// lib/recalculate.js
const { fetch } = require('undici');

async function recalcCustomer(shopName, token, customerId, changedOrderId = null) {
  console.log(`🛠  recalcCustomer start for customer ${customerId}`);

  const shareUnit       = Number(process.env.SHARE_UNIT);
  const apiVersion      = process.env.SHOPIFY_API_VERSION;
  const graphqlEndpoint = `https://${shopName}.myshopify.com/admin/api/${apiVersion}/graphql.json`;

  let cumSpend  = 0;
  let cumShares = 0;

  // Ha nincs changedOrderId, innentől a teljes történetet kellene végigjárni...
  if (!changedOrderId) {
    throw new Error('recalcCustomer: changedOrderId must be provided');
  }

  // 1) Lekérjük a változott rendelés createdAt-jét
  const changedQuery = `
    query getChanged($id: ID!) {
      order(id: $id) { createdAt }
    }`;
  const changedResp = await fetch(graphqlEndpoint, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: changedQuery, variables: { id: `gid://shopify/Order/${changedOrderId}` } })
  });
  const { data: { order: changedOrder } } = await changedResp.json();
  const changedAt = changedOrder.createdAt;
  console.log(`🔔 Changed order createdAt: ${changedAt}`);

  // 2) Lekérjük az egyetlen korábbi rendelést (sortKey=CREATED_AT, reverse=true, first=1)
  const prevQuery = `
    query getPrev($query: String!) {
      orders(first: 1, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            metafield(namespace: "custom", key: "osszes_koltes") { value }
          }
        }
      }
    }`;
  const prevQueryStr = `customer_id:${customerId} created_at:<${changedAt}`;
  const prevResp = await fetch(graphqlEndpoint, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: prevQuery, variables: { query: prevQueryStr } })
  });
  const prevEdges = (await prevResp.json()).data.orders.edges;
  if (prevEdges.length) {
    const prev = prevEdges[0].node;
    cumSpend  = parseFloat(prev.metafield?.value || 0);
    cumShares = Math.floor(cumSpend / shareUnit);
    console.log(`🔢 Seed from ${prev.id}: cumSpend=${cumSpend.toFixed(2)}, cumShares=${cumShares}`);
  } else {
    console.log(`⚠️ No previous order before ${changedOrderId}, starting from zero`);
  }

  // 3) Paginated GraphQL lekérdezés a changedOrderId-tól kezdve
  const orders = [];
  let cursor = null;
  do {
    const pageQuery = `
      query getAfter($query: String!, $after: String) {
        orders(first: 250, query: $query, after: $after, sortKey: CREATED_AT, reverse: false) {
          edges {
            node {
              id
              name
              createdAt
              cancelledAt
              subtotalPrice
            }
            cursor
          }
          pageInfo { hasNextPage }
        }
      }`;
    // query: customer + created_at:>=changedAt
    const pageQueryStr = `customer_id:${customerId} created_at:>=${changedAt}`;
    const pageResp = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: pageQuery,
        variables: { query: pageQueryStr, after: cursor }
      })
    });
    const pageData = (await pageResp.json()).data.orders;
    for (const edge of pageData.edges) {
      orders.push(edge.node);
      cursor = edge.cursor;
    }
    if (!pageData.pageInfo.hasNextPage) break;
  } while (true);

  console.log(`📦 Orders to recalc: ${orders.length}`);

  // 4) Végigmegyünk a fetched rendeléseken, kiszámoljuk az effective-t és update-eljük
  for (const o of orders) {
    const id       = o.id.split('/').pop();
    const name     = o.name;
    const subtotal = parseFloat(o.subtotalPrice || 0);
    let effective  = o.cancelledAt ? 0 : subtotal;

    // csak akkor fetch-eljük a refundokat, ha nem cancelled
    if (!o.cancelledAt) {
      console.log(`💸 Fetching refunds for ${name}`);
      let refunded = 0;
      try {
        const refundsResp = await fetch(
          `https://${shopName}.myshopify.com/admin/api/${apiVersion}/orders/${id}/refunds.json`,
          { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } }
        );
        const { refunds = [] } = await refundsResp.json();
        for (const r of refunds) {
          for (const li of r.refund_line_items || []) {
            refunded += parseFloat(li.subtotal_set?.presentment_money?.amount ?? li.subtotal ?? 0);
          }
        }
      } catch (e) {
        console.error(`❌ Refund-fetch error for ${id}:`, e);
      }
      effective = Math.max(0, subtotal - refunded);
    }

    cumSpend += effective;
    const totalShares = Math.floor(cumSpend / shareUnit);
    const orderShares = totalShares - cumShares;
    cumShares = totalShares;
    const remainder = cumSpend % shareUnit;

    console.log(`🔢 ${name}: eff=${effective.toFixed(2)}, cumSpend=${cumSpend.toFixed(2)}, shares=${orderShares}, totalShares=${cumShares}`);

    // GraphQL mutation az order metafieldek frissítéséhez
    const mut = `
      mutation updateOrder($input: OrderInput!) {
        orderUpdate(input: $input) { userErrors { field message } }
      }`;
    const vars = {
      input: {
        id: `gid://shopify/Order/${id}`,
        metafields: [
          { namespace: 'custom', key: 'osszes_koltes',     type: 'number_decimal', value: cumSpend.toFixed(2) },
          { namespace: 'custom', key: 'order_share',       type: 'number_integer', value: orderShares.toString() },
          { namespace: 'custom', key: 'fennmarado_osszeg', type: 'number_decimal', value: remainder.toFixed(2) }
        ]
      }
    };
    try {
      const resp = await fetch(graphqlEndpoint, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: mut, variables: vars })
      });
      const errs = (await resp.json()).data.orderUpdate.userErrors;
      if (errs.length) console.error('❌ OrderUpdate errors:', errs);
      else console.log(`✅ ${name} metafields updated`);
    } catch (e) {
      console.error(`❌ OrderUpdate failed for ${id}:`, e);
    }
  }

  // 5) Végül a customer metafieldek
  console.log(`🏁 Updating customer ${customerId}`);
  const custMut = `
    mutation updateCust($input: CustomerInput!) {
      customerUpdate(input: $input) { userErrors { field message } }
    }`;
  const custVars = {
    input: {
      id: `gid://shopify/Customer/${customerId}`,
      metafields: [
        { namespace: 'loyalty', key: 'net_spent_total',  type: 'number_decimal', value: cumSpend.toFixed(2) },
        { namespace: 'loyalty', key: 'reszvenyek_szama', type: 'number_integer', value: cumShares.toString() },
        { namespace: 'custom',  key: 'jelenlegi_fennmarado', type: 'number_decimal', value: (cumSpend % shareUnit).toFixed(2) }
      ]
    }
  };
  try {
    const resp = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: custMut, variables: custVars })
    });
    const errs = (await resp.json()).data.customerUpdate.userErrors;
    if (errs.length) console.error('❌ CustomerUpdate errors:', errs);
    else console.log('✅ Customer metafields updated');
  } catch (e) {
    console.error('❌ CustomerUpdate failed:', e);
  }

  console.log(`🚀 recalcCustomer finished for customer ${customerId}`);
}

module.exports = { recalcCustomer };
