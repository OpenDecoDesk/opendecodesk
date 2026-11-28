const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Gift cards and the phase 6 settings in the admin page (public/admin-giftcards.js and public/admin.js), run in jsdom
// with the real orders.js / db.js on sql.js behind fetch (migrations/0120):
//   the "Gift cards" menu button (right after Discount codes; giftcards.cards and the Gift cards feature), the
//   #giftcards and #giftcards/<id> route and loading the page's own script (ensureGiftCardsPage_);
//   the list: the money strip (giftCardTotals), the table, Status, the search box's pause, paging, late answers,
//   errors, and nothing typed read as HTML;
//   "Issue gift card": the page's own refusals, the card made, its full number shown once with Copy number, the email;
//   one card's window: the masked number and Show (audited), Copy, the facts, the history, Resend, Adjust and Void
//   (Full only), the order a card was bought with, and what a read-only role sees;
//   Global settings: the Discount codes rule, the Gift cards section and the Gift cards payment tick, all saved in the
//   one saveGlobalSettingsAll, with the page's own refusals;
//   the Discount codes page: minimum order, "Also free shipping" and the "Free shipping only" kind (one code, and
//   Codes for a list of emails).
// Invented people, shops and codes only; card numbers are made by the code. Every date shown is worked out with the
// page's own helpers in UTC, so nothing depends on the day it runs or this machine's time zone.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { issueGiftCard, voidGiftCard };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role394] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role394" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false;\n" +
  // The gift card email: whether it "went" is the test's to say.
  "const sendGiftCardEmail = async (env, o) => { globalThis.__mail394.push({ to: o.to, code: o.code, cardId: o.card && o.card.id }); return globalThis.__mailOk394; };\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

