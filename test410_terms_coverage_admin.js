process.env.TZ = "UTC";
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");
// Phase 7 in the admin pages, the parts the other tests leave unrun (a V8 coverage measurement found them):
//   the Orders row buttons clicked through the page's own click handling (Net 30…, Accept PO, Check in garments…);
//   the Net 30 window and Accept PO with nothing loaded, an accepted PO with no name, an invoice already sent, a shop
//   rule with no default days, a row's Accept PO when the server sent no PO status, a role with no invoices;
//   completing an order with no PO or no lines; the Orders list and card with no payment method, the card's paid
//   colours, a personalised line on the customer's garments; every shop's orders with no rule known yet;
//   Home's money part with Unpaid POs or Money in and out but no totals, and the New list's Net 30 tag with no name;
//   the Run order's cards and its paid-not-run table waiting on the customer's garments;
//   Global settings: a waiver sent on its own, and no Gift cards tick; Edit items: a new line with the customer's own
//   design; Check in garments…: finding the line (another shop's list, a line known by its id, a failed load), the
//   window opened on the line's own check-ins, without a context, the slip with no business name and its tidying;
//   Reports → Unpaid POs with an answer missing parts (totals, names, groups, dates, customers), the Shop filter
//   when a shop goes away, its CSV, a stale failure; the Customers pages with no default days in the answer;
//   a quote's lines with parts missing, and Convert to order where the shop doesn't take Net 30.
// The real admin.js, admin-receivables.js, admin-garments.js, admin-customers.js and admin-quotes.js in jsdom, with
// the real orders.js / db.js on sql.js behind fetch (migrations/0121), set up as test406 does. Invented shops, people
// and PO numbers only. "Today" is fixed at 2026-12-15 on the page and asked for as such; every stored time is noon UTC.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
globalThis.__f410 = {};
globalThis.__role410 = "admin";
const L = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role410] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role410" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club', school: 'school' }, orgs: {}, features: globalThis.__f410 });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false, sendGiftCardEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const setMarketingChoice = async () => ({});\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost };")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });
const TODAY = "2026-12-15";
const noon = (ymd) => ymd + "T12:00:00.000Z";

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const waits = [];
    const res = await L.post({ env: { DB: d1, DESIGNS: {} }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const must = async (body) => { const r = await call(body); if (r.status !== 200) throw new Error("seed " + body.action + ": " + JSON.stringify(r.body)); return r.body; };
  const orderRow = (id) => d1.q("SELECT * FROM orders WHERE orderId = ?", id)[0];
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1), ('school','school','Example School Shop','t','t',1);
    INSERT INTO customers (id, name, email, phone, createdAt, updatedAt) VALUES (1, 'Pat Example', 'pat@example.com', '555-0101', '2026-01-02T12:00:00.000Z', 't');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt, allowNet30, termsDays) VALUES (2, '', 'Example School District', 'ap@example.org', '2026-01-02T12:00:00.000Z', 't', 1, 45);`);
  for (const org of ["club", "school"])
    await must({ action: "createProduct", org, productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });

  // ---- The page ---------------------------------------------------------------------------------------------------
  const quotesJs = read("public/admin-quotes.js");
  const adminJs = read("public/admin.js"), custJs = read("public/admin-customers.js"), recvJs = read("public/admin-receivables.js"), garmJs = read("public/admin-garments.js");
  const sent = [], toasts = [], served = [], blobs = [];
  let scripted = [];       // [{ action, status, body | throws | empty }]: the next request for that action is answered with this
  let hold = null;         // { action, gate }: the next request for that action waits for gate
  let failScript = null;   // a script name that can't be fetched
  let scriptGate = null;   // { name, gate }: that script arrives when gate settles
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      served.push(String(url));
      const name = (String(url).match(/\/([\w-]+\.js)(\?|$)/) || [])[1];
      if (name && name === failScript) return Promise.reject(new Error("offline"));
      if (scriptGate && name === scriptGate.name) { const g = scriptGate.gate; scriptGate = null; return g.then(() => Buffer.from(name === "admin-receivables.js" ? recvJs : garmJs)); }
      if (name === "admin-receivables.js") return Promise.resolve(Buffer.from(recvJs));
      if (name === "admin-garments.js") return Promise.resolve(Buffer.from(garmJs));
      if (name === "admin.js") return Promise.resolve(Buffer.from(adminJs));
      if (name === "admin-customers.js") return Promise.resolve(Buffer.from(custJs));
      if (name === "admin-quotes.js") return Promise.resolve(Buffer.from(quotesJs));
      return Promise.resolve(Buffer.from(""));
    }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  let pageErrors = 0;   // an exception thrown by the page's own code (an event handler, a timer)
  vc.on("jsdomError", (e) => { if (!/Not implemented|Could not load script/.test(e.message)) { pageErrors++; console.error(e); } });
  let inflight = 0;
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.scrollTo = () => {};
      win.print = () => { win.__printed = (win.__printed || 0) + 1; win.__slipAtPrint = win.document.getElementById("ogSlipPrint") ? win.document.getElementById("ogSlipPrint").outerHTML : ""; win.__printingClass = win.document.body.classList.contains("og-printing"); };
      win.URL.createObjectURL = (b) => { blobs.push(b); return "blob:csv"; };
      win.URL.revokeObjectURL = () => {};
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(JSON.parse(JSON.stringify(b))); inflight++;
        try {
          const i = scripted.findIndex(s => s.action === b.action);
          if (i >= 0) { const s = scripted.splice(i, 1)[0]; if (s.gate) await s.gate; if (s.empty) throw new Error(""); if (s.throws) throw new Error(s.throws); return reply(s.status || 200, s.body); }
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
  // Today on the page is fixed; a day offset still works from it.
  w.eval(`localToday_ = function (off) { const t = "${TODAY}"; return off ? addDays_(t, off) : t; };`);
  w.eval("adminOrgs = " + JSON.stringify([{ orgId: "school", name: "Example School Shop" }, { orgId: "club", name: "Example Club" }]) + ";");
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const id = (s) => d.getElementById(s);
  const app = id("app");
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const of = (action) => sent.filter(b => b.action === action).map(b => { const c = Object.assign({}, b); delete c.key; delete c.listHeld; return c; });
  const reset = () => { sent.length = 0; toasts.length = 0; };
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const typeIn = (el, v) => { el.value = v; fire(el, "input"); };
  const choose = (el, v) => { el.value = v; fire(el, "change"); };
  const tick = (el, v) => { el.checked = v; fire(el, "change"); };
  const levelsOf = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role]);
  const asRoles = (pageRole, serverRole) => { globalThis.__role410 = serverRole || pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  const signInWith = (perms, serverRole) => { globalThis.__role410 = serverRole || "admin"; w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(perms)}; adminAreas = ${JSON.stringify(roles.PERMISSION_AREAS)};`); };
  const withLevels = (role, changes) => Object.assign({}, levelsOf(role), changes);
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const confirmBox = () => q(".confirm-modal");
  const answer = async (yes) => {
    await wait(() => !!confirmBox()); const box = confirmBox();
    const msg = box.dataset.message || text(box);
    box.querySelector(yes ? "#cmOk" : "#cmCancel").click(); await pause(30);
    return msg;
  };
  const hashNow = () => w.location.hash.replace(/^#\/?/, "");
  const fetched = (name) => served.filter(u => u.endsWith("/" + name)).length;
  const features = (f) => { globalThis.__f410 = Object.assign({}, f); w.applyFeatures_(Object.assign({}, f)); };
  asRoles("admin");
  features({});
  w.renderAdminNav();
  w.refreshOrderRows_ = (org, ids) => { w.__refreshed = (w.__refreshed || []).concat([[org, ids]]); };


  const WAIVER = "Customer's garments are decorated at the customer's risk; we're not responsible for garments damaged in normal production.";
  await must({ action: "updateTermsSettings", terms: { defaultDays: 30, startsAt: "invoice" } });
  await must({ action: "updateFeatures", features: { ownGarments: true, ownGarmentsWaiver: WAIVER } });
  features({ ownGarments: true });
  { const g = await must({ action: "getGlobalSettings" });
    const pay = Object.assign({}, (g.globalSettings || g.settings || g).enabledPayments || {}, { net30: true });
    await must({ action: "updateGlobalSettings", globalSettings: { enabledPayments: pay } }); }
  let seq = 0;
  const sale = async (org, placed, extra, qty = 1) => {
    const oid = (await must(Object.assign({ action: "createLocalSale", org, requestId: "seed410-" + (++seq) + "-abcdef", customerName: "Walk-in",
      paymentMethod: "Net 30", net30: true, items: [{ productId: "mug", size: "", qty }] }, extra || {}))).orderId;
    d1._raw.exec(`UPDATE orders SET placedAt = '${noon(placed)}' WHERE orderId = '${oid}'`);
    return oid;
  };
  const oNoPo = await sale("club", "2026-12-01", { customerId: 2, customerName: "Example School District" });
  const oCheck = await sale("club", "2026-12-05", { customerId: 1, customerName: "Pat Example" });
  d1._raw.exec(`UPDATE orders SET poNumber = 'PO-1002', poTypedAt = '${noon("2026-12-06")}' WHERE orderId = '${oCheck}'`);
  const oOk = await sale("club", "2026-12-01", { customerId: 1, customerName: "Pat Example", poNumber: "1003" });
  const oPlain = await sale("club", "2026-12-10", { paymentMethod: "Cash", net30: undefined });
  const oOwn = (await must({ action: "createLocalSale", org: "club", requestId: "seed410-own-abcdef", customerId: 1, customerName: "Pat Example", paymentMethod: "Cash",
    items: [{ productId: "mug", size: "", qty: 3, customerOwned: true }] })).orderId;
  const ORG = { orgId: "club", name: "Example Club" };
  const reload = async (org = "club") => { w._ordersCache = w._ordersCache || {}; const r = await must({ action: "getOrders", org, dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    w._ordersCache[org] = r.orders; (w._ordersNet30 = w._ordersNet30 || {})[org] = r.net30; return r; };
  const get = (oid, org = "club") => (w._ordersCache[org] || []).find(o => o.orderId === oid);
  const copy = (o) => JSON.parse(JSON.stringify(o));
  await reload();
  ok("(seeded: a Net 30 order with no PO, one with a PO the customer typed, one accepted, a plain one and one on the customer's own garments)",
    !!get(oNoPo) && get(oCheck).poStatus === "PO to check" && get(oOk).poStatus === "accepted" && !get(oPlain).net30 && get(oOwn).items[0].customerOwned === true);

  // ==============================================================================================================
  console.log("\n=== The Orders buttons run through the page's own click handling ===");
  // ==============================================================================================================
  const n30 = () => { const m = modal(); return m && m.querySelector("#n30Form") ? m : null; };
  const n30q = (s) => n30().querySelector(s);
  const closeTerms = async () => { n30q("#n30Cancel").click(); await pause(20); if (confirmBox()) confirmBox().querySelector("#cmOk").click(); await wait(() => !n30()); };
  { const cellOf = (o) => { const h = d.createElement("div"); h.innerHTML = w.adminActionCell(ORG, o); return h; };
    const has = (h, a) => !!h.querySelector(`[data-admin-action="${a}"]`);
    signInWith(withLevels("admin", { "orders.invoices": "none" }));
    ok("a role with no access to invoices gets none of the invoice buttons on a cleared order's row, but still Net 30…", !has(cellOf(get(oOk)), "showSendInvoiceModal") && !has(cellOf(get(oOk)), "downloadOrderPdf_") &&
      has(cellOf(get(oOk)), "showOrderTerms_"));
    asRoles("admin");
    ok("…an admin's row has them", has(cellOf(get(oOk)), "showSendInvoiceModal") && has(cellOf(get(oOk)), "downloadOrderPdf_")); }
  const host = d.createElement("div"); d.body.appendChild(host);
  const place = (html) => { host.innerHTML = html; return host; };
  const btnIn = (action) => host.querySelector(`[data-admin-action="${action}"]`);
  place(w.adminActionCell(ORG, get(oCheck)));
  reset(); btnIn("showOrderTerms_").click(); await wait(() => !!n30()); await idle();
  ok("clicking a row's Net 30… opens that order's Net 30 window", !!n30() && text(n30().querySelector("[data-dialog-title]")) === "Net 30 — " + oCheck);
  await closeTerms();
  place(w.adminActionCell(ORG, get(oCheck)));
  reset(); btnIn("acceptOrderPoRow_").click();
  let asked = await answer(false); await idle();
  ok("clicking a row's Accept PO asks about that order's PO, and No sends nothing", /^Accept PO-1002 for order /.test(asked) && asked.includes(oCheck) && of("acceptOrderPo").length === 0);
  { const h = w.ownGarmentLineHtml_(get(oOwn), get(oOwn).items[0], "club");
    place(h); btnIn("showGarmentCheckinFor_").dataset.item = "999999";
    reset(); btnIn("showGarmentCheckinFor_").click(); await idle();
    ok("clicking a line's Check in garments… looks that line up (one no longer in the list: “That line isn't in the list — refresh it.”)",
      lastToast().m === "That line isn't in the list — refresh it." && lastToast().err && of("listGarmentCheckins").length === 0); }
  host.innerHTML = "";

  // ==============================================================================================================
  console.log("\n=== The Net 30 window and Accept PO with nothing loaded, and their fallbacks ===");
  // ==============================================================================================================
  { const keepCache = w._ordersCache, keepRule = w._ordersNet30;
    w._ordersNet30 = undefined;
    ok("no shop's Net 30 rule known at all: a shop's rule is “not allowed”", same(w.net30Rule_("club"), { allowed: false }));
    w._ordersCache = undefined;
    reset(); await w.showOrderTerms_("club", oCheck);
    ok("no orders loaded at all: the Net 30 window says “Order not found — refresh the list.”", lastToast().m === "Order not found — refresh the list." && lastToast().err && !n30());
    reset(); const p = w.acceptOrderPoRow_("club", oCheck); asked = await answer(false); await p;
    ok("…and a row's Accept PO asks about “the PO”, sending nothing on No", /^Accept the PO for order /.test(asked) && of("acceptOrderPo").length === 0);
    w._ordersCache = keepCache; w._ordersNet30 = keepRule; }
  { const o = Object.assign(copy(get(oOk)), { orderId: "FAKE-ACC", poAcceptedBy: "", termsDays: null, invoicedAt: noon("2026-12-02"), termsDueDate: "2027-01-01" });
    w._ordersCache.club.push(o);
    const keep = w._ordersNet30.club; w._ordersNet30.club = { allowed: true };
    reset(); w.showOrderTerms_("club", "FAKE-ACC"); await wait(() => !!n30()); await idle();
    const facts = text(n30q("#n30Facts"));
    ok("a PO accepted by nobody named: “Accepted …” with no “by”", /Accepted [^·]+Due/.test(facts) && !/ by /.test(facts));
    ok("an invoice already sent: “· invoice first sent Dec 2, 2026”-style date after the terms", facts.includes("· invoice first sent " + w.adminDate_(noon("2026-12-02"))) && !/no invoice sent yet/.test(facts));
    ok("a shop's rule that names no default days: Net 30, and the days box says “Default (30)”", /· Net 30 ·/.test(facts) && n30q("#n30Days").placeholder === "Default (30)");
    await closeTerms();
    w._ordersNet30.club = keep;
    w._ordersCache.club = w._ordersCache.club.filter(x => x.orderId !== "FAKE-ACC"); }
  { const cellOf = (o) => { const h = d.createElement("div"); h.innerHTML = w.adminActionCell(ORG, o); return h; };
    const has = (h, a) => !!h.querySelector(`[data-admin-action="${a}"]`);
    const noStatus = (o, extra) => { const c = Object.assign(copy(o), extra || {}); delete c.poStatus; return c; };
    ok("a row whose order came without a PO status: a typed PO not accepted still gets Accept PO", has(cellOf(noStatus(get(oCheck))), "acceptOrderPoRow_"));
    ok("…an accepted one doesn't", !has(cellOf(noStatus(get(oOk))), "acceptOrderPoRow_") && has(cellOf(noStatus(get(oOk))), "showOrderTerms_"));
    ok("…nor one with no PO (or only spaces)", !has(cellOf(noStatus(get(oCheck), { poNumber: "  " })), "acceptOrderPoRow_") && !has(cellOf(noStatus(get(oCheck), { poNumber: undefined })), "acceptOrderPoRow_"));
  }
  { const base = Object.assign(copy(get(oOk)), { deliveredAt: noon("2026-12-10"), paid: false });
    ok("a delivered Net 30 order with an accepted PO can be completed", w.canCompleteOrder(base) === true);
    ok("…not when the order has no PO number at all", w.canCompleteOrder(Object.assign(copy(base), { poNumber: undefined })) === false && w.canCompleteOrder(Object.assign(copy(base), { poNumber: null })) === false);
    ok("an order with no lines can't be completed, even paid and delivered", w.canCompleteOrder(Object.assign(copy(base), { paid: true, items: undefined })) === false); }

  // ==============================================================================================================
  console.log("\n=== The Orders list and the order card ===");
  // ==============================================================================================================
  { const o = copy(get(oNoPo)); delete o.paymentMethod;
    const t = d.createElement("table"); t.innerHTML = "<tbody>" + w.orderRowsHtml_([o], () => ORG, () => null, false) + "</tbody>";
    const cell = t.querySelector("td[data-paid-td]").previousElementSibling;
    ok("an order with no payment method: “—” in its Payment cell, then its Net 30 tag", /^—\s*Net 30 — PO needed$/.test(text(cell)) && !!cell.querySelector(".n30-tag")); }
  { const card = (o) => { const h = d.createElement("div"); h.innerHTML = w.orderCardHtml_(o, ORG, null, false); return h; };
    const paidSpan = (h) => h.querySelector(".oc-amt .oc-dim span");
    const paidO = Object.assign(copy(get(oPlain)), { paid: true });
    ok("a paid order's card: “Paid” in green", text(paidSpan(card(paidO))) === "Paid" && /#166534/.test(paidSpan(card(paidO)).getAttribute("style")));
    const pod = Object.assign(copy(get(oPlain)), { paid: false, payOnDelivery: true });
    ok("an order to pay on delivery: “Unpaid · on delivery” in amber", text(paidSpan(card(pod))) === "Unpaid · on delivery" && /#b45309/.test(paidSpan(card(pod)).getAttribute("style")));
    const unpaid = Object.assign(copy(get(oPlain)), { paid: false, payOnDelivery: false });
    ok("an unpaid order: “Unpaid” in red", /#b03a2e/.test(paidSpan(card(unpaid)).getAttribute("style")));
    const noMethod = copy(get(oNoPo)); delete noMethod.paymentMethod;
    ok("no payment method on the card: “· —”, with the Net 30 tag under it", /· —$/.test(text(card(noMethod).querySelector(".oc-amt .oc-dim"))) && !!card(noMethod).querySelector(".oc-amt .n30-tag"));
    const pers = copy(get(oOwn));
    Object.assign(pers.items[0], { personalized: true, persName: "Sam", config: { garmentColor: "Navy", locations: [] } });
    const main = text(card(pers).querySelector(".oc-item-main"));
    ok("a card's line on the customer's garments shows its personalization and its picks too", /· “Sam”/.test(main) && /· Navy/.test(main) && /Customer's garments/.test(main));
    delete pers.items[0].persName;
    ok("…personalized with no name typed: “yes”", /· “yes”/.test(text(card(pers).querySelector(".oc-item-main")))); }
  { const keep = w._ordersNet30;
    w._ordersNet30 = undefined;
    reset(); w.location.hash = "#orders/all";
    await wait(() => of("getOrdersAllShops").length > 0 && !!q(`#app tr[data-order="${oCheck}"]`), 1500); await idle();
    ok("every shop's orders at once with no rule known yet: each shop's rule is kept from its part of the answer",
      !!w._ordersNet30 && same(w._ordersNet30.club, { allowed: true, defaultDays: 30 }));
    if (!w._ordersNet30) w._ordersNet30 = keep;
    w.location.hash = "#home"; await idle(); }
  await reload();

  // ==============================================================================================================
  console.log("\n=== Home: the money part without money blocks, and the New list ===");
  // ==============================================================================================================
  { const dash = await must({ action: "getDashboard", today: TODAY });
    const realShown = w.homeShown_;
    const made = !id("homeMoney"), money = id("homeMoney") || d.createElement("div"); money.id = "homeMoney"; if (made) d.body.appendChild(money);
    const blocks = () => [...money.querySelectorAll("[data-home-block]")].map(e => e.dataset.homeBlock);
    w.homeShown_ = () => ["orders", "inout"];
    w.drawHomeMoney_(dash);
    ok("(the dashboard sent Money in and out)", !!dash.inOut);
    ok("only Money in and out shown: that block alone, no Unpaid POs and no business totals", same(blocks(), ["inout"]) && /Money in and out/.test(text(money)) && !money.querySelector(".home-card") &&
      !money.querySelector('a[href="#revenue"]') && !/Revenue report/.test(text(money)));
    { const bare = copy(dash); delete bare.year; delete bare.month; delete bare.monthFrom;
      const errs = pageErrors; let threw = false;
      try { w.drawHomeMoney_(bare); } catch (e) { threw = true; }
      ok("…drawn from an answer with no year or month figures at all (they aren't needed then)", !threw && pageErrors === errs && same(blocks(), ["inout"]) && !/didn't come back/.test(text(money))); }
    w.homeShown_ = () => ["orders", "unpaidpos", "inout"];
    w.drawHomeMoney_(dash);
    ok("Unpaid POs and Money in and out without the totals: both, Unpaid POs first", same(blocks(), ["unpaidpos", "inout"]) && !money.querySelector(".home-card"));
    w.homeShown_ = () => ["orders", "unpaidpos"];
    w.drawHomeMoney_(dash);
    ok("Unpaid POs alone: just that block", same(blocks(), ["unpaidpos"]) && qa("#homeMoney .home-po-card").length === 4);
    w.homeShown_ = realShown; if (made) money.remove(); }
  { scripted = [{ action: "getOpenOrders", body: { status: "ok", count: 1, orders: [{ orderId: "N30-9001", orgId: "club", orgName: "Example Club", homeStage: "new", net30: true, poNumber: "",
      placedAt: noon("2026-12-10"), items: [{ qty: 1, name: "Club Mug", size: "" }], effectiveTotal: 10 }] } }];
    reset(); w.history.replaceState(null, "", "#home/new"); await w.adminRoute(); await wait(() => qa("#app tr.dash-row").length > 0, 300); await idle();
    const row = q('#app tr.dash-row[data-order="N30-9001"]');
    ok("the New list: an order with no customer name shows only its Net 30 tag in the customer column", !!row && text(row.children[3]) === "Net 30 — PO needed" && !!row.children[3].querySelector(".n30-tag-need"));
    w.history.replaceState(null, "", "#home"); }

  // ==============================================================================================================
  console.log("\n=== The Run order: waiting on the customer's garments ===");
  // ==============================================================================================================
  { const c = { itemId: 7, orderId: "RO-1", orgId: "club", orgName: "Example Club", customerName: "Pat Example", qty: 2, itemName: "Club Mug", blankReceived: false, transferReceived: true, transferShort: [] };
    const box = (html) => { const h = d.createElement("div"); h.innerHTML = html; return text(h); };
    ok("a transfer card for the customer's own garments waits on “the customer's garments”", /Waiting on the customer's garments/.test(box(w.runDtfCardHtml_(Object.assign({}, c, { customerOwned: true }), false, false))));
    ok("…one with a blank waits on the blank", /Waiting on blank/.test(box(w.runDtfCardHtml_(Object.assign({}, c, { customerOwned: false }), false, false))) &&
      !/customer's garments/.test(box(w.runDtfCardHtml_(Object.assign({}, c, { customerOwned: false }), false, false))));
    ok("…and one short of transfers too: “the customer's garments and transfers”", /Waiting on the customer's garments and transfers/.test(box(w.runDtfCardHtml_(Object.assign({}, c, { customerOwned: true, transferReceived: false }), false, false))));
    const other = Object.assign({}, c, { type: "screenprint", locations: [] });
    ok("a screen print card for the customer's own garments waits on “the customer's garments”", /Waiting on the customer's garments/.test(box(w.runOtherCardHtml_(Object.assign({}, other, { customerOwned: true }), false, false))));
    ok("…one with a blank, on the blank", /Waiting on blank/.test(box(w.runOtherCardHtml_(Object.assign({}, other, { customerOwned: false }), false, false))));
    const readyC = Object.assign({}, c, { customerOwned: true, blankReceived: true });
    delete readyC.transferShort;
    ok("ready (the garments are in): the cards wait on nothing and offer Mark made / Start", !/Waiting on/.test(box(w.runDtfCardHtml_(readyC, true, false))) && /Mark made/.test(box(w.runDtfCardHtml_(readyC, true, false))) &&
      !/Waiting on/.test(box(w.runOtherCardHtml_(Object.assign({}, other, readyC, { type: "screenprint" }), true, false))) && /Start/.test(box(w.runOtherCardHtml_(Object.assign({}, other, readyC, { type: "screenprint" }), true, false))));
    ok("garments in but transfers not received: waiting on “transfers” alone", /Waiting on transfers/.test(box(w.runDtfCardHtml_(Object.assign({}, c, { customerOwned: true, blankReceived: true, transferReceived: false }), false, false))) &&
      !/garments/.test(box(w.runDtfCardHtml_(Object.assign({}, c, { customerOwned: true, blankReceived: true, transferReceived: false }), false, false)).replace("Customer's garments", "")));
    const noShort = Object.assign({}, c, { customerOwned: true, transferReceived: false }); delete noShort.transferShort;
    ok("…a card with no shortage list still waits on transfers not received", /Waiting on the customer's garments and transfers/.test(box(w.runDtfCardHtml_(noShort, false, false)))); }
  { const base = { orgId: "club", orderId: "PU-1", orgName: "Example Club", customerName: "Pat Example", placedAt: noon("2026-12-10"), items: [{ qty: 2, name: "Club Mug", size: "M" }], types: [] };
    const cellOf = (o) => { const t = d.createElement("table"); t.innerHTML = w.paidUnrunHtml_([Object.assign({}, base, o)]); const tds = t.querySelectorAll("td"); return tds[tds.length - 1]; };
    let c = cellOf({ needsBlanks: false, garmentsStatus: "Waiting on the customer's garments", ownGarments: { lines: 1, waiting: 1 } });
    ok("paid, not run, only the customer's garments: “Waiting on the customer's garments” in red", text(c) === "Waiting on the customer's garments" && /#b03a2e/.test(c.querySelector(".ro-garments").getAttribute("style")));
    c = cellOf({ needsBlanks: false, garmentsStatus: "Garments in", ownGarments: { lines: 1, waiting: 0 } });
    ok("…once they're in: “Garments in” in green", text(c) === "Garments in" && /#166534/.test(c.querySelector(".ro-garments").getAttribute("style")));
    c = cellOf({ needsBlanks: true, blankReceived: true, garmentsStatus: "Waiting on the customer's garments", ownGarments: { lines: 1, waiting: 1 } });
    ok("blanks as well: “Blanks in”, then the garments on their own line", /^Blanks in\s*Waiting on the customer's garments$/.test(text(c)) && !!c.querySelector("br"));
    c = cellOf({ needsBlanks: true });
    ok("blanks and no garments: “Blanks not ordered yet” alone", text(c) === "Blanks not ordered yet" && !c.querySelector(".ro-garments"));
    ok("no blank needed and no garments: “From stock” or “No blank needed”", text(cellOf({ needsBlanks: false, allFromStock: true })) === "From stock" && text(cellOf({ needsBlanks: false })) === "No blank needed");
    ok("blanks ordered: “Blanks ordered”", text(cellOf({ needsBlanks: true, blankOrdered: true })) === "Blanks ordered");
    ok("nothing paid and unrun: no table", w.paidUnrunHtml_([]) === "" && w.paidUnrunHtml_(null) === ""); }

  // ==============================================================================================================
  console.log("\n=== Global settings: the waiver the server sends, and no Gift cards tick ===");
  // ==============================================================================================================
  const drawSettings = async () => { reset(); await w.renderGlobalSettings(app); await wait(() => !!id("gPayCard")); await idle(); };
  { const real = await must({ action: "getFeatures" });
    scripted = [{ action: "getFeatures", body: Object.assign({}, real, { ownGarmentsWaiver: "Garments are at your risk (sent on its own).", features: Object.assign({}, real.features, { ownGarmentsWaiver: "Not this one." }) }) }];
    await drawSettings();
    ok("a waiver sent on its own (not inside the switches) is the one shown", id("gOwnWaiver").value === "Garments are at your risk (sent on its own).");
    scripted = [{ action: "getFeatures", body: Object.assign({}, real, { features: Object.assign({}, real.features, { giftCards: false }) }) }];
    await drawSettings();
    ok("gift cards switched off: no Gift cards payment tick", !id("gPayGiftCard") && !!id("gPayNet30"));
    reset(); await w.submitGlobalSettings(); await idle();
    const s = of("saveGlobalSettingsAll")[0];
    ok("…and Save sends no gift card payment choice (the stored one stays), but still Net 30", !!s && !("giftCard" in s.settings.payments) && s.settings.payments.net30 === true); }

  // ==============================================================================================================
  console.log("\n=== Edit items: a new line with the customer's own design ===");
  // ==============================================================================================================
  await must({ action: "createProduct", org: "club", productId: "logo-tee", type: "shirt", name: "Logo Tee", pricingMode: "flat", flatPrice: 15, visible: true, weightOz: 6,
    customDesign: "transfer", customDesignPrice: 5, noDesignNeeded: true });
  { await reload(); reset();
    const p = w.editOrder("club", oPlain); await wait(() => !!q("#editOrderSave")); await idle();
    q("#editOrderAddRow").click(); await idle();
    const sel = qa('select[data-field="productId"]').pop();
    choose(sel, "logo-tee"); await idle();
    const cd = () => q('input[data-field="customDesign"]');
    ok("(a new line of a product that takes the customer's own design, and has a design of its own, has that tick, unticked)", !!cd() && !cd().checked && !cd().disabled);
    tick(cd(), true); await idle();
    ok("ticking it keeps it ticked when the lines are drawn again, and the customer's own garment tick is still there", !!cd() && cd().checked && qa('input[data-field="customerOwned"]').length === 2);
    tick(qa('input[data-field="customerOwned"]')[1], true);
    q("#editOrderSave").click(); await pause(30); if (confirmBox()) confirmBox().querySelector("#cmOk").click(); await p; await idle();
    const ed = of("editOrder")[0];
    ok("…saved: the added line goes with its own design and on the customer's garments", !!ed && ed.additions.length === 1 && ed.additions[0].customDesign === true && ed.additions[0].customerOwned === true); }

  // ==============================================================================================================
  console.log("\n=== Check in garments…: finding the line ===");
  // ==============================================================================================================
  await reload();
  const ownItemId = d1.q("SELECT id FROM order_items WHERE orderId = ?", oOwn)[0].id;
  { const keep = w._ordersCache;
    w._ordersCache = undefined;
    reset(); await w.showGarmentCheckinFor_("club", oOwn, String(ownItemId));
    ok("no orders loaded at all: “That line isn't in the list — refresh it.”", lastToast().m === "That line isn't in the list — refresh it." && lastToast().err);
    const o = copy(keep.club.find(x => x.orderId === oOwn));
    o.items.forEach(it => { delete it.sheetRow; });
    w._ordersCache = { school: [o, { orderId: "NO-LINES" }] };
    let got = null;
    w.showGarmentCheckin_ = async (orderId, item, ctx) => { got = { orderId, item, ctx }; };
    reset(); await w.showGarmentCheckinFor_("club", oOwn, String(ownItemId));
    ok("an order listed under another shop is still found, and a line known only by its id", !!got && got.orderId === oOwn && got.item.id === ownItemId && got.ctx.orgId === "club" && got.ctx.order.orderId === oOwn);
    got = null; reset(); await w.showGarmentCheckinFor_("club", "NO-LINES", "1");
    ok("an order with no lines: “That line isn't in the list — refresh it.”", !got && lastToast().m === "That line isn't in the list — refresh it.");
    w.showGarmentCheckin_ = undefined;
    w._ordersCache = keep;
    const realEnsure = w.ensureGarmentsUi_;
    w.ensureGarmentsUi_ = () => Promise.reject(new Error(""));
    reset(); await w.showGarmentCheckinFor_("club", oOwn, String(ownItemId));
    ok("the window's script failing with no words: “Couldn't load the garment check-in”", lastToast().m === "Couldn't load the garment check-in" && lastToast().err);
    w.ensureGarmentsUi_ = realEnsure;
    await w.ensureGarmentsUi_(); }

  // ==============================================================================================================
  console.log("\n=== Check in garments…: the window ===");
  // ==============================================================================================================
  const og = () => { const m = modal(); return m && m.querySelector("#ogForm") ? m : null; };
  const ogq = (s) => og().querySelector(s);
  const ogRows = () => [...og().querySelectorAll(".og-row")];
  const cellVals = (tr) => [tr.querySelector(".og-size").value, tr.querySelector(".og-exp").value, tr.querySelector(".og-rec").value, tr.querySelector(".og-cond").value, tr.querySelector(".og-note").value];
  const closeOg = async () => { ogq("#ogCancel").click(); await wait(() => { if (confirmBox()) confirmBox().querySelector("#cmOk").click(); return !og(); }); };
  reset(); await w.showGarmentCheckin_("X-1", null);
  ok("no line given: “That line can't be found — refresh the list.”", lastToast().m === "That line can't be found — refresh the list." && lastToast().err && !og() && of("listGarmentCheckins").length === 0);
  scripted = [{ action: "listGarmentCheckins", empty: true }];
  reset(); await w.showGarmentCheckin_(oOwn, { id: ownItemId, name: "Club Mug", qty: 3 }, { orgId: "club" });
  ok("the check-ins can't be read and the line brought none: “Couldn't load the garment check-ins: unknown error”, no window",
    lastToast().m === "Couldn't load the garment check-ins: unknown error" && lastToast().err && !og());
  scripted = [{ action: "listGarmentCheckins", status: 500, body: { status: "error", message: "Offline." } }];
  reset(); w.showGarmentCheckin_(oOwn, { id: ownItemId, name: "Club Mug", qty: 3, size: "M",
    checkins: [{ size: "M", expectedQty: 2, receivedQty: 2, condition: "good", note: "", at: "" }, { expectedQty: 1, receivedQty: 0, condition: "good", note: "", at: "" }] }, { orgId: "club" });
  await wait(() => !!og()); await idle();
  ok("…but with the line's own check-ins (no line number on them): the window opens on those", !!og() && same(ogRows().map(cellVals), [["M", "2", "2", "good", ""], ["", "1", "0", "good", ""]]));
  ok("…a count with no time on it: no “Checked in …” line", !ogq("#ogLast"));
  ok("…one size not as expected: “2 of 3 received · 1 size not as expected”", text(ogq("#ogSum")) === "2 of 3 received · 1 size not as expected");
  choose(ogRows()[0].querySelector(".og-cond"), "damaged");
  ok("two sizes not as expected: “… · 2 sizes not as expected”", text(ogq("#ogSum")) === "2 of 3 received · 2 sizes not as expected");
  { let slipSeen = "";
    w.print = () => { const s = d.getElementById("ogSlipPrint"); slipSeen = s ? s.outerHTML : ""; };
    const before = Date.now(); ogq("#ogPrint").click();
    ok("…the slip stays up while the browser prints, and goes once it says printing ended", !!d.getElementById("ogSlipPrint") && (w.dispatchEvent(new w.Event("afterprint")), !d.getElementById("ogSlipPrint")));
    const slip = d.createElement("div"); slip.innerHTML = slipSeen;
    const at = text([...slip.querySelectorAll(".og-slip-facts tr")].find(tr => text(tr.querySelector("th")) === "Checked in").querySelector("td"));
    ok("a slip printed before any timed count says it was checked in now", at !== "" && (at === w.adminDateTime_(new Date(before).toISOString()) || at === w.adminDateTime_(new Date().toISOString()))); }
  { const errs = pageErrors; const before = ogRows().length;
    ogRows()[0].querySelector(".og-size").click(); ogRows()[0].click();
    ok("a click in the rows that isn't on × removes nothing (and nothing breaks)", ogRows().length === before && text(ogq("#ogErr")) === "" && pageErrors === errs); }
  await closeOg();
  // A real count, so the window has a time and an Undo; then opened from a line given only by its id, without a context.
  await must({ action: "checkInGarments", orderId: oOwn, itemId: ownItemId, counts: [{ size: "One size", expectedQty: 3, receivedQty: 3, condition: "good", note: "" }] });
  reset(); w.showGarmentCheckin_(oOwn, { id: ownItemId, qty: 3 }); await wait(() => !!og()); await idle();
  ok("opened with no context: the check-ins asked for without a shop, the line found by its id", same(of("listGarmentCheckins"), [{ action: "listGarmentCheckins", orderId: oOwn }]) &&
    same(ogRows().map(cellVals), [["One size", "3", "3", "good", ""]]) && !!ogq("#ogLast") && !!ogq("#ogUndo"));
  ok("…no customer in its head (none given), and no name for the line", !ogq(".og-head .og-dim + .og-dim") && text(ogq(".og-head strong")) === "");
  { const keepBiz = w.bizName_;
    w.bizName_ = undefined;
    Object.defineProperty(w, "onafterprint", { value: undefined, writable: true, configurable: true });
    let slipSeen = "", classSeen = false;
    w.print = () => { const s = d.getElementById("ogSlipPrint"); slipSeen = s ? s.outerHTML : ""; classSeen = d.body.classList.contains("og-printing"); };
    ogq("#ogPrint").click();
    const slip = d.createElement("div"); slip.innerHTML = slipSeen;
    ok("the slip with no business name: just “Garment check-in”", text(slip.querySelector(".og-slip-h")) === "Garment check-in" && classSeen);
    ok("…no Customer row, an empty Item, and the time it was checked in", ![...slip.querySelectorAll(".og-slip-facts th")].some(th => text(th) === "Customer") &&
      text([...slip.querySelectorAll(".og-slip-facts tr")].find(tr => text(tr.querySelector("th")) === "Item").querySelector("td")) === "" &&
      text([...slip.querySelectorAll(".og-slip-facts tr")].find(tr => text(tr.querySelector("th")) === "Checked in").querySelector("td")) !== "");
    ok("a browser that never says when printing ends: the slip is tidied away at once", !d.getElementById("ogSlipPrint") && !d.body.classList.contains("og-printing"));
    let afters = 0;
    w.print = () => { w.dispatchEvent(new w.Event("afterprint")); afters++; };
    const errs = pageErrors;
    ogq("#ogPrint").click();
    ok("…one that says so while printing: tidied once, nothing left behind and nothing breaks", afters === 1 && !d.getElementById("ogSlipPrint") && !d.body.classList.contains("og-printing") && pageErrors === errs);
    delete w.onafterprint;
    w.bizName_ = keepBiz; }
  ogq("#ogUndo").click();
  asked = await answer(true); await idle();
  ok("Undo with no context: sent without a shop, and taken back", same(of("undoGarmentCheckin"), [{ action: "undoGarmentCheckin", orderId: oOwn, itemId: ownItemId }]) &&
    lastToast().m === "Check-in taken back." && !og() && !d1.q("SELECT ownReceivedAt FROM order_items WHERE id = ?", ownItemId)[0].ownReceivedAt);

  // ==============================================================================================================
  console.log("\n=== Reports → Unpaid POs: answers with parts missing ===");
  // ==============================================================================================================
  const arPage = () => id("arPage");
  const drawn = () => !!arPage() && !/Loading…/.test(text(id("arBody")));
  const goAr = async () => { const old = arPage(); reset(); if (hashNow() === "unpaidpos") w.adminRoute(); else w.location.hash = "#unpaidpos"; await wait(() => arPage() && arPage() !== old && drawn()); await idle(); };
  const report = (r) => { scripted.push({ action: "getUnpaidPoReport", body: Object.assign({ status: "ok" }, r) }); };
  const csv = [];
  w.downloadCsv_ = (name, rows, cols) => { csv.push({ name, rows, cols }); };
  w.eval("adminOrgs = " + JSON.stringify([{ orgId: "zeta" }, { orgId: "club", name: "Example Club" }, { orgId: "alpha" }]) + ";");
  const R1 = { asOf: TODAY, startsAt: "invoice", totals: { count: "x", toCheck: 0 },
    rows: [{ orderId: "R-1", orgId: "club", group: "1-30", poNumber: "1001", daysLate: 5, owedCents: 1500, termsDays: null },
      { orderId: "R-2", group: "tocheck", poStatus: "PO to check", poNumber: "", owedCents: 500 },
      { orderId: "R-3", orgName: "Example Club", group: "weird", poNumber: "1003", owedCents: 100 },
      { orderId: "R-4", orgName: "Example Club", poNumber: "1004", owedCents: 100, termsDays: 45 }],
    customers: [{ customerId: 7 }, { customerId: null }] };
  report(R1);
  await goAr();
  ok("the Shop filter lists shops by name, a shop with none by its id", same([...id("arOrg").options].map(o => text(o)), ["All shops", "alpha", "Example Club", "zeta"]));
  ok("a total count that isn't a number: “0 orders”", /0 orders/.test(text(id("arTotals"))));
  ok("no late money in the totals: worked out from the rows (R-1, 5 days late, $15.00)", /\$15\.00\s*Late/.test(text(id("arTotals"))));
  const rowEl = (oid) => qa("#arBody tr[data-ar-row]").find(tr => text(tr.querySelector(".stack-title")).startsWith(oid));
  ok("a row with a PO but no status that is late: “Late”", text(rowEl("R-1").children[3]) === "Late");
  ok("…with no shop name, its shop id; with neither, nothing", /^R-1\s*club/.test(text(rowEl("R-1").children[0])) && text(rowEl("R-2").querySelector(".ar-sub")) === "");
  ok("no due date while terms start from the invoice: “—”", text(rowEl("R-1").children[5]) === "—");
  const custRows = qa("#arBody table.ar-customers tbody tr");
  ok("customers with no name: “Customer 7”, and “No customer record”; no count: 0", custRows.length === 2 && text(custRows[0].children[0]) === "Customer 7" && text(custRows[1].children[0]) === "No customer record" &&
    text(custRows[0].children[1]) === "0");
  ok("the Customer filter names a customer with no name “Customer 7”", [...id("arCustomer").options].some(o => o.value === "7" && text(o) === "Customer 7"));
  { const errs = pageErrors; reset();
    id("arTotals").click(); id("arBody").click(); await idle();
    ok("a click on the page that isn't on a button does nothing", of("getUnpaidPoReport").length === 0 && pageErrors === errs); }
  { reset(); id("arCsv").click();
    const c = csv.pop(), by = (oid) => c.rows.find(r => r.orderId === oid);
    ok("the CSV of every shop is named for the day alone", !!c && c.name === "unpaid-pos-" + TODAY + ".csv");
    ok("…a row with no shop name has its id; no customer, company or dates are blanks; no days of its own is blank", by("R-1").shop === "club" && by("R-1").customer === "" && by("R-1").company === "" &&
      by("R-1").placed === "" && by("R-1").invoiced === "" && by("R-1").completed === "" && by("R-1").terms === "" && by("R-1").group === "1–30 days late");
    ok("…a row with neither shop name nor id: an empty shop", by("R-2").shop === "" && by("R-2").group === "PO to check");
    ok("…a group the page doesn't know is named as sent, a missing one is blank", by("R-3").group === "weird" && by("R-4").group === "" && by("R-4").terms === 45); }
  { const p = (async () => { rowEl("R-2").querySelector("[data-ar-accept]").click(); })();
    asked = await answer(false); await p;
    ok("Accept PO on a row with no PO number asks about “the PO”", /^Accept the PO for order R-2\?/.test(asked) && of("acceptOrderPo").length === 0); }
  // The Shop filter: a shop picked, the page drawn again with it still there, then with it gone.
  report(R1);
  reset(); choose(id("arOrg"), "zeta"); await idle();
  ok("picking a shop asks for that shop's orders", of("getUnpaidPoReport").length === 1 && of("getUnpaidPoReport")[0].orgId === "zeta");
  { id("arCsv").click(); const c = csv.pop();
    ok("…and its CSV is named for the shop too", !!c && c.name === "unpaid-pos-" + TODAY + "-zeta.csv"); }
  // Drawn again straight away (the route would read the shops from the server first).
  const redraw = async () => { reset(); w.renderUnpaidPos(app); await wait(() => drawn() && of("getUnpaidPoReport").length > 0); await idle(); };
  report(R1);
  await redraw();
  ok("drawn again: the shop is still picked", id("arOrg").value === "zeta" && id("arOrg").selectedOptions[0].hasAttribute("selected") && of("getUnpaidPoReport")[0].orgId === "zeta");
  w.eval("adminOrgs = " + JSON.stringify([{ orgId: "club", name: "Example Club" }]) + ";");
  report(R1);
  await redraw();
  ok("drawn again once that shop is gone: “All shops”, and the shop dropped from the question", same([...id("arOrg").options].map(o => o.value), ["", "club"]) && id("arOrg").value === "" && !("orgId" in of("getUnpaidPoReport")[0]));
  w.eval("adminOrgs = null;");
  report(R1);
  await redraw();
  ok("no shop list at all: only “All shops”", same([...id("arOrg").options].map(o => o.value), [""]));
  w.eval("adminOrgs = " + JSON.stringify([{ orgId: "school", name: "Example School Shop" }, { orgId: "club", name: "Example Club" }]) + ";");
  // Nothing but the status: no rows, no customers, no groups.
  report({ asOf: TODAY });
  await goAr();
  ok("an answer with no rows, groups or customers: every group 0, “No Net 30 order has money owed…”", qa("#arGroups .ar-group").length === 7 && qa("#arGroups .ar-group-n").every(n => text(n) === "0") &&
    /No Net 30 order has money owed\./.test(text(id("arBody"))) && !q("#arBody table"));
  q('#arGroups [data-ar-group="nopo"]').click(); await idle();
  ok("…its groups still pick on a click", q('#arGroups [data-ar-group="nopo"]').getAttribute("aria-pressed") === "true");
  q('#arGroups [data-ar-group="nopo"]').click(); await idle();
  report({ asOf: TODAY, rows: [{ orderId: "R-9", orgName: "Example Club", group: "nopo", poStatus: "PO needed", owedCents: 900 }] });
  await goAr();
  ok("rows but no customers in the answer: the rows, and no By customer table", !!rowEl("R-9") && !q("#arBody table.ar-customers") && !/By customer/.test(text(id("arBody"))));
  scripted.push({ action: "getUnpaidPoReport", body: "not a report" });
  await goAr();
  ok("an answer that isn't a report at all: drawn as nothing owed", /No Net 30 order has money owed\./.test(text(id("arBody"))) && qa("#arGroups .ar-group").length === 7);
  // An error that arrives after a newer answer must not replace it.
  { let release; const gate = new Promise(r => { release = r; });
    scripted.push({ action: "getUnpaidPoReport", gate, status: 500, body: { status: "error", message: "Old failure." } });
    report(R1);
    reset(); w.adminRoute(); await wait(() => of("getUnpaidPoReport").length === 1); await pause(20);
    id("arToday").click(); await wait(() => !!rowEl("R-1")); await idle();
    release(); await pause(30); await idle();
    ok("a failure arriving after a newer answer is ignored: the newer rows stay, no error shown", !!rowEl("R-1") && !/Old failure/.test(text(app)) && !q("#arBody .cust-err")); }
  { let release; const gate = new Promise(r => { release = r; });
    scripted.push({ action: "getUnpaidPoReport", gate, status: 500, body: { status: "error", message: "Late failure." } });
    reset(); w.adminRoute(); await wait(() => of("getUnpaidPoReport").length === 1); await pause(20);
    w.location.hash = "#home"; await idle();
    release(); await pause(30); await idle();
    ok("…and one arriving after the page was left draws nothing", !/Late failure/.test(text(app)) && !arPage()); }

  // ==============================================================================================================
  console.log("\n=== Customers: no default days in the answer ===");
  // ==============================================================================================================
  await must({ action: "updateTermsSettings", terms: { defaultDays: 60, startsAt: "invoice" } });
  const sam = await must({ action: "saveCustomer", name: "Sam Example", email: "sam@example.com", allowNet30: true, termsDays: null });
  const custPage = () => id("custPage");
  { const real = await must({ action: "listCustomers" }); delete real.defaultDays;
    scripted = [{ action: "listCustomers", body: real }];
    const old = custPage(); reset(); w.location.hash = "#customers"; await wait(() => custPage() && custPage() !== old && !!q("#custPage tr.cust-row")); await idle();
    const row = q(`#custPage tr.cust-row[data-cust-id="${sam.id}"]`);
    ok("a list answer with no default days: a customer without days of their own shows “Net 30”, not the shop's 60", !!row && text(row.querySelector(".cust-tag-net30")) === "Net 30"); }
  { const real = await must({ action: "getCustomer", id: sam.id }); delete real.defaultDays;
    scripted = [{ action: "getCustomer", body: real }];
    const old = custPage(); reset(); w.location.hash = "#customers/" + sam.id; await wait(() => custPage() && custPage() !== old && !!q("#custForm")); await idle();
    ok("…and so does the customer's own page", qa(".cust-sub .cust-tag").map(text).includes("Net 30") && !qa(".cust-sub .cust-tag").map(text).includes("Net 60")); }
  await must({ action: "updateTermsSettings", terms: { defaultDays: 30, startsAt: "invoice" } });

  // ==============================================================================================================
  console.log("\n=== Quotes: lines with parts missing, and Convert where the shop doesn't take Net 30 ===");
  // ==============================================================================================================
  const est = await must({ action: "createEstimate", org: "club", customerId: 1, title: "Mugs" });
  const QID = est.id;
  await must({ action: "saveEstimate", id: QID, items: [{ kind: "product", productId: "mug", size: "OSFA", qty: 2 }, { kind: "product", productId: "mug", size: "OSFA", qty: 1 },
    { kind: "custom", name: "Setup", qty: 1, unitPrice: 4, taxable: true }] });
  const qtPage = () => id("qtPage");
  const openQ = async () => { const old = qtPage(); if (w.location.hash === "#quotes/" + QID) w.adminRoute(); else w.location.hash = "#quotes/" + QID; await wait(() => qtPage() && qtPage() !== old && (!!q("#qtForm") || !!qtPage().querySelector(".cust-err"))); await idle(); };
  { const real = await must({ action: "getEstimate", id: QID });
    const e = copy(real), items = e.items;
    delete items[1].size; delete items[1].qty;
    delete items[2].name; delete items[2].qty; delete items[2].unitPrice;
    scripted = [{ action: "getEstimate", body: e }];
    reset(); await openQ();
    const box = q('input[data-qt-qty="0"]');
    box.value = "5"; fire(box, "change");
    await wait(() => of("saveEstimate").length > 0); await idle();
    const saved = of("saveEstimate")[0];
    ok("a quote line from the server with no size or quantity is sent back as OSFA, quantity 1", !!saved && saved.items[1].kind === "product" && saved.items[1].size === "OSFA" && saved.items[1].qty === 1);
    ok("…a custom line with no name, quantity or price as an empty name, 1 and $0", !!saved && saved.items[2].kind === "custom" && saved.items[2].name === "" && saved.items[2].qty === 1 && saved.items[2].unitPrice === 0);
    ok("…and the changed line with its new quantity", !!saved && saved.items[0].qty === 5); }
  { const convOpen = async () => { await openQ(); q("#qtConvert").click(); await wait(() => !!modal() && !!modal().querySelector("#qtConvForm")); };
    const convClose = async () => { modal().querySelector("#qtConvCancel").click(); await wait(() => !modal()); };
    const keep = w._ordersNet30;
    w._ordersNet30 = { club: { allowed: false } };
    await convOpen();
    ok("Convert to order in a shop known not to take Net 30: no Net 30 tick", !modal().querySelector("#qtConvNet30") && !!modal().querySelector("#qtConvGo"));
    await convClose();
    w._ordersNet30 = { club: { allowed: true, defaultDays: 30 } };
    await convOpen();
    ok("…a shop that takes it: the tick", !!modal().querySelector("#qtConvNet30"));
    await convClose();
    w._ordersNet30 = {};
    await convOpen();
    ok("…a shop the page knows nothing of yet: the tick (the server decides)", !!modal().querySelector("#qtConvNet30"));
    await convClose();
    w._ordersNet30 = keep; }

  ok("nothing on the page threw along the way", pageErrors === 0);
  finished = true;
  w.close();
})().catch((e) => { console.error(e); ok("the test ran without an exception", false); finished = true; process.exit(1); });
