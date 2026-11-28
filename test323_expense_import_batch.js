const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles.js");

// Expenses → Import CSV (orders.js importExpenses) writes the whole file as ONE batch (db.js insertExpenses): the
// same INSERT saveExpense makes for each row, sent together. So a 200-row file is one round trip instead of 200, and
// it goes in whole or not at all — a row that fails part-way no longer leaves the rows before it saved, to be
// duplicated when the file is imported again. The ids come back in the file's order.
// Real SQL (sql.js), real db.js and orders.js; the test database's prepare/batch are wrapped to count round trips.
// Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, insertExpenses: typeof insertExpenses === 'function' ? insertExpenses : null };")();

let passed = 0, failed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  require("./testlib/vendors.js").seedVendors(d1);

  // Round trips to the database: each statement run on its own, and each batch.
  const trips = { n: 0 };
  const prepare = d1.prepare.bind(d1), batch = d1.batch.bind(d1);
  const counted = (b) => Object.assign(b, { first: ((f) => (...a) => { trips.n++; return f(...a); })(b.first),
    run: ((f) => (...a) => { trips.n++; return f(...a); })(b.run), all: ((f) => (...a) => { trips.n++; return f(...a); })(b.all) });
  d1.prepare = (sql) => { const s = counted(prepare(sql)), bind = s.bind; return Object.assign(s, { bind: (...ps) => counted(bind(...ps)) }); };
  d1.batch = async (stmts) => { trips.n++; return batch(stmts); };

  const pending = [];
  const call = async (body) => {
    const full = Object.assign({ key: "x" }, body);
    try {
      const res = await api.post({ env: { DB: d1 }, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
        request: { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } } });
      return { status: res.status, body: JSON.parse(await res.text()) };
    } catch (e) { return { status: 0, body: {}, threw: e }; }
  };
  const software = 3, supplies = 2;
  const file = (n, tag) => Array.from({ length: n }, (_, i) => ({ date: "2026-09-" + String(1 + (i % 28)).padStart(2, "0"),
    description: `${tag} row ${i + 1}`, amount: 1 + i / 100, categoryId: i % 2 ? software : supplies }));
  const live = () => d1.q("SELECT COUNT(*) n FROM expenses WHERE deletedAt IS NULL")[0].n;
  const importTrips = async (rows) => { trips.n = 0; const r = await call({ action: "importExpenses", accountId: 2, rows }); return { r, n: trips.n }; };

  console.log("=== Round trips don't grow with the file ===");
  const small = await importTrips(file(10, "Small"));
  const big = await importTrips(file(200, "Big"));
  ok("a 200-row file is imported", big.r.status === 200 && big.r.body.imported === 200 && live() === 210);
  ok("…in as many round trips as a 10-row file", big.n === small.n);
  ok("…and only a handful of them", big.n <= 8);
  const rows = d1.q("SELECT id, description, amountCents, categoryId, accountId, vendorChargedTax, businessUsePct FROM expenses WHERE description LIKE 'Big row %' ORDER BY id");
  ok("each row as the file has it, in the file's order", rows.length === 200 && rows.every((x, i) => x.description === `Big row ${i + 1}` &&
    x.amountCents === Math.round((1 + i / 100) * 100) && x.categoryId === (i % 2 ? software : supplies) && x.accountId === 2 && x.vendorChargedTax === 1 && x.businessUsePct === 100));
  while (pending.length) await pending.shift();
  const audit = d1.q("SELECT detail FROM audit_log WHERE action='expense.imported' ORDER BY id DESC LIMIT 1").map(r => JSON.parse(r.detail))[0] || {};
  ok("the import is audited as before, with the new ids in order", audit.count === 200 && Array.isArray(audit.ids) && audit.ids.length === 100 &&
    audit.ids.every((id, i) => id === rows[i].id));

  console.log("\n=== insertExpenses returns the ids in the list's order ===");
  const ids = api.insertExpenses ? await api.insertExpenses(d1, [
    { date: "2026-09-02", description: "Direct one", categoryId: supplies, amount: 5, businessUsePct: 100, accountId: 2 },
    { date: "2026-09-01", description: "Direct two", categoryId: software, amount: 6, businessUsePct: 100, paidPersonally: true }]) : [];
  const got = ids.map(id => d1.q("SELECT description, accountId, paidPersonally FROM expenses WHERE id=?", id)[0] || {});
  ok("two ids, each the row it was given", ids.length === 2 && got[0].description === "Direct one" && got[1].description === "Direct two" &&
    got[0].accountId === 2 && got[1].paidPersonally === 1 && got[1].accountId === null);

  console.log("\n=== A row that fails leaves none behind ===");
  // A row the database refuses (a trigger stands in for a constraint failing on row 150 of 200).
  d1._raw.exec("CREATE TRIGGER t301_refuse BEFORE INSERT ON expenses WHEN NEW.description = 'Bad row 150' BEGIN SELECT RAISE(ABORT, 'refused'); END;");
  const before = live();
  const bad = await importTrips(file(200, "Bad"));
  ok("the import fails with a plain message", bad.r.status === 500 && /none of its rows were saved/.test(bad.r.body.message || ""));
  ok("…and not one of its 200 rows was saved", live() === before && d1.q("SELECT COUNT(*) n FROM expenses WHERE description LIKE 'Bad row %'")[0].n === 0);
  d1._raw.exec("DROP TRIGGER t301_refuse");
  const again = await importTrips(file(200, "Bad"));
  ok("importing the same file again then saves each row once", again.r.status === 200 && d1.q("SELECT COUNT(*) n FROM expenses WHERE description LIKE 'Bad row %'")[0].n === 200);

  while (pending.length) await pending.shift();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
