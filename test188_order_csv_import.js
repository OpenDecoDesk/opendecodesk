const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// Orders → Import orders (migrations/0087): another store's orders from its own export, one order per store order.
//   * the three formats are told apart by their columns: an Etsy "Order Items" CSV, a Shopify orders export, a plain
//     sheet with an `order` column;
//   * a line is matched to a product by SKU (sizes in the store's words: "Large" → L); anything else is a custom line;
//     Etsy's personalization becomes the line's name to stitch;
//   * the preview writes nothing; importing the same file again skips the orders already in; cancelled, refunded and
//     closed-month orders aren't imported;
//   * paid and shipped orders come in paid (a ledger payment on the store's date) and shipped; no sales tax is added;
//   * a download bought on Etsy is never granted or emailed here, not even after Mark paid.
// Real db.js / orders.js / digital.js on sql.js; the browser's grouping run from public/admin.js.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const emailSrc = strip(read("functions/_lib/email.js")).replace(/async function send_\(/, "async function send_unused_(") +
  "\nasync function send_(env, m) { (globalThis.__mails = globalThis.__mails || []).push(m); return true; }\n";
const digitalSrc = strip(read("functions/_lib/digital.js"));
const lib = new Function(hostSrc + "\n" + httpSrc + "\n" + dbSrc + "\n" + emailSrc + "\n" + digitalSrc +
  `\nreturn { createProduct, addProductFile, getOrderById, importOrdersCsv, orderImportFormat, deliverOrderDownloads, getPaidUnrunOrders };`)();
