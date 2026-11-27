// Discount codes (migrations/0115): what a code takes off, whether it can be used, and taking / giving back a use —
// db.js called directly.
//   discountForCode_              percent rounded to the cent, an amount capped at the goods, a row or a parsed code
//   checkDiscountCode             every refusal word for word — the same sentence for an unknown code and an email-tied
//                                 code with another address, so the address is never given away; expiry through the end
//                                 of `today` (and the business's own day when it isn't given); shop scope; once per
//                                 email; the code's and the email's case and spaces
//   claimDiscountCode             the limit held atomically (two orders racing for the last use: one wins), once per
//                                 email, the email guard, the same order again ("already"), a released use taken back
//                                 by its order, another code on the same order refused
//   releaseDiscountCodeUse        the use stops counting, the row stays; nothing to give back is a no-op
//   createDiscountCodesForEmails  deduped, bad addresses skipped with the reason, at most 500, the prefix, a taken code
//                                 made again (forced by seeding the code the first draw makes)
// Real SQL (sql.js) + the real db.js, with db.js's clock and random bytes set here, so nothing depends on today's
// date or on chance. Invented shops and addresses only.
process.env.TZ = "UTC";
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

let NOW = Date.parse("2027-06-15T12:00:00.000Z");
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const at = (iso) => { NOW = RealDate.parse(iso); };

// db.js's random bytes: real ones unless a test queues its own (each queued array is one 8-byte draw).
const draws = [];
const fakeCrypto = {
  getRandomValues(arr) {
    if (draws.length) { const d = draws.shift(); for (let i = 0; i < arr.length; i++) arr[i] = d[i % d.length]; return arr; }
    return globalThis.crypto.getRandomValues(arr);
  },
};
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const drawFor = (s) => Array.from(s, ch => ALPHA.indexOf(ch));   // the bytes that make these 8 characters

const lib = new Function("Date", "crypto", strip(read("functions/_lib/db.js")) +
  "\nreturn { discountForCode_, checkDiscountCode, claimDiscountCode, releaseDiscountCodeUse, createDiscountCodesForEmails," +
  " resolveTimeZone, DISCOUNT_CODES_BULK_MAX };")(FakeDate, fakeCrypto);

