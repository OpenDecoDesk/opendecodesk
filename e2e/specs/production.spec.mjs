// Production: threads (and their spools), the searchable thread picker, hoops, decoration locations, machines
// and their needle threads, abort reasons, a design with an uploaded stitch file, and a job on Run Order
// from start to done. Every name is unique to the run; other specs share the install.
import { test, expect, openAdmin, toast, uniq, slug } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

test.describe.configure({ mode: "serial" });

const TAG = slug("e2e").slice(-6).toUpperCase();          // makes this run's thread codes unique
const THREADS = [
  { code: "TC" + TAG + "1", name: "Harbor Navy", hex: "#1f2a55" },
  { code: "TC" + TAG + "2", name: "Signal Red", hex: "#c8202f" },
];
const SPOOL = uniq("Cone spool");
const HOOP = uniq("Round Hoop");
const LOCATION = uniq("Left Chest");
const MACHINE = uniq("Machine");
const REASON = uniq("Thread break");
const DESIGN = uniq("Club Crest");

// A small, valid Tajima .dst: two colour blocks of three stitches each (so two needle stops).
function dstFile() {
  const header = Buffer.alloc(512, 0x20);
  header.write("LA:E2ECREST\r", 0, "latin1");
  const stitch = [0x01, 0x01, 0x03], colorChange = [0x00, 0x00, 0xc3], end = [0x00, 0x00, 0xf3];
  const recs = [stitch, stitch, stitch, colorChange, stitch, stitch, stitch, end].flat();
  return Buffer.concat([header, Buffer.from(recs)]);
}

// The Threads list narrowed to this run's threads.
async function openThreads(page) {
  await openAdmin(page, "threads");
  await page.getByRole("searchbox", { name: "Search brand, code, name…" }).fill(TAG);
}
const threadRow = (page, t) => page.getByRole("row", { name: new RegExp(t.code + " " + t.name) });

test("threads are added to the shared catalog and found by search", async ({ page }) => {
  await openAdmin(page, "threads");
  for (const t of THREADS) {
    await page.getByRole("button", { name: "+ New thread" }).click();
    const dlg = page.getByRole("dialog", { name: "New thread" });
    await dlg.getByLabel("Brand").fill("Test Thread Co");
    await dlg.getByLabel("Code").fill(t.code);
    await dlg.getByLabel("Type").fill("Poly");
    await dlg.getByLabel("Weight").fill("40");
    await dlg.getByLabel("Name").fill(t.name);
    await dlg.getByLabel("Color").fill(t.hex);
    await dlg.getByRole("button", { name: "Create thread" }).click();
    await expect(dlg).toHaveCount(0);
  }
  await page.getByRole("searchbox", { name: "Search brand, code, name…" }).fill(TAG);
  for (const t of THREADS) await expect(threadRow(page, t)).toBeVisible();
  // Several words narrow further: brand + one name.
  await page.getByRole("searchbox", { name: "Search brand, code, name…" }).fill("test thread " + THREADS[1].name.toLowerCase());
  await expect(threadRow(page, THREADS[1])).toBeVisible();
  await expect(threadRow(page, THREADS[0])).toHaveCount(0);
});

test("a thread is missing its brand: the form says so and saves nothing", async ({ page }) => {
  await openAdmin(page, "threads");
  await page.getByRole("button", { name: "+ New thread" }).click();
  const dlg = page.getByRole("dialog", { name: "New thread" });
  await dlg.getByLabel("Code").fill("TC" + TAG + "X");
  await dlg.getByRole("button", { name: "Create thread" }).click();
  await expect(dlg).toContainText("Brand and code are required.");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
});

