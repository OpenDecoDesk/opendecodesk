const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

// Phase 5 (decoration types, the one Run order, outside digitizing, quote price helpers): the branches of functions/_lib/db.js
// the other phase 5 tests leave out, driven one by one against real SQL (sql.js):
//   - an error that is not "no such column / table" is passed on, never swallowed by the before-migration guards (the
//     product's and graphic's decoration type, a vendor's Digitizes tick, the order types, the other printed cards, a
//     digitizing list)
//   - the reorder QR of a plain product when its transfer or graphic is hidden or gone, and the type it carries when shown
//   - a shop with no name, a line with no size, no colour, no due date, a location with no label, a custom
//     image with no file name, and a blank with no name: the cards and the paid-unrun list fall back to words, not nulls
//   - a line that holds no transfer location at all (not JSON, or a plain snapshot) is not a DTF card
//   - a product with no printed transfers on file still gets its own type's card
//   - average run time on the Pricing analysis, the order column on an expense, the fundraiser tie and the receipt group
//     on a new expense, a digitizing row with empty columns
// Invented data only (Example Club, pat@example.com). No date depends on today or on this machine's time zone.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + `\nreturn { insertOrder, createProduct, createBlank, setBlankLink, createGraphic, createTransfer, saveVendor,
  getRunQueue, getTransferQueue, getPaidUnrunOrders, makeDecoratedLine, priceItem, analyzePricing, saveExpense, getExpense, listExpenses,
  insertExpenses, saveExpenseCategory, listDigitizingJobs, getAllOrgs };`)();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

// A database that fails the statements matching `re` with `message` (not a missing column or table), and answers the rest as usual.
function failing(db, re, message) {
  const boom = () => { const s = { bind: () => s, run: async () => { throw new Error(message); }, all: async () => { throw new Error(message); }, first: async () => { throw new Error(message); } }; return s; };
  return new Proxy(db, { get(t, k) { if (k === "prepare") return (sql) => (re.test(sql) ? boom() : t.prepare(sql)); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
}
// A database whose answer to the statements matching `re` has no results list at all.
function noResults(db, re) {
  const empty = () => { const s = { bind: () => s, run: async () => ({}), all: async () => ({}), first: async () => null }; return s; };
  return new Proxy(db, { get(t, k) { if (k === "prepare") return (sql) => (re.test(sql) ? empty() : t.prepare(sql)); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
}
const migrationFiles = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function freshDb() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrationFiles) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t'), ('nameless','nameless','','t','t');`);
  return d1;
}