(async () => {
  globalThis.__role394 = "admin";
  globalThis.__mail394 = [];
  globalThis.__mailOk394 = true;
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  let stripeKey394 = "";   // card payments set up (an invented key) for the Global settings → Gift cards part
  const call = async (body) => {
    const waits = [];
    const res = await api({ env: { DB: d1, ...(stripeKey394 ? { STRIPE_SECRET_KEY: stripeKey394 } : {}) }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const must = async (body) => { const r = await call(body); if (r.status !== 200) throw new Error("seed " + body.action + ": " + JSON.stringify(r.body)); return r.body; };
  const cardRow = (id) => d1.q("SELECT * FROM gift_cards WHERE id = ?", id)[0];
  const ledgerOf = (id) => d1.q("SELECT * FROM gift_card_ledger WHERE cardId = ? ORDER BY id", id);
  const auditOf = (action) => d1.q("SELECT * FROM audit_log WHERE action = ? ORDER BY id", action);
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t');`);

  // ---- The page ---------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), giftJs = read("public/admin-giftcards.js");
  const sent = [], toasts = [], clipboard = [], served = [];
  let scripted = [];       // [{ action, status, body | throws }]: the next request for that action is answered with this
  let hold = null;         // { action, gate }: the next request for that action waits for gate
  let giftMode = "ok";     // "fail": /admin-giftcards.js can't be fetched
  let giftGate = null;     // a promise: /admin-giftcards.js arrives when it settles
  let clipboardMode = "ok";   // "fails": writeText rejects; "none": no navigator.clipboard
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      served.push(String(url));
      if (/\/admin-giftcards\.js(\?|$)/.test(url)) return giftMode === "fail" ? Promise.reject(new Error("offline")) : Promise.resolve(giftGate).then(() => Buffer.from(giftJs));
      if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs));
      return Promise.resolve(Buffer.from(""));
    }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented|Could not load script: "https:\/\/admin\.example\.com\/admin-giftcards\.js/.test(e.message)) console.error(e); });
  let inflight = 0;
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.scrollTo = () => {};
      Object.defineProperty(win.navigator, "clipboard", { configurable: true, get: () => clipboardMode === "none" ? undefined : {
        writeText: async (t) => { if (clipboardMode === "fails") throw new Error("denied"); clipboard.push(String(t)); } } });
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(b); inflight++;
        try {
          const i = scripted.findIndex(s => s.action === b.action);
          if (i >= 0) { const s = scripted.splice(i, 1)[0]; if (s.throws) throw new Error(s.throws); return reply(s.status || 200, s.body); }
          if (hold && hold.action === b.action) { const h = hold; hold = null; await h.gate; }
          const x = await call(b);
          return reply(x.status, x.body);
        } finally { inflight--; }
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC");');
  w.eval('adminOrgs = [{ orgId: "club", name: "Example Club" }];');
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const id = (s) => d.getElementById(s);
  const app = id("app");
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const reset = () => { sent.length = 0; toasts.length = 0; clipboard.length = 0; globalThis.__mail394.length = 0; };
  const of = (action) => sent.filter(b => b.action === action).map(b => { const c = Object.assign({}, b); delete c.key; return c; });
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const hashNow = () => w.location.hash.replace(/^#\/?/, "");
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const levelsOf = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role]);
  const asRoles = (pageRole, serverRole) => { globalThis.__role394 = serverRole || pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  const signInWith = (perms, serverRole) => { globalThis.__role394 = serverRole || "admin"; w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(perms)}; adminAreas = ${JSON.stringify(roles.PERMISSION_AREAS)};`); };
  const withLevels = (role, changes) => Object.assign({}, levelsOf(role), changes);
  const features = (f) => w.applyFeatures_(f);
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const confirmBox = () => q(".confirm-modal");
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const type = (el, v) => { el.value = v; fire(el, "input"); };
  const pick = (el, v) => { el.value = v; fire(el, "change"); };
  const tick = (el, v) => { el.checked = v; fire(el, "change"); };
  const money = (n) => w.adminMoney_(n);
  const day = (v) => w.adminDate_(v);
  const when = (v) => w.adminDateTime_(v);
  const rowButtons = () => qa("#adminNav .admin-nav-row > button.admin-nav-btn");
  const hashes = (btns) => btns.map(b => b.dataset.h);
  const off = (el) => !!el && el.hasAttribute("data-perm-off");
  const page = () => id("gcPage");
  const listDrawn = () => !!(page() && !/Loading…/.test(id("gcBody").textContent));
  const go = async (hash = "giftcards") => { const old = page(); if (hashNow() === hash) w.adminRoute(); else w.location.hash = "#" + hash; await wait(() => page() && page() !== old && listDrawn()); await idle(); };
  const rows = () => qa("#gcBody table.gc-table tbody tr");
  const cellsOf = (tr) => [...tr.children].map(td => text(td));
  const rowOf = (last4) => rows().find(tr => text(tr.children[0]) === "••" + last4);
  const fetchedGift = () => served.filter(u => /\/admin-giftcards\.js$/.test(u)).length;
  asRoles("admin");

  // ==============================================================================================================
  console.log("=== The Gift cards button in the menu ===");
  // ==============================================================================================================
  w.renderAdminNav();
  { const row = hashes(rowButtons());
    const btn = rowButtons().find(b => b.dataset.h === "giftcards");
    ok("an admin's top buttons have “Gift cards”, once", row.filter(h => h === "giftcards").length === 1 && !!btn && btn.textContent === "Gift cards");
    ok("…right after Discount codes", row[row.indexOf("giftcards") - 1] === "discounts");
    ok("…a button that goes to #giftcards like the others", btn.dataset.adminAction === "navGo" && btn.type === "button"); }
  ok("the page's own script isn't loaded until Gift cards is opened", fetchedGift() === 0 && typeof w.renderGiftCards !== "function");
  ok("(the built-in roles) Admin and Manager have Full on Gift cards, Back office Edit, Production none",
    levelsOf("admin")["giftcards.cards"] === "full" && levelsOf("manager")["giftcards.cards"] === "full" && levelsOf("staff")["giftcards.cards"] === "edit" && levelsOf("production")["giftcards.cards"] === "none");
  for (const [role, label] of [["manager", "Manager"], ["staff", "Back office"]]) {
    asRoles(role); w.renderAdminNav();
    ok(label + " gets the button too", hashes(rowButtons()).includes("giftcards") && w.adminCanOpen_("giftcards") === true);
  }
  asRoles("production"); w.renderAdminNav();
  ok("Production, with no access, gets no button and can't open the page", rowButtons().length > 0 && !hashes(rowButtons()).includes("giftcards") && w.adminCanOpen_("giftcards") === false && w.adminCanGiftCards_() === false);
  signInWith(withLevels("admin", { "giftcards.cards": "read" })); w.renderAdminNav();
  ok("Read on Gift cards is enough for the button", hashes(rowButtons()).includes("giftcards") && w.adminCanGiftCards_() === true && w.adminCanOpen_("giftcards/3") === true);
  signInWith(withLevels("admin", { "giftcards.cards": "none" })); w.renderAdminNav();
  ok("None on Gift cards: no button, even with everything else", !hashes(rowButtons()).includes("giftcards") && hashes(rowButtons()).includes("discounts") && w.adminCanOpen_("giftcards") === false);
  signInWith(withLevels("admin", { "discounts.codes": "none" })); w.renderAdminNav();
  { const row = hashes(rowButtons());
    ok("a role without Discount codes gets Gift cards where they would be: right after Quotes", !row.includes("discounts") && row[row.indexOf("giftcards") - 1] === "quotes"); }
  signInWith(withLevels("admin", { "discounts.codes": "none", "quotes.estimates": "none", "customers.records": "none" })); w.renderAdminNav();
  { const row = hashes(rowButtons());
    ok("…and without Quotes and Customers either, right after Orders", !row.includes("quotes") && !row.includes("customers") && row[row.indexOf("giftcards") - 1] === "orders"); }
  asRoles("admin");
  features({ giftCards: false }); w.renderAdminNav();
  ok("with the Gift cards feature turned off there is no button, even for an admin", !hashes(rowButtons()).includes("giftcards") && hashes(rowButtons()).includes("discounts") && w.adminCanOpen_("giftcards") === false);
  ok("…the page belongs to the Gift cards feature, named “Gift cards”", w.adminPageFeature_("giftcards/4") === "giftCards" && w.eval("FEATURE_LABELS_.giftCards") === "Gift cards");
  reset();
  w.location.hash = "#giftcards";
  await wait(() => !!id("featureOffPanel"));
  ok("…#giftcards says “Gift cards is turned off”, loads nothing and asks the server for nothing",
    /Gift cards is turned off/.test(app.textContent) && id("featureOffPanel").dataset.feature === "giftCards" && sent.length === 0 && fetchedGift() === 0);
  features({}); w.renderAdminNav();
  ok("…and the button is back when it is on again", hashes(rowButtons()).includes("giftcards"));
  asRoles("production");
  w.location.hash = "#home"; await idle();
  reset();
  w.location.hash = "#giftcards/5";
  await wait(() => !!id("roleOffPanel"));
  ok("a role without it is told “Not available to you” at a card's address, and nothing is asked for or loaded", /Not available to you\./.test(app.textContent) && sent.length === 0 && fetchedGift() === 0);
  asRoles("admin");
  ok("a card's address lights Gift cards in the menu", (() => { w.eval('history.replaceState(null, "", "#giftcards/7")'); const a = w.adminNavActive_(); w.eval('history.replaceState(null, "", "#home")'); return a === "giftcards"; })());

  // ==============================================================================================================
  console.log("\n=== The #giftcards route and the page's script (ensureGiftCardsPage_) ===");
  // ==============================================================================================================
  w.location.hash = "#home"; await idle();
  giftMode = "fail";
  reset();
  w.location.hash = "#giftcards";
  await wait(() => /Couldn't load the Gift cards page/.test(app.textContent));
  ok("the script can't be loaded: “Couldn't load the Gift cards page. Check your connection and reload the page.”", text(q("#app .admin-empty")) === "Couldn't load the Gift cards page. Check your connection and reload the page.");
  ok("…under the Gift cards heading and the tab's title, and the address stays #giftcards", text(q("#app h1")) === "Gift cards" && /Gift cards \(Admin\)$/.test(d.title) && hashNow() === "giftcards");
  ok("…the script was asked for at /admin-giftcards.js, and its tag taken out again", fetchedGift() === 1 && !q('script[src="/admin-giftcards.js"]') && sent.length === 0);
  { let refused = null; try { await w.ensureGiftCardsPage_(); } catch (e) { refused = e; }
    ok("ensureGiftCardsPage_ fails with a plain sentence and asks again each time", !!refused && refused.message === "Couldn't load the Gift cards page" && fetchedGift() === 2); }
  giftMode = "ok";
  { let release; giftGate = new Promise(r => { release = r; });
    reset();
    w.location.hash = "#home"; await idle();
    w.location.hash = "#giftcards";
    await wait(() => fetchedGift() === 3);
    const p1 = w.ensureGiftCardsPage_(), p2 = w.ensureGiftCardsPage_();
    ok("while the script is on its way, everyone who asks waits for the same one", p1 === p2 && fetchedGift() === 3);
    w.location.hash = "#home";
    await wait(() => !/Gift cards/.test(text(q("#app h1"))));
    release(); giftGate = null; await p1; await pause(80); await idle();
    ok("…and when it arrives after the admin went elsewhere, the Gift cards page isn't drawn over that page", !page() && hashNow() === "home" && of("listGiftCards").length === 0 && typeof w.renderGiftCards === "function"); }

  // ==============================================================================================================
  console.log("\n=== The page with no cards yet ===");
  // ==============================================================================================================
  reset();
  await go();
  const today = w.localToday_(), monthStart = today.slice(0, 8) + "01";
  ok("#giftcards draws “Gift cards”, the tab's title too, lit in the menu", text(q("#app h1")) === "Gift cards" && /Gift cards \(Admin\)$/.test(d.title) && hashNow() === "giftcards" && w.adminNavActive_() === "giftcards");
  ok("the script, once loaded, isn't asked for again", fetchedGift() === 3);
  ok("it asked for the first page: every status (sent as nothing), no search, 50 at a time", same(of("listGiftCards"), [{ action: "listGiftCards", q: "", status: "", limit: 50, offset: 0 }]));
  ok("…and the money strip for this month: from its first day to today", same(of("giftCardTotals"), [{ action: "giftCardTotals", dateFrom: monthStart, dateTo: today }]));
  ok("with none at all: “No gift cards yet. Make one with “Issue gift card”.”, no count, no pager", text(id("gcBody")) === "No gift cards yet. Make one with “Issue gift card”." && id("gcCount").textContent === "" && id("gcPager").innerHTML === "");
  ok("the strip: Still on cards (owed to customers), Sold this month, Spent this month — all $0.00",
    same(qa("#gcTotals .gc-total").map(c => [...c.children].map(x => x.className + "=" + x.textContent).join(" | ")),
      ["gc-total-n=$0.00 | gc-total-l=Still on cards | gc-total-note=Owed to customers as spending money", "gc-total-n=$0.00 | gc-total-l=Sold this month", "gc-total-n=$0.00 | gc-total-l=Spent this month"]));
  ok("the toolbar: Search (last 4 digits, name, email or order), Status (All, Active, Void — All chosen), and “Issue gift card” needing Edit",
    id("gcQ").type === "search" && id("gcQ").placeholder === "Last 4 digits, name, email or order" && id("gcQ").maxLength === 200 &&
    same([...id("gcStatus").options].map(o => o.value + "=" + o.textContent), ["all=All", "active=Active", "void=Void"]) && id("gcStatus").value === "all" &&
    text(id("gcNew")) === "Issue gift card" && id("gcNew").getAttribute("data-need") === "giftcards.cards:edit" && !off(id("gcNew")));
  ok("the note under it: a gift card is a payment, not a discount, never expires, isn't revenue until spent",
    /A gift card is a payment, not a discount: it pays part or all of an order after any discount codes, shipping and tax\. It never expires and can't be cashed out\. The money isn't sales until it is spent, so selling a card doesn't count as revenue\./.test(text(page())));
  asRoles("staff");
  await go();
  ok("Back office (Edit) is offered “Issue gift card” too", text(id("gcBody")) === "No gift cards yet. Make one with “Issue gift card”." && !off(id("gcNew")));
  signInWith(withLevels("admin", { "giftcards.cards": "read" }));
  await go();
  ok("a role with Read only: “No gift cards yet.” and Issue gift card hidden", text(id("gcBody")) === "No gift cards yet." && off(id("gcNew")));
  asRoles("admin");
  scripted.push({ action: "giftCardTotals", body: { status: "ok", outstanding: 12.5, soldCents: 700 } });
  await go();
  ok("a strip answered with its figures at the top (or in cents) is read the same", same(qa("#gcTotals .gc-total-n").map(c => c.textContent), ["$12.50", "$7.00", "$0.00"]));
  scripted.push({ action: "giftCardTotals", status: 500, body: { status: "error", message: "down" } });
  await go();
  ok("a strip the server can't give is left empty (no zeros), and the list still works", id("gcTotals").innerHTML === "" && listDrawn() && !q("#gcBody .cust-err"));

  // ---- The cards ------------------------------------------------------------------------------------------------
  const ROBIN = '<img src=x onerror="window.__xss394=1">Robin';
  const mkCard = async (p) => { const r = await lib.issueGiftCard(d1, Object.assign({ by: "owner@example.test" }, p)); if (!r || !r.id) throw new Error("seed card: " + JSON.stringify(r)); return r; };
  const cPat = await mkCard({ amountCents: 5000, recipientName: "Pat Example", recipientEmail: "pat@example.com", message: "Happy <b>birthday</b>", note: "Paid cash at the show", now: "2026-03-01T15:00:00.000Z" });
  const cOnline = await mkCard({ amountCents: 2500, recipientName: ROBIN, buyerName: "Sam Example", buyerEmail: "sam@example.com", sourceOrderId: "CLUB-GC-1", now: "2026-03-02T15:00:00.000Z" });
  const cEmpty = await mkCard({ amountCents: 1000, recipientEmail: "lee@example.com", now: "2026-03-03T15:00:00.000Z" });
  const cVoid = await mkCard({ amountCents: 2000, recipientName: "Kim Example", now: "2026-03-04T15:00:00.000Z" });
  const cBare = await mkCard({ amountCents: 1500, now: "2026-03-05T15:00:00.000Z" });
  // Spent and put back (as an order's payment would): the ledger rows and the balance.
  d1.q("INSERT INTO gift_card_ledger (cardId, kind, deltaCents, orderId, paymentId, note, at, by) VALUES (?, 'redeem', -1250, 'CLUB-7', NULL, 'Order CLUB-7', '2026-03-06T15:00:00.000Z', 'owner@example.test')", cPat.id);
  d1.q("INSERT INTO gift_card_ledger (cardId, kind, deltaCents, orderId, paymentId, note, at, by) VALUES (?, 'refund', 250, 'CLUB-7', NULL, 'Payment voided', '2026-03-07T15:00:00.000Z', 'owner@example.test')", cPat.id);
  d1.q("UPDATE gift_cards SET balanceCents = 4000 WHERE id = ?", cPat.id);
  d1.q("INSERT INTO gift_card_ledger (cardId, kind, deltaCents, orderId, paymentId, note, at, by) VALUES (?, 'redeem', -1000, 'CLUB-8', NULL, 'Order CLUB-8', '2026-03-08T15:00:00.000Z', 'owner@example.test')", cEmpty.id);
  d1.q("UPDATE gift_cards SET balanceCents = 0 WHERE id = ?", cEmpty.id);
  await lib.voidGiftCard(d1, { id: cVoid.id, note: "Lost", by: "owner@example.test", now: "2026-03-09T15:00:00.000Z" });

  // ==============================================================================================================
  console.log("\n=== The list ===");
  // ==============================================================================================================
  reset();
  await go();
  ok("the table's columns: Card, Balance, Issued for, For, From, Issued, Status", same(qa("#gcBody table.gc-table thead th").map(th => th.textContent), ["Card", "Balance", "Issued for", "For", "From", "Issued", "Status"]));
  ok("one row a card, by its last four only, newest first", same(rows().map(tr => text(tr.children[0])), [cBare, cVoid, cEmpty, cOnline, cPat].map(c => "••" + c.last4)));
  ok("no full card number anywhere on the list", ![cBare, cVoid, cEmpty, cOnline, cPat].some(c => page().innerHTML.includes(c.code)));
  ok("the count: “5 cards”, and no pager for one page", id("gcCount").textContent === "5 cards" && id("gcPager").innerHTML.trim() === "");
  ok("Pat's card: $40.00 left of $50.00, for Pat, from the shop, its day, Active",
    same(cellsOf(rowOf(cPat.last4)), ["••" + cPat.last4, "$40.00", "$50.00", "Pat Example", "The shop", day("2026-03-01T15:00:00.000Z"), "Active"]));
  ok("a card bought online: the buyer's name and an “Online” tag naming the order on hover; the recipient's name as text",
    same(cellsOf(rowOf(cOnline.last4)), ["••" + cOnline.last4, "$25.00", "$25.00", ROBIN, "Sam Example Online", day("2026-03-02T15:00:00.000Z"), "Active"]) &&
    rowOf(cOnline.last4).querySelector(".cust-tag").title === "Bought on the shop with order CLUB-GC-1" && !page().querySelector("table img") && w.__xss394 === undefined);
  ok("a card with only an email: the email under For; nothing left: “Used up”",
    same(cellsOf(rowOf(cEmpty.last4)).slice(1), ["$0.00", "$10.00", "lee@example.com", "The shop", day("2026-03-03T15:00:00.000Z"), "Used up"]));
  ok("a voided card: “Void” (a warning tag), $0.00, its row greyed", cellsOf(rowOf(cVoid.last4))[6] === "Void" && !!rowOf(cVoid.last4).querySelector(".cust-tag-warn") &&
    cellsOf(rowOf(cVoid.last4))[1] === "$0.00" && rowOf(cVoid.last4).classList.contains("cust-row-archived") && !rowOf(cPat.last4).classList.contains("cust-row-archived"));
  ok("a card for nobody in particular: For is empty", cellsOf(rowOf(cBare.last4))[3] === "");
  ok("each card's number is a link to #giftcards/<id>", rows().every(tr => { const a = tr.children[0].querySelector("a[data-gc-open]"); return !!a && /^#giftcards\/\d+$/.test(a.getAttribute("href")); }) &&
    rowOf(cPat.last4).querySelector("a").getAttribute("href") === "#giftcards/" + cPat.id);
  { const t = await call({ action: "giftCardTotals", dateFrom: monthStart, dateTo: today });
    ok("the strip shows what the server says: $80.00 still on active cards (not the voided one), and this month's sold and spent",
      t.body.totals.outstanding === 80 && same(qa("#gcTotals .gc-total-n").map(c => c.textContent), [money(80), money(t.body.totals.sold), money(t.body.totals.redeemed)])); }
  ok("(the active-card tag has its own style, and the strip, in admin.css)", /\.gc-tag-on\b[^{]*\{[^}]*background/.test(read("public/admin.css")) && /\.gc-totals?\b/.test(read("public/admin.css")));

  console.log("\n=== Status and search ===");
  reset();
  pick(id("gcStatus"), "active");
  await wait(() => of("listGiftCards").length === 1 && listDrawn()); await idle();
  ok("Status → Active asks for active cards from the first page: those with money left", same(of("listGiftCards")[0], { action: "listGiftCards", q: "", status: "active", limit: 50, offset: 0 }) &&
    same(rows().map(tr => text(tr.children[0])), [cBare, cOnline, cPat].map(c => "••" + c.last4)) && id("gcCount").textContent === "3 cards");
  reset();
  pick(id("gcStatus"), "void");
  await wait(() => of("listGiftCards").length === 1 && listDrawn()); await idle();
  ok("Void shows the voided card, “1 card”", of("listGiftCards")[0].status === "void" && same(rows().map(tr => text(tr.children[0])), ["••" + cVoid.last4]) && id("gcCount").textContent === "1 card");
  await go();
  ok("drawn again (left and come back), Status still Void", id("gcStatus").value === "void" && of("listGiftCards").pop().status === "void");
  reset();
  pick(id("gcStatus"), "all"); await idle();
  ok("All again sends no status", of("listGiftCards")[0].status === "");
  reset();
  type(id("gcQ"), "  pat");
  await pause(80);
  ok("typing in Search asks nothing at once", of("listGiftCards").length === 0);
  type(id("gcQ"), "  pat@example ");
  await pause(150);
  ok("…nor while typing goes on", of("listGiftCards").length === 0);
  await wait(() => of("listGiftCards").length === 1); await idle();
  ok("…then, after the pause, one request with what was typed, trimmed, from the first page",
    of("listGiftCards").length === 1 && same(of("listGiftCards")[0], { action: "listGiftCards", q: "pat@example", status: "", limit: 50, offset: 0 }) && same(rows().map(tr => text(tr.children[0])), ["••" + cPat.last4]));
  reset();
  type(id("gcQ"), "CLUB-GC"); await wait(() => of("listGiftCards").length === 1); await idle();
  ok("search finds a card by the order that bought it", same(rows().map(tr => text(tr.children[0])), ["••" + cOnline.last4]));
  type(id("gcQ"), cEmpty.last4); await wait(() => rows().length === 1 && text(rows()[0].children[0]) === "••" + cEmpty.last4); await idle();
  ok("…and by its last four", rows().length === 1);
  type(id("gcQ"), "nothing-like-it"); await wait(() => /No gift card matches/.test(text(id("gcBody")))); await idle();
  ok("nothing matching: “No gift card matches.”, no count, no pager", text(id("gcBody")) === "No gift card matches." && id("gcCount").textContent === "" && id("gcPager").innerHTML === "");
  await go();
  ok("leaving and coming back keeps the search", id("gcQ").value === "nothing-like-it" && of("listGiftCards").pop().q === "nothing-like-it");
  type(id("gcQ"), ""); await wait(() => rows().length === 5); await idle();
  reset(); fire(id("gcStatus"), "input"); await pause(320);
  ok("an input event from another field asks nothing", of("listGiftCards").length === 0);
  scripted.push({ action: "listGiftCards", body: { status: "ok", cards: [], total: 0 } });
  pick(id("gcStatus"), "void"); await wait(() => /No gift card/.test(text(id("gcBody")))); await idle();
  ok("a status filter alone with nothing found also says “No gift card matches.”", text(id("gcBody")) === "No gift card matches." && id("gcQ").value === "");
  pick(id("gcStatus"), "all"); await idle();
  { const fake = [{ id: 901, last4: "AB12", balanceCents: 1234, initialCents: 5000, recipientName: "", recipientEmail: "", buyerName: "", buyerEmail: "jo@example.com", sourceOrderId: "", status: "active", createdAt: "" }];
    scripted.push({ action: "listGiftCards", body: { status: "ok", cards: fake } });
    await go();
    ok("an answer without a total counts the cards it has; a card's money given only in cents is shown in dollars",
      id("gcCount").textContent === "1 card" && same(cellsOf(rows()[0]), ["••AB12", "$12.34", "$50.00", "", "jo@example.com", "", "Active"])); }
  scripted.push({ action: "listGiftCards", body: { status: "ok", cards: [{ id: 902, status: "active" }] } });
  await go();
  ok("a card the server says nothing about shows $0.00, “Used up”, and an empty last four", same(cellsOf(rows()[0]), ["••", "$0.00", "$0.00", "", "The shop", "", "Used up"]));
  scripted.push({ action: "listGiftCards", body: { status: "ok", total: 0 } });
  await go();
  ok("an answer without a cards list is an empty list", text(id("gcBody")) === "No gift cards yet. Make one with “Issue gift card”.");
  scripted.push({ action: "listGiftCards", status: 503, body: { status: "error", message: "Gift cards aren't <ready> yet." } });
  await go();
  ok("the server refuses: its message in place of the list, as text, no count or pager", text(id("gcBody")) === "Gift cards aren't <ready> yet." && !!id("gcBody").querySelector(".cust-err[role=alert]") &&
    !id("gcBody").querySelector("ready") && id("gcCount").textContent === "" && id("gcPager").innerHTML === "");
  await go();

  console.log("\n=== Paging ===");
  for (let i = 0; i < 55; i++) await mkCard({ amountCents: 100 + i, recipientName: "Bulk " + i, now: "2026-01-01T00:00:" + String(i % 60).padStart(2, "0") + ".000Z" });
  await go();
  ok("60 cards: the first 50, “Showing 1–50 of 60 cards”", rows().length === 50 && id("gcCount").textContent === "Showing 1–50 of 60 cards");
  const pg = (which) => q(`#gcPager button[data-gc-page="${which}"]`);
  ok("…‹ Previous is off, Next › is on", !!pg("prev") && pg("prev").disabled && !pg("next").disabled && text(pg("prev")) === "‹ Previous" && text(pg("next")) === "Next ›");
  reset(); pg("next").click();
  await wait(() => of("listGiftCards").length === 1 && listDrawn()); await idle();
  ok("Next › asks for offset 50 and shows 51–60, Next now off", of("listGiftCards")[0].offset === 50 && rows().length === 10 && id("gcCount").textContent === "Showing 51–60 of 60 cards" && !pg("prev").disabled && pg("next").disabled);
  reset(); pg("prev").click();
  await wait(() => of("listGiftCards").length === 1 && listDrawn()); await idle();
  ok("‹ Previous goes back to offset 0", of("listGiftCards")[0].offset === 0 && rows().length === 50);
  pg("next").click(); await wait(() => rows().length === 10); await idle();
  reset();
  pick(id("gcStatus"), "active"); await wait(() => of("listGiftCards").length === 1 && listDrawn()); await idle();
  ok("a filter changed on page 2 starts again at the first page", of("listGiftCards")[0].offset === 0);
  pick(id("gcStatus"), "all"); await idle();
  pg("next").click(); await wait(() => rows().length === 10); await idle();
  d1.q("DELETE FROM gift_card_ledger WHERE cardId IN (SELECT id FROM gift_cards WHERE recipientName LIKE 'Bulk %')");
  d1.q("DELETE FROM gift_cards WHERE recipientName LIKE 'Bulk %'");
  reset();
  await go();
  ok("a page that's gone empty (its cards gone) goes back to the first page by itself, with no pager",
    same(of("listGiftCards").map(b => b.offset), [50, 0]) && rows().length === 5 && id("gcCount").textContent === "5 cards" && id("gcPager").innerHTML.trim() === "");

  console.log("\n=== A slower, older answer is never drawn over a newer one ===");
  { let release; hold = { action: "listGiftCards", gate: new Promise(r => { release = r; }) };
    reset();
    pick(id("gcStatus"), "void");
    await wait(() => of("listGiftCards").length === 1);
    pick(id("gcStatus"), "active");
    await wait(() => of("listGiftCards").length === 2 && rows().length === 3); await idle();
    ok("the newer answer (Active) is drawn", rows().length === 3);
    release(); await pause(50); await idle();
    ok("…and when the older one (Void) arrives late it is dropped", rows().length === 3); }
  { let fail; hold = { action: "listGiftCards", gate: new Promise((_, rej) => { fail = rej; }) };
    reset();
    pick(id("gcStatus"), "void");
    await wait(() => of("listGiftCards").length === 1);
    pick(id("gcStatus"), "all");
    await wait(() => of("listGiftCards").length === 2 && rows().length === 5); await idle();
    fail(new Error("offline")); await pause(50); await idle();
    ok("an older request that fails after a newer answer was drawn shows no error over it", rows().length === 5 && !id("gcBody").querySelector(".cust-err")); }
  { let release; hold = { action: "listGiftCards", gate: new Promise(r => { release = r; }) };
    reset();
    pick(id("gcStatus"), "void");
    await wait(() => of("listGiftCards").length === 1);
    w.location.hash = "#home";
    await wait(() => !page()); await idle();
    release(); await pause(50); await idle();
    ok("an answer that arrives after leaving the page draws nothing", !page() && !id("gcBody")); }
  { let fail; hold = { action: "listGiftCards", gate: new Promise((_, rej) => { fail = rej; }) };
    reset();
    w.location.hash = "#giftcards";
    await wait(() => of("listGiftCards").length === 1);
    const before = page();
    w.location.hash = "#home";
    await wait(() => !page()); await idle();
    fail(new Error("offline")); await pause(50); await idle();
    ok("…nor does one that fails after leaving", !before.isConnected && !page() && !q(".cust-err")); }
  { let release; hold = { action: "giftCardTotals", gate: new Promise(r => { release = r; }) };
    reset();
    w.location.hash = "#giftcards";
    await wait(() => of("giftCardTotals").length === 1 && listDrawn());
    const before = page();
    w.location.hash = "#home";
    await wait(() => !page()); await idle();
    release(); await pause(50); await idle();
    ok("a money strip that arrives after leaving is dropped too", !before.isConnected && before.querySelector("#gcTotals").innerHTML === ""); }
  await go();
  if (id("gcStatus").value !== "all") { pick(id("gcStatus"), "all"); await idle(); }

  // ==============================================================================================================
  console.log("\n=== Issue gift card ===");
  // ==============================================================================================================
  const issueWin = () => { const m = modal(); return m && m.querySelector("#gcIssueForm") ? m : null; };
  const $i = (sel) => issueWin() && issueWin().querySelector(sel);
  const answer = async (yes) => { await wait(() => confirmBox()); const box = confirmBox(); const info = { title: text(box.querySelector("[data-dialog-title]")), text: text(box.querySelector(".cm-text")), okLabel: box.querySelector("#cmOk").textContent, cancelLabel: box.querySelector("#cmCancel").textContent };
    box.querySelector(yes ? "#cmOk" : "#cmCancel").click(); await wait(() => !confirmBox()); return info; };
  const openIssue = async () => { id("gcNew").click(); await wait(() => !!issueWin()); return issueWin(); };
  reset();
  await openIssue();
  ok("“Issue gift card” opens a window of that name, asking the server nothing", text(issueWin().querySelector("[data-dialog-title]")) === "Issue gift card" && sent.length === 0);
  ok("…its fields: Amount ($1 to $1,000,000), For (name), Their email, Message (up to 300), Note, and “Email it to them now” unticked",
    $i("#gcAmount").type === "number" && $i("#gcAmount").min === "1" && $i("#gcAmount").max === "1000000" && $i("#gcRecipName").maxLength === 200 && $i("#gcRecipEmail").type === "email" &&
    $i("#gcMessage").maxLength === 300 && /up to 300 characters/.test(text($i("#gcMessage").closest("label"))) && $i("#gcNote").maxLength === 200 && !!$i("#gcSend") && !$i("#gcSend").checked &&
    text($i("#gcIssueSave")) === "Issue card" && $i("#gcIssueForm").getAttribute("data-need-form") === "giftcards.cards:edit");
  $i("#gcIssueCancel").click(); await wait(() => !issueWin());
  ok("Cancel with nothing typed closes it without asking", !issueWin() && !confirmBox());
  await openIssue();
  type($i("#gcAmount"), "20");
  $i("#gcIssueCancel").click();
  { const asked = await answer(false);
    ok("Cancel after typing asks “Discard changes?” first; Keep editing keeps the window", asked.title === "Discard changes?" && !!issueWin() && $i("#gcAmount").value === "20"); }
  for (const bad of ["", "0.99", "1000000.01", "1.234", "-5"]) {
    type($i("#gcAmount"), bad);
    reset(); fire($i("#gcIssueForm"), "submit"); await idle();
    if (!ok("an amount of “" + bad + "”: “Enter an amount from $1 to $1,000,000.”, nothing sent", text($i("#gcIssueErr")) === "Enter an amount from $1 to $1,000,000." && sent.length === 0)) break;
  }
  type($i("#gcAmount"), "50");
  type($i("#gcRecipEmail"), "pat@");
  reset(); fire($i("#gcIssueForm"), "submit"); await idle();
  ok("an email that isn't one: “Enter a valid email address, or leave it blank.”", text($i("#gcIssueErr")) === "Enter a valid email address, or leave it blank." && sent.length === 0);
  type($i("#gcRecipEmail"), "");
  tick($i("#gcSend"), true);
  fire($i("#gcIssueForm"), "submit"); await idle();
  ok("“Email it to them now” with no email: “Enter their email address to email the card.”", text($i("#gcIssueErr")) === "Enter their email address to email the card." && sent.length === 0);
  tick($i("#gcSend"), false);
  type($i("#gcAmount"), "1000.5");
  type($i("#gcRecipName"), "  Jo <i>Example</i>  ");
  type($i("#gcMessage"), "  " + "m".repeat(305) + "  ");
  type($i("#gcNote"), "  Store credit  ");
  scripted.push({ action: "issueGiftCard", status: 400, body: { status: "error", message: "Gift cards aren't <ready>." } });
  reset(); fire($i("#gcIssueForm"), "submit"); await idle();
  ok("the server refuses: its message in the window, as text, and Issue card can be pressed again", text($i("#gcIssueErr")) === "Gift cards aren't <ready>." && !$i("#gcIssueErr").querySelector("ready") && $i("#gcIssueSave").disabled === false && !$i("#gcIssueForm").hidden);
  const firstTry = of("issueGiftCard")[0];
  const before = d1.q("SELECT count(*) AS n FROM gift_cards")[0].n;
  reset(); fire($i("#gcIssueForm"), "submit");
  await wait(() => !!issueWin() && !issueWin().querySelector("#gcIssued").hidden); await idle();
  const madeRow = d1.q("SELECT * FROM gift_cards ORDER BY id DESC LIMIT 1")[0];
  ok("Issue card sends issueGiftCard with the amount in cents, the name, message (trimmed, 300 at most) and note, no email",
    of("issueGiftCard").length === 1 && (() => { const b = of("issueGiftCard")[0]; return b.amountCents === 100050 && b.recipientName === "Jo <i>Example</i>" && b.recipientEmail === "" && b.message === "m".repeat(300) && b.note === "Store credit" && b.sendEmail === false; })());
  ok("…with the same request id as the refused try, so a retry can't make two cards", typeof firstTry.requestId === "string" && firstTry.requestId.length > 8 && of("issueGiftCard")[0].requestId === firstTry.requestId);
  ok("…one card made: $1,000.50, for the name as typed", d1.q("SELECT count(*) AS n FROM gift_cards")[0].n === before + 1 && madeRow.initialCents === 100050 && madeRow.recipientName === "Jo <i>Example</i>");
  { const box = issueWin().querySelector("#gcIssued");
    ok("the form gives way to the result: “Gift card ••XXXX for $1,000.50 is ready.”", $i("#gcIssueForm").hidden && text(box.querySelector(".gc-issued-h")) === "Gift card ••" + madeRow.last4 + " for $1,000.50 is ready.");
    ok("…the whole number, once, in four groups", text(box.querySelector("#gcIssuedCode")) === madeRow.code.match(/.{4}/g).join("-"));
    ok("…“Give this number to the customer. It can be shown again from the card's window.”, and no email line", /Give this number to the customer\. It can be shown again from the card's window\./.test(text(box)) && !/emailed/.test(text(box)));
    ok("…toast “Gift card ••XXXX issued.”, and the list and strip asked for again", lastToast().m === "Gift card ••" + madeRow.last4 + " issued." && !lastToast().err && of("listGiftCards").length === 1 && of("giftCardTotals").length === 1);
    box.querySelector("#gcCopy").click(); await pause(20);
    ok("Copy number puts the grouped number on the clipboard: “Card number copied.”", same(clipboard, [madeRow.code.match(/.{4}/g).join("-")]) && lastToast().m === "Card number copied.");
    clipboardMode = "fails"; let copiedVia = null;
    d.execCommand = (c) => { copiedVia = c; return true; };
    box.querySelector("#gcCopy").click(); await pause(20);
    ok("a clipboard that refuses: copied the old way (a hidden box, “copy”), still “Card number copied.”, the box taken away", copiedVia === "copy" && lastToast().m === "Card number copied." && !q("body > textarea"));
    clipboardMode = "none"; d.execCommand = () => { throw new Error("no"); };
    box.querySelector("#gcCopy").click(); await pause(20);
    ok("no clipboard and no copy: “Couldn't copy — select it and copy by hand.”", lastToast().m === "Couldn't copy — select it and copy by hand." && lastToast().err && !q("body > textarea"));
    clipboardMode = "ok"; delete d.execCommand;
    await idle();
    ok("the new card is at the top of the list behind it", text(rows()[0].children[0]) === "••" + madeRow.last4); }
  issueWin().querySelector("#gcIssuedDone").click();
  await pause(30);
  ok("Done closes the window without asking to discard anything (the card is saved)", !issueWin() && !confirmBox());
  if (confirmBox()) await answer(true);

  console.log("\n=== Issue and email it ===");
  await openIssue();
  type($i("#gcAmount"), "25"); type($i("#gcRecipName"), "Pat Example"); type($i("#gcRecipEmail"), " Pat@Example.com "); tick($i("#gcSend"), true);
  reset(); fire($i("#gcIssueForm"), "submit");
  await wait(() => !!issueWin() && !issueWin().querySelector("#gcIssued").hidden); await idle();
  { const row = d1.q("SELECT * FROM gift_cards ORDER BY id DESC LIMIT 1")[0];
    ok("“Email it to them now” sends sendEmail with the email, and the card is emailed to them with its number", of("issueGiftCard")[0].sendEmail === true && of("issueGiftCard")[0].recipientEmail === "Pat@Example.com" &&
      globalThis.__mail394.length === 1 && globalThis.__mail394[0].to === "pat@example.com" && globalThis.__mail394[0].code === row.code.match(/.{4}/g).join("-"));
    ok("…the window says “It was emailed to Pat@Example.com.”", /It was emailed to Pat@Example\.com\./.test(text(issueWin().querySelector("#gcIssued")))); }
  issueWin().querySelector("#gcIssuedDone").click(); await pause(30); if (confirmBox()) await answer(true);
  globalThis.__mailOk394 = false;
  await openIssue();
  type($i("#gcAmount"), "30"); type($i("#gcRecipEmail"), "sam@example.com"); tick($i("#gcSend"), true);
  reset(); fire($i("#gcIssueForm"), "submit");
  await wait(() => !!issueWin() && !issueWin().querySelector("#gcIssued").hidden); await idle();
  ok("an email that couldn't be sent: “The email couldn't be sent. Use Resend on the card to try again.” (not “It was emailed”)",
    /The email couldn't be sent\. Use Resend on the card to try again\./.test(text(issueWin().querySelector("#gcIssued"))) && !/It was emailed/.test(text(issueWin().querySelector("#gcIssued"))));
  globalThis.__mailOk394 = true;
  issueWin().querySelector("#gcIssuedDone").click(); await pause(30); if (confirmBox()) await answer(true);
  await openIssue();
  type($i("#gcAmount"), "5");
  scripted.push({ action: "issueGiftCard", body: { status: "ok", duplicate: true, card: { id: 1, last4: "ZZ99" } } });
  reset(); fire($i("#gcIssueForm"), "submit");
  await wait(() => !!issueWin() && !issueWin().querySelector("#gcIssued").hidden); await idle();
  ok("an answer without the number (a repeat of the same Save): the card is named, no number and no Copy", text(issueWin().querySelector(".gc-issued-h")) === "Gift card ••ZZ99 for $5.00 is ready." && !issueWin().querySelector("#gcIssuedCode") && !issueWin().querySelector("#gcCopy"));
  issueWin().querySelector("#gcIssuedDone").click(); await pause(30); if (confirmBox()) await answer(true);
  await openIssue();
  type($i("#gcAmount"), "6");
  scripted.push({ action: "issueGiftCard", body: { status: "ok", last4: "PQRS", code: "abcd efgh jkmn pqrs" } });
  fire($i("#gcIssueForm"), "submit");
  await wait(() => !!issueWin() && !issueWin().querySelector("#gcIssued").hidden); await idle();
  ok("an answer with the card's fields at the top and a number typed any way: grouped upper-case", text(issueWin().querySelector(".gc-issued-h")) === "Gift card ••PQRS for $6.00 is ready." && text(issueWin().querySelector("#gcIssuedCode")) === "ABCD-EFGH-JKMN-PQRS");
  issueWin().querySelector("#gcIssuedDone").click(); await pause(30); if (confirmBox()) await answer(true);
  await openIssue();
  type($i("#gcAmount"), "7");
  scripted.push({ action: "issueGiftCard", body: { status: "ok", card: { last4: "WXYZ", code: "WXYZWXYZ" } } });
  fire($i("#gcIssueForm"), "submit");
  await wait(() => !!issueWin() && !issueWin().querySelector("#gcIssued").hidden); await idle();
  ok("a number that isn't 16 characters is shown as it came", text(issueWin().querySelector("#gcIssuedCode")) === "WXYZWXYZ");
  issueWin().querySelector("#gcIssuedDone").click(); await pause(30); if (confirmBox()) await answer(true);
  { const was = w.adminDesktopNoEmail_;
    w.adminDesktopNoEmail_ = () => true;
    await openIssue();
    ok("the desktop program with no mailbox: no “Email it to them now”", !$i("#gcSend") && !!$i("#gcAmount"));
    type($i("#gcAmount"), "8");
    reset(); fire($i("#gcIssueForm"), "submit");
    await wait(() => !!issueWin() && !issueWin().querySelector("#gcIssued").hidden); await idle();
    ok("…and its card is issued without email", of("issueGiftCard")[0].sendEmail === false && globalThis.__mail394.length === 0);
    issueWin().querySelector("#gcIssuedDone").click(); await pause(30); if (confirmBox()) await answer(true);
    w.adminDesktopNoEmail_ = was; }
  // The test cards above, gone again (the list keeps Pat, the online card, the used-up, void and bare ones).
  d1.q("DELETE FROM gift_card_ledger WHERE cardId > ?", cBare.id); d1.q("DELETE FROM gift_cards WHERE id > ?", cBare.id);
  await go();

  // ==============================================================================================================
  console.log("\n=== One card's window ===");
  // ==============================================================================================================
  const cardWin = () => { const m = modal(); return m && m.querySelector("#gcCardBody") ? m : null; };
  const $c = (sel) => cardWin() && cardWin().querySelector(sel);
  const btn = (what) => $c(`button[data-gc-do="${what}"]`);
  const facts = () => { const dl = $c("dl.gc-facts"); if (!dl) return []; return [...dl.children].reduce((a, el) => { if (el.tagName === "DT") a.push(text(el)); else a[a.length - 1] += " = " + text(el); return a; }, []); };
  const ledgerRows = () => cardWin() ? [...cardWin().querySelectorAll("table.gc-ledger tbody tr")].map(tr => cellsOf(tr)) : [];
  const openCard = async (last4, how) => {
    const tr = rowOf(last4);
    if (how === "link") tr.children[0].querySelector("a").dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true })); else tr.children[1].click();
    await wait(() => !!cardWin()); await idle(); return cardWin();
  };
  const closeCard = async () => { btn("close").click(); await wait(() => !cardWin()); };
  reset();
  await openCard(cPat.last4);
  ok("a click anywhere on a row opens that card, asking the server for it (with its history)", !!cardWin() && same(of("getGiftCard"), [{ action: "getGiftCard", id: cPat.id }]));
  ok("titled “Gift card ••XXXX”", text(cardWin().querySelector("[data-dialog-title]")) === "Gift card ••" + cPat.last4);
  ok("its balance: $40.00 “left of $50.00”, Active", text($c(".gc-bal")) === "$40.00" && text($c(".gc-summary .cust-note")) === "left of $50.00" && text($c(".gc-summary .cust-tag")) === "Active");
  ok("the number masked (••••-••••-••••- and the last four) with “Show”, needing Edit, saying it is recorded",
    text($c(".gc-number .gc-code")) === "••••-••••-••••-" + cPat.last4 && text(btn("show")) === "Show" && btn("show").getAttribute("data-need") === "giftcards.cards:edit" &&
    btn("show").title === "Shows the whole number. This is recorded in the activity log." && !cardWin().innerHTML.includes(cPat.code) && !btn("copy"));
  ok("the facts: who it's for, the message and the note as text, when and by whom it was issued",
    same(facts(), ["For = Pat Example · pat@example.com", "Message = Happy <b>birthday</b>", "Note = Paid cash at the show", "Issued = " + when("2026-03-01T15:00:00.000Z") + " by owner@example.test"]) && !$c("dl.gc-facts b"));
  ok("History: When, What, Amount, Order, Note, By", same([...cardWin().querySelectorAll("table.gc-ledger thead th")].map(th => th.textContent), ["When", "What", "Amount", "Order", "Note", "By"]));
  ok("…issued +$50.00, spent on an order −$12.50 (CLUB-7), put back +$2.50, oldest first",
    same(ledgerRows(), [[when("2026-03-01T15:00:00.000Z"), "Issued", "+$50.00", "", "Issued", "owner@example.test"],
      [when("2026-03-06T15:00:00.000Z"), "Spent on an order", "−$12.50", "CLUB-7", "Order CLUB-7", "owner@example.test"],
      [when("2026-03-07T15:00:00.000Z"), "Put back", "+$2.50", "CLUB-7", "Payment voided", "owner@example.test"]]) &&
    cardWin().querySelectorAll("table.gc-ledger td.gc-neg").length === 1);
  ok("an admin (Full) gets Void…, Adjust… and Resend…, and Close", same([...cardWin().querySelectorAll(".cust-dialog-actions button")].map(b => text(b)), ["Void…", "Adjust…", "Resend…", "Close"]) &&
    btn("void").getAttribute("data-need") === "giftcards.cards:full" && btn("adjust").getAttribute("data-need") === "giftcards.cards:full" && btn("resend").getAttribute("data-need") === "giftcards.cards:edit");
  await closeCard();
  ok("Close closes it", !cardWin());
  reset();
  await openCard(cPat.last4, "link");
  ok("the number's link opens it too, the address staying #giftcards", !!cardWin() && of("getGiftCard").length === 1 && hashNow() === "giftcards");
  await closeCard();
  reset(); id("gcCount").click(); id("gcTotals").click(); await pause(30);
  ok("a click outside the rows opens nothing", !cardWin() && of("getGiftCard").length === 0);

  console.log("\n=== Show and Copy ===");
  await openCard(cPat.last4);
  reset();
  btn("show").click();
  await wait(() => !!btn("copy")); await idle();
  ok("Show asks for the number (revealGiftCardCode) and shows it whole, in groups, with Copy in place of Show",
    same(of("revealGiftCardCode"), [{ action: "revealGiftCardCode", id: cPat.id }]) && text($c(".gc-number .gc-code")) === cPat.code.match(/.{4}/g).join("-") && !btn("show") && text(btn("copy")) === "Copy");
  ok("…and the server recorded who saw it", auditOf("giftcard.code_shown").length === 1 && JSON.parse(auditOf("giftcard.code_shown")[0].detail).cardId === cPat.id);
  btn("copy").click(); await pause(20);
  ok("Copy puts it on the clipboard: “Card number copied.”", same(clipboard, [cPat.code.match(/.{4}/g).join("-")]) && lastToast().m === "Card number copied.");
  await closeCard();
  await openCard(cPat.last4);
  ok("opened again, the number is masked again (it isn't kept)", text($c(".gc-number .gc-code")) === "••••-••••-••••-" + cPat.last4 && !!btn("show"));
  scripted.push({ action: "revealGiftCardCode", status: 500, body: { status: "error", message: "The <log> is down." } });
  btn("show").click(); await idle();
  ok("Show refused: the server's message in the window, as text, and Show can be pressed again", text($c("#gcCardErr")) === "The <log> is down." && btn("show").disabled === false && !$c("#gcCardErr log"));
  scripted.push({ action: "revealGiftCardCode", body: { status: "ok" } });
  btn("show").click(); await idle();
  ok("an answer with no number: “The number couldn't be shown.”", text($c("#gcCardErr")) === "The number couldn't be shown." && !!btn("show"));
  scripted.push({ action: "revealGiftCardCode", body: { status: "ok", card: { code: "abcdefghjkmnpqrs" } } });
  btn("show").click(); await wait(() => !!btn("copy"));
  ok("…a number under the card is shown too, grouped", text($c(".gc-number .gc-code")) === "ABCD-EFGH-JKMN-PQRS" && text($c("#gcCardErr")) === "");
  await closeCard();

  console.log("\n=== Other cards' windows ===");
  await openCard(cOnline.last4);
  ok("a card bought online: From the buyer, “Bought with Order CLUB-GC-1 on the shop”, the recipient's name as text",
    same(facts(), ["For = " + ROBIN, "From = Sam Example · sam@example.com", "Issued = " + when("2026-03-02T15:00:00.000Z") + " by owner@example.test", "Bought with = Order CLUB-GC-1 on the shop"]) &&
    !cardWin().querySelector("dl img") && w.__xss394 === undefined && same(ledgerRows().map(r => r[1] + " " + r[2] + " " + r[3] + " " + r[4]), ["Issued +$25.00 CLUB-GC-1 Sold online"]));
  await closeCard();
  await openCard(cVoid.last4);
  ok("a voided card: Void, $0.00 left of $20.00, when it was voided, and only Close", text($c(".gc-summary .cust-tag")) === "Void" && text($c(".gc-bal")) === "$0.00" && text($c(".gc-summary .cust-note")) === "left of $20.00" &&
    facts().includes("Voided = " + when("2026-03-09T15:00:00.000Z")) && same([...cardWin().querySelectorAll(".cust-dialog-actions button")].map(b => text(b)), ["Close"]));
  ok("…its history ends “Voided −$20.00 Lost”", (() => { const r = ledgerRows().pop(); return r[1] === "Voided" && r[2] === "−$20.00" && r[4] === "Lost"; })());
  await closeCard();
  await openCard(cEmpty.last4);
  ok("a card with nothing left: “Used up”, For its email alone, no message or note", text($c(".gc-summary .cust-tag")) === "Used up" && facts()[0] === "For = lee@example.com" && !facts().some(f => /^(Message|Note|From) =/.test(f)));
  await closeCard();
  await openCard(cBare.last4);
  ok("a card for nobody: no For, just Issued", same(facts(), ["Issued = " + when("2026-03-05T15:00:00.000Z") + " by owner@example.test"]));
  await closeCard();
  scripted.push({ action: "getGiftCard", body: { status: "ok", giftCard: { id: 77, last4: "AB12", balanceCents: 999, initialCents: 1000, status: "active", createdAt: "",
    ledger: [{ kind: "weird", deltaCents: -150, orderId: "", note: "<x>", at: "", by: "" }] } } });
  await openCard(cPat.last4);
  ok("an answer in another shape (giftCard, its money in cents, its history on it): $9.99 left of $10.00; an unknown kind shown as is; −$1.50",
    text($c(".gc-bal")) === "$9.99" && text($c(".gc-summary .cust-note")) === "left of $10.00" && same(ledgerRows(), [["", "weird", "−$1.50", "", "<x>", ""]]) &&
    text($c(".gc-number .gc-code")) === "••••-••••-••••-AB12" && same(facts(), ["Issued = "]));
  await closeCard();
  scripted.push({ action: "getGiftCard", body: { status: "ok", card: { id: 78, last4: "CD34", balance: 1, initial: 1, status: "active", codeMasked: "••••-••••-••••-CD34" } } });
  await openCard(cPat.last4);
  ok("a card with no history: “Nothing yet.”", /Nothing yet\./.test(text(cardWin())) && !cardWin().querySelector("table.gc-ledger"));
  await closeCard();
  scripted.push({ action: "getGiftCard", body: { status: "ok", card: { id: 79, status: "active", ledger: [{ kind: "adjust", delta: "x", at: "" }] } } });
  await openCard(cPat.last4);
  ok("a card with no last four or figures, and a history row with an amount that isn't one: $0.00 and +$0.00, no crash", text($c(".gc-bal")) === "$0.00" && text($c(".gc-number .gc-code")) === "••••-••••-••••-" &&
    same(ledgerRows(), [["", "Adjusted", "+$0.00", "", "", ""]]) && text(cardWin().querySelector("[data-dialog-title]")) === "Gift card ••");
  await closeCard();
  reset();
  scripted.push({ action: "getGiftCard", status: 404, body: { status: "error", message: "Gift card not found" } });
  rowOf(cPat.last4).children[1].click(); await idle();
  ok("a card the server can't find: no window, “Gift card not found” as an error, and the list asked for again", !cardWin() && lastToast().m === "Gift card not found" && lastToast().err && of("listGiftCards").length === 1);
  reset();
  scripted.push({ action: "getGiftCard", body: { status: "ok" } });
  rowOf(cPat.last4).children[1].click(); await idle();
  ok("an answer with no card: “That gift card is gone.”", !cardWin() && lastToast().m === "That gift card is gone." && lastToast().err);

  console.log("\n=== Resend ===");
  await openCard(cPat.last4);
  btn("resend").click();
  await wait(() => !!confirmBox());
  { const box = confirmBox();
    ok("Resend… asks “Email gift card ••XXXX to someone?”, the card's email filled in, “Send”",
      text(box.querySelector("[data-dialog-title]")) === "Email gift card ••" + cPat.last4 + " to someone?" && text(box.querySelector(".cm-text")) === "They get the number and how to use it." &&
      box.querySelector("#cmInput").value === "pat@example.com" && box.querySelector("#cmOk").textContent === "Send" && text(box.querySelector("label[for=cmInput]")) === "Email address");
    reset();
    box.querySelector("#cmCancel").click(); await wait(() => !confirmBox()); await idle();
    ok("…Cancel sends nothing", sent.length === 0 && globalThis.__mail394.length === 0 && !!cardWin()); }
  btn("resend").click(); await wait(() => !!confirmBox());
  q("#cmInput").value = "nope"; q("#cmOk").click(); await pause(20);
  ok("an address that isn't one: “Enter a valid email address.” in the box, nothing sent", text(q("#cmInputErr")) === "Enter a valid email address." && !!confirmBox() && sent.length === 0);
  q("#cmInput").value = "  jo@example.com "; q("#cmOk").click(); await wait(() => !confirmBox()); await idle();
  ok("Send: resendGiftCard with the address (trimmed); emailed with the whole number; “Gift card emailed to jo@example.com.”",
    same(of("resendGiftCard"), [{ action: "resendGiftCard", id: cPat.id, email: "jo@example.com" }]) && globalThis.__mail394.length === 1 && globalThis.__mail394[0].to === "jo@example.com" &&
    globalThis.__mail394[0].code === cPat.code.match(/.{4}/g).join("-") && lastToast().m === "Gift card emailed to jo@example.com." && !lastToast().err && btn("resend").disabled === false);
  ok("…recorded on the server", auditOf("giftcard.resent").length === 1);
  globalThis.__mailOk394 = false;
  reset();
  btn("resend").click(); await wait(() => !!confirmBox()); q("#cmOk").click(); await wait(() => !confirmBox()); await idle();
  ok("an email that couldn't be sent: “The email couldn't be sent.” as an error (not “emailed”)", lastToast().m === "The email couldn't be sent." && lastToast().err);
  globalThis.__mailOk394 = true;
  scripted.push({ action: "resendGiftCard", status: 409, body: { status: "error", message: "This gift card was <voided>." } });
  btn("resend").click(); await wait(() => !!confirmBox()); q("#cmOk").click(); await wait(() => !confirmBox()); await idle();
  ok("the server refuses: its message in the window, as text, and Resend can be pressed again", text($c("#gcCardErr")) === "This gift card was <voided>." && btn("resend").disabled === false);

  console.log("\n=== Adjust ===");
  const adjWin = () => { const m = modal(); return m && m.querySelector("#gcAdjForm") ? m : null; };
  const $a = (sel) => adjWin() && adjWin().querySelector(sel);
  btn("adjust").click(); await wait(() => !!adjWin());
  ok("Adjust… opens “Adjust balance”, saying the balance now and how to type a change", text(adjWin().querySelector("[data-dialog-title]")) === "Adjust balance" &&
    /^The balance is \$40\.00 now\. Type how much to add, or a minus sign and how much to take off \(for example 10 or -10\)\./.test(text(adjWin().querySelector(".cust-note"))) && text($a("#gcAdjSave")) === "Change balance");
  reset();
  $a("#gcAdjCancel").click(); await wait(() => !adjWin()); await idle();
  ok("…Cancel sends nothing, the card stays open", sent.length === 0 && !!cardWin() && btn("adjust").disabled === false);
  btn("adjust").click(); await wait(() => !!adjWin());
  adjWin().querySelector("[data-modal-close]").click(); await wait(() => !adjWin()); await idle();
  ok("…✕ the same", sent.length === 0 && !!cardWin());
  btn("adjust").click(); await wait(() => !!adjWin());
  for (const bad of ["", "0", "abc", "1.234", "-0"]) {
    $a("#gcAdjAmount").value = bad; $a("#gcAdjNote").value = "Because";
    fire($a("#gcAdjForm"), "submit"); await pause(10);
    if (!ok("a change of “" + bad + "”: “Enter how much to add or take off, like 10 or -10.”", text($a("#gcAdjErr")) === "Enter how much to add or take off, like 10 or -10." && sent.length === 0)) break;
  }
  $a("#gcAdjAmount").value = "-40.01"; fire($a("#gcAdjForm"), "submit"); await pause(10);
  ok("taking off more than is on it: “That is more than the $40.00 on the card.”", text($a("#gcAdjErr")) === "That is more than the $40.00 on the card." && sent.length === 0);
  $a("#gcAdjAmount").value = "999960.01"; fire($a("#gcAdjForm"), "submit"); await pause(10);
  ok("adding past $1,000,000: “That would take the balance over $1,000,000.”", text($a("#gcAdjErr")) === "That would take the balance over $1,000,000." && sent.length === 0);
  $a("#gcAdjAmount").value = "−5"; $a("#gcAdjNote").value = "   "; fire($a("#gcAdjForm"), "submit"); await pause(10);
  ok("no reason: “Say why the balance is being changed.”", text($a("#gcAdjErr")) === "Say why the balance is being changed." && sent.length === 0);
  $a("#gcAdjAmount").value = " −5 "; $a("#gcAdjNote").value = "  Lost part of it  ";
  fire($a("#gcAdjForm"), "submit");
  await wait(() => !adjWin() && text($c(".gc-bal")) === "$35.00"); await idle();
  ok("“−5” (a typographic minus) with a reason: adjustGiftCard −500 cents and the reason, trimmed", same(of("adjustGiftCard"), [{ action: "adjustGiftCard", id: cPat.id, deltaCents: -500, note: "Lost part of it" }]));
  ok("…“Balance changed.”, the card read again ($35.00, the history's last row “Adjusted −$5.00”), the list asked for again",
    lastToast().m === "Balance changed." && cardRow(cPat.id).balanceCents === 3500 && (() => { const r = ledgerRows().pop(); return r[1] === "Adjusted" && r[2] === "−$5.00" && r[4] === "Lost part of it"; })() &&
    of("listGiftCards").length === 1 && of("getGiftCard").length === 1);
  reset();
  btn("adjust").click(); await wait(() => !!adjWin());
  ok("…and the next Adjust says $35.00", /^The balance is \$35\.00 now\./.test(text(adjWin().querySelector(".cust-note"))));
  $a("#gcAdjAmount").value = "+10"; $a("#gcAdjNote").value = "Goodwill";
  fire($a("#gcAdjForm"), "submit");
  await wait(() => !adjWin() && text($c(".gc-bal")) === "$45.00"); await idle();
  ok("“+10” adds 1000 cents", of("adjustGiftCard")[0].deltaCents === 1000 && cardRow(cPat.id).balanceCents === 4500);
  scripted.push({ action: "adjustGiftCard", status: 400, body: { status: "error", message: "The balance can't go below <$0>." } });
  btn("adjust").click(); await wait(() => !!adjWin());
  $a("#gcAdjAmount").value = "1"; $a("#gcAdjNote").value = "x"; fire($a("#gcAdjForm"), "submit"); await idle();
  ok("the server refuses: its message in the card's window, as text, Adjust can be pressed again", text($c("#gcCardErr")) === "The balance can't go below <$0>." && btn("adjust").disabled === false && cardRow(cPat.id).balanceCents === 4500);
  scripted.push({ action: "getGiftCard", status: 500, body: { status: "error", message: "down" } });
  reset();
  btn("adjust").click(); await wait(() => !!adjWin());
  $a("#gcAdjAmount").value = "-5"; $a("#gcAdjNote").value = "Back to 40"; fire($a("#gcAdjForm"), "submit");
  await wait(() => !cardWin()); await idle();
  ok("a change saved but the card can't be read again: the window closes, still “Balance changed.”, the list asked for again", !cardWin() && cardRow(cPat.id).balanceCents === 4000 && lastToast().m === "Balance changed." && of("listGiftCards").length === 1);

  console.log("\n=== Void ===");
  await openCard(cBare.last4);
  btn("void").click();
  await wait(() => !!confirmBox());
  { const box = confirmBox();
    ok("Void… asks “Void gift card ••XXXX?”, saying its $15.00 goes to $0.00 for good, with a reason box; “Void card” waits for a reason",
      text(box.querySelector("[data-dialog-title]")) === "Void gift card ••" + cBare.last4 + "?" && text(box.querySelector(".cm-text")) === "Its $15.00 balance goes to $0.00 and it can't be spent again. This can't be undone." &&
      !!box.querySelector("#cmReason") && box.querySelector("#cmReason").value === "" && box.querySelector("#cmOk").textContent === "Void card" && box.querySelector("#cmOk").disabled === true);
    reset();
    box.querySelector("#cmCancel").click(); await wait(() => !confirmBox()); await idle();
    ok("…Back voids nothing", sent.length === 0 && cardRow(cBare.id).status === "active" && !!cardWin()); }
  scripted.push({ action: "voidGiftCard", status: 409, body: { status: "error", message: "This gift card is already <voided>." } });
  btn("void").click(); await wait(() => !!confirmBox());
  type(q("#cmReason"), "Test"); q("#cmOk").click(); await wait(() => !confirmBox()); await idle();
  ok("the server refuses: its message in the window, as text, Void can be pressed again", text($c("#gcCardErr")) === "This gift card is already <voided>." && btn("void").disabled === false);
  reset();
  btn("void").click(); await wait(() => !!confirmBox());
  type(q("#cmReason"), "  Customer asked  ");
  ok("…a reason lets “Void card” be pressed", q("#cmOk").disabled === false);
  q("#cmOk").click();
  await wait(() => !!cardWin() && text($c(".gc-summary .cust-tag")) === "Void"); await idle();
  ok("Void card: voidGiftCard with the reason; “Gift card voided.”; the card is void and $0.00 on the server",
    same(of("voidGiftCard"), [{ action: "voidGiftCard", id: cBare.id, note: "Customer asked" }]) && lastToast().m === "Gift card voided." && cardRow(cBare.id).status === "void" && cardRow(cBare.id).balanceCents === 0);
  ok("…the window drawn again: Void, $0.00, when it was voided, and only Close", text($c(".gc-bal")) === "$0.00" && facts().some(f => /^Voided = /.test(f)) &&
    same([...cardWin().querySelectorAll(".cust-dialog-actions button")].map(b => text(b)), ["Close"]) && of("listGiftCards").length === 1);
  await closeCard();
  await idle();
  ok("the list behind shows it Void", cellsOf(rowOf(cBare.last4))[6] === "Void");

  console.log("\n=== What each role sees in a card ===");
  asRoles("staff");
  await go();
  await openCard(cPat.last4);
  ok("Back office (Edit): Show and Resend…, no Void… or Adjust…", !!btn("show") && !off(btn("show")) && same([...cardWin().querySelectorAll(".cust-dialog-actions button")].map(b => text(b)), ["Resend…", "Close"]));
  await closeCard();
  signInWith(withLevels("admin", { "giftcards.cards": "read" }));
  await go();
  await openCard(cPat.last4);
  ok("a role with Read: only Close, and Show hidden", same([...cardWin().querySelectorAll(".cust-dialog-actions button")].map(b => text(b)), ["Close"]) && off(btn("show")) && !off(btn("close")));
  await closeCard();
  asRoles("admin");

  console.log("\n=== A card's own address ===");
  reset();
  w.location.hash = "#home"; await idle();
  reset();
  w.location.hash = "#giftcards/" + cOnline.id;
  await wait(() => !!cardWin()); await idle();
  ok("#giftcards/<id> draws the list and opens that card over it", !!page() && listDrawn() && same(of("getGiftCard"), [{ action: "getGiftCard", id: cOnline.id }]) && text(cardWin().querySelector("[data-dialog-title]")) === "Gift card ••" + cOnline.last4);
  await closeCard();
  for (const bad of ["abc", "0", "1.5", "-3"]) {
    w.location.hash = "#home"; await idle();
    reset();
    w.location.hash = "#giftcards/" + bad;
    await wait(() => page() && listDrawn()); await idle();
    if (!ok("#giftcards/" + bad + " is just the list", !cardWin() && of("getGiftCard").length === 0 && of("listGiftCards").length === 1)) break;
  }
  ok("renderGiftCards opens no card for a missing or empty id", await (async () => { reset(); await w.renderGiftCards(app, ""); await idle(); const a = !cardWin() && of("getGiftCard").length === 0; reset(); await w.renderGiftCards(app); await idle(); return a && !cardWin() && of("getGiftCard").length === 0; })());
  { let release; hold = { action: "listGiftCards", gate: new Promise(r => { release = r; }) };
    w.location.hash = "#home"; await idle();
    reset();
    w.location.hash = "#giftcards/" + cPat.id;
    await wait(() => of("listGiftCards").length === 1);
    w.location.hash = "#home"; await wait(() => !page()); await idle();
    release(); await pause(50); await idle();
    ok("a card's address left before its list arrived opens no card", !cardWin() && of("getGiftCard").length === 0); }
  await go();

  // ==============================================================================================================
  console.log("\n=== Global settings: Discount codes, Gift cards and the Gift cards payment ===");
  // ==============================================================================================================
  const panel = () => id("adminPanel");
  const drawSettings = async () => { reset(); await w.renderGlobalSettings(app); await wait(() => !!id("gPayCard")); await idle(); };
  const h2s = () => qa("#adminPanel h2").map(h => text(h));
  const saveSettings = async () => { reset(); await w.submitGlobalSettings(); await idle(); return of("saveGlobalSettingsAll"); };
  const errNow = () => id("globalSettingsError") ? id("globalSettingsError").textContent : "";
  await drawSettings();
  ok("no Stripe key (card payments not set up): the sell-on-the-shop tick is unticked and greyed out, with the note why",
    !!id("gGiftSell") && id("gGiftSell").disabled && !id("gGiftSell").checked && /Card payments must be set up and switched on to sell gift cards on a shop/.test(text(panel())));
  stripeKey394 = "sk_test_x";
  await drawSettings();
  ok("with a Stripe key and Card on: the tick can be used, with “Only shops that take card payments show gift cards.”",
    !id("gGiftSell").disabled && /Only shops that take card payments show gift cards\./.test(text(panel())));
  ok("the page reads the Discount codes rule and the gift card settings", of("getDiscountRules").length === 1 && of("getGiftCardSettings").length === 1);
  ok("Payment methods has “Gift cards (a card's balance can pay part or all of an order — a payment, not a discount)”, ticked by default",
    !!id("gPayGiftCard") && id("gPayGiftCard").checked && text(id("gPayGiftCard").closest("label")) === "Gift cards (a card's balance can pay part or all of an order — a payment, not a discount)");
  ok("a “Discount codes” section after Payment methods: “More than one discount code can be used on an order”, off by default",
    h2s().indexOf("Discount codes") > h2s().indexOf("Payment methods") && !!id("gDiscMultiple") && !id("gDiscMultiple").checked &&
    text(id("gDiscMultiple").closest("label")) === "More than one discount code can be used on an order" &&
    /Off: one code per order\. On: percent codes add up \(10% and 15% make 25%, never more than the whole price\), then amount codes come off what is left; a free-shipping code makes shipping free\. A gift card is a payment, not a discount, so it can be used with a code either way\./.test(text(panel())));
  ok("a “Gift cards” section after it: not sold online, buttons 25, 50, 100, a custom amount from 5 up to 500",
    h2s().indexOf("Gift cards") === h2s().indexOf("Discount codes") + 1 && !id("gGiftSell").checked && id("gGiftAmounts").value === "25, 50, 100" && id("gGiftMin").value === "5" && id("gGiftMax").value === "500" &&
    /You can always issue a gift card from the Gift cards page\./.test(text(panel())) && /Shown as buttons on the shop, with a box for any other amount between the two figures\./.test(text(panel())));
  ok("(a Save with nothing changed needs no Publish)", w.globalSettingsNeedPublish_() === false);
  tick(id("gPayGiftCard"), false);
  ok("unticking the Gift cards payment needs a Publish (it travels with the catalog)", w.globalSettingsNeedPublish_() === true);
  tick(id("gDiscMultiple"), true);
  tick(id("gGiftSell"), true);
  id("gGiftAmounts").value = " 10, 25.5 $40,  10 ";
  id("gGiftMin").value = "2.5"; id("gGiftMax").value = "1000";
  { const saves = await saveSettings();
    ok("Save sends everything in ONE saveGlobalSettingsAll: the payment tick, the rule, and the gift card settings in cents (sorted, once each)",
      saves.length === 1 && saves[0].settings.payments.giftCard === false && same(saves[0].settings.discountRules, { multiple: true }) &&
      same(saves[0].settings.giftCards, { sellOnline: true, amounts: [1000, 2550, 4000], minCents: 250, maxCents: 100000 }) && of("updateDiscountRules").length === 0 && of("updateGiftCardSettings").length === 0);
    ok("…saved: the rule, the gift card settings and the payment method", errNow() === "" && (await must({ action: "getDiscountRules" })).discountRules.multiple === true &&
      same((await must({ action: "getGiftCardSettings" })).giftCards, { sellOnline: true, amounts: [1000, 2550, 4000], minCents: 250, maxCents: 100000, cardReady: true }) &&
      (await must({ action: "getGlobalSettings" })).globalSettings.enabledPayments.giftCard === false); }
  await drawSettings();
  ok("drawn again: the rule on, sold online, “10, 25.50, 40”, 2.50 to 1000, the payment unticked",
    id("gDiscMultiple").checked && id("gGiftSell").checked && id("gGiftAmounts").value === "10, 25.50, 40" && id("gGiftMin").value === "2.50" && id("gGiftMax").value === "1000" && !id("gPayGiftCard").checked);
  const giftAmountsMsg = "Nothing was saved. Gift cards: enter 1 to 6 amounts, each from $1 to $10,000, like 25, 50, 100.";
  for (const bad of ["", "1, 2, 3, 4, 5, 6, 7", "0.5", "abc", "10001", "5.555"]) {
    id("gGiftAmounts").value = bad;
    const saves = await saveSettings();
    if (!ok("amounts “" + bad + "”: “" + giftAmountsMsg + "”, nothing sent", saves.length === 0 && errNow() === giftAmountsMsg && lastToast().err)) break;
  }
  id("gGiftAmounts").value = "1, 2, 3, 4, 5, 10000";
  const rangeMsg = "Nothing was saved. Gift cards: the custom amount's two figures must run from at least $1 up to no more than $10,000, the second not below the first.";
  for (const [lo, hi] of [["0.5", "10"], ["", "10"], ["20", "10"], ["1", "10000.01"], ["1", ""]]) {
    id("gGiftMin").value = lo; id("gGiftMax").value = hi;
    const saves = await saveSettings();
    if (!ok("a custom amount from “" + lo + "” to “" + hi + "”: “" + rangeMsg + "”", saves.length === 0 && errNow() === rangeMsg)) break;
  }
  id("gGiftMin").value = "1"; id("gGiftMax").value = "10000";
  tick(id("gDiscMultiple"), false); tick(id("gGiftSell"), false); tick(id("gPayGiftCard"), true);
  { const saves = await saveSettings();
    ok("six amounts, $1 to $10,000 each, with the custom range at the limits, save; and everything off again",
      saves.length === 1 && same(saves[0].settings.giftCards, { sellOnline: false, amounts: [100, 200, 300, 400, 500, 1000000], minCents: 100, maxCents: 1000000 }) &&
      saves[0].settings.discountRules.multiple === false && saves[0].settings.payments.giftCard === true && errNow() === "" && (await must({ action: "getDiscountRules" })).discountRules.multiple === false); }
  { const box = (k) => q(`#gFeatures .gFeature[data-feature="${k}"]`);
    await drawSettings();
    ok("(the Features list has Discount codes and Gift cards switches)", !!box("discounts") && !!box("giftCards"));
    tick(box("giftCards"), false); tick(box("discounts"), false);
    const saves = await saveSettings();
    ok("a feature switched off on the form: its section isn't sent (the server would refuse it)", saves.length === 1 && !("giftCards" in saves[0].settings) && !("discountRules" in saves[0].settings) &&
      saves[0].settings.features.giftCards === false && saves[0].settings.features.discounts === false && errNow() === ""); }
  await drawSettings();
  ok("with Gift cards switched off: no Gift cards payment tick and no Gift cards section; Discount codes off: no rule section; neither is asked for",
    !id("gPayGiftCard") && !id("gGiftSell") && !id("gDiscMultiple") && !h2s().includes("Gift cards") && !h2s().includes("Discount codes") && of("getDiscountRules").length === 0 && of("getGiftCardSettings").length === 0);
  { const saves = await saveSettings();
    ok("…and Save sends no gift card payment, rule or gift card settings", saves.length === 1 && !("giftCard" in saves[0].settings.payments) && !("giftCards" in saves[0].settings) && !("discountRules" in saves[0].settings)); }
  tick(q('#gFeatures .gFeature[data-feature="giftCards"]'), true); tick(q('#gFeatures .gFeature[data-feature="discounts"]'), true);
  await saveSettings();
  ok("(both switched on again)", w.adminFeatureOn_("giftCards") === true && w.adminFeatureOn_("discounts") === true);
  scripted.push({ action: "getDiscountRules", status: 500, body: { status: "error", message: "down" } });
  scripted.push({ action: "getGiftCardSettings", status: 500, body: { status: "error", message: "down" } });
  await drawSettings();
  ok("rules or gift card settings the server can't give: their sections aren't drawn (the payment tick still is)", !id("gDiscMultiple") && !id("gGiftSell") && !!id("gPayGiftCard"));
  { const saves = await saveSettings();
    ok("…and nothing of theirs is sent, so the form's defaults can't be saved over the real ones", saves.length === 1 && !("discountRules" in saves[0].settings) && !("giftCards" in saves[0].settings)); }
  scripted.push({ action: "getDiscountRules", body: { status: "ok", rules: { multiple: "yes" } } });
  scripted.push({ action: "getGiftCardSettings", body: { status: "ok", settings: { amounts: "25" } } });
  await drawSettings();
  ok("answers that aren't a rule (multiple not true or false) or a list of amounts: not drawn either", !id("gDiscMultiple") && !id("gGiftSell"));
  scripted.push({ action: "getDiscountRules", body: { status: "ok", rules: { multiple: true } } });
  scripted.push({ action: "getGiftCardSettings", body: { status: "ok", settings: { sellOnline: 1, amounts: ["500", "x", 1234], minCents: 0, maxCents: null } } });
  await drawSettings();
  ok("answers in another shape (rules, settings): drawn, numbers read as numbers, a bad range falling back to 5 to 500",
    id("gDiscMultiple").checked && id("gGiftSell").checked && id("gGiftAmounts").value === "5, 12.34" && id("gGiftMin").value === "5" && id("gGiftMax").value === "500");
  signInWith(withLevels("admin", { "settings.global": "read" }));
  await drawSettings();
  { const saves = await saveSettings();
    ok("a role that can only read Global settings sees both sections but sends neither", !!id("gDiscMultiple") && !!id("gGiftSell") && saves.length === 1 &&
      !("discountRules" in saves[0].settings) && !("giftCards" in saves[0].settings) && "payments" in saves[0].settings); }
  asRoles("admin");
  await drawSettings();
  { const saves = await saveSettings();
    ok("(the page drawn for an admin again sends both)", saves.length === 1 && "discountRules" in saves[0].settings && "giftCards" in saves[0].settings); }

  // ==============================================================================================================
  console.log("\n=== The Discount codes page: minimum order, free shipping, “Free shipping only” ===");
  // ==============================================================================================================
  const dcWin = () => { const m = modal(); return m && m.querySelector("#dcForm") ? m : null; };
  const $d = (sel) => dcWin() && dcWin().querySelector(sel);
  const dcRows = () => qa("#dcBody table.dc-table tbody tr");
  const dcRowOf = (code) => dcRows().find(tr => text(tr.children[0]) === code);
  const goDc = async () => { const old = id("dcPage"); if (hashNow() === "discounts") w.adminRoute(); else w.location.hash = "#discounts"; await wait(() => id("dcPage") && id("dcPage") !== old && !/Loading…/.test(id("dcBody").textContent)); await idle(); };
  const shown = (sel) => !!$d(sel) && !$d(sel).hidden;
  const codeRow = (code) => d1.q("SELECT * FROM discount_codes WHERE code = ?", code)[0];
  await goDc();
  ok("the page's note: a free-shipping code takes the shipping off, and more than one code needs Global settings",
    /the discount comes off the goods \(not shipping or a rush fee; a free-shipping code takes the shipping off\), and an order uses one code unless Global settings → Discount codes allows more\./.test(text(id("dcPage"))));
  id("dcNew").click(); await wait(() => !!dcWin());
  ok("a new code: Discount is Percent off, Amount off or Free shipping only", same([...$d("#dcKind").options].map(o => o.value + "=" + o.textContent), ["percent=Percent off", "amount=Amount off", "shipping=Free shipping only"]) && $d("#dcKind").value === "percent");
  ok("…Percent off shows the percent, the max discount, “Also free shipping” (unticked) and “Minimum order ($, optional)”",
    shown("#dcValueWrap") && shown("#dcMaxWrap") && shown("#dcShipWrap") && !$d("#dcFreeShip").checked && text($d("#dcShipWrap")) === "Also free shipping" && shown("#dcMinWrap") &&
    $d("#dcMinOrder").value === "" && $d("#dcMinOrder").placeholder === "No minimum" && $d("#dcMinOrder").max === "100000" && /^Minimum order \(\$, optional\)/.test(text($d("#dcMinWrap"))) &&
    /The goods total \(before shipping and tax\) an order needs before the code works\./.test(text($d("#dcMinWrap"))));
  pick($d("#dcKind"), "amount");
  ok("Amount off: the amount, no max discount, “Also free shipping” still offered", shown("#dcValueWrap") && !shown("#dcMaxWrap") && shown("#dcShipWrap") && text($d("#dcValueLabel")) === "Amount ($)");
  pick($d("#dcKind"), "shipping");
  ok("Free shipping only: no amount or percent, no max, no “Also free shipping”; the minimum stays", !shown("#dcValueWrap") && !shown("#dcMaxWrap") && !shown("#dcShipWrap") && shown("#dcMinWrap"));
  pick($d("#dcKind"), "percent");
  ok("…back to Percent off: all of them again", shown("#dcValueWrap") && shown("#dcMaxWrap") && shown("#dcShipWrap"));
  pick($d("#dcKind"), "shipping");
  type($d("#dcCode"), "SHIPFREE");
  $d('input[name="dcWho"][value="any"]').checked = true; fire($d('input[name="dcWho"][value="any"]'), "change");
  type($d("#dcMax"), "100");
  for (const bad of ["0", "100000.01", "1.234", "-5"]) {
    $d("#dcMinOrder").value = bad;
    reset(); fire($d("#dcForm"), "submit"); await idle();
    if (!ok("a minimum order of “" + bad + "”: “Enter a minimum order from $0.01 to $100,000, or leave it blank.”, nothing sent", text($d("#dcErr")) === "Enter a minimum order from $0.01 to $100,000, or leave it blank." && sent.length === 0)) break;
  }
  $d("#dcMinOrder").value = "50";
  reset(); fire($d("#dcForm"), "submit");
  await wait(() => !dcWin()); await idle();
  ok("Create a Free shipping only code with a $50 minimum: kind shipping, no percent or amount, minOrder 50, freeShipping true",
    of("saveDiscountCode").length === 1 && (() => { const c = of("saveDiscountCode")[0].code; return c.kind === "shipping" && c.percent === null && c.amount === null && c.maxDiscount === null && c.minOrder === 50 && c.freeShipping === true; })());
  ok("…stored as a free-shipping-only code (nothing off the goods) with the minimum, shown as “Free shipping, on orders of $50.00 or more”",
    codeRow("SHIPFREE").goodsOff === 0 && codeRow("SHIPFREE").freeShipping === 1 && codeRow("SHIPFREE").minOrderCents === 5000 && lastToast().m === "Code SHIPFREE created." &&
    text(dcRowOf("SHIPFREE").children[1]) === "Free shipping, on orders of $50.00 or more");
  id("dcNew").click(); await wait(() => !!dcWin());
  type($d("#dcCode"), "TENSHIP"); type($d("#dcValue"), "10"); tick($d("#dcFreeShip"), true);
  $d('input[name="dcWho"][value="any"]').checked = true; fire($d('input[name="dcWho"][value="any"]'), "change"); type($d("#dcMax"), "5");
  reset(); fire($d("#dcForm"), "submit"); await wait(() => !dcWin()); await idle();
  ok("10% off with “Also free shipping” and no minimum: freeShipping true, minOrder null; “10% off and free shipping”",
    (() => { const c = of("saveDiscountCode")[0].code; return c.kind === "percent" && c.percent === 10 && c.freeShipping === true && c.minOrder === null; })() &&
    codeRow("TENSHIP").freeShipping === 1 && codeRow("TENSHIP").goodsOff === 1 && text(dcRowOf("TENSHIP").children[1]) === "10% off and free shipping");
  const openDc = async (code) => { dcRowOf(code).children[2].click(); await wait(() => !!dcWin()); await idle(); };
  await openDc("SHIPFREE");
  ok("opened: Free shipping only chosen, no value box, no “Also free shipping”, the minimum “50.00”",
    $d("#dcKind").value === "shipping" && !shown("#dcValueWrap") && !shown("#dcShipWrap") && !shown("#dcMaxWrap") && !$d("#dcFreeShip").checked && $d("#dcMinOrder").value === "50.00");
  tick($d("#dcActive"), false);
  reset(); fire($d("#dcForm"), "submit"); await wait(() => !dcWin()); await idle();
  ok("unticking Active alone, minimum and free shipping unchanged: the switch, not a save", same(of("setDiscountCodeActive").map(b => b.active), [false]) && of("saveDiscountCode").length === 0);
  await openDc("SHIPFREE");
  tick($d("#dcActive"), true); $d("#dcMinOrder").value = "60";
  reset(); fire($d("#dcForm"), "submit"); await wait(() => !dcWin()); await idle();
  ok("Active and the minimum changed together: one save with the new minimum", of("saveDiscountCode").length === 1 && of("saveDiscountCode")[0].code.minOrder === 60 && of("setDiscountCodeActive").length === 0 && codeRow("SHIPFREE").minOrderCents === 6000);
  await openDc("TENSHIP");
  ok("a percent code with free shipping opens with “Also free shipping” ticked", $d("#dcKind").value === "percent" && $d("#dcFreeShip").checked && shown("#dcShipWrap"));
  tick($d("#dcActive"), false); tick($d("#dcFreeShip"), false);
  reset(); fire($d("#dcForm"), "submit"); await wait(() => !dcWin()); await idle();
  ok("Active and free shipping changed together: a save (free shipping off), not the switch", of("saveDiscountCode").length === 1 && of("saveDiscountCode")[0].code.freeShipping === false && of("setDiscountCodeActive").length === 0 && codeRow("TENSHIP").freeShipping === 0);
  // Used: the minimum, the kind and free shipping lock.
  d1.q("INSERT INTO discount_code_uses (codeId, orderId, email, amountCents, usedAt) VALUES (?, 'CLUB-9', 'pat@example.com', 0, '2026-03-10T00:00:00.000Z')", codeRow("SHIPFREE").id);
  await goDc();
  await openDc("SHIPFREE");
  ok("a used Free shipping only code: the kind, minimum and free shipping are locked", $d("#dcKind").disabled && $d("#dcMinOrder").disabled && $d("#dcFreeShip").disabled && $d("#dcMinOrder").value === "60.00");
  type($d("#dcNote"), "Summer");
  reset(); fire($d("#dcForm"), "submit"); await wait(() => !dcWin()); await idle();
  ok("…Save keeps its kind, minimum and free shipping as they were", (() => { const c = of("saveDiscountCode")[0].code; return c.kind === "shipping" && c.minOrder === 60 && c.freeShipping === true && c.note === "Summer"; })() &&
    codeRow("SHIPFREE").minOrderCents === 6000 && codeRow("SHIPFREE").freeShipping === 1 && lastToast().m === "Code SHIPFREE saved.");
  d1.q("INSERT INTO discount_code_uses (codeId, orderId, email, amountCents, usedAt) VALUES (?, 'CLUB-10', 'pat@example.com', 100, '2026-03-10T00:00:00.000Z')", codeRow("TENSHIP").id);
  await goDc();
  await openDc("TENSHIP");
  ok("a used code with no minimum: the box locked and empty", $d("#dcMinOrder").disabled && $d("#dcMinOrder").value === "");
  reset(); fire($d("#dcForm"), "submit"); await wait(() => !dcWin()); await idle();
  ok("…Save sends no minimum and its free shipping as it was (off)", of("saveDiscountCode")[0].code.minOrder === null && of("saveDiscountCode")[0].code.freeShipping === false);

  console.log("\n=== Codes for a list of emails: the same three ===");
  const bulkWin = () => { const m = modal(); return m && m.querySelector("#dcBulkForm") ? m : null; };
  const $b = (sel) => bulkWin() && bulkWin().querySelector(sel);
  id("dcBulk").click(); await wait(() => !!bulkWin());
  ok("the list window offers Free shipping only, “Also free shipping” and the minimum order too", [...$b("#dcKind").options].some(o => o.value === "shipping") && !!$b("#dcFreeShip") && !!$b("#dcMinOrder"));
  type($b("#dcEmails"), "jo@example.com, kim@example.com");
  type($b("#dcPrefix"), "SHIP-");
  pick($b("#dcKind"), "amount"); type($b("#dcValue"), "5"); tick($b("#dcFreeShip"), true); $b("#dcMinOrder").value = "40";
  reset(); fire($b("#dcBulkForm"), "submit"); await wait(() => !!bulkWin() && !bulkWin().querySelector("#dcBulkDone").hidden); await idle();
  { const b = of("createDiscountCodes")[0] || {};
    const made = d1.q("SELECT * FROM discount_codes WHERE code LIKE 'SHIP-%' ORDER BY id");
    ok("$5 off with free shipping and a $40 minimum for two addresses: sent with minOrder 40 and freeShipping true, and both codes have them",
      b.kind === "amount" && b.amount === 5 && b.minOrder === 40 && b.freeShipping === true && made.length === 2 && made.every(r => r.minOrderCents === 4000 && r.freeShipping === 1 && r.goodsOff === 1)); }
  bulkWin().querySelector("#dcBulkClose").click(); await wait(() => !bulkWin());
  id("dcBulk").click(); await wait(() => !!bulkWin());
  type($b("#dcEmails"), "lee@example.com"); type($b("#dcPrefix"), "FS-"); pick($b("#dcKind"), "shipping");
  $b("#dcMinOrder").value = "0.001";
  reset(); fire($b("#dcBulkForm"), "submit"); await idle();
  ok("a minimum that isn't an amount is refused there too, nothing sent", text($b("#dcErr")) === "Enter a minimum order from $0.01 to $100,000, or leave it blank." && sent.length === 0);
  $b("#dcMinOrder").value = "";
  reset(); fire($b("#dcBulkForm"), "submit"); await wait(() => !!bulkWin() && !bulkWin().querySelector("#dcBulkDone").hidden); await idle();
  { const b = of("createDiscountCodes")[0] || {}; const r = d1.q("SELECT * FROM discount_codes WHERE code LIKE 'FS-%'")[0];
    ok("Free shipping only for a list: kind shipping, no value, no minimum; the code takes nothing off the goods", b.kind === "shipping" && b.percent === null && b.amount === null && !("minOrder" in b) && b.freeShipping === true &&
      !!r && r.goodsOff === 0 && r.freeShipping === 1 && !r.minOrderCents); }
  bulkWin().querySelector("#dcBulkClose").click(); await wait(() => !bulkWin());
})().catch((e) => { console.error(e); ok("the test ran to the end", false); });
