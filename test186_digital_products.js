const fs = require("fs");
const { may, lowest } = require("./testlib/roles");   // the built-in roles (functions/_lib/permissions.js)
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

// Digital products (migrations/0086): files a customer buys and downloads. A product marked digital needs no blank,
// design or shipping; a cart of only those needs no delivery choice. Once the order is paid each line gets a grant
// per file (db.js grantOrderDownloads), the customer gets a download page (/api/download, its token an HMAC of the
// order and a salt) and one "Your downloads" email with the link and — when they fit — the files; each file can be
// downloaded so many times, for so many days; Resend link retires the old link, Reset and Revoke do what they say.
// Real db.js / email.js / digital.js / orders.js / download.js on sql.js, R2 faked.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const emailSrc = strip(read("functions/_lib/email.js")).replace(/async function send_\(/, "async function send_unused_(") +
  "\nasync function send_(env, m) { m = fillTemplate_(m, { name: 'Acme Tees', owner: 'owner@acme.test', bcc: '' }); (globalThis.__mails = globalThis.__mails || []).push(m); return true; }\n";
const digitalSrc = strip(read("functions/_lib/digital.js"));
const lib = new Function(hostSrc + "\n" + httpSrc + "\n" + dbSrc + "\n" + emailSrc + "\n" + digitalSrc +
  `\nreturn { createProduct, updateProduct, getProductsByOrg, addProductFile, listProductFiles, orderDigitalLines, grantOrderDownloads, listDownloadGrants,
    getDigitalSettings, setDigitalSettings, digitalDeliveryFor, downloadLink, deliverOrderDownloads, grantBlocked, getOrderById, settleOrderBalance, buildDownloadsEmail };`)();
