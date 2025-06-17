// lib/recalculate.js
const { fetch } = require('undici');

async function recalcCustomer(shopName, token, customerId) {
  console.log(`🛠  recalcCustomer start for customer ${customerId}`);
  const shareUnit = 12700;
  const graphqlEndpoint = `https://${shopName}.myshopify.com/admin/api/2023-10/graphql.json`;
  const restBase         = `https://${shopName}.myshopify.com/admin/api/2023-10/orders.json`;

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
      const fetchUrl = `${restBase}?${params.toString()}`;
      console.log(`🔍 Fetching orders page: ${fetchUrl}`);

      const resp = await fetch(fetchUrl, {
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

  let cumSpend  = 0;
  let cumShares = 0;

  // 2) Iterate & recalc each order
  for (const o of orders) {
    const id       = o.id;
    const name     = o.name;
    const subtotal = parseFloat(o.subtotal_price || 0);
    let effective  = 0;

    if (o.cancelled_at) {
      effective = 0;
      console.log(`↩️  Order ${name} (${id}) cancelled → effective=0`);
    } else {
      // 2a) Fetch refunds
      console.log(`💸 Fetching refunds for order ${name} (${id})`);
      let refunded = 0;
      try {
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
      console.log(`↔️  Order ${name} subtotal ${subtotal.toFixed(2)}, refunded ${refunded.toFixed(2)} → effective ${effective.toFixed(2)}`);
    }

    cumSpend += effective;
    const totalShares = Math.floor(cumSpend / shareUnit);
    const orderShares = totalShares - cumShares;
    cumShares = totalShares;
    const remainder = cumSpend % shareUnit;

    console.log(`🔢 After order ${name}: cumSpend=${cumSpend.toFixed(2)}, orderShares=${orderShares}, cumShares=${cumShares}, remainder=${remainder.toFixed(2)}`);

    // 2b) Update order metafields
    try {
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
      const resp = await fetch(graphqlEndpoint, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: orderMutation, variables: orderVars })
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

  // 3) Finally, update customer metafields
  console.log(`🏁 Finished orders loop, now updating customer ${customerId}`);
  try {
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
    const resp = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: customerMutation, variables: customerVars })
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
