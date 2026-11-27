process.env.TZ = "UTC";
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Phase 6 in the admin page (public/admin.js, public/admin-customers.js) and in the customer's emails (functions/_lib/email.js),
// run in jsdom with the real orders.js / db.js / email.js on sql.js behind fetch:
//   the order's Payments window: the Gift card way to pay (the number, Check and its balance, Apply card taking up to the
//   balance due, the refusals said in the window), a gift-card payment in the history (no account, "Back to card…", the
//   Void that puts it back), and the Discount codes area (Add code, the codes with ×, the manual discount locked while a
//   code is on, Free shipping (CODE) in the totals);
//   the Local sale window: several codes when Global settings allows them (Add another code, ×, up to five, the server's
//   refusal in one-code mode), what the codes take off (lsCombineCodes_), and its Gift card box;
//   Reorder from the order window and from the customer page: the Local sale filled from the old order at today's prices,
//   the "N changed" note naming them, what the shop no longer sells, reorderOf sent with the sale;
//   data-need on every new control, and roles without the permission;
//   email.js: one line per code, "Free shipping (CODE)", "Paid by gift card ••XXXX", a gift card order's receipt and the
//   morning roll-up's "Gift cards sold".
// Invented shops, people, codes and cards only (card numbers are made by the code under test).
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const mail = [];
globalThis.__mail395 = mail;
globalThis.__f395 = {};
const emailSrc = strip(read("functions/_lib/email.js")).replace(/async function send_\(/, "async function send_unused_(") +
  "\nasync function send_(env, m) { globalThis.__mail395.push(m); return true; }\n";
const L = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role395] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role395" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {}, features: globalThis.__f395 });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const setMarketingChoice = async () => ({});\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/pdf.js")) + "\n" + emailSrc + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  strip(read("functions/_lib/boxSize.js")) + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, saveDiscountCode, issueGiftCard, getOrderById, receiptLines_, buildOrderReceivedEmail, buildPaymentReceivedEmail, sendDailyDigestEmail };")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });

