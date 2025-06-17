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
  // HMAC verify
  let buf;
  try { buf = await getRawBody(req); }
  catch (e) { console.error(e); return res.writeHead(400).end('Invalid body'); }
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY).update(buf).digest('base64');
  if (!hmac || digest !== hmac) return res.writeHead(401).end('HMAC failed');

  // payload
  let payload;
  try { payload = JSON.parse(buf.toString()); }
  catch { return res.writeHead(400).end('Invalid JSON'); }

  console.log(`🔔 Refund webhook for order: ${payload.order_id}`);
  const rawCustId = payload.customer?.id;
  if (!rawCustId) {
    console.error('No customer in refund payload');
    return res.writeHead(400).end('No customer');
  }
  const custIdStr = String(rawCustId).split('/').pop();

  // full recalculation
  try {
    await recalcCustomer(
      process.env.SHOPIFY_SHOP_NAME,
      process.env.SHOPIFY_API_ACCESS_TOKEN,
      custIdStr
    );
  } catch (e) {
    console.error('Recalc failed:', e);
    return res.writeHead(500).end('Recalc error');
  }

  res.writeHead(200).end('OK');
};
