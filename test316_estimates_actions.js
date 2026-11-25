const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const roles = require("./testlib/roles");
const { makeAuth, prelude, strip, read, request, answer } = require("./testlib/auth-harness");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

// Quotes (migrations/0109; "estimates" in code): the seven quote actions of /api/orders, through the real handler.
//   - who may: every built-in role behind the REAL sign-in gate (adminAuth.js), signed out, and made-up roles for
//     the extra checks inside createEstimate, saveEstimate and convertEstimate
//   - listEstimates, getEstimate, createEstimate, saveEstimate (each kind of line, quantity breaks counted across the
//     quote, the 100-line and 5,000-piece limits, every refusal), sendEstimate (the link, the email, sending again),
//     convertEstimate (convertEstimateToOrder_: the order at the quoted prices, fee lines, the customer, idempotent,
//     the invoice), cancelEstimate (audited first)
//   - the audit rows, the Quotes feature switch, the period guard, the desktop edition, a database without 0109
// Real SQL (sql.js) under the real db.js, email.js and orders.js. Invented shops, customers and products only.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => Object.keys(o || {}).sort().join(",");
const forbidden = (r) => r.status === 403 && r.body && r.body.status === "error" && r.body.code === "forbidden";
const refused = (r, status, message) => r.status === status && r.body && r.body.status === "error" && r.body.message === message;
const ROLE = "Your role can't do this. Ask an admin.", NOT_VALID = "That quote isn't valid.", NOT_FOUND = "Quote not found";
const SEVEN = ["listEstimates", "getEstimate", "createEstimate", "saveEstimate", "sendEstimate", "convertEstimate", "cancelEstimate"];
const ordersJs = read("functions/api/orders.js");

