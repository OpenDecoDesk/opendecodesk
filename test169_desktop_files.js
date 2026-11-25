// The desktop program's file storage (desktop/files.js + desktop/r2-files-binding.mjs): the Worker's
// IMAGES / RECEIPTS / DESIGNS buckets kept as ordinary files in the data folder. The bucket the Worker
// gets is driven here exactly as Miniflare wires it: its requests go to FileStore#handle.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FileStore, keyParts, copyFromR2 } = require("./desktop/files.js");
const ok = (d, c) => console.log(d + ":", !!c);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "odd-files-"));
  const store = new FileStore(path.join(root, "files"));
  const { default: wrap } = await import("./desktop/r2-files-binding.mjs");
  const STORE = { fetch: (url, init) => store.handle(new Request(url, init)) };
  const IMAGES = wrap({ STORE, BUCKET: "images" }), DESIGNS = wrap({ STORE, BUCKET: "designs" });
  const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];

  console.log("=== Files are ordinary files ===");
  const png = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
  const put = await IMAGES.put("uploads/shop/abc123.png", png, { httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=1" } });
  const onDisk = path.join(root, "files", "images", "uploads", "shop", "abc123.png");
  ok("a put writes the file under files/<bucket>/<key>, byte for byte", fs.existsSync(onDisk) && Buffer.compare(fs.readFileSync(onDisk), Buffer.from(png)) === 0);
  ok("…its details go in a separate .meta folder, not beside it", fs.existsSync(path.join(root, "files", ".meta", "images", "uploads", "shop", "abc123.png.json")) &&
    fs.readdirSync(path.dirname(onDisk)).join() === "abc123.png");
  ok("…and no temporary file is left behind", !walk(path.join(root, "files")).some(f => f.includes(".tmp-")));
  ok("put answers like R2: the key, size and upload time", put.key === "uploads/shop/abc123.png" && put.size === 7 && put.uploaded instanceof Date);

  console.log("\n=== Reading it back as the Worker does ===");
  const got = await IMAGES.get("uploads/shop/abc123.png");
  ok("get: the bytes and the content type", got && got.httpMetadata.contentType === "image/png" && Buffer.compare(Buffer.from(await got.arrayBuffer()), Buffer.from(png)) === 0);
  let twice = null; try { await got.arrayBuffer(); } catch (e) { twice = e; }
  ok("…the body can be read once, as with R2", twice instanceof TypeError);
  const streamed = await IMAGES.get("uploads/shop/abc123.png");
  ok("…or streamed straight into a Response (image-proxy.js, design.js)", (await new Response(streamed.body).arrayBuffer()).byteLength === 7);
  const h = new Headers(); streamed.writeHttpMetadata(h);
  ok("writeHttpMetadata copies the saved headers", h.get("content-type") === "image/png" && h.get("cache-control") === "public, max-age=1");
  const head = await IMAGES.head("uploads/shop/abc123.png");
  ok("head: the details and upload time, no body", head && head.size === 7 && head.uploaded.getTime() === put.uploaded.getTime() && head.body === undefined);
  await DESIGNS.put("designs/7/logo.dst", new Uint8Array([1, 2]), { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: { name: "Club logo.dst" } });
  ok("custom details (a design file's own name) come back", (await DESIGNS.get("designs/7/logo.dst")).customMetadata.name === "Club logo.dst");
  ok("a missing key is null, as with R2", (await IMAGES.get("uploads/shop/nope.png")) === null && (await IMAGES.head("nope")) === null);
  ok("buckets are kept apart", (await IMAGES.get("designs/7/logo.dst")) === null);

  console.log("\n=== Listing, a page at a time (Orphaned images) ===");
  for (let i = 0; i < 5; i++) await IMAGES.put(`uploads/shop/p${i}.png`, png, { httpMetadata: { contentType: "image/png" } });
  let page = await IMAGES.list({ limit: 2 }), seen = [...page.objects.map(o => o.key)], pages = 1;
  while (page.truncated) { page = await IMAGES.list({ limit: 2, cursor: page.cursor }); seen.push(...page.objects.map(o => o.key)); pages++; }
  ok("every file is listed once, in key order, across pages", seen.length === 6 && new Set(seen).size === 6 && seen.join() === [...seen].sort().join() && pages === 3);
  ok("…with each one's size and upload time", (await IMAGES.list()).objects.every(o => o.size === 7 && o.uploaded instanceof Date));
  ok("…and only within a prefix when one is given", (await IMAGES.list({ prefix: "uploads/shop/p" })).objects.length === 5);
  ok("the .meta folder and temporary files are never listed", !(await IMAGES.list()).objects.some(o => /meta|tmp/.test(o.key)));
  await IMAGES.delete(["uploads/shop/p0.png", "uploads/shop/p1.png"]);
  await IMAGES.delete("uploads/shop/already-gone.png");
  ok("delete removes the file and its details (one key or several; a missing one is fine)", (await IMAGES.list()).objects.length === 4 &&
    !fs.existsSync(path.join(root, "files", "images", "uploads", "shop", "p0.png")) && !fs.existsSync(path.join(root, "files", ".meta", "images", "uploads", "shop", "p0.png.json")));

  console.log("\n=== Keys can't reach outside the folder ===");
  const bad = ["../outside.png", "uploads/../../outside.png", "/etc/passwd", "a//b", "a\\b", "", "x\0y", "a/./b"];
  ok("unsafe keys are refused", bad.every(k => keyParts(k) === null));
  let refused = 0;
  for (const k of bad.filter(Boolean)) { try { await IMAGES.put(k, png); } catch (e) { refused++; } }
  ok("…by the bucket too, and nothing is written outside files/", refused === bad.filter(Boolean).length && !fs.existsSync(path.join(root, "outside.png")) && !fs.existsSync(path.join(root, "files", "outside.png")));
  const odd = "uploads/shop/Club logo – final (2).png";
  await IMAGES.put(odd, png, { httpMetadata: { contentType: "image/png" } });
  await IMAGES.put("uploads/con.png", png);
  ok("other characters are kept safe for Windows file names and come back as the same key", (await IMAGES.get(odd)) && (await IMAGES.list({ prefix: "uploads/shop/Club" })).objects[0].key === odd &&
    walk(path.join(root, "files", "images")).every(f => !/[ ()–]/.test(path.basename(f))) && (await IMAGES.list({ prefix: "uploads/con" })).objects[0].key === "uploads/con.png");
  ok("today's keys keep their own names on disk", keyParts("receipts/2026/0f3c9a.pdf").join("/") === "receipts/2026/0f3c9a.pdf");
  ok("a bucket that doesn't exist is refused", (await store.handle(new Request("http://files/elsewhere?key=a"))).status === 404);

  console.log("\n=== Copying from Miniflare's own storage (the program before plain files) ===");
  const old = new Map([
    ["IMAGES", [{ key: "uploads/shop/old.png", bytes: png, httpMetadata: { contentType: "image/png" }, customMetadata: {}, uploaded: new Date("2026-10-01T10:00:00Z") }]],
    ["RECEIPTS", [{ key: "receipts/2026/r1.pdf", bytes: new Uint8Array([37, 80, 68, 70]), httpMetadata: { contentType: "application/pdf" }, customMetadata: { name: "Invoice 42.pdf" }, uploaded: new Date("2026-10-02T10:00:00Z") }]],
    ["DESIGNS", []],
  ]);
  const fakeR2 = (name) => ({
    async list() { return { objects: old.get(name).map(o => ({ key: o.key })), truncated: false }; },
    async get(key) { const o = old.get(name).find(x => x.key === key); return o && { ...o, arrayBuffer: async () => o.bytes.buffer.slice(0) }; },
  });
  const copyStore = new FileStore(path.join(root, "copied"));
  const n = await copyFromR2(copyStore, async (name) => fakeR2(name));
  const r1 = copyStore.get("receipts", "receipts/2026/r1.pdf");
  ok("every stored file is copied, with its type, name and original upload time", n === 2 && r1 && r1.httpMetadata.contentType === "application/pdf" &&
    r1.customMetadata.name === "Invoice 42.pdf" && r1.uploaded === "2026-10-02T10:00:00.000Z" && copyStore.get("images", "uploads/shop/old.png").body.length === 7);

  console.log("\n=== Listing reads only the prefix's folder, and reuses its keys page to page ===");
  {
    const s2 = new FileStore(path.join(root, "files2"));
    const B = wrap({ STORE: { fetch: (url, init) => s2.handle(new Request(url, init)) }, BUCKET: "images" });
    for (let i = 0; i < 6; i++) await B.put(`uploads/shop/q${i}.png`, png);
    for (let i = 0; i < 3; i++) await B.put(`uploads/other/r${i}.png`, png);
    await B.put("top.png", png);
    const reads = [];
    const realReaddir = fs.readdirSync;
    fs.readdirSync = function (d, ...rest) { reads.push(path.relative(path.join(root, "files2", "images"), String(d))); return realReaddir.call(fs, d, ...rest); };
    let realNow = Date.now;
    try {
      let p = await B.list({ prefix: "uploads/shop/q", limit: 4 });
      ok("a prefix's listing starts at the deepest folder it names (uploads/shop), not the bucket's top", p.objects.length === 4 && reads.length === 1 && reads[0] === path.join("uploads", "shop"));
      reads.length = 0;
      p = await B.list({ prefix: "uploads/shop/q", limit: 4, cursor: p.cursor });
      ok("…the next page reuses the sorted keys: no folder is read again", reads.length === 0 && p.objects.map(o => o.key).join() === "uploads/shop/q4.png,uploads/shop/q5.png" && !p.truncated);
      p = await B.list({ prefix: "uploads/shop/", cursor: "uploads/shop/q25" });
      ok("a cursor that isn't one of the keys still starts at the next key after it", p.objects[0].key === "uploads/shop/q3.png" && p.objects.length === 3);
      await B.put("uploads/shop/q6.png", png);
      reads.length = 0;
      p = await B.list({ prefix: "uploads/shop/q" });
      ok("a put in the bucket is listed at once (the kept keys are dropped)", reads.length === 1 && p.objects.length === 7);
      await B.delete("uploads/shop/q6.png");
      ok("…and so is a delete", (await B.list({ prefix: "uploads/shop/q" })).objects.length === 6);
      fs.copyFileSync(path.join(root, "files2", "images", "uploads", "shop", "q0.png"), path.join(root, "files2", "images", "uploads", "shop", "q7.png"));
      ok("a file copied in by hand isn't seen while the keys are fresh", (await B.list({ prefix: "uploads/shop/q" })).objects.length === 6);
      const later = realNow() + 31 * 1000; Date.now = () => later;
      ok("…and is after 30 seconds", (await B.list({ prefix: "uploads/shop/q" })).objects.length === 7);
      fs.unlinkSync(path.join(root, "files2", "images", "uploads", "shop", "q7.png"));
      ok("a file removed by hand from a kept listing is skipped, not an error", (await B.list({ prefix: "uploads/shop/q" })).objects.length === 6);
      Date.now = realNow;
      reads.length = 0;
      const all = await B.list();
      ok("no prefix: the whole bucket, in key order", all.objects.map(o => o.key).join() === [...all.objects.map(o => o.key)].sort().join() && all.objects.length === 10 && reads[0] === "");
      ok("a prefix with a folder that can't be a key matches nothing", (await B.list({ prefix: "uploads/../" })).objects.length === 0 && (await B.list({ prefix: "uploads//q" })).objects.length === 0);
      ok("a prefix that names a folder exactly lists its files", (await B.list({ prefix: "uploads/other/" })).objects.map(o => o.key).join() === "uploads/other/r0.png,uploads/other/r1.png,uploads/other/r2.png");
    } finally { fs.readdirSync = realReaddir; Date.now = realNow; }
    let p = await B.list({ prefix: "uploads/shop/", startAfter: "uploads/shop/q3.png" });
    ok("startAfter (R2's option) lists the keys after it, through the bucket as the Worker has it", p.objects.map(o => o.key).join() === "uploads/shop/q4.png,uploads/shop/q5.png");
    p = await B.list({ prefix: "uploads/shop/", startAfter: "uploads/shop/q1.png", limit: 2 });
    const p2 = await B.list({ prefix: "uploads/shop/", startAfter: "uploads/shop/q1.png", limit: 2, cursor: p.cursor });
    ok("…and pages on from there with the cursor", p.objects.map(o => o.key).join() === "uploads/shop/q2.png,uploads/shop/q3.png" && p2.objects.map(o => o.key).join() === "uploads/shop/q4.png,uploads/shop/q5.png");
    ok("FileStore.list reads startAfter too", s2.list("images", { prefix: "uploads/", startAfter: "uploads/shop/q4.png" }).objects.map(o => o.key).join() === "uploads/shop/q5.png");
  }

  console.log("\n=== Wired into the program ===");
  const serverSrc = fs.readFileSync(path.join(__dirname, "desktop/server.js"), "utf8");
  ok("the program gives the Worker these buckets, not Miniflare's R2", /wrappedBindings: \{ IMAGES: bucket\("images"\), RECEIPTS: bucket\("receipts"\), DESIGNS: bucket\("designs"\) \}/.test(serverSrc) &&
    !/r2Persist: paths\.r2,\n/.test(serverSrc.split("async function copyOldR2_")[0]));
  ok("…keeps them under state/, so backups and restores carry them", /files: path\.join\(state, "files"\)/.test(serverSrc));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "desktop/package.json"), "utf8"));
  ok("…and the packaged program includes both files", ["files.js", "r2-files-binding.mjs"].every(f => pkg.build.files.includes(f)));
  fs.rmSync(root, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
