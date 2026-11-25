const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { may } = require("./testlib/roles");
const { JSDOM, ResourceLoader } = require("jsdom");

// Archived blanks (review #82, migrations/0104). A retired blank (a discontinued style kept for its stock history) can
// be archived: it leaves the Blanks screen (unless Show archived), product linking and vendor matching. Its stock,
// movements, history and reports are unchanged, and it can be unarchived. The admin's cached blanks list still
// carries it (flagged), because orders and history look blanks up by id there.
// Real SQL (sql.js) + real db.js, permissions.js, orders.js and admin.js (jsdom). Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createBlank, getAllBlanks, getBlankMovements, getInventoryValuation, setBlankArchived };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@example.test'; const adminUser = () => null; const adminCan = () => true;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  const pending = [];
  const call = async (body) => {
    const full = Object.assign({ key: "x" }, body);
    const request = { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})), request });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const settle = async () => { await Promise.all(pending.splice(0)); };

  console.log("=== The column ===");
  ok("migration 0104 adds blanks.archivedAt; schema.sql has it for new installs", d1.q("SELECT 1 FROM pragma_table_info('blanks') WHERE name = 'archivedAt'").length === 1 &&
    /archivedAt TEXT\s*\n\);/.test(read("schema.sql").slice(read("schema.sql").indexOf("CREATE TABLE IF NOT EXISTS blanks ("))));

  const old = await lib.createBlank(d1, { name: "Old cap", brand: "Generic", color: "Navy", productType: "cap", vendor: "Example Supply", sku: "OC1" }, [{ size: "OSFA", quantity: 5, purchasePrice: 3 }]);
  const cur = await lib.createBlank(d1, { name: "New cap", brand: "Generic", color: "Navy", productType: "cap", vendor: "Example Supply", sku: "NC1" }, [{ size: "OSFA", quantity: 7, purchasePrice: 4 }]);
  const now = new Date().toISOString();
  const valueBefore = JSON.stringify(await lib.getInventoryValuation(d1, now));
  const movesBefore = (await lib.getBlankMovements(d1, old.id)).length;

  console.log("\n=== Archive ===");
  let r = await call({ action: "setBlankArchived", id: old.id, archived: true });
  ok("archived: the answer says when, and carries the blanks list", r.status === 200 && /^\d{4}-\d{2}-\d{2}T/.test(r.body.archivedAt) && Array.isArray(r.body.blanks));
  ok("…on the audit log", d1.q("SELECT detail FROM audit_log WHERE action = 'inventory.blank_archived'").some(x => JSON.parse(x.detail).blankId === old.id));
  ok("getAllBlanks leaves it out by default, and includes it (flagged) when asked", (await lib.getAllBlanks(d1)).map(b => b.id).join() === String(cur.id) &&
    (await lib.getAllBlanks(d1, { includeArchived: true })).find(b => b.id === old.id).archivedAt === r.body.archivedAt);
  await settle();
  const listed = await call({ action: "getBlanks" });
  ok("the admin's blanks list still carries it, flagged (orders and history look blanks up by id)", listed.body.blanks.find(b => b.id === old.id).archivedAt === r.body.archivedAt);
  ok("its stock, history and the inventory valuation are unchanged", d1.q("SELECT quantity FROM blank_sizes WHERE blankId = ?", old.id)[0].quantity === 5 &&
    (await lib.getBlankMovements(d1, old.id)).length === movesBefore && JSON.stringify(await lib.getInventoryValuation(d1, now)) === valueBefore);
  r = await call({ action: "buildProductFromBlank", org: "acme", productId: "oldcap", blankId: old.id, name: "Old cap", sizes: ["OSFA"], price: 20 });
  ok("a product can't be built from an archived blank", r.status === 404);
  r = await call({ action: "setBlankArchived", id: old.id, archived: true });
  ok("archiving again keeps the first date", r.body.archivedAt === d1.q("SELECT archivedAt FROM blanks WHERE id = ?", old.id)[0].archivedAt &&
    d1.q("SELECT count(*) n FROM blanks WHERE archivedAt IS NOT NULL")[0].n === 1);
  ok("an unknown blank: 404", (await call({ action: "setBlankArchived", id: 99999, archived: true })).status === 404);
  ok("archiving is Blanks at Edit: Back office may, Production may not", may("staff", "setBlankArchived") === may("staff", "updateBlank") && !may("production", "setBlankArchived"));
  await settle();

  console.log("\n=== The Blanks screen ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  class L extends ResourceLoader { fetch(url, o) {
    if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs));
    const local = new URL(url).pathname.match(/^\/vendor\/fonts\/[a-z0-9.-]+$/);
    return local ? Promise.resolve(fs.readFileSync(__dirname + "/public" + local[0])) : super.fetch(url, o); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async (u, init) => {
      if (String(u).includes("/api/catalog")) return { ok: true, status: 200, json: async () => ({ status: "admin", features: {} }) };
      if (!String(u).includes("/api/orders")) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; sent.push(b); const x = await call(b); await settle();
      return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }; }; } });
  const w = dom.window, doc = w.document;
  w.CSS = { escape: (x) => String(x).replace(/[^a-zA-Z0-9_-]/g, "\\$&") };
  await tick(150);
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Example Club" }];');
  const app = doc.getElementById("app");
  await w.renderAdminBlanks(app);
  await tick(150);
  const row = (id) => doc.querySelector(`[data-blank-row="${id}"]`);
  const menuItems = (id) => [...row(id).querySelectorAll(".admin-menu-item")].map(b => b.textContent.trim());
  ok("an archived blank is off the list; the others are on it", !row(old.id) && !!row(cur.id));
  ok("…a 'Show archived' switch, off", doc.getElementById("blankShowArchived") && !doc.getElementById("blankShowArchived").checked);
  doc.getElementById("blankShowArchived").checked = true;
  doc.getElementById("blankShowArchived").dispatchEvent(new w.Event("change"));
  ok("Show archived lists it, marked ARCHIVED, with Unarchive in its ⋯ menu", row(old.id) && /ARCHIVED/.test(row(old.id).textContent) && menuItems(old.id).includes("Unarchive") && !menuItems(old.id).includes("Archive"));
  ok("…a blank in use offers Archive", menuItems(cur.id).includes("Archive") && !/ARCHIVED/.test(row(cur.id).textContent));
  doc.getElementById("blankShowArchived").checked = false;
  doc.getElementById("blankShowArchived").dispatchEvent(new w.Event("change"));
  sent.length = 0;
  row(cur.id).querySelector('[data-admin-action="blankArchive"]').click();
  for (let i = 0; i < 50 && row(cur.id); i++) await tick(20);
  ok("Archive (the ⋯ menu) archives it and it leaves the list", sent.some(b => b.action === "setBlankArchived" && b.id === cur.id && b.archived === true) && !row(cur.id) &&
    !!d1.q("SELECT archivedAt FROM blanks WHERE id = ?", cur.id)[0].archivedAt);
  ok("…with every blank archived, the screen says so", /Every blank is archived/.test(doc.getElementById("blanksPanel").textContent));
  doc.getElementById("blankShowArchived").checked = true;
  doc.getElementById("blankShowArchived").dispatchEvent(new w.Event("change"));
  row(cur.id).querySelector('[data-admin-action="blankUnarchive"]').click();
  for (let i = 0; i < 50 && /ARCHIVED/.test(row(cur.id).textContent); i++) await tick(20);
  ok("Unarchive brings it back into use", !/ARCHIVED/.test(row(cur.id).textContent) && d1.q("SELECT archivedAt FROM blanks WHERE id = ?", cur.id)[0].archivedAt === null &&
    d1.q("SELECT count(*) n FROM audit_log WHERE action = 'inventory.blank_unarchived'")[0].n === 1);

  console.log("\n=== Product linking and vendor matching ===");
  d1._raw.exec(`INSERT INTO products (orgId, productId, name, type, pricingMode, flatPriceCents, visible, sortOrder, createdAt, updatedAt) VALUES ('acme','plain','Plain cap','cap','flat',2000,1,0,'t','t');`);
  const section = doc.createElement("div"); section.id = "blankLinksSection"; app.appendChild(section);
  await w.loadBlankLinksSection("acme", { productId: "plain", name: "Plain cap", type: "cap", pricingMode: "flat", sizePricing: {} });
  await tick(60);
  const offered = () => [...section.querySelectorAll("option")].map(o => o.value);
  ok("a product's blank picker offers blanks in use, not archived ones", offered().includes(String(cur.id)) && !offered().includes(String(old.id)));
  await lib.setBlankArchived(d1, cur.id, true);
  d1.q("INSERT INTO product_blank_links (orgId, productId, productColor, productSize, blankId, blankColor, blankSize) VALUES ('acme','plain','','OSFA',?,'Navy','OSFA')", cur.id);
  section.innerHTML = "";
  await w.loadBlankLinksSection("acme", { productId: "plain", name: "Plain cap", type: "cap", pricingMode: "flat", sizePricing: {} });
  await tick(60);
  ok("…but a product already linked to a blank still shows it after it's archived", offered().includes(String(cur.id)) && !offered().includes(String(old.id)));
  await lib.setBlankArchived(d1, cur.id, false);
  w.eval(`window._blanksAll = ${JSON.stringify((await call({ action: "getBlanks" })).body.blanks)};`);
  w.showVendorLinkBlanks_({ id: 77, name: "Example Supply" }, () => {});
  await tick(40);
  const ticks = [...doc.querySelectorAll(".vlb")].map(x => Number(x.value));
  ok("linking blanks to a connected vendor lists the blanks in use, not archived ones", ticks.includes(cur.id) && !ticks.includes(old.id));

  dom.window.close();
  if (failed) console.log("\nFAILED:", failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log("crashed: false"); console.error(e); process.exit(1); });
