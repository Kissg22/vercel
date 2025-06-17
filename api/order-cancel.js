require('dotenv').config();
const crypto = require('crypto');
const { recalcCustomer } = require('../lib/recalculate');

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
  }

  // 1) Raw body + HMAC ellenőrzés
  let buf;
  try {
    buf = await getRawBody(req);
  } catch (e) {
    console.error('Error reading body:', e);
    return res.writeHead(400).end('Invalid body');
  }
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');
  if (!hmacHeader || digest !== hmacHeader) {
    return res.writeHead(401).end('HMAC validation failed');
  }

  // 2) Parse webhook payload
  let payload;
  try {
    payload = JSON.parse(buf.toString());
  } catch {
    return res.writeHead(400).end('Invalid JSON');
  }

  // 3) Csak a tényleges cancel eseményre futunk
  if (!payload.cancelled_at) {
    console.log('▶️ Not a cancel event, skipping');
    return res.writeHead(200).end('Skipped');
  }

  console.log(`🔔 Cancel webhook for order: ${payload.id}`);

  // 4) customer ID kinyerése és számmá alakítása
  const rawCustId = payload.customer?.id;
  if (!rawCustId) {
    console.error('❌ No customer on payload');
    return res.writeHead(400).end('No customer');
  }
  const customerNumericId = String(rawCustId).split('/').pop();

  // 5) Teljes újraszámolás
  try {
    await recalcCustomer(
      process.env.SHOPIFY_SHOP_NAME,
      process.env.SHOPIFY_API_ACCESS_TOKEN,
      customerNumericId
    );
  } catch (err) {
    console.error('Recalculation failed:', err);
    return res.writeHead(500).end('Recalc error');
  }

  // 6) Vissza OK
  res.writeHead(200).end('OK');
};
