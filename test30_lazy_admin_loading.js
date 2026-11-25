const { JSDOM, ResourceLoader } = require("jsdom");
const { storefrontPage } = require("./testlib/storefront-page");
const fs = require("fs");
// The page as a visitor gets it: without the admin's styles, which loadAdminScript adds (review #104).
let html = storefrontPage({ adminCss: false });
const adminJsSource = fs.readFileSync(__dirname + "/public/admin.js", "utf8");
const adminCssSource = fs.readFileSync(__dirname + "/public/admin.css", "utf8");

// index.html doesn't ship the admin panel to every storefront
// visitor — it's lazily loaded from admin.js via
// a dynamically-injected <script src="admin.js"> tag, only when
// /api/catalog resolves to status:"admin". This file tests
// loadAdminScript() itself: the storefront never triggers it, the admin
// subdomain does (automatically, through render()), it's idempotent, it
// fails gracefully, and admin.js's functions genuinely become callable
// once loaded (proving the cross-<script>-tag shared-scope mechanism the
// whole approach depends on — see admin.js's own header comment).

// Polls until check() is truthy or timeoutMs passes; returns the last result.
// Not fixed sleeps or short deadlines: jsdom parsing the large admin.js
// can take seconds on a busy machine. A 10s ceiling costs nothing when
// it's fast.
const LOAD_TIMEOUT_MS = 10000;
async function waitUntil(check, timeoutMs = LOAD_TIMEOUT_MS){
  const start = Date.now();
  let v = check();
  while(!v && Date.now() - start < timeoutMs){
    await new Promise(r => setTimeout(r, 10));
    v = check();
  }
  return v;
}

const requested = [];
class AdminResourceLoader extends ResourceLoader {
  fetch(url, options){
    requested.push(url);
    if(url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJsSource, "utf-8"));
    if(url.includes("/admin.css")) return Promise.resolve(Buffer.from(adminCssSource, "utf-8"));
    return super.fetch(url, options);
  }
}
class FailingAdminResourceLoader extends ResourceLoader {
  fetch(url, options){
    if(url.includes("/admin.js")) return Promise.reject(new Error("simulated network failure"));
    if(url.includes("/admin.css")) return Promise.resolve(Buffer.from(adminCssSource, "utf-8"));
    return super.fetch(url, options);
  }
}
// admin.css held back until release(), or refused: the admin waits for it, or goes on without it.
function cssLoader(mode){
  let release; const held = new Promise(r => { release = r; });
  class L extends ResourceLoader {
    fetch(url, options){
      if(url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJsSource, "utf-8"));
      if(url.includes("/admin.css")) return mode === "fail" ? Promise.reject(new Error("simulated network failure")) : held.then(() => Buffer.from(adminCssSource, "utf-8"));
      return super.fetch(url, options);
    }
  }
  return { loader: new L(), release: () => release() };
}

function orgCatalogFetchMock(){
  return async (url) => {
    if(String(url).startsWith("/api/catalog")){
      return { ok: true, json: async () => ({
        status: "ok", orgId: "league-101",
        catalog: { name: "Example League", eyebrow: "x", accent: "#1E7A4C", ready: true, desc: "d",
          designImages:{shirt:"",cap:"",detail:""}, cardPaymentEnabled: true,
          products: [{ id:"A", type:"shirt", name:"Option A", sub:"s", images:[], features:[], personalizationPrice:2,
            sizePricing:{XS:23,S:23,M:23,L:23,XL:23,"2XL":24,"3XL":26,"4XL":27} }] }
      })};
    }
    return { ok: true, json: async () => ({status:"error"}) };
  };
}
function adminCatalogFetchMock(){
  return async (url) => {
    if(String(url).startsWith("/api/catalog")) return { ok: true, json: async () => ({status:"admin"}) };
    return { ok: true, json: async () => ({status:"error"}) };
  };
}

