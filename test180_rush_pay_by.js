const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");
const { JSDOM, VirtualConsole } = require("jsdom");

// Rush orders: a "full payment received by" date (migrations/0083). The rush rule can say how many days before the
// needed-by date full payment is due (the order gets that date when the customer orders); the admin sets, changes or
// clears it in the order's Rush… window; the invoice email (subject and body), the order-received email and the invoice
// page say plainly that without full payment by then the rush date can't be guaranteed — and the page says when that
// date has passed. Real migrations, db.js, orders.js, invoice.js and email.js on sql.js; the real invoice page in jsdom.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const mail = [];
global.fetch = async (url, init) => { if (captureMail(url, init, mail)) return MAIL_OK; throw new Error("unexpected fetch " + url); };
const M = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  "const ordersApi = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost; })();\n" +
  "const invoiceApi = (function(){\n" + strip(read("functions/api/invoice.js")) + "\nreturn { onRequestGet, onRequestPost }; })();\n" +
  "return { ordersApi, invoiceApi, createProduct, getOrderById, getOrderInvoiceByOrder, cleanRushRule, rushRuleView, rushPayByFor, rushPayByMissed, localToday, " +
  "settleOrderBalance, addOrderPayment, sendInvoiceEmail, sendOrderReceivedEmail, setOrgDeliveryOptions, cleanDeliveryOptions };")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const tick = (ms) => new Promise(res => setTimeout(res, ms || 60));
const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const addDays = (day, n) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const longDay = (day) => new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const quiet = () => { const vc = new VirtualConsole(); vc.on("jsdomError", (e) => { if (!/Not implemented: navigation/.test(String(e && e.message))) console.error(e); }); return vc; };

