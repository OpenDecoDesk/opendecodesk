// A session that ends while a long page is being edited (24 hours, Sign out everywhere, a role change) costs a
// sign-in, not the edit: the product, shop and Global settings saves ask to sign in when the server says the session
// has ended, and send the same save again — the form is not touched meanwhile. Cancel at the sign-in leaves the form
// as it was typed, saying nothing was saved; the next Save asks to sign in before it sends anything.
// Before, each of the three only printed "Session expired — please log in again." under the form, with no sign-in.
// jsdom with the real index.html + admin.js; fetch is answered per action. Invented data only.
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader } = require("jsdom");

const ok = (d, v) => console.log(d + ":", !!v);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 20));
const wait = async (f, n = 150) => { for (let i = 0; i < n && !f(); i++) await tick(10); return f(); };
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const EXPIRED = "Session expired — please log in again.";

(async () => {
  const adminJs = read("public/admin.js");
  const calls = [];            // every /api/orders request, as sent
  const sessions = [];         // every /api/admin-session request: "POST" (a sign-in) or "DELETE"
  const expire = {};           // action → how many of its next requests the server answers 401
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) };
      win.fetch = async (url, opts) => {
        const b = opts && opts.body ? JSON.parse(opts.body) : {};
        const j = (x, status) => ({ ok: !status || status < 400, status: status || 200, json: async () => x, text: async () => JSON.stringify(x) });
        if (String(url).includes("/api/admin-session")) {
          sessions.push((opts && opts.method) || "GET");
          return opts.method === "DELETE" ? j({ status: "ok" }) : j({ status: "ok", session: "cookie", expires: new Date(Date.now() + 864e5).toISOString(), user: { email: "pat@example.test" } });
        }
        if (!b.action) return j({ status: "admin", business: {}, country: "US" });
        calls.push(b);
        if (expire[b.action] > 0) { expire[b.action]--; return j({ status: "error", message: EXPIRED }, 401); }
        switch (b.action) {
          // The product page
          case "listDesigns": return j({ status: "ok", designs: [] });
          case "listHoops": return j({ status: "ok", hoops: [] });
          case "listProductDesigns": return j({ status: "ok", designs: [] });
          case "getBlanks": return j({ status: "ok", blanks: [{ id: 7, name: "Structured cap", productType: "cap", sizes: [{ size: "OSFA", quantity: 3 }] }] });
          case "getBlankLinks": return j({ status: "ok", links: [] });
          case "updateProduct": case "saveBlankLinks": case "updateOrg": return j({ status: "ok" });
          // Global settings
          case "getGlobalSettings": return j({ status: "ok", globalSettings: { enabledPayments: {} } });
          case "getFeatures": return j({ status: "ok", list: [{ key: "shipping", label: "Shipping", description: "Carrier shipping." }], features: { shipping: false }, locked: [], shippoKey: false });
          case "getLocaleSettings": return j({ status: "ok", locale: { timeZone: "", country: "US" }, effectiveTimeZone: "America/Chicago", envTimeZone: "America/Chicago" });
          case "getSalesTaxSettings": return j({ status: "ok", salesTax: { ratePercent: 6, jurisdiction: "OH", taxMode: "inclusive" } });
          case "getRushSettings": return j({ status: "ok", rush: { rule: { mode: "fixed", amount: 15 }, taxable: false } });
          case "getBusinessProfile": return j({ status: "ok", business: {} });
          // (the page's optional sections: not loaded here, as on an install without them)
          case "getShipFromAddress": case "getAccountingSettings": case "getEmailSettings": case "getMachineSettings": case "getSetupStatus":
          case "getPricingSettings": case "getDigitalSettings": return j({ status: "error", message: "n/a" });
          case "saveGlobalSettingsAll": return j({ status: "ok", settings: { ...b.settings, business: {} }, belowTarget: [] });
          case "listOrgs": case "listOrgsAdmin": return j({ status: "ok", orgs: [{ orgId: "shop1", name: "Sample Shop" }, { orgId: "league", name: "League" }] });
          default: return j({ status: "ok" });
        }
      };
    } });
  const w = dom.window, d = w.document;
  await tick(150);
  await w.loadAdminScript();
  const toasts = [];
  w.showToast = (m, bad) => toasts.push(String(m));
  // The page asks to sign in as it opens: that box is closed first, so every box below is one a Save raised.
  await wait(() => d.getElementById("adminPassInput"));
  d.querySelector(".admin-pass-overlay .admin-pass-cancel").click();
  await tick(40);
  const app = d.getElementById("app");
  const signedIn = () => { w.eval('adminKey = "cookie"; adminOrgs = [{orgId:"shop1", name:"Sample Shop"}];'); };
  const signInBox = () => d.getElementById("adminPassInput");
  // Fills in and sends the sign-in box when it opens; false when none opened (the old code never asked).
  const signIn = async () => {
    if (!await wait(signInBox)) return false;
    d.getElementById("adminEmailInput").value = "pat@example.test";
    signInBox().value = "a password";
    d.getElementById("adminPassForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
    return true;
  };
  const cancelSignIn = async () => { if (!await wait(signInBox)) return false; d.querySelector(".admin-pass-overlay .admin-pass-cancel").click(); return true; };
  // Nothing asks to sign in until a Save is refused (checked before each Save below).
  const reset = () => { if (signInBox()) throw new Error("a sign-in box was already open"); calls.length = 0; sessions.length = 0; toasts.length = 0; for (const k of Object.keys(expire)) delete expire[k]; };
  const sentOf = (action) => calls.filter(c => c.action === action);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const NOT_SAVED = "Nothing was saved. Your session ended — save again and sign in.";

  // ---------------------------------------------------------------------------------------------------------------
  console.log("=== Product form ===");
  const product = { productId: "cap", type: "cap", name: "Club cap", pricingMode: "flat", flatPrice: 25, personalizationPrice: 5,
    personalizationOptions: [], visible: true, taxable: true, images: [], features: [], designs: [] };
  const drawProduct = async () => { signedIn(); w.location.hash = "#catalog/orgs/shop1/products/cap/edit"; w.renderProductForm(app, "shop1", product); await wait(() => app.querySelector(".bl-blank")); await tick(40); };
  await drawProduct();
  const prodErr = () => (d.getElementById("prodFormError") || {}).textContent || "";
  d.getElementById("prodFormName").value = "Club cap — navy";
  w._prodFormDirty = true;
  reset(); expire.updateProduct = 1;
  let saving = w.submitProductForm("shop1", true);
  let asked = await signIn();
  await saving; await tick();
  let sent = sentOf("updateProduct");
  ok("product: an ended session opens the sign-in box instead of printing \"Session expired\"", asked && !/Session expired/.test(prodErr()));
  ok("…after signing in, the same save is sent again, unchanged", sent.length === 2 && same(sent[0], sent[1]) && sent[1].name === "Club cap — navy" && sessions.includes("POST"));
  ok("…and the page ends as saved: no error, back on the products list", w._prodFormDirty === false && w.location.hash === "#catalog/orgs/shop1/products" && toasts.includes("Saved."));
  ok("…the old session was forgotten before signing in again", sessions.indexOf("DELETE") >= 0 && sessions.indexOf("DELETE") < sessions.indexOf("POST"));

  await drawProduct();
  d.getElementById("prodFormName").value = "Typed and not yet saved";
  d.getElementById("prodFormFlatPrice").value = "31.50";
  w._prodFormDirty = true;
  reset(); expire.updateProduct = 1;
  saving = w.submitProductForm("shop1", true);
  asked = await cancelSignIn();
  await saving; await tick();
  ok("product, sign-in cancelled: the form is still there with what was typed", asked && d.getElementById("prodFormName") && d.getElementById("prodFormName").value === "Typed and not yet saved" &&
    d.getElementById("prodFormFlatPrice").value === "31.50" && w.location.hash === "#catalog/orgs/shop1/products/cap/edit" && w._prodFormDirty === true);
  ok("…it says nothing was saved and to sign in, and nothing more was sent", prodErr() === NOT_SAVED && sentOf("updateProduct").length === 1);
  reset();
  saving = w.submitProductForm("shop1", true);
  asked = await signIn();
  await saving; await tick();
  sent = sentOf("updateProduct");
  ok("…Save again asks to sign in before sending anything, then saves what was typed", asked && sent.length === 1 && sent[0].name === "Typed and not yet saved" && sent[0].flatPrice === 31.5 &&
    w.location.hash === "#catalog/orgs/shop1/products");

  // The requests that follow the product's own: its blank links go the same way.
  await drawProduct();
  const blank = app.querySelector(".bl-blank"); blank.value = "7"; blank.dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick(40);
  reset(); expire.saveBlankLinks = 1;
  saving = w.submitProductForm("shop1", true);
  asked = await signIn();
  await saving; await tick();
  sent = sentOf("saveBlankLinks");
  ok("product: a session that ends before its blank links are saved asks to sign in and sends the links again", asked && sent.length === 2 && same(sent[0], sent[1]) && sent[1].set.length === 1 &&
    sentOf("updateProduct").length === 1 && !/Blank links/.test(prodErr()) && w.location.hash === "#catalog/orgs/shop1/products");
  await drawProduct();
  { const b2 = app.querySelector(".bl-blank"); b2.value = "7"; b2.dispatchEvent(new w.Event("change", { bubbles: true })); await tick(40); }
  reset(); expire.saveBlankLinks = 1;
  saving = w.submitProductForm("shop1", true);
  asked = await cancelSignIn();
  await saving; await tick();
  ok("…cancelled there: the page stays, saying the product was saved and the blank links weren't", asked && /^The product was saved, but: Blank links: Your session ended/.test(prodErr()) &&
    w.location.hash === "#catalog/orgs/shop1/products/cap/edit" && !!d.getElementById("prodFormName"));

  // An ordinary refusal keeps the form's own wording.
  await drawProduct();
  reset();
  { const real = w.fetch; w.fetch = async (u, o) => { const b = o && o.body ? JSON.parse(o.body) : {};
      if (b.action === "updateProduct") { calls.push(b); return { ok: false, status: 400, json: async () => ({ status: "error", message: "The name is too long." }) }; } return real(u, o); };
    await w.submitProductForm("shop1", true); await tick(); w.fetch = real; }
  ok("product: any other refusal is shown as before, with no sign-in", prodErr() === "The name is too long." && !signInBox() && sentOf("updateProduct").length === 1);

  // ---------------------------------------------------------------------------------------------------------------
  console.log("\n=== Shop form ===");
  const shop = { orgId: "league", subdomain: "league", name: "League", deliveryOptions: [{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }], designImages: {} };
  const drawShop = async () => { signedIn(); w.location.hash = "#catalog/orgs/league/edit"; w.renderOrgForm(app, shop); await wait(() => d.getElementById("orgFormName")); await tick(40); };
  await drawShop();
  const shopErr = () => (d.getElementById("orgFormError") || {}).textContent || "";
  d.getElementById("orgFormName").value = "League — spring season";
  w._prodFormDirty = true;
  reset(); expire.updateOrg = 1;
  saving = w.submitOrgForm(true);
  asked = await signIn();
  await saving; await tick();
  sent = sentOf("updateOrg");
  ok("shop: an ended session opens the sign-in box instead of printing \"Session expired\"", asked && !/Session expired/.test(shopErr()));
  ok("…after signing in, the same save is sent again, unchanged", sent.length === 2 && same(sent[0], sent[1]) && sent[1].name === "League — spring season" && sessions.includes("POST"));
  ok("…and the page ends as saved: back on the shops list", w._prodFormDirty === false && w.location.hash === "#catalog");

  await drawShop();
  d.getElementById("orgFormName").value = "Typed shop name";
  d.getElementById("orgFormDesc").value = "A description typed before the session ended.";
  w._prodFormDirty = true;
  reset(); expire.updateOrg = 1;
  saving = w.submitOrgForm(true);
  asked = await cancelSignIn();
  await saving; await tick();
  ok("shop, sign-in cancelled: the form is still there with what was typed", asked && d.getElementById("orgFormName") && d.getElementById("orgFormName").value === "Typed shop name" &&
    d.getElementById("orgFormDesc").value === "A description typed before the session ended." && w.location.hash === "#catalog/orgs/league/edit" && w._prodFormDirty === true);
  ok("…it says nothing was saved and to sign in, and nothing more was sent", shopErr() === NOT_SAVED && sentOf("updateOrg").length === 1);
  reset();
  saving = w.submitOrgForm(true);
  asked = await signIn();
  await saving; await tick();
  sent = sentOf("updateOrg");
  ok("…Save again asks to sign in before sending anything, then saves what was typed", asked && sent.length === 1 && sent[0].name === "Typed shop name" && w.location.hash === "#catalog");

  // ---------------------------------------------------------------------------------------------------------------
  console.log("\n=== Global settings ===");
  const drawSettings = async () => { signedIn(); w.location.hash = "#settings"; w.renderGlobalSettings(app); await wait(() => d.getElementById("gTaxRate") && d.getElementById("gRushAmount")); await tick(60); };
  await drawSettings();
  const setErr = () => (d.getElementById("globalSettingsError") || {}).textContent || "";
  { const rate = d.getElementById("gTaxRate"); rate.value = "7.25"; rate.dispatchEvent(new w.Event("input", { bubbles: true })); }
  reset(); expire.saveGlobalSettingsAll = 1;
  saving = w.submitGlobalSettings();
  asked = await signIn();
  await saving; await tick(60);
  sent = sentOf("saveGlobalSettingsAll");
  ok("Global settings: an ended session opens the sign-in box instead of \"Nothing was saved. Session expired\"", asked && !/Session expired/.test(setErr()) && !toasts.some(t => /Session expired/.test(t)));
  ok("…after signing in, the same save is sent again, unchanged", sent.length === 2 && same(sent[0], sent[1]) && sent[1].settings.salesTax.ratePercent === 7.25 && sessions.includes("POST"));
  ok("…and the page ends as saved: nothing unsaved, no error, still on Global settings", w._prodFormDirty === false && !/Nothing was saved/.test(setErr()) && w.location.hash === "#settings" &&
    toasts.some(t => /saved/i.test(t)));

  await drawSettings();
  { const rate = d.getElementById("gTaxRate"); rate.value = "8.5"; rate.dispatchEvent(new w.Event("input", { bubbles: true })); }
  reset(); expire.saveGlobalSettingsAll = 1;
  saving = w.submitGlobalSettings();
  asked = await cancelSignIn();
  await saving; await tick(60);
  ok("Global settings, sign-in cancelled: the page is still there with what was typed", asked && d.getElementById("gTaxRate") && d.getElementById("gTaxRate").value === "8.5" && w._prodFormDirty === true);
  ok("…it says nothing was saved and to sign in, and nothing more was sent", setErr() === NOT_SAVED && sentOf("saveGlobalSettingsAll").length === 1);
  reset();
  saving = w.submitGlobalSettings();
  asked = await signIn();
  await saving; await tick(60);
  sent = sentOf("saveGlobalSettingsAll");
  ok("…Save again asks to sign in before sending anything, then saves what was typed", asked && sent.length === 1 && sent[0].settings.salesTax.ratePercent === 8.5 && w._prodFormDirty === false);

  // ---------------------------------------------------------------------------------------------------------------
  console.log("\n=== The shared helper ===");
  signedIn(); reset(); expire.anything = 2;
  let p = w.adminSave_({ action: "anything", n: 1 });
  asked = await signIn();
  let r = await p;
  ok("adminSave_: if it still fails after signing in it stops (one sign-in, two sends), saying nobody is signed in", asked && r.ok === false && r.signedOut === true &&
    sentOf("anything").length === 2 && sessions.filter(x => x === "POST").length === 1 && !w.eval("adminKey"));
  signedIn(); reset();
  r = await w.adminSave_({ action: "anything", n: 2 });
  ok("adminSave_: a save that goes through hands back the server's whole answer", r.ok === true && r.data.status === "ok" && !r.signedOut && sentOf("anything").length === 1 && sentOf("anything")[0].key === "cookie");
  process.exit(0);
})().catch(e => { console.error(e); console.log("test294 crashed: false"); process.exit(1); });
