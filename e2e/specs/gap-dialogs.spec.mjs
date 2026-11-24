// The admin's own dialogs, from the keyboard (coverage review, P30). Every window the admin opens is a real dialog
// (public/admin.js dialogize_): named by its title, focus starts on its first field, Tab and Shift+Tab go round
// inside it, Escape closes it and focus goes back to the button that opened it. Its yes / no question
// (confirmModal_) starts on Cancel when the answer would delete or remove something, so a stray Enter deletes
// nothing. A form that has been typed in asks "Discard changes?" before Escape throws the typing away
// (inventoryModal_ with guard). And removing a spool size, from a thread's stock or from the size list, asks first.
//
// Each test makes its own abort reason / thread / spool size with a unique name and reads only those back; they are
// on shared lists (other specs read them), so they are deleted again in `finally`. The hoop and New blank tests
// create nothing, and the New blank test checks that.
import { test, expect, openAdmin, uniq, slug, waitIdle } from "../fixtures.mjs";

// The page's /api/orders requests of one action, as they are sent (the action is in the JSON body).
function recordActions(page, action) {
  const sent = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || !/\/api\/orders(\?|$)/.test(req.url())) return;
    let body = null;
    try { body = JSON.parse(req.postData() || "null"); } catch (e) {}
    if (body && body.action === action) sent.push(body);
  });
  return sent;
}
const focusInside = (dlg) => dlg.evaluate((el) => el.contains(document.activeElement) && el !== document.activeElement);

test("+ New hoop opened with Enter: focus on Name, Tab and Shift+Tab stay inside, Escape closes it and focus goes back", async ({ page }) => {
  await openAdmin(page, "hoops");
  const newBtn = page.getByRole("button", { name: "+ New hoop" });
  await newBtn.focus();
  await page.keyboard.press("Enter");

  const dlg = page.getByRole("dialog", { name: "New hoop" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute("aria-modal", "true");
  await expect(dlg.getByLabel("Name")).toBeFocused();

  // Tab all the way round (more presses than the window has controls): focus never leaves it.
  const last = dlg.getByRole("button", { name: "Create hoop" });
  const first = dlg.getByRole("button", { name: "Close" });
  let sawLast = false, sawFirst = false;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await focusInside(dlg), `focus inside the dialog after Tab ${i + 1}`).toBe(true);
    if (await last.evaluate((el) => el === document.activeElement)) sawLast = true;
    else if (sawLast && await first.evaluate((el) => el === document.activeElement)) sawFirst = true;
  }
  expect(sawLast && sawFirst, "Tab went past Create hoop and round to the window's first control").toBe(true);

  // From the first control, Shift+Tab goes round to the last; Shift+Tab onward stays inside too.
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await focusInside(dlg), `focus inside the dialog after Shift+Tab ${i + 1}`).toBe(true);
  }

  // Nothing was typed, so Escape closes it at once, and focus is back on the button that opened it.
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(newBtn).toBeFocused();
});

test("an abort reason's Delete question starts on Cancel: Enter deletes nothing", async ({ page, api }) => {
  const label = uniq("Hoop slipped");
  await api("saveAbortReason", { reason: { label, sortOrder: 90 } });
  const mine = async () => (await api("listAbortReasons")).reasons.filter((r) => r.label === label);
  try {
    expect((await mine()).length, "the reason was made").toBe(1);
    const deletes = recordActions(page, "deleteAbortReason");
    await openAdmin(page, "abortreasons");
    const row = page.getByRole("row", { name: new RegExp(label) });
    const del = row.getByRole("button", { name: "Delete" });
    await del.click();

    const ask = page.getByRole("dialog", { name: `Delete "${label}"?` });
    await expect(ask).toBeVisible();
    await expect(ask.locator("#cmCancel")).toBeFocused();
    await expect(ask.locator("#cmCancel")).toHaveText("Cancel");
    await expect(ask.locator("#cmOk")).toHaveText("Delete");

    await page.keyboard.press("Enter");
    await expect(ask).toHaveCount(0);
    await expect(del, "focus back on the Delete that asked").toBeFocused();
    await waitIdle(page);
    expect(deletes, "no deleteAbortReason request").toEqual([]);
    await expect(row).toBeVisible();
    expect((await mine()).length, "the reason is still on the list").toBe(1);
  } finally {
    for (const r of await mine()) await api("deleteAbortReason", { id: r.id });
  }
});

