const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

// The total an order is answered with is the total it was stored with (2026-11). insertOrder stored the rush fee and,
// with sales tax added on top, the fee's tax — but answered without either. A shop that adds tax on top shows the
// answered total on the confirmation and asks for it by Venmo or Zelle (storefront.js), so a $25 cap with a $10
// taxable rush fee at 6% asked for $26.50 where the order owes $37.10. A repeated submit, answered from the saved
// order, said $37.10. Now both answers, the order row and getOrderById agree (test179 covers the rest of rush fees).
// Real migrations, db.js, permissions.js and orders.js on sql.js; the storefront's own lines read from its source.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, getOrderById, insertOrder };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1);`);
  const taxMode = (mode) => d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', '{"rateBps":600,"jurisdiction":"OH","taxMode":"${mode}"}');`);
  taxMode("exclusive");
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 25, visible: true, noDesignNeeded: true });
  const post = async (url, body) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
    request: { url, json: async () => body, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const admin = (body) => post(ADMIN_ORIGIN + "/api/orders", Object.assign({ key: "x" }, body));
  const place = (orderId, extra = {}) => post(shopOrigin("acme") + "/api/orders", Object.assign({ orgId: "acme", orderId, customerName: "Alex Sample", contact: "alex@example.test",
    paymentMethod: "Venmo", deliveryOptionId: "pickup", items: [{ productId: "cap", size: "OSFA", qty: 1 }] }, extra));
  const stored = (orderId) => d1.q("SELECT totalCents FROM orders WHERE orderId = ?", orderId)[0].totalCents;

  console.log("=== Tax added on top, a fixed taxable rush fee ===");
  let r = await admin({ action: "updateRushSettings", rush: { rule: { mode: "fixed", amount: 10 }, taxable: true } });
  ok("the rush rule is saved", r.status === 200);
  r = await place("T-1", { rush: true });
  ok("the order is taken", r.status === 200 && r.body.status === "ok" && r.body.taxMode === "exclusive");
  ok("its answer's total is cap + rush fee + both taxes ($37.10), not $26.50", r.body.total === 37.1);
  ok("…and its sales tax counts the fee's ($1.50 + $0.60)", r.body.salesTax === 2.1);
  const saved = await lib.getOrderById(d1, "T-1");
  ok("the order row, the saved order and the answer agree", stored("T-1") === 3710 && saved.total === 37.1 && saved.effectiveTotal === 37.1 && Math.abs(saved.salesTax - r.body.salesTax) < 0.001);
  const again = await place("T-1", { rush: true });
  ok("the same order submitted again is answered with the same total and tax", again.status === 200 && again.body.duplicate === true && again.body.total === r.body.total && again.body.salesTax === r.body.salesTax);
  ok("…and no second order is made", d1.q("SELECT COUNT(*) n FROM orders")[0].n === 1);

  console.log("\n=== The other cases are as they were ===");
  r = await place("T-2");
  ok("no rush: $25 + $1.50 tax", r.body.total === 26.5 && r.body.salesTax === 1.5 && stored("T-2") === 2650);
  await admin({ action: "updateRushSettings", rush: { rule: { mode: "fixed", amount: 10 }, taxable: false } });
  r = await place("T-3", { rush: true });
  ok("an untaxed rush fee: $25 + $10 + $1.50", r.body.total === 36.5 && r.body.salesTax === 1.5 && stored("T-3") === 3650);
  await admin({ action: "updateRushSettings", rush: { rule: { mode: "follow" }, taxable: true } });
  r = await place("T-4", { rush: true });
  ok("a rush fee to follow isn't in the total yet", r.body.total === 26.5 && stored("T-4") === 2650);

  console.log("\n=== insertOrder's own answer, either tax mode ===");
  const direct = async (orderId, mode, extra) => lib.insertOrder(d1, Object.assign({ orderId, orgId: "acme", customerName: "Alex Sample", contact: "alex@example.test",
    placedAt: "2026-11-02T15:00:00.000Z", taxMode: mode, shippingAddress: { state: "OH", zip: "45503" } }, extra),
    [{ productId: "cap", name: "Club Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 25 }]);
  let x = await direct("D-1", "exclusive", { rushRequested: true, rushFee: 10, rushFeeTaxable: true, shippingCost: 8 });
  ok("on top: items $25 + shipping $8 + fee $10 + tax $1.50 + $0.60 = $45.10, as stored", x.total === 45.1 && x.salesTax === 2.1 && stored("D-1") === 4510 && (await lib.getOrderById(d1, "D-1")).effectiveTotal === 45.1);
  taxMode("inclusive");
  x = await direct("D-2", "inclusive", { rushRequested: true, rushFee: 10.6, rushFeeTaxable: true });
  const d2 = await lib.getOrderById(d1, "D-2");
  ok("in the prices: $25 + $10.60 = $35.60, as stored, with the tax inside both ($1.42 + $0.60)", x.total === 35.6 && stored("D-2") === 3560 && d2.effectiveTotal === 35.6 && x.salesTax === 2.02 && Math.abs(d2.salesTax - 2.02) < 0.001);
  x = await direct("D-3", "inclusive", {});
  ok("no rush: unchanged ($25, $1.42 inside)", x.total === 25 && x.salesTax === 1.42 && stored("D-3") === 2500);

  console.log("\n=== The shop page uses the answered total ===");
  const sf = read("public/storefront.js");
  ok("the confirmation, the Venmo link and the Zelle line take the order's recorded total", /if\(saved && typeof saved\.total === "number"\)\{ order\.total = saved\.total; order\.salesTax = saved\.salesTax; \}/.test(sf));

  if (failed) { console.error(failed + " check(s) failed"); process.exit(1); }
})().catch((e) => { console.error("Error:", e); process.exit(1); });
