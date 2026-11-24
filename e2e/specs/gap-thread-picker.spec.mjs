// The searchable thread picker (threadPicker_ in public/admin.js, PR #54) where production.spec doesn't reach it:
//   - Edit colours on a design version: the list narrows over the threads the page already holds, with no request
//     to the server; Escape closes only the list (not the window it sits in) and keeps the thread that was picked;
//     Enter picks, Save colors saves, and the design's thread map shows the new thread.
//   - A machine's needle whose save fails (setMachineNeedle answers 500): the error toast, and the box goes back to
//     the thread the server still has — after a reload too.
//   - A role with Read only on Machines (Production): the needle box is disabled and still shows its thread.
// The threads, the shop's design and the machines are this file's own (unique codes and names), made through the
// owner's API, and deleted again in afterAll.
import { test, expect, openAdmin, toast, uniq, slug, apiContext, callApi } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

test.describe.configure({ mode: "serial" });

const TAG = slug("tp").slice(-6).toUpperCase();
const BRAND = "Picker Test Co";
const THREADS = [
  { code: "TP" + TAG + "1", name: "Harbor Navy", colorHex: "1f2a55" },
  { code: "TP" + TAG + "2", name: "Signal Red", colorHex: "c8202f" },
  { code: "TP" + TAG + "3", name: "Meadow Green", colorHex: "2f8f3a" },
];
const DESIGN = uniq("Picker Crest");
const MACHINE_FAIL = uniq("Picker Machine");
const MACHINE_READ = uniq("Picker Machine");
const made = { shop: null, designId: null, machines: {} };

// A small, valid Tajima .dst: two colour blocks of three stitches each (two needle stops), as in production.spec.
function dstFile() {
  const header = Buffer.alloc(512, 0x20);
  header.write("LA:E2EPICK\r", 0, "latin1");
  const stitch = [0x01, 0x01, 0x03], colorChange = [0x00, 0x00, 0xc3], end = [0x00, 0x00, 0xf3];
  return Buffer.concat([header, Buffer.from([stitch, stitch, stitch, colorChange, stitch, stitch, stitch, end].flat())]);
}

// The picker's text for a thread (threadPickLabel_): "Brand Type Weight CODE — Name".
const label = (t) => new RegExp("^" + BRAND + " Poly 40 " + t.code + " — " + t.name + "$");
const machineCard = (page, name) => page.locator("#mchBody > div").filter({ hasText: name });

test.beforeAll(async ({}, testInfo) => {
  const ctx = await apiContext("owner", testInfo.workerIndex);
  const api = (action, body, opts) => callApi(ctx, action, body, opts);
  try {
    for (const t of THREADS) {
      t.id = (await api("saveThread", { thread: { brand: BRAND, code: t.code, type: "Poly", weight: "40", name: t.name, colorHex: t.colorHex } })).id;
    }
    // A shop design with one version: the .dst uploaded as the page uploads it, needles 1 and 2 on threads 1 and 2.
    made.shop = await makeShop(api, { prefix: "tpk", products: [{ name: "Picker Cap", price: 18, type: "cap", idPrefix: "cap" }] });
    made.designId = (await api("saveDesign", { org: made.shop.orgId, design: { name: DESIGN } })).id;
    const res = await ctx.post(`/api/design?designId=${made.designId}&role=machine&ext=dst&name=picker-crest.dst`, {
      headers: { "Content-Type": "application/octet-stream" }, data: dstFile() });
    const up = await res.json();
    expect(up.status, "machine file upload: " + JSON.stringify(up)).toBe("ok");
    await api("saveDesignVersion", { designId: made.designId, machineFileKey: up.key, machineFileName: up.name, machineFileExt: up.ext,
      designFileKey: "", designFileName: "", designFileExt: "", notes: "", stitchCount: 6,
      threadColors: [{ needle: 1, threadId: THREADS[0].id }, { needle: 2, threadId: THREADS[1].id }] });
    // Two machines, each with needle 1 on thread 1.
    for (const name of [MACHINE_FAIL, MACHINE_READ]) {
      const id = (await api("saveMachine", { machine: { name, needleCount: 2 } })).id;
      await api("setMachineNeedle", { machineId: id, needle: 1, threadId: THREADS[0].id });
      made.machines[name] = id;
    }
  } finally { await ctx.dispose(); }
});

test.afterAll(async ({}, testInfo) => {
  const ctx = await apiContext("owner", testInfo.workerIndex);
  const api = (action, body) => callApi(ctx, action, body, { allowError: true });
  try {
    for (const id of Object.values(made.machines)) await api("deleteMachine", { id });
    if (made.designId) await api("deleteDesign", { id: made.designId });
    for (const t of THREADS) if (t.id) await api("deleteThread", { id: t.id });
  } finally { await ctx.dispose(); }
});

