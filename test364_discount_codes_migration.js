const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { shopOrigin } = require("./testlib/hosts.js");
const roles = require("./testlib/roles");

// Discount codes (migrations/0115, 2026-11), the database side and a database that hasn't had it yet:
//   migrations/0115 and schema.sql   the two tables, every CHECK (kind; percent 1–10000 / amount 1–1000000, one or the
//                                    other; maxUses ≥ 1), the defaults, the foreign keys, the unique code index, the
//                                    unique order index and the partial live-uses index; the migration on a database
//                                    just before it (additive only, nothing else changed, safe to run twice); the
//                                    shipped migration list
//   FEATURES / normalizeFeatures      the "discounts" switch: on by default, off only by an explicit false
//   a database without 0115          every db.js reader answers empty / null / "", every write { error, notReady },
//                                    insertOrder still takes an order (with or without a discount), the order readers
//                                    say discountCode "", voidOrder / deleteOrder still work, and the catalog's
//                                    discountCodes flag is false — with the same calls on a migrated database as the
//                                    control, so each check can fail.
// Real SQL (sql.js) and the real files. Invented shops, codes and addresses only; no date in here depends on today.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
global.fetch = async (url) => { throw new Error("unexpected fetch " + url); };

const lib = new Function(strip(read("functions/_lib/db.js")) +
  "\nreturn { FEATURES, normalizeFeatures, getFeatures, buildFeatureSettings, listDiscountCodes, getDiscountCode, saveDiscountCode," +
  " createDiscountCodesForEmails, setDiscountCodeActive, deleteDiscountCode, checkDiscountCode, claimDiscountCode, releaseDiscountCodeUse," +
  " insertOrder, getOrderById, getOrdersByOrg, getOrdersByIds, getOpenOrders, voidOrder, deleteOrder };")();
const { MIGRATIONS } = new Function(strip(read("functions/_lib/migrationList.js")) + "\nreturn { MIGRATIONS };")();
// The catalog's GET in its own scope, with the libraries it uses (as test327 loads it).
const C = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/boxSize.js")) + "\n" + strip(read("functions/_lib/catalogCache.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'pat@example.com';\n" + roles.adminAs() + "\n" +
  "const catalogApi = (function(){\n" + strip(read("functions/api/catalog.js")) + "\nreturn { onRequestGet }; })();\n" +
  "return { catalogGet: catalogApi.onRequestGet, createProduct, publishShop, _resetCatalogCacheState };")();

const MIGRATION = "0115_discount_codes.sql";
const migrationFiles = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
// A database with every migration (before: only those before that one), and two invented shops.
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
const tableSql = (d1, name) => { const r = d1.q("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", name)[0]; return r ? r.sql.replace(/\s+/g, " ").replace(/ IF NOT EXISTS/i, "").trim() : ""; };
const indexSql = (d1, name) => { const r = d1.q("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", name)[0]; return r ? r.sql.replace(/\s+/g, " ").replace(/ IF NOT EXISTS/i, "").trim() : ""; };
const shape = (d1, table) => JSON.stringify(d1.q(`PRAGMA table_info(${table})`).map(c => [c.cid, c.name, c.type, c.notnull, c.dflt_value, c.pk]));
const fks = (d1, table) => d1.q(`PRAGMA foreign_key_list(${table})`).map(k => [k.from, k.table, k.to]);
const objects = (d1) => d1.q("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
const CHECK = /CHECK constraint failed/;
const NOT_READY = "Discount codes need the latest database update. Apply the migrations, then try again.";
const INVALID_EMAIL = "This code isn't valid. If it was sent to you, check the email address is the one it was sent to.";
const CAP = [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 2, unitPrice: 20 }];
const placeOrder = (d1, orderId, extra = {}) => lib.insertOrder(d1, { orderId, orgId: "club", customerName: "Pat Example", contact: "pat@example.com",
  placedAt: "2026-06-15T12:00:00.000Z", ...extra }, CAP);

