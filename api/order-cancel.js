// api/order-cancel.js
require('dotenv').config();
const crypto = require('crypto');
const { fetch } = require('undici');
const { recalcCustomer } = require('../lib/recalculate');

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  // 1) Csak POST
  if (req.method !== 'POST') {
    return res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
  }

  // 2) Raw body + HMAC validáció
  let buf;
  try {
    buf = await getRawBody(req);
  } catch {
    return res.writeHead(400).end('Invalid body');
  }
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');
  if (!hmac || hmac !== digest) {
    return res.writeHead(401).end('HMAC validation failed');
  }

  // 3) Payload parse
  let payload;
  try {
    payload = JSON.parse(buf.toString());
  } catch {
    return res.writeHead(400).end('Invalid JSON');
  }

  // 4) Csak tényleges cancel esemény
  if (!payload.cancelled_at) {
    return res.writeHead(200).end('Skipped non-cancel');
  }

  // 5) Customer ID kinyerése (payloadból vagy GraphQL fallback)
  let customerId = payload.customer?.id?.split('/').pop();
  if (!customerId) {
    const endpoint = `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;
    const query = `
      query getOrderCustomer($orderId: ID!) {
        order(id: $orderId) { customer { id } }
      }
    `;
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type':           'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN
        },
        body: JSON.stringify({
          query,
          variables: { orderId: `gid://shopify/Order/${payload.id}` }
        })
      });
      const json = await resp.json();
      customerId = json.data?.order?.customer?.id?.split('/').pop();
    } catch {
      return res.writeHead(500).end('Error fetching customer');
    }
  }
  if (!customerId) {
    return res.writeHead(400).end('No customer ID');
  }

  // 6) Teljes újraszámolás
  try {
    await recalcCustomer(
      process.env.SHOPIFY_SHOP_NAME,
      process.env.SHOPIFY_API_ACCESS_TOKEN,
      customerId
    );
  } catch {
    return res.writeHead(500).end('Recalc error');
  }

  // 7) Válasz
  res.writeHead(200).end('OK');
};
