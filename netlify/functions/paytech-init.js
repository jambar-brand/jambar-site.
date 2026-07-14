// netlify/functions/paytech-init.js
//
// Cette fonction s'exécute UNIQUEMENT côté serveur (Netlify Functions).
// C'est la seule partie du code qui connaît vos clés PayTech : elles ne
// transitent JAMAIS par le navigateur du client (le JS du site appelle
// cette fonction, jamais l'API PayTech directement).
//
// Variables d'environnement requises (à définir dans Netlify → Site
// settings → Environment variables, et en local dans le fichier .env
// fourni à côté) :
//   PAYTECH_API_KEY
//   PAYTECH_API_SECRET
//   PAYTECH_ENV     ("test" ou "prod" — laissez "test" tant que vous
//                    n'avez pas fini de vérifier le tunnel de paiement)
//   SITE_URL        ex: https://www.jambar.sn (sans slash final)

const PAYTECH_URL = 'https://paytech.sn/api/payment/request-payment';

// Fait le lien entre le libellé affiché sur le site et la valeur exacte
// attendue par PayTech dans "target_payment". On ne propose que ces 4
// moyens de paiement, aucun autre n'est accepté par le serveur.
const PAYMENT_METHOD_MAP = {
  'Orange Money': 'Orange Money',
  'Wave': 'Wave',
  'Wizall Money': 'Wizall',
  // ⚠️ Mixx by Yas est le nouveau nom (rebranding 2024) de l'ancien
  // "Tigo Cash / Free Money" chez PayTech. Si ce moyen de paiement
  // n'apparaît pas correctement à l'étape PayTech, contactez
  // contact@paytech.sn pour confirmer la valeur exacte à utiliser sur
  // votre compte, et mettez-la à jour ci-dessous.
  'Mixx by Yas': 'Tigo Cash'
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ success: 0, message: 'Méthode non autorisée' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: 0, message: 'Requête invalide' })
    };
  }

  const { total, itemsLabel, method, name, phone, email, addr, ville, orderNum } = payload;

  // --- Validations côté serveur : on ne fait jamais confiance au client ---
  const amount = Math.round(Number(total));
  if (!amount || amount <= 0) {
    return { statusCode: 400, body: JSON.stringify({ success: 0, message: 'Montant invalide' }) };
  }

  const targetPayment = PAYMENT_METHOD_MAP[method];
  if (!targetPayment) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: 0, message: 'Moyen de paiement non autorisé' })
    };
  }

  if (!name || !phone || !addr || !ville) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: 0, message: 'Informations client incomplètes' })
    };
  }

  const apiKey = process.env.PAYTECH_API_KEY;
  const apiSecret = process.env.PAYTECH_API_SECRET;
  const env = process.env.PAYTECH_ENV || 'test';
  const siteUrl = (process.env.SITE_URL || `https://${event.headers.host}`).replace(/\/$/, '');

  if (!apiKey || !apiSecret) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: 0, message: 'Configuration PayTech manquante côté serveur' })
    };
  }

  const refCommand = (orderNum || ('JMB-' + Date.now())).toString();

  const params = {
    item_name: (itemsLabel || 'Commande JAMBAR').slice(0, 250),
    item_price: amount,
    currency: 'XOF',
    ref_command: refCommand,
    command_name: `Commande JAMBAR — ${itemsLabel || ''}`.slice(0, 250),
    target_payment: targetPayment,
    env,
    ipn_url: `${siteUrl}/.netlify/functions/paytech-ipn`,
    success_url: `${siteUrl}/?paytech=success&ref=${encodeURIComponent(refCommand)}`,
    cancel_url: `${siteUrl}/?paytech=cancel&ref=${encodeURIComponent(refCommand)}`,
    custom_field: JSON.stringify({ orderNum: refCommand, name, phone, email, addr, ville })
  };

  try {
    const resp = await fetch(PAYTECH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        API_KEY: apiKey,
        API_SECRET: apiSecret
      },
      body: JSON.stringify(params)
    });

    const data = await resp.json();

    if (data.success === 1 && data.redirect_url) {
      // Un seul moyen de paiement ciblé => on peut pré-remplir le
      // téléphone / nom du client et activer la soumission automatique
      // côté PayTech (paramètres pn/nn/fn/tp/nac documentés par PayTech).
      const digits = String(phone).replace(/\D/g, '').slice(-9);
      const autofill = new URLSearchParams({
        pn: `+221${digits}`,
        nn: digits,
        fn: name,
        tp: targetPayment,
        nac: '1'
      });

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: 1,
          redirect_url: `${data.redirect_url}?${autofill.toString()}`,
          ref_command: refCommand
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: 0, message: data.message || 'Erreur PayTech' })
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ success: 0, message: 'Impossible de contacter PayTech' })
    };
  }
};
