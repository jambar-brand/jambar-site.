// netlify/functions/paytech-ipn.js
//
// PayTech appelle cette URL en tâche de fond (serveur à serveur, jamais
// depuis le navigateur du client) pour confirmer qu'il a RÉELLEMENT reçu
// l'argent sur votre compte marchand PayTech. C'est la seule source
// fiable pour savoir si une commande est payée — on ne se fie jamais à
// ce que raconte le navigateur du client (il pourrait fermer l'onglet,
// couper sa connexion, ou mentir).
//
// Variables d'environnement requises : PAYTECH_API_KEY, PAYTECH_API_SECRET
// (les mêmes que pour paytech-init.js).

const crypto = require('crypto');

function parseBody(event) {
  const raw = event.body || '';
  // PayTech envoie généralement du x-www-form-urlencoded, mais on
  // accepte aussi du JSON par sécurité.
  const contentType = (event.headers['content-type'] || event.headers['Content-Type'] || '');
  if (contentType.includes('application/json')) {
    try { return JSON.parse(raw); } catch (e) { /* fallback ci-dessous */ }
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Méthode non autorisée' };
  }

  const data = parseBody(event);

  const apiKey = process.env.PAYTECH_API_KEY;
  const apiSecret = process.env.PAYTECH_API_SECRET;

  if (!apiKey || !apiSecret) {
    return { statusCode: 500, body: 'Configuration PayTech manquante côté serveur' };
  }

  let authentic = false;

  // Méthode recommandée par PayTech : HMAC-SHA256 sur "prix|ref_command|api_key"
  if (data.hmac_compute) {
    const message = `${data.final_item_price || data.item_price}|${data.ref_command}|${apiKey}`;
    const expected = crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
    authentic = expected === data.hmac_compute;
  }
  // Méthode alternative : comparaison des clés hachées en SHA256
  else if (data.api_key_sha256 && data.api_secret_sha256) {
    const expectedKey = crypto.createHash('sha256').update(apiKey).digest('hex');
    const expectedSecret = crypto.createHash('sha256').update(apiSecret).digest('hex');
    authentic = expectedKey === data.api_key_sha256 && expectedSecret === data.api_secret_sha256;
  }

  if (!authentic) {
    return { statusCode: 403, body: 'IPN KO - signature invalide' };
  }

  if (data.type_event === 'sale_complete') {
    // ✅ Paiement confirmé, l'argent est sur votre compte PayTech.
    //
    // TODO : c'est ici qu'il faut marquer la commande comme "Payée" dans
    // votre système (base de données, Google Sheet, email/SMS au client
    // et à vous-même, etc.). Utilisez data.ref_command pour retrouver la
    // commande, et data.custom_field (encodé en Base64) pour retrouver
    // le nom/téléphone/adresse du client saisis lors de la commande.
    //
    // Exemple de décodage :
    // const custom = JSON.parse(Buffer.from(data.custom_field, 'base64').toString('utf-8'));
    console.log('[PayTech IPN] Paiement confirmé', {
      ref_command: data.ref_command,
      montant: data.final_item_price || data.item_price,
      moyen: data.payment_method,
      telephone_client: data.client_phone
    });
  } else if (data.type_event === 'sale_canceled') {
    console.log('[PayTech IPN] Paiement annulé', data.ref_command);
  }

  return { statusCode: 200, body: 'IPN OK' };
};
