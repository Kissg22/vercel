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
  // Csak POST kérésekre válaszolunk
  if (req.method !== 'POST') {
    return res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
  }

  // 1) Raw body + HMAC validálás
  let buf;
  try {
    buf = await getRawBody(req);
  } catch (e) {
    console.error('❌ Error reading body:', e);
    return res.writeHead(400).end('Invalid body');
  }
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const expected = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');
  if (!hmacHeader || hmacHeader !== expected) {
    console.error('❌ HMAC validation failed (got %s, expected %s)', hmacHeader, expected);
    return res.writeHead(401).end('HMAC validation failed');
  }
  console.log('✅ HMAC passed');

  // 2) Payload parse
  let order;
  try {
    order = JSON.parse(buf.toString());
  } catch (e) {
    console.error('❌ Invalid JSON payload:', e);
    return res.writeHead(400).end('Invalid JSON');
  }
  console.log(`🔔 Received order creation: ${order.id}`);

  // 3) Előző net_spent_total lekérdezése
  const shop      = process.env.SHOPIFY_SHOP_NAME;
  const token     = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const endpoint  = `https://${shop}.myshopify.com/admin/api/2023-10/graphql.json`;
  const shareUnit = 12700;
  const subtotal  = parseFloat(order.subtotal_price);

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
        variables: {
          custId: `gid://shopify/Customer/${order.customer.id}`
        }
      })
    });
    const { data, errors } = await readRes.json();
    if (errors?.length) {
      console.error('❌ GraphQL errors on getPrev:', errors);
      return res.writeHead(500).end('Error fetching previous spending');
    }
    prev = parseFloat(data.customer.metafield?.value || '0');
  } catch (e) {
    console.error('❌ Fetch previous spending failed:', e);
    return res.writeHead(500).end('Fetch previous spending error');
  }

  // 4) Új értékek kiszámolása
  const total       = prev + subtotal;
  const prevShares  = Math.floor(prev / shareUnit);
  const totalShares = Math.floor(total / shareUnit);
  const newShares   = totalShares - prevShares;
  const remCurrent  = total % shareUnit;

  console.log('📈 Previous spend:  ', prev.toFixed(2));
  console.log('📊 New total spend: ', total.toFixed(2));
  console.log('🎯 New shares:      ', newShares);
  console.log('💰 New remainder:   ', remCurrent.toFixed(2));

  // 5) Egyetlen, változókat használó mutáció
  try {
    const mutRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: `
          mutation updateBoth(
            $custId: ID!,
            $orderGid: ID!,
            $total: Decimal!,
            $shares: Int!,
            $subt: Decimal!,
            $rem: Decimal!
          ) {
            customerUpdate(input: {
              id: $custId,
              metafields: [
                { namespace: "loyalty", key: "net_spent_total",  type: "number_decimal",  value: $total },
                { namespace: "loyalty", key: "reszvenyek_szama", type: "number_integer",  value: $shares },
                { namespace: "loyalty", key: "last_order_value", type: "number_decimal",  value: $subt },
                { namespace: "custom",  key: "jelenlegi_fennmarado", type: "number_decimal",  value: $rem }
              ]
            }) { userErrors { field message } }
            orderUpdate(input: {
              id: $orderGid,
              metafields: [
                { namespace: "custom", key: "order_share",      type: "number_integer",  value: $shares },
                { namespace: "custom", key: "osszes_koltes",     type: "number_decimal",  value: $total },
                { namespace: "custom", key: "fennmarado_osszeg", type: "number_decimal",  value: $rem }
              ]
            }) { userErrors { field message } }
          }
        `,
        variables: {
          custId:   `gid://shopify/Customer/${order.customer.id}`,
          orderGid: `gid://shopify/Order/${order.id}`,
          total,      // szám típus
          shares:     newShares,
          subt:       subtotal,
          rem:        remCurrent
        }
      })
    });
    const mjson = await mutRes.json();
    if (mjson.errors?.length) {
      console.error('❌ Mutation-level errors:', mjson.errors);
      return res.writeHead(500).end('Mutation-level errors');
    }
    const cuErrs = mjson.data.customerUpdate.userErrors;
    const ouErrs = mjson.data.orderUpdate.userErrors;
    if (cuErrs.length || ouErrs.length) {
      console.error('❌ Field-level userErrors:', { cuErrs, ouErrs });
      return res.writeHead(500).end('UserErrors on mutation');
    }
    console.log('✅ Mutation succeeded:', JSON.stringify(mjson.data, null, 2));
  } catch (e) {
    console.error('❌ Mutation failed:', e);
    return res.writeHead(500).end('Mutation error');
  }

  console.log('🏁 Order-creation handler done');
  res.writeHead(200).end('OK');
};
