const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader } = require("jsdom");

// Read on Blanks is stock and details only, no money (owner's decision, 2026-11-23) — and the same for Transfers. A
// blank or transfer stock movement used to reach a read-only role without costs.view with its receipt (the vendor's
// invoice: unit prices and totals) and, for blanks received with shipping, a note naming the landed cost
// ("Received (landed cost incl. $2.50 shipping & other costs)"). Now, for a role without costs.view or Edit there:
//   - getBlankMovements and getTransferMovements leave out receiptKey and receiptName (with the unit cost, as before);
//   - the note's landed-cost part is taken out when read, so notes stored before this change are covered too (the
//     amount stays in the stored note: moving it to a field of its own needs a migration, and the read-time strip
//     already keeps it from these roles);
//   - Blanks → History shows the Receipt button only to whoever is sent costs (adminSeesBlankCosts_).
// costs.view, or Edit on Blanks / Transfers, gets every movement as before. (Opening a receipt: receipt.js, test298.)
// Real SQL (sql.js) + real db.js, permissions.js and orders.js; the real admin page in jsdom. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createBlank, createTransfer, receiveBlanks, receiveTransferSheet };")();
// The gate as adminAuth.js runs it, for the role this test is acting as (__as.role; null = everything), as test251.
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const __as = { role: null };\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => !__as.role || roleAllows(__as.role, need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden', message: 'Your role can\\'t do this.' }), { status: 403 });\n" +
  "const adminActor = () => 'pat@example.test';\n" +
  "const adminUser = () => __as.role ? { id: 7, role: __as.role.key, roleInfo: __as.role } : null;\n" +
  "const adminCan = (request, fn, level) => !__as.role || permRank(effectiveLevel(__as.role, fn)) >= permRank(level || 'read');\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, as: __as, normalizePermissions };")();

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };
const tick = (ms) => new Promise(r => setTimeout(r, ms || 40));
const role = (key, fns) => ({ key, name: key, rank: 10, locked: false, builtIn: false, permissions: api.normalizePermissions({ fns }) });

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const env = { DB: d1, ROOT_DOMAIN: "example.com" };
  const call = async (body, as = null) => {
    api.as.role = as;
    const full = Object.assign({ key: "x" }, body);
    const req = { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    const res = await api.post({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: req });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const KEY = "receipts/2026/" + "c".repeat(32) + ".pdf", TKEY = "receipts/2026/" + "d".repeat(32) + ".pdf";
  const blankId = (await lib.createBlank(d1, { name: "Sample Tee", productType: "tee", brand: "Sample Brand", sku: "ST-1", vendor: "",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: 0, purchasePrice: 0 }] }] })).id;
  await call({ action: "saveVendor", vendor: { name: "Sample Vendor", forBlanks: true } });
  // Received through Blanks → Receive (the API writes the note), with $2.50 of shipping…
  let r = await call({ action: "receiveBlanks", blankId, lines: [{ color: "Navy", size: "M", qty: 10, unitCost: 4 }], extraCost: 2.5, vendor: "Sample Vendor", vendorRef: "INV-7", receivedAt: "2026-10-02" });
  ok("received with shipping (by the owner)", r.status === 200);
  // …one recorded before this change with its invoice and a larger landed cost, and one without shipping.
  await lib.receiveBlanks(d1, { blankId, lines: [{ color: "Navy", size: "M", qty: 5, unitCost: 4.4 }], vendor: "Sample Vendor", vendorRef: "INV-8",
    receivedAt: "2026-10-03T12:00:00.000Z", note: "Received (landed cost incl. $1,234.50 shipping & other costs)", receiptKey: KEY, receiptName: "inv-8.pdf" });
  await lib.receiveBlanks(d1, { blankId, lines: [{ color: "Navy", size: "M", qty: 2, unitCost: 4 }], vendor: "Sample Vendor", vendorRef: "INV-9",
    receivedAt: "2026-10-04T12:00:00.000Z", note: "Received", receiptKey: KEY, receiptName: "inv-9.pdf" });
  ok("the stored notes keep the landed cost (only reading takes it out)", d1.q("SELECT COUNT(*) n FROM inventory_movements WHERE note LIKE '%landed cost incl.%'")[0].n === 2);
  const transferId = await lib.createTransfer(d1, { name: "Crest transfer" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId, count: 10, pctOfSheet: 100 }], totalCents: 2500, vendor: "Sample Transfer Co", vendorRef: "T-1",
    receivedAt: "2026-10-05T12:00:00.000Z", paidPersonally: true, note: "Received (landed cost incl. $3.00 shipping & other costs)", receiptKey: TKEY, receiptName: "sheet.pdf" });

  const blanksRead = role("blanksRead", { "inventory.blanks": "read" });
  const blanksReadCosts = role("blanksReadCosts", { "inventory.blanks": "read", "costs.view": "read" });
  const blanksEdit = role("blanksEdit", { "inventory.blanks": "edit" });
  const transfersRead = role("transfersRead", { "inventory.transfers": "read" });
  const transfersReadCosts = role("transfersReadCosts", { "inventory.transfers": "read", "costs.view": "read" });
  const transfersEdit = role("transfersEdit", { "inventory.transfers": "edit" });
  const blankMoves = async (as) => (await call({ action: "getBlankMovements", blankId }, as)).body.movements;
  const transferMoves = async (as) => (await call({ action: "getTransferMovements", transferId }, as)).body.movements;
  const byRef = (list, ref) => list.find(m => m.vendorRef === ref);
  const MONEY = /"(receiptKey|receiptName|unitCost|unitCostCents|cost)":|landed cost|\$/;

  console.log("=== Blanks → History ===");
  const A = await blankMoves(null);
  ok("the owner's: the receipt, its name, the unit cost and the note's landed cost", byRef(A, "INV-8").receiptKey === KEY && byRef(A, "INV-8").receiptName === "inv-8.pdf" &&
    byRef(A, "INV-8").unitCost > 0 && byRef(A, "INV-7").note === "Received (landed cost incl. $2.50 shipping & other costs)");
  const L = await blankMoves(blanksRead);
  ok("Read on Blanks: every movement, its quantity, vendor and invoice number", L.length === 3 && byRef(L, "INV-8").qtyDelta === 5 && byRef(L, "INV-8").vendor === "Sample Vendor");
  ok("…no receipt, receipt name or unit cost on any of them", L.every(m => !("receiptKey" in m) && !("receiptName" in m) && !("unitCost" in m)));
  ok("…and the note reads Received, without the landed cost (a new note and one stored before alike)", byRef(L, "INV-7").note === "Received" && byRef(L, "INV-8").note === "Received" &&
    byRef(L, "INV-9").note === "Received" && !MONEY.test(JSON.stringify(L)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok("Read on Blanks with costs.view: as the owner's", same(await blankMoves(blanksReadCosts), A));
  ok("Edit on Blanks: as the owner's", same(await blankMoves(blanksEdit), A));

  console.log("\n=== Transfers → History ===");
  const TA = await transferMoves(null), TL = await transferMoves(transfersRead);
  ok("the owner's: the sheet's receipt and unit cost", TA[0].receiptKey === TKEY && TA[0].unitCost === 2.5 && /landed cost/.test(TA[0].note));
  ok("Read on Transfers: the purchase and its count, vendor and % of sheet — no receipt, unit cost or landed cost",
    TL.length === 1 && TL[0].qtyDelta === 10 && TL[0].vendor === "Sample Transfer Co" && TL[0].pctOfSheet === 100 && TL[0].note === "Received" && !MONEY.test(JSON.stringify(TL)));
  ok("Read on Transfers with costs.view, and Edit on Transfers: as the owner's", same(await transferMoves(transfersReadCosts), TA) && same(await transferMoves(transfersEdit), TA));
  ok("the landed-cost strip leaves other notes alone", (() => {
    const src = read("functions/api/orders.js"), m = src.match(/const LANDED_NOTE_RE_ = (\/.*\/g);/);
    const re = m && new Function("return " + m[1])();
    return !!re && "Damaged in the press (stock count)".replace(re, "") === "Damaged in the press (stock count)" &&
      "Received (landed cost incl. $12.00 shipping & other costs)".replace(re, "") === "Received";
  })());

  console.log("\n=== Blanks → History in the page: the Receipt button only for whoever is sent costs ===");
  const adminJs = read("public/admin.js");
  class Loader extends ResourceLoader { fetch(url) { return Promise.resolve(Buffer.from(url.includes("/admin.js") ? adminJs : "")); } }
  // Opens a blank's History as a role with `perms`, answered with `moves` (what the server sends that role).
  const history = async (perms, moves) => {
    const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), url: "https://admin.example.com/", pretendToBeVisual: true,
      beforeParse(win) {
        win.fetch = async (url, opts) => {
          const body = opts && opts.body ? JSON.parse(opts.body) : {};
          const j = (x) => ({ ok: true, status: 200, json: async () => x });
          if (!body.action) return j({ status: "admin", business: {}, country: "US" });
          if (body.action === "getBlankMovements") return j({ status: "ok", movements: moves });
          return j({ status: "ok" });
        };
      } });
    const w = dom.window;
    await tick(150);
    await w.loadAdminScript();
    w.eval(`adminKey = "cookie"; adminMe = { role: "custom" }; adminPerms = ${JSON.stringify(perms)};`);
    w.showBlankHistoryModal({ id: blankId, name: "Sample Tee" }, () => {});
    await tick(120);
    const body = w.document.getElementById("histBody");
    return { text: body ? body.textContent : "", receipts: body ? body.querySelectorAll('[data-admin-action="expViewReceipt_"]').length : -1 };
  };
  const pageRead = await history({ "inventory.blanks": "read" }, L);
  ok("Read on Blanks: the three movements, no Receipt button, no dollar amount or landed cost", /INV-8/.test(pageRead.text) && pageRead.receipts === 0 &&
    !/\$|landed cost|NaN/.test(pageRead.text));
  // Even if a receipt reached the page (an older server), the button stays hidden for this role.
  const pageReadLeak = await history({ "inventory.blanks": "read" }, A);
  ok("…and the button stays hidden for that role even when a movement carries a receipt", pageReadLeak.receipts === 0);
  const pageCosts = await history({ "inventory.blanks": "read", "costs.view": "read" }, A);
  ok("with costs.view: a Receipt button on each of the two received with an invoice", pageCosts.receipts === 2 && /\$4\.40/.test(pageCosts.text));
  const pageEdit = await history({ "inventory.blanks": "edit" }, A);
  ok("Edit on Blanks: the same", pageEdit.receipts === 2);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.log("test297 crashed:", false); console.error(e); process.exit(1); });
