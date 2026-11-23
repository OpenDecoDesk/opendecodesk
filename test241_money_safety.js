const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Money safety follow-ups to the 2026-11-21 review (high and medium items left partly done):
//   #33 a Local sale is one order per Save: the same key twice (a double click, a retry, a second tab) finds the
//       first order and books its payment once
//   #52 one label purchase at a time per order: a claim taken before Shippo is paid
//   #15 a refund on a line taken off in Edit items goes into the payments ledger (not card), once
//   #7  one way to make a Stripe card page: the order on the PaymentIntent, an expiry, remembered, an older open
//       one closed first — for the storefront, the Edit items payment link and the shipping link
//   #9  bulk tracking is one statement; bulk cancel takes at most 20 lines a request and its count is right
//   and refusal times on the shop's clock (Region), not New York's.
// Real SQL (sql.js) + real db.js, permissions.js and orders.js. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { claimLabelPurchase, releaseLabelPurchase, createCheckoutSession, setTrackingNumbers, resolveTimeZone, shopTime_ };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@test';\n" +
  "const adminUser = () => null; const adminCan = () => true;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendShippingPaymentEmail = async () => true; const sendCancellationEmail = async () => true;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost };")();

let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };

// Stripe, as far as these paths ask it: sessions are made, read and expired. Every POST's form is kept.
const stripe = { made: [], sessions: new Map(), n: 0 };
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith("https://api.stripe.com/v1/checkout/sessions")) throw new Error("unexpected fetch " + u);
  const rest = u.slice("https://api.stripe.com/v1/checkout/sessions".length);
  if (!rest && init.method === "POST") {
    const form = new URLSearchParams(init.body);
    const id = "cs_test_" + (++stripe.n);
    const s = { id, url: "https://checkout.stripe.test/" + id, status: "open", amount_total: Number(form.get("line_items[0][price_data][unit_amount]")), success_url: form.get("success_url") };
    stripe.sessions.set(id, s); stripe.made.push(form);
    return { json: async () => ({ ...s }) };
  }
  const m = rest.match(/^\/([^/]+)(\/expire)?$/);
  const s = m && stripe.sessions.get(decodeURIComponent(m[1]));
  if (!s) return { json: async () => ({ error: { code: "resource_missing" } }) };
  if (m[2]) { if (s.status === "open") s.status = "expired"; }
  return { json: async () => ({ ...s }) };
};

async function migratedDb() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
}
function countQueries(d1) {
  const seen = [];
  const prepare = d1.prepare.bind(d1);
  d1.prepare = (sql) => { seen.push(sql); return prepare(sql); };
  return { count: (re) => seen.filter(s => re.test(s)).length, reset: () => { seen.length = 0; } };
}

