// Global settings → Save is all or nothing: the page sends every section in ONE request (saveGlobalSettingsAll), the
// server checks every section first, and one refusal saves nothing — the answer names the section, and the page says
// "Nothing was saved. <Section>: …". (functions/api/orders.js saveGlobalSettingsAll, public/admin.js submitGlobalSettings.)
//
// Global settings are install-wide and the other spec files run beside this one, so nearly every save here is one the
// server REFUSES: nothing changes for anyone. Each refused save carries a value no one else uses (a unique business
// tagline, a unique card fee, a business name) and "nothing was saved" is checked as "that value is nowhere": not in
// the settings read back, not on the page after a reload, not in the audit log. (Comparing the whole settings before
// and after would trip over the other specs' own short-lived changes.) If a refusal ever went through, the finally
// puts the business profile back. The one save that succeeds sends three sections with the values they already have.
// No feature is switched off for real: the feature-off refusal is a save that would switch one off and is refused.
import { request as playwrightRequest } from "@playwright/test";
import crypto from "node:crypto";
import { test, expect, ADMIN, toast, uniq, slug, user, freshIp, waitIdle } from "../fixtures.mjs";
import { apiContext, callApi } from "../fixtures.mjs";
import { freshAdmin } from "../lib/money.mjs";

test.describe.configure({ mode: "serial" });

// The /api/orders actions a page sent, in order (recorded from before Save is clicked).
function recordActions(page) {
  const sent = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || !/\/api\/orders(\?|$)/.test(req.url())) return;
    let body = null;
    try { body = req.postDataJSON(); } catch (e) { body = null; }
    sent.push({ action: body && body.action, body });
  });
  return sent;
}
// The single-section actions Global settings → Save used to send one after another (and must not any more).
const SECTION_ACTIONS = ["updateGlobalSettings", "updateFeatures", "updateBusinessProfile", "updateLocaleSettings", "updateSalesTaxSettings",
  "updateShipFromAddress", "updateAccountingSettings", "updateEmailSettings", "updateDigitalSettings", "updateMachineSettings",
  "updatePricingSettings", "updateRushSettings"];

// Audit entries for Global settings since `from` (an ISO time), newest first.
async function settingsAudit(api, from) {
  const { entries } = await api("getAuditLog", { filter: "settings.", dateFrom: from, limit: 200 });
  return entries;
}

// What the owner's API reads back, for "nothing was saved" checks.
async function current(api) {
  const [{ business }, { locale }, { salesTax }, { pricing }, { rush }, { features }] = await Promise.all([
    api("getBusinessProfile"), api("getLocaleSettings"), api("getSalesTaxSettings"), api("getPricingSettings"), api("getRushSettings"), api("getFeatures")]);
  return { business, locale, salesTax, pricing, rush, features };
}
const pricingForm = (p) => ({ cardPct: p.cardPct, cardFixed: p.cardFixed, supplies: p.supplies,
  targetHourly: p.targetHourly == null ? "" : p.targetHourly, targetIncome: p.targetIncome == null ? "" : p.targetIncome });

// Nothing carrying `marker` was saved: not in the business profile, not in the audit log since `from`.
async function expectMarkerNowhere(api, marker, from) {
  const { business } = await api("getBusinessProfile");
  expect(JSON.stringify(business)).not.toContain(marker);
  const entries = await settingsAudit(api, from);
  expect(entries.filter(e => JSON.stringify(e).includes(marker)), "audit entries carrying " + marker).toEqual([]);
}
// If a refused save went through after all (the bug these tests are for), put the business profile back.
async function putBackBusiness(api, before, marker) {
  const { business } = await api("getBusinessProfile");
  if (JSON.stringify(business).includes(marker)) await api("updateBusinessProfile", { business: before });
}