// A code row straight into the table: only the columns given, so the defaults show.
let codeN = 0;
const addCode = (d1, cols) => {
  const c = Object.assign({ code: "C" + String(++codeN).padStart(3, "0"), kind: "percent", percentBps: 1000, maxUses: 5, createdAt: "t0" }, cols);
  const keys = Object.keys(c);
  return fails(d1, `INSERT INTO discount_codes (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map(k => c[k]));
};

(async () => {
  // =====================================================================================================
  say("=== The database: migrations/0115 and schema.sql build the same two tables and three indexes ===");
  const migrated = await makeDb();
  const fresh = await createD1();
  fresh._raw.exec(read("schema.sql"));
  fresh._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t0','t0');`);
  for (const t of ["discount_codes", "discount_code_uses"]) {
    ok(`${t}: schema.sql's table is the migration's, column for column (names, types, NOT NULL, defaults, key)`,
      shape(fresh, t) === shape(migrated, t) && shape(migrated, t) !== "[]");
    ok(`${t}: and its CREATE statement (with every CHECK) is the same text`, !!tableSql(migrated, t) && tableSql(fresh, t) === tableSql(migrated, t));
    ok(`${t}: the same foreign keys`, same(fks(fresh, t), fks(migrated, t)));
  }
  for (const ix of ["idx_discount_codes_code", "idx_discount_uses_order", "idx_discount_uses_code"])
    ok(`the index ${ix} is the same in schema.sql and the migration`, !!indexSql(migrated, ix) && indexSql(fresh, ix) === indexSql(migrated, ix));
  ok("a code's text is unique (a unique index on discount_codes.code)",
    indexSql(migrated, "idx_discount_codes_code") === "CREATE UNIQUE INDEX idx_discount_codes_code ON discount_codes(code)");
  ok("an order has at most one use (a unique index on discount_code_uses.orderId)",
    indexSql(migrated, "idx_discount_uses_order") === "CREATE UNIQUE INDEX idx_discount_uses_order ON discount_code_uses(orderId)");
  ok("a code's live uses are counted through a partial index on the uses not given back",
    indexSql(migrated, "idx_discount_uses_code") === "CREATE INDEX idx_discount_uses_code ON discount_code_uses(codeId) WHERE releasedAt IS NULL");
  ok("a code's shop refers to the shop (orgs.orgId); its use refers to the code (discount_codes.id)",
    same(fks(migrated, "discount_codes"), [["orgId", "orgs", "orgId"]]) && same(fks(migrated, "discount_code_uses"), [["codeId", "discount_codes", "id"]]));
  ok("a use has no foreign key to its order (it is claimed just before the order is written)",
    !fks(migrated, "discount_code_uses").some(k => k[0] === "orderId"));

  for (const [d1, built] of [[migrated, "after the migrations"], [fresh, "in a new database from schema.sql"]]) {
    say(`The CHECKs and defaults, ${built}`);
    ok(`a percent code with 10% (1000 basis points) and no amount is taken, ${built}`, addCode(d1, { code: "SAVE10" }) === "");
    const row = d1.q("SELECT * FROM discount_codes WHERE code = 'SAVE10'")[0];
    ok(`left out, a code is for every shop (orgId NULL), anyone (email ''), not once per email, on, no note, nobody, never expires, ${built}`,
      row.orgId === null && row.email === "" && row.oncePerEmail === 0 && row.active === 1 && row.note === "" && row.createdBy === "" && row.expiresOn === null);
    ok(`a code's id counts up from 1, ${built}`, Number.isInteger(row.id) && row.id >= 1);
    ok(`kind must be 'percent' or 'amount': 'flat' is refused, ${built}`, CHECK.test(addCode(d1, { kind: "flat" })));
    ok(`…'Percent' (another case) is refused, ${built}`, CHECK.test(addCode(d1, { kind: "Percent" })));
    ok(`…and no kind is refused (NOT NULL), ${built}`, /NOT NULL constraint failed: discount_codes\.kind/.test(addCode(d1, { kind: null })));
    ok(`a percent of 0.01% (1) and of 100% (10000) are taken, ${built}`, addCode(d1, { percentBps: 1 }) === "" && addCode(d1, { percentBps: 10000 }) === "");
    ok(`a percent of 0 is refused, ${built}`, CHECK.test(addCode(d1, { percentBps: 0 })));
    ok(`a percent over 100% (10001) is refused, ${built}`, CHECK.test(addCode(d1, { percentBps: 10001 })));
    ok(`a negative percent is refused, ${built}`, CHECK.test(addCode(d1, { percentBps: -1000 })));
    ok(`a percent code with no percent is refused, ${built}`, CHECK.test(addCode(d1, { percentBps: null })));
    ok(`a percent code that also has an amount is refused, ${built}`, CHECK.test(addCode(d1, { amountCents: 500 })));
    ok(`an amount code of 1 cent and of $10,000 (1000000) are taken, ${built}`,
      addCode(d1, { kind: "amount", percentBps: null, amountCents: 1 }) === "" && addCode(d1, { kind: "amount", percentBps: null, amountCents: 1000000 }) === "");
    ok(`an amount of 0 is refused, ${built}`, CHECK.test(addCode(d1, { kind: "amount", percentBps: null, amountCents: 0 })));
    ok(`an amount over $10,000 (1000001) is refused, ${built}`, CHECK.test(addCode(d1, { kind: "amount", percentBps: null, amountCents: 1000001 })));
    ok(`a negative amount is refused, ${built}`, CHECK.test(addCode(d1, { kind: "amount", percentBps: null, amountCents: -500 })));
    ok(`an amount code with no amount is refused, ${built}`, CHECK.test(addCode(d1, { kind: "amount", percentBps: null })));
    ok(`an amount code that also has a percent is refused, ${built}`, CHECK.test(addCode(d1, { kind: "amount", percentBps: 1000, amountCents: 500 })));
    ok(`a code usable once (maxUses 1) is taken, ${built}`, addCode(d1, { maxUses: 1 }) === "");
    ok(`maxUses 0 is refused, ${built}`, CHECK.test(addCode(d1, { maxUses: 0 })));
    ok(`a negative maxUses is refused, ${built}`, CHECK.test(addCode(d1, { maxUses: -1 })));
    ok(`no maxUses is refused (NOT NULL), ${built}`, /NOT NULL constraint failed: discount_codes\.maxUses/.test(addCode(d1, { maxUses: null })));
    ok(`a code needs its text (NOT NULL), ${built}`, /NOT NULL constraint failed: discount_codes\.code/.test(addCode(d1, { code: null })));
    ok(`a code needs when it was made (NOT NULL), ${built}`, /NOT NULL constraint failed: discount_codes\.createdAt/.test(addCode(d1, { createdAt: null })));
    ok(`the same code twice is refused (UNIQUE), ${built}`, /UNIQUE constraint failed: discount_codes\.code/.test(addCode(d1, { code: "SAVE10", percentBps: 500 })));
    ok(`a code for one shop, one address, once per email, switched off, with a note and a last day is taken, ${built}`,
      addCode(d1, { code: "CLUB5", orgId: "club", email: "pat@example.com", maxUses: 1, oncePerEmail: 1, active: 0, note: "Spring", createdBy: "pat@example.com", expiresOn: "2026-12-31" }) === "");

    const codeId = row.id;
    const use = (orderId, extra = {}) => {
      const u = Object.assign({ codeId, orderId, usedAt: "t1" }, extra);
      const keys = Object.keys(u);
      return fails(d1, `INSERT INTO discount_code_uses (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map(k => u[k]));
    };
    ok(`a use of a code by an order is taken, ${built}`, use("D-1") === "");
    const u = d1.q("SELECT * FROM discount_code_uses WHERE orderId = 'D-1'")[0];
    ok(`left out, a use has no email (''), 0 cents and is not given back (releasedAt NULL), ${built}`, u.email === "" && u.amountCents === 0 && u.releasedAt === null);
    ok(`a use needs its code, its order and when (NOT NULL), ${built}`,
      /NOT NULL constraint failed: discount_code_uses\.codeId/.test(use("D-2", { codeId: null })) &&
      /NOT NULL constraint failed: discount_code_uses\.orderId/.test(use(null)) &&
      /NOT NULL constraint failed: discount_code_uses\.usedAt/.test(use("D-2", { usedAt: null })));
    ok(`the same order can't use a code twice (UNIQUE orderId), ${built}`, /UNIQUE constraint failed: discount_code_uses\.orderId/.test(use("D-1")));
    d1.q("UPDATE discount_code_uses SET releasedAt = 't2' WHERE orderId = 'D-1'");
    ok(`…not even once its first use was given back: the row is kept, one per order, ${built}`, /UNIQUE constraint failed: discount_code_uses\.orderId/.test(use("D-1")));
    ok(`another order can use the same code, ${built}`, use("D-2", { email: "sam@example.com", amountCents: 400 }) === "");
  }

  // =====================================================================================================
  say("=== The migration on a database as it was just before it ===");
  const before = await makeDb(MIGRATION);
  ok("before it there are no discount code tables", tableSql(before, "discount_codes") === "" && tableSql(before, "discount_code_uses") === "");
  await placeOrder(before, "OLD-1");
  const objectsBefore = objects(before);
  const ordersBefore = JSON.stringify(before.q("SELECT * FROM orders ORDER BY orderId")), linesBefore = JSON.stringify(before.q("SELECT * FROM order_items ORDER BY id"));
  ok("0115 applies on top of every migration before it", (() => { try { before.execFile(read("migrations/" + MIGRATION)); return true; } catch (e) { return false; } })());
  const objectsAfter = objects(before);
  const added = objectsAfter.filter(o => !objectsBefore.some(b => b.name === o.name)).map(o => o.type + " " + o.name).sort();
  ok("it adds exactly the two tables and their three indexes",
    same(added, ["index idx_discount_codes_code", "index idx_discount_uses_code", "index idx_discount_uses_order", "table discount_code_uses", "table discount_codes"]));
  ok("and changes nothing that was there (additive only: every other table, index and trigger as it was)",
    same(objectsBefore, objectsAfter.filter(o => objectsBefore.some(b => b.name === o.name))));
  ok("an order placed before it is left exactly as it was (its row and its lines)",
    JSON.stringify(before.q("SELECT * FROM orders ORDER BY orderId")) === ordersBefore && JSON.stringify(before.q("SELECT * FROM order_items ORDER BY id")) === linesBefore);
  ok("the new tables start empty", before.q("SELECT count(*) AS n FROM discount_codes")[0].n === 0 && before.q("SELECT count(*) AS n FROM discount_code_uses")[0].n === 0);
  ok("the tables it makes are the ones schema.sql makes",
    shape(before, "discount_codes") === shape(fresh, "discount_codes") && shape(before, "discount_code_uses") === shape(fresh, "discount_code_uses"));
  ok("and the order made before it reads with no discount code", (await lib.getOrderById(before, "OLD-1")).discountCode === "");
  ok("running it a second time is harmless (IF NOT EXISTS) and changes nothing",
    (() => { try { before.execFile(read("migrations/" + MIGRATION)); return true; } catch (e) { return false; } })() && same(objects(before), objectsAfter));
  ok("the Worker's migration list ships it", MIGRATIONS.includes(MIGRATION));
  ok("and the list matches the migrations folder", same(MIGRATIONS, fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()));

  // =====================================================================================================
  say("=== The feature switch: \"discounts\" in FEATURES and normalizeFeatures ===");
  const entry = lib.FEATURES.find(f => f.key === "discounts");
  ok("FEATURES has a \"discounts\" switch labelled \"Discount codes\"", !!entry && entry.label === "Discount codes");
  ok("…with a description that says what switching it off does", !!entry && /Off:/.test(entry.description) && /code box/.test(entry.description) && entry.description.length > 40);
  ok("…listed once, right after Quotes", lib.FEATURES.filter(f => f.key === "discounts").length === 1 &&
    lib.FEATURES[lib.FEATURES.findIndex(f => f.key === "discounts") - 1].key === "quotes");
  ok("on by default: nothing saved", lib.normalizeFeatures(null).discounts === true);
  ok("on when the saved switches predate it (no \"discounts\" key)", lib.normalizeFeatures({ quotes: false }).discounts === true);
  ok("off only for an explicit false", lib.normalizeFeatures({ discounts: false }).discounts === false);
  ok("anything else is on (0, \"false\", null)",
    lib.normalizeFeatures({ discounts: 0 }).discounts === true && lib.normalizeFeatures({ discounts: "false" }).discounts === true && lib.normalizeFeatures({ discounts: null }).discounts === true);
  ok("switching it off leaves the other features on", lib.normalizeFeatures({ discounts: false }).quotes === true && lib.normalizeFeatures({ discounts: false }).storefront === true);
  ok("a new install reads it on (getFeatures)", (await lib.getFeatures(migrated)).discounts === true);
  {
    const built = await lib.buildFeatureSettings(migrated, { discounts: false });
    for (const s of built.stmts) await s.run();
    ok("saved off, getFeatures reads it off — and the rest stay on", (await lib.getFeatures(migrated)).discounts === false && (await lib.getFeatures(migrated)).quotes === true);
    const again = await lib.buildFeatureSettings(migrated, { quotes: true });
    ok("a later save that leaves it out keeps it off", again.value.discounts === false);
    const on = await lib.buildFeatureSettings(migrated, { discounts: true });
    for (const s of on.stmts) await s.run();
    ok("and it can be switched back on", (await lib.getFeatures(migrated)).discounts === true);
  }

  // =====================================================================================================
  say("=== A database without 0115: db.js reads empty, refuses writes politely, and orders still work ===");
  const old = await makeDb(MIGRATION);
  const today = "2026-06-15";
  const empty = { codes: [], total: 0 };
  // The control: the same calls on a migrated database with one code and an order that used it, so each "empty" can fail.
  const ctl = await makeDb();
  const made = await lib.saveDiscountCode(ctl, { code: "SAVE10", kind: "percent", percent: 10, maxUses: 5 }, { actor: "pat@example.com", now: "2026-06-01T00:00:00.000Z", today });
  ok("(control) on a migrated database a code is saved", !!(made.code && made.code.code === "SAVE10"));
  const ctlId = made.code.id;
  ok("(control) and an order claims a use of it", (await lib.claimDiscountCode(ctl, { codeId: ctlId, orderId: "C-1", email: "pat@example.com", amountCents: 400, now: "2026-06-15T12:00:00.000Z" })).ok === true);
  await placeOrder(ctl, "C-1", { discount: { cents: 400, note: "Code SAVE10" } });

  for (const [status, q, orgId] of [["all", "", null], ["active", "", null], ["off", "", null], ["expired", "", null], ["usedUp", "", null], ["all", "save", null], ["all", "", "club"]]) {
    const args = { status, q, orgId, today };
    const what = `status ${status}${q ? `, search "${q}"` : ""}${orgId ? `, shop ${orgId}` : ""}`;
    if (status === "all" || status === "active") ok(`(control) listDiscountCodes (${what}) finds the code on a migrated database`, (await lib.listDiscountCodes(ctl, args)).total === 1);
    ok(`listDiscountCodes (${what}) without 0115 answers no codes, total 0`, same(await lib.listDiscountCodes(old, args), empty));
  }
  ok("listDiscountCodes with nothing passed without 0115 answers no codes", same(await lib.listDiscountCodes(old), empty));
  ok("(control) getDiscountCode finds the code", (await lib.getDiscountCode(ctl, ctlId, today)).code === "SAVE10");
  ok("getDiscountCode without 0115 answers null", (await lib.getDiscountCode(old, 1, today)) === null);
  const chkCtl = await lib.checkDiscountCode(ctl, { code: "save10", orgId: "club", email: "sam@example.com", subtotal: 40, today });
  ok("(control) checkDiscountCode takes the code: 10% of $40 is $4", chkCtl.ok === true && chkCtl.discount === 4);
  const chk = await lib.checkDiscountCode(old, { code: "save10", orgId: "club", email: "sam@example.com", subtotal: 40, today });
  ok("checkDiscountCode without 0115 refuses the code, as an unknown code is refused, and says the database isn't ready",
    chk.ok === false && chk.reason === INVALID_EMAIL && chk.notReady === true);
  ok("(control) a second order claims a use on a migrated database", (await lib.claimDiscountCode(ctl, { codeId: ctlId, orderId: "C-2", email: "sam@example.com", amountCents: 400 })).ok === true);
  const claim = await lib.claimDiscountCode(old, { codeId: 1, orderId: "O-1", email: "sam@example.com", amountCents: 400 });
  ok("claimDiscountCode without 0115 is refused (\"This code isn't valid.\") and says the database isn't ready",
    claim.ok === false && claim.reason === "This code isn't valid." && claim.notReady === true);
  ok("(control) releaseDiscountCodeUse gives back the second order's use and names its code",
    same(await lib.releaseDiscountCodeUse(ctl, "C-2", "2026-06-16T00:00:00.000Z"), { ok: true, code: "SAVE10" }));
  ok("releaseDiscountCodeUse without 0115 is a no-op: ok, no code", same(await lib.releaseDiscountCodeUse(old, "O-1"), { ok: true, code: "" }));

  const notReady = (r) => !!r && r.notReady === true && r.error === NOT_READY;
  ok("saveDiscountCode (a new code) without 0115: { error, notReady }",
    notReady(await lib.saveDiscountCode(old, { code: "SAVE10", kind: "percent", percent: 10, maxUses: 5 }, { today })));
  ok("…a new code made up for a blank one, too", notReady(await lib.saveDiscountCode(old, { kind: "amount", amount: 5, maxUses: 5 }, { today })));
  ok("…a new code for one shop, too", notReady(await lib.saveDiscountCode(old, { code: "CLUB5", kind: "amount", amount: 5, orgId: "club", maxUses: 5 }, { today })));
  ok("…and a change to a code (an id)", notReady(await lib.saveDiscountCode(old, { id: 1, code: "SAVE10", kind: "percent", percent: 10, maxUses: 5 }, { today })));
  ok("(control) a change to a code that isn't there, on a migrated database, is \"wasn't found\", not \"not ready\"",
    same(await lib.saveDiscountCode(ctl, { id: 999, code: "SAVE99", kind: "percent", percent: 10, maxUses: 5 }, { today }), { error: "That discount code wasn't found." }));
  const badInput = await lib.saveDiscountCode(old, { code: "SAVE10", kind: "percent", percent: 0, maxUses: 5 }, { today });
  ok("what the admin typed is still checked first: a 0% code is refused for that reason, not as \"not ready\"",
    badInput.error === "The percent off must be from 0.01 to 100." && !badInput.notReady);
  ok("createDiscountCodesForEmails without 0115: { error, notReady }",
    notReady(await lib.createDiscountCodesForEmails(old, { emails: ["pat@example.com", "sam@example.com"], kind: "percent", percent: 10 })));
  ok("(control) on a migrated database it makes the codes", (await lib.createDiscountCodesForEmails(ctl, { emails: ["pat@example.com"], kind: "percent", percent: 10 })).codes.length === 1);
  ok("setDiscountCodeActive without 0115: { error, notReady }", notReady(await lib.setDiscountCodeActive(old, 1, false)));
  ok("(control) setDiscountCodeActive switches the code off on a migrated database", (await lib.setDiscountCodeActive(ctl, ctlId, false)).ok === true);
  ok("deleteDiscountCode without 0115: { error, notReady }", notReady(await lib.deleteDiscountCode(old, 1)));
  ok("(control) deleteDiscountCode of a code that isn't there, on a migrated database, is \"wasn't found\"",
    same(await lib.deleteDiscountCode(ctl, 999), { error: "That discount code wasn't found." }));

  say("Orders on a database without 0115");
  const placed = await placeOrder(old, "O-1");
  ok("insertOrder takes an order with no discount: 2 caps at $20 come to $40, discount 0",
    !!placed && placed.subtotal === 40 && placed.discount === 0 && placed.total === 40);
  const placedD = await placeOrder(old, "O-2", { discount: { cents: 400, note: "Code SAVE10" } });
  ok("insertOrder takes an order with a discount too (orders.discountCents is older than 0115): $40 less $4 is $36",
    !!placedD && placedD.discount === 4 && placedD.total === 36 &&
    same(old.q("SELECT discountCents, discountNote FROM orders WHERE orderId = 'O-2'"), [{ discountCents: 400, discountNote: "Code SAVE10" }]));
  ok("(control) getOrderById names the code an order used on a migrated database", (await lib.getOrderById(ctl, "C-1")).discountCode === "SAVE10");
  const one = await lib.getOrderById(old, "O-2");
  ok("getOrderById reads the order without 0115, discountCode \"\" (its discount still there)",
    !!one && one.orderId === "O-2" && one.discountCode === "" && one.discountAmount === 4 && one.discountNote === "Code SAVE10");
  ok("(control) the Orders list (getOrdersByOrg) names the code on a migrated database",
    (await lib.getOrdersByOrg(ctl, "club")).find(o => o.orderId === "C-1").discountCode === "SAVE10");
  const byOrg = await lib.getOrdersByOrg(old, "club");
  ok("the Orders list (getOrdersByOrg) reads both orders without 0115, each with discountCode \"\"",
    byOrg.length === 2 && byOrg.every(o => o.discountCode === ""));
  const byIds = await lib.getOrdersByIds(old, ["O-1", "O-2"]);
  ok("getOrdersByIds reads them, discountCode \"\"", byIds.length === 2 && byIds.every(o => o.discountCode === ""));
  const open = await lib.getOpenOrders(old);
  ok("getOpenOrders reads them, discountCode \"\"", open.length === 2 && open.every(o => o.discountCode === ""));
  ok("(control) voidOrder on a migrated database gives the code back and names it", same(await lib.voidOrder(ctl, "C-1", "Customer cancelled"), { discountCode: "SAVE10" }));
  ok("voidOrder still voids an order without 0115, and names no code",
    same(await lib.voidOrder(old, "O-1", "Customer cancelled"), { discountCode: "" }) && !!old.q("SELECT voidedAt FROM orders WHERE orderId = 'O-1'")[0].voidedAt);
  ok("deleteOrder still deletes an order without 0115, and names no code",
    same(await lib.deleteOrder(old, "O-2"), { discountCode: "" }) && old.q("SELECT count(*) AS n FROM orders WHERE orderId = 'O-2'")[0].n === 0 &&
    old.q("SELECT count(*) AS n FROM order_items WHERE orderId = 'O-2'")[0].n === 0);
  ok("(control) deleteOrder on a migrated database names the code it gave back",
    await (async () => { await placeOrder(ctl, "C-3"); await lib.claimDiscountCode(ctl, { codeId: made.code.id + 1, orderId: "C-3", email: "pat@example.com", amountCents: 400 });
      return same(await lib.deleteOrder(ctl, "C-3"), { discountCode: ctl.q("SELECT code FROM discount_codes WHERE id = ?", made.code.id + 1)[0].code }); })());

  // =====================================================================================================
  say("=== The catalog's discountCodes flag ===");
  let cacheStore = new Map();
  const freshCache = () => {
    cacheStore = new Map();
    global.caches = { default: {
      async match(key) { const hit = cacheStore.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
      async put(key, response) { cacheStore.set(typeof key === "string" ? key : key.url, response); },
    } };
    C._resetCatalogCacheState();
  };
  const errors = [];
  const realError = console.error;
  const catalog = async (d1) => {
    freshCache();
    console.error = (...a) => errors.push(a.map(String).join(" "));
    try {
      const res = await C.catalogGet({ request: { url: shopOrigin("club") + "/api/catalog", headers: { get: () => null } }, env: { DB: d1 } });
      return JSON.parse(await res.text());
    } finally { console.error = realError; }
  };
  const shopDb = async (beforeMigration) => {
    const d1 = await makeDb(beforeMigration);
    d1.q("UPDATE orgs SET ready = 1 WHERE orgId = 'club'");
    await C.createProduct(d1, "club", { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, reorderQr: "none" });
    await C.publishShop(d1, "club");
    return d1;
  };
  const withCode = await shopDb();
  await lib.saveDiscountCode(withCode, { code: "SAVE10", kind: "percent", percent: 10, maxUses: 5 }, { today });
  const cOn = await catalog(withCode);
  ok("(control) with 0115 and a usable code the shop's catalog says discountCodes: true", cOn.status === "ok" && cOn.catalog.discountCodes === true);
  // No database binding at all: the shop can only come from a last-known-good cached copy (here the one just stored,
  // filed under the no-database namespace), and with nothing to read there is no code box.
  {
    for (const [k, v] of [...cacheStore]) {
      const m = /^(.*\/)[^/]+(\/last-known-good\/.*)$/.exec(k);
      if (m) cacheStore.set(m[1] + "no-db" + m[2], v);
    }
    const res = await C.catalogGet({ request: { url: shopOrigin("club") + "/api/catalog", headers: { get: () => null } }, env: {} });
    const cNoDb = JSON.parse(await res.text());
    ok("with no database at all the cached shop is answered and says discountCodes: false",
      res.status === 200 && cNoDb.status === "ok" && cNoDb.orgId === "club" && cNoDb.catalog.products.length === 1 && cNoDb.catalog.discountCodes === false);
  }
  withCode.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('features', ?)", JSON.stringify({ discounts: false }));
  ok("with the Discount codes feature off it says false", (await catalog(withCode)).catalog.discountCodes === false);
  const noTables = await shopDb(MIGRATION);
  errors.length = 0;
  const cOld = await catalog(noTables);
  ok("without 0115 the shop's catalog is still answered", cOld.status === "ok" && cOld.orgId === "club" && Array.isArray(cOld.catalog.products) && cOld.catalog.products.length === 1);
  ok("…and says discountCodes: false (no code box)", cOld.catalog.discountCodes === false);
  ok("…without logging the missing table as a failure", !errors.some(e => /discount code check failed/.test(e)));
})().catch((e) => { console.log("crashed — " + (e && e.stack || e)); process.exit(1); });
