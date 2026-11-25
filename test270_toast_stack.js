const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM } = require("jsdom");

// Toasts (public/storefront.js showToast, review #111), how they stack: an error is announced as an alert;
// the same error again isn't shown twice; no more than three are on screen (the oldest goes); and a new
// screen (the address's #… changing) clears the errors left from the one before — except one shown just
// before the change, which is its reason. The real page in jsdom with a fake clock (as test269).

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

function fakeClock(w) {
  let now = 1_000_000, seq = 0;
  const timers = new Map();
  w.setTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + (Number(ms) || 0) }); return id; };
  w.clearTimeout = (id) => { timers.delete(id); };
  w.Date.now = () => now;
  return {
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
}

(async () => {
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", url: "https://admin.example.test/#orders", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window, d = w.document;
  await new Promise(r => setTimeout(r, 100));
  const clock = fakeClock(w);
  const toasts = () => [...d.querySelectorAll("#toastRegion .toast")];
  const texts = () => toasts().map(t => t.dataset.message);
  const clear = () => toasts().forEach(t => t.remove());
  // jsdom queues hashchange on the window's own timer when the hash is set, so the fake clock lets it fire.
  const goTo = async (hash) => { let fired = false; w.addEventListener("hashchange", () => { fired = true; }, { once: true }); w.location.hash = hash; clock.advance(0); await new Promise(r => setTimeout(r, 0)); if (!fired) throw new Error("no hashchange"); };

  console.log("=== An error is an alert; a success isn't ===");
  w.showToast("Couldn't delete: it's in use", true);
  w.showToast("Saved.", false);
  ok("the error toast has role=alert", toasts()[0].getAttribute("role") === "alert" && toasts()[0].classList.contains("toast-error"));
  ok("the success toast has no role of its own (the region is a status)", !toasts()[1].hasAttribute("role") && d.getElementById("toastRegion").getAttribute("role") === "status");
  clear();

  console.log("\n=== The same error isn't stacked ===");
  w.showToast("Not saved: Simulated server error", true);
  w.showToast("Not saved: Simulated server error", true);
  w.showToast("Not saved: Simulated server error", true);
  ok("clicked three times, shown once", texts().filter(t => t === "Not saved: Simulated server error").length === 1);
  w.showToast("Not saved: another reason", true);
  ok("a different error does stack", texts().length === 2);
  w.showToast("Saved.", false); w.showToast("Saved.", false);
  ok("a success repeated is shown each time (it goes by itself)", texts().filter(t => t === "Saved.").length === 2);
  clear();

  console.log("\n=== At most three on screen ===");
  w.showToast("Error one", true);
  w.showToast("Error two", true);
  w.showToast("Note three", false);
  w.showToast("Note four", false);
  ok("a fourth pushes out the oldest", texts().join("|") === "Error two|Note three|Note four");
  w.showToast("Error five", true);
  ok("…and a fifth the next oldest", texts().join("|") === "Note three|Note four|Error five");
  clear();

  console.log("\n=== A new screen clears the errors left from the last one ===");
  w.showToast("Couldn't load the blanks", true);
  w.showToast("Order recorded.", false);
  clock.advance(5_000);
  await goTo("#settings");
  ok("going to another screen takes the old error away", !texts().includes("Couldn't load the blanks"));
  ok("…and leaves a success to go by itself", texts().includes("Order recorded."));
  clock.advance(20_000);
  ok("…which it does", texts().length === 0);
  w.showToast("That order is gone — back to Orders", true);
  await goTo("#orders");
  ok("an error shown just before the screen changes stays (it is the reason for the change)", texts().includes("That order is gone — back to Orders"));
  clock.advance(2_000);
  await goTo("#catalog");
  ok("…until the next change after that", texts().length === 0);

  console.log("\n=== The style sheet ===");
  const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");
  ok("the ✕ draws its mark in CSS and has room in the toast", /\.toast-close::before\{content:"\\00d7";\}/.test(html) && /\.toast\{[^}]*padding-right:36px/.test(html));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); console.log("crashed: false"); process.exitCode = 1; });
