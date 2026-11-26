// Three screens whose work used to grow, request by request, past the database queries Cloudflare allows one
// request to run (50 on the Free plan) — review round 2, "Query limits":
//
// - Settings → Orphaned images: the scan now runs in steps the page drives (each request does a bounded share and
//   says how far it is), where it ran one query per text column of every table in a single request. Here it is run
//   to the end on the real local database and image store. The store stamps every upload with the time it was made,
//   and a file under 24 hours old is never called orphaned — so in this suite's fresh install nothing can be listed:
//   the test checks the scan finishes in several requests, counts today's uploads as not checked, lists neither a
//   product's picture nor an upload nothing uses, and that a delete asked for anyway removes nothing. Listing and
//   deleting files older than a day is covered by the unit tests (test280, test146), which set the files' dates.
// - Blanks → Count stock…: "Correct all remaining differences" sends a big count in groups of 100 rows; the server
//   takes at most 100 a request and writes each group in one batch. Here: 120 differing rows end all corrected.
// - The shop bar: it asks for the publish state of the shop it shows (not every shop's), and a publish answers with
//   that shop's state. Here, with four shops: the right state on the bar after a product change, after switching
//   shops, and after Publish.
//
// Every test makes its own shops, blanks and uploads, and only looks at those.
import { test, expect, openAdmin, waitIdle, toast, confirmDialog, uniq, pngBytes, apiContext, callApi } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// The bodies of the admin API requests the page sends for one action, as they go out.
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

