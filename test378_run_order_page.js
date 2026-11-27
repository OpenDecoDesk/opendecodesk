process.env.TZ = "UTC";
// The one Run order page (public/admin.js renderRunOrder) in jsdom, with the real orders.js / db.js on sql.js behind fetch:
//   the menu (one Run Order button on the desktop row and in the phone sheet), #runtransfer opening it with DTF on;
//   the type buttons (All and each enabled type with counts, a switched-off type that still has cards marked, none for a
//   hidden one) and Order by (Due date, Order date, Customer / shop, Type, Blank with its headings), both remembered in
//   localStorage (odd_runorder_type, odd_runorder_sort), and still working when the browser keeps nothing;
//   ready cards before waiting ones with "Waiting on ...", embroidery job cards with their detail, DTF cards (Mark
//   transfer received / transfers applied / Mark made, Gang sheet totals for DTF and All only) and the other types'
//   cards (Start, Started + Undo, Mark made / Mark done) calling the right actions and refreshing in place;
//   the Paid, not yet run table's Type column; a role with only the transfer queue or only the production queue; names
//   shown as text. The server answers as the role the page is signed in as (permissions.js). Invented data only.
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok, counts } = require("./testlib/check");
const { autoConfirm } = require("./testlib/confirm.js");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, createProduct, createBlank, setBlankLink, createHoop, saveDesign, addDesignVersion, setProductDesign, saveMachine };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(globalThis.__role378, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" +
  "const adminUser = () => globalThis.__role378 ? { id: 1, email: 'tester@example.test', name: 'Tester', role: globalThis.__role378.key, roleInfo: globalThis.__role378 } : null;\n" +
  "const adminLevel = (request, fn) => effectiveLevel(globalThis.__role378, fn);\n" +
  "const adminCan = (request, fn, level) => permRank(adminLevel(request, fn)) >= permRank(level || 'read');\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost, DEFAULT_ROLES, PERMISSION_AREAS, effectivePermissions };")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