test("a spool size is added and a thread's spools are put in stock", async ({ page }) => {
  await openThreads(page);
  await page.getByRole("button", { name: "Manage spool sizes…" }).click();
  const sizes = page.getByRole("dialog", { name: "Spool sizes" });
  await sizes.getByLabel("Description").fill(SPOOL);
  await sizes.getByLabel("Length (M)").fill("5000");
  await sizes.getByRole("button", { name: "Add" }).click();
  await expect(sizes.getByRole("row", { name: new RegExp(SPOOL + " 5000 M") })).toBeVisible();
  await sizes.getByRole("button", { name: "Done" }).click();

  await openThreads(page);
  const t = THREADS[0];
  await threadRow(page, t).getByRole("button", { name: "Inventory" }).click();
  const inv = page.getByRole("dialog", { name: new RegExp("^Inventory — Test Thread Co " + t.code) });
  await inv.getByLabel("Add spool size").selectOption({ label: SPOOL + " (5000 M)" });
  await inv.getByLabel("Qty").fill("3");
  await inv.getByRole("button", { name: "Add" }).click();
  await expect(inv.locator(".tiQty")).toHaveValue("3");
  await inv.getByRole("button", { name: "Done" }).click();
  await expect(threadRow(page, t)).not.toContainText("—");
});

test("a hoop and a decoration location are added", async ({ page }) => {
  await openAdmin(page, "hoops");
  await page.getByRole("button", { name: "+ New hoop" }).click();
  const hd = page.getByRole("dialog", { name: "New hoop" });
  await hd.getByLabel("Name").fill(HOOP);
  await hd.getByLabel("Width (mm)").fill("100");
  await hd.getByLabel("Height (mm)").fill("100");
  await hd.getByRole("button", { name: "Create hoop" }).click();
  await expect(hd).toHaveCount(0);
  await expect(page.getByRole("row", { name: new RegExp(HOOP) })).toBeVisible();

  await openAdmin(page, "locations");
  await page.getByRole("button", { name: "+ New decoration location" }).click();
  const ld = page.getByRole("dialog", { name: "New decoration location" });
  await ld.getByLabel("Name").fill(LOCATION);
  await ld.getByRole("button", { name: "Create" }).click();
  await expect(ld).toHaveCount(0);
  await expect(page.locator("#app")).toContainText(LOCATION);
});

test("a machine is added and its needles are threaded with the searchable thread picker", async ({ page }) => {
  await openAdmin(page, "machines");
  await page.getByRole("button", { name: "+ New machine" }).click();
  const md = page.getByRole("dialog", { name: "New machine" });
  await md.getByLabel("Name").fill(MACHINE);
  await md.getByLabel("Needle count").fill("4");
  await md.getByRole("button", { name: "Create machine" }).click();
  await expect(toast(page)).toContainText("Machine created.");
  const card = page.locator("#mchBody > div").filter({ hasText: MACHINE });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("4 needles");

  // Needle 1: type to narrow the list, then pick with the keyboard.
  const n1 = card.getByRole("combobox", { name: "Needle 1 thread" });
  await n1.click();
  await n1.fill(THREADS[0].code);
  const list1 = card.locator("#" + (await n1.getAttribute("aria-controls")));
  await expect(list1.getByRole("option")).toHaveCount(2);   // "—" (none) and the one match
  await expect(list1.getByRole("option").nth(1)).toContainText(THREADS[0].name);
  await n1.press("Enter");
  await expect(toast(page)).toContainText("Needle 1 saved.");
  await expect(n1).toHaveValue(new RegExp(THREADS[0].code + " — " + THREADS[0].name));

  // Needle 2: several words narrow the list (brand + this run's code prefix leaves both of this run's
  // threads); the arrow keys move to the second, and Enter picks it.
  const n2 = card.getByRole("combobox", { name: "Needle 2 thread" });
  await n2.click();
  await n2.fill("test thread TC" + TAG);
  const list2 = card.locator("#" + (await n2.getAttribute("aria-controls")));
  await expect(list2.getByRole("option")).toHaveCount(3);   // "—" and the two threads
  await expect(n2).toHaveAttribute("aria-activedescendant", /-o1$/);
  await n2.press("ArrowDown");
  await expect(n2).toHaveAttribute("aria-activedescendant", /-o2$/);
  await expect(list2.locator("li.active")).toContainText(THREADS[1].name);
  await n2.press("Enter");
  await expect(toast(page)).toContainText("Needle 2 saved.");

  // A search with no match says so; Escape closes the list and keeps the needle as it was.
  const n3 = card.getByRole("combobox", { name: "Needle 3 thread" });
  await n3.click();
  await n3.fill("zz-no-such-thread-" + TAG);
  const list3 = card.locator("#" + (await n3.getAttribute("aria-controls")));
  await expect(list3).toContainText("No thread matches");
  await n3.press("Escape");
  await expect(list3).toBeHidden();
  await expect(n3).toHaveValue("");

  // Saved on the server: a fresh page shows the same needles.
  await page.reload();
  const again = page.locator("#mchBody > div").filter({ hasText: MACHINE });
  await expect(again.getByRole("combobox", { name: "Needle 1 thread" })).toHaveValue(new RegExp(THREADS[0].code));
  await expect(again.getByRole("combobox", { name: "Needle 2 thread" })).toHaveValue(new RegExp(THREADS[1].code));
});

