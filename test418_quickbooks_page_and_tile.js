process.env.TZ = "UTC";
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { shopOrigin } = require("./testlib/hosts.js");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Phase 8 on the admin pages and the shop page, in jsdom, on the real orders.js / db.js / quickbooks.js (sql.js):
//   Reports → QuickBooks export (public/admin-quickbooks.js renderQuickBooks): the dates and their presets (This month,
//   Last month, This quarter, Last year), the format choice (QuickBooks Online / Desktop) and its how-to, remembered in the
//   settings; the parts ticks; the summary (summaryOnly — nothing in the audit log); Download (one file per part / bank
//   account for Online, one .iif for Desktop) saved with Blob downloads and "Save again"; the Account mapping (every
//   account, every bank and card account, every expense category, Sales go in as, Customer name, Save, its refusals);
//   read-only for Back office; errors, a late answer, escaping, and a server that sends no accounts with the settings.
//   Global settings → Gift cards: the "Customers can buy gift cards on the shop" tick needs card payments (cardReady):
//   disabled, unticked and explained when not ready, sending sellOnline false; usable with its small note when ready; the
//   server refusing it when the same Save switches Card off.
//   The shop page (public/storefront.js): the "Gift card" tile, first in the products — its price range, opening the buy
//   form, never in the cart or the product count, its own section when the shop has category sections, hidden when the
//   shop doesn't sell gift cards online and in a preview.
// Invented shops, people and names only. "Today" is fixed at 2026-12-15 on the page; the business is in America/Chicago and
// the two seeded sales sit at the edges of its days, so nothing depends on this machine's date or time zone.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
globalThis.__f418 = {};
globalThis.__role418 = "admin";
globalThis.__stripe418 = "";
const libs = strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n";
const L = new Function(libs +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role418] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role418" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club', school: 'school' }, orgs: {}, features: globalThis.__f418 });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false, sendGiftCardEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const setMarketingChoice = async () => ({});\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/quickbooks.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost };")();
// The shop's catalog: the real catalogCache.js and catalog.js (the Cache API is a Map).
const C = new Function(libs + strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/catalogCache.js")) + "\n" +
  "const catalogApi = (function(){\n" + strip(read("functions/api/catalog.js")) + "\nreturn { onRequestGet }; })();\n" +
  "return { catalogGet: catalogApi.onRequestGet, publishShop, _resetCatalogCacheState };")();
