// Outside digitizing: a design sent to someone else to be digitized, what it cost and whether the cost was booked as
// an expense (migrations/0118, table digitizing_jobs). A section the order window (admin.js) and a saved quote
// (admin-quotes.js) both put on their page; it carries its own list, its own "Send to digitizer" window and edit /
// delete, so neither page knows how it works.
//
// A classic script like admin.js and admin-quotes.js, so it uses admin.js's own helpers as they are (adminApi_,
// inventoryModal_, askConfirm_, adminMoney_, adminDate_, localToday_) and storefront.js's (escapeHtml, showToast). It
// adds two globals:
//   digitizingSectionHtml_(ctx)        the section's markup (a box with a heading and a list that fills in);
//   wireDigitizingSection_(root, ctx)  loads the jobs into that markup and listens for its buttons.
// ctx = { orderId?, estimateId?, items?, canEdit, canExpense }. `items` (an order's lines, as { id, name }) lets a job
// say which line it is for. Money is whole cents on the wire (costCents); only the field in the window is dollars.
//
// No data-admin-action here: the names those run are a fixed list at the top of admin.js. The section puts one
// listener on its own box, which goes away with the page.
(function () {
  "use strict";

  const NAME_MAX = 200, VENDOR_MAX = 120, NOTE_MAX = 1000;
  const COST_MAX_CENTS = 100000000;   // the server's limit on a cost; checked here only to say so sooner
  const OTHER = "__other__";          // the vendor list's "someone who isn't on it"

  const iso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !isNaN(Date.parse(v + "T00:00:00Z"));
  // Dollars typed into a field → whole cents, without a float multiply: 0 or more, at most two decimals. NaN when it isn't.
  function toCents(v) {
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(v == null ? "" : v).trim());
    if (!m) return NaN;
    return Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0") || 0);
  }
  const centsToField = (c) => (Math.floor(c / 100)) + "." + String(c % 100).padStart(2, "0");
  const money = (c) => adminMoney_((Number(c) || 0) / 100);
  const lineId = (it) => (it && (it.id != null ? it.id : it.itemId));
  const lineName = (it) => String((it && (it.name != null ? it.name : it.itemName)) || "");

  // The shop's vendors that can digitize, first; the rest after. One request per page load, shared by every section.
  let vendorsAsked = null;
  function vendorList() {
    if (!vendorsAsked) {
      vendorsAsked = adminApi_({ action: "listVendors" })
        .then(d => (d.vendors || []).filter(v => v && v.name && !v.hidden)
          .sort((a, b) => (Number(b.forDigitizing) || 0) - (Number(a.forDigitizing) || 0) || String(a.name).localeCompare(String(b.name))))
        .catch(() => { vendorsAsked = null; return []; });
    }
    return vendorsAsked;
  }

  function digitizingSectionHtml_(ctx) {
    ctx = ctx || {};
    return `<div class="dg-section" data-dg-root>
      <div class="dg-head" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:14px 0 6px;">
        <h3 class="cust-h" style="margin:0;">Outside digitizing</h3>
        ${ctx.canEdit ? `<button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" data-dg-new>Send to digitizer…</button>` : ""}
      </div>
      <div data-dg-list><div class="cust-note">Loading…</div></div>
    </div>`;
  }

  function wireDigitizingSection_(root, ctx) {
    ctx = ctx || {};
    if (!root) return;
    const box = root.matches && root.matches("[data-dg-root]") ? root : root.querySelector("[data-dg-root]");
    if (!box) return;
    const listEl = box.querySelector("[data-dg-list]");
    const scope = ctx.estimateId != null ? { estimateId: ctx.estimateId } : { orderId: ctx.orderId };
    let jobs = [], asked = 0;
    // This section on a page the admin has since left must not draw over the one they went to.
    const alive = () => box.isConnected;

    function draw() {
      if (!jobs.length) { listEl.innerHTML = `<div class="cust-note">Nothing has been sent to an outside digitizer${ctx.canEdit ? ". “Send to digitizer…” records one." : "."}</div>`; return; }
      const total = jobs.reduce((s, j) => s + (Number(j.costCents) || 0), 0);
      listEl.innerHTML = `<div class="admin-table-wrap"><table class="stack-mobile cust-table dg-table">
        <thead><tr><th>Sent</th><th>Vendor</th><th>Back</th><th class="cust-num">Cost</th>${ctx.canEdit ? `<th><span class="qt-sr">Change or delete</span></th>` : ""}</tr></thead>
        <tbody>${jobs.map(j => `<tr>
          <td class="stack-title">${escapeHtml(j.name || "Digitizing")}<div class="qt-line-sub">${escapeHtml(adminDate_(j.sentAt))}${j.note ? " · " + escapeHtml(j.note) : ""}${j.expenseId ? " · cost booked as an expense" : ""}</div></td>
          <td>${escapeHtml(j.vendor || "")}</td>
          <td>${j.returnedAt ? escapeHtml(adminDate_(j.returnedAt)) : `<span class="cust-tag cust-tag-warn">Not back yet</span>`}</td>
          <td class="cust-num">${Number(j.costCents) > 0 ? escapeHtml(money(j.costCents)) : ""}</td>
          ${ctx.canEdit ? `<td class="qt-line-acts">
            <button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" data-dg-edit="${escapeHtml(j.id)}" aria-label="Change ${escapeHtml(j.name || "digitizing")}">Change</button>
            <button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" data-need="production.digitizing:full" data-dg-del="${escapeHtml(j.id)}" aria-label="Delete ${escapeHtml(j.name || "digitizing")}">Delete</button></td>` : ""}
        </tr>`).join("")}</tbody></table></div>
        ${jobs.length > 1 && total > 0 ? `<div class="cust-note">Total cost: ${escapeHtml(money(total))}</div>` : ""}`;
    }

    async function load() {
      const mine = ++asked;   // a slower, older answer must not replace a newer one
      try {
        const d = await adminApi_(Object.assign({ action: "listDigitizingJobs" }, scope));
        if (mine !== asked || !alive()) return;
        jobs = d.jobs || [];
        draw();
      } catch (e) {
        if (mine !== asked || !alive()) return;
        listEl.innerHTML = `<div class="cust-err" role="alert">${escapeHtml(e.message || "Couldn't load the digitizing records.")}</div>`;
      }
    }

    // The window for one job: new (job null) or a change to a recorded one.
    async function showJob(job) {
      if (!ctx.canEdit) return;
      const vendors = await vendorList();
      if (!alive()) return;
      const names = vendors.map(v => String(v.name));
      const known = !job || !job.vendor || names.includes(job.vendor);
      const items = (ctx.items || []).filter(it => lineId(it) != null);
      // An expense is booked once: a job that already has one shows that, and its cost is changed in Expenses.
      const booked = !!(job && job.expenseId);
      const { ov, close } = inventoryModal_(job ? "Change digitizing record" : "Send to digitizer", `
        <form id="dgForm" class="cust-form" novalidate>
          <label class="cust-field"><span>What was sent</span><input type="text" id="dgName" maxlength="${NAME_MAX}" autocomplete="off" placeholder="Example Club left chest logo" value="${escapeHtml(job ? job.name : "")}"></label>
          ${items.length ? `<label class="cust-field"><span>For which line (optional)</span><select id="dgItem">
            <option value="">Not for one line</option>
            ${items.map(it => `<option value="${escapeHtml(lineId(it))}"${job && Number(job.itemId) === Number(lineId(it)) ? " selected" : ""}>${escapeHtml(lineName(it) || "Line " + lineId(it))}</option>`).join("")}</select></label>` : ""}
          <label class="cust-field"><span>Digitizer</span>
            ${names.length ? `<select id="dgVendor">
              ${names.map((n, i) => `<option value="${escapeHtml(n)}"${job && job.vendor === n ? " selected" : ""}>${escapeHtml(n)}${Number(vendors[i].forDigitizing) ? "" : " (not marked as a digitizer)"}</option>`).join("")}
              <option value="${OTHER}"${known ? "" : " selected"}>Someone else…</option></select>` : ""}
          </label>
          <label class="cust-field" id="dgVendorOtherWrap"${names.length && known ? " hidden" : ""}><span>${names.length ? "Their name" : "Digitizer"}</span>
            <input type="text" id="dgVendorOther" maxlength="${VENDOR_MAX}" autocomplete="off" value="${escapeHtml(known ? "" : job.vendor)}"></label>
          <div class="cust-grid">
            <label class="cust-field"><span>Sent on</span><input type="date" id="dgSent" value="${escapeHtml(job ? job.sentAt : localToday_())}"></label>
            <label class="cust-field"><span>Back on (blank = not back yet)</span><input type="date" id="dgBack" value="${escapeHtml(job && job.returnedAt ? job.returnedAt : "")}"></label>
          </div>
          <label class="cust-field"><span>Cost ($)</span><input type="number" id="dgCost" min="0" step="0.01" inputmode="decimal"${booked ? " disabled" : ""} value="${escapeHtml(job && Number(job.costCents) > 0 ? centsToField(Number(job.costCents)) : "")}"></label>
          ${booked ? `<div class="cust-note">Its cost is booked as an expense; change the amount there.</div>`
            : ctx.canExpense ? `<label class="cust-check"><input type="checkbox" id="dgExpense"> <span>Record the cost as an expense</span></label>` : ""}
          <label class="cust-field"><span>Note (optional)</span><textarea id="dgNote" rows="2" maxlength="${NOTE_MAX}">${escapeHtml(job ? job.note || "" : "")}</textarea></label>
          <div class="cust-err" id="dgErr" role="alert"></div>
          <div class="cust-dialog-actions">
            <button type="button" class="admin-btn admin-btn-secondary" id="dgCancel">Cancel</button>
            <button type="submit" class="admin-btn" id="dgSave">${job ? "Save" : "Record it"}</button>
          </div>
        </form>`, 520, { guard: true });
      const $ = (s) => ov.querySelector(s);
      const err = $("#dgErr");
      const vendorSel = $("#dgVendor");
      if (vendorSel) vendorSel.addEventListener("change", () => { $("#dgVendorOtherWrap").hidden = vendorSel.value !== OTHER; });
      $("#dgCancel").onclick = () => ov.querySelector("[data-modal-close]").click();
      $("#dgName").focus();
      $("#dgForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = $("#dgName").value.trim();
        const vendor = (vendorSel && vendorSel.value !== OTHER ? vendorSel.value : $("#dgVendorOther").value).trim();
        const sentAt = $("#dgSent").value, returnedAt = $("#dgBack").value;
        const costText = $("#dgCost").value.trim();
        const costCents = booked ? Number(job.costCents) || 0 : costText === "" ? 0 : toCents(costText);
        if (!name) { err.textContent = "Say what was sent."; $("#dgName").focus(); return; }
        if (!vendor) { err.textContent = "Say who digitized it."; (vendorSel && vendorSel.value !== OTHER ? vendorSel : $("#dgVendorOther")).focus(); return; }
        if (!iso(sentAt)) { err.textContent = "Enter the day it was sent."; $("#dgSent").focus(); return; }
        if (returnedAt && !iso(returnedAt)) { err.textContent = "Enter the day it came back, or leave it blank."; $("#dgBack").focus(); return; }
        if (returnedAt && returnedAt < sentAt) { err.textContent = "It can't come back before it was sent."; $("#dgBack").focus(); return; }
        if (isNaN(costCents) || costCents > COST_MAX_CENTS) { err.textContent = "Enter the cost (0 or more, like 25.00)."; $("#dgCost").focus(); return; }
        const next = Object.assign({}, job ? { id: job.id } : {}, scope, {
          name, vendor, sentAt, returnedAt: returnedAt || null, costCents, note: $("#dgNote").value.trim(),
        });
        const itemSel = $("#dgItem");
        if (itemSel) next.itemId = itemSel.value ? Number(itemSel.value) : null;
        else if (job && job.itemId != null) next.itemId = job.itemId;
        if (job && job.designId != null) next.designId = job.designId;
        if (job && job.expenseId != null) next.expenseId = job.expenseId;
        if ($("#dgExpense") && $("#dgExpense").checked) {
          if (!(costCents > 0)) { err.textContent = "There is no cost to record as an expense. Enter the cost first."; $("#dgCost").focus(); return; }
          next.recordExpense = true;
        }
        $("#dgSave").disabled = true; err.textContent = "";
        try {
          await adminApi_({ action: "saveDigitizingJob", job: next });
        } catch (ex) { err.textContent = ex.message || "Couldn't save the record."; $("#dgSave").disabled = false; return; }
        close();
        showToast(job ? "Digitizing record saved." : "Digitizing record added.");
        if (alive()) load();
      });
    }

    if (!box._dgWired) {
      box._dgWired = true;
      box.addEventListener("click", async (e) => {
        const btn = e.target.closest("button");
        if (!btn) return;
        if (btn.hasAttribute("data-dg-new")) { showJob(null); return; }
        const find = (id) => jobs.find(j => String(j.id) === String(id));
        if (btn.dataset.dgEdit != null) { const j = find(btn.dataset.dgEdit); if (j) showJob(j); return; }
        if (btn.dataset.dgDel != null) {
          const j = find(btn.dataset.dgDel);
          if (!j) return;
          if (!await askConfirm_(`Delete the digitizing record “${j.name || "Digitizing"}”?\n\nIt is removed from this list.${j.expenseId ? " Its expense stays: delete that in Expenses first." : ""}`, { confirmLabel: "Delete", danger: true })) return;
          try {
            await adminApi_({ action: "deleteDigitizingJob", id: j.id });
            showToast("Digitizing record deleted.");
            if (alive()) load();
          } catch (ex) { showToast(ex.message || "Couldn't delete the record.", true); }
        }
      });
    }
    return load();
  }

  window.digitizingSectionHtml_ = digitizingSectionHtml_;
  window.wireDigitizingSection_ = wireDigitizingSection_;
})();
