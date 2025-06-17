// api/order-creation.js   (szálcsiszolt, extra logokkal)
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

  // 1) Raw body + HMAC validáció
  let buf;
  try {
    buf = await getRawBody(req);
  } catch (e) {
    console.error('❌ Error reading body:', e);
    return res.writeHead(400).end('Invalid body');
  }
  const hmac    = req.headers['x-shopify-hmac-sha256'];
  const digest  = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
                        .update(buf).digest('base64');
  if (!hmac || hmac !== digest) {
    console.error('❌ HMAC validation failed (got %s, expected %s)', hmac, digest);
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

  const subtotal   = parseFloat(order.subtotal_price);
  const shop       = process.env.SHOPIFY_SHOP_NAME;
  const token      = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const endpoint   = `https://${shop}.myshopify.com/admin/api/2023-10/graphql.json`;
  const shareUnit  = 12700;

  // 3a) Lekérdezzük a korábbi net_spent_total-t
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
          query ($custId: ID!) {
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
    const { data } = await readRes.json();
    prev = parseFloat(data.customer.metafield?.value || '0');
  } catch (e) {
    console.error('❌ Fetch previous spending failed:', e);
    return res.writeHead(500).end('Fetch previous spending error');
  }

  // 3b) Számoljuk az új értékeket
  const total        = prev + subtotal;
  const prevShares   = Math.floor(prev / shareUnit);
  const totalShares  = Math.floor(total / shareUnit);
  const newShares    = totalShares - prevShares;
  const remBefore    = prev % shareUnit;
  const remCurrent   = total % shareUnit;

  // Logoljuk az értékeket
  console.log('📑 Subtotal for this order:    ', subtotal.toFixed(2));
  console.log('📈 Previous total spent:      ', prev.toFixed(2));
  console.log('📊 New total spending:        ', total.toFixed(2));
  console.log('🎯 Previous shares count:     ', prevShares);
  console.log('🆕 Shares earned now:         ', newShares);
  console.log('💰 Remainder before:          ', remBefore.toFixed(2));
  console.log('💰 Remainder after:           ', remCurrent.toFixed(2));

  // 4) GraphQL mutáció összeállítása (helyettesítjük a value mezőket)
  const baseGql = `
    mutation(
      $custId: ID!,
      $orderGid: ID!
    ) {
      customerUpdate(input: {
        id: $custId,
        metafields: [
          { namespace: "loyalty", key: "net_spent_total",     type: "number_decimal",  value: "__TOTAL__" },
          { namespace: "loyalty", key: "reszvenyek_szama",    type: "number_integer",  value: "__TOTAL_SHARES__" },
          { namespace: "loyalty", key: "last_order_value",    type: "number_decimal",  value: "__SUBTOTAL__" },
          { namespace: "custom",  key: "jelenlegi_fennmarado", type: "number_decimal",  value: "__REMCURR__" }
        ]
      }) { userErrors { field message } }
      orderUpdate(input: {
        id: $orderGid,
        metafields: [
          { namespace: "custom", key: "order_share",      type: "number_integer", value: "__NEW_SHARES__" },
          { namespace: "custom", key: "osszes_koltes",     type: "number_decimal", value: "__TOTAL__" },
          { namespace: "custom", key: "fennmarado_osszeg", type: "number_decimal", value: "__REMCURR__" }
        ]
      }) { userErrors { field message } }
    }
  `;
  const gql = baseGql
    .replace(/__TOTAL__/g,        total.toFixed(2))
    .replace(/__TOTAL_SHARES__/,  totalShares.toString())
    .replace(/__SUBTOTAL__/,      subtotal.toFixed(2))
    .replace(/__REMCURR__/g,      remCurrent.toFixed(2))
    .replace(/__NEW_SHARES__/,    newShares.toString());

  const variables = {
    custId:   `gid://shopify/Customer/${order.customer.id}`,
    orderGid: `gid://shopify/Order/${order.id}`
  };

  // 5) Mutáció küldése
  try {
    const mres  = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: gql, variables })
    });
    const mjson = await mres.json();
    console.log('✅ Mutation result:', JSON.stringify(mjson, null, 2));
  } catch (e) {
    console.error('❌ Mutation failed:', e);
    return res.writeHead(500).end('Mutation error');
  }

  console.log('🏁 Order-creation handler done');
  res.writeHead(200).end('OK');
};
