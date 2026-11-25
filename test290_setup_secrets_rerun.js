const fs = require("fs");
const os = require("os");
const path = require("path");
const { createD1 } = require("./testlib/d1-shim.js");

// Running `npm run setup` again must never replace the password pepper, the signing secret or the
// admin passphrase by accident. The installer makes a new secret for every name `wrangler secret
// list` doesn't show — so a listing that FAILED, or whose answer couldn't be read, used to look like
// "no secrets yet" and a fresh set was deployed over a live install: every password void, every link
// already sent dead, and the old values gone for good.
//
// Now: on an install that is in use (its database has a user or a shop) an unreadable listing stops
// the run before anything is generated or deployed. Only an install with no users and no shops —
// where there is no Worker yet, so nothing to list — still gets every secret made.
//
// Like test108, this drives the real flow with a simulated wrangler whose database is a real SQLite.
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const UUID = "1a1a1a1a-bbbb-cccc-dddd-eeeeeeeeeeee";
const BOOKMARK = "00000085-0000024c-00004c6d-" + "8e61117bf38d7adb".repeat(2);
const FOUR = "CRON_SECRET,PASSWORD_PEPPER,PROXY_ADMIN_PASSPHRASE,SIGNING_SECRET";

(async () => {
  const S = await import("./scripts/setup.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odd-setup-secrets-test-"));
  const MIGRATIONS = fs.readdirSync(path.join(__dirname, "migrations")).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();

  // The stand-in for wrangler. st.secretList, when set, answers `secret list` itself:
  // { status, stdout, stderr }. st.failSql fails any database query whose SQL it matches.
  const cloud = async () => {
    const st = { dbs: [], buckets: [], secrets: [], deployed: 0, calls: [], secretsSeen: null, secretList: null, failSql: null, db: await createD1() };
    st.exec = (file, args) => {
      st.calls.push([file, ...args].join(" "));
      const w = args.slice(1), is = (...words) => words.every((x, i) => w[i] === x);
      const okOut = (stdout) => ({ status: 0, stdout: stdout || "", stderr: "" }), bad = (stderr) => ({ status: 1, stdout: "", stderr });
      if (is("--version")) return okOut("4.0.0");
      if (is("whoami")) return okOut("You are logged in with an OAuth Token");
      if (is("d1", "list")) return okOut(JSON.stringify(st.dbs));
      if (is("d1", "create")) { st.dbs.push({ uuid: UUID, name: w[2] }); return okOut("Created\n\"database_" + "id\": \"" + UUID + "\""); }
      if (is("r2", "bucket", "list")) return okOut("Listing buckets...\n" + st.buckets.map(b => "name:           " + b + "\n").join("\n"));
      if (is("r2", "bucket", "create")) { st.buckets.push(w[3]); return okOut("Created bucket"); }
      const todo = () => { let applied = []; try { applied = st.db.q("SELECT name FROM d1_migrations").map(r => r.name); } catch (err) { /* no record yet */ } return MIGRATIONS.filter(m => !applied.includes(m)); };
      if (is("d1", "migrations", "apply")) { for (const m of todo()) st.db.execFile(read("migrations/" + m)); return okOut("No migrations to apply!"); }
      if (is("d1", "migrations", "list")) return okOut(todo().length ? todo().join("\n") : "No migrations to apply!");
      if (is("d1", "time-travel", "info")) return okOut(JSON.stringify({ bookmark: BOOKMARK }));
      if (is("d1", "execute")) {
        const fi = w.indexOf("--file"), ci = w.indexOf("--command");
        try {
          if (fi >= 0) { st.db._raw.exec(fs.readFileSync(w[fi + 1], "utf8")); return okOut("Executed"); }
          if (st.failSql && st.failSql.test(w[ci + 1])) return bad("X [ERROR] simulated database failure");
          if (w.includes("--json")) return okOut(JSON.stringify([{ results: st.db.q(w[ci + 1]), success: true, meta: {} }]));
          st.db._raw.exec(w[ci + 1]); return okOut("");
        } catch (err) { return bad("D1_ERROR: " + err.message); }
      }
      if (is("secret", "list")) {
        if (st.secretList) return st.secretList;
        return st.deployed ? okOut(JSON.stringify(st.secrets.map(name => ({ name, type: "secret_text" })))) : bad("X [ERROR] This Worker does not exist on your account. [code: 10007]");
      }
      if (is("deploy")) {
        const i = w.indexOf("--secrets-file");
        st.secretsSeen = i >= 0 ? JSON.parse(fs.readFileSync(w[i + 1], "utf8")) : null;
        for (const k of Object.keys(st.secretsSeen || {})) if (!st.secrets.includes(k)) st.secrets.push(k);
        st.deployed++; return okOut("Deployed");
      }
      return bad("the stand-in doesn't know: " + w.join(" "));
    };
    return st;
  };
  const ANSWERS = { rootDomain: "myshop.example.test", adminSubdomain: "", businessName: "Thread & Needle", ownerEmail: "owner@example.test", timeZone: "Europe/London", r2PublicBase: "" };
  const go = async (st, config, { flags, dryRun } = {}) => {
    const lines = [], io = { ask: async (id) => ANSWERS[id] || "", print: (s) => lines.push(String(s)) };
    const run = S.createRunner({ dryRun: !!dryRun, exec: st.exec, print: io.print });
    const before = { deployed: st.deployed, calls: st.calls.length };
    st.secretsSeen = null;
    let result = null, error = null;
    try { result = await S.setup({ io, run, files: S.realFiles, configPath: config, flags: flags || {} }); } catch (err) { error = err; }
    return { result, error, text: lines.join("\n"), deploys: st.deployed - before.deployed, calls: st.calls.slice(before.calls) };
  };
  const config = (name) => { const p = path.join(tmp, name); fs.writeFileSync(p, read("wrangler.toml")); return p; };
  const addUser = (st) => st.db._raw.run("INSERT INTO users (email, name, role, createdAt, updatedAt) VALUES ('owner@example.test', 'Owner', 'owner', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
  const addShop = (st) => st.db._raw.run("INSERT INTO orgs (subdomain, name, createdAt, updatedAt) VALUES ('team', 'Team shop', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
  // An install someone uses: set up once, then a user has signed in.
  const installed = async (name, { shop = false } = {}) => {
    const st = await cloud(), cfg = config(name);
    const first = await go(st, cfg);
    if (first.error) throw first.error;
    if (shop) addShop(st); else addUser(st);
    return { st, cfg };
  };
  const stopped = (x) => x.error instanceof S.SetupError && x.deploys === 0 && !x.calls.some(c => / deploy /.test(c + " ")) && x.result === null;
  const madeNothing = (x) => !/Generated:/.test(x.text);

  console.log("=== Reading the list ===");
  ok("a list of secrets gives their names", S.readSecretList('[{"name":"CRON_SECRET","type":"secret_text"}]').join() === "CRON_SECRET");
  ok("an empty list is an empty list — the Worker has no secrets", Array.isArray(S.readSecretList("[]")) && S.readSecretList("[]").length === 0);
  ok("a banner before the list is skipped", S.readSecretList(" ⛅️ wrangler\n[{\"name\":\"SIGNING_SECRET\"}]").join() === "SIGNING_SECRET");
  ok("anything that isn't a list can't be read — and that is not the same as an empty list",
    [ "", "no worker", "▲ [WARNING] something\n[{\"name\":\"X\"}]", '{"error":"rate limited"}', "[{\"name\":" ].every(t => S.readSecretList(t) === null));
  ok("parseSecretList still answers with a plain list of names for both", S.parseSecretList("no worker").length === 0 && S.parseSecretList('[{"name":"A"}]').join() === "A");

  console.log("\n=== A new install: no Worker yet, so the secrets can't be listed ===");
  {
    const st = await cloud(), cfg = config("new.toml");
    const x = await go(st, cfg);
    ok("every secret is made and deployed, as before", !x.error && x.deploys === 1 && Object.keys(st.secretsSeen).sort().join() === FOUR);
    ok("it looked at the database first: no users and no shops", x.calls.some(c => c.includes(S.DB_IN_USE_SQL)));
  }
  {
    // A first run that got as far as the tables and then failed at the deploy: the database is no
    // longer new, but nobody has ever signed in, so nothing depends on a secret yet.
    const st = await cloud(), cfg = config("half.toml");
    const first = await go(st, cfg, { flags: { skipDeploy: true } });
    const x = await go(st, cfg);
    ok("a first run that stopped before the deploy can be finished: tables there, no users, no shops", !first.error && first.deploys === 0 && !x.error && x.deploys === 1 && /are up to date/.test(x.text) &&
      Object.keys(st.secretsSeen).sort().join() === FOUR);
  }

  console.log("\n=== An install in use: the secrets can't be listed ===");
  {
    const { st, cfg } = await installed("fail.toml");
    st.secretList = { status: 1, stdout: "", stderr: "X [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]" };
    const x = await go(st, cfg);
    ok("`secret list` fails: setup stops, generates nothing and does not deploy", stopped(x) && madeNothing(x) && st.secretsSeen === null);
    ok("the message says what failed, that no secret was changed, and what to do", /Could not list the secrets that are already set\./.test(x.error.message) && /Authentication error/.test(x.error.message) &&
      /already has shops or users/.test(x.error.message) && /No secret was changed/.test(x.error.message) && /can list this Worker's secrets/.test(x.error.message) && /run `npm run setup` again/.test(x.error.message));
    ok("no secret value is in the message", !/[0-9a-f]{64}/.test(x.error.message) && !/([a-z2-9]{4}-){5}[a-z2-9]{4}/.test(x.error.message));
    const y = await go(st, cfg, { flags: { newPassphrase: true } });
    ok("--new-passphrase doesn't get past it either (the pepper would still be at risk)", stopped(y) && madeNothing(y));
    st.secretList = null;
    const z = await go(st, cfg);
    ok("once the list works again, setup runs and makes nothing new", !z.error && z.deploys === 1 && st.secretsSeen === null && /nothing new \(already set\)/.test(z.text));
  }
  {
    const { st, cfg } = await installed("garbage.toml");
    for (const [what, stdout] of [["a warning in front of the list", "▲ [WARNING] wrangler is out of date\n" + JSON.stringify(st.secrets.map(name => ({ name })))], ["a banner and no list", " ⛅️ wrangler 4.0.0\n───────────────"], ["an error object", '{"error":"Too many requests"}'], ["nothing at all", ""]]) {
      st.secretList = { status: 0, stdout, stderr: "" };
      const x = await go(st, cfg);
      ok("`secret list` answers with " + what + ": setup stops, generates nothing and does not deploy", stopped(x) && madeNothing(x) && /Could not read wrangler's list of the secrets/.test(x.error.message) && /No secret was changed/.test(x.error.message));
    }
  }
  {
    const { st, cfg } = await installed("shop.toml", { shop: true });
    st.secretList = { status: 1, stdout: "", stderr: "X [ERROR] fetch failed" };
    const x = await go(st, cfg);
    ok("an install with a shop but no user yet counts as in use too", stopped(x) && madeNothing(x));
  }
  {
    const { st, cfg } = await installed("unknown.toml");
    st.secretList = { status: 1, stdout: "", stderr: "X [ERROR] fetch failed" };
    st.failSql = /FROM users/;
    const x = await go(st, cfg);
    ok("when it can't tell whether the install is in use either, it stops rather than guess", stopped(x) && madeNothing(x) && /could not check whether this install is in use/.test(x.error.message));
  }

  console.log("\n=== An install in use: the list is read ===");
  {
    const { st, cfg } = await installed("partial.toml");
    st.secretList = { status: 0, stdout: JSON.stringify(["PROXY_ADMIN_PASSPHRASE", "SIGNING_SECRET", "PASSWORD_PEPPER"].map(name => ({ name, type: "secret_text" }))), stderr: "" };
    const x = await go(st, cfg);
    ok("a list missing only CRON_SECRET: only CRON_SECRET is made", !x.error && x.deploys === 1 && Object.keys(st.secretsSeen).join() === "CRON_SECRET" && !/Shown ONCE/.test(x.text));
    st.secretList = null;
    const y = await go(st, cfg, { flags: { newPassphrase: true } });
    ok("--new-passphrase still replaces the passphrase, and only that", !y.error && y.deploys === 1 && Object.keys(st.secretsSeen).join() === "PROXY_ADMIN_PASSPHRASE" && y.text.split(st.secretsSeen.PROXY_ADMIN_PASSPHRASE).length === 2);
    st.secretList = { status: 0, stdout: "[]", stderr: "" };
    const z = await go(st, cfg);
    ok("a list that is read and empty means the Worker really has none: they are made (an install from before the pepper gets one this way)", !z.error && Object.keys(st.secretsSeen).sort().join() === FOUR);
  }

  console.log("\n=== A dry run ===");
  {
    const st = await cloud(), cfg = config("dry.toml");
    const x = await go(st, cfg, { dryRun: true });
    ok("it calls nothing, and says a real run makes only the missing secrets and stops if an install in use can't list them", !x.error && x.calls.every(c => /--version$/.test(c)) &&
      /A real run first lists the secrets already set and makes only the missing ones/.test(x.text) && /it stops, changing no secret, if that list can't be read/.test(x.text));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error("test290 crashed:", err); console.log("test290 crashed: false"); process.exit(1); });
