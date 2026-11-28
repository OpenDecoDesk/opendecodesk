// Customer-supplied garments (migrations/0121, phase 7) — the data side and its admin actions:
//   * the switch (Global settings → Features → Customer-supplied garments, off until ticked) refusing a line marked as the
//     customer's own on insertOrder, addOrderItem, updateOrderItem, saveEstimateItems and the Local sale / Edit items /
//     quote actions, and letting a quote accepted before it was turned off become an order;
//   * such a line needs no blank: not in Blanks to order, not in blank stock, no blank used or costed when it is made
//     (its transfers still are), not in the blank cost catch-up, never filled from finished stock;
//   * production waits for its check-in instead: the embroidery queue, the DTF and other decoration cards, the run
//     backlog's garments status, the order's blank roll-up on an order that also has blanks, Home's step and Mark
//     manufactured;
//   * checkInGarments / undoGarmentCheckin / listGarmentCheckins in db.js (every refusal, the note rule, a re-count
//     replacing the last one, ownReceivedAt) and getOrderById's checkins and ownGarments;
//   * the three actions in orders.js: who may (Admin and Manager all, Back office not Undo, Production reads), the
//     switch, every refusal, the answer and the audit rows;
//   * a database from before migrations/0121.
// Real SQL (sql.js) under the real db.js, email.js and orders.js; the sign-in stood in for with the real role tables.
// Invented shops and people only. Every time used is fixed; nothing depends on today's date or this machine's zone.
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const roles = require("./testlib/roles");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const OFF_MSG = "Customer-supplied garments are switched off in Global settings";
const NOTE_MSG = "Say what's different (a note) when the count or condition isn't as expected.";

const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, addOrderItem, updateOrderItem, createProduct, createBlank, setBlankLink, receiveBlanks,
  createTransfer, setFeatures, getFeatures, normalizeFeatures, getBlanksToOrder, getBlankStockCoverage, consumeBlanksForOrder, markItemPieceManufactured,
  planBlankCatchUp, getProductionQueue, getTransferQueue, getRunQueue, getPaidUnrunOrders, getOpenOrderStages, homeOrderStage, stagePrereqError,
  setFulfillmentStage, checkInGarments, undoGarmentCheckin, listGarmentCheckins, createEstimate, saveEstimateItems, getEstimate, voidOrder,
  OWN_GARMENTS_OFF_MESSAGE, GARMENT_CONDITIONS };`)();

// Who is signed in: globalThis.__who405 — a built-in role, or null (nobody).
const LEVELS = {};
for (const k of Object.keys(roles.DEFAULT_ROLES)) LEVELS[k] = roles.effectivePermissions(roles.DEFAULT_ROLES[k]);
const authSrc = `
const __LV405 = ${JSON.stringify(LEVELS)};
const __rank405 = (l) => l === "full" ? 3 : l === "edit" ? 2 : l === "read" ? 1 : 0;
const adminUser = () => { const k = globalThis.__who405; return k && __LV405[k] ? { id: 1, email: k + "@example.test", name: k, role: k, roleInfo: { key: k }, pending: null, bootstrap: false } : null; };
const adminLevel = (request, fn) => { const u = adminUser(); return u ? (__LV405[u.role][fn] || "none") : "none"; };
const adminCan = (request, fn, level) => __rank405(adminLevel(request, fn)) >= __rank405(level || "read");
const requireAdmin = async (env, host, key, request, msg, need) => {
  const u = adminUser();
  if (!u) return jsonResponse({ status: "error", message: "Unauthorized" }, 401);
  const okay = need === "*" || (Array.isArray(need) ? need.some(([fn, l]) => adminCan(request, fn, l)) : u.role === "admin");
  return okay ? null : jsonResponse({ status: "error", code: "forbidden", message: "Your role can't do this. Ask an admin." }, 403);
};
const adminActor = () => (globalThis.__who405 || "nobody") + "@example.test";
`;
globalThis.__f405 = {};
const S = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\n" + authSrc + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\nconst invalidateCatalogVersionCache = () => {};\n" +
  "const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {}, features: globalThis.__f405 });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" +
  strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/digital.js")) + "\n" + strip(read("functions/_lib/campaigns.js")) + "\n" +
  strip(read("functions/api/orders.js")) + `\nreturn { post: onRequestPost };`)();

const mail = [];
globalThis.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};
const logged = [];
console.error = (...a) => { logged.push(a.map(String).join(" ")); };

const migrationFiles = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function freshDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrationFiles) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1), ('other','other','Example School District','t','t',1);
    INSERT INTO customers (id, name, email, phone, company, createdAt, updatedAt) VALUES (1, 'Pat Example', 'pat@example.com', '555-0100', 'Example Club', 't', 't');`);
  return d1;
}
const T = (d) => `2026-10-${String(d).padStart(2, "0")}T15:00:00.000Z`;

