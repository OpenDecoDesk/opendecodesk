const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Blanks → Use blanks for past orders reads only the history it needs (2026-11, review round 2). The plan replays each
// line's blank / color / size in date order to price it at the cost the blank had then; it used to read EVERY stock
// movement ever recorded (and every blank size and blank) whenever one line qualified. Now it reads the movements of
// the candidate lines' blank / color / size only, up to the latest line's date (on idx_movements_blank_color), and only
// those blanks' sizes and names. The plan must not change: the same lines and costs with or without unrelated blanks
// and later movements, and the apply writes exactly what the preview showed.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, receiveBlanks, writeOffBlanks, planBlankCatchUp };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + require("./testlib/roles").adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// The shop's polo is made from blank 1 (Navy S and M); blank 2 (a cap) and blank 1's size L have nothing to do with it.
// `noise`: the unrelated history — blank 2's receipts and use, blank 1 L, and blank 1's receipts and counts AFTER the
// last line was made (they can't change what those lines cost then).
async function build(noise) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Prime Club','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPrice, sizePricing, createdAt, updatedAt) VALUES
      ('polo','prime','shirt','Polo','sized',NULL,'{"S":23,"M":23,"L":23}','t','t'), ('cap','prime','cap','Cap','flat',12,'{}','t','t');
    INSERT INTO blanks (id, name, brand, color, createdAt, updatedAt) VALUES (1,'Plain polo','Example','Navy','t','t'), (2,'Plain cap','Example','Red','t','t');
    INSERT INTO blank_sizes (blankId, size, purchasePrice, quantity) VALUES (1,'S',0,0),(1,'M',0,0),(1,'L',0,0),(2,'OSFA',0,0);
    INSERT INTO product_blank_links (orgId, productId, productSize, blankId, blankSize) VALUES ('prime','polo','S',1,'S'),('prime','polo','M',1,'M');
  `);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const order = async (id, size, qty, made) => {
    await lib.insertOrder(d1, { orderId: id, orgId: "prime", customerName: "Cust " + id, contact: id + "@example.test", placedAt: "2026-07-01T00:00:00Z" },
      [{ productId: "polo", name: "Polo", type: "shirt", size, qty, unitPrice: 23 }]);
    d1._raw.run("UPDATE orders SET manufacturedAt=? WHERE orderId=?", [made, id]);
  };
  await lib.receiveBlanks(d1, { blankId: 1, lines: [{ size: "S", qty: 5, unitCost: 3.00 }], receivedAt: "2026-08-01T12:00:00.000Z" });
  await lib.receiveBlanks(d1, { blankId: 1, lines: [{ size: "S", qty: 5, unitCost: 5.00 }], receivedAt: "2026-08-15T12:00:00.000Z" });
  await lib.receiveBlanks(d1, { blankId: 1, lines: [{ size: "M", qty: 2, unitCost: 6.00 }], receivedAt: "2026-08-25T12:00:00.000Z" });
  if (noise) {
    for (let i = 0; i < 12; i++) await lib.receiveBlanks(d1, { blankId: 2, lines: [{ size: "OSFA", qty: 3, unitCost: 2 + i }], receivedAt: `2026-0${1 + (i % 8)}-1${i % 9}T12:00:00.000Z` });
    await lib.writeOffBlanks(d1, { blankId: 2, size: "OSFA", qty: 2, occurredAt: "2026-08-12T00:00:00.000Z", reason: "damaged" });
    await lib.receiveBlanks(d1, { blankId: 1, lines: [{ size: "L", qty: 4, unitCost: 9.00 }], receivedAt: "2026-08-02T12:00:00.000Z" });
    // After the last line was made: a receipt at a very different cost and a count, which the old plan read and ignored.
    // (Not of M: the line made before any M came in is priced at M's cost today, which a receipt would change.)
    await lib.receiveBlanks(d1, { blankId: 1, lines: [{ size: "S", qty: 10, unitCost: 40.00 }], receivedAt: "2026-10-01T12:00:00.000Z" });
    await lib.writeOffBlanks(d1, { blankId: 1, size: "S", qty: 1, occurredAt: "2026-10-02T00:00:00.000Z", reason: "damaged" });
  }
  await order("A", "S", 2, "2026-08-10T12:00:00.000Z");
  await order("B", "S", 1, "2026-08-20T12:00:00.000Z");
  await order("F", "M", 1, "2026-09-01T12:00:00.000Z");
  await order("H", "M", 1, "2026-08-01T00:00:00.000Z");   // made before any M came in: the blank's current cost
  return d1;
}
// Every query and the rows it returned.
function spying(d1) {
  const log = [];
  const wrap = (st, e) => ({ bind: (...a) => { e.args = a; return wrap(st.bind(...a), e); },
    all: async () => { const r = await st.all(); e.rows = r.results || []; return r; }, first: (c) => st.first(c), run: () => st.run() });
  return { log, db: { prepare: (sql) => { const e = { sql, args: [], rows: [] }; log.push(e); return wrap(d1.prepare(sql), e); }, batch: (l) => d1.batch(l) } };
}
const shape = (plan) => JSON.stringify(plan.lines.map(l => [l.orderId, l.qty, l.blankSize, l.unitCostCents, l.costCents, l.costNote, l.shortBy, l.useDate]));

(async () => {
  const clean = await build(false), noisy = await build(true);
  const planClean = await lib.planBlankCatchUp(clean);
  const s = spying(noisy);
  const planNoisy = await lib.planBlankCatchUp(s.db);

  console.log("=== The plan is the same ===");
  ok("four lines, priced at the blank's cost on the day each was made (A $3, B $4.25, H the current M cost $6, F $6)",
    shape(planClean) === JSON.stringify([["H", 1, "M", 600, 600, "no purchase yet on that date — used the blank's current cost", 1, "2026-08-01T00:00:00.000Z"],
      ["A", 2, "S", 300, 600, "", 0, "2026-08-10T12:00:00.000Z"], ["B", 1, "S", 425, 425, "", 0, "2026-08-20T12:00:00.000Z"], ["F", 1, "M", 600, 600, "", 0, "2026-09-01T12:00:00.000Z"]])
    || (console.log("   ", shape(planClean)), false));
  ok("…and exactly the same with unrelated blanks, another size and later movements in the history", shape(planNoisy) === shape(planClean) &&
    planNoisy.totalCents === planClean.totalCents && planNoisy.shortLines === planClean.shortLines && planNoisy.lines.every(l => l.blankName === "Plain polo"));

  console.log("\n=== Only the history it needs is read ===");
  const mvRead = s.log.filter(e => /FROM[\s\S]*inventory_movements/.test(e.sql) && /qtyDelta/.test(e.sql));
  const rows = mvRead.flatMap(e => e.rows);
  const total = noisy.q("SELECT COUNT(*) n FROM inventory_movements")[0].n;
  ok(`the movements read: blank 1 S and M up to the last line's date — 3 of the ${total} recorded`, mvRead.length === 1 && rows.length === 3 &&
    rows.every(r => Number(r.blankId) === 1 && ["S", "M"].includes(r.size) && r.occurredAt <= "2026-09-01T12:00:00.000Z"));
  const sizesRead = s.log.filter(e => /FROM blank_sizes/.test(e.sql)).flatMap(e => e.rows), blanksRead = s.log.filter(e => /FROM blanks\b/.test(e.sql)).flatMap(e => e.rows);
  ok("only blank 1's sizes and name are read (not the cap's)", sizesRead.length === 3 && sizesRead.every(r => Number(r.blankId) === 1) &&
    blanksRead.length === 1 && Number(blanksRead[0].id) === 1);
  const mvSql = mvRead[0] ? mvRead[0].sql : "SELECT 1";
  const steps = noisy.q("EXPLAIN QUERY PLAN " + mvSql, ...(mvRead[0] ? mvRead[0].args : [])).map(r => String(r.detail));
  ok("…found through idx_movements_blank_color (blank, color, size, up to the date), not by reading the table",
    steps.some(t => /SEARCH m USING INDEX idx_movements_blank_color \(blankId=\? AND color=\? AND size=\? AND occurredAt<\?\)/.test(t)) &&
    !steps.some(t => /^SCAN (m|inventory_movements)\b/.test(t)) || (console.log("   plan:", steps), false));

  console.log("\n=== The preview and the apply agree ===");
  const call = async (body) => {
    const res = await api({ env: { DB: noisy }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const preview = await call({ action: "previewBlankCatchUp" });
  ok("the preview shows the plan", preview.status === 200 && preview.body.lines.length === 4 && preview.body.total === planClean.totalCents / 100);
  const applied = await call({ action: "applyBlankCatchUp", itemIds: preview.body.lines.map(l => l.itemId) });
  const written = noisy.q("SELECT o.orderId, i.cogsCents, i.cogsSource FROM order_items i JOIN orders o ON o.orderId = i.orderId ORDER BY o.orderId");
  const moves = noisy.q("SELECT orderId, qtyDelta, unitCostCents, occurredAt FROM inventory_movements WHERE kind = 'consume' ORDER BY orderId");
  ok("the apply writes exactly the previewed costs, on the days shown", applied.status === 200 && applied.body.applied === 4 &&
    preview.body.lines.every(l => { const w = written.find(r => r.orderId === l.orderId), m = moves.find(r => r.orderId === l.orderId);
      return w && w.cogsCents === Math.round(l.cost * 100) && w.cogsSource === "consumed" && m && m.qtyDelta === -l.qty && m.unitCostCents === Math.round(l.unitCost * 100) && m.occurredAt === l.useDate; }));
  const again = await lib.planBlankCatchUp(noisy);
  ok("…and nothing is left to plan", again.lines.length === 0);

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test337 crashed: false"); process.exit(1); });
