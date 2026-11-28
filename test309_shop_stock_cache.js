const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { shopOrigin } = require("./testlib/hosts.js");

// The shop page's stock is kept 30 seconds per shop (2026-11, review round 2). Every view of a shop page read the shop's
// finished stock, which digital products have files and the blanks' free stock — about six D1 queries, two of them over
// every open order, and one (the links of the shop's blanks) through every shop's links for want of an index. Now the
// block is kept per shop in the isolate's memory and the Cache API for 30 seconds (catalog.js readShopStock_), and
// migrations/0109 indexes product_blank_links by blank. Placing an order doesn't use the kept copy: a line is filled from
// stock only if the database still has the pieces. Runs the REAL db.js, catalogCache.js and catalog.js on SQLite; only
// the Cache API is a stand-in.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const L = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
  strip(read("functions/_lib/catalogCache.js")) + "\n" + strip(read("functions/api/catalog.js")) + `\nreturn { createProduct, createBlank, setBlankLink, insertOrder, publishShop, addProductFile,
  _resetCatalogCacheState, _resetShopStock, catalogGet: onRequestGet };`)();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// A stand-in for the Cache API (caches.default).
function freshCacheApi() {
  const store = new Map();
  global.caches = { default: {
    async match(key) { const hit = store.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { store.set(typeof key === "string" ? key : key.url, response); },
  } };
  return store;
}
// The database, logging each query's SQL; `down` makes the stock reads fail.
function spying(d1) {
  const s = { log: [], down: false };
  const STOCK = /ready_to_ship|order_items|product_blank_links|product_files|blank_sizes/;
  const wrap = (st, sql) => ({ bind: (...a) => wrap(st.bind(...a), sql),
    all: async () => { if (s.down && STOCK.test(sql)) throw new Error("D1 down"); return st.all(); },
    first: async (c) => { if (s.down && STOCK.test(sql)) throw new Error("D1 down"); return st.first(c); }, run: () => st.run() });
  s.db = { prepare: (sql) => { s.log.push(sql); return wrap(d1.prepare(sql), sql); }, batch: (l) => d1.batch(l) };
  // The stock block's queries: finished stock, set aside, the blanks' links and stock, reservations, files.
  s.stockQueries = (from = 0) => s.log.slice(from).filter(q => STOCK.test(q) && !/catalog_snapshot/.test(q));
  return s;
}

(async () => {
  let now = Date.parse("2026-11-20T12:00:00.000Z");
  const realNow = Date.now;
  Date.now = () => now;
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('oak','oak','Oak Club','t','t',1), ('elm','elm','Elm Club','t','t',1);`);
  const tee = (await L.createBlank(d1, { name: "Plain Tee", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "M", purchasePrice: 3, quantity: 10 }] }] })).id;
  for (const org of ["oak", "elm"]) {
    await L.createProduct(d1, org, { productId: "tee", type: "shirt", name: "Tee", pricingMode: "sized", sizePricing: { M: 20 }, visible: true, noDesignNeeded: true, reorderQr: "none" });
    await L.setBlankLink(d1, org, "tee", "", "M", tee, "Navy", "M");
    await L.createProduct(d1, org, { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true, noBlankNeeded: true, reorderQr: "none" });
    await L.createProduct(d1, org, { productId: "rose", type: "other", name: "Rose design", pricingMode: "flat", flatPrice: 12, visible: true, digital: true, reorderQr: "none" });
    await L.publishShop(d1, org);
  }
  d1._raw.exec(`INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt) VALUES ('oak','cap','',2,'t'), ('elm','cap','',7,'t');`);
  const s = spying(d1), env = { DB: s.db };
  const page = async (org, e = env) => {
    const res = await L.catalogGet({ request: { url: shopOrigin(org) + "/api/catalog" }, env: e });
    const body = JSON.parse(await res.text());
    const p = (id) => (body.catalog.products || []).find(x => x.productId === id || x.id === id) || {};
    return { body, cap: (p("cap").stock || {})[""], tee: ((p("tee").blankStock || {})[""] || {}).M, rose: !!p("rose").id };
  };
  const store = freshCacheApi();

  console.log("=== A second view within 30 seconds reads no stock ===");
  let n = s.log.length;
  let v = await page("oak");
  ok("the first view reads the shop's stock: 2 caps in stock, 10 tees ready to decorate, no download without a file", v.cap === 2 && v.tee === 10 && !v.rose && s.stockQueries(n).length >= 5);
  now += 20000; n = s.log.length;
  v = await page("oak");
  ok("a view 20 seconds later runs none of the stock queries, with the same counts", s.stockQueries(n).length === 0 && v.cap === 2 && v.tee === 10);
  d1._raw.exec(`UPDATE ready_to_ship SET quantity = 0 WHERE orgId = 'oak'`);
  n = s.log.length;
  v = await page("oak");
  ok("…so a change made meanwhile shows only once the 30 seconds are up", v.cap === 2 && s.stockQueries(n).length === 0);
  L._resetShopStock(); n = s.log.length;
  v = await page("oak");
  ok("another isolate (nothing in its memory) is answered from the Cache API, also with no stock queries", s.stockQueries(n).length === 0 && v.cap === 2 &&
    [...store.keys()].some(k => /^https:\/\/shop-stock\.internal\/oak\.[^/]+\/oak$/.test(k)));
  n = s.log.length;
  v = await page("elm");
  ok("another shop is kept apart: Elm reads its own (7 caps)", v.cap === 7 && s.stockQueries(n).length >= 5);
  now += 11000; n = s.log.length;
  v = await page("oak");
  ok("after 30 seconds the stock is read again, and the change shows", v.cap === 0 && s.stockQueries(n).length >= 5);

  console.log("\n=== What isn't kept ===");
  now += 31000; s.down = true;
  const ce = console.error; console.error = () => {};
  v = await page("oak");
  console.error = ce;
  ok("when the stock can't be read the page still loads, without badges", v.body.status === "ok" && v.cap === undefined && v.tee === undefined);
  s.down = false; n = s.log.length;
  v = await page("oak");
  ok("…and that isn't kept: the next view reads again", s.stockQueries(n).length >= 5 && v.tee === 10);
  await L.addProductFile(d1, "oak", "rose", { fileKey: "digital/oak/rose/" + "a".repeat(32) + ".dst", fileName: "rose.dst", fileExt: "dst", bytes: 12 });
  now += 31000;
  v = await page("oak");
  ok("a digital product with a file is shown (its files are read with the stock)", v.rose);
  const src = read("functions/api/catalog.js");
  ok("an admin's draft preview always reads fresh (fresh: preview), and nothing else reads the kept copy", /readShopStock_\(env, orgId, \{ host: url\.host, wantFiles, fresh: preview,/.test(src) &&
    ["functions/api/checkout.js", "functions/api/orders.js", "functions/_lib/db.js", "functions/_lib/catalogCache.js", "src/worker.js"].every(f => !/readShopStock_|shop-stock\.internal/.test(read(f))));

  console.log("\n=== Placing an order checks the database, not the kept counts ===");
  d1._raw.exec(`UPDATE ready_to_ship SET quantity = 2 WHERE orgId = 'oak' AND productId = 'cap'`);
  now += 31000;
  v = await page("oak");
  ok("the page shows 2 caps in stock and keeps that", v.cap === 2);
  await L.insertOrder(d1, { orderId: "OAK-1", orgId: "oak", customerName: "Pat Example", contact: "pat@example.test", placedAt: "2026-11-20T12:00:00.000Z" },
    [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 2, unitPrice: 15 }], { fillFromStock: true });
  ok("an order takes both from stock", d1.q("SELECT fromStock FROM order_items WHERE orderId='OAK-1'")[0].fromStock === 1);
  ok("…the page still shows the kept 2 (within 30 seconds)", (await page("oak")).cap === 2);
  await L.insertOrder(d1, { orderId: "OAK-2", orgId: "oak", customerName: "Sam Example", contact: "sam@example.test", placedAt: "2026-11-20T12:00:05.000Z" },
    [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 15 }], { fillFromStock: true });
  ok("…but the next order isn't filled from stock: the database has none left for it", d1.q("SELECT fromStock FROM order_items WHERE orderId='OAK-2'")[0].fromStock === 0);

  console.log("\n=== The blanks' links are read by blank ===");
  const steps = (sql, ...b) => d1.q("EXPLAIN QUERY PLAN " + sql, ...b).map(r => String(r.detail));
  const links = steps("SELECT orgId, productId, productColor, productSize, blankId, blankColor, blankSize FROM product_blank_links WHERE blankId IN (SELECT value FROM json_each(?))", "[1]");
  ok("the links of the shop's blanks are searched on idx_prod_blank_link_blank, not read through every shop's", links.some(t => /SEARCH product_blank_links USING INDEX idx_prod_blank_link_blank \(blankId=\?\)/.test(t)) &&
    !links.some(t => /^SCAN product_blank_links/.test(t)) || (console.log("   plan:", links), false));
  const exists = steps(`SELECT oi.id FROM order_items oi WHERE EXISTS (SELECT 1 FROM product_blank_links bl WHERE bl.orgId = oi.orgId AND bl.productId = oi.productId AND bl.blankId IN (SELECT value FROM json_each(?)))`, "[1]");
  ok("…the open lines' check by blank can use it too", exists.some(t => /product_blank_links|bl\b/.test(t) && /USING (COVERING )?INDEX (idx_prod_blank_link_blank|idx_prod_blank_link|sqlite_autoindex)/.test(t)));
  const dbJs = read("functions/_lib/db.js");
  ok("db.js still reads them that way (getBlankReservations)", dbJs.includes(`FROM product_blank_links\${only ? " WHERE blankId IN (SELECT value FROM json_each(?))" : ""}`));
  const line = /CREATE INDEX IF NOT EXISTS idx_prod_blank_link_blank ON product_blank_links\(blankId, blankColor, blankSize\);/;
  ok("migration 0109 and schema.sql both create the index", line.test(read("migrations/0109_growth_indexes.sql")) && line.test(read("schema.sql")));

  Date.now = realNow;
  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test309 crashed: false"); process.exit(1); });
