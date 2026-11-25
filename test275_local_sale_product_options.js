const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Orders → + Local sale sells what the shop's page sells, with the same choices (public/admin.js showLocalSaleModal,
// functions/api/orders.js createLocalSale). A product where the customer picks a garment color and a design at each
// location (configurable, migrations/0036) could not be sold: the window had no color or design pickers, so the server
// answered "Pick a garment color." every time. Checked here, in the real admin page (jsdom) against the real orders.js /
// db.js on sql.js:
//   - the window shows the product's garment colors, a design list per location (None where the product has several
//     locations), the thread color of a design with more than one, and "Customer's own design" where the product takes
//     one — each list filtered for the color the way the shop's page filters it (a design for other colors only, a
//     design this product doesn't offer on that color);
//   - the price follows the color's price group, each design's add-on and the customer's design add-on;
//   - nothing picked anywhere is refused in the window, as on the shop's page;
//   - Record sale sends the choices, and the order line keeps them (what production makes);
//   - a plain product that takes the customer's own design offers it (ticked and fixed when the product has no design
//     of its own), and the line keeps the design's entry for Files, with its add-on;
//   - the server: Override price on a product with choices now checks those choices and keeps them on the line
//     (it priced it without them and failed the same way); the customer's own design on a plain product is kept.
//   - Edit items → + Add item had the same gap (an added line of such a product had no lists, and Save failed the same
//     way): an added line now gets the color and graphic lists (labelled), the customer's own design, the color's price,
//     the same refusal when nothing is picked, and is saved with its choices (editOrder additions).
// Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createGraphic, saveLocation, setTierPrices, setProductGraphicColorBlocked, getOrderById };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") + "\n" +
  // The real roles (functions/_lib/permissions.js) for the role the request names (the page's requests: the owner).
  "const requireAdmin = async (env, host, key, request, msg, need) => { const r = (request.headers.get('x-role') || 'admin'); return roleAllows(DEFAULT_ROLES[r] || null, need === 'staff' ? '*' : need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'olive@example.test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0, finished = false;
