const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Outside digitizing (migrations/0118, table digitizing_jobs): a design sent to a digitizing vendor, its dates and cost,
// optionally booked as an expense tied to the order.
//   - functions/_lib/db.js: listDigitizingJobs, saveDigitizingJob (every validation and its sentence, insert vs update,
//     the vendor must be on the vendor list, recordExpense writing the expense in the same batch — category "Digitizing"
//     made once, orderId, description, date = returned else sent, account — and never twice), deleteDigitizingJob (soft;
//     refused while its expense is live, allowed once that is deleted); a vendor rename renames the jobs; a database
//     from before 0118
//   - functions/_lib/permissions.js and functions/api/orders.js: the three actions by built-in role (read / edit / full),
//     recordExpense needing Expenses (edit) and Bookkeeping, the closed-month guard on the expense's month, the cost
//     hidden without costs.view, 400 without orderId / estimateId, 409 "Delete its expense first", the audit rows
//   - public/admin-digitizing.js in the real admin page (jsdom): the section, the Send to digitizer window, change,
//     delete, errors shown; the order window's Digitizing… button (ensureDigitizingUi_ loads the script when first
//     needed) and a saved quote's own section
// Real SQL (sql.js) under the real db.js and orders.js. Invented people and shops only. Dates are fixed days (or the page's
// own "today"), so nothing depends on the day it runs or this machine's time zone.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { listDigitizingJobs, saveDigitizingJob, deleteDigitizingJob, saveVendor, listVendors, listExpenses, deleteExpense, saveExpenseCategory, insertOrder, localToday, createProduct };")();
const { makeAuth, prelude, request, answer } = require("./testlib/auth-harness");
const ordersJs = read("functions/api/orders.js");
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

