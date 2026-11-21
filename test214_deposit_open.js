const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// The Reconcile deposit picker (db.js getDepositPayments) reads only payments marked depositOpen (migrations/0218),
// kept by triggers on cash-outs, transfers, statement matches and amounts, instead of working out every payment ever
// recorded. It must list exactly what the old whole-history query listed, before and after every kind of change.
// Real SQL (sql.js), the real migrations and db.js; invented data.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { getDepositPayments };")();
const ok = (d, c) => console.log(d + ":", !!c);
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();

// The query as it was before 0218: every payment's cash-outs and matches worked out, then filtered.
async function oldDepositPayments(d1) {
  const { results } = await d1.prepare(`SELECT * FROM (
       SELECT p.id, p.amountCents, p.receivedAt,
         COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL WHERE c.paymentId = p.id), 0) AS allocatedCents,
         EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = p.id) AS matched
         FROM order_payments p JOIN orders o ON o.orderId = p.orderId LEFT JOIN accounts a ON a.id = p.accountId
        WHERE p.method IN ('venmo', 'cash', 'check', 'zelle', 'card') AND p.kind = 'payment' AND p.voidedAt IS NULL AND p.accountId IS NOT NULL
          AND o.voidedAt IS NULL AND o.isTest = 0
     ) WHERE allocatedCents < amountCents AND matched = 0 ORDER BY receivedAt DESC, id DESC LIMIT 300`).all();
  return results.map(r => r.id + ":" + (Number(r.amountCents) - Number(r.allocatedCents))).join(",");
}
const newDepositPayments = async (d1) => (await lib.getDepositPayments(d1)).map(r => r.id + ":" + r.remainingCents).join(",");

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('shop','shop','Example Shop','t','t');`);
  for (const f of migrations.filter(f => f < "0218")) d1.execFile(read("migrations/" + f));
  const accts = d1.q("SELECT id FROM accounts ORDER BY id").map(r => r.id);
  const [BANK, OTHER] = [accts[0], accts[accts.length - 1]];
  // Payments of every kind before the migration: open, part cashed out, fully cashed out, cashed out on a deleted
  // transfer, matched to a bank line, a refund, voided, on a test order, with no account.
  d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, subtotalCents, totalCents, placedAt) VALUES
      ('A','shop','Customer A','a@example.com',10000,10000,'2026-09-01T00:00:00Z'), ('T','shop','Test','t@example.com',500,500,'2026-09-01T00:00:00Z');
    UPDATE orders SET isTest = 1 WHERE orderId = 'T';`);
  const pay = (amount, method, day, extra = {}) => { d1._raw.run(`INSERT INTO order_payments (orderId, amountCents, receivedAt, method, accountId, kind, voidedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [extra.order || "A", amount, `2026-09-${String(day).padStart(2, "0")}T12:00:00Z`, method, extra.noAccount ? null : OTHER, extra.kind || "payment", extra.voided ? "2026-09-30T00:00:00Z" : null]);
    return d1.q("SELECT MAX(id) AS id FROM order_payments")[0].id; };
  const transfer = (cents, deleted) => { d1._raw.run(`INSERT INTO account_transfers (transferDate, fromAccountId, toAccountId, amountCents, createdAt, updatedAt, deletedAt) VALUES ('2026-09-20', ?, ?, ?, 't', 't', ?)`,
    [OTHER, BANK, cents, deleted ? "t" : null]); return d1.q("SELECT MAX(id) AS id FROM account_transfers")[0].id; };
  const cashout = (paymentId, transferId, cents) => d1._raw.run("INSERT INTO payment_cashouts (paymentId, transferId, amountCents, createdAt) VALUES (?, ?, ?, 't')", [paymentId, transferId, cents]);
  let line = 0;
  const match = (paymentId, cents) => { line++; d1._raw.run(`INSERT INTO statement_lines (accountId, lineDate, amountCents, fingerprint, importedAt) VALUES (?, '2026-09-21', ?, ?, 't')`, [BANK, cents, "fp" + line]);
    const lid = d1.q("SELECT MAX(id) AS id FROM statement_lines")[0].id; d1._raw.run("INSERT INTO statement_matches (lineId, src, srcId, matchedAt) VALUES (?, 'payment', ?, 't')", [lid, paymentId]); return lid; };
  const open = pay(2000, "venmo", 1), part = pay(3000, "cash", 2), full = pay(1500, "venmo", 3), onDeleted = pay(1200, "cash", 4), matched = pay(900, "check", 5);
  pay(-500, "venmo", 6, { kind: "refund" }); pay(700, "cash", 7, { voided: true }); pay(500, "card", 8, { order: "T" }); pay(800, "zelle", 9, { noAccount: true });
  const t1 = transfer(4500), tDel = transfer(1200, true);
  cashout(part, t1, 1000); cashout(full, t1, 1500); cashout(onDeleted, tDel, 1200);
  const matchedLine = match(matched, 900);
  const before = await oldDepositPayments(d1);
  for (const f of migrations.filter(f => f >= "0218")) d1.execFile(read("migrations/" + f));
  ok("after the migration: the same payments, with the same amounts left, as the old query", (await newDepositPayments(d1)) === before && before.split(",").length === 3);
  ok("…the fully cashed out and the matched ones are marked not open", d1.q("SELECT depositOpen FROM order_payments WHERE id IN (?, ?)", full, matched).every(r => r.depositOpen === 0) &&
    d1.q("SELECT depositOpen FROM order_payments WHERE id = ?", open)[0].depositOpen === 1);

  const same = async (label) => { const o = await oldDepositPayments(d1), n = await newDepositPayments(d1); ok(label, o === n); return n; };
  cashout(open, t1, 2000);
  let now = await same("a cash-out covering the rest closes a payment");
  ok("…it's no longer listed", !now.split(",").some(x => x.startsWith(open + ":")));
  d1._raw.run("UPDATE account_transfers SET deletedAt = 't' WHERE id = ?", [t1]);
  now = await same("deleting the transfer reopens every payment it cashed out");
  ok("…they're listed again, with their full amounts", now.split(",").includes(open + ":2000") && now.split(",").includes(full + ":1500") && now.split(",").includes(part + ":3000"));
  d1._raw.run("UPDATE account_transfers SET deletedAt = NULL WHERE id = ?", [t1]);
  await same("bringing the transfer back closes them again");
  d1._raw.run("DELETE FROM payment_cashouts WHERE paymentId = ?", [full]);
  now = await same("removing a cash-out reopens its payment");
  ok("…listed", now.split(",").includes(full + ":1500"));
  d1._raw.run("UPDATE payment_cashouts SET amountCents = 500 WHERE paymentId = ?", [open]);
  await same("lowering a cash-out reopens what it no longer covers");
  d1._raw.run("DELETE FROM statement_lines WHERE id = ?", [matchedLine]);
  now = await same("deleting the bank line a payment was matched to reopens it (the match goes with the line)");
  ok("…listed", now.split(",").includes(matched + ":900"));
  const l2 = match(matched, 900);
  await same("matching it again closes it");
  d1._raw.run("UPDATE statement_matches SET srcId = ? WHERE lineId = ?", [open, l2]);
  await same("moving a match to another payment reopens the first and closes the second");
  d1._raw.run("DELETE FROM statement_matches WHERE lineId = ?", [l2]);
  await same("unmatching a line reopens its payment");
  cashout(part, t1, 2000);
  await same("cashing out the rest of a part-cashed payment closes it");
  d1._raw.run("UPDATE order_payments SET amountCents = 3500 WHERE id = ?", [part]);
  now = await same("raising a closed payment's amount reopens it for the difference");
  ok("…with $5 left", now.split(",").includes(part + ":500"));
  const fresh = pay(1100, "cash", 15);
  now = await same("a new payment is open");
  ok("…listed", now.split(",").includes(fresh + ":1100"));

  // Many years of payments, nearly all deposited long ago: the picker reads only the open ones.
  const t2 = transfer(100000);
  for (let i = 0; i < 400; i++) { const id = pay(250, "venmo", 1 + (i % 28)); if (i % 40) cashout(id, t2, 250); }
  await same("on a long history the picker still lists exactly the open ones");
  const plan = d1._raw.exec(`EXPLAIN QUERY PLAN SELECT p.id FROM order_payments p JOIN orders o ON o.orderId = p.orderId LEFT JOIN accounts a ON a.id = p.accountId
    WHERE p.depositOpen = 1 AND p.method IN ('venmo', 'cash', 'check', 'zelle', 'card') AND p.kind = 'payment' AND p.voidedAt IS NULL AND p.accountId IS NOT NULL AND o.voidedAt IS NULL AND o.isTest = 0`)[0].values.map(r => r[r.length - 1]).join(" ; ");
  ok("…found through idx_payments_deposit_open, not a scan of every payment", /idx_payments_deposit_open/.test(plan));

  // A deposit naming many payments: one JSON list, not one bound parameter each (D1 allows 100).
  const ids = d1.q("SELECT id FROM order_payments ORDER BY id").map(r => r.id);
  const capped = { ...d1, prepare(sql) { const st = d1.prepare(sql); return { ...st, bind: (...p) => { if (p.length > 100) throw new Error("too many SQL variables"); return st.bind(...p); } }; } };
  const byIds = await lib.getDepositPayments(capped, ids);
  ok("asking for " + ids.length + " payments by id works under D1's 100-parameter limit, giving the open ones", ids.length > 100 && byIds.length === (await lib.getDepositPayments(d1)).length);
  ok("schema.sql has the column, the index and the triggers", /depositOpen INTEGER NOT NULL DEFAULT 1/.test(read("schema.sql")) && /idx_payments_deposit_open/.test(read("schema.sql")) &&
    (read("schema.sql").match(/CREATE TRIGGER IF NOT EXISTS \w+_deposit_open/g) || []).length === 9);
})().catch(e => { console.error(e); process.exit(1); });