const api = new Function(hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {}, features: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + emailSrc + "\n" + digitalSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

// The browser's side: csvToObjects_ / parseCsv_ and the grouping the import window does before it sends anything.
const adminSrc = read("public/admin.js");
const cut = (start, end) => { const i = adminSrc.indexOf(start); if (i < 0) throw new Error("not found: " + start); return adminSrc.slice(i, adminSrc.indexOf(end, i) + end.length); };
const ui = new Function("const escapeHtml = (s) => String(s);\n" + cut("function parseCsv_(", "\n}\n") + cut("function csvToObjects_(text){", "\n}\n") +
  cut("const ORDER_IMPORT_KEY_ = ", ";\n") + cut("function orderImportFormat_(headers){", "\n}\n") + cut("function groupOrderRows_(parsed){", "\n}\n") +
  "return { csvToObjects_, groupOrderRows_, orderImportFormat_ };")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// An Etsy "Order Items" file: two orders, the first with two items (one personalized), the second a download.
const ETSY = `Sale Date,Item Name,Buyer,Quantity,Price,Coupon Code,Coupon Details,Discount Amount,Shipping Discount,Order Shipping,Order Sales Tax,Item Total,Currency,Transaction ID,Listing ID,Date Paid,Date Shipped,Ship Name,Ship Address1,Ship Address2,Ship City,Ship State,Ship Zipcode,Ship Country,Order ID,Variations,Order Type,Listings Type,Payment Type,InPerson Discount,InPerson Location,VAT Paid by Buyer,SKU
11/02/26,Custom Embroidered Club Tee,sam123,2,22.00,,,2.00,0,5.95,3.10,44.00,USD,111,901,11/02/26,11/04/26,Sam Rivera,12 Oak St,,Austin,TX,78701,United States,3141592653,"Size:Large,Personalization:Sam, #7",online,listing,online_cc,,,0,CLUB-TEE
11/02/26,Embroidered Patch,sam123,1,8.50,,,2.00,0,5.95,3.10,8.50,USD,112,902,11/02/26,11/04/26,Sam Rivera,12 Oak St,,Austin,TX,78701,United States,3141592653,,online,listing,online_cc,,,0,
11/03/26,Rose Embroidery Design (DST),lee9,1,6.00,,,0,0,0,0.40,6.00,USD,113,903,11/03/26,11/03/26,Lee Park,,,,,,United States,3141592700,,online,listing,online_cc,,,0,ROSE
`;
// A Shopify orders export: order-level values on each order's first row only.
const SHOPIFY = `Name,Email,Financial Status,Paid at,Fulfillment Status,Fulfilled at,Currency,Subtotal,Shipping,Taxes,Total,Discount Code,Discount Amount,Shipping Method,Created at,Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku,Shipping Name,Shipping Address1,Shipping Address2,Shipping City,Shipping Zip,Shipping Province,Shipping Country,Shipping Phone,Cancelled at
#1001,ana@cust.test,paid,2026-11-05 09:12:00 -0500,unfulfilled,,USD,47.00,6.00,0.00,53.00,,0.00,Standard,2026-11-05 09:10:00 -0500,1,Club Tee - Navy / XL,25.00,CLUB-TEE,Ana Cole,4 Elm Rd,,Denver,80202,CO,US,,
#1001,,,,,,,,,,,,,,,2,Club Cap,11.00,CAP,,,,,,,,,
#1002,bo@cust.test,pending,,unfulfilled,,USD,25.00,0.00,0.00,25.00,,0.00,,2026-11-06 14:00:00 -0500,1,Club Tee - Navy / M,25.00,CLUB-TEE,Bo Diaz,9 Pine Ave,,Denver,80202,CO,US,,
#1003,cy@cust.test,refunded,2026-11-06 10:00:00 -0500,unfulfilled,,USD,25.00,0.00,0.00,25.00,,0.00,,2026-11-06 09:00:00 -0500,1,Club Tee - Navy / M,25.00,CLUB-TEE,Cy Ng,1 Main St,,Denver,80202,CO,US,,
#1004,di@cust.test,paid,2026-11-06 10:00:00 -0500,unfulfilled,,USD,25.00,0.00,0.00,25.00,,0.00,,2026-11-06 09:00:00 -0500,1,Club Tee - Navy / M,25.00,CLUB-TEE,Di Fox,1 Main St,,Denver,80202,CO,US,,2026-11-07 10:00:00 -0500
`;
const PLAIN = `order,date,customer,email,sku,item,size,qty,price,personalization,shipping,paid,shipped
A-1,2026-11-08,Max Hill,max@cust.test,,Team Hoodie,M,3,40.00,,0,yes,
A-1,2026-11-08,Max Hill,max@cust.test,CLUB-TEE,,XXL,1,27.00,Max,0,yes,
A-2,2026-02-14,Old Order,old@cust.test,,Mug,,1,10,,0,yes,
`;

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme Tees','t','t',1);`);
  d1._raw.exec(`INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-02', 't', 'test');`);
  // Sales tax on, added on top, so a tax-exempt import is visible.
  await d1.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', ?)").bind(JSON.stringify({ rateBps: 825, jurisdiction: "TX", taxMode: "exclusive" })).run();
  const env = { DB: d1, SIGNING_SECRET: "a-test-signing-secret-of-good-length" };
  const admin = async (body) => {
    const res = await api({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => ({ key: "x", ...body }), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  await lib.createProduct(d1, "acme", { productId: "club-tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 25, M: 25, L: 25, XL: 25, "2XL": 27 }, visible: true });
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 11, visible: true, noBlankNeeded: true });
  await lib.createProduct(d1, "acme", { productId: "rose", type: "other", name: "Rose design", pricingMode: "flat", flatPrice: 6, visible: true, digital: true });
  await lib.addProductFile(d1, "acme", "rose", { fileKey: "digital/acme/rose/" + "a".repeat(32) + ".dst", fileName: "rose.dst", fileExt: "dst", bytes: 12 });
  const count = async (sql) => Number((await d1.prepare(sql).first()).n);

  console.log("=== The browser groups each order's rows ===");
  const etsy = ui.groupOrderRows_(ui.csvToObjects_(ETSY)), shopify = ui.groupOrderRows_(ui.csvToObjects_(SHOPIFY)), plain = ui.groupOrderRows_(ui.csvToObjects_(PLAIN));
  ok("formats told apart by their columns", etsy.format === "etsy" && shopify.format === "shopify" && plain.format === "csv" &&
    ui.orderImportFormat_(["sku", "name"]) === "" && lib.orderImportFormat(Object.keys(ui.csvToObjects_(ETSY).rows[0]).map(h => h.toLowerCase())) === "etsy");
  ok("one unit per order, its rows together, with the file's row of its first item", etsy.rows.length === 2 && etsy.rows[0].lines.length === 2 &&
    etsy.rows[0].order === "3141592653" && etsy.rows[1].row === 4 && shopify.rows.length === 4 && shopify.rows[0].lines.length === 2 && plain.rows.length === 2);
  ok("Shopify's continuation rows (no order number of their own) join the order above", shopify.rows[0].lines[1]["Lineitem name"] === "Club Cap");

  console.log("\n=== Preview: what would happen, nothing written ===");
  let pv = await lib.importOrdersCsv(d1, "acme", etsy.rows, { dryRun: true });
  ok("both Etsy orders would be created", pv.created === 2 && pv.results.every(r => r.action === "create" && !r.problems.length));
  ok("…and nothing was written", (await count("SELECT count(*) n FROM orders")) === 0);
  ok("matched by SKU, Etsy's 'Large' is the product's L, the personalization (with its comma) is what to stitch",
    pv.results[0].lines[0] === '2 × Club Tee L — "Sam, #7"' && /Embroidered Patch \(custom\)/.test(pv.results[0].lines[1]));
  ok("the store's sales tax is named, not added", pv.results[0].notes.some(n => /Sales tax \$3\.10 was charged by Etsy — not added here/.test(n)));
  ok("a total and an order number to show", pv.results[0].total === "$56.45" && pv.results[0].sku === "Etsy 3141592653" && pv.results[0].name === "Sam Rivera");

  console.log("\n=== Import the Etsy file ===");
  let r = await admin({ action: "importOrders", org: "acme", rows: etsy.rows });
  ok("2 orders created", r.status === 200 && r.body.created === 2 && r.body.results.every(x => x.orderId));
  const etsyId = r.body.results[0].orderId, roseId = r.body.results[1].orderId;
  let o = await lib.getOrderById(d1, etsyId);
  ok("it knows where it came from", o && /^ACME-ETSY-3141592653-[0-9A-F]{4}$/.test(etsyId) &&
    (await d1.prepare("SELECT source, externalOrderId FROM orders WHERE orderId=?").bind(etsyId).first()).externalOrderId === "3141592653");
  ok("customer, address and date are the store's", o.customerName === "Sam Rivera" && o.shippingAddress.city === "Austin" && o.shippingAddress.state === "TX" && o.placedAt.slice(0, 10) === "2026-11-02");
  ok("lines: the catalog tee in L, personalized, and a custom patch", o.items.length === 2 && o.items[0].productId === "club-tee" && o.items[0].size === "L" &&
    o.items[0].personalized && o.items[0].persName === "Sam, #7" && o.items[1].productId === "__custom__" && o.items[1].name === "Embroidered Patch");
  ok("no sales tax was added (tax-exempt), shipping and the discount are the store's", o.salesTax === 0 && o.taxExempt && o.shippingCost === 5.95 && o.discountAmount === 2);
  ok("paid in full, on the store's date", o.paid && o.payments.length === 1 && o.payments[0].amount === 56.45 && o.payments[0].receivedAt.slice(0, 10) === "2026-11-02");
  ok("shipped on the store's date, so it isn't in the run backlog", o.shippedAt && o.shippedAt.slice(0, 10) === "2026-11-04" && !(await lib.getPaidUnrunOrders(d1)).some(x => x.orderId === etsyId));

  console.log("\n=== A download bought on Etsy is never sent from here ===");
  globalThis.__mails = [];
  let rose = await lib.getOrderById(d1, roseId);
  ok("the download order came in paid, with no shipping stage", rose.paid && !rose.shippedAt && rose.items[0].productId === "rose");
  ok("no download grants and no email", (await count("SELECT count(*) n FROM download_grants")) === 0 && !globalThis.__mails.length);
  const d = await lib.deliverOrderDownloads(env, roseId, {});
  ok("…and delivering it (what Mark paid / Add payment / the download page call) does nothing", d.status === "none" &&
    (await count("SELECT count(*) n FROM download_grants")) === 0 && !globalThis.__mails.length);
  r = await admin({ action: "resendDownloads", org: "acme", orderId: roseId });
  ok("…not even Resend downloads", (await count("SELECT count(*) n FROM download_grants")) === 0 && !globalThis.__mails.length);

  console.log("\n=== The same file again ===");
  pv = await lib.importOrdersCsv(d1, "acme", etsy.rows, { dryRun: true });
  ok("both orders are already in: can't import, says which order", pv.created === 0 && pv.results.every(x => x.problems.some(p => /^Already imported \(order ACME-ETSY-/.test(p))));
  r = await admin({ action: "importOrders", org: "acme", rows: etsy.rows });
  ok("…and a real run adds nothing", r.body.created === 0 && (await count("SELECT count(*) n FROM orders")) === 2);
  r = await admin({ action: "importOrders", org: "acme", rows: [etsy.rows[0]], seen: ["3141592653"] });
  ok("an order already sent in an earlier batch is caught as a repeat", /more than once/.test(r.body.results[0].problems.join()));

  console.log("\n=== Shopify ===");
  r = await admin({ action: "importOrders", org: "acme", rows: shopify.rows });
  const byNo = Object.fromEntries(r.body.results.map(x => [x.orderNo, x]));
  ok("paid and pending orders imported; refunded and cancelled ones aren't", r.body.created === 2 &&
    /Refunded in Shopify/.test(byNo["#1003"].problems.join()) && /Cancelled in Shopify/.test(byNo["#1004"].problems.join()));
  o = await lib.getOrderById(d1, byNo["#1001"].orderId);
  ok("the variant's size and color are read (Navy / XL), and the cap on the second row joins the order", o.items.length === 2 &&
    o.items[0].productId === "club-tee" && o.items[0].size === "XL" && o.items[0].name === "Club Tee (Navy)" && o.items[1].productId === "cap" && o.items[1].qty === 2);
  ok("email, total, paid at Shopify's time; not shipped yet, so it's in the run backlog", o.contact === "ana@cust.test" && o.total === 53 && o.paid &&
    o.payments[0].receivedAt === "2026-11-05T14:12:00.000Z" && !o.shippedAt && (await lib.getPaidUnrunOrders(d1)).some(x => x.orderId === o.orderId));
  const bo = await lib.getOrderById(d1, byNo["#1002"].orderId);
  ok("a pending order comes in unpaid", bo && !bo.paid && !bo.payments.length && bo.total === 25);
  ok("a Shopify #1001 and an Etsy order are told apart by their store", /^ACME-SHOPIFY-1001-/.test(o.orderId));

  console.log("\n=== A plain sheet ===");
  r = await admin({ action: "importOrders", org: "acme", rows: plain.rows });
  const a1 = r.body.results.find(x => x.orderNo === "A-1"), a2 = r.body.results.find(x => x.orderNo === "A-2");
  ok("an order in a closed month isn't imported", /2026-02, a month that's closed/.test(a2.problems.join()) && a2.action === "skip");
  o = await lib.getOrderById(d1, a1.orderId);
  ok("a line with no SKU is custom, XXL is 2XL, the personalization is kept", o.items[0].productId === "__custom__" && o.items[0].name === "Team Hoodie" &&
    o.items[0].qty === 3 && o.items[1].productId === "club-tee" && o.items[1].size === "2XL" && o.items[1].persName === "Max" && o.paid && o.total === 147);

  console.log("\n=== Bad rows are reported, not written ===");
  const bad = ui.groupOrderRows_(ui.csvToObjects_(`order,date,item,qty,price\nB-1,someday,Thing,1,5\nB-2,2026-11-09,Thing,two,5\nB-3,2026-11-09,,1,5\n`));
  pv = await lib.importOrdersCsv(d1, "acme", bad.rows, { dryRun: true });
  ok("a bad date, a bad quantity and a line with no name each say so", /isn't a date/.test(pv.results[0].problems.join()) &&
    /quantity "two"/.test(pv.results[1].problems.join()) && /no item name/.test(pv.results[2].problems.join()) && pv.skipped === 3);
  r = await admin({ action: "importOrders", org: "nope", rows: plain.rows });
  ok("an unknown shop is refused", r.status === 404);
  r = await admin({ action: "importOrders", org: "acme", rows: [{ order: "x" }] });
  ok("rows that aren't orders are refused", r.status === 400);

  console.log(`\n${fail ? "SOME FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
