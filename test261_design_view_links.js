// A signed link to a private file goes only to a role that may see that kind of file (review #80). /api/design signs a
// 60-second download link for three families of files in the private bucket: designs/… (a design version's files),
// order-files/… (an order line's own files, which may be a customer's photo) and digital/… (a digital product's
// files). It used to sign any of them for a role passing its gate on any one of five read permissions, so a role that
// sees only designs could open a customer's upload. Now each family has its own readers:
//   designs/     Designs, Order details, the Run and Transfer queues, Machine files (Run Order shows designs)
//   order-files/ Order details, the Run and Transfer queues, Machine files
//   digital/     Digital product files, an order's digital downloads
// and a key of no family, or a role with none of them, is refused. The real sign-in (testlib/auth-harness:
// adminAuth.js, permissions.js) on real SQL, the real design.js. Invented data.
const { makeAuth, prelude, strip, read, request, answer } = require("./testlib/auth-harness");

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const A = await makeAuth();
  const design = new Function("__hits", prelude(false, false) + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/api/design.js")) +
    "\nreturn { post: onRequestPost };")([]);
  const env = Object.assign(A.env, { SIGNING_SECRET: "signing-secret-for-tests-only", DESIGNS: { put: async () => {}, get: async () => null } });
  const K = {
    design: "designs/12/" + "a".repeat(32) + ".dst",
    order: "order-files/55/" + "b".repeat(32) + ".png",
    digital: "digital/shop1/club-logo/" + "c".repeat(32) + ".pdf",
  };
  const link = async (cookie, key) => answer(await design.post({ request: request("/api/design", { key }, { cookie, headers: { "Content-Type": "application/json" } }), env }));
  const opens = async (cookie) => {
    const out = {};
    for (const [fam, key] of Object.entries(K)) {
      const r = await link(cookie, key);
      out[fam] = r.status === 200 && r.body.status === "ok" && r.body.url.startsWith("/api/design?key=" + encodeURIComponent(key)) ? "ok" : r.status;
    }
    return out;
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const admin = await A.firstAdmin();
  const roleUser = async (name, fns, email) => {
    const r = await A.users({ action: "saveRole", name, rank: 30, permissions: { fns } }, admin);
    return A.addUser(admin, r.body.role && r.body.role.key, name + " Sample", email);
  };

  console.log("=== Which families each reader opens ===");
  ok("an admin opens all three", same(await opens(admin), { design: "ok", order: "ok", digital: "ok" }));
  const designs = await roleUser("Design viewer", { "catalog.designs": "read" }, "dv@example.test");
  ok("Designs Read: design files only — not an order's files nor a digital product's", same(await opens(designs), { design: "ok", order: 403, digital: 403 }));
  const details = await roleUser("Order viewer", { "orders.details": "read" }, "ov@example.test");
  ok("Order details Read: design files and an order's files, not a digital product's", same(await opens(details), { design: "ok", order: "ok", digital: 403 }));
  const runQueue = await roleUser("Run queue viewer", { "run.queue": "read" }, "rv@example.test");
  ok("Run queue Read: design files and an order's files", same(await opens(runQueue), { design: "ok", order: "ok", digital: 403 }));
  const transfers = await roleUser("Transfer queue viewer", { "transfer.queue": "read" }, "tv@example.test");
  ok("Transfer queue Read: the same", same(await opens(transfers), { design: "ok", order: "ok", digital: 403 }));
  const machineFiles = await roleUser("Machine files viewer", { "production.machinefiles": "read" }, "mv@example.test");
  ok("Machine files Read: the same", same(await opens(machineFiles), { design: "ok", order: "ok", digital: 403 }));
  const productFiles = await roleUser("Product files viewer", { "catalog.productFiles": "read" }, "pv@example.test");
  ok("Digital product files Read: a digital product's files only", same(await opens(productFiles), { design: 403, order: 403, digital: "ok" }));
  const downloads = await roleUser("Downloads viewer", { "orders.downloads": "read" }, "lv@example.test");
  ok("Digital downloads Read: a digital product's files only", same(await opens(downloads), { design: 403, order: 403, digital: "ok" }));
  const nobody = await roleUser("Counts only", { "home.counts": "read" }, "nv@example.test");
  ok("a role with none of them opens nothing", same(await opens(nobody), { design: 403, order: 403, digital: 403 }));

  console.log("\n=== Other keys, and uploads ===");
  let r = await link(admin, "receipts/2026/" + "d".repeat(32) + ".pdf");
  ok("a key of no family is refused before any role check", r.status === 400);
  const up = async (cookie, qs) => {
    const req = request("/api/design?" + qs, null, { cookie, headers: { "Content-Type": "application/octet-stream" } });
    req.arrayBuffer = async () => new Uint8Array([1, 2, 3, 4]).buffer;
    return answer(await design.post({ request: req, env }));
  };
  r = await up(productFiles, "itemId=5&ext=dst&name=a.dst");
  ok("getting past the gate to open digital files doesn't let a role upload to an order (403)", r.status === 403);
  r = await up(downloads, "designId=12&role=machine&ext=dst&name=a.dst");
  ok("…nor to a design (403)", r.status === 403);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.log("test261 crashed:", false); console.error(e); process.exit(1); });
