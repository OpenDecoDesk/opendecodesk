const fs = require("fs");
const { ok } = require("./testlib/check");

// When a shop's order deadline passes (functions/_lib/db.js): localDayEndInstant(day, zone) is the last moment of
// that calendar day in the business's time zone (Global settings → Region) — 11:59:59.999 pm there — and the one
// moment the storefront's banner, its order block and order placement all close at. Checked across clock changes
// (both ways, in a zone west and one east of UTC), in zones far east of UTC, in a zone whose clocks jump at midnight,
// and for input that isn't a day. pickTimeZone is resolveTimeZone's choice from a saved zone already in hand (what
// the cached catalog carries); timeZoneShortName names the zone for the shopper ("EST"). The REAL db.js; no dates
// here depend on today.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const L = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { localDayEndInstant, pickTimeZone, timeZoneShortName, resolveTimeZone, dateInTimeZone };")();
const E = L.localDayEndInstant;
// The day the moment falls on in the zone, and the day of the very next millisecond.
const around = (iso, tz) => [L.dateInTimeZone(new Date(Date.parse(iso)), tz), L.dateInTimeZone(new Date(Date.parse(iso) + 1), tz)];
const endsDay = (day, tz) => { const iso = E(day, tz); const [a, b] = around(iso, tz); return a === day && b > day; };

