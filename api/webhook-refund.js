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

  // 🔧 1) Lekérjük a refundolt order adatait, hogy megszerezzük a customer id-t
  let customerId;
  try {
    const orderQuery = `
      query {
        order(id: "gid://shopify/Order/${orderId}") {
          customer { id }
        }
      }`;

    const orderRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: orderQuery })
    });

    const orderJson = await orderRes.json();
    customerId = orderJson.data.order.customer?.id;

    if (!customerId) throw new Error("Customer not found.");
  } catch (err) {
    console.error('Error fetching order data:', err);
    res.writeHead(500);
    return res.end('Error fetching order');
  }

  // 🔧 2) Refund összeg kiszámítása
  let refundSubtotal = 0;
  for (const refundItem of refund.refund_line_items || []) {
    const amount = parseFloat(refundItem.subtotal_set?.presentment_money?.amount || 0);
    refundSubtotal += amount;
  }
  console.log(`💸 Refund subtotal: ${refundSubtotal}`);

  // 🔧 3) Lekérjük az összes customerhez tartozó order-t
  let orders = [];
  try {
    const ordersQuery = `
      query {
        customer(id: "${customerId}") {
          orders(first: 100, sortKey: CREATED_AT, reverse: false) {
            edges {
              node {
                id
                name
                subtotalPriceSet { presentmentMoney { amount } }
                metafields(first: 10, namespace: "custom") {
                  edges {
                    node { key value }
                  }
                }
              }
            }
          }
        }
      }`;

    const ordersRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: ordersQuery })
    });

    const ordersJson = await ordersRes.json();
    orders = ordersJson.data.customer.orders.edges;

  } catch (err) {
    console.error('Error fetching customer orders:', err);
    res.writeHead(500);
    return res.end('Error fetching orders');
  }

  // 🔧 4) Újraszámoljuk az összes rendelést sorrendben
  let cumulativeSpending = 0;
  let cumulativeShares = 0;

  for (const edge of orders) {
    const order = edge.node;
    const shopifyOrderId = order.id;
    const subtotal = parseFloat(order.subtotalPriceSet.presentmentMoney.amount);

    let refundForThisOrder = 0;
    if (order.name === `#${refund.order_name}` || shopifyOrderId.includes(orderId)) {
      refundForThisOrder = refundSubtotal;
    }

    const adjustedSubtotal = Math.max(0, subtotal - refundForThisOrder);
    cumulativeSpending += adjustedSubtotal;

    const fennmarado_osszeg = cumulativeSpending % shareUnit;
    const totalSharesNow = Math.floor(cumulativeSpending / shareUnit);
    const orderShares = totalSharesNow - cumulativeShares;
    cumulativeShares = totalSharesNow;

    console.log(`🔄 Recalculating order ${order.name}: cumulativeSpending=${cumulativeSpending}, shares=${orderShares}`);

    const updateOrderMutation = `
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) { userErrors { field message } }
      }`;

    const orderVariables = {
      input: {
        id: shopifyOrderId,
        metafields: [
          { namespace: 'custom', key: 'osszes_koltes', type: 'number_decimal', value: cumulativeSpending.toFixed(2) },
          { namespace: 'custom', key: 'fennmarado_osszeg', type: 'number_decimal', value: fennmarado_osszeg.toFixed(2) },
          { namespace: 'custom', key: 'order_share', type: 'number_integer', value: orderShares.toString() }
        ]
      }
    };

    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: updateOrderMutation, variables: orderVariables })
    });
  }

  // 🔧 5) Customer metafield update
  try {
    const fennmaradoCustomer = cumulativeSpending % shareUnit;
    const customerMutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) { userErrors { field message } }
      }`;

    const customerVariables = {
      input: {
        id: customerId,
        metafields: [
          { namespace: 'loyalty', key: 'net_spent_total', type: 'number_decimal', value: cumulativeSpending.toFixed(2) },
          { namespace: 'loyalty', key: 'reszvenyek_szama', type: 'number_integer', value: cumulativeShares.toString() },
          { namespace: 'custom', key: 'jelenlegi_fennmarado', type: 'number_decimal', value: fennmaradoCustomer.toFixed(2) }
        ]
      }
    };

    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: customerMutation, variables: customerVariables })
    });
  } catch (err) {
    console.error('Error updating customer metafields:', err);
  }

  console.log('✅ Refund recalculation finished successfully.');
  res.writeHead(200);
  res.end('OK');
};
