// The customer's design-approval page (/?verify=<token>): it sits on a white card (the site's page
// background is dark, and the page's dark text used to sit straight on it), the Approve / Request
// changes choice is told to screen readers, the upload boxes can be reached by keyboard, and a
// failed upload or submit says why. Invented shop and order only.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const lum = (h) => { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const css = html.slice(html.indexOf("<style"), html.indexOf("</style>"));
const ruleBody = (sel) => { const m = css.match(new RegExp("(^|[\\s}])" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}")); return m ? m[2] : ""; };
const prop = (body, name) => { const m = body.match(new RegExp("(^|[;\\s])" + name + ":\\s*(#[0-9a-fA-F]{3,6})")); return m ? m[2] : null; };

async function page(verifyBody, uploadReply){
  const posts = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://shop.example.com/?verify=tok123", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes("/api/upload-verify")) return uploadReply();
        if (u.includes("/api/verify") && init && init.method === "POST") { posts.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ status: "ok" }) }; }
        if (u.includes("/api/verify")) return { ok: true, status: 200, json: async () => verifyBody };
        return { ok: true, status: 200, json: async () => ({ status: "ok", orgId: null }), text: async () => "{}" };
      };
      win.alert = () => {};
    } });
  await wait(250);
  return { w: dom.window, d: dom.window.document, posts };
}