test("Save sends one saveGlobalSettingsAll; an unknown time zone is refused naming Region, and the business-name edit in the same Save isn't saved", async ({ page, api }) => {
  const { business: before } = await api("getBusinessProfile");
  const { locale: localeBefore } = await api("getLocaleSettings");
  const name = uniq("Example Stitch Co");
  const from = new Date().toISOString();
  try {
    await freshAdmin(page, "settings");
    await page.locator("#gBizName").fill(name);
    await page.locator("#gLocaleTimeZone").fill("Not/AZone");
    const sent = recordActions(page);
    await page.getByRole("button", { name: "Save global settings" }).click();
    await expect(page.locator("#globalSettingsError")).toHaveText(/^Nothing was saved\. Region: "Not\/AZone" isn't a time zone this site knows\..*Fix it and save again\.$/);
    await expect(toast(page)).toContainText("Nothing was saved. Region:");
    await waitIdle(page);
    // One request for the whole page, and none of the single-section saves.
    const actions = sent.map(s => s.action);
    expect(actions.filter(a => a === "saveGlobalSettingsAll")).toHaveLength(1);
    expect(actions.filter(a => SECTION_ACTIONS.includes(a))).toEqual([]);
    // …carrying every section the page shows, the edits among them.
    const { settings } = sent.find(s => s.action === "saveGlobalSettingsAll").body;
    for (const k of ["locale", "features", "payments", "salesTax", "accounting", "business", "email", "pricing", "rush"]) expect(Object.keys(settings)).toContain(k);
    expect(settings.business.name).toBe(name);
    expect(settings.locale.timeZone).toBe("Not/AZone");
    // The page stays on Global settings (a save goes on to the catalog).
    expect(new URL(page.url()).hash).toBe("#settings");

    // Nothing saved: neither the zone nor the name, also after a reload.
    await expectMarkerNowhere(api, name, from);
    const { locale } = await api("getLocaleSettings");
    expect(locale.timeZone).not.toBe("Not/AZone");
    expect(locale.country).toBe(localeBefore.country);
    await freshAdmin(page, "settings");
    await expect(page.locator("#gBizName")).not.toHaveValue(name);
    await expect(page.locator("#gLocaleTimeZone")).not.toHaveValue("Not/AZone");
  } finally {
    await putBackBusiness(api, before, name);
  }
});

test("Save with a sales-tax rate over 15% is refused naming Sales tax; the tagline edited in the same Save isn't saved", async ({ page, api }) => {
  const { business: before } = await api("getBusinessProfile");
  const tagline = uniq("Hand-stitched by the e2e suite");
  const from = new Date().toISOString();
  try {
    await freshAdmin(page, "settings");
    await page.locator("#gBizTagline").fill(tagline);
    await page.locator("#gTaxRate").fill("99");
    const sent = recordActions(page);
    await page.getByRole("button", { name: "Save global settings" }).click();
    await expect(page.locator("#globalSettingsError")).toHaveText(/^Nothing was saved\. Sales tax: Tax rate must be between 0% and 15%\. Fix it and save again\.$/);
    await waitIdle(page);
    expect(sent.filter(s => s.action === "saveGlobalSettingsAll")).toHaveLength(1);
    expect(sent.filter(s => SECTION_ACTIONS.includes(s.action))).toEqual([]);

    await expectMarkerNowhere(api, tagline, from);
    const { salesTax } = await api("getSalesTaxSettings");
    expect(salesTax.ratePercent).not.toBe(99);
    expect(salesTax.ratePercent).toBeLessThanOrEqual(15);
    await freshAdmin(page, "settings");
    await expect(page.locator("#gBizTagline")).not.toHaveValue(tagline);
  } finally {
    await putBackBusiness(api, before, tagline);
  }
});

// The page checks the rush fee itself (globalSettingsProblem_), before anything is sent: no request at all.
test("Save with a fixed rush fee of $5,000 is refused on the page naming the rush fee, and no request is sent", async ({ page, api }) => {
  const { business: before } = await api("getBusinessProfile");
  const tagline = uniq("Rush tagline");
  const from = new Date().toISOString();
  try {
    await freshAdmin(page, "settings");
    await page.locator("#gBizTagline").fill(tagline);
    await page.locator("#gRushMode").selectOption("fixed");
    await page.locator("#gRushAmount").fill("5000");
    const sent = recordActions(page);
    await page.getByRole("button", { name: "Save global settings" }).click();
    await expect(page.locator("#globalSettingsError")).toHaveText(/^Nothing was saved\. Rush fee: .+\. Fix it and save again\.$/);
    await expect(page.locator("#gRushAmount")).toHaveCSS("outline-style", "solid");
    await waitIdle(page);
    expect(sent.map(s => s.action).filter(a => a === "saveGlobalSettingsAll" || SECTION_ACTIONS.includes(a))).toEqual([]);

    await expectMarkerNowhere(api, tagline, from);
    const { rush } = await api("getRushSettings");
    expect(rush.rule.amount).not.toBe(5000);
  } finally {
    await putBackBusiness(api, before, tagline);
  }
});

// The same request the page sends, built from what is saved now, with ONE bad value and two edits no one else uses
// (a business tagline and a card fee). The server checks the sections in order (Region first, Rush fee last), so
// a bad value late in the order is refused after every other section was checked and built: still nothing saved.
const BAD_SECTIONS = [
  { section: "Region", bad: (s) => { s.locale = { ...s.locale, timeZone: "Not/AZone" }; }, message: /^"Not\/AZone" isn't a time zone this site knows\./ },
  { section: "Region", bad: (s) => { s.locale = { ...s.locale, country: "XX" }; }, message: /^Country must be US or OTHER\.$/ },
  { section: "Features", bad: (s) => { s.features = { noSuchFeature: true }; }, message: /^"noSuchFeature" isn't a feature\.$/ },
  { section: "Features", bad: (s) => { s.features = { production: "yes" }; }, message: /^Each feature is either on \(true\) or off \(false\)\.$/ },
  { section: "Sales tax", bad: (s) => { s.salesTax = { ...s.salesTax, ratePercent: 99 }; }, message: /^Tax rate must be between 0% and 15%$/ },
  { section: "Sales tax", bad: (s) => { s.salesTax = { ...s.salesTax, jurisdiction: "Ohio" }; }, message: /2-letter state code/, usOnly: true },
  { section: "Bookkeeping", bad: (s) => { s.accounting = { saleDate: "whenever" }; }, message: /^Choose when a sale counts/ },
  { section: "Business profile", bad: (s) => { s.business = { ...s.business, supportEmail: "not-an-email" }; }, message: /^That doesn't look like a valid email: not-an-email$/ },
  { section: "Pricing", bad: (s) => { s.pricing = { ...s.pricing, cardPct: 500 }; }, message: /^A pricing setting is out of range\.$/ },
  { section: "Rush fee", bad: (s) => { s.rush = { ...s.rush, rule: { ...s.rush.rule, mode: "fixed", amount: 5000 } }; }, message: /.+/ },
  { section: "Business profile", bad: (s) => { s.business = "Example Stitch Co"; }, message: /^That isn't a valid Business profile section\.$/ },
];

test("Each section's bad value is refused (400) naming that section, and none of the valid edits sent with it is saved", async ({ api }) => {
  const now = await current(api);
  const before = now.business;
  const { accounting } = await api("getAccountingSettings");
  const { emailSettings } = await api("getEmailSettings");
  const { machineSettings } = await api("getMachineSettings");
  const from = new Date().toISOString();
  const markers = [];
  try {
    for (const c of BAD_SECTIONS) {
      if (c.usOnly && now.locale.country !== "US") continue;
      const tagline = uniq("All or nothing");
      markers.push(tagline);
      // A card fee no other spec uses: 3.17% (settings.spec uses 3.1). The payment-method boxes take anything, so
      // they are left out: a slip could never change them.
      const settings = {
        locale: { timeZone: now.locale.timeZone, country: now.locale.country },
        salesTax: { ratePercent: now.salesTax.ratePercent, jurisdiction: now.salesTax.jurisdiction || "", taxMode: now.salesTax.taxMode },
        accounting: { saleDate: accounting.saleDate },
        business: { ...before, tagline },
        email: { attachPdf: emailSettings.attachPdf },
        machine: { showDeleteButton: machineSettings.showDeleteButton },
        pricing: { ...pricingForm(now.pricing), cardPct: 3.17 },
        rush: { rule: now.rush.rule, taxable: now.rush.taxable },
      };
      c.bad(settings);
      const r = await api("saveGlobalSettingsAll", { settings }, { allowError: true, withStatus: true });
      expect(r.status, c.section + ": " + JSON.stringify(r.data)).toBe(400);
      expect(r.data.status).toBe("error");
      expect(r.data.section).toBe(c.section);
      expect(r.data.message).toMatch(c.message);
    }
    // Nothing from any of them was saved.
    const after = await current(api);
    for (const m of markers) expect(JSON.stringify(after.business)).not.toContain(m);
    expect(after.pricing.cardPct).not.toBe(3.17);
    expect(after.locale.timeZone).not.toBe("Not/AZone");
    expect(after.salesTax.ratePercent).toBeLessThanOrEqual(15);
    expect(after.features).not.toHaveProperty("noSuchFeature");
    expect(after.features.production).toBe(true);
    const entries = await settingsAudit(api, from);
    expect(entries.filter(e => markers.some(m => JSON.stringify(e).includes(m)) || /"cardPctBps":317\b/.test(JSON.stringify(e)))).toEqual([]);
  } finally {
    const { business } = await api("getBusinessProfile");
    if (markers.some(m => JSON.stringify(business).includes(m))) await api("updateBusinessProfile", { business: before });
  }
});

test("A request that isn't Global settings is refused before any section: an unknown part, a missing one, or none", async ({ api }) => {
  const { business: before } = await api("getBusinessProfile");
  const tagline = uniq("Unknown part");
  const from = new Date().toISOString();
  try {
    let r = await api("saveGlobalSettingsAll", { settings: { business: { ...before, tagline }, noSuchPart: {} } }, { allowError: true, withStatus: true });
    expect(r.status).toBe(400);
    expect(r.data.message).toBe('"noSuchPart" isn\'t a part of Global settings.');
    r = await api("saveGlobalSettingsAll", { settings: {} }, { allowError: true, withStatus: true });
    expect(r.status).toBe(400);
    expect(r.data.message).toBe("Nothing to save.");
    r = await api("saveGlobalSettingsAll", {}, { allowError: true, withStatus: true });
    expect(r.status).toBe(400);
    expect(r.data.message).toBe("Nothing to save.");
    await expectMarkerNowhere(api, tagline, from);
  } finally {
    await putBackBusiness(api, before, tagline);
  }
});

// A section whose feature is off — as it will be once this save is saved — is refused, as its own action would be.
// The save that would switch it off is the one refused, so nothing is switched off for real. Two sections are behind
// a feature (orders.js FEATURE_ACTIONS): Machine settings (Production) and Digital products. No other spec switches
// Production, so it is checked to stay on; settings.spec switches Digital products off and on for a moment, so for
// that one only the refusal and the audit log are checked. (Bookkeeping isn't one: its section, the sale date, is
// saved with the feature off too.)
test("A section whose feature the same save switches off is refused (403) naming the section, and the feature stays on", async ({ api }) => {
  const { business: before } = await api("getBusinessProfile");
  const { features: featBefore } = await api("getFeatures");
  expect(featBefore.production).toBe(true);
  const { machineSettings } = await api("getMachineSettings");
  const from = new Date().toISOString();
  const cases = [
    { feature: "production", label: "Production", section: "Machine settings", settings: { machine: { showDeleteButton: machineSettings.showDeleteButton } } },
    { feature: "digital", label: "Digital products", section: "Digital products", settings: { digital: { days: 14, downloads: 5, email: true, attach: false, attachMb: 10 } } },
  ];
  const markers = [], switchedOff = [];
  try {
    for (const c of cases) {
      const tagline = uniq("Feature off");
      markers.push(tagline);
      const r = await api("saveGlobalSettingsAll", { settings: { features: { [c.feature]: false }, business: { ...before, tagline }, ...c.settings } },
        { allowError: true, withStatus: true });
      if (r.data && r.data.status === "ok") switchedOff.push(c.feature);
      expect(r.status, JSON.stringify(r.data)).toBe(403);
      expect(r.data.section).toBe(c.section);
      expect(r.data.feature).toBe(c.feature);
      expect(r.data.message).toBe(`${c.label} is turned off. Turn it on under Settings → Global settings → Features.`);
    }
    // Production still on, and neither switch-off on record (the Features entry is written with the save, never
    // without it).
    expect((await api("getFeatures")).features.production).toBe(true);
    const entries = await settingsAudit(api, from);
    expect(entries.filter(e => e.action === "settings.features_set" && e.detail && e.detail.changes && e.detail.changes.production)).toEqual([]);
    for (const m of markers) await expectMarkerNowhere(api, m, from);
  } finally {
    const { business } = await api("getBusinessProfile");
    if (markers.some(m => JSON.stringify(business).includes(m))) await api("updateBusinessProfile", { business: before });
    // Only if a refusal went through after all: switch back on what it switched off.
    if (switchedOff.length) await api("updateFeatures", { features: Object.fromEntries(switchedOff.map(k => [k, true])) });
  }
});

// ---- Roles ----
// Every section's own action needs Global settings at Edit (permissions.js ACTION_PERM: settings.global edit), the
// same as saveGlobalSettingsAll itself. A role with Global settings at Read (Manager) or none (Back office, Read only)
// is refused at the door; a role with it at Edit passes every section's check and gets as far as the values.
const usersApi = (ctx, action, body = {}) => callApi(ctx, action, body, { path: "/api/admin-users" });
const client = (storageState, workerIndex) => playwrightRequest.newContext({ baseURL: ADMIN, storageState,
  extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) } });

test("Manager, Back office and Read only can't save Global settings: 403, and nothing saved", async ({ api }, testInfo) => {
  const { business: before } = await api("getBusinessProfile");
  const from = new Date().toISOString();
  const markers = [];
  try {
    for (const role of ["manager", "staff", "viewer"]) {
      const tagline = uniq("Not allowed");
      markers.push(tagline);
      const ctx = await apiContext(role, testInfo.workerIndex);
      try {
        const r = await callApi(ctx, "saveGlobalSettingsAll", { settings: { business: { ...before, name: "Not allowed", tagline } } }, { allowError: true, withStatus: true });
        expect(r.status, role + ": " + JSON.stringify(r.data)).toBe(403);
        expect(r.data.code).toBe("forbidden");
        expect(r.data.message).toBe("Your role can't do this. Ask an admin.");
        // …nor any one section's own action.
        const one = await callApi(ctx, "updateBusinessProfile", { business: { ...before, tagline } }, { allowError: true, withStatus: true });
        expect(one.status).toBe(403);
      } finally {
        await ctx.dispose();
      }
    }
    for (const m of markers) await expectMarkerNowhere(api, m, from);
    expect((await api("getBusinessProfile")).business.name).not.toBe("Not allowed");
  } finally {
    const { business } = await api("getBusinessProfile");
    if (markers.some(m => JSON.stringify(business).includes(m))) await api("updateBusinessProfile", { business: before });
  }
});

test("A custom role with Global settings at Edit and nothing else passes every section's permission check: a bad value is what's refused, and nothing is saved", async ({ api }, testInfo) => {
  const owner = await apiContext("owner", testInfo.workerIndex);
  const { business: before } = await api("getBusinessProfile");
  const tagline = uniq("Custom role");
  const from = new Date().toISOString();
  let roleKey = null, userId = null;
  try {
    const { role } = await usersApi(owner, "saveRole", { name: "Settings only " + slug("r").slice(-5), rank: 12, permissions: { fns: { "settings.global": "edit" } } });
    roleKey = role.key;
    expect(role.permissions.fns["settings.global"]).toBe("edit");
    expect(role.permissions.fns["costs.view"]).toBe("none");

    // A user of that role, signed in (temporary password replaced, as at a first sign-in).
    const email = slug("gs") + "@example.test";
    const made = await usersApi(owner, "create", { name: "Gus Settings", email, role: roleKey });
    userId = made.user.id;
    const first = await client(undefined, testInfo.workerIndex);
    let res = await first.post("/api/admin-session", { data: { email, key: made.temporaryPassword } });
    expect((await res.json()).pending).toBe("password");
    const password = "Gs-" + crypto.randomBytes(15).toString("base64url");
    res = await first.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: password } });
    expect((await res.json()).status).toBe("ok");
    await first.dispose();
    const them = await client(undefined, testInfo.workerIndex);
    try {
      res = await them.post("/api/admin-session", { data: { email, key: password } });
      const session = await res.json();
      expect(session.status, JSON.stringify(session)).toBe("ok");
      expect(session.pending || null).toBeNull();

      // Every section the page sends (Pricing and Rush fee among them, though the role has no costs.view): the
      // permission checks pass; the bad time zone is what's refused.
      const now = await current(api);
      const { accounting } = await api("getAccountingSettings");
      const settings = {
        locale: { timeZone: "Not/AZone", country: now.locale.country },
        salesTax: { ratePercent: now.salesTax.ratePercent, jurisdiction: now.salesTax.jurisdiction || "", taxMode: now.salesTax.taxMode },
        accounting: { saleDate: accounting.saleDate },
        business: { ...before, tagline },
        pricing: pricingForm(now.pricing),
        rush: { rule: now.rush.rule, taxable: now.rush.taxable },
      };
      const r = await callApi(them, "saveGlobalSettingsAll", { settings }, { allowError: true, withStatus: true });
      expect(r.status, JSON.stringify(r.data)).toBe(400);
      expect(r.data.section).toBe("Region");
      expect(r.data.code).not.toBe("forbidden");
    } finally {
      await them.dispose();
    }
    await expectMarkerNowhere(api, tagline, from);
  } finally {
    await putBackBusiness(api, before, tagline);
    // Tidy: the user moves to Production and is disabled, and the role (held by nobody now) is deleted.
    if (userId != null) {
      await usersApi(owner, "setRole", { id: userId, role: "production" }).catch(() => {});
      await usersApi(owner, "setStatus", { id: userId, status: "disabled" }).catch(() => {});
    }
    if (roleKey) await usersApi(owner, "deleteRole", { roleKey }).catch(() => {});
    await owner.dispose();
  }
});

