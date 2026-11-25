// Customer records (migrations/0108): edge cases found while testing them, each fixed.
//   * The backfill takes only plain-ASCII emails, so it never makes a customer the app's own email check can't
//     find again (SQLite's trim() knows four white-space characters, JavaScript's knows many).
//   * saveCustomer refuses an expiry date that isn't a real calendar day (Date.parse rolls 2027-02-31 into March).
//   * listCustomers trims a search again after cutting it to 200 characters.
//   * On a database without migrations/0108, adding an exempt customer answers 503 BEFORE the exemption's audit row
//     is written, so the log never claims a change that didn't happen.
//   * A local sale that isn't shipped keeps the phone typed on it for the customer it makes.
// Real SQL (sql.js), the real db.js and orders.js. Invented customers only.

const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { saveCustomer, listCustomers, normalizeCustomerEmail_ };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  dbSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

const CUSTOMERS = fs.readdirSync(__dirname + "/migrations").find(f => /^\d{4}_customers\.sql$/.test(f));
async function newDb({ before } = {}) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && (!before || f < before)).sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  return d1;
}
const rows = (d1, sql) => { const st = d1._raw.prepare(sql); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; };

(async () => {
  // ---- The backfill and white space JavaScript knows but SQLite doesn't ------------------------------------
  {
    const d1 = await newDb({ before: CUSTOMERS });
    const order = (id, contact) => d1._raw.run(`INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES (?, 'acme', 'Pat Example', ?, '2026-01-0' || ?)`, [id, contact, String(1 + (id.charCodeAt(1) % 8))]);
    const odd = { nbspPad: " pat@example.com", formFeed: "pat@example.com\f", emSpace: "kim@example.com ", nbspInside: "lee x@example.com", feInside: "sam\fx@example.com", accented: "josé@example.com" };
    let n = 0; for (const c of Object.values(odd)) order("O" + (n++), c);
    order("OK", "plain@example.com");
    d1.execFile(read("migrations/" + CUSTOMERS));
    const made = rows(d1, "SELECT email FROM customers ORDER BY email").map(r => r.email);
    ok("the backfill still makes the plain email's customer", made.includes("plain@example.com"));
    ok("…and no customer for a contact with a no-break space, form feed, em space or other non-ASCII character", made.length === 1);
    ok("every customer the backfill makes is one the app's email check finds as it is", made.every(e => lib.normalizeCustomerEmail_(e) === e));
    ok("those orders are left unlinked, for the app to link when it next sees the email", rows(d1, "SELECT count(*) AS n FROM orders WHERE customerId IS NULL")[0].n === Object.keys(odd).length);
  }

  // ---- saveCustomer and a date that isn't a day ---------------------------------------------------------------
  const d1 = await newDb();
  for (const bad of ["2027-02-31", "2027-02-29", "2027-04-31", "2027-13-01", "2027-00-10"]) {
    const r = await lib.saveCustomer(d1, { name: "Date " + bad, taxExempt: true, taxExemptExpires: bad });
    ok(`saveCustomer refuses the expiry ${bad}, which isn't a calendar day`, r.error === "The exemption's expiry date isn't a date." && rows(d1, `SELECT count(*) AS n FROM customers WHERE name = 'Date ${bad}'`)[0].n === 0);
  }
  for (const good of ["2028-02-29", "2027-12-31", "2027-01-01"]) {
    const r = await lib.saveCustomer(d1, { name: "Date " + good, taxExempt: true, taxExemptExpires: good });
    ok(`…and keeps the real day ${good}`, !r.error && rows(d1, `SELECT taxExemptExpires AS d FROM customers WHERE name = 'Date ${good}'`)[0].d === good);
  }

  // ---- listCustomers and a search cut to 200 characters -------------------------------------------------------
  await lib.saveCustomer(d1, { name: "Pat Example", email: "pat@example.com" });
  const longQ = "pat example" + " ".repeat(189) + "zzz";
  ok("a search whose 200th character falls in trailing spaces is trimmed again, and still finds the customer", (await lib.listCustomers(d1, { q: longQ })).total === 1);
  ok("(a search of the same words with nothing after them finds them too)", (await lib.listCustomers(d1, { q: "pat example" })).total === 1);

  // ---- A local sale that isn't shipped, from a new email ------------------------------------------------------
  {
    const sale = async (body) => { const res = await api({ env: { DB: d1 }, waitUntil: () => {},
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", action: "createLocalSale", org: "acme",
        items: [{ productId: "__custom__", name: "Patch", qty: 1, customUnitPrice: 5, type: "patch" }] }, body), headers: { get: () => null } } });
      return { status: res.status, body: JSON.parse(await res.text()) }; };
    const r = await sale({ customerName: "Robin Walk-in", contact: "robin@example.com", phone: " 555-0104 " });
    const c = rows(d1, "SELECT phone FROM customers WHERE email = 'robin@example.com'")[0];
    ok("a local sale with no shipping makes its new customer with the phone typed on the sale", r.status === 200 && !!c && c.phone === "555-0104");
    const r2 = await sale({ customerName: "Robin Walk-in", contact: "robin@example.com", phone: "555-0199" });
    ok("…and a later sale with another phone doesn't change the customer's", r2.status === 200 && rows(d1, "SELECT phone FROM customers WHERE email = 'robin@example.com'")[0].phone === "555-0104");
  }

  // ---- A database without migrations/0108: no audit row for an exemption that wasn't saved --------------------
  {
    const old = await newDb({ before: CUSTOMERS });
    const res = await api({ env: { DB: old }, waitUntil: () => {},
      request: { url: "https://admin.example.com/api/orders", json: async () => ({ key: "x", action: "saveCustomer", name: "Too Early", taxExempt: true, taxExemptCertificate: "C-1" }), headers: { get: () => null } } });
    const body = JSON.parse(await res.text());
    ok("adding an exempt customer before the migration answers 503 with a plain sentence", res.status === 503 && typeof body.message === "string" && body.message.length > 10);
    ok("…and writes no exemption row to the audit log", rows(old, "SELECT count(*) AS n FROM audit_log WHERE action LIKE 'customer.%'")[0].n === 0);
  }
})().catch((e) => { console.error(e); console.log("test310 crashed: false"); process.exit(1); });
