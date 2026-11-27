// More than one discount code per order, minimum-order and free-shipping codes (migrations/0120, 2026-11) — the
// database side and db.js's discount engine, called directly:
//   migrations/0120 and schema.sql   every new column (its type, NOT NULL, default and CHECK) on discount_codes, orders,
//                                    estimates and order_payments; the gift_cards and gift_card_ledger tables and their
//                                    indexes; one use per (order, code) with a plain index on the order; the migration
//                                    on a database just before it (exactly what it adds, existing rows defaulted) and
//                                    the shipped migration list
//   combineDiscounts_                percent codes add up and come off first, capped at the goods; a percent code's max
//                                    caps its own share; amount codes in the order given against what is left; free
//                                    shipping once, credited to the first; half-up rounding; empty, zero goods, zero
//                                    shipping; rows and parsed codes alike
//   discountForCode_                 a code that takes nothing off the goods (goodsOff 0, or a parsed "shipping")
//   normalizeDiscountCodeInput_      kind "shipping", minOrder and freeShipping — every message
//   saveDiscountCode and readers     the free-shipping-only storage hidden (kind "shipping"), the label, minOrder and
//                                    freeShipping locked once used, the codes-for-emails list carrying them, and a
//                                    database before 0120 (writes say it isn't ready; reads still work)
//   getDiscountRules / buildDiscountRules / setDiscountRules   off by default, odd saved values read as off, bad input refused
//   checkDiscountCode with others    the one-code and same-code refusals, the minimum, and the combined answer
// Real SQL (sql.js) and the real files. Invented shops, codes and addresses only; every date is passed in.
process.env.TZ = "UTC";
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
global.fetch = async (url) => { throw new Error("unexpected fetch " + url); };

const lib = new Function(strip(read("functions/_lib/db.js")) +
  "\nreturn { combineDiscounts_, discountForCode_, normalizeDiscountCodeInput_, saveDiscountCode, getDiscountCode, listDiscountCodes," +
  " createDiscountCodesForEmails, checkDiscountCode, getDiscountRules, buildDiscountRules, setDiscountRules, writeSettingBuilds, insertOrder };")();
const { MIGRATIONS } = new Function(strip(read("functions/_lib/migrationList.js")) + "\nreturn { MIGRATIONS };")();

