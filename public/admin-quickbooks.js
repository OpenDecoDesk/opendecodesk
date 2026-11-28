// Reports → QuickBooks export (admin.js loads this file on demand, the first time #quickbooks is opened:
// ensureQuickBooksPage_). Sales, payments, expenses and deposits for a range of dates, as QuickBooks Online files (an
// invoice / sales receipt CSV, and bank-upload CSVs one per bank account) or one QuickBooks Desktop .iif file. The files
// are built on the server (functions/_lib/quickbooks.js, from db.js getQuickBooksData) by getQuickBooksExport; this
// page shows what an export will hold, saves the files it answers, and keeps the account mapping (which QuickBooks
// account each kind of money goes to) with getQuickBooksSettings / updateQuickBooksSettings.
//
// A classic script like admin.js and admin-receivables.js, so it uses admin.js's own helpers as they are (adminApi_,
// adminSetHash, adminTitle_, adminPageHead_, adminCan_, adminMoney_, adminDate_, localToday_, addDays_, addMonths_) and
// storefront.js's (escapeHtml, showToast). It adds one global, renderQuickBooks(app).
//
// No data-admin-action here: the names those run are a fixed list at the top of admin.js. The page puts its listeners on
// its own root element, which goes away with the page.
(function () {
  "use strict";

  const FN = "reports.quickbooks";
  const PARTS = [
    ["sales", "Sales", "Every order in the dates (by its sale date) — goods, shipping, rush, discount, sales tax, and gift cards sold (to the gift card liability, never to sales)."],
    ["payments", "Payments", "Money received and refunded, by the day it moved. Gift cards spent move the liability, not a bank."],
    ["expenses", "Expenses", "Expenses and vendor refunds, from the account they were paid from."],
    ["deposits", "Deposits", "Card payouts and cash-outs into your bank accounts, with the fees taken."],
  ];
  const ACCOUNTS = [
    ["sales", "Sales", "Sales"], ["shippingIncome", "Shipping income", "Shipping Income"], ["rushIncome", "Rush income", "Sales"],
    ["discounts", "Discounts", "Discounts Given"], ["salesTaxPayable", "Sales tax payable", "Sales Tax Payable"],
    ["giftCardLiability", "Gift card liability", "Gift Cards Outstanding"], ["undepositedFunds", "Undeposited funds", "Undeposited Funds"],
    ["cardFees", "Card fees", "Merchant Fees"], ["postage", "Postage", "Postage and Delivery"], ["ar", "Accounts receivable", "Accounts Receivable"],
  ];
  const FORMATS = [["online", "QuickBooks Online", "CSV files"], ["desktop", "QuickBooks Desktop", "one .iif file"]];
  // What the page was showing, kept while the admin is open so coming back finds the same view.
  const view = { from: "", to: "", format: "", parts: PARTS.map(p => p[0]) };

  const stillOn = (root) => _currentAdminHash === "quickbooks" && !!root && root.isConnected;
  const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));
  const money = (c) => adminMoney_((Number(c) || 0) / 100);
  const ymdOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  const nameOk = (v) => { const s = String(v == null ? "" : v).trim(); return s.length >= 1 && s.length <= 100 && !/[\t\r\n]/.test(s); };

  // Saves text as a file with a Blob download (a .iif is plain text QuickBooks Desktop reads as is).
  function downloadText_(filename, text, mime) {
    const blob = new Blob([String(text == null ? "" : text)], { type: (mime || "text/plain") + ";charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // The date presets, on the business's calendar.
  function presets() {
    const today = localToday_();
    const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
    const monthStart = today.slice(0, 7) + "-01";
    const lastMonth = addMonths_(today.slice(0, 7), -1);
    const qStart = `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
    return [
      ["month", "This month", monthStart, today],
      ["lastmonth", "Last month", lastMonth + "-01", addDays_(monthStart, -1)],
      ["quarter", "This quarter", qStart, today],
      ["lastyear", "Last year", `${y - 1}-01-01`, `${y - 1}-12-31`],
    ];
  }

  async function renderPage(app) {
    adminSetHash("quickbooks");
    document.title = adminTitle_("QuickBooks export");
    const canEdit = adminCan_(FN, "edit");
    if (!view.from || !view.to) { const p = presets()[1]; view.from = p[2]; view.to = p[3]; }
    const sel = "font:inherit;font-size:14px;font-weight:400;padding:7px 9px;border:1px solid #ccc;border-radius:4px;background:#fff;color:var(--ink,#1a1a1a);";
    app.innerHTML = `
      ${adminPageHead_("QuickBooks export")}
      <div class="admin-panel cust-page qb-page" id="qbPage" style="--org-accent:var(--accent);">
        <form class="cust-bar" id="qbFilters" novalidate>
          <label class="cust-field"><span>From</span><input type="date" id="qbFrom" value="${escapeHtml(view.from)}" max="9999-12-31"></label>
          <label class="cust-field"><span>To</span><input type="date" id="qbTo" value="${escapeHtml(view.to)}" max="9999-12-31"></label>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-self:flex-end;">
            ${presets().map(p => `<button type="button" class="admin-btn admin-btn-secondary" data-perm-keep data-qb-preset="${p[0]}">${escapeHtml(p[1])}</button>`).join("")}
          </div>
        </form>
        <fieldset style="border:0;padding:0;margin:6px 0 10px;">
          <legend class="cust-field" style="padding:0;margin-bottom:4px;">For</legend>
          <div style="display:flex;gap:16px;flex-wrap:wrap;" id="qbFormats">${FORMATS.map(f => `<label style="display:flex;gap:6px;align-items:center;font-size:14px;">
            <input type="radio" name="qbFormat" value="${f[0]}"> <span><strong>${escapeHtml(f[1])}</strong> <span class="cust-note" style="margin:0;">(${escapeHtml(f[2])})</span></span></label>`).join("")}</div>
        </fieldset>
        <fieldset style="border:0;padding:0;margin:0 0 10px;">
          <legend class="cust-field" style="padding:0;margin-bottom:4px;">What to export</legend>
          <div style="display:flex;gap:16px;flex-wrap:wrap;">${PARTS.map(p => `<label style="display:flex;gap:6px;align-items:center;font-size:14px;" title="${escapeHtml(p[2])}">
            <input type="checkbox" data-qb-part="${p[0]}"${view.parts.includes(p[0]) ? " checked" : ""}> ${escapeHtml(p[1])}</label>`).join("")}</div>
        </fieldset>
        <div class="gc-totals" id="qbSummary" aria-live="polite"><div class="cust-note">Loading…</div></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 8px;">
          <button type="button" class="admin-btn" id="qbDownload" data-perm-keep disabled>Download</button>
          <span class="cust-note" id="qbDownloadNote" style="margin:0;"></span>
        </div>
        <div id="qbFiles"></div>
        <div class="cust-note" id="qbHowTo"></div>
        <div class="cust-note"><strong>Make a backup of your company file first.</strong> An import can't be undone in one step: export each range of dates once.</div>

        <h3 class="cust-h" style="margin-top:22px;">Account mapping</h3>
        <div class="cust-note">The QuickBooks account each kind of money goes to. Type each name exactly as it is in your QuickBooks chart of accounts (a sub-account as <span class="mono">Parent:Child</span>).${canEdit ? "" : " You can see the mapping; changing it needs Edit on QuickBooks export."}</div>
        <form id="qbMap" data-need-form="${FN}:edit" novalidate><div class="cust-note">Loading…</div></form>
      </div>`;
    const root = document.getElementById("qbPage");
    const $ = (s) => root.querySelector(s);
    let settings = null, bankAccounts = [], categories = [], summary = null, asked = 0;

    const partsOn = () => PARTS.map(p => p[0]).filter(k => view.parts.includes(k));
    function drawFormat() {
      root.querySelectorAll('input[name="qbFormat"]').forEach(r => { r.checked = r.value === view.format; });
      $("#qbHowTo").innerHTML = view.format === "desktop"
        ? `<strong>QuickBooks Desktop:</strong> File ▸ Utilities ▸ Import ▸ IIF Files, and pick the .iif file. Every transaction in it balances to the cent. Names QuickBooks doesn't have yet (customers, vendors, accounts) are added as it reads the file, so map the accounts below first.`
        : `<strong>QuickBooks Online:</strong> sales — Settings ▸ Import data ▸ Invoices (a sales receipt file goes in the same way, or with an import tool that takes sales receipts); payments, expenses and deposits — Banking ▸ Upload transactions, one file per bank account, each into the account it is named for.`;
    }

    function drawSummary() {
      const s = summary || {};
      const on = partsOn();
      const cell = (label, part) => {
        const x = s[part] || {};
        const n = Number(x.count) || 0;
        return `<div class="gc-total"${on.includes(part) ? "" : ` style="opacity:.45;"`}><div class="gc-total-n">${money(x.totalCents)}</div><div class="gc-total-l">${escapeHtml(label)}</div><div class="gc-total-note">${escapeHtml(on.includes(part) ? plural(n, part === "sales" ? "order" : part === "payments" ? "payment" : part === "expenses" ? "expense" : "deposit") : "Not exported")}</div></div>`;
      };
      $("#qbSummary").innerHTML = PARTS.map(p => cell(p[1], p[0])).join("");
      const total = on.reduce((t, k) => t + (Number((s[k] || {}).count) || 0), 0);
      $("#qbDownload").disabled = !on.length || !summary;
      $("#qbDownloadNote").textContent = !on.length ? "Tick at least one part." : summary && !total ? "Nothing in these dates for the ticked parts." : "";
    }

    function rangeError() {
      if (!ymdOk(view.from) || !ymdOk(view.to)) return "Choose both dates.";
      if (view.from > view.to) return "The From date is after the To date.";
      return "";
    }

    // The summary: the same export asked for its counts only (summaryOnly — no files, nothing written to the log).
    async function loadSummary() {
      const mine = ++asked;   // a slower, older answer must not replace a newer one
      $("#qbFiles").innerHTML = "";
      const err = rangeError();
      if (err) { summary = null; $("#qbSummary").innerHTML = `<div class="cust-err" role="alert">${escapeHtml(err)}</div>`; $("#qbDownload").disabled = true; return; }
      $("#qbDownload").disabled = true;
      try {
        const d = await adminApi_({ action: "getQuickBooksExport", dateFrom: view.from, dateTo: view.to, format: view.format, parts: PARTS.map(p => p[0]), summaryOnly: true });
        if (mine !== asked || !stillOn(root)) return;
        summary = (d && d.summary) || {};
        drawSummary();
      } catch (e) {
        if (mine !== asked || !stillOn(root)) return;
        summary = null;
        $("#qbSummary").innerHTML = `<div class="cust-err" role="alert">${escapeHtml(e.message || "Couldn't load what the export holds.")}</div>`;
      }
    }

    function drawFiles(files) {
      if (!files.length) { $("#qbFiles").innerHTML = `<div class="cust-note">Nothing to export in these dates.</div>`; return; }
      $("#qbFiles").innerHTML = `<div class="cust-note" style="margin-bottom:4px;">${files.length === 1 ? "Saved:" : `Saved ${files.length} files (your browser may ask to allow several downloads):`}</div>
        <ul style="margin:0 0 10px;padding-left:18px;font-size:13px;">${files.map((f, i) => `<li style="margin:3px 0;"><span class="mono">${escapeHtml(f.filename)}</span>
          <button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" data-perm-keep data-qb-file="${i}">Save again</button></li>`).join("")}</ul>`;
    }

    let lastFiles = [];
    async function download() {
      const err = rangeError();
      if (err) { showToast(err, true); return; }
      const parts = partsOn();
      if (!parts.length) { showToast("Tick at least one part to export.", true); return; }
      const btn = $("#qbDownload");
      btn.disabled = true;
      $("#qbDownloadNote").textContent = "Building the files…";
      try {
        const d = await adminApi_({ action: "getQuickBooksExport", dateFrom: view.from, dateTo: view.to, format: view.format, parts });
        if (!stillOn(root)) return;
        lastFiles = (d && Array.isArray(d.files) ? d.files : []).filter(f => f && f.filename);
        if (d && d.summary) { summary = d.summary; drawSummary(); }
        drawFiles(lastFiles);
        // One after another: a browser saves only the first of several downloads started in the same moment.
        lastFiles.forEach((f, i) => setTimeout(() => downloadText_(f.filename, f.text, f.mime), i * 400));
        $("#qbDownloadNote").textContent = "";
        if (lastFiles.length) showToast(lastFiles.length === 1 ? "QuickBooks file saved." : `${lastFiles.length} QuickBooks files saved.`);
      } catch (e) {
        if (!stillOn(root)) return;
        $("#qbDownloadNote").textContent = "";
        showToast("Couldn't build the export: " + (e.message || "unknown error"), true);
      } finally { if (stillOn(root)) btn.disabled = !partsOn().length || !summary; }
    }

    // ---- Account mapping ----
    function drawMapping() {
      const s = settings || {};
      const acc = s.accounts || {};
      const field = (attr, key, label, value, ph) => `<label class="cust-field"><span>${escapeHtml(label)}</span>
        <input type="text" ${attr}="${escapeHtml(key)}" value="${escapeHtml(value || "")}" placeholder="${escapeHtml(ph || "")}" maxlength="100" autocomplete="off"></label>`;
      const grid = "display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px 16px;margin:6px 0 14px;";
      const banks = bankAccounts.map(a => field("data-qb-bank", String(a.id), a.name + (a.active === 0 || a.active === false ? " (closed)" : ""),
        (s.bankAccounts || {})[String(a.id)] || a.name, a.name)).join("");
      const cats = categories.map(c => field("data-qb-cat", String(c.id), c.name, (s.expenseAccounts || {})[String(c.id)] || c.name, c.name)).join("");
      const radios = (name, value, opts) => opts.map(o => `<label style="display:flex;gap:6px;align-items:center;font-size:14px;"><input type="radio" name="${name}" value="${o[0]}"${value === o[0] ? " checked" : ""}> ${escapeHtml(o[1])}</label>`).join("");
      $("#qbMap").innerHTML = `
        <h4 class="cust-h" style="font-size:13px;margin:8px 0 0;">Accounts</h4>
        <div style="${grid}">${ACCOUNTS.map(a => field("data-qb-acc", a[0], a[1], acc[a[0]] || a[2], a[2])).join("")}</div>
        <h4 class="cust-h" style="font-size:13px;margin:8px 0 0;">Bank and card accounts</h4>
        ${banks ? `<div style="${grid}">${banks}</div>` : `<div class="cust-note">No accounts set up yet (Finance → Accounts).</div>`}
        <h4 class="cust-h" style="font-size:13px;margin:8px 0 0;">Expense categories</h4>
        ${cats ? `<div style="${grid}">${cats}</div>` : `<div class="cust-note">No expense categories yet.</div>`}
        <div style="display:flex;gap:28px;flex-wrap:wrap;margin:6px 0 14px;">
          <fieldset style="border:0;padding:0;margin:0;"><legend class="cust-field" style="padding:0;margin-bottom:4px;">Sales go in as</legend>
            <div style="display:flex;gap:14px;flex-wrap:wrap;">${radios("qbSalesAs", s.salesAs === "invoices" ? "invoices" : "receipts", [["receipts", "Sales receipts"], ["invoices", "Invoices"]])}</div>
            <div class="cust-note" style="margin:4px 0 0;">Net 30 orders always go in as invoices.</div></fieldset>
          <fieldset style="border:0;padding:0;margin:0;"><legend class="cust-field" style="padding:0;margin-bottom:4px;">Customer name</legend>
            <div style="display:flex;gap:14px;flex-wrap:wrap;">${radios("qbCustomerName", s.customerName === "shop" ? "shop" : "customer", [["customer", "Customer"], ["shop", "Shop"]])}</div>
            <div class="cust-note" style="margin:4px 0 0;">Shop: every sale of a shop goes under the shop's name (a club, a school).</div></fieldset>
        </div>
        <div class="cust-err" id="qbMapErr" role="alert"></div>
        ${canEdit ? `<button type="submit" class="admin-btn" id="qbSave">Save mapping</button>` : ""}`;
      if (typeof adminApplyPerms_ === "function") adminApplyPerms_($("#qbMap"));
    }

    function readMapping() {
      const v = { format: view.format, accounts: {}, bankAccounts: {}, expenseAccounts: {},
        salesAs: (root.querySelector('input[name="qbSalesAs"]:checked') || {}).value === "invoices" ? "invoices" : "receipts",
        customerName: (root.querySelector('input[name="qbCustomerName"]:checked') || {}).value === "shop" ? "shop" : "customer" };
      const bad = [];
      const take = (sel, attr, into, labelOf) => root.querySelectorAll(sel).forEach(inp => {
        const val = inp.value.trim();
        if (!nameOk(val)) bad.push(labelOf(inp.getAttribute(attr)));
        into[inp.getAttribute(attr)] = val;
      });
      take("[data-qb-acc]", "data-qb-acc", v.accounts, k => (ACCOUNTS.find(a => a[0] === k) || [0, k])[1]);
      take("[data-qb-bank]", "data-qb-bank", v.bankAccounts, k => (bankAccounts.find(a => String(a.id) === k) || {}).name || "account " + k);
      take("[data-qb-cat]", "data-qb-cat", v.expenseAccounts, k => (categories.find(c => String(c.id) === k) || {}).name || "category " + k);
      return { v, bad };
    }

    async function saveSettings(v, quiet) {
      // Sent both as the fields themselves and as `settings`, so either way of reading the request finds them.
      const d = await adminApi_(Object.assign({ action: "updateQuickBooksSettings" }, v, { settings: v }));
      const saved = d && (d.settings || d.quickbooks);
      settings = saved && typeof saved === "object" ? saved : Object.assign({}, settings || {}, v);
      if (!quiet) showToast("QuickBooks account mapping saved.");
    }

    async function saveMapping() {
      const { v, bad } = readMapping();
      const errEl = $("#qbMapErr");
      if (bad.length) { errEl.textContent = `Give ${bad.length === 1 ? bad[0] : bad.length + " boxes"} a name of 1 to 100 characters, on one line.`; return; }
      errEl.textContent = "";
      const btn = $("#qbSave");
      if (btn) btn.disabled = true;
      try {
        await saveSettings(v);
        if (stillOn(root)) { drawMapping(); loadSummary(); }
      } catch (e) { if (stillOn(root)) errEl.textContent = "Couldn't save: " + (e.message || "unknown error"); }
      finally { const b = $("#qbSave"); if (b) b.disabled = false; }
    }

    async function loadSettings() {
      try {
        const d = await adminApi_({ action: "getQuickBooksSettings" });
        if (!stillOn(root)) return;
        settings = (d && (d.settings || d.quickbooks)) || {};
        bankAccounts = Array.isArray(d && d.accounts) ? d.accounts : null;
        categories = Array.isArray(d && d.categories) ? d.categories : null;
      } catch (e) {
        if (!stillOn(root)) return;
        settings = null;
        $("#qbMap").innerHTML = `<div class="cust-err" role="alert">${escapeHtml(e.message || "Couldn't load the account mapping.")}</div>`;
      }
      // A server that doesn't send the app's accounts and categories with the settings: the lists themselves, when this
      // role may read them.
      if (bankAccounts == null) { try { bankAccounts = ((await adminApi_({ action: "listAccounts" })) || {}).accounts || []; } catch (_) { bankAccounts = []; } }
      if (categories == null) { try { categories = ((await adminApi_({ action: "listExpenseCategories" })) || {}).categories || []; } catch (_) { categories = []; } }
      bankAccounts = bankAccounts.filter(a => a && a.id != null);
      categories = categories.filter(c => c && c.id != null);
      if (!stillOn(root)) return;
      if (!view.format) view.format = settings && settings.format === "desktop" ? "desktop" : "online";
      drawFormat();
      if (settings) drawMapping();
    }

    root.addEventListener("submit", (e) => {
      e.preventDefault();
      if (e.target.id === "qbMap") { if (canEdit) saveMapping(); return; }
      loadSummary();
    });
    root.addEventListener("change", (e) => {
      const t = e.target;
      if (t.id === "qbFrom" || t.id === "qbTo") {
        if (!ymdOk(t.value)) return;
        view[t.id === "qbFrom" ? "from" : "to"] = t.value;
        loadSummary();
      } else if (t.name === "qbFormat") {
        view.format = t.value === "desktop" ? "desktop" : "online";
        drawFormat();
        $("#qbFiles").innerHTML = "";
        // Remembered for next time (and for everyone) when this role may change the settings.
        if (canEdit && settings && settings.format !== view.format) saveSettings(Object.assign({}, settings, { format: view.format }), true).catch(() => {});
      } else if (t.dataset && t.dataset.qbPart) {
        const on = new Set(view.parts);
        if (t.checked) on.add(t.dataset.qbPart); else on.delete(t.dataset.qbPart);
        view.parts = PARTS.map(p => p[0]).filter(k => on.has(k));
        $("#qbFiles").innerHTML = "";
        drawSummary();
      }
    });
    root.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || !root.contains(btn)) return;
      if (btn.dataset.qbPreset) {
        const p = presets().find(x => x[0] === btn.dataset.qbPreset);
        if (!p) return;
        view.from = p[2]; view.to = p[3];
        $("#qbFrom").value = view.from; $("#qbTo").value = view.to;
        loadSummary();
        return;
      }
      if (btn.id === "qbDownload") { download(); return; }
      if (btn.dataset.qbFile != null) {
        const f = lastFiles[Number(btn.dataset.qbFile)];
        if (f) downloadText_(f.filename, f.text, f.mime);
      }
    });

    await loadSettings();
    if (!stillOn(root)) return;
    await loadSummary();
  }

  window.renderQuickBooks = function renderQuickBooks(app) { return renderPage(app); };
})();