const MIGRATIONS = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function makeDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of MIGRATIONS) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES
    ('club','club','Example Club','t','t'), ('band','band','Example Band','t','t');`);
  return d1;
}
// A code straight into the table, so every column the checks read is exactly as written here.
function addCode(d1, c) {
  d1.q(`INSERT INTO discount_codes (code, kind, percentBps, amountCents, orgId, email, maxUses, oncePerEmail, expiresOn, active, note, createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,'', 't')`,
    c.code, c.kind || "percent", (c.kind || "percent") === "percent" ? (c.bps || 1000) : null, c.kind === "amount" ? c.cents : null,
    c.orgId || null, c.email || "", c.maxUses || 1, c.oncePerEmail ? 1 : 0, c.expiresOn || null, c.active === 0 ? 0 : 1);
  return d1.q("SELECT id FROM discount_codes WHERE code = ?", c.code)[0].id;
}
function addUse(d1, codeId, orderId, email, released) {
  d1.q("INSERT INTO discount_code_uses (codeId, orderId, email, amountCents, usedAt, releasedAt) VALUES (?,?,?,100,'t',?)",
    codeId, orderId, email || "", released ? "2027-01-01T00:00:00.000Z" : null);
}
const liveUses = (d1, codeId) => d1.q("SELECT count(*) AS n FROM discount_code_uses WHERE codeId = ? AND releasedAt IS NULL", codeId)[0].n;
const useRow = (d1, orderId) => d1.q("SELECT * FROM discount_code_uses WHERE orderId = ?", orderId)[0] || null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const INVALID = "This code isn't valid.";
const INVALID_EMAIL = "This code isn't valid. If it was sent to you, check the email address is the one it was sent to.";
const EXPIRED = "This code has expired.";
const USED_ONCE = "This code has already been used.";
const LIMIT = "This code has reached its limit.";
const ALREADY_YOURS = "You've already used this code.";
const EMAIL_FIRST = "Enter your email address first — this code is for one person.";
const ORDER_HAS_CODE = "This order already has a discount code.";

(async () => {
  // ---- discountForCode_ ---------------------------------------------------------------------------------------------
  const D = lib.discountForCode_;
  ok("10% of $19.95 rounds half a cent up to $2.00", D({ kind: "percent", percentBps: 1000 }, 1995) === 200);
  ok("10% of $19.94 rounds down to $1.99", D({ kind: "percent", percentBps: 1000 }, 1994) === 199);
  ok("12.5% of $9.99 is $1.25 (124.875 cents rounded)", D({ kind: "percent", percentBps: 1250 }, 999) === 125);
  ok("0.01% of $100 is one cent", D({ kind: "percent", percentBps: 1 }, 10000) === 1);
  ok("100% takes the whole subtotal and no more", D({ kind: "percent", percentBps: 10000 }, 4321) === 4321);
  ok("a parsed code's percent (10) works like percentBps 1000", D({ kind: "percent", percent: 10 }, 1995) === 200);
  ok("a parsed code's percent with two decimals (12.34) is 1234 basis points", D({ kind: "percent", percent: 12.34 }, 10000) === 1234);
  ok("an amount under the subtotal is taken whole", D({ kind: "amount", amountCents: 500 }, 2000) === 500);
  ok("an amount over the subtotal is capped at the subtotal", D({ kind: "amount", amountCents: 5000 }, 1999) === 1999);
  ok("a parsed code's amount in dollars ($5) is 500 cents", D({ kind: "amount", amount: 5 }, 2000) === 500);
  ok("a parsed amount over the goods is capped too", D({ kind: "amount", amount: 50 }, 1234) === 1234);
  ok("no code takes nothing off", D(null, 2000) === 0);
  ok("an empty cart gets nothing off, a percent or an amount", D({ kind: "percent", percentBps: 5000 }, 0) === 0 && D({ kind: "amount", amountCents: 500 }, 0) === 0);
  ok("a negative or unreadable subtotal counts as nothing", D({ kind: "amount", amountCents: 500 }, -300) === 0 && D({ kind: "percent", percentBps: 1000 }, "lots") === 0);
  ok("a subtotal given as text in cents is read as a number", D({ kind: "percent", percentBps: 1000 }, "1995") === 200);
  ok("a fractional cents subtotal is rounded before the percent", D({ kind: "percent", percentBps: 5000 }, 999.6) === 500);
  ok("a code with no readable value takes nothing off, never NaN (a percent or an amount)",
    D({ kind: "percent" }, 2000) === 0 && D({ kind: "percent", percent: "lots" }, 2000) === 0 && D({ kind: "amount" }, 2000) === 0 && D({ kind: "amount", amountCents: "lots" }, 2000) === 0);

  // ---- checkDiscountCode ----------------------------------------------------------------------------------------------
  const d1 = await makeDb();
  const save10 = addCode(d1, { code: "SAVE10", bps: 1000, maxUses: 50 });
  const five = addCode(d1, { code: "FIVE-OFF", kind: "amount", cents: 500, maxUses: 10 });
  const pat = addCode(d1, { code: "PAT_ONLY", bps: 2000, email: "pat@example.com" });
  const clubOnly = addCode(d1, { code: "CLUB15", bps: 1500, orgId: "club", maxUses: 5 });
  addCode(d1, { code: "SLEEPY", bps: 1000, maxUses: 5, active: 0 });
  addCode(d1, { code: "SUMMER", bps: 1000, maxUses: 5, expiresOn: "2027-06-15" });
  addCode(d1, { code: "SPRING", bps: 1000, maxUses: 5, expiresOn: "2027-06-14" });
  const once = addCode(d1, { code: "ONCE-EACH", bps: 1000, maxUses: 5, oncePerEmail: 1 });
  const full = addCode(d1, { code: "FULLUP", bps: 1000, maxUses: 2 });
  addUse(d1, full, "F1", "a@example.com"); addUse(d1, full, "F2", "b@example.com");
  const patUsed = addCode(d1, { code: "SAM_ONLY", bps: 1000, email: "sam@example.com" });
  addUse(d1, patUsed, "S1", "sam@example.com");
  const T = "2027-06-15";
  const check = (code, extra = {}) => lib.checkDiscountCode(d1, { code, orgId: "club", email: "", subtotal: 19.95, today: T, ...extra });

  let r = await check("SAVE10");
  ok("a good percent code answers ok with its id, code, label, kind, percent and amount",
    r.ok === true && same(r.code, { id: save10, code: "SAVE10", label: "10% off", kind: "percent", percent: 10, amount: null, maxDiscount: null }));
  ok("its discount is in dollars: 10% of $19.95 is $2.00", r.discount === 2);
  ok("the answer never carries the email, the uses or the limit", !("email" in r.code) && !("used" in r.code) && !("maxUses" in r.code) && !("email" in r));
  r = await check("FIVE-OFF", { subtotal: 3.5 });
  ok("an amount code over a small cart takes only the cart ($3.50 of $5.00)", r.ok && r.discount === 3.5 && r.code.amount === 5 && r.code.label === "$5.00 off" && r.code.percent === null);
  r = await check("  save10 ");
  ok("the code is matched whatever its case and spaces", r.ok === true && r.code.code === "SAVE10");
  r = await check("sav e10");
  ok("a code that can't be a code (a space inside) gets the same sentence as an unknown one", !r.ok && r.reason === INVALID_EMAIL);
  ok("an empty code gets that sentence too", (await check("")).reason === INVALID_EMAIL && (await lib.checkDiscountCode(d1)).reason === INVALID_EMAIL);
  r = await check("NOPE123");
  ok("an unknown code: \"This code isn't valid. If it was sent to you, check the email address…\"", r.ok === false && r.reason === INVALID_EMAIL);
  r = await check("PAT_ONLY", { email: "sam@example.com" });
  ok("an email-tied code with another address gets exactly the unknown code's sentence", r.ok === false && r.reason === INVALID_EMAIL);
  ok("…and nothing in the answer names the address it was for", !JSON.stringify(r).includes("pat@"));
  r = await check("PAT_ONLY");
  ok("an email-tied code with no email yet asks for the email first", r.ok === false && r.reason === EMAIL_FIRST);
  ok("an unknown code with no email doesn't ask for one (only a real email-tied code does)", (await check("NOPE123")).reason === INVALID_EMAIL);
  r = await check("PAT_ONLY", { email: "  Pat@Example.COM " });
  ok("the email is compared trimmed and lower-case", r.ok === true && r.code.id === pat && r.discount === 3.99);
  r = await check("PAT_ONLY", { email: "not an email" });
  ok("an email that isn't an address counts as none typed yet", r.reason === EMAIL_FIRST);
  r = await check("SLEEPY");
  ok("a switched-off code: \"This code isn't valid.\"", r.ok === false && r.reason === INVALID);
  r = await check("CLUB15", { orgId: "band" });
  ok("a code for another shop: \"This code isn't valid.\"", r.ok === false && r.reason === INVALID);
  ok("a one-shop code with no shop given isn't valid either", (await check("CLUB15", { orgId: undefined })).reason === INVALID);
  r = await check("CLUB15");
  ok("a one-shop code works in its own shop", r.ok === true && r.code.id === clubOnly);
  ok("an every-shop code works in any shop", (await check("SAVE10", { orgId: "band" })).ok === true);
  r = await check("SUMMER");
  ok("a code works through the end of its last day (expires today)", r.ok === true);
  r = await check("SPRING");
  ok("the day after its last day: \"This code has expired.\"", r.ok === false && r.reason === EXPIRED);
  r = await check("SUMMER", { today: "2027-06-16" });
  ok("the next day the code that worked today has expired", r.reason === EXPIRED);
  r = await check("FULLUP");
  ok("a multi-use code with every use taken: \"This code has reached its limit.\"", r.ok === false && r.reason === LIMIT);
  r = await check("SAM_ONLY", { email: "sam@example.com" });
  ok("a single-use code used already: \"This code has already been used.\"", r.ok === false && r.reason === USED_ONCE);
  r = await check("SAM_ONLY", { email: "pat@example.com" });
  ok("a used single-use code with another email still says only the unknown code's sentence", r.reason === INVALID_EMAIL);
  addUse(d1, once, "O1", "pat@example.com");
  r = await check("ONCE-EACH", { email: "PAT@example.com " });
  ok("once per email, the same address again: \"You've already used this code.\"", r.ok === false && r.reason === ALREADY_YOURS);
  r = await check("ONCE-EACH", { email: "sam@example.com" });
  ok("once per email, another address can still use it", r.ok === true);
  r = await check("ONCE-EACH");
  ok("once per email with no email typed yet doesn't refuse (the order's email is checked when placed)", r.ok === true);
  d1.q("UPDATE discount_code_uses SET releasedAt = 'x' WHERE orderId = 'O1'");
  ok("once per email: a use given back (its order voided) lets that address use it again", (await check("ONCE-EACH", { email: "pat@example.com" })).ok === true);
  d1.q("UPDATE discount_code_uses SET releasedAt = 'x' WHERE orderId = 'F2'");
  ok("a use given back frees a place under the limit", (await check("FULLUP")).ok === true);
  r = await check("FIVE-OFF", { subtotal: 0 });
  ok("an empty cart can still check a code (discount $0)", r.ok === true && r.discount === 0);

  // Order of the reasons: the address is checked before anything that would say the code exists.
  addCode(d1, { code: "PAT_OFF", bps: 1000, email: "pat@example.com", active: 0 });
  addCode(d1, { code: "PAT_OLD", bps: 1000, email: "pat@example.com", expiresOn: "2027-01-01" });
  addCode(d1, { code: "PAT_BAND", bps: 1000, email: "pat@example.com", orgId: "band" });
  const wrong = { email: "sam@example.com" };
  ok("an email-tied code that is off, expired or for another shop, with another address, still gives the unknown code's sentence",
    (await check("PAT_OFF", wrong)).reason === INVALID_EMAIL && (await check("PAT_OLD", wrong)).reason === INVALID_EMAIL && (await check("PAT_BAND", wrong)).reason === INVALID_EMAIL);
  ok("with the right address, an off one isn't valid and an expired one has expired",
    (await check("PAT_OFF", { email: "pat@example.com" })).reason === INVALID && (await check("PAT_OLD", { email: "pat@example.com" })).reason === EXPIRED);

  // `today` left out: the business's own day (the time zone resolveTimeZone found), not UTC's.
  await lib.resolveTimeZone({ TIMEZONE: "America/Los_Angeles" });
  at("2027-06-16T03:00:00.000Z");   // 8 pm on the 15th in Los Angeles, already the 16th in UTC
  ok("without `today`, a code is good through the end of its last day in the business's time zone",
    (await lib.checkDiscountCode(d1, { code: "SUMMER", orgId: "club", subtotal: 10 })).ok === true);
  at("2027-06-16T07:30:00.000Z");   // half past midnight on the 16th there
  ok("…and expired once the business's day is the next one", (await lib.checkDiscountCode(d1, { code: "SUMMER", orgId: "club", subtotal: 10 })).reason === EXPIRED);
  ok("a `today` that isn't a date falls back to the business's day", (await lib.checkDiscountCode(d1, { code: "SUMMER", orgId: "club", subtotal: 10, today: "soon" })).reason === EXPIRED);
  at("2027-06-15T12:00:00.000Z");

  // ---- claimDiscountCode ----------------------------------------------------------------------------------------------
  const c2 = await makeDb();
  const last = addCode(c2, { code: "LASTONE", bps: 1000, maxUses: 2 });
  addUse(c2, last, "L0", "x@example.com");
  const [a, b] = await Promise.all([
    lib.claimDiscountCode(c2, { codeId: last, orderId: "LA", email: "pat@example.com", amountCents: 200, now: "2027-06-15T12:00:00.000Z" }),
    lib.claimDiscountCode(c2, { codeId: last, orderId: "LB", email: "sam@example.com", amountCents: 200, now: "2027-06-15T12:00:00.000Z" }),
  ]);
  ok("two orders racing for the last use: exactly one wins", [a, b].filter(x => x.ok === true).length === 1 && [a, b].filter(x => x.ok === false).length === 1);
  ok("…the other is told the code has reached its limit", [a, b].find(x => !x.ok).reason === LIMIT);
  ok("…and the code has its two uses, no more", liveUses(c2, last) === 2);
  const won = a.ok ? "LA" : "LB";
  const wr = useRow(c2, won);
  ok("the winning use records the order, the email, the amount and the time", wr.codeId === last && wr.email === (won === "LA" ? "pat@example.com" : "sam@example.com") && wr.amountCents === 200 && wr.usedAt === "2027-06-15T12:00:00.000Z" && wr.releasedAt === null);
  ok("the losing order has no use row", useRow(c2, a.ok ? "LB" : "LA") === null);

  const single = addCode(c2, { code: "JUST1", bps: 1000 });
  const s = await Promise.all([1, 2, 3].map(i => lib.claimDiscountCode(c2, { codeId: single, orderId: "J" + i, email: "pat@example.com", amountCents: 100 })));
  ok("three orders racing for a single-use code: one wins, two are told it's been used",
    s.filter(x => x.ok).length === 1 && s.filter(x => x.reason === USED_ONCE).length === 2 && liveUses(c2, single) === 1);

  r = await lib.claimDiscountCode(c2, { codeId: single, orderId: s.findIndex(x => x.ok) >= 0 ? "J" + (s.findIndex(x => x.ok) + 1) : "", email: "pat@example.com", amountCents: 100 });
  ok("the same order claiming the same code again answers ok, already — no second use", r.ok === true && r.already === true && liveUses(c2, single) === 1);

  const other = addCode(c2, { code: "OTHER", bps: 500, maxUses: 10 });
  const winner = "J" + (s.findIndex(x => x.ok) + 1);
  r = await lib.claimDiscountCode(c2, { codeId: other, orderId: winner, email: "pat@example.com", amountCents: 50 });
  ok("a different code on an order that has one: \"This order already has a discount code.\"", r.ok === false && r.reason === ORDER_HAS_CODE);
  ok("…and the order's use is unchanged", useRow(c2, winner).codeId === single && liveUses(c2, other) === 0);

  const each = addCode(c2, { code: "EACH1", bps: 1000, maxUses: 10, oncePerEmail: 1 });
  ok("once per email: the first order for an address takes a use", (await lib.claimDiscountCode(c2, { codeId: each, orderId: "E1", email: "pat@example.com", amountCents: 1 })).ok === true);
  r = await lib.claimDiscountCode(c2, { codeId: each, orderId: "E2", email: " PAT@example.com", amountCents: 1 });
  ok("once per email: a second order for that address (any case) is refused: \"You've already used this code.\"", r.ok === false && r.reason === ALREADY_YOURS && useRow(c2, "E2") === null);
  ok("once per email: another address takes a use", (await lib.claimDiscountCode(c2, { codeId: each, orderId: "E3", email: "sam@example.com", amountCents: 1 })).ok === true);
  ok("once per email: two orders with no email at all — the second is refused as already used",
    (await lib.claimDiscountCode(c2, { codeId: each, orderId: "E4", email: "", amountCents: 1 })).ok === true &&
    (await lib.claimDiscountCode(c2, { codeId: each, orderId: "E5", email: "", amountCents: 1 })).reason === ALREADY_YOURS);
  const racing = await Promise.all(["R1", "R2"].map(o => lib.claimDiscountCode(c2, { codeId: each, orderId: o, email: "lee@example.com", amountCents: 1 })));
  ok("once per email: two orders for one address racing — one wins", racing.filter(x => x.ok).length === 1 && racing.find(x => !x.ok).reason === ALREADY_YOURS);

  const mine = addCode(c2, { code: "FORPAT", bps: 1000, email: "pat@example.com" });
  r = await lib.claimDiscountCode(c2, { codeId: mine, orderId: "P1", email: "sam@example.com", amountCents: 1 });
  ok("an email-tied code claimed for another address is refused with the unknown code's sentence", r.ok === false && r.reason === INVALID_EMAIL && useRow(c2, "P1") === null);
  r = await lib.claimDiscountCode(c2, { codeId: mine, orderId: "P1", email: "", amountCents: 1 });
  ok("an email-tied code claimed with no email is refused: enter your email first", r.ok === false && r.reason === EMAIL_FIRST && useRow(c2, "P1") === null);
  r = await lib.claimDiscountCode(c2, { codeId: mine, orderId: "P1", email: "Pat@Example.com ", amountCents: 321 });
  ok("an email-tied code claimed for its address (any case, spaces) is taken, the email stored lower-case",
    r.ok === true && useRow(c2, "P1").email === "pat@example.com" && useRow(c2, "P1").amountCents === 321);

  const off = addCode(c2, { code: "OFFNOW", bps: 1000, maxUses: 5, active: 0 });
  r = await lib.claimDiscountCode(c2, { codeId: off, orderId: "X1", email: "pat@example.com", amountCents: 1 });
  ok("a switched-off code can't be claimed: \"This code isn't valid.\"", r.ok === false && r.reason === INVALID && useRow(c2, "X1") === null);
  r = await lib.claimDiscountCode(c2, { codeId: 99999, orderId: "X2", email: "pat@example.com", amountCents: 1 });
  ok("a code id that doesn't exist: \"This code isn't valid.\"", r.ok === false && r.reason === INVALID && useRow(c2, "X2") === null);
  ok("no code id, a bad one, or no order id: \"This code isn't valid.\" and nothing written",
    (await lib.claimDiscountCode(c2, { orderId: "X3" })).reason === INVALID && (await lib.claimDiscountCode(c2, { codeId: "abc", orderId: "X3" })).reason === INVALID &&
    (await lib.claimDiscountCode(c2, { codeId: 0, orderId: "X3" })).reason === INVALID && (await lib.claimDiscountCode(c2, { codeId: other })).reason === INVALID &&
    (await lib.claimDiscountCode(c2)).reason === INVALID && useRow(c2, "X3") === null);
  r = await lib.claimDiscountCode(c2, { codeId: other, orderId: "NEG", email: "", amountCents: -40 });
  ok("a negative amount is stored as 0", r.ok && useRow(c2, "NEG").amountCents === 0);
  // The insert refused, then a use freed before the reason is read (another order voided in between): the code reads
  // as usable, so the answer falls back to the limit rather than an empty reason.
  const freed = addCode(c2, { code: "FREED", bps: 1000, maxUses: 5 });
  const racy = Object.assign(Object.create(c2), { prepare: (sql) => /^INSERT INTO discount_code_uses/.test(sql)
    ? { bind: () => ({ run: async () => ({ success: true, meta: { changes: 0 } }) }) } : c2.prepare(sql) });
  r = await lib.claimDiscountCode(racy, { codeId: freed, orderId: "FR1", email: "pat@example.com", amountCents: 1 });
  ok("a claim refused by the insert but usable on the re-read still says why: the limit was reached", r.ok === false && r.reason === LIMIT);
  const tillNow = addCode(c2, { code: "OLDONE", bps: 1000, maxUses: 5, expiresOn: "2020-01-01" });
  ok("expiry is the caller's check: an expired code can still be claimed (checkDiscountCode refused it before)",
    (await lib.claimDiscountCode(c2, { codeId: tillNow, orderId: "OLD1", email: "", amountCents: 1 })).ok === true);

  // ---- releaseDiscountCodeUse, and taking a released use back -----------------------------------------------------
  const give = addCode(c2, { code: "GIVEBACK", bps: 1000, maxUses: 1 });
  ok("the order takes the code's only use", (await lib.claimDiscountCode(c2, { codeId: give, orderId: "G1", email: "pat@example.com", amountCents: 150 })).ok === true);
  ok("…so another order can't", (await lib.claimDiscountCode(c2, { codeId: give, orderId: "G2", email: "sam@example.com", amountCents: 1 })).reason === USED_ONCE);
  r = await lib.releaseDiscountCodeUse(c2, "G1", "2027-06-16T09:00:00.000Z");
  ok("giving the use back answers ok with the code", r.ok === true && r.code === "GIVEBACK");
  ok("the use stays as a row, marked given back at that time", useRow(c2, "G1").releasedAt === "2027-06-16T09:00:00.000Z" && useRow(c2, "G1").amountCents === 150);
  ok("the count drops: the code has no live use", liveUses(c2, give) === 0);
  r = await lib.releaseDiscountCodeUse(c2, "G1", "2027-06-17T09:00:00.000Z");
  ok("giving it back twice is a no-op: no code, the first time kept", r.ok === true && r.code === "" && useRow(c2, "G1").releasedAt === "2027-06-16T09:00:00.000Z");
  ok("an order with no use: a no-op answering no code", same(await lib.releaseDiscountCodeUse(c2, "NOSUCH"), { ok: true, code: "" }));
  ok("no order id: a no-op answering no code", same(await lib.releaseDiscountCodeUse(c2, ""), { ok: true, code: "" }) && same(await lib.releaseDiscountCodeUse(c2, null), { ok: true, code: "" }));
  ok("releasing one order leaves other orders' uses counted", liveUses(c2, single) === 1 && liveUses(c2, each) === 4);

  r = await lib.claimDiscountCode(c2, { codeId: give, orderId: "G1", email: "pat@example.com", amountCents: 140, now: "2027-06-18T10:00:00.000Z" });
  ok("the same order claiming again takes its released use back (one row, live again)",
    r.ok === true && !r.already && c2.q("SELECT count(*) AS n FROM discount_code_uses WHERE orderId = 'G1'")[0].n === 1 &&
    useRow(c2, "G1").releasedAt === null && useRow(c2, "G1").amountCents === 140 && useRow(c2, "G1").usedAt === "2027-06-18T10:00:00.000Z" && liveUses(c2, give) === 1);
  await lib.releaseDiscountCodeUse(c2, "G1");
  ok("after giving it back, another order can take the freed use", (await lib.claimDiscountCode(c2, { codeId: give, orderId: "G2", email: "sam@example.com", amountCents: 1 })).ok === true);
  r = await lib.claimDiscountCode(c2, { codeId: give, orderId: "G1", email: "pat@example.com", amountCents: 1 });
  ok("…and then the first order can't take it back: the code has been used", r.ok === false && r.reason === USED_ONCE && useRow(c2, "G1").releasedAt !== null);
  r = await lib.claimDiscountCode(c2, { codeId: other, orderId: "G1", email: "pat@example.com", amountCents: 77 });
  ok("a released order can take a different code: its one row moves to that code", r.ok === true && useRow(c2, "G1").codeId === other && useRow(c2, "G1").releasedAt === null && useRow(c2, "G1").amountCents === 77);

  // ---- before migrations/0115 -----------------------------------------------------------------------------------------
  const old = await makeDb("0115");
  r = await lib.checkDiscountCode(old, { code: "SAVE10", orgId: "club", email: "", subtotal: 10, today: T });
  ok("before 0115, checking a code says it isn't valid (not ready), never an error", r.ok === false && r.reason === INVALID_EMAIL && r.notReady === true);
  r = await lib.claimDiscountCode(old, { codeId: 1, orderId: "A", email: "", amountCents: 1 });
  ok("before 0115, a claim is refused as not ready", r.ok === false && r.reason === INVALID && r.notReady === true);
  ok("before 0115, giving a use back is a no-op", same(await lib.releaseDiscountCodeUse(old, "A"), { ok: true, code: "" }));
  r = await lib.createDiscountCodesForEmails(old, { emails: ["pat@example.com"], kind: "percent", percent: 10 });
  ok("before 0115, bulk codes answer not ready", r.notReady === true && /latest database update/.test(r.error));
  const broken = { prepare() { throw new Error("D1_ERROR: disk I/O error"); } };
  let threw = "";
  try { await lib.checkDiscountCode(broken, { code: "SAVE10", orgId: "club", subtotal: 1, today: T }); } catch (e) { threw = e.message; }
  ok("any other database error is passed on by checkDiscountCode", /disk I\/O/.test(threw));
  threw = "";
  try { await lib.claimDiscountCode(broken, { codeId: 1, orderId: "A" }); } catch (e) { threw = e.message; }
  ok("…and by claimDiscountCode", /disk I\/O/.test(threw));
  threw = "";
  try { await lib.releaseDiscountCodeUse(broken, "A"); } catch (e) { threw = e.message; }
  ok("…and by releaseDiscountCodeUse", /disk I\/O/.test(threw));
  threw = "";
  try { await lib.createDiscountCodesForEmails(broken, { emails: ["pat@example.com"], kind: "percent", percent: 10 }); } catch (e) { threw = e.message; }
  ok("…and by createDiscountCodesForEmails", /disk I\/O/.test(threw));

  // ---- createDiscountCodesForEmails -----------------------------------------------------------------------------------
  const c3 = await makeDb();
  const opts = { actor: "Owner", now: "2027-06-15T12:00:00.000Z" };
  r = await lib.createDiscountCodesForEmails(c3, {
    emails: [" Pat@Example.com", "sam@example.com", "pat@example.com", "not-an-email", "", "lee@example.com", "SAM@EXAMPLE.COM"],
    kind: "amount", amount: 5, orgId: "club", expiresOn: "2027-12-31", note: "Example Club volunteers",
  }, opts);
  ok("one code for each different address, in the list's order, lower-case", same(r.codes.map(x => x.email), ["pat@example.com", "sam@example.com", "lee@example.com"]));
  ok("repeats are skipped as already in the list, bad addresses as not an email (blank lines ignored)",
    same(r.skipped, [{ email: "pat@example.com", reason: "Already in the list." }, { email: "not-an-email", reason: "Not an email address." },
      { email: "sam@example.com", reason: "Already in the list." }]));
  ok("each code is 8 characters from the readable alphabet, all different", r.codes.every(x => /^[A-HJ-NP-Z2-9]{8}$/.test(x.code)) && new Set(r.codes.map(x => x.code)).size === 3);
  const rows = c3.q("SELECT * FROM discount_codes ORDER BY id");
  ok("each is written as a single-use code for its address, with the value, shop, expiry, note and who made it",
    rows.length === 3 && rows.every((w, i) => w.code === r.codes[i].code && w.email === r.codes[i].email && w.maxUses === 1 && w.oncePerEmail === 0 &&
      w.kind === "amount" && w.amountCents === 500 && w.percentBps === null && w.orgId === "club" && w.expiresOn === "2027-12-31" &&
      w.note === "Example Club volunteers" && w.active === 1 && w.createdAt === opts.now && w.createdBy === "Owner"));
  const made = r.codes[0];
  r = await lib.checkDiscountCode(c3, { code: made.code, orgId: "club", email: "pat@example.com", subtotal: 20, today: T });
  ok("a bulk code works for its address", r.ok === true && r.discount === 5);
  ok("…and not for another", (await lib.checkDiscountCode(c3, { code: made.code, orgId: "club", email: "sam@example.com", subtotal: 20, today: T })).reason === INVALID_EMAIL);

  r = await lib.createDiscountCodesForEmails(c3, { emails: "a@example.com, b@example.com;c@example.com\nd@example.com\t e@example.com", prefix: " spring-", kind: "percent", percent: 15 }, opts);
  ok("text is split on commas, semicolons and white space", same(r.codes.map(x => x.email), ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"]) && r.skipped.length === 0);
  { const r2 = await lib.createDiscountCodesForEmails(c3, { emails: [null, "f@example.com", undefined, "  "], kind: "percent", percent: 15 }, opts);
    ok("empty entries in a list (null, missing, blank) are left out, not skipped as addresses", same(r2.codes.map(x => x.email), ["f@example.com"]) && r2.skipped.length === 0); }
  ok("the prefix is trimmed, upper-cased and put before the 8 characters", r.codes.every(x => /^SPRING-[A-HJ-NP-Z2-9]{8}$/.test(x.code)));
  ok("a percent bulk code is stored in basis points for every shop", c3.q("SELECT count(*) AS n FROM discount_codes WHERE code LIKE 'SPRING-%' AND kind='percent' AND percentBps=1500 AND orgId IS NULL AND expiresOn IS NULL")[0].n === 5);

  ok("a prefix with a space or over 12 characters is refused",
    (await lib.createDiscountCodesForEmails(c3, { emails: ["a@example.com"], prefix: "NEW YEAR", kind: "percent", percent: 10 })).error === "A prefix can be up to 12 letters, digits, - or _." &&
    (await lib.createDiscountCodesForEmails(c3, { emails: ["a@example.com"], prefix: "ABCDEFGHIJKLM", kind: "percent", percent: 10 })).error === "A prefix can be up to 12 letters, digits, - or _.");
  ok("a 12-character prefix is allowed (12 + 8 = 20 characters)",
    (await lib.createDiscountCodesForEmails(c3, { emails: ["z@example.com"], prefix: "ABCDEFGHIJKL", kind: "percent", percent: 10 })).codes[0].code.length === 20);
  ok("a bad value is refused with the single code's own words", (await lib.createDiscountCodesForEmails(c3, { emails: ["a@example.com"], kind: "percent", percent: 0 })).error === "The percent off must be from 0.01 to 100.");
  ok("a shop that doesn't exist is refused", (await lib.createDiscountCodesForEmails(c3, { emails: ["a@example.com"], kind: "percent", percent: 10, orgId: "nowhere" })).error === "That shop wasn't found.");
  ok("no addresses at all is refused", (await lib.createDiscountCodesForEmails(c3, { emails: " , ;\n", kind: "percent", percent: 10 })).error === "Enter at least one email address." &&
    (await lib.createDiscountCodesForEmails(c3, { kind: "percent", percent: 10 })).error === "Enter at least one email address." &&
    (await lib.createDiscountCodesForEmails(c3, null)).error === "Choose percent off or an amount off.");
  r = await lib.createDiscountCodesForEmails(c3, { emails: ["only-bad", "also bad"], kind: "percent", percent: 10 });
  ok("a list of only bad addresses makes nothing and says why for each", r.codes.length === 0 && r.skipped.length === 2 && r.skipped.every(x => x.reason === "Not an email address."));

  const many = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i}@example.com`);
  const before = c3.q("SELECT count(*) AS n FROM discount_codes")[0].n;
  r = await lib.createDiscountCodesForEmails(c3, { emails: many(501, "m"), kind: "percent", percent: 10 });
  ok("501 different addresses is refused: at most 500 at a time", r.error === "At most 500 email addresses at a time." && lib.DISCOUNT_CODES_BULK_MAX === 500);
  ok("…and nothing is written", c3.q("SELECT count(*) AS n FROM discount_codes")[0].n === before);
  r = await lib.createDiscountCodesForEmails(c3, { emails: many(500, "k").concat(many(100, "k")), kind: "percent", percent: 10 });
  ok("500 addresses, plus repeats of them, makes 500 codes and skips the repeats", r.codes.length === 500 && r.skipped.length === 100 && r.skipped.every(x => x.reason === "Already in the list."));
  r = await lib.createDiscountCodesForEmails(c3, { emails: Array(2001).fill("q@example.com"), kind: "percent", percent: 10 });
  ok("more than 2,000 lines is refused even when they are repeats", r.error === "At most 500 email addresses at a time.");

  // A taken code is made again. The first draw makes BULK-AAAAAAAA, seeded as taken; the next draw makes another.
  const c4 = await makeDb();
  addCode(c4, { code: "BULK-AAAAAAAA", bps: 1000, maxUses: 3 });
  draws.push(drawFor("AAAAAAAA"), drawFor("BBBBBBBB"), drawFor("CCCCCCCC"));
  r = await lib.createDiscountCodesForEmails(c4, { emails: ["pat@example.com", "sam@example.com"], prefix: "bulk-", kind: "percent", percent: 10 }, opts);
  ok("a made-up code that's taken already is made again for that address", same(r.codes, [{ email: "pat@example.com", code: "BULK-CCCCCCCC" }, { email: "sam@example.com", code: "BULK-BBBBBBBB" }]) && r.skipped.length === 0);
  ok("…the taken code is left as it was", c4.q("SELECT email, maxUses FROM discount_codes WHERE code = 'BULK-AAAAAAAA'")[0].maxUses === 3 && c4.q("SELECT count(*) AS n FROM discount_codes")[0].n === 3);
  draws.push(drawFor("DDDDDDDD"), drawFor("DDDDDDDD"), drawFor("EEEEEEEE"));
  let batches = 0;
  const counting = Object.assign(Object.create(c4), { batch: (s) => { batches++; return c4.batch(s); } });
  r = await lib.createDiscountCodesForEmails(counting, { emails: ["lee@example.com", "kim@example.com"], kind: "percent", percent: 10 }, opts);
  ok("two addresses never get the same code in one batch: the repeat draw is made again", same(r.codes, [{ email: "lee@example.com", code: "DDDDDDDD" }, { email: "kim@example.com", code: "EEEEEEEE" }]));
  ok("…before writing, so the list is written in one batch", batches === 1);
  draws.push(...Array(4).fill(drawFor("DDDDDDDD")));
  r = await lib.createDiscountCodesForEmails(c4, { emails: ["max@example.com"], kind: "percent", percent: 10 }, opts);
  ok("an address whose code is taken four times running is skipped with the reason, not an error",
    r.codes.length === 0 && same(r.skipped, [{ email: "max@example.com", reason: "Couldn't make a code that isn't taken. Try this address again." }]) &&
    c4.q("SELECT count(*) AS n FROM discount_codes WHERE email = 'max@example.com'")[0].n === 0);
  ok("every queued draw was used", draws.length === 0);
})().catch(e => { console.log("test threw " + (e && e.stack || e)); process.exitCode = 1; });
