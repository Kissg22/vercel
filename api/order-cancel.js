require('dotenv').config();
const crypto = require('crypto');
const { recalculateCustomerPartial } = require('../lib/recalculate-partial');
const { fetch } = require('undici');

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  console.log('▶️ /order-cancel endpoint hit');

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

  if (!payload.cancelled_at) {
    return res.writeHead(200).end('Skipped non-cancel');
  }

  let customerGid = payload.customer?.id;
  if (!customerGid) {
    try {
      const resp = await fetch(
        `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/2023-10/orders/${payload.id}.json?fields=customer`,
        { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN } }
      );
      const body = await resp.json();
      customerGid = body.order?.customer?.id;
    } catch {}
  }

  if (!customerGid) {
    return res.writeHead(400).end('No customer ID');
  }

  const customerId = String(customerGid).split('/').pop();
  try {
    await recalculateCustomerPartial(customerId, payload.id);
  } catch (err) {
    return res.writeHead(500).end('Partial recalc error');
  }

  res.writeHead(200).end('OK');
  };