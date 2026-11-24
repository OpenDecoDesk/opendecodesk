const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// The Orders screen's single- and bulk-order actions, RUN in the real admin page (jsdom) against the real orders.js /
// db.js on sql.js — not matched as source text. The coverage review (2026-11-23) found these admin.js functions run by
// neither the unit nor the end-to-end suite, or with the lines review #52/#55/#58 changed never run:
//   shipOrder — a declined label purchase reloads nothing (58.16), the one the row didn't know asks for that order,
//     a purchase on purpose replaces it; bulkCancelLineItems; cancelLineItem; setLineItemRefund; refreshLineRows_ and
//     orderOfLine_; bulkAddTracking; bulkSetDueDate; bulkEditCustomerInfo; blankShippedFlow_ and showBlankShippedModal;
//     showShipmentHistoryModal_; showRushFeeModal_; createLocalSale / createLocalSaleOnce_; and the Payments window's
//     refund handlers (Record refund, Shipping part…, Apply discount) with whileSaving_.
// Each checks what reached the server and the database, what the admin is told, and that only the orders the action
// changed are asked for again (getOrdersByIds) — or, where the page already knows the change, nothing at all.
// Shippo (/api/shippo-label) is a scripted stand-in; everything on /api/orders is the real endpoint. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, createProduct };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'olive@example.test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const sendCancellationEmail = async (env, order, items) => { (globalThis.__cancelEmails = globalThis.__cancelEmails || []).push(order.orderId + ':' + items.length); return true; };\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = async (cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setTimeout(r, 10)); return cond(); };
const pause = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Club tee", pricingMode: "sized", sizePricing: { M: 18, L: 18 }, visible: true, noDesignNeeded: true });
  const hoursAgo = (n) => new Date(Date.now() - n * 3600000).toISOString();
  const mk = (orderId, n, lines, extra = {}) => lib.insertOrder(d1, Object.assign({ orderId, orgId: "acme", customerName: "Customer " + orderId, contact: orderId.toLowerCase() + "@example.test",
    paymentMethod: "Venmo", placedAt: hoursAgo(n), shippingAddress: { name: "Customer " + orderId, line1: n + " Elm St", city: "Springfield", state: "IL", zip: "62701", phone: "555-0100" } }, extra), lines);
  const cap = (qty = 1) => ({ productId: "cap", name: "Club cap", type: "cap", size: "OSFA", qty, unitPrice: 20 });
  const tee = (size) => ({ productId: "tee", name: "Club tee", type: "shirt", size, qty: 1, unitPrice: 18 });
  await mk("SHIP1", 1, [cap()]); await mk("SHIP2", 2, [cap()]); await mk("SHIP3", 3, [cap()]);
  await mk("CAN1", 4, [cap(), tee("M")]);                    // one line cancelled, then refunded
  await mk("BULK1", 5, [cap(), tee("L")]); await mk("BULK2", 6, [cap()]);   // bulk cancel
  await mk("TRK1", 7, [cap()]); await mk("TRK2", 8, [cap()]);               // tracking, due date, customer info
  await mk("BLK1", 9, [cap(), tee("M")]);                    // blank shipments
  await mk("RUSH1", 10, [cap(2)]);                            // rush fee
  await mk("PAY1", 11, [cap(), tee("M")]);                   // the Payments window
  for (const id of ["SHIP1", "SHIP2", "SHIP3", "CAN1", "PAY1"]) {
    const r = await call({ action: "markPaidManual", org: "acme", orderId: id, requestId: "seed-" + id });
    if (r.status !== 200) throw new Error("could not mark " + id + " paid: " + JSON.stringify(r.body));
  }
  // SHIP1 already has a label the list knows about; SHIP2's was bought from another tab after the list loaded.
  const label = (orderId, tx) => d1._raw.run("INSERT INTO shipping_labels (orderId, shippoTransactionId, carrier, service, amountCents, trackingNumber, labelUrl, purchasedAt) VALUES (?, ?, 'USPS', 'Ground Advantage', 520, ?, '', ?)",
    [orderId, tx, "9400" + tx, hoursAgo(1)]);
  label("SHIP1", "1000000001");

  // ---- The page ------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js");
  const sent = [], shippo = [], toasts = [], opened = [];
  let hold = null, refuseNext = null, answerFor = () => true, inflight = 0;
  const questions = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  const RATE = { provider: "USPS", service: "Ground Advantage", amount: 5.2, currency: "USD", carrierId: "carrier_usps", serviceToken: "usps_ground_advantage", estimatedDays: 3 };
  let purchaseAnswers = [];
  class Loader extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), url: "https://admin.example.com/#orders/acme", pretendToBeVisual: true,
    beforeParse(win) {
      autoConfirm(win, (msg) => { const ov = [...win.document.querySelectorAll(".confirm-modal")].pop();
        questions.push({ msg, ok: ov && ov.querySelector("#cmOk").textContent, cancel: ov && ov.querySelector("#cmCancel").textContent }); return answerFor(msg); });
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.open = (u) => { opened.push(u); return null; };
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (u.includes("/api/shippo-label")) {
          shippo.push(b);
          if (b.action === "rates") return reply(200, { status: "ok", rates: [RATE], parcel: { length: "10", width: "8", height: "4" }, weightOz: 8,
            fromAddress: { name: "Example Club", street1: "1 Shop Way", city: "Springfield", state: "IL", zip: "62701" }, toAddress: { name: "A customer", street1: "2 Elm St", city: "Springfield", state: "IL", zip: "62702" } });
          return reply(200, purchaseAnswers.shift());
        }
        if (u.includes("/api/orders")) {
          sent.push(b); inflight++;
          try {
            if (hold && hold.action === b.action) await hold.gate;
            if (refuseNext && refuseNext.action === b.action) { const r = refuseNext; refuseNext = null; return reply(r.status, r.body); }
            const x = await call(b);
            return reply(x.status, x.body);
          } finally { inflight--; }
        }
        return reply(404, { status: "error", message: "not here" });
      };
    } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Example Club" }];');
  const app = d.getElementById("app"), org = { orgId: "acme", name: "Example Club" };
  await w.renderAdminOrders(app, org);
  await wait(() => d.getElementById("ordSummaryBar") && d.querySelector('tr[data-order="PAY1"]'));
  const cached = (id) => w._ordersCache.acme.find(o => o.orderId === id);
  const row = (id) => d.querySelector(`#adminPanel tbody tr[data-order="${id}"]`);
  const actions = () => sent.map(b => b.action);
  // Every request answered and the page done with the answers (what an action does after its request is in the same
  // task as the answer, or the next few).
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 400; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const LIST_READS = ["getOrders", "getOrdersAllShops", "listDesignVerifications", "getBlankLinks"];
  const listReads = () => sent.filter(b => LIST_READS.includes(b.action)).length;
  const lastToast = () => (toasts[toasts.length - 1] || { m: "" });
  const reset = () => { sent.length = 0; shippo.length = 0; toasts.length = 0; };
  const tick = (ids) => { d.querySelectorAll(".order-select").forEach(cb => { cb.checked = ids.includes(cb.dataset.order); }); };
  const overlay = (sel) => d.querySelector(sel);
  // The confirm window opened by confirmModal_ itself (no question text for autoConfirm to answer): fill and press.
  const answerConfirm = async (yes, reason) => {
    await wait(() => d.querySelector(".confirm-modal:not([data-answered]) #cmOk"));
    const ov = d.querySelector(".confirm-modal:not([data-answered])"); ov.dataset.answered = "1";
    if (reason != null && ov.querySelector("#cmReason")) ov.querySelector("#cmReason").value = reason;
    ov.querySelector(yes ? "#cmOk" : "#cmCancel").click();
  };
  const itemsOf = (id) => d1.q("SELECT id, name, size, cancelDate, refundCents FROM order_items WHERE orderId=? ORDER BY id", id);
  ok("(the list is loaded: 11 orders, every one drawn)", w._ordersCache.acme.length === 11 && !!row("SHIP1") && !!row("BLK1"));

  console.log("=== shipOrder: a declined label purchase (58.16) ===");
  // SHIP1: the server says a label already exists (bought before); the row knows it. Don't buy → nothing reloads.
  reset(); questions.length = 0;
  answerFor = (msg) => !/buy another label anyway/.test(msg);
  purchaseAnswers = [{ status: "error", code: "label_exists", message: "This order already has a label (94001000000001)." }];
  const ship1Row = row("SHIP1");
  let shipping = w.shipOrder("acme", "SHIP1");
  await wait(() => overlay("#shipRateForm"));
  ok("Ship asks Shippo for rates and shows them in the Purchase label window", shippo.length === 1 && shippo[0].action === "rates" && shippo[0].orderId === "SHIP1" &&
    /USPS Ground Advantage/.test(overlay("#shipRateForm").textContent) && /\$5\.20/.test(overlay("#shipRateForm").textContent));
  overlay("#shipRateForm .admin-pass-submit").click();
  await shipping;
  ok("…Purchase label: the server says a label exists, and the page asks — Buy another label / Don't buy",
    shippo.length === 2 && shippo[1].action === "purchase" && !shippo[1].replaceExisting && shippo[1].serviceToken === "usps_ground_advantage" &&
    questions.length === 1 && /already has a label/.test(questions[0].msg) && /buy another label anyway/.test(questions[0].msg) && questions[0].ok === "Buy another label" && questions[0].cancel === "Don't buy");
  ok("Don't buy: no second purchase, and nothing sent to /api/orders — no tracking, no reload of the order or the list",
    shippo.length === 2 && sent.length === 0);
  ok("…the admin is told no label was bought and where the existing one is", /No label bought\. The order's Label button opens the one it already has\./.test(lastToast().m) && !lastToast().err);
  await idle();
  ok("…and SHIP1's row is the same element as before (not redrawn)", !!ship1Row && row("SHIP1") === ship1Row && sent.length === 0);

  // SHIP2: its label was bought from another tab after this list loaded — declining asks for that order alone.
  label("SHIP2", "1000000002");
  reset();
  purchaseAnswers = [{ status: "error", code: "label_exists", message: "This order already has a label (94001000000002)." }];
  const ship2Row = row("SHIP2");
  shipping = w.shipOrder("acme", "SHIP2");
  await wait(() => overlay("#shipRateForm"));
  overlay("#shipRateForm .admin-pass-submit").click();
  await shipping;
  await wait(() => sent.length >= 1 && row("SHIP2") !== ship2Row);
  ok("declined, but the row didn't know that label: only that order is asked for again (getOrdersByIds), no list reload",
    JSON.stringify(actions()) === '["getOrdersByIds"]' && JSON.stringify(sent[0].orderIds) === '["SHIP2"]' && listReads() === 0 && shippo.length === 2);
  ok("…its row now has the label (the Label button's reprint), and the loaded list knows it", (cached("SHIP2").labels || []).some(l => !l.voidedAt) &&
    /reprintLabel/.test(row("SHIP2").innerHTML));

  // SHIP3: the same question, answered Buy another label → bought with replaceExisting, tracking recorded, that order redrawn.
  reset();
  purchaseAnswers = [{ status: "error", code: "label_exists", message: "This order already has a label (94001000000003)." },
    { status: "ok", trackingNumber: "9400111100000003", labelUrl: "https://labels.example.test/ship3.pdf" }];
  shipping = w.shipOrder("acme", "SHIP3");
  await wait(() => overlay("#shipRateForm"));
  answerFor = () => true;
  overlay("#shipRateForm .admin-pass-submit").click();
  await shipping;
  await wait(() => actions().includes("getOrdersByIds")); await idle();
  ok("Buy another label: bought again on purpose (replaceExisting), the label opened", shippo.length === 3 && shippo[2].replaceExisting === true && opened.includes("https://labels.example.test/ship3.pdf"));
  ok("…its tracking number recorded on the order, and only that order asked for again", JSON.stringify(actions()) === '["recordTracking","getOrdersByIds"]' &&
    d1.q("SELECT trackingNumber FROM orders WHERE orderId='SHIP3'")[0].trackingNumber === "9400111100000003" && listReads() === 0);
  ok("…\"Label purchased\" with the tracking number", toasts.some(t => /Label purchased\. Tracking: 9400111100000003/.test(t.m)));
  // Cancel in the rates window: no purchase at all.
  reset();
  shipping = w.shipOrder("acme", "SHIP1");
  await wait(() => overlay("#shipRateForm"));
  overlay("#shipRateForm .admin-pass-cancel").click();
  await shipping;
  ok("Cancel in the Purchase label window buys nothing and sends nothing else", shippo.length === 1 && sent.length === 0 && !overlay("#shipRateForm"));

  console.log("\n=== cancelLineItem, setLineItemRefund (refreshLineRows_, orderOfLine_) ===");
  const can1 = cached("CAN1"), teeLine = can1.items.find(it => it.name === "Club tee");
  ok("(orderOfLine_ finds a line's order from the loaded lists, with or without the shop)", JSON.stringify(w.orderOfLine_(teeLine.sheetRow, "acme")) === '{"orgId":"acme","orderId":"CAN1"}' &&
    JSON.stringify(w.orderOfLine_(String(teeLine.sheetRow))) === '{"orgId":"acme","orderId":"CAN1"}' && w.orderOfLine_(987654) === null);
  reset(); globalThis.__cancelEmails = [];
  let acting = w.cancelLineItem("acme", teeLine.sheetRow, "Club tee (M)", 18);
  await answerConfirm(false);
  await acting;
  ok("Cancel item, answered Keep it: nothing is sent", sent.length === 0 && !itemsOf("CAN1")[1].cancelDate);
  acting = w.cancelLineItem("acme", teeLine.sheetRow, "Club tee (M)", 18);
  await answerConfirm(true, "Ordered twice");
  await acting;
  await wait(() => actions().includes("getOrdersByIds")); await idle();
  ok("Cancel item: that line is cancelled with its reason, the customer emailed", sent[0].action === "cancelLineItem" && sent[0].sheetRow === Number(teeLine.sheetRow) &&
    sent[0].reason === "Ordered twice" && !!sent[0].at && !!itemsOf("CAN1")[1].cancelDate && !itemsOf("CAN1")[0].cancelDate && globalThis.__cancelEmails.join() === "CAN1:1");
  ok("…\"Item canceled. Customer notified by email.\", and only CAN1 is asked for again", /^Item canceled\. Customer notified by email\.$/.test(lastToast().m) &&
    JSON.stringify(actions()) === '["cancelLineItem","getOrdersByIds"]' && JSON.stringify(sent[1].orderIds) === '["CAN1"]' && listReads() === 0);
  ok("…its row shows the line cancelled", !!cached("CAN1").items.find(it => it.sheetRow === teeLine.sheetRow).cancelDate);
  reset();
  acting = w.cancelLineItem("acme", teeLine.sheetRow, "Club tee (M)", 18);
  await answerConfirm(true, "");
  await acting;
  ok("cancelling it again: \"already canceled — nothing changed and no email was sent\"", /already canceled — nothing changed and no email was sent/.test(lastToast().m) && globalThis.__cancelEmails.length === 1);

  reset();
  acting = w.setLineItemRefund("acme", teeLine.sheetRow, 18, "Venmo");
  await wait(() => d.getElementById("lrOk"));
  ok("Record refund opens on how the order was paid (Venmo) and the line's amount", d.getElementById("lrMethod").value === "venmo" && d.getElementById("lrAmount").value === "18.00" &&
    d.getElementById("lrOk").textContent === "Record refund" && /Send the money back first \(Venmo\)/.test(d.getElementById("lrNote").textContent));
  d.getElementById("lrMethod").value = "card"; d.getElementById("lrMethod").onchange();
  ok("…switching to card says it's refunded in Stripe and only noted on the line", d.getElementById("lrOk").textContent === "Note refund on line" && /Stripe Dashboard first/.test(d.getElementById("lrNote").textContent));
  d.getElementById("lrMethod").value = "venmo"; d.getElementById("lrMethod").onchange();
  d.getElementById("lrAmount").value = "-3"; d.getElementById("lrOk").click();
  ok("…a negative amount is refused in the window, nothing sent", /Invalid amount/.test(lastToast().m) && sent.length === 0 && !!d.getElementById("lrOk"));
  d.getElementById("lrAmount").value = "18"; d.getElementById("lrOk").click();
  await acting;
  await wait(() => actions().includes("getOrdersByIds")); await idle();
  const refunds = d1.q("SELECT amountCents, method, kind FROM order_payments WHERE orderId='CAN1' AND kind='refund'");
  ok("Record refund (Venmo, $18): the line's refund is set and the money is in Payments as a refund", sent[0].action === "setLineItemRefund" && sent[0].method === "venmo" && sent[0].refundAmount === 18 &&
    itemsOf("CAN1")[1].refundCents === 1800 && refunds.length === 1 && refunds[0].amountCents === -1800);
  ok("…\"Refund of $18.00 recorded — it's in 💰 Payments.\", and CAN1 alone is asked for again", /^Refund of \$18\.00 recorded — it's in 💰 Payments\.$/.test(lastToast().m) &&
    JSON.stringify(actions()) === '["setLineItemRefund","getOrdersByIds"]' && listReads() === 0);
  reset();
  await w.refreshLineRows_("acme", 987654);
  ok("a line the page hasn't loaded: refreshLineRows_ reloads the shop's list instead", actions().includes("getOrders") && !actions().includes("getOrdersByIds"));
  await wait(() => !!row("CAN1"));

  console.log("\n=== bulkCancelLineItems ===");
  reset(); globalThis.__cancelEmails = [];
  tick([]);
  await w.bulkCancelLineItems("acme");
  ok("nothing ticked: \"No orders selected.\"", /No orders selected/.test(lastToast().m) && lastToast().err && sent.length === 0);
  tick(["BULK1", "BULK2"]);
  acting = w.bulkCancelLineItems("acme");
  await wait(() => d.querySelector(".confirm-modal #cmOk"));
  ok("two orders ticked: it asks to cancel 3 items across 2 orders", /Cancel 3 items\?/.test(d.querySelector(".confirm-modal").textContent) && /Across 2 orders/.test(d.querySelector(".confirm-modal").textContent));
  await answerConfirm(true, "Event cancelled");
  await acting;
  await wait(() => actions().includes("getOrdersByIds")); await idle();
  ok("…all three lines are cancelled, in one request, with the reason; each customer emailed once", sent[0].action === "bulkCancelLineItems" && sent[0].sheetRows.length === 3 && sent[0].reason === "Event cancelled" &&
    [...itemsOf("BULK1"), ...itemsOf("BULK2")].every(it => !!it.cancelDate) && globalThis.__cancelEmails.sort().join() === "BULK1:2,BULK2:1");
  ok("…\"Cancelled 3 items.\" (the count the server gives), and only those two orders are asked for again", lastToast().m === "Cancelled 3 items." && !lastToast().err &&
    JSON.stringify(actions()) === '["bulkCancelLineItems","getOrdersByIds"]' && JSON.stringify(sent[1].orderIds.slice().sort()) === '["BULK1","BULK2"]' && listReads() === 0);
  reset();
  ok("…BULK1 and BULK2, every line cancelled, leave the default list (cancelled orders are hidden)", !row("BULK1") && !row("BULK2") && !!row("CAN1"));
  d.getElementById("ordIncludeCancelled").click();
  await wait(() => row("BULK1"));
  ok("…Include cancelled shows them, with no tick box (nothing left on them to act on)", !!row("BULK1") && !row("BULK1").querySelector(".order-select"));
  d.getElementById("ordIncludeCancelled").click();
  await wait(() => !row("BULK1"));
  // Blanks already ordered for BLK1: its lines can't be cancelled from here.
  d1._raw.run("UPDATE orders SET blankOrderedAt = ? WHERE orderId = 'BLK1'", [hoursAgo(3)]);
  await w.refreshOrderRows_("acme", ["BLK1"]);
  await idle();
  reset();
  tick(["BLK1"]);
  await w.bulkCancelLineItems("acme");
  ok("an order whose blanks are already ordered: nothing cancellable, nothing sent", /No cancellable items in selection \(blank already ordered/.test(lastToast().m) && sent.length === 0);
  reset();
  tick(["TRK1"]);
  refuseNext = { action: "bulkCancelLineItems", status: 409, body: { status: "error", message: "March is closed" } };
  acting = w.bulkCancelLineItems("acme");
  await answerConfirm(true, "");
  await acting;
  ok("the server refusing: \"Bulk cancel failed: …\", nothing redrawn", /^Bulk cancel failed: March is closed$/.test(lastToast().m) && lastToast().err && !actions().includes("getOrdersByIds") &&
    !itemsOf("TRK1")[0].cancelDate);

  console.log("\n=== bulkAddTracking, bulkSetDueDate, bulkEditCustomerInfo ===");
  reset();
  tick(["TRK1", "TRK2"]);
  acting = w.bulkAddTracking("acme");
  await wait(() => d.querySelector(".tracking-input"));
  d.querySelector(".tracking-input").closest("form").querySelector(".admin-pass-submit").click();
  ok("Add tracking with no number: the window asks for one, nothing sent", /Enter a tracking number/.test(d.querySelector(".tracking-err").textContent) && sent.length === 0);
  d.querySelector(".tracking-input").value = "1Z999AA10123456784";
  d.querySelector(".tracking-input").closest("form").querySelector(".admin-pass-submit").click();
  await acting;
  await wait(() => actions().includes("getOrdersByIds")); await idle();
  ok("…saved on both orders in one request", sent[0].action === "bulkRecordTracking" && JSON.stringify(sent[0].orderIds) === '["TRK1","TRK2"]' &&
    d1.q("SELECT trackingNumber FROM orders WHERE orderId IN ('TRK1','TRK2')").every(r => r.trackingNumber === "1Z999AA10123456784"));
  ok("…\"Tracking saved for 2 orders.\", and those two asked for again, no list reload", lastToast().m === "Tracking saved for 2 orders." && JSON.stringify(actions()) === '["bulkRecordTracking","getOrdersByIds"]' && listReads() === 0);

  reset();
  tick(["TRK1", "TRK2"]);
  const trk2Row = row("TRK2");
  acting = w.bulkSetDueDate("acme");
  await wait(() => d.getElementById("bulkDueInput"));
  d.getElementById("bulkDueInput").closest("form").querySelector(".admin-pass-submit").click();
  ok("Due date with no date picked: \"Pick a date, or use Clear.\"", /Pick a date, or use Clear/.test(d.getElementById("bulkDueErr").textContent) && sent.length === 0);
  d.getElementById("bulkDueInput").value = "2031-05-06";
  d.getElementById("bulkDueInput").closest("form").querySelector(".admin-pass-submit").click();
  await acting;
  await wait(() => row("TRK2") !== trk2Row);
  ok("…set on both orders", JSON.stringify(actions()) === '["bulkSetDueDate"]' && d1.q("SELECT dueDate FROM orders WHERE orderId IN ('TRK1','TRK2')").every(r => r.dueDate === "2031-05-06"));
  ok("…\"Due date set for 2 orders.\", and the rows drawn with it from what the page knows — no request at all", lastToast().m === "Due date set for 2 orders." && sent.length === 1 &&
    cached("TRK1").dueDate === "2031-05-06" && row("TRK2") !== trk2Row);
  reset();
  tick(["TRK2"]);
  acting = w.bulkSetDueDate("acme");
  await wait(() => d.getElementById("bulkDueClear"));
  d.getElementById("bulkDueClear").click();
  await acting;
  ok("Clear removes it from the ticked order only", lastToast().m === "Due date cleared on 1 order." && !d1.q("SELECT dueDate FROM orders WHERE orderId='TRK2'")[0].dueDate &&
    d1.q("SELECT dueDate FROM orders WHERE orderId='TRK1'")[0].dueDate === "2031-05-06" && !cached("TRK2").dueDate);

  reset();
  tick(["TRK1", "TRK2"]);
  const trk1Row = row("TRK1");
  acting = w.bulkEditCustomerInfo("acme");
  await wait(() => d.getElementById("editCustForm"));
  ok("Edit customer info for two orders: every field starts blank (blank keeps each order's own)", /2 orders/.test(d.getElementById("editCustForm").textContent) &&
    ["ecName", "ecEmail", "ecPhone", "ecAddress"].every(id => d.getElementById(id).value === ""));
  d.getElementById("ecPhone").value = "555-0199";
  d.getElementById("editCustForm").querySelector(".admin-pass-submit").click();
  await acting;
  await wait(() => row("TRK1") !== trk1Row);
  const cust = d1.q("SELECT orderId, customerName, shippingAddress FROM orders WHERE orderId IN ('TRK1','TRK2') ORDER BY orderId");
  ok("…the phone saved on both; each keeps its own name and street", sent.length === 1 && sent[0].action === "updateCustomerInfo" && JSON.stringify(sent[0].orderIds) === '["TRK1","TRK2"]' &&
    cust.every(r => JSON.parse(r.shippingAddress || "{}").phone === "555-0199") && cust[0].customerName === "Customer TRK1" && JSON.parse(cust[1].shippingAddress).line1 === "8 Elm St");
  ok("…\"Customer info updated for 2 orders.\", the rows drawn from what was saved — no request", lastToast().m === "Customer info updated for 2 orders." &&
    cached("TRK1").shippingAddress.phone === "555-0199" && cached("TRK1").customerName === "Customer TRK1" && sent.length === 1);

  console.log("\n=== blankShippedFlow_, showBlankShippedModal, showShipmentHistoryModal_ ===");
  reset();
  const blk = cached("BLK1");
  acting = w.blankShippedFlow_("acme", [blk]);
  await wait(() => d.getElementById("bsSave"));
  const blocks = () => [...d.querySelectorAll(".bsBlock")];
  ok("Blank shipped: one new block, both lines ticked", blocks().length === 1 && [...blocks()[0].querySelectorAll(".bsItem")].length === 2 && [...blocks()[0].querySelectorAll(".bsItem")].every(c => c.checked));
  d.getElementById("bsAdd").click();
  ok("+ Add tracking number adds a second block", blocks().length === 2);
  blocks()[0].querySelector(".bsCarrier").value = "UPS"; blocks()[0].querySelector(".bsTrack").value = "1ZBLANK0001";
  blocks()[0].querySelectorAll(".bsItem")[1].checked = false;
  blocks()[1].querySelector(".bsCarrier").value = "FedEx"; blocks()[1].querySelector(".bsTrack").value = "FDXBLANK0002";
  blocks()[1].querySelectorAll(".bsItem")[0].checked = false;
  d.getElementById("bsSave").click();
  await acting;
  await wait(() => actions().includes("getOrdersByIds")); await idle();
  const ships = () => d1.q("SELECT s.id, s.carrier, s.trackingNumber, group_concat(i.itemId) items FROM blank_shipments s JOIN blank_shipment_items i ON i.shipmentId = s.id GROUP BY s.id ORDER BY s.id");
  ok("…two shipments saved, each with the line ticked in its block", JSON.stringify(actions()) === '["addBlankShipment","addBlankShipment","getOrdersByIds"]' && ships().length === 2 &&
    ships()[0].carrier === "UPS" && ships()[0].items === String(blk.items[0].sheetRow) && ships()[1].trackingNumber === "FDXBLANK0002" && ships()[1].items === String(blk.items[1].sheetRow));
  ok("…\"Blank shipments saved.\", and only BLK1 is asked for again", lastToast().m === "Blank shipments saved." && JSON.stringify(sent[2].orderIds.filter((x, i, a) => a.indexOf(x) === i)) === '["BLK1"]' && listReads() === 0);
  // Opened again: the two shipments pre-filled; one edited, the other removed.
  reset();
  acting = w.blankShippedFlow_("acme", [cached("BLK1")]);
  await wait(() => d.getElementById("bsSave"));
  ok("opened again, each shipment is pre-filled in its own block", blocks().length === 2 && blocks()[0].querySelector(".bsTrack").value === "1ZBLANK0001" && blocks()[1].querySelector(".bsCarrier").value === "FedEx");
  blocks()[0].querySelector(".bsTrack").value = "1ZBLANK0009";
  blocks()[1].querySelector(".bsRm").click();
  d.getElementById("bsSave").click();
  await acting;
  await wait(() => actions().includes("getOrdersByIds")); await idle();
  ok("…Remove deletes the one, the edit updates the other", JSON.stringify(actions()) === '["deleteBlankShipment","updateBlankShipment","getOrdersByIds"]' && ships().length === 1 && ships()[0].trackingNumber === "1ZBLANK0009");
  reset();
  acting = w.blankShippedFlow_("acme", [cached("BLK1")]);
  await wait(() => d.getElementById("bsSave"));
  d.querySelector(".bsBlock .bsItem").closest(".bsBlock").querySelectorAll(".bsItem").forEach(c => { c.checked = false; });
  d.getElementById("bsSave").click();
  ok("a shipment with no line ticked is refused in the window", /Tick at least one line item/.test(d.getElementById("bsErr").textContent));
  d.querySelector(".bsBlock").closest(".admin-pass-box").querySelector(".admin-pass-cancel").click();
  await acting;
  ok("…and Cancel sends nothing", sent.length === 0);
  // Its carrier history, as the daily check stores it.
  const sid = ships()[0].id;
  d1._raw.run("INSERT INTO blank_tracking_events (shipmentId, status, statusDetail, location, occurredAt, recordedAt) VALUES (?, 'TRANSIT', 'Departed facility', 'Louisville, KY', ?, ?), (?, 'DELIVERED', 'Delivered', 'Springfield, IL', ?, ?)",
    [sid, hoursAgo(30), hoursAgo(29), sid, hoursAgo(2), hoursAgo(1)]);
  await w.refreshOrderRows_("acme", ["BLK1"]);
  await wait(() => d.querySelector(`[data-admin-action="showShipmentHistoryModal_"][data-sid="${sid}"]`));
  d.querySelector(`[data-admin-action="showShipmentHistoryModal_"][data-sid="${sid}"]`).click();
  await wait(() => d.querySelector(".shClose"));
  const hist = d.querySelector(".shClose").closest(".admin-pass-box").textContent;
  ok("View history shows the shipment's carrier scans, newest place names and all", /Tracking history/.test(hist) && /1ZBLANK0009/.test(hist) && /Departed facility/.test(hist) &&
    /Louisville, KY/.test(hist) && /Springfield, IL/.test(hist));
  d.querySelector(".shClose2").click();
  ok("…Close closes it", !d.querySelector(".shClose"));
  toasts.length = 0;
  w.showShipmentHistoryModal_(424242);
  ok("a shipment the page doesn't have: \"No tracking history is available…\"", /No tracking history is available/.test(lastToast().m) && !d.querySelector(".shClose"));

  console.log("\n=== showRushFeeModal_ ===");
  reset();
  w.showRushFeeModal_("acme", "RUSH1");
  await wait(() => d.getElementById("rfSave"));
  ok("Rush: the window opens unticked, its fields greyed out", !d.getElementById("rfOn").checked && d.getElementById("rfAmount").disabled);
  d.getElementById("rfOn").checked = true; d.getElementById("rfOn").onchange();
  d.getElementById("rfAmount").value = "1500"; d.getElementById("rfSave").click();
  ok("…a fee over $1,000 is refused in the window", /\$0 to \$1,000/.test(d.getElementById("rfErr").textContent) && !actions().includes("setRushFee"));
  d.getElementById("rfAmount").value = "15"; d.getElementById("rfDue").value = "2031-06-01";
  sent.length = 0;
  d.getElementById("rfSave").click();
  await wait(() => toasts.some(t => /Rush fee saved/.test(t.m)) && !d.getElementById("rfSave"));
  await wait(() => cached("RUSH1").rushRequested);
  const rush = d1.q("SELECT rushRequested, rushFeeCents, dueDate FROM orders WHERE orderId='RUSH1'")[0];
  ok("…Save: the order is a rush order with a $15 fee and the due date", JSON.stringify(actions()) === '["setRushFee"]' && sent[0].amount === 15 && sent[0].dueDate === "2031-06-01" &&
    rush.rushRequested === 1 && rush.rushFeeCents === 1500 && rush.dueDate === "2031-06-01");
  ok("…the row is drawn from the order in the reply — no request after it", sent.length === 1 && cached("RUSH1").rushFee === 15 && listReads() === 0);
  reset();
  w.showRushFeeModal_("acme", "NOPE");
  ok("an order not in the list: \"Order not found — refresh the list.\"", /Order not found/.test(lastToast().m) && !d.getElementById("rfSave"));

  console.log("\n=== createLocalSale (createLocalSaleOnce_) ===");
  reset();
  const first = w.createLocalSale("acme"), second = w.createLocalSale("acme");
  await wait(() => d.getElementById("localSaleForm"));
  await second;
  ok("+ Local sale twice at once opens one window", d.querySelectorAll("#localSaleForm").length === 1 && actions().filter(a => a === "listProducts").length === 1);
  const sel = d.getElementById("lsProduct");
  sel.value = "cap"; sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  d.getElementById("lsName").value = "Walk-in Pat";
  d.getElementById("localSaleForm").querySelector(".admin-pass-submit").click();
  ok("…no payment method: \"Please select a payment method.\"", /Please select a payment method/.test(d.getElementById("localSaleForm").textContent) && !actions().includes("createLocalSale"));
  d.getElementById("lsPayment").value = "Cash";
  d.getElementById("localSaleForm").querySelector(".admin-pass-submit").click();
  await first;
  await wait(() => actions().includes("getOrdersByIds")); await idle();
  const sale = sent.find(b => b.action === "createLocalSale");
  const made = d1.q("SELECT orderId, customerName, totalCents FROM orders WHERE customerName='Walk-in Pat'");
  ok("Record sale: one order made, with a key for the sale", !!sale && /^[0-9a-f]{32}$/.test(sale.requestId) && made.length === 1 && made[0].totalCents === 2000);
  ok("…\"Local sale recorded — <id>\", and that new order alone is asked for and put in the list", new RegExp("^Local sale recorded — " + made[0].orderId + "$").test(lastToast().m) &&
    JSON.stringify(sent[sent.length - 1].orderIds) === JSON.stringify([made[0].orderId]) && !!cached(made[0].orderId) && listReads() === 0);
  ok("…and the window can be opened again afterwards", await (async () => { const again = w.createLocalSale("acme"); await wait(() => d.getElementById("localSaleForm"));
    d.getElementById("localSaleForm").querySelector(".admin-pass-cancel").click(); await again; return !d.getElementById("localSaleForm"); })());

  console.log("\n=== The Payments window: Record refund, Shipping part…, Apply discount (whileSaving_) ===");
  reset();
  const pmOpen = w.showPaymentsModal("acme", "PAY1");
  await wait(() => d.getElementById("pmSaveRefund"));
  ok("(PAY1 paid $38 by Venmo: the window offers Record refund)", /Settled/.test(d.getElementById("pmContent").textContent) && !!d.getElementById("pmRefundAmount"));
  d.getElementById("pmRefundAmount").value = "10"; d.getElementById("pmRefundShipping").value = "12";
  d.getElementById("pmSaveRefund").click();
  await wait(() => /shipping part must be between/.test(d.getElementById("pmError").textContent));
  ok("a shipping part over the refund is refused in the window, nothing sent", !actions().includes("recordRefund"));
  d.getElementById("pmRefundShipping").value = "4"; d.getElementById("pmRefundNote").value = "Cap returned";
  let release; hold = { action: "recordRefund", gate: new Promise(r => { release = r; }) };
  d.getElementById("pmSaveRefund").click();
  await wait(() => actions().includes("recordRefund"));
  const rb = d.getElementById("pmSaveRefund");
  ok("Record refund (confirmed): while the answer is on its way the button reads Saving… and is disabled", rb.disabled && rb.textContent === "Saving…");
  rb.click(); rb.onclick && rb.onclick();
  await new Promise(r => setTimeout(r, 30));
  ok("…pressing it again sends no second refund", actions().filter(a => a === "recordRefund").length === 1);
  release(); hold = null;
  await wait(() => toasts.some(t => t.m === "Refund recorded."));
  await wait(() => d.querySelector("#pmContent .pm-refund-ship"));
  const pr = () => d1.q("SELECT id, amountCents, shippingCents, note FROM order_payments WHERE orderId='PAY1' AND kind='refund'");
  ok("…one $10 refund, $4 of it shipping, in the books", pr().length === 1 && pr()[0].amountCents === -1000 && pr()[0].shippingCents === 400 && pr()[0].note === "Cap returned");
  ok("…the window redraws with it ($4.00 of it shipping) and the button is back", /\$4\.00 of it shipping/.test(d.querySelector("#pmContent .pm-refund-ship").textContent) &&
    !d.getElementById("pmSaveRefund").disabled && d.getElementById("pmSaveRefund").textContent === "Record refund");
  ok("…and the order's row in the list follows (Net kept)", cached("PAY1").refundedAmount === 10);
  reset();
  autoConfirm(w, (msg) => /How much of this \$10\.00 refund was shipping/.test(msg) ? "2.50" : true);
  d.querySelector('#pmContent [data-admin-action="pmSetRefundShipping"]').click();
  await wait(() => toasts.some(t => /of the refund marked as shipping/.test(t.m)));
  ok("Shipping part…: asks how much of the $10.00 was shipping; 2.50 saved", JSON.stringify(actions()) === '["setRefundShipping"]' && sent[0].shippingAmount === 2.5 &&
    pr()[0].shippingCents === 250 && lastToast().m === "$2.50 of the refund marked as shipping.");
  await wait(() => /\$2\.50 of it shipping/.test((d.querySelector("#pmContent .pm-refund-ship") || {}).textContent || ""));
  ok("…and the window shows it", /\$2\.50 of it shipping/.test(d.querySelector("#pmContent .pm-refund-ship").textContent));
  autoConfirm(w, () => true);
  reset();
  d.getElementById("pmDiscountAmount").value = "3"; d.getElementById("pmDiscountNote").value = "Member";
  d.getElementById("pmSaveDiscount").click();
  await wait(() => toasts.some(t => t.m === "Discount applied."));
  ok("Apply discount: $3 saved with its note, and the window redraws with it", JSON.stringify(actions()) === '["setDiscount"]' &&
    d1.q("SELECT discountCents, discountNote FROM orders WHERE orderId='PAY1'").every(r => r.discountCents === 300 && r.discountNote === "Member") &&
    /Discount \(Member\)/.test(d.getElementById("pmContent").textContent));
  d.getElementById("pmCloseBottom").click();
  await pmOpen;
  ok("…Close closes the window", !d.getElementById("pmContent"));
  ok("(whileSaving_ with no button just runs the work)", (await w.whileSaving_(null, async () => 7)) === 7);

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  process.exit(0);
})().catch((e) => { console.error(e); console.log("test255 crashed: false"); process.exit(1); });
