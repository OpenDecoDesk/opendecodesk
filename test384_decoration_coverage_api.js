const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const { makeAuth } = require("./testlib/auth-harness");
const { shopOrigin, ROOT, ADMIN_ORIGIN } = require("./testlib/hosts.js");

// Phase 5 (decoration types, the one Run order, outside digitizing), the branches the other phase 5 tests never reach:
//   functions/api/orders.js — a new version and "Copy settings from the other version" carry the product's decoration type;
//     Global settings → Save refusing a decoration section that isn't an object; a graphic saved with a type but no kind
//     (the stored kind decides); the catalog version bump failing after a decoration save (the save still stands);
//     Start / Mark made when the database fails with no message (a plain sentence instead); a vendor over 120 characters;
//     changing a quote's digitizing record; a database failure on save / delete passing through, not shown as a refusal
//   functions/api/catalog.js — a product's decoration with nothing in it; an old cached answer with no business, on every
//     kind of answer (admin, unrecognized host, closed, no such shop at the main address and on a shop's own address)
// Real SQL (sql.js) under the real db.js, orders.js and catalog.js. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
global.fetch = async (url) => { throw new Error("unexpected fetch " + url); };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { createProduct, createGraphic, createTransfer, insertOrder, getGraphic };")();

// A database that fails on request: while `fail` is set, a statement whose SQL matches `fail.sql` throws `fail.error`
// (from its `nth` match on, counted from the moment it is set). Everything else is the real database.
function faulty(real) {
  const state = { fail: null, seen: 0 };
  const proxy = new Proxy(real, { get(t, k) {
    if (k === "prepare") return (sql) => {
      const f = state.fail;
      if (f && f.sql.test(sql) && ++state.seen >= (f.nth || 1)) throw f.error;
      return t.prepare(sql);
    };
    const v = t[k];
    return typeof v === "function" ? v.bind(t) : v;
  } });
  return { proxy, set: (sql, error, nth) => { state.fail = { sql, error, nth }; state.seen = 0; }, clear: () => { state.fail = null; } };
}

