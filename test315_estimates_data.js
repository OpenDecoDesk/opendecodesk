const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

// Quotes (migrations/0109, "estimates" in the code), the data functions in db.js called directly:
//   the estimates and estimate_items tables      as the migration makes them and as schema.sql makes them
//   nextEstimateNumber_ / createEstimate         Q-00001 and up, every refusal, and another try when two quotes take a number
//   getEstimate                                  the shape, the lines, the customer, and the totals in both tax modes,
//                                                with an exempt shop, an exempt customer and an expired exemption, and
//                                                the tax frozen once the quote is sent
//   listEstimates                                each filter, the search, paging, the expired flag and the order
//   setEstimateFields                            what changes at which status (the internal note always)
//   saveEstimateItems                            only a draft or a quote sent back for changes; every refusal; the lines
//                                                replaced in one batch; a product line taxed as its product is
//   markEstimateSent / getEstimateByToken / markEstimateViewed
//   respondToEstimate                            accept and ask for changes, every refusal, and two answers at once
//   setEstimateConverted / cancelEstimate / estimateExpired
//   …and the readers on a database that hasn't had migrations/0109 yet.
// Real SQL (sql.js) + the real db.js, with its clock set by this file (Date is replaced inside db.js only), so
// nothing here depends on today's date or on this machine's time zone. Invented shops and customers only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

// db.js's clock. NOW is what Date.now() and new Date() give inside db.js.
let NOW = Date.parse("2027-03-10T12:00:00.000Z");
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const at = (iso) => { NOW = RealDate.parse(iso); };

const lib = new Function("Date", strip(read("functions/_lib/db.js")) +
  "\nreturn { nextEstimateNumber_, createEstimate, getEstimate, getEstimateByToken, listEstimates, setEstimateFields, saveEstimateItems," +
  " markEstimateSent, markEstimateViewed, respondToEstimate, setEstimateConverted, cancelEstimate, estimateExpired, setSalesTaxSettings," +
  " setLocaleSettings, ESTIMATE_STATUSES, ESTIMATE_FEE_KINDS, ESTIMATE_LINES_MAX, ESTIMATE_QTY_MAX };")(FakeDate);

const MIGRATIONS = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function makeDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of MIGRATIONS) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t'), ('beta','beta','Sample Works','t','t');`);
  return d1;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => Object.keys(o).sort().join(",");
const thrown = async (fn) => { try { await fn(); return ""; } catch (e) { return String((e && e.message) || e) || "an error"; } };
const fails = (d1, sql, ...p) => { try { d1.q(sql, ...p); return ""; } catch (e) { return String(e.message); } };

// A database whose statements can run something first: hook(sql, params) is called before a statement whose SQL
// matches `re` runs (on its own or in a batch) — how two people acting at the same moment are played out here.
function hooked(d1, re, hook, { times = 1 } = {}) {
  let left = times;
  const fire = (st) => { if (left > 0 && re.test(st._sql)) { left--; hook(st._sql, st._params); } };
  const wrap = (st) => {
    const w = { _sql: st._sql, _params: st._params,
      first: async (c) => { fire(st); return st.first(c); },
      all: async () => { fire(st); return st.all(); },
      run: async () => { fire(st); return st.run(); } };
    if (st.bind) w.bind = (...p) => wrap(st.bind(...p));
    return w;
  };
  return { _raw: d1._raw, q: d1.q, prepare: (sql) => wrap(d1.prepare(sql)),
    batch: async (stmts) => { for (const s of stmts) fire(s); return d1.batch(stmts); } };
}

const ACCEPT_WHILE_CHANGES = "You asked for changes to this quote. The shop will send you a revised one.";
const NOT_FOUND = "That quote wasn't found.";
const NOT_READY = "Quotes need the latest database update. Apply the migrations, then try again.";
const LOCKED_SENT = "This quote has been sent. It can be changed if the customer asks for changes.";
const LOCKED_CANCELLED = "This quote was cancelled.";
const LOCKED_ACCEPTED = "This quote has been accepted.";
const BAD_LINK = "This quote link isn't valid.";
const TOKEN_A = "a".repeat(32), TOKEN_B = "b".repeat(32);

