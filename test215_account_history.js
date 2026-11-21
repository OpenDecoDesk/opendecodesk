const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// An account's register and its reconciliation no longer read every movement since the account opened
// (db.js getAccountRegister / getReconciliationData): the balance before the dates asked for is one sum per source,
// and reconciliation reads only the unmatched movements and the ones this month's lines are matched to
// (migrations/0100 indexes each source by account and day). The numbers must be what reading everything gives.
// Real SQL (sql.js), the real migrations and db.js; invented data.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const L = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { getAccountRegister, getReconciliationData, listMoneyMoves, matchStatementLine, monthBounds, combineReceipts_ };")();
const ok = (d, c) => console.log(d + ":", !!c);
const addDays = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('shop','shop','Example Shop','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const BANK = 1, CARD = 2;
  d1._raw.run("UPDATE accounts SET openingDate = '2025-01-01', openingBalanceCents = 50000 WHERE id IN (1, 2)");
  d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, subtotalCents, totalCents, placedAt) VALUES ('O1','shop','Customer One','one@example.com',1000,1000,'2025-01-01T00:00:00Z');
    INSERT INTO blanks (id, name, createdAt, updatedAt) VALUES (1, 'Plain tee', 't', 't');`);
  const cat = d1.q("SELECT id FROM expense_categories ORDER BY id LIMIT 1")[0].id;
  // Two years of every kind of movement on the bank account (and some on the card), a few a day.
  let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let day = 0; day < 700; day += 1 + rnd(3)) {
    const d = addDays("2025-01-01", day), acct = rnd(5) ? BANK : CARD;
    switch (rnd(8)) {
      case 0: d1._raw.run("INSERT INTO order_payments (orderId, amountCents, feeCents, receivedAt, method, accountId) VALUES ('O1', ?, ?, ?, 'card', ?)", [1000 + rnd(9000), rnd(2) ? 0 : 30 + rnd(200), d + "T15:00:00Z", acct]); break;
      case 1: d1._raw.run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt, accountId) VALUES (?, 'Supplies', ?, ?, 't', 't', ?)", [d, cat, 500 + rnd(5000), acct]); break;
      case 2: d1._raw.run("INSERT INTO other_income (incomeDate, description, type, amountCents, accountId, createdAt, updatedAt) VALUES (?, 'Interest', 'interest', ?, ?, 't', 't')", [d, 1 + rnd(300), acct]); break;
      case 3: d1._raw.run("INSERT INTO owner_transactions (txDate, kind, amountCents, accountId, createdAt, updatedAt) VALUES (?, ?, ?, ?, 't', 't')", [d, rnd(2) ? "draw" : "contribution", 1000 + rnd(20000), acct]); break;
      case 4: d1._raw.run("INSERT INTO account_transfers (transferDate, fromAccountId, toAccountId, amountCents, createdAt, updatedAt) VALUES (?, ?, ?, ?, 't', 't')", [d, rnd(2) ? BANK : CARD, 0, 100 + rnd(9000)].map((v, i, a) => i === 2 ? (a[1] === BANK ? CARD : BANK) : v)); break;
      case 5: d1._raw.run("INSERT INTO shipping_labels (orderId, shippoTransactionId, amountCents, purchasedAt, accountId) VALUES ('O1', ?, ?, ?, ?)", ["tx" + day, 300 + rnd(900), d + "T10:00:00Z", acct]); break;
      case 6: {   // one stock receive: two rows written together, one charge
        const g = "rg" + day;
        for (const size of ["M", "L"]) d1._raw.run(`INSERT INTO inventory_movements (blankId, blankName, size, qtyDelta, unitCostCents, kind, occurredAt, createdAt, accountId, vendor, vendorRef, receiptGroup)
          VALUES (1, 'Plain tee', ?, ?, 350, 'purchase', ?, ?, ?, 'Example Supply', ?, ?)`, [size, 2 + rnd(10), d + "T09:00:00Z", d + "T09:00:00Z", acct, "INV-" + day, g]);
        break;
      }
      default: d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, method, accountId, voidedAt) VALUES ('O1', 999, ?, 'check', ?, 'x')", [d + "T15:00:00Z", acct]);
    }
  }

  console.log("=== The register ===");
  for (const [acct, from, to] of [[BANK, "2026-03-01", "2026-03-31"], [BANK, "2025-06-10", "2025-09-22"], [CARD, "2026-11-01", "2026-11-30"], [BANK, "2024-01-01", "2025-02-15"], [BANK, "2026-12-01", "2026-12-31"]]) {
    const part = await L.getAccountRegister(d1, acct, from, to);
    const whole = await L.getAccountRegister(d1, acct, "2025-01-01", to);   // from the opening date: every movement read, as before
    const inRange = whole.rows.filter(r => r.date >= from);
    const before = whole.rows.filter(r => r.date < from);
    const startCents = before.length ? Math.round(before[0].balance * 100) : 50000;
    const sum = (rows, sign) => rows.reduce((s, r) => s + (sign * r.amount > 0 ? Math.round(sign * r.amount * 100) : 0), 0) / 100;
    ok(`${part.account.name} ${from}…${to}: the same rows, running balances and totals as reading everything`,
      JSON.stringify(part.rows) === JSON.stringify(inRange) && Math.round(part.startBalance * 100) === startCents && part.endBalance === whole.endBalance &&
      part.totalIn === sum(inRange, 1) && part.totalOut === sum(inRange, -1) && part.count === inRange.length);
  }
  const mar = await L.getAccountRegister(d1, BANK, "2026-03-01", "2026-03-31");
  ok("…a stock receive's two rows are still one register row with its parts", mar.rows.some(r => r.parts && r.parts.length === 2) || !d1.q("SELECT 1 FROM inventory_movements WHERE accountId = 1 AND occurredAt LIKE '2026-03%'").length);

  console.log("\n=== Reconciliation ===");
  // Statement lines: most moves up to the end of 2026-05 cleared (matched), a few never did, one line ignored,
  // and a June line matched to a move from long before June (an old check finally cleared).
  const moves = await L.listMoneyMoves(d1, BANK, "2025-01-01", "2026-06-30");
  let n = 0;
  const line = (date, cents, ignored) => { n++; d1._raw.run("INSERT INTO statement_lines (accountId, lineDate, description, amountCents, fingerprint, importedAt, ignoredAt) VALUES (?, ?, 'line', ?, ?, 't', ?)", [BANK, date, cents, "f" + n, ignored ? "t" : null]);
    return d1.q("SELECT MAX(id) AS id FROM statement_lines")[0].id; };
  const lateCleared = moves.find(m => m.date < "2025-03-01" && m.cents !== 0);
  for (const m of moves) {
    if (m === lateCleared || m.cents === 0 || m.date > "2026-06-25" || rnd(13) === 0) continue;
    const lid = line(m.date > "2026-05-31" ? m.date : addDays(m.date, rnd(3)) > "2026-05-31" ? m.date : addDays(m.date, rnd(3)), m.cents);
    d1._raw.run("INSERT INTO statement_matches (lineId, src, srcId, matchedAt) VALUES (?, ?, ?, 't')", [lid, m.src, m.srcId]);
  }
  const lid = line("2026-06-12", lateCleared.cents);
  ok("a June line can be matched to a move from long before June (only the chosen move is looked up)", (await L.matchStatementLine(d1, lid, [lateCleared.key])).ok === true);
  line("2026-06-15", 1234, true);
  // A matched move later voided: its line shows as broken.
  const junePay = moves.find(m => m.src === "payment" && m.date >= "2026-06-01" && m.date <= "2026-06-20");
  if (junePay) d1._raw.run("UPDATE order_payments SET voidedAt = 'later' WHERE id = ?", [junePay.srcId]);

  // What reading everything gives (the old way): every move from the opening date, and the matched keys.
  const oldWay = async (accountId, month) => {
    const { from, to } = L.monthBounds(month);
    const all = await L.listMoneyMoves(d1, accountId, "2025-01-01", addDays(to, 10));
    const taken = new Set(d1.q("SELECT sm.src || ':' || sm.srcId AS k FROM statement_matches sm JOIN statement_lines sl ON sl.id = sm.lineId WHERE sl.accountId = ?", accountId).map(r => r.k));
    const byKey = new Map(all.map(m => [m.key, m]));
    const through = all.filter(m => m.date <= to);
    const book = 50000 + through.reduce((a, m) => a + m.cents, 0);
    const uncleared = through.filter(m => !taken.has(m.key));
    const keysOf = async (list) => (await L.combineReceipts_(d1, list)).map(e => e.keys.join("+")).join(",");
    const lines = [];
    for (const l of d1.q("SELECT * FROM statement_lines WHERE accountId = ? AND lineDate >= ? AND lineDate <= ? ORDER BY lineDate, id", accountId, from, to)) {
      const keys = d1.q("SELECT src || ':' || srcId AS k FROM statement_matches WHERE lineId = ?", l.id).map(r => r.k);
      const items = keys.map(k => byKey.get(k)).filter(Boolean);
      lines.push(l.id + "=" + (l.ignoredAt ? "ignored" : keys.length && items.length !== keys.length ? "broken" : items.length ? "matched" : "unmatched") + ":" + (await keysOf(items)));
    }
    return { book, uncleared: uncleared.reduce((a, m) => a + m.cents, 0), lines: lines.join("|"),
      unmatchedBook: await keysOf(uncleared.filter(m => m.date >= from)), unclearedEarlier: await keysOf(uncleared.filter(m => m.date < from)),
      candidates: await keysOf(all.filter(m => !taken.has(m.key) && m.date >= addDays(from, -10))) };
  };
  for (const month of ["2026-06", "2026-03", "2025-01", "2026-12"]) {
    const r = await L.getReconciliationData(d1, BANK, month), o = await oldWay(BANK, month);
    const keys = (list) => list.map(e => e.keys.join("+")).join(",");
    const lines = r.lines.map(l => l.id + "=" + l.status + ":" + keys(l.matched)).join("|");
    ok(`${month}: the same book balance, uncleared total and expected statement balance`, Math.round(r.bookBalance * 100) === o.book && Math.round(r.uncleared * 100) === o.uncleared &&
      Math.round(r.expectedStatementBalance * 100) === o.book - o.uncleared + Math.round(r.ignored * 100));
    ok(`${month}: the same lines (matched, broken, ignored) and the same uncleared, earlier and candidate lists`, lines === o.lines && keys(r.unmatchedBook) === o.unmatchedBook &&
      keys(r.unclearedEarlier) === o.unclearedEarlier && keys(r.candidates) === o.candidates);
  }
  const june = await L.getReconciliationData(d1, BANK, "2026-06");
  ok("…June shows the old move its line was matched to, and a line whose payment was voided as broken", june.lines.some(l => l.status === "matched" && l.matched.some(e => e.keys.includes(lateCleared.key))) &&
    (!junePay || june.lines.some(l => l.status === "broken")));
  ok("…and some moves that never cleared are listed as earlier uncleared", june.unclearedEarlier.length > 0);

  console.log("\n=== Indexed by account and day (migrations/0100) ===");
  const src = read("functions/_lib/db.js");
  const sources = eval("(" + /export const MONEY_MOVE_SOURCES = (\[[\s\S]*?\n\]);/.exec(src)[1].replace(/^\s*\/\/.*$/gm, "") + ")");
  const plans = sources.map(sql => d1._raw.exec(`EXPLAIN QUERY PLAN SELECT * FROM (${sql}) m WHERE m.accountId = 1 AND m.d >= '2026-01-01' AND m.d <= '2026-01-31'`)[0].values.map(r => r[r.length - 1]).join(" ; "));
  ok("every money source is read through an index on its account and day", plans.length === 10 && plans.every(p => /USING INDEX idx_\w+_(account_day|account_date|account|from_account|to_account) \((from|to)?[aA]ccountId=\? AND/.test(p)));
})().catch(e => { console.error(e); process.exit(1); });
