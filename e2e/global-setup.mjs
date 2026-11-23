// Builds the local install from scratch before the suite runs, and starts it.
//   E2E_REUSE=1  keep an install that is already running on the port (for writing tests: no rebuild, no stop).
import fs from "node:fs";
import * as install from "./lib/install.mjs";

export default async function globalSetup() {
  fs.mkdirSync(install.AUTH_DIR, { recursive: true });
  if (process.env.E2E_REUSE && install.portInUse() && fs.existsSync(install.INSTALL_FILE)) {
    await install.waitForServer("http://127.0.0.1:" + install.PORT);
    console.log("[e2e] reusing the install already running on port " + install.PORT);
    return;
  }
  if (install.portInUse()) {
    // Most likely an earlier run's server that was not stopped: stop it if it is ours, else refuse.
    install.stopServer();
    if (install.portInUse()) throw new Error("Port " + install.PORT + " is in use by another program. Stop it, or set E2E_PORT.");
  }
  const t0 = Date.now();
  // Signed-in states and credentials belong to the install they were made on: a new install starts without them.
  for (const f of fs.readdirSync(install.AUTH_DIR)) if (/\.json$/.test(f)) fs.rmSync(install.AUTH_DIR + "/" + f);
  install.writeLocalFiles();
  install.buildDatabase();
  await install.startServer();
  fs.writeFileSync(install.INSTALL_FILE, JSON.stringify({ builtAt: new Date().toISOString(), port: install.PORT, stateDir: install.STATE_DIR }, null, 2));
  console.log("[e2e] fresh install on http://admin.localhost:" + install.PORT + " in " + ((Date.now() - t0) / 1000).toFixed(1) + "s (state: " + install.STATE_DIR + ")");
}
