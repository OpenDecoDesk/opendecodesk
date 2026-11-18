// Read-only roles see no buttons they can't use (functions/_lib/permissions.js, public/admin.js adminApplyPerms_).
// A control says what it needs (data-need="fn:level", any of several with "|"; data-need-form locks a whole form);
// one watcher on the page hides what the signed-in role lacks, on every screen and popup. jsdom with the real
// index.html + admin.js, signed in as each built-in role.
const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { asRole, PERM_FUNCTIONS } = require("./testlib/roles");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const ok = (m, c) => console.log(m + ":", !!c);

(async () => {
  const adminJs = read("public/admin.js"), indexHtml = read("public/index.html");
  const HOOPS = [{ id: 1, name: "4in round", widthMm: 100, heightMm: 100, isCapFrame: false, notes: "", sortOrder: 0 }];
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(indexHtml, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = async (u, o) => {
        const b = (() => { try { return JSON.parse((o && o.body) || "{}"); } catch (e) { return {}; } })();
        const body = b.action === "listHoops" ? { status: "ok", hoops: HOOPS } : { status: "error", message: "n/a" };
        return { ok: true, status: 200, json: async () => body };
      };
    } });
  const w = dom.window, d = w.document;
  await new Promise(r => setTimeout(r, 150));
  await w.loadAdminScript();
  const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
  w.eval("adminKey = 'test-key';");
  const shown = (el) => !!el && !el.hasAttribute("data-perm-off") && w.getComputedStyle(el).display !== "none";

  console.log("=== The page hides what a role lacks ===");
  ok("one rule hides a control the role can't use, whatever the screen's own code sets", /\[data-perm-off\]\{display:none !important;\}/.test(indexHtml));
  const box = d.createElement("div");
  d.body.appendChild(box);
  const put = async (html) => { box.innerHTML = html; await tick(); return box; };
  w.eval(asRole("production"));
  await put(`<button id="a" data-need="production.hoops:edit">Edit</button><button id="b" data-need="production.maintenanceLog:edit">Done</button>
    <button id="c" data-need="catalog.designs:edit|run.runs:edit">Either</button><button id="e" data-need="production.hoops">No level means edit</button>
    <button id="r" data-need="production.hoops:read">Look</button>`);
  ok("Production: a hoop's Edit is hidden (Hoops is read-only for it)", !shown(d.getElementById("a")));
  ok("…logging maintenance done stays (it has Edit on that)", shown(d.getElementById("b")));
  ok("…any one of several needs is enough", shown(d.getElementById("c")));
  ok("…a need without a level means Edit", !shown(d.getElementById("e")));
  ok("…and a Read need is met by Read", shown(d.getElementById("r")));
  await put(`<div id="f" data-need-form="production.machines:edit"><input id="fi"><select id="fs"><option>1</option></select><button id="fb" type="button">Save</button><button id="fk" type="button" data-perm-keep>Back</button></div>
    <select id="one" data-need-form="production.machines:edit"><option>1</option></select>`);
  ok("a locked form's fields can't be changed", d.getElementById("fi").disabled && d.getElementById("fs").disabled);
  ok("…its buttons are hidden, except one kept for moving around", !shown(d.getElementById("fb")) && shown(d.getElementById("fk")));
  ok("…and a single field can carry the lock itself", d.getElementById("one").disabled);
  const inner = d.createElement("input"); inner.id = "late";
  d.getElementById("f").appendChild(inner); await tick();
  ok("a field added to a locked form later is locked too", d.getElementById("late").disabled);

  w.eval(asRole("staff"));
  await put(`<button id="se" data-need="production.hoops:edit">Edit</button><button id="sd" data-need="production.hoops:full">Delete</button>`);
  ok("Back office: Edit shows, Delete (Full) doesn't", shown(d.getElementById("se")) && !shown(d.getElementById("sd")));
  w.eval(asRole("admin"));
  await put(`<button id="ad" data-need="production.hoops:full">Delete</button><div data-need-form="production.machines:edit"><input id="ai"></div>`);
  ok("Admin sees everything and every field is open", shown(d.getElementById("ad")) && !d.getElementById("ai").disabled);
  w.eval(asRole(null));
  await put(`<button id="nd" data-need="production.hoops:full">Delete</button>`);
  ok("before the server has said what the role may do, nothing is hidden (the server still refuses)", shown(d.getElementById("nd")));
  w.eval(asRole("production"));
  await put(`<button id="pa" data-need="production.hoops:edit">Edit</button>`);
  w.eval(asRole("admin") + " adminApplyPerms_(document.body);");
  ok("when the role's permissions arrive or change, the page is checked again", shown(d.getElementById("pa")));
  box.remove();

  console.log("=== A real screen: Hoops ===");
  const hoopsAs = async (role) => {
    w.eval(asRole(role));
    const app = d.getElementById("app") || d.body;
    await w.eval("renderHoopCatalog")(app); await tick(40);
    const btn = (t) => [...app.querySelectorAll("button")].find(b => b.textContent.trim() === t);
    return { add: shown(btn("+ New hoop")), edit: shown(btn("Edit")), del: shown(btn("Delete")), listed: /4in round/.test(app.textContent) };
  };
  let h = await hoopsAs("production");
  ok("Production sees the hoops but no New, Edit or Delete", h.listed && !h.add && !h.edit && !h.del);
  h = await hoopsAs("staff");
  ok("Back office can add and edit hoops, not delete them", h.listed && h.add && h.edit && !h.del);
  h = await hoopsAs("admin");
  ok("Admin has all three", h.add && h.edit && h.del);

  console.log("=== Every screen's controls are tagged ===");
  const tags = [...adminJs.matchAll(/data-need(?:-form)?="([^"$]+)"/g)].map(m => m[1]);
  const specs = tags.flatMap(t => t.split("|"));
  ok(`every tag (${tags.length}) names a real function at read, edit or full`, specs.length > 150 && specs.every(s => { const [fn, lvl] = s.split(":"); return PERM_FUNCTIONS.includes(fn) && ["read", "edit", "full"].includes(lvl); }));
  const tagged = (re) => re.test(adminJs);
  ok("Run Order: start, finish and abort need Run Edit; marking done without timing needs Mark made", tagged(/class="run-start-btn" data-need="run\.runs:edit"/) && tagged(/class="run-complete-btn" data-need="run\.runs:edit"/) && tagged(/class="run-abort-btn admin-btn-danger" data-need="run\.runs:edit"/) && tagged(/class="run-btn" data-need="run\.markMade:edit"/));
  ok("Run Transfer Sheets: received, applied and made need Mark", ["rtRecv", "rtApply", "rtMake"].every(c => tagged(new RegExp(`class="admin-btn ${c}" data-need="transfer\\.mark:edit"`))));
  ok("Machines: Edit and the hoop and needle pickers need Machines Edit, Delete needs Full, logging work needs only the log", tagged(/data-need="production\.machines:edit" onclick="machineEdit_/) && tagged(/data-need="production\.machines:full" onclick="machineDelete_/) &&
    tagged(/class="mchHoopSelect" data-need-form="production\.machines:edit"/) && tagged(/data-need="production\.maintenanceLog:edit" onclick="machineMaintDone_/));
  ok("Machine files: Delete needs Full", tagged(/mfDeleteBtn admin-btn-danger" data-need="production\.machinefiles:full"/));
  ok("Threads, hoops, abort reasons, locations, categories, graphics, designs: delete needs Full",
    ["threadDelete_", "hoopDelete_", "abortReasonDelete_", "graphicDelete_"].every(f => new RegExp(`data-need="[a-z]+\\.[A-Za-z]+:full" onclick="${f}\\(`).test(adminJs)) &&
    tagged(/data-need="catalog\.designs:full" data-org="\$\{escapeHtml\(orgId\)\}" onclick="deleteDesign_\(/) &&
    tagged(/data-loc-del="\$\{l\.id\}" data-need="catalog\.locations:full"/) && tagged(/data-pc-del="\$\{escapeHtml\(c\.key\)\}" data-need="catalog\.categories:full"/));
  ok("Order popups: recording a payment needs Edit, a refund Full; voiding the order Full", tagged(/data-need="orders\.payments:edit" style="border-top:1px solid #e5e7eb;padding-top:14px;margin-bottom:14px;">\n\s*<div[^>]*>Record payment/) &&
    tagged(/data-need="orders\.payments:full" style="border-top:1px solid #e5e7eb;padding-top:14px;margin-bottom:14px;">\n\s*<div[^>]*>Record refund/) && tagged(/data-need="orders\.details:full" onclick="deleteTransaction\(/));
  ok("Blanks, transfers, money, reconcile, books: voids, write-offs, deletes and reopening need Full",
    tagged(/data-need="inventory\.blanks:full" onclick="voidBlankMovement_/) && tagged(/data-need="inventory\.transfers:full" onclick="transferWriteOff_/) && tagged(/data-need="finance\.money:full" data-kind=/) &&
    tagged(/id="rcReopen" data-need="finance\.reconcile:full"/) && tagged(/data-need="reports\.books:full">Reopen/));
  ok("Product and shop forms lock for a read-only role, keeping the way back", tagged(/class="admin-panel" data-need-form="catalog\.products:edit"/) && tagged(/class="admin-panel" data-need-form="catalog\.shops:edit"/) && tagged(/<button data-perm-keep[^>]*>&larr; Products/));

  console.log("=== The server agrees ===");
  const agentJs = read("functions/api/agent.js"), designJs = read("functions/api/design.js");
  ok("deleting a machine's file needs Machine files Full, scanning for machines needs Machines Edit (sending a design is part of a run)",
    /delete: \["production\.machinefiles", "full"\], discover: \["production\.machines", "edit"\]/.test(agentJs));
  ok("design files can be looked at by anyone who sees designs, orders or the production queues (Run Order shows them)",
    /\[\["catalog\.designs", "read"\], \["orders\.details", "read"\], \["run\.queue", "read"\], \["transfer\.queue", "read"\], \["production\.machinefiles", "read"\]\]/.test(designJs));
  ok("…and uploading one still needs Edit", /mayUpload = [\s\S]{0,200}adminCan\(request, "catalog\.designs", "edit"\)/.test(designJs) && /if \(!url\.searchParams\.get\("productId"\) && !mayUpload\)/.test(designJs));

  dom.window.close();
})();
