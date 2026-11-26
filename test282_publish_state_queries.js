const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { asRole } = require("./testlib/roles");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts");

// Each shop's publish state, read for many shops at once (2026-11, review round 2). getPublishState read every shop
// one after another — its snapshot, the snapshot's parts, its orgs row and all its products: four queries a shop —
// and the admin asked for EVERY shop on every catalog page (the shop bar shows one) and after every publish. D1 caps
// the queries one Worker request may run (50 on the Free plan), so a dozen shops broke the shop bar and "Publish all
// shops" failed after the snapshots were written. Now:
//   - getPublishState(db, orgIds) reads the shops it was asked for in four queries, however many they are, and
//     compares in memory — the same answer per shop as before;
//   - the getPublishState action takes { orgs: [...] }: the shop bar and a shop's own pages ask for that one shop,
//     Manage catalog for all;
//   - publish, discard and apply-prices answer with the state of the shops they touched; the page adds it to what it
//     holds;
//   - a publish request takes at most 10 shops; "Publish all shops" sends them in groups of 10.
// Real SQL (sql.js), the real db.js and orders.js, and the real admin page in jsdom. Invented shops only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const names = "createProduct, updateProduct, getPublishState, publishShop, getCatalogSnapshot, liveShopRows_, createBlank, setBlankLink, setBrandRules, getBrandRules";
const lib = new Function(dbSrc + `\nreturn { ${names} };`)();
// The same code publishing in parts of 600 bytes, so a three-product shop's snapshot is in several parts.
const smallParts = new Function(dbSrc.replace("const SNAPSHOT_PART_BYTES_ = 1000000;", "const SNAPSHOT_PART_BYTES_ = 600;") + `\nreturn { ${names} };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/setupStatus.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@example.test'; " + require("./testlib/roles").adminAs() + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const copyVendorImage = async () => ({ ok: false });\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setTimeout(r, 10)); return cond(); };

// The way it was read before (db.js getPublishState as it stood on 2026-11-25): shop by shop.
async function oldGetPublishState(db) {
  const { results: orgs } = await db.prepare("SELECT orgId FROM orgs ORDER BY orgId").all();
  const out = {};
  for (const { orgId } of orgs) {
    const snap = await lib.getCatalogSnapshot(db, orgId);
    if (!snap) { out[orgId] = { state: "never" }; continue; }
    const live = await lib.liveShopRows_(db, orgId);
    const key = (r) => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]]));
    const pubBy = new Map(snap.products.map(p => [p.productId, key(p)]));
    const liveBy = new Map(live.products.map(p => [p.productId, key(p)]));
    const changed = [];
    for (const [id, k] of liveBy) if (pubBy.get(id) !== k) changed.push(id);
    for (const id of pubBy.keys()) if (!liveBy.has(id)) changed.push(id);
    const shopChanged = key(snap.org) !== key(live.org);
    out[orgId] = { state: changed.length || shopChanged ? "changed" : "current", publishedAt: snap.publishedAt, publishedBy: snap.publishedBy, changedProducts: changed, shopChanged };
  }
  return out;
}
// Counts database round trips: each first / all / run is one, a batch is one (its statements counted apart); the
// audit entry (written after the answer) apart again.
function counting(d1) {
  const c = { calls: 0, statements: 0, audit: 0 };
  const wrap = (st) => {
    const isAudit = /INSERT INTO audit_log/.test(st._sql || "");
    const tally = () => { if (isAudit) c.audit++; else { c.calls++; c.statements++; } };
    return { _sql: st._sql, _params: st._params, first: (...a) => { tally(); return st.first(...a); }, all: (...a) => { tally(); return st.all(...a); }, run: (...a) => { tally(); return st.run(...a); } };
  };
  return { c, db: {
    prepare: (sql) => { const p = d1.prepare(sql); return Object.assign(wrap(p), { bind: (...v) => wrap(p.bind(...v)) }); },
    batch: (stmts) => { c.calls++; c.statements += stmts.length; return d1.batch(stmts); } } };
}
const idOf = (i) => "s" + String(i).padStart(2, "0");
const product = (pid, price) => ({ productId: pid, type: "shirt", name: "Tee " + pid, pricingMode: "flat", flatPrice: price, visible: true, images: [] });
async function addShop(d1, i) {
  const id = idOf(i);
  d1._raw.run("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES (?, ?, ?, 't', 't', 1)", [id, id, "Shop " + id]);
  for (const pid of ["a", "b", "c"]) await lib.createProduct(d1, id, product(pid, 20 + i));
  return id;
}
async function makeDb() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
}

(async () => {
  const d1 = await makeDb();
  const { db, c } = counting(d1);
  const measure = async (fn) => { Object.assign(c, { calls: 0, statements: 0, audit: 0 }); const r = await fn(); return { r, calls: c.calls, statements: c.statements, audit: c.audit }; };

  console.log("=== The same number of queries for 2 shops and for 20 ===");
  for (let i = 0; i < 2; i++) { await addShop(d1, i); await lib.publishShop(d1, idOf(i), "owner@example.test"); }
  const two = await measure(() => lib.getPublishState(db));
  for (let i = 2; i < 20; i++) { await addShop(d1, i); if (i !== 2) await lib.publishShop(d1, idOf(i), "owner@example.test"); }
  // Every kind of shop: s02 never published; s03 a product changed; s04 one added; s05 one deleted; s06 its settings
  // changed; s07 published before the snapshot was kept in parts; s08 in several parts, one product changed;
  // s09 a snapshot row that isn't one.
  await lib.updateProduct(d1, "s03", product("b", 99));
  await lib.createProduct(d1, "s04", product("z", 5));
  d1._raw.run("DELETE FROM products WHERE orgId = 's05' AND productId = 'a'");
  d1._raw.run("UPDATE orgs SET name = 'Renamed' WHERE orgId = 's06'");
  { const snap = await lib.getCatalogSnapshot(d1, "s07");
    d1._raw.run("UPDATE catalog_snapshots SET json = ? WHERE orgId = 's07'", [JSON.stringify({ org: snap.org, products: snap.products })]);
    d1._raw.run("DELETE FROM catalog_snapshot_parts WHERE orgId = 's07'");
    await lib.updateProduct(d1, "s07", product("c", 77)); }
  await smallParts.publishShop(d1, "s08", "owner@example.test");
  await lib.updateProduct(d1, "s08", product("a", 88));
  d1._raw.run("UPDATE catalog_snapshots SET json = '{}' WHERE orgId = 's09'");
  const twenty = await measure(() => lib.getPublishState(db));
  ok(`20 shops are read in ${twenty.calls} queries — the same as 2 shops (${two.calls}); it was 1 + 4 a shop (81)`, twenty.calls === two.calls && twenty.calls <= 4 && Object.keys(twenty.r).length === 20 && Object.keys(two.r).length === 2);
  ok("…the snapshot of s08 really is in several parts, and s07's holds its own products", d1.q("SELECT count(*) n FROM catalog_snapshot_parts WHERE orgId = 's08'")[0].n >= 2 && d1.q("SELECT count(*) n FROM catalog_snapshot_parts WHERE orgId = 's07'")[0].n === 0);
  const before = await oldGetPublishState(d1);
  ok("the answer for every shop is exactly what the shop-by-shop read gave", JSON.stringify(twenty.r) === JSON.stringify(before));
  const st = twenty.r;
  ok("…never published, current, a product changed, added, deleted, the shop's settings changed", st.s02.state === "never" && st.s00.state === "current" && st.s00.publishedBy === "owner@example.test" && !!st.s00.publishedAt &&
    st.s03.state === "changed" && st.s03.changedProducts.join() === "b" && st.s04.changedProducts.join() === "z" && st.s05.changedProducts.join() === "a" &&
    st.s06.state === "changed" && st.s06.shopChanged === true && st.s06.changedProducts.length === 0 && st.s03.shopChanged === false);
  ok("…a snapshot from before parts, one in several parts, and a row that isn't a snapshot", st.s07.state === "changed" && st.s07.changedProducts.join() === "c" && st.s08.changedProducts.join() === "a" && st.s09.state === "never");

  console.log("\n=== Only the shops asked for ===");
  const one = await measure(() => lib.getPublishState(db, ["s03"]));
  ok(`one shop: its state alone, in ${one.calls} queries`, Object.keys(one.r).join() === "s03" && JSON.stringify(one.r.s03) === JSON.stringify(before.s03) && one.calls <= 4);
  const some = await measure(() => lib.getPublishState(db, ["s08", "s02", "nobody", "s08", "s05"]));
  ok("several, in any order, a name twice, a shop that doesn't exist: the ones there are, by shop", Object.keys(some.r).join() === "s02,s05,s08" && ["s02", "s05", "s08"].every(k => JSON.stringify(some.r[k]) === JSON.stringify(before[k])) && some.calls <= 4);
  ok("no shops asked for: none answered (not every shop)", JSON.stringify(await lib.getPublishState(db, [])) === "{}");
  const never = await measure(() => lib.getPublishState(db, ["s02"]));
  ok(`a shop never published is compared with nothing (${never.calls} queries: its products aren't read)`, never.r.s02.state === "never" && never.calls === 2);
  // A snapshot with a part missing is an error, as before — never "not published", which would serve the draft.
  d1._raw.run("DELETE FROM catalog_snapshot_parts WHERE orgId = 's08' AND part = 1");
  let broken = null, brokenOld = null;
  try { await lib.getPublishState(d1, ["s08"]); } catch (e) { broken = e; }
  try { await oldGetPublishState(d1); } catch (e) { brokenOld = e; }
  ok("a published catalog with a part missing is still an error that says so", !!broken && !!brokenOld && broken.message === brokenOld.message && /incomplete/.test(broken.message));
  await smallParts.publishShop(d1, "s08", "owner@example.test");

  console.log("\n=== The admin actions ===");
  const call = async (body, on = db) => {
    const waits = [];
    const res = await api({ env: { DB: on }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  let r = (await measure(() => call({ action: "getPublishState", orgs: ["s03"] }))).r;
  ok("getPublishState { orgs: [one] } answers for that shop", r.status === 200 && Object.keys(r.body.publishState).join() === "s03" && r.body.publishState.s03.state === "changed");
  r = await call({ action: "getPublishState" });
  ok("…and with no list, for every shop", Object.keys(r.body.publishState).length === 20);
  const snapCount = () => d1.q("SELECT count(*) n FROM catalog_snapshots WHERE publishedBy = 'second@example.test'")[0].n;
  d1._raw.run("UPDATE catalog_snapshots SET publishedBy = 'first@example.test'");
  const all20 = await measure(() => call({ action: "publish" }));
  ok("publish for more than 10 shops at once is refused, saying the most it takes, and publishes nothing", all20.r.status === 400 && /max 10/.test(all20.r.body.message) &&
    d1.q("SELECT count(*) n FROM catalog_snapshots WHERE publishedBy <> 'first@example.test'")[0].n === 0 && d1.q("SELECT count(*) n FROM catalog_snapshots")[0].n === 19);
  r = await call({ action: "publish", orgs: Array.from({ length: 11 }, (_, i) => idOf(i)) });
  ok("…11 named shops too", r.status === 400 && /max 10/.test(r.body.message));
  const group = Array.from({ length: 10 }, (_, i) => idOf(i));
  const ten = await measure(() => call({ action: "publish", orgs: group }));
  ok("10 named shops are published", ten.r.status === 200 && ten.r.body.published.join() === group.join() && group.every(id => d1.q("SELECT publishedBy b FROM catalog_snapshots WHERE orgId = ?", id)[0].b === "owner@example.test"));
  ok("…the answer has the state of those 10 — all current now — and no other shop's", Object.keys(ten.r.body.publishState).join() === group.join() && group.every(id => ten.r.body.publishState[id].state === "current"));
  ok(`…in ${ten.calls} database round trips, under the 50 one request may run`, ten.calls < 50);
  ok("…one audit entry naming the shops", ten.audit === 1 && JSON.parse(d1.q("SELECT detail FROM audit_log WHERE action = 'catalog.published' ORDER BY id DESC LIMIT 1")[0].detail).shops.length === 10);
  r = await call({ action: "publish", org: "s12" });
  ok("publish { org } still publishes one shop and answers with that shop's state", r.status === 200 && r.body.published.join() === "s12" && Object.keys(r.body.publishState).join() === "s12");
  r = await call({ action: "publish", orgs: ["nobody"] });
  ok("…a shop that doesn't exist: not found", r.status === 404);
  await lib.updateProduct(d1, "s13", product("a", 55));
  r = await call({ action: "discardShopChanges", org: "s13" });
  ok("discard answers with that shop's state (current again)", r.status === 200 && Object.keys(r.body.publishState).join() === "s13" && r.body.publishState.s13.state === "current");
  // Apply rule prices sets only the saved price rule's prices: both products on a blank with a $40 MAP, the rule MAP + $1
  // ($41, or $41.99 rounded up to .99).
  { const blankId = (await lib.createBlank(d1, { name: "Tee MAP", brand: "", productType: "shirt", colors: [{ color: "Black", images: [], sizes: [{ size: "M", vendorPrice: 5, purchasePrice: 5, quantity: 0, mapPrice: 40 }] }] })).id;
    await lib.setBlankLink(d1, "s14", "a", "", "", blankId, "Black", "M"); await lib.setBlankLink(d1, "s15", "b", "", "", blankId, "Black", "M");
    await lib.setBrandRules(d1, Object.assign({}, await lib.getBrandRules(d1), { priceRule: { add: 1, unit: "amount" } })); }
  r = await call({ action: "applyRulePrices", changes: [{ org: "s14", productId: "a", group: "", size: "", price: 41 }, { org: "s15", productId: "b", group: "", size: "", price: 41.99 }] });
  ok("applying prices answers with the state of the shops whose products changed", r.status === 200 && r.body.prices === 2 && Object.keys(r.body.publishState).join() === "s14,s15" && r.body.publishState.s14.changedProducts.join() === "a");

  console.log("\n=== The admin page ===");
  {
    for (let i = 20; i < 23; i++) { await addShop(d1, i); if (i !== 20) await lib.publishShop(d1, idOf(i), "owner@example.test"); }
    await call({ action: "publish", orgs: ["s10", "s11", "s14", "s15", "s16", "s17", "s18", "s19"] }, d1);
    await lib.updateProduct(d1, "s03", product("c", 12));   // s03: unpublished changes; s01: current; s20: never published
    const sent = [];
    let failPublishAt = 0, publishes = 0;
    const adminJs = read("public/admin.js");
    class Ld extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
    const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Ld(), url: ADMIN_ORIGIN + "/#home", pretendToBeVisual: true,
      beforeParse(win) { autoConfirm(win, () => true); win.open = () => null; win.CSS = win.CSS || { escape: (x) => String(x) }; win.fetch = async (url, init) => {
        if (!String(url).includes("/api/orders")) return { ok: true, status: 200, json: async () => ({ status: "admin" }) };
        const b = JSON.parse(init.body);
        sent.push(Object.assign({ status: (win.document.getElementById("publishStatus") || {}).textContent || "" }, b));
        if (b.action === "publish" && failPublishAt && ++publishes === failPublishAt) return { ok: false, status: 500, json: async () => ({ status: "error", message: "The database is busy" }) };
        const x = await call(b, d1); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }; } });
    const w = dom.window, d = w.document;
    await new Promise(res => setTimeout(res, 150));
    await w.loadAdminScript();
    w.eval('adminKey = "cookie";');
    w.eval(asRole("admin"));
    w.eval(`adminOrgs = ${JSON.stringify(Array.from({ length: 23 }, (_, i) => ({ orgId: idOf(i), name: "Shop " + idOf(i), subdomain: idOf(i) })))};`);
    const asked = () => sent.filter(b => b.action === "getPublishState");
    const barOn = async (shop) => { w.eval(`window._shopBarCtx = { shop: ${JSON.stringify(shop)}, page: "designs" };`); await w.loadShopBarData_(false, shop); return w.shopBarHtml_({ shop, page: "designs" }); };

    let bar = await barOn("s03");
    ok("the shop bar asks for the publish state of the shop it shows, not every shop's", asked().length === 1 && JSON.stringify(asked()[0].orgs) === '["s03"]');
    ok("…and offers Publish changes for a shop with unpublished changes", /shop-bar-pub"[^>]*>Publish changes</.test(bar) && /Discard changes/.test(bar));
    bar = await barOn("s01");
    ok("another shop: asked for in its turn, and shown as ✓ Published", asked().length === 2 && JSON.stringify(asked()[1].orgs) === '["s01"]' && /disabled[^>]*>✓ Published</.test(bar));
    bar = await barOn("s20");
    ok("…and one never published: Publish", /shop-bar-pub"[^>]*>Publish</.test(bar) && !/Discard changes/.test(bar));
    await barOn("s03");
    ok("coming back to a shop read a moment ago doesn't ask again", asked().length === 3);
    // Publishing from the bar: the answer has that shop's state; the others the page holds stay.
    await w.shopBarPublish_("s03");
    bar = w.shopBarHtml_({ shop: "s03", page: "designs" });
    ok("Publish on the bar: that shop reads ✓ Published", sent.some(b => b.action === "publish" && b.org === "s03") && /disabled[^>]*>✓ Published</.test(bar));
    ok("…and what the page knew about the other shops is kept", w.eval("window._shopBarData.publish.s01.state") === "current" && w.eval("window._shopBarData.publish.s20.state") === "never" && w.eval("window._publishState.s20.state") === "never");

    // Manage catalog: every shop's state in one request.
    sent.length = 0;
    await w.renderAdminOrgList(d.getElementById("app"));
    await wait(() => d.querySelector('[data-publish-state="s22"] .pub-state'));
    ok("Manage catalog asks once, for every shop", asked().length === 1 && asked()[0].orgs === undefined && d.querySelectorAll("[data-publish-state] .pub-state").length === 23);
    ok("…and shows each: never published, published", /Not published yet/.test(d.querySelector('[data-publish-state="s20"]').textContent) && /✓ Published/.test(d.querySelector('[data-publish-state="s03"]').textContent));
    await lib.updateProduct(d1, "s21", product("a", 3));
    sent.length = 0;
    await w.publishCatalog();
    const pubs = sent.filter(b => b.action === "publish");
    ok("Publish all shops sends the 23 shops in groups of 10, 10 and 3", pubs.map(b => (b.orgs || []).length).join() === "10,10,3" && pubs.every(b => !b.org) && new Set(pubs.flatMap(b => b.orgs)).size === 23);
    ok("…saying how far it is, then that all 23 are published", /Publishing… 0 of 23 shops done/.test(pubs[0].status) && /Publishing… 10 of 23 shops done/.test(pubs[1].status) && /Publishing… 20 of 23 shops done/.test(pubs[2].status) &&
      d.getElementById("publishStatus").textContent === "Published all 23 shops — shoppers see the changes now.");
    ok("…every shop published, and every row reads ✓ Published (s20, never published before, too)", d1.q("SELECT count(*) n FROM catalog_snapshots")[0].n === 23 &&
      [...d.querySelectorAll("[data-publish-state]")].every(el => /✓ Published/.test(el.textContent)) && Object.values(await lib.getPublishState(d1)).every(x => x.state === "current"));
    // A group that fails: the groups before it stay published, the rest aren't sent, and the page says so.
    for (const id of ["s00", "s12", "s22"]) await lib.updateProduct(d1, id, product("a", 4));
    await w.renderAdminOrgList(d.getElementById("app"));
    await wait(() => /Unpublished changes/.test((d.querySelector('[data-publish-state="s22"]') || {}).textContent || ""));
    sent.length = 0; failPublishAt = 2; publishes = 0;
    await w.publishCatalog();
    ok("a group that fails stops the rest, and the page says how many shops were published before it",
      sent.filter(b => b.action === "publish").length === 2 && d.getElementById("publishStatus").textContent === "Could not publish: The database is busy. 10 of 23 shops were published before that; the others were not.");
    ok("…the first group's rows read ✓ Published, the others still show their changes", /✓ Published/.test(d.querySelector('[data-publish-state="s00"]').textContent) &&
      /Unpublished changes/.test(d.querySelector('[data-publish-state="s12"]').textContent) && /Unpublished changes/.test(d.querySelector('[data-publish-state="s22"]').textContent));
  }

  const dbJs = read("functions/_lib/db.js"), fn = dbJs.slice(dbJs.indexOf("export async function getPublishState("), dbJs.indexOf("export async function createOrg("));
  ok("getPublishState reads no shop on its own any more", !/getCatalogSnapshot\(|liveShopRows_\(/.test(fn) && /orgIds = null/.test(fn));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test282 crashed: false"); process.exit(1); });
