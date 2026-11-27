process.env.TZ = "UTC";
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Phase 6 in the admin page: the corners the other tests leave out (public/admin.js, public/admin-giftcards.js), run in
// jsdom with the real orders.js / db.js on sql.js behind fetch:
//   an order's invoice cell by role;
//   the Payments window: a payment with an unknown method, no reference and a fee; an order with no shipping discount
//   at all; the placeholder of a paid order; a card checked with no balance in the answer; errors with no words
//   (Check, Apply card, Back to card…, Add code); Back to card… with no amount;
//   a discount code's value field with no figure; orderWithAnswer_ with no answer, lsCombineCodes_ with a percent code without a percent, a rule answered as rules;
//   the Local sale window: Pay on delivery by role, no payment method (and Invoice), a gift card on an empty sale, a card
//   with no balance in the answer, a click beside the cards, errors with no words, a code checked with a customer
//   picked, a quiet re-check of an emptied code box, a repeated sale whose card was refused without a reason;
//   Reorder filling every kind of line (choices at each location with a thread color, size, the customer's own design,
//   personalization by pick-list and typed, a custom line with nothing on it, an item with no name), and the old
//   order's customer details when no record is picked;
//   Global settings answered flat; the Gift cards page: cards with odd figures, a row clicked while its list is being
//   read again, a click in a card's window that isn't a button, Resend for a card with no email, and the two forms'
//   errors shown even when the field can't take focus.
// Invented shops, people, codes and cards only (card numbers are made by the code under test).
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
globalThis.__mail399 = [];
globalThis.__f399 = {};
const emailSrc = strip(read("functions/_lib/email.js")).replace(/async function send_\(/, "async function send_unused_(") +
  "\nasync function send_(env, m) { globalThis.__mail399.push(m); return true; }\n";
const L = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role399] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role399" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {}, features: globalThis.__f399 });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const setMarketingChoice = async () => ({});\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/pdf.js")) + "\n" + emailSrc + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  strip(read("functions/_lib/boxSize.js")) + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, saveDiscountCode, issueGiftCard, createGraphic, saveLocation, setTierPrices };")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });

