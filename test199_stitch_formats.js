const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");

// Designs read the other machine-file formats (public/admin-stitch.js): needle stops, stitches and the file's own
// thread colors. A color the file names is matched to the thread catalog — picked automatically on an exact match,
// flagged red when nothing in the catalog matches, amber when the picked thread has none on hand. Every file here
// is made up in code; the catalog threads use an invented brand.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const tick = (ms) => new Promise(res => setTimeout(res, ms || 20));
// Closes the windows a step left open, so the next one's rows are the only ones on the page.
const closeAll = (doc) => doc.querySelectorAll("#dsgvCancel, #dsgcCancel").forEach(b => b.click());
let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(name + ":", !!cond); cond ? pass++ : fail++; };
const buf = (...parts) => new Uint8Array(Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p.flat ? p.flat(9) : p)))).buffer;
const u16le = (n) => [n & 255, (n >> 8) & 255], u16be = (n) => [(n >> 8) & 255, n & 255];
const u32le = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255], u32be = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const zeros = (n) => Buffer.alloc(n);
const rgb = (hex) => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
const pstr = (s) => [s.length, ...Buffer.from(s, "latin1")];          // PES: length byte + text
const vstr = (s) => [...u16be(s.length), ...Buffer.from(s, "latin1")]; // VP3: 16-bit big-endian length + text

// ---- Made-up files ----
// PEC stitch block: n short stitches of +2,+1 per block, a color change (FE B0 xx) between blocks.
const pecStitches = (blocks) => { const r = []; blocks.forEach((n, i) => { if (i) r.push(0xFE, 0xB0, 0x02); for (let k = 0; k < n; k++) r.push(2, 1); }); r.push(0xFF, 0x00); return r; };
const pecBlock = (colorIdx, blocks) => [Buffer.from("LA:"), zeros(16), zeros(0xF), [0, 0], zeros(0xC), [colorIdx.length - 1], colorIdx,
  zeros(0x1D0 - (colorIdx.length - 1)), [0, 0, 0], zeros(0x0B), pecStitches(blocks)];
