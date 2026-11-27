// Discount codes on a Local sale, shop news at checkout, and the Email campaigns actions — through the real handler of
// functions/api/orders.js (the sign-in gate stood in for; who may is checked against functions/_lib/permissions.js):
//   * checkLocalSaleCode (the Local sale window's Apply) and createLocalSale with a code: the discount booked like the
//     checkout's (orders.discountCents / discountNote, the use with the order id), a percent code's max, a code for one
//     person checked against the picked customer's email or the typed one, the Discount codes switch, a refused code
//     leaving no order;
//   * the box at checkout and on a Local sale (marketingOptIn): unticked puts the address on the no-marketing list,
//     ticked takes a checkout's off, nothing when the box wasn't shown or Email campaigns is off;
//   * the Email campaigns actions: who may (permissions.js), the switch, email not set up (status, a send refused),
//     save / preview / schedule / run / cancel / delete with email set up (the desktop's mailbox, a stand-in), the
//     customer page's "Stop marketing email", and the audit rows (never an address).
// Real SQL (sql.js) under the real db.js, campaigns.js, campaign-render.js, email.js and orders.js. Invented shops and people.
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const roles = require("./testlib/roles");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const { selectBox } = new Function(strip(read("functions/_lib/boxSize.js")) + "\nreturn { selectBox };")();
globalThis.__f = {};
const catalogStub = "const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {}, features: globalThis.__f });\n";
const rlStub = "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n";
new Function(read("public/campaign-render.js"))();
const S = new Function("selectBox", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'olive@example.com';\n" + adminAs() + "\n" + rlStub +
  "const verifyTurnstile = async () => ({ ok: true });\nconst invalidateCatalogVersionCache = () => {};\n" + catalogStub +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" +
  strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/digital.js")) + "\n" + strip(read("functions/_lib/campaigns.js")) + "\n" +
  strip(read("functions/api/orders.js")) + `\nreturn { post: onRequestPost, saveDiscountCode, getMarketingChoice, setFeatures };`)(selectBox);

const sent = [];
const MAILER = { fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true }), { status: 200 }); } };
const ordersJs = read("functions/api/orders.js");

