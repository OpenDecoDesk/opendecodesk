const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

// Rush fees (migrations/0082): a global rule (off / fixed / % of the items / the greater of the two / to follow, with an
// optional estimate) that each shop follows, turns off or replaces; the customer asks for rush (and may give a
// "needed by" date, which becomes the due date) and the server prices it; the admin sets or changes it per order; an
// unpaid rush fee never holds up production (paidForWork) but completing still needs it paid; its tax follows the
// "Rush fee is taxable" setting; the reports, receipts and the roll-up show it. Real migrations, db.js, orders.js,
// email.js on sql.js.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, getOrderById, getOrderCheckoutState, addOrderPayment, refreshPaidStatus, settleOrderBalance,
  cleanRushRule, rushFeeFor, resolveRushRule, rushRuleView, getRushSettings, setRushSettings, getOrgById, getPublicCatalogData, stagePrereqError,
  getPaidUnrunOrders, getSalesTaxReturn, getSalesTaxReport, getRevenueData, getRushFeesToSet, setOrderRushFee, setOrdersCompleted, orderAmounts };`)();
const received = [];
const api = new Function("__received", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme', northside: 'northside' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async (env, o) => { __received.push(o); return false; }, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")(received);
const email = new Function(dbSrc + "\nconst send_ = async (env, m) => { (globalThis.__mails = globalThis.__mails || []).push(m); return true; };\n" +
  strip(read("functions/_lib/email.js")).replace(/async function send_\(/, "async function send_unused_(") + "\nreturn { sendOrderReceivedEmail, sendDailyDigestEmail, sendDigestHeartbeatEmail };")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();

(async () => {
  console.log("=== The migration ===");
  {
    const old = await createD1();
    old._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of migrations.filter(f => f < "0082")) old.execFile(read("migrations/" + f));
    old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);
      INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, paid) VALUES ('O-PAID','acme','Alex Sample','a@x.com','2026-10-01T12:00:00Z',1), ('O-OPEN','acme','Alex Sample','a@x.com','2026-10-01T12:00:00Z',0);`);
    old.execFile(read("migrations/0082_rush_fee.sql"));
    const rows = old.q("SELECT orderId, paidForWork, rushRequested, rushFeeCents FROM orders ORDER BY orderId");
    ok("existing orders: paidForWork copied from paid, no rush", rows[0].orderId === "O-OPEN" && rows[0].paidForWork === 0 && rows[1].paidForWork === 1 && rows.every(r => r.rushRequested === 0 && r.rushFeeCents === 0));
    ok("…and shops follow the global rule ('')", old.q("SELECT rushFeeJson FROM orgs")[0].rushFeeJson === "");
  }

  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1), ('northside','northside','Northside','t','t',1);`);
  // A fresh install taxes nothing until a rate and home state are set (Global settings → Sales tax).
  d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', '{"rateBps":600,"jurisdiction":"OH","taxMode":"inclusive"}');`);
  for (const org of ["acme", "northside"]) {
    await lib.createProduct(d1, org, { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 25, visible: true, noDesignNeeded: true });
    await lib.createProduct(d1, org, { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { M: 20 }, visible: true, taxable: false, noDesignNeeded: true });
  }
  const post = async (url, body) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
    request: { url, json: async () => body, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const admin = (body) => post(ADMIN_ORIGIN + "/api/orders", Object.assign({ key: "x" }, body));
  const shop = (org, body) => post(shopOrigin(org) + "/api/orders", Object.assign({ orgId: org, customerName: "Alex Sample", contact: "alex@example.com", paymentMethod: "Venmo", deliveryOptionId: "pickup" }, body));
  let seq = 0;
  const order = async (org, items, extra = {}) => { const orderId = "R-" + (++seq); const r = await shop(org, Object.assign({ orderId, items }, extra)); return { r, orderId }; };
  const caps = (n) => [{ productId: "cap", size: "OSFA", qty: n }];

  console.log("\n=== The rule ===");
  const R = (x) => lib.cleanRushRule(x);
  ok("fixed: the amount", lib.rushFeeFor(R({ mode: "fixed", amount: 20 }), 10000).cents === 2000);
  ok("percent: a % of the items, to the cent", lib.rushFeeFor(R({ mode: "percent", pct: 25 }), 4999).cents === 1250);
  ok("greater: the amount on a small order, the % on a big one", lib.rushFeeFor(R({ mode: "greater", amount: 15, pct: 20 }), 5000).cents === 1500 && lib.rushFeeFor(R({ mode: "greater", amount: 15, pct: 20 }), 20000).cents === 4000);
  ok("follow: no fee yet, pending", (f => f.cents === 0 && f.pending)(lib.rushFeeFor(R({ mode: "follow", estLow: 15, estHigh: 40 }), 9999)));
  const refused = (x) => { try { R(x); return false; } catch (e) { return !!e.userFacing; } };
  ok("refused: no amount, a % of 0 or over 100, over $1,000, estimate low above high, an unknown mode",
    refused({ mode: "fixed" }) && refused({ mode: "percent", pct: 0 }) && refused({ mode: "percent", pct: 101 }) && refused({ mode: "fixed", amount: 1001 }) &&
    refused({ mode: "follow", estLow: 50, estHigh: 10 }) && refused({ mode: "fast" }));
  ok("a label defaults to 'Rush my order' and is cut to 40", R({ mode: "fixed", amount: 1 }).label === "Rush my order" && R({ mode: "fixed", amount: 1, label: "x".repeat(60) }).label.length === 40);
  ok("rushRuleView gives dollars and percent back", JSON.stringify(lib.rushRuleView(R({ mode: "greater", amount: 15, pct: 20 }))) === JSON.stringify({ mode: "greater", amount: 15, pct: 20, estLow: null, estHigh: null, label: "Rush my order", note: "", payByDays: null }));
  ok("with nothing saved, rush is off", (await lib.getRushSettings(d1)).rule.mode === "off");

  console.log("\n=== Global settings and a shop's own ===");
  let r = await admin({ action: "updateRushSettings", rush: { rule: { mode: "fixed", amount: 20, note: "We'll put it first." }, taxable: false } });
  ok("the global rule saves, audited, and bumps the catalog", r.status === 200 && r.body.rush.rule.amount === 20 &&
    d1.q("SELECT count(*) n FROM audit_log WHERE action='settings.rush_fee_set'")[0].n === 1 && d1.q("SELECT value FROM global_settings WHERE key='catalogVersion'").length === 1);
  r = await admin({ action: "updateRushSettings", rush: { rule: { mode: "percent", pct: 0 } } });
  ok("a bad rule is refused with the reason", r.status === 400 && /percentage/.test(r.body.message));
  r = await admin({ action: "getRushSettings" });
  ok("getRushSettings reads it back", r.body.rush.rule.mode === "fixed" && r.body.rush.rule.amount === 20 && r.body.rush.taxable === false);
  const orgUpdate = async (orgId, extra) => admin(Object.assign({ action: "updateOrg", orgId, subdomain: orgId, name: orgId === "acme" ? "Acme" : "Northside", ready: true, deliveryOptions: [{ type: "pickup" }] }, extra));
  r = await orgUpdate("northside", { rushFee: { use: "own", rule: { mode: "follow", estLow: 15, estHigh: 40 } } });
  ok("a shop gets its own rule", r.status === 200 && (await lib.getOrgById(d1, "northside")).rushFee.mode === "follow");
  r = await orgUpdate("northside", {});
  ok("…which a save that doesn't send it (the wizard's) leaves alone", (await lib.getOrgById(d1, "northside")).rushFee.mode === "follow");
  r = await orgUpdate("northside", { rushFee: { use: "own", rule: { mode: "fixed" } } });
  ok("…a bad own rule is refused", r.status === 400 && /amount/.test(r.body.message));
  const settings = await lib.getRushSettings(d1);
  ok("resolve: a shop following the global rule gets it; one with its own gets that", lib.resolveRushRule(await lib.getOrgById(d1, "acme"), settings).mode === "fixed" &&
    lib.resolveRushRule(await lib.getOrgById(d1, "northside"), settings).mode === "follow");
  ok("…a shop that turned it off gets none; nor does a snapshot from before the column", lib.resolveRushRule({ rushFee: { offer: false } }, settings) === null &&
    lib.resolveRushRule({}, settings).mode === "fixed");
  const cat = await lib.getPublicCatalogData(d1);
  ok("the catalog carries the global rule for /api/catalog", cat.globalSettings.rushFee.rule.mode === "fixed" && cat.orgs.northside.rushFee.mode === "follow");
  const catSrc = read("functions/api/catalog.js");
  ok("/api/catalog sends each shop its resolved rule (dollars) and whether it's taxed (for the cart's tax-on-top estimate)", /rush: org\.rushOffer \|\| null/.test(catSrc) &&
    cat.orgs.acme.rushOffer.amount === 20 && typeof cat.orgs.acme.rushOffer.taxable === "boolean" && cat.orgs.northside.rushOffer.mode === "follow");

  console.log("\n=== Ordering with rush ===");
  let o = await order("acme", caps(2), { rush: true, rushFee: 0.01, total: 1 });
  let ord = await lib.getOrderById(d1, o.orderId);
  ok("the fee is the shop's rule ($20), not the browser's", o.r.status === 200 && ord.rushRequested && ord.rushFee === 20 && !ord.rushFeePending && ord.effectiveTotal === 70);
  ok("…the stored total includes it", d1.q(`SELECT totalCents FROM orders WHERE orderId='${o.orderId}'`)[0].totalCents === 7000);
  ok("…the order-received email is given the rush fee", received.some(x => x.orderId === o.orderId && x.rushRequested && x.rushFee === 20));
  o = await order("acme", caps(1));
  ok("no rush asked → no fee", !(await lib.getOrderById(d1, o.orderId)).rushRequested && (await lib.getOrderById(d1, o.orderId)).effectiveTotal === 25);
  await orgUpdate("acme", { rushFee: { use: "off" } });
  o = await order("acme", caps(1), { rush: true });
  ok("a shop that doesn't offer rush refuses it — nothing saved", o.r.status === 400 && /doesn't offer rush/.test(o.r.body.message) && !(await lib.getOrderById(d1, o.orderId)));
  await orgUpdate("acme", { rushFee: { use: "default" } });
  ok("'Uses the global setting' puts the shop back on it", (await lib.getOrgById(d1, "acme")).rushFee === null);
  const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  o = await order("northside", caps(1), { rush: true, neededBy: soon });
  ord = await lib.getOrderById(d1, o.orderId);
  const pendingId = o.orderId;
  ok("to follow: rush on, no fee yet, pending; the needed-by date is the due date", ord.rushRequested && ord.rushFeePending && ord.rushFee === 0 && ord.effectiveTotal === 25 && ord.dueDate === soon);
  o = await order("northside", caps(1), { rush: true, neededBy: "2020-01-01" });
  ok("a needed-by date in the past is refused", o.r.status === 400 && /needed by/.test(o.r.body.message));
  o = await order("northside", caps(1), { neededBy: soon });
  ok("…a needed-by date sets the due date even without rush", (await lib.getOrderById(d1, o.orderId)).dueDate === soon);

  console.log("\n=== An unpaid rush fee doesn't hold up production ===");
  ok("card checkout isn't held for a rush fee to follow — it charges the rest", (s => s.total === 25 && s.rushFeePending && !s.shippingPending)(await lib.getOrderCheckoutState(d1, pendingId)));
  await lib.addOrderPayment(d1, pendingId, 25, "Venmo", "", { method: "venmo" });
  ord = await lib.getOrderById(d1, pendingId);
  ok("the rest paid → paid and paid for the work", ord.paid && ord.paidForWork && ord.balanceDue === 0);
  r = await admin({ action: "setRushFee", org: "northside", orderId: pendingId, requested: true, pending: false, amount: 32.5 });
  ord = await lib.getOrderById(d1, pendingId);
  ok("setting the fee: owed again, but still paid for the work", r.status === 200 && ord.rushFee === 32.5 && !ord.rushFeePending && !ord.paid && ord.paidForWork && ord.balanceDue === 32.5);
  ok("…audited first, from → to", (a => a && JSON.parse(a.detail).to.fee === 32.5 && JSON.parse(a.detail).from.pending === true)(d1.q(`SELECT detail FROM audit_log WHERE action='order.rush_fee_set' AND orderId='${pendingId}'`)[0]));
  ok("…it stays on the run pages (Paid, not yet run) and the production stages are open", (await lib.getPaidUnrunOrders(d1)).some(x => x.orderId === pendingId) &&
    !lib.stagePrereqError(ord, "digitizingComplete") && !lib.stagePrereqError(ord, "blankOrdered"));
  // The one-statement paid flag (a payment's batch) agrees with refreshPaidStatus.
  await lib.addOrderPayment(d1, pendingId, 10, "part", "", { method: "venmo" });
  const viaBatch = d1.q(`SELECT paid, paidForWork FROM orders WHERE orderId='${pendingId}'`)[0];
  await lib.refreshPaidStatus(d1, pendingId);
  const viaRefresh = d1.q(`SELECT paid, paidForWork FROM orders WHERE orderId='${pendingId}'`)[0];
  ok("the payment batch and refreshPaidStatus agree (part of the rush fee paid: still owed)", viaBatch.paid === 0 && viaBatch.paidForWork === 1 && JSON.stringify(viaBatch) === JSON.stringify(viaRefresh));
  d1._raw.exec(`UPDATE orders SET deliveredAt='${new Date().toISOString()}' WHERE orderId='${pendingId}'`);
  const comp = await lib.setOrdersCompleted(d1, [pendingId], true);
  ok("completing waits for the rush fee to be paid", !(await lib.getOrderById(d1, pendingId)).completedAt && JSON.stringify(comp).includes("balance"));
  await lib.settleOrderBalance(d1, pendingId, "Paid the rush fee");
  ok("…Mark as paid settles it", (await lib.getOrderById(d1, pendingId)).paid);
  // An order that hasn't paid for the work is still held.
  o = await order("acme", caps(1), { rush: true });
  ord = await lib.getOrderById(d1, o.orderId);
  ok("an unpaid order (items unpaid) stays off the run pages", !ord.paidForWork && !(await lib.getPaidUnrunOrders(d1)).some(x => x.orderId === o.orderId) && !!lib.stagePrereqError(ord, "digitizingComplete"));

  console.log("\n=== Changing it on an order ===");
  r = await admin({ action: "setRushFee", org: "acme", orderId: o.orderId, requested: true, pending: false, amount: "" });
  ok("a fee has to be given (or 'to follow')", r.status === 400);
  r = await admin({ action: "setRushFee", org: "acme", orderId: o.orderId, requested: false, dueDate: soon });
  ord = await lib.getOrderById(d1, o.orderId);
  ok("rush off: no fee, the due date set from the same window", r.status === 200 && !ord.rushRequested && ord.rushFee === 0 && ord.effectiveTotal === 25 && ord.dueDate === soon);
  o = await order("acme", caps(1));
  r = await admin({ action: "setRushFee", org: "acme", orderId: o.orderId, requested: true, pending: true });
  ok("rush added afterwards to any order, to follow", r.status === 200 && (x => x.rushRequested && x.rushFeePending)(await lib.getOrderById(d1, o.orderId)));
  ok("…and listed under 'Rush fees to set', soonest due first", (await lib.getRushFeesToSet(d1)).some(x => x.orderId === o.orderId));
  r = await admin({ action: "setRushFee", org: "northside", orderId: o.orderId, requested: true, pending: true });
  ok("another shop's order isn't found", r.status === 404);
  d1._raw.exec(`INSERT INTO closed_periods (month, closedAt) VALUES ('${new Date().toISOString().slice(0, 7)}', 't')`);
  r = await admin({ action: "setRushFee", org: "acme", orderId: o.orderId, requested: false });
  ok("a closed month refuses it", r.status === 409);
  d1._raw.exec(`DELETE FROM closed_periods`);
  const ordersSrc = read("functions/api/orders.js");
  ok("roles: setRushFee / getRushSettings are a manager's, updateRushSettings an admin's",
    /const MANAGER_ACTIONS = \[\s*"getRushSettings", "setRushFee"/.test(ordersSrc) && /"updateRushSettings",\s+\/\/ rush fees/.test(ordersSrc));

  console.log("\n=== Sales tax ===");
  await admin({ action: "updateRushSettings", rush: { rule: { mode: "fixed", amount: 10.6 }, taxable: true } });
  o = await order("acme", caps(1), { rush: true });
  ord = await lib.getOrderById(d1, o.orderId);
  const taxedId = o.orderId;
  ok("taxable: the tax is backed out of the fee like a line ($10.60 at 6% → $0.60)", ord.rushFeeTaxable && ord.rushFeeTax === 0.6 && Math.abs(ord.salesTax - (1.42 + 0.6)) < 0.001);
  o = await order("acme", [{ productId: "tee", size: "M", qty: 1 }], { rush: true, deliveryOptionId: "pickup" });
  ok("…a fee on an order of untaxed items is still taxed when the setting says so", (await lib.getOrderById(d1, o.orderId)).rushFeeTax === 0.6);
  d1._raw.exec(`UPDATE orgs SET taxExempt=1, taxExemptCertificate='C-1' WHERE orgId='northside'`);
  o = await order("northside", caps(1), { rush: true });
  r = await admin({ action: "setRushFee", org: "northside", orderId: o.orderId, requested: true, pending: false, amount: 10.6 });
  ok("…an exempt shop's order carries none", (await lib.getOrderById(d1, o.orderId)).rushFeeTax === 0);
  await admin({ action: "updateRushSettings", rush: { rule: { mode: "fixed", amount: 10.6 }, taxable: false } });
  ok("turning the setting off later doesn't rewrite an order placed under it", (await lib.getOrderById(d1, taxedId)).rushFeeTax === 0.6);
  o = await order("acme", caps(1), { rush: true });
  ok("…new orders aren't taxed on the fee", (await lib.getOrderById(d1, o.orderId)).rushFeeTax === 0);
  const from = "2020-01-01T00:00:00.000Z", to = "2099-01-01T00:00:00.000Z";
  const ret = await lib.getSalesTaxReturn(d1, from, to);
  const taxedRush = 1060, sumRush = d1.q(`SELECT SUM(rushFeeCents) s FROM orders`)[0].s;
  ok("the return counts rush fees (taxed ones in taxable sales and their tax in tax collected)", Math.round(ret.total.rushFees * 100) === sumRush &&
    Math.round(ret.total.taxCollected * 100) === d1.q(`SELECT SUM(i.taxCents) s FROM order_items i JOIN orders o ON o.orderId=i.orderId WHERE i.cancelDate IS NULL`)[0].s - d1.q(`SELECT SUM(discountTaxCents) s FROM orders`)[0].s + d1.q(`SELECT SUM(rushFeeTaxCents) s FROM orders`)[0].s);
  ok("…gross sales add up: every rush fee lands in exactly one bucket", (t => Math.round((t.taxableSales + t.exemptSales + t.interstateSales + t.nonTaxableSales) * 100) === Math.round(t.grossSales * 100))(ret.total));
  const rep = await lib.getSalesTaxReport(d1, from, to);
  ok("the by-state report has a Rush fees column (and its tax)", Math.round(rep.reduce((s, x) => s + x.rushFees, 0) * 100) === sumRush && rep.some(x => x.rushTax > 0) && taxedRush > 0);
  const rev = await lib.getRevenueData(d1, from, to);
  ok("the revenue report's total includes rush fees", rev.some(x => x.rushFee === 20 && x.effectiveTotal === 70));

  console.log("\n=== Tax added on top (taxMode exclusive) ===");
  d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', '{"rateBps":600,"jurisdiction":"OH","taxMode":"exclusive"}');`);
  await admin({ action: "updateRushSettings", rush: { rule: { mode: "fixed", amount: 10 }, taxable: true } });
  o = await order("acme", caps(1), { rush: true });
  ord = await lib.getOrderById(d1, o.orderId);
  const exId = o.orderId;
  ok("the fee's tax is added on top of it ($10 → $0.60), and the total is items + fee + both taxes ($37.10)",
    ord.taxMode === "exclusive" && ord.rushFeeTax === 0.6 && Math.abs(ord.salesTax - 2.1) < 0.001 && ord.effectiveTotal === 37.1 &&
    d1.q(`SELECT totalCents FROM orders WHERE orderId='${exId}'`)[0].totalCents === 3710);
  await lib.addOrderPayment(d1, exId, 26.5, "items and their tax", "", { method: "venmo" });
  let exRow = d1.q(`SELECT paid, paidForWork FROM orders WHERE orderId='${exId}'`)[0];
  ok("paying the items and their tax ($26.50) is paid for the work, not paid in full", exRow.paidForWork === 1 && exRow.paid === 0);
  await lib.refreshPaidStatus(d1, exId);
  ok("…the payment batch and refreshPaidStatus agree", (r2 => r2.paidForWork === 1 && r2.paid === 0)(d1.q(`SELECT paid, paidForWork FROM orders WHERE orderId='${exId}'`)[0]));
  r = await admin({ action: "setRushFee", org: "acme", orderId: exId, requested: true, pending: false, amount: 20 });
  ord = await lib.getOrderById(d1, exId);
  ok("changing the fee on the order re-taxes it on top ($20 → $1.20; total $47.70, $21.20 still owed)",
    r.status === 200 && ord.rushFeeTax === 1.2 && ord.effectiveTotal === 47.7 && ord.balanceDue === 21.2 &&
    d1.q(`SELECT totalCents FROM orders WHERE orderId='${exId}'`)[0].totalCents === 4770);
  await lib.addOrderPayment(d1, exId, 21.2, "rush fee", "", { method: "venmo" });
  ok("…paying the rest makes it paid", d1.q(`SELECT paid FROM orders WHERE orderId='${exId}'`)[0].paid === 1);
  ok("orderAmounts: with tax on top the fee's tax is owed on top and left out of what the work needs",
    (a => a.owedCents === 3710 && a.workOwedCents === 2650 && a.rushNetCents === 1000 && a.taxAddedCents === 210)(
      lib.orderAmounts({ itemsCents: 2500, itemsTaxCents: 150, shippingCents: 0, discountCents: 0, discountTaxCents: 0, taxMode: "exclusive", rushCents: 1000, rushTaxCents: 60 })));
  d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', '{"rateBps":600,"jurisdiction":"OH","taxMode":"inclusive"}');`);

  console.log("\n=== Emails ===");
  globalThis.__mails = [];
  await email.sendOrderReceivedEmail({}, await lib.getOrderById(d1, taxedId));
  await email.sendOrderReceivedEmail({}, { orderId: "X-1", customerName: "Alex Sample", contact: "a@x.com", items: [{ name: "Cap", qty: 1, lineTotal: 25 }], subtotal: 25, shippingCost: 0, rushRequested: true, rushFee: 0, rushFeePending: true });
  ok("receipts show the rush fee (before tax, its tax in the tax line), or that it's to follow (and the total still shows)", /Rush fee: \$10\.00\nSales tax \(6%\): \$2\.02\nTotal: \$35\.60/.test(globalThis.__mails[0].text) &&
    /Rush fee: to follow/.test(globalThis.__mails[1].text) && /Total: \$25\.00/.test(globalThis.__mails[1].text));
  const toSet = [{ orderId: "R-9", orgId: "acme", customerName: "Alex Sample", dueDate: soon }];
  globalThis.__mails = [];
  await email.sendDailyDigestEmail({}, { orders: [Object.assign({}, await lib.getOrderById(d1, pendingId), { total: 57.5 })], rushToSet: toSet });
  ok("the roll-up marks a rush order and lists the fees still to set", /⚡ RUSH/.test(globalThis.__mails[0].html) && /Rush fees to set — 1/.test(globalThis.__mails[0].html) && /RUSH FEES TO SET/.test(globalThis.__mails[0].text));
  await email.sendDigestHeartbeatEmail({}, { rushToSet: toSet });
  ok("…and the quiet-morning email mentions them", /1 rush fee still to set/.test(globalThis.__mails[1].text));
  globalThis.__mails = [];
  ok("rush fees to set alone don't send a roll-up", (await email.sendDailyDigestEmail({}, { rushToSet: toSet })) === false);

  console.log("\n=== The shop page works the fee out as the server does ===");
  const html = read("public/index.html");
  const quoteSrc = html.slice(html.indexOf("function rushQuote_("), html.indexOf("function rushSectionHtml_("));
  const rushQuote_ = new Function(quoteSrc + "\nreturn rushQuote_;")();
  const view = (x) => lib.rushRuleView(R(x));
  const same = [[{ mode: "fixed", amount: 20 }, 37.5], [{ mode: "percent", pct: 25 }, 49.99], [{ mode: "greater", amount: 15, pct: 20 }, 50], [{ mode: "greater", amount: 15, pct: 20 }, 200]]
    .every(([rule, sub]) => Math.round(rushQuote_({ rush: view(rule) }, sub).fee * 100) === lib.rushFeeFor(R(rule), Math.round(sub * 100)).cents);
  ok("fixed / % / greater: the page's fee equals the server's", same);
  ok("to follow: the estimate is shown and no fee is added", (q => q.pending && q.fee === 0 && /usually \$15–\$40/.test(q.text))(rushQuote_({ rush: view({ mode: "follow", estLow: 15, estHigh: 40 }) }, 30)));
  ok("no rule → no rush box", rushQuote_({ rush: null }, 30) === null);
  ok("placeOrder sends rush + neededBy; the fee itself isn't trusted", /rush: true, rushFee: rush\.fee/.test(html) && /neededBy: rushNeededBy/.test(html));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
