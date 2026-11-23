// Stops the local install the suite started (E2E_REUSE=1 or E2E_KEEP=1 leave it running).
import * as install from "./lib/install.mjs";

export default async function globalTeardown() {
  if (process.env.E2E_REUSE || process.env.E2E_KEEP) return;
  if (install.stopServer()) console.log("[e2e] stopped the local install on port " + install.PORT);
}