test("a maintenance task is set on the machine and logged as done", async ({ page }) => {
  await openAdmin(page, "machines");
  const card = page.locator("#mchBody > div").filter({ hasText: MACHINE });
  await card.getByRole("button", { name: "Tasks…" }).click();
  const tasks = page.getByRole("dialog", { name: "Maintenance tasks — " + MACHINE });
  await tasks.locator("#mtName").fill("Oil the rotary hook");
  await tasks.locator("#mtHours").fill("4");
  await tasks.getByRole("button", { name: "+ Add task" }).click();
  // Listed as an editable task: its name in a box, due every 4 run hours.
  await expect(tasks.locator("#mtList").getByRole("textbox").first()).toHaveValue("Oil the rotary hook");
  await expect(tasks.locator("#mtList")).toContainText("0 h / 4 h");
  await tasks.getByRole("button", { name: "Done" }).click();
  const task = card.locator(".mch-task").filter({ hasText: "Oil the rotary hook" });
  await expect(task).toBeVisible();
  await task.getByRole("button", { name: "Done" }).click();
  const done = page.getByRole("dialog", { name: "Done — Oil the rotary hook" });
  await done.locator("#mdNote").fill("Checked by the end-to-end suite");
  await done.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toContainText("Logged.");
  // The machine's maintenance log lists it.
  await card.getByRole("link", { name: "Log" }).click();
  await expect(page.locator("#app")).toContainText("Oil the rotary hook");
  await expect(page.locator("#app")).toContainText("Checked by the end-to-end suite");
});

test("an abort reason is added for Run Order", async ({ page }) => {
  await openAdmin(page, "abortreasons");
  await page.getByRole("button", { name: "+ New reason" }).click();
  const dlg = page.getByRole("dialog", { name: "New reason" });
  await dlg.getByLabel("Reason").fill(REASON);
  await dlg.getByRole("button", { name: "Create reason" }).click();
  await expect(toast(page)).toContainText("Reason created.");
  await expect(page.locator("#app")).toContainText(REASON);
});

