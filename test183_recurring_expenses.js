const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { autoConfirm } = require("./testlib/confirm.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// Recurring expenses (migrations/0085) — the occurrence dates, recording once-only from the daily run and the Expenses
// screen, editing (future only), stopping and deleting, the refusals, the vendor list and categories, the roll-up and
// Communications, and the Expenses screen in jsdom on the real API.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { recurringOccurrenceDate, recurringIndexAfter, recurringDueDates, recordDueRecurringExpenses,
  saveRecurringExpense, getRecurringExpense, getSystemIssues, insertOrder, localToday };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const checkShippedDeliveries = async () => ({ inTransit: [], delivered: [], pickedUp: [], awaitingPickup: [] });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const digest = new Function(strip(read("functions/_lib/http.js")) + "\n" +
  "function timingSafeEqual(a, b){ return typeof a === 'string' && a === b; }\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" + strip(read("functions/api/daily-digest.js")) + "\nreturn onRequestPost;")();

const occ = (frequency, startDate, i) => lib.recurringOccurrenceDate({ frequency, startDate }, i);
const addDays = (ymd, n) => new Date(Date.parse(ymd + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
// Month arithmetic for the test's own dates (forwards and backwards), the 1st of a month only.
const addMonths = (ymd, n) => { const [y, m] = ymd.split("-").map(Number); const t = (m - 1) + n; return `${y + Math.floor(t / 12)}-${String(((t % 12) + 12) % 12 + 1).padStart(2, "0")}-${ymd.slice(8, 10)}`; };

(async () => {
  console.log("=== Occurrence dates ===");
  console.log("weekly / every 2 weeks step 7 / 14 days, across a month and a year end:",
    occ("weekly", "2026-12-29", 1) === "2027-01-05" && occ("biweekly", "2026-12-20", 1) === "2027-01-03" && occ("biweekly", "2026-01-30", 2) === "2026-02-27");
  console.log("the 31st clamps to a shorter month's end and comes back (Jan 31 → Feb 28 → Mar 31 → Apr 30):",
    occ("monthly", "2027-01-31", 1) === "2027-02-28" && occ("monthly", "2027-01-31", 2) === "2027-03-31" && occ("monthly", "2027-01-31", 3) === "2027-04-30");
  console.log("leap year: Feb 29 in 2028, and a yearly Feb 29 falls on Feb 28 in other years:",
    occ("monthly", "2028-01-31", 1) === "2028-02-29" && occ("yearly", "2028-02-29", 1) === "2029-02-28" && occ("yearly", "2028-02-29", 4) === "2032-02-29");
  console.log("every 3 / 6 months and yearly:", occ("quarterly", "2026-11-15", 1) === "2027-02-15" && occ("quarterly", "2026-11-30", 1) === "2027-02-28" &&
    occ("semiannual", "2026-08-31", 1) === "2027-02-28" && occ("yearly", "2026-11-05", 2) === "2028-11-05");
  console.log("unknown frequency or bad date → no date:", occ("daily", "2026-01-01", 1) === "" && occ("monthly", "nope", 1) === "");
  console.log("the next occurrence after a recorded date:", lib.recurringIndexAfter({ frequency: "monthly", startDate: "2026-01-15" }, "2026-03-15") === 3 &&
    lib.recurringIndexAfter({ frequency: "quarterly", startDate: "2026-01-15" }, "2026-03-15") === 1 && lib.recurringIndexAfter({ frequency: "monthly", startDate: "2026-01-15" }, "") === 0);
  console.log("due dates stop at today and at the end date:",
    JSON.stringify(lib.recurringDueDates({ frequency: "weekly", startDate: "2026-03-01", nextIndex: 0 }, "2026-03-20")) === JSON.stringify(["2026-03-01", "2026-03-08", "2026-03-15"]) &&
    JSON.stringify(lib.recurringDueDates({ frequency: "weekly", startDate: "2026-03-01", nextIndex: 1, endDate: "2026-03-10" }, "2026-03-20")) === JSON.stringify(["2026-03-08"]));

  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Acme','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  require("./testlib/vendors.js").seedVendors(d1);
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const q = (sql, ...p) => d1.q(sql, ...p);
  const today = await lib.localToday({ DB: d1 });
  const firstOfMonth = today.slice(0, 8) + "01";
  const software = 3, supplies = 2, card = 2;
  const depreciation = q("SELECT id FROM expense_categories WHERE deductionType='depreciation' LIMIT 1")[0].id;
  const base = { description: "Design software", categoryId: software, amount: 29.99, vendor: "Adobe", accountId: card, frequency: "monthly" };

  console.log("\n=== Saving a rule records what's already due ===");
  let r = await call({ action: "saveRecurringExpense", recurring: { ...base, startDate: addMonths(firstOfMonth, -3) } });
  const ruleA = r.body.recurring;
  console.log("a first date three months back records four (one a month up to this month's 1st):",
    r.status === 200 && r.body.recorded.length === 4 && q("SELECT count(*) n FROM expenses WHERE recurringId = ?", ruleA.id)[0].n === 4);
  console.log("…each an ordinary expense: amount, category, vendor, paid from, tagged with the rule:",
    q("SELECT count(*) n FROM expenses WHERE recurringId = ? AND amountCents = 2999 AND categoryId = ? AND vendor = 'Adobe' AND accountId = ? AND deletedAt IS NULL", ruleA.id, software, card)[0].n === 4);
  console.log("dated on each occurrence; next is next month's 1st:",
    JSON.stringify(q("SELECT expenseDate FROM expenses WHERE recurringId = ? ORDER BY expenseDate", ruleA.id).map(x => x.expenseDate)) ===
      JSON.stringify([-3, -2, -1, 0].map(n => addMonths(firstOfMonth, n))) && r.body.nextDate === addMonths(firstOfMonth, 1) && ruleA.recordedCount === 4);
  console.log("audited: the rule and each expense:", q("SELECT count(*) n FROM audit_log WHERE action = 'recurring_expense.created'")[0].n === 1 &&
    q("SELECT count(*) n FROM audit_log WHERE action = 'expense.created' AND detail LIKE '%recurringId%'")[0].n === 4);
  r = await call({ action: "listExpenses", dateFrom: addMonths(firstOfMonth, -12), dateTo: today });
  console.log("listExpenses returns the rules and each recorded expense says its rule:", r.body.recurring.length === 1 && r.body.recurring[0].nextDate === addMonths(firstOfMonth, 1) &&
    r.body.expenses.filter(x => x.recurringId === ruleA.id).length === 4 && r.body.frequencies.quarterly === "Every 3 months");

  r = await call({ action: "saveRecurringExpense", recurring: { ...base, description: "Phone", frequency: "weekly", startDate: addDays(today, 10) } });
  const ruleF = r.body.recurring;
  console.log("a first date ahead records nothing yet:", r.status === 200 && r.body.recorded.length === 0 && r.body.nextDate === addDays(today, 10));
  const fut = await lib.recordDueRecurringExpenses(d1, addDays(today, 24), { ids: [ruleF.id] });
  console.log("…until its dates come (two weeks later: three):", fut.recorded.length === 3);

  console.log("\n=== Once only ===");
  r = await lib.recordDueRecurringExpenses(d1, today);
  console.log("running again records nothing new:", r.recorded.length === 0 && q("SELECT count(*) n FROM expenses WHERE recurringId = ?", ruleA.id)[0].n === 4);
  const firstA = q("SELECT id FROM expenses WHERE recurringId = ? ORDER BY expenseDate LIMIT 1", ruleA.id)[0].id;
  await call({ action: "deleteExpense", expenseId: firstA });
  d1._raw.run("UPDATE recurring_expenses SET nextIndex = 0 WHERE id = ?", [ruleA.id]);   // as if a second run read the rule before the first moved it on
  r = await lib.recordDueRecurringExpenses(d1, today);
  console.log("a run that starts from the beginning again adds no duplicates, and a deleted one isn't brought back:",
    r.recorded.length === 0 && q("SELECT count(*) n FROM expenses WHERE recurringId = ?", ruleA.id)[0].n === 4 &&
    q("SELECT deletedAt FROM expenses WHERE id = ?", firstA)[0].deletedAt !== null && q("SELECT nextIndex FROM recurring_expenses WHERE id = ?", ruleA.id)[0].nextIndex === 4);

  console.log("\n=== Editing changes only what's still to come ===");
  r = await call({ action: "saveRecurringExpense", recurring: { ...base, id: ruleA.id, amount: 34.99, startDate: ruleA.startDate } });
  console.log("new amount saved; recorded ones keep $29.99:", r.status === 200 && r.body.recurring.amount === 34.99 &&
    q("SELECT count(*) n FROM expenses WHERE recurringId = ? AND amountCents = 2999", ruleA.id)[0].n === 4 && r.body.recorded.length === 0);
  r = await lib.recordDueRecurringExpenses(d1, addMonths(firstOfMonth, 1), { ids: [ruleA.id] });
  console.log("the next one is recorded at the new amount:", r.recorded.length === 1 && r.recorded[0].amount === 34.99);
  d1._raw.run("DELETE FROM expenses WHERE id = ?", [r.recorded[0].id]); d1._raw.run("UPDATE recurring_expenses SET nextIndex = 4 WHERE id = ?", [ruleA.id]);
  r = await call({ action: "saveRecurringExpense", recurring: { ...base, id: ruleA.id, amount: 34.99, frequency: "quarterly", startDate: ruleA.startDate } });
  console.log("every 3 months from the same first date → next is three months after this month's:", r.status === 200 && r.body.nextDate === addMonths(firstOfMonth, 3));
  r = await call({ action: "saveRecurringExpense", recurring: { ...base, id: ruleA.id, startDate: addMonths(firstOfMonth, -2) } });
  console.log("the first date can't change once something is recorded:", r.status === 400 && /first date can't change/.test(r.body.message));

  console.log("\n=== Refusals ===");
  const refuse = async (extra, re, status = 400) => { const x = await call({ action: "saveRecurringExpense", recurring: { ...base, startDate: today, ...extra } }); return x.status === status && re.test(x.body.message); };
  console.log("no frequency / an unknown one:", await refuse({ frequency: "" }, /how often/) && await refuse({ frequency: "daily" }, /how often/));
  console.log("an end date before the first date:", await refuse({ endDate: addDays(today, -1) }, /end date/));
  console.log("a first date more than a year ahead:", await refuse({ startDate: addDays(today, 400) }, /year/));
  console.log("a Depreciation category:", await refuse({ categoryId: depreciation }, /Capital equipment/));
  console.log("a refund:", await refuse({ refund: true }, /refund/));
  console.log("no amount / no description / no account:", await refuse({ amount: 0 }, /Amount/) && await refuse({ description: " " }, /Description/) && await refuse({ accountId: 0 }, /account/));
  console.log("a vendor that isn't on the vendor list:", await refuse({ vendor: "Nobody Inc" }, /list/));
  const lastMonth = addMonths(firstOfMonth, -1).slice(0, 7);
  await call({ action: "closePeriod", month: lastMonth });
  console.log("a first date that would record into a closed month:", await refuse({ startDate: lastMonth + "-10" }, /closed/, 409) &&
    q("SELECT count(*) n FROM recurring_expenses WHERE startDate = ?", lastMonth + "-10")[0].n === 0);
  await call({ action: "reopenPeriod", month: lastMonth });

  console.log("\n=== Vendors and categories ===");
  const adobe = q("SELECT id FROM vendors WHERE name = 'Adobe'")[0].id;
  r = await call({ action: "saveVendor", vendor: { id: adobe, name: "Adobe Systems" } });
  console.log("renaming a vendor renames it on the rules too:", r.status === 200 && q("SELECT count(*) n FROM recurring_expenses WHERE vendor = 'Adobe Systems'")[0].n === 2);
  r = await call({ action: "saveRecurringExpense", recurring: { ...base, vendor: "adobe systems", startDate: addDays(today, 5) } });
  console.log("a vendor gets the list's spelling:", r.status === 200 && r.body.recurring.vendor === "Adobe Systems");
  r = await call({ action: "saveExpenseCategory", category: { name: "Web hosting", deductionType: "deductible", scheduleCLine: "18" } });
  const hosting = r.body.id;
  await call({ action: "saveRecurringExpense", recurring: { ...base, description: "Hosting", categoryId: hosting, startDate: addDays(today, 3) } });
  r = await call({ action: "deleteExpenseCategory", categoryId: hosting });
  console.log("a category a rule uses can't be deleted:", r.status === 400 && /recurring/.test(r.body.message));

  console.log("\n=== Stop and delete ===");
  r = await call({ action: "stopRecurringExpense", id: ruleF.id });
  const stopped = (r.body.recurring || []).find(x => x.id === ruleF.id);
  console.log("Stop ends it today and keeps it (and what it recorded):", r.status === 200 && stopped && stopped.endDate === today && stopped.ended &&
    q("SELECT count(*) n FROM expenses WHERE recurringId = ? AND deletedAt IS NULL", ruleF.id)[0].n === 3);
  r = await lib.recordDueRecurringExpenses(d1, addDays(today, 60), { ids: [ruleF.id] });
  console.log("…nothing more is recorded after it:", r.recorded.length === 0);
  r = await call({ action: "deleteRecurringExpense", id: ruleF.id });
  console.log("Delete takes the rule off the list; its expenses stay:", r.status === 200 && !(r.body.recurring || []).some(x => x.id === ruleF.id) &&
    q("SELECT count(*) n FROM expenses WHERE recurringId = ? AND deletedAt IS NULL", ruleF.id)[0].n === 3);
  console.log("stop / delete audited:", q("SELECT count(*) n FROM audit_log WHERE action IN ('recurring_expense.stopped', 'recurring_expense.deleted')")[0].n === 2);

  console.log("\n=== An account made inactive ===");
  const saved = await call({ action: "saveRecurringExpense", recurring: { ...base, description: "Insurance", accountId: 4, startDate: addDays(today, 2) } });
  d1._raw.run("UPDATE accounts SET active = 0 WHERE id = 4");
  r = await lib.recordDueRecurringExpenses(d1, addDays(today, 2));
  console.log("its occurrence is skipped (with the reason) and stays due:", r.skipped.some(x => x.ruleId === saved.body.recurring.id && /no longer active/.test(x.reason)) &&
    !r.recorded.some(x => x.ruleId === saved.body.recurring.id) && q("SELECT nextIndex FROM recurring_expenses WHERE id = ?", saved.body.recurring.id)[0].nextIndex === 0);
  d1._raw.run("UPDATE accounts SET active = 1 WHERE id = 4");
  r = await lib.recordDueRecurringExpenses(d1, addDays(today, 2));
  console.log("…and recorded once the account is active again:", r.recorded.some(x => x.ruleId === saved.body.recurring.id));

  console.log("\n=== Roles ===");
  const ordersSrc = read("functions/api/orders.js");
  const mgr = ordersSrc.slice(ordersSrc.indexOf("const MANAGER_ACTIONS"), ordersSrc.indexOf("const STAFF_ACTIONS"));
  console.log("the four actions are a manager's (like the rest of the books):",
    ["listRecurringExpenses", "saveRecurringExpense", "stopRecurringExpense", "deleteRecurringExpense"].every(a => mgr.includes(`"${a}"`)));

  console.log("\n=== The roll-up and Communications ===");
  const d2 = await createD1();
  d2._raw.exec(read("testlib/schema-pre-0006.sql"));
  d2._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Acme','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d2.execFile(read("migrations/" + f));
  require("./testlib/vendors.js").seedVendors(d2);
  await lib.saveRecurringExpense(d2, 0, { description: "Internet", categoryId: software, amount: 65, vendor: "Verizon", accountId: card, businessUsePct: 100,
    frequency: "monthly", startDate: today });
  await lib.saveRecurringExpense(d2, 0, { description: "Storage unit", categoryId: supplies, amount: 80, accountId: 4, businessUsePct: 100, frequency: "monthly", startDate: today });
  d2._raw.run("UPDATE accounts SET active = 0 WHERE id = 4");
  await lib.insertOrder(d2, { orderId: "A-1", orgId: "acme", customerName: "Alex Sample", contact: "alex@example.com", paymentMethod: "Venmo", placedAt: new Date().toISOString() },
    [{ productId: "", name: "Tee", type: "shirt", size: "L", qty: 1, unitPrice: 20 }]);
  const emails = [];
  global.fetch = async (url, init) => captureMail(url, init, emails) ? MAIL_OK : { ok: true, json: async () => ({}) };
  const res = await digest({ env: { DB: d2, CRON_SECRET: "cron-key", ...MAIL_ENV }, request: { json: async () => ({ key: "cron-key" }), headers: { get: () => null } } });
  const e = emails[0] || { htmlBody: "", body: "" };
  console.log("the roll-up records what's due first:", res.status === 200 && d2.q("SELECT count(*) n FROM expenses WHERE description = 'Internet' AND expenseDate = ?", today)[0].n === 1);
  console.log("…and lists it under 🔁 Recurring expenses recorded (HTML and text):", /🔁 Recurring expenses recorded — 1/.test(e.htmlBody) && /Internet — \$65\.00 \(Monthly, Credit card\)/.test(e.htmlBody) &&
    /RECURRING EXPENSES RECORDED — 1/.test(e.body));
  console.log("a rule it couldn't record is a problem in that roll-up:", /Recurring expenses that couldn't be recorded/.test(e.htmlBody) && /Storage unit/.test(e.htmlBody));
  console.log("the heartbeat email lists them too:", /recurringRecorded/.test(read("functions/_lib/email.js").slice(read("functions/_lib/email.js").indexOf("export async function sendDigestHeartbeatEmail"), read("functions/_lib/email.js").indexOf("export async function sendDailyDigestEmail"))));
  d1._raw.run("DELETE FROM global_settings WHERE key = 'dailyDigest'");
  r = await call({ action: "getPendingCommunications" });
  console.log("Communications lists the ones recorded since the last roll-up:", r.status === 200 && Array.isArray(r.body.recurringRecorded) &&
    r.body.recurringRecorded.some(x => x.description === "Design software" && x.frequency === "Every 3 months" && x.paidFrom === "Credit card"));

  console.log("\n=== The Expenses screen (jsdom) ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
      sent.push(b);
      const x = await call(b);
      return { ok: x.status < 400, status: x.status, json: async () => x.body }; }; } });
  const w = dom.window, doc = w.document;
  w.HTMLElement.prototype.scrollIntoView = function () {};   // jsdom has no layout
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"');
  autoConfirm(w, () => true);
  const wait = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return fn(); };
  await w.renderExpenses(doc.getElementById("app"));
  const shown = (id) => doc.getElementById(id).style.display !== "none";
  console.log("Repeats starts at Doesn't repeat: no Ends box, receipt and refund shown:", doc.getElementById("expRepeat").value === "" && !shown("expEndsWrap") && shown("expReceiptWrap") && shown("expRefundWrap"));
  doc.getElementById("expRepeat").value = "biweekly";
  doc.getElementById("expRepeat").dispatchEvent(new w.Event("change"));
  console.log("repeating: Ends appears, receipt and refund go, the date is the First date and may be ahead:",
    shown("expEndsWrap") && !shown("expReceiptWrap") && !shown("expRefundWrap") && doc.getElementById("expDateLbl").textContent === "First date" && doc.getElementById("expDate").max > today);
  doc.getElementById("expDate").value = addDays(today, -14);
  doc.getElementById("expDesc").value = "Cleaning service";
  doc.getElementById("expCat").value = String(supplies); doc.getElementById("expCat").dispatchEvent(new w.Event("change"));
  doc.getElementById("expAmount").value = "45";
  doc.getElementById("expPaidFrom").value = String(card);
  doc.getElementById("expEnds").value = addDays(today, 60);
  doc.getElementById("expSave").click();
  await wait(() => doc.querySelector('#expRecurring tr[data-recurring-row]') && [...doc.querySelectorAll("#expRecurring tr")].some(tr => /Cleaning service/.test(tr.textContent)));
  const sv = sent.find(b => b.action === "saveRecurringExpense");
  console.log("Save sends saveRecurringExpense with the frequency, dates and account:", !!sv && sv.recurring.frequency === "biweekly" && sv.recurring.startDate === addDays(today, -14) &&
    sv.recurring.endDate === addDays(today, 60) && sv.recurring.accountId === card && sv.recurring.amount === 45 && !sent.some(b => b.action === "saveExpense"));
  const row = [...doc.querySelectorAll("#expRecurring tr[data-recurring-row]")].find(tr => /Cleaning service/.test(tr.textContent));
  console.log("the Recurring section lists it: Every 2 weeks, 2 recorded, next date:", !!row && /Every 2 weeks/.test(row.textContent) && /2 · \$90\.00/.test(row.textContent));
  console.log("the form went back to a single expense:", doc.getElementById("expRepeat").value === "" && shown("expReceiptWrap"));
  await wait(() => doc.querySelector('#expList [title*="Recorded automatically"]'));
  console.log("recorded expenses carry the 🔁 RECURRING tag in the list:", [...doc.querySelectorAll("#expList tr[data-expense-row]")].filter(tr => /RECURRING/.test(tr.textContent) && /Cleaning service/.test(tr.textContent)).length === 2);
  const exRow = [...doc.querySelectorAll("#expList tr[data-expense-row]")].find(tr => /Cleaning service/.test(tr.textContent));
  exRow.querySelector('button[onclick^="expEdit_"]').click();
  console.log("editing one recorded expense hides Repeats (it changes only that expense):", !shown("expRepeatRow"));
  doc.getElementById("expCancel").click();
  const ruleId = Number(row.dataset.recurringRow);
  row.querySelector('button[onclick^="expEditRecurring_"]').click();
  const modal = await wait(() => doc.querySelector("#erAmount") && doc.querySelector("#erAmount").closest(".admin-modal, div"));
  console.log("Edit… opens a window with the first date locked (something's recorded):", !!modal && doc.querySelector("#erStart").disabled && doc.querySelector("#erFreq").value === "biweekly");
  doc.querySelector("#erAmount").value = "50";
  doc.querySelector("#erSave").click();
  await wait(() => sent.some(b => b.action === "saveRecurringExpense" && b.recurring.id === ruleId));
  await wait(() => !doc.querySelector("#erSave"));
  console.log("saved for the future only:", q("SELECT amountCents FROM recurring_expenses WHERE id = ?", ruleId)[0].amountCents === 5000 &&
    q("SELECT count(*) n FROM expenses WHERE recurringId = ? AND amountCents = 4500", ruleId)[0].n === 2);
  await wait(() => doc.querySelector(`#expRecurring tr[data-recurring-row="${ruleId}"] button[onclick^="expStopRecurring_"]`));
  doc.querySelector(`#expRecurring tr[data-recurring-row="${ruleId}"] button[onclick^="expStopRecurring_"]`).click();
  await wait(() => sent.some(b => b.action === "stopRecurringExpense" && b.id === ruleId));
  await wait(() => /Ended/.test((doc.querySelector(`#expRecurring tr[data-recurring-row="${ruleId}"]`) || {}).textContent || ""));
  console.log("Stop (after asking) → the row says Ended and has no Stop button:", /Ended/.test(doc.querySelector(`#expRecurring tr[data-recurring-row="${ruleId}"]`).textContent) &&
    !doc.querySelector(`#expRecurring tr[data-recurring-row="${ruleId}"] button[onclick^="expStopRecurring_"]`));
  doc.querySelector(`#expRecurring tr[data-recurring-row="${ruleId}"] button[onclick^="expDeleteRecurring_"]`).click();
  await wait(() => !doc.querySelector(`#expRecurring tr[data-recurring-row="${ruleId}"]`));
  console.log("Delete → off the list; the recorded expenses stay:", !doc.querySelector(`#expRecurring tr[data-recurring-row="${ruleId}"]`) &&
    q("SELECT count(*) n FROM expenses WHERE recurringId = ? AND deletedAt IS NULL", ruleId)[0].n === 2);
  const html = doc.getElementById("expRecurring").innerHTML;
  await call({ action: "saveRecurringExpense", recurring: { ...base, description: "<b>x</b>", vendor: "", startDate: addDays(today, 30) } });
  await w.expLoad_();
  console.log("descriptions are escaped in the section:", !doc.querySelector("#expRecurring b") && /&lt;b&gt;x/.test(doc.getElementById("expRecurring").innerHTML) && !!html);
})().catch(e => { console.log("test164 crashed:", false); console.error(e); process.exit(1); });
