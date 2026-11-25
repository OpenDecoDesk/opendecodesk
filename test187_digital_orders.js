const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

// Digital products on the shop and on Orders (2026-11, after #29):
//   * a digital product isn't shown in the shop until it has at least one file (catalog.js), nor while the feature is
//     off; checkout refuses one with no file still in a cart; its product lists the problem (getCatalogIssues).
//   * an order of only downloads has no stages: received → paid → completed. The server refuses every make / pack /
//     ship stage for it (stagePrereqError) and completes it once paid, with nothing delivered (whyNotCompletable_);
//     it isn't in the run backlog, and a download line isn't on Run Order.
//   * Orders: no stage list, Set shipping or Rush on a downloads-only order; Mark completed once it's paid; and
//     Resend downloads on any paid order with downloads (adminActionCell).
// Real db.js / orders.js / catalog.js on sql.js; the admin's order cell run from public/admin.js.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const emailSrc = strip(read("functions/_lib/email.js")).replace(/async function send_\(/, "async function send_unused_(") +
  "\nasync function send_(env, m) { m = fillTemplate_(m, { name: 'Acme Tees', owner: 'owner@acme.test', bcc: '' }); (globalThis.__mails = globalThis.__mails || []).push(m); return true; }\n";
const digitalSrc = strip(read("functions/_lib/digital.js"));
const lib = new Function(hostSrc + "\n" + httpSrc + "\n" + dbSrc + "\n" + emailSrc + "\n" + digitalSrc +
  `\nreturn { createProduct, addProductFile, getOrderById, stagePrereqError, whyNotCompletable_, getPaidUnrunOrders, getProductionQueue,
    getCatalogIssues, getPublicCatalogData };`)();
const api = new Function(hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test'; " + require("./testlib/roles").adminAs() + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async (env) => ({ subdomainMap: { acme: 'acme' }, orgs: {}, features: globalThis.__features || {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + emailSrc + "\n" + digitalSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const download = new Function(hostSrc + "\n" + httpSrc + "\n" + dbSrc + "\n" + emailSrc + "\n" + digitalSrc + "\nconst rateLimited = async () => ({ blocked: false });\n" +
  strip(read("functions/api/download.js")) + "\nreturn onRequestGet;")();
const catalog = new Function(hostSrc + "\n" + httpSrc + "\nconst getReadyToShipByOrg = async () => []; const getBlankReadyByOrg = async () => ({});\n" +
  "const getDraftCatalogShop = async () => null; const verifyPreviewToken = async () => false;\nlet getCatalogData;\n" +
  "const getCatalogShop = async (env, orgId) => (((await getCatalogData(env)) || {}).orgs || {})[orgId] || null;\n" + strip(read("functions/api/catalog.js")) + "\nreturn { get: onRequestGet, set: (f) => { getCatalogData = f; } };")();

