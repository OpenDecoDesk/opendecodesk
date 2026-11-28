// How a new order gets its customer (migrations/0108, customer records phase 1), through the real handlers:
//   * a storefront order (the public order action, pickup and shipped on a signed quote), a local sale
//     (createLocalSale, with and without a picked customer), an imported order (importOrders) and insertOrder itself;
//   * findOrCreateCustomerForOrder_: an email finds or makes the customer (case and padding don't matter), a phone
//     number or nothing links nothing, the name / phone / address are kept when one is made, a test order joins but
//     never makes one, an archived customer still gets its orders, a merged-away duplicate's email goes to the
//     customer that was kept, and a database without migrations/0108 still takes orders;
//   * a picked customer (opts.customerId) beats the email; an unknown or merged-away pick falls back to the email;
//     only a PICKED customer's tax exemption counts;
//   * setOrderCustomer (link, relink, unlink, what it refuses) and the order readers' customerId.
// Real SQL (sql.js) + the real db.js, quoteToken.js and orders.js. Invented shops, people and addresses only.
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
// Mail is never sent from here: the one function that would is swapped for one that says it did.
const emailSrc = strip(read("functions/_lib/email.js")).replace(/async function send_\(/, "async function send_unused_(") +
  "\nasync function send_(env, m) { return true; }\n";
const { selectBox } = new Function(strip(read("functions/_lib/boxSize.js")) + "\nreturn { selectBox };")();
// Who is signed in is read on every call: a built-in role's key, or null for nobody.
globalThis.__role276 = "admin";
const S = new Function("selectBox", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs({ roleFrom: "globalThis.__role276" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {}, features: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/_lib/digital.js")) + "\n" + strip(read("functions/api/orders.js")) +
  `\nreturn { post: onRequestPost, signQuote, canonicalItems, insertOrder, findOrCreateCustomerForOrder_, normalizeCustomerEmail_, setOrderCustomer,
    mergeCustomers, saveCustomer, setCustomerArchived, getOrderById, getOrdersByOrg, getOrdersByIds, getOpenOrders, createProduct,
    setSalesTaxSettings, setLocaleSettings };`)(selectBox);

const ENV = { SIGNING_SECRET: "s".repeat(40) };
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const newDb = async (before) => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('acme','acme','Example Club','t','t',1,1);`);
  return d1;
};
const rejects = async (fn) => { try { await fn(); return ""; } catch (e) { return String((e && e.message) || e) || "threw"; } };

(async () => {
  const d1 = await newDb();
  await S.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, weightOz: 6 });
  // Sales tax on, added on top (6%), so an exempt order is one with no tax.
  await S.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH", taxMode: "exclusive" });

  const call = async (url, body) => {
    const waits = [];
    const res = await S.post({ env: { DB: d1, ...ENV }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url, json: async () => body, headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => call(ADMIN_ORIGIN + "/api/orders", { key: "x", ...body });
  const shop = (orderId, extra = {}) => call(shopOrigin("acme") + "/api/orders",
    { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check", items: [{ productId: "tee", qty: 1 }], ...extra });
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  const customers = () => d1.q("SELECT count(*) AS n FROM customers")[0].n;
  const linkOf = (orderId) => { const r = q1("SELECT customerId FROM orders WHERE orderId = ?", orderId); return r ? r.customerId : "no such order"; };
  const byEmail = (email) => d1.q("SELECT * FROM customers WHERE email = ? ORDER BY id", email);
  const line = [{ productId: "", name: "Item", type: "custom", size: "", qty: 1, unitPrice: 10 }];
  let n = 0;
  // insertOrder itself, as the handlers call it.
  const place = async (order = {}, opts) => {
    const orderId = order.orderId || "DIRECT-" + (++n);
    await S.insertOrder(d1, { orderId, orgId: "acme", customerName: "Dana Example", contact: "", placedAt: "2026-06-15T12:00:00.000Z", ...order }, line, opts);
    return orderId;
  };
  const newCustomer = async (fields) => (await S.saveCustomer(d1, fields)).id;
  let r, c, id, before;

  console.log("=== A storefront order ===");
  r = await shop("WEB-1", { contact: "Pat@Example.COM" });
  c = byEmail("pat@example.com");
  ok("the first order with an email makes a customer and belongs to it", r.status === 200 && c.length === 1 && customers() === 1 && linkOf("WEB-1") === c[0].id);
  const patId = c[0].id;
  ok("…with the order's name and the email in lower case, and nothing else filled in", c[0].name === "Pat Example" && c[0].email === "pat@example.com" &&
    c[0].phone === "" && c[0].addressJson === "" && c[0].company === "" && c[0].notes === "");
  ok("…not exempt, not archived, not merged, dated now", c[0].taxExempt === 0 && c[0].archivedAt === null && c[0].mergedIntoId === null &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(c[0].createdAt) && c[0].updatedAt === c[0].createdAt);
  ok("the order keeps the contact as it was typed", q1("SELECT contact FROM orders WHERE orderId = 'WEB-1'").contact === "Pat@Example.COM");
  r = await shop("WEB-2", { customerName: "P. Example", contact: "PAT@example.com" });
  ok("a second order with the same email, typed in other letters, joins that customer: no second one", r.status === 200 && customers() === 1 && linkOf("WEB-2") === patId);
  ok("…and the customer keeps the name it has", byEmail("pat@example.com")[0].name === "Pat Example");
  // Shipped by carrier: the address comes with the signed quote for its ZIP.
  const quote = await S.signQuote(ENV, { orgId: "acme", zip: "43000", items: S.canonicalItems([{ productId: "tee", qty: 1 }]), amountCents: 500, method: "Ground" });
  r = await shop("WEB-3", { customerName: "  Sam Example ", contact: "sam@example.com", shippingQuoteToken: quote,
    shippingAddress: { name: "Sam Example", line1: "1 Example St", line2: "", city: "Anytown", state: "OH", zip: "43000", phone: "555-0100" } });
  c = byEmail("sam@example.com");
  ok("a shipped order with a new email makes its customer too", r.status === 200 && c.length === 1 && customers() === 2 && linkOf("WEB-3") === c[0].id);
  const samId = c.length ? c[0].id : 0;
  ok("…named as on the order (trimmed), with the phone from the ship-to address", c[0].name === "Sam Example" && c[0].phone === "555-0100");
  const samAddr = JSON.parse(c[0].addressJson || "{}");
  ok("…and the ship-to address, its empty lines left out", samAddr.name === "Sam Example" && samAddr.line1 === "1 Example St" && samAddr.city === "Anytown" &&
    samAddr.state === "OH" && samAddr.zip === "43000" && samAddr.phone === "555-0100" && !("line2" in samAddr));
  r = await shop("WEB-4", { customerName: "Someone Else", contact: "sam@example.com" });
  ok("a later order doesn't rewrite the customer's name, phone or address", linkOf("WEB-4") === samId && byEmail("sam@example.com")[0].name === "Sam Example" &&
    byEmail("sam@example.com")[0].addressJson === c[0].addressJson && byEmail("sam@example.com")[0].updatedAt === c[0].updatedAt);
  r = await shop("WEB-5", { contact: "lee example@example.com" });
  ok("a contact the shop accepts but that isn't one email address (a space in it) gives the order no customer", r.status === 200 && linkOf("WEB-5") === null && customers() === 2);
  // An exempt customer's email on a storefront order: linked, taxed as usual.
  d1._raw.run("UPDATE customers SET taxExempt = 1 WHERE id = ?", [patId]);
  r = await shop("WEB-6");
  ok("an order that found an EXEMPT customer by its email is linked but still taxed (20.00 + 1.20)", r.status === 200 && linkOf("WEB-6") === patId && r.body.salesTax === 1.2 && r.body.total === 21.2 &&
    q1("SELECT taxExempt FROM orders WHERE orderId = 'WEB-6'").taxExempt === 0);

  console.log("\n=== A local sale ===");
  const sale = async (extra = {}) => {
    const res = await admin({ action: "createLocalSale", org: "acme", items: [{ productId: "tee", qty: 1 }], ...extra });
    return { ...res, orderId: res.body.orderId };
  };
  const saleAudit = (orderId) => JSON.parse(q1("SELECT detail FROM audit_log WHERE action = 'order.created_local_sale' AND orderId = ?", orderId).detail);
  r = await sale({ customerName: "Pat Example", contact: " pat@EXAMPLE.com " });
  ok("a sale with a typed email joins the customer who has it (spaces around it and capitals don't matter)", r.status === 200 && linkOf(r.orderId) === patId && customers() === 2);
  ok("…and is taxed as usual, though that customer is exempt: nobody picked them", (await S.getOrderById(d1, r.orderId)).salesTax === 1.2);
  ok("…and its log entry names no customer", !("customerId" in saleAudit(r.orderId)));
  r = await sale({ customerName: "Robin Example", contact: "robin@example.com", shippingAddress: { name: "Robin Example", line1: "2 Example St", city: "Anytown", state: "OH", zip: "43000", phone: "555-0101" } });
  c = byEmail("robin@example.com");
  ok("a sale with a new email makes the customer, with the sale's name and its address and phone", r.status === 200 && c.length === 1 && linkOf(r.orderId) === c[0].id &&
    c[0].name === "Robin Example" && c[0].phone === "555-0101" && JSON.parse(c[0].addressJson).line1 === "2 Example St");
  const robinId = c[0].id;
  before = customers();
  r = await sale({ customerName: "Walk-in", contact: "555-0100" });
  ok("a sale whose contact is a phone number has no customer, and none is made", r.status === 200 && linkOf(r.orderId) === null && customers() === before);
  r = await sale({});
  ok("a sale with no contact at all has no customer either", r.status === 200 && linkOf(r.orderId) === null && customers() === before);

  // Picked on the form.
  r = await sale({ customerName: "Pat Example", contact: "pat@example.com", customerId: patId });
  ok("a sale with a customer picked belongs to that customer", r.status === 200 && linkOf(r.orderId) === patId);
  ok("…and, picked, the customer's exemption counts: no sales tax", (await S.getOrderById(d1, r.orderId)).salesTax === 0 && q1("SELECT taxExempt FROM orders WHERE orderId = ?", r.orderId).taxExempt === 1);
  ok("…and the log entry carries the customer's id", saleAudit(r.orderId).customerId === patId);
  before = customers();
  r = await sale({ customerName: "Front Desk", contact: "frontdesk@example.com", customerId: String(samId) });
  ok("the picked customer beats the email typed on the sale (an id sent as text is still an id)", r.status === 200 && linkOf(r.orderId) === samId);
  ok("…and no customer is made for that other email", customers() === before && byEmail("frontdesk@example.com").length === 0);
  ok("…and a picked customer who isn't exempt is taxed", (await S.getOrderById(d1, r.orderId)).salesTax === 1.2);
  r = await sale({ customerName: "Robin Example", contact: "robin@example.com", customerId: 987654 });
  ok("a picked id that is no customer is ignored: the sale goes through and falls back to the email", r.status === 200 && linkOf(r.orderId) === robinId && customers() === before);
  r = await sale({ customerName: "Walk-in", contact: "", customerId: 987654 });
  ok("…and with no email to fall back on, the sale has no customer", r.status === 200 && linkOf(r.orderId) === null && customers() === before);
  // A duplicate of Robin, folded into Robin.
  const dupId = await newCustomer({ name: "Robin E.", email: "robin.dup@example.com", taxExempt: true });
  r = await S.mergeCustomers(d1, { fromId: dupId, intoId: robinId });
  ok("(a duplicate is merged into the customer that is kept)", r.moved === 0 && q1("SELECT mergedIntoId FROM customers WHERE id = ?", dupId).mergedIntoId === robinId);
  before = customers();
  r = await sale({ customerName: "Sam Example", contact: "sam@example.com", customerId: dupId });
  ok("a picked customer that was merged away is ignored too: the email decides, and the duplicate's exemption doesn't apply", r.status === 200 && linkOf(r.orderId) === samId && customers() === before &&
    (await S.getOrderById(d1, r.orderId)).salesTax === 1.2);
  r = await sale({ customerName: "Robin E.", contact: "Robin.Dup@example.com" });
  ok("a sale with the merged-away duplicate's email goes to the customer that was kept, and brings no duplicate back", r.status === 200 && linkOf(r.orderId) === robinId && customers() === before);

  const orders = () => d1.q("SELECT count(*) AS n FROM orders")[0].n;
  before = orders();
  for (const bad of ["abc", 0, -3, 1.5, true, [patId], { id: patId }]) {
    r = await sale({ contact: "pat@example.com", customerId: bad });
    ok(`a customer id of ${JSON.stringify(bad)} is refused in plain words (400) and no sale is recorded`, r.status === 400 && r.body.message === "That customer isn't valid. Pick one from the list." && orders() === before);
  }
  r = await sale({ contact: "pat@example.com", customerId: "" });
  ok("an empty customer id is the same as none picked: the email decides", r.status === 200 && linkOf(r.orderId) === patId && !("customerId" in saleAudit(r.orderId)));
  r = await sale({ contact: "pat@example.com", customerId: null });
  ok("…and so is null", r.status === 200 && linkOf(r.orderId) === patId && (await S.getOrderById(d1, r.orderId)).salesTax === 1.2);
  before = orders();
  globalThis.__role276 = null;
  r = await sale({ contact: "pat@example.com", customerId: patId });
  ok("picking a customer needs the Customers permission: without it the sale is refused (403), nothing recorded", r.status === 403 && r.body.code === "forbidden" &&
    r.body.message === "Your role can't pick a customer for a sale. Ask an admin." && orders() === before);
  globalThis.__role276 = "production";
  r = await sale({ contact: "", customerId: patId });
  ok("a role that may only read Customers (Production) may pick one", r.status === 200 && linkOf(r.orderId) === patId);
  globalThis.__role276 = "admin";

  console.log("\n=== Imported orders ===");
  const unit = (order, fields) => ({ order, row: 2, lines: [{ order, date: "2026-06-10", customer: "Max Example", email: "", sku: "", item: "Team Hoodie", size: "M", qty: "1", price: "40.00", personalization: "", shipping: "0", paid: "", shipped: "", ...fields }] });
  before = customers();
  r = await admin({ action: "importOrders", org: "acme", dryRun: true, rows: [unit("P-1", { email: "max@example.com" })] });
  ok("the import's preview makes no customer", r.status === 200 && r.body.created === 1 && customers() === before && byEmail("max@example.com").length === 0);
  r = await admin({ action: "importOrders", org: "acme", rows: [unit("A-1", { email: "Max@Example.com" }), unit("A-2", { customer: "Pat E.", email: "PAT@EXAMPLE.COM" }), unit("A-3", { customer: "No Email" })] });
  const imported = (r.body.results || []).map(x => x.orderId);
  c = byEmail("max@example.com");
  ok("an imported order with a new email makes its customer, named as in the file", r.status === 200 && r.body.created === 3 && c.length === 1 && c[0].name === "Max Example" && linkOf(imported[0]) === c[0].id);
  ok("an imported order with a known email joins that customer", linkOf(imported[1]) === patId && byEmail("pat@example.com").length === 1 && byEmail("pat@example.com")[0].name === "Pat Example");
  ok("an imported order with no email has no customer", linkOf(imported[2]) === null && customers() === before + 1);

  console.log("\n=== findOrCreateCustomerForOrder_: what counts as an email ===");
  before = customers();
  const find = (args) => S.findOrCreateCustomerForOrder_(d1, args);
  ok("called with nothing, it answers null", (await S.findOrCreateCustomerForOrder_(d1)) === null);
  for (const [what, contact] of [["no contact", ""], ["a missing contact", undefined], ["null", null], ["a phone number", "555-0100"], ["a name", "Pat Example"],
    ["an address with no dot after the @", "pat@example"], ["two @ signs", "pat@@example.com"], ["a space inside", "pat example@example.com"],
    ["nothing before the @", "@example.com"], ["an email longer than 200 characters", "p".repeat(190) + "@example.com"]]) {
    ok(`${what} links nothing`, (await find({ name: "Nobody", contact })) === null);
  }
  ok("…and none of those made a customer", customers() === before);
  ok("an email of exactly 200 characters is one", (await find({ name: "Long", contact: "p".repeat(188) + "@example.com" })) > 0 && customers() === before + 1);
  ok("tabs and line breaks around the email are padding", (await find({ contact: "\t pat@example.com \n" })) === patId);
  ok("normalizeCustomerEmail_ gives the email trimmed and in lower case, or nothing", S.normalizeCustomerEmail_("  Pat@Example.COM ") === "pat@example.com" &&
    S.normalizeCustomerEmail_("555-0100") === "" && S.normalizeCustomerEmail_(null) === "" && S.normalizeCustomerEmail_(undefined) === "" && S.normalizeCustomerEmail_(42) === "");
  ok("…lowering only A to Z, as the database does", S.normalizeCustomerEmail_("ÉLAN@Example.com") === "Élan@example.com");

  console.log("\n=== What a new customer is made with ===");
  id = await find({ name: "  " + "N".repeat(250) + "  ", contact: "long@example.com", phone: "  " + "5".repeat(60) + " ",
    address: { name: " Lou Example ", line1: "L".repeat(250), line2: "   ", city: "Anytown", state: "OH", zip: "43000", country: "US", phone: "555-0102", notes: "leave at door", extra: { a: 1 }, line3: "x" } });
  c = q1("SELECT * FROM customers WHERE id = ?", id);
  ok("the name is trimmed and cut at 200 characters, the phone at 50", c.name === "N".repeat(200) && c.phone === "5".repeat(50));
  let a = JSON.parse(c.addressJson);
  ok("the address keeps its eight known fields, trimmed, each cut at 200", a.name === "Lou Example" && a.line1 === "L".repeat(200) && a.city === "Anytown" && a.state === "OH" &&
    a.zip === "43000" && a.country === "US" && a.phone === "555-0102");
  ok("…and nothing else: blank fields and unknown ones are left out", Object.keys(a).sort().join(",") === "city,country,line1,name,phone,state,zip");
  id = await find({ contact: "bare@example.com" });
  c = q1("SELECT * FROM customers WHERE id = ?", id);
  ok("with only an email, the name, phone and address are empty", c.name === "" && c.phone === "" && c.addressJson === "");
  for (const [what, address] of [["a list", ["1 Example St"]], ["text", "1 Example St"], ["an address of blanks", { line1: "  ", city: "" }], ["an address whose fields are objects", { line1: { a: 1 }, city: ["x"] }]]) {
    id = await find({ name: "Addr", contact: "addr" + (++n) + "@example.com", address });
    ok(`${what} for an address is kept as no address`, q1("SELECT addressJson FROM customers WHERE id = ?", id).addressJson === "");
  }
  id = await find({ name: "Num", contact: "num@example.com", phone: 5550100, address: { zip: 43000 } });
  c = q1("SELECT * FROM customers WHERE id = ?", id);
  ok("a phone or ZIP sent as a number is kept as text", c.phone === "5550100" && JSON.parse(c.addressJson).zip === "43000");
  let oid = await place({ customerName: "Kit Example", contact: "kit@example.com", phone: "555-0103", shippingAddress: { name: "Kit Example", line1: "3 Example St", phone: "555-0199" } });
  c = byEmail("kit@example.com")[0];
  ok("insertOrder passes the order's name, its own phone ahead of the address's, and the ship-to address", linkOf(oid) === c.id && c.name === "Kit Example" && c.phone === "555-0103" &&
    JSON.parse(c.addressJson).line1 === "3 Example St" && JSON.parse(c.addressJson).phone === "555-0199");
  oid = await place({ customerName: "Kim Example", contact: "kim@example.com", shippingAddress: { line1: "4 Example St", phone: "555-0104" } });
  ok("…and the address's phone when the order has none", byEmail("kim@example.com")[0].phone === "555-0104" && linkOf(oid) === byEmail("kim@example.com")[0].id);
  before = customers();
  const both = await Promise.all([find({ name: "First", contact: "twice@example.com" }), find({ name: "Second", contact: "TWICE@example.com" })]);
  ok("two orders placed at once with a new email make one customer, and both find it", both[0] > 0 && both[0] === both[1] && customers() === before + 1 && byEmail("twice@example.com").length === 1);

  console.log("\n=== A test order joins its customer, never makes one ===");
  before = customers();
  ok("find-only with an unknown email answers null and makes nobody", (await find({ name: "Tester", contact: "tester@example.com", findOnly: true })) === null && customers() === before);
  ok("find-only with a known email finds the customer", (await find({ contact: "PAT@example.com", findOnly: true })) === patId);
  oid = await place({ isTest: true, customerName: "Tester", contact: "tester@example.com" });
  ok("a test order with a new email is saved with no customer", linkOf(oid) === null && customers() === before && q1("SELECT isTest FROM orders WHERE orderId = ?", oid).isTest === 1);
  oid = await place({ isTest: true, contact: "pat@example.com" });
  ok("a test order with a known email joins that customer", linkOf(oid) === patId && customers() === before);
  oid = await place({ isTest: true, contact: "tester@example.com" }, { customerId: samId });
  ok("a test order with a customer picked belongs to the picked one", linkOf(oid) === samId && customers() === before);
  oid = await place({ contact: "tester@example.com" });
  ok("the same email on a real order then makes the customer", byEmail("tester@example.com").length === 1 && linkOf(oid) === byEmail("tester@example.com")[0].id && customers() === before + 1);

  console.log("\n=== An archived customer ===");
  await S.setCustomerArchived(d1, samId, true);
  const archivedAt = q1("SELECT archivedAt FROM customers WHERE id = ?", samId).archivedAt;
  before = customers();
  oid = await place({ contact: "Sam@Example.com" });
  ok("still receives the orders placed with its email: no new customer is made", !!archivedAt && linkOf(oid) === samId && customers() === before);
  ok("…and stays archived, as it was", q1("SELECT archivedAt FROM customers WHERE id = ?", samId).archivedAt === archivedAt);
  oid = await place({ contact: "" }, { customerId: samId });
  ok("…and can still be picked", linkOf(oid) === samId && q1("SELECT archivedAt FROM customers WHERE id = ?", samId).archivedAt === archivedAt);

  console.log("\n=== A merged-away duplicate's email ===");
  before = customers();
  oid = await place({ contact: "robin.dup@example.com" });
  ok("an order with it goes to the customer the duplicate was merged into", linkOf(oid) === robinId && customers() === before);
  ok("…for a test order too", (await find({ contact: "robin.dup@example.com", findOnly: true })) === robinId);
  // A live customer may have the same email as a merged-away one (the index only counts live ones).
  const liveDup = await newCustomer({ name: "Robin Again", email: "robin.dup@example.com" });
  oid = await place({ contact: "robin.dup@example.com" });
  ok("a live customer with that email comes first", liveDup > 0 && liveDup !== robinId && linkOf(oid) === liveDup);
  // Two merged-away duplicates with one email, kept by different customers: the later duplicate's says where.
  const keepA = await newCustomer({ name: "Keep A", email: "keep.a@example.com" }), keepB = await newCustomer({ name: "Keep B", email: "keep.b@example.com" });
  const oldDup = await newCustomer({ name: "Twin 1", email: "twin@example.com" });
  await S.mergeCustomers(d1, { fromId: oldDup, intoId: keepA });
  const newDup = await newCustomer({ name: "Twin 2", email: "twin@example.com" });
  await S.mergeCustomers(d1, { fromId: newDup, intoId: keepB });
  before = customers();
  oid = await place({ contact: "twin@example.com" });
  ok("with two merged-away duplicates of one email, the order follows the newer one", newDup > oldDup && linkOf(oid) === keepB && customers() === before);
  // A chain that was never re-pointed (not something mergeCustomers leaves): the customer it leads to isn't live.
  const chainEnd = await newCustomer({ name: "Chain end", email: "chain.end@example.com" }), chainMid = await newCustomer({ name: "Chain mid", email: "chain.mid@example.com" });
  const chainDup = await newCustomer({ name: "Chain dup", email: "chain.dup@example.com" });
  d1._raw.run("UPDATE customers SET mergedIntoId = ? WHERE id = ?", [chainEnd, chainMid]);
  d1._raw.run("UPDATE customers SET mergedIntoId = ? WHERE id = ?", [chainMid, chainDup]);
  before = customers();
  ok("a duplicate merged into a customer that was itself merged away leads nowhere: a find-only (test) order with its email gets no customer", (await find({ contact: "chain.dup@example.com", findOnly: true })) === null && customers() === before);
  oid = await place({ customerName: "Chain Example", contact: "chain.dup@example.com" });
  c = d1.q("SELECT id FROM customers WHERE email = 'chain.dup@example.com' AND mergedIntoId IS NULL");
  ok("…and a real order with it goes to neither of them: a new customer is made", c.length === 1 && linkOf(oid) === c[0].id &&
    c[0].id !== chainMid && c[0].id !== chainDup && customers() === before + 1);

  console.log("\n=== A picked customer (insertOrder opts.customerId) ===");
  before = customers();
  oid = await place({ contact: "sam@example.com" }, { customerId: robinId });
  ok("the picked customer beats the order's email", linkOf(oid) === robinId);
  oid = await place({ contact: "brandnew@example.com" }, { customerId: String(robinId) });
  ok("…and the email, being beaten, makes no customer", linkOf(oid) === robinId && customers() === before && byEmail("brandnew@example.com").length === 0);
  oid = await place({ contact: "555-0100" }, { customerId: robinId });
  ok("an order with a phone number for a contact belongs to the picked customer", linkOf(oid) === robinId);
  oid = await place({ contact: "sam@example.com" }, { customerId: 987654 });
  ok("an unknown picked id is ignored and the email decides", linkOf(oid) === samId);
  oid = await place({ contact: "sam@example.com" }, { customerId: dupId });
  ok("a merged-away picked id is ignored and the email decides", linkOf(oid) === samId);
  oid = await place({ contact: "" }, { customerId: dupId });
  ok("…and with no email, a merged-away pick leaves the order with no customer (it does not follow the merge)", linkOf(oid) === null);
  for (const bad of [0, -1, 2.5, "abc", "", null, undefined]) {
    oid = await place({ contact: "sam@example.com" }, { customerId: bad });
    ok(`a picked id of ${bad === undefined ? "undefined" : JSON.stringify(bad)} is no pick: the email decides`, linkOf(oid) === samId);
  }
  ok("none of that made a customer", customers() === before);

  console.log("\n=== Only a picked customer's exemption counts ===");
  const taxOf = async (orderId) => { const o = await S.getOrderById(d1, orderId); return { tax: o.salesTax, exempt: !!o.taxExempt }; };
  const exemptId = await newCustomer({ name: "Example Club", email: "club@example.com", taxExempt: true, taxExemptCertificate: "EX-000" });
  oid = await place({ contact: "club@example.com" });
  r = await taxOf(oid);
  ok("found by its email, an exempt customer's order is taxed (10.00 → 0.60)", linkOf(oid) === exemptId && r.tax === 0.6 && !r.exempt);
  oid = await place({ contact: "" }, { customerId: exemptId });
  r = await taxOf(oid);
  ok("picked, the order is exempt", linkOf(oid) === exemptId && r.tax === 0 && r.exempt);
  oid = await place({ contact: "sam@example.com" }, { customerId: exemptId });
  ok("…whatever email the order carries", (await taxOf(oid)).exempt && linkOf(oid) === exemptId);
  oid = await place({ contact: "club@example.com" }, { customerId: samId });
  ok("picking a customer who isn't exempt, with an exempt customer's email on the order, is taxed", linkOf(oid) === samId && (await taxOf(oid)).tax === 0.6);
  await S.saveCustomer(d1, { id: exemptId, taxExemptExpires: "2026-06-15" });
  oid = await place({ contact: "", placedAt: "2026-06-15T12:00:00.000Z" }, { customerId: exemptId });
  ok("an exemption that expires on the order's day still covers it", (await taxOf(oid)).exempt);
  oid = await place({ contact: "", placedAt: "2026-06-16T12:00:00.000Z" }, { customerId: exemptId });
  r = await taxOf(oid);
  ok("the day after it expires, the picked customer's order is taxed, and still theirs", !r.exempt && r.tax === 0.6 && linkOf(oid) === exemptId);
  oid = await place({ contact: "", placedAt: "2026-06-16T03:00:00.000Z" }, { customerId: exemptId });
  ok("with no Region time zone saved, the order's day is the UTC day (03:00 UTC on the 16th is past the 15th)", !(await taxOf(oid)).exempt);
  await S.setLocaleSettings(d1, { timeZone: "America/New_York" });
  oid = await place({ contact: "", placedAt: "2026-06-16T03:00:00.000Z" }, { customerId: exemptId });
  ok("with the Region time zone saved, it is the business's day (still the 15th in New York): exempt", (await taxOf(oid)).exempt);
  await S.setLocaleSettings(d1, { timeZone: "" });
  await S.saveCustomer(d1, { id: exemptId, taxExempt: false, taxExemptExpires: "" });
  oid = await place({ contact: "" }, { customerId: exemptId });
  ok("once the box is unticked, a picked customer's order is taxed", !(await taxOf(oid)).exempt);

  console.log("\n=== setOrderCustomer ===");
  const loose = await place({ customerName: "Walk-in", contact: "555-0100" });
  const asPlaced = JSON.stringify(q1("SELECT customerName, contact, taxExempt, taxRateBps, subtotalCents, totalCents FROM orders WHERE orderId = ?", loose));
  r = await S.setOrderCustomer(d1, loose, patId);
  ok("links an order that had no customer, and says it had none", r.ok === true && r.before === null && !r.error && linkOf(loose) === patId);
  ok("…leaving the order's name, contact and tax as placed (Pat is exempt; the order is not)", JSON.stringify(q1("SELECT customerName, contact, taxExempt, taxRateBps, subtotalCents, totalCents FROM orders WHERE orderId = ?", loose)) === asPlaced);
  r = await S.setOrderCustomer(d1, loose, String(robinId));
  ok("moves it to another customer (an id as text will do), and says whose it was", r.ok === true && r.before === patId && linkOf(loose) === robinId);
  r = await S.setOrderCustomer(d1, loose, robinId);
  ok("linking it to the customer it already has is fine and changes nothing", r.ok === true && r.before === robinId && linkOf(loose) === robinId);
  r = await S.setOrderCustomer(d1, loose, samId);
  ok("an archived customer can be linked", r.ok === true && linkOf(loose) === samId);
  r = await S.setOrderCustomer(d1, loose, 987654);
  ok("an unknown customer is refused in plain words, the order left as it was", r.error === "That customer wasn't found." && !r.ok && linkOf(loose) === samId);
  r = await S.setOrderCustomer(d1, loose, dupId);
  ok("a merged-away customer is refused the same way", r.error === "That customer wasn't found." && linkOf(loose) === samId);
  for (const bad of ["abc", 0, -2, 1.5, false]) {
    r = await S.setOrderCustomer(d1, loose, bad);
    ok(`a customer id of ${JSON.stringify(bad)} is refused, the order left as it was`, r.error === "That customer wasn't found." && linkOf(loose) === samId);
  }
  r = await S.setOrderCustomer(d1, loose, null);
  ok("null unlinks, and says whose it was", r.ok === true && r.before === samId && linkOf(loose) === null);
  r = await S.setOrderCustomer(d1, loose, null);
  ok("unlinking an order with no customer is fine", r.ok === true && r.before === null && linkOf(loose) === null);
  await S.setOrderCustomer(d1, loose, patId);
  r = await S.setOrderCustomer(d1, loose, "");
  ok("an empty id unlinks too", r.ok === true && r.before === patId && linkOf(loose) === null);
  await S.setOrderCustomer(d1, loose, patId);
  r = await S.setOrderCustomer(d1, loose);
  ok("…and so does none given", r.ok === true && r.before === patId && linkOf(loose) === null);
  const linked = () => d1.q("SELECT count(*) AS n FROM orders WHERE customerId IS NOT NULL")[0].n;
  before = linked();
  r = await S.setOrderCustomer(d1, "NO-SUCH-ORDER", patId);
  ok("an unknown order is refused in plain words", r.error === "That order wasn't found." && !r.ok && linked() === before);
  r = await S.setOrderCustomer(d1, "NO-SUCH-ORDER", null);
  ok("…when unlinking too", r.error === "That order wasn't found.");
  r = await S.setOrderCustomer(d1, null, patId);
  ok("…and so is no order at all", r.error === "That order wasn't found." && linked() === before);
  r = await S.setOrderCustomer(d1, "NO-SUCH-ORDER", 987654);
  ok("an unknown order with an unknown customer: the order is what's named", r.error === "That order wasn't found.");

  console.log("\n=== The order readers give the order's customer ===");
  await S.setOrderCustomer(d1, loose, null);
  const some = await place({ contact: "pat@example.com" });
  r = await S.getOrderById(d1, some);
  ok("getOrderById: the customer's id as a number", r.customerId === patId && typeof r.customerId === "number");
  ok("getOrderById: null for an order with none", (await S.getOrderById(d1, loose)).customerId === null);
  const check = (list) => { const m = Object.fromEntries(list.map(o => [o.orderId, o.customerId])); return m[some] === patId && m[loose] === null && m["WEB-3"] === samId; };
  ok("getOrdersByOrg: each order's customer, null for none", check(await S.getOrdersByOrg(d1, "acme")));
  ok("getOrdersByIds: the same", check(await S.getOrdersByIds(d1, [some, loose, "WEB-3"])));
  ok("getOpenOrders: the same", check(await S.getOpenOrders(d1)));
  ok("every order the readers give has the field", (await S.getOrdersByOrg(d1, "acme")).every(o => o.customerId === null || (Number.isInteger(o.customerId) && o.customerId > 0)));

  console.log("\n=== A database that hasn't had migrations/0108 yet ===");
  const old = await newDb("0108");
  ok("(it has no customers table and no orders.customerId)", d1.q("SELECT count(*) AS n FROM sqlite_master WHERE name = 'customers'")[0].n === 1 &&
    old.q("SELECT count(*) AS n FROM sqlite_master WHERE name = 'customers'")[0].n === 0 && !old.q("PRAGMA table_info(orders)").some(col => col.name === "customerId"));
  ok("findOrCreateCustomerForOrder_ answers null instead of failing", (await S.findOrCreateCustomerForOrder_(old, { name: "Pat Example", contact: "pat@example.com" })) === null &&
    (await S.findOrCreateCustomerForOrder_(old, { contact: "pat@example.com", findOnly: true })) === null);
  const oldPlace = (orderId, order, opts) => S.insertOrder(old, { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-06-15T12:00:00.000Z", ...order }, line, opts);
  ok("an order with an email is still taken", (await rejects(() => oldPlace("OLD-1"))) === "" && old.q("SELECT count(*) AS n FROM orders WHERE orderId = 'OLD-1'")[0].n === 1);
  ok("…and one with a customer picked", (await rejects(() => oldPlace("OLD-2", {}, { customerId: 1 }))) === "" && old.q("SELECT count(*) AS n FROM order_items WHERE orderId = 'OLD-2'")[0].n === 1);
  ok("…and a test order, and one with no contact", (await rejects(() => oldPlace("OLD-3", { isTest: true }))) === "" && (await rejects(() => oldPlace("OLD-4", { contact: "" }))) === "" &&
    old.q("SELECT count(*) AS n FROM orders")[0].n === 4);
  ok("…taxed as usual (no customer, no exemption)", old.q("SELECT taxExempt FROM orders WHERE orderId = 'OLD-2'")[0].taxExempt === 0);
  const oldOrder = await S.getOrderById(old, "OLD-1");
  ok("getOrderById reads it, with a customerId of null", !!oldOrder && oldOrder.contact === "pat@example.com" && oldOrder.customerId === null);
  const oldLists = [await S.getOrdersByOrg(old, "acme"), await S.getOrdersByIds(old, ["OLD-1", "OLD-2"]), await S.getOpenOrders(old)];
  ok("getOrdersByOrg, getOrdersByIds and getOpenOrders read them too, each with a customerId of null", oldLists[0].length === 4 && oldLists[1].length === 2 && oldLists[2].length === 3 &&
    oldLists.every(list => list.every(o => o.customerId === null)));
  ok("setOrderCustomer has nothing to write to there, and says so by failing", /no such (table|column)/i.test(await rejects(() => S.setOrderCustomer(old, "OLD-1", 1))));
  const oldCall = async (url, body) => {
    const waits = [];
    const res = await S.post({ env: { DB: old, ...ENV }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})), request: { url, json: async () => body, headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  await S.createProduct(old, "acme", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, weightOz: 6 });
  r = await oldCall(shopOrigin("acme") + "/api/orders", { orderId: "OLD-WEB", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check", items: [{ productId: "tee", qty: 1 }] });
  ok("the storefront still takes an order there", r.status === 200 && old.q("SELECT count(*) AS n FROM orders WHERE orderId = 'OLD-WEB'")[0].n === 1);
  r = await oldCall(ADMIN_ORIGIN + "/api/orders", { key: "x", action: "createLocalSale", org: "acme", items: [{ productId: "tee", qty: 1 }], contact: "pat@example.com", customerId: 1 });
  ok("…and a local sale goes through, even with a customer picked", r.status === 200 && old.q("SELECT count(*) AS n FROM orders WHERE orderId = ?", r.body.orderId)[0].n === 1);

  console.log("\n=== Any other database failure is not hidden ===");
  const broken = { prepare: () => { throw new Error("D1_ERROR: disk I/O error"); } };
  ok("findOrCreateCustomerForOrder_ passes on an error that isn't a missing migration", /disk I\/O error/.test(await rejects(() => S.findOrCreateCustomerForOrder_(broken, { contact: "pat@example.com" }))));
  ok("…but never touches the database for a contact that isn't an email", (await S.findOrCreateCustomerForOrder_(broken, { contact: "555-0100" })) === null);
})().catch(e => { console.error(e); ok("test302 ran to the end without an error", false); });