// A test that stops part-way (a promise nothing resolves) must not pass by printing no failure.
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return cond(); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);`);
  const call = async (body, { role = "admin" } = {}) => {
    // DESIGNS: the bucket the customer's own design is kept in (a stand-in; nothing is uploaded here).
    const res = await api({ env: { DB: d1, DESIGNS: {} }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  // Two decoration locations; three graphics: Crest (a small-tier add-on of $3, two thread colors), Star (only for
  // Navy garments), Wave (this product doesn't offer it on Heather).
  const chest = await lib.saveLocation(d1, { name: "Left chest", sortOrder: 1 });
  const back = await lib.saveLocation(d1, { name: "Back", sortOrder: 2 });
  const crest = await lib.createGraphic(d1, "club", { name: "Crest", kind: "transfer", tier: "small", inkColors: ["White", "Gold"], imageUrl: "img/crest.png", visible: true });
  const star = await lib.createGraphic(d1, "club", { name: "Star", kind: "transfer", allowedGarmentColors: ["Navy"], imageUrl: "img/star.png", visible: true });
  const wave = await lib.createGraphic(d1, "club", { name: "Wave", kind: "transfer", imageUrl: "img/wave.png", visible: true });
  await lib.setTierPrices(d1, "club", { small: 3 });
  const CHEST = "loc" + chest, BACK = "loc" + back;
  let r = await call({ action: "createProduct", org: "club", productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 20 },
    visible: true, sortOrder: 1, images: [], configurable: true, garmentColors: ["Navy", "Heather"], reorderQr: "none", noDesignNeeded: true,
    colorGroups: [{ label: "Heather", colors: ["Heather"], sizePricing: { S: 24, M: 24 } }],
    locations: [{ key: CHEST, label: "Left chest", locationId: chest, graphicIds: [crest, star, wave] }, { key: BACK, label: "Back", locationId: back, graphicIds: [crest] }],
    customDesign: "transfer", customDesignPrice: 6 });
  ok("(the product with choices is made)", r.status === 200);
  await lib.setProductGraphicColorBlocked(d1, "club", "tee", wave, "Heather", true);
  r = await call({ action: "createProduct", org: "club", productId: "logo-tee", type: "shirt", name: "Your Logo Tee", pricingMode: "flat", flatPrice: 18, visible: true, sortOrder: 2,
    images: [], customDesign: "transfer", customDesignPrice: 5 });
  ok("(a plain product that takes the customer's own design, with no design of its own, is made)", r.status === 200);
  r = await call({ action: "createProduct", org: "club", productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 15, visible: true, sortOrder: 3, images: [], noDesignNeeded: true });
  ok("(a plain cap is made)", r.status === 200);
  const sale = (items, extra = {}) => call({ action: "createLocalSale", org: "club", customerName: "Walk-in", paymentMethod: "Cash", items, ...extra });
  const lineOf = async (orderId) => (await lib.getOrderById(d1, orderId)).items[0];
  const pick = (location, graphicId, ink) => ({ location, graphicId, ...(ink ? { ink } : {}) });

  console.log("=== The server: a sale of a product with choices ===");
  r = await sale([{ productId: "tee", size: "M", qty: 1 }]);
  ok("with no garment color it's refused, as a storefront order is", r.status === 400 && r.body.message === "Pick a garment color.");
  r = await sale([{ productId: "tee", size: "M", qty: 2, config: { garmentColor: "Heather", locations: [pick(CHEST, crest, "Gold")] } }]);
  let line = r.status === 200 ? await lineOf(r.body.orderId) : null;
  ok("with its choices it's recorded: Heather's price ($24) plus Crest's add-on ($3)", !!line && line.unitPrice === 27 && line.lineTotal === 54);
  ok("…and the line keeps the color and the design, with its thread color", !!line && line.config.garmentColor === "Heather" &&
    line.config.locations.length === 1 && line.config.locations[0].graphicId === crest && line.config.locations[0].ink === "Gold" && line.config.locations[0].location === CHEST);
  r = await sale([{ productId: "tee", size: "S", qty: 1, customUnitPrice: 12, config: { garmentColor: "Navy", locations: [pick(CHEST, star)] } }]);
  line = r.status === 200 ? await lineOf(r.body.orderId) : null;
  ok("Override price on a product with choices is recorded at the price typed (it was refused: \"Pick a garment color.\")", r.status === 200 && !!line && line.unitPrice === 12);
  ok("…and the line keeps the choices, so production knows what to make", !!line && !!line.config && line.config.garmentColor === "Navy" && line.config.locations.some(l => l.graphicId === star));
  r = await sale([{ productId: "tee", size: "S", qty: 1, customUnitPrice: 12, config: { garmentColor: "Heather", locations: [pick(CHEST, wave)] } }]);
  ok("…the choices are still checked: a design the product doesn't offer on that color is refused", r.status === 400 && /Wave isn't available on Heather/.test(r.body.message));
  r = await sale([{ productId: "tee", size: "S", qty: 1, config: { garmentColor: "Navy", locations: [{ location: BACK, custom: true }] } }]);
  line = r.status === 200 ? await lineOf(r.body.orderId) : null;
  ok("the customer's own design at a location is recorded with its $6 add-on, waiting for the file (Files)", !!line && line.unitPrice === 26 &&
    line.config.locations.some(l => l.custom && l.location === BACK && !l.uploadId && l.addOnCents === 600));

  console.log("\n=== The server: the customer's own design on a plain product ===");
  r = await sale([{ productId: "logo-tee", size: "OSFA", qty: 1, customDesign: true }]);
  line = r.status === 200 ? await lineOf(r.body.orderId) : null;
  ok("ticked, the line has the design's entry for Files and its $5 add-on ($23)", !!line && line.unitPrice === 23 &&
    !!line.config && line.config.locations.some(l => l.custom && l.location === "customdesign" && !l.uploadId));
  r = await sale([{ productId: "cap", size: "OSFA", qty: 1, customDesign: true }]);
  ok("…a product that doesn't take one is refused", r.status === 400 && /no longer takes your own design/.test(r.body.message));

  // ---- The page ------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js");
  const sent = [], toasts = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) { return Promise.resolve(Buffer.from(url.includes("/admin.js") ? adminJs : "")); }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/#orders/club", pretendToBeVisual: true,
    beforeParse(win) {
      autoConfirm(win, () => true);
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.fetch = async (url, init) => {
        const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (String(url).includes("/api/orders")) { sent.push(b); const x = await call(b); return reply(x.status, x.body); }
        return reply(404, { status: "error", message: "not here" });
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "club", name: "Example Club" }];');
  w.refreshOrderRows_ = () => {};

  const form = () => d.querySelector("#localSaleForm");
  // The window's promise is kept apart (an async function returning it would wait for the whole sale).
  const open = async () => { const done = w.createLocalSale("club"); await wait(() => !!form()); return { done }; };
  const lineEl = (i = 0) => form().querySelectorAll(".ls-line")[i];
  const fld = (line, name) => line.querySelector(`[data-f="${name}"]`);
  const choose = (el, value) => { el.value = value; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const shown = (el) => !!el && el.style.display !== "none" && !(el.closest("[data-f]") && el.closest("[data-f]").style.display === "none");
  const locSel = (line, key) => line.querySelector(`select[data-f="loc"][data-loc="${key}"]`);
  const inkSel = (line, key) => line.querySelector(`select[data-f="ink"][data-loc="${key}"]`);
  const optTexts = (sel) => sel ? [...sel.options].map(o => o.textContent.trim()) : [];
  const preview = () => form().querySelector("#lsPricePreview").textContent;

  console.log("\n=== The window: a product with choices ===");
  let opening = await open();
  ok("the window opens", !!form());
  choose(form().querySelector("#lsProduct"), "tee");
  let L = lineEl();
  const colorSel = fld(L, "color");
  ok("it shows the garment colors (Navy, Heather)", !!colorSel && shown(colorSel) && optTexts(colorSel).join("|") === "Navy|Heather");
  ok("…a graphic list for each location, labelled with its name", !!locSel(L, CHEST) && !!locSel(L, BACK) &&
    /Left chest/.test(form().querySelector(`label[for="${locSel(L, CHEST).id}"]`) ? form().querySelector(`label[for="${locSel(L, CHEST).id}"]`).textContent : "") &&
    /Back/.test(form().querySelector(`label[for="${locSel(L, BACK).id}"]`) ? form().querySelector(`label[for="${locSel(L, BACK).id}"]`).textContent : ""));
  ok("…Left chest on Navy offers None, Crest (+$3.00), Star, Wave and the customer's own design (+$6.00)",
    optTexts(locSel(L, CHEST)).join("|") === "None|Crest (+$3.00)|Star|Wave|Customer's own design (+$6.00)");
  ok("…Back offers None, Crest and the customer's own design", optTexts(locSel(L, BACK)).join("|") === "None|Crest (+$3.00)|Customer's own design (+$6.00)");
  choose(colorSel, "Heather");
  ok("on Heather, Star (Navy only) and Wave (not offered on Heather) are gone", optTexts(locSel(L, CHEST)).join("|") === "None|Crest (+$3.00)|Customer's own design (+$6.00)");
  ok("…and the sizes show Heather's price", [...fld(L, "size").options].map(o => o.textContent).join("|") === "S — $24.00|M — $24.00");
  choose(form().querySelector("#lsPayment"), "Cash");
  form().querySelector(".admin-pass-submit").click();
  await pause(20);
  ok("with no graphic anywhere, Record sale is refused in the window, as on the shop's page", form() && /Choose a graphic for at least one location\./.test(form().querySelector("#lsErr").textContent) &&
    !sent.some(b => b.action === "createLocalSale"));
  choose(locSel(L, CHEST), String(crest));
  ok("picking Crest shows its thread colors", shown(inkSel(L, CHEST)) && optTexts(inkSel(L, CHEST)).join("|") === "White|Gold");
  ok("…a location left at None (Back) shows no thread list", !shown(inkSel(L, BACK)));
  choose(inkSel(L, CHEST), "Gold");
  choose(fld(L, "size"), "M");
  fld(L, "qty").value = "2"; fld(L, "qty").dispatchEvent(new w.Event("input", { bubbles: true }));
  ok("the price follows the color's group and the design's add-on: ($24 + $3) × 2", /= \$54\.00$/.test(preview()));
  choose(locSel(L, BACK), "custom");
  ok("…and the customer's own design adds its $6: ($24 + $3 + $6) × 2", /= \$66\.00$/.test(preview()));
  sent.length = 0;
  form().querySelector(".admin-pass-submit").click();
  await opening.done;
  const req = sent.find(b => b.action === "createLocalSale");
  ok("Record sale sends the color and each location's choice", !!req && JSON.stringify(req.items[0].config) ===
    JSON.stringify({ garmentColor: "Heather", locations: [{ location: CHEST, graphicId: crest, ink: "Gold" }, { location: BACK, custom: true }] }));
  const made = req ? await lib.getOrderById(d1, toasts.map(t => (/Local sale recorded — (\S+)/.exec(t.m) || [])[1]).filter(Boolean).pop()) : null;
  ok("…the sale is recorded", !!made && toasts.some(t => /^Local sale recorded — /.test(t.m) && !t.err));
  ok("…its line keeps Heather, Crest in Gold at Left chest and the customer's design at Back, at $33 each",
    !!made && made.items[0].unitPrice === 33 && made.items[0].config.garmentColor === "Heather" &&
    made.items[0].config.locations.some(l => l.location === CHEST && l.graphicId === crest && l.ink === "Gold") &&
    made.items[0].config.locations.some(l => l.location === BACK && l.custom));

  console.log("\n=== The window: the customer's own design on a plain product, and a plain product ===");
  toasts.length = 0; sent.length = 0;
  opening = await open();
  choose(form().querySelector("#lsProduct"), "logo-tee");
  L = lineEl();
  const cd = fld(L, "customDesign");
  ok("a product with no design of its own needs the customer's: the box is ticked and can't be unticked", !!cd && shown(cd) && cd.checked && cd.disabled &&
    /Customer's own design/.test(fld(L, "customDesignWrap").textContent) && /Files/.test(fld(L, "customDesignWrap").textContent));
  ok("…its $5 add-on is in the price ($23.00)", /= \$23\.00$/.test(preview()));
  ok("…and it has no color or design lists", !shown(fld(L, "cfgWrap")));
  form().querySelector("#lsAddLine").click();
  const L2 = lineEl(1);
  choose(fld(L2, "product"), "tee");
  ok("a second item has its own lists (its own ids)", !!locSel(L2, CHEST) && locSel(L2, CHEST).id !== (locSel(L, CHEST) || {}).id && fld(L2, "color").id === "lsColor-2");
  choose(locSel(L2, CHEST), String(star));
  form().querySelector("#lsAddLine").click();
  const L3 = lineEl(2);
  choose(fld(L3, "product"), "cap");
  ok("a plain cap shows no color, design or customer-design choice", !shown(fld(L3, "cfgWrap")) && !shown(fld(L3, "customDesignWrap")));
  choose(form().querySelector("#lsPayment"), "Cash");
  form().querySelector(".admin-pass-submit").click();
  await opening.done;
  const req2 = sent.find(b => b.action === "createLocalSale");
  ok("Record sale sends the plain product's design and the second item's Navy + Star", !!req2 && req2.items[0].customDesign === true && !req2.items[0].config &&
    JSON.stringify(req2.items[1].config) === JSON.stringify({ garmentColor: "Navy", locations: [{ location: CHEST, graphicId: star, ink: "" }] }) &&
    !req2.items[2].config && !req2.items[2].customDesign);
  const made2Id = toasts.map(t => (/Local sale recorded — (\S+)/.exec(t.m) || [])[1]).filter(Boolean).pop();
  const made2 = made2Id ? await lib.getOrderById(d1, made2Id) : null;
  const byProduct = (o, pid) => o.items.find(i => i.productId === pid);
  ok("…all three lines are recorded: the logo tee with the design's entry ($23), the tee on Navy with Star ($20), the cap ($15)", !!made2 &&
    byProduct(made2, "logo-tee").unitPrice === 23 && byProduct(made2, "logo-tee").config.locations.some(l => l.custom && l.location === "customdesign") &&
    byProduct(made2, "tee").unitPrice === 20 && byProduct(made2, "tee").config.garmentColor === "Navy" && byProduct(made2, "cap").unitPrice === 15);

  console.log("\n=== Edit items: + Add item with a product's choices ===");
  // An order with one cap, as the Orders page has it (its list is what Edit items opens from).
  r = await sale([{ productId: "cap", size: "OSFA", qty: 1 }], { customerName: "Edit Me" });
  const editId = r.body.orderId;
  w._ordersCache = { club: (await call({ action: "getOrders", org: "club" })).body.orders };
  toasts.length = 0; sent.length = 0;
  const editing = w.editOrder("club", editId);
  const rowsEl = () => d.querySelector("#editOrderRows");
  await wait(() => !!rowsEl());
  ok("Edit items opens", !!rowsEl());
  d.querySelector("#editOrderAddRow").click();
  const newRow = () => rowsEl().querySelectorAll("tr")[1];
  choose(newRow().querySelector('select[data-field="productId"]'), "tee");
  const cfgSel = (field, loc) => newRow().querySelector(`select[data-cfgfield="${field}"]${loc ? `[data-loc="${loc}"]` : ""}`);
  ok("an added Club Tee shows its garment colors and a graphic list for each location", !!cfgSel("color") && optTexts(cfgSel("color")).join("|") === "Navy|Heather" &&
    !!cfgSel("graphic", CHEST) && !!cfgSel("graphic", BACK));
  ok("…labelled for a screen reader", !!cfgSel("color") && cfgSel("color").getAttribute("aria-label") === "Garment color" && !!cfgSel("graphic", CHEST) && cfgSel("graphic", CHEST).getAttribute("aria-label") === "Left chest");
  ok("…its product can still be changed (a new line)", !!newRow().querySelector('select[data-field="productId"]'));
  ok("…Left chest offers the customer's own design on a new line", optTexts(cfgSel("graphic", CHEST)).includes("Customer's own design (+$6.00)"));
  d.querySelector("#editOrderSave").click();
  await pause(20);
  ok("with no graphic anywhere, Save is refused in the window and nothing is sent", /Choose a graphic for at least one location\./.test((d.querySelector("#editOrderErr") || {}).textContent || "") &&
    !sent.some(b => b.action === "editOrder"));
  if (cfgSel("color")) choose(cfgSel("color"), "Heather");
  ok("on Heather, Star and Wave are gone", optTexts(cfgSel("graphic", CHEST)).join("|") === "None|Crest (+$3.00)|Customer's own design (+$6.00)");
  if (cfgSel("graphic", CHEST)) choose(cfgSel("graphic", CHEST), String(crest));
  ok("picking Crest shows its thread colors", !!cfgSel("ink", CHEST) && optTexts(cfgSel("ink", CHEST)).join("|") === "White|Gold");
  if (cfgSel("ink", CHEST)) choose(cfgSel("ink", CHEST), "Gold");
  choose(newRow().querySelector('select[data-field="size"]'), "M");
  ok("the new total adds Heather's $24 + Crest's $3 to the cap's $15 ($42.00)", /\$42\.00/.test(d.querySelector("#editOrderNewTotal").textContent));
  // A plain product made from the customer's own design, added too.
  d.querySelector("#editOrderAddRow").click();
  const row3 = () => rowsEl().querySelectorAll("tr")[2];
  choose(row3().querySelector('select[data-field="productId"]'), "logo-tee");
  const own = row3().querySelector('input[data-field="customDesign"]');
  ok("an added Your Logo Tee has the customer's own design ticked and fixed", !!own && own.checked && own.disabled);
  ok("…and the new total adds its $18 + $5 ($65.00)", /\$65\.00/.test(d.querySelector("#editOrderNewTotal").textContent));
  d.querySelector("#editOrderSave").click();
  // Before the fix the window stays open (or the server refuses): don't wait for a sale that never comes.
  await Promise.race([editing, pause(3000)]);
  const editReq = sent.find(b => b.action === "editOrder");
  ok("Save sends the new lines with their choices", !!editReq && editReq.additions.length === 2 &&
    JSON.stringify(editReq.additions[0].config) === JSON.stringify({ garmentColor: "Heather", locations: [{ location: CHEST, graphicId: crest, ink: "Gold" }] }) &&
    editReq.additions[1].customDesign === true && !editReq.additions[1].config);
  const edited = await lib.getOrderById(d1, editId);
  const added = (pid) => edited.items.find(i => i.productId === pid && !i.cancelDate);
  ok("…the order now has the tee on Heather with Crest in Gold at $27", toasts.some(t => /^Order updated/.test(t.m) && !t.err) && !!added("tee") && added("tee").unitPrice === 27 &&
    added("tee").config.garmentColor === "Heather" && added("tee").config.locations.some(l => l.graphicId === crest && l.ink === "Gold"));
  ok("…and the logo tee with the design's entry, waiting for the file, at $23", !!added("logo-tee") && added("logo-tee").unitPrice === 23 &&
    !!added("logo-tee").config && added("logo-tee").config.locations.some(l => l.custom && l.location === "customdesign" && !l.uploadId));

  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
