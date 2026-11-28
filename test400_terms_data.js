process.env.TZ = "UTC";   // nothing here should read the machine's zone; pinned anyway
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

// Net 30 terms and customer-supplied garments, the data underneath (migrations/0121, functions/_lib/db.js), on real SQL
// (sql.js):
//   - migrations/0121 against schema.sql: every new column (type, NOT NULL, default), every CHECK, the two indexes,
//     garment_checkins, the invoicedAt backfill (only where an invoice was sent exactly once: order_invoices.sentAt is
//     the LAST send) and the shipped migration list
//   - the Customer-supplied garments switch, the one feature that starts OFF: normalizeFeatures, getFeatures,
//     buildFeatureSettings / setFeatures, featureOnSql_ (the SQL form agrees), and the slip's waiver line
//     (ownGarmentsWaiver: default, 1000 characters at most, saved, "" = none)
//   - Global settings → Net 30 terms: TERMS_STARTS, TERMS_DEFAULT, normalizeTerms, getTerms, buildTermsSettings, setTerms
//   - the payment rule: net30Rule / getNet30Rule (off unless ticked globally; a shop can only switch it off)
//   - customers: allowNet30 and termsDays read and saved (blank = the default days, 1–365), before 0121 too
//   - getNet30Customer: live customers only, email in any case, their days or the default
// Invented data only (Example Club, Example School District, pat@example.com).
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const NAMES = `{ FEATURES, normalizeFeatures, getFeatures, buildFeatureSettings, setFeatures, featureOnSql_, OWN_GARMENTS_WAIVER_DEFAULT,
  OWN_GARMENTS_WAIVER_MAX, TERMS_STARTS, TERMS_DEFAULT, normalizeTerms, getTerms, buildTermsSettings, setTerms, net30Rule, getNet30Rule,
  saveCustomer, getCustomer, mergeCustomers, setCustomerArchived, getNet30Customer }`;
const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn " + NAMES + ";")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

