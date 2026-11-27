const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

// Quotes (migrations/0109), the customer's side: the public endpoint functions/api/estimate.js (GET the quote by
// the emailed link's token; POST accept or ask for changes), its route in src/worker.js, and the quote emails in
// functions/_lib/email.js (sendEstimateEmail / buildEstimateEmail / estimateLinesView and the owner's
// sendEstimateResponseNotification). Real SQL (sql.js) under the real db.js, orders.js (the staff actions that make
// and send a quote, and convertEstimateToOrder_ that accepting goes through), email.js and rateLimit.js.
// Dates are worked out from the business's own day (localToday) or are far from today; the time zone is set here.
// Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");

const mail = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  throw new Error("unexpected fetch " + url);
};

// One scope with the shared libraries; orders.js and estimate.js each in their own inner scope (both declare
// onRequestPost). estimate.js gets the REAL rate limiter; orders.js the usual stub.
const M = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  strip(read("functions/_lib/boxSize.js")) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'olive@example.test';\n" + require("./testlib/roles").adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {}, features: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  "const ordersMod = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn { onRequestPost, convertEstimateToOrder_ }; })();\n" +
  "const convertEstimateToOrder_ = (...a) => globalThis.__convertSpy ? globalThis.__convertSpy(ordersMod.convertEstimateToOrder_, a) : ordersMod.convertEstimateToOrder_(...a);\n" +
  "const estimateApi = (function(){\n" + strip(read("functions/_lib/rateLimit.js")) + "\n" + strip(read("functions/api/estimate.js")) + "\nreturn { onRequestGet, onRequestPost }; })();\n" +
  "return { ordersApi: ordersMod.onRequestPost, estimateApi, createProduct, setSalesTaxSettings, setLocaleSettings, setFeatures, localToday, getEstimate, getOrderById, " +
  "estimateLinesView, buildEstimateEmail, sendEstimateEmail, sendEstimateResponseNotification };")();