const pec = (colorIdx, blocks) => buf(Buffer.from("#PEC0001"), ...pecBlock(colorIdx, blocks));
// PES v6 with its thread list (code, color, name, brand) in the header, then the PEC block.
const pes6 = (threads, blocks) => {
  const head = [zeros(4), pstr(""), pstr(""), pstr(""), pstr(""), pstr(""), zeros(36), pstr(""), zeros(24), u16le(0), u16le(0), u16le(0), u16le(threads.length),
    ...threads.map(t => [pstr(t.code), rgb(t.hex), [0, 0, 0, 0, 0], pstr(t.name), pstr(t.brand), pstr("")])];
  const headBuf = Buffer.from(Buffer.concat(head.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p.flat ? p.flat(9) : p))));
  const pecAt = 8 + 4 + headBuf.length;
  return buf(Buffer.from("#PES0060"), u32le(pecAt), headBuf, ...pecBlock(threads.map((_, i) => i + 1), blocks));
};
// JEF: chart positions; 0 = a stop, not a color. 80 01 = color change, 80 10 = end.
const jef = (chartIdx, blocks) => {
  const st = []; blocks.forEach((n, i) => { if (i) st.push(0x80, 0x01, 0, 0); for (let k = 0; k < n; k++) st.push(3, 2); }); st.push(0x80, 0x10);
  const head = [u32le(0), zeros(20), u32le(chartIdx.length), zeros(88), ...chartIdx.map(u32le)];
  const len = 4 + 20 + 4 + 88 + chartIdx.length * 4;
  head[0] = u32le(len);
  return buf(...head, st);
};
// VP3: one color block per thread, each with its color, code, name and brand.
const vp3 = (threads, perBlock) => {
  const blocks = threads.map(t => {
    const stitches = []; for (let k = 0; k < perBlock; k++) stitches.push(4, 4);
    const body = Buffer.concat([Buffer.from([...u32be(0), ...u32be(0), 1, 0, ...rgb(t.hex), 0, ...u16be(0), 0, 0, ...vstr(t.code), ...vstr(t.name), ...vstr(t.brand)]), zeros(15), Buffer.from([0x0A, 0xF6, 0]), Buffer.from(stitches)]);
    return Buffer.concat([Buffer.from([0, 5, 0]), Buffer.from(u32be(body.length)), body]);
  });
  return buf(Buffer.from("%vsm%\0"), vstr(""), zeros(7), vstr(""), zeros(32), u32be(0), u32be(0), zeros(27), vstr(""), zeros(24), vstr(""), u16be(threads.length), ...blocks);
};
// XXX: stitches from 0x100, 7F 08 = color change, 7F 7F = end, then the colors.
const xxx = (hexes, blocks) => {
  const head = zeros(0x100); head.writeUInt16LE(hexes.length, 0x27);
  const st = []; blocks.forEach((n, i) => { if (i) st.push(0x7F, 0x08, 0, 0); for (let k = 0; k < n; k++) st.push(5, 3); }); st.push(0x7F, 0x7F, 0, 0);
  return buf(head, st, [0, 0], ...hexes.map(h => [0, ...rgb(h)]));
};
// EXP: no colors. 80 01 = color change.
const exp = (blocks) => { const st = []; blocks.forEach((n, i) => { if (i) st.push(0x80, 0x01, 0, 0); for (let k = 0; k < n; k++) st.push(2, 2); }); return buf(st); };
// HUS: Husqvarna chart positions; the command/x/y streams are stored with the trivial "compressed" wrapper
// pyembroidery's writer uses (a header that sets a one-symbol table, then the bytes as they are).
const husStore = (bytes) => Buffer.concat([Buffer.from([bytes.length & 255, (bytes.length >> 8) & 255, 0x02, 0xA0, 0x01, 0xFE]), Buffer.from(bytes)]);
const hus = (chartIdx, blocks) => {
  const cmd = [], xs = [], ys = [];
  blocks.forEach((n, i) => { if (i) { cmd.push(0x84); xs.push(0); ys.push(0); } for (let k = 0; k < n; k++) { cmd.push(0x80); xs.push(3); ys.push(1); } });
  cmd.push(0x90); xs.push(0); ys.push(0);
  const c = husStore(cmd), x = husStore(xs), y = husStore(ys);
  const headLen = 4 + 4 + 4 + 8 + 12 + 8 + 2 + chartIdx.length * 2;
  return buf(u32le(0x00C8AF5B), u32le(cmd.length), u32le(chartIdx.length), zeros(8), u32le(headLen), u32le(headLen + c.length), u32le(headLen + c.length + x.length),
    zeros(8), u16le(0), ...chartIdx.map(u16le), c, x, y);
};
// DSZ: 512-byte header, [y, x, ctrl]; 0x83 + 2·(n−1) = needle n.
const dsz = (blocks) => { const r = []; blocks.forEach((n, i) => { r.push(0, 0, 0x83 + 2 * i); for (let k = 0; k < n; k++) r.push(1, 2, 0); }); return buf(zeros(512), r); };
// U01: 0x100 header, [ctrl, y, x]; 0x09 + (n−1) = needle n, 0x18 = end.
const u01 = (blocks) => { const r = []; blocks.forEach((n, i) => { r.push(0x89 + i, 0, 0); for (let k = 0; k < n; k++) r.push(0x80, 1, 2); }); r.push(0xF8, 0, 0); return buf(zeros(0x100), r); };
// DST with the "TC:" thread lines some design software writes in the header.
const dstTc = (tcLines, blocks) => {
  const header = Buffer.alloc(512, 0x20);
  header.write("LA:TEST\r" + tcLines.map(l => "TC:" + l + "\r").join(""), 0, "latin1");
  const r = []; blocks.forEach((n, i) => { if (i) r.push(0, 0, 0xC3); for (let k = 0; k < n; k++) r.push(1, 0, 3); }); r.push(0, 0, 0xF3);
  return buf(header, r);
};

