require('dotenv').config();
const { fetch } = require('undici');

const API_VERSION = process.env.SHOPIFY_API_VERSION;
const SHARE_UNIT  = Number(process.env.SHARE_UNIT);

function gqlEndpoint(shop) {
  return `https://${shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;
}

async function recalcCustomer(shop, token, customerId) {
  console.log(`🛠  recalcCustomer start for customer ${customerId}`);
  const endpoint = gqlEndpoint(shop);

  let cumSpend = 0;
  let cumShares = 0;
  let cursor = null;
  let hasNext = true;

  // 1) Paginated GraphQL lekérdezés: orders + refunds
  while (hasNext) {
    const query = `
      query OrdersWithRefunds($cust: ID!, $after: String) {
        customer(id: $cust) {
          orders(first: 250, after: $after, sortKey: CREATED_AT) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                name
                cancelledAt
                subtotalPriceSet { presentmentMoney { amount } }
                refunds(first: 50) {
                  edges {
                    node {
                      refundLineItems(first: 100) {
                        edges {
                          node {
                            subtotalSet { presentmentMoney { amount } }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const variables = {
      cust: `gid://shopify/Customer/${customerId}`,
      after: cursor,
    };
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    const { data, errors } = await resp.json();
    if (errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);

    const orders = data.customer.orders.edges.map(e => e.node);
    hasNext = data.customer.orders.pageInfo.hasNextPage;
    cursor = data.customer.orders.pageInfo.endCursor;

    // 2) Számítás és előkészítés bulk‐update‐re
    const updates = orders.map(o => {
      const subtotal = parseFloat(o.subtotalPriceSet.presentmentMoney.amount);
      const refunded = o.refunds.edges.reduce((sum, { node }) =>
        sum + node.refundLineItems.edges.reduce((s, li) =>
          s + parseFloat(li.node.subtotalSet.presentmentMoney.amount), 0
        ), 0
      );
      const effective = o.cancelledAt ? 0 : Math.max(0, subtotal - refunded);
      cumSpend += effective;

      const totalShares = Math.floor(cumSpend / SHARE_UNIT);
      const orderShares = totalShares - cumShares;
      cumShares = totalShares;
      const remainder = cumSpend % SHARE_UNIT;

      return {
        id: `gid://shopify/Order/${o.id}`,
        metafields: [
          { namespace: 'custom', key: 'osszes_koltes',     type: 'number_decimal', value: cumSpend.toFixed(2) },
          { namespace: 'custom', key: 'order_share',       type: 'number_integer', value: orderShares.toString() },
          { namespace: 'custom', key: 'fennmarado_osszeg', type: 'number_decimal', value: remainder.toFixed(2) },
        ]
      };
    });

    // 3) Bulk‐mutáció egy kérésben
    const bulkMut = `
      mutation bulkOrderUpdate($inputs: [OrderInput!]!) {
        orderBulkUpdate(input: {orders: $inputs}) {
          userErrors { field message }
        }
      }
    `;
    const bulkResp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: bulkMut, variables: { inputs: updates } }),
    });
    const bulkJson = await bulkResp.json();
    if (bulkJson.data?.orderBulkUpdate.userErrors.length) {
      console.error('❌ bulkOrderUpdate errors:', bulkJson.data.orderBulkUpdate.userErrors);
    }
  }

  // 4) Végső customerUpdate
  const custMut = `
    mutation updateCustomer($input: CustomerInput!) {
      customerUpdate(input: $input) { userErrors { field message } }
    }
  `;
  const custVars = {
    input: {
      id: `gid://shopify/Customer/${customerId}`,
      metafields: [
        { namespace: 'loyalty', key: 'net_spent_total',  type: 'number_decimal', value: cumSpend.toFixed(2) },
        { namespace: 'loyalty', key: 'reszvenyek_szama', type: 'number_integer', value: cumShares.toString() },
        { namespace: 'custom',  key: 'jelenlegi_fennmarado', type: 'number_decimal', value: (cumSpend % SHARE_UNIT).toFixed(2) },
      ]
    }
  };
  const custResp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': process.env.SHOPIFY_API_ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: custMut, variables: custVars }),
  });
  const custJson = await custResp.json();
  if (custJson.data.customerUpdate.userErrors.length) {
    console.error('❌ customerUpdate errors:', custJson.data.customerUpdate.userErrors);
  }

  console.log(`🚀 recalcCustomer finished for customer ${customerId}`);
}

module.exports = { recalcCustomer };
