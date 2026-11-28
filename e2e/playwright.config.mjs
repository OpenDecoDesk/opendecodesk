// The end-to-end suite: a fresh local install (e2e/global-setup.mjs) driven in Playwright's Chromium.
// See e2e/README.md. Run it with `npm run e2e`.
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT || 8897);
// Specs that change a setting for the whole install (the sales tax, a feature switch): each runs alone, one after
// another, once every other spec has finished, so no other test reads that setting while it is changed.
const ALONE = ["gap-customers-tax-merge", "gap-quotes-tax", "gap-quotes-switch", "gap-discounts-switch", "gap-decoration-run-order", "gap-decoration-quotes", "gap-giftcards-flow", "gap-multi-codes-flow", "gap-giftcards-roles-reorder", "gap-net30-flow", "gap-unpaid-pos", "gap-own-garments", "gap-sales-profit", "gap-quickbooks"];
const ALONE_RE = (name) => new RegExp("specs[\\\\/]" + name + "\\.spec\\.mjs$");
const AFTER_SPECS = ALONE.map(ALONE_RE);

export default defineConfig({
  testDir: here,
  outputDir: path.join(here, ".results"),
  globalSetup: path.join(here, "global-setup.mjs"),
  globalTeardown: path.join(here, "global-teardown.mjs"),
  // A flaky test is a bug to fix, not to retry into passing. On this computer nothing is retried. On GitHub (CI set),
  // whose slower runner shows timing faults a fast machine hides, a failed test runs once more: one that then passes
  // is listed as "flaky" in the run's summary and report, to be fixed; a real break fails both times and still fails
  // the run.
  retries: process.env.CI ? 1 : 0,
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
      testIgnore: AFTER_SPECS,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(here, ".auth", "owner.json") },
    },
    // The specs in ALONE, each its own project, each waiting for the one before it.
    ...ALONE.map((name, i) => ({
      name: "alone-" + name,
      testMatch: ALONE_RE(name),
      dependencies: [i === 0 ? "chromium" : "alone-" + ALONE[i - 1]],
      use: { ...devices["Desktop Chrome"], storageState: path.join(here, ".auth", "owner.json") },
    })),
  ],
});