const pause = (ms) => new Promise(r => setTimeout(r, ms));
const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&rarr;/g, "→").replace(/\s+/g, " ");
const dayAfter = (day, n) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Errors the product logs on purpose are kept, not printed (a printed stack could look like a failed check).
const logged = [];
const realError = console.error;
const quietly = async (fn) => { console.error = (...a) => logged.push(a.map(String).join(" ")); try { return await fn(); } finally { console.error = realError; } };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const env = { DB: d1, SIGNING_SECRET: "test-signing-secret", ...MAIL_ENV };
  await M.setLocaleSettings(d1, { timeZone: "America/Chicago" });
  await M.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "Example County", taxMode: "exclusive" });
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, accent, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','#1E7A4C','t','t',1);`);
  await M.createProduct(d1, "club", { productId: "polo", type: "shirt", name: "Club polo", pricingMode: "sized", sizePricing: { M: 25, L: 27 }, visible: true, noDesignNeeded: true,
    qtyBreaks: [{ minQty: 12, off: 3 }] });
  await M.createProduct(d1, "club", { productId: "cap", type: "cap", name: "Club cap", pricingMode: "flat", flatPrice: 18, visible: true, noDesignNeeded: true });

  // ---- helpers -------------------------------------------------------------------------------------------------
  const admin = async (body) => {
    const waits = [];
    const res = await M.ordersApi({ env, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  let ipN = 0;
  const freshIp = () => "198.51.100." + (++ipN);
  // One request to the public endpoint. waitUntil's work is finished before this returns, unless noWait.
  const ctxFor = (request, e, opts = {}) => {
    const waits = [];
    const c = { env: e || env, request };
    if (!opts.noWait) c.waitUntil = (p) => waits.push(Promise.resolve(p));
    return { c, waits };
  };
  const reqHeaders = (ip) => ({ get: (k) => (/cf-connecting-ip/i.test(k) ? ip : null) });
  const get = async (token, opts = {}) => {
    const url = "https://club.example.com/api/estimate" + (token === undefined ? "" : "?token=" + encodeURIComponent(token));
    const { c, waits } = ctxFor({ url, headers: reqHeaders(opts.ip || freshIp()) }, opts.env, opts);
    const res = await M.estimateApi.onRequestGet(c);
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()), headers: res.headers };
  };
  const post = async (body, opts = {}) => {
    const { c, waits } = ctxFor({ url: "https://club.example.com/api/estimate", headers: reqHeaders(opts.ip || freshIp()),
      json: async () => { if (body === "not json") throw new SyntaxError("Unexpected token"); return body; } }, opts.env, opts);
    const res = await M.estimateApi.onRequestPost(c);
    const out = { status: res.status, body: JSON.parse(await res.text()), headers: res.headers };
    if (!opts.noWait) await Promise.all(waits);
    return out;
  };
  const estRow = (id) => d1.q("SELECT * FROM estimates WHERE id = ?", id)[0];
  const audits = (action) => d1.q("SELECT * FROM audit_log WHERE action = ? ORDER BY id", action);
  const lastAudit = (action) => { const a = audits(action); return a[a.length - 1] || null; };
  const notices = () => d1.q("SELECT * FROM owner_notices ORDER BY id");
  const lastNotice = () => { const n = notices(); return n[n.length - 1] || null; };
  const issues = () => d1.q("SELECT * FROM system_issues ORDER BY id");
  const tokenOf = (link) => (/[?&]estimate=([a-z0-9]+)$/.exec(String(link || "")) || [])[1] || "";

  const custId = (await admin({ action: "saveCustomer", name: "Pat Example", company: "", email: "pat@example.com", phone: "555-0101" })).body.id;
  const noMailCust = (await admin({ action: "saveCustomer", name: "", company: "Example Boosters", email: "", phone: "555-0102" })).body.id;
  // A quote made, filled and sent by staff the way the Quotes page does it. Answers { id, number, token, link, send }.
  const quote = async ({ customerId = custId, title = "Spring polos", message = "", internalNote = "", expiresOn = "2099-12-31", items, email } = {}) => {
    const c = await admin({ action: "createEstimate", org: "club", customerId, title, message, internalNote, expiresOn });
    const s = await admin({ action: "saveEstimate", id: c.body.id, items: items || [{ kind: "custom", name: "Club banner", qty: 1, unitPrice: 40, taxable: true }] });
    const send = await admin({ action: "sendEstimate", id: c.body.id, ...(email ? { email } : {}) });
    return { id: c.body.id, number: c.body.number, token: tokenOf(send.body.link), link: send.body.link, send, saved: s };
  };
  const ok200 = (r) => r.status === 200 && r.body.status === "ok";

  ok("the test's own data: two customers, a shop with a 6% tax added on top, a polo with a 12-piece break and a cap",
    Number.isInteger(custId) && Number.isInteger(noMailCust) && d1.q("SELECT count(*) n FROM products")[0].n === 2);

  // ==============================================================================================================
  console.log("=== The route: /api/estimate reaches estimate.js ===");
  {
    const w = await import("./src/worker.js");
    const est = await import("./functions/api/estimate.js");
    ok("ROUTES.estimate is the estimate.js module, with a GET and a POST handler",
      w.ROUTES.estimate === est && typeof w.ROUTES.estimate.onRequestGet === "function" && typeof w.ROUTES.estimate.onRequestPost === "function");
    const wctx = () => ({ waitUntil: () => {}, passThroughOnException() {} });
    let r = await w.handleRequest(new Request("https://club.example.com/api/estimate?token=x"), {}, wctx());
    let b = await r.json();
    ok("GET /api/estimate through the Worker reaches the handler (no database here: its own 500, \"Server misconfigured\")", r.status === 500 && b.message === "Server misconfigured");
    r = await w.handleRequest(new Request("https://club.example.com/api/estimate", { method: "POST", body: "{}" }), {}, wctx());
    b = await r.json();
    ok("POST /api/estimate through the Worker reaches the POST handler the same way", r.status === 500 && b.message === "Server misconfigured");
    r = await w.handleRequest(new Request("https://club.example.com/api/estimate", { method: "PUT", body: "{}" }), {}, wctx());
    ok("any other method is 405", r.status === 405);
  }

  // ==============================================================================================================
  console.log("=== Sending a quote emails its link (sendEstimateEmail through the staff action) ===");
  const items = [
    { kind: "product", productId: "polo", size: "M", qty: 8 },
    { kind: "product", productId: "polo", size: "L", qty: 4 },
    { kind: "product", productId: "cap", size: "OSFA", qty: 2, customUnitPrice: 15 },
    { kind: "custom", name: "Club banner <big>", qty: 1, unitPrice: 40, taxable: false },
    { kind: "fee", feeKind: "setup", name: "Club crest", amount: 30, taxable: true },
    { kind: "fee", feeKind: "digitizing", name: "", amount: 20, taxable: false },
  ];
  mail.length = 0;
  const A = await quote({ title: "Spring polos & caps", message: "Thanks for asking — <b>see below</b>.", internalNote: "SECRET-NOTE margin is thin", items });
  const other = await quote({ title: "OTHER-QUOTE-TITLE", internalNote: "OTHER-QUOTE-NOTE" });
  const quoteMail = mail.find(m => m.subject.includes(A.number));
  ok("the staff send answers ok with the link /?estimate=<32 lower-case hex> on the shop's own address",
    A.send.status === 200 && A.send.body.emailSent === true && /^https:\/\/club\.example\.com\/\?estimate=[0-9a-f]{32}$/.test(A.link) && A.token.length === 32);
  ok("the quote email goes to the customer's address", !!quoteMail && quoteMail.to === "pat@example.com");
  ok("its subject is \"Quote <number> — <shop> · <total>\"", !!quoteMail && quoteMail.subject === `Quote ${A.number} — Example Club · $411.92`);
  const qh = quoteMail ? quoteMail.htmlBody : "", qt = quoteMail ? quoteMail.body : "";
  ok("it says to use the button to accept the quote or ask for changes", plain(qh).includes("Here is your quote. Use the button below to accept it or to ask for changes.") &&
    qt.includes("Here is your quote. Use the button below to accept it or to ask for changes."));
  ok("the HTML has a button to the link and the link to copy", qh.includes(`<a href="${A.link}"`) && qh.includes("View &amp; accept quote &rarr;") && qh.includes("If the button doesn't work, copy this link: " + A.link));
  ok("the shop's note to the customer is escaped in the HTML", qh.includes("Thanks for asking — &lt;b&gt;see below&lt;/b&gt;.") && !qh.includes("<b>see below</b>"));
  ok("the number and the title (escaped) are shown", qh.includes(`<strong>Quote:</strong> ${A.number} · Spring polos &amp; caps`));
  ok("a line a quantity break took something off shows the list price struck through", qh.includes("$22.00<div style=\"font-size:12px;color:#666\"><s>$25.00</s> quantity price</div>") && qh.includes("<s>$27.00</s>"));
  ok("a line with a typed price shows no \"was\" price", !qh.includes("<s>$18.00</s>"));
  ok("a custom line's name is escaped", qh.includes("Club banner &lt;big&gt;") && !qh.includes("<big>"));
  ok("fees read as their kind with the description, and an untaxed one says so", qh.includes("Setup fee — Club crest</td>") && qh.includes("Digitizing fee <span style=\"font-size:12px;color:#666\">(not taxed)</span>"));
  ok("tax added on top is its own row, then the Total", plain(qh).includes("Subtotal $392.00 Sales tax (6%) $19.92 Total $411.92"));
  ok("the expiry is said as a long date", qh.includes("This quote is good through Thursday, December 31, 2099."));
  ok("the plain-text part has the lines with the \"was\" price, the fees, the totals, the expiry and the link",
    qt.includes("8 × Club polo (M)  $22.00 each (was $25.00)  $176.00") && qt.includes("2 × Club cap  $15.00 each  $30.00") &&
    qt.includes("  Digitizing fee (not taxed)  $20.00") && qt.includes("Sales tax (6%): $19.92\nTotal: $411.92") &&
    qt.includes("This quote is good through Thursday, December 31, 2099.") && qt.includes("View and accept: " + A.link));
  ok("the email never carries the internal note", !qh.includes("SECRET-NOTE") && !qt.includes("SECRET-NOTE"));

  // ==============================================================================================================
  console.log("=== GET: what the customer sees ===");
  ok("before it is opened, the quote has no viewedAt", !estRow(A.id).viewedAt);
  let r = await get(A.token);
  const v = r.body.estimate || {};
  ok("a sent quote's link answers 200 with status ok", ok200(r));
  ok("it names the quote, its title and the shop's note", v.number === A.number && v.title === "Spring polos & caps" && v.message === "Thanks for asking — <b>see below</b>.");
  ok("it names the shop (id, name, accent) and the customer", v.orgId === "club" && v.orgName === "Example Club" && v.orgAccent === "#1E7A4C" && v.customerName === "Pat Example");
  ok("it says where the quote stands: sent, not expired, its last day, and that it can be accepted or answered",
    v.status === "sent" && v.expired === false && v.expiresOn === "2099-12-31" && v.canAccept === true && v.canAskChanges === true);
  ok("it has when it was sent, and no answer, acceptance, customer note or order yet",
    !!v.sentAt && v.respondedAt === "" && v.acceptedAt === "" && v.customerNote === "" && v.orderId === "");
  const L = v.lines || [], F = v.fees || [];
  ok("the four lines come in order, the fees apart", L.length === 4 && F.length === 2 && L.map(l => l.name).join("|") === "Club polo|Club polo|Club cap|Club banner <big>");
  ok("a polo line has its size, quantity, the break price, the list price as \"was\" and its total",
    L[0] && L[0].kind === "product" && L[0].size === "M" && L[0].qty === 8 && L[0].unitPrice === 22 && L[0].wasPrice === 25 && L[0].lineTotal === 176 && L[0].taxable === true);
  ok("…and the other size its own", L[1] && L[1].size === "L" && L[1].qty === 4 && L[1].unitPrice === 24 && L[1].wasPrice === 27 && L[1].lineTotal === 96);
  ok("the cap at a typed price has no \"was\" price, and its one-size size is left blank", L[2] && L[2].unitPrice === 15 && L[2].wasPrice === null && L[2].size === "" && L[2].lineTotal === 30);
  ok("the custom line is kind custom, untaxed, with no \"was\" price", L[3] && L[3].kind === "custom" && L[3].taxable === false && L[3].wasPrice === null && L[3].lineTotal === 40);
  ok("the fees: \"Setup fee — Club crest\" $30 taxed, \"Digitizing fee\" $20 untaxed",
    F[0] && F[0].feeKind === "setup" && F[0].name === "Setup fee — Club crest" && F[0].amount === 30 && F[0].taxable === true &&
    F[1] && F[1].feeKind === "digitizing" && F[1].name === "Digitizing fee" && F[1].amount === 20 && F[1].taxable === false);
  ok("the totals as sent: subtotal, tax, total, added on top at 6%, and the tax's place",
    v.subtotal === 392 && v.tax === 19.92 && v.total === 411.92 && v.taxMode === "exclusive" && v.taxRate === 6 && v.taxJurisdiction === "Example County");
  const json = JSON.stringify(r.body);
  ok("it never shows the internal note, the token, who it was sent to or made by, or ids of the customer",
    !json.includes("SECRET-NOTE") && !/internalNote|sentTo|createdBy|customerId|"token"/.test(json) && !json.includes(A.token) && !json.includes("pat@example.com"));
  ok("it never shows costs or list prices by their stored names", !/cost|listUnitPrice|breakOff|Cents/i.test(json));
  ok("it never shows anything of another quote", !json.includes("OTHER-QUOTE") && !json.includes(other.number));
  ok("its exact keys are the customer's view and nothing more", JSON.stringify(Object.keys(v).sort()) === JSON.stringify(["acceptedAt", "canAccept", "canAskChanges", "customerName", "customerNote", "discount", "discountCodes", "discounts", "expired",
    "expiresOn", "fees", "lines", "message", "number", "orderId", "orgAccent", "orgId", "orgName", "respondedAt", "sentAt", "shippingOff", "status", "subtotal", "tax", "taxJurisdiction", "taxMode", "taxRate", "title", "total"].sort()) &&
    JSON.stringify(Object.keys(L[0]).sort()) === JSON.stringify(["detail", "kind", "lineTotal", "name", "qty", "size", "taxable", "unitPrice", "wasPrice"]));
  const firstView = estRow(A.id).viewedAt;
  ok("opening the link marks the quote viewed", !!firstView);
  await pause(5);
  await get(A.token);
  ok("opening it again keeps the first time it was viewed", estRow(A.id).viewedAt === firstView);
  r = await get("  " + A.token + " ");
  ok("spaces around the token are ignored", ok200(r) && r.body.estimate.number === A.number);

  console.log("=== GET: links that aren't a quote ===");
  const bad = (x) => x.status === 404 && x.body.status === "error" && x.body.message === "This quote link isn't valid.";
  ok("an unknown token of the right shape: 404 \"This quote link isn't valid.\"", bad(await get("0123456789abcdef0123456789abcdef")));
  ok("no token at all: the same 404", bad(await get(undefined)));
  ok("an upper-case token (not the shape the links have): 404", bad(await get(A.token.toUpperCase())));
  ok("a token shorter than 16 characters: 404", bad(await get("abc123")));
  ok("a token longer than 64 characters: 404", bad(await get("a".repeat(65))));
  ok("a token with other characters: 404", bad(await get(A.token.slice(0, 20) + "-_' OR 1=1")));
  // A draft has no token; one given a token by hand is still not shown.
  const D = await admin({ action: "createEstimate", org: "club", customerId: custId, title: "Draft only" });
  d1._raw.exec(`UPDATE estimates SET token = 'feedfacefeedfacefeedfacefeedface' WHERE id = ${D.body.id}`);
  ok("a draft quote, even with a token, is not shown: 404", bad(await get("feedfacefeedfacefeedfacefeedface")));
  ok("…and a draft can't be answered either", bad(await post({ token: "feedfacefeedfacefeedfacefeedface", action: "changes", note: "Hi" })));
  // A quote whose shop is gone.
  const G = await quote({ title: "Ghost shop" });
  d1._raw.exec(`PRAGMA foreign_keys = OFF; INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('gone','gone','Gone','t','t');
    UPDATE estimates SET orgId = 'nowhere' WHERE id = ${G.id}; PRAGMA foreign_keys = ON;`);
  ok("a quote whose shop no longer exists: 404", bad(await get(G.token)));
  // Before migration 0109 (no estimates table): the same answer, not an error.
  const old = await createD1();
  old._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f < "0109").sort()) old.execFile(read("migrations/" + f));
  const oldEnv = { DB: old };
  ok("on a database without the quotes tables yet, a link answers the same 404", bad(await get(A.token, { env: oldEnv })));
  ok("…and so does an answer posted to it", bad(await post({ token: A.token, action: "accept" }, { env: oldEnv })));

  // ==============================================================================================================
  console.log("=== The Quotes feature switched off ===");
  await M.setFeatures(d1, { quotes: false });
  const off = (x) => x.status === 403 && x.body.status === "error" && x.body.feature === "quotes" && x.body.message === "Quotes aren't available.";
  ok("GET with a good link: 403 \"Quotes aren't available.\"", off(await get(A.token)));
  ok("GET with a bad link: the same 403 (nothing about the link is said)", off(await get("zz")));
  ok("POST accept: the same 403, and the quote is untouched", off(await post({ token: A.token, action: "accept" })) && estRow(A.id).status === "sent");
  ok("POST that isn't even JSON: the same 403", off(await post("not json")));
  await M.setFeatures(d1, { quotes: true });
  ok("switched back on, the link works again", ok200(await get(A.token)));

  // ==============================================================================================================
  console.log("=== POST: requests refused before anything changes ===");
  r = await post("not json");
  ok("a body that isn't JSON: 400 \"Invalid JSON\"", r.status === 400 && r.body.message === "Invalid JSON");
  ok("a bad token: 404 \"This quote link isn't valid.\"", bad(await post({ token: "nope", action: "accept" })));
  ok("no token: the same 404", bad(await post({ action: "accept" })));
  r = await post({ token: A.token, action: "decline" });
  ok("an action other than accept or changes: 400 \"Unknown action\"", r.status === 400 && r.body.message === "Unknown action");
  r = await post({ token: A.token });
  ok("no action: the same 400", r.status === 400 && r.body.message === "Unknown action");
  r = await post({ token: A.token, action: "changes", note: "x".repeat(2001) });
  ok("a note over 2,000 characters: 400, in a plain sentence", r.status === 400 && r.body.message === "Please keep your message under 2,000 characters.");
  r = await post({ token: A.token, action: "accept", note: "y".repeat(2001) });
  ok("…for an accept too", r.status === 400 && r.body.message === "Please keep your message under 2,000 characters.");
  r = await post({ token: A.token, action: "changes" });
  ok("a changes request with no note: 400 \"Please tell us what you'd like changed.\"", r.status === 400 && r.body.message === "Please tell us what you'd like changed.");
  r = await post({ token: A.token, action: "changes", note: "   \n  " });
  ok("…or a note of only spaces: the same 400", r.status === 400 && r.body.message === "Please tell us what you'd like changed.");
  ok("none of those changed the quote, or told the owner", estRow(A.id).status === "sent" && !estRow(A.id).respondedAt && notices().length === 0 &&
    audits("estimate.changes_requested").length === 0 && audits("estimate.accepted").length === 0);

  // ==============================================================================================================
  console.log("=== POST changes: the customer asks for changes ===");
  const ip = "203.0.113.7";
  r = await post({ token: A.token, action: "changes", note: "  Could the caps be navy?\nAnd 2 more polos.  " }, { ip });
  ok("it answers 200: action changes, no order, no invoice", ok200(r) && r.body.action === "changes" && r.body.orderId === "" && r.body.invoiceSent === false);
  ok("the answer carries the quote as it is now: waiting on changes, with their note back, and no accept",
    r.body.estimate && r.body.estimate.status === "changes" && r.body.estimate.customerNote === "Could the caps be navy?\nAnd 2 more polos." &&
    r.body.estimate.canAccept === false && r.body.estimate.canAskChanges === true && !!r.body.estimate.respondedAt);
  ok("the quote is saved as changes with the note (trimmed) and when they answered",
    estRow(A.id).status === "changes" && estRow(A.id).customerNote === "Could the caps be navy?\nAnd 2 more polos." && !!estRow(A.id).respondedAt);
  let au = lastAudit("estimate.changes_requested");
  ok("the audit log has estimate.changes_requested by customer-quote, from their address, with the number and note",
    !!au && au.actor === "customer-quote" && au.ip === ip && au.orgId === "club" && !au.orderId &&
    JSON.stringify(JSON.parse(au.detail)) === JSON.stringify({ estimate: A.number, note: "Could the caps be navy?\nAnd 2 more polos." }));
  let nt = lastNotice();
  ok("the owner is told (queued for the roll-up): \"Pat Example asked for changes to quote …\" with their note",
    notices().length === 1 && nt.kind === "quote" && nt.orgId === "club" && nt.orderId === A.number &&
    nt.summary === `Pat Example asked for changes to quote ${A.number}` && nt.detail === "Their note: Could the caps be navy?\nAnd 2 more polos.");
  r = await post({ token: A.token, action: "accept" });
  ok("accepting while waiting on changes: 409, in a plain sentence", r.status === 409 && r.body.message === "You've asked for changes to this quote — we'll send you the revised quote to accept.");
  ok("…and nothing changed", estRow(A.id).status === "changes" && !estRow(A.id).orderId);
  r = await get(A.token);
  ok("GET while waiting on changes shows their note and no accept", ok200(r) && r.body.estimate.status === "changes" && r.body.estimate.customerNote.startsWith("Could the caps") &&
    r.body.estimate.canAccept === false && r.body.estimate.canAskChanges === true);
  const long = "z".repeat(2000);
  r = await post({ token: A.token, action: "changes", note: long });
  ok("asking again (a note of exactly 2,000 characters is fine) replaces the first note", ok200(r) && estRow(A.id).customerNote === long && notices().length === 2);
  // Without waitUntil (a caller that has none), the record is written before the answer.
  r = await post({ token: A.token, action: "changes", note: "Navy caps, please." }, { noWait: true });
  ok("with no waitUntil, the audit row and the owner's notice are written before it answers",
    ok200(r) && JSON.parse(lastAudit("estimate.changes_requested").detail).note === "Navy caps, please." && lastNotice().summary.includes("asked for changes") && notices().length === 3);

  // ==============================================================================================================
  console.log("=== POST accept: the quote becomes an order and its invoice is emailed ===");
  const resend = await admin({ action: "sendEstimate", id: A.id });
  ok("staff send it again: the same link", resend.status === 200 && tokenOf(resend.body.link) === A.token && estRow(A.id).status === "sent");
  mail.length = 0;
  r = await post({ token: A.token, action: "accept", note: "  Looks good  " }, { ip });
  const orderA = "CLUB-" + A.number.replace(/[^A-Za-z0-9]/g, "");
  ok("it answers 200: action accept, the new order's number, and invoiceSent true", ok200(r) && r.body.action === "accept" && r.body.orderId === orderA && r.body.invoiceSent === true);
  ok("the answer's quote is converted, names the order, and can't be answered again",
    r.body.estimate && r.body.estimate.status === "converted" && r.body.estimate.orderId === orderA && r.body.estimate.canAccept === false &&
    r.body.estimate.canAskChanges === false && !!r.body.estimate.acceptedAt && r.body.estimate.customerNote === "");
  const order = await M.getOrderById(d1, orderA);
  ok("the order exists, for the quote's customer, at the quoted prices", !!order && Number(d1.q("SELECT customerId FROM orders WHERE orderId = ?", orderA)[0].customerId) === custId &&
    Number(order.subtotal) === 392 && order.items.length === 6 && order.items.some(i => i.productId === "polo" && i.size === "M" && Number(i.unitPrice) === 22 && Number(i.qty) === 8));
  ok("the quote is marked converted with that order", estRow(A.id).status === "converted" && estRow(A.id).orderId === orderA && !!estRow(A.id).acceptedAt);
  const inv = mail.find(m => m.to === "pat@example.com" && m.subject.includes(orderA));
  ok("the order's invoice is emailed to the customer", !!inv);
  au = lastAudit("estimate.accepted");
  ok("the audit log has estimate.accepted by customer-quote, with the order, the number and the note",
    !!au && au.actor === "customer-quote" && au.ip === ip && au.orderId === orderA &&
    JSON.stringify(JSON.parse(au.detail)) === JSON.stringify({ estimate: A.number, orderId: orderA, note: "Looks good" }));
  ok("the order was made through convertEstimateToOrder_ (its estimate.converted row, actor customer-quote)",
    !!lastAudit("estimate.converted") && lastAudit("estimate.converted").orderId === orderA && lastAudit("estimate.converted").actor === "customer-quote");
  nt = lastNotice();
  ok("the owner is told: \"Pat Example accepted quote … — it is now order …\" with their note",
    nt.summary === `Pat Example accepted quote ${A.number} — it is now order ${orderA}` && nt.orderId === orderA && nt.detail === "Their note: Looks good");
  r = await post({ token: A.token, action: "accept" });
  ok("accepting a second time: 409 naming the same order", r.status === 409 && r.body.message === `This quote has already been accepted — your order is ${orderA}.`);
  r = await post({ token: A.token, action: "changes", note: "One more thing" });
  ok("asking for changes once it is an order: the same 409", r.status === 409 && r.body.message === `This quote has already been accepted — your order is ${orderA}.`);
  ok("…and only one order was made", d1.q("SELECT count(*) n FROM orders WHERE orderId LIKE 'CLUB-%'")[0].n === 1);
  r = await get(A.token);
  ok("the link still shows the quote: converted, with its order", ok200(r) && r.body.estimate.status === "converted" && r.body.estimate.orderId === orderA &&
    r.body.estimate.canAccept === false && r.body.estimate.canAskChanges === false);

  console.log("=== POST accept: when the site can't send email, or the customer has no address ===");
  const B = await quote({ title: "No email here" });
  const noMailEnv = { DB: d1 };
  mail.length = 0;
  r = await post({ token: B.token, action: "accept" }, { env: noMailEnv });
  ok("with no email set up, the order is still made, and invoiceSent is false", ok200(r) && r.body.orderId === "CLUB-" + B.number.replace("-", "") && r.body.invoiceSent === false && mail.length === 0);
  ok("an accept with no note has no note in its audit row or the owner's notice",
    JSON.stringify(JSON.parse(lastAudit("estimate.accepted").detail)) === JSON.stringify({ estimate: B.number, orderId: r.body.orderId }) && lastNotice().detail === "");
  const C = await quote({ customerId: noMailCust, title: "Boosters", email: "boosters@example.com" });
  r = await post({ token: C.token, action: "accept" });
  ok("a customer with no email address on file: the order is made, no invoice (invoiceSent false)", ok200(r) && !!r.body.orderId && r.body.invoiceSent === false);
  ok("…and the owner's notice names the company when there's no name", lastNotice().summary.startsWith(`Example Boosters accepted quote ${C.number}`));
  ok("GET of it shows the company as the customer's name", (await get(C.token)).body.estimate.customerName === "Example Boosters");

  // ==============================================================================================================
  console.log("=== POST accept: the order can't be made — the acceptance stands ===");
  const E1 = await quote({ title: "Lines vanish" });
  d1._raw.exec(`DELETE FROM estimate_items WHERE estimateId = ${E1.id}`);
  const issuesBefore = issues().length;
  r = await quietly(() => post({ token: E1.token, action: "accept" }));
  ok("convertEstimateToOrder_ refusing (no lines): still 200, no order, no invoice", ok200(r) && r.body.orderId === "" && r.body.invoiceSent === false);
  ok("…the quote stays accepted, with no order", estRow(E1.id).status === "accepted" && !estRow(E1.id).orderId && r.body.estimate.status === "accepted" && r.body.estimate.orderId === "");
  let iss = issues().slice(issuesBefore);
  ok("…an api_error system problem is recorded, naming the quote and why", iss.length === 1 && iss[0].kind === "api_error" &&
    iss[0].sample === `estimate: quote ${E1.number} accepted, but its order couldn't be made — This quote has no lines to order.`);
  ok("…the owner is told to convert it on the Quotes page", lastNotice().summary === `Pat Example accepted quote ${E1.number}, but it couldn't be made into an order — open it on the Quotes page and convert it` &&
    lastNotice().orderId === E1.number);
  ok("…the audit row has no order", !lastAudit("estimate.accepted").orderId && JSON.parse(lastAudit("estimate.accepted").detail).orderId === undefined);
  r = await get(E1.token);
  ok("GET of an accepted quote with no order: accepted, no order, can't be answered", ok200(r) && r.body.estimate.status === "accepted" && r.body.estimate.orderId === "" && r.body.estimate.canAccept === false);
  r = await post({ token: E1.token, action: "accept" });
  ok("accepting it again: 409 \"This quote has already been accepted.\" (no order to name)", r.status === 409 && r.body.message === "This quote has already been accepted.");

  const E2 = await quote({ title: "Order fails" });
  globalThis.__convertSpy = async () => { throw new Error("database is locked (test)"); };
  const before2 = issues().length;
  r = await quietly(() => post({ token: E2.token, action: "accept" }));
  globalThis.__convertSpy = null;
  iss = issues().slice(before2);
  ok("convertEstimateToOrder_ throwing: still 200, no order, the quote accepted", ok200(r) && r.body.orderId === "" && estRow(E2.id).status === "accepted");
  ok("…an api_error system problem names the error", iss.length === 1 && iss[0].kind === "api_error" &&
    iss[0].sample === `estimate: quote ${E2.number} accepted, but its order couldn't be made — database is locked (test)`);
  ok("…and the failure is logged", logged.some(l => l.includes("Quote accepted, but making its order failed:") && l.includes(E2.number)));

  const E3 = await quote({ title: "Convert answers nothing" });
  globalThis.__convertSpy = async () => null;
  const before3 = issues().length;
  r = await quietly(() => post({ token: E3.token, action: "accept" }));
  globalThis.__convertSpy = null;
  ok("convertEstimateToOrder_ answering nothing: no order, and the problem says \"no order\"", ok200(r) && r.body.orderId === "" &&
    issues().slice(before3).some(i => i.sample === `estimate: quote ${E3.number} accepted, but its order couldn't be made — no order`));

  const E4 = await quote({ title: "What convert is given" });
  let seenArgs = null;
  globalThis.__convertSpy = (real, a) => { seenArgs = a; return real(...a); };
  r = await post({ token: E4.token, action: "accept" }, { ip: "203.0.113.44" });
  globalThis.__convertSpy = null;
  ok("accepting hands convertEstimateToOrder_ the quote as it is now, actor customer-quote, the customer's address, sendInvoice and the shop's origin",
    ok200(r) && !!seenArgs && seenArgs[1].id === E4.id && seenArgs[1].status === "accepted" && seenArgs[2].actor === "customer-quote" &&
    seenArgs[2].ip === "203.0.113.44" && seenArgs[2].sendInvoice === true && seenArgs[2].origin === "https://club.example.com");

  // ==============================================================================================================
  console.log("=== POST: the database has the last word (another tab answered a moment ago) ===");
  const R1 = await quote({ title: "Cancelled meanwhile" });
  const raceDb = Object.create(d1);
  raceDb.prepare = (sql) => {
    if (/^UPDATE estimates SET status = 'accepted'/.test(sql)) d1._raw.exec(`UPDATE estimates SET status = 'cancelled', cancelledAt = 't' WHERE id = ${R1.id}`);
    return d1.prepare(sql);
  };
  r = await post({ token: R1.token, action: "accept" }, { env: { ...env, DB: raceDb } });
  ok("a quote cancelled between the check and the save: 409 in the customer's words from the quote as it is now",
    r.status === 409 && r.body.message === "This quote was cancelled — contact us if you'd still like to go ahead." && estRow(R1.id).status === "cancelled" && !estRow(R1.id).orderId);
  const R2 = await quote({ title: "Database refuses" });
  d1._raw.exec(`UPDATE estimates SET sentAt = NULL WHERE id = ${R2.id}`);
  r = await post({ token: R2.token, action: "changes", note: "Hello" });
  ok("a refusal the page can't explain: 409 \"This quote can't be answered online right now — contact us.\"",
    r.status === 409 && r.body.message === "This quote can't be answered online right now — contact us." && estRow(R2.id).status === "sent");
  ok("…never the database's own text", !/hasn't been sent/.test(r.body.message));

  // ==============================================================================================================
  console.log("=== Cancelled quotes ===");
  const X = await quote({ title: "To be cancelled" });
  await admin({ action: "cancelEstimate", id: X.id });
  r = await get(X.token);
  ok("GET of a cancelled quote still shows it, cancelled, with no accept or changes", ok200(r) && r.body.estimate.status === "cancelled" && r.body.estimate.canAccept === false && r.body.estimate.canAskChanges === false);
  const cancelled = "This quote was cancelled — contact us if you'd still like to go ahead.";
  r = await post({ token: X.token, action: "accept" });
  ok("accepting it: 409 \"This quote was cancelled — contact us …\"", r.status === 409 && r.body.message === cancelled);
  r = await post({ token: X.token, action: "changes", note: "Please?" });
  ok("asking for changes: the same 409", r.status === 409 && r.body.message === cancelled && estRow(X.id).status === "cancelled");

  // ==============================================================================================================
  console.log("=== Expired quotes (the business's own calendar day after the last day) ===");
  const today = await M.localToday(env);
  const Y = await quote({ title: "Last day today", expiresOn: today });
  r = await get(Y.token);
  ok("on its last day (the business's today) it isn't expired and can be accepted", ok200(r) && r.body.estimate.expired === false && r.body.estimate.canAccept === true && r.body.estimate.expiresOn === today);
  d1._raw.exec(`UPDATE estimates SET expiresOn = '${dayAfter(today, -1)}' WHERE id = ${Y.id}`);
  r = await get(Y.token);
  ok("the day after its last day it is expired: shown, with no accept and no changes", ok200(r) && r.body.estimate.expired === true && r.body.estimate.canAccept === false && r.body.estimate.canAskChanges === false);
  d1._raw.exec(`UPDATE estimates SET expiresOn = '2000-01-01' WHERE id = ${Y.id}`);
  const expiredMsg = "This quote expired on Saturday, January 1, 2000 — contact us for a new one.";
  r = await post({ token: Y.token, action: "accept" });
  ok("accepting an expired quote: 410, naming the last day as a long date", r.status === 410 && r.body.message === expiredMsg);
  r = await post({ token: Y.token, action: "changes", note: "Still want it" });
  ok("asking for changes to an expired quote: the same 410", r.status === 410 && r.body.message === expiredMsg && estRow(Y.id).status === "sent");
  d1._raw.exec(`UPDATE estimates SET status = 'changes', customerNote = 'old' WHERE id = ${Y.id}`);
  r = await post({ token: Y.token, action: "changes", note: "Again" });
  ok("expired while waiting on changes: 410 too", r.status === 410 && r.body.message === expiredMsg);
  d1._raw.exec(`UPDATE estimates SET status = 'cancelled' WHERE id = ${Y.id}`);
  r = await post({ token: Y.token, action: "accept" });
  ok("expired and cancelled: 409 cancelled (cancelled is said first)", r.status === 409 && r.body.message === cancelled);
  d1._raw.exec(`UPDATE estimates SET status = 'accepted' WHERE id = ${Y.id}`);
  r = await post({ token: Y.token, action: "accept" });
  ok("expired and already accepted: 409 already accepted", r.status === 409 && r.body.message === "This quote has already been accepted.");
  // The day is the business's, not the server's: a far-west zone and a far-east one are on different days.
  const Z = await quote({ title: "Time zones" });
  await M.setLocaleSettings(d1, { timeZone: "Pacific/Pago_Pago" });
  const westDay = await M.localToday(env);
  d1._raw.exec(`UPDATE estimates SET expiresOn = '${westDay}' WHERE id = ${Z.id}`);
  ok("in a shop at UTC−11 whose day it still is, the quote can be accepted", (await get(Z.token)).body.estimate.canAccept === true);
  await M.setLocaleSettings(d1, { timeZone: "Pacific/Kiritimati" });
  r = await get(Z.token);
  ok("the same quote in a shop at UTC+14, already on the next day, is expired", r.body.estimate.expired === true && r.body.estimate.canAccept === false);
  r = await post({ token: Z.token, action: "accept" });
  ok("…and accepting it there is 410", r.status === 410);
  await M.setLocaleSettings(d1, { timeZone: "America/Chicago" });

  // ==============================================================================================================
  console.log("=== Rate limits (bucket 'estimate', per address, per minute) ===");
  // Kept inside one minute's window: wait out the end of one that is nearly over.
  while (Math.floor(Date.now() / 1000) % 60 > 45) await pause(500);
  const gip = "192.0.2.10";
  let statuses = [];
  for (let i = 0; i < 61; i++) statuses.push((await get(A.token, { ip: gip })).status);
  ok("60 GETs a minute from one address are answered", statuses.slice(0, 60).every(s => s === 200));
  const blocked = await get(A.token, { ip: gip });
  ok("the 61st and later get 429 \"Too many requests — try again shortly.\" with Retry-After",
    statuses[60] === 429 && blocked.status === 429 && blocked.body.message === "Too many requests — try again shortly." && Number(blocked.headers.get("Retry-After")) > 0);
  ok("another address is still answered", (await get(A.token, { ip: "192.0.2.11" })).status === 200);
  const pip = "192.0.2.20";
  statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await post({ token: A.token, action: "decline" }, { ip: pip })).status);
  ok("30 POSTs a minute from one address are answered (here: 400 unknown action)", statuses.slice(0, 30).every(s => s === 400));
  ok("the 31st POST gets 429", statuses[30] === 429);
  await M.setFeatures(d1, { quotes: false });
  ok("the limit is counted before the feature switch is read (a blocked address gets 429 even with Quotes off)", (await get(A.token, { ip: gip })).status === 429);
  await M.setFeatures(d1, { quotes: true });

  // ==============================================================================================================
  console.log("=== estimateLinesView (the lines both the email and the page read) ===");
  {
    const view = M.estimateLinesView([
      null,
      { kind: "product", name: "Polo", size: "M", qty: 3, unitPrice: 20, listUnitPrice: 24, lineTotal: 60, taxable: true, personalized: true, persName: "Sam", config: null },
      { kind: "product", name: "Cap", size: "OSFA", qty: 0, unitPrice: 15, listUnit: 18, lineTotal: 15, taxable: 0, customPrice: true },
      { kind: "product", name: "Hat", qty: 2, unitPrice: 10, listUnit: 12, lineTotal: 20 },
      { kind: "product", name: "Tee", qty: 1, unitPrice: 10, listUnitPrice: 10, lineTotal: 10 },
      { kind: "custom", name: "Banner", qty: 1, unitPrice: 40, listUnitPrice: 50, lineTotal: 40, taxable: false },
      { kind: "product", name: "Bag", qty: 1, unitPrice: 5, lineTotal: 5, configJson: "{not json" },
      { kind: "fee", feeKind: "art", name: "ART FEE", unitPrice: 12 },
      { kind: "fee", feeKind: "mystery", name: "Rush", lineTotal: 9, taxable: false },
      { kind: "fee", name: "" , lineTotal: 3 },
    ]);
    const [p, c, h, t, b, bag] = view.lines;
    ok("an empty entry is skipped; product and custom lines go to lines, fees to fees", view.lines.length === 6 && view.fees.length === 3);
    ok("a personalized line's detail has the name in quotes", p.detail === "“Sam”" && p.wasPrice === 24);
    ok("a typed price has no \"was\" price, a one-size size is blank, a quantity under 1 reads 1, taxable 0 is untaxed",
      c.wasPrice === null && c.size === "" && c.qty === 1 && c.taxable === false);
    ok("the list price may come as listUnit; a line with no taxable setting is taxed", h.wasPrice === 12 && h.taxable === true && h.size === "");
    ok("no \"was\" price when the list price isn't above the price", t.wasPrice === null);
    ok("a custom line never has a \"was\" price", b.kind === "custom" && b.wasPrice === null && b.taxable === false);
    ok("unreadable configJson gives no detail rather than an error", bag.detail === "");
    ok("a fee named as its own kind reads just the kind; the amount falls back to unitPrice", view.fees[0].name === "Art fee" && view.fees[0].amount === 12 && view.fees[0].feeKind === "art");
    ok("an unknown fee kind reads \"Fee — <description>\"", view.fees[1].name === "Fee — Rush" && view.fees[1].taxable === false && view.fees[1].feeKind === "mystery");
    ok("a fee with no kind is kind other, named \"Fee\"", view.fees[2].feeKind === "other" && view.fees[2].name === "Fee" && view.fees[2].amount === 3);
    const cfgJson = JSON.stringify({ garmentColor: "Navy", locations: [{ location: "lc", label: "Left chest", graphicName: "Crest", ink: "White" }, { location: "back", graphicName: "Auto", auto: true }] });
    const cfg = M.estimateLinesView([{ kind: "product", name: "Jacket", qty: 1, unitPrice: 50, lineTotal: 50, configJson: cfgJson, personalized: true, persName: "Sam" },
      { kind: "product", name: "Vest", qty: 1, unitPrice: 50, lineTotal: 50, config: JSON.parse(cfgJson), configJson: "{not json" }]);
    ok("configJson as stored is read for the detail, the same picks as a receipt's, then the personalization",
      cfg.lines[0].detail === "Navy · Left chest: Crest (White) · “Sam”");
    ok("config already read wins over configJson", cfg.lines[1].detail === "Navy · Left chest: Crest (White)");
    ok("no items at all: no lines and no fees", JSON.stringify(M.estimateLinesView(undefined)) === JSON.stringify({ lines: [], fees: [] }));
  }

  console.log("=== buildEstimateEmail: its other shapes ===");
  {
    const base = { estimate: { number: "Q-00077", title: "", message: "", sentTo: "sam@example.com", expiresOn: "" },
      items: [{ kind: "product", name: "Polo", qty: 2, unitPrice: 20, lineTotal: 40, taxable: true }, { kind: "fee", feeKind: "setup", name: "", lineTotal: 10, taxable: false }],
      totals: { subtotal: 50, tax: 2.4, total: 50, taxMode: "inclusive", taxRateBps: 600 } };
    let m = M.buildEstimateEmail(base);
    ok("with no link the customer is told to reply, and there is no button or link", m.html.includes("To accept it, or to ask for changes, reply to this email.") &&
      !m.html.includes("<a href") && !m.text.includes("View and accept"));
    ok("with no name it says \"Hello,\"", m.html.includes("<p>Hello, Here is your quote.") && m.text.includes("Hello, Here is your quote."));
    ok("it goes to the address the quote was sent to", m.to === "sam@example.com");
    ok("with no shop name the subject is \"Quote <number> · <total>\"", m.subject === "Quote Q-00077 · $50.00");
    ok("with no expiry there's no \"good through\" line", !m.html.includes("good through") && !m.text.includes("good through"));
    ok("tax included in the prices is noted under the Total, not added as its own line",
      plain(m.html).includes("Subtotal $50.00 Total $50.00 Includes sales tax (6%) $2.40") && m.text.includes("Total: $50.00\nIncludes sales tax (6%): $2.40") && !m.text.includes("\nSales tax"));
    ok("an untaxed fee says (not taxed) when the quote has tax", m.html.includes("Setup fee <span") && m.text.includes("  Setup fee (not taxed)  $10.00"));
    m = M.buildEstimateEmail({ ...base, totals: { subtotal: 50, tax: 0, total: 50, taxMode: "exclusive", taxRateBps: 0 } });
    ok("with no tax there's no tax row and no (not taxed) mark", !/sales tax/i.test(m.html) && !m.html.includes("(not taxed)") && !m.text.includes("(not taxed)"));
    m = M.buildEstimateEmail({ ...base, to: "other@example.com", customerName: "Robin Example", orgName: "Example <Club>",
      link: "https://club.example.com/?estimate=abc\"def", message: "Cover note", estimate: { ...base.estimate, title: "T & <i>", message: "Own note" } });
    ok("an address given wins over the one the quote was sent to", m.to === "other@example.com");
    ok("the customer's name given is used", m.text.includes("Hi Robin Example,"));
    ok("the shop's name, the title and the link are escaped in the HTML", m.html.includes("Quote — Example &lt;Club&gt;") && m.html.includes("T &amp; &lt;i&gt;") &&
      m.html.includes('href="https://club.example.com/?estimate=abc&quot;def"') && !m.html.includes("<Club>"));
    ok("the note from the Send window comes first, then the quote's own note when it says something else",
      m.html.indexOf("Cover note") > 0 && m.html.indexOf("Own note") > m.html.indexOf("Cover note") && m.text.includes("Cover note\n\nOwn note"));
    ok("the text part's first line names the number and title", m.text.startsWith("Quote Q-00077 — T & <i>\n"));
    m = M.buildEstimateEmail({ ...base, message: "Same note", estimate: { ...base.estimate, message: "Same note", customerName: "Lee Example" } });
    ok("the same note twice is said once; the quote's customerName is used", m.html.split("Same note").length === 2 && m.text.includes("Hi Lee Example,"));
    m = M.buildEstimateEmail({ ...base, estimate: { ...base.estimate, message: "Only own" } });
    ok("with no Send-window note, the quote's own note is shown", m.html.includes("Only own"));
    m = M.buildEstimateEmail({});
    ok("built from nothing it still makes an email with no address", m.to === "" && m.subject === "Quote  · $0.00" && m.html.includes("Hello,"));
    mail.length = 0;
    const sentOk = await M.sendEstimateEmail(env, { ...base, link: "https://club.example.com/?estimate=0123456789abcdef", orgName: "Example Club" });
    ok("sendEstimateEmail sends it (true) to the address, with the shop's footer filled in", sentOk === true && mail.length === 1 && mail[0].to === "sam@example.com" &&
      !mail[0].htmlBody.includes("%%FOOTER") && !mail[0].body.includes("%%FOOTER"));
    ok("sendEstimateEmail with no address sends nothing (false)", (await M.sendEstimateEmail(env, { ...base, estimate: { number: "Q-1" } })) === false && mail.length === 1);
    ok("sendEstimateEmail with no arguments sends nothing (false)", (await M.sendEstimateEmail(env)) === false);
  }

  console.log("=== sendEstimateResponseNotification (the owner hears of an answer) ===");
  {
    const n0 = notices().length;
    await M.sendEstimateResponseNotification(env, { estimate: { number: "Q-00090", orgId: "club" }, accepted: true, orderId: "CLUB-Q00090", note: "" });
    let n = lastNotice();
    ok("an accept with an order, no name: \"The customer accepted quote … — it is now order …\", no detail, filed under the order",
      notices().length === n0 + 1 && n.summary === "The customer accepted quote Q-00090 — it is now order CLUB-Q00090" && n.detail === "" && n.orderId === "CLUB-Q00090" && n.kind === "quote");
    await M.sendEstimateResponseNotification(env, { estimate: { number: "Q-00091", orgId: "club", customerName: "Lee Example" }, accepted: false, note: "  Blue  " });
    n = lastNotice();
    ok("a changes request uses the quote's customerName and the trimmed note, filed under the quote's number",
      n.summary === "Lee Example asked for changes to quote Q-00091" && n.detail === "Their note: Blue" && n.orderId === "Q-00091");
    await M.sendEstimateResponseNotification(env, {});
    ok("called with nothing it still files a notice", lastNotice().summary === "The customer asked for changes to quote " && notices().length === n0 + 3);
    // No database to queue it in: the owner is emailed at once instead.
    mail.length = 0;
    const fallbackEnv = { ...MAIL_ENV, OWNER_EMAIL: "owner@example.com" };
    await M.sendEstimateResponseNotification(fallbackEnv, { estimate: { number: "Q-00092", orgId: "club" }, accepted: true, orderId: "CLUB-Q00092", customerName: "Pat <Example>", note: "Line one\n<b>two</b>" });
    let m = mail[0];
    ok("with no queue the owner is emailed: subject \"Quote accepted — <shop> — <number>\"", mail.length === 1 && m.to === "owner@example.com" && m.subject === "Quote accepted — club — Q-00092");
    ok("…its HTML escapes the name and the note, with the note's line breaks kept",
      !!m && m.htmlBody.includes("Pat &lt;Example&gt; accepted quote Q-00092 — it is now order CLUB-Q00092") && m.htmlBody.includes("<strong>Their note:</strong> Line one<br>&lt;b&gt;two&lt;/b&gt;"));
    ok("…its text names the order", !!m && m.body.includes("Order: CLUB-Q00092 (club)\nTheir note: Line one\n<b>two</b>"));
    mail.length = 0;
    await M.sendEstimateResponseNotification(fallbackEnv, { estimate: { number: "Q-00093", orgId: "club" }, accepted: true, orderId: "" });
    m = mail[0];
    ok("an accept with no order: subject \"Quote accepted …\", the text names the quote, and no note paragraph",
      !!m && m.subject === "Quote accepted — club — Q-00093" && m.body.includes("Quote: Q-00093 (club)") && !m.htmlBody.includes("Their note") && m.body.includes("couldn't be made into an order"));
    mail.length = 0;
    await M.sendEstimateResponseNotification(fallbackEnv, { estimate: { number: "Q-00094" }, accepted: false, note: "x" });
    ok("a changes request emailed: subject \"Quote changes asked for — <shop> — <number>\" (no shop: blank)", mail[0] && mail[0].subject === "Quote changes asked for —  — Q-00094" && mail[0].body.includes("Quote: Q-00094 ()"));
  }

  console.log("=== The answer is saved even if recording it fails ===");
  {
    const W = await quote({ title: "Audit fails" });
    const failDb = Object.create(d1);
    failDb.prepare = (sql) => { if (/INSERT INTO audit_log/i.test(sql)) throw new Error("audit table busy (test)"); return d1.prepare(sql); };
    logged.length = 0;
    r = await quietly(() => post({ token: W.token, action: "changes", note: "Hi there" }, { env: { ...env, DB: failDb } }));
    ok("the customer's answer is still ok and saved", ok200(r) && estRow(W.id).status === "changes");
    ok("…and the failure to record it is logged", logged.some(l => l.includes("Quote answer saved, but recording it failed:") && l.includes(W.number)));
  }
})().catch((e) => { console.error(e); process.exit(1); });
