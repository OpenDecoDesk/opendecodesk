const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { autoConfirm } = require("./testlib/confirm.js");
const { seedVendors } = require("./testlib/vendors.js");

// The vendor list (migrations/0084): one list every vendor box picks from — blanks, receipts, transfer sheets,
// expenses, Mark blank ordered — with "For blanks" and free shipping (an amount, 0 = always free; pieces; or none) per
// vendor, Hide, and Delete only when unused. The migration builds it from the names in use (the saved free shipping
// carried over); the server refuses a name that isn't on the list and stores the list's spelling;
// renaming a vendor renames every record. Real migrations, db.js and orders.js on sql.js; the admin page in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { listVendors, saveVendor, deleteVendor, resolveVendorName, ensureVendor, vendorShippingFor, createBlank, importBlanksCsv };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', message: 'Not allowed' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = async (fn, n = 400) => { for (let i = 0; i < n && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return fn(); };
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const fresh = async (upTo) => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations.filter(f => !upTo || f < upTo)) d1.execFile(read("migrations/" + f));
  return d1;
};

(async () => {
  console.log("=== The migration builds the list from what's in use ===");
  {
    const old = await fresh("0084");
    const now = "2026-11-01T00:00:00Z";
    old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);
      INSERT INTO blanks (name, vendor, createdAt, updatedAt) VALUES ('Tee', 'SanMar', '${now}', '${now}'), ('Polo', 'S&S', '${now}', '${now}'), ('Cap', '  sanmar ', '${now}', '${now}'), ('Bag', 'Amazon', '${now}', '${now}');
      INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, vendor, occurredAt, createdAt) VALUES (2, 'Polo', '', 'M', 5, 400, 'purchase', 'S&S Activewear', '${now}', '${now}');
      INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('O1', 'acme', 'Alex Sample', 'a@x.com', '${now}');
      INSERT INTO order_items (orderId, orgId, type, productId, name, size, qty, unitPriceCents, lineTotalCents, blankVendor) VALUES ('O1', 'acme', 'shirt', 'tee', 'Tee', 'M', 1, 1000, 1000, 'In stock'), ('O1', 'acme', 'shirt', 'tee', 'Tee', 'L', 1, 1000, 1000, 'S&S Activewear');
      INSERT INTO global_settings (key, value) VALUES ('vendorShipping', '{"amazon":{"name":"Amazon","overCents":1,"minQty":null},"jiffy":{"name":"Jiffy","overCents":5900,"minQty":null},"ss":{"name":"S&S","overCents":null,"minQty":null}}');`);
    const catId = old.q("SELECT id FROM expense_categories ORDER BY id LIMIT 1")[0].id;
    old._raw.run(`INSERT INTO expenses (expenseDate, description, categoryId, amountCents, vendor, createdAt, updatedAt) VALUES ('2026-10-01', 'Hosting', ?, 500, 'CloudFlare', ?, ?), ('2026-10-02', 'Thread', ?, 900, 'S&S Activewear', ?, ?)`, [catId, now, now, catId, now, now]);
    old.execFile(read("migrations/0084_vendors.sql"));
    const v = Object.fromEntries(old.q("SELECT * FROM vendors").map(r => [r.name, r]));
    ok("every name in use is on the list once — case and spaces ignored, two different spellings stay two, “In stock” isn't a vendor",
      Object.keys(v).sort().join("|") === "Amazon|CloudFlare|Jiffy|S&S|S&S Activewear|SanMar" && !v["In stock"]);
    ok("names from blanks, receipts and order lines are for blanks; one only on an expense isn't", v.SanMar.forBlanks === 1 && v["S&S"].forBlanks === 1 && v.Amazon.forBlanks === 1 && v.CloudFlare.forBlanks === 0);
    ok("every record now spells its vendor the list's way", old.q("SELECT vendor FROM blanks WHERE name='Cap'")[0].vendor === "SanMar" &&
      old.q("SELECT vendor FROM inventory_movements")[0].vendor === "S&S Activewear" && old.q("SELECT blankVendor FROM order_items WHERE size='L'")[0].blankVendor === "S&S Activewear" &&
      old.q("SELECT vendor FROM expenses WHERE description='Thread'")[0].vendor === "S&S Activewear" && old.q("SELECT blankVendor FROM order_items WHERE size='M'")[0].blankVendor === "In stock");
    ok("saved free shipping carries over: Jiffy $59, Amazon's $0.01 (the old stand-in for always free) is $0", v.Jiffy.freeShipOverCents === 5900 && v.Amazon.freeShipOverCents === 0);
    ok("…a saved entry with no amounts was “no free shipping”: S&S has none", v["S&S"].noFreeShipping === 1 && v["S&S"].freeShipOverCents === null);
    ok("…SanMar gets the old $200 default", v.SanMar.freeShipOverCents === 20000 && v.SanMar.noFreeShipping === 0);
    ok("…a vendor with nothing saved and no default has none set", v.CloudFlare.freeShipOverCents === null && v.CloudFlare.freeShipMinQty === null);
  }

  const d1 = await fresh();
  seedVendors(d1);
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);
  const call = async (body, { role = "admin" } = {}) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  console.log("\n=== Free shipping per vendor ===");
  let list = await lib.listVendors(d1);
  const vf = (n) => lib.vendorShippingFor(list, n);
  ok("an amount, pieces, $0 = every order, none", vf("SanMar").overCents === 20000 && vf("Otto Cap").minQty === 25 && vf("Amazon") === null);
  const amz = list.find(v => v.name === "Amazon");
  let r = await call({ action: "saveVendor", vendor: { id: amz.id, name: "Amazon", forBlanks: true, over: "0" } }, { role: "manager" });
  ok("$0 saves as free on every order", r.status === 200 && r.body.vendor.freeShipping.overCents === 0 && r.body.vendor.freeShipOverCents === 0);
  r = await call({ action: "saveVendor", vendor: { id: amz.id, name: "Amazon", forBlanks: true, over: "50", minQty: "10" } });
  ok("an amount and pieces together (whichever comes first)", r.body.vendor.freeShipping.overCents === 5000 && r.body.vendor.freeShipping.minQty === 10);
  r = await call({ action: "saveVendor", vendor: { id: amz.id, name: "Amazon", forBlanks: true, over: "50", noFreeShipping: true } });
  ok("No free shipping wins over any amount typed", r.body.vendor.freeShipping === null && r.body.vendor.noFreeShipping);
  ok("nonsense is refused: a negative amount, 0 pieces", (await call({ action: "saveVendor", vendor: { id: amz.id, name: "Amazon", over: "-1" } })).status === 400 &&
    (await call({ action: "saveVendor", vendor: { id: amz.id, name: "Amazon", minQty: "0" } })).status === 400);

  console.log("\n=== Adding, renaming, hiding, deleting ===");
  r = await call({ action: "saveVendor", vendor: { name: "  Gildan   Direct ", forBlanks: true, over: "150" } });
  const gid = r.body.vendor.id;
  ok("a new vendor (spaces tidied), audited", r.status === 200 && r.body.vendor.name === "Gildan Direct" && r.body.vendor.forBlanks && d1.q("SELECT COUNT(*) n FROM audit_log WHERE action='vendor.created'")[0].n === 1);
  ok("…a name already on the list (any case) is refused", (await call({ action: "saveVendor", vendor: { name: "sanmar" } })).status === 400);
  ok("…“In stock” can't be a vendor", (await call({ action: "saveVendor", vendor: { name: "In stock" } })).status === 400);
  ok("…a worker can read the list but not change it", (await call({ action: "listVendors" }, { role: "staff" })).status === 200 &&
    (await call({ action: "saveVendor", vendor: { name: "Nope" } }, { role: "staff" })).status === 403 && (await call({ action: "deleteVendor", id: gid }, { role: "staff" })).status === 403);
  const tee = (await lib.createBlank(d1, { name: "Tee", productType: "shirt", vendor: "Gildan Direct", sku: "G1", color: "", colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 0 }] }] })).id;
  d1._raw.run("INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, vendor, occurredAt, createdAt) VALUES (?, 'Tee', 'Navy', 'M', 2, 300, 'purchase', 'gildan direct', 't', 't')", [tee]);
  const catId = d1.q("SELECT id FROM expense_categories ORDER BY id LIMIT 1")[0].id;
  d1._raw.run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, vendor, createdAt, updatedAt) VALUES ('2026-10-02', 'Samples', ?, 900, 'Gildan Direct', 't', 't')", [catId]);
  r = await call({ action: "listVendors", withUse: true });
  ok("Manage vendors says what names each vendor", r.body.vendors.find(v => v.id === gid).used.blanks === 1 && r.body.vendors.find(v => v.id === gid).used["blank receipts"] === 1 && r.body.vendors.find(v => v.id === gid).usedTotal === 3);
  r = await call({ action: "deleteVendor", id: gid });
  ok("a vendor on records can't be deleted (hide it instead)", r.status === 409 && /hide it instead/.test(r.body.message));
  r = await call({ action: "saveVendor", vendor: { id: gid, name: "Gildan Brands", forBlanks: true, over: "150" } });
  ok("renaming renames every record that names it (any case)", r.status === 200 && r.body.renamed.blanks === 1 && d1.q(`SELECT vendor FROM blanks WHERE id=${tee}`)[0].vendor === "Gildan Brands" &&
    d1.q(`SELECT vendor FROM inventory_movements WHERE blankId=${tee}`)[0].vendor === "Gildan Brands" && d1.q("SELECT vendor FROM expenses WHERE description='Samples'")[0].vendor === "Gildan Brands");
  ok("…and the audit says from what", JSON.parse(d1.q("SELECT detail FROM audit_log WHERE action='vendor.updated' ORDER BY id DESC LIMIT 1")[0].detail).renamedFrom === "Gildan Direct");
  r = await call({ action: "saveVendor", vendor: { id: gid, name: "Gildan Brands", forBlanks: true, hidden: true } });
  ok("hidden: still on the list and its records", r.body.vendor.hidden && d1.q(`SELECT vendor FROM blanks WHERE id=${tee}`)[0].vendor === "Gildan Brands");
  r = await call({ action: "saveVendor", vendor: { name: "Unused Co" } });
  ok("a vendor nothing names can be deleted", (await call({ action: "deleteVendor", id: r.body.vendor.id })).status === 200 && !(await lib.listVendors(d1)).some(v => v.name === "Unused Co"));

  console.log("\n=== Records take a vendor from the list ===");
  r = await call({ action: "createBlank", name: "Polo", productType: "shirt", vendor: "Typed Vendor", sku: "P1", colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 0 }] }] });
  ok("a blank with a vendor that isn't on the list is refused, saying how to add it", r.status === 400 && /isn't in the vendor list — add it with Manage…/.test(r.body.message));
  r = await call({ action: "createBlank", name: "Polo", productType: "shirt", vendor: "s&s activewear", sku: "P1", colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 0 }] }] });
  ok("…another form of a listed name is stored as the list spells it", r.status === 200 && d1.q(`SELECT vendor FROM blanks WHERE id=${r.body.id}`)[0].vendor === "S&S");
  ok("…a hidden vendor still works on a record (it's only left out of the pickers)", (await call({ action: "updateBlank", id: tee, name: "Tee", productType: "shirt", vendor: "Gildan Brands", sku: "G1" })).status === 200);
  r = await call({ action: "saveExpense", expense: { date: "2026-10-05", description: "Box", categoryId: catId, amount: 12, vendor: "Somebody", paidPersonally: true } });
  ok("an expense with a vendor that isn't on the list is refused", r.status === 400 && /vendor list/.test(r.body.message));
  r = await call({ action: "saveExpense", expense: { date: "2026-10-05", description: "Box", categoryId: catId, amount: 12, vendor: "walmart", paidPersonally: true } });
  ok("…one on the list is saved in its spelling; no vendor is fine", r.status === 200 && d1.q("SELECT vendor FROM expenses WHERE description='Box'")[0].vendor === "Walmart" &&
    (await call({ action: "saveExpense", expense: { date: "2026-10-05", description: "Stamps", categoryId: catId, amount: 3, vendor: "", paidPersonally: true } })).status === 200);
  r = await call({ action: "receiveTransferSheet", vendor: "Typed Print Shop", rows: [], total: 10 });
  ok("a transfer sheet from a vendor that isn't on the list is refused", r.status === 400 && /vendor list/.test(r.body.message));
  d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, paid) VALUES ('O1','acme','Alex Sample','a@x.com','2026-10-01T12:00:00Z',1);
    INSERT INTO order_items (orderId, orgId, type, productId, name, size, qty, unitPriceCents, lineTotalCents) VALUES ('O1', 'acme', 'shirt', 'tee', 'Tee', 'M', 1, 1000, 1000);`);
  r = await call({ action: "setFulfillmentStage", org: "acme", orderId: "O1", stage: "blankOrdered", vendor: "Nobody Inc" });
  ok("Mark blank ordered with a vendor that isn't on the list is refused", r.status === 400 && /vendor list/.test(r.body.message));
  r = await call({ action: "setFulfillmentStage", org: "acme", orderId: "O1", stage: "blankOrdered", vendor: "sanmar" });
  ok("…with one on the list, the order lines get its spelling", r.status === 200 && d1.q("SELECT blankVendor FROM order_items WHERE orderId='O1'")[0].blankVendor === "SanMar");
  r = await lib.importBlanksCsv(d1, [{ style: "PC54", name: "Core Tee", supplier: "Mystery Mills", category: "Shirts", cost_M: "3" }, { style: "PC55", name: "Core Tee 2", supplier: "sanmar", category: "Shirts", cost_M: "3" }], { dryRun: true });
  ok("the blank CSV import: a supplier not on the list is a problem on its row; one on it is matched", r.results[0].problems.some(p => /Mystery Mills.*isn't in the vendor list/.test(p)) && !r.results[1].problems.length);
  ok("a vendor file or connection naming a vendor that isn't on the list adds it (for blanks)", await lib.ensureVendor(d1, "Brand New Supply", { forBlanks: true }) === "Brand New Supply" &&
    (await lib.listVendors(d1)).find(v => v.name === "Brand New Supply").forBlanks && await lib.ensureVendor(d1, "S&S Activewear") === "S&S");
  r = await call({ action: "getBlanksToOrder" });
  ok("Blanks to Order's “Start an order for…” offers the vendors for blanks that aren't hidden, with their free shipping",
    r.body.vendors.some(v => v.vendor === "SanMar" && v.freeShipping.overCents === 20000) && !r.body.vendors.some(v => v.vendor === "Gildan Brands") && !r.body.vendors.some(v => v.vendor === "Walmart"));
  ok("the old free-shipping actions are gone", (await call({ action: "setVendorShipping", vendor: "SanMar", over: "5" })).status !== 200);

  console.log("\n=== The admin page ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/#inventory", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.CSS = win.CSS || { escape: (x) => String(x) }; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminMe = { role: "admin", name: "A", email: "a@x" };');
  const app = d.getElementById("app");
  const opts = (sel) => [...sel.options].map(o => o.value).filter(Boolean);
  // The blank form.
  w.showBlankModal(null, () => {});
  await wait(() => d.getElementById("blkVendor") && opts(d.getElementById("blkVendor")).length);
  const bv = d.getElementById("blkVendor");
  ok("the blank form's Vendor is a picker of vendors for blanks (not hidden ones), with Manage…", bv.tagName === "SELECT" && opts(bv).includes("SanMar") && opts(bv).includes("S&S") &&
    !opts(bv).includes("Walmart") && !opts(bv).includes("Gildan Brands") && !!bv.parentElement.querySelector("[data-manage-vendors]"));
  bv.parentElement.querySelector("[data-manage-vendors]").click();
  await wait(() => d.querySelector("[data-vd-new]") && d.querySelector("[data-vendor-row]"));
  ok("Manage… opens the vendor list, with free shipping and what names each one", !!d.querySelector("[data-vd-new]") && /SanMar/.test(d.querySelector("[data-vd-body]").textContent) && /Free at \$200/.test(d.querySelector("[data-vd-body]").textContent));
  d.querySelector("[data-vd-new]").click();
  await wait(() => d.getElementById("vfmName"));
  d.getElementById("vfmName").value = "Next Level";
  d.getElementById("vfmOver").value = "0";
  d.getElementById("vfmSave").click();
  await wait(() => opts(d.getElementById("blkVendor")).includes("Next Level"));
  ok("a vendor added there is saved — $0 = every order — and picked in the form that opened it", (await lib.listVendors(d1)).find(v => v.name === "Next Level").freeShipOverCents === 0 &&
    d.getElementById("blkVendor").value === "Next Level" && /Free on every order/.test(d.querySelector("[data-vd-body]").textContent));
  d.querySelectorAll(".admin-modal-close, [data-modal-close]").forEach(b => b.click());
  // Mark blank ordered.
  const p = w.showBlankOrderModal("Blanks ordered");
  await wait(() => d.getElementById("blankVendorSelect") && opts(d.getElementById("blankVendorSelect")).length);
  const bo = d.getElementById("blankVendorSelect");
  ok("Mark blank ordered picks from the list (no fixed list, no “Other…” to type)", opts(bo).includes("SanMar") && opts(bo).includes("Next Level") && !opts(bo).includes("Other") && !d.getElementById("blankVendorOther"));
  d.getElementById("blankOrderForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  ok("…and needs one picked", /Pick the vendor/.test(d.getElementById("blankOrderFormErr").textContent));
  bo.value = "SanMar";
  d.getElementById("blankOrderForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  ok("…the vendor picked is what it sends", (await p).vendor === "SanMar");
  // Global settings no longer has Vendor free shipping.
  await w.renderGlobalSettings(app);
  await wait(() => d.getElementById("adminPanel") && !/Loading/.test(d.getElementById("adminPanel").textContent));
  ok("Global settings has no Vendor free shipping section any more", !d.getElementById("gVendorShipping") && !/Vendor free shipping/.test(d.getElementById("adminPanel").textContent));
  ok("every other vendor box is a picker: Receive order, Import from PDF, expenses, vendor files, quick blank, transfer sheets",
    /vendorPickerHtml_\("rccVendor"/.test(adminJs) && /vendorPickerHtml_\("piVendor"/.test(adminJs) && /vendorPickerHtml_\("expVendor"/.test(adminJs) && /vendorPickerHtml_\("vfVendor"/.test(adminJs) &&
    /vendorPickerHtml_\("qbVendor"/.test(adminJs) && /vendorPickerHtml_\("trVendor"/.test(adminJs) && /vendor: ov\.querySelector\("#trVendor"\)\.value/.test(adminJs) && /select class="ei-vendor"/.test(adminJs) &&
    !/id="(rccVendor|piVendor|expVendor|vfVendor|qbVendor|blkVendor)"[^>]*type="text"|<input[^>]*id="(rccVendor|piVendor|expVendor|vfVendor|qbVendor)"/.test(adminJs));
  ok("free shipping text: $0 reads “on every order” and counts as met at once", w.freeShipText_({ overCents: 0, minQty: null }) === "on every order" && w.freeShipProgress_({ overCents: 0, minQty: null }, 0, 0).met &&
    !w.freeShipProgress_({ overCents: 20000, minQty: null }, 100, 1).met);

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exitCode = 1; });