const migrationFiles = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function migratedDb(upTo = "9999") {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrationFiles) if (f < upTo) d1.execFile(read("migrations/" + f));
  d1._raw.exec("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t');");
  return d1;
}
async function schemaDb() {
  const d1 = await createD1();
  d1._raw.exec(read("schema.sql"));
  d1._raw.exec("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t');");
  return d1;
}
const rows = (d1, sql) => { const r = d1._raw.exec(sql)[0]; return r ? r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; };
const one = (d1, sql) => rows(d1, sql)[0];
const col = (d1, table, name) => rows(d1, `PRAGMA table_info(${table})`).find(c => c.name === name) || null;
const refused = (d1, sql) => { try { d1._raw.run(sql); return false; } catch (e) { return /CHECK constraint failed|NOT NULL constraint failed/i.test(e.message); } };
const allowed = (d1, sql) => { try { d1._raw.run(sql); return true; } catch (e) { return false; } };
// A database that fails the statements matching `re` with `message`, and answers the rest as usual.
function failing(db, re, message) {
  const boom = () => { const s = { bind: () => s, run: async () => { throw new Error(message); }, all: async () => { throw new Error(message); }, first: async () => { throw new Error(message); } }; return s; };
  return new Proxy(db, { get(t, k) { if (k === "prepare") return (sql) => (re.test(sql) ? boom() : t.prepare(sql)); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
}
const WAIVER = "Customer's garments are decorated at the customer's risk; we're not responsible for garments damaged in normal production.";
const DAYS_MSG = "Terms must be a whole number of days from 1 to 365 (or blank for the default).";

(async () => {
  console.log("=== migrations/0121: what an existing database gets ===");
  {
    const old = await migratedDb("0121");
    old._raw.exec(`
      INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('O-1','club','Pat','pat@example.com','2026-10-01T12:00:00Z');
      INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('O-2','club','Pat','pat@example.com','2026-10-02T12:00:00Z');
      INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('O-3','club','Pat','pat@example.com','2026-10-03T12:00:00Z');
      INSERT INTO order_invoices (token, orderId, orgId, sentAt, sendCount) VALUES ('t1','O-1','club','2026-10-05T15:00:00.000Z',1);
      INSERT INTO order_invoices (token, orderId, orgId, sentAt, sendCount) VALUES ('t2','O-2','club','2026-10-20T15:00:00.000Z',3);
      INSERT INTO customers (name, email, createdAt, updatedAt) VALUES ('Pat Example','pat@example.com','t','t');`);
    old.execFile(read("migrations/0121_terms_and_own_garments.sql"));
    const o = Object.fromEntries(rows(old, "SELECT orderId, invoicedAt FROM orders").map(r => [r.orderId, r.invoicedAt]));
    ok("an order invoiced exactly once gets invoicedAt from that one send", o["O-1"] === "2026-10-05T15:00:00.000Z");
    ok("an order whose invoice was resent keeps invoicedAt empty (sentAt is the last send, not the first)", o["O-2"] === null);
    ok("an order never invoiced keeps invoicedAt empty", o["O-3"] === null);
    const ord = one(old, "SELECT net30, poNumber, poAcceptedAt, poAcceptedBy, poTypedAt, termsDays FROM orders WHERE orderId = 'O-3'");
    ok("existing orders are not on Net 30, with no PO, nothing accepted or typed and the default days",
      same(ord, { net30: 0, poNumber: "", poAcceptedAt: null, poAcceptedBy: "", poTypedAt: null, termsDays: null }));
    ok("existing customers may not pick Net 30 and use the default days", same(one(old, "SELECT allowNet30, termsDays FROM customers"), { allowNet30: 0, termsDays: null }));
    ok("the migration only adds: it drops, renames and rebuilds nothing", !/\b(DROP|RENAME)\b/i.test(read("migrations/0121_terms_and_own_garments.sql")));
    ok("the migration list ships it, last", (() => { const m = read("functions/_lib/migrationList.js").match(/"\d{4}_[^"]+\.sql"/g); return m[m.length - 1] === '"0121_terms_and_own_garments.sql"'; })());
    ok("the file it names is in the migrations folder", migrationFiles.includes("0121_terms_and_own_garments.sql"));
  }

  console.log("\n=== migrations/0121 and schema.sql make the same tables ===");
  const COLS = {
    customers: { allowNet30: ["INTEGER", 1, "0"], termsDays: ["INTEGER", 0, null] },
    orders: { net30: ["INTEGER", 1, "0"], poNumber: ["TEXT", 1, "''"], poAcceptedAt: ["TEXT", 0, null], poAcceptedBy: ["TEXT", 1, "''"],
      poTypedAt: ["TEXT", 0, null], termsDays: ["INTEGER", 0, null], invoicedAt: ["TEXT", 0, null] },
    order_items: { customerOwned: ["INTEGER", 1, "0"], ownReceivedAt: ["TEXT", 0, null] },
    estimate_items: { customerOwned: ["INTEGER", 1, "0"] },
    garment_checkins: { id: ["INTEGER", 0, null], orderId: ["TEXT", 1, null], itemId: ["INTEGER", 1, null], size: ["TEXT", 1, "''"],
      expectedQty: ["INTEGER", 1, "0"], receivedQty: ["INTEGER", 1, "0"], condition: ["TEXT", 1, "'good'"], note: ["TEXT", 1, "''"],
      at: ["TEXT", 1, null], by: ["TEXT", 1, "''"], voidedAt: ["TEXT", 0, null] },
  };
  for (const [label, build] of [["migrations", () => migratedDb()], ["schema.sql", () => schemaDb()]]) {
    const d1 = await build();
    for (const [table, cols] of Object.entries(COLS)) {
      const okCols = Object.entries(cols).every(([name, [type, notnull, dflt]]) => { const c = col(d1, table, name); return c && c.type === type && c.notnull === notnull && c.dflt_value === dflt; });
      ok(`${label}: ${table} has ${Object.keys(cols).join(", ")} with their types, NOT NULLs and defaults`, okCols);
    }
    ok(`${label}: garment_checkins.id is the row id that counts up`, col(d1, "garment_checkins", "id").pk === 1 &&
      /id\s+INTEGER PRIMARY KEY AUTOINCREMENT/.test(one(d1, "SELECT sql FROM sqlite_master WHERE name = 'garment_checkins'").sql));
    const net30Idx = one(d1, "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_orders_net30'");
    ok(`${label}: idx_orders_net30 indexes only the Net 30 orders`, !!net30Idx && /ON orders\s*\(net30\)\s*WHERE net30 = 1/.test(net30Idx.sql));
    ok(`${label}: idx_garment_checkins_item indexes a line's check-ins by itemId`, same(rows(d1, "PRAGMA index_info(idx_garment_checkins_item)").map(r => r.name), ["itemId"]));
    d1._raw.exec(`INSERT INTO customers (name, email, createdAt, updatedAt) VALUES ('Pat Example','pat@example.com','t','t');
      INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('O-1','club','Pat','pat@example.com','2026-10-01T12:00:00Z');
      INSERT INTO order_items (orderId, orgId, productId, name, type, qty) VALUES ('O-1','club','cap','Club Cap','cap',1);`);
    ok(`${label}: a customer's allowNet30 is 0 or 1 only`, refused(d1, "UPDATE customers SET allowNet30 = 2") && allowed(d1, "UPDATE customers SET allowNet30 = 1"));
    ok(`${label}: a customer's days are 1 to 365, or NULL for the default`, refused(d1, "UPDATE customers SET termsDays = 0") && refused(d1, "UPDATE customers SET termsDays = 366") &&
      allowed(d1, "UPDATE customers SET termsDays = 1") && allowed(d1, "UPDATE customers SET termsDays = 365") && allowed(d1, "UPDATE customers SET termsDays = NULL"));
    ok(`${label}: an order's net30 is 0 or 1 only`, refused(d1, "UPDATE orders SET net30 = 2") && allowed(d1, "UPDATE orders SET net30 = 1"));
    ok(`${label}: an order's days are 1 to 365, or NULL for the default`, refused(d1, "UPDATE orders SET termsDays = 0") && refused(d1, "UPDATE orders SET termsDays = 366") &&
      allowed(d1, "UPDATE orders SET termsDays = 1") && allowed(d1, "UPDATE orders SET termsDays = 365") && allowed(d1, "UPDATE orders SET termsDays = NULL"));
    ok(`${label}: an order's PO number and who accepted it can't be NULL`, refused(d1, "UPDATE orders SET poNumber = NULL") && refused(d1, "UPDATE orders SET poAcceptedBy = NULL"));
    ok(`${label}: an order line's customerOwned is 0 or 1 only`, refused(d1, "UPDATE order_items SET customerOwned = 2") && allowed(d1, "UPDATE order_items SET customerOwned = 1"));
    ok(`${label}: a quote line's customerOwned is 0 or 1 only`, /customerOwned INTEGER NOT NULL DEFAULT 0 CHECK \(customerOwned IN \(0, 1\)\)/.test(one(d1, "SELECT sql FROM sqlite_master WHERE name = 'estimate_items'").sql));
    d1._raw.run("INSERT INTO garment_checkins (orderId, itemId, at) VALUES ('O-1', 1, '2026-10-02T12:00:00Z')");
    ok(`${label}: a check-in row starts with no size, 0 expected and received, good, no note, nobody, not voided`,
      same(one(d1, "SELECT size, expectedQty, receivedQty, condition, note, by, voidedAt FROM garment_checkins"),
        { size: "", expectedQty: 0, receivedQty: 0, condition: "good", note: "", by: "", voidedAt: null }));
    ok(`${label}: a check-in needs its time, order and line`, refused(d1, "INSERT INTO garment_checkins (orderId, itemId) VALUES ('O-1', 1)") &&
      refused(d1, "INSERT INTO garment_checkins (itemId, at) VALUES (1, 't')") && refused(d1, "INSERT INTO garment_checkins (orderId, at) VALUES ('O-1', 't')"));
    ok(`${label}: counts can't go below 0`, refused(d1, "UPDATE garment_checkins SET expectedQty = -1") && refused(d1, "UPDATE garment_checkins SET receivedQty = -1"));
    ok(`${label}: the condition is good, damaged or other`, refused(d1, "UPDATE garment_checkins SET condition = 'lost'") &&
      ["good", "damaged", "other"].every(c => allowed(d1, `UPDATE garment_checkins SET condition = '${c}'`)));
  }

  console.log("\n=== Customer-supplied garments: the one feature that starts off ===");
  {
    const f = lib.FEATURES.find(x => x.key === "ownGarments");
    ok("the Features list has it, labelled Customer-supplied garments", !!f && f.label === "Customer-supplied garments" && /Customer's own garment/.test(f.description));
    const others = lib.FEATURES.map(x => x.key).filter(k => k !== "ownGarments");
    const n = lib.normalizeFeatures(null);
    ok("nothing saved: it is off", n.ownGarments === false);
    ok("nothing saved: every other feature is on", others.length >= 9 && others.every(k => n[k] === true));
    const e = lib.normalizeFeatures({});
    ok("saved without it (an install from before): off, and every other feature still on", e.ownGarments === false && others.every(k => e[k] === true));
    ok("only a real true turns it on", lib.normalizeFeatures({ ownGarments: true }).ownGarments === true &&
      [1, "true", "yes", {}].every(v => lib.normalizeFeatures({ ownGarments: v }).ownGarments === false));
    ok("only a real false turns another feature off", lib.normalizeFeatures({ quotes: false }).quotes === false &&
      [0, "false", null].every(v => lib.normalizeFeatures({ quotes: v }).quotes === true));
    ok("turning another feature off leaves this one off and the rest on", (() => { const x = lib.normalizeFeatures({ storefront: false });
      return x.storefront === false && x.ownGarments === false && others.filter(k => k !== "storefront").every(k => x[k] === true); })());
    ok("turning it on leaves the rest on", (() => { const x = lib.normalizeFeatures({ ownGarments: true }); return others.every(k => x[k] === true); })());

    console.log("\n=== The check-in slip's waiver line (features.ownGarmentsWaiver) ===");
    ok("the default is the sentence the owner chose", lib.OWN_GARMENTS_WAIVER_DEFAULT === WAIVER && n.ownGarmentsWaiver === WAIVER);
    ok("at most 1000 characters", lib.OWN_GARMENTS_WAIVER_MAX === 1000 && lib.normalizeFeatures({ ownGarmentsWaiver: "x".repeat(1500) }).ownGarmentsWaiver.length === 1000);
    ok("a saved line is kept, trimmed", lib.normalizeFeatures({ ownGarmentsWaiver: "  Example Club is not responsible.  " }).ownGarmentsWaiver === "Example Club is not responsible.");
    ok("saved empty on purpose: no waiver line, not the default", lib.normalizeFeatures({ ownGarmentsWaiver: "" }).ownGarmentsWaiver === "" &&
      lib.normalizeFeatures({ ownGarmentsWaiver: "   " }).ownGarmentsWaiver === "");
    ok("anything but text: the default", [null, 5, true, ["a"]].every(v => lib.normalizeFeatures({ ownGarmentsWaiver: v }).ownGarmentsWaiver === WAIVER));
    ok("the waiver is not a switch: it isn't in the Features list", !lib.FEATURES.some(x => x.key === "ownGarmentsWaiver"));

    console.log("\n=== getFeatures, setFeatures and the SQL form ===");
    ok("no database: off, the rest on, the default waiver", same(await lib.getFeatures(null), n));
    const empty = await createD1();
    ok("a database with no settings table yet: the same", same(await lib.getFeatures(empty), n));
    const d1 = await migratedDb();
    ok("nothing saved yet: the same", same(await lib.getFeatures(d1), n));
    d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('features', 'not json')");
    ok("an unreadable saved value: the same", same(await lib.getFeatures(d1), n));
    d1._raw.run(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('features', '{"production":true,"quotes":false}')`);
    const g = await lib.getFeatures(d1);
    ok("saved switches without ownGarments: it is off, the one saved off is off, the rest on", g.ownGarments === false && g.quotes === false && g.production === true && g.storefront === true);
    d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('dashboardCache', '{}')");
    const on = await lib.setFeatures(d1, { ownGarments: true });
    ok("setFeatures turns it on and keeps what was saved before", on.ownGarments === true && on.quotes === false && (await lib.getFeatures(d1)).ownGarments === true);
    ok("…and throws Home's kept figures away", !one(d1, "SELECT 1 AS x FROM global_settings WHERE key = 'dashboardCache'"));
    await lib.setFeatures(d1, { ownGarments: "false", quotes: 0 });
    ok("a switch that isn't true or false is ignored", (await lib.getFeatures(d1)).ownGarments === true && (await lib.getFeatures(d1)).quotes === false);
    await lib.setFeatures(d1, { ownGarmentsWaiver: "  Garments are decorated at your risk.  " });
    ok("the waiver is saved with the switches, trimmed", (await lib.getFeatures(d1)).ownGarmentsWaiver === "Garments are decorated at your risk." &&
      JSON.parse(one(d1, "SELECT value FROM global_settings WHERE key = 'features'").value).ownGarmentsWaiver === "Garments are decorated at your risk.");
    await lib.setFeatures(d1, { quotes: true });
    ok("saving other switches keeps the waiver", (await lib.getFeatures(d1)).ownGarmentsWaiver === "Garments are decorated at your risk.");
    await lib.setFeatures(d1, { ownGarmentsWaiver: "y".repeat(1200) });
    ok("a waiver over 1000 characters is cut to 1000", (await lib.getFeatures(d1)).ownGarmentsWaiver.length === 1000);
    await lib.setFeatures(d1, { ownGarmentsWaiver: "" });
    ok("saving it empty removes the line, and it stays removed", (await lib.getFeatures(d1)).ownGarmentsWaiver === "");
    await lib.setFeatures(d1, { ownGarmentsWaiver: 42 });
    ok("a waiver that isn't text leaves the saved one alone", (await lib.getFeatures(d1)).ownGarmentsWaiver === "");
    const built = await lib.buildFeatureSettings(d1, { ownGarments: false });
    ok("the build step alone writes nothing", built.value.ownGarments === false && (await lib.getFeatures(d1)).ownGarments === true);

    const sqlOn = (key) => one(d1, `SELECT ${lib.featureOnSql_(key)} AS v`).v;
    const put = (v) => v == null ? d1._raw.run("DELETE FROM global_settings WHERE key = 'features'")
      : d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('features', ?)", [v]);
    put(null);
    ok("SQL, nothing saved: ownGarments off, production on", sqlOn("ownGarments") === 0 && sqlOn("production") === 1);
    put("{}");
    ok("SQL, saved without either: ownGarments off, production on", sqlOn("ownGarments") === 0 && sqlOn("production") === 1);
    put('{"ownGarments":true,"production":false}');
    ok("SQL, saved true and false: ownGarments on, production off", sqlOn("ownGarments") === 1 && sqlOn("production") === 0);
    put('{"ownGarments":false}');
    ok("SQL, ownGarments saved false: off", sqlOn("ownGarments") === 0);
    put("not json");
    ok("SQL, an unreadable value: ownGarments off, production on", sqlOn("ownGarments") === 0 && sqlOn("production") === 1);
    let agree = true;
    for (const v of [null, "{}", '{"ownGarments":true}', '{"ownGarments":false,"production":false}', "not json"]) {
      put(v); const js = await lib.getFeatures(d1);
      for (const k of ["ownGarments", "production", "designVerification"]) if ((sqlOn(k) === 1) !== js[k]) agree = false;
    }
    ok("the SQL form and getFeatures agree on every saved value tried", agree);
  }

  console.log("\n=== Global settings → Net 30 terms ===");
  {
    ok("the terms start when the invoice is sent, on the order date, or when the order is completed", same(lib.TERMS_STARTS, ["invoice", "order", "completed"]));
    ok("the default is 30 days from the invoice, and it can't be changed by accident", same(lib.TERMS_DEFAULT, { defaultDays: 30, startsAt: "invoice" }) && Object.isFrozen(lib.TERMS_DEFAULT));
    const N = lib.normalizeTerms;
    ok("nothing saved: 30 days from the invoice", same(N(null), { defaultDays: 30, startsAt: "invoice" }) && same(N(undefined), N(null)) && same(N("x"), N(null)));
    ok("a saved setting is read as saved", same(N({ defaultDays: 45, startsAt: "order" }), { defaultDays: 45, startsAt: "order" }) &&
      N({ startsAt: "completed" }).startsAt === "completed");
    ok("1 and 365 days are kept", N({ defaultDays: 1 }).defaultDays === 1 && N({ defaultDays: 365 }).defaultDays === 365);
    ok("days saved as text are read as a number", N({ defaultDays: "60" }).defaultDays === 60);
    ok("0, 366, part days, negative or no number: back to 30", [0, 366, 30.5, -5, "abc", null].every(v => N({ defaultDays: v }).defaultDays === 30));
    ok("an unknown start, or one in other letters: back to the invoice", ["shipped", "Invoice", "", null].every(v => N({ startsAt: v }).startsAt === "invoice"));

    const empty = await createD1();
    ok("getTerms on a database with no settings table: the default", same(await lib.getTerms(empty), lib.TERMS_DEFAULT));
    const d1 = await migratedDb();
    ok("getTerms with nothing saved: the default", same(await lib.getTerms(d1), { defaultDays: 30, startsAt: "invoice" }));
    d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('terms', 'not json')");
    ok("getTerms with an unreadable value: the default", same(await lib.getTerms(d1), { defaultDays: 30, startsAt: "invoice" }));
    d1._raw.run(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('terms', '{"defaultDays":500,"startsAt":"order"}')`);
    ok("getTerms with a saved value out of range: that part falls back, the rest is kept", same(await lib.getTerms(d1), { defaultDays: 30, startsAt: "order" }));
    d1._raw.run("DELETE FROM global_settings WHERE key = 'terms'");

    const DAYS = "The terms' days must be a whole number from 1 to 365.";
    const START = "Choose when the terms start: when the invoice is sent, the order date, or when the order is completed.";
    let allRefused = true;
    for (const v of [0, 366, -1, 1.5, "", null, "abc"]) {
      const e = await rejects(lib.setTerms(d1, { defaultDays: v }));
      if (!(e && e.userFacing === true && e.message === DAYS)) allRefused = false;
    }
    ok("days of 0, 366, -1, 1.5, blank, null or not a number are refused, in words a person can read", allRefused);
    const se = await rejects(lib.setTerms(d1, { startsAt: "shipped" }));
    ok("an unknown start is refused, in words", !!se && se.userFacing === true && se.message === START);
    ok("…and in other letters too", !!(await rejects(lib.setTerms(d1, { startsAt: "Order" }))));
    const mixed = await rejects(lib.setTerms(d1, { defaultDays: 45, startsAt: "nope" }));
    ok("a refusal saves nothing, not even the good half", !!mixed && !one(d1, "SELECT 1 AS x FROM global_settings WHERE key = 'terms'"));
    d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('dashboardCache', '{}')");
    const saved = await lib.setTerms(d1, { defaultDays: 45, startsAt: "completed" });
    ok("setTerms saves both and answers what was saved", same(saved, { defaultDays: 45, startsAt: "completed" }) && same(await lib.getTerms(d1), saved) &&
      same(JSON.parse(one(d1, "SELECT value FROM global_settings WHERE key = 'terms'").value), saved));
    ok("…and throws Home's kept figures away (the Unpaid POs block depends on when the days start)", !one(d1, "SELECT 1 AS x FROM global_settings WHERE key = 'dashboardCache'"));
    ok("only the days: the start is kept", same(await lib.setTerms(d1, { defaultDays: "60" }), { defaultDays: 60, startsAt: "completed" }));
    ok("only the start: the days are kept", same(await lib.setTerms(d1, { startsAt: "order" }), { defaultDays: 60, startsAt: "order" }));
    ok("1 and 365 days are accepted", (await lib.setTerms(d1, { defaultDays: 1 })).defaultDays === 1 && (await lib.setTerms(d1, { defaultDays: 365 })).defaultDays === 365);
    ok("nothing passed keeps what is saved", same(await lib.setTerms(d1, {}), { defaultDays: 365, startsAt: "order" }) && same(await lib.setTerms(d1), { defaultDays: 365, startsAt: "order" }));
    const b = await lib.buildTermsSettings(d1, { defaultDays: 10 });
    ok("the build step alone writes nothing", b.value.defaultDays === 10 && (await lib.getTerms(d1)).defaultDays === 365 && b.stmts.length === 1 && b.after.length === 1);
    ok("other settings are left alone", (await lib.getFeatures(d1)).ownGarments === false);
  }

  console.log("\n=== The Net 30 payment rule ===");
  {
    const R = lib.net30Rule;
    ok("off until it's ticked in Global settings", R(null, null).allowed === false && R({}, {}).allowed === false && R({ card: true, check: true }, {}).allowed === false);
    ok("ticked globally: a shop that hasn't switched it off may use it", R({ net30: true }, {}).allowed === true && R({ net30: true }, null).allowed === true &&
      R({ net30: true }, { net30: true }).allowed === true);
    ok("only a real true ticks it", R({ net30: "true" }, {}).allowed === false && R({ net30: 1 }, {}).allowed === false);
    ok("a shop can switch it off for itself", R({ net30: true }, { net30: false }).allowed === false);
    ok("a shop can't switch it on when it's off globally", R({ net30: false }, { net30: true }).allowed === false && R({}, { net30: true }).allowed === false);
    ok("a shop's odd value doesn't switch it off", R({ net30: true }, { net30: 0 }).allowed === true && R({ net30: true }, "x").allowed === true);
    ok("the answer is just whether it's allowed", same(Object.keys(R({ net30: true }, {})), ["allowed"]));

    const d1 = await migratedDb();
    d1._raw.exec("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('district','district','Example School District','t','t');");
    ok("a new install: off for a shop", (await lib.getNet30Rule(d1, "club")).allowed === false);
    d1._raw.run(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', '{"card":true,"net30":true}')`);
    ok("ticked globally: on for a shop with its usual payment methods", (await lib.getNet30Rule(d1, "club")).allowed === true);
    d1._raw.run(`UPDATE orgs SET enabledPayments = '{"card":true,"net30":false}' WHERE orgId = 'club'`);
    ok("a shop that switched it off: off for that shop only", (await lib.getNet30Rule(d1, "club")).allowed === false && (await lib.getNet30Rule(d1, "district")).allowed === true);
    ok("no shop or an unknown shop: the Global setting alone", (await lib.getNet30Rule(d1, "")).allowed === true && (await lib.getNet30Rule(d1, "nobody")).allowed === true);
    d1._raw.run(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', '{"card":true}')`);
    ok("unticked globally: off everywhere, whatever a shop saved", (await lib.getNet30Rule(d1, "district")).allowed === false &&
      (d1._raw.run(`UPDATE orgs SET enabledPayments = '{"net30":true}' WHERE orgId = 'district'`), (await lib.getNet30Rule(d1, "district")).allowed === false));
  }

  console.log("\n=== A customer allowed Net 30, and their days ===");
  {
    const d1 = await migratedDb();
    const a = await lib.saveCustomer(d1, { name: "Pat Example", company: "Example Club", email: "pat@example.com", allowNet30: true, termsDays: 45 });
    ok("a new customer can be allowed Net 30 with their own days", a.created && a.after.allowNet30 === true && a.after.termsDays === 45);
    ok("the customer's page reads them back", (await lib.getCustomer(d1, a.id)).customer.allowNet30 === true && (await lib.getCustomer(d1, a.id)).customer.termsDays === 45);
    const b = await lib.saveCustomer(d1, { name: "Sam Example", email: "sam@example.com" });
    ok("a customer saved without them: no Net 30, the default days", b.after.allowNet30 === false && b.after.termsDays === null);

    const before = one(d1, `SELECT allowNet30, termsDays, name FROM customers WHERE id = ${a.id}`);
    let bounded = true;
    for (const v of [0, 366, -5, 1.5, "abc", "30 days", true]) {
      const r = await lib.saveCustomer(d1, { id: a.id, name: "Changed", termsDays: v });
      if (r.error !== DAYS_MSG) bounded = false;
    }
    ok("days of 0, 366, below 0, part days or not a number are refused, saying blank means the default", bounded);
    ok("…and a refusal changes nothing, not even the name", same(one(d1, `SELECT allowNet30, termsDays, name FROM customers WHERE id = ${a.id}`), before));
    ok("1 and 365 days are kept", (await lib.saveCustomer(d1, { id: a.id, termsDays: 1 })).after.termsDays === 1 &&
      (await lib.saveCustomer(d1, { id: a.id, termsDays: 365 })).after.termsDays === 365);
    ok("days typed as text, with spaces, are read as a number", (await lib.saveCustomer(d1, { id: a.id, termsDays: " 60 " })).after.termsDays === 60);
    const keep = await lib.saveCustomer(d1, { id: a.id, phone: "555-0100" });
    ok("saving other fields keeps Net 30 and the days", keep.after.allowNet30 === true && keep.after.termsDays === 60 && keep.after.phone === "555-0100");
    ok("the audit's before shows them as they were", keep.before.allowNet30 === true && keep.before.termsDays === 60);
    const onlyDays = await lib.saveCustomer(d1, { id: a.id, termsDays: 90 });
    ok("changing only the days keeps Net 30 allowed", onlyDays.after.allowNet30 === true && onlyDays.after.termsDays === 90);
    const off = await lib.saveCustomer(d1, { id: a.id, allowNet30: false });
    ok("taking Net 30 away keeps their days for next time", off.after.allowNet30 === false && off.after.termsDays === 90);
    const onAgain = await lib.saveCustomer(d1, { id: b.id, allowNet30: true });
    ok("allowing Net 30 alone keeps the default days", onAgain.after.allowNet30 === true && onAgain.after.termsDays === null);
    ok("blank days: back to the default", (await lib.saveCustomer(d1, { id: a.id, termsDays: "" })).after.termsDays === null &&
      (await lib.saveCustomer(d1, { id: a.id, termsDays: 30 })).after.termsDays === 30 && (await lib.saveCustomer(d1, { id: a.id, termsDays: "  " })).after.termsDays === null &&
      (await lib.saveCustomer(d1, { id: a.id, termsDays: 30 })).after.termsDays === 30 && (await lib.saveCustomer(d1, { id: a.id, termsDays: null })).after.termsDays === null);
    ok("any truthy tick allows it, any falsy one doesn't", (await lib.saveCustomer(d1, { id: a.id, allowNet30: 1 })).after.allowNet30 === true &&
      (await lib.saveCustomer(d1, { id: a.id, allowNet30: 0 })).after.allowNet30 === false);
    ok("an unknown customer is refused before anything", (await lib.saveCustomer(d1, { id: 999, allowNet30: true })).error === "That customer wasn't found.");
    ok("Net 30 alone doesn't make a customer: a name or company is still needed", (await lib.saveCustomer(d1, { allowNet30: true, termsDays: 30 })).error === "Enter a name or a company." &&
      Number(one(d1, "SELECT count(*) AS n FROM customers").n) === 2);

    // Merging: a duplicate's Net 30 is not carried over (as built).
    const dup = await lib.saveCustomer(d1, { name: "Pat E.", email: "pat.e@example.com", allowNet30: true, termsDays: 15 });
    await lib.saveCustomer(d1, { id: a.id, allowNet30: false, termsDays: "" });
    await lib.mergeCustomers(d1, { fromId: dup.id, intoId: a.id });
    const kept = (await lib.getCustomer(d1, a.id)).customer;
    ok("merging a duplicate allowed Net 30 into one that isn't leaves the kept one as it was", kept.allowNet30 === false && kept.termsDays === null);

    console.log("\n=== Before migrations/0121 ===");
    const old = await migratedDb("0121");
    const o = await lib.saveCustomer(old, { name: "Pat Example", email: "pat@example.com", allowNet30: true, termsDays: 45 });
    ok("a customer is still saved, without Net 30 (there's nowhere to keep it yet)", !o.error && o.created && o.after.name === "Pat Example" && o.after.allowNet30 === false && o.after.termsDays === null);
    ok("the customer's page reads them as not allowed, default days", (await lib.getCustomer(old, o.id)).customer.allowNet30 === false && (await lib.getCustomer(old, o.id)).customer.termsDays === null);
    ok("their bounds are still checked first", (await lib.saveCustomer(old, { id: o.id, termsDays: 400 })).error === DAYS_MSG);
    const boom = failing(d1, /UPDATE customers SET allowNet30/, "disk I/O error");
    ok("any other failure saving them is not swallowed", !!(await rejects(lib.saveCustomer(boom, { id: b.id, allowNet30: false }))));
  }

  console.log("\n=== getNet30Customer: who may pick Net 30 at checkout ===");
  {
    const d1 = await migratedDb();
    const pat = await lib.saveCustomer(d1, { name: "Pat Example", email: "pat@example.com", allowNet30: true, termsDays: 45 });
    const sam = await lib.saveCustomer(d1, { name: "Sam Example", email: "sam@example.com", allowNet30: true });
    const lee = await lib.saveCustomer(d1, { name: "Lee Example", email: "lee@example.com" });
    const arc = await lib.saveCustomer(d1, { name: "Ari Example", email: "ari@example.com", allowNet30: true, termsDays: 20 });
    await lib.setCustomerArchived(d1, arc.id, true);
    const C = (e, db = d1) => lib.getNet30Customer(db, e);
    ok("a customer allowed it, with their own days: their id and days", same(await C("pat@example.com"), { customerId: pat.id, termsDays: 45 }));
    ok("allowed with no days of their own: the default days", same(await C("sam@example.com"), { customerId: sam.id, termsDays: 30 }));
    await lib.setTerms(d1, { defaultDays: 60 });
    ok("…which follow Global settings → Net 30 terms", (await C("sam@example.com")).termsDays === 60);
    ok("the email in any case and with spaces is the same customer", same(await C("  PAT@Example.COM "), { customerId: pat.id, termsDays: 45 }));
    ok("a customer not allowed Net 30: no", (await C("lee@example.com")) === null);
    ok("an email nobody has: no, the same answer", (await C("nobody@example.com")) === null);
    ok("an archived customer: no", (await C("ari@example.com")) === null);
    await lib.setCustomerArchived(d1, arc.id, false);
    ok("…until brought back", (await C("ari@example.com")).termsDays === 20);
    // A customer merged away (its email cleared by the merge or kept) is never the one asked about.
    d1._raw.run(`UPDATE customers SET mergedIntoId = ${lee.id} WHERE id = ${arc.id}`);
    ok("a customer merged into another: no", (await C("ari@example.com")) === null);
    const unasked = failing(d1, /.*/, "the database should not be asked");
    ok("not an email, blank or nothing: no, without asking the database", (await C("not-an-email", unasked)) === null && (await C("", unasked)) === null &&
      (await C(null, unasked)) === null && (await C(undefined, unasked)) === null && (await C("pat@", unasked)) === null);
    ok("a stored days value it can't use falls back to the default", await (async () => {
      d1._raw.run("PRAGMA ignore_check_constraints = 1");
      d1._raw.run(`UPDATE customers SET termsDays = 0 WHERE id = ${pat.id}`);
      d1._raw.run("PRAGMA ignore_check_constraints = 0");
      const r = await C("pat@example.com");
      d1._raw.run(`UPDATE customers SET termsDays = 45 WHERE id = ${pat.id}`);
      return !!r && r.termsDays === 60;
    })());
    const before0121 = await migratedDb("0121");
    before0121._raw.run("INSERT INTO customers (name, email, createdAt, updatedAt) VALUES ('Pat Example','pat@example.com','t','t')");
    ok("before migrations/0121: no, rather than an error", (await C("pat@example.com", before0121)) === null);
    const before0108 = await migratedDb("0108");
    ok("before there were customers at all: no, rather than an error", (await C("pat@example.com", before0108)) === null);
    ok("any other database failure is not swallowed", !!(await rejects(C("pat@example.com", failing(d1, /FROM customers/, "disk I/O error")))));
  }
})().catch((e) => { console.error(e); ok("the test ran to the end without an error", false); });
