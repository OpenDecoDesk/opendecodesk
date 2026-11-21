// The order panel is redrawn on every quantity change, delivery or payment choice and rate update, and
// the invoice page on every rate lookup and save. A keyboard user used to land back at the top of the
// page each time; now focus (and the text cursor) stays on the same control after the redraw.
// Invented shop, people and addresses only.
const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");
const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const catalog = { status: "ok", orgId: "league", country: "US", catalog: { name: "League", eyebrow: "", accent: "#123456", ready: true, desc: "", designImages: { shirt: "", cap: "", detail: "" },
  enabledPayments: ["Venmo", "Zelle"], salesTaxRate: 0, shippingEnabled: false, graphics: [],
  deliveryOptions: [{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }, { id: "cmeet00001", type: "custom", label: "Delivery at practice", fee: 0 }, { id: "chand00001", type: "custom", label: "Hand delivery", fee: 5 }],
  products: [{ id: "tee", type: "shirt", name: "Tee", sub: "", images: [], features: [], sizePricing: { M: 20 }, personalizationPrice: null, weightOz: 6 },
             { id: "cap", type: "cap", name: "Cap", sub: "", images: [], features: [], sizePricing: { OSFA: 15 }, personalizationPrice: null, weightOz: 4 }] } };

(async () => {
  console.log("=== Order panel ===");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://league.example.com/", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => catalog, text: async () => JSON.stringify(catalog) }); win.alert = () => {}; } });
  await wait(200);
  const w = dom.window, d = w.document;
  const panel = () => d.getElementById("ticketPanel");
  const q = (sel) => panel().querySelector(sel);
  d.querySelector('[data-action="add"][data-pid="tee"]').click();
  d.querySelector('[data-action="add"][data-pid="cap"]').click();
  ok("two lines in the cart", panel().querySelectorAll(".cart-line").length === 2);

  let plus = q('[data-action="qty"][data-idx="0"][data-d="1"]');
  plus.focus(); plus.click();
  let now = d.activeElement;
  ok("pressing + keeps focus on that line's + (a new button after the redraw)", now !== plus && now.getAttribute("data-action") === "qty" && now.getAttribute("data-idx") === "0" && now.getAttribute("data-d") === "1" && /2/.test(panel().querySelector(".l-qty span").textContent));
  d.activeElement.click(); d.activeElement.click();
  ok("…and again, so + can be pressed over and over from the keyboard", d.activeElement.getAttribute("data-idx") === "0" && d.activeElement.getAttribute("data-d") === "1" && w.eval("cart[0].qty") === 4);

  let rm = q('[data-action="remove"][data-idx="0"]');
  rm.focus(); rm.click();
  ok("removing a line puts focus on the remove button of the line now in its place", d.activeElement.getAttribute("data-action") === "remove" && d.activeElement.getAttribute("data-idx") === "0" && /Cap/.test(d.activeElement.getAttribute("aria-label")));
  d.activeElement.click();
  ok("removing the last line keeps focus in the order panel (not the top of the page)", w.eval("cart.length") === 0 && panel().contains(d.activeElement) && d.activeElement !== d.body);

  d.querySelector('[data-action="add"][data-pid="tee"]').click();
  const radio = (v) => [...panel().querySelectorAll('input[name="shippingChoice"]')].find(r => r.value.endsWith(v));
  const r3 = radio("chand00001"); r3.focus(); r3.checked = true; r3.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("choosing a delivery option keeps focus on that option", d.activeElement !== r3 && d.activeElement.name === "shippingChoice" && d.activeElement.value === r3.value && d.activeElement.checked);

  let sel = d.getElementById("custPaymentMethod");
  sel.focus(); sel.value = "Zelle"; sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("choosing how to pay keeps focus on the payment list", d.activeElement.id === "custPaymentMethod" && d.activeElement.value === "Zelle");

  const nameBox = d.getElementById("custName");
  nameBox.focus(); nameBox.value = "Robin Vale"; nameBox.setSelectionRange(3, 3);
  w.eval("renderTicket(currentOrg, currentOrgId)");   // e.g. shipping rates arriving while typing
  ok("a redraw while typing keeps focus and the cursor in the name box", d.activeElement.id === "custName" && d.activeElement !== nameBox && d.activeElement.value === "Robin Vale" && d.activeElement.selectionStart === 3);

  d.activeElement.blur();
  const before = d.activeElement;
  w.eval("renderTicket(currentOrg, currentOrgId)");
  ok("a redraw doesn't grab focus when it was outside the panel", d.activeElement === before && !panel().contains(d.activeElement));

  console.log("\n=== Invoice page ===");
  const invoice = { status: "ok", invoice: { orderId: "LEAG-1001", orgId: "league", orgName: "League", accent: "#123456", paid: false, items: [{ productId: "tee", name: "Tee", size: "M", qty: 1, unitPrice: 20, lineTotal: 20 }],
    subtotal: 20, total: 20, balance: 20, payments: ["Card"], delivery: { options: [{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }, { id: "shipping", type: "shipping", label: "Shipping", fee: null }], quotable: true, chosen: false, locked: false } } };
  const idom = new JSDOM(html, { runScripts: "dangerously", url: "https://league.example.com/?invoice=" + "a".repeat(32), pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    beforeParse(win){
      win.fetch = async (url, init) => {
        const u = String(url);
        if (u.startsWith("/api/invoice?")) return { ok: true, status: 200, json: async () => invoice };
        if (u === "/api/shipping") { await new Promise(r => setTimeout(r, 40)); const b = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ status: "ok", rates: [{ provider: "USPS", service: "Ground", amount: 7.5, quoteToken: "q-" + b.zip }] }) }; }
        return { ok: true, status: 200, json: async () => ({ status: "error" }) };
      };
    } });
  await wait(250);
  const iw = idom.window, id = iw.document, el = (x) => id.getElementById(x);
  const ship = id.querySelector('input[name="invDelivery"][value="ship"]');
  ship.checked = true; ship.dispatchEvent(new iw.Event("change"));
  el("invAName").value = "Robin Vale"; el("invALine1").value = "12 Elm Lane"; el("invACity").value = "Springfield"; el("invAState").value = "OH"; el("invAZip").value = "45503";
  el("invRatesBtn").focus(); el("invRatesBtn").click();
  await wait(5);
  ok("while rates load (button disabled), focus waits on the control just before it", el("invRatesBtn").disabled && id.activeElement === el("invAZip"));
  await wait(120);
  ok("once the rates are in, focus is back on the rates button", !el("invRatesBtn").disabled && id.activeElement === el("invRatesBtn") && id.querySelectorAll('input[name="invRate"]').length === 1);
  el("invSaveDelivery").focus(); el("invSaveDelivery").click();
  await wait(30);
  ok("saving without a rate shows the error and keeps focus on Save", /Choose one of the shipping options/.test(el("invDelErr").textContent) && id.activeElement === el("invSaveDelivery"));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