// ---- A save that goes through ----
// Three sections saved with the values they already have (so nothing changes for the other specs): one request,
// the sections named in the answer, and one audit entry per section — the side effects happen once.
test("A successful save of three sections answers with them and records one audit entry for each", async ({ api }) => {
  const { accounting } = await api("getAccountingSettings");
  const { emailSettings } = await api("getEmailSettings");
  const { machineSettings } = await api("getMachineSettings");
  const t0 = new Date(Date.now() - 50).toISOString();
  const r = await api("saveGlobalSettingsAll", { settings: {
    accounting: { saleDate: accounting.saleDate },
    email: { attachPdf: emailSettings.attachPdf },
    machine: { showDeleteButton: machineSettings.showDeleteButton },
  } });
  const t1 = new Date(Date.now() + 1500).toISOString();
  expect(r.status).toBe("ok");
  expect(r.sections).toEqual(["Bookkeeping", "Email", "Machine settings"]);
  expect(r.settings).toEqual({ accounting, email: emailSettings, machine: machineSettings });
  expect(r.belowTarget).toEqual([]);
  expect(r).not.toHaveProperty("effectiveTimeZone");   // no Region in this save

  // The audit entries are written just after the answer: wait for them.
  const mine = async () => (await settingsAudit(api, t0)).filter(e => e.createdAt <= t1 && e.actor === user("owner").email);
  const count = (list, action) => list.filter(e => e.action === action).length;
  await expect.poll(async () => { const l = await mine(); return [count(l, "settings.accounting_set"), count(l, "settings.email_set"), count(l, "settings.machine_set")]; },
    { timeout: 5000 }).toEqual([1, 1, 1]);
  const list = await mine();
  expect(list.find(e => e.action === "settings.accounting_set").detail).toEqual({ from: accounting, to: accounting });
  expect(list.find(e => e.action === "settings.email_set").detail).toEqual({});

  // Read back: the same values.
  expect((await api("getAccountingSettings")).accounting).toEqual(accounting);
  expect((await api("getEmailSettings")).emailSettings).toEqual(emailSettings);
  expect((await api("getMachineSettings")).machineSettings).toEqual(machineSettings);
});
