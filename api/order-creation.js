// api/order-creation.js
require('dotenv').config();
const crypto = require('crypto');
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
  } catch (err) {
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
  let order;
  try {
    order = JSON.parse(buf.toString());
  } catch (err) {
    return res.writeHead(400).end('Invalid JSON');
  }

  // 4) Customer ID kinyerése
  const customerGid = order.customer?.id;
  if (!customerGid) {
    return res.writeHead(400).end('No customer ID');
  }
  const customerId = String(customerGid).split('/').pop();

  // 5) Újraszámolás
  try {
    await recalcCustomer(
      process.env.SHOPIFY_SHOP_NAME,
      process.env.SHOPIFY_API_ACCESS_TOKEN,
      customerId
    );
  } catch (err) {
    return res.writeHead(500).end('Recalc error');
  }

  // 6) Válasz
  res.writeHead(200).end('OK');
};
