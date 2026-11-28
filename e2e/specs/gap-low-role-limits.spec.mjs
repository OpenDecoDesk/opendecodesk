// Role limits on files and dates (the low-priority review, #78, #80, #89):
//   - #78 Receipts: the View buttons show on read-only screens (Brand rules, the Account viewer…), so
//     /api/receipt signs a link for Read on any of them; adding a receipt still needs Edit on expenses, money or
//     payments (functions/api/receipt.js). Blanks (owner's rule, 2026-11-23: Read on Blanks = stock and details only):
//     Read there opens a vendor receipt only together with costs.view, or at Edit.
//   - #80 Private files: /api/design signs a link only for a role that may see that kind of file: a design's files
//     for the design, order and production screens; an order line's own files (a customer's photo) for the order
//     and production screens, not Designs; a digital product's files for the product-files and downloads screens.
//   - #89 The Dates window: a step's date belongs to the half of the steps it is in (orders.stepsEarly /
//     orders.stepsLate), as moving the step does. The server refuses the other half (setOrderDates), and the window
//     greys it out.
// Each test's roles, users and shop are its own, with unique names, made through the owner's session; at the end
// the users are moved to Production and disabled, and the roles deleted. Nothing install-wide changes.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, openAdmin, signInThroughPage, callApi, apiContext, freshIp, slug, uniq, pngBytes } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

const USERS = { path: "/api/admin-users" };
const strongPassword = () => "Desk-" + crypto.randomBytes(15).toString("base64url");
const client = (workerIndex) => playwrightRequest.newContext({ baseURL: ADMIN, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) } });

// Roles made by the owner, each with one user who has replaced the temporary password. `people.make(label, fns)`
// → { email, password, ctx (their own signed-in API) }; `people.cleanUp()` puts everything back (after a failure too).
function people(api, workerIndex) {
  const made = [];
  return {
    async make(label, fns) {
      const role = (await api("saveRole", { name: label + " " + slug("r").slice(-6), rank: 20, permissions: { fns } }, USERS)).role;
      const entry = { role, user: null, ctx: null };
      made.push(entry);
      const tag = slug("lr");
      const email = tag + "@example.test";
      const u = await api("create", { name: label + " " + tag.slice(-4), email, role: role.key }, USERS);
      entry.user = u.user;
      const c = await client(workerIndex);
      let r = await c.post("/api/admin-session", { data: { email, key: u.temporaryPassword } });
      expect((await r.json()).pending).toBe("password");
      const password = strongPassword();
      r = await c.post("/api/admin-password", { data: { action: "change", current: u.temporaryPassword, next: password } });
      expect((await r.json()).status).toBe("ok");
      r = await c.post("/api/admin-session", { data: { email, key: password } });
      expect(r.status()).toBe(200);
      entry.ctx = c;
      return { email, password, ctx: c };
    },
    async cleanUp() {
      for (const { role, user, ctx } of made) {
        if (ctx) await ctx.dispose();
        if (user) {
          await api("setRole", { id: user.id, role: "production" }, { ...USERS, allowError: true });
          await api("setStatus", { id: user.id, status: "disabled" }, { ...USERS, allowError: true });
        }
        await api("deleteRole", { roleKey: role.key }, { ...USERS, allowError: true });
      }
      const keys = made.map(m => m.role.key);
      const left = (await api("listRoles", {}, USERS)).roles.filter(r => keys.includes(r.key));
      expect(left, "this test's roles are gone again").toEqual([]);
    },
  };
}

// Asks for a signed link to a private file (receipt or design endpoint): { status, url }.
const askLink = async (ctx, path, key) => {
  const res = await ctx.post(path, { data: { key } });
  const d = await res.json().catch(() => ({}));
  return { status: res.status(), url: d.url || null };
};
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n", "latin1");