// The admin's order cell, from public/admin.js, with what it calls stubbed.
const adminSrc = read("public/admin.js");
const cut = (start, end) => { const i = adminSrc.indexOf(start); if (i < 0) throw new Error("not found: " + start); return adminSrc.slice(i, adminSrc.indexOf(end, i) + end.length); };
const ui = new Function(
  "const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[c]);\n" +
  "const featureOn_ = () => true, adminCan_ = () => true, adminDesktopNoEmail_ = () => false, invoiceCell_ = () => '';\n" +
  cut("const FULFILLMENT_STAGES = [", "\n];\n") + cut("const FULFILLMENT_LATE_ = ", ";\n") + cut("const FULFILLMENT_FIELD = ", ";\n") +
  cut("function canCompleteOrder(o){", "\n}\n") + cut("function adminActionCell(org, o){", "\n}\n") +
  cut("const DASH_STATUSES_ = [", "\n];\n") + cut("function dashOrderStatus_(o){", "\n}\n") +
  "return { adminActionCell, canCompleteOrder, dashOrderStatus_ };")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, deliveryOptionsJson) VALUES ('acme','acme','Acme Tees','t','t',1,'[{"id":"pickup","type":"pickup","label":"Local pickup","fee":0}]');`);
  const env = { DB: d1, SIGNING_SECRET: "a-test-signing-secret-of-good-length" };
  const post = async (url, body) => { const res = await api({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
    request: { url, json: async () => body, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const admin = (body) => post(ADMIN_ORIGIN + "/api/orders", Object.assign({ key: "x" }, body));
  const shop = (body) => post(shopOrigin("acme") + "/api/orders", Object.assign({ orgId: "acme", customerName: "Pat Buyer", contact: "pat@cust.test", paymentMethod: "Venmo" }, body));
  let features = {};
  catalog.set(async () => ({ ...(await lib.getPublicCatalogData(d1)), subdomainMap: { acme: "acme" }, features }));
  const shopProducts = async () => {
    const res = await catalog.get({ request: { url: shopOrigin("acme") + "/api/catalog" }, env });
    const j = JSON.parse(await res.text());
    return { ids: (j.catalog && j.catalog.products || []).map(p => p.id).sort().join(), categories: (j.catalog && j.catalog.categories || []).map(c => c.key).join() };
  };

  await lib.createProduct(d1, "acme", { productId: "rose", type: "other", name: "Rose design", pricingMode: "flat", flatPrice: 12, visible: true, digital: true });
  await lib.createProduct(d1, "acme", { productId: "empty", type: "patch", name: "Pattern with no file", pricingMode: "flat", flatPrice: 8, visible: true, digital: true });
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 25, visible: true, noDesignNeeded: true, noBlankNeeded: true });
  await lib.addProductFile(d1, "acme", "rose", { fileKey: "digital/acme/rose/" + "a".repeat(32) + ".dst", fileName: "rose.dst", fileExt: "dst", bytes: 12 });

  console.log("=== The shop shows a digital product only with a file ===");
  let s = await shopProducts();
  ok("the digital product with a file and the cap are shown; the one with no file isn't", s.ids === "cap,rose");
  ok("…nor its section, which nothing else is in", !s.categories.split(",").includes("patch"));
  features = { digital: false };
  ok("with Digital products off, no digital product is shown", (await shopProducts()).ids === "cap");
  features = {};
  let r = await shop({ orderId: "E-1", items: [{ productId: "empty", qty: 1 }] });
  ok("checkout refuses one with no file still in a cart, by name", r.status === 400 && /Pattern with no file/.test(r.body.message) && /isn't available/.test(r.body.message));
  globalThis.__features = { digital: false };
  r = await shop({ orderId: "E-2", items: [{ productId: "rose", qty: 1 }, { productId: "cap", qty: 1 }], deliveryOptionId: "pickup" });
  ok("…and, with the feature off, any cart with a download in it (not only a downloads-only one)", r.status === 400 && /Downloads aren't available/.test(r.body.message));
  globalThis.__features = {};
  const issues = await lib.getCatalogIssues(d1, "acme");
  const codes = (id) => JSON.stringify(((issues.orgs.acme || {}).products || {})[id] || []);
  ok("the product with no file says why it isn't shown", /digitalNoFiles/.test(codes("empty")) && /isn't shown in the shop until one is added/.test(codes("empty")));
  ok("…and the one with a file doesn't", !/digitalNoFiles/.test(codes("rose")));
  await lib.addProductFile(d1, "acme", "empty", { fileKey: "digital/acme/empty/" + "b".repeat(32) + ".pdf", fileName: "pattern.pdf", fileExt: "pdf", bytes: 30 });
  ok("once a file is added it's shown at once", (await shopProducts()).ids === "cap,empty,rose");

  console.log("\n=== An order of only downloads: received → paid → completed ===");
  r = await shop({ orderId: "D-1", items: [{ productId: "rose", qty: 1 }] });
  ok("ordered", r.status === 200);
  let o = await lib.getOrderById(d1, "D-1");
  ok("the order knows it's downloads only", o.digitalOnly === true && o.hasDigital === true && o.items[0].digital === true);
  r = await admin({ action: "setOrderCompleted", org: "acme", orderIds: ["D-1"], completed: true });
  ok("unpaid, it can't be completed", r.status === 200 && r.body.updated === 0 && /balance is still due/.test(JSON.stringify(r.body.skipped)));
  r = await admin({ action: "markPaidManual", org: "acme", orderId: "D-1" });
  ok("marked paid", r.status === 200 && (await lib.getOrderById(d1, "D-1")).paid);
  o = await lib.getOrderById(d1, "D-1");
  const stages = ["blankOrdered", "blankShipped", "blankReceived", "digitizingComplete", "designApproved", "manufactured", "qaPacked", "shipped", "delivered"];
  ok("no stage applies to it", stages.every(st => /nothing to make or ship/.test(lib.stagePrereqError(o, st))));
  r = await admin({ action: "setFulfillmentStage", org: "acme", orderId: "D-1", stage: "manufactured" });
  ok("…and the server refuses one", r.status >= 400 && /nothing to make or ship/.test(r.body.message));
  ok("it isn't in the run backlog", !(await lib.getPaidUnrunOrders(d1)).some(x => x.orderId === "D-1"));
  ok("paid, nothing delivered: it can be completed", lib.whyNotCompletable_({ ...o, activeItems: 1 }) === "");
  r = await admin({ action: "setOrderCompleted", org: "acme", orderIds: ["D-1"], completed: true });
  ok("…and is", r.status === 200 && r.body.updated === 1 && !!(await lib.getOrderById(d1, "D-1")).completedAt);

  console.log("\n=== A mixed order keeps its stages ===");
  d1._raw.run("PRAGMA foreign_keys = OFF"); d1._raw.run("UPDATE products SET designId = 1 WHERE productId = 'cap'"); d1._raw.run("PRAGMA foreign_keys = ON");   // the cap's stitch file is linked
  r = await shop({ orderId: "M-1", items: [{ productId: "rose", qty: 1 }, { productId: "cap", qty: 1 }], deliveryOptionId: "pickup" });
  await admin({ action: "markPaidManual", org: "acme", orderId: "M-1" });
  o = await lib.getOrderById(d1, "M-1");
  ok("downloads, but not only downloads", r.status === 200 && o.digitalOnly === false && o.hasDigital === true);
  ok("the download doesn't make it need digitizing (the cap has its design)", o.needsDigitizing === false);
  ok("its stages still apply", lib.stagePrereqError(o, "manufactured") === "" && /isn.t manufactured yet/.test(lib.stagePrereqError(o, "qaPacked")));
  r = await admin({ action: "setOrderCompleted", org: "acme", orderIds: ["M-1"], completed: true });
  ok("it can't be completed before it's delivered", r.body.updated === 0 && /not delivered yet/.test(JSON.stringify(r.body.skipped)));
  const backlog = (await lib.getPaidUnrunOrders(d1)).find(x => x.orderId === "M-1");
  ok("in the run backlog with the cap only", !!backlog && backlog.items.map(i => i.name).join() === "Club Cap");
  ok("Run Order has no line for the download", !(await lib.getProductionQueue(d1)).some(j => j.orderId === "M-1" && /Rose/.test(j.itemName || "")));

  console.log("\n=== The order's buttons ===");
  const org = { orgId: "acme" };
  const base = { orderId: "X-1", items: [{ name: "Rose design" }], paid: true, paidForWork: true, balanceDue: 0, contact: "pat@cust.test" };
  let cell = ui.adminActionCell(org, { ...base, digitalOnly: true, hasDigital: true, hasDownloads: true });
  ok("downloads only, paid: no stage list, just Mark completed", /Downloads only/.test(cell) && !/<select/.test(cell) && /Mark completed/.test(cell));
  ok("…Resend downloads", /data-admin-action="resendDownloadsNow_"/.test(cell) && />Resend downloads</.test(cell));
  ok("…and no Set shipping or Rush", !/Set shipping|Edit shipping/.test(cell) && !/Rush/.test(cell));
  cell = ui.adminActionCell(org, { ...base, paid: false, paidForWork: false, balanceDue: 12, digitalOnly: true, hasDigital: true });
  ok("downloads only, unpaid: Mark as paid, no Resend downloads yet, no Rush", /Mark as paid/.test(cell) && !/>Resend downloads</.test(cell) && !/Rush/.test(cell));
  cell = ui.adminActionCell(org, { ...base, digitalOnly: false, hasDigital: true, needsBlanks: false, needsDigitizing: false, needsDesignApproval: false });
  ok("a mixed order, paid: its stages, Set shipping and Rush, plus Resend downloads", /<select/.test(cell) && /Set shipping/.test(cell) && /Rush/.test(cell) && />Resend downloads</.test(cell) && !/Mark completed/.test(cell));
  cell = ui.adminActionCell(org, { ...base, needsBlanks: false, needsDigitizing: false, needsDesignApproval: false });
  ok("an order with no downloads has no Resend downloads", !/Resend downloads/.test(cell) && !/Downloads…/.test(cell));
  ok("Mark completed: delivered and paid, or downloads only and paid", ui.canCompleteOrder({ ...base, digitalOnly: true }) && !ui.canCompleteOrder({ ...base }) &&
    ui.canCompleteOrder({ ...base, deliveredAt: "2026-11-15" }) && !ui.canCompleteOrder({ ...base, digitalOnly: true, paid: false }));
  ok("Resend downloads emails a new link (resendDownloads), after asking", /async function resendDownloadsNow_\(orgId, orderId\)\{\n  if \(!\(await askConfirm_\(/.test(adminSrc) && /hoopApi_\(\{ action: "resendDownloads", orderId, org: orgId \}\)/.test(adminSrc));
  ok("the home page's open orders: a paid downloads-only order is ready to complete", ui.dashOrderStatus_({ digitalOnly: true, paid: true }) === "digitalPaid" &&
    ui.dashOrderStatus_({ digitalOnly: true, paid: false }) === "unpaid" && ui.dashOrderStatus_({ paid: true, manufacturedAt: "x" }) === "manufacturedAt");
  ok("the product form says it isn't shown without a file", /No files yet: it isn't shown in the shop until it has at least one\./.test(adminSrc));

  console.log("\n=== The customer's download page ===");
  // A fresh order of the rose with two downloads per file.
  d1._raw.run(`UPDATE products SET digitalDeliveryJson = '{"downloads":2}' WHERE productId = 'rose'`);
  const R2 = new Map([["digital/acme/rose/" + "a".repeat(32) + ".dst", Buffer.from("DST-STITCHES")]]);
  env.DESIGNS = { async get(k) { const b = R2.get(k); return b ? { size: b.length, body: b, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) } : null; } };
  await shop({ orderId: "P-1", items: [{ productId: "rose", qty: 1 }] });
  await admin({ action: "markPaidManual", org: "acme", orderId: "P-1" });
  const dlSrc = strip(read("functions/_lib/digital.js"));
  const link = await new Function(hostSrc + "\n" + httpSrc + "\n" + dbSrc + "\n" + emailSrc + "\n" + dlSrc + "\nreturn downloadLink;")()(env, "P-1", "acme");
  const get = async (url) => { const res = await download({ env, request: { url, method: "GET", headers: { get: () => null } } }); return { status: res.status, headers: res.headers, text: await res.text() }; };
  let pg = await get(link);
  const fileHref = shopOrigin("acme") + (pg.text.match(/href="([^"]+&amp;f=\d+)"/) || [])[1].replace(/&amp;/g, "&");
  const nonce = (pg.text.match(/<script nonce="([0-9a-f]{32})">/) || [])[1];
  ok("the page: 2 of 2 left, and a Download button with no download attribute", /2 of 2 downloads left/.test(pg.text) && !!fileHref && !/ download>/.test(pg.text));
  ok("…and its one script, allowed by a fresh nonce and nothing else", !!nonce && pg.headers.get("Content-Security-Policy").includes(`script-src 'nonce-${nonce}'`) &&
    /default-src 'none'/.test(pg.headers.get("Content-Security-Policy")) && (pg.text.match(/<script/g) || []).length === 1 && nonce !== ((await get(link)).text.match(/nonce="([0-9a-f]{32})"/) || [])[1]);
  await get(fileHref);
  pg = await get(link);
  ok("after a download the page shows what's left", /1 of 2 downloads left/.test(pg.text));
  await get(fileHref);
  pg = await get(link);
  ok("…and once they're used up, no button", /All downloads used/.test(pg.text) && !/class="btn"/.test(pg.text));
  const refused = await get(fileHref);
  ok("another click is refused with a page the browser shows (not saved as the file)", refused.status === 410 && /All downloads used/.test(refused.text) &&
    /text\/html/.test(refused.headers.get("Content-Type")) && !refused.headers.get("Content-Disposition"));
  ok("…and nothing is counted past the limit", d1.q("SELECT downloads FROM download_grants g JOIN orders o ON o.orderId = g.orderId WHERE o.orderId = 'P-1'")[0].downloads === 2);
  ok("the waiting and error pages have no script", !/<script/.test((await get(link.replace(/t=[0-9a-f]{4}/, "t=0000"))).text));

  // The button's script in a browser (jsdom): greys out at once, ignores a second click, reloads a moment later.
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(`<a class="btn" href="/f">Download</a>`, { url: "https://example.test/api/download", runScripts: "outside-only" });
  const timers = [];
  dom.window.setTimeout = (fn, ms) => { timers.push(ms); return 0; };
  const src = read("functions/api/download.js").match(/const RELOAD_SCRIPT = `([\s\S]*?)`;/)[1].replace(/\\u2026/g, "\u2026");
  dom.window.eval(src);
  const a = dom.window.document.querySelector("a.btn");
  const e1 = new dom.window.MouseEvent("click", { cancelable: true }); a.dispatchEvent(e1);
  const e2 = new dom.window.MouseEvent("click", { cancelable: true }); a.dispatchEvent(e2);
  ok("clicking Download: it says Downloading…, greys out and the page reloads after 2.5 s", a.textContent === "Downloading\u2026" && a.style.opacity === "0.6" && timers.join() === "2500");
  ok("…the first click goes through, a second one doesn't", !e1.defaultPrevented && e2.defaultPrevented);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
