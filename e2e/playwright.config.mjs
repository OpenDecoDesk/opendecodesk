// The end-to-end suite: a fresh local install (e2e/global-setup.mjs) driven in Playwright's Chromium.
// See e2e/README.md. Run it with `npm run e2e`.
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT || 8897);

export default defineConfig({
  testDir: here,
  outputDir: path.join(here, ".results"),
  globalSetup: path.join(here, "global-setup.mjs"),
  globalTeardown: path.join(here, "global-teardown.mjs"),
  // Nothing is retried: a flaky test is a bug to fix, not to retry into passing.
  retries: 0,
  // The tests share one install (one database). Each makes its own data with unique names, so files can
  // run side by side; tests inside a file run in order.
  workers: Number(process.env.E2E_WORKERS || 3),
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { outputFolder: path.join(here, ".report"), open: "never" }]],
  use: {
    baseURL: "http://admin.localhost:" + PORT,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    // First run of the new install, through the real pages: the setup passphrase, the owner's account,
    // the users of every role, two-step sign-in. Saves each user's signed-in browser state in e2e/.auth/.
    { name: "setup", testMatch: /setup[\\/].*\.setup\.mjs$/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "chromium",
      testMatch: /specs[\\/].*\.spec\.mjs$/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(here, ".auth", "owner.json") },
    },
  ],
});
