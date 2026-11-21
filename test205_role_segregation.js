// Roles do only what their level allows, even inside a bigger action (functions/_lib/permissions.js):
//   * Edit items (editOrder): removing a line is a cancel (orders.details Full), its refund a refund (orders.payments
//     Full), asking the customer to pay needs Payments; every line must be the order's own; a line that can't be
//     priced refuses the whole edit before anything is written.
//   * Users: a role that can do more than yours is neither given nor are its users changed (admin-users.js).
//   * The send agent: putting a file onto a machine needs Run Edit or Machine files Edit, not Read (agent.js).
//   * costs.view: the order lists leave out cost of goods and processor fees; Run Order's blanks leave out costs.
//   * Blanks: Edit can't change stock or average cost from the blank form; merging blanks is Full.
//   * Local sale: Paid needs Payments, Delivered needs the late steps.
//   * Shipping: the label details are Shipping's; the charge and a ship-to state that moves the tax are Payments'.
//   * The audit log keeps only real order IDs, and its order links carry the ID as data, not code.
// Real sign-in (testlib/auth-harness), real SQL and the real endpoints; jsdom with the real admin page.
const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { makeAuth, prelude, strip, read } = require("./testlib/auth-harness");
const { may, asRole } = require("./testlib/roles");
const ok = (m, c) => console.log(m + ":", !!c);

