const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { may, lowest, DEFAULT_ROLES, effectivePermissions } = require("./testlib/roles");

// Payment on delivery (migrations/0105). Global settings → Payment methods allows it for every shop (off until
// ticked), and a shop can only turn it off or limit it to local sales — never on when it's off globally (the same
// allow-list rule as the payment methods). An order set to pay on delivery goes through its steps before it's paid:
// blanks, digitizing, approval, the run queue, the blanks-to-order list and Home's step all treat it like a paid one;
// it's completed only once paid in full. Setting it needs its own permission, "Set orders to pay on delivery"
// (orders.payOnDelivery) — Manager and Admin by default, not Back office or Production. With "Only for local sales"
// it can be chosen only in the Local sale window. Real db.js / orders.js / permissions.js on sql.js.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, insertOrder, settleOrderBalance, getOrderById, getPaidUnrunOrders, getBlanksToOrder, getOpenOrderStages,
  stagePrereqError, payOnDeliveryRule, getPayOnDeliveryRule, setOrgDeliveryOptions, cleanDeliveryOptions };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => { const r = (request.headers.get('x-role') || 'admin'); return roleAllows(DEFAULT_ROLES[r] || null, need === 'staff' ? '*' : need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'test'; " + require("./testlib/roles").adminAs({ roleFrom: "request.headers.get('x-role') || 'admin'" }) + "\n\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  console.log("=== The rule (db.js payOnDeliveryRule) ===");
  const R = lib.payOnDeliveryRule;
  ok("off until it's ticked globally", R({ card: true }, {}).allowed === false && R(null, null).allowed === false);
  ok("on globally: every shop that hasn't turned it off may use it", R({ onDelivery: true }, {}).allowed === true && R({ onDelivery: true }, null).allowed === true);
  ok("a shop can turn it off for itself", R({ onDelivery: true }, { onDelivery: false }).allowed === false);
  ok("a shop can't turn it on when it's off globally", R({ onDelivery: false }, { onDelivery: true }).allowed === false && R({}, { onDelivery: true }).allowed === false);
  ok("'only for local sales' globally holds for every shop, whatever the shop says",
    R({ onDelivery: true, onDeliveryLocalOnly: true }, { onDeliveryLocalOnly: false }).localSaleOnly === true);
  ok("a shop can limit it to local sales for itself", R({ onDelivery: true }, { onDeliveryLocalOnly: true }).localSaleOnly === true &&
    R({ onDelivery: true }, {}).localSaleOnly === false);
  ok("not allowed is never 'local sales only'", R({ onDeliveryLocalOnly: true }, {}).localSaleOnly === false);

  console.log("\n=== The permission ===");
  ok("its own function on the Roles screen", effectivePermissions(DEFAULT_ROLES.manager)["orders.payOnDelivery"] === "full");
  ok("Manager and above by default", lowest("setPayOnDelivery") === "manager" && may("manager", "setPayOnDelivery"));
  ok("…not Back office, not Production", !may("staff", "setPayOnDelivery") && !may("production", "setPayOnDelivery"));
  ok("recording payments doesn't bring it with it", may("staff", "markPaidManual") && !may("staff", "setPayOnDelivery"));

  console.log("\n=== The migration ===");
  const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
  {
    const old = await createD1();
    old._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of migrations.filter(f => f < "0105")) old.execFile(read("migrations/" + f));
    old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);
      INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('O-1','acme','Alex','a@x.com','2026-10-01T12:00:00Z');`);
    const before = await lib.getPaidUnrunOrders(old);
    ok("before it, the queues still work (no column to read)", Array.isArray(before) && before.length === 0);
    old.execFile(read("migrations/0105_pay_on_delivery.sql"));
    ok("existing orders are not pay on delivery", old.q("SELECT payOnDelivery FROM orders")[0].payOnDelivery === 0);
    ok("only 0 or 1", (() => { try { old._raw.exec("UPDATE orders SET payOnDelivery = 2"); return false; } catch (e) { return true; } })());
  }
  ok("schema.sql has the column", /payOnDelivery\s+INTEGER NOT NULL DEFAULT 0/.test(read("schema.sql")));
  ok("the migration list ships it", read("functions/_lib/migrationList.js").includes('"0105_pay_on_delivery.sql"'));

  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('other','other','Other','t','t',1);`);
  await lib.setOrgDeliveryOptions(d1, "club", lib.cleanDeliveryOptions([{ type: "pickup" }]).options);
  const call = async (body, { role = "admin" } = {}) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "club" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const setGlobal = (p) => d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', '${JSON.stringify(p)}')`);
  const setShop = (org, p) => d1._raw.exec(`UPDATE orgs SET enabledPayments = '${JSON.stringify(p)}' WHERE orgId = '${org}'`);
  await lib.createProduct(d1, "club", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  d1._raw.exec(`INSERT INTO blanks (name, productType, createdAt, updatedAt) VALUES ('Cap blank', 'cap', 't', 't')`);
  const blankId = d1.q("SELECT id FROM blanks")[0].id;
  d1._raw.exec(`INSERT INTO product_blank_links (orgId, productId, productColor, productSize, blankId, blankColor, blankSize) VALUES ('club','cap','','OSFA',${blankId},'','OSFA')`);
  let n = 0;
  const place = async (orderId) => {
    n++;
    await lib.insertOrder(d1, { orderId, orgId: "club", customerName: "C" + n, contact: "c@x.com", paymentMethod: "Cash", placedAt: `2026-10-0${n}T15:00:00.000Z` },
      [{ productId: "cap", name: "Club Cap", type: "cap", size: "OSFA", qty: 2, unitPrice: 20 }]);
  };
  await place("P-1");
  await place("P-2");

  console.log("\n=== Global settings and shop settings ===");
  let r = await call({ action: "getOrders" });
  ok("Orders says what the shop allows — off by default", r.status === 200 && r.body.payOnDelivery && r.body.payOnDelivery.allowed === false);
  r = await call({ action: "setPayOnDelivery", orderId: "P-1", on: true });
  ok("off globally: an order can't be set to pay on delivery", r.status === 409 && /isn't allowed/.test(r.body.message));
  r = await call({ action: "saveGlobalSettingsAll", settings: { payments: { card: true, venmo: true, zelle: true, check: true, onDelivery: true, onDeliveryLocalOnly: false } } });
  ok("Global settings → Payment methods saves it", r.status === 200 && JSON.parse(d1.q("SELECT value FROM global_settings WHERE key='enabledPayments'")[0].value).onDelivery === true);
  r = await call({ action: "getGlobalSettings" });
  ok("…and reads it back", r.body.globalSettings.enabledPayments.onDelivery === true && r.body.globalSettings.enabledPayments.onDeliveryLocalOnly === false);
  r = await call({ action: "getOrders" });
  ok("Orders now says it's allowed for the shop", r.body.payOnDelivery.allowed === true && r.body.payOnDelivery.localSaleOnly === false);
  setShop("club", { card: true, venmo: true, zelle: true, check: true, onDelivery: false });
  r = await call({ action: "setPayOnDelivery", orderId: "P-1", on: true });
  ok("a shop that turned it off refuses it", r.status === 409 && /isn't allowed/.test(r.body.message));
  ok("…and its Orders says so", (await call({ action: "getOrders" })).body.payOnDelivery.allowed === false);
  setShop("club", { card: true, venmo: true, zelle: true, check: true });

  console.log("\n=== Who may set it ===");
  r = await call({ action: "setPayOnDelivery", orderId: "P-1", on: true }, { role: "staff" });
  ok("Back office is refused", r.status === 403);
  r = await call({ action: "setPayOnDelivery", orderId: "P-1", on: true }, { role: "production" });
  ok("Production is refused", r.status === 403);
  r = await call({ action: "setPayOnDelivery", orderId: "P-1", on: true, org: "other" }, { role: "manager" });
  ok("the order must belong to the shop named", r.status === 404);
  ok("unpaid, blanks can't be ordered yet", /isn't paid/.test(lib.stagePrereqError(await lib.getOrderById(d1, "P-1"), "blankOrdered")));
  r = await call({ action: "setPayOnDelivery", orderId: "P-1", on: true }, { role: "manager" });
  ok("a Manager sets it", r.status === 200 && r.body.payOnDelivery === true && r.body.paid === false);
  ok("…on the record", d1.q("SELECT payOnDelivery FROM orders WHERE orderId='P-1'")[0].payOnDelivery === 1 &&
    d1.q("SELECT count(*) AS n FROM audit_log WHERE action='order.pay_on_delivery_set' AND orderId='P-1'")[0].n === 1);

  console.log("\n=== The steps go on before it's paid ===");
  const o1 = await lib.getOrderById(d1, "P-1");
  ok("the order says pay on delivery, and still unpaid", o1.payOnDelivery === true && o1.paid === false && Number(o1.balanceDue) > 0);
  ok("blanks can be ordered", lib.stagePrereqError(o1, "blankOrdered") === "");
  ok("digitizing can be marked done", lib.stagePrereqError(o1, "digitizingComplete") === "");
  ok("an unpaid order without it still waits", /isn't paid/.test(lib.stagePrereqError(await lib.getOrderById(d1, "P-2"), "blankOrdered")));
  r = await call({ action: "setFulfillmentStage", orderId: "P-1", stage: "blankOrdered" }, { role: "staff" });
  ok("Back office marks its blanks ordered (the step itself needs no new permission)", r.status === 200);
  const bto = await lib.getBlanksToOrder(d1);
  ok("blanks to order counts its pieces as paid, not the other order's", bto.unpaidOrders === 1 && bto.unpaidPieces === 2);
  const stages = await lib.getOpenOrderStages(d1);
  ok("Home moves it past 'new'", stages.find(s => s.orderId === "P-1").stage !== "new" && stages.find(s => s.orderId === "P-2").stage === "new");
  await call({ action: "setFulfillmentStage", orderId: "P-1", stage: "blankReceived" });
  const unrun = await lib.getPaidUnrunOrders(d1);
  ok("it's in the run backlog, the unpaid one isn't", unrun.some(o => o.orderId === "P-1") && !unrun.some(o => o.orderId === "P-2"));
  for (const stage of ["digitizingComplete", "manufactured", "qaPacked", "delivered"]) {
    r = await call({ action: "setFulfillmentStage", orderId: "P-1", stage });
    ok("…" + stage + " before it's paid", r.status === 200);
  }
  r = await call({ action: "setOrderCompleted", orderId: "P-1", completed: true });
  ok("delivered but unpaid: it can't be completed yet", r.status !== 200 || r.body.status === "error" || !d1.q("SELECT completedAt FROM orders WHERE orderId='P-1'")[0].completedAt);
  await lib.settleOrderBalance(d1, "P-1", "cash on delivery");
  r = await call({ action: "setOrderCompleted", orderId: "P-1", completed: true });
  ok("paid on delivery, it completes", !!d1.q("SELECT completedAt FROM orders WHERE orderId='P-1'")[0].completedAt);
  r = await call({ action: "setPayOnDelivery", orderId: "P-2", on: true });
  ok("(admin sets it on the other order)", r.status === 200);
  r = await call({ action: "setPayOnDelivery", orderId: "P-2", on: false }, { role: "staff" });
  ok("Back office can't take it off either", r.status === 403);
  r = await call({ action: "setPayOnDelivery", orderId: "P-2", on: false }, { role: "manager" });
  ok("taken off, the order waits for payment again", r.status === 200 && r.body.payOnDelivery === false &&
    /isn't paid/.test(lib.stagePrereqError(await lib.getOrderById(d1, "P-2"), "blankOrdered")));
  await lib.settleOrderBalance(d1, "P-2", "venmo");
  r = await call({ action: "setPayOnDelivery", orderId: "P-2", on: true });
  ok("a paid order isn't set to pay on delivery", r.status === 409 && /already paid/.test(r.body.message));

  console.log("\n=== Local sales ===");
  const sale = (extra, role) => call(Object.assign({ action: "createLocalSale", items: [{ productId: "cap", size: "OSFA", qty: 1 }], customerName: "Walk-in" }, extra), { role });
  r = await sale({ payOnDelivery: true }, "staff");
  ok("Back office can record a local sale but not as pay on delivery", r.status === 403 && /pay on delivery/.test(r.body.message));
  ok("(Back office still records a plain one)", (await sale({}, "staff")).status === 200);
  r = await sale({ payOnDelivery: true, paid: true });
  ok("Paid and Pay on delivery together are refused", r.status === 400);
  r = await sale({ payOnDelivery: true }, "manager");
  ok("a Manager records one as pay on delivery", r.status === 200 && (await lib.getOrderById(d1, r.body.orderId)).payOnDelivery === true);
  ok("…in the audit entry too", JSON.parse(d1.q(`SELECT detail FROM audit_log WHERE action='order.created_local_sale' AND orderId='${r.body.orderId}'`)[0].detail).payOnDelivery === true);
  await place("P-3");
  setGlobal({ card: true, venmo: true, zelle: true, check: true, onDelivery: true, onDeliveryLocalOnly: true });
  ok("Orders says 'local sales only'", (await call({ action: "getOrders" })).body.payOnDelivery.localSaleOnly === true);
  r = await call({ action: "setPayOnDelivery", orderId: "P-3", on: true });
  ok("only for local sales: an order can't be set to it from its row", r.status === 409 && /only for local sales/.test(r.body.message));
  r = await sale({ payOnDelivery: true });
  ok("…but the Local sale window still can", r.status === 200 && (await lib.getOrderById(d1, r.body.orderId)).payOnDelivery === true);
  r = await call({ action: "setPayOnDelivery", orderId: r.body.orderId, on: false });
  ok("…and it can always be taken off", r.status === 200 && r.body.payOnDelivery === false);
  setGlobal({ card: true, venmo: true, zelle: true, check: true });
  setShop("club", { card: true, onDelivery: true, onDeliveryLocalOnly: false });
  r = await sale({ payOnDelivery: true });
  ok("off globally, the shop's own tick doesn't allow it — not even for a local sale", r.status === 409);

  console.log("\n=== The admin page ===");
  const admin = read("public/admin.js");
  ok("Global settings has the switch and 'only for local sales'", /id="gPayOnDelivery"/.test(admin) && /id="gPayOnDeliveryLocal"/.test(admin) &&
    /onDelivery: \$g\("gPayOnDelivery"\)\.checked, onDeliveryLocalOnly: \$g\("gPayOnDeliveryLocal"\)\.checked/.test(admin));
  ok("Shop settings has them too, on by default (follows the global switch)", /id="orgFormPayOnDelivery" \$\{orgPay\.onDelivery !== false \? "checked"/.test(admin) &&
    /onDeliveryLocalOnly: document\.getElementById\("orgFormPayOnDeliveryLocal"\)\.checked/.test(admin));
  ok("the shop wizard keeps them when it saves the payment methods", /enabledPayments: Object\.assign\(\{\}, ep,/.test(admin));
  ok("the Local sale window offers it only where the shop allows it and to a role that may set it",
    /payOnDelivery: pod\.allowed && adminCan_\("orders\.payOnDelivery", "edit"\)/.test(admin) && /id="lsPod"/.test(admin));
  ok("the row's button needs the permission and a shop not limited to local sales",
    /pod\.allowed && !pod\.localSaleOnly && can\("orders\.payOnDelivery", "edit"\)/.test(admin));
  ok("the stage menu goes on for it (workCleared_)", (admin.match(/prereqMet: o => workCleared_\(o\)/g) || []).length === 4);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
