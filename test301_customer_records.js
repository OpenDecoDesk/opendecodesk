const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

// Customer records (migrations/0108), the data functions in db.js called directly:
//   normalizeCustomerEmail_   what counts as an email, and how it is stored
//   saveCustomer              adding and changing one: every refusal, every length cap, what an unset field keeps,
//                             the address that is kept, and the before / after it hands the audit log
//   listCustomers             the search, archived and merged-away rows, the sort, paging, and the order counts
//   getCustomer               one customer with its orders and what they add up to
//   setCustomerArchived       archive and restore
//   …and each of them (with the functions beside them) on a database that hasn't had migrations/0108 yet.
// Real SQL (sql.js) + the real db.js. Invented customers only; every date an order is placed on is fixed.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) +
  "\nreturn { normalizeCustomerEmail_, saveCustomer, listCustomers, getCustomer, setCustomerArchived, mergeCustomers, setOrderCustomer," +
  " findOrCreateCustomerForOrder_, insertOrder, getOrderById, addOrderPayment, voidPayment, voidOrder, setOrderDiscount, setSalesTaxSettings };")();

const MIGRATIONS = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
// A database with every migration, or (before) only the ones before that number.
async function makeDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of MIGRATIONS) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  return d1;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => Object.keys(o).sort().join(",");
const thrown = async (fn) => { try { await fn(); return ""; } catch (e) { return String((e && e.message) || e) || "an error"; } };
const NOT_FOUND = "That customer wasn't found.";

