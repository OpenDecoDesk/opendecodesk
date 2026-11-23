const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader } = require("jsdom");

// Searchable thread picker (2026-11). Every thread dropdown — a design's colours when uploading its files, Edit
// colours, a machine's needles — is a box to type in. The list narrows by brand, type, weight, code or name (the
// Threads screen's own search, threadMatches_), from the threads the page already holds: no request is sent. The
// <select> stays, hidden, as the value, so each screen's change handler and what it saves are unchanged.
// Real admin.js in jsdom. Invented threads only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

const THREADS = [
  { id: 1, brand: "Madeira", type: "Rayon", weight: "40", code: "1000", name: "Black", colorHex: "000000" },
  { id: 2, brand: "Madeira", type: "Rayon", weight: "40", code: "1147", name: "Christmas Red", colorHex: "cc2222" },
  { id: 3, brand: "Isacord", type: "Poly", weight: "40", code: "0015", name: "White", colorHex: "ffffff" },
  { id: 4, brand: "Isacord", type: "Poly", weight: "60", code: "1902", name: "Poppy", colorHex: "dd3311" },
  { id: 5, brand: "Robison-Anton", type: "Rayon", weight: "40", code: "2263", name: "Navy", colorHex: "112244" },
];

(async () => {
  const adminJs = read("public/admin.js");
  const requests = [];
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.TextDecoder = TextDecoder;
      win.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {} });
      win.fetch = async (u, init) => { requests.push(init && init.body ? JSON.parse(init.body) : { url: String(u) }); return { ok: true, status: 200, json: async () => ({ status: "ok" }) }; };
    } });
  const w = dom.window, d = w.document;
  await tick(150);
  await w.loadAdminScript();
  const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const type = (el, text) => { el.value = text; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
  const optionsText = (input) => [...d.getElementById(input.getAttribute("aria-controls")).querySelectorAll("[role=option]")].map(li => li.textContent);

  console.log("=== The search (threadMatches_) ===");
  const m = (q) => THREADS.filter(t => w.threadMatches_(t, q)).map(t => t.id).join(",");
  ok("by code", m("1147") === "2");
  ok("by brand, any case", m("isacord") === "3,4");
  ok("by name, part of a word", m("red") === "2");
  ok("by type and weight", m("poly 60") === "4");
  ok("several words narrow (brand + code)", m("madeira 1000") === "1" && m("madeira 0015") === "");
  ok("an empty search matches everything", m("  ") === "1,2,3,4,5");

  console.log("\n=== One picker ===");
  const host = d.createElement("div");
  host.innerHTML = `<select class="probe" style="font-size:13px;">${w.designThreadRowsHtml_(THREADS)(2)}</select>`;
  d.body.appendChild(host);
  const sel = host.querySelector("select");
  let changes = 0; sel.addEventListener("change", () => changes++);
  const input = w.threadPicker_(sel, THREADS);
  ok("the select is kept, hidden, with its value; a search box shows the chosen thread", sel.hidden && sel.value === "2" && input.value === "Madeira Rayon 40 1147 — Christmas Red");
  ok("…the box is a combobox tied to its list", input.getAttribute("role") === "combobox" && d.getElementById(input.getAttribute("aria-controls")).getAttribute("role") === "listbox");
  const before = requests.length;
  input.focus(); type(input, "isa");
  ok("typing opens the list with only the matches (plus the empty choice)", input.getAttribute("aria-expanded") === "true" && optionsText(input).length === 3 &&
    optionsText(input).slice(1).every(t => /Isacord/.test(t)) && /pick a thread/.test(optionsText(input)[0]));
  type(input, "poppy");
  ok("…narrowing by name", optionsText(input).length === 2 && /1902 — Poppy/.test(optionsText(input)[1]));
  ok("searching sends nothing to the server", requests.length === before);
  key(input, "Enter");
  ok("Enter picks the highlighted match: the select changes and its change event fires", sel.value === "4" && changes === 1 && input.getAttribute("aria-expanded") === "false" && /Poppy/.test(input.value));
  type(input, "navy"); key(input, "Escape");
  ok("Escape closes the list and puts the chosen thread's name back, unchanged", sel.value === "4" && /Poppy/.test(input.value) && changes === 1);
  type(input, "zzz");
  ok("no match says so", /No thread matches “zzz”/.test(d.getElementById(input.getAttribute("aria-controls")).textContent));
  key(input, "Escape");
  input.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  key(input, "ArrowDown");
  const list = d.getElementById(input.getAttribute("aria-controls"));
  const black = [...list.querySelectorAll("[role=option]")].find(li => /Black/.test(li.textContent));
  black.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  ok("clicking a thread in the full list picks it", sel.value === "1" && changes === 2 && /Black/.test(input.value));
  type(input, ""); key(input, "ArrowUp"); key(input, "ArrowUp");
  ok("the arrows move through the list; the active one is announced", input.getAttribute("aria-activedescendant") === list.querySelector(".active").id);
  const none = list.querySelector(".thread-pick-none");
  none.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  ok("the empty choice clears it", sel.value === "" && input.value === "" && changes === 3);
  sel.value = "5"; sel.dispatchEvent(new w.Event("change"));
  ok("a value set on the select by the screen shows in the box", /Navy/.test(input.value));
  sel.disabled = true; await tick();
  ok("a disabled select disables the box (a role that can't edit)", input.disabled);

  console.log("\n=== Long lists ===");
  const many = Array.from({ length: 250 }, (_, i) => ({ id: 100 + i, brand: "Chart", type: "Poly", weight: "40", code: String(5000 + i), name: "Shade " + i, colorHex: "336699" }));
  const host2 = d.createElement("div");
  host2.innerHTML = `<select>${w.designThreadRowsHtml_(many)("")}</select>`;
  d.body.appendChild(host2);
  const in2 = w.threadPicker_(host2.querySelector("select"), many);
  in2.focus(); type(in2, "chart");
  const l2 = d.getElementById(in2.getAttribute("aria-controls"));
  ok("at most 100 matches are drawn, and the rest are counted", l2.querySelectorAll("[role=option]").length === 101 && /150 more/.test(l2.textContent));
  type(in2, "5249");
  ok("…typing the code finds one past the first 100", l2.querySelectorAll("[role=option]").length === 2 && /Shade 249/.test(l2.textContent));
  key(in2, "Escape");

  console.log("\n=== Upload the design's files: the colour rows ===");
  w._dsgCtx = { threads: THREADS };
  w.showDesignVersionUploadModal_(1, null);
  await tick();
  const vRows = () => [...d.querySelectorAll(".dsgvThreadSelect")];
  ok("each colour row is a search box over its select", vRows().length >= 1 && vRows().every(s => s.hidden && s.parentElement.querySelector(".thread-pick-input")));
  const vIn = vRows()[0].parentElement.querySelector(".thread-pick-input");
  vIn.focus(); type(vIn, "1147"); key(vIn, "Enter"); await tick();
  ok("picking by code sets that row (the rows redraw with it chosen)", vRows()[0].value === "2" && /Christmas Red/.test(vRows()[0].parentElement.querySelector(".thread-pick-input").value));
  [...d.querySelectorAll(".admin-pass-overlay, .admin-modal")].forEach(o => o.remove());

  console.log("\n=== Edit colours ===");
  w.designApi_ = async () => ({ status: "ok" }); w.showToast = () => {};
  w.showEditVersionColorsModal_({ id: 7, designId: 3, machineFileExt: "dst", machineFileKey: "k", machineFileName: "logo.dst",
    threadColors: [{ needle: 1, threadId: 1 }, { needle: 2, threadId: 3 }] }, null);
  await tick();
  const cRows = () => [...d.querySelectorAll(".dsgcThreadSelect")];
  ok("both saved colours show by name in their search boxes", cRows().length === 2 && cRows().map(s => s.parentElement.querySelector(".thread-pick-input").value).join("|") === "Madeira Rayon 40 1000 — Black|Isacord Poly 40 0015 — White");
  const cIn = cRows()[1].parentElement.querySelector(".thread-pick-input");
  cIn.focus(); type(cIn, "robison navy"); key(cIn, "Enter"); await tick();
  ok("a two-word search picks the second colour", cRows()[1].value === "5");
  [...d.querySelectorAll(".admin-pass-overlay, .admin-modal")].forEach(o => o.remove());

  console.log("\n=== Machines: each needle ===");
  const machine = { id: 9, name: "Machine 1", needleCount: 3, ipAddress: "", embDir: "", hoopIds: [], needles: { 1: 2 }, currentHoopId: null, maintenance: [], maintenanceDue: [], stitchCount: 0, runSeconds: 0 };
  const sent = [];
  w.machineApi_ = async (b) => { sent.push(b); if (b.action === "listMachines") return { status: "ok", machines: [machine] }; if (b.action === "setMachineNeedle") return { status: "ok" }; return { status: "ok" }; };
  w.hoopApi_ = async (b) => (b.action === "listHoops" ? { status: "ok", hoops: [] } : { status: "ok" });
  w.threadApi_ = async (b) => (b.action === "listThreads" ? { status: "ok", threads: THREADS } : { status: "ok" });
  w.eval('adminKey = "cookie";');
  const app = d.getElementById("app");
  await w.renderMachines(app);
  await tick(50);
  const needles = () => [...d.querySelectorAll(".mchNeedleSelect")];
  ok("every needle's thread is a search box (3 needles)", needles().length === 3 && needles().every(s => s.hidden && s.parentElement.querySelector(".thread-pick-input")));
  ok("…needle 1 shows its saved thread; the box says which needle it is", /Christmas Red/.test(needles()[0].parentElement.querySelector(".thread-pick-input").value) &&
    needles()[1].parentElement.querySelector(".thread-pick-input").getAttribute("aria-label") === "Needle 2 thread");
  const nIn = needles()[1].parentElement.querySelector(".thread-pick-input");
  nIn.focus(); type(nIn, "white"); key(nIn, "Enter"); await tick(50);
  ok("picking a thread for needle 2 saves it, as the dropdown did", sent.some(b => b.action === "setMachineNeedle" && b.needle === 2 && String(b.threadId) === "3"));
  w.machineApi_ = async (b) => { if (b.action === "setMachineNeedle") throw new Error("offline"); return { status: "ok", machines: [machine] }; };
  nIn.focus(); type(nIn, "navy"); key(nIn, "Enter"); await tick(50);
  ok("a save that fails puts the box back to the saved thread", needles()[1].value === "3" && /White/.test(nIn.value));

  console.log("\n=== The Threads screen uses the same search ===");
  ok("its filter is threadMatches_", /const filtered = !q \? threads : threads\.filter\(t => threadMatches_\(t, q\)\)/.test(adminJs));

  dom.window.close();
  if (failed) console.log("\nFAILED:", failed);
})().catch(e => { console.log("crashed: false"); console.error(e); process.exit(1); });
