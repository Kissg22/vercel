// lib/recalculate.js
const { fetch } = require('undici');

async function recalcCustomer(shopName, token, customerId, changedOrderId = null) {
  console.log(`🛠  recalcCustomer start for customer ${customerId}`);
  const shareUnit       = Number(process.env.SHARE_UNIT);
  const apiVersion      = process.env.SHOPIFY_API_VERSION;
  const graphqlEndpoint = `https://${shopName}.myshopify.com/admin/api/${apiVersion}/graphql.json`;
  const restBase        = `https://${shopName}.myshopify.com/admin/api/${apiVersion}/orders.json`;

  // 1) REST: Paginated fetch of all orders
  let orders = [];
  let nextPageInfo = null;
  try {
    do {
      const params = new URLSearchParams({
        status:      'any',
        customer_id: customerId,
        limit:       '250'
      });
      if (nextPageInfo) params.set('page_info', nextPageInfo);

      const url = `${restBase}?${params.toString()}`;
      console.log(`🔍 Fetching orders page: ${url}`);
      const resp = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      });
      if (!resp.ok) throw new Error(`Orders fetch failed: ${resp.status}`);
      const body = await resp.json();
      console.log(`✅ Retrieved ${body.orders?.length || 0} orders`);
      orders = orders.concat(body.orders || []);

      const linkHeader = resp.headers.get('link') || '';
      const match = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>; rel="next"/);
      nextPageInfo = match ? match[1] : null;
    } while (nextPageInfo);
  } catch (e) {
    console.error('❌ Error during paginated orders fetch:', e);
    throw e;
  }

  console.log(`📦 Total orders fetched: ${orders.length}`);
  orders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  // 2) Ha van changedOrderId, seedeljük cumSpend/cumShares-t az előző rendelés meta-ből
  let cumSpend  = 0;
  let cumShares = 0;
  let startIndex = 0;

  if (changedOrderId) {
    const idx = orders.findIndex(o => String(o.id) === String(changedOrderId));
    if (idx > 0) {
      const prevOrder = orders[idx - 1];
      console.log(`🔍 Seeding from previous order ${prevOrder.name} (${prevOrder.id})`);
      try {
        const metaResp = await fetch(graphqlEndpoint, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            query: `
              query getOrderMeta($id: ID!) {
                order(id: $id) {
                  metafield(namespace: "custom", key: "osszes_koltes") {
                    value
                  }
                }
              }`,
            variables: { id: `gid://shopify/Order/${prevOrder.id}` }
          })
        });
        const { data } = await metaResp.json();
        cumSpend  = parseFloat(data.order.metafield?.value || 0);
        cumShares = Math.floor(cumSpend / shareUnit);
        console.log(`🔢 Seeded cumSpend=${cumSpend.toFixed(2)}, cumShares=${cumShares}`);
      } catch (e) {
        console.error('❌ Error fetching previous order metafield:', e);
      }
    }
    startIndex = idx >= 0 ? idx : 0;
    console.log(`🔄 Recalculating from index ${startIndex} (order ${changedOrderId})`);
  }

  // 3) Iterate & recalc from startIndex onward
  for (let i = startIndex; i < orders.length; i++) {
    const o        = orders[i];
    const id       = o.id;
    const name     = o.name;
    const subtotal = parseFloat(o.subtotal_price || 0);
    let effective  = 0;

    if (o.cancelled_at) {
      console.log(`↩️  Order ${name} (${id}) cancelled → effective=0`);
    } else {
      // 3a) Fetch refunds
      console.log(`💸 Fetching refunds for order ${name} (${id})`);
      let refunded = 0;
      try {
        const refundsResp = await fetch(
          `https://${shopName}.myshopify.com/admin/api/${apiVersion}/orders/${id}/refunds.json`,
          {
            headers: {
              'X-Shopify-Access-Token': token,
              'Content-Type': 'application/json'
            }
          }
        );
        const { refunds = [] } = await refundsResp.json();
        for (const r of refunds) {
          for (const li of r.refund_line_items || []) {
            const amt = parseFloat(
              li.subtotal_set?.presentment_money?.amount
              ?? li.subtotal
              ?? 0
            );
            refunded += amt;
          }
        }
      } catch (e) {
        console.error(`❌ Error fetching refunds for order ${id}:`, e);
      }
      effective = Math.max(0, subtotal - refunded);
      console.log(`↔️  Order ${name} subtotal=${subtotal.toFixed(2)}, refunded=${refunded.toFixed(2)} → effective=${effective.toFixed(2)}`);
    }

    cumSpend += effective;
    const totalShares = Math.floor(cumSpend / shareUnit);
    const orderShares = totalShares - cumShares;
    cumShares = totalShares;
    const remainder = cumSpend % shareUnit;

    console.log(`🔢 After order ${name}: cumSpend=${cumSpend.toFixed(2)}, orderShares=${orderShares}, cumShares=${cumShares}, remainder=${remainder.toFixed(2)}`);

    // 3b) Update order metafields
    try {
      const mutation = `
        mutation orderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            userErrors { field message }
          }
        }`;
      const variables = {
        input: {
          id: `gid://shopify/Order/${id}`,
          metafields: [
            { namespace: 'custom', key: 'osszes_koltes',     type: 'number_decimal',  value: cumSpend.toFixed(2) },
            { namespace: 'custom', key: 'order_share',       type: 'number_integer',  value: orderShares.toString() },
            { namespace: 'custom', key: 'fennmarado_osszeg', type: 'number_decimal',  value: remainder.toFixed(2) }
          ]
        }
      };
      const resp = await fetch(graphqlEndpoint, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: mutation, variables })
      });
      const j = await resp.json();
      if (j.data.orderUpdate.userErrors.length) {
        console.error(`❌ orderUpdate errors for ${name}:`, j.data.orderUpdate.userErrors);
      } else {
        console.log(`✅ Order ${name} metafields updated`);
      }
    } catch (e) {
      console.error(`❌ Error updating metafields for order ${id}:`, e);
    }
  }

  // 4) Update customer metafields
  console.log(`🏁 Finished orders loop, now updating customer ${customerId}`);
  try {
    const custMutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          userErrors { field message }
        }
      }`;
    const custVariables = {
      input: {
        id: `gid://shopify/Customer/${customerId}`,
        metafields: [
          { namespace: 'loyalty', key: 'net_spent_total',      type: 'number_decimal', value: cumSpend.toFixed(2) },
          { namespace: 'loyalty', key: 'reszvenyek_szama',     type: 'number_integer', value: cumShares.toString() },
          { namespace: 'custom',  key: 'jelenlegi_fennmarado', type: 'number_decimal', value: (cumSpend % shareUnit).toFixed(2) }
        ]
      }
    };
    const resp = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: custMutation, variables: custVariables })
    });
    const j = await resp.json();
    if (j.data.customerUpdate.userErrors.length) {
      console.error('❌ customerUpdate errors:', j.data.customerUpdate.userErrors);
    } else {
      console.log('✅ Customer metafields updated');
    }
  } catch (e) {
    console.error('❌ Error updating customer metafields:', e);
  }

  console.log(`🚀 recalcCustomer finished for customer ${customerId}`);
}

module.exports = { recalcCustomer };