(async () => {
  // =====================================================================================================
  console.log("=== What counts as an email, and how it is kept ===");
  const norm = lib.normalizeCustomerEmail_;
  ok("an email is trimmed and lower-cased", norm("  Pat@Example.COM \n") === "pat@example.com");
  ok("only A to Z are lowered, as the database's lower() does (an accented capital stays)", norm("ÉMILE@EXAMPLE.COM") === "Émile@example.com");
  ok("nothing at all is not an email", norm(null) === "" && norm(undefined) === "" && norm("") === "" && norm("   ") === "");
  ok("a phone number is not an email", norm("555-0100") === "" && norm(5550100) === "");
  ok("it needs something before the @", norm("@example.com") === "");
  ok("it needs a dot after the @, with something either side of it", norm("pat@example") === "" && norm("pat@example.") === "" && norm("pat@.com") === "");
  ok("two @ are not an email", norm("pat@home@example.com") === "");
  ok("white space inside is not an email", norm("pat smith@example.com") === "" && norm("pat@exa\tmple.com") === "" && norm("pat@example.com\nx@example.com") === "");
  const at200 = "a".repeat(188) + "@example.com", at201 = "a".repeat(189) + "@example.com";
  ok("an email of exactly 200 characters is kept", at200.length === 200 && norm(at200) === at200);
  ok("one of 201 characters is not an email", at201.length === 201 && norm(at201) === "");
  ok("…and the 200 are counted after trimming", norm("  " + at200 + "  ") === at200);

  // =====================================================================================================
  console.log("\n=== Adding a customer ===");
  const d1 = await makeDb();
  const row = (id) => d1.q("SELECT * FROM customers WHERE id = ?", id)[0];
  const count = () => d1.q("SELECT count(*) AS n FROM customers")[0].n;

  let r = await lib.saveCustomer(d1, { name: "  Pat Example  ", company: " Example Club ", email: "  Pat@Example.COM ", phone: " 555-0100 ", notes: "  Prefers pickup. ",
    address: { name: "Pat Example", line1: "1 Example Street", city: "Exampleville", state: "ZZ", zip: "00000", country: "US", phone: "555-0100" },
    taxExempt: true, taxExemptCertificate: " CERT-1 ", taxExemptExpires: " 2030-06-30 " });
  const patId = r.id;
  ok("a new customer answers with its id (a number), created, and nothing before", Number.isInteger(patId) && patId > 0 && r.created === true && r.before === null && !r.error);
  ok("…and with the customer as it now is, in the shape getCustomer gives",
    keys(r.after) === "address,allowNet30,archived,company,createdAt,email,id,name,notes,phone,taxExempt,taxExemptCertificate,taxExemptExpires,termsDays,updatedAt");
  ok("the text fields are stored trimmed, the email lower case", same([r.after.name, r.after.company, r.after.email, r.after.phone, r.after.notes], ["Pat Example", "Example Club", "pat@example.com", "555-0100", "Prefers pickup."]));
  ok("the exemption is stored: ticked, the certificate and the expiry date trimmed", r.after.taxExempt === true && r.after.taxExemptCertificate === "CERT-1" && r.after.taxExemptExpires === "2030-06-30");
  ok("the address comes back as an object", r.after.address && r.after.address.line1 === "1 Example Street" && r.after.address.city === "Exampleville" && r.after.address.zip === "00000");
  ok("a new customer is not archived, and was created and updated at the same moment", r.after.archived === false && /^\d{4}-\d{2}-\d{2}T/.test(r.after.createdAt) && r.after.createdAt === r.after.updatedAt);
  ok("the row in the database is that customer", row(patId).name === "Pat Example" && row(patId).email === "pat@example.com" && row(patId).taxExempt === 1 && row(patId).archivedAt === null && row(patId).mergedIntoId === null);
  ok("what getCustomer reads is exactly what the save answered with", same((await lib.getCustomer(d1, patId)).customer, r.after));

  r = await lib.saveCustomer(d1, { name: "Sam Sample" });
  const samId = r.id;
  ok("a name alone is enough", r.created === true && r.after.name === "Sam Sample");
  ok("everything not given starts empty: no company, email, phone, notes, address or exemption",
    same([r.after.company, r.after.email, r.after.phone, r.after.notes, r.after.address, r.after.taxExempt, r.after.taxExemptCertificate, r.after.taxExemptExpires], ["", "", "", "", null, false, "", ""]));
  ok("an expiry date that isn't set is stored as NULL, an address that isn't as empty text", row(samId).taxExemptExpires === null && row(samId).addressJson === "");
  r = await lib.saveCustomer(d1, { company: "Sample Works", id: "" });
  const worksId = r.id;
  ok("a company alone is enough (an empty id means a new customer)", r.created === true && r.after.company === "Sample Works" && r.after.name === "" && worksId !== samId);
  r = await lib.saveCustomer(d1, { id: null, name: "Null Fields", company: null, email: null, phone: null, notes: null, address: null, taxExemptCertificate: null, taxExemptExpires: null, taxExempt: null });
  const nullId = r.id;
  ok("fields given as null are stored empty", r.created === true && same([r.after.company, r.after.email, r.after.phone, r.after.notes, r.after.address, r.after.taxExemptCertificate, r.after.taxExemptExpires, r.after.taxExempt], ["", "", "", "", null, "", "", false]));
  r = await lib.saveCustomer(d1, { name: "Exempt By One", taxExempt: 1 });
  ok("no certificate is needed to tick the exemption", r.created === true && r.after.taxExempt === true && r.after.taxExemptCertificate === "");

  console.log("\n=== What a new customer is refused for ===");
  let n = count();
  r = await lib.saveCustomer(d1, {});
  ok("nothing at all: a name or a company is needed", r.error === "Enter a name or a company." && r.id === undefined);
  r = await lib.saveCustomer(d1, { name: "   ", company: " \t ", email: "blank@example.com" });
  ok("a name and company of only spaces are refused the same way", r.error === "Enter a name or a company.");
  r = await lib.saveCustomer(d1);
  ok("…and so is a call with no customer at all", r.error === "Enter a name or a company.");
  r = await lib.saveCustomer(d1, { name: "Bad Email", email: "not-an-email" });
  ok("an email that isn't one is refused in a plain sentence", r.error === "That doesn't look like an email address.");
  r = await lib.saveCustomer(d1, { name: "Bad Email", email: "555-0100" });
  ok("a phone number in the email field is refused", r.error === "That doesn't look like an email address.");
  r = await lib.saveCustomer(d1, { name: "Long Email", email: at201 });
  ok("an email over 200 characters is refused, not cut", r.error === "That doesn't look like an email address.");
  r = await lib.saveCustomer(d1, { name: "Second Pat", email: "pat@example.com" });
  ok("an email another customer has is refused", r.error === "Another customer already has that email.");
  r = await lib.saveCustomer(d1, { name: "Second Pat", email: " PAT@EXAMPLE.com " });
  ok("…whatever its capitals and the spaces around it", r.error === "Another customer already has that email.");
  for (const [bad, why] of [["tomorrow", "a word"], ["2030-6-30", "a date without leading zeros"], ["06/30/2030", "a date with slashes"], ["2030-13-01", "a thirteenth month"],
    ["2030-06-30T00:00:00Z", "a date with a time"], ["20300630", "eight digits run together"],
    ["2030-06", "a month without a day"], ["+002030-06-30", "a year written with six digits"]]) {
    r = await lib.saveCustomer(d1, { name: "Bad Date", taxExemptExpires: bad });
    ok("an expiry date that is " + why + " is refused", r.error === "The exemption's expiry date isn't a date.");
  }
  for (const [bad, why] of [["abc", "a word"], [0, "zero"], [-3, "a negative number"], [1.5, "a fraction"], [{}, "an object"]]) {
    r = await lib.saveCustomer(d1, { id: bad, name: "Whoever" });
    ok("an id that is " + why + " is not a customer (and doesn't quietly add one)", r.error === NOT_FOUND);
  }
  r = await lib.saveCustomer(d1, { id: 99999, name: "Whoever" });
  ok("an id no customer has is refused", r.error === NOT_FOUND);
  ok("none of those refusals added a customer", count() === n);

  console.log("\n=== The length caps ===");
  r = await lib.saveCustomer(d1, { name: "n".repeat(250), company: "c".repeat(250), phone: "5".repeat(80), notes: "x".repeat(2500), taxExemptCertificate: "k".repeat(250) });
  const longId = r.id;
  ok("a name is cut to 200 characters", r.after.name === "n".repeat(200));
  ok("a company is cut to 200 characters", r.after.company === "c".repeat(200));
  ok("a phone number is cut to 50 characters", r.after.phone === "5".repeat(50));
  ok("notes are cut to 2000 characters", r.after.notes === "x".repeat(2000));
  ok("a certificate number is cut to 200 characters", r.after.taxExemptCertificate === "k".repeat(200));
  r = await lib.saveCustomer(d1, { name: "  " + "n".repeat(200) + "  ", phone: 5550100 });
  ok("the cap counts what is left after trimming, and a number is kept as text", r.after.name === "n".repeat(200) && r.after.phone === "5550100");
  r = await lib.saveCustomer(d1, { name: "At The Cap", email: at200.toUpperCase() });
  ok("an email of exactly 200 characters is taken", r.created === true && r.after.email === at200);

  console.log("\n=== The address that is kept ===");
  r = await lib.saveCustomer(d1, { name: "Address One", address: { name: "  Robin Example ", line1: " 2 Example Road ", line2: "Unit 3", city: "Exampleville", state: "zz", zip: 12345, country: "US", phone: "555-0101",
    lat: 1.5, residential: true, note: "leave at the door", line3: "extra" } });
  const addrId = r.id;
  ok("its eight fields are kept, trimmed, a number as text",
    same(r.after.address, { name: "Robin Example", line1: "2 Example Road", line2: "Unit 3", city: "Exampleville", state: "zz", zip: "12345", country: "US", phone: "555-0101" }));
  ok("anything else sent with it is left out", !("lat" in r.after.address) && !("residential" in r.after.address) && !("note" in r.after.address) && !("line3" in r.after.address));
  r = await lib.saveCustomer(d1, { name: "Address Two", address: { name: "N".repeat(300), line1: "1".repeat(300), line2: "2".repeat(300), city: "C".repeat(300), state: "S".repeat(300), zip: "9".repeat(300), country: "U".repeat(300), phone: "5".repeat(300) } });
  ok("each address field is cut to 200 characters", ["name", "line1", "line2", "city", "state", "zip", "country", "phone"].every(k => r.after.address[k].length === 200));
  r = await lib.saveCustomer(d1, { name: "Address Three", address: { line1: "3 Example Lane", line2: "   ", city: "", state: null, zip: undefined, country: { code: "US" }, phone: ["555-0102"] } });
  ok("empty fields, and ones that aren't text, are left out of it", same(r.after.address, { line1: "3 Example Lane" }));
  r = await lib.saveCustomer(d1, { name: "Address Four", address: { line1: "  ", city: "" } });
  ok("an address with nothing in it is no address", r.after.address === null && row(r.id).addressJson === "");
  r = await lib.saveCustomer(d1, { name: "Address Five", address: ["1 Example Street"] });
  ok("a list is not an address", r.after.address === null);
  r = await lib.saveCustomer(d1, { name: "Address Six", address: "1 Example Street" });
  ok("a line of text is not an address", r.after.address === null);

  console.log("\n=== Changing a customer ===");
  d1._raw.run("UPDATE customers SET createdAt = '2026-01-01T00:00:00.000Z', updatedAt = '2026-01-01T00:00:00.000Z' WHERE id = ?", [patId]);
  const patBefore = (await lib.getCustomer(d1, patId)).customer;
  r = await lib.saveCustomer(d1, { id: patId, name: "Pat Q. Example", phone: "555-0199" });
  ok("a change answers with the same id, not created", r.id === patId && r.created === false && !r.error);
  ok("…with the customer as it was before", same(r.before, patBefore) && r.before.name === "Pat Example" && r.before.phone === "555-0100");
  ok("…and as it is now", r.after.name === "Pat Q. Example" && r.after.phone === "555-0199" && same(r.after, (await lib.getCustomer(d1, patId)).customer));
  ok("the fields that weren't sent keep what they had: company, email, notes and address",
    r.after.company === "Example Club" && r.after.email === "pat@example.com" && r.after.notes === "Prefers pickup." && same(r.after.address, patBefore.address));
  ok("…and the exemption a caller didn't send is not cleared", r.after.taxExempt === true && r.after.taxExemptCertificate === "CERT-1" && r.after.taxExemptExpires === "2030-06-30");
  ok("the day it became a customer stays; the time it was last changed moves on", r.after.createdAt === "2026-01-01T00:00:00.000Z" && r.after.updatedAt > "2026-01-01T00:00:00.000Z");
  ok("no second row was made", count() === d1.q("SELECT max(id) AS m FROM customers")[0].m && d1.q("SELECT count(*) AS n FROM customers WHERE email = 'pat@example.com'")[0].n === 1);

  r = await lib.saveCustomer(d1, { id: String(patId), name: "Pat Example" });
  ok("an id sent as text finds the same customer", r.id === patId && r.created === false && r.after.name === "Pat Example");
  r = await lib.saveCustomer(d1, { id: patId, email: "PAT@example.com" });
  ok("saving a customer with its own email is not a duplicate", !r.error && r.after.email === "pat@example.com");
  r = await lib.saveCustomer(d1, { id: patId, email: "Pat.New@Example.com" });
  ok("an email can be changed, and is stored lower case", !r.error && r.before.email === "pat@example.com" && r.after.email === "pat.new@example.com");
  r = await lib.saveCustomer(d1, { name: "Took The Old One", email: "pat@example.com" });
  const tookId = r.id;
  ok("the email it gave up is free for another customer", r.created === true && r.after.email === "pat@example.com");
  r = await lib.saveCustomer(d1, { id: patId, email: "Pat@Example.com" });
  ok("changing to an email another customer now has is refused", r.error === "Another customer already has that email." && row(patId).email === "pat.new@example.com");
  r = await lib.saveCustomer(d1, { id: patId, email: "nope" });
  ok("changing to something that isn't an email is refused, the old one kept", r.error === "That doesn't look like an email address." && row(patId).email === "pat.new@example.com");
  r = await lib.saveCustomer(d1, { id: patId, email: "  " });
  ok("an email sent empty is cleared", !r.error && r.after.email === "" && row(patId).email === "");
  r = await lib.saveCustomer(d1, { id: samId, email: "" });
  ok("two customers may both have no email", !r.error && r.after.email === "" && d1.q("SELECT count(*) AS n FROM customers WHERE email = ''")[0].n >= 2);
  r = await lib.saveCustomer(d1, { id: patId, email: "pat.new@example.com" });
  ok("…and given back", !r.error && r.after.email === "pat.new@example.com");

  r = await lib.saveCustomer(d1, { id: patId, name: "", company: "" });
  ok("clearing both the name and the company is refused, nothing changed", r.error === "Enter a name or a company." && row(patId).name === "Pat Example" && row(patId).company === "Example Club");
  r = await lib.saveCustomer(d1, { id: patId, name: "" });
  ok("clearing the name of a customer with a company is fine", !r.error && r.after.name === "" && r.after.company === "Example Club");
  r = await lib.saveCustomer(d1, { id: patId, company: "  " });
  ok("…but then the company can't go too", r.error === "Enter a name or a company." && row(patId).company === "Example Club");
  r = await lib.saveCustomer(d1, { id: patId, name: "Pat Example", company: null });
  ok("with the name back, the company can be cleared", !r.error && r.after.name === "Pat Example" && r.after.company === "");

  r = await lib.saveCustomer(d1, { id: patId, taxExemptExpires: "2031-12-31" });
  ok("the expiry date alone can be changed", !r.error && r.before.taxExemptExpires === "2030-06-30" && r.after.taxExemptExpires === "2031-12-31" && r.after.taxExempt === true && r.after.taxExemptCertificate === "CERT-1");
  r = await lib.saveCustomer(d1, { id: patId, taxExemptExpires: "next year" });
  ok("a changed expiry date that isn't a date is refused, the old one kept", r.error === "The exemption's expiry date isn't a date." && row(patId).taxExemptExpires === "2031-12-31");
  r = await lib.saveCustomer(d1, { id: patId, taxExemptExpires: "" });
  ok("an expiry date sent empty is cleared (NULL in the database)", !r.error && r.after.taxExemptExpires === "" && row(patId).taxExemptExpires === null);
  r = await lib.saveCustomer(d1, { id: patId, taxExemptExpires: "2031-12-31" });
  r = await lib.saveCustomer(d1, { id: patId, taxExemptExpires: null });
  ok("…and so is one sent as null", !r.error && r.before.taxExemptExpires === "2031-12-31" && r.after.taxExemptExpires === "");
  r = await lib.saveCustomer(d1, { id: patId, taxExempt: false });
  ok("the exemption can be unticked, the certificate left as it was", !r.error && r.before.taxExempt === true && r.after.taxExempt === false && r.after.taxExemptCertificate === "CERT-1" && row(patId).taxExempt === 0);
  r = await lib.saveCustomer(d1, { id: patId, notes: "Changed." });
  ok("…and an unticked one stays unticked when the box isn't sent", !r.error && r.after.taxExempt === false && r.after.notes === "Changed.");
  r = await lib.saveCustomer(d1, { id: patId, taxExempt: true, taxExemptCertificate: "" });
  ok("…ticked again, and the certificate cleared", !r.error && r.after.taxExempt === true && r.after.taxExemptCertificate === "");
  r = await lib.saveCustomer(d1, { id: patId, phone: "", notes: "" });
  ok("a phone number and notes sent empty are cleared", !r.error && r.after.phone === "" && r.after.notes === "");

  r = await lib.saveCustomer(d1, { id: patId, address: { line1: "9 Example Avenue", city: "Exampleton" } });
  ok("a new address replaces the old one whole (it is not mixed with it)", same(r.after.address, { line1: "9 Example Avenue", city: "Exampleton" }) && r.before.address.line1 === "1 Example Street");
  r = await lib.saveCustomer(d1, { id: patId, address: null });
  ok("an address sent as null is cleared", !r.error && r.after.address === null && row(patId).addressJson === "");
  r = await lib.saveCustomer(d1, { id: longId, name: "m".repeat(300), company: "d".repeat(300), phone: "6".repeat(90), notes: "y".repeat(2600), taxExemptCertificate: "j".repeat(300) });
  ok("the caps hold on a change too: 200, 200, 50, 2000 and 200",
    same([r.after.name.length, r.after.company.length, r.after.phone.length, r.after.notes.length, r.after.taxExemptCertificate.length], [200, 200, 50, 2000, 200]) && r.after.name[0] === "m");

  console.log("\n=== Archived and merged-away customers, and a lost race ===");
  await lib.setCustomerArchived(d1, tookId, true);
  r = await lib.saveCustomer(d1, { name: "Wants It Too", email: "pat@example.com" });
  ok("an archived customer still holds its email", r.error === "Another customer already has that email.");
  r = await lib.saveCustomer(d1, { id: tookId, notes: "Still here." });
  ok("an archived customer can be changed, and stays archived", !r.error && r.after.notes === "Still here." && r.after.archived === true && r.before.archived === true);
  // A duplicate folded into another customer (what mergeCustomers leaves behind).
  d1._raw.run("UPDATE customers SET mergedIntoId = ?, archivedAt = '2026-02-02T00:00:00.000Z' WHERE id = ?", [samId, tookId]);
  r = await lib.saveCustomer(d1, { id: tookId, notes: "Too late." });
  ok("a customer that was merged into another can't be changed", r.error === NOT_FOUND && row(tookId).notes === "Still here.");
  r = await lib.saveCustomer(d1, { name: "Wants It Too", email: "pat@example.com" });
  const wantsId = r.id;
  ok("…and its email is free again for a live customer", r.created === true && r.after.email === "pat@example.com");
  // Someone else takes the email between the check and the write: the check sees nobody, the index refuses.
  const racing = { prepare: (sql) => /AND id <> \?/.test(sql) ? { bind: () => ({ first: async () => null }) } : d1.prepare(sql), batch: (s) => d1.batch(s) };
  n = count();
  r = await lib.saveCustomer(racing, { name: "Lost The Race", email: "pat@example.com" });
  ok("a new customer whose email is taken in the moment between the check and the save is refused the same way", r.error === "Another customer already has that email." && count() === n);
  r = await lib.saveCustomer(racing, { id: nullId, email: "pat@example.com" });
  ok("…and so is a change that loses that race, the customer left as it was", r.error === "Another customer already has that email." && row(nullId).email === "");
  const broken = { prepare: (sql) => /^\s*INSERT INTO customers/.test(sql) ? { bind: () => ({ run: async () => { throw new Error("disk I/O error"); } }) } : d1.prepare(sql) };
  ok("any other database failure while saving is not swallowed", /disk I\/O error/.test(await thrown(() => lib.saveCustomer(broken, { name: "Unlucky" }))));

  // =====================================================================================================
  console.log("\n=== Archive and restore ===");
  r = await lib.setCustomerArchived(d1, samId, true);
  ok("archiving answers ok", same(r, { ok: true }));
  const archivedAt = row(samId).archivedAt;
  ok("the customer is marked archived, with the time", /^\d{4}-\d{2}-\d{2}T/.test(archivedAt) && (await lib.getCustomer(d1, samId)).customer.archived === true);
  ok("its other fields are untouched", row(samId).name === "Sam Sample" && row(samId).mergedIntoId === null);
  d1._raw.run("UPDATE customers SET archivedAt = '2026-03-03T00:00:00.000Z', updatedAt = '2026-03-03T00:00:00.000Z' WHERE id = ?", [samId]);
  r = await lib.setCustomerArchived(d1, samId, true);
  ok("archiving one already archived keeps the day it was archived on", r.ok === true && row(samId).archivedAt === "2026-03-03T00:00:00.000Z");
  ok("…while noting it was touched", row(samId).updatedAt > "2026-03-03T00:00:00.000Z");
  r = await lib.setCustomerArchived(d1, String(samId), false);
  ok("restoring (the id sent as text) clears the mark", r.ok === true && row(samId).archivedAt === null && (await lib.getCustomer(d1, samId)).customer.archived === false);
  r = await lib.setCustomerArchived(d1, samId, false);
  ok("restoring one that isn't archived is fine and leaves it so", r.ok === true && row(samId).archivedAt === null);
  r = await lib.setCustomerArchived(d1, samId, 1);
  ok("anything truthy archives", r.ok === true && row(samId).archivedAt !== null);
  r = await lib.setCustomerArchived(d1, samId, 0);
  ok("anything falsy restores", r.ok === true && row(samId).archivedAt === null);
  r = await lib.setCustomerArchived(d1, 99999, true);
  ok("an id no customer has is refused", same(r, { error: NOT_FOUND }));
  for (const [bad, why] of [["abc", "a word"], [0, "zero"], [null, "nothing"], [2.5, "a fraction"]]) {
    r = await lib.setCustomerArchived(d1, bad, true);
    ok("an id that is " + why + " is refused", r.error === NOT_FOUND && !r.ok);
  }
  r = await lib.setCustomerArchived(d1, tookId, false);
  ok("a customer merged into another can't be restored on its own", r.error === NOT_FOUND && row(tookId).archivedAt === "2026-02-02T00:00:00.000Z");
  ok("only the customer named was ever touched", row(patId).archivedAt === null && row(worksId).archivedAt === null && row(wantsId).archivedAt === null);

  // =====================================================================================================
  console.log("\n=== The customer list ===");
  const db = await makeDb();
  const add = async (c) => { const s = await lib.saveCustomer(db, c); if (s.error) throw new Error(s.error); return s.id; };
  const pat = await add({ name: "pat Example", email: "pat@example.com", phone: "555-0100" });
  const club = await add({ company: "Example Club", email: "club@example.com", phone: "555-0101" });
  const alexA = await add({ name: "Alex Sample", company: "Zed Works", phone: "555-0102" });
  const alexB = await add({ name: "alex sample", email: "second@sample.test" });
  const morgan = await add({ name: "Morgan Test", email: "morgan@example.com", taxExempt: true, taxExemptExpires: "2030-01-01" });
  const dup = await add({ name: "Dup Person", email: "dup@example.com", phone: "555-0100" });
  const quinn = await add({ name: "Quinn 100%_real", taxExempt: true });
  await lib.setCustomerArchived(db, morgan, true);
  db._raw.run("UPDATE customers SET mergedIntoId = ?, archivedAt = '2026-02-02T00:00:00.000Z' WHERE id = ?", [pat, dup]);
  const ids = (res) => res.customers.map(c => c.id);

  let l = await lib.listCustomers(db);
  ok("with nothing asked for, it lists the live customers that aren't archived, and says how many", same(ids(l), [alexA, alexB, club, pat, quinn]) && l.total === 5);
  ok("they are in name order whatever the capitals (pat before Quinn)", ids(l).indexOf(pat) < ids(l).indexOf(quinn));
  ok("a customer with only a company sorts by the company (Example Club between alex and pat)", ids(l).indexOf(club) === 2);
  ok("two with the same name come in the order they were added", ids(l).indexOf(alexA) + 1 === ids(l).indexOf(alexB));
  ok("each row carries exactly: id, name, company, email, phone, taxExempt, taxExemptExpires, archived, orderCount, lastOrderAt",
    l.customers.every(c => keys(c) === "archived,company,email,id,lastOrderAt,name,orderCount,phone,taxExempt,taxExemptExpires"));
  const rowOf = (res, id) => res.customers.find(c => c.id === id);
  ok("a row has the customer's own details", same(rowOf(l, alexA), { id: alexA, name: "Alex Sample", company: "Zed Works", email: "", phone: "555-0102", taxExempt: false, taxExemptExpires: "", archived: false, orderCount: 0, lastOrderAt: "" }));
  ok("an exempt customer is marked, with no expiry date as empty text", rowOf(l, quinn).taxExempt === true && rowOf(l, quinn).taxExemptExpires === "");
  ok("called with no options at all it answers the same", same(await lib.listCustomers(db, undefined), l) && same(await lib.listCustomers(db, {}), l));

  l = await lib.listCustomers(db, { includeArchived: true });
  ok("asked for archived ones too, the archived customer is listed in its place", same(ids(l), [alexA, alexB, club, morgan, pat, quinn]) && l.total === 6);
  ok("…marked archived, with its exemption and expiry date", rowOf(l, morgan).archived === true && rowOf(l, morgan).taxExempt === true && rowOf(l, morgan).taxExemptExpires === "2030-01-01" && rowOf(l, pat).archived === false);
  ok("a customer merged into another is never listed, archived ones shown or not", !ids(l).includes(dup));

  console.log("\n=== Searching the list ===");
  l = await lib.listCustomers(db, { q: "PAT EX" });
  ok("the search finds a name, whatever the capitals", same(ids(l), [pat]) && l.total === 1);
  l = await lib.listCustomers(db, { q: "zed w" });
  ok("…a company", same(ids(l), [alexA]) && l.total === 1);
  l = await lib.listCustomers(db, { q: "CLUB@EXAMPLE" });
  ok("…an email", same(ids(l), [club]) && l.total === 1);
  l = await lib.listCustomers(db, { q: "0102" });
  ok("…a phone number", same(ids(l), [alexA]) && l.total === 1);
  l = await lib.listCustomers(db, { q: "example" });
  ok("…and anyone it matches in any of the four, in name order", same(ids(l), [club, pat]) && l.total === 2);
  l = await lib.listCustomers(db, { q: "   alex   " });
  ok("spaces around what was typed are ignored", same(ids(l), [alexA, alexB]) && l.total === 2);
  l = await lib.listCustomers(db, { q: "nobody-by-that-name" });
  ok("a search nobody matches lists nobody, a total of none", same(l.customers, []) && l.total === 0);
  l = await lib.listCustomers(db, { q: "%" });
  ok("a percent sign means itself, not anything", same(ids(l), [quinn]) && l.total === 1);
  l = await lib.listCustomers(db, { q: "_" });
  ok("an underscore means itself, not any one character", same(ids(l), [quinn]) && l.total === 1);
  l = await lib.listCustomers(db, { q: "morgan" });
  ok("the search leaves an archived customer out", same(ids(l), []) && l.total === 0);
  l = await lib.listCustomers(db, { q: "morgan", includeArchived: true });
  ok("…unless archived ones are asked for", same(ids(l), [morgan]) && l.total === 1);
  l = await lib.listCustomers(db, { q: "dup", includeArchived: true });
  ok("it never finds a merged-away customer by name", l.total === 0 && l.customers.length === 0);
  l = await lib.listCustomers(db, { q: "555-0100", includeArchived: true });
  ok("…nor by the phone number it shares with the customer it was merged into", same(ids(l), [pat]) && l.total === 1);
  l = await lib.listCustomers(db, { q: null });
  ok("a search of nothing (null, or only spaces) lists everyone", l.total === 5 && (await lib.listCustomers(db, { q: "   " })).total === 5);
  l = await lib.listCustomers(db, { q: 555 });
  ok("a number typed is searched as text", same(ids(l), [alexA, club, pat]) && l.total === 3);
  const wide = await add({ name: "W".repeat(200) });
  l = await lib.listCustomers(db, { q: "w".repeat(200) + "zzz" });
  ok("only the first 200 characters typed are searched", same(ids(l), [wide]) && (await lib.listCustomers(db, { q: "w".repeat(199) + "z" })).total === 0);
  await lib.setCustomerArchived(db, wide, true);

  console.log("\n=== Paging the list ===");
  l = await lib.listCustomers(db, { limit: 2 });
  ok("a page of two is the first two by name, the total still everyone", same(ids(l), [alexA, alexB]) && l.total === 5);
  l = await lib.listCustomers(db, { limit: 2, offset: 2 });
  ok("the next page carries on where it stopped", same(ids(l), [club, pat]) && l.total === 5);
  l = await lib.listCustomers(db, { limit: 2, offset: 4 });
  ok("the last page has what is left", same(ids(l), [quinn]) && l.total === 5);
  l = await lib.listCustomers(db, { limit: 2, offset: 50 });
  ok("a page past the end is empty, the total unchanged", same(l.customers, []) && l.total === 5);
  l = await lib.listCustomers(db, { limit: "2", offset: "1" });
  ok("the page size and the start may arrive as text", same(ids(l), [alexB, club]));
  l = await lib.listCustomers(db, { limit: 2.9, offset: 1.9 });
  ok("fractions are rounded down", same(ids(l), [alexB, club]));
  l = await lib.listCustomers(db, { limit: 2, offset: -4 });
  ok("a start before the beginning is the beginning", same(ids(l), [alexA, alexB]));
  l = await lib.listCustomers(db, { limit: -4 });
  ok("a page size below one is one", same(ids(l), [alexA]) && l.total === 5);
  l = await lib.listCustomers(db, { q: "example", limit: 1, offset: 1 });
  ok("paging and searching together: the second of the two matches, total two", same(ids(l), [pat]) && l.total === 2);
  l = await lib.listCustomers(db, { q: "example", includeArchived: true, limit: 1 });
  ok("the total counts every match with archived ones in, not just the page", l.customers.length === 1 && l.total === 3);

  // =====================================================================================================
  console.log("\n=== A customer's orders ===");
  await lib.setSalesTaxSettings(db, { rateBps: 800, jurisdiction: "", taxMode: "inclusive" });
  const cap = (qty, price) => ({ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty, unitPrice: price });
  const place = (orderId, placedAt, items, extra = {}, opts = {}) =>
    lib.insertOrder(db, Object.assign({ orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt }, extra), items, opts);
  // O1: two caps and a tee plus shipping; part paid, with a payment entered by mistake (voided) and a refund.
  await place("O1", "2026-01-10T15:00:00.000Z", [cap(2, 20), { productId: "tee", name: "Tee", type: "shirt", size: "M", qty: 1, unitPrice: 15 }], { shippingCost: 5 });
  await lib.addOrderPayment(db, "O1", 25, "deposit", "", { receivedAt: "2026-01-11T15:00:00.000Z" });
  const mistake = await lib.addOrderPayment(db, "O1", 10, "entered twice", "", { receivedAt: "2026-01-12T15:00:00.000Z" });
  await lib.voidPayment(db, mistake, "entered twice");
  await lib.addOrderPayment(db, "O1", -5, "refund", "", { kind: "refund", receivedAt: "2026-01-13T15:00:00.000Z" });
  // O2: tax added on top, a discount, and one of its two lines cancelled.
  await place("O2", "2026-02-10T15:00:00.000Z", [cap(5, 20), cap(1, 50)], { taxMode: "exclusive" });
  await lib.setOrderDiscount(db, "O2", 10, "thanks");
  db._raw.run("UPDATE order_items SET cancelDate = '2026-02-11' WHERE orderId = 'O2' AND unitPriceCents = 5000");
  // O3: paid more than it comes to. O6: placed at the very same moment, marked completed.
  await place("O3", "2026-03-10T15:00:00.000Z", [cap(1, 30)]);
  await lib.addOrderPayment(db, "O3", 40, "cash", "", { receivedAt: "2026-03-10T16:00:00.000Z" });
  await place("O6", "2026-03-10T15:00:00.000Z", [cap(1, 12)]);
  db._raw.run("UPDATE orders SET completedAt = '2026-03-20T00:00:00.000Z' WHERE orderId = 'O6'");
  // O4: voided, with a payment still on it. O5: a test order.
  await place("O4", "2026-04-10T15:00:00.000Z", [cap(1, 70)]);
  await lib.addOrderPayment(db, "O4", 20, "deposit", "", { receivedAt: "2026-04-10T16:00:00.000Z" });
  await lib.voidOrder(db, "O4", "placed twice");
  await place("O5", "2026-05-10T15:00:00.000Z", [cap(1, 80)], { isTest: true });
  // The club: only a voided order and a test order. An order of somebody else's, and one with no customer.
  await place("C1", "2026-04-01T15:00:00.000Z", [cap(1, 9)], { customerName: "Example Club", contact: "club@example.com" });
  await lib.voidOrder(db, "C1", "mistake");
  await place("C2", "2026-04-02T15:00:00.000Z", [cap(1, 9)], { customerName: "Example Club", contact: "club@example.com", isTest: true });
  await place("X1", "2026-06-01T15:00:00.000Z", [cap(1, 500)], { customerName: "Quinn", contact: "555-0177" }, { customerId: quinn });
  await place("N1", "2026-06-02T15:00:00.000Z", [cap(1, 900)], { customerName: "Walk In", contact: "555-0188" });
  const linked = (orderId) => db.q("SELECT customerId FROM orders WHERE orderId = ?", orderId)[0].customerId;
  ok("(the orders belong to who they should: six to pat, two to the club, one to Quinn, one to nobody)",
    ["O1", "O2", "O3", "O4", "O5", "O6"].every(o => linked(o) === pat) && linked("C1") === club && linked("C2") === club && linked("X1") === quinn && linked("N1") === null);

  let g = await lib.getCustomer(db, pat);
  ok("a customer answers with the customer, its orders and their totals", keys(g) === "customer,orders,totals");
  ok("the customer has exactly: id, name, company, email, phone, address, notes, the three exemption fields, Net 30 (allowNet30, termsDays), archived, createdAt, updatedAt",
    keys(g.customer) === "address,allowNet30,archived,company,createdAt,email,id,name,notes,phone,taxExempt,taxExemptCertificate,taxExemptExpires,termsDays,updatedAt");
  ok("…with its own details", g.customer.id === pat && g.customer.name === "pat Example" && g.customer.email === "pat@example.com" && g.customer.phone === "555-0100" && g.customer.address === null && g.customer.archived === false);
  ok("each order has exactly: orderId, orgId, placedAt, total, paidAmount, balanceDue, voided, isTest, completed",
    g.orders.length === 6 && g.orders.every(o => keys(o) === "balanceDue,completed,isTest,orderId,orgId,paidAmount,placedAt,total,voided"));
  ok("the orders are newest first; two placed at the same moment go by order number, highest first",
    same(g.orders.map(o => o.orderId), ["O5", "O4", "O6", "O3", "O2", "O1"]));
  const o = Object.fromEntries(g.orders.map(x => [x.orderId, x]));
  ok("an order says which shop it is in and when it was placed", o.O1.orgId === "acme" && o.O1.placedAt === "2026-01-10T15:00:00.000Z");
  ok("a voided order, a test order and a completed one are each marked — and only those",
    same(g.orders.filter(x => x.voided).map(x => x.orderId), ["O4"]) && same(g.orders.filter(x => x.isTest).map(x => x.orderId), ["O5"]) && same(g.orders.filter(x => x.completed).map(x => x.orderId), ["O6"]));
  ok("O1 comes to its lines plus shipping (60), of which 25 is paid and 35 still owed", o.O1.total === 60 && o.O1.paidAmount === 25 && o.O1.balanceDue === 35);
  ok("…so a voided payment and a refund are not money received", o.O1.paidAmount !== 35 && o.O1.paidAmount !== 20);
  ok("O2 comes to its one live line less the discount plus the tax on top (97.20), not what it was placed at",
    o.O2.total === 97.2 && o.O2.paidAmount === 0 && o.O2.balanceDue === 97.2 && db.q("SELECT totalCents FROM orders WHERE orderId = 'O2'")[0].totalCents !== 9720);
  ok("O3, paid more than it comes to, owes nothing (never less than nothing)", o.O3.total === 30 && o.O3.paidAmount === 40 && o.O3.balanceDue === 0);
  const readers = {};
  for (const id of ["O1", "O2", "O3", "O4", "O5", "O6"]) readers[id] = await lib.getOrderById(db, id);
  ok("every order's total is what the order itself reports as its total owed", g.orders.every(x => x.total === readers[x.orderId].effectiveTotal));
  ok("every order's paid amount is what the order itself reports as received", g.orders.every(x => x.paidAmount === readers[x.orderId].amountReceived));
  ok("every order's balance is what the order itself reports as its balance due", g.orders.every(x => x.balanceDue === readers[x.orderId].balanceDue));
  ok("(the order reader says each of these orders is this customer's)", Object.values(readers).every(x => x.customerId === pat));

  console.log("\n=== What a customer's orders add up to ===");
  ok("the totals are exactly: orderCount, totalSpent, balanceDue", keys(g.totals) === "balanceDue,orderCount,totalSpent");
  ok("the order count leaves out the voided order and the test order (4 of 6)", g.totals.orderCount === 4);
  ok("spent is what the four counted orders come to: 60 + 97.20 + 30 + 12 = 199.20", g.totals.totalSpent === 199.2);
  ok("…which is the sum of what those orders themselves report", Math.round(g.totals.totalSpent * 100) === ["O1", "O2", "O3", "O6"].reduce((s, id) => s + Math.round(readers[id].effectiveTotal * 100), 0));
  ok("balance due is what the four still owe: 35 + 97.20 + 0 + 12 = 144.20 (an overpaid order doesn't lower it)", g.totals.balanceDue === 144.2);
  ok("…which is the sum of the balances those orders themselves report", Math.round(g.totals.balanceDue * 100) === ["O1", "O2", "O3", "O6"].reduce((s, id) => s + Math.round(readers[id].balanceDue * 100), 0));
  ok("the voided order and the test order are still listed with their own amounts", o.O4.total === 70 && o.O4.paidAmount === 20 && o.O4.balanceDue === 50 && o.O5.total === 80 && o.O5.balanceDue === 80);

  g = await lib.getCustomer(db, club);
  ok("a customer with only a voided order and a test order: both listed, nothing counted, nothing spent, nothing owed",
    same(g.orders.map(x => x.orderId), ["C2", "C1"]) && same(g.totals, { orderCount: 0, totalSpent: 0, balanceDue: 0 }));
  g = await lib.getCustomer(db, alexA);
  ok("a customer with no orders: an empty list and totals of nothing", same(g.orders, []) && same(g.totals, { orderCount: 0, totalSpent: 0, balanceDue: 0 }) && g.customer.company === "Zed Works");
  g = await lib.getCustomer(db, quinn);
  ok("a customer only ever sees its own orders", same(g.orders.map(x => x.orderId), ["X1"]) && g.totals.orderCount === 1 && g.totals.totalSpent === 500);
  g = await lib.getCustomer(db, String(pat));
  ok("an id sent as text finds the customer", g !== null && g.customer.id === pat && g.orders.length === 6);
  g = await lib.getCustomer(db, morgan);
  ok("an archived customer can still be opened, marked archived", g !== null && g.customer.archived === true && g.customer.taxExempt === true && g.customer.taxExemptExpires === "2030-01-01");

  console.log("\n=== The list's order counts ===");
  l = await lib.listCustomers(db);
  ok("the list counts a customer's orders leaving out the voided and the test one (4)", rowOf(l, pat).orderCount === 4);
  ok("its last order is the newest counted one — not the later voided order or the still later test order", rowOf(l, pat).lastOrderAt === "2026-03-10T15:00:00.000Z");
  ok("a customer with only a voided and a test order shows no orders, and no last order (empty text, not null)", rowOf(l, club).orderCount === 0 && rowOf(l, club).lastOrderAt === "");
  ok("a customer's count is its own orders only", rowOf(l, quinn).orderCount === 1 && rowOf(l, quinn).lastOrderAt === "2026-06-01T15:00:00.000Z" && rowOf(l, alexA).orderCount === 0 && rowOf(l, alexB).orderCount === 0);
  l = await lib.listCustomers(db, { limit: 1, offset: 3 });
  ok("the counts are right on a later page too", same(ids(l), [pat]) && l.customers[0].orderCount === 4 && l.customers[0].lastOrderAt === "2026-03-10T15:00:00.000Z");
  ok("the list's count agrees with the customer's own totals", (await lib.getCustomer(db, pat)).totals.orderCount === l.customers[0].orderCount);

  console.log("\n=== Ids that aren't a customer, and ones that were merged away ===");
  ok("an id no customer has answers null", await lib.getCustomer(db, 99999) === null);
  for (const [bad, why] of [["abc", "a word"], [0, "zero"], [-1, "a negative number"], [1.5, "a fraction"], [null, "nothing"], ["", "empty text"], [undefined, "not given"]])
    ok("an id that is " + why + " answers null", await lib.getCustomer(db, bad) === null);
  g = await lib.getCustomer(db, dup);
  ok("the id of a customer merged into another answers with the one that was kept, and its orders", g !== null && g.customer.id === pat && g.customer.name === "pat Example" && g.orders.length === 6 && g.totals.orderCount === 4);
  const older = await add({ name: "Older Dup" }), oldest = await add({ name: "Oldest Dup" });
  db._raw.run("UPDATE customers SET mergedIntoId = ?, archivedAt = 't' WHERE id = ?", [dup, older]);
  db._raw.run("UPDATE customers SET mergedIntoId = ?, archivedAt = 't' WHERE id = ?", [older, oldest]);
  g = await lib.getCustomer(db, oldest);
  ok("…through a chain of merges, however long (three steps here)", g !== null && g.customer.id === pat && g.orders.length === 6);
  const loopA = await add({ name: "Loop A" }), loopB = await add({ name: "Loop B" });
  db._raw.run("UPDATE customers SET mergedIntoId = ? WHERE id = ?", [loopB, loopA]);
  db._raw.run("UPDATE customers SET mergedIntoId = ? WHERE id = ?", [loopA, loopB]);
  ok("two rows that point at each other (which should never be) answer null instead of going round for ever", await lib.getCustomer(db, loopA) === null);
  db._raw.run("UPDATE customers SET addressJson = '{not json' WHERE id = ?", [alexB]);
  ok("an address that can't be read is no address, not a failure", (await lib.getCustomer(db, alexB)).customer.address === null);
  db._raw.run("UPDATE customers SET addressJson = '\"1 Example Street\"' WHERE id = ?", [alexB]);
  ok("…and neither is one stored as plain text", (await lib.getCustomer(db, alexB)).customer.address === null);

  console.log("\n=== A customer with more than 500 orders ===");
  const many = await add({ name: "Very Regular" });
  const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString();
  for (let i = 0; i < 503; i++)
    await lib.insertOrder(db, { orderId: "M" + String(i).padStart(3, "0"), orgId: "acme", customerName: "Very Regular", contact: "555-0150", placedAt: day(i) }, [cap(1, 2)], { customerId: many });
  g = await lib.getCustomer(db, many);
  ok("at most 500 orders are listed, the newest ones", g.orders.length === 500 && g.orders[0].orderId === "M502" && g.orders[499].orderId === "M003");
  ok("…but the totals count all 503", g.totals.orderCount === 503 && g.totals.totalSpent === 1006 && g.totals.balanceDue === 1006);
  l = await lib.listCustomers(db, { q: "very regular" });
  ok("…and so does the list, with the newest as its last order", l.customers[0].orderCount === 503 && l.customers[0].lastOrderAt === day(502));

  console.log("\n=== A list longer than a page ===");
  const live = (await lib.listCustomers(db)).total;
  db._raw.run("BEGIN");
  for (let i = 0; i < 205; i++) db._raw.run("INSERT INTO customers (name, createdAt, updatedAt) VALUES (?, 't', 't')", ["Bulk " + String(i).padStart(3, "0")]);
  db._raw.run("COMMIT");
  l = await lib.listCustomers(db);
  ok("a page is 50 customers unless asked otherwise, the total everyone", l.customers.length === 50 && l.total === live + 205);
  l = await lib.listCustomers(db, { limit: 0 });
  ok("a page size of nothing is the usual 50", l.customers.length === 50);
  l = await lib.listCustomers(db, { limit: "lots" });
  ok("…and so is one that isn't a number", l.customers.length === 50);
  l = await lib.listCustomers(db, { limit: 200 });
  ok("200 may be asked for", l.customers.length === 200);
  l = await lib.listCustomers(db, { limit: 1000 });
  ok("more than 200 gets 200", l.customers.length === 200 && l.total === live + 205);
  l = await lib.listCustomers(db, { q: "bulk", limit: 1000, offset: 200 });
  ok("the rest are on the next page: the last five of the 205, in name order", same(l.customers.map(c => c.name), ["Bulk 200", "Bulk 201", "Bulk 202", "Bulk 203", "Bulk 204"]) && l.total === 205);

  console.log("\n=== A database failure that isn't a missing migration ===");
  const down = { prepare: () => { throw new Error("D1_ERROR: the database is not answering"); } };
  ok("the list passes it on (it is not shown as an empty list)", /not answering/.test(await thrown(() => lib.listCustomers(down))));
  ok("opening a customer passes it on (it is not shown as no such customer)", /not answering/.test(await thrown(() => lib.getCustomer(down, 1))));

  // =====================================================================================================
  console.log("\n=== On a database that hasn't had migrations/0108 yet ===");
  const old = await makeDb("0108");
  ok("(that database has no customers table and no customer on its orders)",
    old.q("SELECT count(*) AS n FROM sqlite_master WHERE name = 'customers'")[0].n === 0 && !old.q("PRAGMA table_info(orders)").some(c => c.name === "customerId"));
  ok("the list is empty, not an error", same(await lib.listCustomers(old), { customers: [], total: 0 }));
  ok("…searched, paged or with archived ones too", same(await lib.listCustomers(old, { q: "pat", includeArchived: true, limit: 10, offset: 5 }), { customers: [], total: 0 }));
  ok("there is no customer to open: null, not an error", await lib.getCustomer(old, 1) === null);
  ok("an id that was never an id is still just null", await lib.getCustomer(old, "abc") === null);
  ok("adding a customer fails saying the table is missing (the page turns that into its own message)", /no such table: customers/.test(await thrown(() => lib.saveCustomer(old, { name: "Pat Example", email: "pat@example.com" }))));
  ok("…and so does changing one", /no such table: customers/.test(await thrown(() => lib.saveCustomer(old, { id: 1, name: "Pat Example" }))));
  ok("a save refused for what was typed is refused the same as ever", (await lib.saveCustomer(old, {})).error === "Enter a name or a company." && (await lib.saveCustomer(old, { name: "Pat", email: "nope" })).error === "That doesn't look like an email address.");
  ok("archiving fails saying the table is missing", /no such table: customers/.test(await thrown(() => lib.setCustomerArchived(old, 1, true))));
  ok("…restoring too", /no such table: customers/.test(await thrown(() => lib.setCustomerArchived(old, 1, false))));
  ok("archiving an id that was never an id is refused before the database is asked", (await lib.setCustomerArchived(old, "abc", true)).error === NOT_FOUND);
  ok("merging fails saying the table is missing", /no such table: customers/.test(await thrown(() => lib.mergeCustomers(old, { fromId: 1, intoId: 2 }))));
  ok("an order has no customer to find or make: null, not an error", await lib.findOrCreateCustomerForOrder_(old, { name: "Pat Example", contact: "pat@example.com" }) === null);
  await lib.insertOrder(old, { orderId: "P1", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-01-10T15:00:00.000Z" }, [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
  await lib.insertOrder(old, { orderId: "P2", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-01-11T15:00:00.000Z" }, [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }], { customerId: 7 });
  ok("an order is still placed, by email or with a customer picked", old.q("SELECT count(*) AS n FROM orders")[0].n === 2);
  const p1 = await lib.getOrderById(old, "P1");
  ok("…and reads back with no customer", p1 !== null && p1.customerId === null && p1.effectiveTotal === 20);
  ok("linking an order to a customer fails saying the column is missing", /no such column: customerId/.test(await thrown(() => lib.setOrderCustomer(old, "P1", 1))));
  ok("…and nothing was added to that database along the way", old.q("SELECT count(*) AS n FROM sqlite_master WHERE name = 'customers'")[0].n === 0);
  ok("what counts as an email doesn't depend on the database", norm(" Pat@Example.com ") === "pat@example.com");
})().catch((e) => { console.error(e); process.exit(1); });
