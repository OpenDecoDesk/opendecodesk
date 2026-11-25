const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

// Customer records, the database side (migrations/0105_customers.sql and its mirror in schema.sql, 2026-11):
//   - the customers table, its defaults and what it refuses
//   - one live customer per email (a merged-away duplicate keeps its email; an archived customer is still live)
//   - orders.customerId and its index
//   - the backfill, run on a database as it was just before 0105 with orders already in it: one customer per
//     email that real orders were placed with, named after the newest order, a customer since the oldest;
//     every order with that email linked, test orders too; anything that isn't an email left alone
//   - an empty database, and a new one built from schema.sql, end up with the same shape
//   - functions/_lib/migrationList.js names the migration
// Real SQL (sql.js) and the real files. Invented shops and customers only. Every date is written out, so
// neither today's date nor this machine's time zone matters.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const MIGRATION = "0105_customers.sql";
const migrationFiles = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f)).sort();
const { normalizeCustomerEmail_ } = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { normalizeCustomerEmail_ };")();

// A database as it was just before migrations/0105: the frozen pre-0006 schema plus every migration up to 0104.
async function databaseBefore0105() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrationFiles.filter(f => f >= "0006" && f < "0105")) d1.execFile(read("migrations/" + f));
  return d1;
}
const refused = (d1, sql, ...params) => { try { d1.q(sql, ...params); return ""; } catch (e) { return String(e && e.message || e); } };
const columns = (d1, table) => d1.q(`PRAGMA table_info(${table})`);
const hasTable = (d1, name) => d1.q("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).length === 1;
const indexSql = (d1, name) => { const r = d1.q("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", name)[0]; return r ? r.sql.replace(/\s+/g, " ").replace(/ IF NOT EXISTS/i, "").trim() : ""; };
const plan = (d1, sql) => d1.q("EXPLAIN QUERY PLAN " + sql).map(r => r.detail).join(" | ");
const say = (line) => console.log("\n" + line);

const LONG_OK = "y".repeat(188) + "@example.com";        // 200 characters: the longest email a customer can have
const LONG_OVER = "x".repeat(189) + "@example.com";      // 201 characters
// orderId, shop, the name on the order, its contact, when it was placed, a test order?
const ORDERS = [
  // one person, typed five ways, in two shops
  ["A-1001", "acme", "Pat Middle",       "  Pat@Example.COM  ",   "2026-02-10T12:00:00.000Z", 0],
  ["A-1002", "acme", "  Pat Newest  ",   "pat@example.com",       "2026-03-05T09:30:00.000Z", 0],
  ["A-1003", "beta", "Pat Oldest",       "PAT@EXAMPLE.COM\t",     "2025-12-01T08:00:00.000Z", 0],
  ["A-1004", "acme", "Pat Newline",      "\r\npat@example.com\n", "2026-01-01T00:00:00.000Z", 0],
  ["T-1005", "acme", "Test Pat Later",   "pat@example.com",       "2026-06-01T00:00:00.000Z", 1],
  ["T-1006", "acme", "Test Pat Earlier", "Pat@example.com",       "2025-01-01T00:00:00.000Z", 1],
  // two orders placed at the same moment
  ["S-2001", "acme", "Sam First",        "sam@example.com",       "2026-04-04T10:00:00.000Z", 0],
  ["S-2002", "acme", "Sam Second",       "sam@example.com",       "2026-04-04T10:00:00.000Z", 0],
  // an email only a test order used
  ["T-3001", "acme", "Test Only",        "tester@example.com",    "2026-02-02T00:00:00.000Z", 1],
  // contacts that aren't an email
  ["U-4001", "acme", "Phone Person",     "555-0100",                    "2026-02-03T00:00:00.000Z", 0],
  ["U-4002", "acme", "No Contact",       "",                            "2026-02-03T00:00:00.000Z", 0],
  ["U-4003", "acme", "No Dot",           "a@b",                         "2026-02-03T00:00:00.000Z", 0],
  ["U-4004", "acme", "Double At",        "pat@@example.com",            "2026-02-03T00:00:00.000Z", 0],
  ["U-4005", "acme", "Two Ats",          "pat@example.com@example.org", "2026-02-03T00:00:00.000Z", 0],
  ["U-4006", "acme", "Space Inside",     "pat lee@example.com",         "2026-02-03T00:00:00.000Z", 0],
  ["U-4007", "acme", "Tab Inside",       "pat\tlee@example.com",        "2026-02-03T00:00:00.000Z", 0],
  ["U-4008", "acme", "Newline Inside",   "pat\nlee@example.com",        "2026-02-03T00:00:00.000Z", 0],
  ["U-4009", "acme", "Return Inside",    "pat\rlee@example.com",        "2026-02-03T00:00:00.000Z", 0],
  ["U-4010", "acme", "Too Long",         LONG_OVER,                     "2026-02-03T00:00:00.000Z", 0],
  ["U-4011", "acme", "Nothing Before",   "@example.com",                "2026-02-03T00:00:00.000Z", 0],
  ["U-4012", "acme", "Nothing Between",  "pat@.com",                    "2026-02-03T00:00:00.000Z", 0],
  ["U-4013", "acme", "Nothing After",    "pat@example.",                "2026-02-03T00:00:00.000Z", 0],
  ["U-4014", "acme", "Only Spaces",      "   ",                         "2026-02-03T00:00:00.000Z", 0],
  ["U-4015", "acme", "Two Emails",       "pat@example.com, sam@example.com", "2026-02-03T00:00:00.000Z", 0],
  // emails at the edges of what counts
  ["L-5001", "acme", "Long Email",       "  " + LONG_OK.toUpperCase() + " ", "2026-02-04T00:00:00.000Z", 0],
  ["N-6001", "acme", "N".repeat(250),    "long.name@example.com",       "2026-02-05T00:00:00.000Z", 0],
  ["N-6002", "acme", "   ",              "noname@example.com",          "2026-02-06T00:00:00.000Z", 0],
  ["D-7001", "beta", "Lee Sample",       "Lee.Sample+Club@mail.example.co", "2026-02-07T00:00:00.000Z", 0],
  // a real order that was voided afterwards (set just after the orders go in)
  ["V-8001", "acme", "Voided Person",    "voided@example.com",          "2026-02-08T00:00:00.000Z", 0],
];
const EXPECTED_EMAILS = ["voided@example.com", "lee.sample+club@mail.example.co", "long.name@example.com", "noname@example.com", "pat@example.com", "sam@example.com", LONG_OK].sort();

// What the table and its indexes hold to, whichever way the database was built.
function checkRules(d1, built) {
  const T = "2026-01-01T00:00:00.000Z";
  const add = (fields) => {
    const f = Object.assign({ createdAt: T, updatedAt: T }, fields), keys = Object.keys(f);
    d1.q(`INSERT INTO customers (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map(k => f[k]));
    return d1.q("SELECT last_insert_rowid() AS id")[0].id;
  };
  const tryAdd = (fields) => { try { add(fields); return ""; } catch (e) { return String(e && e.message || e); } };
  const count = (where, ...p) => d1.q("SELECT COUNT(*) AS n FROM customers WHERE " + where, ...p)[0].n;

  say(`The customers table, ${built}`);
  const plainId = add({});
  const plain = d1.q("SELECT * FROM customers WHERE id = ?", plainId)[0];
  ok("a customer saved with only its two dates gets a number of its own", Number.isInteger(plainId) && plainId > 0);
  ok("and has no name, company, email, phone, address or notes yet (empty text, never NULL)",
    ["name", "company", "email", "phone", "addressJson", "notes", "taxExemptCertificate"].every(k => plain[k] === ""));
  ok("and is not tax exempt, with no expiry date", plain.taxExempt === 0 && plain.taxExemptExpires === null);
  ok("and is neither archived nor merged into another", plain.archivedAt === null && plain.mergedIntoId === null);
  ok("a customer can't be saved without the date it was created", /NOT NULL constraint failed: customers\.createdAt/.test(refused(d1, "INSERT INTO customers (updatedAt) VALUES (?)", T)));
  ok("nor without the date it was last changed", /NOT NULL constraint failed: customers\.updatedAt/.test(refused(d1, "INSERT INTO customers (createdAt) VALUES (?)", T)));
  ok("a NULL name, company, email, phone, address, notes or certificate is refused",
    ["name", "company", "email", "phone", "addressJson", "notes", "taxExemptCertificate"].every(k => new RegExp("NOT NULL constraint failed: customers\\." + k).test(tryAdd({ [k]: null }))));
  ok("the tax exemption is on or off: 1 is saved", d1.q("SELECT taxExempt FROM customers WHERE id = ?", add({ name: "Example Club", taxExempt: 1, taxExemptCertificate: "EX-0001", taxExemptExpires: "2027-12-31" }))[0].taxExempt === 1);
  ok("any other number is refused", /CHECK constraint failed/.test(tryAdd({ taxExempt: 2 })) && /CHECK constraint failed/.test(tryAdd({ taxExempt: -1 })));
  ok("and so is no value at all", /NOT NULL constraint failed: customers\.taxExempt/.test(tryAdd({ taxExempt: null })));
  const lastId = add({ name: "Gone Tomorrow" });
  d1.q("DELETE FROM customers WHERE id = ?", lastId);
  ok("a customer's number is never handed out again, even after its row is gone", add({ name: "Next In Line" }) > lastId);

  say(`One live customer per email, ${built}`);
  const blair = add({ name: "Blair Sample", email: "blair@example.com" });
  ok("a second customer with the same email is refused", /UNIQUE constraint failed: customers\.email/.test(tryAdd({ name: "Blair Again", email: "blair@example.com" })));
  ok("the first one is still the only one", count("email = ?", "blair@example.com") === 1);
  const before = count("email = ''");
  add({ name: "No Email One" }); add({ name: "No Email Two" });
  ok("any number of customers can have no email", count("email = ''") === before + 2);
  d1.q("UPDATE customers SET archivedAt = ? WHERE id = ?", T, blair);
  ok("an archived customer still holds its email: another with it is refused", /UNIQUE constraint failed: customers\.email/.test(tryAdd({ name: "Blair Again", email: "blair@example.com" })));
  const keep = add({ name: "Casey Keep", email: "casey@example.com" });
  const dupe = add({ name: "Casey Duplicate" });
  ok("a duplicate can't take the email while it is still live", /UNIQUE constraint failed: customers\.email/.test(refused(d1, "UPDATE customers SET email = ? WHERE id = ?", "casey@example.com", dupe)));
  d1.q("UPDATE customers SET mergedIntoId = ?, archivedAt = ? WHERE id = ?", keep, T, dupe);
  d1.q("UPDATE customers SET email = ? WHERE id = ?", "casey@example.com", dupe);
  ok("a customer merged into another keeps the same email as the one it was merged into", count("email = ?", "casey@example.com") === 2);
  const dupe2 = add({ name: "Casey Third", email: "casey@example.com", mergedIntoId: keep, archivedAt: T });
  ok("and so can a second merged-away duplicate", count("email = ? AND mergedIntoId IS NOT NULL", "casey@example.com") === 2 && dupe2 > dupe);
  ok("a merged-away duplicate can't come back to life while the email is taken", /UNIQUE constraint failed: customers\.email/.test(refused(d1, "UPDATE customers SET mergedIntoId = NULL WHERE id = ?", dupe)));
  ok("a third live customer with that email is still refused", /UNIQUE constraint failed: customers\.email/.test(tryAdd({ name: "Casey Fourth", email: "casey@example.com" })));
  ok("a customer can only be merged into a customer that exists", /FOREIGN KEY constraint failed/.test(refused(d1, "UPDATE customers SET mergedIntoId = 999999 WHERE id = ?", plainId)));
  ok("and the one it was merged into can't be deleted from under it", /FOREIGN KEY constraint failed/.test(refused(d1, "DELETE FROM customers WHERE id = ?", keep)));
  ok("looking a live customer up by email uses the email index",
    /idx_customers_email/.test(plan(d1, "SELECT id FROM customers WHERE email = 'casey@example.com' AND email <> '' AND mergedIntoId IS NULL")));

  say(`An order's customer, ${built}`);
  if (!d1.q("SELECT 1 AS x FROM orgs WHERE orgId = 'rules'").length) d1.q("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('rules', 'rules', 'Example Rules Shop', ?, ?)", T, T);
  d1.q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('R-9001', 'rules', 'Casey Keep', 'casey@example.com', ?)", T);
  ok("a new order has no customer until it is given one", d1.q("SELECT customerId FROM orders WHERE orderId = 'R-9001'")[0].customerId === null);
  d1.q("UPDATE orders SET customerId = ? WHERE orderId = 'R-9001'", keep);
  ok("an order can be given a customer", d1.q("SELECT customerId FROM orders WHERE orderId = 'R-9001'")[0].customerId === keep);
  ok("but not one that doesn't exist", /FOREIGN KEY constraint failed/.test(refused(d1, "UPDATE orders SET customerId = 999999 WHERE orderId = 'R-9001'")));
  ok("a customer with orders can't be deleted", /FOREIGN KEY constraint failed/.test(refused(d1, "DELETE FROM customers WHERE id = ?", keep)));
  d1.q("UPDATE orders SET customerId = NULL WHERE orderId = 'R-9001'");
  ok("an order can be unlinked again", d1.q("SELECT customerId FROM orders WHERE orderId = 'R-9001'")[0].customerId === null);
  ok("a customer's orders are found through the customer index", /idx_orders_customer/.test(plan(d1, "SELECT orderId FROM orders WHERE customerId = 1")));
}

(async () => {
  // ---------------------------------------------------------------- the list of migrations
  say("The migration is part of the code");
  const MIGRATIONS = new Function(strip(read("functions/_lib/migrationList.js")) + "\nreturn MIGRATIONS;")();
  ok("migrations/0105_customers.sql exists", migrationFiles.includes(MIGRATION));
  ok("functions/_lib/migrationList.js lists it, once", MIGRATIONS.filter(m => m === MIGRATION).length === 1);
  ok("right after 0104, in the same place as the file sits in migrations/",
    /^0104_/.test(MIGRATIONS[MIGRATIONS.indexOf(MIGRATION) - 1] || "") && MIGRATIONS.indexOf(MIGRATION) === migrationFiles.indexOf(MIGRATION));
  ok("no other migration has the number 0105", migrationFiles.filter(f => /^0105_/.test(f)).length === 1 && MIGRATIONS.filter(m => /^0105_/.test(m)).length === 1);

  // ---------------------------------------------------------------- before
  say("A database that hasn't had the migration yet");
  const d1 = await databaseBefore0105();
  ok("has no customers table", !hasTable(d1, "customers"));
  ok("and its orders have no customer column", !columns(d1, "orders").some(c => c.name === "customerId"));
  d1.q("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme', 'acme', 'Example Club', 't', 't')");
  d1.q("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('beta', 'beta', 'Example Team', 't', 't')");
  for (const [orderId, orgId, name, contact, placedAt, isTest] of ORDERS)
    d1.q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, isTest) VALUES (?, ?, ?, ?, ?, ?)", orderId, orgId, name, contact, placedAt, isTest);
  d1.q("UPDATE orders SET voidedAt = '2026-02-09T00:00:00.000Z' WHERE orderId = 'V-8001'");
  const ordersBefore = d1.q("SELECT * FROM orders ORDER BY orderId");
  ok("it holds the " + ORDERS.length + " orders this test placed in it", ordersBefore.length === ORDERS.length);

  // ---------------------------------------------------------------- the backfill
  say("Applying the migration to a database that already has orders");
  let applyError = "";
  try { d1.execFile(read("migrations/" + MIGRATION)); } catch (e) { applyError = String(e && e.message || e); }
  ok("the migration applies without an error", applyError === "");
  const customers = d1.q("SELECT * FROM customers ORDER BY id");
  const byEmail = (email) => customers.filter(c => c.email === email);
  const order = (orderId) => d1.q("SELECT * FROM orders WHERE orderId = ?", orderId)[0];
  const linkOf = (orderId) => order(orderId).customerId;
  ok("there is now one customer for each email real orders were placed with, and no other",
    JSON.stringify(customers.map(c => c.email).sort()) === JSON.stringify(EXPECTED_EMAILS));
  ok("each has a number of its own", new Set(customers.map(c => c.id)).size === customers.length && customers.every(c => Number.isInteger(c.id) && c.id > 0));
  ok("no order was added, removed or renumbered", JSON.stringify(d1.q("SELECT orderId FROM orders ORDER BY orderId")) === JSON.stringify(ordersBefore.map(o => ({ orderId: o.orderId }))));
  ok("and nothing else on an order changed: its name, contact and every other column are as they were",
    d1.q("SELECT * FROM orders ORDER BY orderId").every((o, i) => Object.keys(ordersBefore[i]).every(k => o[k] === ordersBefore[i][k])));

  say("The same email typed in different ways is one customer");
  const pats = byEmail("pat@example.com"), pat = pats[0] || {};
  ok("Pat@Example.COM, PAT@EXAMPLE.COM and pat@example.com make one customer, stored in lower case", pats.length === 1);
  ok("spaces around the email don't make it a different customer", linkOf("A-1001") === pat.id);
  ok("nor does a tab after it", linkOf("A-1003") === pat.id);
  ok("nor do line breaks around it", linkOf("A-1004") === pat.id);
  ok("the order typed exactly in lower case belongs to the same customer", linkOf("A-1002") === pat.id && Number.isInteger(pat.id));
  ok("orders with that email in two different shops belong to the one customer", order("A-1003").orgId === "beta" && order("A-1002").orgId === "acme" && linkOf("A-1003") === linkOf("A-1002"));
  ok("the customer's name is the name on that email's newest order, without the spaces around it", pat.name === "Pat Newest");
  ok("the customer has been one since that email's oldest order", pat.createdAt === "2025-12-01T08:00:00.000Z");
  ok("of two orders placed at the same moment, the one with the later order number gives the name", byEmail("sam@example.com").length === 1 && byEmail("sam@example.com")[0].name === "Sam Second");
  ok("and both of them belong to that customer", linkOf("S-2001") === byEmail("sam@example.com")[0].id && linkOf("S-2002") === linkOf("S-2001"));

  say("Test orders");
  ok("an email only a test order used makes no customer", byEmail("tester@example.com").length === 0);
  ok("and that test order stays without a customer", linkOf("T-3001") === null);
  ok("a test order with a real customer's email is linked to that customer", linkOf("T-1005") === pat.id && linkOf("T-1006") === pat.id);
  ok("a test order newer than every real one does not give the customer its name", pat.name !== "Test Pat Later");
  ok("a test order older than every real one does not move the customer's first date back", pat.createdAt > "2025-01-01T00:00:00.000Z");

  say("Contacts that aren't an email stay without a customer");
  const unlinked = (id) => linkOf(id) === null;
  ok("a phone number", unlinked("U-4001"));
  ok("no contact at all", unlinked("U-4002"));
  ok("only spaces", unlinked("U-4014"));
  ok("an address with no dot after the @ (a@b)", unlinked("U-4003") && byEmail("a@b").length === 0);
  ok("two @ signs side by side", unlinked("U-4004") && byEmail("pat@@example.com").length === 0);
  ok("two @ signs apart", unlinked("U-4005") && byEmail("pat@example.com@example.org").length === 0);
  ok("two emails in the one box", unlinked("U-4015"));
  ok("a space inside the address", unlinked("U-4006") && byEmail("pat lee@example.com").length === 0);
  ok("a tab inside the address", unlinked("U-4007"));
  ok("a line break inside the address", unlinked("U-4008") && unlinked("U-4009"));
  ok("nothing before the @", unlinked("U-4011") && byEmail("@example.com").length === 0);
  ok("nothing between the @ and the dot", unlinked("U-4012") && byEmail("pat@.com").length === 0);
  ok("nothing after the dot", unlinked("U-4013") && byEmail("pat@example.").length === 0);
  ok("an address of 201 characters", unlinked("U-4010") && byEmail(LONG_OVER).length === 0);
  ok("exactly the orders listed above, and the one test-only email, are without a customer",
    JSON.stringify(d1.q("SELECT orderId FROM orders WHERE customerId IS NULL ORDER BY orderId").map(o => o.orderId)) ===
    JSON.stringify(ORDERS.map(o => o[0]).filter(id => /^U-/.test(id) || id === "T-3001").sort()));

  say("Emails at the edge of what counts");
  ok("an address of exactly 200 characters, typed in capitals with spaces around it, is a customer in lower case", byEmail(LONG_OK).length === 1 && linkOf("L-5001") === byEmail(LONG_OK)[0].id);
  ok("dots and a plus sign before the @, and more than one dot after it, are kept as typed apart from the capitals",
    byEmail("lee.sample+club@mail.example.co").length === 1 && linkOf("D-7001") === byEmail("lee.sample+club@mail.example.co")[0].id && byEmail("lee.sample+club@mail.example.co")[0].name === "Lee Sample");
  ok("a name longer than 200 characters is cut to 200", byEmail("long.name@example.com").length === 1 && byEmail("long.name@example.com")[0].name === "N".repeat(200));
  ok("an order with a blank name makes a customer with no name", byEmail("noname@example.com").length === 1 && byEmail("noname@example.com")[0].name === "" && linkOf("N-6002") === byEmail("noname@example.com")[0].id);
  ok("the migration and the app agree on every one of these contacts: a linked order's customer has the email the app would look up",
    ORDERS.every(([id, , , contact]) => { const c = customers.find(x => x.id === linkOf(id)); return !c || (normalizeCustomerEmail_(contact) !== "" && c.email === normalizeCustomerEmail_(contact)); }));
  ok("and the app sees no email in any contact the migration left without a customer (the test-only one aside)",
    ORDERS.filter(([id]) => linkOf(id) === null && id !== "T-3001").every(([, , , contact]) => normalizeCustomerEmail_(contact) === ""));
  ok("every linked order's contact, trimmed and lower-cased, is its customer's email",
    d1.q("SELECT o.contact, c.email FROM orders o JOIN customers c ON c.id = o.customerId").length === ORDERS.length - 16 &&
    d1.q("SELECT o.contact, c.email FROM orders o JOIN customers c ON c.id = o.customerId").every(r => r.contact.trim().toLowerCase() === r.email));

  ok("a real order that was voided still makes its customer, and is linked to it",
    order("V-8001").voidedAt === "2026-02-09T00:00:00.000Z" && byEmail("voided@example.com").length === 1 && linkOf("V-8001") === byEmail("voided@example.com")[0].id);

  say("What a customer made by the migration starts with");
  ok("only a name and an email: no company, phone, address, notes or certificate", customers.length > 0 && customers.every(c => ["company", "phone", "addressJson", "notes", "taxExemptCertificate"].every(k => c[k] === "")));
  ok("no tax exemption", customers.every(c => c.taxExempt === 0 && c.taxExemptExpires === null));
  ok("not archived, not merged", customers.every(c => c.archivedAt === null && c.mergedIntoId === null));
  ok("last changed when the migration ran, as a full UTC timestamp", customers.every(c => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(c.updatedAt)));
  ok("every customer's first date is the date of one of its own real orders",
    customers.every(c => c.createdAt === d1.q("SELECT MIN(placedAt) AS t FROM orders WHERE customerId = ? AND isTest = 0", c.id)[0].t));

  // ---------------------------------------------------------------- an empty database
  say("Applying the migration to a database with no orders");
  const empty = await databaseBefore0105();
  let emptyError = "";
  try { empty.execFile(read("migrations/" + MIGRATION)); } catch (e) { emptyError = String(e && e.message || e); }
  ok("it applies without an error", emptyError === "");
  ok("the customers table is there, with nobody in it", hasTable(empty, "customers") && empty.q("SELECT COUNT(*) AS n FROM customers")[0].n === 0);
  ok("and orders have their customer column", columns(empty, "orders").some(c => c.name === "customerId"));
  const noEmails = await databaseBefore0105();
  noEmails.q("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme', 'acme', 'Example Club', 't', 't')");
  noEmails.q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('P-1', 'acme', 'Phone Person', '555-0100', '2026-01-01T00:00:00.000Z')");
  noEmails.q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, isTest) VALUES ('P-2', 'acme', 'Test Only', 'tester@example.com', '2026-01-01T00:00:00.000Z', 1)");
  noEmails.execFile(read("migrations/" + MIGRATION));
  ok("a shop whose only orders are by phone or tests gets no customers and no links",
    noEmails.q("SELECT COUNT(*) AS n FROM customers")[0].n === 0 && noEmails.q("SELECT COUNT(*) AS n FROM orders WHERE customerId IS NOT NULL")[0].n === 0);
  ok("a database that already had the migration refuses it a second time, and keeps what it had",
    /duplicate column name: customerId/.test((() => { try { d1.execFile(read("migrations/" + MIGRATION)); return ""; } catch (e) { return String(e.message); } })()) &&
    d1.q("SELECT COUNT(*) AS n FROM customers")[0].n === customers.length);

  // ---------------------------------------------------------------- the same shape from schema.sql
  say("A new database built from schema.sql has the same shape as a migrated one");
  const fresh = await createD1();
  fresh._raw.exec(read("schema.sql"));
  const want = [
    ["id", "INTEGER", 0, null, 1], ["name", "TEXT", 1, "''", 0], ["company", "TEXT", 1, "''", 0], ["email", "TEXT", 1, "''", 0], ["phone", "TEXT", 1, "''", 0],
    ["addressJson", "TEXT", 1, "''", 0], ["notes", "TEXT", 1, "''", 0], ["taxExempt", "INTEGER", 1, "0", 0], ["taxExemptCertificate", "TEXT", 1, "''", 0],
    ["taxExemptExpires", "TEXT", 0, null, 0], ["createdAt", "TEXT", 1, null, 0], ["updatedAt", "TEXT", 1, null, 0], ["archivedAt", "TEXT", 0, null, 0], ["mergedIntoId", "INTEGER", 0, null, 0],
  ];
  const shape = (db) => JSON.stringify(columns(db, "customers").map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk]));
  ok("the migrated customers table has the fourteen columns, with their types and defaults, in order", shape(empty) === JSON.stringify(want));
  ok("schema.sql's customers table has exactly the same columns", shape(fresh) === JSON.stringify(want));
  ok("a new database starts with no customers", fresh.q("SELECT COUNT(*) AS n FROM customers")[0].n === 0);
  const createSql = (db) => db.q("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customers'")[0].sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").replace(/ IF NOT EXISTS/i, "").trim();
  ok("the two tables are declared the same way, word for word", createSql(fresh) === createSql(empty) && /AUTOINCREMENT/.test(createSql(fresh)) && /CHECK \(taxExempt IN \(0, 1\)\)/.test(createSql(fresh)));
  const fks = (db, table, col) => JSON.stringify(db.q(`PRAGMA foreign_key_list(${table})`).filter(f => f.from === col).map(f => [f.table, f.to]));
  ok("mergedIntoId points at a customer in both", fks(empty, "customers", "mergedIntoId") === '[["customers","id"]]' && fks(fresh, "customers", "mergedIntoId") === fks(empty, "customers", "mergedIntoId"));
  const customerCol = (db) => JSON.stringify(columns(db, "orders").filter(c => c.name === "customerId").map(c => [c.type, c.notnull, c.dflt_value, c.pk]));
  ok("orders.customerId is a whole number that may be empty, with no default, in both", customerCol(empty) === '[["INTEGER",0,null,0]]' && customerCol(fresh) === customerCol(empty));
  ok("and points at a customer in both", fks(empty, "orders", "customerId") === '[["customers","id"]]' && fks(fresh, "orders", "customerId") === fks(empty, "orders", "customerId"));
  ok("orders have the same columns in the same order either way", JSON.stringify(columns(fresh, "orders").map(c => c.name)) === JSON.stringify(columns(empty, "orders").map(c => c.name)));
  const EMAIL_INDEX = "CREATE UNIQUE INDEX idx_customers_email ON customers(email) WHERE email <> '' AND mergedIntoId IS NULL";
  ok("the email index is unique and leaves out blank emails and merged-away customers, in both", indexSql(empty, "idx_customers_email") === EMAIL_INDEX && indexSql(fresh, "idx_customers_email") === EMAIL_INDEX);
  ok("the orders' customer index is on customerId alone, and not unique, in both",
    [empty, fresh].every(db => indexSql(db, "idx_orders_customer") === "CREATE INDEX idx_orders_customer ON orders(customerId)" &&
      JSON.stringify(db.q("PRAGMA index_info(idx_orders_customer)").map(c => c.name)) === '["customerId"]' &&
      db.q("PRAGMA index_list(orders)").filter(i => i.name === "idx_orders_customer")[0].unique === 0));
  const customerIndexes = (db) => JSON.stringify(db.q("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'customers' AND sql IS NOT NULL ORDER BY name").map(r => r.name));
  ok("customers have that one index and no other, in both", customerIndexes(empty) === '["idx_customers_email"]' && customerIndexes(fresh) === customerIndexes(empty));
  ok("neither database has a trigger on customers", [empty, fresh].every(db => db.q("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'customers'").length === 0));

  // ---------------------------------------------------------------- the rules, on each kind of database
  checkRules(d1, "after the migration ran on a database with orders");
  checkRules(empty, "after the migration ran on an empty database");
  checkRules(fresh, "in a new database built from schema.sql");
  ok("the customers the migration made were not disturbed by any of that",
    JSON.stringify(d1.q("SELECT * FROM customers WHERE id <= ? ORDER BY id", Math.max(...customers.map(c => c.id)))) === JSON.stringify(customers));
})().catch((e) => { console.log("the customers migration test ran to the end: false"); console.error(e); process.exitCode = 1; });
