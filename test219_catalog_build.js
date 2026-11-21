const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Building the storefront catalog reads the whole install in one go (catalogPrefetch_ in db.js), not shop by shop:
// the same dozen or so queries whether there are two shops or twenty (D1 caps the queries one request may make). Each
// shop comes out exactly as the shop-by-shop build makes it (getDraftCatalogShop, the admin's preview): products,
// designs, blank weights and color photos, mockups, decorations, graphics and tier prices.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + `\nreturn { createProduct, createTransfer, createGraphic, setTierPrices, publishShop,
  getPublicCatalogData, getDraftCatalogShop };`)();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

const freshDb = async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
};
const counting = (d1) => { const sqls = []; return { sqls, db: { prepare: (q) => { sqls.push(q); return d1.prepare(q); }, batch: (s) => d1.batch(s) } }; };

// One shop with a bit of everything the catalog shows.
async function addShop(d1, orgId, n) {
  d1._raw.exec(`INSERT OR IGNORE INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('${orgId}','${orgId}','Shop ${n}','t','t',1);`);
  const t = await lib.createTransfer(d1, { name: "Sheet " + n });
  const g = await lib.createGraphic(d1, orgId, { name: "Crest " + n, kind: "transfer", transferId: t, tier: "medium", inkColors: ["White"] });
  await lib.setTierPrices(d1, orgId, { small: 1, medium: 2 + n, large: 5 });
  await lib.createProduct(d1, orgId, { productId: "tee", type: "shirt", name: "Tee " + n, pricingMode: "sized", sizePricing: { M: 20, L: 22 }, visible: true, noDesignNeeded: true, reorderQr: "none" });
  await lib.createProduct(d1, orgId, { productId: "rag", type: "shirt", name: "Raglan " + n, pricingMode: "flat", flatPrice: 18, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Navy", "Grey"], reorderQr: "none", locations: [{ key: "front", label: "Front", graphicIds: [g, 1] }] });
  await lib.createProduct(d1, orgId, { productId: "cap", type: "cap", name: "Cap " + n, pricingMode: "flat", flatPrice: 15, visible: true, reorderQr: "none" });
  await lib.createProduct(d1, orgId, { productId: "hidden", type: "cap", name: "Hidden " + n, pricingMode: "flat", flatPrice: 15, visible: false, reorderQr: "none" });
  d1._raw.exec(`
    UPDATE products SET garmentColorsJson='["Navy","Grey"]', fixedTransfersJson='[{"locationId":1,"graphicId":${g},"ink":"White"}]', sortOrder=2 WHERE orgId='${orgId}' AND productId='tee';
    UPDATE products SET mockupGraphicsJson='[{"locationId":2,"graphicId":1}]', sortOrder=1 WHERE orgId='${orgId}' AND productId='cap';
    INSERT INTO designs (orgId, name, createdAt, updatedAt) VALUES ('${orgId}', 'Logo ${n}', 't', 't');
    INSERT INTO product_designs (orgId, productId, designId, placement, sortOrder, createdAt) VALUES ('${orgId}', 'cap', last_insert_rowid(), 'Front', 0, 't');
    INSERT INTO product_blank_links (orgId, productId, productColor, productSize, blankId, blankColor, blankSize) VALUES
      ('${orgId}', 'tee', 'Navy', 'M', 1, 'Navy', 'M'), ('${orgId}', 'tee', 'Navy', 'L', 1, 'Navy', 'L'), ('${orgId}', 'rag', 'Navy', 'L', 2, 'Navy', 'L');
    INSERT INTO product_graphic_images (orgId, productId, locationId, graphicId, garmentColor, imageUrl, createdAt, updatedAt) VALUES
      ('${orgId}', 'rag', 1, ${g}, 'Navy', '/img/rag-${n}.png', 't', 't'), ('${orgId}', 'cap', 2, 1, '', '/img/cap-${n}.png', 't', 't');`);
}

(async () => {
  const build = async (shops, publish) => {
    const d1 = await freshDb();
    d1._raw.exec(`DELETE FROM locations; INSERT INTO locations (id, name, createdAt, updatedAt) VALUES (1, 'Front', 't', 't'), (2, 'Left chest', 't', 't');
      INSERT INTO blanks (id, name, createdAt, updatedAt) VALUES (1, 'Plain Tee', 't', 't'), (2, 'Plain Raglan', 't', 't');
      INSERT INTO blank_colors (blankId, color, imagesJson, createdAt, updatedAt) VALUES (1, 'Navy', '["/img/tee-navy.png"]', 't', 't'), (1, 'Grey', '["/img/tee-grey.png"]', 't', 't'),
        (2, 'Navy', '[{"url":"/img/rag-navy.png","locationId":1}]', 't', 't'), (2, 'Grey', '["/img/rag-grey.png"]', 't', 't');
      INSERT INTO blank_sizes (blankId, color, size, quantity, weightOz) VALUES (1, 'Navy', 'M', 0, 5), (1, 'Navy', 'L', 0, 6), (2, 'Navy', 'L', 0, 7);`);
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('s0','s0','Shop 0','t','t',1);`);
    const t = await lib.createTransfer(d1, { name: "Global sheet" });
    await lib.createGraphic(d1, "s0", { name: "Shared mark", kind: "transfer", transferId: t, tier: "small", isGlobal: true });
    d1._raw.exec(`UPDATE graphics SET isGlobal=1, orgId='s0' WHERE id=1`);
    for (let i = 0; i < shops; i++) await addShop(d1, "s" + i, i);
    for (const i of publish) await lib.publishShop(d1, "s" + i);
    return d1;
  };

  console.log("=== Every shop comes out as the shop-by-shop build makes it ===");
  const d1 = await build(3, [0, 2]);   // s1 never published: served live
  const c = counting(d1);
  const cat = await lib.getPublicCatalogData(c.db);
  for (const org of ["s0", "s1", "s2"]) {
    const one = await lib.getDraftCatalogShop(d1, org);   // nothing changed since Publish, so the draft is the published shop
    ok(`${org}: the same shop, products, photos, mockups, decorations and graphics`, JSON.stringify(cat.orgs[org]) === JSON.stringify(one));
  }
  const tee = cat.orgs.s1.products.find(p => p.productId === "tee"), cap = cat.orgs.s1.products.find(p => p.productId === "cap"), rag = cat.orgs.s1.products.find(p => p.productId === "rag");
  ok("…the data is really there (not two empty answers agreeing)", tee.colorImages.Navy[0] === "/img/tee-navy.png" && tee.colorImages.Grey[0] === "/img/tee-grey.png" &&
    tee.blankWeightBySize.L === 6 && cap.designs.length === 1 && cap.decorations.some(d => d.name === "Shared mark" && d.location === "Left chest") &&
    tee.decorations.some(d => d.kind === "Printed" && d.name === "Crest 1" && d.location === "Front") && rag.graphicImages && cap.fixedMockups[0].label === "Left chest" &&
    cat.orgs.s1.graphics.map(g => g.name).join() === "Crest 1,Shared mark" && cat.orgs.s1.tierPricesCents.medium === 300 && !cat.orgs.s1.products.some(p => p.productId === "hidden"));
  ok("…in the shop's order, and the subdomains map", cat.orgs.s1.products.map(p => p.productId).join() === "rag,cap,tee" && cat.subdomainMap.s2 === "s2");
  // A draft edit after Publish shows in the preview, not in the published catalog.
  d1._raw.exec(`UPDATE products SET name='Renamed' WHERE orgId='s0' AND productId='tee'`);
  const after = await lib.getPublicCatalogData(d1);
  ok("a published shop's draft edit stays out of the catalog; a never-published shop is live",
    after.orgs.s0.products.find(p => p.productId === "tee").name === "Tee 0" && (await lib.getDraftCatalogShop(d1, "s0")).products.find(p => p.productId === "tee").name === "Renamed");

  console.log("\n=== The number of queries doesn't grow with the number of shops ===");
  const few = counting(await build(2, [0])), many = counting(await build(12, [0, 1, 2, 3, 4, 5]));
  const a = await lib.getPublicCatalogData(few.db), b = await lib.getPublicCatalogData(many.db);
  ok("2 shops and 12 shops take the same number of queries", Object.keys(a.orgs).length === 2 && Object.keys(b.orgs).length === 12 && few.sqls.length === many.sqls.length);
  ok("…well under D1's 50 a request", many.sqls.length <= 25);
  ok("…and every one of the 12 is built", Object.values(b.orgs).every(o => o.products.length === 3 && o.graphics.length === 2));

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); console.log("test crashed:", false); process.exit(1); });