(async () => {
  console.log("=== Storefront visitor: admin.js is NEVER requested ===");
  {
    const dom = new JSDOM(html, {
      runScripts: "dangerously", resources: new AdminResourceLoader(),
      url: "https://league101.example.com/x.html", pretendToBeVisual: true,
      beforeParse(win){ win.fetch = orgCatalogFetchMock(); }
    });
    const { window } = dom;
    await new Promise(r => setTimeout(r, 150));
    console.log("Storefront rendered normally:", window.document.getElementById("app").innerHTML.includes("Option A"));
    console.log("No <script src=admin.js> was ever injected:", !window.document.querySelector('script[src^="admin.js"]'));
    console.log("Admin-only functions are NOT defined in this window:", typeof window.renderAdminPicker === "undefined");
    console.log("…and admin.css isn't asked for either: a shop's visitor downloads none of the admin's styles:", !window.document.querySelector("[data-admin-css]") && !requested.some(u => u.includes("/admin.css")));
    const page = fs.readFileSync(__dirname + "/public/index.html", "utf8");
    console.log("index.html carries no admin-only rule (#adminNav, .admin-hero, .home-tiles live in admin.css):", !/\n\s*(#adminNav|\.admin-hero|\.home-tiles)\s*\{/.test(page) &&
      /#adminNav\s*\{/.test(adminCssSource) && /\.admin-hero\s*\{/.test(adminCssSource) && /\.home-tiles\s*\{/.test(adminCssSource));
    console.log("…while what the storefront uses stays in it (buttons, toasts, the loading note):", /\.admin-btn\s*\{/.test(page) && /\.toast\s*\{/.test(page) && /\.admin-summary\s*\{/.test(page) && !/\.toast\s*\{/.test(adminCssSource));
  }

  console.log("\n=== Admin subdomain: boot() -> render() automatically triggers the load ===");
  {
    const dom = new JSDOM(html, {
      runScripts: "dangerously", resources: new AdminResourceLoader(),
      url: "https://admin.example.com/x.html", pretendToBeVisual: true,
      beforeParse(win){ win.fetch = adminCatalogFetchMock(); }
    });
    const { window } = dom;
    await new Promise(r => setTimeout(r, 50));
    console.log("Shows a loading state before admin.js resolves:", window.document.getElementById("app").innerHTML.includes("Loading"));
    await waitUntil(() => window.document.querySelector('script[src^="admin.js"]'));
    console.log("<script src=admin.js> was injected automatically, with no test code calling loadAdminScript() itself:", !!window.document.querySelector('script[src^="admin.js"]'));
    // Poll instead of fixed-wait — JSDOM's execution time varies with file size
    await waitUntil(() => typeof window.renderAdminPicker === "function");
    console.log("Admin functions became callable globals once it loaded:", typeof window.renderAdminPicker === "function");
    await waitUntil(() => window.document.getElementById("adminPassInput"));
    console.log("The real admin UI replaced the loading state:", !!window.document.getElementById("adminPassInput"));
    const link = window.document.querySelector("link[data-admin-css]"), tag = window.document.querySelector('script[src^="admin.js"]');
    console.log("admin.css was added with it, as a stylesheet under the same version as admin.js:", !!link && link.rel === "stylesheet" &&
      link.getAttribute("href").replace(/^admin\.css/, "") === tag.getAttribute("src").replace(/^admin\.js/, "") && /^\?(v|t)=/.test(link.getAttribute("href").replace(/^admin\.css/, "")));
  }

  console.log("\n=== The admin waits for admin.css, so it never draws unstyled (#104) ===");
  {
    const { loader, release } = cssLoader("hold");
    const dom = new JSDOM(html, { runScripts: "dangerously", resources: loader, url: "https://admin.example.com/x.html", pretendToBeVisual: true,
      beforeParse(win){ win.fetch = adminCatalogFetchMock(); } });
    const { window } = dom;
    await waitUntil(() => window.document.querySelector('script[src^="admin.js"]') && window.document.querySelector("link[data-admin-css]"));
    await new Promise(r => setTimeout(r, 1000));
    console.log("with admin.css still on its way the page still says Loading, a second later:", !window.document.getElementById("adminPassInput") && window.document.getElementById("app").innerHTML.includes("Loading"));
    release();
    await waitUntil(() => window.document.getElementById("adminPassInput"));
    console.log("…and the admin draws once it is in:", !!window.document.getElementById("adminPassInput"));
  }
  {
    const { loader } = cssLoader("fail");
    const dom = new JSDOM(html, { runScripts: "dangerously", resources: loader, url: "https://admin.example.com/x.html", pretendToBeVisual: true,
      virtualConsole: new (require("jsdom").VirtualConsole)(),
      beforeParse(win){ win.fetch = adminCatalogFetchMock(); } });
    const { window } = dom;
    await waitUntil(() => window.document.getElementById("adminPassInput"));
    console.log("admin.css failing to load doesn't stop the admin (it works, plainly):", !!window.document.getElementById("adminPassInput"));
  }

  console.log("\n=== loadAdminScript() is idempotent — repeated calls don't inject a second <script> tag ===");
  {
    const dom = new JSDOM(html, {
      runScripts: "dangerously", resources: new AdminResourceLoader(),
      url: "https://league101.example.com/x.html", pretendToBeVisual: true,
      beforeParse(win){ win.fetch = orgCatalogFetchMock(); }
    });
    const { window } = dom;
    await new Promise(r => setTimeout(r, 100));
    await window.loadAdminScript();
    await window.loadAdminScript();
    await window.loadAdminScript();
    const tags = window.document.querySelectorAll('script[src^="admin.js"]');
    console.log("Exactly one <script> tag after 3 calls:", tags.length === 1);
    console.log("…and one admin.css link:", window.document.querySelectorAll("link[data-admin-css]").length === 1);
  }

  console.log("\n=== A failed load is handled gracefully, not left as an unhandled rejection ===");
  {
    const dom = new JSDOM(html, {
      runScripts: "dangerously", resources: new FailingAdminResourceLoader(),
      url: "https://admin.example.com/x.html", pretendToBeVisual: true,
      beforeParse(win){ win.fetch = adminCatalogFetchMock(); }
    });
    const { window } = dom;
    let unhandled = false;
    window.addEventListener("unhandledrejection", () => { unhandled = true; });
    await waitUntil(() => window.document.getElementById("app").innerHTML.includes("Could not load"));
    console.log("Shows a clear error message instead of a stuck loading state:", window.document.getElementById("app").innerHTML.includes("Could not load"));
    console.log("No unhandled promise rejection leaked:", unhandled === false);
  }

  console.log("\n=== Shared state works correctly across the two <script> tags ===");
  {
    const dom = new JSDOM(html, {
      runScripts: "dangerously", resources: new AdminResourceLoader(),
      url: "https://admin.example.com/x.html", pretendToBeVisual: true,
      beforeParse(win){ win.fetch = adminCatalogFetchMock(); }
    });
    const { window } = dom;
    await waitUntil(() => window.document.getElementById("adminPassInput"));
    // adminKey is declared in admin.js; escapeHtml/showToast are declared
    // in index.html's own script. promptAdminPassphrase (admin.js) calling
    // showToast (index.html) or vice versa would throw a ReferenceError if
    // the two <script> tags didn't actually share one global scope.
    // (loadAdminOrgList()'s own follow-up fetch resets adminKey to null on
    // any error, so give the mocked listOrgs call a success response —
    // otherwise this would race that reset instead of testing shared state.)
    const FAKE_SESSION_TOKEN = "cookie"; // the real session is an HttpOnly cookie; admin.js only ever holds this marker
    window.fetch = async (url, opts) => {
      if(String(url).startsWith("/api/catalog")) return { ok: true, json: async () => ({status:"admin"}) };
      if(String(url).startsWith("/api/admin-session")) return { ok: true, json: async () => ({status:"ok", session: "cookie", expires:"2099-01-01T00:00:00Z"}) };
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if(body.action === "listOrgs") return { ok: true, json: async () => ({status:"ok", orgs:[]}) };
      return { ok: true, json: async () => ({status:"error"}) };
    };
    window.document.getElementById("adminPassInput").value = "test-key-xyz";
    window.document.querySelector(".admin-pass-submit").click();
    await waitUntil(() => window.eval("adminKey") === FAKE_SESSION_TOKEN);
    // adminKey is declared in admin.js — verifies the two <script> tags share
    // one global scope. With session-based auth, adminKey is set to the session
    // token returned by /api/admin-session, not the raw passphrase typed.
    console.log("adminKey (declared in admin.js) is now set after login (shared scope works):", window.eval("adminKey") === FAKE_SESSION_TOKEN);
  }
})();
