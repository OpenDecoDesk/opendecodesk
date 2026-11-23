const fs = require("fs");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { createD1 } = require("./testlib/d1-shim.js");

// Month-end stock snapshots (migrations/0103): the Inventory & COGS report and the accountant export start each
// stock replay (blanks, transfer sheets, finished stock) from the snapshot of the latest CLOSED month before the
// period, written the first time a report needs it, and replay only the movements after it. The numbers must be
// exactly the ones a replay of the whole history gives — for random histories, and after a movement backdated into
// an earlier open month, a void, a restore and a reopened month. Also: the triggers delete the right months,
// setOrderDates refuses a sale date (shipped / delivered / completed) moving into or out of a closed month, a new
// sale-date basis clears the snapshots, and the accountant export has transfer sheets. Real SQL (sql.js), the real
// migrations, db.js and orders.js; invented data.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const L = new Function(dbSrc + `\nreturn { getInventoryValuations, getTransferValuations, getFinishedGoodsValuations, getOrderCostsNotYetSoldAt, getAccountantExport,
  closePeriod, reopenPeriod, setAccountingSettings, monthEndMoment_, voidTransferMovement, restoreTransferMovement, voidInventoryMovement, restoreInventoryMovement,
  voidFinishedGoodsMovement, saleDateSql_ };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const ok = (d, c) => console.log(d + ":", !!c);
const fromCents = (c) => Math.round(c) / 100;

