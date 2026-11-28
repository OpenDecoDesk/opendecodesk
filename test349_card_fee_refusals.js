const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// The daily card-fee back-fill (functions/_lib/stripeFees.js) used to read every Stripe answer the same way: no key,
// a refused key (401), a restricted key (403), an error body or a network failure all came back as "no fee yet", so
// with a revoked or restricted key every card payment quietly kept a $0 fee and the roll-up showed no problem. Now:
//   * readStripeFee tells a fee, "not there yet" (no balance transaction, Stripe busy or unreachable) and "Stripe
//     refused" (an error answer) apart;
//   * fillMissingCardFees returns the refusals as `errors`, and stops at the first 401/403 instead of making the same
//     failing call for every payment;
//   * the housekeeping (src/worker.js runHousekeeping_) records them as ONE "Card fees couldn't be read from Stripe"
//     problem for the roll-up, on the day's first try (a retry an hour later doesn't add another), and a crash too.
// The real stripeFees.js, db.js and src/worker.js on sql.js with the real schema; Stripe is a mocked fetch.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const quiet = async (fn) => { const e = console.error, l = console.log; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.error = e; console.log = l; } };

(async () => {
  const lib = await import("./functions/_lib/stripeFees.js");
  const db = await import("./functions/_lib/db.js");
  const w = await import("./src/worker.js");

  // Stripe: `mode` picks the answer for every call; `answers` overrides it per PaymentIntent.
  let mode = "fee", answers = {};
  const calls = [];
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const stripeAnswer = (id) => {
    const m = answers[id] || mode;
    if (m === "fee") return reply(200, { id, latest_charge: { balance_transaction: { fee: 59 } } });
    if (m === "notyet") return reply(200, { id, latest_charge: { balance_transaction: null } });
    if (m === "401") return reply(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided: sk_live_****abcd" } });
    if (m === "403") return reply(403, { error: { type: "invalid_request_error", message: "The provided key 'rk_live_****wxyz' does not have the required permissions" } });
    if (m === "404") return reply(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such payment_intent: '" + id + "'" } });
    if (m === "429") return reply(429, { error: { type: "rate_limit_error", message: "Too many requests" } });
    if (m === "500") return reply(500, { error: { type: "api_error", message: "Something went wrong on Stripe's end" } });
    if (m === "network") throw new Error("network down");
    throw new Error("unknown mode " + m);
  };
  global.fetch = async (url) => {
    const m = String(url).match(/^https:\/\/api\.stripe\.com\/v1\/payment_intents\/([^?]+)/);
    if (m) { calls.push(m[1]); return stripeAnswer(decodeURIComponent(m[1])); }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };

  const site = async (payments = 5) => {
    const d1 = await createD1();
    d1._raw.exec(read("schema.sql"));
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('shop','shop','Example Shop','t','t');`);
    const now = new Date().toISOString();
    for (let i = 1; i <= payments; i++) {
      d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, subtotalCents, totalCents, placedAt) VALUES ('O${i}','shop','Pat','pat@example.test',1000,1000,'${now}')`);
      d1._raw.exec(`INSERT INTO order_payments (orderId, amountCents, method, kind, feeCents, externalRef, note, receivedAt) VALUES ('O${i}', 1000, 'card', 'payment', 0, 'pi_${i}', 'Stripe', '${now}')`);
    }
    return { d1, env: { DB: d1, STRIPE_SECRET_KEY: "sk_test_example", SIGNING_SECRET: "s" } };
  };
  const fees = (d1) => d1.q("SELECT feeCents f FROM order_payments ORDER BY id").map(r => r.f);
  const issues = (d1) => d1.q("SELECT kind, sample FROM system_issues WHERE kind = 'card_fees_failed'");

  console.log("=== Reading one fee: a fee, not there yet, or refused ===");
  {
    const env = { STRIPE_SECRET_KEY: "sk_test_example" };
    const r = async (m) => { mode = m; return quiet(() => lib.readStripeFee(env, "pi_x")); };
    ok("a fee", (await r("fee")).fee === 59);
    ok("no balance transaction yet: not there yet (tried again later)", (await r("notyet")).pending === true);
    ok("a network failure: not there yet, never a refusal", (await r("network")).pending === true);
    ok("Stripe busy (429) or down (500): not there yet", (await r("429")).pending === true && (await r("500")).pending === true);
    const k401 = await r("401"), k403 = await r("403"), k404 = await r("404");
    ok("a refused key (401): refused, saying to check the key", k401.refused === true && k401.status === 401 && /check STRIPE_SECRET_KEY/.test(k401.message));
    ok("a restricted key without read access (403): refused, saying what access it needs", k403.refused === true && k403.status === 403 && /restricted key needs read access/.test(k403.message));
    ok("a payment this Stripe account doesn't have (404): refused, with Stripe's reason", k404.refused === true && /resource_missing/.test(k404.message));
    ok("never a key, even a masked one, in the message", ![k401, k403, k404].some(x => /sk_|rk_/.test(x.message)));
    mode = "fee";
    ok("no key, or not a PaymentIntent: not there yet, and Stripe isn't asked",
      (await lib.readStripeFee({}, "pi_x")).pending === true && (await lib.readStripeFee(env, "cs_x")).pending === true);
    mode = "401";
    ok("readStripeFeeCents (the old shape) still answers null for a refusal", (await quiet(() => lib.readStripeFeeCents(env, "pi_x"))) === null);
  }

  console.log("\n=== The back-fill ===");
  {
    const { d1, env } = await site(5);
    mode = "401"; calls.length = 0;
    const r = await quiet(() => lib.fillMissingCardFees(env));
    ok("a refused key: one call, then it stops (not one failing call per payment)", calls.length === 1 && r.checked === 1 && r.filled === 0);
    ok("…and the refusal comes back in errors", Array.isArray(r.errors) && r.errors.length === 1 && /401/.test(r.errors[0]));
    mode = "403"; calls.length = 0;
    const r3 = await quiet(() => lib.fillMissingCardFees(env));
    ok("a restricted key (403) stops the same way", calls.length === 1 && r3.errors.length === 1 && /403/.test(r3.errors[0]));
    mode = "fee"; answers = { pi_5: "404", pi_4: "notyet" }; calls.length = 0;
    const r4 = await quiet(() => lib.fillMissingCardFees(env));
    ok("one payment Stripe doesn't have: reported, and the others still filled", calls.length === 5 && r4.errors.length === 1 && /pi_5/.test(r4.errors[0]) && r4.filled === 3);
    ok("…one not there yet stays at 0 with no error", JSON.stringify(fees(d1)) === "[59,59,59,0,0]");
    answers = {}; mode = "network"; calls.length = 0;
    const r5 = await quiet(() => lib.fillMissingCardFees(env));
    ok("a network failure: no error (tried again on a later run)", r5.errors.length === 0 && r5.filled === 0);
    mode = "fee";
    ok("nothing to do: an empty errors list", JSON.stringify((await lib.fillMissingCardFees({ DB: d1 })).errors) === "[]");
  }

  console.log("\n=== The housekeeping reports it, once ===");
  {
    const { d1, env } = await site(5);
    const tick = (hhmm) => quiet(() => w.handleScheduled({ scheduledTime: Date.parse(`2026-07-15T${hhmm}:00Z`) }, env));
    const record = () => { const r = d1.q("SELECT value FROM global_settings WHERE key = 'housekeepingScheduled'"); return r.length ? JSON.parse(r[0].value) : null; };
    mode = "401"; calls.length = 0;
    const h5 = await tick("05:00");
    ok("05:00 (the housekeeping): the refusal is in its result", h5.ran && h5.housekeeping && h5.housekeeping.cardFees.errors.length === 1);
    ok("…recorded as ONE problem for the roll-up, however many payments it stopped", issues(d1).length === 1 && /check STRIPE_SECRET_KEY/.test(issues(d1)[0].sample) && calls.length === 1);
    ok("…and the try counts as failed (tried again later)", record().ok === false && record().attempts === 1);
    const list = await db.getSystemIssues(d1);
    ok("the roll-up's label says what it is", list.length === 1 && list[0].label === db.SYSTEM_ISSUE_LABELS.card_fees_failed && /^Card fees couldn't be read from Stripe/.test(list[0].label));
    await tick("06:00");   // the roll-up's tick (no email set up here: nothing is sent or cleared)
    await tick("07:00");
    ok("the retry at 07:00 meets the same refusal but adds no second problem (one a day)", record().attempts === 2 && issues(d1).length === 1);
    mode = "fee";
    const next = await quiet(() => w.handleScheduled({ scheduledTime: Date.parse("2026-07-16T05:00:00Z") }, env));
    ok("the next day, with the key fixed: the fees are filled, nothing new recorded", next.housekeeping.cardFees.filled === 5 && issues(d1).length === 1 && record().ok === true);
  }
  {
    const { d1, env } = await site(2);
    // A database error while finding the payments: the job crashes, and that is recorded too (it used to be the only
    // housekeeping job that wasn't).
    const DB = new Proxy(d1, { get(t, k) {
      if (k === "prepare") return (sql) => { if (/FROM order_payments/.test(sql) && /feeCents = 0/.test(sql)) throw new Error("the database refused it"); return t.prepare(sql); };
      const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
    } });
    const h = await quiet(() => w.handleScheduled({ scheduledTime: Date.parse("2026-07-15T05:00:00Z") }, { ...env, DB }));
    ok("a crash in the card-fee job is recorded as a problem as well", h.housekeeping.cardFees.error && issues(d1).length === 1 && /the database refused it/.test(issues(d1)[0].sample));
  }

  console.log("\n=== Wiring ===");
  {
    const src = read("src/worker.js");
    const hk = src.slice(src.indexOf("async function runHousekeeping_("), src.indexOf("export async function handleScheduled("));
    ok("the housekeeping is told whether this is the day's first try", /runHousekeeping_\(env, \{ firstTry: attempt\.attempts === 1 \}\)/.test(src));
    ok("…and records card_fees_failed for refusals and for a crash", (hk.match(/recordSystemIssue\(env\.DB, "card_fees_failed"/g) || []).length === 2);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log("test349 crashed: false"); process.exit(1); });
