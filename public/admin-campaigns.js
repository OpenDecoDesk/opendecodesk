// The Discount codes page's Email campaigns tab (migrations/0117). admin.js loads this file (and public/campaign-render.js,
// the renderer the server sends with) the first time #discounts/campaigns is opened: ensureCampaignsPage_.
//   #discounts/campaigns          the list: each campaign's theme, discount, audience, where it stands and how it did
//   #discounts/campaigns/new      a new campaign (admin.js's _campaignPreset can pick a discount code for it)
//   #discounts/campaigns/<id>     one campaign: the editor while it's a draft, else where it stands
// The editor has four steps: who gets it (shops, the last order, how many orders, typed addresses — counted live by the
// server), the email (a theme, then blocks: banner, heading, text, discount code, button, products, picture, divider,
// space — or HTML written by hand), the discount (none, one code, or a code for each person) and sending (a test, now,
// or at a time). A draft saves itself as it changes.
//
// A classic script like admin.js and admin-quotes.js: it uses admin.js's helpers as they are (adminApi_, adminSetHash,
// adminTitle_, adminPageHead_, inventoryModal_, askConfirm_, adminCan_, adminDate_, adminOrgs, bizName_, dcTabsHtml_,
// _campaignPreset) and storefront.js's (escapeHtml, showToast). It adds one global, renderCampaigns(app, sub).
(function () {
  "use strict";

  const FN = "discounts.campaigns";
  const R = () => window.OddCampaignRender;
  const STATUS = { draft: "Draft", scheduled: "Scheduled", sending: "Sending", sent: "Sent", canceled: "Canceled" };
  const LAST_MODES = [["any", "Any time"], ["olderThan", "More than"], ["within", "Less than"], ["before", "Before a date"]];
  const ORDER_MODES = [["any", "Any number"], ["atLeast", "At least"], ["atMost", "At most"], ["exactly", "Exactly"]];
  const BLOCKS = [["banner", "Banner", "▭"], ["heading", "Heading", "H"], ["text", "Text", "¶"], ["code", "Discount code", "%"], ["button", "Button", "▢"],
    ["products", "Products", "▦"], ["image", "Picture", "◩"], ["divider", "Divider", "—"], ["spacer", "Space", "↕"]];
  const BLOCK_NAME = Object.fromEntries(BLOCKS.map(b => [b[0], b[1]]));
  const SWATCHES = ["#232323", "#6b6558", "#1E7A4C", "#1E3A8A", "#B91C1C", "#BE185D", "#EA580C", "#CA8A04"];
  let listFilter = "", seq = 0;

  const esc = (s) => escapeHtml(String(s == null ? "" : s));
  const plural = (n, one, many) => Number(n).toLocaleString("en-US") + " " + (Number(n) === 1 ? one : (many || one + "s"));
  const canEdit = () => adminCan_(FN, "edit"), canSend = () => adminCan_(FN, "full");
  const shops = () => (adminOrgs || []).slice().sort((a, b) => String(a.name || a.orgId).localeCompare(String(b.name || b.orgId)));
  const statusTag = (s) => `<span class="cust-tag cmp-st-${esc(s)}">${esc(STATUS[s] || s)}</span>`;
  const when = (iso) => { try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return iso; } };
  const sampleVars = (c, codeText) => ({ name: "Sam Lee", firstName: "Sam", business: (typeof bizName_ === "function" ? bizName_() : ""), shop: (typeof bizName_ === "function" ? bizName_() : ""),
    code: codeText || "", codeLabel: codeText ? discountLabel(c.discount) : "", expires: c.discount && c.discount.expiresOn ? adminDate_(c.discount.expiresOn) : "" });
  function discountLabel(d) {
    if (!d || d.mode === "none") return "";
    if (d.mode === "shared") return d.label || "";
    if (d.kind === "amount") return "$" + Number(d.amount || 0).toFixed(2) + " off";
    return String(Number(d.percent || 0)) + "% off" + (Number(d.maxDiscount) > 0 ? ", up to $" + Number(d.maxDiscount).toFixed(2) : "");
  }
  function discountText(c) {
    const d = c.discount || {};
    if (d.mode === "shared") return d.code || "One code";
    if (d.mode === "unique") return "A code each";
    return "None";
  }
  function head(sub) {
    return adminPageHead_("Discount codes", { crumbs: sub ? [{ label: "Discount codes", hash: "discounts" }, { label: "Email campaigns", hash: "discounts/campaigns" }, { label: sub }] : undefined })
      + (typeof dcTabsHtml_ === "function" ? dcTabsHtml_("campaigns") : "");
  }

  // ---- The list -------------------------------------------------------------------------------------------------
  async function renderList(app) {
    const hash = "discounts/campaigns";
    adminSetHash(hash);
    document.title = adminTitle_("Email campaigns");
    app.innerHTML = `${head()}
      <div class="admin-panel cust-page cmp-page" id="cmpList" style="--org-accent:var(--accent);">
        <div class="cust-bar">
          <label class="cust-field dc-filter"><span>Show</span>
            <select id="cmpFilter"><option value="">All campaigns</option>
              ${Object.keys(STATUS).map(k => `<option value="${k}"${listFilter === k ? " selected" : ""}>${STATUS[k]}</option>`).join("")}</select></label>
          <div class="dc-bar-btns"><button type="button" class="admin-btn" id="cmpNew" data-need="${FN}:edit">+ New campaign</button></div>
        </div>
        <div id="cmpBody"><div class="cust-note">Loading…</div></div>
        <div class="cust-note">Marketing emails go only to customers who haven't unsubscribed; every one has a way to unsubscribe. Order emails aren't affected.</div>
      </div>`;
    const root = document.getElementById("cmpList"), body = root.querySelector("#cmpBody");
    const stillOn = () => _currentAdminHash === hash && root.isConnected;
    let rows = [];
    async function load() {
      const mine = ++seq;
      try {
        const d = await adminApi_({ action: "listCampaigns", filter: listFilter, limit: 100 });
        if (mine !== seq || !stillOn()) return;
        rows = d.campaigns || [];
        if (!rows.length) { body.innerHTML = `<div class="cust-note">${listFilter ? "No campaign matches." : "No campaigns yet." + (canEdit() ? " Start one with “+ New campaign”." : "")}</div>`; return; }
        body.innerHTML = `<div class="admin-table-wrap"><table class="stack-mobile cust-table cmp-table">
          <thead><tr><th>Campaign</th><th>Discount</th><th class="cust-num">People</th><th>Status</th><th>Result</th></tr></thead>
          <tbody>${rows.map((c, i) => {
            const th = R().theme(c.theme);
            const result = c.status === "draft" ? "Edited " + adminDate_(c.updatedAt) : c.status === "scheduled" ? "Sends " + when(c.scheduledAt)
              : `${plural(c.counts.sent, "sent")}${c.counts.failed ? " · " + c.counts.failed + " failed" : ""}${c.counts.queued ? " · " + c.counts.queued + " to go" : ""}${c.discount.mode !== "none" ? " · " + plural(c.codesUsed || 0, "code used", "codes used") : ""}`;
            return `<tr class="cust-row" data-cmp-row="${i}">
              <td class="stack-title"><span class="cmp-swatch" style="background:${esc(th.bg)}"></span><a class="cust-link" href="#discounts/campaigns/${c.id}">${esc(c.name || c.subject || "Untitled campaign")}</a></td>
              <td>${esc(discountText(c))}</td>
              <td class="cust-num">${c.counts.total ? c.counts.total.toLocaleString("en-US") : "—"}</td>
              <td>${statusTag(c.status)}</td>
              <td>${esc(result)}</td></tr>`;
          }).join("")}</tbody></table></div>`;
      } catch (e) {
        if (mine !== seq || !stillOn()) return;
        body.innerHTML = `<div class="cust-err" role="alert">${esc(e.message)}</div>`;
      }
    }
    root.addEventListener("change", (e) => { if (e.target.id === "cmpFilter") { listFilter = e.target.value; load(); } });
    root.addEventListener("click", (e) => {
      if (e.target.closest("#cmpNew")) { location.hash = "discounts/campaigns/new"; return; }
      const row = e.target.closest("tr[data-cmp-row]");
      if (row && !e.target.closest("a")) { const c = rows[Number(row.dataset.cmpRow)]; if (c) location.hash = "discounts/campaigns/" + c.id; }
    });
    await load();
  }

  // ---- One campaign ---------------------------------------------------------------------------------------------
  function newCampaign() {
    const preset = window._campaignPreset || null;
    window._campaignPreset = null;
    const theme = "plain";
    const discount = preset && preset.codeId ? { mode: "shared", codeId: preset.codeId, code: preset.code || "", label: preset.label || "" } : { mode: "none" };
    return { id: null, name: "", subject: R().theme(theme).subject, preheader: "", theme, design: R().starterDesign(theme, discount.mode !== "none"),
      audience: { orgIds: [], last: { mode: "any" }, orders: { mode: "any" }, extra: "" }, discount, status: "draft", counts: { total: 0, sent: 0, failed: 0, queued: 0, skipped: 0 } };
  }

  async function renderOne(app, sub) {
    let c;
    if (sub === "new") c = newCampaign();
    else {
      try { c = (await adminApi_({ action: "getCampaign", id: sub })).campaign; }
      catch (e) {
        adminSetHash("discounts/campaigns/" + sub);
        app.innerHTML = head("Campaign") + `<div class="admin-panel"><div class="cust-err" role="alert">${esc(e.message)}</div></div>`;
        return;
      }
    }
    // One shared code: its code and label, for the preview (the campaign keeps only the code's id).
    if (c.discount && c.discount.mode === "shared" && c.discount.codeId && !c.discount.code) {
      try { const k = (await adminApi_({ action: "getDiscountCode", id: c.discount.codeId })).code; if (k) Object.assign(c.discount, { code: k.code, label: k.label }); } catch (e) { /* shown as CODE */ }
    }
    if (c.status === "draft" && canEdit()) return renderEditor(app, c);
    return renderStatus(app, c);
  }

  // Where a campaign stands (scheduled, sending, sent, canceled — or a draft for someone who can't edit), with its email.
  function renderStatus(app, c) {
    const hash = "discounts/campaigns/" + c.id;
    adminSetHash(hash);
    document.title = adminTitle_(c.name || "Email campaign");
    const draw = () => {
      const k = c.counts, pct = k.total ? Math.round((k.sent + k.failed + k.skipped) / k.total * 100) : 0;
      app.innerHTML = `${head(c.name || c.subject || "Campaign")}
        <div class="admin-panel cust-page cmp-page" id="cmpStatus" style="--org-accent:var(--accent);">
          <div class="cmp-status-head"><div><h2 class="cmp-h">${esc(c.name || c.subject || "Untitled campaign")}</h2>
            <div class="cust-note" style="margin:4px 0 0;">Subject: ${esc(c.subject)}</div></div>${statusTag(c.status)}</div>
          ${c.status === "scheduled" ? `<div class="cust-note">Sends ${esc(when(c.scheduledAt))}${adminDesktop_() ? " — the program needs to be open then (or it sends the next time it opens)" : ""}.</div>` : ""}
          ${k.total ? `<div class="cmp-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
            <div class="cmp-counts"><span><b>${k.sent.toLocaleString("en-US")}</b> sent</span><span><b>${k.queued + k.sending}</b> to go</span><span><b>${k.failed}</b> failed</span><span><b>${k.skipped}</b> skipped</span>
            ${c.discount.mode !== "none" ? `<span><b>${c.codesUsed || 0}</b> ${c.codesUsed === 1 ? "code" : "codes"} used</span>` : ""}</div>` : ""}
          ${c.status === "sending" ? `<div class="cust-note" id="cmpSendingNote">Sending a few at a time${adminDesktop_() ? " while the program is open" : ""}. You can leave this page; it carries on.</div>` : ""}
          <div class="cust-dialog-actions cmp-actions">
            ${c.status === "scheduled" && canEdit() ? `<button type="button" class="admin-btn admin-btn-secondary" id="cmpUnschedule">Unschedule and edit</button>` : ""}
            ${(c.status === "scheduled" || c.status === "sending") && canSend() ? `<button type="button" class="admin-btn admin-btn-danger" id="cmpCancel">${c.status === "sending" ? "Stop sending" : "Cancel"}</button>` : ""}
            ${canEdit() ? `<button type="button" class="admin-btn admin-btn-secondary" id="cmpCopy">Copy to a new campaign</button>` : ""}
            ${!c.startedAt && canSend() && c.status !== "sending" ? `<button type="button" class="admin-btn admin-btn-secondary" id="cmpDelete">Delete</button>` : ""}
          </div>
          <h3 class="dc-h">The email</h3>
          <div class="cmp-canvas-wrap"><div class="cmp-canvas" id="cmpPreview"></div></div>
        </div>`;
      const pv = document.getElementById("cmpPreview");
      pv.innerHTML = fullPreview(c);
      wire();
    };
    const root = () => document.getElementById("cmpStatus");
    let timer = null;
    function wire() {
      const r = root(); if (!r) return;
      const on = (id, f) => { const b = r.querySelector("#" + id); if (b) b.onclick = f; };
      on("cmpCancel", async () => {
        if (!(await askConfirm_(c.status === "sending" ? "Stop sending this campaign? The emails not sent yet won't go." : "Cancel this scheduled campaign?", { confirmLabel: c.status === "sending" ? "Stop sending" : "Cancel campaign", danger: true }))) return;
        try { c = (await adminApi_({ action: "cancelCampaign", id: c.id })).campaign; showToast("Campaign canceled."); draw(); } catch (e) { showToast(e.message, true); }
      });
      on("cmpUnschedule", async () => {
        try { c = (await adminApi_({ action: "saveCampaign", campaign: c })).campaign; renderEditor(document.getElementById("app") || r.parentNode, c); } catch (e) { showToast(e.message, true); }
      });
      on("cmpCopy", async () => {
        try { const d = await adminApi_({ action: "copyCampaign", id: c.id }); showToast("Copied. It's a new draft."); location.hash = "discounts/campaigns/" + d.campaign.id; } catch (e) { showToast(e.message, true); }
      });
      on("cmpDelete", async () => {
        if (!(await askConfirm_("Delete this campaign? It was never sent.", { confirmLabel: "Delete", danger: true }))) return;
        try { await adminApi_({ action: "deleteCampaign", id: c.id }); showToast("Campaign deleted."); location.hash = "discounts/campaigns"; } catch (e) { showToast(e.message, true); }
      });
    }
    // While it sends and this page is open, the next few go every few seconds (the hourly run or the program's timer
    // carry on when no one is watching).
    async function tick() {
      if (_currentAdminHash !== hash || !root()) return;
      if (c.status !== "sending") return;
      try {
        const d = await adminApi_({ action: canEdit() ? "runCampaignQueue" : "getCampaign", id: c.id });
        if (d.campaign) { c = d.campaign; draw(); }
      } catch (e) { /* tried again next time */ }
      timer = setTimeout(tick, 4000);
    }
    draw();
    if (c.status === "sending") timer = setTimeout(tick, 1500);
  }

  function fullPreview(c) {
    const code = c.discount.mode === "shared" ? (c.discount.code || "CODE") : c.discount.mode === "unique" ? "SAMPLE-CODE" : "";
    const out = R().render({ theme: c.theme, design: c.design, vars: sampleVars(c, code), preheader: "", preview: true,
      footerHtml: esc(typeof bizName_ === "function" ? bizName_() : "") + "<br>You're getting this because you're a customer. <u>Unsubscribe</u>" });
    // The email's own body (its tables), without the page around it.
    const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(out.html);
    return m ? m[1] : out.html;
  }

  // ---- The editor -----------------------------------------------------------------------------------------------
  function renderEditor(app, c) {
    let hash = c.id ? "discounts/campaigns/" + c.id : "discounts/campaigns/new";
    adminSetHash(hash);
    document.title = adminTitle_(c.name || "New email campaign");
    const st = { step: "who", sel: 0, view: "desktop", saving: false, savedAt: null, dirty: false, saveTimer: null, hist: [], fut: [], codes: null, products: {}, audienceSeq: 0 };
    if (!c.design || (!Array.isArray(c.design.blocks) && !c.design.html)) c.design = R().starterDesign(c.theme, c.discount.mode !== "none");
    app.innerHTML = `${head(c.name || "New campaign")}
      <div class="admin-panel cust-page cmp-page cmp-editor" id="cmpEd" style="--org-accent:var(--accent);">
        <div class="cmp-top">
          <div class="cmp-steps" role="tablist">
            <button type="button" role="tab" data-step="who">1 Who gets it <span id="cmpWhoCount"></span></button>
            <button type="button" role="tab" data-step="design">2 The email</button>
            <button type="button" role="tab" data-step="discount">3 Discount</button>
            <button type="button" role="tab" data-step="send">4 Send</button>
          </div>
          <div class="cmp-top-right"><span class="cmp-saved" id="cmpSaved" role="status" aria-live="polite"></span>
            <button type="button" class="admin-btn admin-btn-secondary" id="cmpNext">Next</button></div>
        </div>
        <div class="cust-grid cmp-fields">
          <label class="cust-field"><span>Campaign name (only you see it)</span><input type="text" id="cmpName" maxlength="120" value="${esc(c.name)}" placeholder="Black Friday 2026"></label>
          <label class="cust-field"><span>Theme</span><select id="cmpTheme">${R().THEME_KEYS.map(k => `<option value="${k}"${c.theme === k ? " selected" : ""}>${esc(R().THEMES[k].name)}</option>`).join("")}</select></label>
          <label class="cust-field"><span>Subject</span><input type="text" id="cmpSubject" maxlength="200" value="${esc(c.subject)}"></label>
          <label class="cust-field"><span>Preview text (the line inboxes show after the subject)</span><input type="text" id="cmpPre" maxlength="200" value="${esc(c.preheader)}" placeholder="Your own code inside, good through Monday"></label>
        </div>
        <div id="cmpStep"></div>
      </div>`;
    const root = document.getElementById("cmpEd"), stepEl = root.querySelector("#cmpStep");
    const $ = (s) => root.querySelector(s);
    const stillOn = () => _currentAdminHash === hash && root.isConnected;

    // Saving: a draft saves itself a second after a change (the first save gives it its id and address).
    function changed(opts) {
      st.dirty = true;
      $("#cmpSaved").textContent = "Saving…";
      clearTimeout(st.saveTimer);
      st.saveTimer = setTimeout(save, (opts && opts.now) ? 0 : 1000);
    }
    async function save() {
      if (st.saving) { st.saveTimer = setTimeout(save, 500); return; }
      if (!stillOn()) return;
      st.saving = true; st.dirty = false;
      try {
        const d = await adminApi_({ action: "saveCampaign", campaign: { id: c.id, name: c.name, subject: c.subject, preheader: c.preheader, theme: c.theme, design: c.design, audience: c.audience, discount: c.discount } });
        if (!c.id && d.campaign) {
          c.id = d.campaign.id;
          hash = "discounts/campaigns/" + c.id;
          _currentAdminHash = hash;
          history.replaceState(null, "", "#" + hash);
        }
        if (d.campaign) { c.status = d.campaign.status; c.counts = d.campaign.counts; }
        $("#cmpSaved").textContent = st.dirty ? "Saving…" : "✓ Draft saved";
      } catch (e) { $("#cmpSaved").textContent = "Not saved: " + e.message; }
      finally { st.saving = false; }
      return c.id;
    }
    // Undo / redo of the email (the design and theme), up to 50 steps.
    function remember() { st.hist.push(JSON.stringify({ design: c.design, theme: c.theme })); if (st.hist.length > 50) st.hist.shift(); st.fut = []; }
    function restore(from, to) {
      if (!from.length) return;
      to.push(JSON.stringify({ design: c.design, theme: c.theme }));
      const s = JSON.parse(from.pop()); c.design = s.design; c.theme = s.theme; $("#cmpTheme").value = c.theme;
      st.sel = Math.min(st.sel, Math.max(0, (c.design.blocks || []).length - 1));
      drawStep(); changed();
    }

    // The top fields.
    root.addEventListener("input", (e) => {
      const id = e.target.id;
      if (id === "cmpName") { c.name = e.target.value; changed(); }
      else if (id === "cmpSubject") { c.subject = e.target.value; changed(); }
      else if (id === "cmpPre") { c.preheader = e.target.value; changed(); }
    });
    $("#cmpTheme").addEventListener("change", async (e) => {
      const next = e.target.value, old = c.theme;
      remember();
      c.theme = next;
      // A new theme fills in its own banner words and subject where they were still the old theme's.
      const tOld = R().theme(old), tNew = R().theme(next);
      for (const b of c.design.blocks || []) {
        if (b.t === "banner") { if (!b.h || b.h === tOld.h) b.h = tNew.h; if (!b.s || b.s === tOld.s) b.s = tNew.s; }
        if (b.t === "button" && (!b.x || b.x === tOld.button)) b.x = tNew.button;
        if (b.t === "text" && b.x === "Hi {first name},<br>" + R().esc(tOld.body)) b.x = "Hi {first name},<br>" + R().esc(tNew.body);
      }
      if (!c.subject || c.subject === tOld.subject) { c.subject = tNew.subject; $("#cmpSubject").value = c.subject; }
      drawStep(); changed();
    });
    root.querySelector(".cmp-steps").addEventListener("click", (e) => { const b = e.target.closest("[data-step]"); if (b) { st.step = b.dataset.step; drawStep(); } });
    $("#cmpNext").addEventListener("click", () => { const order = ["who", "design", "discount", "send"]; st.step = order[Math.min(3, order.indexOf(st.step) + 1)]; drawStep(); });

    function drawStep() {
      root.querySelectorAll(".cmp-steps [data-step]").forEach(b => { const on = b.dataset.step === st.step; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
      $("#cmpNext").hidden = st.step === "send";
      if (st.step === "who") drawWho(); else if (st.step === "design") drawDesign(); else if (st.step === "discount") drawDiscount(); else drawSend();
    }

    // ---- Step 1: who gets it ----
    function drawWho() {
      const a = c.audience, list = shops();
      stepEl.innerHTML = `<div class="cmp-who">
        ${list.length > 1 ? `<div class="cmp-row"><span class="cmp-label">Shops</span><div class="cmp-chips">
          <label class="cmp-chip${!a.orgIds.length ? " on" : ""}"><input type="checkbox" data-shop="" ${!a.orgIds.length ? "checked" : ""}> All shops</label>
          ${list.map(o => `<label class="cmp-chip${a.orgIds.includes(o.orgId) ? " on" : ""}"><input type="checkbox" data-shop="${esc(o.orgId)}" ${a.orgIds.includes(o.orgId) ? "checked" : ""}> ${esc(o.name || o.orgId)}</label>`).join("")}
        </div></div>` : ""}
        <div class="cmp-row"><span class="cmp-label">Last order</span><div class="cmp-inline">
          <select id="cmpLast">${LAST_MODES.map(([k, l]) => `<option value="${k}"${a.last.mode === k ? " selected" : ""}>${l}</option>`).join("")}</select>
          <span id="cmpLastN"${a.last.mode === "olderThan" || a.last.mode === "within" ? "" : " hidden"}><input type="number" id="cmpLastNum" min="1" max="3650" step="1" value="${esc(a.last.n || 3)}" style="width:80px;">
            <select id="cmpLastUnit"><option value="days"${a.last.unit !== "months" ? " selected" : ""}>days</option><option value="months"${a.last.unit === "months" ? " selected" : ""}>months</option></select> ago</span>
          <span id="cmpLastD"${a.last.mode === "before" ? "" : " hidden"}><input type="date" id="cmpLastDate" value="${esc(a.last.date || "")}"></span>
        </div></div>
        <div class="cmp-row"><span class="cmp-label">Orders</span><div class="cmp-inline">
          <select id="cmpOrders">${ORDER_MODES.map(([k, l]) => `<option value="${k}"${a.orders.mode === k ? " selected" : ""}>${l}</option>`).join("")}</select>
          <input type="number" id="cmpOrdersN" min="0" max="100000" step="1" value="${esc(a.orders.n != null ? a.orders.n : 2)}" style="width:80px;"${a.orders.mode === "any" ? " hidden" : ""}>
        </div></div>
        <div class="cmp-row"><span class="cmp-label">Also send to</span>
          <label class="cust-field" style="flex:1;margin:0;"><textarea id="cmpExtra" rows="3" spellcheck="false" placeholder="sam@example.com, pat@example.com">${esc(a.extra)}</textarea>
          <small class="dc-hint" style="display:block;margin-top:4px;">Addresses typed here get it whatever the rules above say (unless they unsubscribed).</small>
          <label class="cust-check" style="display:flex;gap:6px;align-items:center;margin-top:6px;font-size:13px;"><input type="checkbox" id="cmpOnly"${a.onlyTyped ? " checked" : ""}> Only these addresses (ignore the shops, last order and orders above)</label></label></div>
        <div class="cmp-count" id="cmpCount" role="status" aria-live="polite">Counting…</div>
      </div>`;
      const readA = () => {
        const sel = [...stepEl.querySelectorAll("[data-shop]")].filter(x => x.checked && x.dataset.shop).map(x => x.dataset.shop);
        const lm = $("#cmpLast").value, om = $("#cmpOrders").value;
        c.audience = { orgIds: sel,
          last: lm === "any" ? { mode: "any" } : lm === "before" ? { mode: "before", date: $("#cmpLastDate").value } : { mode: lm, n: Number($("#cmpLastNum").value) || 0, unit: $("#cmpLastUnit").value },
          orders: om === "any" ? { mode: "any" } : { mode: om, n: Math.max(0, Math.round(Number($("#cmpOrdersN").value) || 0)) },
          extra: $("#cmpExtra").value, onlyTyped: $("#cmpOnly").checked };
        $("#cmpLastN").hidden = !(lm === "olderThan" || lm === "within");
        $("#cmpLastD").hidden = lm !== "before";
        $("#cmpOrdersN").hidden = om === "any";
        changed(); count();
      };
      stepEl.addEventListener("change", (e) => {
        const box = e.target.closest("[data-shop]");
        if (box) {
          if (!box.dataset.shop && box.checked) stepEl.querySelectorAll("[data-shop]").forEach(x => { if (x.dataset.shop) x.checked = false; });
          else if (box.dataset.shop && box.checked) stepEl.querySelector('[data-shop=""]').checked = false;
          if (![...stepEl.querySelectorAll("[data-shop]")].some(x => x.checked)) stepEl.querySelector('[data-shop=""]').checked = true;
          stepEl.querySelectorAll(".cmp-chip").forEach(l => l.classList.toggle("on", l.querySelector("input").checked));
        }
        readA();
      });
      let t = null;
      stepEl.addEventListener("input", (e) => { if (e.target.matches("#cmpExtra, #cmpLastNum, #cmpOrdersN")) { clearTimeout(t); t = setTimeout(readA, 400); } });
      count();
    }
    async function count() {
      const mine = ++st.audienceSeq, el = $("#cmpCount");
      try {
        const d = await adminApi_({ action: "previewAudience", audience: c.audience });
        if (mine !== st.audienceSeq || !stillOn()) return;
        st.audience = d;
        $("#cmpWhoCount").textContent = "· " + d.count.toLocaleString("en-US");
        if (!el) return;
        const parts = [`<b>${plural(d.count, "person", "people")}</b>`];
        if (d.typed) parts.push(plural(d.typed, "typed address", "typed addresses") + " included");
        if (d.optedOut) parts.push(d.optedOut + " unsubscribed left out");
        if (d.bad && d.bad.length) parts.push(`<span class="cust-err">${d.bad.length === 1 ? "1 typed entry isn't" : d.bad.length + " typed entries aren't"} an email address: ${esc(d.bad.slice(0, 3).join(", "))}</span>`);
        el.innerHTML = `<span>${parts.join(" · ")}</span>${d.tooMany ? `<span class="cust-err">One campaign goes to at most ${d.max.toLocaleString("en-US")} people. Narrow who gets it.</span>` : ""}
          ${d.count ? `<button type="button" class="admin-btn admin-btn-secondary" id="cmpSeeList">See the list</button>` : ""}`;
        const see = el.querySelector("#cmpSeeList");
        if (see) see.onclick = () => inventoryModal_("Who gets it", `<div class="cust-note">${d.count > d.people.length ? `The first ${d.people.length} of ${d.count.toLocaleString("en-US")}.` : plural(d.count, "person", "people") + "."}</div>
          <div class="admin-table-wrap dc-bulk-list"><table class="stack-mobile cust-table"><thead><tr><th>Email</th><th>Name</th></tr></thead>
          <tbody>${d.people.map(p => `<tr><td>${esc(p.email)}</td><td>${esc(p.name)}</td></tr>`).join("")}</tbody></table></div>`, 560);
      } catch (e) {
        if (mine !== st.audienceSeq || !el) return;
        el.innerHTML = `<span class="cust-err">${esc(e.message)}</span>`;
      }
    }

    // ---- Step 2: the email ----
    function previewCode() { return c.discount.mode === "shared" ? (c.discount.code || "CODE") : c.discount.mode === "unique" ? "SAMPLE-CODE" : ""; }
    function drawDesign() {
      const raw = !!(c.design && c.design.html != null && !Array.isArray(c.design.blocks));
      stepEl.innerHTML = `<div class="cmp-design">
        <div class="cmp-palette"><div class="cmp-small">Add a block</div>
          ${BLOCKS.map(([k, l, i]) => `<button type="button" class="cmp-pal" data-add="${k}"${raw ? " disabled" : ""}><span aria-hidden="true">${i}</span> ${l}</button>`).join("")}
          <div class="cmp-small" style="margin-top:8px;">Adds below the block you picked.</div></div>
        <div class="cmp-center">
          <div class="cmp-toolbar">
            <div class="cmp-seg" role="group" aria-label="View">
              <button type="button" data-view="desktop" class="${st.view === "desktop" ? "on" : ""}">Desktop</button><button type="button" data-view="phone" class="${st.view === "phone" ? "on" : ""}">Phone</button><button type="button" data-view="html" class="${st.view === "html" ? "on" : ""}">HTML</button>
            </div>
            <div><button type="button" class="cmp-icon" id="cmpUndo" title="Undo" aria-label="Undo">↶</button><button type="button" class="cmp-icon" id="cmpRedo" title="Redo" aria-label="Redo">↷</button></div>
          </div>
          <div class="cmp-canvas-wrap" id="cmpCanvasWrap"><div class="cmp-canvas${st.view === "phone" ? " phone" : ""}" id="cmpCanvas"></div></div>
          <div class="cmp-small">Fill-ins: {first name} · {name} · {code} · {shop} · {expires}. The footer, your business details and the unsubscribe line are added to every email.</div>
        </div>
        <div class="cmp-panel" id="cmpPanel"></div>
      </div>`;
      drawCanvas(); drawPanel();
      stepEl.querySelector(".cmp-palette").addEventListener("click", (e) => {
        const b = e.target.closest("[data-add]"); if (!b || b.disabled) return;
        const blocks = c.design.blocks || (c.design.blocks = []);
        if (blocks.length >= R().MAX_BLOCKS) { showToast("An email can have at most " + R().MAX_BLOCKS + " blocks.", true); return; }
        remember();
        const t = b.dataset.add, th = R().theme(c.theme);
        const nb = { banner: { t, h: th.h, s: th.s, art: "theme" }, heading: { t, x: "A heading", align: "left" }, text: { t, x: "Write something here.", align: "left" },
          code: { t, x: "YOUR CODE" }, button: { t, x: th.button, url: "" }, products: { t, items: [] }, image: { t, src: "", alt: "", url: "" }, divider: { t }, spacer: { t, h: 24 } }[t];
        const at = blocks.length ? Math.min(blocks.length, st.sel + 1) : 0;
        blocks.splice(at, 0, nb); st.sel = at;
        drawCanvas(); drawPanel(); changed();
      });
      stepEl.querySelector(".cmp-seg").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) { st.view = b.dataset.view; drawDesign(); } });
      $("#cmpUndo").onclick = () => restore(st.hist, st.fut);
      $("#cmpRedo").onclick = () => restore(st.fut, st.hist);
      $("#cmpCanvas").addEventListener("click", (e) => {
        if (e.target.closest("a")) e.preventDefault();
        const row = e.target.closest("tr[data-i]"); if (!row) return;
        st.sel = Number(row.dataset.i); drawCanvas(); drawPanel();
      });
    }
    function drawCanvas() {
      const cv = $("#cmpCanvas"); if (!cv) return;
      const raw = c.design && c.design.html != null && !Array.isArray(c.design.blocks);
      if (st.view === "html") {
        const full = R().render({ theme: c.theme, design: c.design, vars: sampleVars(c, "{code}"), preheader: c.preheader, footerHtml: "" }).html;
        const m = /<table role="presentation" width="600"[\s\S]*?>([\s\S]*)<tr><td style="padding:18px 28px 24px;border-top/.exec(full);
        const body = raw ? c.design.html : (m ? `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;font-family:Helvetica,Arial,sans-serif;color:#232323;">${m[1]}</table>` : "");
        cv.innerHTML = `<div class="cmp-html">
          <div class="cmp-small">${raw ? "This email is written in HTML." : "The email as HTML. Change it here and press “Use this HTML” to edit it as HTML from now on (the blocks are then put away)."}</div>
          <textarea id="cmpHtml" rows="18" spellcheck="false">${esc(body)}</textarea>
          <div class="cust-dialog-actions">${raw ? `<button type="button" class="admin-btn admin-btn-secondary" id="cmpBackBlocks">Back to blocks (start over from the theme)</button>` : ""}
          <button type="button" class="admin-btn" id="cmpUseHtml">${raw ? "Update" : "Use this HTML"}</button></div></div>`;
        cv.querySelector("#cmpUseHtml").onclick = async () => {
          const v = cv.querySelector("#cmpHtml").value;
          if (!raw && !(await askConfirm_("Edit this email as HTML from now on? The blocks are put away; “Back to blocks” starts again from the theme.", { confirmLabel: "Use this HTML" }))) return;
          remember(); c.design = { html: v }; changed(); showToast("HTML saved."); drawDesign();
        };
        const back = cv.querySelector("#cmpBackBlocks");
        if (back) back.onclick = async () => {
          if (!(await askConfirm_("Go back to blocks? Your HTML is replaced by the theme's starting email.", { confirmLabel: "Back to blocks", danger: true }))) return;
          remember(); c.design = R().starterDesign(c.theme, c.discount.mode !== "none"); st.sel = 0; st.view = "desktop"; changed(); drawDesign();
        };
        return;
      }
      if (raw) { cv.innerHTML = fullPreview(c); return; }
      const rows = R().blockRows({ theme: c.theme, design: c.design, vars: sampleVars(c, previewCode()) }) || [];
      cv.innerHTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="cmp-email">
        ${rows.map((h, i) => h.replace(/^<tr/, `<tr data-i="${i}" class="cmp-blk${i === st.sel ? " sel" : ""}" title="${esc(BLOCK_NAME[c.design.blocks[i].t])} — click to change"`)).join("")}
        ${rows.length ? "" : `<tr><td style="padding:30px;text-align:center;color:#888;font-size:14px;">Add blocks from the left.</td></tr>`}
        <tr><td style="padding:16px 28px;border-top:1px solid #eee;font-size:12px;color:#6b6558;text-align:center;">${esc(typeof bizName_ === "function" ? bizName_() : "")} · Your business details · <u>Unsubscribe</u></td></tr>
      </table>`;
    }
    // The picked block's settings.
    function drawPanel() {
      const p = $("#cmpPanel"); if (!p) return;
      const blocks = c.design.blocks;
      if (!Array.isArray(blocks)) { p.innerHTML = `<div class="cmp-small">The HTML tab edits this email.</div>`; return; }
      const b = blocks[st.sel];
      if (!b) { p.innerHTML = `<div class="cmp-small">Pick a block in the email to change it.</div>`; return; }
      const F = (label, html) => `<label class="cust-field"><span>${label}</span>${html}</label>`;
      const alignSel = (v) => `<select data-k="align">${["left", "center", "right"].map(a => `<option${(v || "left") === a ? " selected" : ""}>${a}</option>`).join("")}</select>`;
      let h = `<div class="cmp-panel-head"><b>${esc(BLOCK_NAME[b.t])}</b><span>
        <button type="button" class="cmp-icon" data-move="-1" title="Move up" aria-label="Move up">↑</button><button type="button" class="cmp-icon" data-move="1" title="Move down" aria-label="Move down">↓</button>
        <button type="button" class="cmp-icon" data-dup title="Duplicate" aria-label="Duplicate">⧉</button></span></div>`;
      if (b.t === "banner") h += F("Picture", `<select data-k="art"><option value="theme"${b.art === "theme" ? " selected" : ""}>The theme's picture</option><option value="image"${b.art === "image" ? " selected" : ""}>My own (a web address)</option><option value="none"${b.art === "none" ? " selected" : ""}>Colour only</option></select>`)
        + (b.art === "image" ? F("Picture's web address", `<input type="url" data-k="img" value="${esc(b.img)}" placeholder="https://…">`) : "")
        + F("Headline", `<input type="text" data-k="h" maxlength="120" value="${esc(b.h)}">`) + F("Tagline", `<input type="text" data-k="s" maxlength="200" value="${esc(b.s)}">`);
      else if (b.t === "heading") h += F("Heading", `<input type="text" data-k="x" maxlength="300" value="${esc(b.x)}">`) + F("Align", alignSel(b.align));
      else if (b.t === "text") h += `<div class="cust-field"><span>Text</span>
          <div class="cmp-rt-bar" role="toolbar" aria-label="Text style">
            <button type="button" data-cmd="bold" title="Bold" aria-label="Bold"><b>B</b></button><button type="button" data-cmd="italic" title="Italic" aria-label="Italic"><i>I</i></button>
            <button type="button" data-cmd="underline" title="Underline" aria-label="Underline"><u>U</u></button><button type="button" data-cmd="link" title="Link" aria-label="Link">🔗</button>
            ${SWATCHES.map(s => `<button type="button" class="cmp-sw" data-color="${s}" title="Text colour ${s}" aria-label="Text colour ${s}" style="background:${s}"></button>`).join("")}
          </div>
          <div class="cmp-rt" id="cmpRt" contenteditable="true" role="textbox" aria-multiline="true">${R().cleanInline(b.x)}</div></div>`
        + F("Align", alignSel(b.align));
      else if (b.t === "code") h += F("Line over the code", `<input type="text" data-k="x" maxlength="200" value="${esc(b.x)}">`)
        + `<div class="cmp-small">${c.discount.mode === "none" ? "The campaign has no discount yet (step 3), so this box isn't in the email." : c.discount.mode === "unique" ? "Each person sees their own code here." : "Everyone sees " + esc(c.discount.code || "the code") + " here."}</div>`;
      else if (b.t === "button") h += F("Label", `<input type="text" data-k="x" maxlength="60" value="${esc(b.x)}">`)
        + F("Links to", `<input type="url" data-k="url" value="${esc(b.url)}" placeholder="Leave blank for your site">`);
      else if (b.t === "products") h += productsPanel(b);
      else if (b.t === "image") h += F("Picture's web address", `<input type="url" data-k="src" value="${esc(b.src)}" placeholder="https://…">`)
        + F("Describe it (for screen readers)", `<input type="text" data-k="alt" maxlength="200" value="${esc(b.alt)}">`) + F("Links to (optional)", `<input type="url" data-k="url" value="${esc(b.url)}" placeholder="https://…">`);
      else if (b.t === "spacer") h += F("Height", `<input type="range" data-k="h" min="0" max="40" step="2" value="${esc(b.h == null ? 24 : b.h)}">`);
      if (b.t !== "spacer") h += F("Space around it", `<input type="range" data-k="pad" min="0" max="40" step="2" value="${esc(b.pad == null ? 14 : b.pad)}">`);
      h += `<button type="button" class="admin-btn admin-btn-secondary cmp-remove" data-remove>Remove block</button>`;
      p.innerHTML = h;
      p.oninput = (e) => {
        const k = e.target.dataset && e.target.dataset.k;
        if (k) { b[k] = e.target.type === "range" ? Number(e.target.value) : e.target.value; drawCanvas(); changed(); }
        if (e.target.id === "cmpRt") { b.x = e.target.innerHTML; drawCanvas(); changed(); }
      };
      p.onchange = (e) => { const k = e.target.dataset && e.target.dataset.k; if (k === "art") { remember(); b.art = e.target.value; drawPanel(); drawCanvas(); changed(); } };
      p.onfocusin = (e) => { if (e.target.matches("input, textarea, [contenteditable]") && !p.dataset.remembered) { remember(); p.dataset.remembered = "1"; } };
      p.onclick = async (e) => {
        const t = e.target.closest("button"); if (!t) return;
        if (t.dataset.move) {
          const to = st.sel + Number(t.dataset.move); if (to < 0 || to >= blocks.length) return;
          remember(); [blocks[st.sel], blocks[to]] = [blocks[to], blocks[st.sel]]; st.sel = to; drawCanvas(); drawPanel(); changed();
        } else if (t.hasAttribute("data-dup")) {
          if (blocks.length >= R().MAX_BLOCKS) return;
          remember(); blocks.splice(st.sel + 1, 0, JSON.parse(JSON.stringify(b))); st.sel++; drawCanvas(); drawPanel(); changed();
        } else if (t.hasAttribute("data-remove")) {
          remember(); blocks.splice(st.sel, 1); st.sel = Math.max(0, Math.min(st.sel, blocks.length - 1)); drawCanvas(); drawPanel(); changed();
        } else if (t.dataset.cmd || t.dataset.color) {
          const rt = p.querySelector("#cmpRt"); if (!rt) return;
          rt.focus();
          if (t.dataset.cmd === "link") {
            const url = await askText_("Link to which web address?", { label: "Web address", placeholder: "https://…", confirmLabel: "Add link",
              validate: (v) => /^(https?:\/\/|mailto:)\S+$/i.test(String(v).trim()) ? "" : "Enter an address starting with https://" });
            if (!url) return;
            rt.focus(); document.execCommand("createLink", false, url.trim());
          } else if (t.dataset.color) document.execCommand("foreColor", false, t.dataset.color);
          else document.execCommand(t.dataset.cmd);
          // execCommand writes <font color> in some browsers: kept as a span with a colour.
          rt.querySelectorAll("font[color]").forEach(f => { const s = document.createElement("span"); s.setAttribute("style", "color:" + f.getAttribute("color")); s.innerHTML = f.innerHTML; f.replaceWith(s); });
          b.x = rt.innerHTML; drawCanvas(); changed();
        } else if (t.dataset.pickProducts != null) pickProducts(b);
      };
      delete p.dataset.remembered;
    }
    function productsPanel(b) {
      return `<div class="cmp-small">${b.items.length ? b.items.map(it => esc(it.name)).join(", ") : "No products picked yet."}</div>
        <button type="button" class="admin-btn admin-btn-secondary" data-pick-products>Pick products…</button>`;
    }
    async function pickProducts(b) {
      const list = shops();
      const { ov, close } = inventoryModal_("Pick up to 4 products", `
        ${list.length > 1 ? `<label class="cust-field"><span>Shop</span><select id="cmpPShop">${list.map(o => `<option value="${esc(o.orgId)}">${esc(o.name || o.orgId)}</option>`).join("")}</select></label>` : ""}
        <div id="cmpPList" class="cmp-plist">Loading…</div>
        <div class="cust-err" id="cmpPErr"></div>
        <div class="cust-dialog-actions"><button type="button" class="admin-btn admin-btn-secondary" data-modal-close>Cancel</button><button type="button" class="admin-btn" id="cmpPUse">Use these</button></div>`, 560);
      const picked = new Map(b.items.map(it => [it.name, it]));
      const load = async (org) => {
        const box = ov.querySelector("#cmpPList");
        box.textContent = "Loading…";
        try {
          if (!st.products[org]) st.products[org] = ((await adminApi_({ action: "listProducts", org })).products || []).filter(p => p.visible !== false);
          const ps = st.products[org];
          if (!ps.length) { box.textContent = "This shop has no products to show."; return; }
          box.innerHTML = ps.map((p, i) => {
            const prices = p.flatPrice != null ? [p.flatPrice] : Object.values(p.sizePricing || {}).map(Number).filter(n => n > 0);
            const price = prices.length ? "$" + Math.min(...prices).toFixed(2) + (prices.length > 1 && Math.max(...prices) > Math.min(...prices) ? "+" : "") : "";
            const img0 = Array.isArray(p.images) && p.images[0] ? (typeof p.images[0] === "string" ? p.images[0] : (p.images[0].url || "")) : "";
            p._item = { name: p.name, price, image: img0, url: "" };
            return `<label class="cmp-pitem"><input type="checkbox" data-pi="${i}"${picked.has(p.name) ? " checked" : ""}> ${esc(p.name)} <span class="cmp-small">${esc(price)}</span></label>`;
          }).join("");
          box.onchange = (e) => {
            const i = e.target.dataset.pi; if (i == null) return;
            const it = ps[Number(i)]._item;
            if (e.target.checked) { if (picked.size >= 4) { e.target.checked = false; ov.querySelector("#cmpPErr").textContent = "Up to 4."; return; } picked.set(it.name, it); }
            else picked.delete(it.name);
            ov.querySelector("#cmpPErr").textContent = "";
          };
        } catch (e) { box.innerHTML = `<span class="cust-err">${esc(e.message)}</span>`; }
      };
      const shopSel = ov.querySelector("#cmpPShop");
      if (shopSel) shopSel.onchange = () => load(shopSel.value);
      load(shopSel ? shopSel.value : (list[0] && list[0].orgId) || "");
      ov.querySelector("#cmpPUse").onclick = () => { remember(); b.items = [...picked.values()].slice(0, 4); close(); drawCanvas(); drawPanel(); changed(); };
    }

    // ---- Step 3: the discount ----
    async function drawDiscount() {
      const d = c.discount;
      stepEl.innerHTML = `<div class="cmp-discount">
        <label class="cust-check"><input type="radio" name="cmpDisc" value="none"${d.mode === "none" ? " checked" : ""}> No discount</label>
        <label class="cust-check"><input type="radio" name="cmpDisc" value="shared"${d.mode === "shared" ? " checked" : ""}> One code for everyone</label>
        <div class="dc-indent" id="cmpShared"${d.mode === "shared" ? "" : " hidden"}><label class="cust-field"><span>Code</span><select id="cmpCode"><option value="">Loading…</option></select></label>
          <div class="cmp-small">Only codes that are on, not used up and not expired. Make one on the Codes tab. A code anyone can use as many times as people get the email works best.</div></div>
        <label class="cust-check"><input type="radio" name="cmpDisc" value="unique"${d.mode === "unique" ? " checked" : ""}> A code for each person (works once, only with their email)</label>
        <div class="dc-indent" id="cmpUnique"${d.mode === "unique" ? "" : " hidden"}>
          <div class="cust-grid">
            <label class="cust-field"><span>Discount</span><select id="cmpUKind"><option value="percent"${d.kind !== "amount" ? " selected" : ""}>Percent off</option><option value="amount"${d.kind === "amount" ? " selected" : ""}>Amount off</option></select></label>
            <label class="cust-field"><span id="cmpUValL">${d.kind === "amount" ? "Amount ($)" : "Percent (%)"}</span><input type="number" id="cmpUVal" step="0.01" min="0.01" value="${esc(d.kind === "amount" ? (d.amount || "") : (d.percent || ""))}"></label>
            <label class="cust-field" id="cmpUMaxW"${d.kind === "amount" ? " hidden" : ""}><span>Max discount ($, optional)</span><input type="number" id="cmpUMax" step="0.01" min="0.01" placeholder="No limit" value="${esc(d.maxDiscount || "")}"></label>
            <label class="cust-field"><span>Expires (blank = never)</span><input type="date" id="cmpUExp" value="${esc(d.expiresOn || "")}"></label>
            ${shops().length > 1 ? `<label class="cust-field"><span>Shop</span><select id="cmpUShop"><option value="">All shops</option>${shops().map(o => `<option value="${esc(o.orgId)}"${d.orgId === o.orgId ? " selected" : ""}>${esc(o.name || o.orgId)}</option>`).join("")}</select></label>` : ""}
            <label class="cust-field"><span>Start each code with (optional)</span><input type="text" id="cmpUPre" class="dc-code" maxlength="12" value="${esc(d.prefix || "")}" placeholder="BF-"></label>
          </div>
          <div class="cmp-small">The codes are made when the campaign starts sending, and show on the Codes tab with the campaign's name in their note.</div>
        </div>
        ${(c.design.blocks || []).some(b => b.t === "code") || d.mode === "none" ? "" : `<div class="dc-locked" style="margin-top:10px;">The email has no Discount code block, so the code isn't shown. Add one in step 2.</div>`}
      </div>`;
      const read = () => {
        const mode = (stepEl.querySelector('input[name="cmpDisc"]:checked') || {}).value || "none";
        $("#cmpShared").hidden = mode !== "shared"; $("#cmpUnique").hidden = mode !== "unique";
        if (mode === "none") c.discount = { mode: "none" };
        else if (mode === "shared") {
          const sel = $("#cmpCode"), id = Number(sel.value), code = (st.codes || []).find(x => x.id === id);
          c.discount = id ? { mode: "shared", codeId: id, code: code ? code.code : "", label: code ? code.label : "" } : { mode: "none" };
          if (!id) c.discount = { mode: "shared", codeId: 0 };
        } else {
          const kind = $("#cmpUKind").value, v = $("#cmpUVal").value;
          $("#cmpUValL").textContent = kind === "amount" ? "Amount ($)" : "Percent (%)"; $("#cmpUMaxW").hidden = kind === "amount";
          c.discount = { mode: "unique", kind, percent: kind === "percent" ? Number(v) || null : null, amount: kind === "amount" ? Number(v) || null : null,
            maxDiscount: kind === "percent" && $("#cmpUMax").value ? Number($("#cmpUMax").value) : null, expiresOn: $("#cmpUExp").value || null,
            orgId: $("#cmpUShop") ? $("#cmpUShop").value || null : null, prefix: $("#cmpUPre").value.toUpperCase().replace(/[^A-Z0-9_-]/g, "") };
        }
        // A discount and no code block: one is added after the first text block, so the code shows.
        if (c.discount.mode !== "none" && Array.isArray(c.design.blocks) && !c.design.blocks.some(b => b.t === "code")) {
          const at = c.design.blocks.findIndex(b => b.t === "text");
          c.design.blocks.splice(at >= 0 ? at + 1 : c.design.blocks.length, 0, { t: "code", x: "YOUR CODE" });
          showToast("Added a Discount code block to the email.");
        }
        changed();
      };
      stepEl.addEventListener("change", read);
      stepEl.addEventListener("input", (e) => { if (e.target.matches("#cmpUVal, #cmpUMax, #cmpUPre")) read(); });
      try {
        if (!st.codes) st.codes = ((await adminApi_({ action: "listDiscountCodes", status: "active", limit: 200 })).codes || []);
        const sel = $("#cmpCode"); if (!sel) return;
        sel.innerHTML = `<option value="">Pick a code</option>` + st.codes.map(x => `<option value="${x.id}"${d.codeId === x.id ? " selected" : ""}>${esc(x.code)} — ${esc(x.label)}${x.email ? " (one person's)" : ""}</option>`).join("");
      } catch (e) { const sel = $("#cmpCode"); if (sel) sel.innerHTML = `<option value="">Couldn't load the codes</option>`; }
    }

    // ---- Step 4: send ----
    function drawSend() {
      const n = st.audience ? st.audience.count : null;
      const tomorrow = new Date(Date.now() + 86400000); tomorrow.setMinutes(0, 0, 0);
      const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      stepEl.innerHTML = `<div class="cmp-send">
        <table class="cmp-summary"><tbody>
          <tr><th>To</th><td>${n == null ? "Counting…" : plural(n, "person", "people")}</td></tr>
          <tr><th>Subject</th><td>${esc(c.subject || "(none yet)")}</td></tr>
          <tr><th>Theme</th><td>${esc(R().theme(c.theme).name)}</td></tr>
          <tr><th>Discount</th><td>${esc(c.discount.mode === "none" ? "None" : c.discount.mode === "shared" ? (c.discount.code || "Pick a code") + " for everyone" : discountLabel(c.discount) + ", a code for each person")}</td></tr>
        </tbody></table>
        <h3 class="dc-h">Send a test</h3>
        <div class="cmp-inline"><input type="email" id="cmpTestTo" placeholder="you@example.com" style="min-width:240px;"><button type="button" class="admin-btn admin-btn-secondary" id="cmpTest">Send me a test</button></div>
        <h3 class="dc-h">Send it</h3>
        ${canSend() ? `<div class="cmp-inline">
          <button type="button" class="admin-btn" id="cmpSendNow">Send now${n ? " to " + n.toLocaleString("en-US") : ""}</button>
          <span class="cmp-small">or at</span><input type="datetime-local" id="cmpAt" value="${local(tomorrow)}">
          <button type="button" class="admin-btn admin-btn-secondary" id="cmpSchedule">Schedule</button></div>
          <div class="cmp-small" style="margin-top:6px;">${adminDesktop_() ? "The program sends while it's open. A time that passes while it's closed sends the next time it opens." : "Emails go out a few at a time; a large list takes a while to finish."} Who gets it is worked out again when it starts.</div>`
          : `<div class="cust-note">Your role can't send campaigns. Ask an admin.</div>`}
        <div class="cust-err" id="cmpSendErr" role="alert"></div>
      </div>`;
      if (n == null) count().then(() => { if (st.step === "send" && stillOn()) drawSend(); });
      const err = $("#cmpSendErr");
      $("#cmpTest").onclick = async (e) => {
        const to = $("#cmpTestTo").value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { err.textContent = "Enter the address to send the test to."; return; }
        e.target.disabled = true; err.textContent = "";
        try { const d = await adminApi_({ action: "sendCampaignTest", to, campaign: c }); showToast("Test sent to " + d.sentTo + "."); }
        catch (ex) { err.textContent = ex.message; }
        finally { e.target.disabled = false; }
      };
      const go = async (at) => {
        err.textContent = "";
        clearTimeout(st.saveTimer);
        await save();
        if (!c.id) { err.textContent = "The campaign couldn't be saved. Try again."; return; }
        const what = at ? `Schedule this campaign for ${when(at)}?` : `Send this campaign now to ${n == null ? "everyone who matches" : plural(n, "person", "people")}?`;
        if (!(await askConfirm_(what + (c.discount.mode === "unique" ? " A code is made for each person." : ""), { confirmLabel: at ? "Schedule" : "Send now" }))) return;
        try {
          const d = await adminApi_({ action: "scheduleCampaign", id: c.id, at: at || "" });
          showToast(at ? "Scheduled." : "Sending started.");
          renderStatus(document.getElementById("app") || root.parentNode, d.campaign);
        } catch (ex) { err.textContent = ex.message; }
      };
      const sn = $("#cmpSendNow"); if (sn) sn.onclick = () => go(null);
      const sc = $("#cmpSchedule"); if (sc) sc.onclick = () => { const v = $("#cmpAt").value; if (!v) { err.textContent = "Pick when to send it."; return; } go(new Date(v).toISOString()); };
    }

    drawStep();
    count();
    if (!c.id) changed({ now: true });   // a new campaign is saved at once, so it has an address
  }

  window.renderCampaigns = async function (app, sub) {
    if (!R()) { app.innerHTML = `<div class="admin-panel"><div class="cust-err">The email editor didn't load. Reload the page.</div></div>`; return; }
    if (sub == null) return renderList(app);
    if (sub === "new" && !canEdit()) return renderList(app);
    return renderOne(app, sub);
  };
})();
