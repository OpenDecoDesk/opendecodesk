const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { makeAuth } = require("./testlib/auth-harness");
const roles = require("./testlib/roles");

// Merging two customer records (migrations/0105, 2026-11): db.js mergeCustomers and the mergeCustomers action.
//   - every order of the duplicate moves to the customer that is kept (test and voided orders too), in one batch
//   - the duplicate is retired: marked as merged into the kept one and archived; its own fields stay for the record
//   - what the kept customer has blank (email, phone, company, address, notes) is filled from the duplicate, and
//     nothing it already has is overwritten; a tax exemption is never carried over
//   - customers merged into the duplicate earlier are re-pointed at the one that is left
//   - the retired email sends new orders to the kept customer, and is free for another customer to use
//   - the action is Full's (customers.records), is written to the audit log BEFORE anything changes and is refused
//     with nothing changed when that row can't be written
// Real SQL (sql.js), the real db.js, and the real orders endpoint behind the real sign-in gate. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { mergeCustomers, insertOrder, getCustomer, listCustomers, saveCustomer, findOrCreateCustomerForOrder_ };")();
const tick = () => new Promise(r => setTimeout(r, 10));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const A = await makeAuth();          // a new install on schema.sql
  const d1 = A.d1;
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);

  // A customers row exactly as given (so a check knows what was there before), and an order of a customer.
  const T0 = "2026-01-05T10:00:00.000Z";
  const cust = (f = {}) => {
    d1._raw.run(`INSERT INTO customers (name, company, email, phone, addressJson, notes, taxExempt, taxExemptCertificate, taxExemptExpires, createdAt, updatedAt, archivedAt, mergedIntoId)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [f.name || "", f.company || "", f.email || "", f.phone || "", f.address ? JSON.stringify(f.address) : "", f.notes || "",
      f.taxExempt ? 1 : 0, f.taxExemptCertificate || "", f.taxExemptExpires || null, T0, T0, f.archivedAt || null, f.mergedIntoId || null]);
    return d1.q("SELECT max(id) AS m FROM customers")[0].m;
  };
  let seq = 0;
  const ITEMS = [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }];
  const order = async (customerId, { isTest = false, voided = false } = {}) => {
    const id = "M" + String(++seq).padStart(3, "0");
    await lib.insertOrder(d1, { orderId: id, orgId: "acme", customerName: "Pat Example", contact: "555-0100", placedAt: "2026-03-02T15:00:00.000Z" }, ITEMS);
    d1._raw.run("UPDATE orders SET customerId = ?, isTest = ?, voidedAt = ? WHERE orderId = ?", [customerId, isTest ? 1 : 0, voided ? "2026-03-03T15:00:00.000Z" : null, id]);
    return id;
  };
  const placed = async (orderId, contact, extra = {}) => {
    await lib.insertOrder(d1, Object.assign({ orderId, orgId: "acme", customerName: "Pat Example", contact, placedAt: "2026-04-02T15:00:00.000Z" }, extra), ITEMS);
    return d1.q("SELECT customerId FROM orders WHERE orderId = ?", orderId)[0].customerId;
  };
  const row = (id) => d1.q("SELECT * FROM customers WHERE id = ?", id)[0];
  const ordersOf = (id) => d1.q("SELECT orderId FROM orders WHERE customerId = ? ORDER BY orderId", id).map(r => r.orderId);
  const snapshot = () => JSON.stringify([d1.q("SELECT * FROM customers ORDER BY id"), d1.q("SELECT orderId, customerId FROM orders ORDER BY orderId")]);

  console.log("=== db.js mergeCustomers: the orders move and the duplicate is retired ===");
  const ADDRESS = { name: "Pat Example", line1: "1 Example Street", city: "Exampleville", state: "EX", zip: "00000", country: "US" };
  let from = cust({ name: "Pat Example", email: "pat@example.com", phone: "555-0100", company: "Example Club", address: ADDRESS, notes: "Prefers navy thread" });
  let into = cust({ name: "Patricia Example" });
  const other = cust({ name: "Sam Sample", email: "sam@example.com" });
  const o1 = await order(from), o2 = await order(from, { isTest: true }), o3 = await order(from, { voided: true });
  const oKept = await order(into), oOther = await order(other), oNone = await order(null);
  let r = await lib.mergeCustomers(d1, { fromId: from, intoId: into });
  ok("merging a customer with three orders answers that three orders moved", same(r, { moved: 3 }));
  ok("every order of the duplicate now belongs to the kept customer, beside the order it already had", same(ordersOf(into), [o1, o2, o3, oKept].sort()));
  ok("…its test order and its voided order moved too", ordersOf(into).includes(o2) && ordersOf(into).includes(o3));
  ok("the duplicate has no orders left", ordersOf(from).length === 0);
  ok("another customer's order and an order with no customer are left alone", same(ordersOf(other), [oOther]) && d1.q("SELECT customerId FROM orders WHERE orderId = ?", oNone)[0].customerId === null);
  ok("the duplicate is marked as merged into the kept customer", row(from).mergedIntoId === into);
  ok("…and archived, with the time it happened", /^\d{4}-\d{2}-\d{2}T/.test(row(from).archivedAt || "") && row(from).updatedAt !== T0 && row(from).archivedAt === row(from).updatedAt);
  ok("the duplicate keeps its own name, email, phone, company, address and notes for the record", row(from).name === "Pat Example" && row(from).email === "pat@example.com" &&
    row(from).phone === "555-0100" && row(from).company === "Example Club" && same(JSON.parse(row(from).addressJson), ADDRESS) && row(from).notes === "Prefers navy thread");
  ok("the kept customer is still live and not archived", row(into).mergedIntoId === null && row(into).archivedAt === null);
  ok("the kept customer's name is its own, never the duplicate's", row(into).name === "Patricia Example");

  console.log("\n=== What the kept customer has blank is filled from the duplicate ===");
  ok("a blank email is filled", row(into).email === "pat@example.com");
  ok("a blank phone is filled", row(into).phone === "555-0100");
  ok("a blank company is filled", row(into).company === "Example Club");
  ok("a blank address is filled", same(JSON.parse(row(into).addressJson || "null"), ADDRESS));
  ok("blank notes are filled", row(into).notes === "Prefers navy thread");
  ok("the kept customer's last-changed time moves on", row(into).updatedAt !== T0);
  ok("the other customer isn't touched", same(row(other), Object.assign({}, row(other), { name: "Sam Sample", email: "sam@example.com", updatedAt: T0, mergedIntoId: null, archivedAt: null })));
  let got = await lib.getCustomer(d1, from);
  ok("opening the retired customer answers with the kept one and all four orders", got.customer.id === into && got.orders.length === 4);
  got = await lib.listCustomers(d1, { includeArchived: true });
  ok("the retired customer is no longer on the list, archived ones included", !got.customers.some(c => c.id === from) && got.customers.some(c => c.id === into));

  console.log("\n=== Nothing the kept customer already has is overwritten ===");
  const ADDRESS2 = { line1: "2 Sample Road", city: "Sampleton" };
  from = cust({ name: "Lee Example", email: "lee@example.com", phone: "555-0101", company: "Example Guild", address: ADDRESS, notes: "From the duplicate" });
  into = cust({ name: "Lee E.", email: "lee.e@example.com", phone: "555-0102", company: "Example Society", address: ADDRESS2, notes: "Its own notes" });
  r = await lib.mergeCustomers(d1, { fromId: from, intoId: into });
  ok("a customer with no orders merges, and no orders moved", same(r, { moved: 0 }) && row(from).mergedIntoId === into);
  ok("the kept customer's own email stays", row(into).email === "lee.e@example.com");
  ok("its own phone stays", row(into).phone === "555-0102");
  ok("its own company stays", row(into).company === "Example Society");
  ok("its own address stays", same(JSON.parse(row(into).addressJson), ADDRESS2));
  ok("its own notes stay", row(into).notes === "Its own notes");
  // Field by field: only the blank one is filled.
  const BOTH = { email: ["dup@example.com", "kept@example.com"], phone: ["555-0121", "555-0122"], company: ["Example From", "Example Into"],
    addressJson: [JSON.stringify({ line1: "3 From Lane" }), JSON.stringify({ line1: "4 Into Lane" })], notes: ["From note", "Into note"] };
  for (const [field, col] of [["email", "email"], ["phone", "phone"], ["company", "company"], ["address", "addressJson"], ["notes", "notes"]]) {
    const all = Object.fromEntries(Object.entries(BOTH).map(([k, v]) => [k, k === "email" ? v.map(e => field + "-" + e) : v.slice()]));
    all[col][1] = "";
    const mk = (i, name) => { const id = cust({ name }); d1._raw.run("UPDATE customers SET email = ?, phone = ?, company = ?, addressJson = ?, notes = ? WHERE id = ?", [all.email[i], all.phone[i], all.company[i], all.addressJson[i], all.notes[i], id]); return id; };
    const f = mk(0, "Dup " + field), t = mk(1, "Kept " + field);
    await lib.mergeCustomers(d1, { fromId: f, intoId: t });
    const after = row(t);
    ok(`with only the ${field} blank on the kept customer, the ${field} is filled and the other four fields are left as they were`, after[col] === all[col][0] && after[col] !== "" &&
      Object.keys(all).filter(k => k !== col).every(k => after[k] === all[k][1]));
  }
  from = cust({ name: "Blank One" }); into = cust({ name: "Blank Two" });
  await lib.mergeCustomers(d1, { fromId: from, intoId: into });
  ok("when both have a field blank it stays blank", row(into).email === "" && row(into).phone === "" && row(into).company === "" && row(into).addressJson === "" && row(into).notes === "");

  console.log("\n=== A tax exemption is never carried over ===");
  from = cust({ name: "Exempt Example", email: "exempt@example.com", taxExempt: true, taxExemptCertificate: "CERT-EXAMPLE-1", taxExemptExpires: "2031-12-31" });
  into = cust({ name: "Taxed Example" });
  await lib.mergeCustomers(d1, { fromId: from, intoId: into });
  ok("merging an exempt duplicate into a customer who isn't exempt leaves that customer not exempt", row(into).taxExempt === 0);
  ok("…with no certificate and no expiry date", row(into).taxExemptCertificate === "" && row(into).taxExemptExpires === null);
  ok("…though the email was filled from it", row(into).email === "exempt@example.com");
  ok("the retired record keeps its exemption for the record", row(from).taxExempt === 1 && row(from).taxExemptCertificate === "CERT-EXAMPLE-1" && row(from).taxExemptExpires === "2031-12-31");
  from = cust({ name: "Plain Example" });
  into = cust({ name: "Kept Exempt", taxExempt: true, taxExemptCertificate: "CERT-EXAMPLE-2", taxExemptExpires: "2032-06-30" });
  await lib.mergeCustomers(d1, { fromId: from, intoId: into });
  ok("the kept customer's own exemption is not cleared by a merge", row(into).taxExempt === 1 && row(into).taxExemptCertificate === "CERT-EXAMPLE-2" && row(into).taxExemptExpires === "2032-06-30");

  console.log("\n=== Archived customers ===");
  from = cust({ name: "Old Dup", archivedAt: "2026-02-01T00:00:00.000Z" });
  into = cust({ name: "Old Kept", archivedAt: "2026-02-02T00:00:00.000Z" });
  r = await lib.mergeCustomers(d1, { fromId: from, intoId: into });
  ok("a duplicate that was already archived keeps the date it was archived on", !r.error && row(from).mergedIntoId === into && row(from).archivedAt === "2026-02-01T00:00:00.000Z");
  ok("an archived customer can be merged into, and stays archived as it was", row(into).archivedAt === "2026-02-02T00:00:00.000Z" && row(into).mergedIntoId === null);

  console.log("\n=== Customers merged into the duplicate earlier are re-pointed ===");
  const first = cust({ name: "First Dup", email: "first@example.com" });
  const second = cust({ name: "Second Dup", email: "second@example.com" });
  const last = cust({ name: "Kept In The End", email: "kept@example.com" });
  const oFirst = await order(first);
  await lib.mergeCustomers(d1, { fromId: first, intoId: second });
  r = await lib.mergeCustomers(d1, { fromId: second, intoId: last });
  ok("the second merge moves the order that came with the first", r.moved === 1 && same(ordersOf(last), [oFirst]));
  ok("the customer merged earlier now points at the one that is left, not at the retired one", row(first).mergedIntoId === last && row(second).mergedIntoId === last);
  ok("opening the first duplicate answers with the customer that is left", (await lib.getCustomer(d1, first)).customer.id === last);
  ok("a new order with the first duplicate's email goes to the customer that is left", (await placed("R001", "first@example.com")) === last);
  ok("a customer merged elsewhere is not re-pointed by someone else's merge", row(d1.q("SELECT id FROM customers WHERE name = 'Exempt Example'")[0].id).mergedIntoId !== last);

  console.log("\n=== The retired email ===");
  from = cust({ name: "Robin Example", email: "robin@example.com" });
  into = cust({ name: "Robin E.", email: "robin.e@example.com" });
  await lib.mergeCustomers(d1, { fromId: from, intoId: into });
  let before = d1.q("SELECT count(*) AS n FROM customers")[0].n;
  ok("a new order placed with the retired email goes to the kept customer", (await placed("R002", "robin@example.com")) === into);
  ok("…however the email is typed", (await placed("R003", "  Robin@Example.com ")) === into);
  ok("…and a test order with it does too", (await placed("R004", "robin@example.com", { isTest: true })) === into);
  ok("…without bringing the duplicate back or making a new customer", d1.q("SELECT count(*) AS n FROM customers")[0].n === before && row(from).mergedIntoId === into);
  ok("an order with the kept customer's own email still goes to it", (await placed("R005", "robin.e@example.com")) === into);
  ok("the lookup itself answers the kept customer for the retired email", (await lib.findOrCreateCustomerForOrder_(d1, { name: "Robin", contact: "robin@example.com" })) === into);
  r = await lib.saveCustomer(d1, { name: "Robin Newcomer", email: "robin@example.com" });
  ok("the retired email no longer collides: a new customer can be saved with it", !r.error && r.created === true && row(r.id).email === "robin@example.com");
  r = await lib.saveCustomer(d1, { id: other, email: "exempt@example.com" });
  ok("an email the kept customer took from the duplicate is that customer's now: another customer can't have it", r.error === "Another customer already has that email.");
  from = cust({ name: "Twin One", email: "twin@example.com" }); into = cust({ name: "Twin Two" });
  r = await lib.mergeCustomers(d1, { fromId: from, intoId: into });
  ok("the kept customer can take the duplicate's email though both rows then carry it (only live customers must differ)", !r.error && row(into).email === "twin@example.com" && row(from).email === "twin@example.com");

  console.log("\n=== All of it in one batch ===");
  from = cust({ name: "Batch Dup", email: "batch@example.com", notes: "A note" }); into = cust({ name: "Batch Kept" });
  const oBatch = await order(from);
  const calls = { batches: 0, inBatch: 0, writes: 0 };
  const counting = (st) => ({ _sql: st._sql, _params: st._params, first: (...a) => st.first(...a), all: (...a) => st.all(...a), run: (...a) => { calls.writes++; return st.run(...a); } });
  const countedDb = { prepare: (sql) => { const p = d1.prepare(sql); return Object.assign(counting(p), { bind: (...v) => counting(p.bind(...v)) }); },
    batch: (stmts) => { calls.batches++; calls.inBatch += stmts.length; return d1.batch(stmts); } };
  d1._raw.run(`CREATE TRIGGER t277_refuse BEFORE UPDATE OF notes ON customers WHEN NEW.id = ${into} BEGIN SELECT RAISE(ABORT, 'test277 refuses this write'); END;`);
  let wasBefore = snapshot(), threw = "";
  try { await lib.mergeCustomers(d1, { fromId: from, intoId: into }); } catch (e) { threw = String(e && e.message); }
  ok("when the last write of a merge fails, the merge fails", /test277 refuses this write/.test(threw));
  ok("…and nothing of it is kept: the order hasn't moved and the duplicate isn't retired", snapshot() === wasBefore && same(ordersOf(from), [oBatch]) && row(from).mergedIntoId === null);
  d1._raw.run("DROP TRIGGER t277_refuse");
  r = await lib.mergeCustomers(countedDb, { fromId: from, intoId: into });
  ok("a merge is one batch of four statements and no write outside it", r.moved === 1 && calls.batches === 1 && calls.inBatch === 4 && calls.writes === 0);

  console.log("\n=== db.js mergeCustomers: what it refuses, with nothing changed ===");
  const a = cust({ name: "Refusal A", email: "ra@example.com" }), b = cust({ name: "Refusal B" });
  const gone = cust({ name: "Refusal Gone" }); await lib.mergeCustomers(d1, { fromId: gone, intoId: b });
  d1._raw.run("UPDATE customers SET email = '', phone = '', company = '', addressJson = '', notes = '', updatedAt = ? WHERE id = ?", [T0, b]);
  const oA = await order(a);
  wasBefore = snapshot();
  const NOT_FOUND = "That customer wasn't found.";
  ok("a customer can't be merged into itself", (await lib.mergeCustomers(d1, { fromId: a, intoId: a })).error === "A customer can't be merged into itself.");
  ok("…the same id sent as text and as a number is still the same customer", (await lib.mergeCustomers(d1, { fromId: String(a), intoId: a })).error === "A customer can't be merged into itself.");
  ok("a duplicate that doesn't exist isn't found", (await lib.mergeCustomers(d1, { fromId: 999999, intoId: a })).error === NOT_FOUND);
  ok("a customer to keep that doesn't exist isn't found", (await lib.mergeCustomers(d1, { fromId: a, intoId: 999999 })).error === NOT_FOUND);
  let bad = [];
  for (const v of [undefined, null, "", 0, -1, 1.5, "abc"]) {
    if ((await lib.mergeCustomers(d1, { fromId: v, intoId: a })).error !== NOT_FOUND) bad.push("from " + JSON.stringify(v));
    if ((await lib.mergeCustomers(d1, { fromId: a, intoId: v })).error !== NOT_FOUND) bad.push("into " + JSON.stringify(v));
  }
  if (bad.length) console.log("   not refused as not found — " + bad.join(", "));
  ok("an id that isn't a whole number above zero — nothing, empty, 0, -1, 1.5, a word — isn't found, on either side", bad.length === 0);
  ok("called with nothing at all it answers that the customer wasn't found", (await lib.mergeCustomers(d1)).error === NOT_FOUND && (await lib.mergeCustomers(d1, {})).error === NOT_FOUND);
  ok("a duplicate that was already merged can't be merged again", (await lib.mergeCustomers(d1, { fromId: gone, intoId: a })).error === "That customer has already been merged into another.");
  ok("a customer can't be merged into one that was itself merged away, and the sentence says to pick the other",
    (await lib.mergeCustomers(d1, { fromId: a, intoId: gone })).error === "The customer to keep has itself been merged into another. Pick that one instead.");
  ok("none of those refusals changed a customer or an order", snapshot() === wasBefore && same(ordersOf(a), [oA]));
  const pre = await createD1();
  pre._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f < "0105").sort()) pre.execFile(read("migrations/" + f));
  threw = "";
  try { await lib.mergeCustomers(pre, { fromId: 1, intoId: 2 }); } catch (e) { threw = String(e && e.message); }
  ok("on a database that hasn't had migrations/0105 it throws the database's own \"no such table\" (the action turns that into a plain answer)", /no such table: customers/.test(threw));

  // ---------------------------------------------------------------------------------------------------------
  console.log("\n=== The mergeCustomers action ===");
  const admin = await A.firstAdmin("Olive Owner", "owner@example.com");
  const manager = await A.addUser(admin, "manager", "Mo Manager", "manager@example.com");
  const staff = await A.addUser(admin, "staff", "Sam Staff", "staff@example.com");
  const prod = await A.addUser(admin, "production", "Pat Production", "production@example.com");
  // The endpoint's database, tapped: every statement in the order it ran, and two things a test can make happen —
  // the audit log refusing a write, and something changing right after the "customer.merged" row is written.
  const tap = { log: [], failAudit: false, afterMergedRow: null };
  const tapped = (st) => {
    const isAudit = /INSERT INTO audit_log/.test(st._sql);
    const note = () => tap.log.push({ sql: st._sql, params: st._params });
    return { _sql: st._sql, _params: st._params,
      first: (...x) => { note(); return st.first(...x); }, all: (...x) => { note(); return st.all(...x); },
      run: async (...x) => {
        note();
        if (isAudit && tap.failAudit) throw new Error("D1_ERROR: the audit log can't be written (test277)");
        const res = await st.run(...x);
        if (isAudit && tap.afterMergedRow && st._params.includes("customer.merged")) { const f = tap.afterMergedRow; tap.afterMergedRow = null; f(); }
        return res;
      } };
  };
  A.env.DB = { prepare: (sql) => { const p = d1.prepare(sql); return Object.assign(tapped(p), { bind: (...v) => tapped(p.bind(...v)) }); },
    batch: (stmts) => { stmts.forEach(s => tap.log.push({ sql: "BATCH " + s._sql, params: s._params })); return d1.batch(stmts); } };
  const call = async (body, cookie = admin) => { tap.log = []; const res = await A.orders(Object.assign({ action: "mergeCustomers" }, body), cookie); await tick(); return res; };
  const audits = (action) => A.audit(action).map(x => Object.assign({}, x, { detail: JSON.parse(x.detail || "null") }));
  const auditCount = () => d1.q("SELECT count(*) AS n FROM audit_log WHERE action LIKE 'customer.%'")[0].n;

  from = cust({ name: "Jo Example", company: "Example Club", email: "jo@example.com", phone: "555-0130", address: ADDRESS, notes: "Calls on Mondays",
    taxExempt: true, taxExemptCertificate: "CERT-EXAMPLE-3", taxExemptExpires: "2030-01-31" });
  into = cust({ name: "Joanna Example", company: "Example Guild", email: "joanna@example.com" });
  const j1 = await order(from), j2 = await order(from, { isTest: true }), j3 = await order(from, { voided: true });
  r = await call({ fromId: from, intoId: into });
  ok("an admin merging two customers is answered ok with how many orders moved", r.status === 200 && same(r.body, { status: "ok", moved: 3 }));
  ok("the orders moved, the test and voided ones too, and the duplicate is retired", same(ordersOf(into), [j1, j2, j3]) && row(from).mergedIntoId === into && !!row(from).archivedAt);
  ok("the kept customer's blank phone, address and notes were filled; its email and company were kept", row(into).phone === "555-0130" && same(JSON.parse(row(into).addressJson), ADDRESS) &&
    row(into).notes === "Calls on Mondays" && row(into).email === "joanna@example.com" && row(into).company === "Example Guild");
  ok("the exemption did not come with it", row(into).taxExempt === 0 && row(into).taxExemptCertificate === "" && row(into).taxExemptExpires === null);
  let log = audits("customer.merged");
  ok("the merge is in the audit log once, as customer.merged, with no shop and no order", log.length === 1 && log[0].orgId === null && log[0].orderId === null);
  const d = log.length ? log[0].detail : {};
  ok("…naming both customers by id and how many orders the duplicate had", d.fromId === from && d.intoId === into && d.orders === 3);
  ok("…with the record being retired in full, its exemption included", same(d.from, { name: "Jo Example", company: "Example Club", email: "jo@example.com", phone: "555-0130", address: ADDRESS,
    notes: "Calls on Mondays", taxExempt: true, taxExemptCertificate: "CERT-EXAMPLE-3", taxExemptExpires: "2030-01-31" }));
  ok("…and the kept customer's name, company and email as they were before the merge", same(d.into, { name: "Joanna Example", company: "Example Guild", email: "joanna@example.com" }));
  ok("…saying who did it", /owner@example\.com/.test(String(log.length && log[0].actor)));
  const iAudit = tap.log.findIndex(x => /INSERT INTO audit_log/.test(x.sql) && x.params.includes("customer.merged"));
  const iChange = tap.log.findIndex(x => /^BATCH /.test(x.sql) || /^\s*UPDATE (orders|customers)/.test(x.sql));
  ok("the audit row is written BEFORE anything is changed", iAudit >= 0 && iChange > iAudit);
  ok("a merge that went through writes no customer.merge_not_done", audits("customer.merge_not_done").length === 0);
  from = cust({ name: "Text Id Dup" }); into = cust({ name: "Text Id Kept" });
  r = await call({ fromId: String(from), intoId: String(into) });
  ok("ids sent as text are taken, and a merge with no orders answers that none moved", r.status === 200 && r.body.moved === 0 && row(from).mergedIntoId === into && audits("customer.merged").pop().detail.orders === 0);

  console.log("\n=== The action's refusals: the status, the sentence, nothing changed and nothing logged ===");
  const x = cust({ name: "Action A", email: "aa@example.com" }), y = cust({ name: "Action B" });
  const merged = cust({ name: "Action Gone" }); await lib.mergeCustomers(d1, { fromId: merged, intoId: cust({ name: "Action Sink" }) });
  await order(x);
  wasBefore = snapshot(); before = auditCount();
  const PICK = "Pick the customer to merge and the customer to merge them into.";
  bad = [];
  for (const v of [undefined, null, "", 0, -1, 1.5, "abc", true, {}, [x]]) {
    const r1 = await call({ fromId: v, intoId: y }), r2 = await call({ fromId: x, intoId: v });
    if (!(r1.status === 400 && r1.body.status === "error" && r1.body.message === PICK)) bad.push("from " + JSON.stringify(v) + " → " + r1.status);
    if (!(r2.status === 400 && r2.body.status === "error" && r2.body.message === PICK)) bad.push("into " + JSON.stringify(v) + " → " + r2.status);
  }
  if (bad.length) console.log("   not refused that way — " + bad.join(", "));
  ok("either customer left out, or an id that isn't a whole number above zero (empty, 0, -1, 1.5, a word, true, an object, a list) → 400, saying to pick both customers", bad.length === 0);
  ok("neither customer sent → the same 400", (r = await call({})).status === 400 && r.body.message === PICK);
  r = await call({ fromId: x, intoId: x });
  ok("the same customer on both sides → 400 \"A customer can't be merged into themselves.\"", r.status === 400 && r.body.status === "error" && r.body.message === "A customer can't be merged into themselves.");
  r = await call({ fromId: String(x), intoId: x });
  ok("…also when one id is text and the other a number", r.status === 400 && r.body.message === "A customer can't be merged into themselves.");
  r = await call({ fromId: 999999, intoId: 999999 });
  ok("…and that is said before either is looked up", r.status === 400 && r.body.message === "A customer can't be merged into themselves.");
  r = await call({ fromId: 999999, intoId: y });
  ok("a duplicate that doesn't exist → 404 \"Customer not found\"", r.status === 404 && r.body.status === "error" && r.body.message === "Customer not found");
  r = await call({ fromId: x, intoId: 999999 });
  ok("a customer to keep that doesn't exist → 404 \"Customer not found\"", r.status === 404 && r.body.status === "error" && r.body.message === "Customer not found");
  r = await call({ fromId: 999999, intoId: merged });
  ok("a missing customer is said before an already-merged one", r.status === 404 && r.body.message === "Customer not found");
  const ALREADY = "One of these customers was already merged into another one.";
  r = await call({ fromId: merged, intoId: y });
  ok("a duplicate that was already merged → 400 \"One of these customers was already merged into another one.\"", r.status === 400 && r.body.status === "error" && r.body.message === ALREADY);
  r = await call({ fromId: x, intoId: merged });
  ok("a customer to keep that was itself merged away → the same 400", r.status === 400 && r.body.status === "error" && r.body.message === ALREADY);
  ok("none of those refusals changed a customer or an order", snapshot() === wasBefore);
  ok("…or wrote anything about customers to the audit log, so the log never names a merge that didn't happen", auditCount() === before);

  console.log("\n=== Who may merge: Full on Customer records ===");
  ok("the action is Full's on customers.records, and nothing less", same(roles.ACTION_PERM.mergeCustomers, [["customers.records", "full"]]));
  const level = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role])["customers.records"];
  ok("by default a Manager has Full on Customer records, Back office Edit and Production Read", level("manager") === "full" && level("staff") === "edit" && level("production") === "read");
  for (const [label, cookie, may] of [["an Admin", admin, true], ["a Manager", manager, true], ["Back office (Edit)", staff, false], ["Production (Read)", prod, false]]) {
    const f = cust({ name: "Role Dup", notes: "From the duplicate" }), t = cust({ name: "Role Kept" });
    const o = await order(f);
    wasBefore = snapshot(); before = auditCount();
    r = await call({ fromId: f, intoId: t }, cookie);
    if (may) ok(`${label} may merge: the order moves and the merge is logged`, r.status === 200 && r.body.status === "ok" && r.body.moved === 1 && same(ordersOf(t), [o]) && row(f).mergedIntoId === t && auditCount() === before + 1);
    else ok(`${label} is refused (403, "your role can't do this") and nothing changes or is logged`, r.status === 403 && r.body.code === "forbidden" && /role can't do this/.test(r.body.message) && snapshot() === wasBefore && auditCount() === before);
  }
  {
    const f = cust({ name: "Nobody Dup" }), t = cust({ name: "Nobody Kept" });
    wasBefore = snapshot();
    r = await call({ fromId: f, intoId: t }, "");
    ok("someone who isn't signed in is refused (401) and nothing changes", r.status === 401 && snapshot() === wasBefore);
  }

  console.log("\n=== When the audit log can't be written, the merge is refused ===");
  from = cust({ name: "Strict Dup", email: "strict@example.com", notes: "From the duplicate" }); into = cust({ name: "Strict Kept" });
  const oStrict = await order(from);
  wasBefore = snapshot(); before = auditCount();
  const realError = console.error; const errors = []; console.error = (...m) => errors.push(m.map(String).join(" "));
  tap.failAudit = true;
  r = await call({ fromId: from, intoId: into });
  tap.failAudit = false; console.error = realError;
  ok("the answer is 503, saying the audit log couldn't be written so nothing was changed", r.status === 503 && r.body.status === "error" && r.body.message === "Could not write the audit log, so nothing was changed. Try again.");
  ok("nothing was changed: the order is still the duplicate's, which is still live, and the kept customer is as it was", snapshot() === wasBefore && same(ordersOf(from), [oStrict]) && row(from).mergedIntoId === null && row(into).notes === "");
  ok("no statement that changes an order or a customer was even sent", !tap.log.some(e => /^BATCH /.test(e.sql) || /^\s*UPDATE (orders|customers)/.test(e.sql)));
  ok("nothing about the merge is in the audit log, and the failure was reported to the server's own log", auditCount() === before && errors.some(m => /AUDIT WRITE FAILED/.test(m) && /customer\.merged/.test(m)));
  r = await call({ fromId: from, intoId: into });
  ok("the same merge goes through once the audit log can be written again", r.status === 200 && r.body.moved === 1 && same(ordersOf(into), [oStrict]) && auditCount() === before + 1);

  console.log("\n=== customer.merge_not_done: the merge was logged, then couldn't be done ===");
  // Someone else merges the duplicate away between this request's checks and its change.
  from = cust({ name: "Race Dup", notes: "From the duplicate" }); into = cust({ name: "Race Kept" });
  const elsewhere = cust({ name: "Race Elsewhere" });
  const oRace = await order(from);
  before = audits("customer.merged").length;
  tap.afterMergedRow = () => d1._raw.run("UPDATE customers SET mergedIntoId = ? WHERE id = ?", [elsewhere, from]);
  r = await call({ fromId: from, intoId: into });
  ok("the answer is 400 with db.js's own sentence", r.status === 400 && r.body.status === "error" && r.body.message === "That customer has already been merged into another.");
  ok("this request moved no order and filled nothing on the customer it was to keep", same(ordersOf(from), [oRace]) && ordersOf(into).length === 0 && row(into).notes === "" && row(from).mergedIntoId === elsewhere);
  log = audits("customer.merge_not_done");
  ok("the customer.merged row it wrote first is followed by one customer.merge_not_done", audits("customer.merged").length === before + 1 && log.length === 1 &&
    log[0].id > audits("customer.merged").pop().id);
  ok("…naming both customers and the reason, with no shop and no order", log.length === 1 && same(log[0].detail, { fromId: from, intoId: into, reason: "That customer has already been merged into another." }) &&
    log[0].orgId === null && log[0].orderId === null && /owner@example\.com/.test(String(log[0].actor)));

  console.log("\n=== A database that hasn't had migrations/0105 yet ===");
  const B = await makeAuth({ d1: pre });
  const admin2 = await B.firstAdmin("Olive Owner", "owner@example.com");
  r = await B.orders({ action: "mergeCustomers", fromId: 1, intoId: 2 }, admin2);
  ok("the action answers 503 with a plain sentence, not a database error", r.status === 503 && r.body.status === "error" &&
    r.body.message === "Customers aren't ready yet: the database is still being updated. Try again in a minute.");
  ok("…and writes nothing to the audit log", B.audit("customer.merged").length === 0 && B.audit("customer.merge_not_done").length === 0);
})().catch((e) => { console.error(e); process.exitCode = 1; });