const MIGRATION = "0120_gift_cards_multi_codes.sql";
const migrationFiles = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function makeDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrationFiles) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t0','t0'), ('works','works','Sample Works','t0','t0');`);
  return d1;
}
const say = (line) => console.log("\n" + line);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fails = (d1, sql, ...p) => { try { d1.q(sql, ...p); return ""; } catch (e) { return String(e && e.message || e); } };
const norm = (s) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").replace(/ IF NOT EXISTS/i, "").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
const tableSql = (d1, name) => { const r = d1.q("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", name)[0]; return r ? norm(r.sql) : ""; };
const indexSql = (d1, name) => { const r = d1.q("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", name)[0]; return r ? norm(r.sql) : ""; };
const cols = (d1, table) => d1.q(`PRAGMA table_info(${table})`).map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
const col = (d1, table, name) => JSON.stringify(cols(d1, table).find(c => c[0] === name) || null);
const shape = (d1, table) => JSON.stringify(cols(d1, table));
// The same columns whatever their order (order_payments' receipt columns sat in another place in schema.sql long before 0120).
const colSet = (d1, table) => JSON.stringify(cols(d1, table).map(c => JSON.stringify(c)).sort());
const fks = (d1, table) => d1.q(`PRAGMA foreign_key_list(${table})`).map(k => [k.from, k.table, k.to]);
const objects = (d1) => d1.q("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
const CHECK = /CHECK constraint failed/;
const TODAY = "2027-06-15", NOW = "2027-06-15T12:00:00.000Z";
const CAP = [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 2, unitPrice: 20 }];
const placeOrder = (d1, orderId) => lib.insertOrder(d1, { orderId, orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2027-06-15T12:00:00.000Z" }, CAP);
const insertRow = (d1, table, row) => { const k = Object.keys(row); return fails(d1, `INSERT INTO ${table} (${k.join(", ")}) VALUES (${k.map(() => "?").join(", ")})`, ...k.map(x => row[x])); };
let codeN = 0;
const addCode = (d1, extra) => insertRow(d1, "discount_codes", Object.assign({ code: "M" + String(++codeN).padStart(3, "0"), kind: "percent", percentBps: 1000, maxUses: 5, createdAt: "t0" }, extra));
const save = (d1, input) => lib.saveDiscountCode(d1, input, { actor: "pat@example.com", now: NOW, today: TODAY });
const useCode = (d1, codeId, orderId) => d1.q("INSERT INTO discount_code_uses (codeId, orderId, email, amountCents, usedAt) VALUES (?, ?, '', 100, 't1')", codeId, orderId);
const C = (o) => lib.combineDiscounts_(o.codes, o.at);
const shares = (r) => r.perCode.map(p => [p.goodsOffCents, p.shippingOffCents]);

(async () => {
  // =====================================================================================================
  say("=== The database: migrations/0120 and schema.sql build the same columns, tables and indexes ===");
  const migrated = await makeDb();
  const fresh = await createD1();
  fresh._raw.exec(read("schema.sql"));
  fresh._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t0','t0');`);
  const newCols = [["discount_codes", "minOrderCents", '["minOrderCents","INTEGER",0,null,0]'],
    ["discount_codes", "freeShipping", '["freeShipping","INTEGER",1,"0",0]'],
    ["discount_codes", "goodsOff", '["goodsOff","INTEGER",1,"1",0]'],
    ["orders", "reorderOf", `["reorderOf","TEXT",1,"''",0]`],
    ["orders", "shippingDiscountCents", '["shippingDiscountCents","INTEGER",1,"0",0]'],
    ["estimates", "discountCodes", `["discountCodes","TEXT",1,"'[]'",0]`],
    ["order_payments", "giftCardId", '["giftCardId","INTEGER",0,null,0]']];
  for (const [t, c, want] of newCols) {
    ok(`${t}.${c} after the migrations is ${want.replace(/[\[\]"]/g, "").replace(/,/g, " ")} (name type notnull default pk)`, col(migrated, t, c) === want);
    ok(`…and schema.sql's ${t}.${c} is the same`, col(fresh, t, c) === want);
  }
  for (const t of ["discount_codes", "orders", "estimates", "discount_code_uses", "gift_cards", "gift_card_ledger"])
    ok(`${t}: schema.sql's columns are the migrations', in the same order`, shape(fresh, t) === shape(migrated, t) && shape(migrated, t) !== "[]");
  ok("order_payments: schema.sql has the migrations' columns, with giftCardId last in both", colSet(fresh, "order_payments") === colSet(migrated, "order_payments") &&
    cols(fresh, "order_payments").slice(-1)[0][0] === "giftCardId" && cols(migrated, "order_payments").slice(-1)[0][0] === "giftCardId");
  for (const t of ["gift_cards", "gift_card_ledger"]) {
    ok(`${t}: schema.sql's CREATE statement (every CHECK) is the migration's, word for word`, !!tableSql(migrated, t) && tableSql(fresh, t) === tableSql(migrated, t));
    ok(`${t}: the same foreign keys in both`, same(fks(fresh, t), fks(migrated, t)));
  }
  ok("a ledger row refers to its card (gift_card_ledger.cardId → gift_cards.id); a card refers to nothing",
    same(fks(migrated, "gift_card_ledger"), [["cardId", "gift_cards", "id"]]) && same(fks(migrated, "gift_cards"), []));
  ok("order_payments.giftCardId has no foreign key (a plain integer)", !fks(migrated, "order_payments").some(k => k[0] === "giftCardId"));
  const wantIdx = {
    idx_discount_uses_order_code: "CREATE UNIQUE INDEX idx_discount_uses_order_code ON discount_code_uses(orderId, codeId)",
    idx_discount_uses_order: "CREATE INDEX idx_discount_uses_order ON discount_code_uses(orderId)",
    idx_gift_cards_code: "CREATE UNIQUE INDEX idx_gift_cards_code ON gift_cards(code)",
    idx_gift_cards_source: "CREATE UNIQUE INDEX idx_gift_cards_source ON gift_cards(sourceOrderId) WHERE sourceOrderId <> ''",
    idx_gift_card_ledger_card: "CREATE INDEX idx_gift_card_ledger_card ON gift_card_ledger(cardId, id)",
    idx_order_payments_giftcard: "CREATE INDEX idx_order_payments_giftcard ON order_payments(giftCardId) WHERE giftCardId IS NOT NULL",
  };
  for (const [ix, want] of Object.entries(wantIdx)) {
    ok(`after the migrations the index is: ${want}`, indexSql(migrated, ix) === want);
    ok(`…and schema.sql makes the same ${ix}`, indexSql(fresh, ix) === want);
  }

  for (const [d1, built] of [[migrated, "after the migrations"], [fresh, "in a new database from schema.sql"]]) {
    say(`The new CHECKs and defaults, ${built}`);
    ok(`a code with only the old columns gets no minimum, no free shipping and takes its value off the goods, ${built}`, addCode(d1, { code: "PLAIN" }) === "" &&
      same(d1.q("SELECT minOrderCents, freeShipping, goodsOff FROM discount_codes WHERE code = 'PLAIN'")[0], { minOrderCents: null, freeShipping: 0, goodsOff: 1 }));
    ok(`a minimum of 1 cent and of $100,000 (10000000) are taken, ${built}`, addCode(d1, { minOrderCents: 1 }) === "" && addCode(d1, { minOrderCents: 10000000 }) === "");
    ok(`a minimum of 0 is refused, ${built}`, CHECK.test(addCode(d1, { minOrderCents: 0 })));
    ok(`a minimum over $100,000 (10000001) is refused, ${built}`, CHECK.test(addCode(d1, { minOrderCents: 10000001 })));
    ok(`a negative minimum is refused, ${built}`, CHECK.test(addCode(d1, { minOrderCents: -100 })));
    ok(`freeShipping 1 and goodsOff 0 are taken (the free-shipping-only shape: percent 10000), ${built}`, addCode(d1, { percentBps: 10000, freeShipping: 1, goodsOff: 0 }) === "");
    ok(`freeShipping 2 is refused, ${built}`, CHECK.test(addCode(d1, { freeShipping: 2 })));
    ok(`freeShipping NULL is refused (NOT NULL), ${built}`, /NOT NULL constraint failed: discount_codes\.freeShipping/.test(addCode(d1, { freeShipping: null })));
    ok(`goodsOff 2 and -1 are refused, ${built}`, CHECK.test(addCode(d1, { goodsOff: 2 })) && CHECK.test(addCode(d1, { goodsOff: -1 })));
    ok(`goodsOff NULL is refused (NOT NULL), ${built}`, /NOT NULL constraint failed: discount_codes\.goodsOff/.test(addCode(d1, { goodsOff: null })));
    ok(`the kind CHECK is unchanged: kind 'shipping' is still refused in the table, ${built}`, CHECK.test(addCode(d1, { kind: "shipping" })));

    const ids = d1.q("SELECT id FROM discount_codes ORDER BY id LIMIT 2").map(r => r.id);
    const use = (orderId, codeId) => insertRow(d1, "discount_code_uses", { codeId, orderId, usedAt: "t1" });
    ok(`an order can carry two different codes, ${built}`, use("D-1", ids[0]) === "" && use("D-1", ids[1]) === "");
    ok(`but not the same code twice (UNIQUE orderId, codeId), ${built}`, /UNIQUE constraint failed: discount_code_uses\.orderId, discount_code_uses\.codeId/.test(use("D-1", ids[0])));
    d1.q("UPDATE discount_code_uses SET releasedAt = 't2' WHERE orderId = 'D-1'");
    ok(`…not even once that use was given back (one row per pair), ${built}`, /UNIQUE constraint failed/.test(use("D-1", ids[0])));
    ok(`another order can use the same code, ${built}`, use("D-2", ids[0]) === "");

    await placeOrder(d1, "O-1");
    const o = d1.q("SELECT reorderOf, shippingDiscountCents FROM orders WHERE orderId = 'O-1'")[0];
    ok(`a new order reorders nothing ('') and has no shipping discount (0), ${built}`, !!o && o.reorderOf === "" && o.shippingDiscountCents === 0);
    ok(`a shipping discount of 0 or more is taken, a negative one refused, ${built}`,
      fails(d1, "UPDATE orders SET shippingDiscountCents = 800 WHERE orderId = 'O-1'") === "" && CHECK.test(fails(d1, "UPDATE orders SET shippingDiscountCents = -1 WHERE orderId = 'O-1'")));
    ok(`reorderOf can't be NULL, ${built}`, /NOT NULL constraint failed: orders\.reorderOf/.test(fails(d1, "UPDATE orders SET reorderOf = NULL WHERE orderId = 'O-1'")));

    d1.q("INSERT INTO customers (name, createdAt, updatedAt) VALUES ('Pat Example', 't0', 't0')");
    const custId = d1.q("SELECT max(id) AS id FROM customers")[0].id;
    ok(`a quote with no codes stores '[]', ${built}`, insertRow(d1, "estimates", { number: "Q-1", orgId: "club", customerId: custId, createdAt: "t0", updatedAt: "t0" }) === "" &&
      d1.q("SELECT discountCodes FROM estimates WHERE number = 'Q-1'")[0].discountCodes === "[]");
    ok(`a quote's codes must be JSON: '["SAVE10"]' is taken, 'SAVE10' refused, ${built}`,
      fails(d1, `UPDATE estimates SET discountCodes = '["SAVE10"]' WHERE number = 'Q-1'`) === "" && CHECK.test(fails(d1, "UPDATE estimates SET discountCodes = 'SAVE10' WHERE number = 'Q-1'")));

    say(`Gift cards, ${built}`);
    const card = (extra) => insertRow(d1, "gift_cards", Object.assign({ code: "GC" + String(++codeN).padStart(14, "A"), last4: "AAAA", initialCents: 5000, balanceCents: 5000, createdAt: "t0" }, extra));
    ok(`a $50 card with only what it needs is taken, ${built}`, card({ code: "ABCDEFGHJKLMNPQR" }) === "");
    const gc = d1.q("SELECT * FROM gift_cards WHERE code = 'ABCDEFGHJKLMNPQR'")[0];
    ok(`left out, a card is active, from staff (sourceOrderId ''), with no names, emails, message, note, creator or void date, ${built}`,
      gc.status === "active" && gc.sourceOrderId === "" && gc.recipientName === "" && gc.recipientEmail === "" && gc.buyerName === "" && gc.buyerEmail === "" &&
      gc.message === "" && gc.note === "" && gc.createdBy === "" && gc.voidedAt === null && Number.isInteger(gc.id));
    ok(`a card of $1.00 (100) and of $1,000,000 (100000000) are taken, ${built}`, card({ initialCents: 100 }) === "" && card({ initialCents: 100000000 }) === "");
    ok(`a card of 99 cents or over $1,000,000 is refused, ${built}`, CHECK.test(card({ initialCents: 99 })) && CHECK.test(card({ initialCents: 100000001 })));
    ok(`a balance of 0 is taken, a negative one refused, ${built}`, card({ balanceCents: 0 }) === "" && CHECK.test(card({ balanceCents: -1 })));
    ok(`status 'void' is taken, 'used' refused, ${built}`, card({ status: "void" }) === "" && CHECK.test(card({ status: "used" })));
    ok(`the same card number twice is refused (UNIQUE code), ${built}`, /UNIQUE constraint failed: gift_cards\.code/.test(card({ code: "ABCDEFGHJKLMNPQR" })));
    ok(`two staff cards (sourceOrderId '') are fine, but one order can't make two cards, ${built}`,
      card({}) === "" && card({ sourceOrderId: "CLUB-GC-1" }) === "" && /UNIQUE constraint failed: gift_cards\.sourceOrderId/.test(card({ sourceOrderId: "CLUB-GC-1" })));
    ok(`a card needs its code, last4, amounts and when it was made (NOT NULL), ${built}`,
      ["code", "last4", "initialCents", "balanceCents", "createdAt"].every(k => new RegExp("NOT NULL constraint failed: gift_cards\\." + k).test(card({ [k]: null }))));
    const led = (extra) => insertRow(d1, "gift_card_ledger", Object.assign({ cardId: gc.id, kind: "issue", deltaCents: 5000, at: "t0" }, extra));
    ok(`a ledger row of each kind (issue, redeem, refund, adjust, void) is taken, ${built}`, ["issue", "redeem", "refund", "adjust", "void"].every(k => led({ kind: k }) === ""));
    ok(`a ledger kind 'spend' is refused, ${built}`, CHECK.test(led({ kind: "spend" })));
    const l = d1.q("SELECT * FROM gift_card_ledger ORDER BY id LIMIT 1")[0];
    ok(`left out, a ledger row has no order (''), payment (NULL), note or person, ${built}`, l.orderId === "" && l.paymentId === null && l.note === "" && l.by === "");
    ok(`a ledger row for a card that isn't there is refused (foreign key), ${built}`, /FOREIGN KEY constraint failed/.test(led({ cardId: 999999 })));
    ok(`a ledger row needs its delta and when (NOT NULL), ${built}`, /NOT NULL constraint failed: gift_card_ledger\.deltaCents/.test(led({ deltaCents: null })) && /NOT NULL constraint failed: gift_card_ledger\.at/.test(led({ at: null })));
    ok(`a payment on an order has no gift card unless it is given one, ${built}`,
      insertRow(d1, "order_payments", { orderId: "O-1", amountCents: 1000, receivedAt: "t1" }) === "" &&
      insertRow(d1, "order_payments", { orderId: "O-1", amountCents: 500, receivedAt: "t1", giftCardId: gc.id }) === "" &&
      same(d1.q("SELECT giftCardId FROM order_payments WHERE orderId = 'O-1' ORDER BY id").map(r => r.giftCardId), [null, gc.id]));
  }

  // =====================================================================================================
  say("=== The migration on a database as it was just before it ===");
  const before = await makeDb(MIGRATION);
  ok("before it a code's uses were one per order (a unique index on orderId)", indexSql(before, "idx_discount_uses_order") === "CREATE UNIQUE INDEX idx_discount_uses_order ON discount_code_uses(orderId)");
  addCode(before, { code: "OLD10" });
  await placeOrder(before, "OLD-1");
  const oldCode = before.q("SELECT id FROM discount_codes WHERE code = 'OLD10'")[0].id;
  useCode(before, oldCode, "OLD-1");
  before.q("INSERT INTO customers (name, createdAt, updatedAt) VALUES ('Pat Example', 't0', 't0')");
  insertRow(before, "estimates", { number: "Q-OLD", orgId: "club", customerId: before.q("SELECT max(id) AS id FROM customers")[0].id, createdAt: "t0", updatedAt: "t0" });
  insertRow(before, "order_payments", { orderId: "OLD-1", amountCents: 1000, receivedAt: "t1" });
  const objectsBefore = objects(before);
  const ordersBefore = before.q("SELECT * FROM orders"), usesBefore = before.q("SELECT * FROM discount_code_uses");
  ok("0120 applies on top of every migration before it", (() => { try { before.execFile(read("migrations/" + MIGRATION)); return true; } catch (e) { return false; } })());
  const objectsAfter = objects(before);
  const added = objectsAfter.filter(o => !objectsBefore.some(b => b.name === o.name)).map(o => o.type + " " + o.name).sort();
  ok("it adds exactly the two gift card tables and five new indexes",
    same(added, ["index idx_discount_uses_order_code", "index idx_gift_card_ledger_card", "index idx_gift_cards_code", "index idx_gift_cards_source",
      "index idx_order_payments_giftcard", "table gift_card_ledger", "table gift_cards"]));
  ok("it keeps the name idx_discount_uses_order, now a plain (not unique) index on the order",
    indexSql(before, "idx_discount_uses_order") === "CREATE INDEX idx_discount_uses_order ON discount_code_uses(orderId)");
  const changed = objectsAfter.filter(o => objectsBefore.some(b => b.name === o.name && b.sql !== o.sql)).map(o => o.name).sort();
  ok("the only things it changes are the four tables it adds columns to and that one index",
    same(changed, ["discount_codes", "estimates", "idx_discount_uses_order", "order_payments", "orders"]));
  ok("nothing it had is gone", objectsBefore.every(b => objectsAfter.some(o => o.name === b.name)));
  for (const t of ["discount_codes", "orders", "estimates", "order_payments", "gift_cards", "gift_card_ledger"])
    ok(`after it, ${t} has schema.sql's columns`, colSet(before, t) === colSet(fresh, t));
  ok("an existing code gets no minimum, no free shipping and still takes its value off the goods",
    same(before.q("SELECT minOrderCents, freeShipping, goodsOff FROM discount_codes WHERE code = 'OLD10'")[0], { minOrderCents: null, freeShipping: 0, goodsOff: 1 }));
  ok("an existing order reorders nothing and has no shipping discount, and is otherwise as it was",
    same(before.q("SELECT * FROM orders").map(r => { const { reorderOf, shippingDiscountCents, ...rest } = r; return [reorderOf, shippingDiscountCents, rest]; }),
      ordersBefore.map(r => ["", 0, r])));
  ok("an existing use is kept as it was", same(before.q("SELECT * FROM discount_code_uses"), usesBefore));
  ok("an existing quote has no codes ('[]') and an existing payment no gift card",
    before.q("SELECT discountCodes FROM estimates")[0].discountCodes === "[]" && before.q("SELECT giftCardId FROM order_payments")[0].giftCardId === null);
  ok("the gift card tables start empty", before.q("SELECT count(*) AS n FROM gift_cards")[0].n === 0 && before.q("SELECT count(*) AS n FROM gift_card_ledger")[0].n === 0);
  ok("after it, the old order can take a second, different code", addCode(before, { code: "OLD5" }) === "" &&
    insertRow(before, "discount_code_uses", { codeId: before.q("SELECT id FROM discount_codes WHERE code = 'OLD5'")[0].id, orderId: "OLD-1", usedAt: "t" }) === "");
  ok("the Worker's migration list ships it, last", MIGRATIONS[MIGRATIONS.length - 1] === MIGRATION);
  ok("and the list matches the migrations folder", same(MIGRATIONS, fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()));

  // =====================================================================================================
  say("=== combineDiscounts_: what several codes take off together (cents) ===");
  const pct = (id, bps, extra) => Object.assign({ id, code: "P" + id, kind: "percent", percentBps: bps, amountCents: null, maxDiscountCents: null, goodsOff: 1, freeShipping: 0 }, extra);
  const amt = (id, cents, extra) => Object.assign({ id, code: "A" + id, kind: "amount", percentBps: null, amountCents: cents, maxDiscountCents: null, goodsOff: 1, freeShipping: 0 }, extra);
  const shipOnly = (id) => ({ id, code: "S" + id, kind: "percent", percentBps: 10000, amountCents: null, maxDiscountCents: null, goodsOff: 0, freeShipping: 1 });
  {
    const e = C({ codes: [], at: { goodsCents: 10000, shippingCents: 800 } });
    ok("no codes take nothing off: goods 0, shipping 0, no shares", e.goodsOffCents === 0 && e.shippingOffCents === 0 && same(e.perCode, []));
    ok("nothing passed at all is the same (codes not a list, no amounts)", same(lib.combineDiscounts_(), e) && same(lib.combineDiscounts_(null, {}), e) && same(lib.combineDiscounts_("SAVE10"), e));
    const r = C({ codes: [pct(1, 1000), pct(2, 1500)], at: { goodsCents: 10000, shippingCents: 800 } });
    ok("10% and 15% on $100.00 add up to 25%: $10.00 and $15.00, $25.00 in all", r.goodsOffCents === 2500 && same(shares(r), [[1000, 0], [1500, 0]]));
    ok("each share names its code and id, in the order given", same(r.perCode.map(p => [p.id, p.code]), [[1, "P1"], [2, "P2"]]));
    ok("no free-shipping code: nothing off shipping", r.shippingOffCents === 0);
    const cap = C({ codes: [pct(1, 6000), pct(2, 6000)], at: { goodsCents: 10000 } });
    ok("60% and 60% stop at 100% of the goods: $60.00 and then only the $40.00 left", cap.goodsOffCents === 10000 && same(shares(cap), [[6000, 0], [4000, 0]]));
    const three = C({ codes: [pct(1, 5000), pct(2, 5000), pct(3, 2500)], at: { goodsCents: 2000 } });
    ok("a third percent code once the goods are all taken off takes nothing", three.goodsOffCents === 2000 && same(shares(three), [[1000, 0], [1000, 0], [0, 0]]));
    const mx = C({ codes: [pct(1, 2000, { maxDiscountCents: 500 }), pct(2, 1000)], at: { goodsCents: 10000 } });
    ok("a 20% code with a $5.00 max takes $5.00 (its own share capped) and a 10% code still takes its $10.00", mx.goodsOffCents === 1500 && same(shares(mx), [[500, 0], [1000, 0]]));
    const mxBig = C({ codes: [pct(1, 2000, { maxDiscountCents: 5000 })], at: { goodsCents: 10000 } });
    ok("a max above the share changes nothing (20% of $100.00 = $20.00 under a $50.00 max)", mxBig.goodsOffCents === 2000);
    const pa = C({ codes: [pct(1, 1000), amt(2, 500)], at: { goodsCents: 4000 } });
    ok("10% then $5.00 off $40.00: $4.00 and $5.00", pa.goodsOffCents === 900 && same(shares(pa), [[400, 0], [500, 0]]));
    const ap = C({ codes: [amt(1, 500), pct(2, 1000)], at: { goodsCents: 4000 } });
    ok("an amount code listed first still comes off after the percent: 10% is of the full $40.00 ($4.00), not of $35.00", ap.goodsOffCents === 900 && same(shares(ap), [[500, 0], [400, 0]]));
    const aa = C({ codes: [amt(1, 800), amt(2, 500)], at: { goodsCents: 1000 } });
    ok("amount codes come off in the order given, each no more than what is left: $8.00 then $2.00 of $10.00", aa.goodsOffCents === 1000 && same(shares(aa), [[800, 0], [200, 0]]));
    const aa2 = C({ codes: [amt(1, 500), amt(2, 800)], at: { goodsCents: 1000 } });
    ok("…the other way round: $5.00 then $5.00", same(shares(aa2), [[500, 0], [500, 0]]));
    const past = C({ codes: [pct(1, 5000), amt(2, 1000), amt(3, 300)], at: { goodsCents: 1000 } });
    ok("never past the goods: 50% and $10.00 and $3.00 off $10.00 come to $10.00", past.goodsOffCents === 1000 && same(shares(past), [[500, 0], [500, 0], [0, 0]]));
    const fs1 = C({ codes: [pct(1, 1000), shipOnly(2), amt(3, 200, { freeShipping: 1 })], at: { goodsCents: 5000, shippingCents: 795 } });
    ok("a free-shipping-only code takes nothing off the goods but all the shipping", fs1.goodsOffCents === 700 && fs1.shippingOffCents === 795);
    ok("shipping comes off once though two codes make it free, credited to the first of them", same(shares(fs1), [[500, 0], [0, 795], [200, 0]]));
    const fs2 = C({ codes: [pct(1, 1000, { freeShipping: 1 }), shipOnly(2)], at: { goodsCents: 5000, shippingCents: 800 } });
    ok("a percent code that also makes shipping free does both: $5.00 off and $8.00 shipping", same(shares(fs2), [[500, 800], [0, 0]]) && fs2.shippingOffCents === 800);
    const goodsOff0 = C({ codes: [pct(1, 5000, { goodsOff: 0 })], at: { goodsCents: 5000, shippingCents: 800 } });
    ok("a code with goodsOff 0 and no free shipping takes nothing at all", goodsOff0.goodsOffCents === 0 && goodsOff0.shippingOffCents === 0);
    const r1 = C({ codes: [pct(1, 1500)], at: { goodsCents: 1003 } }), r2 = C({ codes: [pct(1, 1500)], at: { goodsCents: 1010 } });
    ok("rounding: 15% of $10.03 ($1.5045) is $1.50; 15% of $10.10 ($1.515) rounds half up to $1.52", r1.goodsOffCents === 150 && r2.goodsOffCents === 152);
    const r3 = C({ codes: [pct(1, 1250)], at: { goodsCents: 4 } }), r4 = C({ codes: [pct(1, 1250), pct(2, 1250)], at: { goodsCents: 4 } });
    ok("12.5% of 4 cents (half a cent) rounds up to 1 cent, and each share rounds on its own (two make 2 cents)", r3.goodsOffCents === 1 && r4.goodsOffCents === 2);
    const z = C({ codes: [pct(1, 1000), amt(2, 500), shipOnly(3)], at: { goodsCents: 0, shippingCents: 600 } });
    ok("no goods: nothing off the goods, but free shipping still takes the shipping", z.goodsOffCents === 0 && z.shippingOffCents === 600 && same(shares(z), [[0, 0], [0, 0], [0, 600]]));
    const zs = C({ codes: [shipOnly(1), pct(2, 1000)], at: { goodsCents: 1000, shippingCents: 0 } });
    ok("no shipping: a free-shipping code takes 0 off it", zs.shippingOffCents === 0 && same(shares(zs), [[0, 0], [100, 0]]));
    const odd = C({ codes: [null, pct(1, 1000), undefined], at: { goodsCents: "2000", shippingCents: -50 } });
    ok("empty entries are skipped, goods given as text are read, and negative shipping counts as none", odd.goodsOffCents === 200 && odd.shippingOffCents === 0 && odd.perCode.length === 1);
    const frac = C({ codes: [pct(1, 1000)], at: { goodsCents: 999.6 } });
    ok("goods with a fraction of a cent are rounded first ($9.996 → $10.00, 10% = $1.00)", frac.goodsOffCents === 100);
    const neg = C({ codes: [amt(1, 500)], at: { goodsCents: -1000 } });
    ok("negative goods count as none", neg.goodsOffCents === 0);
    const parsed = C({ codes: [{ id: "7", code: "HALF", kind: "percent", percent: 50, maxDiscount: 20 }, { code: "FIVE", kind: "amount", amount: 5 }, { kind: "shipping" }, { kind: "percent", percent: 10, freeShipping: true }],
      at: { goodsCents: 10000, shippingCents: 900 } });
    ok("parsed codes work the same: 50% up to $20.00, $5.00, free shipping and 10% with free shipping", same(shares(parsed), [[2000, 0], [500, 0], [0, 900], [1000, 0]]) &&
      parsed.goodsOffCents === 3500 && parsed.shippingOffCents === 900);
    ok("a parsed code's id is a number, and one with no id or code says null and ''", parsed.perCode[0].id === 7 && parsed.perCode[2].id === null && parsed.perCode[2].code === "");
  }

  say("=== discountForCode_: a code that takes nothing off the goods ===");
  ok("a free-shipping-only row (goodsOff 0) takes nothing off $50.00", lib.discountForCode_(shipOnly(1), 5000) === 0);
  ok("a parsed { kind: \"shipping\" } code takes nothing", lib.discountForCode_({ kind: "shipping", percent: 100 }, 5000) === 0);
  ok("a percent row with goodsOff 0 takes nothing", lib.discountForCode_(pct(1, 1000, { goodsOff: 0 }), 5000) === 0);
  ok("goodsOff 1, or a row from before 0120 with no goodsOff, takes its 10%", lib.discountForCode_(pct(1, 1000), 5000) === 500 && lib.discountForCode_({ kind: "percent", percentBps: 1000 }, 5000) === 500);
  ok("a code that makes shipping free as well still takes its goods discount", lib.discountForCode_(amt(1, 700, { freeShipping: 1 }), 5000) === 700);

  // =====================================================================================================
  say("=== normalizeDiscountCodeInput_: minimum order, free shipping and the free-shipping-only kind ===");
  const N = (p) => lib.normalizeDiscountCodeInput_(Object.assign({ kind: "percent", percent: 10, maxUses: 5 }, p));
  {
    const s = N({ kind: "shipping", percent: "not a number", maxDiscount: "x", amount: 5 });
    ok("kind \"shipping\" is stored as percent 10000 that takes nothing off the goods and makes shipping free; a percent, amount or max typed with it is ignored",
      !s.error && s.value.kind === "percent" && s.value.percentBps === 10000 && s.value.amountCents === null && s.value.maxDiscountCents === null && s.value.freeShipping === 1 && s.value.goodsOff === 0);
    ok("a percent or amount code takes its value off the goods (goodsOff 1) and doesn't make shipping free unless asked",
      N({}).value.goodsOff === 1 && N({}).value.freeShipping === 0 && N({ kind: "amount", amount: 5 }).value.goodsOff === 1);
    ok("no kind, or any other kind, is refused: \"Choose percent off or an amount off.\"",
      N({ kind: "" }).error === "Choose percent off or an amount off." && N({ kind: "free" }).error === "Choose percent off or an amount off.");
    ok("freeShipping true, 1, \"1\" or \"true\" makes shipping free", [true, 1, "1", "true"].every(v => N({ freeShipping: v }).value.freeShipping === 1));
    ok("freeShipping false, 0, \"yes\", or left out does not", [false, 0, "yes", undefined].every(v => N({ freeShipping: v }).value.freeShipping === 0));
    ok("an amount code can make shipping free too", N({ kind: "amount", amount: 5, freeShipping: true }).value.freeShipping === 1);
    ok("no minimum (blank, null, false or left out) stores NULL", ["", null, false, undefined].every(v => N({ minOrder: v }).value.minOrderCents === null));
    ok("a minimum of $25 is 2500 cents, \"25.50\" is 2550", N({ minOrder: 25 }).value.minOrderCents === 2500 && N({ minOrder: "25.50" }).value.minOrderCents === 2550);
    ok("the smallest and largest minimums, $0.01 and $100,000, are taken", N({ minOrder: 0.01 }).value.minOrderCents === 1 && N({ minOrder: 100000 }).value.minOrderCents === 10000000);
    const MSG_AMOUNT = "The minimum order must be an amount, or left blank for none.", MSG_RANGE = "The minimum order must be from $0.01 to $100,000.";
    ok(`a minimum that isn't a number is refused: "${MSG_AMOUNT}"`, N({ minOrder: "abc" }).error === MSG_AMOUNT && N({ minOrder: true }).error === MSG_AMOUNT && N({ minOrder: Infinity }).error === MSG_AMOUNT);
    ok("a minimum with a fraction of a cent is refused: \"The minimum order can't have fractions of a cent.\"", N({ minOrder: 25.555 }).error === "The minimum order can't have fractions of a cent.");
    ok(`a minimum of 0, a negative one, or over $100,000 is refused: "${MSG_RANGE}"`,
      N({ minOrder: 0 }).error === MSG_RANGE && N({ minOrder: -5 }).error === MSG_RANGE && N({ minOrder: 100000.01 }).error === MSG_RANGE);
    ok("a free-shipping-only code can have a minimum", N({ kind: "shipping", minOrder: 50 }).value.minOrderCents === 5000);
    ok("the minimum is checked after the value (a bad percent is still named first)", N({ percent: "", minOrder: "abc" }).error === "Enter the percent off.");
  }

  // =====================================================================================================
  say("=== Saving and reading codes: the free-shipping-only storage is hidden ===");
  const d = await makeDb();
  {
    const made = await save(d, { code: "SHIPFREE", kind: "shipping", maxUses: 10, minOrder: 50 });
    const c = made.code;
    ok("a free-shipping-only code is saved and reads back as kind \"shipping\", labelled \"Free shipping, on orders of $50.00 or more\"",
      !!c && c.kind === "shipping" && c.label === "Free shipping, on orders of $50.00 or more");
    ok("…with no percent, amount or max, free shipping on and a minimum of $50", c.percent === null && c.amount === null && c.maxDiscount === null && c.freeShipping === true && c.minOrder === 50);
    ok("…stored as percent 10000, goodsOff 0, freeShipping 1, minOrderCents 5000",
      same(d.q("SELECT kind, percentBps, amountCents, goodsOff, freeShipping, minOrderCents FROM discount_codes WHERE code = 'SHIPFREE'")[0],
        { kind: "percent", percentBps: 10000, amountCents: null, goodsOff: 0, freeShipping: 1, minOrderCents: 5000 }));
    const both = (await save(d, { code: "TENSHIP", kind: "percent", percent: 20, maxDiscount: 5, freeShipping: true, minOrder: 25, maxUses: 10 })).code;
    ok("a percent code with a max, free shipping and a minimum reads \"20% off, up to $5.00 and free shipping, on orders of $25.00 or more\"",
      both.label === "20% off, up to $5.00 and free shipping, on orders of $25.00 or more" && both.kind === "percent" && both.percent === 20 && both.freeShipping === true && both.minOrder === 25);
    const big = (await save(d, { code: "BIGFIVE", kind: "amount", amount: 5, minOrder: 1000, maxUses: 10 })).code;
    ok("an amount code with a $1,000 minimum reads \"$5.00 off, on orders of $1,000.00 or more\", free shipping off",
      big.label === "$5.00 off, on orders of $1,000.00 or more" && big.freeShipping === false && big.minOrder === 1000);
    const plain = (await save(d, { code: "PLAIN10", kind: "percent", percent: 10, maxUses: 10 })).code;
    ok("a code with neither reads just \"10% off\", minOrder null, freeShipping false", plain.label === "10% off" && plain.minOrder === null && plain.freeShipping === false);
    const list = await lib.listDiscountCodes(d, { q: "SHIPFREE", today: TODAY });
    ok("the list shows the free-shipping-only code as kind \"shipping\" with its minimum", list.total === 1 && list.codes[0].kind === "shipping" && list.codes[0].minOrder === 50);

    const changedKind = await save(d, { id: c.id, kind: "amount", amount: 5, maxUses: 10 });
    ok("an unused free-shipping-only code can become an amount code: it then takes its value off the goods again",
      !!changedKind.code && changedKind.code.kind === "amount" && changedKind.code.freeShipping === false && changedKind.code.minOrder === null &&
      same(d.q("SELECT goodsOff, freeShipping, percentBps FROM discount_codes WHERE id = ?", c.id)[0], { goodsOff: 1, freeShipping: 0, percentBps: null }));
    ok("and back again", (await save(d, { id: c.id, kind: "shipping", minOrder: 50, maxUses: 10 })).code.kind === "shipping");

    useCode(d, c.id, "U-1");
    useCode(d, both.id, "U-2");
    const LOCKED = "This code has been used — you can change its expiry, uses, note or switch it off.";
    const noteOnly = await save(d, { id: c.id, kind: "shipping", minOrder: 50, maxUses: 10, note: "Summer" });
    ok("a used free-shipping-only code can still have its note changed (its hidden storage counts as unchanged)",
      !!noteOnly.code && noteOnly.code.note === "Summer" && noteOnly.code.kind === "shipping" && d.q("SELECT goodsOff FROM discount_codes WHERE id = ?", c.id)[0].goodsOff === 0);
    ok("…but not its minimum", (await save(d, { id: c.id, kind: "shipping", minOrder: 60, maxUses: 10 })).error === LOCKED);
    ok("…nor dropping its minimum", (await save(d, { id: c.id, kind: "shipping", maxUses: 10 })).error === LOCKED);
    ok("…nor turning it into a 100% percent code with free shipping (the same stored percent and shipping, but now off the goods)",
      (await save(d, { id: c.id, kind: "percent", percent: 100, freeShipping: true, minOrder: 50, maxUses: 10 })).error === LOCKED &&
      d.q("SELECT goodsOff FROM discount_codes WHERE id = ?", c.id)[0].goodsOff === 0);
    const bothIn = { id: both.id, kind: "percent", percent: 20, maxDiscount: 5, freeShipping: true, minOrder: 25, maxUses: 10 };
    ok("a used code with free shipping can have its uses changed", !!(await save(d, Object.assign({}, bothIn, { maxUses: 20 }))).code);
    ok("…but not its free shipping switched off", (await save(d, Object.assign({}, bothIn, { freeShipping: false }))).error === LOCKED);
    ok("…nor made free-shipping-only", (await save(d, Object.assign({}, bothIn, { kind: "shipping" }))).error === LOCKED);
    ok("…nor given another minimum", (await save(d, Object.assign({}, bothIn, { minOrder: 30 }))).error === LOCKED);
    ok("after the refusals the code is as it was", same(d.q("SELECT percentBps, maxDiscountCents, freeShipping, goodsOff, minOrderCents, maxUses FROM discount_codes WHERE id = ?", both.id)[0],
      { percentBps: 2000, maxDiscountCents: 500, freeShipping: 1, goodsOff: 1, minOrderCents: 2500, maxUses: 20 }));
    ok("a bad minimum is refused on save with its message", (await save(d, { code: "BADMIN", kind: "percent", percent: 10, maxUses: 2, minOrder: 0 })).error === "The minimum order must be from $0.01 to $100,000.");

    const bulk = await lib.createDiscountCodesForEmails(d, { kind: "shipping", minOrder: 40, emails: "pat@example.com, sam@example.com", prefix: "SHIP" }, { actor: "pat@example.com", now: NOW });
    ok("codes for a list of emails can be free-shipping-only with a minimum: each stored that way",
      bulk.codes && bulk.codes.length === 2 && bulk.codes.every(x => same(d.q("SELECT percentBps, goodsOff, freeShipping, minOrderCents FROM discount_codes WHERE code = ?", x.code)[0],
        { percentBps: 10000, goodsOff: 0, freeShipping: 1, minOrderCents: 4000 })));
    const bulk2 = await lib.createDiscountCodesForEmails(d, { kind: "amount", amount: 3, freeShipping: "true", emails: ["lee@example.com"] }, { actor: "pat@example.com", now: NOW });
    ok("…or an amount code that also makes shipping free", bulk2.codes.length === 1 &&
      same(d.q("SELECT amountCents, goodsOff, freeShipping, minOrderCents FROM discount_codes WHERE code = ?", bulk2.codes[0].code)[0], { amountCents: 300, goodsOff: 1, freeShipping: 1, minOrderCents: null }));
    ok("…and a bad minimum there is refused too", (await lib.createDiscountCodesForEmails(d, { kind: "percent", percent: 5, minOrder: "x", emails: "pat@example.com" })).error === "The minimum order must be an amount, or left blank for none.");
  }

  say("A database from before 0120");
  {
    const old = await makeDb(MIGRATION);
    addCode(old, { code: "OLD20", percentBps: 2000 });
    const NOT_READY = "Discount codes need the latest database update. Apply the migrations, then try again.";
    const s = await save(old, { code: "NEWONE", kind: "percent", percent: 10, maxUses: 5 });
    ok("saving a new code says the database needs the update (no minimum / free-shipping columns yet)", s.error === NOT_READY && s.notReady === true);
    const oldId = old.q("SELECT id FROM discount_codes WHERE code = 'OLD20'")[0].id;
    ok("changing an old code says the same", (await save(old, { id: oldId, kind: "percent", percent: 20, maxUses: 5, note: "x" })).notReady === true);
    ok("codes for a list of emails say the same", (await lib.createDiscountCodesForEmails(old, { kind: "percent", percent: 5, emails: "pat@example.com" })).notReady === true);
    const l = await lib.listDiscountCodes(old, { today: TODAY });
    ok("the list still reads the old code: 20% off, no minimum, no free shipping", l.total === 1 && l.codes[0].kind === "percent" && l.codes[0].label === "20% off" &&
      l.codes[0].minOrder === null && l.codes[0].freeShipping === false);
    const chk = await lib.checkDiscountCode(old, { code: "old20", orgId: "club", subtotal: 50, today: TODAY });
    ok("and a checkout still takes it: 20% of $50.00 is $10.00", chk.ok === true && chk.discount === 10 && chk.combined.goodsOffCents === 1000);
  }

  // =====================================================================================================
  say("=== The rule: may an order carry more than one code? ===");
  {
    const r = await makeDb();
    ok("a new install allows one code per order (multiple false)", same(await lib.getDiscountRules(r), { multiple: false }));
    ok("no database at all reads the same", same(await lib.getDiscountRules(null), { multiple: false }));
    for (const [raw, what] of [['{"multiple":"yes"}', "\"yes\""], ['{"multiple":1}', "1"], ["[true]", "a list"], ["not json", "text that isn't JSON"], ["true", "a bare true"]]) {
      r.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('discountRules', ?)", raw);
      ok(`a saved value of ${what} reads as one code only`, (await lib.getDiscountRules(r)).multiple === false);
    }
    r.q("DELETE FROM global_settings WHERE key = 'discountRules'");
    const b = await lib.buildDiscountRules(r, { multiple: true });
    ok("building the rule answers the new value and one statement, and writes nothing yet",
      same(b.value, { multiple: true }) && b.stmts.length === 1 && r.q("SELECT count(*) AS n FROM global_settings WHERE key = 'discountRules'")[0].n === 0);
    await lib.writeSettingBuilds(r, [b], { batch: true });
    ok("written, it is stored as {\"multiple\":true} and reads back as allowed",
      r.q("SELECT value FROM global_settings WHERE key = 'discountRules'")[0].value === '{"multiple":true}' && (await lib.getDiscountRules(r)).multiple === true);
    ok("a save that leaves multiple out keeps it (an empty object, null, or not an object)",
      same(await lib.setDiscountRules(r, {}), { multiple: true }) && same(await lib.setDiscountRules(r, null), { multiple: true }) &&
      same(await lib.setDiscountRules(r, "off"), { multiple: true }) && (await lib.getDiscountRules(r)).multiple === true);
    ok("setDiscountRules switches it off and answers the new value", same(await lib.setDiscountRules(r, { multiple: false }), { multiple: false }) && (await lib.getDiscountRules(r)).multiple === false);
    for (const [bad, what] of [["true", "the text \"true\""], [1, "1"], [null, "null"]]) {
      let err = null;
      try { await lib.setDiscountRules(r, { multiple: bad }); } catch (e) { err = e; }
      ok(`${what} is refused: "Choose whether more than one discount code can be used on an order", a message for the person`,
        !!err && err.message === "Choose whether more than one discount code can be used on an order" && err.userFacing === true);
    }
    ok("and a refused value changes nothing", (await lib.getDiscountRules(r)).multiple === false);
  }

  // =====================================================================================================
  say("=== checkDiscountCode with codes already applied, and the minimum order ===");
  {
    const k = await makeDb();
    const mk = async (input) => (await save(k, Object.assign({ maxUses: 100 }, input))).code;
    await mk({ code: "SAVE10", kind: "percent", percent: 10 });
    await mk({ code: "TEAM15", kind: "percent", percent: 15 });
    await mk({ code: "FIVE", kind: "amount", amount: 5 });
    await mk({ code: "SHIPIT", kind: "shipping" });
    await mk({ code: "MIN50", kind: "amount", amount: 10, minOrder: 50 });
    await mk({ code: "MIN1K", kind: "percent", percent: 5, minOrder: 1000 });
    await mk({ code: "GONE", kind: "percent", percent: 50, expiresOn: "2027-01-01" });
    await mk({ code: "GONEMIN", kind: "percent", percent: 50, expiresOn: "2027-01-01", minOrder: 500 });
    await mk({ code: "WORKS", kind: "percent", percent: 30, orgId: "works" });
    const chk = (code, extra) => lib.checkDiscountCode(k, Object.assign({ code, orgId: "club", email: "pat@example.com", subtotal: 100, shipping: 8, today: TODAY }, extra));
    const ONE = "Only one discount code can be used on an order.", SAMEC = "That code is already applied.";

    say("One code per order (the default)");
    ok("a code alone is taken", (await chk("SAVE10")).ok === true);
    let r = await chk("SAVE10", { others: ["TEAM15"] });
    ok(`a second, different code is refused: "${ONE}"`, r.ok === false && r.reason === ONE);
    ok("…even one that doesn't exist (the rule is said first, nothing is looked up)", (await chk("NOSUCH", { others: ["TEAM15"] })).reason === ONE);
    r = await chk("SAVE10", { others: ["SAVE10"] });
    ok(`the same code again is refused: "${SAMEC}"`, r.ok === false && r.reason === SAMEC);
    ok("…whatever its case or spaces (\" save10 \")", (await chk("save10", { others: [" Save10 "] })).reason === SAMEC);
    ok("…and that is said before the one-code rule when the others include it", (await chk("SAVE10", { others: ["TEAM15", "SAVE10"] })).reason === SAMEC);
    ok("others that aren't codes at all (blank, symbols, null) don't count as a code applied", (await chk("SAVE10", { others: ["", "!!", null] })).ok === true);
    ok("others that isn't a list counts as none", (await chk("SAVE10", { others: "TEAM15" })).ok === true);
    ok("one other code given twice is still another code: refused", (await chk("SAVE10", { others: ["TEAM15", "team15"] })).reason === ONE);

    say("The answer for one code");
    r = await chk("SAVE10");
    ok("10% of $100.00: discount $10.00, combined $10.00 off the goods and nothing off shipping",
      r.discount === 10 && r.combined.goodsOffCents === 1000 && r.combined.shippingOffCents === 0 && same(r.combinedOff, { goods: 10, shipping: 0 }));
    ok("the code in the answer: id, code, label, kind, percent, amount, max, minimum and free shipping",
      same(Object.keys(r.code), ["id", "code", "label", "kind", "percent", "amount", "maxDiscount", "minOrder", "freeShipping"]) &&
      r.code.code === "SAVE10" && r.code.label === "10% off" && r.code.minOrder === null && r.code.freeShipping === false);
    r = await chk("SHIPIT");
    ok("a free-shipping-only code: kind \"shipping\", \"Free shipping\", $0 off the goods, the $8.00 shipping off",
      r.ok === true && r.code.kind === "shipping" && r.code.label === "Free shipping" && r.code.freeShipping === true && r.discount === 0 &&
      same(r.combinedOff, { goods: 0, shipping: 8 }) && r.combined.perCode[0].shippingOffCents === 800);
    ok("with no shipping given it takes 0 off shipping", (await chk("SHIPIT", { shipping: undefined })).combined.shippingOffCents === 0);
    ok("a negative shipping counts as none", (await chk("SHIPIT", { shipping: -5 })).combined.shippingOffCents === 0);

    say("The minimum order");
    r = await chk("MIN50", { subtotal: 49.99 });
    ok("$49.99 of goods for a $50.00-minimum code is refused: \"This code needs an order of at least $50.00.\"",
      r.ok === false && r.reason === "This code needs an order of at least $50.00.");
    r = await chk("MIN50", { subtotal: 50 });
    ok("exactly $50.00 is taken, $10.00 off, and the answer gives the minimum in dollars", r.ok === true && r.discount === 10 && r.code.minOrder === 50);
    ok("a $1,000 minimum is written with its comma: \"This code needs an order of at least $1,000.00.\"",
      (await chk("MIN1K", { subtotal: 999.99 })).reason === "This code needs an order of at least $1,000.00.");
    ok("no goods at all is under any minimum", (await chk("MIN50", { subtotal: 0 })).reason === "This code needs an order of at least $50.00.");
    ok("an expired code under its minimum is told it has expired (the minimum is checked last)", (await chk("GONEMIN", { subtotal: 10 })).reason === "This code has expired.");

    say("More than one code per order (the rule switched on)");
    await lib.setDiscountRules(k, { multiple: true });
    r = await chk("SAVE10", { others: ["TEAM15"] });
    ok("10% with 15% already applied is taken", r.ok === true);
    ok("…this code's own discount is $10.00, and together they take $25.00 (25%)", r.discount === 10 && r.combined.goodsOffCents === 2500 && same(r.combinedOff, { goods: 25, shipping: 0 }));
    ok("…the shares are listed with the codes already applied first, then this one", same(r.combined.perCode.map(p => [p.code, p.goodsOffCents]), [["TEAM15", 1500], ["SAVE10", 1000]]));
    ok(`the same code twice is still refused: "${SAMEC}"`, (await chk("SAVE10", { others: ["TEAM15", "save10"] })).reason === SAMEC);
    r = await chk("FIVE", { others: ["SAVE10", "SHIPIT"], subtotal: 40 });
    ok("$5.00 with 10% and free shipping on $40.00: $4.00 + $5.00 off the goods, the $8.00 shipping off",
      r.ok === true && r.discount === 5 && same(r.combinedOff, { goods: 9, shipping: 8 }) &&
      same(r.combined.perCode.map(p => [p.code, p.goodsOffCents, p.shippingOffCents]), [["SAVE10", 400, 0], ["SHIPIT", 0, 800], ["FIVE", 500, 0]]));
    r = await chk("SAVE10", { others: ["GONE", "NOSUCH", "WORKS", "MIN50"], subtotal: 40 });
    ok("codes already applied that no longer work here (expired, unknown, another shop's, under their minimum) are left out of the total",
      r.ok === true && same(r.combined.perCode.map(p => p.code), ["SAVE10"]) && r.combined.goodsOffCents === 400);
    r = await chk("MIN50", { others: ["SAVE10"], subtotal: 30 });
    ok("the code itself is still refused for its own reason (the minimum) with others applied", r.ok === false && r.reason === "This code needs an order of at least $50.00.");
    ok("an unknown code with others applied gets the unknown-code answer, not the one-code rule",
      (await chk("NOSUCH", { others: ["SAVE10"] })).reason === "This code isn't valid. If it was sent to you, check the email address is the one it was sent to.");
    await lib.setDiscountRules(k, { multiple: false });
    ok("switched back off, a second code is refused again", (await chk("SAVE10", { others: ["TEAM15"] })).reason === ONE);
  }
})().catch((e) => { console.log("the test file ran to the end without an error: false"); console.error(e); process.exitCode = 1; });
