// Small checks of four fixes that no other spec looks at directly:
//   - Global settings → Setup status: the Database line is ticked on an install that has every migration
//     (functions/_lib/setupStatus.js addDatabase; it is flagged only while database updates are pending).
//   - Deleting a design deletes its versions' files in the private DESIGNS bucket, unless another row still
//     points to the same file (functions/_lib/db.js deleteDesign / designsKeysUnused_, functions/api/orders.js
//     deleteDesignsFiles_). A signed link to a deleted file then answers 404.
//   - The admin page loads admin.js under a content version (?v=<the assets layer's ETag for it>,
//     functions/api/catalog.js adminScriptVersion), the same one on the next load, so the browser can keep it.
//   - The accountant export's "Inventory by group" CSV has a Transfer sheets row (functions/_lib/db.js
//     getAccountantExport), and the status line counts the rows downloaded.
//
// Everything here is this file's own (a shop with three designs and their files) or only read. Nothing
// install-wide is changed.
import fs from "node:fs";
import { test, expect, openAdmin, toast, uniq, apiContext, confirmDialog, ADMIN } from "../fixtures.mjs";
import { freshAdmin } from "../lib/money.mjs";
import { makeShop } from "../lib/data.mjs";

// A small Tajima .dst (512-byte header, a few stitches, one colour change, the end record).
function dstFile(label) {
  const header = Buffer.alloc(512, 0x20);
  header.write("LA:" + label + "\r", 0, "latin1");
  const stitch = [0x01, 0x01, 0x03], colorChange = [0x00, 0x00, 0xc3], end = [0x00, 0x00, 0xf3];
  return Buffer.concat([header, Buffer.from([stitch, stitch, colorChange, stitch, end].flat())]);
}

// Uploads a machine file for `designId` the way the Upload version window does (POST /api/design?designId&role…),
// and returns the stored key.
async function uploadMachineFile(ctx, designId, name, bytes) {
  const res = await ctx.post(`/api/design?designId=${designId}&role=machine&ext=dst&name=${encodeURIComponent(name)}`,
    { headers: { "Content-Type": "application/octet-stream" }, data: bytes });
  const d = await res.json();
  expect(res.ok(), JSON.stringify(d)).toBe(true);
  expect(d.key).toMatch(/^designs\/.+\.dst$/);
  return d.key;
}
// A signed 60-second link to a stored file (what Download and the preview ask for).
async function signedLink(ctx, key) {
  const res = await ctx.post("/api/design", { data: { key } });
  const d = await res.json();
  expect(res.ok(), JSON.stringify(d)).toBe(true);
  return d.url;
}
// What a link answers: its status, and the bytes when it found the file.
const fetchFile = async (ctx, url) => { const r = await ctx.get(url); return { status: r.status(), body: r.ok() ? await r.body() : null }; };

test("Setup status: the Database line is ticked on an install with every migration applied", async ({ page, api }) => {
  // The server's list: ready, with nothing pending to say.
  const { items } = await api("getSetupStatus");
  expect(items.find(i => i.key === "database")).toMatchObject({ label: "Database", level: "required", ready: true, note: "" });

  await freshAdmin(page, "settings");
  // The Setup status section of the form…
  const row = page.locator('#gSetupStatus .setup-row[data-key="database"]');
  await expect(row).toHaveAttribute("data-ready", "1");
  await expect(row).toContainText("✓");
  await expect(row).toContainText("Database Ready");
  await expect(row).not.toContainText("haven't been applied");
  // …and the summary box above it.
  const boxRow = page.locator("#setupStatusBox tr").filter({ has: page.getByRole("cell", { name: /^Database required/ }) });
  await expect(boxRow.locator("td").first()).toHaveText("✓");
});

test("Designs: deleting a design deletes its file, and its link answers 404 from then on", async ({ page, api }, testInfo) => {
  const shop = await makeShop(api, { prefix: "dsgdel", products: [], publish: false });
  const name = uniq("Gone Crest");
  const { id } = await api("saveDesign", { org: shop.orgId, design: { name } });
  const ctx = await apiContext("owner", testInfo.workerIndex);
  try {
    const bytes = dstFile("GONECREST");
    const key = await uploadMachineFile(ctx, id, "gone-crest.dst", bytes);
    await api("saveDesignVersion", { designId: id, machineFileKey: key, machineFileName: "gone-crest.dst", machineFileExt: "dst", threadColors: [] });
    // Before: the file is there.
    const link = await signedLink(ctx, key);
    const before = await fetchFile(ctx, link);
    expect(before.status).toBe(200);
    expect(before.body.equals(bytes)).toBe(true);

    // Delete it on the Designs page.
    await openAdmin(page, "designs/" + shop.orgId + "/" + id);
    const detail = page.locator("#dsgDetail");
    await expect(detail).toContainText(name);
    await expect(detail).toContainText("gone-crest.dst");
    await detail.getByRole("button", { name: "Delete", exact: true }).click();
    await confirmDialog(page);
    await expect(toast(page)).toContainText("Design deleted.");
    await expect(page.locator("#dsgList")).not.toContainText(name);
    expect((await api("listDesigns", { org: shop.orgId })).designs.map(d => d.id)).not.toContain(id);

    // After: the link signed before (still within its minute) and a new one both find nothing.
    expect((await fetchFile(ctx, link)).status).toBe(404);
    expect((await fetchFile(ctx, await signedLink(ctx, key))).status).toBe(404);
  } finally {
    await ctx.dispose();
  }
});

