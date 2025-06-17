// api/refund.js
require('dotenv').config();
const crypto = require('crypto');
const { recalcCustomer } = require('../lib/recalculate');
const fetch = require('undici').fetch;

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  console.log('▶️  /refund endpoint hit');

  // 1) Csak POST
  if (req.method !== 'POST') {
    console.log('✋ Method not allowed:', req.method);
    return res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
  }

  // 2) Raw body + HMAC validáció
  let buf;
  try {
    buf = await getRawBody(req);
    console.log('✅ Raw body read, length:', buf.length);
  } catch (e) {
    console.error('❌ Error reading body:', e);
    return res.writeHead(400).end('Invalid body');
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const computed = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');
  console.log('🔐 Received HMAC header:', hmacHeader);
  console.log('🔑 Computed HMAC:', computed);

  if (!hmacHeader || computed !== hmacHeader) {
    console.error('❌ HMAC validation failed');
    return res.writeHead(401).end('HMAC validation failed');
  }
  console.log('✅ HMAC validation passed');

  // 3) Payload parse
  let payload;
  try {
    payload = JSON.parse(buf.toString());
    console.log('📦 Parsed payload:', payload);
  } catch (e) {
    console.error('❌ Invalid JSON:', e);
    return res.writeHead(400).end('Invalid JSON');
  }

  const orderId = payload.order_id;
  console.log(`🔔 Refund webhook for order_id: ${orderId}`);

  // 4) Customer ID kinyerése REST API‐val
  let customerId;
  try {
    console.log('🔍 Fetching order via REST to get customer ID');
    const resp = await fetch(
      `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/2023-10/orders/${orderId}.json?fields=customer`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    if (!resp.ok) throw new Error(`Status ${resp.status}`);
    const body = await resp.json();
    customerId = body.order.customer?.id;
    console.log('✅ REST fetched customer.id:', customerId);
  } catch (e) {
    console.error('❌ REST fetch order/customer failed:', e);
  }

  if (!customerId) {
    console.error('❌ No customer ID after REST lookup, aborting');
    return res.writeHead(400).end('No customer ID');
  }

  // numeric ID
  const numericCustomerId = String(customerId).split('/').pop();
  console.log('🔢 Numeric customer ID:', numericCustomerId);

  // 5) Fire-and-forget recalcCustomer
  console.log('🔄 Triggering background recalcCustomer...');
  recalcCustomer(
    process.env.SHOPIFY_SHOP_NAME,
    process.env.SHOPIFY_API_ACCESS_TOKEN,
    numericCustomerId
  )
    .then(() => console.log('✅ Background recalcCustomer done'))
    .catch(err => console.error('❌ Background recalcCustomer error:', err));

  // 6) Azonnali válasz
  console.log('🏁 Refund handler returning 200 OK');
  res.writeHead(200).end('OK');
};
