// lib/recalculate.js
const { fetch } = require('undici');
const url = require('url');

async function recalcCustomer(shopName, token, customerId) {
  const shareUnit = 12700;
  const graphqlEndpoint = `https://${shopName}.myshopify.com/admin/api/2023-10/graphql.json`;
  const restBase         = `https://${shopName}.myshopify.com/admin/api/2023-10/orders.json`;

  // 1) REST: Paginated fetch of all orders
  let orders = [];
  let nextPageInfo = null;
  do {
    // Build URL with or without page_info
    const params = new URLSearchParams({
      status:      'any',
      customer_id: customerId,
      limit:       '250'
    });
    if (nextPageInfo) params.set('page_info', nextPageInfo);
    const fetchUrl = `${restBase}?${params.toString()}`;

    const resp = await fetch(fetchUrl, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });
    if (!resp.ok) throw new Error(`Orders fetch failed: ${resp.status}`);

    const body = await resp.json();
    orders    = orders.concat(body.orders || []);

    // Parse Link header for rel="next"
    const linkHeader = resp.headers.get('link') || '';
    const match = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>; rel="next"/);
    nextPageInfo = match ? match[1] : null;
  } while (nextPageInfo);

  // Sort by created_at ascending
  orders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  let cumSpend  = 0;
  let cumShares = 0;

  // 2) Iterate & recalc each order
  for (const o of orders) {
    const id       = o.id;
    const subtotal = parseFloat(o.subtotal_price || 0);
    let effective  = 0;

    if (o.cancelled_at) {
      // Cancelled orders count as zero
      effective = 0;
    } else {
      // 2a) Fetch refunds for this order
      const refundsResp = await fetch(
        `https://${shopName}.myshopify.com/admin/api/2023-10/orders/${id}/refunds.json`,
        {
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
          }
        }
      );
      const { refunds = [] } = await refundsResp.json();

      // Sum up refunded amounts
      let refunded = 0;
      for (const r of refunds) {
        for (const li of r.refund_line_items || []) {
          refunded += parseFloat(
            li.subtotal_set?.presentment_money?.amount
            ?? li.subtotal
            ?? 0
          );
        }
      }
      effective = Math.max(0, subtotal - refunded);
    }

    cumSpend += effective;
    const totalShares = Math.floor(cumSpend / shareUnit);
    const orderShares = totalShares - cumShares;
    cumShares = totalShares;
    const remainder = cumSpend % shareUnit;

    // 2b) Update this order's metafields via GraphQL
    const orderMutation = `
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          userErrors { field message }
        }
      }`;
    const orderVars = {
      input: {
        id: `gid://shopify/Order/${id}`,
        metafields: [
          { namespace: 'custom', key: 'osszes_koltes',     type: 'number_decimal',  value: cumSpend.toFixed(2) },
          { namespace: 'custom', key: 'order_share',       type: 'number_integer',  value: orderShares.toString() },
          { namespace: 'custom', key: 'fennmarado_osszeg', type: 'number_decimal',  value: remainder.toFixed(2) }
        ]
      }
    };
    await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: orderMutation, variables: orderVars })
    });
  }

  // 3) Finally, update customer metafields
  const customerMutation = `
    mutation customerUpdate($input: CustomerInput!) {
      customerUpdate(input: $input) {
        userErrors { field message }
      }
    }`;
  const customerVars = {
    input: {
      id: `gid://shopify/Customer/${customerId}`,
      metafields: [
        { namespace: 'loyalty', key: 'net_spent_total',      type: 'number_decimal', value: cumSpend.toFixed(2) },
        { namespace: 'loyalty', key: 'reszvenyek_szama',     type: 'number_integer', value: cumShares.toString() },
        { namespace: 'custom',  key: 'jelenlegi_fennmarado', type: 'number_decimal', value: (cumSpend % shareUnit).toFixed(2) }
      ]
    }
  };
  await fetch(graphqlEndpoint, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: customerMutation, variables: customerVars })
  });
}

module.exports = { recalcCustomer };
