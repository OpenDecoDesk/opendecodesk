const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");
const roles = require("./testlib/roles");

// Decoration types on products and graphics (migrations/0118, phase 5). What this file pins:
//   productDecoration_            the type a product is made with: its own choice, else a design, else "no design
//                                 needed", fixed transfers, a digital product — every branch
//   products                      parseProduct_ / createProduct / updateProduct: decorationType stored, kept when left out,
//                                 cleared with '', an unknown key stored as ''; `decoration` worked out again once the
//                                 product's designs are read
//   the admin product actions     createProduct / updateProduct and the new-product wizard (buildProductFromBlank): every
//                                 decoration answer, a switched-off type refused with the exact message for a new choice
//                                 but kept on a record that already has it, who may
//   graphics                      create / update / parse with `decoration`: DTF stored as '', kept when left out, refused
//                                 when switched off, an embroidery graphic's ignored, the pre-0118 database
//   order-line snapshots          priceConfigurable_ / priceItem: the decoration of a graphic pick, a fixed transfer, the
//                                 reorder QR and a customer's own design of each kind; locationDecoration_ on old snapshots;
//                                 lineDecorations_; the "Update from catalog" text when a graphic's printed type changed
//   analyzePricing                the decoration cost per printed type
//   the shop page                 attachDecorations_ labels, switched-off types left out; published snapshots carrying
//                                 decorationType
// Real SQL (sql.js) and the real source files, glued as CONTRIBUTING.md describes. Invented names only; no date here depends
// on today.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { DECORATION_KEYS, productDecoration_, locationDecoration_, lineDecorations_, graphicDecoration,
  getDecorationTypes, setDecorationTypes, setDecorationPricing, createProduct, updateProduct, getProductsByOrg, setProductDesign, setProductDesigns,
  saveDesign, createTransfer, createGraphic, updateGraphic, getGraphic, listGraphics, priceItem, insertOrder, getOrderById,
  refreshOrderLinesFromCatalog, analyzePricing, setOrgReorderQrTransfer, saveLocation, publishShop, getCatalogSnapshot,
  getDraftCatalogShop, getPublicCatalogShop, getPublicCatalogData };`)();
const common = strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/setupStatus.js")) + "\n";
const api = new Function(common +
  roles.adminAs({ roleFrom: "request.headers.get('x-role') || 'admin'" }) + "\n" +
  // The real roles (permissions.js) for the role the request names, as test160 reads them.
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => { const r = (request.headers.get('x-role') || 'admin'); return roleAllows(DEFAULT_ROLES[r] || null, need === 'staff' ? '*' : need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@test';\n" +
  "const copyVendorImage = async () => ({ ok: false });\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

const migrationFiles = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function makeDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrationFiles) if (!before || f < before) d1.execFile(read("migrations/" + f));
  require("./testlib/vendors.js").seedVendors(d1);
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1), ('other','other','Example Boosters','t','t',1);`);
  return d1;
}
const say = (line) => console.log("\n" + line);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const OFF = "That decoration type is switched off in Global settings";

