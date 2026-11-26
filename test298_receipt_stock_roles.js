// Opening a vendor receipt from Blanks or Transfers (owner's rule, 2026-11-23: Read on Blanks = stock and details only,
// no money). A stock movement's receipt is the vendor's invoice, with unit prices and totals. /api/receipt used to sign
// a link for anyone with Read on Blanks, and not at all for Transfers (whose sheets carry receipts too). Now, through
// Blanks or Transfers, a role needs Edit there (it receives that stock) or Read there together with costs.view (Money,
// costs and margins) — the roles orders.js still sends a movement's receipt to (test297). Read there alone is refused.
// The other screens with a receipt's View button (expenses, money, the account viewer, payments, brand approvals) are
// unchanged (test260), and adding a receipt still needs Edit on expenses, money or payments.
// The real sign-in (testlib/auth-harness: adminAuth.js, permissions.js) on real SQL, the real receipt.js. Invented data.
const { makeAuth, prelude, strip, read, request, answer } = require("./testlib/auth-harness");

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const A = await makeAuth();
  const receipt = new Function("__hits", prelude(false, false) + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/api/receipt.js")) +
    "\nreturn { post: onRequestPost, get: onRequestGet };")([]);
  const stored = new Map();
  const env = Object.assign(A.env, { SIGNING_SECRET: "signing-secret-for-tests-only", RECEIPTS: {
    put: async (k, b) => { stored.set(k, b); }, get: async (k) => stored.has(k) ? { body: stored.get(k) } : null } });
  const KEY = "receipts/2026/" + "e".repeat(32) + ".pdf";
  const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A]);
  stored.set(KEY, PDF);
  const view = async (cookie) => answer(await receipt.post({ request: request("/api/receipt", { key: KEY }, { cookie, headers: { "Content-Type": "application/json" } }), env }));
  const upload = async (cookie) => {
    const req = request("/api/receipt?name=bill.pdf", null, { cookie, headers: { "Content-Type": "application/pdf" } });
    req.arrayBuffer = async () => PDF.buffer.slice(0);
    return answer(await receipt.post({ request: req, env }));
  };
  const admin = await A.firstAdmin();
  let n = 0;
  // Each case its own role (a short name of its own; the label is only what's printed) and user.
  const roleUser = async (label, fns) => {
    n++;
    const r = await A.users({ action: "saveRole", name: "Stock role " + n, rank: 30, permissions: { fns } }, admin);
    if (!r.body.role) console.log("   role not saved for " + label + ":", JSON.stringify(r.body));
    return A.addUser(admin, r.body.role && r.body.role.key, "Stock Sample " + n, "stock" + n + "@example.test");
  };

  console.log("=== Through Blanks or Transfers: Edit there, or Read there with costs.view ===");
  const allowed = {
    "Blanks Read + costs.view": { "inventory.blanks": "read", "costs.view": "read" },
    "Blanks Edit": { "inventory.blanks": "edit" },
    "Blanks Full": { "inventory.blanks": "full" },
    "Transfers Read + costs.view": { "inventory.transfers": "read", "costs.view": "read" },
    "Transfers Edit": { "inventory.transfers": "edit" },
    "Blanks Read + Expenses Read, through Expenses": { "inventory.blanks": "read", "finance.expenses": "read" },
  };
  for (const [label, fns] of Object.entries(allowed)) {
    const cookie = await roleUser(label, fns);
    const r = await view(cookie);
    ok(label + ": gets a signed link", r.status === 200 && r.body.status === "ok" && String(r.body.url).startsWith("/api/receipt?key="));
    if (label === "Blanks Edit") {
      const u = new URL("https://admin.example.com" + r.body.url);
      const res = await receipt.get({ request: { url: u.toString(), headers: { get: () => null } }, env });
      ok("…and the link opens the file", res.status === 200 && res.headers.get("Content-Type") === "application/pdf");
      const up = await upload(cookie);
      ok("…but Edit on Blanks still can't add a receipt (403)", up.status === 403);
    }
  }

  console.log("\n=== Read there alone: refused ===");
  const refused = {
    "Blanks Read": { "inventory.blanks": "read" },
    "Transfers Read": { "inventory.transfers": "read" },
    "Blanks Read + Transfers Read": { "inventory.blanks": "read", "inventory.transfers": "read" },
    "costs.view alone, no screen with a receipt": { "costs.view": "read" },
  };
  for (const [label, fns] of Object.entries(refused)) {
    const r = await view(await roleUser(label, fns));
    ok(label + ": 403, no link", r.status === 403 && !r.body.url);
    if (label === "Blanks Read") ok("…told why, in a plain sentence", r.body.code === "forbidden" && /^Your role can't see what stock cost, so it can't open vendor receipts\. Ask an admin\.$/.test(r.body.message));
  }
  ok("the owner (admin) still gets one", (await view(admin)).status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.log("test298 crashed:", false); console.error(e); process.exit(1); });
