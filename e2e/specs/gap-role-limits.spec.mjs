// Back office and Production: the limits on money and stock (functions/_lib/permissions.js, the built-in roles).
//   - Back office (staff) has Edit on order details and payments, not Full: Edit items takes no line off and
//     records no refund (orders.js editOrder), and every line an edit names must be that order's.
//   - Back office has Edit on Blanks, not Full: the blank form can't change what is on hand or its average cost
//     (updateBlank keepStock), and merging blanks, removing a product's blank link and correcting a finished-stock
//     count are Full only (mergeBlanks, deleteBlankLink / saveBlankLinks removals, setReadyToShipQty).
//   - Production has Edit on Shipping but nothing on Payments: setShippingInfo saves the address and the weight,
//     never a new shipping charge or a ship-to state that moves the sales tax.
// Each refusal is checked in the page (the field read-only, the button not there) where the page offers one, at
// the API (403), and then through the owner's API: nothing the refused request carried was written.
// Every test makes its own shop, orders, blanks and products with unique names; nothing install-wide changes.
import { test, expect, openAdmin, uniq, ADMIN, apiContext, callApi } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
// The shop's Orders page, always a fresh load (as orders.spec opens it).
const ordersPage = async (page, shop) => {
  const target = ADMIN + "/#orders/" + shop.orgId;
  if (page.url() === target) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");

// A shop with a Tee ($20) and a Cap ($15), and one order placed on its page with one of each ($35).
const shopWithOrder = async (api, page) => {
  const shop = await makeShop(api, { prefix: "lim", products: [{ name: "Sample Tee", price: 20 }, { name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap" }] });
  const order = await placeOrder(page, shop, { customer: uniq("Casey Customer"), items: [{ name: "Sample Tee", qty: 1 }, { name: "Sample Cap", qty: 1 }] });
  return { shop, order };
};

// A request the server must refuse: { status, data } instead of throwing.
const tryApi = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });

// The owner's view of one order (getOrders on its shop), cut down to what an edit or a shipping save could change.
const orderState = async (api, shop, orderId) => {
  const o = (await api("getOrders", { org: shop.orgId })).orders.find(x => x.orderId === orderId);
  expect(o, "order " + orderId + " in its shop's list").toBeTruthy();
  return {
    total: o.total, balanceDue: o.balanceDue, netReceived: o.netReceived,
    items: o.items.map(i => ({ sheetRow: i.sheetRow, name: i.name, qty: i.qty, lineTotal: i.lineTotal, cancelDate: i.cancelDate, refundAmount: i.refundAmount })),
  };
};
const fullOrder = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(x => x.orderId === orderId);

// A blank made through the owner's API: one color (Navy) with the sizes given ({ size: quantity }), each at $4.50.
const makeBlank = async (api, name, sizes) => {
  const r = await api("createBlank", {
    name, productType: "shirt", vendor: "", brand: "Test Blank Co", sku: "", notes: "", color: "Navy",
    colors: [{ color: "Navy", images: [], sizes: Object.entries(sizes).map(([size, quantity]) => ({ size, quantity, vendorPrice: 4.5 })) }],
  });
  return r.id;
};
// The owner's view of a blank (getBlanks): name and each size's count, average cost and reorder point. null = gone.
const blankState = async (api, id) => {
  const b = (await api("getBlanks", {})).blanks.find(x => x.id === id);
  if (!b) return null;
  const sizes = {};
  for (const c of b.colors || []) for (const s of c.sizes || []) sizes[(c.color || "") + "/" + s.size] = { quantity: s.quantity, purchasePrice: s.purchasePrice, reorderPoint: s.reorderPoint ?? null };
  return { name: b.name, sizes };
};

// ---- P4 · Edit items for Back office -------------------------------------------------------------------
test("Back office: Edit items offers no Remove on the order's lines, and a bigger quantity still saves", async ({ page, api, as }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  expect(order.total).toBe("35.00");
  const staff = await as("staff");
  await ordersPage(staff, shop);
  await actionCell(staff, id).getByRole("button", { name: "Edit items" }).click();
  const rows = staff.locator("#editOrderRows tr");
  await expect(rows).toHaveCount(2);
  // Taking a saved line off is a cancellation (Full on order details): no Remove on either line.
  await expect(staff.locator("#editOrderRows").getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(staff.locator("#editOrderRows [data-edit-action=remove]")).toHaveCount(0);
  // A line added here can always be taken off again (it stays in the window, marked with Undo, and isn't sent).
  await staff.locator("#editOrderAddRow").click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2).getByRole("button", { name: "Remove" })).toBeVisible();
  await rows.nth(2).getByRole("button", { name: "Remove" }).click();
  await expect(rows.nth(2).getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(staff.locator("#editOrderRows").getByRole("button", { name: "Remove" })).toHaveCount(0);

  // The Tee's line (the rows follow the order's lines; found by the product picked in it).
  let teeRow = null;
  for (let i = 0; i < 2; i++) {
    if (await rows.nth(i).locator("select[data-field=productId]").inputValue() === shop.products[0].productId) teeRow = rows.nth(i);
  }
  expect(teeRow, "the Sample Tee line in Edit items").toBeTruthy();
  await teeRow.locator("input[data-field=qty]").fill("2");
  await teeRow.locator("input[data-field=qty]").press("Tab");
  await expect(staff.locator("#editOrderNewTotal")).toHaveText("$55.00");
  await staff.locator("#editOrderSave").click();
  await expect(staff.locator("#editOrderSave")).toHaveCount(0);
  await expect(orderRow(staff, id).locator("td[data-balance-td]")).toHaveText("$55.00");

  // The server has it: the Tee at 2, the Cap untouched, and no third line.
  const after = await orderState(api, shop, id);
  expect(after.total).toBe(55);
  expect(after.items).toHaveLength(2);
  expect(after.items.find(i => i.name === "Sample Tee").qty).toBe(2);
  const cap = after.items.find(i => i.name === "Sample Cap");
  expect(cap.qty).toBe(1);
  expect(cap.cancelDate).toBe("");
});

test("Back office can't remove or refund a line through editOrder, and no edit may name another order's line", async ({ page, api }, testInfo) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  const other = await placeOrder(page, shop, { customer: uniq("Other Customer") });
  // Paid, so a refund on a removed line would have money to come out of.
  await api("markPaidManual", { org: shop.orgId, orderId: id, requestId: uniq("pay").replace(/\W/g, "") });
  const before = await orderState(api, shop, id);
  const otherBefore = await orderState(api, shop, other.orderId);
  expect(before.balanceDue).toBe(0);
  const tee = before.items.find(i => i.name === "Sample Tee"), cap = before.items.find(i => i.name === "Sample Cap");
  const teeUpdate = (qty) => ({ itemId: tee.sheetRow, productId: shop.products[0].productId, size: "", qty, personalized: false });

  const staff = await apiContext("staff", testInfo.workerIndex);
  try {
    // Taking the Cap off.
    let r = await tryApi(staff, "editOrder", { orderId: id, removals: [{ itemId: cap.sheetRow, reason: "Back office try" }] });
    expect(r.status).toBe(403);
    expect(r.data.message).toMatch(/can't remove items/);
    // Taking it off with a cash refund (refunds are Full on Payments, which Back office hasn't either).
    r = await tryApi(staff, "editOrder", { orderId: id, removals: [{ itemId: cap.sheetRow, reason: "Back office try", refundAmount: 15, refundMethod: "cash" }] });
    expect(r.status).toBe(403);
    expect(r.data.message).toMatch(/can't remove items|can't record refunds/);
    // A removal refuses the whole edit: the Tee's change that came with it isn't saved either.
    r = await tryApi(staff, "editOrder", { orderId: id, updates: [teeUpdate(3)], removals: [{ itemId: cap.sheetRow, reason: "Back office try" }] });
    expect(r.status).toBe(403);
  } finally {
    await staff.dispose();
  }
  expect(await orderState(api, shop, id)).toEqual(before);

  // Even the owner can't name a line of another order (X's only line, on this order's edit)…
  const xLine = otherBefore.items[0];
  let r = await api("editOrder", { orderId: id, updates: [{ itemId: xLine.sheetRow, productId: shop.products[0].productId, size: "", qty: 5, personalized: false }] }, { allowError: true, withStatus: true });
  expect(r.status).toBe(400);
  expect(r.data.message).toMatch(/isn't on this order/);
  r = await api("editOrder", { orderId: id, removals: [{ itemId: xLine.sheetRow, reason: "Not this order's" }] }, { allowError: true, withStatus: true });
  expect(r.status).toBe(400);
  expect(r.data.message).toMatch(/isn't on this order/);
  // …and a line that can't be priced (a product that doesn't exist) stops the whole edit, the Tee's change too.
  r = await api("editOrder", { orderId: id, updates: [teeUpdate(3)], additions: [{ productId: "no-such-product-e2e", size: "", qty: 1, personalized: false }] }, { allowError: true, withStatus: true });
  expect(r.status).toBe(400);
  expect(r.data.message).toMatch(/not available/i);
  // Both orders are as they were.
  expect(await orderState(api, shop, id)).toEqual(before);
  expect(await orderState(api, shop, other.orderId)).toEqual(otherBefore);
});

// ---- P6 · Production and the shipping charge -------------------------------------------------------------
test("Production saves a shipping address and weight, but not a shipping charge or a new ship-to state", async ({ page, api }, testInfo) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  // A paid order with an address, as orders.spec's Ship test sets it up: no shipping charge, shipped to CA.
  await api("markPaidManual", { org: shop.orgId, orderId: id, requestId: uniq("pay").replace(/\W/g, "") });
  const addr = (over = {}) => ({ name: "Casey Customer", line1: "1 Example Way", line2: "", city: "Sampletown", state: "CA", zip: "90001", country: "US", ...over });
  await api("setShippingInfo", { org: shop.orgId, orderId: id, totalWeightOz: 8, shippingCost: 0, shippingMethod: "", shippingAddress: addr() });
  const before = await fullOrder(api, shop, id);

  const prod = await apiContext("production", testInfo.workerIndex);
  try {
    // The label details are Shipping's: a new street and weight save.
    const ok = await callApi(prod, "setShippingInfo", { org: shop.orgId, orderId: id, totalWeightOz: 10, shippingCost: 0, shippingMethod: "",
      shippingAddress: addr({ line1: "2 Example Way" }) });
    expect(ok.status).toBe("ok");
    // A shipping charge is what the customer pays: Payments'.
    let r = await tryApi(prod, "setShippingInfo", { org: shop.orgId, orderId: id, totalWeightOz: 12, shippingCost: 7.5, shippingMethod: "",
      shippingAddress: addr({ line1: "3 Example Way" }) });
    expect(r.status).toBe(403);
    expect(r.data.message).toMatch(/can't change what the customer pays/);
    // So is a state that moves the sales tax (a New York address, with a New York ZIP so the address itself is valid).
    r = await tryApi(prod, "setShippingInfo", { org: shop.orgId, orderId: id, totalWeightOz: 12, shippingCost: 0, shippingMethod: "",
      shippingAddress: addr({ line1: "4 Example Way", city: "Sampleville", state: "NY", zip: "10001" }) });
    expect(r.status).toBe(403);
    expect(r.data.message).toMatch(/sales tax/);
  } finally {
    await prod.dispose();
  }
  // The owner sees the saved street and weight, still $0 shipping to CA, and the same totals.
  const after = await fullOrder(api, shop, id);
  expect(after.shippingAddress.line1).toBe("2 Example Way");
  expect(after.shippingAddress.state).toBe("CA");
  expect(after.shippingAddress.zip).toBe("90001");
  expect(after.totalWeightOz).toBe(10);
  expect(after.shippingCost).toBe(0);
  expect(after.total).toBe(before.total);
  expect(after.balanceDue).toBe(before.balanceDue);
});

// ---- P5 · Blank stock, cost, merges, links and finished-stock counts are Full only -------------------------
test("Back office: the blank's Edit window keeps counts read-only and offers no Merge…, and the server refuses a count or cost change", async ({ api, as }, testInfo) => {
  const BLANK = uniq("Limits Tee Blank");
  const blankId = await makeBlank(api, BLANK, { M: 6, L: 0 });
  const start = await blankState(api, blankId);
  expect(start.sizes["Navy/M"]).toMatchObject({ quantity: 6, purchasePrice: 4.5 });

  const staff = await as("staff");
  await openAdmin(staff, "inventory");
  await staff.getByRole("searchbox", { name: /Search name, vendor/ }).fill(BLANK);
  const row = staff.getByRole("row", { name: new RegExp(BLANK) });
  await expect(row).toContainText("M: 6");
  // More: Clone (Edit) is there; Merge…, Write off… and Delete… (Full) are not.
  await row.getByRole("button", { name: "More for " + BLANK }).click();
  await expect(staff.getByRole("menuitem", { name: "Clone" })).toBeVisible();
  for (const name of ["Merge…", "Write off…", "Delete…"]) await expect(staff.getByRole("menuitem", { name })).toHaveCount(0);
  await staff.keyboard.press("Escape");

  // The Edit window: the on-hand counts are read-only; the reorder point can be changed and saved.
  await row.getByRole("button", { name: "Edit" }).click();
  const dlg = staff.getByRole("dialog", { name: "Edit blank" });
  const sizeRow = (size) => dlg.locator(`tr:has([data-sf=size][value="${size}"])`);
  await expect(sizeRow("M").locator("[data-sf=quantity]")).toBeDisabled();
  await expect(sizeRow("L").locator("[data-sf=quantity]")).toBeDisabled();
  await sizeRow("M").getByRole("spinbutton", { name: "Keep at least" }).fill("5");
  const saved = staff.waitForRequest((req) => req.method() === "POST" && /\/api\/orders(\?|$)/.test(req.url()) && /"action":"updateBlank"/.test(req.postData() || ""));
  await dlg.getByRole("button", { name: "Save changes" }).click();
  const sent = JSON.parse((await saved).postData());
  await expect(dlg).toHaveCount(0);
  await expect(row).toContainText("M: 6");
  const afterSave = await blankState(api, blankId);
  expect(afterSave.sizes["Navy/M"]).toEqual({ ...start.sizes["Navy/M"], reorderPoint: 5 });

  // The same save sent again by Back office, changed the ways the form doesn't allow: each refused whole.
  const replay = (edit) => {
    const body = JSON.parse(JSON.stringify(sent));
    delete body.action; delete body.key;   // the cookie is the credential
    body.name = BLANK + " renamed";       // a rename riding along must not be written either
    edit(body.colors.find(c => c.color === "Navy").sizes);
    return body;
  };
  const ctx = await apiContext("staff", testInfo.workerIndex);
  try {
    const tries = {
      "M counted at 99": (sizes) => { sizes.find(s => s.size === "M").quantity = 99; },
      "M's cost at $9.99": (sizes) => { sizes.find(s => s.size === "M").purchasePrice = 9.99; },
      "size M taken off (its 6 with it)": (sizes) => { sizes.splice(sizes.findIndex(s => s.size === "M"), 1); },
    };
    for (const [what, edit] of Object.entries(tries)) {
      const r = await tryApi(ctx, "updateBlank", replay(edit));
      expect(r.status, what).toBe(403);
      expect(r.data.message, what).toMatch(/can't change stock counts or costs/);
    }
  } finally {
    await ctx.dispose();
  }
  expect(await blankState(api, blankId)).toEqual(afterSave);
  await openAdmin(staff, "inventory");
  await staff.getByRole("searchbox", { name: /Search name, vendor/ }).fill(BLANK);
  await expect(staff.getByRole("row", { name: new RegExp(BLANK) })).toContainText("M: 6");

  // Count stock… opens to compare (Edit), but a difference found there can't be settled without Full: the row shows
  // −2 with no Correct count and no Write off….
  await staff.getByRole("button", { name: "Count stock…" }).click();
  const cd = staff.getByRole("dialog", { name: "Count stock — blanks" });
  await cd.getByRole("searchbox", { name: "Search" }).fill(BLANK);
  const crow = cd.getByRole("row", { name: /^Navy · M 6/ });
  await crow.getByRole("spinbutton", { name: "Counted" }).fill("4");
  await expect(crow).toContainText("−2");
  await expect(crow.getByRole("button", { name: "History" })).toBeVisible();
  for (const name of ["Correct count", "Write off…"]) await expect(crow.getByRole("button", { name })).toHaveCount(0);
  await cd.getByRole("button", { name: "Close" }).last().click();
  expect(await blankState(api, blankId)).toEqual(afterSave);
});

test("Back office can't merge blanks or take a product's blank link away; moving the link to another blank is allowed", async ({ api }, testInfo) => {
  const a = uniq("Limits Merge Blank A"), b = uniq("Limits Merge Blank B");
  const idA = await makeBlank(api, a, { M: 2 }), idB = await makeBlank(api, b, { M: 3 });
  const shop = await makeShop(api, { prefix: "limlink", products: [{ name: "Linked Tee", price: 20 }] });
  const productId = shop.products[0].productId;
  await api("setBlankLink", { org: shop.orgId, productId, productColor: "", productSize: "", blankId: idA, blankColor: "Navy", blankSize: "M" });
  const linkOf = async () => (await api("getBlankLinks", { org: shop.orgId })).links.filter(l => l.productId === productId);
  expect((await linkOf()).map(l => l.blankId)).toEqual([idA]);
  const aBefore = await blankState(api, idA), bBefore = await blankState(api, idB);

  const staff = await apiContext("staff", testInfo.workerIndex);
  try {
    // Merging deletes the blanks merged in: Full.
    const m = await tryApi(staff, "mergeBlanks", { targetId: idA, sourceIds: [idB] });
    expect(m.status).toBe(403);
    expect(await blankState(api, idA)).toEqual(aBefore);
    expect(await blankState(api, idB)).toEqual(bBefore);

    // Moving the link to another blank is Edit…
    const moved = await callApi(staff, "saveBlankLinks", { org: shop.orgId, productId, set: [{ productColor: "", productSize: "", blankId: idB, blankColor: "Navy", blankSize: "M" }], remove: [] });
    expect(moved.status).toBe("ok");
    expect((await linkOf()).map(l => l.blankId)).toEqual([idB]);
    // …taking it away (None) is a deletion: refused both ways the page could ask.
    const d = await tryApi(staff, "deleteBlankLink", { org: shop.orgId, productId, productColor: "", productSize: "" });
    expect(d.status).toBe(403);
    const s = await tryApi(staff, "saveBlankLinks", { org: shop.orgId, productId, set: [], remove: [{ productColor: "", productSize: "" }] });
    expect(s.status).toBe(403);
    expect(s.data.message).toMatch(/Full access to Blanks/);
  } finally {
    await staff.dispose();
  }
  const links = await linkOf();
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({ blankId: idB, blankColor: "Navy", blankSize: "M" });
});

test("Back office sees a product's finished stock but can't correct its count", async ({ api, as }, testInfo) => {
  const shop = await makeShop(api, { prefix: "limstock", products: [{ name: "Limits Stock Tee", price: 22 }] });
  const productId = shop.products[0].productId;
  // The owner counts 3 on hand.
  await api("setReadyToShipQty", { org: shop.orgId, productId, size: "", quantity: 3 });
  const onHand = async () => {
    const f = (await api("getReadyToShip", { org: shop.orgId, productId })).finished;
    return (f.sizes || []).filter(r => (r.size || "") === "").map(r => r.onHand);
  };
  expect(await onHand()).toEqual([3]);

  const staff = await as("staff");
  await openAdmin(staff, "catalog/orgs/" + shop.orgId + "/products");
  await staff.getByTitle("Finished stock: pieces already decorated for this shop").first().click();
  const dlg = staff.getByRole("dialog", { name: "Finished stock — Limits Stock Tee" });
  const count = dlg.getByRole("spinbutton", { name: /^Counted on hand/ });
  await expect(count).toHaveValue("3");
  await expect(count).toBeDisabled();
  await expect(dlg.getByRole("button", { name: "Correct count" })).toHaveCount(0);

  const ctx = await apiContext("staff", testInfo.workerIndex);
  try {
    const r = await tryApi(ctx, "setReadyToShipQty", { org: shop.orgId, productId, size: "", quantity: 10 });
    expect(r.status).toBe(403);
  } finally {
    await ctx.dispose();
  }
  expect(await onHand()).toEqual([3]);
});
