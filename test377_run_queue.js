const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { makeAuth, prelude, strip, read, request, answer } = require("./testlib/auth-harness");

// Phase 5, the Run order's server side (migrations/0118): one page's worth of work for every decoration type.
//   getRunQueue (db.js)           embroidery is getProductionQueue's answer; transfers are DTF only (with placedAt); the other
//                                 printed types (screen print, vinyl, DTG, sublimation) get one card per line and type, with
//                                 every card field; counts per type; due date (none last) then order date; the lines left
//                                 out; blank received vs waiting; a database from before 0118 answers no other cards
//   getTransferQueue              no longer lists a screen print pick; cards carry placedAt
//   getPaidUnrunOrders            each order's decoration types
//   setDecorationStarted          set, clear, unknown line, cancelled line
//   makeDecoratedLine             a line that is not embroidered is made (every piece, blanks used, order complete); an
//                                 embroidered one only records its printing; idempotent; errors
//   /api/orders                   getRunQueue's answer by role, who may start and make, the audit rows, the Production
//                                 feature switch on these and the five transfer actions
// Real SQL (sql.js), the real db.js and orders.js behind the real sign-in. Invented data only; no date depends on today.
global.fetch = async (url) => { throw new Error("unexpected fetch " + url); };
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, createHoop, createThread, saveDesign, addDesignVersion, setProductDesign,
  createProduct, setBlankLink, createBlank, receiveBlanks, getProductionQueue, getRunQueue, getTransferQueue, getPaidUnrunOrders,
  setDecorationStarted, makeDecoratedLine, createTransfer, receiveTransferSheet, createGraphic, saveLocation, priceItem };`)();
const roles_ = require("./testlib/roles");
const ordersJsSrc = read("functions/api/orders.js");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ids = (list) => (list || []).map(c => c.orderId);
const migrationFiles = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function freshDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrationFiles) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t'), ('boost','boost','Example Boosters','t','t');`);
  return d1;
}
const CARD_KEYS = "blank,blankReceived,customerName,customerOwned,dueDate,embroideryDone,garmentColor,hasEmbroidery,itemId,itemName,itemSize,locations,orderId,orgId,orgName,placedAt,qty,started,type";   // customerOwned: phase 7, the line is on the customer's own garment
const loc = (decoration, label, extra = {}) => ({ location: label.toLowerCase(), label, kind: decoration === "embroidery" ? "embroidery" : "transfer", decoration,
  graphicName: "Crest " + label, ink: "Red", ...extra });

