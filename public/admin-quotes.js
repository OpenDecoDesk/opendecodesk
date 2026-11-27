// The Quotes page (admin.js loads this file on demand, the first time #quotes is opened: ensureQuotesPage_). A quote
// is a priced offer to one customer, in one shop (migrations/0109, table `estimates`): the list with its filters, and
// one quote's editor — its lines, fees and totals, Send, Convert to order and Cancel.
//
// In code a quote is an "estimate" (the word "quote" is already the signed shipping-rate quote, quoteToken.js), so
// every action and field here says estimate; only what a person reads says quote.
//
// A classic script like admin.js and admin-customers.js, so it uses admin.js's own helpers as they are (adminApi_,
// adminSetHash, adminTitle_, adminPageHead_, inventoryModal_, askConfirm_, adminCan_, adminMoney_, adminDate_,
// localToday_, adminLastShop_, customerSearchHtml_, wireCustomerSearch_, openOrderFromDashboard_) and storefront.js's
// (escapeHtml, showToast, productSizes_). A saved quote also carries the outside-digitizing section of
// admin-digitizing.js (digitizingSectionHtml_ / wireDigitizingSection_, used when that script is loaded). It adds one
// global, renderQuotes(app, id), which also carries
// renderQuotes.newForCustomer(customer) for the Customers page's "New quote for this customer".
//
// No data-admin-action here: the names those run are a fixed list at the top of admin.js. Each screen instead puts
// one listener on its own root element (as the Customers page does), which goes away with the screen.
(function () {
  "use strict";

  const FN = "quotes.estimates";
  const PAGE_SIZE = 50;
  const SEARCH_WAIT_MS = 250;      // typing pauses this long before a search is sent
  const MAX_LINES = 100;           // the server's limits (saveEstimate); checked here only to say so sooner
  const MAX_QTY = 5000;
  const DEFAULT_DAYS = 30;         // a new quote can be accepted for this many days unless the expiry is changed
  const STATUS = {
    draft: "Draft", sent: "Sent", changes: "Changes asked", accepted: "Accepted", converted: "Converted", cancelled: "Cancelled",
  };
  const FEE_KINDS = [["setup", "Setup fee"], ["digitizing", "Digitizing fee"], ["art", "Art fee"], ["other", "Other fee"]];
  const feeLabel = (k) => (FEE_KINDS.find(f => f[0] === k) || FEE_KINDS[3])[1];
  // What the list was showing, kept while the admin is open so coming back from a quote returns to the same view.
  const listView = { q: "", status: "", org: "", offset: 0 };

  function custLabel(c) { return (c && (c.name || c.company || c.email)) || (c && c.id != null ? "Customer " + c.id : "Customer"); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const shopName = (orgId) => { const o = (adminOrgs || []).find(x => x.orgId === orgId); return (o && o.name) || orgId || ""; };
  const manyShops = () => (adminOrgs || []).length > 1;
  // A screen that finished loading after the admin moved on must not draw over the page they went to.
  const stillOn = (hash, root) => _currentAdminHash === hash && (!root || root.isConnected);
  // A quote that can still be answered but whose last day has gone (the server decides; this is only the badge).
  const isExpired = (e) => !!(e && e.expiresOn && ["draft", "sent", "changes"].includes(e.status) && e.expiresOn < localToday_());
  function statusTag(e) {
    const st = STATUS[e.status] ? e.status : "draft";
    return `<span class="cust-tag qt-st qt-st-${st}">${escapeHtml(STATUS[st])}</span>${isExpired(e) ? ` <span class="cust-tag cust-tag-warn">Expired</span>` : ""}`;
  }
  // A whole number from a field, or NaN.
  const wholeNum = (v) => { const s = String(v == null ? "" : v).trim(); return /^\d+$/.test(s) ? Number(s) : NaN; };
  // An amount in dollars typed into a field: 0 or more, at most two decimals. NaN when it isn't one.
  const dollars = (v) => { const s = String(v == null ? "" : v).trim(); return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : NaN; };
  const canConvert = () => adminCan_(FN, "edit") && adminCan_("orders.details", "edit");
  const canOpenOrders = () => typeof openOrderFromDashboard_ === "function" && (typeof adminCanOpen_ !== "function" || adminCanOpen_("orders"));
  const canOpenCustomers = () => typeof adminCanCustomers_ !== "function" || adminCanCustomers_();

  // ---- What the shop sells and prices (Global settings → Decoration types) ------------------------------------
  // The stitch-count and screen-print helpers show only where that pricing is on; the picker for a configurable
  // product leaves out graphics whose decoration is switched off. Asked once per quote opened; a server without the
  // setting (or a role that can't read it) answers nothing, and the quote then has no helpers.
  let decoAsked = null;
  function decoSettings() {
    if (!decoAsked) {
      decoAsked = adminApi_({ action: "getDecorationSettings" })
        .then(d => ({ types: Array.isArray(d.types) ? d.types : [], pricing: d.pricing || {} }))
        .catch(() => null);
    }
    return decoAsked;
  }
  const stitchPricingOn = (s) => !!(s && s.types.includes("embroidery") && s.pricing && s.pricing.embroidery && s.pricing.embroidery.stitchPricing);
  const screenPrintOn = (s) => !!(s && s.types.includes("screenprint"));
  // The server's answer for one decoration's price: { unitCents, setupCents, note }.
  const priceDeco = (type, params) => adminApi_({ action: "priceDecoration", type, params });
  const centsToDollars = (c) => ((Number(c) || 0) / 100).toFixed(2);

  // A configurable line's picks as plain text: "Navy · Front: Lockup (White)". Mirrors admin.js cfgSummary_ (the
  // invisible reorder-QR application and auto-added entries are left out); "" when the line has no picks.
  function cfgText(it) {
    let c = it && it.config;
    if (!c && it && it.configJson) { try { c = JSON.parse(it.configJson); } catch (e) { c = null; } }
    if (!c || !Array.isArray(c.locations)) return "";
    const parts = c.locations.filter(l => !l.auto && !l.fixed && l.location !== "reorderqr")
      .map(l => `${l.label || l.location}: ${l.graphicName || (l.custom ? "Customer's own design" : "")}${l.ink ? " (" + l.ink + ")" : ""}`);
    return [c.garmentColor, ...parts].filter(Boolean).join(" · ");
  }
  // The shop's graphics and their add-on prices, asked once per shop while the admin stays on the Quotes pages.
  const graphicsByOrg = {};
  async function shopGraphics(orgId) {
    if (!graphicsByOrg[orgId]) {
      const g = await adminApi_({ action: "listGraphics", org: orgId });
      graphicsByOrg[orgId] = { graphics: g.graphics || [], tiersCents: g.tiersCents || {} };
    }
    return graphicsByOrg[orgId];
  }

  // ---- The list: #quotes ------------------------------------------------------------------------------------
  async function renderList(app) {
    const hash = "quotes";
    adminSetHash(hash);
    document.title = adminTitle_("Quotes");
    if (listView.org && !(adminOrgs || []).some(o => o.orgId === listView.org)) listView.org = "";
    app.innerHTML = `
      ${adminPageHead_("Quotes")}
      <div class="admin-panel cust-page qt-page" id="qtPage" style="--org-accent:var(--accent);">
        <div class="cust-bar">
          <label class="cust-field cust-search"><span>Search</span>
            <input type="search" id="qtQ" autocomplete="off" maxlength="200" placeholder="Quote number, title or customer" value="${escapeHtml(listView.q)}"></label>
          <label class="cust-field qt-filter"><span>Status</span>
            <select id="qtStatus">
              <option value="">Any status</option>
              ${Object.keys(STATUS).map(k => `<option value="${k}"${listView.status === k ? " selected" : ""}>${STATUS[k]}</option>`).join("")}
            </select></label>
          ${manyShops() ? `<label class="cust-field qt-filter"><span>Shop</span>
            <select id="qtShop">
              <option value="">All shops</option>
              ${(adminOrgs || []).map(o => `<option value="${escapeHtml(o.orgId)}"${listView.org === o.orgId ? " selected" : ""}>${escapeHtml(o.name || o.orgId)}</option>`).join("")}
            </select></label>` : ""}
          <button type="button" class="admin-btn" id="qtNew" data-need="${FN}:edit">+ New quote</button>
        </div>
        <div class="cust-count" id="qtCount" role="status" aria-live="polite"></div>
        <div id="qtBody"><div class="cust-note">Loading…</div></div>
        <div class="cust-pager" id="qtPager"></div>
      </div>`;
    const root = document.getElementById("qtPage");
    const body = root.querySelector("#qtBody"), count = root.querySelector("#qtCount"), pager = root.querySelector("#qtPager");
    let asked = 0, timer = null;
    const filtered = () => !!(listView.q || listView.status || listView.org);

    function draw(rows, total) {
      if (!rows.length) {
        count.textContent = ""; pager.innerHTML = "";
        body.innerHTML = `<div class="cust-note">${filtered() ? "No quote matches." : "No quotes yet. Start one with “+ New quote”, or from a customer's page."}</div>`;
        return;
      }
      const from = listView.offset + 1, to = listView.offset + rows.length;
      count.textContent = total > rows.length ? `Showing ${from}–${to} of ${plural(total, "quote")}` : plural(total, "quote");
      body.innerHTML = `<div class="admin-table-wrap"><table class="stack-mobile cust-table qt-table">
        <thead><tr><th>Quote</th><th>Customer</th><th>Title</th>${manyShops() ? "<th>Shop</th>" : ""}<th>Status</th><th class="cust-num">Total</th><th>Expires</th><th>Updated</th></tr></thead>
        <tbody>${rows.map(e => `<tr class="cust-row${e.status === "cancelled" ? " cust-row-archived" : ""}" data-qt-id="${escapeHtml(e.id)}">
          <td class="stack-title"><a class="cust-link" href="#quotes/${encodeURIComponent(e.id)}">${escapeHtml(e.number || "Quote " + e.id)}</a></td>
          <td>${escapeHtml(e.customerName || "")}</td>
          <td>${escapeHtml(e.title || "")}</td>
          ${manyShops() ? `<td>${escapeHtml(shopName(e.orgId))}</td>` : ""}
          <td>${statusTag(e)}</td>
          <td class="cust-num">${adminMoneyOr_(e.total)}</td>
          <td>${escapeHtml(e.expiresOn ? adminDate_(e.expiresOn) : "")}</td>
          <td>${escapeHtml(e.updatedAt ? adminDate_(e.updatedAt) : "")}</td>
        </tr>`).join("")}</tbody></table></div>`;
      pager.innerHTML = total > PAGE_SIZE || listView.offset > 0 ? `
        <button type="button" class="admin-btn admin-btn-secondary" data-qt-page="prev" ${listView.offset > 0 ? "" : "disabled"}>‹ Previous</button>
        <button type="button" class="admin-btn admin-btn-secondary" data-qt-page="next" ${to < total ? "" : "disabled"}>Next ›</button>` : "";
    }

    async function load() {
      const mine = ++asked;   // a slower, older answer must not replace a newer one
      try {
        const ask = { action: "listEstimates", q: listView.q, status: listView.status, limit: PAGE_SIZE, offset: listView.offset };
        if (listView.org) ask.org = listView.org;
        const d = await adminApi_(ask);
        if (mine !== asked || !stillOn(hash, root)) return;
        const rows = d.estimates || [], total = Number(d.total) || 0;
        // The page being asked for is gone (its last quote no longer matches): back to the first.
        if (!rows.length && listView.offset > 0) { listView.offset = 0; return load(); }
        draw(rows, total);
      } catch (e) {
        if (mine !== asked || !stillOn(hash, root)) return;
        count.textContent = ""; pager.innerHTML = "";
        body.innerHTML = `<div class="cust-err" role="alert">${escapeHtml(e.message)}</div>`;
      }
    }

    root.addEventListener("input", (e) => {
      if (e.target.id !== "qtQ") return;
      clearTimeout(timer);
      timer = setTimeout(() => { listView.q = e.target.value.trim(); listView.offset = 0; load(); }, SEARCH_WAIT_MS);
    });
    root.addEventListener("change", (e) => {
      if (e.target.id === "qtStatus") { listView.status = e.target.value; listView.offset = 0; load(); }
      else if (e.target.id === "qtShop") { listView.org = e.target.value; listView.offset = 0; load(); }
    });
    root.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (btn && btn.id === "qtNew") { showNewQuote(null); return; }
      if (btn && btn.dataset.qtPage) {
        listView.offset = Math.max(0, listView.offset + (btn.dataset.qtPage === "next" ? PAGE_SIZE : -PAGE_SIZE));
        load();
        return;
      }
      // Anywhere on a row opens the quote; the number is a real link, for the keyboard and "open in a new tab".
      const row = e.target.closest("tr[data-qt-id]");
      if (row && !e.target.closest("a, button, input, select")) location.hash = "#quotes/" + encodeURIComponent(row.dataset.qtId);
    });
    await load();
  }

  // "+ New quote" (and the Customers page's "New quote for this customer", which arrives with the customer picked):
  // who it is for, in which shop, and until when. The lines are added on the quote's own page, which opens once it is made.
  function showNewQuote(customer) {
    if (!adminCan_(FN, "edit")) { showToast("Your role can't make quotes.", true); return; }
    // The quote's customer is picked with the customer search, which is the Customers page's own permission (the
    // server asks for it too).
    if (typeof adminCanCustomers_ === "function" && !adminCanCustomers_()) { showToast("Your role can't pick a customer, so it can't start a quote. Ask an admin.", true); return; }
    const shops = adminOrgs || [];
    if (!shops.length) { showToast("Add a shop first — a quote is made in a shop.", true); return; }
    const last = adminLastShop_();
    const { ov, close } = inventoryModal_("New quote", `
      <form id="qtNewForm" class="cust-form" novalidate>
        <div class="qt-field-block">
          <label class="cust-field" for="qtNewCust"><span>Customer</span></label>
          <div id="qtNewFind">${customerSearchHtml_("qtNewCust", "width:100%;padding:7px 9px;border:1px solid #ccc;border-radius:4px;font-size:14px;box-sizing:border-box;margin-bottom:10px;")}</div>
          <div class="qt-picked" id="qtNewPicked" hidden>
            <span id="qtNewPickedText" role="status"></span>
            <button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" id="qtNewChange">Change</button>
          </div>
        </div>
        ${shops.length > 1 ? `<label class="cust-field"><span>Shop</span>
          <select id="qtNewShop">${shops.map(s => `<option value="${escapeHtml(s.orgId)}"${s.orgId === last ? " selected" : ""}>${escapeHtml(s.name || s.orgId)}</option>`).join("")}</select></label>` : ""}
        <div class="cust-grid">
          <label class="cust-field"><span>Title (optional)</span><input type="text" id="qtNewTitle" maxlength="200" autocomplete="off" placeholder="Team shirts"></label>
          <label class="cust-field"><span>Can be accepted until (blank = no end)</span><input type="date" id="qtNewExpires" value="${escapeHtml(localToday_(DEFAULT_DAYS))}"></label>
        </div>
        <div class="cust-err" id="qtNewErr" role="alert"></div>
        <div class="cust-dialog-actions">
          <button type="button" class="admin-btn admin-btn-secondary" id="qtNewCancel">Cancel</button>
          <button type="submit" class="admin-btn" id="qtNewSave">Create quote</button>
        </div>
      </form>`, 520, { guard: true });
    const err = ov.querySelector("#qtNewErr"), save = ov.querySelector("#qtNewSave");
    const find = ov.querySelector("#qtNewFind"), pickedBox = ov.querySelector("#qtNewPicked");
    let picked = null;
    const pick = (c) => {
      picked = c || null;
      find.hidden = !!picked; pickedBox.hidden = !picked;
      ov.querySelector("#qtNewPickedText").textContent = picked ? "For " + customerLine_(picked) : "";
      err.textContent = "";
    };
    const search = wireCustomerSearch_(ov, "qtNewCust", (c) => { pick(c); ov.querySelector("#qtNewTitle").focus(); });
    ov.querySelector("#qtNewChange").onclick = () => { pick(null); search.reset(); ov.querySelector("#qtNewCust").focus(); };
    // Cancel asks before throwing away what was typed, as ✕ and Escape do.
    ov.querySelector("#qtNewCancel").onclick = () => ov.querySelector("[data-modal-close]").click();
    if (customer) { pick(customer); ov.querySelector("#qtNewTitle").focus(); } else ov.querySelector("#qtNewCust").focus();
    ov.querySelector("#qtNewForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!picked) { err.textContent = "Search for the customer and pick them from the list first."; ov.querySelector("#qtNewCust").focus(); return; }
      const shopSel = ov.querySelector("#qtNewShop");
      const org = shopSel ? shopSel.value : shops[0].orgId;
      const expiresOn = ov.querySelector("#qtNewExpires").value || null;
      if (expiresOn && expiresOn < localToday_()) { err.textContent = "The last day to accept can't be in the past."; ov.querySelector("#qtNewExpires").focus(); return; }
      save.disabled = true; err.textContent = "";
      try {
        const d = await adminApi_({ action: "createEstimate", org, customerId: Number(picked.id), title: ov.querySelector("#qtNewTitle").value.trim(), expiresOn });
        close();
        adminNoteShop_(org);
        showToast("Quote " + (d.number || "") + " started.");
        location.hash = "#quotes/" + encodeURIComponent(d.id);
      } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    });
  }

  // ---- One quote: #quotes/<id> ------------------------------------------------------------------------------
  function backLink() { return `<a class="backlink" href="#quotes">‹ Quotes</a>`; }

  // A line of the server's answer as saveEstimate takes it back. Product lines keep a price staff typed (customPrice)
  // and are otherwise priced again by the server; custom and fee lines carry their own price.
  function toRequest(it) {
    if (it.kind === "fee") return { kind: "fee", feeKind: it.feeKind || "other", name: it.name || "", amount: Number(it.unitPrice) || 0, taxable: !!Number(it.taxable) };
    if (it.kind === "custom") return { kind: "custom", name: it.name || "", qty: Number(it.qty) || 1, unitPrice: Number(it.unitPrice) || 0, taxable: !!Number(it.taxable) };
    let config = it.config || null;
    if (!config && it.configJson) { try { config = JSON.parse(it.configJson); } catch (e) { config = null; } }
    const r = { kind: "product", productId: it.productId, size: it.size || "OSFA", qty: Number(it.qty) || 1, personalized: !!Number(it.personalized), persName: it.persName || "" };
    if (config) r.config = config;
    if (Number(it.customPrice)) r.customUnitPrice = Number(it.unitPrice) || 0;
    return r;
  }

  async function renderOne(app, id) {
    const hash = "quotes/" + id;
    adminSetHash(hash);
    document.title = adminTitle_("Quote");
    decoAsked = null;   // the settings may have changed since the last quote was opened
    const crumbs = (label) => ({ crumbs: [{ label: "Quotes", hash: "quotes" }, { label }] });
    app.innerHTML = `${adminPageHead_("Quote", crumbs("Quote"))}
      <div class="admin-panel cust-page qt-page" id="qtPage" style="--org-accent:var(--accent);">${backLink()}<div class="cust-note">Loading…</div></div>`;
    let d;
    try { d = await adminApi_({ action: "getEstimate", id }); }
    catch (e) {
      if (!stillOn(hash)) return;
      document.getElementById("qtPage").innerHTML = `${backLink()}<div class="cust-err" role="alert">${escapeHtml(e.message)}</div>`;
      return;
    }
    if (!stillOn(hash) || !d || !d.estimate) return;
    drawOne(app, id, hash, crumbs, d);
  }

  function drawOne(app, id, hash, crumbs, d) {
    let state = d;                         // the server's latest answer: { estimate, items, customer, totals }
    let lines = (d.items || []).map(toRequest);
    let busy = false, headDirty = false;
    let codes = Array.isArray(d.estimate && d.estimate.discountCodes) ? d.estimate.discountCodes.map(String) : [];   // typed on the quote
    let codeRules = null;   // { multiple } from Global settings, asked when the box is first drawn (null = unknown)
    const e0 = d.estimate, cust = d.customer || { id: e0.customerId };
    const number = e0.number || "Quote " + e0.id;
    // Lines, title, note to the customer and expiry change while it's a draft or the customer asked for changes. Once
    // sent, only its internal note (saveEstimate without items): the server refuses the rest (db.js setEstimateFields),
    // so the customer accepts exactly what they were sent.
    const editable = ["draft", "changes"].includes(e0.status) && adminCan_(FN, "edit");
    const fieldsEditable = ["draft", "sent", "changes"].includes(e0.status) && adminCan_(FN, "edit");
    const noteOnly = fieldsEditable && !editable;
    const open = ["draft", "sent", "changes"].includes(e0.status);
    document.title = adminTitle_(number);
    const custLink = canOpenCustomers() && cust.id != null
      ? `<a class="cust-link" href="#customers/${encodeURIComponent(cust.id)}">${escapeHtml(custLabel(cust))}</a>` : escapeHtml(custLabel(cust));
    const sentLine = e0.sentAt ? `Sent ${escapeHtml(adminDate_(e0.sentAt))}${e0.sentTo ? " to " + escapeHtml(e0.sentTo) : ""}${Number(e0.sendCount) > 1 ? ` (${plural(Number(e0.sendCount), "time")})` : ""}`
      + (e0.viewedAt ? ` · Opened by the customer ${escapeHtml(adminDate_(e0.viewedAt))}` : "") : "";

    app.innerHTML = `${adminPageHead_(number, crumbs(number))}
      <div class="admin-panel cust-page qt-page" id="qtPage" style="--org-accent:var(--accent);">
        ${backLink()}
        <div class="cust-head">
          <div>
            <h2 class="cust-name">${escapeHtml(number)}${e0.title ? " · " + escapeHtml(e0.title) : ""} ${statusTag(e0)}</h2>
            <div class="cust-sub">For ${custLink}${manyShops() ? " · " + escapeHtml(shopName(e0.orgId)) : ""} · Started ${escapeHtml(adminDate_(e0.createdAt))}</div>
            ${sentLine ? `<div class="cust-sub">${sentLine}</div>` : ""}
          </div>
          <div class="cust-actions">
            ${open ? `<button type="button" class="admin-btn" id="qtSend" data-need="${FN}:edit">${e0.status === "sent" ? "Send again…" : "Send…"}</button>` : ""}
            ${(open || (e0.status === "accepted" && !e0.orderId)) && canConvert() ? `<button type="button" class="admin-btn admin-btn-secondary" id="qtConvert">Convert to order…</button>` : ""}
            ${open || (e0.status === "accepted" && !e0.orderId) ? `<button type="button" class="admin-btn admin-btn-secondary" id="qtCancel" data-need="${FN}:full">Cancel quote…</button>` : ""}
          </div>
        </div>

        ${e0.status === "changes" ? `<div class="qt-callout qt-callout-changes" role="note">
          <b>The customer asked for changes${e0.respondedAt ? " on " + escapeHtml(adminDate_(e0.respondedAt)) : ""}.</b>
          ${e0.customerNote ? `<div class="qt-quote-text">${escapeHtml(e0.customerNote)}</div>` : ""}
          <div>Change the quote, press Revise, then send it again.</div></div>` : ""}
        ${e0.status === "sent" ? `<div class="cust-note">This quote has been sent, so it is fixed as the customer has it: its lines, prices, title, note to the customer and expiry. Only the internal note can change. The rest can change again if the customer asks for changes.</div>` : ""}
        ${e0.orderId ? `<div class="qt-callout" role="note">${e0.status === "converted" ? "Converted to order" : "Order"} ${canOpenOrders()
          ? `<a class="cust-link" href="#orders/${encodeURIComponent(e0.orgId)}" id="qtOrderLink">${escapeHtml(e0.orderId)}</a>` : `<b>${escapeHtml(e0.orderId)}</b>`}${e0.convertedAt ? " on " + escapeHtml(adminDate_(e0.convertedAt)) : ""}.</div>` : ""}
        ${e0.status === "accepted" && !e0.orderId ? `<div class="qt-callout qt-callout-changes" role="note">The customer accepted this quote${e0.acceptedAt ? " on " + escapeHtml(adminDate_(e0.acceptedAt)) : ""}, but its order wasn't made. Use Convert to order.</div>` : ""}
        ${e0.status === "cancelled" ? `<div class="cust-note">Cancelled${e0.cancelledAt ? " on " + escapeHtml(adminDate_(e0.cancelledAt)) : ""}. The customer's link no longer accepts it.</div>` : ""}

        <form id="qtForm" class="cust-form qt-form" novalidate>
          <div class="cust-grid">
            <label class="cust-field"><span>Title</span><input type="text" id="qtTitle" maxlength="200" autocomplete="off" value="${escapeHtml(e0.title || "")}"></label>
            <label class="cust-field"><span>Can be accepted until (blank = no end)</span><input type="date" id="qtExpires" value="${escapeHtml(e0.expiresOn || "")}"></label>
          </div>
          <label class="cust-field"><span>Note to the customer (shown on the quote)</span><textarea id="qtMessage" rows="3" maxlength="3000">${escapeHtml(e0.message || "")}</textarea></label>
          <label class="cust-field"><span>Internal note (staff only)</span><textarea id="qtInternal" rows="2" maxlength="2000">${escapeHtml(e0.internalNote || "")}</textarea></label>

          <h3 class="cust-h">Lines</h3>
          <div id="qtLines"></div>
          ${editable ? `<div class="qt-add">
            <button type="button" class="admin-btn admin-btn-secondary" id="qtAddProduct">+ Product</button>
            <button type="button" class="admin-btn admin-btn-secondary" id="qtAddCustom">+ Custom line</button>
            <button type="button" class="admin-btn admin-btn-secondary" id="qtAddFee">+ Fee</button>
          </div>` : ""}
          <div id="qtCodes" class="qt-codes"></div>
          <div id="qtTotals" class="qt-totals" aria-live="polite"></div>

          <div class="cust-err" id="qtErr" role="alert"></div>
          ${fieldsEditable ? `<div class="cust-form-actions"><button type="submit" class="admin-btn" id="qtSave">${e0.status === "changes" ? "Revise" : "Save"}</button>
            <span class="cust-count" id="qtSaved" role="status"></span></div>` : ""}
        </form>
        <div id="qtDigitizing"></div>
      </div>`;

    const root = document.getElementById("qtPage");
    const form = root.querySelector("#qtForm"), errEl = root.querySelector("#qtErr");
    if (!fieldsEditable) form.querySelectorAll("input, textarea, select").forEach(f => { f.disabled = true; });
    else if (noteOnly) ["#qtTitle", "#qtExpires", "#qtMessage"].forEach(sel => { root.querySelector(sel).disabled = true; });
    const reload = () => { if (stillOn(hash)) renderOne(app, id); };
    // The price helpers' settings are asked for as the quote opens, so a line's window doesn't wait for them.
    if (editable) decoSettings();
    // Digitizing sent to an outside vendor for this quote's digitizing fee: under the fee lines, for any saved quote,
    // to a role that may see it (its own permission; admin-digitizing.js).
    if (typeof ensureDigitizingUi_ === "function" && adminCan_("production.digitizing", "read")) {
      ensureDigitizingUi_().then(() => {
        if (!stillOn(hash)) return;
        const dg = root.querySelector("#qtDigitizing");
        if (!dg || !dg.isConnected) return;
        const dctx = { estimateId: e0.id, canEdit: adminCan_("production.digitizing", "edit"), canExpense: adminCan_("finance.expenses", "edit") };
        dg.innerHTML = digitizingSectionHtml_(dctx);
        wireDigitizingSection_(dg, dctx);
      }).catch(() => {});
    }

    function lineRow(it, i) {
      const qtyCell = it.kind === "fee" ? "1" : editable
        ? `<input type="number" class="qt-qty" data-qt-qty="${i}" min="1" max="${MAX_QTY}" step="1" value="${escapeHtml(it.qty)}" aria-label="Quantity of ${escapeHtml(it.name || "this line")}">`
        : escapeHtml(it.qty);
      const unit = Number(it.unitPrice) || 0, list = it.listUnitPrice != null ? Number(it.listUnitPrice) : unit;
      const off = it.kind === "product" && !Number(it.customPrice) && list > unit ? list - unit : 0;
      const what = it.kind === "fee" ? feeLabel(it.feeKind) + (it.name && it.name !== feeLabel(it.feeKind) ? " — " + it.name : "") : it.name || "";
      const sub = [
        it.kind === "product" && it.size && it.size !== "OSFA" ? "Size " + it.size : "",
        it.kind === "product" ? cfgText(it) : "",
        Number(it.personalized) ? "Personalized" + (it.persName ? ": " + it.persName : "") + (Number(it.personalizationFee) > 0 ? " (+" + adminMoney_(it.personalizationFee) + " each)" : "") : "",
        it.kind === "product" && Number(it.customPrice) ? "Price set by hand" : "",
        it.kind === "custom" ? "Custom line" : "",
        it.kind !== "product" && !Number(it.taxable) ? "Not taxed" : "",
      ].filter(Boolean).join(" · ");
      return `<tr>
        <td class="stack-title">${escapeHtml(what)}${sub ? `<div class="qt-line-sub">${escapeHtml(sub)}</div>` : ""}</td>
        <td class="cust-num">${qtyCell}</td>
        <td class="cust-num">${it.kind === "product" ? adminMoney_(list) : ""}</td>
        <td class="cust-num">${off > 0 ? "−" + adminMoney_(off) : ""}</td>
        <td class="cust-num">${adminMoney_(unit)}</td>
        <td class="cust-num">${adminMoneyOr_(it.lineTotal)}</td>
        ${editable ? `<td class="qt-line-acts">
          <button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" data-qt-edit="${i}" aria-label="Change ${escapeHtml(what)}">Change</button>
          <button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" data-qt-remove="${i}" aria-label="Remove ${escapeHtml(what)}">Remove</button></td>` : ""}
      </tr>`;
    }
    function paintLines() {
      const items = state.items || [];
      root.querySelector("#qtLines").innerHTML = items.length ? `<div class="admin-table-wrap"><table class="stack-mobile cust-table qt-lines">
        <thead><tr><th>Item</th><th class="cust-num">Qty</th><th class="cust-num">List</th><th class="cust-num">Quantity price</th><th class="cust-num">Unit</th><th class="cust-num">Total</th>${editable ? "<th><span class=\"qt-sr\">Change or remove</span></th>" : ""}</tr></thead>
        <tbody>${items.map(lineRow).join("")}</tbody></table></div>`
        : `<div class="cust-note">${editable ? "No lines yet. Add a product, a custom line or a fee." : "No lines."}</div>`;
      const t = state.totals || {};
      const inclusive = t.taxMode !== "exclusive";
      // What the discount codes took off the goods (each code's share when the server says it) and free shipping.
      const num = (v) => Number(v) > 0 ? Number(v) : 0;
      // getEstimate's totals.discountCodes [{code, discount, freeShipping, label}]: each code's share of the goods off.
      const share = (x) => num(x.discount != null ? x.discount : x.amount != null ? x.amount : x.goodsOff);
      const per = (Array.isArray(t.discountCodes) ? t.discountCodes : Array.isArray(t.discounts) ? t.discounts : Array.isArray(t.perCode) ? t.perCode : []).filter(x => x && share(x) > 0);
      const discount = num(t.discount != null ? t.discount : t.discountAmount) || per.reduce((a, x) => a + share(x), 0);
      const shipOff = num(t.shippingOff != null ? t.shippingOff : t.shippingDiscount);
      const discRows = (per.length > 1 ? per.map(x => `<tr class="qt-sum-disc"><th>Discount (${escapeHtml(x.code || "")})</th><td>−${adminMoney_(share(x))}</td></tr>`).join("")
        : discount > 0 ? `<tr class="qt-sum-disc"><th>Discount${codes.length ? " (" + escapeHtml(codes.join(", ")) + ")" : ""}</th><td>−${adminMoney_(discount)}</td></tr>` : "")
        + (shipOff > 0 ? `<tr class="qt-sum-disc"><th>Free shipping</th><td>−${adminMoney_(shipOff)}</td></tr>` : "");
      root.querySelector("#qtTotals").innerHTML = items.length ? `<table class="qt-sum">
        ${inclusive && !discRows ? "" : `<tr><th>Subtotal</th><td>${adminMoneyOr_(t.subtotal)}</td></tr>`}${discRows}${inclusive ? "" : `<tr><th>Sales tax</th><td>${adminMoneyOr_(t.tax)}</td></tr>`}
        <tr class="qt-sum-total"><th>Total</th><td>${adminMoneyOr_(t.total)}</td></tr>
        ${inclusive && Number(t.tax) > 0 ? `<tr><th>Includes sales tax</th><td>${adminMoneyOr_(t.tax)}</td></tr>` : ""}
      </table>${state.estimate && state.estimate.status === "draft" ? `<div class="cust-note">Prices follow the catalog until the quote is sent; from then on they are fixed.</div>` : ""}` : "";
    }
    // The Discount codes box under the lines: the codes on this quote (each with a ×) and a field to add one. A code is
    // checked the way the Local sale window checks one — against this quote's goods, its shop and its customer's email
    // (checkLocalSaleCode, with the codes already on it so one-code shops refuse a second) — and then saved with the
    // quote (saveEstimate discountCodes). The server checks them all again when the quote is sent and when it is
    // converted, so this is only to say sooner.
    const codesOn = () => (typeof adminFeatureOn_ !== "function" || adminFeatureOn_("discounts")) && (editable || codes.length > 0);
    function paintCodes() {
      const box = root.querySelector("#qtCodes");
      if (!box) return;
      if (!codesOn()) { box.innerHTML = ""; return; }
      const multiple = !!(codeRules && codeRules.multiple);
      const canAdd = editable && (multiple || !codes.length) && codes.length < 5;
      const keep = box.querySelector("#qtCodeMsg") ? box.querySelector("#qtCodeMsg").textContent : "";
      box.innerHTML = `<h3 class="cust-h">Discount codes</h3>
        ${codes.length ? `<ul class="qt-code-list">${codes.map((c, i) => `<li><span class="cust-tag">${escapeHtml(c)}</span>${editable
          ? ` <button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" data-qt-code-remove="${i}" aria-label="Take off code ${escapeHtml(c)}">×</button>` : ""}</li>`).join("")}</ul>` : `<div class="cust-note">No discount code on this quote.</div>`}
        ${canAdd ? `<div class="qt-code-add"><div class="cust-field"><label for="qtCode">${codes.length ? "Add another code" : "Discount code"}</label>
          <input type="text" id="qtCode" maxlength="64" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
          <button type="button" class="admin-btn admin-btn-secondary" id="qtCodeAdd">Apply</button></div>`
          : editable && codes.length && !multiple ? `<div class="cust-note">Only one discount code can be used at a time (Global settings → Discount codes). Take this one off to use another.</div>` : ""}
        <div class="cust-note" id="qtCodeMsg" role="status">${escapeHtml(keep)}</div>`;
    }
    async function codeRule() {
      // Readable with Quotes (permissions.js lets the screens with a code box read it), not only with Global settings.
      try { const r = await adminApi_({ action: "getDiscountRules" }); const v = r && (r.discountRules || r.rules || r); codeRules = { multiple: !!(v && v.multiple) }; }
      catch (ex) { codeRules = null; }
      if (stillOn(hash, root)) paintCodes();
    }
    // Saves the codes (and nothing else): the quote's lines are sent too, so the server prices them with the codes on.
    async function saveCodes(next) {
      const problem = await persist(lines, { discountCodes: next });   // (only an editable quote has a code box to change)
      if (!problem) codes = Array.isArray(state.estimate && state.estimate.discountCodes) ? state.estimate.discountCodes.map(String) : next;
      paintCodes(); paintLines();
      return problem;
    }
    async function addCode() {
      const input = root.querySelector("#qtCode"), msg = root.querySelector("#qtCodeMsg"), btn = root.querySelector("#qtCodeAdd");
      if (!input || !msg) return;
      const typed = input.value.trim().toUpperCase();
      msg.textContent = "";
      if (!typed) { msg.textContent = "Enter a code first."; input.focus(); return; }
      if (codes.includes(typed)) { msg.textContent = "That code is already on this quote."; return; }
      if (!(state.items || []).some(it => it.kind !== "fee")) { msg.textContent = "Add the items first."; return; }
      if (headDirty && fieldsEditable) { const bad = await persist(lines); if (bad) { msg.textContent = bad; return; } }
      const goods = (state.items || []).filter(it => it.kind !== "fee").reduce((a, it) => a + (Number(it.lineTotal) || 0), 0);
      if (btn) btn.disabled = true;
      try {
        const r = await adminApi_({ action: "checkLocalSaleCode", org: state.estimate.orgId, code: typed, subtotal: Math.round(goods * 100) / 100, others: codes,
          ...(cust && cust.email ? { contact: cust.email } : {}), ...(cust && cust.id != null ? { customerId: cust.id } : {}) });
        if (!r || !r.ok) { msg.textContent = (r && r.reason) || "This code isn't valid."; return; }
        const real = (r.code && r.code.code) || typed;
        const problem = await saveCodes(codes.concat([String(real).toUpperCase()]));
        const again = root.querySelector("#qtCodeMsg");
        if (again) again.textContent = problem || "";
        if (!problem) showToast("Code " + real + " added.");
      } catch (ex) { msg.textContent = (ex && ex.message) || "Couldn't check the code."; }
      finally { const b = root.querySelector("#qtCodeAdd"); if (b) b.disabled = false; }
    }
    paintLines();
    paintCodes();
    if (editable) codeRule();

    const headFields = () => {
      const v = (fid) => root.querySelector("#" + fid).value;
      // A sent quote saves its internal note alone: the other fields are fixed.
      if (noteOnly) return { internalNote: v("qtInternal").trim() };
      return { title: v("qtTitle").trim(), message: v("qtMessage").trim(), internalNote: v("qtInternal").trim(), expiresOn: v("qtExpires") || null };
    };
    // Saves the quote with `next` as its lines (and what is typed above them), and draws the server's answer: it is
    // the server that prices the lines (quantity breaks across the whole quote, tax). `next` undefined saves the fields
    // alone (a sent quote). Answers "" or the problem.
    const STILL_SAVING = "Still saving — try again in a moment.";
    async function persist(next, extra) {
      if (busy) return STILL_SAVING;
      const head = headFields();
      if (head.expiresOn && head.expiresOn < localToday_() && head.expiresOn !== (state.estimate.expiresOn || null)) return "The last day to accept can't be in the past.";
      busy = true; errEl.textContent = "";
      try {
        const a = await adminApi_(Object.assign({ action: "saveEstimate", id }, head, next === undefined ? {} : { items: next }, extra || {}));
        if (!stillOn(hash, root)) return "";
        if (a && a.estimate) state = a;
        lines = (state.items || []).map(toRequest);
        headDirty = false;
        paintLines();
        const saved = root.querySelector("#qtSaved");
        if (saved) saved.textContent = "Saved.";
        return "";
      } catch (ex) {
        return ex.message || "Couldn't save the quote.";
      } finally {
        busy = false;
        // A change refused while this save ran said to try again: now it can be, so that no longer stands.
        if (errEl.textContent === STILL_SAVING) errEl.textContent = "";
      }
    }

    form.addEventListener("input", (e) => {
      if (e.target.closest("#qtLines, #qtCodes")) return;
      headDirty = true;
      const saved = root.querySelector("#qtSaved"); if (saved) saved.textContent = "";
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!fieldsEditable) return;
      const btn = root.querySelector("#qtSave");
      btn.disabled = true;
      const problem = await persist(editable ? lines : undefined);
      btn.disabled = false;
      if (problem) { errEl.textContent = problem; return; }
      showToast(e0.status === "changes" ? "Quote revised. Send it again when it's ready." : "Quote saved.");
    });
    // A quantity typed into a line is saved when the field is left (or Enter), so the line's price is the server's.
    form.addEventListener("change", async (e) => {
      const q = e.target.closest("input[data-qt-qty]");
      if (!q) return;
      const i = Number(q.dataset.qtQty), n = wholeNum(q.value);
      if (!(n >= 1 && n <= MAX_QTY)) { errEl.textContent = `A quantity is a whole number from 1 to ${MAX_QTY.toLocaleString("en-US")}.`; q.focus(); return; }
      if (!lines[i] || Number(lines[i].qty) === n) return;
      const next = lines.map((l, j) => j === i ? Object.assign({}, l, { qty: n }) : l);
      const problem = await persist(next);
      if (problem) { errEl.textContent = problem; return; }
      const again = root.querySelector(`input[data-qt-qty="${i}"]`); if (again) again.focus();
    });
    form.addEventListener("keydown", (e) => {
      // Enter in a quantity saves that quantity, not the whole form (the change event above does it).
      if (e.key === "Enter" && e.target.matches("input[data-qt-qty]")) { e.preventDefault(); e.target.blur(); }
      // Enter in the code field applies the code, not the whole form.
      if (e.key === "Enter" && e.target.id === "qtCode") { e.preventDefault(); addCode(); }
    });

    root.addEventListener("click", async (e) => {
      const orderLink = e.target.closest("#qtOrderLink");
      if (orderLink) {
        e.preventDefault();
        openOrderFromDashboard_(state.estimate.orgId, state.estimate.orderId, state.estimate.convertedAt);
        return;
      }
      const btn = e.target.closest("button");
      if (!btn) return;
      const at = (name) => btn.dataset[name] != null ? Number(btn.dataset[name]) : null;
      if (at("qtRemove") != null) {
        const i = at("qtRemove");
        const problem = await persist(lines.filter((_, j) => j !== i));
        if (problem) { errEl.textContent = problem; return; }
        const add = root.querySelector("#qtAddProduct"); if (add) add.focus();
        return;
      }
      const lineDialog = (kind, i) => {
        const item = i == null ? null : (state.items || [])[i];
        // `extra`: lines a helper in the window adds beside this one (the screen print setup fee).
        const done = async (line, extra) => {
          const more = extra || [];
          const next = (i == null ? lines.concat([line]) : lines.map((l, j) => j === i ? line : l)).concat(more);
          if (next.length > MAX_LINES) return `A quote can have at most ${MAX_LINES} lines.`;
          return persist(next);
        };
        if (kind === "product") return showProductLine(state.estimate.orgId, item, done);
        return showOtherLine(kind, item, done);
      };
      if (at("qtEdit") != null) { const it = (state.items || [])[at("qtEdit")]; if (it) lineDialog(it.kind, at("qtEdit")); return; }
      if (btn.id === "qtCodeAdd") { addCode(); return; }
      if (btn.dataset.qtCodeRemove != null) {
        const i = Number(btn.dataset.qtCodeRemove);
        const problem = await saveCodes(codes.filter((_, j) => j !== i));
        const m = root.querySelector("#qtCodeMsg"); if (m) m.textContent = problem || "";
        return;
      }
      if (btn.id === "qtAddProduct") { lineDialog("product", null); return; }
      if (btn.id === "qtAddCustom") { lineDialog("custom", null); return; }
      if (btn.id === "qtAddFee") { lineDialog("fee", null); return; }
      if (btn.id === "qtSend") {
        if (!(state.items || []).length) { errEl.textContent = "Add at least one line before sending the quote."; return; }
        // What is typed above the lines goes with it: saved first, so the customer sees what is on the screen.
        if (headDirty && fieldsEditable) { const problem = await persist(editable ? lines : undefined); if (problem) { errEl.textContent = problem; return; } }
        showSend(state, reload);
        return;
      }
      if (btn.id === "qtConvert") {
        if (headDirty && fieldsEditable) { const problem = await persist(editable ? lines : undefined); if (problem) { errEl.textContent = problem; return; } }
        showConvert(state, reload);
        return;
      }
      if (btn.id === "qtCancel") {
        if (!await askConfirm_(`Cancel quote ${number}?\n\nThe customer can no longer accept it, and it can't be sent again. This can't be undone.`)) return;
        try {
          await adminApi_({ action: "cancelEstimate", id });
          showToast("Quote " + number + " cancelled.");
          reload();
        } catch (ex) { showToast(ex.message, true); }
      }
    });
  }

  // The price helpers under a line's price (product line and custom line alike): "By stitches" (embroidery priced by
  // its stitch count) and "Screen print price" (colors, locations, reorder), each where the shop has that pricing on.
  // The server works the price out (priceDecoration: the shop's own settings); this only asks and fills the field.
  //   box        an empty element in the window the helpers are drawn into (it stays hidden when neither is on)
  //   o.getPrice()   the price per piece now, in dollars (NaN when there isn't one yet)
  //   o.setPrice(d)  puts a price in dollars into the line's field
  //   o.catalog()    the product's catalog price in dollars, or null on a custom line
  //   o.stitches()   Promise of the product's design's latest stitch count, or null
  // Returns { extra(), prefill() }: extra() is the fee lines to save with the line (the screen print setup), prefill()
  // asks again for the stitch count to start from (after the product changed).
  function decoTools(box, deco, o) {
    const none = { extra: () => [], prefill: () => {} };
    const stitchOn = stitchPricingOn(deco), screenOn = screenPrintOn(deco);
    if (!box || (!stitchOn && !screenOn)) return none;
    const maxColors = Math.max(1, Math.min(12, Number(deco.pricing.screenprint && deco.pricing.screenprint.maxColors) || 6));
    box.hidden = false;
    box.innerHTML = `<div class="qt-deco">
      <div class="qt-deco-buttons" style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 6px;">
        ${stitchOn ? `<button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" data-qt-deco="stitch" aria-expanded="false">By stitches</button>` : ""}
        ${screenOn ? `<button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" data-qt-deco="screen" aria-expanded="false">Screen print price</button>` : ""}
      </div>
      ${stitchOn ? `<div class="qt-deco-pane" data-qt-pane="stitch" style="margin:6px 0;" hidden>
        <label class="cust-field"><span>Stitches</span><input type="number" min="1" step="1" inputmode="numeric" data-qt-f="stitches" placeholder="8500"></label>
        ${o.catalog ? `<label class="cust-check"><input type="checkbox" data-qt-f="addCatalog" checked> <span>Add the product's catalog price</span></label>` : ""}
        <button type="button" class="admin-btn admin-btn-sm" data-qt-go="stitch">Work out the price</button>
      </div>` : ""}
      ${screenOn ? `<div class="qt-deco-pane" data-qt-pane="screen" style="margin:6px 0;" hidden>
        <div class="cust-grid">
          <label class="cust-field"><span>Colors</span><select data-qt-f="colors">${Array.from({ length: maxColors }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}</select></label>
          <label class="cust-field"><span>Locations</span><input type="number" min="1" max="10" step="1" value="1" data-qt-f="locations"></label>
        </div>
        <label class="cust-check"><input type="checkbox" data-qt-f="reorder"> <span>A reorder (the screens already exist)</span></label>
        <button type="button" class="admin-btn admin-btn-sm" data-qt-go="screen">Add to the price</button>
      </div>` : ""}
      <div class="qt-muted" data-qt-note role="status" aria-live="polite" style="font-size:13px;margin-bottom:8px;"></div>
    </div>`;
    const $ = (s) => box.querySelector(s);
    const f = (name) => box.querySelector(`[data-qt-f="${name}"]`);
    const note = (t, bad) => { const n = $("[data-qt-note]"); n.textContent = t; n.style.color = bad ? "#b03a2e" : ""; };
    let setup = null;          // { cents, name } the screen print helper adds as a fee line
    let spCents = 0;           // what the screen print helper put in the price, so pressing it again replaces it
    let touched = false;       // a stitch count typed by hand is not overwritten by the design's
    if (f("stitches")) f("stitches").addEventListener("input", () => { touched = true; });
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.qtDeco) {
        const pane = $(`[data-qt-pane="${b.dataset.qtDeco}"]`);
        pane.hidden = !pane.hidden;
        b.setAttribute("aria-expanded", String(!pane.hidden));
        if (!pane.hidden) { const first = pane.querySelector("input, select"); if (first) first.focus(); }
        return;
      }
      if (b.dataset.qtGo === "stitch") {
        const n = wholeNum(f("stitches").value);
        if (!(n >= 1)) { note("Enter the number of stitches (a whole number, like 8500).", true); f("stitches").focus(); return; }
        b.disabled = true; note("");
        try {
          const d = await priceDeco("embroidery", { stitches: n });
          if (!box.isConnected) return;
          if (!(Number(d.unitCents) > 0)) { note((d.note || "No price worked out.") + " Set the stitch price under Global settings → Decoration types.", true); return; }
          const add = f("addCatalog") && f("addCatalog").checked && o.catalog ? Math.round((Number(o.catalog()) || 0) * 100) : 0;
          o.setPrice(centsToDollars(Number(d.unitCents) + add));
          spCents = 0;
          note(`${d.note || "Embroidery"}: ${adminMoney_(Number(d.unitCents) / 100)}${add ? " + catalog price " + adminMoney_(add / 100) : ""} each.`);
        } catch (ex) { note(ex.message || "Couldn't work out the price.", true); }
        finally { b.disabled = false; }
        return;
      }
      if (b.dataset.qtGo === "screen") {
        const colors = Number(f("colors").value), locs = wholeNum(f("locations").value), reorder = f("reorder").checked;
        if (!(locs >= 1 && locs <= 10)) { note("Enter how many locations (1 to 10).", true); f("locations").focus(); return; }
        b.disabled = true; note("");
        try {
          const d = await priceDeco("screenprint", { colors, locations: locs, reorder });
          if (!box.isConnected) return;
          const unit = Number(d.unitCents) || 0, set = Number(d.setupCents) || 0;
          const was = o.getPrice();
          const base = (isNaN(was) ? 0 : Math.round(was * 100)) - spCents;
          o.setPrice(centsToDollars(Math.max(0, base) + unit));
          spCents = unit;
          setup = set > 0 ? { cents: set, name: `Screen setup — ${plural(colors, "color")}${locs > 1 ? ", " + plural(locs, "location") : ""}${reorder ? " (reorder)" : ""}` } : null;
          note(`Screen print adds ${adminMoney_(unit / 100)} to each piece${setup ? `; a ${adminMoney_(set / 100)} screen setup fee is added as its own line when you save` : ""}.`);
        } catch (ex) { note(ex.message || "Couldn't work out the price.", true); }
        finally { b.disabled = false; }
      }
    });
    // Enter in a helper's field works the helper out; it must not save the whole line.
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !e.target.matches("input, select")) return;
      e.preventDefault();
      const pane = e.target.closest("[data-qt-pane]");
      const go = pane && pane.querySelector("[data-qt-go]");
      if (go) go.click();
    });
    return {
      extra: () => setup ? [{ kind: "fee", feeKind: "setup", name: setup.name, amount: setup.cents / 100, taxable: true }] : [],
      prefill: async () => {
        if (!f("stitches") || touched || !o.stitches) return;
        let n = null;
        try { n = await o.stitches(); } catch (ex) { n = null; }
        if (n && box.isConnected && !touched) f("stitches").value = String(n);
      },
    };
  }
  // The latest stitch count of a design (a design's newest version that has one), or null.
  const designStitchCache = {};
  async function designStitches(designId) {
    if (designId == null) return null;
    if (!(designId in designStitchCache)) {
      try {
        const d = await adminApi_({ action: "getDesign", id: designId });
        const v = (d.versions || []).find(x => Number(x.stitchCount) > 0);
        designStitchCache[designId] = v ? Number(v.stitchCount) : null;
      } catch (ex) { designStitchCache[designId] = null; }
    }
    return designStitchCache[designId];
  }

  // Add or change a catalog line: the shop's products, size, quantity and personalization, and for a product with
  // choices (a garment color and a graphic at each location) the same picks as a Local sale; a price typed by hand
  // for a role that may set one (as on a Local sale), or worked out by stitch count / screen print. The price shown
  // here is the catalog's; the server works out the quantity break over the whole quote once the line is saved.
  // done(line, extraLines) saves; it answers "" or the problem to show.
  const productsByOrg = {};
  async function showProductLine(orgId, item, done) {
    let products = productsByOrg[orgId];
    if (!products) {
      try { products = (await adminApi_({ action: "listProducts", org: orgId })).products || []; }
      catch (ex) { showToast("Couldn't load the shop's products: " + ex.message, true); return; }
      productsByOrg[orgId] = products;
    }
    // A product with choices needs the shop's graphics (and their add-on prices) to pick from.
    let gData = { graphics: [], tiersCents: {} }, gFailed = false;
    if (products.some(p => p.configurable)) {
      try { gData = await shopGraphics(orgId); }
      catch (ex) { gFailed = true; showToast("Couldn't load the shop's graphics: " + (ex.message || "unknown error") + " Products with choices can't be quoted until they load.", true); }
    }
    const deco = await decoSettings();
    const usable = products.filter(p => !(p.configurable && gFailed));
    if (!usable.length) { showToast("This shop has no products to quote. Add a custom line instead.", true); return; }
    const isSized = (p) => !!p && p.pricingMode !== "flat" && p.sizePricing && Object.keys(p.sizePricing).length > 0;
    const sizes = (p) => typeof productSizes_ === "function" ? productSizes_(p.sizePricing) : Object.keys(p.sizePricing || {});
    const canPrice = adminCan_("orders.payments", "edit");
    const was = item ? toRequest(item) : null;
    // ---- The shop page's choices, as the Local sale draws them (admin.js drawCfg / cfgConfig_ / catalogUnit_ / basePrice_) ----
    const gById = {}; (gData.graphics || []).forEach(g => { gById[g.id] = g; });
    const addOnCents = (g) => (g && g.tier ? Number((gData.tiersCents || {})[g.tier]) || 0 : 0);
    const isCfg = (p) => !!(p && p.configurable);
    // A graphic stays pickable when its decoration was switched off since, only if this line already has it.
    const wasPicks = new Set(((was && was.config && was.config.locations) || []).map(l => Number(l.graphicId)).filter(Boolean));
    const decoOff = (g) => !!(deco && g.decoration && !deco.types.includes(g.decoration) && !wasPicks.has(Number(g.id)));
    const cfgOpts = (p, loc, color) => (loc.graphicIds || []).map(id => gById[id]).filter(Boolean)
      .filter(g => g.visible !== false && !decoOff(g))
      .filter(g => !(g.allowedLocations && g.allowedLocations.length) || g.allowedLocations.includes(loc.key))
      .filter(g => !(g.allowedGarmentColors && g.allowedGarmentColors.length) || !color || g.allowedGarmentColors.includes(color))
      .filter(g => !(color && (p.blockedGraphicColors || []).some(b => Number(b.graphicId) === Number(g.id) && b.color === color)));
    // The price before add-ons: the color's price group, else the product's own.
    const basePrice = (p, color, size) => {
      const grp = color ? (p.colorGroups || []).find(x => (x.colors || []).includes(color)) : null;
      if (isSized(p)) { const v = grp && grp.sizePricing ? grp.sizePricing[size] : undefined; return typeof v === "number" ? v : Number((p.sizePricing || {})[size] || 0); }
      return grp && typeof grp.flatPrice === "number" ? grp.flatPrice : Number(p.flatPrice || 0);
    };
    const customPrice = (p, loc) => loc && loc.customDesignPriceCents != null && loc.customDesignPriceCents !== "" && Number.isFinite(Number(loc.customDesignPriceCents))
      ? Number(loc.customDesignPriceCents) / 100 : Number(p.customDesignPrice) || 0;
    const plus = (v) => v > 0 ? ` (+${adminMoney_(v)})` : "";

    const { ov, close } = inventoryModal_(item ? "Change product line" : "Add a product", `
      <form id="qtProdForm" class="cust-form" novalidate>
        <label class="cust-field"><span>Product</span>
          <select id="qtProd">${usable.map(p => `<option value="${escapeHtml(p.productId)}"${was && was.productId === p.productId ? " selected" : ""}>${escapeHtml(p.name)}${p.versionGroup && p.versionLabel ? " — " + escapeHtml(p.versionLabel) : ""}${p.visible === false || p.visible === 0 || p.visible === "N" ? " (hidden)" : ""}</option>`).join("")}</select></label>
        <div id="qtProdCfg" hidden>
          <label class="cust-field" id="qtProdColorWrap"><span>Garment color</span><select id="qtProdColor"></select></label>
          <div id="qtProdLocs"></div>
        </div>
        <div class="cust-grid">
          <label class="cust-field" id="qtProdSizeWrap"><span>Size</span><select id="qtProdSize"></select></label>
          <label class="cust-field"><span>Quantity</span><input type="number" id="qtProdQty" min="1" max="${MAX_QTY}" step="1" value="${escapeHtml(was ? was.qty : 1)}"></label>
        </div>
        <div id="qtProdPersWrap" hidden>
          <label class="cust-check"><input type="checkbox" id="qtProdPers"> <span>Personalize <span id="qtProdPersPrice" class="qt-muted"></span></span></label>
          <div id="qtProdPersFields" hidden>
            <label class="cust-field" id="qtProdPersOptWrap" hidden><span>Placement / option</span><select id="qtProdPersOpt"></select></label>
            <label class="cust-field"><span>Personalization text (optional)</span><input type="text" id="qtProdPersName" maxlength="200" autocomplete="off" placeholder="Name, number, or custom text"></label>
          </div>
        </div>
        ${canPrice ? `<label class="cust-check"><input type="checkbox" id="qtProdOwn"${was && was.customUnitPrice != null ? " checked" : ""}> Set the price per piece by hand (no quantity price)</label>
        <label class="cust-field" id="qtProdOwnWrap" hidden><span>Price per piece ($)</span><input type="number" id="qtProdOwnPrice" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(was && was.customUnitPrice != null ? Number(was.customUnitPrice).toFixed(2) : "")}"></label>
        <div id="qtProdDeco" hidden></div>` : ""}
        <div class="qt-preview" id="qtProdPreview" role="status"></div>
        <div class="cust-err" id="qtProdErr" role="alert"></div>
        <div class="cust-dialog-actions">
          <button type="button" class="admin-btn admin-btn-secondary" id="qtProdCancel">Cancel</button>
          <button type="submit" class="admin-btn" id="qtProdSave">${item ? "Save line" : "Add line"}</button>
        </div>
      </form>`, 520, { guard: true });
    const $ = (s) => ov.querySelector(s);
    const err = $("#qtProdErr");
    const cur = () => usable.find(p => p.productId === $("#qtProd").value) || usable[0];
    const locSel = (key) => [...ov.querySelectorAll('select[data-qt-loc]')].find(s => s.dataset.qtLoc === key);
    const inkSel = (key) => [...ov.querySelectorAll('select[data-qt-ink]')].find(s => s.dataset.qtInk === key);
    const colorOf = (p) => (p.garmentColors || []).length ? $("#qtProdColor").value : "";
    // Draws a product's color and per-location lists. `from`: where the picks to show come from — "dom" (what is
    // drawn now, kept where it is still offered), "was" (this line as it was saved) or "none".
    function drawCfg(from) {
      const p = cur();
      const box = $("#qtProdCfg");
      if (!isCfg(p)) { box.hidden = true; $("#qtProdLocs").innerHTML = ""; return; }
      box.hidden = false;
      const colors = p.garmentColors || [];
      const seed = from === "was" && was && was.productId === p.productId && was.config ? was.config : null;
      $("#qtProdColorWrap").hidden = !colors.length;
      if (from !== "dom") {
        $("#qtProdColor").innerHTML = colors.map(c => `<option value="${escapeHtml(c)}"${seed && seed.garmentColor === c ? " selected" : ""}>${escapeHtml(c)}</option>`).join("");
      }
      const color = colorOf(p);
      const prev = {}, prevInk = {};
      if (from === "dom") for (const loc of (p.locations || [])) { const s = locSel(loc.key), k = inkSel(loc.key); if (s) prev[loc.key] = s.value; if (k) prevInk[loc.key] = k.value; }
      if (seed) for (const l of (seed.locations || [])) { if (l.auto || l.fixed || l.location === "reorderqr") continue; prev[l.location] = l.custom || l.graphicId === "custom" ? "custom" : String(l.graphicId == null ? "" : l.graphicId); prevInk[l.location] = l.ink || ""; }
      const locs = p.locations || [];
      const fixed = (p.fixedTransfers || []).length > 0;
      $("#qtProdLocs").innerHTML = locs.map((loc, i) => {
        const options = cfgOpts(p, loc, color);
        const custom = !!p.customDesign;
        // One location and nothing fixed: there's nothing to leave blank, so no None and the first is picked.
        const onlyLoc = locs.length === 1 && (options.length > 0 || custom) && !fixed;
        const ids = [...options.map(g => String(g.id)), ...(custom ? ["custom"] : [])];
        const value = prev[loc.key] != null && (prev[loc.key] === "" ? !onlyLoc : ids.includes(prev[loc.key])) ? prev[loc.key] : (onlyLoc ? (ids[0] || "") : "");
        const g = value && value !== "custom" ? gById[value] : null;
        const inks = g && Array.isArray(g.inkColors) && g.inkColors.length > 1 ? g.inkColors : [];
        const ink = inks.includes(prevInk[loc.key]) ? prevInk[loc.key] : (inks[0] || "");
        return `<label class="cust-field"><span>${escapeHtml(loc.label || loc.key)}</span>
          <select data-qt-loc="${escapeHtml(loc.key)}" id="qtProdLoc${i}">
            ${onlyLoc ? "" : `<option value=""${value === "" ? " selected" : ""}>None</option>`}
            ${options.map(o => `<option value="${o.id}"${String(o.id) === value ? " selected" : ""}>${escapeHtml(o.name)}${plus(addOnCents(o) / 100)}</option>`).join("")}
            ${custom ? `<option value="custom"${value === "custom" ? " selected" : ""}>Customer's own design${plus(customPrice(p, loc))}</option>` : ""}
          </select></label>
          <label class="cust-field"${inks.length ? "" : " hidden"}><span class="qt-sr">Thread color for ${escapeHtml(loc.label || loc.key)}</span>
            <select data-qt-ink="${escapeHtml(loc.key)}" aria-label="Thread color for ${escapeHtml(loc.label || loc.key)}">
              ${inks.map(c => `<option value="${escapeHtml(c)}"${c === ink ? " selected" : ""}>${escapeHtml(c)}</option>`).join("")}
            </select></label>`;
      }).join("");
    }
    // The line's choices as the shop's page sends them: { garmentColor, locations: [{location, graphicId, ink} | {location, custom: true}] }.
    function cfgConfig(p) {
      const locations = [];
      for (const loc of (p.locations || [])) {
        const v = (locSel(loc.key) || {}).value || "";
        if (!v) continue;
        if (v === "custom") { locations.push({ location: loc.key, custom: true }); continue; }
        const g = gById[v], k = inkSel(loc.key);
        const ink = k && !k.closest("label").hidden ? k.value : (g && Array.isArray(g.inkColors) && g.inkColors.length === 1 ? g.inkColors[0] : "");
        locations.push({ location: loc.key, graphicId: Number(v), ink });
      }
      return { garmentColor: colorOf(p), locations };
    }
    // What one piece costs before personalization: the color's price (or the size's) plus the add-ons.
    function catalogUnit(p) {
      const size = isSized(p) ? $("#qtProdSize").value : "";
      if (isCfg(p)) {
        const c = cfgConfig(p);
        let u = basePrice(p, c.garmentColor, size);
        for (const l of c.locations) u += l.custom ? customPrice(p, (p.locations || []).find(x => x.key === l.location)) : addOnCents(gById[l.graphicId]) / 100;
        return u;
      }
      return isSized(p) ? Number((p.sizePricing || {})[size]) || 0 : Number(p.flatPrice) || 0;
    }
    // The size list, priced for the color chosen; the size picked stays picked.
    function drawSizes(p, keepSize) {
      const sel = $("#qtProdSize"), before = keepSize || sel.value;
      const color = isCfg(p) ? colorOf(p) : "";
      sel.innerHTML = sizes(p).map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)} — ${adminMoney_(basePrice(p, color, s))}</option>`).join("");
      if (before && [...sel.options].some(o => o.value === before)) sel.value = before;
    }
    function preview() {
      const p = cur(); if (!p) return;
      const list = catalogUnit(p);
      const own = $("#qtProdOwn") && $("#qtProdOwn").checked;
      const pers = p.personalizationPrice != null && $("#qtProdPers").checked ? Number(p.personalizationPrice) || 0 : 0;
      const breaks = Array.isArray(p.qtyBreaks) ? p.qtyBreaks.filter(b => Number(b.minQty) > 1 && Number(b.off) > 0) : [];
      const parts = [own ? "Price set by hand." : `Catalog price ${adminMoney_(list)} each${isCfg(p) ? " with the choices above" : ""}${pers ? " + " + adminMoney_(pers) + " personalization" : ""}.`];
      if (!own && breaks.length) parts.push("Quantity prices: " + breaks.map(b => `${Number(b.minQty)}+ pieces, ${adminMoney_(b.off)} off each`).join("; ") + " — counted across every line of this product on the quote.");
      $("#qtProdPreview").textContent = parts.filter(Boolean).join(" ");
    }
    const tools = decoTools($("#qtProdDeco"), deco, {
      // What a piece costs now: the price typed by hand, else the catalog's with the choices.
      getPrice: () => { const own = $("#qtProdOwn").checked ? dollars($("#qtProdOwnPrice").value) : NaN; return isNaN(own) ? catalogUnit(cur()) : own; },
      setPrice: (v) => { const c = $("#qtProdOwn"); c.checked = true; $("#qtProdOwnPrice").value = v; ownToggle(); $("#qtProdOwnPrice").dispatchEvent(new Event("input", { bubbles: true })); },
      catalog: () => catalogUnit(cur()),
      stitches: () => designStitches(cur().designId),
    });
    function forProduct(keep) {
      const p = cur(); if (!p) return;
      const sized = isSized(p);
      drawCfg(keep ? "was" : "none");
      $("#qtProdSizeWrap").hidden = !sized;
      $("#qtProdSize").innerHTML = "";
      if (sized) drawSizes(p, keep && was ? was.size : "");
      const hasPers = p.personalizationPrice != null;
      $("#qtProdPersWrap").hidden = !hasPers;
      $("#qtProdPersPrice").textContent = hasPers ? "(+" + adminMoney_(Number(p.personalizationPrice) || 0) + " each)" : "";
      const opts = hasPers && Array.isArray(p.personalizationOptions) ? p.personalizationOptions : [];
      $("#qtProdPersOptWrap").hidden = !opts.length;
      $("#qtProdPersOpt").innerHTML = opts.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
      const persOn = !!(keep && was && was.personalized && hasPers);
      $("#qtProdPers").checked = persOn;
      $("#qtProdPersFields").hidden = !persOn;
      if (persOn) {
        if (opts.includes(was.persName)) { $("#qtProdPersOpt").value = was.persName; $("#qtProdPersName").value = ""; }
        else $("#qtProdPersName").value = was.persName || "";
      } else $("#qtProdPersName").value = "";
      preview();
      tools.prefill();
    }
    function ownToggle() { if ($("#qtProdOwn")) $("#qtProdOwnWrap").hidden = !$("#qtProdOwn").checked; preview(); }
    forProduct(true); ownToggle();
    $("#qtProd").addEventListener("change", () => forProduct(false));
    $("#qtProdSize").addEventListener("change", preview);
    // A color changes the graphics offered and the price of every size; what is still offered stays picked.
    $("#qtProdColor").addEventListener("change", () => { const p = cur(); drawCfg("dom"); if (isSized(p)) drawSizes(p); preview(); });
    // A graphic changes its thread colors and the price (its add-on).
    $("#qtProdLocs").addEventListener("change", () => { drawCfg("dom"); preview(); });
    $("#qtProdPers").addEventListener("change", () => { $("#qtProdPersFields").hidden = !$("#qtProdPers").checked; preview(); });
    if ($("#qtProdOwn")) $("#qtProdOwn").addEventListener("change", ownToggle);
    $("#qtProdCancel").onclick = () => ov.querySelector("[data-modal-close]").click();
    $("#qtProd").focus();
    $("#qtProdForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const p = cur();
      const qty = wholeNum($("#qtProdQty").value);
      if (!(qty >= 1 && qty <= MAX_QTY)) { err.textContent = `Enter a quantity from 1 to ${MAX_QTY.toLocaleString("en-US")}.`; $("#qtProdQty").focus(); return; }
      const line = { kind: "product", productId: p.productId, size: isSized(p) ? $("#qtProdSize").value : "OSFA", qty, personalized: false, persName: "" };
      if (isCfg(p)) line.config = cfgConfig(p);
      if (p.personalizationPrice != null && $("#qtProdPers").checked) {
        line.personalized = true;
        line.persName = $("#qtProdPersName").value.trim() || (!$("#qtProdPersOptWrap").hidden ? $("#qtProdPersOpt").value : "");
      }
      if ($("#qtProdOwn") && $("#qtProdOwn").checked) {
        const v = dollars($("#qtProdOwnPrice").value);
        if (isNaN(v)) { err.textContent = "Enter the price per piece (0 or more, like 12.50)."; $("#qtProdOwnPrice").focus(); return; }
        line.customUnitPrice = v;
      } else if (!canPrice && was && was.customUnitPrice != null && was.productId === line.productId) {
        // A price someone else set by hand stays, so a role that can't set prices doesn't undo it by changing the size.
        line.customUnitPrice = was.customUnitPrice;
      }
      $("#qtProdSave").disabled = true; err.textContent = "";
      const problem = await done(line, tools.extra());
      if (!ov.isConnected) return;
      if (problem) { err.textContent = problem; $("#qtProdSave").disabled = false; return; }
      close();
    });
  }

  // Add or change a custom line (a description, quantity and price per piece, which the stitch-count and screen print
  // helpers can work out) or a fee (setup, digitizing, art or other: a one-time amount). Either can be taxed or not — sales tax on a fee depends on where the shop is.
  async function showOtherLine(kind, item, done) {
    const fee = kind === "fee";
    const was = item ? toRequest(item) : null;
    const deco = fee ? null : await decoSettings();
    const { ov, close } = inventoryModal_(fee ? (item ? "Change fee" : "Add a fee") : (item ? "Change custom line" : "Add a custom line"), `
      <form id="qtOtherForm" class="cust-form" novalidate>
        ${fee ? `<label class="cust-field"><span>Kind of fee</span><select id="qtOtherKind">${FEE_KINDS.map(([k, l]) => `<option value="${k}"${was && was.feeKind === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>` : ""}
        <label class="cust-field"><span>${fee ? "Description (optional)" : "Description"}</span><input type="text" id="qtOtherName" maxlength="200" autocomplete="off" value="${escapeHtml(was ? was.name : "")}" placeholder="${fee ? "Left logo, 8,000 stitches" : "Extra patch"}"></label>
        <div class="cust-grid">
          ${fee ? "" : `<label class="cust-field"><span>Quantity</span><input type="number" id="qtOtherQty" min="1" max="${MAX_QTY}" step="1" value="${escapeHtml(was ? was.qty : 1)}"></label>`}
          <label class="cust-field"><span>${fee ? "Amount ($)" : "Price per piece ($)"}</span><input type="number" id="qtOtherPrice" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(was ? Number(fee ? was.amount : was.unitPrice).toFixed(2) : "")}"></label>
        </div>
        ${fee ? "" : `<div id="qtOtherDeco" hidden></div>`}
        <label class="cust-check"><input type="checkbox" id="qtOtherTax"${!was || was.taxable ? " checked" : ""}> Subject to sales tax</label>
        <div class="cust-err" id="qtOtherErr" role="alert"></div>
        <div class="cust-dialog-actions">
          <button type="button" class="admin-btn admin-btn-secondary" id="qtOtherCancel">Cancel</button>
          <button type="submit" class="admin-btn" id="qtOtherSave">${item ? "Save line" : "Add line"}</button>
        </div>
      </form>`, 480, { guard: true });
    const $ = (s) => ov.querySelector(s);
    const err = $("#qtOtherErr");
    const tools = fee ? { extra: () => [] } : decoTools($("#qtOtherDeco"), deco, {
      getPrice: () => dollars($("#qtOtherPrice").value),
      setPrice: (v) => { $("#qtOtherPrice").value = v; $("#qtOtherPrice").dispatchEvent(new Event("input", { bubbles: true })); },
    });
    $("#qtOtherCancel").onclick = () => ov.querySelector("[data-modal-close]").click();
    (fee ? $("#qtOtherKind") : $("#qtOtherName")).focus();
    $("#qtOtherForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = $("#qtOtherName").value.trim(), price = dollars($("#qtOtherPrice").value);
      let line;
      if (fee) {
        if (isNaN(price) || price <= 0) { err.textContent = "Enter the fee's amount (more than 0, like 25.00)."; $("#qtOtherPrice").focus(); return; }
        const feeKind = $("#qtOtherKind").value;
        line = { kind: "fee", feeKind, name: name || feeLabel(feeKind), amount: price, taxable: $("#qtOtherTax").checked };
      } else {
        const qty = wholeNum($("#qtOtherQty").value);
        if (!name) { err.textContent = "Describe the line, as the customer will read it."; $("#qtOtherName").focus(); return; }
        if (!(qty >= 1 && qty <= MAX_QTY)) { err.textContent = `Enter a quantity from 1 to ${MAX_QTY.toLocaleString("en-US")}.`; $("#qtOtherQty").focus(); return; }
        if (isNaN(price)) { err.textContent = "Enter the price per piece (0 or more, like 12.50)."; $("#qtOtherPrice").focus(); return; }
        line = { kind: "custom", name, qty, unitPrice: price, taxable: $("#qtOtherTax").checked };
      }
      $("#qtOtherSave").disabled = true; err.textContent = "";
      const problem = await done(line, tools.extra());
      if (!ov.isConnected) return;
      if (problem) { err.textContent = problem; $("#qtOtherSave").disabled = false; return; }
      close();
    });
  }

  // Send… / Send again…: to the customer's email (or another), with an optional message. The customer gets a link to
  // see the quote and accept it or ask for changes. Sending fixes the prices; sending again keeps the same link.
  function showSend(d, reload) {
    const e = d.estimate, c = d.customer || {};
    const number = e.number || "Quote " + e.id;
    const again = e.status === "sent";
    const { ov, close } = inventoryModal_(escapeHtml((again ? "Send again: " : "Send ") + number), `
      <form id="qtSendForm" class="cust-form" novalidate>
        <div class="cust-note">${again ? "The customer gets the same link again." : "The customer gets a link to see the quote, and to accept it or ask for changes. From now on its prices are fixed."}</div>
        <label class="cust-field"><span>Email</span><input type="email" id="qtSendEmail" maxlength="200" autocomplete="off" value="${escapeHtml(e.sentTo || c.email || "")}" placeholder="pat@example.com"></label>
        <label class="cust-field"><span>Note to the customer (on the quote and in the email)</span><textarea id="qtSendMsg" rows="3" maxlength="3000">${escapeHtml(e.message || "")}</textarea></label>
        <div id="qtSendLinkWrap" hidden>
          <div class="cust-note" id="qtSendLinkNote"></div>
          <label class="cust-field"><span>The quote's link</span><input type="text" id="qtSendLink" readonly></label>
        </div>
        <div class="cust-err" id="qtSendErr" role="alert"></div>
        <div class="cust-dialog-actions">
          <button type="button" class="admin-btn admin-btn-secondary" id="qtSendCancel">Cancel</button>
          <button type="submit" class="admin-btn" id="qtSendGo">${again ? "Send again" : "Send quote"}</button>
        </div>
      </form>`, 500, { guard: true });
    const $ = (s) => ov.querySelector(s);
    const err = $("#qtSendErr");
    let sent = false;
    $("#qtSendCancel").onclick = () => { if (sent) { close(); reload(); } else ov.querySelector("[data-modal-close]").click(); };
    $("#qtSendEmail").focus();
    $("#qtSendForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (sent) { close(); reload(); return; }
      const email = $("#qtSendEmail").value.trim();
      if (!email || !looksLikeEmail(email)) { err.textContent = "Enter the email address to send the quote to."; $("#qtSendEmail").focus(); return; }
      $("#qtSendGo").disabled = true; err.textContent = "";
      let a;
      try { a = await adminApi_({ action: "sendEstimate", id: e.id, email, message: $("#qtSendMsg").value.trim() }); }
      catch (ex) { err.textContent = ex.message; $("#qtSendGo").disabled = false; return; }
      if (a && a.emailSent) { close(); showToast("Quote " + number + " sent to " + (a.sentTo || email) + "."); reload(); return; }
      // Marked sent, but the email didn't go: the link is shown so it can be sent another way.
      sent = true;
      $("#qtSendLinkWrap").hidden = false;
      $("#qtSendLinkNote").textContent = "The quote is marked sent, but the email couldn't be sent. Copy this link and send it to the customer yourself.";
      $("#qtSendLink").value = (a && a.link) || "";
      $("#qtSendGo").disabled = false; $("#qtSendGo").textContent = "Done";
      $("#qtSendCancel").hidden = true;
      $("#qtSendLink").focus(); try { $("#qtSendLink").select(); } catch (ex) {}
    });
  }

  // Convert to order…: the order is recorded the way a Local sale is, at the quote's prices, for the quote's customer,
  // unpaid — the invoice it can email at once is how the customer pays.
  function showConvert(d, reload) {
    const e = d.estimate, c = d.customer || {};
    const number = e.number || "Quote " + e.id;
    const hasEmail = !!(c.email || e.sentTo);
    // Emailing the invoice is Send invoice's own permission; a role without it makes the order and nothing more.
    const mayInvoice = adminCan_("orders.invoices", "edit");
    const { ov, close } = inventoryModal_(escapeHtml("Convert " + number + " to an order"), `
      <form id="qtConvForm" class="cust-form" novalidate>
        <div class="cust-merge-text">An order is recorded for ${escapeHtml(custLabel(c))}${manyShops() ? " in " + escapeHtml(shopName(e.orgId)) : ""}, at the quote's prices (${escapeHtml(adminMoneyOr_((d.totals || {}).total))}), not yet paid. The quote is then marked converted.</div>
        ${mayInvoice ? `<label class="cust-check"><input type="checkbox" id="qtConvInvoice"${hasEmail ? " checked" : " disabled"}> <span>Email the customer the invoice${hasEmail ? "" : " (no email address on the customer)"}</span></label>` : ""}
        <div class="cust-err" id="qtConvErr" role="alert"></div>
        <div class="cust-dialog-actions">
          <button type="button" class="admin-btn admin-btn-secondary" id="qtConvCancel">Cancel</button>
          <button type="submit" class="admin-btn" id="qtConvGo">Make the order</button>
        </div>
      </form>`, 480);
    const $ = (s) => ov.querySelector(s);
    const err = $("#qtConvErr");
    $("#qtConvCancel").onclick = () => close();
    // The question is read first, and Enter must not make the order by accident: focus goes to the safe button.
    $("#qtConvCancel").focus();
    $("#qtConvForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      $("#qtConvGo").disabled = true; err.textContent = "";
      try {
        const a = await adminApi_({ action: "convertEstimate", id: e.id, sendInvoice: !!($("#qtConvInvoice") && $("#qtConvInvoice").checked) });
        close();
        showToast("Order " + (a.orderId || "") + " made from quote " + number + ".");
        reload();
      } catch (ex) { err.textContent = ex.message; $("#qtConvGo").disabled = false; }
    });
  }

  // The one name admin.js calls (its route for #quotes and #quotes/<id>, after ensureQuotesPage_).
  window.renderQuotes = function renderQuotes(app, id) {
    if (id == null || id === "") return renderList(app);
    const n = Number(id);
    // An address that isn't a quote's number names nothing: the list, rather than a request the server refuses.
    if (!Number.isInteger(n) || n <= 0) return renderList(app);
    return renderOne(app, n);
  };
  // The Customers page's "New quote for this customer": the New quote window with that customer already picked.
  window.renderQuotes.newForCustomer = function (customer) { showNewQuote(customer && customer.id != null ? customer : null); };
})();