(async () => {
  globalThis.__role399 = "admin";
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
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);
    INSERT INTO customers (id, name, email, phone, createdAt, updatedAt) VALUES (1, 'Pat Example', 'pat@example.com', '555-0101', 't', 't');`);
  // Products: two plain ones, one with choices (a color, a design at each of two places, sizes), one that takes the
  // customer's own design as a choice, and two with personalization (one from a pick-list, one typed).
  const chest = await L.saveLocation(d1, { name: "Left chest", sortOrder: 1 });
  const back = await L.saveLocation(d1, { name: "Back", sortOrder: 2 });
  const crest = await L.createGraphic(d1, "club", { name: "Crest", kind: "transfer", tier: "small", inkColors: ["White", "Gold"], imageUrl: "img/crest.png", visible: true });
  await L.setTierPrices(d1, "club", { small: 3 });
  const CHEST = "loc" + chest, BACK = "loc" + back;
  await must({ action: "createProduct", org: "club", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  await must({ action: "createProduct", org: "club", productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 20 },
    visible: true, images: [], configurable: true, garmentColors: ["Navy", "Heather"], reorderQr: "none", noDesignNeeded: true,
    locations: [{ key: CHEST, label: "Left chest", locationId: chest, graphicIds: [crest] }, { key: BACK, label: "Back", locationId: back, graphicIds: [crest] }],
    customDesign: "transfer", customDesignPrice: 6 });
  await must({ action: "createProduct", org: "club", productId: "logo-cap", type: "cap", name: "Your Logo Cap", pricingMode: "flat", flatPrice: 18, visible: true, images: [],
    noDesignNeeded: true, customDesign: "transfer", customDesignPrice: 5 });
  await must({ action: "createProduct", org: "club", productId: "name-cap", type: "cap", name: "Name Cap", pricingMode: "flat", flatPrice: 15, visible: true, images: [],
    noDesignNeeded: true, personalizationPrice: 4, personalizationOptions: ["Coach", "Captain"] });
  await must({ action: "createProduct", org: "club", productId: "name-mug", type: "other", name: "Name Mug", pricingMode: "flat", flatPrice: 12, visible: true, images: [],
    noDesignNeeded: true, personalizationPrice: 3 });
  const code = await L.saveDiscountCode(d1, { code: "SAVE10", kind: "percent", percent: 10, maxUses: 1000 }, { actor: "t" });
  ok("(the code SAVE10 is made)", !!code && !!code.code);
  const card = async (dollars, extra) => { const r = await L.issueGiftCard(d1, { amountCents: Math.round(dollars * 100), by: "t", ...(extra || {}) }); if (!r || !r.code) throw new Error("card " + JSON.stringify(r)); return r; };
  const g50 = await card(50, { recipientName: "Sam Example", recipientEmail: "sam@example.com" }), g20 = await card(20), gBare = await card(15);
  let seq = 0;
  const sale = async (items, extra) => (await must({ action: "createLocalSale", org: "club", requestId: "seed399-" + (++seq) + "-abcdef", customerName: "Walk-in", paymentMethod: "Cash", items, ...(extra || {}) })).orderId;

  // ---- The page ---------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), custJs = read("public/admin-customers.js"), giftJs = read("public/admin-giftcards.js");
  const sent = [], toasts = [];
  let scripted = [];       // [{ action, status, body | throws | empty }]: the next request for that action is answered with this
  let hold = null;         // { action, gate }: the next request for that action waits for gate
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      if (/\/admin-giftcards\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(giftJs));
      if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs));
      if (/\/admin-customers\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(custJs));
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
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(JSON.parse(JSON.stringify(b))); inflight++;
        try {
          const i = scripted.findIndex(s => s.action === b.action);
          if (i >= 0) { const s = scripted.splice(i, 1)[0]; if (s.empty) throw new Error(""); if (s.throws) throw new Error(s.throws); return reply(s.status || 200, s.body); }
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
  w.eval("adminOrgs = " + JSON.stringify([{ orgId: "club", name: "Example Club" }]) + ";");
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const id = (s) => d.getElementById(s);
  const app = id("app");
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const of = (action) => sent.filter(b => b.action === action).map(b => { const c = Object.assign({}, b); delete c.key; return c; });
  const reset = () => { sent.length = 0; toasts.length = 0; };
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const typeIn = (el, v) => { el.value = v; fire(el, "input"); };
  const choose = (el, v) => { el.value = v; fire(el, "change"); };
  const asRoles = (pageRole) => { globalThis.__role399 = pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  const signInWith = (perms) => { globalThis.__role399 = "admin"; w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(perms)}; adminAreas = ${JSON.stringify(roles.PERMISSION_AREAS)};`); };
  const withLevels = (role, changes) => Object.assign({}, roles.effectivePermissions(roles.DEFAULT_ROLES[role]), changes);
  const confirmBox = () => q(".confirm-modal");
  const answer = async (yes, value) => {
    await wait(() => !!confirmBox()); const box = confirmBox();
    const info = { message: box.dataset.message || text(box) };
    if (value != null) { const inp = box.querySelector("#cmInput"); inp.value = value; fire(inp, "input"); }
    box.querySelector(yes ? "#cmOk" : "#cmCancel").click(); await pause(30);
    return info;
  };
  // The page's focus() made to fail for a moment (a field that can't take focus): what the form says must not depend on it.
  const focusFails = (fn) => { const proto = w.HTMLElement.prototype, was = proto.focus; let tried = 0; proto.focus = function () { tried++; throw new Error("can't focus"); }; try { fn(); } finally { proto.focus = was; } return tried; };
  asRoles("admin");
  w.applyFeatures_({});
  w.renderAdminNav();
  w.refreshOrderRows_ = () => {};

  // ==============================================================================================================
  console.log("=== An order's actions ===");
  const oA = await sale([{ productId: "mug", size: "", qty: 1 }], { customerId: 1 });
  const oPaid = await sale([{ productId: "mug", size: "", qty: 1 }]);
  await must({ action: "redeemGiftCard", orderId: oPaid, code: g50.code, requestId: "rq399-paid-1" });
  w.location.hash = "#orders/club";
  await wait(() => !!q(`#app tr[data-order="${oPaid}"]`), 1500); await idle();
  ok("the Orders page lists the seeded orders", !!q(`#app tr[data-order="${oA}"]`));
  const cellOf = (o) => { const h = d.createElement("div"); h.innerHTML = w.adminActionCell({ orgId: "club", name: "Example Club" }, o); return h; };
  const base = w._ordersCache.club.find(o => o.orderId === oA), paidBase = w._ordersCache.club.find(o => o.orderId === oPaid);
  ok("a paid order's actions, for a role that may read invoices: the invoice cell (its receipt PDF button)", paidBase.paid === true && !!cellOf(paidBase).querySelector('[data-admin-action="downloadOrderPdf_"]'));
  signInWith(withLevels("admin", { "orders.invoices": "none" }));
  ok("…for a role with no access to invoices: none, and Payments still there", !cellOf(paidBase).querySelector('[data-admin-action="downloadOrderPdf_"]') && !!cellOf(paidBase).querySelector('[data-admin-action="showPaymentsModal"]'));
  asRoles("admin");

  // ==============================================================================================================
  console.log("\n=== The Payments window ===");
  const openPay = async (oid) => { const p = w.showPaymentsModal("club", oid); await wait(() => !!q("#pmContent")); return { p }; };
  const closePay = async (box) => { const b = q("#pmCloseBottom"); if (b) b.click(); await box.p; await idle(); };
  const $ = (s) => q("#pmContent " + s) || q(s);
  w._ordersCache.club.push(Object.assign({}, base, { orderId: "FAKE-1", shippingCost: 0, shippingDiscount: undefined, shippingDiscountCents: undefined, discountCodes: undefined, discountCode: "",
    payments: [{ id: 91, amount: 5, method: "barter", reference: null, fee: 1.5, kind: "payment", receivedAt: "2026-11-01T00:00:00Z" }] }));
  let pm = await openPay("FAKE-1");
  const fakeRow = () => qa("#pmContent tbody tr").find(tr => /\$5\.00/.test(text(tr)));
  ok("a payment with a method the page doesn't know, no reference and a fee: “Other (fee $1.50)”", !!fakeRow() && /Other \(fee \$1\.50\)/.test(text(fakeRow())) && !/ · /.test(text(fakeRow())));
  ok("…it isn't taken for a gift card (no Back to card…)", !!fakeRow() && !fakeRow().querySelector('[data-admin-action="pmRefundToGiftCard"]'));
  ok("an order with no shipping discount in any shape: no Free shipping line", !qa("#pmContent tr").some(tr => /Free shipping/.test(text(tr))));
  choose($("#pmMethod"), "__giftcard__");
  typeIn($("#pmGiftCode"), g20.code);
  scripted = [{ action: "checkGiftCard", body: { status: "ok", ok: true, last4: "WXYZ" } }];
  $("#pmGiftCheck").click(); await idle();
  ok("Check answered with a card but no balance: “Gift card ••WXYZ has $0.00.”", text($("#pmGiftInfo")) === "Gift card ••WXYZ has $0.00.");
  scripted = [{ action: "checkGiftCard", empty: true }];
  $("#pmGiftCheck").click(); await idle();
  ok("Check failing with no words: “Couldn't check the gift card.”", text($("#pmGiftInfo")) === "Couldn't check the gift card.");
  scripted = [{ action: "redeemGiftCard", empty: true }];
  $("#pmSavePayment").click(); await idle();
  ok("Apply card failing with no words: “Couldn't take the gift card.” in the window", text($("#pmError")) === "Couldn't take the gift card.");
  reset();
  const asked0 = w.pmRefundToGiftCard("91", "");
  let a = await answer(false); await asked0;
  ok("Back to card… with no amount on the button asks “Up to $0.00”, and Cancel sends nothing", /Up to \$0\.00, the amount of this payment\./.test(a.message) && of("refundToGiftCard").length === 0);
  scripted = [{ action: "refundToGiftCard", empty: true }];
  const asked1 = w.pmRefundToGiftCard("91", "5");
  await answer(true, "1"); await asked1; await idle();
  ok("a refund to the card failing with no words: “Not refunded: unknown error” (an error)", lastToast().m === "Not refunded: unknown error" && lastToast().err);
  typeIn($("#pmCodeInput"), "SAVE10");
  scripted = [{ action: "applyOrderDiscountCode", empty: true }];
  $("#pmCodeApply").click(); await idle();
  ok("Add code failing with no words: “The code wasn't changed.”", text($("#pmError")) === "The code wasn't changed.");
  await closePay(pm);
  pm = await openPay(oPaid);
  choose($("#pmMethod"), "__giftcard__"); choose($("#pmMethod"), "cash");
  ok("a paid order (the gift card paid it all): back from Gift card, the amount's placeholder is 0.00", $("#pmAmount").placeholder === "0.00" && Number(w._ordersCache.club.find(o => o.orderId === oPaid).balanceDue) === 0);
  await closePay(pm);

  // ==============================================================================================================
  console.log("\n=== Helpers: an answer with nothing, a percent with no percent, a rule answered as rules ===");
  { const o = { orderId: "X-1", amountReceived: 3, payments: [] }, r = w.orderWithAnswer_(o, null);
    ok("orderWithAnswer_ with no answer keeps the order as it was (a copy)", r !== o && same(r, o)); }
  ok("a percent code with no percent takes nothing off", same(w.lsCombineCodes_([{ kind: "percent" }], 1000, 0).perCode, [{ goodsOffCents: 0, shippingOffCents: 0 }]));
  w.eval("_lsRulesPromise = null");
  scripted = [{ action: "getDiscountRules", body: { status: "ok", rules: { multiple: true } } }];
  ok("a rule answered under “rules” is read (several codes)", same(await w.lsDiscountRules_(), { multiple: true }));
  w.eval("_lsRulesPromise = null");
  { const valOf = (c) => { const h = d.createElement("div"); h.innerHTML = w.dcValueHtml_(c, false); return h.querySelector("#dcValue").value; };
    ok("a code's value field: an amount code with no amount, and a percent code with no percent, start empty", valOf({ kind: "amount" }) === "" && valOf({ kind: "percent" }) === "" && valOf({ kind: "amount", amount: 5 }) === "5.00" && valOf({ kind: "percent", percent: 15 }) === "15"); }

  // ==============================================================================================================
  console.log("\n=== The Local sale window ===");
  const form = () => q("#localSaleForm");
  const preview = () => text(form().querySelector("#lsPricePreview"));
  const open = async (opts) => { reset(); const done = w.createLocalSale("club", opts); await wait(() => !!form()); await idle(); return { p: done }; };
  const pickMugs = (n) => { choose(form().querySelector("#lsProduct"), "mug"); typeIn(form().querySelector("#lsQty"), String(n)); };
  const closeSale = async (box) => { const c = [...form().querySelectorAll("button")].find(b => /^Cancel$/.test(text(b))); c.click(); await pause(20); if (confirmBox()) confirmBox().querySelector("#cmOk").click(); await (box && box.p); await idle(); };
  const submit = async () => { form().querySelector(".admin-pass-submit").click(); await idle(); };
  const lsErr = () => text(form().querySelector("#lsErr"));
  const gMsg = () => text(form().querySelector("#lsGiftMsg"));
  const gList = () => qa("#lsGiftList .ls-gift-chip").map(e => text(e.querySelector("span")));
  const giftApply = async (typed) => { typeIn(form().querySelector("#lsGift"), typed); form().querySelector("#lsGiftApply").click(); await idle(); };

  w._ordersPod = { club: { allowed: true, localSaleOnly: false } };
  let done = await open();
  ok("a shop that allows Pay on delivery: an admin's window offers it", !!form().querySelector("#lsPod"));
  await submit();
  ok("Record sale with no payment method, no invoice and no gift card: “Please select a payment method.”", lsErr() === "Please select a payment method." && of("createLocalSale").length === 0);
  form().querySelector("#lsInvoice").checked = true;
  await submit();
  ok("…with “Email the customer an invoice” ticked, no method is needed (it asks for the email instead)", lsErr() === "Enter the customer's email (under Customer info) to send them an invoice." && of("createLocalSale").length === 0);
  form().querySelector("#lsInvoice").checked = false;
  await giftApply(g20.code);
  ok("a gift card on a sale with nothing in it yet: its balance, no “pays about”", same(gList(), [`Gift card ••${g20.last4} — balance $20.00`]));
  form().querySelector("#lsGiftList span").click(); await idle();
  ok("a click on the card's text (not its ×) takes nothing off", gList().length === 1 && gMsg() === `✓ Gift card ••${g20.last4} has $20.00.`);
  scripted = [{ action: "checkGiftCard", body: { status: "ok", ok: true, last4: "QRST" } }];
  await giftApply("QRST-QRST-QRST-QRST");
  ok("a card answered with no balance: “✓ Gift card ••QRST has $0.00.” and listed at $0.00", gMsg() === "✓ Gift card ••QRST has $0.00." && gList()[1] === "Gift card ••QRST — balance $0.00");
  scripted = [{ action: "checkGiftCard", empty: true }];
  await giftApply(gBare.code);
  ok("a check failing with no words: “Couldn't check the gift card.”, nothing added", gMsg() === "Couldn't check the gift card." && gList().length === 2);
  pickMugs(1);
  typeIn(form().querySelector("#lsCode"), "SAVE10");
  scripted = [{ action: "checkLocalSaleCode", empty: true }];
  form().querySelector("#lsCodeApply").click(); await idle();
  ok("a code check failing with no words: “Couldn't check the code.”", text(form().querySelector("#lsCodeMsg")) === "Couldn't check the code.");
  await closeSale(done);
  signInWith(withLevels("admin", { "orders.payOnDelivery": "none" }));
  done = await open();
  ok("…a role that can't set Pay on delivery isn't offered it there", !form().querySelector("#lsPod"));
  await closeSale(done);
  asRoles("admin");
  w._ordersPod = {};

  done = await open({ customer: { id: 1, name: "Pat Example", email: "pat@example.com" } });
  pickMugs(2);
  typeIn(form().querySelector("#lsCode"), "save10"); form().querySelector("#lsCodeApply").click(); await idle();
  ok("a code checked with a customer picked is checked for that customer (customerId 1)", of("checkLocalSaleCode").length === 1 && of("checkLocalSaleCode")[0].customerId === 1 && /code SAVE10$/.test(preview()));
  form().querySelector("#lsCode").value = "";   // emptied without an input event
  reset();
  fire(form().querySelector("#lsEmail"), "change"); await idle();
  ok("the applied code's box found empty when the email changes: the code is dropped quietly (no “Enter a code first.”)",
    text(form().querySelector("#lsCodeMsg")) === "" && !/code SAVE10/.test(preview()) && of("checkLocalSaleCode").length === 0);
  choose(form().querySelector("#lsPayment"), "Cash");
  scripted = [{ action: "createLocalSale", body: { status: "ok", repeated: true, giftCards: [{ ok: false }] } }];
  reset();
  form().querySelector(".admin-pass-submit").click(); await done.p; await idle();
  ok("an answer that the sale was already recorded, with no order number and a card refused without a reason: “Local sale already recorded —  — A gift card wasn't taken.” (an error)",
    lastToast().m === "Local sale already recorded —  — A gift card wasn't taken." && lastToast().err && !form());

  console.log("\n=== Reorder ===");
  const lines = () => qa("#localSaleForm .ls-line");
  const fld = (line, nm) => line.querySelector(`[data-f="${nm}"]`);
  done = await open({ reorder: { orderId: oA } });
  ok("a reorder given as an object asks for that order (getOrderForReorder " + "with its orderId)", same(of("getOrderForReorder").map(b => b.orderId), [oA]) && lines().length === 1 && fld(lines()[0], "product").value === "mug");
  await closeSale(done);
  scripted = [{ action: "getOrderForReorder", empty: true }];
  reset();
  await w.createLocalSale("club", { reorder: oA }); await idle();
  ok("the order can't be read, with no words: “Couldn't load that order to reorder it: unknown error”, no window", lastToast().m === "Couldn't load that order to reorder it: unknown error" && lastToast().err && !form());
  scripted = [{ action: "getOrderForReorder", body: { status: "ok", reorder: { orgId: "club", customerId: 1, lines: [
    { productId: "tee", name: "Club Tee", qty: 2, size: "M", priceThen: 20, config: { garmentColor: "Heather", locations: [{ location: CHEST, graphicId: crest, ink: "Gold" }, { location: BACK, custom: true }, { location: "loc-gone", graphicId: crest }] } },
    { productId: "logo-cap", name: "", qty: "x", customDesign: true, priceThen: 1 },
    { productId: "name-cap", name: "Name Cap", qty: 1, personalized: true, persName: "Captain" },
    { productId: "name-mug", name: "Name Mug", qty: 1, personalized: true, persName: "Pat" },
    { productId: "tee", name: "Club Tee", qty: 1, size: "S", config: { garmentColor: "Navy" } },
    { productId: "name-mug", name: "Name Mug", qty: 1, personalized: true },
    { productId: "__custom__", qty: 1 },
    { qty: 1 }] } } }];
  done = await open({ reorder: { orderId: "" } });
  ok("every line the shop still sells is filled in (seven), the one with no product left out", lines().length === 7);
  { const [tee, cap, nameCap, nameMug, tee2, nameMug2, custom] = lines();
    const loc = (line, key, f) => [...line.querySelectorAll(`select[data-f="${f}"]`)].find(s => s.dataset.loc === key);
    ok("the product with choices: its color, the design at the chest with its thread color, the customer's own design at the back, and the size",
      fld(tee, "product").value === "tee" && fld(tee, "qty").value === "2" && fld(tee, "color").value === "Heather" && loc(tee, CHEST, "loc").value === String(crest) &&
      loc(tee, CHEST, "ink").value === "Gold" && loc(tee, BACK, "loc").value === "custom" && fld(tee, "size").value === "M");
    ok("…a place this product no longer has is skipped", !loc(tee, "loc-gone", "loc"));
    ok("a quantity that isn't a number is 1; the customer's own design is ticked again", fld(cap, "product").value === "logo-cap" && fld(cap, "qty").value === "1" && fld(cap, "customDesign").checked === true);
    ok("personalization from a pick-list: ticked, the option chosen (Captain)", fld(nameCap, "pers").checked && fld(nameCap, "persOption").value === "Captain");
    ok("typed personalization: ticked, the name typed in (Pat)", fld(nameMug, "pers").checked && fld(nameMug, "persName").value === "Pat");
    ok("…and with no name kept: ticked, the name left empty", fld(nameMug2, "pers").checked && fld(nameMug2, "persName").value === "");
    ok("choices with only a color (no places): the color is picked, size S", fld(tee2, "color").value === "Navy" && fld(tee2, "size").value === "S");
    ok("a custom line with no name or price: an empty description at $0.00", fld(custom, "product").value === "__custom__" && fld(custom, "customDesc").value === "" && fld(custom, "customUnitPrice").value === "0.00"); }
  { const nt = text(form().querySelector("#lsReorderNote"));
    ok("the note: “Reordered from an earlier order.” when the server doesn't say which", nt.startsWith("Reordered from an earlier order. Prices are today's;"));
    ok("…a changed price named by the product when the line has no name (Your Logo Cap was $1.00)", /Your Logo Cap \(was \$1\.00, now \$\d+\.\d\d\)/.test(nt));
    ok("…and the item with no name or product left out as “An item”", /Left out because the shop doesn't sell it now: An item\./.test(nt)); }
  ok("the old order's customer record is picked by its id alone", /^Picked: /.test(text(form().querySelector("#lsCustomerPickedText"))) && form().querySelector("#lsCustomerPicked").style.display === "flex");
  await closeSale(done);
  scripted = [{ action: "getOrderForReorder", body: { status: "ok", lines: [{ productId: "mug", qty: 1 }], customer: { email: "lee@example.com", phone: "555-0199" } } }];
  done = await open({ reorder: oA });
  ok("no record but an email and phone: both typed in and Customer info opened", form().querySelector("#lsEmail").value === "lee@example.com" && form().querySelector("#lsPhone").value === "555-0199" &&
    form().querySelector("#lsName").value === "" && form().querySelector("#lsCustomerInfo").open);
  await closeSale(done);
  scripted = [{ action: "getOrderForReorder", body: { status: "ok", lines: [{ productId: "mug", qty: 1 }], customer: { phone: "555-0123" } } }];
  done = await open({ reorder: oA });
  ok("only a phone: it is typed in and Customer info opened", form().querySelector("#lsPhone").value === "555-0123" && form().querySelector("#lsEmail").value === "" && form().querySelector("#lsCustomerInfo").open);
  await closeSale(done);

  // ==============================================================================================================
  console.log("\n=== Global settings answered flat ===");
  scripted = [{ action: "getDiscountRules", body: { status: "ok", multiple: true } },
    { action: "getGiftCardSettings", body: { status: "ok", sellOnline: true, amounts: [0, 2500], minCents: 500, maxCents: 50000 } }];
  reset(); await w.renderGlobalSettings(app); await wait(() => !!id("gPayCard")); await idle();
  ok("a rule answered at the top level is drawn (several codes on)", !!id("gDiscMultiple") && id("gDiscMultiple").checked);
  ok("gift card settings answered at the top level are drawn, a $0 amount shown as 0", !!id("gGiftSell") && id("gGiftSell").checked && id("gGiftAmounts").value === "0, 25");

  // ==============================================================================================================
  console.log("\n=== The Gift cards page ===");
  const page = () => id("gcPage");
  const listDrawn = () => !!(page() && !/Loading…/.test(id("gcBody").textContent));
  const go = async () => { const old = page(); w.location.hash = "#home"; await idle(); w.location.hash = "#giftcards"; await wait(() => page() && page() !== old && listDrawn()); await idle(); };
  const rows = () => qa("#gcBody table.gc-table tbody tr");
  const cellsOf = (tr) => [...tr.children].map(td => text(td));
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const cardWin = () => { const m = modal(); return m && m.querySelector("#gcCardBody") ? m : null; };
  scripted = [{ action: "listGiftCards", body: { status: "ok", total: 2, cards: [
    { id: 950, last4: "ON12", balance: 5, initial: 5, sourceOrderId: "CLUB-GC-9", status: "active", createdAt: "" },
    { id: 951, last4: "NC00", balanceCents: "x", initialCents: 500, status: "active", createdAt: "" }] } }];
  await go();
  ok("a card bought online with no buyer named: From is just the “Online” tag", same(cellsOf(rows()[0]).slice(0, 5), ["••ON12", "$5.00", "$5.00", "", "Online"]));
  ok("a balance in cents that isn't a number: $0.00, “Used up”", same(cellsOf(rows()[1]), ["••NC00", "$0.00", "$5.00", "", "The shop", "", "Used up"]));
  { let release;
    scripted = [{ action: "listGiftCards", body: { status: "ok", total: 60, cards: [{ id: 952, last4: "PG01", balance: 1, initial: 1, status: "active" }] } }];
    await go();
    scripted = [{ action: "listGiftCards", body: { status: "ok", total: 60, cards: [] } }];
    hold = { action: "listGiftCards", gate: new Promise(r => { release = r; }) };
    reset();
    q('#gcPager button[data-gc-page="next"]').click();
    await wait(() => of("listGiftCards").length === 2);
    rows()[0].children[1].click(); await pause(30);
    ok("a row clicked while its page is being read again (the page asked for was empty) opens nothing", !cardWin() && of("getGiftCard").length === 0 && same(of("listGiftCards").map(b => b.offset), [50, 0]));
    release(); await wait(() => rows().length === 3); await idle(); }
  ok("…and the first page is drawn when it comes (the real cards)", rows().length === 3);
  const rowOf = (last4) => rows().find(tr => text(tr.children[0]) === "••" + last4);
  scripted = [{ action: "getGiftCard", body: { status: "ok", card: { id: 80, last4: "LG01", balance: 1, initial: 1, status: "active" }, ledger: [{ delta: "x", at: "" }, { kind: "adjust", deltaCents: "x", at: "" }] } }];
  rowOf(g50.last4).children[1].click(); await wait(() => !!cardWin()); await idle();
  ok("history rows with no kind, or an amount (or amount in cents) that isn't one: an empty What and +$0.00",
    same([...cardWin().querySelectorAll("table.gc-ledger tbody tr")].map(cellsOf), [["", "", "+$0.00", "", "", ""], ["", "Adjusted", "+$0.00", "", "", ""]]));
  reset();
  cardWin().querySelector(".gc-bal").click(); await pause(30);
  ok("a click in the window that isn't on a button does nothing", !!cardWin() && sent.length === 0 && !confirmBox());
  cardWin().querySelector('button[data-gc-do="close"]').click(); await wait(() => !cardWin());
  rowOf(gBare.last4).children[1].click(); await wait(() => !!cardWin()); await idle();
  cardWin().querySelector('button[data-gc-do="resend"]').click(); await wait(() => !!confirmBox());
  ok("Resend… for a card with no email starts with an empty address", confirmBox().querySelector("#cmInput").value === "");
  confirmBox().querySelector("#cmCancel").click(); await wait(() => !confirmBox());
  cardWin().querySelector('button[data-gc-do="adjust"]').click();
  const adjWin = () => { const m = modal(); return m && m.querySelector("#gcAdjForm") ? m : null; };
  await wait(() => !!adjWin());
  reset();
  const triedAdj = focusFails(() => fire(adjWin().querySelector("#gcAdjForm"), "submit"));
  ok("Adjust with nothing typed, the field unable to take focus: the error is still said, nothing sent", triedAdj > 0 && text(adjWin().querySelector("#gcAdjErr")) === "Enter how much to add or take off, like 10 or -10." && sent.length === 0);
  adjWin().querySelector("#gcAdjCancel").click(); await wait(() => !adjWin());
  cardWin().querySelector('button[data-gc-do="close"]').click(); await wait(() => !cardWin());
  id("gcNew").click();
  const issueWin = () => { const m = modal(); return m && m.querySelector("#gcIssueForm") ? m : null; };
  await wait(() => !!issueWin());
  reset();
  const triedIssue = focusFails(() => fire(issueWin().querySelector("#gcIssueForm"), "submit"));
  ok("Issue card with no amount, the field unable to take focus: “Enter an amount from $1 to $1,000,000.” still said, nothing sent", triedIssue > 0 && text(issueWin().querySelector("#gcIssueErr")) === "Enter an amount from $1 to $1,000,000." && sent.length === 0);
  issueWin().querySelector("#gcIssueCancel").click(); await pause(30); if (confirmBox()) confirmBox().querySelector("#cmOk").click();
  await wait(() => !issueWin());

  finished = true;
  w.close();
})().catch((e) => { console.error(e); ok("the test ran without an exception", false); finished = true; process.exit(1); });