(async () => {
  const d1 = await freshDb();
  const q = (sql, ...p) => d1.q(sql, ...p);
  const flat = (org, productId, extra = {}) => lib.createProduct(d1, org, Object.assign({ productId, type: "shirt", name: "Tee " + productId, pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, noBlankNeeded: true, reorderQr: "none" }, extra));
  const orders = { n: 0 };
  async function order(id, org, items, sets = {}) {
    await lib.insertOrder(d1, { orderId: id, orgId: org, customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-10-01T00:00:00Z" }, items);
    for (const [k, v] of Object.entries(Object.assign({ paid: 1 }, sets))) q(`UPDATE orders SET ${k}=? WHERE orderId=?`, v, id);
    return Number(q("SELECT id FROM order_items WHERE orderId=? ORDER BY id", id)[0].id);
  }
  const line = (productId, config, extra = {}) => Object.assign({ productId, name: "Item " + productId, type: "shirt", size: "L", qty: 2, unitPrice: 20, ...(config ? { config } : {}) }, extra);

  console.log("=== An error that is not a missing column or table is passed on ===");
  {
    await flat("club", "ctl");
    const e1 = await rejects(lib.createProduct(failing(d1, /UPDATE products SET decorationType/, "disk full"), "club", { productId: "x1", type: "shirt", name: "X1", pricingMode: "flat", flatPrice: 20, decorationType: "vinyl" }));
    ok("saving a product's decoration type fails with the database's own error, not silently", !!e1 && e1.message === "disk full");
    await lib.createProduct(d1, "club", { productId: "x2", type: "shirt", name: "X2", pricingMode: "flat", flatPrice: 20, decorationType: "vinyl" });
    ok("the same save on a working database stores the type", q("SELECT decorationType t FROM products WHERE productId='x2'")[0].t === "vinyl");
    const g1 = await rejects(lib.createGraphic(failing(d1, /UPDATE graphics SET decoration/, "disk full"), "club", { name: "Crest", kind: "transfer", decoration: "screenprint" }));
    ok("saving a graphic's printed type fails with the database's own error", !!g1 && g1.message === "disk full");
    const v1 = await rejects(lib.saveVendor(failing(d1, /UPDATE vendors SET forDigitizing/, "disk full"), { name: "Example Digitizing Co", forDigitizing: true }));
    ok("saving a vendor's Digitizes tick fails with the database's own error", !!v1 && v1.message === "disk full");
    await order("E1", "club", [line("ctl", { garmentColor: "Navy", locations: [{ location: "front", kind: "transfer", decoration: "screenprint" }] })]);
    ok("the paid-unrun list passes on a failing order-types query", ((await rejects(lib.getPaidUnrunOrders(failing(d1, /pDecorationType[\s\S]*json_each/, "disk full")))) || {}).message === "disk full");
    ok("the paid-unrun list on a working database has that order (so the failure above was the query's)", (await lib.getPaidUnrunOrders(d1)).some(o => o.orderId === "E1"));
    ok("the Run order passes on a failing cards query", ((await rejects(lib.getRunQueue(failing(d1, /pDecorationType(?![\s\S]*json_each)/, "disk full")))) || {}).message === "disk full");
    ok("the digitizing list passes on a failing query", ((await rejects(lib.listDigitizingJobs(failing(d1, /FROM digitizing_jobs/, "disk full"), { orderId: "E1" }))) || {}).message === "disk full");
    ok("and treats an answer with no results list as no jobs", same(await lib.listDigitizingJobs(noResults(d1, /FROM digitizing_jobs/), { orderId: "E1" }), []));
  }

  console.log("\n=== The reorder QR of a plain product ===");
  {
    const t1 = await lib.createTransfer(d1, { name: "Example QR sheet" });
    const gShown = await lib.createGraphic(d1, "club", { name: "QR print", kind: "transfer", transferId: t1, decoration: "screenprint", visible: true });
    const gHidden = await lib.createGraphic(d1, "club", { name: "QR hidden", kind: "transfer", transferId: t1, visible: false });
    q("UPDATE graphics SET visible=0 WHERE id=?", gHidden);
    await flat("club", "qrt", { reorderQr: "t" + t1 });
    await flat("club", "qrgone", { reorderQr: "t987654" });
    await flat("club", "qrg", { reorderQr: String(gShown) });
    await flat("club", "qrgh", { reorderQr: String(gHidden) });
    await flat("club", "qrgmissing", { reorderQr: "987654" });
    const locs = async (p) => ((await lib.priceItem(d1, "club", p, "L", 1, false, null)).config || { locations: [] }).locations;
    const shownT = await locs("qrt");
    ok("a visible transfer is the product's reorder QR line, printed as DTF", shownT.length === 1 && shownT[0].location === "reorderqr" && shownT[0].transferId === t1 && shownT[0].decoration === "dtf");
    q("UPDATE transfers SET visible=0 WHERE id=?", t1);
    ok("the same transfer hidden leaves no reorder QR line", same(await locs("qrt"), []));
    ok("a transfer that is not there leaves none either", same(await locs("qrgone"), []));
    const shownG = await locs("qrg");
    ok("a visible graphic chosen the old way is the line, with the graphic's own printed type", shownG.length === 1 && shownG[0].graphicId === gShown && shownG[0].decoration === "screenprint");
    ok("a hidden graphic leaves no reorder QR line", same(await locs("qrgh"), []));
    ok("a graphic that is not there leaves none", same(await locs("qrgmissing"), []));
  }

  console.log("\n=== A shop with no name, a line with nothing filled in ===");
  {
    // A blank with no name, colour or type, linked at no colour or size.
    const blankId = (await lib.createBlank(d1, { name: "Placeholder", productType: "shirt" })).id;
    q("UPDATE blanks SET name='', color='', productType='' WHERE id=?", blankId);
    for (const p of ["dtfp", "spp"]) {
      await flat("nameless", p, { noBlankNeeded: false });
      q("INSERT INTO product_blank_links (orgId, productId, productColor, productSize, blankId, blankColor, blankSize) VALUES ('nameless', ?, '', '', ?, '', '')", p, blankId);
    }
    const dtfItem = await order("S1", "nameless", [line("dtfp", { locations: [{ location: "front", kind: "transfer", decoration: "dtf", graphicName: "Crest" }] }, { size: "" })], { dueDate: null });
    q("UPDATE orders SET placedAt='' WHERE orderId='S1'");
    const spItem = await order("S2", "nameless", [line("spp", { locations: [{ location: "front", kind: "transfer", decoration: "screenprint" },
      { location: "back", kind: "transfer", decoration: "screenprint", custom: true }, { location: "sleeve", kind: "transfer", decoration: "dtf", label: "Sleeve", graphicName: "Other" }] }, { size: "", qty: 1 })], { dueDate: null });
    q("UPDATE orders SET placedAt='' WHERE orderId='S2'");
    const tq = await lib.getTransferQueue(d1);
    const dtf = tq.ready.concat(tq.waiting).find(c => c.orderId === "S1");
    ok("a DTF card for a line with no colour, size or dates says empty words for them", !!dtf && dtf.garmentColor === "" && dtf.itemSize === "" && dtf.dueDate === "" && dtf.placedAt === "");
    ok("…its shop shows by its id when it has no name", dtf.orgName === "nameless");
    ok("…its blank with no name, colour, size or type shows empty words", same(dtf.blank, { id: blankId, name: "", color: "", size: "", productType: "" }));
    ok("…its location falls back to the location's own word", dtf.transfers.length === 1 && dtf.transfers[0].location === "front" && dtf.transfers[0].graphicName === "Crest");
    const rq = await lib.getRunQueue(d1);
    const card = rq.other.ready.concat(rq.other.waiting).find(c => c.orderId === "S2");
    ok("the screen print card of a line with nothing filled in says empty words", !!card && card.type === "screenprint" && card.garmentColor === "" && card.itemSize === "" &&
      card.dueDate === "" && card.placedAt === "");
    ok("…its shop shows by its id", card.orgName === "nameless");
    ok("…its blank with no name shows empty words", same(card.blank, { id: blankId, name: "", color: "", size: "", productType: "" }));
    ok("…its locations are the screen printed ones, a missing label falling back to the location and a missing graphic name to nothing, a custom image with no file to empty words",
      same(card.locations, [{ location: "front", graphicName: "", ink: "", imageUrl: "", thumbUrl: "" },
        { location: "back", graphicName: "", ink: "", imageUrl: "", thumbUrl: "", custom: true, fileKey: "", fileName: "" }]));
    const paid = (await lib.getPaidUnrunOrders(d1)).find(o => o.orderId === "S2");
    ok("the paid-unrun list names that shop by its id and gives the order's types", !!paid && paid.orgName === "nameless" && same(paid.types, ["dtf", "screenprint"]));
    const made = await lib.makeDecoratedLine(d1, "S2", spItem, "2026-10-09T10:00:00.000Z");
    ok("Mark made on that line makes its one piece and completes the order", made.orderComplete === true && Number(q("SELECT manufacturedQty m FROM order_items WHERE id=?", spItem)[0].m) === 1);
    ok("…and the card is gone", !(await lib.getRunQueue(d1)).other.ready.concat((await lib.getRunQueue(d1)).other.waiting).some(c => c.orderId === "S2"));
    void dtfItem;
  }

  console.log("\n=== Lines that are not DTF, and a product with no printed transfers on file ===");
  {
    await flat("club", "lp");
    await order("N1", "club", [line("lp", null, { configJson: "" })]);
    const bad = await order("N2", "club", [line("lp")]);
    q("UPDATE order_items SET configJson='not json at all' WHERE id=?", bad);
    const plain = await order("N3", "club", [line("lp")]);
    q("UPDATE order_items SET configJson='{\"plain\":true}' WHERE id=?", plain);
    const tq = await lib.getTransferQueue(d1);
    const listed = tq.ready.concat(tq.waiting).map(c => c.orderId);
    ok("a line whose snapshot is not JSON, and a plain one with no locations, are not DTF cards (and do not break the list)", !listed.includes("N2") && !listed.includes("N3") && !listed.includes("N1"));
    await flat("club", "vp", { decorationType: "vinyl" });
    q("UPDATE products SET fixedTransfersJson='null' WHERE productId='vp'");
    await order("V1", "club", [line("vp", null)]);
    const rq = await lib.getRunQueue(d1);
    const vc = rq.other.ready.concat(rq.other.waiting).find(c => c.orderId === "V1");
    ok("a line with no locations on a vinyl product with no printed transfers on file is a vinyl card", !!vc && vc.type === "vinyl" && same(vc.locations, []) && vc.garmentColor === "");
    ok("…and the order lists vinyl as its type", same((await lib.getPaidUnrunOrders(d1)).find(o => o.orderId === "V1").types, ["vinyl"]));
  }

  console.log("\n=== The Pricing analysis: average run time ===");
  {
    await flat("club", "timed", { runMinutes: 12 });
    const itemId = await order("R1", "club", [line("timed", null, { qty: 1 })]);
    const before = (await lib.analyzePricing(d1, { orgId: "club", productId: "timed" })).products[0];
    ok("a product never run has no average", before.avgRunMinutes === null && before.avgRunPieces === 0);
    q("INSERT INTO production_runs (orgId, orderId, itemId, startedAt, finishedAt, status, createdAt, pieceNo, stepNo, timed) VALUES ('club','R1',?,?,?,'done','t',1,1,1)", itemId, "2026-10-02T10:00:00Z", "2026-10-02T10:14:00Z");
    const after = (await lib.analyzePricing(d1, { orgId: "club", productId: "timed" })).products[0];
    ok("one timed piece of 14 minutes is its average", after.avgRunMinutes === 14 && after.avgRunPieces === 1);
  }

  console.log("\n=== Expenses: the order, the fundraiser tie and the receipt group ===");
  {
    const cat = await lib.saveExpenseCategory(d1, null, { name: "Example supplies", deductionType: "deductible", scheduleCLine: "22", deductiblePct: 100, useTaxable: false });
    const base = { date: "2026-10-05", description: "Example purchase", categoryId: cat, amount: 12.5, vendor: "Sample Supply", businessUsePct: 100 };
    const plainId = await lib.saveExpense(d1, null, base);
    ok("an expense recorded for no order says an empty word for it", (await lib.getExpense(d1, plainId)).orderId === "");
    const forOrder = await lib.saveExpense(d1, null, Object.assign({}, base, { orderId: "O-77" }));
    ok("an expense recorded for an order keeps it", (await lib.getExpense(d1, forOrder)).orderId === "O-77");
    const tied = await lib.saveExpense(d1, null, Object.assign({}, base, { fundraiserOrgId: "club", receiptGroup: "group-one" }));
    ok("a payout to a shop's fundraiser is tied to the shop and keeps its receipt group", (await lib.getExpense(d1, tied)).fundraiserOrgId === "club" &&
      q("SELECT receiptGroup g FROM expenses WHERE id=?", tied)[0].g === "group-one");
    const batch = await lib.insertExpenses(d1, [Object.assign({}, base, { receiptGroup: "g".repeat(80) }), Object.assign({}, base, { description: "Second" })]);
    ok("an imported batch keeps each row's receipt group, cut to 64 characters, and none where there is none",
      q("SELECT receiptGroup g FROM expenses WHERE id=?", batch[0])[0].g === "g".repeat(64) && q("SELECT receiptGroup g FROM expenses WHERE id=?", batch[1])[0].g === null);
  }

  console.log("\n=== A digitizing row with empty columns ===");
  {
    d1._raw.exec(`INSERT INTO digitizing_jobs (orderId, name, vendor, sentAt, createdAt, createdBy) VALUES ('H-1', '', '', '', '', '');`);
    const [j] = await lib.listDigitizingJobs(d1, { orderId: "H-1" });
    ok("the list gives empty words for a row's empty name, dates and maker, and no ids it never had",
      j.name === "" && j.vendor === "" && j.sentAt === "" && j.returnedAt === "" && j.createdAt === "" && j.createdBy === "" && j.itemId === null && j.designId === null && j.estimateId === null && j.expenseId === null && j.costCents === 0);
  }
})();
