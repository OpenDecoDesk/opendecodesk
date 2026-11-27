// Gift cards, the two phase 6 settings and Reorder — the admin actions of functions/api/orders.js through the real
// handler (the sign-in gate stood in for; who may is the real functions/_lib/permissions.js tables):
//   * the Gift cards page: listGiftCards, getGiftCard (with its ledger), revealGiftCardCode (audited first),
//     issueGiftCard (its limits, the email, a double click), adjustGiftCard, voidGiftCard, resendGiftCard, giftCardTotals;
//   * spending a card on an order (redeemGiftCard: addPayment's permission, a closed month, the audit row) and putting
//     money back on one (refundToGiftCard);
//   * every built-in role and nobody signed in for each, and the Gift cards switch turned off;
//   * Global settings: getGiftCardSettings / updateGiftCardSettings, getDiscountRules / updateDiscountRules, their
//     sections in saveGlobalSettingsAll, and the Gift card payment method switched off;
//   * Reorder: getOrderForReorder and createLocalSale's reorderOf, and gift cards spent on a Local sale (a sale the
//     cards pay in full delivers its downloads; an order with nothing left to copy is refused).
// Real SQL (sql.js) under the real db.js, email.js, digital.js and orders.js. Invented shops and people; the card
// numbers are the ones the code makes. No check depends on today's date or this machine's time zone.
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const roles = require("./testlib/roles");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ordersJs = read("functions/api/orders.js");

// Who is signed in: globalThis.__who392 — a built-in role, "clerk" (a made-up role: the order details at Edit and
// nothing else, so no customer records and no payments), or null (nobody). requireAdmin answers as adminAuth.js does:
// 401 for nobody, 403 for a role the action's permission doesn't allow.
const LEVELS = {};
for (const k of Object.keys(roles.DEFAULT_ROLES)) LEVELS[k] = roles.effectivePermissions(roles.DEFAULT_ROLES[k]);
LEVELS.clerk = { "orders.details": "edit" };
const authSrc = `
const __LV392 = ${JSON.stringify(LEVELS)};
const __rank392 = (l) => l === "full" ? 3 : l === "edit" ? 2 : l === "read" ? 1 : 0;
const adminUser = () => { const k = globalThis.__who392; return k && __LV392[k] ? { id: 1, email: k + "@example.test", name: k, role: k, roleInfo: { key: k }, pending: null, bootstrap: false } : null; };
const adminLevel = (request, fn) => { const u = adminUser(); return u ? (__LV392[u.role][fn] || "none") : "none"; };
const adminCan = (request, fn, level) => __rank392(adminLevel(request, fn)) >= __rank392(level || "read");
const requireAdmin = async (env, host, key, request, msg, need) => {
  const u = adminUser();
  if (!u) return jsonResponse({ status: "error", message: "Unauthorized" }, 401);
  const okay = need === "*" || (Array.isArray(need) ? need.some(([fn, l]) => adminCan(request, fn, l)) : u.role === "admin");
  return okay ? null : jsonResponse({ status: "error", code: "forbidden", message: "Your role can't do this. Ask an admin." }, 403);
};
const adminActor = () => (globalThis.__who392 || "nobody") + "@example.test";
`;
globalThis.__f = {};
const S = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\n" + authSrc + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\nconst invalidateCatalogVersionCache = () => {};\n" +
  "const getCatalogData = async () => ({ subdomainMap: { acme: 'acme', rec: 'rec' }, orgs: {}, features: globalThis.__f });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" +
  strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/digital.js")) + "\n" + strip(read("functions/_lib/campaigns.js")) + "\n" +
  strip(read("functions/api/orders.js")) + `\nreturn { post: onRequestPost, saveDiscountCode };`)();

// The mail that goes out (Cloudflare Email Service, stood in for); mailDown = the service answers 500.
const mail = [];
let mailDown = false;
globalThis.fetch = async (url, init) => {
  if (mailDown) return { ok: false, status: 500, json: async () => ({ success: false }), text: async () => "down" };
  if (captureMail(url, init, mail)) return MAIL_OK;
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};
// What the code logs on purpose (a refused audit write, a mail that didn't go) is kept here, not printed.
const logged = [];
const origErr = console.error;
console.error = (...a) => { logged.push(a.map(String).join(" ")); };

