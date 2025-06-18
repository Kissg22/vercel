// lib/recalculate-partial.js
require('dotenv').config();
const { fetch } = require('undici');

const SET_METAFIELDS_MUTATION = `
mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    userErrors { field message }
  }
}
`;

async function recalculateCustomerPartial(customerId, changedOrderId) {
  console.log(`[PartialRecalc] customer=${customerId}, fromOrder=${changedOrderId}`);
  const shop = process.env.SHOPIFY_SHOP_NAME;
  const token = process.env.SHOPIFY_API_ACCESS_TOKEN;
  const shareUnit = 12700;

  // 1) Lekérjük a módosított rendelés created_at-ját
  const changedResp = await fetch(
    `https://${shop}.myshopify.com/admin/api/2023-10/orders/${changedOrderId}.json?fields=created_at,status,subtotal_price,total_refunded,cancelled_at`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  const { order: changedOrder } = await changedResp.json();
  const since = encodeURIComponent(changedOrder.created_at);

  // 2) Lekérjük a kumulatív előzményeket (ha van előző rendelés)
  let prevCum = 0, prevShares = 0;
  const prevResp = await fetch(
    `https://${shop}.myshopify.com/admin/api/2023-10/orders.json?customer_id=${customerId}&status=any&limit=1&order=created_at%20desc&created_at_max=${since}&fields=id,metafields`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  const prevOrders = (await prevResp.json()).orders;
  if (prevOrders.length) {
    const mf = prevOrders[0].metafields || [];
    const o = mf.find(m=>m.key==='osszes_koltes')?.value;
    const s = mf.find(m=>m.key==='reszvenyek_szama')?.value;
    prevCum    = parseFloat(o)||0;
    prevShares = parseInt(s,10)||Math.floor(prevCum/shareUnit);
  }

  // 3) Oldalazva lekérjük a 'since'-től kezdődő rendeléseket (friss→régi)
  let page = 1, all = [];
  while (true) {
    const resp = await fetch(
      `https://${shop}.myshopify.com/admin/api/2023-10/orders.json`
      + `?customer_id=${customerId}`
      + `&status=any`
      + `&limit=250`
      + `&order=created_at asc`
      + `&created_at_min=${since}`
      + `&page=${page}`
      + `&fields=id,created_at,subtotal_price,total_refunded,cancelled_at`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const orders = (await resp.json()).orders;
    if (!orders.length) break;
    all.push(...orders);
    if (orders.length < 250) break;
    page++;
  }

  // 4) Számoljuk végig csak ezeket, gyűjtsük a metafield-frissítéseket
  let cum = prevCum;
  const metafields = [];
  for (const o of all) {
    const subtotal = parseFloat(o.subtotal_price)||0;
    const refunded = parseFloat(o.total_refunded)||0;
    const effective = o.cancelled_at ? 0 : Math.max(0, subtotal - refunded);
    const beforeShares = Math.floor(cum/shareUnit);
    cum += effective;
    const afterShares = Math.floor(cum/shareUnit);
    const orderShares = afterShares - beforeShares;
    const remainder   = cum % shareUnit;

    metafields.push(
      { ownerId: `gid://shopify/Order/${o.id}`, namespace:'custom', key:'osszes_koltes',      type:'number_decimal', value: cum.toFixed(2) },
      { ownerId: `gid://shopify/Order/${o.id}`, namespace:'custom', key:'order_share',       type:'number_integer', value: orderShares.toString() },
      { ownerId: `gid://shopify/Order/${o.id}`, namespace:'custom', key:'fennmarado_osszeg', type:'number_decimal', value: remainder.toFixed(2) }
    );
  }

  // 5) Metafield-ek küldése GraphQL-lel
  if (metafields.length) {
    await fetch(
      `https://${shop}.myshopify.com/admin/api/2023-10/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type':'application/json',
          'X-Shopify-Access-Token': token
        },
        body: JSON.stringify({
          query: SET_METAFIELDS_MUTATION,
          variables: { metafields }
        })
      }
    );
  }
  console.log(`[PartialRecalc] kész – ${metafields.length} rekord frissítve.`);
}

module.exports = { recalculateCustomerPartial };
