const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { asRole } = require("./testlib/roles");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts");

// Count stock, a whole count at once (2026-11, review round 2). D1 caps the queries one Worker request may run (50 on
// the Free plan, 1,000 on Workers Paid). "Correct all remaining differences" sent every differing row in one request
// and the server took them a row at a time — a read, a name lookup, a two-statement batch and sometimes an update
// each — so a yearly count with a few hundred differences ran out of queries partway: the rows before that were
// saved, the rest weren't, and no audit entry was written. Now:
//   - the server takes at most 100 rows a request, reads the group in two queries (one for transfers) and writes it
//     in ONE batch, each row's statements still guarded on the quantity the window showed, with one audit entry;
//   - the window sends a bigger count in groups of 100, one after another, and says how far it is;
//   - what one row does is unchanged: the difference as an `adjust` at the size's average cost (its vendor price when
//     it has no cost yet and gains stock, which then becomes its first cost), refused when the stock moved.
// Real SQL (sql.js), the real db.js and orders.js, and the real count window in jsdom. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createTransfer, setBlankCount, setBlankCounts, setTransferCount, setTransferCounts, blankName_, blankScalarColor_, tookRow_, pricingError_ };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@example.test'; " + require("./testlib/roles").adminAs() + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = async (cond, n = 600) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setTimeout(r, 10)); return cond(); };

// The way one row was corrected before (db.js setBlankCount as it stood on 2026-11-25), kept here to compare with.
async function oldSetBlankCount(db, { blankId, color, size, counted, onHand, note, at }) {
  const want = Math.floor(Number(counted)), shown = Math.trunc(Number(onHand));
  if (!Number.isFinite(want) || want < 0) throw lib.pricingError_("Enter a count of 0 or more.");
  if (!Number.isFinite(shown)) throw lib.pricingError_("Reload the count window and try again.");
  const clr = color == null ? await lib.blankScalarColor_(db, blankId) : String(color), sz = String(size || "");
  const cur = await db.prepare("SELECT quantity, purchasePriceCents, vendorPriceCents FROM blank_sizes WHERE blankId=? AND color=? AND size=?").bind(Number(blankId), clr, sz).first();
  if (!cur) throw lib.pricingError_("That size isn't on file for this blank.");
  if (Number(cur.quantity) !== shown) throw lib.pricingError_(`The stock changed while you were counting (it's ${Number(cur.quantity)} now) — count that row again.`);
  const delta = want - shown;
  if (!delta) return { delta: 0 };
  const unit = Number(cur.purchasePriceCents) || (delta > 0 ? Number(cur.vendorPriceCents) || 0 : 0);
  const now = new Date().toISOString();
  const G = "(SELECT quantity FROM blank_sizes WHERE blankId=? AND color=? AND size=?) = ?", gb = [Number(blankId), clr, sz, shown];
  const res = await db.batch([
    db.prepare(`INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, note, occurredAt, createdAt)
      SELECT ?, ?, ?, ?, ?, ?, 'adjust', ?, ?, ? WHERE ${G}`)
      .bind(Number(blankId), await lib.blankName_(db, blankId), clr, sz, delta, Math.max(0, Math.round(unit)),
        String(note ? "Stock count: " + note : "Stock count").slice(0, 300), at || now, now, ...gb),
    db.prepare(`UPDATE blank_sizes SET quantity = ? WHERE blankId=? AND color=? AND size=? AND quantity = ?`).bind(want, Number(blankId), clr, sz, shown),
  ]);
  if (!lib.tookRow_(res[0])) throw lib.pricingError_("The stock changed while you were counting — count that row again.");
  if (!Number(cur.purchasePriceCents) && delta > 0 && unit) await db.prepare("UPDATE blank_sizes SET purchasePriceCents = ? WHERE blankId=? AND color=? AND size=? AND purchasePriceCents = 0").bind(unit, Number(blankId), clr, sz).run();
  return { delta };
}

