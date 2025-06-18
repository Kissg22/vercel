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
  console.log('🔐 Received HMAC header:', hmacHeader);
  const computed = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');
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

  console.log(`🔔 Received refund webhook for order: ${payload.order_id}`);

  // 4) Customer ID kinyerése
  let customerGid = payload.customer?.id;
  console.log('👤 Initial payload.customer.id:', customerGid);
  if (!customerGid) {
    console.log('🔍 customer.id missing, fetching via GraphQL order query');
    const endpoint = `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/2023-10/graphql.json`;
    const orderQuery = `
      query {
        order(id: "gid://shopify/Order/${payload.order_id}") {
          customer { id }
        }
      }
    `;
    try {
      const orderRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type':           'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN
        },
        body: JSON.stringify({ query: orderQuery })
      });
      const orderJson = await orderRes.json();
      customerGid = orderJson.data?.order?.customer?.id;
      console.log('🔍 Fetched customerGid via GraphQL:', customerGid);
    } catch (e) {
      console.error('❌ Error fetching order for customer ID:', e);
      return res.writeHead(500).end('Error fetching customer');
    }
  }

  if (!customerGid) {
    console.error('❌ Still no customer ID available, aborting');
    return res.writeHead(400).end('No customer ID');
  }

  const customerId = String(customerGid).split('/').pop();
  console.log('🔢 Numeric customer ID:', customerId);

  // 5) Teljes újraszámolás
  console.log('🔄 Starting recalcCustomer...');
  try {
    await recalcCustomer(
      process.env.SHOPIFY_SHOP_NAME,
      process.env.SHOPIFY_API_ACCESS_TOKEN,
      customerId
    );
    console.log('✅ recalcCustomer completed successfully');
  } catch (e) {
    console.error('❌ Recalculation failed:', e);
    return res.writeHead(500).end('Recalc error');
  }

  // 6) Válasz
  console.log('🏁 Refund handling finished, sending 200 OK');
  res.writeHead(200).end('OK');
};
