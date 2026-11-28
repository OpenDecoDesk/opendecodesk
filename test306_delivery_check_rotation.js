// The daily delivery check takes turns (review round 2). Both of its steps — labels the carrier hasn't scanned yet,
// and shipped orders waiting on a delivery — took the OLDEST first, every morning, with at most 40 lookups: with
// more than that waiting, the same oldest ones were looked up every day and the newer ones never were; and the
// pickup step could use nearly all 40, leaving the deliveries none. Now (orders.trackingCheckedAt, migrations/0108):
//   - each step takes the ones looked up longest ago first (never-looked-up first), and every lookup is stamped,
//     a failed one too, as blank shipments already do;
//   - the pickup step gets at most half of the run's lookups;
//   - shipments 90 days on (from shipping, or from the label when it never shipped) aren't looked up any more;
//     the roll-up lists them for a person to check by hand (the oldest 20, and how many in all).
// Real SQL (sql.js), the real migrations, db.js, deliveryCheck.js and email.js; Shippo and email answered here.
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const L = new Function(dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) +
  "\nreturn { insertOrder, recordShippingLabel, checkShippedDeliveries, getUnconfirmedShipments, getShippedAwaitingDelivery, getLabeledAwaitingShipment, sendDailyDigestEmail, sendDigestHeartbeatEmail, TRACKING_CHECK_DAYS };")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

let lookups = [], emails = [];
const tracks = {};
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://api.goshippo.com/tracks/")) {
    const num = decodeURIComponent(u.split("/").pop());
    lookups.push(num);
    if (tracks[num] instanceof Error) throw tracks[num];
    const t = tracks[num] || { status: "TRANSIT", status_date: daysAgo(1) };
    return { ok: true, json: async () => ({ tracking_status: t, tracking_history: t.status === "PRE_TRANSIT" ? [] : [{ status: t.status, status_date: t.status_date }] }) };
  }
  if (captureMail(url, init, emails)) return MAIL_OK;
  return { ok: true, json: async () => ({}) };
};

async function freshDb() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t')");
  return d1;
}
const order = (d1, orderId, placedDaysAgo = 20) => L.insertOrder(d1, { orderId, orgId: "acme", customerName: "Cust " + orderId, contact: orderId.toLowerCase() + "@example.test",
  paymentMethod: "Venmo", placedAt: daysAgo(placedDaysAgo) }, [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: 20 }]);
// Shipped `days` ago with its own tracking number "T-<id>".
const shipped = async (d1, id, days) => { await order(d1, id, days + 2); d1._raw.run("UPDATE orders SET shippedAt = ?, trackingNumber = ?, shippingMethod = 'USPS Ground Advantage' WHERE orderId = ?", [daysAgo(days), "T-" + id, id]); };
// A label bought `days` ago, not scanned yet.
const labeled = async (d1, id, days) => {
  await order(d1, id, days + 2);
  await L.recordShippingLabel(d1, { orderId: id, shippoTransactionId: "tx-" + id, carrier: "USPS", service: "Ground Advantage", amount: 6, trackingNumber: "T-" + id, labelUrl: "" });
  d1._raw.run("UPDATE shipping_labels SET purchasedAt = ? WHERE orderId = ?", [daysAgo(days), id]);
  tracks["T-" + id] = { status: "PRE_TRANSIT", status_date: "" };
};
const env = (d1) => ({ DB: d1, SHIPPO_API_KEY: "shippo_test_key", ...MAIL_ENV });
const stamp = (d1, id) => d1.q("SELECT trackingCheckedAt AS t FROM orders WHERE orderId = ?", id)[0].t;