function freshCacheApi() {
  const store = new Map();
  global.caches = { default: {
    async match(key) { const hit = store.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { store.set(typeof key === "string" ? key : key.url, response); },
  } };
  C._resetCatalogCacheState();
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });
const TODAY = "2026-12-15";

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const waits = [];
    const res = await L.post({ env: { DB: d1, DESIGNS: {}, STRIPE_SECRET_KEY: globalThis.__stripe418 }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const must = async (body) => { const r = await call(body); if (r.status !== 200) throw new Error("seed " + body.action + ": " + JSON.stringify(r.body)); return r.body; };
  const audits = (action) => d1.q("SELECT count(*) AS n FROM audit_log WHERE action = ?", action)[0].n;
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, "desc", accent, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','Gear for the club.','#123456','t','t',1), ('school','school','Example School Shop','Gear for the school.','#654321','t','t',1);
    INSERT INTO global_settings (key, value) VALUES ('locale', '{"timeZone":"America/Chicago","country":"US"}');
    INSERT INTO accounts (id, name, type, active, createdAt, updatedAt) VALUES (6, 'Old <b>Savings</b> "A&B"', 'other', 0, 't', 't');
    INSERT INTO expense_categories (id, name, deductionType, createdAt, updatedAt) VALUES (90, 'Thread <i>&</i> "floss"', 'deductible', 't', 't');`);
  await must({ action: "createProduct", org: "club", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  await must({ action: "createProduct", org: "school", productId: "tee", type: "shirt", name: "School Tee", pricingMode: "flat", flatPrice: 20, visible: true, weightOz: 6, noDesignNeeded: true });
  await must({ action: "createProduct", org: "school", productId: "cap", type: "cap", name: "School Cap", pricingMode: "flat", flatPrice: 15, visible: true, weightOz: 4, noDesignNeeded: true });
  // Two cash sales, each moved to the edge of a business day in Chicago: 23:30 on Oct 31 and 23:30 on Nov 30.
  let seq = 0;
  const sale = async (atIso) => {
    const oid = (await must({ action: "createLocalSale", org: "club", requestId: "seed418-" + (++seq) + "-abcdef", customerName: "Pat Example", paymentMethod: "Cash", paid: true,
      items: [{ productId: "mug", size: "", qty: 2 }] })).orderId;
    // Its sale date (the default basis: when it was completed — picked up at the counter) and its order date.
    d1.q("UPDATE orders SET placedAt = ?, completedAt = ?, shippedAt = NULL, deliveredAt = NULL WHERE orderId = ?", atIso, atIso, oid);
    d1.q("UPDATE order_payments SET receivedAt = ? WHERE orderId = ?", atIso, oid);
    return oid;
  };
  await sale("2026-11-01T04:30:00.000Z");   // Oct 31, 23:30 in Chicago
  await sale("2026-12-01T05:30:00.000Z");   // Nov 30, 23:30 in Chicago
  d1._raw.exec(`INSERT INTO expenses (expenseDate, description, categoryId, amountCents, vendor, accountId, createdAt, updatedAt) VALUES ('2026-11-12', 'Thread', 90, 4250, 'Example Supply', 1, 't', 't');`);

  // ---- The admin page ---------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), qbJs = read("public/admin-quickbooks.js");
  const sent = [], toasts = [], served = [], blobs = [], saves = [];
  let scripted = [];       // [{ action, status, body | throws | empty, gate }]: the next request for that action is answered with this
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      served.push(String(url));
      const name = (String(url).match(/\/([\w-]+\.js)(\?|$)/) || [])[1];
      if (name === "admin-quickbooks.js") return Promise.resolve(Buffer.from(qbJs));
      if (name === "admin.js") return Promise.resolve(Buffer.from(adminJs));
      return Promise.resolve(Buffer.from(""));
    }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented|Could not load script/.test(e.message)) console.error(e); });
  let inflight = 0;
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.scrollTo = () => {};
      win.URL.createObjectURL = (b) => { blobs.push(b); return "blob:file-" + blobs.length; };
      win.URL.revokeObjectURL = () => {};
      win.HTMLAnchorElement.prototype.click = function () { saves.push({ name: this.download, href: this.href, inPage: this.isConnected, at: Date.now() }); };
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(JSON.parse(JSON.stringify(b))); inflight++;
        try {
          const i = scripted.findIndex(s => s.action === b.action);
          if (i >= 0) { const s = scripted.splice(i, 1)[0]; if (s.gate) await s.gate; if (s.empty) throw new Error(""); if (s.throws) throw new Error(s.throws); return reply(s.status || 200, s.body); }
          const x = await call(b);
          return reply(x.status, x.body);
        } finally { inflight--; }
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("America/Chicago");');
  w.eval(`localToday_ = function (off) { const t = "${TODAY}"; return off ? addDays_(t, off) : t; };`);
  w.eval("adminOrgs = " + JSON.stringify([{ orgId: "school", name: "Example School Shop" }, { orgId: "club", name: "Example Club" }]) + ";");
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const id = (s) => d.getElementById(s);
  const app = id("app");
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const of = (action) => sent.filter(b => b.action === action).map(b => { const c = Object.assign({}, b); delete c.key; return c; });
  const reset = () => { sent.length = 0; toasts.length = 0; };
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true }));
  const choose = (el, v) => { el.value = v; fire(el, "change"); };
  const tick = (el, v) => { el.checked = v; fire(el, "change"); };
  const asRoles = (pageRole, serverRole) => { globalThis.__role418 = serverRole || pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  const features = (f) => { globalThis.__f418 = Object.assign({}, f); w.applyFeatures_(Object.assign({}, f)); };
  const blobText = (b) => new Promise((res) => { const r = new w.FileReader(); r.onload = () => res(String(r.result)); r.readAsText(b); });
  const hashNow = () => w.location.hash.replace(/^#\/?/, "");
  asRoles("admin");
  features({});
  w.renderAdminNav();

  const page = () => id("qbPage");
  const open = async () => { reset(); w.location.hash = "#home"; await idle(); reset(); w.location.hash = "#quickbooks"; await wait(() => !!page() && !!q("#qbMap input, #qbMap .cust-err")); await idle(); };
  const summaryCell = (label) => qa("#qbSummary .gc-total").find(c => text(c.querySelector(".gc-total-l")) === label);
  const cellText = (label) => { const c = summaryCell(label); return c ? [...c.children].map(text).join(" ") : ""; };
  const asked = () => of("getQuickBooksExport");
  const summaryAsks = () => asked().filter(b => b.summaryOnly === true);
  const money = (c) => w.adminMoney_(c / 100);
  const serverSummary = async (from, to) => (await must({ action: "getQuickBooksExport", dateFrom: from, dateTo: to, summaryOnly: true })).summary;
  const accBox = (k) => q(`#qbMap input[data-qb-acc="${k}"]`);
  const bankBox = (k) => q(`#qbMap input[data-qb-bank="${k}"]`);
  const catBox = (k) => q(`#qbMap input[data-qb-cat="${k}"]`);
  const labelOf = (inp) => inp ? text(inp.closest("label").querySelector("span")) : "";
  const radio = (name, v) => q(`input[name="${name}"][value="${v}"]`);
  const submitMap = async () => { reset(); const f = id("qbMap"); f.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await pause(20); await idle(); };

  // ==============================================================================================================
  console.log("=== Reports → QuickBooks export: the page as an admin opens it ===");
  // ==============================================================================================================
  await open();
  ok("opening #quickbooks loads public/admin-quickbooks.js and draws the page under its heading “QuickBooks export”",
    served.filter(u => u.endsWith("/admin-quickbooks.js")).length === 1 && !!page() && hashNow() === "quickbooks" && /QuickBooks export/.test(d.title) && /QuickBooks export/.test(text(app.querySelector("h1, h2"))));
  ok("the dates start on last month on the business's calendar: 2026-11-01 to 2026-11-30", id("qbFrom").value === "2026-11-01" && id("qbTo").value === "2026-11-30");
  ok("four presets in order: This month, Last month, This quarter, Last year",
    same(qa("[data-qb-preset]").map(b => b.dataset.qbPreset + "=" + text(b)), ["month=This month", "lastmonth=Last month", "quarter=This quarter", "lastyear=Last year"]));
  ok("…each kept usable whatever the role (data-perm-keep) and never a submit button", qa("[data-qb-preset]").every(b => b.hasAttribute("data-perm-keep") && b.type === "button"));
  ok("“For”: QuickBooks Online (CSV files) or QuickBooks Desktop (one .iif file)",
    same(qa('input[name="qbFormat"]').map(r => r.value + "=" + text(r.closest("label"))), ["online=QuickBooks Online (CSV files)", "desktop=QuickBooks Desktop (one .iif file)"]));
  ok("…QuickBooks Online chosen, as the saved settings say (none saved yet: Online)", radio("qbFormat", "online").checked && !radio("qbFormat", "desktop").checked);
  ok("…with how to import into QuickBooks Online (Import data ▸ Invoices; Banking ▸ Upload transactions, one file per bank account)",
    /^QuickBooks Online: sales — Settings ▸ Import data ▸ Invoices/.test(text(id("qbHowTo"))) && /Banking ▸ Upload transactions, one file per bank account, each into the account it is named for\./.test(text(id("qbHowTo"))));
  ok("“Make a backup of your company file first.” is always shown", /Make a backup of your company file first\. An import can't be undone in one step: export each range of dates once\./.test(text(page())));
  ok("“What to export”: Sales, Payments, Expenses, Deposits, all ticked",
    same(qa("[data-qb-part]").map(c => c.dataset.qbPart + "=" + text(c.closest("label")) + "=" + c.checked), ["sales=Sales=true", "payments=Payments=true", "expenses=Expenses=true", "deposits=Deposits=true"]));
  ok("…each saying what it holds when pointed at (gift cards sold go to the liability, never to sales)",
    /gift cards sold \(to the gift card liability, never to sales\)/.test(qa("[data-qb-part]")[0].closest("label").title) &&
    /Money received and refunded, by the day it moved/.test(qa("[data-qb-part]")[1].closest("label").title) &&
    /Expenses and vendor refunds/.test(qa("[data-qb-part]")[2].closest("label").title) && /Card payouts and cash-outs/.test(qa("[data-qb-part]")[3].closest("label").title));
  ok("the page reads the settings once, with their accounts and categories (no listAccounts / listExpenseCategories)",
    of("getQuickBooksSettings").length === 1 && of("listAccounts").length === 0 && of("listExpenseCategories").length === 0);
  ok("the summary is asked as a summary only, for last month, every part, in the chosen format",
    summaryAsks().length === 1 && same(summaryAsks()[0], { action: "getQuickBooksExport", dateFrom: "2026-11-01", dateTo: "2026-11-30", format: "online", parts: ["sales", "payments", "expenses", "deposits"], summaryOnly: true }));
  ok("…and asking it writes nothing to the audit log", audits("report.quickbooks_export") === 0);
  { const s = await serverSummary("2026-11-01", "2026-11-30"); 
    ok("the summary shows each part's total and count as the server counts them: the sale at 23:30 on Nov 30 is in, the one at 23:30 on Oct 31 isn't",
      s.sales.count === 1 && cellText("Sales") === money(s.sales.totalCents) + " Sales 1 order" && s.sales.totalCents > 0 &&
      cellText("Payments") === money(s.payments.totalCents) + " Payments " + s.payments.count + (s.payments.count === 1 ? " payment" : " payments") &&
      cellText("Expenses") === "$42.50 Expenses 1 expense" && cellText("Deposits") === "$0.00 Deposits 0 deposits"); }
  ok("Download can be pressed, with no note under it", !id("qbDownload").disabled && text(id("qbDownloadNote")) === "" && id("qbDownload").hasAttribute("data-perm-keep"));

  console.log("\n=== The account mapping ===");
  ok("“Account mapping” says to type each name as it is in QuickBooks (a sub-account as Parent:Child)",
    /Type each name exactly as it is in your QuickBooks chart of accounts \(a sub-account as Parent:Child\)\./.test(text(page())) && !/You can see the mapping/.test(text(page())));
  ok("Accounts: a box for each kind of money, with its label and QuickBooks' usual name filled in",
    same(qa("#qbMap [data-qb-acc]").map(i => i.dataset.qbAcc + "=" + labelOf(i) + "=" + i.value), [
      "sales=Sales=Sales", "shippingIncome=Shipping income=Shipping Income", "rushIncome=Rush income=Sales", "discounts=Discounts=Discounts Given",
      "salesTaxPayable=Sales tax payable=Sales Tax Payable", "giftCardLiability=Gift card liability=Gift Cards Outstanding", "undepositedFunds=Undeposited funds=Undeposited Funds",
      "cardFees=Card fees=Merchant Fees", "postage=Postage=Postage and Delivery", "ar=Accounts receivable=Accounts Receivable"]));
  ok("…each one line of at most 100 characters, the usual name as its placeholder", qa("#qbMap [data-qb-acc]").every(i => i.type === "text" && i.maxLength === 100) && accBox("cardFees").placeholder === "Merchant Fees" && accBox("rushIncome").placeholder === "Sales");
  ok("Bank and card accounts: one box per account in the app, named as the app names it",
    same(qa("#qbMap [data-qb-bank]").map(i => i.dataset.qbBank), ["1", "2", "3", "4", "5", "6"]) && bankBox("1").value === "Business checking" && labelOf(bankBox("5")) === "Stripe balance");
  ok("…a closed account still listed, marked “(closed)”, its name shown as text (markup escaped)",
    labelOf(bankBox("6")) === 'Old <b>Savings</b> "A&B" (closed)' && bankBox("6").value === 'Old <b>Savings</b> "A&B"' && !q("#qbMap b"));
  ok("Expense categories: one box per category, its name filled in, markup escaped",
    qa("#qbMap [data-qb-cat]").length === d1.q("SELECT count(*) AS n FROM expense_categories")[0].n && labelOf(catBox("90")) === 'Thread <i>&</i> "floss"' && catBox("90").value === 'Thread <i>&</i> "floss"' && !q("#qbMap i"));
  ok("“Sales go in as”: Sales receipts (chosen) or Invoices, saying Net 30 orders always go in as invoices",
    radio("qbSalesAs", "receipts").checked && !radio("qbSalesAs", "invoices").checked && /Sales go in as Sales receipts Invoices Net 30 orders always go in as invoices\./.test(text(id("qbMap"))));
  ok("“Customer name”: Customer (chosen) or Shop, saying a shop's sales go under the shop's name",
    radio("qbCustomerName", "customer").checked && !radio("qbCustomerName", "shop").checked && /Shop: every sale of a shop goes under the shop's name \(a club, a school\)\./.test(text(id("qbMap"))));
  ok("a “Save mapping” button, and nothing locked", text(id("qbSave")) === "Save mapping" && id("qbSave").type === "submit" && qa("#qbMap input").every(i => !i.disabled));

  // ==============================================================================================================
  console.log("\n=== The dates ===");
  // ==============================================================================================================
  const preset = async (k) => { reset(); q(`[data-qb-preset="${k}"]`).click(); await pause(20); await idle(); };
  await preset("month");
  ok("This month: Dec 1 to today (Dec 15), asked at once", id("qbFrom").value === "2026-12-01" && id("qbTo").value === "2026-12-15" && summaryAsks().length === 1 && summaryAsks()[0].dateFrom === "2026-12-01" && summaryAsks()[0].dateTo === "2026-12-15");
  await preset("quarter");
  ok("This quarter: Oct 1 to today — both sales, 2 orders", id("qbFrom").value === "2026-10-01" && id("qbTo").value === "2026-12-15" && / 2 orders$/.test(cellText("Sales")));
  await preset("lastyear");
  ok("Last year: all of 2025 — nothing there: $0.00 and “0 orders”, and the note “Nothing in these dates for the ticked parts.”",
    id("qbFrom").value === "2025-01-01" && id("qbTo").value === "2025-12-31" && cellText("Sales") === "$0.00 Sales 0 orders" && text(id("qbDownloadNote")) === "Nothing in these dates for the ticked parts.");
  await preset("lastmonth");
  ok("Last month again: Nov 1 to Nov 30, the note gone", id("qbFrom").value === "2026-11-01" && id("qbTo").value === "2026-11-30" && text(id("qbDownloadNote")) === "" && / 1 order$/.test(cellText("Sales")));
  reset(); choose(id("qbFrom"), ""); await pause(20); await idle();
  ok("a date box cleared asks nothing and keeps the dates it had", sent.length === 0 && / 1 order$/.test(cellText("Sales")));
  reset(); choose(id("qbFrom"), "2026-12-05"); await pause(20); await idle();
  ok("From after To: “The From date is after the To date.” in place of the summary, Download off, nothing asked",
    sent.length === 0 && text(q("#qbSummary .cust-err")) === "The From date is after the To date." && q("#qbSummary .cust-err").getAttribute("role") === "alert" && id("qbDownload").disabled);
  id("qbDownload").disabled = false; reset(); id("qbDownload").click(); await pause(20);
  ok("…and Download, even if it were pressed, says the same and asks nothing", sent.length === 0 && lastToast().m === "The From date is after the To date." && lastToast().err);
  reset(); choose(id("qbFrom"), "2026-11-01"); await pause(20); await idle();
  ok("a good From date asks again", summaryAsks().length === 1 && summaryAsks()[0].dateFrom === "2026-11-01" && !q("#qbSummary .cust-err") && !id("qbDownload").disabled);
  reset(); choose(id("qbTo"), "2026-11-29"); await pause(20); await idle();
  ok("the To date too: Nov 1 to Nov 29 leaves out the sale at 23:30 on Nov 30 in Chicago", summaryAsks().length === 1 && summaryAsks()[0].dateTo === "2026-11-29" && / 0 orders$/.test(cellText("Sales")));
  reset(); id("qbFilters").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await pause(20); await idle();
  ok("pressing Enter in the dates asks again", summaryAsks().length === 1);
  await preset("lastmonth");

  // ==============================================================================================================
  console.log("\n=== The parts ===");
  // ==============================================================================================================
  reset(); tick(q('[data-qb-part="sales"]'), false); await pause(20);
  ok("unticking Sales greys its total and says “Not exported”, asking nothing", sent.length === 0 && summaryCell("Sales").getAttribute("style") === "opacity:.45;" && / Not exported$/.test(cellText("Sales")) && !summaryCell("Payments").hasAttribute("style"));
  for (const k of ["payments", "expenses", "deposits"]) tick(q(`[data-qb-part="${k}"]`), false);
  ok("nothing ticked: Download off, “Tick at least one part.”", id("qbDownload").disabled && text(id("qbDownloadNote")) === "Tick at least one part.");
  id("qbDownload").disabled = false; reset(); id("qbDownload").click(); await pause(20);
  ok("…and Download, even if pressed, asks nothing and says “Tick at least one part to export.”", sent.length === 0 && lastToast().m === "Tick at least one part to export." && lastToast().err);
  tick(q('[data-qb-part="expenses"]'), true);
  ok("Expenses ticked alone: Download on, the other totals greyed", !id("qbDownload").disabled && text(id("qbDownloadNote")) === "" && / 1 expense$/.test(cellText("Expenses")) && / Not exported$/.test(cellText("Deposits")));
  tick(q('[data-qb-part="deposits"]'), true);
  ok("Deposits too, which have nothing: no “nothing” note while a ticked part has something", text(id("qbDownloadNote")) === "");
  tick(q('[data-qb-part="expenses"]'), false);
  ok("only Deposits, with nothing in them: “Nothing in these dates for the ticked parts.”", text(id("qbDownloadNote")) === "Nothing in these dates for the ticked parts.");
  for (const k of ["sales", "payments", "expenses"]) tick(q(`[data-qb-part="${k}"]`), true);

  // ==============================================================================================================
  console.log("\n=== Download: QuickBooks Online ===");
  // ==============================================================================================================
  const download = async (n) => { reset(); blobs.length = 0; saves.length = 0; id("qbDownload").click(); await idle(); await wait(() => saves.length >= n, 300); await pause(450); };
  const auditsBefore = audits("report.quickbooks_export");
  await download(3);
  const auditsAfter = audits("report.quickbooks_export");
  { const ask = asked()[0];
    const files = (await must({ action: "getQuickBooksExport", dateFrom: "2026-11-01", dateTo: "2026-11-30", format: "online", parts: ["sales", "payments", "expenses", "deposits"] })).files;
    ok("Download asks for the files (not a summary): last month, Online, the ticked parts in order",
      asked().length === 1 && same(ask, { action: "getQuickBooksExport", dateFrom: "2026-11-01", dateTo: "2026-11-30", format: "online", parts: ["sales", "payments", "expenses", "deposits"] }));
    ok("each file the server built is saved, one after another, under its own name", files.length >= 3 && saves.length === files.length && same(saves.map(s => s.name), files.map(f => f.filename)) &&
      saves.every(s => s.inPage && /^blob:file-/.test(s.href)) && files.every(f => /^odd-qbo-.*2026-11-01-to-2026-11-30\.csv$/.test(f.filename)));
    ok("…spaced out (a browser saves only the first of several started at once): at least a third of a second apart",
      saves.slice(1).every((s, i) => s.at - saves[i].at >= 300));
    const texts = await Promise.all(blobs.map(blobText));
    ok("…as CSV text, the server's text exactly", same(texts, files.map(f => f.text)) && blobs.every(b => b.type === "text/csv;charset=utf-8"));
    ok("…and the link used to save it is gone from the page", !q("a[download]"));
    ok("the page lists the files: “Saved N files (your browser may ask to allow several downloads):”, each name with “Save again”",
      text(id("qbFiles").querySelector(".cust-note")) === `Saved ${files.length} files (your browser may ask to allow several downloads):` &&
      same(qa("#qbFiles li .mono").map(text), files.map(f => f.filename)) && qa("#qbFiles [data-qb-file]").every(b => text(b) === "Save again" && b.hasAttribute("data-perm-keep")));
    ok("a toast says “N QuickBooks files saved.”, the note is cleared, Download is on again", lastToast().m === `${files.length} QuickBooks files saved.` && !lastToast().err && text(id("qbDownloadNote")) === "" && !id("qbDownload").disabled);
    ok("one export, one line in the audit log", auditsBefore === 0 && auditsAfter === 1);
    reset(); blobs.length = 0; saves.length = 0;
    qa("#qbFiles [data-qb-file]")[1].click(); await pause(20);
    ok("“Save again” saves that one file again, asking the server nothing", sent.length === 0 && saves.length === 1 && saves[0].name === files[1].filename && (await blobText(blobs[0])) === files[1].text); }
  tick(q('[data-qb-part="sales"]'), false);
  ok("changing the parts clears the list of saved files", id("qbFiles").innerHTML === "");
  for (const k of ["payments", "deposits"]) tick(q(`[data-qb-part="${k}"]`), false);
  await download(1);
  ok("only Expenses: one file, “Saved:”, and “QuickBooks file saved.”", asked().length === 1 && same(asked()[0].parts, ["expenses"]) && saves.length === 1 &&
    /^odd-qbo-expenses-/.test(saves[0].name) && text(id("qbFiles").querySelector(".cust-note")) === "Saved:" && lastToast().m === "QuickBooks file saved.");
  for (const k of ["sales", "payments", "deposits"]) tick(q(`[data-qb-part="${k}"]`), true);
  await preset("lastyear");
  scripted = [{ action: "getQuickBooksExport", body: { status: "ok", files: [], summary: { sales: { count: 0, totalCents: 0 } } } }];
  await download(0);
  ok("an export with no files: “Nothing to export in these dates.”, nothing saved, no toast", text(id("qbFiles")) === "Nothing to export in these dates." && saves.length === 0 && toasts.length === 0);
  await preset("lastmonth");

  // ==============================================================================================================
  console.log("\n=== Download: QuickBooks Desktop, and the format remembered ===");
  // ==============================================================================================================
  await download(3);
  reset(); tick(radio("qbFormat", "desktop"), true); await pause(20); await idle();
  ok("choosing QuickBooks Desktop shows its how-to (File ▸ Utilities ▸ Import ▸ IIF Files; every transaction balances)",
    /^QuickBooks Desktop: File ▸ Utilities ▸ Import ▸ IIF Files, and pick the \.iif file\. Every transaction in it balances to the cent\./.test(text(id("qbHowTo"))) && radio("qbFormat", "desktop").checked);
  ok("…clears the list of saved files", id("qbFiles").innerHTML === "");
  ok("…and is remembered in the settings for next time, quietly (no toast)",
    of("updateQuickBooksSettings").length === 1 && of("updateQuickBooksSettings")[0].format === "desktop" && of("updateQuickBooksSettings")[0].settings.format === "desktop" &&
    (await must({ action: "getQuickBooksSettings" })).settings.format === "desktop" && toasts.length === 0);
  reset(); tick(radio("qbFormat", "desktop"), true); await pause(20); await idle();
  ok("choosing the format already saved saves nothing", of("updateQuickBooksSettings").length === 0);
  await download(1);
  { const iif = (await must({ action: "getQuickBooksExport", dateFrom: "2026-11-01", dateTo: "2026-11-30", format: "desktop", parts: ["sales", "payments", "expenses", "deposits"] })).files[0];
    ok("Download for Desktop: one .iif file, the server's text exactly, as plain bytes",
      asked()[0].format === "desktop" && saves.length === 1 && saves[0].name === "odd-quickbooks-2026-11-01-to-2026-11-30.iif" && saves[0].name === iif.filename &&
      (await blobText(blobs[0])) === iif.text && blobs[0].type === "application/octet-stream;charset=utf-8" && lastToast().m === "QuickBooks file saved."); }
  await open();
  ok("coming back to the page keeps Desktop, last month and the parts as they were", radio("qbFormat", "desktop").checked && id("qbFrom").value === "2026-11-01" && /QuickBooks Desktop:/.test(text(id("qbHowTo"))) &&
    summaryAsks()[0].format === "desktop");
  // A fresh load of the page script (a new visit): the format comes from the saved settings.
  w.eval("delete window.renderQuickBooks; _quickBooksPagePromise = null;");
  await open();
  ok("a new visit opens on the format saved in the settings: Desktop, and the dates back on last month",
    served.filter(u => u.endsWith("/admin-quickbooks.js")).length === 2 && radio("qbFormat", "desktop").checked && summaryAsks()[0].format === "desktop" && id("qbFrom").value === "2026-11-01");
  tick(radio("qbFormat", "online"), true); await pause(20); await idle();
  ok("(back to Online, saved)", (await must({ action: "getQuickBooksSettings" })).settings.format === "online");

  // ==============================================================================================================
  console.log("\n=== Errors and late answers ===");
  // ==============================================================================================================
  scripted = [{ action: "getQuickBooksExport", status: 500, body: { status: "error", message: "Database <busy> (test)" } }];
  await preset("lastmonth");
  ok("a summary the server can't give: its message in place of the summary (escaped), Download off",
    text(q("#qbSummary .cust-err")) === "Database <busy> (test)" && !q("#qbSummary busy") && id("qbDownload").disabled);
  scripted = [{ action: "getQuickBooksExport", empty: true }];
  await preset("lastmonth");
  ok("…one with no message: “Couldn't load what the export holds.”", text(q("#qbSummary .cust-err")) === "Couldn't load what the export holds.");
  await preset("lastmonth");
  ok("asking again draws the summary", !q("#qbSummary .cust-err") && / 1 order$/.test(cellText("Sales")) && !id("qbDownload").disabled);
  scripted = [{ action: "getQuickBooksExport", status: 409, body: { status: "error", message: "Order ODD-1 doesn't balance." } }];
  await download(0);
  ok("a Download the server refuses: “Couldn't build the export: <why>”, nothing saved, the note cleared, Download on again",
    lastToast().m === "Couldn't build the export: Order ODD-1 doesn't balance." && lastToast().err && saves.length === 0 && text(id("qbDownloadNote")) === "" && !id("qbDownload").disabled);
  scripted = [{ action: "getQuickBooksExport", empty: true }];
  await download(0);
  ok("…one with no message: “Couldn't build the export: unknown error”", lastToast().m === "Couldn't build the export: unknown error");
  { let release; const gate = new Promise(r => { release = r; });
    scripted = [{ action: "getQuickBooksExport", gate }];
    reset(); blobs.length = 0; saves.length = 0; id("qbDownload").click(); await pause(20);
    ok("while the files are built: “Building the files…”, Download off", text(id("qbDownloadNote")) === "Building the files…" && id("qbDownload").disabled);
    release(); await idle(); await wait(() => saves.length >= 3, 300); }
  { let release; const gate = new Promise(r => { release = r; });
    scripted = [{ action: "getQuickBooksExport", gate, body: { status: "ok", summary: { sales: { count: 99, totalCents: 99900 } } } }];
    reset(); q('[data-qb-preset="lastyear"]').click(); await pause(20);
    q('[data-qb-preset="quarter"]').click(); await pause(20); await idle();
    release(); await pause(30); await idle();
    ok("a slow answer for older dates doesn't replace the newer one", / 2 orders$/.test(cellText("Sales")) && !/99/.test(cellText("Sales")) && id("qbFrom").value === "2026-10-01"); }
  { let release; const gate = new Promise(r => { release = r; });
    scripted = [{ action: "getQuickBooksExport", gate, body: { status: "ok", summary: { sales: { count: 77, totalCents: 7700 } } } }];
    reset(); q('[data-qb-preset="lastmonth"]').click(); await pause(20);
    w.location.hash = "#home"; await wait(() => !page()); await idle();
    const before = app.innerHTML;
    release(); await pause(30); await idle();
    ok("an answer that arrives after leaving the page draws nothing", app.innerHTML === before && !page()); }
  { let release; const gate = new Promise(r => { release = r; });
    await open();
    scripted = [{ action: "getQuickBooksExport", gate, status: 500, body: { status: "error", message: "late failure (test)" } }];
    reset(); q('[data-qb-preset="lastmonth"]').click(); await pause(20);
    w.location.hash = "#home"; await wait(() => !page()); await idle();
    release(); await pause(30); await idle();
    ok("…nor does a failure that arrives after leaving", !page() && !/late failure/.test(app.textContent)); }
  await open();
  { let release; const gate = new Promise(r => { release = r; });
    scripted = [{ action: "getQuickBooksExport", gate }];
    reset(); saves.length = 0; id("qbDownload").click(); await pause(20);
    w.location.hash = "#home"; await wait(() => !page()); await idle();
    release(); await pause(30); await idle(); await pause(450);
    ok("a Download whose files arrive after leaving the page saves nothing and says nothing", saves.length === 0 && toasts.length === 0); }
  { let release; const gate = new Promise(r => { release = r; });
    await open();
    scripted = [{ action: "getQuickBooksExport", gate, status: 409, body: { status: "error", message: "late refusal (test)" } }];
    reset(); id("qbDownload").click(); await pause(20);
    w.location.hash = "#home"; await wait(() => !page()); await idle();
    release(); await pause(30); await idle();
    ok("…nor does a refusal that arrives after leaving", toasts.length === 0); }
  scripted = [{ action: "getQuickBooksSettings", status: 500, body: { status: "error", message: "Settings <unreadable> (test)" } }];
  await open();
  ok("settings the server can't give: the mapping says why (escaped), the page opens on Online, and the summary still comes",
    text(q("#qbMap .cust-err")) === "Settings <unreadable> (test)" && !q("#qbMap unreadable") && radio("qbFormat", "online").checked && / 1 order$/.test(cellText("Sales")) && !q("#qbMap input"));
  scripted = [{ action: "getQuickBooksSettings", empty: true }];
  await open();
  ok("…with no message: “Couldn't load the account mapping.”", text(q("#qbMap .cust-err")) === "Couldn't load the account mapping.");
  reset(); tick(radio("qbFormat", "desktop"), true); await pause(20); await idle();
  ok("…and choosing a format then saves nothing (there are no settings to save it in)", of("updateQuickBooksSettings").length === 0);
  tick(radio("qbFormat", "online"), true);
  { const real = await must({ action: "getQuickBooksSettings" });
    scripted = [{ action: "getQuickBooksSettings", body: { status: "ok", quickbooks: real.settings } }];
    await open();
    ok("a server that sends the settings without the app's accounts: the page reads Accounts and Expense categories itself",
      of("listAccounts").length === 1 && of("listExpenseCategories").length === 1 && qa("#qbMap [data-qb-bank]").length === 6 && !!catBox("90"));
    scripted = [{ action: "getQuickBooksSettings", body: { status: "ok", quickbooks: real.settings } }, { action: "listAccounts", status: 403, body: { status: "error", message: "no" } },
      { action: "listExpenseCategories", status: 403, body: { status: "error", message: "no" } }];
    await open();
    ok("…and when this role can't read those either: “No accounts set up yet (Finance → Accounts).” and “No expense categories yet.”",
      /No accounts set up yet \(Finance → Accounts\)\./.test(text(id("qbMap"))) && /No expense categories yet\./.test(text(id("qbMap"))) && !q("#qbMap [data-qb-bank]") && qa("#qbMap [data-qb-acc]").length === 10);
    scripted = [{ action: "getQuickBooksSettings", body: { status: "ok", quickbooks: real.settings, accounts: [{ id: 1, name: "Business checking" }, { name: "no id" }, null], categories: [{ id: 90, name: "Thread" }, {}] } }];
    await open();
    ok("accounts and categories without an id are left out", qa("#qbMap [data-qb-bank]").length === 1 && qa("#qbMap [data-qb-cat]").length === 1); }

  // ==============================================================================================================
  console.log("\n=== Saving the mapping ===");
  // ==============================================================================================================
  await open();
  accBox("sales").value = "  Income:Embroidery  ";
  bankBox("1").value = "Checking 1234";
  catBox("90").value = "Supplies:Thread";
  radio("qbSalesAs", "invoices").checked = true;
  radio("qbCustomerName", "shop").checked = true;
  await submitMap();
  { const u = of("updateQuickBooksSettings")[0] || {};
    ok("Save sends every box trimmed, the two choices and the format, also as `settings`",
      u.accounts && u.accounts.sales === "Income:Embroidery" && u.accounts.ar === "Accounts Receivable" && Object.keys(u.accounts).length === 10 &&
      u.bankAccounts["1"] === "Checking 1234" && u.bankAccounts["6"] === 'Old <b>Savings</b> "A&B"' && u.expenseAccounts["90"] === "Supplies:Thread" &&
      u.salesAs === "invoices" && u.customerName === "shop" && u.format === "online" && same(u.settings, (({ action, settings, ...v }) => v)(u)));
    const stored = (await must({ action: "getQuickBooksSettings" })).settings;
    ok("…the server keeps it", stored.accounts.sales === "Income:Embroidery" && stored.bankAccounts["1"] === "Checking 1234" && stored.expenseAccounts["90"] === "Supplies:Thread" && stored.salesAs === "invoices" && stored.customerName === "shop");
    ok("…“QuickBooks account mapping saved.”, the mapping drawn again from what was saved, and the summary asked again",
      lastToast().m === "QuickBooks account mapping saved." && !lastToast().err && accBox("sales").value === "Income:Embroidery" && radio("qbSalesAs", "invoices").checked && radio("qbCustomerName", "shop").checked &&
      summaryAsks().length === 1 && !id("qbSave").disabled); }
  accBox("cardFees").value = "   ";
  await submitMap();
  ok("an empty box: “Give Card fees a name of 1 to 100 characters, on one line.”, nothing sent", text(id("qbMapErr")) === "Give Card fees a name of 1 to 100 characters, on one line." && sent.length === 0);
  bankBox("6").value = "x".repeat(101);
  await submitMap();
  ok("two bad boxes (one over 100 characters): “Give 2 boxes a name of 1 to 100 characters, on one line.”", text(id("qbMapErr")) === "Give 2 boxes a name of 1 to 100 characters, on one line." && sent.length === 0);
  accBox("cardFees").value = "Merchant Fees";
  await submitMap();
  ok("a bank account's box is named by the account", text(id("qbMapErr")) === 'Give Old <b>Savings</b> "A&B" a name of 1 to 100 characters, on one line.' && sent.length === 0);
  bankBox("6").value = "Savings";
  catBox("90").value = "Thread\tfloss";
  await submitMap();
  ok("a category's box with a tab in it is named by the category", text(id("qbMapErr")) === 'Give Thread <i>&</i> "floss" a name of 1 to 100 characters, on one line.' && sent.length === 0);
  catBox("90").value = "Supplies:Thread";
  scripted = [{ action: "updateQuickBooksSettings", status: 400, body: { status: "error", message: "That name is too long." } }];
  await submitMap();
  ok("a Save the server refuses: “Couldn't save: <why>”, Save usable again, the boxes kept", text(id("qbMapErr")) === "Couldn't save: That name is too long." && !id("qbSave").disabled && bankBox("6").value === "Savings" && toasts.length === 0);
  scripted = [{ action: "updateQuickBooksSettings", empty: true }];
  await submitMap();
  ok("…one with no message: “Couldn't save: unknown error”", text(id("qbMapErr")) === "Couldn't save: unknown error");
  scripted = [{ action: "updateQuickBooksSettings", body: { status: "ok" } }];
  await submitMap();
  ok("a server that answers without the settings: what was sent is kept as saved", text(id("qbMapErr")) === "" && bankBox("6").value === "Savings" && lastToast().m === "QuickBooks account mapping saved.");
  await submitMap();
  ok("(saved for real)", (await must({ action: "getQuickBooksSettings" })).settings.bankAccounts["6"] === "Savings");
  radio("qbSalesAs", "receipts").checked = true; radio("qbCustomerName", "customer").checked = true;
  await submitMap();
  ok("Sales receipts and Customer chosen again are saved too", (await must({ action: "getQuickBooksSettings" })).settings.salesAs === "receipts" && (await must({ action: "getQuickBooksSettings" })).settings.customerName === "customer");
  ok("(each Save is one settings line in the audit log)", audits("settings.quickbooks") >= 4);

  // ==============================================================================================================
  console.log("\n=== Back office: reads the page and downloads, can't change the mapping ===");
  // ==============================================================================================================
  asRoles("staff");
  await open();
  ok("Back office opens the page with the mapping shown", !!page() && accBox("sales").value === "Income:Embroidery" && bankBox("6").value === "Savings");
  ok("…told “You can see the mapping; changing it needs Edit on QuickBooks export.”", /You can see the mapping; changing it needs Edit on QuickBooks export\./.test(text(page())));
  ok("…every mapping box and choice locked, no Save button", !id("qbSave") && qa("#qbMap input").length > 10 && qa("#qbMap input").every(i => i.disabled));
  ok("…while the dates, presets, format, parts and Download still work", !id("qbFrom").disabled && !radio("qbFormat", "desktop").disabled && !q('[data-qb-part="sales"]').disabled &&
    !id("qbDownload").disabled && !id("qbDownload").hasAttribute("data-perm-off") && qa("[data-qb-preset]").every(b => !b.hasAttribute("data-perm-off")));
  reset(); tick(radio("qbFormat", "desktop"), true); await pause(20); await idle();
  ok("choosing Desktop changes the page but saves nothing", radio("qbFormat", "desktop").checked && /QuickBooks Desktop:/.test(text(id("qbHowTo"))) && of("updateQuickBooksSettings").length === 0 &&
    (await must({ action: "getQuickBooksSettings" })).settings.format === "online");
  await download(1);
  ok("Back office downloads the .iif", saves.length === 1 && /\.iif$/.test(saves[0].name) && lastToast().m === "QuickBooks file saved.");
  await submitMap();
  ok("the mapping form sent anyway (Enter in a box) saves nothing", of("updateQuickBooksSettings").length === 0 && sent.length === 0);
  tick(radio("qbFormat", "online"), true);
  asRoles("admin");

  // ==============================================================================================================
  console.log("\n=== Global settings → Gift cards: selling on the shop needs card payments ===");
  // ==============================================================================================================
  const panel = () => id("adminPanel");
  const drawSettings = async () => { reset(); await w.renderGlobalSettings(app); await wait(() => !!id("gPayCard")); await idle(); };
  const saveGlobal = async () => { reset(); await w.submitGlobalSettings(); await idle(); return of("saveGlobalSettingsAll"); };
  const errNow = () => id("globalSettingsError") ? id("globalSettingsError").textContent : "";
  const NOT_READY = "Card payments must be set up and switched on to sell gift cards on a shop: add your Stripe keys (see Setup) and tick Card under Payment methods. A shop also needs Card switched on in its own payment methods.";
  const sellNote = () => text(id("gGiftSellNote"));
  // Stored as on from before (an install that had the tick on with no Stripe key).
  d1.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('giftCards', ?)", JSON.stringify({ sellOnline: true, amounts: [2500, 5000, 10000], minCents: 500, maxCents: 50000 }));
  globalThis.__stripe418 = "";
  await drawSettings();
  ok("no Stripe key: the server says card payments aren't ready", (await must({ action: "getGiftCardSettings" })).giftCards.cardReady === false);
  ok("…the tick is greyed out and unticked, though “on” is stored", id("gGiftSell").disabled && !id("gGiftSell").checked);
  ok("…with the note right under it, saying card payments must be set up and switched on", sellNote() === NOT_READY && id("gGiftSell").getAttribute("aria-describedby") === "gGiftSellNote" &&
    id("gGiftSell").closest("label").nextElementSibling === id("gGiftSellNote"));
  ok("…the amount boxes can still be changed", !id("gGiftAmounts").disabled && !id("gGiftMin").disabled && !id("gGiftMax").disabled);
  id("gGiftAmounts").value = "20, 40";
  id("gGiftSell").checked = true;   // as a browser restoring the form might leave it: the box is still greyed out
  { const s = await saveGlobal();
    ok("Save sends sellOnline false (and the new amounts), even with the greyed-out box ticked, and is saved", s.length === 1 && s[0].settings.giftCards.sellOnline === false && same(s[0].settings.giftCards.amounts, [2000, 4000]) && errNow() === "" &&
      same(JSON.parse(d1.q("SELECT value FROM global_settings WHERE key = 'giftCards'")[0].value).sellOnline, false)); }
  globalThis.__stripe418 = "sk_test_x";
  { const g = await must({ action: "getGlobalSettings" });
    const pay = Object.assign({}, (g.globalSettings || g.settings || g).enabledPayments || {}, { card: false });
    await must({ action: "updateGlobalSettings", globalSettings: { enabledPayments: pay } }); }
  await drawSettings();
  ok("a Stripe key but Card unticked under Payment methods: still not ready, the same note", id("gGiftSell").disabled && sellNote() === NOT_READY);
  reset(); tick(id("gPayCard"), true);
  { const s = await saveGlobal(); ok("(Card ticked again and saved)", s.length === 1 && errNow() === ""); }
  await drawSettings();
  ok("Stripe set up and Card on: the tick can be used, unticked as stored", !id("gGiftSell").disabled && !id("gGiftSell").checked && !id("gGiftSell").hasAttribute("aria-describedby"));
  ok("…with the small note “Only shops that take card payments show gift cards.”", sellNote() === "Only shops that take card payments show gift cards.");
  tick(id("gGiftSell"), true);
  { const s = await saveGlobal();
    ok("ticked and saved: sellOnline true is sent and stored", s.length === 1 && s[0].settings.giftCards.sellOnline === true && errNow() === "" && (await must({ action: "getGiftCardSettings" })).giftCards.sellOnline === true); }
  await drawSettings();
  ok("drawn again: ticked", id("gGiftSell").checked && !id("gGiftSell").disabled);
  tick(id("gPayCard"), false);
  { const s = await saveGlobal();
    ok("Card unticked in the same Save as the gift card tick: refused, “Set up card payments before selling gift cards on a shop.”",
      s.length === 1 && /Set up card payments before selling gift cards on a shop\./.test(errNow()));
    ok("…and nothing of that Save is kept: Card still on", (await must({ action: "getGiftCardSettings" })).giftCards.cardReady === true); }
  scripted = [{ action: "getGiftCardSettings", body: { status: "ok", giftCards: { sellOnline: true, amounts: [2500], minCents: 500, maxCents: 50000 } } }];
  await drawSettings();
  ok("a server from before cardReady: the tick works as before (ticked, usable, the small note)", id("gGiftSell").checked && !id("gGiftSell").disabled && sellNote() === "Only shops that take card payments show gift cards.");

  // ==============================================================================================================
  console.log("\n=== The shop page: the Gift card tile ===");
  // ==============================================================================================================
  await must({ action: "updateFeatures", features: { giftCards: true } });
  d1.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('giftCards', ?)", JSON.stringify({ sellOnline: true, amounts: [2500, 5000, 10000], minCents: 500, maxCents: 50000 }));
  for (const org of ["club", "school"]) await C.publishShop(d1, org);
  const shop = async (sub, env) => {
    freshCacheApi();
    const svc = new VirtualConsole();
    svc.on("jsdomError", (e) => { if (!/Not implemented/.test(String(e && e.message))) console.error(e); });
    const sdom = new JSDOM(storefrontPage({ adminCss: false }), { runScripts: "dangerously", url: shopOrigin(sub) + "/", pretendToBeVisual: true, virtualConsole: svc,
      beforeParse(win) {
        win.scrollTo = () => {}; win.alert = () => {};
        win.fetch = async (u) => {
          if (String(u).startsWith("/api/catalog")) {
            const res = await C.catalogGet({ request: { url: shopOrigin(sub) + String(u), headers: { get: () => null } }, env: { DB: d1, ...env } });
            const t = await res.text();
            return { ok: res.status < 400, status: res.status, json: async () => JSON.parse(t), text: async () => t, headers: { get: () => null } };
          }
          return { ok: true, status: 200, json: async () => ({}), text: async () => "{}", headers: { get: () => null } };
        };
      } });
    const sw = sdom.window, sd = sw.document;
    await wait(() => !!sd.querySelector(".org-hero"));
    return { sw, sd };
  };
  const STRIPE = { STRIPE_SECRET_KEY: "sk_test_x" };
  {
    const { sw, sd } = await shop("club", STRIPE);
    const tile = sd.querySelector(".gift-tile");
    const firstSection = sd.querySelector("#catalogArea .cat-section");
    ok("a shop that sells gift cards online shows a “Gift card” tile", !!tile && text(tile.querySelector("h3")) === "Gift card");
    ok("…first in its one Products section, before the products", !!tile && firstSection.contains(tile) && text(firstSection.querySelector(".cat-heading")) === "Products" &&
      firstSection.querySelector(".cat-heading").nextElementSibling === tile && !!(tile.compareDocumentPosition(sd.querySelector(".product")) & sw.Node.DOCUMENT_POSITION_FOLLOWING) &&
      !sd.querySelector(".gift-tile-section"));
    ok("…priced from the smallest to the largest amount a buyer can choose: “$5 – $500”", text(tile.querySelector(".product-price")) === "$5 – $500");
    ok("…“Emailed to the person you choose.”, and a “Buy a gift card” button", text(tile.querySelector(".product-desc")) === "Emailed to the person you choose." &&
      text(tile.querySelector("button")) === "Buy a gift card" && tile.querySelector("button").type === "button");
    ok("…a built-in picture in the shop's colour, hidden from screen readers", !!tile.querySelector("svg.gift-tile-pic[aria-hidden='true']") && tile.querySelector("svg rect").getAttribute("fill") === "currentColor" &&
      !tile.querySelector("img"));
    ok("…not a product: one .product on the page for the one product, and the tile has no id or price id", sd.querySelectorAll(".product").length === 1 && !tile.classList.contains("product") &&
      !tile.querySelector("[id]") && !tile.querySelector("[data-pid]"));
    ok("…reached by the keyboard the way a product's button is: a real button in the tab order, the tile itself not a stop",
      tile.querySelector("button").tabIndex === 0 && !tile.querySelector("button").disabled && !tile.hasAttribute("tabindex"));
    ok("the header's “Gift cards” button is still there", !!sd.querySelector(".org-hero .gift-buy-btn"));
    tile.querySelector("h3").click(); await pause(20);
    ok("a click anywhere on the tile opens the gift card buy form", !!sd.querySelector(".giftbuy") && text(sd.querySelector(".giftbuy h2")) === "Gift cards" && sd.querySelectorAll(".gb-amount").length === 3);
    ok("…and nothing went in the cart", sw.eval("cart.length") === 0);
    sw.eval('renderOrgPage(document.getElementById("app"), currentOrgId, currentOrg)');
    const btn = sd.querySelector(".gift-tile button");
    btn.focus();
    ok("(the button takes the focus)", sd.activeElement === btn);
    btn.click(); await pause(20);
    ok("its button (Enter or Space presses it) opens the buy form too, and the cart stays empty", !!sd.querySelector(".giftbuy") && sw.eval("cart.length") === 0);
    sw.eval('renderOrgPage(document.getElementById("app"), currentOrgId, currentOrg)');
    sd.querySelector(".product [data-action='add']").click(); await pause(20);
    ok("adding the product puts one line in the cart: the product's, never a gift card", sw.eval("cart.length") === 1 && sw.eval("cart[0].productId || cart[0].id") !== undefined && !/gift/i.test(sw.eval("JSON.stringify(cart)")));

    // The same page drawn with the catalog's other shapes.
    const org = sw.eval("currentOrg");
    const draw = (gift, extra = {}) => { sw.renderOrgPage(sd.getElementById("app"), "club", Object.assign({}, org, { giftCards: gift }, extra)); return sd.querySelector(".gift-tile"); };
    const priceFor = (gift) => { const t = draw(Object.assign({ sellOnline: true }, gift)); return t ? text(t.querySelector(".product-price")) : null; };
    ok("the price runs from the custom minimum when it is the smallest: amounts 25, 50 with 10 to 200 → “$10 – $200”", priceFor({ amounts: [25, 50], min: 10, max: 200 }) === "$10 – $200");
    ok("…from the smallest button when it is below the minimum, and to the largest button when above the maximum", priceFor({ amounts: [5, 1000], min: 10, max: 200 }) === "$5 – $1000");
    ok("…cents shown only when not whole: 12.5 → “$12.50 – $75.25”", priceFor({ amounts: [12.5], min: 20, max: 75.25 }) === "$12.50 – $75.25");
    ok("…one figure when every amount is the same: “$25”", priceFor({ amounts: [25], min: 25, max: 25 }) === "$25");
    ok("…amounts given as text still count, and zero or missing limits are left out", priceFor({ amounts: ["30", 60], min: 0 }) === "$30 – $60");
    ok("…no usable amount at all: no tile (the header button still shows)", priceFor({ amounts: [], min: 0, max: 0 }) === null && !!sd.querySelector(".gift-buy-btn"));
    ok("selling online off: no tile and no header button", draw({ sellOnline: false, amounts: [25], min: 5, max: 500 }) === null && !sd.querySelector(".gift-buy-btn") &&
      text(sd.querySelector(".cat-heading")) === "Products" && sd.querySelector(".cat-heading").nextElementSibling.classList.contains("product"));
    ok("…sellOnline anything but true, or amounts not a list: no tile", draw({ sellOnline: "yes", amounts: [25], min: 5, max: 500 }) === null && draw({ sellOnline: true, amounts: "25", min: 5, max: 500 }) === null && draw(undefined) === null);
    ok("a shop preview never shows it", draw({ sellOnline: true, amounts: [25], min: 5, max: 500 }, { preview: true }) === null && !sd.querySelector(".gift-buy-btn"));
    ok("a shop with no products yet: the tile in its own “Gift cards” section", (() => { const t = draw({ sellOnline: true, amounts: [25], min: 5, max: 500 }, { products: [] });
      return !!t && t.closest("section").classList.contains("gift-tile-section") && sd.querySelectorAll("#catalogArea .cat-section").length === 1; })());
  }
  {
    const { sw, sd } = await shop("school", STRIPE);
    const sections = [...sd.querySelectorAll("#catalogArea .cat-section")];
    ok("a shop whose products are in category sections: a small “Gift cards” section first, holding the tile",
      sections.length === 3 && sections[0].classList.contains("gift-tile-section") && sections[0].getAttribute("aria-label") === "Gift cards" &&
      text(sections[0].querySelector(".cat-heading")) === "Gift cards" && !!sections[0].querySelector(".gift-tile") && !sections[0].querySelector(".product"));
    ok("…then the categories under their own headings, the tile in none of them", text(sections[1].querySelector(".cat-heading")) === "Shirts" && text(sections[2].querySelector(".cat-heading")) === "Caps" &&
      sd.querySelectorAll(".gift-tile").length === 1 && sd.querySelectorAll(".product").length === 2);
    ok("…and the jump links are the categories only", same([...sd.querySelectorAll(".cat-nav-link")].map(a => text(a)), ["Shirts", "Caps"]));
    sections[0].querySelector(".gift-tile").click(); await pause(20);
    ok("…a click on it opens the buy form", !!sd.querySelector(".giftbuy"));
    sw.close();
  }
  {
    const { sd } = await shop("club", {});
    ok("the same shop where card payments aren't set up (no Stripe key): no tile and no header button", !sd.querySelector(".gift-tile") && !sd.querySelector(".gift-buy-btn") && !!sd.querySelector(".product"));
  }

  finished = true;
  w.close();
})().catch((e) => { console.error(e); ok("the test ran without an exception", false); finished = true; process.exit(1); });