(async () => {
  const adminJs = read("public/admin.js"), stitchJs = read("public/admin-stitch.js");
  let stitchLoads = 0;
  class L extends ResourceLoader { fetch(url, o){
    if (url.includes("/admin-stitch.js")) { stitchLoads++; return Promise.resolve(Buffer.from(stitchJs)); }
    if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs));
    return Promise.resolve(Buffer.from("")); } }
  const draws = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.TextDecoder = TextDecoder;
      win.HTMLCanvasElement.prototype.getContext = () => ({ clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, fillText(){},
        set strokeStyle(v){ draws.push(v); }, get strokeStyle(){ return ""; }, stroke(){} });
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window, doc = w.document;
  await tick(150);
  await w.loadAdminScript();

  console.log("=== The readers load only when needed ===");
  ok("a .dst doesn't load the extra readers", (await w.ensureStitchReaders_("a.dst"), stitchLoads === 0 && !w.StitchReaders));
  await w.ensureStitchReaders_("a.pes"); await w.ensureStitchReaders_("b.jef");
  ok("a .pes loads them once, and they stay loaded", stitchLoads === 1 && w.StitchReaders && w.StitchReaders.exts.includes("vp3"));
  ok("every format admin.js says it reads has a reader", w.eval("STITCH_PREVIEW_EXTS").filter(e => e !== "dst" && e !== "dsb").every(e => w.StitchReaders.exts.includes(e)));
  ok("formats with no reader say so", w.eval("!canPreviewStitch_('x.vip') && !canPreviewStitch_('x.csd') && !canPreviewStitch_('x.emb')"));

  console.log("\n=== Each reader: needle stops, stitches, the file's colors ===");
  const P = (b, ext) => w.parseStitchFile_(b, ext);
  let p = P(pes6([{ code: "01800", hex: "112233", name: "Navy", brand: "Sample Poly 40" }, { code: "77", hex: "abcdef", name: "Sky", brand: "Other Thread Co" }], [5, 4]), "logo.pes");
  ok("PES v6: 2 stops, 9 stitches", p.needleStops === 2 && p.stitchCount === 9 && p.colorChanges === 1);
  ok("PES v6: each stop's brand, code, name and color come from the header", p.fileColors[0].brand === "Sample Poly 40" && p.fileColors[0].code === "01800" && p.fileColors[0].hex === "112233" && p.fileColors[1].name === "Sky");
  ok("PES: Y points up and the size is in the stitches", p.bbox.maxX - p.bbox.minX === 16 && p.bbox.maxY - p.bbox.minY === 8 && p.stitches[1].y < p.stitches[0].y);
  p = P(pec([20, 5], [3, 3]), "logo.PEC");
  ok("PEC: chart positions give Brother's chart colors", p.needleStops === 2 && p.fileColors[0].hex === "000000" && p.fileColors[0].name === "Black" && p.fileColors[1].hex === "ed171f" && p.fileColors[0].brand === "Brother");
  p = P(jef([1, 0, 2], [4, 4, 4]), "x.jef");
  ok("JEF: chart position 0 is a stop, not a new color (2 stops)", p.needleStops === 2 && p.stitchCount === 12);
  ok("JEF: colors carry the maker's thread numbers", p.fileColors[0].code === "002" && p.fileColors[0].name === "Black" && p.fileColors[1].code === "001" && p.fileColors[1].brand === "Janome");
  p = P(vp3([{ code: "1800", hex: "112233", name: "Navy", brand: "Sample Poly 40" }, { code: "9", hex: "fedcba", name: "", brand: "Other" }], 6), "x.vp3");
  ok("VP3: a stop per color block, with its thread", p.needleStops === 2 && p.stitchCount === 12 && p.fileColors[0].code === "1800" && p.fileColors[1].hex === "fedcba");
  p = P(xxx(["ff0000", "00ff00", "0000ff"], [2, 2, 2]), "x.xxx");
  ok("XXX: the colors listed after the stitches", p.needleStops === 3 && p.fileColors.map(c => c.hex).join() === "ff0000,00ff00,0000ff" && !p.fileColors[0].brand);
  p = P(xxx(["ff0000", "00ff00"], [2, 0, 2]), "x.xxx");
  ok("a color block with no stitches isn't a stop, and the colors stay with their blocks", p.needleStops === 2 && p.fileColors.length === 2 && p.fileColors[0].hex === "ff0000" && p.fileColors[1] === null);
  p = P(exp([3, 3, 3]), "x.exp");
  ok("EXP: 3 stops, no colors in the file", p.needleStops === 3 && p.fileColors.every(c => c === null));
  p = P(hus([0, 12], [5, 5]), "x.hus");
  ok("HUS: decompressed; chart colors with the maker's numbers", p.needleStops === 2 && p.stitchCount === 10 && p.fileColors[0].code === "026" && p.fileColors[1].name === "White");
  p = P(dsz([2, 3]), "x.dsz");
  ok("DSZ: needle changes are stops; the needles are named", p.needleStops === 2 && p.stitchCount === 5 && p.needles.join() === "1,2");
  p = P(u01([2, 2, 2]), "x.u01");
  ok("U01: needle changes are stops", p.needleStops === 3 && p.needles.join() === "1,2,3");
  p = P(dstTc(["#112233,Navy,1800", "#ABCDEF,Sky,77"], [3, 3]), "x.dst");
  ok("DST: the header's TC lines are the stops' colors", p.needleStops === 2 && p.fileColors[0].hex === "112233" && p.fileColors[0].code === "1800" && p.fileColors[1].hex === "abcdef");
  p = P(dstTc([], [3, 3]), "x.dst");
  ok("DST without TC lines: no file colors (as before)", p.needleStops === 2 && p.fileColors.every(c => c === null));
  let err = ""; try { P(new Uint8Array(20).buffer, "x.pes"); } catch (e) { err = e.message; }
  ok("a file that isn't what its name says is refused", /too short|isn't a PES/.test(err));
  err = ""; try { P(exp([0]), "x.exp"); } catch (e) { err = e.message; }
  ok("a file with no stitches is refused", /No stitches found in this EXP/.test(err));
  err = ""; try { P(buf(Array.from({ length: 200 }, () => [100, 100]).flat()), "x.exp"); } catch (e) { err = e.message; }
  ok("a misread file (stitches over a metre across) is refused, not drawn", /couldn't be read/.test(err));

  console.log("\n=== Matching a file's colors to the thread catalog ===");
  const inv = (q) => [{ id: 1, quantity: q }];
  const threads = [
    { id: 1, brand: "Sample Poly", type: "", weight: "40", code: "1800", name: "Navy", colorHex: "112233", inventory: inv(3) },
    { id: 2, brand: "Sample Poly", type: "", weight: "40", code: "1801", name: "Black", colorHex: "000000", inventory: inv(0) },
    { id: 3, brand: "Other Thread Co", type: "", weight: "", code: "5", name: "Black", colorHex: "000000", inventory: inv(2) },
    { id: 4, brand: "Sample Poly", type: "", weight: "40", code: "1900", name: "Red", colorHex: "e01010", inventory: inv(1) },
    { id: 5, brand: "Brother Sample", type: "", weight: "", code: "B1", name: "Prussian Blue", colorHex: "0e1f7d", inventory: inv(1) },
  ];
  const byId = {}; threads.forEach(t => { byId[t.id] = t; });
  const M = (fc) => w.matchFileColor_(fc, threads);
  let m = M({ hex: "999999", brand: "Sample Poly 40", code: "01800", name: "" });
  ok("brand + thread number wins (leading zeros ignored), even when the color differs", m.thread && m.thread.id === 1 && m.by === "code");
  m = M({ hex: "000000", brand: "", code: "", name: "" });
  ok("same color: the one with stock on hand is picked", m.thread && m.thread.id === 3 && m.by === "color");
  m = M({ hex: "0e1f7c", brand: "Brother", code: "", name: "Prussian Blue", chart: "Brother chart 1" });
  ok("a maker's chart color matches that brand's thread by name", m.thread && m.thread.id === 5 && m.by === "name");
  m = M({ hex: "e01111", brand: "Default", code: "8", name: "" });
  ok("a placeholder brand (\"Default\") isn't a brand; a near color isn't a match", !m.thread && m.nearest[0].id === 4 && m.nearest.length === 3);
  m = M({ hex: "112233", brand: "Unrelated Brand", code: "1800", name: "" });
  ok("another brand's number doesn't match; its exact color still does", m.thread && m.thread.id === 1 && m.by === "color");
  ok("no file color: nothing to match", !M(null).thread);
  const rows = [{ threadId: "" }, { threadId: 4 }, { threadId: "" }];
  const n = w.autoPickFileColors_(rows, [{ hex: "112233", brand: "", code: "", name: "" }, { hex: "000000", brand: "", code: "", name: "" }, { hex: "abcdef", brand: "", code: "", name: "" }], threads);
  ok("auto-pick fills only empty stops, and only on an exact match", n === 1 && rows[0].threadId === 1 && rows[1].threadId === 4 && rows[2].threadId === "");
  const colorOf = w.dstColorForNeedle_([{ threadId: "" }, { threadId: 4 }, { threadId: "" }], byId, [{ hex: "abcdef" }, { hex: "000000" }, null]);
  ok("preview: the picked thread's color, else the file's, else a placeholder", colorOf(0) === "#abcdef" && colorOf(1) === "#e01010" && /^#[0-9a-f]{3,6}$/i.test(colorOf(2)) && colorOf(2) !== "#abcdef");

  console.log("\n=== Upload version window ===");
  w._dsgCtx = { threads };
  w.showToast = () => {};
  let saved = null, versions = [];
  w.designApi_ = async (body) => {
    if (body.action === "getDesign") return { status: "ok", design: { id: 5, name: "Logo" }, versions };
    if (body.action === "saveDesignVersion") { saved = body; return { status: "ok", id: 9 }; }
    return { status: "ok" };
  };
  const pick = async (name, b) => {
    const input = doc.getElementById("dsgvMachineFile");
    Object.defineProperty(input, "files", { value: [{ name, arrayBuffer: async () => b }], configurable: true });
    input.dispatchEvent(new w.Event("change"));
    await tick(60);
  };
  const sels = () => [...doc.querySelectorAll(".dsgvThreadSelect")].map(s => s.value);
  const stopsText = () => doc.getElementById("dsgvStops").textContent.replace(/\s+/g, " ");
  const notes = () => [...doc.querySelectorAll("#dsgvThreadRows .dsg-file-note")].map(e => e.textContent.replace(/\s+/g, " "));
  w.showDesignVersionUploadModal_(5, null);
  const file = vp3([{ code: "1800", hex: "445566", name: "Navy", brand: "Sample Poly 40" }, { code: "77", hex: "e01111", name: "Coral", brand: "Other" },
    { code: "1801", hex: "000000", name: "Black", brand: "Sample Poly 40" }], 4);
  await pick("design.VP3", file);
  ok("a .vp3 is read: its stops size the thread map", /3 needle stops/.test(stopsText()) && sels().length === 3);
  ok("stops the file names are picked from the catalog; the unknown one is left empty", sels().join() === "1,,2");
  ok("the summary says what was picked and what's missing", /2 picked from the file's colors/.test(stopsText()) && /1 not in the thread catalog/.test(stopsText()) && /1 none on hand/.test(stopsText()));
  ok("each row says what the file names", /File: Sample Poly 40 1800 Navy/.test(notes()[0]));
  ok("red flag on the color with no catalog thread, with the closest ones to pick", doc.querySelectorAll("#dsgvThreadRows .dsg-flag-missing").length === 1 && doc.querySelectorAll(".dsgvSuggest").length === 3 && /Not in thread catalog/.test(notes()[1]));
  ok("amber flag on the picked thread with none on hand", doc.querySelectorAll("#dsgvThreadRows .dsg-flag-nostock").length === 1 && /None on hand/.test(notes()[2]));
  ok("the preview draws the unmatched stop in the file's own color", draws.includes("#e01111"));
  doc.querySelector(".dsgvSuggest[data-tid='4']").click();
  ok("a closest-thread button picks it for that stop", sels()[1] === "4" && !doc.querySelector("#dsgvThreadRows .dsg-flag-missing ~ button.dsgvSuggest"));
  const sel0 = doc.querySelectorAll(".dsgvThreadSelect")[0]; sel0.value = "3"; sel0.dispatchEvent(new w.Event("change"));
  ok("any stop can still be changed by hand", sels()[0] === "3");
  await pick("design.VP3", file);
  ok("reading the file again leaves hand-picked stops alone", sels().join() === "3,4,2");

  console.log("\n=== Copy threads from previous version, then the file's colors ===");
  closeAll(doc);
  versions = [{ id: 7, uploadedAt: "2026-11-01", threadColors: [{ needle: 2, threadId: 3 }] }];
  w.showDesignVersionUploadModal_(5, null);
  await tick(30);
  doc.getElementById("dsgvCopyPrev").click();
  await pick("design.vp3", file);
  ok("copied stops are kept; the file's colors fill what's still empty", sels().join() === "1,3,2");
  doc.getElementById("dsgvDesignFile").dispatchEvent(new w.Event("change"));
  Object.defineProperty(doc.getElementById("dsgvDesignFile"), "files", { value: [{ name: "design.emb" }], configurable: true });
  w.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ status: "ok", key: "k/" + url.length, name: "f", ext: "x" }) });
  const sel1 = doc.querySelectorAll(".dsgvThreadSelect")[1]; sel1.value = ""; sel1.dispatchEvent(new w.Event("change"));
  doc.getElementById("dsgvSave").click(); await tick(60);
  ok("an empty stop between picked ones is saved as a gap: stop 3's thread stays needle 3",
    saved && JSON.stringify(saved.threadColors) === JSON.stringify([{ needle: 1, threadId: 1 }, { needle: 3, threadId: 2 }]));

  console.log("\n=== Thread stock not kept: no amber flags ===");
  closeAll(doc);
  const noStock = threads.map(t => Object.assign({}, t, { inventory: [] }));
  w._dsgCtx = { threads: noStock };
  versions = [];
  w.showDesignVersionUploadModal_(5, null);
  await pick("design.vp3", file);
  ok("without any thread stock kept, nothing says \"none on hand\"", !doc.querySelector("#dsgvThreadRows .dsg-flag-nostock") && !/none on hand/.test(stopsText()));

  console.log("\n=== Edit colors and Run Order ===");
  closeAll(doc);
  w._dsgCtx = { threads };
  w.fetchDesignFileBytes_ = async () => file;
  w.showEditVersionColorsModal_({ id: 3, uploadedAt: "2026-11-01", machineFileExt: "vp3", machineFileName: "design.vp3", machineFileKey: "k", threadColors: [{ needle: 3, threadId: 4 }] }, null);
  await tick(80);
  const ecSels = [...doc.querySelectorAll(".dsgcThreadSelect")].map(s => s.value);
  ok("Edit colors: empty stops filled from the file, the saved pick kept", ecSels.join() === "1,,4" && /filled from the file's colors/.test(doc.getElementById("dsgcInfo").textContent));
  ok("Edit colors: the red flag shows there too", doc.querySelectorAll("#dsgcThreadRows .dsg-flag-missing").length === 1);
  closeAll(doc);
  doc.body.insertAdjacentHTML("beforeend", `<div id="dsgList"></div><div id="dsgDetail"></div>`);
  w._dsgCtx = { orgId: "demo", orgName: "Demo", designs: [], hoops: [], threads, issues: null };
  w.designApi_ = async (body) => body.action === "getDesign" ? { status: "ok", design: { id: 5, name: "Logo", orgId: "demo", hoopIds: [] },
    versions: [{ id: 3, designId: 5, uploadedAt: "2026-11-01", designFileName: "d.emb", designFileKey: "d", machineFileName: "design.vp3", machineFileExt: "vp3", machineFileKey: "k",
      stitchCount: 12, notes: "", threadColors: [{ needle: 1, threadId: 1 }, { needle: 3, threadId: 2 }] }] } : { status: "ok" };
  await w.loadDesignDetail_(5); await tick(120);
  const mapText = doc.getElementById("dsgThreadMap").textContent.replace(/\s+/g, " ");
  ok("the design page lists every stop the file has, the empty one too, with its red flag",
    /1\. .*1800/.test(mapText) && /2\. no thread picked/.test(mapText) && /Not in thread catalog/.test(mapText) && /3\. .*1801/.test(mapText) && /None on hand/.test(mapText));
  ok("…without the pick buttons (those are in Edit colors)", !doc.querySelector("#dsgThreadMap button"));
  ok("Run Order draws a preview for every readable format", /canPreviewStitch_\(step\.machineFileName/.test(adminJs) && !/\\\.\(dst\|dsb\)\$\/i\.test\(step/.test(adminJs));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test199 crashed: false"); process.exit(1); });
