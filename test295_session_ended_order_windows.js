// Local sale, Cancel item and Mark as paid keep their window open, with what was typed, until the server has
// answered. A session that ended asks to sign in and sends the same request again with the same key, so nothing is
// recorded twice; Cancel at the sign-in, or any other refusal, leaves the window open with the problem shown in it.
// Before, each window closed first: the answer came as a toast after everything typed was gone.
// jsdom with the real index.html + admin.js; fetch is answered per action. Invented data only.
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader } = require("jsdom");

const ok = (d, v) => console.log(d + ":", !!v);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 20));
const wait = async (f, n = 150) => { for (let i = 0; i < n && !f(); i++) await tick(10); return f(); };
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const EXPIRED = "Session expired — please log in again.";

(async () => {
  const adminJs = read("public/admin.js");
  const calls = [], sessions = [];
  const expire = {};           // action → how many of its next requests the server answers 401
  let refuse = null;           // { action, status, message }: that action's next request is refused once
  let gate = null;             // { action, open() }: that action's next answer waits until open() is called
  let drop = 0;                // how many of the next createLocalSale requests never reach the server
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) };
      win.fetch = async (url, opts) => {
        const b = opts && opts.body ? JSON.parse(opts.body) : {};
        const j = (x, status) => ({ ok: !status || status < 400, status: status || 200, json: async () => x, text: async () => JSON.stringify(x) });
        if (String(url).includes("/api/admin-session")) {
          sessions.push((opts && opts.method) || "GET");
          return opts.method === "DELETE" ? j({ status: "ok" }) : j({ status: "ok", session: "cookie", expires: new Date(Date.now() + 864e5).toISOString(), user: { email: "pat@example.test" } });
        }
        if (!b.action) return j({ status: "admin", business: {}, country: "US" });
        calls.push(b);
        if (b.action === "createLocalSale" && drop > 0) { drop--; throw new TypeError("Failed to fetch"); }
        if (gate && gate.action === b.action) { const g = gate; gate = null; await new Promise(res => { g.open = res; }); }
        if (expire[b.action] > 0) { expire[b.action]--; return j({ status: "error", message: EXPIRED }, 401); }
        if (refuse && refuse.action === b.action) { const r = refuse; refuse = null; return j({ status: "error", message: r.message }, r.status); }
        switch (b.action) {
          case "listOrgs": return j({ status: "ok", orgs: [{ orgId: "acme", name: "Example Club" }] });
          case "listProducts": return j({ status: "ok", products: [{ productId: "cap", name: "Club cap", type: "cap", pricingMode: "flat", flatPrice: 20, visible: true }] });
          case "getBlanks": return j({ status: "ok", blanks: [] });
          case "cancelLineItem": return j({ status: "ok", emailSent: true });
          case "markPaidManual": return j({ status: "ok", amountRecorded: 20 });
          case "createLocalSale": return j({ status: "ok", orderId: "ACME-LS-1" });
          default: return j({ status: "ok" });
        }
      };
    } });
  const w = dom.window, d = w.document;
  await tick(150);
  await w.loadAdminScript();
  const toasts = [];
  w.showToast = (m, bad) => toasts.push(String(m));
  // The page asks to sign in as it opens: that box is closed first, so every box below is one a window raised.
  await wait(() => d.getElementById("adminPassInput"));
  d.querySelector(".admin-pass-overlay .admin-pass-cancel").click();
  await tick(40);
  const signedIn = () => { w.eval('adminKey = "cookie";'); };   // (no shop list: the orders table isn't drawn here, so nothing is redrawn after a save)
  const signInBox = () => d.getElementById("adminPassInput");
  const signIn = async () => {
    if (!await wait(signInBox)) return false;
    d.getElementById("adminEmailInput").value = "pat@example.test";
    signInBox().value = "a password";
    d.getElementById("adminPassForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
    return true;
  };
  const cancelSignIn = async () => { if (!await wait(signInBox)) return false; signInBox().closest(".admin-pass-overlay").querySelector(".admin-pass-cancel").click(); return true; };
  const reset = () => { if (signInBox()) throw new Error("a sign-in box was already open"); calls.length = 0; sessions.length = 0; toasts.length = 0; refuse = null; gate = null; drop = 0;
    for (const k of Object.keys(expire)) delete expire[k]; };
  const sentOf = (action) => calls.filter(c => c.action === action);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const confirmWin = () => d.querySelector(".confirm-modal");
  const esc = () => d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  // ---------------------------------------------------------------------------------------------------------------
  console.log("=== Cancel item ===");
  signedIn(); reset(); expire.cancelLineItem = 1;
  let acting = w.cancelLineItem("acme", 41, "Club tee (M)", 18);
  await wait(confirmWin);
  d.getElementById("cmReason").value = "Ordered twice — same as the one before";
  d.getElementById("cmOk").click();
  let asked = await signIn();
  ok("Cancel item: an ended session opens the sign-in box, with the window still open behind it and the reason in it", asked && !!confirmWin() &&
    d.getElementById("cmReason").value === "Ordered twice — same as the one before" && toasts.every(t => !/Cancel failed/.test(t)));
  await acting; await tick();
  let sent = sentOf("cancelLineItem");
  ok("…after signing in, the same cancel is sent again, unchanged", sent.length === 2 && same(sent[0], sent[1]) && sent[1].sheetRow === 41 && sent[1].reason === "Ordered twice — same as the one before" && !!sent[1].at);
  ok("…and the window closes as done: \"Item canceled. Customer notified by email.\"", !confirmWin() && toasts.includes("Item canceled. Customer notified by email."));

  signedIn(); reset(); expire.cancelLineItem = 1;
  acting = w.cancelLineItem("acme", 41, "Club tee (M)", 18);
  await wait(confirmWin);
  d.getElementById("cmReason").value = "A reason typed before the session ended";
  d.getElementById("cmOk").click();
  asked = await cancelSignIn();
  await wait(() => /session ended/.test((d.getElementById("cmSubmitErr") || {}).textContent || ""));
  ok("Cancel item, sign-in cancelled: the window is still there with the reason typed", asked && !!confirmWin() && d.getElementById("cmReason").value === "A reason typed before the session ended");
  ok("…it says nothing was cancelled and to sign in; its buttons work again", /^Nothing was cancelled: your session ended\. Press Cancel item again and sign in\.$/.test(d.getElementById("cmSubmitErr").textContent) &&
    !d.getElementById("cmOk").disabled && !d.getElementById("cmCancel").disabled && sentOf("cancelLineItem").length === 1 && !toasts.some(t => /Item canceled/.test(t)));
  d.getElementById("cmOk").click();
  asked = await signIn();
  await acting; await tick();
  ok("…pressing Cancel item again asks to sign in, then cancels with the reason that was typed", asked && sentOf("cancelLineItem").length === 2 &&
    sentOf("cancelLineItem")[1].reason === "A reason typed before the session ended" && !confirmWin() && toasts.includes("Item canceled. Customer notified by email."));

  signedIn(); reset(); refuse = { action: "cancelLineItem", status: 400, message: "That month is closed." };
  acting = w.cancelLineItem("acme", 41, "Club tee (M)", 18);
  await wait(confirmWin);
  d.getElementById("cmReason").value = "Out of stock";
  d.getElementById("cmOk").click();
  await wait(() => (d.getElementById("cmSubmitErr") || {}).textContent);
  ok("Cancel item, any other refusal: shown in the window, which stays open with the reason", !!confirmWin() && d.getElementById("cmSubmitErr").textContent === "Cancel failed: That month is closed." &&
    d.getElementById("cmSubmitErr").style.display !== "none" && d.getElementById("cmReason").value === "Out of stock" && !signInBox());
  d.getElementById("cmCancel").click();
  await acting;
  ok("…Keep it then closes it, and nothing more is sent", !confirmWin() && sentOf("cancelLineItem").length === 1 && !toasts.some(t => /Item canceled/.test(t)));

  signedIn(); reset(); gate = { action: "cancelLineItem" };
  { const g = gate;
    acting = w.cancelLineItem("acme", 41, "Club tee (M)", 18);
    await wait(confirmWin);
    d.getElementById("cmOk").click();
    await wait(() => g.open);
    d.getElementById("cmOk").click(); esc(); confirmWin().querySelector("[data-modal-close]").click();
    await tick(30);
    ok("while the request is on its way the window can't be closed and a second press sends nothing", !!confirmWin() && d.getElementById("cmOk").disabled && d.getElementById("cmCancel").disabled && sentOf("cancelLineItem").length === 1);
    g.open(); await acting; await tick();
    ok("…and it closes once the server has answered", !confirmWin() && toasts.includes("Item canceled. Customer notified by email.")); }

  // ---------------------------------------------------------------------------------------------------------------
  console.log("\n=== Mark as paid ===");
  signedIn(); reset(); expire.markPaidManual = 1;
  acting = w.markOrderPaid("acme", "ORD-7");
  await wait(confirmWin);
  d.getElementById("cmOk").click();
  asked = await signIn();
  ok("Mark as paid: an ended session opens the sign-in box, with the window still open behind it", asked && !!confirmWin() && toasts.every(t => !/Could not mark as paid/.test(t)));
  await acting; await tick();
  sent = sentOf("markPaidManual");
  ok("…after signing in, the same request is sent again with the same key, so the payment is booked once", sent.length === 2 && same(sent[0], sent[1]) && /^[0-9a-f]{32}$/.test(sent[1].requestId) &&
    sent[1].orderId === "ORD-7" && !!sent[1].at);
  ok("…and the window closes as done", !confirmWin() && !toasts.some(t => /Could not/.test(t)));

  signedIn(); reset(); expire.markPaidManual = 1;
  acting = w.markOrderPaid("acme", "ORD-8");
  await wait(confirmWin);
  { const when = d.getElementById("cmWhen"); when.value = "2026-11-02T09:30"; }
  d.getElementById("cmOk").click();
  asked = await cancelSignIn();
  await wait(() => /session ended/.test((d.getElementById("cmSubmitErr") || {}).textContent || ""));
  ok("Mark as paid, sign-in cancelled: the window is still there with the time that was picked", asked && !!confirmWin() && d.getElementById("cmWhen").value === "2026-11-02T09:30" &&
    /^Nothing was recorded: your session ended\. Press Mark again and sign in\.$/.test(d.getElementById("cmSubmitErr").textContent) && sentOf("markPaidManual").length === 1);
  const firstKey = sentOf("markPaidManual")[0].requestId;
  d.getElementById("cmOk").click();
  asked = await signIn();
  await acting; await tick();
  sent = sentOf("markPaidManual");
  ok("…pressing Mark again asks to sign in, then sends it with the same key and the picked time", asked && sent.length === 2 && sent[1].requestId === firstKey && sent[1].at === sent[0].at && !confirmWin());

  signedIn(); reset(); refuse = { action: "markPaidManual", status: 403, message: "Your role can't do this. Ask an admin." };
  acting = w.markOrderPaid("acme", "ORD-9");
  await wait(confirmWin);
  d.getElementById("cmOk").click();
  await wait(() => (d.getElementById("cmSubmitErr") || {}).textContent);
  ok("Mark as paid, any other refusal: shown in the window, which stays open (and nobody is signed out)", !!confirmWin() &&
    d.getElementById("cmSubmitErr").textContent === "Could not mark as paid: Your role can't do this. Ask an admin." && !signInBox() && w.eval("adminKey") === "cookie");
  d.getElementById("cmCancel").click();
  await acting;
  ok("…a second order can be marked while nothing is on its way (the double-click guard was let go)", await (async () => { reset(); const again = w.markOrderPaid("acme", "ORD-9");
    await wait(confirmWin); d.getElementById("cmOk").click(); await again; return sentOf("markPaidManual").length === 1 && !confirmWin(); })());

  // ---------------------------------------------------------------------------------------------------------------
  console.log("\n=== Local sale ===");
  const form = () => d.getElementById("localSaleForm");
  const openSale = async (name) => {
    signedIn(); reset();
    const p = w.createLocalSale("acme");
    await wait(form);
    const sel = d.getElementById("lsProduct"); sel.value = "cap"; sel.dispatchEvent(new w.Event("change", { bubbles: true }));
    d.getElementById("lsName").value = name;
    d.getElementById("lsQty").value = "3";
    d.getElementById("lsPayment").value = "Cash";
    calls.length = 0;
    return { done: p };
  };
  const record = () => form().querySelector(".admin-pass-submit").click();
  const saleErr = () => { const e = d.getElementById("lsErr"); return e && e.style.display !== "none" ? e.textContent : ""; };

  acting = (await openSale("Walk-in Pat")).done;
  expire.createLocalSale = 1;
  record();
  asked = await signIn();
  ok("Local sale: an ended session opens the sign-in box, with the window still open behind it and everything typed in it", asked && !!form() && d.getElementById("lsName").value === "Walk-in Pat" &&
    d.getElementById("lsQty").value === "3" && toasts.every(t => !/Could not record/.test(t)));
  await acting; await tick();
  sent = sentOf("createLocalSale");
  ok("…after signing in, the same sale is sent again with the same key, so one order is made", sent.length === 2 && same(sent[0], sent[1]) && /^[0-9a-f]{32}$/.test(sent[1].requestId) &&
    sent[1].customerName === "Walk-in Pat" && sent[1].items.length === 1 && sent[1].items[0].qty === 3 && sent[1].sendInvoice === undefined);
  ok("…and the window closes as done: \"Local sale recorded — <id>\"", !form() && toasts.includes("Local sale recorded — ACME-LS-1"));

  acting = (await openSale("Typed before the session ended")).done;
  expire.createLocalSale = 1;
  record();
  asked = await cancelSignIn();
  await wait(saleErr);
  ok("Local sale, sign-in cancelled: the window is still there with what was typed", asked && !!form() && d.getElementById("lsName").value === "Typed before the session ended" &&
    d.getElementById("lsQty").value === "3" && d.getElementById("lsPayment").value === "Cash");
  ok("…it says nothing was recorded and to sign in; its buttons work again", saleErr() === "Nothing was recorded: your session ended. Press Record sale again and sign in." &&
    !form().querySelector(".admin-pass-submit").disabled && !form().querySelector(".admin-pass-cancel").disabled && sentOf("createLocalSale").length === 1 && !toasts.some(t => /Local sale recorded/.test(t)));
  const saleKey = sentOf("createLocalSale")[0].requestId;
  record();
  asked = await signIn();
  await acting; await tick();
  sent = sentOf("createLocalSale");
  ok("…pressing Record sale again asks to sign in, then records it with the same key", asked && sent.length === 2 && sent[1].requestId === saleKey && sent[1].customerName === "Typed before the session ended" &&
    !form() && toasts.includes("Local sale recorded — ACME-LS-1"));

  acting = (await openSale("Walk-in Lee")).done;
  refuse = { action: "createLocalSale", status: 400, message: "That month is closed." };
  record();
  await wait(saleErr);
  ok("Local sale, any other refusal: shown in the window, which stays open with what was typed", !!form() && saleErr() === "Could not record local sale: That month is closed." &&
    d.getElementById("lsName").value === "Walk-in Lee" && !signInBox() && !toasts.some(t => /Could not record/.test(t)));
  record();
  await acting; await tick();
  sent = sentOf("createLocalSale");
  ok("…fixed and pressed again: recorded, still under this window's one key", sent.length === 2 && sent[0].requestId === sent[1].requestId && !form() && toasts.includes("Local sale recorded — ACME-LS-1"));

  acting = (await openSale("Walk-in Sam")).done;
  drop = 1;
  record();
  await acting; await tick();
  sent = sentOf("createLocalSale");
  ok("Local sale: a dropped connection is still tried once more with the same key", sent.length === 2 && sent[0].requestId === sent[1].requestId && !form() && toasts.includes("Local sale recorded — ACME-LS-1"));
  acting = (await openSale("Walk-in Kim")).done;
  drop = 2;
  record();
  await wait(saleErr);
  ok("…and when the server can't be reached at all, the window stays open saying so", !!form() && saleErr() === "Could not reach the server." && d.getElementById("lsName").value === "Walk-in Kim");
  form().querySelector(".admin-pass-cancel").click();
  await acting;

  acting = (await openSale("Walk-in Ray")).done;
  gate = { action: "createLocalSale" };
  { const g = gate;
    record();
    await wait(() => g.open);
    record(); esc(); form().querySelector(".admin-pass-cancel").click();
    await tick(30);
    ok("while the sale is on its way the window can't be closed and a second press sends nothing", !!form() && form().querySelector(".admin-pass-submit").disabled && sentOf("createLocalSale").length === 1);
    g.open(); await acting; await tick();
    ok("…and it closes once the server has answered", !form() && toasts.includes("Local sale recorded — ACME-LS-1")); }
  process.exit(0);
})().catch(e => { console.error(e); console.log("test295 crashed: false"); process.exit(1); });
