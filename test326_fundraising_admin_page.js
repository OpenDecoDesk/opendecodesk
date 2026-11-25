const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Fundraising for group shops (migrations/0110) in the admin page (public/admin.js), run in jsdom with the real
// orders.js / db.js on sql.js behind fetch:
//   the shop form's Fundraiser section (none / a percent / an amount per piece, the amount, "Supports", "Show on the
//   shop", the help line and the live preview), the page's own refusals, Save sending setOrgFundraiser after
//   updateOrg / createOrg and only when it changed, what is said when that fails, and Copy settings leaving it alone;
//   Reports → Fundraising (#fundraising): who sees it, the dates and their buttons, the shop filter, the per-shop table
//   and totals, the "still owed" and sale-date notes, the per-order table and its links, Export CSV, a slower older
//   answer never drawn over a newer one, the payouts list and a server that can't send it;
//   Record payout…: who gets it, the accounts offered, the amount it starts with, its refusals, the discard question,
//   and the report drawn again;
//   "Raises $x for <group>" on an order (the pill and the Payments window), the audit log's two new summaries, and that
//   nothing typed is read as HTML.
// The page signs in as a built-in role (testlib/roles.js asRole) and the server answers as one (adminAs). Invented
// people and shops only. Sales are dated in 2024 and the report is asked for 2024 by hand; anything about "this year"
// is compared with the page's own today (localToday_, the page told UTC), so nothing depends on the day it runs or
// this machine's time zone.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role326] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role326" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