(async () => {
  console.log("=== The column ===");
  ok("migrations/0108 adds orders.trackingCheckedAt, and schema.sql has it", /ALTER TABLE orders ADD COLUMN trackingCheckedAt TEXT;/.test(read("migrations/0108_order_tracking_checked.sql")) &&
    /\n  trackingCheckedAt   TEXT\s+-- migrations\/0108/.test(read("schema.sql")));

  console.log("\n=== Shipped orders take turns ===");
  {
    const d1 = await freshDb();
    for (let i = 1; i <= 8; i++) await shipped(d1, "S" + i, 20 - i);   // S1 shipped longest ago
    tracks["T-S3"] = new Error("Shippo down");
    lookups = [];
    let r = await L.checkShippedDeliveries(env(d1), { limit: 4 });
    const first = lookups.slice();
    ok("the first run looks up the four never looked up, oldest shipment first", first.join() === "T-S1,T-S2,T-S3,T-S4" && r.requests === 4);
    ok("each lookup is stamped on its order — the failed one too", ["S1", "S2", "S3", "S4"].every(id => stamp(d1, id)) && ["S5", "S6", "S7", "S8"].every(id => !stamp(d1, id)) && r.errors === 1);
    lookups = [];
    r = await L.checkShippedDeliveries(env(d1), { limit: 4 });
    ok("the next run looks up the other four (the old code looked up S1–S4 again)", lookups.join() === "T-S5,T-S6,T-S7,T-S8");
    lookups = [];
    await L.checkShippedDeliveries(env(d1), { limit: 4 });
    ok("…and then the ones looked up longest ago come round again", lookups.join() === "T-S1,T-S2,T-S3,T-S4");
    ok("in the reading itself: least recently looked up first, never-looked-up before all", /ORDER BY \(trackingCheckedAt IS NOT NULL\), trackingCheckedAt, shippedAt ASC/.test(dbSrc) &&
      /ORDER BY \(trackingCheckedAt IS NOT NULL\), trackingCheckedAt, COALESCE\(labelAt, ''\) ASC/.test(dbSrc));
  }

  console.log("\n=== Labels waiting for a scan get at most half the lookups ===");
  {
    const d1 = await freshDb();
    for (let i = 1; i <= 12; i++) await labeled(d1, "L" + String(i).padStart(2, "0"), 3);
    for (let i = 1; i <= 6; i++) await shipped(d1, "D" + i, 5);
    lookups = [];
    const r = await L.checkShippedDeliveries(env(d1), { limit: 10 });
    const pick = lookups.filter(n => /^T-L/.test(n)), dlv = lookups.filter(n => /^T-D/.test(n));
    ok("of 10 lookups, the labels get at most 5 (the old code used 9, leaving the deliveries 1)", pick.length > 0 && pick.length <= 5 && r.requests <= 10);
    ok("…and the shipped orders get the rest", dlv.length === 10 - pick.length && dlv.length >= 5);
    lookups = [];
    await L.checkShippedDeliveries(env(d1), { limit: 10 });
    ok("the next run goes on to labels not looked up yet", lookups.filter(n => /^T-L/.test(n)).every(n => !pick.includes(n)) && lookups.some(n => /^T-L/.test(n)));
  }

  console.log("\n=== After 90 days: no more lookups, listed for a person ===");
  {
    const d1 = await freshDb();
    ok("the check stops after 90 days", L.TRACKING_CHECK_DAYS === 90);
    await shipped(d1, "NEW", 10); await shipped(d1, "EDGE", 89);
    await shipped(d1, "OLD1", 120); await labeled(d1, "OLDLBL", 100);
    // A typed tracking number, never shipped and no label: dated by when it was placed.
    await order(d1, "OLDTYPED", 150); d1._raw.run("UPDATE orders SET trackingNumber = 'T-OLDTYPED' WHERE orderId = 'OLDTYPED'");
    await shipped(d1, "OLDDONE", 130); d1._raw.run("UPDATE orders SET deliveredAt = ? WHERE orderId = 'OLDDONE'", [daysAgo(125)]);
    lookups = [];
    await L.checkShippedDeliveries(env(d1), { limit: 40 });
    ok("shipments under 90 days are looked up", lookups.includes("T-NEW") && lookups.includes("T-EDGE"));
    ok("ones 90 days on (shipped, labeled, or typed and placed) aren't", !lookups.includes("T-OLD1") && !lookups.includes("T-OLDLBL") && !lookups.includes("T-OLDTYPED"));
    let u = await L.getUnconfirmedShipments(d1);
    ok("they're listed for a person, oldest first, with how many (delivered ones aren't)", u.count === 3 && u.orders.map(o => o.orderId).join() === "OLDTYPED,OLD1,OLDLBL" &&
      u.orders[1].shipped === true && u.orders[2].shipped === false && u.orders[1].tracking === "T-OLD1");
    for (let i = 1; i <= 24; i++) await shipped(d1, "X" + String(i).padStart(2, "0"), 100 + i);
    u = await L.getUnconfirmedShipments(d1);
    ok("the list is kept short: the oldest 20, and the count of all of them", u.count === 27 && u.orders.length === 20 && u.orders[0].orderId === "OLDTYPED");

    console.log("\n=== …in the roll-up ===");
    emails = [];
    const sent = await L.sendDailyDigestEmail(env(d1), { orders: [{ orderId: "N1", orgId: "acme", customerName: "Pat", items: [], total: 20, placedAt: daysAgo(0) }], unconfirmed: u });
    const e = emails[0];
    ok("the roll-up lists them under \"Shipments not confirmed after 90 days\", to check by hand", sent === true && /Shipments not confirmed after 90 days — 27/.test(e.htmlBody) &&
      /Check them by hand/.test(e.htmlBody) && /SHIPMENTS NOT CONFIRMED AFTER 90 DAYS — CHECK THEM BY HAND — 27/.test(e.body));
    ok("…20 of them by order, customer and tracking, then how many more", /OLD1 — Cust OLD1 — T-OLD1 \(shipped /.test(e.body) && /…and 7 more/.test(e.body) && /…and 7 more/.test(e.htmlBody));
    emails = [];
    await L.sendDigestHeartbeatEmail(env(d1), { unconfirmed: u });
    ok("the quiet-morning email mentions them too", /27 shipments not confirmed after 90 days — check them by hand/.test(emails[0].body));
    ok("the roll-up reads them (never a reason to send on its own)", /getUnconfirmedShipments\(env\.DB\)/.test(read("functions/api/daily-digest.js")) &&
      !/!unconfirmed/.test(read("functions/api/daily-digest.js")));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