(async () => {
  console.log("=== Who may (functions/_lib/permissions.js) and the lists in orders.js ===");
  {
    const perm = (a) => roles.ACTION_PERM[a];
    const area = roles.PERMISSION_AREAS.find(a => a.key === "giftcards");
    ok("a Gift cards area with one function, giftcards.cards, on the page #giftcards", !!area && area.items.length === 1 && area.items[0].hash === "giftcards" && area.items[0].fns.length === 1 && area.items[0].fns[0][0] === "giftcards.cards");
    const lvl = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role])["giftcards.cards"];
    ok("built-in defaults: Admin and Manager full, Back office edit, Production none", ["admin", "manager", "staff", "production"].map(lvl).join() === "full,full,edit,none");
    ok("looking cards up and the totals: read", ["listGiftCards", "getGiftCard", "giftCardTotals"].every(a => same(perm(a), [["giftcards.cards", "read"]])));
    ok("issuing, showing the number and resending: edit", ["issueGiftCard", "revealGiftCardCode", "resendGiftCard"].every(a => same(perm(a), [["giftcards.cards", "edit"]])));
    ok("adjusting a balance and voiding a card: full", ["adjustGiftCard", "voidGiftCard"].every(a => same(perm(a), [["giftcards.cards", "full"]])));
    ok("spending a card on an order needs what Add payment needs", same(perm("redeemGiftCard"), perm("addPayment")));
    ok("putting money back on a card needs what Record refund needs", same(perm("refundToGiftCard"), perm("recordRefund")));
    ok("Reorder needs the order details at Edit (it starts a Local sale)", same(perm("getOrderForReorder"), [["orders.details", "edit"]]) && same(perm("getOrderForReorder"), perm("createLocalSale")));
    ok("changing the two rules is Global settings at Edit", same(perm("updateDiscountRules"), [["settings.global", "edit"]]) && same(perm("updateGiftCardSettings"), [["settings.global", "edit"]]));
    ok("reading the code rule: Global settings, or any screen with a code box",
      same(perm("getDiscountRules"), [["settings.global", "read"], ["orders.details", "edit"], ["orders.payments", "read"], ["quotes.estimates", "read"], ["discounts.codes", "read"]]));
    ok("reading the gift card settings: Global settings, the Gift cards page, or the order's payment form",
      same(perm("getGiftCardSettings"), [["settings.global", "read"], ["giftcards.cards", "read"], ["orders.payments", "edit"]]));
    const feat = [...ordersJs.match(/giftCards: \[([\s\S]*?)\],/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ok("the Gift cards switch covers the ten admin card actions, and not the settings or Reorder",
      same(feat.slice().sort(), ["adjustGiftCard", "getGiftCard", "giftCardTotals", "issueGiftCard", "listGiftCards", "redeemGiftCard", "refundToGiftCard", "resendGiftCard", "revealGiftCardCode", "voidGiftCard"]));
    const noMonth = [...ordersJs.match(/const NO_MONTH_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ok("issuing, adjusting, voiding, resending, showing and the settings change no month's numbers",
      ["issueGiftCard", "adjustGiftCard", "voidGiftCard", "resendGiftCard", "revealGiftCardCode", "updateDiscountRules", "updateGiftCardSettings", "getDiscountRules", "getGiftCardSettings", "getOrderForReorder"].every(a => noMonth.includes(a)));
    ok("…but spending a card and refunding to one do", !noMonth.includes("redeemGiftCard") && !noMonth.includes("refundToGiftCard"));
  }

  const d1 = await createD1();
  d1._raw.exec(read("schema.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1), ('rec','rec','Example Boosters','t','t',1);
    INSERT INTO customers (id, name, email, phone, company, createdAt, updatedAt) VALUES (1, 'Pat Example', 'pat@example.com', '555-0100', 'Example Club', 't', 't');`);
  let ENV = { SIGNING_SECRET: "s".repeat(40), ...MAIL_ENV };
  const call = async (url, body) => {
    const waits = [];
    const res = await S.post({ env: { DB: d1, ...ENV }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})), request: { url, json: async () => body, headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => call((ENV.EDITION === "desktop" ? "http://localhost:8788" : ADMIN_ORIGIN) + "/api/orders", { key: "x", ...body });
  const as = async (who, body) => { const was = globalThis.__who392; globalThis.__who392 = who; try { return await admin(body); } finally { globalThis.__who392 = was; } };
  globalThis.__who392 = "admin";
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  const card = (id) => q1("SELECT * FROM gift_cards WHERE id = ?", id);
  const lastAudit = (action) => { const r = q1("SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC", action); return r ? { ...r, d: JSON.parse(r.detail || "{}") } : null; };
  const auditCount = () => q1("SELECT count(*) AS n FROM audit_log").n;
  const breakAudit = () => d1._raw.exec("CREATE TRIGGER no_audit_392 BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log unavailable'); END;");
  const fixAudit = () => d1._raw.exec("DROP TRIGGER no_audit_392;");
  const CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
  let n = 0;
  const tee = [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", customUnitPrice: 25, qty: 4, taxable: false }];   // $100 of goods
  const sale = (extra) => admin({ action: "createLocalSale", org: "acme", requestId: "req392x" + (++n), items: tee, paymentMethod: "Cash", ...extra });
  const issue = async (amountCents, extra) => { const r = await admin({ action: "issueGiftCard", amountCents, ...extra }); if (r.status !== 200) throw new Error("issue: " + JSON.stringify(r.body)); return r.body; };
  const thisMonth = new Date().toISOString().slice(0, 7);
  const closeMonth = () => d1._raw.exec(`INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('${thisMonth}', 't', 'owner')`);
  const openMonth = () => d1._raw.exec(`DELETE FROM closed_periods WHERE month = '${thisMonth}'`);

  console.log("\n=== issueGiftCard: what staff may make ===");
  let A;   // a $25 card for Sam, with its number
  {
    for (const bad of [0, 99, 150.5, 100000001, "abc", null]) {
      const r = await admin({ action: "issueGiftCard", amountCents: bad });
      if (!(r.status === 400 && r.body.message === "A gift card is for $1 to $1,000,000.")) { ok("an amount of " + JSON.stringify(bad) + " cents is refused", false); }
    }
    ok("an amount under $1, over $1,000,000, not whole cents or not a number: 400 “A gift card is for $1 to $1,000,000.”", q1("SELECT count(*) AS n FROM gift_cards").n === 0);
    let r = await admin({ action: "issueGiftCard", amountCents: 2500, recipientEmail: "not an address" });
    ok("a recipient email that isn't one: 400 and no card", r.status === 400 && r.body.message === "The recipient's email address isn't valid." && q1("SELECT count(*) AS n FROM gift_cards").n === 0);
    r = await admin({ action: "issueGiftCard", amountCents: 2500, sendEmail: true });
    ok("“email it now” with no address: 400 “Enter the recipient's email address to email the card.”", r.status === 400 && r.body.message === "Enter the recipient's email address to email the card.");
    const log0 = auditCount();
    A = await issue(2500, { recipientName: "  Sam   Example ", recipientEmail: " SAM@Example.com ", message: "  Happy birthday!  ", note: "Raffle  prize" });
    const row = card(A.card.id);
    ok("made: the number comes back once, grouped XXXX-XXXX-XXXX-XXXX from the letters and digits without look-alikes", CODE_RE.test(A.code) && A.code.replace(/-/g, "") === row.code);
    ok("the card in the answer is masked: last 4 and ••••-••••-••••-last4, never the number", A.card.last4 === row.code.slice(-4) && A.card.codeMasked === "••••-••••-••••-" + A.card.last4 && !JSON.stringify(A.card).includes(row.code));
    ok("$25 on it, in dollars and cents", A.card.initial === 25 && A.card.balance === 25 && A.card.balanceCents === 2500);
    ok("the name's spaces tidied, the email lower case, the message trimmed, the note kept", A.card.recipientName === "Sam Example" && A.card.recipientEmail === "sam@example.com" && A.card.message === "Happy birthday!" && A.card.note === "Raffle prize");
    ok("staff-issued: no source order, made by who was signed in", A.card.sourceOrderId === "" && A.card.createdBy === "admin@example.test" && A.card.status === "active");
    ok("not emailed when not asked", A.emailSent === false && mail.length === 0);
    const au = lastAudit("giftcard.issued");
    ok("audited giftcard.issued: the card, its last 4, $25, the recipient, not emailed, the note — never the number",
      auditCount() === log0 + 1 && au.d.cardId === A.card.id && au.d.last4 === A.card.last4 && au.d.amount === 25 && au.d.recipientEmail === "sam@example.com" && au.d.emailed === false && au.d.note === "Raffle prize" && !au.detail.includes(row.code));
    const led = d1.q("SELECT * FROM gift_card_ledger WHERE cardId = ?", A.card.id);
    ok("its ledger starts with one 'issue' row of +$25, “Issued”", led.length === 1 && led[0].kind === "issue" && led[0].deltaCents === 2500 && led[0].note === "Issued");
    r = await admin({ action: "issueGiftCard", amountCents: 2500, message: "x".repeat(400) });
    ok("a message is cut to 300 characters", r.status === 200 && r.body.card.message.length === 300);

    const E = await issue(5000, { recipientName: "Lee Sample", recipientEmail: "lee@example.com", message: "Enjoy", sendEmail: true });
    ok("“email it now”: one email to the recipient, with the whole number in it", E.emailSent === true && mail.length === 1 && mail[0].to === "lee@example.com" && (mail[0].body + mail[0].htmlBody).includes(E.code));
    ok("…the audit row says it was emailed", lastAudit("giftcard.issued").d.emailed === true && lastAudit("giftcard.issued").d.cardId === E.card.id);
    mailDown = true;
    const F = await issue(1000, { recipientEmail: "kim@example.com", sendEmail: true });
    mailDown = false;
    ok("the mail service failing: the card is still made, emailSent false", !!card(F.card.id) && F.emailSent === false && lastAudit("giftcard.issued").d.emailed === false);

    const cnt = q1("SELECT count(*) AS n FROM gift_cards").n;
    const first = await admin({ action: "issueGiftCard", amountCents: 1500, recipientEmail: "ari@example.com", note: "Refund", requestId: "issue392aa" });
    const again = await admin({ action: "issueGiftCard", amountCents: 1500, recipientEmail: "ari@example.com", note: "Refund", requestId: "issue392aa" });
    ok("the same Save twice (a double click): one card, and the second answer is that card marked duplicate, without its number",
      first.status === 200 && again.status === 200 && again.body.duplicate === true && again.body.card.id === first.body.card.id && !again.body.code && q1("SELECT count(*) AS n FROM gift_cards").n === cnt + 1);
    await admin({ action: "issueGiftCard", amountCents: 1500, recipientEmail: "ari@example.com", note: "Refund" });
    await admin({ action: "issueGiftCard", amountCents: 1500, recipientEmail: "ari@example.com", note: "Refund" });
    ok("without a form key (a script), each request makes its own card", q1("SELECT count(*) AS n FROM gift_cards").n === cnt + 3);
    const other = await admin({ action: "issueGiftCard", amountCents: 1600, recipientEmail: "ari@example.com", note: "Refund", requestId: "issue392aa" });
    ok("a different amount is a different card, form key or not", other.status === 200 && !other.body.duplicate && other.body.card.id !== first.body.card.id);

    ENV = { SIGNING_SECRET: "s".repeat(40), EDITION: "desktop" };
    r = await admin({ action: "issueGiftCard", amountCents: 2000, recipientEmail: "pat@example.com", sendEmail: true });
    ok("on the desktop without its mailbox set up, “email it now” is refused (403, code desktop) and no card is made", r.status === 403 && r.body.code === "desktop" && q1("SELECT count(*) AS n FROM gift_cards WHERE initialCents = 2000").n === 0);
    r = await admin({ action: "issueGiftCard", amountCents: 2000, recipientEmail: "pat@example.com" });
    ok("…a card made without emailing it is fine there", r.status === 200 && r.body.emailSent === false);
    ENV = { SIGNING_SECRET: "s".repeat(40), ...MAIL_ENV };
  }

  console.log("\n=== listGiftCards and getGiftCard ===");
  {
    let r = await admin({ action: "listGiftCards" });
    const all = q1("SELECT count(*) AS n FROM gift_cards").n;
    ok("the list: every card, newest first, with the total", r.status === 200 && r.body.total === all && r.body.cards.length === all && r.body.cards[0].id === q1("SELECT max(id) AS m FROM gift_cards").m);
    ok("…masked: no card's number is in the list", d1.q("SELECT code FROM gift_cards").every(c => !JSON.stringify(r.body).includes(c.code)));
    r = await admin({ action: "listGiftCards", q: A.card.last4.toLowerCase() });
    ok("search by the last 4 (any case)", r.body.cards.some(c => c.id === A.card.id));
    r = await admin({ action: "listGiftCards", q: "  sam example " });
    ok("search by the recipient's name", r.body.total === 1 && r.body.cards[0].id === A.card.id);
    r = await admin({ action: "listGiftCards", q: "lee@example" });
    ok("search by email", r.body.total === 1 && r.body.cards[0].recipientEmail === "lee@example.com");
    r = await admin({ action: "listGiftCards", limit: 2, offset: 1 });
    ok("paging: two at a time from the second", r.body.cards.length === 2 && r.body.total === all && r.body.cards[0].id === q1("SELECT id FROM gift_cards ORDER BY createdAt DESC, id DESC LIMIT 1 OFFSET 1").id);
    r = await admin({ action: "listGiftCards", limit: "lots", offset: -3 });
    ok("a limit or offset that isn't a whole number: the defaults", r.status === 200 && r.body.cards.length === all && r.body.cards[0].id === q1("SELECT max(id) AS m FROM gift_cards").m);
    r = await admin({ action: "listGiftCards", status: "spent" });
    ok("a status that isn't one: 400 “That status isn't one a gift card has.”", r.status === 400 && r.body.message === "That status isn't one a gift card has.");

    let refusedIds = 0;
    for (const bad of ["x", 0, -1, "1.5", true]) {
      const g = await admin({ action: "getGiftCard", id: bad });
      if (g.status === 400 && g.body.message === "That gift card isn't valid.") refusedIds++;
    }
    ok("a card id that isn't a whole number from 1: 400 “That gift card isn't valid.”", refusedIds === 5);
    r = await admin({ action: "getGiftCard", id: 9999 });
    ok("a card that isn't there: 404 “Gift card not found”", r.status === 404 && r.body.message === "Gift card not found");
    r = await admin({ action: "getGiftCard", id: String(A.card.id) });
    ok("one card (its id as a string too) with its ledger: the issue row, +$25", r.status === 200 && r.body.card.id === A.card.id && r.body.ledger.length === 1 && r.body.ledger[0].kind === "issue" && r.body.ledger[0].delta === 25 && r.body.ledger[0].deltaCents === 2500);
    ok("…and not its number", !JSON.stringify(r.body).includes(card(A.card.id).code));
  }

  console.log("\n=== revealGiftCardCode (Show): audited first ===");
  {
    const log0 = auditCount();
    let r = await admin({ action: "revealGiftCardCode", id: A.card.id });
    ok("Show: the full number, grouped", r.status === 200 && r.body.code === A.code);
    const au = lastAudit("giftcard.code_shown");
    ok("audited giftcard.code_shown with the card and its last 4 — not the number", auditCount() === log0 + 1 && au.d.cardId === A.card.id && au.d.last4 === A.card.last4 && !au.detail.includes(card(A.card.id).code));
    breakAudit();
    r = await admin({ action: "revealGiftCardCode", id: A.card.id });
    fixAudit();
    ok("the audit log can't be written: 503 and no number", r.status === 503 && !r.body.code && /audit log/.test(r.body.message));
    r = await admin({ action: "revealGiftCardCode", id: 9999 });
    ok("a card that isn't there: 404", r.status === 404);
    r = await admin({ action: "revealGiftCardCode", id: "abc" });
    ok("an id that isn't one: 400", r.status === 400);
  }

  console.log("\n=== adjustGiftCard ===");
  let B;
  {
    B = await issue(4000, { recipientName: "Jo Example" });
    for (const d of [0, 1.5, "abc", 100000001]) {
      const r = await admin({ action: "adjustGiftCard", id: B.card.id, deltaCents: d, note: "x" });
      if (!(r.status === 400 && r.body.message === "Enter how much to add or take off.")) ok("a change of " + JSON.stringify(d) + " is refused", false);
    }
    ok("a change of $0, not whole cents, not a number or over $1,000,000: 400 “Enter how much to add or take off.”", card(B.card.id).balanceCents === 4000);
    let r = await admin({ action: "adjustGiftCard", id: B.card.id, deltaCents: 500, note: "   " });
    ok("no reason: 400 “Say why the balance is changing.”", r.status === 400 && r.body.message === "Say why the balance is changing.");
    r = await admin({ action: "adjustGiftCard", id: B.card.id, deltaCents: -4001, note: "Too much" });
    ok("taking off more than is on it: 400 “The balance can't go below $0.”", r.status === 400 && r.body.message === "The balance can't go below $0." && card(B.card.id).balanceCents === 4000);
    r = await admin({ action: "adjustGiftCard", id: 9999, deltaCents: 500, note: "x" });
    ok("a card that isn't there: 404", r.status === 404);
    const log0 = auditCount();
    r = await admin({ action: "adjustGiftCard", id: B.card.id, deltaCents: 750, note: "  Goodwill   credit " });
    ok("adding $7.50: the balance is $47.50 and the answer is the card and its ledger", r.status === 200 && r.body.card.balance === 47.5 && card(B.card.id).balanceCents === 4750 && r.body.ledger.length === 2);
    ok("…a ledger 'adjust' row of +$7.50 with the reason, by who did it", r.body.ledger[1].kind === "adjust" && r.body.ledger[1].delta === 7.5 && r.body.ledger[1].note === "Goodwill credit" && r.body.ledger[1].by === "admin@example.test");
    const au = lastAudit("giftcard.adjusted");
    ok("audited giftcard.adjusted: from $40, by +$7.50, why", auditCount() === log0 + 1 && au.d.cardId === B.card.id && au.d.from === 40 && au.d.delta === 7.5 && au.d.note === "Goodwill credit");
    r = await admin({ action: "adjustGiftCard", id: B.card.id, deltaCents: -4750, note: "Used in the shop" });
    ok("taking all of it off leaves $0", r.status === 200 && card(B.card.id).balanceCents === 0 && r.body.ledger[2].deltaCents === -4750);
    r = await admin({ action: "adjustGiftCard", id: B.card.id, deltaCents: 4000, note: "Back" });
    breakAudit();
    const r2 = await admin({ action: "adjustGiftCard", id: B.card.id, deltaCents: 100, note: "Extra" });
    fixAudit();
    ok("the audit log can't be written: 503 and the balance is not changed", r2.status === 503 && card(B.card.id).balanceCents === 4000);
  }

  console.log("\n=== voidGiftCard ===");
  {
    let r = await admin({ action: "voidGiftCard", id: B.card.id, note: "" });
    ok("no reason: 400 “Say why the card is being voided.”", r.status === 400 && r.body.message === "Say why the card is being voided." && card(B.card.id).status === "active");
    breakAudit();
    r = await admin({ action: "voidGiftCard", id: B.card.id, note: "Lost" });
    fixAudit();
    ok("the audit log can't be written: 503 and the card is not voided", r.status === 503 && card(B.card.id).status === "active");
    const log0 = auditCount();
    r = await admin({ action: "voidGiftCard", id: B.card.id, note: "Reported   lost" });
    ok("voided: status void, balance $0, a 'void' ledger row taking the $40 off", r.status === 200 && r.body.card.status === "void" && r.body.card.balance === 0 && !!r.body.card.voidedAt &&
      r.body.ledger[r.body.ledger.length - 1].kind === "void" && r.body.ledger[r.body.ledger.length - 1].deltaCents === -4000 && r.body.ledger[r.body.ledger.length - 1].note === "Reported lost");
    const au = lastAudit("giftcard.voided");
    ok("audited giftcard.voided with the $40 it held and why", auditCount() === log0 + 1 && au.d.balance === 40 && au.d.note === "Reported lost" && au.d.last4 === B.card.last4);
    r = await admin({ action: "voidGiftCard", id: B.card.id, note: "Again" });
    ok("voiding it again: 409 “This gift card is already voided.”", r.status === 409 && r.body.message === "This gift card is already voided.");
    r = await admin({ action: "adjustGiftCard", id: B.card.id, deltaCents: 500, note: "Oops" });
    ok("a voided card's balance can't be changed: 409 “This gift card was voided.”", r.status === 409 && r.body.message === "This gift card was voided." && card(B.card.id).balanceCents === 0);
    r = await admin({ action: "voidGiftCard", id: 9999, note: "x" });
    ok("a card that isn't there: 404", r.status === 404);
  }

  console.log("\n=== resendGiftCard ===");
  {
    mail.length = 0;
    let r = await admin({ action: "resendGiftCard", id: A.card.id });
    ok("to its recipient: one email with the whole number, and who it went to", r.status === 200 && r.body.emailSent === true && r.body.sentTo === "sam@example.com" && mail.length === 1 && mail[0].to === "sam@example.com" && (mail[0].body + mail[0].htmlBody).includes(A.code));
    const au = lastAudit("giftcard.resent");
    ok("audited giftcard.resent with the address — not the number", au && au.d.cardId === A.card.id && au.d.to === "sam@example.com" && !au.detail.includes(card(A.card.id).code));
    r = await admin({ action: "resendGiftCard", id: A.card.id, email: " other@example.com " });
    ok("to another address typed now", r.status === 200 && r.body.sentTo === "other@example.com" && mail[mail.length - 1].to === "other@example.com");
    const noMail = await issue(1200, {});
    r = await admin({ action: "resendGiftCard", id: noMail.card.id });
    ok("a card with no email and none typed: 400 “Enter the email address to send the card to.”", r.status === 400 && r.body.message === "Enter the email address to send the card to.");
    r = await admin({ action: "resendGiftCard", id: noMail.card.id, email: "nope" });
    ok("…or one that isn't an address: the same 400", r.status === 400 && r.body.message === "Enter the email address to send the card to.");
    r = await admin({ action: "resendGiftCard", id: B.card.id, email: "pat@example.com" });
    ok("a voided card: 409 “This gift card was voided.”", r.status === 409 && r.body.message === "This gift card was voided.");
    r = await admin({ action: "resendGiftCard", id: 9999 });
    ok("a card that isn't there: 404", r.status === 404);
    const sent = mail.length;
    breakAudit();
    r = await admin({ action: "resendGiftCard", id: A.card.id });
    fixAudit();
    ok("the audit log can't be written: 503 and nothing is sent", r.status === 503 && mail.length === sent);
    mailDown = true;
    r = await admin({ action: "resendGiftCard", id: A.card.id });
    mailDown = false;
    ok("the mail service failing: emailSent false", r.status === 200 && r.body.emailSent === false);
    ENV = { SIGNING_SECRET: "s".repeat(40), EDITION: "desktop" };
    r = await admin({ action: "resendGiftCard", id: A.card.id });
    ok("on the desktop without its mailbox: 403, code desktop", r.status === 403 && r.body.code === "desktop");
    ENV = { SIGNING_SECRET: "s".repeat(40), ...MAIL_ENV };
  }

  console.log("\n=== giftCardTotals ===");
  {
    // A card of its own in 2025 with dated ledger rows, so the range is checked without today's date.
    d1._raw.exec(`INSERT INTO gift_cards (id, code, last4, initialCents, balanceCents, status, createdAt) VALUES (500, 'ABCDEFGHJKLMNP22', 'NP22', 10000, 6000, 'void', '2025-03-01T00:00:00.000Z');
      INSERT INTO gift_card_ledger (cardId, kind, deltaCents, at) VALUES
        (500, 'issue', 10000, '2025-03-02T03:00:00.000Z'),
        (500, 'redeem', -3000, '2025-03-05T12:00:00.000Z'),
        (500, 'refund', 500, '2025-03-06T12:00:00.000Z'),
        (500, 'adjust', -1500, '2025-03-07T12:00:00.000Z'),
        (500, 'void', -6000, '2025-03-08T12:00:00.000Z'),
        (500, 'redeem', -100, '2025-04-01T04:00:00.000Z');`);
    let r = await admin({ action: "giftCardTotals", dateFrom: "2025-03-01", dateTo: "2025-03-31" });
    ok("March 2025 (UTC): sold $100, redeemed $30, refunded $5, adjusted −$75 (by hand and voided)",
      r.status === 200 && r.body.totals.sold === 100 && r.body.totals.redeemed === 30 && r.body.totals.refunded === 5 && r.body.totals.adjusted === -75);
    const held = q1("SELECT sum(balanceCents) AS n FROM gift_cards WHERE status = 'active'").n / 100;
    ok("outstanding: what the active cards hold now, whatever the range", r.body.totals.outstanding === held);
    ENV = { ...ENV, TIMEZONE: "America/Chicago" };
    r = await admin({ action: "giftCardTotals", dateFrom: "2025-03-02", dateTo: "2025-03-31" });
    ok("the days are the business's (Chicago): the sale at 03:00 UTC on 2 March was the evening of 1 March, and 04:00 UTC on 1 April is still March",
      r.body.totals.sold === 0 && r.body.totals.redeemed === 31);
    ENV = { SIGNING_SECRET: "s".repeat(40), ...MAIL_ENV };
    r = await admin({ action: "giftCardTotals", dateFrom: "2025-03-05" });
    ok("only a start: everything from it on", r.status === 200 && r.body.totals.sold >= 0 && r.body.totals.redeemed >= 31 && r.body.totals.refunded >= 5);
    r = await admin({ action: "giftCardTotals" });
    ok("no range: every row", r.status === 200 && r.body.totals.sold >= 100 + 25);
    for (const bad of ["03/01/2025", "2025-02-30x", 20250301]) {
      const t = await admin({ action: "giftCardTotals", dateFrom: bad });
      if (!(t.status === 400 && t.body.message === "The dates must be YYYY-MM-DD.")) ok("a start of " + JSON.stringify(bad) + " is refused", false);
    }
    r = await admin({ action: "giftCardTotals", dateTo: "2025-13-45" });
    ok("a date not written YYYY-MM-DD (or not a day): 400 “The dates must be YYYY-MM-DD.”", r.status === 400 && r.body.message === "The dates must be YYYY-MM-DD.");
  }

  console.log("\n=== redeemGiftCard: a card spent in the order's Payments window ===");
  let saleId, C, payId;
  {
    let r = await sale({});
    saleId = r.body.orderId;
    C = await issue(3000, { recipientName: "Pat Example" });
    const order = () => q1("SELECT * FROM orders WHERE orderId = ?", saleId);
    for (const [body, msg, status] of [
      [{ orderId: "" , code: C.code }, "Invalid order ID", 400],
      [{ orderId: "bad id!", code: C.code }, "Invalid order ID", 400],
      [{ orderId: saleId }, "Enter the gift card number.", 400],
      [{ orderId: saleId, code: "   " }, "Enter the gift card number.", 400],
      [{ orderId: saleId, code: "X".repeat(65) }, "Enter the gift card number.", 400],
      [{ orderId: saleId, code: C.code, amount: 0 }, "Amount must be a positive number", 400],
      [{ orderId: saleId, code: C.code, amount: -5 }, "Amount must be a positive number", 400],
      [{ orderId: saleId, code: C.code, amount: "lots" }, "Amount must be a positive number", 400],
      [{ orderId: saleId, code: C.code, amount: 1000001 }, "Amount must be a positive number", 400],
      [{ orderId: "ACME-NOPE", code: C.code }, "Order not found", 404],
      [{ orderId: saleId, org: "rec", code: C.code }, "Order not found", 404],
      [{ orderId: saleId, code: "ABCD-EFGH-JKLM-NPQ2" }, "That gift card number isn't right.", 400],
      [{ orderId: saleId, code: B.code }, "That gift card number isn't right.", 400],
    ]) {
      const x = await admin({ action: "redeemGiftCard", ...body });
      if (!(x.status === status && x.body.message === msg)) ok("redeem " + JSON.stringify(body) + " answers " + status + " " + msg, false);
    }
    ok("refused, each with its sentence: no order id, no number, an amount that isn't positive or is over $1,000,000, another shop's order, a number that isn't a card, a voided card",
      d1.q("SELECT count(*) AS n FROM order_payments WHERE orderId = ?", saleId)[0].n === 0 && card(C.card.id).balanceCents === 3000);
    const empty = await issue(500, {});
    await admin({ action: "adjustGiftCard", id: empty.card.id, deltaCents: -500, note: "Spent" });
    r = await admin({ action: "redeemGiftCard", orderId: saleId, code: empty.code });
    ok("a card with nothing left: 400 “This gift card has no balance left.”", r.status === 400 && r.body.message === "This gift card has no balance left.");

    closeMonth();
    r = await admin({ action: "redeemGiftCard", orderId: saleId, code: C.code, amount: 10 });
    openMonth();
    ok("this month closed (filed): 409 and nothing taken", r.status === 409 && /is closed/.test(r.body.message) && card(C.card.id).balanceCents === 3000);

    const log0 = auditCount();
    r = await admin({ action: "redeemGiftCard", orderId: saleId, code: C.code.toLowerCase().replace(/-/g, " "), amount: 12.5, requestId: "redeem392a" });
    ok("$12.50 of it (the number typed in lower case with spaces): taken $12.50, $17.50 left on the card, $87.50 still owed",
      r.status === 200 && r.body.taken === 12.5 && r.body.cardBalance === 17.5 && r.body.last4 === C.card.last4 && r.body.balanceDue === 87.5 && r.body.amountReceived === 12.5 && card(C.card.id).balanceCents === 1750);
    const p = q1("SELECT * FROM order_payments WHERE orderId = ? AND giftCardId IS NOT NULL", saleId);
    payId = p.id;
    ok("a payment row: method other, the card's id, “Gift card ••last4”, “Paid by gift card”, no account", p.method === "other" && p.giftCardId === C.card.id && p.reference === "Gift card ••" + C.card.last4 && p.note === "Paid by gift card" && p.accountId === null && p.amountCents === 1250);
    ok("…and it is in the answer's payments", Array.isArray(r.body.payments) && r.body.payments.some(x => x.reference === "Gift card ••" + C.card.last4));
    const au = lastAudit("payment.added");
    ok("audited payment.added: $12.50, method “gift card”, the masked reference", auditCount() === log0 + 1 && au.orderId === saleId && au.d.amount === 12.5 && au.d.method === "gift card" && au.d.reference === "Gift card ••" + C.card.last4);
    const dup = await admin({ action: "redeemGiftCard", orderId: saleId, code: C.code, amount: 12.5, requestId: "redeem392a" });
    ok("the same Save again: answered as a duplicate, nothing more taken", dup.status === 200 && dup.body.duplicate === true && card(C.card.id).balanceCents === 1750 && d1.q("SELECT count(*) AS n FROM order_payments WHERE orderId = ?", saleId)[0].n === 1);
    r = await admin({ action: "redeemGiftCard", orderId: saleId, code: C.code });
    ok("no amount: all the card has left ($17.50), as it is less than what is owed", r.status === 200 && r.body.taken === 17.5 && r.body.cardBalance === 0 && r.body.balanceDue === 70);

    const big = await issue(50000, {});
    r = await admin({ action: "redeemGiftCard", orderId: saleId, code: big.code, amount: 500 });
    ok("more asked than is owed: only the $70 owed is taken, and the order is paid", r.status === 200 && r.body.taken === 70 && r.body.balanceDue === 0 && r.body.paid === true && card(big.card.id).balanceCents === 43000);
    r = await admin({ action: "redeemGiftCard", orderId: saleId, code: big.code });
    ok("nothing owed: 400 “Nothing is owed on this order.”", r.status === 400 && r.body.message === "Nothing is owed on this order.");
    ok("order paid", !!order().paid);

    const v = await sale({});
    d1._raw.exec(`UPDATE orders SET voidedAt = '2026-01-02T00:00:00.000Z' WHERE orderId = '${v.body.orderId}'`);
    r = await admin({ action: "redeemGiftCard", orderId: v.body.orderId, code: big.code });
    ok("a voided order: 409 “This order is voided.”", r.status === 409 && r.body.message === "This order is voided.");
  }

  console.log("\n=== Digital products: paid by gift card, the files go out ===");
  let DIG;
  {
    await admin({ action: "createProduct", org: "acme", productId: "pattern", type: "other", name: "Club Pattern", pricingMode: "flat", flatPrice: 20, visible: true, weightOz: 0, noDesignNeeded: true });
    d1._raw.exec(`UPDATE products SET digital = 1, noBlankNeeded = 1, noDesignNeeded = 1 WHERE productId = 'pattern';
      INSERT INTO product_files (orgId, productId, fileKey, fileName, fileExt, bytes, sortOrder, createdAt) VALUES ('acme', 'pattern', 'files/pattern.pdf', 'pattern.pdf', 'pdf', 1000, 0, 't');`);
    const grants = (oid) => q1("SELECT count(*) AS n FROM download_grants WHERE orderId = ?", oid).n;
    DIG = await issue(10000, { recipientName: "Pat Example" });
    let r = await admin({ action: "createLocalSale", org: "acme", requestId: "req392dig1", items: [{ productId: "pattern", size: "", qty: 1 }], paymentMethod: "Cash", contact: "pat@example.com" });
    ok("a Local sale of a digital product, unpaid: no downloads yet", r.status === 200 && grants(r.body.orderId) === 0);
    const owed = q1("SELECT * FROM orders WHERE orderId = ?", r.body.orderId);
    r = await admin({ action: "redeemGiftCard", orderId: r.body.orderId, code: DIG.code });
    ok("a gift card in the Payments window pays it: the order is paid and its file is granted", r.status === 200 && r.body.paid === true && grants(owed.orderId) === 1);
    r = await admin({ action: "createLocalSale", org: "acme", requestId: "req392dig2", items: [{ productId: "pattern", size: "", qty: 1 }], paymentMethod: "Gift card", contact: "pat@example.com",
      giftCards: [{ code: DIG.code }] });
    const o2 = q1("SELECT * FROM orders WHERE orderId = ?", r.body.orderId);
    ok("a Local sale the gift card pays in full is paid…", r.status === 200 && r.body.giftCards && r.body.giftCards[0].ok === true && !!o2.paid);
    ok("…and its downloads are granted, as when a payment pays an order in full", grants(r.body.orderId) === 1);
    r = await admin({ action: "createLocalSale", org: "acme", requestId: "req392dig3", items: [{ productId: "pattern", size: "", qty: 2 }], paymentMethod: "Gift card", contact: "pat@example.com",
      giftCards: [{ code: DIG.code, amount: 5 }] });
    ok("a card that pays only part: not paid, nothing granted", r.status === 200 && r.body.giftCards[0].taken === 5 && !q1("SELECT paid FROM orders WHERE orderId = ?", r.body.orderId).paid && grants(r.body.orderId) === 0);
  }

  console.log("\n=== refundToGiftCard ===");
  {
    const bal = () => card(C.card.id).balanceCents;
    for (const [body, msg, status] of [
      [{ paymentId: "x", amount: 5 }, "Invalid payment ID", 400],
      [{ paymentId: 0, amount: 5 }, "Invalid payment ID", 400],
      [{ paymentId: payId, amount: 0 }, "Refund amount must be a positive number", 400],
      [{ paymentId: payId, amount: "x" }, "Refund amount must be a positive number", 400],
      [{ paymentId: payId, amount: 1000001 }, "Refund amount must be a positive number", 400],
      [{ paymentId: 99999, amount: 5 }, "Payment not found", 404],
    ]) {
      const x = await admin({ action: "refundToGiftCard", ...body });
      if (!(x.status === status && x.body.message === msg)) ok("refund " + JSON.stringify(body) + " answers " + status + " " + msg, false);
    }
    ok("refused, each with its sentence: a payment id that isn't one, an amount that isn't positive or is too big, a payment that isn't there", bal() === 0);
    closeMonth();
    let r = await admin({ action: "refundToGiftCard", paymentId: payId, amount: 5 });
    openMonth();
    ok("this month closed: 409, nothing put back", r.status === 409 && /is closed/.test(r.body.message) && bal() === 0);
    const log0 = auditCount();
    r = await admin({ action: "refundToGiftCard", paymentId: payId, amount: 5, orderId: saleId });
    ok("$5 of the $12.50 gift-card payment back on the card: the card has $5", r.status === 200 && bal() === 500 && r.body.orderId === saleId);
    const ref = q1("SELECT * FROM order_payments WHERE orderId = ? AND kind = 'refund'", saleId);
    ok("…a refund row of −$5 with the same card, “Refunded to gift card”", ref && ref.amountCents === -500 && ref.giftCardId === C.card.id && ref.note === "Refunded to gift card" && ref.accountId === null);
    ok("…a ledger 'refund' row of +$5 for the order", !!q1("SELECT 1 AS x FROM gift_card_ledger WHERE cardId = ? AND kind = 'refund' AND deltaCents = 500 AND orderId = ?", C.card.id, saleId));
    ok("…the answer shows $5 refunded and $95 kept", r.body.refundedAmount === 5 && r.body.netReceived === 95 && r.body.payments.some(x => x.kind === "refund" && x.amount === -5));
    const au = lastAudit("payment.refunded");
    ok("audited payment.refunded: $5, method “gift card”, the payment", auditCount() === log0 + 1 && au.d.amount === 5 && au.d.method === "gift card" && au.d.paymentId === payId);
    r = await admin({ action: "refundToGiftCard", paymentId: payId, amount: 8 });
    ok("more than that payment has left to give back ($7.50): 409 with the reason", r.status === 409 && r.body.message === "That's more than this gift card payment has left to give back." && bal() === 500);
    const cash = q1("SELECT id FROM order_payments WHERE giftCardId IS NULL AND kind = 'payment' ORDER BY id DESC");
    const cashPay = await admin({ action: "addPayment", orderId: (await sale({})).body.orderId, amount: 10, method: "cash" });
    const cashId = q1("SELECT id FROM order_payments WHERE giftCardId IS NULL AND kind = 'payment' ORDER BY id DESC").id;
    r = await admin({ action: "refundToGiftCard", paymentId: cashId, amount: 5 });
    ok("a payment that wasn't by gift card: 409 “That payment wasn't paid by a gift card.”", cashPay.status === 200 && (!cash || cash.id !== cashId) && r.status === 409 && r.body.message === "That payment wasn't paid by a gift card.");
    d1._raw.exec(`UPDATE order_payments SET voidedAt = '2026-01-02T00:00:00.000Z' WHERE id = ${cashId}`);
    r = await admin({ action: "refundToGiftCard", paymentId: cashId, amount: 5 });
    ok("a voided entry: 400 “That entry is already voided”", r.status === 400 && r.body.message === "That entry is already voided");
    await admin({ action: "voidGiftCard", id: C.card.id, note: "Closed account" });
    r = await admin({ action: "refundToGiftCard", paymentId: payId, amount: 1 });
    ok("a voided card: 409, nothing can be put back on it", r.status === 409 && r.body.message === "This gift card has been voided, so nothing can be put back on it.");
  }

  console.log("\n=== Every built-in role, and nobody signed in ===");
  {
    const X = await issue(2000, { recipientEmail: "pat@example.com" });
    const o = (await sale({})).body.orderId;
    // Bodies that are refused by their own checks (or harmless), so a role that may gets past the permission check
    // without changing anything: its answer is neither 401 nor 403.
    const tries = {
      listGiftCards: { status: "nope" }, getGiftCard: { id: 99999 }, giftCardTotals: { dateFrom: "x" },
      issueGiftCard: { amountCents: 1 }, revealGiftCardCode: { id: 99999 }, resendGiftCard: { id: 99999 },
      adjustGiftCard: { id: X.card.id, deltaCents: 0 }, voidGiftCard: { id: X.card.id, note: "" },
      redeemGiftCard: { orderId: o }, refundToGiftCard: { paymentId: 0 },
      getGiftCardSettings: {}, updateGiftCardSettings: { sellOnline: "yes" }, getDiscountRules: {}, updateDiscountRules: { multiple: "yes" },
      getOrderForReorder: { orderId: "" },
    };
    const want = {   // who may: admin, manager, staff (Back office), production
      listGiftCards: "1110", getGiftCard: "1110", giftCardTotals: "1110", issueGiftCard: "1110", revealGiftCardCode: "1110", resendGiftCard: "1110",
      adjustGiftCard: "1100", voidGiftCard: "1100", redeemGiftCard: "1110", refundToGiftCard: "1100",
      getGiftCardSettings: "1110", updateGiftCardSettings: "1000", getDiscountRules: "1110", updateDiscountRules: "1000", getOrderForReorder: "1110",
    };
    for (const a of Object.keys(tries)) {
      const got = [];
      for (const role of ["admin", "manager", "staff", "production"]) {
        const r = await as(role, { action: a, ...tries[a] });
        got.push(r.status === 403 ? "0" : r.status === 401 ? "?" : "1");
      }
      const out = await as(null, { action: a, ...tries[a] });
      const roleWord = { "1110": "Admin, Manager and Back office; not Production", "1100": "Admin and Manager; not Back office or Production", "1000": "Admin only" }[want[a]];
      ok(a + ": " + roleWord + "; nobody signed in gets 401", got.join("") === want[a] && out.status === 401);
    }
    ok("…and none of those tries changed a card", card(X.card.id).balanceCents === 2000 && card(X.card.id).status === "active");
    let r = await as("staff", { action: "issueGiftCard", amountCents: 1000, recipientName: "Back office" });
    ok("Back office can issue a card", r.status === 200 && r.body.card.createdBy === "staff@example.test");
    r = await as("staff", { action: "adjustGiftCard", id: X.card.id, deltaCents: 100, note: "x" });
    ok("…but not change a balance (403, the card untouched)", r.status === 403 && card(X.card.id).balanceCents === 2000);
    r = await as("manager", { action: "voidGiftCard", id: X.card.id, note: "Manager voids" });
    ok("a Manager can void one", r.status === 200 && card(X.card.id).status === "void");
  }

  console.log("\n=== The Gift cards switch turned off ===");
  {
    const Y = await issue(2000, {});
    globalThis.__f = { giftCards: false };
    const bodies = {
      listGiftCards: {}, getGiftCard: { id: Y.card.id }, revealGiftCardCode: { id: Y.card.id }, issueGiftCard: { amountCents: 1000 },
      adjustGiftCard: { id: Y.card.id, deltaCents: 100, note: "x" }, voidGiftCard: { id: Y.card.id, note: "x" }, resendGiftCard: { id: Y.card.id, email: "pat@example.com" },
      giftCardTotals: {}, redeemGiftCard: { orderId: saleId, code: Y.code }, refundToGiftCard: { paymentId: payId, amount: 1 },
    };
    const cards0 = q1("SELECT count(*) AS n FROM gift_cards").n;
    const answers = [];
    for (const a of Object.keys(bodies)) answers.push([a, await admin({ action: a, ...bodies[a] })]);
    const bad = answers.filter(([, r]) => !(r.status === 403 && r.body.feature === "giftCards" && /Gift cards is turned off/.test(r.body.message)));
    ok("each of the ten card actions: 403 “Gift cards is turned off…”, feature giftCards", bad.length === 0);
    ok("…and nothing was made, changed or spent", q1("SELECT count(*) AS n FROM gift_cards").n === cards0 && card(Y.card.id).balanceCents === 2000 && card(Y.card.id).status === "active");
    let r = await as(null, { action: "listGiftCards" });
    ok("nobody signed in still hears 401 first (nothing about which features are on)", r.status === 401);
    r = await as("production", { action: "issueGiftCard", amountCents: 1000 });
    ok("…and a role without the permission 403 for its role, not the switch", r.status === 403 && !r.body.feature);
    r = await admin({ action: "getGiftCardSettings" });
    const r2 = await admin({ action: "getDiscountRules" });
    const r3 = await admin({ action: "getOrderForReorder", orderId: saleId });
    ok("the settings and Reorder are not behind the switch", r.status === 200 && r2.status === 200 && r3.status === 200);
    r = await sale({ giftCards: [{ code: Y.code }] });
    ok("a Local sale sent with a gift card: 400 “Gift cards aren't available right now.”", r.status === 400 && r.body.message === "Gift cards aren't available right now." && card(Y.card.id).balanceCents === 2000);
    globalThis.__f = {};
  }

  console.log("\n=== Global settings: Gift cards ===");
  {
    let r = await admin({ action: "getGiftCardSettings" });
    ok("before anything is saved: not sold online, $25 / $50 / $100, custom $5–$500", r.status === 200 && same(r.body.giftCards, { sellOnline: false, amounts: [2500, 5000, 10000], minCents: 500, maxCents: 50000 }));
    const good = { sellOnline: true, amounts: [2000, 4000], minCents: 1000, maxCents: 20000 };
    for (const [b, msg] of [
      [{ ...good, sellOnline: "yes" }, "Say whether gift cards are sold online."],
      [{ ...good, amounts: [] }, "Give 1 to 6 amounts for the buttons."],
      [{ ...good, amounts: [100, 200, 300, 400, 500, 600, 700] }, "Give 1 to 6 amounts for the buttons."],
      [{ ...good, amounts: "2500" }, "Give 1 to 6 amounts for the buttons."],
      [{ ...good, amounts: [99] }, "Each amount must be between $1 and $10,000."],
      [{ ...good, amounts: [1000001] }, "Each amount must be between $1 and $10,000."],
      [{ ...good, amounts: [250.5] }, "Each amount must be between $1 and $10,000."],
      [{ ...good, amounts: [""] }, "Each amount must be between $1 and $10,000."],
      [{ ...good, minCents: 99 }, "The smallest and largest amount must be between $1 and $10,000."],
      [{ ...good, maxCents: 1000001 }, "The smallest and largest amount must be between $1 and $10,000."],
      [{ ...good, minCents: "x" }, "The smallest and largest amount must be between $1 and $10,000."],
      [{ ...good, minCents: 30000, maxCents: 20000 }, "The smallest amount can't be more than the largest."],
    ]) {
      const x = await admin({ action: "updateGiftCardSettings", ...b });
      if (!(x.status === 400 && x.body.message === msg)) ok("settings " + JSON.stringify(b) + " are refused with " + msg, false);
    }
    r = await admin({ action: "getGiftCardSettings" });
    ok("refused, each with its sentence (sell online not yes/no; 1–6 amounts of $1–$10,000; the smallest and largest $1–$10,000, in order), and nothing saved",
      r.body.giftCards.sellOnline === false);
    const v0 = q1("SELECT value FROM global_settings WHERE key = 'catalogVersion'");
    const log0 = auditCount();
    r = await admin({ action: "updateGiftCardSettings", sellOnline: true, amounts: ["2000", 4000, 2000, 100, 1000000], minCents: "100", maxCents: 1000000 });
    ok("saved: amounts as whole cents with repeats dropped (the $1 and $10,000 ends allowed), numbers given as text taken",
      r.status === 200 && same(r.body.giftCards, { sellOnline: true, amounts: [2000, 4000, 100, 1000000], minCents: 100, maxCents: 1000000 }));
    r = await admin({ action: "getGiftCardSettings" });
    ok("…and read back", same(r.body.giftCards.amounts, [2000, 4000, 100, 1000000]) && r.body.giftCards.sellOnline === true);
    const au = lastAudit("settings.gift_cards_set");
    ok("audited settings.gift_cards_set from the defaults to the new ones", auditCount() === log0 + 1 && au.d.from.sellOnline === false && same(au.d.to.amounts, [2000, 4000, 100, 1000000]));
    const v1 = q1("SELECT value FROM global_settings WHERE key = 'catalogVersion'");
    ok("the shops' catalog moves to a new version (the Gift cards button shows without a Publish)", !!v1 && (!v0 || v1.value !== v0.value));
  }

  console.log("\n=== Global settings: Discount codes (one code or several) ===");
  {
    let r = await admin({ action: "getDiscountRules" });
    ok("before anything is saved: one code per order", r.status === 200 && same(r.body.discountRules, { multiple: false }));
    r = await admin({ action: "updateDiscountRules", multiple: "true" });
    ok("not yes/no: 400 “Say whether more than one code can be used on an order.”", r.status === 400 && r.body.message === "Say whether more than one code can be used on an order.");
    r = await admin({ action: "updateDiscountRules" });
    ok("…left out: the same 400", r.status === 400);
    const v0 = q1("SELECT value FROM global_settings WHERE key = 'catalogVersion'").value;
    r = await admin({ action: "updateDiscountRules", multiple: true });
    ok("several allowed: saved and read back", r.status === 200 && r.body.discountRules.multiple === true && (await admin({ action: "getDiscountRules" })).body.discountRules.multiple === true);
    const au = lastAudit("settings.discount_rules_set");
    ok("audited settings.discount_rules_set from one to several", au && au.d.from.multiple === false && au.d.to.multiple === true);
    ok("the shops' catalog moves to a new version", q1("SELECT value FROM global_settings WHERE key = 'catalogVersion'").value !== v0);
    await admin({ action: "updateDiscountRules", multiple: false });
  }

  console.log("\n=== Global settings → Save (saveGlobalSettingsAll): the two sections, and the Gift card payment method ===");
  {
    const save = (settings, who = "admin") => as(who, { action: "saveGlobalSettingsAll", settings });
    let r = await save({ discountRules: { multiple: "yes" } });
    ok("Discount codes not yes/no: 400 naming the section", r.status === 400 && r.body.section === "Discount codes" && r.body.message === "Say whether more than one code can be used on an order.");
    r = await save({ discountRules: { multiple: true }, giftCards: { sellOnline: true, amounts: [], minCents: 500, maxCents: 50000 } });
    ok("a bad Gift cards section: 400 naming it, and nothing is saved — not even the good Discount codes section",
      r.status === 400 && r.body.section === "Gift cards" && r.body.message === "Give 1 to 6 amounts for the buttons." && (await admin({ action: "getDiscountRules" })).body.discountRules.multiple === false);
    const log0 = q1("SELECT max(id) AS m FROM audit_log").m;
    r = await save({ discountRules: { multiple: true }, giftCards: { sellOnline: false, amounts: [1500], minCents: 500, maxCents: 2500 } });
    ok("both good: saved together, the sections named “Discount codes” and “Gift cards”",
      r.status === 200 && r.body.sections.includes("Discount codes") && r.body.sections.includes("Gift cards") && r.body.settings.discountRules.multiple === true && same(r.body.settings.giftCards.amounts, [1500]));
    ok("…read back by their own actions", (await admin({ action: "getDiscountRules" })).body.discountRules.multiple === true && (await admin({ action: "getGiftCardSettings" })).body.giftCards.maxCents === 2500);
    const rows = d1.q("SELECT action, detail FROM audit_log WHERE id > ?", log0);
    ok("…each with its own audit row, from and to", rows.some(x => x.action === "settings.discount_rules_set" && JSON.parse(x.detail).to.multiple === true)
      && rows.some(x => x.action === "settings.gift_cards_set" && JSON.parse(x.detail).to.maxCents === 2500 && JSON.parse(x.detail).from.maxCents === 1000000));
    r = await save({ discountRules: { multiple: false } }, "manager");
    ok("a Manager (Global settings read only): 403, nothing saved", r.status === 403 && (await admin({ action: "getDiscountRules" })).body.discountRules.multiple === true);

    const Z = await issue(2000, {});
    r = await save({ payments: { cash: true, giftCard: false } });
    ok("Payment methods → Gift card off: saved", r.status === 200 && JSON.parse(q1("SELECT value FROM global_settings WHERE key = 'enabledPayments'").value).giftCard === false);
    r = await sale({ giftCards: [{ code: Z.code }] });
    ok("…then a Local sale with a gift card: 400 “Gift cards aren't available right now.”, no sale and nothing taken",
      r.status === 400 && r.body.message === "Gift cards aren't available right now." && card(Z.card.id).balanceCents === 2000);
    r = await save({ payments: { cash: true, giftCard: true } });
    r = await sale({ giftCards: [{ code: Z.code }] });
    ok("…back on: the card pays $20 of the sale", r.status === 200 && r.body.giftCards[0].ok === true && r.body.giftCards[0].taken === 20 && card(Z.card.id).balanceCents === 0);
  }

  console.log("\n=== Gift cards on a Local sale ===");
  {
    const G1 = await issue(3000, {}), G2 = await issue(10000, {});
    for (const [extra, msg] of [
      [{ giftCards: "x" }, "At most 3 gift cards can be used on an order."],
      [{ giftCards: [{ code: "a" }, { code: "b" }, { code: "c" }, { code: "d" }] }, "At most 3 gift cards can be used on an order."],
      [{ giftCards: [{ code: "" }] }, "That gift card number isn't right."],
      [{ giftCards: [null] }, "That gift card number isn't right."],
      [{ giftCards: [{ code: 1234 }] }, "That gift card number isn't right."],
      [{ giftCards: [{ code: G1.code, amount: -1 }] }, "That gift card amount isn't valid."],
      [{ giftCards: [{ code: G1.code, amount: "lots" }] }, "That gift card amount isn't valid."],
    ]) {
      const x = await sale(extra);
      if (!(x.status === 400 && x.body.message === msg)) ok("a sale with " + JSON.stringify(extra) + " is refused with " + msg, false);
    }
    ok("refused before anything is recorded: more than 3 cards, a card with no number, an amount that isn't one", card(G1.card.id).balanceCents === 3000);
    const before = q1("SELECT count(*) AS n FROM orders").n;
    let r = await as("clerk", { action: "createLocalSale", org: "acme", requestId: "req392clerk", items: tee, paymentMethod: "Cash", giftCards: [{ code: G1.code }] });
    ok("a role that may record a sale but not payments: 403 “Your role can't record payments.”, and no sale", r.status === 403 && /can't record payments/.test(r.body.message) && q1("SELECT count(*) AS n FROM orders").n === before);
    r = await as("staff", { action: "createLocalSale", org: "acme", requestId: "req392multi", items: tee, paymentMethod: "Cash",
      giftCards: [{ code: G1.code }, { code: "ABCD-EFGH-JKLM-NPQ2" }, { code: G1.code.toLowerCase() }] });
    ok("Back office: the first card pays its $30; a number that isn't a card is reported and the sale still stands; the same card typed twice is spent once",
      r.status === 200 && r.body.giftCards.length === 2 && r.body.giftCards[0].ok === true && r.body.giftCards[0].taken === 30 && r.body.giftCards[0].last4 === G1.card.last4 &&
      r.body.giftCards[1].ok === false && r.body.giftCards[1].reason === "That gift card number isn't right." && card(G1.card.id).balanceCents === 0);
    const o = q1("SELECT * FROM orders WHERE orderId = ?", r.body.orderId);
    ok("…the sale is recorded, $70 still owed", !!o && !o.paid && q1("SELECT sum(amountCents) AS n FROM order_payments WHERE orderId = ?", o.orderId).n === 3000);
    const au = lastAudit("order.created_local_sale");
    ok("…its audit row lists the card that paid and how much", au.orderId === o.orderId && same(au.d.giftCards, [{ last4: G1.card.last4, amount: 30 }]));
    r = await sale({ giftCards: [{ code: G2.code, amount: 40 }], paid: true });
    const o2 = q1("SELECT * FROM orders WHERE orderId = ?", r.body.orderId);
    ok("a card for $40 of it with Paid ticked: $40 by card, the rest settled as the sale's own method, paid", r.status === 200 && r.body.giftCards[0].taken === 40 && !!o2.paid &&
      card(G2.card.id).balanceCents === 6000 && q1("SELECT sum(amountCents) AS n FROM order_payments WHERE orderId = ? AND giftCardId IS NULL", o2.orderId).n === 6000);
    r = await sale({});
    ok("a sale without cards answers no giftCards", r.status === 200 && r.body.giftCards === undefined);
  }

  console.log("\n=== Reorder: getOrderForReorder ===");
  let PAST;
  {
    await admin({ action: "createProduct", org: "acme", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
    const r0 = await admin({ action: "createLocalSale", org: "acme", requestId: "req392past", customerId: 1, paymentMethod: "Cash", items: [
      { productId: "mug", size: "", qty: 2 },
      { productId: "__custom__", name: "Club Tee", type: "other", size: "M", customUnitPrice: 18.5, qty: 3, taxable: true },
      { productId: "__custom__", name: "Setup fee — Club crest", type: "other", size: "", customUnitPrice: 30, qty: 1, taxable: false },
      { productId: "__custom__", name: "Old hat", type: "other", size: "", customUnitPrice: 9, qty: 1, taxable: false },
      { productId: "__custom__", name: "A card", type: "other", size: "", customUnitPrice: 25, qty: 1, taxable: false },
    ] });
    PAST = r0.body.orderId;
    d1._raw.exec(`UPDATE order_items SET cancelDate = '2026-01-03' WHERE orderId = '${PAST}' AND name = 'Old hat';
      UPDATE order_items SET productId = '__giftcard__', type = 'giftcard' WHERE orderId = '${PAST}' AND name = 'A card';`);
    let r = await admin({ action: "getOrderForReorder", orderId: PAST });
    ok("a past order: its shop, customer (from the customer record) and what it reorders", r.status === 200 && r.body.orgId === "acme" && r.body.customerId === 1 && r.body.reorderOf === PAST &&
      same(r.body.customer, { name: "Pat Example", email: "pat@example.com", phone: "555-0100", company: "Example Club" }));
    ok("…the same, flat and under reorder", same(r.body.reorder.lines, r.body.lines) && r.body.reorder.reorderOf === PAST);
    ok("…its lines without the cancelled one, the gift card and the fee", r.body.lines.map(l => l.name).join("|") === "Club Mug|Club Tee");
    const [mug, tee2] = r.body.lines;
    ok("a catalog line keeps the product and quantity, and what one cost then", mug.productId === "mug" && mug.qty === 2 && mug.priceThen === 10 && mug.customUnitPrice === undefined);
    ok("a custom line keeps its name, size, type, taxability and price", tee2.productId === "__custom__" && tee2.size === "M" && tee2.qty === 3 && tee2.taxable === true && tee2.customUnitPrice === 18.5 && tee2.priceThen === 18.5);
    r = await as("clerk", { action: "getOrderForReorder", orderId: PAST });
    ok("a role that may start a sale but not see customer records: the lines, without the customer's record id", r.status === 200 && r.body.customerId === undefined && r.body.reorder.customerId === undefined && r.body.lines.length === 2);
    r = await admin({ action: "getOrderForReorder", orderId: "" });
    ok("no order id: 400 “Invalid order ID”", r.status === 400 && r.body.message === "Invalid order ID");
    r = await admin({ action: "getOrderForReorder", orderId: "bad id!" });
    ok("an id that isn't one: 400", r.status === 400 && r.body.message === "Invalid order ID");
    r = await admin({ action: "getOrderForReorder", orderId: "ACME-NOPE" });
    ok("an order that isn't there: 404 “Order not found”", r.status === 404 && r.body.message === "Order not found");
    r = await admin({ action: "getOrderForReorder", orderId: PAST, org: "rec" });
    ok("asked from another shop: 404", r.status === 404);
    const walkIn = await admin({ action: "createLocalSale", org: "acme", requestId: "req392walk", contact: "Walk@Example.com", customerName: "Walk In", paymentMethod: "Cash", items: tee });
    d1._raw.exec(`UPDATE orders SET customerId = NULL WHERE orderId = '${walkIn.body.orderId}'`);
    r = await admin({ action: "getOrderForReorder", orderId: walkIn.body.orderId });
    ok("an order with no customer record: the name and email typed on it", r.status === 200 && r.body.customerId === null && r.body.customer.name === "Walk In" && r.body.customer.email === "walk@example.com");
    const gone = await admin({ action: "createLocalSale", org: "acme", requestId: "req392gone", paymentMethod: "Cash", items: tee });
    d1._raw.exec(`UPDATE order_items SET cancelDate = '2026-01-03' WHERE orderId = '${gone.body.orderId}'`);
    r = await admin({ action: "getOrderForReorder", orderId: gone.body.orderId });
    ok("every line cancelled: 409 “Nothing on this order can be reordered.” (not an empty sale)", r.status === 409 && r.body.message === "Nothing on this order can be reordered.");
  }

  console.log("\n=== Reorder: createLocalSale reorderOf ===");
  {
    let r = await sale({ reorderOf: PAST });
    ok("a sale started from a past order remembers it (orders.reorderOf)", r.status === 200 && q1("SELECT reorderOf FROM orders WHERE orderId = ?", r.body.orderId).reorderOf === PAST);
    ok("…and its audit row says so", lastAudit("order.created_local_sale").d.reorderOf === PAST);
    r = await sale({ reorderOf: "" });
    ok("reorderOf empty: an ordinary sale", r.status === 200 && q1("SELECT reorderOf FROM orders WHERE orderId = ?", r.body.orderId).reorderOf === "" && lastAudit("order.created_local_sale").d.reorderOf === undefined);
    const before = q1("SELECT count(*) AS n FROM orders").n;
    for (const bad of ["bad id!", 12345, "ACME-NOPE"]) {
      const x = await sale({ reorderOf: bad });
      if (!(x.status === 400 && x.body.message === "That order can't be copied.")) ok("reorderOf " + JSON.stringify(bad) + " is refused", false);
    }
    const rec = await admin({ action: "createLocalSale", org: "rec", requestId: "req392rec", items: tee, paymentMethod: "Cash" });
    r = await sale({ reorderOf: rec.body.orderId });
    ok("an id that isn't one, not text, an order that isn't there or another shop's: 400 “That order can't be copied.”, and no sale",
      r.status === 400 && r.body.message === "That order can't be copied." && q1("SELECT count(*) AS n FROM orders").n === before + 1);
  }

  console.log("\n=== Before migrations/0120 (the tables not there yet) ===");
  {
    d1._raw.exec("DROP TABLE gift_card_ledger; DROP TABLE gift_cards;");
    let r = await admin({ action: "listGiftCards" });
    ok("the list: empty, not an error", r.status === 200 && r.body.cards.length === 0 && r.body.total === 0);
    r = await admin({ action: "getGiftCard", id: 1 });
    ok("a card: 404", r.status === 404);
    r = await admin({ action: "issueGiftCard", amountCents: 1000 });
    ok("issuing: 400 “Gift cards need the latest database update…”", r.status === 400 && /latest database update/.test(r.body.message));
    r = await admin({ action: "giftCardTotals" });
    ok("the totals: all $0", r.status === 200 && same(r.body.totals, { sold: 0, redeemed: 0, adjusted: 0, refunded: 0, outstanding: 0 }));
  }
})().catch((e) => { origErr(e); process.exitCode = 1; });