(async () => {
  console.log("=== The switch: off until it is ticked ===");
  ok("a new install has Customer-supplied garments off (missing counts as off for this switch only)",
    lib.normalizeFeatures(null).ownGarments === false && lib.normalizeFeatures({}).ownGarments === false && lib.normalizeFeatures({}).production === true);
  ok("only an explicit true turns it on", lib.normalizeFeatures({ ownGarments: true }).ownGarments === true && lib.normalizeFeatures({ ownGarments: "yes" }).ownGarments === false);
  ok("the refusal's words are the documented ones (no full stop in db.js)", lib.OWN_GARMENTS_OFF_MESSAGE === OFF_MSG);
  ok("a garment's condition is good, damaged or other", same(lib.GARMENT_CONDITIONS, ["good", "damaged", "other"]));

  const d1 = await freshDb();
  const q = (sql, ...p) => d1.q(sql, ...p);
  const q1 = (sql, ...p) => q(sql, ...p)[0] || null;
  // The shop: a tee with a linked blank in stock, a cap filled from finished stock, a transfer sheet.
  for (const [id, type, name] of [["tee", "shirt", "Club Tee"], ["cap", "cap", "Club Cap"], ["hood", "shirt", "Club Hoodie"]])
    await lib.createProduct(d1, "club", { productId: id, type, name, pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  const blankId = (await lib.createBlank(d1, { name: "Example Tee Blank", brand: "Sample", color: "Navy", productType: "shirt" })).id;
  await lib.setBlankLink(d1, "club", "tee", "", "L", blankId, "Navy", "L");
  await lib.setBlankLink(d1, "club", "hood", "", "L", blankId, "Navy", "L");
  await lib.receiveBlanks(d1, { blankId, lines: [{ color: "Navy", size: "L", qty: 30, unitCost: 3 }], vendor: "", receivedAt: T(1) });
  d1._raw.exec(`INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt) VALUES ('club','cap','',10,'t')`);
  const sheet = await lib.createTransfer(d1, { name: "Example Crest DTF" });
  q("UPDATE transfers SET purchasePriceCents = 150 WHERE id = ?", sheet);
  const blankQty = () => q1("SELECT quantity FROM blank_sizes WHERE blankId = ? AND color = 'Navy' AND size = 'L'", blankId).quantity;
  const lineRow = (orderId, n = 0) => q("SELECT * FROM order_items WHERE orderId = ? ORDER BY id", orderId)[n];
  const place = (orderId, items, extra = {}, opts = {}) => lib.insertOrder(d1, { orderId, orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: T(2), ...extra }, items, opts);
  const tee = (extra = {}) => ({ productId: "tee", name: "Club Tee", type: "shirt", size: "L", qty: 2, unitPrice: 20, ...extra });
  const throwsWith = async (fn, msg) => { try { await fn(); return false; } catch (e) { return !!e.userFacing && e.message === msg; } };

  console.log("\n=== While the switch is off, db.js refuses a line marked as the customer's own ===");
  ok("insertOrder: a userFacing refusal with the switch's message, and no order", await throwsWith(() => place("OFF-1", [tee({ customerOwned: true })]), OFF_MSG) &&
    !q1("SELECT 1 AS x FROM orders WHERE orderId = 'OFF-1'"));
  let fromQuote = true;
  try { await place("OFF-Q", [tee({ customerOwned: true })], {}, { fromEstimate: true }); } catch (e) { fromQuote = false; }
  ok("…but a quote's lines (fromEstimate) still become an order with the line marked", fromQuote && Number(lineRow("OFF-Q").customerOwned) === 1);
  await place("OFF-2", [tee()]);
  ok("addOrderItem: refused, and no line added", await throwsWith(() => lib.addOrderItem(d1, "OFF-2", "club", tee({ customerOwned: true })), OFF_MSG) &&
    q("SELECT id FROM order_items WHERE orderId = 'OFF-2'").length === 1);
  const off2 = Number(lineRow("OFF-2").id);
  ok("updateOrderItem marking a line: refused, and the line is as it was", await throwsWith(() => lib.updateOrderItem(d1, off2, tee({ qty: 5, customerOwned: true })), OFF_MSG) &&
    Number(lineRow("OFF-2").qty) === 2 && Number(lineRow("OFF-2").customerOwned) === 0);
  if (fromQuote) await lib.updateOrderItem(d1, Number(lineRow("OFF-Q").id), tee({ customerOwned: false }));
  ok("…unmarking one (false) always works", fromQuote && Number(lineRow("OFF-Q").customerOwned) === 0);
  await lib.updateOrderItem(d1, off2, tee({ qty: 3 }));
  ok("…and an edit that doesn't name it is not refused", Number(lineRow("OFF-2").qty) === 3);
  const est = await lib.createEstimate(d1, { orgId: "club", customerId: 1, title: "Example Club tees" });
  let r = await lib.saveEstimateItems(d1, est.id, [{ kind: "custom", name: "Decoration", qty: 3, unitPrice: 8, customerOwned: true }]);
  ok("saveEstimateItems: { error } with the message, and no line saved", r.error === OFF_MSG && q("SELECT * FROM estimate_items WHERE estimateId = ?", est.id).length === 0);
  r = await lib.saveEstimateItems(d1, est.id, [{ kind: "fee", feeKind: "setup", name: "Setup fee", amount: 15, customerOwned: true }]);
  ok("…a fee marked as one is not asked about, and is saved unmarked", !r.error && Number(q1("SELECT customerOwned FROM estimate_items WHERE estimateId = ?", est.id).customerOwned) === 0);

  console.log("\n=== Switched on ===");
  await lib.setFeatures(d1, { ownGarments: true });
  ok("Global settings saves it on", (await lib.getFeatures(d1)).ownGarments === true);
  r = await lib.saveEstimateItems(d1, est.id, [{ kind: "custom", name: "Decoration", qty: 3, unitPrice: 8, customerOwned: true }, { kind: "custom", name: "Patch", qty: 1, unitPrice: 4 }]);
  const estLines = (await lib.getEstimate(d1, est.id)).items;
  ok("a quote's line is saved as the customer's own garment, the other line not", !r.error && estLines[0].customerOwned === true && estLines[1].customerOwned === false);

  // Finished stock: the cap is stocked, so a plain cap line is filled from it — but not one on the customer's own cap.
  await place("STK-1", [{ productId: "cap", name: "Club Cap", type: "cap", size: "", qty: 1, unitPrice: 20 }], {}, { fillFromStock: true });
  await place("OWN-STK", [{ productId: "cap", name: "Club Cap", type: "cap", size: "", qty: 1, unitPrice: 20, customerOwned: true }], {}, { fillFromStock: true });
  ok("a stocked line is filled from finished stock…", Number(lineRow("STK-1").fromStock) === 1);
  ok("…the customer's own garment never is, even with stock on hand", Number(lineRow("OWN-STK").fromStock) === 0 && Number(lineRow("OWN-STK").customerOwned) === 1);
  ok("…and is priced like any line (the price is the decoration)", Number(lineRow("OWN-STK").lineTotalCents) === 2000);
  await place("STK-2", [{ productId: "cap", name: "Club Cap", type: "cap", size: "", qty: 1, unitPrice: 20 }], {}, { fillFromStock: true });
  await lib.updateOrderItem(d1, Number(lineRow("STK-2").id), { productId: "cap", name: "Club Cap", type: "cap", size: "", qty: 1, unitPrice: 20 });
  ok("an edit of a stocked line keeps it filled from stock…", Number(lineRow("STK-2").fromStock) === 1);
  await lib.updateOrderItem(d1, Number(lineRow("STK-2").id), { productId: "cap", name: "Club Cap", type: "cap", size: "", qty: 1, unitPrice: 20, customerOwned: true });
  ok("…marking it the customer's own takes it off stock and doesn't fill it again", Number(lineRow("STK-2").fromStock) === 0 && Number(lineRow("STK-2").customerOwned) === 1);

  console.log("\n=== No blank: Blanks to order, blank stock, a line made, the cost catch-up ===");
  await place("BLK-1", [tee()]);
  await place("OWN-1", [tee({ customerOwned: true, config: { garmentColor: "", locations: [{ location: "front", label: "Front", kind: "transfer", graphicName: "Crest", transferId: sheet, decoration: "dtf" }] } })]);
  q("UPDATE orders SET paid = 1 WHERE orderId IN ('BLK-1', 'OWN-1')");
  const bto = JSON.stringify(await lib.getBlanksToOrder(d1));
  ok("Blanks to order lists the ordinary tee's order and not the customer's own", bto.includes('"BLK-1"') && !bto.includes('"OWN-1"'));
  const cov = await lib.getBlankStockCoverage(d1, ["BLK-1", "OWN-1"]);
  ok("blank stock covers the ordinary order and has nothing to say about the customer's own", !!cov["BLK-1"] && !("OWN-1" in cov));
  let o = await lib.getOrderById(d1, "OWN-1");
  ok("the line reads as the customer's own with no blank, waiting for its garments", o.items[0].customerOwned === true && o.items[0].noBlank === true && o.items[0].ownReceivedAt === "");
  ok("…and the order of only such lines has no blank steps", o.needsBlanks === false && same(o.ownGarments, { lines: 1, waiting: 1 }));
  const before = blankQty();
  await lib.consumeBlanksForOrder(d1, "OWN-1", T(9));
  const own1 = lineRow("OWN-1");
  ok("made: the customer's own line takes no blank from stock and writes no blank use", blankQty() === before &&
    !q1("SELECT 1 AS x FROM inventory_movements WHERE orderId = 'OWN-1'"));
  ok("…but its transfers are still used, and its cost is the transfers' only (2 × $1.50)", q("SELECT * FROM transfer_movements WHERE orderId = 'OWN-1' AND kind = 'consume'").length === 1 &&
    Number(own1.cogsCents) === 300 && Number(own1.manufacturedQty) === 2);
  await lib.consumeBlanksForOrder(d1, "BLK-1", T(9));
  ok("an ordinary line made the same way does use its blanks ($3 each)", blankQty() === before - 2 && Number(lineRow("BLK-1").cogsCents) === 600);
  await place("OWN-PC", [tee({ customerOwned: true, qty: 1 })]);
  q("UPDATE orders SET paid = 1 WHERE orderId = 'OWN-PC'");
  await lib.markItemPieceManufactured(d1, "OWN-PC", Number(lineRow("OWN-PC").id), T(9));
  ok("Run order's one piece at a time: the customer's own piece uses no blank either", blankQty() === before - 2 && Number(lineRow("OWN-PC").manufacturedQty) === 1 &&
    !q1("SELECT 1 AS x FROM inventory_movements WHERE orderId = 'OWN-PC'"));
  // The catch-up: lines made with no cost on file get their blanks' cost — not the customer's own.
  await place("CU-BLK", [tee({ qty: 1 })]);
  await place("CU-OWN", [tee({ qty: 1, customerOwned: true })]);
  q("UPDATE orders SET manufacturedAt = ? WHERE orderId IN ('CU-BLK', 'CU-OWN')", T(10));
  const plan = JSON.stringify(await lib.planBlankCatchUp(d1));
  ok("the blank cost catch-up offers the ordinary made line and not the customer's own", plan.includes('"CU-BLK"') && !plan.includes('"CU-OWN"'));
  q("UPDATE orders SET voidedAt = 't' WHERE orderId IN ('CU-BLK', 'CU-OWN', 'OWN-PC', 'BLK-1', 'OWN-1', 'STK-1', 'STK-2', 'OWN-STK', 'OFF-2', 'OFF-Q')");

  console.log("\n=== Production waits for the check-in ===");
  const dtf = { location: "front", label: "Front", kind: "transfer", graphicName: "Crest", ink: "", transferId: sheet, decoration: "dtf" };
  const scr = { location: "back", label: "Back", kind: "transfer", graphicName: "Crest", ink: "Red", decoration: "screenprint" };
  await place("Q-OWN", [tee({ customerOwned: true, config: { garmentColor: "", locations: [dtf, scr] } })]);
  await place("Q-NB", [{ productId: "cap", name: "Club Cap", type: "cap", size: "", qty: 1, unitPrice: 20, config: { garmentColor: "", locations: [dtf, scr] } }]);
  q("UPDATE products SET noBlankNeeded = 1 WHERE productId = 'cap'");
  // The embroidery queue: plain lines (no transfers), the stitch file done.
  await place("P-OWN", [tee({ customerOwned: true })]);
  await place("P-NB", [{ productId: "cap", name: "Club Cap", type: "cap", size: "", qty: 1, unitPrice: 20 }]);
  q("UPDATE orders SET paid = 1, digitizingCompleteAt = ? WHERE orderId IN ('Q-OWN', 'Q-NB', 'P-OWN', 'P-NB')", T(3));
  const pOwn = Number(lineRow("P-OWN").id);
  const qOwn = Number(lineRow("Q-OWN").id);
  const pq = async () => (await lib.getProductionQueue(d1)).map(j => j.orderId);
  const rq = await lib.getRunQueue(d1);
  const tCard = (rqx, id) => rqx.transfers.ready.concat(rqx.transfers.waiting).find(c => c.orderId === id);
  const oCard = (rqx, id) => rqx.other.ready.concat(rqx.other.waiting).find(c => c.orderId === id);
  ok("the embroidery queue leaves the line out until its garments are in, and lists a no-blank line", !(await pq()).includes("P-OWN") && (await pq()).includes("P-NB"));
  ok("its DTF card: blankReceived false and customerOwned true", tCard(rq, "Q-OWN").blankReceived === false && tCard(rq, "Q-OWN").customerOwned === true);
  ok("…a no-blank line's DTF card: blankReceived true, customerOwned false", tCard(rq, "Q-NB").blankReceived === true && tCard(rq, "Q-NB").customerOwned === false);
  ok("its screen print card: blankReceived false and customerOwned true", oCard(rq, "Q-OWN").blankReceived === false && oCard(rq, "Q-OWN").customerOwned === true &&
    oCard(rq, "Q-NB").blankReceived === true && oCard(rq, "Q-NB").customerOwned === false);
  let unrun = await lib.getPaidUnrunOrders(d1);
  ok("the run backlog says it waits on the customer's garments", same(unrun.find(x => x.orderId === "Q-OWN").ownGarments, { lines: 1, waiting: 1 }) &&
    unrun.find(x => x.orderId === "Q-OWN").garmentsStatus === "Waiting on the customer's garments");
  ok("…and an order with none says nothing about garments", unrun.find(x => x.orderId === "Q-NB").garmentsStatus === "" && same(unrun.find(x => x.orderId === "Q-NB").ownGarments, { lines: 0, waiting: 0 }));
  const stageOf = async (id) => (await lib.getOpenOrderStages(d1)).find(s => s.orderId === id).stage;
  o = await lib.getOrderById(d1, "Q-OWN");
  ok("Home holds it at blanks (an order of only the customer's garments has no blank step otherwise)", lib.homeOrderStage(o) === "blanks" && await stageOf("Q-OWN") === "blanks");
  ok("Mark manufactured says the garments aren't checked in yet", lib.stagePrereqError(o, "manufactured") === "the customer's garments haven't been checked in yet");
  ok("…and the blank steps say there is no blank", lib.stagePrereqError(o, "blankOrdered") === "nothing on this order uses a blank");
  r = await lib.checkInGarments(d1, { orderId: "Q-OWN", itemId: qOwn, counts: [{ size: "L", expectedQty: 2, receivedQty: 2 }], by: "pat@example.com", at: T(12) });
  const rq2 = await lib.getRunQueue(d1);
  ok("checked in: the DTF line's check-in is taken", r.ok === true);
  await lib.checkInGarments(d1, { orderId: "P-OWN", itemId: pOwn, counts: [{ size: "L", expectedQty: 2, receivedQty: 2 }], at: T(12) });
  ok("checked in: the embroidery queue lists the line", (await pq()).includes("P-OWN"));
  ok("…its DTF and screen print cards say the garments are in, still the customer's own", tCard(rq2, "Q-OWN").blankReceived === true && tCard(rq2, "Q-OWN").customerOwned === true &&
    oCard(rq2, "Q-OWN").blankReceived === true && oCard(rq2, "Q-OWN").customerOwned === true);
  unrun = await lib.getPaidUnrunOrders(d1);
  ok("…the run backlog says Garments in", unrun.find(x => x.orderId === "Q-OWN").garmentsStatus === "Garments in" && same(unrun.find(x => x.orderId === "Q-OWN").ownGarments, { lines: 1, waiting: 0 }));
  o = await lib.getOrderById(d1, "Q-OWN");
  ok("…Home moves it to run, and Mark manufactured may go ahead", lib.homeOrderStage(o) === "run" && await stageOf("Q-OWN") === "run" && lib.stagePrereqError(o, "manufactured") === "");
  ok("homeOrderStage holds at blanks for any waiting garments, and goes on once none wait",
    lib.homeOrderStage({ paid: true, paidForWork: true, needsBlanks: false, ownGarments: { lines: 2, waiting: 1 } }) === "blanks" &&
    lib.homeOrderStage({ paid: true, paidForWork: true, needsBlanks: false, ownGarments: { lines: 2, waiting: 0 } }) === "run");

  console.log("\n=== An order with blanks and the customer's own garments: the blank roll-up waits for both ===");
  await place("MIX", [tee({ qty: 1 }), tee({ qty: 1, customerOwned: true, size: "M" })]);
  q("UPDATE orders SET paid = 1 WHERE orderId = 'MIX'");
  const [mixBlank, mixOwn] = q("SELECT id FROM order_items WHERE orderId = 'MIX' ORDER BY id").map(x => Number(x.id));
  o = await lib.getOrderById(d1, "MIX");
  ok("it has blank steps (one line uses a blank)", o.needsBlanks === true && same(o.ownGarments, { lines: 1, waiting: 1 }));
  await lib.setFulfillmentStage(d1, "MIX", "blankOrdered", { at: T(5) });
  await lib.setFulfillmentStage(d1, "MIX", "blankReceived", { at: T(6) });
  const mixO = () => q1("SELECT blankOrderedAt, blankReceivedAt FROM orders WHERE orderId = 'MIX'");
  ok("the blank received alone doesn't make the order's blanks received", !!lineRow("MIX").blankReceivedAt && !!mixO().blankOrderedAt && mixO().blankReceivedAt === null);
  o = await lib.getOrderById(d1, "MIX");
  ok("…Home keeps it at blanks", lib.homeOrderStage(o) === "blanks");
  await lib.checkInGarments(d1, { orderId: "MIX", itemId: mixOwn, counts: [{ size: "M", expectedQty: 1, receivedQty: 1 }], at: T(7) });
  ok("the garments checked in: received, at the later of the two times", mixO().blankReceivedAt === T(7));
  await lib.undoGarmentCheckin(d1, { orderId: "MIX", itemId: mixOwn, at: T(8) });
  ok("an Undo takes the order's blanks received back off", mixO().blankReceivedAt === null && lineRow("MIX", 1).ownReceivedAt === null);
  await lib.updateOrderItem(d1, mixOwn, tee({ qty: 1, size: "M", customerOwned: false }));
  ok("unmarking the line makes it a blank line again (the blanks wait for it)", Number(lineRow("MIX", 1).customerOwned) === 0 && mixO().blankReceivedAt === null &&
    (await lib.getOrderById(d1, "MIX")).ownGarments.lines === 0);
  // Every blank in, then a customer's own line added: the order waits again.
  await place("MIX2", [tee({ qty: 1 })]);
  q("UPDATE orders SET paid = 1 WHERE orderId = 'MIX2'");
  await lib.setFulfillmentStage(d1, "MIX2", "blankOrdered", { at: T(5) });
  await lib.setFulfillmentStage(d1, "MIX2", "blankReceived", { at: T(6) });
  const before2 = q1("SELECT blankReceivedAt FROM orders WHERE orderId = 'MIX2'").blankReceivedAt;
  const added = await lib.addOrderItem(d1, "MIX2", "club", tee({ qty: 1, customerOwned: true }));
  ok("adding a customer's own line to an order whose blanks are in holds it until the garments come", before2 === T(6) && Number(q1("SELECT customerOwned FROM order_items WHERE id = ?", added).customerOwned) === 1 &&
    q1("SELECT blankReceivedAt FROM orders WHERE orderId = 'MIX2'").blankReceivedAt === null);
  await lib.updateOrderItem(d1, Number(added), tee({ qty: 1, customerOwned: false }));
  ok("…and unmarking it leaves the order waiting for that line's blank", q1("SELECT blankReceivedAt FROM orders WHERE orderId = 'MIX2'").blankReceivedAt === null);
  await lib.updateOrderItem(d1, Number(added), tee({ qty: 1, customerOwned: true }));
  ok("…marking it again: the order waits for its garments, not a blank", q1("SELECT blankReceivedAt FROM orders WHERE orderId = 'MIX2'").blankReceivedAt === null &&
    (await lib.getOrderById(d1, "MIX2")).ownGarments.waiting === 1);
  await lib.checkInGarments(d1, { orderId: "MIX2", itemId: Number(added), counts: [{ size: "L", expectedQty: 1, receivedQty: 1 }], at: T(4) });
  ok("…checked in with an earlier time than the blank: received at the blank's time (the later)", q1("SELECT blankReceivedAt FROM orders WHERE orderId = 'MIX2'").blankReceivedAt === T(6));

  console.log("\n=== checkInGarments: every refusal leaves nothing changed ===");
  await place("CI", [tee({ qty: 5, customerOwned: true }), tee({ qty: 1 }), tee({ qty: 1, customerOwned: true, size: "S" })]);
  const [ciOwn, ciPlain, ciCancelled] = q("SELECT id FROM order_items WHERE orderId = 'CI' ORDER BY id").map(x => Number(x.id));
  q("UPDATE order_items SET cancelDate = ? WHERE id = ?", T(3), ciCancelled);
  const rows = () => q("SELECT count(*) AS n FROM garment_checkins")[0].n;
  const n0 = rows();
  const ci = (counts, extra = {}) => lib.checkInGarments(d1, { orderId: "CI", itemId: ciOwn, counts, at: T(13), ...extra });
  const good = [{ size: "L", expectedQty: 5, receivedQty: 5 }];
  const refusals = [
    ["a line of another order", () => lib.checkInGarments(d1, { orderId: "MIX", itemId: ciOwn, counts: good }), "That line isn't on this order."],
    ["no such line", () => ci(good, { itemId: 999999 }), "That line isn't on this order."],
    ["a cancelled line", () => ci(good, { itemId: ciCancelled }), "That line is cancelled."],
    ["a line that isn't the customer's own", () => ci(good, { itemId: ciPlain }), "That line isn't marked as the customer's own garment."],
    ["no counts", () => ci([]), "Count at least one size."],
    ["counts that aren't a list", () => ci("5"), "Count at least one size."],
    ["more than 100 sizes", () => ci(Array.from({ length: 101 }, () => ({ size: "L", expectedQty: 1, receivedQty: 1 }))), "That's too many sizes for one line."],
    ["a count that isn't an object", () => ci([5]), "Each count needs a size, how many were expected and how many came in."],
    ["a negative count", () => ci([{ size: "L", expectedQty: 5, receivedQty: -1 }]), "Counts must be whole numbers, 0 or more."],
    ["a part of a garment", () => ci([{ size: "L", expectedQty: 2.5, receivedQty: 2 }]), "Counts must be whole numbers, 0 or more."],
    ["more than 100,000", () => ci([{ size: "L", expectedQty: 100001, receivedQty: 100001 }]), "Counts must be whole numbers, 0 or more."],
    ["a condition not on the list", () => ci([{ size: "L", expectedQty: 5, receivedQty: 5, condition: "wet" }]), "The condition must be Good, Damaged or Other."],
    ["fewer than expected with no note", () => ci([{ size: "L", expectedQty: 5, receivedQty: 4 }]), NOTE_MSG],
    ["more than expected with a blank note", () => ci([{ size: "L", expectedQty: 5, receivedQty: 6, note: "   " }]), NOTE_MSG],
    ["damaged with no note", () => ci([{ size: "L", expectedQty: 5, receivedQty: 5, condition: "Damaged" }]), NOTE_MSG],
    ["other with no note", () => ci([{ size: "L", expectedQty: 5, receivedQty: 5, condition: "other" }]), NOTE_MSG],
  ];
  for (const [what, run, msg] of refusals) {
    const got = await run();
    ok("refused — " + what + ": “" + msg + "”", got.error === msg && rows() === n0 && lineRow("CI").ownReceivedAt === null);
  }
  q("UPDATE orders SET completedAt = ? WHERE orderId = 'CI'", T(20));
  ok("refused — a completed order", (await ci(good)).error === "This order is completed." && rows() === n0);
  q("UPDATE orders SET completedAt = NULL, voidedAt = ? WHERE orderId = 'CI'", T(20));
  ok("refused — a voided order", (await ci(good)).error === "This order is voided." && rows() === n0);
  q("UPDATE orders SET voidedAt = NULL WHERE orderId = 'CI'");

  console.log("\n=== checkInGarments: what it writes ===");
  r = await ci([{ size: "  L  ", expectedQty: "3", receivedQty: 3, condition: "" }, { size: "XL", expectedQty: 2, receivedQty: 1, condition: "DAMAGED", note: "  One torn at the collar  " }], { by: "pat@example.com" });
  ok("taken: { ok, checkins, ownReceivedAt, received, before }", r.ok === true && r.checkins.length === 2 && r.ownReceivedAt === T(13) && r.received === 4 && same(r.before, []));
  ok("…each size a row: trimmed size, counts as numbers, a blank condition is good, the condition in lower case, the note trimmed",
    same(r.checkins.map(c => [c.size, c.expectedQty, c.receivedQty, c.condition, c.note]), [["L", 3, 3, "good", ""], ["XL", 2, 1, "damaged", "One torn at the collar"]]));
  ok("…who and when, and live (not voided)", r.checkins.every(c => c.by === "pat@example.com" && c.at === T(13) && c.voidedAt === "" && c.orderId === "CI" && c.itemId === ciOwn));
  ok("…the line is in: ownReceivedAt set", lineRow("CI").ownReceivedAt === T(13));
  o = await lib.getOrderById(d1, "CI");
  ok("getOrderById: the customer's own line carries its live rows, the other lines none", same(o.items.find(i => i.sheetRow === ciOwn).checkins.map(c => c.size), ["L", "XL"]) &&
    !("checkins" in o.items.find(i => i.sheetRow === ciPlain)));
  ok("…and ownGarments counts active lines only (the cancelled one isn't)", same(o.ownGarments, { lines: 1, waiting: 0 }));
  const firstIds = r.checkins.map(c => c.id);
  r = await ci([{ size: "L", expectedQty: 5, receivedQty: 5 }], { at: T(14) });
  ok("a re-count replaces the last one: its rows are the new ones, before = the old ones", r.ok && r.checkins.length === 1 && r.checkins[0].at === T(14) && same(r.before.map(c => c.id), firstIds));
  ok("…the old rows are voided at the re-count's time", q("SELECT voidedAt FROM garment_checkins WHERE id IN (" + firstIds.join(",") + ")").every(x => x.voidedAt === T(14)));
  ok("…and the line keeps the time its garments first came in", lineRow("CI").ownReceivedAt === T(13) && r.ownReceivedAt === T(13));
  r = await ci([{ size: "L", expectedQty: 5, receivedQty: 0, note: "Not dropped off yet" }], { at: T(15) });
  ok("a count of none: the line is not in (ownReceivedAt cleared, the answer's is empty)", r.ok && r.received === 0 && r.ownReceivedAt === "" && lineRow("CI").ownReceivedAt === null);
  ok("…and the order waits for it again", (await lib.getOrderById(d1, "CI")).ownGarments.waiting === 1);
  r = await ci([{ size: "x".repeat(80), expectedQty: 5, receivedQty: 5, note: "n".repeat(1200), condition: "other" }], { at: T(16), by: "b".repeat(300) });
  ok("a long size, note and name are cut to 60, 1,000 and 200 characters", r.ok && r.checkins[0].size.length === 60 && r.checkins[0].note.length === 1000 && r.checkins[0].by.length === 200);
  ok("…and a check-in without a size is taken (size '')", (await ci([{ expectedQty: 5, receivedQty: 5 }], { at: T(17) })).checkins[0].size === "");
  const all = await lib.listGarmentCheckins(d1, "CI");
  ok("listGarmentCheckins: every row of the order, voided ones too, in the order written", all.length === 6 && all.filter(c => !c.voidedAt).length === 1 &&
    same(all.map(c => c.id), all.map(c => c.id).slice().sort((a, b) => a - b)));
  ok("…an order with none: an empty list", same(await lib.listGarmentCheckins(d1, "MIX2-NONE"), []));

  console.log("\n=== undoGarmentCheckin ===");
  r = await lib.undoGarmentCheckin(d1, { orderId: "CI", itemId: ciOwn, by: "pat@example.com", at: T(18) });
  ok("Undo: { ok, before } and the live rows voided, the line waiting again", r.ok === true && r.before.length === 1 && r.by === "pat@example.com" &&
    q("SELECT count(*) AS n FROM garment_checkins WHERE orderId = 'CI' AND voidedAt IS NULL")[0].n === 0 && lineRow("CI").ownReceivedAt === null);
  ok("…getOrderById then shows no rows on the line", same((await lib.getOrderById(d1, "CI")).items.find(i => i.sheetRow === ciOwn).checkins, []));
  ok("Undo with nothing checked in: “Nothing has been checked in for that line.”", (await lib.undoGarmentCheckin(d1, { orderId: "CI", itemId: ciOwn })).error === "Nothing has been checked in for that line.");
  ok("Undo on a line that isn't the customer's own is refused", (await lib.undoGarmentCheckin(d1, { orderId: "CI", itemId: ciPlain })).error === "That line isn't marked as the customer's own garment.");
  await ci(good, { at: T(19) });
  q("UPDATE orders SET completedAt = ? WHERE orderId = 'CI'", T(20));
  ok("Undo on a completed order is refused and changes nothing", (await lib.undoGarmentCheckin(d1, { orderId: "CI", itemId: ciOwn })).error === "This order is completed." && lineRow("CI").ownReceivedAt === T(19));
  q("UPDATE orders SET completedAt = NULL, voidedAt = ? WHERE orderId = 'CI'", T(20));
  ok("…on a voided order too", (await lib.undoGarmentCheckin(d1, { orderId: "CI", itemId: ciOwn })).error === "This order is voided." && lineRow("CI").ownReceivedAt === T(19));
  q("UPDATE orders SET voidedAt = NULL WHERE orderId = 'CI'");

  console.log("\n=== The actions: who may ===");
  const perm = (a) => roles.ACTION_PERM[a];
  ok("listing check-ins is the early steps at read, checking in at edit, Undo at full", same(perm("listGarmentCheckins"), [["orders.stepsEarly", "read"]]) &&
    same(perm("checkInGarments"), [["orders.stepsEarly", "edit"]]) && same(perm("undoGarmentCheckin"), [["orders.stepsEarly", "full"]]));
  const ordersJs = read("functions/api/orders.js");
  const feat = [...ordersJs.match(/ownGarments: \[([\s\S]*?)\],/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
  ok("the Customer-supplied garments switch covers the three actions", same(feat.sort(), ["checkInGarments", "listGarmentCheckins", "undoGarmentCheckin"]));
  const noMonth = [...ordersJs.match(/const NO_MONTH_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
  ok("checking garments in and undoing it change no month's numbers", noMonth.includes("checkInGarments") && noMonth.includes("undoGarmentCheckin"));

  let ENV = { SIGNING_SECRET: "s".repeat(40), ...MAIL_ENV };
  const call = async (db, body) => {
    const waits = [];
    const res = await S.post({ env: { DB: db, ...ENV }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})), request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => body, headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const as = async (who, body, db = d1) => { const was = globalThis.__who405; globalThis.__who405 = who; try { return await call(db, { key: "x", ...body }); } finally { globalThis.__who405 = was; } };
  const admin = (body, db) => as("admin", body, db);
  const audits = (action, orderId) => q("SELECT * FROM audit_log WHERE action = ? AND orderId = ? ORDER BY id", action, orderId).map(a => ({ ...a, d: JSON.parse(a.detail || "{}") }));
  globalThis.__f405 = { ownGarments: true };

  await place("AC", [tee({ qty: 3, customerOwned: true }), tee({ qty: 1 }), tee({ qty: 1, customerOwned: true, size: "S" })]);
  const [acOwn, acPlain, acCancelled] = q("SELECT id FROM order_items WHERE orderId = 'AC' ORDER BY id").map(x => Number(x.id));
  q("UPDATE order_items SET cancelDate = ? WHERE id = ?", T(3), acCancelled);
  const counts3 = [{ size: "L", expectedQty: 3, receivedQty: 3 }];
  const checkIn = (who, extra = {}) => as(who, { action: "checkInGarments", orderId: "AC", itemId: acOwn, counts: counts3, ...extra });
  ok("nobody signed in: 401 for each", (await checkIn(null)).status === 401 && (await as(null, { action: "listGarmentCheckins", orderId: "AC" })).status === 401 &&
    (await as(null, { action: "undoGarmentCheckin", orderId: "AC", itemId: acOwn })).status === 401);
  ok("Production may list the check-ins but not check in or undo", (await as("production", { action: "listGarmentCheckins", orderId: "AC" })).status === 200 &&
    (await checkIn("production")).status === 403 && (await as("production", { action: "undoGarmentCheckin", orderId: "AC", itemId: acOwn })).status === 403 && lineRow("AC").ownReceivedAt === null);
  r = await checkIn("staff");
  ok("Back office checks garments in", r.status === 200 && !!lineRow("AC").ownReceivedAt);
  ok("…but can't undo a check-in", (await as("staff", { action: "undoGarmentCheckin", orderId: "AC", itemId: acOwn })).status === 403 && !!lineRow("AC").ownReceivedAt);
  ok("a Manager may undo", (await as("manager", { action: "undoGarmentCheckin", orderId: "AC", itemId: acOwn })).status === 200 && lineRow("AC").ownReceivedAt === null);

  console.log("\n=== The actions: the switch ===");
  globalThis.__f405 = { ownGarments: false };
  r = await checkIn("admin");
  ok("switched off: 403 “Customer-supplied garments is turned off…” and nothing written", r.status === 403 && r.body.feature === "ownGarments" && /^Customer-supplied garments is turned off/.test(r.body.message) && lineRow("AC").ownReceivedAt === null);
  ok("…for listing and Undo as well", (await admin({ action: "listGarmentCheckins", orderId: "AC" })).status === 403 && (await admin({ action: "undoGarmentCheckin", orderId: "AC", itemId: acOwn })).status === 403);
  ok("…and someone not signed in still learns only 401", (await checkIn(null)).status === 401);
  globalThis.__f405 = {};
  r = await checkIn("admin");
  ok("a catalog from before the switch existed (no key) counts as off for these, unlike other switches", r.status === 403 && r.body.feature === "ownGarments" && lineRow("AC").ownReceivedAt === null &&
    (await admin({ action: "listGarmentCheckins", orderId: "AC" })).status === 403 && (await admin({ action: "undoGarmentCheckin", orderId: "AC", itemId: acOwn })).status === 403);
  globalThis.__f405 = { ownGarments: true };

  console.log("\n=== checkInGarments: what it refuses ===");
  const aRefusals = [
    ["no line named", { itemId: undefined }, 400, "Say which line the garments are for."],
    ["no counts", { counts: [] }, 400, "Count at least one size."],
    ["more than 50 sizes", { counts: Array.from({ length: 51 }, () => counts3[0]) }, 400, "A check-in has at most 50 sizes."],
    ["a count that is a list", { counts: [[1]] }, 400, "Those counts aren't valid."],
    ["a count that isn't a number", { counts: [{ size: "L", expectedQty: 3, receivedQty: "three" }] }, 400, "Counts are whole numbers from 0 to 100,000."],
    ["a count over 100,000", { counts: [{ size: "L", expectedQty: 100001, receivedQty: 3 }] }, 400, "Counts are whole numbers from 0 to 100,000."],
    ["a missing count", { counts: [{ size: "L", expectedQty: 3 }] }, 400, "Counts are whole numbers from 0 to 100,000."],
    ["a condition not on the list", { counts: [{ size: "L", expectedQty: 3, receivedQty: 3, condition: "fine" }] }, 400, "The condition is Good, Damaged or Other."],
    ["a short count with no note", { counts: [{ size: "L", expectedQty: 3, receivedQty: 2 }] }, 400, NOTE_MSG],
    ["damaged with no note", { counts: [{ size: "L", expectedQty: 3, receivedQty: 3, condition: "damaged" }] }, 400, NOTE_MSG],
    ["a time that isn't one", { at: "not a time" }, 400, "That date and time isn't valid."],
    ["a time before 2020", { at: "2019-06-01T12:00:00Z" }, 400, "That date is too far back."],
    ["an order number that isn't one", { orderId: "AC 1" }, 400, "Invalid order ID"],
    ["an order that doesn't exist", { orderId: "NOPE-1" }, 404, "Order not found"],
    ["the order of another shop", { org: "other" }, 404, "Order not found"],
    ["a line that isn't on it", { itemId: 999999 }, 400, "That line isn't on this order. Reload the order and try again."],
    ["a line id that isn't one", { itemId: "abc" }, 400, "That line isn't on this order. Reload the order and try again."],
    ["a line that isn't the customer's own", { itemId: acPlain }, 409, "That line isn't marked as the customer's own garments."],
    ["a cancelled line", { itemId: acCancelled }, 409, "That line was cancelled."],
  ];
  const auditN = () => q("SELECT count(*) AS n FROM audit_log WHERE action LIKE 'order.garments%'")[0].n;
  const a0 = auditN(), g0 = rows();
  for (const [what, extra, status, msg] of aRefusals) {
    const got = await checkIn("admin", extra);
    ok("refused — " + what + ": " + status + " “" + msg + "”", got.status === status && got.body.message === msg && rows() === g0 && auditN() === a0);
  }
  q("UPDATE orders SET voidedAt = ? WHERE orderId = 'AC'", T(20));
  r = await checkIn("admin");
  ok("refused — a voided order: 409 “This order is voided.”", r.status === 409 && r.body.message === "This order is voided." && rows() === g0 && auditN() === a0);
  q("UPDATE orders SET voidedAt = NULL, completedAt = ? WHERE orderId = 'AC'", T(20));
  r = await checkIn("admin");
  ok("refused — a completed order: 409 “This order is completed.” (db.js's answer)", r.status === 409 && r.body.message === "This order is completed." && rows() === g0 && auditN() === a0);
  q("UPDATE orders SET completedAt = NULL WHERE orderId = 'AC'");

  console.log("\n=== checkInGarments: the answer and the audit row ===");
  r = await checkIn("admin", { at: "2021-03-01T10:00:00Z", org: "club",
    counts: [{ size: " " + "S".repeat(50), expectedQty: "2", receivedQty: 1, condition: "Other", note: "y".repeat(600) }, { size: "L", expectedQty: 1, receivedQty: 1 }] });
  ok("taken: { status, orderId, checkins, waiver, order, itemId }", r.status === 200 && r.body.status === "ok" && r.body.orderId === "AC" && r.body.itemId === acOwn &&
    Array.isArray(r.body.checkins) && !!r.body.order && r.body.order.orderId === "AC");
  const live = r.body.checkins.filter(c => !c.voidedAt);
  ok("…the answer's rows are every row of the order: the earlier ones voided, these two live", live.length === 2 && r.body.checkins.length > 2);
  ok("…the size cut to 40 and the note to 500, a count typed as text taken as a number, the condition in lower case",
    live[0].size.length === 40 && live[0].note.length === 500 && live[0].expectedQty === 2 && live[0].condition === "other");
  ok("…dated when it happened and signed by who did it", live.every(c => c.at === "2021-03-01T10:00:00.000Z" && c.by === "admin@example.test") &&
    lineRow("AC").ownReceivedAt === "2021-03-01T10:00:00.000Z");
  ok("…the slip's waiver is the default sentence", r.body.waiver === "Customer's garments are decorated at the customer's risk; we're not responsible for garments damaged in normal production.");
  ok("…the order in the answer shows the line in and nothing waiting", r.body.order.ownGarments.waiting === 0 && r.body.order.items.find(i => i.sheetRow === acOwn).checkins.length === 2 &&
    r.body.order.items.find(i => i.sheetRow === acPlain).checkins === undefined);
  let au = audits("order.garments_checked_in", "AC").pop();
  ok("audited: order.garments_checked_in with the line, its name, the totals, the time and each size (a note only where there is one)",
    !!au && au.orgId === "club" && au.d.itemId === acOwn && au.d.name === "Club Tee" && au.d.expected === 3 && au.d.received === 2 && au.d.at === "2021-03-01T10:00:00.000Z" &&
    au.d.counts.length === 2 && au.d.counts[0].note.length === 500 && au.d.counts[0].condition === "other" && !("note" in au.d.counts[1]));
  await lib.setFeatures(d1, { ownGarmentsWaiver: "" });
  r = await checkIn("admin");
  ok("a waiver saved empty: the answer's waiver is empty (no line on the slip)", r.status === 200 && r.body.waiver === "");
  await lib.setFeatures(d1, { ownGarmentsWaiver: "Example waiver line." });
  r = await admin({ action: "listGarmentCheckins", orderId: "AC" });
  ok("listGarmentCheckins: every row of the order (voided ones too), the waiver and the order, no line named", r.status === 200 &&
    r.body.checkins.length === q("SELECT count(*) AS n FROM garment_checkins WHERE orderId = 'AC'")[0].n && r.body.checkins.length >= 3 &&
    r.body.checkins.filter(c => !c.voidedAt).length === 1 && r.body.waiver === "Example waiver line." && r.body.order.orderId === "AC" && !("itemId" in r.body));
  ok("…an order that isn't there: 404, and a bad number: 400", (await admin({ action: "listGarmentCheckins", orderId: "NOPE-1" })).status === 404 &&
    (await admin({ action: "listGarmentCheckins", orderId: "" })).status === 400 && (await admin({ action: "listGarmentCheckins", orderId: "AC", org: "other" })).status === 404);

  console.log("\n=== undoGarmentCheckin: refusals, the audit first ===");
  const undo = (extra = {}) => admin({ action: "undoGarmentCheckin", orderId: "AC", itemId: acOwn, ...extra });
  const u0 = audits("order.garments_checkin_undone", "AC").length;
  for (const [what, extra, status, msg] of [
    ["no line named", { itemId: undefined }, 400, "Say which line the garments are for."],
    ["an order that doesn't exist", { orderId: "NOPE-1" }, 404, "Order not found"],
    ["a line that isn't on it", { itemId: 999999 }, 400, "That line isn't on this order. Reload the order and try again."],
    ["a line that isn't the customer's own", { itemId: acPlain }, 409, "That line isn't marked as the customer's own garments."],
  ]) {
    const got = await undo(extra);
    ok("refused — " + what + ": " + status, got.status === status && got.body.message === msg && !!lineRow("AC").ownReceivedAt && audits("order.garments_checkin_undone", "AC").length === u0);
  }
  q("UPDATE orders SET voidedAt = ? WHERE orderId = 'AC'", T(20));
  r = await undo();
  ok("refused — a voided order: 409", r.status === 409 && r.body.message === "This order is voided." && !!lineRow("AC").ownReceivedAt);
  q("UPDATE orders SET voidedAt = NULL WHERE orderId = 'AC'");
  d1._raw.exec("CREATE TRIGGER no_audit_405 BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log unavailable'); END;");
  r = await undo();
  ok("the audit log can't be written: 503 and the check-in stays", r.status === 503 && /audit log/.test(r.body.message) && !!lineRow("AC").ownReceivedAt &&
    q("SELECT count(*) AS n FROM garment_checkins WHERE orderId = 'AC' AND voidedAt IS NULL")[0].n === 1);
  d1._raw.exec("DROP TRIGGER no_audit_405;");
  const liveBefore = q("SELECT size, expectedQty, receivedQty FROM garment_checkins WHERE orderId = 'AC' AND voidedAt IS NULL");
  const receivedBefore = lineRow("AC").ownReceivedAt;
  r = await undo();
  au = audits("order.garments_checkin_undone", "AC").pop();
  ok("undone: 200 with the rows (all voided now), the order waiting again", r.status === 200 && r.body.itemId === acOwn && r.body.checkins.every(c => c.voidedAt) &&
    r.body.order.ownGarments.waiting === 1 && lineRow("AC").ownReceivedAt === null);
  ok("…audited as order.garments_checkin_undone with what was taken back", !!au && au.d.itemId === acOwn && au.d.before.ownReceivedAt === receivedBefore &&
    same(au.d.before.counts.map(c => [c.size, c.expected, c.received]), liveBefore.map(c => [c.size, c.expectedQty, c.receivedQty])));
  r = await undo();
  ok("Undo again: 409 “Nothing has been checked in for that line.” (written to the audit first, nothing else changes)", r.status === 409 && r.body.message === "Nothing has been checked in for that line.");
  await lib.checkInGarments(d1, { orderId: "AC", itemId: acOwn, counts: counts3, at: T(19) });
  q("UPDATE orders SET completedAt = ? WHERE orderId = 'AC'", T(20));
  r = await undo();
  ok("…Undo on a completed order: 409 “This order is completed.” from db.js, and the check-in stays", r.status === 409 && r.body.message === "This order is completed." && lineRow("AC").ownReceivedAt === T(19));
  q("UPDATE orders SET completedAt = NULL WHERE orderId = 'AC'");

  console.log("\n=== Local sale, Edit items and quotes: a line marked as the customer's own ===");
  let n = 0;
  const saleItems = (owned) => [{ productId: "hood", size: "L", customUnitPrice: 9, qty: 4, ...(owned === undefined ? {} : { customerOwned: owned }) }];
  const sale = (owned, who = "admin") => as(who, { action: "createLocalSale", org: "club", requestId: "req405x" + (++n), items: saleItems(owned), paymentMethod: "Cash", paid: true });
  globalThis.__f405 = { ownGarments: false };
  const orders0 = q("SELECT count(*) AS n FROM orders")[0].n;
  r = await sale(true);
  ok("Local sale while off: 400 with the switch's message and a full stop, the feature named, no order", r.status === 400 && r.body.message === OFF_MSG + "." && r.body.feature === "ownGarments" &&
    q("SELECT count(*) AS n FROM orders")[0].n === orders0);
  globalThis.__f405 = {};
  ok("…a catalog without the key is off too", (await sale(true)).status === 400 && q("SELECT count(*) AS n FROM orders")[0].n === orders0);
  r = await sale(false);
  const plainSale = r.body.orderId;
  ok("…a line not marked (false) is a sale as ever", r.status === 200 && Number(lineRow(plainSale).customerOwned) === 0);
  globalThis.__f405 = { ownGarments: true };
  r = await sale(true);
  const saleId = r.body.orderId;
  ok("Local sale while on: the line is the customer's own, priced as typed", r.status === 200 && Number(lineRow(saleId).customerOwned) === 1 && Number(lineRow(saleId).lineTotalCents) === 3600);
  au = audits("order.created_local_sale", saleId).pop();
  ok("…its audit row counts the customer's own lines", !!au && au.d.customerOwnedLines === 1);
  ok("…a sale without one says nothing of them", audits("order.created_local_sale", plainSale).length === 1 && !("customerOwnedLines" in audits("order.created_local_sale", plainSale)[0].d));
  r = await sale("yes");
  ok("…only a true marks a line", r.status === 200 && Number(lineRow(r.body.orderId).customerOwned) === 0);

  const editLine = Number(lineRow(saleId).id);
  const edit = (change) => admin({ action: "editOrder", orderId: saleId, ...change });
  const upd = (owned) => ({ itemId: editLine, productId: "hood", size: "L", qty: 4, ...(owned === undefined ? {} : { customerOwned: owned }) });
  globalThis.__f405 = { ownGarments: false };
  r = await edit({ additions: [{ productId: "hood", size: "L", qty: 1, customerOwned: true }] });
  ok("Edit items while off: adding a customer's own line is refused (400, the message)", r.status === 400 && r.body.message === OFF_MSG + "." && q("SELECT count(*) AS n FROM order_items WHERE orderId = ?", saleId)[0].n === 1);
  r = await edit({ updates: [upd(true)] });
  ok("…marking a line is refused", r.status === 400 && r.body.message === OFF_MSG + ".");
  r = await edit({ updates: [upd(false)] });
  ok("…unmarking one always works", r.status === 200 && Number(lineRow(saleId).customerOwned) === 0);
  globalThis.__f405 = { ownGarments: true };
  r = await edit({ updates: [upd(true)], additions: [{ productId: "hood", size: "L", qty: 1, customerOwned: true }] });
  ok("Edit items while on: a line marked and a line added as the customer's own", r.status === 200 && Number(lineRow(saleId).customerOwned) === 1 && Number(lineRow(saleId, 1).customerOwned) === 1);
  r = await edit({ updates: [upd()] });
  ok("…a change that doesn't name it keeps the mark", r.status === 200 && Number(lineRow(saleId).customerOwned) === 1);

  r = await admin({ action: "createEstimate", org: "club", customerId: 1, title: "Example Club caps" });
  const estId = r.body.id;
  const saveQ = (items) => admin({ action: "saveEstimate", id: estId, items });
  globalThis.__f405 = { ownGarments: false };
  r = await saveQ([{ kind: "custom", name: "Decoration", qty: 2, unitPrice: 7, customerOwned: true }]);
  ok("a quote's line marked while off: 400 with the message", r.status === 400 && r.body.message === OFF_MSG + "." && q("SELECT count(*) AS n FROM estimate_items WHERE estimateId = ?", estId)[0].n === 0);
  globalThis.__f405 = { ownGarments: true };
  r = await saveQ([{ kind: "fee", feeKind: "setup", amount: 10, customerOwned: true }]);
  ok("a fee can't be the customer's own garment (400)", r.status === 400 && /a fee can't be the customer's own garment\.$/.test(r.body.message));
  r = await saveQ([{ kind: "custom", name: "Decoration", qty: 2, unitPrice: 7, customerOwned: true }, { kind: "product", productId: "tee", size: "L", qty: 1, customerOwned: true }, { kind: "custom", name: "Patch", qty: 1, unitPrice: 3 }]);
  ok("while on: product and custom lines saved as the customer's own, the other line not", r.status === 200 &&
    same(q("SELECT customerOwned FROM estimate_items WHERE estimateId = ? ORDER BY position", estId).map(x => Number(x.customerOwned)), [1, 1, 0]));
  globalThis.__f405 = { ownGarments: false };
  await lib.setFeatures(d1, { ownGarments: false });
  r = await admin({ action: "convertEstimate", id: estId });
  const conv = r.body.orderId;
  ok("the switch turned off after: the quote still becomes an order, its lines still the customer's own",
    r.status === 200 && same(q("SELECT customerOwned FROM order_items WHERE orderId = ? ORDER BY id", conv).map(x => Number(x.customerOwned)), [1, 1, 0]));
  ok("…and that order waits for the garments", same((await lib.getOrderById(d1, conv)).ownGarments, { lines: 2, waiting: 2 }));
  await lib.setFeatures(d1, { ownGarments: true });
  globalThis.__f405 = { ownGarments: true };

  console.log("\n=== A database from before migrations/0121 ===");
  const old = await freshDb("0121");
  const lo = (o) => lib.insertOrder(old, { orderId: o, orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: T(2), paid: true }, [{ productId: "__custom__", name: "Logo", type: "other", size: "L", qty: 1, unitPrice: 5 }]);
  await lo("OLD-1");
  const oldLine = Number(old.q("SELECT id FROM order_items WHERE orderId = 'OLD-1'")[0].id);
  old.q("UPDATE orders SET paid = 1 WHERE orderId = 'OLD-1'");
  o = await lib.getOrderById(old, "OLD-1");
  ok("orders still read: no line is the customer's own and nothing waits", o && o.items[0].customerOwned === false && o.items[0].ownReceivedAt === "" && same(o.ownGarments, { lines: 0, waiting: 0 }) &&
    !("checkins" in o.items[0]));
  ok("…the queues, the stages and the backlog still answer", Array.isArray(await lib.getProductionQueue(old)) && Array.isArray((await lib.getRunQueue(old)).transfers.ready) &&
    (await lib.getPaidUnrunOrders(old)).find(x => x.orderId === "OLD-1").garmentsStatus === "" && (await lib.getOpenOrderStages(old)).length === 1);
  ok("…Blanks to order and the cost catch-up still answer", !!(await lib.getBlanksToOrder(old)) && Array.isArray((await lib.planBlankCatchUp(old)).lines));
  const NOT_READY = "Customer-supplied garments aren't ready yet: the database needs its latest update (migrations/0121).";
  ok("checkInGarments and Undo say the database needs its update", (await lib.checkInGarments(old, { orderId: "OLD-1", itemId: oldLine, counts: good })).error === NOT_READY &&
    (await lib.undoGarmentCheckin(old, { orderId: "OLD-1", itemId: oldLine })).error === NOT_READY);
  ok("listGarmentCheckins is an empty list", same(await lib.listGarmentCheckins(old, "OLD-1"), []));
  await lib.consumeBlanksForOrder(old, "OLD-1", T(9));
  ok("a line is still made there", Number(old.q("SELECT manufacturedQty FROM order_items WHERE id = ?", oldLine)[0].manufacturedQty) === 1);
  r = await admin({ action: "checkInGarments", orderId: "OLD-1", itemId: oldLine, counts: [{ size: "L", expectedQty: 1, receivedQty: 1 }] }, old);
  ok("the action there: 409, the line isn't the customer's own (no line can be yet)", r.status === 409 && r.body.message === "That line isn't marked as the customer's own garments.");
  old.execFile(read("migrations/0121_terms_and_own_garments.sql"));
  ok("the migration: every existing line is not the customer's own and waits for nothing", Number(old.q("SELECT customerOwned FROM order_items")[0].customerOwned) === 0 &&
    old.q("SELECT ownReceivedAt FROM order_items")[0].ownReceivedAt === null && old.q("SELECT count(*) AS n FROM garment_checkins")[0].n === 0);
  ok("…a line is the customer's own or not (0 or 1), and a condition is one of the three", (() => { try { old._raw.exec("UPDATE order_items SET customerOwned = 2"); return false; } catch (e) { return true; } })() &&
    (() => { try { old._raw.exec(`INSERT INTO garment_checkins (orderId, itemId, condition, at) VALUES ('OLD-1', ${oldLine}, 'wet', 't')`); return false; } catch (e) { return true; } })());
  ok("schema.sql and the migration list have it", /customerOwned\s+INTEGER NOT NULL DEFAULT 0/.test(read("schema.sql")) && /CREATE TABLE IF NOT EXISTS garment_checkins/.test(read("schema.sql")) &&
    read("functions/_lib/migrationList.js").includes('"0121_terms_and_own_garments.sql"'));

  ok("nothing was logged as an unexpected failure", !logged.some(l => /TypeError|ReferenceError|SyntaxError/.test(l)));
})().catch((e) => { console.log("crashed — " + (e && e.stack || e)); process.exitCode = 1; });