(async () => {
  console.log("=== The migration ===");
  const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
  {
    const old = await createD1();
    old._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of migrations.filter(f => f < "0083")) old.execFile(read("migrations/" + f));
    old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);
      INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, rushRequested) VALUES ('O-1','acme','Alex Sample','a@x.com','2026-10-01T12:00:00Z',1);`);
    old.execFile(read("migrations/0083_rush_pay_by.sql"));
    ok("existing orders keep everything and have no pay-by date", old.q("SELECT rushPayBy, rushRequested FROM orders")[0].rushPayBy === null);
  }

  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, accent, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','#1E7A4C','t','t',1);`);
  await M.setOrgDeliveryOptions(d1, "acme", M.cleanDeliveryOptions([{ type: "pickup" }]).options);
  await M.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 25, visible: true, noDesignNeeded: true });
  const env = { DB: d1, SIGNING_SECRET: "s", TIMEZONE: "America/New_York", ...MAIL_ENV };
  const ctx = (request) => ({ env, request, waitUntil: (p) => Promise.resolve(p).catch(() => {}) });
  const post = async (url, body) => { const res = await M.ordersApi(ctx({ url, json: async () => body, headers: { get: () => null } })); return { status: res.status, body: JSON.parse(await res.text()) }; };
  const admin = (body) => post(ADMIN_ORIGIN + "/api/orders", Object.assign({ key: "x" }, body));
  let seq = 0;
  const order = async (extra = {}) => { const orderId = "P-" + (++seq);
    const r = await post(shopOrigin("acme") + "/api/orders", Object.assign({ orderId, orgId: "acme", customerName: "Alex Sample", contact: "alex@example.com", paymentMethod: "Venmo",
      deliveryOptionId: "pickup", items: [{ productId: "cap", size: "OSFA", qty: 1 }] }, extra));
    return { r, orderId }; };
  const today = await M.localToday(env);

  console.log("\n=== The rule ===");
  const R = (x) => M.cleanRushRule(x);
  ok("days before the needed-by date: optional, kept, shown back", R({ mode: "fixed", amount: 20 }).payByDays === null && R({ mode: "fixed", amount: 20, payByDays: 3 }).payByDays === 3 &&
    M.rushRuleView(R({ mode: "follow", payByDays: 0 })).payByDays === 0);
  const refused = (x) => { try { R(x); return false; } catch (e) { return !!e.userFacing; } };
  ok("refused: a fraction, a negative, over 60", refused({ mode: "fixed", amount: 1, payByDays: 1.5 }) && refused({ mode: "fixed", amount: 1, payByDays: -1 }) && refused({ mode: "fixed", amount: 1, payByDays: 61 }));
  const due = addDays(today, 10);
  ok("the pay-by date is that many days before the needed-by date", M.rushPayByFor(R({ mode: "fixed", amount: 1, payByDays: 3 }), due, today) === addDays(today, 7));
  ok("…never before today; none without a rule's days or a needed-by date", M.rushPayByFor(R({ mode: "fixed", amount: 1, payByDays: 30 }), due, today) === today &&
    M.rushPayByFor(R({ mode: "fixed", amount: 1 }), due, today) === "" && M.rushPayByFor(R({ mode: "fixed", amount: 1, payByDays: 3 }), "", today) === "");

  console.log("\n=== Ordering ===");
  let r = await admin({ action: "updateRushSettings", rush: { rule: { mode: "fixed", amount: 20, payByDays: 3 }, taxable: false } });
  ok("the global rule saves its days", r.status === 200 && r.body.rush.rule.payByDays === 3);
  r = await admin({ action: "updateRushSettings", rush: { rule: { mode: "fixed", amount: 20, payByDays: 99 } } });
  ok("…a bad number of days is refused with the reason", r.status === 400 && /0 to 60/.test(r.body.message));
  let o = await order({ rush: true, neededBy: due });
  let ord = await M.getOrderById(d1, o.orderId);
  ok("a rush order with a needed-by date gets the pay-by date", o.r.status === 200 && ord.dueDate === due && ord.rushPayBy === addDays(today, 7));
  o = await order({ rush: true });
  ok("…none without a needed-by date", (await M.getOrderById(d1, o.orderId)).rushPayBy === "");
  o = await order({ neededBy: due });
  ok("…none without rush", (await M.getOrderById(d1, o.orderId)).rushPayBy === "");
  o = await order({ rush: true, neededBy: due, rushPayBy: "2020-01-01" });
  ok("…and the browser can't choose it", (await M.getOrderById(d1, o.orderId)).rushPayBy === addDays(today, 7));

  console.log("\n=== The Rush… window ===");
  const id = o.orderId;
  r = await admin({ action: "setRushFee", org: "acme", orderId: id, requested: true, amount: 20, payBy: addDays(today, 5) });
  ok("the admin changes it", r.status === 200 && (await M.getOrderById(d1, id)).rushPayBy === addDays(today, 5));
  const aud = JSON.parse(d1.q(`SELECT detail FROM audit_log WHERE action='order.rush_fee_set' AND orderId='${id}'`)[0].detail);
  ok("…audited from → to", aud.from.payBy === addDays(today, 7) && aud.to.payBy === addDays(today, 5));
  r = await admin({ action: "setRushFee", org: "acme", orderId: id, requested: true, amount: 20, payBy: addDays(due, 1) });
  ok("a pay-by date after the due date is refused", r.status === 400 && /after/.test(r.body.message) && (await M.getOrderById(d1, id)).rushPayBy === addDays(today, 5));
  r = await admin({ action: "setRushFee", org: "acme", orderId: id, requested: true, amount: 20, payBy: "soon" });
  ok("…so is one that isn't a date", r.status === 400);
  r = await admin({ action: "setRushFee", org: "acme", orderId: id, requested: true, amount: 25 });
  ok("changing just the fee leaves it", r.status === 200 && (await M.getOrderById(d1, id)).rushPayBy === addDays(today, 5));
  r = await admin({ action: "setRushFee", org: "acme", orderId: id, requested: true, amount: 25, payBy: "" });
  ok("…it can be cleared", (await M.getOrderById(d1, id)).rushPayBy === "");
  await admin({ action: "setRushFee", org: "acme", orderId: id, requested: true, amount: 25, payBy: addDays(today, 2) });
  await admin({ action: "setRushFee", org: "acme", orderId: id, requested: false });
  ok("…and turning rush off clears it", (await M.getOrderById(d1, id)).rushPayBy === "");
  r = await admin({ action: "setRushFee", org: "acme", orderId: id, requested: true, pending: true, dueDate: due, payBy: addDays(today, 2) });
  ok("rush put back on with a fee to follow, a due date and a pay-by date in one save", r.status === 200 && (x => x.rushFeePending && x.dueDate === due && x.rushPayBy === addDays(today, 2))(await M.getOrderById(d1, id)));

  console.log("\n=== Passed? ===");
  ord = await M.getOrderById(d1, id);
  ok("not passed before or on the day", !M.rushPayByMissed(ord, addDays(today, 2)) && !M.rushPayByMissed(ord, today));
  ok("passed the day after while something is owed", M.rushPayByMissed({ ...ord, balanceDue: 25 }, addDays(today, 3)));
  ok("…not once it's paid", !M.rushPayByMissed({ ...ord, balanceDue: 0 }, addDays(today, 3)));

  console.log("\n=== The emails ===");
  await admin({ action: "setRushFee", org: "acme", orderId: id, requested: true, amount: 20 });
  mail.length = 0;
  r = await admin({ action: "sendInvoice", org: "acme", orderId: id });
  const inv = mail.find(m => /Invoice/.test(m.subject));
  const payNice = longDay(addDays(today, 2)), dueNice = longDay(due);
  ok("the invoice email's subject says it's a rush order and when full payment is due", r.status === 200 && inv && /rush order/.test(inv.subject) && /full payment due by/.test(inv.subject));
  ok("…its body says full payment by the date or the rush date can't be guaranteed (both parts)",
    plain(inv.htmlBody).includes(`we must receive full payment by ${payNice}`) && plain(inv.htmlBody).includes(`If we have not received full payment by ${payNice}, we cannot guarantee the rush delivery date of ${dueNice}`) &&
    inv.body.includes(`we cannot guarantee the rush delivery date of ${dueNice}`) && /RUSH ORDER — FULL PAYMENT DUE BY/.test(inv.body));
  ok("…the notice comes before the items, and once more by the pay button", plain(inv.htmlBody).indexOf("cannot guarantee") < plain(inv.htmlBody).indexOf("Club Cap") &&
    /Reminder: full payment is due by/.test(plain(inv.htmlBody)));
  mail.length = 0;
  await M.sendInvoiceEmail(env, { order: { ...(await M.getOrderById(d1, id)), rushFeePending: true, balanceDue: 0 }, orgName: "Acme", invoiceUrl: "https://x/?invoice=1", allowDelivery: false });
  ok("a rush fee still to follow is part of the full payment", /including the rush fee, which we'll send you separately/.test(mail[0].body));
  mail.length = 0;
  await M.sendInvoiceEmail(env, { order: { ...(await M.getOrderById(d1, "P-2")) }, orgName: "Acme", invoiceUrl: "https://x/?invoice=1", allowDelivery: false });
  ok("no pay-by date → no notice, the usual subject", !/cannot guarantee/.test(mail[0].body) && /^Invoice — P-2( · \$[\d.,]+ due)?$/.test(mail[0].subject));
  mail.length = 0;
  await M.sendInvoiceEmail(env, { order: { ...(await M.getOrderById(d1, id)), balanceDue: 0, rushFeePending: false }, orgName: "Acme", invoiceUrl: "https://x/?invoice=1", allowDelivery: false });
  ok("nothing left to pay → no notice", !/cannot guarantee/.test(mail[0].body));
  mail.length = 0;
  o = await order({ rush: true, neededBy: due });
  await tick(30);
  const rec = mail.find(m => /^Order received/.test(m.subject));
  ok("the order-received email says it too", rec && rec.body.includes(`cannot guarantee the rush delivery date of ${dueNice}`) && plain(rec.htmlBody).includes(`full payment by ${longDay(addDays(today, 7))}`));

  console.log("\n=== The invoice page ===");
  const token = (await M.getOrderInvoiceByOrder(d1, id)).token;
  const invGet = async () => { const res = await M.invoiceApi.onRequestGet(ctx({ url: shopOrigin("acme") + "/api/invoice?token=" + token, headers: { get: () => null } })); return JSON.parse(await res.text()); };
  let v = (await invGet()).invoice;
  ok("the endpoint gives the needed-by and pay-by dates, not passed", v.rushRequested && v.neededBy === due && v.rushPayBy === addDays(today, 2) && v.rushPayByPassed === false);
  const page = async () => {
    const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", url: shopOrigin("acme") + "/?invoice=" + token, pretendToBeVisual: true, virtualConsole: quiet(),
      beforeParse(win){
        win.fetch = async (url) => {
          const u = String(url);
          if (u.startsWith("/api/invoice?")) { const res = await M.invoiceApi.onRequestGet(ctx({ url: shopOrigin("acme") + u, headers: { get: () => null } })); const t = await res.text(); return { ok: res.status < 400, status: res.status, json: async () => JSON.parse(t) }; }
          return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
        };
      } });
    for (let i = 0; i < 40 && !dom.window.document.querySelector(".inv"); i++) await tick(25);
    return dom;
  };
  let dom = await page(), doc = dom.window.document;
  const box = doc.querySelector(".inv-rush");
  ok("a rush box at the top: full payment by the date, or the rush date can't be guaranteed", box && !box.classList.contains("passed") &&
    plain(box.innerHTML).includes(`full payment due by ${payNice}`) && plain(box.innerHTML).includes(`If we have not received full payment by ${payNice}, we cannot guarantee the rush delivery date of ${dueNice}`) &&
    box.compareDocumentPosition(doc.querySelector(".inv-items")) & 4);
  ok("…and a reminder by the pay buttons", /Pay in full by .* to keep your rush delivery date/.test(plain(doc.querySelector(".inv-rush-short").innerHTML)));
  d1._raw.exec(`UPDATE orders SET rushPayBy='${addDays(today, -1)}' WHERE orderId='${id}'`);
  v = (await invGet()).invoice;
  dom = await page(); doc = dom.window.document;
  ok("once the date has passed unpaid, it says the rush date can no longer be guaranteed", v.rushPayByPassed && doc.querySelector(".inv-rush.passed") &&
    /can no longer guarantee the rush delivery date/.test(plain(doc.querySelector(".inv-rush").innerHTML)) && /has passed/.test(plain(doc.querySelector(".inv-rush-short").innerHTML)));
  await M.settleOrderBalance(d1, id, "Paid");
  dom = await page(); doc = dom.window.document;
  ok("paid in full: no warning, just the rush date", !doc.querySelector(".inv-rush") && /rush delivery date/.test(plain(doc.getElementById("app").innerHTML)));

  console.log("\n=== The shop page and the admin ===");
  const html = read("public/index.html");
  const payBySrc = html.slice(html.indexOf("function rushPayByDate_("), html.indexOf("function rushPayByHtml_("));
  const rushPayByDate_ = new Function(payBySrc + "\nreturn rushPayByDate_;")();
  ok("the checkout works out the same pay-by date as the server", rushPayByDate_({ rush: M.rushRuleView(R({ mode: "fixed", amount: 1, payByDays: 3 })) }, due, today) === M.rushPayByFor(R({ mode: "fixed", amount: 1, payByDays: 3 }), due, today) &&
    rushPayByDate_({ rush: M.rushRuleView(R({ mode: "fixed", amount: 1, payByDays: 30 })) }, due, today) === today && rushPayByDate_({ rush: M.rushRuleView(R({ mode: "fixed", amount: 1 })) }, due, today) === "");
  ok("…and tells the customer before they order", /Full payment must be received by \$\{escapeHtml\(nice\)\}\. If it isn't, we can't guarantee this date\./.test(html));
  const adminSrc = read("public/admin.js");
  const helpers = new Function("escapeHtml", adminSrc.slice(adminSrc.indexOf("function rushPill_("), adminSrc.indexOf("function showRushFeeModal_(")) + "\nreturn { rushPill_, rushPayBySuggest_, rushLocalToday_ };")(s => String(s));
  const lt = helpers.rushLocalToday_();
  ok("the Rush… window suggests the date from the rule's days, never before today", helpers.rushPayBySuggest_(addDays(lt, 10), 3) === addDays(lt, 7) && helpers.rushPayBySuggest_(addDays(lt, 1), 5) === lt && helpers.rushPayBySuggest_("", 3) === "");
  ok("the Orders pill shows the pay-by date, and flags it once it's passed unpaid", /pay by/.test(helpers.rushPill_({ rushRequested: true, rushPayBy: addDays(lt, 3), balanceDue: 10 })) &&
    /rush-pill-late/.test(helpers.rushPill_({ rushRequested: true, rushPayBy: addDays(lt, -1), balanceDue: 10 })) && !/rush-pill-late/.test(helpers.rushPill_({ rushRequested: true, rushPayBy: addDays(lt, -1), balanceDue: 0, paid: true })));
  ok("the Rush… window has the date, sends payBy, and the rule editor has the days", /id="rfPayBy"/.test(adminSrc) && /req\.payBy = payBy/.test(adminSrc) && /PayByDays/.test(adminSrc) && /payByDays: num\(val\("PayByDays"\)\)/.test(adminSrc));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
