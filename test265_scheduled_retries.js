const fs = require("fs");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { createD1 } = require("./testlib/d1-shim.js");

// The scheduled roll-up and housekeeping are retried (code review #96). They used to run only on their own hourly
// tick: a run that failed (the email service down, a database error) or a tick that never came waited a whole day,
// though the failure was recorded. Now each job keeps a record of the day in global_settings (dailyDigestScheduled,
// housekeepingScheduled: {day, attempts, ok}) and a later tick the same local day runs it again, up to 3 tries
// (functions/_lib/schedule.js scheduledJobDue). A roll-up whose email went out is done even if saving its progress
// then fails (no second email), and a roll-up sent by hand is neither a try nor a reason to skip one. The real
// src/worker.js, daily-digest.js, db.js and email.js on sql.js with the real schema; mail captured by a fetch mock.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const w = await import("./src/worker.js");
  const sch = await import("./functions/_lib/schedule.js");
  const dailyDigest = await import("./functions/api/daily-digest.js");
  const db = await import("./functions/_lib/db.js");

  console.log("=== The rule (schedule.js scheduledJobDue) ===");
  {
    const due = (entry, hour) => sch.scheduledJobDue(entry, { hour, jobHour: 6, day: "2026-07-15" });
    ok("before the job's hour: never", !due(null, 5) && !due({ day: "2026-07-14", attempts: 1, ok: true }, 5));
    ok("no record at all (the first day after the update): only the job's own hour, as before", due(null, 6) && !due(null, 7) && !due(null, 15));
    ok("yesterday's record: the job's hour or any later tick (a tick that never came, or the skipped hour of a clock change)", due({ day: "2026-07-14", attempts: 1, ok: true }, 6) && due({ day: "2026-07-14", attempts: 3, ok: false }, 9));
    ok("today, done: not again (nor on a repeated hour of a clock change)", !due({ day: "2026-07-15", attempts: 1, ok: true }, 6) && !due({ day: "2026-07-15", attempts: 1, ok: true }, 7));
    ok("today, failed: again until 3 tries", due({ day: "2026-07-15", attempts: 1, ok: false }, 7) && due({ day: "2026-07-15", attempts: 2, ok: false }, 8) && !due({ day: "2026-07-15", attempts: 3, ok: false }, 9));
    ok("a try counts from today's record, starting over on a new day", JSON.stringify(sch.scheduledAttempt({ day: "2026-07-15", attempts: 2, ok: false }, "2026-07-15")) === '{"day":"2026-07-15","attempts":3,"ok":false}' &&
      sch.scheduledAttempt({ day: "2026-07-14", attempts: 3, ok: false }, "2026-07-15").attempts === 1 && sch.scheduledAttempt(null, "2026-07-15").attempts === 1);
    ok("the local day is the business's (Tokyo is already the 15th at 21:00 UTC on the 14th)", sch.localDay(new Date("2026-07-14T21:00:00Z"), "Asia/Tokyo") === "2026-07-15" &&
      sch.localDay(new Date("2026-07-14T21:00:00Z"), "Not/AZone") === "2026-07-14");
  }

  // A database with the real schema, one shop and a new order (so the roll-up has something to send), and a switch
  // that makes chosen statements fail.
  const emails = [];
  let mailOk = true;
  global.fetch = async (url, init) => {
    if (!captureMail(url, init, emails)) return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    return mailOk ? MAIL_OK : { ok: false, status: 429, json: async () => ({ success: false, errors: [{ message: "quota" }] }) };
  };
  const site = async () => {
    const d1 = await createD1();
    d1._raw.exec(read("schema.sql"));
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('shop','shop','Example Shop','t','t');`);
    await db.insertOrder(d1, { orderId: "A1", orgId: "shop", customerName: "Pat", contact: "pat@example.test", paymentMethod: "Venmo", placedAt: new Date(Date.now() - 3600e3).toISOString() },
      [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: 20 }]);
    let failOn = null;
    const DB = new Proxy(d1, { get(t, k) {
      if (k === "prepare") return (sql) => { if (failOn && failOn.test(sql)) throw new Error("the database refused it"); return t.prepare(sql); };
      if (k === "failOn") return (re) => { failOn = re; };
      const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
    } });
    return { DB, d1, env: { DB, OWNER_EMAIL: "owner@example.test", EMAIL_FROM: "shop@example.test", SIGNING_SECRET: "s", ...MAIL_ENV } };
  };
  const tick = (env, hhmm, day = "2026-07-15") => w.handleScheduled({ scheduledTime: Date.parse(`${day}T${hhmm}:00Z`) }, env);
  const record = (d1, key) => { const r = d1.q("SELECT value FROM global_settings WHERE key = ?", key); return r.length ? JSON.parse(r[0].value) : null; };
  const quiet = async (fn) => { const e = console.error, l = console.log; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.error = e; console.log = l; } };

  console.log("\n=== The roll-up: fails at 06:00, retried at 07:00 ===");
  {
    const { d1, env } = await site();
    emails.length = 0; mailOk = false;
    const r6 = await quiet(() => tick(env, "06:00"));
    ok("06:00: the email can't be sent, the try is recorded as failed", r6.ran && r6.ok === false && emails.length === 1 &&
      JSON.stringify(record(d1, "dailyDigestScheduled")) === '{"day":"2026-07-15","attempts":1,"ok":false}');
    mailOk = true;
    const r7 = await quiet(() => tick(env, "07:00"));
    ok("07:00: tried again, and sent", r7.ran && r7.ok === true && r7.body.sent === true && emails.length === 2 && /A1/.test(emails[1].body) &&
      JSON.stringify(record(d1, "dailyDigestScheduled")) === '{"day":"2026-07-15","attempts":2,"ok":true}');
    const r8 = await quiet(() => tick(env, "08:00"));
    ok("08:00: done for the day, nothing runs", r8.ran === false && emails.length === 2);
    const next = await quiet(() => tick(env, "06:00", "2026-07-16"));
    ok("the next day runs at its hour again", next.ran === true && record(d1, "dailyDigestScheduled").day === "2026-07-16");
  }

  console.log("\n=== No fourth try ===");
  {
    const { d1, env } = await site();
    emails.length = 0; mailOk = false;
    const runs = [];
    for (const t of ["06:00", "07:00", "08:00", "09:00", "10:00"]) runs.push(await quiet(() => tick(env, t)));
    ok("three tries (06:00, 07:00, 08:00), then nothing that day", runs.map(r => r.ran).join() === "true,true,true,false,false" && emails.length === 3 &&
      record(d1, "dailyDigestScheduled").attempts === 3);
    ok("each failed try is reported for the owner", d1.q("SELECT count(*) AS n FROM system_issues WHERE kind = 'digest_failed'")[0].n === 3);
    mailOk = true;
  }

  console.log("\n=== A success isn't run again; a tick that never came is made up ===");
  {
    const { env } = await site();
    emails.length = 0;
    const r6 = await quiet(() => tick(env, "06:00"));
    const r7 = await quiet(() => tick(env, "07:00"));
    ok("sent at 06:00, nothing at 07:00", r6.ok === true && r7.ran === false && emails.length === 1);
    emails.length = 0;
    const late = await quiet(() => tick(env, "09:00", "2026-07-16"));
    ok("the next day's 06:00 tick never came: 09:00 sends it", late.ran === true && late.ok === true && emails.length === 1);
  }

  console.log("\n=== Sent, then saving the progress fails: no second email ===");
  {
    const { DB, d1, env } = await site();
    emails.length = 0;
    // The cursor ('dailyDigest') is saved after the email goes out.
    DB.failOn(/VALUES \('dailyDigest', \?\)/);
    const r6 = await quiet(() => tick(env, "06:00"));
    DB.failOn(null);
    ok("06:00: the email went out, then the run failed", emails.length === 1 && r6.ok === false);
    ok("…the try is recorded as done the moment the email went out", record(d1, "dailyDigestScheduled").ok === true);
    const r7 = await quiet(() => tick(env, "07:00"));
    ok("…so 07:00 doesn't send it again", r7.ran === false && emails.length === 1);
  }

  console.log("\n=== A roll-up sent by hand doesn't count ===");
  {
    const { d1, env } = await site();
    emails.length = 0;
    await quiet(() => dailyDigest.runDailyDigest(env, "manual"));
    ok("(sent by hand before the hour)", emails.length === 1 && JSON.parse(d1.q("SELECT value FROM global_settings WHERE key = 'dailyDigestRun'")[0].value).trigger === "manual");
    const r6 = await quiet(() => tick(env, "06:00"));
    ok("the 06:00 tick still runs (a hand-sent roll-up isn't the scheduled one)", r6.ran === true && record(d1, "dailyDigestScheduled").attempts === 1);
    const { d1: d2, env: env2 } = await site();
    mailOk = false;
    await quiet(() => tick(env2, "06:00"));
    mailOk = true;
    await quiet(() => dailyDigest.runDailyDigest(env2, "manual"));
    const r7 = await quiet(() => tick(env2, "07:00"));
    ok("…and after a failed 06:00 try, one sent by hand doesn't stop the 07:00 retry", r7.ran === true && record(d2, "dailyDigestScheduled").attempts === 2 && record(d2, "dailyDigestScheduled").ok === true);
  }

  console.log("\n=== The housekeeping: retried the same way, never on the roll-up's tick ===");
  {
    const { DB, d1, env } = await site();
    DB.failOn(/FROM vendor_api_log/);
    const h5 = await quiet(() => tick(env, "05:00"));
    ok("05:00: a clean-up fails, the housekeeping's try is recorded as failed", h5.ran && h5.housekeeping && h5.housekeeping.vendorLog.error &&
      JSON.stringify(record(d1, "housekeepingScheduled")) === '{"day":"2026-07-15","attempts":1,"ok":false}');
    DB.failOn(null);
    const r6 = await quiet(() => tick(env, "06:00"));
    ok("06:00: the roll-up runs, not the housekeeping (one job a tick)", r6.ran && !r6.housekeeping && "ok" in r6 && record(d1, "housekeepingScheduled").attempts === 1);
    const h7 = await quiet(() => tick(env, "07:00"));
    ok("07:00: the housekeeping is tried again and completes", h7.ran && !!h7.housekeeping && !h7.housekeeping.vendorLog.error &&
      JSON.stringify(record(d1, "housekeepingScheduled")) === '{"day":"2026-07-15","attempts":2,"ok":true}');
    const h8 = await quiet(() => tick(env, "08:00"));
    ok("08:00: nothing left to do", h8.ran === false);
  }

  console.log("\n=== Wiring ===");
  {
    const src = read("src/worker.js"), dd = read("functions/api/daily-digest.js");
    ok("the roll-up marks the try done as soon as the email is out, before it saves its progress", /runDailyDigest\(env, "scheduled", \{ onSent: markDone \}\)/.test(src) &&
      dd.lastIndexOf("await onSent();") > dd.indexOf("if (!sent) return") && dd.lastIndexOf("await onSent();") < dd.indexOf("await setDigestState(env.DB, { ...cursor, sentAt: new Date().toISOString() });"));
    ok("the desktop program keeps its own rule (desktopRollUpDue_)", /desktopRollUpDue_\(env, new Date\(/.test(src));
    ok("installs whose cron lists only some hours are told they get no retries", /no retries/.test(read("functions/_lib/schedule.js")) && /isn't retried until the next day/.test(read("wrangler.toml")));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log("test265 crashed: false"); process.exit(1); });