test("Edit colours: searching sends nothing, Escape keeps the window and the thread, Enter picks and Save saves", async ({ page, api }) => {
  await openAdmin(page, "designs/" + made.shop.orgId + "/" + made.designId);
  const detail = page.locator("#dsgDetail");
  await expect(detail.locator("#dsgThreadMap")).toContainText(THREADS[0].code);
  await detail.getByRole("button", { name: "Edit colors" }).click();
  const dlg = page.getByRole("dialog", { name: /^Edit thread colors/ });
  await expect(dlg).toBeVisible();
  // The window redraws its rows once it has read the machine file; wait for that before using a box.
  await expect(dlg.locator("#dsgcInfo")).toContainText("2 needle stops");
  const box = dlg.getByRole("combobox", { name: "Colour 1 thread" });
  await expect(box).toHaveValue(label(THREADS[0]));
  const list = page.locator("#" + (await box.getAttribute("aria-controls")));

  // Typing narrows the list from what the page holds: not one request leaves the page.
  const sent = [];
  const record = (r) => sent.push(r.method() + " " + r.url());
  page.on("request", record);
  await box.click();
  await expect(list).toBeVisible();
  await box.pressSequentially(THREADS[2].code);
  await expect(list.getByRole("option")).toHaveCount(2);   // "— pick a thread —" and the one match
  await expect(list.getByRole("option").nth(1)).toContainText(THREADS[2].name);
  page.off("request", record);
  expect(sent, "requests sent while typing in the thread box").toEqual([]);

  // Escape closes the list only: the window stays open and the box shows the thread it had.
  await box.press("Escape");
  await expect(list).toBeHidden();
  await expect(dlg).toBeVisible();
  await expect(box).toHaveValue(label(THREADS[0]));

  // Enter picks the highlighted match; Save colors saves it.
  await box.click();
  await box.fill(THREADS[2].code);
  await expect(list.getByRole("option")).toHaveCount(2);
  await box.press("Enter");
  await expect(list).toBeHidden();
  await expect(dlg.getByRole("combobox", { name: "Colour 1 thread" })).toHaveValue(label(THREADS[2]));
  await dlg.getByRole("button", { name: "Save colors" }).click();
  await expect(toast(page)).toContainText("Thread colors updated.");
  await expect(dlg).toHaveCount(0);
  const map = detail.locator("#dsgThreadMap");
  await expect(map).toContainText("1. " + BRAND);
  await expect(map).toContainText(THREADS[2].code);
  await expect(map).not.toContainText(THREADS[0].code);
  await expect(map).toContainText(THREADS[1].code);   // needle 2 untouched

  // Saved on the server: needle 1 is thread 3, needle 2 still thread 2.
  const { versions } = await api("getDesign", { id: made.designId });
  expect(versions).toHaveLength(1);
  const v = versions[0];
  const byNeedle = Object.fromEntries(v.threadColors.map(tc => [tc.needle, tc.threadId]));
  expect(byNeedle).toEqual({ 1: THREADS[2].id, 2: THREADS[1].id });
});

test("a needle save that fails puts the box back to the thread the server still has", async ({ page, api }) => {
  // Every setMachineNeedle answers 500; everything else goes through.
  await page.route("**/api/orders", async (route) => {
    let action = null;
    try { action = JSON.parse(route.request().postData() || "{}").action; } catch (e) {}
    if (action === "setMachineNeedle") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ status: "error", message: "Simulated server error" }) });
    else await route.continue();
  });
  await openAdmin(page, "machines");
  const card = machineCard(page, MACHINE_FAIL);
  await expect(card).toHaveCount(1);
  const n1 = card.getByRole("combobox", { name: "Needle 1 thread" });
  await expect(n1).toHaveValue(label(THREADS[0]));

  await n1.click();
  await n1.fill(THREADS[1].code);
  await n1.press("Enter");
  await expect(toast(page)).toContainText("Not saved: Simulated server error");
  await expect(n1).toHaveValue(label(THREADS[0]));
  await expect(card.locator('select[data-needle="1"]')).toHaveValue(String(THREADS[0].id));

  // A fresh page (and the server) still have thread 1 on needle 1.
  await page.unroute("**/api/orders");
  await openAdmin(page, "machines");
  await expect(machineCard(page, MACHINE_FAIL).getByRole("combobox", { name: "Needle 1 thread" })).toHaveValue(label(THREADS[0]));
  const { machine } = await api("getMachine", { id: made.machines[MACHINE_FAIL] });
  expect(Number(machine.needles[1])).toBe(THREADS[0].id);
});

test("Production (Read only on Machines) gets a disabled needle box that still shows its thread", async ({ as }) => {
  const prod = await as("production");
  await openAdmin(prod, "machines");
  const card = machineCard(prod, MACHINE_READ);
  await expect(card).toHaveCount(1);
  const n1 = card.getByRole("combobox", { name: "Needle 1 thread" });
  await expect(n1).toBeDisabled();
  await expect(n1).toHaveValue(label(THREADS[0]));
  await expect(card.getByRole("combobox", { name: "Needle 2 thread" })).toBeDisabled();
  await expect(card.getByRole("combobox", { name: "Needle 2 thread" })).toHaveValue("");
});
