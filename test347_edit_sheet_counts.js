const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// Editing a transfer sheet sets each transfer's count from its history inside the save (2026-11, review round 2).
// It used to replay the history in JS and write that count back, so a use recorded between the read and the save
// (Run Order finishing a line) was overwritten and the count came out too high. Now the count is SUM(qtyDelta) of the
// live movements, and the save — one batch, as before — writes nothing if any of the sheet's transfers gained or lost
// a movement since it was read: the screen says "Stock changed while you were editing; try again." Real migrations,
// db.js and orders.js on sql.js. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createTransfer };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1);
    INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotalCents, totalCents, placedAt) VALUES ('U1','acme','Pat Example','pat@example.test','Card',1,4000,4000,'2026-09-12T00:00:00Z');
    INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPriceCents, lineTotalCents, cancelDate, cogsCents, cogsSource) VALUES ('U1','acme','tee','Tee','tee',2,2000,4000,'',1200,'consumed');`);
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  await call({ action: "saveVendor", vendor: { name: "Example Prints", forTransfers: true } });
  const acct = d1.q("SELECT id FROM accounts WHERE active=1 ORDER BY id LIMIT 1")[0].id;
  const A = await lib.createTransfer(d1, { name: "Crest" }), B = await lib.createTransfer(d1, { name: "QR" });
  // One sheet on Sep 10: 10 Crest (60%, $6.00 each) and 20 QR (40%, $2.00 each) for $100. Order U1 used 2 Crest on Sep 12.
  let r = await call({ action: "receiveTransferSheet", receivedAt: "2026-09-10", vendor: "Example Prints", vendorRef: "S1", total: 100, accountId: acct,
    rows: [{ transferId: A, count: 10, pctOfSheet: 60 }, { transferId: B, count: 20, pctOfSheet: 40 }] });
  const seed = r.body.ids[0];
  const item = d1.q("SELECT id FROM order_items WHERE orderId = 'U1'")[0].id;
  d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, itemId, note, occurredAt, createdAt) VALUES (?, 'Crest', -2, 600, 'consume', 'U1', ?, 'Used', '2026-09-12T00:00:00Z', 't')", [A, item]);
  d1._raw.run("UPDATE transfers SET quantity = quantity - 2 WHERE id = ?", [A]);
  const t = (id) => d1.q("SELECT quantity q, purchasePriceCents c FROM transfers WHERE id = ?", id)[0];
  const sum = (id) => d1.q("SELECT COALESCE(SUM(qtyDelta), 0) s FROM transfer_movements WHERE transferId = ? AND voidedAt IS NULL", id)[0].s;
  const purchases = () => d1.q("SELECT id, transferId, qtyDelta, unitCostCents, voidedAt FROM transfer_movements WHERE kind = 'purchase' ORDER BY id");
  const cogs = () => d1.q("SELECT cogsCents FROM order_items WHERE id = ?", item)[0].cogsCents;
  ok("set up: 8 Crest at $6.00, 20 QR at $2.00", t(A).q === 8 && t(A).c === 600 && t(B).q === 20 && sum(A) === 8);

  // Every batch the save sends; `meanwhile` runs once just before the save's batch — Run Order using one Crest then.
  const sent = [];
  let meanwhile = null;
  const batch = d1.batch.bind(d1);
  d1.batch = async (stmts) => {
    const sqls = stmts.map(s => s._sql);
    if (sqls.some(s => /voidReason = 'Sheet edited'/.test(s))) { sent.push(sqls); if (meanwhile) { const f = meanwhile; meanwhile = null; f(); } }
    return batch(stmts);
  };
  const runOrderUsesOne = () => {
    d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, note, occurredAt, createdAt) VALUES (?, 'Crest', -1, 600, 'consume', 'U2', 'Used', '2026-09-20T00:00:00Z', 't')", [A]);
    d1._raw.run("UPDATE transfers SET quantity = quantity - 1 WHERE id = ?", [A]);
  };
  // The correction: Crest was 50% of the sheet ($5.00 each), QR 50% ($2.50 each).
  const edit = () => call({ action: "editTransferSheet", movementId: purchases().find(m => !m.voidedAt).id, receivedAt: "2026-09-10", vendor: "Example Prints", vendorRef: "S1", total: 100, accountId: acct,
    rows: [{ transferId: A, count: 10, pctOfSheet: 50 }, { transferId: B, count: 20, pctOfSheet: 50 }] });

  console.log("=== Saving while Run Order uses a Crest ===");
  const beforeRows = JSON.stringify(purchases());
  meanwhile = runOrderUsesOne;
  r = await edit();
  ok("the save is refused with the message the screen shows", r.status === 400 && r.body.message === "Stock changed while you were editing; try again.");
  ok("…and nothing was written: the old purchases stand, no new ones, the order line's cost as it was", JSON.stringify(purchases()) === beforeRows && cogs() === 1200);
  ok("…the count keeps the use that landed (7 Crest), and the price is unchanged", t(A).q === 7 && sum(A) === 7 && t(A).c === 600 && t(B).q === 20 && t(B).c === 200);
  ok("…in one batch, as before", sent.length === 1);

  console.log("\n=== Trying again ===");
  r = await edit();
  ok("saved", r.status === 200);
  ok("the old purchases are voided and the new ones written", purchases().filter(m => !m.voidedAt).length === 2 && purchases().filter(m => m.voidedAt).length === 2);
  ok("Crest $5.00 each and QR $2.50", t(A).c === 500 && t(B).c === 250);
  ok("the counts come from the history: 10 − 2 − 1 = 7 Crest, 20 QR", t(A).q === 7 && sum(A) === 7 && t(B).q === 20 && sum(B) === 20);
  ok("the order line that used Crest is re-costed to $5.00 a transfer", cogs() === 1000);
  ok("…one batch again", sent.length === 2);

  console.log("\n=== The screen shows what the server says ===");
  const admin = read("public/admin.js");
  const modal = admin.match(/function showTransferSheetModal_[\s\S]*?\n}\n/);
  ok("the sheet form shows the server's message when a save is refused", !!modal && /action: "editTransferSheet"/.test(modal[0]) && /\.message/.test(modal[0]));

  console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); console.log("test347 crashed: false"); process.exit(1); });
