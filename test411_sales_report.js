process.env.TZ = "UTC";
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");

// Sales by customer, product, shop and decoration (phase 8). Real db.js / orders.js / permissions.js on sql.js.
//   db.js businessRange_ / businessMonth_: a report's days are the business's days (Region's zone, else UTC): from the
//   first moment of the first day to the last moment of the last, clock changes allowed for.
//   db.js getSalesReport: the orders sold in the range on the install's sale date (shipped or placed), not test, not
//   void, not nothing-but-gift-cards, optionally one shop; their live lines (not cancelled, not gift cards) with gross,
//   the order's discount shared by amount (codes and manual alike, tax taken out when prices include it), the line's own
//   refund and net; grouped by customer, product, shop or decoration; share of net; sorted by net then label; totals
//   with shipping, rush and tax below; its net plus refunds ties to the Revenue report's net sales (getRevenueData).
//   The getSalesReport action: reports.sales (Admin and Manager, nobody else), dates, grouping and shop checked.
// The business is in America/Chicago (clocks change on 2026-03-08) and every sale has a fixed time, so nothing depends
// on the machine's date or zone. Invented shops, people and products only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const apiSrc = strip(read("functions/api/orders.js"));
const L = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => { const r = request.headers.get('x-role') || 'admin'; return roleAllows(DEFAULT_ROLES[r] || null, need === 'staff' ? '*' : need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@example.test'; " + roles.adminAs({ roleFrom: "request.headers.get('x-role') || 'admin'" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {}, features: {} });\n" +
  dbSrc + "\n" + apiSrc +
  "\nreturn { post: onRequestPost, getSalesReport, SALES_REPORT_BY, businessRange_, businessMonth_, getRevenueData };")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const fresh = async ({ zone = "America/Chicago" } = {}) => {
  const d = await createD1();
  d._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) d.execFile(read("migrations/" + f));
  d._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('school','school','Example School District','t','t',1);`);
  if (zone) d._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('locale', '{"timeZone":"${zone}","country":"US"}')`);
  return d;
};
const q = (s) => s == null ? "NULL" : "'" + String(s).replace(/'/g, "''") + "'";
const n = (v) => v == null ? 0 : Number(v);
// One order with its lines, written straight to the tables so every date and figure is exactly what the test says.
//   items: [{ product, name, qty, cents, tax, cancelled, refund, config }]
const seed = (d1, o) => {
  const t = o.at || "2026-03-10T18:00:00.000Z";
  d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerId, customerName, contact, placedAt, shippedAt, deliveredAt, completedAt, voidedAt, isTest,
      shippingCostCents, shippingDiscountCents, discountCents, discountTaxCents, discountNote, rushFeeCents, rushFeeTaxCents, taxMode)
    VALUES (${q(o.id)}, ${q(o.org || "club")}, ${o.cust == null ? "NULL" : o.cust}, ${q(o.name != null ? o.name : "Pat Buyer")}, ${q(o.contact != null ? o.contact : "pat@example.com")},
      ${q(o.placedAt || t)}, ${q(o.shippedAt === undefined ? t : o.shippedAt)}, ${q(o.deliveredAt)}, ${q(o.completedAt)}, ${q(o.voided ? t : null)}, ${o.isTest ? 1 : 0},
      ${n(o.shipping)}, ${n(o.shipDisc)}, ${n(o.discount)}, ${n(o.discountTax)}, ${q(o.discountNote || "")}, ${n(o.rush)}, ${n(o.rushTax)}, ${q(o.taxMode || "exclusive")})`);
  for (const it of o.items || []) {
    d1._raw.exec(`INSERT INTO order_items (orderId, orgId, productId, name, type, qty, lineTotalCents, taxCents, cancelDate, refundCents, configJson)
      VALUES (${q(o.id)}, ${q(it.org || o.org || "club")}, ${q(it.product === undefined ? "tee" : it.product)}, ${q(it.name != null ? it.name : "Example line")}, 'shirt',
        ${it.qty == null ? 1 : it.qty}, ${it.cents}, ${n(it.tax)}, ${q(it.cancelled ? "2026-03-02" : null)}, ${it.refund == null ? "NULL" : it.refund}, ${q(JSON.stringify(it.config || {}))})`);
  }
};
const product = (d1, p) => d1._raw.exec(`INSERT INTO products (productId, orgId, type, name, createdAt, updatedAt, designId, noDesignNeeded, digital, fixedTransfersJson, decorationType)
  VALUES (${q(p.id)}, ${q(p.org || "club")}, 'shirt', ${q(p.name)}, 't', 't', ${q(p.designId)}, ${p.noDesign ? 1 : 0}, ${p.digital ? 1 : 0}, ${q(JSON.stringify(p.transfers || []))}, ${q(p.decoration || "")})`);
const callOn = (d1) => async (body, role = "admin") => {
  const res = await L.post({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
    request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
  return { status: res.status, body: JSON.parse(await res.text()) };
};
const MARCH = { dateFrom: "2026-03-01", dateTo: "2026-03-31" };
const rowOf = (r, key) => r.rows.find(x => x.key === key) || {};
const money = (x) => [x.orders, x.qty, x.grossCents, x.discountCents, x.refundCents, x.netCents];
const sumOf = (list, f) => list.reduce((s, x) => s + f(x), 0);
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });

(async () => {
  console.log("=== Business days and months ===");
  {
    const d1 = await fresh();
    let r = await L.businessRange_(d1, "2026-03-01", "2026-03-31");
    ok("March in Chicago starts at 6 am UTC on Mar 1 (before the clocks change)", r.fromIso === "2026-03-01T06:00:00.000Z");
    ok("…and ends at 4:59:59.999 am UTC on Apr 1 (after they change)", r.toIso === "2026-04-01T04:59:59.999Z");
    ok("…in the zone saved in Region", r.tz === "America/Chicago");
    r = await L.businessRange_(d1, "2026-11-01T10:00:00Z", "2026-11-01T22:00:00Z");
    ok("a time given with the day is cut to the day: Nov 1 runs 5 am to 5:59:59.999 am UTC the next day (the clocks go back that night)",
      r.fromIso === "2026-11-01T05:00:00.000Z" && r.toIso === "2026-11-02T05:59:59.999Z");
    r = await L.businessRange_(d1, "March", "");
    ok("a day that isn't a day falls back to the plain UTC bounds of what was given", r.fromIso === "MarchT00:00:00.000Z" && r.toIso === "T23:59:59.999Z");
    const utc = await fresh({ zone: null });
    r = await L.businessRange_(utc, "2026-03-01", "2026-03-31");
    ok("with no zone saved, the days are UTC days", r.tz === "UTC" && r.fromIso === "2026-03-01T00:00:00.000Z" && r.toIso === "2026-03-31T23:59:59.999Z");
    ok("businessMonth_: the last moment of March in Chicago is still March there", L.businessMonth_("2026-04-01T04:59:59.999Z", "America/Chicago") === "2026-03");
    ok("…the next moment is April", L.businessMonth_("2026-04-01T05:00:00.000Z", "America/Chicago") === "2026-04");
    ok("…in UTC the earlier moment is already April", L.businessMonth_("2026-04-01T04:59:59.999Z", "UTC") === "2026-04");
    ok("…and no time has no month", L.businessMonth_("", "America/Chicago") === "" && L.businessMonth_(null, "UTC") === "");
  }

  console.log("=== Which orders and lines count ===");
  {
    const d1 = await fresh();
    const one = (id, cents, extra) => seed(d1, Object.assign({ id, placedAt: "2026-02-20T18:00:00.000Z", items: [{ cents }] }, extra));
    one("E-BEFORE", 1, { shippedAt: "2026-03-01T05:59:59.999Z" });   // 11:59:59.999 pm Feb 28 in Chicago
    one("E-FIRST", 2, { shippedAt: "2026-03-01T06:00:00.000Z" });    // midnight Mar 1
    one("E-LAST", 4, { shippedAt: "2026-04-01T04:59:59.999Z" });     // 11:59:59.999 pm Mar 31
    one("E-AFTER", 8, { shippedAt: "2026-04-01T05:00:00.000Z" });    // midnight Apr 1
    one("E-UTC", 16, { shippedAt: "2026-03-01T03:00:00.000Z" });     // Mar 1 in UTC, still Feb 28 in Chicago
    one("DELIVERED", 32, { shippedAt: null, deliveredAt: "2026-03-10T18:00:00.000Z" });
    one("COMPLETED", 64, { shippedAt: null, completedAt: "2026-03-11T18:00:00.000Z" });
    one("UNSHIPPED", 128, { placedAt: "2026-03-01T06:00:00.000Z", shippedAt: null });
    one("SHIPS-LATER", 256, { placedAt: "2026-04-01T04:59:59.999Z", shippedAt: "2026-04-10T18:00:00.000Z" });
    seed(d1, { id: "TEST", isTest: true, items: [{ cents: 512 }] });
    seed(d1, { id: "VOID", voided: true, items: [{ cents: 1024 }] });
    seed(d1, { id: "GIFT-ONLY", shipping: 500, items: [{ product: "__giftcard__", name: "Gift card", cents: 2048 }] });
    seed(d1, { id: "MIXED", items: [{ cents: 4096 }, { product: "__giftcard__", name: "Gift card", cents: 5000, qty: 2 }] });
    seed(d1, { id: "CANCELLED", items: [{ cents: 8192 }, { cents: 3000, qty: 4, cancelled: true, refund: 3000 }] });
    seed(d1, { id: "SCHOOL", org: "school", at: "2026-03-06T18:00:00.000Z", items: [{ cents: 16384 }] });
    one("PLACED-FEB", 32768, { placedAt: "2026-03-01T05:59:59.999Z", shippedAt: "2026-03-02T18:00:00.000Z" });

    let r = await L.getSalesReport(d1, { ...MARCH, by: "shop" });
    ok("the install's sale date is used: shipped by default", r.basis === "shipped" && r.by === "shop" && r.dateFrom === "2026-03-01" && r.dateTo === "2026-03-31");
    ok("shipped basis: the first and last moments of March in Chicago count, the moments either side and a UTC-only March day don't; a delivery or completion with no shipment counts; test, void, gift-card-only and unshipped orders don't; a cancelled line and a gift card line add nothing",
      r.totals.netCents === 2 + 4 + 32 + 64 + 4096 + 8192 + 16384 + 32768);
    ok("…eight orders, one piece each (the gift card's two and the cancelled line's four left out)", r.totals.orders === 8 && r.totals.qty === 8);
    ok("…the gift-card-only order's shipping is not in the totals", r.totals.shippingCents === 0);
    ok("…a cancelled line's refund is no refund here", r.totals.refundCents === 0);
    ok("by shop: one row per shop, its name, its orgId and its key", same(r.rows.map(x => [x.key, x.label, x.orgId, x.orders]),
      [["s:club", "Example Club", "club", 7], ["s:school", "Example School District", "school", 1]]));
    ok("…each shop's net", rowOf(r, "s:club").netCents === 2 + 4 + 32 + 64 + 4096 + 8192 + 32768 && rowOf(r, "s:school").netCents === 16384);
    const rev = await L.getRevenueData(d1, (await L.businessRange_(d1, "2026-03-01", "2026-03-31")).fromIso, "2026-04-01T04:59:59.999Z");
    ok("the Revenue report, asked for the same business days, has the same orders", same(rev.map(x => x.orderId).sort(), ["CANCELLED", "COMPLETED", "DELIVERED", "E-FIRST", "E-LAST", "MIXED", "PLACED-FEB", "SCHOOL"]));
    r = await L.getSalesReport(d1, { ...MARCH, by: "shop", orgId: "school" });
    ok("narrowed to one shop: only that shop's orders", r.totals.orders === 1 && r.rows.length === 1 && r.rows[0].key === "s:school" && r.totals.netCents === 16384);

    d1._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('accounting', '{"saleDate":"placed"}')`);
    r = await L.getSalesReport(d1, { ...MARCH, by: "shop" });
    ok("placed basis: the report says so", r.basis === "placed");
    ok("…an order placed at the first moment of March counts though it hasn't shipped, and one placed at the last moment though it ships in April; those placed in February don't, whenever they shipped",
      r.totals.netCents === 128 + 256 + 4096 + 8192 + 16384 && r.totals.orders === 5);
  }

  console.log("=== The money of a line: discounts, refunds, shipping, rush and tax ===");
  let customerReport;
  {
    const d1 = await fresh();
    d1._raw.exec(`INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (1, 'Pat Example', '', 'pat@example.com', 't', 't'),
      (2, '', 'Example Club Boosters', 'boosters@example.com', 't', 't'), (3, '', '', 'lee@example.com', 't', 't')`);
    // Prices include tax; a SAVE10 code took $3.24 off, $0.24 of it tax; free-shipping code took $3 off $8 shipping; a
    // taxed rush fee; the second line was half refunded.
    seed(d1, { id: "M1", cust: 1, taxMode: "inclusive", discount: 324, discountTax: 24, discountNote: "Code SAVE10", shipping: 800, shipDisc: 300, rush: 1080, rushTax: 80,
      at: "2026-03-03T18:00:00.000Z", items: [{ qty: 2, cents: 2160, tax: 160 }, { cents: 1080, tax: 80, refund: 540 }] });
    // Tax on top; a manual $1 off three equal lines; the third refunded more than it cost.
    seed(d1, { id: "M2", cust: 1, taxMode: "exclusive", discount: 100, discountTax: 8, rush: 500, rushTax: 40,
      at: "2026-03-04T18:00:00.000Z", items: [{ cents: 1001, tax: 83 }, { cents: 1001, tax: 83 }, { cents: 1001, tax: 83, refund: 2000 }] });
    seed(d1, { id: "M3", taxMode: "inclusive", contact: "Pat@Example.com", name: "Pat Walkin", discount: 900, at: "2026-03-05T18:00:00.000Z", items: [{ cents: 500 }] });
    seed(d1, { id: "M4", contact: "pat@example.com", shipping: 250, at: "2026-03-06T18:00:00.000Z", items: [{ cents: 700 }] });
    seed(d1, { id: "M5", cust: 2, items: [{ cents: 300 }] });
    seed(d1, { id: "M6", cust: 3, items: [{ cents: 300 }] });
    d1._raw.exec("PRAGMA foreign_keys = OFF");   // a customer record since removed
    seed(d1, { id: "M7", cust: 99, name: "Gone Customer", items: [{ cents: 50 }] });
    seed(d1, { id: "M8", contact: "", name: "", items: [{ cents: 20 }] });
    seed(d1, { id: "M9", contact: "", name: "Walk-in Buyer", items: [{ cents: 10 }] });

    const r = customerReport = await L.getSalesReport(d1, MARCH);
    ok("by customer when nothing says otherwise", r.by === "customer");
    const pat = rowOf(r, "c:1");
    ok("a customer record: its name, its id, both its orders and every piece", pat.label === "Pat Example" && pat.customerId === 1 && pat.orders === 2 && pat.qty === 6);
    ok("prices including tax: gross is each line less the tax inside it ($20 + $10), and with tax on top, the lines as they are (3 × $10.01)", pat.grossCents === 3000 + 3003);
    ok("the discount: a code's $3.24 less its $0.24 tax, plus a manual $1.00 with tax on top", pat.discountCents === 300 + 100);
    ok("refunds: half the $10.80 line is $5.00 without tax; a refund bigger than the line takes only what's left after its discount ($10.01 − $0.33)", pat.refundCents === 500 + 968);
    ok("net is gross less discount less refunds", pat.netCents === 6003 - 400 - 1468 && pat.netCents === 4135);
    const walkin = rowOf(r, "e:pat@example.com");
    ok("no customer record: grouped by the order's contact whatever its capitals, labelled with the first one seen", walkin.label === "No customer record: Pat@Example.com" && walkin.orders === 2);
    ok("…a discount bigger than the goods takes them to nothing, never below", walkin.grossCents === 1200 && walkin.discountCents === 500 && walkin.netCents === 700);
    ok("a customer with no name goes by the company", rowOf(r, "c:2").label === "Example Club Boosters");
    ok("…with neither, by the email", rowOf(r, "c:3").label === "lee@example.com");
    ok("a customer id with no record left goes by the name typed on the order", rowOf(r, "c:99").label === "Gone Customer" && rowOf(r, "c:99").customerId === 99);
    ok("no customer and no contact: the name typed on the order", rowOf(r, "e:walk-in buyer").label === "No customer record: Walk-in Buyer");
    ok("no customer, no contact and no name: unknown", rowOf(r, "e:").label === "No customer record: unknown" && rowOf(r, "e:").netCents === 20);
    ok("rows run from the most net down, a tie in label order",
      same(r.rows.map(x => x.key), ["c:1", "e:pat@example.com", "c:2", "c:3", "c:99", "e:", "e:walk-in buyer"]));
    ok("share of net, to one decimal place", rowOf(r, "c:1").sharePct === 75 && walkin.sharePct === 12.7 && rowOf(r, "c:2").sharePct === 5.4 && rowOf(r, "e:walk-in buyer").sharePct === 0.2);
    ok("totals: every order and piece", r.totals.orders === 9 && r.totals.qty === 6 + 7);
    ok("…gross, discount, refunds and net", r.totals.grossCents === 7883 && r.totals.discountCents === 900 && r.totals.refundCents === 1468 && r.totals.netCents === 5515);
    ok("…the rows add up to the totals", ["qty", "grossCents", "discountCents", "refundCents", "netCents"].every(k => sumOf(r.rows, x => x[k]) === r.totals[k]));
    ok("…shipping charged, after a free-shipping code ($5.00 + $2.50)", r.totals.shippingCents === 750);
    ok("…the rush fees without their tax ($10.00 + $5.00)", r.totals.rushCents === 1500);
    ok("…sales tax: the goods' tax less the discount's share, plus the rush fees' tax", r.totals.taxCents === (240 - 24 + 80) + (249 - 8 + 40));
    const range = await L.businessRange_(d1, MARCH.dateFrom, MARCH.dateTo);
    const rev = await L.getRevenueData(d1, range.fromIso, range.toIso);
    ok("it ties to the Revenue report: net plus line refunds is its net sales", r.totals.netCents + r.totals.refundCents === sumOf(rev, x => x.netSalesCents));
    ok("…and its shipping and rush are the same", r.totals.shippingCents === sumOf(rev, x => x.shippingCents) && r.totals.rushCents === sumOf(rev, x => x.rushNetCents));
  }

  console.log("=== By product ===");
  {
    const d1 = await fresh();
    product(d1, { id: "tee", org: "club", name: "Classic Tee" });
    product(d1, { id: "tee", org: "school", name: "Classic Tee" });
    product(d1, { id: "cap", org: "club", name: "Club Cap" });
    seed(d1, { id: "P1", items: [{ product: "tee", qty: 2, cents: 1000 }, { product: "cap", cents: 300 }, { product: "__custom__", name: "Banner ", cents: 200 }] });
    seed(d1, { id: "P2", items: [{ product: "tee", qty: 3, cents: 1500 }, { product: "", name: "banner", cents: 150 }, { product: "gone", name: "Old Mug", cents: 100 }, { product: "", name: "", cents: 50 }] });
    seed(d1, { id: "P3", org: "school", items: [{ product: "tee", cents: 600 }] });
    const r = await L.getSalesReport(d1, { ...MARCH, by: "product" });
    ok("the same product name in two shops: each shop's name goes on its label", rowOf(r, "p:club\u0001tee").label === "Classic Tee (Example Club)" &&
      rowOf(r, "p:school\u0001tee").label === "Classic Tee (Example School District)");
    const tee = rowOf(r, "p:club\u0001tee");
    ok("a product row: its shop, product, shop name, both orders and all five pieces", tee.orgId === "club" && tee.productId === "tee" && tee.shop === "Example Club" && tee.orders === 2 && tee.qty === 5 && tee.netCents === 2500);
    ok("a name used once keeps it plain", rowOf(r, "p:club\u0001cap").label === "Club Cap");
    ok("custom lines and lines with no product are grouped by their name, whatever its capitals or spaces", rowOf(r, "n:banner").label === "Banner" && rowOf(r, "n:banner").netCents === 350 && rowOf(r, "n:banner").orders === 2);
    ok("a product that no longer exists goes by the line's name", rowOf(r, "n:old mug").label === "Old Mug" && !("productId" in rowOf(r, "n:old mug")));
    ok("a line with no name at all is a Custom line", rowOf(r, "n:").label === "Custom line");
    ok("rows by net", same(r.rows.map(x => x.netCents), [2500, 600, 350, 300, 100, 50]));
  }

  console.log("=== By decoration ===");
  const decorationSetUp = async () => {
    const d1 = await fresh();
    product(d1, { id: "emb", name: "Stitched Polo", decoration: "embroidery" });
    product(d1, { id: "scr", name: "Printed Tee", decoration: "screenprint" });
    product(d1, { id: "dig", name: "Download", digital: true, noDesign: true });
    product(d1, { id: "pd", name: "Logo Hoodie", noDesign: true });
    product(d1, { id: "tr", name: "Transfer Tote", noDesign: true, transfers: [{ graphicId: "g1" }] });
    d1._raw.exec(`PRAGMA foreign_keys = OFF; INSERT INTO product_designs (orgId, productId, designId, createdAt) VALUES ('club', 'pd', 'logo', 't')`);
    const twoTypes = { locations: [{ location: "Front", decoration: "embroidery" }, { location: "Back", decoration: "dtf" }] };
    seed(d1, { id: "D1", items: [{ product: "emb", cents: 1000 }, { product: "scr", cents: 400 }, { product: "dig", cents: 300 }, { product: "pd", cents: 100 }, { product: "tr", cents: 50 }] });
    // One line decorated two ways (its config beats its product's own type): $10.01 less a 3¢ discount and a $1.01 refund.
    seed(d1, { id: "D2", discount: 3, items: [{ product: "scr", qty: 3, cents: 1001, refund: 101, config: twoTypes }] });
    seed(d1, { id: "D3", items: [{ product: "__custom__", name: "Patch", cents: 200 }] });
    return d1;
  };
  {
    const d1 = await decorationSetUp();
    const r = await L.getSalesReport(d1, { ...MARCH, by: "decoration" });
    const emb = rowOf(r, "d:embroidery"), dtf = rowOf(r, "d:dtf");
    ok("a line with two types counts its pieces under each", emb.qty === 1 + 3 + 1 && dtf.qty === 3 + 1);
    ok("…and splits its money evenly, the spare cent to the first type: gross 501 / 500, discount 2 / 1, refund 51 / 50",
      emb.grossCents === 1000 + 501 + 100 && dtf.grossCents === 500 + 50 && emb.discountCents === 2 && dtf.discountCents === 1 && emb.refundCents === 51 && dtf.refundCents === 50);
    ok("…its net is each share's gross less its discount and refund", emb.netCents === 1000 + 448 + 100 && dtf.netCents === 449 + 50);
    ok("a product's own type, a design attached to the product and fixed transfers decide a line with no locations", rowOf(r, "d:screenprint").netCents === 400);
    ok("labels and the decoration key", emb.label === "Embroidery" && emb.decoration === "embroidery" && dtf.label === "DTF transfer" && rowOf(r, "d:screenprint").label === "Screen print");
    const none = rowOf(r, "d:none");
    ok("a download and a custom line: No decoration", none.label === "No decoration" && none.decoration === "" && none.netCents === 500 && none.orders === 2);
    ok("rows by net", same(r.rows.map(x => x.key), ["d:embroidery", "d:none", "d:dtf", "d:screenprint"]));
    ok("the totals count the two-type line once", r.totals.qty === 9 && sumOf(r.rows, x => x.qty) === 12);
    ok("…and its money once: the rows' net adds up to the total", r.totals.netCents === 2947 && sumOf(r.rows, x => x.netCents) === 2947 && sumOf(r.rows, x => x.grossCents) === r.totals.grossCents);
    ok("the share is of the total net", emb.sharePct === 52.5 && dtf.sharePct === 16.9);
  }
  {
    // A database without product_designs: a product's attached designs can't be seen, so one marked "no design needed"
    // with no transfers counts as a transfer product.
    const d1 = await decorationSetUp();
    d1._raw.exec("PRAGMA foreign_keys = OFF; DROP TABLE product_designs");
    const r = await L.getSalesReport(d1, { ...MARCH, by: "decoration" });
    ok("without the product designs table the report still answers, the hoodie now under DTF", rowOf(r, "d:embroidery").netCents === 1448 && rowOf(r, "d:dtf").netCents === 599);
  }
  {
    // A database without the customers table (before migrations/0108): orders go by the name typed on them.
    const d1 = await fresh();
    d1._raw.exec("PRAGMA foreign_keys = OFF");
    seed(d1, { id: "C1", cust: 1, name: "Pat Typed", items: [{ cents: 100 }] });
    d1._raw.exec("DROP TABLE customers");
    const r = await L.getSalesReport(d1, MARCH);
    ok("without the customers table: a customer id goes by the order's name", r.rows.length === 1 && r.rows[0].key === "c:1" && r.rows[0].label === "Pat Typed");
  }

  console.log("=== Answers that aren't a report ===");
  {
    const d1 = await fresh();
    ok("a start that isn't a day", same(await L.getSalesReport(d1, { dateFrom: "2026-3-1", dateTo: "2026-03-31" }), { error: "Choose the dates as YYYY-MM-DD." }));
    ok("an end that isn't a day", same(await L.getSalesReport(d1, { dateFrom: "2026-03-01" }), { error: "Choose the dates as YYYY-MM-DD." }));
    ok("nothing asked at all", same(await L.getSalesReport(d1), { error: "Choose the dates as YYYY-MM-DD." }));
    ok("the start after the end", same(await L.getSalesReport(d1, { dateFrom: "2026-04-01", dateTo: "2026-03-31" }), { error: "The start date is after the end date." }));
    let r = await L.getSalesReport(d1, { ...MARCH, by: "colour" });
    ok("a grouping it doesn't know: by customer", r.by === "customer");
    ok("no sales: no rows and totals of nothing", r.rows.length === 0 && same(r.totals, { orders: 0, qty: 0, grossCents: 0, discountCents: 0, refundCents: 0, netCents: 0, shippingCents: 0, rushCents: 0, taxCents: 0 }));
    ok("the grouping list", same(L.SALES_REPORT_BY, ["customer", "product", "shop", "decoration"]));
    seed(d1, { id: "FREE", discount: 500, items: [{ cents: 500 }] });
    r = await L.getSalesReport(d1, { ...MARCH, by: "shop" });
    ok("sales that come to nothing: a share of 0, not a division by nothing", r.rows.length === 1 && r.rows[0].netCents === 0 && r.rows[0].sharePct === 0);
  }

  console.log("=== The getSalesReport action ===");
  {
    const d1 = await fresh();
    seed(d1, { id: "A1", items: [{ cents: 1200 }] });
    seed(d1, { id: "A2", org: "school", items: [{ cents: 800 }] });
    const call = callOn(d1);
    let r = await call({ action: "getSalesReport", ...MARCH });
    ok("Admin gets the report, by customer unless asked otherwise, in cents, for every shop", r.status === 200 && r.body.status === "ok" && r.body.by === "customer" && r.body.totals.netCents === 2000 && r.body.orgId === null);
    r = await call({ action: "getSalesReport", ...MARCH, by: "" }, "manager");
    ok("Manager too; an empty grouping is by customer", r.status === 200 && r.body.by === "customer");
    for (const role of ["staff", "production", "nobody"]) {
      r = await call({ action: "getSalesReport", ...MARCH }, role);
      ok(`${role === "staff" ? "Back office" : role === "production" ? "Production" : "Nobody signed in"} is refused`, r.status === 403 && !r.body.rows);
    }
    r = await call({ action: "getSalesReport", ...MARCH, by: "shop", orgId: "school" });
    ok("one shop by orgId", r.status === 200 && r.body.orgId === "school" && r.body.rows.length === 1 && r.body.totals.netCents === 800);
    r = await call({ action: "getSalesReport", ...MARCH, by: "shop", org: "club" });
    ok("…or by org", r.status === 200 && r.body.orgId === "club" && r.body.totals.netCents === 1200);
    r = await call({ action: "getSalesReport", ...MARCH, orgId: "", org: "club" });
    ok("…an empty orgId gives way to org", r.status === 200 && r.body.orgId === "club");
    r = await call({ action: "getSalesReport", ...MARCH, orgId: "nowhere" });
    ok("a shop that doesn't exist", r.status === 404 && r.body.message === "Unknown shop");
    r = await call({ action: "getSalesReport", ...MARCH, orgId: 7 });
    ok("a shop that isn't a name", r.status === 400 && r.body.message === "That shop isn't valid.");
    r = await call({ action: "getSalesReport", ...MARCH, by: "colour" });
    ok("a grouping it doesn't offer is refused", r.status === 400 && r.body.message === "Group by customer, product, shop or decoration.");
    for (const by of ["product", "shop", "decoration"]) {
      r = await call({ action: "getSalesReport", ...MARCH, by });
      ok(`grouped by ${by}`, r.status === 200 && r.body.by === by && r.body.totals.netCents === 2000);
    }
    r = await call({ action: "getSalesReport", dateFrom: "2026-03-01", dateTo: "31/03/2026" });
    ok("a day that isn't YYYY-MM-DD", r.status === 400 && r.body.message === "Invalid date range — expected YYYY-MM-DD");
    r = await call({ action: "getSalesReport", dateTo: "2026-03-31" });
    ok("no start day", r.status === 400 && r.body.message === "Invalid date range — expected YYYY-MM-DD");
    r = await call({ action: "getSalesReport", dateFrom: "2026-04-01", dateTo: "2026-03-31" });
    ok("the start after the end", r.status === 400 && r.body.message === "The start date is after the end date.");
    r = await call({ action: "getSalesReport", dateFrom: "2024-01-01", dateTo: "2026-12-31" });
    ok("three years to the day is allowed", r.status === 200 && r.body.dateFrom === "2024-01-01" && r.body.dateTo === "2026-12-31");
    r = await call({ action: "getSalesReport", dateFrom: "2024-01-01", dateTo: "2027-01-01" });
    ok("a day more is refused", r.status === 400 && r.body.message === "Pick at most three years.");
    r = await call({ action: "getSalesReport", dateFrom: " 2026-03-01 ", dateTo: "2026-03-31" });
    ok("spaces around a day are trimmed", r.status === 200 && r.body.dateFrom === "2026-03-01");
  }
  {
    // Shares are rounded one by one, so they add up to about 100, not always exactly.
    ok("the customer report's shares add up to about 100", Math.abs(sumOf(customerReport.rows, x => x.sharePct) - 100) < 0.5);
  }

  finished = true;
})().catch((e) => { console.error(e); ok("the test ran without an error", false); finished = true; });
