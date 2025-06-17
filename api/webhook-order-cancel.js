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
  if (!hmac) return res.writeHead(400).end('Missing HMAC header');
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');
  if (hash !== hmac) return res.writeHead(401).end('HMAC validation failed');

  // 2) Parse payload
  let payload;
  try {
    payload = JSON.parse(buf.toString());
  } catch {
    return res.writeHead(400).end('Invalid JSON');
  }
  console.log(`🔔 Order cancelled: ${payload.id}`);

  const shareUnit = 12700;
  const shopName  = process.env.SHOPIFY_SHOP_NAME;
  const token     = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const endpoint  = `https://${shopName}.myshopify.com/admin/api/2023-10/graphql.json`;

  // 3) Customer ID és törölt rendelés adatai
  const cancelledOrderId = payload.id;
  const cancelledSubtotal = parseFloat(payload.subtotal_price);
  const customerId = payload.customer?.id;
  if (!customerId) {
    console.error('No customer attached to cancelled order');
    return res.writeHead(400).end('Customer not found');
  }

  // 4) Lekérjük REST-en az összes rendelést
  let orders;
  try {
    const numericCustomerId = customerId.split('/').pop();
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
    // client-side sort created_at asc
    orders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  } catch (e) {
    console.error('Error fetching orders via REST:', e);
    return res.writeHead(500).end('Error fetching orders');
  }

  // 5) Kumulatív újraszámolás
  let cumulativeSpend = 0;
  let cumulativeShares = 0;

  for (const ord of orders) {
    const id = ord.id;
    // ha ez a törölt, akkor 0, különben az eredeti subtotal
    const effective = id === cancelledOrderId ? 0 : parseFloat(ord.subtotal_price);
    cumulativeSpend += effective;

    const newShares = Math.floor(cumulativeSpend / shareUnit) - cumulativeShares;
    cumulativeShares += newShares;
    const remainder = cumulativeSpend % shareUnit;

    console.log(
      `→ Recalc ${ord.name}: spend=${cumulativeSpend.toFixed(
        2
      )}, shares=${newShares}, rem=${remainder.toFixed(2)}`
    );

    // 6) Update order metafields
    const orderMutation = `
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) { userErrors { field message } }
      }`;
    const orderVars = {
      input: {
        id,
        metafields: [
          {
            namespace: 'custom',
            key: 'osszes_koltes',
            type: 'number_decimal',
            value: cumulativeSpend.toFixed(2)
          },
          {
            namespace: 'custom',
            key: 'order_share',
            type: 'number_integer',
            value: newShares.toString()
          },
          {
            namespace: 'custom',
            key: 'fennmarado_osszeg',
            type: 'number_decimal',
            value: remainder.toFixed(2)
          }
        ]
      }
    };

    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: orderMutation, variables: orderVars })
    });
  }

  // 7) Customer metafields frissítése
  try {
    const custMutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) { userErrors { field message } }
      }`;
    const custVars = {
      input: {
        id: customerId,
        metafields: [
          {
            namespace: 'loyalty',
            key: 'net_spent_total',
            type: 'number_decimal',
            value: cumulativeSpend.toFixed(2)
          },
          {
            namespace: 'loyalty',
            key: 'reszvenyek_szama',
            type: 'number_integer',
            value: cumulativeShares.toString()
          },
          {
            namespace: 'custom',
            key: 'jelenlegi_fennmarado',
            type: 'number_decimal',
            value: (cumulativeSpend % shareUnit).toFixed(2)
          }
        ]
      }
    };

    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: custMutation, variables: custVars })
    });
  } catch (e) {
    console.error('Error updating customer:', e);
  }

  console.log('✅ Cancel-order recalculation done.');
  res.writeHead(200).end('OK');
};
