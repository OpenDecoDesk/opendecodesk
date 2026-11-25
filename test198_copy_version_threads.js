const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader } = require("jsdom");

// Upload design version: "Copy threads from previous version" copies the thread map of the design's
// current (newest) version onto the one being added, stop by stop by needle position, and says what
// was left out when the new machine file has a different number of needle stops.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const STITCH = [0x00, 0x00, 0x03], CC = [0x00, 0x00, 0xC3], END = [0x00, 0x00, 0xF3];
const dst = (...recs) => {
  const header = Buffer.alloc(512, 0x20);
  header.write("LA:TEST\r", 0, "latin1");
  return new Uint8Array(Buffer.concat([header, Buffer.from(recs.flat())])).buffer;
};
const s = (n) => Array.from({ length: n }, () => STITCH);
const stops = (n) => { const r = []; for (let i = 0; i < n; i++) { if (i) r.push(CC); r.push(...s(3)); } r.push(END); return dst(...r); };
const tick = (ms) => new Promise(res => setTimeout(res, ms || 20));

(async () => {
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.TextDecoder = TextDecoder;
      win.HTMLCanvasElement.prototype.getContext = () => ({ clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, fillText(){} });
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window, doc = w.document;
  await tick(150);
  await w.loadAdminScript();

  const threads = [1, 2, 3, 4].map(id => ({ id, brand: "Madeira", type: "Rayon", weight: "40", code: "100" + id, name: "Color " + id, colorHex: "11111" + id }));
  const byId = {}; threads.forEach(t => { byId[t.id] = t; });
  const prevMap = [{ needle: 1, threadId: 1 }, { needle: 2, threadId: 2 }, { needle: 3, threadId: 3 }];

  console.log("=== copyPreviousThreadMap_ ===");
  let r = w.copyPreviousThreadMap_(prevMap, 3, byId);
  console.log("same stop count: every stop copied in order, nothing left out:",
    r.rows.map(x => x.threadId).join() === "1,2,3" && r.copied.length === 3 && !r.leftOut.length && !r.empty.length);
  r = w.copyPreviousThreadMap_(prevMap, 2, byId);
  console.log("fewer stops: the first stops copied, the extra old needle left out:",
    r.rows.map(x => x.threadId).join() === "1,2" && r.leftOut.length === 1 && r.leftOut[0].needle === 3 && r.leftOut[0].threadId === 3);
  r = w.copyPreviousThreadMap_(prevMap, 5, byId);
  console.log("more stops: old needles copied, the new stops stay empty and are listed:",
    r.rows.map(x => x.threadId).join() === "1,2,3,," && r.empty.join() === "4,5" && !r.leftOut.length);
  r = w.copyPreviousThreadMap_([{ needle: 3, threadId: 3 }, { needle: 1, threadId: 1 }], 3, byId);
  console.log("copied by needle position, not list order (a gap stays a gap):", r.rows.map(x => x.threadId).join() === "1,,3" && r.empty.join() === "2");
  r = w.copyPreviousThreadMap_([{ needle: 1, threadId: 1 }, { needle: 2, threadId: 99 }], 2, byId);
  console.log("a thread no longer in the catalog isn't copied, and is reported:", r.rows.map(x => x.threadId).join() === "1," && r.unknown.length === 1 && r.unknown[0].threadId === 99);
  r = w.copyPreviousThreadMap_(prevMap, 0, byId);
  console.log("no stop count yet: the whole map is copied:", r.rows.map(x => x.threadId).join() === "1,2,3" && !r.empty.length);
  const note = w.copyThreadMapNoteHtml_(w.copyPreviousThreadMap_(prevMap, 2, byId), byId);
  console.log("the note names the stop and thread that were left out:", /Copied 2 threads/.test(note) && /Left out/.test(note) && /stop 3 \(Madeira 1003 Color 3\)/.test(note));

  console.log("\n=== Upload version window ===");
  w._dsgCtx = { threads };
  w.showToast = () => {};
  let saved = null, versions = [];
  w.designApi_ = async (body) => {
    if (body.action === "getDesign") return { status: "ok", design: { id: 5, name: "Logo" }, versions };
    if (body.action === "saveDesignVersion") { saved = body; return { status: "ok", id: 9 }; }
    return { status: "ok" };
  };
  const open = async () => { w.showDesignVersionUploadModal_(5, null); await tick(); };
  const btn = () => [...doc.querySelectorAll("#dsgvCopyPrev")].pop();
  const vals = () => [...doc.querySelectorAll(".dsgvThreadSelect")].map(x => x.value).join();
  const noteText = () => ([...doc.querySelectorAll("#dsgvCopyNote")].pop() || {}).textContent || "";
  const pick = async (name, buf) => {
    const input = [...doc.querySelectorAll("#dsgvMachineFile")].pop();
    Object.defineProperty(input, "files", { value: [{ name, arrayBuffer: async () => buf }], configurable: true });
    input.dispatchEvent(new w.Event("change"));
    await tick();
  };
  const closeAll = () => doc.querySelectorAll("#dsgvCancel").forEach(b => b.click());

  versions = [];
  await open();
  console.log("a design with no earlier version: the copy button is there but off:", !!btn() && btn().disabled === true && /no earlier version/.test(btn().title));
  closeAll();

  versions = [{ id: 7, designId: 5, uploadedAt: "2026-11-01", threadColors: [] }, { id: 6, designId: 5, uploadedAt: "2026-10-01", threadColors: prevMap }];
  await open();
  console.log("previous = the current (newest) version; with no thread map it's off:", btn().disabled === true && /no thread colors/.test(btn().title));
  closeAll();

  versions = [{ id: 8, designId: 5, uploadedAt: "2026-11-10", threadColors: prevMap }, { id: 6, designId: 5, uploadedAt: "2026-10-01", threadColors: [{ needle: 1, threadId: 4 }] }];
  await open();
  console.log("previous version has a thread map: the button is on:", btn().disabled === false && /2026-11-10/.test(btn().title));
  await pick("logo.dst", stops(2));
  btn().click(); await tick();
  console.log("new file has 2 stops (old had 3): stops 1-2 copied:", vals() === "1,2");
  console.log("...and the window says stop 3 was left out:", /Copied 2 threads/.test(noteText()) && /Left out/.test(noteText()) && /stop 3/.test(noteText()));
  const dsgFile = [...doc.querySelectorAll("#dsgvDesignFile")].pop();
  Object.defineProperty(dsgFile, "files", { value: [{ name: "logo.emb" }], configurable: true });
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "ok", key: "k", name: "f", ext: "dst" }) });
  [...doc.querySelectorAll("#dsgvSave")].pop().click(); await tick(50);
  console.log("Upload saves the copied map onto the new version:", !!(saved && saved.designId === 5 &&
    JSON.stringify(saved.threadColors) === JSON.stringify([{ needle: 1, threadId: 1 }, { needle: 2, threadId: 2 }])));
  closeAll();

  await open();
  await pick("logo.dst", stops(5));
  btn().click(); await tick();
  console.log("new file has 5 stops: 3 copied, stops 4-5 left to pick and said so:", vals() === "1,2,3,," && /Still to pick/.test(noteText()) && /stops 4, 5/.test(noteText()));
  closeAll();

  await open();
  btn().click(); await tick();
  console.log("copied before choosing the file: the whole map, with a reminder to choose it:", vals() === "1,2,3" && /Choose the machine file/.test(noteText()));
  await pick("logo.dst", stops(2));
  console.log("then a 2-stop file: copied again to fit, stop 3 left out:", vals() === "1,2" && /stop 3/.test(noteText()) && !/Choose the machine file/.test(noteText()));
  closeAll();

  w.showDesignVersionUploadModal_(null, null, { itemId: 44, threads });
  await tick();
  console.log("an order-specific design upload has no copy button (no previous version):", !btn() || doc.querySelectorAll("#dsgvCopyPrev").length === 0);
})().catch(e => { console.log("test198 crashed:", false); console.error(e); process.exit(1); });
