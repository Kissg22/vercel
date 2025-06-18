require('dotenv').config();
const crypto = require('crypto');
const { recalculateCustomerPartial } = require('../lib/recalculate-partial');
const fetch = require('undici').fetch;

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  console.log('▶️ /refund endpoint hit');

  if (req.method !== 'POST') {
    return res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
  }

  let buf;
  try {
    buf = await getRawBody(req);
  } catch (e) {
    return res.writeHead(400).end('Invalid body');
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const computedHmac = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');

  if (!hmacHeader || computedHmac !== hmacHeader) {
    return res.writeHead(401).end('HMAC validation failed');
  }

  let payload;
  try {
    payload = JSON.parse(buf.toString());
  } catch {
    return res.writeHead(400).end('Invalid JSON');
  }

  const orderId = payload.order_id;
  let customerGid = payload.customer?.id;
  if (!customerGid) {
    const endpoint = `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/2023-10/graphql.json`;
    const query = `query { order(id: \"gid://shopify/Order/${orderId}\") { customer { id } } }`;
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN
        },
        body: JSON.stringify({ query })
      });
      const j = await r.json();
      customerGid = j.data?.order?.customer?.id;
    } catch {}
  }

  if (!customerGid) {
    return res.writeHead(400).end('No customer ID');
  }

  const customerId = String(customerGid).split('/').pop();
  try {
    await recalculateCustomerPartial(customerId, orderId);
  } catch (err) {
    return res.writeHead(500).end('Partial recalc error');
  }

  res.writeHead(200).end('OK');
};