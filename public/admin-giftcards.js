// The Gift cards page (admin.js loads this file on demand, the first time #giftcards is opened: ensureGiftCardsPage_;
// migrations/0120). A gift card is a balance a customer can spend on any order, as a payment (never a discount): staff
// issue one here, customers can buy one on the shop, and it is spent at checkout, in a Local sale, on an order's Payments
// window or on the invoice page. It never expires and can't be cashed out. This page is the list (search, status,
// paging, the money strip), "Issue gift card", and one card's window: the balance, who it is for, the ledger of
// everything that moved its balance, and Resend, Adjust and Void.
//
// A classic script like admin.js and admin-customers.js, so it uses admin.js's own helpers as they are (adminApi_,
// adminSetHash, adminPageHead_, inventoryModal_, confirmModal_, askConfirm_, askText_, adminCan_, adminMoney_, adminDate_,
// adminDateTime_, newRequestId_, localToday_) and storefront.js's (escapeHtml, showToast). It adds one global,
// renderGiftCards(app, id).
//
// No data-admin-action here: the names those run are a fixed list at the top of admin.js. The page puts one listener on
// its own root element, which goes away with the page. The full card number is never in a list or a card's first view:
// "Show" asks the server for it (an audited action) and the window keeps it only until it is closed.
(function () {
  "use strict";

  const GC_FN = "giftcards.cards";
  const PAGE_SIZE = 50;
  const SEARCH_WAIT_MS = 250;           // typing pauses this long before a search is sent
  const AMOUNT_MAX_CENTS = 100000000;   // $1,000,000, the server's limit for a card a person issues
  const MESSAGE_MAX = 300;
  // What the list was showing, kept while the admin is open so closing a card returns to the same view.
  const listView = { q: "", status: "all", offset: 0 };
  const STATUS = { all: "All", active: "Active", void: "Void" };
  const KIND = { issue: "Issued", redeem: "Spent on an order", refund: "Put back", adjust: "Adjusted", void: "Voided" };

  const stillOn = (hash, root) => _currentAdminHash === hash && (!root || root.isConnected);
  const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));
  const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

  // Dollars typed into a field → whole cents, without a float multiply: at most two decimals; a leading + or - is kept by
  // the caller. NaN when it isn't an amount.
  function toCents(v) {
    const m = /^\$?(\d+)(?:\.(\d{1,2}))?$/.exec(String(v == null ? "" : v).trim().replace(/,/g, ""));
    if (!m) return NaN;
    return Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0") || 0);
  }
  const money = (dollars) => adminMoney_(Number(dollars) || 0);
  // The card as the server sends it has dollars (balance, initial); a figure that comes as cents is turned into dollars here
  // for display only.
  const dollarsOf = (o, name) => o && o[name] != null ? Number(o[name]) || 0 : o && o[name + "Cents"] != null ? (Number(o[name + "Cents"]) || 0) / 100 : 0;
  // A card number in four groups of four, when it has the full 16 characters.
  function grouped(code) {
    const raw = String(code || "").replace(/[\s-]+/g, "").toUpperCase();
    return raw.length === 16 ? raw.match(/.{4}/g).join("-") : String(code || "");
  }
  const cardName = (c) => "••" + (c && c.last4 != null ? c.last4 : "");
  function statusTag(c) {
    if (c.status === "void") return `<span class="cust-tag cust-tag-warn">Void</span>`;
    if (dollarsOf(c, "balance") <= 0) return `<span class="cust-tag">Used up</span>`;
    return `<span class="cust-tag gc-tag-on">Active</span>`;
  }
  function copyText(text, done) {
    const ok = () => showToast(done || "Copied.");
    const fallback = () => {
      const t = document.createElement("textarea");
      t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select();
      try { document.execCommand("copy"); ok(); } catch (e) { showToast("Couldn't copy — select it and copy by hand.", true); }
      t.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
  }

  // ---- The page: #giftcards and #giftcards/<id> -----------------------------------------------------------------
  async function renderPage(app, openId) {
    const hash = "giftcards";
    adminSetHash(hash);
    document.title = adminTitle_("Gift cards");
    app.innerHTML = `
      ${adminPageHead_("Gift cards")}
      <div class="admin-panel cust-page gc-page" id="gcPage" style="--org-accent:var(--accent);">
        <div class="gc-totals" id="gcTotals" aria-live="polite"></div>
        <div class="cust-bar">
          <label class="cust-field cust-search"><span>Search</span>
            <input type="search" id="gcQ" autocomplete="off" maxlength="200" placeholder="Last 4 digits, name, email or order" value="${escapeHtml(listView.q)}"></label>
          <label class="cust-field gc-filter"><span>Status</span>
            <select id="gcStatus">${Object.keys(STATUS).map(k => `<option value="${k}"${listView.status === k ? " selected" : ""}>${STATUS[k]}</option>`).join("")}</select></label>
          <button type="button" class="admin-btn" id="gcNew" data-need="${GC_FN}:edit">Issue gift card</button>
        </div>
        <div class="cust-count" id="gcCount" role="status" aria-live="polite"></div>
        <div id="gcBody"><div class="cust-note">Loading…</div></div>
        <div class="cust-pager" id="gcPager"></div>
        <div class="cust-note">A gift card is a payment, not a discount: it pays part or all of an order after any discount codes, shipping and tax. It never expires and can't be cashed out. The money isn't sales until it is spent, so selling a card doesn't count as revenue.</div>
      </div>`;
    const root = document.getElementById("gcPage");
    const body = root.querySelector("#gcBody"), count = root.querySelector("#gcCount"), pager = root.querySelector("#gcPager");
    let cards = [], asked = 0, timer = null;

    // The strip: what is still owed on active cards (now), and what was sold and spent this month. A server that can't say
    // leaves it empty rather than showing zeros.
    async function loadTotals() {
      const today = localToday_();
      try {
        const d = await adminApi_({ action: "giftCardTotals", dateFrom: today.slice(0, 8) + "01", dateTo: today });
        if (!stillOn(hash, root)) return;
        const t = (d && (d.totals || d)) || {};
        const box = root.querySelector("#gcTotals");
        const cell = (label, v, note) => `<div class="gc-total"><div class="gc-total-n">${money(v)}</div><div class="gc-total-l">${escapeHtml(label)}</div>${note ? `<div class="gc-total-note">${escapeHtml(note)}</div>` : ""}</div>`;
        box.innerHTML = cell("Still on cards", dollarsOf(t, "outstanding"), "Owed to customers as spending money") + cell("Sold this month", dollarsOf(t, "sold")) + cell("Spent this month", dollarsOf(t, "redeemed"));
      } catch (e) { /* the list still works without the strip */ }
    }

    function draw(total) {
      if (!cards.length) {
        count.textContent = ""; pager.innerHTML = "";
        const filtered = listView.q || listView.status !== "all";
        body.innerHTML = `<div class="cust-note">${filtered ? "No gift card matches." : "No gift cards yet." + (adminCan_(GC_FN, "edit") ? " Make one with “Issue gift card”." : "")}</div>`;
        return;
      }
      const from = listView.offset + 1, to = listView.offset + cards.length;
      count.textContent = total > cards.length ? `Showing ${from}–${to} of ${plural(total, "card")}` : plural(total, "card");
      body.innerHTML = `<div class="admin-table-wrap"><table class="stack-mobile cust-table gc-table">
        <thead><tr><th>Card</th><th class="cust-num">Balance</th><th class="cust-num">Issued for</th><th>For</th><th>From</th><th>Issued</th><th>Status</th></tr></thead>
        <tbody>${cards.map((c, i) => `<tr class="cust-row${c.status === "void" ? " cust-row-archived" : ""}" data-gc-row="${i}">
          <td class="stack-title"><a class="cust-link dc-code" href="#giftcards/${encodeURIComponent(c.id)}" data-gc-open="${i}">${escapeHtml(cardName(c))}</a></td>
          <td class="cust-num">${money(dollarsOf(c, "balance"))}</td>
          <td class="cust-num">${money(dollarsOf(c, "initial"))}</td>
          <td>${escapeHtml(c.recipientName || c.recipientEmail || "")}</td>
          <td>${escapeHtml(c.buyerName || c.buyerEmail || (c.sourceOrderId ? "" : "The shop"))}${c.sourceOrderId ? ` <span class="cust-tag" title="Bought on the shop with order ${escapeHtml(c.sourceOrderId)}">Online</span>` : ""}</td>
          <td>${escapeHtml(c.createdAt ? adminDate_(c.createdAt) : "")}</td>
          <td>${statusTag(c)}</td>
        </tr>`).join("")}</tbody></table></div>`;
      pager.innerHTML = total > PAGE_SIZE || listView.offset > 0 ? `
        <button type="button" class="admin-btn admin-btn-secondary" data-gc-page="prev" ${listView.offset > 0 ? "" : "disabled"}>‹ Previous</button>
        <button type="button" class="admin-btn admin-btn-secondary" data-gc-page="next" ${to < total ? "" : "disabled"}>Next ›</button>` : "";
    }

    async function load() {
      const mine = ++asked;   // a slower, older answer must not replace a newer one
      try {
        const d = await adminApi_({ action: "listGiftCards", q: listView.q, status: listView.status === "all" ? "" : listView.status, limit: PAGE_SIZE, offset: listView.offset });
        if (mine !== asked || !stillOn(hash, root)) return;
        cards = Array.isArray(d.cards) ? d.cards : [];
        // The page asked for is gone: back to the first.
        if (!cards.length && listView.offset > 0) { listView.offset = 0; return load(); }
        draw(Number(d.total) || cards.length);
      } catch (e) {
        if (mine !== asked || !stillOn(hash, root)) return;
        cards = []; count.textContent = ""; pager.innerHTML = "";
        body.innerHTML = `<div class="cust-err" role="alert">${escapeHtml(e.message)}</div>`;
      }
    }
    const reload = () => { if (stillOn(hash, root)) { load(); loadTotals(); } };

    root.addEventListener("input", (e) => {
      if (e.target.id !== "gcQ") return;
      clearTimeout(timer);
      timer = setTimeout(() => { listView.q = e.target.value.trim(); listView.offset = 0; load(); }, SEARCH_WAIT_MS);
    });
    root.addEventListener("change", (e) => {
      if (e.target.id === "gcStatus") { listView.status = e.target.value; listView.offset = 0; load(); }
    });
    root.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (btn && btn.id === "gcNew") { showIssue(reload); return; }
      if (btn && btn.dataset.gcPage) {
        listView.offset = Math.max(0, listView.offset + (btn.dataset.gcPage === "next" ? PAGE_SIZE : -PAGE_SIZE));
        load();
        return;
      }
      // Anywhere on a row opens the card in a window over the list; the number is a real link for "open in a new tab".
      const row = e.target.closest("tr[data-gc-row]");
      if (!row || e.target.closest("button, input")) return;
      const c = cards[Number(row.dataset.gcRow)];
      if (!c) return;
      e.preventDefault();
      showCard(c.id, reload);
    });

    loadTotals();
    await load();
    // #giftcards/<id>: the card's window over the list (a link from somewhere else on the admin).
    if (openId != null && stillOn(hash, root)) showCard(openId, reload);
  }

  // ---- Issue a gift card ------------------------------------------------------------------------------------
  function showIssue(onChanged) {
    const canEmail = !(typeof adminDesktopNoEmail_ === "function" && adminDesktopNoEmail_());
    const requestId = newRequestId_();   // one key for this window: a double click or a retry makes one card
    const modalOpts = { guard: true };   // switched off once the card is made, so Done and ✕ close without asking
    const { ov, close } = inventoryModal_("Issue gift card", `
      <form id="gcIssueForm" class="cust-form" data-need-form="${GC_FN}:edit" novalidate>
        <div class="cust-note">Makes a card with a balance, ready to spend. The number is shown once the card is made.</div>
        <div class="cust-grid">
          <label class="cust-field"><span>Amount ($)</span><input type="number" id="gcAmount" inputmode="decimal" step="0.01" min="1" max="1000000" placeholder="50.00" autocomplete="off"></label>
        </div>
        <div class="cust-grid">
          <label class="cust-field"><span>For (name, optional)</span><input type="text" id="gcRecipName" maxlength="200" autocomplete="off"></label>
          <label class="cust-field"><span>Their email (optional)</span><input type="email" id="gcRecipEmail" maxlength="200" autocomplete="off" placeholder="pat@example.com"></label>
        </div>
        <label class="cust-field"><span>Message (optional, up to ${MESSAGE_MAX} characters)</span><textarea id="gcMessage" rows="3" maxlength="${MESSAGE_MAX}"></textarea></label>
        <label class="cust-field"><span>Note (only you see it)</span><input type="text" id="gcNote" maxlength="200" autocomplete="off" placeholder="e.g. Paid by cash at the show"></label>
        ${canEmail ? `<label class="cust-check"><input type="checkbox" id="gcSend"> Email it to them now <span class="cust-note" style="display:inline;">(needs their email)</span></label>` : ""}
        <div class="cust-err" id="gcIssueErr" role="alert"></div>
        <div class="cust-dialog-actions">
          <button type="button" class="admin-btn admin-btn-secondary" id="gcIssueCancel" data-perm-keep>Cancel</button>
          <button type="submit" class="admin-btn" id="gcIssueSave">Issue card</button>
        </div>
      </form>
      <div id="gcIssued" hidden></div>`, 540, modalOpts);
    const $ = (sel) => ov.querySelector(sel);
    const err = $("#gcIssueErr");
    $("#gcIssueCancel").onclick = () => $("[data-modal-close]").click();
    $("#gcIssueForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fail = (msg, sel) => { err.textContent = msg; if (sel) try { $(sel).focus(); } catch (x) {} };
      const cents = toCents($("#gcAmount").value);
      if (!(cents >= 100 && cents <= AMOUNT_MAX_CENTS)) return fail("Enter an amount from $1 to $1,000,000.", "#gcAmount");
      const email = $("#gcRecipEmail").value.trim();
      if (email && !looksLikeEmail(email)) return fail("Enter a valid email address, or leave it blank.", "#gcRecipEmail");
      const send = !!($("#gcSend") && $("#gcSend").checked);
      if (send && !email) return fail("Enter their email address to email the card.", "#gcRecipEmail");
      const save = $("#gcIssueSave");
      save.disabled = true; err.textContent = "";
      try {
        const d = await adminApi_({ action: "issueGiftCard", amountCents: cents, recipientName: $("#gcRecipName").value.trim(), recipientEmail: email,
          message: $("#gcMessage").value.trim().slice(0, MESSAGE_MAX), note: $("#gcNote").value.trim(), sendEmail: send, requestId });
        const card = d && d.card && typeof d.card === "object" ? d.card : d || {};
        const code = grouped(d.code || card.code || "");
        // The form is replaced by the result, so the window can't send a second card; Done closes it.
        $("#gcIssueForm").hidden = true;
        modalOpts.guard = false;
        const box = $("#gcIssued");
        box.hidden = false;
        box.innerHTML = `<div class="gc-issued">
          <div class="gc-issued-h">Gift card ${escapeHtml(cardName(card))} for ${escapeHtml(adminMoney_(cents / 100))} is ready.</div>
          ${code ? `<div class="gc-code" id="gcIssuedCode" data-gc-code>${escapeHtml(code)}</div>
          <div class="cust-note">Give this number to the customer. It can be shown again from the card's window.</div>
          <div class="cust-dialog-actions"><button type="button" class="admin-btn admin-btn-secondary" id="gcCopy">Copy number</button></div>` : ""}
          ${send ? `<div class="cust-note">${d.emailSent === false ? "The email couldn't be sent. Use Resend on the card to try again." : "It was emailed to " + escapeHtml(email) + "."}</div>` : ""}
          <div class="cust-dialog-actions"><button type="button" class="admin-btn" id="gcIssuedDone">Done</button></div>
        </div>`;
        if (code) $("#gcCopy").onclick = () => copyText(code, "Card number copied.");
        $("#gcIssuedDone").onclick = () => $("[data-modal-close]").click();
        showToast("Gift card " + cardName(card) + " issued.");
        if (onChanged) onChanged();
      } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    });
  }

  // ---- One card ---------------------------------------------------------------------------------------------
  async function showCard(id, onChanged) {
    let card, ledger = [];
    async function fetchCard() {
      const d = await adminApi_({ action: "getGiftCard", id });
      card = d && (d.card || d.giftCard);
      if (!card) throw new Error("That gift card is gone.");
      ledger = Array.isArray(d.ledger) ? d.ledger : Array.isArray(card.ledger) ? card.ledger : [];
    }
    try { await fetchCard(); } catch (e) { showToast(e.message, true); if (onChanged) onChanged(); return; }
    let shown = "";   // the full number, once Show has asked for it; kept only while this window is open
    const canEdit = adminCan_(GC_FN, "edit"), canFull = adminCan_(GC_FN, "full");
    const { ov, close } = inventoryModal_(`Gift card ${escapeHtml(cardName(card))}`, `<div id="gcCardBody"></div>`, 640);
    const root = ov.querySelector("#gcCardBody");

    function draw() {
      const bal = dollarsOf(card, "balance"), initial = dollarsOf(card, "initial");
      const rows = ledger.map(l => {
        const delta = l.delta != null ? Number(l.delta) || 0 : (Number(l.deltaCents) || 0) / 100;
        return `<tr><td>${escapeHtml(l.at ? adminDateTime_(l.at) : "")}</td>
          <td>${escapeHtml(KIND[l.kind] || l.kind || "")}</td>
          <td class="cust-num${delta < 0 ? " gc-neg" : ""}">${delta < 0 ? "−" : "+"}${escapeHtml(adminMoney_(Math.abs(delta)))}</td>
          <td>${escapeHtml(l.orderId || "")}</td>
          <td>${escapeHtml(l.note || "")}</td>
          <td>${escapeHtml(l.by || "")}</td></tr>`;
      }).join("");
      root.innerHTML = `
        <div class="gc-summary">
          <div><div class="gc-bal">${escapeHtml(money(bal))}</div><div class="cust-note">left of ${escapeHtml(money(initial))}</div></div>
          <div>${statusTag(card)}</div>
        </div>
        <div class="gc-number">
          <span>Number</span>
          <span class="gc-code" data-gc-code>${escapeHtml(shown ? grouped(shown) : (card.codeMasked || "••••-••••-••••-" + (card.last4 || "")))}</span>
          ${shown ? `<button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" data-gc-do="copy">Copy</button>`
            : `<button type="button" class="admin-btn admin-btn-secondary admin-btn-sm" data-gc-do="show" data-need="${GC_FN}:edit" title="Shows the whole number. This is recorded in the activity log.">Show</button>`}
        </div>
        <dl class="gc-facts">
          ${card.recipientName || card.recipientEmail ? `<dt>For</dt><dd>${escapeHtml([card.recipientName, card.recipientEmail].filter(Boolean).join(" · "))}</dd>` : ""}
          ${card.buyerName || card.buyerEmail ? `<dt>From</dt><dd>${escapeHtml([card.buyerName, card.buyerEmail].filter(Boolean).join(" · "))}</dd>` : ""}
          ${card.message ? `<dt>Message</dt><dd class="gc-msg">${escapeHtml(card.message)}</dd>` : ""}
          ${card.note ? `<dt>Note</dt><dd>${escapeHtml(card.note)}</dd>` : ""}
          <dt>Issued</dt><dd>${escapeHtml(card.createdAt ? adminDateTime_(card.createdAt) : "")}${card.createdBy ? " by " + escapeHtml(card.createdBy) : ""}</dd>
          ${card.sourceOrderId ? `<dt>Bought with</dt><dd>Order <span class="dc-code">${escapeHtml(card.sourceOrderId)}</span> on the shop</dd>` : ""}
          ${card.voidedAt ? `<dt>Voided</dt><dd>${escapeHtml(adminDateTime_(card.voidedAt))}</dd>` : ""}
        </dl>
        <h4 class="dc-h">History</h4>
        ${rows ? `<div class="admin-table-wrap"><table class="stack-mobile cust-table gc-ledger">
          <thead><tr><th>When</th><th>What</th><th class="cust-num">Amount</th><th>Order</th><th>Note</th><th>By</th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : `<div class="cust-note">Nothing yet.</div>`}
        <div class="cust-err" id="gcCardErr" role="alert"></div>
        <div class="cust-dialog-actions">
          ${canFull && card.status !== "void" ? `<button type="button" class="admin-btn admin-btn-danger" data-gc-do="void" data-need="${GC_FN}:full">Void…</button>` : ""}
          ${canFull && card.status !== "void" ? `<button type="button" class="admin-btn admin-btn-secondary" data-gc-do="adjust" data-need="${GC_FN}:full">Adjust…</button>` : ""}
          ${canEdit && card.status !== "void" ? `<button type="button" class="admin-btn admin-btn-secondary" data-gc-do="resend" data-need="${GC_FN}:edit">Resend…</button>` : ""}
          <button type="button" class="admin-btn" data-gc-do="close" data-perm-keep>Close</button>
        </div>`;
    }
    draw();

    const say = (m) => { const e = root.querySelector("#gcCardErr"); if (e) e.textContent = m || ""; };
    // After a change: the card read again, and the list behind it.
    async function refreshed(msg) {
      try { await fetchCard(); draw(); } catch (e) { close(); }
      if (msg) showToast(msg);
      if (onChanged) onChanged();
    }

    root.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-gc-do]");
      if (!b) return;
      const what = b.dataset.gcDo;
      say("");
      if (what === "close") { ov.querySelector("[data-modal-close]").click(); return; }
      if (what === "copy") { copyText(grouped(shown), "Card number copied."); return; }
      if (what === "show") {
        b.disabled = true;
        try {
          const d = await adminApi_({ action: "revealGiftCardCode", id: card.id });
          shown = String(d.code || (d.card && d.card.code) || "");
          if (!shown) throw new Error("The number couldn't be shown.");
          draw();
        } catch (ex) { say(ex.message); b.disabled = false; }
        return;
      }
      if (what === "resend") {
        const email = await askText_(`Email gift card ${cardName(card)} to someone?\n\nThey get the number and how to use it.`, {
          label: "Email address", value: card.recipientEmail || "", inputMode: "email", confirmLabel: "Send",
          validate: (v) => looksLikeEmail(String(v).trim()) ? { value: String(v).trim() } : { error: "Enter a valid email address." } });
        if (email === null) return;
        b.disabled = true;
        try {
          const d = await adminApi_({ action: "resendGiftCard", id: card.id, email });
          showToast(d && d.emailSent === false ? "The email couldn't be sent." : "Gift card emailed to " + email + ".", !!(d && d.emailSent === false));
        } catch (ex) { say(ex.message); }
        b.disabled = false;
        return;
      }
      if (what === "adjust") {
        const bal = dollarsOf(card, "balance");
        const r = await askAdjust(bal);
        if (!r) return;
        b.disabled = true;
        try {
          await adminApi_({ action: "adjustGiftCard", id: card.id, deltaCents: r.deltaCents, note: r.note });
          await refreshed("Balance changed.");
        } catch (ex) { say(ex.message); b.disabled = false; }
        return;
      }
      if (what === "void") {
        const ans = await confirmModal_({ title: `Void gift card ${cardName(card)}?`, text: `Its ${money(dollarsOf(card, "balance"))} balance goes to $0.00 and it can't be spent again. This can't be undone.`,
          reason: "required", defaultReason: "", confirmLabel: "Void card", danger: true });
        if (!ans || !ans.ok) return;
        b.disabled = true;
        try {
          await adminApi_({ action: "voidGiftCard", id: card.id, note: ans.reason });
          await refreshed("Gift card voided.");
        } catch (ex) { say(ex.message); b.disabled = false; }
      }
    });
  }

  // Adjust: a signed amount (+ adds, − takes off) and a reason; the balance can't go below $0. Resolves
  // { deltaCents, note } or null when cancelled.
  function askAdjust(balance) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); };
      const { ov, close } = inventoryModal_("Adjust balance", `
        <form id="gcAdjForm" class="cust-form" novalidate>
          <div class="cust-note">The balance is ${escapeHtml(money(balance))} now. Type how much to add, or a minus sign and how much to take off (for example 10 or -10). It is written in the card's history with your reason.</div>
          <label class="cust-field"><span>Change by ($)</span><input type="text" id="gcAdjAmount" inputmode="decimal" autocomplete="off" placeholder="-10.00"></label>
          <label class="cust-field"><span>Reason (required)</span><input type="text" id="gcAdjNote" maxlength="200" autocomplete="off" placeholder="e.g. Customer lost part of it"></label>
          <div class="cust-err" id="gcAdjErr" role="alert"></div>
          <div class="cust-dialog-actions">
            <button type="button" class="admin-btn admin-btn-secondary" id="gcAdjCancel">Cancel</button>
            <button type="submit" class="admin-btn" id="gcAdjSave">Change balance</button>
          </div>
        </form>`, 460, { onClose: () => finish(null) });
      const $ = (sel) => ov.querySelector(sel);
      $("#gcAdjCancel").onclick = () => { close(); finish(null); };
      $("#gcAdjForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const raw = $("#gcAdjAmount").value.trim().replace(/^[+−]/, (s) => s === "−" ? "-" : "");
        const neg = raw.startsWith("-");
        const cents = toCents(neg ? raw.slice(1) : raw);
        const note = $("#gcAdjNote").value.trim();
        const err = (m, sel) => { $("#gcAdjErr").textContent = m; try { $(sel).focus(); } catch (x) {} };
        if (!(cents >= 1)) return err("Enter how much to add or take off, like 10 or -10.", "#gcAdjAmount");
        if (neg && cents > Math.round(balance * 100)) return err("That is more than the " + money(balance) + " on the card.", "#gcAdjAmount");
        if (!neg && Math.round(balance * 100) + cents > AMOUNT_MAX_CENTS) return err("That would take the balance over $1,000,000.", "#gcAdjAmount");
        if (!note) return err("Say why the balance is being changed.", "#gcAdjNote");
        close(); finish({ deltaCents: neg ? -cents : cents, note });
      });
      $("#gcAdjAmount").focus();
    });
  }

  // The one name admin.js calls (its route for #giftcards and #giftcards/<id>, after ensureGiftCardsPage_).
  window.renderGiftCards = function renderGiftCards(app, id) {
    const n = Number(id);
    return renderPage(app, id != null && id !== "" && Number.isInteger(n) && n > 0 ? n : null);
  };
})();