(async () => {
  console.log("=== The end of a day in the business's time zone ===");
  ok("New York in winter: Dec 1 ends at 11:59:59.999 pm EST (04:59:59.999Z on Dec 2)", E("2026-12-01", "America/New_York") === "2026-12-02T04:59:59.999Z");
  ok("New York in summer: Jul 1 ends at 11:59:59.999 pm EDT (03:59:59.999Z on Jul 2)", E("2026-07-01", "America/New_York") === "2026-07-02T03:59:59.999Z");
  ok("UTC: the day ends at 23:59:59.999Z", E("2026-12-01", "UTC") === "2026-12-01T23:59:59.999Z");
  ok("Los Angeles: Dec 1 ends at 07:59:59.999Z on Dec 2", E("2026-12-01", "America/Los_Angeles") === "2026-12-02T07:59:59.999Z");

  console.log("\n=== Across a clock change (west of UTC) ===");
  ok("the day before the clocks go back (Oct 31) ends on summer time: 03:59:59.999Z", E("2026-10-31", "America/New_York") === "2026-11-01T03:59:59.999Z");
  ok("the day they go back (Nov 1, 25 hours) ends on winter time: 04:59:59.999Z on Nov 2", E("2026-11-01", "America/New_York") === "2026-11-02T04:59:59.999Z");
  ok("the day before they go forward (Mar 7) ends on winter time: 04:59:59.999Z", E("2026-03-07", "America/New_York") === "2026-03-08T04:59:59.999Z");
  ok("the day they go forward (Mar 8, 23 hours) ends on summer time: 03:59:59.999Z on Mar 9", E("2026-03-08", "America/New_York") === "2026-03-09T03:59:59.999Z");

  console.log("\n=== East of UTC ===");
  ok("Tokyo (UTC+9): Dec 1 ends at 14:59:59.999Z the same UTC day", E("2026-12-01", "Asia/Tokyo") === "2026-12-01T14:59:59.999Z");
  ok("Kiritimati (UTC+14): Dec 31 ends at 09:59:59.999Z, before the UTC day is half over", E("2026-12-31", "Pacific/Kiritimati") === "2026-12-31T09:59:59.999Z");
  ok("Berlin, the day before its clocks go forward (Mar 28): 22:59:59.999Z", E("2026-03-28", "Europe/Berlin") === "2026-03-28T22:59:59.999Z");
  ok("Berlin, the day they go forward (Mar 29): 21:59:59.999Z", E("2026-03-29", "Europe/Berlin") === "2026-03-29T21:59:59.999Z");
  ok("Sydney, the day before its clocks go forward (Oct 3, UTC+10): 13:59:59.999Z", E("2026-10-03", "Australia/Sydney") === "2026-10-03T13:59:59.999Z");
  ok("Sydney, the day they go forward (Oct 4, then UTC+11): 12:59:59.999Z", E("2026-10-04", "Australia/Sydney") === "2026-10-04T12:59:59.999Z");

  console.log("\n=== A zone whose clocks jump at midnight ===");
  // Santiago's clocks go from 11:59:59 pm on Sep 5 straight to 1:00 am on Sep 6: the day ends when the calendar turns.
  ok("Santiago, the night midnight is skipped (Sep 5): the day ends at 03:59:59.999Z, not an hour early", E("2026-09-05", "America/Santiago") === "2026-09-06T03:59:59.999Z");
  // …and go back from 12:00 am on Apr 5 to 11:00 pm on Apr 4, so Apr 4 has its last hour twice: it ends after the second.
  ok("Santiago, the night midnight comes twice (Apr 4): the day ends after its repeated hour, 03:59:59.999Z", E("2026-04-04", "America/Santiago") === "2026-04-05T03:59:59.999Z");
  const sample = [["2026-12-01", "America/New_York"], ["2026-03-08", "America/New_York"], ["2026-11-01", "America/New_York"], ["2026-12-01", "Asia/Tokyo"],
    ["2026-03-29", "Europe/Berlin"], ["2026-10-04", "Australia/Sydney"], ["2026-09-05", "America/Santiago"], ["2026-04-04", "America/Santiago"],
    ["2026-02-28", "Asia/Kolkata"], ["2028-02-29", "America/St_Johns"], ["2026-12-31", "Pacific/Chatham"]];
  ok("in every case the moment is still on that day there, and the next millisecond is on a later one", sample.every(([d, z]) => endsDay(d, z)));

  console.log("\n=== Input ===");
  ok("a full ISO time is read as its day (the first ten characters)", E("2026-12-01T00:00:00.000Z", "UTC") === "2026-12-01T23:59:59.999Z");
  ok("a month's last day rolls into the next month and year", E("2026-12-31", "UTC") === "2026-12-31T23:59:59.999Z" && E("2028-02-29", "UTC") === "2028-02-29T23:59:59.999Z");
  ok("an unknown zone counts as UTC", E("2026-12-01", "Not/AZone") === "2026-12-01T23:59:59.999Z" && E("2026-12-01", "") === "2026-12-01T23:59:59.999Z");
  ok("a zone with spaces around it is still that zone", E("2026-12-01", " America/New_York ") === "2026-12-02T04:59:59.999Z");
  ok("anything that isn't a day gives null (no deadline closes the shop)",
    [null, undefined, "", "soon", "12/01/2026", 20261201].every(v => E(v, "UTC") === null) && E("2026-12-01", "UTC") !== null);

  console.log("\n=== The zone: saved, else TIMEZONE, else UTC ===");
  ok("a saved zone wins", L.pickTimeZone("Asia/Tokyo", { TIMEZONE: "America/Chicago" }) === "Asia/Tokyo");
  ok("none saved: the TIMEZONE variable", L.pickTimeZone("", { TIMEZONE: "America/Chicago" }) === "America/Chicago");
  ok("…unless it isn't a zone: UTC", L.pickTimeZone("", { TIMEZONE: "Eastern" }) === "UTC" && L.pickTimeZone("", {}) === "UTC" && L.pickTimeZone(undefined, null) === "UTC");
  ok("resolveTimeZone gives the same answer from the database", (await L.resolveTimeZone({ DB: null, TIMEZONE: "America/Chicago" })) === "America/Chicago");

  console.log("\n=== The zone's short name, for the shopper ===");
  ok("New York: EST in winter, EDT in summer", L.timeZoneShortName("2026-12-02T04:59:59.999Z", "America/New_York") === "EST" && L.timeZoneShortName("2026-07-02T03:59:59.999Z", "America/New_York") === "EDT");
  ok("UTC: UTC", L.timeZoneShortName("2026-12-01T23:59:59.999Z", "UTC") === "UTC");
  ok("a zone with no US name: its offset (GMT+9)", L.timeZoneShortName("2026-12-01T14:59:59.999Z", "Asia/Tokyo") === "GMT+9");
  ok("an unknown zone: nothing (the banner then names no time)", L.timeZoneShortName("2026-12-01T00:00:00Z", "Not/AZone") === "" && L.timeZoneShortName("2026-12-01T00:00:00Z", "") === "");

  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