// A database with `blanks` blanks of two colors × `sizes` sizes each, stock and cost set row by row:
// every third size has no cost yet (and every sixth of those a vendor price).
async function makeDb(blanks, sizes) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const rows = [];
  for (let b = 0; b < blanks; b++) {
    const names = Array.from({ length: sizes }, (_, i) => "S" + i);
    const id = (await lib.createBlank(d1, { name: "Blank " + String(b).padStart(2, "0"), productType: "tee",
      colors: ["Black", "Navy"].map(color => ({ color, images: [], sizes: names.map(size => ({ size, purchasePrice: 0, quantity: 0 })) })) })).id;
    for (const color of ["Black", "Navy"]) names.forEach((size, i) => {
      const n = rows.length, cost = n % 3 === 0 ? 0 : 300 + n, vendor = n % 3 === 0 && n % 6 === 0 ? 450 + n : null;
      d1._raw.run("UPDATE blank_sizes SET quantity=?, purchasePriceCents=?, vendorPriceCents=? WHERE blankId=? AND color=? AND size=?", [10 + (n % 7), cost, vendor, id, color, size]);
      rows.push({ blankId: id, color, size, onHand: 10 + (n % 7) });
    });
  }
  return { d1, rows };
}
// Counts database round trips: each first / all / run is one, a batch is one (its statements counted apart), and the
// audit entry (written after the answer) apart again.
function counting(d1, hooks = {}) {
  const c = { calls: 0, batches: 0, statements: 0, audit: 0 };
  const wrap = (st) => {
    const isAudit = /INSERT INTO audit_log/.test(st._sql || "");
    const tally = () => { if (isAudit) c.audit++; else c.calls++; };
    return { _sql: st._sql, _params: st._params, first: (...a) => { tally(); return st.first(...a); }, all: (...a) => { tally(); return st.all(...a); }, run: (...a) => { tally(); return st.run(...a); } };
  };
  const db = {
    prepare: (sql) => { const p = d1.prepare(sql); return Object.assign(wrap(p), { bind: (...v) => wrap(p.bind(...v)) }); },
    batch: async (stmts) => { c.calls++; c.batches++; c.statements += stmts.length; if (hooks.beforeBatch) hooks.beforeBatch(stmts); return d1.batch(stmts); },
  };
  return { db, c };
}
const caller = (db) => async (body) => {
  const waits = [];
  const res = await api({ env: { DB: db }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
    request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
  await Promise.all(waits);
  return { status: res.status, body: JSON.parse(await res.text()) };
};

(async () => {
  console.log("=== One request: 100 rows in a fixed number of queries ===");
  const { d1, rows } = await makeDb(6, 20);   // 240 sizes
  const qty = (r) => d1.q("SELECT quantity q, purchasePriceCents c FROM blank_sizes WHERE blankId=? AND color=? AND size=?", r.blankId, r.color, r.size)[0];
  const moves = () => d1.q("SELECT count(*) n FROM inventory_movements WHERE kind='adjust'")[0].n;
  const { db, c } = counting(d1);
  const call = caller(db);
  const measure = async (body) => { Object.assign(c, { calls: 0, batches: 0, statements: 0, audit: 0 }); const r = await call(body); return { ...r, ...c }; };
  const off = (r, i) => ({ blankId: r.blankId, color: r.color, size: r.size, onHand: r.onHand, counted: r.onHand + (i % 2 ? 2 : -3) });

  let r = await measure({ action: "countBlankStock", rows: rows.slice(0, 101).map(off) });
  ok("101 rows in one request are refused, saying the most it takes, and nothing changes", r.status === 400 && /max 100/.test(r.body.message) && moves() === 0);
  const ten = await measure({ action: "countBlankStock", at: "2026-11-10T15:00:00.000Z", rows: rows.slice(0, 10).map(off) });
  ok("10 rows are corrected", ten.status === 200 && ten.body.corrected.length === 10 && ten.body.failed.length === 0 && moves() === 10);
  const hundred = await measure({ action: "countBlankStock", at: "2026-11-10T15:00:00.000Z", note: "yearly count", rows: rows.slice(10, 110).map(off) });
  ok("100 rows are all corrected", hundred.status === 200 && hundred.body.corrected.length === 100 && hundred.body.failed.length === 0 && moves() === 110 &&
    rows.slice(10, 110).every((x, i) => qty(x).q === off(x, i).counted));
  ok(`…in ${hundred.calls} database round trips — the same as for 10 rows (${ten.calls}), and far under 50 (it was 3 or 4 a row)`, hundred.calls === ten.calls && hundred.calls < 20);
  ok(`…the whole group written in ONE batch (${hundred.statements} statements), not one a row`, hundred.batches === 1 && hundred.statements === 200 && ten.batches === 1 && ten.statements === 20);
  const aud = d1.q("SELECT detail FROM audit_log WHERE action='inventory.counted' ORDER BY id");
  const last = JSON.parse(aud[aud.length - 1].detail);
  ok("…and ONE audit entry for the group: every row, what was on record, what was counted, the note and the date", hundred.audit === 1 && aud.length === 2 && last.rows.length === 100 &&
    last.rows[0].onHand === rows[10].onHand && last.rows[0].counted === off(rows[10], 0).counted && last.rows[0].delta === -3 && last.note === "yearly count" && last.occurredAt === "2026-11-10T15:00:00.000Z");
  const mv = d1.q("SELECT note, occurredAt, unitCostCents c, blankName FROM inventory_movements WHERE kind='adjust' ORDER BY id DESC LIMIT 1")[0];
  ok("…each movement dated when counted, noted as a stock count, named for its blank", mv.occurredAt === "2026-11-10T15:00:00.000Z" && mv.note === "Stock count: yearly count" && /^Blank 0\d$/.test(mv.blankName));

  console.log("\n=== A group with rows that can't be corrected: they're refused, the rest still apply ===");
  {
    const part = rows.slice(110, 210).map(off);
    part[3].onHand += 1;                                   // the window showed a number that's no longer right
    part[7] = { blankId: part[7].blankId, color: "Black", size: "NOPE", counted: 1, onHand: 0 };   // not on file
    part[9].counted = part[9].onHand;                      // matches: nothing to record
    part[12] = { ...part[11] };                            // the same row twice
    // Row 20's stock changes after the group was read and before it's written (a use recorded meanwhile).
    const hooked = counting(d1, { beforeBatch: () => d1._raw.run("UPDATE blank_sizes SET quantity = quantity - 1 WHERE blankId=? AND color=? AND size=?", [part[20].blankId, part[20].color, part[20].size]) });
    const before = moves();
    const g = await caller(hooked.db)({ action: "countBlankStock", rows: part });
    const failed = (i) => g.body.failed.find(f => f.blankId === part[i].blankId && f.color === part[i].color && f.size === part[i].size && f.counted === part[i].counted && f.onHand === part[i].onHand);
    ok("a row whose stock is no longer what the window showed is refused, with what it is now", g.status === 200 && !!failed(3) && new RegExp(`it's ${part[3].onHand - 1} now`).test(failed(3).error));
    ok("…a size that isn't on file is refused", !!failed(7) && /isn't on file/.test(failed(7).error));
    ok("…a row that matches records nothing and isn't a failure", !failed(9) && !g.body.corrected.some(x => x.blankId === part[9].blankId && x.color === part[9].color && x.size === part[9].size));
    ok("…a row sent twice is corrected once", g.body.corrected.filter(x => x.blankId === part[11].blankId && x.color === part[11].color && x.size === part[11].size).length === 1 &&
      g.body.failed.filter(x => x.blankId === part[11].blankId && x.color === part[11].color && x.size === part[11].size).length === 1);
    ok("…a row whose stock moved between the read and the write is refused by its own guard and left as it is", !!failed(20) && /changed while you were counting/.test(failed(20).error) &&
      qty(part[20]).q === part[20].onHand - 1 && d1.q("SELECT count(*) n FROM inventory_movements WHERE kind='adjust' AND blankId=? AND color=? AND size=?", part[20].blankId, part[20].color, part[20].size)[0].n === 0);
    ok("…and the other 95 rows are all corrected", g.body.corrected.length === 95 && g.body.failed.length === 4 && moves() === before + 95 && hooked.c.batches === 1);
  }

  console.log("\n=== What one row does is what it always did ===");
  {
    // Two identical databases: the old row-at-a-time way on one, the group on the other; then the rows compared.
    const A = await makeDb(3, 12), B = await makeDb(3, 12);
    const list = A.rows.map((x, i) => ({ blankId: x.blankId, color: x.color, size: x.size, onHand: x.onHand + (i % 11 === 5 ? 1 : 0), counted: i % 9 === 4 ? x.onHand : x.onHand + (i % 4 < 2 ? 4 : -2) }));
    // A row sent without a color means the blank's own (row 5's size, which the list above left alone as stale).
    list.push({ blankId: A.rows[5].blankId, color: null, size: A.rows[5].size, counted: A.rows[5].onHand + 6, onHand: A.rows[5].onHand }, { blankId: 99999, color: "Black", size: "S0", counted: 1, onHand: 0 }, { blankId: A.rows[0].blankId, color: "Black", size: "S1", counted: -1, onHand: 10 });
    const oldOut = [];
    for (const row of list) { try { oldOut.push(await oldSetBlankCount(A.d1, { ...row, note: "n", at: "2026-11-11T10:00:00.000Z" })); } catch (e) { if (!e.userFacing) throw e; oldOut.push({ error: e.message }); } }
    const newOut = await lib.setBlankCounts(B.d1, list, { note: "n", at: "2026-11-11T10:00:00.000Z" });
    const sizesOf = (d) => JSON.stringify(d.q("SELECT blankId, color, size, quantity, purchasePriceCents, vendorPriceCents FROM blank_sizes ORDER BY blankId, color, size"));
    const movesOf = (d) => JSON.stringify(d.q("SELECT blankId, blankName, color, size, qtyDelta, unitCostCents, kind, note, occurredAt FROM inventory_movements ORDER BY blankId, color, size, id"));
    ok(`${list.length} rows — corrections, matches, stale rows, a missing size, a bad count — get the same answer each`, JSON.stringify(newOut) === JSON.stringify(oldOut) && newOut.filter(x => x.error).length >= 8 && newOut.filter(x => x.delta).length > 50 && newOut[72].delta === 6);
    ok("…and leave the same stock and costs, and the same movements", sizesOf(A.d1) === sizesOf(B.d1) && movesOf(A.d1) === movesOf(B.d1));
    const firstCost = B.d1.q("SELECT s.purchasePriceCents c, s.vendorPriceCents v FROM blank_sizes s WHERE s.vendorPriceCents IS NOT NULL");
    ok("…a size with no cost that gained stock took its vendor price as its first cost; one that lost stock didn't", firstCost.some(x => x.c === x.v) && firstCost.some(x => x.c === 0));
    let one = null;
    try { await lib.setBlankCount(B.d1, { blankId: A.rows[1].blankId, color: A.rows[1].color, size: A.rows[1].size, counted: 3, onHand: 999 }); } catch (e) { one = e; }
    ok("setBlankCount (one row) still throws the row's reason", !!one && one.userFacing === true && /changed while you were counting \(it's \d+ now\)/.test(one.message));
  }

  console.log("\n=== Transfers ===");
  {
    const tids = [];
    for (let i = 0; i < 120; i++) { const id = await lib.createTransfer(d1, { name: "Transfer " + i }); tids.push(id); d1._raw.run("UPDATE transfers SET quantity = ?, purchasePriceCents = ? WHERE id = ?", [20 + (i % 5), 150 + i, id]); }
    const trow = (id, i) => ({ transferId: id, onHand: 20 + (i % 5), counted: 20 + (i % 5) + (i % 2 ? 3 : -4) });
    r = await measure({ action: "countTransferStock", rows: tids.slice(0, 101).map(trow) });
    ok("101 transfers in one request are refused", r.status === 400 && /max 100/.test(r.body.message));
    const t5 = await measure({ action: "countTransferStock", at: "2026-11-12T09:00:00.000Z", rows: tids.slice(0, 5).map(trow) });
    const list = tids.slice(5, 105).map((id, i) => trow(id, i + 5));
    list[4].onHand += 2; list[6] = { transferId: 999999, counted: 1, onHand: 0 };
    const t100 = await measure({ action: "countTransferStock", at: "2026-11-12T09:00:00.000Z", rows: list });
    ok("100 transfers: 98 corrected, the stale one and the unknown one refused", t100.status === 200 && t100.body.corrected.length === 98 && t100.body.failed.length === 2 &&
      /it's \d+ now/.test(t100.body.failed.find(f => f.transferId === list[4].transferId).error) && /isn't on file/.test(t100.body.failed.find(f => f.transferId === 999999).error));
    ok(`…in ${t100.calls} database round trips, the same as for 5 (${t5.calls}), one batch, one audit entry`, t100.calls === t5.calls && t100.calls < 20 && t100.batches === 1 && t100.statements === 196 && t100.audit === 1);
    const m = d1.q("SELECT qtyDelta d, unitCostCents c, transferName n, occurredAt FROM transfer_movements WHERE kind='adjust' AND transferId=?", tids[5])[0];
    ok("…each as one adjust at the transfer's average cost, dated when counted", m.d === 3 && m.c === 155 && m.n === "Transfer 5" && m.occurredAt === "2026-11-12T09:00:00.000Z" &&
      d1.q("SELECT quantity q, purchasePriceCents c FROM transfers WHERE id=?", tids[5])[0].q === 23);
    let one = null;
    try { await lib.setTransferCount(d1, { transferId: tids[110], counted: 3, onHand: 999 }); } catch (e) { one = e; }
    ok("setTransferCount (one row) still throws the row's reason", !!one && one.userFacing === true && /it's \d+ now/.test(one.message));
  }

  console.log("\n=== The count window sends a big count in groups of 100 ===");
  {
    const W = await makeDb(6, 20);   // 240 sizes, all counted 1 more than on record
    const sent = [];
    let failAt = 0;
    const wcall = caller(W.d1);
    const adminJs = read("public/admin.js");
    class Ld extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
    const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Ld(), url: ADMIN_ORIGIN + "/#inventory", pretendToBeVisual: true,
      beforeParse(win) { autoConfirm(win, () => true); win.CSS = win.CSS || { escape: (x) => String(x) }; win.fetch = async (url, init) => {
        if (!String(url).includes("/api/orders")) return { ok: false, status: 404, json: async () => ({ status: "error" }) };
        const b = JSON.parse(init.body);
        if (b.action === "countBlankStock") { sent.push({ n: b.rows.length, sum: win.document.getElementById("scSum").textContent }); if (failAt && sent.length === failAt) return { ok: false, status: 500, json: async () => ({ status: "error", message: "The database is busy" }) }; }
        const x = await wcall(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }; } });
    const w = dom.window, d = w.document;
    await new Promise(res => setTimeout(res, 150));
    await w.loadAdminScript();
    w.eval('adminKey = "cookie";');
    w.eval(asRole("admin"));
    const open = async () => { w.showStockCount_("blanks", () => {}); await wait(() => d.querySelectorAll(".sc-count").length === 240);
      d.querySelectorAll(".sc-count").forEach(inp => { inp.value = String(Number(inp.value) + 1); inp.dispatchEvent(new w.Event("input", { bubbles: true })); }); };
    await open();
    ok("240 rows are off", /240 sizes · 240 differ/.test(d.getElementById("scSum").textContent));
    d.getElementById("scAll").click();
    await wait(() => W.d1.q("SELECT count(*) n FROM inventory_movements WHERE kind='adjust'")[0].n === 240 && /0 differ|240 sizes · 0/.test(d.getElementById("scSum").textContent));
    ok("Correct all remaining differences sends 100, 100 and 40 rows, one request after another", sent.map(x => x.n).join() === "100,100,40");
    ok("…saying how far it is while it goes", /Correcting… 0 of 240 rows done/.test(sent[0].sum) && /Correcting… 100 of 240 rows done/.test(sent[1].sum) && /Correcting… 200 of 240 rows done/.test(sent[2].sum));
    ok("…and every row ends up corrected: 240 corrections, no row still off, three audit entries", W.d1.q("SELECT count(*) n FROM inventory_movements WHERE kind='adjust'")[0].n === 240 &&
      W.rows.every(x => W.d1.q("SELECT quantity q FROM blank_sizes WHERE blankId=? AND color=? AND size=?", x.blankId, x.color, x.size)[0].q === x.onHand + 1) &&
      / 0 differ/.test(d.getElementById("scSum").textContent) && W.d1.q("SELECT count(*) n FROM audit_log WHERE action='inventory.counted'")[0].n === 3);
    // A group that fails outright: the groups before it stay, the rest aren't sent, and the window says so.
    d.querySelectorAll(".sc-count").forEach(inp => { inp.value = String(Number(inp.value) + 2); inp.dispatchEvent(new w.Event("input", { bubbles: true })); });
    sent.length = 0; failAt = 2;
    d.getElementById("scAll").click();
    await wait(() => /It stopped after 100 of 240 rows/.test(d.getElementById("scErr").textContent));
    ok("a group that fails stops the rest, and the window says how far it got and that the others weren't corrected",
      sent.length === 2 && /It stopped after 100 of 240 rows \(The database is busy\) — the other 140 were not corrected/.test(d.getElementById("scErr").textContent));
    await wait(() => /240 sizes · 140 differ/.test(d.getElementById("scSum").textContent));
    ok("…the 100 that went through are settled, the other 140 still show their difference", /240 sizes · 140 differ/.test(d.getElementById("scSum").textContent) &&
      W.d1.q("SELECT count(*) n FROM inventory_movements WHERE kind='adjust'")[0].n === 340);
  }

  const orders = read("functions/api/orders.js");
  ok("the server no longer takes 2,000 rows a request, nor a row at a time", !/body\.rows\.slice\(0, 2000\)/.test(orders) && /const COUNT_ROWS_MAX = 100;/.test(orders) && !/await setBlankCount\(/.test(orders) && !/await setTransferCount\(/.test(orders));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  process.exit(0);
})().catch(e => { console.error(e); console.log("test281 crashed: false"); process.exit(1); });
