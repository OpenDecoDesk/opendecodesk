// Communications → the list of problems waiting for the next roll-up (public/admin.js renderCommunications,
// commsClearIssues_). The roll-up clears the problems it reports; with no email set up it never sends, so the list
// would only grow: a Clear button empties it, after asking. Shown to a role with Communications at Edit (the
// owner, a manager), not to Back office (Communications at Read).
//
// The problems are put in the local database directly (wrangler d1 execute --local on the suite's own install):
// the app records them only when something outside fails (an email provider, a Stripe webhook, a crashed request).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test, expect, openAdmin, confirmDialog, toast, uniq } from "../fixtures.mjs";
import { CONFIG, STATE_DIR, REPO } from "../lib/install.mjs";

const sql = (command) => {
  const r = spawnSync(path.join(REPO, "node_modules", ".bin", "wrangler"), ["d1", "execute", "DB", "--local", "--config", CONFIG, "--persist-to", STATE_DIR, "--command", command, "--json"],
    { cwd: REPO, encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
  if (r.status !== 0) throw new Error("wrangler d1 execute failed: " + (r.stdout || "") + (r.stderr || ""));
  return r.stdout;
};

test.describe.configure({ mode: "serial" });

test("the problems list: Clear asks first, then empties it; Back office sees no Clear", async ({ page, as }) => {
  const sample = uniq("Order received");
  const at = new Date().toISOString();
  sql(`INSERT INTO system_issues (kind, n, sample, at) VALUES ('email_failed', 1, '${sample}', '${at}'), ('webhook_failed', 1, 'evt_e2e', '${at}')`);

  await openAdmin(page, "comms");
  const box = page.locator("#commsIssues");
  await expect(box).toContainText("Emails that couldn't be sent at all");
  await expect(box).toContainText(sample);

  // Back office reads Communications but may not clear it.
  const staff = await as("staff");
  await openAdmin(staff, "comms");
  await expect(staff.locator("#commsIssues")).toContainText(sample);
  await expect(staff.locator("#commsClearIssuesBtn")).toBeHidden();

  // Asked first: Cancel leaves the list as it was.
  const clear = page.getByRole("button", { name: "Clear", exact: true });
  await clear.click();
  await page.getByRole("dialog").last().locator("#cmCancel").click();
  await expect(box).toContainText(sample);

  await clear.click();
  await confirmDialog(page, "Clear");
  await expect(toast(page)).toContainText(/Cleared \d+ problems?\./);
  await expect(page.locator("#commsBody")).not.toContainText(sample);

  // Cleared in the database too, and the clearing is in the audit log.
  expect(JSON.parse(sql(`SELECT COUNT(*) AS n FROM system_issues WHERE sample = '${sample}'`))[0].results[0].n).toBe(0);
  expect(JSON.parse(sql("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'system_issues.cleared'"))[0].results[0].n).toBeGreaterThan(0);
});

// Two things the roll-up now keeps instead of losing (functions/_lib/stripeFees.js, deliveryCheck.js): Stripe refusing
// the card-fee lookups (a revoked or restricted key) is a problem with its own label, and a carrier pickup is a queued
// notice, under "Needs attention" when the customer's shipped email couldn't be sent. Put in the database directly, as
// above: the test install has no Stripe key and no carrier tracking.
test("a card-fee refusal and carrier pickups show on Communications", async ({ page }) => {
  const sample = uniq("Stripe refused the secret key (401)");
  const fine = uniq("Cust - USPS 9400111 picked up"), failed = uniq("Cust - USPS 9400222 picked up");
  const at = new Date().toISOString();
  sql(`INSERT INTO system_issues (kind, n, sample, at) VALUES ('card_fees_failed', 1, '${sample}', '${at}')`);
  sql(`INSERT INTO owner_notices (kind, orderId, orgId, summary, detail, urgent, createdAt) VALUES
    ('picked_up', 'E2E-PU1', '', '${fine}', 'Marked shipped; the customer was emailed their tracking.', 0, '${at}'),
    ('picked_up', 'E2E-PU2', '', '${failed}', 'Marked shipped, but the shipped email could not be sent. Send them their tracking yourself.', 1, '${at}')`);
  try {
    await openAdmin(page, "comms");
    const body = page.locator("#commsBody");
    await expect(page.locator("#commsIssues")).toContainText("Card fees couldn't be read from Stripe");
    await expect(page.locator("#commsIssues")).toContainText(sample);

    await expect(body.getByRole("heading", { name: /Picked up by the carrier — \d+/ })).toBeVisible();
    const row = body.locator("tr", { hasText: fine });
    await expect(row).toContainText("Picked up");
    await expect(row).toContainText("E2E-PU1");

    const attention = body.locator("div", { has: page.getByRole("heading", { name: "⚠️ Needs attention" }) });
    await expect(attention).toContainText(failed);
    await expect(attention).toContainText("Send them their tracking yourself");
    await expect(attention).not.toContainText(fine);
  } finally {
    // Leave nothing behind for the next roll-up (or another spec's page).
    sql(`DELETE FROM system_issues WHERE sample = '${sample}'`);
    sql(`UPDATE owner_notices SET sentAt = '${at}' WHERE summary IN ('${fine}', '${failed}')`);
  }
});