const api = new Function(hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async (env) => ({ subdomainMap: { acme: 'acme' }, orgs: {}, features: globalThis.__features || {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + emailSrc + "\n" + digitalSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const download = new Function(hostSrc + "\n" + httpSrc + "\n" + dbSrc + "\n" + emailSrc + "\n" + digitalSrc + "\nconst rateLimited = async () => ({ blocked: false });\n" +
  strip(read("functions/api/download.js")) + "\nreturn onRequestGet;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// An R2 bucket in memory: get (with an optional range), head, put, delete.
function fakeR2() {
  const m = new Map();
  return { m,
    async put(k, bytes) { m.set(k, Buffer.from(bytes)); },
    async head(k) { const b = m.get(k); return b ? { size: b.length } : null; },
    async delete(k) { m.delete(k); },
    async get(k) { const b = m.get(k); if (!b) return null; return { size: b.length, body: b, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; } };
}

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, deliveryOptionsJson) VALUES ('acme','acme','Acme Tees','t','t',1,'[{"id":"pickup","type":"pickup","label":"Local pickup","fee":0}]');`);
  const R2 = fakeR2();
  const env = { DB: d1, DESIGNS: R2, SIGNING_SECRET: "a-test-signing-secret-of-good-length" };
  const post = async (url, body) => { const res = await api({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
    request: { url, json: async () => body, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const admin = (body) => post(ADMIN_ORIGIN + "/api/orders", Object.assign({ key: "x" }, body));
  const shop = (body) => post(shopOrigin("acme") + "/api/orders", Object.assign({ orgId: "acme", customerName: "Pat Buyer", contact: "pat@cust.test", paymentMethod: "Venmo" }, body));
  const get = async (url, { method = "GET", headers = {} } = {}) => {
    const res = await download({ env, request: { url, method, headers: { get: (h) => headers[h] || null } } });
    return { status: res.status, headers: res.headers, text: method === "HEAD" ? "" : await res.text() };
  };

  console.log("=== A digital product ===");
  await lib.createProduct(d1, "acme", { productId: "rose", type: "other", name: "Rose design (DST + PES)", pricingMode: "flat", flatPrice: 12, visible: true, digital: true, digitalDelivery: { days: 3, downloads: 2 } });
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 25, visible: true, noDesignNeeded: true, noBlankNeeded: true });
  let p = (await lib.getProductsByOrg(d1, "acme")).find(x => x.productId === "rose");
  ok("marked digital: no blank and no design needed, with its own limits", p.digital && p.noBlankNeeded && p.noDesignNeeded && p.digitalDelivery.days === 3 && p.digitalDelivery.downloads === 2 && !("attach" in p.digitalDelivery));
  ok("the global defaults: 7 days, 5 downloads, email and attach on, 10 MB", JSON.stringify(await lib.getDigitalSettings(d1)) === JSON.stringify({ days: 7, downloads: 5, attachMb: 10, attach: true, email: true }));
  ok("a product's limits sit on top of the defaults", JSON.stringify(lib.digitalDeliveryFor(p, await lib.getDigitalSettings(d1))) === JSON.stringify({ days: 3, downloads: 2, attachMb: 10, attach: true, email: true }));
  ok("the storefront is told it's a download", /if\(p\.digital\) out\.digital = true;/.test(read("functions/api/catalog.js")) && /Instant download/.test(read("public/index.html")));
  let r = await admin({ action: "updateProduct", org: "acme", productId: "rose", pricingMode: "sized", sizePricing: { M: 5 } });
  ok("a digital product can't have sizes", r.status === 400 && /one price/.test(r.body.message));

  console.log("\n=== Its files ===");
  await R2.put("digital/acme/rose/" + "a".repeat(32) + ".dst", Buffer.from("DST-STITCHES"));
  await R2.put("digital/acme/rose/" + "b".repeat(32) + ".pes", Buffer.from("PES-STITCHES-LONGER"));
  await lib.addProductFile(d1, "acme", "rose", { fileKey: "digital/acme/rose/" + "a".repeat(32) + ".dst", fileName: "rose.dst", fileExt: "dst", bytes: 12 });
  await lib.addProductFile(d1, "acme", "rose", { fileKey: "digital/acme/rose/" + "b".repeat(32) + ".pes", fileName: "rose.pes", fileExt: "pes", bytes: 19 });
  r = await admin({ action: "listProductFiles", org: "acme", productId: "rose" });
  ok("the product lists its files in order", r.status === 200 && r.body.files.map(f => f.fileName).join() === "rose.dst,rose.pes");
  const ds = read("functions/api/design.js");
  ok("uploads go to the private bucket under digital/<org>/<product>/, embroidery files, PDFs and zips, manager or above", /digital\/\$\{keyPart_\(org\)\}\/\$\{keyPart_\(productId\)\}/.test(ds) &&
    /DIGITAL_EXTRA_EXTS = new Set\(\["pdf", "zip"\]\)/.test(ds) && /\[\["catalog\.productFiles", "edit"\]\]\);/.test(ds) && lowest("addProductFileFromDesign") === "manager");

  console.log("\n=== Ordering ===");
  r = await shop({ orderId: "D-1", items: [{ productId: "rose", qty: 1 }] });
  ok("a cart of only downloads needs no delivery choice", r.status === 200, JSON.stringify(r.body));
  let o = await lib.getOrderById(d1, "D-1");
  ok("…the order says digital delivery, with no address and no shipping", o.shippingMethod === "Digital delivery" && !o.shippingAddress && Number(o.shippingCost) === 0);
  r = await shop({ orderId: "D-2", items: [{ productId: "rose", qty: 1 }, { productId: "cap", qty: 1 }], deliveryOptionId: "pickup" });
  ok("a mixed cart goes by the delivery chosen for the rest (here local pickup)", r.status === 200 && (await lib.getOrderById(d1, "D-2")).shippingMethod !== "Digital delivery");

  console.log("\n=== Before payment ===");
  const link = await lib.downloadLink(env, "D-1", "acme");
  ok("the link is on the shop's address, with the order and a 64-character token", new RegExp("^" + shopOrigin("acme").replace(/\./g, "\\.") + "/api/download\\?o=D-1&t=[0-9a-f]{64}$").test(link));
  let g = await get(link);
  ok("before the order is paid the page waits, and checks again by itself", g.status === 200 && /Almost there/.test(g.text) && /http-equiv="refresh"/.test(g.text));
  ok("…nothing is granted or emailed yet", (await lib.listDownloadGrants(d1, "D-1")).length === 0 && !(globalThis.__mails || []).some(m => /Your downloads/.test(m.subject)));
  g = await get(link.replace(/t=[0-9a-f]{4}/, "t=0000"));
  ok("a wrong token: not found", g.status === 404);
  ok("the page is never cached or indexed", g.headers.get("Cache-Control") === "no-store" && /noindex/.test(g.headers.get("X-Robots-Tag")));

  console.log("\n=== Paid ===");
  globalThis.__mails = [];
  r = await admin({ action: "markPaidManual", org: "acme", orderId: "D-1" });
  const grants = await lib.listDownloadGrants(d1, "D-1");
  ok("Mark paid grants each file of the line, with the product's limits", r.status === 200 && grants.length === 2 && grants.every(x => x.maxDownloads === 2 && x.downloads === 0 && x.expiresAt));
  const mail = globalThis.__mails.find(m => /Your downloads/.test(m.subject));
  ok("one \"Your downloads\" email, with the link and both files attached", !!mail && mail.html.includes("/api/download?o=D-1&amp;t=") && (mail.attachments || []).map(a => a.filename).join() === "rose.dst,rose.pes" &&
    Buffer.from(mail.attachments[0].contentBase64, "base64").toString() === "DST-STITCHES" && mail.attachments[0].contentType === "application/octet-stream");
  ok("…telling the customer the limits", /2 downloads/.test(mail.text) && /until/.test(mail.text));
  await lib.deliverOrderDownloads(env, "D-1");
  ok("delivering again grants nothing new and doesn't email twice", (await lib.listDownloadGrants(d1, "D-1")).length === 2 && globalThis.__mails.filter(m => /Your downloads/.test(m.subject)).length === 1);
  const link2 = await lib.downloadLink(env, "D-1", "acme");
  ok("the link stays the same until it's resent", link2 === link);

  console.log("\n=== Downloading ===");
  g = await get(link);
  ok("the page lists each file with its size and downloads left", g.status === 200 && /rose\.dst/.test(g.text) && /rose\.pes/.test(g.text) && /2 of 2 downloads left/.test(g.text));
  const fileUrl = link + "&f=" + grants[0].id;
  g = await get(fileUrl, { method: "HEAD" });
  ok("a HEAD isn't counted", g.status === 200 && (await lib.listDownloadGrants(d1, "D-1"))[0].downloads === 0);
  g = await get(fileUrl);
  ok("the file comes as an attachment, not cached", g.status === 200 && g.text === "DST-STITCHES" && /attachment; filename="rose\.dst"/.test(g.headers.get("Content-Disposition")) && g.headers.get("Cache-Control") === "no-store");
  ok("…counted, and logged", (await lib.listDownloadGrants(d1, "D-1"))[0].downloads === 1 && d1.q("SELECT count(*) n FROM download_log")[0].n === 1);
  g = await get(fileUrl, { headers: { Range: "bytes=5-" } });
  ok("a resumed download isn't counted again", (await lib.listDownloadGrants(d1, "D-1"))[0].downloads === 1);
  g = await get(fileUrl, { headers: { Range: "bytes=1-", "CF-Connecting-IP": "198.51.100.7" } });
  ok("…but \"the rest of the file\" asked for from a network that never downloaded it is counted", g.status !== 410 && (await lib.listDownloadGrants(d1, "D-1"))[0].downloads === 2);
  g = await get(fileUrl, { headers: { Range: "bytes=-4", "CF-Connecting-IP": "203.0.113.40" } });
  ok("…and once the limit is used, a Range gets nothing either", g.status === 410 && (await lib.listDownloadGrants(d1, "D-1"))[0].downloads === 2);
  g = await get(fileUrl);
  ok("after the limit: refused, and the page says so", g.status === 410 && /All downloads used/.test(g.text) && /All downloads used/.test((await get(link)).text));
  g = await get(link + "&f=999999");
  ok("a file that isn't this order's: not found", g.status === 404);
  d1._raw.run("UPDATE download_grants SET expiresAt = '2020-01-01T00:00:00.000Z' WHERE id = ?", [grants[1].id]);
  g = await get(link + "&f=" + grants[1].id);
  ok("an expired link: refused", g.status === 410 && /expired/.test(g.text));

  console.log("\n=== The admin's actions ===");
  r = await admin({ action: "getOrderDownloads", org: "acme", orderId: "D-1" });
  ok("the order's downloads: each file, what's used, why it's blocked, when it was emailed", r.status === 200 && r.body.grants[0].blocked === "used" && r.body.grants[1].blocked === "expired" && r.body.emailedAt);
  r = await admin({ action: "resetDownloads", org: "acme", orderId: "D-1" });
  ok("Reset: counts back to 0, a new expiry", r.body.grants.every(x => x.downloads === 0 && !x.blocked && x.expiresAt > new Date().toISOString()));
  r = await admin({ action: "revokeDownloads", org: "acme", orderId: "D-1" });
  g = await get(fileUrl);
  ok("Revoke: the files can't be downloaded", r.body.grants.every(x => x.blocked === "revoked") && g.status === 410);
  await admin({ action: "resetDownloads", org: "acme", orderId: "D-1" });
  globalThis.__mails = [];
  r = await admin({ action: "resendDownloads", org: "acme", orderId: "D-1" });
  const newLink = (globalThis.__mails[0].text.match(/https:\/\/\S+\/api\/download\?o=D-1&t=[0-9a-f]{64}/) || [])[0];
  ok("Resend link: a new link, emailed with the files", r.status === 200 && r.body.sent.attached === 2 && newLink && newLink !== link);
  ok("…and the old link stops working", (await get(link)).status === 404 && (await get(newLink)).status === 200);
  ok("each action is audited", ["order.downloads_reset", "order.downloads_revoked", "order.downloads_resent"].every(a => d1.q("SELECT count(*) n FROM audit_log WHERE action = ?", a)[0].n >= 1));

  console.log("\n=== What's attached ===");
  d1._raw.exec(`UPDATE products SET digitalDeliveryJson = '{"days":3,"downloads":2,"attach":false}' WHERE productId = 'rose'`);
  await shop({ orderId: "D-3", items: [{ productId: "rose", qty: 1 }] });
  globalThis.__mails = [];
  await admin({ action: "markPaidManual", org: "acme", orderId: "D-3" });
  let m3 = globalThis.__mails.find(m => /Your downloads/.test(m.subject));
  ok("attachments off for the product: the link only", m3 && !(m3.attachments || []).length && /Download them from the link/.test(m3.text));
  d1._raw.exec(`UPDATE products SET digitalDeliveryJson = '{"days":3,"downloads":2}' WHERE productId = 'rose'`);
  await lib.setDigitalSettings(d1, { days: 7, downloads: 5, attachMb: 1, attach: true, email: true });
  await R2.put("digital/acme/rose/" + "c".repeat(32) + ".zip", Buffer.alloc(2 * 1048576, 1));
  await lib.addProductFile(d1, "acme", "rose", { fileKey: "digital/acme/rose/" + "c".repeat(32) + ".zip", fileName: "rose-all-formats.zip", fileExt: "zip", bytes: 2 * 1048576 });
  await shop({ orderId: "D-4", items: [{ productId: "rose", qty: 1 }] });
  globalThis.__mails = [];
  await admin({ action: "markPaidManual", org: "acme", orderId: "D-4" });
  let m4 = globalThis.__mails.find(m => /Your downloads/.test(m.subject));
  ok("over the size cap: none attached, and the email says they're too large", m4 && !(m4.attachments || []).length && /too large to attach/.test(m4.text));

  console.log("\n=== Switched off ===");
  globalThis.__features = { digital: false };
  r = await shop({ orderId: "D-5", items: [{ productId: "rose", qty: 1 }] });
  ok("Digital products off: a download-only cart is refused", r.status === 400 && /Downloads aren't available/.test(r.body.message));
  globalThis.__features = {};
  d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('features', '{"digital":false}')`);
  ok("…and the links don't open", (await get(newLink)).status === 403);
  d1._raw.exec(`DELETE FROM global_settings WHERE key = 'features'`);

  console.log("\n=== Card payments and the code paths ===");
  const co = read("functions/api/checkout.js"), wh = read("functions/api/stripe-webhook.js");
  ok("a card payment for an order with downloads returns to its download page", /orderDigitalLines\(env\.DB, orderId\)\)\.length\) downloadUrl = await downloadLink/.test(co) && /const successUrl = downloadUrl \? downloadUrl/.test(co));
  ok("the Stripe webhook delivers the downloads once the payment is recorded (after responding)", /if\(inserted && typeof deliverOrderDownloads === "function"\)/.test(wh) && /context\.waitUntil\(deliver\)/.test(wh));
  ok("voiding an order revokes its downloads", /await revokeOrderDownloads\(env\.DB, orderId\)/.test(read("functions/api/orders.js")));
  ok("a mixed cart's parcel leaves the downloads out", /const parcelItems = items\.filter\(it => !it\.digital\)/.test(read("functions/api/shipping.js")));
  ok("the desktop version has no digital products (no storefront)", /"storefront", "digital"/.test(read("functions/_lib/hostConfig.js")));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