(async () => {
  const d1 = await migratedDb();
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  const env = { DB: d1, STRIPE_SECRET_KEY: "sk_test_x", ROOT_DOMAIN: "example.com" };
  const call = async (body) => {
    const full = Object.assign({ key: "x" }, body);
    const request = { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    const res = await api.post({ env, waitUntil: () => {}, request });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const sale = (extra) => ({ action: "createLocalSale", org: "acme", paid: true, paymentMethod: "Cash", customerName: "Pat Example", contact: "pat@example.test",
    items: [{ productId: "__custom__", name: "Club scarf", type: "Accessory", customUnitPrice: 20, qty: 1 }, { productId: "__custom__", name: "Club hat", type: "Hat", customUnitPrice: 15, qty: 1 }], ...extra });
  const orders = () => d1.q("SELECT orderId FROM orders ORDER BY orderId").map(r => r.orderId);
  const payments = (id) => d1.q("SELECT amountCents, kind, method, requestKey FROM order_payments WHERE orderId = ? ORDER BY id", id);

  console.log("=== #33 Local sale: one order per Save ===");
  const first = await call(sale({ requestId: "a1b2c3d4e5f6a7b8c9d0" }));
  const again = await call(sale({ requestId: "a1b2c3d4e5f6a7b8c9d0" }));
  ok("the first request makes the order, paid in full", first.status === 200 && first.body.orderId && payments(first.body.orderId).length === 1 && payments(first.body.orderId)[0].amountCents === 3500);
  ok("the same key again answers with the same order, marked as a repeat, and books nothing more", again.body.orderId === first.body.orderId && again.body.repeated === true &&
    orders().length === 1 && payments(first.body.orderId).length === 1);
  const [x, y] = await Promise.all([call(sale({ requestId: "ffeeddccbbaa99887766" })), call(sale({ requestId: "ffeeddccbbaa99887766" }))]);
  ok("two requests with one key at the same moment: still one order and one payment", x.body.orderId === y.body.orderId && orders().length === 2 && payments(x.body.orderId).length === 1);
  ok("the payment carries the sale's key (one booking per key)", /^localSale:ffeeddccbbaa99887766$/.test(payments(x.body.orderId)[0].requestKey || ""));
  const keyless1 = await call(sale({})), keyless2 = await call(sale({}));
  ok("without a key (an older page) each request is its own sale, as before", keyless1.body.orderId !== keyless2.body.orderId && orders().length === 4);
  const page = read("public/admin.js");
  ok("the page sends one key per sale and allows one Local sale window per shop", /requestId, \.\.\.sale\}/.test(page) && /_localSaleOpen\.has\(orgId\)/.test(page));

  console.log("\n=== #52 one label purchase at a time ===");
  const t0 = Date.parse("2026-11-22T15:00:00Z");
  ok("the first purchase takes the claim", await lib.claimLabelPurchase(d1, "ORD-L1", t0));
  ok("a second one at the same moment is refused", !(await lib.claimLabelPurchase(d1, "ORD-L1", t0 + 500)));
  ok("…another order isn't affected", await lib.claimLabelPurchase(d1, "ORD-L2", t0 + 500));
  ok("a claim left by a purchase that never finished lapses after two minutes", await lib.claimLabelPurchase(d1, "ORD-L1", t0 + 121 * 1000));
  await lib.releaseLabelPurchase(d1, "ORD-L1");
  ok("released when the purchase ends, so the next one can go", await lib.claimLabelPurchase(d1, "ORD-L1", t0 + 122 * 1000));
  const label = read("functions/api/shippo-label.js");
  ok("the purchase takes the claim before Shippo is paid and releases it in a finally", label.indexOf("claimLabelPurchase(env.DB, orderId)") > 0 &&
    label.indexOf("claimLabelPurchase(env.DB, orderId)") < label.indexOf("https://api.goshippo.com/transactions/\", {") && /finally \{\s*await releaseLabelPurchase\(env\.DB, orderId\);/.test(label));

  console.log("\n=== #15 a refund on a line taken off in Edit items ===");
  const oid = first.body.orderId;
  const lines = d1.q("SELECT id, name FROM order_items WHERE orderId = ? ORDER BY id", oid);
  const scarf = lines.find(l => l.name === "Club scarf").id, hat = lines.find(l => l.name === "Club hat").id;
  const tooMuch = await call({ action: "editOrder", orderId: oid, removals: [{ itemId: scarf, refundAmount: 50, refundMethod: "cash" }] });
  ok("more than the order holds is refused before anything changes", tooMuch.status === 400 && /can't exceed/.test(tooMuch.body.message) &&
    d1.q("SELECT cancelDate FROM order_items WHERE id = ?", scarf)[0].cancelDate == null);
  const badMethod = await call({ action: "editOrder", orderId: oid, removals: [{ itemId: scarf, refundAmount: 5, refundMethod: "barter" }] });
  ok("an unknown refund method is refused", badMethod.status === 400 && /how the refund was paid/.test(badMethod.body.message));
  const edited = await call({ action: "editOrder", orderId: oid, removals: [{ itemId: scarf, reason: "Changed mind", refundAmount: 20, refundMethod: "cash" }] });
  const refunds = payments(oid).filter(p => p.kind === "refund");
  ok("the line comes off and its cash refund is in the payments ledger, keyed by the line", edited.status === 200 && refunds.length === 1 &&
    refunds[0].amountCents === -2000 && refunds[0].method === "cash" && refunds[0].requestKey === "lineRefund:" + scarf);
  ok("…and the line shows the refund too", d1.q("SELECT refundCents FROM order_items WHERE id = ?", scarf)[0].refundCents === 2000);
  const recorded = await call({ action: "setLineItemRefund", org: "acme", sheetRow: scarf, refundAmount: 20, method: "cash" });
  ok("recording the same line's refund again (its Record refund) doesn't book it twice", recorded.status === 200 && payments(oid).filter(p => p.kind === "refund").length === 1);
  await call({ action: "editOrder", orderId: oid, removals: [{ itemId: hat, refundAmount: 15, refundMethod: "card" }] });
  ok("a card refund only notes the line: Stripe's webhook books it", payments(oid).filter(p => p.kind === "refund").length === 1 &&
    d1.q("SELECT refundCents FROM order_items WHERE id = ?", hat)[0].refundCents === 1500);
  ok("the Edit items window sends how each refund was paid", /refundMethod: mayRefund_ \? row\._refundMethod/.test(page) && /data-field="_refundMethod"/.test(page));

  console.log("\n=== #7 one way to make a card page ===");
  const oid2 = keyless1.body.orderId;
  const made = await lib.createCheckoutSession(env, { orderId: oid2, orgId: "acme", amountCents: 3500, name: "Order — acme", customerEmail: "pat@example.test",
    successUrl: "https://acme.example.com/?ok", cancelUrl: "https://acme.example.com/", expiresInSec: 3600, sessionMetadata: { customerName: "Pat" } });
  const f1 = stripe.made[stripe.made.length - 1];
  ok("the page is made with the order on the session and on the PaymentIntent", made.url && f1.get("metadata[orderId]") === oid2 && f1.get("payment_intent_data[metadata][orderId]") === oid2 &&
    f1.get("payment_intent_data[metadata][orgId]") === "acme" && f1.get("metadata[customerName]") === "Pat" && !f1.has("payment_intent_data[metadata][customerName]"));
  ok("…with an expiry, and remembered for the order", Number(f1.get("expires_at")) > Date.now() / 1000 && d1.q("SELECT sessionId FROM checkout_sessions WHERE orderId = ?", oid2)[0].sessionId === made.sessionId);
  const same = await lib.createCheckoutSession(env, { orderId: oid2, orgId: "acme", amountCents: 3500, successUrl: "https://acme.example.com/?ok", cancelUrl: "x" });
  ok("the same amount and return page again: the open page is handed back", same.reused === true && same.url === made.url && stripe.made.length === 1);
  const changed = await lib.createCheckoutSession(env, { orderId: oid2, orgId: "acme", amountCents: 4000, successUrl: "https://acme.example.com/?ok", cancelUrl: "x" });
  ok("a different amount: the open page is closed first, then a new one made", !changed.reused && stripe.sessions.get(made.sessionId).status === "expired" &&
    d1.q("SELECT sessionId FROM checkout_sessions WHERE orderId = ?", oid2)[0].sessionId === changed.sessionId);
  stripe.sessions.get(changed.sessionId).status = "complete";
  const afterPaid = await lib.createCheckoutSession(env, { orderId: oid2, orgId: "acme", amountCents: 500, successUrl: "s", cancelUrl: "c" });
  ok("the storefront refuses while the last page has just been paid", afterPaid.error === "paid");
  const link = await lib.createCheckoutSession(env, { orderId: oid2, orgId: "acme", amountCents: 500, successUrl: "s", cancelUrl: "c", afterPaid: true, expiresInSec: 99 * 3600, metadata: { type: "shipping_payment" } });
  const f2 = stripe.made[stripe.made.length - 1];
  ok("an admin link for more money on a paid order is made, typed on both, and lasts at most 23 hours", link.url && f2.get("metadata[type]") === "shipping_payment" &&
    f2.get("payment_intent_data[metadata][type]") === "shipping_payment" && Number(f2.get("expires_at")) <= Math.floor(Date.now() / 1000) + 23 * 3600 + 5);
  // The emailed shipping link (createShippingPaymentLink), end to end through orders.js: the order on the
  // PaymentIntent, typed as shipping, an expiry, and remembered — so the next link or Pay by card closes it.
  const oid3 = keyless2.body.orderId;
  const before = stripe.made.length;
  const shipLink = await call({ action: "createShippingPaymentLink", orderId: oid3, shippingCost: 9.5 });
  const f3 = stripe.made[stripe.made.length - 1];
  ok("the shipping link goes through it: PaymentIntent metadata, typed, an expiry, remembered", shipLink.status === 200 && shipLink.body.url && stripe.made.length === before + 1 &&
    f3.get("payment_intent_data[metadata][orderId]") === oid3 && f3.get("payment_intent_data[metadata][type]") === "shipping_payment" && f3.get("line_items[0][price_data][unit_amount]") === "950" &&
    Number(f3.get("expires_at")) > Date.now() / 1000 + 20 * 3600 && d1.q("SELECT sessionId FROM checkout_sessions WHERE orderId = ?", oid3)[0].sessionId === shipLink.body.url.split("/").pop());
  const shipLink2 = await call({ action: "createShippingPaymentLink", orderId: oid3, shippingCost: 12 });
  ok("a newer link for a different amount closes the earlier one first", shipLink2.status === 200 && stripe.sessions.get(shipLink.body.url.split("/").pop()).status === "expired");
  const ordersSrc = read("functions/api/orders.js");
  const editBlock = ordersSrc.slice(ordersSrc.indexOf('body.action === "editOrder"'), ordersSrc.indexOf('body.action === "recordTracking"'));
  ok("Edit items' payment link goes through it too, typed as an order-edit payment", /createCheckoutSession\(env, \{[\s\S]*?metadata: \{ type: "order_edit_payment" \}/.test(editBlock) &&
    !/api\.stripe\.com\/v1\/checkout\/sessions/.test(editBlock));
  ok("the shipping link and the storefront call it too", /createCheckoutSession\(env, \{\s*orderId, orgId: order\.orgId/.test(read("functions/api/orders.js")) &&
    /await createCheckoutSession\(env, \{/.test(read("functions/api/checkout.js")) && !/api\.stripe\.com\/v1\/checkout\/sessions/.test(read("functions/api/checkout.js")));

  console.log("\n=== #9 bulk tracking and bulk cancel ===");
  const q = countQueries(d1);
  const tr = await lib.setTrackingNumbers(d1, [oid, oid2, oid3, oid3, "ORD-NOPE"], "1Z999");
  ok("tracking for a selection is one UPDATE", q.count(/^UPDATE orders SET trackingNumber/) === 1 && tr.updated === 3 && tr.skipped === 1 &&
    d1.q("SELECT count(*) n FROM orders WHERE trackingNumber = '1Z999'")[0].n === 3);
  const many = Array.from({ length: 21 }, (_, i) => i + 1);
  const tooMany = await call({ action: "bulkCancelLineItems", org: "acme", sheetRows: many });
  ok("bulk cancel takes at most 20 lines a request", tooMany.status === 400 && /at most 20/.test(tooMany.body.message));
  const hatLine = d1.q("SELECT id FROM order_items WHERE orderId = ? AND name = 'Club hat'", oid2)[0].id;
  const c1 = await call({ action: "bulkCancelLineItems", org: "acme", sheetRows: [hatLine] });
  const c2 = await call({ action: "bulkCancelLineItems", org: "acme", sheetRows: [hatLine] });
  ok("each line's result: cancelled, then 'alreadyCancelled' the second time", c1.body.results[0].alreadyCancelled === undefined && c2.body.results[0].alreadyCancelled === true);
  ok("the page counts with the server's spelling and sends groups of whole orders", /results\.filter\(x => !x\.alreadyCancelled\)/.test(page) && !/alreadyCanceled/.test(page) &&
    /postOrdersInGroups_\(\{action:"bulkCancelLineItems"/.test(page));

  console.log("\n=== Small fixes ===");
  await lib.resolveTimeZone({ DB: d1, TIMEZONE: "America/Los_Angeles" });
  ok("a refusal's time is on the shop's clock (Region / TIMEZONE), not New York's", lib.shopTime_("2026-11-05T03:15:00.000Z") === "Nov 4, 2026, 7:15 PM");
  ok("the Edit items window's buttons don't use data-action (the storefront's cart handler answers those)", !/data-action="/.test(page) && /data-edit-action="remove"/.test(page));
  ok("the verify page's token is in a data attribute, not inside a script string", /data-token="\$\{escapeHtml\(token\)\}" onclick="dvSubmitResponse\(this\.dataset\.token\)"/.test(read("public/index.html")));

  if (failed) console.log("\nFAILED:", failed);
})().catch(e => { console.log("crashed: false"); console.error(e); process.exit(1); });