(async () => {
  globalThis.__role326 = "admin";
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const waits = [];
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const must = async (body) => { const r = await call(body); if (r.status !== 200) throw new Error("seed " + body.action + ": " + JSON.stringify(r.body)); return r.body; };
  const orgRow = (id) => d1.q("SELECT * FROM orgs WHERE orgId = ?", id)[0];

  // ---- What is in the database ----------------------------------------------------------------------------------
  // Four shops: one giving a percent, one an amount per piece (its names written to look like HTML), one whose
  // fundraiser has ended but raised money in 2024, and one that never had one.
  const BAND_NAME = "Example <b>Band</b>", BAND_LABEL = "<i>Band</i> & Parents";
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t'), ('band','band','${BAND_NAME}','t','t'),
    ('old','old','Example Old Shop','t','t'), ('plain','plain','Example Plain','t','t');`);
  await must({ action: "setOrgFundraiser", org: "club", fundraiser: { mode: "percent", percent: 10, label: "Example Boosters", showOnShop: true } });
  await must({ action: "setOrgFundraiser", org: "band", fundraiser: { mode: "perPiece", amount: 2, label: BAND_LABEL, showOnShop: false } });
  // Paid orders, shipped (the default sale date) on fixed days; the lines keep what they raised.
  const order = (id, org, name, placed, shipped, paid, lines) => {
    d1.q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, shippedAt, paid) VALUES (?, ?, ?, ?, ?, ?, ?)", id, org, name, "pat@example.com", placed, shipped, paid);
    for (const l of lines) d1.q("INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, unitPriceCents, lineTotalCents, fundraiserCents) VALUES (?, ?, ?, ?, 'cap', 'OSFA', ?, ?, ?, ?)",
      id, org, l.productId, l.name, l.qty, l.unit, l.qty * l.unit, l.raised);
  };
  const ROBIN = '<img src=x onerror="window.__xss326=1">Robin';
  const FORMULA = "=HYPERLINK(\"http://example.com\")";
  order("CLUB-1", "club", "Pat Example", "2024-02-10T15:00:00.000Z", "2024-02-12T15:00:00.000Z", 1, [{ productId: "cap", name: "Club cap", qty: 2, unit: 2000, raised: 400 }]);
  order("CLUB-2", "club", ROBIN, "2024-05-01T15:00:00.000Z", "2024-05-03T15:00:00.000Z", 1,
    [{ productId: "tee", name: "Club tee", qty: 1, unit: 3000, raised: 300 }, { productId: "__custom__", name: "Custom patch", qty: 1, unit: 1000, raised: 0 }]);
  order("CLUB-3", "club", "Sam Unpaid", "2024-06-01T15:00:00.000Z", "2024-06-02T15:00:00.000Z", 0, [{ productId: "cap", name: "Club cap", qty: 1, unit: 2000, raised: 200 }]);
  order("CLUB-0", "club", "Lee Lastyear", "2023-06-01T15:00:00.000Z", "2023-06-02T15:00:00.000Z", 1, [{ productId: "cap", name: "Club cap", qty: 1, unit: 1000, raised: 100 }]);
  order("BAND-1", "band", FORMULA, "2024-03-01T15:00:00.000Z", "2024-03-01T18:00:00.000Z", 1, [{ productId: "cap", name: "Band cap", qty: 3, unit: 1500, raised: 600 }]);
  order("OLD-1", "old", "Kim Example", "2024-04-01T15:00:00.000Z", "2024-04-02T15:00:00.000Z", 1, [{ productId: "cap", name: "Old cap", qty: 1, unit: 1500, raised: 150 }]);
  order("PLAIN-1", "plain", "Jo Example", "2024-04-01T15:00:00.000Z", "2024-04-02T15:00:00.000Z", 1, [{ productId: "cap", name: "Plain cap", qty: 1, unit: 1500, raised: 0 }]);
  // Payouts already made: $2 to the club's group in March, $1.50 for the old shop (settling it), $10 to the band in
  // 2023 (more than it has raised: it is owed a negative amount).
  d1._raw.run("UPDATE accounts SET active = 0 WHERE id = 3");
  await must({ action: "recordFundraiserPayout", org: "club", amount: 2, date: "2024-03-15", accountId: 1, note: "Check <1042>" });
  await must({ action: "recordFundraiserPayout", org: "old", amount: 1.5, date: "2024-04-20", accountId: 4, note: "" });
  await must({ action: "recordFundraiserPayout", org: "band", amount: 10, date: "2023-12-01", accountId: 1, note: "Early" });

  // ---- The page ---------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js");
  const sent = [], toasts = [], downloads = [];
  let scripted = [];       // [{ action, status, body | throws }]: the next request for that action is answered with this
  let hold = null;         // { action, gate }: the next request for that action waits for gate
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) { if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) console.error(e); });
  let inflight = 0;
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.scrollTo = () => {};
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(b); inflight++;
        try {
          const i = scripted.findIndex(s => s.action === b.action);
          if (i >= 0) { const s = scripted.splice(i, 1)[0]; if (s.throws) throw new Error(s.throws); return reply(s.status || 200, s.body); }
          if (hold && hold.action === b.action) { const h = hold; hold = null; await h.gate; }
          const x = await call(b);
          return reply(x.status, x.body);
        } finally { inflight--; }
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  // Export CSV: the file the page hands the browser (its name and text), instead of a download.
  const blobs = new Map();
  w.URL.createObjectURL = (blob) => { const k = "blob:t/" + blobs.size; blobs.set(k, blob); return k; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({ name: this.download, blob: blobs.get(this.href) }); };
  const blobText = (blob) => new Promise((res) => { const r = new w.FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blob); });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC");');
  const shopList = [{ orgId: "club", name: "Example Club" }, { orgId: "band", name: BAND_NAME }, { orgId: "old", name: "Example Old Shop" }, { orgId: "plain", name: "Example Plain" }];
  w.eval("adminOrgs = " + JSON.stringify(shopList) + ";");
  const loadRegistry = async () => { const r = await call({ action: "listOrgsAdmin" }); w.eval("window._adminOrgRegistry = " + JSON.stringify(r.body.orgs) + ";"); return r.body.orgs; };
  await loadRegistry();
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const id = (s) => d.getElementById(s);
  const app = id("app");
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const reset = () => { sent.length = 0; toasts.length = 0; downloads.length = 0; };
  // (What was sent, without the page's own list-cache bookkeeping, listHeld.)
  const of = (action) => sent.filter(b => b.action === action).map(b => { const c = Object.assign({}, b); delete c.listHeld; return c; });
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const hashNow = () => w.location.hash.replace(/^#\/?/, "");
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const levelsOf = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role]);
  const asRoles = (pageRole, serverRole) => { globalThis.__role326 = serverRole || pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  const signInWith = (perms, serverRole) => { globalThis.__role326 = serverRole || "admin"; w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(perms)}; adminAreas = ${JSON.stringify(roles.PERMISSION_AREAS)};`); };
  const withLevels = (role, changes) => Object.assign({}, levelsOf(role), changes);
  const features = (f) => w.applyFeatures_(f);
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const confirmBox = () => q(".confirm-modal");
  const answer = async (yes) => { await wait(() => confirmBox()); const box = confirmBox(); const info = { message: box.dataset.message, okLabel: box.querySelector("#cmOk").textContent, cancelLabel: box.querySelector("#cmCancel").textContent };
    box.querySelector(yes ? "#cmOk" : "#cmCancel").click(); await wait(() => !confirmBox()); return info; };
  const day = (v) => w.adminDate_(v);
  asRoles("admin");

  // ==============================================================================================================
  console.log("=== The shop form's Fundraiser section ===");
  // ==============================================================================================================
  const reg = (orgId) => w._adminOrgRegistry.find(o => o.orgId === orgId);
  const openForm = (orgId) => { w.renderOrgForm(app, orgId ? reg(orgId) : null); };
  const mode = () => id("orgFrMode"), amount = () => id("orgFrAmount"), label = () => id("orgFrLabel"), showBox = () => id("orgFrShow");
  const preview = () => id("orgFrPreview").textContent;
  const fieldsShown = () => id("orgFrFields").style.display !== "none";
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const setMode = (v) => { mode().value = v; fire(mode(), "change"); };
  const type = (el, v) => { el.value = v; fire(el, "input"); };
  const tick = (el, v) => { el.checked = v; fire(el, "change"); };
  const formErr = () => id("orgFormError") ? id("orgFormError").textContent : "(the form is gone)";
  ok("(listOrgsAdmin gives the form each shop's fundraiser, in dollars and percent)", same(reg("club").fundraiser, { mode: "percent", percent: 10, label: "Example Boosters", showOnShop: true }) &&
    same(reg("band").fundraiser, { mode: "perPiece", amount: 2, label: BAND_LABEL, showOnShop: false }) && reg("plain").fundraiser === null);

  openForm("club");
  const h3s = qa("#app .admin-form h3").map(h => h.textContent.trim());
  ok("the shop's Edit form has a “Fundraiser” section, right after Sales tax and before Payment methods",
    h3s.includes("Fundraiser") && h3s[h3s.indexOf("Fundraiser") - 1] === "Sales tax" && h3s[h3s.indexOf("Fundraiser") + 1] === "Payment methods");
  { const help = id("orgFormFundraiser").previousElementSibling;
    ok("…with its help line: inside your prices, customers pay the same, changes apply to new orders",
      help.classList.contains("admin-note") && /Inside your prices: customers pay the same\. Changes apply to new orders\./.test(help.textContent) && /Reports → Fundraising adds it up/.test(help.textContent)); }
  ok("the choice is labelled “This shop”: has no fundraiser / gives a percent of each item's price / gives a set amount per piece",
    /^This shop/.test(mode().closest("label").textContent.trim()) &&
    same([...mode().options].map(o => o.value + "=" + o.textContent), ["=Has no fundraiser", "percent=Gives a percent of each item's price", "perPiece=Gives a set amount per piece"]));
  ok("a shop giving 10% opens on the percent, filled in: 10, “Example Boosters”, shown on the shop",
    mode().value === "percent" && amount().value === "10" && label().value === "Example Boosters" && showBox().checked === true && fieldsShown());
  ok("…the amount box is labelled for a percent, from 0.01 to 50, in steps of 0.01", id("orgFrAmountLabel").textContent === "Percent of each item's price (0.01–50)" &&
    amount().max === "50" && amount().min === "0.01" && amount().step === "0.01" && amount().type === "number");
  ok("…“Supports” is a box of at most 80 characters with an example", /^Supports/.test(label().closest("label").textContent.trim()) && label().maxLength === 80 && label().placeholder === "e.g. Example Boosters");
  ok("…“Show on the shop — a line under its name” is a tick box", showBox().type === "checkbox" && /Show on the shop — a line under its name/.test(showBox().closest("label").textContent));
  ok("the preview says what the shop shows: “10% of every purchase supports Example Boosters.”", preview() === "The shop shows: “10% of every purchase supports Example Boosters.”");
  tick(showBox(), false);
  ok("untick Show on the shop and the preview says it isn't shown", preview() === "Not shown on the shop: 10% of every purchase supports Example Boosters.");
  type(amount(), "12.5");
  ok("typing a new percent changes the preview at once", preview() === "Not shown on the shop: 12.5% of every purchase supports Example Boosters.");
  type(label(), "Example Swim Team");
  ok("…and so does a new name", preview() === "Not shown on the shop: 12.5% of every purchase supports Example Swim Team.");
  setMode("perPiece");
  ok("choosing an amount per piece relabels the box ($0.01–$1,000) and lets it go to 1000", id("orgFrAmountLabel").textContent === "Amount per piece ($0.01–$1,000)" && amount().max === "1000");
  ok("…and the preview reads it as dollars per item", preview() === "Not shown on the shop: $12.50 of every item supports Example Swim Team.");
  type(amount(), "0");
  ok("an amount that can't be saved leaves the preview empty", preview() === "");
  type(amount(), "2"); type(label(), "  ");
  ok("…and so does a missing name", preview() === "");
  setMode("");
  ok("“Has no fundraiser” hides the amount, the name and the tick box, and empties the preview", !fieldsShown() && preview() === "");
  setMode("percent");
  ok("…choosing one again shows them, with what was typed kept", fieldsShown() && amount().value === "2");

  openForm("band");
  ok("a shop giving $2 a piece opens on the amount per piece, the amount written as dollars (2.00)", mode().value === "perPiece" && amount().value === "2.00" && showBox().checked === false);
  ok("…its group's name, written like HTML, is in the box as typed and not read as HTML", label().value === BAND_LABEL && !id("orgFormFundraiser").querySelector("i"));
  ok("…and the preview shows it as text", preview() === "Not shown on the shop: $2.00 of every item supports " + BAND_LABEL + "." && !id("orgFrPreview").querySelector("i"));
  openForm("plain");
  ok("a shop with no fundraiser opens on “Has no fundraiser”, the rest hidden and empty", mode().value === "" && !fieldsShown() && amount().value === "" && label().value === "" && showBox().checked === false);
  openForm(null);
  ok("a new shop starts with no fundraiser", mode().value === "" && !fieldsShown() && preview() === "");

  console.log("\n=== What the form reads (readOrgFundraiser_) and the page's own refusals ===");
  openForm("plain");
  const readAs = (m, a, l, s) => { mode().value = m; amount().value = a; label().value = l; showBox().checked = !!s; return w.readOrgFundraiser_(); };
  ok("none reads as { fundraiser: null }", same(readAs("", "5", "X"), { fundraiser: null }));
  ok("a percent reads as { mode: percent, percent, label, showOnShop }", same(readAs("percent", "7.5", "  Example Boosters  ", true), { fundraiser: { mode: "percent", percent: 7.5, label: "Example Boosters", showOnShop: true } }));
  ok("an amount per piece reads as { mode: perPiece, amount, … }", same(readAs("perPiece", "1.25", "Example Boosters", false), { fundraiser: { mode: "perPiece", amount: 1.25, label: "Example Boosters", showOnShop: false } }));
  ok("the limits are kept: a percent of 0.01 and of 50, an amount of $0.01 and of $1,000 are fine",
    readAs("percent", "0.01", "A").fundraiser.percent === 0.01 && readAs("percent", "50", "A").fundraiser.percent === 50 &&
    readAs("perPiece", "0.01", "A").fundraiser.amount === 0.01 && readAs("perPiece", "1000", "A").fundraiser.amount === 1000);
  const PCT_ERR = "The fundraiser's percent must be from 0.01 to 50.", AMT_ERR = "The fundraiser's amount per piece must be from $0.01 to $1,000.", LABEL_ERR = "Say who the fundraiser supports (e.g. Example Boosters).";
  ok("a percent of nothing, 0, 0.009 or 50.01 is refused: " + PCT_ERR,
    ["", "0", "0.009", "50.01", "-1"].every(v => same(readAs("percent", v, "A"), { error: PCT_ERR })));
  ok("an amount of nothing, 0, 0.009 or 1000.01 is refused: " + AMT_ERR,
    ["", "0", "0.009", "1000.01", "-2"].every(v => same(readAs("perPiece", v, "A"), { error: AMT_ERR })));
  ok("either one with no name (or only spaces) is refused: " + LABEL_ERR, same(readAs("percent", "5", "   "), { error: LABEL_ERR }) && same(readAs("perPiece", "5", ""), { error: LABEL_ERR }));
  ok("a name over 80 characters is cut to 80", readAs("percent", "5", "x".repeat(95)).fundraiser.label.length === 80);
  ok("a percent with more than 2 decimals is rounded to 2", readAs("percent", "12.5", "A").fundraiser.percent === 12.5 && readAs("percent", "3.999", "A").fundraiser.percent === 4);
  { const box = id("orgFormFundraiser"); box.remove();
    ok("a form without the section reads as undefined (nothing to save)", w.readOrgFundraiser_() === undefined); }

  // Save on Edit: the page's refusals stop everything.
  for (const [what, m, a, l, msg] of [["a percent over 50", "percent", "60", "Example Boosters", PCT_ERR], ["an amount per piece of $0", "perPiece", "0", "Example Boosters", AMT_ERR],
    ["no name", "percent", "5", "", LABEL_ERR]]) {
    openForm("club"); reset();
    setMode(m); type(amount(), a); type(label(), l);
    await w.submitOrgForm(true);
    ok("Save with " + what + " says “" + msg + "” and sends nothing", formErr() === msg && sent.length === 0);
  }
  openForm(null); reset();
  id("orgFormName").value = "Example New Shop"; id("orgFormId").value = "newshop"; id("orgFormSubdomain").value = "newshop";
  setMode("percent"); type(amount(), "51"); type(label(), "Example Boosters");
  await w.submitOrgForm(false);
  ok("…and on a new shop too: the shop isn't created", formErr() === PCT_ERR && sent.length === 0 && !orgRow("newshop"));

  console.log("\n=== Save: setOrgFundraiser, after the shop, and only when it changed ===");
  openForm("club"); reset();
  await w.submitOrgForm(true);
  await idle();
  ok("Save with the fundraiser untouched sends updateOrg and no setOrgFundraiser", of("updateOrg").length === 1 && of("setOrgFundraiser").length === 0 && hashNow() === "catalog");
  openForm("club"); reset();
  type(amount(), "15"); tick(showBox(), false);
  await w.submitOrgForm(true);
  const regNow = JSON.stringify(reg("club").fundraiser);
  await idle();
  ok("a new percent: updateOrg first, then setOrgFundraiser for that shop with what the form says",
    same(sent.map(b => b.action).filter(a => a === "updateOrg" || a === "setOrgFundraiser"), ["updateOrg", "setOrgFundraiser"]) &&
    same(of("setOrgFundraiser")[0], { action: "setOrgFundraiser", org: "club", fundraiser: { mode: "percent", percent: 15, label: "Example Boosters", showOnShop: false }, key: "cookie" }));
  ok("…it is saved (1500 basis points, not shown on the shop) and the form goes back to the catalog",
    same(JSON.parse(orgRow("club").fundraiserJson), { mode: "percent", percentBps: 1500, label: "Example Boosters", showOnShop: false }) && hashNow() === "catalog" && !id("orgFrMode"));
  ok("…and the page's own copy of the shop has the new fundraiser at once", regNow === JSON.stringify({ mode: "percent", percent: 15, label: "Example Boosters", showOnShop: false }));
  openForm("club"); reset();
  const reopened = mode().value === "percent" && amount().value === "15" && showBox().checked === false;
  await w.submitOrgForm(true);
  await idle();
  ok("opened again it shows what was saved, and Save sends no setOrgFundraiser", reopened && of("setOrgFundraiser").length === 0 && of("updateOrg").length === 1);
  // A fundraiser changed and saved, and then the same form saved again: only what still differs is sent.
  openForm("club"); reset();
  type(amount(), "10"); tick(showBox(), true);
  scripted.push({ action: "updateOrg", status: 200, body: { status: "ok" } });
  // Edit stays on the form when the fundraiser fails; the same form's next Save sends only the fundraiser again.
  scripted.push({ action: "setOrgFundraiser", status: 400, body: { status: "error", message: "That fundraiser isn't valid." } });
  await w.submitOrgForm(true);
  await idle();
  ok("the fundraiser refused on Edit: “The shop's settings were saved, but not its fundraiser: That fundraiser isn't valid.”",
    formErr() === "The shop's settings were saved, but not its fundraiser: That fundraiser isn't valid.");
  ok("…the form stays open (the address is still the shop's Edit), with what was typed", hashNow() === "catalog/orgs/club/edit" && !!mode() && amount().value === "10" &&
    JSON.parse(orgRow("club").fundraiserJson).percentBps === 1500);
  reset();
  await w.submitOrgForm(true);
  await idle();
  ok("…Save again sends it again, and this time it is saved", of("setOrgFundraiser").length === 1 && JSON.parse(orgRow("club").fundraiserJson).percentBps === 1000 &&
    JSON.parse(orgRow("club").fundraiserJson).showOnShop === true && hashNow() === "catalog");
  openForm("club"); reset();
  type(amount(), "11");
  scripted.push({ action: "setOrgFundraiser", status: 500, body: { status: "error" } });
  await w.submitOrgForm(true);
  ok("a refusal with no message: “… but not its fundraiser: the save failed.”", formErr() === "The shop's settings were saved, but not its fundraiser: the save failed.");
  reset();
  scripted.push({ action: "setOrgFundraiser", throws: "offline" });
  await w.submitOrgForm(true);
  ok("the server out of reach: “… but not its fundraiser: the server couldn't be reached.”", formErr() === "The shop's settings were saved, but not its fundraiser: the server couldn't be reached.");
  reset();
  scripted.push({ action: "setOrgFundraiser", status: 200, body: { status: "ok" } });
  await w.submitOrgForm(true);
  // (Checked before the catalog page, drawn next, reads the shops again from the server, which wasn't told.)
  ok("an ok answer without the fundraiser: the page keeps what it sent as the shop's", w.location.hash === "#catalog" &&
    same(reg("club").fundraiser, { mode: "percent", percent: 11, label: "Example Boosters", showOnShop: true }));
  await idle();
  await must({ action: "setOrgFundraiser", org: "club", fundraiser: { mode: "percent", percent: 10, label: "Example Boosters", showOnShop: true } });
  await loadRegistry();

  openForm("band"); reset();
  setMode("");
  await w.submitOrgForm(true);
  await idle();
  ok("choosing “Has no fundraiser” sends fundraiser: null, and the shop has none", same(of("setOrgFundraiser").map(b => b.fundraiser), [null]) && orgRow("band").fundraiserJson === "" && reg("band").fundraiser === null);
  await must({ action: "setOrgFundraiser", org: "band", fundraiser: { mode: "perPiece", amount: 2, label: BAND_LABEL, showOnShop: false } });
  await loadRegistry();
  { // A server older than fundraisers sends shops without one: the form reads that as none and sends nothing for it.
    const older = Object.assign({}, reg("plain")); delete older.fundraiser;
    w.renderOrgForm(app, older); reset();
    await w.submitOrgForm(true);
    await idle();
    ok("a shop from a server older than fundraisers opens on none, and Save sends no setOrgFundraiser", of("updateOrg").length === 1 && of("setOrgFundraiser").length === 0);
  }

  // A new shop.
  openForm(null); reset();
  id("orgFormName").value = "Example New Shop"; id("orgFormId").value = "newshop"; id("orgFormSubdomain").value = "newshop";
  setMode("perPiece"); type(amount(), "1.5"); type(label(), "Example Boosters"); tick(showBox(), true);
  await w.submitOrgForm(false);
  await idle();
  ok("a new shop with a fundraiser: createOrg, then setOrgFundraiser for the new shop",
    same(sent.map(b => b.action).filter(a => a === "createOrg" || a === "setOrgFundraiser"), ["createOrg", "setOrgFundraiser"]) && of("setOrgFundraiser")[0].org === "newshop" &&
    same(JSON.parse(orgRow("newshop").fundraiserJson), { mode: "perPiece", cents: 150, label: "Example Boosters", showOnShop: true }));
  ok("…and it goes on to Shop setup as usual, saying nothing went wrong", /^(setup|wizard)\/newshop$/.test(hashNow()) && !toasts.some(t => t.err));
  openForm(null); reset();
  id("orgFormName").value = "Example Second Shop"; id("orgFormId").value = "second"; id("orgFormSubdomain").value = "second";
  await w.submitOrgForm(false);
  await idle();
  ok("a new shop left at none: createOrg only", of("createOrg").length === 1 && of("setOrgFundraiser").length === 0 && orgRow("second").fundraiserJson === "");
  openForm(null); reset();
  id("orgFormName").value = "Example Third Shop"; id("orgFormId").value = "third"; id("orgFormSubdomain").value = "third";
  setMode("percent"); type(amount(), "5"); type(label(), "Example Boosters");
  scripted.push({ action: "setOrgFundraiser", status: 400, body: { status: "error", message: "No <b>way</b>" } });
  await w.submitOrgForm(false);
  await idle();
  ok("a new shop whose fundraiser is refused is still created, and goes on to Shop setup", !!orgRow("third") && orgRow("third").fundraiserJson === "" && /^(setup|wizard)\/third$/.test(hashNow()));
  ok("…saying so: “Shop created, but its fundraiser wasn't saved (…) — set it again under the shop's Edit.”, as a problem",
    toasts.some(t => t.err && t.m === "Shop created, but its fundraiser wasn't saved (No <b>way</b>) — set it again under the shop's Edit."));
  await must({ action: "setOrgFundraiser", org: "newshop", fundraiser: null });   // (out of the report below)
  await loadRegistry();

  console.log("\n=== Copy settings from another shop leaves the fundraiser alone ===");
  openForm(null);
  id("orgFormCloneFrom").value = "club";
  w.applyCloneOrg();
  ok("copying from a shop that has a fundraiser copies the other settings but not it: the new shop still has none",
    mode().value === "" && !fieldsShown() && amount().value === "" && label().value === "" && preview() === "");
  openForm(null);
  setMode("perPiece"); type(amount(), "3"); type(label(), "Example Own Group");
  id("orgFormCloneFrom").value = "club";
  w.applyCloneOrg();
  ok("…and one already typed on the new shop is kept as it was", mode().value === "perPiece" && amount().value === "3" && label().value === "Example Own Group");
  w._prodFormDirty = false;   // (leaving the form unsaved would ask first)

  console.log("\n=== fundraiserView_ and fundraiserText_: one shape, however it arrives ===");
  const view = (f) => JSON.stringify(w.fundraiserView_(f));
  ok("the parsed shape is read as it is", view({ mode: "percent", percent: 10, label: " Example Boosters ", showOnShop: true }) === '{"mode":"percent","percent":10,"label":"Example Boosters","showOnShop":true}');
  ok("the stored shape (percentBps / cents), as an audit row may hold it, is read too",
    view({ mode: "percent", percentBps: 250, label: "A" }) === '{"mode":"percent","percent":2.5,"label":"A","showOnShop":false}' &&
    view({ mode: "perPiece", cents: 125, label: "A", showOnShop: true }) === '{"mode":"perPiece","amount":1.25,"label":"A","showOnShop":true}');
  ok("…and so is the stored JSON text", view('{"mode":"perPiece","cents":200,"label":"A","showOnShop":false}') === '{"mode":"perPiece","amount":2,"label":"A","showOnShop":false}');
  ok("nothing, empty text, text that isn't JSON, a number, an unknown mode, or an amount of 0 or less is none",
    [null, undefined, "", "{nope", 5, { mode: "other", percent: 5 }, { mode: "percent", percent: 0 }, { mode: "perPiece", amount: -1 }, { mode: "percent" }, { mode: "perPiece", amount: "x" }].every(f => w.fundraiserView_(f) === null));
  ok("showOnShop is only true when it is true", w.fundraiserView_({ mode: "percent", percent: 1, label: "A", showOnShop: "yes" }).showOnShop === false);
  ok("the shop's line: “10% of every purchase supports …”, “$2.00 of every item supports …”, the percent with no trailing zeros",
    w.fundraiserText_({ mode: "percent", percent: 10, label: "Example Boosters" }) === "10% of every purchase supports Example Boosters" &&
    w.fundraiserText_({ mode: "perPiece", amount: 2, label: "Example Boosters" }) === "$2.00 of every item supports Example Boosters" &&
    w.fundraiserText_({ mode: "percent", percentBps: 250, label: "X" }) === "2.5% of every purchase supports X");
  ok("…“the group” when it has no name, and nothing for none", w.fundraiserText_({ mode: "perPiece", amount: 1000 }) === "$1,000.00 of every item supports the group" && w.fundraiserText_(null) === "");

  // ==============================================================================================================
  console.log("\n=== Reports → Fundraising in the menu ===");
  // ==============================================================================================================
  const reportItems = () => { w.renderAdminNav(); const g = qa("#adminNav .admin-nav-group").find(x => x.querySelector(".admin-nav-drop").textContent === "Reports"); return g ? [...g.querySelectorAll(".admin-nav-menu button[data-h]")].map(b => b.dataset.h + "=" + b.textContent) : []; };
  { const items = reportItems();
    ok("an admin's Reports menu has “Fundraising” (#fundraising), right after the Sales tax report", items.includes("fundraising=Fundraising") && items[items.indexOf("fundraising=Fundraising") - 1] === "salestax=Sales tax report"); }
  ok("(the built-in roles) Admin and Manager have Full on the Fundraising report, Back office Read, Production none",
    levelsOf("admin")["reports.fundraising"] === "full" && levelsOf("manager")["reports.fundraising"] === "full" && levelsOf("staff")["reports.fundraising"] === "read" && levelsOf("production")["reports.fundraising"] === "none");
  asRoles("staff");
  ok("Back office gets it too (Read is enough)", reportItems().includes("fundraising=Fundraising") && w.adminCanOpen_("fundraising") === true);
  signInWith(withLevels("admin", { "reports.fundraising": "none" }));
  ok("a role without it doesn't: not in the menu, and the page can't be opened", !reportItems().some(s => s.startsWith("fundraising=")) && w.adminCanOpen_("fundraising") === false && w.adminCanFundraising_() === false);
  reset();
  w.location.hash = "#fundraising";
  await wait(() => !!id("roleOffPanel"));
  ok("…going to #fundraising says “Not available to you” and asks the server for nothing", /Not available to you\./.test(app.textContent) && of("getFundraisingReport").length === 0);
  asRoles("admin");

  // ==============================================================================================================
  console.log("\n=== The report page ===");
  // ==============================================================================================================
  const results = () => id("frResults");
  const drawn = () => !!results() && !/Loading…/.test(results().textContent) && results().textContent.trim() !== "";
  const go = async () => { const old = results(); w.location.hash = "#home"; await wait(() => !results()); await idle(); reset(); w.location.hash = "#fundraising"; await wait(() => results() && results() !== old && drawn()); await idle(); };
  const generate = async (from, to, org) => { if (from != null) id("frFrom").value = from; if (to != null) id("frTo").value = to; if (org != null) id("frOrg").value = org;
    reset(); id("frFilters").dispatchEvent(new w.Event("submit", { cancelable: true })); await wait(() => drawn()); await idle(); };
  await go();
  const y = Number(w.localToday_().slice(0, 4));
  ok("#fundraising draws the page headed “Fundraising”, the tab's title too", text(q("#app h1")) === "Fundraising" && /Fundraising \(Admin\)$/.test(d.title) && hashNow() === "fundraising");
  ok("…it is lit under Reports in the menu", w.adminNavActive_() === "fundraising");
  ok("the range starts on January 1 of this year and ends today", id("frFrom").value === y + "-01-01" && id("frTo").value === w.reportToDay_() && id("frFrom").type === "date" && id("frTo").type === "date");
  ok("…labelled From and To", q('label[for="frFrom"]').textContent === "From" && q('label[for="frTo"]').textContent === "To");
  ok("it asked for the report and the payouts of that range, for every shop", of("getFundraisingReport").length === 1 && of("listFundraiserPayouts").length === 1 &&
    same(of("getFundraisingReport")[0], { action: "getFundraisingReport", dateFrom: y + "-01-01", dateTo: w.reportToDay_(), key: "cookie" }) &&
    same(of("listFundraiserPayouts")[0], { action: "listFundraiserPayouts", dateFrom: y + "-01-01", dateTo: w.reportToDay_(), key: "cookie" }));
  { const btns = qa("#frFilters button[data-admin-action='fundraisingShowRange_']").map(b => b.textContent + "=" + b.dataset.from + ".." + b.dataset.to);
    ok("there are buttons for this year's four quarters, this year and last year", same(btns, ["Q1 " + y + "=" + y + "-01-01.." + y + "-03-31", "Q2 " + y + "=" + y + "-04-01.." + y + "-06-30",
      "Q3 " + y + "=" + y + "-07-01.." + y + "-09-30", "Q4 " + y + "=" + y + "-10-01.." + y + "-12-31", y + "=" + y + "-01-01.." + y + "-12-31", (y - 1) + "=" + (y - 1) + "-01-01.." + (y - 1) + "-12-31"])); }
  ok("the Shop filter: All shops, then every shop by name, written as text", q('label[for="frOrg"]').textContent === "Shop" &&
    same([...id("frOrg").options].map(o => o.value + "=" + o.textContent), ["=All shops", "band=" + BAND_NAME, "club=Example Club", "old=Example Old Shop", "plain=Example Plain"]) && !id("frOrg").querySelector("b"));
  ok("the note says a fundraiser is inside the prices and what Raised counts", /A fundraiser is inside the shop's prices: customers pay the same/.test(app.textContent) &&
    /Raised counts paid orders only; a cancelled item raises nothing, and a refund takes its share back\./.test(app.textContent));
  { reset();
    const btn = qa("#frFilters button[data-admin-action='fundraisingShowRange_']").find(b => b.textContent === "Q2 " + y);
    btn.click(); await wait(() => of("getFundraisingReport").length === 1 && drawn()); await idle();
    ok("a quarter's button sets From and To to that quarter and asks for it", id("frFrom").value === y + "-04-01" && id("frTo").value === y + "-06-30" &&
      of("getFundraisingReport")[0].dateFrom === y + "-04-01" && of("getFundraisingReport")[0].dateTo === y + "-06-30"); }
  { reset();
    const btn = qa("#frFilters button[data-admin-action='fundraisingShowRange_']").find(b => b.textContent === String(y - 1));
    btn.click(); await wait(() => of("getFundraisingReport").length === 1 && drawn()); await idle();
    ok("last year's button asks for the whole of last year", of("getFundraisingReport")[0].dateFrom === (y - 1) + "-01-01" && of("getFundraisingReport")[0].dateTo === (y - 1) + "-12-31"); }

  console.log("\n=== Dates the page won't ask for, and a report it can't get ===");
  await generate("2024-01-01", "");
  ok("a To date left empty: “Choose both dates.”, and nothing is asked", text(results()) === "Choose both dates." && sent.length === 0 && !!results().querySelector(".admin-error"));
  await generate("", "2024-12-31");
  ok("…a From date left empty too", text(results()) === "Choose both dates." && sent.length === 0);
  await generate("2024-12-31", "2024-01-01");
  ok("From after To: “The From date is after the To date.”, and nothing is asked", text(results()) === "The From date is after the To date." && sent.length === 0);
  scripted.push({ action: "getFundraisingReport", status: 503, body: { status: "error", message: "Fundraising isn't <ready> yet." } });
  await generate("2024-01-01", "2024-12-31");
  ok("the server refuses: its message is shown, as text", text(results()) === "Fundraising isn't <ready> yet." && !!results().querySelector(".admin-error") && !results().querySelector("ready"));
  scripted.push({ action: "getFundraisingReport", throws: "offline" });
  await generate();
  ok("the server out of reach: the problem is shown in place of the report", !!results().querySelector(".admin-error") && !id("frShops") && text(results()) !== "");

  console.log("\n=== The per-shop table, 2024, every shop ===");
  await generate("2024-01-01", "2024-12-31", "");
  const server = (await call({ action: "getFundraisingReport", dateFrom: "2024-01-01", dateTo: "2024-12-31" })).body;
  ok("(the server's figures for 2024: the club raised $7.00 on 2 orders, the band $6.00, the old shop $1.50, $2.00 + $1.50 paid out)",
    same(server.shops.map(s => [s.orgId, s.orders, s.pieces, s.sales, s.raised, s.paidOut, s.owed]),
      [["band", 1, 3, 45, 6, 0, -4], ["club", 2, 3, 80, 7, 2, 6], ["old", 1, 1, 15, 1.5, 1.5, 0]]) && same(server.totals, { orders: 4, pieces: 7, sales: 140, raised: 14.5, paidOut: 3.5, owed: 2 }));
  const shopRows = () => qa("#frShops tbody tr");
  const cellsOf = (tr) => [...tr.children].map(td => text(td));
  ok("the table's columns: Shop, Orders, Pieces, Sales, Raised, Paid out, Still owed, and one for the payout button",
    same(qa("#frShops thead th").map(th => th.textContent), ["Shop", "Orders", "Pieces", "Sales", "Raised", "Paid out", "Still owed", ""]));
  ok("…with what each heading means on hover", q("#frShops thead th:nth-child(4)").title === "What these orders' items sold for, before tax" &&
    q("#frShops thead th:nth-child(6)").title === "Payouts dated in this range" && q("#frShops thead th:nth-child(7)").title === "Raised less paid out, up to the To date");
  ok("one row a shop, in the server's order (by name)", shopRows().length === 3);
  ok("the band: its name and group as text, an amount per piece, 1 order, 3 pieces, $45.00, raised $6.00, nothing paid out, owed −$4.00",
    same(cellsOf(shopRows()[0]).slice(0, 7), [BAND_NAME + "Supports " + BAND_LABEL + " · an amount per piece", "1", "3", "$45.00", "$6.00", "—", "−$4.00"]) &&
    !shopRows()[0].querySelector("b, i"));
  ok("the club: “Supports Example Boosters · a percent of each sale”, 2 orders, 3 pieces, $80.00, $7.00, $2.00 paid out, $6.00 owed",
    same(cellsOf(shopRows()[1]).slice(0, 7), ["Example ClubSupports Example Boosters · a percent of each sale", "2", "3", "$80.00", "$7.00", "$2.00", "$6.00"]));
  ok("the old shop, whose fundraiser has ended: “no fundraiser now”, settled (owed —)",
    same(cellsOf(shopRows()[2]).slice(0, 7), ["Example Old Shopno fundraiser now", "1", "1", "$15.00", "$1.50", "$1.50", "—"]));
  const owedColor = (tr) => tr.children[6].style.color;
  ok("still owed is amber when owed, red when paid out more than raised, plain when settled",
    /180,\s*83,\s*9|#b45309/.test(owedColor(shopRows()[1])) && /176,\s*58,\s*46|#b03a2e/.test(owedColor(shopRows()[0])) && /17,\s*17,\s*17|#111/.test(owedColor(shopRows()[2])));
  ok("a shop that never had one and raised nothing isn't listed", !text(id("frShops")).includes("Example Plain"));
  ok("the totals row: 4 orders, 7 pieces, $140.00, $14.50 raised, $3.50 paid out, $2.00 owed",
    same(cellsOf(q("#frShops tfoot tr")).slice(0, 7), ["Total", "4", "7", "$140.00", "$14.50", "$3.50", "$2.00"]));
  ok("each shop has “Record payout…”, needing Edit on Expenses", shopRows().every(tr => { const b = tr.querySelector("button[data-admin-action='fundraisingPayout_']"); return b && b.textContent === "Record payout…" && b.getAttribute("data-need") === "finance.expenses:edit"; }) &&
    same(shopRows().map(tr => tr.querySelector("button").dataset.org), ["band", "club", "old"]));
  const note = () => text(results().firstElementChild);
  ok("above it: the range, how orders are dated (when they ship, the default), and that still owed runs up to the To date",
    note() === day("2024-01-01") + " – " + day("2024-12-31") + " · orders counted when they ship or are delivered. Still owed is everything raised less everything paid out up to " + day("2024-12-31") + ", not only in this range.");
  ok("…no note about recording payouts (this role can)", !/To record a payout|Recording a payout needs/.test(results().textContent));

  console.log("\n=== The per-order table ===");
  const orderRows = () => qa("#frOrders tbody tr");
  ok("headed “Orders (4)”, with Export CSV", /^Orders \(4\)$/.test(text(q("#frResults h3"))) && text(q("#frResults button[data-admin-action='fundraisingExportCsv_']")) === "Export CSV");
  ok("columns: Date, Order #, Shop, Customer, Pieces, Sales, Raised", same(qa("#frOrders thead th").map(th => th.textContent), ["Date", "Order #", "Shop", "Customer", "Pieces", "Sales", "Raised"]));
  const rowIds = () => orderRows().map(tr => text(tr.children[1]));
  ok("one row an order, in the server's order: the paid ones sold in 2024 (not the unpaid one, not last year's)",
    same(rowIds(), server.orders.map(o => o.orderId)) && same(rowIds().slice().sort(), ["BAND-1", "CLUB-1", "CLUB-2", "OLD-1"]));
  const rowOf = (orderId) => orderRows().find(tr => text(tr.children[1]) === orderId);
  ok("a row: the day it was placed, the order, its shop, the customer, pieces, sales and raised",
    same(cellsOf(rowOf("CLUB-1")), [day("2024-02-10T15:00:00.000Z"), "CLUB-1", "Example Club", "Pat Example", "2", "$40.00", "$4.00"]));
  ok("names that look like HTML are text: the band's shop name and the customer with an <img>", text(rowOf("BAND-1").children[2]) === BAND_NAME && text(rowOf("CLUB-2").children[3]) === ROBIN &&
    !id("frOrders").querySelector("img, b") && w.__xss326 === undefined);
  ok("an order with a custom line counts only the catalog line's pieces, and all its sales", same(cellsOf(rowOf("CLUB-2")).slice(4), ["1", "$40.00", "$3.00"]));
  { const b = rowOf("CLUB-1").children[1].querySelector("button");
    ok("the order number is a button that opens the order in its shop's orders", !!b && b.dataset.adminAction === "fundraisingOpenOrder_" && b.dataset.org === "club" && b.dataset.order === "CLUB-1" &&
      b.dataset.placed === "2024-02-10T15:00:00.000Z" && b.title === "Open this order in its shop's orders" && b.hasAttribute("data-perm-keep")); }

  console.log("\n=== The payouts under it ===");
  const payRows = () => qa("#frPayouts tbody tr");
  ok("“Payouts to the group (2)”: the payouts dated in 2024, newest first", /Payouts to the group \(2\)/.test(results().textContent) && payRows().length === 2);
  ok("columns: Date, Shop, Amount, Paid from, Note", same(qa("#frPayouts thead th").map(th => th.textContent), ["Date", "Shop", "Amount", "Paid from", "Note"]));
  ok("a payout: its date, shop, amount, the account it was paid from, and what it was for (as text)",
    same(cellsOf(payRows()[1]), [day("2024-03-15"), "Example Club", "$2.00", "Business checking", "Fundraiser payout — Example Boosters — Check <1042>"]) && payRows()[1].children[4].children.length === 0);
  ok("…the old shop's, paid from Cash on hand, says whom it went to", same(cellsOf(payRows()[0]), [day("2024-04-20"), "Example Old Shop", "$1.50", "Cash on hand", "Fundraiser payout — Example Old Shop"]));
  ok("under them: each is an expense, with a link to Finance → Expenses", /Each payout is an expense in the Fundraiser payouts category — change or void one under Finance → Expenses\./.test(results().textContent) &&
    results().querySelector('a[href="#expenses"]').textContent === "Finance → Expenses");

  console.log("\n=== One shop (the Shop filter) ===");
  reset();
  id("frOrg").value = "club"; fire(id("frOrg"), "change");
  await wait(() => of("getFundraisingReport").length === 1 && drawn()); await idle();
  ok("choosing a shop asks again, for that shop", same(of("getFundraisingReport")[0], { action: "getFundraisingReport", dateFrom: "2024-01-01", dateTo: "2024-12-31", org: "club", key: "cookie" }) &&
    of("listFundraiserPayouts")[0].org === "club");
  ok("…and shows only it, its orders and its payouts", shopRows().length === 1 && same(orderRows().map(tr => text(tr.children[1])), ["CLUB-1", "CLUB-2"]) && payRows().length === 1 &&
    same(cellsOf(q("#frShops tfoot tr")).slice(0, 7), ["Total", "2", "3", "$80.00", "$7.00", "$2.00", "$6.00"]));
  await generate(null, null, "plain");
  ok("a shop with nothing to show: the empty table says how to set one up, with no totals row", text(shopRows()[0]) === "No shop has a fundraiser, and none raised or paid out anything in this range. Set one up on a shop's Edit page (Manage catalog → the shop → Edit)." &&
    shopRows()[0].children[0].getAttribute("colspan") === "8" && !q("#frShops tfoot"));
  ok("…“Orders (0)”, no Export CSV, and the orders table says none raised anything", /^Orders \(0\)$/.test(text(q("#frResults h3"))) && !q("#frResults button[data-admin-action='fundraisingExportCsv_']") &&
    text(orderRows()[0]) === "No paid order raised anything in this range." && orderRows()[0].children[0].getAttribute("colspan") === "7");
  ok("…and “No payouts in this range.”", /Payouts to the group \(0\)/.test(results().textContent) && text(payRows()[0]) === "No payouts in this range.");
  reset();
  w.fundraisingExportCsv_();
  ok("Export CSV with no orders on the screen says to generate the report first, and makes no file", lastToast().m === "Generate the report first — there are no orders to export." && lastToast().err && downloads.length === 0);

  console.log("\n=== The sale date, as the Revenue report dates sales ===");
  const saleBasis = (b) => d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('accounting', ?)", [JSON.stringify({ saleDate: b })]);
  saleBasis("placed");
  await generate("2024-05-01", "2024-05-01", "");
  ok("with sales dated when placed, the note says so", /orders counted on the date they were placed\./.test(note()));
  ok("…and the orders are those placed in the range (CLUB-2 was placed on May 1 and shipped on May 3)", same(orderRows().map(tr => text(tr.children[1])), ["CLUB-2"]));
  saleBasis("shipped");
  await generate("2024-05-01", "2024-05-01", "");
  ok("…dated when shipped, the same day has none", /orders counted when they ship or are delivered\./.test(note()) && text(orderRows()[0]) === "No paid order raised anything in this range.");
  { // An answer without the sale date, or without owedAsOf, from an older server: the dates the page asked for.
    scripted.push({ action: "getFundraisingReport", body: { status: "ok", shops: [], orders: [], totals: {} } });
    await generate("2024-01-01", "2024-03-31", "");
    ok("an answer without saleDate or owedAsOf: no sale-date words, and still owed runs up to the To date asked for",
      note() === day("2024-01-01") + " – " + day("2024-03-31") + ". Still owed is everything raised less everything paid out up to " + day("2024-03-31") + ", not only in this range."); }

  console.log("\n=== Export CSV ===");
  await generate("2024-01-01", "2024-12-31", "");
  reset();
  q("#frResults button[data-admin-action='fundraisingExportCsv_']").click();
  await wait(() => downloads.length === 1);
  ok("Export CSV makes one file, named for the range: fundraising-2024-01-01-to-2024-12-31.csv", downloads.length === 1 && downloads[0].name === "fundraising-2024-01-01-to-2024-12-31.csv");
  ok("…from what is on the screen: nothing is asked of the server", sent.length === 0);
  const csv = await blobText(downloads[0].blob);
  const csvLines = csv.split("\r\n");
  const csvRow = (orderId) => csvLines.find(l => l.split(",")[1] === orderId);
  ok("its header: Date, Order #, Shop, Supports, Customer, Pieces, Sales, Raised", csvLines[0] === "Date,Order #,Shop,Supports,Customer,Pieces,Sales,Raised");
  ok("a row: the sale's day as YYYY-MM-DD, the order, shop, the group it supports, customer, pieces, sales and raised as plain numbers",
    csvRow("CLUB-1") === "2024-02-10,CLUB-1,Example Club,Example Boosters,Pat Example,2,40,4");
  ok("a customer's name that starts like a formula is written so a spreadsheet won't run it", csvRow("BAND-1") === "2024-03-01,BAND-1,Example <b>Band</b>," + BAND_LABEL + ",\"'=HYPERLINK(\"\"http://example.com\"\")\",3,45,6");
  ok("a shop whose fundraiser has ended has an empty Supports", csvRow("OLD-1") === "2024-04-01,OLD-1,Example Old Shop,,Kim Example,1,15,1.5");
  ok("…a name with quotes and commas is quoted, the quotes doubled", csvRow("CLUB-2") === '2024-05-01,CLUB-2,Example Club,Example Boosters,"<img src=x onerror=""window.__xss326=1"">Robin",1,40,3');
  ok("one line an order, in the order on the screen, and nothing more", csvLines.length === 6 && csvLines[5] === "" &&
    same(csvLines.slice(1, 5).map(l => l.split(",")[1]), server.orders.map(o => o.orderId)));
  await generate(null, null, "club");
  reset();
  q("#frResults button[data-admin-action='fundraisingExportCsv_']").click();
  await wait(() => downloads.length === 1);
  ok("for one shop the file is named for it too: fundraising-club-2024-01-01-to-2024-12-31.csv", downloads[0].name === "fundraising-club-2024-01-01-to-2024-12-31.csv");

  console.log("\n=== A slower, older answer is never drawn over a newer one ===");
  { let release; hold = { action: "getFundraisingReport", gate: new Promise(r => { release = r; }) };
    reset();
    id("frOrg").value = "band"; fire(id("frOrg"), "change");
    await wait(() => of("getFundraisingReport").length === 1);
    ok("while it is on its way the results say “Loading…”", /Loading…/.test(results().textContent));
    id("frOrg").value = "club"; fire(id("frOrg"), "change");
    await wait(() => of("getFundraisingReport").length === 2 && drawn()); await idle();
    ok("the newer answer (the club) is drawn", shopRows().length === 1 && /Example Club/.test(text(shopRows()[0])));
    release(); await pause(50); await idle();
    ok("…and when the older one (the band) arrives late, it is dropped", shopRows().length === 1 && /Example Club/.test(text(shopRows()[0])) && !/Band/.test(text(id("frShops"))));
    reset();
    q("#frResults button[data-admin-action='fundraisingExportCsv_']").click();
    await wait(() => downloads.length === 1);
    ok("…Export CSV uses the report on the screen, not the dropped one", downloads[0].name === "fundraising-club-2024-01-01-to-2024-12-31.csv"); }
  { let release; hold = { action: "getFundraisingReport", gate: new Promise(r => { release = r; }) };
    reset();
    id("frOrg").value = "band"; fire(id("frOrg"), "change");
    await wait(() => of("getFundraisingReport").length === 1);
    w.location.hash = "#home";
    await wait(() => !results()); await idle();
    release(); await pause(50); await idle();
    ok("an answer that arrives after leaving the page draws nothing", !results() && !id("frShops")); }

  console.log("\n=== The payouts list can't be had ===");
  await go();
  scripted.push({ action: "listFundraiserPayouts", status: 500, body: { status: "error", message: "Couldn't read <payouts>" } });
  await generate("2024-01-01", "2024-12-31", "");
  ok("the report is still drawn, and the payouts section is left out", shopRows().length === 3 && !id("frPayouts") && !/Payouts to the group/.test(results().textContent) && !/Couldn't read/.test(results().textContent));
  scripted.push({ action: "listFundraiserPayouts", body: { status: "ok" } });
  await generate();
  ok("an answer with no payouts list reads as none", /Payouts to the group \(0\)/.test(results().textContent));
  { // A payout without the account's name (an older server): the page's own list of accounts names it.
    w.eval('_accountsCache = { accounts: [{ id: 4, name: "Cash <box>", active: true }] };');
    scripted.push({ action: "listFundraiserPayouts", body: { status: "ok", payouts: [{ id: 1, date: "2024-04-20", orgId: "zzz", amount: 3, accountId: 4, note: "Hand <delivered>", description: "ignored" },
      { id: 2, date: "2024-04-21", orgId: "old", amount: 1, accountId: 99, description: "Desc <only>" }] } });
    await generate();
    ok("a payout without its account's name is named from the page's accounts; one it doesn't know is left blank",
      same(cellsOf(payRows()[0]), [day("2024-04-20"), "zzz", "$3.00", "Cash <box>", "Hand <delivered>"]) && same(cellsOf(payRows()[1]), [day("2024-04-21"), "Example Old Shop", "$1.00", "", "Desc <only>"]) &&
      !id("frPayouts").querySelector("box, delivered, only"));
    w.eval("_accountsCache = null;"); }

  console.log("\n=== Without Bookkeeping, or without Edit on Expenses ===");
  features({ bookkeeping: false });
  await generate();
  ok("with Bookkeeping off there is no Record payout… and no column for it", !q("#frShops button[data-admin-action='fundraisingPayout_']") && qa("#frShops thead th").length === 7 && q("#frShops tfoot tr").children.length === 7);
  ok("…a note says how to turn it on, since a shop is owed money", /To record a payout to the group, turn on Bookkeeping \(Global settings → Features\): a payout is an expense, paid from one of your accounts\./.test(results().textContent));
  ok("…and the payouts' footer has no link to Expenses (the page is off)", /Each payout is an expense in the Fundraiser payouts category\./.test(results().textContent) && !results().querySelector('a[href="#expenses"]'));
  reset();
  await w.showFundraiserPayoutModal_("club");
  ok("…asked for anyway, Record payout… says the role or Bookkeeping won't allow it and opens nothing", lastToast().m === "Your role can't record expenses, or Bookkeeping is off." && lastToast().err && !modal() && sent.length === 0);
  await generate(null, null, "old");
  ok("…with nobody owed anything, no note", !/To record a payout|Recording a payout needs/.test(results().textContent));
  features({});
  signInWith(withLevels("admin", { "finance.expenses": "read" }));
  await generate(null, null, "");
  ok("Bookkeeping on, but Expenses at Read: no Record payout…, and the note says it needs Edit on Expenses",
    !q("#frShops button[data-admin-action='fundraisingPayout_']") && /Recording a payout needs Edit on Expenses \(Users → Roles and permissions\)\./.test(results().textContent));
  signInWith(withLevels("admin", { "orders.list": "none", "orders.details": "none" }));
  if (w.adminCanOpen_("orders")) signInWith(Object.fromEntries(Object.entries(levelsOf("admin")).map(([k, v]) => [k, /^orders\./.test(k) ? "none" : v])));
  await generate();
  ok("a role that can't open Orders sees the order numbers as plain text, not buttons", !w.adminCanOpen_("orders") && orderRows().length === 4 && !q("#frOrders button") && text(orderRows()[0].children[1]) === "CLUB-1");
  asRoles("admin");

  // ==============================================================================================================
  console.log("\n=== Record payout… ===");
  // ==============================================================================================================
  await generate("2024-01-01", "2024-12-31", "");
  const payBtn = (org) => q(`#frShops button[data-admin-action='fundraisingPayout_'][data-org='${org}']`);
  const openPay = async (org) => { payBtn(org).click(); await wait(() => !!(modal() && modal().querySelector("#frpSave"))); return modal(); };
  try { w.localStorage.removeItem("oddExpPaidFrom"); } catch (_) {}
  reset();
  let m = await openPay("club");
  ok("it opens a window titled “Record payout — Example Club”", text(m.querySelector("[data-dialog-title]")) === "Record payout — Example Club");
  ok("…saying who the money went to and that it is an expense, with what is still owed up to the To date",
    text(m.querySelector("[data-dialog-title]").parentNode.nextElementSibling) === "Money you paid to Example Boosters from this shop's fundraiser. It is recorded as an expense in Fundraiser payouts; still owed up to " + day("2024-12-31") + ": $6.00.");
  ok("the amount starts at what is owed: 6.00", m.querySelector("#frpAmount").value === "6.00" && m.querySelector("#frpAmount").min === "0.01");
  ok("the date paid starts today", m.querySelector("#frpDate").value === w.localToday_() && m.querySelector("#frpDate").type === "date");
  ok("Paid from offers the active accounts only (not the inactive Venmo), starting at “Choose…”",
    same([...m.querySelector("#frpAccount").options].map(o => o.value + "=" + o.textContent), ["=Choose…", "1=Business checking", "2=Credit card", "4=Cash on hand", "5=Stripe balance"]) && m.querySelector("#frpAccount").value === "");
  ok("the boxes are labelled, the note at most 200 characters", m.querySelector('label[for="frpAmount"]').textContent === "Amount ($)" && m.querySelector('label[for="frpDate"]').textContent === "Date paid" &&
    m.querySelector('label[for="frpAccount"]').textContent === "Paid from" && m.querySelector('label[for="frpNote"]').textContent === "Note (optional)" && m.querySelector("#frpNote").maxLength === 200);
  ok("…Save payout needs Edit on Expenses", m.querySelector("#frpSave").textContent === "Save payout" && m.querySelector("#frpSave").getAttribute("data-need") === "finance.expenses:edit");
  ok("(it asked for the accounts)", of("listAccounts").length === 1);
  const pErr = () => m.querySelector("#frpErr").textContent;
  const save = async () => { m.querySelector("#frpSave").click(); await pause(20); await idle(); };
  m.querySelector("#frpAmount").value = "";
  reset(); await save();
  ok("no amount: “Enter the amount paid.”, nothing sent", pErr() === "Enter the amount paid." && sent.length === 0);
  m.querySelector("#frpAmount").value = "0";
  await save();
  ok("…$0 the same", pErr() === "Enter the amount paid." && sent.length === 0);
  m.querySelector("#frpAmount").value = "5"; m.querySelector("#frpDate").value = "";
  await save();
  ok("no date: “Enter the date it was paid.”", pErr() === "Enter the date it was paid." && sent.length === 0);
  m.querySelector("#frpDate").value = "2024-06-01";
  await save();
  ok("no account: “Choose the account it was paid from.”", pErr() === "Choose the account it was paid from." && sent.length === 0);
  m.querySelector("#frpAccount").value = "2"; m.querySelector("#frpDate").value = "2999-01-01";
  await save();
  ok("the server refuses (a date in the future): its message is shown, the window stays, nothing is recorded",
    pErr() === "The date can't be in the future" && !!modal() && of("recordFundraiserPayout").length === 1 && d1.q("SELECT COUNT(*) AS n FROM expenses WHERE fundraiserOrgId = 'club'")[0].n === 1);
  ok("…and Save payout can be pressed again", m.querySelector("#frpSave").disabled === false && m.querySelector("#frpSave").textContent === "Save payout");
  scripted.push({ action: "recordFundraiserPayout", status: 500, body: { status: "error" } });
  reset(); await save();
  ok("a refusal with no message: “The payout wasn't saved.”", pErr() === "The payout wasn't saved.");
  scripted.push({ action: "recordFundraiserPayout", throws: "offline" });
  reset(); await save();
  ok("the server out of reach: “Could not reach the server.”", pErr() === "Could not reach the server." && m.querySelector("#frpSave").disabled === false);
  { // The session ended and nobody signed in again.
    const login = w.adminLogin; w.adminLogin = async () => null; w.eval('adminKey = "";');
    reset(); await save();
    ok("the session ended and nobody signed in: “Nothing was saved. …”, nothing sent", pErr() === "Nothing was saved. " + w.eval("SAVE_SIGNED_OUT_") && sent.length === 0);
    w.adminLogin = login; w.eval('adminKey = "cookie";'); }

  // Saved.
  m.querySelector("#frpDate").value = "2024-06-01"; m.querySelector("#frpNote").value = "  Check <1043>  ";
  { let release; hold = { action: "recordFundraiserPayout", gate: new Promise(r => { release = r; }) };
    reset();
    m.querySelector("#frpSave").click();
    await wait(() => of("recordFundraiserPayout").length === 1);
    ok("while it saves, the button reads “Saving…” and is disabled", m.querySelector("#frpSave").disabled && m.querySelector("#frpSave").textContent === "Saving…");
    release(); }
  await wait(() => !modal()); await wait(() => drawn() && of("getFundraisingReport").length === 1); await idle();
  ok("Save payout sends the shop, the amount, the day, the account (a number) and the note, trimmed",
    same(of("recordFundraiserPayout")[0], { action: "recordFundraiserPayout", org: "club", amount: 5, date: "2024-06-01", accountId: 2, note: "Check <1043>", key: "cookie" }));
  ok("…the window closes and says “Payout of $5.00 recorded for Example Boosters.”", !modal() && lastToast().m === "Payout of $5.00 recorded for Example Boosters." && !lastToast().err);
  { const e = d1.q("SELECT * FROM expenses WHERE fundraiserOrgId = 'club' ORDER BY id DESC")[0];
    ok("…it is an expense in Fundraiser payouts for the club, from the credit card, on that day", e.amountCents === 500 && e.expenseDate === "2024-06-01" && e.accountId === 2 &&
      d1.q("SELECT systemKey FROM expense_categories WHERE id = ?", e.categoryId)[0].systemKey === "fundraiser_payout"); }
  ok("…and the report is drawn again: the club has $7.00 paid out and $1.00 still owed, and the payout is listed",
    same(cellsOf(shopRows()[1]).slice(5, 7), ["$7.00", "$1.00"]) && payRows().some(tr => cellsOf(tr)[4] === "Fundraiser payout — Example Boosters — Check <1043>" && cellsOf(tr)[3] === "Credit card"));
  let remembered = null; try { remembered = w.localStorage.getItem("oddExpPaidFrom"); } catch (_) {}
  m = await openPay("club");
  ok("next time Paid from starts at the account used last", remembered === "2" && m.querySelector("#frpAccount").value === "2" && ![...m.querySelector("#frpAccount").options].some(o => o.value === ""));
  ok("…and the amount at what is owed now: 1.00", m.querySelector("#frpAmount").value === "1.00");
  m.querySelector("#frpCancel").click();
  ok("Cancel closes it without asking anything", !modal() && !confirmBox());

  console.log("\n=== Closing a payout with something typed asks first ===");
  m = await openPay("club");
  m.querySelector("#frpNote").value = "half typed"; fire(m.querySelector("#frpNote"), "input");
  m.querySelector("[data-modal-close]").click();
  let asked = await answer(false);
  ok("✕ after typing asks “Discard changes?”, with Discard and Keep editing", /^Discard changes\?/.test(asked.message) && /What you typed in this window hasn't been saved\./.test(asked.message) &&
    asked.okLabel === "Discard" && asked.cancelLabel === "Keep editing");
  ok("…Keep editing leaves the window open with what was typed", !!modal() && modal().querySelector("#frpNote").value === "half typed");
  m.querySelector("[data-modal-close]").click();
  await answer(true);
  ok("…Discard closes it, and nothing is recorded", !modal() && d1.q("SELECT COUNT(*) AS n FROM expenses WHERE fundraiserOrgId = 'club'")[0].n === 2);
  m = await openPay("club");
  m.querySelector("[data-modal-close]").click();
  await pause(30);
  ok("✕ with nothing typed closes at once", !modal() && !confirmBox());

  console.log("\n=== Record payout… for a shop owed nothing, or with no group ===");
  m = await openPay("band");
  ok("a shop that is owed nothing (paid out more): the amount starts empty, and no “still owed” is said",
    m.querySelector("#frpAmount").value === "" && !/still owed/.test(m.textContent) && /Money you paid to <i>Band<\/i> & Parents from this shop's fundraiser/.test(text(m)) && !m.querySelector("i") && text(m.querySelector("[data-dialog-title]")) === "Record payout — " + BAND_NAME);
  m.querySelector("#frpCancel").click();
  m = await openPay("old");
  ok("a shop whose fundraiser has ended: “Money you paid to the group …”", /Money you paid to the group from this shop's fundraiser\. It is recorded as an expense in Fundraiser payouts\./.test(text(m)) && m.querySelector("#frpAmount").value === "");
  m.querySelector("#frpAmount").value = "0.5"; m.querySelector("#frpDate").value = "2024-07-01"; m.querySelector("#frpAccount").value = "1";
  reset(); await save();
  await wait(() => !modal()); await idle();
  ok("…saved, it says “Payout of $0.50 recorded.” without a group's name", lastToast().m === "Payout of $0.50 recorded." && d1.q("SELECT COUNT(*) AS n FROM expenses WHERE fundraiserOrgId = 'old'")[0].n === 2);

  console.log("\n=== When Record payout… can't open ===");
  reset();
  await w.showFundraiserPayoutModal_("plain");
  ok("a shop not on the report on the screen: “Generate the report again, then record the payout.”", lastToast().m === "Generate the report again, then record the payout." && lastToast().err && !modal() && sent.length === 0);
  w.eval("_accountsCache = null;");
  scripted.push({ action: "listAccounts", status: 500, body: { status: "error", message: "Accounts <down>" } });
  reset();
  await w.showFundraiserPayoutModal_("club");
  ok("the accounts can't be had: their message, and no window", lastToast().m === "Accounts <down>" && lastToast().err && !modal());
  d1._raw.run("UPDATE accounts SET active = 0");
  w.eval("_accountsCache = null;");
  reset();
  await w.showFundraiserPayoutModal_("club");
  ok("no active account: “Add an account first (Finance → Accounts & money): a payout is paid from one.”", lastToast().m === "Add an account first (Finance → Accounts & money): a payout is paid from one." && lastToast().err && !modal());
  d1._raw.run("UPDATE accounts SET active = 1 WHERE id <> 3");
  d1._raw.run("UPDATE accounts SET active = 0 WHERE id <> 4");
  w.eval("_accountsCache = null;");
  try { w.localStorage.removeItem("oddExpPaidFrom"); } catch (_) {}
  m = await openPay("club");
  ok("with only one active account it is chosen, with no “Choose…”", same([...m.querySelector("#frpAccount").options].map(o => o.value), ["4"]) && m.querySelector("#frpAccount").value === "4");
  m.querySelector("#frpCancel").click();
  d1._raw.run("UPDATE accounts SET active = 1 WHERE id <> 3");
  w.eval("_accountsCache = null;");

  // ==============================================================================================================
  console.log("\n=== Opening an order from the report, and “Raises $x for …” on it ===");
  // ==============================================================================================================
  await generate("2024-01-01", "2024-12-31", "");
  orderRows()[0].children[1].querySelector("button").click();
  await wait(() => hashNow() === "orders/club" && !!q('#app tr[data-order="CLUB-1"]'), 1500); await idle();
  ok("the order number opens its shop's orders, the order in the list", hashNow() === "orders/club" && !!q('#app tr[data-order="CLUB-1"]') && !toasts.some(t => /isn't in this list/.test(t.m)));
  const pillsOf = (orderId) => qa(`#app tr[data-order="${orderId}"] .fundraiser-pill`);
  ok("its line shows “Raises $4.00 for Example Boosters” by the customer's name", pillsOf("CLUB-1").length > 0 && pillsOf("CLUB-1").every(p => p.textContent === "Raises $4.00 for Example Boosters" && p.tagName === "SPAN") &&
    pillsOf("CLUB-1")[0].title === "Inside the order's price: what it raises for the shop's fundraiser (Reports → Fundraising)");
  { const cached = (w._ordersCache && w._ordersCache.club) || [];
    const o1 = cached.find(o => o.orderId === "CLUB-1");
    ok("(the order the page has carries fundraiserRaised in dollars)", !!o1 && o1.fundraiserRaised === 4);
    const box = d.createElement("div");
    box.innerHTML = w.orderCardHtml_(o1, { orgId: "club", name: "Example Club" }, null, false);
    ok("the phone's order card shows it next to the name too", text(box.querySelector(".oc-name .fundraiser-pill")) === "Raises $4.00 for Example Boosters");
    const pm = w.showPaymentsModal("club", "CLUB-1");
    await wait(() => !!q("#pmContent"));
    ok("the Payments window has a line under the totals: “Raises $4.00 for Example Boosters (inside the price)”",
      text(q("#pmContent tr.pm-fundraiser")) === "Raises $4.00 for Example Boosters (inside the price)" && q("#pmContent tr.pm-fundraiser td").title === "Inside the price: the customer pays the same");
    q("#pmCloseBottom").click(); await pm; }
  { // An order that raises nothing has neither.
    d1.q("UPDATE orders SET placedAt = '2024-02-10T16:00:00.000Z' WHERE orderId = 'CLUB-3'");
    d1.q("UPDATE order_items SET fundraiserCents = 0 WHERE orderId = 'CLUB-3'");
    w.adminRoute(); await wait(() => !!q('#app tr[data-order="CLUB-3"]'), 1000); await idle();
    ok("an order whose lines raise nothing has no pill", !!q('#app tr[data-order="CLUB-3"]') && pillsOf("CLUB-3").length === 0 && pillsOf("CLUB-1").length > 0);
    const pm = w.showPaymentsModal("club", "CLUB-3");
    await wait(() => !!q("#pmContent"));
    ok("…and no line in its Payments window", !q("#pmContent tr.pm-fundraiser"));
    q("#pmCloseBottom").click(); await pm; }
  ok("an order from a shop with no group's name: “Raises $1.00 for the shop's fundraiser”",
    w.orderFundraiserText_({ fundraiserRaised: 1, orgId: "old" }) === "Raises $1.00 for the shop's fundraiser" && w.orderFundraiserText_({ fundraiserRaised: 1 }, "nope") === "Raises $1.00 for the shop's fundraiser");
  ok("the shop is the one given, else the order's own", w.orderFundraiserText_({ fundraiserRaised: 2.5, orgId: "club" }) === "Raises $2.50 for Example Boosters" &&
    w.orderFundraiserText_({ fundraiserRaised: 2.5, orgId: "nope" }, "club") === "Raises $2.50 for Example Boosters");
  ok("nothing for 0, a negative amount, an order from a server older than fundraisers, or no order", w.orderFundraiserText_({ fundraiserRaised: 0, orgId: "club" }) === "" &&
    w.orderFundraiserText_({ fundraiserRaised: -1, orgId: "club" }) === "" && w.orderFundraiserText_({ orgId: "club" }) === "" && w.orderFundraiserText_(null, "club") === "" && w.orderFundraiserPill_({ orgId: "club" }) === "");
  ok("the group's name is escaped in the pill", /Raises \$6\.00 for &lt;i&gt;Band&lt;\/i&gt; &amp; Parents/.test(w.orderFundraiserPill_({ fundraiserRaised: 6, orgId: "band" })) &&
    !(() => { const b = d.createElement("div"); b.innerHTML = w.orderFundraiserPill_({ fundraiserRaised: 6, orgId: "band" }); return b.querySelector("i"); })());
  ok("(the pill has its own style: .fundraiser-pill)", /\.fundraiser-pill\{[^}]*display:inline-block/.test(read("public/admin.css")));

  // ==============================================================================================================
  console.log("\n=== The audit log ===");
  // ==============================================================================================================
  ok("the two new entries are named: “Fundraiser set” and “Fundraiser payout recorded”",
    w.eval('AUDIT_ACTION_LABELS["org.fundraiser_set"]') === "Fundraiser set" && w.eval('AUDIT_ACTION_LABELS["fundraiser.payout_recorded"]') === "Fundraiser payout recorded");
  const sum = (a, detail) => w.auditDetailSummary(a, detail);
  ok("a fundraiser set: what it was → what it is", sum("org.fundraiser_set", { from: { mode: "perPiece", amount: 2, label: "Example Boosters" }, to: { mode: "percent", percent: 10, label: "Example Boosters" } }) ===
    "$2.00 of every item supports Example Boosters → 10% of every purchase supports Example Boosters");
  ok("…“none” where there wasn't one, or isn't now", sum("org.fundraiser_set", { from: null, to: { mode: "percent", percentBps: 500, label: "X" } }) === "none → 5% of every purchase supports X" &&
    sum("org.fundraiser_set", { from: { mode: "perPiece", cents: 150, label: "X" }, to: null }) === "$1.50 of every item supports X → none");
  ok("…the group's name escaped", sum("org.fundraiser_set", { from: null, to: { mode: "perPiece", amount: 2, label: BAND_LABEL } }) === "none → $2.00 of every item supports &lt;i&gt;Band&lt;/i&gt; &amp; Parents");
  ok("a payout: the amount, to whom, the day and the note", sum("fundraiser.payout_recorded", { amount: 5, label: "Example Boosters", date: "2024-06-01", note: "Check 1043" }) ===
    "$5.00 to Example Boosters · " + day("2024-06-01") + " — Check 1043");
  ok("…each part left out when it isn't there", sum("fundraiser.payout_recorded", { amount: 1.5 }) === "$1.50" && sum("fundraiser.payout_recorded", {}) === "$0.00");
  ok("…the name and the note escaped", sum("fundraiser.payout_recorded", { amount: 1, label: BAND_LABEL, note: "<b>n</b>" }) === "$1.00 to &lt;i&gt;Band&lt;/i&gt; &amp; Parents — &lt;b&gt;n&lt;/b&gt;");
  { // The log itself, from the real entries written above.
    reset();
    w.location.hash = "#audit";
    await wait(() => /Fundraiser payout recorded/.test(app.textContent) && /Fundraiser set/.test(app.textContent), 1500); await idle();
    ok("the Audit log page shows the real entries by those names, with their summaries",
      /Fundraiser payout recorded/.test(app.textContent) && /\$5\.00 to Example Boosters/.test(app.textContent) && /Check <1043>/.test(app.textContent) &&
      /Fundraiser set/.test(app.textContent) && /none → \$1\.50 of every item supports Example Boosters/.test(app.textContent));
    ok("…and nothing in them is read as HTML", !app.querySelector("i, b") || ![...app.querySelectorAll("i, b")].some(el => /Band|1043/.test(el.textContent))); }

  ok("nothing typed anywhere ran as HTML", w.__xss326 === undefined);
  await idle();
})().catch((e) => { console.error(e); ok("test326 ran to the end", false); });