(async () => {
  globalThis.__role378 = api.DEFAULT_ROLES.admin;
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const waits = [];
    const res = await api.post({ env: { DB: d1 }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t'), ('band','band','Example <b>Boosters</b>','t','t');`);
  const hoop = await lib.createHoop(d1, { name: "Cap Frame", isCapFrame: true });
  await lib.saveMachine(d1, { name: "Machine 1", needleCount: 12, hoopIds: [hoop] });
  const capBlank = (await lib.createBlank(d1, { name: "Cap 112", brand: "Example", color: "Navy", productType: "cap" })).id;
  const teeBlank = (await lib.createBlank(d1, { name: "Tee 5000", brand: "Example", color: "Navy", productType: "shirt" })).id;
  for (const org of ["club", "band"]) {
    await lib.createProduct(d1, org, { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 20, visible: true });
    const designId = await lib.saveDesign(d1, org, { name: "Logo", stabilizer: "cutaway", hoopId: hoop });
    await lib.addDesignVersion(d1, designId, { designFileKey: "d/a.emb", designFileName: "a.emb", designFileExt: "emb", machineFileKey: "d/a.dst", machineFileName: "a.dst", machineFileExt: "dst", threadColors: [] });
    await lib.setProductDesign(d1, org, "cap", designId);
    await lib.setBlankLink(d1, org, "cap", "", "OSFA", capBlank, "Navy", "OSFA");
    await lib.setBlankLink(d1, org, "cap", "Navy", "OSFA", capBlank, "Navy", "OSFA");
    await lib.createProduct(d1, org, { productId: "tee", type: "shirt", name: "Tee", pricingMode: "sized", sizePricing: { M: 18 }, visible: true, noDesignNeeded: true, configurable: true, garmentColors: ["Navy"] });
    await lib.setBlankLink(d1, org, "tee", "Navy", "M", teeBlank, "Navy", "M");
  }
  await lib.createProduct(d1, "club", { productId: "badge", type: "cap", name: "Badge", pricingMode: "flat", flatPrice: 5, visible: true });
  { const dId = await lib.saveDesign(d1, "club", { name: "Badge logo", stabilizer: "cutaway", hoopId: hoop });
    await lib.addDesignVersion(d1, dId, { designFileKey: "d/b.emb", designFileName: "b.emb", designFileExt: "emb", machineFileKey: "d/b.dst", machineFileName: "b.dst", machineFileExt: "dst", threadColors: [] });
    await lib.setProductDesign(d1, "club", "badge", dId); }
  d1._raw.run("UPDATE products SET noBlankNeeded=1 WHERE orgId='club' AND productId='badge'");
  const loc = (decoration, extra) => Object.assign({ location: "front", label: "Front", kind: decoration === "embroidery" ? "embroidery" : "transfer", decoration, graphicName: "Crest", ink: "", imageUrl: "", thumbUrl: "" }, extra);
  async function mk(id, o) {
    const product = o.product || "tee";
    const item = { productId: product, name: o.itemName || (product === "tee" ? "Tee" : product === "badge" ? "Badge" : "Cap"), type: product === "tee" ? "shirt" : "cap", size: product === "tee" ? "M" : "OSFA", qty: o.qty || (product === "tee" ? 2 : 1), unitPrice: 20 };
    await lib.insertOrder(d1, { orderId: id, orgId: o.org || "club", customerName: o.cust, contact: id + "@example.com", placedAt: o.placed }, [item]);
    const cfg = o.decos ? JSON.stringify({ garmentColor: o.color || "Navy", locations: o.decos.map(k => loc(k, o.locExtra || {})) }) : "";
    d1._raw.run("UPDATE order_items SET configJson=? WHERE orderId=?", [cfg, id]);
    d1._raw.run("UPDATE orders SET paid=1, dueDate=?, blankReceivedAt=?, designApprovedAt='2020-01-01', digitizingCompleteAt='2020-01-01' WHERE orderId=?", [o.due || null, o.blank === false ? null : "2020-01-02T00:00:00Z", id]);
    if (o.xfer) d1._raw.run("UPDATE order_items SET transferReceivedAt='2020-01-03T00:00:00Z' WHERE orderId=?", [id]);
    if (o.started) d1._raw.run("UPDATE order_items SET decStartedAt='2020-01-03T00:00:00Z' WHERE orderId=?", [id]);
  }
  await mk("E1", { product: "cap", cust: "Zed Embroider", placed: "2020-01-02T00:00:00Z", due: "2099-01-20" });
  await mk("E2", { product: "cap", org: "band", cust: "Amy Embroider", placed: "2020-01-01T00:00:00Z" });
  await mk("E3", { product: "badge", cust: "Ivy NoBlank", placed: "2020-01-12T00:00:00Z", due: "2099-01-25" });
  await mk("T1", { cust: "Bob Transfer", placed: "2020-01-05T00:00:00Z", due: "2099-01-10", decos: ["dtf"], xfer: true });
  await mk("T2", { org: "band", cust: "Cat <i>Dtf</i>", placed: "2020-01-04T00:00:00Z", due: "2099-01-08", decos: ["dtf"] });
  await mk("T3", { product: "cap", cust: "Hal Both", placed: "2020-01-09T00:00:00Z", due: "2099-01-12", decos: ["dtf"], xfer: true });
  await mk("S1", { cust: "Dan Screen", placed: "2020-01-06T00:00:00Z", due: "2099-01-05", decos: ["screenprint"] });
  await mk("S2", { org: "band", cust: "Eve Screen", placed: "2020-01-07T00:00:00Z", due: "2099-01-02", decos: ["screenprint"], blank: false });
  await mk("V1", { cust: "Fay Vinyl", placed: "2020-01-08T00:00:00Z", decos: ["vinyl"], started: true, color: "Red" });
  await mk("G1", { product: "cap", org: "band", cust: "Gus Both", placed: "2020-01-10T00:00:00Z", due: "2099-01-15", decos: ["dtg"] });
  await mk("M1", { cust: "Mia Sub", placed: "2020-01-11T00:00:00Z", due: "2099-01-03", decos: ["sublimation"] });

  // ---- The page -------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js");
  const sent = [], toasts = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  let scripted = [];
  class Loader extends ResourceLoader { fetch(url) { if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) console.error(e); });
  let inflight = 0;
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.scrollTo = () => {};
      autoConfirm(win, () => true);
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(b); inflight++;
        try {
          const i = scripted.findIndex(x => x.action === b.action);
          if (i >= 0) { const x = scripted.splice(i, 1)[0]; return reply(x.status || 200, x.body); }
          const x = await call(b);
          return reply(x.status, x.body);
        } finally { inflight--; }
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC");');
  w.eval("adminOrgs = " + JSON.stringify([{ orgId: "club", name: "Example Club" }, { orgId: "band", name: "Example <b>Boosters</b>" }]) + ";");
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const app = d.getElementById("app");
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const of = (action) => sent.filter(b => b.action === action).map(b => { const c = Object.assign({}, b); delete c.key; return c; });
  const signIn = (role) => { globalThis.__role378 = role; w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(api.effectivePermissions(role))}; adminAreas = ${JSON.stringify(api.PERMISSION_AREAS)};`); };
  const custom = (fns) => ({ key: "custom", name: "Front desk", rank: 10, builtIn: false, locked: false, permissions: { menus: {}, items: {}, fns, costsApart: true } });
  const who = {};
  const NAMES = { "Zed Embroider": "E1", "Amy Embroider": "E2", "Bob Transfer": "T1", "Cat <i>Dtf</i>": "T2", "Hal Both": "T3", "Ivy NoBlank": "E3", "Dan Screen": "S1", "Eve Screen": "S2", "Fay Vinyl": "V1", "Gus Both": "G1", "Mia Sub": "M1" };
  const cardLabel = (el) => { const t = text(el); const k = Object.keys(NAMES).find(n => t.includes(n)); return (k ? NAMES[k] : "?") + "/" + (el.classList.contains("run-job-card") ? "embroidery" : el.dataset.type); };
  const cards = () => qa(".run-job-card, .ro-card").map(cardLabel);
  const filters = () => qa(".ro-filter").map(b => text(b));

  const ALL = ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"];
  const DUE = "M1/sublimation S1/screenprint T1/dtf T3/embroidery T3/dtf G1/embroidery G1/dtg E1/embroidery E3/embroidery E2/embroidery V1/vinyl S2/screenprint T2/dtf";
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const store = (k, v) => { try { if (v === undefined) w.localStorage.removeItem(k); else w.localStorage.setItem(k, v); } catch (e) { /* none */ } };
  const prefs = (type, sort) => { store("odd_runorder_type", type); store("odd_runorder_sort", sort); };
  const load = async (type, sort) => { prefs(type, sort); sent.length = 0; toasts.length = 0; await w.renderRunOrder(app); await idle(); };
  const types = (list) => d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('decorationTypes', ?)", [JSON.stringify(list)]);
  const sql = (s, ...a) => d1._raw.run(s, a);
  const card = (id, kind) => qa(".run-job-card, .ro-card").find(el => cardLabel(el) === id + "/" + kind);
  const btn = (el, sel) => el ? el.querySelector(sel) : null;
  const onFilter = () => qa(".ro-filter.on").map(b => b.dataset.type).join();
  const admin = api.DEFAULT_ROLES.admin;
  signIn(admin);
  types(ALL);

  console.log("=== The menu: one Run Order, on the desktop row and in the phone sheet ===");
  w.renderAdminNav();
  const navBtns = (root) => [...root.querySelectorAll("button")].map(b => text(b));
  ok("the desktop menu row has exactly one Run Order button", navBtns(q("#adminNav .admin-nav-row")).filter(t => t === "Run Order").length === 1 && qa('#adminNav .admin-nav-row > button[data-h="runorder"]').length === 1);
  ok("the phone sheet has exactly one Run Order button, in its top list", qa('#adminNav .admin-nav-sheet-top button[data-h="runorder"]').length === 1 && navBtns(q("#adminNav .admin-nav-sheet-top")).filter(t => t === "Run Order").length === 1);
  ok("there is no Run Transfer Sheets button anywhere in the menu or the sheet", !/Run Transfer Sheets/.test(text(q("#adminNav"))) && !q('#adminNav [data-h="runtransfer"]'));
  signIn(custom({ "transfer.queue": "read" }));
  w.renderAdminNav();
  ok("a role with only the transfer queue still gets the one Run Order button (row and sheet)", qa('#adminNav [data-h="runorder"]').length === 2 && !q('#adminNav [data-h="runtransfer"]'));
  signIn(custom({ "run.queue": "read", "run.runs": "edit" }));
  w.renderAdminNav();
  ok("a role with only the production queue gets it too", qa('#adminNav [data-h="runorder"]').length === 2);
  signIn(custom({ "home.counts": "read" }));
  w.renderAdminNav();
  ok("a role with neither queue gets no Run Order button, and the page is not one it can open", qa('#adminNav [data-h="runorder"]').length === 0 && w.adminCanOpen_("runorder") === false && w.adminCanOpen_("runtransfer") === false);
  signIn(custom({ "transfer.queue": "read" }));
  ok("#runtransfer is open to a transfer-queue role, and #runorder too", w.adminCanOpen_("runtransfer") === true && w.adminCanOpen_("runorder") === true);
  signIn(admin);

  console.log("\n=== #runtransfer opens the Run order with the DTF filter on ===");
  prefs("all", "due");
  w.location.hash = "#runtransfer";
  ok("the old address draws the one page and keeps its address as #runorder", await wait(() => !!q("#roBody .ro-card") && w.location.hash === "#runorder"));
  await idle();
  ok("the DTF button is the one that is on", onFilter() === "dtf");
  ok("only DTF cards are listed", same(cards(), ["T1/dtf", "T3/dtf", "T2/dtf"]));
  ok("the choice is remembered as DTF", w.localStorage.getItem("odd_runorder_type") === "dtf");
  ok("the page is titled Run Order", /Run Order/.test(d.title) && /Run Order/.test(text(q("#app h1, #app .admin-page-head, #app"))));
  ok("renderRunTransfer is the same page with the DTF filter", await (async () => { prefs("all", "due"); await w.renderRunTransfer(app); return onFilter() === "dtf" && !!q("#roBody") && !!q("#roBar"); })());

  console.log("\n=== The filter buttons ===");
  await load("all", "due");
  ok("All first, then one button per type with its count", same(filters(), ["All (13)", "Embroidery (5)", "DTF (3)", "Screen print (2)", "Vinyl (1)", "DTG (1)", "Sublimation (1)"]));
  ok("All is on by default and every card of every type is listed", onFilter() === "all" && same(cards(), DUE.split(" ")));
  ok("the buttons say which one is pressed", qa(".ro-filter").every(b => b.getAttribute("aria-pressed") === String(b.classList.contains("on"))) && q('.ro-filter[data-type="all"]').getAttribute("aria-pressed") === "true");
  ok("the buttons sit in a group named Type of work", q(".ro-filters").getAttribute("role") === "group" && q(".ro-filters").getAttribute("aria-label") === "Type of work");
  sent.length = 0;
  q('.ro-filter[data-type="screenprint"]').click();
  ok("choosing Screen print lists only its cards, due date first, without asking the server again", same(cards(), ["S1/screenprint", "S2/screenprint"]) && onFilter() === "screenprint" && sent.length === 0);
  ok("…and remembers the choice (odd_runorder_type)", w.localStorage.getItem("odd_runorder_type") === "screenprint");
  q('.ro-filter[data-type="embroidery"]').click();
  ok("Embroidery lists the embroidery job cards", same(cards(), ["T3/embroidery", "G1/embroidery", "E1/embroidery", "E3/embroidery", "E2/embroidery"]));
  q('.ro-filter[data-type="all"]').click();
  ok("All brings every card back and is remembered", same(cards(), DUE.split(" ")) && w.localStorage.getItem("odd_runorder_type") === "all");
  await load("vinyl", "due");
  ok("a remembered type is on when the page opens again", onFilter() === "vinyl" && same(cards(), ["V1/vinyl"]));
  await load("nonsense", "due");
  ok("a remembered value that is not a type falls back to All", onFilter() === "all" && cards().length === 13);
  await load(undefined, "due");
  ok("nothing remembered means All", onFilter() === "all");

  console.log("\n=== A switched-off type, and types nobody uses ===");
  types(["embroidery", "dtf", "screenprint", "dtg"]);
  await load("all", "due");
  ok("a switched-off type that still has cards is a button marked (switched off), with its count", same(filters(), ["All (13)", "Embroidery (5)", "DTF (3)", "Screen print (2)", "Vinyl (switched off) (1)", "DTG (1)", "Sublimation (switched off) (1)"]));
  ok("its cards are still listed, each marked (switched off)", text(card("V1", "vinyl")).includes("Vinyl (switched off)") && text(card("M1", "sublimation")).includes("Sublimation (switched off)") && !/switched off/.test(text(card("S1", "screenprint"))));
  q('.ro-filter[data-type="vinyl"]').click();
  ok("choosing it lists those cards", same(cards(), ["V1/vinyl"]));
  sql("UPDATE orders SET voidedAt='2020-02-01T00:00:00Z' WHERE orderId IN ('V1','M1')");
  await load("all", "due");
  ok("a switched-off type with no cards has no button", same(filters(), ["All (11)", "Embroidery (5)", "DTF (3)", "Screen print (2)", "DTG (1)"]));
  await load("sublimation", "due");
  ok("a remembered type that has no button falls back to All", onFilter() === "all" && cards().length === 11);
  types(["embroidery", "dtf", "screenprint", "vinyl", "dtg"]);
  await load("all", "due");
  ok("a type that is on shows even with no cards, with a zero count", filters().includes("Vinyl (0)") && !filters().some(f => /Sublimation/.test(f)));
  q('.ro-filter[data-type="vinyl"]').click();
  ok("choosing it says there is nothing to run for it", same(cards(), []) && text(q("#roBody .ro-empty")) === "Nothing to run for Vinyl.");
  sql("UPDATE orders SET voidedAt=NULL WHERE orderId IN ('V1','M1')");
  types(["dtf"]);
  await load("all", "due");
  ok("embroidery switched off with embroidery cards still there is a marked button, and its cards say so", filters()[1] === "Embroidery (switched off) (5)" && text(card("E1", "embroidery")).includes("Embroidery (switched off)"));
  types(ALL);

  console.log("\n=== Nothing to run ===");
  sql("UPDATE orders SET voidedAt='2020-02-01T00:00:00Z'");
  await load("all", "due");
  ok("with nothing to run, All says so in words", cards().length === 0 && /^Nothing to run — every paid order with its blanks received and its design ready is already made\.$/.test(text(q("#roBody .ro-empty"))) && filters()[0] === "All (0)");
  ok("…and no Gang sheet button is offered when there are no DTF cards", !q("#rtGang"));
  sql("UPDATE orders SET voidedAt=NULL");

  console.log("\n=== Order by ===");
  await load("all", undefined);
  ok("Order by offers Due date, Order date, Customer / shop, Type and Blank", same([...q("#roSort").options].map(o => o.textContent), ["Due date", "Order date", "Customer / shop", "Type", "Blank"]) && same([...q("#roSort").options].map(o => o.value), ["due", "order", "customer", "type", "blank"]));
  ok("with nothing remembered it is Due date: soonest due first, none last, then order date; waiting cards after the ready ones",
    q("#roSort").value === "due" && same(cards(), DUE.split(" ")));
  sent.length = 0;
  q("#roSort").value = "order"; q("#roSort").dispatchEvent(new w.Event("change"));
  ok("Order date: oldest order first (ready cards, then the waiting ones), no server call", same(cards(), "E2/embroidery E1/embroidery T1/dtf S1/screenprint V1/vinyl T3/embroidery T3/dtf G1/embroidery G1/dtg M1/sublimation E3/embroidery T2/dtf S2/screenprint".split(" ")) && sent.length === 0);
  ok("…and the choice is remembered (odd_runorder_sort)", w.localStorage.getItem("odd_runorder_sort") === "order");
  q("#roSort").value = "customer"; q("#roSort").dispatchEvent(new w.Event("change"));
  ok("Customer / shop: by shop name, then customer (a name with markup in it sorts as the text it is)", same(cards(), "E2/embroidery G1/embroidery G1/dtg T1/dtf S1/screenprint V1/vinyl T3/embroidery T3/dtf E3/embroidery M1/sublimation E1/embroidery T2/dtf S2/screenprint".split(" ")));
  q("#roSort").value = "type"; q("#roSort").dispatchEvent(new w.Event("change"));
  ok("Type: embroidery, DTF, screen print, vinyl, DTG, sublimation, each by due date", same(cards(), "T3/embroidery G1/embroidery E1/embroidery E3/embroidery E2/embroidery T1/dtf T3/dtf S1/screenprint V1/vinyl G1/dtg M1/sublimation T2/dtf S2/screenprint".split(" ")));
  ok("Due date, Order date, Customer and Type are flat lists with no headings", qa("#roBody h2").length === 0);
  q("#roSort").value = "blank"; q("#roSort").dispatchEvent(new w.Event("change"));
  ok("Blank: grouped with headings — no blank needed, nothing linked, then the blank types (a DTF or other-type card under its blank's type, not a bare Blanks heading)", same(qa("#roBody h2").map(text), ["No blank", "Unlinked", "cap", "shirt"]));
  ok("…each group by blank and size, cards by due date, waiting after ready within a group", same(cards(), "E3/embroidery V1/vinyl T3/embroidery T3/dtf G1/embroidery G1/dtg E1/embroidery E2/embroidery M1/sublimation S1/screenprint T1/dtf S2/screenprint T2/dtf".split(" ")));
  ok("…with a line for each blank and size", same(qa("#roBody h2 ~ div > div:first-child").map(text), ["No blank needed — OSFA", "No blank linked — M", "Cap 112 — Navy — OSFA", "Tee 5000 — Navy — M"]));
  ok("…the choice is remembered", w.localStorage.getItem("odd_runorder_sort") === "blank");
  await load("all", "blank");
  ok("a remembered Order by is selected when the page opens again, and draws the headings", q("#roSort").value === "blank" && qa("#roBody h2").length === 4);
  await load("all", "bogus");
  ok("a remembered Order by that is not one of them falls back to Due date", q("#roSort").value === "due" && same(cards(), DUE.split(" ")));
  q('.ro-filter[data-type="dtf"]').click();
  q("#roSort").value = "type"; q("#roSort").dispatchEvent(new w.Event("change"));
  ok("the type buttons and Order by work together", same(cards(), ["T1/dtf", "T3/dtf", "T2/dtf"]) && onFilter() === "dtf");

  console.log("\n=== Ready cards first, waiting cards greyed with what they wait on ===");
  await load("all", "due");
  ok("the waiting cards come after every ready card", same(cards().slice(-2), ["S2/screenprint", "T2/dtf"]) && qa(".ro-card-waiting").length === 2 && qa(".ro-card-ready").length === 6);
  ok("a printed card without its blank says Waiting on blank and offers nothing to press", /Waiting on blank/.test(text(card("S2", "screenprint"))) && !btn(card("S2", "screenprint"), ".roDecStart, .roDecMake, .roDecUndo"));
  ok("a DTF card without its transfers says Waiting on transfers and offers Mark transfer received, not Mark made", /Waiting on transfers/.test(text(card("T2", "dtf"))) && !/blank and/.test(text(card("T2", "dtf"))) &&
    text(btn(card("T2", "dtf"), ".rtRecv")) === "Mark transfer received" && !btn(card("T2", "dtf"), ".rtMake, .rtApply"));
  ok("ready cards say nothing about waiting", !/Waiting on/.test(text(card("S1", "screenprint"))) && !/Waiting on/.test(text(card("T1", "dtf"))));
  sql("UPDATE orders SET blankReceivedAt=NULL WHERE orderId IN ('T1','T2')");
  await load("all", "due");
  ok("a DTF card short of both says Waiting on blank and transfers", /Waiting on blank and transfers/.test(text(card("T2", "dtf"))));
  ok("a DTF card with its transfers but no blank says Waiting on blank, with no Mark made and no Mark transfer received", /Waiting on blank/.test(text(card("T1", "dtf"))) && !/Waiting on (transfers|blank and)/.test(text(card("T1", "dtf"))) && !btn(card("T1", "dtf"), ".rtMake, .rtRecv") && card("T1", "dtf").classList.contains("ro-card-waiting"));
  sql("UPDATE orders SET blankReceivedAt='2020-01-02T00:00:00Z' WHERE orderId IN ('T1','T2')");

  console.log("\n=== Embroidery job cards still show their detail ===");
  await load("all", "due");
  ok("the cards sit in a box that keeps its scroll by name", q("#roBody").getAttribute("data-keep-scroll") === "runorder" && w.location.hash === "#runorder");
  ok("one getRunQueue call, then the machines, hoops, threads, runs and abort reasons for the embroidery cards", of("getRunQueue").length === 1 && ["listMachines", "listHoops", "listThreads", "listActiveRuns", "listAbortReasons"].every(a => of(a).length === 1));
  const e1 = card("E1", "embroidery");
  ok("an embroidery card names its design, shop, customer, item and due date", /Logo/.test(text(e1)) && /Example Club · Zed Embroider/.test(text(e1)) && /Cap \(OSFA\)/.test(text(e1)) && /Due 2099-01-20/.test(text(e1)));
  ok("…its type chip, stabilizer, hoop and needle line", !!btn(e1, ".ro-chip.ro-t-embroidery") && text(btn(e1, ".ro-chip")) === "Embroidery" && /Stabilizer: cutaway/.test(text(e1)) && /Hoop: Cap Frame/.test(text(e1)) && /Needle:/.test(text(e1)));
  ok("…a machine to pick, Start job and Mark done (no timing), each tagged with what it needs", !!btn(e1, ".run-machine-select") && text(btn(e1, ".run-start-btn")) === "Start job" && btn(e1, ".run-start-btn").dataset.need === "run.runs:edit" &&
    /Mark done \(no timing\)/.test(text(btn(e1, ".run-btn"))) && btn(e1, ".run-btn").dataset.need === "run.markMade:edit");
  ok("a card with no blank needed says so on its needle line", /made without a blank/.test(text(card("E3", "embroidery"))));
  ok("an embroidered line that also has a transfer says its DTF card is on this page", /Also needs a transfer pressed: Crest — its DTF card is on this page \(show DTF\)/.test(text(card("T3", "embroidery"))) && !/Also needs/.test(text(e1)));
  q('.run-job-card a[href="#runtransfer"]').click();
  ok("its show DTF link opens this page with the DTF filter on", await wait(() => onFilter() === "dtf"));
  await idle();

  console.log("\n=== DTF cards ===");
  await load("all", "due");
  const t1 = card("T1", "dtf"), t2 = card("T2", "dtf"), t3 = card("T3", "dtf");
  ok("a DTF card shows its chip, shop, customer, quantity, item, garment colour and blank", text(btn(t1, ".ro-chip")) === "DTF" && /Example Club · Bob Transfer · Qty 2/.test(text(t1)) && /Tee \(M\) · Navy · Blank: Tee 5000 \/ Navy/.test(text(t1)));
  ok("…and a tile for each location with its graphic", /Front\s*Crest/.test(text(t1)));
  ok("a ready line that is not embroidered offers Mark made", text(btn(t1, ".rtMake")) === "Mark made" && !btn(t1, ".rtApply") && !btn(t1, ".rtRecv") && t1.classList.contains("ro-card-dtf"));
  ok("a ready line that is also embroidered offers Mark transfers applied and says its embroidery is still to run", text(btn(t3, ".rtApply")) === "Mark transfers applied" && !btn(t3, ".rtMake") && /Also embroidered — embroidery still to run \(its Embroidery card is on this page\)/.test(text(t3)));
  ok("a line whose transfers are not in hand offers Mark transfer received", text(btn(t2, ".rtRecv")) === "Mark transfer received");
  ok("the three DTF buttons need transfer.mark and carry the line's ids", [[t1, ".rtMake"], [t3, ".rtApply"], [t2, ".rtRecv"]].every(([c, sel]) => btn(c, sel).dataset.need === "transfer.mark:edit" && btn(c, sel).dataset.org && /^\d+$/.test(btn(c, sel).dataset.item) && /^[A-Z]\d$/.test(btn(c, sel).dataset.order)));
  ok("Gang sheet totals is in the bar for All", !!q("#rtGang") && q("#rtGang").dataset.need === "transfer.queue:read");
  q("#rtGang").click();
  ok("it opens the totals for what still has to be printed", await wait(() => /Gang sheet totals/.test(text(q(".admin-modal")))) && of("getGangSheet").length === 1 && /Crest/.test(text(q(".admin-modal"))) && !!q("#rtGangCsv"));
  const csv = [];
  w.downloadCsv_ = (name, rows, cols) => csv.push({ name, rows, cols });
  q("#rtGangCsv").click();
  ok("…its Download CSV saves the rows with Graphic, Ink, Size and Count", csv.length === 1 && /^odd-gang-sheet-\d{4}-\d\d-\d\d\.csv$/.test(csv[0].name) && csv[0].rows.length === 1 && csv[0].rows[0].graphic === "Crest" && csv[0].rows[0].count === 2 && same(csv[0].cols.map(c => c[1]), ["Graphic", "Ink", "Size", "Count"]));
  q(".admin-modal [data-modal-close]").click();
  ok("Gang sheet totals shows for the DTF filter", (q('.ro-filter[data-type="dtf"]').click(), !!q("#rtGang")));
  ok("…and not for Embroidery, Screen print, Vinyl, DTG or Sublimation", ["embroidery", "screenprint", "vinyl", "dtg", "sublimation"].every(t => (q('.ro-filter[data-type="' + t + '"]').click(), !q("#rtGang"))));

  console.log("\n=== Cards of the other types ===");
  await load("all", "due");
  const s1 = card("S1", "screenprint"), v1 = card("V1", "vinyl"), g1 = card("G1", "dtg"), m1 = card("M1", "sublimation");
  ok("a printed card shows its chip, shop, customer, quantity, item, blank and locations", text(btn(s1, ".ro-chip")) === "Screen print" && /Example Club · Dan Screen · Qty 2/.test(text(s1)) && /Tee \(M\) · Navy · Blank: Tee 5000 \/ Navy/.test(text(s1)) && /Front\s*Crest/.test(text(s1)) && s1.classList.contains("ro-card-other"));
  ok("a card not started offers Start and Mark made, tagged run.markMade", text(btn(s1, ".roDecStart")) === "Start" && text(btn(s1, ".roDecMake")) === "Mark made" && !btn(s1, ".ro-started") && !btn(s1, ".roDecUndo") &&
    [".roDecStart", ".roDecMake"].every(sel => btn(s1, sel).dataset.need === "run.markMade:edit" && btn(s1, sel).dataset.type === "screenprint" && /^\d+$/.test(btn(s1, sel).dataset.item) && btn(s1, sel).dataset.order === "S1" && btn(s1, sel).dataset.org === "club"));
  ok("a started card shows Started and Undo instead of Start, and still offers Mark made", text(btn(v1, ".ro-started")) === "● Started" && text(btn(v1, ".roDecUndo")) === "Undo" && !btn(v1, ".roDecStart") && !!btn(v1, ".roDecMake") && btn(v1, ".roDecUndo").dataset.need === "run.markMade:edit");
  ok("a card with no blank linked says so", /Blank: — none linked —/.test(text(v1)));
  ok("a line that is also embroidered says Mark done and that its embroidery is still to run", text(btn(g1, ".roDecMake")) === "Mark done" && /Also embroidered — embroidery still to run \(its Embroidery card is on this page\)\. Marking this decoration done here doesn't make the piece/.test(text(g1)) && !!btn(g1, ".roDecStart"));
  ok("every other-type chip is its type's name", text(btn(m1, ".ro-chip")) === "Sublimation" && text(btn(g1, ".ro-chip")) === "DTG" && text(btn(v1, ".ro-chip")) === "Vinyl");
  ok("customer names, shop names and locations are shown as text, never as markup", (() => { const c = card("T2", "dtf"); return /Cat <i>Dtf<\/i>/.test(text(c)) && /Example <b>Boosters<\/b>/.test(text(c)) && !c.querySelector("i, b"); })() && !q("#roBody .ro-card i"));

  console.log("\n=== Paid, not yet run ===");
  const paidRows = () => qa("#roBody details tbody tr");
  ok("the table has a Type column and counts every paid order not yet run", same(qa("#roBody details thead th").map(text), ["Due", "Placed", "Customer", "Items", "Type", "Blanks"]) && /Paid, not yet run — by due date \(11\)/.test(text(q("#roBody details summary"))) && paidRows().length === 11);
  const rowOf = (id) => paidRows().find(tr => text(tr.querySelector("a[href^=\"#orders\"]")) === id);
  ok("each row's Type column names its work", text(rowOf("S2").querySelector(".ro-paid-types")) === "Screen print" && text(rowOf("T1").querySelector(".ro-paid-types")) === "DTF" && text(rowOf("E1").querySelector(".ro-paid-types")) === "Embroidery" && text(rowOf("V1").querySelector(".ro-paid-types")) === "Vinyl");
  ok("a name with markup in it is shown as text in the table", /Cat <i>Dtf<\/i>/.test(text(rowOf("T2"))) && !rowOf("T2").querySelector("i"));
  q('.ro-filter[data-type="dtf"]').click();
  ok("choosing a type keeps the orders that have that type", paidRows().length === 3 && /\(3\)/.test(text(q("#roBody details summary"))));
  q('.ro-filter[data-type="screenprint"]').click();
  ok("…whatever the type", paidRows().length === 2 && paidRows().every(tr => /Screen print/.test(text(tr.querySelector(".ro-paid-types")))));
  q('.ro-filter[data-type="all"]').click();
  ok("All shows them all again", paidRows().length === 11);

  console.log("\n=== A server with no types, no other cards and no Type on the paid rows ===");
  const oldRow = { orderId: "X1", orgId: "club", orgName: "Example Club", customerName: "Old Shape", placedAt: "2020-01-01T00:00:00Z", dueDate: "", items: [{ name: "Tee", qty: 1, size: "M" }], needsBlanks: true, blankOrdered: false, blankReceived: false, blanksInStock: false };
  scripted.push({ action: "getRunQueue", body: { status: "ok", embroidery: { queue: [] }, transfers: { ready: [], waiting: [] }, paidUnrun: [oldRow] } });
  await load("dtf", "due");
  ok("with no list of types it offers Embroidery and DTF only, and no Gang sheet for an empty DTF list", same(filters(), ["All (0)", "Embroidery (0)", "DTF (0)"]) && !q("#rtGang") && text(q("#roBody .ro-empty")) === "Nothing to run for DTF.");
  ok("a paid row with no types has an empty Type cell and shows under any filter", paidRows().length === 1 && text(paidRows()[0].querySelector(".ro-paid-types")) === "");
  scripted.push({ action: "getRunQueue", body: { status: "error", message: "The queue is <b>unreadable</b>" } });
  await load("all", "due");
  ok("a failed load shows its message as text in the page", text(q("#roBody")) === "The queue is <b>unreadable</b>" && !q("#roBody b"));

  console.log("\n=== A browser that will not keep the choices ===");
  await load("all", "due"); q('.ro-filter[data-type="all"]').click(); q("#roSort").value = "due"; q("#roSort").dispatchEvent(new w.Event("change"));
  const storageWas = Object.getOwnPropertyDescriptor(w, "localStorage");
  Object.defineProperty(w, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  sent.length = 0;
  await w.renderRunOrder(app); await idle();
  ok("the page still opens, on All and Due date", onFilter() === "all" && q("#roSort").value === "due" && cards().length === 13);
  q('.ro-filter[data-type="dtf"]').click();
  q("#roSort").value = "customer"; q("#roSort").dispatchEvent(new w.Event("change"));
  ok("choosing a type and an order still works for this visit", onFilter() === "dtf" && same(cards(), ["T1/dtf", "T3/dtf", "T2/dtf"]) && q("#roSort").value === "customer");
  await w.renderRunOrder(app); await idle();
  ok("…and the page remembers them while it stays open, though the browser keeps nothing", onFilter() === "dtf" && q("#roSort").value === "customer");
  q('.ro-filter[data-type="all"]').click();
  await w.renderRunTransfer(app); await idle();
  ok("#runtransfer still opens the DTF filter when nothing can be kept", onFilter() === "dtf");
  Object.defineProperty(w, "localStorage", storageWas);
  ok("(storage is back)", (() => { try { w.localStorage.setItem("odd_t378", "1"); w.localStorage.removeItem("odd_t378"); return true; } catch (e) { return false; } })());

  console.log("\n=== Who sees which cards ===");
  const transferOnly = custom({ "transfer.queue": "read", "transfer.mark": "edit" });
  signIn(transferOnly);
  await load("all", "due");
  ok("a role with only the transfer queue sees DTF and the printed types, no embroidery", same(cards(), ["M1/sublimation", "S1/screenprint", "T1/dtf", "T3/dtf", "G1/dtg", "V1/vinyl", "S2/screenprint", "T2/dtf"]) &&
    same(filters(), ["All (8)", "DTF (3)", "Screen print (2)", "Vinyl (1)", "DTG (1)", "Sublimation (1)"]));
  ok("…the page never asks for machines, hoops, threads or runs", ["listMachines", "listHoops", "listThreads", "listActiveRuns", "listAbortReasons"].every(a => of(a).length === 0) && of("getRunQueue").length === 1);
  ok("…it has the DTF buttons and Gang sheet totals, but not the Start and Mark made of the printed cards", !!q("#rtGang") && !btn(card("T1", "dtf"), ".rtMake").hasAttribute("data-perm-off") && !btn(card("T2", "dtf"), ".rtRecv").hasAttribute("data-perm-off") &&
    btn(card("S1", "screenprint"), ".roDecStart").hasAttribute("data-perm-off") && btn(card("S1", "screenprint"), ".roDecMake").hasAttribute("data-perm-off"));
  let r = await call({ action: "getRunQueue" });
  ok("the server's answer to it leaves out the embroidery queue and counts none", r.status === 200 && r.body.embroidery === undefined && r.body.counts.embroidery === 0 && r.body.counts.dtf === 3 && !!r.body.transfers && r.body.waitingOnBlanks === undefined && r.body.needleSizes === undefined);
  r = await call({ action: "setDecorationStarted", orderId: "S1", itemId: 1, on: true });
  ok("it can't start a printed line", r.status === 403);
  r = await call({ action: "makeDecoratedLine", orderId: "S1", itemId: 1 });
  ok("…or mark one made", r.status === 403);
  const runOnly = custom({ "run.queue": "read", "run.runs": "edit", "run.markMade": "edit" });
  signIn(runOnly);
  await load("all", "due");
  ok("a role with only the production queue sees embroidery and the printed types, no DTF", same(cards(), ["M1/sublimation", "S1/screenprint", "T3/embroidery", "G1/embroidery", "G1/dtg", "E1/embroidery", "E3/embroidery", "E2/embroidery", "V1/vinyl", "S2/screenprint"]) &&
    same(filters(), ["All (10)", "Embroidery (5)", "Screen print (2)", "Vinyl (1)", "DTG (1)", "Sublimation (1)"]));
  ok("…no Gang sheet totals, and the machines are asked for", !q("#rtGang") && of("listMachines").length === 1 && !qa(".ro-card-dtf").length);
  ok("…and it can Start and Mark made the printed cards", !btn(card("S1", "screenprint"), ".roDecStart").hasAttribute("data-perm-off") && !btn(card("S1", "screenprint"), ".roDecMake").hasAttribute("data-perm-off") && !btn(card("E1", "embroidery"), ".run-start-btn").hasAttribute("data-perm-off"));
  r = await call({ action: "getRunQueue" });
  ok("the server's answer to it leaves out the DTF cards and counts none", r.status === 200 && r.body.transfers === undefined && r.body.counts.dtf === 0 && r.body.counts.embroidery === 5 && Array.isArray(r.body.embroidery));
  r = await call({ action: "setTransferReceived", orderId: "T2", itemId: 1, received: true });
  ok("it can't mark a transfer received", r.status === 403);
  r = await call({ action: "makeTransferLine", orderId: "T1", itemId: 1 });
  ok("…or make a DTF line, or see the gang sheet", r.status === 403 && (await call({ action: "getGangSheet" })).status === 403);
  signIn(custom({ "transfer.queue": "read" }));
  await load("all", "due");
  ok("a role that may only read the transfer queue sees the cards but is not offered the DTF buttons", !!card("T1", "dtf") && btn(card("T1", "dtf"), ".rtMake").hasAttribute("data-perm-off") && btn(card("T2", "dtf"), ".rtRecv").hasAttribute("data-perm-off") && btn(card("T3", "dtf"), ".rtApply").hasAttribute("data-perm-off"));
  signIn(custom({ "run.queue": "read", "run.runs": "edit" }));
  await load("all", "due");
  ok("a role that may run jobs but not mark pieces made sees the embroidery buttons, not the printed cards' Start and Mark made", !!card("S1", "screenprint") && !btn(card("E1", "embroidery"), ".run-start-btn").hasAttribute("data-perm-off") && btn(card("E1", "embroidery"), ".run-btn").hasAttribute("data-perm-off") && btn(card("S1", "screenprint"), ".roDecStart").hasAttribute("data-perm-off") && btn(card("S1", "screenprint"), ".roDecMake").hasAttribute("data-perm-off") && btn(card("V1", "vinyl"), ".roDecUndo").hasAttribute("data-perm-off"));
  signIn(api.DEFAULT_ROLES.production);
  await load("all", "due");
  ok("the built-in Production role sees every kind of card and every button", cards().length === 13 && !!q("#rtGang") && qa("#roBody [data-perm-off]").length === 0);
  signIn(admin);

  console.log("\n=== Buttons on the DTF cards ===");
  let answer = true; const asked = [];
  w.__confirmAnswer = (m) => { asked.push(m); return answer; };
  const isoAt = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v) && !isNaN(Date.parse(v));
  const lastIdle = async () => { await idle(); await pause(30); await idle(); };
  await load("all", "due");
  const body0 = q("#roBody");
  answer = false;
  btn(card("T2", "dtf"), ".rtRecv").click();
  await pause(60);
  ok("Mark transfer received asks first, and answering No sends nothing", asked.pop() === "Mark the transfer for order T2 received?" && of("setTransferReceived").length === 0 && !!btn(card("T2", "dtf"), ".rtRecv"));
  answer = true;
  scripted.push({ action: "setTransferReceived", status: 409, body: { status: "error", message: "That month is closed" } });
  btn(card("T2", "dtf"), ".rtRecv").click();
  await wait(() => of("setTransferReceived").length === 1); await lastIdle();
  ok("a refused Mark transfer received shows the reason and leaves the card waiting", toasts.some(t => t.m === "That month is closed" && t.err) && !!btn(card("T2", "dtf"), ".rtRecv") && of("getRunQueue").length === 1);
  sent.length = 0; toasts.length = 0; asked.length = 0;
  btn(card("T2", "dtf"), ".rtRecv").click();
  await wait(() => of("setTransferReceived").length === 1); await lastIdle();
  const recv = of("setTransferReceived")[0];
  ok("Yes marks the transfer received for that line, with when", recv.received === true && recv.orderId === "T2" && recv.org === "band" && typeof recv.itemId === "number" && isoAt(recv.at));
  ok("…says so, and the page is refreshed in place (same box, no Loading…)", toasts.some(t => t.m === "Transfer received." && !t.err) && of("getRunQueue").length === 1 && q("#roBody") === body0 && !/Loading/.test(text(q("#roBody"))));
  ok("…the card is ready now, with Mark made, and no longer waiting", !!card("T2", "dtf") && !!btn(card("T2", "dtf"), ".rtMake") && !btn(card("T2", "dtf"), ".rtRecv") && !/Waiting on/.test(text(card("T2", "dtf"))) && d1.q("SELECT transferReceivedAt t FROM order_items WHERE orderId='T2'")[0].t !== null);
  sent.length = 0; toasts.length = 0; asked.length = 0;
  scripted.push({ action: "setTransfersApplied", status: 400, body: { status: "error", message: "Line item not found" } });
  btn(card("T3", "dtf"), ".rtApply").click();
  await wait(() => of("setTransfersApplied").length === 1); await lastIdle();
  ok("a refused Mark transfers applied shows the reason and leaves the card", toasts.some(t => t.m === "Line item not found" && t.err) && !!card("T3", "dtf") && of("getRunQueue").length === 0);
  sent.length = 0; toasts.length = 0; asked.length = 0;
  btn(card("T3", "dtf"), ".rtApply").click();
  await wait(() => of("setTransfersApplied").length === 1); await lastIdle();
  const apl = of("setTransfersApplied")[0];
  ok("Mark transfers applied asks, then marks the line applied", asked[0] === "Mark the transfers on order T3 applied?" && apl.applied === true && apl.orderId === "T3" && apl.org === "club" && typeof apl.itemId === "number" && isoAt(apl.at));
  ok("…says so, and the DTF card goes while its embroidery card stays", toasts.some(t => t.m === "Transfers marked applied.") && !card("T3", "dtf") && !!card("T3", "embroidery") && d1.q("SELECT transfersAppliedAt t FROM order_items WHERE orderId='T3'")[0].t !== null);
  sent.length = 0; toasts.length = 0; asked.length = 0;
  scripted.push({ action: "makeTransferLine", status: 409, body: { status: "error", message: "That month is closed" } });
  btn(card("T1", "dtf"), ".rtMake").click();
  await wait(() => of("makeTransferLine").length === 1); await lastIdle();
  ok("a refusal from the server is shown as an error and the card stays", asked[0] === "Mark this line made? Consumes the blank and the transfer applications." && toasts.some(t => t.m === "That month is closed" && t.err) && !!card("T1", "dtf") && of("getRunQueue").length === 0);
  sent.length = 0; toasts.length = 0;
  btn(card("T1", "dtf"), ".rtMake").click();
  await wait(() => of("makeTransferLine").length === 1); await lastIdle();
  const mk1 = of("makeTransferLine")[0];
  ok("Mark made on a line that is not embroidered makes it, with when", mk1.orderId === "T1" && mk1.org === "club" && typeof mk1.itemId === "number" && isoAt(mk1.at));
  ok("…the order was complete, so it says so, and the card is gone", toasts.some(t => t.m === "Order complete.") && !card("T1", "dtf") && Number(d1.q("SELECT manufacturedQty n FROM order_items WHERE orderId='T1'")[0].n) === 2);

  console.log("\n=== Start, Started, Undo and Mark made on the other types ===");
  await load("all", "due");
  const sBody = q("#roBody");
  asked.length = 0;
  btn(card("S1", "screenprint"), ".roDecStart").click();
  await wait(() => of("setDecorationStarted").length === 1); await lastIdle();
  const st = of("setDecorationStarted")[0];
  ok("Start marks that line started, with when, without asking first", st.on === true && st.orderId === "S1" && st.org === "club" && typeof st.itemId === "number" && isoAt(st.at) && asked.length === 0);
  ok("…says Started., and the page is refreshed in place", toasts.some(t => t.m === "Started." && !t.err) && of("getRunQueue").length === 2 && q("#roBody") === sBody);
  ok("…the card now shows Started and Undo instead of Start", text(btn(card("S1", "screenprint"), ".ro-started")) === "● Started" && !!btn(card("S1", "screenprint"), ".roDecUndo") && !btn(card("S1", "screenprint"), ".roDecStart") && d1.q("SELECT decStartedAt t FROM order_items WHERE orderId='S1'")[0].t !== null);
  sent.length = 0; toasts.length = 0;
  btn(card("S1", "screenprint"), ".roDecUndo").click();
  await wait(() => of("setDecorationStarted").length === 1); await lastIdle();
  ok("Undo takes the start back", of("setDecorationStarted")[0].on === false && toasts.some(t => t.m === "Start undone.") && !!btn(card("S1", "screenprint"), ".roDecStart") && !btn(card("S1", "screenprint"), ".ro-started") && d1.q("SELECT decStartedAt t FROM order_items WHERE orderId='S1'")[0].t === null);
  sent.length = 0; toasts.length = 0;
  scripted.push({ action: "setDecorationStarted", status: 400, body: { status: "error", message: "Line item not found" } });
  const startBtn = btn(card("S1", "screenprint"), ".roDecStart");
  startBtn.click();
  await wait(() => of("setDecorationStarted").length === 1); await lastIdle();
  ok("a refused Start shows the reason, leaves the button usable and does not refresh", toasts.some(t => t.m === "Line item not found" && t.err) && startBtn.disabled === false && of("getRunQueue").length === 0 && !!card("S1", "screenprint"));
  sent.length = 0; toasts.length = 0; asked.length = 0;
  answer = false;
  btn(card("S1", "screenprint"), ".roDecMake").click();
  await pause(60);
  ok("Mark made asks first (the blanks come out of stock), and No sends nothing", asked.pop() === "Mark this line made? Consumes the blanks." && of("makeDecoratedLine").length === 0 && !!card("S1", "screenprint"));
  answer = true;
  btn(card("G1", "dtg"), ".roDecMake").click();
  await wait(() => of("makeDecoratedLine").length === 1); await lastIdle();
  const mk2 = of("makeDecoratedLine")[0];
  ok("Mark done on a line that is also embroidered asks in its own words and records only the decoration", asked.pop() === "Mark this decoration done? The piece is made when its embroidery is finished too." && mk2.orderId === "G1" && mk2.org === "band" && isoAt(mk2.at));
  ok("…says Marked done., records only the decoration, and the embroidery card stays", toasts.some(t => t.m === "Marked done.") && !!card("G1", "embroidery") && d1.q("SELECT decMadeAt t FROM order_items WHERE orderId='G1'")[0].t !== null && Number(d1.q("SELECT manufacturedQty n FROM order_items WHERE orderId='G1'")[0].n) === 0);
  ok("…and the marked-done card leaves the Run order at once (its embroidery card stays until the embroidery is finished)", !card("G1", "dtg") && !!card("G1", "embroidery"));
  sent.length = 0; toasts.length = 0; asked.length = 0;
  btn(card("S1", "screenprint"), ".roDecMake").click();
  await wait(() => of("makeDecoratedLine").length === 1); await lastIdle();
  ok("Mark made on a line with no embroidery makes the pieces; the whole order is done, and it says so", asked.pop() === "Mark this line made? Consumes the blanks." && toasts.some(t => t.m === "Order complete.") && !card("S1", "screenprint") && Number(d1.q("SELECT manufacturedQty n FROM order_items WHERE orderId='S1'")[0].n) === 2);
  sent.length = 0; toasts.length = 0;
  scripted.push({ action: "makeDecoratedLine", status: 409, body: { status: "error", message: "That month is closed" } });
  btn(card("M1", "sublimation"), ".roDecMake").click();
  await wait(() => of("makeDecoratedLine").length === 1); await lastIdle();
  ok("a refused Mark made shows the reason and leaves the card", toasts.some(t => t.m === "That month is closed" && t.err) && !!card("M1", "sublimation") && of("getRunQueue").length === 0);
  sent.length = 0; toasts.length = 0;
  btn(card("V1", "vinyl"), ".roDecUndo").click();
  await wait(() => of("setDecorationStarted").length === 1); await lastIdle();
  ok("a card that was already started can be undone too", of("setDecorationStarted")[0].on === false && !!btn(card("V1", "vinyl"), ".roDecStart"));

  console.log("\n=== Gang sheet when nothing is left to print ===");
  await load("dtf", "due");
  q("#rtGang").click();
  ok("it says so when every queued transfer is in hand", await wait(() => /Nothing to print — every queued transfer is in stock or already in hand\./.test(text(q(".admin-modal")))) && !q("#rtGangCsv"));
  q(".admin-modal [data-modal-close]").click();
  scripted.push({ action: "getGangSheet", status: 500, body: { status: "error", message: "Gang sheet is unavailable" } });
  q("#rtGang").click();
  ok("a failure to read it is shown as an error and no window opens", await wait(() => toasts.some(t => t.m === "Gang sheet is unavailable" && t.err)) && !q(".admin-modal"));

  console.log("\n=== The pictures on a card ===");
  const holder = d.createElement("div");
  holder.innerHTML = w.runLocsHtml_([
    { location: "Front", graphicName: "Crest <b>one</b>", ink: "Navy", thumbUrl: "https://img.example.com/t.png" },
    { location: "Back", graphicName: "Reorder", auto: true },
    { location: "Sleeve", custom: true, fileKey: "customer/a.png", fileName: "a.png" },
    { location: "Neck", custom: true, fileKey: "" }]);
  ok("a graphic location shows its picture, place, name and ink; the reorder QR is marked; a name is text, not markup", holder.querySelector('img[src="https://img.example.com/t.png"]') && /Front\s*Crest <b>one<\/b> · Navy/.test(text(holder)) && /Back \(QR\)/.test(text(holder)) && !holder.querySelector("b"));
  ok("a customer's own design shows a private picture to fill in and a Download button; one with no file says how to add it", holder.querySelector('img[data-design-key="customer/a.png"]') && holder.querySelector(".rtDl").dataset.key === "customer/a.png" && /Customer design — no file \(Edit items → Files\)/.test(text(holder)));
  const dls = [];
  w.downloadDesignFile_ = (k) => dls.push(k);
  w.fillDesignThumbs_ = () => {};
  w.wireRunCards_(holder);
  holder.querySelector(".rtDl").click();
  ok("Download asks for that file", same(dls, ["customer/a.png"]));
  ok("a type's chip is its name, marked when switched off, and an unknown type is shown as it is", w.runTypeChip_("dtg", false) === '<span class="ro-chip ro-t-dtg">DTG</span>' && /DTG \(switched off\)/.test(w.runTypeChip_("dtg", true)) && w.runTypeLabel_("laser") === "laser" && w.runTypeLabel_(undefined) === "");

  console.log("\n" + counts().passed + " checks passed, " + counts().failed + " failed");
  process.exit(counts().failed ? 1 : 0);
})().catch((e) => { console.error(e); ok("the test ran to its end", false); process.exit(1); });