(async () => {
  console.log("=== The permission, the feature switch and the lists in orders.js ===");
  {
    const areas = roles.PERMISSION_AREAS, at = areas.findIndex(a => a.key === "quotes");
    ok("Quotes is a permission area of its own, right after Customers", at > 0 && areas[at - 1].key === "customers");
    ok("…with one page (quotes) and one function: quotes.estimates, \"Quotes\"",
      same(areas[at], { key: "quotes", label: "Quotes", items: [{ hash: "quotes", label: "Quotes", fns: [["quotes.estimates", "Quotes"]] }] }));
    const perm = (a) => roles.ACTION_PERM[a];
    ok("listing and opening quotes need quotes.estimates at read", same(perm("listEstimates"), [["quotes.estimates", "read"]]) && same(perm("getEstimate"), [["quotes.estimates", "read"]]));
    ok("making, saving, sending and converting need it at edit", ["createEstimate", "saveEstimate", "sendEstimate", "convertEstimate"].every(a => same(perm(a), [["quotes.estimates", "edit"]])));
    ok("cancelling needs it at full", same(perm("cancelEstimate"), [["quotes.estimates", "full"]]));
    const level = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role])["quotes.estimates"];
    ok("built-in defaults: Admin and Manager full, Back office edit, Production none",
      ["admin", "manager", "staff", "production"].map(level).join() === "full,full,edit,none");
    const featureList = (ordersJs.match(/\n  quotes: \[([\s\S]*?)\],/) || [])[1] || "";
    ok("every quote action is listed under the quotes feature switch in orders.js", SEVEN.every(a => featureList.includes('"' + a + '"')) && [...featureList.matchAll(/"(\w+)"/g)].length === 7);
    const noMonth = [...ordersJs.match(/const NO_MONTH_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ok("making, saving, sending and cancelling a quote change no month's numbers; converting one isn't on that list",
      ["createEstimate", "saveEstimate", "sendEstimate", "cancelEstimate"].every(a => noMonth.includes(a)) && !noMonth.includes("convertEstimate"));
    const desktop = (ordersJs.match(/const DESKTOP_REFUSED_ACTIONS = new Set\(\[([\s\S]*?)\]\);/) || [])[1] || "";
    ok("sending a quote is one of the desktop edition's refused actions; the other six aren't", desktop.includes('"sendEstimate"') && SEVEN.filter(a => a !== "sendEstimate").every(a => !desktop.includes('"' + a + '"')));
  }

  // ---- The real endpoint behind the real sign-in (adminAuth.js), on schema.sql ----
  // The catalog stand-in carries the feature switches from globalThis.__t316Features (the gate reads them there).
  const STUB = "const getCatalogData = async () => ({ subdomainMap: {}, business: {} });";
  const pre = prelude(false, false);
  if (!pre.includes(STUB)) throw new Error("testlib/auth-harness.js's catalog stand-in changed: update test316");
  const A = await makeAuth();
  const d1 = A.d1;
  Object.assign(A.env, MAIL_ENV);
  const post = new Function("__hits", pre.replace(STUB, "const getCatalogData = async () => ({ subdomainMap: {}, business: {}, features: globalThis.__t316Features || {} });") +
    strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
    "const invalidateCatalogVersionCache = () => {}; const selectBox = () => null;\n" +
    strip(read("functions/_lib/setupStatus.js")) + "\n" + strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" +
    strip(read("functions/_lib/email.js")) + "\n" + strip(ordersJs) + "\nreturn onRequestPost;")(A.hits);
  // Mail goes out through Cloudflare Email Service's REST call, captured here; mailFails makes it fail.
  const mails = []; let mailFails = false;
  globalThis.fetch = async (url, init) => {
    if (captureMail(url, init, mails)) return mailFails ? { ok: false, status: 500, json: async () => ({ success: false, errors: [{ message: "down" }] }), text: async () => "down" } : MAIL_OK;
    throw new Error("test316: unexpected fetch " + url);
  };
  const call = async (body, cookie) => {
    const waits = [];
    const res = await post({ request: request("/api/orders", body, { cookie }), env: A.env, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})) });
    await Promise.all(waits);
    return answer(res);
  };
  // The server logs an expected failure (a failed email, a refused audit write) with console.error; kept out of the output.
  const quietly = async (fn) => { const err = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = err; } };
  const q = (sql) => d1.q(sql);
  const estRow = (id) => q("SELECT * FROM estimates WHERE id = " + Number(id))[0] || null;
  const itemRows = (id) => q("SELECT * FROM estimate_items WHERE estimateId = " + Number(id) + " ORDER BY position");
  const orderRow = (id) => q("SELECT * FROM orders").find(o => o.orderId === id) || null;
  const orderLines = (id) => q("SELECT * FROM order_items ORDER BY id").filter(l => l.orderId === id);
  const auditRows = (action) => q("SELECT * FROM audit_log ORDER BY id").filter(r => r.action === action).map(r => ({ ...r, detail: JSON.parse(r.detail || "null") }));
  const auditCount = () => q("SELECT count(*) n FROM audit_log")[0].n;
  const estCount = () => q("SELECT count(*) n FROM estimates")[0].n;
  const orderCount = () => q("SELECT count(*) n FROM orders")[0].n;
  const logged = async (body, cookie) => { const before = q("SELECT COALESCE(MAX(id), 0) m FROM audit_log")[0].m; const r = await call(body, cookie);
    return { ...r, rows: q("SELECT * FROM audit_log WHERE id > " + before + " ORDER BY id").map(x => ({ ...x, detail: JSON.parse(x.detail || "null") })) }; };

  const admin = await A.firstAdmin("Olive Owner", "olive@example.com");
  const manager = await A.addUser(admin, "manager", "Mo Manager", "mo@example.com");
  const staff = await A.addUser(admin, "staff", "Sam Staff", "sam@example.com");
  const prod = await A.addUser(admin, "production", "Pat Production", "pp@example.com");
  const staffRole = (await A.users({ action: "listRoles" }, admin)).body.roles.find(x => x.key === "staff");
  const roleWith = async (name, change) => {
    const permissions = JSON.parse(JSON.stringify(staffRole.permissions)); change(permissions);
    const r = await A.users({ action: "saveRole", name, rank: 40, permissions }, admin);
    return r.body.role.key;
  };
  // Back office with one thing taken away each.
  const noCustomers = await A.addUser(admin, await roleWith("Quotes only", (p) => { p.fns["customers.records"] = "none"; }), "Quinn Quotes", "quinn@example.com");
  const noPayments = await A.addUser(admin, await roleWith("No payments", (p) => { p.fns["orders.payments"] = "none"; }), "Nell Nopay", "nell@example.com");
  const noOrders = await A.addUser(admin, await roleWith("No orders", (p) => { p.fns["orders.details"] = "none"; }), "Ozzie Noorder", "ozzie@example.com");
  const noInvoices = await A.addUser(admin, await roleWith("No invoices", (p) => { p.fns["orders.invoices"] = "none"; }), "Ivy Noinvoice", "ivy@example.com");
  const me = async (cookie) => (await A.users({ action: "me" }, cookie)).body.permissions;
  {
    const [c, p, o, i, s, pr] = [await me(noCustomers), await me(noPayments), await me(noOrders), await me(noInvoices), await me(staff), await me(prod)];
    ok("the roles under test are what they should be: Back office has Quotes at edit, Production none, and each made-up role lacks only its one thing",
      s["quotes.estimates"] === "edit" && pr["quotes.estimates"] === "none" &&
      c["customers.records"] === "none" && c["quotes.estimates"] === "edit" && p["orders.payments"] === "none" && p["quotes.estimates"] === "edit" &&
      o["orders.details"] === "none" && o["quotes.estimates"] === "edit" && i["orders.invoices"] === "none" && i["orders.details"] === "edit" && i["quotes.estimates"] === "edit");
  }

  // Shops, products (never published, so priced live), the tax settings and customers.
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('beta','','Example Second Shop','t','t');`);
  const product = (cols) => { const c = Object.assign({ orgId: "acme", type: "shirt", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, cols);
    d1._raw.run(`INSERT INTO products (${Object.keys(c).join(",")}) VALUES (${Object.keys(c).map(() => "?").join(",")})`, Object.values(c)); };
  // Polo: $20, $5 personalization, $2 off each from 12 pieces and $5 off from 48. Cap: by size, not taxable, $3 off from 12.
  product({ productId: "polo", name: "Example Polo", pricingMode: "flat", flatPriceCents: 2000, personalizationPriceCents: 500, taxable: 1,
    qtyBreaksJson: JSON.stringify([{ minQty: 12, offCents: 200 }, { minQty: 48, offCents: 500 }]) });
  product({ productId: "cap", name: "Example Cap", type: "cap", pricingMode: "sized", sizePricingCents: JSON.stringify({ S: 1500, L: 1700 }), taxable: 0,
    qtyBreaksJson: JSON.stringify([{ minQty: 12, offCents: 300 }]) });
  product({ productId: "hidden", name: "Hidden Example", pricingMode: "flat", flatPriceCents: 1000, visible: 0 });
  product({ productId: "tote", orgId: "beta", name: "Example Tote", type: "bag", pricingMode: "flat", flatPriceCents: 1200, taxable: 1 });
  const setTax = (rateBps, taxMode) => d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', ?)", [JSON.stringify({ rateBps, taxShipping: false, jurisdiction: "", taxMode })]);
  setTax(1000, "exclusive");
  const spare = (name, extra = {}) => { const cols = Object.assign({ name, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, extra);
    d1._raw.run(`INSERT INTO customers (${Object.keys(cols).join(",")}) VALUES (${Object.keys(cols).map(() => "?").join(",")})`, Object.values(cols));
    return q("SELECT MAX(id) m FROM customers")[0].m; };
  const pat = spare("Pat Example", { email: "pat@example.com", phone: "555-0110" });
  const lee = spare("Lee Example", { phone: "555-0111" });
  const kim = spare("Kim Example", { email: "kim@example.com", taxExempt: 1, taxExemptCertificate: "EX-0316" });
  const gone = spare("Merged Example", { email: "merged@example.com", mergedIntoId: pat });
  const newQuote = async (extra, cookie = admin) => (await call(Object.assign({ action: "createEstimate", org: "acme", customerId: pat }, extra || {}), cookie)).body;
  const save = (id, items, extra, cookie = admin) => call(Object.assign({ action: "saveEstimate", id, items }, extra || {}), cookie);

  console.log("\n=== Signed out: nothing answers ===");
  {
    const est = await newQuote({ title: "Signed-out probe" });
    const before = [estCount(), orderCount(), auditCount(), JSON.stringify(estRow(est.id))];
    const bodies = { listEstimates: {}, getEstimate: { id: est.id }, createEstimate: { org: "acme", customerId: pat }, saveEstimate: { id: est.id, title: "Changed" },
      sendEstimate: { id: est.id, email: "pat@example.com" }, convertEstimate: { id: est.id }, cancelEstimate: { id: est.id } };
    const got = [];
    for (const a of SEVEN) got.push(await call(Object.assign({ action: a }, bodies[a]), ""));
    ok("each of the seven quote actions answers 401 Unauthorized without a session", got.every(r => refused(r, 401, "Unauthorized")));
    ok("…and gives nothing away: only a status and a message", got.every(r => keys(r.body) === "message,status"));
    ok("nothing was made, changed, sent or logged", same(before, [estCount(), orderCount(), auditCount(), JSON.stringify(estRow(est.id))]) && mails.length === 0);
    await call({ action: "cancelEstimate", id: est.id }, admin);
  }

  console.log("\n=== Who may: each built-in role ===");
  {
    // Bodies refused AFTER the gate (404 / 200) so every role can send them and change nothing: 403 is the gate's answer.
    const probe = { listEstimates: { limit: 1 }, getEstimate: { id: 987654 }, createEstimate: { org: "acme", customerId: 987654 }, saveEstimate: { id: 987654, title: "x" },
      sendEstimate: { id: 987654 }, convertEstimate: { id: 987654 }, cancelEstimate: { id: 987654 } };
    const who = { admin, manager, staff, production: prod };
    const row = async (a) => { const out = []; for (const r of ["production", "staff", "manager", "admin"]) { const x = await call(Object.assign({ action: a }, probe[a]), who[r]);
      out.push(forbidden(x) ? (x.body.message === ROLE ? "no" : "no?") : x.status === 401 ? "out" : "yes"); } return out.join(); };
    const log = auditCount();
    ok("listEstimates: not Production (\"Your role can't do this. Ask an admin.\"); Back office, Manager and Admin", await row("listEstimates") === "no,yes,yes,yes");
    ok("getEstimate: not Production; Back office, Manager and Admin", await row("getEstimate") === "no,yes,yes,yes");
    ok("createEstimate: not Production; Back office, Manager and Admin", await row("createEstimate") === "no,yes,yes,yes");
    ok("saveEstimate: not Production; Back office, Manager and Admin", await row("saveEstimate") === "no,yes,yes,yes");
    ok("sendEstimate: not Production; Back office, Manager and Admin", await row("sendEstimate") === "no,yes,yes,yes");
    ok("convertEstimate: not Production; Back office, Manager and Admin", await row("convertEstimate") === "no,yes,yes,yes");
    ok("cancelEstimate: not Production or Back office; Manager and Admin", await row("cancelEstimate") === "no,no,yes,yes");
    ok("a refusal for the role writes nothing to the audit log", auditCount() === log);

    const n = estCount();
    let r = await call({ action: "createEstimate", org: "acme", customerId: pat, title: "By production" }, prod);
    ok("Production can't make a quote: 403, none is made", forbidden(r) && estCount() === n);
    r = await call({ action: "createEstimate", org: "acme", customerId: pat, title: "By back office" }, staff);
    const sid = r.body.id;
    ok("Back office makes one", r.status === 200 && estRow(sid).title === "By back office" && estRow(sid).createdBy === "sam@example.com");
    const cancels = auditRows("estimate.cancelled").length;
    r = await call({ action: "cancelEstimate", id: sid }, staff);
    ok("…but can't cancel it: 403, still a draft, no estimate.cancelled row", forbidden(r) && estRow(sid).status === "draft" && auditRows("estimate.cancelled").length === cancels);
    r = await logged({ action: "cancelEstimate", id: sid }, manager);
    ok("a Manager cancels it: { status: ok }, cancelled, and estimate.cancelled names who", r.status === 200 && keys(r.body) === "status" && r.body.status === "ok" &&
      estRow(sid).status === "cancelled" && !!estRow(sid).cancelledAt && r.rows.length === 1 && r.rows[0].action === "estimate.cancelled" && r.rows[0].actor === "mo@example.com");
  }

  console.log("\n=== The checks inside the actions, for made-up roles ===");
  {
    let r = await call({ action: "createEstimate", org: "acme", customerId: pat }, noCustomers);
    ok("a role without Customers can't make a quote: \"Your role can't pick a customer for a quote. Ask an admin.\"", forbidden(r) && r.body.message === "Your role can't pick a customer for a quote. Ask an admin.");
    const est = await newQuote({ title: "Inside checks" });
    r = await call({ action: "getEstimate", id: est.id }, noCustomers);
    ok("…it still opens a quote (reading needs only Quotes)", r.status === 200 && r.body.estimate.id === est.id);
    r = await save(est.id, [{ kind: "product", productId: "polo", qty: 2, customUnitPrice: 9 }], {}, noPayments);
    ok("a role without Payments can't type a price over the catalog's: \"Your role can't set a custom price. Ask an admin.\"", forbidden(r) && r.body.message === "Your role can't set a custom price. Ask an admin." && itemRows(est.id).length === 0);
    r = await save(est.id, [{ kind: "product", productId: "polo", qty: 2, customUnitPrice: "" }, { kind: "custom", name: "Patch", qty: 1, unitPrice: 4 }], {}, noPayments);
    ok("…an empty typed price is no typed price, and a custom line's own price needs nothing more: saved", r.status === 200 && r.body.items.length === 2 && r.body.items[0].unitPrice === 20 && r.body.items[0].customPrice === false);
    r = await save(est.id, [{ kind: "product", productId: "polo", qty: 2, customUnitPrice: 9 }], {}, staff);
    ok("Back office (Payments at edit) may", r.status === 200 && r.body.items[0].unitPrice === 9 && r.body.items[0].customPrice === true);
    const orders = orderCount();
    r = await call({ action: "convertEstimate", id: est.id }, noOrders);
    ok("a role without order details can't convert: \"Your role can't make orders. Ask an admin.\"", forbidden(r) && r.body.message === "Your role can't make orders. Ask an admin." && orderCount() === orders);
    r = await call({ action: "convertEstimate", id: est.id, sendInvoice: true }, noInvoices);
    ok("a role without Send invoice can't convert with the invoice emailed: \"Your role can't send invoices. Ask an admin.\"", forbidden(r) && r.body.message === "Your role can't send invoices. Ask an admin." && orderCount() === orders && estRow(est.id).status === "draft");
    r = await call({ action: "convertEstimate", id: est.id }, noInvoices);
    ok("…but converts without it", r.status === 200 && orderCount() === orders + 1 && estRow(est.id).status === "converted" && estRow(est.id).orderId === r.body.orderId);
  }

  console.log("\n=== createEstimate ===");
  {
    const log = auditCount(), n = estCount();
    ok("no shop: 400 \"Pick the shop the quote is from.\"", refused(await call({ action: "createEstimate", customerId: pat }, admin), 400, "Pick the shop the quote is from.") &&
      refused(await call({ action: "createEstimate", org: 7, customerId: pat }, admin), 400, "Pick the shop the quote is from."));
    ok("no customer, or one that isn't an id: 400 \"Pick the customer the quote is for.\"",
      refused(await call({ action: "createEstimate", org: "acme" }, admin), 400, "Pick the customer the quote is for.") &&
      refused(await call({ action: "createEstimate", org: "acme", customerId: "abc" }, admin), 400, "Pick the customer the quote is for.") &&
      refused(await call({ action: "createEstimate", org: "acme", customerId: 0 }, admin), 400, "Pick the customer the quote is for."));
    ok("an expiry date that isn't one: 400 \"The quote's expiry date isn't a valid date.\"", refused(await call({ action: "createEstimate", org: "acme", customerId: pat, expiresOn: "2027-02-31" }, admin), 400, "The quote's expiry date isn't a valid date.") &&
      refused(await call({ action: "createEstimate", org: "acme", customerId: pat, expiresOn: "soon" }, admin), 400, "The quote's expiry date isn't a valid date."));
    ok("a shop that doesn't exist: 404 \"Shop not found\"", refused(await call({ action: "createEstimate", org: "nowhere", customerId: pat }, admin), 404, "Shop not found"));
    ok("a customer who doesn't exist: 404 \"Customer not found\"", refused(await call({ action: "createEstimate", org: "acme", customerId: 987654 }, admin), 404, "Customer not found"));
    ok("a customer merged into another: 400 \"That customer was merged into another one. Open that one instead.\"",
      refused(await call({ action: "createEstimate", org: "acme", customerId: gone }, admin), 400, "That customer was merged into another one. Open that one instead."));
    ok("none of those made a quote or wrote to the audit log", estCount() === n && auditCount() === log);
    const r = await logged({ action: "createEstimate", org: "acme", customerId: pat, title: "  Team polos  ", message: "Thanks for asking", internalNote: "Call first", expiresOn: "2099-12-31" }, admin);
    const row = estRow(r.body.id);
    ok("a quote is made: { status, id, number }, its number Q- and five digits, one more than the last", r.status === 200 && keys(r.body) === "id,number,status" &&
      /^Q-\d{5}$/.test(r.body.number) && r.body.number === "Q-" + String(n + 1).padStart(5, "0") && row.number === r.body.number);
    ok("…a draft for that customer in that shop, with its fields (the title trimmed) and who made it", row.status === "draft" && row.orgId === "acme" && row.customerId === pat &&
      row.title === "Team polos" && row.message === "Thanks for asking" && row.internalNote === "Call first" && row.expiresOn === "2099-12-31" && row.createdBy === "olive@example.com" && row.token === null);
    ok("…and estimate.created is logged with the quote, its number, the customer and the title", r.rows.length === 1 && r.rows[0].action === "estimate.created" && r.rows[0].orgId === "acme" &&
      same(r.rows[0].detail, { estimateId: r.body.id, number: r.body.number, customerId: pat, title: "Team polos" }) && r.rows[0].actor === "olive@example.com");
    const r2 = await call({ action: "createEstimate", org: "acme", customerId: lee, expiresOn: "" }, admin);
    ok("an empty expiry date is no end date", r2.status === 200 && estRow(r2.body.id).expiresOn === null && estRow(r2.body.id).title === "");
  }

  console.log("\n=== saveEstimate: pricing each kind of line ===");
  let A1;   // the quote converted later
  {
    A1 = (await newQuote({ title: "Club order" })).id;
    const items = [
      { kind: "product", productId: "polo", qty: 6 },
      { kind: "product", productId: "polo", qty: "6", personalized: true, persName: "Pat" },
      { kind: "product", productId: "cap", size: "S", qty: 4 },
      { kind: "custom", name: "  Sample patch ", qty: 2, unitPrice: 7.5, taxable: false },
      { kind: "fee", feeKind: "setup", name: "Club crest", amount: 25 },
      { kind: "fee", feeKind: "digitizing", name: "", amount: "40", taxable: false, qty: 9 },
    ];
    const r = await logged({ action: "saveEstimate", id: A1, items, title: "Club order, spring" }, admin);
    const it = r.body.items || [];
    ok("the answer is the quote as getEstimate gives it: { status, estimate, items, customer, totals }", r.status === 200 && keys(r.body) === "customer,estimate,items,status,totals" &&
      r.body.estimate.id === A1 && r.body.customer.id === pat && it.length === 6);
    ok("two polo lines of 6 make 12 pieces of it: each piece $18 ($20 less the 12-piece break of $2)", it[0].unitPrice === 18 && it[0].listUnitPrice === 20 && it[0].breakOff === 2 && it[0].lineTotal === 108 &&
      it[1].unitPrice === 18 && it[1].breakOff === 2);
    ok("…a quantity sent as text (\"6\") counts as the number", it[1].qty === 6);
    ok("personalization ($5) isn't discounted: 6 × ($18 + $5) = $138, the name kept", it[1].personalized === true && it[1].persName === "Pat" && it[1].personalizationFee === 5 && it[1].lineTotal === 138);
    ok("the cap's 4 pieces don't reach its break (polo pieces aren't counted for it): $15 each, untaxed as the product is", it[2].unitPrice === 15 && it[2].breakOff === 0 && it[2].size === "S" &&
      it[2].lineTotal === 60 && it[2].taxable === false && it[2].name === "Example Cap");
    ok("a custom line keeps its description (trimmed), quantity, price and taxable setting", it[3].kind === "custom" && it[3].name === "Sample patch" && it[3].qty === 2 && it[3].unitPrice === 7.5 && it[3].taxable === false && it[3].lineTotal === 15);
    ok("a fee is one amount, once, taxable unless it says not", it[4].kind === "fee" && it[4].feeKind === "setup" && it[4].name === "Club crest" && it[4].qty === 1 && it[4].unitPrice === 25 && it[4].taxable === true);
    ok("a fee with no description is named for its kind (\"Digitizing fee\"), a quantity sent with it is ignored", it[5].name === "Digitizing fee" && it[5].qty === 1 && it[5].lineTotal === 40 && it[5].taxable === false);
    ok("totals at 10% added: subtotal $386, tax $27.10 on the taxable lines only, total $413.10",
      same(r.body.totals, { subtotal: 386, tax: 27.1, total: 413.1, taxMode: "exclusive", taxRateBps: 1000 }));
    ok("the lines are stored in cents in the order sent", same(itemRows(A1).map(x => [x.kind, x.unitPriceCents, x.listUnitCents, x.lineTotalCents]),
      [["product", 1800, 2000, 10800], ["product", 1800, 2000, 13800], ["product", 1500, 1500, 6000], ["custom", 750, 750, 1500], ["fee", 2500, 2500, 2500], ["fee", 4000, 4000, 4000]]));
    ok("estimate.saved is logged: the title's change, how many lines, and the total from nothing to $413.10", r.rows.length === 1 && r.rows[0].action === "estimate.saved" &&
      same(r.rows[0].detail.changes, { title: { from: "Club order", to: "Club order, spring" } }) && r.rows[0].detail.items === 6 && same(r.rows[0].detail.total, { from: 0, to: 413.1 }) && r.rows[0].detail.number === estRow(A1).number);

    const B = (await newQuote({ title: "Breaks" })).id;
    let x = await save(B, [{ kind: "product", productId: "polo", qty: 10 }, { kind: "product", productId: "polo", qty: 3, customUnitPrice: "12.50", personalized: true, persName: "Kept out" }]);
    ok("a typed price: that line is $12.50 a piece, marked as typed, with no break and no personalization",
      x.status === 200 && x.body.items[1].unitPrice === 12.5 && x.body.items[1].listUnitPrice === 12.5 && x.body.items[1].customPrice === true && x.body.items[1].breakOff === 0 &&
      x.body.items[1].personalized === false && x.body.items[1].personalizationFee === 0 && x.body.items[1].lineTotal === 37.5);
    ok("…its pieces still count toward the product's break: 10 + 3 = 13 pieces, so the other line is $18", x.body.items[0].unitPrice === 18 && x.body.items[0].breakOff === 2);
    x = await save(B, [{ kind: "product", productId: "polo", qty: 30 }, { kind: "product", productId: "polo", qty: 20 }]);
    ok("50 pieces across two lines reach the deepest break: $15 each", x.body.items.every(i => i.unitPrice === 15 && i.breakOff === 5));
    x = await save(B, [{ kind: "product", productId: "polo", qty: 11 }]);
    ok("11 pieces: no break, $20", x.body.items[0].unitPrice === 20 && x.body.items[0].breakOff === 0 && x.body.items[0].listUnitPrice === 20);
    x = await save(B, [{ kind: "product", productId: "polo", qty: 11 }, { kind: "custom", name: "Polo, customer's own", qty: 5, unitPrice: 1 }]);
    ok("a custom line doesn't count toward a product's break", x.body.items[0].unitPrice === 20);
    x = await save(B, [{ kind: "product", productId: "polo", qty: 5000 }]);
    ok("5,000 pieces on a line is allowed (bulk sales)", x.status === 200 && x.body.items[0].qty === 5000 && x.body.items[0].lineTotal === 75000);
    x = await save(B, Array.from({ length: 100 }, (_, i) => ({ kind: "custom", name: "Line " + (i + 1), qty: 1, unitPrice: 1 })));
    ok("100 lines is allowed", x.status === 200 && x.body.items.length === 100 && x.body.totals.subtotal === 100);
    x = await save(B, [{ kind: "fee", feeKind: "art", amount: 0 }, { kind: "fee", feeKind: "other", name: "Rush handling", amount: 10 }]);
    ok("a $0 fee is allowed; art and other fees are named \"Art fee\" and as typed", x.status === 200 && x.body.items[0].unitPrice === 0 && x.body.items[0].name === "Art fee" && x.body.items[1].name === "Rush handling");
    x = await save(B, []);
    ok("an empty list empties the quote", x.status === 200 && x.body.items.length === 0 && itemRows(B).length === 0 && x.body.totals.total === 0);
    const log = auditCount();
    x = await save(B, undefined, { title: "Breaks" });
    ok("a save that changes nothing answers the quote and logs nothing", x.status === 200 && x.body.estimate.title === "Breaks" && auditCount() === log);
    x = await call({ action: "saveEstimate", id: B, internalNote: "Note only", expiresOn: "" }, admin);
    ok("a save without items changes only the fields sent", x.status === 200 && estRow(B).internalNote === "Note only" && estRow(B).title === "Breaks" && auditRows("estimate.saved").pop().detail.items === undefined);
    x = await call({ action: "saveEstimate", id: B, expiresOn: "2099-06-30" }, admin);
    const x2 = await call({ action: "saveEstimate", id: B, expiresOn: null }, admin);
    ok("an expiry date is set, and null clears it (logged from the date to null)", x.status === 200 && x2.status === 200 && estRow(B).expiresOn === null &&
      same(auditRows("estimate.saved").pop().detail.changes, { expiresOn: { from: "2099-06-30", to: null } }));
  }

  console.log("\n=== saveEstimate: refusals ===");
  {
    const C = (await newQuote({ title: "Refusals" })).id;
    await save(C, [{ kind: "custom", name: "Kept line", qty: 1, unitPrice: 3 }]);
    const log = auditCount(), kept = JSON.stringify(itemRows(C));
    const no = async (items, msg) => refused(await save(C, items), 400, msg);
    ok("lines that aren't a list: \"The quote's lines aren't valid.\"", await no("three polos", "The quote's lines aren't valid.") && await no(null, "The quote's lines aren't valid.") && await no({ kind: "custom" }, "The quote's lines aren't valid."));
    ok("101 lines: \"A quote can have at most 100 lines.\"", await no(Array.from({ length: 101 }, () => ({ kind: "custom", name: "x", qty: 1, unitPrice: 1 })), "A quote can have at most 100 lines."));
    ok("a line that isn't a product, custom line or fee: \"Line 1: that kind of line isn't one a quote has.\"", await no([{ kind: "discount", qty: 1 }], "Line 1: that kind of line isn't one a quote has.") &&
      await no([null], "Line 1: that kind of line isn't one a quote has.") && await no([[]], "Line 1: that kind of line isn't one a quote has.") && await no(["polo"], "Line 1: that kind of line isn't one a quote has."));
    const QTY = "the quantity must be a whole number from 1 to 5,000.";
    ok("a quantity of 0, 5,001, 1.5, a word or none: \"Line N: " + QTY + "\"", await no([{ kind: "product", productId: "polo", qty: 0 }], "Line 1: " + QTY) &&
      await no([{ kind: "custom", name: "ok", qty: 1, unitPrice: 1 }, { kind: "product", productId: "polo", qty: 5001 }], "Line 2: " + QTY) &&
      await no([{ kind: "custom", name: "x", qty: 1.5, unitPrice: 1 }], "Line 1: " + QTY) && await no([{ kind: "custom", name: "x", qty: "many", unitPrice: 1 }], "Line 1: " + QTY) &&
      await no([{ kind: "product", productId: "polo" }], "Line 1: " + QTY) && await no([{ kind: "product", productId: "polo", qty: " " }], "Line 1: " + QTY));
    ok("a product line with no product, or the custom marker: \"Line 1: pick a product.\"", await no([{ kind: "product", qty: 1 }], "Line 1: pick a product.") &&
      await no([{ kind: "product", productId: "__custom__", qty: 1 }], "Line 1: pick a product.") && await no([{ kind: "product", productId: 5, qty: 1 }], "Line 1: pick a product."));
    const PRICE = "enter a valid price per piece (0 or more).";
    ok("a typed price below 0, over $1,000,000 or not a number: \"Line 1: " + PRICE + "\"", await no([{ kind: "product", productId: "polo", qty: 1, customUnitPrice: -1 }], "Line 1: " + PRICE) &&
      await no([{ kind: "product", productId: "polo", qty: 1, customUnitPrice: 1000001 }], "Line 1: " + PRICE) && await no([{ kind: "product", productId: "polo", qty: 1, customUnitPrice: "cheap" }], "Line 1: " + PRICE) &&
      await no([{ kind: "product", productId: "polo", qty: 1, customUnitPrice: true }], "Line 1: " + PRICE));
    ok("a custom line with no description: \"Line 1: describe the custom item.\"", await no([{ kind: "custom", name: "  ", qty: 1, unitPrice: 1 }], "Line 1: describe the custom item.") && await no([{ kind: "custom", qty: 1, unitPrice: 1 }], "Line 1: describe the custom item."));
    ok("a custom line with no price, a negative one or a yes/no: \"Line 1: " + PRICE + "\"", await no([{ kind: "custom", name: "x", qty: 1 }], "Line 1: " + PRICE) &&
      await no([{ kind: "custom", name: "x", qty: 1, unitPrice: -2 }], "Line 1: " + PRICE) && await no([{ kind: "custom", name: "x", qty: 1, unitPrice: "" }], "Line 1: " + PRICE) && await no([{ kind: "custom", name: "x", qty: 1, unitPrice: false }], "Line 1: " + PRICE));
    ok("a fee of a kind there isn't: \"Line 1: pick the kind of fee (setup, digitizing, art or other).\"", await no([{ kind: "fee", feeKind: "shipping", amount: 1 }], "Line 1: pick the kind of fee (setup, digitizing, art or other).") &&
      await no([{ kind: "fee", amount: 1 }], "Line 1: pick the kind of fee (setup, digitizing, art or other).") && await no([{ kind: "fee", feeKind: "toString", amount: 1 }], "Line 1: pick the kind of fee (setup, digitizing, art or other)."));
    ok("a fee with no amount or a negative one: \"Line 1: enter the fee's amount (0 or more).\"", await no([{ kind: "fee", feeKind: "setup" }], "Line 1: enter the fee's amount (0 or more).") &&
      await no([{ kind: "fee", feeKind: "setup", amount: -5 }], "Line 1: enter the fee's amount (0 or more).") && await no([{ kind: "fee", feeKind: "setup", amount: null }], "Line 1: enter the fee's amount (0 or more)."));
    ok("a product the shop doesn't have, or has hidden: \"Line 1: Product not available: …\"", await no([{ kind: "product", productId: "nosuch", qty: 1 }], "Line 1: Product not available: nosuch") &&
      await no([{ kind: "product", productId: "hidden", qty: 1 }], "Line 1: Product not available: hidden") && await no([{ kind: "product", productId: "tote", qty: 1 }], "Line 1: Product not available: tote"));
    ok("a size the product doesn't list: \"Line 2: Size XL not available for cap\"", await no([{ kind: "custom", name: "ok", qty: 1, unitPrice: 1 }, { kind: "product", productId: "cap", size: "XL", qty: 1 }], "Line 2: Size XL not available for cap"));
    ok("an expiry date that isn't a date: \"The quote's expiry date isn't a valid date.\"", refused(await save(C, undefined, { expiresOn: "2026-13-01" }), 400, "The quote's expiry date isn't a valid date."));
    ok("none of those changed the quote's lines or wrote to the audit log", JSON.stringify(itemRows(C)) === kept && auditCount() === log);
    ok("a quote id that isn't one: 400 \"That quote isn't valid.\"", refused(await save("abc", []), 400, NOT_VALID) && refused(await save(0, []), 400, NOT_VALID) && refused(await save(undefined, []), 400, NOT_VALID));
    ok("a quote that doesn't exist: 404 \"Quote not found\"", refused(await save(987654, []), 404, NOT_FOUND));
  }

  console.log("\n=== listEstimates and getEstimate ===");
  {
    const L1 = (await newQuote({ title: "Listed example one" })).id;
    const L2 = (await call({ action: "createEstimate", org: "beta", customerId: lee, title: "Listed example two" }, admin)).body.id;
    await save(L2, [{ kind: "product", productId: "tote", qty: 2 }]);
    let r = await call({ action: "listEstimates" }, staff);
    ok("the list answers { status, estimates, total }, most recently changed first", r.status === 200 && keys(r.body) === "estimates,status,total" && r.body.total === estCount() &&
      r.body.estimates[0].id === L2 && r.body.estimates[1].id === L1);
    const e2 = r.body.estimates[0];
    ok("…each with its number, shop, customer's name, title, status and total (tax added)", e2.orgId === "beta" && e2.customerName === "Lee Example" && e2.title === "Listed example two" &&
      e2.status === "draft" && e2.total === 26.4 && e2.expired === false && e2.orderId === "");
    r = await call({ action: "listEstimates", org: "beta" }, staff);
    ok("…by shop", r.body.total === 1 && r.body.estimates[0].id === L2);
    r = await call({ action: "listEstimates", customerId: lee }, staff);
    ok("…by customer", r.body.estimates.length > 0 && r.body.estimates.every(e => e.customerId === lee));
    r = await call({ action: "listEstimates", status: "cancelled" }, staff);
    ok("…by status", r.body.estimates.length > 0 && r.body.estimates.every(e => e.status === "cancelled"));
    r = await call({ action: "listEstimates", q: "  LISTED example  " }, staff);
    ok("…by words in the title (trimmed, either case)", r.body.total === 2);
    r = await call({ action: "listEstimates", limit: 1, offset: 1 }, staff);
    ok("…a page at a time: limit and offset", r.body.estimates.length === 1 && r.body.estimates[0].id === L1 && r.body.total === estCount());
    r = await call({ action: "listEstimates", limit: 0, status: "" }, staff);
    ok("…a limit of 0 or an empty status is the default list", r.status === 200 && r.body.estimates.length === Math.min(50, estCount()));
    ok("a customer id that isn't one: 400 \"That customer isn't valid.\"", refused(await call({ action: "listEstimates", customerId: "abc" }, staff), 400, "That customer isn't valid."));
    ok("a status a quote doesn't have: 400 \"That status isn't one a quote has.\"", refused(await call({ action: "listEstimates", status: "lost" }, staff), 400, "That status isn't one a quote has."));
    r = await call({ action: "getEstimate", id: String(L2) }, staff);
    ok("getEstimate answers { status, estimate, items, customer, totals } for an id sent as text", r.status === 200 && keys(r.body) === "customer,estimate,items,status,totals" &&
      r.body.estimate.number === estRow(L2).number && r.body.items[0].productId === "tote" && r.body.customer.name === "Lee Example" && r.body.totals.subtotal === 24);
    ok("an id that isn't one: 400 \"That quote isn't valid.\"", refused(await call({ action: "getEstimate", id: "x" }, staff), 400, NOT_VALID) && refused(await call({ action: "getEstimate", id: -2 }, staff), 400, NOT_VALID) &&
      refused(await call({ action: "getEstimate" }, staff), 400, NOT_VALID));
    ok("a quote that doesn't exist: 404 \"Quote not found\"", refused(await call({ action: "getEstimate", id: 987654 }, staff), 404, NOT_FOUND));
  }

  console.log("\n=== sendEstimate ===");
  let tokenA1;
  {
    let r = await logged({ action: "sendEstimate", id: A1 }, staff);
    const row = estRow(A1);
    tokenA1 = row.token;
    ok("sent to the customer's own email when none is typed: { status, sentTo, emailSent, link }", r.status === 200 && keys(r.body) === "emailSent,link,sentTo,status" && r.body.sentTo === "pat@example.com" && r.body.emailSent === true);
    ok("the link is on the shop's address, with a 32-character token", /^[0-9a-f]{32}$/.test(row.token) && r.body.link === "https://acme.example.com/?estimate=" + row.token);
    ok("the quote is sent: once, to that address, with today's tax frozen on it (10%, added)", row.status === "sent" && row.sendCount === 1 && row.sentTo === "pat@example.com" && !!row.sentAt &&
      row.taxMode === "exclusive" && row.taxRateBps === 1000);
    const m = mails[mails.length - 1];
    ok("the email goes to the customer, names the quote, the shop and the total, and carries the link", mails.length === 1 && m.to === "pat@example.com" &&
      m.subject.startsWith("Quote " + row.number + " — Example Club") && m.subject.includes("413.10") && m.body.includes(r.body.link) && m.htmlBody.includes(r.body.link));
    ok("estimate.sent is logged with who it went to, that it went, the total and the send count", r.rows.length === 1 && r.rows[0].action === "estimate.sent" && r.rows[0].actor === "sam@example.com" &&
      same(r.rows[0].detail, { estimateId: A1, number: row.number, to: "pat@example.com", emailSent: true, total: 413.1, sendCount: 1 }));
    setTax(500, "exclusive");
    r = await call({ action: "getEstimate", id: A1 }, staff);
    ok("once sent its tax stays as sent, even after the rate changes", r.body.totals.tax === 27.1 && r.body.totals.taxRateBps === 1000);
    setTax(1000, "exclusive");
    r = await logged({ action: "sendEstimate", id: A1, email: " club@example.com ", message: "A second copy, as asked" }, staff);
    const row2 = estRow(A1);
    ok("sending again keeps the token (the first email's link still works), counts two sends, and goes to the typed address", r.status === 200 && row2.token === tokenA1 && row2.sendCount === 2 &&
      row2.sentTo === "club@example.com" && r.body.link.endsWith(tokenA1) && mails[mails.length - 1].to === "club@example.com" && r.rows[0].detail.sendCount === 2);
    ok("…its note goes in that email, but isn't saved on a quote already sent", mails[mails.length - 1].body.includes("A second copy, as asked") && row2.message === "");

    const D = (await newQuote({ title: "Draft send", message: "Old note" })).id;
    await save(D, [{ kind: "custom", name: "Banner", qty: 1, unitPrice: 50 }]);
    r = await call({ action: "sendEstimate", id: D, message: "New note for you" }, staff);
    ok("a note typed in the Send window on a draft becomes the quote's note", r.status === 200 && estRow(D).message === "New note for you" && mails[mails.length - 1].body.includes("New note for you"));

    const E = (await call({ action: "createEstimate", org: "acme", customerId: lee }, admin)).body.id;
    await save(E, [{ kind: "custom", name: "Banner", qty: 1, unitPrice: 50 }]);
    const sends = mails.length;
    ok("no address typed and none on the customer: 400 \"Enter the customer's email address to send the quote to\"",
      refused(await call({ action: "sendEstimate", id: E }, staff), 400, "Enter the customer's email address to send the quote to") && estRow(E).status === "draft");
    ok("…nor a typed address that isn't one", refused(await call({ action: "sendEstimate", id: E, email: "lee at example" }, staff), 400, "Enter the customer's email address to send the quote to") && mails.length === sends);
    mailFails = true;
    r = await quietly(() => logged({ action: "sendEstimate", id: E, email: "lee@example.com" }, staff));
    mailFails = false;
    ok("when the email fails the quote is still sent, and the answer and the log say the email wasn't", r.status === 200 && r.body.emailSent === false && estRow(E).status === "sent" && r.rows[0].detail.emailSent === false);

    const Bq = (await call({ action: "createEstimate", org: "beta", customerId: pat }, admin)).body.id;
    await save(Bq, [{ kind: "product", productId: "tote", qty: 1 }]);
    r = await call({ action: "sendEstimate", id: Bq }, staff);
    ok("a shop with no address of its own: the link is on the address the request came to", r.status === 200 && r.body.link === "https://admin.example.com/?estimate=" + estRow(Bq).token);

    const K = (await newQuote({ customerId: kim })).id;
    await save(K, [{ kind: "product", productId: "polo", qty: 1 }]);
    r = await call({ action: "sendEstimate", id: K }, staff);
    ok("a tax-exempt customer's quote is sent with no tax", r.status === 200 && estRow(K).taxRateBps === 0 && (await call({ action: "getEstimate", id: K }, staff)).body.totals.tax === 0);

    const empty = (await newQuote()).id;
    ok("a quote with no lines: 400 \"Add at least one line before sending the quote.\"", refused(await call({ action: "sendEstimate", id: empty }, staff), 400, "Add at least one line before sending the quote."));
    const old = (await newQuote({ expiresOn: "2020-01-31" })).id;
    await save(old, [{ kind: "custom", name: "Late", qty: 1, unitPrice: 1 }]);
    ok("a quote whose last day has passed: 409 naming the day", refused(await call({ action: "sendEstimate", id: old }, staff), 409, "This quote's last day (2020-01-31) has passed. Set a later expiry date before sending it.") && estRow(old).status === "draft");
    ok("an id that isn't one: 400; one that doesn't exist: 404", refused(await call({ action: "sendEstimate", id: "x" }, staff), 400, NOT_VALID) && refused(await call({ action: "sendEstimate", id: 987654 }, staff), 404, NOT_FOUND));
    // The quote is cancelled while it is being sent (here: as its note is saved).
    const race = (await newQuote()).id;
    await save(race, [{ kind: "custom", name: "Raced", qty: 1, unitPrice: 1 }]);
    d1._raw.exec(`CREATE TRIGGER t316_send_race AFTER UPDATE OF message ON estimates WHEN NEW.id = ${race} BEGIN UPDATE estimates SET status = 'cancelled' WHERE id = NEW.id; END;`);
    const before = mails.length;
    r = await call({ action: "sendEstimate", id: race, message: "Changed meanwhile" }, staff);
    d1._raw.exec("DROP TRIGGER t316_send_race");
    ok("a quote cancelled while it is being sent: 409 with the reason, and no email", refused(r, 409, "This quote was cancelled.") && mails.length === before && estRow(race).token === null);
  }

  console.log("\n=== Saving and sending by status ===");
  {
    const S = (await newQuote({ title: "Statuses" })).id;
    await save(S, [{ kind: "product", productId: "polo", qty: 2 }]);
    await call({ action: "sendEstimate", id: S }, staff);
    let r = await save(S, [{ kind: "product", productId: "polo", qty: 3 }]);
    ok("a sent quote's lines can't change: 409 \"This quote was sent: its lines can't change unless the customer asks for changes. …\"",
      refused(r, 409, "This quote was sent: its lines can't change unless the customer asks for changes. Cancel it and make a new one instead.") && itemRows(S)[0].qty === 2);
    r = await call({ action: "saveEstimate", id: S, title: "New title" }, staff);
    ok("…nor its title: 409 \"This quote has been sent. It can be changed if the customer asks for changes.\"", refused(r, 409, "This quote has been sent. It can be changed if the customer asks for changes.") && estRow(S).title === "Statuses");
    r = await logged({ action: "saveEstimate", id: S, internalNote: "Followed up" }, staff);
    ok("…but its internal note can, and that is logged", r.status === 200 && estRow(S).internalNote === "Followed up" && r.rows[0].action === "estimate.saved" &&
      same(r.rows[0].detail.changes, { internalNote: { from: "", to: "Followed up" } }));
    d1._raw.run("UPDATE estimates SET status = 'changes', customerNote = 'Can it be 12?' WHERE id = ?", [S]);
    r = await save(S, [{ kind: "product", productId: "polo", qty: 12 }], { title: "Revised" });
    ok("once the customer asks for changes the quote is revised: lines repriced (12 pieces, $18) and the title changed", r.status === 200 && r.body.items[0].unitPrice === 18 && estRow(S).title === "Revised");
    r = await call({ action: "sendEstimate", id: S }, staff);
    ok("…and sent again with the same link", r.status === 200 && estRow(S).status === "sent" && estRow(S).sendCount === 2 && r.body.link.endsWith(estRow(S).token));
    d1._raw.run("UPDATE estimates SET status = 'accepted' WHERE id = ?", [S]);
    ok("an accepted quote can't change: 409 \"The customer accepted this quote: it can't change now.\"", refused(await save(S, []), 409, "The customer accepted this quote: it can't change now."));
    ok("…nor be sent: 409 \"The customer accepted this quote: there's nothing to send.\"", refused(await call({ action: "sendEstimate", id: S }, staff), 409, "The customer accepted this quote: there's nothing to send."));
    const X = (await newQuote()).id;
    await call({ action: "cancelEstimate", id: X }, admin);
    ok("a cancelled quote can't be saved or sent: 409 \"This quote was cancelled.\"", refused(await save(X, []), 409, "This quote was cancelled.") &&
      refused(await call({ action: "saveEstimate", id: X, internalNote: "x" }, staff), 409, "This quote was cancelled.") && refused(await call({ action: "sendEstimate", id: X }, staff), 409, "This quote was cancelled."));
    // The quote is sent from elsewhere while this save is under way (here: as its title is saved).
    const R = (await newQuote({ title: "Race" })).id;
    d1._raw.exec(`CREATE TRIGGER t316_save_race AFTER UPDATE OF title ON estimates WHEN NEW.id = ${R} BEGIN UPDATE estimates SET status = 'sent' WHERE id = NEW.id; END;`);
    r = await save(R, [{ kind: "custom", name: "Raced", qty: 1, unitPrice: 1 }], { title: "Race again" });
    d1._raw.exec("DROP TRIGGER t316_save_race");
    ok("a quote sent while its lines are being saved: 409, and its lines stay as they were", refused(r, 409, "This quote has been sent. It can be changed if the customer asks for changes.") && itemRows(R).length === 0);
  }

  console.log("\n=== convertEstimate ===");
  {
    // After A1 was sent the polo's price went up and its breaks went away.
    d1._raw.run("UPDATE products SET flatPriceCents = 3000, qtyBreaksJson = '[]' WHERE productId = 'polo'");
    const num = estRow(A1).number, want = "ACME-" + num.replace("-", "");
    const sends = mails.length, orders = orderCount();
    let r = await logged({ action: "convertEstimate", id: A1, sendInvoice: true }, staff);
    const o = orderRow(want), lines = orderLines(want);
    ok("the order is made: { status, orderId, invoiceSent }, its number the shop's and the quote's (" + "ACME-Q…" + ")", r.status === 200 && keys(r.body) === "invoiceSent,orderId,status" &&
      r.body.orderId === want && /^ACME-Q\d{5}$/.test(want) && !!o && orderCount() === orders + 1);
    ok("…at the prices quoted, not today's catalog: the polo lines at $18 each, personalization $5", lines[0].productId === "polo" && lines[0].unitPriceCents === 1800 && lines[0].qty === 6 &&
      lines[1].unitPriceCents === 1800 && lines[1].personalizationFeeCents === 500 && lines[1].personalized === 1 && lines[1].persName === "Pat" && lines[1].lineTotalCents === 13800);
    ok("…the cap with its size, untaxed as the product is", lines[2].productId === "cap" && lines[2].size === "S" && lines[2].unitPriceCents === 1500 && lines[2].taxable === 0);
    ok("…the custom line and the fees as custom lines: \"Sample patch\", \"Setup fee — Club crest\", \"Digitizing fee\"",
      same(lines.slice(3).map(l => [l.productId, l.name, l.qty, l.unitPriceCents, l.taxable]),
        [["__custom__", "Sample patch", 2, 750, 0], ["__custom__", "Setup fee — Club crest", 1, 2500, 1], ["__custom__", "Digitizing fee", 1, 4000, 0]]));
    ok("…coming to what the quote said: $386 and $27.10 tax added, $413.10", o.subtotalCents === 38600 && o.totalCents === 41310 && o.taxMode === "exclusive" && lines.reduce((s, l) => s + l.taxCents, 0) === 2710);
    ok("…for the quote's customer, by name and email", o.customerId === pat && o.customerName === "Pat Example" && o.contact === "pat@example.com");
    ok("the quote is now converted, naming the order", estRow(A1).status === "converted" && estRow(A1).orderId === want && !!estRow(A1).convertedAt);
    const conv = r.rows.find(x => x.action === "estimate.converted");
    ok("estimate.converted is logged on the order: the quote, its number, the customer, the total and how many lines", !!conv && conv.orderId === want && conv.actor === "sam@example.com" &&
      same(conv.detail, { estimateId: A1, number: num, customerId: pat, total: 413.1, items: 6 }));
    const inv = r.rows.find(x => x.action === "order.invoice_sent");
    ok("with \"email the invoice\": it is emailed to the customer and logged as sent from the quote", r.body.invoiceSent === true && mails.length === sends + 1 && mails[mails.length - 1].to === "pat@example.com" &&
      !!inv && inv.detail.fromEstimate === num && inv.detail.to === "pat@example.com" && inv.detail.emailSent === true && q("SELECT count(*) n FROM order_invoices")[0].n === 1);

    r = await logged({ action: "convertEstimate", id: A1, sendInvoice: true }, staff);
    ok("converting again answers the same order, marked repeated, and makes, emails and logs nothing", r.status === 200 && r.body.orderId === want && r.body.repeated === true && r.body.invoiceSent === false &&
      orderCount() === orders + 1 && mails.length === sends + 1 && r.rows.length === 0);
    // An earlier call made the order but stopped before marking the quote converted.
    d1._raw.run("UPDATE estimates SET status = 'accepted', orderId = NULL, convertedAt = NULL WHERE id = ?", [A1]);
    r = await logged({ action: "convertEstimate", id: A1 }, staff);
    ok("an order already made under the quote's number is the quote's: answered as repeated, and the quote marked converted again", r.status === 200 && r.body.orderId === want && r.body.repeated === true &&
      orderCount() === orders + 1 && estRow(A1).status === "converted" && estRow(A1).orderId === want && r.rows.length === 0);

    // Fee names, a shop's own prefix, a never-sent quote following today's tax mode, and an expired one.
    const F = (await call({ action: "createEstimate", org: "beta", customerId: lee, expiresOn: "2020-02-01" }, admin)).body.id;
    await save(F, [{ kind: "fee", feeKind: "setup", name: "setup FEE", amount: 10 }, { kind: "fee", feeKind: "art", name: "Logo cleanup", amount: 5, taxable: false },
      { kind: "fee", feeKind: "other", name: "Rush handling", amount: 2 }, { kind: "custom", name: "Tote, customer's own", qty: 3, unitPrice: 4 }]);
    setTax(1000, "inclusive");
    r = await call({ action: "convertEstimate", id: F, sendInvoice: true }, admin);
    const fid = "BETA-" + estRow(F).number.replace("-", "");
    ok("an expired draft converts too; the order number starts with the shop's", r.status === 200 && r.body.orderId === fid && estRow(F).status === "converted");
    ok("a fee named just for its kind is \"Setup fee\"; others read \"Art fee — …\", \"Fee — …\"; a fee's taxable setting is kept",
      same(orderLines(fid).map(l => [l.name, l.qty, l.taxable]), [["Setup fee", 1, 1], ["Art fee — Logo cleanup", 1, 0], ["Fee — Rush handling", 1, 1], ["Tote, customer's own", 3, 1]]));
    ok("a quote never sent follows today's tax mode (in the prices)", orderRow(fid).taxMode === "inclusive" && orderRow(fid).customerId === lee);
    ok("a customer with no email gets no invoice (invoiceSent is not true)", r.body.invoiceSent === false && q("SELECT count(*) n FROM order_invoices")[0].n === 1);
    const T = (await newQuote()).id;
    await save(T, [{ kind: "custom", name: "Sent while added", qty: 1, unitPrice: 10 }]);
    setTax(1000, "exclusive");
    await call({ action: "sendEstimate", id: T }, staff);
    setTax(1000, "inclusive");
    r = await call({ action: "convertEstimate", id: T }, admin);
    ok("a quote sent with tax added makes an order with tax added, even after the setting changed", r.status === 200 && orderRow(r.body.orderId).taxMode === "exclusive" && orderRow(r.body.orderId).totalCents === 1100);
    setTax(1000, "exclusive");

    // The picked customer's exemption, and the rate as of the day of conversion.
    const K = (await newQuote({ customerId: kim })).id;
    await save(K, [{ kind: "product", productId: "polo", qty: 2 }]);
    r = await call({ action: "convertEstimate", id: K }, admin);
    ok("a tax-exempt customer's quote makes a tax-exempt order (the quote's customer counts as picked)", r.status === 200 && orderRow(r.body.orderId).taxExempt === 1 && orderRow(r.body.orderId).customerId === kim &&
      orderLines(r.body.orderId).every(l => l.taxCents === 0) && orderRow(r.body.orderId).totalCents === 6000);
    const P2 = (await newQuote()).id;
    await save(P2, [{ kind: "custom", name: "Rate check", qty: 1, unitPrice: 100 }]);
    await call({ action: "sendEstimate", id: P2 }, staff);
    setTax(500, "exclusive");
    r = await call({ action: "convertEstimate", id: P2 }, admin);
    ok("the order's tax rate is the one set on the day it is made (only the mode comes from the quote)", r.status === 200 && orderRow(r.body.orderId).taxRateBps === 500 && orderRow(r.body.orderId).totalCents === 10500);
    setTax(1000, "exclusive");

    const Z = (await newQuote()).id;
    await save(Z, [{ kind: "custom", name: "Free sample", qty: 1, unitPrice: 0 }]);
    r = await call({ action: "convertEstimate", id: Z, sendInvoice: true }, admin);
    ok("an order with nothing to pay gets no invoice either", r.status === 200 && r.body.invoiceSent === false && q("SELECT count(*) n FROM order_invoices")[0].n === 1);

    const n = orderCount();
    const X = (await newQuote()).id;
    await save(X, [{ kind: "custom", name: "Cancelled", qty: 1, unitPrice: 1 }]);
    await call({ action: "cancelEstimate", id: X }, admin);
    ok("a cancelled quote: 409 \"This quote was cancelled.\"", refused(await call({ action: "convertEstimate", id: X }, admin), 409, "This quote was cancelled."));
    const empty = (await newQuote()).id;
    ok("a quote with no lines: 400 \"This quote has no lines to order.\"", refused(await call({ action: "convertEstimate", id: empty }, admin), 400, "This quote has no lines to order."));
    ok("a quote that doesn't exist: 404 \"That quote wasn't found.\"; an id that isn't one: 400", refused(await call({ action: "convertEstimate", id: 987654 }, admin), 404, "That quote wasn't found.") &&
      refused(await call({ action: "convertEstimate", id: "x" }, admin), 400, NOT_VALID));
    ok("none of those made an order", orderCount() === n);
    ok("a converted quote can't be saved, sent or cancelled", refused(await save(A1, []), 409, "This quote is already an order.") &&
      refused(await call({ action: "sendEstimate", id: A1 }, admin), 409, "This quote is already an order.") &&
      refused(await call({ action: "cancelEstimate", id: A1 }, admin), 409, `This quote is already order ${want}. Void or edit the order instead.`));
  }

  console.log("\n=== cancelEstimate ===");
  {
    const C = (await newQuote({ title: "To cancel" })).id;
    await save(C, [{ kind: "custom", name: "Shirt", qty: 2, unitPrice: 10 }]);
    await call({ action: "sendEstimate", id: C }, staff);
    d1._raw.exec("CREATE TRIGGER t316_no_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'estimate.cancelled' BEGIN SELECT RAISE(ABORT, 'audit log unavailable'); END;");
    let r = await quietly(() => call({ action: "cancelEstimate", id: C }, admin));
    d1._raw.exec("DROP TRIGGER t316_no_audit");
    ok("when the audit row can't be written first: 503 \"Could not write the audit log, so nothing was changed. Try again.\" and the quote stays sent",
      refused(r, 503, "Could not write the audit log, so nothing was changed. Try again.") && estRow(C).status === "sent");
    r = await logged({ action: "cancelEstimate", id: C }, manager);
    ok("cancelled: { status: ok }, and estimate.cancelled records the status it had and its total", r.status === 200 && keys(r.body) === "status" && estRow(C).status === "cancelled" &&
      r.rows.length === 1 && same(r.rows[0].detail, { estimateId: C, number: estRow(C).number, customerId: pat, before: { status: "sent" }, total: 22 }));
    r = await logged({ action: "cancelEstimate", id: C }, manager);
    ok("cancelling it again answers ok and logs nothing", r.status === 200 && r.body.status === "ok" && r.rows.length === 0);
    // Cancelled by someone else between the read and the write.
    const D = (await newQuote()).id;
    d1._raw.exec(`CREATE TRIGGER t316_cancel_race AFTER INSERT ON audit_log WHEN NEW.action = 'estimate.cancelled' BEGIN UPDATE estimates SET status = 'cancelled' WHERE id = ${D}; END;`);
    r = await logged({ action: "cancelEstimate", id: D }, admin);
    d1._raw.exec("DROP TRIGGER t316_cancel_race");
    ok("when the cancel fails after its audit row: 409 with the reason, and estimate.cancel_not_done says so", refused(r, 409, "This quote is already cancelled.") &&
      same(r.rows.map(x => x.action), ["estimate.cancelled", "estimate.cancel_not_done"]) && r.rows[1].detail.reason === "This quote is already cancelled." && r.rows[1].detail.estimateId === D);
    ok("an id that isn't one: 400; one that doesn't exist: 404", refused(await call({ action: "cancelEstimate", id: "x" }, admin), 400, NOT_VALID) && refused(await call({ action: "cancelEstimate", id: 987654 }, admin), 404, NOT_FOUND));
  }

  console.log("\n=== The period guard: only converting is a sale ===");
  {
    const now = new Date(), ym = (d) => d.toISOString().slice(0, 7);
    const months = new Set([ym(now), ym(new Date(now.getTime() - 3 * 86400000)), ym(new Date(now.getTime() + 3 * 86400000))]);
    for (const m of months) d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES (?, '2026-01-05T00:00:00Z', 'test')", [m]);
    const n = orderCount();
    let r = await call({ action: "createEstimate", org: "acme", customerId: pat, title: "Closed month" }, admin);
    const id = r.body.id;
    ok("with this month closed a quote is still made", r.status === 200 && !!id);
    r = await save(id, [{ kind: "custom", name: "Closed", qty: 1, unitPrice: 5 }]);
    ok("…saved", r.status === 200);
    r = await call({ action: "sendEstimate", id }, admin);
    ok("…and sent", r.status === 200 && estRow(id).status === "sent");
    r = await call({ action: "convertEstimate", id }, admin);
    ok("…but converting it is refused (409, the month is closed) and no order is made", r.status === 409 && /is closed/.test(r.body.message) && orderCount() === n && estRow(id).status === "sent");
    r = await call({ action: "cancelEstimate", id }, admin);
    ok("…and it can still be cancelled", r.status === 200 && estRow(id).status === "cancelled");
    d1._raw.run("DELETE FROM closed_periods");
  }

  console.log("\n=== The Quotes feature switched off ===");
  {
    const live = (await newQuote({ title: "Feature off" })).id;
    await save(live, [{ kind: "custom", name: "Off", qty: 1, unitPrice: 5 }]);
    globalThis.__t316Features = { quotes: false };
    const before = [estCount(), orderCount(), auditCount(), mails.length, JSON.stringify(estRow(live))];
    const bodies = { listEstimates: {}, getEstimate: { id: live }, createEstimate: { org: "acme", customerId: pat }, saveEstimate: { id: live, title: "Changed" },
      sendEstimate: { id: live }, convertEstimate: { id: live }, cancelEstimate: { id: live } };
    const got = [];
    for (const a of SEVEN) got.push(await call(Object.assign({ action: a }, bodies[a]), admin));
    ok("every quote action is refused for an Admin: 403, feature quotes, \"Quotes is turned off. Turn it on under Settings → Global settings → Features.\"",
      got.every(r => r.status === 403 && r.body.feature === "quotes" && r.body.message === "Quotes is turned off. Turn it on under Settings → Global settings → Features."));
    const out = [];
    for (const a of SEVEN) out.push(await call(Object.assign({ action: a }, bodies[a]), ""));
    ok("…signed out, the sign-in is still asked for first (401), so nothing says the feature is off", out.every(r => refused(r, 401, "Unauthorized")));
    ok("…nothing was made, changed, sent or logged", same(before, [estCount(), orderCount(), auditCount(), mails.length, JSON.stringify(estRow(live))]));
    ok("…while the rest of the admin works (Customers)", (await call({ action: "listCustomers" }, admin)).status === 200);
    globalThis.__t316Features = { quotes: true, storefront: false };
    ok("another feature off doesn't touch quotes", (await call({ action: "getEstimate", id: live }, admin)).status === 200);
    delete globalThis.__t316Features;
  }

  // ---- A harness signed in with testlib/roles.js adminAs(), on a database built from the migrations ----
  const glue = (signIn) => new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
    "const requireAdmin = async () => null; const adminActor = () => 'owner@example.test';\n" + signIn + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
    "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false;\n" +
    strip(read("functions/_lib/db.js")) + "\n" + strip(ordersJs) + "\nreturn onRequestPost;")();
  const migrated = async (upTo) => {
    const db = await createD1();
    db._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f.slice(0, 4) <= upTo).sort()) db.execFile(read("migrations/" + f));
    db._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');
      INSERT INTO customers (name, email, createdAt, updatedAt) VALUES ('Pat Example', 'pat@example.com', 't', 't');`);
    return db;
  };
  // The desktop program's window is its admin, on 127.0.0.1.
  const caller = (api, db, env = {}) => async (body) => {
    const waits = [];
    const res = await api({ env: Object.assign({ DB: db }, env), waitUntil: (p) => waits.push(p && p.then ? p.then(() => {}, () => {}) : null),
      request: { url: env.EDITION === "desktop" ? "http://127.0.0.1/api/orders" : "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  console.log("\n=== The checks inside the actions with nobody signed in (testlib adminAs) ===");
  {
    const db = await migrated("9999");
    globalThis.__t316Role = "admin";
    const as = caller(glue(roles.adminAs({ roleFrom: "globalThis.__t316Role" })), db);
    let r = await as({ action: "createEstimate", org: "acme", customerId: 1 });
    const id = r.body.id;
    ok("on a database built from the migrations, an Admin makes a quote", r.status === 200 && /^Q-\d{5}$/.test(r.body.number));
    await as({ action: "saveEstimate", id, items: [{ kind: "custom", name: "Patch", qty: 1, unitPrice: 5 }] });
    globalThis.__t316Role = null;
    r = await as({ action: "createEstimate", org: "acme", customerId: 1 });
    const r2 = await as({ action: "saveEstimate", id, items: [{ kind: "custom", name: "Patch", qty: 1, unitPrice: 5 }, { kind: "product", productId: "p", qty: 1, customUnitPrice: 1 }] });
    const r3 = await as({ action: "convertEstimate", id });
    ok("with nobody signed in, the inside checks refuse on their own: no customer picked, no typed price, no order made",
      forbidden(r) && r.body.message === "Your role can't pick a customer for a quote. Ask an admin." && forbidden(r2) && r2.body.message === "Your role can't set a custom price. Ask an admin." &&
      forbidden(r3) && r3.body.message === "Your role can't make orders. Ask an admin." && db.q("SELECT count(*) n FROM orders")[0].n === 0);
    const bare = caller(glue(""), db);
    r = await bare({ action: "createEstimate", org: "acme", customerId: 1 });
    const b3 = await bare({ action: "convertEstimate", id });
    ok("a harness with no permission check at all is refused the same, never allowed by default", forbidden(r) && forbidden(b3) && db.q("SELECT count(*) n FROM orders")[0].n === 0);
    globalThis.__t316Role = "admin";
    const desk = caller(glue(roles.adminAs({ roleFrom: "globalThis.__t316Role" })), db, { EDITION: "desktop" });
    r = await desk({ action: "sendEstimate", id });
    ok("the desktop edition refuses to send a quote: 403, code desktop, \"This needs the internet, so it isn't part of the desktop version.\"",
      r.status === 403 && r.body.code === "desktop" && r.body.message === "This needs the internet, so it isn't part of the desktop version." && db.q("SELECT status FROM estimates WHERE id = " + id)[0].status === "draft");
    r = await desk({ action: "convertEstimate", id });
    ok("…but converts one there", r.status === 200 && r.body.orderId === "ACME-" + db.q("SELECT number FROM estimates WHERE id = " + id)[0].number.replace("-", ""));
  }

  console.log("\n=== A database that hasn't had migrations/0109 yet ===");
  {
    const db = await migrated("0108");
    ok("the database under test has no estimates table", db.q("SELECT count(*) n FROM sqlite_master WHERE name IN ('estimates', 'estimate_items')")[0].n === 0);
    globalThis.__t316Role = "admin";
    const old = caller(glue(roles.adminAs({ roleFrom: "globalThis.__t316Role" })), db);
    const log = db.q("SELECT count(*) n FROM audit_log")[0].n;
    let r = await old({ action: "listEstimates" });
    ok("listEstimates answers an empty list", r.status === 200 && same(r.body.estimates, []) && r.body.total === 0);
    ok("getEstimate, saveEstimate, sendEstimate and cancelEstimate answer 404 \"Quote not found\"", refused(await old({ action: "getEstimate", id: 1 }), 404, NOT_FOUND) &&
      refused(await old({ action: "saveEstimate", id: 1, items: [] }), 404, NOT_FOUND) && refused(await old({ action: "sendEstimate", id: 1 }), 404, NOT_FOUND) && refused(await old({ action: "cancelEstimate", id: 1 }), 404, NOT_FOUND));
    ok("convertEstimate answers 404 \"That quote wasn't found.\"", refused(await old({ action: "convertEstimate", id: 1 }), 404, "That quote wasn't found."));
    r = await old({ action: "createEstimate", org: "acme", customerId: 1 });
    ok("createEstimate says the database needs updating", refused(r, 400, "Quotes need the latest database update. Apply the migrations, then try again."));
    ok("none of them wrote an audit row or made an order", db.q("SELECT count(*) n FROM audit_log")[0].n === log && db.q("SELECT count(*) n FROM orders")[0].n === 0);
    // Half-way: the estimates table is there, its lines' table not yet.
    const half = await migrated("9999");
    const h = caller(glue(roles.adminAs({ roleFrom: "globalThis.__t316Role" })), half);
    const made = await h({ action: "createEstimate", org: "acme", customerId: 1 });
    half._raw.exec("DROP TABLE estimate_items");
    const NOT_READY = "Quotes aren't ready yet: the database is still being updated. Try again in a minute.";
    ok("with the quotes' lines table missing, getEstimate answers 503 \"" + NOT_READY + "\"", refused(await h({ action: "getEstimate", id: made.body.id }), 503, NOT_READY));
    ok("…and so do listEstimates, saveEstimate, sendEstimate, convertEstimate and cancelEstimate", refused(await h({ action: "listEstimates" }), 503, NOT_READY) &&
      refused(await h({ action: "saveEstimate", id: made.body.id, title: "x" }), 503, NOT_READY) && refused(await h({ action: "sendEstimate", id: made.body.id }), 503, NOT_READY) &&
      refused(await h({ action: "convertEstimate", id: made.body.id }), 503, NOT_READY) && refused(await h({ action: "cancelEstimate", id: made.body.id }), 503, NOT_READY));
    delete globalThis.__t316Role;
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
