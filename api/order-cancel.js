// api/order-cancel.js
require('dotenv').config();
const crypto            = require('crypto');
const { fetch }         = require('undici');
const { recalcCustomer } = require('../lib/recalculate');

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  console.log('▶️  /order-cancel endpoint hit');

  // 1) Csak POST
  if (req.method !== 'POST') {
    console.log(`✋ Method not allowed: ${req.method}`);
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
  const computedHmac = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');
  console.log('🔐 Received HMAC:', hmacHeader);
  console.log('🔑 Computed HMAC:', computedHmac);
  if (!hmacHeader || computedHmac !== hmacHeader) {
    console.error('❌ HMAC validation failed');
    return res.writeHead(401).end('HMAC validation failed');
  }
  console.log('✅ HMAC validation passed');

  // 3) Payload parse
  let payload;
  try {
    payload = JSON.parse(buf.toString());
    console.log('📦 Parsed payload:', {
      id:            payload.id,
      cancelled_at:  payload.cancelled_at,
      customer_id:   payload.customer?.id
    });
  } catch (e) {
    console.error('❌ Invalid JSON:', e);
    return res.writeHead(400).end('Invalid JSON');
  }

  // 4) Csak tényleges cancel esemény
  if (!payload.cancelled_at) {
    console.log('▶️ Not a cancel event, skipping');
    return res.writeHead(200).end('Skipped non-cancel');
  }
  const orderId = payload.id;
  console.log(`🔔 Cancel webhook for order: ${orderId} at ${payload.cancelled_at}`);

  // 5) Customer ID kinyerése
  let customerGid = payload.customer?.id;
  console.log('👤 Initial payload.customer.id:', customerGid);
  if (!customerGid) {
    console.log('🔍 customer.id missing, fetching via REST');
    try {
      const resp = await fetch(
        `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/orders/${orderId}.json?fields=customer`,
        {
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      const body = await resp.json();
      customerGid = body.order?.customer?.id;
      console.log('🔍 REST fetched customer.id:', customerGid);
    } catch (e) {
      console.error('❌ Error fetching order for customer ID:', e);
    }
  }
  if (!customerGid) {
    console.error('❌ Still no customer ID, aborting');
    return res.writeHead(400).end('No customer ID');
  }
  const customerId = String(customerGid).split('/').pop();
  console.log('🔢 Numeric customer ID:', customerId);

  // 6) Szinkron újraszámolás csak ettől a rendeléstől
  console.log(`🔄 Calling recalcCustomer from order ${orderId}`);
  try {
    await recalcCustomer(
      process.env.SHOPIFY_SHOP_NAME,
      process.env.SHOPIFY_API_ACCESS_TOKEN,
      customerId,
      orderId
    );
    console.log('✅ recalcCustomer completed successfully');
  } catch (err) {
    console.error('❌ Recalculation failed:', err);
    return res.writeHead(500).end('Recalc error');
  }

  // 7) Válasz
  console.log('🏁 Cancel handler finished, sending 200 OK');
  res.writeHead(200).end('OK');
};
