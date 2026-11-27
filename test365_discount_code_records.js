// Discount codes (migrations/0115): the code records, db.js called directly.
//   normalizeDiscountCode_       trimmed, upper-case, 3–32 of A–Z 0–9 - _, else ""
//   generateDiscountCode_        the prefix (cleaned, at most 12) + 8 characters from the 32-letter alphabet with no 0/O/1/I
//   normalizeDiscountCodeInput_  every refusal and both ends of every range: percent 0.01–100 (two decimals), amount
//                                $0.01–$10,000 (whole cents), uses 1–100,000, an email forcing single use, the expiry
//                                date, the note's 200 characters, the active switch
//   saveDiscountCode             create (a made-up code, made again when taken; a typed one taken → duplicate), edit,
//                                the code's value / shop / who fixed once used (the same values sent again accepted),
//                                uses in all never below the uses, the UPDATE guarded against a use claimed meanwhile
//   listDiscountCodes            search, the shop filter (every-shop codes included), each status, paging and total, the
//                                label, the shop's name
//   getDiscountCode              its uses (released ones too), usesTotal, at most 500 listed
//   setDiscountCodeActive, deleteDiscountCode (refused once any use exists, a released one too)
// Real SQL (sql.js) + the real db.js, with db.js's clock and crypto.getRandomValues set here, so nothing depends on
// today's date or chance. Invented shops, codes and customers only.
process.env.TZ = "America/Los_Angeles";
const fs = require("fs");
const { ok, counts } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

const NOW = Date.parse("2027-06-15T12:00:00.000Z");
const TODAY = "2027-06-15";
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
// crypto.getRandomValues inside db.js: the queued bytes first, then real random ones.
const queued = [];
const fakeCrypto = {
  getRandomValues(arr) {
    for (let i = 0; i < arr.length; i++) arr[i] = queued.length ? queued.shift() : Math.floor(Math.random() * 256);
    return arr;
  },
  randomUUID: () => globalThis.crypto.randomUUID(),
  subtle: globalThis.crypto.subtle,
};

const lib = new Function("Date", "crypto", strip(read("functions/_lib/db.js")) +
  "\nreturn { normalizeDiscountCode_, generateDiscountCode_, normalizeDiscountCodeInput_, listDiscountCodes, getDiscountCode," +
  " saveDiscountCode, setDiscountCodeActive, deleteDiscountCode, DISCOUNT_CODE_MAX_USES };")(FakeDate, fakeCrypto);

