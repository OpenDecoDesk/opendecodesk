const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM } = require("jsdom");

// Toasts (public/storefront.js showToast, review #111): an error stays until it is dismissed, however long
// that takes; anything else goes by itself after 6–15 seconds depending on its length, and waits while the
// pointer or keyboard focus is on it. Every toast has a ✕ button named "Dismiss". The real page in jsdom,
// with the window's clock and timers replaced by a fake one so the test moves time on by hand.

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// A fake clock for the page: setTimeout/clearTimeout and Date.now, moved on with advance(ms).
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
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", url: "https://shop.example.test/", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window, d = w.document;
  await new Promise(r => setTimeout(r, 100));
  const clock = fakeClock(w);
  const toasts = () => [...d.querySelectorAll("#toastRegion .toast")];
  const has = (text) => toasts().some(t => t.dataset.message === text);
  const clear = () => toasts().forEach(t => t.remove());

  console.log("=== An error stays until it is dismissed ===");
  w.showToast("Not saved: the server didn't answer", true);
  clock.advance(60_000);
  ok("still there a minute later", has("Not saved: the server didn't answer"));
  clock.advance(10 * 60_000);
  ok("…and ten minutes after that", has("Not saved: the server didn't answer"));
  const err = toasts()[0];
  ok("its text is the message alone (the ✕ draws its mark from the style sheet)", err.textContent === "Not saved: the server didn't answer");
  const x = err.querySelector("button.toast-close");
  ok("it has a ✕ button named Dismiss", !!x && x.getAttribute("aria-label") === "Dismiss" && x.type === "button");
  x.click();
  ok("the ✕ dismisses it", !has("Not saved: the server didn't answer"));

  console.log("\n=== A success goes by itself: 6 s, longer for longer text, at most 15 s ===");
  w.showToast("Saved.", false);
  clock.advance(5_900);
  ok("a short one is there at 5.9 s", has("Saved."));
  clock.advance(200);
  ok("…and gone at 6.1 s", !has("Saved."));
  const mid = "x".repeat(150);   // 150 × 60 ms = 9 s
  w.showToast(mid, false);
  clock.advance(8_900);
  ok("150 characters: there at 8.9 s", has(mid));
  clock.advance(200);
  ok("…gone at 9.1 s", !has(mid));
  const long = "y".repeat(1000);   // 60 s by length, capped at 15 s
  w.showToast(long, false);
  clock.advance(14_900);
  ok("a very long one: there at 14.9 s", has(long));
  clock.advance(200);
  ok("…gone at 15.1 s (the cap)", !has(long));
  ok("the length rule: clamp(6000, 60 ms × length, 15000)", w.toastDuration_("ab") === 6000 && w.toastDuration_("z".repeat(200)) === 12000 && w.toastDuration_("z".repeat(400)) === 15000);

  console.log("\n=== It waits while the pointer or focus is on it ===");
  w.showToast("Order recorded.", false);
  let t = toasts().find(e => e.dataset.message === "Order recorded.");
  clock.advance(3_000);
  t.dispatchEvent(new w.MouseEvent("mouseenter"));
  clock.advance(30_000);
  ok("hovered: still there 30 s later", has("Order recorded."));
  t.dispatchEvent(new w.MouseEvent("mouseleave"));
  clock.advance(2_900);
  ok("after the pointer leaves, the rest of its time runs (3 s left): there at 2.9 s", has("Order recorded."));
  clock.advance(200);
  ok("…gone at 3.1 s", !has("Order recorded."));
  w.showToast("Copied.", false);
  t = toasts().find(e => e.dataset.message === "Copied.");
  t.querySelector(".toast-close").dispatchEvent(new w.FocusEvent("focusin", { bubbles: true }));
  clock.advance(60_000);
  ok("keyboard focus on its ✕: still there a minute later", has("Copied."));
  t.querySelector(".toast-close").dispatchEvent(new w.FocusEvent("focusout", { bubbles: true }));
  clock.advance(6_100);
  ok("…and goes once focus leaves", !has("Copied."));

  console.log("\n=== Clicking a toast still dismisses it ===");
  w.showToast("Done.", false);
  toasts()[0].click();
  ok("a click on the toast itself", !has("Done."));
  clear();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); console.log("crashed: false"); process.exitCode = 1; });
