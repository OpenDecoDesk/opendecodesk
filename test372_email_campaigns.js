const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

// Email campaigns (migrations/0117) and the max discount (migrations/0116), on the REAL modules (functions/_lib/campaigns.js,
// db.js, email.js, public/campaign-render.js, functions/api/unsubscribe.js) over real SQL (sql.js):
//   - the migrations: schema.sql builds the same tables; 0116 and 0117 are additive
//   - a percent code's max discount: the math, the label, the checks, a list of codes and a code's own check
//   - the no-marketing list: checkout, unsubscribe, a reply, the owner — and what takes an address off it
//   - who a campaign goes to: shops, the last order (more than / less than N days or months, before a date), how many
//     orders, typed addresses, the opt-out list, test and voided orders left out
//   - the campaigns: save, copy, delete, schedule, send now with one code or a code each, the queue (batches, no double
//     send even with two runs at once, someone who unsubscribed meanwhile skipped), cancel, a scheduled one starting
//   - the email: the theme, the fill-ins (escaped), the cleaned text, the unsubscribe link (web) or reply line (desktop),
//     the banner picture (a link on the web, attached on the desktop), no copy to the receipts inbox
//   - /api/unsubscribe: a good link, a changed one, GET changes nothing, POST does
// Invented shops and people only.
const read = (f) => fs.readFileSync(__dirname + "/" + f, "utf8");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const db = await import("./functions/_lib/db.js");
  const C = await import("./functions/_lib/campaigns.js");
  const http = await import("./functions/_lib/http.js");
  const unsub = await import("./functions/api/unsubscribe.js");
  const R = globalThis.OddCampaignRender;

  console.log("=== The migrations ===");
  {
    const migrated = await createD1();
    migrated._raw.exec(read("testlib/schema-pre-0006.sql"));
    const files = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
    for (const f of files) migrated.execFile(read("migrations/" + f));
    const fresh = await createD1();
    fresh._raw.exec(read("schema.sql"));
    const shape = (d, t) => JSON.stringify(d.q(`PRAGMA table_info(${t})`).map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk]));
    for (const t of ["marketing_optouts", "email_campaigns", "email_campaign_recipients", "discount_codes"]) {
      ok(`${t}: schema.sql's table is the migrations', column for column`, shape(fresh, t) === shape(migrated, t) && shape(fresh, t) !== "[]");
    }
    const idx = (d) => d.q("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%campaign%'").map(r => r.name).sort().join();
    ok("…and the same campaign indexes", idx(fresh) === idx(migrated) && idx(fresh).split(",").length === 3);
    const before = await createD1();
    before._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of files) if (f < "0117") before.execFile(read("migrations/" + f));
    const objs = (d) => d.q("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
    const was = objs(before);
    before.execFile(read("migrations/0117_email_campaigns.sql"));
    const now = objs(before);
    ok("0117 only adds (three tables, three indexes), changing nothing that was there",
      same(now.filter(o => was.some(w => w.name === o.name)), was) && now.length - was.length === 6);
    ok("0116 adds one nullable column to discount_codes", /maxDiscountCents INTEGER CHECK/.test(read("migrations/0116_discount_max.sql")) && !/DROP|DELETE|UPDATE /i.test(read("migrations/0116_discount_max.sql")));
  }

  // A database from schema.sql with invented shops, customers and orders.
  const d1 = await createD1();
  d1._raw.exec(read("schema.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t0','t0'), ('works','works','Sample Works','t0','t0');`);
  const NOW = new Date("2026-11-27T15:00:00Z");
  const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
  let cid = 0;
  const person = (email, name, orders) => {
    cid++;
    d1._raw.exec(`INSERT INTO customers (id, name, email, createdAt, updatedAt) VALUES (${cid}, '${name}', '${email}', 't0', 't0')`);
    orders.forEach(([org, ago, extra], i) => d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, customerId${extra ? ", " + Object.keys(extra).join(", ") : ""})
      VALUES ('O-${cid}-${i}', '${org}', '${name}', '${email}', '${daysAgo(ago)}', ${cid}${extra ? ", " + Object.values(extra).map(v => typeof v === "string" ? `'${v}'` : v).join(", ") : ""})`));
    return cid;
  };
  person("ann@example.com", "Ann Able", [["club", 10], ["club", 200]]);          // 2 orders, last 10 days ago, club
  person("bo@example.com", "Bo Brown", [["works", 400]]);                        // 1 order, 400 days ago, works
  person("cy@example.com", "Cy Cole", [["club", 100], ["works", 50], ["works", 30]]);   // 3 orders, last 30 days ago
  person("di@example.com", "Di Dunn", []);                                       // no orders
  person("ed@example.com", "Ed Eng", [["club", 5, { isTest: 1 }]]);              // only a test order
  person("fay@example.com", "Fay Fox", [["club", 60, { voidedAt: "2026-10-01T00:00:00Z" }], ["club", 90]]);   // a voided order and one 90 days ago
  person("gus@example.com", "Gus <Grey>", [["works", 15]]);

  console.log("=== A percent code's max discount (migrations/0116) ===");
  {
    ok("20% of $300 with a $25 max takes off $25", db.discountForCode_({ kind: "percent", percentBps: 2000, maxDiscountCents: 2500 }, 30000) === 2500);
    ok("…20% of $100 is under it: $20", db.discountForCode_({ kind: "percent", percentBps: 2000, maxDiscountCents: 2500 }, 10000) === 2000);
    ok("…a parsed code (dollars) works the same", db.discountForCode_({ kind: "percent", percent: 20, maxDiscount: 25 }, 30000) === 2500);
    ok("no max: 20% of $300 is $60", db.discountForCode_({ kind: "percent", percentBps: 2000, maxDiscountCents: null }, 30000) === 6000);
    const v = (p) => db.normalizeDiscountCodeInput_(Object.assign({ kind: "percent", percent: 20, maxUses: 5 }, p));
    ok("blank, null or missing is no limit", [undefined, null, ""].every(m => v({ maxDiscount: m }).value.maxDiscountCents === null));
    ok("25 is stored as 2500 cents", v({ maxDiscount: 25 }).value.maxDiscountCents === 2500 && v({ maxDiscount: "12.50" }).value.maxDiscountCents === 1250);
    ok("refused: not a number, under a cent, over $10,000, fractions of a cent",
      ["abc", 0, -1, 10000.01, 1.005, true].every(m => !!v({ maxDiscount: m }).error));
    ok("an amount code never keeps one", db.normalizeDiscountCodeInput_({ kind: "amount", amount: 5, maxUses: 2, maxDiscount: 3 }).value.maxDiscountCents === null);
    const r = await db.saveDiscountCode(d1, { code: "FALL20", kind: "percent", percent: 20, maxDiscount: 25, maxUses: 200 }, { today: "2026-11-27" });
    ok("saved, its label says the max: “20% off, up to $25.00”", r.code && r.code.maxDiscount === 25 && r.code.label === "20% off, up to $25.00");
    const chk = await db.checkDiscountCode(d1, { code: "fall20", orgId: "club", email: "", subtotal: 300, today: "2026-11-27" });
    ok("checking it on $300 of goods: $25 off, and the code carries its max", chk.ok && chk.discount === 25 && chk.code.maxDiscount === 25);
    const edit = await db.saveDiscountCode(d1, { id: r.code.id, code: "FALL20", kind: "percent", percent: 20, maxDiscount: "", maxUses: 200 }, { today: "2026-11-27" });
    ok("an unused code's max can be taken off", edit.code && edit.code.maxDiscount === null && edit.code.label === "20% off");
    await db.saveDiscountCode(d1, { id: r.code.id, code: "FALL20", kind: "percent", percent: 20, maxDiscount: 25, maxUses: 200 }, { today: "2026-11-27" });
    await db.claimDiscountCode(d1, { codeId: r.code.id, orderId: "O-1-0", email: "ann@example.com", amountCents: 2500 });
    const locked = await db.saveDiscountCode(d1, { id: r.code.id, code: "FALL20", kind: "percent", percent: 20, maxDiscount: 30, maxUses: 200 }, { today: "2026-11-27" });
    ok("once used, the max is fixed like the rest of its value", !!locked.error);
    await db.releaseDiscountCodeUse(d1, "O-1-0");
    const bulk = await db.createDiscountCodesForEmails(d1, { emails: ["a1@example.com"], kind: "percent", percent: 10, maxDiscount: 5 });
    ok("codes for a list of emails keep the max too", bulk.codes.length === 1 && d1.q("SELECT maxDiscountCents FROM discount_codes WHERE code = ?", bulk.codes[0].code)[0].maxDiscountCents === 500);
  }

  console.log("=== The no-marketing list ===");
  {
    const on = async (e) => (await C.getMarketingChoice(d1, e)).optedOut;
    await C.setMarketingChoice(d1, " Gus@Example.com ", false, "checkout");
    ok("an unticked box at checkout puts the address on the list (trimmed, lower case)", await on("gus@example.com") && (await C.getMarketingChoice(d1, "gus@example.com")).source === "checkout");
    await C.setMarketingChoice(d1, "gus@example.com", true, "checkout");
    ok("a later ticked box takes a checkout's off again", !(await on("gus@example.com")));
    await C.setMarketingChoice(d1, "gus@example.com", false, "checkout");
    await C.setMarketingChoice(d1, "gus@example.com", false, "unsubscribe");
    ok("an unsubscribe replaces a checkout's reason", (await C.getMarketingChoice(d1, "gus@example.com")).source === "unsubscribe");
    await C.setMarketingChoice(d1, "gus@example.com", false, "checkout");
    ok("…and a later unticked checkout doesn't weaken it", (await C.getMarketingChoice(d1, "gus@example.com")).source === "unsubscribe");
    await C.setMarketingChoice(d1, "gus@example.com", true, "checkout");
    ok("a ticked box never undoes an unsubscribe", await on("gus@example.com"));
    await C.setMarketingChoice(d1, "gus@example.com", true, "admin");
    ok("the owner (Subscribe again) can", !(await on("gus@example.com")));
    await C.setMarketingChoice(d1, "gus@example.com", false, "reply");
    ok("a reply asking to stop is recorded as one", (await C.getMarketingChoice(d1, "gus@example.com")).source === "reply");
    ok("not an address, or an unknown reason: nothing", !(await C.setMarketingChoice(d1, "nope", false, "checkout")).ok && !(await C.setMarketingChoice(d1, "a@b.co", false, "spam")).ok);
    const old = await createD1(); old._raw.exec("CREATE TABLE customers (id INTEGER)");
    ok("before 0117: answers notReady, never throws", (await C.setMarketingChoice(old, "a@b.co", false, "checkout")).notReady === true && (await C.getMarketingChoice(old, "a@b.co")).optedOut === false);
  }

  console.log("=== Who a campaign goes to ===");
  {
    const aud = async (a) => C.campaignAudience(d1, a, { now: NOW, timeZone: "America/New_York" });
    const who = async (a) => (await aud(a)).people.map(p => p.email).sort().join();
    ok("everyone (no rules): every live customer with an email, less the opted out (Gus)",
      await who({}) === "ann@example.com,bo@example.com,cy@example.com,di@example.com,ed@example.com,fay@example.com");
    ok("…and it says one was left out", (await aud({})).optedOut === 1);
    ok("one shop: only customers with a real order there (test and voided orders don't count)", await who({ orgIds: ["works"] }) === "bo@example.com,cy@example.com");
    ok("club: Ann, Cy and Fay (Ed's only order was a test; Fay has a real one too)", await who({ orgIds: ["club"] }) === "ann@example.com,cy@example.com,fay@example.com");
    ok("last order more than 60 days ago: Bo (400) and Fay (90 — her voided order 60 days ago doesn't count)", await who({ last: { mode: "olderThan", n: 60, unit: "days" } }) === "bo@example.com,fay@example.com");
    ok("more than 3 months ago: Bo only (Fay's was 90 days ago, under 3 months)", await who({ last: { mode: "olderThan", n: 3, unit: "months" } }) === "bo@example.com");
    ok("less than 40 days ago: Ann (10) and Cy (30)", await who({ last: { mode: "within", n: 40, unit: "days" } }) === "ann@example.com,cy@example.com");
    ok("before a date: last order before 2026-06-01 — Bo only", await who({ last: { mode: "before", date: "2026-06-01" } }) === "bo@example.com");
    ok("at least 2 orders: Ann and Cy", await who({ orders: { mode: "atLeast", n: 2 } }) === "ann@example.com,cy@example.com");
    ok("exactly 1: Bo and Fay", await who({ orders: { mode: "exactly", n: 1 } }) === "bo@example.com,fay@example.com");
    ok("at most 0: customers who never ordered (Di; Ed's test order doesn't count)", await who({ orders: { mode: "atMost", n: 0 } }) === "di@example.com,ed@example.com");
    ok("rules together: works, at least 2 orders → Cy", await who({ orgIds: ["works"], orders: { mode: "atLeast", n: 2 } }) === "cy@example.com");
    const t = await aud({ orgIds: ["works"], extra: "new@example.com, BO@example.com; not-an-email\ngus@example.com" });
    ok("typed addresses are added (lower case, once), opted-out ones left out, bad ones listed",
      t.people.map(p => p.email).sort().join() === "bo@example.com,cy@example.com,new@example.com" && t.typed === 1 && t.optedOut === 1 && same(t.bad, ["not-an-email"]));
    ok("only the typed addresses: the rules are ignored, opted-out ones still left out",
      await who({ orgIds: ["works"], onlyTyped: true, extra: "ann@example.com new@example.com gus@example.com" }) === "ann@example.com,new@example.com");
    ok("…and with none typed it says so", /Type at least one address/.test((await aud({ onlyTyped: true, extra: "" })).error || ""));
    ok("a missing number or date is refused with a sentence", !!(await aud({ last: { mode: "olderThan" } })).error && !!(await aud({ last: { mode: "before", date: "" } })).error);
    ok("an archived customer is left out", (d1._raw.exec("UPDATE customers SET archivedAt = 't1' WHERE email = 'di@example.com'"), !(await who({})).includes("di@")));
    d1._raw.exec("UPDATE customers SET archivedAt = NULL WHERE email = 'di@example.com'");
  }

  console.log("=== The email ===");
  {
    const design = R.starterDesign("halloween", true);
    design.blocks[1].x = 'Hi {first name}, <b>bold</b> <script>steal()</script><a href="javascript:alert(1)">x</a> <a href="https://ok.example/">ok</a> <span style="color:#ff0000" onclick="x()">red</span>';
    const out = R.render({ theme: "halloween", design, vars: { name: "Gus <Grey>", code: "HW-ABC", codeLabel: "20% off" }, footerHtml: "F", footerText: "F" });
    ok("the theme's colours and the code are in it", out.html.includes("#1C1917") && out.html.includes("HW-ABC"));
    ok("a name is escaped where it's filled in", out.html.includes("Hi Gus,") && !out.html.includes("<Grey>"));
    ok("no script, no javascript: link, no event handler; safe links and a colour kept",
      !/<script|javascript:|onclick/i.test(out.html) && out.html.includes('href="https://ok.example/"') && out.html.includes('style="color:#ff0000"'));
    ok("a plain-text part with the code", /HW-ABC/.test(out.text) && /Hi Gus,/.test(out.text));
    ok("every theme renders and has its sample words", R.THEME_KEYS.length === 11 && R.THEME_KEYS.every(k => R.render({ theme: k, design: R.starterDesign(k, false) }).html.includes(R.THEMES[k].h.replace(/'/g, "&#39;"))));
    ok("every theme has its banner picture", R.THEME_KEYS.every(k => fs.existsSync(__dirname + "/public/email-art/" + k + ".png")));
    ok("the code block is left out when there's no code (not shown empty)", !R.render({ theme: "plain", design: R.starterDesign("plain", true) }).html.includes("dashed"));
    ok("HTML written by hand: scripts and handlers taken out", !/<script|onload/i.test(R.render({ theme: "plain", design: { html: '<p onload="x">hi</p><script>bad()</script>' } }).html));
    ok("only known blocks are kept, at most 40", R.normalizeDesign({ blocks: Array(60).fill({ t: "text", x: "a" }).concat([{ t: "evil" }]) }).blocks.length === 40);
  }

  console.log("=== The campaigns, and sending ===");
  const sent = [];
  const env = { DB: d1, EDITION: "desktop", DESKTOP_EMAIL: "on",
    MAILER: { fetch: async (url, init) => { const m = JSON.parse(init.body); sent.push(m); return new Response(JSON.stringify({ ok: true, message: "250 OK" }), { status: 200 }); } },
    ASSETS: { fetch: async (req) => { const f = __dirname + "/public" + new URL(req.url).pathname; return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response("", { status: 404 }); } } };
  d1._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('business', '{"name":"Sample Print Co","receiptsEmail":"books@example.com"}')`);
  {
    const s = await C.saveCampaign(d1, { name: "Fall", subject: "Hi {first name}", theme: "thanksgiving", design: R.starterDesign("thanksgiving", true),
      audience: { orgIds: ["club"] }, discount: { mode: "unique", kind: "percent", percent: 15, maxDiscount: 20, expiresOn: "2026-12-31", prefix: "FALL-" } }, { actor: "owner" });
    ok("a new campaign is a draft with what was given", s.campaign && s.campaign.status === "draft" && s.campaign.theme === "thanksgiving" && s.campaign.discount.prefix === "FALL-");
    const id = s.campaign.id;
    const copy = await C.copyCampaign(d1, id);
    ok("copy: a new draft named “… (copy)”", copy.campaign && copy.campaign.id !== id && copy.campaign.name === "Fall (copy)");
    ok("a draft can be deleted", (await C.deleteCampaign(d1, copy.campaign.id)).ok && !(await C.getCampaign(d1, copy.campaign.id)));
    const empty = await C.saveCampaign(d1, { name: "Empty", subject: "", design: { blocks: [] } });
    ok("one without a subject can't be sent", (await C.scheduleCampaign(env, empty.campaign.id, null, { now: NOW })).error === "Give the email a subject.");
    ok("a time less than a minute ahead is refused", /at least a minute/.test((await C.scheduleCampaign(env, id, new Date(NOW.getTime() + 1000).toISOString(), { now: NOW })).error || ""));

    const go = await C.scheduleCampaign(env, id, null, { now: NOW });
    ok("send now: it's sending, to the 3 club customers", go.campaign && go.campaign.status === "sending" && go.campaign.counts.total === 3 && go.campaign.counts.queued === 3);
    const codes = d1.q("SELECT r.email, r.code, d.maxDiscountCents, d.email AS codeEmail, d.note FROM email_campaign_recipients r JOIN discount_codes d ON d.code = r.code WHERE r.campaignId = ? ORDER BY r.email", id);
    ok("each person got their own single-use code, tied to their email, with the max and a note naming the campaign",
      codes.length === 3 && codes.every(c => /^FALL-/.test(c.code) && c.codeEmail === c.email && c.maxDiscountCents === 2000 && c.note === "Campaign: Fall"));
    ok("it can't be changed now", /can't change/.test((await C.saveCampaign(d1, { id, subject: "x" })).error || "") && /already/.test((await C.scheduleCampaign(env, id, null, { now: NOW })).error || ""));
    await C.setMarketingChoice(d1, "fay@example.com", false, "unsubscribe");   // unsubscribes after it started
    const [r1, r2] = await Promise.all([C.runCampaignQueue(env, { limit: 1, now: NOW }), C.runCampaignQueue(env, { limit: 1, now: NOW })]);
    ok("two runs at once never send the same person (a row is taken by one of them only)", r1.sent + r2.sent >= 1 && new Set(sent.map(m => m.to)).size === sent.length);
    const r3 = await C.runCampaignQueue(env, { limit: 10, now: NOW });
    const after = await C.getCampaign(d1, id);
    ok("…then the rest: someone who unsubscribed meanwhile is skipped, and it's finished",
      r3.finished === 1 && after.status === "sent" && after.counts.sent === 2 && sent.length === 2 && after.counts.skipped === 1 && !sent.some(m => m.to === "fay@example.com"));
    ok("each email went to one person with their own code in it, the name filled in", sent.every(m => codes.some(c => c.email === m.to && m.html.includes(c.code))) && sent.some(m => m.subject === "Hi Ann"));
    ok("no copy to the receipts inbox", sent.every(m => !(m.bcc || []).length));
    ok("the desktop way to stop: reply UNSUBSCRIBE (no web link), and no List-Unsubscribe header", sent.every(m => /Reply with UNSUBSCRIBE/.test(m.html) && !/api\/unsubscribe/.test(m.html) && !m.listUnsubscribe));
    ok("the banner picture is attached and shown from it (cid:)", sent.every(m => m.html.includes("cid:art-thanksgiving") && m.attachments && m.attachments[0].cid === "art-thanksgiving"));
    ok("the business block fills the footer", sent.every(m => m.html.includes("Sample Print Co")));
    ok("nothing is sent again", (await C.runCampaignQueue(env, { now: NOW })).sent === 0 && sent.length === 2);

    // One shared code, scheduled.
    const k = await db.saveDiscountCode(d1, { code: "THANKS10", kind: "amount", amount: 10, maxUses: 1000 }, { today: "2026-11-27" });
    const s2 = await C.saveCampaign(d1, { name: "Later", subject: "Thanks", theme: "plain", design: R.starterDesign("plain", true), audience: { orgIds: ["works"] }, discount: { mode: "shared", codeId: k.code.id } });
    const at = new Date(NOW.getTime() + 3600000).toISOString();
    const sch = await C.scheduleCampaign(env, s2.campaign.id, at, { now: NOW });
    ok("scheduled for later: it waits", sch.campaign.status === "scheduled" && sch.campaign.scheduledAt === at && sch.campaign.counts.total === 0);
    ok("a run before its time leaves it alone", (await C.runCampaignQueue(env, { now: NOW })).started === 0);
    const later = new Date(NOW.getTime() + 3600000 + 1000);
    const run = await C.runCampaignQueue(env, { now: later, limit: 50 });
    const c2 = await C.getCampaign(d1, s2.campaign.id);
    ok("a run after its time starts it and sends it: Bo and Cy, both with THANKS10", run.started === 1 && c2.status === "sent" && c2.counts.sent === 2 &&
      sent.slice(-2).every(m => m.html.includes("THANKS10")));
    ok("its codes used are counted from when it started", c2.codesUsed === 0);
    const s3 = await C.saveCampaign(d1, { name: "Stop me", subject: "x", design: R.starterDesign("plain", false), audience: {} });
    await C.scheduleCampaign(env, s3.campaign.id, new Date(NOW.getTime() + 7200000).toISOString(), { now: NOW });
    const can = await C.cancelCampaign(d1, s3.campaign.id);
    ok("a scheduled campaign can be canceled", can.ok && can.campaign.status === "canceled");
    ok("a campaign that was sent can't be deleted", !!(await C.deleteCampaign(d1, id)).error);
    const list = await C.listCampaigns(d1, {});
    ok("the list: every campaign, newest change first, with counts", list.total === 4 && list.campaigns.every(c => c.counts && c.design === undefined));
  }

  console.log("=== The web: the unsubscribe link ===");
  {
    const web = { DB: d1, ROOT_DOMAIN: "shop.example", SIGNING_SECRET: "test-secret-0123456789", RESEND_API_KEY: "re_test", EMAIL_FROM: "news@shop.example" };
    const c = { theme: "summer", subject: "Sun", preheader: "", design: R.starterDesign("summer", false), discount: { mode: "none" } };
    const m = await C.buildCampaignEmail(web, c, { email: "zed@example.com", name: "Zed" });
    const link = (/href="(https:\/\/shop\.example\/api\/unsubscribe\?[^"]+)"/.exec(m.html) || [])[1];
    ok("a web email has an unsubscribe link and the List-Unsubscribe header for it", !!link && m.listUnsubscribe === "<" + link.replace(/&amp;/g, "&") + ">");
    ok("its banner picture is a link to the site's copy (nothing attached)", m.html.includes("https://shop.example/email-art/summer.png") && !m.attachments.length);
    const u = new URL(link.replace(/&amp;/g, "&"));
    const get = await unsub.onRequestGet({ request: new Request(u.toString()), env: web });
    const page = await get.text();
    ok("opening the link shows a page with one button, and changes nothing yet", get.status === 200 && /<form method="post"/.test(page) && !(await C.getMarketingChoice(d1, "zed@example.com")).optedOut);
    ok("…a page with no script that can't be framed", !/<script/i.test(page) && /frame-ancestors 'none'/.test(get.headers.get("Content-Security-Policy")));
    const form = new URLSearchParams({ e: u.searchParams.get("e"), t: u.searchParams.get("t") });
    const post = await unsub.onRequestPost({ request: new Request("https://shop.example/api/unsubscribe", { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded" } }), env: web });
    ok("pressing it unsubscribes that address", post.status === 200 && /unsubscribed/.test(await post.text()) && (await C.getMarketingChoice(d1, "zed@example.com")).source === "unsubscribe");
    const bad = await unsub.onRequestPost({ request: new Request("https://shop.example/api/unsubscribe", { method: "POST", body: new URLSearchParams({ e: "ann@example.com", t: u.searchParams.get("t") }), headers: { "Content-Type": "application/x-www-form-urlencoded" } }), env: web });
    ok("another address with that token is refused, and stays subscribed", bad.status === 400 && !(await C.getMarketingChoice(d1, "ann@example.com")).optedOut);
    ok("the token is tied to the address and the secret", await http.verifyUnsubscribeToken(web, "zed@example.com", u.searchParams.get("t")) &&
      !(await http.verifyUnsubscribeToken({ SIGNING_SECRET: "other-secret-0123456789" }, "zed@example.com", u.searchParams.get("t"))));
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
