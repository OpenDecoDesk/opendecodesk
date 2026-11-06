#!/usr/bin/env node
// `npm run deploy` — upgrade an installed OpenDecoDesk: apply new database migrations, make sure
// every shop's hostname is listed in wrangler.toml, then deploy. (`-- --dry-run` shows the
// commands and changes nothing; `-- --config <path>` uses another wrangler.toml; `-- --check` lists the
// migrations still to run and checks with Cloudflare that no hostname would be dropped, changing nothing.)
//
// Why not just `wrangler deploy`: a deploy makes the Worker's hostnames exactly the ones in
// wrangler.toml, so a shop hostname attached in the Cloudflare dashboard, or by the admin when the
// shop was created, would be detached. The work is `upgrade` in scripts/setup.mjs, tested in
// test108_setup_script.js with the same simulated wrangler as the installer.
import { upgrade, createRunner, createCloudflareApi, realExec, realFiles, SetupError } from "./setup.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const check = args.includes("--check");
const skipHostnameCheck = args.includes("--skip-hostname-check");
// Cloudflare's build (Workers Builds) sets WORKERS_CI; it is where a Deploy-button site is built.
const ci = !!process.env.WORKERS_CI || args.includes("--ci");
const diagnose = args.includes("--diagnose") || ci;   // in the build log it helps whoever reads it; nothing secret
const at = args.indexOf("--config");
const configPath = at >= 0 && args[at + 1] ? args[at + 1] : "wrangler.toml";
const print = (s = "") => console.log(s);

if (args.includes("--help") || args.includes("-h")) {
  print("npm run deploy [-- --dry-run] [-- --check] [-- --config <path>] [-- --diagnose] [-- --skip-hostname-check]\n\nBuilds or updates the database tables, lists every hostname the site uses in wrangler.toml, checks with Cloudflare that no hostname would be dropped, then deploys. --check does the checks and changes nothing.");
} else {
  print("OpenDecoDesk deploy" + (dryRun ? "  —  DRY RUN: nothing is changed or deployed" : check ? "  —  CHECK: nothing is changed or deployed" : ""));
  try {
    const run = createRunner({ dryRun, exec: realExec, print });
    await upgrade({ print, run, files: realFiles, configPath, ci, diagnose, check, skipHostnameCheck, api: createCloudflareApi({ run, env: process.env }) });
  } catch (e) {
    if (!(e instanceof SetupError)) throw e;
    print(""); print("✗ Deploy stopped: " + e.message);
    process.exit(1);
  }
}