const MIGRATIONS = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function makeDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of MIGRATIONS) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES
    ('club','club','Example Club','t','t'), ('band','band','Example Band','t','t');`);
  return d1;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const inAlphabet = (s) => [...s].every(ch => ALPHABET.includes(ch));
const LOCKED = "This code has been used — you can change its expiry, uses, note or switch it off.";
const NOT_FOUND = "That discount code wasn't found.";
const NOT_READY = "Discount codes need the latest database update. Apply the migrations, then try again.";
const USES_ERR = "Enter how many times the code can be used in all: a whole number from 1 to 100,000.";

// A use straight into the table (live, or released when releasedAt is given).
let useSeq = 0;
function addUse(d1, codeId, { orderId, email = "pat@example.com", cents = 100, usedAt, releasedAt = null } = {}) {
  useSeq++;
  d1.q("INSERT INTO discount_code_uses (codeId, orderId, email, amountCents, usedAt, releasedAt) VALUES (?, ?, ?, ?, ?, ?)",
    codeId, orderId || "U" + useSeq, email, cents, usedAt || "2027-06-0" + (1 + (useSeq % 9)) + "T00:00:00.000Z", releasedAt);
}
const codeRow = (d1, id) => d1.q("SELECT * FROM discount_codes WHERE id = ?", id)[0];

(async () => {
  // ---- normalizeDiscountCode_ -------------------------------------------------------------------------------------
  {
    const n = lib.normalizeDiscountCode_;
    ok("a code is trimmed and upper-cased", n("  save10 ") === "SAVE10");
    ok("letters, digits, - and _ are kept", n("Spring-Fair_2027") === "SPRING-FAIR_2027");
    ok("3 characters is long enough", n("abc") === "ABC");
    ok("2 characters is too short", n("ab") === "");
    ok("32 characters is allowed", n("A".repeat(32)) === "A".repeat(32));
    ok("33 characters is too long", n("A".repeat(33)) === "");
    ok("a space inside a code makes it no code", n("SAVE 10") === "");
    ok("an accented letter makes it no code", n("CAFÉ10") === "");
    ok("a percent sign makes it no code", n("10%OFF") === "");
    ok("null and undefined are no code", n(null) === "" && n(undefined) === "");
    ok("a number is read as its digits", n(12345) === "12345");
  }

  // ---- generateDiscountCode_ --------------------------------------------------------------------------------------
  {
    const g = lib.generateDiscountCode_;
    queued.push(0, 1, 2, 3, 4, 5, 6, 7);
    ok("bytes 0–7 make the first 8 letters of the alphabet", g() === "ABCDEFGH");
    queued.push(24, 25, 26, 27, 28, 29, 30, 31);
    ok("bytes 24–31 make the digits 2–9 (no 0 or 1)", g() === "23456789");
    queued.push(32, 255, 64, 95, 8, 13, 22, 200);
    ok("a byte is taken modulo 32 (32→A, 255→9, 64→A, 95→9, 8→J, 13→P, 22→Y, 200→J)", g() === "A9A9JPYJ");
    let all = "";
    for (let i = 0; i < 32; i += 8) { queued.push(...Array.from({ length: 8 }, (_, j) => i + j)); all += g(); }
    ok("the 32 characters are exactly A–Z without I and O, then 2–9", all === ALPHABET && !/[01IO]/.test(all));
    const many = Array.from({ length: 300 }, () => g());
    ok("random codes are 8 characters from the alphabet", many.every(c => c.length === 8 && inAlphabet(c)));
    ok("random codes differ", new Set(many).size > 290);
    ok("a random code is a valid code", many.every(c => lib.normalizeDiscountCode_(c) === c));
    queued.push(0, 0, 0, 0, 0, 0, 0, 0);
    ok("the prefix is trimmed, upper-cased and cleaned of anything but A–Z 0–9 - _", g("  club 2027! ") === "CLUB2027AAAAAAAA");
    const long = g("abcdefghijklmnopqrstuvwxyz");
    ok("a prefix is cut to 12 characters, so the code is at most 20", long.startsWith("ABCDEFGHIJKL") && long.length === 20 && inAlphabet(long.slice(12)));
    ok("a prefix of - and _ is kept", g("fall_sale-").startsWith("FALL_SALE-"));
    ok("a null prefix makes a plain 8-character code", g(null).length === 8);
    ok("a prefix of nothing usable makes a plain 8-character code", g("!!! ").length === 8);
  }

  // ---- normalizeDiscountCodeInput_ --------------------------------------------------------------------------------
  {
    const n = lib.normalizeDiscountCodeInput_;
    const base = { kind: "percent", percent: 10, maxUses: 5 };
    const err = (over) => n({ ...base, ...over }).error;
    const val = (over) => n({ ...base, ...over }).value;
    ok("not an object: asked to choose percent or amount", n(null).error === "Choose percent off or an amount off." && n("x").error === "Choose percent off or an amount off.");
    ok("no kind: asked to choose percent or amount", err({ kind: undefined }) === "Choose percent off or an amount off.");
    ok("an unknown kind: asked to choose", err({ kind: "free" }) === "Choose percent off or an amount off.");
    ok("a code that isn't 3–32 letters, digits, - or _ is refused", err({ code: "save 10" }) === "A code is 3 to 32 letters, digits, - or _ (no spaces)."
      && err({ code: "ab" }) === "A code is 3 to 32 letters, digits, - or _ (no spaces).");
    ok("a typed code is upper-cased and trimmed", val({ code: " save10 " }).code === "SAVE10");
    ok("a blank code (or only spaces) is left blank to be made up", val({ code: "" }).code === "" && val({ code: "   " }).code === "" && val({}).code === "");
    // percent
    for (const bad of ["", null, undefined, true, false, "ten", NaN, Infinity]) {
      ok(`percent ${JSON.stringify(String(bad))} asks for the percent`, err({ percent: bad }) === "Enter the percent off.");
    }
    ok("percent 0.01 is 1 basis point", val({ percent: 0.01 }).percentBps === 1);
    ok("percent 100 is 10000 basis points", val({ percent: 100 }).percentBps === 10000);
    ok("percent 12.5 is 1250 basis points", val({ percent: 12.5 }).percentBps === 1250);
    ok("percent \"15\" as text is 1500 basis points", val({ percent: "15" }).percentBps === 1500);
    ok("percent 0.29 (floating point 28.999…) is 29 basis points", val({ percent: 0.29 }).percentBps === 29);
    ok("percent 0 is out of range", err({ percent: 0 }) === "The percent off must be from 0.01 to 100.");
    ok("percent 100.01 is out of range", err({ percent: 100.01 }) === "The percent off must be from 0.01 to 100.");
    ok("percent -5 is out of range", err({ percent: -5 }) === "The percent off must be from 0.01 to 100.");
    ok("percent 0.001 has too many decimals", err({ percent: 0.001 }) === "The percent off can have at most two decimals.");
    ok("percent 10.555 has too many decimals", err({ percent: 10.555 }) === "The percent off can have at most two decimals.");
    ok("a percent code has no amount", val({ percent: 10, amount: 5 }).amountCents === null && val({}).kind === "percent");
    // amount
    const a = { kind: "amount", percent: undefined };
    for (const bad of ["", null, undefined, true, "five", NaN, -Infinity]) {
      ok(`amount ${JSON.stringify(String(bad))} asks for the amount`, err({ ...a, amount: bad }) === "Enter the amount off.");
    }
    ok("amount $0.01 is 1 cent", val({ ...a, amount: 0.01 }).amountCents === 1);
    ok("amount $10,000 is 1000000 cents", val({ ...a, amount: 10000 }).amountCents === 1000000);
    ok("amount \"4.10\" as text is 410 cents", val({ ...a, amount: "4.10" }).amountCents === 410);
    ok("amount $0 is out of range", err({ ...a, amount: 0 }) === "The amount off must be from $0.01 to $10,000.");
    ok("amount $10,000.01 is out of range", err({ ...a, amount: 10000.01 }) === "The amount off must be from $0.01 to $10,000.");
    ok("amount -$1 is out of range", err({ ...a, amount: -1 }) === "The amount off must be from $0.01 to $10,000.");
    ok("amount $0.005 is a fraction of a cent", err({ ...a, amount: 0.005 }) === "The amount off can't have fractions of a cent.");
    ok("amount $1.234 is a fraction of a cent", err({ ...a, amount: 1.234 }) === "The amount off can't have fractions of a cent.");
    ok("an amount code has no percent", val({ ...a, amount: 5, percent: 10 }).percentBps === null && val({ ...a, amount: 5 }).kind === "amount");
    // shop
    ok("no shop or an empty one is every shop (null)", val({}).orgId === null && val({ orgId: "" }).orgId === null && val({ orgId: null }).orgId === null);
    ok("a shop id is kept, cut to 100 characters", val({ orgId: "club" }).orgId === "club" && val({ orgId: "x".repeat(150) }).orgId.length === 100);
    // email
    const e = val({ email: "  Pat@Example.COM ", maxUses: 50, oncePerEmail: true });
    ok("an email is trimmed and lower-cased", e.email === "pat@example.com");
    ok("an email makes the code single use whatever uses were sent", e.maxUses === 1);
    ok("an email turns once-per-email off (it is one use anyway)", e.oncePerEmail === 0);
    ok("an email code needs no uses at all", !!val({ email: "pat@example.com", maxUses: undefined }) && val({ email: "pat@example.com", maxUses: "" }).maxUses === 1);
    ok("a bad email is refused", err({ email: "pat@example" }) === "That email address doesn't look right." && err({ email: "pat example.com" }) === "That email address doesn't look right.");
    ok("a blank email (only spaces) is anyone", val({ email: "   " }).email === "" && val({ email: "   " }).maxUses === 5);
    // uses
    for (const bad of [undefined, null, "", true, 0, -1, 1.5, "2.5", 100001, "lots", NaN]) {
      ok(`uses ${JSON.stringify(String(bad))} are refused for a code for anyone`, err({ maxUses: bad }) === USES_ERR);
    }
    ok("1 use in all is allowed", val({ maxUses: 1 }).maxUses === 1);
    ok("100,000 uses in all is allowed", val({ maxUses: 100000 }).maxUses === 100000 && lib.DISCOUNT_CODE_MAX_USES === 100000);
    ok("uses as text \"25\" are 25", val({ maxUses: "25" }).maxUses === 25);
    for (const on of [true, 1, "1", "true"]) ok(`once per email ${JSON.stringify(on)} is on`, val({ oncePerEmail: on }).oncePerEmail === 1);
    for (const off of [false, 0, "0", "yes", undefined, null]) ok(`once per email ${String(off)} is off`, val({ oncePerEmail: off }).oncePerEmail === 0);
    // expiry
    ok("no expiry is null", val({}).expiresOn === null && val({ expiresOn: "" }).expiresOn === null && val({ expiresOn: null }).expiresOn === null && val({ expiresOn: "  " }).expiresOn === null);
    ok("an expiry YYYY-MM-DD is kept, trimmed", val({ expiresOn: " 2027-02-28 " }).expiresOn === "2027-02-28");
    ok("a leap day in a leap year is a date", val({ expiresOn: "2028-02-29" }).expiresOn === "2028-02-29");
    for (const bad of ["2027-02-30", "2027-02-29", "2027-13-01", "2027-2-3", "06/30/2027", "tomorrow", "2027-06-30T00:00"]) {
      ok(`expiry ${bad} isn't a date`, err({ expiresOn: bad }) === "The expiry date isn't a date.");
    }
    // note
    ok("a note of 200 characters is kept", val({ note: "n".repeat(200) }).note.length === 200);
    ok("a note of 201 characters is refused", err({ note: "n".repeat(201) }) === "The note can be at most 200 characters.");
    ok("a note is trimmed (200 after trimming is fine)", val({ note: "  " + "n".repeat(200) + "  " }).note.length === 200 && val({ note: " Spring fair " }).note === "Spring fair");
    ok("no note is \"\"", val({}).note === "" && val({ note: null }).note === "");
    // active
    ok("active left out (or null) is undefined: unchanged on an edit", val({}).active === undefined && val({ active: null }).active === undefined);
    ok("active false, 0, \"0\", \"false\" are off", [false, 0, "0", "false"].every(x => val({ active: x }).active === false));
    ok("active true, 1, \"1\" are on", [true, 1, "1"].every(x => val({ active: x }).active === true));
    ok("the value is exactly the stored shape", same(val({ code: "save10", note: "x", expiresOn: "2027-07-01", orgId: "club" }),
      { code: "SAVE10", kind: "percent", percentBps: 1000, amountCents: null, maxDiscountCents: null, orgId: "club", email: "", maxUses: 5, oncePerEmail: 0, expiresOn: "2027-07-01", note: "x", active: undefined }));
  }

  // ---- saveDiscountCode: create ------------------------------------------------------------------------------------
  {
    const d1 = await makeDb();
    const opts = { actor: "owner@example.com", now: "2027-06-15T10:00:00.000Z", today: TODAY };
    const r = await lib.saveDiscountCode(d1, { code: " save10 ", kind: "percent", percent: 10, maxUses: 50, note: "Spring fair" }, opts);
    const c = r.code;
    ok("a new code is saved upper-case", c && c.code === "SAVE10" && codeRow(d1, c.id).code === "SAVE10");
    ok("a new code answers the reader's shape", same(Object.keys(c).sort(), ["active", "amount", "code", "createdAt", "createdBy", "email", "expiresOn", "id", "kind",
      "label", "maxDiscount", "maxUses", "note", "oncePerEmail", "orgId", "orgName", "percent", "status", "used", "uses", "usesTotal"].sort()));
    ok("a new code: 10% off, every shop, anyone, 50 uses, none used, active", c.percent === 10 && c.amount === null && c.label === "10% off"
      && c.orgId === null && c.orgName === "" && c.email === "" && c.maxUses === 50 && c.used === 0 && c.active === true && c.status === "active");
    ok("a new code records who and when", c.createdBy === "owner@example.com" && c.createdAt === "2027-06-15T10:00:00.000Z");
    ok("a new code has no uses yet", same(c.uses, []) && c.usesTotal === 0);
    ok("a create answers no 'before'", r.before === undefined);
    const dup = await lib.saveDiscountCode(d1, { code: "Save10", kind: "amount", amount: 5, maxUses: 1 }, opts);
    ok("a typed code already taken is refused as a duplicate", dup.duplicate === true && dup.error === "The code SAVE10 is already taken. Choose another." && !dup.code);
    ok("the duplicate left one row", d1.q("SELECT count(*) AS n FROM discount_codes")[0].n === 1);
    const off = await lib.saveDiscountCode(d1, { code: "LATER", kind: "amount", amount: 5, maxUses: 1, active: false }, opts);
    ok("a new code saved switched off is off", off.code.active === false && off.code.status === "off" && codeRow(d1, off.code.id).active === 0);
    const shop = await lib.saveDiscountCode(d1, { code: "CLUBONLY", kind: "amount", amount: 1234.5, orgId: "club", email: "Sam@Example.com" }, opts);
    ok("a code for one shop names the shop", shop.code.orgId === "club" && shop.code.orgName === "Example Club");
    ok("a code for one person is single use, lower-case email", shop.code.email === "sam@example.com" && shop.code.maxUses === 1 && shop.code.oncePerEmail === false);
    ok("an amount code's label is dollars with a thousands comma", shop.code.label === "$1,234.50 off" && shop.code.amount === 1234.5);
    const noShop = await lib.saveDiscountCode(d1, { code: "NOWHERE", kind: "percent", percent: 5, maxUses: 1, orgId: "gone" }, opts);
    ok("a shop that doesn't exist is refused", noShop.error === "That shop wasn't found." && !codeRow(d1, 99));
    ok("a bad input is refused with its reason, nothing written", (await lib.saveDiscountCode(d1, { kind: "percent", percent: 0, maxUses: 1 }, opts)).error === "The percent off must be from 0.01 to 100."
      && d1.q("SELECT count(*) AS n FROM discount_codes")[0].n === 3);
    ok("an id of 0 is a create", !!(await lib.saveDiscountCode(d1, { id: 0, code: "ZEROID", kind: "percent", percent: 5, maxUses: 1 }, opts)).code);
    ok("an empty id is a create", !!(await lib.saveDiscountCode(d1, { id: "", code: "EMPTYID", kind: "percent", percent: 5, maxUses: 1 }, opts)).code);
    const made = await lib.saveDiscountCode(d1, { kind: "percent", percent: 5, maxUses: 3 }, opts);
    ok("a blank code is made up: 8 characters from the alphabet", made.code && made.code.code.length === 8 && inAlphabet(made.code.code));
    // A made-up code that is taken is made again.
    await lib.saveDiscountCode(d1, { code: "AAAAAAAA", kind: "percent", percent: 5, maxUses: 1 }, opts);
    queued.length = 0; queued.push(0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1);
    const again = await lib.saveDiscountCode(d1, { kind: "percent", percent: 5, maxUses: 1 }, opts);
    ok("a made-up code already taken is made again", again.code && again.code.code === "BBBBBBBB" && queued.length === 0);
    queued.length = 0; queued.push(...new Array(40).fill(0));
    const stuck = await lib.saveDiscountCode(d1, { kind: "percent", percent: 5, maxUses: 1 }, opts);
    ok("five made-up codes all taken: asked to try again", stuck.error === "Couldn't make a code that isn't taken. Try again." && !stuck.duplicate && queued.length === 0);
    queued.length = 0;
    const defaults = await lib.saveDiscountCode(d1, { code: "NOACTOR", kind: "percent", percent: 5, maxUses: 1 });
    ok("without an actor createdBy is \"\" and createdAt is now", defaults.code.createdBy === "" && defaults.code.createdAt === "2027-06-15T12:00:00.000Z");
    // A database error that isn't about the code is passed on.
    const broken = { prepare: (sql) => { const s = d1.prepare(sql); return /^INSERT INTO discount_codes/.test(sql) ? { bind: () => ({ run: async () => { throw new Error("disk I/O error"); } }) } : s; } };
    let threw = "";
    try { await lib.saveDiscountCode(broken, { code: "IOERR", kind: "percent", percent: 5, maxUses: 1 }, opts); } catch (e2) { threw = e2.message; }
    ok("a database error on the insert is passed on", threw === "disk I/O error");
  }

  // ---- saveDiscountCode: edit --------------------------------------------------------------------------------------
  {
    const d1 = await makeDb();
    const opts = { actor: "owner@example.com", now: "2027-06-15T10:00:00.000Z", today: TODAY };
    const mk = async (input) => (await lib.saveDiscountCode(d1, input, opts)).code;
    const a = await mk({ code: "SAVE10", kind: "percent", percent: 10, maxUses: 5, note: "first" });
    for (const bad of ["abc", -1, 0.5, 1e20, "1x"]) {
      const before = d1.q("SELECT count(*) AS n FROM discount_codes")[0].n;
      ok(`edit id ${bad} is not found (and makes no new code)`, (await lib.saveDiscountCode(d1, { id: bad, kind: "percent", percent: 10, maxUses: 5 }, opts)).error === NOT_FOUND
        && d1.q("SELECT count(*) AS n FROM discount_codes")[0].n === before);
    }
    ok("edit of a code that isn't there is not found", (await lib.saveDiscountCode(d1, { id: 999, kind: "percent", percent: 10, maxUses: 5 }, opts)).error === NOT_FOUND);
    // Unused: everything can change.
    const e1 = await lib.saveDiscountCode(d1, { id: a.id, code: "fall5", kind: "amount", amount: 5, orgId: "band", email: "pat@example.com", expiresOn: "2027-07-01", note: "changed" }, opts);
    ok("an unused code's code, kind, value, shop and who all change", e1.code.code === "FALL5" && e1.code.kind === "amount" && e1.code.amount === 5 && e1.code.percent === null
      && e1.code.orgId === "band" && e1.code.orgName === "Example Band" && e1.code.email === "pat@example.com" && e1.code.maxUses === 1);
    ok("the row was changed in place (same id), percentBps cleared", codeRow(d1, a.id).code === "FALL5" && codeRow(d1, a.id).percentBps === null && codeRow(d1, a.id).amountCents === 500);
    ok("an edit answers the code before it", e1.before && e1.before.code === "SAVE10" && e1.before.percent === 10 && e1.before.note === "first");
    ok("the expiry and the note change", e1.code.expiresOn === "2027-07-01" && e1.code.note === "changed");
    ok("an edit keeps who made it", e1.code.createdBy === "owner@example.com" && e1.code.createdAt === "2027-06-15T10:00:00.000Z");
    const keep = await lib.saveDiscountCode(d1, { id: a.id, code: "", kind: "amount", amount: 5, orgId: "band", email: "pat@example.com" }, opts);
    ok("a blank code on an edit keeps the code", keep.code.code === "FALL5");
    ok("an edit can clear the expiry", keep.code.expiresOn === null);
    await lib.setDiscountCodeActive(d1, a.id, false);
    const still = await lib.saveDiscountCode(d1, { id: a.id, kind: "amount", amount: 5, orgId: "band", email: "pat@example.com" }, opts);
    ok("active left out of an edit keeps it switched off", still.code.active === false);
    const on = await lib.saveDiscountCode(d1, { id: String(a.id), kind: "amount", amount: 5, orgId: "band", email: "pat@example.com", active: true }, opts);
    ok("active true on an edit (id as text) switches it on", on.code.active === true && codeRow(d1, a.id).active === 1);
    const back = await lib.saveDiscountCode(d1, { id: a.id, kind: "percent", percent: 10, maxUses: 5, oncePerEmail: true }, opts);
    ok("an unused code goes back to anyone, percent, every shop, once per email", back.code.email === "" && back.code.percent === 10 && back.code.orgId === null
      && back.code.maxUses === 5 && back.code.oncePerEmail === true);
    const b = await mk({ code: "OTHER", kind: "percent", percent: 5, maxUses: 1 });
    const dupEdit = await lib.saveDiscountCode(d1, { id: b.id, code: "fall5", kind: "percent", percent: 5, maxUses: 1 }, opts);
    ok("renaming to a code that's taken is a duplicate", dupEdit.duplicate === true && dupEdit.error === "The code FALL5 is already taken. Choose another." && codeRow(d1, b.id).code === "OTHER");
    ok("an edit to a shop that doesn't exist is refused", (await lib.saveDiscountCode(d1, { id: b.id, kind: "percent", percent: 5, maxUses: 1, orgId: "gone" }, opts)).error === "That shop wasn't found.");
    ok("an edit with a bad input is refused with its reason", (await lib.saveDiscountCode(d1, { id: b.id, kind: "percent", percent: 5, maxUses: 0 }, opts)).error === USES_ERR);

    // Used: the fixed parts are locked.
    const u = await mk({ code: "USED", kind: "percent", percent: 12.5, maxUses: 10, orgId: "club", oncePerEmail: true, expiresOn: "2027-07-01", note: "n" });
    addUse(d1, u.id); addUse(d1, u.id); addUse(d1, u.id, { email: "sam@example.com" });
    const same0 = { id: u.id, code: "USED", kind: "percent", percent: 12.5, maxUses: 10, orgId: "club", oncePerEmail: true };
    const tries = [
      ["its code", { code: "USED2" }], ["its kind", { kind: "amount", amount: 12.5 }], ["its percent", { percent: 12 }],
      ["its shop", { orgId: "band" }], ["its shop to every shop", { orgId: "" }], ["who can use it (an email)", { email: "pat@example.com" }],
      ["once per email", { oncePerEmail: false }],
    ];
    for (const [what, over] of tries) {
      const r = await lib.saveDiscountCode(d1, { ...same0, ...over }, opts);
      ok(`once used, ${what} can't change`, r.error === LOCKED && !r.code);
    }
    ok("the locked edits changed nothing", (() => { const row = codeRow(d1, u.id); return row.code === "USED" && row.percentBps === 1250 && row.orgId === "club" && row.oncePerEmail === 1 && row.email === ""; })());
    const okEdit = await lib.saveDiscountCode(d1, { ...same0, code: " used ", expiresOn: "2027-12-31", maxUses: 20, note: "more", active: false }, opts);
    ok("once used, the same code / value / shop / who sent again with a new expiry, uses, note and switch is accepted",
      okEdit.code && okEdit.code.expiresOn === "2027-12-31" && okEdit.code.maxUses === 20 && okEdit.code.note === "more" && okEdit.code.active === false && okEdit.code.used === 3);
    ok("once used, a blank code sent with the same value is accepted", !!(await lib.saveDiscountCode(d1, { ...same0, code: "", maxUses: 20 }, opts)).code);
    ok("once used, the percent sent as text \"12.50\" is the same value", !!(await lib.saveDiscountCode(d1, { ...same0, percent: "12.50", maxUses: 20 }, opts)).code);
    let updates = 0;
    const spy = { prepare: (sql) => { if (/^UPDATE discount_codes SET code=/.test(sql)) updates++; return d1.prepare(sql); } };
    const below = await lib.saveDiscountCode(spy, { ...same0, maxUses: 2 }, opts);
    ok("uses in all below the uses is refused before any write", updates === 0);
    ok("uses in all can't go below the uses it has", !!below.error && below.error === "This code has been used 3 times, so it needs at least 3 uses in all." && codeRow(d1, u.id).maxUses === 20);
    ok("uses in all equal to the uses it has is accepted (used up)", (await lib.saveDiscountCode(d1, { ...same0, maxUses: 3, active: true }, opts)).code.status === "usedUp");
    // An email code, used: the same address sent again (in another case, once-per-email ticked) is no change.
    const p = await mk({ code: "PATONLY", kind: "amount", amount: 5, email: "pat@example.com" });
    addUse(d1, p.id);
    const pr = await lib.saveDiscountCode(d1, { id: p.id, code: "PATONLY", kind: "amount", amount: 5, email: "PAT@example.com", oncePerEmail: true, maxUses: 99, note: "sent" }, opts);
    ok("once used, an email code re-sent with the same address (any case) is accepted, still single use", pr.code && pr.code.note === "sent" && pr.code.maxUses === 1);
    ok("once used, an email code can't become a code for anyone", (await lib.saveDiscountCode(d1, { id: p.id, kind: "amount", amount: 5, maxUses: 5 }, opts)).error === LOCKED);
    ok("once used, an amount code's amount can't change", (await lib.saveDiscountCode(d1, { id: p.id, kind: "amount", amount: 6, email: "pat@example.com" }, opts)).error === LOCKED);
    // Only released uses: not used, so it can change again.
    const rel = await mk({ code: "GIVENBACK", kind: "percent", percent: 10, maxUses: 1 });
    addUse(d1, rel.id, { releasedAt: "2027-06-10T00:00:00.000Z" });
    const relEdit = await lib.saveDiscountCode(d1, { id: rel.id, code: "GIVENBACK", kind: "percent", percent: 20, maxUses: 1 }, opts);
    ok("a code whose only use was given back can change its value", relEdit.code && relEdit.code.percent === 20 && relEdit.code.used === 0);

    // The guarded UPDATE: a use claimed between the read and the write.
    const racing = (onUpdate) => ({
      prepare(sql) {
        const s = d1.prepare(sql);
        if (!/^UPDATE discount_codes SET code=/.test(sql)) return s;
        return { bind: (...args) => { const bound = s.bind(...args); return { run: async () => { onUpdate(); return bound.run(); } }; } };
      },
    });
    const g = await mk({ code: "RACE", kind: "percent", percent: 10, maxUses: 5 });
    const raced = await lib.saveDiscountCode(racing(() => addUse(d1, g.id)), { id: g.id, code: "RACE", kind: "percent", percent: 50, maxUses: 5 }, opts);
    ok("a use claimed just before a value change: the change is refused as locked", raced.error === LOCKED);
    ok("…and the value is unchanged", codeRow(d1, g.id).percentBps === 1000);
    const g2 = await mk({ code: "RACE2", kind: "percent", percent: 10, maxUses: 5 });
    const raced2 = await lib.saveDiscountCode(racing(() => { addUse(d1, g2.id); addUse(d1, g2.id); }), { id: g2.id, code: "RACE2", kind: "percent", percent: 10, maxUses: 1 }, opts);
    ok("uses claimed just before lowering the uses in all: refused with the uses as they are now", raced2.error === "This code has been used 2 times, so it needs at least 2 uses in all.");
    ok("…and the uses in all are unchanged", codeRow(d1, g2.id).maxUses === 5);
    const g3 = await mk({ code: "RACE3", kind: "percent", percent: 10, maxUses: 5 });
    const raced3 = await lib.saveDiscountCode(racing(() => d1.q("DELETE FROM discount_codes WHERE id = ?", g3.id)), { id: g3.id, code: "RACE3", kind: "percent", percent: 10, maxUses: 4 }, opts);
    ok("a code deleted just before the change: not found", raced3.error === NOT_FOUND);
    const g4 = await mk({ code: "RACE4", kind: "percent", percent: 10, maxUses: 5 });
    const raced4 = await lib.saveDiscountCode(racing(() => {}), { id: g4.id, code: "RACE4", kind: "percent", percent: 10, maxUses: 4, note: "fine" }, opts);
    ok("with nothing claimed meanwhile the guarded change goes through", raced4.code && raced4.code.maxUses === 4 && raced4.code.note === "fine");
    let threw = "";
    const brokenUpd = { prepare: (sql) => /^UPDATE discount_codes SET code=/.test(sql) ? { bind: () => ({ run: async () => { throw new Error("disk I/O error"); } }) } : d1.prepare(sql) };
    try { await lib.saveDiscountCode(brokenUpd, { id: g4.id, kind: "percent", percent: 10, maxUses: 4 }, opts); } catch (e) { threw = e.message; }
    ok("a database error on the update is passed on", threw === "disk I/O error");
  }

  // ---- listDiscountCodes ------------------------------------------------------------------------------------------
  {
    const d1 = await makeDb();
    let t = 0;
    const mk = async (input, extra) => {
      t++;
      const c = (await lib.saveDiscountCode(d1, input, { actor: "owner@example.com", now: `2027-06-0${t}T00:00:00.000Z`, today: TODAY })).code;
      if (extra) extra(c);
      return c;
    };
    const any = await mk({ code: "ANYONE10", kind: "percent", percent: 10, maxUses: 50 }, (c) => {
      addUse(d1, c.id); addUse(d1, c.id); addUse(d1, c.id); addUse(d1, c.id, { releasedAt: "2027-06-05T00:00:00.000Z" });
    });
    const club5 = await mk({ code: "CLUB5", kind: "amount", amount: 5, orgId: "club", email: "pat@example.com" }, (c) => addUse(d1, c.id));
    const old = await mk({ code: "OLDCODE", kind: "percent", percent: 12.5, orgId: "band", maxUses: 9, expiresOn: "2027-03-01" });
    const offc = await mk({ code: "OFFCODE", kind: "amount", amount: 1234.5, orgId: "club", maxUses: 9, expiresOn: "2027-03-01", active: false });
    const todayc = await mk({ code: "LASTDAY", kind: "percent", percent: 0.01, maxUses: 9, expiresOn: TODAY });
    const fair = await mk({ code: "FAIR", kind: "percent", percent: 100, orgId: "band", maxUses: 2, oncePerEmail: true, note: "Spring Fair handout" });
    const both = await mk({ code: "BOTH", kind: "amount", amount: 10000, maxUses: 1, expiresOn: "2027-06-14" }, (c) => addUse(d1, c.id));
    const ids = (r) => r.codes.map(c => c.code).join(",");
    const all = await lib.listDiscountCodes(d1, { today: TODAY });
    ok("all codes, newest first", ids(all) === "BOTH,FAIR,LASTDAY,OFFCODE,OLDCODE,CLUB5,ANYONE10" && all.total === 7);
    const by = Object.fromEntries(all.codes.map(c => [c.code, c]));
    ok("uses count only the ones not given back", by.ANYONE10.used === 3 && by.CLUB5.used === 1 && by.FAIR.used === 0);
    ok("statuses: active, used up, expired, off", by.ANYONE10.status === "active" && by.CLUB5.status === "usedUp" && by.OLDCODE.status === "expired" && by.OFFCODE.status === "off");
    ok("a code expiring today still works today", by.LASTDAY.status === "active");
    ok("expired wins over used up; off wins over expired", by.BOTH.status === "expired" && by.OFFCODE.status === "off");
    ok("labels: 10% off, 12.5% off, 0.01% off, 100% off", by.ANYONE10.label === "10% off" && by.OLDCODE.label === "12.5% off" && by.LASTDAY.label === "0.01% off" && by.FAIR.label === "100% off");
    ok("labels: $5.00 off, $1,234.50 off, $10,000.00 off", by.CLUB5.label === "$5.00 off" && by.OFFCODE.label === "$1,234.50 off" && by.BOTH.label === "$10,000.00 off");
    ok("percent and amount in their units", by.OLDCODE.percent === 12.5 && by.OLDCODE.amount === null && by.OFFCODE.amount === 1234.5 && by.OFFCODE.percent === null);
    ok("the shop's name, or \"\" for every shop", by.CLUB5.orgName === "Example Club" && by.FAIR.orgName === "Example Band" && by.ANYONE10.orgName === "" && by.ANYONE10.orgId === null);
    ok("each code has the reader's shape (no uses list)", same(Object.keys(by.FAIR).sort(), ["active", "amount", "code", "createdAt", "createdBy", "email", "expiresOn", "id", "kind",
      "label", "maxDiscount", "maxUses", "note", "oncePerEmail", "orgId", "orgName", "percent", "status", "used"]));
    ok("the reader's values for a code for anyone, once per email", by.FAIR.email === "" && by.FAIR.maxUses === 2 && by.FAIR.oncePerEmail === true && by.FAIR.note === "Spring Fair handout"
      && by.FAIR.expiresOn === null && by.FAIR.active === true && by.FAIR.createdBy === "owner@example.com" && by.FAIR.id === fair.id);
    const st = async (s, extra = {}) => ids(await lib.listDiscountCodes(d1, { status: s, today: TODAY, ...extra }));
    ok("status active: on, not expired, uses left", await st("active") === "FAIR,LASTDAY,ANYONE10");
    ok("status off: switched off, expired or not", await st("off") === "OFFCODE");
    ok("status expired: on and past its expiry (used up too)", await st("expired") === "BOTH,OLDCODE");
    ok("status usedUp: on, not expired, no uses left", await st("usedUp") === "CLUB5");
    ok("status all, and an empty status, list every code", await st("all") === ids(all) && await st("") === ids(all));
    const weird = await lib.listDiscountCodes(d1, { status: "weird", today: TODAY });
    ok("an unknown status lists nothing", weird.codes.length === 0 && weird.total === 0);
    ok("each status's total is its count", (await lib.listDiscountCodes(d1, { status: "active", today: TODAY })).total === 3
      && (await lib.listDiscountCodes(d1, { status: "expired", today: TODAY })).total === 2);
    ok("a day later LASTDAY is expired", (await st("expired", { today: "2027-06-16" })).includes("LASTDAY") && !(await st("active", { today: "2027-06-16" })).includes("LASTDAY"));
    ok("before its expiry OLDCODE is active", (await st("active", { today: "2027-03-01" })).includes("OLDCODE"));
    ok("no today (or a bad one) is the business's today", await st("expired", { today: "" }) === "BOTH,OLDCODE" && await st("expired", { today: "June 15" }) === "BOTH,OLDCODE"
      && (await lib.listDiscountCodes(d1, {})).codes.find(c => c.code === "LASTDAY").status === "active");
    ok("the shop filter: that shop's codes and every-shop codes", await st("all", { orgId: "club" }) === "BOTH,LASTDAY,OFFCODE,CLUB5,ANYONE10");
    ok("the shop filter: band", await st("all", { orgId: "band" }) === "BOTH,FAIR,LASTDAY,OLDCODE,ANYONE10");
    ok("the shop filter with a status", await st("active", { orgId: "club" }) === "LASTDAY,ANYONE10");
    ok("the shop filter's total", (await lib.listDiscountCodes(d1, { orgId: "club", today: TODAY })).total === 5);
    ok("search matches the code, any case", await st("all", { q: "club5" }) === "CLUB5" && await st("all", { q: "  OLD " }) === "OLDCODE");
    ok("search matches the email", await st("all", { q: "PAT@" }) === "CLUB5");
    ok("search matches the note", await st("all", { q: "spring fair" }) === "FAIR");
    ok("search matches part of a code across codes", await st("all", { q: "code" }) === "OFFCODE,OLDCODE");
    ok("search text is not a LIKE pattern", await st("all", { q: "%" }) === "" && await st("all", { q: "C_UB" }) === "");
    ok("search with a status and a shop", await st("active", { q: "a", orgId: "band" }) === "FAIR,LASTDAY,ANYONE10" && await st("off", { q: "code", orgId: "club" }) === "OFFCODE");
    const qTotal = await lib.listDiscountCodes(d1, { q: "code", today: TODAY });
    ok("search's total is the matches", qTotal.total === 2);
    ok("blank search lists all", await st("all", { q: "   " }) === ids(all) && await st("all", { q: null }) === ids(all));
    // paging
    const p1 = await lib.listDiscountCodes(d1, { limit: 3, offset: 0, today: TODAY }), p2 = await lib.listDiscountCodes(d1, { limit: 3, offset: 3, today: TODAY });
    const p3 = await lib.listDiscountCodes(d1, { limit: 3, offset: 6, today: TODAY }), p4 = await lib.listDiscountCodes(d1, { limit: 3, offset: 9, today: TODAY });
    ok("pages of 3 in order", ids(p1) === "BOTH,FAIR,LASTDAY" && ids(p2) === "OFFCODE,OLDCODE,CLUB5" && ids(p3) === "ANYONE10" && ids(p4) === "");
    ok("every page's total is the whole count", [p1, p2, p3, p4].every(p => p.total === 7));
    ok("a limit of 0 or nonsense is 50; a negative offset is 0", ids(await lib.listDiscountCodes(d1, { limit: 0, offset: -5, today: TODAY })) === ids(all)
      && ids(await lib.listDiscountCodes(d1, { limit: "x", offset: "y", today: TODAY })) === ids(all));
    ok("a fractional limit is floored", (await lib.listDiscountCodes(d1, { limit: 2.9, today: TODAY })).codes.length === 2);
    // the shop's name when the shop row is gone
    d1.q("PRAGMA foreign_keys = OFF");
    d1.q("UPDATE discount_codes SET orgId = 'gone' WHERE id = ?", old.id);
    d1.q("PRAGMA foreign_keys = ON");
    ok("a code for a shop that's gone shows the shop's id", (await lib.listDiscountCodes(d1, { q: "OLDCODE", today: TODAY })).codes[0].orgName === "gone");
    // limit cap 200
    const stmts = [];
    for (let i = 0; i < 205; i++) stmts.push(d1.prepare("INSERT INTO discount_codes (code, kind, percentBps, maxUses, createdAt) VALUES (?, 'percent', 100, 1, '2027-05-01T00:00:00.000Z')").bind("BULK" + i));
    await d1.batch(stmts);
    const big = await lib.listDiscountCodes(d1, { limit: 1000, today: TODAY });
    ok("a limit over 200 lists 200", big.codes.length === 200 && big.total === 212);
    ok("without a limit 50 are listed", (await lib.listDiscountCodes(d1, { today: TODAY })).codes.length === 50);
    ok("no arguments at all list 50 (every status)", (await lib.listDiscountCodes(d1)).codes.length === 50);
    void any; void club5; void offc; void todayc; void both;
  }

  // ---- getDiscountCode ---------------------------------------------------------------------------------------------
  {
    const d1 = await makeDb();
    const c = (await lib.saveDiscountCode(d1, { code: "SAVE10", kind: "percent", percent: 10, maxUses: 1000, orgId: "club" }, { now: "2027-06-01T00:00:00.000Z", today: TODAY })).code;
    d1.q(`INSERT INTO orders (orderId, orgId, customerName, contact, paid, placedAt) VALUES ('club-1', 'club', 'Pat Example', 'pat@example.com', 1, '2027-06-02T00:00:00.000Z'),
      ('band-2', 'band', 'Sam Example', 'sam@example.com', 1, '2027-06-03T00:00:00.000Z')`);
    addUse(d1, c.id, { orderId: "club-1", email: "pat@example.com", cents: 425, usedAt: "2027-06-02T00:00:00.000Z" });
    addUse(d1, c.id, { orderId: "band-2", email: "sam@example.com", cents: 1000, usedAt: "2027-06-03T00:00:00.000Z", releasedAt: "2027-06-04T00:00:00.000Z" });
    addUse(d1, c.id, { orderId: "gone-3", email: "lee@example.com", cents: 1, usedAt: "2027-06-04T00:00:00.000Z" });
    const g = await lib.getDiscountCode(d1, c.id, TODAY);
    ok("a code's uses, newest first", g.uses.map(u => u.orderId).join(",") === "gone-3,band-2,club-1");
    ok("a use in dollars, with its email and when", g.uses[2].amount === 4.25 && g.uses[2].email === "pat@example.com" && g.uses[2].usedAt === "2027-06-02T00:00:00.000Z");
    ok("a use names the order's customer and shop", g.uses[2].customerName === "Pat Example" && g.uses[2].orgId === "club" && g.uses[1].orgId === "band");
    ok("a given-back use is listed with when it was given back", g.uses[1].releasedAt === "2027-06-04T00:00:00.000Z" && g.uses[2].releasedAt === null);
    ok("a use whose order is gone lists no customer or shop", g.uses[0].customerName === "" && g.uses[0].orgId === null && g.uses[0].amount === 0.01);
    ok("each use has exactly its fields", same(Object.keys(g.uses[0]).sort(), ["amount", "customerName", "email", "orderId", "orgId", "releasedAt", "usedAt"]));
    ok("usesTotal counts every use, given back too; used doesn't", g.usesTotal === 3 && g.used === 2);
    ok("the code is in the reader's shape too", g.code === "SAVE10" && g.orgName === "Example Club" && g.label === "10% off" && g.status === "active");
    ok("an id as text works", (await lib.getDiscountCode(d1, String(c.id), TODAY)).code === "SAVE10");
    for (const bad of [0, -1, 1.5, "abc", null, undefined, 2 ** 60]) ok(`id ${String(bad)} is null`, (await lib.getDiscountCode(d1, bad, TODAY)) === null);
    ok("a code that isn't there is null", (await lib.getDiscountCode(d1, 999, TODAY)) === null);
    // At most 500 uses listed.
    const stmts = [];
    for (let i = 0; i < 510; i++) {
      const at = new RealDate(Date.parse("2027-01-01T00:00:00.000Z") + i * 60000).toISOString();
      stmts.push(d1.prepare("INSERT INTO discount_code_uses (codeId, orderId, email, amountCents, usedAt) VALUES (?, ?, '', 100, ?)").bind(c.id, "B" + i, at));
    }
    for (let i = 0; i < stmts.length; i += 100) await d1.batch(stmts.slice(i, i + 100));
    const big = await lib.getDiscountCode(d1, c.id, TODAY);
    ok("at most 500 uses are listed", big.uses.length === 500);
    ok("usesTotal says how many in all", big.usesTotal === 513 && big.used === 512);
    ok("the 500 listed are the newest", big.uses[0].orderId === "gone-3" && big.uses[3].orderId === "B509" && big.uses[499].orderId === "B13");
    // same usedAt: the later id first
    const t2 = (await lib.saveDiscountCode(d1, { code: "TIE", kind: "percent", percent: 1, maxUses: 5 }, { today: TODAY })).code;
    addUse(d1, t2.id, { orderId: "T1", usedAt: "2027-06-01T00:00:00.000Z" }); addUse(d1, t2.id, { orderId: "T2", usedAt: "2027-06-01T00:00:00.000Z" });
    ok("uses at the same moment: the later one first", (await lib.getDiscountCode(d1, t2.id, TODAY)).uses.map(u => u.orderId).join(",") === "T2,T1");
  }

  // ---- setDiscountCodeActive, deleteDiscountCode -------------------------------------------------------------------
  {
    const d1 = await makeDb();
    const mk = async (code) => (await lib.saveDiscountCode(d1, { code, kind: "percent", percent: 10, maxUses: 5 }, { today: TODAY })).code;
    const a = await mk("SWITCH");
    const off = await lib.setDiscountCodeActive(d1, a.id, false);
    ok("switching off answers ok, the code and that it was on", off.ok === true && off.code === "SWITCH" && off.wasActive === true);
    ok("switched off: stored 0, status off", codeRow(d1, a.id).active === 0 && (await lib.getDiscountCode(d1, a.id, TODAY)).status === "off");
    const offAgain = await lib.setDiscountCodeActive(d1, a.id, false);
    ok("switching off again says it was already off", offAgain.ok === true && offAgain.wasActive === false);
    const on = await lib.setDiscountCodeActive(d1, String(a.id), true);
    ok("switching on again (id as text)", on.ok === true && on.wasActive === false && codeRow(d1, a.id).active === 1);
    ok("a falsy active (0) switches off", (await lib.setDiscountCodeActive(d1, a.id, 0)).ok === true && codeRow(d1, a.id).active === 0);
    for (const bad of [0, -2, "x", 1.5, null]) ok(`switching id ${String(bad)} is not found`, (await lib.setDiscountCodeActive(d1, bad, true)).error === NOT_FOUND);
    ok("switching a code that isn't there is not found", (await lib.setDiscountCodeActive(d1, 999, true)).error === NOT_FOUND);

    const del = await mk("DELME");
    const r = await lib.deleteDiscountCode(d1, del.id);
    ok("an unused code is deleted, answering what it was", r.ok === true && r.before && r.before.code === "DELME" && !codeRow(d1, del.id));
    ok("deleting it again: not found", (await lib.deleteDiscountCode(d1, del.id)).error === NOT_FOUND);
    for (const bad of [0, -1, "x", 2.5, undefined]) ok(`deleting id ${String(bad)} is not found`, (await lib.deleteDiscountCode(d1, bad)).error === NOT_FOUND);
    const USED_DEL = "This code has been used on an order, so it can't be deleted. Switch it off instead.";
    const used = await mk("USEDDEL");
    addUse(d1, used.id);
    ok("a used code can't be deleted", (await lib.deleteDiscountCode(d1, used.id)).error === USED_DEL && !!codeRow(d1, used.id));
    const rel = await mk("RELDEL");
    addUse(d1, rel.id, { releasedAt: "2027-06-10T00:00:00.000Z" });
    ok("a code whose only use was given back still can't be deleted", (await lib.deleteDiscountCode(d1, rel.id)).error === USED_DEL && !!codeRow(d1, rel.id));
    // Guarded in the same statement: a use claimed between the read and the delete.
    const racing = (onDelete) => ({
      prepare(sql) {
        const s = d1.prepare(sql);
        if (!/^DELETE FROM discount_codes/.test(sql)) return s;
        return { bind: (...args) => { const bound = s.bind(...args); return { run: async () => { onDelete(); return bound.run(); } }; } };
      },
    });
    const race = await mk("RACEDEL");
    ok("a use claimed just before the delete: refused, the code kept", (await lib.deleteDiscountCode(racing(() => addUse(d1, race.id)), race.id)).error === USED_DEL && !!codeRow(d1, race.id));
    const race2 = await mk("RACEDEL2");
    ok("a code deleted meanwhile: not found", (await lib.deleteDiscountCode(racing(() => d1.q("DELETE FROM discount_codes WHERE id = ?", race2.id)), race2.id)).error === NOT_FOUND);
  }

  // ---- a database before migrations/0115 ---------------------------------------------------------------------------
  {
    const d1 = await makeDb("0115");
    ok("before 0115: the list is empty", same(await lib.listDiscountCodes(d1, { today: TODAY }), { codes: [], total: 0 }));
    ok("before 0115: a code is null", (await lib.getDiscountCode(d1, 1, TODAY)) === null);
    const s = await lib.saveDiscountCode(d1, { code: "SAVE10", kind: "percent", percent: 10, maxUses: 1 }, { today: TODAY });
    ok("before 0115: saving says the update is needed", s.error === NOT_READY && s.notReady === true);
    { const r = await lib.saveDiscountCode(d1, { id: 1, kind: "percent", percent: 10, maxUses: 1 }, { today: TODAY }); ok("before 0115: editing answers not ready, not \"not found\"", r.notReady === true && r.error !== NOT_FOUND); }
    ok("before 0115: switching says the update is needed", (await lib.setDiscountCodeActive(d1, 1, false)).notReady === true);
    { const r = await lib.deleteDiscountCode(d1, 1); ok("before 0115: deleting answers not ready, not \"not found\"", r.notReady === true && r.error !== NOT_FOUND); }
  }

  // ---- a database failing for any other reason: passed on, never taken for "not ready" -------------------------------
  {
    const broken = { prepare() { throw new Error("D1_ERROR: disk I/O error"); } };
    const failure = async (run) => { try { await run(); return ""; } catch (e) { return String(e && e.message); } };
    ok("getDiscountCode passes any other database error on", /disk I\/O/.test(await failure(() => lib.getDiscountCode(broken, 1, TODAY))));
    ok("…and so does setDiscountCodeActive", /disk I\/O/.test(await failure(() => lib.setDiscountCodeActive(broken, 1, false))));
    ok("…and deleteDiscountCode", /disk I\/O/.test(await failure(() => lib.deleteDiscountCode(broken, 1))));
  }

  const { passed, failed } = counts();
  console.log(`${passed} checks passed, ${failed} failed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