(async () => {
  const A = await makeAuth();
  const d1 = A.d1;
  const q = (sql, ...p) => d1.q(sql, ...p);
  const admin = await A.firstAdmin("Olive Owner", "olive@example.com");
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t');`);
  const F = faulty(d1);
  const call = (body, cookie = admin) => A.orders(body, cookie);
  const auditRows = (action) => q("SELECT * FROM audit_log ORDER BY id").filter(r => r.action === action);
  const withFault = async (sql, error, body, nth) => { A.env.DB = F.proxy; F.set(sql, error, nth); try { return await call(body); } finally { F.clear(); A.env.DB = d1; } };
  const decorationOf = (id) => q("SELECT decorationType t FROM products WHERE orgId='club' AND productId=?", id)[0].t;

  console.log("=== A new version, and copying settings between versions, keep the decoration type ===");
  await lib.createProduct(d1, "club", { productId: "vtee", type: "shirt", name: "Vinyl Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, decorationType: "vinyl" });
  ok("the product is stored as a vinyl product", decorationOf("vtee") === "vinyl");
  let r = await call({ action: "createProductVersion", org: "club", productId: "vtee", newProductId: "vtee-ls" });
  ok("a new version is made", r.status === 200 && r.body.status === "ok" && r.body.productId === "vtee-ls");
  ok("…and starts with the same decoration type as the product it was copied from", decorationOf("vtee-ls") === "vinyl");
  q("UPDATE products SET decorationType='dtg' WHERE orgId='club' AND productId='vtee-ls'");
  ok("(the second version is given another type)", decorationOf("vtee-ls") === "dtg");
  r = await call({ action: "copyProductVersionSettings", org: "club", productId: "vtee-ls", fromProductId: "vtee" });
  ok("copying the other version's settings succeeds", r.status === 200 && r.body.status === "ok");
  ok("…and the decoration type is the other version's again", decorationOf("vtee-ls") === "vinyl" && decorationOf("vtee") === "vinyl");

  console.log("\n=== Global settings → Save: a decoration section that isn't an object ===");
  const before = JSON.stringify(q("SELECT * FROM global_settings WHERE key LIKE 'decoration%' ORDER BY key"));
  for (const [what, v] of [["a sentence", "dtf"], ["a list", ["dtf"]], ["a number", 7]]) {
    r = await call({ action: "saveGlobalSettingsAll", settings: { decoration: v } });
    ok("a decoration section that is " + what + " is refused (400) with the section's own sentence", r.status === 400 && r.body.status === "error" &&
      r.body.message === "That isn't a valid Decoration types section." && /ecoration/.test(r.body.section));
  }
  ok("…and nothing was saved", JSON.stringify(q("SELECT * FROM global_settings WHERE key LIKE 'decoration%' ORDER BY key")) === before);

  console.log("\n=== A graphic saved with a decoration type but no kind: the stored kind decides ===");
  const sheet = await lib.createTransfer(d1, { name: "Example Sheet" });
  d1._raw.exec(`INSERT INTO designs (orgId, name, createdAt, updatedAt) VALUES ('club', 'Club Crest', 't', 't');`);
  const designId = q("SELECT id FROM designs WHERE orgId='club'")[0].id;
  const gTr = await lib.createGraphic(d1, "club", { name: "Print Mark", kind: "transfer", transferId: sheet, tier: "small", inkColors: ["White"] });
  const mkEmb = (name) => lib.createGraphic(d1, "club", { name, kind: "embroidery", designId });
  const gEmb1 = await mkEmb("Stitch Mark 1"), gEmb2 = await mkEmb("Stitch Mark 2");
  const save = (g) => call({ action: "saveGraphic", org: "club", graphic: g });
  const typeOf = async (id) => (await lib.getGraphic(d1, id)).decoration;
  await call({ action: "updateDecorationSettings", types: ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"] });
  r = await save({ id: gTr, name: "Print Mark", decoration: "vinyl" });
  ok("a printed graphic given a type (no kind sent) is saved with it", r.status === 200 && await typeOf(gTr) === "vinyl");
  r = await save({ id: gEmb1, name: "Stitch Mark 1", decoration: "embroidery" });
  ok("'embroidery' on an embroidered graphic (no kind sent) is accepted: its stored kind is embroidery", r.status === 200 && r.body.status === "ok");
  r = await save({ id: gEmb2, name: "Stitch Mark 2", decoration: "vinyl" });
  ok("a printed type on an embroidered graphic (no kind sent) is not refused, it is just not kept as a printed type", r.status === 200 && r.body.status === "ok");
  r = await save({ id: gTr, name: "Print Mark", decoration: "embroidery" });
  ok("'embroidery' on a printed graphic (no kind sent) is refused (400, Unknown decoration type) and keeps its type", r.status === 400 && r.body.message === "Unknown decoration type" && await typeOf(gTr) === "vinyl");
  r = await save({ name: "Brand new mark", decoration: "embroidery" });
  ok("'embroidery' on a new graphic with no kind is refused too (it is not an embroidered graphic)", r.status === 400 && r.body.message === "Unknown decoration type");

  console.log("\n=== Saving decoration types when the catalog version bump fails ===");
  const logged = [];
  const realError = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(" ")); };
  try {
    // The first catalog version statement is the save's own; the second is the bump after it.
    r = await withFault(/INSERT INTO global_settings \(key, value\) VALUES \('catalogVersion'/, new Error("bump failed"), { action: "updateDecorationSettings", types: ["embroidery", "vinyl"] }, 2);
  } finally { console.error = realError; }
  ok("the answer is still ok, with the types", r.status === 200 && r.body.status === "ok" && same(r.body.types, ["embroidery", "vinyl"]));
  ok("…the types were saved", same(JSON.parse(q("SELECT value FROM global_settings WHERE key='decorationTypes'")[0].value), ["embroidery", "vinyl"]));
  ok("…the failure was reported in the log, not to the person", logged.some(l => /catalog version bump failed/.test(l) && /bump failed/.test(l)));
  await call({ action: "updateDecorationSettings", types: ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"] });

  console.log("\n=== Start and Mark made when the database fails with no message ===");
  await lib.createProduct(d1, "club", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, noBlankNeeded: true });
  await lib.insertOrder(d1, { orderId: "O-1", orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-03-01T12:00:00.000Z" },
    [{ productId: "tee", name: "Tee", type: "shirt", size: "L", qty: 2, unitPrice: 20, config: { garmentColor: "Navy", locations: [{ location: "front", label: "Front", kind: "transfer", decoration: "screenprint", graphicName: "Crest", ink: "Red" }] } }]);
  const itemId = Number(q("SELECT id FROM order_items WHERE orderId='O-1'")[0].id);
  r = await withFault(/UPDATE order_items SET decStartedAt/, new Error(""), { action: "setDecorationStarted", orderId: "O-1", itemId });
  ok("Start says it could not update the line (400), not an empty message", r.status === 400 && r.body.status === "error" && r.body.message === "Could not update the line");
  ok("…nothing was stamped and no audit row was written", q("SELECT decStartedAt s FROM order_items WHERE id=?", itemId)[0].s === null && auditRows("order.decoration_started").length === 0);
  r = await withFault(/UPDATE order_items/, new Error(""), { action: "makeDecoratedLine", orderId: "O-1", itemId });
  ok("Mark made says it could not mark made (400), not an empty message", r.status === 400 && r.body.status === "error" && r.body.message === "Could not mark made");
  ok("…and no audit row was written", auditRows("order.decoration_made").length === 0);
  r = await withFault(/UPDATE order_items SET decStartedAt/, new Error("The database is busy"), { action: "setDecorationStarted", orderId: "O-1", itemId });
  ok("a failure that has words shows them (400)", r.status === 400 && r.body.message === "The database is busy");

  console.log("\n=== Outside digitizing: a long vendor, a quote's record changed, a database failing ===");
  d1._raw.exec(`INSERT INTO vendors (name, forDigitizing, createdAt, updatedAt) VALUES ('Example Digitizing Co', 1, 't', 't');`);
  const job = { name: "Club logo", vendor: "Example Digitizing Co", sentAt: "2026-03-02" };
  // The vendor form stops a name this long, so one on the list this long came from elsewhere (an old import).
  const longVendor = "v".repeat(121);
  d1._raw.exec(`INSERT INTO vendors (name, forDigitizing, createdAt, updatedAt) VALUES ('${longVendor}', 1, 't', 't');`);
  r = await call({ action: "saveDigitizingJob", job: Object.assign({}, job, { orderId: "O-1", vendor: longVendor }) });
  ok("a vendor of 121 characters (on the list) is refused (400) with its sentence", r.status === 400 && r.body.message === "The vendor is up to 120 characters");
  ok("…and nothing was saved", q("SELECT * FROM digitizing_jobs").length === 0);
  r = await call({ action: "saveDigitizingJob", job: Object.assign({}, job, { estimateId: 4 }) });
  const quoteJob = r.body.id;
  ok("a record for a quote is saved and the quote's list comes back", r.status === 200 && Number.isInteger(quoteJob) && r.body.jobs.length === 1 && r.body.jobs[0].estimateId === 4);
  ok("…audited as sent, with the quote", auditRows("digitizing.sent").length === 1 && JSON.parse(auditRows("digitizing.sent")[0].detail).estimateId === 4);
  r = await call({ action: "saveDigitizingJob", job: Object.assign({}, job, { id: quoteJob, estimateId: 4, returnedAt: "2026-03-05", note: "Back" }) });
  ok("changing it (by its quote, no order) answers the quote's list with the change", r.status === 200 && r.body.id === quoteJob && r.body.jobs.length === 1 && r.body.jobs[0].returnedAt === "2026-03-05");
  ok("…and is audited as changed, not sent again", auditRows("digitizing.updated").length === 1 && auditRows("digitizing.sent").length === 1 &&
    JSON.parse(auditRows("digitizing.updated")[0].detail).estimateId === 4);
  r = await withFault(/INSERT INTO digitizing_jobs/, new Error("disk is full"), { action: "saveDigitizingJob", job: Object.assign({}, job, { orderId: "O-1" }) });
  ok("a database failure on save is not shown as a refusal of the form (it is thrown on)", r.status === 0 && /disk is full/.test(r.body.threw));
  ok("…and nothing was recorded or audited for it", q("SELECT * FROM digitizing_jobs").length === 1 && auditRows("digitizing.sent").length === 1);
  r = await withFault(/UPDATE digitizing_jobs SET deletedAt/, new Error("disk is full"), { action: "deleteDigitizingJob", id: quoteJob });
  ok("a database failure on delete is thrown on too, not a 409", r.status === 0 && /disk is full/.test(r.body.threw));
  ok("…and the record is still there, with no audit row", q("SELECT * FROM digitizing_jobs WHERE deletedAt IS NULL").length === 1 && auditRows("digitizing.deleted").length === 0);
  r = await call({ action: "deleteDigitizingJob", id: quoteJob });
  ok("(without the failure it deletes)", r.status === 200 && q("SELECT * FROM digitizing_jobs WHERE deletedAt IS NULL").length === 0);

  await catalogPart();
  console.log("\nDone");
})();

async function catalogPart() {
  console.log("\n=== The shop page's catalog (catalog.js) ===");
  // getCatalogData, with switches for an old cached answer with no business, and a shop address with nothing behind it.
  const cacheSrc = strip(read("functions/_lib/catalogCache.js")).replace("async function getCatalogData(", "async function getCatalogDataReal_(") +
    "\nasync function getCatalogData(env, o){ const d = await getCatalogDataReal_(env, o); const c = { ...d };" +
    " if(globalThis.__noBusiness) delete c.business; if(globalThis.__ghost) c.subdomainMap = { ...c.subdomainMap, ghost: 'ghost' }; return c; }\n";
  const L = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
    cacheSrc + "\n" + strip(read("functions/api/catalog.js")) +
    "\nreturn { catalogGet: onRequestGet, setFeatures, _resetCatalogCacheState, toClientProduct };")();
  let store;
  const freshCache = () => {
    store = new Map();
    global.caches = { default: {
      async match(key) { const hit = store.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
      async put(key, response) { store.set(typeof key === "string" ? key : key.url, response); },
    } };
    L._resetCatalogCacheState();
  };
  freshCache();
  const d1 = await createD1();
  d1._raw.exec(read("schema.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);`);
  const get = async (origin) => {
    const res = await L.catalogGet({ request: { url: origin + "/api/catalog", headers: { get: () => null } }, env: { DB: d1 } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  const dec = L.toClientProduct({ productId: "p", name: "P", images: [], pricingMode: "flat", flatPrice: 5, decorations: [{}, { kind: "transfer", name: "Crest", location: "Front", type: "vinyl" }] });
  ok("a decoration with nothing in it is listed with empty words, and no type", same(dec.decorations[0], { kind: "", name: "", location: "" }));
  ok("…a full one keeps its words and its type", same(dec.decorations[1], { kind: "transfer", name: "Crest", location: "Front", type: "vinyl" }));

  const sane = await get(ADMIN_ORIGIN);
  ok("the admin address's answer carries the business as saved", sane.body.status === "admin" && !!sane.body.business && typeof sane.body.business === "object");
  globalThis.__noBusiness = true;
  try {
    let a = await get(ADMIN_ORIGIN);
    ok("with no business in the cached answer the admin address still answers, with an empty business", a.status === 200 && a.body.status === "admin" && same(a.body.business, {}));
    a = await get("https://nobody." + ROOT);
    ok("…an unrecognized address answers 404 with an empty business", a.status === 404 && a.body.message === "Unrecognized host" && same(a.body.business, {}));
    a = await get("https://" + ROOT);
    ok("…the main address (no shop) answers Unknown org with an empty business", a.status === 200 && a.body.message === "Unknown org" && same(a.body.business, {}));
    globalThis.__ghost = true;
    freshCache();
    a = await get(shopOrigin("ghost"));
    ok("…a shop address with no shop behind it answers 404 Unknown org with an empty business", a.status === 404 && a.body.message === "Unknown org" && same(a.body.business, {}));
    globalThis.__ghost = false;
    await L.setFeatures(d1, { storefront: false });
    freshCache();
    a = await get(shopOrigin("club"));
    ok("…a switched-off storefront answers closed with an empty business", a.status === 200 && a.body.status === "closed" && same(a.body.business, {}));
  } finally { globalThis.__noBusiness = false; globalThis.__ghost = false; }
}
