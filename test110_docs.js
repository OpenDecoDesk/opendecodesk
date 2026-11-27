const fs = require("fs");
const path = require("path");

// The documentation is part of the product: this keeps it honest where a machine can check.
// It can't check prose, but it can check that every setting the code reads is in the reference,
// that links go somewhere, that the claims that must stay hedged are still hedged, and that the
// backup workflow can't run in a fork that hasn't switched it on.
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

const DOCS = ["README.md", "CONTRIBUTING.md", "SECURITY.md", ...fs.readdirSync(path.join(__dirname, "docs")).filter(f => f.endsWith(".md")).map(f => "docs/" + f)];
const text = Object.fromEntries(DOCS.map(f => [f, read(f)]));
const readme = text["README.md"], config = text["docs/configuration.md"];

console.log("=== The set of documents ===");
ok("the eight guides, CONTRIBUTING and SECURITY exist", ["configuration", "setup", "accounts-and-keys", "email", "sales-tax", "shops-and-domains", "operations", "architecture"].every(n => ("docs/" + n + ".md") in text) && text["CONTRIBUTING.md"].length > 2000 && text["SECURITY.md"].length > 1000);
const broken = [];
for (const f of DOCS) for (const m of text[f].matchAll(/\]\(([^)\s]+)\)/g)) {
  const target = m[1];
  if (/^(https?:|mailto:)/.test(target)) continue;
  const [file, anchor] = target.split("#");
  const abs = file ? path.join(__dirname, path.dirname(f), file) : path.join(__dirname, f);
  if (!fs.existsSync(abs)) { broken.push(f + " → " + target); continue; }
  if (anchor && abs.endsWith(".md")) {
    const slugs = fs.readFileSync(abs, "utf8").split("\n").filter(l => /^#+ /.test(l)).map(l => l.replace(/^#+ /, "").trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-"));
    if (!slugs.includes(anchor)) broken.push(f + " → " + target + " (no such heading)");
  }
}
if (broken.length) console.log("   broken:", broken.join("; "));
ok("every link between the documents points at a file (and heading) that exists", broken.length === 0);
ok("the Deploy to Cloudflare button points at this repository, in the README and the one-click guide, and both say what has been tested", [readme, text["docs/install-one-click.md"] || ""].every(t => t.includes("](https://deploy.workers.cloudflare.com/?url=https://github.com/OpenDecoDesk/opendecodesk)") && /has(n't| not) been tried on a real account|Not yet tested on a real account/.test(t)) &&
  readme.includes("docs/install-one-click.md") && /\*\*Tested:\*\*/.test(text["docs/install-one-click.md"]) && /\*\*Not built yet:\*\*/.test(text["docs/install-one-click.md"]));
ok("the README links to every guide", ["setup", "accounts-and-keys", "configuration", "shops-and-domains", "email", "sales-tax", "operations", "architecture"].every(n => readme.includes("docs/" + n + ".md")) && /CONTRIBUTING\.md/.test(readme) && /SECURITY\.md/.test(readme));

console.log("\n=== The configuration reference is complete ===");
const code = [...fs.readdirSync(path.join(__dirname, "functions/_lib")).map(f => "functions/_lib/" + f), ...fs.readdirSync(path.join(__dirname, "functions/api")).map(f => "functions/api/" + f), "src/worker.js"].map(read).join("\n");
const names = [...new Set([...code.matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)].map(m => m[1]))].sort();
const legacyShipFrom = [...code.matchAll(/"(SHIP_FROM_[A-Z0-9]+)"/g)].map(m => m[1]);
const missing = names.filter(n => !new RegExp("`" + n + "`").test(config));
if (missing.length) console.log("   read by the code but not in docs/configuration.md:", missing.join(", "));
ok("every variable, secret and binding the code reads (env.NAME) is in docs/configuration.md", names.length >= 35 && missing.length === 0);
ok("…including the old ship-from variables the code still accepts", legacyShipFrom.length === 7 && /SHIP_FROM_NAME/.test(config) && /_STREET1/.test(config) && /_EMAIL/.test(config));
const documented = [...new Set([...config.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map(m => m[1]))].filter(n => !/^(US|OTHER|DB|UTC|SHIP_FROM_NAME)$/.test(n));
const invented = documented.filter(n => !names.includes(n) && !["IMAGES", "RECEIPTS", "DESIGNS"].includes(n));
if (invented.length) console.log("   documented but not read by the code:", invented.join(", "));
ok("…and it documents nothing the code doesn't read", invented.length === 0);
const wrangler = read("wrangler.toml");
ok("the bindings it lists are the ones in wrangler.toml", ["DB", "IMAGES", "RECEIPTS", "DESIGNS", "AGENT_MAILBOX", "ASSETS"].every(b => new RegExp('(binding|name) = "' + b + '"').test(wrangler) && config.includes("`" + b + "`")));
const dbSrc = read("functions/_lib/db.js");
ok("the defaults it states match the code: admin subdomain, roll-up hour, time zone, sender, placeholder domain", /ADMIN_SUBDOMAIN\) \|\| "admin"/.test(read("functions/_lib/hostConfig.js")) && /`ADMIN_SUBDOMAIN` \| no \| `admin`/.test(config) &&
  /DEFAULT_DIGEST_HOUR = 6\b/.test(read("functions/_lib/schedule.js")) && /`DIGEST_HOUR` \| no \| `6`/.test(config) && /DEFAULT_TIMEZONE = "UTC"/.test(read("functions/_lib/schedule.js")) && /`TIMEZONE` \| no \| `UTC`/.test(config) &&
  /"orders@" \+ siteRoot_/.test(read("functions/_lib/email.js")) && /`orders@<root domain>`/.test(config) && /DEFAULT_ROOT_DOMAIN = "example\.com"/.test(read("functions/_lib/hostConfig.js")) && /`ROOT_DOMAIN` \| \*\*yes\*\* \| `example\.com`/.test(config));
// (Ship-from address and Machine Files are panels inside Features — Shipping's and Production's.)
ok("each section of Global settings in the admin is in the reference", [...read("public/admin.js").matchAll(/<h2 style="margin(?:-bottom:12px|:22px 0 (?:12|6)px);">([A-Za-z -]+)<\/h2>/g)].map(m => m[1]).filter(h => ["Setup status", "Business profile", "Region", "Features", "Payment methods", "Sales tax"].includes(h)).length >= 6 &&
  /Ship-from address \$\{G_REQ_\}/.test(read("public/admin.js")) && /<div style="font-weight:600;margin-bottom:4px;">Machine Files<\/div>/.test(read("public/admin.js")) &&
  ["Setup status", "Business profile", "Region", "Features", "Payment methods", "Sales tax", "Ship-from address", "Machine Files"].every(h => config.includes("**" + h + "**")));
ok("it names all nine feature switches, as the code does", dbSrc.match(/export const FEATURES = \[[\s\S]*?\n\];/)[0].match(/\{ key: "(\w+)", label: "([^"]+)"/g).length === 9 && ["Storefront", "Production", "Bookkeeping", "Shipping", "Design approval", "Digital products", "Quotes", "Discount codes", "Email campaigns"].every(l => config.includes(l) && readme.includes("**" + l + "**")));
ok("it says which one section needs Publish — the one whose save doesn't refresh the catalog", /Payment methods\*\* \|[^\n]*needs Publish/.test(config) &&
  !/bumpCatalogVersion/.test(read("functions/api/orders.js").match(/if \(body\.action === "updateGlobalSettings"\) \{[\s\S]*?\n    \}/)[0]) &&
  ["updateBusinessProfile", "updateLocaleSettings", "updateFeatures", "updateSalesTaxSettings"].every(a => /bumpCatalogVersion/.test(read("functions/api/orders.js").match(new RegExp('if \\(body\\.action === "' + a + '"\\) \\{[\\s\\S]*?\\n    \\}\\n'))[0])));

console.log("\n=== Claims that must stay honest ===");
ok("the README keeps its first line and description", readme.startsWith("# OpenDecoDesk\nFree, open-source shop software for embroidery and garment decoration businesses."));
ok("it says pre-release, and exactly how far a real install has got: one, in its smallest form", /\*\*Status: pre-release\.\*\*/.test(readme) && /\*\*one install on a real Cloudflare account, in its smallest form\*\*/.test(readme) && /have run only against a simulated `wrangler`/.test(readme) && !/not ready for use/.test(readme));
const costs = readme.split("\n## What it costs\n")[1].split("\n## ")[0];
ok("costs: run on the paid Workers plan; Cloudflare email needs it; Resend is the alternative", /paid Workers plan/.test(costs) && /Cloudflare's own email sending needs the paid Workers plan/.test(costs) && /Resend/.test(costs));
ok("costs: the free plan is 'being evaluated', explicitly not a supported claim", /free plan is being evaluated and is not yet a supported claim/.test(costs));
ok("costs: no price or plan limit is stated as fact — it points at Cloudflare's pricing pages", !/\$\s?\d|\d[\d,]*\s*(requests|writes|reads|GB|MB)\b|per (day|month)/i.test(costs) && /Cloudflare's pricing pages/.test(costs));
ok("the send-agent is described as a separate project, linked to the machine agent's own repository", /send-agent/.test(readme) && /separate project/.test(readme) && !/not been published yet/.test(readme) &&
  /\[OpenDecoDesk Machine Agent\]\(https:\/\/github\.com\/OpenDecoDesk\/opendecodesk-machine-agent\)/.test(readme));
ok("the licence: AGPL-3.0, and NOTICE for pdf.js", /Affero General Public License v3\.0/.test(readme) && /NOTICE/.test(readme) && /pdf\.js/.test(readme) && fs.existsSync(path.join(__dirname, "LICENSE")) && fs.existsSync(path.join(__dirname, "NOTICE")));
ok("requirements and quickstart: a Cloudflare account, a domain on it, Node; npm ci then npm run setup", /Cloudflare account/.test(readme) && /domain whose DNS is on that Cloudflare account/.test(readme) && /Node\.js 22/.test(readme) && /npm ci\n/.test(readme) && /npm run setup\n/.test(readme));
ok("the installer is described the same way — one real install, the smallest one — in the setup guide and its own header", /has completed one install on a real Cloudflare account, in its smallest\s+> form/.test(text["docs/setup.md"]) && /have run only against a\s+> simulated `wrangler`/.test(text["docs/setup.md"]) &&
  /ONE INSTALL HAS BEEN COMPLETED ON A REAL CLOUDFLARE ACCOUNT, THE SMALLEST ONE/.test(read("scripts/setup.mjs")) && /has not run for real/.test(read("scripts/setup.mjs")));
ok("nothing still says no install was ever run or completed", !/not\s+(yet\s+)?been run against a real|not yet\s+completed an install|not yet been installed/i.test(readme + text["docs/setup.md"]) && !/NOT YET RUN AGAINST|NO INSTALL (HAS )?YET/.test(read("scripts/setup.mjs")));
ok("what couldn't be verified is marked as such rather than asserted", /This was seen on a real install/.test(text["docs/shops-and-domains.md"]) && /expected, not confirmed/.test(text["docs/setup.md"]) && /has not\s+been done by anyone/.test(text["docs/operations.md"]));
const all = DOCS.map(f => text[f]).join("\n");
const urls = [...new Set([...all.matchAll(/https?:\/\/[^\s)`"'>]+/g)].map(m => m[0].replace(/[.,;]$/, "")))];
// The sign-in pages of the outside services, as accounts-and-keys.md gives them (each checked against that service's documentation).
const SERVICE_PAGES = ["https://dash.cloudflare.com/sign-up", "https://dash.cloudflare.com/profile/api-tokens", "https://dashboard.stripe.com/register", "https://dashboard.stripe.com/apikeys",
  "https://dashboard.stripe.com/webhooks", "https://apps.goshippo.com/join", "https://portal.goshippo.com/api-config/api", "https://resend.com/domains", "https://resend.com/api-keys"];
// The Deploy to Cloudflare button: its picture and its link to this repository.
const BUTTON = ["https://deploy.workers.cloudflare.com/button", "https://deploy.workers.cloudflare.com/?url=https://github.com/OpenDecoDesk/opendecodesk",
  "https://github.com/OpenDecoDesk/opendecodesk-machine-agent"];   // and the project's own machine agent
const madeUp = urls.filter(u => !SERVICE_PAGES.includes(u) && !BUTTON.includes(u) && !/^https:\/\/(admin|images|league)?\.?(myshop\.com|<[^>]+>)|^https:\/\/(admin|images)\.<|^https:\/\/postalpro\.usps\.com\/ZIP_Locale_Detail$|^http:\/\/(localhost|127\.0\.0\.1):\d+|^https:\/\/…|^https:\/\/$/.test(u));
if (madeUp.length) console.log("   URLs:", madeUp.join(" "));
ok("no invented URLs: only example addresses on a made-up domain, localhost, the one real source the code cites, and the services' own sign-in pages", madeUp.length === 0);
ok("…and those service pages appear only in the accounts guide", SERVICE_PAGES.every(u => text["docs/accounts-and-keys.md"].includes(u)) && DOCS.filter(f => f !== "docs/accounts-and-keys.md").every(f => !SERVICE_PAGES.some(u => text[f].includes(u))));
ok("no real-looking email address anywhere in the docs", [...all.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)].map(m => m[0]).every(a => /@([\w-]+\.)?myshop\.com$|@threadneedle\.example$/.test(a)));

console.log("\n=== The accounts guide ===");
const guide = text["docs/accounts-and-keys.md"], setupSrc = read("scripts/setup.mjs");
const asked = [...new Set([...setupSrc.slice(setupSrc.indexOf("export const INTEGRATIONS"), setupSrc.indexOf("export const SECRET_NAMES")).matchAll(/(?:name: |generate: \[)"([A-Z][A-Z0-9_]+)"/g)].map(m => m[1]))];
const unnamed = asked.filter(n => !guide.includes("`" + n + "`"));
if (unnamed.length) console.log("   asked by the installer but not in docs/accounts-and-keys.md:", unnamed.join(", "));
ok("every value the installer asks an outside service for, or makes for one, is in the accounts guide", asked.length >= 13 && asked.includes("AGENT_TOKEN") && unnamed.length === 0);
ok("it names every Stripe event the installer lists, and the payload format the code needs", (setupSrc.match(/STRIPE_WEBHOOK_EVENTS = \[([\s\S]*?)\]/)[1].match(/"([a-z_.]+)"/g) || []).every(e => guide.includes("`" + e.replace(/"/g, "") + "`")) && /Snapshot/.test(guide));
ok("it covers the five accounts and says which are needed", ["Cloudflare", "Stripe", "Shippo", "Resend", "GitHub"].every(n => new RegExp("\\*\\*" + n + "\\*\\*").test(guide)) && /You don't need a GitHub account to install/.test(guide));
ok("it says it has not been followed end to end, and quotes no price, allowance or plan limit", /not yet been followed end to end/.test(guide) && !/\$\s?\d|\d[\d,]*\s*(requests|writes|reads|operations|GB|MB)\b|per (day|month)/i.test(guide));
ok("R2 is optional everywhere it is mentioned as a requirement, and the docs say an install without it has been done", /R2 \(file storage\) is optional/.test(readme) && /\*\*R2\*\* \(file storage\) is optional/.test(text["docs/setup.md"]) && /### 3\. Switch on R2 \(file storage\) — optional/.test(guide) &&
  /One real install has been done this way/.test(guide) && /an install that carried on\s+without storage have happened on a real account/.test(text["docs/setup.md"]) && !/with \*\*R2 switched on\*\*|R2 switched on \(which takes/.test(readme + text["docs/setup.md"] + guide));
ok("users and roles: the docs name the three roles, where people are managed, how a locked-out admin gets back in and what it costs, and that one function on the server enforces it",
  /Settings → Users/.test(text["docs/setup.md"]) && ["`staff` | Back office", "`manager` | Manager", "`admin` | Admin"].every(r => text["docs/operations.md"].includes(r)) && /### Locked out/.test(text["docs/operations.md"]) &&
  /npm run setup -- --new-passphrase/.test(text["docs/operations.md"]) && /Every other user's password\s+stops working too/.test(text["docs/operations.md"]) && /voids \*\*every\*\* user's password/.test(text["docs/configuration.md"]) &&
  /One function enforces them/.test(text["docs/architecture.md"]) && /anything it isn't told is\s+admin-only/.test(text["docs/architecture.md"]) && !/enforced by the admin page, not by each admin request/.test(text["docs/architecture.md"]));
ok("upgrading: one command applies migrations and then deploys, and it is a real script", /`npm run deploy`/.test(text["docs/operations.md"]) && JSON.parse(read("package.json")).scripts.deploy === "node scripts/deploy.mjs" &&
  /Coming from a version with one shared admin password/.test(text["docs/operations.md"]));
ok("deploying: the docs say a bare wrangler deploy detaches hostnames that aren't in wrangler.toml, and send people to npm run deploy instead", /Always deploy with `npm run deploy`, not a bare `npx wrangler deploy`/.test(text["docs/shops-and-domains.md"]) &&
  /detached by the next deploy/.test(text["docs/shops-and-domains.md"]) && /Don't use a bare\s+`npx wrangler deploy` on an installed site/.test(text["docs/operations.md"]) && !/Not yet verified:\*\* whether a later `wrangler deploy`/.test(text["docs/shops-and-domains.md"]) &&
  /by-hand|by hand/i.test(text["docs/shops-and-domains.md"]) && /^# Deploy:   npm run deploy/m.test(read("wrangler.toml")));
ok("a demo-site reset is told which tables and settings to leave alone", /`users` table, `admin_sessions`, `audit_log`/.test(text["docs/operations.md"]) && /`require2fa`/.test(text["docs/operations.md"]) && /key by key, not as a whole table/.test(text["docs/operations.md"]));
{
  // Optional Cloudflare Access: the paths the guide lists are real, and it leaves none of the back office's out.
  const access = guide.slice(guide.indexOf("### Optional: Cloudflare Access"), guide.indexOf("## GitHub (optional)"));
  const listed = [...new Set([...access.matchAll(/`\/?api\/([a-z0-9-]+)`/g)].map(m => m[1]))];
  const apiFiles = fs.readdirSync(path.join(__dirname, "functions/api")).filter(f => f.endsWith(".js")).map(f => f.replace(/\.js$/, ""));
  const gated = apiFiles.filter(f => /await requireAdmin\(/.test(read("functions/api/" + f + ".js")));
  ok("optional Cloudflare Access: an extra gate where people sign in twice, scoped to the admin hostname", access.length > 1500 && /people sign in twice/.test(access) && /an extra\s+gate, not a replacement/.test(access) && /scope\s+the Access application to that hostname/.test(access));
  ok("…every path it lists is a real endpoint, and every endpoint that needs a signed-in user is listed, with sign-in itself", listed.length >= 12 && listed.every(n => apiFiles.includes(n)) && [...gated, "admin-session"].every(n => listed.includes(n)));
  ok("…it says what must stay open (shops, the Stripe webhook, the by-hand roll-up) and that the workers.dev address stays off — as wrangler.toml has it", /Every shop hostname/.test(access) && /`\/api\/stripe-webhook` on the admin hostname/.test(access) && /`\/api\/daily-digest`/.test(access) &&
    /workers\.dev/.test(access) && /^preview_urls = false$/m.test(read("wrangler.toml")) && /^workers_dev = (true|false)$/m.test(read("wrangler.toml")));
}
ok("the payment method is something to expect, not a rule, and nothing describes one account's card", !/asks for a payment method|needs a payment method|payment method on file|already has a (card|payment method)/.test(readme + text["docs/setup.md"] + guide + setupSrc) && /Expect the checkout to ask for a \*\*payment method\*\*/.test(guide));
ok("it claims only what was seen: the R2 checkout screen, not a finished checkout or a rule for every plan", /the checkout was not completed there/.test(guide) && !/has been done on a real account/.test(guide) && !/on any plan|whatever plan/i.test(guide + readme + text["docs/setup.md"]));
ok("Access: it says which application's tag to copy, how to get back in, and who else can't sign in", /main\*\* application \(the one for the whole hostname, not the bypass\s+one\)/.test(guide) && /Access token is for a different application/.test(guide) && /`api\/agent`/.test(guide) && /`api\/design`/.test(guide) && /shop\s+hostnames instead of the admin hostname/.test(guide));
ok("by hand: secrets go through wrangler secret put, plain settings through [vars] and a deploy", /A secret \(every key, token and signing secret you gave the installer, except the Turnstile\s+site key\): `npx wrangler secret put NAME`/.test(guide) && /`\[vars\]` block in\s+`wrangler\.toml`, then `npm run deploy`/.test(guide) &&
  // the names the guide itself lists as plain settings are exactly the installer's non-secret fields, plus the bucket address
  [...(guide.match(/- A plain setting \(([^)]*)\)/) || ["", ""])[1].matchAll(/`([A-Z_0-9]+)`/g)].map(m => m[1]).sort().join() ===
    [...new Set([...setupSrc.slice(setupSrc.indexOf("export const INTEGRATIONS"), setupSrc.indexOf("export const SECRET_NAMES")).matchAll(/\{ name: "([A-Z][A-Z0-9_]+)"(?![^}]*secret: true)/g)].map(m => m[1])), "R2_PUBLIC_BASE"].sort().join());
ok("the backup steps say the project's own test check fails on an installed copy, and the by-hand backup needs the account id", /Disable workflow/.test(guide) && guide.includes('"' + (read(".github/workflows/test.yml").match(/^name: (.+)$/m) || [])[1] + '"') && /CLOUDFLARE_ACCOUNT_ID=<your account id> npm run db:backup:now/.test(guide));
ok("the setup guide and the README point to it", /accounts-and-keys\.md/.test(text["docs/setup.md"]) && /accounts-and-keys\.md/.test(readme));

console.log("\n=== SECURITY and CONTRIBUTING ===");
const sec = text["SECURITY.md"], con = text["CONTRIBUTING.md"];
ok("SECURITY: report privately through the repository host — no email address is given", /private vulnerability reporting/i.test(sec) && !/[\w.+-]+@[\w-]+\.\w+/.test(sec) && /don't open a public issue/i.test(sec));
ok("SECURITY: says what is in scope and what isn't", /## What is in scope/.test(sec) && /## What is out of scope/.test(sec));
ok("CONTRIBUTING: how to run the tests and the scan", /npm test/.test(con) && /scan-private\.sh --strict/.test(con));
ok("CONTRIBUTING: the ': false' convention, exactly as run-tests.sh applies it (with the other shapes a failed check prints, and testlib/check.js)", /: false/.test(con) && /exits non-zero/.test(con) &&
  /^FAIL_LINE='\(\^\|\[\[:space:\]\]\)false\$\|: \(0\|undefined\|null\)\$\|:\[\[:space:\]\]\*\$'$/m.test(read("run-tests.sh")) && /grep -E "\$FAIL_LINE"/.test(read("run-tests.sh")) &&
  ["`: 0`", "`: undefined`", "`: null`", "testlib/check.js", "test272"].every(s => con.includes(s)));
ok("CONTRIBUTING: access checks fail closed in a harness, and testlib/roles.js adminAs() signs one in", /Access checks fail closed in a harness/.test(con) && /adminAs\(\)/.test(con) && /test273/.test(con) &&
  typeof require("./testlib/roles").adminAs === "function");
ok("CONTRIBUTING: the glued-source harness and its pitfalls (exports, unique names, new imports)", /imports removed/i.test(con) && /export default/.test(con) && /unique across files/.test(con) && /ReferenceError/.test(con));
ok("CONTRIBUTING: migrations and the schema.sql drift rule, cents with db.js the only converter, audit-first, style", /schema\.sql/.test(con) && /test33/.test(con) && /only place that\s+converts/.test(con) && /auditStrict/.test(con) && /refuse the action if the audit row can't be written/.test(con) && /## Style/.test(con));
ok("…and those are real: the names it uses exist in the code", /const toCents = /.test(dbSrc) && /const fromCents = /.test(dbSrc) && /const auditStrict = /.test(read("functions/api/orders.js")) && /const periodGuard = /.test(read("functions/api/orders.js")) &&
  /export async function refreshPaidStatus|async function refreshPaidStatus/.test(dbSrc) && /export function orderAmounts/.test(dbSrc) && fs.existsSync(path.join(__dirname, "scripts/admin-local.js")));

console.log("\n=== The backup workflow is safe in a fork ===");
const wf = read(".github/workflows/d1-backup.yml");
ok("the job only runs where a repository variable switches it on", /\n    if: \$\{\{ vars\.D1_BACKUP_ENABLED == 'true' \}\}\n/.test(wf) && (wf.match(/^  [a-z]+:\n    if:/gm) || []).length === (wf.match(/\n    runs-on:/g) || []).length);
ok("…so a scheduled tick in a fork does nothing rather than failing nightly", /schedule:/.test(wf) && /OFF BY DEFAULT/.test(wf));
ok("it needs no GitHub environment to exist, and checks its secrets before doing anything", !/^\s*environment:/m.test(wf) && wf.indexOf("Check the secrets are there") < wf.indexOf("Export the D1 database") && /exit 1/.test(wf));
ok("read-only repository token, actions pinned to commits, wrangler pinned in the script", /permissions:\s*\n\s*contents: read/.test(wf) && [...wf.matchAll(/uses: (\S+)/g)].every(m => /@[0-9a-f]{40}$/.test(m[1])) && /wrangler@\d+\.\d+\.\d+/.test(read("scripts/d1-backup.sh")));
ok("the database and bucket can be changed with variables; the defaults are the names in wrangler.toml and the script", /vars\.D1_BACKUP_DATABASE \|\| 'opendecodesk-db'/.test(wf) && /database_name = "opendecodesk-db"/.test(wrangler) &&
  /vars\.D1_BACKUP_BUCKET \|\| 'opendecodesk-db-backups'/.test(wf) && /BACKUP_BUCKET:-opendecodesk-db-backups/.test(read("scripts/d1-backup.sh")));
ok("docs/operations.md explains switching it on, the two secrets, restoring, migrations and upgrading", ["D1_BACKUP_ENABLED", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "### Restoring", "## Migrations", "## Upgrading to a newer version", "npm run db:migrate"].every(s => text["docs/operations.md"].includes(s)));
{
  // The script itself, run with a stand-in wrangler and a stand-in clock: where each backup lands.
  const { spawnSync } = require("child_process"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odd-backup-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "date"), "#!/bin/sh\necho \"$FAKE_STAMP\"\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "wrangler.sh"), [
    "#!/bin/bash",
    'if [ "$1 $2" = "d1 export" ]; then out=""; while [ $# -gt 0 ]; do [ "$1" = "--output" ] && out="$2"; shift; done; printf "CREATE TABLE t(x);\\nINSERT INTO t VALUES(1);\\n" > "$out"; exit 0; fi',
    'if [ "$1 $2 $3" = "r2 object put" ]; then echo "$4" >> "$PUT_LOG"; exit 0; fi',
    // `r2 object get` as wrangler 4.110 behaves: an object that's there is written to --file; a missing key (HTTP 404)
    // fails with "The specified key does not exist."; any other failure says "Failed to fetch …".
    'if [ "$1 $2 $3" = "r2 object get" ]; then echo "$4" >> "$GET_LOG"',
    '  if [ -n "$GET_FAILS" ]; then echo "✘ [ERROR] A request to the Cloudflare API failed. Failed to fetch /accounts/x/r2/buckets/bk/objects/k - 500: Internal Server Error;" >&2; exit 1; fi',
    '  if grep -qxF "$4" "$EXISTING" 2>/dev/null; then out=""; while [ $# -gt 0 ]; do [ "$1" = "--file" ] && out="$2"; shift; done; echo x > "$out"; exit 0; fi',
    '  echo "✘ [ERROR] The specified key does not exist." >&2; exit 1; fi',
    "exit 1", ""].join("\n"), { mode: 0o755 });
  const backup = (stamp, { existing = [], getFails = false } = {}) => {
    const log = path.join(dir, "puts-" + stamp + ".txt"), gets = path.join(dir, "gets-" + stamp + ".txt"), have = path.join(dir, "have-" + stamp + ".txt");
    for (const f of [log, gets]) fs.rmSync(f, { force: true });
    fs.writeFileSync(have, existing.map(k => k + "\n").join(""));
    const r = spawnSync("bash", [path.join(__dirname, "scripts/d1-backup.sh"), "shopdb"], { encoding: "utf8",
      env: { ...process.env, PATH: path.join(dir, "bin") + ":" + process.env.PATH, FAKE_STAMP: stamp, PUT_LOG: log, GET_LOG: gets, EXISTING: have,
        GET_FAILS: getFails ? "1" : "", CLOUDFLARE_ACCOUNT_ID: "acct-test", BACKUP_BUCKET: "bk", WRANGLER: "bash " + path.join(dir, "wrangler.sh") } });
    const lines = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : [];
    return { status: r.status, puts: lines(log), gets: lines(gets), out: r.stdout + r.stderr };
  };
  const mid = backup("2026-11-14T030000Z", { existing: ["bk/shopdb/monthly/2026-11.sql.gz"] }), first = backup("2026-12-01T030000Z");
  ok("a nightly backup goes under <db>/daily/, where the lifecycle rule expires it (this month's copy already there: not written again)",
    mid.status === 0 && mid.puts.join() === "bk/shopdb/daily/2026-11-14T030000Z.sql.gz" && mid.gets.join() === "bk/shopdb/monthly/2026-11.sql.gz" && /already there/.test(mid.out));
  ok("on the 1st of the month it is also kept as <db>/monthly/<YYYY-MM>.sql.gz, which no rule touches", first.status === 0 &&
    first.puts.join() === "bk/shopdb/daily/2026-12-01T030000Z.sql.gz,bk/shopdb/monthly/2026-12.sql.gz");
  const late = backup("2026-10-17T030000Z");
  ok("a month whose 1st had no backup gets its copy from the first run that works (mid-month, none there yet)", late.status === 0 &&
    late.puts.join() === "bk/shopdb/daily/2026-10-17T030000Z.sql.gz,bk/shopdb/monthly/2026-10.sql.gz" && late.gets.join() === "bk/shopdb/monthly/2026-10.sql.gz");
  const lastMonthOnly = backup("2026-09-20T030000Z", { existing: ["bk/shopdb/monthly/2026-08.sql.gz"] });
  ok("…looking for this month's copy only (last month's being there doesn't count)", lastMonthOnly.status === 0 && lastMonthOnly.puts.length === 2 && lastMonthOnly.puts[1] === "bk/shopdb/monthly/2026-09.sql.gz");
  const unsure = backup("2026-11-15T030000Z", { existing: ["bk/shopdb/monthly/2026-11.sql.gz"], getFails: true });
  ok("when the check itself fails (not \"does not exist\"), the month's copy is written anyway, and the script says why", unsure.status === 0 &&
    unsure.puts.join() === "bk/shopdb/daily/2026-11-15T030000Z.sql.gz,bk/shopdb/monthly/2026-11.sql.gz" && /Couldn't check for this month's copy/.test(unsure.out));
  fs.rmSync(dir, { recursive: true, force: true });
  const ops = text["docs/operations.md"];
  ok("docs/operations.md gives the one-time 35-day rule on daily/ only, keeps monthly/, and says what to do with older flat files",
    /npx wrangler r2 bucket lifecycle add opendecodesk-db-backups \S+ "opendecodesk-db\/daily\/" --expire-days 35/.test(ops) && /no rule for `monthly\/`/.test(ops) &&
    /Backups from before this layout/.test(ops) && /opendecodesk-db\/daily\/<file>\.sql\.gz/.test(ops));
  ok("…and the nightly workflow says the same", /<db>\/daily\/<timestamp>\.sql\.gz/.test(wf) && /monthly\/<YYYY-MM>\.sql\.gz/.test(wf) && /35 days/.test(wf));
  ok("docs/operations.md: npm run deploy saves a restore point before migrations, and --no-backup skips it",
    /npx wrangler d1 time-travel restore opendecodesk-db --bookmark=<bookmark>/.test(ops) && /npm run deploy -- --no-backup/.test(ops) && read("scripts/deploy.mjs").includes('args.includes("--no-backup")'));
}
ok("the test workflow runs the scan in strict mode", /scan-private\.sh --strict/.test(read(".github/workflows/test.yml")));
{
  // A desktop release runs the whole test suite (test.yml, as a reusable workflow) and waits for it.
  const desk = read(".github/workflows/desktop.yml"), tw = read(".github/workflows/test.yml");
  const job = (name) => (desk.match(new RegExp("\\n  " + name + ":\\n((?:    .*\\n|\\s*\\n)+)")) || [])[1] || "";
  ok("a desktop release can't be published unless the test suite passes on the same run", /^on:\n(?:  .*\n)*  workflow_call:/m.test(tw) &&
    /if: inputs\.release\n/.test(job("tests")) && /uses: \.\/\.github\/workflows\/test\.yml\n/.test(job("tests")) && /needs: \[version, build, tests\]/.test(job("release")));

  // The end-to-end suite runs in test.yml as a second job, so every push and pull request runs it, and a release
  // (whose `tests` job waits for every job of test.yml) can't be published past a failing one. Both jobs have a
  // time limit, so a hang ends the run instead of holding it for GitHub's six hours.
  const twJob = (name) => (tw.match(new RegExp("\\n  " + name + ":\\n((?:    .*\\n|\\s*\\n)+)")) || [])[1] || "";
  const unit = twJob("test"), e2e = twJob("e2e");
  ok("the test job has a 20-minute limit", /^    timeout-minutes: 20\b/m.test(unit));
  ok("an e2e job with a 45-minute limit installs Chromium with its system libraries and runs `npm run e2e` one file at a time with CI set",
    /^    timeout-minutes: 45\b/m.test(e2e) && /^      - run: npm ci\b/m.test(e2e) && /^      - run: npx playwright install --with-deps chromium\b/m.test(e2e) &&
    /^      - run: npm run e2e\n        env:\n(?:          .*\n)*?          E2E_WORKERS: "1"/m.test(e2e) && /^          CI: "1"/m.test(e2e) &&
    e2e.indexOf("npm ci") < e2e.indexOf("playwright install") && e2e.indexOf("playwright install") < e2e.indexOf("npm run e2e"));
  ok("…on the same Node as the test job", (unit.match(/node-version: (\S+)/) || [])[1] === "22" && (e2e.match(/node-version: (\S+)/) || [])[1] === "22");
  ok("…and when it fails it keeps the report and the traces as an artifact", /- uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\n        if: failure\(\)\n/.test(e2e) &&
    /e2e\/\.report\n/.test(e2e) && /e2e\/\.results\n/.test(e2e) && /e2e-state\/wrangler-dev\.log\n/.test(e2e) && /include-hidden-files: true/.test(e2e));
  ok("a failed end-to-end test runs once more on GitHub only (CI set), never on a person's computer",
    /^  retries: process\.env\.CI \? 1 : 0,$/m.test(read("e2e/playwright.config.mjs")));
  ok("every action the workflows use is pinned to a full commit", [tw, desk, read(".github/workflows/d1-backup.yml")]
    .every(w => [...w.matchAll(/uses: (\S+)/g)].every(m => /^\.\//.test(m[1]) || /@[0-9a-f]{40}$/.test(m[1]))) && /actions\/upload-artifact@/.test(e2e));
}
const pkg = JSON.parse(read("package.json"));
ok("every npm script the docs mention exists", [...new Set([...all.matchAll(/npm run ([a-z0-9:]+)/g)].map(m => m[1]))].every(s => s in pkg.scripts));
ok("every script flag the docs mention is one the installer accepts", [...new Set([...all.matchAll(/(--[a-z][a-z-]+)/g)].map(m => m[1]))].filter(f => ["--dry-run", "--config", "--skip-deploy", "--new-passphrase", "--print-fresh-sql"].includes(f)).length === 5 &&
  ["--dry-run", "--skip-deploy", "--new-passphrase", "--print-fresh-sql"].every(f => read("scripts/setup.mjs").includes('a === "' + f + '"')));

console.log("\n=== Menu paths name menus that exist ===");
{
  // The admin's menus (ADMIN_NAV_GROUPS) and the pages in each. A path written "Menu → Page" in the docs, the
  // installer, the desktop program, the server's messages and emails or the admin itself must name a real menu
  // and a page in it — there is no "Tools" or "Security" menu.
  const adminSrc = read("public/admin.js");
  const groupsSrc = adminSrc.slice(adminSrc.indexOf("const ADMIN_NAV_GROUPS = ["), adminSrc.indexOf("// Flat list of every page hash"));
  const menus = {};
  for (const g of groupsSrc.matchAll(/\{ label: "([^"]+)", items: \[([\s\S]*?)\]\}/g)) menus[g[1]] = [...g[2].matchAll(/\["[a-z]+", "([^"]+)"\]|label: "([^"]+)"/g)].map(m => m[1] || m[2]);
  const files = [...DOCS, "scripts/setup.mjs", "desktop/main.js", "public/admin.js", "public/index.html", "public/storefront.js", "functions/_lib/email.js", "functions/_lib/http.js",
    "functions/_lib/supplierOrders.js", "functions/api/orders.js", "functions/api/admin-users.js", "functions/api/admin-password.js"];
  const wrong = [];
  for (const f of files) {
    const t = read(f).replace(/\*\*/g, "").replace(/&rarr;/g, "→").replace(/\s*\n\s*(\/\/\s*)?/g, " ");
    for (const m of t.matchAll(/\b(Tools|Security|Catalog|Production|Inventory|Finance|Reports|Settings) → ([A-Z][\w&()]*(?: [\w&()]+)*)/g)) {
      const [, menu, rest] = m;
      if (menu === "Security" && /^2-Step/.test(rest)) continue;   // Google's own account settings
      // Another program's or site's Settings (Cloudflare, GitHub, macOS, Shippo), not the admin's menu.
      if (/→ $/.test(t.slice(Math.max(0, m.index - 2), m.index))) continue;   // inside another site's path (Etsy: Shop Manager → Settings → …)
      if (menu === "Settings" && /^(Secrets and variables|Variables and Secrets|Privacy & Security|API\b|Delete this repository|Domains & Routes)/.test(rest)) continue;
      const pages = menus[menu];
      if (!pages || !pages.some(p => rest.toLowerCase().startsWith(p.toLowerCase()))) wrong.push(`${f}: ${menu} → ${rest.slice(0, 30)}`);
    }
  }
  if (wrong.length) console.log("   wrong:", wrong.slice(0, 12).join("; "));
  ok("the menus are read from the admin (Catalog … Settings)", ["Catalog", "Production", "Inventory", "Finance", "Reports", "Settings"].every(g => (menus[g] || []).length) && menus.Settings.includes("Users"));
  ok("every 'Menu → Page' path in the docs, installer, desktop program, server messages and admin names a real menu and one of its pages", wrong.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