(async () => {
  console.log("=== getRunQueue: the work of every decoration type, from the real SQL ===");
  const d1 = await freshDb();
  const q = (sql, ...p) => d1.q(sql, ...p);
  // Products: a plain tee with a blank in stock, a tee that needs no blank, a vinyl tee (its own type, no locations on its
  // lines), a cap with an embroidery design, and a digital download.
  for (const p of [["tee", "Tee"], ["nbtee", "Plain Tee"], ["vtee", "Vinyl Tee"], ["cap", "Cap"]])
    await lib.createProduct(d1, "club", { productId: p[0], type: p[0] === "cap" ? "cap" : "shirt", name: p[1], pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: p[0] !== "cap", noBlankNeeded: p[0] === "nbtee" });
  q("UPDATE products SET decorationType='vinyl' WHERE productId='vtee'");
  const blankId = (await lib.createBlank(d1, { name: "Example Tee Blank", brand: "Sample", color: "Navy", productType: "shirt" })).id;
  await lib.setBlankLink(d1, "club", "tee", "Navy", "L", blankId, "Navy", "L");
  await lib.setBlankLink(d1, "club", "vtee", "", "L", blankId, "Navy", "L");
  await lib.receiveBlanks(d1, { blankId, lines: [{ color: "Navy", size: "L", qty: 30, unitCost: 3 }], vendor: "", receivedAt: "2026-09-01T12:00:00.000Z" });
  const hoop = await lib.createHoop(d1, { name: "Cap Frame", isCapFrame: true });
  const thread = await lib.createThread(d1, { brand: "Example", type: "Poly", weight: "40", code: "100", name: "Red", colorHex: "cc2222" });
  const designId = await lib.saveDesign(d1, "club", { name: "Club Logo", stabilizer: "cutaway", hoopId: hoop });
  await lib.addDesignVersion(d1, designId, { designFileKey: "d/a.emb", designFileName: "a.emb", designFileExt: "emb", machineFileKey: "d/a.dst", machineFileName: "a.dst", machineFileExt: "dst",
    threadColors: [{ needle: 1, threadId: thread }] });
  await lib.setProductDesign(d1, "club", "cap", designId);

  let n = 0;
  // One order, one line: `sets` are order columns, `item` overrides the line.
  async function order(id, { org = "club", product = "tee", qty = 2, config = undefined, placedAt = "2026-10-01T00:00:00Z", due = null, sets = {}, item = {}, extra = [] } = {}) {
    const cfg = config === undefined ? { garmentColor: "Navy", locations: [loc("screenprint", "Front")] } : config;
    await lib.insertOrder(d1, { orderId: id, orgId: org, customerName: "Cust " + id, contact: id + "@example.com", placedAt },
      [Object.assign({ productId: product, name: "Item " + id, type: "shirt", size: "L", qty, unitPrice: 20, ...(cfg ? { config: cfg } : {}) }, item), ...extra]);
    const all = Object.assign({ paid: 1, dueDate: due }, sets);
    for (const [k, v] of Object.entries(all)) q(`UPDATE orders SET ${k}=? WHERE orderId=?`, v, id);
    return Number(q("SELECT id FROM order_items WHERE orderId=? ORDER BY id", id)[0].id);
  }
  const rq = () => lib.getRunQueue(d1);
  const otherAll = async () => { const o = (await rq()).other; return o.ready.concat(o.waiting); };
  const cardOf = async (id, type) => (await otherAll()).find(c => c.orderId === id && (!type || c.type === type));

  // ---- a screen print line: every field of the card
  const sp = await order("SP1", { due: "2026-11-05", sets: { blankReceivedAt: "2026-10-03T00:00:00Z" },
    config: { garmentColor: "Navy", locations: [loc("screenprint", "Front", { imageUrl: "/img/f.png", thumbUrl: "/img/f-t.png" }),
      loc("screenprint", "Back", { custom: true, fileKey: "up/back.png", fileName: "back.png" }), loc("dtf", "Sleeve")] } });
  let r = await rq();
  const card = r.other.ready.find(c => c.orderId === "SP1");
  ok("a paid screen print line with its blank received is a ready card on the other cards (not waiting)", !!card && !r.other.waiting.some(c => c.orderId === "SP1"));
  ok("the card has exactly the documented fields", !!card && Object.keys(card).sort().join(",") === CARD_KEYS);
  ok("…its type, line, order, shop, customer, size, quantity, colour and dates are the line's",
    card.type === "screenprint" && card.itemId === sp && card.orderId === "SP1" && card.orgId === "club" && card.orgName === "Example Club" &&
    card.customerName === "Cust SP1" && card.itemName === "Item SP1" && card.itemSize === "L" && card.qty === 2 && card.garmentColor === "Navy" &&
    card.dueDate === "2026-11-05" && card.placedAt === "2026-10-01T00:00:00Z");
  ok("…it is not started, not embroidered, and its blank is the linked blank in the line's colour and size",
    card.started === false && card.hasEmbroidery === false && card.embroideryDone === false && card.blankReceived === true &&
    same(card.blank, { id: blankId, name: "Example Tee Blank", color: "Navy", size: "L", productType: "shirt" }));
  ok("…its locations are only the screen printed ones (the DTF sleeve is left to the DTF card), in the line's words, with a customer's own image marked",
    same(card.locations, [{ location: "Front", graphicName: "Crest Front", ink: "Red", imageUrl: "/img/f.png", thumbUrl: "/img/f-t.png" },
      { location: "Back", graphicName: "Crest Back", ink: "Red", imageUrl: "", thumbUrl: "", custom: true, fileKey: "up/back.png", fileName: "back.png" }]));
  ok("the same line's DTF sleeve is on the transfer queue (DTF cards), not the other cards", ids((await rq()).transfers.ready.concat(r.transfers.waiting)).includes("SP1") && r.other.ready.every(c => c.type !== "dtf"));
  ok("the answer carries the types the shop does (embroidery and DTF on a new install) and the counts for all six keys",
    same(r.types, ["embroidery", "dtf"]) && same(Object.keys(r.counts), ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"]));

  // ---- a card for each other type
  await order("VN1", { config: { garmentColor: "Navy", locations: [loc("vinyl", "Front")] } });
  await order("DG1", { config: { garmentColor: "Navy", locations: [loc("dtg", "Chest")] } });
  await order("SB1", { config: { garmentColor: "Navy", locations: [loc("sublimation", "Back")] } });
  ok("a vinyl, a DTG and a sublimation line each get a card of their own type",
    (await cardOf("VN1")).type === "vinyl" && (await cardOf("DG1")).type === "dtg" && (await cardOf("SB1")).type === "sublimation");
  ok("…with only that type's location on it", (await cardOf("DG1")).locations.length === 1 && (await cardOf("DG1")).locations[0].location === "Chest");
  ok("…and none of them is on the transfer queue (DTF only)", !ids((await rq()).transfers.ready.concat((await rq()).transfers.waiting)).some(o => ["VN1", "DG1", "SB1"].includes(o)));
  const tq = await lib.getTransferQueue(d1);
  ok("a DTF card's blank carries the blank's product type too, as the other cards' and the embroidery cards' do (so Order by Blank groups it with them)",
    same(tq.ready.concat(tq.waiting).find(c => c.orderId === "SP1").blank, { id: blankId, name: "Example Tee Blank", color: "Navy", size: "L", productType: "shirt" }));
  ok("getTransferQueue no longer lists a screen print pick: the screen print line's DTF sleeve only", tq.ready.concat(tq.waiting).filter(c => c.orderId === "SP1").every(c => c.transfers.length === 1 && c.transfers[0].location === "Sleeve"));
  await order("SPONLY", {});
  ok("…and a line with only screen print picks is not on it at all", !ids(tq.ready.concat(tq.waiting)).includes("SPONLY") && !ids((await lib.getTransferQueue(d1)).ready.concat((await lib.getTransferQueue(d1)).waiting)).includes("SPONLY"));

  // ---- a product's fixed printed transfer takes its graphic's type, so the line is routed by it
  {
    const sheet = await lib.createTransfer(d1, { name: "Example Fixed Sheet" });
    const place = await lib.saveLocation(d1, { name: "Back" });
    const gSp = await lib.createGraphic(d1, "club", { name: "Fixed screen mark", kind: "transfer", transferId: sheet, decoration: "screenprint" });
    const gDtf = await lib.createGraphic(d1, "club", { name: "Fixed DTF mark", kind: "transfer", transferId: sheet });
    for (const [id, g] of [["fxsp", gSp], ["fxdtf", gDtf]])
      await lib.createProduct(d1, "club", { productId: id, type: "shirt", name: "Fixed " + id, pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, reorderQr: "none", fixedTransfers: [{ locationId: place, graphicId: g }] });
    await lib.setBlankLink(d1, "club", "fxsp", "", "L", blankId, "Navy", "L");
    await lib.setBlankLink(d1, "club", "fxdtf", "", "L", blankId, "Navy", "L");
    const fxCfg = async (id) => (await lib.priceItem(d1, "club", id, "L", 2, false, { garmentColor: "Navy" })).config;
    const spCfg = await fxCfg("fxsp"), dtfCfg = await fxCfg("fxdtf");
    ok("a fixed transfer's order-line entry carries its graphic's type (screen print), and a DTF graphic's stays DTF", spCfg.locations[0].fixed === true && spCfg.locations[0].decoration === "screenprint" && dtfCfg.locations[0].fixed === true && dtfCfg.locations[0].decoration === "dtf");
    await order("FXSP", { product: "fxsp", config: spCfg, sets: { blankReceivedAt: "2026-10-03T00:00:00Z" } });
    await order("FXDTF", { product: "fxdtf", config: dtfCfg, sets: { blankReceivedAt: "2026-10-03T00:00:00Z" } });
    const rr = await rq(), tIds = ids(rr.transfers.ready.concat(rr.transfers.waiting));
    const fc = await cardOf("FXSP");
    ok("a line whose fixed transfer is screen printed is a screen print card on the Run order (with that location), not a DTF card", !!fc && fc.type === "screenprint" && fc.locations.length === 1 && fc.locations[0].graphicName === "Fixed screen mark" && !tIds.includes("FXSP"));
    ok("…while a DTF fixed transfer is still a DTF card and has no other card", tIds.includes("FXDTF") && !(await cardOf("FXDTF")));
  }

  // ---- a line with no locations takes its product's own type
  await order("PRD1", { product: "vtee", config: null });
  const pc = await cardOf("PRD1");
  ok("a line with no locations on a vinyl product gets a vinyl card from the product's own type, with no locations or colour",
    !!pc && pc.type === "vinyl" && pc.locations.length === 0 && pc.garmentColor === "" && same(pc.blank, { id: blankId, name: "Example Tee Blank", color: "Navy", size: "L", productType: "shirt" }));
  await order("DTFONLY", { product: "nbtee", config: null });
  ok("…a no-design product's plain line is DTF: no other card", !(await otherAll()).some(c => c.orderId === "DTFONLY"));

  // ---- two types on one line
  await order("TWO", { config: { garmentColor: "Navy", locations: [loc("screenprint", "Front"), loc("vinyl", "Back")] } });
  const two = (await otherAll()).filter(c => c.orderId === "TWO");
  ok("a line with two types gives two cards, one per type, in registry order", same(two.map(c => c.type), ["screenprint", "vinyl"]) && two[0].itemId === two[1].itemId);
  ok("…each lists only its own type's location", two[0].locations.length === 1 && two[0].locations[0].location === "Front" && two[1].locations[0].location === "Back");

  // ---- an embroidered and printed line
  const capCfg = { garmentColor: "Navy", locations: [loc("embroidery", "Cap front", { designId }), loc("screenprint", "Cap side")] };
  const emb = await order("EMB", { product: "cap", config: capCfg, item: { type: "cap", size: "OSFA" }, sets: { blankReceivedAt: "2026-10-03T00:00:00Z", designApprovedAt: "2026-10-04T00:00:00Z" } });
  let ec = await cardOf("EMB");
  ok("an embroidered and printed line has a card for its printing, flagged as embroidered and not yet made", !!ec && ec.type === "screenprint" && ec.hasEmbroidery === true && ec.embroideryDone === false);
  ok("…it is also on the embroidery list (and its embroidered location is not on the card)", ids((await rq()).embroidery).includes("EMB") && ec.locations.length === 1 && ec.locations[0].location === "Cap side");
  r = await rq();
  ok("the embroidery list is exactly getProductionQueue's answer", same(r.embroidery, await lib.getProductionQueue(d1)) && Array.isArray(r.embroidery) && r.embroidery.length >= 1);
  q("UPDATE order_items SET manufacturedQty=2 WHERE id=?", emb);
  ec = await cardOf("EMB");
  ok("once its embroidery is finished the card still waits for the printing, and says the embroidery is done", !!ec && ec.hasEmbroidery === true && ec.embroideryDone === true);
  q("UPDATE order_items SET decMadeAt='2026-10-10T00:00:00Z' WHERE id=?", emb);
  ok("…and with the printing marked made (and the pieces made) it leaves", !(await cardOf("EMB")));
  q("UPDATE order_items SET manufacturedQty=0 WHERE id=?", emb);
  ok("…and an embroidered line whose printing is marked made leaves even though its embroidery is not finished (like DTF's transfersAppliedAt)", !(await cardOf("EMB")));
  q("UPDATE order_items SET decMadeAt=NULL WHERE id=?", emb);
  ok("…but with the printing not marked made it is still listed, embroidery finished or not", !!(await cardOf("EMB")));
  q("UPDATE order_items SET manufacturedQty=2 WHERE id=?", emb);
  ok("…even with its embroidery finished", !!(await cardOf("EMB")));
  q("UPDATE order_items SET manufacturedQty=0, decMadeAt='2026-10-10T00:00:00Z' WHERE id=?", emb);

  // ---- counts
  r = await rq();
  const tally = {}; for (const c of r.other.ready.concat(r.other.waiting)) tally[c.type] = (tally[c.type] || 0) + 1;
  ok("counts for the other types are the number of cards of that type", ["screenprint", "vinyl", "dtg", "sublimation"].every(k => r.counts[k] === (tally[k] || 0)) && r.counts.screenprint >= 3);
  ok("…embroidery is the length of the embroidery list and dtf the transfer cards, ready and waiting", r.counts.embroidery === r.embroidery.length && r.counts.dtf === r.transfers.ready.length + r.transfers.waiting.length && r.counts.dtf >= 1);
  ok("…a line with two types is counted once under each", (await otherAll()).filter(c => c.orderId === "TWO").length === 2 && r.counts.vinyl === r.other.ready.concat(r.other.waiting).filter(c => c.type === "vinyl").length);

  // ---- the lines left out
  const out = [];
  const gone = async (id, opts, why) => { await order(id, opts); const hit = (await otherAll()).some(c => c.orderId === id); out.push([why, !hit]); };
  await gone("O-UNPAID", { sets: { paid: 0 } }, "an order not paid for");
  await gone("O-TEST", { sets: { isTest: 1 } }, "a test order");
  await gone("O-VOID", { sets: { voidedAt: "2026-10-02T00:00:00Z" } }, "a voided order");
  await gone("O-DONE", { sets: { completedAt: "2026-10-02T00:00:00Z" } }, "a completed order");
  await gone("O-SHIP", { sets: { shippedAt: "2026-10-02T00:00:00Z" } }, "a shipped order");
  await gone("O-DELIV", { sets: { deliveredAt: "2026-10-02T00:00:00Z" } }, "a delivered order");
  { const sid = await order("O-STOCK", {}); q("UPDATE order_items SET fromStock=1 WHERE id=?", sid); out.push(["a line filled from finished stock", !(await otherAll()).some(c => c.orderId === "O-STOCK")]); }
  await gone("O-MADE", { sets: { manufacturedAt: "2026-10-02T00:00:00Z" } }, "an order already made");
  const cancelled = await order("O-CANCEL", {});
  q("UPDATE order_items SET cancelDate='2026-10-02' WHERE id=?", cancelled);
  out.push(["a cancelled line", !(await otherAll()).some(c => c.orderId === "O-CANCEL")]);
  const partly = await order("O-ALLMADE", {});
  q("UPDATE order_items SET manufacturedQty=2 WHERE id=?", partly);
  out.push(["a line whose pieces are all made (not embroidered)", !(await otherAll()).some(c => c.orderId === "O-ALLMADE")]);
  for (const [why, left] of out) ok(why + " is left out", left);
  await order("O-PFW", { sets: { paid: 0, paidForWork: 1 } });
  await order("O-POD", { sets: { paid: 0, payOnDelivery: 1 } });
  ok("an order paid for the work (rush fee owing) or set to pay on delivery is cleared for work, so listed", !!(await cardOf("O-PFW")) && !!(await cardOf("O-POD")));
  ok("a line with one piece of two made is still listed", !!(await (async () => { const i = await order("O-HALF", {}); q("UPDATE order_items SET manufacturedQty=1 WHERE id=?", i); return cardOf("O-HALF"); })()));

  // ---- blank received vs waiting
  await order("B-ORDER", { sets: { blankReceivedAt: "2026-10-03T00:00:00Z" } });
  await order("B-NONE", {});
  const lineRecv = await order("B-LINE", {}); q("UPDATE order_items SET blankReceivedAt='2026-10-03T00:00:00Z' WHERE id=?", lineRecv);
  await order("B-NOBLANK", { product: "nbtee" });
  r = await rq();
  var where = (id) => r.other.ready.some(c => c.orderId === id) ? "ready" : r.other.waiting.some(c => c.orderId === id) ? "waiting" : "none";
  ok("blank received on the order → ready", where("B-ORDER") === "ready");
  ok("blank not received → waiting, and its card says blankReceived false", where("B-NONE") === "waiting" && !r.other.waiting.find(c => c.orderId === "B-NONE").blankReceived);
  ok("blank received on the line alone → ready", where("B-LINE") === "ready");
  ok("a product that needs no blank → ready without one (and no blank on the card)", where("B-NOBLANK") === "ready" && r.other.ready.find(c => c.orderId === "B-NOBLANK").blank === null);
  ok("…a line with a blank linked at its size has it on the card", same(r.other.waiting.find(c => c.orderId === "B-NONE").blank, { id: blankId, name: "Example Tee Blank", color: "Navy", size: "L", productType: "shirt" }));
  await order("B-NOLINK", { item: { size: "XL" } });
  r = await rq();
  ok("a line whose size has no blank link waits with a null blank", where("B-NOLINK") === "waiting" && r.other.waiting.find(c => c.orderId === "B-NOLINK").blank === null);
  ok("ready is the cards with blankReceived true, waiting the ones with false", r.other.ready.every(c => c.blankReceived) && r.other.waiting.every(c => !c.blankReceived));

  // ---- order of the cards
  const d2 = await freshDb();
  await lib.createProduct(d2, "club", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, noBlankNeeded: true });
  const o2 = async (id, due, placedAt, product = "tee") => {
    await lib.insertOrder(d2, { orderId: id, orgId: "club", customerName: id, contact: "c@example.com", placedAt },
      [{ productId: product, name: "T", type: "shirt", size: "L", qty: 1, unitPrice: 20, config: { garmentColor: "Navy", locations: [loc("dtg", "Front")] } }]);
    d2.q("UPDATE orders SET paid=1, dueDate=? WHERE orderId=?", due, id);
  };
  await lib.createProduct(d2, "club", { productId: "tee2", type: "shirt", name: "Tee 2", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  await o2("N-LATE-OLD", null, "2026-09-01T00:00:00Z");
  await o2("D-NOV-2", "2026-11-02", "2026-10-05T00:00:00Z");
  await o2("N-LATE-NEW", null, "2026-10-09T00:00:00Z");
  await o2("D-NOV-1-NEW", "2026-11-01", "2026-10-08T00:00:00Z");
  await o2("D-NOV-1-OLD", "2026-11-01", "2026-10-02T00:00:00Z");
  r = await lib.getRunQueue(d2);
  ok("the cards are in due date order, an order with no due date after every dated one, then by order date (oldest first)",
    same(ids(r.other.ready), ["D-NOV-1-OLD", "D-NOV-1-NEW", "D-NOV-2", "N-LATE-OLD", "N-LATE-NEW"]));
  await o2("W-NONE", null, "2026-10-01T00:00:00Z", "tee2");
  await o2("W-B", "2026-11-03", "2026-10-01T00:00:00Z", "tee2");
  await o2("W-A", "2026-11-02", "2026-10-02T00:00:00Z", "tee2");
  r = await lib.getRunQueue(d2);
  ok("…and the same order inside waiting (blank not received)", same(ids(r.other.waiting), ["W-A", "W-B", "W-NONE"]) && same(ids(r.other.ready).slice(0, 2), ["D-NOV-1-OLD", "D-NOV-1-NEW"]));
  await o2("S-SAME", "2026-11-01", "2026-10-02T00:00:00Z");
  r = await lib.getRunQueue(d2);
  ok("two lines with the same due and order date keep the order they were entered", ids(r.other.ready).slice(0, 3).join() === "D-NOV-1-OLD,S-SAME,D-NOV-1-NEW");

  // ---- a database from before 0118
  const old = await freshDb("0118");
  await lib.createProduct(old, "club", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  await lib.insertOrder(old, { orderId: "OLD1", orgId: "club", customerName: "Cust", contact: "c@example.com", placedAt: "2026-10-01T00:00:00Z" },
    [{ productId: "tee", name: "T", type: "shirt", size: "L", qty: 1, unitPrice: 20, config: { garmentColor: "Navy", locations: [loc("screenprint", "Front")] } }]);
  old.q("UPDATE orders SET paid=1 WHERE orderId='OLD1'");
  const oldR = await lib.getRunQueue(old);
  ok("before migrations/0118 the other cards are empty (no error), and the rest of the answer is there",
    same(oldR.other, { ready: [], waiting: [] }) && Array.isArray(oldR.embroidery) && Array.isArray(oldR.transfers.ready) && oldR.counts.screenprint === 0);
  ok("…the same line on a migrated database does give its card (so the empty answer is the fallback's)", ids((await lib.getRunQueue(d2)).other.ready).length > 0);
  const oldPaid = await lib.getPaidUnrunOrders(old);
  ok("…and getPaidUnrunOrders still lists the order, with no types", oldPaid.length === 1 && same(oldPaid[0].types, []));
  const oldTransfer = await lib.getTransferQueue(old);
  ok("…getTransferQueue on it still answers", Array.isArray(oldTransfer.ready) && Array.isArray(oldTransfer.waiting));

  // ---- a transfer line: DTF only, with placedAt
  const d3 = await freshDb();
  const sheet = await lib.createTransfer(d3, { name: "Example Crest DTF" });
  await lib.createProduct(d3, "club", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, noBlankNeeded: true });
  const dtfLoc = (decoration) => { const l = { location: "front", label: "Front", kind: "transfer", graphicName: "Crest", ink: "", transferId: sheet }; if (decoration) l.decoration = decoration; return l; };
  const o3 = async (id, locs, placed) => { await lib.insertOrder(d3, { orderId: id, orgId: "club", customerName: id, contact: "c@example.com", placedAt: placed },
    [{ productId: "tee", name: "T", type: "shirt", size: "L", qty: 1, unitPrice: 20, config: { garmentColor: "Navy", locations: locs } }]); d3.q("UPDATE orders SET paid=1 WHERE orderId=?", id); };
  await o3("DTF-NEW", [dtfLoc("dtf")], "2026-10-02T00:00:00Z");
  await o3("DTF-OLD", [dtfLoc()], "2026-10-03T00:00:00Z");
  await o3("DTF-AND-VINYL", [dtfLoc("dtf"), loc("vinyl", "Back")], "2026-10-04T00:00:00Z");
  await o3("VINYL-ONLY", [loc("vinyl", "Back")], "2026-10-05T00:00:00Z");
  r = await lib.getRunQueue(d3);
  const dtfCards = r.transfers.ready.concat(r.transfers.waiting);
  ok("the transfer cards are the DTF lines only: a location marked dtf, one from before 0118 with no type, and a line with DTF and vinyl",
    same(ids(dtfCards).sort(), ["DTF-AND-VINYL", "DTF-NEW", "DTF-OLD"]));
  ok("…each DTF card carries its order date (placedAt)", dtfCards.every(c => c.placedAt === { "DTF-NEW": "2026-10-02T00:00:00Z", "DTF-OLD": "2026-10-03T00:00:00Z", "DTF-AND-VINYL": "2026-10-04T00:00:00Z" }[c.orderId]));
  ok("…the DTF and vinyl line's DTF card holds only the DTF transfer, and its vinyl is a card on the other list", dtfCards.find(c => c.orderId === "DTF-AND-VINYL").transfers.length === 1 &&
    same(ids(r.other.ready.concat(r.other.waiting)), ["DTF-AND-VINYL", "VINYL-ONLY"]));
  ok("getTransferQueue's answer is the transfers part of the run queue", same(r.transfers, await lib.getTransferQueue(d3)) && r.counts.dtf === 3 && r.counts.vinyl === 2);

  console.log("\n=== getPaidUnrunOrders: each order's decoration types ===");
  const pu = await lib.getPaidUnrunOrders(d1);
  const typesOf = (id) => (pu.find(o => o.orderId === id) || {}).types;
  ok("an order's types are what its live lines are decorated with: screen print and DTF on the first order, in registry order", same(typesOf("SP1"), ["dtf", "screenprint"]));
  ok("…two types on one line are both listed, in registry order", same(typesOf("TWO"), ["screenprint", "vinyl"]));
  ok("…an embroidered and printed line lists embroidery and screen print", same(typesOf("EMB"), ["embroidery", "screenprint"]));
  ok("…a line with no locations takes its product's type", same(typesOf("PRD1"), ["vinyl"]) && same(typesOf("DTFONLY"), ["dtf"]));
  const m = await order("MIXED", { config: { garmentColor: "Navy", locations: [loc("dtg", "Front")] }, extra: [
    { productId: "tee", name: "Second", type: "shirt", size: "L", qty: 1, unitPrice: 20, config: { garmentColor: "Navy", locations: [loc("sublimation", "Back")] } },
    { productId: "tee", name: "Third", type: "shirt", size: "L", qty: 1, unitPrice: 20, config: { garmentColor: "Navy", locations: [loc("vinyl", "Back")] } }] });
  q("UPDATE order_items SET cancelDate='2026-10-02' WHERE orderId='MIXED' AND name='Third'");
  const pu2 = await lib.getPaidUnrunOrders(d1);
  ok("a cancelled line's type is not counted", same(pu2.find(o => o.orderId === "MIXED").types, ["dtg", "sublimation"]));
  ok("every row has a types list", pu2.every(o => Array.isArray(o.types)));

  console.log("\n=== setDecorationStarted ===");
  const line = await order("ST1", {});
  q("UPDATE order_items SET decStartedAt=NULL WHERE id=?", line);
  const startedOf = () => q("SELECT decStartedAt s FROM order_items WHERE id=?", line)[0].s;
  await lib.setDecorationStarted(d1, "ST1", line, true, "2026-10-06T08:30:00.000Z");
  ok("Start stamps the line with the time it is given", startedOf() === "2026-10-06T08:30:00.000Z");
  ok("…and the card says it is started", (await cardOf("ST1")).started === true);
  await lib.setDecorationStarted(d1, "ST1", line, false);
  ok("Undo clears it, and the card is not started again", startedOf() === null && (await cardOf("ST1")).started === false);
  await lib.setDecorationStarted(d1, "ST1", line);
  ok("Start with no time given stamps the current time (a real timestamp)", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(startedOf()));
  await lib.setDecorationStarted(d1, "ST1", line, true, "2026-10-07T00:00:00.000Z");
  ok("Start again moves the stamp to the new time", startedOf() === "2026-10-07T00:00:00.000Z");
  const throwsMsg = async (fn) => { try { await fn(); return ""; } catch (e) { return String(e && e.message); } };
  ok("a line that doesn't exist is refused: Line item not found", await throwsMsg(() => lib.setDecorationStarted(d1, "ST1", 99999, true)) === "Line item not found");
  ok("a line of another order is refused the same way", await throwsMsg(() => lib.setDecorationStarted(d1, "SP1", line, true)) === "Line item not found" && startedOf() === "2026-10-07T00:00:00.000Z");
  q("UPDATE order_items SET cancelDate='2026-10-08' WHERE id=?", line);
  ok("a cancelled line is refused: That line item is cancelled (and Undo is too)", await throwsMsg(() => lib.setDecorationStarted(d1, "ST1", line, true)) === "That line item is cancelled" &&
    await throwsMsg(() => lib.setDecorationStarted(d1, "ST1", line, false)) === "That line item is cancelled" && startedOf() === "2026-10-07T00:00:00.000Z");

  console.log("\n=== makeDecoratedLine ===");
  const onHand = () => Number(q("SELECT COALESCE(SUM(qtyDelta),0) s FROM inventory_movements WHERE blankId=?", blankId)[0].s);
  const consumes = (itemId) => q("SELECT COALESCE(SUM(-qtyDelta),0) s FROM inventory_movements WHERE kind='consume' AND itemId=?", itemId)[0].s;
  const rowOf = (itemId) => q("SELECT manufacturedQty mq, decMadeAt d FROM order_items WHERE id=?", itemId)[0];
  const orderMade = (id) => q("SELECT manufacturedAt m FROM orders WHERE orderId=?", id)[0].m;
  const mk = await order("MK1", { qty: 3, config: { garmentColor: "Navy", locations: [loc("screenprint", "Front")] } });
  const stock0 = onHand();
  let res = await lib.makeDecoratedLine(d1, "MK1", mk, "2026-10-09T10:00:00.000Z");
  ok("a line that is not embroidered: every piece is made, and the order is complete", same(res, { orderComplete: true }) && rowOf(mk).mq === 3 && orderMade("MK1") === "2026-10-09T10:00:00.000Z");
  ok("…its printing is marked made, at the time given", rowOf(mk).d === "2026-10-09T10:00:00.000Z");
  ok("…the blanks come out of stock (3 pieces)", consumes(mk) === 3 && onHand() === stock0 - 3);
  ok("…the card is gone from the Run order", !(await cardOf("MK1")));
  res = await lib.makeDecoratedLine(d1, "MK1", mk, "2026-10-11T00:00:00.000Z");
  ok("doing it again changes nothing: alreadyDone, the order not newly complete, no more blanks, the first stamp kept",
    same(res, { alreadyDone: true, orderComplete: false }) && consumes(mk) === 3 && rowOf(mk).d === "2026-10-09T10:00:00.000Z" && orderMade("MK1") === "2026-10-09T10:00:00.000Z");
  const partial = await order("MK2", { qty: 3 });
  q("UPDATE order_items SET manufacturedQty=1 WHERE id=?", partial);
  res = await lib.makeDecoratedLine(d1, "MK2", partial);
  ok("a line with one piece already made makes only the rest (two more blanks used)", res.orderComplete === true && rowOf(partial).mq === 3 && consumes(partial) === 2);
  ok("…with no time given, the stamps are real timestamps", /^\d{4}-/.test(rowOf(partial).d) && /^\d{4}-/.test(orderMade("MK2")));
  const multi = await order("MK3", { qty: 1, extra: [{ productId: "tee", name: "Second line", type: "shirt", size: "L", qty: 1, unitPrice: 20, config: { garmentColor: "Navy", locations: [loc("vinyl", "Back")] } }] });
  res = await lib.makeDecoratedLine(d1, "MK3", multi, "2026-10-09T10:00:00.000Z");
  ok("on an order with another line still to make, orderComplete is false and the order is not marked made", res.orderComplete === false && orderMade("MK3") === null && rowOf(multi).mq === 1);
  const madeNotMarked = await order("MK4", { qty: 2 });
  q("UPDATE order_items SET manufacturedQty=2 WHERE id=?", madeNotMarked);
  res = await lib.makeDecoratedLine(d1, "MK4", madeNotMarked, "2026-10-09T11:00:00.000Z");
  ok("a line whose pieces are all made but whose printing was never marked: alreadyDone, and the printing is marked now, no blanks used",
    same(res, { alreadyDone: true, orderComplete: false }) && rowOf(madeNotMarked).d === "2026-10-09T11:00:00.000Z" && consumes(madeNotMarked) === 0);

  // embroidered
  const bw = onHand();
  const em2 = await order("EM2", { product: "cap", config: capCfg, item: { type: "cap", size: "OSFA" } });
  res = await lib.makeDecoratedLine(d1, "EM2", em2, "2026-10-09T12:00:00.000Z");
  ok("an embroidered line only has its printing recorded: applied, the order not complete", same(res, { applied: true, orderComplete: false }));
  ok("…no piece is made and no blank used (Run order makes it when the embroidery is finished)", rowOf(em2).mq === 0 && orderMade("EM2") === null && onHand() === bw && rowOf(em2).d === "2026-10-09T12:00:00.000Z");
  res = await lib.makeDecoratedLine(d1, "EM2", em2, "2026-10-12T00:00:00.000Z");
  ok("…again: alreadyDone and applied, the first stamp kept", same(res, { alreadyDone: true, applied: true, orderComplete: false }) && rowOf(em2).d === "2026-10-09T12:00:00.000Z");
  ok("…the embroidered line's card leaves the Run order once its printing is marked done, its embroidery not yet finished", !(await cardOf("EM2")));
  q("UPDATE order_items SET manufacturedQty=2 WHERE id=?", em2);
  ok("…and stays gone when the embroidery is finished too", !(await cardOf("EM2")));

  const cancelled2 = await order("MK5", {}); q("UPDATE order_items SET cancelDate='2026-10-02' WHERE id=?", cancelled2);
  ok("a line that doesn't exist is refused: Line item not found", await throwsMsg(() => lib.makeDecoratedLine(d1, "MK1", 99999)) === "Line item not found");
  ok("a line of another order is refused the same way", await throwsMsg(() => lib.makeDecoratedLine(d1, "MK2", cancelled2)) === "Line item not found");
  ok("a cancelled line is refused: That line item is cancelled, and nothing is made", await throwsMsg(() => lib.makeDecoratedLine(d1, "MK5", cancelled2)) === "That line item is cancelled" && rowOf(cancelled2).mq === 0 && rowOf(cancelled2).d === null);

  await endpoint();
})().catch((e) => { console.error("the file stopped:", e && e.stack || e); process.exit(1); });


async function endpoint() {
  console.log("\n=== /api/orders: getRunQueue, setDecorationStarted and makeDecoratedLine behind the real sign-in ===");
  const STUB = "const getCatalogData = async () => ({ subdomainMap: {}, business: {} });";
  const pre = prelude(false, false);
  if (!pre.includes(STUB)) throw new Error("testlib/auth-harness.js's catalog stand-in changed: update test377");
  const A = await makeAuth();
  const d1 = A.d1;
  const post = new Function("__hits", pre.replace(STUB, "const getCatalogData = async () => ({ subdomainMap: {}, business: {}, features: globalThis.__t377Features || {} });") +
    strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
    "const invalidateCatalogVersionCache = () => {}; const selectBox = () => null;\n" +
    strip(read("functions/_lib/setupStatus.js")) + "\n" + strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" +
    strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")(A.hits);
  const call = async (body, cookie) => {
    const waits = [];
    const res = await post({ request: request("/api/orders", body, { cookie }), env: A.env, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})) });
    await Promise.all(waits);
    return answer(res);
  };
  const logged = async (body, cookie) => { const before = d1.q("SELECT COALESCE(MAX(id), 0) m FROM audit_log")[0].m; const r = await call(body, cookie);
    return { ...r, rows: d1.q("SELECT * FROM audit_log WHERE id > " + before + " ORDER BY id").map(x => ({ ...x, detail: JSON.parse(x.detail || "null") })) }; };
  const forbidden = (r) => r.status === 403 && r.body && r.body.status === "error" && r.body.code === "forbidden";
  const ROLE = "Your role can't do this. Ask an admin.";

  const admin = await A.firstAdmin("Olive Owner", "olive@example.com");
  const manager = await A.addUser(admin, "manager", "Mo Manager", "mo@example.com");
  const staff = await A.addUser(admin, "staff", "Sam Staff", "sam@example.com");
  const prod = await A.addUser(admin, "production", "Pat Production", "pp@example.com");
  const staffRole = (await A.users({ action: "listRoles" }, admin)).body.roles.find(x => x.key === "staff");
  // Made-up roles: only the embroidery half of the page, only the DTF half, neither half (but may mark made), and may see but not mark.
  const mkRole = async (name, email, fns) => {
    const perms = JSON.parse(JSON.stringify(staffRole.permissions));
    Object.assign(perms.fns, fns);
    const key = (await A.users({ action: "saveRole", name, rank: 40, permissions: perms }, admin)).body.role.key;
    return A.addUser(admin, key, name, email);
  };
  const embOnly = await mkRole("Embroidery only", "e1@example.com", { "run.queue": "read", "transfer.queue": "none", "run.markMade": "edit" });
  const dtfOnly = await mkRole("DTF only", "e2@example.com", { "run.queue": "none", "transfer.queue": "read", "run.markMade": "edit" });
  const neither = await mkRole("Neither half", "e3@example.com", { "run.queue": "none", "transfer.queue": "none", "run.markMade": "edit" });
  const viewer = await mkRole("Sees not marks", "e4@example.com", { "run.queue": "read", "transfer.queue": "read", "run.markMade": "read" });
  const me = async (cookie) => (await A.users({ action: "me" }, cookie)).body.permissions;
  ok("the roles under test are what they should be (the one-half roles, the viewer)",
    (await me(embOnly))["transfer.queue"] === "none" && (await me(dtfOnly))["run.queue"] === "none" && (await me(neither))["run.queue"] === "none" && (await me(viewer))["run.markMade"] === "read");

  // The shop: a tee with its blank in stock, a cap with an embroidery design, a transfer sheet.
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t');`);
  for (const [id, type, noDesign] of [["tee", "shirt", true], ["cap", "cap", false]])
    await lib.createProduct(d1, "club", { productId: id, type, name: id === "tee" ? "Tee" : "Cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: noDesign });
  const blank = (await lib.createBlank(d1, { name: "Example Tee Blank", brand: "Sample", color: "Navy", productType: "shirt" })).id;
  await lib.setBlankLink(d1, "club", "tee", "Navy", "L", blank, "Navy", "L");
  await lib.receiveBlanks(d1, { blankId: blank, lines: [{ color: "Navy", size: "L", qty: 40, unitCost: 3 }], vendor: "", receivedAt: "2026-09-01T12:00:00.000Z" });
  const hoop = await lib.createHoop(d1, { name: "Cap Frame", isCapFrame: true });
  const design = await lib.saveDesign(d1, "club", { name: "Club Logo", stabilizer: "cutaway", hoopId: hoop });
  await lib.addDesignVersion(d1, design, { designFileKey: "d/a.emb", designFileName: "a.emb", designFileExt: "emb", machineFileKey: "d/a.dst", machineFileName: "a.dst", machineFileExt: "dst", threadColors: [] });
  await lib.setProductDesign(d1, "club", "cap", design);
  const sheet = await lib.createTransfer(d1, { name: "Example Crest DTF" });
  let k = 0;
  async function put(id, product, locs, { qty = 2, sets = {} } = {}) {
    await lib.insertOrder(d1, { orderId: id, orgId: "club", customerName: "Cust " + id, contact: id + "@example.com", placedAt: "2026-10-01T00:00:00Z" },
      [{ productId: product, name: "Item " + id, type: product === "cap" ? "cap" : "shirt", size: product === "cap" ? "OSFA" : "L", qty, unitPrice: 20, config: { garmentColor: "Navy", locations: locs } }]);
    for (const [c, v] of Object.entries(Object.assign({ paid: 1 }, sets))) d1.q(`UPDATE orders SET ${c}=? WHERE orderId=?`, v, id);
    return Number(d1.q("SELECT id FROM order_items WHERE orderId=?", id)[0].id);
  }
  const printLine = await put("SP", "tee", [loc("screenprint", "Front")], { sets: { blankReceivedAt: "2026-10-03T00:00:00Z" } });
  await put("DTF", "tee", [{ location: "front", label: "Front", kind: "transfer", decoration: "dtf", graphicName: "Crest", ink: "", transferId: sheet }]);
  await put("EMB", "cap", [loc("embroidery", "Cap front", { designId: design }), loc("screenprint", "Cap side")], { sets: { blankReceivedAt: "2026-10-03T00:00:00Z", designApprovedAt: "2026-10-04T00:00:00Z" } });

  // ---- getRunQueue by role
  const KEYS_ALL = "counts,embroidery,needleSizes,other,paidUnrun,status,transfers,types,waitingOnBlanks";
  const full = await call({ action: "getRunQueue" }, admin);
  ok("an Admin gets the whole answer: embroidery (a plain list), transfers, other cards, types, counts, paidUnrun, waitingOnBlanks and needleSizes",
    full.status === 200 && full.body.status === "ok" && Object.keys(full.body).sort().join(",") === KEYS_ALL && Array.isArray(full.body.embroidery) && Array.isArray(full.body.waitingOnBlanks) && Array.isArray(full.body.needleSizes));
  ok("…with the screen print cards, the DTF card, the embroidery card and the counts of each",
    ids(full.body.other.ready).join() === "SP,EMB" && ids(full.body.transfers.ready.concat(full.body.transfers.waiting)).join() === "DTF" && ids(full.body.embroidery).join() === "EMB" &&
    full.body.counts.screenprint === 2 && full.body.counts.dtf === 1 && full.body.counts.embroidery === 1 && full.body.counts.vinyl === 0);
  ok("…paidUnrun rows carry each order's types", same(full.body.paidUnrun.map(o => [o.orderId, o.types]).sort(), [["DTF", ["dtf"]], ["EMB", ["embroidery", "screenprint"]], ["SP", ["screenprint"]]]));
  ok("…and the same answer in the same shape for a Manager, Back office and Production",
    (await Promise.all([manager, staff, prod].map(c => call({ action: "getRunQueue" }, c)))).every(r => r.status === 200 && Object.keys(r.body).sort().join(",") === KEYS_ALL && same(r.body.counts, full.body.counts)));
  const ro = await call({ action: "getRunQueue" }, embOnly);
  ok("a role with the embroidery half only gets embroidery, the waiting blanks and needle sizes, and the other cards — no transfers, and counts.dtf is 0",
    ro.status === 200 && Object.keys(ro.body).sort().join(",") === "counts,embroidery,needleSizes,other,paidUnrun,status,types,waitingOnBlanks" && ro.body.counts.dtf === 0 && ro.body.counts.embroidery === 1 && ro.body.counts.screenprint === 2 && ids(ro.body.other.ready).join() === "SP,EMB");
  const dt = await call({ action: "getRunQueue" }, dtfOnly);
  ok("a role with the DTF half only gets transfers and the other cards — no embroidery, waiting blanks or needle sizes, and counts.embroidery is 0",
    dt.status === 200 && Object.keys(dt.body).sort().join(",") === "counts,other,paidUnrun,status,transfers,types" && dt.body.counts.embroidery === 0 && dt.body.counts.dtf === 1 && ids(dt.body.transfers.ready.concat(dt.body.transfers.waiting)).join() === "DTF" && ids(dt.body.other.ready).join() === "SP,EMB");
  ok("…the other counts are not zeroed for either half", ro.body.counts.vinyl === 0 && dt.body.counts.screenprint === 2);
  const nn = await call({ action: "getRunQueue" }, neither);
  ok("a role with neither half is refused (403, not allowed)", forbidden(nn) && nn.body.message === ROLE);
  ok("signed out it is refused with 401", (await call({ action: "getRunQueue" }, "")).status === 401);

  // ---- setDecorationStarted
  const sd = (extra, cookie = admin) => logged(Object.assign({ action: "setDecorationStarted", orderId: "SP", itemId: printLine }, extra), cookie);
  let r = await sd({});
  ok("Start answers started: true and writes one audit row (order.decoration_started with the line)",
    r.status === 200 && same(r.body, { status: "ok", started: true }) && r.rows.length === 1 && r.rows[0].action === "order.decoration_started" && r.rows[0].orderId === "SP" && same(r.rows[0].detail, { itemId: printLine }));
  ok("…the line is stamped, and its card says started", !!d1.q("SELECT decStartedAt s FROM order_items WHERE id=?", printLine)[0].s &&
    (await call({ action: "getRunQueue" }, admin)).body.other.ready.find(c => c.orderId === "SP").started === true);
  r = await sd({ on: false });
  ok("Undo answers started: false and writes order.decoration_unstarted", same(r.body, { status: "ok", started: false }) && r.rows.length === 1 && r.rows[0].action === "order.decoration_unstarted" &&
    d1.q("SELECT decStartedAt s FROM order_items WHERE id=?", printLine)[0].s === null);
  r = await sd({ at: "2026-10-06T08:30:00.000Z" });
  ok("Start at a time stamps that time", r.status === 200 && d1.q("SELECT decStartedAt s FROM order_items WHERE id=?", printLine)[0].s === "2026-10-06T08:30:00.000Z");
  r = await sd({ at: "2026-10-06" });
  ok("…a date alone is taken as noon that day", r.status === 200 && d1.q("SELECT decStartedAt s FROM order_items WHERE id=?", printLine)[0].s === "2026-10-06T12:00:00.000Z");
  r = await sd({ at: "not a date" });
  ok("a time that isn't a date is refused (400, \"That date and time isn't valid.\") and logs nothing", r.status === 400 && r.body.message === "That date and time isn't valid." && r.rows.length === 0);
  r = await sd({ at: "2999-01-01T00:00:00Z" });
  ok("…one in the future is refused (400)", r.status === 400 && /future/.test(r.body.message) && r.rows.length === 0);
  r = await sd({ at: "2019-01-01T00:00:00Z" });
  ok("…one before 2020 is refused (400)", r.status === 400 && /too far back/.test(r.body.message));
  r = await sd({ on: false, at: "not a date" });
  ok("Undo ignores a time (nothing to date)", r.status === 200 && r.body.started === false);
  r = await sd({ orderId: "" });
  ok("no orderId → 400 \"orderId and itemId required\"", r.status === 400 && r.body.message === "orderId and itemId required" && r.rows.length === 0);
  r = await sd({ itemId: 0 });
  ok("no itemId → the same 400", r.status === 400 && r.body.message === "orderId and itemId required");
  r = await sd({ itemId: 99999 });
  ok("an unknown line → 400 \"Line item not found\", nothing logged", r.status === 400 && r.body.message === "Line item not found" && r.rows.length === 0);
  const cl = await put("CX", "tee", [loc("vinyl", "Front")]);
  d1.q("UPDATE order_items SET cancelDate='2026-10-02' WHERE id=?", cl);
  r = await sd({ orderId: "CX", itemId: cl });
  ok("a cancelled line → 400 \"That line item is cancelled\"", r.status === 400 && r.body.message === "That line item is cancelled" && r.rows.length === 0);
  for (const [who, cookie] of [["Manager", manager], ["Back office", staff], ["Production", prod], ["a role with only Mark made at edit", neither]])
    ok(who + " may start a line (run.markMade at edit)", (await sd({}, cookie)).status === 200);
  r = await sd({}, viewer);
  ok("a role that can see the Run order but only read Mark made is refused (403) and nothing is logged", forbidden(r) && r.body.message === ROLE && r.rows.length === 0);
  ok("signed out → 401", (await sd({}, "")).status === 401);
  ok("run.markMade is the permission, at edit, for both actions", roles_.ACTION_PERM.setDecorationStarted.join() === "run.markMade,edit" && roles_.ACTION_PERM.makeDecoratedLine.join() === "run.markMade,edit");

  // ---- makeDecoratedLine
  const mk = (extra, cookie = admin) => logged(Object.assign({ action: "makeDecoratedLine", orderId: "SP", itemId: printLine }, extra), cookie);
  const stock0 = Number(d1.q("SELECT COALESCE(SUM(qtyDelta),0) s FROM inventory_movements WHERE blankId=?", blank)[0].s);
  ok("a viewer can't mark made, and nothing was made yet", forbidden(await mk({}, viewer)) && Number(d1.q("SELECT manufacturedQty q FROM order_items WHERE id=?", printLine)[0].q) === 0);
  r = await mk({ at: "2026-10-05T10:00:00.000Z" });
  ok("marking a screen printed line made answers orderComplete: true, uses its blanks, and logs order.decoration_made with the line and orderComplete",
    r.status === 200 && same(r.body, { status: "ok", orderComplete: true }) && Number(d1.q("SELECT COALESCE(SUM(qtyDelta),0) s FROM inventory_movements WHERE blankId=?", blank)[0].s) === stock0 - 2 &&
    r.rows.length === 1 && r.rows[0].action === "order.decoration_made" && r.rows[0].orderId === "SP" && same(r.rows[0].detail, { itemId: printLine, orderComplete: true }));
  ok("…the order is made at the time given", d1.q("SELECT manufacturedAt m FROM orders WHERE orderId='SP'")[0].m === "2026-10-05T10:00:00.000Z");
  r = await mk({});
  ok("again: alreadyDone, orderComplete false, and the audit row says alreadyDone", same(r.body, { status: "ok", orderComplete: false, alreadyDone: true }) && r.rows.length === 1 && same(r.rows[0].detail, { itemId: printLine, orderComplete: false, alreadyDone: true }));
  const embLine = Number(d1.q("SELECT id FROM order_items WHERE orderId='EMB'")[0].id);
  r = await mk({ orderId: "EMB", itemId: embLine });
  ok("an embroidered and printed line answers applied: true, orderComplete false, makes no piece, and the audit row says applied",
    same(r.body, { status: "ok", orderComplete: false, applied: true }) && same(r.rows[0].detail, { itemId: embLine, orderComplete: false, applied: true }) &&
    Number(d1.q("SELECT manufacturedQty q FROM order_items WHERE id=?", embLine)[0].q) === 0);
  r = await mk({ orderId: "EMB", itemId: embLine });
  ok("…again: alreadyDone and applied, both in the answer and the audit row", same(r.body, { status: "ok", orderComplete: false, applied: true, alreadyDone: true }) && same(r.rows[0].detail, { itemId: embLine, orderComplete: false, applied: true, alreadyDone: true }));
  const l2 = await put("MK", "tee", [loc("dtg", "Front")], { sets: { blankReceivedAt: "2026-10-03T00:00:00Z" } });
  r = await mk({ orderId: "MK", itemId: l2 });
  ok("with no time given it is made now: a timestamp, and the audit row", r.status === 200 && r.body.orderComplete === true && /^\d{4}-/.test(d1.q("SELECT manufacturedAt m FROM orders WHERE orderId='MK'")[0].m));
  r = await mk({ orderId: "", itemId: l2 });
  ok("no orderId → 400 \"orderId and itemId required\"", r.status === 400 && r.body.message === "orderId and itemId required" && r.rows.length === 0);
  r = await mk({ itemId: null });
  ok("no itemId → the same 400", r.status === 400 && r.body.message === "orderId and itemId required");
  r = await mk({ at: "not a date" });
  ok("an invalid time → 400 \"That date and time isn't valid.\"", r.status === 400 && r.body.message === "That date and time isn't valid.");
  const l3 = await put("MK2", "tee", [loc("dtg", "Front")], { sets: { blankReceivedAt: "2026-10-03T00:00:00Z" } });
  r = await mk({ orderId: "MK2", itemId: l3, at: "2026-10-01T00:00:00.000Z" });
  ok("a time before the blank was received is refused (409, \"can't be before …\") and nothing is made", r.status === 409 && /can't be before .*\.$/.test(r.body.message) && r.rows.length === 0 &&
    Number(d1.q("SELECT manufacturedQty q FROM order_items WHERE id=?", l3)[0].q) === 0);
  d1.q("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-10', 't', 'x')");
  r = await mk({ orderId: "MK2", itemId: l3, at: "2026-10-09T00:00:00.000Z" });
  ok("a time in a closed month is refused (409, already filed) and nothing is made", r.status === 409 && /already filed/.test(r.body.message) && r.rows.length === 0 &&
    Number(d1.q("SELECT manufacturedQty q FROM order_items WHERE id=?", l3)[0].q) === 0);
  d1.q("DELETE FROM closed_periods");
  r = await mk({ itemId: 99999 });
  ok("an unknown line → 400 \"Line item not found\", nothing logged", r.status === 400 && r.body.message === "Line item not found" && r.rows.length === 0);
  r = await mk({ orderId: "CX", itemId: cl });
  ok("a cancelled line → 400 \"That line item is cancelled\", nothing logged", r.status === 400 && r.body.message === "That line item is cancelled" && r.rows.length === 0);
  for (const [who, cookie] of [["Manager", manager], ["Back office", staff], ["Production", prod]])
    ok(who + " may mark a line made", (await mk({ orderId: "MK2", itemId: l3 }, cookie)).status === 200);
  const l4 = await put("MK3", "tee", [loc("dtg", "Front")]);
  ok("signed out → 401, and a role without Mark made at edit is refused with nothing made",
    (await mk({ orderId: "MK3", itemId: l4 }, "")).status === 401 && forbidden(await mk({ orderId: "MK3", itemId: l4 }, viewer)) && Number(d1.q("SELECT manufacturedQty q FROM order_items WHERE id=?", l4)[0].q) === 0);

  // ---- the Production feature switch
  console.log("\n=== The Production switch: the Run order's actions and the five transfer actions ===");
  const bodies = { getRunQueue: {}, setDecorationStarted: { orderId: "MK3", itemId: l4 }, makeDecoratedLine: { orderId: "MK3", itemId: l4 },
    getTransferQueue: {}, getGangSheet: {}, setTransferReceived: { itemId: l4, received: true }, setTransfersApplied: { orderId: "MK3", itemId: l4 }, makeTransferLine: { orderId: "MK3", itemId: l4 } };
  const names = Object.keys(bodies);
  const before = JSON.stringify([d1.q("SELECT decStartedAt, decMadeAt, manufacturedQty, transferReceivedAt, transfersAppliedAt FROM order_items ORDER BY id"), d1.q("SELECT count(*) n FROM audit_log")]);
  globalThis.__t377Features = { production: false };
  const got = [];
  for (const a of names) got.push([a, await call(Object.assign({ action: a }, bodies[a]), admin)]);
  const OFF = "Production is turned off. Turn it on under Settings → Global settings → Features.";
  for (const [a, res] of got) ok("with Production off, " + a + " is refused for an Admin: 403 { feature: \"production\" }", res.status === 403 && res.body.status === "error" && res.body.feature === "production" && res.body.message === OFF);
  ok("…nothing was started, made, received or logged", before === JSON.stringify([d1.q("SELECT decStartedAt, decMadeAt, manufacturedQty, transferReceivedAt, transfersAppliedAt FROM order_items ORDER BY id"), d1.q("SELECT count(*) n FROM audit_log")]));
  ok("…a role that may not is told about its role first, and signed out it is the sign-in that is asked for", forbidden(await call({ action: "makeDecoratedLine", ...bodies.makeDecoratedLine }, viewer)) && (await call({ action: "getRunQueue" }, "")).status === 401);
  globalThis.__t377Features = { production: true, quotes: false };
  ok("with Production on (another feature off) they work again", (await call({ action: "getRunQueue" }, admin)).status === 200 && (await call({ action: "getTransferQueue" }, admin)).status === 200 && (await call({ action: "getGangSheet" }, admin)).status === 200);
  delete globalThis.__t377Features;
  const inList = ordersJsSrc.match(/const FEATURE_ACTIONS = \{([\s\S]*?)\n\};/)[1].match(/production: \[([\s\S]*?)\],/)[1];
  ok("the eight actions are listed under the production switch in orders.js", names.every(a => inList.includes('"' + a + '"')));
}
