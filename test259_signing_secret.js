const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { makeAuth, answer, read, strip } = require("./testlib/auth-harness");

// The signing secret (review #83). Links, checkout tokens, draft previews and shipping quotes are signed with
// SIGNING_SECRET. The Stripe key is no longer a fallback for it (one secret mustn't double as another). A site
// installed with the Deploy button has none at first: the Worker makes one and keeps it in the database
// (src/worker.js withSigningSecret, db.js ensureSigningSecret), marking the env SIGNING_SECRET_FROM_DB. Setup status
// warns while that copy is in use; the domain step (cloudflareSetup.js) saves the same value as the Worker's
// SIGNING_SECRET, so links already sent keep working; and once the Worker has it, the database copy is deleted.
// An install with neither is told to run `npm run setup`. Real SQL (sql.js); Cloudflare's API is a stand-in.
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const stored = (d1) => d1.q("SELECT value FROM global_settings WHERE key = 'signingSecret'").map(r => r.value);

(async () => {
  console.log("=== Not the Stripe key ===");
  const H = new Function(strip(read("functions/_lib/http.js")) + "\nreturn { signOrderToken };")();
  const Q = new Function(strip(read("functions/_lib/quoteToken.js")) + "\nreturn { canSignQuotes, signQuote };")();
  const D = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { signPreviewToken };")();
  const stripeOnly = { STRIPE_SECRET_KEY: "sk_test_only_this" };
  ok("with only the Stripe key, nothing is signed: checkout tokens, shipping quotes, draft previews", (await H.signOrderToken(stripeOnly, "ord-1")) === null && !Q.canSignQuotes(stripeOnly) &&
    (await Q.signQuote(stripeOnly, { orgId: "o", zip: "1", items: "[]", amountCents: 1, method: "x" })) === null && (await D.signPreviewToken(stripeOnly, "o")) === null);
  ok("…with SIGNING_SECRET they are", /^\d+\.[0-9a-f]{64}$/.test(await H.signOrderToken({ SIGNING_SECRET: "s" }, "ord-1")) && Q.canSignQuotes({ SIGNING_SECRET: "s" }) && !!(await D.signPreviewToken({ SIGNING_SECRET: "s" }, "o")));
  const src = ["functions/_lib/http.js", "functions/_lib/db.js", "functions/_lib/quoteToken.js", "functions/api/design.js", "functions/api/receipt.js"].map(read).join("\n");
  ok("no signing code falls back to STRIPE_SECRET_KEY", !/SIGNING_SECRET[^\n]*\|\|\s*env\.STRIPE_SECRET_KEY/.test(src));

  console.log("\n=== The copy kept in the database ===");
  const d1 = await createD1(); d1._raw.exec(read("schema.sql"));
  const w1 = await import("./src/worker.js?made");
  const made = await w1.withSigningSecret({ DB: d1 });
  ok("with none set, the Worker makes one, keeps it in the database and says that is where it came from", /^[0-9a-f]{64}$/.test(made.SIGNING_SECRET) && made.SIGNING_SECRET_FROM_DB === true && stored(d1).join() === made.SIGNING_SECRET);
  const S = new Function(strip(read("functions/_lib/setupStatus.js")) + "\nreturn { setupStatus };")();
  const items = S.setupStatus(made, {}), warn = items.find(i => i.key === "signingSecretStored");
  ok("Setup status: links work, with a warning saying how to move it to the Worker", items.find(i => i.key === "signingSecret").ready && warn && !warn.ready && warn.level === "recommended" &&
    /Your domain/.test(warn.note) && !JSON.stringify(items).includes(made.SIGNING_SECRET));
  const none = S.setupStatus({ DB: d1 }, {}).find(i => i.key === "signingSecret");
  ok("an install with neither a Worker secret nor a stored copy is told to run npm run setup", !none.ready && /npm run setup/.test(none.note));

  // A later version of the Worker that has the secret: a fresh isolate (module) each time.
  let calls = 0;
  const counted = { prepare: (sql) => { calls++; return d1.prepare(sql); } };
  const w2 = await import("./src/worker.js?other");
  const other = { DB: counted, SIGNING_SECRET: "a different secret" };
  ok("a Worker secret that differs from the stored copy leaves the copy alone, and the env untouched", (await w2.withSigningSecret(other)) === other && stored(d1).length === 1 && !("SIGNING_SECRET_FROM_DB" in other));
  const w3 = await import("./src/worker.js?same");
  const same = { DB: counted, SIGNING_SECRET: made.SIGNING_SECRET };
  calls = 0;
  ok("once the Worker has the same value as its own secret, the database copy is deleted", (await w3.withSigningSecret(same)) === same && stored(d1).length === 0 && calls === 1);
  ok("…tried once per isolate, not on every request", (await w3.withSigningSecret(same)) === same && calls === 1);
  ok("…and it is no longer flagged, so Setup status has no warning", !S.setupStatus(same, {}).some(i => i.key === "signingSecretStored"));
  const d2 = await createD1(); d2._raw.exec(read("schema.sql"));
  const lib = await import("./functions/_lib/db.js");
  await lib.ensureSigningSecret(d2);
  ok("only a copy equal to the Worker's secret is ever deleted", (await lib.dropStoredSigningSecret(d2, "not it")) === false && (await lib.dropStoredSigningSecret(d2, "")) === false && stored(d2).length === 1 &&
    (await lib.dropStoredSigningSecret(d2, stored(d2)[0])) === true && stored(d2).length === 0);

  console.log("\n=== The domain step saves it on the Worker ===");
  const KEY = "Abc_def-1234567890ghijklmnopqrstuv";
  const cf = { secrets: [], domains: [] };
  const reply = (status, result) => ({ ok: status < 400, status, json: async () => ({ success: status < 400, result, errors: [] }) });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname.replace(/^\/client\/v4/, ""), method = init.method || "GET", body = init.body ? JSON.parse(init.body) : null;
    if (p === "/user/tokens/verify") return reply(200, { status: "active" });
    if (p === "/zones") return reply(200, [{ id: "zone-1", name: "myshop.com", status: "active", account: { id: "acct-1" } }]);
    if (/\/workers\/subdomain$/.test(p)) return reply(200, { subdomain: "someone" });
    if (/\/settings$/.test(p)) return reply(200, { bindings: [] });
    if (/\/secrets$/.test(p) && method === "PUT") { cf.secrets.push(body); return reply(200, { name: body.name }); }
    if (/\/workers\/domains$/.test(p) && method === "GET") return reply(200, []);
    if (/\/workers\/domains$/.test(p) && method === "PUT") { cf.domains.push(body); return reply(200, body); }
    if (/\/workers\/routes$/.test(p) || /\/dns_records$/.test(p)) return reply(200, []);
    return reply(404, null);
  };
  const C = await import("./functions/_lib/cloudflareSetup.js");
  const r1 = await C.connectCloudflare({ token: KEY, domain: "", hostname: "opendecodesk.someone.workers.dev", signingSecret: made.SIGNING_SECRET });
  ok("given the stored secret, it is saved first, as SIGNING_SECRET, with the same value (sent links keep working); ROOT_DOMAIN still last",
    r1.status === "connected" && cf.secrets.map(s => s.name).join() === "SIGNING_SECRET,CF_API_TOKEN,CF_ACCOUNT_ID,CF_ZONE_ID,CF_WORKER_NAME,ROOT_DOMAIN" && cf.secrets[0].text === made.SIGNING_SECRET &&
    cf.secrets[0].type === "secret_text" && !JSON.stringify({ ...r1, cfg: undefined }).includes(made.SIGNING_SECRET));
  cf.secrets = [];
  await C.connectCloudflare({ token: KEY, domain: "", hostname: "opendecodesk.someone.workers.dev" });
  ok("…without one, the step writes only its own settings, as before", cf.secrets.map(s => s.name).join() === "CF_API_TOKEN,CF_ACCOUNT_ID,CF_ZONE_ID,CF_WORKER_NAME,ROOT_DOMAIN");

  // Through the admin: only a secret the Worker says came from the database is handed over.
  const W = "https://opendecodesk.someone.workers.dev";
  const B = await makeAuth({ passphrase: "a long setup password", realDomains: true });
  delete B.env.ROOT_DOMAIN;
  const req = (url, body, cookie) => { const h = { origin: new URL(url).origin, cookie: cookie ? "__Host-odd_admin=" + cookie : "", "cf-connecting-ip": "203.0.113.9" };
    return { url, method: "POST", json: async () => body, headers: { get: (n) => h[String(n).toLowerCase()] || null } }; };
  const at = async (path, body, cookie) => answer(await B.raw[path].POST({ request: req(W + path, body, cookie), env: B.env, waitUntil: () => {} }));
  const first = await at("/api/admin-session", { email: "", key: "a long setup password" });
  await B.password({ action: "account", name: "Olive Owner", email: "olive@example.test", next: "correct horse battery" }, first.cookie);
  const owner = (await at("/api/admin-session", { email: "olive@example.test", key: "correct horse battery" })).cookie;
  B.env.SIGNING_SECRET = "the site's own secret";
  cf.secrets = [];
  let done = await at("/api/orders", { action: "connectCloudflare", token: KEY }, owner);
  ok("a site whose SIGNING_SECRET is already a Worker secret doesn't have it written again", done.status === 200 && !cf.secrets.some(s => s.name === "SIGNING_SECRET"));
  B.env.SIGNING_SECRET = made.SIGNING_SECRET; B.env.SIGNING_SECRET_FROM_DB = true;
  cf.secrets = [];
  done = await at("/api/orders", { action: "connectCloudflare", token: KEY }, owner);
  ok("a site signing with the database copy has it saved on the Worker, and the key and secret appear in no answer or log",
    done.status === 200 && cf.secrets[0].name === "SIGNING_SECRET" && cf.secrets[0].text === made.SIGNING_SECRET &&
    !JSON.stringify(done.body).includes(made.SIGNING_SECRET) && !JSON.stringify(B.d1.q("SELECT * FROM audit_log")).includes(made.SIGNING_SECRET));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); console.log("test259 crashed: false"); process.exit(1); });
