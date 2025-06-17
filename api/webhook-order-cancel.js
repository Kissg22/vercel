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
    res.writeHead(405, { Allow: 'POST' });
    return res.end('Method Not Allowed');
  }

  // 1) Read & verify raw body
  let buf;
  try {
    buf = await getRawBody(req);
  } catch (err) {
    console.error('Error reading body:', err);
    return res.writeHead(400).end('Invalid body');
  }
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac) return res.writeHead(400).end('Missing HMAC header');
  const digest = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
                       .update(buf)
                       .digest('base64');
  if (digest !== hmac) return res.writeHead(401).end('HMAC mismatch');

  // 2) Parse payload
  let order;
  try {
    order = JSON.parse(buf.toString());
  } catch {
    return res.writeHead(400).end('Invalid JSON');
  }
  console.log(`🔔 Order cancelled: ${order.id}`);

  const shareUnit = 12700;
  const shopName = process.env.SHOPIFY_SHOP_NAME;
  const token    = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const endpoint = `https://${shopName}.myshopify.com/admin/api/2023-10/graphql.json`;

  const cancelledId = order.id;
  const subtotal    = parseFloat(order.subtotal_price);
  const customerId  = order.customer?.id;
  if (!customerId) {
    console.error('❌ No customer attached to cancelled order.');
    return res.writeHead(400).end('Customer not found');
  }

  // 3) Fetch all orders for this customer
  let orders;
  try {
    const ordersQuery = `
      query {
        customer(id: "${customerId}") {
          orders(first: 100, sortKey: CREATED_AT, reverse: false) {
            edges { node { id name subtotalPriceSet { presentmentMoney { amount } } } }
          }
        }
      }`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: ordersQuery })
    });
    const json = await resp.json();
    orders = json.data.customer.orders.edges.map(e => e.node);
  } catch (err) {
    console.error('Error fetching customer orders:', err);
    return res.writeHead(500).end('Error fetching orders');
  }

  // 4) Recalculate cumulatively
  let cumSpend  = 0;
  let cumShares = 0;
  for (const o of orders) {
    const id       = o.id;
    const amount   = parseFloat(o.subtotalPriceSet.presentmentMoney.amount);
    const effective= (id === cancelledId ? 0 : amount);
    cumSpend += effective;

    const newShares = Math.floor(cumSpend/shareUnit) - cumShares;
    cumShares += newShares;
    const remainder = cumSpend % shareUnit;

    // update each order
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
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: orderMut, variables: vars })
    });
  }

  // 5) Update customer
  try {
    const customerMut = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) { userErrors { field message } }
      }`;
    const custVars = {
      input: {
        id: customerId,
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
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: customerMut, variables: custVars })
    });
  } catch (err) {
    console.error('Error updating customer:', err);
  }

  console.log('✅ Cancel-order recalculation done.');
  res.writeHead(200).end('OK');
};
