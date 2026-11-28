// Quotes (migrations/0109): the Quotes switch under Settings → Global settings → Features. Off hides the page and the
// button, the server refuses every quote action, and a sent link says quotes aren't available; on again, all back.
// It switches Quotes off for the whole install, so it runs alone, after every other spec (ALONE in
// e2e/playwright.config.mjs) — while it runs, no other test can be making or answering a quote.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, shopUrl, openAdmin, toast, confirmDialog, signInThroughPage, callApi, apiContext, freshIp, slug, uniq } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const USERS = { path: "/api/admin-users" };
const FN = "quotes.estimates";
const NO_ROLE = "Your role can't do this. Ask an admin.";
const FEATURE_OFF = "Quotes is turned off. Turn it on under Settings → Global settings → Features.";
const FAR = "2099-12-31";   // an expiry no run of this suite reaches
const ACTIONS = ["listEstimates", "getEstimate", "createEstimate", "saveEstimate", "sendEstimate", "convertEstimate", "cancelEstimate"];

const nav = (page) => page.getByRole("navigation", { name: "Admin" });
const navBtn = (page) => nav(page).locator('.admin-nav-row > button[data-h="quotes"]');
const topButtons = (page) => nav(page).locator(".admin-nav-row > button[data-h]").evaluateAll(els => els.map(e => e.dataset.h));
const anEmail = () => slug("qr") + "@example.test";
const tryApi = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });
const refused = (r, message, what) => {
  expect(r.status, what + " is refused").toBe(403);
  expect(r.data.status, what).toBe("error");
  expect(r.data.message, what).toBe(message);
};
const ok200 = (r, what) => {
  expect(r.status, what + ": " + JSON.stringify(r.data)).toBe(200);
  expect(r.data.status, what).toBe("ok");
};

const makeCustomer = async (api, fields = {}) => (await api("saveCustomer", { name: uniq("Pat Example"), email: anEmail(), ...fields })).id;
// A quote made through the owner's session, with a $10 × 2 custom line: { id, number }.
const makeQuote = async (api, shop, customerId, title = uniq("Team shirts")) => {
  const made = await api("createEstimate", { org: shop.orgId, customerId, title, expiresOn: FAR });
  await api("saveEstimate", { id: made.id, items: [{ kind: "custom", name: "Embroidered patch", qty: 2, unitPrice: 10, taxable: true }] });
  return { id: made.id, number: made.number, title };
};
const sendQuote = async (api, id) => (await api("sendEstimate", { id, email: anEmail() })).link;
const quoteOf = async (api, id) => (await api("getEstimate", { id })).estimate;
const tokenOf = (link) => /[?&]estimate=([0-9a-f]{32})$/.exec(link)[1];

// The request each action takes, for a quote `q` (a draft with lines) of customer `customerId` in `shop`.
const bodies = (shop, customerId, q) => ({
  listEstimates: {},
  getEstimate: { id: q.id },
  createEstimate: { org: shop.orgId, customerId, title: "Never made" },
  saveEstimate: { id: q.id, title: "Changed by someone who may not", items: [{ kind: "custom", name: "Never saved", qty: 1, unitPrice: 1, taxable: true }] },
  sendEstimate: { id: q.id, email: "pat@example.com" },
  convertEstimate: { id: q.id },
  cancelEstimate: { id: q.id },
});

const openQuote = async (page, id) => {
  await openAdmin(page, "quotes/" + id);
  await expect(page.locator("#qtForm")).toBeVisible();
};
const listShown = async (page) => {
  await expect(page).toHaveTitle(/ — Quotes \(Admin\)$/);
  await expect(page.locator("#qtPage #qtQ")).toBeVisible();
};
const statusTag = (page) => page.locator("#qtPage h2.cust-name .qt-st");
const notAvailable = async (page, roleName) => {
  await expect(page.locator("#roleOffPanel")).toContainText("Not available to you.");
  await expect(page.locator("#roleOffPanel")).toContainText(`Your role (${roleName}) doesn't include this page.`);
};
const quotesHeading = (page) => page.locator("#custPage h3.cust-h", { hasText: /^Quotes$/ });

