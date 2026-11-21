const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// System problems and failed admin sign-ins for the daily roll-up are one row each (migrations/0215), not one
// JSON value read, changed and written back: failures at the same moment are each counted, and the roll-up
// deletes only what it reported, never one recorded while it was sending. The old JSON values carry over.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const L = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { recordSystemIssue, getSystemIssues, clearSystemIssues, recordFailedAdminLogin, getFailedAdminLogins, clearFailedAdminLogins };")();
const ok = (d, c) => console.log(d + ":", !!c);
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();

(async () => {
  console.log("=== The old JSON values carry over ===");
  {
    const d1 = await createD1();
    d1._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of migrations.filter(f => f < "0215")) d1.execFile(read("migrations/" + f));
    d1.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('systemIssues', ?)", JSON.stringify({ kinds: {
      email_failed: { count: 3, first: "2026-10-01T08:00:00.000Z", last: "2026-10-02T09:00:00.000Z", samples: ["Order received — SAMPLE-1", "Order confirmed — SAMPLE-2"] },
      webhook_failed: { count: 1, first: "2026-10-03T10:00:00.000Z", last: "2026-10-03T10:00:00.000Z", samples: [] } } }));
    d1.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('failedAdminLogins', ?)", JSON.stringify({
      count: 7, passphrase: 5, code: 2, ips: ["198.51.100.7", "203.0.113.9"], first: "2026-10-01T01:00:00.000Z", last: "2026-10-04T02:00:00.000Z" }));
    for (const f of migrations.filter(f => f >= "0215")) d1.execFile(read("migrations/" + f));
    const issues = await L.getSystemIssues(d1);
    const em = issues.find(x => x.kind === "email_failed"), wh = issues.find(x => x.kind === "webhook_failed");
    ok("problems: the same counts, times and samples as before", issues.length === 2 && em.count === 3 && em.first === "2026-10-01T08:00:00.000Z" && em.last === "2026-10-02T09:00:00.000Z" &&
      em.samples.join("|") === "Order received — SAMPLE-1|Order confirmed — SAMPLE-2" && wh.count === 1 && wh.samples.length === 0 && /couldn't be sent at all/.test(em.label));
    const s = await L.getFailedAdminLogins(d1);
    ok("failed sign-ins: the same counts, addresses and times as before", s.count === 7 && s.passphrase === 5 && s.code === 2 && s.ips.join() === "198.51.100.7,203.0.113.9" &&
      s.first === "2026-10-01T01:00:00.000Z" && s.last === "2026-10-04T02:00:00.000Z");
    ok("…and the old values are gone", d1.q("SELECT COUNT(*) AS n FROM global_settings WHERE key IN ('systemIssues', 'failedAdminLogins')")[0].n === 0);
  }

  console.log("\n=== At the same moment, and while the roll-up is sending ===");
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) d1.execFile(read("migrations/" + f));
  ok("nothing recorded reads as nothing", (await L.getSystemIssues(d1)) === null && (await L.getFailedAdminLogins(d1)) === null);
  await Promise.all([1, 2, 3, 4, 5, 6, 7].map(i => L.recordSystemIssue(d1, "email_failed", "Receipt — SAMPLE-" + i)));
  await Promise.all([L.recordSystemIssue(d1, "webhook_failed", ""), L.recordSystemIssue(d1, "webhook_failed")]);
  let issues = await L.getSystemIssues(d1);
  const em = issues.find(x => x.kind === "email_failed");
  ok("seven email failures at once count seven, with the first five samples", em.count === 7 && em.samples.length === 5 && em.samples[0] === "Receipt — SAMPLE-1" &&
    issues.find(x => x.kind === "webhook_failed").count === 2);
  await Promise.all(["a", "b", "c", "d"].map((x, i) => L.recordFailedAdminLogin(d1, i === 3 ? "code" : "passphrase", "192.0.2." + (i % 2))));
  let s = await L.getFailedAdminLogins(d1);
  ok("four sign-ins failing at once count four", s.count === 4 && s.passphrase === 3 && s.code === 1 && s.ips.join() === "192.0.2.0,192.0.2.1");

  // The roll-up reads, then (while its email is going out) another email fails and another sign-in fails.
  await L.recordSystemIssue(d1, "email_failed", "Sent while the roll-up was going out");
  await L.recordFailedAdminLogin(d1, "passphrase", "198.51.100.200");
  await L.clearSystemIssues(d1, issues);
  await L.clearFailedAdminLogins(d1, s);
  issues = await L.getSystemIssues(d1);
  s = await L.getFailedAdminLogins(d1);
  ok("the roll-up clears only what it reported: a problem recorded while it was sending waits for the next one",
    issues && issues.length === 1 && issues[0].kind === "email_failed" && issues[0].count === 1 && issues[0].samples[0] === "Sent while the roll-up was going out");
  ok("…and so does a sign-in that failed while it was sending", s && s.count === 1 && s.ips.join() === "198.51.100.200");
  await L.clearSystemIssues(d1, issues);
  await L.clearFailedAdminLogins(d1, s);
  ok("…which the next roll-up then clears", (await L.getSystemIssues(d1)) === null && (await L.getFailedAdminLogins(d1)) === null);
  ok("the roll-up passes what it read to both clears", /clearFailedAdminLogins\(env\.DB, security\)/.test(read("functions/api/daily-digest.js")) && /clearSystemIssues\(env\.DB, issues\)/.test(read("functions/api/daily-digest.js")));
  ok("recording a problem never throws, even with no database", await L.recordSystemIssue(null, "email_failed", "x").then(() => true, () => false));
})().catch(e => { console.error(e); process.exit(1); });
