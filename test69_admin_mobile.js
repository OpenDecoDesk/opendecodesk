// Admin on a phone: below 760px the Orders page shows one card per order instead of the
// 31-column table (same buttons, same .order-select checkboxes for the bulk bar, in-place updates
// rebuild the card), the header is a "☰ Menu" sheet, the Manage catalog org/product tables stack
// into cards, the product form's blank links fit the width, and Designs shows the list OR the open
// design. Desktop keeps the table. jsdom with the real index.html + admin.js; matchMedia is stubbed
// (jsdom has none), fetch is mocked per action.
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader } = require("jsdom");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");

const day = 864e5, iso = (d) => new Date(Date.now() - d * day).toISOString();
const item = (row, name, type, size, qty, price, extra) => Object.assign({ sheetRow: row, productId: "p" + row, name, type, size, qty, unitPrice: price, lineTotal: price * qty, personalized: false, persName: "", cancelDate: null }, extra || {});
const order = (orderId, cust, d, items, extra) => Object.assign({ orderId, customerName: cust, contact: "c@x.com", placedAt: iso(d), items, paymentMethod: "Card", paid: true,
  discountAmount: 0, discountNote: "", balanceDue: 0, amountReceived: 1, shippingCost: 0, shippingMethod: "", receivedEmailAt: iso(d), confirmedEmailAt: null,
  blankOrderedAt: null, blankReceivedAt: null, manufacturedAt: null, digitizingCompleteAt: null, designApprovedAt: null, qaPackedAt: null, shippedAt: null, deliveredAt: null,
  completedAt: null, trackingNumber: "", labels: [], shippingAddress: null, voidedAt: null, isTest: false }, extra || {});

async function boot(width){
  const adminJs = read("public/admin.js");
  const listeners = [], sent = [];
  const orders = [
    order("PRIME-2", "Sam <b>Gamgee</b>", 1, [item(1, "Polo", "shirt", "L", 2, 32), item(2, "Cap", "cap", "", 1, 24, { personalized: true, persName: "SAM" })], { paid: false, paymentMethod: "Venmo", balanceDue: 88, amountReceived: 0 }),
    order("PRIME-1", "Frodo", 3, [item(3, "Quarter-zip", "sweatshirt", "M", 1, 48), item(4, "Cap", "cap", "", 1, 24, { cancelDate: iso(2), cancelReason: "Changed mind" })],
      { blankOrderedAt: iso(2), qaPackedAt: iso(1), labels: [{ trackingNumber: "9400", voidedAt: null }], discountAmount: 5, discountNote: "Club" }),
  ];
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.__width = width;
      win.CSS = win.CSS || { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) }; // jsdom has no CSS.escape
      win.matchMedia = (q) => { const m = /max-width:\s*(\d+)px/.exec(q); return { get matches(){ return m ? win.__width <= Number(m[1]) : false; }, media: q,
        addEventListener: (_, fn) => listeners.push(fn), removeEventListener(){} }; };
      win.fetch = async (url, opts) => {
        const b = opts && opts.body ? JSON.parse(opts.body) : {};
        if (b.action) sent.push(b);
        const ok = (o) => ({ ok: true, status: 200, json: async () => Object.assign({ status: "ok" }, o) });
        if (String(url).includes("/api/catalog")) return ok({ status: "admin" });
        switch (b.action) {
          case "getOrders": return ok({ orders: JSON.parse(JSON.stringify(b.org === "prime" ? orders : [])) });
          case "getOrdersByIds": return ok({ orders: JSON.parse(JSON.stringify(b.org === "prime" ? orders.filter(o => b.orderIds.includes(o.orderId)) : [])) });
          case "getOrdersAllShops": return ok({ shops: [{ orgId: "prime", name: "Example League", orders: JSON.parse(JSON.stringify(orders)), verifications: [] }] });
          case "listDesignVerifications": return ok({ verifications: [] });
          case "getBlanks": return ok({ blanks: [{ id: 1, name: "ST520", productType: "shirt", sizes: [{ size: "L", quantity: 2 }] }] });
          case "getBlankLinks": return ok({ links: [] });
          case "listOrgsAdmin": return ok({ orgs: [{ orgId: "prime", subdomain: "prime", name: "Example League", ready: true }] });
          case "listProducts": return ok({ products: [{ productId: "polo", type: "shirt", name: "Polo", pricingMode: "sized", sizePricing: { S: 30, L: 32 }, visible: true }] });
          case "listDesigns": return ok({ designs: [{ id: 1, name: "Crest", hoopId: null }] });
          case "getDesign": return ok({ design: { id: 1, name: "Crest" }, versions: [] });
          case "listHoops": return ok({ hoops: [] });
          case "listThreads": return ok({ threads: [] });
          default: return ok({});
        }
      };
    } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{orgId:"prime", name:"Example League"}, {orgId:"rec", name:"REC"}]; window._ordersFilter = {from:"", to:""};');
  return { w, app: w.document.getElementById("app"), listeners, orders, sent, tick: (ms = 40) => new Promise(res => setTimeout(res, ms)) };
}

