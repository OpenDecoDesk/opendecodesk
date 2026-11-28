// Customer-supplied garments (migrations/0121; Global settings → Features → Customer-supplied garments): the
// "Check in garments…" window for one line of an order that is decorated on the customer's own garments. admin.js loads
// this file the first time the window is opened (ensureGarmentsUi_). Such a line never orders or uses a blank and carries
// no blank cost; instead the work waits until the customer's garments are in: counted per size, their condition noted.
// Saving the count (checkInGarments) marks the line's garments in, and once every line has its blank or its garments the
// order moves on the way it does when a blank is received. A re-count replaces the last one; Undo takes it back.
// "Print slip" prints a check-in slip to hand the customer: the order, who it is for, the counts and condition, and the
// shop's waiver line (Global settings → Customer-supplied garments), which can be left off.
//
// A classic script like admin.js and admin-giftcards.js, so it uses admin.js's own helpers as they are (adminApi_,
// inventoryModal_, askConfirm_, adminCan_, adminDateTime_, bizName_) and storefront.js's (escapeHtml, showToast, siteFeatures).
// It adds one global, showGarmentCheckin_(orderId, item, ctx). No data-admin-action here: the window's buttons are wired
// on the window itself.
(function () {
  "use strict";

  // Checking garments in is a step of the order, like marking a blank received (setFulfillmentStage): the same permission.
  const STEP_FN = "orders.stepsEarly";
  const NOTE_MAX = 300, QTY_MAX = 5000, ROWS_MAX = 30;
  const DEFAULT_WAIVER = "Customer's garments are decorated at the customer's risk; we're not responsible for garments damaged in normal production.";
  const CONDITIONS = { good: "Good", damaged: "Damaged", other: "Other" };
  const NEED_NOTE = "Say what's different (a note) when the count or condition isn't as expected.";

  const itemIdOf = (it) => it == null ? null : it.sheetRow != null ? it.sheetRow : it.id != null ? it.id : it.itemId;
  const intOr = (v, d) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : d; };
  // The waiver line: what the server sent with the check-ins, else the shop's settings as the catalog carries them,
  // else the usual sentence. An empty one saved on purpose prints nothing.
  function waiverText(d) {
    if (d && typeof d.waiver === "string") return d.waiver.trim();
    if (typeof siteFeatures !== "undefined" && siteFeatures && typeof siteFeatures.ownGarmentsWaiver === "string") return siteFeatures.ownGarmentsWaiver.trim();
    return DEFAULT_WAIVER;
  }

  async function showGarmentCheckin(orderId, item, ctx) {
    ctx = ctx || {};
    const itemId = itemIdOf(item);
    if (!orderId || itemId == null) { showToast("That line can't be found — refresh the list.", true); return; }
    const canEdit = adminCan_(STEP_FN, "edit");
    const order = ctx.order || {};
    let live = Array.isArray(item.checkins) ? item.checkins.filter(c => c && !c.voidedAt && Number(c.itemId != null ? c.itemId : itemId) === Number(itemId)) : null;
    let answer = null;
    try {
      answer = await adminApi_({ action: "listGarmentCheckins", orderId, ...(ctx.orgId ? { org: ctx.orgId } : {}) });
      const rows = Array.isArray(answer.checkins) ? answer.checkins : Array.isArray(answer.rows) ? answer.rows : [];
      live = rows.filter(c => c && !c.voidedAt && Number(c.itemId) === Number(itemId));
    } catch (e) {
      // The window still opens on what the order itself said; a save checks everything again.
      if (!live) { showToast("Couldn't load the garment check-ins: " + (e.message || "unknown error"), true); return; }
    }
    const waiver = waiverText(answer);
    const size = String(item.size || "").trim() || "One size";
    const lineQty = intOr(item.qty, 0);
    // The rows the window starts with: the last count, else one row for the line's size expecting its quantity.
    const start = live && live.length
      ? live.map(c => ({ size: String(c.size || ""), expectedQty: intOr(c.expectedQty, 0), receivedQty: intOr(c.receivedQty, 0), condition: CONDITIONS[c.condition] ? c.condition : "good", note: String(c.note || "") }))
      : [{ size, expectedQty: lineQty, receivedQty: lineQty, condition: "good", note: "" }];
    const checkedAt = live && live.length ? live.map(c => c.at).filter(Boolean).sort().pop() : "";
    const checkedBy = live && live.length ? (live.find(c => c.at === checkedAt) || {}).by || "" : "";
    const modalOpts = { guard: canEdit };
    const who = [order.customerName, order.company].filter(Boolean).join(" · ");
    const { ov, close } = inventoryModal_("Check in garments — " + escapeHtml(orderId), `
      <div class="og-head"><strong>${escapeHtml(item.name || "")}</strong> <span class="og-dim">· ${escapeHtml(size)} · ${lineQty} on the order</span>${who ? `<div class="og-dim">${escapeHtml(who)}</div>` : ""}</div>
      <div class="cust-note" style="margin-top:4px;">The customer's own garments: count what came in for each size and note their condition. The order's work waits until they're in; this line never uses a blank.</div>
      ${checkedAt ? `<div class="og-last" id="ogLast">Checked in ${escapeHtml(adminDateTime_(checkedAt))}${checkedBy ? " by " + escapeHtml(checkedBy) : ""}.${canEdit ? " Saving again replaces that count." : ""}</div>` : ""}
      <form id="ogForm" novalidate>
        <div class="admin-table-wrap"><table class="cust-table og-table">
          <thead><tr><th>Size</th><th class="cust-num">Expected</th><th class="cust-num">Received</th><th>Condition</th><th>Note</th>${canEdit ? "<th></th>" : ""}</tr></thead>
          <tbody id="ogRows"></tbody>
        </table></div>
        ${canEdit ? `<button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" id="ogAdd" style="margin-top:6px;">+ Another size</button>` : ""}
        <div class="og-sum" id="ogSum" aria-live="polite"></div>
        <label class="cust-check"><input type="checkbox" id="ogWaiver" ${waiver ? "checked" : "disabled"}> Print the waiver line on the slip</label>
        ${waiver ? `<div class="og-waiver">“${escapeHtml(waiver)}”</div>` : `<div class="cust-note">No waiver line is set (Global settings → Features → Customer-supplied garments).</div>`}
        <div class="cust-err" id="ogErr" role="alert"></div>
        <div class="cust-dialog-actions og-actions">
          ${canEdit && live && live.length ? `<button type="button" class="admin-btn admin-btn-secondary" id="ogUndo" style="margin-right:auto;">Undo check-in</button>` : ""}
          <button type="button" class="admin-btn admin-btn-secondary" id="ogPrint" data-perm-keep>Print slip</button>
          <button type="button" class="admin-btn admin-btn-secondary" id="ogCancel" data-perm-keep>${canEdit ? "Cancel" : "Close"}</button>
          ${canEdit ? `<button type="submit" class="admin-btn" id="ogSave">Save check-in</button>` : ""}
        </div>
      </form>`, 720, modalOpts);
    const $ = (sel) => ov.querySelector(sel);
    const err = $("#ogErr");
    const tbody = $("#ogRows");
    const dis = canEdit ? "" : " disabled";

    function rowHtml(r) {
      return `<tr class="og-row">
        <td><input type="text" class="og-size" maxlength="40" value="${escapeHtml(r.size)}" aria-label="Size"${dis}></td>
        <td class="cust-num"><input type="number" class="og-exp" min="0" max="${QTY_MAX}" step="1" value="${r.expectedQty}" aria-label="Expected"${dis}></td>
        <td class="cust-num"><input type="number" class="og-rec" min="0" max="${QTY_MAX}" step="1" value="${r.receivedQty}" aria-label="Received"${dis}></td>
        <td><select class="og-cond" aria-label="Condition"${dis}>${Object.keys(CONDITIONS).map(k => `<option value="${k}"${k === r.condition ? " selected" : ""}>${CONDITIONS[k]}</option>`).join("")}</select></td>
        <td><input type="text" class="og-note" maxlength="${NOTE_MAX}" value="${escapeHtml(r.note)}" placeholder="e.g. 2 short, one stained" aria-label="Note"${dis}></td>
        ${canEdit ? `<td><button type="button" class="og-remove" aria-label="Remove this size" title="Remove this size">&times;</button></td>` : ""}
      </tr>`;
    }
    function read() {
      return [...tbody.querySelectorAll(".og-row")].map(tr => ({
        size: tr.querySelector(".og-size").value.trim(),
        expectedRaw: tr.querySelector(".og-exp").value.trim(), receivedRaw: tr.querySelector(".og-rec").value.trim(),
        condition: tr.querySelector(".og-cond").value, note: tr.querySelector(".og-note").value.trim(), tr,
      })).map(r => ({ ...r, expectedQty: Number(r.expectedRaw), receivedQty: Number(r.receivedRaw) }));
    }
    function summary() {
      const rows = read();
      const rec = rows.reduce((s, r) => s + (Number.isInteger(r.receivedQty) && r.receivedQty > 0 ? r.receivedQty : 0), 0);
      const exp = rows.reduce((s, r) => s + (Number.isInteger(r.expectedQty) && r.expectedQty > 0 ? r.expectedQty : 0), 0);
      const off = rows.filter(r => r.receivedQty !== r.expectedQty || r.condition !== "good").length;
      $("#ogSum").textContent = `${rec} of ${exp} received` + (off ? ` · ${off} size${off === 1 ? "" : "s"} not as expected` : "");
      if ($("#ogAdd")) $("#ogAdd").disabled = rows.length >= ROWS_MAX;
    }
    tbody.innerHTML = start.map(rowHtml).join("");
    summary();

    ov.addEventListener("input", (e) => { if (e.target.closest && e.target.closest("#ogRows")) { e.target.style.outline = ""; summary(); } });
    ov.addEventListener("change", (e) => { if (e.target.closest && e.target.closest("#ogRows")) summary(); });
    $("#ogCancel").onclick = () => $("[data-modal-close]").click();
    if ($("#ogAdd")) $("#ogAdd").onclick = () => {
      if (tbody.querySelectorAll(".og-row").length >= ROWS_MAX) return;
      tbody.insertAdjacentHTML("beforeend", rowHtml({ size: "", expectedQty: 0, receivedQty: 0, condition: "good", note: "" }));
      const sizes = tbody.querySelectorAll(".og-size"); sizes[sizes.length - 1].focus();
      summary();
    };
    tbody.addEventListener("click", (e) => {
      const b = e.target.closest(".og-remove");
      if (!b) return;
      if (tbody.querySelectorAll(".og-row").length <= 1) { err.textContent = "Keep at least one size."; return; }
      b.closest("tr").remove(); err.textContent = ""; summary();
    });

    // What the form says, checked as the server checks it: { counts } or { error, focus }.
    function collect() {
      const rows = read();
      if (!rows.length) return { error: "Count at least one size." };
      const seen = new Set();
      for (const r of rows) {
        if (!r.size) return { error: "Name the size (or One size).", focus: r.tr.querySelector(".og-size") };
        const key = r.size.toLowerCase();
        if (seen.has(key)) return { error: `${r.size} is listed twice — put it on one row.`, focus: r.tr.querySelector(".og-size") };
        seen.add(key);
        if (r.expectedRaw === "" || !Number.isInteger(r.expectedQty) || r.expectedQty < 0 || r.expectedQty > QTY_MAX) return { error: `Expected for ${r.size}: a whole number from 0 to ${QTY_MAX}.`, focus: r.tr.querySelector(".og-exp") };
        if (r.receivedRaw === "" || !Number.isInteger(r.receivedQty) || r.receivedQty < 0 || r.receivedQty > QTY_MAX) return { error: `Received for ${r.size}: a whole number from 0 to ${QTY_MAX}.`, focus: r.tr.querySelector(".og-rec") };
        if ((r.receivedQty !== r.expectedQty || r.condition !== "good") && !r.note) return { error: NEED_NOTE, focus: r.tr.querySelector(".og-note") };
      }
      return { counts: rows.map(r => ({ size: r.size, expectedQty: r.expectedQty, receivedQty: r.receivedQty, condition: r.condition, note: r.note.slice(0, NOTE_MAX) })) };
    }

    if (canEdit) $("#ogForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const got = collect();
      if (got.error) { err.textContent = got.error; if (got.focus) { got.focus.style.outline = "2px solid #b03a2e"; got.focus.focus(); } return; }
      const save = $("#ogSave");
      save.disabled = true;
      try {
        await adminApi_({ action: "checkInGarments", orderId, itemId: Number(itemId), counts: got.counts, ...(ctx.orgId ? { org: ctx.orgId } : {}) });
        const rec = got.counts.reduce((s, c) => s + c.receivedQty, 0);
        modalOpts.guard = false;
        close();
        showToast(rec ? `Garments checked in: ${rec} for ${item.name || "the line"}.` : "Check-in saved: nothing received yet, so the line still waits for the garments.");
        if (typeof ctx.onDone === "function") ctx.onDone();
      } catch (ex) { err.textContent = ex.message || "Couldn't save the check-in."; save.disabled = false; }
    });

    if ($("#ogUndo")) $("#ogUndo").onclick = async () => {
      if (!(await askConfirm_("Undo this check-in?\n\nThe count is taken back and the line waits for the customer's garments again.", { confirmLabel: "Undo check-in", danger: true }))) return;
      const b = $("#ogUndo"); if (b) b.disabled = true;
      try {
        await adminApi_({ action: "undoGarmentCheckin", orderId, itemId: Number(itemId), ...(ctx.orgId ? { org: ctx.orgId } : {}) });
        modalOpts.guard = false;
        close();
        showToast("Check-in taken back.");
        if (typeof ctx.onDone === "function") ctx.onDone();
      } catch (ex) { err.textContent = ex.message || "Couldn't undo the check-in."; if (b && b.isConnected) b.disabled = false; }
    };

    // The slip: what the form shows now (saved or not), printed on its own — everything else on the page is hidden
    // while it prints (admin.css body.og-printing).
    $("#ogPrint").onclick = () => {
      const rows = read();
      const withWaiver = !!(waiver && $("#ogWaiver").checked);
      const shop = typeof bizName_ === "function" ? bizName_() : "";
      const slip = document.createElement("div");
      slip.id = "ogSlipPrint";
      slip.className = "og-slip";
      slip.innerHTML = `
        <div class="og-slip-h">${escapeHtml(shop)}${shop ? " — " : ""}Garment check-in</div>
        <table class="og-slip-facts"><tbody>
          <tr><th>Order</th><td>${escapeHtml(orderId)}</td></tr>
          ${who ? `<tr><th>Customer</th><td>${escapeHtml(who)}</td></tr>` : ""}
          <tr><th>Item</th><td>${escapeHtml(item.name || "")}</td></tr>
          <tr><th>Checked in</th><td>${escapeHtml(adminDateTime_(checkedAt || new Date().toISOString()))}</td></tr>
        </tbody></table>
        <table class="og-slip-counts"><thead><tr><th>Size</th><th>Expected</th><th>Received</th><th>Condition</th><th>Note</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td>${escapeHtml(r.size)}</td><td>${escapeHtml(r.expectedRaw)}</td><td>${escapeHtml(r.receivedRaw)}</td><td>${escapeHtml(CONDITIONS[r.condition] || r.condition)}</td><td>${escapeHtml(r.note)}</td></tr>`).join("")}</tbody></table>
        ${withWaiver ? `<p class="og-slip-waiver">${escapeHtml(waiver)}</p>` : ""}
        <div class="og-slip-sign"><span>Customer signature</span><span>Date</span></div>`;
      document.body.appendChild(slip);
      document.body.classList.add("og-printing");
      let done = false;
      const tidy = () => { if (done) return; done = true; document.body.classList.remove("og-printing"); slip.remove(); window.removeEventListener("afterprint", tidy); };
      window.addEventListener("afterprint", tidy);
      try { window.print(); } catch (e) { /* no printer: the slip is still tidied away */ }
      // A browser that never says the printing ended still gets the page back.
      setTimeout(tidy, 60000);
      if (typeof window.onafterprint === "undefined") tidy();
    };
  }

  window.showGarmentCheckin_ = function showGarmentCheckin_(orderId, item, ctx) { return showGarmentCheckin(orderId, item, ctx); };
})();
