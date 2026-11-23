const fs = require("fs");
const path = require("path");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader } = require("jsdom");

// The Content-Security-Policy (public/_headers) runs no inline script: no <script> without a src, no on…=""
// attribute, no javascript: link. So the pages must have none — in the HTML files, and in the HTML that
// admin.js and storefront.js build in their template strings. An admin element names its action instead
// (data-admin-action="name", data-admin-change / -input / -submit / -keydown) and one listener runs it from
// ADMIN_ACTIONS_, a fixed list at the top of admin.js: every name used must be on the list, and everything on
// the list must call something that exists. The storefront's own elements use its data-action / data-change
// listeners. The one page the API writes itself (functions/api/download.js) allows its script by a nonce.

const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const tick = (ms) => new Promise(r => setTimeout(r, ms || 5));
// Source without its comment lines (a comment may well mention <script src> or onclick). Only comments that start a
// line: a "/*" inside a string (accept="image/*") must not hide the code after it.
const code = (src) => src.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
const INLINE_HANDLER = /[\s"'`]on[a-z]+\s*=\s*["'\\]/gi;
const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc=)[^>]*>/gi;
const JS_URL = /\b(?:href|src|action)\s*=\s*["']?\s*javascript:/gi;
const hits = (re, s) => (s.match(re) || []);

(async () => {
  console.log("=== The policy ===");
  const headers = read("public/_headers");
  const csp = (headers.match(/Content-Security-Policy: (.*)/) || [])[1] || "";
  const scriptSrc = (csp.split(";").map(d => d.trim()).find(d => d.startsWith("script-src ")) || "");
  ok("public/_headers sets a script-src", /^script-src 'self'/.test(scriptSrc));
  ok("…with no 'unsafe-inline' (nor 'unsafe-eval', nor a wildcard)", !/'unsafe-inline'|'unsafe-eval'|\*|data:/.test(scriptSrc));
  ok("…only this site, Cloudflare's analytics and its bot check", scriptSrc === "script-src 'self' https://static.cloudflareinsights.com https://challenges.cloudflare.com");
  ok("inline styles are still allowed (thousands of style=\"…\")", /style-src 'self' 'unsafe-inline'/.test(csp));
  const desktop = require("./desktop/server.js").desktopCsp(csp);
  const desktopScript = desktop.split(";").map(d => d.trim()).find(d => d.startsWith("script-src "));
  ok("the desktop program's policy (the same one, rewritten) runs only its own files", desktopScript === "script-src 'self'");

  console.log("\n=== No inline script in the HTML files ===");
  const htmlFiles = fs.readdirSync(path.join(__dirname, "public")).filter(f => f.endsWith(".html"));
  ok("public/ has its page", htmlFiles.includes("index.html"));
  for (const f of htmlFiles) {
    const s = read("public/" + f);
    ok(`public/${f}: no on…="" attribute`, !hits(INLINE_HANDLER, s).length);
    ok(`public/${f}: no <script> without a src`, !hits(INLINE_SCRIPT, s).length);
    ok(`public/${f}: no javascript: link`, !hits(JS_URL, s).length);
  }
  ok("index.html loads its script as a file, at the end of <body>", /<script src="\/storefront\.js"><\/script>\n<\/body>/.test(read("public/index.html")));

  console.log("\n=== …nor in the HTML the scripts build ===");
  const scripts = fs.readdirSync(path.join(__dirname, "public")).filter(f => /\.m?js$/.test(f));
  for (const f of scripts) {
    const s = code(read("public/" + f));
    const h = hits(INLINE_HANDLER, s), sc = hits(INLINE_SCRIPT, s), j = hits(JS_URL, s);
    ok(`public/${f}: no on…="" in its template strings${h.length ? " (found " + h.slice(0, 3).join(" ") + ")" : ""}`, !h.length);
    ok(`public/${f}: no inline <script>${sc.length ? " (found " + sc.slice(0, 3).join(" ") + ")" : ""}`, !sc.length);
    ok(`public/${f}: no javascript: link`, !j.length);
  }
  const adminJs = read("public/admin.js"), storefrontJs = read("public/storefront.js");
  ok("the label sheets' print pop-ups carry no script: this page prints them when they're ready", (adminJs.match(/printPopupWhenReady_\(pw\);/g) || []).length === 3 && !/window\.onload\s*=/.test(code(adminJs)));

  console.log("\n=== Pages the API writes ===");
  const serverFiles = [];
  const walk = (dir) => { for (const e of fs.readdirSync(path.join(__dirname, dir), { withFileTypes: true })) { const p = dir + "/" + e.name; if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name)) serverFiles.push(p); } };
  walk("functions"); walk("src");
  const withScript = serverFiles.filter(f => /<script\b/i.test(code(read(f))));
  ok("only the downloads page writes a <script>", withScript.join() === "functions/api/download.js");
  const dl = read("functions/api/download.js");
  ok("…allowed by a nonce made for that response, in that response's own policy", /<script nonce="\$\{nonce\}">/.test(dl) && /script-src 'nonce-\$\{nonce\}'/.test(dl) && /crypto\.getRandomValues/.test(dl));
  ok("no page the API writes has an on…=\"\" attribute", serverFiles.every(f => !hits(INLINE_HANDLER, code(read(f))).length));

  console.log("\n=== Every action named is on the list, and every listed one runs something real ===");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const errors = [];
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window, d = w.document;
  w.console.error = (...a) => errors.push(a.join(" "));
  await tick(150);
  await w.loadAdminScript();
  const actions = w.eval("ADMIN_ACTIONS_");
  const names = Object.keys(actions);
  ok("the list is there, every entry a function", names.length > 150 && names.every(n => typeof actions[n] === "function"));
  const used = new Map();
  for (const m of code(adminJs).matchAll(/data-admin-(action|change|input|submit|keydown)="([^"]*)"/g)) {
    if (m[2].includes("${")) continue;
    used.set(m[2], (used.get(m[2]) || 0) + 1);
  }
  const navActions = w.eval("ADMIN_NAV_GROUPS").flatMap(g => g.items.filter(it => !Array.isArray(it)).map(it => it.action));
  ok("the Settings menu's two non-page items are on the list", navActions.length === 2 && navActions.every(a => names.includes(a)));
  ok("the one name built from a value is the menu's (it.action)", [...adminJs.matchAll(/data-admin-[a-z]+="([^"]*\$\{[^"]*)"/g)].every(m => m[1] === "${escapeHtml(it.action)}"));
  const unknown = [...used.keys()].filter(n => !names.includes(n));
  ok(`every data-admin-… name in admin.js is on the list${unknown.length ? " (not: " + unknown.join(", ") + ")" : ""} — ${used.size} names`, !unknown.length && used.size > 150);
  const unused = names.filter(n => !used.has(n) && !navActions.includes(n));
  ok(`every name on the list is used${unused.length ? " (unused: " + unused.join(", ") + ")" : ""}`, !unused.length);
  // A function a screen sets on window when it draws (window.blankEdit = …, the label sheets' print) counts when
  // admin.js sets it somewhere; the button that calls it is only drawn by that screen.
  const setOnWindow = (id) => new RegExp("window\\." + id.replace(/\$/g, "\\$") + "\\s*=[^=]").test(adminJs + storefrontJs);
  const SKIP = new Set(["if", "for", "while", "switch", "return", "function", "Number", "String", "Boolean", "JSON", "Event", "encodeURIComponent", "Object"]);
  const missing = [];
  for (const n of names) {
    const src = actions[n].toString().replace(/^[^{]*\{/, "");
    for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const id = m[2];
      if (SKIP.has(id)) continue;
      if (w.eval("typeof " + id) !== "function" && !setOnWindow(id)) missing.push(n + " → " + id);
    }
    for (const m of src.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (typeof w[m[1]] !== "function" && !setOnWindow(m[1])) missing.push(n + " → window." + m[1]);
    }
  }
  ok(`everything an action calls exists${missing.length ? " (missing: " + missing.join(", ") + ")" : ""}`, !missing.length);

  console.log("\n=== The listener ===");
  const calls = [];
  w.eval(`ADMIN_ACTIONS_.__t1 = function(event){ window.__calls.push(["t1", this.id, event.type]); };
          ADMIN_ACTIONS_.__t2 = function(event){ window.__calls.push(["t2", this.id, event.type]); };
          ADMIN_ACTIONS_.__stop = function(event){ window.__calls.push(["stop", this.id]); event.stopPropagation(); };
          ADMIN_ACTIONS_.__val = function(event){ window.__calls.push(["val", this.value, event.type]); };`);
  w.__calls = calls;
  d.body.insertAdjacentHTML("beforeend", `<div id="outer" data-admin-action="__t2"><button id="inner" data-admin-action="__t1"><span id="label">Go</span></button></div>
    <div id="outer2" data-admin-action="__t2"><button id="stopper" data-admin-action="__stop">Stop</button></div>
    <input id="field" data-admin-change="__val" data-admin-input="__val" data-admin-keydown="__t1" value="a">
    <form id="frm" data-admin-submit="__t1"><button id="sub">Send</button></form>
    <button id="evil1" data-admin-action="toString">x</button><button id="evil2" data-admin-action="alert">y</button><button id="evil3" data-admin-action="__proto__">z</button>`);
  let bubbledTo = null;
  d.getElementById("outer").addEventListener("click", () => bubbledTo = calls.length);
  d.getElementById("label").click();
  ok("a click runs the element's action with `this` the element (from a child of it too)", calls[0] && calls[0].join() === "t1,inner,click");
  ok("…then the action of an element around it, like bubbling", calls[1] && calls[1].join() === "t2,outer,click" && calls.length === 2);
  ok("…both before a listener on an element around it (the order an inline handler had)", bubbledTo === 2);
  calls.length = 0;
  let reached = false;
  d.getElementById("outer2").addEventListener("click", () => reached = true);
  d.getElementById("stopper").click();
  ok("an action that stops the event: nothing around it runs (neither an action nor a listener)", calls.length === 1 && calls[0][0] === "stop" && !reached);
  calls.length = 0;
  const f = d.getElementById("field");
  f.value = "b"; f.dispatchEvent(new w.Event("input", { bubbles: true })); f.dispatchEvent(new w.Event("change", { bubbles: true }));
  f.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  ok("input, change and keydown each run their own attribute's action, with this.value", calls.map(c => c.join()).join("|") === "val,b,input|val,b,change|t1,field,keydown");
  calls.length = 0;
  d.getElementById("frm").addEventListener("submit", (e) => e.preventDefault());
  d.getElementById("sub").click();
  ok("a form's submit runs data-admin-submit", calls.length === 1 && calls[0].join() === "t1,frm,submit");
  calls.length = 0; errors.length = 0;
  let threw = null;
  try { d.getElementById("evil1").click(); d.getElementById("evil2").click(); d.getElementById("evil3").click(); } catch (e) { threw = e; }
  ok("a name that isn't on the list runs nothing (not even an inherited toString, nor window.alert)", !threw && !calls.length && errors.length === 3 && errors.every(e => /No admin action named/.test(e)));

  console.log("\n=== Some real ones, end to end ===");
  d.body.insertAdjacentHTML("beforeend", `<table><tr id="row"><td><button id="rm" data-admin-action="removeRow_">Remove</button></td></tr></table>
    <button id="goShop" data-org="a b" data-admin-action="goShopProducts_">Products</button>
    <a href="#" id="roles" data-admin-action="usersShowRoles_">Roles</a>`);
  d.getElementById("rm").click();
  ok("removeRow_ removes the row the button is in", !d.getElementById("row"));
  d.getElementById("goShop").click();
  ok("goShopProducts_ opens the shop's products, its id encoded", w.location.hash === "#catalog/orgs/a%20b/products");
  let shown = null; w.eval("usersShowTab_ = (t) => { window.__shown = t; }");
  const ev = new w.MouseEvent("click", { bubbles: true, cancelable: true });
  d.getElementById("roles").dispatchEvent(ev);
  shown = w.__shown;
  ok("usersShowRoles_ shows the Roles tab and the link doesn't navigate", shown === "roles" && ev.defaultPrevented);

  console.log("\n=== The storefront's own elements ===");
  const sf = code(storefrontJs);
  const sfActions = [...new Set([...sf.matchAll(/data-action="([^"$]+)"/g)].map(m => m[1]))];
  const sfChanges = [...new Set([...sf.matchAll(/data-change="([^"$]+)"/g)].map(m => m[1]))];
  ok("every data-action in storefront.js is handled by its click listener", sfActions.length >= 10 && sfActions.every(a => sf.includes(`a === "${a}"`)));
  ok("every data-change in storefront.js is handled by its change listener", sfChanges.length === 4 && sfChanges.every(a => sf.includes(`ch === "${a}"`)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