(async () => {
  // =====================================================================================================
  console.log("=== The quotes tables, from the migration and from schema.sql ===");
  const migrated = await makeDb();
  const fresh = await createD1();
  fresh._raw.exec(read("schema.sql"));
  const cols = (db, t) => JSON.stringify(db.q(`PRAGMA table_info(${t})`).map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk]));
  const wantEstimates = [
    ["id", "INTEGER", 0, null, 1], ["number", "TEXT", 1, null, 0], ["orgId", "TEXT", 1, null, 0], ["customerId", "INTEGER", 1, null, 0],
    ["status", "TEXT", 1, "'draft'", 0], ["title", "TEXT", 1, "''", 0], ["message", "TEXT", 1, "''", 0], ["internalNote", "TEXT", 1, "''", 0],
    ["expiresOn", "TEXT", 0, null, 0], ["token", "TEXT", 0, null, 0], ["sentAt", "TEXT", 0, null, 0], ["sentTo", "TEXT", 1, "''", 0],
    ["sendCount", "INTEGER", 1, "0", 0], ["viewedAt", "TEXT", 0, null, 0], ["respondedAt", "TEXT", 0, null, 0], ["customerNote", "TEXT", 1, "''", 0],
    ["acceptedAt", "TEXT", 0, null, 0], ["orderId", "TEXT", 0, null, 0], ["convertedAt", "TEXT", 0, null, 0], ["cancelledAt", "TEXT", 0, null, 0],
    ["taxMode", "TEXT", 1, "'inclusive'", 0], ["taxRateBps", "INTEGER", 1, "0", 0], ["createdAt", "TEXT", 1, null, 0], ["updatedAt", "TEXT", 1, null, 0],
    ["createdBy", "TEXT", 1, "''", 0], ["discountCodes", "TEXT", 1, "'[]'", 0],   // migrations/0120: the codes typed on the quote
  ];
  const wantItems = [
    ["id", "INTEGER", 0, null, 1], ["estimateId", "INTEGER", 1, null, 0], ["position", "INTEGER", 1, "0", 0], ["kind", "TEXT", 1, null, 0],
    ["productId", "TEXT", 1, "''", 0], ["name", "TEXT", 1, null, 0], ["type", "TEXT", 1, "''", 0], ["size", "TEXT", 1, "''", 0],
    ["configJson", "TEXT", 1, "''", 0], ["personalized", "INTEGER", 1, "0", 0], ["persName", "TEXT", 1, "''", 0], ["feeKind", "TEXT", 1, "''", 0],
    ["qty", "INTEGER", 1, "1", 0], ["unitPriceCents", "INTEGER", 1, "0", 0], ["listUnitCents", "INTEGER", 1, "0", 0],
    ["personalizationFeeCents", "INTEGER", 1, "0", 0], ["customPrice", "INTEGER", 1, "0", 0], ["taxable", "INTEGER", 1, "1", 0], ["lineTotalCents", "INTEGER", 1, "0", 0],
  ];
  ok("the migrated estimates table has the 26 columns, with their types and defaults, in order", cols(migrated, "estimates") === JSON.stringify(wantEstimates));
  ok("schema.sql's estimates table has exactly the same columns", cols(fresh, "estimates") === cols(migrated, "estimates"));
  ok("the migrated estimate_items table has the 19 columns, with their types and defaults, in order", cols(migrated, "estimate_items") === JSON.stringify(wantItems));
  ok("schema.sql's estimate_items table has exactly the same columns", cols(fresh, "estimate_items") === cols(migrated, "estimate_items"));
  const qb = (db) => JSON.stringify(db.q("PRAGMA table_info(products)").filter(c => c.name === "qtyBreaksJson").map(c => [c.type, c.notnull, c.dflt_value]));
  ok("products have qtyBreaksJson, text, required, '[]' by default, in both", qb(migrated) === `[["TEXT",1,"'[]'"]]` && qb(fresh) === qb(migrated));
  const createSql = (db, t) => db.q("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", t)[0].sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").replace(/ IF NOT EXISTS/i, "").trim();
  ok("the two tables are declared the same way in both, word for word",
    createSql(fresh, "estimates") === createSql(migrated, "estimates") && createSql(fresh, "estimate_items") === createSql(migrated, "estimate_items"));
  const idx = (db) => JSON.stringify(db.q("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('estimates', 'estimate_items') AND sql IS NOT NULL ORDER BY name")
    .map(r => [r.name, r.sql.replace(/ IF NOT EXISTS/i, "")]));
  ok("the indexes are the shop and status, the customer, and a quote's lines in order, in both", idx(migrated) === JSON.stringify([
    ["idx_estimate_items_estimate", "CREATE INDEX idx_estimate_items_estimate ON estimate_items(estimateId, position)"],
    ["idx_estimates_customer", "CREATE INDEX idx_estimates_customer ON estimates(customerId)"],
    ["idx_estimates_org_status", "CREATE INDEX idx_estimates_org_status ON estimates(orgId, status)"]]) && idx(fresh) === idx(migrated));
  const fks = (db, t) => JSON.stringify(db.q(`PRAGMA foreign_key_list(${t})`).map(f => [f.from, f.table, f.to, f.on_delete]).sort());
  ok("a quote points at its shop, its customer and its order, in both",
    fks(migrated, "estimates") === JSON.stringify([["customerId", "customers", "id", "NO ACTION"], ["orderId", "orders", "orderId", "NO ACTION"], ["orgId", "orgs", "orgId", "NO ACTION"]]) &&
    fks(fresh, "estimates") === fks(migrated, "estimates"));
  ok("a line points at its quote and goes with it, in both",
    fks(migrated, "estimate_items") === JSON.stringify([["estimateId", "estimates", "id", "CASCADE"]]) && fks(fresh, "estimate_items") === fks(migrated, "estimate_items"));

  for (const [db, where] of [[migrated, "migrated"], [fresh, "from schema.sql"]]) {
    if (where !== "migrated") db._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
    db.q("INSERT INTO customers (name, createdAt, updatedAt) VALUES ('Pat Example', 't', 't')");
    const cid = db.q("SELECT max(id) AS id FROM customers")[0].id;
    const ins = (number, extra = "", vals = "") => fails(db, `INSERT INTO estimates (number, orgId, customerId, createdAt, updatedAt${extra}) VALUES (?, 'acme', ?, 't', 't'${vals})`, number, cid);
    ok(`(${where}) a quote takes its defaults: draft, empty texts, no expiry, no link, inclusive tax at 0`,
      ins("Q-1") === "" && same(db.q("SELECT status, title, message, internalNote, expiresOn, token, sentTo, sendCount, customerNote, taxMode, taxRateBps, createdBy FROM estimates WHERE number = 'Q-1'")[0],
        { status: "draft", title: "", message: "", internalNote: "", expiresOn: null, token: null, sentTo: "", sendCount: 0, customerNote: "", taxMode: "inclusive", taxRateBps: 0, createdBy: "" }));
    ok(`(${where}) two quotes can't have the same number`, /UNIQUE constraint failed: estimates\.number/.test(ins("Q-1")));
    ok(`(${where}) a status outside the six is refused`, /CHECK constraint failed/.test(ins("Q-2", ", status", ", 'open'")) && ins("Q-2", ", status", ", 'changes'") === "");
    ok(`(${where}) a tax mode outside the two is refused`, /CHECK constraint failed/.test(ins("Q-3", ", taxMode", ", 'gross'")));
    ok(`(${where}) two quotes can't share a link`, ins("Q-4", ", token", ", 'tok'") === "" && /UNIQUE constraint failed: estimates\.token/.test(ins("Q-5", ", token", ", 'tok'")));
    ok(`(${where}) a quote must be for a customer that exists`, /FOREIGN KEY/.test(fails(db, "INSERT INTO estimates (number, orgId, customerId, createdAt, updatedAt) VALUES ('Q-6', 'acme', 9999, 't', 't')")));
    const eid = db.q("SELECT id FROM estimates WHERE number = 'Q-1'")[0].id;
    const line = (cols2 = "", vals = "") => fails(db, `INSERT INTO estimate_items (estimateId, kind, name${cols2}) VALUES (?, 'custom', 'Line'${vals})`, eid);
    ok(`(${where}) a line takes its defaults: one piece, at 0, taxable, not a typed price`,
      line() === "" && same(db.q("SELECT qty, unitPriceCents, listUnitCents, taxable, customPrice, feeKind, position FROM estimate_items WHERE estimateId = ?", eid)[0],
        { qty: 1, unitPriceCents: 0, listUnitCents: 0, taxable: 1, customPrice: 0, feeKind: "", position: 0 }));
    ok(`(${where}) a line's kind is product, custom or fee`, /CHECK/.test(fails(db, "INSERT INTO estimate_items (estimateId, kind, name) VALUES (?, 'discount', 'x')", eid)));
    ok(`(${where}) a quantity is 1 to 5,000`, /CHECK/.test(line(", qty", ", 0")) && /CHECK/.test(line(", qty", ", 5001")) && line(", qty", ", 5000") === "");
    ok(`(${where}) a unit price is never below 0`, /CHECK/.test(line(", unitPriceCents", ", -1")));
    ok(`(${where}) a fee's kind is setup, digitizing, art, other or none`, /CHECK/.test(line(", feeKind", ", 'rush'")) &&
      ["setup", "digitizing", "art", "other"].every(k => line(", feeKind", `, '${k}'`) === ""));
    ok(`(${where}) taxable and customPrice are 0 or 1`, /CHECK/.test(line(", taxable", ", 2")) && /CHECK/.test(line(", customPrice", ", 2")));
    ok(`(${where}) a product's quantity breaks must be JSON`, /CHECK/.test(fails(db,
      "INSERT INTO products (productId, orgId, type, name, createdAt, updatedAt, qtyBreaksJson) VALUES ('p', 'acme', 'Tee', 'Tee', 't', 't', 'not json')")) &&
      fails(db, "INSERT INTO products (productId, orgId, type, name, createdAt, updatedAt) VALUES ('p', 'acme', 'Tee', 'Tee', 't', 't')") === "" &&
      db.q("SELECT qtyBreaksJson FROM products WHERE productId = 'p'")[0].qtyBreaksJson === "[]");
    db.q("DELETE FROM estimates WHERE id = ?", eid);
    ok(`(${where}) deleting a quote deletes its lines`, db.q("SELECT count(*) AS n FROM estimate_items WHERE estimateId = ?", eid)[0].n === 0);
  }

  // =====================================================================================================
  console.log("\n=== Numbering and making a quote ===");
  const d1 = await makeDb();
  const cust = (name, extra = {}) => {
    const c = Object.assign({ company: "", email: "", taxExempt: 0, taxExemptExpires: null, mergedIntoId: null }, extra);
    d1.q("INSERT INTO customers (name, company, email, taxExempt, taxExemptExpires, mergedIntoId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 't', 't')",
      name, c.company, c.email, c.taxExempt, c.taxExemptExpires, c.mergedIntoId);
    return d1.q("SELECT max(id) AS id FROM customers")[0].id;
  };
  const pat = cust("Pat Example", { company: "Example Club", email: "pat@example.com" });
  const sam = cust("", { company: "Sample Works", email: "sam@example.com" });
  const gone = cust("Old Pat", { mergedIntoId: pat });
  const erow = (id) => d1.q("SELECT * FROM estimates WHERE id = ?", id)[0];
  const ecount = () => d1.q("SELECT count(*) AS n FROM estimates")[0].n;

  ok("the first quote's number is Q-00001", await lib.nextEstimateNumber_(d1) === "Q-00001");
  at("2027-03-10T12:00:00.000Z");
  let r = await lib.createEstimate(d1, { orgId: "acme", customerId: pat, title: "  Team shirts  ", message: "  Thanks for asking. ", internalNote: " Rush if we can ",
    expiresOn: " 2027-03-31 ", createdBy: "staff@example.com" });
  const q1 = r.id;
  ok("a new quote answers with its id and its number, Q-00001", Number.isInteger(q1) && q1 > 0 && r.number === "Q-00001" && keys(r) === "id,number");
  const row1 = erow(q1);
  ok("it is a draft for that customer in that shop", row1.status === "draft" && row1.orgId === "acme" && row1.customerId === pat && row1.number === "Q-00001");
  ok("the title, message, internal note and expiry date are stored trimmed",
    same([row1.title, row1.message, row1.internalNote, row1.expiresOn], ["Team shirts", "Thanks for asking.", "Rush if we can", "2027-03-31"]));
  ok("who made it and when are stored, created and updated at the same moment",
    row1.createdBy === "staff@example.com" && row1.createdAt === "2027-03-10T12:00:00.000Z" && row1.updatedAt === row1.createdAt);
  ok("it has no link, has not been sent and has no order", row1.token === null && row1.sentAt === null && row1.sendCount === 0 && row1.orderId === null);
  ok("the next number is one more: Q-00002", await lib.nextEstimateNumber_(d1) === "Q-00002");
  r = await lib.createEstimate(d1, { orgId: "beta", customerId: String(sam) });
  const q2 = r.id;
  ok("a customer id given as text is taken, and the number goes on across shops: Q-00002", r.number === "Q-00002" && erow(q2).orgId === "beta" && erow(q2).customerId === sam);
  ok("everything not given starts empty, with no expiry date (NULL) and no maker",
    same([erow(q2).title, erow(q2).message, erow(q2).internalNote, erow(q2).expiresOn, erow(q2).createdBy], ["", "", "", null, ""]));
  r = await lib.createEstimate(d1, { orgId: "acme", customerId: pat, title: "x".repeat(250), message: "m".repeat(3100), internalNote: "n".repeat(2100), createdBy: "c".repeat(250), expiresOn: "" });
  const q3 = r.id;
  ok("the title is cut to 200 characters, the message to 3000, the internal note to 2000 and the maker to 200",
    erow(q3).title.length === 200 && erow(q3).message.length === 3000 && erow(q3).internalNote.length === 2000 && erow(q3).createdBy.length === 200);
  ok("an empty expiry date is stored as NULL", erow(q3).expiresOn === null);

  d1.q("INSERT INTO estimates (number, orgId, customerId, createdAt, updatedAt) VALUES ('Q-00041', 'acme', ?, 't', 't'), ('EST-900', 'acme', ?, 't', 't')", pat, pat);
  ok("the next number follows the highest Q- number, not the count, and other numbers don't count", await lib.nextEstimateNumber_(d1) === "Q-00042");
  d1.q("INSERT INTO estimates (number, orgId, customerId, createdAt, updatedAt) VALUES ('Q-99999', 'acme', ?, 't', 't')", pat);
  ok("after Q-99999 comes Q-100000 (more digits, not a wrap)", await lib.nextEstimateNumber_(d1) === "Q-100000");
  d1.q("DELETE FROM estimates WHERE number IN ('Q-00041', 'EST-900', 'Q-99999')");

  let before = ecount();
  const refusedCreate = async (desc, args, msg) => {
    const res = await lib.createEstimate(d1, args);
    ok(desc, res.error === msg && !res.id && ecount() === before);
  };
  await refusedCreate("a quote with no shop is refused, and nothing is made", { customerId: pat }, "That shop wasn't found.");
  await refusedCreate("a quote for a shop that doesn't exist is refused", { orgId: "nowhere", customerId: pat }, "That shop wasn't found.");
  await refusedCreate("a quote with no customer is refused", { orgId: "acme" }, "Pick the customer the quote is for.");
  await refusedCreate("a customer id that isn't a whole number above 0 is refused", { orgId: "acme", customerId: "1.5" }, "Pick the customer the quote is for.");
  await refusedCreate("a customer that doesn't exist is refused", { orgId: "acme", customerId: 9999 }, "Pick the customer the quote is for.");
  await refusedCreate("a customer merged into another is refused", { orgId: "acme", customerId: gone }, "Pick the customer the quote is for.");
  await refusedCreate("an expiry date that isn't a date is refused", { orgId: "acme", customerId: pat, expiresOn: "next week" }, "The expiry date isn't a date.");
  await refusedCreate("a day that doesn't exist (31 February) is refused, not rolled into March", { orgId: "acme", customerId: pat, expiresOn: "2027-02-31" }, "The expiry date isn't a date.");
  await refusedCreate("a date in another form (03/31/2027) is refused", { orgId: "acme", customerId: pat, expiresOn: "03/31/2027" }, "The expiry date isn't a date.");
  r = await lib.createEstimate(d1, { orgId: "acme", customerId: pat, expiresOn: "2028-02-29" });
  ok("29 February in a leap year is a date", r.number && erow(r.id).expiresOn === "2028-02-29");
  d1.q("DELETE FROM estimates WHERE id = ?", r.id);

  // Two quotes at the same moment: another takes the number this one picked, just before it is written.
  const nextNo = await lib.nextEstimateNumber_(d1);
  let inserts = 0;
  const racer = hooked(d1, /INSERT INTO estimates/, (sql, p) => {
    inserts++;
    if (inserts === 1) d1.q("INSERT INTO estimates (number, orgId, customerId, createdAt, updatedAt) VALUES (?, 'acme', ?, 't', 't')", p[0], sam);
  }, { times: 10 });
  before = ecount();
  r = await lib.createEstimate(racer, { orgId: "acme", customerId: pat, title: "Raced" });
  ok("when another quote takes the number first, it tries again and takes the next one", r.number === "Q-" + String(Number(nextNo.slice(2)) + 1).padStart(5, "0") &&
    inserts === 2 && erow(r.id).title === "Raced" && ecount() === before + 2 &&
    d1.q("SELECT customerId FROM estimates WHERE number = ?", nextNo)[0].customerId === sam);
  inserts = 0;
  const alwaysBeaten = hooked(d1, /INSERT INTO estimates/, (sql, p) => {
    inserts++;
    d1.q("INSERT INTO estimates (number, orgId, customerId, createdAt, updatedAt) VALUES (?, 'acme', ?, 't', 't')", p[0], sam);
  }, { times: 50 });
  let err = await thrown(() => lib.createEstimate(alwaysBeaten, { orgId: "acme", customerId: pat, title: "Never" }));
  ok("it gives up after five tries, with the database's error", inserts === 5 && /UNIQUE constraint failed: estimates\.number/.test(err) &&
    d1.q("SELECT count(*) AS n FROM estimates WHERE title = 'Never'")[0].n === 0);
  inserts = 0;
  const broken = hooked(d1, /INSERT INTO estimates/, () => { inserts++; throw new Error("D1_ERROR: the database is busy"); }, { times: 50 });
  err = await thrown(() => lib.createEstimate(broken, { orgId: "acme", customerId: pat }));
  ok("any other failure is not tried again: it is thrown at once", inserts === 1 && /the database is busy/.test(err));
  d1.q("DELETE FROM estimates WHERE id NOT IN (?, ?, ?) AND title <> 'Raced'", q1, q2, q3);
  const raced = d1.q("SELECT id FROM estimates WHERE title = 'Raced'")[0].id;
  d1.q("DELETE FROM estimates WHERE id = ?", raced);

  // =====================================================================================================
  console.log("\n=== One quote, with its lines, its customer and its totals ===");
  d1._raw.exec(`INSERT INTO products (productId, orgId, type, name, createdAt, updatedAt, taxable) VALUES
    ('tee', 'acme', 'Tee', 'Club Tee', 't', 't', 1), ('gift', 'acme', 'Card', 'Gift Card', 't', 't', 0), ('btee', 'beta', 'Tee', 'Works Tee', 't', 't', 0);`);
  const LINES = [
    { kind: "product", productId: "tee", name: "Club Tee", type: "Tee", size: "M", config: { color: "Navy" }, personalized: true, persName: "PAT",
      qty: 3, unitPrice: 18, listUnitPrice: 20, personalizationFee: 5 },
    { kind: "custom", name: "Hand-sewn patch", qty: 2, unitPrice: 12.5, taxable: false },
    { kind: "fee", feeKind: "setup", name: "Setup", amount: 25, taxable: true },
  ];
  r = await lib.saveEstimateItems(d1, q1, LINES);
  ok("a draft's lines are saved: { ok, lines: 3 }", r.ok === true && r.lines === 3);
  await lib.setSalesTaxSettings(d1, { rateBps: 800, jurisdiction: "ZZ", taxMode: "inclusive" });
  let g = await lib.getEstimate(d1, q1);
  ok("getEstimate answers the quote, its lines, its customer and its totals", keys(g) === "customer,estimate,items,totals");
  ok("the quote has every field people see, plus expired and the link's token", keys(g.estimate) === [
    "acceptedAt", "cancelledAt", "convertedAt", "createdAt", "createdBy", "customerId", "customerNote", "discountCodes", "expired", "expiresOn", "id", "internalNote", "message", "number",
    "orderId", "orgId", "respondedAt", "sendCount", "sentAt", "sentTo", "status", "taxMode", "taxRateBps", "title", "token", "updatedAt", "viewedAt"].join(","));
  ok("what isn't set yet reads as empty text, not null", same([g.estimate.token, g.estimate.sentAt, g.estimate.viewedAt, g.estimate.respondedAt, g.estimate.acceptedAt,
    g.estimate.orderId, g.estimate.convertedAt, g.estimate.cancelledAt], ["", "", "", "", "", "", "", ""]));
  ok("the quote reads back as created", g.estimate.id === q1 && g.estimate.number === "Q-00001" && g.estimate.status === "draft" && g.estimate.customerId === pat &&
    g.estimate.title === "Team shirts" && g.estimate.expiresOn === "2027-03-31" && g.estimate.expired === false && g.estimate.sendCount === 0);
  ok("the customer is the quote's customer, as getCustomer shapes one", g.customer.id === pat && g.customer.name === "Pat Example" && g.customer.email === "pat@example.com" &&
    g.customer.taxExempt === false);
  ok("the lines come in the order they were saved", same(g.items.map(i => i.kind), ["product", "custom", "fee"]) && same(g.items.map(i => i.position), [0, 1, 2]));
  const [pl, cl, fl] = g.items;
  ok("a line has every field, in dollars", keys(pl) === ["breakOff", "config", "customPrice", "feeKind", "id", "kind", "lineTotal", "listUnitPrice", "name", "persName",
    "personalizationFee", "personalized", "position", "productId", "qty", "size", "taxable", "type", "unitPrice"].sort().join(","));
  ok("a product line: product, size, the choices, personalization, the price after the break and before it",
    pl.productId === "tee" && pl.name === "Club Tee" && pl.type === "Tee" && pl.size === "M" && same(pl.config, { color: "Navy" }) && pl.personalized === true && pl.persName === "PAT" &&
    pl.qty === 3 && pl.unitPrice === 18 && pl.listUnitPrice === 20 && pl.personalizationFee === 5 && pl.customPrice === false);
  ok("a product line's break is what each piece got off ($2)", pl.breakOff === 2);
  ok("a product line's total is pieces × (unit price + personalization): 3 × $23 = $69", pl.lineTotal === 69);
  ok("a custom line: its description, quantity and price, no product, no break, not taxable as asked",
    cl.name === "Hand-sewn patch" && cl.productId === "" && cl.qty === 2 && cl.unitPrice === 12.5 && cl.listUnitPrice === 12.5 && cl.breakOff === 0 && cl.taxable === false &&
    cl.lineTotal === 25 && cl.config === null && cl.size === "" && cl.feeKind === "");
  ok("a fee line: its kind, its amount as one piece, taxable as asked", fl.feeKind === "setup" && fl.name === "Setup" && fl.qty === 1 && fl.unitPrice === 25 && fl.lineTotal === 25 &&
    fl.taxable === true && fl.breakOff === 0 && fl.type === "");
  ok("the product line is taxable because its product is", pl.taxable === true);
  // Inclusive 8%: the $69 line holds $5.11 of tax, the $25 fee $1.85; the $25 custom line none. 6900·10000/10800 = 6388.9 → 6389.
  ok("inclusive tax at 8%: tax backed out of each taxable line ($5.11 + $1.85), the total is the subtotal",
    same(g.totals, { subtotal: 119, tax: 6.96, total: 119, taxMode: "inclusive", taxRateBps: 800 }));
  await lib.setSalesTaxSettings(d1, { rateBps: 800, jurisdiction: "ZZ", taxMode: "exclusive" });
  g = await lib.getEstimate(d1, q1);
  ok("exclusive tax at 8%: added to each taxable line ($5.52 + $2.00), on top of the subtotal",
    same(g.totals, { subtotal: 119, tax: 7.52, total: 126.52, taxMode: "exclusive", taxRateBps: 800 }));
  await lib.setSalesTaxSettings(d1, { rateBps: 0, jurisdiction: "", taxMode: "exclusive" });
  ok("with no tax rate set, there is no tax", same((await lib.getEstimate(d1, q1)).totals, { subtotal: 119, tax: 0, total: 119, taxMode: "exclusive", taxRateBps: 0 }));
  await lib.setSalesTaxSettings(d1, { rateBps: 800, jurisdiction: "ZZ", taxMode: "exclusive" });

  d1.q("UPDATE orgs SET taxExempt = 1 WHERE orgId = 'acme'");
  ok("a quote from an exempt shop has no tax (rate 0)", same((await lib.getEstimate(d1, q1)).totals, { subtotal: 119, tax: 0, total: 119, taxMode: "exclusive", taxRateBps: 0 }));
  d1.q("UPDATE orgs SET taxExempt = 0 WHERE orgId = 'acme'");
  d1.q("UPDATE customers SET taxExempt = 1, taxExemptExpires = NULL WHERE id = ?", pat);
  ok("a quote for an exempt customer (no expiry) has no tax", (await lib.getEstimate(d1, q1)).totals.taxRateBps === 0 && (await lib.getEstimate(d1, q1)).totals.tax === 0);
  d1.q("UPDATE customers SET taxExemptExpires = '2027-03-10' WHERE id = ?", pat);
  ok("…nor when the exemption's last day is today", (await lib.getEstimate(d1, q1)).totals.taxRateBps === 0);
  d1.q("UPDATE customers SET taxExemptExpires = '2027-03-09' WHERE id = ?", pat);
  ok("an exemption that ran out yesterday doesn't count: the quote is taxed", (await lib.getEstimate(d1, q1)).totals.taxRateBps === 800 && (await lib.getEstimate(d1, q1)).totals.tax === 7.52);
  await lib.setLocaleSettings(d1, { timeZone: "America/Los_Angeles" });
  at("2027-03-10T05:00:00.000Z");   // 9 pm on the 9th in that zone: still the exemption's last day there
  ok("'today' for the exemption is the business's calendar day, not UTC's", (await lib.getEstimate(d1, q1)).totals.taxRateBps === 0);
  at("2027-03-10T12:00:00.000Z");
  await lib.setLocaleSettings(d1, { timeZone: "" });
  d1.q("UPDATE customers SET taxExempt = 0, taxExemptExpires = NULL WHERE id = ?", pat);

  for (const bad of [null, undefined, "", "abc", 0, -1, 1.5, "1.5"]) {
    if (await lib.getEstimate(d1, bad) !== null) ok(`getEstimate(${JSON.stringify(bad)}) is null`, false);
  }
  ok("an id that isn't a whole number above 0 finds nothing (null)", await lib.getEstimate(d1, "abc") === null && await lib.getEstimate(d1, 0) === null && await lib.getEstimate(d1, 1.5) === null);
  ok("a quote that doesn't exist is null", await lib.getEstimate(d1, 9999) === null);
  ok("an id given as text finds the quote", (await lib.getEstimate(d1, String(q1))).estimate.id === q1);
  ok("a quote with no lines comes to nothing", same((await lib.getEstimate(d1, q2)).items, []) && (await lib.getEstimate(d1, q2)).totals.total === 0);

  // Breaks on product lines.
  r = await lib.saveEstimateItems(d1, q3, [
    { kind: "product", productId: "tee", name: "Club Tee", qty: 12, unitPrice: 15, listUnitPrice: 20, customPrice: true },
    { kind: "product", productId: "tee", name: "Club Tee", qty: 1, unitPrice: 20 },
    { kind: "product", productId: "tee", name: "Club Tee", qty: 1, unitPrice: 22, listUnitPrice: 20 },
  ]);
  g = await lib.getEstimate(d1, q3);
  ok("a typed price is marked, and shows no break even when it is below the list price", g.items[0].customPrice === true && g.items[0].breakOff === 0 && g.items[0].listUnitPrice === 20);
  ok("a product line given no list price lists at its unit price, with no break", g.items[1].listUnitPrice === 20 && g.items[1].breakOff === 0);
  ok("a unit price above the list price is no break", g.items[2].breakOff === 0);

  // =====================================================================================================
  console.log("\n=== Sending a quote, and its frozen tax ===");
  r = await lib.markEstimateSent(d1, q1, { sentTo: "  pat@example.com  " });
  ok("sending answers ok, the link's token (32 hex), one send, and the tax it went out with (today's)",
    r.ok === true && /^[0-9a-f]{32}$/.test(r.token) && r.sendCount === 1 && r.taxMode === "exclusive" && r.taxRateBps === 800 && keys(r) === "ok,sendCount,taxMode,taxRateBps,token");
  const tok1 = r.token;
  ok("the quote is now sent, to that address (trimmed), at this moment, with the tax snapshot",
    same([erow(q1).status, erow(q1).sentTo, erow(q1).sentAt, erow(q1).token, erow(q1).sendCount, erow(q1).taxMode, erow(q1).taxRateBps],
      ["sent", "pat@example.com", "2027-03-10T12:00:00.000Z", tok1, 1, "exclusive", 800]));
  await lib.setSalesTaxSettings(d1, { rateBps: 500, jurisdiction: "ZZ", taxMode: "inclusive" });
  d1.q("UPDATE customers SET taxExempt = 1 WHERE id = ?", pat);
  g = await lib.getEstimate(d1, q1);
  ok("once sent, the totals keep the tax it was sent with, whatever the settings or the customer's exemption say now",
    same(g.totals, { subtotal: 119, tax: 7.52, total: 126.52, taxMode: "exclusive", taxRateBps: 800 }));
  d1.q("UPDATE customers SET taxExempt = 0 WHERE id = ?", pat);
  at("2027-03-11T09:00:00.000Z");
  r = await lib.markEstimateSent(d1, q1, { sentTo: "pat@example.com", token: TOKEN_B });
  ok("sending again keeps the first link (a new token given is ignored) and counts two sends", r.ok && r.token === tok1 && r.sendCount === 2 && erow(q1).token === tok1);
  ok("…and takes today's tax again, and the new time", r.taxMode === "inclusive" && r.taxRateBps === 500 && erow(q1).taxRateBps === 500 && erow(q1).sentAt === "2027-03-11T09:00:00.000Z");
  r = await lib.markEstimateSent(d1, q1, { sentTo: "pat@example.com", taxMode: "exclusive", taxRateBps: 712.6 });
  ok("a tax mode and rate given by the caller are used as given (the rate rounded)", r.taxMode === "exclusive" && r.taxRateBps === 713 && erow(q1).taxRateBps === 713 && r.sendCount === 3);
  r = await lib.markEstimateSent(d1, q1, { sentTo: "pat@example.com", taxMode: "bogus", taxRateBps: -5 });
  ok("…a mode that isn't one is inclusive, and a rate below 0 is 0", r.taxMode === "inclusive" && r.taxRateBps === 0);
  r = await lib.markEstimateSent(d1, q1, { sentTo: "pat@example.com", taxMode: "exclusive" });
  ok("a mode without a rate is not enough: the tax is worked out now", r.taxMode === "inclusive" && r.taxRateBps === 500);
  r = await lib.markEstimateSent(d1, q1, { sentTo: "x".repeat(250) + "@example.com" });
  ok("the address is cut to 200 characters", erow(q1).sentTo.length === 200);
  r = await lib.markEstimateSent(d1, q1);
  ok("with nothing given, the address is empty", r.ok && erow(q1).sentTo === "");

  r = await lib.createEstimate(d1, { orgId: "acme", customerId: pat, title: "With a token" });
  const q4 = r.id;
  await lib.saveEstimateItems(d1, q4, [{ kind: "custom", name: "Banner", qty: 1, unitPrice: 40 }]);
  r = await lib.markEstimateSent(d1, q4, { token: "  " + TOKEN_A });
  ok("a token that isn't a link's shape (here with spaces) is replaced with a new one", r.ok && r.token !== TOKEN_A && /^[0-9a-f]{32}$/.test(r.token));
  r = await lib.createEstimate(d1, { orgId: "acme", customerId: pat, title: "Own token" });
  const q5 = r.id;
  await lib.saveEstimateItems(d1, q5, [{ kind: "custom", name: "Banner", qty: 1, unitPrice: 40 }]);
  r = await lib.markEstimateSent(d1, q5, { token: TOKEN_A });
  ok("a token the caller made (16–128 letters, digits, - and _) is the link's on the first send", r.ok && r.token === TOKEN_A && erow(q5).token === TOKEN_A);

  const sendRefused = async (desc, id, msg) => {
    const was = JSON.stringify(erow(id));
    const res = await lib.markEstimateSent(d1, id, { sentTo: "pat@example.com" });
    ok(desc, res.error === msg && !res.ok && JSON.stringify(erow(id)) === was);
  };
  await sendRefused("a quote with no lines can't be sent, and nothing changes", q2, "Add a line to the quote before sending it.");
  ok("a quote that doesn't exist can't be sent", (await lib.markEstimateSent(d1, 9999, {})).error === NOT_FOUND && (await lib.markEstimateSent(d1, "x")).error === NOT_FOUND);
  r = await lib.createEstimate(d1, { orgId: "acme", customerId: pat, title: "Expiring", expiresOn: "2027-03-11" });
  const q6 = r.id;
  await lib.saveEstimateItems(d1, q6, [{ kind: "custom", name: "Banner", qty: 1, unitPrice: 40 }]);
  at("2027-03-12T00:30:00.000Z");
  await sendRefused("a quote whose expiry date has passed can't be sent", q6, "This quote's expiry date has passed. Change it before sending.");
  await lib.setLocaleSettings(d1, { timeZone: "America/Los_Angeles" });
  r = await lib.markEstimateSent(d1, q6, {});
  ok("…passed by the business's calendar: at 4:30 pm on the 11th there, its last day, it is sent", r.ok === true && erow(q6).status === "sent");
  await lib.setLocaleSettings(d1, { timeZone: "" });
  at("2027-03-11T09:00:00.000Z");

  // Status checks for sending: accepted, converted and cancelled.
  const setRow = (id, sets) => d1.q(`UPDATE estimates SET ${Object.keys(sets).map(k => k + " = ?").join(", ")} WHERE id = ?`, ...Object.values(sets), id);
  const mk = async (title, extra = {}, lines = [{ kind: "custom", name: "Banner", qty: 1, unitPrice: 40 }]) => {
    const res = await lib.createEstimate(d1, Object.assign({ orgId: "acme", customerId: pat, title }, extra));
    await lib.saveEstimateItems(d1, res.id, lines);
    return res.id;
  };
  const qa = await mk("Accepted one"); setRow(qa, { status: "accepted", sentAt: "s", token: "acc".repeat(6), acceptedAt: "a" });
  const qc = await mk("Cancelled one"); setRow(qc, { status: "cancelled", cancelledAt: "c" });
  d1.q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('ACME-Q1', 'acme', 'Pat Example', 'pat@example.com', 't'), ('ACME-Q2', 'acme', 'Pat Example', 'pat@example.com', 't')");
  const qv = await mk("Converted one"); setRow(qv, { status: "converted", sentAt: "s", token: "conv".repeat(5), orderId: "ACME-Q1", convertedAt: "c" });
  await sendRefused("an accepted quote can't be sent again", qa, LOCKED_ACCEPTED);
  await sendRefused("a converted quote can't be sent again", qv, LOCKED_ACCEPTED);
  await sendRefused("a cancelled quote can't be sent", qc, LOCKED_CANCELLED);
  const qch = await mk("Changes asked"); setRow(qch, { status: "changes", sentAt: "s", token: "chg".repeat(6), sendCount: 1, customerNote: "Bigger logo" });
  r = await lib.markEstimateSent(d1, qch, {});
  ok("a quote the customer asked to change is sent again: status sent, two sends, the same link", r.ok && erow(qch).status === "sent" && r.sendCount === 2 && r.token === "chg".repeat(6));
  const qr = await mk("Cancelled while sending");
  const cancelFirst = hooked(d1, /UPDATE estimates SET status = 'sent'/, () => setRow(qr, { status: "cancelled" }));
  r = await lib.markEstimateSent(cancelFirst, qr, {});
  ok("a quote cancelled just as it is sent is not sent", r.error === "This quote was answered or cancelled meanwhile. Reload it to see where it stands." &&
    erow(qr).status === "cancelled" && erow(qr).token === null && erow(qr).sendCount === 0);

  // =====================================================================================================
  console.log("\n=== The link: finding the quote, and its first view ===");
  g = await lib.getEstimateByToken(d1, tok1);
  ok("the link finds its quote, in getEstimate's shape", g && g.estimate.id === q1 && same(g, await lib.getEstimate(d1, q1)));
  ok("the link is trimmed first", (await lib.getEstimateByToken(d1, "  " + tok1 + "\n")).estimate.id === q1);
  ok("a link that isn't one finds nothing: too short, too long, other characters, not text",
    await lib.getEstimateByToken(d1, "abc") === null && await lib.getEstimateByToken(d1, "a".repeat(129)) === null &&
    await lib.getEstimateByToken(d1, "a".repeat(20) + "!") === null && await lib.getEstimateByToken(d1, 12345678901234567890) === null &&
    await lib.getEstimateByToken(d1, null) === null && await lib.getEstimateByToken(d1, undefined) === null);
  ok("a link of the right shape that no quote has finds nothing", await lib.getEstimateByToken(d1, "z".repeat(32)) === null);
  ok("16 and 128 characters are the right shape", await lib.getEstimateByToken(d1, "q".repeat(16)) === null && await lib.getEstimateByToken(d1, "q".repeat(128)) === null &&
    (setRow(q2, { token: "Ab_-".repeat(4) }), (await lib.getEstimateByToken(d1, "Ab_-".repeat(4))).estimate.id === q2));
  setRow(q2, { token: null });

  at("2027-03-11T10:00:00.000Z");
  await lib.markEstimateViewed(d1, tok1);
  ok("the first time the link is opened is recorded", erow(q1).viewedAt === "2027-03-11T10:00:00.000Z");
  at("2027-03-11T11:00:00.000Z");
  await lib.markEstimateViewed(d1, " " + tok1 + " ");
  ok("opening it again keeps the first time", erow(q1).viewedAt === "2027-03-11T10:00:00.000Z");
  const viewedBefore = JSON.stringify(d1.q("SELECT id, viewedAt FROM estimates ORDER BY id"));
  ok("a link that isn't one records nothing and doesn't throw",
    await thrown(() => lib.markEstimateViewed(d1, "short")) === "" && await thrown(() => lib.markEstimateViewed(d1, null)) === "" &&
    await thrown(() => lib.markEstimateViewed(d1, "z".repeat(32))) === "" && JSON.stringify(d1.q("SELECT id, viewedAt FROM estimates ORDER BY id")) === viewedBefore);
  ok("viewing doesn't change when the quote was last updated", erow(q1).updatedAt === "2027-03-11T09:00:00.000Z");

  // =====================================================================================================
  console.log("\n=== Changing a quote's title, message, internal note and expiry ===");
  at("2027-03-11T12:00:00.000Z");
  r = await lib.setEstimateFields(d1, q3, { title: "  New title ", message: " New message ", internalNote: " Note ", expiresOn: "2027-04-30" });
  ok("a draft's title, message, internal note and expiry all change, trimmed", r.ok === true &&
    same([r.after.title, r.after.message, r.after.internalNote, r.after.expiresOn], ["New title", "New message", "Note", "2027-04-30"]));
  ok("the answer has the quote before and after, parsed", r.before.title === "x".repeat(200) && r.before.expiresOn === "" && r.after.id === q3 && keys(r) === "after,before,ok");
  ok("…and the change is stored, with the time", erow(q3).title === "New title" && erow(q3).updatedAt === "2027-03-11T12:00:00.000Z");
  r = await lib.setEstimateFields(d1, q3, { internalNote: "Only this" });
  ok("a field left out keeps its value", r.ok && erow(q3).title === "New title" && erow(q3).message === "New message" && erow(q3).expiresOn === "2027-04-30" && erow(q3).internalNote === "Only this");
  r = await lib.setEstimateFields(d1, q3, { expiresOn: "" });
  ok("an empty expiry date clears it (NULL)", r.ok && erow(q3).expiresOn === null && r.after.expiresOn === "");
  r = await lib.setEstimateFields(d1, q3, { expiresOn: null, title: null });
  ok("null clears a text and leaves no expiry", r.ok && erow(q3).title === "" && erow(q3).expiresOn === null);
  r = await lib.setEstimateFields(d1, q3, { title: "t".repeat(300), message: "m".repeat(3500), internalNote: "n".repeat(2500) });
  ok("the same caps apply: 200, 3000 and 2000 characters", erow(q3).title.length === 200 && erow(q3).message.length === 3000 && erow(q3).internalNote.length === 2000);
  let was = JSON.stringify(erow(q3));
  r = await lib.setEstimateFields(d1, q3, { title: "Fine", expiresOn: "2027-13-01" });
  ok("a bad expiry date is refused, and nothing else changes either", r.error === "The expiry date isn't a date." && JSON.stringify(erow(q3)) === was);
  ok("a quote that doesn't exist can't be changed", (await lib.setEstimateFields(d1, 9999, { title: "x" })).error === NOT_FOUND);
  r = await lib.setEstimateFields(d1, q3);
  ok("with no fields given, nothing is changed but the time", r.ok && erow(q3).title === "t".repeat(200));

  // q1 is sent.
  was = JSON.stringify(erow(q1));
  for (const [field, value] of [["title", "Other"], ["message", "Other"], ["expiresOn", "2027-12-31"]]) {
    r = await lib.setEstimateFields(d1, q1, { [field]: value, internalNote: "with it" });
    ok(`a sent quote's ${field} can't change (and the internal note with it doesn't either)`, r.error === LOCKED_SENT && JSON.stringify(erow(q1)) === was);
  }
  r = await lib.setEstimateFields(d1, q1, { expiresOn: "" });
  ok("…nor can its expiry date be cleared", r.error === LOCKED_SENT);
  r = await lib.setEstimateFields(d1, q1, { title: "Team shirts", message: "Thanks for asking.", expiresOn: "2027-03-31", internalNote: "Called Pat" });
  ok("a sent quote's internal note changes, with the other fields given as they already are", r.ok && erow(q1).internalNote === "Called Pat" && erow(q1).status === "sent");
  for (const [id, msg, what] of [[qa, LOCKED_ACCEPTED, "an accepted"], [qv, LOCKED_ACCEPTED, "a converted"], [qc, LOCKED_CANCELLED, "a cancelled"]]) {
    const w = JSON.stringify(erow(id));
    r = await lib.setEstimateFields(d1, id, { title: "Changed" });
    const r2 = await lib.setEstimateFields(d1, id, { internalNote: "Kept for later" });
    ok(`${what} quote's title can't change ("${msg}"), but its internal note can`, r.error === msg && JSON.parse(w).title === erow(id).title && r2.ok && erow(id).internalNote === "Kept for later" && erow(id).title !== "Changed");
  }
  setRow(qch, { status: "changes" });   // sent again above; the customer asks for changes once more
  r = await lib.setEstimateFields(d1, qch, { title: "Revised", message: "Logo made bigger", expiresOn: "2027-05-01" });
  ok("a quote the customer asked to change can be revised", r.ok && erow(qch).title === "Revised" && erow(qch).expiresOn === "2027-05-01" && erow(qch).status === "changes");

  // =====================================================================================================
  console.log("\n=== Saving a quote's lines ===");
  const icount = (id) => d1.q("SELECT count(*) AS n FROM estimate_items WHERE estimateId = ?", id)[0].n;
  const irows = (id) => d1.q("SELECT * FROM estimate_items WHERE estimateId = ? ORDER BY position", id);
  const q7 = await mk("Lines", {}, []);
  const saveRefused = async (desc, id, items, msg) => {
    const w = JSON.stringify(irows(id));
    const res = await lib.saveEstimateItems(d1, id, items);
    ok(desc, res.error === msg && !res.ok && JSON.stringify(irows(id)) === w);
  };
  await lib.saveEstimateItems(d1, q7, [{ kind: "custom", name: "Keep me", qty: 1, unitPrice: 1 }]);
  await saveRefused("a quote that doesn't exist has no lines to save", 9999, [], NOT_FOUND);
  await saveRefused("a sent quote's lines can't change", q1, [], LOCKED_SENT);
  await saveRefused("an accepted quote's lines can't change", qa, [], LOCKED_ACCEPTED);
  await saveRefused("a converted quote's lines can't change", qv, [], LOCKED_ACCEPTED);
  await saveRefused("a cancelled quote's lines can't change", qc, [], LOCKED_CANCELLED);
  await saveRefused("the lines must be a list", q7, { kind: "custom" }, "The quote's lines must be a list.");
  await saveRefused("no list at all is refused too", q7, undefined, "The quote's lines must be a list.");
  const hundredOne = Array.from({ length: 101 }, () => ({ kind: "custom", name: "Patch", qty: 1, unitPrice: 1 }));
  await saveRefused("a quote can have up to 100 lines: 101 is refused", q7, hundredOne, "A quote can have up to 100 lines.");
  const L = (o) => Object.assign({ kind: "custom", name: "Patch", qty: 1, unitPrice: 1 }, o);
  const ok1 = L({});
  await saveRefused("a line that isn't a product, custom line or fee is refused, by its number", q7, [ok1, L({ kind: "discount" })], "Line 2 isn't a product, a custom line or a fee.");
  await saveRefused("a line that isn't an object is refused", q7, [null], "Line 1 isn't a product, a custom line or a fee.");
  await saveRefused("…nor is text", q7, ["custom"], "Line 1 isn't a product, a custom line or a fee.");
  const QTY = "the quantity must be a whole number from 1 to 5,000.";
  await saveRefused("a quantity of 0 is refused", q7, [L({ qty: 0 })], "Line 1: " + QTY);
  await saveRefused("a quantity of 5,001 is refused", q7, [ok1, ok1, L({ qty: 5001 })], "Line 3: " + QTY);
  await saveRefused("a quantity of 1.5 is refused", q7, [L({ qty: 1.5 })], "Line 1: " + QTY);
  await saveRefused("no quantity is refused", q7, [L({ qty: undefined })], "Line 1: " + QTY);
  await saveRefused("a custom line needs a description", q7, [L({ name: "   " })], "Line 1 needs a description.");
  await saveRefused("a product line needs a description", q7, [L({ kind: "product", productId: "tee", name: "" })], "Line 1 needs a description.");
  const PRICE = "Line 1 needs a price of $0 or more.";
  await saveRefused("a price below $0 is refused", q7, [L({ unitPrice: -1 })], PRICE);
  await saveRefused("an empty price is refused", q7, [L({ unitPrice: "" })], PRICE);
  await saveRefused("no price is refused", q7, [L({ unitPrice: null })], PRICE);
  await saveRefused("a price that isn't a number is refused", q7, [L({ unitPrice: "ten" })], PRICE);
  await saveRefused("a price of $1,000,000 or more is refused", q7, [L({ unitPrice: 1000000 })], PRICE);
  await saveRefused("a fee with no amount is refused", q7, [{ kind: "fee", feeKind: "art", name: "Art" }], PRICE);
  await saveRefused("a product line needs a product", q7, [L({ kind: "product", productId: "  " })], "Line 1 needs a product.");
  await saveRefused("a personalization price that isn't a price is refused", q7, [L({ kind: "product", productId: "tee", personalized: true, personalizationFee: -2 })],
    "Line 1: the personalization price isn't a price.");
  ok("…and after every refusal the quote's old line is still there", irows(q7).length === 1 && irows(q7)[0].name === "Keep me");

  at("2027-03-11T13:00:00.000Z");
  r = await lib.saveEstimateItems(d1, q7, [
    L({ name: "  Patch  ", qty: "4", unitPrice: "2.505", type: "y".repeat(100), size: "XL", config: { a: 1 }, personalized: true, persName: "X" }),
    { kind: "fee", feeKind: "rush", name: " Rush ", amount: 10, qty: 50, taxable: false },
    { kind: "fee", feeKind: "digitizing", unitPrice: 30 },
    { kind: "fee", feeKind: "art", name: "Art", amount: 0, unitPrice: 99 },
    L({ kind: "product", productId: "gift", name: "Gift Card", qty: 2, unitPrice: 10, taxable: true, size: "z".repeat(50), personalized: false, persName: "ignored",
      personalizationFee: 3, listUnitPrice: "abc" }),
    L({ kind: "product", productId: "btee", name: "Works Tee", qty: 1, unitPrice: 10 }),
    L({ kind: "product", productId: "tee", name: "Club Tee", qty: 5000, unitPrice: 0, listUnitPrice: "", taxable: false, personalized: true, personalizationFee: 0, persName: "n".repeat(250) }),
    L({ kind: "product", productId: "ghost", name: "Ghost Tee", qty: 1, unitPrice: 5, taxable: false }),
  ]);
  ok("the lines are saved, and the answer counts them", r.ok === true && r.lines === 8);
  const rows7 = irows(q7);
  ok("the old line is gone: the lines are replaced, not added to", rows7.length === 8 && !rows7.some(x => x.name === "Keep me"));
  ok("they keep the order they were given (position 0 to 7)", same(rows7.map(x => x.position), [0, 1, 2, 3, 4, 5, 6, 7]));
  const [c0, f1, f2, f3, p4, p5, p6, p7] = rows7;
  ok("a custom line: the description trimmed, a quantity given as text taken, the price rounded to the cent, the type cut to 80",
    c0.name === "Patch" && c0.qty === 4 && c0.unitPriceCents === 251 && c0.listUnitCents === 251 && c0.type.length === 80 && c0.lineTotalCents === 1004);
  ok("a custom line keeps no size, choices or personalization", c0.size === "" && c0.configJson === "" && c0.personalized === 0 && c0.persName === "" && c0.customPrice === 0 && c0.taxable === 1);
  ok("a fee is always one piece, whatever quantity is given, and its kind outside the four is 'other'", f1.qty === 1 && f1.feeKind === "other" && f1.name === "Rush" && f1.lineTotalCents === 1000 && f1.taxable === 0);
  ok("a fee may have no description, and takes unitPrice when it has no amount", f2.name === "" && f2.feeKind === "digitizing" && f2.unitPriceCents === 3000 && f2.taxable === 1);
  ok("a fee's amount wins over a unitPrice, even an amount of $0", f3.unitPriceCents === 0 && f3.feeKind === "art");
  ok("a fee has no type", f1.type === "" && f2.type === "");
  ok("a product line is taxed as its product is, not as the line says (the gift card isn't taxable)", p4.taxable === 0);
  ok("…and a taxable product's line is taxable even when the line says it isn't", p6.taxable === 1);
  ok("a product of another shop is not looked up: the line's own setting (taxable by default) stands", p5.productId === "btee" && p5.taxable === 1);
  ok("a product that isn't in the catalog keeps the line's setting", p7.productId === "ghost" && p7.taxable === 0);
  ok("a list price that isn't a number is the unit price", p4.listUnitCents === 1000);
  ok("an empty list price is the unit price", p6.listUnitCents === 0);
  ok("a product line that isn't personalized keeps no personalization price or name", p4.personalized === 0 && p4.persName === "" && p4.personalizationFeeCents === 0 && p4.lineTotalCents === 2000);
  ok("a product's size is cut to 40 characters, the personalized name to 200", p4.size.length === 40 && p6.persName.length === 200 && p6.personalized === 1);
  ok("5,000 pieces at $0 is a line of $0", p6.qty === 5000 && p6.lineTotalCents === 0);
  ok("the quote's time is updated", erow(q7).updatedAt === "2027-03-11T13:00:00.000Z");
  const hundred = Array.from({ length: 100 }, (_, i) => ({ kind: "custom", name: "Patch " + i, qty: 1, unitPrice: 1 }));
  r = await lib.saveEstimateItems(d1, q7, hundred);
  ok("exactly 100 lines are taken", r.ok && r.lines === 100 && icount(q7) === 100);
  r = await lib.saveEstimateItems(d1, q7, []);
  ok("an empty list clears the lines", r.ok && r.lines === 0 && icount(q7) === 0);
  r = await lib.saveEstimateItems(d1, qch, [{ kind: "custom", name: "Bigger logo", qty: 1, unitPrice: 45 }]);
  ok("a quote the customer asked to change takes new lines", r.ok && irows(qch)[0].unitPriceCents === 4500);

  // Statements all go in one batch: a failure part-way leaves the old lines.
  await lib.saveEstimateItems(d1, q7, [L({ name: "Old line" })]);
  let batches = 0;
  const failMid = { _raw: d1._raw, q: d1.q, prepare: (s) => d1.prepare(s),
    batch: async (stmts) => { batches++; d1.q("UPDATE estimates SET title = title WHERE id = ?", q7);
      const bad = stmts.slice(); bad.splice(2, 0, d1.prepare("INSERT INTO estimate_items (estimateId, kind, name) VALUES (?, 'nonsense', 'x')").bind(q7)); return d1.batch(bad); } };
  err = await thrown(() => lib.saveEstimateItems(failMid, q7, [L({ name: "New 1" }), L({ name: "New 2" })]));
  ok("the delete and the inserts are one batch: when one statement fails, the old lines are still there", batches === 1 && /CHECK/.test(err) &&
    same(irows(q7).map(x => x.name), ["Old line"]));
  const q8 = await mk("Sent meanwhile", {}, [L({ name: "As sent" })]);
  const sendFirst = hooked(d1, /DELETE FROM estimate_items/, () => setRow(q8, { status: "sent", sentAt: "s" }));
  r = await lib.saveEstimateItems(sendFirst, q8, [L({ name: "Too late" })]);
  ok("a quote sent while its lines were being saved keeps the lines it was sent with", r.error === "This quote was sent or answered meanwhile. Reload it to see where it stands." &&
    same(irows(q8).map(x => x.name), ["As sent"]));

  // =====================================================================================================
  console.log("\n=== The customer's answer ===");
  at("2027-03-12T10:00:00.000Z");
  const answer = (tok, o) => lib.respondToEstimate(d1, tok, o);
  // q5 (TOKEN_A) is sent with no expiry; q1 (tok1) is sent, expiring 2027-03-31.
  ok("a link that isn't one is refused", (await answer("nope", { accept: true })).error === BAD_LINK && (await answer(null, { accept: true })).error === BAD_LINK &&
    (await answer(undefined)).error === BAD_LINK);
  ok("a link of the right shape that no quote has is refused", (await answer("z".repeat(32), { accept: true })).error === BAD_LINK);
  const qd = await mk("Draft with a token"); setRow(qd, { token: "drf".repeat(6) });
  ok("a draft can't be answered, even with a token", (await answer("drf".repeat(6), { accept: true })).error === "This quote hasn't been sent yet." && erow(qd).status === "draft");
  const qs = await mk("Sent with no time"); setRow(qs, { token: "nst".repeat(6), status: "sent" });
  ok("a quote marked sent but with no send time can't be answered", (await answer("nst".repeat(6), { note: "x" })).error === "This quote hasn't been sent yet.");
  setRow(qc, { token: "cnl".repeat(6), sentAt: "s" });
  ok("a cancelled quote can't be accepted or answered", (await answer("cnl".repeat(6), { accept: true })).error === "This quote was cancelled." &&
    (await answer("cnl".repeat(6), { note: "x" })).error === "This quote was cancelled.");
  ok("an accepted quote can't be answered again", (await answer("acc".repeat(6), { accept: true })).error === "This quote has already been accepted." &&
    (await answer("acc".repeat(6), { note: "x" })).error === "This quote has already been accepted.");
  ok("nor can a converted one", (await answer("conv".repeat(5), { accept: true })).error === "This quote has already been accepted.");

  r = await answer(" " + TOKEN_A + " ", { note: "  Can the logo be bigger?  " });
  ok("asking for changes answers ok, status changes, and the quote's id", r.ok === true && r.status === "changes" && r.id === q5 && keys(r) === "id,ok,status");
  ok("…the note is stored trimmed, with when they answered", erow(q5).status === "changes" && erow(q5).customerNote === "Can the logo be bigger?" &&
    erow(q5).respondedAt === "2027-03-12T10:00:00.000Z" && erow(q5).updatedAt === erow(q5).respondedAt && erow(q5).acceptedAt === null);
  at("2027-03-12T11:00:00.000Z");
  r = await answer(TOKEN_A, { accept: false, note: "And navy, please." });
  ok("asking again while waiting replaces the note", r.ok && erow(q5).customerNote === "And navy, please." && erow(q5).respondedAt === "2027-03-12T11:00:00.000Z");
  // q5 was sent at 5% inclusive; while the customer's changes are open it is being worked on again, so it shows today's tax.
  ok("(q5 was sent with 5% inclusive)", erow(q5).taxRateBps === 500 && erow(q5).taxMode === "inclusive");
  await lib.setSalesTaxSettings(d1, { rateBps: 300, jurisdiction: "ZZ", taxMode: "exclusive" });
  ok("a quote sent back for changes is taxed as it would be today again, not as it was sent",
    same((await lib.getEstimate(d1, q5)).totals, { subtotal: 40, tax: 1.2, total: 41.2, taxMode: "exclusive", taxRateBps: 300 }));
  ok("…in the list too", (await lib.listEstimates(d1, { status: "changes", q: "Own token" })).estimates[0].total === 41.2);
  await lib.setSalesTaxSettings(d1, { rateBps: 500, jurisdiction: "ZZ", taxMode: "inclusive" });
  was = JSON.stringify(erow(q5));
  r = await answer(TOKEN_A, { accept: true });
  ok("accepting while waiting on their own changes is refused, and nothing changes", r.error === ACCEPT_WHILE_CHANGES && JSON.stringify(erow(q5)) === was);
  for (const note of ["", "   ", null, undefined]) {
    r = await answer(tok1, { note });
    if (r.error !== "Say what you'd like changed.") ok(`a changes request with the note ${JSON.stringify(note)} is refused`, false);
  }
  ok("asking for changes with an empty note (or none) is refused", (await answer(tok1, { note: " " })).error === "Say what you'd like changed." &&
    (await answer(tok1, {})).error === "Say what you'd like changed." && erow(q1).status === "sent");
  r = await answer(tok1, { note: "n".repeat(2100) });
  ok("a long note is cut to 2000 characters", r.ok && erow(q1).customerNote.length === 2000);
  setRow(q1, { status: "sent" });

  // Expiry, by the business's calendar. q1 expires 2027-03-31.
  await lib.setLocaleSettings(d1, { timeZone: "Asia/Tokyo" });
  at("2027-03-31T14:30:00.000Z");   // 11:30 pm on the 31st in Tokyo: its last day
  was = JSON.stringify(erow(q1));
  r = await answer(tok1, { note: "Still time?" });
  ok("on its last day (by the business's clock) a quote can still be answered", r.ok && erow(q1).status === "changes");
  setRow(q1, { status: "sent", customerNote: "" });
  at("2027-03-31T15:30:00.000Z");   // 12:30 am on 1 April in Tokyo, still the 31st in UTC
  was = JSON.stringify(erow(q1));
  r = await answer(tok1, { accept: true });
  ok("the day after its expiry date where the business is, it is refused as expired, naming the date", r.error === "This quote expired on 2027-03-31." && JSON.stringify(erow(q1)) === was);
  ok("…and asking for changes is refused the same way", (await answer(tok1, { note: "x" })).error === "This quote expired on 2027-03-31.");
  await lib.setLocaleSettings(d1, { timeZone: "America/Los_Angeles" });
  at("2027-04-01T06:30:00.000Z");   // 11:30 pm on the 31st in Los Angeles, already 1 April in UTC
  r = await answer(tok1, { accept: true });
  ok("in a zone behind UTC, it can still be accepted on its last evening", r.ok === true && r.status === "accepted" && r.id === q1);
  ok("accepting stores status accepted, when, and when they answered", erow(q1).status === "accepted" && erow(q1).acceptedAt === "2027-04-01T06:30:00.000Z" &&
    erow(q1).respondedAt === erow(q1).acceptedAt && erow(q1).updatedAt === erow(q1).acceptedAt);
  ok("a second accept is refused", (await answer(tok1, { accept: true })).error === "This quote has already been accepted.");
  await lib.setLocaleSettings(d1, { timeZone: "" });
  at("2027-03-12T12:00:00.000Z");
  const expiredChanges = await mk("Expired after changes", { expiresOn: "2027-03-11" });
  setRow(expiredChanges, { status: "changes", sentAt: "s", token: "exc".repeat(6) });
  ok("a quote waiting on changes whose date passed can't be answered either (expired comes first)", (await answer("exc".repeat(6), { accept: true })).error === "This quote expired on 2027-03-11.");

  // Two answers at the same moment.
  const qx = await mk("Raced answer"); setRow(qx, { status: "sent", sentAt: "s", token: "rce".repeat(6) });
  let racing = hooked(d1, /UPDATE estimates SET status = 'accepted'/, () => setRow(qx, { status: "cancelled" }));
  r = await lib.respondToEstimate(racing, "rce".repeat(6), { accept: true });
  ok("an accept that loses to a cancel says the quote was cancelled, and doesn't accept it", r.error === "This quote was cancelled." && erow(qx).status === "cancelled" && erow(qx).acceptedAt === null);
  setRow(qx, { status: "sent" });
  racing = hooked(d1, /UPDATE estimates SET status = 'accepted'/, () => setRow(qx, { status: "changes", customerNote: "Wait" }));
  r = await lib.respondToEstimate(racing, "rce".repeat(6), { accept: true });
  ok("an accept that loses to a changes request says the quote changed meanwhile", r.error === "This quote changed meanwhile. Open the link again to see it." && erow(qx).status === "changes");
  setRow(qx, { status: "sent", customerNote: "" });
  racing = hooked(d1, /UPDATE estimates SET status = 'accepted'/, () => setRow(qx, { status: "accepted", acceptedAt: "a" }));
  r = await lib.respondToEstimate(racing, "rce".repeat(6), { accept: true });
  ok("two accepts at once: the second is told it was already accepted", r.error === "This quote has already been accepted.");
  setRow(qx, { status: "sent", acceptedAt: null });
  racing = hooked(d1, /UPDATE estimates SET status = 'changes'/, () => setRow(qx, { status: "accepted", acceptedAt: "a" }));
  r = await lib.respondToEstimate(racing, "rce".repeat(6), { note: "Too late" });
  ok("a changes request that loses to an accept is told it was accepted, and the note is not kept", r.error === "This quote has already been accepted." && erow(qx).customerNote === "");
  setRow(qx, { status: "sent", acceptedAt: null });
  racing = hooked(d1, /UPDATE estimates SET status = 'changes'/, () => setRow(qx, { status: "draft" }));
  r = await lib.respondToEstimate(racing, "rce".repeat(6), { note: "Hello" });
  ok("a changes request that loses to staff taking the quote back to draft is told it isn't sent", r.error === "This quote hasn't been sent yet.");
  setRow(qx, { status: "sent" });
  racing = hooked(d1, /UPDATE estimates SET status = 'changes'/, () => d1.q("DELETE FROM estimates WHERE id = ?", qx));
  r = await lib.respondToEstimate(racing, "rce".repeat(6), { note: "Hello" });
  ok("…and one whose quote disappeared meanwhile is told it changed", r.error === "This quote changed meanwhile. Open the link again to see it.");

  // =====================================================================================================
  console.log("\n=== Becoming an order, and being cancelled ===");
  const qo = await mk("To convert"); setRow(qo, { status: "accepted", sentAt: "s", acceptedAt: "a" });
  at("2027-03-13T09:00:00.000Z");
  r = await lib.setEstimateConverted(d1, qo, "ACME-Q2");
  ok("converting answers ok and the order", r.ok === true && r.orderId === "ACME-Q2" && keys(r) === "ok,orderId");
  ok("the quote is converted, linked to the order, with when", erow(qo).status === "converted" && erow(qo).orderId === "ACME-Q2" &&
    erow(qo).convertedAt === "2027-03-13T09:00:00.000Z" && erow(qo).updatedAt === erow(qo).convertedAt);
  at("2027-03-13T10:00:00.000Z");
  r = await lib.setEstimateConverted(d1, qo, "ACME-Q2");
  ok("converting again to the same order answers the same, and changes nothing", r.ok === true && r.orderId === "ACME-Q2" && erow(qo).convertedAt === "2027-03-13T09:00:00.000Z");
  r = await lib.setEstimateConverted(d1, qo, "ACME-Q1");
  ok("converting to a different order is refused, naming the order it already is", r.error === "This quote is already order ACME-Q2." && r.orderId === "ACME-Q2" && !r.ok && erow(qo).orderId === "ACME-Q2");
  ok("a quote that doesn't exist can't be converted", (await lib.setEstimateConverted(d1, 9999, "ACME-Q1")).error === NOT_FOUND);
  const qn = await mk("Draft to convert");
  ok("converting needs an order", (await lib.setEstimateConverted(d1, qn, "")).error === "There's no order to link the quote to." &&
    (await lib.setEstimateConverted(d1, qn, null)).error === "There's no order to link the quote to." && erow(qn).status === "draft");
  d1.q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('ACME-Q3', 'acme', 'Pat Example', 'pat@example.com', 't'), ('ACME-Q4', 'acme', 'Pat Example', 'pat@example.com', 't')");
  ok("a cancelled quote can't be converted", (await lib.setEstimateConverted(d1, qc, "ACME-Q3")).error === "This quote was cancelled." && erow(qc).orderId === null);
  r = await lib.setEstimateConverted(d1, qn, "ACME-Q3");
  ok("a draft can be converted (staff's Convert to order works at any open status)", r.ok && erow(qn).status === "converted");
  const qy = await mk("Converted twice at once");
  racing = hooked(d1, /UPDATE estimates SET status = 'converted'/, () => setRow(qy, { status: "converted", orderId: "ACME-Q4" }));
  r = await lib.setEstimateConverted(racing, qy, "ACME-Q1");
  ok("two conversions at once: the second is told the order the first made", r.error === "This quote is already order ACME-Q4." && r.orderId === "ACME-Q4");
  const qz = await mk("Same order at once");
  racing = hooked(d1, /UPDATE estimates SET status = 'converted'/, () => setRow(qz, { status: "converted", orderId: "ACME-Q1" }));
  r = await lib.setEstimateConverted(racing, qz, "ACME-Q1");
  ok("…and when it was the same order, that is ok", r.ok === true && r.orderId === "ACME-Q1");
  const qw = await mk("Cancelled while converting");
  racing = hooked(d1, /UPDATE estimates SET status = 'converted'/, () => setRow(qw, { status: "cancelled" }));
  r = await lib.setEstimateConverted(racing, qw, "ACME-Q1");
  ok("a quote cancelled just as it is converted stays cancelled", r.error === "This quote was cancelled." && erow(qw).orderId === null && erow(qw).status === "cancelled");

  at("2027-03-14T09:00:00.000Z");
  const qk = await mk("To cancel", { expiresOn: "2027-03-20" });
  r = await lib.cancelEstimate(d1, qk);
  ok("cancelling answers ok and the quote as it was", r.ok === true && r.before.id === qk && r.before.status === "draft" && r.before.title === "To cancel" && keys(r) === "before,ok");
  ok("the quote is cancelled, with when", erow(qk).status === "cancelled" && erow(qk).cancelledAt === "2027-03-14T09:00:00.000Z" && erow(qk).updatedAt === erow(qk).cancelledAt);
  ok("a cancelled quote can't be cancelled again", (await lib.cancelEstimate(d1, qk)).error === "This quote is already cancelled.");
  ok("a converted quote can't be cancelled", (await lib.cancelEstimate(d1, qo)).error === "This quote is already an order. Void the order instead." && erow(qo).status === "converted");
  const qlinked = await mk("Linked but accepted"); setRow(qlinked, { status: "accepted", orderId: "ACME-Q3" });
  ok("nor can a quote that has an order, whatever its status says", (await lib.cancelEstimate(d1, qlinked)).error === "This quote is already an order. Void the order instead.");
  ok("a quote that doesn't exist can't be cancelled", (await lib.cancelEstimate(d1, 9999)).error === NOT_FOUND);
  for (const st of ["sent", "changes", "accepted"]) {
    const id = await mk("Cancel " + st); setRow(id, { status: st, sentAt: "s" });
    r = await lib.cancelEstimate(d1, id);
    if (!(r.ok && erow(id).status === "cancelled" && r.before.status === st)) ok(`a ${st} quote can be cancelled`, false);
  }
  ok("a sent, a changes and an accepted quote can each be cancelled", d1.q("SELECT count(*) AS n FROM estimates WHERE title LIKE 'Cancel %' AND status = 'cancelled'")[0].n === 3);
  const qj = await mk("Converted while cancelling");
  racing = hooked(d1, /UPDATE estimates SET status = 'cancelled'/, () => setRow(qj, { status: "converted", orderId: "ACME-Q4" }));
  r = await lib.cancelEstimate(racing, qj);
  ok("a quote that becomes an order just as it is cancelled stays the order", r.error === "This quote became an order meanwhile. Reload it to see where it stands." && erow(qj).status === "converted");

  // =====================================================================================================
  console.log("\n=== When a quote has expired ===");
  const ex = lib.estimateExpired;
  const day = (iso) => RealDate.parse(iso);
  ok("a quote with no expiry date never expires", ex({ expiresOn: null }, day("2099-01-01T00:00:00Z")) === false && ex({}, day("2099-01-01T00:00:00Z")) === false &&
    ex(null, day("2099-01-01T00:00:00Z")) === false);
  ok("an expiry date that isn't YYYY-MM-DD never expires", ex({ expiresOn: "March 1" }, day("2099-01-01T00:00:00Z")) === false && ex({ expiresOn: "2027-3-1" }, day("2099-01-01T00:00:00Z")) === false);
  ok("on its last day it hasn't expired, to the last second (UTC)", ex({ expiresOn: "2027-03-31" }, day("2027-03-31T23:59:59Z"), "UTC") === false);
  ok("the next day it has", ex({ expiresOn: "2027-03-31" }, day("2027-04-01T00:00:00Z"), "UTC") === true);
  ok("before its last day it hasn't", ex({ expiresOn: "2027-03-31" }, day("2027-03-01T00:00:00Z"), "UTC") === false);
  ok("the day is the business's: already expired in Tokyo while still the 31st in UTC", ex({ expiresOn: "2027-03-31" }, day("2027-03-31T16:00:00Z"), "Asia/Tokyo") === true);
  ok("…and still open in Los Angeles while already 1 April in UTC", ex({ expiresOn: "2027-03-31" }, day("2027-04-01T05:00:00Z"), "America/Los_Angeles") === false);
  ok("an unknown time zone counts as UTC", ex({ expiresOn: "2027-03-31" }, day("2027-04-01T05:00:00Z"), "Not/AZone") === true);
  ok("with no zone given it uses the install's as last resolved (none yet here: UTC)", ex({ expiresOn: "2027-03-31" }, day("2027-04-01T05:00:00Z")) === true);
  at("2027-04-01T05:00:00Z");
  ok("with no time given it is now", ex({ expiresOn: "2027-03-31" }) === true && ex({ expiresOn: "2027-04-01" }) === false);

  // The expired flag on a quote read back.
  at("2027-03-20T12:00:00.000Z");
  const flagFor = async (st) => {
    const id = await mk("Flag " + st, { expiresOn: "2027-03-19" });
    if (st !== "draft") setRow(id, { status: st, sentAt: "s", orderId: st === "converted" ? "ACME-Q3" : null });
    return (await lib.getEstimate(d1, id)).estimate.expired;
  };
  ok("a draft, sent or changes quote past its date reads as expired",
    await flagFor("draft") === true && await flagFor("sent") === true && await flagFor("changes") === true);
  ok("an accepted, converted or cancelled one never does", await flagFor("accepted") === false && await flagFor("converted") === false && await flagFor("cancelled") === false);
  await lib.setLocaleSettings(d1, { timeZone: "America/Los_Angeles" });
  at("2027-03-20T05:00:00.000Z");   // 10 pm on the 19th there
  const flagId = d1.q("SELECT id FROM estimates WHERE title = 'Flag draft'")[0].id;
  ok("the flag is worked out on the business's calendar", (await lib.getEstimate(d1, flagId)).estimate.expired === false);
  await lib.setLocaleSettings(d1, { timeZone: "" });
  d1.q("DELETE FROM estimates WHERE title LIKE 'Flag %'");

  // =====================================================================================================
  console.log("\n=== The list of quotes ===");
  const L2 = await makeDb();
  const lc = (name, company, email, ex2 = {}) => { L2.q("INSERT INTO customers (name, company, email, taxExempt, createdAt, updatedAt) VALUES (?, ?, ?, ?, 't', 't')", name, company, email, ex2.taxExempt || 0);
    return L2.q("SELECT max(id) AS id FROM customers")[0].id; };
  const lp = lc("Pat Example", "Example Club", "pat@example.com"), ls = lc("", "Sample Works", "orders@sample.example"), lx = lc("Lee Exempt", "", "lee@example.com", { taxExempt: 1 });
  await lib.setSalesTaxSettings(L2, { rateBps: 1000, jurisdiction: "ZZ", taxMode: "exclusive" });
  const made = [];
  const lm = async (iso, args, lines, after) => {
    at(iso);
    const res = await lib.createEstimate(L2, Object.assign({ orgId: "acme" }, args));
    if (lines) await lib.saveEstimateItems(L2, res.id, lines);
    if (after) await after(res.id);
    made.push(res.id);
    return res.id;
  };
  const ln = (unitPrice, taxable = true) => [{ kind: "custom", name: "Patch", qty: 1, unitPrice, taxable }];
  const e1 = await lm("2027-03-01T10:00:00.000Z", { customerId: lp, title: "Spring shirts", expiresOn: "2027-03-05" }, ln(100));
  const e2 = await lm("2027-03-02T10:00:00.000Z", { customerId: ls, title: "Caps 100% cotton" }, ln(50), async (id) => {
    await lib.markEstimateSent(L2, id, { sentTo: "orders@sample.example" }); });
  const e3 = await lm("2027-03-03T10:00:00.000Z", { orgId: "beta", customerId: lp, title: "Hoodies" }, ln(200, false));
  const e4 = await lm("2027-03-04T10:00:00.000Z", { customerId: lx, title: "Bags" }, ln(30));
  const e5 = await lm("2027-03-04T10:00:00.000Z", { customerId: lp, title: "Same moment" }, ln(10), async (id) => { await lib.cancelEstimate(L2, id); });
  at("2027-03-10T12:00:00.000Z");
  await lib.setSalesTaxSettings(L2, { rateBps: 2000, jurisdiction: "ZZ", taxMode: "exclusive" });
  let li = await lib.listEstimates(L2);
  ok("with no filter, every quote, with the count of all", li.total === 5 && li.estimates.length === 5);
  ok("most recently changed first, and the later id first when two changed at the same moment", same(li.estimates.map(e => e.id), [e5, e4, e3, e2, e1]));
  const one = li.estimates.find(e => e.id === e1);
  ok("an entry has its id, number, shop, customer, title, status, total, expiry, expired flag, sent and updated times and order",
    keys(one) === "customerId,customerName,expired,expiresOn,id,number,orderId,orgId,sentAt,status,title,total,updatedAt");
  ok("…as the quote has them", one.number === "Q-00001" && one.orgId === "acme" && one.customerId === lp && one.customerName === "Pat Example" && one.title === "Spring shirts" &&
    one.status === "draft" && one.expiresOn === "2027-03-05" && one.sentAt === "" && one.orderId === "" && one.updatedAt === "2027-03-01T10:00:00.000Z");
  ok("a draft past its date is flagged expired; one with no date isn't", one.expired === true && li.estimates.find(e => e.id === e4).expired === false);
  ok("a customer with no name is listed by company", li.estimates.find(e => e.id === e2).customerName === "Sample Works");
  ok("a draft's total uses today's tax (20% added)", one.total === 120);
  ok("a sent quote's total uses the tax it was sent with (10% added)", li.estimates.find(e => e.id === e2).total === 55 && li.estimates.find(e => e.id === e2).sentAt === "2027-03-02T10:00:00.000Z");
  ok("a line that isn't taxable adds no tax", li.estimates.find(e => e.id === e3).total === 200);
  ok("an exempt customer's draft has no tax", li.estimates.find(e => e.id === e4).total === 30);
  ok("…and the totals match getEstimate's", (await lib.getEstimate(L2, e1)).totals.total === 120 && (await lib.getEstimate(L2, e2)).totals.total === 55 && (await lib.getEstimate(L2, e4)).totals.total === 30);
  L2.q("UPDATE orgs SET taxExempt = 1 WHERE orgId = 'acme'");
  ok("an exempt shop's draft has no tax in the list either", (await lib.listEstimates(L2, { status: "draft", orgId: "acme" })).estimates.find(e => e.id === e1).total === 100);
  L2.q("UPDATE orgs SET taxExempt = 0 WHERE orgId = 'acme'");
  const ids = async (f) => (await lib.listEstimates(L2, f)).estimates.map(e => e.id);
  ok("by shop", same(await ids({ orgId: "beta" }), [e3]) && (await lib.listEstimates(L2, { orgId: "beta" })).total === 1);
  ok("by customer (a number or text)", same(await ids({ customerId: lp }), [e5, e3, e1]) && same(await ids({ customerId: String(ls) }), [e2]));
  ok("a customer id that isn't one lists nothing", same(await lib.listEstimates(L2, { customerId: "abc" }), { estimates: [], total: 0 }) &&
    same(await lib.listEstimates(L2, { customerId: 0 }), { estimates: [], total: 0 }));
  ok("an empty customer id is no filter", (await lib.listEstimates(L2, { customerId: "" })).total === 5);
  ok("by status", same(await ids({ status: "sent" }), [e2]) && same(await ids({ status: "cancelled" }), [e5]) && same(await ids({ status: "draft" }), [e4, e3, e1]));
  ok("a status that isn't one lists nothing", same(await lib.listEstimates(L2, { status: "open" }), { estimates: [], total: 0 }));
  ok("filters combine", same(await ids({ orgId: "acme", customerId: lp, status: "draft" }), [e1]));
  ok("search by number", same(await ids({ q: "q-00003" }), [e3]));
  ok("search by title, any case", same(await ids({ q: "SPRING" }), [e1]));
  ok("search by customer name", same(await ids({ q: "lee exempt" }), [e4]));
  ok("search by company", same(await ids({ q: "sample works" }), [e2]));
  ok("search by email", same(await ids({ q: "pat@example" }), [e5, e3, e1]));
  ok("what is typed is plain text, not a pattern: % matches only a %", same(await ids({ q: "100%" }), [e2]) && same(await ids({ q: "%" }), [e2]) && same(await ids({ q: "_" }), []));
  ok("the search is trimmed; blank is no search", same(await ids({ q: "  Hoodies  " }), [e3]) && (await lib.listEstimates(L2, { q: "   " })).total === 5);
  ok("the count follows the search", (await lib.listEstimates(L2, { q: "pat@example", limit: 1 })).total === 3);
  ok("paging: limit and offset", same(await ids({ limit: 2 }), [e5, e4]) && same(await ids({ limit: 2, offset: 2 }), [e3, e2]) && same(await ids({ limit: 2, offset: 4 }), [e1]) &&
    (await lib.listEstimates(L2, { limit: 2, offset: 4 })).total === 5);
  ok("an offset past the end lists nothing, with the count of all", same(await ids({ offset: 10 }), []) && (await lib.listEstimates(L2, { offset: 10 })).total === 5);
  ok("a limit below 1 is 1, a negative offset is 0", (await ids({ limit: -3 })).length === 1 && same(await ids({ limit: 1, offset: -4 }), [e5]));
  ok("a limit that isn't a number is 50", (await ids({ limit: "lots" })).length === 5);
  for (let i = 0; i < 205; i++) L2.q("INSERT INTO estimates (number, orgId, customerId, createdAt, updatedAt) VALUES (?, 'beta', ?, 't', '2000')", "X-" + i, ls);
  ok("at most 200 a page", (await ids({ limit: 1000 })).length === 200 && (await lib.listEstimates(L2, { limit: 1000 })).total === 210);
  ok("by default 50 a page", (await ids({})).length === 50);
  L2.q("DELETE FROM estimates WHERE number LIKE 'X-%'");
  const ld = await lib.listEstimates(L2, { orgId: "acme", status: "sent", limit: 50 });
  ok("a page's quotes have only their own lines in their totals", ld.estimates.length === 1 && ld.estimates[0].total === 55);

  // =====================================================================================================
  console.log("\n=== A database without migrations/0109 ===");
  const old = await makeDb("0109");
  old.q("INSERT INTO customers (name, createdAt, updatedAt) VALUES ('Pat Example', 't', 't')");
  ok("(it really has no quotes tables)", old.q("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('estimates', 'estimate_items')")[0].n === 0);
  ok("getEstimate is null", await lib.getEstimate(old, 1) === null);
  ok("getEstimateByToken is null", await lib.getEstimateByToken(old, TOKEN_A) === null);
  ok("listEstimates is empty, with any filter", same(await lib.listEstimates(old), { estimates: [], total: 0 }) &&
    same(await lib.listEstimates(old, { orgId: "acme", q: "pat", status: "draft", customerId: 1 }), { estimates: [], total: 0 }));
  ok("markEstimateViewed does nothing and doesn't throw", await thrown(() => lib.markEstimateViewed(old, TOKEN_A)) === "");
  ok("an answer through a link is told the link isn't valid", (await lib.respondToEstimate(old, TOKEN_A, { accept: true })).error === BAD_LINK);
  ok("making a quote says the database needs updating", (await lib.createEstimate(old, { orgId: "acme", customerId: 1 })).error === NOT_READY);
  ok("changing, saving lines, sending, converting and cancelling find no quote",
    (await lib.setEstimateFields(old, 1, { title: "x" })).error === NOT_FOUND && (await lib.saveEstimateItems(old, 1, [])).error === NOT_FOUND &&
    (await lib.markEstimateSent(old, 1, {})).error === NOT_FOUND && (await lib.setEstimateConverted(old, 1, "A-1")).error === NOT_FOUND &&
    (await lib.cancelEstimate(old, 1)).error === NOT_FOUND);
  const older = await makeDb("0108");
  ok("on a database without customers either, making a quote says the database needs updating", (await lib.createEstimate(older, { orgId: "acme", customerId: 1 })).error === NOT_READY);
  ok("…and the list is empty", same(await lib.listEstimates(older), { estimates: [], total: 0 }));
  const otherError = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1_ERROR: network lost"); }, all: async () => { throw new Error("D1_ERROR: network lost"); },
    run: async () => { throw new Error("D1_ERROR: network lost"); } }), first: async () => { throw new Error("D1_ERROR: network lost"); } }) };
  ok("any other database failure is not taken for a missing table: it is thrown",
    /network lost/.test(await thrown(() => lib.getEstimate(otherError, 1))) && /network lost/.test(await thrown(() => lib.getEstimateByToken(otherError, TOKEN_A))) &&
    /network lost/.test(await thrown(() => lib.markEstimateViewed(otherError, TOKEN_A))) && /network lost/.test(await thrown(() => lib.respondToEstimate(otherError, TOKEN_A, {}))) &&
    /network lost/.test(await thrown(() => lib.cancelEstimate(otherError, 1))));
})().catch((e) => { console.log("the quotes data test ran to the end: false"); console.error(e); process.exitCode = 1; });
