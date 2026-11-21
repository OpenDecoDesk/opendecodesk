// When the storefront can't get its catalog (a passing server error, or no connection), the visitor
// sees "We couldn't load this page" with a Try again button, not the "your link may be mistyped" page.
// That page is kept for the server's real "no shop at this address" answer (404). Invented data only.
const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");
const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const business = { name: "Pine Hollow Stitch Co", supportEmail: "help@example.com" };

async function load(url, catalog){
  const vc = new VirtualConsole(); // quiet: the page logs the failed fetch on purpose
  const dom = new JSDOM(html, { runScripts: "dangerously", url, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win){
      win.fetch = async (u) => {
        if (String(u).includes("/api/catalog")) return catalog();
        if (String(u).includes("/api/verify")) return { ok: true, status: 200, json: async () => ({ status: "error" }) };
        return { ok: true, status: 200, json: async () => ({}) };
      };
      win.alert = () => {};
    } });
  await wait(250);
  const app = dom.window.document.getElementById("app");
  return { w: dom.window, d: dom.window.document, text: app.textContent.replace(/\s+/g, " ") };
}
const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

(async () => {
  let s = await load("https://shop.example.com/", reply(503, { status: "error", message: "Catalog temporarily unavailable" }));
  ok("a 503 from the catalog shows 'We couldn't load this page'", /We couldn't load this page/.test(s.text));
  ok("…not the 'link may be mistyped' page", !/mistyped|Looking for your organization/.test(s.text));
  const btn = s.d.getElementById("loadErrorRetry");
  ok("…with a Try again button", !!btn && btn.tagName === "BUTTON" && /Try again/.test(btn.textContent));
  ok("…and the message is announced", s.d.getElementById("loadError").getAttribute("role") === "alert");

  s = await load("https://shop.example.com/", async () => { throw new TypeError("Failed to fetch"); });
  ok("no connection at all shows the same retry page", /We couldn't load this page/.test(s.text) && !!s.d.getElementById("loadErrorRetry"));

  s = await load("https://shop.example.com/", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }));
  ok("a reply that isn't the catalog shows the retry page too", /We couldn't load this page/.test(s.text));

  s = await load("https://admin.example.com/", reply(500, {}));
  ok("on the admin address a passing error shows the retry page, not the public 'not found' page", /We couldn't load this page/.test(s.text) && !/mistyped/.test(s.text));

  s = await load("https://nowhere.example.com/", reply(404, { status: "error", message: "Unrecognized host", business }));
  ok("the server's real 'unknown host' (404) still shows the generic page", /Looking for your organization/.test(s.text) && !s.d.getElementById("loadErrorRetry"));
  ok("…with the business's name from that reply", /Pine Hollow Stitch Co/.test(s.text));

  s = await load("https://nowhere.example.com/", reply(200, { status: "error", message: "Unknown org", business }));
  ok("an 'Unknown org' answer still shows the generic page", /Looking for your organization/.test(s.text));

  s = await load("https://shop.example.com/?verify=tok999", reply(503, {}));
  ok("a design-approval link still opens its own page when the catalog is down", /invalid or has expired/.test(s.text) && !/We couldn't load this page/.test(s.text));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