test("Receipts: Read on Blanks with costs.view, Brand approvals or the Account viewer opens one; only Edit on expenses adds one", async ({ api }, testInfo) => {
  const P = people(api, testInfo.workerIndex);
  const owner = await apiContext("owner", testInfo.workerIndex);
  try {
    // The owner adds a receipt, as the expense form does.
    let res = await owner.post("/api/receipt?name=" + encodeURIComponent("blank-invoice.pdf"), { headers: { "Content-Type": "application/pdf" }, data: PDF });
    const up = await res.json();
    expect(res.ok(), JSON.stringify(up)).toBe(true);
    expect(up.key).toMatch(/^receipts\/\d{4}\/[a-z0-9]{32}\.pdf$/);

    // Blanks: Read there opens a vendor receipt only with costs.view (Read on Blanks alone is stock and details, no money).
    for (const [label, fns] of [["Blanks reader with costs", { "inventory.blanks": "read", "costs.view": "read" }], ["Approvals reader", { "catalog.brandApprovals": "read" }],
      ["Account reader", { "finance.accountviewer": "read" }]]) {
      const { ctx } = await P.make(label, fns);
      const link = await askLink(ctx, "/api/receipt", up.key);
      expect(link.status, label + " gets a link").toBe(200);
      const file = await ctx.get(link.url);
      expect(file.status(), label + " opens the receipt").toBe(200);
      expect(Buffer.compare(await file.body(), PDF), label + " gets the stored file").toBe(0);
      res = await ctx.post("/api/receipt?name=x.pdf", { headers: { "Content-Type": "application/pdf" }, data: PDF });
      expect(res.status(), label + " can't add a receipt").toBe(403);
    }
    const none = await P.make("Counts only", { "home.counts": "read" });
    expect((await askLink(none.ctx, "/api/receipt", up.key)).status, "a role with none of them gets no link").toBe(403);
    const blanksOnly = await P.make("Blanks reader", { "inventory.blanks": "read" });
    expect((await askLink(blanksOnly.ctx, "/api/receipt", up.key)).status, "Read on Blanks alone gets no link").toBe(403);
    const editor = await P.make("Expense editor", { "finance.expenses": "edit" });
    res = await editor.ctx.post("/api/receipt?name=y.pdf", { headers: { "Content-Type": "application/pdf" }, data: PDF });
    expect(res.status(), "Expenses Edit adds one").toBe(200);
  } finally {
    await owner.dispose();
    await P.cleanUp();
  }
});

