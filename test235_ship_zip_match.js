// A carrier rate is priced for one ZIP, and the server refuses an order whose address has another.
// The storefront's address box now says so before sending (with the typed address kept), and remembers
// the address if the customer cancels to get new rates. On the invoice page, changing the ZIP after the
// rates are shown drops those rates and asks for new ones. Invented shop, people and addresses only.
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, VirtualConsole } = require("jsdom");
const html = storefrontPage();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const catalog = { status: "ok", orgId: "league", country: "US", catalog: { name: "League", eyebrow: "", accent: "#123456", ready: true, desc: "", designImages: { shirt: "", cap: "", detail: "" },
  enabledPayments: ["Venmo"], salesTaxRate: 0, shippingEnabled: true, deliveryOptions: [{ id: "shipping", type: "shipping", label: "Shipping", fee: null }], graphics: [],
  products: [{ id: "tee", type: "shirt", name: "Tee", sub: "", images: [], features: [], sizePricing: { M: 20 }, personalizationPrice: null, weightOz: 6 }] } };

async function shop(){
  const sent = [], shipAsks = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://league.example.com/", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    beforeParse(win){
      win.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes("/api/orders")) { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ status: "ok" }) }; }
        if (u.includes("/api/shipping")) { const b = JSON.parse(init.body); shipAsks.push(b.zip);
          return { ok: true, status: 200, json: async () => ({ status: "ok", manualShipping: false, rates: [{ provider: "USPS", service: "Ground", amount: 8.99, quoteToken: "q-" + b.zip }] }) }; }
        return { ok: true, status: 200, json: async () => catalog, text: async () => JSON.stringify(catalog) };
      };
      win.alert = () => {};
    } });
  await wait(200);
  return { w: dom.window, d: dom.window.document, sent, shipAsks };
}

