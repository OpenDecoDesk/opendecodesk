const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { storefrontPage } = require("./testlib/storefront-page");

// Reports → Tax packet (docs/tax-packet.md) — real SQL (sql.js), real db.js and orders.js, and the
// admin page (jsdom) talking to that API:
//   getTaxPacketExtras: stock the shop used itself listed for use tax REVIEW (and left out of the
//   use tax due), money owed at the end date, exempt sales with their certificates, the first sale;
//   the printable page: the same figures as the reports, sections ticked on and off, everything escaped.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, addOrderPayment, setSalesTaxSettings, setOrgTaxExemption };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let failed = 0;
const ok = (desc, v) => { if (!v) failed++; console.log(desc + ":", !!v); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('shop','shop','Main Shop','t','t'), ('school','school','Example School','t','t'), ('church','church','Example Church','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPrice, sizePricing, createdAt, updatedAt) VALUES ('tee','shop','shirt','Tee','flat',20,'{}','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  require("./testlib/vendors.js").seedVendors(d1);
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const range = { dateFrom: "2026-01-01", dateTo: "2026-06-30" };
  const tee = (qty = 1, unitPrice = 20) => ({ productId: "tee", name: "Tee", type: "shirt", qty, unitPrice });
  const catId = (n) => d1.q("SELECT id FROM expense_categories WHERE name=?", n)[0].id;

  await lib.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH" });
  await lib.setOrgTaxExemption(d1, "school", { taxExempt: true, certificate: "", expires: null });
  await lib.setOrgTaxExemption(d1, "church", { taxExempt: true, certificate: "cert-church.pdf", expires: "2027-12-31" });

  // A test order before the first real one, and a voided one: neither counts anywhere.
  await lib.insertOrder(d1, { orderId: "T0", orgId: "shop", customerName: "Tester", contact: "t@x", placedAt: "2026-01-15T00:00:00Z" }, [tee(5)]);
  d1._raw.run("UPDATE orders SET isTest = 1 WHERE orderId = 'T0'");
  await lib.insertOrder(d1, { orderId: "O1", orgId: "shop", customerName: "Ann", contact: "a@x", placedAt: "2026-03-01T00:00:00Z" }, [tee(2)]);
  await lib.insertOrder(d1, { orderId: "O2", orgId: "shop", customerName: "Bob", contact: "b@x", placedAt: "2026-04-01T00:00:00Z" }, [tee(1, 16)]);
  await lib.insertOrder(d1, { orderId: "V1", orgId: "shop", customerName: "Void", contact: "v@x", placedAt: "2026-04-02T00:00:00Z" }, [tee(3)]);
  d1._raw.run("UPDATE orders SET voidedAt = '2026-04-03T00:00:00Z' WHERE orderId = 'V1'");
  await lib.insertOrder(d1, { orderId: "S1", orgId: "school", customerName: "Example School", contact: "s@x", placedAt: "2026-05-01T00:00:00Z" }, [tee(10)]);
  await lib.insertOrder(d1, { orderId: "C1", orgId: "church", customerName: "Example Church", contact: "c@x", placedAt: "2026-05-02T00:00:00Z" }, [tee(4)]);
  const o1 = await lib.getOrderById(d1, "O1"), o2 = await lib.getOrderById(d1, "O2");
  await lib.addOrderPayment(d1, "O1", o1.total, "Card", "", { method: "card", receivedAt: "2026-03-02T00:00:00Z" });
  await lib.addOrderPayment(d1, "O1", -10, "refund", "", { method: "card", kind: "refund", receivedAt: "2026-04-10T00:00:00Z" });
  await lib.addOrderPayment(d1, "O2", 5, "Venmo", "", { method: "venmo", receivedAt: "2026-04-02T00:00:00Z" });
  await lib.addOrderPayment(d1, "O2", o2.total - 5, "Venmo", "", { method: "venmo", receivedAt: "2026-07-15T00:00:00Z" });   // after the end date
  for (const id of ["S1", "C1"]) { const o = await lib.getOrderById(d1, id); await lib.addOrderPayment(d1, id, o.total, "Check", "", { method: "check", receivedAt: o.placedAt }); }

  // Expenses: one before the first sale, an untaxed supply (use tax), a meal, equipment, and a category with markup in its name.
  await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-02-01", description: "Business license", categoryId: catId("Office expense"), amount: 75 } });
  await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-03-10", description: "Stabilizer", categoryId: catId("Supplies (thread, stabilizer, needles)"), amount: 50, vendorChargedTax: false } });
  await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-03-11", description: "Client lunch", categoryId: catId("Meals (50%)"), amount: 40 } });
  await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-03-12", description: "Embroidery machine", categoryId: catId("Equipment & machines"), amount: 1000, placedInService: "2026-03-15", depMethod: "section179" } });
  const evil = (await call({ action: "saveExpenseCategory", category: { name: "<script>alert(1)</script>", deductionType: "deductible", scheduleCLine: "22", deductiblePct: 100 } })).body.id;
  await call({ action: "saveExpense", expense: { accountId: 2, date: "2026-04-05", description: "Odd thing", categoryId: evil, amount: 12 } });

  // Blanks: bought for resale tax-free (fine), some used for testing (review), some damaged (not used — not listed);
  // a blank kept for testing bought without tax (review).
  d1._raw.exec(`INSERT INTO blanks (id, name, brand, color, createdAt, updatedAt) VALUES (1,'Tee blank','ST','Black','t','t'), (2,'Test fabric','ST','White','t','t');
    INSERT INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity) VALUES (1,'Black','M',400,0), (2,'White','OS',300,0);
    UPDATE blanks SET forTesting = 1 WHERE id = 2;`);
  let r = await call({ action: "receiveBlanks", blankId: 1, lines: [{ color: "Black", size: "M", qty: 10, unitCost: 4 }], vendor: "SanMar", receivedAt: "2026-02-20" });
  ok("resale blanks received", r.status === 200);
  r = await call({ action: "receiveBlanks", blankId: 2, lines: [{ color: "White", size: "OS", qty: 5, unitCost: 3 }], vendor: "SanMar", receivedAt: "2026-02-21" });
  ok("testing blanks received", r.status === 200);
  r = await call({ action: "writeOffBlanks", blankId: 1, color: "Black", size: "M", qty: 2, reason: "testing", note: "Test sew-outs", occurredAt: "2026-03-20" });
  ok("2 resale blanks written off for testing", r.status === 200);
  await call({ action: "writeOffBlanks", blankId: 1, color: "Black", size: "M", qty: 1, reason: "damaged", note: "Torn", occurredAt: "2026-03-21" });
  // Count stock: 6 counted where 7 are on file — a correction.
  r = await call({ action: "countBlankStock", rows: [{ blankId: 1, color: "Black", size: "M", counted: 6, onHand: 7 }], at: "2026-06-01" });
  ok("a shelf count of 6 where 7 were on file is recorded as a correction", r.status === 200 && r.body.corrected.length === 1 && r.body.corrected[0].delta === -1);

  console.log("=== getTaxPacketExtras ===");
  r = await call({ action: "getTaxPacketExtras", ...range });
  const x = r.body;
  ok("answers with the rate and state on file", r.status === 200 && x.ratePct === 6 && x.jurisdiction === "OH");
  const testing = x.selfUsed.find(s => /used for testing/.test(s.why)), shopUse = x.selfUsed.find(s => /shop use/.test(s.why));
  ok("resale blanks used for testing are listed: 2 × $4 = $8, use tax $0.48", testing && testing.qty === 2 && testing.cost === 8 && testing.useTax === 0.48 && testing.note === "Test sew-outs");
  ok("a testing blank bought with no tax is listed: $15, use tax $0.90", shopUse && shopUse.cost === 15 && shopUse.useTax === 0.9);
  ok("damaged stock and blanks bought for resale aren't listed", x.selfUsed.length === 2);
  r = await call({ action: "getSalesTaxReport", ...range });
  const tax = r.body;
  ok("the review list is NOT added to the use tax due (only the $50 untaxed supply: $3.00)", tax.taxReturn.total.useTax === 3 && tax.totals.useTax === 3);
  ok("…and net tax due is still collected − refunded + use tax", Math.round(tax.totals.netTaxDue * 100) === Math.round((tax.totals.taxCollected - tax.totals.taxRefunded + 3) * 100));
  const owe = x.receivables;
  ok("an order refunded in part after being paid in full isn't owing", !owe.some(o => o.orderId === "O1"));
  ok("money owed at the end date: only O2, its total less the $5 paid by then (the July payment doesn't count)",
    owe.length === 1 && owe[0].orderId === "O2" && owe[0].received === 5 && Math.round(owe[0].balance * 100) === Math.round((o2.total - 5) * 100) && owe[0].customer === "Bob");
  const r2 = await call({ action: "getTaxPacketExtras", dateFrom: "2026-01-01", dateTo: "2026-07-31" });
  ok("…paid in full after July 15, so nothing owed at the end of July", r2.body.receivables.length === 0);
  ok("test and voided orders are never owing", !owe.some(o => o.orderId === "T0" || o.orderId === "V1"));
  const school = x.exempt.find(e => e.orgId === "school"), church = x.exempt.find(e => e.orgId === "church");
  ok("exempt sales by customer: the school's certificate is missing, the church's is on file", x.exempt.length === 2 && school.certificateOnFile === false && church.certificateOnFile === true && church.certificateExpired === false);
  ok("exempt sales amounts: $200 and $80", school.sales === 200 && church.sales === 80 && school.orders === 1);
  ok("the first sale is the first real order (the earlier test order doesn't count)", x.firstSaleDate === "2026-03-01");
  ok("audited", d1.q("SELECT count(*) n FROM audit_log WHERE action = 'report.tax_packet'")[0].n === 2);
  r = await call({ action: "getTaxPacketExtras", dateFrom: "2026-1-1", dateTo: "2026-06-30" });
  ok("a bad date is refused", r.status === 400);

  console.log("\n=== The admin page (jsdom) ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(w){ w.fetch = async (u, init) => {
      const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (String(u).includes("/api/orders")) { const res = await call(b); return { ok: res.status < 400, status: res.status, json: async () => res.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    }; } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"');
  ok("Tax packet is in the Reports menu", /label: "Reports"[\s\S]*?\["taxpacket", "Tax packet"\]/.test(adminJs));
  const data = await w.loadTaxPacket_("2026-01-01", "2026-06-30");
  ok("every report loads for the packet", Object.keys(data.errors).length === 0 && data.expenses && data.tax && data.revenue && data.cash && data.inventory && data.books && data.extras);
  const all = w.eval("TAX_PACKET_SECTIONS_").map(s => s[0]);
  const html = w.taxPacketHtml_(data, all, { business: "Test Shop", today: "2026-07-01" });
  const doc = new JSDOM(html).window.document;
  const text = doc.body.textContent;
  const fmt = (n) => (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  ok("one section per ticked part, each starting a new page", doc.querySelectorAll("section").length === all.length && /section\{page-break-before:always/.test(html));
  ok("no script runs in the packet, and a category named with markup prints as text", !/<script/i.test(html) && text.includes("<script>alert(1)</script>"));
  const fees = data.books.summary.reduce((a, m) => a + Math.round(m.stripeFees * 100), 0) / 100;
  const dedAll = Math.round((data.expenses.summary.totals.deductible + fees) * 100) / 100;
  ok("expenses: the deductible total is the expense report's plus card fees (proposed)", text.includes(fmt(dedAll)) && /Commissions and fees — Card processing fees/.test(text));
  ok("expenses: meals at 50% ($20), the machine listed to depreciate with its method", text.includes(fmt(20)) && /Embroidery machine/.test(text) && /Section 179/.test(text));
  ok("sales tax: the total due is the sales tax report's", text.includes(fmt(tax.taxReturn.total.totalDue)) && /For review: stock used by the shop itself/.test(text) && text.includes(fmt(1.38)));
  const line1 = Math.round((tax.taxReturn.total.grossSales + tax.taxReturn.total.shipping) * 100) / 100;
  ok("revenue: line 1 gross receipts from the same sales figures", text.includes(fmt(line1)) && /Returns and allowances/.test(text));
  const inv = data.inventory, t = inv.transfers;
  const l40 = Math.round((inv.rollForward.beginning + t.beginning.value + t.notYetSold.beginning + inv.totals.purchases + t.totals.purchases + inv.totals.corrections) * 100) / 100;
  const l42 = Math.round((l40 - (inv.rollForward.ending + t.ending.value + t.notYetSold.ending)) * 100) / 100;
  ok("cost of goods: Part III lines 35–42 from the inventory report's roll-forward", /Inventory at beginning of period/.test(text) && text.includes(fmt(l42)) && l42 > 0);
  ok("…with the stock-count correction (−$4) on line 39", inv.totals.corrections === -4 && /Other costs: stock count corrections/.test(text) && text.includes(fmt(-4)));
  ok("start-up costs: only the expense before the first sale", /Business license/.test(doc.querySelectorAll("section")[6].textContent) && !/Stabilizer/.test(doc.querySelectorAll("section")[6].textContent));
  ok("receivables and exempt sales: O2 owing, the school's certificate MISSING", /O2/.test(text) && /MISSING/.test(text) && /Example School/.test(text));
  ok("first-year decisions page with a line for each", doc.querySelectorAll(".dec").length === 9);
  const some = w.taxPacketHtml_(data, ["salestax", "cogs"], { business: "Test Shop" });
  ok("unticked sections are left out", (some.match(/<section/g) || []).length === 2 && !/First-year decisions/.test(some) && !/Also bring/.test(some) && /Schedule C Part III/.test(some));
  ok("nothing ticked: says so", /No sections are ticked/.test(w.taxPacketHtml_(data, [], {})));

  const app = w.document.getElementById("app");
  await w.renderTaxPacket(app);
  await new Promise(res => setTimeout(res, 300));
  ok("the page: a checkbox per section, all ticked at first, and a preview", w.document.querySelectorAll(".tpSec").length === all.length &&
    [...w.document.querySelectorAll(".tpSec")].every(c => c.checked) && /<section/.test(w.document.getElementById("tpPreview").srcdoc));
  const box = w.document.querySelector('.tpSec[value="decisions"]');
  box.checked = false; box.dispatchEvent(new w.Event("change"));
  ok("unticking a section remembers it and redraws the preview without it", JSON.parse(w.localStorage.getItem("odd.taxPacket.sections")).indexOf("decisions") === -1 &&
    !/First-year decisions/.test(w.document.getElementById("tpPreview").srcdoc));
  ok("the preview frame can't run anything", w.document.getElementById("tpPreview").getAttribute("sandbox") === "");
  const renderSrc = adminJs.slice(adminJs.indexOf("async function renderTaxPacket("), adminJs.indexOf("async function renderBooks("));
  ok("printing writes the packet as it is and prints it from this page (no script in the packet)", /printPopupWhenReady_\(packetWin\);/.test(renderSrc) && /packetWin\.document\.write\(html\(\)\);/.test(renderSrc));
  ok("dates use the business's calendar: To defaults to the report day", /const today = reportToDay_\(\)/.test(renderSrc));

  console.log(`\n${failed ? failed + " failed" : "all passed"}`);
  if (failed) process.exit(1);
})().catch(e => { console.log("test201 crashed:", false); console.error(e); process.exit(1); });