test("Designs: a file another design still uses is kept when one of them is deleted", async ({ api }, testInfo) => {
  const shop = await makeShop(api, { prefix: "dsgshr", products: [], publish: false });
  const a = (await api("saveDesign", { org: shop.orgId, design: { name: uniq("Shared Crest A") } })).id;
  const b = (await api("saveDesign", { org: shop.orgId, design: { name: uniq("Shared Crest B") } })).id;
  const ctx = await apiContext("owner", testInfo.workerIndex);
  try {
    const bytes = dstFile("SHAREDCREST");
    const key = await uploadMachineFile(ctx, a, "shared-crest.dst", bytes);
    for (const designId of [a, b])
      await api("saveDesignVersion", { designId, machineFileKey: key, machineFileName: "shared-crest.dst", machineFileExt: "dst", threadColors: [] });

    await api("deleteDesign", { id: a });
    const kept = await fetchFile(ctx, await signedLink(ctx, key));
    expect(kept.status, "B's version still points to the file").toBe(200);
    expect(kept.body.equals(bytes)).toBe(true);

    await api("deleteDesign", { id: b });
    expect((await fetchFile(ctx, await signedLink(ctx, key))).status, "nothing points to it any more").toBe(404);
  } finally {
    await ctx.dispose();
  }
});

test("admin.js is loaded under a content version (?v=<hex>), the same one after a reload", async ({ page }) => {
  const requested = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/admin.js") requested.push(r.url()); });
  const scriptSrc = () => page.locator('script[src*="admin.js"]').getAttribute("src");

  await openAdmin(page, "home");
  const src = await scriptSrc();
  expect(src).toMatch(/^admin\.js\?v=[0-9a-f]+$/);
  const v = new URL(src, ADMIN).searchParams.get("v");
  expect(requested).toEqual([ADMIN + "/admin.js?v=" + v]);
  // It is the version the server announces with the catalog (functions/api/catalog.js adminScriptVersion).
  const catalog = await (await page.request.get(ADMIN + "/api/catalog")).json();
  expect(catalog.adminScript).toBe(v);

  await page.reload();
  await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
  expect(await scriptSrc()).toBe("admin.js?v=" + v);
  // Asked for under the same address (whether the browser then answers it from its cache or not).
  for (const u of requested) expect(u).toBe(ADMIN + "/admin.js?v=" + v);
});

test("Accountant export: Inventory by group has a Transfer sheets row, and the status counts the rows", async ({ page, api }) => {
  const year = new Date().getUTCFullYear();
  // What the server sends for the year: one row per inventory group.
  const { inventoryGroups } = await api("getAccountantExport", { dateFrom: year + "-01-01", dateTo: year + "-12-31" });
  const groups = inventoryGroups.map(g => g.group);
  expect(groups).toEqual(["Blanks for sale", "Blanks for testing / shop use", "Finished stock", "Transfer sheets"]);

  await freshAdmin(page, "books");
  await page.getByRole("button", { name: String(year), exact: true }).click();
  await expect(page.locator("#expFrom")).toHaveValue(year + "-01-01");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Inventory by group", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`odd-inventoryGroups-${year}-01-01-to-${year}-12-31.csv`);
  const lines = fs.readFileSync(await download.path(), "utf8").trim().split(/\r?\n/);
  expect(lines[0]).toBe("Inventory group,Beginning inventory,Ending inventory");
  // No group name has a comma in it, so a plain split reads them: one line per group, in the server's order.
  const rows = lines.slice(1).map(l => l.split(","));
  expect(rows.map(r => r[0])).toEqual(groups);
  const transfers = rows.find(r => r[0] === "Transfer sheets");
  expect(transfers).toHaveLength(3);
  for (const n of transfers.slice(1)) expect(n !== "" && Number.isFinite(Number(n)), "a value: " + n).toBe(true);
  await expect(page.locator("#expStatus")).toHaveText(`Downloaded ${groups.length} rows.`);
});
