const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// The Inventory & COGS report and the accountant export read each stock history (transfers, finished stock, and
// costs on orders not sold yet) once for the period's beginning and end, as the blank valuation already did
// (db.js getTransferValuations / getFinishedGoodsValuations / getOrderCostsNotYetSoldAt). The numbers must be the
// ones the separate one-moment reads gave. Real SQL (sql.js), the real migrations and db.js; invented data.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const L = new Function(strip(read("functions/_lib/db.js")) + `\nreturn { getTransferValuation, getTransferValuations, getFinishedGoodsValuation, getFinishedGoodsValuations,
  getOrderCostsNotYetSold, getOrderCostsNotYetSoldAt, getAccountantExport, saleDateSql_ };`)();
const ok = (d, c) => console.log(d + ":", !!c);
const fromCents = (c) => Math.round(c) / 100;

// The one-moment reads as they were before (each replaying the whole history up to its moment).
async function oldTransferValuation(db, asOf) {
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
async function oldFinishedValuation(db, asOf) {
  const { results } = await db.prepare("SELECT orgId, productId, productName, size, variant, variantLabel, qtyDelta, unitCostCents, kind FROM finished_goods_movements WHERE occurredAt <= ? AND voidedAt IS NULL ORDER BY occurredAt, id").bind(asOf).all();
  const state = new Map();
  for (const m of results) {
    const key = [m.orgId, m.productId, m.size || "", m.variant || ""].join("|");
    const st = state.get(key) || { orgId: m.orgId, productId: m.productId, name: m.productName, size: m.size || "", variant: m.variant || "", label: "", qty: 0, avg: 0 };
    const d = Number(m.qtyDelta);
    if (d > 0 && m.kind !== "sell") { const on = Math.max(0, st.qty); st.avg = Math.round((on * st.avg + d * Number(m.unitCostCents)) / (on + d)); }
    st.qty += d; st.name = m.productName || st.name; st.label = m.variantLabel || st.label; state.set(key, st);
  }
  const rows = [...state.values()].filter(r => r.qty !== 0).map(r => ({ orgId: r.orgId, productId: r.productId, name: r.label ? r.name + " · " + r.label : r.name, size: r.size, variant: r.variant, qty: r.qty, avgCost: fromCents(r.avg), value: fromCents(Math.max(0, r.qty) * r.avg) }))
    .sort((a, b) => (a.orgId + a.name + a.size).localeCompare(b.orgId + b.name + b.size));
  return { asOf, rows, units: rows.reduce((s, r) => s + r.qty, 0), value: fromCents(rows.reduce((s, r) => s + Math.round(r.value * 100), 0)) };
}
async function oldNotYetSold(db, asOf, basis) {
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
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('shop','shop','Example Shop','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO blanks (id, name, createdAt, updatedAt) VALUES (1, 'Plain tee', 't', 't');`);
  let seed = 11; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const day = (n) => new Date(Date.parse("2025-01-01T00:00:00Z") + n * 86400000 + rnd(86400) * 1000).toISOString();
  // Orders over two years, some shipped later than made (basis "shipped"), with blanks, transfers and finished stock used on them.
  for (let i = 0; i < 120; i++) {
    const placed = day(i * 6), shipped = rnd(4) ? day(i * 6 + 2 + rnd(30)) : null, id = "ORD-" + i;
    d1._raw.run("INSERT INTO orders (orderId, orgId, customerName, contact, subtotalCents, totalCents, placedAt, shippedAt) VALUES (?, 'shop', 'Customer', 'c@example.com', 1000, 1000, ?, ?)", [id, placed, shipped]);
    const made = day(i * 6 + 1);
    d1._raw.run("INSERT INTO inventory_movements (blankId, blankName, size, qtyDelta, unitCostCents, kind, orderId, occurredAt, createdAt) VALUES (1, 'Plain tee', 'M', ?, ?, 'consume', ?, ?, ?)", [-(1 + rnd(4)), 300 + rnd(100), id, made, made]);
    d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, occurredAt, createdAt) VALUES (?, ?, ?, ?, 'consume', ?, ?, ?)", [1 + rnd(3), "Crest", -(1 + rnd(3)), 80 + rnd(40), id, made, made]);
    if (rnd(3) === 0) d1._raw.run("INSERT INTO finished_goods_movements (orgId, productId, productName, size, qtyDelta, unitCostCents, kind, orderId, occurredAt, createdAt) VALUES ('shop', 'cap', 'Cap', '', -1, ?, 'sell', ?, ?, ?)", [900 + rnd(200), id, made, made]);
  }
  for (let i = 0; i < 90; i++) {
    const at = day(i * 8);
    d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, occurredAt, createdAt, voidedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [1 + rnd(3), ["Crest", "Logo", "Mascot"][rnd(3)], rnd(5) ? 10 + rnd(40) : -(1 + rnd(5)), 60 + rnd(60), rnd(5) ? "purchase" : "writeoff", at, at, rnd(15) ? null : "x"]);
    d1._raw.run("INSERT INTO finished_goods_movements (orgId, productId, productName, size, variant, variantLabel, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES ('shop', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [["cap", "tee"][rnd(2)], ["Cap", "Tee"][rnd(2)], ["", "M", "L"][rnd(3)], rnd(3) ? "" : "navy", rnd(3) ? "" : "Navy", rnd(4) ? 2 + rnd(8) : -(1 + rnd(3)), 700 + rnd(500), rnd(4) ? "make" : "adjust", at, at]);
  }

  const periods = [["2025-03-01", "2025-03-31"], ["2025-07-01", "2026-06-30"], ["2026-01-01", "2026-12-31"], ["2024-01-01", "2024-12-31"]];
  for (const [from, to] of periods) {
    const ends = [new Date(Date.parse(from + "T00:00:00.000Z") - 1).toISOString(), to + "T23:59:59.999Z"];
    const [t0, t1] = await L.getTransferValuations(d1, ends), [f0, f1] = await L.getFinishedGoodsValuations(d1, ends);
    ok(`${from}…${to}: transfers at both ends, read once, are what the separate reads gave`,
      JSON.stringify([t0, t1]) === JSON.stringify([await oldTransferValuation(d1, ends[0]), await oldTransferValuation(d1, ends[1])]));
    ok(`${from}…${to}: finished stock at both ends, read once, is what the separate reads gave`,
      JSON.stringify([f0, f1]) === JSON.stringify([await oldFinishedValuation(d1, ends[0]), await oldFinishedValuation(d1, ends[1])]));
    for (const basis of ["shipped", "placed"]) {
      const both = await L.getOrderCostsNotYetSoldAt(d1, ends, { basis });
      ok(`${from}…${to}: costs on orders not yet sold (${basis}) at both ends, one read`, JSON.stringify(both) === JSON.stringify([await oldNotYetSold(d1, ends[0], basis), await oldNotYetSold(d1, ends[1], basis)]));
    }
  }
  const ends = ["2026-05-31T23:59:59.999Z", "2025-02-28T23:59:59.999Z", "2025-11-30T23:59:59.999Z"];   // out of order
  ok("moments in any order come back in the order asked", JSON.stringify(await L.getTransferValuations(d1, ends)) === JSON.stringify(await Promise.all(ends.map(e => oldTransferValuation(d1, e)))) &&
    JSON.stringify(await L.getFinishedGoodsValuations(d1, ends)) === JSON.stringify(await Promise.all(ends.map(e => oldFinishedValuation(d1, e)))));
  ok("the one-moment forms still give the same answer", JSON.stringify(await L.getTransferValuation(d1, ends[0])) === JSON.stringify(await oldTransferValuation(d1, ends[0])) &&
    JSON.stringify(await L.getFinishedGoodsValuation(d1, ends[0])) === JSON.stringify(await oldFinishedValuation(d1, ends[0])) &&
    JSON.stringify(await L.getOrderCostsNotYetSold(d1, ends[0], { basis: "shipped" })) === JSON.stringify(await oldNotYetSold(d1, ends[0], "shipped")));
  const exp = await L.getAccountantExport(d1, "2025-07-01T00:00:00.000Z", "2026-06-30T23:59:59.999Z");
  const fin = exp.inventoryGroups.find(g => g.group === "Finished stock");
  ok("the accountant export's finished stock beginning and ending come from the one read", fin.beginning === (await oldFinishedValuation(d1, "2025-06-30T23:59:59.999Z")).value &&
    fin.ending === (await oldFinishedValuation(d1, "2026-06-30T23:59:59.999Z")).value);
  const ordersSrc = read("functions/api/orders.js");
  ok("the Inventory report reads each history once for both ends", /getTransferValuations\(env\.DB, ends\)/.test(ordersSrc) && /getFinishedGoodsValuations\(env\.DB, ends\)/.test(ordersSrc) &&
    /getOrderCostsNotYetSoldAt\(env\.DB, ends/.test(ordersSrc) && !/getTransferValuation\(env\.DB, dayBefore\)/.test(ordersSrc));
})().catch(e => { console.error(e); process.exit(1); });
