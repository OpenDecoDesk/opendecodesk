const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

// Fundraising for group shops (migrations/0110, 2026-11), the setup side — the database and db.js called directly:
//   migrations/0110 and schema.sql      orgs.fundraiserJson, order_items.fundraiserCents (and its CHECK), expenses
//                                       .fundraiserOrgId and its index, the built-in "Fundraiser payouts" category
//                                       (systemKey, Schedule C 27a, deductible 100%) and its "(built in)" name when
//                                       the owner already has one; the shipped migration list
//   parseFundraiser_                    each mode, damaged or partial values → none
//   normalizeFundraiser_                every rule and message the admin can get
//   setOrgFundraiser                    what is stored, what it answers, updatedAt left alone, refusals
//   the shop readers                    getOrgById / getAllOrgs / getPublishedOrg carry `fundraiser`
//   live, never published               not an unpublished change, Discard leaves it, the storefront's shop uses it
//   fundraiserLineCents_                percent and per piece, tax included or added, personalization, rounding, caps
//   deleteExpenseCategory               the built-in category can't be deleted
//   a database without 0110             the readers still work; saving a fundraiser is refused politely
// Real SQL (sql.js) and the real files. Invented shops only; no date in here depends on today or the time zone.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) +
  "\nreturn { parseFundraiser_, normalizeFundraiser_, setOrgFundraiser, fundraiserLineCents_, splitTaxInclusive, getOrgById, getAllOrgs," +
  " getPublishedOrg, publishShop, getPublishState, planDiscardShopChanges, discardShopChanges, getPublicCatalogShop, getPublicCatalogData," +
  " getDraftCatalogShop, updateOrg, deleteExpenseCategory, listExpenseCategories };")();
const { MIGRATIONS } = new Function(strip(read("functions/_lib/migrationList.js")) + "\nreturn { MIGRATIONS };")();

const MIGRATION = "0110_fundraising.sql";
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
const col = (d1, table, name) => d1.q(`PRAGMA table_info(${table})`).find(c => c.name === name) || null;
const indexSql = (d1, name) => { const r = d1.q("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", name)[0]; return r ? r.sql.replace(/\s+/g, " ").replace(/ IF NOT EXISTS/i, "").trim() : ""; };
// The columns as a set (a migration appends a column where schema.sql may list it elsewhere).
const shape = (d1, table) => JSON.stringify(d1.q(`PRAGMA table_info(${table})`).map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk]).sort((a, b) => a[0] < b[0] ? -1 : 1));
const stored = (d1, orgId) => d1.q("SELECT fundraiserJson FROM orgs WHERE orgId = ?", orgId)[0].fundraiserJson;

const NOT_READY = "Fundraising needs the latest database update. Apply the migrations, then try again.";
const MSG = {
  unreadable: "That fundraiser setup can't be read.",
  mode: "Pick how the fundraiser is worked out: a percent of each item, or an amount per piece.",
  label: "Enter who the fundraiser supports (for example, the team or club's name).",
  labelLong: "Who the fundraiser supports can be at most 80 characters.",
  show: "\"Show on the shop\" must be on or off.",
  percent: "The fundraiser's percent must be from 0.01 to 50.",
  percentDecimals: "The fundraiser's percent can have at most two decimals.",
  amount: "The fundraiser's amount per piece must be from $0.01 to $1,000.",
  amountCents: "The fundraiser's amount per piece must be in whole cents.",
};
const PCT = (percent, extra = {}) => ({ mode: "percent", percent, label: "Example Boosters", ...extra });
const PER = (amount, extra = {}) => ({ mode: "perPiece", amount, label: "Example Boosters", ...extra });

