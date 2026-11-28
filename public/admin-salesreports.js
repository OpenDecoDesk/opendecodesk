// Reports → Sales by…, Profit per job and Gift card liability (phase 8). admin.js loads this file on demand, the first
// time one of #salesby, #profit or #giftliability is opened (ensureSalesReportsPage_). The figures come from db.js
// getSalesReport, getProfitReport and getGiftCardLiability; money arrives as whole cents (…Cents) and is shown in dollars.
// Sales and profit count the same orders on the same sale date (Global settings → Bookkeeping: shipped or placed), with
// business-day bounds; gift cards sold are never sales here (they are money owed on cards: Gift card liability).
//
// A classic script like admin.js and admin-receivables.js, so it uses admin.js's own helpers as they are (adminApi_,
// adminSetHash, adminTitle_, adminPageHead_, adminCan_, adminCanOpen_, adminCanCustomers_, adminMoney_, adminDate_,
// adminDay_, adminYear_, localToday_, saleDateNote_, downloadCsv_, openOrderFromDashboard_, adminOrgs, _currentAdminHash)
// and storefront.js's (escapeHtml, showToast). It adds three globals: renderSalesBy(app), renderProfitReport(app) and
// renderGiftCardLiability(app).
//
// No data-admin-action here: the names those run are a fixed list at the top of admin.js. Each page puts its listeners
// on its own root element, which goes away with the page.
(function () {
  "use strict";

  const BY = [["customer", "Customer"], ["product", "Product"], ["shop", "Shop"], ["decoration", "Decoration"]];
  const SORTS = [["margin", "Lowest margin first"], ["profit", "Highest profit"], ["revenue", "Most revenue"], ["date", "Newest"]];
  // The parts of a job's cost, in the order the profit table and the order window show them (db.js getOrderProfit).
  const COST_PARTS = [["blanksCents", "Blanks"], ["transfersCents", "Transfers"], ["decorationCents", "Decoration"], ["suppliesCents", "Supplies"],
    ["digitizingCents", "Outside digitizing"], ["cardFeesCents", "Card fees"], ["postageCents", "Postage"], ["laborCents", "Labor"]];

  const thisMonthStart = () => localToday_().slice(0, 8) + "01";
  // What each page was showing, kept while the admin is open so coming back finds the same view.
  const views = {
    salesby: { from: "", to: "", org: "", by: "customer" },
    profit: { from: "", to: "", org: "", sort: "margin", open: new Set() },
    giftliability: { from: "", to: "" },
  };

  const num = (v) => Number(v) || 0;
  const money = (c) => adminMoney_(num(c) / 100);
  const dash = (c) => num(c) ? money(c) : "—";
  const dollars = (c) => Number((num(c) / 100).toFixed(2));
  const pct = (v) => v == null || v === "" || !isFinite(Number(v)) ? "—" : Number(v).toFixed(1) + "%";
  const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  const stillOn = (hash, root) => _currentAdminHash === hash && !!root && root.isConnected;
  const shopsSorted = () => (adminOrgs || []).slice().sort((a, b) => String(a.name || a.orgId).localeCompare(String(b.name || b.orgId)));
  const shopName = (orgId, given) => given || ((adminOrgs || []).find(o => o.orgId === orgId) || {}).name || orgId || "";

  // The quick ranges under the dates. kind "quarters": this month, Q1–Q4 and the year (Sales by… and Profit per job);
  // "years": this year, last year and this month (Gift card liability).
  function presets(kind) {
    const y = adminYear_(), today = localToday_();
    const out = [];
    if (kind === "quarters") {
      out.push(["This month", thisMonthStart(), today]);
      ["01", "04", "07", "10"].forEach((m, i) => out.push([`Q${i + 1} ${y}`, `${y}-${m}-01`, `${y}-${["03-31", "06-30", "09-30", "12-31"][i]}`]));
      out.push([String(y), `${y}-01-01`, `${y}-12-31`], [String(y - 1), `${y - 1}-01-01`, `${y - 1}-12-31`]);
    } else {
      out.push(["This year", `${y}-01-01`, today], [String(y - 1), `${y - 1}-01-01`, `${y - 1}-12-31`], ["This month", thisMonthStart(), today]);
    }
    return out;
  }
  function datesHtml(view, kind, withShop, extra) {
    const shops = shopsSorted();
    if (view.org != null && view.org && !shops.some(o => o.orgId === view.org)) view.org = "";
    return `<form class="cust-bar sr-bar" novalidate>
        <label class="cust-field"><span>From</span><input type="date" class="sr-from" value="${escapeHtml(view.from)}" max="9999-12-31"></label>
        <label class="cust-field"><span>To</span><input type="date" class="sr-to" value="${escapeHtml(view.to)}" max="9999-12-31"></label>
        ${withShop ? `<label class="cust-field"><span>Shop</span><select class="sr-org"><option value="">All shops</option>${shops.map(o => `<option value="${escapeHtml(o.orgId)}"${o.orgId === view.org ? " selected" : ""}>${escapeHtml(o.name || o.orgId)}</option>`).join("")}</select></label>` : ""}
        ${extra || ""}
        <button type="submit" class="admin-btn">Show</button>
        <button type="button" class="admin-btn admin-btn-secondary sr-csv" data-perm-keep disabled>Export CSV</button>
      </form>
      <div class="sr-presets" role="group" aria-label="Quick ranges">${presets(kind).map(([label, f, t]) =>
        `<button type="button" class="sr-preset${view.from === f && view.to === t ? " on" : ""}" data-sr-from="${f}" data-sr-to="${t}">${escapeHtml(label)}</button>`).join("")}</div>`;
  }
  // The dates on the form: an error to show, or null when they can be asked for.
  function readDates(root, view) {
    const f = root.querySelector(".sr-from").value, t = root.querySelector(".sr-to").value;
    if (!isDay(f) || !isDay(t)) return "Choose both dates.";
    if (f > t) return "The From date is after the To date.";
    view.from = f; view.to = t;
    root.querySelectorAll(".sr-preset").forEach(b => b.classList.toggle("on", b.dataset.srFrom === f && b.dataset.srTo === t));
    return null;
  }
  // Wires the dates, the shop and the quick ranges of a page to its load().
  function wireDates(root, view, load) {
    root.querySelector(".sr-bar").addEventListener("submit", (e) => { e.preventDefault(); load(); });
    root.addEventListener("change", (e) => {
      if (e.target.classList.contains("sr-org")) { view.org = e.target.value; load(); }
      else if (e.target.classList.contains("sr-from") || e.target.classList.contains("sr-to")) load();
    });
    root.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-sr-from]");
      if (!b || !root.contains(b)) return;
      root.querySelector(".sr-from").value = b.dataset.srFrom;
      root.querySelector(".sr-to").value = b.dataset.srTo;
      load();
    });
  }
  function rangeText(d, view) {
    const f = d.dateFrom || view.from, t = d.dateTo || view.to;
    return `${escapeHtml(adminDate_(f))} – ${escapeHtml(adminDate_(t))}`;
  }
  const errHtml = (msg) => `<div class="cust-err" role="alert">${escapeHtml(msg || "Couldn't load the report.")}</div>`;
  const unwrap = (d, key) => d && typeof d === "object" ? (d[key] && typeof d[key] === "object" ? d[key] : d) : {};

  // ---- Sales by… ---------------------------------------------------------------------------------------------------
  async function renderSalesBy(app) {
    const view = views.salesby;
    adminSetHash("salesby");
    document.title = adminTitle_("Sales by…");
    if (!isDay(view.from) || !isDay(view.to)) { view.from = thisMonthStart(); view.to = localToday_(); }
    if (!BY.some(b => b[0] === view.by)) view.by = "customer";
    app.innerHTML = `
      ${adminPageHead_("Sales by…")}
      <div class="admin-panel sr-page" id="srSalesPage" style="--org-accent:var(--accent);">
        ${datesHtml(view, "quarters", true)}
        <div class="sr-by" role="group" aria-label="Group by"><span class="sr-by-l">Group by</span>${BY.map(([k, l]) =>
          `<button type="button" class="sr-by-btn${view.by === k ? " on" : ""}" data-sr-by="${k}" aria-pressed="${view.by === k}">${escapeHtml(l)}</button>`).join("")}</div>
        <div class="cust-note sr-basis"></div>
        <div class="sr-body"><div class="cust-note">Loading…</div></div>
        <div class="cust-note">Sales are what the items sold for, before tax: less the order's discount (codes and discounts by hand, shared over its items by amount) and less refunds on items. Cancelled items, test and voided orders and gift cards sold are left out — a gift card is money owed on the card until it is spent (Reports → Gift card liability). Shipping, rush and sales tax aren't sales of a customer, product, shop or decoration, so they are totalled below the table.</div>
      </div>`;
    const root = document.getElementById("srSalesPage");
    const $ = (s) => root.querySelector(s);
    let report = null, asked = 0;

    function draw() {
      const d = report || {};
      const rows = Array.isArray(d.rows) ? d.rows : [];
      const t = d.totals || {};
      $(".sr-basis").innerHTML = `${rangeText(d, view)}${d.basis ? " · " + escapeHtml(saleDateNote_(d.basis)) : ""}, each day on the business's own calendar.`;
      $(".sr-csv").disabled = !rows.length;
      if (!rows.length) { $(".sr-body").innerHTML = `<div class="cust-note sr-empty">No sales in these dates.</div>`; return; }
      const byLabel = (BY.find(b => b[0] === (d.by || view.by)) || BY[0])[1];
      const canCust = (d.by || view.by) === "customer" && typeof adminCanCustomers_ === "function" && adminCanCustomers_();
      const labelCell = (r) => {
        const id = custId(r);
        const text = escapeHtml(r.label || r.key || "—");
        return canCust && id ? `<a class="cust-link" href="#customers/${encodeURIComponent(id)}">${text}</a>` : text;
      };
      const share = (r) => { const p = Math.max(0, Math.min(100, num(r.sharePct))); return `<span class="sr-share"><span class="sr-share-bar" style="width:${p}%"></span></span><span class="sr-share-n">${pct(r.sharePct)}</span>`; };
      const below = [["Shipping charged", t.shippingCents], ["Rush fees", t.rushCents], ["Sales tax", t.taxCents]];
      $(".sr-body").innerHTML = `<div class="admin-table-wrap"><table class="stack-mobile cust-table sr-table" id="srSalesTable">
          <thead><tr><th>${escapeHtml(byLabel)}</th><th class="cust-num">Orders</th><th class="cust-num">Qty</th><th class="cust-num">Gross</th><th class="cust-num">Discount</th><th class="cust-num">Refunds</th><th class="cust-num">Net sales</th><th class="sr-share-h">Share</th></tr></thead>
          <tbody>${rows.map(r => `<tr>
            <td class="stack-title">${labelCell(r)}</td>
            <td class="cust-num" data-label="Orders">${num(r.orders)}</td>
            <td class="cust-num" data-label="Qty">${num(r.qty)}</td>
            <td class="cust-num" data-label="Gross">${money(r.grossCents)}</td>
            <td class="cust-num" data-label="Discount">${num(r.discountCents) ? "−" + money(r.discountCents) : "—"}</td>
            <td class="cust-num" data-label="Refunds">${num(r.refundCents) ? "−" + money(r.refundCents) : "—"}</td>
            <td class="cust-num" data-label="Net sales"><strong>${money(r.netCents)}</strong></td>
            <td class="sr-share-c" data-label="Share">${share(r)}</td>
          </tr>`).join("")}</tbody>
          <tfoot><tr class="sr-total"><td>Total</td><td class="cust-num" data-label="Orders">${num(t.orders)}</td><td class="cust-num" data-label="Qty">${num(t.qty)}</td><td class="cust-num" data-label="Gross">${money(t.grossCents)}</td>
            <td class="cust-num" data-label="Discount">${num(t.discountCents) ? "−" + money(t.discountCents) : "—"}</td><td class="cust-num" data-label="Refunds">${num(t.refundCents) ? "−" + money(t.refundCents) : "—"}</td>
            <td class="cust-num" data-label="Net sales"><strong>${money(t.netCents)}</strong></td><td></td></tr></tfoot>
        </table></div>
        ${(d.by || view.by) === "decoration" ? `<div class="cust-note">An item with two kinds of decoration counts its pieces under each, and its money is split evenly between them.</div>` : ""}
        <div class="sr-below">${below.map(([l, c]) => `<div><span>${escapeHtml(l)}</span><strong>${money(c)}</strong></div>`).join("")}</div>
        <div class="cust-note">Orders in the total counts each order once, even when its items fall under several rows.</div>`;
    }
    // A customer row's id: the server's customerId, or a key that is a number ("12" or "customer:12").
    function custId(r) {
      if (r.customerId != null && /^\d+$/.test(String(r.customerId))) return String(r.customerId);
      const m = /^(?:customer:|c:)?(\d+)$/.exec(String(r.key == null ? "" : r.key));
      return m ? m[1] : "";
    }

    async function load() {
      const bad = readDates(root, view);
      if (bad) { $(".sr-body").innerHTML = errHtml(bad); $(".sr-csv").disabled = true; return; }
      const mine = ++asked;   // a slower, older answer must not replace a newer one
      const ask = { action: "getSalesReport", dateFrom: view.from, dateTo: view.to, by: view.by };
      if (view.org) ask.orgId = view.org;
      $(".sr-csv").disabled = true;
      $(".sr-body").innerHTML = `<div class="cust-note">Loading…</div>`;
      try {
        const d = await adminApi_(ask);
        if (mine !== asked || !stillOn("salesby", root)) return;
        report = Object.assign({ by: view.by }, unwrap(d, "report"));
        draw();
      } catch (e) {
        if (mine !== asked || !stillOn("salesby", root)) return;
        report = null;
        $(".sr-basis").innerHTML = "";
        $(".sr-body").innerHTML = errHtml(e && e.message);
      }
    }

    function exportCsv() {
      const d = report || {}, rows = Array.isArray(d.rows) ? d.rows : [];
      if (!rows.length) { showToast("There are no sales to export.", true); return; }
      const by = d.by || view.by, t = d.totals || {};
      const byLabel = (BY.find(b => b[0] === by) || BY[0])[1];
      const out = rows.map(r => ({ label: r.label || r.key || "", orders: num(r.orders), qty: num(r.qty), gross: dollars(r.grossCents), discount: dollars(r.discountCents),
        refunds: dollars(r.refundCents), net: dollars(r.netCents), share: num(r.sharePct) }));
      out.push({ label: "Total", orders: num(t.orders), qty: num(t.qty), gross: dollars(t.grossCents), discount: dollars(t.discountCents), refunds: dollars(t.refundCents), net: dollars(t.netCents), share: "" });
      downloadCsv_(`sales-by-${by}-${view.from}-to-${view.to}${view.org ? "-" + view.org : ""}.csv`, out,
        [["label", byLabel], ["orders", "Orders"], ["qty", "Qty"], ["gross", "Gross"], ["discount", "Discount"], ["refunds", "Refunds"], ["net", "Net sales"], ["share", "Share %"]]);
    }

    wireDates(root, view, load);
    root.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !root.contains(b)) return;
      if (b.classList.contains("sr-csv")) { exportCsv(); return; }
      if (b.dataset.srBy) {
        view.by = b.dataset.srBy;
        root.querySelectorAll(".sr-by-btn").forEach(x => { const on = x.dataset.srBy === view.by; x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); });
        load();
      }
    });
    await load();
  }

  // ---- Profit per job ----------------------------------------------------------------------------------------------
  async function renderProfitReport(app) {
    const view = views.profit;
    adminSetHash("profit");
    document.title = adminTitle_("Profit per job");
    if (!isDay(view.from) || !isDay(view.to)) { view.from = thisMonthStart(); view.to = localToday_(); }
    if (!SORTS.some(s => s[0] === view.sort)) view.sort = "margin";
    app.innerHTML = `
      ${adminPageHead_("Profit per job")}
      <div class="admin-panel sr-page" id="srProfitPage" style="--org-accent:var(--accent);">
        ${datesHtml(view, "quarters", true, `<label class="cust-field sr-sort"><span>Sort</span><select class="sr-sort-sel">${SORTS.map(([k, l]) => `<option value="${k}"${view.sort === k ? " selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select></label>`)}
        <div class="cust-note sr-basis"></div>
        <div class="gc-totals sr-totals" aria-live="polite"></div>
        <div class="sr-body"><div class="cust-note">Loading…</div></div>
        <div class="cust-note">Profit is what the job brought in — items after discounts and refunds, shipping and rush charged; never sales tax or gift cards sold — less what it cost: blanks and transfers used (estimated for items not made yet), decoration and supplies at today's settings, outside digitizing, card fees and postage. <strong>Labor isn't counted yet.</strong> A job marked <span class="sr-est">est.</span> uses an estimate for part of its cost.</div>
      </div>`;
    const root = document.getElementById("srProfitPage");
    const $ = (s) => root.querySelector(s);
    let report = null, asked = 0;
    const canOrders = typeof adminCanOpen_ !== "function" || adminCanOpen_("orders");

    function partsHtml(costs) {
      const c = costs || {};
      const parts = COST_PARTS.filter(([k]) => num(c[k]) || k === "laborCents");
      return `<div class="sr-parts">${parts.map(([k, l]) => `<div><span>${escapeHtml(l)}</span><strong>${k === "laborCents" && !num(c[k]) ? "not counted yet" : money(c[k])}</strong></div>`).join("")}</div>`;
    }
    function draw() {
      const d = report || {};
      const rows = Array.isArray(d.rows) ? d.rows : [];
      const t = d.totals || {};
      $(".sr-basis").innerHTML = `${rangeText(d, view)}${d.basis ? " · " + escapeHtml(saleDateNote_(d.basis)) : ""}, each day on the business's own calendar.`;
      $(".sr-csv").disabled = !rows.length;
      const cell = (label, v, note, warn) => `<div class="gc-total${warn ? " ar-total-warn" : ""}"><div class="gc-total-n">${v}</div><div class="gc-total-l">${escapeHtml(label)}</div>${note ? `<div class="gc-total-note">${escapeHtml(note)}</div>` : ""}</div>`;
      const est = num(t.estimatedCount);
      $(".sr-totals").innerHTML = rows.length ? cell("Revenue", money(t.revenueCents), `${num(t.orders)} order${num(t.orders) === 1 ? "" : "s"}`) + cell("Costs", money(t.costCents))
        + cell("Profit", money(t.profitCents), "", num(t.profitCents) < 0) + cell("Margin", pct(t.marginPct), est ? `${est} order${est === 1 ? " uses" : "s use"} estimates` : "", t.marginPct != null && Number(t.marginPct) < 0) : "";
      if (!rows.length) { $(".sr-body").innerHTML = `<div class="cust-note sr-empty">No orders in these dates.</div>`; return; }
      $(".sr-body").innerHTML = `<div class="admin-table-wrap"><table class="stack-mobile cust-table sr-table" id="srProfitTable">
          <thead><tr><th></th><th>Order</th><th>Customer</th><th>Date</th><th class="cust-num">Revenue</th><th class="cust-num">Costs</th><th class="cust-num">Profit</th><th class="cust-num">Margin</th></tr></thead>
          <tbody>${rows.map((r, i) => {
            const open = view.open.has(String(r.orderId));
            const neg = r.marginPct != null && Number(r.marginPct) < 0;
            return `<tr class="sr-prow${neg ? " sr-neg" : ""}">
              <td><button type="button" class="sr-toggle" data-sr-toggle="${i}" aria-expanded="${open}" title="Show the cost parts">${open ? "▾" : "▸"}</button></td>
              <td class="stack-title">${canOrders ? `<button type="button" class="ar-linkbtn mono" data-sr-open="${i}" title="Open this order in its shop's orders">${escapeHtml(r.orderId)}</button>` : `<span class="mono">${escapeHtml(r.orderId)}</span>`}<div class="ar-sub">${escapeHtml(shopName(r.orgId, r.orgName))}</div></td>
              <td data-label="Customer">${escapeHtml(r.customerName || "—")}</td>
              <td data-label="Date">${r.saleDate ? escapeHtml(adminDate_(r.saleDate)) : "—"}</td>
              <td class="cust-num" data-label="Revenue">${money(r.revenueCents)}</td>
              <td class="cust-num" data-label="Costs">${money(r.costCents)}${r.estimated ? ` <span class="sr-est" title="Part of this cost is an estimate">est.</span>` : ""}</td>
              <td class="cust-num${num(r.profitCents) < 0 ? " sr-negn" : ""}" data-label="Profit"><strong>${money(r.profitCents)}</strong></td>
              <td class="cust-num${neg ? " sr-negn" : ""}" data-label="Margin">${pct(r.marginPct)}</td>
            </tr>${open ? `<tr class="sr-parts-row"><td></td><td colspan="7">${partsHtml(r.costs)}</td></tr>` : ""}`;
          }).join("")}</tbody>
        </table></div>`;
    }

    async function load() {
      const bad = readDates(root, view);
      if (bad) { $(".sr-body").innerHTML = errHtml(bad); $(".sr-totals").innerHTML = ""; $(".sr-csv").disabled = true; return; }
      const mine = ++asked;
      const ask = { action: "getProfitReport", dateFrom: view.from, dateTo: view.to, sort: view.sort };
      if (view.org) ask.orgId = view.org;
      $(".sr-csv").disabled = true;
      $(".sr-body").innerHTML = `<div class="cust-note">Loading…</div>`;
      try {
        const d = await adminApi_(ask);
        if (mine !== asked || !stillOn("profit", root)) return;
        report = unwrap(d, "report");
        draw();
      } catch (e) {
        if (mine !== asked || !stillOn("profit", root)) return;
        report = null;
        $(".sr-basis").innerHTML = ""; $(".sr-totals").innerHTML = "";
        $(".sr-body").innerHTML = errHtml(e && e.message);
      }
    }

    function exportCsv() {
      const rows = report && Array.isArray(report.rows) ? report.rows : [];
      if (!rows.length) { showToast("There are no orders to export.", true); return; }
      const out = rows.map(r => {
        const c = r.costs || {};
        const o = { orderId: r.orderId, shop: shopName(r.orgId, r.orgName), customer: r.customerName || "", date: r.saleDate || "",
          revenue: dollars(r.revenueCents), costs: dollars(r.costCents), profit: dollars(r.profitCents), margin: r.marginPct == null ? "" : Number(r.marginPct), estimated: r.estimated ? "yes" : "" };
        COST_PARTS.forEach(([k]) => { o[k] = dollars(c[k]); });
        return o;
      });
      downloadCsv_(`profit-per-job-${view.from}-to-${view.to}${view.org ? "-" + view.org : ""}.csv`, out,
        [["orderId", "Order #"], ["shop", "Shop"], ["customer", "Customer"], ["date", "Sale date"], ["revenue", "Revenue"], ["costs", "Costs"], ["profit", "Profit"], ["margin", "Margin %"], ["estimated", "Estimated"]]
          .concat(COST_PARTS.map(([k, l]) => [k, l])));
    }

    wireDates(root, view, load);
    root.addEventListener("change", (e) => { if (e.target.classList.contains("sr-sort-sel")) { view.sort = e.target.value; load(); } });
    root.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !root.contains(b)) return;
      if (b.classList.contains("sr-csv")) { exportCsv(); return; }
      const rows = (report && report.rows) || [];
      if (b.dataset.srToggle != null) {
        const r = rows[Number(b.dataset.srToggle)];
        if (!r) return;
        const id = String(r.orderId);
        if (view.open.has(id)) view.open.delete(id); else view.open.add(id);
        draw();
        return;
      }
      if (b.dataset.srOpen != null) {
        const r = rows[Number(b.dataset.srOpen)];
        // A sale date is a plain day: noon UTC is that same day on any US calendar.
        if (r) openOrderFromDashboard_(r.orgId, r.orderId, r.placedAt || (isDay(r.saleDate) ? r.saleDate + "T12:00:00Z" : ""));
      }
    });
    await load();
  }

  // ---- Gift card liability -----------------------------------------------------------------------------------------
  const LIAB_COLS = [["openingCents", "Opening"], ["soldCents", "Sold"], ["issuedCents", "Given"], ["redeemedCents", "Spent"], ["refundedCents", "Put back"],
    ["adjustedCents", "Adjusted"], ["voidedCents", "Voided"], ["closingCents", "Closing"]];
  const LIAB_TITLES = { soldCents: "Cards bought by customers", issuedCents: "Cards issued by staff without a sale", redeemedCents: "Spent on orders",
    refundedCents: "Money put back on cards (refunds to a card)", adjustedCents: "Balance changes by hand", voidedCents: "Balances taken off voided cards" };
  async function renderGiftCardLiability(app) {
    const view = views.giftliability;
    adminSetHash("giftliability");
    document.title = adminTitle_("Gift card liability");
    if (!isDay(view.from) || !isDay(view.to)) { view.from = adminYear_() + "-01-01"; view.to = localToday_(); }
    app.innerHTML = `
      ${adminPageHead_("Gift card liability")}
      <div class="admin-panel sr-page" id="srLiabPage" style="--org-accent:var(--accent);">
        ${datesHtml(view, "years", false)}
        <div class="gc-totals sr-totals" aria-live="polite"></div>
        <div class="sr-body"><div class="cust-note">Loading…</div></div>
        <div class="cust-note">Money on gift cards is owed to whoever holds them until it is spent, so it is a liability, not a sale. Each month: what was on the cards at its start, plus cards sold and given, less what was spent on orders, plus money put back on cards, balance changes by hand, less voided balances — what is left is the closing balance. Months are the business's own calendar months.</div>
      </div>`;
    const root = document.getElementById("srLiabPage");
    const $ = (s) => root.querySelector(s);
    let report = null, asked = 0;
    // Spent and voided take money off the cards: shown with a minus.
    const signed = (k, c) => (k === "redeemedCents" || k === "voidedCents") && num(c) ? "−" + money(c) : (k === "openingCents" || k === "closingCents" ? money(c) : dash(c));

    function draw() {
      const d = report || {};
      const months = Array.isArray(d.months) ? d.months : [];
      const t = d.totals || {};
      $(".sr-csv").disabled = !months.length;
      const cell = (label, v, note) => `<div class="gc-total"><div class="gc-total-n">${v}</div><div class="gc-total-l">${escapeHtml(label)}</div>${note ? `<div class="gc-total-note">${escapeHtml(note)}</div>` : ""}</div>`;
      $(".sr-totals").innerHTML = cell("On cards right now", money(d.outstandingNowCents), "Every active card's balance today")
        + (months.length ? cell(`Owed on ${adminDate_(d.dateTo || view.to)}`, money(t.closingCents), "The closing balance of the last month") : "");
      if (!months.length) { $(".sr-body").innerHTML = `<div class="cust-note sr-empty">No months in these dates.</div>`; return; }
      $(".sr-body").innerHTML = `<div class="cust-note">${rangeText(d, view)}</div>
        <div class="admin-table-wrap"><table class="stack-mobile cust-table sr-table" id="srLiabTable">
          <thead><tr><th>Month</th>${LIAB_COLS.map(([k, l]) => `<th class="cust-num"${LIAB_TITLES[k] ? ` title="${escapeHtml(LIAB_TITLES[k])}"` : ""}>${escapeHtml(l)}</th>`).join("")}</tr></thead>
          <tbody>${months.map(m => `<tr><td class="stack-title">${escapeHtml(adminDate_(m.month, { month: "long", year: "numeric" }) || m.month)}</td>
            ${LIAB_COLS.map(([k, l]) => `<td class="cust-num" data-label="${escapeHtml(l)}">${k === "closingCents" ? `<strong>${signed(k, m[k])}</strong>` : signed(k, m[k])}</td>`).join("")}</tr>`).join("")}</tbody>
          <tfoot><tr class="sr-total"><td>Total</td>${LIAB_COLS.map(([k, l]) => `<td class="cust-num" data-label="${escapeHtml(l)}">${k === "closingCents" ? `<strong>${signed(k, t[k])}</strong>` : signed(k, t[k])}</td>`).join("")}</tr></tfoot>
        </table></div>`;
    }

    async function load() {
      const bad = readDates(root, view);
      if (bad) { $(".sr-body").innerHTML = errHtml(bad); $(".sr-csv").disabled = true; return; }
      const mine = ++asked;
      $(".sr-csv").disabled = true;
      $(".sr-body").innerHTML = `<div class="cust-note">Loading…</div>`;
      try {
        const d = await adminApi_({ action: "getGiftCardLiability", dateFrom: view.from, dateTo: view.to });
        if (mine !== asked || !stillOn("giftliability", root)) return;
        report = unwrap(d, "report");
        draw();
      } catch (e) {
        if (mine !== asked || !stillOn("giftliability", root)) return;
        report = null;
        $(".sr-totals").innerHTML = "";
        $(".sr-body").innerHTML = errHtml(e && e.message);
      }
    }

    function exportCsv() {
      const months = report && Array.isArray(report.months) ? report.months : [];
      if (!months.length) { showToast("There are no months to export.", true); return; }
      const row = (label, m) => { const o = { month: label }; LIAB_COLS.forEach(([k]) => { o[k] = dollars(m[k]); }); return o; };
      const out = months.map(m => row(m.month, m)).concat([row("Total", report.totals || {})]);
      downloadCsv_(`gift-card-liability-${view.from}-to-${view.to}.csv`, out, [["month", "Month"]].concat(LIAB_COLS));
    }

    wireDates(root, view, load);
    root.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b && root.contains(b) && b.classList.contains("sr-csv")) exportCsv();
    });
    await load();
  }

  window.renderSalesBy = function renderSalesBy_(app) { return renderSalesBy(app); };
  window.renderProfitReport = function renderProfitReport_(app) { return renderProfitReport(app); };
  window.renderGiftCardLiability = function renderGiftCardLiability_(app) { return renderGiftCardLiability(app); };
})();