(async () => {
  console.log("=== Storefront address box ===");
  const s = await shop();
  s.d.querySelector('[data-action="add"][data-pid="tee"]').click();
  // Rates for 45503; the customer picks one.
  await s.w.eval(`shippingZip = "45503"; fetchShippingQuote()`);
  const rate = s.d.querySelector('input[name="shippingChoice"]');
  rate.checked = true; rate.dispatchEvent(new s.w.Event("change", { bubbles: true }));
  ok("rates were asked for the typed ZIP and remembered as the quoted one", s.shipAsks[0] === "45503" && s.w.eval("shippingQuotedZip") === "45503");
  s.d.getElementById("custName").value = "Robin Vale"; s.d.getElementById("custContact").value = "robin@example.com";
  const pay = s.d.getElementById("custPaymentMethod"); if (pay) pay.value = "Venmo";
  s.d.querySelector('[data-action="place-order"]').click();
  await wait(30);
  const $ = (id) => s.d.getElementById(id);
  ok("placing the order opens the address box with the quoted ZIP", !!$("shipLine1") && $("shipZip").value === "45503");
  $("shipLine1").value = "12 Elm Lane"; $("shipLine2").value = "Unit 3"; $("shipCity").value = "Springfield"; $("shipState").value = "OH"; $("shipZip").value = "45504";
  $("shipConfirmBtn").click();
  await wait(30);
  ok("a different ZIP is caught in the box, before anything is sent", /priced for ZIP 45503/.test($("shipAddrError").textContent) && /Cancel/.test($("shipAddrError").textContent) && s.sent.length === 0);
  ok("…the box stays open with the address still typed, and the ZIP marked", !!$("shipLine1") && $("shipLine1").value === "12 Elm Lane" && $("shipZip").getAttribute("aria-invalid") === "true" && s.d.activeElement === $("shipZip"));
  $("shipCancelBtn").click();
  await wait(30);
  ok("Cancel closes it without sending", !$("shipLine1") && s.sent.length === 0);
  s.d.querySelector('[data-action="place-order"]').click();
  await wait(30);
  ok("opening it again keeps the street address, city and state", $("shipName").value === "Robin Vale" && $("shipLine1").value === "12 Elm Lane" && $("shipLine2").value === "Unit 3" && $("shipCity").value === "Springfield" && $("shipState").value === "OH");
  ok("…and offers the ZIP the rate was priced for", $("shipZip").value === "45503");
  $("shipConfirmBtn").click();
  await wait(300);
  const order = s.sent.find(b => b.orderId);
  ok("with the matching ZIP the order goes through with that address and quote", !!order && order.shippingAddress.zip === "45503" && order.shippingAddress.line1 === "12 Elm Lane" && order.shippingQuoteToken === "q-45503");
  ok("once the order is saved the remembered address is dropped", s.w.eval("lastShipAddr_") === null);

  // A pickup / custom-quote shop with no carrier rate: no ZIP check (manual shipping isn't priced by ZIP).
  const s2 = await shop();
  const p2 = s2.w.eval(`collectShippingAddress("")`); await wait(20);
  const $2 = (id) => s2.d.getElementById(id);
  $2("shipName").value = "Robin Vale"; $2("shipLine1").value = "12 Elm Lane"; $2("shipCity").value = "Springfield"; $2("shipState").value = "OH"; $2("shipZip").value = "45504";
  $2("shipConfirmBtn").click();
  const got = await p2;
  ok("without a carrier rate any valid ZIP is accepted as before", !!got && got.zip === "45504");

  console.log("\n=== Invoice page ZIP box ===");
  const invoice = { status: "ok", invoice: { orderId: "LEAG-1001", orgId: "league", orgName: "League", accent: "#123456", paid: false, items: [{ productId: "tee", name: "Tee", size: "M", qty: 1, unitPrice: 20, lineTotal: 20 }],
    subtotal: 20, total: 20, balance: 20, payments: ["Card"], delivery: { options: [{ id: "shipping", type: "shipping", label: "Shipping", fee: null }], quotable: true, chosen: false, locked: false } } };
  const posts = [];
  const idom = new JSDOM(html, { runScripts: "dangerously", url: "https://league.example.com/?invoice=" + "a".repeat(32), pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    beforeParse(win){
      win.fetch = async (url, init) => {
        const u = String(url);
        if (u.startsWith("/api/invoice?")) return { ok: true, status: 200, json: async () => invoice };
        if (u === "/api/invoice") { posts.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => invoice }; }
        if (u === "/api/shipping") { const b = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ status: "ok", rates: [{ provider: "USPS", service: "Ground", amount: 7.5, quoteToken: "q-" + b.zip }] }) }; }
        return { ok: true, status: 200, json: async () => ({ status: "error" }) };
      };
    } });
  await wait(250);
  const w = idom.window, d = w.document, el = (id) => d.getElementById(id);
  const shipRadio = d.querySelector('input[name="invDelivery"][value="ship"]');
  ok("the invoice page offers shipping", !!shipRadio);
  if (shipRadio) {
    shipRadio.checked = true; shipRadio.dispatchEvent(new w.Event("change"));
    el("invAName").value = "Robin Vale"; el("invALine1").value = "12 Elm Lane"; el("invACity").value = "Springfield"; el("invAState").value = "OH"; el("invAZip").value = "45503";
    el("invRatesBtn").click(); await wait(60);
    ok("rates are shown for the ZIP", d.querySelectorAll('input[name="invRate"]').length === 1);
    const zip = el("invAZip"); zip.focus(); zip.value = "45504"; zip.dispatchEvent(new w.Event("input", { bubbles: true }));
    ok("changing the ZIP drops those rates and asks for new ones", d.querySelectorAll('input[name="invRate"]').length === 0 && /ZIP changed/.test(el("invDelErr").textContent) && el("invRatesBtn").textContent === "Show shipping options");
    ok("…without redrawing the form, so the cursor stays in the ZIP box and the address is kept", d.activeElement === zip && el("invALine1").value === "12 Elm Lane");
    el("invSaveDelivery").click(); await wait(60);
    ok("saving now asks for rates first, and sends nothing", posts.length === 0 && /Show shipping options/.test(el("invDelErr").textContent));
    el("invRatesBtn").click(); await wait(60);
    const r = d.querySelector('input[name="invRate"]'); r.checked = true; r.dispatchEvent(new w.Event("change"));
    el("invSaveDelivery").click(); await wait(60);
    ok("after new rates the save sends the new ZIP with its own quote", posts.length === 1 && posts[0].quoteToken === "q-45504" && posts[0].shippingAddress.zip === "45504");
  }

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
