const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Reads that shop and admin pages wait on, made smaller or at the same time:
// - The shop page's "ready to decorate" counts read what's set aside of just the blanks that shop's products use
//   (every shop's orders still count: a blank is shared stock), and nothing at all for a shop with no blank links.
// - An order list and a single order ask D1 for their lines, payments, labels, shipments and invoices together, not
//   one after another — with the same answer as before.
// - The admin's script is loaded under a version of its content, so the browser keeps it between deploys.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + `\nreturn { createProduct, createBlank, setBlankLink, insertOrder, settleOrderBalance, getBlankReservations,
  getBlankReadyByOrg, getOrderById, getOrdersByOrg, addOrderPayment };`)();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('oak','oak','Oak Club','t','t',1), ('elm','elm','Elm Club','t','t',1), ('ash','ash','Ash Club','t','t',1);`);
  // One tee blank shared by Oak and Elm; a cap blank only Elm uses.
  const tee = (await lib.createBlank(d1, { name: "Plain Tee", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "M", purchasePrice: 3, quantity: 10 }] }] })).id;
  const cap = (await lib.createBlank(d1, { name: "Plain Cap", productType: "cap", colors: [{ color: "Royal", images: [], sizes: [{ size: "OSFA", purchasePrice: 4, quantity: 8 }] }] })).id;
  for (const org of ["oak", "elm"]) {
    await lib.createProduct(d1, org, { productId: "tee", type: "shirt", name: "Tee", pricingMode: "sized", sizePricing: { M: 20 }, visible: true, noDesignNeeded: true });
    await lib.setBlankLink(d1, org, "tee", "", "M", tee, "Navy", "M");
  }
  await lib.createProduct(d1, "elm", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true });
  await lib.setBlankLink(d1, "elm", "cap", "", "OSFA", cap, "Royal", "OSFA");
  await lib.createProduct(d1, "ash", { productId: "mug", type: "other", name: "Mug", pricingMode: "flat", flatPrice: 9, visible: true, noDesignNeeded: true });
  // Elm's order for 3 tees and 2 caps, its blanks in (received): those are set aside.
  await lib.insertOrder(d1, { orderId: "ELM-1", orgId: "elm", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-11-01T15:00:00.000Z" },
    [{ productId: "tee", name: "Tee", type: "shirt", size: "M", qty: 3, unitPrice: 20 }, { productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 2, unitPrice: 15 }]);
  d1._raw.exec(`UPDATE orders SET blankReceivedAt = '2026-11-02T00:00:00Z' WHERE orderId = 'ELM-1'`);

  console.log("=== The shop page's blank counts read only that shop's blanks ===");
  const all = await lib.getBlankReservations(d1);
  const onlyTee = await lib.getBlankReservations(d1, { blankIds: [tee] });
  ok("scoped to the tee blank: the same count as reading everything, and nothing else", onlyTee[`${tee}|Navy|M`] === 3 && all[`${tee}|Navy|M`] === 3 && all[`${cap}|Royal|OSFA`] === 2 &&
    Object.keys(onlyTee).join() === `${tee}|Navy|M`);
  const sqls = [];
  const DB = { prepare: (q) => { sqls.push(q); return d1.prepare(q); } };
  const oak = await lib.getBlankReadyByOrg(DB, "oak");
  ok("Oak's tee counts Elm's order too (shared stock): 10 on hand, 3 set aside, 7 ready", oak.tee[""].M === 7);
  ok("…reading only links to Oak's blanks", sqls.some(q => /FROM product_blank_links WHERE blankId IN \(SELECT value FROM json_each/.test(q)) &&
    !sqls.some(q => /FROM product_blank_links\s*$/.test(q.trim())));
  ok("Elm's counts are unchanged: 7 tees, 6 caps", (r => r.tee[""].M === 7 && r.cap[""][""] === 6)(await lib.getBlankReadyByOrg(d1, "elm")));
  sqls.length = 0;
  ok("a shop with no blank links: nothing, and no reservations read", Object.keys(await lib.getBlankReadyByOrg(DB, "ash")).length === 0 && !sqls.some(q => /order_items/.test(q)));
  ok("no blanks named: nothing read", Object.keys(await lib.getBlankReservations(d1, { blankIds: [] })).length === 0);

  console.log("\n=== The shop page's three fresh reads run together ===");
  const src = read("functions/api/catalog.js");
  ok("catalog.js asks for stock, files and blank counts in one Promise.all", /Promise\.all\(\[\s*settle\(\(\) => getReadyToShipByOrg/.test(src) && /settle\(\(\) => getBlankReadyByOrg/.test(src));

  console.log("\n=== An order's parts are asked for together, with the same answer ===");
  await lib.addOrderPayment(d1, "ELM-1", 10, "Cash");
  let inFlight = 0, most = 0;
  const slow = {
    prepare: (q) => {
      const st = d1.prepare(q);
      const wrap = (s) => ({
        bind: (...a) => wrap(s.bind(...a)),
        all: async () => { inFlight++; most = Math.max(most, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--; return s.all(); },
        first: async (c) => { inFlight++; most = Math.max(most, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--; return s.first(c); },
        run: () => s.run(),
      });
      return wrap(st);
    },
    batch: (s) => d1.batch(s),
  };
  const plain = await lib.getOrderById(d1, "ELM-1");
  most = 0;
  const viaSlow = await lib.getOrderById(slow, "ELM-1");
  ok("getOrderById: the same order", JSON.stringify(plain) === JSON.stringify(viaSlow) && plain.items.length === 2);
  ok("…its lines, payments, labels, shipments and invoices asked for at once (4 or more at a time)", most >= 4);
  const a = await lib.getOrdersByOrg(d1, "elm");
  most = 0;
  const b = await lib.getOrdersByOrg(slow, "elm");
  ok("an order list: the same orders", JSON.stringify(a) === JSON.stringify(b) && a.length === 1 && a[0].payments.length === 1);
  ok("…its parts asked for at once (4 or more at a time)", most >= 4);

  console.log("\n=== The admin's script is kept by the browser between deploys ===");
  const page = read("public/index.html");
  ok("index.html no longer loads admin.js under a new address on every visit", !/"admin\.js\?v=" \+ Date\.now\(\)/.test(page));
  ok("…it loads it under the version /api/catalog gives (fresh only when none is known)", /adminScriptVersion_ = typeof data\.adminScript === "string"/.test(page) &&
    /s\.src = "admin\.js" \+ \(adminScriptVersion_ \? "\?v=" \+ encodeURIComponent\(adminScriptVersion_\) : "\?t=" \+ Date\.now\(\)\)/.test(page));
  const { ADMIN_ORIGIN } = require("./testlib/hosts.js");
  const catalog = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const getCatalogData = async () => ({ subdomainMap: {}, orgs: {}, business: {}, features: {} });\n" +
    "const getReadyToShipByOrg = async () => [], getBlankReadyByOrg = async () => ({}), getDraftCatalogShop = async () => null, verifyPreviewToken = async () => false;\n" +
    strip(read("functions/api/catalog.js")) + "\nreturn onRequestGet;")();
  const answer = async (env, origin = ADMIN_ORIGIN) => JSON.parse(await (await catalog({ request: { url: origin + "/api/catalog" }, env })).text());
  let asked = null;
  const assets = (etag) => ({ fetch: async (req) => { asked = req; return new Response(null, { status: 200, headers: etag ? { ETag: etag } : {} }); } });
  let ans = await answer({ DB: d1, ASSETS: assets('"3f9a0c7e1b"') });
  ok("the admin's answer names admin.js's version: its ETag (a hash of the file)", ans.status === "admin" && ans.adminScript === "3f9a0c7e1b" &&
    asked && asked.method === "HEAD" && new URL(asked.url).pathname === "/admin.js");
  ans = await answer({ DB: d1, ASSETS: assets('W/"abc123"') });
  ok("…a weak ETag too, as letters and digits only", ans.adminScript === "Wabc123");
  ans = await answer({ DB: d1, EDITION: "desktop", DESKTOP_VERSION: "2026.11.01.01" }, "http://localhost:47830");
  ok("the desktop program without an ETag: its version (changes with each update)", ans.status === "admin" && ans.adminScript === "desktop-2026.11.01.01");
  ans = await answer({ DB: d1, EDITION: "desktop" }, "http://localhost:47830");
  ok("…a development copy (dev), and nothing known: none, so the page loads it fresh", ans.adminScript === "" && (await answer({ DB: d1 })).adminScript === "");
  ans = await answer({ DB: d1, ASSETS: { fetch: async () => { throw new Error("down"); } } });
  ok("the assets layer failing doesn't stop the admin's answer", ans.status === "admin" && ans.adminScript === "");

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); console.log("test crashed:", false); process.exit(1); });
