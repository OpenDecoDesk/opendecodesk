// The Customers page (admin.js loads this file on demand, the first time #customers is opened:
// ensureCustomersPage_). A customer is a record orders link to (migrations/0105): the list with a search, and one
// customer's details, tax exemption, totals and orders, with archive and merge.
//
// A classic script like admin.js, so it uses admin.js's own helpers as they are (adminApi_, adminSetHash,
// adminPageHead_, inventoryModal_, askConfirm_, adminCan_, adminMoney_, adminDate_, openOrderFromDashboard_) and
// storefront.js's (escapeHtml, showToast). It adds one global, renderCustomers(app, id).
//
// No data-admin-action here: the names those run are a fixed list at the top of admin.js. Each screen instead puts
// one listener on its own root element (the way the decoration-locations list does), which goes away with the screen.
(function () {
  "use strict";

  const CUST_FN = "customers.records";
  const PAGE_SIZE = 50;
  const SEARCH_WAIT_MS = 250;      // typing pauses this long before a search is sent
  const ORDERS_SHOWN_MAX = 500;    // getCustomer sends at most this many orders
  // What the list was showing, kept while the admin is open so coming back from a customer returns to the same search.
  const listView = { q: "", includeArchived: false, offset: 0 };

  // What to call a customer on screen: a record may have only a company, or only an email.
  function custLabel(c) { return (c && (c.name || c.company || c.email)) || "Customer " + (c && c.id != null ? c.id : ""); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  // A screen that finished loading after the admin moved on must not draw over the page they went to.
  const stillOn = (hash, root) => _currentAdminHash === hash && (!root || root.isConnected);

  // ---- The list: #customers ---------------------------------------------------------------------------------
  async function renderList(app) {
    const hash = "customers";
    adminSetHash(hash);
    document.title = adminTitle_("Customers");
    app.innerHTML = `
      ${adminPageHead_("Customers")}
      <div class="admin-panel cust-page" id="custPage" style="--org-accent:var(--accent);">
        <div class="cust-bar">
          <label class="cust-field cust-search"><span>Search</span>
            <input type="search" id="custQ" autocomplete="off" maxlength="200" placeholder="Name, company, email or phone" value="${escapeHtml(listView.q)}"></label>
          <label class="cust-check"><input type="checkbox" id="custShowArchived" ${listView.includeArchived ? "checked" : ""}> Show archived</label>
          <button type="button" class="admin-btn" id="custNew" data-need="${CUST_FN}:edit">+ New customer</button>
        </div>
        <div class="cust-count" id="custCount" role="status" aria-live="polite"></div>
        <div id="custBody"><div class="cust-note">Loading…</div></div>
        <div class="cust-pager" id="custPager"></div>
      </div>`;
    const root = document.getElementById("custPage");
    const body = root.querySelector("#custBody"), count = root.querySelector("#custCount"), pager = root.querySelector("#custPager");
    let asked = 0, timer = null;

    function draw(customers, total) {
      if (!customers.length) {
        count.textContent = "";
        pager.innerHTML = "";
        body.innerHTML = `<div class="cust-note">${listView.q ? "No customer matches that search." : "No customers yet. A customer is added when an order comes in with an email address, or with “+ New customer”."}</div>`;
        return;
      }
      const from = listView.offset + 1, to = listView.offset + customers.length;
      count.textContent = total > customers.length ? `Showing ${from}–${to} of ${plural(total, "customer")}` : plural(total, "customer");
      body.innerHTML = `<div class="admin-table-wrap"><table class="stack-mobile cust-table">
        <thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th class="cust-num">Orders</th><th>Last order</th></tr></thead>
        <tbody>${customers.map(c => `<tr class="cust-row${c.archived ? " cust-row-archived" : ""}" data-cust-id="${escapeHtml(c.id)}">
          <td class="stack-title"><a class="cust-link" href="#customers/${encodeURIComponent(c.id)}">${escapeHtml(custLabel(c))}</a>${c.taxExempt ? (c.taxExemptExpires && c.taxExemptExpires < localToday_() ? ` <span class="cust-tag cust-tag-warn">Exemption expired</span>` : ` <span class="cust-tag cust-tag-exempt">Exempt</span>`) : ""}${c.archived ? ` <span class="cust-tag">Archived</span>` : ""}</td>
          <td>${escapeHtml(c.company || "")}</td>
          <td>${escapeHtml(c.email || "")}</td>
          <td>${escapeHtml(c.phone || "")}</td>
          <td class="cust-num">${Number(c.orderCount) || 0}</td>
          <td>${escapeHtml(c.lastOrderAt ? adminDate_(c.lastOrderAt) : "")}</td>
        </tr>`).join("")}</tbody></table></div>`;
      pager.innerHTML = total > PAGE_SIZE || listView.offset > 0 ? `
        <button type="button" class="admin-btn admin-btn-secondary" data-cust-page="prev" ${listView.offset > 0 ? "" : "disabled"}>‹ Previous</button>
        <button type="button" class="admin-btn admin-btn-secondary" data-cust-page="next" ${to < total ? "" : "disabled"}>Next ›</button>` : "";
    }

    async function load() {
      const mine = ++asked;   // a slower, older answer must not replace a newer one
      try {
        const d = await adminApi_({ action: "listCustomers", q: listView.q, includeArchived: listView.includeArchived, limit: PAGE_SIZE, offset: listView.offset });
        if (mine !== asked || !stillOn(hash, root)) return;
        const customers = d.customers || [], total = Number(d.total) || 0;
        // The page being asked for is gone (the last customer on it was archived or merged): back to the first.
        if (!customers.length && listView.offset > 0) { listView.offset = 0; return load(); }
        draw(customers, total);
      } catch (e) {
        if (mine !== asked || !stillOn(hash, root)) return;
        count.textContent = ""; pager.innerHTML = "";
        body.innerHTML = `<div class="cust-err" role="alert">${escapeHtml(e.message)}</div>`;
      }
    }

    root.addEventListener("input", (e) => {
      if (e.target.id !== "custQ") return;
      clearTimeout(timer);
      timer = setTimeout(() => { listView.q = e.target.value.trim(); listView.offset = 0; load(); }, SEARCH_WAIT_MS);
    });
    root.addEventListener("change", (e) => {
      if (e.target.id !== "custShowArchived") return;
      listView.includeArchived = e.target.checked; listView.offset = 0; load();
    });
    root.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (btn && btn.id === "custNew") { showNewCustomer(); return; }
      if (btn && btn.dataset.custPage) {
        listView.offset = Math.max(0, listView.offset + (btn.dataset.custPage === "next" ? PAGE_SIZE : -PAGE_SIZE));
        load();
        return;
      }
      // Anywhere on a row opens the customer; the name is a real link, for the keyboard and "open in a new tab".
      const row = e.target.closest("tr[data-cust-id]");
      if (row && !e.target.closest("a, button, input")) location.hash = "#customers/" + encodeURIComponent(row.dataset.custId);
    });
    await load();
  }

  // "+ New customer": the few fields that say who it is; the rest (address, notes, exemption) is on the customer's page,
  // which opens once it is saved.
  function showNewCustomer() {
    const { ov, close } = inventoryModal_("New customer", `
      <form id="custNewForm" class="cust-form" novalidate>
        <div class="cust-grid">
          <label class="cust-field"><span>Name</span><input type="text" id="custNewName" maxlength="200" autocomplete="off"></label>
          <label class="cust-field"><span>Company</span><input type="text" id="custNewCompany" maxlength="200" autocomplete="off"></label>
          <label class="cust-field"><span>Email</span><input type="email" id="custNewEmail" maxlength="200" autocomplete="off" placeholder="pat@example.com"></label>
          <label class="cust-field"><span>Phone</span><input type="tel" id="custNewPhone" maxlength="50" autocomplete="off"></label>
        </div>
        <div class="cust-err" id="custNewErr" role="alert"></div>
        <div class="cust-dialog-actions">
          <button type="button" class="admin-btn admin-btn-secondary" id="custNewCancel">Cancel</button>
          <button type="submit" class="admin-btn" id="custNewSave">Create customer</button>
        </div>
      </form>`, 480, { guard: true });
    const val = (id) => ov.querySelector("#" + id).value.trim();
    const err = ov.querySelector("#custNewErr"), save = ov.querySelector("#custNewSave");
    // Cancel asks before throwing away what was typed, as ✕ and Escape do.
    ov.querySelector("#custNewCancel").onclick = () => ov.querySelector("[data-modal-close]").click();
    ov.querySelector("#custNewForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = val("custNewName"), company = val("custNewCompany"), email = val("custNewEmail");
      if (!name && !company) { err.textContent = "Enter a name or a company."; ov.querySelector("#custNewName").focus(); return; }
      if (email && !looksLikeEmail(email)) { err.textContent = "That email address doesn't look right."; ov.querySelector("#custNewEmail").focus(); return; }
      save.disabled = true; err.textContent = "";
      try {
        const d = await adminApi_({ action: "saveCustomer", name, company, email, phone: val("custNewPhone"), address: null, notes: "",
          taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" });
        close();
        showToast("Customer created.");
        location.hash = "#customers/" + encodeURIComponent(d.id);
      } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    });
  }

  // ---- One customer: #customers/<id> -------------------------------------------------------------------------
  function backLink() { return `<a class="backlink" href="#customers">‹ Customers</a>`; }

  async function renderOne(app, id) {
    let hash = "customers/" + id;
    adminSetHash(hash);
    document.title = adminTitle_("Customer");
    const crumbs = (label) => ({ crumbs: [{ label: "Customers", hash: "customers" }, { label }] });
    app.innerHTML = `${adminPageHead_("Customer", crumbs("Customer"))}
      <div class="admin-panel cust-page" id="custPage" style="--org-accent:var(--accent);">${backLink()}<div class="cust-note">Loading…</div></div>`;
    let d;
    try { d = await adminApi_({ action: "getCustomer", id }); }
    catch (e) {
      if (!stillOn(hash)) return;
      document.getElementById("custPage").innerHTML = `${backLink()}<div class="cust-err" role="alert">${escapeHtml(e.message)}</div>`;
      return;
    }
    if (!stillOn(hash) || !d || !d.customer) return;
    const c = d.customer, orders = d.orders || [], totals = d.totals || {};
    // A customer that was merged away answers as the one it was merged into: the address follows.
    if (Number(c.id) !== id) { hash = "customers/" + c.id; adminSetHash(hash); }
    document.title = adminTitle_(custLabel(c));

    const canFull = adminCan_(CUST_FN, "full");
    // A role that isn't shown money gets the customer without it (the server leaves the fields out).
    const showMoney = totals.totalSpent != null || totals.balanceDue != null || orders.some(o => o.total != null);
    const linkOrders = typeof openOrderFromDashboard_ === "function" && (typeof adminCanOpen_ !== "function" || adminCanOpen_("orders"));
    const a = c.address || {};
    const expired = !!(c.taxExempt && c.taxExemptExpires && c.taxExemptExpires < localToday_());
    const shopName = (orgId) => { const o = (adminOrgs || []).find(x => x.orgId === orgId); return (o && o.name) || orgId || ""; };
    const field = (label, fid, value, attrs) => `<label class="cust-field"><span>${label}</span><input id="${fid}" value="${escapeHtml(value == null ? "" : value)}" ${attrs || 'type="text"'}></label>`;

    app.innerHTML = `${adminPageHead_(custLabel(c), crumbs(custLabel(c)))}
      <div class="admin-panel cust-page" id="custPage" style="--org-accent:var(--accent);">
        ${backLink()}
        <div class="cust-head">
          <div>
            <h2 class="cust-name">${escapeHtml(custLabel(c))}</h2>
            <div class="cust-sub">${c.name && c.company ? escapeHtml(c.company) + " · " : ""}Customer since ${escapeHtml(adminDate_(c.createdAt))}
              ${c.archived ? ` <span class="cust-tag">Archived</span>` : ""}
              ${c.taxExempt ? ` <span class="cust-tag ${expired ? "cust-tag-warn" : "cust-tag-exempt"}">${expired ? "Exemption expired" : "Tax exempt"}</span>` : ""}</div>
          </div>
          <div class="cust-actions">
            ${c.archived ? "" : `<button type="button" class="admin-btn" id="custNewSale" data-need="orders.details:edit">New sale for this customer</button>`}
            <button type="button" class="admin-btn admin-btn-secondary" id="custArchive" data-need="${CUST_FN}:edit">${c.archived ? "Restore" : "Archive"}</button>
            <button type="button" class="admin-btn admin-btn-secondary" id="custMerge" data-need="${CUST_FN}:full">Merge into another customer…</button>
          </div>
        </div>

        <div class="cust-totals">
          <div class="cust-total"><b>${Number(totals.orderCount) || 0}</b><span>Orders</span></div>
          ${totals.totalSpent != null ? `<div class="cust-total"><b>${adminMoney_(totals.totalSpent)}</b><span>Spent</span></div>` : ""}
          ${totals.balanceDue != null ? `<div class="cust-total${Number(totals.balanceDue) > 0 ? " cust-total-due" : ""}"><b>${adminMoney_(totals.balanceDue)}</b><span>Balance due</span></div>` : ""}
        </div>

        <form id="custForm" class="cust-form" data-need-form="${CUST_FN}:edit" novalidate>
          <h3 class="cust-h">Details</h3>
          <div class="cust-grid">
            ${field("Name", "custName", c.name, 'type="text" maxlength="200" autocomplete="off"')}
            ${field("Company", "custCompany", c.company, 'type="text" maxlength="200" autocomplete="off"')}
            ${field("Email", "custEmail", c.email, 'type="email" maxlength="200" autocomplete="off"')}
            ${field("Phone", "custPhone", c.phone, 'type="tel" maxlength="50" autocomplete="off"')}
          </div>
          <div class="cust-grid">
            ${field("Address", "custLine1", a.line1, 'type="text" maxlength="300" autocomplete="off"')}
            ${field("Address line 2", "custLine2", a.line2, 'type="text" maxlength="300" autocomplete="off"')}
          </div>
          <div class="cust-grid cust-grid-3">
            ${field("City", "custCity", a.city, 'type="text" maxlength="100" autocomplete="off"')}
            ${field("State", "custState", a.state, 'type="text" maxlength="50" autocomplete="off"')}
            ${field("ZIP", "custZip", a.zip, 'type="text" maxlength="20" autocomplete="off"')}
          </div>
          <label class="cust-field"><span>Notes</span><textarea id="custNotes" rows="3" maxlength="2000">${escapeHtml(c.notes || "")}</textarea></label>

          <fieldset class="cust-exempt" data-need-form="${CUST_FN}:full">
            <legend>Tax exemption</legend>
            <label class="cust-check"><input type="checkbox" id="custExempt" ${c.taxExempt ? "checked" : ""}> Tax exempt: this customer's orders are not charged sales tax</label>
            <div class="cust-grid">
              ${field("Certificate number", "custCert", c.taxExemptCertificate, 'type="text" maxlength="200" autocomplete="off"')}
              ${field("Expires (blank = never)", "custExpires", c.taxExemptExpires, 'type="date"')}
            </div>
            <div class="cust-note">${canFull ? "Applies to orders placed from now on, until the day it expires. Orders already placed keep the tax they were charged."
              : "Only a role with full access to Customers can change a tax exemption."}</div>
          </fieldset>

          <div class="cust-err" id="custErr" role="alert"></div>
          <div class="cust-form-actions"><button type="submit" class="admin-btn" id="custSave">Save</button></div>
        </form>

        <h3 class="cust-h">Orders</h3>
        ${orders.length ? `<div class="admin-table-wrap"><table class="stack-mobile cust-table">
          <thead><tr><th>Order</th><th>Shop</th><th>Placed</th>${showMoney ? `<th class="cust-num">Total</th><th class="cust-num">Paid</th><th class="cust-num">Balance</th>` : ""}<th>Status</th></tr></thead>
          <tbody>${orders.map((o, i) => `<tr class="${o.voided ? "cust-row-archived" : ""}">
            <td class="stack-title">${linkOrders
              ? `<a class="cust-link" href="#orders/${encodeURIComponent(o.orgId)}" data-cust-order="${i}">${escapeHtml(o.orderId)}</a>`
              : escapeHtml(o.orderId)}</td>
            <td>${escapeHtml(shopName(o.orgId))}</td>
            <td>${escapeHtml(adminDate_(o.placedAt))}</td>
            ${showMoney ? `<td class="cust-num">${adminMoneyOr_(o.total)}</td><td class="cust-num">${adminMoneyOr_(o.paidAmount)}</td><td class="cust-num">${adminMoneyOr_(o.balanceDue)}</td>` : ""}
            <td>${[o.voided ? `<span class="cust-tag cust-tag-warn">Voided</span>` : "", o.isTest ? `<span class="cust-tag">Test</span>` : "", o.completed ? `<span class="cust-tag">Completed</span>` : ""].join(" ")}</td>
          </tr>`).join("")}</tbody></table></div>
          ${orders.length >= ORDERS_SHOWN_MAX ? `<div class="cust-note">The ${ORDERS_SHOWN_MAX} most recent orders are listed. The totals above count every order.</div>` : ""}
          ${orders.some(o => o.voided || o.isTest) ? `<div class="cust-note">Voided and test orders are listed but not counted in the totals.</div>` : ""}`
          : `<div class="cust-note">No orders yet.</div>`}
      </div>`;

    const root = document.getElementById("custPage");
    const reload = () => { if (stillOn(hash)) renderOne(app, Number(c.id)); };
    const val = (fid) => root.querySelector("#" + fid).value.trim();

    root.querySelector("#custForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = root.querySelector("#custErr"), save = root.querySelector("#custSave");
      const name = val("custName"), company = val("custCompany"), email = val("custEmail");
      if (!name && !company) { err.textContent = "Enter a name or a company."; root.querySelector("#custName").focus(); return; }
      if (email && !looksLikeEmail(email)) { err.textContent = "That email address doesn't look right."; root.querySelector("#custEmail").focus(); return; }
      // The parts of the stored address this form has no field for (a recipient name, a country) are kept as they are.
      const typed = { line1: val("custLine1"), line2: val("custLine2"), city: val("custCity"), state: val("custState"), zip: val("custZip") };
      const address = Object.values(typed).some(Boolean) ? Object.assign({}, c.address || {}, typed) : null;
      // A role that can't change the exemption sends back what is stored, so its save is never read as a change to it.
      const exemption = canFull
        ? { taxExempt: root.querySelector("#custExempt").checked, taxExemptCertificate: val("custCert"), taxExemptExpires: val("custExpires") }
        : { taxExempt: !!c.taxExempt, taxExemptCertificate: c.taxExemptCertificate || "", taxExemptExpires: c.taxExemptExpires || "" };
      save.disabled = true; err.textContent = "";
      try {
        await adminApi_(Object.assign({ action: "saveCustomer", id: c.id, name, company, email, phone: val("custPhone"), address, notes: val("custNotes") }, exemption));
        showToast("Customer saved.");
        reload();
      } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    });

    root.addEventListener("click", async (e) => {
      const orderLink = e.target.closest("a[data-cust-order]");
      if (orderLink) {
        // Opened the way Home opens an order: its shop's Orders list, widened to the day it was placed, scrolled to
        // the row. A completed or voided order is hidden there until its "Include …" box is ticked, so tick it.
        const o = orders[Number(orderLink.dataset.custOrder)];
        if (!o) return;
        e.preventDefault();
        if (window._orderView) { if (o.completed) window._orderView.includeCompleted = true; if (o.voided) window._orderView.includeCancelled = true; }
        openOrderFromDashboard_(o.orgId, o.orderId, o.placedAt);
        return;
      }
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.id === "custNewSale") {
        if (typeof adminNewSaleForCustomer_ === "function") adminNewSaleForCustomer_(c);
        return;
      }
      if (btn.id === "custArchive") {
        if (!c.archived && !await askConfirm_(`Archive ${custLabel(c)}?\n\nIt leaves the customer list and the customer search. Its orders stay as they are, and you can restore it at any time.`, { confirmLabel: "Archive" })) return;
        try {
          await adminApi_({ action: "setCustomerArchived", id: c.id, archived: !c.archived });
          showToast(c.archived ? "Customer restored." : "Customer archived.");
          reload();
        } catch (ex) { showToast(ex.message, true); }
        return;
      }
      if (btn.id === "custMerge") showMerge(c, orders.length);
    });
  }

  // "Merge into another customer…": find the customer to keep, then one question that says what moves. The merge
  // can't be taken back, so nothing is sent until that question is answered.
  function showMerge(from, orderCount) {
    const { ov, close } = inventoryModal_("Merge into another customer", `
      <div id="custMergePick">
        <div class="cust-note" id="custMergeIntro"></div>
        <label class="cust-field"><span>Search customers</span>
          <input type="search" id="custMergeQ" autocomplete="off" maxlength="200" placeholder="Name, company, email or phone"></label>
        <div class="cust-pick-list" id="custMergeList" role="group" aria-label="Matching customers"></div>
        <div class="cust-count" id="custMergeStatus" role="status" aria-live="polite"></div>
      </div>
      <div id="custMergeConfirm" hidden>
        <div class="cust-merge-text" id="custMergeText" tabindex="-1"></div>
        <div class="cust-err" id="custMergeErr" role="alert"></div>
        <div class="cust-dialog-actions">
          <button type="button" class="admin-btn admin-btn-secondary" id="custMergeBack">Choose another</button>
          <button type="button" class="admin-btn admin-btn-danger admin-btn-danger-solid" id="custMergeGo">Merge</button>
        </div>
      </div>`, 520);
    const q = ov.querySelector("#custMergeQ"), list = ov.querySelector("#custMergeList"), status = ov.querySelector("#custMergeStatus");
    const pick = ov.querySelector("#custMergePick"), confirm = ov.querySelector("#custMergeConfirm"), err = ov.querySelector("#custMergeErr");
    const fromName = custLabel(from);
    ov.querySelector("#custMergeIntro").textContent = `Find the customer to keep. ${fromName}'s orders move to it, and ${fromName} is archived.`;
    let found = [], into = null, asked = 0, timer = null;

    async function search() {
      const mine = ++asked, text = q.value.trim();
      if (!text) { found = []; list.innerHTML = ""; status.textContent = ""; return; }
      try {
        const d = await adminApi_({ action: "listCustomers", q: text, includeArchived: false, limit: 9, offset: 0 });
        if (mine !== asked || !ov.isConnected) return;
        found = (d.customers || []).filter(c => Number(c.id) !== Number(from.id)).slice(0, 8);
        list.innerHTML = found.map((c, i) => `<button type="button" class="cust-pick" data-cust-pick="${i}">
          <b>${escapeHtml(custLabel(c))}</b>
          <span>${escapeHtml([c.name ? c.company : "", c.name || c.company ? c.email : "", c.phone, plural(Number(c.orderCount) || 0, "order")].filter(Boolean).join(" · "))}</span></button>`).join("");
        status.textContent = found.length ? plural(found.length, "customer") + " found" : "No other customer matches that search.";
      } catch (ex) {
        if (mine !== asked || !ov.isConnected) return;
        found = []; list.innerHTML = ""; status.textContent = ex.message;
      }
    }
    q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, SEARCH_WAIT_MS); });

    list.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-cust-pick]");
      into = b ? found[Number(b.dataset.custPick)] : null;
      if (!into) return;
      const intoName = custLabel(into) + (into.email ? " (" + into.email + ")" : "");
      const moving = orderCount >= ORDERS_SHOWN_MAX ? ORDERS_SHOWN_MAX + " or more orders" : plural(orderCount, "order");
      const text = ov.querySelector("#custMergeText");
      text.textContent = `Merge ${fromName} into ${intoName}?\n\n${moving} will move to ${custLabel(into)}. ${fromName} is then archived and can't be used again. ` +
        `This can't be undone.\n\nA tax exemption is not carried over: if ${fromName} is exempt, set the exemption on ${custLabel(into)} yourself.`;
      err.textContent = "";
      pick.hidden = true; confirm.hidden = false;
      // The question is read first, and Enter must not merge by accident: focus goes to the safe button.
      try { ov.querySelector("#custMergeBack").focus(); } catch (ex) {}
    });
    ov.querySelector("#custMergeBack").onclick = () => { into = null; confirm.hidden = true; pick.hidden = false; try { q.focus(); } catch (ex) {} };
    ov.querySelector("#custMergeGo").onclick = async function () {
      if (!into) return;
      this.disabled = true; err.textContent = "";
      try {
        const d = await adminApi_({ action: "mergeCustomers", fromId: from.id, intoId: into.id });
        close();
        showToast(`Merged. ${plural(Number(d.moved) || 0, "order")} moved.`);
        location.hash = "#customers/" + encodeURIComponent(into.id);
      } catch (ex) { err.textContent = ex.message; this.disabled = false; }
    };
  }

  // The one name admin.js calls (its route for #customers and #customers/<id>, after ensureCustomersPage_).
  window.renderCustomers = function renderCustomers(app, id) {
    if (id == null || id === "") return renderList(app);
    const n = Number(id);
    // An address that isn't a customer's number names nothing: the list, rather than a request the server refuses.
    if (!Number.isInteger(n) || n <= 0) return renderList(app);
    return renderOne(app, n);
  };
})();