(async () => {
  console.log("=== Who may (functions/_lib/permissions.js) and the lists in orders.js ===");
  {
    const perm = (a) => roles.ACTION_PERM[a];
    const area = roles.PERMISSION_AREAS.find(a => a.key === "discounts");
    ok("the Discount codes area has a second function: discounts.campaigns, “Email campaigns”", same(area.items[0].fns, [["discounts.codes", "Discount codes"], ["discounts.campaigns", "Email campaigns"]]));
    ok("reading campaigns and who they'd go to: read", ["getCampaignStatus", "listCampaigns", "getCampaign", "previewAudience"].every(a => same(perm(a), [["discounts.campaigns", "read"]])));
    ok("writing them, sending a test and keeping a send going: edit", ["saveCampaign", "copyCampaign", "sendCampaignTest", "runCampaignQueue"].every(a => same(perm(a), [["discounts.campaigns", "edit"]])));
    ok("sending, scheduling, canceling and deleting: full", ["scheduleCampaign", "cancelCampaign", "deleteCampaign"].every(a => same(perm(a), [["discounts.campaigns", "full"]])));
    ok("“Stop marketing email” on a customer is the customer record's (edit)", same(perm("setMarketingOptOut"), [["customers.records", "edit"]]));
    ok("the Local sale's Apply needs what recording the sale does", same(perm("checkLocalSaleCode"), perm("createLocalSale")));
    const level = (role, fn) => roles.effectivePermissions(roles.DEFAULT_ROLES[role])[fn];
    ok("built-in defaults for campaigns: Admin and Manager full, Back office and Production none",
      ["admin", "manager", "staff", "production"].map(r => level(r, "discounts.campaigns")).join() === "full,full,none,none");
    const noMonth = [...ordersJs.match(/const NO_MONTH_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ok("none of them changes a month's numbers", ["checkLocalSaleCode", "saveCampaign", "scheduleCampaign", "runCampaignQueue", "setMarketingOptOut"].every(a => noMonth.includes(a)));
    const desk = [...ordersJs.match(/const DESKTOP_EMAIL_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ok("on the desktop, sending needs email set up there", ["sendCampaignTest", "scheduleCampaign", "runCampaignQueue"].every(a => desk.includes(a)));
  }

  const d1 = await createD1();
  d1._raw.exec(read("schema.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1);
    INSERT INTO customers (id, name, email, createdAt, updatedAt) VALUES (1, 'Pat Example', 'pat@example.com', 't', 't'), (2, 'Lee Sample', 'lee@example.com', 't', 't');`);
  let ENV = { SIGNING_SECRET: "s".repeat(40) };
  const call = async (url, body) => {
    const waits = [];
    const res = await S.post({ env: { DB: d1, ...ENV }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})), request: { url, json: async () => body, headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  // The desktop program answers only on localhost (hostConfig.js), so its admin is asked there.
  const admin = (body) => call((ENV.EDITION === "desktop" ? "http://localhost:8788" : ADMIN_ORIGIN) + "/api/orders", { key: "x", org: "acme", ...body });
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  const make = async (input) => (await S.saveDiscountCode(d1, input, { actor: "t" })).code;
  const items = [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", customUnitPrice: 25, qty: 4, taxable: false }];   // $100 of goods
  let n = 0;
  const sale = (extra) => admin({ action: "createLocalSale", requestId: "req" + (++n) + "abcdef", items, paymentMethod: "Cash", ...extra });

  console.log("\n=== A discount code on a Local sale ===");
  {
    await make({ code: "SAVE20", kind: "percent", percent: 20, maxDiscount: 15, maxUses: 10 });
    await make({ code: "PATONLY", kind: "amount", amount: 7, email: "pat@example.com" });
    let r = await admin({ action: "checkLocalSaleCode", code: " save20 ", subtotal: 100 });
    ok("Apply: 20% of $100 with a $15 max is $15, and the answer says so", r.status === 200 && r.body.ok === true && r.body.discount === 15 && r.body.code.code === "SAVE20" && r.body.code.label === "20% off, up to $15.00");
    r = await admin({ action: "checkLocalSaleCode", code: "NOPE", subtotal: 100 });
    ok("a code that isn't one: ok false with the reason", r.status === 200 && r.body.ok === false && !!r.body.reason);
    r = await admin({ action: "checkLocalSaleCode", code: "PATONLY", subtotal: 100, contact: "lee@example.com" });
    ok("one person's code with another email typed: refused", r.body.ok === false);
    r = await admin({ action: "checkLocalSaleCode", code: "PATONLY", subtotal: 100, customerId: 1 });
    ok("…with that person picked as the customer: good", r.body.ok === true && r.body.discount === 7);
    r = await admin({ action: "checkLocalSaleCode", subtotal: 100 });
    ok("no code: 400 “Enter a code.”", r.status === 400 && r.body.message === "Enter a code.");

    r = await sale({ discountCode: "save20", contact: "sam@example.com" });
    const o = q1("SELECT * FROM orders WHERE orderId = ?", r.body.orderId);
    ok("recorded with the code: $15 off, noted “Code SAVE20”", r.status === 200 && o && o.discountCents === 1500 && o.discountNote === "Code SAVE20");
    const use = q1("SELECT * FROM discount_code_uses WHERE orderId = ?", r.body.orderId);
    ok("…and one use of the code, for this order and the typed email", use && use.amountCents === 1500 && use.email === "sam@example.com" && !use.releasedAt);
    const audit = q1("SELECT detail FROM audit_log WHERE action = 'order.created_local_sale' ORDER BY id DESC");
    ok("the sale's audit row names the code and the discount", audit && JSON.parse(audit.detail).discountCode === "SAVE20" && JSON.parse(audit.detail).discount === 15);
    const before = q1("SELECT count(*) AS n FROM orders").n;
    r = await sale({ discountCode: "PATONLY", contact: "lee@example.com" });
    ok("one person's code for someone else: refused, and no order is recorded", r.status === 400 && q1("SELECT count(*) AS n FROM orders").n === before);
    r = await sale({ discountCode: "PATONLY", customerId: 1 });
    ok("…for the picked customer it's theirs: $7 off", r.status === 200 && q1("SELECT discountCents FROM orders WHERE orderId = ?", r.body.orderId).discountCents === 700);
    r = await sale({ discountCode: "PATONLY", customerId: 1 });
    ok("…and it works once", r.status === 400 && /already been used/.test(r.body.message));
    globalThis.__f = { discounts: false };
    r = await sale({ discountCode: "SAVE20" });
    ok("Discount codes switched off: a sale sent with a code is refused", r.status === 403 && /Discount codes is turned off/.test(r.body.message));
    r = await admin({ action: "checkLocalSaleCode", code: "SAVE20", subtotal: 10 });
    ok("…and so is Apply", r.status === 403);
    globalThis.__f = {};
    r = await sale({});
    ok("a sale with no code is as before: no discount", r.status === 200 && !q1("SELECT discountCents FROM orders WHERE orderId = ?", r.body.orderId).discountCents);
  }

  console.log("\n=== The shop news box: Local sale and checkout ===");
  {
    let r = await sale({ contact: "new@example.com", marketingOptIn: false });
    ok("Local sale with the box unticked: the address goes on the no-marketing list (as a checkout's)", r.status === 200 && (await S.getMarketingChoice(d1, "new@example.com")).source === "checkout");
    r = await sale({ contact: "new@example.com", marketingOptIn: true });
    ok("…ticked next time: taken off again", !(await S.getMarketingChoice(d1, "new@example.com")).optedOut);
    r = await sale({ customerId: 2, marketingOptIn: false });
    ok("…for a picked customer, their email", (await S.getMarketingChoice(d1, "lee@example.com")).optedOut === true);
    globalThis.__f = { emailCampaigns: false };
    r = await sale({ contact: "off@example.com", marketingOptIn: false });
    ok("Email campaigns switched off: the box's answer isn't kept", r.status === 200 && !(await S.getMarketingChoice(d1, "off@example.com")).optedOut);
    globalThis.__f = {};
    await admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
    d1._raw.exec("UPDATE orgs SET deliveryOptionsJson = '[{\"id\":\"pickup\",\"label\":\"Pickup\",\"type\":\"pickup\",\"fee\":0}]' WHERE orgId = 'acme'");
    const shop = (extra) => call(shopOrigin("acme") + "/api/orders", { orderId: "WEB-" + (++n), orgId: "acme", customerName: "Kim Shopper", contact: "kim@example.com", paymentMethod: "Check",
      items: [{ productId: "mug", size: "", qty: 1 }], deliveryOptionId: "pickup", ...extra });
    r = await shop({ marketingOptIn: false });
    ok("checkout with the box unticked: on the list", r.status === 200 && (await S.getMarketingChoice(d1, "kim@example.com")).source === "checkout");
    r = await shop({ marketingOptIn: true });
    ok("checkout ticked: off it", r.status === 200 && !(await S.getMarketingChoice(d1, "kim@example.com")).optedOut);
    await shop({ marketingOptIn: false });
    await shop({});
    ok("an order sent without the box (an older page) changes nothing", (await S.getMarketingChoice(d1, "kim@example.com")).optedOut === true);
  }

  console.log("\n=== Email campaigns: email not set up ===");
  {
    let r = await admin({ action: "getCampaignStatus" });
    ok("status: not ready (no email provider here)", r.status === 200 && r.body.emailReady === false);
    r = await admin({ action: "saveCampaign", campaign: { name: "Fall", subject: "Hello", theme: "halloween", design: globalThis.OddCampaignRender.starterDesign("halloween", false), audience: {} } });
    ok("a draft can still be written", r.status === 200 && r.body.campaign.status === "draft");
    const id = r.body.campaign.id;
    r = await admin({ action: "scheduleCampaign", id });
    ok("sending is refused: “Email isn't set up yet…”", r.status === 409 && /Email isn't set up yet/.test(r.body.message));
    globalThis.__f = { emailCampaigns: false };
    r = await admin({ action: "listCampaigns" });
    ok("Email campaigns switched off: its actions are refused", r.status === 403 && /Email campaigns is turned off/.test(r.body.message));
    globalThis.__f = {};
  }

  console.log("\n=== Email campaigns: email set up (the desktop's mailbox) ===");
  {
    ENV = { SIGNING_SECRET: "s".repeat(40), EDITION: "desktop", DESKTOP_EMAIL: "on", MAILER };
    let r = await admin({ action: "getCampaignStatus" });
    ok("status: ready, on the desktop", r.body.emailReady === true && r.body.desktop === true);
    r = await admin({ action: "previewAudience", audience: { extra: "a@example.com, b@example.com, nope" } });
    ok("preview: everyone not opted out, the typed ones, and what isn't an address",
      r.status === 200 && r.body.count >= 4 && r.body.bad.join() === "nope" && r.body.people.every(p => p.email !== "lee@example.com"));
    r = await admin({ action: "previewAudience", audience: { last: { mode: "olderThan" } } });
    ok("a rule missing its number: 400 with the sentence", r.status === 400 && /how many days or months/.test(r.body.message));
    const log0 = q1("SELECT COALESCE(MAX(id),0) AS m FROM audit_log").m;
    r = await admin({ action: "saveCampaign", campaign: { name: "Winter", subject: "Hi {first name}", theme: "christmas", design: globalThis.OddCampaignRender.starterDesign("christmas", true),
      audience: { extra: "pat@example.com, a@example.com", onlyTyped: true }, discount: { mode: "unique", kind: "amount", amount: 5 } } });
    const id = r.body.campaign.id;
    r = await admin({ action: "sendCampaignTest", to: "olive@example.com", campaign: { subject: "Hi {first name}", theme: "christmas", design: globalThis.OddCampaignRender.starterDesign("christmas", true), discount: { mode: "unique", kind: "amount", amount: 5 } } });
    ok("a test goes to the address given, marked [Test], with a sample code", r.status === 200 && sent.length === 1 && sent[0].to === "olive@example.com" && /^\[Test\]/.test(sent[0].subject) && sent[0].html.includes("SAMPLE-CODE"));
    r = await admin({ action: "scheduleCampaign", id });
    ok("send now: started and the first few sent at once (here, both)", r.status === 200 && r.body.campaign.counts.total === 2 && r.body.campaign.counts.sent === 2 && sent.length === 3);
    ok("each got a $5 code of their own", sent.slice(1).every(m => /\$5\.00 off/.test(m.html)) && d1.q("SELECT count(*) AS n FROM discount_codes WHERE note = 'Campaign: Winter'")[0].n === 2);
    r = await admin({ action: "runCampaignQueue", id });
    ok("keeping it going when it's done: nothing more is sent, and it's marked sent", r.status === 200 && r.body.sent === 0 && r.body.campaign.status === "sent" && sent.length === 3);
    const rows = d1.q("SELECT action, detail FROM audit_log WHERE id > ? ORDER BY id", log0);
    ok("the audit log has the campaign made and started, with how many — never an address",
      rows.some(x => x.action === "campaign.created") && rows.some(x => x.action === "campaign.started" && JSON.parse(x.detail).recipients === 2) && rows.every(x => !/@example\.com/.test(x.detail || "")));
    r = await admin({ action: "deleteCampaign", id });
    ok("a sent campaign can't be deleted", r.status === 409);
    r = await admin({ action: "copyCampaign", id });
    ok("copy: a new draft", r.status === 200 && r.body.campaign.status === "draft" && r.body.campaign.id !== id);
    const at = new Date(Date.now() + 3600000).toISOString();
    r = await admin({ action: "scheduleCampaign", id: r.body.campaign.id, at });
    ok("schedule for later: scheduled, nothing sent", r.status === 200 && r.body.campaign.status === "scheduled" && sent.length === 3);
    r = await admin({ action: "cancelCampaign", id: r.body.campaign.id });
    ok("cancel it", r.status === 200 && r.body.campaign.status === "canceled");
    r = await admin({ action: "getCampaign", id: 999 });
    ok("a campaign that isn't there: 404", r.status === 404);
    r = await admin({ action: "setMarketingOptOut", email: "pat@example.com", optedOut: true });
    ok("“Stop marketing email” on a customer: on the list, set by the owner", r.status === 200 && r.body.marketing.optedOut && r.body.marketing.source === "admin");
    r = await admin({ action: "getCustomer", id: 1 });
    ok("the customer page reads it", r.status === 200 && r.body.marketing && r.body.marketing.optedOut === true);
    r = await admin({ action: "setMarketingOptOut", email: "pat@example.com", optedOut: false });
    ok("“Subscribe again”", r.status === 200 && r.body.marketing.optedOut === false);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
