// Template data, made through the REAL admin API on the running desktop server: shops, blanks, a
// catalog, and a few dozen orders taken through what a working shop does to them (paid in part or
// in full, every fulfillment stage, completed, voided, refunded, test sales, invoices and PDFs).
// The cloner (clone.js) then copies these orders many thousands of times, so every row it writes
// is one the app itself wrote — the generated data can't drift from the schema or the app's rules.
const { pick, rng } = require("./names.js");

const SHOPS = [
  { orgId: "north", name: "North Stitch Co" },
  { orgId: "harbor", name: "Harbor Threads" },
  { orgId: "summit", name: "Summit Club Shop" },
];
// designApproved is left out: design approval is off in a new install (Global settings → Features).
const STAGES = ["blankOrdered", "blankReceived", "digitizingComplete", "manufactured", "qaPacked", "shipped", "delivered"];
const SIZES = ["S", "M", "L", "XL"];

// One shop's catalog: blank-linked tees and hoodies, plus caps and patches that need no blank.
async function makeCatalog(S, orgId, blankIds, nProducts) {
  const products = [];
  for (let i = 0; i < nProducts; i++) {
    const kind = i % 4;
    const productId = (kind === 0 ? "tee-" : kind === 1 ? "hood-" : kind === 2 ? "cap-" : "patch-") + i;
    const base = kind === 0 ? 22 : kind === 1 ? 44 : kind === 2 ? 26 : 9;
    const sized = kind < 2;
    await S.must({ action: "createProduct", org: orgId, productId, type: kind < 2 ? "shirt" : kind === 2 ? "cap" : "patch",
      name: ["Club", "Team", "Crew", "Event"][i % 4] + " " + ["Tee", "Hoodie", "Cap", "Patch"][kind] + " " + i,
      ...(sized ? { pricingMode: "sized", sizePricing: Object.fromEntries(SIZES.map((s, k) => [s, base + (k > 2 ? 2 : 0)])) }
                : { pricingMode: "flat", flatPrice: base, noBlankNeeded: true }),
      images: [], features: [], visible: true });
    if (sized) {
      const blankId = blankIds[kind];
      await S.must({ action: "saveBlankLinks", org: orgId, productId,
        set: SIZES.map(s => ({ productColor: "", productSize: s, blankId, blankColor: "White", blankSize: s })) });
    }
    products.push({ productId, sized });
  }
  return products;
}

async function makeBlanks(S) {
  const ids = [];
  for (const [name, productType, price] of [["Basic tee blank", "shirt", 3.1], ["Heavy hoodie blank", "shirt", 11.4]]) {
    const r = await S.must({ action: "createBlank", name, productType,
      colors: [{ color: "White", images: [], sizes: SIZES.map(size => ({ size, quantity: 0, vendorPrice: price })) }] });
    ids.push(r.id || r.blankId);
  }
  return ids;
}

// Grows a shop's catalog later (more products and graphics), so list calls that read whole catalog
// tables see a catalog in proportion to the order history.
async function growCatalog(S, orgId, blankIds, from, to) {
  for (let i = from; i < to; i++) {
    const productId = "extra-" + i;
    await S.must({ action: "createProduct", org: orgId, productId, type: "shirt", name: "Season Tee " + i,
      pricingMode: "sized", sizePricing: Object.fromEntries(SIZES.map(s => [s, 24])), images: [], features: [], visible: true });
    await S.must({ action: "saveBlankLinks", org: orgId, productId,
      set: SIZES.map(s => ({ productColor: "", productSize: s, blankId: blankIds[0], blankColor: "White", blankSize: s })) });
    if (i % 2 === 0) await S.must({ action: "saveGraphic", org: orgId, graphic: { name: "Crest " + i, kind: i % 4 ? "embroidery" : "transfer", visible: true } });
  }
}