(async () => {
  globalThis.__role395 = "admin";
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const waits = [];
    const res = await L.post({ env: { DB: d1 }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const must = async (body) => { const r = await call(body); if (r.status !== 200) throw new Error("seed " + body.action + ": " + JSON.stringify(r.body)); return r.body; };
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);
    INSERT INTO customers (id, name, email, phone, createdAt, updatedAt) VALUES (1, 'Pat Example', 'pat@example.com', '555-0101', 't', 't'), (2, 'Lee Sample', 'lee@example.com', '', 't', 't');`);
  await must({ action: "createProduct", org: "club", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  await must({ action: "createProduct", org: "club", productId: "cap", type: "other", name: "Club Cap", pricingMode: "flat", flatPrice: 15, visible: true, weightOz: 6, noDesignNeeded: true });
  const code = async (input) => { const r = await L.saveDiscountCode(d1, { maxUses: 1000, ...input }, { actor: "t" }); if (!r || !r.code) throw new Error("code " + JSON.stringify(r)); return r.code; };
  await code({ code: "SAVE10", kind: "percent", percent: 10 });
  await code({ code: "TEAM5", kind: "amount", amount: 5 });
  await code({ code: "SHIPFREE", kind: "shipping" });
  await code({ code: "BIG50", kind: "amount", amount: 5, minOrder: 50 });
  await code({ code: "ONE3", kind: "amount", amount: 1 });
  await code({ code: "ONE4", kind: "amount", amount: 1 });
  await code({ code: "ONE5", kind: "amount", amount: 1 });
  const card = async (dollars, extra) => { const r = await L.issueGiftCard(d1, { amountCents: Math.round(dollars * 100), recipientName: "Sam Example", by: "t", ...(extra || {}) }); if (!r || !r.code) throw new Error("card " + JSON.stringify(r)); return r; };
  const cardBal = (c) => q1("SELECT balanceCents FROM gift_cards WHERE id = ?", c.id).balanceCents;
  const g30 = await card(30), g5 = await card(5), gVoid = await card(20), gEmpty = await card(1), gLate = await card(10), g7 = await card(7), g8 = await card(8), g9 = await card(9);
  d1._raw.exec(`UPDATE gift_cards SET status = 'void', balanceCents = 0 WHERE id = ${gVoid.id}; UPDATE gift_cards SET balanceCents = 0 WHERE id = ${gEmpty.id};`);
  const rule = async (multiple) => must({ action: "updateDiscountRules", multiple });
  const ADDR = { name: "Pat Example", line1: "1 Example St", city: "Springfield", state: "IL", zip: "62701" };
  let seq = 0;
  const sale = async (items, extra) => (await must({ action: "createLocalSale", org: "club", requestId: "seed395-" + (++seq) + "-abcdef", customerName: "Walk-in", paymentMethod: "Cash", items, ...(extra || {}) })).orderId;

  // ---- The page ---------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), custJs = read("public/admin-customers.js");
  const sent = [], toasts = [];
  let scripted = [];       // [{ action, status, body | throws }]: the next request for that action is answered with this
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
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
          if (i >= 0) { const s = scripted.splice(i, 1)[0]; if (s.throws) throw new Error(s.throws); return reply(s.status || 200, s.body); }
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
  const app = d.getElementById("app");
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const of = (action) => sent.filter(b => b.action === action).map(b => { const c = Object.assign({}, b); delete c.key; return c; });
  const reset = () => { sent.length = 0; toasts.length = 0; };
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const typeIn = (el, v) => { el.value = v; fire(el, "input"); };
  const choose = (el, v) => { el.value = v; fire(el, "change"); };
  const enter = (el) => el.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const asRoles = (pageRole, serverRole) => { globalThis.__role395 = serverRole || pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  const features = (f) => { globalThis.__f395 = Object.assign({}, f); w.applyFeatures_(Object.assign({}, f)); };
  const confirmBox = () => q(".confirm-modal");
  const answer = async (yes, value) => {
    await wait(() => !!confirmBox()); const box = confirmBox();
    const info = { message: box.dataset.message || text(box), okLabel: text(box.querySelector("#cmOk")) };
    if (value != null) { const inp = box.querySelector("#cmInput"); inp.value = value; fire(inp, "input"); }
    box.querySelector(yes ? "#cmOk" : "#cmCancel").click(); await pause(30);
    info.stillOpen = !!confirmBox() && confirmBox() === box; info.err = box.querySelector("#cmInputErr") ? text(box.querySelector("#cmInputErr")) : "";
    return info;
  };
  const off = (el) => !!el && el.hasAttribute("data-perm-off");
  asRoles("admin");
  features({});
  w.renderAdminNav();

  // ==============================================================================================================
  console.log("=== Seeded: two products, codes, gift cards, orders ===");
  const oPay = await sale([{ productId: "mug", size: "", qty: 4 }], { customerId: 1 });                   // $40, nothing paid
  const oCodes = await sale([{ productId: "mug", size: "", qty: 4 }], { customerId: 1 });                 // $40
  const oShip = await sale([{ productId: "mug", size: "", qty: 2 }], { customerName: "Kim Example", shippingAddress: ADDR, shippingCost: 8 });
  const oManual = await sale([{ productId: "cap", size: "", qty: 2 }]);
  await must({ action: "setDiscount", orderId: oManual, amount: 3, note: "Loyal customer" });
  ok("the orders to work on are recorded", [oPay, oCodes, oShip, oManual].every(Boolean));
  w.location.hash = "#orders/club";
  await wait(() => !!q(`#app tr[data-order="${oManual}"]`), 1500); await idle();
  ok("the Orders page lists them", !!q(`#app tr[data-order="${oPay}"]`));
  // (The window's promise is kept in a box: an async function returning it would wait for the window to close.)
  const openPay = async (oid) => { const p = w.showPaymentsModal("club", oid); await wait(() => !!q("#pmContent")); return { p }; };
  const closePay = async (box) => { const b = q("#pmCloseBottom"); if (b) b.click(); await box.p; await idle(); };
  const $ = (s) => q("#pmContent " + s) || q(s);

  // ==============================================================================================================
  console.log("\n=== The Payments window: Gift card as a way to pay ===");
  let pm = await openPay(oPay);
  const method = $("#pmMethod");
  const opts = [...method.options].map(o => o.value + "=" + o.textContent.trim());
  ok("“Paid by” ends with a Gift card choice (value __giftcard__)", opts[opts.length - 1] === "__giftcard__=Gift card");
  ok("its number field, Check and the balance line are hidden until it is chosen", qa(".pm-gift").length === 2 && qa(".pm-gift").every(e => e.hidden) && qa(".pm-std").every(e => !e.hidden));
  ok("Check sits inside Record payment, which needs orders.payments edit", !!$("#pmGiftCheck") && $("#pmGiftCheck").closest('[data-need="orders.payments:edit"]') !== null);
  const acctBefore = $("#pmAccount").value;
  choose(method, "__giftcard__");
  ok("choosing it shows the number, Check and the note “The gift card pays up to what is owed…”", qa(".pm-gift").every(e => !e.hidden) && /The gift card pays up to what is owed on this order/.test(text(qa(".pm-gift")[1])));
  ok("…and hides the date, the account, the reference and the note", qa(".pm-std").length === 4 && qa(".pm-std").every(e => e.hidden));
  ok("…Save reads “Apply card” and the amount says “Up to the balance”", text($("#pmSavePayment")) === "Apply card" && $("#pmAmount").placeholder === "Up to the balance");
  ok("…and the account picker isn't moved by it", $("#pmAccount").value === acctBefore);
  reset();
  $("#pmGiftCheck").click(); await idle();
  ok("Check with nothing typed: “Enter the gift card number.”, nothing asked", text($("#pmGiftInfo")) === "Enter the gift card number." && sent.length === 0);
  typeIn($("#pmGiftCode"), "ABCD-EFGH-JKLM-NPQR");
  $("#pmGiftCheck").click(); await idle();
  ok("a number that isn't a card: the server's “That gift card number isn't right.”", text($("#pmGiftInfo")) === "That gift card number isn't right." && of("checkGiftCard").length === 1 && of("checkGiftCard")[0].code === "ABCD-EFGH-JKLM-NPQR");
  typeIn($("#pmGiftCode"), gVoid.code); $("#pmGiftCheck").click(); await idle();
  ok("a voided card reads the same, never saying it was voided", text($("#pmGiftInfo")) === "That gift card number isn't right.");
  typeIn($("#pmGiftCode"), gEmpty.code); $("#pmGiftCheck").click(); await idle();
  ok("a card with nothing left: “This gift card has no balance left.”", text($("#pmGiftInfo")) === "This gift card has no balance left.");
  typeIn($("#pmGiftCode"), " " + g30.code.toLowerCase() + " "); $("#pmGiftCheck").click(); await idle();
  ok("a good card: “Gift card ••" + "XXXX has $30.00.” with its own last four, in green", text($("#pmGiftInfo")) === `Gift card ••${g30.last4} has $30.00.` && $("#pmGiftInfo").style.color === "rgb(22, 101, 52)");
  ok("…the check asks with the number as typed, trimmed", of("checkGiftCard").pop().code === g30.code.toLowerCase());
  ok("…and Check is usable again afterwards", $("#pmGiftCheck").disabled === false);
  scripted = [{ action: "checkGiftCard", throws: "offline" }];
  $("#pmGiftCheck").click(); await idle();
  ok("no answer: the error is said (“offline”)", /offline|Network|server/i.test(text($("#pmGiftInfo"))) && $("#pmGiftInfo").style.color === "rgb(176, 58, 46)");
  scripted = [{ action: "checkGiftCard", body: { status: "ok", ok: true, card: { last4: "TEST", balance: 2.5 } } }];
  $("#pmGiftCheck").click(); await idle();
  ok("an answer with the card nested reads the same (“Gift card ••TEST has $2.50.”)", text($("#pmGiftInfo")) === "Gift card ••TEST has $2.50.");
  scripted = [{ action: "checkGiftCard", body: { status: "ok", ok: false } }];
  $("#pmGiftCheck").click(); await idle();
  ok("a refusal with no reason: “That gift card number isn't right.”", text($("#pmGiftInfo")) === "That gift card number isn't right.");
  choose(method, "cash");
  ok("back to Cash: the usual fields return, Save reads Save, the balance is the placeholder and the card line is cleared",
    qa(".pm-std").every(e => !e.hidden) && qa(".pm-gift").every(e => e.hidden) && text($("#pmSavePayment")) === "Save" && $("#pmAmount").placeholder === "40.00" && text($("#pmGiftInfo")) === "");
  choose(method, "__giftcard__");

  console.log("\n=== Apply card ===");
  reset();
  typeIn($("#pmGiftCode"), "");
  $("#pmSavePayment").click(); await idle();
  ok("Apply card with no number: “Enter the gift card number.” and nothing sent", text($("#pmError")) === "Enter the gift card number." && sent.length === 0);
  typeIn($("#pmGiftCode"), g30.code); $("#pmAmount").value = "-3";
  $("#pmSavePayment").click(); await idle();
  ok("a negative amount: “Enter an amount, or leave it empty to take as much as the card can.”", text($("#pmError")) === "Enter an amount, or leave it empty to take as much as the card can." && sent.length === 0);
  $("#pmAmount").value = "0"; $("#pmSavePayment").click(); await idle();
  ok("…and so is 0", /^Enter an amount/.test(text($("#pmError"))) && sent.length === 0);
  typeIn($("#pmGiftCode"), gVoid.code); $("#pmAmount").value = "";
  $("#pmSavePayment").click(); await idle();
  ok("a voided card: the server's refusal in the window, nothing taken", text($("#pmError")) === "That gift card number isn't right." && !q1("SELECT 1 AS x FROM order_payments WHERE orderId = ? AND giftCardId IS NOT NULL", oPay));
  typeIn($("#pmGiftCode"), g30.code); $("#pmAmount").value = "15";
  reset();
  $("#pmSavePayment").click(); await idle();
  const redeem1 = of("redeemGiftCard")[0];
  ok("$15 from the $30 card: redeemGiftCard with the order, the number, the amount and a request key", !!redeem1 && redeem1.orderId === oPay && redeem1.code === g30.code && redeem1.amount === 15 && /\S{8,}/.test(redeem1.requestId || ""));
  ok("…toast “Took $15.00 from the gift card; $15.00 is left on it.”", lastToast().m === "Took $15.00 from the gift card; $15.00 is left on it." && !lastToast().err);
  ok("…the card has $15.00 left and the order a $15.00 gift-card payment", cardBal(g30) === 1500 && q1("SELECT amountCents, method, accountId FROM order_payments WHERE orderId = ? AND giftCardId = ?", oPay, g30.id).amountCents === 1500);
  const payRow = () => qa("#pmContent tbody tr").find(tr => /Gift card ••/.test(text(tr)) && !tr.style.textDecoration);
  let gpRow = payRow();
  ok("the window is drawn again: the payment reads “Gift card · Gift card ••" + "XXXX”", !!gpRow && text(gpRow).includes(`Gift card · Gift card ••${g30.last4}`));
  ok("…with no account to move it into (it isn't money in an account)", !!gpRow && !gpRow.querySelector("select.pm-acct") && /no account/.test(text(gpRow)));
  const back = gpRow && gpRow.querySelector('[data-admin-action="pmRefundToGiftCard"]');
  ok("…a “Back to card…” button for Full on orders.payments, carrying the amount", !!back && text(back) === "Back to card…" && back.dataset.need === "orders.payments:full" && back.dataset.amount === "15.00");
  ok("…and its Void says the money goes back on the card", !!gpRow && /money goes back on the gift card/.test(gpRow.querySelector('[data-admin-action="pmDeletePayment"]').title));
  ok("the balance due is now $25.00", qa("#pmContent tr").some(tr => text(tr) === "Balance due$25.00"));
  ok("the cached order follows (amount received $15.00)", Number(w._ordersCache.club.find(o => o.orderId === oPay).amountReceived) === 15);
  choose($("#pmMethod"), "__giftcard__");
  typeIn($("#pmGiftCode"), g5.code); $("#pmAmount").value = "";
  reset();
  $("#pmSavePayment").click(); await idle();
  ok("left empty, the amount isn't sent: the $5 card gives all it has", !!of("redeemGiftCard")[0] && !("amount" in of("redeemGiftCard")[0]) && cardBal(g5) === 0 && lastToast().m === "Took $5.00 from the gift card; $0.00 is left on it.");
  choose($("#pmMethod"), "__giftcard__");
  typeIn($("#pmGiftCode"), g7.code);
  scripted = [{ action: "redeemGiftCard", body: { status: "ok", duplicate: true } }];
  $("#pmSavePayment").click(); await idle();
  ok("an answer that it was already recorded: “That gift card payment was already recorded — it isn't taken twice.”", lastToast().m === "That gift card payment was already recorded — it isn't taken twice.");
  await closePay(pm); pm = await openPay(oPay);
  choose($("#pmMethod"), "__giftcard__"); typeIn($("#pmGiftCode"), g7.code);
  scripted = [{ action: "redeemGiftCard", body: { status: "ok", takenCents: 250, balanceCents: 450 } }];
  $("#pmSavePayment").click(); await idle();
  ok("an answer in cents reads the same: “Took $2.50 …; $4.50 is left on it.”", lastToast().m === "Took $2.50 from the gift card; $4.50 is left on it.");
  await closePay(pm); pm = await openPay(oPay);
  choose($("#pmMethod"), "__giftcard__"); typeIn($("#pmGiftCode"), g7.code);
  scripted = [{ action: "redeemGiftCard", body: { status: "ok", taken: 1 } }];
  $("#pmSavePayment").click(); await idle();
  ok("…with no balance in it: “Took $1.00 from the gift card.”", lastToast().m === "Took $1.00 from the gift card.");
  await closePay(pm); pm = await openPay(oPay);
  choose($("#pmMethod"), "__giftcard__"); typeIn($("#pmGiftCode"), g7.code);
  scripted = [{ action: "redeemGiftCard", body: { status: "ok" } }];
  $("#pmSavePayment").click(); await idle();
  ok("…and with neither: “Gift card applied.”", lastToast().m === "Gift card applied.");
  await closePay(pm); pm = await openPay(oPay);
  choose($("#pmMethod"), "__giftcard__"); typeIn($("#pmGiftCode"), g7.code);
  scripted = [{ action: "redeemGiftCard", throws: "offline" }];
  $("#pmSavePayment").click(); await idle();
  ok("no answer: the error is said in the window", /offline|Network|server/i.test(text($("#pmError"))));
  ok("(none of those scripted answers took money off the $7 card)", cardBal(g7) === 700);

  console.log("\n=== Back to card… and Void on a gift-card payment ===");
  reset();
  payRow().querySelector('[data-admin-action="pmRefundToGiftCard"]').click();
  let a = await answer(false);
  ok("Back to card… asks “How much goes back on the gift card?” up to the payment; Cancel sends nothing", /How much goes back on the gift card\?/.test(a.message) && /Up to \$15\.00/.test(a.message) && a.okLabel === "Refund to card" && of("refundToGiftCard").length === 0);
  payRow().querySelector('[data-admin-action="pmRefundToGiftCard"]').click();
  a = await answer(true, "20");
  ok("more than the payment: “Enter an amount from $0.01 to $15.00.” and the question stays", a.stillOpen && a.err === "Enter an amount from $0.01 to $15.00.");
  confirmBox().querySelector("#cmInput").value = "$5"; fire(confirmBox().querySelector("#cmInput"), "input");
  confirmBox().querySelector("#cmOk").click(); await idle();
  const rf = of("refundToGiftCard")[0];
  ok("$5 back: refundToGiftCard with the payment, the amount, the order and a request key", !!rf && rf.paymentId === q1("SELECT id FROM order_payments WHERE orderId = ? AND giftCardId = ? AND kind = 'payment'", oPay, g30.id).id && rf.amount === 5 && rf.orderId === oPay && !!rf.requestId);
  ok("…toast “$5.00 put back on the gift card.” and the card has $20.00", lastToast().m === "$5.00 put back on the gift card." && cardBal(g30) === 2000);
  ok("…the window shows the refund row (“Refunded to gift card”, no account) and Refunded −$5.00", qa("#pmContent tbody tr").some(tr => /−\$5\.00 refund/.test(text(tr)) && /Gift card · Gift card ••/.test(text(tr)) && /no account Refunded to gift card/.test(text(tr))) && qa("#pmContent tr").some(tr => text(tr) === "Refunded−$5.00"));
  ok("…a refund row has no Back to card…", qa("#pmContent tbody tr").filter(tr => /refund/.test(text(tr))).every(tr => !tr.querySelector('[data-admin-action="pmRefundToGiftCard"]')));
  scripted = [{ action: "refundToGiftCard", status: 409, body: { status: "error", message: "That payment wasn't paid by a gift card." } }];
  payRow().querySelector('[data-admin-action="pmRefundToGiftCard"]').click();
  await answer(true, "1"); await idle();
  ok("a refused refund: toast “Not refunded: That payment wasn't paid by a gift card.” (an error)", lastToast().m === "Not refunded: That payment wasn't paid by a gift card." && lastToast().err);
  await closePay(pm);

  // ==============================================================================================================
  console.log("\n=== The Payments window: discount codes on the order ===");
  await rule(false);
  pm = await openPay(oCodes);
  const codesBox = () => $(".pm-codes");
  ok("a Discount codes area under the manual discount: “Add code” and its box, no codes yet", !!codesBox() && text(codesBox().querySelector("label")) === "Add code" && !codesBox().querySelector(".pm-code-chip"));
  ok("Add code needs orders.payments edit, inside the discount form that needs the same", $("#pmCodeApply").dataset.need === "orders.payments:edit" && !!$("#pmCodeApply").closest('[data-need-form="orders.payments:edit"]'));
  ok("…the manual discount is open while no code is on", !$("#pmDiscountAmount").disabled && !$("#pmSaveDiscount").disabled && !$(".pm-code-note"));
  reset();
  $("#pmCodeApply").click(); await idle();
  ok("Add code with nothing typed: “Enter a code first.”, nothing sent", text($("#pmError")) === "Enter a code first." && sent.length === 0);
  typeIn($("#pmCodeInput"), "nope"); $("#pmCodeApply").click(); await idle();
  ok("a code that isn't one: the server's reason in the window", of("applyOrderDiscountCode")[0].code === "NOPE" && !!text($("#pmError")) && !/Enter a code/.test(text($("#pmError"))));
  typeIn($("#pmCodeInput"), " save10 "); reset();
  $("#pmCodeApply").click(); await idle();
  ok("SAVE10 (typed in lower case): applyOrderDiscountCode with the order and the code upper-cased", same(of("applyOrderDiscountCode"), [{ action: "applyOrderDiscountCode", orderId: oCodes, code: "SAVE10" }]));
  ok("…toast “Code SAVE10 added.”, and the order has $4.00 off", lastToast().m === "Code SAVE10 added." && q1("SELECT discountCents FROM orders WHERE orderId = ?", oCodes).discountCents === 400);
  const chips = () => qa("#pmContent .pm-code-chip").map(c => text(c.querySelector(".dc-code")));
  ok("the window is drawn again with the code and its ×, labelled “Take code SAVE10 off”", same(chips(), ["SAVE10"]) && $('[data-pm-code-remove="SAVE10"]').getAttribute("aria-label") === "Take code SAVE10 off");
  ok("…the box now says “Add another code”", text(codesBox().querySelector("label")) === "Add another code");
  ok("…the Discount line names the code (−$4.00)", qa("#pmContent tr").some(tr => /^Discount \(Code SAVE10\)−\$4\.00$/.test(text(tr))));
  ok("…and the manual discount is locked, saying “take the code off before setting a discount by hand”",
    $("#pmDiscountAmount").disabled && $("#pmDiscountNote").disabled && $("#pmSaveDiscount").disabled && text($(".pm-code-note")) === "This order has a discount code; take the code off before setting a discount by hand.");
  typeIn($("#pmCodeInput"), "TEAM5"); reset();
  enter($("#pmCodeInput")); await idle();
  ok("one code per order (the default): Enter tries TEAM5 and the refusal “Only one discount code can be used on an order.” is shown",
    of("applyOrderDiscountCode").length === 1 && text($("#pmError")) === "Only one discount code can be used on an order." && same(chips(), ["SAVE10"]));
  await rule(true);
  typeIn($("#pmCodeInput"), "team5"); $("#pmCodeApply").click(); await idle();
  ok("with several allowed (Global settings): TEAM5 joins — both listed, $9.00 off ($4 + $5)", same(chips(), ["SAVE10", "TEAM5"]) && q1("SELECT discountCents FROM orders WHERE orderId = ?", oCodes).discountCents === 900);
  typeIn($("#pmCodeInput"), "SAVE10"); $("#pmCodeApply").click(); await idle();
  ok("the same code again: “That code is already applied.”", text($("#pmError")) === "That code is already applied.");
  reset();
  $('[data-pm-code-remove="TEAM5"]').click();
  a = await answer(false);
  ok("× asks “Take code TEAM5 off <order>?” (the total goes back up); Cancel sends nothing", new RegExp("Take code TEAM5 off " + oCodes + "\\?").test(a.message) && /total goes back up/.test(a.message) && a.okLabel === "Take it off" && of("removeOrderDiscountCode").length === 0);
  $('[data-pm-code-remove="TEAM5"]').click();
  await answer(true); await idle();
  ok("Take it off: removeOrderDiscountCode for TEAM5; toast “Code TEAM5 taken off.”; $4.00 off again", same(of("removeOrderDiscountCode"), [{ action: "removeOrderDiscountCode", orderId: oCodes, code: "TEAM5" }]) &&
    lastToast().m === "Code TEAM5 taken off." && same(chips(), ["SAVE10"]) && q1("SELECT discountCents FROM orders WHERE orderId = ?", oCodes).discountCents === 400);
  scripted = [{ action: "removeOrderDiscountCode", status: 400, body: { status: "error" } }];
  $('[data-pm-code-remove="SAVE10"]').click(); await answer(true); await idle();
  ok("a removal refused without words: “The code wasn't changed.” (or the client's own wording) and the code stays", !!text($("#pmError")) && same(chips(), ["SAVE10"]));
  $('[data-pm-code-remove="SAVE10"]').click(); await answer(true); await idle();
  ok("the last code off: no codes listed, the manual discount open again", same(chips(), []) && !$("#pmDiscountAmount").disabled && !$(".pm-code-note"));
  await closePay(pm);

  pm = await openPay(oManual);
  typeIn($("#pmCodeInput"), "SAVE10"); $("#pmCodeApply").click(); await idle();
  ok("an order with a discount typed by hand: the code is refused, the reason shown", !!text($("#pmError")) && q1("SELECT count(*) AS n FROM discount_code_uses WHERE orderId = ?", oManual).n === 0);
  await closePay(pm);

  pm = await openPay(oShip);
  typeIn($("#pmCodeInput"), "SHIPFREE"); $("#pmCodeApply").click(); await idle();
  ok("a free-shipping code on an order with $8 shipping: “Free shipping (SHIPFREE) −$8.00” under Shipping", qa("#pmContent tr").some(tr => text(tr) === "Free shipping (SHIPFREE)−$8.00"));
  ok("…and the balance due is the goods only ($20.00)", qa("#pmContent tr").some(tr => text(tr) === "Balance due$20.00"));
  await closePay(pm);
  const shipOrder = w._ordersCache.club.find(o => o.orderId === oShip);
  pm = await openPay(oShip);
  ok("(the order from the list carries shippingDiscount 8 and discountCodes [SHIPFREE])", Number(shipOrder.shippingDiscount) === 8 && same(shipOrder.discountCodes, ["SHIPFREE"]));
  await closePay(pm);
  // An order the page has from an older answer: discountCode text and shippingDiscountCents only.
  w._ordersCache.club.push(Object.assign({}, shipOrder, { orderId: "OLD-1", discountCodes: undefined, discountCode: "SHIPFREE, TEAM5", shippingDiscount: undefined, shippingDiscountCents: 800 }));
  pm = await openPay("OLD-1");
  ok("an older order shape: codes from the joined text, shipping off from cents", same(chips(), ["SHIPFREE", "TEAM5"]) && qa("#pmContent tr").some(tr => text(tr) === "Free shipping (SHIPFREE, TEAM5)−$8.00"));
  await closePay(pm);
  w._ordersCache.club.push(Object.assign({}, shipOrder, { orderId: "OLD-2", discountCodes: undefined, discountCode: "", shippingDiscount: 2, payments: [{ id: 99, amount: 4, method: "other", reference: "Gift card ••2345", kind: "payment", receivedAt: "2026-11-01T00:00:00Z" },
    { id: 98, amount: 3, method: "other", reference: "Gift card ••W5TX", kind: "payment", receivedAt: "2026-11-01T00:00:00Z" },
    { id: 97, amount: 2, method: "other", reference: "Gift card ••w5tx!", kind: "payment", receivedAt: "2026-11-01T00:00:00Z" }] }));
  pm = await openPay("OLD-2");
  ok("free shipping with no code named: “Free shipping −$2.00”", qa("#pmContent tr").some(tr => text(tr) === "Free shipping−$2.00"));
  ok("a payment the page only knows by its reference (••2345) is still shown as a gift card", qa("#pmContent tbody tr").some(tr => text(tr).includes("Gift card · Gift card ••2345")));
  ok("…and so is one whose last four are letters and digits, as a card's are (••W5TX), with its Back to card button",
    qa("#pmContent tbody tr").some(tr => text(tr).includes("Gift card · Gift card ••W5TX") && !!tr.querySelector("[data-admin-action=pmRefundToGiftCard]")));
  ok("…while a reference that only looks like one (••w5tx!) is not taken for a card", qa("#pmContent tbody tr").some(tr => text(tr).includes("Other · Gift card ••w5tx!")));
  await closePay(pm);

  features({ discounts: false, giftCards: false });
  pm = await openPay(oCodes);
  ok("Discount codes and Gift cards switched off: no codes area and no Gift card choice", !$(".pm-codes") && ![...$("#pmMethod").options].some(o => o.value === "__giftcard__"));
  await closePay(pm);
  features({});

  // A role that may see payments but not change them: the new controls are offered to nobody who can't use them.
  w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(Object.assign({}, roles.effectivePermissions(roles.DEFAULT_ROLES.staff), { "orders.payments": "read" }))}; adminAreas = ${JSON.stringify(roles.PERMISSION_AREAS)};`);
  pm = await openPay(oPay);
  ok("orders.payments read only: Record payment (Gift card and its Check with it) is off", off(q('#pmContent [data-need="orders.payments:edit"]')) && !!$("#pmGiftCheck").closest("[data-perm-off]"));
  ok("…Add code is off and its box read-only", off($("#pmCodeApply")) && $("#pmCodeInput").disabled);
  ok("…and Back to card… is off", off(payRow().querySelector('[data-admin-action="pmRefundToGiftCard"]')));
  await closePay(pm);
  asRoles("staff");
  pm = await openPay(oPay);
  ok("Back office (payments Edit, not Full): Gift card and Add code are theirs, Back to card… isn't", !off(q('#pmContent [data-need="orders.payments:edit"]')) && !off($("#pmCodeApply")) && off(payRow().querySelector('[data-admin-action="pmRefundToGiftCard"]')));
  await closePay(pm);
  asRoles("admin");

  pm = await openPay(oPay);
  reset();
  payRow().querySelector('[data-admin-action="pmDeletePayment"]').click();
  await wait(() => !!confirmBox()); confirmBox().querySelector("#cmOk").click(); await idle();
  ok("Void on the gift-card payment ($15, $5 of it already back on the card): only the other $10 goes back ($30.00, what the card had)", cardBal(g30) === 3000);
  ok("…its ledger has one “Payment voided” row of $10.00", same(d1.q("SELECT deltaCents FROM gift_card_ledger WHERE cardId = ? AND note = 'Payment voided'", g30.id).map(r => r.deltaCents), [1000]));
  await closePay(pm);

  // ==============================================================================================================
  console.log("\n=== The Local sale window: several codes ===");
  const form = () => q("#localSaleForm");
  const preview = () => text(form().querySelector("#lsPricePreview"));
  const addLink = () => form().querySelector("#lsCodeAdd");
  const rowsOf = () => [{ input: form().querySelector("#lsCode"), btn: form().querySelector("#lsCodeApply"), msg: form().querySelector("#lsCodeMsg") }]
    .concat(qa("#localSaleForm .ls-code-row").map(h => ({ input: h.querySelector("input"), btn: h.querySelector('[data-f="apply"]'), msg: h.querySelector('[data-f="msg"]'), x: h.querySelector('[data-f="remove"]') })));
  const open = async (opts) => { reset(); const done = w.createLocalSale("club", opts); await wait(() => !!form()); await idle(); return { p: done }; };
  const pickMugs = (n) => { choose(form().querySelector("#lsProduct"), "mug"); typeIn(form().querySelector("#lsQty"), String(n)); };
  const closeSale = async (box) => { const c = [...form().querySelectorAll("button")].find(b => /^Cancel$/.test(text(b))); c.click(); await pause(20); if (confirmBox()) confirmBox().querySelector("#cmOk").click(); await (box && box.p); await idle(); };
  const record = async (box) => { form().querySelector(".admin-pass-submit").click(); if (box) await box.p; else await wait(() => !form()); await idle(); };
  w.refreshOrderRows_ = () => {};

  await rule(false);
  w.eval("_lsRulesPromise = null");
  let done = await open();
  pickMugs(4);
  ok("the code box has an “Add another code” link, hidden at first", !!addLink() && addLink().hidden);
  ok("the window asked once whether several codes may be used (getDiscountRules)", of("getDiscountRules").length === 1);
  typeIn(rowsOf()[0].input, "save10"); rowsOf()[0].btn.click(); await idle();
  ok("Apply SAVE10: “✓ SAVE10: 10% off — $4.00 off” and the preview takes it off", text(rowsOf()[0].msg) === "✓ SAVE10: 10% off — $4.00 off" && /− \$4\.00 code SAVE10$/.test(preview()));
  ok("one code per order (the shop's rule): “Add another code” stays hidden", addLink().hidden);
  await closeSale(done);

  await rule(true);
  w.eval("_lsRulesPromise = null");
  done = await open();
  pickMugs(4);
  ok("several allowed: still hidden until a code is applied", addLink().hidden);
  typeIn(rowsOf()[0].input, "SAVE10"); enter(rowsOf()[0].input); await idle();
  ok("Enter applies the first code; the link appears", text(rowsOf()[0].msg) === "✓ SAVE10: 10% off — $4.00 off" && !addLink().hidden);
  addLink().click();
  ok("Add another code: a second row (its box, Apply and ×, labelled “Discount code 2”), focused, and the link hides again",
    rowsOf().length === 2 && rowsOf()[1].input.getAttribute("aria-label") === "Discount code 2" && rowsOf()[1].x.getAttribute("aria-label") === "Remove code 2" && d.activeElement === rowsOf()[1].input && addLink().hidden);
  reset();
  typeIn(rowsOf()[1].input, "team5"); rowsOf()[1].btn.click(); await idle();
  ok("TEAM5 in the second row is checked with the code already on (others: SAVE10)", same(of("checkLocalSaleCode")[0].others, ["SAVE10"]) && of("checkLocalSaleCode")[0].code === "TEAM5" && of("checkLocalSaleCode")[0].subtotal === 40);
  ok("…each row says what it takes off ($4.00, then $5.00) and the preview “− $9.00 codes SAVE10, TEAM5”",
    text(rowsOf()[1].msg) === "✓ TEAM5: $5.00 off — $5.00 off" && /− \$9\.00 codes SAVE10, TEAM5$/.test(preview()));
  addLink().click();
  typeIn(rowsOf()[2].input, "SAVE10"); rowsOf()[2].btn.click(); await idle();
  ok("the same code twice: “That code is already applied.” in that row, no link", text(rowsOf()[2].msg) === "That code is already applied." && addLink().hidden);
  rowsOf()[2].btn.click(); await pause(0);
  typeIn(rowsOf()[2].input, "ONE3"); rowsOf()[2].btn.click(); await idle();
  addLink().click(); typeIn(rowsOf()[3].input, "ONE4"); rowsOf()[3].btn.click(); await idle();
  addLink().click(); typeIn(rowsOf()[4].input, "ONE5"); rowsOf()[4].btn.click(); await idle();
  ok("five codes applied: the link is gone (the server takes five)", rowsOf().length === 5 && addLink().hidden && /− \$12\.00 codes SAVE10, TEAM5, ONE3, ONE4, ONE5$/.test(preview()));
  rowsOf()[4].x.click(); await idle();
  ok("× on a row takes it out, the preview follows and the link comes back; the row above is focused",
    rowsOf().length === 4 && /− \$11\.00 codes SAVE10, TEAM5, ONE3, ONE4$/.test(preview()) && !addLink().hidden && d.activeElement === rowsOf()[3].input);
  typeIn(rowsOf()[3].input, "ONE4X");
  ok("changing an applied row's text un-applies it (its message cleared, the preview without it)", text(rowsOf()[3].msg) === "" && /− \$10\.00 codes SAVE10, TEAM5, ONE3$/.test(preview()) && addLink().hidden);
  typeIn(rowsOf()[3].input, ""); rowsOf()[3].btn.click(); await idle();
  ok("Apply on an empty row: “Enter a code first.”", text(rowsOf()[3].msg) === "Enter a code first.");
  rowsOf()[3].x.click(); rowsOf()[2].x.click(); await idle();
  form().querySelector("#lsShip").checked = true; fire(form().querySelector("#lsShip"), "change");
  for (const [k, v] of Object.entries({ lsShipLine1: ADDR.line1, lsShipCity: ADDR.city, lsShipState: ADDR.state, lsShipZip: ADDR.zip, lsShipCost: "8" })) typeIn(form().querySelector("#" + k), v);
  ok("with $8 shipping the preview adds it", /\+ \$8\.00 shipping$/.test(preview()));
  addLink().click(); typeIn(rowsOf()[2].input, "SHIPFREE"); rowsOf()[2].btn.click(); await idle();
  ok("SHIPFREE: “✓ SHIPFREE: Free shipping — free shipping” and “+ $0.00 shipping (free with SAVE10, TEAM5, SHIPFREE)”",
    text(rowsOf()[2].msg) === "✓ SHIPFREE: Free shipping — free shipping" && /\+ \$0\.00 shipping \(free with SAVE10, TEAM5, SHIPFREE\)$/.test(preview()));
  addLink().click(); typeIn(rowsOf()[3].input, "BIG50"); rowsOf()[3].btn.click(); await idle();
  ok("a code with a $50 minimum on $40 of goods: “This code needs an order of at least $50.00.”", text(rowsOf()[3].msg) === "This code needs an order of at least $50.00.");
  scripted = [{ action: "checkLocalSaleCode", throws: "offline" }];
  rowsOf()[3].btn.click(); await idle();
  ok("no answer: the row says so", /offline|Network|server/i.test(text(rowsOf()[3].msg)));
  scripted = [{ action: "checkLocalSaleCode", body: { status: "ok", ok: false } }];
  rowsOf()[3].btn.click(); await idle();
  ok("a refusal with no reason: “This code isn't valid.”", text(rowsOf()[3].msg) === "This code isn't valid.");
  rowsOf()[3].x.click();
  typeIn(form().querySelector("#lsEmail"), "lee@example.com");
  reset(); fire(form().querySelector("#lsEmail"), "change"); await idle();
  ok("a different email: every applied code is checked again", of("checkLocalSaleCode").map(b => b.code).join() === "SAVE10,TEAM5,SHIPFREE");
  choose(form().querySelector("#lsPayment"), "Cash");
  reset();
  await record(done);
  const ls1 = of("createLocalSale")[0];
  ok("Record sale sends the three codes as discountCodes (no discountCode)", !!ls1 && same(ls1.discountCodes, ["SAVE10", "TEAM5", "SHIPFREE"]) && !("discountCode" in ls1));
  const ls1Id = (/Local sale recorded — (\S+)/.exec(lastToast().m) || [])[1];
  const ls1Row = ls1Id && q1("SELECT discountCents, shippingDiscountCents, discountNote FROM orders WHERE orderId = ?", ls1Id);
  ok("…the order has $9.00 off the goods, $8.00 off shipping, noted “Codes SAVE10, TEAM5, SHIPFREE”", !!ls1Row && ls1Row.discountCents === 900 && ls1Row.shippingDiscountCents === 800 && ls1Row.discountNote === "Codes SAVE10, TEAM5, SHIPFREE");

  // The rule can't be read (a role without it, or no answer): the link is offered and the server decides.
  await rule(false);
  w.eval("_lsRulesPromise = null");
  scripted = [{ action: "getDiscountRules", status: 403, body: { status: "error", message: "Your role can't do that here." } }];
  done = await open();
  pickMugs(4);
  typeIn(rowsOf()[0].input, "SAVE10"); rowsOf()[0].btn.click(); await idle();
  ok("the rule unknown: the link is offered after the first code", !addLink().hidden);
  addLink().click(); typeIn(rowsOf()[1].input, "TEAM5"); rowsOf()[1].btn.click(); await idle();
  ok("…a second code in one-code mode: the server's “Only one discount code can be used on an order.” is shown in its row", text(rowsOf()[1].msg) === "Only one discount code can be used on an order.");
  ok("…and the rule is asked again next time (a failed read isn't kept)", w.eval("_lsRulesPromise") === null);
  typeIn(rowsOf()[1].input, "SAVE10");
  choose(form().querySelector("#lsPayment"), "Cash");
  reset(); await record(done);
  ok("the same code typed in two rows is sent once, as discountCode", of("createLocalSale")[0].discountCode === "SAVE10" && !("discountCodes" in of("createLocalSale")[0]));
  scripted = [{ action: "getDiscountRules", body: { status: "ok", discountRules: { multiple: true } } }];
  ok("an answer with discountRules: { multiple: true } is read as several", ((await w.lsDiscountRules_()) || {}).multiple === true);
  w.eval("_lsRulesPromise = null");
  scripted = [{ action: "getDiscountRules", body: { status: "ok", multiple: false } }];
  ok("…a flat { multiple: false } as one", ((await w.lsDiscountRules_()) || {}).multiple === false);
  w.eval("_lsRulesPromise = null");
  scripted = [{ action: "getDiscountRules", body: { status: "ok" } }];
  ok("…and an answer with neither as unknown (null)", (await w.lsDiscountRules_()) === null);
  w.eval("_lsRulesPromise = null");

  console.log("\n=== What the codes take off in the window (lsCombineCodes_) ===");
  const cmb = (codes, goods, ship) => { const r = w.lsCombineCodes_(codes, goods, ship); return [r.goodsOffCents, r.shippingOffCents, r.perCode.map(p => p.goodsOffCents + "/" + p.shippingOffCents).join(" ")].join("|"); };
  ok("10% + 15% of $100 add up to $25", cmb([{ kind: "percent", percent: 10 }, { kind: "percent", percent: 15 }], 10000, 0) === "2500|0|1000/0 1500/0");
  ok("a percent code's own maximum caps its share", cmb([{ kind: "percent", percent: 50, maxDiscount: 5 }, { kind: "percent", percent: 10 }], 10000, 0) === "1500|0|500/0 1000/0");
  ok("percents never take more than the goods (60% + 70%)", cmb([{ kind: "percent", percent: 60 }, { kind: "percent", percent: 70 }], 1000, 0) === "1000|0|600/0 400/0");
  ok("amount codes come off what is left, in order, never below zero", cmb([{ kind: "amount", amount: 5 }, { kind: "percent", percent: 50 }, { kind: "amount", amount: 9 }], 1000, 0) === "1000|0|500/0 500/0 0/0");
  ok("a free-shipping code takes the shipping once, even with two such codes; a percent code with free shipping takes both", cmb([{ kind: "shipping" }, { kind: "percent", percent: 10, freeShipping: true }], 2000, 800) === "200|800|0/800 200/0");
  ok("nothing applied, or nonsense numbers: nothing off", cmb([], 2000, 800) === "0|0|" && cmb(null, "x", -5) === "0|0|" && cmb([{ kind: "amount", amount: "x" }], 500, 0) === "0|0|0/0");

  // ==============================================================================================================
  console.log("\n=== The Local sale window: gift cards ===");
  done = await open();
  pickMugs(2);
  const gw = form().querySelector("#lsGiftWrap");
  ok("a Gift card box (number and Apply) for a role that may take payments (data-need orders.payments:edit)", !!gw && gw.dataset.need === "orders.payments:edit" && !!form().querySelector("#lsGiftApply"));
  const gMsg = () => text(form().querySelector("#lsGiftMsg"));
  const gList = () => qa("#lsGiftList .ls-gift-chip").map(e => text(e.querySelector("span")));
  form().querySelector("#lsGiftApply").click(); await idle();
  ok("Apply with nothing typed: “Enter the gift card number first.”", gMsg() === "Enter the gift card number first." && of("checkGiftCard").length === 0);
  typeIn(form().querySelector("#lsGift"), "ABCD-EFGH-JKLM-NPQR"); form().querySelector("#lsGiftApply").click(); await idle();
  ok("a wrong number: “That gift card number isn't right.”, nothing listed", gMsg() === "That gift card number isn't right." && gList().length === 0);
  typeIn(form().querySelector("#lsGift"), g8.code); enter(form().querySelector("#lsGift")); await idle();
  ok("Enter applies a good card: “✓ Gift card ••" + "XXXX has $8.00.”, the box emptied", gMsg() === `✓ Gift card ••${g8.last4} has $8.00.` && form().querySelector("#lsGift").value === "");
  ok("…listed with what it pays: “balance $8.00, pays about $8.00 (before sales tax)”", same(gList(), [`Gift card ••${g8.last4} — balance $8.00, pays about $8.00 (before sales tax)`]));
  typeIn(form().querySelector("#lsGift"), g8.code.toLowerCase().replace(/-/g, " ")); form().querySelector("#lsGiftApply").click(); await idle();
  ok("the same card typed another way: “That gift card is already on this sale.”", gMsg() === "That gift card is already on this sale.");
  typeIn(form().querySelector("#lsGift"), g30.code); form().querySelector("#lsGiftApply").click(); await idle();
  ok("a second card pays only what is left ($12.00 of its $30.00)", gList()[1] === `Gift card ••${g30.last4} — balance $30.00, pays about $12.00 (before sales tax)`);
  typeIn(form().querySelector("#lsGift"), g9.code); form().querySelector("#lsGiftApply").click(); await idle();
  ok("a third pays nothing more ($0.00)", gList()[2] === `Gift card ••${g9.last4} — balance $9.00, pays about $0.00 (before sales tax)`);
  typeIn(form().querySelector("#lsGift"), gLate.code); form().querySelector("#lsGiftApply").click(); await idle();
  ok("a fourth: “Up to 3 gift cards can pay one sale.”", gMsg() === "Up to 3 gift cards can pay one sale." && gList().length === 3);
  ok("each card's × is labelled with its last four", qa("#lsGiftList [data-gift-remove]")[1].getAttribute("aria-label") === `Remove gift card ••${g30.last4}`);
  qa("#lsGiftList [data-gift-remove]")[2].click();
  qa("#lsGiftList [data-gift-remove]")[1].click();
  ok("× takes a card off and clears the message", gList().length === 1 && gMsg() === "");
  scripted = [{ action: "checkGiftCard", throws: "offline" }];
  typeIn(form().querySelector("#lsGift"), gLate.code); form().querySelector("#lsGiftApply").click(); await idle();
  ok("no answer: the message says so and nothing is added", /offline|Network|server/i.test(gMsg()) && gList().length === 1);
  scripted = [{ action: "checkGiftCard", body: { status: "ok", ok: false } }];
  form().querySelector("#lsGiftApply").click(); await idle();
  ok("a refusal with no reason: “That gift card number isn't right.”", gMsg() === "That gift card number isn't right.");
  typeIn(form().querySelector("#lsGift"), gLate.code); form().querySelector("#lsGiftApply").click(); await idle();
  // The late card is voided before the sale is recorded: the server refuses it, the sale stands.
  d1._raw.exec(`UPDATE gift_cards SET status = 'void' WHERE id = ${gLate.id}`);
  ok("no payment method picked", form().querySelector("#lsPayment").value === "");
  reset(); await record(done);
  const ls2 = of("createLocalSale")[0];
  ok("Record sale with only gift cards: the method goes as Other, and the cards with their balances", !!ls2 && ls2.paymentMethod === "Other" &&
    same(ls2.giftCards, [{ code: g8.code, amount: 8 }, { code: gLate.code, amount: 10 }]));
  ok("…the toast says the sale was recorded and why a card wasn't taken (an error toast)", /^Local sale recorded — \S+ — That gift card number isn't right\.$/.test(lastToast().m) && lastToast().err);
  const ls2Id = (/Local sale recorded — (\S+)/.exec(lastToast().m) || [])[1];
  ok("…the $8 card paid $8.00 of it", cardBal(g8) === 0 && q1("SELECT amountCents FROM order_payments WHERE orderId = ? AND giftCardId = ?", ls2Id, g8.id).amountCents === 800);
  done = await open();
  pickMugs(1);
  typeIn(form().querySelector("#lsGift"), g9.code); form().querySelector("#lsGiftApply").click(); await idle();
  choose(form().querySelector("#lsPayment"), "Card");
  reset(); await record(done);
  ok("a card that covers it, with Card picked: sent as Card, the toast plain", of("createLocalSale")[0].paymentMethod === "Card" && /^Local sale recorded — \S+$/.test(lastToast().m) && !lastToast().err && cardBal(g9) === 0);
  features({ giftCards: false });
  done = await open();
  ok("Gift cards switched off: no Gift card box", !form().querySelector("#lsGiftWrap"));
  features({ discounts: false });
  await closeSale(done);
  done = await open();
  ok("Discount codes switched off: no code box", !form().querySelector("#lsCodeWrap") && !!form().querySelector("#lsGiftWrap"));
  await closeSale(done);
  features({});
  asRoles("staff");
  done = await open();
  ok("Back office (payments Edit) gets the Gift card box", !off(form().querySelector("#lsGiftWrap")));
  await closeSale(done);
  w.eval(`adminPerms = ${JSON.stringify(Object.assign({}, roles.effectivePermissions(roles.DEFAULT_ROLES.staff), { "orders.payments": "read" }))};`);
  done = await open();
  ok("a role without payments Edit doesn't", off(form().querySelector("#lsGiftWrap")));
  await closeSale(done);
  asRoles("admin");

  // ==============================================================================================================
  console.log("\n=== Reorder from the order window ===");
  const oOld = await sale([{ productId: "mug", size: "", qty: 2 }, { productId: "__custom__", name: "Club Banner", type: "other", size: "", customUnitPrice: 25, qty: 1, taxable: false },
    { productId: "cap", size: "", qty: 1 }], { customerId: 1 });
  d1._raw.exec("UPDATE products SET flatPriceCents = 1200 WHERE productId = 'mug' AND orgId = 'club'");
  await w.refreshAdminOrders("club"); await idle();
  await wait(() => !!q(`#app tr[data-order="${oOld}"]`), 1500);
  const reBtn = (oid) => q(`#app tr[data-order="${oid}"] [data-admin-action="reorderOrder_"]`);
  ok("the order's actions have Reorder (orders.details edit) with its title", !!reBtn(oOld) && reBtn(oOld).dataset.need === "orders.details:edit" && reBtn(oOld).title === "Start a new Local sale with this order's items" && reBtn(oOld).dataset.order === oOld);
  const cellOf = (o) => { const h = d.createElement("div"); h.innerHTML = w.adminActionCell({ orgId: "club", name: "Example Club" }, o); return h; };
  const base = w._ordersCache.club.find(o => o.orderId === oOld);
  ok("an order that sold a gift card has no Reorder", !cellOf(Object.assign({}, base, { items: [{ productId: "__giftcard__", name: "Gift card for Sam", qty: 1 }] })).querySelector('[data-admin-action="reorderOrder_"]'));
  ok("a cancelled order keeps Reorder (its items can be sold again)", !!cellOf(Object.assign({}, base, { items: base.items.map(it => Object.assign({}, it, { cancelDate: "2026-11-01" })) })).querySelector('[data-admin-action="reorderOrder_"]'));
  reset();
  reBtn(oOld).click();
  await wait(() => !!form()); await idle();
  ok("Reorder asks for the order's items (getOrderForReorder) and opens the Local sale", same(of("getOrderForReorder").map(b => b.orderId), [oOld]) && !!form());
  const lines = () => qa("#localSaleForm .ls-line");
  const fld = (line, nm) => line.querySelector(`[data-f="${nm}"]`);
  ok("…with its three lines: 2 Club Mug, the custom Club Banner at $25.00 untaxed, 1 Club Cap", lines().length === 3 &&
    fld(lines()[0], "product").value === "mug" && fld(lines()[0], "qty").value === "2" &&
    fld(lines()[1], "product").value === "__custom__" && fld(lines()[1], "customDesc").value === "Club Banner" && fld(lines()[1], "customUnitPrice").value === "25.00" && fld(lines()[1], "customTaxable").checked === false &&
    fld(lines()[2], "product").value === "cap" && fld(lines()[2], "qty").value === "1");
  const note = form().querySelector("#lsReorderNote");
  ok("the note: “Reordered from <order>. Prices are today's; 1 changed since the original order: Club Mug (was $10.00, now $12.00).”",
    note.style.display !== "none" && text(note) === `Reordered from ${oOld}. Prices are today's; 1 changed since the original order: Club Mug (was $10.00, now $12.00).`);
  ok("…the old order's customer is picked (Pat Example)", /Pat Example/.test(text(form().querySelector("#lsCustomerPickedText"))));
  ok("…and the preview is today's: 2 × $12 + $25 + $15 = $64.00", /\$64\.00/.test(preview()));
  choose(form().querySelector("#lsPayment"), "Cash");
  reset(); await record(null);
  await idle();
  const re1 = of("createLocalSale")[0];
  ok("Record sale sends reorderOf with the sale", !!re1 && re1.reorderOf === oOld && re1.customerId === 1);
  const re1Id = (/Local sale recorded — (\S+)/.exec(lastToast().m) || [])[1];
  ok("…and the new order remembers it (orders.reorderOf)", !!re1Id && q1("SELECT reorderOf FROM orders WHERE orderId = ?", re1Id).reorderOf === oOld);

  d1._raw.exec("UPDATE products SET flatPriceCents = 1000 WHERE productId = 'mug' AND orgId = 'club'");
  const oNoRec = await sale([{ productId: "mug", size: "", qty: 1 }], { customerName: "Kim Example", contact: "kim@example.com", phone: "555-0102" });
  done = { p: w.adminReorderOrder_("club", oNoRec) }; await wait(() => !!form()); await idle();
  ok("nothing changed: “…Prices are today's; none changed since the original order.”", text(form().querySelector("#lsReorderNote")) === `Reordered from ${oNoRec}. Prices are today's; none changed since the original order.`);
  ok("an order with no customer record: its name, email and phone are typed in, Customer info opened",
    form().querySelector("#lsName").value === "Kim Example" && form().querySelector("#lsEmail").value === "kim@example.com" && form().querySelector("#lsPhone").value === "555-0102" && form().querySelector("#lsCustomerInfo").open);
  await closeSale(done);

  scripted = [{ action: "getOrderForReorder", body: { status: "ok", reorder: { orgId: "club", customer: { name: "A <b>B</b>" }, reorderOf: "X<1>",
    lines: [{ productId: "gone", name: "Old <i>Hoodie</i>", qty: 1, priceThen: 30 }, { productId: "gone2", name: "Old Scarf", qty: 1 }, { productId: "mug", name: "Club Mug", qty: 3, priceThen: 10 }] } } }];
  done = { p: w.adminReorderOrder_("club", oNoRec) }; await wait(() => !!form()); await idle();
  const nt = form().querySelector("#lsReorderNote");
  ok("items the shop no longer sells are left out and named: “Left out because the shop doesn't sell them now: …”", lines().length === 1 && fld(lines()[0], "qty").value === "3" &&
    /Left out because the shop doesn't sell them now: Old <i>Hoodie<\/i>, Old Scarf\./.test(text(nt)));
  ok("…and what the server sends is shown as text, never as markup", !nt.querySelector("i") && /Reordered from X<1>\./.test(text(nt)));
  await closeSale(done);
  scripted = [{ action: "getOrderForReorder", body: { status: "ok", lines: [{ productId: "gone", qty: 1 }] } }];
  done = { p: w.adminReorderOrder_("club", oNoRec) }; await wait(() => !!form()); await idle();
  ok("one item gone: “…doesn't sell it now: gone.” and “Reordered from <the order asked>”", /Left out because the shop doesn't sell it now: gone\./.test(text(form().querySelector("#lsReorderNote"))) && text(form().querySelector("#lsReorderNote")).startsWith(`Reordered from ${oNoRec}.`));
  await closeSale(done);
  reset();
  scripted = [{ action: "getOrderForReorder", status: 404, body: { status: "error", message: "Order not found" } }];
  await w.adminReorderOrder_("club", oNoRec); await idle();
  ok("an order the server can't find: toast “Couldn't load that order to reorder it: Order not found”, no window", lastToast().m === "Couldn't load that order to reorder it: Order not found" && lastToast().err && !form());
  scripted = [{ action: "getOrderForReorder", body: { status: "ok" } }];
  await w.adminReorderOrder_("club", oNoRec); await idle();
  ok("an answer with no lines: “…: Nothing to reorder.”", lastToast().m === "Couldn't load that order to reorder it: Nothing to reorder." && !form());
  reset();
  await w.adminReorderOrder_("", oNoRec); await w.adminReorderOrder_("club", ""); await idle();
  ok("no shop or no order: nothing happens", sent.length === 0 && toasts.length === 0);
  asRoles("production");
  await w.adminReorderOrder_("club", oNoRec); await idle();
  ok("a role that can't record a sale (Production): “Your role can't record a sale.”, nothing asked", lastToast().m === "Your role can't record a sale." && lastToast().err && of("getOrderForReorder").length === 0);
  ok("…and the order's actions have no Reorder for it", !cellOf(base).querySelector('[data-admin-action="reorderOrder_"]'));
  asRoles("admin");
  const r1 = await call({ action: "createLocalSale", org: "club", requestId: "bad395-reorder-1", customerName: "X", paymentMethod: "Cash", items: [{ productId: "mug", size: "", qty: 1 }], reorderOf: "NOPE-1" });
  ok("(the server refuses a reorderOf that isn't one of this shop's orders)", r1.status === 400 && r1.body.message === "That order can't be copied.");

  // ==============================================================================================================
  console.log("\n=== Reorder from the customer page ===");
  const oVoid = await sale([{ productId: "cap", size: "", qty: 1 }], { customerId: 1 });
  await must({ action: "voidOrder", orderId: oVoid, reason: "Entered twice" }).catch(() => must({ action: "deleteTransaction", orderId: oVoid, reason: "Entered twice" }));
  w.location.hash = "#customers/1";
  await wait(() => qa("#app [data-cust-reorder]").length > 0, 1500); await idle();
  const custBtns = () => qa("#app [data-cust-reorder]");
  const rowOf = (b) => b.closest("tr");
  ok("each past order has Reorder in its Status cell (orders.details edit), with its title", custBtns().length >= 3 && custBtns().every(b => b.dataset.need === "orders.details:edit" && b.title === "Start a new Local sale with this order's items"));
  ok("…but not a voided one", qa("#app tr").filter(tr => /Voided/.test(text(tr))).length === 1 && qa("#app tr").filter(tr => /Voided/.test(text(tr))).every(tr => !tr.querySelector("[data-cust-reorder]")));
  const target = custBtns().find(b => text(rowOf(b)).includes(oOld));
  reset(); toasts.length = 0;
  target.click();
  await wait(() => !!form()); await idle();
  ok("Reorder there opens the Local sale for that order, with the customer of the page picked", same(of("getOrderForReorder").map(b => b.orderId), [oOld]) && /Pat Example/.test(text(form().querySelector("#lsCustomerPickedText"))) && lines().length === 3);
  choose(form().querySelector("#lsPayment"), "Cash");
  const before = sent.length;
  form().querySelector(".admin-pass-submit").click();
  await wait(() => !form()); await idle();
  ok("Record sale: sent with reorderOf, and the customer page is drawn again (its orders asked for again)", of("createLocalSale")[0].reorderOf === oOld && sent.slice(before).some(b => b.action === "getCustomer"));
  d1._raw.exec("UPDATE customers SET archivedAt = '2026-11-01T00:00:00Z' WHERE id = 1");
  w.location.hash = "#customers/2"; await idle(); w.location.hash = "#customers/1";
  await wait(() => /Pat Example/.test(text(app)), 1500); await idle();
  ok("an archived customer's orders have no Reorder", custBtns().length === 0 && qa("#app tbody tr").length > 0);
  d1._raw.exec("UPDATE customers SET archivedAt = NULL WHERE id = 1");
  asRoles("production");
  w.location.hash = "#customers/2"; await idle(); w.location.hash = "#customers/1";
  await wait(() => /Pat Example/.test(text(app)), 1500); await idle();
  ok("a role that can't record a sale (Production) sees no Reorder there", custBtns().length === 0 && qa("#app tbody tr").length > 0);
  asRoles("admin");

  // ==============================================================================================================
  console.log("\n=== Receipts and order emails (email.js) ===");
  const rows = (o) => L.receiptLines_(o).rows.map(r => r.label + " " + r.value);
  const baseO = { orderId: "CLUB-9", customerName: "Pat Example", contact: "pat@example.com", items: [{ name: "Club Mug", qty: 4, lineTotal: 40, unitPrice: 10 }], subtotal: 40 };
  ok("each code its own line when the order says what each took off: “Discount (SAVE10) −$4.00”, “Discount (TEAM5) −$5.00”",
    (r => r.includes("Discount (SAVE10) −$4.00") && r.includes("Discount (TEAM5) −$5.00") && !r.some(x => /^Discount \(SAVE10, TEAM5\)/.test(x)))(rows({ ...baseO, discountAmount: 9, discountCodes: [{ code: "SAVE10", amount: 4 }, { code: "TEAM5", amount: 5 }] })));
  ok("…amounts that don't add up to the discount: one line naming both", (r => r.includes("Discount (SAVE10, TEAM5) −$9.00"))(rows({ ...baseO, discountAmount: 9, discountCodes: [{ code: "SAVE10", amount: 4 }, { code: "TEAM5", amount: 4 }] })));
  ok("the codes as the order readers give them (names): “Discount (SAVE10, TEAM5)”, the note “Codes SAVE10, TEAM5” not repeated",
    (r => r.includes("Discount (SAVE10, TEAM5) −$9.00"))(rows({ ...baseO, discountAmount: 9, discountNote: "Codes SAVE10, TEAM5", discountCodes: ["SAVE10", "TEAM5"], discountCode: "SAVE10, TEAM5" })));
  ok("…with the owner's own words after the codes kept: “Discount (SAVE10, TEAM5; Loyal customer)”",
    (r => r.includes("Discount (SAVE10, TEAM5; Loyal customer) −$9.00"))(rows({ ...baseO, discountAmount: 9, discountNote: "Codes SAVE10, TEAM5; Loyal customer", discountCode: "SAVE10, TEAM5" })));
  const shipO = { ...baseO, shippingCost: 8, shippingMethod: "USPS Ground Advantage", shippingDiscount: 8 };
  ok("free shipping from a code that says so: “Free shipping (SHIPFREE) −$8.00”, and the total without it ($40.00)",
    (r => r.includes("Free shipping (SHIPFREE) −$8.00") && r.some(x => /^Total \$40\.00/.test(x)))(rows({ ...shipO, discountCodes: [{ code: "SHIPFREE", freeShipping: true }] })));
  ok("…with plain code names it can't tell which, so just “Free shipping −$8.00”", (r => r.includes("Free shipping −$8.00"))(rows({ ...shipO, discountCodes: ["SAVE10", "SHIPFREE"] })));
  ok("…in cents too, never more than the shipping", (r => r.includes("Free shipping −$8.00"))(rows({ ...baseO, shippingCost: 8, shippingDiscountCents: 5000 })));
  const gp = (ref, amt, extra) => ({ amount: amt, reference: ref, kind: "payment", method: "other", ...(extra || {}) });
  let m = await L.buildPaymentReceivedEmail({}, { ...baseO, total: 40, effectiveTotal: 40, amountReceived: 25, balanceDue: 15, paymentMethod: "Cash",
    payments: [gp("Gift card ••W5TX", 20), gp("", 5, { method: "cash" }), gp("Gift card ••AAAA", 7, { voidedAt: "2026-11-02" }), gp("Gift card ••BBBB", -3, { kind: "refund" })] }, "2026-11-03T00:00:00Z", { pdf: false });
  ok("a payment email: “Paid by gift card ••W5TX −$20.00”, then “Paid −$5.00” for the rest; voided and refund rows aren't listed",
    m.text.includes("Paid by gift card ••W5TX") && m.text.includes("\nPaid by gift card ••W5TX: −$20.00\nPaid: −$5.00\n") && !/AAAA|BBBB/.test(m.text) && m.html.includes("Paid by gift card ••W5TX"));
  m = await L.buildPaymentReceivedEmail({}, { ...baseO, total: 40, effectiveTotal: 40, amountReceived: 40, balanceDue: 0, payments: [gp("Gift card ••W5TX", 40)] }, "2026-11-03T00:00:00Z", { pdf: false });
  ok("all of it by gift card: no plain “Paid” line", m.text.includes("\nPaid by gift card ••W5TX: −$40.00\nBalance due: $0.00") && !m.text.includes("\nPaid:"));
  m = await L.buildPaymentReceivedEmail({}, { ...baseO, total: 40, effectiveTotal: 40, amountReceived: 10, balanceDue: 30, payments: [gp("", 10, { giftCardId: 3 })] }, "2026-11-03T00:00:00Z", { pdf: false });
  ok("a gift-card payment known by its card id only: “Paid by gift card”", m.text.includes("\nPaid by gift card: −$10.00\n") && !m.text.includes("\nPaid:"));
  const gcOrder = (extra) => ({ ...baseO, items: [{ productId: "__giftcard__", name: "Gift card for Sam", qty: 1, lineTotal: 50, configJson: JSON.stringify({ giftCard: { recipientName: "Sam Example", recipientEmail: "sam@example.com" } }) }], subtotal: 50, total: 50, ...(extra || {}) });
  m = await L.buildOrderReceivedEmail({}, gcOrder({ paid: true, amountReceived: 50, balanceDue: 0 }), { pdf: false });
  ok("a gift card order, paid: “Your gift card is on its way to Sam Example (sam@example.com) by email. It never expires.” in the text and the HTML",
    m.text.includes("Your gift card is on its way to Sam Example (sam@example.com) by email. It never expires.") && m.html.includes("Your gift card is on its way to Sam Example (sam@example.com) by email."));
  m = await L.buildOrderReceivedEmail({}, gcOrder({ paid: false, balanceDue: 50, items: [{ productId: "__giftcard__", name: "Gift card", qty: 1, lineTotal: 50, config: { giftCard: { recipientEmail: "sam@example.com" } } }] }), { pdf: false });
  ok("…not paid yet, only an email known: “Once this is paid, your gift card is emailed to sam@example.com.”", m.text.includes("Once this is paid, your gift card is emailed to sam@example.com. It never expires."));
  m = await L.buildPaymentReceivedEmail({}, gcOrder({ paid: true, amountReceived: 50, balanceDue: 0, items: [{ productId: "__giftcard__", name: "Gift card", qty: 1, lineTotal: 50, configJson: "{not json" }] }), "2026-11-03T00:00:00Z", { pdf: false });
  ok("…nothing readable about the recipient: “…on its way to the person you chose…”, in the payment email too", m.text.includes("Your gift card is on its way to the person you chose by email."));
  m = await L.buildOrderReceivedEmail({}, gcOrder({ items: [{ productId: "__giftcard__", name: "Gift card", qty: 1, lineTotal: 50, cancelDate: "2026-11-01" }, { productId: "mug", name: "Club Mug", qty: 1, lineTotal: 10 }] }), { pdf: false });
  ok("an order with no live gift card line says nothing about one", !/gift card/i.test(m.text.replace(/Gift card — cancelled|Gift card/g, "")) && !m.text.includes("never expires"));
  // A real order from the database, as the server would email it.
  await rule(true);
  const realO = await L.getOrderById(d1, oCodes);
  await call({ action: "applyOrderDiscountCode", orderId: oCodes, code: "SAVE10" });
  await call({ action: "applyOrderDiscountCode", orderId: oCodes, code: "TEAM5" });
  await call({ action: "redeemGiftCard", orderId: oCodes, code: g30.code, amount: 6, requestId: "rq395-real-1" });
  const realO2 = await L.getOrderById(d1, oCodes);
  m = await L.buildPaymentReceivedEmail({}, realO2, realO2.paidAt || "2026-11-03T00:00:00Z", { pdf: false });
  ok("a real order with two codes and a gift card: “Discount (SAVE10, TEAM5) −$9.00” and “Paid by gift card ••" + "XXXX −$6.00”",
    !!realO && m.text.includes("\nDiscount (SAVE10, TEAM5): −$9.00\n") && m.text.includes("\nPaid by gift card ••" + g30.last4 + ": −$6.00\n"));

  console.log("\n=== The morning roll-up: Gift cards sold ===");
  mail.length = 0;
  const notice = (kind, summary, i) => ({ kind, orderId: "CLUB-GC-" + i, orgId: "club", summary, createdAt: "2026-11-03T0" + i + ":00:00Z" });
  await L.sendDailyDigestEmail({}, { notices: [notice("gift_card", "Gift card $50.00 for Sam — order CLUB-GC-1", 1), notice("gift_card", "Gift card $25.00 for Lee — order CLUB-GC-2", 2), notice("payment", "Payment $10.00", 3)], orgNames: { club: "Example Club" } });
  let dg = mail.pop();
  ok("two sold: the subject says “2 gift cards sold”", !!dg && /2 gift cards sold/.test(dg.subject));
  ok("…the payments section starts with “🎁 Gift cards sold: 2” (HTML) and “  Gift cards sold: 2” (text)", dg.html.includes("🎁 Gift cards sold: 2") && dg.text.includes("Payments, refunds & customer responses\n  Gift cards sold: 2\n"));
  ok("…and each sale is a “Gift card” row with its summary", (dg.html.match(/>Gift card</g) || []).length === 2 && dg.text.includes("Gift card  CLUB-GC-1 (Example Club)  Gift card $50.00 for Sam — order CLUB-GC-1"));
  await L.sendDailyDigestEmail({}, { notices: [notice("gift_card", "Gift card $50.00 for Sam — order CLUB-GC-1", 1)], orgNames: { club: "Example Club" } });
  dg = mail.pop();
  ok("one sold: “1 gift card sold” and “Gift cards sold: 1”", /1 gift card sold(?!s)/.test(dg.subject) && dg.html.includes("Gift cards sold: 1"));
  await L.sendDailyDigestEmail({}, { notices: [notice("payment", "Payment $10.00", 3)], orgNames: { club: "Example Club" } });
  dg = mail.pop();
  ok("none sold: no Gift cards line", !/gift card/i.test(dg.subject) && !dg.html.includes("Gift cards sold") && !dg.text.includes("Gift cards sold"));

  finished = true;
  w.close();
})().catch((e) => { console.error(e); ok("the test ran without an exception", false); finished = true; process.exit(1); });
