// Carrier pickups and the morning roll-up (review round 2). The tracking check marks an order shipped once the
// carrier scans it and emails the customer their tracking. That news used to live only in the run's memory: when the
// roll-up email failed (and the retry an hour later no longer saw the order as "awaiting pickup"), or on a morning
// with no email set up, the owner was never told which orders went out, nor that a customer's "your order has
// shipped" email couldn't be sent. Now each pickup is queued as an owner notice (kind 'picked_up', migrations/0113),
// urgent when email is set up and the customer still couldn't be emailed, so it rides the next roll-up that goes out and is marked sent with
// the other notices; the roll-up's and Communications' "Picked up by the carrier" lists are built from these
// notices, so a pickup is never reported twice.
// Real SQL (sql.js), the real migrations, db.js, email.js, deliveryCheck.js, daily-digest.js and orders.js; Shippo
// and the email service are a mocked fetch; invented data.
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), emailSrc = strip(read("functions/_lib/email.js")), delSrc = strip(read("functions/_lib/deliveryCheck.js"));
const L = new Function(strip(read("functions/_lib/http.js")) + "\n" +
  "function timingSafeEqual(a, b){ return typeof a === 'string' && a === b; }\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const checkSupplierShipments = async () => ({ checked: 0, errors: [] });\n" +
  dbSrc + "\n" + emailSrc + "\n" + delSrc + "\n" + strip(read("functions/api/daily-digest.js")) +
  "\nreturn { runDailyDigest, insertOrder, recordShippingLabel, checkShippedDeliveries, getUnsentOwnerNotices };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + require("./testlib/roles").adminAs() + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  dbSrc + "\n" + emailSrc + "\n" + delSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const quiet = async (fn) => { const e = console.error, l = console.log; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.error = e; console.log = l; } };

// Shippo answers from `tracks`; the email service captures every message in `mail`, and refuses the roll-up while
// `rollUpFails` (customers' shipped emails still go out).
const tracks = {}, mail = [];
let rollUpFails = false;
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://api.goshippo.com/tracks/")) {
    const t = tracks[decodeURIComponent(u.split("/").pop())] || { tracking_status: { status: "UNKNOWN" } };
    return { ok: true, status: 200, json: async () => t };
  }
  const sink = [];
  if (captureMail(u, init, sink)) {
    if (rollUpFails && /^Daily roll-up/.test(sink[0].subject)) return { ok: false, status: 500, json: async () => ({ success: false, errors: [{ message: "service down" }] }), text: async () => "service down" };
    mail.push(sink[0]);
    return MAIL_OK;
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
};
const iso = (daysAgo, h = 12) => { const d = new Date(Date.now() - daysAgo * 86400000); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, ready, createdAt, updatedAt) VALUES ('club','club','Example Club',1,'t','t');`);
  const env = { DB: d1, SHIPPO_API_KEY: "k", ROOT_DOMAIN: "example.test", ...MAIL_ENV };
  // An order made 10 days ago (so the roll-up has no new orders: only the pickups can make it send), packed, with a label.
  const labeled = async (id, tracking, contact) => {
    await L.insertOrder(d1, { orderId: id, orgId: "club", customerName: "Cust " + id, contact, placedAt: iso(10),
      shippingAddress: { name: "Cust", line1: "1 Main", city: "Springfield", state: "OH", zip: "45505" } },
      [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
    d1._raw.run("UPDATE orders SET paid=1, blankOrderedAt=?, blankReceivedAt=?, digitizingCompleteAt=?, designApprovedAt=?, manufacturedAt=?, qaPackedAt=? WHERE orderId=?",
      [iso(9), iso(8), iso(8), iso(7), iso(6), iso(5), id]);
    await L.recordShippingLabel(d1, { orderId: id, shippoTransactionId: "tx_" + id, carrier: "USPS", service: "Ground Advantage", amount: 6, trackingNumber: tracking, labelUrl: "" });
    tracks[tracking] = { tracking_status: { status: "TRANSIT", status_date: iso(0, 9) }, tracking_history: [{ status: "TRANSIT", status_date: iso(1, 15) }] };
  };
  const notices = () => d1.q("SELECT orderId, kind, urgent, summary, detail, sentAt FROM owner_notices WHERE kind = 'picked_up' ORDER BY id");
  const run = async (e = env) => { const res = await quiet(() => L.runDailyDigest(e, "scheduled")); return { status: res.status, body: JSON.parse(await res.text()) }; };
  const rollUps = () => mail.filter(m => /^Daily roll-up/.test(m.subject) && !/nothing new/.test(m.subject));   // not the quiet-morning one

  console.log("=== A pickup is queued as an owner notice ===");
  await labeled("P1", "9400111", "p1@example.test");
  await labeled("P2", "9400222", "");            // no email address: the customer can't be told
  rollUpFails = true;
  const first = await run();
  ok("both orders were picked up and marked shipped", d1.q("SELECT COUNT(*) AS n FROM orders WHERE shippedAt IS NOT NULL AND orderId IN ('P1','P2')")[0].n === 2);
  const q = notices();
  ok("each is queued as a 'picked_up' notice, still unsent", q.length === 2 && q.every(x => x.sentAt === null) && q.map(x => x.orderId).join() === "P1,P2");
  ok("…saying who, carrier, tracking and the day", /^Cust P1 — USPS 9400111 picked up /.test(q[0].summary) && /emailed their tracking/.test(q[0].detail));
  ok("the customer who couldn't be emailed is urgent, and says what to do", q[1].urgent === 1 && q[0].urgent === 0 && /couldn't be sent\. Send them their tracking yourself/.test(q[1].detail));

  console.log("\n=== The roll-up email fails: nothing is lost ===");
  ok("the run failed (the scheduled tick tries again later)", first.status === 502 && rollUps().length === 0);
  ok("the notices are still waiting for the next roll-up", notices().every(x => x.sentAt === null));

  console.log("\n=== The retry sends them ===");
  rollUpFails = false;
  const second = await run();
  const email = rollUps()[0];
  ok("the next run sends the roll-up, though the orders are no longer awaiting pickup", second.status === 200 && second.body.sent === true && rollUps().length === 1);
  ok("it lists the pickup under 'Picked up by the carrier', with its type", /Picked up by the carrier — 1/.test(email.htmlBody) && /9400111/.test(email.htmlBody) && />Picked up</.test(email.htmlBody));
  const attention = email.htmlBody.slice(email.htmlBody.indexOf("Needs attention"), email.htmlBody.indexOf("Picked up by the carrier"));
  ok("the customer who couldn't be emailed is under 'Needs attention'", /9400222/.test(attention) && /Send them their tracking yourself/.test(attention));
  ok("each pickup appears once (never also from the run's own list)", (email.htmlBody.match(/USPS 9400111 picked up/g) || []).length === 1 && (email.htmlBody.match(/USPS 9400222 picked up/g) || []).length === 1
    && (email.body.match(/USPS 9400111 picked up/g) || []).length === 1);
  ok("the subject counts both pickups and the unsent email, and calls nothing a dispute",
    /2 picked up by carrier/.test(email.subject) && /⚠️ 1 shipped email not sent/.test(email.subject) && !/dispute/.test(email.subject));
  ok("the run's record counts the pickups it reported", second.body.pickedUp === 2);
  ok("they're marked sent with the other notices", notices().every(x => x.sentAt));
  const third = await run();
  ok("…so the next morning doesn't report them again", third.body.sent === false && rollUps().length === 1);

  console.log("\n=== No email set up: kept until it is ===");
  await labeled("P3", "9400333", "p3@example.test");
  const noMail = { DB: d1, SHIPPO_API_KEY: "k", ROOT_DOMAIN: "example.test" };
  const quietDay = await run(noMail);
  ok("the run checks tracking and sends nothing", quietDay.body.reason === "email not set up" && d1.q("SELECT shippedAt FROM orders WHERE orderId='P3'")[0].shippedAt !== null);
  ok("the pickup is queued, unsent, and not urgent (with no email set up at all, Setup status says so once; each pickup doesn't)",
    notices().filter(x => x.orderId === "P3" && x.sentAt === null).length === 1 && notices().find(x => x.orderId === "P3").urgent === 0
    && /Email isn't set up, so the customer wasn't emailed their tracking/.test(notices().find(x => x.orderId === "P3").detail));
  const later = await run();
  ok("the first roll-up once email is set up reports it", later.body.sent === true && /9400333/.test(rollUps()[1].htmlBody) && notices().every(x => x.sentAt));

  console.log("\n=== Picked up in the run that sends ===");
  await labeled("P5", "9400555", "p5@example.test");
  const same = await run();
  const e5 = rollUps()[2];
  ok("listed once, from its notice (the run's own list isn't added to it)", same.body.sent === true && /Picked up by the carrier — 1/.test(e5.htmlBody)
    && (e5.htmlBody.match(/USPS 9400555 picked up/g) || []).length === 1 && (e5.body.match(/USPS 9400555 picked up/g) || []).length === 1 && /1 picked up by carrier/.test(e5.subject));

  console.log("\n=== Communications ===");
  await labeled("P4", "9400444", "p4@example.test");
  const res = await api({ env, waitUntil: () => {},
    request: { url: "https://admin.example.test/api/orders", json: async () => ({ action: "getPendingCommunications", key: "x" }), headers: { get: () => null } } });
  const d = JSON.parse(await res.text());
  ok("the page's own tracking check queues the pickup, and it's among the notices the next roll-up will contain",
    d.status === "ok" && d.notices.some(x => x.kind === "picked_up" && x.orderId === "P4" && x.orgName === "Example Club"));
  ok("…and not also as a separate list (it would be shown twice)", !("pickedUp" in d));
  const admin = read("public/admin.js");
  const comms = admin.slice(admin.indexOf("const KIND = { payment: \"Payment\", refund: \"Refund\", dispute: \"Dispute\", design: \"Design response\""), admin.indexOf("const awaitingHtml"));
  ok("Communications labels the kind and builds 'Picked up by the carrier' from the notices", /picked_up: "Picked up"/.test(comms)
    && /const pickedUp = d\.notices\.filter\(x => !x\.urgent && x\.kind === "picked_up"\)/.test(comms) && /x\.kind !== "picked_up"/.test(comms) && /noticeTable\(pickedUp\)/.test(comms));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log("test350 crashed: false"); process.exit(1); });