(async () => {
  // ============================ The database layer (db.js) on schema.sql ============================
  console.log("=== Before migrations/0118: no table, nothing breaks ===");
  {
    const old = await createD1();
    old._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f.slice(0, 4) <= "0117").sort()) old.execFile(read("migrations/" + f));
    ok("the digitizing_jobs table isn't there yet", old.q("SELECT name FROM sqlite_master WHERE name = 'digitizing_jobs'").length === 0);
    ok("listing answers an empty list, not an error", same(await lib.listDigitizingJobs(old, { orderId: "O-1" }), []));
    const e = await rejects(lib.saveDigitizingJob(old, { name: "Left chest logo", sentAt: "2026-03-02", orderId: "O-1" }));
    ok("saving is refused by the database (the migration must be applied first)", !!e && /no such table/i.test(e.message));
  }

  const d1 = await createD1();
  d1._raw.exec(read("schema.sql"));
  const d1q = (sql, ...p) => d1.q(sql, ...p);
  const jobRows = () => d1q("SELECT * FROM digitizing_jobs ORDER BY id");
  const expRows = () => d1q("SELECT * FROM expenses ORDER BY id");
  const rej = async (job, opts) => { const e = await rejects(lib.saveDigitizingJob(d1, job, opts)); return e ? { message: e.message, userFacing: !!e.userFacing } : null; };
  const VENDORS = ["Example Digitizing Co", "Sample Stitch Works", "Other Supplier"];
  for (const [i, name] of VENDORS.entries()) await lib.saveVendor(d1, { name, forBlanks: i === 2, forDigitizing: i < 2 });
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  const cap = [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }];
  for (const id of ["O-1", "O-2"]) await lib.insertOrder(d1, { orderId: id, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-03-01T12:00:00.000Z" }, cap);
  const base = { orderId: "O-1", name: "Example Club left chest logo", vendor: "Example Digitizing Co", sentAt: "2026-03-02" };

  console.log("\n=== saveDigitizingJob: what is refused, and the sentence ===");
  {
    const cases = [
      ["no name", { name: "" }, "Say what was sent (its name)"],
      ["a name of only spaces", { name: "   " }, "Say what was sent (its name)"],
      ["a name that is missing", { name: undefined }, "Say what was sent (its name)"],
      ["a name over 200 characters", { name: "x".repeat(201) }, "What was sent can be at most 200 characters."],
      ["a vendor name over 120 characters", { vendor: "v".repeat(121) }, "The digitizer's name can be at most 120 characters."],
      ["a vendor that isn't on the list", { vendor: "Nobody Digitizing" }, "“Nobody Digitizing” isn't in the vendor list — add it with Manage… next to the digitizer."],
      ["no sent date", { sentAt: "" }, "Pick the date it was sent."],
      ["a sent date that isn't a day", { sentAt: "soon" }, "Pick the date it was sent."],
      ["a sent date that doesn't exist (February 30)", { sentAt: "2026-02-30" }, "Pick the date it was sent."],
      ["a returned date that doesn't exist", { returnedAt: "2026-04-31" }, "The date it came back isn't a real date."],
      ["a returned date before the sent date", { returnedAt: "2026-03-01" }, "It can't come back before it was sent."],
      ["a negative cost", { costCents: -1 }, "The cost must be a whole number of cents from 0 to 100,000,000."],
      ["a cost with a fraction of a cent", { costCents: 12.5 }, "The cost must be a whole number of cents from 0 to 100,000,000."],
      ["a cost that isn't a number", { costCents: "lots" }, "The cost must be a whole number of cents from 0 to 100,000,000."],
      ["a cost over $1,000,000", { costCents: 100000001 }, "The cost must be a whole number of cents from 0 to 100,000,000."],
      ["an order line id that isn't an id", { itemId: "abc" }, "The order line isn't a valid id."],
      ["an order line id of 0", { itemId: 0.5 }, "The order line isn't a valid id."],
      ["a design id that isn't an id", { designId: -3 }, "The design isn't a valid id."],
      ["a quote id that isn't an id", { estimateId: "q" }, "The quote isn't a valid id."],
      ["a record that doesn't exist (an id nobody has)", { id: 999 }, "That digitizing record no longer exists — reload and try again."],
    ];
    for (const [what, patch, message] of cases) {
      const before = JSON.stringify([jobRows(), expRows()]);
      const r = await rej(Object.assign({}, base, patch));
      ok(what + ": “" + message + "” and nothing written", !!r && r.message === message && r.userFacing === true && JSON.stringify([jobRows(), expRows()]) === before);
    }
    const r = await rej(Object.assign({}, base, { costCents: 5000, recordExpense: true, vendor: "Nobody Digitizing" }));
    ok("a refused save with “record the cost as an expense” writes no expense and no Digitizing category", !!r && expRows().length === 0 && d1q("SELECT * FROM expense_categories WHERE name = 'Digitizing'").length === 0);
    ok("a vendor given in another case or with extra spaces is the list's spelling, and an empty vendor is allowed (not named yet)",
      (await lib.saveDigitizingJob(d1, Object.assign({}, base, { vendor: "  example   DIGITIZING co " }))).vendor === "Example Digitizing Co" &&
      (await lib.saveDigitizingJob(d1, Object.assign({}, base, { vendor: "", name: "Unnamed vendor" }))).vendor === "");
    ok("a vendor that doesn't digitize (marked for blanks only) is still on the list, so it is accepted",
      (await lib.saveDigitizingJob(d1, Object.assign({}, base, { vendor: "Other Supplier", name: "Odd one" }))).vendor === "Other Supplier");
    ok("a missing job (null) is refused as no name, not a crash", (await rej(null)).message === "Say what was sent (its name)");
    d1._raw.run("DELETE FROM digitizing_jobs");
  }

  console.log("\n=== saveDigitizingJob: a new record ===");
  let first;
  {
    first = await lib.saveDigitizingJob(d1, Object.assign({}, base, { returnedAt: "2026-03-05", costCents: 2500, note: "Rush please", itemId: 7, designId: "9", estimateId: "", extra: "ignored" }), { by: "owner@example.test" });
    ok("insert gives the record back, shaped: id, order, line, design, no quote, name, vendor, dates, cost, no expense, note, who",
      same(first, { id: first.id, orderId: "O-1", itemId: 7, designId: 9, estimateId: null, name: "Example Club left chest logo", vendor: "Example Digitizing Co",
        sentAt: "2026-03-02", returnedAt: "2026-03-05", costCents: 2500, expenseId: null, note: "Rush please", createdAt: first.createdAt, createdBy: "owner@example.test" }) &&
      Number.isInteger(first.id) && /^\d{4}-\d\d-\d\dT/.test(first.createdAt));
    ok("…without “record the cost as an expense” no expense is written", expRows().length === 0 && d1q("SELECT * FROM expense_categories WHERE name = 'Digitizing'").length === 0);
    const bare = await lib.saveDigitizingJob(d1, { name: "  Quote logo  ", sentAt: "2026-03-09T10:00:00Z", estimateId: 4, costCents: "", note: "n".repeat(600) });
    ok("a quote's record: the name is trimmed, a date and time is cut to the day, an empty cost is 0, no order, a long note is cut to 500",
      bare.name === "Quote logo" && bare.sentAt === "2026-03-09" && bare.costCents === 0 && bare.orderId === "" && bare.estimateId === 4 && bare.returnedAt === "" && bare.note.length === 500 && bare.createdBy === "");
    const longId = await lib.saveDigitizingJob(d1, { name: "Long order id", sentAt: "2026-03-09", orderId: "  " + "9".repeat(80) + "  " });
    ok("an order id is trimmed and cut to 64 characters", longId.orderId === "9".repeat(64));
    ok("a cost of exactly $1,000,000 is allowed", (await lib.saveDigitizingJob(d1, Object.assign({}, base, { name: "Big", costCents: 100000000 }))).costCents === 100000000);
    ok("a record may come back the day it was sent", (await lib.saveDigitizingJob(d1, Object.assign({}, base, { name: "Same day", returnedAt: "2026-03-02" }))).returnedAt === "2026-03-02");
    d1._raw.run("DELETE FROM digitizing_jobs WHERE id <> ?", [first.id]);
  }

  console.log("\n=== listDigitizingJobs ===");
  {
    const a = await lib.saveDigitizingJob(d1, { orderId: "O-1", name: "Second, sent later", sentAt: "2026-03-20" });
    const b = await lib.saveDigitizingJob(d1, { orderId: "O-1", name: "Third, same day as the second", sentAt: "2026-03-20" });
    const other = await lib.saveDigitizingJob(d1, { orderId: "O-2", name: "Other order", sentAt: "2026-03-01" });
    const quote = await lib.saveDigitizingJob(d1, { estimateId: 4, name: "For a quote", sentAt: "2026-03-01" });
    const ids = async (f) => (await lib.listDigitizingJobs(d1, f)).map(j => j.id);
    ok("an order's list: newest sent first, ties newest record first", same(await ids({ orderId: "O-1" }), [b.id, a.id, first.id]));
    ok("another order has only its own", same(await ids({ orderId: "O-2" }), [other.id]));
    ok("a quote's list is by estimateId", same(await ids({ estimateId: 4 }), [quote.id]) && same(await ids({ estimateId: "4" }), [quote.id]));
    ok("an order nobody sent anything for has none", same(await ids({ orderId: "O-404" }), []));
    ok("with no filter, every record", (await ids({})).length === 5 && (await ids()).length === 5);
    ok("an empty-string filter is no filter", (await ids({ orderId: "", estimateId: "" })).length === 5);
    d1._raw.run("UPDATE digitizing_jobs SET deletedAt = 'x' WHERE id = ?", [a.id]);
    ok("a deleted record is left out", same(await ids({ orderId: "O-1" }), [b.id, first.id]));
    d1._raw.run("DELETE FROM digitizing_jobs WHERE id <> ?", [first.id]);
  }

  console.log("\n=== saveDigitizingJob: changing a record ===");
  {
    const upd = await lib.saveDigitizingJob(d1, { id: first.id, orderId: "O-2", itemId: null, designId: 12, estimateId: null, name: "Changed name", vendor: "Sample Stitch Works",
      sentAt: "2026-03-03", returnedAt: "", costCents: 3000, note: "" }, { by: "someone else" });
    ok("an id changes the record in place (same id, one row)", upd.id === first.id && jobRows().length === 1);
    ok("…every field is replaced, a blank return date clears it", same([upd.orderId, upd.itemId, upd.designId, upd.name, upd.vendor, upd.sentAt, upd.returnedAt, upd.costCents, upd.note],
      ["O-2", null, 12, "Changed name", "Sample Stitch Works", "2026-03-03", "", 3000, ""]));
    ok("…and who first made it and when stay", upd.createdBy === "owner@example.test" && upd.createdAt === first.createdAt);
    const gone = await rej({ id: first.id + 1, name: "x", sentAt: "2026-03-03" });
    ok("an id that isn't there is refused, not added: “That digitizing record no longer exists — reload and try again.”", !!gone && /no longer exists/.test(gone.message) && jobRows().length === 1);
    d1._raw.run("UPDATE digitizing_jobs SET deletedAt = 'x' WHERE id = ?", [first.id]);
    const del = await rej({ id: first.id, name: "x", sentAt: "2026-03-03" });
    ok("a deleted record can't be changed either", !!del && /no longer exists/.test(del.message) && jobRows().length === 1);
    d1._raw.run("DELETE FROM digitizing_jobs");
  }

  console.log("\n=== recordExpense: the expense is written in the same batch ===");
  let booked;
  {
    d1._raw.run("DELETE FROM expense_categories WHERE name = 'Digitizing'");
    const none = await lib.saveDigitizingJob(d1, Object.assign({}, base, { costCents: 0, recordExpense: true, name: "Free sample" }));
    ok("a cost of 0 has nothing to book: no expense, no category", none.expenseId === null && expRows().length === 0 && d1q("SELECT * FROM expense_categories WHERE name = 'Digitizing'").length === 0);
    const notTrue = await lib.saveDigitizingJob(d1, Object.assign({}, base, { costCents: 800, recordExpense: "yes", name: "Not a real true" }));
    ok("only a true recordExpense books one (the string “yes” doesn't)", notTrue.expenseId === null && expRows().length === 0);
    booked = await lib.saveDigitizingJob(d1, Object.assign({}, base, { costCents: 4250, recordExpense: true, returnedAt: "2026-03-06", accountId: 1 }));
    const e = expRows()[0];
    ok("a cost with the tick writes one expense and the record keeps its id", expRows().length === 1 && booked.expenseId === Number(e.id));
    ok("…the expense: dated when it came back, “Digitizing: <name>”, the amount in cents, the vendor, the order, no tax split, not paid personally",
      e.expenseDate === "2026-03-06" && e.description === "Digitizing: Example Club left chest logo" && Number(e.amountCents) === 4250 && e.vendor === "Example Digitizing Co" &&
      e.orderId === "O-1" && Number(e.businessUsePct) === 100 && Number(e.paidPersonally) === 0 && Number(e.vendorChargedTax) === 1 && e.deletedAt === null);
    const cat = d1q("SELECT * FROM expense_categories WHERE name = 'Digitizing'");
    ok("…the category “Digitizing” was made (fully deductible, Schedule C line 11) and the expense is in it", cat.length === 1 && cat[0].deductionType === "deductible" && String(cat[0].scheduleCLine) === "11" &&
      Number(cat[0].deductiblePct) === 100 && Number(e.categoryId) === Number(cat[0].id));
    ok("…paid from the account given", Number(e.accountId) === 1 || (d1q("SELECT id FROM accounts WHERE id = 1").length === 0 && e.accountId === 1));
    const noRet = await lib.saveDigitizingJob(d1, Object.assign({}, base, { costCents: 1000, recordExpense: true, name: "Not back yet", sentAt: "2026-03-04" }));
    const e2 = expRows().find(x => Number(x.id) === noRet.expenseId);
    ok("not back yet: the expense is dated when it was sent; the category is used again, not made twice", e2.expenseDate === "2026-03-04" && Number(e2.categoryId) === Number(expRows()[0].categoryId) &&
      d1q("SELECT * FROM expense_categories WHERE name = 'Digitizing'").length === 1 && e2.accountId === null);
    d1._raw.run("UPDATE expense_categories SET name = 'DIGITIZING' WHERE name = 'Digitizing'");
    const third = await lib.saveDigitizingJob(d1, Object.assign({}, base, { costCents: 700, recordExpense: true, name: "Third" }));
    ok("an existing category is found whatever its capitals", d1q("SELECT * FROM expense_categories WHERE name LIKE 'digitizing'").length === 1 && third.expenseId !== null);
    const noOrder = await lib.saveDigitizingJob(d1, { name: "For a quote", sentAt: "2026-03-08", estimateId: 3, costCents: 900, recordExpense: true, vendor: "" });
    const e3 = expRows().find(x => Number(x.id) === noOrder.expenseId);
    ok("a quote's record books an expense tied to no order, with no vendor", e3.orderId === "" && e3.vendor === "" && e3.description === "Digitizing: For a quote");
    const longName = await lib.saveDigitizingJob(d1, Object.assign({}, base, { name: "N".repeat(200), costCents: 100, recordExpense: true }));
    ok("the expense's description holds a 200-character name in full (\"Digitizing: \" + name, cut to 200 before the label)", expRows().find(x => Number(x.id) === longName.expenseId).description === "Digitizing: " + "N".repeat(200));
    d1._raw.run("DELETE FROM digitizing_jobs; DELETE FROM expenses");
  }

  console.log("\n=== recordExpense: never twice, and the batch is all or nothing ===");
  {
    const j = await lib.saveDigitizingJob(d1, Object.assign({}, base, { costCents: 4250, recordExpense: true }));
    const n = expRows().length;
    const again = await lib.saveDigitizingJob(d1, { id: j.id, orderId: "O-1", name: "Renamed", vendor: "Sample Stitch Works", sentAt: "2026-03-02", costCents: 9999, recordExpense: true });
    ok("saving a record that already has its expense, with the tick on again, writes no second expense", expRows().length === n && again.expenseId === j.expenseId);
    ok("…the new cost is the job's own; the booked expense isn't rewritten (change it in Expenses)", again.costCents === 9999 && Number(expRows()[0].amountCents) === 4250 && expRows()[0].vendor === "Example Digitizing Co");
    const plain = await lib.saveDigitizingJob(d1, Object.assign({}, base, { name: "Plain" }));
    const later = await lib.saveDigitizingJob(d1, { id: plain.id, orderId: "O-1", name: "Plain", vendor: "", sentAt: "2026-03-02", costCents: 1500, recordExpense: true });
    ok("a record saved without an expense can book it later, by changing it with the tick on; the link is set", expRows().length === n + 1 && later.expenseId === Number(expRows()[n].id));
    const kept = await lib.saveDigitizingJob(d1, { id: plain.id, orderId: "O-1", name: "Plain", vendor: "", sentAt: "2026-03-02", costCents: 1500 });
    ok("…and a later save without the tick keeps the link", kept.expenseId === later.expenseId);
    // The batch: when the job's write fails, the expense written beside it is rolled back with it.
    const before = [expRows().length, jobRows().length];
    const real = d1.batch.bind(d1);
    let seen = 0;
    d1.batch = async (stmts) => { seen = stmts.length; return real([...stmts.slice(0, -1), d1.prepare("INSERT INTO digitizing_jobs (orderId, sentAt, costCents, createdAt) VALUES ('x', 'x', -5, 'x')")]); };
    const fail = await rejects(lib.saveDigitizingJob(d1, Object.assign({}, base, { name: "Breaks", costCents: 1200, recordExpense: true })));
    d1.batch = real;
    ok("the expense and the job are one batch of two statements", seen === 2);
    ok("when the batch fails (here the job's row breaks its check), the expense isn't left behind", !!fail && same([expRows().length, jobRows().length], before));
    d1._raw.run("DELETE FROM digitizing_jobs; DELETE FROM expenses");
  }

  console.log("\n=== deleteDigitizingJob ===");
  {
    const plain = await lib.saveDigitizingJob(d1, Object.assign({}, base, { name: "No expense", costCents: 500 }));
    const gone = await lib.deleteDigitizingJob(d1, plain.id);
    ok("deleting a record with no expense answers it and sets deletedAt (it stays in the table)", gone.id === plain.id && gone.name === "No expense" &&
      jobRows().length === 1 && /^\d{4}-\d\d-\d\dT/.test(jobRows()[0].deletedAt) && (await lib.listDigitizingJobs(d1, { orderId: "O-1" })).length === 0);
    const e1 = await rejects(lib.deleteDigitizingJob(d1, plain.id));
    ok("deleting it again: “That digitizing record no longer exists.” (userFacing)", !!e1 && e1.message === "That digitizing record no longer exists." && e1.userFacing === true);
    const e2 = await rejects(lib.deleteDigitizingJob(d1, 9999));
    ok("an id nobody has: the same sentence", !!e2 && e2.message === "That digitizing record no longer exists.");
    const e3 = await rejects(lib.deleteDigitizingJob(d1, "nope"));
    ok("an id that isn't a number: the same sentence, nothing deleted", !!e3 && e3.message === "That digitizing record no longer exists.");
    const j = await lib.saveDigitizingJob(d1, Object.assign({}, base, { name: "With expense", costCents: 3300, recordExpense: true }));
    const e4 = await rejects(lib.deleteDigitizingJob(d1, j.id));
    ok("while its expense is live: “Delete its expense first” and the record stays listed", !!e4 && e4.message === "Delete its expense first" && e4.userFacing === true &&
      (await lib.listDigitizingJobs(d1, { orderId: "O-1" })).length === 1);
    await lib.deleteExpense(d1, j.expenseId);
    const done = await lib.deleteDigitizingJob(d1, j.id);
    ok("once the expense is deleted (soft) the record can be deleted too, and it keeps its link", done.id === j.id && done.expenseId === j.expenseId && (await lib.listDigitizingJobs(d1, { orderId: "O-1" })).length === 0);
    const j2 = await lib.saveDigitizingJob(d1, Object.assign({}, base, { name: "Dangling", costCents: 100 }));
    d1._raw.run("UPDATE digitizing_jobs SET expenseId = 99999 WHERE id = ?", [j2.id]);
    ok("a link to an expense that isn't there doesn't hold the record back", (await lib.deleteDigitizingJob(d1, j2.id)).id === j2.id);
    d1._raw.run("DELETE FROM digitizing_jobs; DELETE FROM expenses");
  }

  console.log("\n=== A vendor's rename renames its jobs ===");
  {
    const j = await lib.saveDigitizingJob(d1, Object.assign({}, base, { name: "Renamed vendor job" }));
    const dead = await lib.saveDigitizingJob(d1, Object.assign({}, base, { name: "Deleted job" }));
    await lib.deleteDigitizingJob(d1, dead.id);
    const v = (await lib.listVendors(d1)).find(x => x.name === "Example Digitizing Co");
    ok("the vendor says it digitizes (forDigitizing)", v.forDigitizing === true && (await lib.listVendors(d1)).find(x => x.name === "Other Supplier").forDigitizing === false);
    const r = await lib.saveVendor(d1, { id: v.id, name: "Example Digitizing Inc", forBlanks: false });
    ok("renaming the vendor renames the jobs that name it and counts them (digitizing jobs: 2 — a deleted one too)", r.renamed["digitizing jobs"] === 2 &&
      (await lib.listDigitizingJobs(d1, { orderId: "O-1" }))[0].vendor === "Example Digitizing Inc" && jobRows().every(x => x.vendor === "Example Digitizing Inc"));
    ok("…and a record saved after it takes the new name, while the old name is no longer on the list",
      (await lib.saveDigitizingJob(d1, Object.assign({}, base, { vendor: "Example Digitizing Inc", name: "After" }))).vendor === "Example Digitizing Inc" &&
      (await rej(Object.assign({}, base, { vendor: "Example Digitizing Co" }))).message.includes("isn't in the vendor list"));
    const before = r.renamed;
    const same2 = await lib.saveVendor(d1, { id: v.id, name: "Example Digitizing Inc", forBlanks: false, forDigitizing: false });
    ok("saving a vendor's “Digitizes designs” tick off keeps the name and the jobs", !same2.renamed["digitizing jobs"] && (await lib.listVendors(d1)).find(x => x.name === "Example Digitizing Inc").forDigitizing === false && before["digitizing jobs"] === 2);
    await lib.saveVendor(d1, { id: v.id, name: "Example Digitizing Co", forBlanks: false, forDigitizing: true });
    d1._raw.run("DELETE FROM digitizing_jobs");
  }

  // ============================ The action, behind the real handler ============================
  console.log("\n=== The migrations build the same table as schema.sql ===");
  const mig = await createD1();
  mig._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) mig.execFile(read("migrations/" + f));
  {
    const cols = (db) => db.q("PRAGMA table_info(digitizing_jobs)").map(c => c.name + ":" + c.type + ":" + c.notnull).join();
    ok("digitizing_jobs has the same columns after the migrations as in schema.sql", cols(mig) === cols(d1) && cols(d1).includes("deletedAt"));
    ok("expenses.orderId and vendors.forDigitizing are there too", mig.q("PRAGMA table_info(expenses)").some(c => c.name === "orderId") && mig.q("PRAGMA table_info(vendors)").some(c => c.name === "forDigitizing"));
  }
  // The real endpoint behind the real sign-in (adminAuth.js), on schema.sql; the catalog stand-in carries the feature
  // switches from globalThis.__t332Features.
  const STUB = "const getCatalogData = async () => ({ subdomainMap: {}, business: {} });";
  const pre = prelude(false, false);
  if (!pre.includes(STUB)) throw new Error("testlib/auth-harness.js's catalog stand-in changed: update test380");
  const A = await makeAuth();
  const D = A.d1;
  const post = new Function("__hits", pre.replace(STUB, "const getCatalogData = async () => ({ subdomainMap: {}, business: {}, features: globalThis.__t332Features || {} });") +
    strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
    "const invalidateCatalogVersionCache = () => {}; const selectBox = () => null;\n" +
    strip(read("functions/_lib/setupStatus.js")) + "\n" + strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" +
    strip(read("functions/_lib/email.js")) + "\n" + strip(ordersJs) + "\nreturn onRequestPost;")(A.hits);
  const admin = await A.firstAdmin("Olive Owner", "olive@example.com");
  const cookies = { admin, manager: await A.addUser(admin, "manager", "Mo Manager", "mo@example.com"), staff: await A.addUser(admin, "staff", "Sam Staff", "sam@example.com"),
    production: await A.addUser(admin, "production", "Pat Production", "pp@example.com"), nobody: "" };
  let who = "admin";
  const call = async (body, role) => {
    if (role !== undefined) who = role;
    const waits = [];
    const res = await post({ request: request("/api/orders", body, { cookie: cookies[who] }), env: A.env, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})) });
    await Promise.all(waits);
    const r = await answer(res);
    return { status: r.status, body: r.body };
  };
  const dq = (sql, ...p) => D.q(sql, ...p);
  const auditCount = () => dq("SELECT count(*) n FROM audit_log")[0].n;
  const logged = async (body, role) => { const before = dq("SELECT COALESCE(MAX(id), 0) m FROM audit_log")[0].m; const r = await call(body, role);
    return Object.assign({}, r, { rows: dq("SELECT * FROM audit_log WHERE id > " + before + " ORDER BY id").map(x => Object.assign({}, x, { detail: JSON.parse(x.detail || "null") })) }); };
  const refused = (r, status, message) => r.status === status && r.body.status === "error" && r.body.message === message;
  const forbidden = (r) => r.status === 403 && r.body && r.body.status === "error" && r.body.code === "forbidden";
  D._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  for (const [i, name] of VENDORS.entries()) await lib.saveVendor(D, { name, forBlanks: i === 2, forDigitizing: i < 2 });
  for (const id of ["O-1", "O-2"]) await lib.insertOrder(D, { orderId: id, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-03-01T12:00:00.000Z" }, cap);
  const itemId = dq("SELECT id FROM order_items WHERE orderId = 'O-1'")[0].id;
  const asAdmin = (b) => call(b, "admin");

  console.log("\n=== Who may: read, edit and full by built-in role (permissions.js) ===");
  {
    ok("the permission is in the Production menu as “Outside digitizing” (#digitizing)", roles.PERMISSION_AREAS.some(a => a.key === "production" && a.items.some(i => i.hash === "digitizing" && i.label === "Outside digitizing" && i.fns[0][0] === "production.digitizing")));
    ok("listing needs production.digitizing at read (or Orders details / Quotes at read); saving edit; deleting full",
      same(roles.ACTION_PERM.listDigitizingJobs.slice(0, 1), [["production.digitizing", "read"]]) && same(roles.ACTION_PERM.saveDigitizingJob, [["production.digitizing", "edit"]]) && same(roles.ACTION_PERM.deleteDigitizingJob, [["production.digitizing", "full"]]));
    ok("the vendor list is open to a role that may edit digitizing (the form picks the digitizer from it)", roles.ACTION_PERM.listVendors.some(p => p[0] === "production.digitizing" && p[1] === "edit"));
    const level = (r) => roles.effectivePermissions(roles.DEFAULT_ROLES[r])["production.digitizing"];
    ok("built-in defaults: Admin full, Manager full, Back office edit, Production read", ["admin", "manager", "staff", "production"].map(level).join() === "full,full,edit,read");
    const P = new Function(read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") + "\nreturn { normalizePermissions, roleAllows, ACTION_PERM };")();
    const stored = P.normalizePermissions({ fns: { "quotes.estimates": "edit" } });
    ok("a role stored before the permission existed has none of it: it can't save or delete", stored.fns["production.digitizing"] === "none" &&
      !P.roleAllows({ key: "r_old", permissions: stored }, P.ACTION_PERM.saveDigitizingJob) && !P.roleAllows({ key: "r_old", permissions: stored }, P.ACTION_PERM.deleteDigitizingJob));
    const log = auditCount();
    const probe = { listDigitizingJobs: {}, saveDigitizingJob: { job: null }, deleteDigitizingJob: { id: 0 } };
    const row = async (a) => { const out = []; for (const r of ["production", "staff", "manager", "admin"]) { const x = await call(Object.assign({ action: a }, probe[a]), r);
      out.push(forbidden(x) ? "no" : x.status === 400 ? "yes" : "? " + x.status); } return out.join(); };
    ok("listDigitizingJobs: every built-in role (Production reads)", await row("listDigitizingJobs") === "yes,yes,yes,yes");
    ok("saveDigitizingJob: not Production (read only); Back office, Manager and Admin", await row("saveDigitizingJob") === "no,yes,yes,yes");
    ok("deleteDigitizingJob: only Manager and Admin (full) — not Back office with edit", await row("deleteDigitizingJob") === "no,no,yes,yes");
    ok("a refusal for the role says so and writes nothing", (await call({ action: "deleteDigitizingJob", id: 1 }, "staff")).body.message === "Your role can't do this. Ask an admin." && auditCount() === log);
    const full = await call({ action: "listDigitizingJobs", orderId: "O-1" }, "production");
    const noRole = await call({ action: "listDigitizingJobs", orderId: "O-1" }, "nobody");
    ok("signed out nothing is answered: 401 Unauthorized", refused(noRole, 401, "Unauthorized"));
    ok("Production may list an order's records (200)", full.status === 200);
  }

  console.log("\n=== listDigitizingJobs: the request ===");
  {
    const bad = (b) => asAdmin(Object.assign({ action: "listDigitizingJobs" }, b));
    ok("without orderId or estimateId: 400 “orderId or estimateId required”", refused(await bad({}), 400, "orderId or estimateId required") && refused(await bad({ orderId: "" , estimateId: "" }), 400, "orderId or estimateId required") && refused(await bad({ estimateId: null }), 400, "orderId or estimateId required"));
    ok("an estimateId that isn't a whole number: 400 “estimateId must be a whole number”", refused(await bad({ estimateId: "x" }), 400, "estimateId must be a whole number") &&
      refused(await bad({ estimateId: 0 }), 400, "estimateId must be a whole number") && refused(await bad({ estimateId: 1.5 }), 400, "estimateId must be a whole number"));
    const r = await bad({ orderId: "O-1" });
    ok("an order with none answers { status: ok, jobs: [] }", r.status === 200 && r.body.status === "ok" && same(r.body.jobs, []));
    ok("a quote with none (estimateId given as text) answers the same", same((await bad({ estimateId: "7" })).body.jobs, []));
    ok("with both, the order wins", same((await bad({ orderId: "O-1", estimateId: "x" })).body, { status: "error", message: "estimateId must be a whole number" }));
  }

  console.log("\n=== saveDigitizingJob: the request's refusals (400 / 404) ===");
  const job = (patch) => ({ action: "saveDigitizingJob", job: Object.assign({ orderId: "O-1", name: "Example Club left chest logo", vendor: "Example Digitizing Co", sentAt: "2026-03-02" }, patch) });
  const jobCount = () => dq("SELECT count(*) n FROM digitizing_jobs")[0].n, expCount = () => dq("SELECT count(*) n FROM expenses")[0].n;
  {
    const log = auditCount(), n = jobCount();
    const cases = [
      ["no job", { action: "saveDigitizingJob" }, 400, "job required"],
      ["a job that is a list", { action: "saveDigitizingJob", job: [1] }, 400, "job required"],
      ["a job that is text", { action: "saveDigitizingJob", job: "x" }, 400, "job required"],
      ["no name", job({ name: "   " }), 400, "Say what was sent (its name)"],
      ["a name that isn't text", job({ name: 5 }), 400, "Say what was sent (its name)"],
      ["a name over 200 characters", job({ name: "x".repeat(201) }), 400, "The name is up to 200 characters"],
      ["no sent date", job({ sentAt: "" }), 400, "Enter the day it was sent (YYYY-MM-DD)"],
      ["a sent date with a time", job({ sentAt: "2026-03-02T10:00:00Z" }), 400, "Enter the day it was sent (YYYY-MM-DD)"],
      ["a sent date that isn't a day (2026-02-30)", job({ sentAt: "2026-02-30" }), 400, "Enter the day it was sent (YYYY-MM-DD)"],
      ["a sent date that is a number", job({ sentAt: 20260302 }), 400, "Enter the day it was sent (YYYY-MM-DD)"],
      ["a returned date that isn't a day", job({ returnedAt: "next week" }), 400, "Enter the day it came back (YYYY-MM-DD) or leave it empty"],
      ["a returned date before it was sent", job({ returnedAt: "2026-03-01" }), 400, "It can't come back before it was sent"],
      ["a negative cost", job({ costCents: -5 }), 400, "The cost is whole cents from $0 to $1,000,000"],
      ["a cost with a fraction", job({ costCents: 10.5 }), 400, "The cost is whole cents from $0 to $1,000,000"],
      ["a cost over $1,000,000", job({ costCents: 100000001 }), 400, "The cost is whole cents from $0 to $1,000,000"],
      ["a cost that isn't a number", job({ costCents: "lots" }), 400, "The cost is whole cents from $0 to $1,000,000"],
      ["an order that doesn't exist", job({ orderId: "O-404" }), 404, "Order not found"],
      ["a vendor that isn't on the list", job({ vendor: "Nobody Digitizing" }), 400, "“Nobody Digitizing” isn't in the vendor list — add it with Manage… next to the vendor."],
      ["an order line that isn't an id (db.js's sentence)", job({ itemId: "abc" }), 400, "The order line isn't a valid id."],
      ["a changed record that isn't there", job({ id: 4242 }), 400, "That digitizing record no longer exists — reload and try again."],
    ];
    for (const [what, body, status, message] of cases) {
      const r = await logged(body, "admin");
      ok(what + ": " + status + " “" + message + "”, nothing written or logged", refused(r, status, message) && r.rows.length === 0 && jobCount() === n && auditCount() === log);
    }
    { const r = await logged(job({ vendor: "v".repeat(121) }), "admin");
      ok("a vendor name over 120 characters is no vendor on the list: 400 “…isn't in the vendor list…”, nothing written", r.status === 400 && /isn't in the vendor list/.test(r.body.message) && jobCount() === n && r.rows.length === 0); }
    for (const p of [{ costCents: "" }, { costCents: null }, {}, { vendor: "", returnedAt: "" }, { returnedAt: null }, { returnedAt: "2026-03-02" }, { costCents: "2500" }]) {
      const r = await asAdmin(job(Object.assign({ name: "Variant " + JSON.stringify(p) }, p)));
      ok("accepted: " + JSON.stringify(p), r.status === 200 && r.body.status === "ok");
    }
    D._raw.run("DELETE FROM digitizing_jobs; DELETE FROM audit_log");
  }

  console.log("\n=== saveDigitizingJob: saved, the answer and the audit row ===");
  let savedId;
  {
    let r = await logged(job({ itemId, returnedAt: "2026-03-05", costCents: 2500, note: "Rush please" }), "admin");
    savedId = r.body.id;
    ok("a new record answers { status: ok, id, jobs } with the order's list including it", r.status === 200 && r.body.status === "ok" && Number.isInteger(r.body.id) && r.body.jobs.length === 1 && r.body.jobs[0].id === r.body.id &&
      r.body.jobs[0].costCents === 2500 && r.body.jobs[0].expenseId === null && r.body.jobs[0].createdBy === "olive@example.com");
    const a = r.rows.filter(x => x.action === "digitizing.sent");
    ok("…one audit row “digitizing.sent” on the order with what was sent, to whom, when, the cost and that no expense was recorded",
      r.rows.length === 1 && a.length === 1 && a[0].orderId === "O-1" && same(a[0].detail, { id: savedId, name: "Example Club left chest logo", vendor: "Example Digitizing Co", sentAt: "2026-03-02", returnedAt: "2026-03-05", costCents: 2500, expenseRecorded: false }));
    r = await logged(job({ id: savedId, name: "Changed name", costCents: 3000 }), "admin");
    ok("changing it (an id) answers the same shape, the list shows the new name, and the audit row is “digitizing.updated”",
      r.status === 200 && r.body.id === savedId && r.body.jobs.length === 1 && r.body.jobs[0].name === "Changed name" && r.body.jobs[0].costCents === 3000 &&
      r.rows.length === 1 && r.rows[0].action === "digitizing.updated" && r.rows[0].detail.returnedAt === null && r.rows[0].detail.costCents === 3000);
    r = await logged({ action: "saveDigitizingJob", job: { estimateId: 5, name: "Quote logo", sentAt: "2026-03-09" } }, "admin");
    ok("a record for a quote (no order) answers the quote's list, with the quote on its audit row and no order", r.status === 200 && r.body.jobs.length === 1 && r.body.jobs[0].estimateId === 5 && r.body.jobs[0].orderId === "" &&
      r.rows[0].orderId === null && r.rows[0].detail.estimateId === 5 && r.rows[0].detail.vendor === "");
    r = await logged({ action: "saveDigitizingJob", job: { name: "Neither", sentAt: "2026-03-09" } }, "admin");
    ok("a record for neither: saved, with no list in the answer", r.status === 200 && r.body.status === "ok" && Number.isInteger(r.body.id) && !("jobs" in r.body));
    r = await logged(job({ vendor: "  sample   stitch works " }), "admin");
    ok("the vendor is the vendor list's spelling in the record and in the audit row", r.body.jobs.some(j => j.vendor === "Sample Stitch Works") && r.rows[0].detail.vendor === "Sample Stitch Works");
    ok("the audit row of a save never has the note in it", !JSON.stringify(r.rows).includes("Rush please"));
  }

  console.log("\n=== recordExpense through the action: Expenses (edit), Bookkeeping, the closed month ===");
  {
    const want = (patch) => job(Object.assign({ name: "Booked logo", costCents: 4250, recordExpense: true, returnedAt: "2026-03-06" }, patch));
    const n = jobCount(), e = expCount(), log = auditCount();
    let r = await logged(want(), "staff");
    ok("Back office (edit on digitizing, no Expenses): 403 and the sentence about the tick; nothing saved", r.status === 403 && r.body.status === "error" &&
      r.body.message === "Your role can't record an expense. Untick “Record the cost as an expense”, or ask an admin." && jobCount() === n && expCount() === e && auditCount() === log);
    r = await logged(want({ costCents: 0 }), "staff");
    ok("…the same role may save the record with a cost of 0 and the tick (nothing to book)", r.status === 200);
    r = await logged(want({ name: "No tick for Back office", recordExpense: false }), "staff");
    ok("…and without the tick, with a cost", r.status === 200 && r.body.jobs.some(j => j.name === "No tick for Back office" && j.costCents === 4250 && j.expenseId === null));
    r = await logged(want({ expenseId: 5 }), "staff");
    ok("an expenseId sent with the tick is not taken as “already booked”: Back office is still refused (403) and no expense is written", r.status === 403 && r.body.message.startsWith("Your role can't record an expense.") && expCount() === e && jobCount() === n + 2);
    globalThis.__t332Features = { bookkeeping: false };
    r = await logged(want(), "admin");
    ok("with Bookkeeping off: 403 { feature: bookkeeping } and nothing saved", r.status === 403 && r.body.feature === "bookkeeping" && /Bookkeeping is turned off/.test(r.body.message) && expCount() === e);
    r = await logged(want({ recordExpense: false, name: "Books off, no tick" }), "admin");
    ok("…a record without the tick is saved as usual while Bookkeeping is off", r.status === 200);
    delete globalThis.__t332Features;
      D._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-03', '2026-04-05T00:00:00Z', 'test')");
    const nj = jobCount();
    r = await logged(want(), "admin");
    ok("a closed month: the expense's month (the day it came back) refuses it: 409 “…is closed (already filed)”; nothing saved", r.status === 409 && /March 2026 is closed \(already filed\)/.test(r.body.message) && jobCount() === nj && expCount() === e);
    r = await logged(want({ returnedAt: "", sentAt: "2026-03-02" }), "admin");
    ok("…with no return date the month it was sent decides", r.status === 409 && /March 2026 is closed/.test(r.body.message));
    r = await logged(want({ expenseId: 5 }), "admin");
    ok("…an expenseId sent with the tick doesn't get round the closed month", r.status === 409 && /March 2026 is closed/.test(r.body.message) && expCount() === e);
    r = await logged(want({ returnedAt: "2026-04-06" }), "admin");
    ok("…the month it came back is what counts, not the month it was sent: sent in a closed month, back in an open one is allowed", r.status === 200 && expCount() === e + 1);
    r = await logged(want({ recordExpense: false, name: "Closed month, no expense", returnedAt: "2026-03-06" }), "admin");
    ok("a record with no expense is no sale and no cost: a closed month doesn't refuse it", r.status === 200);
    r = await logged(want({ costCents: 0, name: "Closed month, no cost", returnedAt: "2026-03-06" }), "admin");
    ok("…nor does one with the tick but no cost to book", r.status === 200);
    const booked = dq("SELECT * FROM digitizing_jobs WHERE expenseId IS NOT NULL")[0];
    r = await logged(job({ id: booked.id, name: "Booked logo, renamed", returnedAt: "2026-03-06", costCents: 4250, expenseId: booked.expenseId }), "admin");
    ok("…nor does changing a record that already has its expense, as the page sends it (no tick): the expense isn't touched", r.status === 200 && expCount() === e + 1 && dq("SELECT * FROM expenses WHERE id = ?", booked.expenseId)[0].expenseDate === "2026-04-06");
    D._raw.run("DELETE FROM closed_periods");
    const ex = dq("SELECT * FROM expenses ORDER BY id DESC")[0];
    ok("the expense the action wrote: dated when it came back, the order, the amount, in the Digitizing category, with its audit row noting expenseRecorded",
      ex.expenseDate === "2026-04-06" && ex.orderId === "O-1" && Number(ex.amountCents) === 4250 && ex.description === "Digitizing: Booked logo" &&
      dq("SELECT name FROM expense_categories WHERE id = ?", ex.categoryId)[0].name === "Digitizing" &&
      dq("SELECT * FROM audit_log WHERE action = 'digitizing.sent'").some(x => JSON.parse(x.detail).expenseRecorded === true));
    r = await logged(want({ name: "Manager books it", returnedAt: "2026-05-02" }), "manager");
    ok("Manager (Expenses edit and Bookkeeping on) books the expense", r.status === 200 && r.body.jobs.find(j => j.name === "Manager books it").expenseId !== null);
  }

  console.log("\n=== The cost is hidden without costs.view (and without editing digitizing) ===");
  {
    const asked = async (role, b) => (await call(Object.assign({ action: "listDigitizingJobs", orderId: "O-1" }, b || {}), role)).body.jobs;
    const costed = (await asked("admin")).filter(j => j.costCents > 0 && j.expenseId !== null);
    ok("there are records with a cost and an expense to look at", costed.length >= 2);
    ok("Admin and Manager see costCents and expenseId", (await asked("admin"))[0].costCents !== undefined && "expenseId" in (await asked("manager"))[0]);
    ok("Back office, who edits digitizing, sees them too (it enters them)", (await asked("staff")).every(j => "costCents" in j && "expenseId" in j));
    const prod = await asked("production");
    ok("Production (read only, no costs.view) gets the records with no costCents and no expenseId at all", prod.length === (await asked("admin")).length && prod.every(j => !("costCents" in j) && !("expenseId" in j) && j.name && j.sentAt));
    const saved = (await call(job({ name: "Production can't save" }), "production"));
    ok("…and after a save by a role that can, the answer's list is hidden the same way for that role (Back office keeps it)", forbidden(saved) && (await call(job({ name: "Back office save" }), "staff")).body.jobs.every(j => "costCents" in j));
  }

  console.log("\n=== deleteDigitizingJob through the action ===");
  {
    const mk = async (patch) => (await asAdmin(job(patch))).body.id;
    const log = auditCount();
    let r = await logged({ action: "deleteDigitizingJob" }, "admin");
    ok("no id: 400 “id required”", refused(r, 400, "id required") && refused(await asAdmin({ action: "deleteDigitizingJob", id: "x" }), 400, "id required") && refused(await asAdmin({ action: "deleteDigitizingJob", id: 0 }), 400, "id required") &&
      refused(await asAdmin({ action: "deleteDigitizingJob", id: 1.5 }), 400, "id required") && auditCount() === log);
    r = await logged({ action: "deleteDigitizingJob", id: 98765 }, "admin");
    ok("an id nobody has: 409 “That digitizing record no longer exists.”", refused(r, 409, "That digitizing record no longer exists.") && r.rows.length === 0);
    const plain = await mk({ name: "Delete me" });
    r = await logged({ action: "deleteDigitizingJob", id: plain, orderId: "O-1" }, "manager");
    ok("a Manager deletes a record with no expense: 200 { status: ok }, kept as deleted, off the list, audit “digitizing.deleted” on its order",
      r.status === 200 && same(r.body, { status: "ok" }) && /^\d{4}/.test(dq("SELECT deletedAt FROM digitizing_jobs WHERE id = ?", plain)[0].deletedAt) &&
      !(await call({ action: "listDigitizingJobs", orderId: "O-1" })).body.jobs.some(j => j.id === plain) &&
      r.rows.length === 1 && r.rows[0].action === "digitizing.deleted" && r.rows[0].orderId === "O-1" && same(r.rows[0].detail, { id: plain }));
    r = await logged({ action: "deleteDigitizingJob", id: plain }, "admin");
    ok("deleting it again: 409, and no second audit row", refused(r, 409, "That digitizing record no longer exists.") && r.rows.length === 0);
    r = await logged({ action: "deleteDigitizingJob", id: await mk({ name: "No order given" }) }, "admin");
    ok("an audit row without an order when the page didn't send one", r.status === 200 && r.rows[0].orderId === null);
    const withExp = await mk({ name: "Has its expense", costCents: 1800, recordExpense: true, returnedAt: "2026-06-02" });
    const expId = dq("SELECT expenseId FROM digitizing_jobs WHERE id = ?", withExp)[0].expenseId;
    r = await logged({ action: "deleteDigitizingJob", id: withExp }, "admin");
    ok("while its expense is live: 409 “Delete its expense first”, the record is kept, nothing logged", refused(r, 409, "Delete its expense first") && r.rows.length === 0 &&
      dq("SELECT deletedAt FROM digitizing_jobs WHERE id = ?", withExp)[0].deletedAt === null);
    r = await logged({ action: "deleteDigitizingJob", id: withExp }, "staff");
    ok("Back office is refused first (403) whatever the record's state", forbidden(r));
    const gone = await asAdmin({ action: "deleteExpense", expenseId: expId });
    r = await logged({ action: "deleteDigitizingJob", id: withExp }, "admin");
    ok("after the expense is deleted, the record can be deleted: 200", gone.status === 200 && r.status === 200 && dq("SELECT deletedAt FROM digitizing_jobs WHERE id = ?", withExp)[0].deletedAt !== null);
  }

  console.log("\n=== Deleting a record changes no month (a closed month doesn't stop it) ===");
  {
    const id = (await asAdmin(job({ name: "Filed month record", sentAt: "2026-03-02" }))).body.id;
    D._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-03', '2026-04-05T00:00:00Z', 'test')");
    const r = await asAdmin({ action: "deleteDigitizingJob", id });
    D._raw.run("DELETE FROM closed_periods");
    ok("with the record's month closed, deleting it (no expense) answers 200", r.status === 200);
    const noMonth = [...ordersJs.match(/const NO_MONTH_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ok("deleteDigitizingJob is listed as touching no month; saveDigitizingJob is not (its expense has a month: periodGuard)", noMonth.includes("deleteDigitizingJob") && !noMonth.includes("saveDigitizingJob") && /a === "saveDigitizingJob" && b\.job && b\.job\.recordExpense === true/.test(ordersJs));
  }

  console.log("\n=== listVendors for the form: Back office may, Production may not ===");
  {
    const v = await call({ action: "listVendors" }, "staff");
    ok("Back office (digitizing edit) gets the vendor list, each vendor saying whether it digitizes", v.status === 200 && v.body.vendors.find(x => x.name === "Example Digitizing Co").forDigitizing === true && v.body.vendors.find(x => x.name === "Other Supplier").forDigitizing === false);
    ok("Production (digitizing read only) is refused the vendor list", forbidden(await call({ action: "listVendors" }, "production")));
    const s = await call({ action: "saveVendor", vendor: { name: "Brand New Digitizer", forBlanks: false, forDigitizing: true } }, "admin");
    ok("a vendor saved with “Digitizes designs” keeps it (saveVendor and listVendors)", s.status === 200 && s.body.vendor.forDigitizing === true && s.body.vendors.find(x => x.name === "Brand New Digitizer").forDigitizing === true);
    const s2 = await call({ action: "saveVendor", vendor: { id: s.body.vendor.id, name: "Brand New Digitizer", forBlanks: false } }, "admin");
    ok("…and a save that doesn't send the tick leaves it as it was", s2.body.vendor.forDigitizing === true);
  }

  // ============================ The page (public/admin-digitizing.js in the real admin page) ============================
  const adminJs = read("public/admin.js"), custJs = read("public/admin-customers.js"), quotesJs = read("public/admin-quotes.js"), dgJs = read("public/admin-digitizing.js");
  const sent = [], toasts = [], served = [];
  let dgMode = "ok";      // "fail": /admin-digitizing.js can't be fetched
  let scripted = null;    // { action, status, body, gate? }: the next request for that action is answered with this
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      served.push(String(url));
      if (/\/admin-digitizing\.js(\?|$)/.test(url)) return dgMode === "fail" ? Promise.reject(new Error("offline")) : Promise.resolve(Buffer.from(dgJs));
      if (/\/admin-quotes\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(quotesJs));
      if (/\/admin-customers\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(custJs));
      if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs));
      return Promise.resolve(Buffer.from(""));
    }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented|Could not load script: "https:\/\/admin\.example\.com\/admin-digitizing\.js/.test(e.message)) console.error(e); });
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(b);
        if (scripted && scripted.action === b.action) { const sc = scripted; scripted = null; if (sc.gate) await sc.gate; return reply(sc.status || 200, sc.body); }
        const x = await call(b);
        return reply(x.status, x.body);
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC");');
  w.eval('adminOrgs = ' + JSON.stringify([{ orgId: "acme", name: "Example Club" }]) + ';');
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const reset = () => { sent.length = 0; toasts.length = 0; };
  const of = (action) => sent.filter(b => b.action === action);
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const levelsOf = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role]);
  const asRole = (role) => { who = role; w.eval(roles.asRole(role, { name: "Tester", email: "tester@example.test" })); };
  const signInWith = (perms, serverRole) => { who = serverRole || "admin"; w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(perms)}; adminAreas = ${JSON.stringify(roles.PERMISSION_AREAS)};`); };
  const withLevels = (role, changes) => Object.assign({}, levelsOf(role), changes);
  const modals = () => qa(".admin-modal").filter(m => !m.classList.contains("confirm-modal") && !m.querySelector("#cmOk"));
  const topModal = () => modals()[modals().length - 1] || null;
  const confirmBox = () => q(".confirm-modal");
  const answerConfirm = async (yes) => { await wait(() => confirmBox()); const box = confirmBox(); const info = { message: box.dataset.message, okLabel: box.querySelector("#cmOk").textContent };
    box.querySelector(yes ? "#cmOk" : "#cmCancel").click(); await wait(() => !confirmBox()); return info; };
  const closeAll = () => { for (const m of qa(".admin-modal")) m.remove(); };
  const listText = () => { const m = topModal() || q("#qtDigitizing"); const l = m && m.querySelector("[data-dg-list]"); return l ? l.textContent.replace(/\s+/g, " ").trim() : ""; };
  const listLoaded = () => { const m = topModal() || q("#qtDigitizing"); const l = m && m.querySelector("[data-dg-list]"); return !!l && !/Loading…/.test(l.textContent); };
  const rowsOf = () => qa("[data-dg-list] tbody tr");
  const setVal = (sel, v) => { const el = topModal().querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const submitForm = async () => { topModal().querySelector("#dgForm").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await pause(30); };
  const afterSave = async () => { await wait(() => !formOpen()); await wait(() => of("listDigitizingJobs").length >= 1); await pause(60); };
  const formOpen = () => topModal() && topModal().querySelector("#dgForm");
  const today = w.eval("localToday_()");
  const ord = async () => (await call({ action: "getOrders", org: "acme" }, "admin")).body.orders || [];
  const openOrder = async (orderId) => { reset(); const p = w.showOrderDigitizing_("acme", orderId); await p; return wait(() => listLoaded()); };
  // Hand-made rows on the server, for the lists the page draws.
  const seed = async (patch) => { const r = await call(Object.assign({ action: "saveDigitizingJob" }, { job: Object.assign({ orderId: "O-1", name: "Seed", vendor: "", sentAt: "2026-02-01" }, patch) }), "admin"); if (r.status !== 200) throw new Error("seed: " + JSON.stringify(r.body)); return r.body.id; };
  D._raw.run("DELETE FROM digitizing_jobs; DELETE FROM expenses; DELETE FROM audit_log");
  await lib.saveVendor(D, { name: "Hidden Digitizer", forBlanks: false, forDigitizing: true, hidden: true });
  w.eval("window._ordersCache = window._ordersCache || {};");
  w._ordersCache.acme = await ord();
  asRole("admin");

  console.log("\n=== The order window's Digitizing… button ===");
  {
    const o = Object.assign({}, w._ordersCache.acme.find(x => x.orderId === "O-1"), { paid: true });
    const cell = (role, perms) => { if (perms) signInWith(perms); else asRole(role); const t = d.createElement("div"); t.innerHTML = w.adminActionCell({ orgId: "acme" }, o); return t.querySelector('[data-admin-action="showOrderDigitizing_"]'); };
    const btn = cell("admin");
    ok("an order's Action cell has a Digitizing… button for the order (data-org, data-order), with its title", !!btn && btn.textContent === "Digitizing…" && btn.dataset.org === "acme" && btn.dataset.order === "O-1" && /outside digitizer/.test(btn.title));
    ok("…Admin, Manager, Back office and Production (read) all get it", ["manager", "staff", "production"].every(r => { const b = cell(r); return !!b && b.textContent === "Digitizing…"; }));
    ok("…a role with no access to Outside digitizing gets none", cell(null, withLevels("admin", { "production.digitizing": "none" })) === null);
    {
      const unpaid = Object.assign({}, o, { paid: false, paidForWork: false, payOnDelivery: false });
      const find = (html, a) => { const t = d.createElement("div"); t.innerHTML = html; return t.querySelector('[data-admin-action="' + a + '"]'); };
      asRole("admin");
      const ucell = w.adminActionCell({ orgId: "acme" }, unpaid);
      const ub = find(ucell, "showOrderDigitizing_");
      ok("an order that isn't paid or cleared for work still has Digitizing… (it is often sent out before payment), with its data and title", !!ub && ub.textContent === "Digitizing…" && ub.dataset.org === "acme" && ub.dataset.order === "O-1" && /outside digitizer/.test(ub.title) && !!find(ucell, "markOrderPaid"));
      ok("…on an unpaid order Back office and Production (read) get it too, and a role with no access to Outside digitizing gets none", ["manager", "staff", "production"].every(r => { asRole(r); return !!find(w.adminActionCell({ orgId: "acme" }, unpaid), "showOrderDigitizing_"); }) &&
        (signInWith(withLevels("admin", { "production.digitizing": "none" })), find(w.adminActionCell({ orgId: "acme" }, unpaid), "showOrderDigitizing_") === null));
      asRole("admin");
    }
    ok("the button is on the paid orders' Action cell, which is where Dates… and the stage menu are too (an unpaid order's cell offers payment first)", !!btn && !!(() => { const t = d.createElement("div"); t.innerHTML = w.adminActionCell({ orgId: "acme" }, o); return t.querySelector('[data-admin-action="showOrderDates_"]'); })());
    ok("the button's action is one the page knows (admin.js's action list names showOrderDigitizing_)", typeof w.showOrderDigitizing_ === "function" && /showOrderDigitizing_\(\)\{ showOrderDigitizing_\(this\.dataset\.org,this\.dataset\.order\); \}/.test(adminJs));
  }

  console.log("\n=== Opening it: the script is fetched the first time (ensureDigitizingUi_) ===");
  {
    asRole("admin");
    ok("the script isn't loaded until it is needed (and isn't a script tag of index.html)", !served.some(u => /admin-digitizing\.js/.test(u)) && typeof w.digitizingSectionHtml_ !== "function" && !/admin-digitizing\.js/.test(read("public/index.html")));
    reset();
    await w.showOrderDigitizing_("acme", "O-404");
    ok("an order that isn't in the list: the toast “Order not found — refresh the list.” (an error), no window, nothing fetched", lastToast().m === "Order not found — refresh the list." && lastToast().err === true && !topModal() && !served.some(u => /admin-digitizing\.js/.test(u)));
    dgMode = "fail";
    reset();
    await w.showOrderDigitizing_("acme", "O-1");
    ok("when the script can't be fetched: the toast “Couldn't load the digitizing records” (an error) and no window", lastToast().m === "Couldn't load the digitizing records" && lastToast().err === true && !topModal() && of("listDigitizingJobs").length === 0);
    dgMode = "ok";
    reset();
    const hold = {}; hold.p = new Promise(r => { hold.go = r; });
    scripted = { action: "listDigitizingJobs", gate: hold.p, body: { status: "ok", jobs: [] } };
    const opened = w.showOrderDigitizing_("acme", "O-1");
    await opened;
    ok("asked again (the failed fetch isn't remembered), it loads the script once and opens “Outside digitizing — O-1” with “Loading…” until the list answers",
      served.filter(u => /admin-digitizing\.js/.test(u)).length === 2 && typeof w.digitizingSectionHtml_ === "function" && typeof w.wireDigitizingSection_ === "function" &&
      topModal().querySelector("[data-dialog-title]").textContent === "Outside digitizing — O-1" && /Loading…/.test(listText()));
    hold.go();
    await wait(listLoaded);
    ok("…the list was asked for this order: listDigitizingJobs { orderId: O-1 }, and an order with none says so, with how to add one", same(of("listDigitizingJobs").map(b => ({ orderId: b.orderId, estimateId: b.estimateId })), [{ orderId: "O-1" }]) &&
      listText() === "Nothing has been sent to an outside digitizer. “Send to digitizer…” records one.");
    ok("the window has the heading “Outside digitizing” and a Send to digitizer… button (for a role that edits)", topModal().querySelector("h3.cust-h").textContent === "Outside digitizing" && topModal().querySelector("[data-dg-new]").textContent === "Send to digitizer…");
    closeAll();
    reset();
    await w.showOrderDigitizing_("acme", "O-1");
    ok("opened again: the script isn't fetched a second time", served.filter(u => /admin-digitizing\.js/.test(u)).length === 2 && !!topModal());
    closeAll();
  }

  console.log("\n=== Send to digitizer: the window ===");
  {
    asRole("admin");
    await openOrder("O-1");
    scripted = { action: "listVendors", status: 500, body: { status: "error", message: "Server error" } };
    topModal().querySelector("[data-dg-new]").click();
    await wait(formOpen);
    ok("if the vendor list can't be read, the form still opens, with a plain Digitizer box in place of the list", !!formOpen() && !q("#dgVendor") && !!q("#dgVendorOther") && q("#dgVendorOtherWrap").hidden === false && /Digitizer/.test(q("#dgVendorOtherWrap").textContent));
    ok("…the window is named “Send to digitizer”, the button says “Record it”", topModal().querySelector("[data-dialog-title]").textContent === "Send to digitizer" && q("#dgSave").textContent === "Record it");
    q("#dgCancel").click();
    await wait(() => !formOpen());
    ok("Cancel closes the window when nothing was typed (no question asked)", !formOpen() && !confirmBox());
    reset();
    topModal().querySelector("[data-dg-new]").click();
    await wait(formOpen);
    ok("opened again it asks for the vendors again (the failure wasn't kept): listVendors", of("listVendors").length === 1 && !!q("#dgVendor"));
    const opts = [...q("#dgVendor").options].map(o => o.value + "|" + o.textContent);
    ok("the digitizers first (by name), then the others marked “(not marked as a digitizer)”, a hidden vendor not at all, then “Someone else…”",
      same(opts, ["Brand New Digitizer|Brand New Digitizer", "Example Digitizing Co|Example Digitizing Co", "Sample Stitch Works|Sample Stitch Works", "Other Supplier|Other Supplier (not marked as a digitizer)", "__other__|Someone else…"]));
    ok("the first digitizer is picked, and the “their name” box is hidden", q("#dgVendor").value === "Brand New Digitizer" && q("#dgVendorOtherWrap").hidden === true);
    ok("Sent on is today (the page's own today), Back on and Cost are empty, no note", q("#dgSent").value === today && q("#dgBack").value === "" && q("#dgCost").value === "" && q("#dgNote").value === "" && q("#dgName").value === "");
    ok("the name box has its example placeholder and the 200-character limit; the vendor box 120; the note 1000", q("#dgName").maxLength === 200 && q("#dgVendorOther").maxLength === 120 && q("#dgNote").maxLength === 1000 && /Example Club/.test(q("#dgName").placeholder));
    ok("the order's lines are offered (“Not for one line”, then each active line)", same([...q("#dgItem").options].map(o => o.textContent), ["Not for one line", "Cap"]) && q("#dgItem").value === "");
    ok("an admin may book the expense: the tick “Record the cost as an expense” is there, unticked", !!q("#dgExpense") && q("#dgExpense").checked === false && /Record the cost as an expense/.test(q("#dgForm").textContent));
    q("#dgVendor").value = "__other__"; q("#dgVendor").dispatchEvent(new w.Event("change", { bubbles: true }));
    ok("choosing “Someone else…” shows the “Their name” box", q("#dgVendorOtherWrap").hidden === false && /Their name/.test(q("#dgVendorOtherWrap").textContent));
    q("#dgVendor").value = "Example Digitizing Co"; q("#dgVendor").dispatchEvent(new w.Event("change", { bubbles: true }));
    ok("…and choosing a vendor again hides it", q("#dgVendorOtherWrap").hidden === true);
    setVal("#dgName", "x");
    q("#dgCancel").click();
    const info = await answerConfirm(false);
    ok("after typing, Cancel asks “Discard changes?”, and “Keep editing” leaves the window open with what was typed", /Discard changes\?/.test(info.message) && !!formOpen() && q("#dgName").value === "x");
    q("#dgCancel").click();
    await answerConfirm(true);
    ok("…“Discard” closes it, nothing was sent", !formOpen() && of("saveDigitizingJob").length === 0);
    closeAll();
    asRole("staff");
    await openOrder("O-1");
    topModal().querySelector("[data-dg-new]").click();
    await wait(formOpen);
    ok("Back office (no Expenses edit) gets the form without the expense tick", !!formOpen() && !q("#dgExpense") && !!q("#dgVendor"));
    closeAll();
    asRole("production");
    await openOrder("O-1");
    ok("Production (read only) sees the section with no Send to digitizer… button, and the empty list without the “records one” sentence", !topModal().querySelector("[data-dg-new]") && listText() === "Nothing has been sent to an outside digitizer.");
    closeAll();
  }

  console.log("\n=== Send to digitizer: what is checked before anything is sent ===");
  {
    asRole("admin");
    await openOrder("O-1");
    topModal().querySelector("[data-dg-new]").click();
    await wait(formOpen);
    reset();
    const err = () => q("#dgErr").textContent;
    const tryIt = async (name, fields, expectMsg, focusSel) => {
      for (const [sel, v] of Object.entries(fields)) { if (sel === "#dgExpense") q(sel).checked = v; else setVal(sel, v); }
      await submitForm();
      ok(name + ": “" + expectMsg + "”, nothing sent" + (focusSel ? ", the box to fix has focus" : ""), err() === expectMsg && of("saveDigitizingJob").length === 0 && (!focusSel || d.activeElement === q(focusSel)));
    };
    await tryIt("nothing typed", {}, "Say what was sent.", "#dgName");
    await tryIt("a name of only spaces", { "#dgName": "   " }, "Say what was sent.", "#dgName");
    setVal("#dgName", "Example Club left chest logo");
    q("#dgVendor").value = "__other__"; q("#dgVendor").dispatchEvent(new w.Event("change", { bubbles: true }));
    await tryIt("“Someone else…” left blank", {}, "Say who digitized it.", "#dgVendorOther");
    q("#dgVendor").value = "Example Digitizing Co"; q("#dgVendor").dispatchEvent(new w.Event("change", { bubbles: true }));
    await tryIt("no sent date", { "#dgSent": "" }, "Enter the day it was sent.", "#dgSent");
    setVal("#dgSent", "2026-03-10");
    await tryIt("back before sent", { "#dgBack": "2026-03-09" }, "It can't come back before it was sent.", "#dgBack");
    setVal("#dgBack", "");
    await tryIt("a cost with three decimals", { "#dgCost": "1.234" }, "Enter the cost (0 or more, like 25.00).", "#dgCost");
    await tryIt("a negative cost", { "#dgCost": "-5" }, "Enter the cost (0 or more, like 25.00).", "#dgCost");
    await tryIt("a cost over $1,000,000", { "#dgCost": "2000000" }, "Enter the cost (0 or more, like 25.00).", "#dgCost");
    await tryIt("the expense tick with no cost", { "#dgCost": "", "#dgExpense": true }, "There is no cost to record as an expense. Enter the cost first.", "#dgCost");
    ok("while refused, Record it stays usable (it was never disabled)", q("#dgSave").disabled === false);
    closeAll();
  }

  console.log("\n=== Send to digitizer: saving ===");
  {
    asRole("admin");
    await openOrder("O-1");
    topModal().querySelector("[data-dg-new]").click();
    await wait(formOpen);
    reset();
    setVal("#dgName", "  Example Club left chest logo "); setVal("#dgVendor", "Sample Stitch Works"); setVal("#dgSent", "2026-03-10"); setVal("#dgBack", "2026-03-12");
    setVal("#dgCost", "25.5"); setVal("#dgNote", " Rush please "); setVal("#dgItem", String(itemId)); q("#dgExpense").checked = true;
    scripted = { action: "saveDigitizingJob", status: 400, body: { status: "error", message: "Server says no" } };
    await submitForm();
    ok("a refusal from the server is shown in the window, which stays open with Record it usable again; nothing is toasted",
      q("#dgErr").textContent === "Server says no" && !!formOpen() && q("#dgSave").disabled === false && of("saveDigitizingJob").length === 1 && toasts.length === 0);
    reset();
    await submitForm();
    const sentBody = of("saveDigitizingJob")[0];
    ok("saving sends one saveDigitizingJob with the job: trimmed text, the order, the line as a number, dates, the cost in whole cents, and recordExpense",
      same(sentBody.job, { orderId: "O-1", name: "Example Club left chest logo", vendor: "Sample Stitch Works", sentAt: "2026-03-10", returnedAt: "2026-03-12", costCents: 2550, note: "Rush please", itemId, recordExpense: true }));
    await wait(() => !formOpen() && listLoaded() && rowsOf().length === 1);
    ok("…then the window closes, the toast says “Digitizing record added.”, and the list is asked for again", lastToast().m === "Digitizing record added." && lastToast().err === false && !formOpen() && of("listDigitizingJobs").length >= 1);
    const row = rowsOf()[0];
    ok("…the row: name, the sent date and note and “cost booked as an expense”, the vendor, the back date, the cost as money",
      /^Example Club left chest logo/.test(row.children[0].textContent) && /3\/10\/2026/.test(row.children[0].textContent) && /Rush please/.test(row.children[0].textContent) && /cost booked as an expense/.test(row.children[0].textContent) &&
      row.children[1].textContent === "Sample Stitch Works" && /3\/12\/2026/.test(row.children[2].textContent) && row.children[3].textContent === "$25.50");
    const ex = dq("SELECT * FROM expenses ORDER BY id DESC")[0];
    ok("…and the expense is in the books: the order, the amount, the day it came back", !!ex && ex.orderId === "O-1" && Number(ex.amountCents) === 2550 && ex.expenseDate === "2026-03-12" && ex.vendor === "Sample Stitch Works");
    ok("a single record shows no “Total cost” line", !/Total cost/.test(listText()));
    // A second one, not back yet, a cost typed with no decimals, someone not on the vendor list typed by hand.
    topModal().querySelector("[data-dg-new]").click();
    await wait(formOpen);
    reset();
    setVal("#dgName", "Back of cap"); setVal("#dgVendor", "__other__"); setVal("#dgVendorOther", " Nobody Digitizing "); setVal("#dgCost", "10");
    await submitForm();
    ok("a vendor typed under “Someone else…” that isn't on the list is refused by the server, and the window shows its sentence", /“Nobody Digitizing” isn't in the vendor list/.test(q("#dgErr").textContent) && !!formOpen() &&
      of("saveDigitizingJob")[0].job.vendor === "Nobody Digitizing" && of("saveDigitizingJob")[0].job.costCents === 1000 && of("saveDigitizingJob")[0].job.returnedAt === null && !("recordExpense" in of("saveDigitizingJob")[0].job));
    setVal("#dgVendorOther", "Sample Stitch Works"); reset();
    await submitForm();
    await wait(() => !formOpen() && rowsOf().length === 2);
    ok("…typing a vendor that is on the list works (the list's own spelling kept by the server)", rowsOf().length === 2 && !formOpen());
    ok("two records: newest sent first (the record sent today before the March one), “Not back yet” on the one still out, and the total cost", /Not back yet/.test(rowsOf()[0].textContent) && rowsOf()[0].children[3].textContent === "$10.00" && rowsOf()[1].children[3].textContent === "$25.50" &&
      /Total cost: \$35\.50/.test(listText()));
    ok("…each row has a Change and a Delete button, named for what they act on", rowsOf().every(r => /^Change /.test(r.querySelector("[data-dg-edit]").getAttribute("aria-label")) && /^Delete /.test(r.querySelector("[data-dg-del]").getAttribute("aria-label"))) &&
      rowsOf()[0].querySelector("[data-dg-edit]").getAttribute("aria-label") === "Change Back of cap");
    closeAll();
  }

  console.log("\n=== The list: what is drawn, escaped, and hidden ===");
  {
    D._raw.run("DELETE FROM digitizing_jobs; DELETE FROM expenses");
    const XSS = '<img src=x onerror="window.__xss380=1">Cap & Co';
    await seed({ name: XSS, note: '<b onmouseover="window.__xss380=2">bold</b>', vendor: "Example Digitizing Co", sentAt: "2026-02-01", costCents: 1234 });
    const nameless = await lib.saveDigitizingJob(D, { orderId: "O-1", name: "Old record", vendor: "", sentAt: "2026-01-01", returnedAt: "2026-01-04", costCents: 0 });
    D._raw.run("UPDATE digitizing_jobs SET name = '' WHERE id = ?", [nameless.id]);   // a record from before a name was required
    asRole("admin");
    await openOrder("O-1");
    ok("names and notes are text, never markup", !w.__xss380 && !topModal().querySelector("[data-dg-list] img") && !topModal().querySelector("[data-dg-list] b") && rowsOf()[0].children[0].textContent.includes(XSS));
    ok("a record with no name shows “Digitizing” and its edit/delete labels use it; no cost shows nothing; a returned date shows the date, not the tag",
      rowsOf()[1].children[0].textContent.startsWith("Digitizing") && rowsOf()[1].querySelector("[data-dg-edit]").getAttribute("aria-label") === "Change digitizing" && rowsOf()[1].children[3].textContent === "" && !/Not back yet/.test(rowsOf()[1].textContent) && /1\/4\/2026/.test(rowsOf()[1].children[2].textContent));
    ok("two records with one cost: the total is shown (a single cost isn't a total of anything)", /Total cost: \$12\.34/.test(listText()));
    closeAll();
    asRole("production");
    await openOrder("O-1");
    ok("Production sees the records but no cost anywhere, no total, and no Change or Delete", rowsOf().length === 2 && !/\$/.test(listText()) && !/Total cost/.test(listText()) && !topModal().querySelector("[data-dg-edit]") && !topModal().querySelector("[data-dg-del]") && !/Change or delete/.test(topModal().textContent));
    closeAll();
    asRole("admin");
    scripted = { action: "listDigitizingJobs", status: 500, body: { status: "error", message: "The database is busy" } };
    await openOrder("O-1");
    await wait(() => topModal().querySelector(".cust-err"));
    ok("a list that can't be read shows the server's message as an alert", topModal().querySelector("[data-dg-list] .cust-err").getAttribute("role") === "alert" && topModal().querySelector("[data-dg-list] .cust-err").textContent === "The database is busy");
    closeAll();
  }

  console.log("\n=== A slower, older answer doesn't replace a newer one; a closed window isn't drawn on ===");
  {
    asRole("admin");
    D._raw.run("DELETE FROM digitizing_jobs; DELETE FROM expenses");
    reset();
    // The list's first answer is held; meanwhile a record is saved, which asks for the list again and draws it.
    const hold = {}; hold.p = new Promise(r => { hold.go = r; });
    scripted = { action: "listDigitizingJobs", gate: hold.p, body: { status: "ok", jobs: [] } };
    await w.showOrderDigitizing_("acme", "O-1");
    await pause(20);
    ok("the list is still on its way (“Loading…”) while the window already offers Send to digitizer…", /Loading…/.test(listText()) && !!topModal().querySelector("[data-dg-new]"));
    topModal().querySelector("[data-dg-new]").click();
    await wait(formOpen);
    setVal("#dgName", "Newer than the held answer");
    await submitForm();
    await wait(() => rowsOf().length === 1);
    hold.go(); await pause(40);
    ok("the first answer (empty) arrives after the newer one (one record) and is ignored", rowsOf().length === 1 && /Newer than the held answer/.test(listText()));
    const root = topModal();
    reset();
    w.wireDigitizingSection_(root, { orderId: "O-1", canEdit: true, canExpense: true });
    await pause(60);
    root.querySelector("[data-dg-new]").click();
    await wait(formOpen); await pause(20);
    ok("wiring the same box again loads it again but adds no second set of click listeners: one Send window per click", modals().filter(m => m.querySelector("#dgForm")).length === 1 && of("listDigitizingJobs").length === 1);
    closeAll();
    // A window closed while its list is on its way.
    const hold2 = {}; hold2.p = new Promise(r => { hold2.go = r; });
    scripted = { action: "listDigitizingJobs", gate: hold2.p, body: { status: "ok", jobs: [{ id: 1, name: "Late", sentAt: "2026-01-01" }] } };
    const p = w.showOrderDigitizing_("acme", "O-1");
    await p;
    const box = topModal().querySelector("[data-dg-list]");
    closeAll();
    hold2.go(); await pause(30);
    ok("a list that answers after its window was closed isn't drawn (it stays as it was)", /Loading…/.test(box.textContent));
    scripted = { action: "listDigitizingJobs", gate: hold2.p, status: 500, body: { status: "error", message: "Late failure" } };
    const p2 = w.showOrderDigitizing_("acme", "O-1"); await p2;
    const box2 = topModal().querySelector("[data-dg-list]");
    closeAll(); await pause(30);
    ok("…and neither is a late failure", /Loading…/.test(box2.textContent));
    ok("wiring an element with no section in it does nothing, and none at all is no error", (await w.wireDigitizingSection_(d.createElement("div"), {})) === undefined && (await w.wireDigitizingSection_(null, {})) === undefined);
    ok("the section's markup carries its own root, list and (for editors) the new button; a missing ctx is read-only", /data-dg-root/.test(w.digitizingSectionHtml_({ canEdit: true })) && /data-dg-new/.test(w.digitizingSectionHtml_({ canEdit: true })) && !/data-dg-new/.test(w.digitizingSectionHtml_()) && !/data-dg-new/.test(w.digitizingSectionHtml_({ canEdit: false })));
  }

  console.log("\n=== Change a record ===");
  {
    D._raw.run("DELETE FROM digitizing_jobs; DELETE FROM expenses");
    const plain = await seed({ name: "Plain logo", vendor: "Example Digitizing Co", sentAt: "2026-02-01", returnedAt: "2026-02-03", costCents: 1500, note: "First note", itemId });
    D._raw.run("UPDATE digitizing_jobs SET designId = 31 WHERE id = ?", [plain]);
    const stale = await seed({ name: "Old vendor job", vendor: "Other Supplier", sentAt: "2026-01-15" });
    D._raw.run("UPDATE digitizing_jobs SET vendor = 'Former Digitizer Ltd' WHERE id = ?", [stale]);
    const booked = await seed({ name: "Booked logo", vendor: "Sample Stitch Works", sentAt: "2026-01-10", returnedAt: "2026-01-11", costCents: 4000, recordExpense: true });
    const changeBtn = (name) => rowsOf().find(r => r.children[0].textContent.startsWith(name)).querySelector("[data-dg-edit]");
    asRole("admin");
    await openOrder("O-1");
    changeBtn("Plain logo").click();
    await wait(formOpen);
    ok("Change opens “Change digitizing record” with the record's fields filled in: name, vendor chosen, dates, cost as dollars, note, the line", topModal().querySelector("[data-dialog-title]").textContent === "Change digitizing record" &&
      q("#dgName").value === "Plain logo" && q("#dgVendor").value === "Example Digitizing Co" && q("#dgSent").value === "2026-02-01" && q("#dgBack").value === "2026-02-03" && q("#dgCost").value === "15.00" && q("#dgNote").value === "First note" && q("#dgItem").value === String(itemId));
    ok("…the button says Save, and the expense tick is offered (no expense yet)", q("#dgSave").textContent === "Save" && !!q("#dgExpense") && q("#dgCost").disabled === false);
    reset();
    setVal("#dgName", "Plain logo v2"); setVal("#dgBack", "");
    await submitForm();
    ok("saving sends the id, the order, the blank return date as null, the cost, the design it was already for; the line stays", same(of("saveDigitizingJob")[0].job, { id: plain, orderId: "O-1", name: "Plain logo v2", vendor: "Example Digitizing Co", sentAt: "2026-02-01", returnedAt: null, costCents: 1500, note: "First note", itemId, designId: 31 }));
    await afterSave();
    ok("…the toast is “Digitizing record saved.” and the list shows the change (not back yet now)", lastToast().m === "Digitizing record saved." && /Plain logo v2/.test(listText()) && /Not back yet/.test(rowsOf().find(r => /Plain logo v2/.test(r.textContent)).textContent));
    changeBtn("Plain logo v2").click();
    await wait(formOpen);
    setVal("#dgCost", "20"); q("#dgExpense").checked = true; setVal("#dgBack", "2026-02-05");
    reset();
    await submitForm();
    await afterSave();
    ok("ticking the expense on a record that has none books it then: recordExpense sent, an expense for 20.00 dated when it came back", of("saveDigitizingJob")[0].job.recordExpense === true && of("saveDigitizingJob")[0].job.costCents === 2000 &&
      dq("SELECT * FROM expenses WHERE orderId = 'O-1' AND amountCents = 2000 AND expenseDate = '2026-02-05'").length === 1);
    changeBtn("Old vendor job").click();
    await wait(formOpen);
    ok("a record whose vendor has left the list opens with “Someone else…” chosen and the name in the box", q("#dgVendor").value === "__other__" && q("#dgVendorOtherWrap").hidden === false && q("#dgVendorOther").value === "Former Digitizer Ltd");
    closeAll();
    await openOrder("O-1");
    changeBtn("Booked logo").click();
    await wait(formOpen);
    ok("a record whose cost is booked as an expense: the cost can't be changed here (disabled), there is no tick, and it says where to change it", q("#dgCost").disabled === true && q("#dgCost").value === "40.00" && !q("#dgExpense") && /Its cost is booked as an expense; change the amount there\./.test(q("#dgForm").textContent));
    reset();
    setVal("#dgNote", "Changed note");
    await submitForm();
    await afterSave();
    const bj = of("saveDigitizingJob")[0].job;
    ok("…saving it sends the cost it has, its expenseId and no recordExpense; the booked expense isn't touched", bj.costCents === 4000 && Number.isInteger(bj.expenseId) && !("recordExpense" in bj) && bj.note === "Changed note" &&
      dq("SELECT count(*) n FROM expenses WHERE amountCents = 4000")[0].n === 1);
    closeAll();
    asRole("staff");
    await openOrder("O-1");
    changeBtn("Plain logo v2").click();
    await wait(formOpen);
    ok("Back office can change a record (no expense tick for it)", !!formOpen() && !q("#dgExpense") && q("#dgName").value === "Plain logo v2");
    closeAll();
  }

  console.log("\n=== Delete a record ===");
  {
    D._raw.run("DELETE FROM digitizing_jobs; DELETE FROM expenses");
    const a = await seed({ name: "Delete me", vendor: "", sentAt: "2026-02-01" });
    const b = await seed({ name: "Has expense", vendor: "Sample Stitch Works", sentAt: "2026-02-02", returnedAt: "2026-02-03", costCents: 900, recordExpense: true });
    const delBtn = (name) => rowsOf().find(r => r.children[0].textContent.startsWith(name)).querySelector("[data-dg-del]");
    asRole("manager");
    await openOrder("O-1");
    ok("the Delete button asks for Full on Outside digitizing: shown to a Manager, hidden (data-perm-off) for Back office", !delBtn("Delete me").hasAttribute("data-perm-off") && delBtn("Delete me").getAttribute("data-need") === "production.digitizing:full");
    closeAll();
    asRole("staff");
    await openOrder("O-1");
    ok("…Back office edits but can't delete: its Delete buttons are switched off", rowsOf().length === 2 && rowsOf().every(r => r.querySelector("[data-dg-del]").hasAttribute("data-perm-off")) && rowsOf().every(r => !r.querySelector("[data-dg-edit]").hasAttribute("data-perm-off")));
    closeAll();
    asRole("admin");
    await openOrder("O-1");
    reset();
    delBtn("Delete me").click();
    let info = await answerConfirm(false);
    ok("Delete asks first: “Delete the digitizing record “Delete me”?”, with what it does and a Delete button; Cancel sends nothing", info.okLabel === "Delete" && /^Delete the digitizing record “Delete me”\?/.test(info.message) && /It is removed from this list\./.test(info.message) && !/Its expense stays/.test(info.message) &&
      of("deleteDigitizingJob").length === 0 && rowsOf().length === 2);
    delBtn("Has expense").click();
    info = await answerConfirm(false);
    ok("a record with an expense says its expense stays, and to delete that in Expenses first", /Its expense stays: delete that in Expenses first\./.test(info.message) && /“Has expense”/.test(info.message));
    delBtn("Has expense").click();
    await answerConfirm(true);
    await wait(() => of("deleteDigitizingJob").length === 1); await pause(30);
    ok("confirming sends deleteDigitizingJob { id }; the server refuses (409): the toast is its sentence “Delete its expense first” as an error, and the record stays",
      same(of("deleteDigitizingJob")[0], { action: "deleteDigitizingJob", id: b, key: "cookie" }) && lastToast().m === "Delete its expense first" && lastToast().err === true && rowsOf().length === 2);
    reset();
    delBtn("Delete me").click();
    await answerConfirm(true);
    await wait(() => rowsOf().length === 1);
    ok("deleting one with no expense: the toast “Digitizing record deleted.”, the list is asked for again and shows one record", lastToast().m === "Digitizing record deleted." && lastToast().err === false && of("listDigitizingJobs").length === 1 && rowsOf().length === 1 && dq("SELECT deletedAt FROM digitizing_jobs WHERE id = ?", a)[0].deletedAt !== null);
    D._raw.run("UPDATE expenses SET deletedAt = 'x'");
    reset();
    delBtn("Has expense").click();
    await answerConfirm(true);
    await wait(() => rowsOf().length === 0);
    ok("once its expense is deleted, the record can be deleted from here", rowsOf().length === 0 && /Nothing has been sent/.test(listText()));
    closeAll();
  }

  console.log("\n=== A saved quote's own section (admin-quotes.js) ===");
  {
    const cust = (await call({ action: "saveCustomer", name: "Dee Quoted", company: "Example Boosters", email: "dee@example.com", phone: "555-0102", address: null, notes: "", taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" }, "admin")).body.id;
    const qid = (await call({ action: "createEstimate", org: "acme", customerId: cust, title: "Club shirts" }, "admin")).body.id;
    const qid2 = (await call({ action: "createEstimate", org: "acme", customerId: cust, title: "Booster hats" }, "admin")).body.id;
    D._raw.run("DELETE FROM digitizing_jobs; DELETE FROM expenses");
    await call({ action: "saveDigitizingJob", job: { estimateId: qid, name: "Quote logo", vendor: "Example Digitizing Co", sentAt: "2026-02-01", costCents: 5000 } }, "admin");
    await call({ action: "saveDigitizingJob", job: { estimateId: qid2, name: "Other quote's logo", sentAt: "2026-02-02" } }, "admin");
    const drawn = () => !!q("#qtDigitizing [data-dg-root]") && listLoaded();
    const go = async (id, cond) => { const old = q("#qtPage"); if (w.location.hash === "#quotes/" + id) w.adminRoute(); else w.location.hash = "#quotes/" + id; return wait(() => q("#qtPage") && q("#qtPage") !== old && cond(), 800); };
    asRole("admin");
    reset();
    await go(qid, drawn);
    ok("a saved quote shows “Outside digitizing” under its fee lines, with its own records (asked by estimateId, not by order)", !!q("#qtDigitizing [data-dg-root]") && same(of("listDigitizingJobs").map(b => ({ orderId: b.orderId, estimateId: b.estimateId })), [{ estimateId: qid }]) &&
      rowsOf().length === 1 && rowsOf()[0].children[0].textContent.startsWith("Quote logo") && rowsOf()[0].children[3].textContent === "$50.00");
    ok("…and not the other quote's", !/Other quote's logo/.test(listText()));
    q("#qtDigitizing [data-dg-new]").click();
    await wait(formOpen);
    ok("Send to digitizer on a quote has no line to pick, and the admin may book the expense", !!formOpen() && !q("#dgItem") && !!q("#dgExpense"));
    reset();
    setVal("#dgName", "Back logo"); setVal("#dgSent", "2026-02-10"); setVal("#dgCost", "7.25");
    await submitForm();
    await wait(() => !formOpen() && rowsOf().length === 2);
    ok("…it saves for the quote: estimateId in the job and no orderId; the list shows both records and their total", same(of("saveDigitizingJob")[0].job, { estimateId: qid, name: "Back logo", vendor: "Brand New Digitizer", sentAt: "2026-02-10", returnedAt: null, costCents: 725, note: "" }) &&
      /Total cost: \$57\.25/.test(listText()) && dq("SELECT estimateId, orderId FROM digitizing_jobs WHERE name = 'Back logo'")[0].estimateId === qid && dq("SELECT orderId FROM digitizing_jobs WHERE name = 'Back logo'")[0].orderId === "");
    asRole("staff");
    reset();
    await go(qid2, () => !!q("#qtDigitizing [data-dg-root]") && listLoaded() && /Other quote/.test(listText()));
    ok("Back office sees it with the button and no expense tick; the section shows the quote it was opened on", /Other quote's logo/.test(listText()) && !!q("#qtDigitizing [data-dg-new]"));
    q("#qtDigitizing [data-dg-new]").click(); await wait(formOpen);
    ok("…its form has no expense tick (no Expenses edit)", !!formOpen() && !q("#dgExpense"));
    closeAll();
    signInWith(withLevels("admin", { "production.digitizing": "read", "quotes.estimates": "read" }), "manager");
    reset();
    await go(qid, () => !!q("#qtDigitizing [data-dg-root]") && listLoaded());
    ok("a role that only reads Outside digitizing sees the quote's records without the Send to digitizer… button or Change / Delete", rowsOf().length === 2 && !q("#qtDigitizing [data-dg-new]") && !q("#qtDigitizing [data-dg-edit]") && !q("#qtDigitizing [data-dg-del]"));
    signInWith(withLevels("admin", { "production.digitizing": "none" }), "admin");
    reset();
    await go(qid2, () => !!q("#qtForm"));
    await pause(200);
    ok("a role with no access to Outside digitizing gets no section and no request for the records", !q("#qtDigitizing [data-dg-root]") && !!q("#qtDigitizing") && of("listDigitizingJobs").length === 0);
    asRole("admin");
  }

})().catch((e) => { console.error(e); process.exitCode = 1; });