test("Private files: each kind of file opens only for the roles that see it", async ({ page, api }, testInfo) => {
  const P = people(api, testInfo.workerIndex);
  const owner = await apiContext("owner", testInfo.workerIndex);
  try {
    const shop = await makeShop(api, { prefix: "lrf", products: [{ name: "Sample Tee", price: 20 }] });
    const order = await placeOrder(page, shop, { customer: uniq("Robin Photo") });
    const item = (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === order.orderId).items[0];
    // An order line's own file (what the Files window uploads; a customer's photo is stored the same way).
    const photo = pngBytes(64, 64, [200, 40, 40]);
    let res = await owner.post(`/api/design?itemId=${item.sheetRow}&ext=png&name=customer-photo.png`, { headers: { "Content-Type": "image/png" }, data: photo });
    const orderFile = await res.json();
    expect(res.ok(), JSON.stringify(orderFile)).toBe(true);
    expect(orderFile.key).toMatch(/^order-files\//);
    // A design version's machine file.
    const { id: designId } = await api("saveDesign", { org: shop.orgId, design: { name: uniq("Role Crest") } });
    res = await owner.post(`/api/design?designId=${designId}&role=machine&ext=dst&name=role-crest.dst`, { headers: { "Content-Type": "application/octet-stream" }, data: Buffer.alloc(600, 0x20) });
    const designFile = await res.json();
    expect(res.ok(), JSON.stringify(designFile)).toBe(true);
    // A digital product's file key (only the link is asked for here: who may be given one).
    const digitalKey = `digital/${shop.orgId}/sample-pattern/${"c".repeat(32)}.pdf`;

    const designs = await P.make("Design reader", { "catalog.designs": "read" });
    expect((await askLink(designs.ctx, "/api/design", designFile.key)).status, "Designs Read: a design's file").toBe(200);
    expect((await askLink(designs.ctx, "/api/design", orderFile.key)).status, "Designs Read: not an order's own file").toBe(403);
    expect((await askLink(designs.ctx, "/api/design", digitalKey)).status, "Designs Read: not a digital product's file").toBe(403);

    const orders = await P.make("Order reader", { "orders.details": "read" });
    const link = await askLink(orders.ctx, "/api/design", orderFile.key);
    expect(link.status, "Order details Read: the order's own file").toBe(200);
    const file = await orders.ctx.get(link.url);
    expect(file.status()).toBe(200);
    expect(Buffer.compare(await file.body(), photo), "…and it is the stored file").toBe(0);
    expect((await askLink(orders.ctx, "/api/design", designFile.key)).status, "Order details Read: a design's file (Run Order shows them)").toBe(200);
    expect((await askLink(orders.ctx, "/api/design", digitalKey)).status, "Order details Read: not a digital product's file").toBe(403);

    const productFiles = await P.make("Product files reader", { "catalog.productFiles": "read" });
    expect((await askLink(productFiles.ctx, "/api/design", digitalKey)).status, "Digital product files Read: a digital product's file").toBe(200);
    expect((await askLink(productFiles.ctx, "/api/design", orderFile.key)).status, "Digital product files Read: not an order's own file").toBe(403);
    expect((await askLink(productFiles.ctx, "/api/design", designFile.key)).status, "Digital product files Read: not a design's file").toBe(403);
  } finally {
    await owner.dispose();
    await P.cleanUp();
  }
});

test("Dates window: a role with only the early steps can't change when an order shipped, in the window or at the API", async ({ page, api, as }, testInfo) => {
  const P = people(api, testInfo.workerIndex);
  try {
    const shop = await makeShop(api, { prefix: "lrd", products: [{ name: "Sample Tee", price: 20 }] });
    const order = await placeOrder(page, shop, { customer: uniq("Dana Dates") });
    const early = await P.make("Early steps", { "orders.details": "edit", "orders.stepsEarly": "edit" });
    const datesOf = async () => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === order.orderId);

    // The API: the late half is refused (nothing written), the early half goes through.
    const shipAt = new Date().toISOString();
    let r = await callApi(early.ctx, "setOrderDates", { org: shop.orgId, orderId: order.orderId, dates: { shippedAt: shipAt } }, { allowError: true, withStatus: true });
    expect(r.status).toBe(403);
    expect(r.data.message).toBe("Your role can't set that step. Ask an admin.");
    expect((await datesOf()).shippedAt || "").toBe("");
    const blankAt = new Date().toISOString();
    r = await callApi(early.ctx, "setOrderDates", { org: shop.orgId, orderId: order.orderId, dates: { blankOrderedAt: blankAt } }, { allowError: true, withStatus: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect((await datesOf()).blankOrderedAt).toBe(blankAt);

    // The window: Blank ordered can change, Shipped is greyed out with no ✕.
    const ep = await as(null);
    await ep.goto(ADMIN + "/#orders/" + shop.orgId);
    await signInThroughPage(ep, early);
    await expect(ep.getByRole("navigation", { name: "Admin" })).toBeVisible();
    await openAdmin(ep, "orders/" + shop.orgId);
    await ep.locator(`tr[data-order="${order.orderId}"]`).first().getByRole("button", { name: "✎" }).first().click();   // the ✎ by the order date opens the Dates window
    await expect(ep.locator('.od-input[data-col="blankOrderedAt"]')).toBeEnabled();
    await expect(ep.locator('.od-input[data-col="shippedAt"]')).toBeDisabled();
    await expect(ep.locator('.od-clear[data-col="shippedAt"]')).toHaveCount(0);
    await expect(ep.locator('.od-input[data-col="deliveredAt"]')).toBeDisabled();
    await expect(ep.locator('.od-input[data-col="placedAt"]')).toBeEnabled();
    await ep.locator("#odCancel").click();

    // The owner's window: every step can change.
    await openAdmin(page, "orders/" + shop.orgId);
    await page.locator(`tr[data-order="${order.orderId}"]`).first().getByRole("button", { name: "✎" }).first().click();   // the ✎ by the order date opens the Dates window
    await expect(page.locator('.od-input[data-col="shippedAt"]')).toBeEnabled();
    await expect(page.locator('.od-input[data-col="blankOrderedAt"]')).toBeEnabled();
  } finally {
    await P.cleanUp();
  }
});