test("New blank: after typing, Escape asks \"Discard changes?\"; Keep editing keeps the text, Discard creates nothing", async ({ page, api }) => {
  const name = uniq("Dialog Test Tee");
  const creates = recordActions(page, "createBlank");
  await openAdmin(page, "inventory");
  await page.getByRole("button", { name: "+ New blank" }).click();
  const dlg = page.getByRole("dialog", { name: "New blank" });
  await expect(dlg).toBeVisible();
  const nameBox = dlg.getByRole("textbox", { name: /^Name/ });
  await nameBox.fill(name);

  // Escape asks first, on top of the form; the question starts on Keep editing.
  await page.keyboard.press("Escape");
  const ask = page.getByRole("dialog", { name: "Discard changes?" });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("What you typed in this window hasn't been saved.");
  await expect(ask.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await ask.getByRole("button", { name: "Keep editing" }).click();
  await expect(ask).toHaveCount(0);
  await expect(dlg).toBeVisible();
  await expect(nameBox).toHaveValue(name);
  await expect(nameBox, "focus back in the form, where it was").toBeFocused();

  // Escape again, and Discard: both windows close and no blank was made.
  await page.keyboard.press("Escape");
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Discard" }).click();
  await expect(ask).toHaveCount(0);
  await expect(dlg).toHaveCount(0);
  await waitIdle(page);
  expect(creates, "no createBlank request").toEqual([]);
  const blanks = (await api("getBlanks")).blanks || [];
  expect(blanks.filter((b) => b.name === name), "no blank with the typed name").toEqual([]);
});

test("removing a spool size asks first: Cancel keeps it, in the thread's stock (count 3) and in the size list", async ({ page, api }) => {
  const code = "DLG" + slug("t").slice(-7).toUpperCase();
  const threadName = uniq("Dialog Teal");
  const sizeName = uniq("Dialog cone");
  let threadId = null, sizeId = null;
  try {
    await api("saveThread", { thread: { brand: "Test Thread Co", code, type: "Poly", weight: "40", name: threadName, colorHex: "11806a" } });
    threadId = (await api("listThreads")).threads.find((t) => t.code === code).id;
    sizeId = (await api("saveSpoolSize", { spoolSize: { description: sizeName, meters: 4000 } })).id;
    await api("saveThreadInventory", { item: { threadId, spoolSizeId: sizeId, quantity: 3 } });
    const stock = async () => ((await api("listThreads")).threads.find((t) => t.id === threadId).inventory || []);
    expect((await stock()).map((it) => Number(it.quantity))).toEqual([3]);

    const removes = recordActions(page, "deleteThreadInventory");
    const sizeDeletes = recordActions(page, "deleteSpoolSize");
    await openAdmin(page, "threads");
    await page.getByRole("searchbox", { name: "Search brand, code, name…" }).fill(code);
    await page.getByRole("row", { name: new RegExp(code) }).getByRole("button", { name: "Inventory" }).click();
    const inv = page.getByRole("dialog", { name: new RegExp("^Inventory — Test Thread Co " + code) });
    await expect(inv.locator(".tiQty")).toHaveValue("3");

    // Remove asks first, and starts on Cancel; Cancel keeps the count.
    await inv.getByRole("button", { name: "Remove" }).click();
    const ask = page.getByRole("dialog", { name: "Remove this spool size from the thread's inventory?" });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("Its count on hand goes with it.");
    await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(ask).toHaveCount(0);
    await expect(inv).toBeVisible();
    await expect(inv.locator(".tiQty")).toHaveValue("3");
    await inv.getByRole("button", { name: "Done" }).click();
    await expect(inv).toHaveCount(0);

    // The shared size list: Delete asks first too, and Cancel keeps the size.
    await page.getByRole("button", { name: "Manage spool sizes…" }).click();
    const sizes = page.getByRole("dialog", { name: "Spool sizes" });
    const sizeRow = sizes.getByRole("row", { name: new RegExp(sizeName) });
    await sizeRow.getByRole("button", { name: "Delete" }).click();
    const askSize = page.getByRole("dialog", { name: "Delete this spool size?" });
    await expect(askSize).toBeVisible();
    await expect(askSize.getByRole("button", { name: "Cancel" })).toBeFocused();
    await askSize.getByRole("button", { name: "Cancel" }).click();
    await expect(askSize).toHaveCount(0);
    await expect(sizeRow).toBeVisible();
    await sizes.getByRole("button", { name: "Done" }).click();

    await waitIdle(page);
    expect(removes, "no deleteThreadInventory request").toEqual([]);
    expect(sizeDeletes, "no deleteSpoolSize request").toEqual([]);
    expect((await stock()).map((it) => [it.spoolSizeId, Number(it.quantity)])).toEqual([[sizeId, 3]]);
    expect((await api("listSpoolSizes")).spoolSizes.some((s) => s.id === sizeId), "the size is still listed").toBe(true);
  } finally {
    if (threadId) {
      const t = (await api("listThreads")).threads.find((x) => x.id === threadId);
      for (const it of (t && t.inventory) || []) await api("deleteThreadInventory", { id: it.id });
      await api("deleteThread", { id: threadId });
    }
    if (sizeId) await api("deleteSpoolSize", { id: sizeId });
  }
});
