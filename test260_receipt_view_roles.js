// Receipts open for every role that sees a receipt's View button, and only an editor adds one (review #78).
// /api/receipt used to let a request through only at Edit on expenses, money or payments, for viewing and uploading
// alike, while the View buttons show on read-only screens too: Blanks (a stock movement's receipt), Brand rules
// (an approval's letter), the Account viewer, Expenses and Money. Now viewing (the signed link) needs Read on any of
// those, and uploading still needs Edit on expenses, money or payments. Also: Global settings' Bookkeeping section is
// read at Global settings' read level (getAccountingSettings), as every other section of the page.
// The real sign-in (testlib/auth-harness: adminAuth.js, permissions.js) on real SQL, the real receipt.js. Invented data.
const { makeAuth, prelude, strip, read, request, answer } = require("./testlib/auth-harness");
const R = require("./testlib/roles");

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const A = await makeAuth();
  const receipt = new Function("__hits", prelude(false, false) + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/api/receipt.js")) +
    "\nreturn { post: onRequestPost, get: onRequestGet };")([]);
  const stored = new Map();
  const env = Object.assign(A.env, { SIGNING_SECRET: "signing-secret-for-tests-only", RECEIPTS: {
    put: async (k, b) => { stored.set(k, b); }, get: async (k) => stored.has(k) ? { body: stored.get(k) } : null } });
  const KEY = "receipts/2026/" + "a".repeat(32) + ".pdf";
  const view = async (cookie, key = KEY) => answer(await receipt.post({ request: request("/api/receipt", { key }, { cookie, headers: { "Content-Type": "application/json" } }), env }));
  const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A]);
  const upload = async (cookie) => {
    const req = request("/api/receipt?name=bill.pdf", null, { cookie, headers: { "Content-Type": "application/pdf" } });
    req.arrayBuffer = async () => PDF.buffer.slice(0);
    return answer(await receipt.post({ request: req, env }));
  };

  const admin = await A.firstAdmin();
  const roleUser = async (name, fns, email) => {
    const r = await A.users({ action: "saveRole", name, rank: 30, permissions: { fns } }, admin);
    return A.addUser(admin, r.body.role && r.body.role.key, name + " Sample", email);
  };
  const readers = {
    "Expenses Read": await roleUser("Expense viewer", { "finance.expenses": "read" }, "ev@example.test"),
    "Money Read": await roleUser("Money viewer", { "finance.money": "read" }, "mv@example.test"),
    "Account viewer Read": await roleUser("Account viewer", { "finance.accountviewer": "read" }, "av@example.test"),
    "Payments Read": await roleUser("Payment viewer", { "orders.payments": "read" }, "pv@example.test"),
    "Brand approvals Read": await roleUser("Approvals viewer", { "catalog.brandApprovals": "read" }, "bv@example.test"),
    "Blank stock Read": await roleUser("Blanks viewer", { "inventory.blanks": "read" }, "iv@example.test"),
  };
  const nobody = await roleUser("Counts only", { "home.counts": "read" }, "nv@example.test");
  const editor = await roleUser("Expense editor", { "finance.expenses": "edit" }, "ee@example.test");

  console.log("=== Viewing a receipt: Read on any screen that shows one ===");
  for (const [label, cookie] of Object.entries(readers)) {
    const r = await view(cookie);
    ok(label + ": gets a signed 60-second link", r.status === 200 && r.body.status === "ok" && r.body.url.startsWith("/api/receipt?key=" + encodeURIComponent(KEY) + "&exp="));
  }
  let r = await view(nobody);
  ok("a role with none of them is refused", r.status === 403 && !r.body.url);
  ok("…and the link a reader got opens the file", await (async () => {
    stored.set(KEY, PDF);
    const u = new URL("https://admin.example.com" + (await view(readers["Blank stock Read"])).body.url);
    const res = await receipt.get({ request: { url: u.toString(), headers: { get: () => null } }, env });
    return res.status === 200 && res.headers.get("Content-Type") === "application/pdf";
  })());

  console.log("\n=== Adding a receipt: Edit on expenses, money or payments ===");
  stored.clear();
  for (const [label, cookie] of Object.entries(readers)) {
    r = await upload(cookie);
    ok(label + ": can't upload one (403), nothing stored", r.status === 403 && stored.size === 0);
  }
  r = await upload(editor);
  ok("Expenses Edit uploads it, under a key the server chose", r.status === 200 && /^receipts\/\d{4}\/[a-z0-9]{32}\.pdf$/.test(r.body.key) && stored.has(r.body.key));
  r = await upload(admin);
  ok("…and so does an admin", r.status === 200 && stored.size === 2);
  ok("the gate lists the six read levels; the upload check the three edit levels", (() => {
    const src = read("functions/api/receipt.js");
    return ["finance.expenses", "finance.money", "finance.accountviewer", "orders.payments", "catalog.brandApprovals", "inventory.blanks"].every(f => src.includes(`["${f}", "read"]`)) &&
      ["finance.expenses", "finance.money", "orders.payments"].every(f => src.includes(`adminCan(request, "${f}", "edit")`));
  })());

  console.log("\n=== Global settings → Bookkeeping is read at Global settings' read level ===");
  ok("getAccountingSettings needs Global settings Read; changing it still Edit", JSON.stringify(R.ACTION_PERM.getAccountingSettings) === JSON.stringify([["settings.global", "read"]]) &&
    JSON.stringify(R.ACTION_PERM.updateAccountingSettings) === JSON.stringify([["settings.global", "edit"]]));
  const settingsReader = await roleUser("Settings viewer", { "settings.global": "read" }, "sv@example.test");
  r = await A.orders({ action: "getAccountingSettings" }, settingsReader);
  ok("a Global settings reader loads it (as the page does with the rest)", r.status === 200 && r.body.accounting && typeof r.body.accounting.saleDate === "string");
  r = await A.orders({ action: "updateAccountingSettings", saleDate: "placed" }, settingsReader);
  ok("…but can't change it", r.status === 403);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.log("test260 crashed:", false); console.error(e); process.exit(1); });