(async () => {
  try {
    const css = storefrontPage();

    console.log("=== Orders on a phone: cards, not the table ===");
    let { w, app, listeners, orders, sent, tick } = await boot(375);
    w.renderAdminOrders(app, { orgId: "prime", name: "Example League" });
    await tick(80);
    const cards = () => [...app.querySelectorAll(".order-card")];
    console.log("one card per order and no table:", cards().length === 2 && !app.querySelector(".orders-table-wrap table"));
    const c2 = cards().find(c => c.dataset.orderCard === "PRIME-2");
    console.log("the card shows customer (escaped), order #, total, unpaid and the balance due:",
      c2.querySelector(".oc-name").textContent.includes("Sam <b>Gamgee</b>") && !c2.querySelector(".oc-name b") &&
      /PRIME-2/.test(c2.textContent) && /\$88\.00/.test(c2.querySelector(".oc-total").textContent) && /Unpaid/.test(c2.textContent) && /Balance due \$88\.00/.test(c2.textContent));
    console.log("items list qty × name · size and the personalization:", /2 × Polo/.test(c2.textContent) && /· L/.test(c2.textContent) && /“SAM”/.test(c2.textContent));
    console.log("the same action buttons as the table row:", !!c2.querySelector('.oc-actions button[data-admin-action="markOrderPaid"]') && !!c2.querySelector('.oc-actions button[data-admin-action="showPaymentsModal"]'));
    const c1 = cards().find(c => c.dataset.orderCard === "PRIME-1");
    console.log("status chip is the latest stage reached, and a bought label isn't shown as shipped:",
      /QA & packed/.test(c1.querySelector(".oc-status").textContent) && /Label created, not shipped/.test(c1.querySelector(".oc-status").textContent));
    console.log("a cancelled line is struck through with its cancel note; discount shown:",
      !!c1.querySelector(".oc-item-cancelled s") && /Changed mind/.test(c1.textContent) && /Discount/.test(c1.textContent));
    console.log("every stage and both emails are under Progress & emails:",
      ["“Order received” email", "“Payment received” email", "Blank ordered", "Design approved", "Verification sent", "Manufactured", "Shipped", "Delivered", "Completed"].every(k => [...c1.querySelectorAll(".oc-more dt")].some(dt => dt.textContent === k)) &&
      !c1.querySelector(".oc-more td"));

    console.log("\n=== Bulk selection works with cards ===");
    c2.querySelector(".order-select").click();
    console.log("ticking a card shows the bulk bar and getSelectedOrderIds sees it:", w.document.getElementById("bulkBar").style.display === "" && JSON.stringify(w.getSelectedOrderIds()) === '["PRIME-2"]');
    w.document.getElementById("selectAllOrders").click();
    console.log("Select all ticks every order:", w.getSelectedOrderIds().length === 2);
    console.log("the bulk bar floats at the bottom of a phone screen:", /\.bulk-bar\{position:fixed; left:8px; right:8px; bottom:8px;/.test(css));

    console.log("\n=== In-place updates rebuild the card ===");
    const applied = w.applyOrderUpdate("prime", "PRIME-2", { paid: true, blankOrderedAt: new Date().toISOString() }, { orgId: "prime", name: "Example League" });
    const c2b = cards().find(c => c.dataset.orderCard === "PRIME-2");
    console.log("applyOrderUpdate refreshes the card (no table-row fallback):", applied === true && /Blank ordered/.test(c2b.querySelector(".oc-status").textContent) && /Paid/.test(c2b.textContent));
    console.log("…and keeps it ticked:", c2b.querySelector(".order-select").checked === true);
    const cached = w._ordersCache.prime.find(o => o.orderId === "PRIME-2");
    w.updateOrderCache("prime", "PRIME-2", Object.assign({}, cached, { discountAmount: 3, discountNote: "Loyalty" }));
    w.updateOrderTableRow("prime", "PRIME-2", w._ordersCache.prime.find(o => o.orderId === "PRIME-2"));
    console.log("updateOrderTableRow (payments/discount) refreshes the card too:", /Loyalty/.test(cards().find(c => c.dataset.orderCard === "PRIME-2").textContent));

    console.log("\n=== An action on one order redraws only its card (review #62) ===");
    const card = (id) => cards().find(c => c.dataset.orderCard === id);
    const p1 = card("PRIME-1"), p2 = card("PRIME-2");
    console.log("(PRIME-2 still ticked):", p2.querySelector(".order-select").checked === true);
    Object.assign(orders[0], { discountAmount: 4, discountNote: "Team rate", balanceDue: 84 });
    sent.length = 0;
    await w.refreshOrderRows_("prime", ["PRIME-2"]);
    console.log("one request, for that order alone (no list reload):", JSON.stringify(sent.map(b => b.action)) === '["getOrdersByIds"]' && JSON.stringify(sent[0].orderIds) === '["PRIME-2"]');
    console.log("…its card is rebuilt with the change, still ticked, and flashes; the other card is the same element:",
      card("PRIME-2") !== p2 && /Team rate/.test(card("PRIME-2").textContent) && card("PRIME-2").querySelector(".order-select").checked === true &&
      card("PRIME-2").classList.contains("row-flash") && card("PRIME-1") === p1 && !p1.classList.contains("row-flash"));
    console.log("…the bulk bar still counts both ticked orders:", w.document.getElementById("bulkBar").style.display === "" && w.getSelectedOrderIds().slice().sort().join() === "PRIME-1,PRIME-2" &&
      /2 orders selected/.test(w.document.getElementById("bulkBarCount").textContent));
    // A new order, the newest: its card goes in first.
    orders.unshift(order("PRIME-3", "Merry", 0, [item(5, "Beanie", "cap", "", 1, 20)]));
    sent.length = 0;
    await w.refreshOrderRows_("prime", ["PRIME-3"]);
    console.log("a new order's card goes in first, the others untouched:", cards().map(c => c.dataset.orderCard).join() === "PRIME-3,PRIME-2,PRIME-1" &&
      card("PRIME-1") === p1 && sent.length === 1 && w._ordersCache.prime.length === 3);
    // Voided: the order now counts as cancelled, hidden unless "Include cancelled" is ticked.
    orders.find(o => o.orderId === "PRIME-1").voidedAt = new Date().toISOString();
    await w.refreshOrderRows_("prime", ["PRIME-1"]);
    console.log("a voided order's card leaves the list (cancelled are hidden), the cache keeps it:", !card("PRIME-1") && cards().length === 2 &&
      !!w._ordersCache.prime.find(o => o.orderId === "PRIME-1").voidedAt);
    // A miss: the server doesn't give the order back — the whole list is reloaded.
    sent.length = 0;
    await w.refreshOrderRows_("prime", ["PRIME-404"]);
    await tick(80);
    console.log("an order the server doesn't give back falls back to reloading the list:", sent[0].action === "getOrdersByIds" && sent.some(b => b.action === "getOrders") && cards().length === 2);
    orders.shift(); delete orders.find(o => o.orderId === "PRIME-1").voidedAt;
    Object.assign(orders[0], { discountAmount: 0, discountNote: "", balanceDue: 88 });
    await w.refreshOrdersInPlace_({ orgId: "prime", name: "Example League" });

    console.log("\n=== All shops on a phone ===");
    await w.renderOrdersPage(app);
    await tick(80);
    console.log("cards show the shop, and no checkboxes (bulk actions are single-shop):",
      cards().length === 2 && cards().every(c => /Example League/.test(c.textContent)) && !app.querySelector(".order-select") && !app.querySelector("#selectAllOrders"));

    console.log("\n=== Crossing the breakpoint re-renders ===");
    w.__width = 1280;
    w.location.hash = "#orders/prime";
    listeners.forEach(fn => fn());
    await tick(120);
    console.log("wider than 760px → the table again, no cards:", !!app.querySelector(".orders-table-wrap table") && cards().length === 0);

    console.log("\n=== Header on a phone ===");
    w.renderAdminNav();
    const nav = w.document.getElementById("adminNav");
    const sheet = nav.querySelector(".admin-nav-mobile .admin-nav-sheet");
    const sheetLabels = [...sheet.querySelectorAll(".admin-nav-btn")].map(b => b.textContent);
    console.log("a ☰ Menu bar whose sheet lists every page (top buttons + every group's items):",
      !!nav.querySelector(".admin-nav-menu-btn") && ["Orders", "Run Order", "Manage catalog", "Machines", "Global settings", "Blanks", "Expenses", "Audit log", "Sign out"].every(l => sheetLabels.includes(l)));
    console.log("it names the current page:", nav.querySelector(".admin-nav-current").textContent === "Orders");
    // Every button of the desktop row is in the sheet too (Run Transfer Sheets used to be missing on phones).
    const rowLabels = [...nav.querySelectorAll(".admin-nav-row > .admin-nav-btn")].map(b => b.textContent);
    console.log("every top-level desktop button is in the phone menu, Run Transfer Sheets included:", sheetLabels.includes("Run Transfer Sheets") && rowLabels.every(l => sheetLabels.includes(l)));
    nav.querySelector(".admin-nav-menu-btn").click();
    console.log("tapping Menu opens the sheet:", nav.querySelector(".admin-nav-mobile").classList.contains("open"));
    console.log("CSS swaps the button row for the Menu bar under 760px:", /#adminNav \.admin-nav-row\{display:none;\}/.test(css) && /\.admin-nav-mobile\{display:none;\}/.test(css));

    console.log("\n=== Manage catalog ===");
    ({ w, app, tick } = await boot(375));
    await w.renderAdminOrgList(app);
    await tick();
    const orgTable = app.querySelector("table.stack-mobile");
    console.log("the org list stacks into cards, every cell labelled:", !!orgTable && [...orgTable.querySelectorAll("tbody td")].every(td => td.dataset.label || td.classList.contains("stack-actions")));
    await w.renderProductList(app, "prime");
    await tick();
    console.log("the product list stacks too:", !!app.querySelector("table.stack-mobile td[data-label='Price']") && !!app.querySelector("td.stack-actions button"));
    console.log("CSS turns .stack-mobile rows into labelled cards:", /table\.stack-mobile thead\{display:none;\}/.test(css) && /td\[data-label\]::before\{content:attr\(data-label\)/.test(css));
    w._adminProductRegistry = { prime: [{ productId: "polo", type: "shirt", name: "Polo", pricingMode: "sized", sizePricing: { S: 30, L: 32 }, visible: true }] };
    w.renderProductForm(app, "prime", w._adminProductRegistry.prime[0]);
    await tick(80);
    console.log("the product form's blank links table fits a phone (its own grid layout):", !!app.querySelector("table.blank-links-table") && /\.blank-links-table tr\{display:grid;/.test(css));
    console.log("date fields get the form styling:", /\.admin-form input\[type=date\], \.admin-form textarea, \.admin-form select\{\n/.test(css));

    console.log("\n=== Designs: the list, or the open design ===");
    await w.renderDesigns(app, "prime", null);
    await tick();
    const layout = () => app.querySelector(".dsg-layout");
    console.log("no design open → the list, no back button:", !layout().classList.contains("dsg-has-open") && !app.querySelector(".dsg-back"));
    await w.renderDesigns(app, "prime", 1);
    await tick();
    console.log("a design open → marked so the phone hides the list, with ← All designs:", layout().classList.contains("dsg-has-open") && !!app.querySelector(".dsg-back[data-org='prime']"));
    console.log("CSS: one column on a phone, list hidden while a design is open; desktop keeps 260px + detail:",
      /\.dsg-layout\.dsg-has-open \.dsg-list-col\{display:none;\}/.test(css) && /\.dsg-layout\{display:grid; grid-template-columns:260px 1fr; gap:20px;\}/.test(css));

    console.log("\n=== Desktop is unchanged ===");
    ({ w, app, tick } = await boot(1280));
    w.renderAdminOrders(app, { orgId: "prime", name: "Example League" });
    await tick(80);
    console.log("the Orders table with every column, no cards:", app.querySelectorAll(".orders-table-wrap thead th").length === 33 && !app.querySelector(".order-card"));
  } catch (e) {
    console.log("test69 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
