const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Use transfers for past orders (Inventory & COGS). A made line whose transfers never left stock — its saved
// options name them but it was made some other way ("order"), or it was placed before its product carried a
// transfer and saved no options ("product") — gets a consume dated when the order was made, at the transfer's
// average cost then, and later uses whose cost moves because of it are re-costed. Real SQL + real db.js + real orders.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createTransfer };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let failed = 0;
const ok = (label, cond) => { console.log(label + ": " + !!cond); if (!cond) failed++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('ac','ac','AC','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPrice, sizePricing, createdAt, updatedAt) VALUES
      ('cap','ac','cap','Cap','flat',20,'{}','t','t'), ('emb','ac','cap','Embroidered cap','flat',20,'{}','t','t');`);
  // Orders: [orderId, product, line count]; their made date, test flag and saved options are set after the migrations.
  const orderSpec = [["O1", "cap", 2], ["O2", "cap", 1], ["O3", "cap", 1], ["O4", "emb", 1], ["O5", "cap", 1], ["O6", "cap", 1], ["O7", "cap", 1]];
  for (const [id, prod, n] of orderSpec) {
    d1._raw.run(`INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotal, total, placedAt) VALUES (?, 'ac', ?, 'c@x', 'Card', 1, 20, 20, '2026-10-01T00:00:00Z')`, [id, "Cust " + id]);
    for (let i = 0; i < n; i++) d1._raw.run(`INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPrice, lineTotal, cancelDate) VALUES (?, 'ac', ?, 'Cap', 'cap', 1, 20, 20, '')`, [id, prod]);
  }
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  await call({ action: "saveVendor", vendor: { name: "DTF Co", forTransfers: true } });
  const QR = await lib.createTransfer(d1, { name: "Shop QR" });
  d1._raw.run("UPDATE orgs SET reorderQrTransferId = ? WHERE orgId = 'ac'", [QR]);
  d1._raw.run("UPDATE products SET reorderQr = 'none' WHERE productId = 'emb'");
  const qrCfg = JSON.stringify({ garmentColor: "", size: "OSFA", plain: true, locations: [{ location: "reorderqr", kind: "transfer", transferId: QR, auto: true }] });
  // [orderId, configJson, made date, isTest]
  const orders = [["O1", "", "2026-10-14T15:00:00Z", 0], ["O2", qrCfg, "2026-10-16T15:00:00Z", 0], ["O3", JSON.stringify({ locations: [] }), "2026-10-16T15:00:00Z", 0],
    ["O4", "", "2026-10-16T15:00:00Z", 0], ["O5", qrCfg, "2026-10-25T15:00:00Z", 0], ["O6", "", "2026-10-16T15:00:00Z", 1], ["O7", "", null, 0]];
  for (const [id, cfg, made, test] of orders) {
    d1._raw.run("UPDATE orders SET manufacturedAt = ?, isTest = ? WHERE orderId = ?", [made, test, id]);
    d1._raw.run("UPDATE order_items SET configJson = ?, cogsCents = 300, cogsSource = 'consumed' WHERE orderId = ?", [cfg, id]);
  }
  const item = (orderId, n = 0) => d1.q("SELECT id FROM order_items WHERE orderId = ? ORDER BY id", orderId)[n].id;
  const cogs = (id) => d1.q("SELECT cogsCents FROM order_items WHERE id = ?", id)[0].cogsCents;
  const t = () => d1.q("SELECT quantity, purchasePriceCents FROM transfers WHERE id = ?", QR)[0];

  // Two sheets: 10 at $1.00 on Oct 1, 10 at $2.00 on Oct 20. O5 used one on Oct 25 at the average then ($1.50).
  let r = await call({ action: "receiveTransferSheet", receivedAt: "2026-10-01", vendor: "DTF Co", vendorRef: "A", total: 10, rows: [{ transferId: QR, count: 10, pctOfSheet: 100 }] });
  ok("first sheet received", r.status === 200);
  r = await call({ action: "receiveTransferSheet", receivedAt: "2026-10-20", vendor: "DTF Co", vendorRef: "B", total: 20, rows: [{ transferId: QR, count: 10, pctOfSheet: 100 }] });
  ok("second sheet received", r.status === 200);
  d1._raw.run(`INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, itemId, note, occurredAt, createdAt) VALUES (?, 'Shop QR', -1, 150, 'consume', 'O5', ?, 'Used', '2026-10-25T15:00:00Z', 't')`, [QR, item("O5")]);
  d1._raw.run("UPDATE transfers SET quantity = 19, purchasePriceCents = 150 WHERE id = ?", [QR]);
  d1._raw.run("UPDATE order_items SET cogsCents = 450 WHERE id = ?", [item("O5")]);

  console.log("=== Preview ===");
  r = await call({ action: "previewTransferCatchUp" });
  const lines = r.body.lines || [];
  const byItem = (id) => lines.find(l => l.itemId === id);
  ok("preview lists O1's two lines (from the product) and O2's line (from its options)", r.status === 200 && lines.length === 3 &&
    byItem(item("O1")).source === "product" && byItem(item("O1", 1)).source === "product" && byItem(item("O2")).source === "order");
  ok("not listed: options with no transfer, a product with its QR off, a line that already used it, a test order, an unmade order",
    !["O3", "O4", "O5", "O6", "O7"].some(o => lines.some(l => l.orderId === o)));
  ok("each is priced at the average on the day it was made ($1.00)", lines.every(l => l.uses.length === 1 && l.uses[0].unitCostCents === 100 && l.cost === 1));
  ok("the later use (O5) would be re-costed", r.body.recostLines === 1);
  ok("the preview wrote nothing", d1.q("SELECT count(*) n FROM transfer_movements WHERE kind = 'consume'")[0].n === 1 && t().quantity === 19);

  console.log("\n=== Apply two of the three ===");
  r = await call({ action: "applyTransferCatchUp", itemIds: [item("O1"), item("O2")] });
  ok("applied 2 lines, 2 transfers, $2.00", r.status === 200 && r.body.applied === 2 && r.body.totalUnits === 2 && r.body.total === 2);
  const mv = d1.q("SELECT itemId, qtyDelta, unitCostCents, occurredAt, note FROM transfer_movements WHERE kind = 'consume' AND note LIKE '%catch-up%' ORDER BY itemId");
  ok("a consume per line, dated when its order was made, at $1.00", mv.length === 2 && mv[0].occurredAt === "2026-10-14T15:00:00Z" && mv[1].occurredAt === "2026-10-16T15:00:00Z" && mv.every(m => m.qtyDelta === -1 && m.unitCostCents === 100));
  ok("each line's cost of goods went up by $1.00", cogs(item("O1")) === 400 && cogs(item("O2")) === 400 && cogs(item("O1", 1)) === 300);
  // On hand when the second sheet came in: 10 − 2 = 8, so its average is (8×100 + 10×200) / 18 = 156.
  ok("the transfer's stock and average follow (17 at $1.56)", t().quantity === 17 && t().purchasePriceCents === 156);
  ok("O5's later use re-costed $1.50 → $1.56, and its line's cost with it", d1.q("SELECT unitCostCents FROM transfer_movements WHERE itemId = ? AND kind = 'consume'", item("O5"))[0].unitCostCents === 156 && cogs(item("O5")) === 456);
  ok("audit row written", d1.q("SELECT count(*) n FROM audit_log WHERE action = 'transfer.catch_up'")[0].n === 1);
  r = await call({ action: "applyTransferCatchUp", itemIds: [item("O1"), item("O2")] });
  ok("applying the same lines again does nothing", r.status === 400 && t().quantity === 17);
  r = await call({ action: "previewTransferCatchUp" });
  ok("only O1's second line is left", r.status === 200 && r.body.lines.length === 1 && r.body.lines[0].itemId === item("O1", 1));

  console.log("\n=== Closed month, roles ===");
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-10','t','test')");
  r = await call({ action: "previewTransferCatchUp" });
  ok("a line in a closed month shows locked", r.body.lines.length === 1 && r.body.lines[0].locked === true);
  r = await call({ action: "applyTransferCatchUp", itemIds: [item("O1", 1)] });
  ok("and can't be applied", r.status === 409 && /closed/.test(r.body.message) && t().quantity === 17);
  const src = read("functions/api/orders.js");
  const staff = src.match(/const STAFF_ACTIONS = \[[\s\S]*?\];/)[0], catalog = src.match(/const CATALOG_ADMIN_ACTIONS = new Set\(\[[\s\S]*?\]\);/)[0];
  ok("allowed for the same roles as Use blanks for past orders", /"applyTransferCatchUp"/.test(staff) && /"applyTransferCatchUp"/.test(catalog) && /"previewTransferCatchUp"/.test(staff));
  const admin = read("public/admin.js");
  ok("the Inventory & COGS page has the button", /id="cogsTransferCatchUp"[^>]*>Use transfers for past orders…/.test(admin) && /action: "applyTransferCatchUp"/.test(admin));

  console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
