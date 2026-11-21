const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Count stock (Blanks / Transfers → Count stock…): a counted number recorded as one `adjust` movement for the
// difference at the current average cost (countBlankStock / countTransferStock → setBlankCount / setTransferCount).
// Refused when the stock changed since the window read it; a bulk call applies the good rows and returns the bad
// ones; refused in a closed month; audited; voiding the correction puts the old number back. Real SQL, real
// db.js, real orders.js admin API. Also checks the window is wired on both pages.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, receiveBlanks, createTransfer, receiveTransferSheet, voidInventoryMovement, voidTransferMovement, setBlankCount };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  console.log("=== Blanks ===");
  const b = (await lib.createBlank(d1, { name: "Heavy Tee", productType: "tee", colors: [{ color: "Black", images: [], sizes: [{ size: "M", purchasePrice: 0, quantity: 0 }, { size: "L", purchasePrice: 0, quantity: 0 }] }] })).id;
  await lib.receiveBlanks(d1, { blankId: b, lines: [{ color: "Black", size: "M", qty: 10, unitCost: 4 }, { color: "Black", size: "L", qty: 6, unitCost: 5 }], receivedAt: "2026-09-01T12:00:00.000Z" });
  const bs = (size) => d1.q("SELECT quantity q, purchasePriceCents c FROM blank_sizes WHERE blankId=? AND color='Black' AND size=?", b, size)[0];
  const adj = (size) => d1.q("SELECT id, qtyDelta d, unitCostCents c, note, occurredAt FROM inventory_movements WHERE blankId=? AND size=? AND kind='adjust' AND voidedAt IS NULL ORDER BY id", b, size);
  console.log("setup: M 10 @ $4, L 6 @ $5:", bs("M").q === 10 && bs("M").c === 400 && bs("L").q === 6 && bs("L").c === 500);

  let r = await call({ action: "countBlankStock", at: "2026-10-15T15:00:00.000Z", rows: [{ blankId: b, color: "Black", size: "M", counted: 7, onHand: 10 }] });
  console.log("counting 7 of 10 succeeds:", r.status === 200 && r.body.corrected.length === 1 && r.body.corrected[0].delta === -3 && !r.body.failed.length);
  console.log("stock is now 7 and the average cost didn't move:", bs("M").q === 7 && bs("M").c === 400);
  let a = adj("M");
  console.log("one adjust of -3 at $4, dated when counted, noted as a stock count:", a.length === 1 && a[0].d === -3 && a[0].c === 400 && a[0].occurredAt === "2026-10-15T15:00:00.000Z" && /Stock count/.test(a[0].note));
  console.log("the response carries refreshed blanks for the screen:", Array.isArray(r.body.blanks));

  r = await call({ action: "countBlankStock", rows: [{ blankId: b, color: "Black", size: "M", counted: 9, onHand: 7 }] });
  console.log("counting up (9 of 7) writes +2 at the average and keeps it:", r.status === 200 && bs("M").q === 9 && bs("M").c === 400 && adj("M").length === 2 && adj("M")[1].d === 2);

  r = await call({ action: "countBlankStock", rows: [{ blankId: b, color: "Black", size: "M", counted: 9, onHand: 9 }] });
  console.log("a row that matches records nothing:", r.status === 200 && !r.body.corrected.length && adj("M").length === 2);

  r = await call({ action: "countBlankStock", rows: [{ blankId: b, color: "Black", size: "M", counted: 5, onHand: 10 }] });
  console.log("a stale on-hand (the window showed 10, it's 9) is refused for that row:", r.status === 200 && r.body.failed.length === 1 && /changed while you were counting/.test(r.body.failed[0].error) && bs("M").q === 9);

  r = await call({ action: "countBlankStock", rows: [
    { blankId: b, color: "Black", size: "M", counted: 8, onHand: 3 },
    { blankId: b, color: "Black", size: "L", counted: 4, onHand: 6 }] });
  console.log("bulk: the good row applies, the bad row comes back with its reason:", r.status === 200 && r.body.corrected.length === 1 && r.body.corrected[0].size === "L" &&
    r.body.failed.length === 1 && r.body.failed[0].size === "M" && bs("L").q === 4 && bs("M").q === 9);

  r = await call({ action: "countBlankStock", rows: [{ blankId: b, color: "Black", size: "M", counted: -1, onHand: 9 }] });
  console.log("a negative count is refused:", r.status === 400);
  r = await call({ action: "countBlankStock", rows: [] });
  console.log("no rows is refused:", r.status === 400);
  r = await call({ action: "countBlankStock", rows: [{ blankId: b, color: "Black", size: "XS", counted: 1, onHand: 0 }] });
  console.log("a size that isn't on file comes back as failed:", r.status === 200 && r.body.failed.length === 1 && /isn't on file/.test(r.body.failed[0].error));
  r = await call({ action: "countBlankStock", at: "2099-01-01T00:00:00.000Z", rows: [{ blankId: b, color: "Black", size: "M", counted: 1, onHand: 9 }] });
  console.log("a count dated in the future is refused:", r.status === 400 && bs("M").q === 9);

  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-10','t','test')");
  r = await call({ action: "countBlankStock", at: "2026-10-20T12:00:00.000Z", rows: [{ blankId: b, color: "Black", size: "M", counted: 1, onHand: 9 }] });
  console.log("a count dated in a closed month is refused and changes nothing:", r.status === 409 && /closed/i.test(r.body.message) && bs("M").q === 9);
  d1._raw.run("DELETE FROM closed_periods");

  const aud = d1.q("SELECT detail FROM audit_log WHERE action='inventory.counted' ORDER BY id");
  const first = aud.length && JSON.parse(aud[0].detail);
  console.log("each correction is audited with what was on record and what was counted:", aud.length === 3 && first.rows.length === 1 && first.rows[0].onHand === 10 && first.rows[0].counted === 7 && first.rows[0].delta === -3);

  const up = adj("M")[1];
  await lib.voidInventoryMovement(d1, up.id, "miscounted");
  console.log("voiding the +2 correction puts the stock back to 7:", bs("M").q === 7 && bs("M").c === 400);

  const nb = (await lib.createBlank(d1, { name: "New Cap", productType: "cap", colors: [{ color: "", images: [], sizes: [{ size: "OSFA", purchasePrice: 0, quantity: 0 }] }] })).id;
  d1._raw.run("UPDATE blank_sizes SET vendorPriceCents = 350 WHERE blankId = " + nb);
  await lib.setBlankCount(d1, { blankId: nb, color: "", size: "OSFA", counted: 4, onHand: 0 });
  const nr = d1.q("SELECT quantity q, purchasePriceCents c FROM blank_sizes WHERE blankId=?", nb)[0];
  console.log("found stock of a size with no cost yet is valued at its vendor price:", nr.q === 4 && nr.c === 350 &&
    d1.q("SELECT unitCostCents c FROM inventory_movements WHERE blankId=? AND kind='adjust'", nb)[0].c === 350);

  console.log("\n=== Transfers ===");
  const t = await lib.createTransfer(d1, { name: "Left chest" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: t, count: 20, pctOfSheet: 100 }], totalCents: 4000, receivedAt: "2026-09-02" });
  const ts = () => d1.q("SELECT quantity q, purchasePriceCents c FROM transfers WHERE id=?", t)[0];
  const tadj = () => d1.q("SELECT id, qtyDelta d, unitCostCents c FROM transfer_movements WHERE transferId=? AND kind='adjust' AND voidedAt IS NULL ORDER BY id", t);
  console.log("setup: 20 @ $2.00:", ts().q === 20 && ts().c === 200);
  r = await call({ action: "countTransferStock", at: "2026-11-01T10:00:00.000Z", rows: [{ transferId: t, counted: 16, onHand: 20 }] });
  console.log("counting 16 of 20 writes one adjust of -4 at $2.00:", r.status === 200 && r.body.corrected[0].delta === -4 && ts().q === 16 && ts().c === 200 &&
    tadj().length === 1 && tadj()[0].d === -4 && tadj()[0].c === 200);
  console.log("the response carries refreshed transfers:", Array.isArray(r.body.transfers) && r.body.transfers.find(x => x.id === t).quantity === 16);
  r = await call({ action: "countTransferStock", rows: [{ transferId: t, counted: 30, onHand: 20 }] });
  console.log("a stale on-hand is refused for that row:", r.status === 200 && r.body.failed.length === 1 && ts().q === 16);
  r = await call({ action: "countTransferStock", rows: [{ transferId: t, counted: 18, onHand: 16 }, { transferId: 99999, counted: 1, onHand: 0 }] });
  console.log("bulk: the good row applies, an unknown transfer comes back failed:", r.status === 200 && r.body.corrected.length === 1 && r.body.failed.length === 1 && ts().q === 18);
  const tAud = d1.q("SELECT count(*) n FROM audit_log WHERE action='transfer.counted'")[0].n;
  console.log("transfer corrections are audited:", tAud === 2);
  await lib.voidTransferMovement(d1, tadj()[1].id, "miscounted");
  console.log("voiding the +2 correction puts it back to 16:", ts().q === 16 && ts().c === 200);

  console.log("\n=== The window ===");
  const admin = read("public/admin.js");
  console.log("Blanks has a Count stock… button that opens the window:", /id="blankCountBtn"[^>]*>Count stock…</.test(admin) && /blankCountBtn"\)\.onclick = \(\) => showStockCount_\("blanks"/.test(admin));
  console.log("Transfers has a Count stock… button that opens the window:", /id="trCountBtn"[^>]*>Count stock…</.test(admin) && /trCountBtn"\)\.onclick = \(\) => showStockCount_\("transfers"/.test(admin));
  const win = admin.slice(admin.indexOf("function showStockCount_("), admin.indexOf("// ---- Blanks: import a vendor order from a PDF"));
  console.log("the window offers Past orders, Write off, Correct count and History per row, and a bulk correction:",
    ["Past orders…", "Write off…", "Correct count", "History", "Correct all remaining differences"].every(s => win.includes(s)));
  console.log("Past orders opens the catch-up windows filtered to the row's item:",
    /showBlankCatchUp_\(null, \{ blankId: r\.blankId, color: r\.color, size: r\.size \}\)/.test(win) && /showTransferCatchUp_\(null, \{ transferId: r\.transferId \}\)/.test(win));
  console.log("the catch-up windows accept that filter:", /async function showBlankCatchUp_\(onDone, filter\)/.test(admin) && /async function showTransferCatchUp_\(onDone, filter\)/.test(admin));
})().catch(e => { console.error(e); console.log("test crashed: false"); process.exitCode = 1; });
