const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { makeAuth } = require("./testlib/auth-harness");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Home's ⚙ (2026-11): each user picks which of Home's blocks show — Orders, Business totals, Money in and out,
// Where the money went, Product sales. The choice is kept on the user's account (users.prefs, migrations/0091;
// admin-users "me" / "savePrefs"), so it's the same in any browser. Hidden blocks' figures aren't asked for or
// worked out (db.js getDashboard `blocks`). Real endpoints and SQL; the page in jsdom.

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

(async () => {
  console.log("=== Kept on the account (admin-users savePrefs / me) ===");
  const A = await makeAuth();
  const pending = (await A.signIn("", A.PRINTED)).cookie;   // the installer's passphrase, account not set up yet
  let r = await A.users({ action: "savePrefs", prefs: { home: { hidden: ["pies"] } } }, pending);
  ok("the installer's passphrase, with no account yet, can't keep settings on the server", r.status >= 400 && r.body.status === "error");
  const admin = await A.firstAdmin();
  const staff = await A.addUser(admin, "staff", "Sam Staff", "sam@myshop.com");
  r = await A.users({ action: "me" }, admin);
  ok("a user with nothing saved gets empty settings with 'me'", r.status === 200 && JSON.stringify(r.body.prefs) === "{}");
  r = await A.users({ action: "savePrefs", prefs: { home: { hidden: ["pies", "inout", "nonsense"] } } }, admin);
  ok("saving keeps the known blocks, in Home's order, and drops what isn't one", r.status === 200 && JSON.stringify(r.body.prefs) === '{"home":{"hidden":["inout","pies"]}}');
  ok("…on that user's own row only", A.user("olive@myshop.com").prefs === '{"home":{"hidden":["inout","pies"]}}' && A.user("sam@myshop.com").prefs == null);
  r = await A.users({ action: "me" }, admin);
  ok("'me' hands them back — from any browser, since they're on the account", JSON.stringify(r.body.prefs) === '{"home":{"hidden":["inout","pies"]}}');
  r = await A.users({ action: "savePrefs", prefs: { home: { hidden: "pies" } } }, staff);
  ok("a list that isn't a list is refused", r.status === 400 && A.user("sam@myshop.com").prefs == null);
  r = await A.users({ action: "savePrefs", prefs: { home: { hidden: ["sales"] } } }, staff);
  ok("any signed-in user may keep their own (Back office too)", r.status === 200 && A.user("sam@myshop.com").prefs === '{"home":{"hidden":["sales"]}}');
  A.d1._raw.exec(`UPDATE users SET prefs = '{"other":{"x":1},"home":{"hidden":["pies"]}}' WHERE email = 'olive@myshop.com'`);
  r = await A.users({ action: "savePrefs", prefs: { home: { hidden: [] } } }, admin);
  ok("saving Home's leaves any other kept setting alone", r.status === 200 && JSON.parse(A.user("olive@myshop.com").prefs).other.x === 1 && JSON.parse(A.user("olive@myshop.com").prefs).home.hidden.length === 0);
  A.d1._raw.exec(`UPDATE users SET prefs = '{"other":"${"x".repeat(5000)}"}' WHERE email = 'olive@myshop.com'`);
  r = await A.users({ action: "savePrefs", prefs: { home: { hidden: [] } } }, admin);
  ok("settings past 4 KB aren't saved", r.status === 400 && /too big/.test(r.body.message));
  ok("the column is there on a migrated database as on a fresh one (0091)", /prefs\s+TEXT/.test(read("schema.sql")) && /ADD COLUMN prefs TEXT/.test(read("migrations/0091_user_prefs.sql")));

  console.log("\n=== Only what's shown is worked out (db.js getDashboard) ===");
  const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { getDashboard, insertOrder };")();
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','P','t','t');`);
  await lib.insertOrder(d1, { orderId: "O1", orgId: "prime", customerName: "C", contact: "c@x.com", paymentMethod: "Venmo", placedAt: new Date().toISOString() },
    [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: 20 }]);
  const seen = [], prepare = d1.prepare.bind(d1);
  d1.prepare = (sql) => { seen.push(sql); return prepare(sql); };
  const today = new Date().toISOString().slice(0, 10), t0 = Date.now();
  const sqlRan = (re) => seen.some(s => re.test(s));
  const clear = () => { seen.length = 0; d1._raw.run("DELETE FROM global_settings WHERE key = 'dashboardCache'"); };
  clear();
  let d = await lib.getDashboard(d1, { today, blocks: ["orders"], now: t0 });
  ok("Orders alone: the counts, and no money asked for or worked out", d.stages && d.open === 1 && !("year" in d) && !("inOut" in d)
    && !sqlRan(/other_income|owner_transactions|expense_categories|inventory_movements|order_payments p JOIN/) && d.blocks.join() === "orders");
  clear();
  d = await lib.getDashboard(d1, { today, blocks: ["totals"], now: t0 });
  ok("Business totals alone: the money, without the expenses by category, the months or the orders", d.year && !d.year.byType && !("inOut" in d) && !("stages" in d)
    && !sqlRan(/expense_categories c ON c\.id = e\.categoryId\s+WHERE e\.deletedAt IS NULL AND e\.expenseDate >= \? AND e\.expenseDate <= \? GROUP BY e\.categoryId/) && !sqlRan(/owner_transactions/));
  seen.length = 0;
  d = await lib.getDashboard(d1, { today, blocks: ["totals"], now: t0 + 1000 });
  ok("asked again within the hour, it's the kept part, no new work", d.cached === true && !sqlRan(/order_items|expenses/));
  seen.length = 0;
  d = await lib.getDashboard(d1, { today, blocks: ["totals", "pies", "inout"], now: t0 + 2000 });
  ok("showing the pies and the months works out just those (the kept money had no categories)", d.cached === false && Array.isArray(d.year.byType) && d.inOut && d.inOut.months.length >= 1
    && sqlRan(/GROUP BY e\.categoryId/) && sqlRan(/owner_transactions/) && !("stages" in d));
  seen.length = 0;
  d = await lib.getDashboard(d1, { today, blocks: ["totals"], now: t0 + 3000 });
  ok("…and the kept money with categories still serves Business totals alone (without handing the slices back)", d.cached === true && !d.year.byType && seen.every(s => !/FROM expenses/.test(s)));
  seen.length = 0;
  d = await lib.getDashboard(d1, { today, blocks: ["totals"], fresh: true, now: t0 + 4000 });
  ok("Refresh works out only what's shown", d.cached === false && !sqlRan(/owner_transactions|GROUP BY e\.categoryId/));
  d = await lib.getDashboard(d1, { today, now: t0 + 5000 });
  ok("no blocks named: everything, as before", d.stages && d.year && Array.isArray(d.year.byType) && d.inOut && d.blocks.length === 6);   // 6: Unpaid POs (phase 7)
  d = await lib.getDashboard(d1, { today, blocks: [], now: t0 + 6000 });
  ok("nothing shown: nothing worked out", !d.stages && !d.year && !d.inOut && d.blocks.length === 0);

  console.log("\n=== Back office (getDashboard as staff) ===");
  r = await A.orders({ action: "getDashboard", today, blocks: ["orders", "totals", "inout"] }, staff);
  ok("staff asking for money blocks still get only the order counts", r.status === 200 && r.body.blocks.join() === "orders" && !("year" in r.body) && !("inOut" in r.body));
  r = await A.orders({ action: "getDashboard", today, blocks: [] }, staff);
  ok("…and with Orders hidden, nothing", r.status === 200 && !("stages" in r.body));

  console.log("\n=== The ⚙ on Home (jsdom) ===");
  // A stand-in server: getDashboard on the real db.js (counting what each call asks for), and "me" / "savePrefs"
  // keeping one account's settings — as the real endpoints above do.
  let saved = {}, asked = [];
  const answer = async (url, b) => {
    if (/admin-users/.test(url)) {
      if (b.action === "me") return { status: "ok", user: { id: 1, name: "Olive", email: "olive@myshop.com", role: "admin" }, prefs: saved };
      if (b.action === "savePrefs") { saved = Object.assign({}, saved, b.prefs); return { status: "ok", prefs: saved }; }
    }
    if (b.action === "getDashboard") { asked.push(b.blocks); return Object.assign({ status: "ok" }, await lib.getDashboard(d1, { today: b.today, blocks: b.blocks, fresh: b.fresh })); }
    return { status: "ok" };
  };
  const browser = async () => {
    const adminJs = read("public/admin.js");
    class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
    const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
      beforeParse(win){ win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; const x = await answer(String(u), b);
        return { ok: true, status: 200, json: async () => x, text: async () => JSON.stringify(x) }; }; } });
    const w = dom.window;
    await new Promise(x => setTimeout(x, 150));
    await w.loadAdminScript();
    w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "prime", name: "P" }];');
    await w.refreshAdminMe_();
    return w;
  };
  const wait = async (fn, n = 300) => { for (let i = 0; i < n && !fn(); i++) await new Promise(x => setTimeout(x, 10)); return fn(); };
  const blocksOn = (w) => [...w.document.querySelectorAll("[data-home-block]")].map(e => e.dataset.homeBlock).join();
  const home = async (w, expect) => { w.history.replaceState(null, "", "#home"); await w.adminRoute(); await wait(() => blocksOn(w) === expect); return blocksOn(w); };

  let w = await browser();
  ok("Home starts with every block, top to bottom", (await home(w, "orders,totals,unpaidpos,inout,pies,sales")) === "orders,totals,unpaidpos,inout,pies,sales");
  const cog = w.document.getElementById("homeCog");
  ok("a ⚙ in the corner says what it does", !!cog && cog.getAttribute("aria-label") === "Choose what Home shows");
  cog.click();
  const boxes = () => [...w.document.querySelectorAll(".admin-modal [data-block]")];
  ok("it opens a window with a checkbox per block, all ticked", boxes().map(c => c.dataset.block + (c.checked ? "+" : "-")).join() === "orders+,totals+,unpaidpos+,inout+,pies+,sales+");
  boxes().find(c => c.dataset.block === "inout").checked = false;
  boxes().find(c => c.dataset.block === "pies").checked = false;
  asked = [];
  w.document.getElementById("homeLayoutSave").click();
  await wait(() => !w.document.querySelector(".admin-modal") && blocksOn(w) === "orders,totals,unpaidpos,sales");
  ok("Save hides them at once, without reloading the page", blocksOn(w) === "orders,totals,unpaidpos,sales" && !w.document.querySelector(".home-inout") && !w.document.querySelector(".home-pie"));
  ok("…keeps the choice on the account", JSON.stringify(saved) === '{"home":{"hidden":["inout","pies"]}}');
  ok("…and asks the server only for the blocks still shown", asked.length === 1 && asked[0].join() === "orders,totals,unpaidpos,sales");

  w = await browser();   // another browser, same user: nothing kept in it
  asked = [];
  ok("another browser signed in as the same user opens Home the same way", (await home(w, "orders,totals,unpaidpos,sales")) === "orders,totals,unpaidpos,sales" && asked[0].join() === "orders,totals,unpaidpos,sales");
  w.document.getElementById("homeCog").click();
  ok("…and its ⚙ shows the hidden ones unticked", boxes().map(c => c.checked ? 1 : 0).join("") === "111001");
  w.document.getElementById("homeLayoutAll").click();
  asked = [];
  w.document.getElementById("homeLayoutSave").click();
  await wait(() => blocksOn(w) === "orders,totals,unpaidpos,inout,pies,sales");
  ok("Show all brings them back, fetching them then", blocksOn(w) === "orders,totals,unpaidpos,inout,pies,sales" && asked[0].join() === "orders,totals,unpaidpos,inout,pies,sales" && !!w.document.querySelector(".home-pie"));

  w.document.getElementById("homeCog").click();
  boxes().forEach(c => { c.checked = false; });
  asked = [];
  w.document.getElementById("homeLayoutSave").click();
  await wait(() => !!w.document.getElementById("homeAllHidden"));
  ok("everything hidden: one line says how to bring them back, and nothing is fetched", /use ⚙/.test(w.document.getElementById("homeAllHidden").textContent) && !blocksOn(w) && asked.length === 0);
  ok("…the ⚙ is still there", !!w.document.getElementById("homeCog"));

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.log("test196 crashed:", false); console.error(e); process.exit(1); });
