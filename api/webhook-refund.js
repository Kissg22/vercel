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

  let refund;
  try {
    refund = JSON.parse(buf.toString());
  } catch {
    res.writeHead(400);
    return res.end('Invalid JSON');
  }

  console.log(`🔔 Received refund webhook for order: ${refund.order_id}`);

  const shareUnit = 12700;
  const shopName = process.env.SHOPIFY_SHOP_NAME;
  const token = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const endpoint = `https://${shopName}.myshopify.com/admin/api/2023-10/graphql.json`;

  const orderId = refund.order_id;

  // 1️⃣ Lekérjük az order részleteit (customer ID + metafieldek)
  let customerId, osszes_koltes = 0, order_share = 0;
  try {
    const orderQuery = `
      query {
        order(id: "gid://shopify/Order/${orderId}") {
          customer { id }
          metafields(first: 10, namespace: "custom") {
            edges {
              node {
                key
                value
              }
            }
          }
        }
      }`;

    const orderRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: orderQuery })
    });

    const orderJson = await orderRes.json();

    if (!orderJson.data.order) {
      throw new Error('Order not found.');
    }

    customerId = orderJson.data.order.customer?.id;

    const metafields = orderJson.data.order.metafields.edges;
    for (const edge of metafields) {
      if (edge.node.key === 'osszes_koltes') {
        osszes_koltes = parseFloat(edge.node.value);
      }
      if (edge.node.key === 'order_share') {
        order_share = parseInt(edge.node.value);
      }
    }

    if (!customerId) {
      throw new Error('Customer not found.');
    }

  } catch (err) {
    console.error('Error fetching order data:', err);
    res.writeHead(500);
    return res.end('Error fetching order data');
  }

  // 2️⃣ Refund összeg kiszámítása
  let refundSubtotal = 0;
  for (const refundItem of refund.refund_line_items || []) {
    const amount = parseFloat(refundItem.subtotal_set?.presentment_money?.amount || 0);
    refundSubtotal += amount;
  }
  console.log(`💸 Refund subtotal: ${refundSubtotal}`);

  // 3️⃣ Új osszes_koltes és új order_share számolása
  let newOrderOsszesKoltes = osszes_koltes - refundSubtotal;
  if (newOrderOsszesKoltes < 0) newOrderOsszesKoltes = 0;

  const fennmarado = newOrderOsszesKoltes % shareUnit;
  const totalShares = Math.floor(newOrderOsszesKoltes / shareUnit);
  const newOrderShares = totalShares;

  console.log(`📉 New order osszes_koltes: ${newOrderOsszesKoltes}`);
  console.log(`📉 New order share: ${newOrderShares}`);

  // 4️⃣ Order metafield update
  try {
    const updateOrderMutation = `
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          userErrors { field message }
        }
      }`;

    const orderVariables = {
      input: {
        id: `gid://shopify/Order/${orderId}`,
        metafields: [
          {
            namespace: 'custom',
            key: 'osszes_koltes',
            type: 'number_decimal',
            value: newOrderOsszesKoltes.toFixed(2)
          },
          {
            namespace: 'custom',
            key: 'fennmarado_osszeg',
            type: 'number_decimal',
            value: fennmarado.toFixed(2)
          },
          {
            namespace: 'custom',
            key: 'order_share',
            type: 'number_integer',
            value: newOrderShares.toString()
          }
        ]
      }
    };

    const orderUpdateRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: updateOrderMutation, variables: orderVariables })
    });

    const orderUpdateJson = await orderUpdateRes.json();
    const orderErrs = orderUpdateJson.data.orderUpdate.userErrors;
    if (orderErrs.length) {
      console.error('Order update errors:', orderErrs);
    }
  } catch (err) {
    console.error('Error updating order metafields:', err);
  }

  // 5️⃣ Customer current net spent lekérése
  let previousSpending = 0;
  try {
    const getQ = `
      query {
        customer(id: "${customerId}") {
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
    return res.end('Error fetching customer metafield');
  }

  // 6️⃣ Customer update
  let newTotalSpending = previousSpending - refundSubtotal;
  if (newTotalSpending < 0) newTotalSpending = 0;

  const totalCustomerShares = Math.floor(newTotalSpending / shareUnit);
  const fennmaradoCustomer = newTotalSpending % shareUnit;

  try {
    const customerMutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          userErrors { field message }
        }
      }`;

    const customerVariables = {
      input: {
        id: customerId,
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
            value: totalCustomerShares.toString()
          },
          {
            namespace: 'custom',
            key: 'jelenlegi_fennmarado',
            type: 'number_decimal',
            value: fennmaradoCustomer.toFixed(2)
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
    }
  } catch (err) {
    console.error('Error updating customer metafields:', err);
  }

  console.log('✅ Refund processed successfully.');
  res.writeHead(200);
  res.end('OK');
};
