// api/order-creation.js
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

  // 1) Raw body + HMAC validálás
  let buf;
  try { buf = await getRawBody(req); }
  catch (e) { console.error('❌ Error reading body:', e); return res.writeHead(400).end('Invalid body'); }

  const hmac   = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
                       .update(buf).digest('base64');
  if (!hmac || hmac !== digest) {
    console.error('❌ HMAC validation failed (got %s, expected %s)', hmac, digest);
    return res.writeHead(401).end('HMAC validation failed');
  }

  // 2) Payload parse
  let order;
  try { order = JSON.parse(buf.toString()); }
  catch (e) { console.error('❌ Invalid JSON payload:', e); return res.writeHead(400).end('Invalid JSON'); }

  console.log(`🔔 Received order creation: ${order.id}`);

  const subtotal   = parseFloat(order.subtotal_price);
  const shop       = process.env.SHOPIFY_SHOP_NAME;
  const token      = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const endpoint   = `https://${shop}.myshopify.com/admin/api/2023-10/graphql.json`;
  const shareUnit  = 12700;

  // 3) Lekérdezzük a korábbi net_spent_total-t
  let prev = 0;
  try {
    const readRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: `
          query getPrev($custId: ID!) {
            customer(id: $custId) {
              metafield(namespace: "loyalty", key: "net_spent_total") {
                value
              }
            }
          }
        `,
        variables: { custId: `gid://shopify/Customer/${order.customer.id}` }
      })
    });
    const { data, errors } = await readRes.json();
    if (errors?.length) {
      console.error('❌ GraphQL getPrev errors:', errors);
      return res.writeHead(500).end('Error fetching previous spending');
    }
    prev = parseFloat(data.customer.metafield?.value || '0');
  } catch (e) {
    console.error('❌ Fetch previous spending failed:', e);
    return res.writeHead(500).end('Fetch error');
  }

  // 4) Új értékek kiszámolása
  const total       = prev + subtotal;
  const totalShares = Math.floor(total / shareUnit);
  const newShares   = totalShares - Math.floor(prev / shareUnit);
  const remCurrent  = total % shareUnit;

  console.log('📈 Previous spend: ', prev.toFixed(2));
  console.log('📊 New total spend:', total.toFixed(2));
  console.log('🎯 Shares earned: ', newShares);
  console.log('💰 New remainder:', remCurrent.toFixed(2));

  // 5) Single inline mutation (minden érték literal)
  const mutation = `
    mutation {
      customerUpdate(input: {
        id: "gid://shopify/Customer/${order.customer.id}",
        metafields: [
          { namespace: "loyalty", key: "net_spent_total",     type: "number_decimal",  value: "${total.toFixed(2)}" },
          { namespace: "loyalty", key: "reszvenyek_szama",    type: "number_integer",  value: "${totalShares}" },
          { namespace: "loyalty", key: "last_order_value",    type: "number_decimal",  value: "${subtotal.toFixed(2)}" },
          { namespace: "custom",  key: "jelenlegi_fennmarado", type: "number_decimal",  value: "${remCurrent.toFixed(2)}" }
        ]
      }) {
        userErrors { field message }
      }
      orderUpdate(input: {
        id: "gid://shopify/Order/${order.id}",
        metafields: [
          { namespace: "custom", key: "order_share",      type: "number_integer", value: "${newShares}" },
          { namespace: "custom", key: "osszes_koltes",     type: "number_decimal",  value: "${total.toFixed(2)}" },
          { namespace: "custom", key: "fennmarado_osszeg", type: "number_decimal",  value: "${remCurrent.toFixed(2)}" }
        ]
      }) {
        userErrors { field message }
      }
    }
  `;

  try {
    const mutRes  = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: mutation })
    });
    const mutJson = await mutRes.json();
    if (mutJson.errors?.length) {
      console.error('❌ Mutation-level errors:', mutJson.errors);
      return res.writeHead(500).end('Mutation errors');
    }
    const cuErrs = mutJson.data.customerUpdate.userErrors;
    const ouErrs = mutJson.data.orderUpdate.userErrors;
    if (cuErrs.length || ouErrs.length) {
      console.error('❌ Field-level errors:', { cuErrs, ouErrs });
      return res.writeHead(500).end('UserErrors');
    }
    console.log('✅ Everything updated successfully.');
  } catch (e) {
    console.error('❌ Mutation failed:', e);
    return res.writeHead(500).end('Mutation error');
  }

  res.writeHead(200).end('OK');
};