(async () => {
  const A = await makeAuth();
  const admin = await A.firstAdmin();
  const staff = await A.addUser(admin, "staff", "Sam Sample", "sam@example.com");
  const prod = await A.addUser(admin, "production", "Pat Sample", "pat@example.com");
  const now = new Date().toISOString();
  A.d1._raw.exec(`
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('shop1', 'shop1', 'Sample Shop', '${now}', '${now}');
    INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, shippingCostCents, shippingAddress)
      VALUES ('TST-1001', 'shop1', 'Alex Sample', 'alex@example.com', '${now}', 800, '{"name":"Alex Sample","line1":"1 Sample St","city":"Sampleton","state":"CA","zip":"94105","country":"US"}');
    INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('TST-2002', 'shop1', 'Blair Sample', 'blair@example.com', '${now}');
    INSERT INTO order_items (id, orderId, orgId, productId, name, type, size, qty, unitPriceCents, lineTotalCents, cogsCents, cogsSource)
      VALUES (11, 'TST-1001', 'shop1', 'tee', 'Sample Tee', 'shirt', 'M', 1, 2000, 2000, 500, 'consumed');
    INSERT INTO order_items (id, orderId, orgId, productId, name, type, size, qty, unitPriceCents, lineTotalCents)
      VALUES (12, 'TST-1001', 'shop1', 'tee', 'Sample Tee', 'shirt', 'L', 1, 2000, 2000);
    INSERT INTO order_items (id, orderId, orgId, productId, name, type, size, qty, unitPriceCents, lineTotalCents)
      VALUES (21, 'TST-2002', 'shop1', 'tee', 'Sample Tee', 'shirt', 'S', 1, 2000, 2000);
    INSERT INTO order_payments (orderId, amountCents, receivedAt, method, feeCents, kind) VALUES ('TST-1001', 4000, '${now}', 'card', 146, 'payment');
  `);
  const item = (id) => A.d1.q("SELECT * FROM order_items WHERE id=" + Number(id))[0];
  const forbidden = (r) => r.status === 403;

  // A role that may cancel lines (orders.details Full) but has no Payments and no steps.
  let r = await A.users({ action: "saveRole", name: "Order clerk", rank: 40, permissions: { fns: { "orders.details": "full" } } }, admin);
  const clerkKey = r.body.role && r.body.role.key;
  const clerk = await A.addUser(admin, clerkKey, "Casey Sample", "casey@example.com");

  console.log("=== Edit items: removals, refunds and payment requests need their own levels ===");
  r = await A.orders({ action: "editOrder", org: "shop1", orderId: "TST-1001", removals: [{ itemId: 11, refundAmount: 0 }] }, staff);
  ok("Back office (Details Edit) can't remove a line through Edit items", forbidden(r) && !item(11).cancelDate);
  r = await A.orders({ action: "editOrder", org: "shop1", orderId: "TST-1001", removals: [{ itemId: 11, refundAmount: 20 }] }, clerk);
  ok("a role with Details Full but no Payments Full can't refund the line it removes", forbidden(r) && !item(11).cancelDate && !item(11).refundCents);
  r = await A.orders({ action: "editOrder", org: "shop1", orderId: "TST-1001", requestPayment: true }, clerk);
  ok("…nor ask the customer to pay", forbidden(r));
  r = await A.orders({ action: "editOrder", org: "shop1", orderId: "TST-1001", removals: [{ itemId: 21, refundAmount: 0 }] }, admin);
  ok("a line from another order is refused, and left alone", r.status === 400 && /isn't on this order/.test(r.body.message) && !item(21).cancelDate);
  r = await A.orders({ action: "editOrder", org: "shop1", orderId: "TST-1001", updates: [{ itemId: 21, productId: "tee", size: "S", qty: 5 }] }, admin);
  ok("…for a change as well as a removal", r.status === 400 && Number(item(21).qty) === 1);
  r = await A.orders({ action: "editOrder", org: "shop1", orderId: "TST-1001", removals: [{ itemId: 11, refundAmount: 0 }], additions: [{ productId: "no-such-product", size: "M", qty: 1 }] }, admin);
  ok("a line that can't be priced refuses the whole edit before anything is written", r.status === 400 && !item(11).cancelDate &&
    A.d1.q("SELECT count(*) n FROM order_items WHERE orderId='TST-1001'")[0].n === 2);
  r = await A.orders({ action: "editOrder", org: "shop1", orderId: "TST-1001", removals: [{ itemId: 12, reason: "Changed mind", refundAmount: 0 }] }, clerk);
  ok("Details Full removes a line (no refund) through Edit items", r.status === 200 && !!item(12).cancelDate && !item(12).refundCents);
  ok("…and the edit is in the audit log", A.audit("order.edited").some(e => e.orderId === "TST-1001"));
  A.d1._raw.exec("UPDATE order_items SET cancelDate=NULL, cancelReason='' WHERE id=12");

  console.log("=== Users: never a role that can do more than yours ===");
  r = await A.users({ action: "saveRole", name: "Bookkeeper", rank: 60, permissions: { fns: { "finance.expenses": "full", "reports.audit": "read" } } }, admin);
  const bookKey = r.body.role && r.body.role.key;
  r = await A.users({ action: "saveRole", name: "Viewer", rank: 10, permissions: { fns: { "home.counts": "read" } } }, admin);
  const viewerKey = r.body.role && r.body.role.key;
  r = await A.users({ action: "saveRole", name: "Hiring", rank: 70, permissions: { fns: { "settings.users": "edit", "home.counts": "read" } } }, admin);
  const hiring = await A.addUser(admin, r.body.role.key, "Harper Sample", "harper@example.com");
  const book = (await A.users({ action: "create", name: "Bo Sample", email: "bo@example.com", role: bookKey }, admin)).body.user;
  const viewer = (await A.users({ action: "create", name: "Vi Sample", email: "vi@example.com", role: viewerKey }, admin)).body.user;
  r = await A.users({ action: "create", name: "Taken Over", email: "mine@example.com", role: bookKey }, hiring);
  ok("a user manager can't create a user with a lower-ranked role that has more than theirs", forbidden(r) && !A.user("mine@example.com") && !r.body.temporaryPassword);
  r = await A.users({ action: "create", name: "New Viewer", email: "nv@example.com", role: viewerKey }, hiring);
  ok("…but can with a role that has nothing beyond theirs", r.status === 200 && !!r.body.temporaryPassword);
  r = await A.users({ action: "setRole", id: viewer.id, role: bookKey }, hiring);
  ok("…nor give such a role to an existing user", forbidden(r) && A.user("vi@example.com").role === viewerKey);
  r = await A.users({ action: "resetPassword", id: book.id }, hiring);
  ok("…nor reset the password of someone whose role has more (no temporary password comes back)", forbidden(r) && !r.body.temporaryPassword);
  ok("…nor change their email or two-step", forbidden(await A.users({ action: "update", id: book.id, name: "Bo Sample", email: "me2@example.com" }, hiring)) &&
    forbidden(await A.users({ action: "reset2fa", id: book.id }, hiring)) && A.user("bo@example.com"));
  ok("…while a user whose role is within theirs can still be reset", (await A.users({ action: "resetPassword", id: viewer.id }, hiring)).status === 200);
  r = await A.users({ action: "listRoles" }, hiring);
  const rv = (k) => (r.body.roles || []).find(x => x.key === k) || {};
  ok("the Users screen hears which roles are within the caller's own", rv(bookKey).withinMine === false && rv(viewerKey).withinMine === true && rv("production").withinMine === false);
  r = await A.users({ action: "listRoles" }, admin);
  ok("…and for an admin every role is", (r.body.roles || []).every(x => x.withinMine === true));
  ok("an admin still gives any role", (await A.users({ action: "setRole", id: viewer.id, role: bookKey }, admin)).status === 200);

  console.log("=== costs.view: the order lists and Run Order's blanks ===");
  const lineOf = (body) => ((body.orders || []).find(o => o.orderId === "TST-1001") || { items: [] });
  r = await A.orders({ action: "getOrders", org: "shop1" }, prod);
  let o = lineOf(r.body);
  ok("Production (no costs.view) gets the order without cost of goods or processor fees",
    r.status === 200 && o.items.length === 2 && o.items.every(it => !("cogs" in it) && !("cogsSource" in it)) && o.payments.every(p => !("fee" in p)) && !("processorFees" in o));
  ok("…but with its prices and payments", o.items[0].unitPrice === 20 && o.payments.length === 1 && o.payments[0].amount === 40);
  r = await A.orders({ action: "getOrders", org: "shop1" }, admin);
  o = lineOf(r.body);
  ok("an admin gets them", o.items.some(it => it.cogs === 5) && o.payments[0].fee === 1.46 && o.processorFees === 1.46);
  r = await A.orders({ action: "getOrdersAllShops" }, staff);
  o = ((r.body.shops || [])[0] || { orders: [] }).orders.find(x => x.orderId === "TST-1001") || { items: [] };
  ok("All shops leaves them out too (Back office has no costs.view)", o.items.length === 2 && o.items.every(it => !("cogs" in it)) && o.payments.every(p => !("fee" in p)));
  r = await A.orders({ action: "getOpenOrders" }, prod);
  o = (r.body.orders || []).find(x => x.orderId === "TST-1001") || { items: [] };
  ok("…and so does Home's open orders", r.status === 200 && o.items.every(it => !("cogs" in it)) && !("processorFees" in o));
  A.d1._raw.exec(`INSERT INTO blanks (id, name, createdAt, updatedAt) VALUES (7, 'Sample Blank', '${now}', '${now}');
    INSERT INTO blank_colors (blankId, color, imagesJson, sortOrder, createdAt, updatedAt) VALUES (7, 'Navy', '[]', 0, '${now}', '${now}');
    INSERT INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity, vendorPriceCents) VALUES (7, 'Navy', 'M', 500, 10, 450);`);
  r = await A.orders({ action: "getBlanks" }, prod);
  const sizeOf = (body) => (((body.blanks || []).find(b => b.id === 7) || { sizes: [] }).sizes[0]) || {};
  ok("Run Order's blanks for Production carry stock but no average cost or vendor price",
    r.status === 200 && sizeOf(r.body).quantity === 10 && !("purchasePrice" in sizeOf(r.body)) && !("vendorPrice" in sizeOf(r.body)) &&
    (r.body.blanks.find(b => b.id === 7).colors[0].sizes[0].purchasePrice === undefined));
  r = await A.orders({ action: "getBlanks" }, staff);
  ok("the Blanks screen (Blanks Read) keeps them: receiving and pricing work there", sizeOf(r.body).purchasePrice === 5 && sizeOf(r.body).vendorPrice === 4.5);

  console.log("=== Blanks: stock and cost from the blank form, merging ===");
  const blankSave = (qty, extra) => ({ action: "updateBlank", id: 7, name: "Sample Blank", ...(extra || {}),
    colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: qty, baseQuantity: 10, purchasePrice: 5, basePurchasePrice: 5 }] }] });
  const blankRow = () => A.d1.q("SELECT b.name, s.quantity, s.purchasePriceCents FROM blanks b JOIN blank_sizes s ON s.blankId=b.id WHERE b.id=7")[0];
  r = await A.orders(blankSave(4, { name: "Renamed Blank" }), staff);
  ok("Back office (Blanks Edit) can't change stock from the blank form, and nothing of the save is written",
    forbidden(r) && /Count stock/.test(r.body.message) && blankRow().quantity === 10 && blankRow().name === "Sample Blank" &&
    !A.d1.q("SELECT count(*) n FROM inventory_movements WHERE blankId=7")[0].n);
  r = await A.orders({ action: "updateBlank", id: 7, name: "Sample Blank", colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: 10, purchasePrice: 9 }] }] }, staff);
  ok("…nor its average cost", forbidden(r) && blankRow().purchasePriceCents === 500);
  r = await A.orders({ action: "updateBlank", id: 7, name: "Sample Blank", colors: [{ color: "Navy", images: [], sizes: [] }] }, staff);
  ok("…nor drop a size that has stock", forbidden(r) && blankRow().quantity === 10);
  r = await A.orders(blankSave(10, { name: "Renamed Blank" }), staff);
  ok("…but saves everything else", r.status === 200 && blankRow().name === "Renamed Blank" && blankRow().quantity === 10);
  r = await A.orders(blankSave(12), admin);
  ok("Full changes the count, as an adjustment", r.status === 200 && blankRow().quantity === 12 && A.d1.q("SELECT count(*) n FROM inventory_movements WHERE blankId=7")[0].n === 1);
  ok("merging blanks (which deletes them) needs Full; removing a product's blank link is Edit, as saving its links is",
    !may("staff", "mergeBlanks") && may("manager", "mergeBlanks") && may("staff", "deleteBlankLink") && may("staff", "saveBlankLinks"));

  console.log("=== Local sale: Paid and Delivered ===");
  r = await A.orders({ action: "createLocalSale", org: "shop1", items: [{ productId: "tee", size: "M", qty: 1 }], paid: true }, clerk);
  ok("Paid needs Payments", forbidden(r) && /payments/.test(r.body.message));
  r = await A.orders({ action: "createLocalSale", org: "shop1", items: [{ productId: "tee", size: "M", qty: 1 }], delivered: true }, clerk);
  ok("Delivered needs the late steps", forbidden(r) && /step/.test(r.body.message));
  ok("no order was made", A.d1.q("SELECT count(*) n FROM orders")[0].n === 2);

  console.log("=== Shipping: the label details, not the charge ===");
  const ship = (cost, state, zip) => ({ action: "setShippingInfo", org: "shop1", orderId: "TST-1001", totalWeightOz: 12, shippingCost: cost, shippingMethod: "Ground",
    shippingAddress: { name: "Alex Sample", line1: "2 Sample Ave", city: "Sampleton", state, zip, country: "US" } });
  const orderRow = () => A.d1.q("SELECT shippingCostCents, shippingAddress, totalWeightOz FROM orders WHERE orderId='TST-1001'")[0];
  r = await A.orders(ship(8, "CA", "94105"), prod);
  ok("Production saves a corrected street and the weight at the same charge", r.status === 200 && Number(orderRow().totalWeightOz) === 12 && /2 Sample Ave/.test(orderRow().shippingAddress));
  r = await A.orders(ship(0, "CA", "94105"), prod);
  ok("…but can't change what the customer pays for shipping", forbidden(r) && Number(orderRow().shippingCostCents) === 800);
  r = await A.orders(ship(8, "NY", "10001"), prod);
  ok("…nor move the ship-to state (it decides the sales tax)", forbidden(r) && /"CA"/.test(orderRow().shippingAddress));
  r = await A.orders(ship(12.5, "NY", "10001"), admin);
  ok("Payments can do both", r.status === 200 && Number(orderRow().shippingCostCents) === 1250 && /"NY"/.test(orderRow().shippingAddress));

  console.log("=== The send agent: writing onto a machine needs more than Read ===");
  const agentApi = (who) => new Function("deps",
    "const {classifyHost, requireAdmin, timingSafeEqual, jsonResponse, rateLimited, rateLimitResponse, signedDesignPath, DESIGN_KEY_RE, adminUser, adminCan} = deps;\n" +
    "const featureIsOff = async () => false, featureOffResponse = () => null;\n" +
    strip(read("functions/_lib/agentRelay.js")) + "\n" + strip(read("functions/api/agent.js")) + "\nreturn onRequestPost;")({
    classifyHost: () => ({ kind: "admin" }), requireAdmin: async () => null, timingSafeEqual: (a, b) => a === b,
    jsonResponse: (b, s) => new Response(JSON.stringify(b), { status: s || 200, headers: { "Content-Type": "application/json" } }),
    rateLimited: async () => ({ blocked: false }), rateLimitResponse: () => new Response("{}", { status: 429 }), signedDesignPath: async () => "/x",
    DESIGN_KEY_RE: /^designs\/[a-z0-9-]+\/[a-z0-9]{32}\.[a-z0-9]{1,10}$/,
    adminUser: () => ({ roleInfo: {} }), adminCan: (req, fn, lvl) => (who[fn] || 0) >= ({ read: 1, edit: 2, full: 3 })[lvl] });
  const store = new Map();
  global.caches = { default: { async match(k) { const v = store.get(k); return v === undefined ? undefined : new Response(v); },
    async put(k, res) { store.set(k, await res.text()); }, async delete(k) { return store.delete(k); } } };
  const send = async (who) => (await agentApi(who)({ request: { url: "https://admin.example.com/api/agent?op=submit", headers: { get: () => null },
    json: async () => ({ type: "send", machineIp: "192.0.2.10", fileKey: "designs/9/" + "a".repeat(32) + ".dst", fileName: "SAMPLE.DST" }) },
    env: { AGENT_TOKEN: "t".repeat(40) } })).status;
  ok("Machine files Read can't send a design onto a machine", await send({ "production.machinefiles": 1, "production.machines": 1 }) === 403);
  ok("Run Edit or Machine files Edit gets past the role check (here to 'agent offline')",
    await send({ "run.runs": 2 }) === 503 && await send({ "production.machinefiles": 2 }) === 503);

  console.log("=== The audit log: only real order IDs, linked as data ===");
  const insertAuditLog = new Function("__hits", prelude(false, false) + "\nreturn insertAuditLog;")([]);
  const evil = "x');window.__pwned=1;//";
  await insertAuditLog(A.d1, { orgId: null, orderId: evil, action: "run.completed", detail: {} });
  await insertAuditLog(A.d1, { orgId: null, orderId: "TST-1001", action: "run.aborted", detail: {} });
  ok("an order ID that isn't one is not stored", A.audit("run.completed").slice(-1)[0].orderId === null);
  ok("…a real one is", A.audit("run.aborted").slice(-1)[0].orderId === "TST-1001");

  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = async (u, opt) => {
        const b = (() => { try { return JSON.parse((opt && opt.body) || "{}"); } catch (e) { return {}; } })();
        const body = b.action === "getAuditLog" ? { status: "ok", entries: [{ id: 1, createdAt: now, orgId: "shop1", orderId: evil, action: "run.completed", detail: null, actor: "x" }] }
          : b.action === "listOrgs" ? { status: "ok", orgs: [] } : { status: "error", message: "n/a" };
        return { ok: true, status: 200, json: async () => body };
      };
    } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  const tick = (ms = 30) => new Promise(res => setTimeout(res, ms));
  w.eval("adminKey = 'test-key';");
  w.eval(asRole("admin"));
  const app = d.getElementById("app") || d.body;
  await w.eval("renderAuditLog")(app); await tick(80);
  const link = d.querySelector("#auditResults a[data-order]");
  ok("an order ID in the audit log is a link that carries the ID as data", !!link && link.dataset.order === evil && !/afOrder'\)\.value='/.test(link.getAttribute("onclick")));
  if (link) link.click();
  await tick();
  ok("…clicking it filters by that ID and runs nothing in it", d.getElementById("afOrder").value === evil && w.__pwned === undefined);
  ok("design file downloads carry their key as data too", /data-key="\$\{escapeHtml\(v\.designFileKey\)\}" onclick="downloadDesignFile_\(this\.dataset\.key\)"/.test(adminJs) &&
    /data-key="\$\{escapeHtml\(v\.machineFileKey\)\}" onclick="downloadDesignFile_\(this\.dataset\.key\)"/.test(adminJs));

  console.log("=== The page offers only what the server allows ===");
  const order = { orderId: "TST-1001", customerName: "Alex Sample", total: 40, shippingCost: 0, items: [
    { sheetRow: 11, productId: "tee", name: "Sample Tee", type: "shirt", size: "M", qty: 1, unitPrice: 20, personalizationFee: 0, personalized: false, persName: "", lineTotal: 20, cancelDate: "" }] };
  const products = [{ productId: "tee", name: "Sample Tee", type: "shirt", pricingMode: "flat", flatPrice: 20, personalizationPrice: null, visible: true }];
  const editAs = async (role) => {
    w.eval(asRole(role));
    const pending = w.showEditOrderModal(order, products);
    await tick();
    const ov = d.body.lastElementChild;
    const removeBtn = ov.querySelector('#editOrderRows [data-action="remove"]');
    let refund = false;
    if (removeBtn) { removeBtn.click(); await tick(); refund = !!ov.querySelector('[data-field="_refundAmount"]'); }
    d.getElementById("editOrderSave").click();
    const res = await pending;
    return { remove: !!removeBtn, refund, sent: res && res.removals[0] };
  };
  let e = await editAs("staff");
  ok("Edit items: Back office isn't offered Remove on an existing line", !e.remove && !e.sent);
  e = await editAs("admin");
  ok("…an admin is, with a refund box", e.remove && e.refund && e.sent && e.sent.refundAmount === 20);
  w.eval(`adminPerms = Object.assign({}, adminPerms, { "orders.payments": "edit" });`);
  {
    const pending = w.showEditOrderModal(order, products);
    await tick();
    const ov = d.body.lastElementChild;
    ov.querySelector('#editOrderRows [data-action="remove"]').click(); await tick();
    const noRefundBox = !ov.querySelector('[data-field="_refundAmount"]');
    d.getElementById("editOrderSave").click();
    const res = await pending;
    ok("…a role without Payments Full removes the line with no refund box, and sends no refund", noRefundBox && res.removals[0].refundAmount === 0);
  }
  ok("Local sale: Paid needs Payments, Delivered the late steps", /<label data-need="orders\.payments:edit"[^>]*>\s*<input type="checkbox" id="lsPaid"/.test(adminJs) &&
    /<label data-need="orders\.stepsLate:edit"[^>]*>\s*<input type="checkbox" id="lsDelivered"/.test(adminJs));
  ok("Shipping: rates, shipping paid and the payment link need Payments", /id="getRatesBtn" type="button" data-need="orders\.payments:edit"/.test(adminJs) &&
    /id="shipSendPayment" data-need="orders\.payments:edit"/.test(adminJs) && /<div data-need="orders\.payments:edit">\s*<label[^>]*>Shipping paid/.test(adminJs));
  ok("Blanks: Merge needs Full; an existing blank's counts are locked without Full", /data-need="inventory\.blanks:full" onclick="blankMerge\(/.test(adminJs) &&
    /data-sf="quantity"\$\{isNew \? "" : ' data-need-form="inventory\.blanks:full"'\}/.test(adminJs));
  ok("Users: a role beyond the caller's isn't offered, and its users can't be changed", /r\.withinMine !== false\);/.test(adminJs) && /\|\| beyondMine\(u\.role\);/.test(adminJs));
  dom.window.close();
})();