// The template orders. `kind` says what was done to each, so the cloner can keep the mix.
async function makeTemplateOrders(S, shops, catalogs, { perShop = 14 } = {}) {
  const r = rng(7);
  const templates = [];
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const problems = [];
  const after = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString();
  // A step that may be refused (a stage the order can't take yet): noted, not fatal.
  const tryAction = async (body) => {
    const x = await S.orders(body);
    const ok = x.status === 200 && !(x.body && x.body.status === "error") && !(x.body && x.body.skipped && x.body.skipped.length);
    if (!ok) problems.push(body.action + (body.stage ? " " + body.stage : "") + ": " + ((x.body && (x.body.message || JSON.stringify(x.body.skipped))) || x.status));
    return ok;
  };
  for (const { orgId } of shops) {
    const cat = catalogs[orgId];
    for (let i = 0; i < perShop; i++) {
      const nLines = 1 + Math.floor(r() * 4);   // 1–4 lines, about 2.5 on average
      const items = [];
      for (let k = 0; k < nLines; k++) {
        const p = cat[Math.floor(r() * cat.length)];
        items.push({ productId: p.productId, size: p.sized ? SIZES[Math.floor(r() * 4)] : "", qty: 1 + Math.floor(r() * 6) });
      }
      // The mix: what a working shop's history looks like.
      const kind = ["complete", "complete", "complete", "complete", "shipped", "inProduction", "paidNew", "partPaid", "unpaid", "refunded", "voided", "complete", "complete", "complete"][i % 14];
      const ship = i % 3 === 0;
      const placedAt = ago(40 + i);
      const sale = await S.must({ action: "createLocalSale", org: orgId, items, customerName: pick(r, "name"), contact: pick(r, "email"),
        paymentMethod: "card", placedAt, paid: !["unpaid", "partPaid", "voided"].includes(kind),
        ...(ship ? { shippingAddress: { name: "Ship To", line1: "12 Sample Rd", city: "Springfield", state: "OH", zip: "45501", country: "US" }, shippingCost: 8.5, shippingMethod: "UPS Ground" } : {}) });
      const orderId = sale.orderId;
      if (kind === "partPaid") await S.must({ action: "addPayment", orderId, amount: 10, method: "cash", date: placedAt.slice(0, 10) });
      // Each stage a day after the last, as a shop works through an order.
      const stagesTo = { complete: 7, shipped: 6, refunded: 7, inProduction: 3, paidNew: 0, partPaid: 0, unpaid: 0, voided: 0 }[kind];
      let day = 1;
      for (const stage of STAGES.slice(0, stagesTo)) await tryAction({ action: "setFulfillmentStage", org: orgId, orderId, stage, at: after(placedAt, day++) });
      if (kind === "complete" || kind === "refunded") await tryAction({ action: "setOrderCompleted", orderIds: [orderId], completed: true, at: after(placedAt, day++) });
      if (kind === "refunded") await tryAction({ action: "recordRefund", orderId, amount: 5, method: "cash", date: after(placedAt, day++).slice(0, 10) });
      if (kind === "voided") await S.must({ action: "voidOrder", org: orgId, orderId, reason: "duplicate" });
      // An invoice and a PDF, as the owner opens them (invoices get their token row).
      if (i % 2 === 0) { await S.orders({ action: "getInvoiceDocument", org: orgId, orderId }); await S.orders({ action: "getOrderPdf", org: orgId, orderId }); }
      if (i % 5 === 0) await S.orders({ action: "updateCustomerInfo", org: orgId, orderIds: [orderId], contact: pick(r, "email") });
      templates.push({ orderId, orgId, kind });
    }
  }
  return { templates, problems };
}

async function orderTotal(S, orgId, orderId) {
  const r = await S.must({ action: "getOrders", org: orgId, dateFrom: "", dateTo: "" });
  const o = (r.orders || []).find(x => x.orderId === orderId);
  return o ? o.total : 0;
}

// Everything the cloner starts from: shops, catalogs and template orders. Returns what was made.
async function buildTemplates(S, { productsPerShop = 20 } = {}) {
  for (const s of SHOPS) await S.must({ action: "createOrg", orgId: s.orgId, subdomain: s.orgId, name: s.name, ready: true, deliveryOptions: [{ type: "pickup" }] });
  const blankIds = await makeBlanks(S);
  blankIds.push(blankIds[0], blankIds[1]);
  const catalogs = {};
  for (const s of SHOPS) catalogs[s.orgId] = await makeCatalog(S, s.orgId, blankIds, productsPerShop);
  const { templates, problems } = await makeTemplateOrders(S, SHOPS, catalogs);
  return { shops: SHOPS, blankIds, catalogs, templates, problems };
}

module.exports = { buildTemplates, growCatalog, SHOPS, SIZES };