test("a design gets a stitch file: its needle stops are read and threaded with the picker", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "dsgn", products: [{ name: "Crest Cap", price: 18, type: "cap", idPrefix: "cap" }] });
  await openAdmin(page, "designs/" + shop.orgId);
  await page.getByRole("button", { name: "+ New design" }).click();
  const form = page.getByRole("dialog", { name: "New design" });
  await form.locator("#dsgfName").fill(DESIGN);
  await form.getByRole("button", { name: "Create design" }).click();
  await expect(toast(page)).toContainText("Design created.");
  await page.locator("#dsgList").getByRole("button", { name: DESIGN }).click();
  await expect(page.locator("#dsgDetail")).toContainText(DESIGN);

  await page.getByRole("button", { name: "+ Upload version" }).click();
  const up = page.getByRole("dialog").filter({ has: page.locator("#dsgvMachineFile") });
  await up.locator("#dsgvMachineFile").setInputFiles({ name: "club-crest.dst", mimeType: "application/octet-stream", buffer: dstFile() });
  await expect(up.locator("#dsgvStops")).toContainText("2 needle stops");
  await expect(up.locator("#dsgvStops")).toContainText("0 of 2 needle definitions picked");
  for (const [i, t] of THREADS.entries()) {
    const box = up.getByRole("combobox", { name: `Colour ${i + 1} thread` });
    await box.click();
    await box.fill(t.code);
    await box.press("Enter");
    await expect(up.getByRole("combobox", { name: `Colour ${i + 1} thread` })).toHaveValue(new RegExp(t.code));
  }
  await expect(up.locator("#dsgvStops")).toContainText("2 of 2 needle definitions picked");
  await up.getByRole("button", { name: "Upload" }).click();
  await expect(up).toHaveCount(0);
  // The version is listed with its machine file and its two-needle thread map.
  const detail = page.locator("#dsgDetail");
  await expect(detail).toContainText("club-crest.dst");
  await expect(detail).toContainText("2 needles");
  await expect(detail.locator("#dsgThreadMap")).toContainText(THREADS[0].code);
});

test("a paid order's piece is run on Run Order, start to done", async ({ page, api, as }) => {
  // A cap that needs no blank, ordered and paid, digitized and approved: ready to run.
  const shop = await makeShop(api, { prefix: "runq", products: [{ name: "Run Cap", price: 18, type: "cap", idPrefix: "cap", extra: { noBlankNeeded: true } }] });
  const customer = await as(null);   // a shopper: not signed in
  const { orderId } = await placeOrder(customer, shop);
  await api("markPaidManual", { org: shop.orgId, orderId });
  await api("setFulfillmentStage", { org: shop.orgId, orderId, stage: "digitizingComplete" });
  await api("setFulfillmentStage", { org: shop.orgId, orderId, stage: "designApproved" });

  await openAdmin(page, "runorder");
  const card = page.locator(".run-job-card").filter({ has: page.locator(`[data-orderid="${orderId}"]`) });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Run Cap");
  // Run it on this spec's machine.
  const machineBox = card.getByRole("combobox", { name: "Machine" });
  const value = await machineBox.locator("option", { hasText: MACHINE }).getAttribute("value");
  await machineBox.selectOption(value);
  await card.getByRole("button", { name: "Start job" }).click();
  await expect(toast(page)).toContainText("Started on " + MACHINE + ".");
  const running = page.locator(".run-job-card").filter({ has: page.locator(`[data-orderid="${orderId}"]`) });
  await expect(running).toContainText("Running on " + MACHINE);
  await running.getByRole("button", { name: "Mark piece done" }).click();
  const finish = page.getByRole("dialog", { name: "Finish job" });
  await expect(finish).toContainText("Run time:");
  await finish.locator("#rfDone").click();
  await expect(finish).toHaveCount(0);
  await expect(page.locator(".run-job-card").filter({ has: page.locator(`[data-orderid="${orderId}"]`) })).toHaveCount(0);
  // The order is now made.
  const { orders } = await api("getOrders", { org: shop.orgId });
  expect(orders.find(o => o.orderId === orderId).manufacturedAt).toBeTruthy();
});

test("Production staff can read the thread catalog but not change it", async ({ as }) => {
  const prod = await as("production");
  await openAdmin(prod, "threads");
  await prod.getByRole("searchbox", { name: "Search brand, code, name…" }).fill(TAG);
  await expect(prod.getByRole("row", { name: new RegExp(THREADS[0].code) })).toBeVisible();
  await expect(prod.getByRole("button", { name: "+ New thread" })).toBeHidden();
  await expect(prod.getByRole("row", { name: new RegExp(THREADS[0].code) }).getByRole("button", { name: "Delete" })).toBeHidden();
});
