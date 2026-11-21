// Writes functions/_lib/migrationList.js: the names of the files in migrations/, which the Worker ships so it can
// tell when its database hasn't had them all (functions/_lib/migrationCheck.js). The Worker can't read the
// migrations folder itself, so the list is a file in the code — run this after adding a migration:
//
//   node scripts/migration-list.mjs
//
// A test (test225) fails while the list and the folder differ.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NAME_RE = /^\d{4}_[A-Za-z0-9_.-]+\.sql$/;   // as desktop/migrate.js and wrangler read them

export function migrationNames(root) {
  return fs.readdirSync(path.join(root, "migrations")).filter((f) => NAME_RE.test(f)).sort();
}

export function migrationListSource(names) {
  return "// The migrations this code needs, in order: written by scripts/migration-list.mjs from migrations/ — don't edit\n" +
    "// it by hand. functions/_lib/migrationCheck.js compares it with the database's d1_migrations table.\n" +
    "export const MIGRATIONS = [\n" + names.map((n) => "  " + JSON.stringify(n) + ",\n").join("") + "];\n";
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const names = migrationNames(root);
  fs.writeFileSync(path.join(root, "functions", "_lib", "migrationList.js"), migrationListSource(names));
  console.log("functions/_lib/migrationList.js: " + names.length + " migrations, the last " + names[names.length - 1]);
}
