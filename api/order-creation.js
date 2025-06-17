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

  // 1) Raw body + HMAC validáció
  let buf;
  try { buf = await getRawBody(req); }
  catch (e) { console.error('❌ Error reading body:', e); return res.writeHead(400).end('Invalid body'); }

  const hmac    = req.headers['x-shopify-hmac-sha256'];
  const digest  = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
                        .update(buf).digest('base64');
  if (!hmac || hmac !== digest) {
    console.error('❌ HMAC validation failed (got %s, expected %s)', hmac, digest);
    return res.writeHead(401).end('HMAC validation failed');
  }
  console.log('✅ HMAC passed');

  // 2) Parse payload
  let order;
  try { order = JSON.parse(buf.toString()); }
  catch (e) { console.error('❌ Invalid JSON payload:', e); return res.writeHead(400).end('Invalid JSON'); }
  console.log(`🔔 Received order creation: ${order.id}`);

  const subtotal  = parseFloat(order.subtotal_price);
  const shop      = process.env.SHOPIFY_SHOP_NAME;
  const token     = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const endpoint  = `https://${shop}.myshopify.com/admin/api/2023-10/graphql.json`;
  const shareUnit = 12700;

  // 3) Egyetlen GraphQL round-trip: lekérdezzük a korábbi spendinget, 
  //    majd customerUpdate + orderUpdate egyben
  const gql = `
    query getPrevious($custId: ID!) {
      prev: customer(id: $custId) {
        mf: metafield(namespace: "loyalty", key: "net_spent_total") { value }
      }
    }
    
    mutation updateBoth(
      $custId: ID!,
      $orderGid: ID!,
      $newTotal: Decimal!,
      $newShares: Int!,
      $subt: Decimal!,
      $rem: Decimal!
    ) {
      cu: customerUpdate(input: {
        id: $custId,
        metafields: [
          { namespace: "loyalty", key: "net_spent_total",  type: "number_decimal",  value: "${'${newTotal}'}" },
          { namespace: "loyalty", key: "reszvenyek_szama", type: "number_integer",  value: "${'${newShares}'}" },
          { namespace: "loyalty", key: "last_order_value", type: "number_decimal",  value: "${'${subt}'}" },
          { namespace: "custom",  key: "jelenlegi_fennmarado", type: "number_decimal", value: "${'${rem}'}" }
        ]
      }) { userErrors { field message } }
      ou: orderUpdate(input: {
        id: $orderGid,
        metafields: [
          { namespace: "custom", key: "order_share",      type: "number_integer", value: "${'${newShares}'}" },
          { namespace: "custom", key: "osszes_koltes",     type: "number_decimal",  value: "${'${newTotal}'}" },
          { namespace: "custom", key: "fennmarado_osszeg", type: "number_decimal",  value: "${'${rem}'}" }
        ]
      }) { userErrors { field message } }
    }
  `;

  // 3a) First: lekérdezzük a prev spendinget
  let prev = 0;
  try {
    const readRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: gql.split('mutation')[0],
        variables: { custId: `gid://shopify/Customer/${order.customer.id}` }
      })
    });
    const { data } = await readRes.json();
    prev = parseFloat(data.prev?.mf?.value || '0');
  } catch (e) {
    console.error('❌ Fetch previous spending failed:', e);
    return res.writeHead(500).end('Fetch previous spending error');
  }

  // 3b) Újraszámoljuk
  const total       = prev + subtotal;
  const prevShares  = Math.floor(prev / shareUnit);
  const totalShares = Math.floor(total / shareUnit);
  const newShares   = totalShares - prevShares;
  const remCurrent  = total % shareUnit;

  console.log('📈 Previous spend:', prev.toFixed(2));
  console.log('📊 New total spend:', total.toFixed(2));
  console.log('🎯 New shares:', newShares);
  console.log('💰 New remainder:', remCurrent.toFixed(2));

  // 3c) Ezután egyszerre küldjük a mutációt
  try {
    const mres = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: gql,
        variables: {
          custId:    `gid://shopify/Customer/${order.customer.id}`,
          orderGid:  `gid://shopify/Order/${order.id}`,
          newTotal:  total.toFixed(2),
          newShares: newShares,
          subt:      subtotal.toFixed(2),
          rem:       remCurrent.toFixed(2)
        }
      })
    });
    const mjson = await mres.json();
    console.log('✅ Mutation result:', JSON.stringify(mjson, null, 2));
  } catch (e) {
    console.error('❌ Combined mutation failed:', e);
    return res.writeHead(500).end('Mutation error');
  }

  console.log('🏁 Order-creation handler done');
  res.writeHead(200).end('OK');
};