// ---- The whole-history replays, as they were before snapshots -------------------------------------------------
async function fullBlanks(db, asOf) {
  const { results } = await db.prepare("SELECT blankId, blankName, color, size, qtyDelta, unitCostCents, kind FROM inventory_movements WHERE occurredAt <= ? AND voidedAt IS NULL ORDER BY occurredAt, id").bind(asOf).all();
  const testing = new Set(db.q("SELECT id FROM blanks WHERE forTesting = 1").map(r => Number(r.id)));
  const current = new Map(db.q("SELECT id, name, brand, color FROM blanks").map(b => [Number(b.id), b.name || [b.brand, b.color].filter(Boolean).join(" ")]));
  const state = new Map();
  for (const m of results) {
    const key = m.blankId + "|" + (m.color || "") + "|" + m.size;
    const st = state.get(key) || { blankId: Number(m.blankId), name: m.blankName, color: m.color || "", size: m.size, qty: 0, avg: 0 };
    const d = Number(m.qtyDelta);
    if (d > 0 && (m.kind === "purchase" || m.kind === "adjust")) { const on = Math.max(0, st.qty); st.avg = Math.round((on * st.avg + d * Number(m.unitCostCents)) / (on + d)); }
    st.qty += d; st.name = current.get(Number(m.blankId)) || m.blankName || st.name; state.set(key, st);
  }
  const rows = [...state.values()].filter(r => r.qty !== 0)
    .map(r => ({ blankId: r.blankId, name: r.name, color: r.color, size: r.size, qty: r.qty, avgCost: fromCents(r.avg), value: fromCents(Math.max(0, r.qty) * r.avg), forTesting: testing.has(r.blankId) }))
    .sort((a, b) => (a.name + a.color + a.size).localeCompare(b.name + b.color + b.size));
  const group = (list) => ({ units: list.reduce((s, r) => s + r.qty, 0), value: fromCents(list.reduce((s, r) => s + Math.round(r.value * 100), 0)) });
  return { asOf, rows, units: rows.reduce((s, r) => s + r.qty, 0), value: fromCents(rows.reduce((s, r) => s + Math.round(r.value * 100), 0)),
    groups: { forSale: group(rows.filter(r => !r.forTesting)), testing: group(rows.filter(r => r.forTesting)) } };
}
async function fullTransfers(db, asOf) {
  const { results } = await db.prepare("SELECT transferId, transferName, qtyDelta, unitCostCents, kind FROM transfer_movements WHERE occurredAt <= ? AND voidedAt IS NULL ORDER BY occurredAt, id").bind(asOf).all();
  const state = new Map();
  for (const m of results) {
    const st = state.get(String(m.transferId)) || { transferId: Number(m.transferId), name: m.transferName, qty: 0, avg: 0 };
    const d = Number(m.qtyDelta);
    if (d > 0 && (m.kind === "purchase" || m.kind === "adjust")) { const on = Math.max(0, st.qty); st.avg = Math.round((on * st.avg + d * Number(m.unitCostCents)) / (on + d)); }
    st.qty += d; st.name = m.transferName || st.name; state.set(String(m.transferId), st);
  }
  const rows = [...state.values()].filter(r => r.qty !== 0).map(r => ({ transferId: r.transferId, name: r.name, qty: r.qty, avgCost: fromCents(r.avg), value: fromCents(Math.max(0, r.qty) * r.avg) }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return { asOf, rows, units: rows.reduce((s, r) => s + r.qty, 0), value: fromCents(rows.reduce((s, r) => s + Math.round(r.value * 100), 0)) };
}
async function fullFinished(db, asOf) {
  const { results } = await db.prepare("SELECT orgId, productId, productName, size, variant, variantLabel, qtyDelta, unitCostCents, kind FROM finished_goods_movements WHERE occurredAt <= ? AND voidedAt IS NULL ORDER BY occurredAt, id").bind(asOf).all();
  const state = new Map();
  for (const m of results) {
    const key = JSON.stringify([m.orgId, m.productId, m.size || "", m.variant || ""]);
    const st = state.get(key) || { orgId: m.orgId, productId: m.productId, name: m.productName, size: m.size || "", variant: m.variant || "", label: "", qty: 0, avg: 0 };
    const d = Number(m.qtyDelta);
    if (d > 0 && m.kind !== "sell") { const on = Math.max(0, st.qty); st.avg = Math.round((on * st.avg + d * Number(m.unitCostCents)) / (on + d)); }
    st.qty += d; st.name = m.productName || st.name; st.label = m.variantLabel || st.label; state.set(key, st);
  }
  const rows = [...state.values()].filter(r => r.qty !== 0).map(r => ({ orgId: r.orgId, productId: r.productId, name: r.label ? r.name + " · " + r.label : r.name, size: r.size, variant: r.variant, qty: r.qty, avgCost: fromCents(r.avg), value: fromCents(Math.max(0, r.qty) * r.avg) }))
    .sort((a, b) => (a.orgId + a.name + a.size).localeCompare(b.orgId + b.name + b.size));
  return { asOf, rows, units: rows.reduce((s, r) => s + r.qty, 0), value: fromCents(rows.reduce((s, r) => s + Math.round(r.value * 100), 0)) };
}
async function fullNotYetSold(db, asOf, basis) {
  const sale = L.saleDateSql_(basis, "o");
  const two = async (table, k) => {
    const used = await db.prepare(`SELECT COALESCE(SUM(-m.qtyDelta * m.unitCostCents), 0) AS c FROM ${table} m WHERE m.occurredAt <= ? AND m.kind IN (${k}) AND m.voidedAt IS NULL AND m.orderId IS NOT NULL
      AND EXISTS (SELECT 1 FROM orders ox WHERE ox.orderId = m.orderId)`).bind(asOf).first();
    const sold = await db.prepare(`SELECT COALESCE(SUM(-m.qtyDelta * m.unitCostCents), 0) AS c FROM orders o JOIN ${table} m ON m.orderId = o.orderId WHERE ${sale} <= ? AND m.kind IN (${k}) AND m.voidedAt IS NULL`).bind(asOf).first();
    return Number(used.c) - Number(sold.c);
  };
  return { blanksCents: await two("inventory_movements", "'consume'"), finishedCents: await two("finished_goods_movements", "'sell', 'return'"), transfersCents: await two("transfer_movements", "'consume'") };
}

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Shop','t','t',1);
    INSERT INTO blanks (id, name, createdAt, updatedAt) VALUES (1, 'Plain tee', 't', 't'), (2, 'Plain tee', 't', 't'), (3, '', 't', 't');
    UPDATE blanks SET forTesting = 1 WHERE id = 2;`);
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x", org: "acme" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const snapRows = (kind, month) => d1.q("SELECT key FROM inventory_period_snapshots WHERE kind = ? AND month = ?", kind, month);
  const snapMonths = (kind) => d1.q("SELECT DISTINCT month FROM inventory_period_snapshots WHERE kind = ? AND key = '#complete' ORDER BY month", kind).map(r => r.month);

  console.log("=== The migration ===");
  ok("the table is keyed by month, kind and item", /PRIMARY KEY \(month, kind, key\)/.test(read("migrations/0103_inventory_period_snapshots.sql")));
  const trig = d1.q("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'ips_%' ORDER BY name").map(r => r.name);
  ok("an insert, update and delete trigger on each of the three movement tables", trig.length === 9 &&
    ["inventory_movements", "transfer_movements", "finished_goods_movements"].every(t => ["ins", "upd", "del"].every(k => trig.includes(`ips_${t}_${k}`))));
  ok("schema.sql (fresh installs) has the table, the index and the triggers", /CREATE TABLE IF NOT EXISTS inventory_period_snapshots/.test(read("schema.sql")) &&
    /idx_fgm_order/.test(read("schema.sql")) && (read("schema.sql").match(/CREATE TRIGGER IF NOT EXISTS ips_/g) || []).length === 9);
  ok("a month's end is its last millisecond", L.monthEndMoment_("2025-02") === "2025-02-28T23:59:59.999Z" && L.monthEndMoment_("2024-02") === "2024-02-29T23:59:59.999Z" &&
    L.monthEndMoment_("2025-12") === "2025-12-31T23:59:59.999Z");

  // ---- Random history over three years: renamed and nameless items, stock below zero, voids, orders ----
  let seed = 245; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const at = (day) => new Date(Date.parse("2024-01-01T00:00:00Z") + day * 86400000 + rnd(86400) * 1000).toISOString();
  const blankMove = (when, extra = {}) => {
    const kind = extra.kind || ["purchase", "purchase", "consume", "adjust", "writeoff"][rnd(5)], up = kind === "purchase" || (kind === "adjust" && rnd(2));
    d1._raw.run("INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, orderId, occurredAt, createdAt, voidedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [extra.blankId || 1 + rnd(4), ["Plain tee", "Old tee", "", "Tee v2"][rnd(4)], ["", "Navy", "Red"][rnd(3)], ["S", "M", "L"][rnd(3)], up ? 1 + rnd(30) : -(1 + rnd(8)),
        150 + rnd(400), kind, extra.orderId || null, when, when, rnd(20) ? null : "x"]);
  };
  const transferMove = (when, extra = {}) => {
    const kind = extra.kind || ["purchase", "purchase", "consume", "writeoff", "adjust"][rnd(5)], up = kind === "purchase" || (kind === "adjust" && rnd(2));
    d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, occurredAt, createdAt, voidedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [1 + rnd(4), ["Crest", "Logo", "", "Crest"][rnd(4)], up ? 5 + rnd(40) : -(1 + rnd(6)), 40 + rnd(90), kind, extra.orderId || null, when, when, rnd(20) ? null : "x"]);
  };
  const finishedMove = (when, extra = {}) => {
    const kind = extra.kind || ["make", "make", "adjust", "sell", "opening"][rnd(5)], up = kind !== "sell" && (kind !== "adjust" || rnd(2));
    d1._raw.run("INSERT INTO finished_goods_movements (orgId, productId, productName, size, variant, variantLabel, qtyDelta, unitCostCents, kind, orderId, occurredAt, createdAt, voidedAt) VALUES ('acme', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [["cap", "tee"][rnd(2)], ["Cap", "Tee", ""][rnd(3)], ["", "M", "L"][rnd(3)], rnd(3) ? "" : "navy", rnd(3) ? "" : "Navy", up ? 1 + rnd(9) : -(1 + rnd(4)), 600 + rnd(600), kind,
        extra.orderId || null, when, when, rnd(20) ? null : "x"]);
  };
  for (let i = 0; i < 900; i++) {
    const when = at(rnd(1050));
    [blankMove, transferMove, finishedMove][i % 3](when);
  }
  // A few movements exactly on a month's last millisecond, and on its first.
  blankMove("2024-06-30T23:59:59.999Z", { kind: "purchase" }); transferMove("2024-07-01T00:00:00.000Z", { kind: "purchase" }); finishedMove("2024-06-30T23:59:59.999Z", { kind: "make" });
  for (let i = 0; i < 80; i++) {
    const placed = at(i * 13), made = at(i * 13 + 1), shipped = rnd(4) ? at(i * 13 + 2 + rnd(40)) : null, id = "S" + i;
    d1._raw.run("INSERT INTO orders (orderId, orgId, customerName, contact, subtotalCents, totalCents, placedAt, shippedAt) VALUES (?, 'acme', 'Customer', 'c@example.com', 1000, 1000, ?, ?)", [id, placed, shipped]);
    blankMove(made, { kind: "consume", orderId: id }); transferMove(made, { kind: "consume", orderId: id });
    if (rnd(3) === 0) finishedMove(made, { kind: "sell", orderId: id });
  }
  // Closed months: most of 2024 and the first half of 2025, with gaps.
  for (const m of ["2024-01", "2024-02", "2024-03", "2024-05", "2024-06", "2024-07", "2024-09", "2024-12", "2025-01", "2025-02", "2025-03", "2025-06"]) await L.closePeriod(d1, m, "test");

  const periods = [["2024-02-01", "2024-02-29"], ["2025-02-01", "2025-02-28"], ["2024-07-01", "2024-07-31"], ["2024-08-15", "2024-11-30"], ["2025-01-01", "2025-12-31"], ["2025-04-01", "2026-06-30"],
    ["2025-07-01", "2025-09-30"], ["2026-01-01", "2026-12-31"], ["2023-01-01", "2023-12-31"]];
  const ends = ([from, to]) => [new Date(Date.parse(from + "T00:00:00.000Z") - 1).toISOString(), to + "T23:59:59.999Z"];
  const same = async (label) => {
    let all = true;
    for (const p of periods) {
      const e = ends(p);
      const [b, t, f] = await Promise.all([L.getInventoryValuations(d1, e), L.getTransferValuations(d1, e), L.getFinishedGoodsValuations(d1, e)]);
      const good = JSON.stringify(b) === JSON.stringify([await fullBlanks(d1, e[0]), await fullBlanks(d1, e[1])]) &&
        JSON.stringify(t) === JSON.stringify([await fullTransfers(d1, e[0]), await fullTransfers(d1, e[1])]) &&
        JSON.stringify(f) === JSON.stringify([await fullFinished(d1, e[0]), await fullFinished(d1, e[1])]);
      if (!good) { all = false; console.log("  differs for " + p.join("…") + " (" + label + ")"); }
    }
    return all;
  };

  console.log("\n=== Snapshot + the movements after it = the whole history ===");
  ok("no snapshot before any report", d1.q("SELECT COUNT(*) n FROM inventory_period_snapshots")[0].n === 0);
  ok("every period, every stock: the same rows, units and values as a full replay (first run, writing snapshots)", await same("first run"));
  ok("…the snapshots written are of closed months a report started after, for all three stocks", ["blank", "transfer", "finished"].every(k => {
    const ms = snapMonths(k); return ms.length > 0 && ms.every(m => d1.q("SELECT 1 FROM closed_periods WHERE month = ?", m).length === 1); }) &&
    snapMonths("blank").includes("2024-12") && snapMonths("blank").includes("2025-06") && snapMonths("blank").includes("2024-07"));
  ok("…no '#pending' row is left behind", d1.q("SELECT COUNT(*) n FROM inventory_period_snapshots WHERE key = '#pending'")[0].n === 0);
  ok("…a snapshot is never of an open month (2024-08 is open: a report from 2024-08-15 starts from July)", !snapMonths("blank").includes("2024-08") && !snapMonths("transfer").includes("2024-04"));
  ok("every period again, reading the snapshots: still the same", await same("from snapshots"));
  // Prove the seed is really used: change one snapshot row by hand and a report from after it changes.
  const someRow = d1.q("SELECT month, key, qty FROM inventory_period_snapshots WHERE kind = 'transfer' AND month = '2025-06' AND key NOT LIKE '#%' AND qty > 0 LIMIT 1")[0];
  d1._raw.run("UPDATE inventory_period_snapshots SET qty = qty + 1000 WHERE kind = 'transfer' AND month = ? AND key = ?", [someRow.month, someRow.key]);
  const seeded = (await L.getTransferValuations(d1, ends(["2025-07-01", "2025-09-30"])))[0];
  ok("a report after a closed month starts from its snapshot (a hand-changed row shows through)", seeded.units === (await fullTransfers(d1, "2025-06-30T23:59:59.999Z")).units + 1000);
  d1._raw.run("UPDATE inventory_period_snapshots SET qty = qty - 1000 WHERE kind = 'transfer' AND month = ? AND key = ?", [someRow.month, someRow.key]);
  ok("the items keep the order the replay first met them (ties in the sort come out the same)", await same("order"));

  console.log("\n=== Costs on orders not sold yet: two bounded sums = all history ===");
  let nys = true;
  for (const basis of ["shipped", "placed"]) for (const p of periods) {
    const e = ends(p);
    if (JSON.stringify(await L.getOrderCostsNotYetSoldAt(d1, e, { basis })) !== JSON.stringify([await fullNotYetSold(d1, e[0], basis), await fullNotYetSold(d1, e[1], basis)])) { nys = false; console.log("  differs", basis, p); }
  }
  ok("every period, both bases: the same cents as summing all history", nys);
  const three = ["2026-05-31T23:59:59.999Z", "2024-02-29T23:59:59.999Z", "2025-11-30T23:59:59.999Z"];
  ok("…moments in any order come back in the order asked", JSON.stringify(await L.getOrderCostsNotYetSoldAt(d1, three, { basis: "shipped" })) ===
    JSON.stringify(await Promise.all(three.map(a => fullNotYetSold(d1, a, "shipped")))));

  console.log("\n=== Changes under a snapshot ===");
  const before = snapMonths("blank");
  // A movement backdated into an earlier OPEN month (2024-04, between closed months) — no period guard stops it.
  blankMove("2024-04-15T12:00:00.000Z", { kind: "purchase", blankId: 1 });
  ok("a movement backdated into an open month deletes every snapshot from that month on, and only those", JSON.stringify(snapMonths("blank")) === JSON.stringify(before.filter(m => m < "2024-04")) &&
    JSON.stringify(snapMonths("transfer")) === JSON.stringify(before.filter(m => m < "2024-04")) && snapMonths("finished").every(m => m < "2024-04"));
  ok("…and the reports are still the full replay's", await same("after a backdated movement"));
  const tp = d1.q("SELECT id FROM transfer_movements WHERE kind = 'purchase' AND voidedAt IS NULL AND occurredAt >= '2025-07' AND occurredAt < '2025-08' LIMIT 1")[0].id;
  const tMonth = d1.q("SELECT substr(occurredAt, 1, 7) m FROM transfer_movements WHERE id = ?", tp)[0].m;
  ok("…snapshots rebuilt by the reports", snapMonths("transfer").includes("2025-06"));
  await L.voidTransferMovement(d1, tp, "test");
  ok("a void (voidTransferMovement) deletes snapshots from its month on", snapMonths("transfer").every(m => m < tMonth) && snapMonths("transfer").includes("2025-06"));
  ok("…and the reports are still the full replay's", await same("after a void"));
  // Void and restore in a month with snapshots after it: reopen June 2025 to reach it, as the period guard would make you.
  const bp = d1.q("SELECT id, substr(occurredAt, 1, 7) m FROM inventory_movements WHERE kind = 'purchase' AND voidedAt IS NULL AND occurredAt >= '2025-01' AND occurredAt < '2025-02' LIMIT 1")[0];
  await L.reopenPeriod(d1, "2025-01");
  ok("reopening a month deletes its snapshots and every later month's, of every kind", ["blank", "transfer", "finished"].every(k => snapMonths(k).every(m => m < "2025-01")) &&
    d1.q("SELECT COUNT(*) n FROM inventory_period_snapshots WHERE month >= '2025-01'")[0].n === 0);
  ok("…and the reports are still the full replay's (they now start from 2024-12)", await same("after a reopen"));
  ok("…a reopened month gets no snapshot", !snapMonths("blank").includes("2025-01") && snapMonths("blank").includes("2025-06"));
  await L.voidInventoryMovement(d1, bp.id, "test");
  ok("a void in it deletes the later snapshots", snapMonths("blank").every(m => m < bp.m));
  ok("…and the reports are still the full replay's", await same("after a blank void"));
  await L.restoreInventoryMovement(d1, bp.id);
  ok("a restore deletes them again", snapMonths("blank").every(m => m < bp.m));
  ok("…and the reports are still the full replay's", await same("after a restore"));
  await L.restoreTransferMovement(d1, tp);
  ok("a transfer restore too", await same("after a transfer restore") && snapMonths("transfer").every(m => m < "2025-07"));
  await L.closePeriod(d1, "2025-01", "test");
  ok("closed again: the reports agree and write its snapshot", await same("re-closed") && snapMonths("blank").includes("2025-01"));

  console.log("\n=== The triggers delete the right months ===");
  const seedSnaps = () => {
    d1._raw.run("DELETE FROM inventory_period_snapshots");
    for (const m of ["2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06"]) for (const k of ["blank", "transfer", "finished"])
      d1._raw.run("INSERT INTO inventory_period_snapshots (month, kind, key, qty, avgCents, name, label) VALUES (?, ?, '#complete', 0, 0, '', '')", [m, k]);
  };
  const left = () => d1.q("SELECT DISTINCT month FROM inventory_period_snapshots ORDER BY month").map(r => r.month).join(",");
  const tables = [["inventory_movements", "INSERT INTO inventory_movements (blankId, blankName, size, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES (1, 'x', 'M', 1, 100, 'purchase', ?, 't')"],
    ["transfer_movements", "INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES (1, 'x', 1, 100, 'purchase', ?, 't')"],
    ["finished_goods_movements", "INSERT INTO finished_goods_movements (orgId, productId, productName, size, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES ('acme', 'cap', 'Cap', '', 1, 100, 'make', ?, 't')"]];
  for (const [t, ins] of tables) {
    seedSnaps(); d1._raw.run(ins, ["2027-03-10T12:00:00.000Z"]);
    const id = d1.q(`SELECT MAX(id) id FROM ${t}`)[0].id;
    ok(`${t}: an insert keeps the months before it`, left() === "2027-01,2027-02");
    seedSnaps(); d1._raw.run(`UPDATE ${t} SET occurredAt = '2027-05-02T00:00:00.000Z' WHERE id = ?`, [id]);
    ok(`${t}: a date moved later deletes from the OLD month on`, left() === "2027-01,2027-02");
    seedSnaps(); d1._raw.run(`UPDATE ${t} SET occurredAt = '2027-02-02T00:00:00.000Z' WHERE id = ?`, [id]);
    ok(`${t}: a date moved earlier deletes from the NEW month on`, left() === "2027-01");
    seedSnaps(); d1._raw.run(`UPDATE ${t} SET voidedAt = 'x' WHERE id = ?`, [id]);
    ok(`${t}: a void (any update) deletes from its month on`, left() === "2027-01");
    seedSnaps(); d1._raw.run(`UPDATE ${t} SET occurredAt = '2027-04-30T23:59:59.999Z' WHERE id = ?`, [id]);
    seedSnaps(); d1._raw.run(`DELETE FROM ${t} WHERE id = ?`, [id]);
    ok(`${t}: a delete deletes from its month on`, left() === "2027-01,2027-02,2027-03");
    seedSnaps(); d1._raw.run(ins, ["2028-01-01T00:00:00.000Z"]); d1._raw.run(`DELETE FROM ${t} WHERE id = (SELECT MAX(id) FROM ${t})`);
    ok(`${t}: a change after every snapshot deletes none`, left() === "2027-01,2027-02,2027-03,2027-04,2027-05,2027-06");
  }
  d1._raw.run("DELETE FROM inventory_period_snapshots");

  console.log("\n=== A write raced by a change is dropped ===");
  // A '#pending' row deleted under a writer (a movement changed in that month while it read): nothing is saved.
  d1._raw.run("DELETE FROM closed_periods"); await L.closePeriod(d1, "2025-06", "test");
  const realBatch = d1.batch.bind(d1);
  d1.batch = async (stmts) => {
    d1._raw.run("INSERT INTO inventory_movements (blankId, blankName, size, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES (1, 'Plain tee', 'M', 7, 250, 'purchase', '2025-05-20T00:00:00.000Z', 't')");
    return realBatch(stmts);
  };
  const raced = await L.getInventoryValuations(d1, ends(["2025-07-01", "2025-07-31"]));
  d1.batch = realBatch;
  ok("a movement changed between reading the history and saving: no snapshot, no '#pending' left to trust", snapMonths("blank").length === 0 &&
    d1.q("SELECT COUNT(*) n FROM inventory_period_snapshots WHERE kind = 'blank'")[0].n === 0);
  ok("…the report itself is what the history said when it was read", raced[0].units === (await fullBlanks(d1, "2025-06-30T23:59:59.999Z")).units - 7);
  ok("…and the next report writes it right", await same("after a raced write") && snapMonths("blank").includes("2025-06"));

  console.log("\n=== Sale-date basis ===");
  ok("snapshots exist before the change", d1.q("SELECT COUNT(*) n FROM inventory_period_snapshots")[0].n > 0);
  let r = await call({ action: "updateAccountingSettings", saleDate: "shipped" });
  ok("saving the same basis keeps them", r.status === 200 && d1.q("SELECT COUNT(*) n FROM inventory_period_snapshots")[0].n > 0);
  r = await call({ action: "updateAccountingSettings", saleDate: "placed" });
  ok("changing the basis clears every snapshot", r.status === 200 && d1.q("SELECT COUNT(*) n FROM inventory_period_snapshots")[0].n === 0);
  ok("…and the reports are still the full replay's", await same("after a basis change"));
  await call({ action: "updateAccountingSettings", saleDate: "shipped" });

  console.log("\n=== The Inventory report and the accountant export ===");
  const rep = await call({ action: "getInventoryReport", dateFrom: "2025-07-01", dateTo: "2025-09-30" });
  const e = ends(["2025-07-01", "2025-09-30"]);
  ok("the Inventory report's three stocks are the full replay's", rep.status === 200 && JSON.stringify(rep.body.beginning) === JSON.stringify(await fullBlanks(d1, e[0])) &&
    JSON.stringify(rep.body.transfers.ending) === JSON.stringify(await fullTransfers(d1, e[1])) && JSON.stringify(rep.body.finished.beginning) === JSON.stringify(await fullFinished(d1, e[0])));
  const exp = await L.getAccountantExport(d1, "2025-07-01T00:00:00.000Z", "2025-09-30T23:59:59.999Z");
  const tg = exp.inventoryGroups.find(g => g.group === "Transfer sheets");
  ok("the accountant export's inventory by group has transfer sheets, beginning and ending", exp.inventoryGroups.length === 4 && !!tg &&
    tg.beginning === (await fullTransfers(d1, e[0])).value && tg.ending === (await fullTransfers(d1, e[1])).value);
  ok("…the export screen says so", /finished stock and transfer sheets — beginning and ending value">Inventory by group/.test(read("public/admin.js")));

  console.log("\n=== setOrderDates: the sale date and closed months ===");
  d1._raw.run("DELETE FROM closed_periods"); await L.closePeriod(d1, "2026-01", "test");
  const order = (id, dates) => d1._raw.run(`INSERT INTO orders (orderId, orgId, customerName, contact, subtotalCents, totalCents, paid, placedAt, manufacturedAt, qaPackedAt, shippedAt, deliveredAt, completedAt)
    VALUES (?, 'acme', 'Customer', 'c@example.com', 1000, 1000, 1, ?, ?, ?, ?, ?, ?)`, [id, dates.placedAt, dates.manufacturedAt, dates.qaPackedAt, dates.shippedAt || null, dates.deliveredAt || null, dates.completedAt || null]);
  const col = (id, c) => d1.q(`SELECT ${c} AS v FROM orders WHERE orderId = ?`, id)[0].v;
  order("SD1", { placedAt: "2025-12-01T12:00:00.000Z", manufacturedAt: "2025-12-05T12:00:00.000Z", qaPackedAt: "2025-12-06T12:00:00.000Z" });
  r = await call({ action: "setOrderDates", orderId: "SD1", dates: { shippedAt: "2026-01-10T12:00:00.000Z" } });
  ok("Shipped can't move into a closed month (orders count as sold when they ship)", r.status === 409 && /January 2026 is closed/.test(r.body.message) && /shipped/.test(r.body.message) && col("SD1", "shippedAt") === null);
  r = await call({ action: "setOrderDates", orderId: "SD1", dates: { deliveredAt: "2026-01-12T12:00:00.000Z" } });
  ok("…nor Delivered", r.status === 409 && /January 2026 is closed/.test(r.body.message) && col("SD1", "deliveredAt") === null);
  order("SD2", { placedAt: "2025-12-01T12:00:00.000Z", manufacturedAt: "2025-12-05T12:00:00.000Z", qaPackedAt: "2025-12-06T12:00:00.000Z",
    shippedAt: "2026-01-10T12:00:00.000Z", deliveredAt: "2026-01-12T12:00:00.000Z", completedAt: "2026-01-14T12:00:00.000Z" });
  r = await call({ action: "setOrderDates", orderId: "SD2", dates: { completedAt: "2026-02-14T12:00:00.000Z" } });
  ok("…nor Completed (here out of it)", r.status === 409 && /January 2026 is closed/.test(r.body.message) && col("SD2", "completedAt") === "2026-01-14T12:00:00.000Z");
  r = await call({ action: "setOrderDates", orderId: "SD2", dates: { shippedAt: "2026-02-10T12:00:00.000Z", deliveredAt: "2026-02-12T12:00:00.000Z", completedAt: "2026-02-14T12:00:00.000Z" } });
  ok("…nor Shipped out of it", r.status === 409 && col("SD2", "shippedAt") === "2026-01-10T12:00:00.000Z");
  r = await call({ action: "setOrderDates", orderId: "SD1", dates: { shippedAt: "2026-02-10T12:00:00.000Z" } });
  ok("a sale date in open months changes as before", r.status === 200 && col("SD1", "shippedAt") === "2026-02-10T12:00:00.000Z");
  await call({ action: "updateAccountingSettings", saleDate: "placed" });
  r = await call({ action: "setOrderDates", orderId: "SD2", dates: { completedAt: "2026-02-14T12:00:00.000Z" } });
  ok("with orders counted as sold when placed, Shipped / Delivered / Completed move nothing filed: allowed", r.status === 200 && col("SD2", "completedAt") === "2026-02-14T12:00:00.000Z");
  await call({ action: "updateAccountingSettings", saleDate: "shipped" });
  r = await call({ action: "setOrderDates", orderId: "SD2", dates: { placedAt: "2025-11-30T12:00:00.000Z" } });
  ok("other dates of an order sold in a closed month still change (only the sale date is held)", r.status === 200);
})().catch(e => { console.error(e); process.exit(1); });
