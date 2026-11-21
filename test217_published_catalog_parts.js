const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// A shop's published catalog in parts (migrations/0225) and one read of it per order (priceLookups).
// Publish keeps the shop's row in catalog_snapshots and its products rows in catalog_snapshot_parts, each part
// under about 1 MB, so a large catalog never passes D1's limit for one value; a snapshot published before 0225
// (one value with every product) is still read as it is. Pricing a cart reads the published shop once, not once
// per line — and the same cart is charged exactly the same, whichever way the snapshot is stored and read.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const exportsList = `\nreturn { priceItem, priceLookups, publishShop, getCatalogSnapshot, getPublishedOrg, createProduct, createTransfer,
  createGraphic, setTierPrices, setOrgReorderQr, getPublishState };`;
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + exportsList)();
// The same code with small parts (2 KB), so a handful of products spreads over several.
const smallParts = new Function(dbSrc.replace("const SNAPSHOT_PART_BYTES_ = 1000000;", "const SNAPSHOT_PART_BYTES_ = 2000;") + exportsList)();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

const freshDb = async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
};
// Counts the statements a call prepares (each is one D1 query).
const counting = (d1) => {
  const sqls = [];
  return { sqls, db: { prepare: (sql) => { sqls.push(sql); return d1.prepare(sql); }, batch: (s) => d1.batch(s) } };
};

(async () => {
  const d1 = await freshDb();
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('maple','maple','Maple Club','t','t',1);`);
  const tLock = await lib.createTransfer(d1, { name: "Crest sheet" });
  const tQr = await lib.createTransfer(d1, { name: "Reorder sheet" });
  const gCrest = await lib.createGraphic(d1, "maple", { name: "Crest", kind: "transfer", transferId: tLock, tier: "medium", inkColors: ["White", "Gold"] });
  const gBig = await lib.createGraphic(d1, "maple", { name: "Big mark", kind: "transfer", transferId: tLock, tier: "large" });
  await lib.setTierPrices(d1, "maple", { small: 1, medium: 2.5, large: 4 });
  d1._raw.exec(`UPDATE orgs SET reorderQrTransferId=${tQr} WHERE orgId='maple'`);
  await lib.createProduct(d1, "maple", { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true,
    personalizationPrice: 5, reorderQr: "none" });
  await lib.createProduct(d1, "maple", { productId: "hood", type: "shirt", name: "Club Hood", pricingMode: "sized", sizePricing: { S: 40, M: 40, XL: 44.5 }, visible: true, noDesignNeeded: true, reorderQr: "none" });
  await lib.createProduct(d1, "maple", { productId: "rag", type: "shirt", name: "Raglan", pricingMode: "flat", flatPrice: 18, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Navy", "Grey"], reorderQr: "default",
    locations: [{ key: "front", label: "Front", graphicIds: [gCrest, gBig] }, { key: "back", label: "Back", graphicIds: [gCrest] }] });
  // Long descriptions, so the shop's products come to a few KB each.
  for (let i = 1; i <= 12; i++) {
    await lib.createProduct(d1, "maple", { productId: "extra" + i, type: "shirt", name: "Extra " + i, pricingMode: "flat", flatPrice: 10 + i, visible: true,
      noDesignNeeded: true, reorderQr: "none" });
    d1._raw.exec(`UPDATE products SET sub='${"Soft cotton, made to order. ".repeat(40)}' WHERE productId='extra${i}'`);
  }
  const cart = [
    ["tee", "OSFA", 2, true, null],
    ["hood", "XL", 1, false, null],
    ["hood", "M", 3, false, null],
    ["rag", "L", 1, false, { garmentColor: "Navy", locations: { front: { graphicId: gBig }, back: { graphicId: gCrest, ink: "Gold" } } }],
    ["rag", "M", 2, false, { garmentColor: "Grey", locations: { front: { graphicId: gCrest, ink: "White" } } }],
    ["extra7", "OSFA", 1, false, null],
  ];
  const priceCart = async (L, db, lookups) => Promise.all(cart.map(([pid, size, qty, pers, cfg]) =>
    L.priceItem(db || d1, "maple", pid, size, qty, pers, cfg, lookups ? { lookups } : {})));
  const expected = [[20, 5], [44.5, 0], [40, 0], [18 + 4 + 2.5, 0], [18 + 2.5, 0], [17, 0]];
  const sameAsExpected = (priced) => priced.every((p, i) => p.unitPrice === expected[i][0] && p.personalizationFee === expected[i][1]);

  console.log("=== The cart's prices, live (never published) ===");
  const live = await priceCart(lib);
  ok("each line is charged what the catalog says", sameAsExpected(live));
  ok("…the configurable line keeps its picks and the reorder QR", live[3].config.locations.map(l => l.location).join() === "front,back,reorderqr");

  console.log("\n=== Publish writes the products in parts ===");
  const r = await smallParts.publishShop(d1, "maple", "owner@example.test");
  const head = JSON.parse(d1.q("SELECT json FROM catalog_snapshots WHERE orgId='maple'")[0].json);
  const parts = d1.q("SELECT part, json FROM catalog_snapshot_parts WHERE orgId='maple' ORDER BY part");
  ok("the shop's row says how many parts, and holds no products itself", head.org && head.org.orgId === "maple" && !("products" in head) && head.parts === parts.length && r.products === 15);
  ok("the products spread over several parts, each within the part size", parts.length > 3 && parts.every(p => Buffer.byteLength(p.json) <= 2000 || JSON.parse(p.json).length === 1));
  const snap = await lib.getCatalogSnapshot(d1, "maple");
  const liveRows = d1.q("SELECT * FROM products WHERE orgId='maple' ORDER BY productId");
  ok("read back, the snapshot is every products row, in order, exactly as stored", JSON.stringify(snap.products) === JSON.stringify(liveRows) && snap.publishedBy === "owner@example.test");
  ok("the published shop reads as published (current)", (await lib.getPublishState(d1)).maple.state === "current");
  const published = await priceCart(lib);
  ok("the same cart is charged exactly the same from the published parts", sameAsExpected(published) && JSON.stringify(published) === JSON.stringify(live));
  // A draft edit isn't charged until it's published.
  d1._raw.exec(`UPDATE products SET flatPriceCents=9900 WHERE productId='tee'`);
  ok("an unpublished edit isn't charged", (await lib.priceItem(d1, "maple", "tee", "OSFA", 1, false)).unitPrice === 20);
  // Publishing again with fewer parts leaves none of the old ones behind.
  d1._raw.exec(`UPDATE products SET flatPriceCents=2000 WHERE productId='tee'`);
  await lib.publishShop(d1, "maple");
  ok("a second Publish (normal part size) replaces the parts: one now", d1.q("SELECT count(*) AS n FROM catalog_snapshot_parts WHERE orgId='maple'")[0].n === 1 &&
    JSON.parse(d1.q("SELECT json FROM catalog_snapshots WHERE orgId='maple'")[0].json).parts === 1);
  ok("…and still charges the same", sameAsExpected(await priceCart(lib)));

  console.log("\n=== A snapshot published before 0225 is read as it is ===");
  const legacy = JSON.stringify({ org: d1.q("SELECT * FROM orgs WHERE orgId='maple'")[0], products: liveRows });
  await d1.prepare("UPDATE catalog_snapshots SET json=? WHERE orgId='maple'").bind(legacy).run();
  d1._raw.exec(`DELETE FROM catalog_snapshot_parts`);
  const old = await lib.getCatalogSnapshot(d1, "maple");
  ok("its products come from the one value", old && old.products.length === 15 && old.org.orgId === "maple");
  ok("…and the same cart is charged exactly the same", sameAsExpected(await priceCart(lib)) && sameAsExpected(await priceCart(lib, null, lib.priceLookups())));
  ok("…and the shop is still published, not served live", (await lib.getPublishState(d1)).maple.state === "current");

  console.log("\n=== Parts missing: an error, never the unpublished draft ===");
  await smallParts.publishShop(d1, "maple");
  d1._raw.exec(`DELETE FROM catalog_snapshot_parts WHERE part = 1`);
  let threw = false;
  try { await lib.priceItem(d1, "maple", "tee", "OSFA", 1, false); } catch (e) { threw = !e.userFacing && /incomplete/.test(e.message); }
  ok("pricing refuses (an internal error) rather than charging the draft", threw);
  ok("the order checks see no shop rather than the draft", (await lib.getPublishedOrg(d1, "maple")) === null);
  await lib.publishShop(d1, "maple");

  console.log("\n=== A database before 0225 publishes as before ===");
  const d0 = await freshDb();
  d0._raw.exec(`DROP TABLE catalog_snapshot_parts; INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('maple','maple','Maple Club','t','t',1);`);
  await lib.createProduct(d0, "maple", { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, reorderQr: "none" });
  await lib.publishShop(d0, "maple");
  const one = JSON.parse(d0.q("SELECT json FROM catalog_snapshots WHERE orgId='maple'")[0].json);
  ok("the whole shop in one value, and it reads and prices", Array.isArray(one.products) && one.products.length === 1 &&
    (await lib.priceItem(d0, "maple", "tee", "OSFA", 1, false)).unitPrice === 20);

  console.log("\n=== A large catalog: no value near D1's 2 MB limit ===");
  const big = await freshDb();
  big._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('north','north','North Team','t','t',1);`);
  for (let i = 0; i < 40; i++) {
    await lib.createProduct(big, "north", { productId: "p" + i, type: "shirt", name: "Item " + i, pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true, reorderQr: "none" });
  }
  big._raw.exec(`UPDATE products SET sub='${"x".repeat(80000)}'`);   // 40 × 80 KB ≈ 3.2 MB of products
  await lib.publishShop(big, "north");
  const sizes = big.q("SELECT length(json) AS n FROM catalog_snapshot_parts WHERE orgId='north'").map(r => r.n);
  ok("the catalog (over 3 MB) is published in parts of at most 1 MB", sizes.reduce((a, b) => a + b, 0) > 3000000 && sizes.every(n => n <= 1000000) && sizes.length >= 4);
  ok("…the shop's own value is small", big.q("SELECT length(json) AS n FROM catalog_snapshots WHERE orgId='north'")[0].n < 5000);
  ok("…and every product reads back", (await lib.getCatalogSnapshot(big, "north")).products.length === 40 && (await lib.priceItem(big, "north", "p39", "OSFA", 1, false)).unitPrice === 15);

  console.log("\n=== One order reads the published shop once (priceLookups) ===");
  await smallParts.publishShop(d1, "maple");
  const without = counting(d1);
  const a = await priceCart(lib, without.db);
  const withLk = counting(d1), lookups = lib.priceLookups();
  const org = await lib.getPublishedOrg(withLk.db, "maple", lookups);
  const b = await priceCart(lib, withLk.db, lookups);
  const snapReads = (c) => c.sqls.filter(q => /FROM catalog_snapshots/.test(q)).length;
  const partReads = (c) => c.sqls.filter(q => /FROM catalog_snapshot_parts/.test(q)).length;
  ok("without it every line reads the snapshot (6 lines, 6 reads)", snapReads(without) === 6 && partReads(without) === 6);
  ok("with it the shop's row and products are read once for the whole order", snapReads(withLk) === 1 && partReads(withLk) === 1 && org && org.orgId === "maple");
  ok("…tier prices, graphics and the reorder QR transfer once each", withLk.sqls.filter(q => /SELECT \* FROM orgs WHERE orgId/.test(q)).length === 1 &&
    withLk.sqls.filter(q => /FROM graphics WHERE id/.test(q)).length === 2 && withLk.sqls.filter(q => /FROM transfers WHERE id/.test(q)).length === 1);
  ok("…fewer queries in all", withLk.sqls.length < without.sqls.length / 2);
  ok("…and every line is priced exactly the same", JSON.stringify(a) === JSON.stringify(b) && sameAsExpected(b));
  let refused = false;
  try { await lib.priceItem(d1, "maple", "gone", "OSFA", 1, false, null, { lookups }); } catch (e) { refused = !!e.userFacing; }
  ok("a product not in the published shop is still refused with lookups", refused);
  // A shop never published is priced from its live rows, with or without lookups.
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('birch','birch','Birch Club','t','t',1);`);
  await lib.createProduct(d1, "birch", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 12, visible: true, noDesignNeeded: true, reorderQr: "none" });
  const lk2 = lib.priceLookups();
  ok("a never-published shop is priced live with lookups too", (await lib.priceItem(d1, "birch", "cap", "OSFA", 1, false, null, { lookups: lk2 })).unitPrice === 12 &&
    (await lib.getPublishedOrg(d1, "birch", lk2)).name === "Birch Club");

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); console.log("test crashed:", false); process.exit(1); });
