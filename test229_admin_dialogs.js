const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");

// Admin pop-up windows behave as dialogs for keyboard and screen-reader users, the older hand-built prompts follow the
// same Escape rule as the shared window, a form window asks before throwing typed work away, and the four questions
// that used the browser's prompt() (which the desktop edition doesn't have) ask in the admin's own window.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const ok = (d, v) => console.log(d + ":", !!v);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 5));
(async () => {
  const adminJs = read("public/admin.js"), indexHtml = read("public/index.html");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const dom = new JSDOM(indexHtml, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window, d = w.document;
  await tick(150);
  await w.loadAdminScript();
  const key = (k, o) => d.activeElement.dispatchEvent(new w.KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, o || {})));

  console.log("=== The shared window is a dialog ===");
  d.body.insertAdjacentHTML("beforeend", `<button id="opener">Open</button>`);
  d.getElementById("opener").focus();
  const m = w.inventoryModal_("Edit thread", `<label for="f1">Name</label><input id="f1"><select id="f2"><option>a</option></select><button id="save">Save</button>`);
  const box = m.ov.firstElementChild;
  ok("role=dialog and aria-modal on the box", box.getAttribute("role") === "dialog" && box.getAttribute("aria-modal") === "true");
  ok("…labelled by its title", d.getElementById(box.getAttribute("aria-labelledby")).textContent === "Edit thread");
  ok("focus moves to the first field when it opens", d.activeElement === d.getElementById("f1"));
  d.getElementById("save").focus();
  key("Tab");
  ok("Tab from the last control wraps to the first (✕), not the page behind", d.activeElement === box.querySelector("[data-modal-close]"));
  key("Tab", { shiftKey: true });
  ok("Shift+Tab from the first wraps to the last", d.activeElement === d.getElementById("save"));
  d.getElementById("opener").focus();
  key("Tab");
  ok("Tab while focus is behind the window brings it back inside", box.contains(d.activeElement));
  m.close();
  await tick();
  ok("closing it puts focus back on what opened it", d.activeElement === d.getElementById("opener"));

  console.log("\n=== Confirm windows start on the answer ===");
  d.getElementById("opener").focus();
  let q = w.askConfirm_("Delete this thread?");
  await tick();
  ok("a Delete question starts on Cancel (Enter again doesn't open a second window or delete)", d.activeElement && d.activeElement.id === "cmCancel");
  key("Enter"); d.activeElement.click();
  ok("…which answers no", (await q) === false && d.querySelectorAll(".confirm-modal").length === 0);
  await tick();
  ok("…and focus goes back to the opener", d.activeElement === d.getElementById("opener"));
  q = w.askConfirm_("Mark this order shipped?");
  await tick();
  ok("a plain question starts on its OK button", d.activeElement && d.activeElement.id === "cmOk");
  d.activeElement.click(); await q;

  console.log("\n=== Older prompts: Escape works after typing, and only on the top window ===");
  const t = w.showTrackingModal("Mark shipped");
  const ti = d.querySelector(".tracking-input");
  ok("the tracking prompt is a dialog labelled by its title", ti.closest("[role=dialog]") && d.getElementById(ti.closest("[role=dialog]").getAttribute("aria-labelledby")).textContent === "Mark shipped");
  ti.value = "1Z999";
  ti.dispatchEvent(new w.KeyboardEvent("keydown", { key: "1", bubbles: true }));
  ti.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok("Escape still closes it after other keys were typed", (await t) === undefined && !d.querySelector(".tracking-input"));
  const under = w.inventoryModal_("Under", `<input id="u1">`).ov;
  const t2 = w.showTrackingModal("On top");
  key("Escape");
  ok("Escape closes the prompt on top, not the window under it", (await t2) === undefined && under.isConnected);
  key("Escape");
  ok("…the next Escape closes the window under it", !under.isConnected);
  ok("no hand-built Escape listener that a first keystroke removes ({once: true}) is left", !/once:\s*true/.test(adminJs));
  ok("prompts sit at the same level as other windows, so the one opened last is on top", /\.admin-pass-overlay\{[^}]*z-index:9999/.test(indexHtml) && !/style\.zIndex = "100\d"/.test(adminJs));
  ok("prompt fields are 16px on a phone too (no iOS zoom)", /\.admin-pass-overlay input:not\(\[type=checkbox\]\)[^{]*\.admin-pass-overlay textarea\{font-size:16px!important;\}/.test(indexHtml));

  console.log("\n=== A form window asks before throwing typed work away ===");
  let closed = 0;
  const g = w.inventoryModal_("New blank", `<input id="g1">`, 400, { guard: true, onClose: () => closed++ });
  g.ov.querySelector("[data-modal-close]").click();
  await tick();
  ok("untouched: ✕ closes it straight away", !g.ov.isConnected && closed === 1);
  const g2 = w.inventoryModal_("New blank", `<input id="g2">`, 400, { guard: true, onClose: () => closed++ });
  d.getElementById("g2").value = "Navy";
  d.getElementById("g2").dispatchEvent(new w.Event("input", { bubbles: true }));
  key("Escape");
  await tick();
  const ask = d.querySelector(".confirm-modal");
  ok("after typing, Escape asks 'Discard changes?' and keeps the form open", ask && /Discard changes\?/.test(ask.querySelector("h3").textContent) && g2.ov.isConnected);
  ask.querySelector("#cmCancel").click();
  await tick();
  ok("…Keep editing leaves the form and what was typed", g2.ov.isConnected && d.getElementById("g2").value === "Navy" && closed === 1);
  g2.ov.querySelector("[data-modal-close]").click();
  await tick();
  d.querySelector(".confirm-modal #cmOk").click();
  await tick();
  ok("…Discard closes it", !g2.ov.isConnected && closed === 2);
  ok("the blank, thread, hoop, stock, receive and expense forms turn the guard on", (adminJs.match(/guard: true/g) || []).length >= 6);

  console.log("\n=== No browser prompt() left ===");
  const code = adminJs.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  ok("admin.js never calls prompt() (the desktop edition has none)", !/(^|[^.\w])prompt\(|window\.prompt\(/.test(code));
  let a = w.askText_("Set the stitch count?", { label: "Stitches", value: "1,200", validate: (x) => /^\d[\d,]*$/.test(x) ? { value: x.replace(/,/g, "") } : "Enter a whole number." });
  await tick();
  const inp = d.getElementById("cmInput");
  ok("askText_ shows a labelled box with the starting value, focused", inp && inp.value === "1,200" && d.activeElement === inp && d.querySelector("label[for=cmInput]").textContent === "Stitches");
  inp.value = "abc";
  d.getElementById("cmOk").click();
  await tick();
  ok("a wrong value is explained in the window, which stays open", /whole number/.test(d.getElementById("cmInputErr").textContent) && d.getElementById("cmInput"));
  inp.value = "12,500";
  inp.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  ok("Enter saves; it resolves the cleaned-up value", (await a) === "12500");
  a = w.askText_("Record this order as placed?", { label: "Vendor order # (optional)" });
  await tick();
  d.getElementById("cmCancel").click();
  ok("Cancel resolves null", (await a) === null);

  console.log("\n=== Labels name their fields; Home's order rows open from the keyboard ===");
  const pm = w.inventoryModal_("Payments", `<div><label>Amount ($)</label><input id="pmAmountX" type="number"></div><div><label>Paid by</label><select><option>Cash</option></select></div><label>Wraps <input id="wrapX"></label><label>Heading only</label><div>not a field</div>`);
  const labels = [...pm.ov.querySelectorAll("label")];
  ok("a text label just before its field is tied to it (for= its id)", labels[0].htmlFor === "pmAmountX" && labels[1].htmlFor && d.getElementById(labels[1].htmlFor).tagName === "SELECT");
  ok("…a label that wraps its field, or sits before something else, is left alone", !labels[2].htmlFor && !labels[3].htmlFor);
  pm.close();
  d.body.insertAdjacentHTML("beforeend", `<div id="pageX"><label>Reference</label><input id="refX"></div>`);
  await tick(20);
  ok("…on pages too, as they are drawn", d.querySelector("#pageX label").htmlFor === "refX");
  ok("Home's order rows (both lists) carry a real button for the order, so Tab + Enter opens it", (adminJs.match(/\$\{dashOpenBtn_\(o\)\}/g) || []).length === 2 &&
    /function dashOpenBtn_\(o\)\{\n  return `<button type="button" class="dash-open" aria-label="Open order/.test(adminJs));
  d.body.insertAdjacentHTML("beforeend", `<table><tr class="dash-row" id="rowX">${"<td>" + w.dashOpenBtn_({ orderId: "ORD-9" }) + "</td>"}</tr></table>`);
  let opened = 0; d.getElementById("rowX").onclick = () => opened++;
  d.querySelector("#rowX .dash-open").click();
  ok("…and pressing it opens the row's order", opened === 1);

  console.log("\n=== Deletes ask first ===");
  const handler = (action) => { const i = adminJs.indexOf(`action: "${action}"`); return adminJs.slice(adminJs.lastIndexOf("btn.onclick = async () => {", i), i); };
  ok("deleting an order line's file asks first (it's gone for good, beside Download)", /askConfirm_\(`Delete this file from the order line\?/.test(handler("deleteOrderItemFile")));
  ok("removing a spool size from a thread's inventory asks first", /askConfirm_\("Remove this spool size from the thread's inventory\?/.test(handler("deleteThreadInventory")));
  process.exit(0);
})().catch(e => { console.error(e); console.log("test crashed: false"); process.exit(1); });
