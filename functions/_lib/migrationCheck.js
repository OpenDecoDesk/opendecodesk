/**
 * Has this database had every migration this code needs?
 *
 * Code can reach Cloudflare without its migrations: a bare `wrangler deploy`, the "Import a repository"
 * route (docs/install-one-click.md), or a migration that failed partway. Many readers in db.js treat a
 * missing table or column as "nothing yet" (so a deploy that runs a moment ahead of its migrations keeps
 * working), which would otherwise leave Home and Accounts & money showing $0 with no error anywhere.
 * This is the one check that says so instead: Global settings → Setup status marks the database as
 * not ready (and the admin opens there after signing in), and the morning roll-up reports it.
 *
 * MIGRATIONS (migrationList.js, written by scripts/migration-list.mjs) is the list this code ships;
 * the database's own list is its d1_migrations table, which `wrangler d1 migrations apply`, `npm run
 * setup` and the desktop program (desktop/migrate.js) all keep.
 */
import { MIGRATIONS } from "./migrationList.js";

// The names in `expected` the database hasn't recorded, in order: [] when it is up to date. null when it
// can't tell — no database, or no d1_migrations table at all (a database that predates the record; see
// docs/operations.md, "A database without a migration record").
export async function pendingMigrations(db, expected = MIGRATIONS) {
  if (!db || typeof db.prepare !== "function") return null;
  let rows;
  try { rows = ((await db.prepare("SELECT name FROM d1_migrations").all()) || {}).results || []; }
  catch (e) { return null; }
  const done = new Set(rows.map((r) => r && r.name));
  return (expected || []).filter((n) => !done.has(n));
}

// One line for the owner: how many, and the first few by name.
export function pendingMigrationsNote(pending) {
  if (!pending || !pending.length) return "";
  const names = pending.slice(0, 3).join(", ") + (pending.length > 3 ? ", and " + (pending.length - 3) + " more" : "");
  return `${pending.length} database update${pending.length === 1 ? " hasn't" : "s haven't"} been applied (${names}). ` +
    "Until they are, some pages can show $0 or empty lists. Apply them with npm run db:migrate (docs/operations.md, Migrations).";
}
