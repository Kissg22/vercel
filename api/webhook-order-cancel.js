// pages/api/webhook/order-cancel.js
require('dotenv').config();
const crypto = require('crypto');
const { fetch } = require('undici');

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
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac) return res.writeHead(400).end('Missing HMAC');
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');
  if (digest !== hmac) return res.writeHead(401).end('HMAC mismatch');

  // 2) Parse payload
  let payload;
  try {
    payload = JSON.parse(buf.toString());
  } catch {
    return res.writeHead(400).end('Invalid JSON');
  }

  // 3) Csak ha valóban CANCELLED event (vagyis payload.cancelled_at van)
  if (!payload.cancelled_at) {
    console.log('▶️ Skipping: not a cancel event');
    return res.writeHead(200).end('Skipped non-cancel');
  }

  console.log(`🔔 Order cancelled: ${payload.id}`);

  const shareUnit = 12700;
  const shopName  = process.env.SHOPIFY_SHOP_NAME;
  const token     = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const endpoint  = `https://${shopName}.myshopify.com/admin/api/2023-10/graphql.json`;

  const cancelledId     = payload.id;
  const cancelledSubtotal = parseFloat(payload.subtotal_price || 0);
  const rawCustomerId   = payload.customer?.id;
  if (!rawCustomerId) {
    console.error('❌ No customer in payload');
    return res.writeHead(400).end('No customer');
  }
  // Biztonságos stringesítés + numeric ID kinyerése
  const custIdStr = String(rawCustomerId);
  const numericCustomerId = custIdStr.includes('/') 
    ? custIdStr.split('/').pop() 
    : custIdStr;

  // 4) Lekérjük REST-en az összes rendelést
  let orders;
  try {
    const resp = await fetch(
      `https://${shopName}.myshopify.com/admin/api/2023-10/orders.json?status=any&customer_id=${numericCustomerId}&limit=250`,
      {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );
    const json = await resp.json();
    orders = json.orders || [];
    // sort by created_at asc
    orders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  } catch (e) {
    console.error('Error fetching orders via REST:', e);
    return res.writeHead(500).end('Error fetching orders');
  }

  // 5) Kumulatív újraszámolás
  let cumSpend  = 0;
  let cumShares = 0;

  for (const o of orders) {
    const id       = o.id;
    const amount   = parseFloat(o.subtotal_price || 0);
    const effective= (id === cancelledId ? 0 : amount);
    cumSpend += effective;

    const newShares = Math.floor(cumSpend / shareUnit) - cumShares;
    cumShares += newShares;
    const remainder = cumSpend % shareUnit;

    console.log(
      `→ ${o.name}: spend=${cumSpend.toFixed(2)}, shares=${newShares}, rem=${remainder.toFixed(2)}`
    );

    // 6) Update order metafields
    const orderMut = `
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          userErrors { field message }
        }
      }`;
    const vars = {
      input: {
        id,
        metafields: [
          { namespace: 'custom', key: 'osszes_koltes',     type: 'number_decimal',  value: cumSpend.toFixed(2) },
          { namespace: 'custom', key: 'order_share',       type: 'number_integer',  value: newShares.toString() },
          { namespace: 'custom', key: 'fennmarado_osszeg', type: 'number_decimal',  value: remainder.toFixed(2) }
        ]
      }
    };
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: orderMut, variables: vars })
    });
  }

  // 7) Customer metafield update
  try {
    const custMut = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          userErrors { field message }
        }
      }`;
    const custVars = {
      input: {
        id: `gid://shopify/Customer/${numericCustomerId}`,
        metafields: [
          { namespace: 'loyalty', key: 'net_spent_total',     type: 'number_decimal',  value: cumSpend.toFixed(2) },
          { namespace: 'loyalty', key: 'reszvenyek_szama',    type: 'number_integer',  value: cumShares.toString() },
          { namespace: 'custom',  key: 'jelenlegi_fennmarado',type: 'number_decimal',  value: (cumSpend % shareUnit).toFixed(2) }
        ]
      }
    };
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: custMut, variables: custVars })
    });
  } catch (e) {
    console.error('Error updating customer:', e);
  }

  console.log('✅ Cancel-order recalculation done.');
  res.writeHead(200).end('OK');
};