test("Orphaned images: the scan runs to the end in steps, and leaves today's uploads alone", async ({ page, api }, testInfo) => {
  // A product with a picture, and a second upload nothing points to.
  const shop = await makeShop(api, { prefix: "orph", products: [{ name: uniq("Pictured Tee"), price: 20 }] });
  const owner = await apiContext("owner", testInfo.workerIndex);
  const upload = async (rgb) => {
    const up = await owner.post("/api/upload?org=" + shop.orgId, { data: pngBytes(24, 24, rgb), headers: { "Content-Type": "image/png" } });
    expect(up.status()).toBe(200);
    return (await up.json()).url;
  };
  const used = await upload([200, 40, 40]), unused = await upload([40, 200, 40]);
  const keyOf = (url) => new URL(url).pathname.replace(/^\//, "");
  const p = shop.products[0];
  await api("updateProduct", { org: shop.orgId, productId: p.productId, type: "shirt", name: p.name, pricingMode: "flat", flatPrice: p.price, visible: true, images: [used] });

  const steps = recordActions(page, "findOrphanImages");
  const answers = [];
  page.on("response", async (res) => {
    if (!/\/api\/orders(\?|$)/.test(res.url())) return;
    let body = null;
    try { body = JSON.parse(res.request().postData() || "null"); } catch (e) {}
    if (body && body.action === "findOrphanImages") answers.push({ status: res.status(), data: await res.json().catch(() => null) });
  });
  await openAdmin(page, "orphans");
  await expect(page).toHaveTitle(/Orphaned images/);
  await page.getByRole("button", { name: "Scan the image store" }).click();

  // It ends: every file of this fresh install is under a day old, so none is orphaned and all are "not checked".
  const body = page.locator("#orBody");
  await expect(body).toContainText(/No orphaned images — all \d+ files? (is|are) in use \(\d+ uploaded in the last 24 hours not checked\)\./, { timeout: 30_000 });
  const m = /all (\d+) files? (?:is|are) in use \((\d+) uploaded/.exec(await body.textContent());
  expect(Number(m[1]), "files in the store").toBeGreaterThanOrEqual(2);
  expect(Number(m[2]), "of them uploaded today").toBe(Number(m[1]));
  await expect(page.locator(".orPick")).toHaveCount(0);
  await expect(body).not.toContainText(keyOf(used));
  await expect(body).not.toContainText(keyOf(unused));

  // In steps: the first request starts a scan, each later one carries its scanId, and each answer says how far it is.
  await expect.poll(() => answers.length).toBe(steps.length);
  expect(steps.length, "requests for one scan").toBeGreaterThanOrEqual(3);
  expect(steps[0].scanId).toBeUndefined();
  const scanId = answers[0].data.scanId;
  expect(scanId).toMatch(/^[0-9a-f]{24}$/);
  for (const s of steps.slice(1)) expect(s.scanId).toBe(scanId);
  for (const a of answers) { expect(a.status).toBe(200); expect(a.data.status).toBe("ok"); }
  expect(answers[0].data).toMatchObject({ done: false, phase: "tables" });
  expect(answers[0].data.table).toBeGreaterThan(0);
  expect(answers[0].data.tables).toBeGreaterThan(70);
  const tables = answers.filter(a => a.data.phase === "tables").map(a => a.data.table);
  expect(tables, "always further along").toEqual([...tables].sort((x, y) => x - y));
  // About twenty tables a request: the local database gave every table's columns in one query (had it not, the
  // scan reads them table by table and takes twice the requests).
  expect(tables.length, "requests that ended part-way through the tables").toBeLessThanOrEqual(5);
  expect(answers[answers.length - 1].data).toMatchObject({ done: true, phase: "done", orphans: [] });

  // A delete asked for anyway (not something the page offers: nothing was listed) is refused, with or without the
  // scan's id — a scan that found nothing orphaned keeps no list to delete from — and both files stay.
  for (const body of [{ keys: [keyOf(unused)] }, { keys: [keyOf(used), keyOf(unused)], scanId }]) {
    const refused = await callApi(owner, "deleteOrphanImages", body, { allowError: true, withStatus: true });
    expect(refused.status).toBe(400);
    expect(refused.data.message).toBe("This list is out of date — scan the image store again, then remove the files.");
  }
  for (const url of [used, unused]) {
    const still = await owner.get("/api/image-proxy?src=" + encodeURIComponent(url));
    expect(still.status(), "still in the store: " + url).toBe(200);
  }
  await owner.dispose();
});

test("Count stock: 120 differing rows are all corrected by Correct all remaining differences, 100 rows a request", async ({ page, api }) => {
  // Two blanks, two colors each, thirty sizes a color: 120 rows, none in stock.
  const mark = uniq("Limits Count Blank"), names = [mark + " A", mark + " B"];
  const sizes = Array.from({ length: 30 }, (_, i) => "N" + String(i + 1).padStart(2, "0"));
  const ids = [];
  for (const name of names) {
    ids.push((await api("createBlank", { name, brand: "Test Blank Co", productType: "Tee",
      colors: ["Navy", "Red"].map(color => ({ color, sizes: sizes.map(size => ({ size, quantity: 0, purchasePrice: 2, vendorPrice: 2 })) })) })).id);
  }
  const mine = async () => (await api("getBlanks")).blanks.filter(b => ids.includes(b.id));
  expect((await mine()).flatMap(b => b.sizes).length).toBe(120);

  const sent = recordActions(page, "countBlankStock");
  await openAdmin(page, "inventory");
  await page.getByRole("button", { name: "Count stock…" }).click();
  const cd = page.getByRole("dialog", { name: "Count stock — blanks" });
  // Only this test's rows (other tests have blanks of their own in the list): both blanks' names start the same.
  await cd.getByRole("searchbox", { name: "Search" }).fill(mark);
  await expect(cd.getByRole("spinbutton", { name: "Counted" })).toHaveCount(120);
  // Each row is counted, 1 to 7 on hand (the system says 0) — set the way typing sets it: the box's value, then its
  // input event, which is what the window follows.
  const typed = await cd.locator("input.sc-count").evaluateAll((boxes) => boxes.map((box, i) => {
    box.value = String(1 + (i % 7));
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return 1 + (i % 7);
  }));
  expect(typed.length).toBe(120);
  await cd.getByRole("checkbox", { name: "Only rows with a difference" }).check();
  await expect(cd.getByRole("spinbutton", { name: "Counted" })).toHaveCount(120);

  await cd.getByRole("button", { name: "Correct all remaining differences" }).click();
  const ask = page.getByRole("dialog").last();
  await expect(ask).toContainText("Record corrections for 120 rows?");
  await confirmDialog(page);
  await expect(toast(page)).toContainText("120 counts corrected.");

  // Two requests, 100 rows and 20; nothing of this test's still differs.
  expect(sent.map(b => b.rows.length)).toEqual([100, 20]);
  await expect(cd.locator("#scTable")).toContainText("Nothing matches.");
  await expect(cd.locator("#scErr")).toHaveText("");
  // Every row is what was counted, each by one correction of its own.
  const after = await mine();
  const total = after.flatMap(b => b.sizes).reduce((n, z) => n + Number(z.quantity), 0);
  expect(total).toBe(typed.reduce((n, v) => n + v, 0));
  expect(after.flatMap(b => b.sizes).every(z => Number(z.quantity) >= 1 && Number(z.quantity) <= 7)).toBe(true);
  for (const id of ids) {
    const { movements } = await api("getBlankMovements", { blankId: id });
    const adjusts = movements.filter(mv => mv.kind === "adjust");
    expect(adjusts.length, "corrections recorded for blank " + id).toBe(60);
    expect(adjusts.every(mv => /^Stock count/.test(mv.note))).toBe(true);
  }
  // More than 100 rows straight to the server (not something the window sends) are refused, and nothing changes.
  const tooMany = await api("countBlankStock", { rows: Array.from({ length: 101 }, () => ({ blankId: ids[0], color: "Navy", size: "N01", counted: 9, onHand: 1 })) }, { allowError: true, withStatus: true });
  expect(tooMany.status).toBe(400);
  expect(tooMany.data.message).toBe("Too many rows at once (max 100)");
  expect((await mine()).flatMap(b => b.sizes).reduce((n, z) => n + Number(z.quantity), 0)).toBe(total);
  await cd.getByRole("button", { name: "Close" }).last().click();
});

test("the shop bar shows the right publish state for the shop on screen, among several shops", async ({ page, api }) => {
  // Three published shops and one never published.
  const a = await makeShop(api, { prefix: "bara", products: [{ name: uniq("Bar Tee A"), price: 20 }] });
  const b = await makeShop(api, { prefix: "barb", products: [{ name: uniq("Bar Tee B"), price: 21 }] });
  const c = await makeShop(api, { prefix: "barc", products: [{ name: uniq("Bar Tee C"), price: 22 }] });
  const fresh = await makeShop(api, { prefix: "bard", publish: false, products: [{ name: uniq("Bar Tee D"), price: 23 }] });
  const asked = recordActions(page, "getPublishState");
  const bar = page.getByRole("navigation", { name: "Shop" });
  const open = async (shop) => { await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products"); await expect(bar.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId); };

  await open(b);
  await expect(bar.getByRole("button", { name: "✓ Published" })).toBeDisabled();
  await expect(page.locator("main")).toContainText("✓ Published");
  // A shop's own page asks for that shop's state, never every shop's.
  expect(asked.length).toBeGreaterThan(0);
  for (const body of asked) expect(body.orgs).toEqual([b.orgId]);

  // One of B's products changes: B has something to publish; A and C don't.
  const p = b.products[0];
  await api("updateProduct", { org: b.orgId, productId: p.productId, type: "shirt", name: p.name, pricingMode: "flat", flatPrice: 26, visible: true, images: [] });
  await open(b);
  await expect(bar.getByRole("button", { name: "Publish changes" })).toBeEnabled();
  await expect(bar.getByRole("button", { name: "Discard changes…" })).toBeVisible();
  await expect(page.locator("main")).toContainText("Unpublished changes (1 product)");

  // The picker moves to another shop: the bar shows THAT shop's state.
  asked.length = 0;
  await bar.getByRole("combobox", { name: "Shop" }).selectOption(a.orgId);
  await expect(page).toHaveURL(new RegExp("#catalog/orgs/" + a.orgId + "/products$"));
  await waitIdle(page);
  await expect(bar.getByRole("button", { name: "✓ Published" })).toBeDisabled();
  await expect(bar.getByRole("button", { name: "Publish changes" })).toHaveCount(0);
  expect(asked.length).toBeGreaterThan(0);
  for (const body of asked) expect(body.orgs).toEqual([a.orgId]);
  // …the one never published offers Publish (and nothing to discard)…
  await bar.getByRole("combobox", { name: "Shop" }).selectOption(fresh.orgId);
  await expect(page).toHaveURL(new RegExp("#catalog/orgs/" + fresh.orgId + "/products$"));
  await waitIdle(page);
  await expect(bar.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
  await expect(bar.getByRole("button", { name: "Discard changes…" })).toHaveCount(0);
  // …and back on B it still has changes to publish.
  await bar.getByRole("combobox", { name: "Shop" }).selectOption(b.orgId);
  await expect(page).toHaveURL(new RegExp("#catalog/orgs/" + b.orgId + "/products$"));
  await waitIdle(page);
  await expect(bar.getByRole("button", { name: "Publish changes" })).toBeEnabled();

  // Publish from the bar: the answer carries B's state alone, and the bar reads ✓ Published.
  const published = page.waitForResponse(async (res) => {
    if (!/\/api\/orders(\?|$)/.test(res.url())) return false;
    try { return JSON.parse(res.request().postData() || "null").action === "publish"; } catch (e) { return false; }
  });
  await bar.getByRole("button", { name: "Publish changes" }).click();
  await confirmDialog(page, "Publish");
  await expect(toast(page)).toContainText("Published — shoppers see " + b.name + " as it is now.");
  const answer = await (await published).json();
  expect(answer.published).toEqual([b.orgId]);
  expect(Object.keys(answer.publishState)).toEqual([b.orgId]);
  expect(answer.publishState[b.orgId].state).toBe("current");
  await expect(bar.getByRole("button", { name: "✓ Published" })).toBeDisabled();
  await expect(page.locator("main")).toContainText("✓ Published");

  // Manage catalog asks for every shop at once and shows each shop's own state.
  asked.length = 0;
  await openAdmin(page, "catalog");
  const row = (shop) => page.getByRole("row", { name: new RegExp(shop.orgId) });
  await expect(row(a)).toContainText("✓ Published");
  await expect(row(b)).toContainText("✓ Published");
  await expect(row(c)).toContainText("✓ Published");
  await expect(row(fresh)).toContainText("Not published yet");
  expect(asked.some(body => body.orgs === undefined), "one request for every shop").toBe(true);
  // The server's own word, shop by shop, agrees.
  const all = (await api("getPublishState")).publishState;
  expect([a, b, c, fresh].map(s => all[s.orgId].state)).toEqual(["current", "current", "current", "never"]);
  const some = (await api("getPublishState", { orgs: [c.orgId, fresh.orgId] })).publishState;
  expect(Object.keys(some).sort()).toEqual([c.orgId, fresh.orgId].sort());
});