// + New quote (or the customer page's button, which arrives with `customerName` picked): a quote in `shop`.
// Returns { id, number }.
async function fillNewQuote(page, shop, customerName, title, { picked = false } = {}) {
  const form = page.locator("#qtNewForm");
  await expect(form).toBeVisible();
  if (!picked) {
    await expect(form.locator("#qtNewSave")).toBeVisible();
    await form.locator("#qtNewCust").fill(customerName);
    await form.locator("#qtNewCustList button", { hasText: customerName }).click();
  }
  await expect(form.locator("#qtNewPickedText")).toHaveText(new RegExp("^For " + customerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // The shop list is there whenever the install has more than one shop (other files' shops count).
  if (await form.locator("#qtNewShop").count()) await form.locator("#qtNewShop").selectOption(shop.orgId);
  await form.locator("#qtNewTitle").fill(title);
  await form.locator("#qtNewExpires").fill(FAR);
  await form.locator("#qtNewSave").click();
  await expect(toast(page)).toContainText(/Quote Q-\d{5} started\./);
  await expect(page).toHaveURL(/#quotes\/\d+$/);
  await expect(page.locator("#qtForm")).toBeVisible();
  const id = Number(/#quotes\/(\d+)$/.exec(page.url())[1]);
  const number = (await page.locator("#qtPage h2.cust-name").textContent()).match(/Q-\d{5}/)[0];
  return { id, number };
}
async function addFee(page, feeKind, name, amount) {
  await page.locator("#qtAddFee").click();
  const f = page.locator("#qtOtherForm");
  await f.locator("#qtOtherKind").selectOption(feeKind);
  await f.locator("#qtOtherName").fill(name);
  await f.locator("#qtOtherPrice").fill(amount);
  await f.locator("#qtOtherSave").click();
  await expect(f).toHaveCount(0);
}
async function addCustom(page, name, qty, price) {
  await page.locator("#qtAddCustom").click();
  const f = page.locator("#qtOtherForm");
  await f.locator("#qtOtherName").fill(name);
  await f.locator("#qtOtherQty").fill(qty);
  await f.locator("#qtOtherPrice").fill(price);
  await f.locator("#qtOtherSave").click();
  await expect(f).toHaveCount(0);
}
// Send… through the page. The suite's install sends no email, so the window shows the link instead: its token.
async function sendInPage(page, shop, email) {
  await page.locator("#qtSend").click();
  const f = page.locator("#qtSendForm");
  await f.locator("#qtSendEmail").fill(email);
  await f.locator("#qtSendGo").click();
  await expect(f.locator("#qtSendLinkNote")).toContainText("The quote is marked sent, but the email couldn't be sent.");
  const link = await f.locator("#qtSendLink").inputValue();
  expect(link).toMatch(new RegExp("^https://" + shop.subdomain + "\\.localhost/\\?estimate=[0-9a-f]{32}$"));
  await f.locator("#qtSendGo").click();   // now "Done"
  await expect(f).toHaveCount(0);
  await expect(statusTag(page)).toHaveText("Sent");
  await expect(page.locator("#qtSend")).toHaveText("Send again…");
  return tokenOf(link);
}

// ---- Manager: everything -----------------------------------------------------------------------------------

// ---- The Quotes feature switch ---------------------------------------------------------------------------------
test("Quotes switched off in Global settings: no button or page, the server refuses every quote action, a sent link says quotes aren't available; on again, all back", async ({ page, api, as }, testInfo) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "qrf", products: [{ name: "Sample Tee", price: 20 }] });
  const custId = await makeCustomer(api);
  const q = await makeQuote(api, shop, custId);
  const sent = await makeQuote(api, shop, custId);
  const token = tokenOf(await sendQuote(api, sent.id));
  const before = await api("getEstimate", { id: q.id });
  expect((await api("getFeatures")).features.quotes).not.toBe(false);

  const box = page.locator("#gFeatRow-quotes .gFeature");
  const saveSettings = async () => {
    await page.getByRole("button", { name: "Save global settings" }).click();
    await expect(toast(page)).toContainText("Global settings saved.");
  };
  const customerPage = (p) => p.goto(shopUrl(shop.subdomain) + "/?estimate=" + token);
  const publicApi = async (p) => {
    const get = await p.request.get(shopUrl(shop.subdomain) + "/api/estimate?token=" + token);
    const post = await p.request.post(shopUrl(shop.subdomain) + "/api/estimate", { data: { token, action: "changes", note: "Navy instead, please." } });
    return { get: { status: get.status(), data: await get.json() }, post: { status: post.status(), data: await post.json() } };
  };
  let switchedOff = false;
  try {
    // -- Off, through the page.
    await openAdmin(page, "settings");
    await expect(page.locator("#gFeatRow-quotes")).toContainText("Quotes");
    await expect(box).toBeChecked();
    await expect(navBtn(page)).toBeVisible();
    await box.uncheck();
    switchedOff = true;
    await saveSettings();
    expect((await api("getFeatures")).features.quotes).toBe(false);
    // The menu follows at once.
    await expect(navBtn(page)).toHaveCount(0);

    // The page and a quote's page say it's off; the customer's page has no Quotes section.
    await openAdmin(page, "quotes");
    await expect(page.locator("#featureOffPanel")).toContainText("Quotes is turned off.");
    await expect(page.locator("#featureOffPanel")).toHaveAttribute("data-feature", "quotes");
    await expect(page).toHaveTitle(/Quotes is turned off/);
    await expect(page.locator("#qtPage")).toHaveCount(0);
    await openAdmin(page, "quotes/" + q.id);
    await expect(page.locator("#featureOffPanel")).toContainText("Quotes is turned off.");
    await expect(page.locator("#qtForm")).toHaveCount(0);
    await openAdmin(page, "customers/" + custId);
    await expect(page.locator("#custForm")).toBeVisible();
    await expect(quotesHeading(page)).toHaveCount(0);
    await expect(page.locator("#custNewQuote")).toHaveCount(0);
    // Back office loses the button too.
    const sp = await as("staff");
    await openAdmin(sp, "home");
    expect(await topButtons(sp)).toContain("customers");
    await expect(navBtn(sp)).toHaveCount(0);

    // The server: every quote action, for a role that may use it, is refused as switched off; a role that may not
    // hears only that.
    const b = bodies(shop, custId, q);
    for (const a of ACTIONS) {
      const r = await api(a, b[a], { allowError: true, withStatus: true });
      expect(r.status, a + " with Quotes off").toBe(403);
      expect(r.data, a).toMatchObject({ status: "error", feature: "quotes", message: FEATURE_OFF });
    }
    const prod = await apiContext("production", testInfo.workerIndex);
    try {
      refused(await tryApi(prod, "listEstimates", {}), NO_ROLE, "listEstimates for Production with Quotes off");
    } finally {
      await prod.dispose();
    }

    // The customer's link: the page and the endpoint both say quotes aren't available, and nothing is answered.
    const cust = await as(null);
    await customerPage(cust);
    await expect(cust.locator("#app .inv-err")).toHaveText("Quotes aren't available.");
    await expect(cust.locator("#estAccept")).toHaveCount(0);
    const off = await publicApi(cust);
    for (const [k, v] of Object.entries(off)) {
      expect(v.status, k + " /api/estimate with Quotes off").toBe(403);
      expect(v.data, k).toMatchObject({ status: "error", feature: "quotes", message: "Quotes aren't available." });
    }

    // -- On again, through the page.
    await openAdmin(page, "settings");
    await expect(box).not.toBeChecked();
    await box.check();
    await saveSettings();
    expect((await api("getFeatures")).features.quotes).toBe(true);
    switchedOff = false;
    await expect(navBtn(page)).toBeVisible();
    await navBtn(page).click();
    await listShown(page);
    await openQuote(page, q.id);
    await expect(page.locator("#qtTitle")).toHaveValue(before.estimate.title);
    await openAdmin(page, "customers/" + custId);
    await expect(quotesHeading(page)).toBeVisible();
    // Nothing was lost while it was off.
    expect(await quoteOf(api, sent.id), "the refused request for changes changed nothing").toMatchObject({ status: "sent", customerNote: "" });
    const after = await api("getEstimate", { id: q.id });
    expect(after.estimate).toMatchObject({ status: "draft", title: before.estimate.title });
    expect(after.items).toEqual(before.items);
    // The customer's link shows the quote again, with Accept.
    await customerPage(cust);
    await expect(cust.locator("#app")).toContainText(sent.number);
    await expect(cust.locator("#estAccept")).toBeVisible();
    const get = await cust.request.get(shopUrl(shop.subdomain) + "/api/estimate?token=" + token);
    expect(get.status()).toBe(200);
    expect((await get.json()).estimate).toMatchObject({ number: sent.number, status: "sent", canAccept: true });
  } finally {
    if (switchedOff || (await api("getFeatures")).features.quotes === false) await api("updateFeatures", { features: { quotes: true } });
  }
});
