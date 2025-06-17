// api/order-cancel.js
require('dotenv').config();
const crypto = require('crypto');
const { recalcCustomer } = require('../lib/recalculate');

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  console.log('▶️  /order-cancel endpoint hit');
  if (req.method !== 'POST') {
    console.log(`✋ Method not allowed: ${req.method}`);
    return res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
  }

  // 1) Raw body + HMAC ellenőrzés
  let buf;
  try {
    buf = await getRawBody(req);
    console.log('✅ Raw body read, length:', buf.length);
  } catch (e) {
    console.error('❌ Error reading body:', e);
    return res.writeHead(400).end('Invalid body');
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  console.log('🔐 Received HMAC header:', hmacHeader);
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');
  console.log('🔑 Computed HMAC digest:', digest);

  if (!hmacHeader || digest !== hmacHeader) {
    console.error('❌ HMAC validation failed');
    return res.writeHead(401).end('HMAC validation failed');
  }
  console.log('✅ HMAC validation passed');

  // 2) Parse webhook payload
  let payload;
  try {
    payload = JSON.parse(buf.toString());
    console.log('📦 Parsed payload:', payload);
  } catch (e) {
    console.error('❌ Invalid JSON:', e);
    return res.writeHead(400).end('Invalid JSON');
  }

  // 3) Csak a tényleges cancel eseményre futunk
  if (!payload.cancelled_at) {
    console.log('▶️ Not a cancel event, skipping');
    return res.writeHead(200).end('Skipped');
  }
  console.log(`🔔 Cancel webhook for order: ${payload.id} at ${payload.cancelled_at}`);

  // 4) Customer ID kinyerése és számmá alakítása
  const rawCustId = payload.customer?.id;
  console.log('👤 Raw customer GID:', rawCustId);
  if (!rawCustId) {
    console.error('❌ No customer in payload');
    return res.writeHead(400).end('No customer');
  }
  const customerNumericId = String(rawCustId).split('/').pop();
  console.log('🔢 Numeric customer ID:', customerNumericId);

  // 5) Teljes újraszámolás
  console.log('🔄 Starting recalcCustomer...');
  try {
    await recalcCustomer(
      process.env.SHOPIFY_SHOP_NAME,
      process.env.SHOPIFY_API_ACCESS_TOKEN,
      customerNumericId
    );
    console.log('✅ recalcCustomer completed successfully');
  } catch (err) {
    console.error('❌ Recalculation failed:', err);
    return res.writeHead(500).end('Recalc error');
  }

  // 6) Vissza OK
  console.log('🏁 Cancel handling finished, sending 200 OK');
  res.writeHead(200).end('OK');
};
