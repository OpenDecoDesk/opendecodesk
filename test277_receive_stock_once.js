const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { seedVendors } = require("./testlib/vendors.js");

// Received stock is recorded once per Save of its form (2026-11, migrations/0107). Record order, Receive blanks and
// Receive transfer sheet took no key, so pressing the button again after a dropped answer — or after a failure
// part-way through an order of several blanks, which is written blank by blank — put the same purchase into stock,
// the average cost and the paying account twice, and the R&D expense and the personal-use draw with it. Now the
// form sends a key made when it opens (`requestId`, as the payment forms do — migrations/0095): each movement
// carries its own key under it and is written, with its stock, only if no movement has that key yet; the expense
// and the draw are found again by the receipt group worked out from the key. The same request again writes only
// what is missing and answers as the first one did. Without a key, nothing changes.
// Real migrations, schema.sql, db.js, permissions.js and orders.js on sql.js. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createTransfer, receiveBlanks, receiveBlanksOnce, receiveTransferSheet, receiveTransferSheetOnce, receiptGroupForKey };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));

  console.log("=== The migration ===");
  const hasKey = (db, table) => db.q(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = 'requestKey'`).length === 1;
  const uniqueIdx = (db, name) => (r => !!r && /UNIQUE/i.test(r.sql) && /requestKey IS NOT NULL/i.test(r.sql))(db.q("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", name)[0]);
  ok("0107 adds requestKey to blank and transfer movements, each with a unique index over the keys given",
    hasKey(d1, "inventory_movements") && hasKey(d1, "transfer_movements") && uniqueIdx(d1, "idx_movements_request_key") && uniqueIdx(d1, "idx_transfer_movements_request_key"));
  {
    const fresh = await createD1();
    fresh._raw.exec(read("schema.sql"));
    ok("schema.sql has them for a new install", hasKey(fresh, "inventory_movements") && hasKey(fresh, "transfer_movements") && uniqueIdx(fresh, "idx_movements_request_key") && uniqueIdx(fresh, "idx_transfer_movements_request_key"));
  }

  seedVendors(d1, ["Example Supply", "Example Prints"]);   // the vendor list the receive forms check names against
  // Two blanks, two transfers, an account to pay from and an expense category.
  const blank = async (name) => (await lib.createBlank(d1, { name, productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "M", purchasePrice: 0, quantity: 0 }, { size: "L", purchasePrice: 0, quantity: 0 }] }] })).id;
  const b1 = await blank("Example tee blank"), b2 = await blank("Example hoodie blank");
  const t1 = await lib.createTransfer(d1, { name: "Lockup" }), t2 = await lib.createTransfer(d1, { name: "Sleeve" });
  const account = d1.q("SELECT id FROM accounts WHERE active = 1 ORDER BY id LIMIT 1")[0].id;
  d1._raw.run("INSERT INTO expense_categories (name, deductionType, createdAt, updatedAt) VALUES ('Example testing', 'deductible', 't', 't')");
  const cat = d1.q("SELECT id FROM expense_categories WHERE name = 'Example testing'")[0].id;

  const pending = [];
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    while (pending.length) await pending.shift();
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  // A request the server fails part-way: one write throws — the first stock write ("batch") once `when` says so
  // (a number: the n-th), or the first statement whose SQL matches `match`.
  const failing = async (match, when, run) => {
    const batch = d1.batch.bind(d1), prepare = d1.prepare.bind(d1);
    let seen = 0, tripped = false;
    const trip = () => { seen++; if (!tripped && (typeof when === "function" ? when() : seen === when)) { tripped = true; throw new Error("connection lost"); } };
    if (match === "batch") d1.batch = async (stmts) => { trip(); return batch(stmts); };
    else d1.prepare = (sql) => { if (match.test(String(sql))) trip(); return prepare(sql); };
    let out;
    try { out = await run(); } catch (e) { out = { status: 500, body: { status: "error", message: String(e && e.message) } }; }
    finally { d1.batch = batch; d1.prepare = prepare; }
    return { out, tripped };
  };
  const qty = (blankId, size) => (d1.q("SELECT quantity q FROM blank_sizes WHERE blankId = ? AND color = 'Navy' AND size = ?", blankId, size)[0] || { q: 0 }).q;
  const avg = (blankId, size) => (d1.q("SELECT purchasePriceCents c FROM blank_sizes WHERE blankId = ? AND color = 'Navy' AND size = ?", blankId, size)[0] || { c: 0 }).c;
  const tq = (id) => d1.q("SELECT quantity q, purchasePriceCents c FROM transfers WHERE id = ?", id)[0];
  const count = (table, where = "1=1") => d1.q(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`)[0].n;
  const audits = (action) => count("audit_log", `action = '${action}'`);
  const today = new Date().toISOString().slice(0, 10);

  console.log("\n=== Record order: the same request sent twice ===");
  const orderBody = (requestId, extra = {}) => ({ action: "receiveBlankOrder", ...(requestId ? { requestId } : {}), receivedAt: today, accountId: account, vendor: "Example Supply", vendorRef: "INV-1",
    groups: [{ blankId: b1, lines: [{ color: "Navy", size: "M", qty: 10, unitCost: 4 }, { color: "Navy", size: "L", qty: 5, unitCost: 5 }] },
             { blankId: b2, lines: [{ color: "Navy", size: "L", qty: 4, unitCost: 12 }] }],
    extraCost: 7, rdAmount: 20, rdCategoryId: cat, personalAmount: 15, ...extra });
  let r = await call(orderBody("req-order-0001"));
  if (r.status !== 200) console.error("first Record order answered", r.status, JSON.stringify(r.body).slice(0, 300));
  ok("the order is recorded", r.status === 200 && r.body.status === "ok" && r.body.total > 0);
  const first = { total: r.body.total, parts: r.body.parts };
  const after1 = { m: count("inventory_movements"), e: count("expenses"), d: count("owner_transactions"), q: [qty(b1, "M"), qty(b1, "L"), qty(b2, "L")], a: [avg(b1, "M"), avg(b1, "L"), avg(b2, "L")] };
  ok("stock went up (10 M, 5 L, 4 L), with one R&D expense and one personal draw", same(after1.q, [10, 5, 4]) && after1.e === 1 && after1.d === 1);
  const group = await lib.receiptGroupForKey("blankOrder:req-order-0001");
  ok("every movement carries its own key under the form's, and the whole receive is one receipt group",
    (rows => rows.length === after1.m && new Set(rows.map(x => x.requestKey)).size === rows.length && rows.every(x => x.requestKey.startsWith("blankOrder:req-order-0001:") && x.receiptGroup === group))(
      d1.q("SELECT requestKey, receiptGroup FROM inventory_movements WHERE kind = 'purchase'"))
    && d1.q("SELECT receiptGroup g FROM expenses")[0].g === group && d1.q("SELECT receiptGroup g FROM owner_transactions")[0].g === group && /^[a-f0-9]{24}$/.test(group));
  r = await call(orderBody("req-order-0001"));
  const after2 = { m: count("inventory_movements"), e: count("expenses"), d: count("owner_transactions"), q: [qty(b1, "M"), qty(b1, "L"), qty(b2, "L")], a: [avg(b1, "M"), avg(b1, "L"), avg(b2, "L")] };
  ok("the same request again is answered ok with the same total and parts (so the form closes as usual)", r.status === 200 && r.body.status === "ok" && r.body.total === first.total && same(r.body.parts, first.parts));
  ok("…and nothing is recorded twice: stock, average costs, movements, the expense and the draw are as they were", same(after2, after1));
  ok("…nor audited twice", audits("inventory.order_received") === 1 && audits("inventory.received") === 2);
  ok("the account was charged once", d1.q("SELECT COALESCE(SUM(qtyDelta * unitCostCents), 0) c FROM inventory_movements WHERE kind = 'purchase' AND accountId = ?", account)[0].c
    + d1.q("SELECT COALESCE(SUM(amountCents), 0) c FROM expenses")[0].c + d1.q("SELECT COALESCE(SUM(amountCents), 0) c FROM owner_transactions")[0].c === Math.round(first.total * 100));

  console.log("\n=== Record order: a failure part-way, then the same request again ===");
  // The first blank is written in full (as many movements as the first order gave it); the next write — the
  // second blank's — fails.
  const b1Rows = count("inventory_movements", `vendorRef = 'INV-1' AND blankId = ${b1}`);
  let f = await failing("batch", () => count("inventory_movements", `vendorRef = 'INV-2' AND blankId = ${b1}`) === b1Rows, () => call(orderBody("req-order-0002", { vendorRef: "INV-2" })));
  ok("the request fails after the first blank is in", f.tripped && f.out.status >= 500 && same([qty(b1, "M"), qty(b1, "L"), qty(b2, "L")], [20, 10, 4]) && count("expenses") === 1);
  r = await call(orderBody("req-order-0002", { vendorRef: "INV-2" }));
  ok("the retry is recorded", r.status === 200 && r.body.total === first.total);
  ok("…filling in only what was missing: the second blank, the R&D expense and the draw (the first blank isn't received twice)",
    same([qty(b1, "M"), qty(b1, "L"), qty(b2, "L")], [20, 10, 8]) && count("expenses") === 2 && count("owner_transactions") === 2 && count("inventory_movements", "kind = 'purchase'") === 2 * after1.m);
  ok("…and both tries' records share one receipt group", new Set(d1.q("SELECT receiptGroup g FROM inventory_movements WHERE vendorRef = 'INV-2'").map(x => x.g)).size === 1
    && d1.q("SELECT COUNT(*) n FROM expenses WHERE receiptGroup = (SELECT receiptGroup FROM inventory_movements WHERE vendorRef = 'INV-2' LIMIT 1)")[0].n === 1);
  // The stock is all in; the R&D expense's write fails.
  f = await failing(/INSERT INTO expenses/, 1, () => call(orderBody("req-order-0003", { vendorRef: "INV-3" })));
  ok("a failure after the stock, before the R&D expense", f.tripped && f.out.status >= 500 && qty(b2, "L") === 12 && count("expenses") === 2);
  r = await call(orderBody("req-order-0003", { vendorRef: "INV-3" }));
  ok("…the retry adds the expense and the draw, and no stock", r.status === 200 && qty(b2, "L") === 12 && qty(b1, "M") === 30 && count("expenses") === 3 && count("owner_transactions") === 3);
  r = await call(orderBody("req-order-0003", { vendorRef: "INV-3" }));
  ok("…and a third time changes nothing", r.status === 200 && qty(b1, "M") === 30 && count("expenses") === 3 && count("owner_transactions") === 3);

  console.log("\n=== Without a key, and with a new one ===");
  await call(orderBody("", { vendorRef: "INV-4" })); await call(orderBody("", { vendorRef: "INV-4" }));
  ok("a request with no requestId (an older page, a script) is recorded each time, as before", qty(b1, "M") === 50 && count("expenses") === 5);
  ok("…and its movements carry no key", count("inventory_movements", "vendorRef = 'INV-4' AND requestKey IS NOT NULL") === 0);
  await call(orderBody("short", { vendorRef: "INV-5" })); await call(orderBody("short", { vendorRef: "INV-5" }));
  ok("a requestId that isn't a key (too short) counts as none", qty(b1, "M") === 70);
  await call(orderBody("req-order-0004", { vendorRef: "INV-6" }));
  ok("a new form's key is a new receive", qty(b1, "M") === 80);

  console.log("\n=== Receive blanks (one blank) ===");
  const one = (requestId) => ({ action: "receiveBlanks", ...(requestId ? { requestId } : {}), blankId: b2, receivedAt: today, lines: [{ color: "Navy", size: "M", qty: 6, unitCost: 10 }, { color: "Navy", size: "L", qty: 2, unitCost: 11 }], extraCost: 4 });
  const l0 = qty(b2, "L"), audited = audits("inventory.received");
  r = await call(one("req-blanks-0001")); const r2 = await call(one("req-blanks-0001"));
  ok("the same request twice is received once, and both are answered ok", r.status === 200 && r2.status === 200 && r2.body.status === "ok" && qty(b2, "M") === 6 && qty(b2, "L") === l0 + 2);
  ok("…and audited once", audits("inventory.received") === audited + 1);
  f = await failing("batch", () => count("inventory_movements", "requestKey LIKE 'receiveBlanks:req-blanks-0002:%'") > 0, () => call(one("req-blanks-0002")));
  r = await call(one("req-blanks-0002"));
  ok("a failure between its sizes, then the retry: each size once", f.tripped && r.status === 200 && qty(b2, "M") === 12 && qty(b2, "L") === l0 + 4);
  await call(one("")); await call(one(""));
  ok("without a key it is received each time", qty(b2, "M") === 24);

  console.log("\n=== Receive transfer sheet ===");
  const sheet = (requestId, extra = {}) => ({ action: "receiveTransferSheet", ...(requestId ? { requestId } : {}), receivedAt: today, total: 100, vendor: "Example Prints", vendorRef: "SH-1", accountId: account,
    rows: [{ transferId: t1, count: 10, pctOfSheet: 50 }, { transferId: t2, count: 20, pctOfSheet: 30 }],
    writeoff: { pct: 12, description: "Misprints", categoryId: cat }, personal: { pct: 8, description: "A gift" }, ...extra });
  const eBefore = count("expenses"), dBefore = count("owner_transactions");
  r = await call(sheet("req-sheet-0001"));
  ok("the sheet is received: 10 and 20 into stock, the written-off part an expense, the personal part a draw",
    r.status === 200 && tq(t1).q === 10 && tq(t2).q === 20 && count("expenses") === eBefore + 1 && count("owner_transactions") === dBefore + 1 && r.body.writeoff.expenseId > 0 && r.body.personal.ownerEntryId > 0);
  const s1 = { ids: r.body.ids, wo: r.body.writeoff, pe: r.body.personal, t: [tq(t1), tq(t2)] };
  r = await call(sheet("req-sheet-0001"));
  ok("the same request again: the same answer (the same movements, expense and draw)", r.status === 200 && same(r.body.ids, s1.ids) && same(r.body.writeoff, s1.wo) && same(r.body.personal, s1.pe));
  ok("…and nothing recorded twice", same([tq(t1), tq(t2)], s1.t) && count("expenses") === eBefore + 1 && count("owner_transactions") === dBefore + 1 && count("transfer_movements") === s1.ids.length && audits("transfer.received") === 1);
  f = await failing("batch", 2, () => call(sheet("req-sheet-0002", { vendorRef: "SH-2" })));
  ok("a failure after the sheet's first row", f.tripped && f.out.status >= 500 && tq(t1).q === 20 && tq(t2).q === 20);
  r = await call(sheet("req-sheet-0002", { vendorRef: "SH-2" }));
  ok("…the retry adds the second row, the expense and the draw only", r.status === 200 && tq(t1).q === 20 && tq(t2).q === 40 && count("expenses") === eBefore + 2 && count("owner_transactions") === dBefore + 2);
  await call(sheet("", { vendorRef: "SH-3" })); await call(sheet("", { vendorRef: "SH-3" }));
  ok("without a key the sheet is received each time, as before", tq(t1).q === 40 && tq(t2).q === 80 && count("transfer_movements", "vendorRef = 'SH-3' AND requestKey IS NOT NULL") === 0);
  ok("the transfers' history adds up to their stock", [t1, t2].every(id => d1.q("SELECT COALESCE(SUM(qtyDelta), 0) s FROM transfer_movements WHERE transferId = ? AND voidedAt IS NULL", id)[0].s === tq(id).q));
  ok("the blanks' history adds up to their stock", [[b1, "M"], [b1, "L"], [b2, "M"], [b2, "L"]].every(([id, size]) =>
    d1.q("SELECT COALESCE(SUM(qtyDelta), 0) s FROM inventory_movements WHERE blankId = ? AND size = ? AND voidedAt IS NULL", id, size)[0].s === qty(id, size)));

  console.log("\n=== The functions themselves ===");
  const args = { blankId: b1, lines: [{ color: "Navy", size: "M", qty: 3, unitCost: 4 }], receivedAt: today + "T12:00:00.000Z" };
  const m0 = qty(b1, "M");
  const a = await lib.receiveBlanksOnce(d1, { ...args, requestKey: "direct:0001" }), b = await lib.receiveBlanksOnce(d1, { ...args, requestKey: "direct:0001" });
  ok("receiveBlanksOnce: written once; the second call names the same movement and wrote nothing", a.written === 1 && b.written === 0 && same(a.ids, b.ids) && a.ids[0] > 0 && qty(b1, "M") === m0 + 3);
  const both = await Promise.all([lib.receiveBlanksOnce(d1, { ...args, requestKey: "direct:0002" }), lib.receiveBlanksOnce(d1, { ...args, requestKey: "direct:0002" })]);
  ok("…two at once: one of them writes it", both[0].written + both[1].written === 1 && qty(b1, "M") === m0 + 6);
  const plain = await lib.receiveBlanks(d1, args);
  ok("receiveBlanks still answers the new movements' ids", Array.isArray(plain) && plain.length === 1 && plain[0] > a.ids[0] && qty(b1, "M") === m0 + 9);
  const sh = { rows: [{ transferId: t1, count: 3, pctOfSheet: 100 }], totalCents: 900, receivedAt: today };
  const q0 = tq(t1).q;
  const c = await lib.receiveTransferSheetOnce(d1, { ...sh, requestKey: "direct:0003" }), d = await lib.receiveTransferSheetOnce(d1, { ...sh, requestKey: "direct:0003" });
  ok("receiveTransferSheetOnce: the same", c.written === 1 && d.written === 0 && same(c.ids, d.ids) && tq(t1).q === q0 + 3 && Array.isArray(await lib.receiveTransferSheet(d1, sh)) && tq(t1).q === q0 + 6);

  console.log("\n=== The admin's forms send the key ===");
  const adminJs = read("public/admin.js");
  const fn = (name) => adminJs.slice(adminJs.indexOf("async function " + name + "("), adminJs.indexOf("\n}\n", adminJs.indexOf("async function " + name + "(")));
  ok("Record order: a key made when the form opens, sent with every Save of it",
    (src => src.indexOf("const requestId = newRequestId_();") > 0 && src.indexOf("const requestId = newRequestId_();") < src.indexOf("save.onclick") && /action: "receiveBlankOrder", requestId,/.test(src))(fn("showReceiveOrderModal")));
  ok("Receive transfer sheet: the same (an edit of a sheet sends none)", /const requestId = newRequestId_\(\);\n  let busy = false;/.test(adminJs) && /\{ action: "editTransferSheet", movementId: ed\.seedId \} : \{ action: "receiveTransferSheet", requestId \}/.test(adminJs));

  if (failed) { console.error(failed + " check(s) failed"); process.exit(1); }
})().catch((e) => { console.error("Error:", e); process.exit(1); });