(async () => {
  const body = { status: "ok", orderId: "ORD-1001", orgName: "Maple Street Rec", orgAccent: "#1d4ed8", verificationStatus: "pending", message: "Here is your logo on the front.", imageUrls: [] };
  const s = await page(body, async () => ({ ok: false, status: 413, json: async () => ({ status: "error", message: "That picture is too big — the limit is 10 MB." }) }));
  const card = s.d.querySelector("#app .dv");

  console.log("=== Readable on the dark page ===");
  ok("the page is drawn on a card", !!card && /Maple Street Rec/.test(card.textContent) && /ORD-1001/.test(card.textContent));
  const dv = ruleBody(".dv"), sub = ruleBody(".dv-sub");
  const bg = prop(dv, "background"), ink = prop(dv, "color");
  ok("…with a white background and dark text, not the page's dark background", bg === "#fff" && !!ink && contrast(ink, bg) >= 4.5);
  ok("…the order line and messages are AA on the card (4.5:1)", !!prop(sub, "color") && contrast(prop(sub, "color"), bg) >= 4.5 && contrast(prop(ruleBody(".dv-err"), "color") || "#b03a2e", bg) >= 4.5);
  const borderOf = (sel) => (ruleBody(sel).match(/border:\s*\dpx solid (#[0-9a-f]{3,6})/i) || [])[1] || "#fff";
  ok("…the choice buttons' and boxes' borders are at least 3:1 on white", contrast(borderOf(".dv-choice"), "#ffffff") >= 3 && contrast(borderOf(".dv-field"), "#ffffff") >= 3);
  ok("no inline dark-on-nothing text is left on the page", !s.d.querySelector('#app [style*="color:#1a1a1a"]') && !s.d.querySelector('#app [style*="color:#555"]'));

  console.log("\n=== Choosing Approve or Request changes ===");
  const approve = s.d.getElementById("dvApproveBtn"), revise = s.d.getElementById("dvRevisionBtn");
  ok("both choices start unpressed, in a named group", approve.getAttribute("aria-pressed") === "false" && revise.getAttribute("aria-pressed") === "false" && !!s.d.querySelector('.dv-choices[role="group"][aria-labelledby="dvChoiceLabel"]'));
  revise.click();
  ok("choosing Request changes marks it pressed and the other not", revise.getAttribute("aria-pressed") === "true" && approve.getAttribute("aria-pressed") === "false");
  ok("…and shows the changes box with a real label", s.d.getElementById("dvRevisionArea").style.display === "block" && !!s.d.querySelector('label[for="dvNote"]'));
  approve.click();
  ok("choosing Approve flips them", approve.getAttribute("aria-pressed") === "true" && revise.getAttribute("aria-pressed") === "false");
  ok("the pressed look comes from aria-pressed in the CSS (shop colour + readable text)", /\.dv-choice\[aria-pressed="true"\]\{[^}]*background:var\(--dv-accent/.test(css));

  console.log("\n=== Uploads and errors ===");
  const files = [...s.d.querySelectorAll('#dvRevisionArea input[type="file"]')];
  ok("each upload box is still in the page (not display:none), so the keyboard can reach it", files.length === 2 && files.every(f => f.style.display !== "none" && f.classList.contains("sr-only") && f.tabIndex !== -1));
  ok("…and is named for screen readers", files.every((f, i) => f.getAttribute("aria-label") === "Upload supporting image " + (i + 1)));
  ok("…and the Upload button shows the focus ring when the box has focus", /\.dv-upload input:focus-visible \+ span\{outline:2px solid/.test(css));
  ok("the error line is announced (role=alert)", s.d.getElementById("dvError").getAttribute("role") === "alert");
  ok("the upload status is announced", s.d.getElementById("dvCustImg1Status").getAttribute("aria-live") === "polite");
  const fake = { files: [new s.w.File(["x"], "a.png", { type: "image/png" })], dataset: { target: "dvCustImg1", token: "tok123" } };
  await s.w.handleCustVerifyUpload(fake);
  ok("a failed upload shows the server's reason, not just 'Failed'", s.d.getElementById("dvCustImg1Status").textContent === "That picture is too big — the limit is 10 MB." && s.d.getElementById("dvCustImg1Status").classList.contains("err"));

  const s2 = await page(body, async () => { throw new TypeError("Failed to fetch"); });
  await s2.w.handleCustVerifyUpload({ files: [new s2.w.File(["x"], "a.png", { type: "image/png" })], dataset: { target: "dvCustImg1", token: "tok123" } });
  ok("a dropped connection says to check the connection", /check your connection/.test(s2.d.getElementById("dvCustImg1Status").textContent));

  const s3 = await page(body, async () => ({ ok: true, status: 200, json: async () => ({ status: "ok", url: "https://img.example.com/u/1.png" }) }));
  await s3.w.handleCustVerifyUpload({ files: [new s3.w.File(["x"], "a.png", { type: "image/png" })], dataset: { target: "dvCustImg2", token: "tok123" } });
  ok("a good upload fills the link box and says so", s3.d.getElementById("dvCustImg2").value === "https://img.example.com/u/1.png" && /Uploaded/.test(s3.d.getElementById("dvCustImg2Status").textContent));
  s3.d.getElementById("dvRevisionBtn").click();
  s3.d.getElementById("dvNote").value = "Make the logo bigger.";
  await s3.w.dvSubmitResponse("tok123");
  ok("submitting still sends the choice, note and image", s3.posts.length === 1 && s3.posts[0].action === "revision" && s3.posts[0].note === "Make the logo bigger." && s3.posts[0].imageUrls[0] === "https://img.example.com/u/1.png");
  ok("…and the thank-you note is on the card", /Revision request sent/.test(s3.d.querySelector(".dv").textContent));

  console.log("\n=== A light shop colour ===");
  const s4 = await page({ ...body, orgAccent: "#fde047" }, async () => ({ ok: true, json: async () => ({}) }));
  const style = s4.d.querySelector(".dv").getAttribute("style");
  ok("a pale shop colour gets dark button text and a dark shop name (readable on white)", /--dv-accent-ink:#232323/.test(style) && /--dv-accent-text:#1a1a1a/.test(style));

  console.log("\n=== Bad link ===");
  const s5 = await page({ status: "error" }, async () => ({ ok: true, json: async () => ({}) }));
  const m = s5.d.querySelector("#app .dv .dv-msg.err");
  ok("an expired link's message is on the card and announced", !!m && /invalid or has expired/.test(m.textContent) && m.getAttribute("role") === "alert");

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
