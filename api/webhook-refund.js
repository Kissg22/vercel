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

  let customerId, orderCreatedAt;
  try {
    const orderQuery = `
      query {
        order(id: "gid://shopify/Order/${orderId}") {
          customer { id }
          createdAt
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
    customerId = orderJson.data.order.customer?.id;
    orderCreatedAt = orderJson.data.order.createdAt;

    if (!customerId) {
      console.error('❌ Customer not found for order.');
      res.writeHead(400);
      return res.end('Customer not found.');
    }
  } catch (err) {
    console.error('Error fetching order data:', err);
    res.writeHead(500);
    return res.end('Error fetching order.');
  }

  let refundSubtotal = 0;
  for (const refundItem of refund.refund_line_items || []) {
    const amount = parseFloat(refundItem.subtotal_set?.presentment_money?.amount || 0);
    refundSubtotal += amount;
  }
  console.log(`💸 Refund subtotal to deduct: ${refundSubtotal}`);

  let orders = [];
  try {
    const ordersRes = await fetch(`https://${shopName}.myshopify.com/admin/api/2023-10/orders.json?status=any&created_at_min=${orderCreatedAt}&customer_id=${customerId.split("/").pop()}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      }
    });

    const ordersJson = await ordersRes.json();
    orders = ordersJson.orders;
    console.log(`📦 Found ${orders.length} affected orders after refund`);
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.writeHead(500);
    return res.end('Error fetching orders');
  }

  let cumulativeSpending = 0;
  let cumulativeShares = 0;

  for (const order of orders) {
    if (order.id == orderId) {
      cumulativeSpending += parseFloat(order.subtotal_price) - refundSubtotal;
    } else {
      cumulativeSpending += parseFloat(order.subtotal_price);
    }

    const fennmarado_osszeg = cumulativeSpending % shareUnit;
    const newTotalShares = Math.floor(cumulativeSpending / shareUnit);
    const orderShares = newTotalShares - cumulativeShares;
    cumulativeShares = newTotalShares;

    console.log(`🔄 Recalculating order ${order.id}: cumulativeSpending=${cumulativeSpending}, shares=${orderShares}`);

    const updateOrderMutation = `
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
            value: orderShares.toString()
          },
          {
            namespace: 'custom',
            key: 'osszes_koltes',
            type: 'number_decimal',
            value: cumulativeSpending.toFixed(2)
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
  }

  // ✅ Customer metafield update (last_order_value + fennmarado_osszeg is mostantól)
  try {
    const lastOrderSubtotal = orders.length > 0 ? parseFloat(orders[orders.length - 1].subtotal_price) : 0;
    const fennmaradoJelenlegi = cumulativeSpending % shareUnit;

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
            value: cumulativeSpending.toFixed(2)
          },
          {
            namespace: 'loyalty',
            key: 'reszvenyek_szama',
            type: 'number_integer',
            value: cumulativeShares.toString()
          },
          {
            namespace: 'loyalty',
            key: 'last_order_value',
            type: 'number_decimal',
            value: lastOrderSubtotal.toFixed(2)
          },
          {
            namespace: 'custom',
            key: 'jelenlegi_fennmarado',
            type: 'number_decimal',
            value: fennmaradoJelenlegi.toFixed(2)
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

  console.log('✅ Refund recalculation successfully finished.');
  res.writeHead(200);
  res.end('OK');
};
