// The roll-up takes at most 200 orders (review round 2). getOrdersForDigest read every order after the cursor and
// loaded all of them in full: after weeks without a roll-up email (email not set up, a broken key) that could run
// the Worker out of time or memory, so the roll-up never went out and the backlog only grew. Now one roll-up takes
// the OLDEST 200 after the cursor (test and voided ones it passes over count too), the cursor stops at the last one
// taken so the rest are the next roll-up's, and the email says "N more orders — see Orders" with the admin link.
// Real SQL (sql.js), the real migrations, db.js, email.js and daily-digest.js; invented data.
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { getOrdersForDigest, setDigestState, getDigestState };")();
const digest = new Function(strip(read("functions/_lib/http.js")) + "\n" +
  "function timingSafeEqual(a, b){ return typeof a === 'string' && a === b; }\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const checkSupplierShipments = async () => ({ checked: 0, errors: [] });\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" + strip(read("functions/api/daily-digest.js")) +
  "\nreturn { runDailyDigest };")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t')");
  // 230 orders written one second apart (insertedAt drives the roll-up), every tenth a test order; one item each.
  const base = Date.parse("2026-11-20T08:00:00.000Z");
  const at = (i) => new Date(base + i * 1000).toISOString();
  const id = (i) => "R" + String(i).padStart(3, "0");
  const tx = ["BEGIN"];
  for (let i = 1; i <= 230; i++) {
    tx.push(`INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, placedAt, insertedAt, isTest) VALUES ('${id(i)}', 'acme', 'Cust ${i}', 'c${i}@example.test', 'Venmo', '${at(i)}', '${at(i)}', ${i % 10 === 0 ? 1 : 0})`);
    tx.push(`INSERT INTO order_items (orderId, orgId, name, type, size, qty, unitPriceCents, lineTotalCents) VALUES ('${id(i)}', 'acme', 'Polo', 'shirt', 'L', 1, 2000, 2000)`);
  }
  tx.push("COMMIT");
  d1._raw.exec(tx.join(";\n"));
  const start = { afterInsertedAt: at(0), afterOrderId: "", sentAt: "" };

  console.log("=== One roll-up takes the oldest 200 ===");
  // Count what is read: the cursor query's LIMIT and every order id loaded in full.
  const binds = [];
  const db = { prepare: (sql) => { const st = d1.prepare(sql); const wrap = (b) => Object.assign({}, b, { bind: (...a) => { binds.push({ sql, a }); return wrap(b.bind(...a)); } }); return wrap(st); },
    batch: (s) => d1.batch(s) };
  const a = await lib.getOrdersForDigest(db, start);
  const cursorQuery = binds.find(b => /WHERE insertedAt > \? OR \(insertedAt = \? AND orderId > \?\)/.test(b.sql) && /LIMIT \?/.test(b.sql));
  ok("the cursor query is limited to 200 rows", !!cursorQuery && cursorQuery.a[3] === 200);
  ok("180 real orders from the first 200 written (20 test ones passed over), oldest first", a.orders.length === 180 && a.orders[0].orderId === "R001" && a.orders[a.orders.length - 1].orderId === "R199");
  ok("the cursor stops at the 200th written, not the newest", a.cursor.afterInsertedAt === at(200) && a.cursor.afterOrderId === "R200");
  ok("`more` counts the real orders still waiting after it (201–230, three of them test orders)", a.more === 27);
  const b = await lib.getOrdersForDigest(d1, { ...a.cursor, sentAt: "x" });
  ok("the next roll-up takes the rest, and nothing more is waiting", b.orders.length === 27 && b.orders[0].orderId === "R201" && b.more === 0 && b.cursor.afterOrderId === "R230");
  const c = await lib.getOrdersForDigest(d1, { ...b.cursor, sentAt: "x" });
  ok("…and after that, nothing (the cursor stays)", c.orders.length === 0 && c.more === 0 && c.cursor.afterOrderId === "R230");
  ok("together the two roll-ups report every real order exactly once", new Set([...a.orders, ...b.orders].map(o => o.orderId)).size === 207);

  console.log("\n=== The email says how many more ===");
  await lib.setDigestState(d1, start);
  const emails = [];
  global.fetch = async (url, init) => { if (captureMail(url, init, emails)) return MAIL_OK; return { ok: true, json: async () => ({}) }; };
  const env = { DB: d1, ROOT_DOMAIN: "shop.example.test", ...MAIL_ENV };
  let res = await digest.runDailyDigest(env, "manual");
  let body = JSON.parse(await res.text());
  ok("sent with 180 orders, 27 more waiting", res.status === 200 && body.sent === true && body.orders === 180 && body.more === 27);
  const e = emails[0];
  ok("the email says \"27 more orders — see Orders\", linking the admin's Orders page", /27 more orders — see Orders/.test(e.body) && /https:\/\/admin\.shop\.example\.test\/#orders/.test(e.body) &&
    /<a href="https:\/\/admin\.shop\.example\.test\/#orders">27 more orders — see Orders<\/a>/.test(e.htmlBody));
  ok("the progress saved is the 200th order, so the rest come next time", (await lib.getDigestState(d1)).afterOrderId === "R200");
  res = await digest.runDailyDigest(env, "manual");
  body = JSON.parse(await res.text());
  ok("the next roll-up sends the other 27, with no \"more\" line", body.sent === true && body.orders === 27 && body.more === 0 && emails.length === 2 &&
    /R201/.test(emails[1].body) && !/more order/.test(emails[1].body) && !/R199/.test(emails[1].body));

  console.log("\n=== Communications shows the same ===");
  const orders = read("functions/api/orders.js"), admin = read("public/admin.js");
  ok("getPendingCommunications passes the count on, and the page says \"…and N more orders — see Orders\"",
    /\[\{ orders, more \}, notices/.test(orders) && /moreOrders: more \|\| 0/.test(orders) && /…and \$\{Number\(d\.moreOrders\)\} more order/.test(admin));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