(async () => {
  // =====================================================================================================
  say("=== The database: migrations/0110 and schema.sql make the same three columns, index and category ===");
  const migrated = await makeDb();
  const fresh = await createD1();
  fresh._raw.exec(read("schema.sql"));
  fresh._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t0','t0');`);
  for (const [d1, built] of [[migrated, "after the migrations"], [fresh, "in a new database from schema.sql"]]) {
    const fj = col(d1, "orgs", "fundraiserJson"), fc = col(d1, "order_items", "fundraiserCents"), fo = col(d1, "expenses", "fundraiserOrgId");
    ok(`a shop's fundraiser is text that can't be NULL and is '' (none) unless set, ${built}`, !!fj && fj.type === "TEXT" && fj.notnull === 1 && fj.dflt_value === "''");
    ok(`a new shop has no fundraiser, ${built}`, stored(d1, "club") === "");
    ok(`what an order line raises is a whole number of cents, never NULL, 0 unless set, ${built}`, !!fc && fc.type === "INTEGER" && fc.notnull === 1 && fc.dflt_value === "0");
    ok(`an expense can be tied to a shop's fundraiser (text, empty = NULL), ${built}`, !!fo && fo.type === "TEXT" && fo.notnull === 0 && fo.dflt_value === null);
    ok(`that tie refers to the shop (orgs.orgId), ${built}`,
      d1.q("PRAGMA foreign_key_list(expenses)").some(k => k.from === "fundraiserOrgId" && k.table === "orgs" && k.to === "orgId"));
    ok(`payouts are found by shop through a partial index on the tied expenses only, ${built}`,
      indexSql(d1, "idx_expenses_fundraiser") === "CREATE INDEX idx_expenses_fundraiser ON expenses(fundraiserOrgId) WHERE fundraiserOrgId IS NOT NULL");
    d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('F-1', 'club', 'Pat Example', 'pat@example.com', '2026-01-05T12:00:00.000Z');
      INSERT INTO order_items (orderId, orgId, productId, name, type) VALUES ('F-1', 'club', 'tee', 'Tee', 'shirt');`);
    const lineId = d1.q("SELECT id FROM order_items WHERE orderId = 'F-1'")[0].id;
    ok(`a line saved without it raises 0, ${built}`, d1.q("SELECT fundraiserCents FROM order_items WHERE id = ?", lineId)[0].fundraiserCents === 0);
    ok(`a line can raise a positive amount, ${built}`, fails(d1, "UPDATE order_items SET fundraiserCents = 546 WHERE id = ?", lineId) === "");
    ok(`a line can't raise a negative amount (CHECK), ${built}`, /CHECK constraint failed/.test(fails(d1, "UPDATE order_items SET fundraiserCents = -1 WHERE id = ?", lineId)));
    ok(`nor NULL, ${built}`, /NOT NULL constraint failed: order_items\.fundraiserCents/.test(fails(d1, "UPDATE order_items SET fundraiserCents = NULL WHERE id = ?", lineId)));
    const cats = d1.q("SELECT * FROM expense_categories WHERE systemKey = 'fundraiser_payout'");
    ok(`there is exactly one built-in fundraiser payouts category, ${built}`, cats.length === 1);
    ok(`it is named "Fundraiser payouts", ${built}`, cats[0].name === "Fundraiser payouts");
    ok(`it is deductible, 100%, on Schedule C line 27a (other expenses), ${built}`,
      cats[0].deductionType === "deductible" && cats[0].deductiblePct === 100 && cats[0].scheduleCLine === "27a");
    ok(`it is neither capital nor use-taxable, and has its dates, ${built}`, cats[0].capital === 0 && cats[0].useTaxable === 0 && !!cats[0].createdAt && !!cats[0].updatedAt);
  }
  for (const t of ["orgs", "order_items", "expenses", "expense_categories"])
    ok(`schema.sql's ${t} table has the same columns the migrations give it`, shape(fresh, t) === shape(migrated, t));
  ok("Schedule C line 27a is the one the code names \"Other expenses\"", /"27a": "Other expenses"/.test(read("functions/_lib/db.js")));

  say("The migration on a database as it was just before it");
  const before = await makeDb(MIGRATION);
  ok("before it, the shops have no fundraiser column", !col(before, "orgs", "fundraiserJson"));
  before.execFile(read("migrations/" + MIGRATION));
  ok("a shop that existed before is left with no fundraiser ('')", stored(before, "club") === "" && stored(before, "works") === "");
  ok("and nothing else about it changed (its updatedAt is still its own)", before.q("SELECT updatedAt FROM orgs WHERE orgId = 'club'")[0].updatedAt === "t0");
  const insertCat = read("migrations/" + MIGRATION).match(/INSERT INTO expense_categories[\s\S]*?;/)[0];
  before.execFile(insertCat);
  ok("adding the category again adds nothing: still one fundraiser payouts category",
    before.q("SELECT COUNT(*) AS n FROM expense_categories WHERE systemKey = 'fundraiser_payout'")[0].n === 1);
  for (const taken of ["Fundraiser payouts", "FUNDRAISER PAYOUTS"]) {
    const d1 = await makeDb(MIGRATION);
    d1.q("INSERT INTO expense_categories (name, deductionType, createdAt, updatedAt) VALUES (?, 'none', 't0', 't0')", taken);
    d1.execFile(read("migrations/" + MIGRATION));
    const built = d1.q("SELECT * FROM expense_categories WHERE systemKey = 'fundraiser_payout'");
    ok(`when the owner already has a category named "${taken}", the built-in one is named "Fundraiser payouts (built in)"`,
      built.length === 1 && built[0].name === "Fundraiser payouts (built in)" && built[0].scheduleCLine === "27a" && built[0].deductiblePct === 100);
    ok(`and the owner's own "${taken}" is left as it was (no key, its own deduction type)`,
      same(d1.q("SELECT name, deductionType, systemKey FROM expense_categories WHERE name = ? COLLATE BINARY", taken), [{ name: taken, deductionType: "none", systemKey: null }]));
  }
  ok("the Worker's migration list ships it, as its newest migration", MIGRATIONS.includes(MIGRATION) && MIGRATIONS[MIGRATIONS.length - 1] === MIGRATION);
  ok("and the list matches the migrations folder", same(MIGRATIONS, fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()));

  // =====================================================================================================
  say("=== parseFundraiser_: the stored value → the setup, or null ===");
  const P = lib.parseFundraiser_;
  ok("a percent: 1000 basis points is 10%, with its label and whether it shows on the shop",
    same(P('{"mode":"percent","percentBps":1000,"label":"Example Boosters","showOnShop":true}'), { mode: "percent", percent: 10, label: "Example Boosters", showOnShop: true }));
  ok("per piece: 200 cents is $2.00", same(P('{"mode":"perPiece","cents":200,"label":"Example Boosters","showOnShop":false}'), { mode: "perPiece", amount: 2, label: "Example Boosters", showOnShop: false }));
  ok("the smallest and largest percent are read (1 = 0.01%, 5000 = 50%)",
    P('{"mode":"percent","percentBps":1,"label":"X"}').percent === 0.01 && P('{"mode":"percent","percentBps":5000,"label":"X"}').percent === 50);
  ok("the smallest and largest amount are read (1 cent, $1,000)",
    P('{"mode":"perPiece","cents":1,"label":"X"}').amount === 0.01 && P('{"mode":"perPiece","cents":100000,"label":"X"}').amount === 1000);
  ok("the label is trimmed", P('{"mode":"perPiece","cents":200,"label":"  Example Boosters  "}').label === "Example Boosters");
  ok("show on the shop is on only when stored as true (missing, \"true\" or 1 are off)",
    P('{"mode":"perPiece","cents":200,"label":"X"}').showOnShop === false && P('{"mode":"perPiece","cents":200,"label":"X","showOnShop":"true"}').showOnShop === false &&
    P('{"mode":"perPiece","cents":200,"label":"X","showOnShop":1}').showOnShop === false);
  const nones = [
    ["'' (no fundraiser)", ""], ["null", null], ["undefined", undefined], ["damaged JSON", '{"mode":"percent",'], ["the JSON null", "null"],
    ["a JSON array", '[{"mode":"percent","percentBps":1000,"label":"X"}]'], ["a JSON number", "5"], ["a JSON string", '"percent"'],
    ["no label", '{"mode":"percent","percentBps":1000}'], ["a blank label", '{"mode":"percent","percentBps":1000,"label":"   "}'],
    ["a label that isn't text", '{"mode":"percent","percentBps":1000,"label":7}'],
    ["an unknown mode", '{"mode":"flat","cents":200,"label":"X"}'], ["no mode", '{"cents":200,"label":"X"}'],
    ["0 basis points", '{"mode":"percent","percentBps":0,"label":"X"}'], ["over 50%", '{"mode":"percent","percentBps":5001,"label":"X"}'],
    ["a fraction of a basis point", '{"mode":"percent","percentBps":12.5,"label":"X"}'], ["no basis points", '{"mode":"percent","label":"X"}'],
    ["a negative percent", '{"mode":"percent","percentBps":-100,"label":"X"}'],
    ["0 cents", '{"mode":"perPiece","cents":0,"label":"X"}'], ["over $1,000", '{"mode":"perPiece","cents":100001,"label":"X"}'],
    ["a fraction of a cent", '{"mode":"perPiece","cents":1.5,"label":"X"}'], ["no cents", '{"mode":"perPiece","label":"X"}'],
    ["a percent setup with only cents", '{"mode":"percent","cents":200,"label":"X"}'],
  ];
  for (const [what, v] of nones) ok(`${what} reads as no fundraiser (null), so it never raises money by mistake`, P(v) === null);

  // =====================================================================================================
  say("=== normalizeFundraiser_: what the admin sent → { fundraiser } or { error } ===");
  const N = lib.normalizeFundraiser_;
  for (const [what, v] of [["null", null], ["undefined", undefined], ["''", ""], ["mode none", { mode: "none", percent: 10, label: "X" }], ["mode ''", { mode: "" }]])
    ok(`${what} means no fundraiser`, same(N(v), { fundraiser: null }));
  for (const [what, v] of [["a number", 5], ["text", "10%"], ["true", true], ["a list", [PCT(10)]], ["an empty list", []]])
    ok(`${what} is refused: "${MSG.unreadable}"`, same(N(v), { error: MSG.unreadable }));
  for (const [what, v] of [["no mode", { percent: 10, label: "X" }], ["an unknown mode", { mode: "flat", amount: 2, label: "X" }], ["mode \"Percent\" (case matters)", { mode: "Percent", percent: 10, label: "X" }]])
    ok(`${what} is refused: pick how it's worked out`, same(N(v), { error: MSG.mode }));
  ok("the mode is checked before the label", N({ mode: "flat" }).error === MSG.mode);
  for (const [what, label] of [["no label", undefined], ["an empty label", ""], ["a label of spaces", "   "], ["a label that isn't text", 12]])
    ok(`${what} is refused: enter who it supports`, same(N({ mode: "percent", percent: 10, label }), { error: MSG.label }));
  ok("the label is trimmed", N(PCT(10, { label: "  Example Boosters  " })).fundraiser.label === "Example Boosters");
  ok("80 characters is the longest label", N(PCT(10, { label: "B".repeat(80) })).fundraiser.label === "B".repeat(80));
  ok("80 characters with spaces round it is still fine (counted after trimming)", N(PCT(10, { label: "  " + "B".repeat(80) + "  " })).fundraiser.label.length === 80);
  ok("81 characters is refused: at most 80", same(N(PCT(10, { label: "B".repeat(81) })), { error: MSG.labelLong }));
  ok("the label is checked before the percent", N({ mode: "percent", percent: 99 }).error === MSG.label);
  ok("show on the shop is off unless sent", N(PCT(10)).fundraiser.showOnShop === false);
  ok("true turns it on", N(PCT(10, { showOnShop: true })).fundraiser.showOnShop === true);
  ok("false leaves it off", N(PER(2, { showOnShop: false })).fundraiser.showOnShop === false);
  for (const [what, v] of [["\"yes\"", "yes"], ["1", 1], ["null", null], ["\"true\"", "true"]])
    ok(`show on the shop as ${what} is refused: on or off`, same(N(PCT(10, { showOnShop: v })), { error: MSG.show }));
  ok("show on the shop is checked before the percent", N(PCT(99, { showOnShop: "yes" })).error === MSG.show);

  say("A percent of each item");
  ok("10% is accepted as given, with its label", same(N(PCT(10, { showOnShop: true })), { fundraiser: { mode: "percent", percent: 10, label: "Example Boosters", showOnShop: true } }));
  ok("0.01% is the smallest", N(PCT(0.01)).fundraiser.percent === 0.01);
  ok("50% is the largest", N(PCT(50)).fundraiser.percent === 50);
  ok("12.5% and 12.25% are fine (two decimals)", N(PCT(12.5)).fundraiser.percent === 12.5 && N(PCT(12.25)).fundraiser.percent === 12.25);
  ok("a percent typed as text (\"7.5\") is read", N(PCT("7.5")).fundraiser.percent === 7.5);
  ok("0.07% comes back as exactly 0.07 (no floating-point tail)", N(PCT(0.07)).fundraiser.percent === 0.07);
  for (const [what, p] of [["0.009%", 0.009], ["0%", 0], ["a negative percent", -5], ["50.01%", 50.01], ["51%", 51], ["no percent", undefined], ["null", null], ["''", ""], ["text that isn't a number", "ten"], ["Infinity", Infinity], ["NaN", NaN]])
    ok(`${what} is refused: from 0.01 to 50`, same(N(PCT(p)), { error: MSG.percent }));
  for (const p of [12.345, 0.015, 49.999]) ok(`${p}% is refused: at most two decimals`, same(N(PCT(p)), { error: MSG.percentDecimals }));
  ok("an amount sent with a percent setup is ignored", !("amount" in N(PCT(10, { amount: 5 })).fundraiser));

  say("An amount per piece");
  ok("$2 a piece is accepted, with its label", same(N(PER(2)), { fundraiser: { mode: "perPiece", amount: 2, label: "Example Boosters", showOnShop: false } }));
  ok("$0.01 is the smallest", N(PER(0.01)).fundraiser.amount === 0.01);
  ok("$1,000 is the largest", N(PER(1000)).fundraiser.amount === 1000);
  ok("$1.29 keeps its cents exactly", N(PER(1.29)).fundraiser.amount === 1.29);
  ok("an amount typed as text (\"2.50\") is read", N(PER("2.50")).fundraiser.amount === 2.5);
  for (const [what, a] of [["$0.009", 0.009], ["$0", 0], ["a negative amount", -2], ["$1,000.01", 1000.01], ["no amount", undefined], ["null", null], ["''", ""], ["text that isn't a number", "two"], ["Infinity", Infinity]])
    ok(`${what} is refused: from $0.01 to $1,000`, same(N(PER(a)), { error: MSG.amount }));
  for (const a of [2.345, 0.015]) ok(`$${a} is refused: whole cents`, same(N(PER(a)), { error: MSG.amountCents }));
  ok("a percent sent with a per-piece setup is ignored", !("percent" in N(PER(2, { percent: 10 })).fundraiser));

  // =====================================================================================================
  say("=== setOrgFundraiser: saving a shop's fundraiser ===");
  const d1 = await makeDb();
  let r = await lib.setOrgFundraiser(d1, "club", PCT(12.5, { label: "  Example Boosters ", showOnShop: true }));
  ok("a percent is saved: it answers ok, with no fundraiser before and the new one parsed",
    same(r, { ok: true, before: null, fundraiser: { mode: "percent", percent: 12.5, label: "Example Boosters", showOnShop: true } }));
  ok("it is stored as basis points with its label and show-on-shop flag",
    stored(d1, "club") === '{"mode":"percent","percentBps":1250,"label":"Example Boosters","showOnShop":true}');
  ok("the shop's updatedAt is left alone (a live setting, never an unpublished change)", d1.q("SELECT updatedAt FROM orgs WHERE orgId = 'club'")[0].updatedAt === "t0");
  ok("the other shop is untouched", stored(d1, "works") === "");
  r = await lib.setOrgFundraiser(d1, "club", PER(2));
  ok("changing it to per piece answers with the percent it replaced",
    same(r.before, { mode: "percent", percent: 12.5, label: "Example Boosters", showOnShop: true }) && same(r.fundraiser, { mode: "perPiece", amount: 2, label: "Example Boosters", showOnShop: false }));
  ok("per piece is stored as cents", stored(d1, "club") === '{"mode":"perPiece","cents":200,"label":"Example Boosters","showOnShop":false}');
  await lib.setOrgFundraiser(d1, "club", PCT(0.07));
  ok("0.07% is stored as exactly 7 basis points", JSON.parse(stored(d1, "club")).percentBps === 7);
  await lib.setOrgFundraiser(d1, "club", PER(1.29));
  ok("$1.29 is stored as exactly 129 cents", JSON.parse(stored(d1, "club")).cents === 129);
  r = await lib.setOrgFundraiser(d1, "club", null);
  ok("null ends it: stored as '' and answered as none, with what it was before",
    stored(d1, "club") === "" && r.ok === true && r.fundraiser === null && same(r.before, { mode: "perPiece", amount: 1.29, label: "Example Boosters", showOnShop: false }));
  r = await lib.setOrgFundraiser(d1, "club", { mode: "none" });
  ok("mode none on a shop with none answers ok, before none", same(r, { ok: true, before: null, fundraiser: null }));
  await lib.setOrgFundraiser(d1, "club", PER(2));
  r = await lib.setOrgFundraiser(d1, "club", PER(0));
  ok("an invalid setup is refused with normalizeFundraiser_'s message", same(r, { error: MSG.amount }));
  ok("and the saved one is kept", JSON.parse(stored(d1, "club")).cents === 200);
  r = await lib.setOrgFundraiser(d1, "nowhere", PER(2));
  ok("an unknown shop is refused: \"That shop wasn't found.\"", same(r, { error: "That shop wasn't found." }));
  ok("as is no shop at all (null)", same(await lib.setOrgFundraiser(d1, null, PER(2)), { error: "That shop wasn't found." }));
  ok("an invalid setup for an unknown shop gets the setup's message first", same(await lib.setOrgFundraiser(d1, "nowhere", PER(0)), { error: MSG.amount }));
  ok("nothing was written for the unknown shop", d1.q("SELECT COUNT(*) AS n FROM orgs WHERE orgId = 'nowhere'")[0].n === 0);
  ok("the shop's updatedAt is still its own after all of that", d1.q("SELECT updatedAt FROM orgs WHERE orgId = 'club'")[0].updatedAt === "t0");

  say("The shop readers carry it");
  await lib.setOrgFundraiser(d1, "club", PCT(10, { showOnShop: true }));
  const want = { mode: "percent", percent: 10, label: "Example Boosters", showOnShop: true };
  ok("getOrgById gives the shop's fundraiser, parsed", same((await lib.getOrgById(d1, "club")).fundraiser, want));
  ok("getOrgById gives null for a shop with none", (await lib.getOrgById(d1, "works")).fundraiser === null);
  const all = await lib.getAllOrgs(d1);
  ok("getAllOrgs gives each shop's (and null for none)", same(all.find(o => o.orgId === "club").fundraiser, want) && all.find(o => o.orgId === "works").fundraiser === null);
  ok("getPublishedOrg for a shop never published gives its live fundraiser", same((await lib.getPublishedOrg(d1, "club")).fundraiser, want));
  d1.q("UPDATE orgs SET fundraiserJson = '{\"mode\":\"percent\",' WHERE orgId = 'works'");
  ok("a damaged stored value reads as no fundraiser", (await lib.getOrgById(d1, "works")).fundraiser === null);
  d1.q("UPDATE orgs SET fundraiserJson = '' WHERE orgId = 'works'");

  // =====================================================================================================
  say("=== Live, not published: Publish and Discard never touch it; the storefront's shop uses the current one ===");
  const pd = await makeDb();
  await lib.setOrgFundraiser(pd, "club", PCT(10, { showOnShop: true }));
  await lib.publishShop(pd, "club", "test");
  await lib.publishShop(pd, "works", "test");
  ok("just published: both shops are current", (await lib.getPublishState(pd)).club.state === "current" && (await lib.getPublishState(pd)).works.state === "current");
  await lib.setOrgFundraiser(pd, "club", PER(2, { label: "Example Club Fund", showOnShop: true }));
  await lib.setOrgFundraiser(pd, "works", PCT(5, { showOnShop: true }));
  let st = await lib.getPublishState(pd);
  ok("changing the fundraiser after publishing is not an unpublished change", st.club.state === "current" && st.club.shopChanged === false);
  ok("nor is setting one on a shop published without one", st.works.state === "current" && st.works.shopChanged === false);
  ok("getPublishState for one shop agrees", (await lib.getPublishState(pd, ["club"])).club.state === "current");
  let plan = await lib.planDiscardShopChanges(pd, "club");
  ok("Discard has nothing to put back for it", plan.anything === false && plan.shopChanged === false && !plan.shopFields.includes("fundraiserJson"));
  const shop = await lib.getPublicCatalogShop(pd, "club");
  ok("the storefront's shop (getPublicCatalogShop) has the fundraiser saved since publishing, not the published one",
    same(shop.fundraiser, { mode: "perPiece", amount: 2, label: "Example Club Fund", showOnShop: true }));
  ok("the published row is still what the rest of the shop is built from (its name)", shop.name === "Example Club");
  const whole = await lib.getPublicCatalogData(pd);
  ok("the whole-install catalog (getPublicCatalogData) gives each shop's current fundraiser too",
    same(whole.orgs.club.fundraiser, shop.fundraiser) && same(whole.orgs.works.fundraiser, { mode: "percent", percent: 5, label: "Example Boosters", showOnShop: true }));
  ok("the admin's draft preview (getDraftCatalogShop) has it", same((await lib.getDraftCatalogShop(pd, "club")).fundraiser, shop.fundraiser));
  await lib.setOrgFundraiser(pd, "club", null);
  ok("ending it shows at once on the storefront's shop, though the published copy had one",
    (await lib.getPublicCatalogShop(pd, "club")).fundraiser === null && (await lib.getPublicCatalogData(pd)).orgs.club.fundraiser === null);
  { const pub = await lib.getPublishedOrg(pd, "club");
    ok("getPublishedOrg for a published shop carries no fundraiser at all, so not the published copy's (since ended)",
      !!pub && pub.name === "Example Club" && !("fundraiser" in pub));
    const pubW = await lib.getPublishedOrg(pd, "works");
    ok("…nor for a shop published without one that has one now", !!pubW && !("fundraiser" in pubW)); }
  { const np = await makeDb();
    await lib.setOrgFundraiser(np, "club", PCT(10, { showOnShop: true }));
    ok("getPublishedOrg for a shop never published still carries the live fundraiser",
      same((await lib.getPublishedOrg(np, "club")).fundraiser, { mode: "percent", percent: 10, label: "Example Boosters", showOnShop: true })); }
  ok("an unknown shop is still no shop", (await lib.getPublicCatalogShop(pd, "nowhere")) === null && (await lib.getPublicCatalogShop(pd, "")) === null);

  say("Discard puts back the other settings and leaves the fundraiser");
  await lib.setOrgFundraiser(pd, "club", PER(3, { label: "Example Club Fund" }));
  const org = await lib.getOrgById(pd, "club");
  await lib.updateOrg(pd, "club", { ...org, name: "Example Club Renamed" });
  st = await lib.getPublishState(pd);
  ok("a renamed shop does show an unpublished change (the comparison still works)", st.club.state === "changed" && st.club.shopChanged === true);
  plan = await lib.planDiscardShopChanges(pd, "club");
  ok("the plan lists the name, not the fundraiser", plan.shopChanged && plan.shopFields.includes("name") && !plan.shopFields.includes("fundraiserJson"));
  await lib.discardShopChanges(pd, "club");
  ok("Discard put the name back", pd.q("SELECT name FROM orgs WHERE orgId = 'club'")[0].name === "Example Club");
  ok("and kept the fundraiser saved since publishing", stored(pd, "club") === '{"mode":"perPiece","cents":300,"label":"Example Club Fund","showOnShop":false}');
  ok("afterwards the shop is current", (await lib.getPublishState(pd)).club.state === "current");
  await lib.setOrgFundraiser(pd, "club", null);
  await lib.updateOrg(pd, "club", { ...org, name: "Example Club Again" });
  await lib.discardShopChanges(pd, "club");
  ok("a fundraiser ended since publishing stays ended after Discard, though the published copy had one",
    stored(pd, "club") === "" && JSON.parse(pd.q("SELECT json FROM catalog_snapshots WHERE orgId = 'club'")[0].json).org.fundraiserJson !== "");

  say("A shop published before migrations/0110");
  const old = await makeDb(MIGRATION);
  await lib.publishShop(old, "club", "test");
  old.execFile(read("migrations/" + MIGRATION));
  ok("after the migration it is still current (the new column isn't an unpublished change)", (await lib.getPublishState(old)).club.state === "current");
  await lib.setOrgFundraiser(old, "club", PER(2, { showOnShop: true }));
  ok("a fundraiser set afterwards isn't one either", (await lib.getPublishState(old)).club.state === "current" && (await lib.planDiscardShopChanges(old, "club")).anything === false);
  ok("and the storefront's shop shows it", (await lib.getPublicCatalogShop(old, "club")).fundraiser.amount === 2);
  await lib.discardShopChanges(old, "club");
  ok("Discard leaves it", JSON.parse(stored(old, "club")).cents === 200);

  // =====================================================================================================
  say("=== fundraiserLineCents_: what one order line raises, from the stored setup ===");
  const L = lib.fundraiserLineCents_;
  const pct = (bps) => ({ mode: "percent", percentBps: bps, label: "X" }), per = (cents) => ({ mode: "perPiece", cents, label: "X" });
  ok("no fundraiser (null) raises 0", L(null, { qty: 2, unitCents: 2000, taxRateBps: 0, taxMode: "exclusive" }) === 0);
  ok("nor does something that isn't a setup (text)", L("percent", { qty: 2, unitCents: 2000, taxMode: "exclusive" }) === 0);
  ok("nor an unknown mode", L({ mode: "flat", cents: 200 }, { qty: 2, unitCents: 2000, taxMode: "exclusive" }) === 0);
  ok("with no line details it raises 0", L(pct(1000)) === 0);
  ok("10% of a $20 line with tax added on top (exclusive) is $2.00", L(pct(1000), { qty: 1, unitCents: 2000, taxRateBps: 800, taxMode: "exclusive" }) === 200);
  ok("10% of 3 × $20 is $6.00", L(pct(1000), { qty: 3, unitCents: 2000, taxRateBps: 0, taxMode: "exclusive" }) === 600);
  ok("with prices including tax, the tax is backed out first: a $60 line at 10% tax and 10% raises 546 cents (5455 × 10%, half rounded up)",
    L(pct(1000), { qty: 1, unitCents: 6000, taxRateBps: 1000, taxMode: "inclusive" }) === 546);
  ok("that is the same split the line's tax uses (splitTaxInclusive)", lib.splitTaxInclusive(6000, 1000).netCents === 5455);
  ok("a tax mode not given counts as tax included", L(pct(1000), { qty: 1, unitCents: 6000, taxRateBps: 1000 }) === 546);
  ok("any tax mode other than \"exclusive\" counts as included", L(pct(1000), { qty: 1, unitCents: 6000, taxRateBps: 1000, taxMode: "other" }) === 546);
  ok("with tax included but a 0% rate nothing is backed out", L(pct(1000), { qty: 1, unitCents: 6000, taxRateBps: 0, taxMode: "inclusive" }) === 600);
  ok("the personalization fee counts as part of the price: 2 × ($20 + $5) at 10% is $5.00",
    L(pct(1000), { qty: 2, unitCents: 2000, personalizationFeeCents: 500, taxMode: "exclusive" }) === 500);
  ok("and it is backed out of tax with the rest: 1 × ($55 + $5) at 10% tax included raises 546",
    L(pct(1000), { qty: 1, unitCents: 5500, personalizationFeeCents: 500, taxRateBps: 1000, taxMode: "inclusive" }) === 546);
  ok("half a cent rounds up: 1% of $0.50 is 1 cent", L(pct(100), { qty: 1, unitCents: 50, taxMode: "exclusive" }) === 1);
  ok("under half a cent rounds down: 1% of $0.49 is 0", L(pct(100), { qty: 1, unitCents: 49, taxMode: "exclusive" }) === 0);
  ok("0.01% of $100 is 1 cent", L(pct(1), { qty: 1, unitCents: 10000, taxMode: "exclusive" }) === 1);
  ok("a percent never raises more than the line's pre-tax amount (a stored 200% raises the whole $10)", L(pct(20000), { qty: 1, unitCents: 1000, taxMode: "exclusive" }) === 1000);
  ok("a negative stored percent raises 0", L(pct(-1000), { qty: 1, unitCents: 1000, taxMode: "exclusive" }) === 0);
  ok("$2 a piece on 3 pieces is $6.00, whatever the price", L(per(200), { qty: 3, unitCents: 2000, taxRateBps: 800, taxMode: "exclusive" }) === 600);
  ok("per piece is the same with tax included (the amount isn't a share of the price)", L(per(200), { qty: 3, unitCents: 2000, taxRateBps: 1000, taxMode: "inclusive" }) === 600);
  ok("per piece never raises more than the line's pre-tax amount: $5 a piece on 2 × $3 raises $6", L(per(500), { qty: 2, unitCents: 300, taxMode: "exclusive" }) === 600);
  ok("that cap is the amount before tax: $5 a piece on 1 × $3.30 with 10% tax included raises $3.00", L(per(500), { qty: 1, unitCents: 330, taxRateBps: 1000, taxMode: "inclusive" }) === 300);
  ok("a free line raises nothing", L(per(200), { qty: 2, unitCents: 0, taxMode: "exclusive" }) === 0 && L(pct(1000), { qty: 2, unitCents: 0, taxMode: "exclusive" }) === 0);
  ok("a line of no pieces raises nothing", L(per(200), { qty: 0, unitCents: 2000, taxMode: "exclusive" }) === 0);
  ok("a part of a piece doesn't count (2.7 pieces are 2)", L(per(200), { qty: 2.7, unitCents: 2000, taxMode: "exclusive" }) === 400);
  ok("a negative price or fee counts as 0", L(pct(1000), { qty: 1, unitCents: -2000, personalizationFeeCents: 500, taxMode: "exclusive" }) === 50);
  ok("a negative stored amount raises 0", L(per(-200), { qty: 2, unitCents: 2000, taxMode: "exclusive" }) === 0);
  ok("numbers passed as text are read", L(per("200"), { qty: "3", unitCents: "2000", taxMode: "exclusive" }) === 600);

  // =====================================================================================================
  say("=== The built-in category can't be deleted ===");
  const cd = await makeDb();
  const builtIn = cd.q("SELECT id FROM expense_categories WHERE systemKey = 'fundraiser_payout'")[0].id;
  ok("deleting the Fundraiser payouts category is refused", (await lib.deleteExpenseCategory(cd, builtIn)) === false);
  ok("and it is still there", cd.q("SELECT COUNT(*) AS n FROM expense_categories WHERE id = ?", builtIn)[0].n === 1);
  cd.q("UPDATE expense_categories SET name = 'Paid to the boosters' WHERE id = ?", builtIn);
  ok("renamed, it still can't be deleted (found by its key, not its name)", (await lib.deleteExpenseCategory(cd, builtIn)) === false && cd.q("SELECT COUNT(*) AS n FROM expense_categories WHERE id = ?", builtIn)[0].n === 1);
  const taxPaid = cd.q("SELECT id FROM expense_categories WHERE systemKey = 'sales_tax_paid'")[0].id;
  ok("nor can any other built-in category (sales tax paid)", (await lib.deleteExpenseCategory(cd, taxPaid)) === false);
  cd.q("INSERT INTO expense_categories (name, deductionType, createdAt, updatedAt) VALUES ('Example Unused', 'deductible', 't0', 't0')");
  const plainCat = cd.q("SELECT id FROM expense_categories WHERE name = 'Example Unused'")[0].id;
  ok("while an owner's own unused category can be deleted", (await lib.deleteExpenseCategory(cd, plainCat)) === true && cd.q("SELECT COUNT(*) AS n FROM expense_categories WHERE id = ?", plainCat)[0].n === 0);
  ok("the expense categories list shows it as built in (its systemKey)",
    (await lib.listExpenseCategories(cd)).some(c => c.id === builtIn && c.systemKey === "fundraiser_payout"));

  // =====================================================================================================
  say("=== A database that hasn't had migrations/0110 yet ===");
  const pre = await makeDb(MIGRATION);
  ok("getOrgById still reads the shop, with no fundraiser", (await lib.getOrgById(pre, "club")).name === "Example Club" && (await lib.getOrgById(pre, "club")).fundraiser === null);
  ok("getAllOrgs still reads every shop, none with a fundraiser", (await lib.getAllOrgs(pre)).length === 2 && (await lib.getAllOrgs(pre)).every(o => o.fundraiser === null));
  ok("getPublishedOrg still reads it", (await lib.getPublishedOrg(pre, "club")).fundraiser === null);
  ok("the storefront's shop still builds, with no fundraiser", (await lib.getPublicCatalogShop(pre, "club")).fundraiser === null);
  ok("so does the whole-install catalog", (await lib.getPublicCatalogData(pre)).orgs.club.fundraiser === null);
  await lib.publishShop(pre, "club", "test");
  ok("publish state still works", (await lib.getPublishState(pre)).club.state === "current" && (await lib.planDiscardShopChanges(pre, "club")).anything === false);
  ok("saving a fundraiser is refused with a message saying to apply the migrations", same(await lib.setOrgFundraiser(pre, "club", PER(2)), { error: NOT_READY, notReady: true }));
  ok("so is ending one", same(await lib.setOrgFundraiser(pre, "club", null), { error: NOT_READY, notReady: true }));
  ok("an invalid setup still gets its own message first", same(await lib.setOrgFundraiser(pre, "club", PER(0)), { error: MSG.amount }));
  ok("the readers' pure helpers don't need the database", lib.parseFundraiser_("") === null && lib.fundraiserLineCents_(null, { qty: 1, unitCents: 100 }) === 0);
  ok("and the shop row is untouched", pre.q("SELECT updatedAt FROM orgs WHERE orgId = 'club'")[0].updatedAt === "t0");

  // =====================================================================================================
  say("=== Odd cases: a shop that isn't there, a stored setup missing its number, a database that is down ===");
  const od = await makeDb();
  ok("getPublishedOrg for a shop that doesn't exist (never published, no row) gives null", (await lib.getPublishedOrg(od, "nope")) === null);
  ok("a stored percent setup without its percentBps raises nothing (0, never NaN)",
    lib.fundraiserLineCents_({ mode: "percent" }, { qty: 2, unitCents: 1000, taxMode: "exclusive" }) === 0);
  ok("a stored per-piece setup without its cents raises nothing (0, never NaN)",
    lib.fundraiserLineCents_({ mode: "perPiece", cents: "x" }, { qty: 2, unitCents: 1000, taxMode: "exclusive" }) === 0);
  // Every query fails for a reason that has nothing to do with 0110 (the database out of reach).
  const DOWN = "D1_ERROR: Network connection lost.";
  const down = { ...od, prepare() { const fail = async () => { throw new Error(DOWN); }; const st = { first: fail, all: fail, run: fail }; return Object.assign({ bind: () => st }, st); } };
  const thrown = async (p) => { try { await p; return ""; } catch (e) { return String(e && e.message); } };
  ok("setOrgFundraiser on a database that is down passes the failure on, not “apply the migrations”",
    (await thrown(lib.setOrgFundraiser(down, "club", PCT(10)))) === DOWN);
  ok("…and nothing was saved", od.q("SELECT fundraiserJson FROM orgs WHERE orgId = 'club'")[0].fundraiserJson === "");
})().catch((e) => { console.log("the fundraiser setup checks ran to the end:", false); console.error(e); process.exitCode = 1; });
