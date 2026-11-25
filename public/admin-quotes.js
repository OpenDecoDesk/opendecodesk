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
// (escapeHtml, showToast, productSizes_). It adds one global, renderQuotes(app, id), which also carries
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
          <div id="qtTotals" class="qt-totals" aria-live="polite"></div>

          <div class="cust-err" id="qtErr" role="alert"></div>
          ${fieldsEditable ? `<div class="cust-form-actions"><button type="submit" class="admin-btn" id="qtSave">${e0.status === "changes" ? "Revise" : "Save"}</button>
            <span class="cust-count" id="qtSaved" role="status"></span></div>` : ""}
        </form>
      </div>`;

    const root = document.getElementById("qtPage");
    const form = root.querySelector("#qtForm"), errEl = root.querySelector("#qtErr");
    if (!fieldsEditable) form.querySelectorAll("input, textarea, select").forEach(f => { f.disabled = true; });
    else if (noteOnly) ["#qtTitle", "#qtExpires", "#qtMessage"].forEach(sel => { root.querySelector(sel).disabled = true; });
    const reload = () => { if (stillOn(hash)) renderOne(app, id); };

    function lineRow(it, i) {
      const qtyCell = it.kind === "fee" ? "1" : editable
        ? `<input type="number" class="qt-qty" data-qt-qty="${i}" min="1" max="${MAX_QTY}" step="1" value="${escapeHtml(it.qty)}" aria-label="Quantity of ${escapeHtml(it.name || "this line")}">`
        : escapeHtml(it.qty);
      const unit = Number(it.unitPrice) || 0, list = it.listUnitPrice != null ? Number(it.listUnitPrice) : unit;
      const off = it.kind === "product" && !Number(it.customPrice) && list > unit ? list - unit : 0;
      const what = it.kind === "fee" ? feeLabel(it.feeKind) + (it.name && it.name !== feeLabel(it.feeKind) ? " — " + it.name : "") : it.name || "";
      const sub = [
        it.kind === "product" && it.size && it.size !== "OSFA" ? "Size " + it.size : "",
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
      root.querySelector("#qtTotals").innerHTML = items.length ? `<table class="qt-sum">
        ${inclusive ? "" : `<tr><th>Subtotal</th><td>${adminMoneyOr_(t.subtotal)}</td></tr><tr><th>Sales tax</th><td>${adminMoneyOr_(t.tax)}</td></tr>`}
        <tr class="qt-sum-total"><th>Total</th><td>${adminMoneyOr_(t.total)}</td></tr>
        ${inclusive && Number(t.tax) > 0 ? `<tr><th>Includes sales tax</th><td>${adminMoneyOr_(t.tax)}</td></tr>` : ""}
      </table>${state.estimate && state.estimate.status === "draft" ? `<div class="cust-note">Prices follow the catalog until the quote is sent; from then on they are fixed.</div>` : ""}` : "";
    }
    paintLines();

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
    async function persist(next) {
      if (busy) return STILL_SAVING;
      const head = headFields();
      if (head.expiresOn && head.expiresOn < localToday_() && head.expiresOn !== (state.estimate.expiresOn || null)) return "The last day to accept can't be in the past.";
      busy = true; errEl.textContent = "";
      try {
        const a = await adminApi_(Object.assign({ action: "saveEstimate", id }, head, next === undefined ? {} : { items: next }));
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
      if (e.target.closest("#qtLines")) return;
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
        const done = async (line) => {
          if (i == null && lines.length >= MAX_LINES) return `A quote can have at most ${MAX_LINES} lines.`;
          const next = i == null ? lines.concat([line]) : lines.map((l, j) => j === i ? line : l);
          return persist(next);
        };
        if (kind === "product") return showProductLine(state.estimate.orgId, item, done);
        return showOtherLine(kind, item, done);
      };
      if (at("qtEdit") != null) { const it = (state.items || [])[at("qtEdit")]; if (it) lineDialog(it.kind, at("qtEdit")); return; }
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

  // Add or change a catalog line: the shop's products (not the ones with a garment color and graphics to choose —
  // those are quoted as a custom line), size, quantity and personalization, and a price typed by hand for a role that
  // may set one (as on a Local sale). The price shown here is the catalog's; the server works out the quantity break
  // over the whole quote once the line is saved. done(line) saves; it answers "" or the problem to show.
  const productsByOrg = {};
  async function showProductLine(orgId, item, done) {
    let products = productsByOrg[orgId];
    if (!products) {
      try { products = (await adminApi_({ action: "listProducts", org: orgId })).products || []; }
      catch (ex) { showToast("Couldn't load the shop's products: " + ex.message, true); return; }
      productsByOrg[orgId] = products;
    }
    const usable = products.filter(p => !p.configurable);
    if (!usable.length) { showToast("This shop has no products to quote. Add a custom line instead.", true); return; }
    const isSized = (p) => !!p && p.pricingMode !== "flat" && p.sizePricing && Object.keys(p.sizePricing).length > 0;
    const sizes = (p) => typeof productSizes_ === "function" ? productSizes_(p.sizePricing) : Object.keys(p.sizePricing || {});
    const canPrice = adminCan_("orders.payments", "edit");
    const was = item ? toRequest(item) : null;
    const { ov, close } = inventoryModal_(item ? "Change product line" : "Add a product", `
      <form id="qtProdForm" class="cust-form" novalidate>
        <label class="cust-field"><span>Product</span>
          <select id="qtProd">${usable.map(p => `<option value="${escapeHtml(p.productId)}"${was && was.productId === p.productId ? " selected" : ""}>${escapeHtml(p.name)}${p.versionGroup && p.versionLabel ? " — " + escapeHtml(p.versionLabel) : ""}${p.visible === false || p.visible === 0 || p.visible === "N" ? " (hidden)" : ""}</option>`).join("")}</select></label>
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
        <label class="cust-field" id="qtProdOwnWrap" hidden><span>Price per piece ($)</span><input type="number" id="qtProdOwnPrice" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(was && was.customUnitPrice != null ? Number(was.customUnitPrice).toFixed(2) : "")}"></label>` : ""}
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
    function preview() {
      const p = cur(); if (!p) return;
      const list = isSized(p) ? Number((p.sizePricing || {})[$("#qtProdSize").value]) || 0 : Number(p.flatPrice) || 0;
      const own = $("#qtProdOwn") && $("#qtProdOwn").checked;
      const pers = p.personalizationPrice != null && $("#qtProdPers").checked ? Number(p.personalizationPrice) || 0 : 0;
      const breaks = Array.isArray(p.qtyBreaks) ? p.qtyBreaks.filter(b => Number(b.minQty) > 1 && Number(b.off) > 0) : [];
      const parts = [own ? "Price set by hand." : `Catalog price ${adminMoney_(list)} each${pers ? " + " + adminMoney_(pers) + " personalization" : ""}.`];
      if (!own && breaks.length) parts.push("Quantity prices: " + breaks.map(b => `${Number(b.minQty)}+ pieces, ${adminMoney_(b.off)} off each`).join("; ") + " — counted across every line of this product on the quote.");
      $("#qtProdPreview").textContent = parts.filter(Boolean).join(" ");
    }
    function forProduct(keep) {
      const p = cur(); if (!p) return;
      const sized = isSized(p);
      $("#qtProdSizeWrap").hidden = !sized;
      $("#qtProdSize").innerHTML = sized ? sizes(p).map(s => `<option value="${escapeHtml(s)}"${keep && was && was.size === s ? " selected" : ""}>${escapeHtml(s)} — ${adminMoney_(Number(p.sizePricing[s]) || 0)}</option>`).join("") : "";
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
    }
    const ownToggle = () => { if ($("#qtProdOwn")) $("#qtProdOwnWrap").hidden = !$("#qtProdOwn").checked; preview(); };
    forProduct(true); ownToggle();
    $("#qtProd").addEventListener("change", () => forProduct(false));
    $("#qtProdSize").addEventListener("change", preview);
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
      const problem = await done(line);
      if (!ov.isConnected) return;
      if (problem) { err.textContent = problem; $("#qtProdSave").disabled = false; return; }
      close();
    });
  }

  // Add or change a custom line (a description, quantity and price per piece) or a fee (setup, digitizing, art or
  // other: a one-time amount). Either can be taxed or not — sales tax on a fee depends on where the shop is.
  function showOtherLine(kind, item, done) {
    const fee = kind === "fee";
    const was = item ? toRequest(item) : null;
    const { ov, close } = inventoryModal_(fee ? (item ? "Change fee" : "Add a fee") : (item ? "Change custom line" : "Add a custom line"), `
      <form id="qtOtherForm" class="cust-form" novalidate>
        ${fee ? `<label class="cust-field"><span>Kind of fee</span><select id="qtOtherKind">${FEE_KINDS.map(([k, l]) => `<option value="${k}"${was && was.feeKind === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>` : ""}
        <label class="cust-field"><span>${fee ? "Description (optional)" : "Description"}</span><input type="text" id="qtOtherName" maxlength="200" autocomplete="off" value="${escapeHtml(was ? was.name : "")}" placeholder="${fee ? "Left logo, 8,000 stitches" : "Extra patch"}"></label>
        <div class="cust-grid">
          ${fee ? "" : `<label class="cust-field"><span>Quantity</span><input type="number" id="qtOtherQty" min="1" max="${MAX_QTY}" step="1" value="${escapeHtml(was ? was.qty : 1)}"></label>`}
          <label class="cust-field"><span>${fee ? "Amount ($)" : "Price per piece ($)"}</span><input type="number" id="qtOtherPrice" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(was ? Number(fee ? was.amount : was.unitPrice).toFixed(2) : "")}"></label>
        </div>
        <label class="cust-check"><input type="checkbox" id="qtOtherTax"${!was || was.taxable ? " checked" : ""}> Subject to sales tax</label>
        <div class="cust-err" id="qtOtherErr" role="alert"></div>
        <div class="cust-dialog-actions">
          <button type="button" class="admin-btn admin-btn-secondary" id="qtOtherCancel">Cancel</button>
          <button type="submit" class="admin-btn" id="qtOtherSave">${item ? "Save line" : "Add line"}</button>
        </div>
      </form>`, 480, { guard: true });
    const $ = (s) => ov.querySelector(s);
    const err = $("#qtOtherErr");
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
      const problem = await done(line);
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
