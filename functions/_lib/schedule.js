/**
 * Decides whether a cron tick is the daily roll-up's moment.
 *
 * Cron Triggers run in UTC only, but the roll-up should arrive at the same LOCAL hour all year,
 * wherever the business is (and through daylight saving). So the Worker is woken every hour, on the
 * hour, and this check lets exactly one tick a day through: the one whose local hour is DIGEST_HOUR.
 *
 * The time zone is the install's one time zone — Global settings → Region, else the TIMEZONE
 * variable, else UTC (resolveTimeZone in db.js) — which the caller looks up and passes in. Without
 * one passed, the TIMEZONE variable is used, then UTC. An unknown time zone counts as UTC rather
 * than never sending. DIGEST_HOUR (plain variable, 0-23) defaults to 6.
 *
 * The tick an hour BEFORE it is the daily housekeeping (isHousekeepingHour): Stripe fees the webhook
 * couldn't read, old vendor web-service logs, and customers' abandoned design uploads. It runs on its
 * own tick so its requests never come out of the roll-up's per-run allowance, and so a clean-up that
 * fails is recorded in time for that morning's roll-up.
 *
 * Retries (scheduledJobDue): each job keeps a record of the day in global_settings — {day, attempts, ok}
 * under dailyDigestScheduled and housekeepingScheduled (src/worker.js). A run that fails, or a tick that
 * never came, is tried again at the next hourly tick of the same local day, up to 3 tries a day. That
 * also covers the day the clocks change when DIGEST_HOUR is the hour that is skipped (it runs the hour
 * after) or repeated (the second one finds the day done). An install whose cron lists only specific UTC
 * hours (wrangler.toml) gets no retries: there is no later tick that day to retry on.
 */

export const DEFAULT_TIMEZONE = "UTC";
export const DEFAULT_DIGEST_HOUR = 6;

export function localHour(date, timeZone) {
  const fmt = (tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" });
  let parts;
  try { parts = fmt(timeZone || DEFAULT_TIMEZONE).formatToParts(date); }
  catch { parts = fmt(DEFAULT_TIMEZONE).formatToParts(date); }
  return Number(parts.find(p => p.type === "hour").value);
}

export function digestHour(env) {
  const n = Number(env && env.DIGEST_HOUR);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : DEFAULT_DIGEST_HOUR;
}

export function isDigestHour(env, date, timeZone) {
  return localHour(date, timeZone || (env && env.TIMEZONE)) === digestHour(env);
}

// The hour before the roll-up's (wrapping past midnight): the daily housekeeping tick.
export function housekeepingHour(env) {
  return (digestHour(env) + 23) % 24;
}
export function isHousekeepingHour(env, date, timeZone) {
  return localHour(date, timeZone || (env && env.TIMEZONE)) === housekeepingHour(env);
}

// The business's calendar day (YYYY-MM-DD) at `date`, in the time zone (UTC when it isn't one).
export function localDay(date, timeZone) {
  const fmt = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  try { return fmt(timeZone || DEFAULT_TIMEZONE).format(date); }
  catch { return fmt(DEFAULT_TIMEZONE).format(date); }
}

export const SCHEDULED_MAX_ATTEMPTS = 3;

// Whether this tick should run a daily job: its local hour or later, and today not yet done — no try yet
// today (its own tick never came, or it's the first tick of the day at or past the hour), or tries that
// failed, fewer than SCHEDULED_MAX_ATTEMPTS. `entry` is the job's saved record ({day, attempts, ok}), null
// when there is none at all — a database that has never had one (the first day after this update, or a
// record that can't be read): then only the job's own hour runs it, as before retries, so an update deployed
// in the afternoon doesn't send a second roll-up that day.
export function scheduledJobDue(entry, { hour, jobHour, day }) {
  if (hour < jobHour) return false;
  if (!entry || typeof entry !== "object") return hour === jobHour;
  if (entry.day !== day) return true;
  return entry.ok !== true && (Number(entry.attempts) || 0) < SCHEDULED_MAX_ATTEMPTS;
}

// The record to save before a try (so a run the runtime cuts off still counts as one), and after it.
export function scheduledAttempt(entry, day) {
  const before = entry && typeof entry === "object" && entry.day === day ? Number(entry.attempts) || 0 : 0;
  return { day, attempts: before + 1, ok: false };
}