(async () => {
  const d1 = await makeDb();
  const ENV = { DB: d1, SIGNING_SECRET: "a-signing-secret-for-tests-0123456789abcdef" };
  const call = async (body, { role = "admin" } = {}) => {
    const res = await api({ env: ENV, waitUntil: (pr) => Promise.resolve(pr).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const products = async (org = "acme") => lib.getProductsByOrg(d1, org, false);
  const prod = async (id, org = "acme") => (await products(org)).find(p => p.productId === id);
  const col = (id, c = "decorationType", org = "acme") => d1.q(`SELECT ${c} AS v FROM products WHERE orgId=? AND productId=?`, org, id)[0].v;
  // updateProduct takes the whole product; what a caller leaves out is left as it is (the stored type is only sent when asked).
  const upd = async (id, extra = {}, org = "acme") => { const { decorationType, decoration, ...rest } = (await products(org)).find(x => x.productId === id); return lib.updateProduct(d1, org, Object.assign(rest, extra)); };
  const make = (id, extra = {}, org = "acme") => lib.createProduct(d1, org, Object.assign({ productId: id, type: "shirt", name: id, pricingMode: "flat", flatPrice: 20, visible: true }, extra));

  // ------------------------------------------------------------------------------------------------------------
  say("=== productDecoration_: the decoration a product is made with ===");
  const pd = lib.productDecoration_;
  ok("nothing at all has no decoration", pd(null) === "" && pd(undefined) === "");
  for (const k of lib.DECORATION_KEYS) ok("a product's own choice of " + k + " wins over everything it could be worked out from",
    pd({ decorationType: k, designId: 5, digital: true, noDesignNeeded: false, fixedTransfers: [{ graphicId: 1 }] }) === k);
  ok("a choice that is not a known type is ignored and the type is worked out", pd({ decorationType: "laser", noDesignNeeded: true }) === "dtf" && pd({ decorationType: "laser" }) === "embroidery");
  ok("a main design makes it embroidery, even when it is also marked as needing no design", pd({ designId: 5, noDesignNeeded: true }) === "embroidery");
  ok("a main design makes a digital product embroidery too", pd({ designId: 5, digital: true }) === "embroidery");
  ok("a list of designs makes it embroidery", pd({ designs: [{ designId: 9 }], noDesignNeeded: true }) === "embroidery");
  ok("a design count (the product's designs not read yet) makes it embroidery", pd({ designCount: 2, noDesignNeeded: true }) === "embroidery");
  ok("an empty list of designs is not a design, whatever the count says", pd({ designs: [], designCount: 3, noDesignNeeded: true }) === "dtf");
  ok("an ordinary product that needs a design is embroidery", pd({}) === "embroidery" && pd({ noDesignNeeded: false, digital: false, fixedTransfers: [] }) === "embroidery");
  ok("a product that needs no design is DTF", pd({ noDesignNeeded: true }) === "dtf");
  ok("a product with fixed transfers and no design is DTF", pd({ fixedTransfers: [{ graphicId: 1 }] }) === "dtf");
  ok("fixed transfers make a digital product DTF; no design needed does too", pd({ digital: true, fixedTransfers: [{ graphicId: 1 }] }) === "dtf" && pd({ digital: true, noDesignNeeded: true }) === "dtf");
  ok("a digital product with nothing to decorate has none", pd({ digital: true }) === "");
  ok("fixed transfers that are not a list are nothing", pd({ digital: true, fixedTransfers: "x" }) === "");

  // ------------------------------------------------------------------------------------------------------------
  say("=== Products: decorationType stored, kept, cleared and worked out ===");
  await make("tee-vinyl", { decorationType: "vinyl" });
  let p = await prod("tee-vinyl");
  ok("a product made with its own type has it stored, and it is the worked-out type", col("tee-vinyl") === "vinyl" && p.decorationType === "vinyl" && p.decoration === "vinyl");
  await make("tee-plain");
  p = await prod("tee-plain");
  ok("a product made without one stores nothing and works its type out (an ordinary product is embroidery)", col("tee-plain") === "" && p.decorationType === "" && p.decoration === "embroidery");
  await make("tee-bogus", { decorationType: "laser" });
  ok("an unknown key is stored as none", col("tee-bogus") === "");
  await make("tee-dtf", { noDesignNeeded: true });
  ok("a product that needs no design works out to DTF", (await prod("tee-dtf")).decoration === "dtf" && col("tee-dtf") === "");
  await make("tee-digital", { digital: true });
  d1._raw.run("UPDATE products SET noDesignNeeded=0 WHERE productId='tee-digital'");
  ok("a digital product that is not marked as needing no design works out to no decoration", (await prod("tee-digital")).decoration === "");
  const dsg = await lib.saveDesign(d1, "acme", { name: "Example crest" });
  await make("tee-design", { noDesignNeeded: true });
  await lib.setProductDesign(d1, "acme", "tee-design", dsg);
  ok("a product with a design from its list works out to embroidery once its designs are read", (await prod("tee-design")).decoration === "embroidery");
  const dsg2 = await lib.saveDesign(d1, "acme", { name: "Example back mark" });
  await make("tee-two", { noDesignNeeded: true });
  await lib.setProductDesigns(d1, "acme", "tee-two", [{ designId: dsg, placement: "Front" }, { designId: dsg2, placement: "Back" }]);
  ok("…also with several designs", (await prod("tee-two")).decoration === "embroidery");
  d1._raw.run("UPDATE products SET designId=NULL WHERE orgId='acme' AND productId='tee-two'");
  ok("…even when only its list of designs says so (no main design on the product row)", (await prod("tee-two")).decoration === "embroidery");
  await upd("tee-design", { decorationType: "dtg" });
  ok("its own choice beats its design", (await prod("tee-design")).decoration === "dtg");

  await upd("tee-vinyl", { name: "Vinyl tee" });
  ok("an update that does not send decorationType leaves it", col("tee-vinyl") === "vinyl");
  await upd("tee-vinyl", { decorationType: "sublimation" });
  ok("an update changes it", col("tee-vinyl") === "sublimation");
  await upd("tee-vinyl", { decorationType: "laser" });
  ok("an update with an unknown key clears it", col("tee-vinyl") === "");
  await upd("tee-vinyl", { decorationType: "screenprint" });
  await upd("tee-vinyl", { decorationType: "" });
  ok("an update with '' clears it, and the type is worked out again", col("tee-vinyl") === "" && (await prod("tee-vinyl")).decoration === "embroidery");

  // ------------------------------------------------------------------------------------------------------------
  say("=== Admin product actions: a type must be switched on to be chosen ===");
  const create = (id, extra = {}, role) => call(Object.assign({ action: "createProduct", org: "acme", productId: id, type: "shirt", name: id, pricingMode: "flat", flatPrice: 20, visible: true, noBlankNeeded: true }, extra), { role });
  const update = (id, extra = {}, role) => call(Object.assign({ action: "updateProduct", org: "acme", productId: id, type: "shirt", name: id, pricingMode: "flat", flatPrice: 20, visible: true, noBlankNeeded: true }, extra), { role });
  ok("a new install has embroidery and DTF on", same(await lib.getDecorationTypes(d1), ["embroidery", "dtf"]));
  let r = await create("api-dtf", { decorationType: "dtf" });
  ok("a product is created with a switched-on type", r.status === 200 && col("api-dtf") === "dtf");
  r = await create("api-vinyl", { decorationType: "vinyl" });
  ok("a switched-off type is refused for a new product, with the exact message", r.status === 400 && r.body.message === OFF && d1.q("SELECT 1 FROM products WHERE productId='api-vinyl'").length === 0);
  r = await create("api-bad", { decorationType: "laser" });
  ok("a type that does not exist is refused by name", r.status === 400 && r.body.message === "Unknown decoration type: laser");
  r = await create("api-num", { decorationType: 7 });
  ok("a type that is not text is refused", r.status === 400 && r.body.message === "Unknown decoration type");
  r = await create("api-none", { decorationType: "" });
  ok("'' (worked out) is always fine", r.status === 200 && col("api-none") === "");
  r = await create("api-null", { decorationType: null });
  ok("null is read as ''", r.status === 200 && col("api-null") === "");
  r = await create("api-left-out");
  ok("a type left out is fine and stores none", r.status === 200 && col("api-left-out") === "");
  r = await create("api-staff", { decorationType: "embroidery" }, "staff");
  ok("Back office may create a product with a type", r.status === 200 && col("api-staff") === "embroidery");
  r = await create("api-prod", { decorationType: "dtf" }, "production");
  ok("Production may not create products at all", r.status === 403 && d1.q("SELECT 1 FROM products WHERE productId='api-prod'").length === 0);

  r = await update("api-dtf", { decorationType: "vinyl" });
  ok("changing a product to a switched-off type is refused, and it keeps what it had", r.status === 400 && r.body.message === OFF && col("api-dtf") === "dtf");
  r = await update("api-dtf", { decorationType: "laser" });
  ok("an update with an unknown type is refused by name", r.status === 400 && r.body.message === "Unknown decoration type: laser");
  r = await update("api-dtf", { decorationType: ["dtf"] });
  ok("an update with a type that is not text is refused", r.status === 400 && r.body.message === "Unknown decoration type");
  r = await update("api-dtf", { decorationType: "embroidery" });
  ok("changing to another switched-on type works, and is audited as a product change", r.status === 200 && col("api-dtf") === "embroidery" &&
    d1.q("SELECT detail FROM audit_log WHERE action='product.updated' ORDER BY id DESC LIMIT 1")[0].detail.includes("decorationType"));
  r = await update("api-dtf", {});
  ok("an update that leaves it out keeps it", r.status === 200 && col("api-dtf") === "embroidery");
  r = await update("api-dtf", { decorationType: null });
  ok("null on an update clears it", r.status === 200 && col("api-dtf") === "");

  // A record that already has a type keeps it once the type is switched off; only choosing it anew is refused.
  await lib.setDecorationTypes(d1, ["embroidery", "dtf", "vinyl", "dtg"]);
  r = await create("api-vinyl", { decorationType: "vinyl" });
  ok("once vinyl is switched on it can be chosen", r.status === 200 && col("api-vinyl") === "vinyl");
  await call({ action: "updateProduct", org: "acme", productId: "api-vinyl", type: "shirt", name: "api-vinyl", pricingMode: "flat", flatPrice: 20, visible: true, noBlankNeeded: true, decorationType: "dtg" });
  await lib.setDecorationTypes(d1, ["embroidery", "dtf"]);
  ok("switching a type off does not touch the records that have it", col("api-vinyl") === "dtg" && (await prod("api-vinyl")).decoration === "dtg");
  r = await update("api-vinyl", { decorationType: "dtg", name: "Renamed tee" });
  ok("a product already on a switched-off type keeps it when saved again", r.status === 200 && col("api-vinyl") === "dtg" && col("api-vinyl", "name") === "Renamed tee");
  r = await update("api-vinyl", { decorationType: "vinyl" });
  ok("…but is refused another switched-off type", r.status === 400 && r.body.message === OFF && col("api-vinyl") === "dtg");
  r = await update("api-vinyl", { decorationType: "" });
  ok("…and can always go back to worked out", r.status === 200 && col("api-vinyl") === "");
  r = await update("api-vinyl", { decorationType: "dtg" });
  ok("…after which the switched-off type is a new choice and refused", r.status === 400 && r.body.message === OFF);
  const typesAfter = await lib.getDecorationTypes(d1);
  ok("none of this changed which types are on", same(typesAfter, ["embroidery", "dtf"]));

  // ------------------------------------------------------------------------------------------------------------
  say("=== The new-product wizard: each decoration answer ===");
  r = await call({ action: "createBlank", name: "Sample Tee", brand: "Sample Co", sku: "ST1", vendor: "Supplier", productType: "shirt",
    colors: [{ color: "Navy", images: [], sizes: ["S", "M"].map(s => ({ size: s, quantity: 0, purchasePrice: 5, vendorPrice: 5 })) }] });
  const blankId = r.body.id;
  const build = (extra = {}, role) => call(Object.assign({ action: "buildProductFromBlank", org: "acme", blankId, colors: ["Navy"], sizes: ["S", "M"], name: "Wiz Tee", pricingMode: "flat", flatPrice: 18 }, extra), { role });
  const stored = (id) => d1.q("SELECT noDesignNeeded n, decorationType t FROM products WHERE orgId='acme' AND productId=?", id)[0];
  await lib.setDecorationTypes(d1, ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"]);
  const expected = { embroidery: [0, "", "embroidery"], dtf: [1, "", "dtf"], both: [0, "", "embroidery"], screenprint: [1, "screenprint", "screenprint"],
    vinyl: [1, "vinyl", "vinyl"], dtg: [1, "dtg", "dtg"], sublimation: [1, "sublimation", "sublimation"] };
  const made = {};
  for (const [answer, [need, type, worked]] of Object.entries(expected)) {
    r = await build({ decoration: answer, name: "Wiz " + answer });
    made[answer] = r.body.productId;
    const s = r.status === 200 ? stored(r.body.productId) : {};
    ok("the wizard's answer '" + answer + "' saves noDesignNeeded " + (need ? "on" : "off") + " and " + (type ? "type " + type : "no type of its own"),
      r.status === 200 && s.n === need && s.t === type && (await prod(r.body.productId)).decoration === worked);
  }
  r = await build({ decoration: "laser", name: "Wiz laser" });
  ok("an answer that is nothing known is embroidery, as before", r.status === 200 && stored(r.body.productId).n === 0 && stored(r.body.productId).t === "");
  r = await build({ name: "Wiz nothing" });
  ok("no answer is embroidery", r.status === 200 && stored(r.body.productId).n === 0 && stored(r.body.productId).t === "");
  r = await build({ decoration: "vinyl", name: "Wiz staff" }, "staff");
  ok("Back office cannot build a product", r.status === 403);

  await lib.setDecorationTypes(d1, ["embroidery", "dtf", "screenprint"]);
  for (const k of ["vinyl", "dtg", "sublimation"]) {
    r = await build({ decoration: k, name: "Off " + k });
    ok("a switched-off " + k + " answer is refused with the exact message and builds nothing", r.status === 400 && r.body.message === OFF && d1.q("SELECT 1 FROM products WHERE name=?", "Off " + k).length === 0);
  }
  r = await build({ decoration: "screenprint", name: "Wiz on" });
  ok("a switched-on new type is accepted", r.status === 200 && stored(r.body.productId).t === "screenprint");
  await lib.setDecorationTypes(d1, ["embroidery", "screenprint"]);
  r = await build({ decoration: "both", name: "Off both" });
  ok("'both' is refused when DTF is off", r.status === 400 && r.body.message === OFF);
  r = await build({ decoration: "dtf", name: "Off dtf" });
  ok("a switched-off DTF answer is refused", r.status === 400 && r.body.message === OFF);
  await lib.setDecorationTypes(d1, ["dtf", "screenprint"]);
  r = await build({ decoration: "both", name: "Off both 2" });
  ok("'both' is refused when embroidery is off", r.status === 400 && r.body.message === OFF);
  r = await build({ decoration: "embroidery", name: "Off emb" });
  ok("a switched-off embroidery answer is refused", r.status === 400 && r.body.message === OFF);
  await lib.setDecorationTypes(d1, ["embroidery", "dtf"]);
  r = await build({ decoration: "both", name: "Both on" });
  ok("'both' is fine when embroidery and DTF are on", r.status === 200);
  r = await build({ decoration: "laser", name: "Unknown ok" });
  ok("an unknown answer is never a refusal (it is embroidery)", r.status === 200);

  // Rebuilding a product that already has a type that is now switched off.
  const vinylId = made.vinyl;
  r = await build({ productId: vinylId, decoration: "vinyl" });
  ok("rebuilding a product on a switched-off type with the same answer keeps it", r.status === 200 && stored(vinylId).t === "vinyl" && stored(vinylId).n === 1);
  r = await build({ productId: vinylId, decoration: "dtg" });
  ok("…another switched-off type is refused", r.status === 400 && r.body.message === OFF && stored(vinylId).t === "vinyl");
  r = await build({ productId: vinylId, decoration: "dtf" });
  ok("…a switched-on one replaces it (no type of its own, no design needed)", r.status === 200 && stored(vinylId).t === "" && stored(vinylId).n === 1 && (await prod(vinylId)).decoration === "dtf");
  r = await build({ productId: vinylId, decoration: "vinyl" });
  ok("…after which vinyl is a new choice and refused", r.status === 400 && r.body.message === OFF);

  // ------------------------------------------------------------------------------------------------------------
  say("=== Graphics: decoration saved, kept and refused ===");
  const sheet = await lib.createTransfer(d1, { name: "Example sheet" });
  const sg = (g, role) => call({ action: "saveGraphic", org: "acme", graphic: Object.assign({ name: "Example mark", kind: "transfer", transferId: sheet, visible: true }, g) }, { role });
  const gcol = (id) => d1.q("SELECT decoration d, kind FROM graphics WHERE id=?", id)[0];
  const listed = async (id) => (await lib.listGraphics(d1, "acme")).find(g => g.id === id);
  await lib.setDecorationTypes(d1, ["embroidery", "dtf", "screenprint", "vinyl"]);
  r = await sg({ decoration: "screenprint" });
  const gScreen = r.body.id;
  ok("a printed graphic saves its type", r.status === 200 && gcol(gScreen).d === "screenprint" && (await listed(gScreen)).decoration === "screenprint");
  r = await sg({ name: "Example DTF mark", decoration: "dtf" });
  const gDtf = r.body.id;
  ok("'dtf' is stored as '' and read back as dtf", r.status === 200 && gcol(gDtf).d === "" && (await listed(gDtf)).decoration === "dtf");
  r = await sg({ name: "Example plain mark" });
  const gPlain = r.body.id;
  ok("a graphic saved without a type is '' and reads as dtf", r.status === 200 && gcol(gPlain).d === "" && (await listed(gPlain)).decoration === "dtf");
  r = await sg({ name: "Example null mark", decoration: null });
  ok("null is read as DTF", r.status === 200 && gcol(r.body.id).d === "");
  r = await sg({ name: "Example stitched", kind: "embroidery", transferId: null, decoration: "vinyl" });
  const gEmb = r.body.id;
  ok("an embroidery graphic's type is ignored: stored '' and read as embroidery", r.status === 200 && gcol(gEmb).d === "" && (await listed(gEmb)).decoration === "embroidery");
  r = await sg({ name: "Example stitched 2", kind: "embroidery", transferId: null, decoration: "embroidery" });
  ok("'embroidery' on an embroidery graphic is fine", r.status === 200 && gcol(r.body.id).d === "");
  r = await sg({ name: "Wrong embroidery", decoration: "embroidery" });
  ok("'embroidery' on a printed graphic is refused", r.status === 400 && r.body.message === "Unknown decoration type" && d1.q("SELECT 1 FROM graphics WHERE name='Wrong embroidery'").length === 0);
  r = await sg({ name: "Not text", decoration: 5 });
  ok("a type that is not text is refused", r.status === 400 && r.body.message === "Unknown decoration type");
  r = await sg({ name: "Unknown", decoration: "laser" });
  ok("an unknown type is refused by name", r.status === 400 && r.body.message === "Unknown decoration type: laser");
  r = await sg({ name: "Off one", decoration: "dtg" });
  ok("a switched-off type is refused with the exact message", r.status === 400 && r.body.message === OFF && d1.q("SELECT 1 FROM graphics WHERE name='Off one'").length === 0);
  r = await sg({ name: "Staff one", decoration: "vinyl" }, "staff");
  ok("Back office may save a graphic with a type", r.status === 200 && gcol(r.body.id).d === "vinyl");
  r = await sg({ name: "Production one", decoration: "vinyl" }, "production");
  ok("Production may not save graphics", r.status === 403);

  r = await sg({ id: gScreen, name: "Renamed mark" });
  ok("an update that leaves the type out keeps it", r.status === 200 && gcol(gScreen).d === "screenprint" && (await listed(gScreen)).name === "Renamed mark");
  r = await sg({ id: gScreen, decoration: "vinyl" });
  ok("an update changes it", r.status === 200 && gcol(gScreen).d === "vinyl");
  r = await sg({ id: gScreen, decoration: "dtf" });
  ok("an update to DTF stores ''", r.status === 200 && gcol(gScreen).d === "");
  r = await sg({ id: gScreen, decoration: "screenprint" });
  r = await sg({ id: gScreen, decoration: null });
  ok("an update with null clears it", r.status === 200 && gcol(gScreen).d === "");
  await sg({ id: gScreen, decoration: "vinyl" });
  await lib.setDecorationTypes(d1, ["embroidery", "dtf", "screenprint"]);
  r = await sg({ id: gScreen, decoration: "vinyl", name: "Still vinyl" });
  ok("a graphic already on a switched-off type keeps it when saved again", r.status === 200 && gcol(gScreen).d === "vinyl");
  r = await sg({ id: gScreen, decoration: "dtg" });
  ok("…but is refused another switched-off type", r.status === 400 && r.body.message === OFF && gcol(gScreen).d === "vinyl");
  r = await sg({ id: gScreen, name: "Left out" });
  ok("…and is untouched when the type is left out", r.status === 200 && gcol(gScreen).d === "vinyl");
  r = await sg({ id: gScreen, decoration: "dtf" });
  r = await sg({ id: gScreen, decoration: "vinyl" });
  ok("…after it has changed away, the old switched-off type is a new choice and refused", r.status === 400 && r.body.message === OFF);
  await lib.setDecorationTypes(d1, ["embroidery", "dtf", "screenprint", "vinyl"]);
  r = await sg({ id: gEmb, decoration: "screenprint", kind: "transfer", transferId: sheet });
  ok("an embroidery graphic made into a printed one can take a type in the same save", r.status === 200 && gcol(gEmb).d === "screenprint" && gcol(gEmb).kind === "transfer");
  r = await sg({ id: gEmb, kind: "embroidery", transferId: null });
  ok("a printed graphic made into an embroidery one has its type cleared", r.status === 200 && gcol(gEmb).d === "" && (await listed(gEmb)).decoration === "embroidery");
  r = await sg({ id: gEmb, kind: "embroidery", transferId: null, decoration: "embroidery" });
  ok("an embroidery graphic updated with 'embroidery' stays embroidery", r.status === 200 && (await listed(gEmb)).decoration === "embroidery");
  await sg({ id: gEmb, kind: "transfer", transferId: sheet, decoration: "vinyl" });
  r = await sg({ id: gEmb, kind: "embroidery", transferId: null, decoration: "screenprint" });
  ok("an update that turns it into embroidery ignores a type sent with it", r.status === 200 && gcol(gEmb).d === "");

  // The lib calls the form's save ends in.
  const gl = await lib.createGraphic(d1, "acme", { name: "Lib vinyl", kind: "transfer", transferId: sheet, decoration: "vinyl" });
  ok("createGraphic stores a printed type", gcol(gl).d === "vinyl" && (await lib.getGraphic(d1, gl)).decoration === "vinyl");
  const gl2 = await lib.createGraphic(d1, "acme", { name: "Lib dtf", kind: "transfer", transferId: sheet, decoration: "dtf" });
  ok("createGraphic stores DTF as ''", gcol(gl2).d === "" && (await lib.getGraphic(d1, gl2)).decoration === "dtf");
  const gl3 = await lib.createGraphic(d1, "acme", { name: "Lib stitched", kind: "embroidery", decoration: "vinyl" });
  ok("createGraphic ignores a type on an embroidery graphic", gcol(gl3).d === "" && (await lib.getGraphic(d1, gl3)).decoration === "embroidery");
  const gl4 = await lib.createGraphic(d1, "acme", { name: "Lib unknown", kind: "transfer", transferId: sheet, decoration: "laser" });
  ok("createGraphic stores an unknown type as ''", gcol(gl4).d === "");
  await lib.updateGraphic(d1, gl, Object.assign(await lib.getGraphic(d1, gl), { name: "Lib vinyl 2" }));
  ok("updateGraphic from a read graphic keeps its type", gcol(gl).d === "vinyl");
  await lib.updateGraphic(d1, gl, { name: "Lib vinyl 3", kind: "transfer", transferId: sheet });
  ok("updateGraphic from a caller that does not know the type leaves it", gcol(gl).d === "vinyl");
  await lib.updateGraphic(d1, gl, { name: "Lib vinyl 4", kind: "transfer", transferId: sheet, decoration: "sublimation" });
  ok("updateGraphic with a type changes it", gcol(gl).d === "sublimation");
  const gAll = await lib.listGraphics(d1, "acme");
  ok("every graphic lists a type that is a key", gAll.length > 5 && gAll.every(g => lib.DECORATION_KEYS.includes(g.decoration) && (g.kind === "embroidery") === (g.decoration === "embroidery")));
  ok("graphicDecoration says what prints a graphic", lib.graphicDecoration({ kind: "embroidery", decoration: "vinyl" }) === "embroidery" && lib.graphicDecoration({ kind: "transfer", decoration: "dtg" }) === "dtg" &&
    lib.graphicDecoration({ kind: "transfer", decoration: "" }) === "dtf" && lib.graphicDecoration({ kind: "transfer", decoration: "embroidery" }) === "dtf" && lib.graphicDecoration(null) === "dtf");

  // ------------------------------------------------------------------------------------------------------------
  say("=== A database from before 0118 ===");
  const old = await makeDb("0118");
  ok("that database has no decoration columns", !old.q("PRAGMA table_info(products)").some(c => c.name === "decorationType") && !old.q("PRAGMA table_info(graphics)").some(c => c.name === "decoration"));
  const oldSheet = await lib.createTransfer(old, { name: "Example sheet" });
  let threw = "";
  try {
    await lib.createProduct(old, "acme", { productId: "o1", type: "shirt", name: "Old tee", pricingMode: "flat", flatPrice: 20, visible: true, decorationType: "vinyl" });
    const { decorationType, decoration, ...whole } = (await lib.getProductsByOrg(old, "acme", false))[0];
    await lib.updateProduct(old, "acme", Object.assign(whole, { decorationType: "dtg" }));
  } catch (e) { threw = String(e && e.message || e); }
  ok("a product is created and updated with a type and nothing fails", threw === "");
  const op = (await lib.getProductsByOrg(old, "acme", false))[0];
  ok("it reads back with no type of its own and a worked-out one", op.productId === "o1" && op.decorationType === "" && op.decoration === "embroidery");
  threw = "";
  let og = 0;
  try {
    og = await lib.createGraphic(old, "acme", { name: "Old mark", kind: "transfer", transferId: oldSheet, decoration: "vinyl" });
    await lib.updateGraphic(old, og, { name: "Old mark 2", kind: "transfer", transferId: oldSheet, decoration: "dtg" });
  } catch (e) { threw = String(e && e.message || e); }
  ok("a graphic is created and updated with a type and nothing fails", threw === "" && og > 0);
  ok("it reads as DTF and an embroidery one as embroidery", (await lib.getGraphic(old, og)).decoration === "dtf" &&
    (await lib.getGraphic(old, await lib.createGraphic(old, "acme", { name: "Old stitched", kind: "embroidery" }))).decoration === "embroidery");
  await lib.createProduct(old, "acme", { productId: "oc", type: "shirt", name: "Old cfg", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, configurable: true, garmentColors: ["Navy"], reorderQr: "none",
    locations: [{ key: "front", label: "Front", graphicIds: [og] }] });
  const oldPriced = await lib.priceItem(old, "acme", "oc", "OSFA", 1, false, { garmentColor: "Navy", locations: { front: { graphicId: og } } });
  ok("a line priced there still carries a decoration (DTF)", oldPriced.config.locations[0].decoration === "dtf");
  const oa = (await lib.analyzePricing(old, { orgId: "acme" })).products;
  ok("the pricing analysis there works and costs no decoration", oa.length === 2 && oa.every(x => x.decorationCost === 0));

  // ------------------------------------------------------------------------------------------------------------
  say("=== Order-line snapshots: the decoration of each kind of location ===");
  await lib.setDecorationTypes(d1, ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"]);
  const tr = (name, decoration) => lib.createGraphic(d1, "acme", { name, kind: "transfer", transferId: sheet, decoration });
  const G = { emb: await lib.createGraphic(d1, "acme", { name: "Snap stitched", kind: "embroidery", designId: dsg }), dtf: await tr("Snap DTF"), screenprint: await tr("Snap screen", "screenprint"),
    vinyl: await tr("Snap vinyl", "vinyl"), dtg: await tr("Snap DTG", "dtg"), sublimation: await tr("Snap sub", "sublimation") };
  const cfgProduct = (id, extra = {}) => make(id, Object.assign({ noDesignNeeded: true, configurable: true, garmentColors: ["Navy"], reorderQr: "none",
    locations: [{ key: "front", label: "Front", graphicIds: Object.values(G) }, { key: "back", label: "Back", graphicIds: Object.values(G) }] }, extra));
  await cfgProduct("snap");
  const snap = async (pid, cfg, opts) => (await lib.priceItem(d1, "acme", pid, "OSFA", 1, false, cfg, opts)).config;
  for (const [k, gid] of Object.entries(G)) {
    const c = await snap("snap", { garmentColor: "Navy", locations: { front: { graphicId: gid } } });
    ok("a pick of the " + (k === "emb" ? "embroidery" : k) + " graphic is " + (k === "emb" ? "embroidery" : k) + " in the line's copy", c.locations.length === 1 && c.locations[0].decoration === (k === "emb" ? "embroidery" : k));
  }
  const two = await snap("snap", { garmentColor: "Navy", locations: { front: { graphicId: G.vinyl }, back: { graphicId: G.emb } } });
  ok("each location carries its own", two.locations.find(l => l.location === "front").decoration === "vinyl" && two.locations.find(l => l.location === "back").decoration === "embroidery");

  // Fixed transfers are DTF whatever the graphic prints with.
  const BACK = await lib.saveLocation(d1, { name: "Back" });
  await make("fixed", { noDesignNeeded: true, reorderQr: "none", fixedTransfers: [{ locationId: BACK, graphicId: G.screenprint }] });
  const fx = await snap("fixed", null);
  ok("a product's fixed transfer is DTF, whatever its graphic is printed with", fx.locations.length === 1 && fx.locations[0].fixed === true && fx.locations[0].decoration === "dtf");

  // The reorder QR: a transfer is DTF; one chosen through a graphic is that graphic's type.
  await make("qr-t", { noDesignNeeded: true, reorderQr: "t" + sheet });
  const q1 = await snap("qr-t", null);
  ok("a reorder QR chosen as a transfer is DTF", q1.locations.length === 1 && q1.locations[0].location === "reorderqr" && q1.locations[0].decoration === "dtf");
  for (const k of ["screenprint", "vinyl", "dtg", "dtf", "emb"]) {
    await make("qr-" + k, { noDesignNeeded: true, reorderQr: String(G[k]) });
    const c = await snap("qr-" + k, null);
    ok("a reorder QR chosen through a " + (k === "emb" ? "embroidery" : k) + " graphic is " + (k === "emb" ? "embroidery" : k), c.locations[0].decoration === (k === "emb" ? "embroidery" : k));
  }
  await lib.setOrgReorderQrTransfer(d1, "acme", sheet);
  await make("qr-default", { noDesignNeeded: true, reorderQr: "default" });
  ok("the shop's default reorder QR (a transfer) is DTF", (await snap("qr-default", null)).locations[0].decoration === "dtf");
  await lib.setOrgReorderQrTransfer(d1, "acme", null);
  d1._raw.run("UPDATE orgs SET reorderQrGraphicId=? WHERE orgId='acme'", [G.dtg]);
  ok("the shop's old-style default reorder QR (a graphic) is that graphic's type", (await snap("qr-default", null)).locations[0].decoration === "dtg");
  d1._raw.run("UPDATE orgs SET reorderQrGraphicId=NULL WHERE orgId='acme'");

  // The customer's own design.
  const up = (extra) => Object.assign({ uploadId: "u1", fileKey: "order-files/pending/a.png", fileName: "a", fileExt: "png" }, extra);
  const plainCustom = async (id, extra, uploadExtra) => { await make(id, Object.assign({ noDesignNeeded: true, reorderQr: "none" }, extra)); return (await snap(id, null, { custom: { customdesign: up(uploadExtra) } })).locations[0]; };
  const cases = [
    ["transfer", "", "dtf"], ["embroidery", "", "embroidery"],
    ["transfer", "embroidery", "dtf"], ["embroidery", "embroidery", "embroidery"],
    ["transfer", "dtf", "dtf"], ["embroidery", "dtf", "dtf"],
    ["transfer", "screenprint", "screenprint"], ["embroidery", "screenprint", "screenprint"],
    ["transfer", "vinyl", "vinyl"], ["embroidery", "dtg", "dtg"], ["transfer", "sublimation", "sublimation"],
  ];
  for (const [kind, type, want] of cases) {
    const loc = await plainCustom("cd-" + kind + "-" + (type || "none"), { customDesign: kind, decorationType: type });
    ok("the customer's own design on an ordinary " + kind + " product with " + (type ? "its own type " + type : "no type of its own") + " is " + want, loc.custom === true && loc.kind === kind && loc.decoration === want);
  }
  let loc = await plainCustom("cd-carry-t", { customDesign: "" }, { kind: "transfer", addOnCents: 100 });
  ok("a design carried over from the line's copy (product no longer offers it) is DTF when it was a transfer", loc.kind === "transfer" && loc.decoration === "dtf");
  loc = await plainCustom("cd-carry-e", { customDesign: "" }, { kind: "embroidery", addOnCents: 100 });
  ok("…and embroidery when it was stitched", loc.kind === "embroidery" && loc.decoration === "embroidery");
  loc = await plainCustom("cd-carry-v", { customDesign: "", decorationType: "vinyl" }, { kind: "embroidery", addOnCents: 100 });
  ok("…but the product's own printed type still wins", loc.decoration === "vinyl");
  for (const [kind, type, want] of [["transfer", "", "dtf"], ["embroidery", "", "embroidery"], ["embroidery", "dtg", "dtg"], ["transfer", "embroidery", "dtf"]]) {
    const id = "cc-" + kind + "-" + (type || "none");
    await cfgProduct(id, { customDesign: kind, decorationType: type });
    const c = await snap(id, { garmentColor: "Navy", locations: { front: { custom: true }, back: { graphicId: G.vinyl } } }, { custom: { front: up() } });
    ok("a configurable " + kind + " product with " + (type ? "type " + type : "no type") + ": the customer's own design at a location is " + want + " and a graphic pick keeps its own",
      c.locations.find(l => l.location === "front").decoration === want && c.locations.find(l => l.location === "back").decoration === "vinyl");
  }

  // ------------------------------------------------------------------------------------------------------------
  say("=== locationDecoration_ and lineDecorations_ ===");
  const ld = lib.locationDecoration_;
  ok("a location says its own decoration", ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"].every(k => ld({ kind: "transfer", decoration: k }) === k));
  ok("a line placed before 0118 (no decoration) is embroidery for an embroidery entry", ld({ kind: "embroidery" }) === "embroidery");
  ok("…and DTF for a transfer entry", ld({ kind: "transfer" }) === "dtf");
  ok("a decoration that is not a key is ignored and the kind decides", ld({ kind: "embroidery", decoration: "laser" }) === "embroidery" && ld({ kind: "transfer", decoration: "laser" }) === "dtf" && ld({ kind: "transfer", decoration: "" }) === "dtf");
  ok("an entry with a decoration beats its kind", ld({ kind: "embroidery", decoration: "vinyl" }) === "vinyl");
  ok("no entry at all is DTF", ld(null) === "dtf" && ld({}) === "dtf");
  const ldl = lib.lineDecorations_;
  const L = (...ds) => ({ config: { locations: ds.map((d, i) => ({ location: "l" + i, kind: d === "embroidery" ? "embroidery" : "transfer", decoration: d })) } });
  ok("a line lists the unique decorations of its locations in registry order", same(ldl(L("vinyl", "embroidery", "vinyl", "dtf")), ["embroidery", "dtf", "vinyl"]));
  ok("a line of one type lists one", same(ldl(L("sublimation", "sublimation")), ["sublimation"]));
  ok("a line placed before 0118 reads each location by its kind", same(ldl({ config: { locations: [{ location: "a", kind: "embroidery" }, { location: "b", kind: "transfer" }] } }), ["embroidery", "dtf"]));
  ok("a line read from its stored text works the same", same(ldl({ configJson: JSON.stringify(L("dtg", "screenprint").config) }), ["screenprint", "dtg"]));
  ok("an entry with no location is not counted", same(ldl({ config: { locations: [{ kind: "embroidery" }, { location: "x", kind: "transfer", decoration: "vinyl" }, null] } }), ["vinyl"]));
  ok("a line with no locations takes its product's decoration", same(ldl({ config: { locations: [] } }, { decorationType: "dtg" }), ["dtg"]) && same(ldl({}, { noDesignNeeded: true }), ["dtf"]) && same(ldl(null, {}), ["embroidery"]));
  ok("a line with locations ignores its product's decoration", same(ldl(L("vinyl"), { decorationType: "dtg" }), ["vinyl"]));
  ok("a line with nothing to decorate lists nothing", same(ldl({}, { digital: true }), []) && same(ldl({ config: { locations: [] } }, null), []) && same(ldl({ configJson: "not json" }, { digital: true }), []));

  // ------------------------------------------------------------------------------------------------------------
  say("=== Update from catalog: a graphic whose printed type changed ===");
  const place = async (orderId, graphicId) => {
    const pr = await lib.priceItem(d1, "acme", "rf", "OSFA", 1, false, { garmentColor: "Navy", locations: { front: { graphicId } } });
    await lib.insertOrder(d1, { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-07-05T00:00:00Z" },
      [{ productId: "rf", name: "rf", type: "shirt", size: "OSFA", qty: 1, unitPrice: pr.unitPrice, config: pr.config }]);
  };
  const preview = async (orderId, apply = false) => (await lib.refreshOrderLinesFromCatalog(d1, orderId, apply)).lines;
  const storedLoc = (orderId) => JSON.parse(d1.q("SELECT configJson FROM order_items WHERE orderId=?", orderId)[0].configJson).locations[0];
  const setDec = async (gid, decoration) => lib.updateGraphic(d1, gid, Object.assign(await lib.getGraphic(d1, gid), { decoration }));
  const gR = await tr("Refresh mark"), gK = await tr("Kind mark", "screenprint"), gT = await tr("Sheet mark", "vinyl");
  await make("rf", { noDesignNeeded: true, configurable: true, garmentColors: ["Navy"], reorderQr: "none", locations: [{ key: "front", label: "Front", graphicIds: [gR, gK, gT] }] });
  await place("R1", gR);
  ok("nothing is offered while the graphic is as it was ordered", (await preview("R1")).length === 0);
  await setDec(gR, "screenprint");
  let lines = await preview("R1");
  ok("a graphic moved from DTF to screen print says what it is now", lines.length === 1 && lines[0].changes.length === 1 && lines[0].changes[0] === "Refresh mark: now Screen print");
  ok("…the preview changes nothing", storedLoc("R1").decoration === "dtf");
  await preview("R1", true);
  ok("…applying it puts the new type on the line", storedLoc("R1").decoration === "screenprint");
  ok("…and then nothing more is offered", (await preview("R1")).length === 0);
  await setDec(gR, "vinyl");
  lines = await preview("R1");
  ok("from one printed type to another says so", lines.length === 1 && lines[0].changes[0] === "Refresh mark: now Vinyl / heat transfer");
  await setDec(gR, "dtf");
  lines = await preview("R1");
  ok("back to DTF says DTF transfer", lines.length === 1 && lines[0].changes[0] === "Refresh mark: now DTF transfer");
  await lib.setDecorationTypes(d1, ["embroidery", "dtf"]);
  await setDec(gR, "sublimation");
  lines = await preview("R1");
  ok("a type that is switched off is still named (records are never hidden)", lines.length === 1 && lines[0].changes[0] === "Refresh mark: now Sublimation");
  await lib.setDecorationTypes(d1, ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"]);

  await setDec(gR, "");
  await place("R2", gR);
  d1._raw.run("UPDATE order_items SET configJson = json_remove(configJson, '$.locations[0].decoration') WHERE orderId='R2'");
  ok("the old line really has no decoration saved", storedLoc("R2").decoration === undefined);
  lines = await preview("R2");
  ok("a line placed before 0118 is read as DTF, so a DTF graphic is no change of type (only the ordinary refresh of its copy is offered)", lines.length === 1 && same(lines[0].changes, ["Pictures / names refreshed"]));
  await setDec(gR, "dtg");
  lines = await preview("R2");
  ok("…and a graphic that is now DTG is a change from DTF", lines.length === 1 && lines[0].changes[0] === "Refresh mark: now DTG");
  await preview("R2", true);
  ok("…which puts the type on the old line", storedLoc("R2").decoration === "dtg");

  await place("R3", gK);
  await lib.updateGraphic(d1, gK, Object.assign(await lib.getGraphic(d1, gK), { kind: "embroidery", decoration: undefined }));
  lines = await preview("R3");
  ok("a graphic that became embroidery says transfer to embroidery, not a decoration change", lines.length === 1 && lines[0].changes[0] === "Kind mark: a transfer → embroidery");
  await preview("R3", true);
  ok("…and the line now says embroidery", storedLoc("R3").decoration === "embroidery" && storedLoc("R3").kind === "embroidery");

  const sheet2 = await lib.createTransfer(d1, { name: "Second sheet" });
  await place("R4", gT);
  await lib.updateGraphic(d1, gT, Object.assign(await lib.getGraphic(d1, gT), { transferId: sheet2 }));
  lines = await preview("R4");
  ok("a changed transfer on an unchanged type is still a transfer change", lines.length === 1 && lines[0].changes[0] === "Sheet mark: transfer linked");
  await lib.updateGraphic(d1, gT, Object.assign(await lib.getGraphic(d1, gT), { transferId: sheet2, decoration: "dtg" }));
  lines = await preview("R4");
  ok("a changed type is reported before a changed transfer", lines.length === 1 && lines[0].changes.length === 1 && lines[0].changes[0] === "Sheet mark: now DTG");

  // ------------------------------------------------------------------------------------------------------------
  say("=== analyzePricing: the decoration cost per printed type ===");
  await lib.setDecorationPricing(d1, {
    embroidery: { stitchPricing: true, centsPer1000: 100 },
    dtf: { costCents: 30, priceCents: 90, setupCents: 500 },
    screenprint: { inkColorCents: 150, screenSetupCents: 2000, reorderSetupCents: 500, costCents: 25, maxColors: 4 },
    vinyl: { costCents: 40 }, dtg: { costCents: 90 }, sublimation: { costCents: 60 } });
  const ap = (id, extra) => make(id, Object.assign({ pricingMode: "flat", flatPrice: 30, noBlankNeeded: true }, extra), "other");
  const dsgO = await lib.saveDesign(d1, "other", { name: "Example boosters crest" });
  await ap("a-emb"); await lib.setProductDesign(d1, "other", "a-emb", dsgO);
  await ap("a-dtf", { noDesignNeeded: true });
  await ap("a-scr", { decorationType: "screenprint", noDesignNeeded: true });
  await ap("a-vin", { decorationType: "vinyl", noDesignNeeded: true });
  await ap("a-dtg", { decorationType: "dtg", noDesignNeeded: true });
  await ap("a-sub", { decorationType: "sublimation", noDesignNeeded: true });
  await ap("a-dig", { digital: true });
  d1._raw.run("UPDATE products SET noDesignNeeded=0 WHERE productId='a-dig'");
  let an = (await lib.analyzePricing(d1, { orgId: "other" })).products;
  const by = (id) => an.find(x => x.productId === id);
  const base = by("a-emb");
  ok("every product is analysed", an.length === 7);
  ok("an embroidery product costs no decoration and says so", base.decoration === "embroidery" && base.decorationLabel === "Embroidery" && base.decorationCost === 0 && base.rows[0].decoration === 0);
  ok("a DTF product's decoration cost is not added (its transfer is counted as before)", by("a-dtf").decoration === "dtf" && by("a-dtf").decorationLabel === "DTF transfer" && by("a-dtf").decorationCost === 0 &&
    by("a-dtf").rows[0].decoration === 0 && by("a-dtf").rows[0].costs === base.rows[0].costs);
  const want = { "a-scr": ["screenprint", "Screen print", 0.25], "a-vin": ["vinyl", "Vinyl / heat transfer", 0.4], "a-dtg": ["dtg", "DTG", 0.9], "a-sub": ["sublimation", "Sublimation", 0.6] };
  for (const [id, [type, label, cost]] of Object.entries(want)) {
    const a = by(id);
    ok("a " + type + " product costs $" + cost.toFixed(2) + " a piece for one colour at one location", a.decoration === type && a.decorationLabel === label && a.decorationCost === cost && a.rows[0].decoration === cost);
    ok("…which is part of its costs and takes that much off its income", Math.abs(a.rows[0].costs - base.rows[0].costs - cost) < 0.0001 && Math.abs(base.rows[0].income - a.rows[0].income - cost) < 0.0001);
  }
  ok("a digital product has no decoration and costs none", by("a-dig").decoration === "" && by("a-dig").decorationLabel === "" && by("a-dig").decorationCost === 0);
  await lib.setDecorationPricing(d1, { screenprint: { costCents: 0 } });
  an = (await lib.analyzePricing(d1, { orgId: "other", productId: "a-scr" })).products;
  ok("a type with no cost set adds nothing", an.length === 1 && an[0].decoration === "screenprint" && an[0].decorationCost === 0 && an[0].rows[0].costs === base.rows[0].costs);
  await lib.setDecorationTypes(d1, ["embroidery", "dtf"]);
  await lib.setDecorationPricing(d1, { vinyl: { costCents: 40 } });
  an = (await lib.analyzePricing(d1, { orgId: "other", productId: "a-vin" })).products;
  ok("a switched-off type's product is still analysed with its cost", an[0].decoration === "vinyl" && an[0].decorationCost === 0.4);
  await lib.setDecorationTypes(d1, ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"]);

  // ------------------------------------------------------------------------------------------------------------
  say("=== The shop page: decorations in words, and the published snapshot ===");
  const SHOP = "other";
  const gS = { emb: await lib.createGraphic(d1, SHOP, { name: "Boosters stitched", kind: "embroidery" }), dtf: await lib.createGraphic(d1, SHOP, { name: "Boosters DTF", kind: "transfer", transferId: sheet }),
    scr: await lib.createGraphic(d1, SHOP, { name: "Boosters screen", kind: "transfer", transferId: sheet, decoration: "screenprint" }),
    vin: await lib.createGraphic(d1, SHOP, { name: "Boosters vinyl", kind: "transfer", transferId: sheet, decoration: "vinyl" }),
    dtg: await lib.createGraphic(d1, SHOP, { name: "Boosters DTG", kind: "transfer", transferId: sheet, decoration: "dtg" }),
    sub: await lib.createGraphic(d1, SHOP, { name: "Boosters sub", kind: "transfer", transferId: sheet, decoration: "sublimation" }) };
  const FRONT = await lib.saveLocation(d1, { name: "Front" }), SLEEVE = await lib.saveLocation(d1, { name: "Sleeve" });
  await make("shop-print", { noDesignNeeded: true, noBlankNeeded: true, fixedTransfers: [{ locationId: FRONT, graphicId: gS.dtf }, { locationId: SLEEVE, graphicId: gS.scr }, { locationId: BACK, graphicId: gS.vin }] }, SHOP);
  await make("shop-print2", { noDesignNeeded: true, noBlankNeeded: true, fixedTransfers: [{ locationId: FRONT, graphicId: gS.dtg }, { locationId: SLEEVE, graphicId: gS.sub }] }, SHOP);
  const shopDesign = await lib.saveDesign(d1, SHOP, { name: "Boosters crest stitch" });
  await make("shop-stitch", { noBlankNeeded: true }, SHOP);
  await lib.setProductDesign(d1, SHOP, "shop-stitch", shopDesign);
  await make("shop-mock", { noDesignNeeded: true, noBlankNeeded: true, mockupGraphics: [{ locationId: FRONT, graphicId: gS.emb }] }, SHOP);
  await make("shop-bare", { noDesignNeeded: true, noBlankNeeded: true }, SHOP);
  const kinds = (shop, id) => ((shop.products.find(x => x.productId === id) || {}).decorations || []).map(d => d.kind + "|" + d.name + "|" + d.location);
  let draft = await lib.getDraftCatalogShop(d1, SHOP);
  ok("with every type on, each printed type is labelled with its own word and where it sits", same(kinds(draft, "shop-print"),
    ["Printed (DTF)|Boosters DTF|Front", "Screen printed|Boosters screen|Sleeve", "Vinyl|Boosters vinyl|Back"]) &&
    same(kinds(draft, "shop-print2"), ["DTG printed|Boosters DTG|Front", "Sublimated|Boosters sub|Sleeve"]));
  ok("…a product's own design is Embroidered", same(kinds(draft, "shop-stitch"), ["Embroidered|Boosters crest stitch|Main"]));
  ok("…and so is an embroidery graphic placed for a mockup", same(kinds(draft, "shop-mock"), ["Embroidered|Boosters stitched|Front"]));
  ok("…a product with nothing to describe has no list", draft.products.find(x => x.productId === "shop-bare").decorations === undefined);
  await lib.setDecorationTypes(d1, ["dtf", "vinyl"]);
  draft = await lib.getDraftCatalogShop(d1, SHOP);
  ok("a switched-off type is left out of the shop page: only DTF and vinyl are listed", same(kinds(draft, "shop-print"), ["Printed (DTF)|Boosters DTF|Front", "Vinyl|Boosters vinyl|Back"]));
  ok("…a product whose types are all off has no list", draft.products.find(x => x.productId === "shop-print2").decorations === undefined);
  ok("…embroidery is left out when it is off, from designs and from mockups", draft.products.find(x => x.productId === "shop-stitch").decorations === undefined && draft.products.find(x => x.productId === "shop-mock").decorations === undefined);
  await lib.setDecorationTypes(d1, ["embroidery"]);
  draft = await lib.getDraftCatalogShop(d1, SHOP);
  ok("…and with only embroidery on, only embroidery is listed", draft.products.find(x => x.productId === "shop-print").decorations === undefined && same(kinds(draft, "shop-stitch"), ["Embroidered|Boosters crest stitch|Main"]));
  await lib.setDecorationTypes(d1, ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"]);

  // The same on the published path, which reads the types once for every shop.
  await lib.setDecorationTypes(d1, ["dtf", "dtg"]);
  const whole = await lib.getPublicCatalogData(d1);
  const wShop = Object.values(whole.orgs || {}).find(o => o.products && o.products.some(x => x.productId === "shop-print2")) || { products: [] };
  ok("the whole-install catalog leaves a switched-off type out too", same(kinds(wShop, "shop-print"), ["Printed (DTF)|Boosters DTF|Front"]) && same(kinds(wShop, "shop-print2"), ["DTG printed|Boosters DTG|Front"]));
  const one = await lib.getPublicCatalogShop(d1, SHOP);
  ok("…and so does a single shop's", same(kinds(one, "shop-print"), ["Printed (DTF)|Boosters DTF|Front"]) && same(kinds(one, "shop-print2"), ["DTG printed|Boosters DTG|Front"]));
  await lib.setDecorationTypes(d1, ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"]);

  // Published snapshots.
  await make("snap-a", { decorationType: "dtg", noDesignNeeded: true }, SHOP);
  await make("snap-b", { noDesignNeeded: true }, SHOP);
  const pub = await lib.publishShop(d1, SHOP, "pat@example.com");
  const snapRows = await lib.getCatalogSnapshot(d1, SHOP);
  ok("publishing keeps every product's decorationType in the snapshot", pub && snapRows.products.length === pub.products && snapRows.products.every(x => "decorationType" in x) &&
    snapRows.products.find(x => x.productId === "snap-a").decorationType === "dtg" && snapRows.products.find(x => x.productId === "snap-b").decorationType === "");
  await upd("snap-a", { decorationType: "vinyl" }, SHOP);
  await upd("snap-b", { decorationType: "sublimation" }, SHOP);
  let live = await lib.getPublicCatalogShop(d1, SHOP);
  const lp = (shop, id) => shop.products.find(x => x.productId === id);
  ok("the shop page shows the published type, not the draft's, until it is published again", lp(live, "snap-a").decorationType === "dtg" && lp(live, "snap-a").decoration === "dtg" &&
    lp(live, "snap-b").decorationType === "" && lp(live, "snap-b").decoration === "dtf");
  ok("…while the draft shows the new ones", lp(await lib.getDraftCatalogShop(d1, SHOP), "snap-a").decoration === "vinyl" && lp(await lib.getDraftCatalogShop(d1, SHOP), "snap-b").decoration === "sublimation");
  await lib.publishShop(d1, SHOP, "pat@example.com");
  live = await lib.getPublicCatalogShop(d1, SHOP);
  ok("publishing again carries the new types to the shop page", lp(live, "snap-a").decorationType === "vinyl" && lp(live, "snap-b").decorationType === "sublimation" && lp(live, "snap-b").decoration === "sublimation");
  ok("a product's type is part of what the page is told, as stored and as worked out", Object.prototype.hasOwnProperty.call(lp(live, "snap-a"), "decorationType") && Object.prototype.hasOwnProperty.call(lp(live, "snap-a"), "decoration"));
  const aloneDb = await makeDb();
  aloneDb._raw.run("INSERT INTO products (orgId, productId, type, name, pricingMode, flatPriceCents, visible, createdAt, updatedAt) VALUES ('acme','pub-old','shirt','Old','flat',2000,1,'t','t')");
  await lib.publishShop(aloneDb, "acme", "pat@example.com");
  ok("a product published with no type of its own reads as none", lp(await lib.getPublicCatalogShop(aloneDb, "acme"), "pub-old").decorationType === "");
})().catch((e) => { console.log("the test file stopped with an error: " + (e && e.stack || e)); process.exit(1); });
