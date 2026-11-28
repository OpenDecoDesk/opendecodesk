// Reports → Unpaid POs (admin.js loads this file on demand, the first time #unpaidpos is opened: ensureReceivablesPage_;
// migrations/0121). Every Net 30 order that still has money owed: who owes it, the PO it rests on, when it falls due and
// how late it is. A Net 30 order counts as paid for the WORK once its PO is accepted (db.js net30Cleared) — blanks, the
// run, delivery and completion go ahead — but the money stays owed, and the order stays on this page, until real payments
// bring its balance to nothing. The figures come from getUnpaidPoReport (db.js), the same owed/received sums the order
// itself shows, as of a day (today unless another is chosen).
//
// A classic script like admin.js and admin-giftcards.js, so it uses admin.js's own helpers as they are (adminApi_,
// adminSetHash, adminTitle_, adminPageHead_, askConfirm_, adminCan_, adminCanOpen_, adminCanCustomers_, adminMoney_,
// adminDate_, adminDay_, localToday_, downloadCsv_, openOrderFromDashboard_) and storefront.js's (escapeHtml, showToast).
// It adds one global, renderUnpaidPos(app).
//
// No data-admin-action here: the names those run are a fixed list at the top of admin.js. The page puts its listeners on
// its own root element, which goes away with the page.
(function () {
  "use strict";

  const TERMS_FN = "orders.terms";
  // The report's groups, in the order the strip shows them (db.js getUnpaidPoReport). A server that sends its own labels
  // wins; these are for one that sends only the keys.
  const GROUPS = [
    ["nopo", "No PO yet"], ["tocheck", "PO to check"], ["notdue", "Not yet due"],
    ["1-30", "1–30 days late"], ["31-60", "31–60 days late"], ["61-90", "61–90 days late"], ["90+", "Over 90 days late"],
  ];
  const STARTS = {
    invoice: "the day the invoice was first sent (the order date when no invoice was sent)",
    order: "the order date",
    completed: "the day the order was completed — shipped or picked up (not due until then)",
  };
  // What the page was showing, kept while the admin is open so coming back finds the same view.
  const view = { asOf: "", org: "", customerId: "", group: "" };
  let knownCustomers = [];   // the customers of the last answer for every customer, for the Customer filter

  const stillOn = (root) => _currentAdminHash === "unpaidpos" && !!root && root.isConnected;
  const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));
  // Money comes as whole cents (…Cents); a server that sends dollars instead (owed, received…) is read too.
  const cents = (o, name) => {
    if (!o) return 0;
    if (o[name + "Cents"] != null) return Math.round(Number(o[name + "Cents"]) || 0);
    return o[name] != null ? Math.round((Number(o[name]) || 0) * 100) : 0;
  };
  const money = (c) => adminMoney_((Number(c) || 0) / 100);
  const day = (v) => v ? adminDate_(adminDay_(v)) : "";
  const poText = (r) => { const p = String(r.poNumber || "").trim(); return p ? (/^po\b/i.test(p) ? p : "PO " + p) : ""; };
  const customerLabel = (r) => r.customerName || r.company || "";
  function statusTag(r) {
    const s = r.poStatus || (r.poNumber ? "" : "PO needed");
    if (s === "PO needed") return `<span class="cust-tag cust-tag-warn">PO needed</span>`;
    if (s === "PO to check") return `<span class="cust-tag ar-tag-check">PO to check</span>`;
    if (Number(r.daysLate) > 0) return `<span class="cust-tag cust-tag-warn">Late</span>`;
    return `<span class="cust-tag ar-tag-ok">PO accepted</span>`;
  }

  async function renderPage(app) {
    adminSetHash("unpaidpos");
    document.title = adminTitle_("Unpaid POs");
    if (!view.asOf) view.asOf = localToday_();
    const shops = (adminOrgs || []).slice().sort((a, b) => String(a.name || a.orgId).localeCompare(String(b.name || b.orgId)));
    if (view.org && !shops.some(o => o.orgId === view.org)) view.org = "";
    app.innerHTML = `
      ${adminPageHead_("Unpaid POs")}
      <div class="admin-panel cust-page ar-page" id="arPage" style="--org-accent:var(--accent);">
        <form class="cust-bar" id="arFilters" novalidate>
          <label class="cust-field ar-filter"><span>As of</span><input type="date" id="arAsOf" value="${escapeHtml(view.asOf)}" max="9999-12-31"></label>
          <label class="cust-field ar-filter"><span>Shop</span><select id="arOrg"><option value="">All shops</option>${shops.map(o => `<option value="${escapeHtml(o.orgId)}"${o.orgId === view.org ? " selected" : ""}>${escapeHtml(o.name || o.orgId)}</option>`).join("")}</select></label>
          <label class="cust-field ar-filter ar-filter-wide"><span>Customer</span><select id="arCustomer"><option value="">All customers</option></select></label>
          <button type="button" class="admin-btn admin-btn-secondary" id="arToday">Today</button>
          <button type="button" class="admin-btn admin-btn-secondary" id="arCsv" data-perm-keep disabled>Export CSV</button>
        </form>
        <div class="gc-totals" id="arTotals" aria-live="polite"></div>
        <div class="ar-groups" id="arGroups" role="group" aria-label="Show one group"></div>
        <div id="arBody"><div class="cust-note">Loading…</div></div>
        <div class="cust-note" id="arBasis"></div>
        <div class="cust-note">A Net 30 order goes ahead — blanks, the run, delivery and completing it — once its PO is accepted, but it stays here until it is paid in full. A PO the customer typed (at checkout or on the invoice page) waits for <strong>Accept PO</strong>; a PO typed by staff counts at once. Set an order to Net 30, or change its PO, with <strong>Net 30…</strong> on the order.</div>
      </div>`;
    const root = document.getElementById("arPage");
    const $ = (sel) => root.querySelector(sel);
    let report = null, asked = 0;

    function drawCustomerFilter() {
      const sel = $("#arCustomer");
      const list = knownCustomers.slice();
      if (view.customerId && !list.some(c => String(c.customerId) === String(view.customerId))) list.push({ customerId: view.customerId, name: "Customer " + view.customerId });
      sel.innerHTML = `<option value="">All customers</option>` + list.map(c => `<option value="${escapeHtml(String(c.customerId))}"${String(c.customerId) === String(view.customerId) ? " selected" : ""}>${escapeHtml(c.name || c.company || "Customer " + c.customerId)}</option>`).join("");
    }

    function groupsOf(d) {
      const sent = Array.isArray(d.groups) ? d.groups : [];
      return GROUPS.map(([key, label]) => {
        const g = sent.find(x => x && x.key === key) || {};
        const rows = (d.rows || []).filter(r => r.group === key);
        return { key, label: g.label || label, count: g.count != null ? Number(g.count) || 0 : rows.length,
          owed: g.owedCents != null || g.owed != null ? cents(g, "owed") : rows.reduce((s, r) => s + cents(r, "owed"), 0) };
      });
    }

    function draw() {
      const d = report || {};
      const t = d.totals || {};
      const rows = Array.isArray(d.rows) ? d.rows : [];
      const shown = view.group ? rows.filter(r => r.group === view.group) : rows;
      const canAccept = adminCan_(TERMS_FN, "edit");
      const canOrders = typeof adminCanOpen_ !== "function" || adminCanOpen_("orders");
      const canCustomers = typeof adminCanCustomers_ === "function" && adminCanCustomers_();
      const cell = (label, v, note, warn) => `<div class="gc-total${warn ? " ar-total-warn" : ""}"><div class="gc-total-n">${v}</div><div class="gc-total-l">${escapeHtml(label)}</div>${note ? `<div class="gc-total-note">${escapeHtml(note)}</div>` : ""}</div>`;
      const count = t.count != null ? Number(t.count) || 0 : rows.length;
      const owed = t.owedCents != null || t.owed != null ? cents(t, "owed") : rows.reduce((s, r) => s + cents(r, "owed"), 0);
      const late = t.lateCents != null || t.late != null ? cents(t, "late") : rows.filter(r => Number(r.daysLate) > 0).reduce((s, r) => s + cents(r, "owed"), 0);
      const toCheck = t.toCheck != null ? Number(t.toCheck) || 0 : rows.filter(r => r.poStatus === "PO to check").length;
      $("#arTotals").innerHTML = cell("Owed on Net 30", money(owed), plural(count, "order")) + cell("Late", money(late), late ? "Past the due date" : "Nothing past its due date", late > 0)
        + cell("POs to check", String(toCheck), toCheck ? "Typed by the customer — accept each one" : "None waiting", toCheck > 0);

      $("#arGroups").innerHTML = groupsOf(d).map(g => `<button type="button" class="ar-group${view.group === g.key ? " on" : ""}${g.count ? "" : " ar-group-zero"}" data-ar-group="${escapeHtml(g.key)}" aria-pressed="${view.group === g.key ? "true" : "false"}">
          <span class="ar-group-l">${escapeHtml(g.label)}</span><span class="ar-group-n">${g.count}</span><span class="ar-group-m">${money(g.owed)}</span></button>`).join("");

      const starts = STARTS[d.startsAt] || STARTS.invoice;
      $("#arBasis").innerHTML = `As of ${escapeHtml(adminDate_(d.asOf || view.asOf))}. Due dates count from ${escapeHtml(starts)}, plus the order's terms (the customer's own days, else the default)${adminCanOpen_("settings") ? ` — change it under <a href="#settings">Global settings → Net 30 terms</a>` : ""}. A day is late once it is past the due date; due today isn't late yet.`;
      $("#arCsv").disabled = !shown.length;

      if (!rows.length) {
        const off = d.net30On === false || d.enabled === false;
        $("#arBody").innerHTML = `<div class="cust-note ar-empty">${off
          ? `Net 30 is switched off, and no order is on Net 30 terms. ${adminCanOpen_("settings") ? `Turn it on under <a href="#settings">Global settings → Payment methods</a> (“Net 30 (with a PO)”).` : "An admin can turn it on under Global settings → Payment methods."}`
          : view.org || view.customerId ? "No unpaid Net 30 order for this shop or customer." : "No Net 30 order has money owed. Everything on terms is paid."}</div>`;
        return;
      }

      const custRows = Array.isArray(d.customers) ? d.customers : [];
      const custTable = custRows.length > 1 || (custRows.length === 1 && !view.customerId) ? `<h3 class="cust-h">By customer</h3>
        <div class="admin-table-wrap"><table class="stack-mobile cust-table ar-customers">
          <thead><tr><th>Customer</th><th class="cust-num">Orders</th><th class="cust-num">Owed</th><th class="cust-num">Late</th></tr></thead>
          <tbody>${custRows.map((c, i) => `<tr>
            <td class="stack-title"><button type="button" class="ar-linkbtn" data-ar-cust="${i}" title="Show only this customer's orders">${escapeHtml(c.name || c.company || (c.customerId ? "Customer " + c.customerId : "No customer record"))}</button></td>
            <td class="cust-num">${Number(c.count) || 0}</td>
            <td class="cust-num">${money(cents(c, "owed"))}</td>
            <td class="cust-num${cents(c, "late") > 0 ? " ar-late" : ""}">${cents(c, "late") ? money(cents(c, "late")) : "—"}</td>
          </tr>`).join("")}</tbody></table></div>` : "";

      const label = (GROUPS.find(g => g[0] === view.group) || [])[1];
      $("#arBody").innerHTML = `${custTable}
        <div class="cust-h-row"><h3 class="cust-h" style="margin:0;">Orders${view.group ? " — " + escapeHtml(label || view.group) : ""} (${shown.length})</h3>
          ${view.group ? `<button type="button" class="admin-btn admin-btn-secondary" data-ar-group="">Show every group</button>` : ""}</div>
        ${shown.length ? `<div class="admin-table-wrap"><table class="stack-mobile cust-table ar-rows">
          <thead><tr><th>Order</th><th>Customer</th><th>PO</th><th>Status</th><th>Invoiced</th><th>Due</th><th class="cust-num">Days late</th><th class="cust-num">Owed</th>${canAccept ? "<th></th>" : ""}</tr></thead>
          <tbody>${shown.map(r => {
            const i = rows.indexOf(r);
            const who = customerLabel(r);
            const late = Number(r.daysLate) || 0;
            return `<tr data-ar-row="${i}">
              <td class="stack-title">${canOrders ? `<button type="button" class="ar-linkbtn mono" data-ar-open="${i}" title="Open this order in its shop's orders">${escapeHtml(r.orderId)}</button>` : `<span class="mono">${escapeHtml(r.orderId)}</span>`}
                <div class="ar-sub">${escapeHtml(r.orgName || r.orgId || "")}${r.placedAt ? " · placed " + escapeHtml(day(r.placedAt)) : ""}</div></td>
              <td>${who ? (canCustomers && Number(r.customerId) > 0 ? `<a class="cust-link" href="#customers/${encodeURIComponent(r.customerId)}">${escapeHtml(who)}</a>` : escapeHtml(who)) : "—"}${r.company && r.customerName && r.company !== r.customerName ? `<div class="ar-sub">${escapeHtml(r.company)}</div>` : ""}</td>
              <td>${poText(r) ? escapeHtml(poText(r)) : "—"}</td>
              <td>${statusTag(r)}</td>
              <td>${r.invoicedAt ? escapeHtml(day(r.invoicedAt)) : `<span class="ar-sub">Not sent</span>`}</td>
              <td>${r.dueDate ? escapeHtml(adminDate_(r.dueDate)) : `<span class="ar-sub">${d.startsAt === "completed" && !r.completedAt ? "When completed" : "—"}</span>`}${r.termsDays ? `<div class="ar-sub">Net ${Number(r.termsDays)}</div>` : ""}</td>
              <td class="cust-num${late > 0 ? " ar-late" : ""}">${late > 0 ? late : "—"}</td>
              <td class="cust-num"><strong>${money(cents(r, "owed"))}</strong>${cents(r, "received") > 0 ? `<div class="ar-sub">of ${money(cents(r, "total"))}</div>` : ""}</td>
              ${canAccept ? `<td>${r.poStatus === "PO to check" ? `<button type="button" class="admin-btn admin-btn-sm" data-ar-accept="${i}" data-need="${TERMS_FN}:edit">Accept PO</button>` : ""}</td>` : ""}
            </tr>`; }).join("")}</tbody></table></div>`
          : `<div class="cust-note">No order in this group.</div>`}`;
    }

    async function load() {
      const mine = ++asked;   // a slower, older answer must not replace a newer one
      const ask = { action: "getUnpaidPoReport", asOf: view.asOf };
      if (view.org) ask.orgId = view.org;
      if (view.customerId) ask.customerId = Number(view.customerId);
      $("#arCsv").disabled = true;
      try {
        const d = await adminApi_(ask);
        if (mine !== asked || !stillOn(root)) return;
        report = d && typeof d === "object" ? (d.report && typeof d.report === "object" ? d.report : d) : {};
        // The Customer filter lists everyone owing, so it is filled from an answer that wasn't narrowed to one.
        if (!view.customerId && Array.isArray(report.customers)) knownCustomers = report.customers.filter(c => c && c.customerId != null);
        drawCustomerFilter();
        draw();
      } catch (e) {
        if (mine !== asked || !stillOn(root)) return;
        report = null;
        $("#arTotals").innerHTML = ""; $("#arGroups").innerHTML = "";
        $("#arBody").innerHTML = `<div class="cust-err" role="alert">${escapeHtml(e.message || "Couldn't load the report.")}</div>`;
      }
    }

    function exportCsv() {
      const rows = report && Array.isArray(report.rows) ? report.rows.filter(r => !view.group || r.group === view.group) : [];
      if (!rows.length) { showToast("There are no orders to export.", true); return; }
      const label = (k) => (GROUPS.find(g => g[0] === k) || [])[1] || k || "";
      const dollars = (c) => Number(((Number(c) || 0) / 100).toFixed(2));
      downloadCsv_(`unpaid-pos-${view.asOf}${view.org ? "-" + view.org : ""}.csv`, rows.map(r => ({
        orderId: r.orderId, shop: r.orgName || r.orgId || "", customer: r.customerName || "", company: r.company || "", po: String(r.poNumber || ""),
        status: r.poStatus || "", group: label(r.group), placed: adminDay_(r.placedAt || ""), invoiced: adminDay_(r.invoicedAt || ""),
        completed: adminDay_(r.completedAt || ""), terms: r.termsDays != null ? Number(r.termsDays) : "", due: r.dueDate || "",
        daysLate: Number(r.daysLate) > 0 ? Number(r.daysLate) : 0, total: dollars(cents(r, "total")), received: dollars(cents(r, "received")), owed: dollars(cents(r, "owed")) })),
        [["orderId", "Order #"], ["shop", "Shop"], ["customer", "Customer"], ["company", "Company"], ["po", "PO number"], ["status", "PO status"], ["group", "Group"],
          ["placed", "Placed"], ["invoiced", "Invoiced"], ["completed", "Completed"], ["terms", "Terms (days)"], ["due", "Due"], ["daysLate", "Days late"],
          ["total", "Total"], ["received", "Received"], ["owed", "Owed"]]);
    }

    async function acceptPo(r, btn) {
      if (!r) return;
      const po = poText(r) || "the PO";
      if (!(await askConfirm_(`Accept ${po} for order ${r.orderId}?\n\nThe order is cleared for work: blanks, the run and delivery go ahead. The money stays owed until it's paid, and the order stays on this report until then.`, { confirmLabel: "Accept PO" }))) return;
      if (btn) btn.disabled = true;
      try {
        await adminApi_({ action: "acceptOrderPo", orderId: r.orderId, org: r.orgId });
        showToast(`${po} accepted for order ${r.orderId}.`);
        if (stillOn(root)) load();
      } catch (e) { showToast("Couldn't accept the PO: " + (e.message || "unknown error"), true); if (btn && btn.isConnected) btn.disabled = false; }
    }

    root.addEventListener("submit", (e) => { e.preventDefault(); load(); });
    root.addEventListener("change", (e) => {
      const id = e.target.id;
      if (id === "arAsOf") { if (!/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) return; view.asOf = e.target.value; load(); }
      else if (id === "arOrg") { view.org = e.target.value; view.customerId = ""; view.group = ""; load(); }
      else if (id === "arCustomer") { view.customerId = e.target.value; view.group = ""; load(); }
    });
    root.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || !root.contains(btn)) return;
      if (btn.id === "arToday") { view.asOf = localToday_(); $("#arAsOf").value = view.asOf; load(); return; }
      if (btn.id === "arCsv") { exportCsv(); return; }
      const rows = (report && report.rows) || [];
      if (btn.dataset.arGroup != null) { view.group = view.group === btn.dataset.arGroup ? "" : btn.dataset.arGroup; if (report) draw(); return; }
      if (btn.dataset.arCust != null) {
        const c = ((report && report.customers) || [])[Number(btn.dataset.arCust)];
        if (c && c.customerId != null) { view.customerId = String(c.customerId); view.group = ""; drawCustomerFilter(); load(); }
        return;
      }
      if (btn.dataset.arOpen != null) {
        const r = rows[Number(btn.dataset.arOpen)];
        if (r) openOrderFromDashboard_(r.orgId, r.orderId, r.placedAt);
        return;
      }
      if (btn.dataset.arAccept != null) { acceptPo(rows[Number(btn.dataset.arAccept)], btn); return; }
    });

    drawCustomerFilter();
    await load();
  }

  window.renderUnpaidPos = function renderUnpaidPos(app) { return renderPage(app); };
})();
