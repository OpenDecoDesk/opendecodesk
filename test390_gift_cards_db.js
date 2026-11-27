const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// Gift cards in functions/_lib/db.js (migrations/0120), driven branch by branch against real SQL (sql.js):
//   - the card number: generateGiftCardCode_ (16 characters, no look-alikes), normalizeGiftCardCode_, formatGiftCardCode_,
//     and giftCardPaymentOn (the Global settings payment tick)
//   - issueGiftCard (limits, email checks, the ledger 'issue' row, one card per order sold online even when two race,
//     a taken number tried again), getGiftCard (masked: the full number never in it), revealGiftCardCode, listGiftCards
//     (search on the last 4, names, emails and order; status; paging), giftCardLedger, checkGiftCard
//   - redeemGiftCard: the least of what was asked, the balance and what the order owes; the one conditional UPDATE so two
//     spends racing cannot both have the last of a card; the payment row (method other, giftCardId, reference,
//     accountId NULL); the paid flag; requestKey; "That order just changed."
//   - refundToGiftCard, voidPayment of a gift-card payment (money back once, less what was already refunded to the card),
//     and voiding a refund put on a card (the credit comes back off; refused when the card no longer has it), with the
//     Void button in functions/api/orders.js refusing before anything is written
//   - adjustGiftCard, voidGiftCard, giftCardTotals, and every function on a database from before migrations/0120
// Invented data only (Example Club, pat@example.com). Every date the checks read is set by the test.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const NAMES = `{ GIFT_CARD_ALPHABET, giftCardPaymentOn, generateGiftCardCode_, normalizeGiftCardCode_, formatGiftCardCode_, issueGiftCard, getGiftCard,
  revealGiftCardCode, listGiftCards, giftCardLedger, checkGiftCard, redeemGiftCard, refundToGiftCard, voidPayment, giftCardVoidRefusal,
  adjustGiftCard, voidGiftCard, giftCardTotals, insertOrder, getOrderCheckoutState, addOrderPayment }`;
const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn " + NAMES + ";")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

// A database that fails the statements matching `re` with `message`, and answers the rest as usual.
function failing(db, re, message) {
  const boom = () => { const s = { bind: () => s, run: async () => { throw new Error(message); }, all: async () => { throw new Error(message); }, first: async () => { throw new Error(message); } }; return s; };
  return new Proxy(db, { get(t, k) { if (k === "prepare") return (sql) => (re.test(sql) ? boom() : t.prepare(sql)); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
}
// A database whose batches fail with `message` (a write failing).
function batchFails(db, message) {
  return new Proxy(db, { get(t, k) { if (k === "batch") return async () => { throw new Error(message); }; const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
}
// A database that runs `before` once, just before its next batch: another writer getting in between a read and a write.
function racing(db, before) {
  let done = false;
  return new Proxy(db, { get(t, k) {
    if (k === "batch") return async (stmts) => { if (!done) { done = true; await before(); } return t.batch(stmts); };
    const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
  } });
}
// A database whose first answer to the statements matching `re` is "no row" (a read that missed a row being written).
function missesOnce(db, re) {
  let missed = false;
  const none = () => { const s = { bind: () => s, first: async () => null }; return s; };
  return new Proxy(db, { get(t, k) { if (k === "prepare") return (sql) => { if (!missed && re.test(sql)) { missed = true; return none(); } return t.prepare(sql); }; const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
}
const migrationFiles = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function freshDb(upTo = "9999") {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrationFiles) if (f < upTo) d1.execFile(read("migrations/" + f));
  d1._raw.exec("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t');");
  return d1;
}
// Holds the next calls to crypto.getRandomValues to the bytes given (a card number chosen by the test), then puts it back.
async function withRandom(bytesFor, fn) {
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: (a) => { const b = bytesFor(); for (let i = 0; i < a.length; i++) a[i] = b[i]; return a; } } });
  try { return await fn(); } finally { Object.defineProperty(globalThis, "crypto", real); }
}
const T = (d) => "2026-10-" + String(d).padStart(2, "0") + "T12:00:00.000Z";
const NOT_RIGHT = "That gift card number isn't right.", EMPTY = "This gift card has no balance left.";
const NOT_READY = "Gift cards need the latest database update. Apply the migrations, then try again.";

(async () => {
  console.log("=== The card number ===");
  {
    const A = lib.GIFT_CARD_ALPHABET;
    ok("the alphabet is the 32 letters and digits that can't be misread: A to Z without I and O, and 2 to 9", A === "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" && A.length === 32);
    const codes = Array.from({ length: 300 }, () => lib.generateGiftCardCode_());
    ok("a new number is 16 characters, every one from that alphabet", codes.every(c => c.length === 16 && [...c].every(ch => A.includes(ch))));
    ok("no number has a 0, O, 1 or I in it", codes.every(c => !/[0O1I]/.test(c)));
    ok("numbers come out different each time", new Set(codes).size === codes.length);
    const fixed = await withRandom(() => Array.from({ length: 16 }, (_, i) => i * 2 + (i % 2 ? 32 : 0)), () => lib.generateGiftCardCode_());
    ok("each random byte picks the character at its value modulo 32 (so every character is as likely)", fixed === Array.from({ length: 16 }, (_, i) => A[(i * 2) % 32]).join(""));
    ok("the number comes from the secure random source", (await withRandom(() => new Array(16).fill(255), () => lib.generateGiftCardCode_())) === "9".repeat(16));

    ok("a number typed in lower case with dashes and spaces is read as the plain number", lib.normalizeGiftCardCode_(" abcd-efgh jklm-npqr ") === "ABCDEFGHJKLMNPQR");
    ok("a number one character short is not a number", lib.normalizeGiftCardCode_("ABCDEFGHJKLMNPQ") === "");
    ok("a number one character long is not a number", lib.normalizeGiftCardCode_("ABCDEFGHJKLMNPQRS") === "");
    ok("a number with a look-alike (O, I, 0 or 1) is not a number", ["ABCDEFGHJKLMNPQO", "ABCDEFGHJKLMNPQI", "ABCDEFGHJKLMNPQ0", "ABCDEFGHJKLMNPQ1"].every(c => lib.normalizeGiftCardCode_(c) === ""));
    ok("other punctuation is not stripped (a dot makes it no number)", lib.normalizeGiftCardCode_("ABCD.EFGH.JKLM.NPQR") === "");
    ok("nothing typed is no number", lib.normalizeGiftCardCode_(null) === "" && lib.normalizeGiftCardCode_(undefined) === "" && lib.normalizeGiftCardCode_("") === "");
    ok("a number is shown in four groups of four", lib.formatGiftCardCode_("ABCDEFGHJKLMNPQR") === "ABCD-EFGH-JKLM-NPQR");
    ok("an empty number is shown as nothing, with no dash", lib.formatGiftCardCode_("") === "" && lib.formatGiftCardCode_(null) === "");

    ok("the Gift card payment method is on when Global settings never saved it", lib.giftCardPaymentOn(undefined) === true && lib.giftCardPaymentOn(null) === true && lib.giftCardPaymentOn({}) === true);
    ok("it is on when saved as on, and off only when saved as off", lib.giftCardPaymentOn({ giftCard: true }) === true && lib.giftCardPaymentOn({ giftCard: false }) === false);
  }

  const d1 = await freshDb();
  const q = (sql, ...p) => d1.q(sql, ...p);
  const q1 = (sql, ...p) => q(sql, ...p)[0] || null;
  const bal = (id) => q1("SELECT balanceCents b FROM gift_cards WHERE id=?", id).b;
  const ledgerN = (id) => q1("SELECT count(*) n FROM gift_card_ledger WHERE cardId=?", id).n;
  // An order in Example Club for `dollars` of untaxed goods, unpaid.
  async function order(id, dollars) {
    await lib.insertOrder(d1, { orderId: id, orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: T(1) },
      [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", qty: 1, unitPrice: dollars, taxable: false }]);
    return id;
  }
  const owed = async (id) => (await lib.getOrderCheckoutState(d1, id)).total;
  const issue = (cents, extra = {}) => lib.issueGiftCard(d1, { amountCents: cents, recipientName: "Sam Example", recipientEmail: "sam@example.com", by: "olive@example.com", now: T(2), ...extra });

  console.log("\n=== Issuing a card ===");
  {
    ok("under $1 is refused", (await issue(99)).error === "A gift card is from $1 to $1,000,000.");
    ok("over $1,000,000 is refused", (await issue(100000001)).error === "A gift card is from $1 to $1,000,000.");
    ok("a part of a cent, nothing and words are refused", (await issue(150.5)).error && (await issue(undefined)).error && (await issue("ten")).error);
    ok("none of those refusals made a card", q1("SELECT count(*) n FROM gift_cards").n === 0);
    ok("a recipient email that isn't an address is refused", (await issue(5000, { recipientEmail: "not an address" })).error === "The recipient's email address doesn't look right.");
    ok("a buyer email that isn't an address is refused", (await issue(5000, { buyerEmail: "nope" })).error === "The buyer's email address doesn't look right.");
    const lo = await issue(100, { recipientEmail: "", recipientName: "" });
    ok("$1 is the least a card can be", lo.created === true && lo.balanceCents === 100);
    const hi = await issue(100000000);
    ok("$1,000,000 is the most", hi.created === true && hi.balanceCents === 100000000);
    const c = await issue(5000, { recipientName: "  Sam Example  ", recipientEmail: " Sam@Example.COM ", buyerName: "Pat Example", buyerEmail: "PAT@example.com",
      message: "x".repeat(400), note: "n".repeat(600) });
    ok("a card answers its id, the full number (shown once), its last 4 and balance, and that it was made", c.created === true && c.id > 0 &&
      /^[A-HJ-NP-Z2-9]{16}$/.test(c.code) && c.last4 === c.code.slice(-4) && c.balanceCents === 5000);
    const row = q1("SELECT * FROM gift_cards WHERE id=?", c.id);
    ok("it is stored active with the full balance, the number and its last 4", row.status === "active" && row.initialCents === 5000 && row.balanceCents === 5000 && row.code === c.code && row.last4 === c.last4);
    ok("names are trimmed and emails kept in lower case", row.recipientName === "Sam Example" && row.recipientEmail === "sam@example.com" && row.buyerEmail === "pat@example.com");
    ok("the message is cut to 300 characters and the note to 500", row.message.length === 300 && row.note.length === 500);
    ok("who made it and when are kept", row.createdBy === "olive@example.com" && row.createdAt === T(2) && row.sourceOrderId === "");
    const led = q("SELECT * FROM gift_card_ledger WHERE cardId=?", c.id);
    ok("the ledger has one 'issue' row for the whole amount, “Issued”, no order", led.length === 1 && led[0].kind === "issue" && led[0].deltaCents === 5000 &&
      led[0].note === "Issued" && led[0].orderId === "" && led[0].paymentId === null && led[0].by === "olive@example.com" && led[0].at === T(2));

    const sold = await issue(2500, { sourceOrderId: "CLUB-GC-1", buyerName: "Pat Example" });
    ok("a card sold online is made once, for that order", sold.created === true);
    ok("its ledger row says “Sold online” and names the order", same(q("SELECT kind, deltaCents d, orderId, note FROM gift_card_ledger WHERE cardId=?", sold.id), [{ kind: "issue", d: 2500, orderId: "CLUB-GC-1", note: "Sold online" }]));
    const again = await issue(9900, { sourceOrderId: "CLUB-GC-1" });
    ok("the same order a second time (a webhook replay) answers the first card, not made again", again.created === false && again.id === sold.id && again.code === sold.code && again.balanceCents === 2500);
    const replay = await lib.issueGiftCard(batchFails(d1, "no writes"), { amountCents: 2500, sourceOrderId: "CLUB-GC-1" });
    ok("a replay finds the card before writing anything", replay.created === false && replay.id === sold.id);
    ok("and there is still one card for that order, with one ledger row", q1("SELECT count(*) n FROM gift_cards WHERE sourceOrderId='CLUB-GC-1'").n === 1 && ledgerN(sold.id) === 1);

    // Two deliveries of one payment racing: the second read missed the first's card, so its insert hits the unique index.
    const raced = await lib.issueGiftCard(missesOnce(d1, /SELECT \* FROM gift_cards WHERE sourceOrderId/), { amountCents: 2500, sourceOrderId: "CLUB-GC-1", now: T(2) });
    ok("two webhook deliveries racing make one card: the second answers the first one", raced.created === false && raced.id === sold.id && q1("SELECT count(*) n FROM gift_cards WHERE sourceOrderId='CLUB-GC-1'").n === 1);

    // A number already taken is tried again with a new one; five taken numbers in a row give up.
    const takenBytes = [...c.code].map(ch => lib.GIFT_CARD_ALPHABET.indexOf(ch));
    let calls = 0;
    const retry = await withRandom(() => (++calls === 1 ? takenBytes : new Array(16).fill(calls)), () => issue(700));
    ok("a number that is already some card's is not used: another is made", retry.created === true && retry.code !== c.code && calls === 2);
    const before = q1("SELECT count(*) n FROM gift_cards").n;
    const stuck = await withRandom(() => takenBytes, () => issue(700));
    ok("after five taken numbers in a row it says so and makes nothing", stuck.error === "Couldn't make a card number that isn't taken. Try again." && q1("SELECT count(*) n FROM gift_cards").n === before);
    const e = await rejects(lib.issueGiftCard(batchFails(d1, "disk full"), { amountCents: 500 }));
    ok("a database failure that is not a taken number is passed on", !!e && e.message === "disk full");
  }

  console.log("\n=== Reading a card ===");
  {
    const c = await issue(4000, { recipientName: "Robin Example", recipientEmail: "robin@example.com", message: "Happy birthday", now: T(3) });
    const g = await lib.getGiftCard(d1, { id: c.id });
    ok("a card reads its last 4 behind a masked number, its amounts in dollars and cents, and who it is for", g.id === c.id && g.last4 === c.last4 &&
      g.codeMasked === "••••-••••-••••-" + c.last4 && g.initial === 40 && g.balance === 40 && g.initialCents === 4000 && g.balanceCents === 4000 &&
      g.recipientName === "Robin Example" && g.recipientEmail === "robin@example.com" && g.message === "Happy birthday" && g.status === "active" &&
      g.createdAt === T(3) && g.createdBy === "olive@example.com" && g.voidedAt === null && g.sourceOrderId === "");
    ok("the full number is nowhere in what a card reads", !JSON.stringify(g).includes(c.code) && !JSON.stringify(g).includes(c.code.slice(0, 12)));
    ok("a card is found by its number typed in lower case with dashes", (await lib.getGiftCard(d1, { code: lib.formatGiftCardCode_(c.code).toLowerCase() })).id === c.id);
    ok("an id that is no card, zero, negative or not a number finds nothing", (await lib.getGiftCard(d1, { id: 99999 })) === null && (await lib.getGiftCard(d1, { id: 0 })) === null &&
      (await lib.getGiftCard(d1, { id: -2 })) === null && (await lib.getGiftCard(d1, { id: "abc" })) === null && (await lib.getGiftCard(d1, { id: 1.5 })) === null);
    ok("a number that isn't a number, or nothing at all, finds nothing", (await lib.getGiftCard(d1, { code: "ABCD" })) === null && (await lib.getGiftCard(d1)) === null);
    ok("an empty id falls back to the number", (await lib.getGiftCard(d1, { id: "", code: c.code })).id === c.id);
    ok("Show gives the full number in groups of four", (await lib.revealGiftCardCode(d1, c.id)) === lib.formatGiftCardCode_(c.code));
    ok("Show on no card gives nothing", (await lib.revealGiftCardCode(d1, 99999)) === null);
    q("UPDATE gift_cards SET status='void', voidedAt=? WHERE id=?", T(4), c.id);
    const v = await lib.getGiftCard(d1, { id: c.id });
    ok("a void card reads void with when", v.status === "void" && v.voidedAt === T(4));
    q("UPDATE gift_cards SET status='active', voidedAt=NULL WHERE id=?", c.id);
    ok("a database failure reading a card is passed on", ((await rejects(lib.getGiftCard(failing(d1, /FROM gift_cards/, "disk full"), { id: c.id }))) || {}).message === "disk full");
    ok("and showing its number too", ((await rejects(lib.revealGiftCardCode(failing(d1, /FROM gift_cards/, "disk full"), c.id))) || {}).message === "disk full");

    const led = await lib.giftCardLedger(d1, c.id);
    ok("its history reads the issue row in dollars and cents", led.length === 1 && led[0].kind === "issue" && led[0].delta === 40 && led[0].deltaCents === 4000 &&
      led[0].paymentId === null && led[0].orderId === "" && led[0].note === "Issued" && led[0].at === T(3) && led[0].by === "olive@example.com");
    ok("the history of no card, or of an id that isn't one, is empty", same(await lib.giftCardLedger(d1, 99999), []) && same(await lib.giftCardLedger(d1, 0), []) && same(await lib.giftCardLedger(d1, "x"), []));
    ok("a database failure reading the history is passed on", ((await rejects(lib.giftCardLedger(failing(d1, /FROM gift_card_ledger/, "disk full"), c.id))) || {}).message === "disk full");
  }

  console.log("\n=== The Gift cards list ===");
  {
    const L = await freshDb();
    const add = (cents, extra) => lib.issueGiftCard(L, { amountCents: cents, now: T(5), ...extra });
    const a = await add(1000, { recipientName: "Alex Example", recipientEmail: "alex@example.com", now: T(5) });
    const b = await add(2000, { buyerName: "Blair Example", buyerEmail: "blair@example.com", now: T(6) });
    const c = await add(3000, { sourceOrderId: "CLUB-GC-77", now: T(7) });
    const d = await add(4000, { now: T(7) });
    L.q("UPDATE gift_cards SET balanceCents = 0 WHERE id=?", b.id);
    L.q("UPDATE gift_cards SET status='void', balanceCents = 0 WHERE id=?", c.id);
    const ids = (r) => r.cards.map(x => x.id);
    const all = await lib.listGiftCards(L);
    ok("all cards, newest first (and the later one first on the same moment)", same(ids(all), [d.id, c.id, b.id, a.id]) && all.total === 4);
    ok("each card in the list is masked", all.cards.every(x => x.codeMasked.startsWith("••••-") && !("code" in x)));
    ok("Active is cards with something left", same(ids(await lib.listGiftCards(L, { status: "active" })), [d.id, a.id]));
    ok("Used up is active cards with nothing left", same(ids(await lib.listGiftCards(L, { status: "empty" })), [b.id]));
    ok("Void is void cards", same(ids(await lib.listGiftCards(L, { status: "void" })), [c.id]));
    ok("an empty status is all", (await lib.listGiftCards(L, { status: "" })).total === 4);
    ok("a status that isn't one finds nothing", same(await lib.listGiftCards(L, { status: "lost" }), { cards: [], total: 0 }));
    ok("search finds a card by its last 4, in any case", same(ids(await lib.listGiftCards(L, { q: a.last4.toLowerCase() })), [a.id]));
    ok("by the recipient's name and email", same(ids(await lib.listGiftCards(L, { q: "ALEX ex" })), [a.id]) && same(ids(await lib.listGiftCards(L, { q: "alex@" })), [a.id]));
    ok("by the buyer's name and email", same(ids(await lib.listGiftCards(L, { q: "blair EX" })), [b.id]) && same(ids(await lib.listGiftCards(L, { q: "blair@example" })), [b.id]));
    ok("by the order that sold it", same(ids(await lib.listGiftCards(L, { q: "gc-77" })), [c.id]));
    ok("search and status together", same(ids(await lib.listGiftCards(L, { q: "example", status: "active" })), [a.id]));
    ok("a search with spaces round it is trimmed; nothing but spaces is no search", same(ids(await lib.listGiftCards(L, { q: "  alex  " })), [a.id]) && (await lib.listGiftCards(L, { q: "   " })).total === 4);
    ok("a search that matches nothing finds nothing, total 0", same(await lib.listGiftCards(L, { q: "nobody" }), { cards: [], total: 0 }));
    const p = await lib.listGiftCards(L, { limit: 2, offset: 1 });
    ok("a page: limit and offset, with the total of all that match", same(ids(p), [c.id, b.id]) && p.total === 4);
    ok("a negative or nonsense offset starts at the top", same(ids(await lib.listGiftCards(L, { limit: 1, offset: -5 })), [d.id]) && same(ids(await lib.listGiftCards(L, { limit: 1, offset: "x" })), [d.id]));
    for (let i = 0; i < 205; i++) L.q("INSERT INTO gift_cards (code, last4, initialCents, balanceCents, createdAt) VALUES (?, ?, 500, 500, ?)", "BULK" + String(i).padStart(12, "0"), "B" + i, T(1));
    ok("a page is at most 200 cards", (await lib.listGiftCards(L, { limit: 500 })).cards.length === 200);
    ok("a limit of 0 or nonsense is 50", (await lib.listGiftCards(L, { limit: 0 })).cards.length === 50 && (await lib.listGiftCards(L, { limit: "x" })).cards.length === 50);
    ok("a negative limit is 1", (await lib.listGiftCards(L, { limit: -3 })).cards.length === 1);
    ok("a database failure listing is passed on", ((await rejects(lib.listGiftCards(failing(L, /FROM gift_cards g/, "disk full")))) || {}).message === "disk full");
  }

  console.log("\n=== Checking a number (what a customer is told) ===");
  {
    const c = await issue(1500);
    const r = await lib.checkGiftCard(d1, lib.formatGiftCardCode_(c.code).toLowerCase());
    ok("a good card answers its id, last 4 and balance in dollars and cents", same(r, { ok: true, card: { id: c.id, last4: c.last4, balance: 15, balanceCents: 1500 } }));
    const unknown = await lib.checkGiftCard(d1, "ABCDEFGHJKLMNPQR"), garbage = await lib.checkGiftCard(d1, "hello");
    q("UPDATE gift_cards SET status='void' WHERE id=?", c.id);
    const voided = await lib.checkGiftCard(d1, c.code);
    ok("an unknown number, a number that isn't one and a void card all say the same thing", unknown.reason === NOT_RIGHT && garbage.reason === NOT_RIGHT && voided.reason === NOT_RIGHT &&
      same(unknown, voided) && unknown.ok === false && !("card" in voided));
    q("UPDATE gift_cards SET status='active', balanceCents=0 WHERE id=?", c.id);
    ok("a card with nothing left says so", same(await lib.checkGiftCard(d1, c.code), { ok: false, reason: EMPTY }));
    ok("a database failure checking is passed on", ((await rejects(lib.checkGiftCard(failing(d1, /FROM gift_cards/, "disk full"), c.code))) || {}).message === "disk full");
  }

  console.log("\n=== Spending a card on an order ===");
  {
    const c = await issue(5000);
    await order("O1", 30);
    const r = await lib.redeemGiftCard(d1, { code: c.code, orderId: "O1", by: "olive@example.com", now: T(8) });
    ok("with no amount it takes what the order owes ($30 of a $50 card)", r.ok === true && r.takenCents === 3000 && r.balanceCents === 2000 && r.last4 === c.last4 && r.paymentId > 0);
    ok("the card is down to $20", bal(c.id) === 2000);
    const pay = q1("SELECT * FROM order_payments WHERE id=?", r.paymentId);
    ok("the payment is method other, the card's id, “Gift card ••” and its last 4, “Paid by gift card”, no account, no fee", pay.orderId === "O1" && pay.amountCents === 3000 &&
      pay.method === "other" && pay.giftCardId === c.id && pay.reference === "Gift card ••" + c.last4 && pay.note === "Paid by gift card" &&
      pay.accountId === null && pay.feeCents === 0 && pay.kind === "payment" && pay.receivedAt === T(8) && pay.externalRef === "" && pay.requestKey === null);
    const led = q("SELECT * FROM gift_card_ledger WHERE cardId=? AND kind='redeem'", c.id);
    ok("the ledger has a 'redeem' row taking $30, for that order and that payment", led.length === 1 && led[0].deltaCents === -3000 && led[0].orderId === "O1" &&
      led[0].paymentId === r.paymentId && led[0].note === "Order O1" && led[0].by === "olive@example.com" && led[0].at === T(8));
    ok("the order is paid in full", q1("SELECT paid FROM orders WHERE orderId='O1'").paid === 1 && (await owed("O1")) === 0);
    ok("a paid order owes nothing more", same(await lib.redeemGiftCard(d1, { code: c.code, orderId: "O1" }), { ok: false, reason: "Nothing is owed on this order." }));

    await order("O2", 80);
    const r2 = await lib.redeemGiftCard(d1, { cardId: c.id, orderId: "O2", now: T(8) });
    ok("by the card's id, a card worth less than the order takes all it has ($20 of $80)", r2.ok && r2.takenCents === 2000 && r2.balanceCents === 0);
    ok("and the order is not yet paid, $60 still owed", q1("SELECT paid FROM orders WHERE orderId='O2'").paid === 0 && (await owed("O2")) === 60);
    ok("an empty card is refused as empty", same(await lib.redeemGiftCard(d1, { cardId: c.id, orderId: "O2" }), { ok: false, reason: EMPTY }));

    const c2 = await issue(10000);
    const r3 = await lib.redeemGiftCard(d1, { code: c2.code, orderId: "O2", amountCents: 1500 });
    ok("an amount asked takes just that ($15)", r3.ok && r3.takenCents === 1500 && bal(c2.id) === 8500 && (await owed("O2")) === 45);
    ok("an amount as words of cents is rounded", (await lib.redeemGiftCard(d1, { code: c2.code, orderId: "O2", amountCents: "250.4" })).takenCents === 250);
    ok("an amount of 0 is refused", (await lib.redeemGiftCard(d1, { code: c2.code, orderId: "O2", amountCents: 0 })).reason === "Enter an amount to take from the gift card.");
    ok("a negative or nonsense amount is refused", (await lib.redeemGiftCard(d1, { code: c2.code, orderId: "O2", amountCents: -100 })).reason === "Enter an amount to take from the gift card." &&
      (await lib.redeemGiftCard(d1, { code: c2.code, orderId: "O2", amountCents: "lots" })).reason === "Enter an amount to take from the gift card.");
    ok("an empty amount is the most it can", (await lib.redeemGiftCard(d1, { code: c2.code, orderId: "O2", amountCents: "" })).takenCents === 4250 && (await owed("O2")) === 0);
    ok("more than the order owes is cut to what it owes", (await (async () => { await order("O3", 10); return lib.redeemGiftCard(d1, { code: c2.code, orderId: "O3", amountCents: 999999 }); })()).takenCents === 1000);
    ok("an order that isn't there is refused", same(await lib.redeemGiftCard(d1, { code: c2.code, orderId: "NOPE" }), { ok: false, reason: "That order wasn't found." }));
    ok("an order with no id is refused the same", (await lib.redeemGiftCard(d1, { code: c2.code })).reason === "That order wasn't found.");
    await order("OV", 10); q("UPDATE orders SET voidedAt=? WHERE orderId='OV'", T(9));
    ok("a voided order is refused", same(await lib.redeemGiftCard(d1, { code: c2.code, orderId: "OV" }), { ok: false, reason: "This order is voided." }));
    ok("an unknown number is refused as not right", same(await lib.redeemGiftCard(d1, { code: "ABCDEFGHJKLMNPQR", orderId: "O3" }), { ok: false, reason: NOT_RIGHT }));
    const vc = await issue(1000); q("UPDATE gift_cards SET status='void' WHERE id=?", vc.id);
    ok("a void card is refused as not right", same(await lib.redeemGiftCard(d1, { cardId: vc.id, orderId: "O3" }), { ok: false, reason: NOT_RIGHT }));
    ok("none of the refusals wrote a payment or a ledger row", q1("SELECT count(*) n FROM order_payments WHERE orderId IN ('OV','NOPE')").n === 0 && ledgerN(vc.id) === 1);

    console.log("\n=== The same Save twice (requestKey) ===");
    const c3 = await issue(5000);
    await order("O4", 40);
    const k1 = await lib.redeemGiftCard(d1, { code: c3.code, orderId: "O4", amountCents: 1000, requestKey: "giftcard:req-1" });
    const k2 = await lib.redeemGiftCard(d1, { code: c3.code, orderId: "O4", amountCents: 1000, requestKey: "giftcard:req-1" });
    ok("the first takes $10 and keeps the key on the payment", k1.ok && k1.takenCents === 1000 && q1("SELECT requestKey k FROM order_payments WHERE id=?", k1.paymentId).k === "giftcard:req-1");
    ok("the second answers the first, marked a duplicate, taking nothing", k2.ok && k2.duplicate === true && k2.paymentId === k1.paymentId && k2.takenCents === 1000 && k2.balanceCents === 4000 && k2.last4 === c3.last4);
    ok("one payment, one redeem row, $10 off the card", q1("SELECT count(*) n FROM order_payments WHERE orderId='O4'").n === 1 && bal(c3.id) === 4000 &&
      q1("SELECT count(*) n FROM gift_card_ledger WHERE cardId=? AND kind='redeem'", c3.id).n === 1);
    ok("a key over 100 characters is cut to 100", (await lib.redeemGiftCard(d1, { code: c3.code, orderId: "O4", amountCents: 100, requestKey: "k".repeat(150) })).ok &&
      q1("SELECT count(*) n FROM order_payments WHERE requestKey=?", "k".repeat(100)).n === 1);
    // The key's payment lands between the read and the write (a double click's twin): nothing is taken twice.
    const twin = await lib.redeemGiftCard(racing(d1, async () => {
      q("INSERT INTO order_payments (orderId, amountCents, note, receivedAt, method, kind, requestKey) VALUES ('O4', 100, 'x', ?, 'cash', 'payment', 'giftcard:req-2')", T(9));
    }), { code: c3.code, orderId: "O4", amountCents: 500, requestKey: "giftcard:req-2" });
    ok("a Save whose twin lands first takes nothing from the card", twin.ok === false && bal(c3.id) === 3900 && q1("SELECT count(*) n FROM order_payments WHERE requestKey='giftcard:req-2'").n === 1);

    console.log("\n=== Two spends racing for one card ===");
    const c4 = await issue(5000);
    await order("RA", 30); await order("RB", 40);
    const loser = await lib.redeemGiftCard(racing(d1, () => lib.redeemGiftCard(d1, { code: c4.code, orderId: "RA" })), { code: c4.code, orderId: "RB" });
    ok("the spend that lands first takes $30", bal(c4.id) === 2000 && (await owed("RA")) === 0);
    ok("the other, which read $50 left, is refused: the card doesn't have enough left", same(loser, { ok: false, reason: "This gift card doesn't have enough left." }));
    ok("and it wrote nothing: no payment on its order, no ledger row", q1("SELECT count(*) n FROM order_payments WHERE orderId='RB'").n === 0 &&
      q1("SELECT count(*) n FROM gift_card_ledger WHERE cardId=? AND kind='redeem'", c4.id).n === 1 && (await owed("RB")) === 40);
    const c5 = await issue(3000);
    await order("RC", 30); await order("RD", 30);
    const late = await lib.redeemGiftCard(racing(d1, () => lib.redeemGiftCard(d1, { code: c5.code, orderId: "RC" })), { code: c5.code, orderId: "RD" });
    ok("when the first spend took it all, the other is told the card has nothing left", same(late, { ok: false, reason: EMPTY }) && bal(c5.id) === 0);
    const c6 = await issue(3000);
    await order("RE", 20);
    const gone = await lib.redeemGiftCard(racing(d1, async () => { q("UPDATE gift_cards SET status='void', balanceCents=0 WHERE id=?", c6.id); }), { code: c6.code, orderId: "RE" });
    ok("a card voided between the read and the write is refused as not right", same(gone, { ok: false, reason: NOT_RIGHT }) && (await owed("RE")) === 20);
    const c7 = await issue(3000);
    const changed = await lib.redeemGiftCard(racing(d1, async () => {
      q("INSERT INTO order_payments (orderId, amountCents, note, receivedAt, method, kind) VALUES ('RE', 500, 'cash', ?, 'cash', 'payment')", T(9));
    }), { code: c7.code, orderId: "RE" });
    ok("a payment landing on the order in between: “That order just changed.”, nothing taken", same(changed, { ok: false, reason: "That order just changed. Try again." }) && bal(c7.id) === 3000 &&
      q1("SELECT count(*) n FROM order_payments WHERE giftCardId=?", c7.id).n === 0);
    ok("a database failure spending is passed on", ((await rejects(lib.redeemGiftCard(failing(d1, /FROM gift_cards/, "disk full"), { code: c7.code, orderId: "RE" }))) || {}).message === "disk full");

    console.log("\n=== Voiding a gift-card payment ===");
    const c8 = await issue(5000);
    await order("V1", 30);
    const p8 = await lib.redeemGiftCard(d1, { code: c8.code, orderId: "V1" });
    ok("voiding the payment answers its order", (await lib.voidPayment(d1, p8.paymentId, "Wrong card")) === "V1");
    ok("puts its $30 back on the card", bal(c8.id) === 5000);
    const back = q("SELECT * FROM gift_card_ledger WHERE cardId=? AND kind='refund'", c8.id);
    ok("with a ledger 'refund' row, “Payment voided”, naming the order and the payment", back.length === 1 && back[0].deltaCents === 3000 && back[0].note === "Payment voided" &&
      back[0].orderId === "V1" && back[0].paymentId === p8.paymentId);
    ok("the order owes it again", q1("SELECT paid FROM orders WHERE orderId='V1'").paid === 0 && (await owed("V1")) === 30);
    await lib.voidPayment(d1, p8.paymentId, "again");
    ok("voiding it a second time puts nothing more back", bal(c8.id) === 5000 && q1("SELECT count(*) n FROM gift_card_ledger WHERE cardId=? AND kind='refund'", c8.id).n === 1);
    const p9 = await lib.redeemGiftCard(d1, { code: c8.code, orderId: "V1", amountCents: 1000 });
    q("UPDATE gift_cards SET status='void', balanceCents=0 WHERE id=?", c8.id);
    await lib.voidPayment(d1, p9.paymentId, "x");
    ok("a payment from a card voided since is voided, and the void card gets nothing", q1("SELECT voidedAt v FROM order_payments WHERE id=?", p9.paymentId).v !== null && bal(c8.id) === 0 &&
      q1("SELECT count(*) n FROM gift_card_ledger WHERE cardId=? AND kind='refund'", c8.id).n === 1);
    const cash = await lib.addOrderPayment(d1, "V1", 5, "cash", "", { method: "cash" });
    const ledBefore = q1("SELECT count(*) n FROM gift_card_ledger").n;
    await lib.voidPayment(d1, cash, "x");
    ok("voiding a payment that isn't a gift card's touches no card", q1("SELECT count(*) n FROM gift_card_ledger").n === ledBefore && q1("SELECT voidedAt v FROM order_payments WHERE id=?", cash).v !== null);
    ok("voiding a payment that isn't there answers nothing", (await lib.voidPayment(d1, 999999, "x")) === null);

    console.log("\n=== Refunding to a card ===");
    const g = await issue(5000);
    await order("F1", 40);
    const pf = await lib.redeemGiftCard(d1, { code: g.code, orderId: "F1", now: T(10) });
    const f1 = await lib.refundToGiftCard(d1, { paymentId: pf.paymentId, amountCents: 1500, by: "olive@example.com", now: T(11) });
    ok("a refund of $15 puts it back on the card", f1.ok && f1.refundedCents === 1500 && f1.balanceCents === 2500 && bal(g.id) === 2500);
    const rr = q1("SELECT * FROM order_payments WHERE id=?", f1.refundPaymentId);
    ok("as a negative refund row with the same card, no account, tagged with the payment it refunds", rr.kind === "refund" && rr.amountCents === -1500 && rr.giftCardId === g.id &&
      rr.accountId === null && rr.method === "other" && rr.externalRef.startsWith("gcpay:" + pf.paymentId + ":") && rr.reference === "Gift card ••" + g.last4 && rr.note === "Refunded to gift card" && rr.receivedAt === T(11));
    const rl = q("SELECT * FROM gift_card_ledger WHERE cardId=? AND kind='refund'", g.id);
    ok("and a ledger 'refund' row naming the refund row and the order", rl.length === 1 && rl[0].deltaCents === 1500 && rl[0].paymentId === f1.refundPaymentId &&
      rl[0].orderId === "F1" && rl[0].note === "Refund of order F1" && rl[0].by === "olive@example.com" && rl[0].at === T(11));
    ok("more than is left to give back is refused", same(await lib.refundToGiftCard(d1, { paymentId: pf.paymentId, amountCents: 2600 }), { ok: false, reason: "That's more than this gift card payment has left to give back." }));
    ok("0, negative or nonsense is refused", (await lib.refundToGiftCard(d1, { paymentId: pf.paymentId, amountCents: 0 })).reason === "Enter an amount to put back on the gift card." &&
      (await lib.refundToGiftCard(d1, { paymentId: pf.paymentId, amountCents: -5 })).reason === "Enter an amount to put back on the gift card." &&
      (await lib.refundToGiftCard(d1, { paymentId: pf.paymentId, amountCents: "x" })).reason === "Enter an amount to put back on the gift card.");
    const f2 = await lib.refundToGiftCard(d1, { paymentId: pf.paymentId });
    ok("with no amount, all that is left of the payment goes back ($25)", f2.ok && f2.refundedCents === 2500 && bal(g.id) === 5000);
    ok("a second refund of the same payment is its own row with its own tag (the tag is unique)", q1("SELECT count(DISTINCT externalRef) n FROM order_payments WHERE giftCardId=? AND kind='refund'", g.id).n === 2);
    ok("then the payment has nothing left to give back", same(await lib.refundToGiftCard(d1, { paymentId: pf.paymentId, amountCents: 1 }), { ok: false, reason: "This gift card payment has already been given back." }));
    const cashF = await lib.addOrderPayment(d1, "F1", 1, "cash", "", { method: "cash" });
    ok("a payment that isn't a gift card's is refused", (await lib.refundToGiftCard(d1, { paymentId: cashF })).reason === "That payment wasn't paid by a gift card.");
    ok("a refund row, a payment not there and a voided payment are refused the same", (await lib.refundToGiftCard(d1, { paymentId: f1.refundPaymentId })).reason === "That payment wasn't paid by a gift card." &&
      (await lib.refundToGiftCard(d1, { paymentId: 999999 })).reason === "That payment wasn't paid by a gift card." &&
      (await lib.refundToGiftCard(d1, { paymentId: p8.paymentId })).reason === "That payment wasn't paid by a gift card.");
    const g2 = await issue(5000); await order("F2", 20);
    const pg2 = await lib.redeemGiftCard(d1, { code: g2.code, orderId: "F2" });
    q("UPDATE gift_cards SET status='void', balanceCents=0 WHERE id=?", g2.id);
    ok("a voided card gets nothing back", same(await lib.refundToGiftCard(d1, { paymentId: pg2.paymentId }), { ok: false, reason: "This gift card has been voided, so nothing can be put back on it." }));
    q("PRAGMA foreign_keys = OFF"); q("UPDATE order_payments SET giftCardId = 88888 WHERE id=?", pg2.paymentId);
    ok("a payment whose card is gone is refused as not right", same(await lib.refundToGiftCard(d1, { paymentId: pg2.paymentId }), { ok: false, reason: NOT_RIGHT }));
    q("UPDATE order_payments SET giftCardId = ? WHERE id=?", g2.id, pg2.paymentId); q("PRAGMA foreign_keys = ON");
    const g3 = await issue(5000); await order("F3", 20);
    const pg3 = await lib.redeemGiftCard(d1, { code: g3.code, orderId: "F3" });
    const racedR = await lib.refundToGiftCard(racing(d1, () => lib.voidPayment(d1, pg3.paymentId, "x")), { paymentId: pg3.paymentId, amountCents: 500 });
    ok("a payment voided in between: refused, “just changed”, and only the void's money went back", same(racedR, { ok: false, reason: "That payment was just changed. Reload and try again." }) && bal(g3.id) === 5000);
    const g4 = await issue(5000); await order("F4", 20);
    const pg4 = await lib.redeemGiftCard(d1, { code: g4.code, orderId: "F4" });
    const racedR2 = await lib.refundToGiftCard(racing(d1, () => lib.refundToGiftCard(d1, { paymentId: pg4.paymentId, amountCents: 1500 })), { paymentId: pg4.paymentId, amountCents: 1000 });
    ok("two refunds racing past the payment: the second is refused, the card gets $15 not $25", racedR2.ok === false && bal(g4.id) === 3000 + 1500);
    ok("a database failure refunding is passed on", ((await rejects(lib.refundToGiftCard(failing(d1, /FROM order_payments WHERE id/, "disk full"), { paymentId: pg4.paymentId }))) || {}).message === "disk full");

    console.log("\n=== Voiding a payment that was partly refunded to its card ===");
    const h = await issue(5000); await order("H1", 30);
    const ph = await lib.redeemGiftCard(d1, { code: h.code, orderId: "H1" });
    await lib.refundToGiftCard(d1, { paymentId: ph.paymentId, amountCents: 1000 });
    ok("the card is at $30 after spending $30 and getting $10 back", bal(h.id) === 3000);
    await lib.voidPayment(d1, ph.paymentId, "Wrong card");
    ok("voiding the payment puts back only the $20 not already refunded: the card is whole at $50, not $60", bal(h.id) === 5000 &&
      q1("SELECT deltaCents d FROM gift_card_ledger WHERE cardId=? AND note='Payment voided'", h.id).d === 2000);
    const rowH = q1("SELECT id FROM order_payments WHERE externalRef LIKE ? AND kind='refund'", "gcpay:" + ph.paymentId + ":%").id;
    ok("its refund, with the payment already voided, can still be voided", (await lib.giftCardVoidRefusal(d1, rowH)) === "" && (await lib.voidPayment(d1, rowH, "x")) === "H1");
    ok("and takes nothing off the card: the payment's void settled it", bal(h.id) === 5000 && q1("SELECT count(*) n FROM gift_card_ledger WHERE cardId=? AND note='Refund voided'", h.id).n === 0);
    const h2 = await issue(5000); await order("H2", 30);
    const ph2 = await lib.redeemGiftCard(d1, { code: h2.code, orderId: "H2" });
    await lib.refundToGiftCard(d1, { paymentId: ph2.paymentId });
    await lib.voidPayment(d1, ph2.paymentId, "x");
    ok("a payment refunded in full and then voided puts nothing more back", bal(h2.id) === 5000 && q1("SELECT count(*) n FROM gift_card_ledger WHERE cardId=? AND note='Payment voided'", h2.id).n === 0);

    console.log("\n=== Voiding a refund put on a card ===");
    const k = await issue(5000); await order("K1", 40);
    const pk = await lib.redeemGiftCard(d1, { code: k.code, orderId: "K1" });
    const rk = await lib.refundToGiftCard(d1, { paymentId: pk.paymentId, amountCents: 1500 });
    ok("before: the card has $25 (spent $40, $15 back), and the order still owes nothing (a goodwill refund puts no balance back)", bal(k.id) === 2500 && (await owed("K1")) === 0);
    ok("the Void button has nothing against it while the card has the $15", (await lib.giftCardVoidRefusal(d1, rk.refundPaymentId)) === "");
    ok("voiding the refund answers the order", (await lib.voidPayment(d1, rk.refundPaymentId, "Refunded by mistake")) === "K1");
    ok("takes the $15 back off the card", bal(k.id) === 1000);
    const kl = q("SELECT * FROM gift_card_ledger WHERE cardId=? AND note='Refund voided'", k.id);
    ok("with a ledger 'refund' row of −$15, naming the refund row and the order", kl.length === 1 && kl[0].kind === "refund" && kl[0].deltaCents === -1500 && kl[0].paymentId === rk.refundPaymentId && kl[0].orderId === "K1");
    ok("the refund row is voided with its reason", q1("SELECT voidReason r FROM order_payments WHERE id=? AND voidedAt IS NOT NULL", rk.refundPaymentId).r === "Refunded by mistake");
    await lib.voidPayment(d1, rk.refundPaymentId, "again");
    ok("voiding it again takes nothing more", bal(k.id) === 1000 && q1("SELECT count(*) n FROM gift_card_ledger WHERE cardId=? AND note='Refund voided'", k.id).n === 1);
    ok("the payment can then be refunded again in full ($40)", (await lib.refundToGiftCard(d1, { paymentId: pk.paymentId })).refundedCents === 4000 && bal(k.id) === 5000);

    const m = await issue(5000); await order("M1", 40); await order("M2", 50);
    const pm = await lib.redeemGiftCard(d1, { code: m.code, orderId: "M1" });
    const rm = await lib.refundToGiftCard(d1, { paymentId: pm.paymentId, amountCents: 2000 });
    await lib.redeemGiftCard(d1, { code: m.code, orderId: "M2" });
    ok("the refunded $20 has been spent again: the card has $0", bal(m.id) === 0);
    const why = "The gift card no longer has the $20.00 this refund put on it, so the refund can't be voided.";
    ok("the Void button is refused with a clear reason", (await lib.giftCardVoidRefusal(d1, rm.refundPaymentId)) === why);
    ok("voiding the refund is refused with the same reason", same(await lib.voidPayment(d1, rm.refundPaymentId, "x"), { error: why }));
    ok("and nothing changed: the refund stands, the card is not below 0, no ledger row", q1("SELECT voidedAt v FROM order_payments WHERE id=?", rm.refundPaymentId).v === null &&
      bal(m.id) === 0 && q1("SELECT count(*) n FROM gift_card_ledger WHERE cardId=? AND note='Refund voided'", m.id).n === 0);
    await lib.adjustGiftCard(d1, { id: m.id, deltaCents: 1999, note: "Goodwill" });
    ok("a card a cent short is still refused", (await lib.giftCardVoidRefusal(d1, rm.refundPaymentId)) === why && (await lib.voidPayment(d1, rm.refundPaymentId, "x")).error === why && bal(m.id) === 1999);
    await lib.adjustGiftCard(d1, { id: m.id, deltaCents: 1, note: "Goodwill" });
    ok("with exactly $20 on it the refund can be voided, leaving $0", (await lib.voidPayment(d1, rm.refundPaymentId, "x")) === "M1" && bal(m.id) === 0);

    const n = await issue(5000); await order("N1", 40);
    const pn = await lib.redeemGiftCard(d1, { code: n.code, orderId: "N1" });
    const rn = await lib.refundToGiftCard(d1, { paymentId: pn.paymentId, amountCents: 500 });
    await lib.voidGiftCard(d1, { id: n.id, note: "Lost" });
    ok("a refund on a card voided since is refused: the void card has nothing to give back", (await lib.giftCardVoidRefusal(d1, rn.refundPaymentId)).startsWith("The gift card no longer has the $5.00") &&
      (await lib.voidPayment(d1, rn.refundPaymentId, "x")).error.startsWith("The gift card no longer has the $5.00") && q1("SELECT voidedAt v FROM order_payments WHERE id=?", rn.refundPaymentId).v === null);
    const s = await issue(5000); await order("S1", 40); await order("S2", 50);
    const ps = await lib.redeemGiftCard(d1, { code: s.code, orderId: "S1" });
    const rs = await lib.refundToGiftCard(d1, { paymentId: ps.paymentId, amountCents: 1000 });
    const racedV = await lib.voidPayment(racing(d1, () => lib.redeemGiftCard(d1, { code: s.code, orderId: "S2" })), rs.refundPaymentId, "x");
    ok("the card spent between the check and the void: refused, nothing written", racedV && racedV.error && racedV.error.includes("$10.00") && bal(s.id) === 0 &&
      q1("SELECT voidedAt v FROM order_payments WHERE id=?", rs.refundPaymentId).v === null);
    const s2 = await issue(5000); await order("S3", 40);
    const ps2 = await lib.redeemGiftCard(d1, { code: s2.code, orderId: "S3" });
    const rs2 = await lib.refundToGiftCard(d1, { paymentId: ps2.paymentId, amountCents: 1000 });
    const twinV = await lib.voidPayment(racing(d1, async () => { q("UPDATE order_payments SET voidedAt=?, voidReason='first' WHERE id=?", T(12), rs2.refundPaymentId); }), rs2.refundPaymentId, "second");
    ok("two voids of one refund racing: the second answers the order and takes nothing", twinV === "S3" && bal(s2.id) === 2000 && q1("SELECT voidReason r FROM order_payments WHERE id=?", rs2.refundPaymentId).r === "first");
    const plain = await lib.addOrderPayment(d1, "S3", -2, "refund", "", { method: "cash", kind: "refund" });
    ok("a refund that isn't a gift card's has nothing against voiding it", (await lib.giftCardVoidRefusal(d1, plain)) === "" && (await lib.voidPayment(d1, plain, "x")) === "S3");
    ok("nor does a gift-card payment, an entry not there, or one already voided", (await lib.giftCardVoidRefusal(d1, ps2.paymentId)) === "" &&
      (await lib.giftCardVoidRefusal(d1, 999999)) === "" && (await lib.giftCardVoidRefusal(d1, rs2.refundPaymentId)) === "");
    q("PRAGMA foreign_keys = OFF");
    q("INSERT INTO order_payments (orderId, amountCents, note, receivedAt, method, kind, giftCardId, externalRef) VALUES ('S3', -100, 'x', ?, 'other', 'refund', ?, 'not-a-tag')", T(12), s2.id);
    q("PRAGMA foreign_keys = ON");
    const odd = q1("SELECT id FROM order_payments WHERE externalRef='not-a-tag'").id;
    ok("a card refund row with no payment tag is voided plainly, taking nothing off the card", (await lib.giftCardVoidRefusal(d1, odd)) === "" && (await lib.voidPayment(d1, odd, "x")) === "S3" && bal(s2.id) === 2000);
    ok("a database failure checking a void is passed on", ((await rejects(lib.giftCardVoidRefusal(failing(d1, /FROM order_payments WHERE id/, "disk full"), rs.refundPaymentId))) || {}).message === "disk full");
    ok("and voiding one too", ((await rejects(lib.voidPayment(failing(d1, /SELECT orderId, giftCardId/, "disk full"), rs.refundPaymentId, "x"))) || {}).message === "disk full");
  }

  console.log("\n=== Changing a balance by hand ===");
  {
    const c = await issue(2000);
    ok("no amount, 0, a part of a cent or over $1,000,000 is refused", true &&
      (await lib.adjustGiftCard(d1, { id: c.id, deltaCents: 0, note: "n" })).error === "Enter an amount to add or take off." &&
      (await lib.adjustGiftCard(d1, { id: c.id, deltaCents: 1.5, note: "n" })).error === "Enter an amount to add or take off." &&
      (await lib.adjustGiftCard(d1, { id: c.id, deltaCents: 100000001, note: "n" })).error === "Enter an amount to add or take off." &&
      (await lib.adjustGiftCard(d1, { id: c.id, deltaCents: -100000001, note: "n" })).error === "Enter an amount to add or take off." &&
      (await lib.adjustGiftCard(d1, { id: c.id, note: "n" })).error === "Enter an amount to add or take off.");
    ok("a note is required (spaces are no note)", (await lib.adjustGiftCard(d1, { id: c.id, deltaCents: 100, note: "   " })).error === "Say why the balance is being changed." &&
      (await lib.adjustGiftCard(d1, { id: c.id, deltaCents: 100 })).error === "Say why the balance is being changed.");
    ok("a card not there is refused", (await lib.adjustGiftCard(d1, { id: 99999, deltaCents: 100, note: "n" })).error === "That gift card wasn't found.");
    const up = await lib.adjustGiftCard(d1, { id: c.id, deltaCents: 500, note: "  Goodwill  ", by: "olive@example.com", now: T(13) });
    ok("adding $5 answers the new balance and the card as it was", up.ok && up.balanceCents === 2500 && up.before.balanceCents === 2000 && bal(c.id) === 2500);
    const al = q1("SELECT * FROM gift_card_ledger WHERE cardId=? AND kind='adjust'", c.id);
    ok("with an 'adjust' ledger row carrying the note as the reason", al.deltaCents === 500 && al.note === "Goodwill" && al.by === "olive@example.com" && al.at === T(13) && al.orderId === "" && al.paymentId === null);
    ok("taking off more than it has is refused, and the card stays", (await lib.adjustGiftCard(d1, { id: c.id, deltaCents: -2501, note: "n" })).error === "That's more than the card has left." && bal(c.id) === 2500);
    ok("taking off exactly all of it leaves $0", (await lib.adjustGiftCard(d1, { id: c.id, deltaCents: -2500, note: "Cashed in" })).balanceCents === 0);
    ok("the note is cut to 500 characters", (await lib.adjustGiftCard(d1, { id: c.id, deltaCents: 1, note: "w".repeat(700) })).ok && q1("SELECT max(length(note)) n FROM gift_card_ledger WHERE cardId=?", c.id).n === 500);
    await lib.voidGiftCard(d1, { id: c.id, note: "Lost" });
    ok("a void card can't be changed", (await lib.adjustGiftCard(d1, { id: c.id, deltaCents: 100, note: "n" })).error === "This gift card has been voided.");
    const c2 = await issue(2000);
    const raced = await lib.adjustGiftCard(racing(d1, async () => { q("UPDATE gift_cards SET status='void', balanceCents=0 WHERE id=?", c2.id); }), { id: c2.id, deltaCents: 100, note: "n" });
    ok("a card voided between the read and the write: adding is refused as voided", raced.error === "This gift card has been voided." && bal(c2.id) === 0 && q1("SELECT count(*) n FROM gift_card_ledger WHERE cardId=? AND kind='adjust'", c2.id).n === 0);
    ok("a database failure adjusting is passed on", ((await rejects(lib.adjustGiftCard(failing(d1, /FROM gift_cards/, "disk full"), { id: c2.id, deltaCents: 1, note: "n" }))) || {}).message === "disk full");
  }

  console.log("\n=== Voiding a card ===");
  {
    const c = await issue(3000);
    ok("a reason is required", (await lib.voidGiftCard(d1, { id: c.id })).error === "Say why the gift card is being voided." && (await lib.voidGiftCard(d1, { id: c.id, note: " " })).error === "Say why the gift card is being voided.");
    ok("a card not there is refused", (await lib.voidGiftCard(d1, { id: 99999, note: "x" })).error === "That gift card wasn't found.");
    const v = await lib.voidGiftCard(d1, { id: c.id, note: "Reported stolen", by: "olive@example.com", now: T(14) });
    ok("voiding answers what it held and the card as it was", v.ok && v.voidedCents === 3000 && v.before.status === "active");
    const row = q1("SELECT * FROM gift_cards WHERE id=?", c.id);
    ok("the card is void with nothing left, and when", row.status === "void" && row.balanceCents === 0 && row.voidedAt === T(14));
    ok("a 'void' ledger row takes the $30 with the reason", same(q("SELECT kind, deltaCents d, note, at, by FROM gift_card_ledger WHERE cardId=? AND kind='void'", c.id), [{ kind: "void", d: -3000, note: "Reported stolen", at: T(14), by: "olive@example.com" }]));
    ok("voiding it again is refused", (await lib.voidGiftCard(d1, { id: c.id, note: "x" })).error === "This gift card is already voided.");
    const c2 = await issue(3000);
    const raced = await lib.voidGiftCard(racing(d1, () => lib.voidGiftCard(d1, { id: c2.id, note: "first", now: T(14) })), { id: c2.id, note: "second" });
    ok("two voids racing: the second is refused, one 'void' row", raced.error === "This gift card is already voided." && q1("SELECT count(*) n FROM gift_card_ledger WHERE cardId=? AND kind='void'", c2.id).n === 1);
    ok("a database failure voiding is passed on", ((await rejects(lib.voidGiftCard(failing(d1, /FROM gift_cards/, "disk full"), { id: c2.id, note: "x" }))) || {}).message === "disk full");
  }

  console.log("\n=== The totals strip ===");
  {
    const D = await freshDb();
    const a = await lib.issueGiftCard(D, { amountCents: 5000, now: "2026-09-30T23:00:00.000Z" });
    const b = await lib.issueGiftCard(D, { amountCents: 3000, now: T(3) });
    const c = await lib.issueGiftCard(D, { amountCents: 2000, now: T(4) });
    await lib.insertOrder(D, { orderId: "T1", orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: T(1) },
      [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", qty: 1, unitPrice: 25, taxable: false }]);
    const p = await lib.redeemGiftCard(D, { code: b.code, orderId: "T1", amountCents: 1200, now: T(5) });
    await lib.refundToGiftCard(D, { paymentId: p.paymentId, amountCents: 200, now: T(6) });
    await lib.adjustGiftCard(D, { id: a.id, deltaCents: 700, note: "Goodwill", now: T(7) });
    await lib.voidGiftCard(D, { id: c.id, note: "Lost", now: T(8) });
    const oct = await lib.giftCardTotals(D, { dateFrom: "2026-10-01T00:00:00.000Z", dateTo: "2026-10-31T23:59:59.999Z" });
    ok("October: sold $50 of cards made that month (not September's)", oct.sold === 50);
    ok("redeemed $12, refunded $2, adjusted +$7 less the $20 voided", oct.redeemed === 12 && oct.refunded === 2 && oct.adjusted === -13);
    ok("outstanding is what active cards hold now ($57 + $20), the void card's nothing", oct.outstanding === 77);
    const allTime = await lib.giftCardTotals(D);
    ok("with no range, everything: $100 sold", allTime.sold === 100 && allTime.outstanding === 77);
    ok("a range with nothing in it is all 0 but what is outstanding", same(await lib.giftCardTotals(D, { dateFrom: "2025-01-01", dateTo: "2025-12-31" }), { sold: 0, redeemed: 0, adjusted: 0, refunded: 0, outstanding: 77 }));
    ok("a database failure reading the totals is passed on", ((await rejects(lib.giftCardTotals(failing(D, /FROM gift_card_ledger/, "disk full")))) || {}).message === "disk full");
  }

  console.log("\n=== Before migrations/0120 ===");
  {
    const P = await freshDb("0120");
    await lib.insertOrder(P, { orderId: "P1", orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: T(1) },
      [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", qty: 1, unitPrice: 25, taxable: false }]);
    ok("issuing says the database needs updating", same(await lib.issueGiftCard(P, { amountCents: 500 }), { error: NOT_READY, notReady: true }));
    ok("a card reads as none, Show as nothing", (await lib.getGiftCard(P, { id: 1 })) === null && (await lib.getGiftCard(P, { code: "ABCDEFGHJKLMNPQR" })) === null && (await lib.revealGiftCardCode(P, 1)) === null);
    ok("the list is empty, the history too", same(await lib.listGiftCards(P, { q: "x" }), { cards: [], total: 0 }) && same(await lib.giftCardLedger(P, 1), []));
    ok("checking a number says it isn't right (and that the database isn't ready)", same(await lib.checkGiftCard(P, "ABCDEFGHJKLMNPQR"), { ok: false, reason: NOT_RIGHT, notReady: true }));
    ok("spending says the database needs updating", same(await lib.redeemGiftCard(P, { code: "ABCDEFGHJKLMNPQR", orderId: "P1" }), { ok: false, reason: NOT_READY, notReady: true }));
    const pay = await lib.addOrderPayment(P, "P1", 5, "cash", "", { method: "cash" });
    ok("refunding to a card says the database needs updating", same(await lib.refundToGiftCard(P, { paymentId: pay }), { ok: false, reason: NOT_READY, notReady: true }));
    ok("adjusting and voiding say so too", same(await lib.adjustGiftCard(P, { id: 1, deltaCents: 5, note: "n" }), { error: NOT_READY, notReady: true }) &&
      same(await lib.voidGiftCard(P, { id: 1, note: "n" }), { error: NOT_READY, notReady: true }));
    ok("the totals are all 0", same(await lib.giftCardTotals(P), { sold: 0, redeemed: 0, adjusted: 0, refunded: 0, outstanding: 0 }));
    ok("the Void button has nothing against a payment", (await lib.giftCardVoidRefusal(P, pay)) === "");
    ok("and voiding a payment still works, the old way", (await lib.voidPayment(P, pay, "x")) === "P1" && P.q("SELECT voidedAt v FROM order_payments WHERE id=?", pay)[0].v !== null);
  }

  console.log("\n=== The Void button (functions/api/orders.js) ===");
  {
    const hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
    const emailMocks = "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n";
    const post = new Function(hostSrc + "\n" + httpSrc + "\n" +
      "const requireAdmin = async () => null; const adminActor = () => 'olive@example.com';\n" + adminAs() + "\n" +
      "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
      "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
      "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {} });\n" +
      emailMocks + strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
    const call = async (body) => {
      const res = await post({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
        request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x", org: "club" }, body), headers: { get: () => null } } });
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    const w = await issue(5000); await order("W1", 40); await order("W2", 50);
    const pw = await lib.redeemGiftCard(d1, { code: w.code, orderId: "W1" });
    const rw = await lib.refundToGiftCard(d1, { paymentId: pw.paymentId, amountCents: 2000 });
    await lib.redeemGiftCard(d1, { code: w.code, orderId: "W2" });
    const audits = () => q1("SELECT count(*) n FROM audit_log WHERE action='payment.voided'").n;
    const before = audits();
    const r = await call({ action: "voidPayment", paymentId: rw.refundPaymentId, reason: "Mistake" });
    ok("Void on a refund the card no longer has is refused (409) with the reason", r.status === 409 && r.body.status === "error" &&
      r.body.message === "The gift card no longer has the $20.00 this refund put on it, so the refund can't be voided.");
    ok("and nothing is written: no audit row saying it was voided, the refund stands", audits() === before && q1("SELECT voidedAt v FROM order_payments WHERE id=?", rw.refundPaymentId).v === null);
    await lib.adjustGiftCard(d1, { id: w.id, deltaCents: 2000, note: "Found it" });
    const r2 = await call({ action: "voidPayment", paymentId: rw.refundPaymentId, reason: "Mistake" });
    ok("once the card has it again, Void works and takes it off the card", r2.status === 200 && r2.body.status === "ok" && bal(w.id) === 0 && audits() === before + 1);
    const pw2 = await lib.redeemGiftCard(d1, { code: (await issue(1000)).code, orderId: "W2" });
    const r3 = await call({ action: "voidPayment", paymentId: pw2.paymentId, reason: "Wrong card" });
    ok("Void on a gift-card payment puts it back on its card", r3.status === 200 && q1("SELECT balanceCents b FROM gift_cards g JOIN order_payments p ON p.giftCardId = g.id WHERE p.id=?", pw2.paymentId).b === 1000);
  }
})();
