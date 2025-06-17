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

  let buf;
  try {
    buf = await getRawBody(req);
  } catch (err) {
    console.error('Error reading body:', err);
    res.writeHead(400);
    return res.end('Invalid body');
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader) {
    res.writeHead(400);
    return res.end('Missing HMAC header');
  }
  const generated = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET_KEY)
    .update(buf)
    .digest('base64');
  if (generated !== hmacHeader) {
    res.writeHead(401);
    return res.end('HMAC validation failed');
  }

  let order;
  try {
    order = JSON.parse(buf.toString());
  } catch {
    res.writeHead(400);
    return res.end('Invalid JSON');
  }

  console.log(`🔔 Received order creation: ${order.id}`);

  const customerId = order.customer.id;
  const orderSubtotal = parseFloat(order.subtotal_price);
  const shopName = process.env.SHOPIFY_SHOP_NAME;
  const token = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const endpoint = `https://${shopName}.myshopify.com/admin/api/2023-10/graphql.json`;

  const shareUnit = 12700;

  let previousSpending = 0;
  try {
    const getQ = `
      query {
        customer(id: "gid://shopify/Customer/${customerId}") {
          metafield(namespace: "loyalty", key: "net_spent_total") { value }
        }
      }`;
    const getRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: getQ })
    });
    const getJson = await getRes.json();
    const rawValue = getJson.data.customer.metafield?.value;
    previousSpending = rawValue ? parseFloat(rawValue) : 0;
  } catch (err) {
    console.error('Error fetching customer metafield:', err);
    res.writeHead(500);
    return res.end('Error fetching metafield');
  }

  const newTotalSpending = previousSpending + orderSubtotal;

  const previousShares = Math.floor(previousSpending / shareUnit);
  const totalShares = Math.floor(newTotalSpending / shareUnit);
  const newlyEarnedShares = totalShares - previousShares;

  const fennmarado_osszeg = previousSpending % shareUnit;
  const osszes_koltes = newTotalSpending;
  const jelenlegi_fennmarado = newTotalSpending % shareUnit;

  console.log(`📊 Total spending: ${newTotalSpending}`);
  console.log(`🎯 Total shares: ${totalShares}`);
  console.log(`🆕 Order shares: ${newlyEarnedShares}`);

  // ✅ Customer metafield update:
  try {
    const customerMutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          userErrors { field message }
        }
      }`;
    const customerVariables = {
      input: {
        id: `gid://shopify/Customer/${customerId}`,
        metafields: [
          {
            namespace: 'loyalty',
            key: 'net_spent_total',
            type: 'number_decimal',
            value: newTotalSpending.toFixed(2)
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
            value: orderSubtotal.toFixed(2)
          },
          {
            namespace: 'custom',
            key: 'jelenlegi_fennmarado',
            type: 'number_decimal',
            value: jelenlegi_fennmarado.toFixed(2)
          }
        ]
      }
    };

    const customerRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: customerMutation, variables: customerVariables })
    });

    const customerJson = await customerRes.json();
    const customerErrs = customerJson.data.customerUpdate.userErrors;
    if (customerErrs.length) {
      console.error('Customer update errors:', customerErrs);
      res.writeHead(500);
      return res.end('Customer mutation error');
    }
  } catch (err) {
    console.error('Error updating customer metafields:', err);
    res.writeHead(500);
    return res.end('Error updating customer metafields');
  }

  // ✅ Order metafield update:
  try {
    const orderMutation = `
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          userErrors { field message }
        }
      }`;
    const orderVariables = {
      input: {
        id: `gid://shopify/Order/${order.id}`,
        metafields: [
          {
            namespace: 'custom',
            key: 'order_share',
            type: 'number_integer',
            value: newlyEarnedShares.toString()
          },
          {
            namespace: 'custom',
            key: 'osszes_koltes',
            type: 'number_decimal',
            value: osszes_koltes.toFixed(2)
          },
          {
            namespace: 'custom',
            key: 'fennmarado_osszeg',
            type: 'number_decimal',
            value: fennmarado_osszeg.toFixed(2)
          }
        ]
      }
    };

    const orderRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: orderMutation, variables: orderVariables })
    });

    const orderJson = await orderRes.json();
    const orderErrs = orderJson.data.orderUpdate.userErrors;
    if (orderErrs.length) {
      console.error('Order update errors:', orderErrs);
      res.writeHead(500);
      return res.end('Order mutation error');
    }
  } catch (err) {
    console.error('Error updating order metafields:', err);
    res.writeHead(500);
    return res.end('Error updating order metafields');
  }

  console.log('✅ Everything updated successfully.');
  res.writeHead(200);
  res.end('OK');
};
