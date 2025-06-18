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
  const shareUnit  = Number(process.env.SHARE_UNIT);
  const endpoint   = `https://${shop}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

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

  // 3b) Számoljuk az új értékeket
  const total        = prev + subtotal;
  const prevShares   = Math.floor(prev / shareUnit);
  const totalShares  = Math.floor(total / shareUnit);
  const newShares    = totalShares - prevShares;
  const remCurrent   = total % shareUnit;

  // Logoljuk az értékeket
  console.log('📑 Subtotal for this order:    ', subtotal.toFixed(2));
  console.log('📈 Previous total spent:      ', prev.toFixed(2));
  console.log('📊 New total spending:        ', total.toFixed(2));
  console.log('🎯 Previous shares count:     ', prevShares);
  console.log('🆕 Shares earned now:         ', newShares);
  console.log('💰 Remainder before:          ', (prev % shareUnit).toFixed(2));
  console.log('💰 Remainder after:           ', remCurrent.toFixed(2));

  // 4) Customer és Order mutációk külön-külön
  try {
    // Customer update
    const custMutRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: `
          mutation customerUpdate($input: CustomerInput!) {
            customerUpdate(input: $input) {
              userErrors { field message }
            }
          }
        `,
        variables: {
          input: {
            id: `gid://shopify/Customer/${order.customer.id}`,
            metafields: [
              {
                namespace: 'loyalty',
                key: 'net_spent_total',
                type: 'number_decimal',
                value: total.toFixed(2)
              },
              {
                namespace: 'loyalty',
                key: 'reszvenyek_szama',
                type: 'number_integer',
                value: totalShares.toString()
              },
              {
                namespace: 'loyalty',
                key: 'last_order_value',
                type: 'number_decimal',
                value: subtotal.toFixed(2)
              },
              {
                namespace: 'custom',
                key: 'jelenlegi_fennmarado',
                type: 'number_decimal',
                value: remCurrent.toFixed(2)
              }
            ]
          }
        }
      })
    });
    const custJson = await custMutRes.json();
    if (custJson.data.customerUpdate.userErrors.length) {
      console.error('❌ Customer update errors:', custJson.data.customerUpdate.userErrors);
      return res.writeHead(500).end('Customer mutation error');
    }

    // Order update
    const orderMutRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: `
          mutation orderUpdate($input: OrderInput!) {
            orderUpdate(input: $input) {
              userErrors { field message }
            }
          }
        `,
        variables: {
          input: {
            id: `gid://shopify/Order/${order.id}`,
            metafields: [
              {
                namespace: 'custom',
                key: 'order_share',
                type: 'number_integer',
                value: newShares.toString()
              },
              {
                namespace: 'custom',
                key: 'osszes_koltes',
                type: 'number_decimal',
                value: total.toFixed(2)
              },
              {
                namespace: 'custom',
                key: 'fennmarado_osszeg',
                type: 'number_decimal',
                value: remCurrent.toFixed(2)
              }
            ]
          }
        }
      })
    });
    const orderJson = await orderMutRes.json();
    if (orderJson.data.orderUpdate.userErrors.length) {
      console.error('❌ Order update errors:', orderJson.data.orderUpdate.userErrors);
      return res.writeHead(500).end('Order mutation error');
    }
  } catch (e) {
    console.error('❌ Error updating metafields:', e);
    return res.writeHead(500).end('Metafield update error');
  }

  console.log('✅ Everything updated successfully.');
  res.writeHead(200).end('OK');
};
