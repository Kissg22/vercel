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

  let customerId;
  try {
    const orderQuery = `
      query {
        order(id: "gid://shopify/Order/${orderId}") {
          customer { id }
          metafield(namespace: "custom", key: "osszes_koltes") { value }
          metafield(namespace: "custom", key: "order_share") { value }
        }
      }`;

    const orderRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: orderQuery })
    });

    const orderJson = await orderRes.json();
    const orderData = orderJson.data.order;
    customerId = orderData.customer?.id;
    const orderOsszesKoltes = parseFloat(orderData.metafield?.value || 0);
    const orderShareCurrent = parseInt(orderData.metafield?.value || 0);

    if (!customerId) {
      console.error('❌ Customer not found for order.');
      res.writeHead(400);
      return res.end('Customer not found.');
    }

    // Összesített order adatokat kimentjük (használni fogjuk később)
    order.originalOsszesKoltes = orderOsszesKoltes;
    order.originalOrderShare = orderShareCurrent;

  } catch (err) {
    console.error('Error fetching order data:', err);
    res.writeHead(500);
    return res.end('Error fetching order.');
  }

  // Refund összeg kiszámítása
  let refundSubtotal = 0;
  for (const refundItem of refund.refund_line_items || []) {
    const amount = parseFloat(refundItem.subtotal_set?.presentment_money?.amount || 0);
    refundSubtotal += amount;
  }
  console.log(`💸 Refund subtotal to deduct: ${refundSubtotal}`);

  // Lekérjük a customer jelenlegi net_spent_total-ját
  let previousSpending = 0;
  try {
    const customerQuery = `
      query {
        customer(id: "${customerId}") {
          metafield(namespace: "loyalty", key: "net_spent_total") { value }
        }
      }`;

    const customerRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: customerQuery })
    });

    const customerJson = await customerRes.json();
    const rawValue = customerJson.data.customer.metafield?.value;
    previousSpending = rawValue ? parseFloat(rawValue) : 0;
  } catch (err) {
    console.error('Error fetching customer spending:', err);
    res.writeHead(500);
    return res.end('Error fetching spending');
  }

  let newTotalSpending = previousSpending - refundSubtotal;
  if (newTotalSpending < 0) newTotalSpending = 0;

  const newTotalShares = Math.floor(newTotalSpending / shareUnit);
  const newFennmarado = newTotalSpending % shareUnit;

  console.log(`📊 New customer spending: ${newTotalSpending}`);
  console.log(`🎯 New customer shares: ${newTotalShares}`);
  console.log(`➗ New remainder: ${newFennmarado}`);

  // Update customer metafieldek:
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
            value: newTotalShares.toString()
          },
          {
            namespace: 'custom',
            key: 'jelenlegi_fennmarado',
            type: 'number_decimal',
            value: newFennmarado.toFixed(2)
          }
        ]
      }
    };

    const customerRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
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

  // 🔧 Frissítsük az adott order metafieldet is!
  try {
    const updatedOrderOsszesKoltes = order.originalOsszesKoltes - refundSubtotal;
    const updatedOrderShares = Math.floor(updatedOrderOsszesKoltes / shareUnit);
    const updatedFennmaradoOrder = updatedOrderOsszesKoltes % shareUnit;

    const orderMutation = `
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
            value: updatedOrderOsszesKoltes.toFixed(2)
          },
          {
            namespace: 'custom',
            key: 'order_share',
            type: 'number_integer',
            value: updatedOrderShares.toString()
          },
          {
            namespace: 'custom',
            key: 'fennmarado_osszeg',
            type: 'number_decimal',
            value: updatedFennmaradoOrder.toFixed(2)
          }
        ]
      }
    };

    const orderRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: orderMutation, variables: orderVariables })
    });

    const orderJson = await orderRes.json();
    const orderErrs = orderJson.data.orderUpdate.userErrors;
    if (orderErrs.length) {
      console.error('Order update errors:', orderErrs);
    }
  } catch (err) {
    console.error('Error updating order metafields:', err);
  }

  console.log('✅ Refund successfully processed with updated order + customer metafields.');
  res.writeHead(200);
  res.end('OK');
};
