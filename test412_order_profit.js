process.env.TZ = "UTC";
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");

// Profit per job (phase 8): db.js getOrderProfit (one order, the order window's Profit box) and getProfitReport (every
// order the sales report counts). Real db.js / orders.js / permissions.js on sql.js, every row written straight to the
// tables so each figure is exactly what the test says.
//   Revenue = goods (gross − the order's discount shared by line − the line's own refund, without tax; gift card and
//   cancelled lines left out) − refunds not tied to a line (without the tax inside them) + shipping charged (less the
//   shipping discount and shipping refunds) + the rush fee without its tax. Sales tax is never revenue.
//   Costs = consumed blanks and finished stock + estimated blanks for pieces not made (blank links, ready-to-ship
//   average cost) + consumed transfers, else an estimate for unfinished lines + decoration at today's prices + supplies
//   (the product's own, else the Pricing default) + live outside digitizing + fees on live payments + live postage.
//   marginPct is profit ÷ revenue to one decimal, null with no revenue.
//   The report: the sales report's orders (sale-date basis, business days in America/Chicago, not test, void or
//   gift-only), sorted by margin / profit / revenue / date, narrowed by shop, with totals; its reads are batched.
// Nothing here depends on the machine's date or zone: "now" is fixed and the business zone is saved.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const NOW = Date.parse("2026-12-15T18:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
globalThis.__FixedDate412 = FixedDate;
const L = new Function("const Date = globalThis.__FixedDate412;\n" +
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => { const r = request.headers.get('x-role') || 'admin'; return roleAllows(DEFAULT_ROLES[r] || null, need === 'staff' ? '*' : need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@example.test'; " + roles.adminAs({ roleFrom: "request.headers.get('x-role') || 'admin'" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {}, features: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, getOrderProfit, getProfitReport, PROFIT_REPORT_SORTS, getSalesReport };")();

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const fresh = async () => {
  const d = await createD1();
  d._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) d.execFile(read("migrations/" + f));
  // Rows are written straight to the tables, some naming a design, blank or transfer that isn't on file.
  d._raw.exec(`PRAGMA foreign_keys = OFF;
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('school','school','Example School District','t','t',1);
    INSERT INTO global_settings (key, value) VALUES ('locale', '{"timeZone":"America/Chicago","country":"US"}');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (1, 'Pat Example', 'Example School District', 'pat@example.com', 't', 't');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (2, '', '', 'sam@example.com', 't', 't');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (3, '', 'Example Booster Club', 'boosters@example.com', 't', 't');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (4, '', '', '', 't', 't');`);
  return d;
};
const q = (v) => v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
const insSql = (table, row) => `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`;
const ins = (d1, table, row) => d1._raw.exec(insSql(table, row));
const T = "2026-11-10T18:00:00.000Z";
// An order with its lines; anything not given is an ordinary, inclusive-tax order with nothing extra.
let itemSeq = 1000;
const order = (d1, id, o = {}, lines = []) => {
  ins(d1, "orders", Object.assign({ orderId: id, orgId: "club", customerName: "Walk-in Buyer", contact: "buyer@example.com", placedAt: T, taxMode: "inclusive" }, o));
  const ids = [];
  for (const l of lines) {
    const row = Object.assign({ id: ++itemSeq, orderId: id, orgId: o.orgId || "club", productId: "tee", name: "Example line", type: "shirt", qty: 1, lineTotalCents: 0, taxCents: 0, manufacturedQty: l.qty || 1 }, l);
    ins(d1, "order_items", row);
    ids.push(row.id);
  }
  return ids;
};
const product = (d1, p) => ins(d1, "products", Object.assign({ orgId: "club", type: "shirt", createdAt: "t", updatedAt: "t" }, p));
const pay = (d1, orderId, p) => ins(d1, "order_payments", Object.assign({ orderId, receivedAt: T, kind: "payment", method: "card" }, p));
const mv = (d1, table, p) => ins(d1, table, Object.assign({ occurredAt: T, createdAt: T }, p));
const setting = (d1, key, v) => d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES (${q(key)}, ${q(JSON.stringify(v))})`);
const callOn = (d1) => async (body, role = "admin") => {
  const res = await L.post({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
    request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
  return { status: res.status, body: JSON.parse(await res.text()) };
};
const ZERO = { blanksCents: 0, transfersCents: 0, decorationCents: 0, suppliesCents: 0, digitizingCents: 0, cardFeesCents: 0, postageCents: 0, laborCents: 0 };
const costs = (c) => Object.assign({}, ZERO, c);
const N_REFUND = "Refunds not tied to a line are taken off the goods";
const N_BLANK = "Blank cost estimated for lines not yet made";
const N_TRANSFER = "Transfer cost estimated for lines not yet made";
const N_MISSING = "Some lines have no blank cost to go on";
const N_DEC = "Decoration cost uses today's settings";
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });

// The shop's products and price settings, shared by the first database.
const catalog = (d1) => {
  product(d1, { productId: "tee", name: "Example Tee", designId: 7, suppliesCostCents: 50 });                       // embroidery: no decoration cost
  product(d1, { productId: "hood", name: "Example Hoodie", decorationType: "dtf", transferCostCents: 300 });         // supplies: the Pricing default
  product(d1, { productId: "vin", name: "Example Vinyl Tee", decorationType: "vinyl", suppliesCostCents: 0 });
  product(d1, { productId: "stockp", name: "Example Stock Tee", suppliesCostCents: 0, transferCostCents: 400 });
  product(d1, { productId: "flatp", name: "Example Flat Cap", pricingMode: "flat" });
  product(d1, { productId: "nbp", name: "Example Patch", noBlankNeeded: 1, suppliesCostCents: 10 });
  product(d1, { productId: "dl", name: "Example Download", digital: 1, noDesignNeeded: 1, suppliesCostCents: 999 });
  product(d1, { productId: "zp", name: "Example Unpriced Tee", suppliesCostCents: 0 });
  setting(d1, "pricing", { suppliesCents: 25 });
  setting(d1, "decorationPricing", { dtf: { costCents: 120 }, screenprint: { costCents: 40 }, vinyl: { costCents: 70 } });
  ins(d1, "blanks", { id: 1, name: "Example Blank Tee", createdAt: "t", updatedAt: "t" });
  ins(d1, "blank_sizes", { blankId: 1, color: "Navy", size: "L", purchasePriceCents: 0, vendorPriceCents: 450 });
  ins(d1, "blank_sizes", { blankId: 1, color: "White", size: "L", purchasePriceCents: 9999 });
  ins(d1, "blank_sizes", { blankId: 1, color: "White", size: "M", purchasePriceCents: 380, vendorPriceCents: 999 });
  ins(d1, "blank_sizes", { blankId: 1, color: "Grey", size: "", purchasePriceCents: 1100 });
  ins(d1, "blank_sizes", { blankId: 1, color: "Free", size: "", purchasePriceCents: 0 });
  ins(d1, "product_blank_links", { orgId: "club", productId: "tee", productColor: "Navy", productSize: "L", blankId: 1, blankColor: "Navy", blankSize: "L" });
  ins(d1, "product_blank_links", { orgId: "club", productId: "tee", productColor: "", productSize: "L", blankId: 1, blankColor: "White", blankSize: "L" });
  ins(d1, "product_blank_links", { orgId: "club", productId: "tee", productColor: "", productSize: "M", blankId: 1, blankColor: "White", blankSize: "M" });
  ins(d1, "product_blank_links", { orgId: "club", productId: "hood", productColor: "", productSize: "", blankId: 1, blankColor: "Grey", blankSize: "" });
  ins(d1, "product_blank_links", { orgId: "club", productId: "zp", productColor: "", productSize: "", blankId: 1, blankColor: "Free", blankSize: "" });
  ins(d1, "ready_to_ship", { orgId: "club", productId: "stockp", size: "S", variant: "", avgCostCents: 700, updatedAt: "t" });
  ins(d1, "ready_to_ship", { orgId: "club", productId: "stockp", size: "M", variant: "Navy", avgCostCents: 650, updatedAt: "t" });
  ins(d1, "ready_to_ship", { orgId: "club", productId: "stockp", size: "M", variant: "", avgCostCents: 9999, updatedAt: "t" });
  ins(d1, "ready_to_ship", { orgId: "club", productId: "flatp", size: "", variant: "", avgCostCents: 300, updatedAt: "t" });
  ins(d1, "transfers", { id: 1, name: "Example Front Transfer", purchasePriceCents: 210, createdAt: "t", updatedAt: "t" });
  ins(d1, "transfers", { id: 2, name: "Example Back Transfer", purchasePriceCents: 90, createdAt: "t", updatedAt: "t" });
};

(async () => {
  const d1 = await fresh();
  catalog(d1);
  const P = (id) => L.getOrderProfit(d1, id);

  console.log("=== The answer's shape ===");
  {
    order(d1, "SHAPE-1", {}, [{ lineTotalCents: 1000 }]);
    const p = await P("SHAPE-1");
    ok("an order's profit has its id, revenue (goods, shipping, rush), the eight cost parts, cost, profit, margin, estimated and notes",
      same(Object.keys(p), ["orderId", "revenueCents", "revenue", "costs", "costCents", "profitCents", "marginPct", "estimated", "notes"]) &&
      same(Object.keys(p.revenue), ["goodsCents", "shippingCents", "rushCents"]) && same(Object.keys(p.costs), Object.keys(ZERO)));
    ok("labor is 0 until run times are costed (phase 9)", p.costs.laborCents === 0);
    ok("a $10.00 tee with $0.50 of supplies: revenue 1000, cost 50, profit 950, margin 95%, nothing estimated, no notes",
      p.orderId === "SHAPE-1" && p.revenueCents === 1000 && p.costCents === 50 && p.profitCents === 950 && p.marginPct === 95 && p.estimated === false && same(p.notes, []));
    ok("no such order: null", (await P("NO-SUCH-ORDER")) === null);
    ok("no order id at all: null", (await P(null)) === null && (await P(undefined)) === null && (await P("")) === null);
    order(d1, "12345", {}, [{ lineTotalCents: 500 }]);
    ok("an order id given as a number is read as text", (await P(12345)) && (await P(12345)).orderId === "12345");
    order(d1, "SHAPE-TEST", { isTest: 1, voidedAt: T, shippedAt: "2020-01-01T00:00:00.000Z" }, [{ lineTotalCents: 700 }]);
    const t = await P("SHAPE-TEST");
    ok("one order's profit is worked out whatever it is (a test or void order, any date)", !!t && t.revenueCents === 700);
  }

  console.log("\n=== Revenue: goods, shipping and rush, never tax or gift cards ===");
  {
    // $42.40 for two tees (with $2.40 tax, $10.60 refunded on the line) and $21.20 for a hoodie ($1.20 tax); a $6.36
    // discount ($0.36 of it tax); $9 shipping less a $1 shipping code; a $10.60 rush fee with $0.60 tax; a $50 gift card
    // and a cancelled line, both left out. Refunds: $3 of shipping, the $10.60 line refund and $5.30 not tied to a line.
    order(d1, "REV-1", { discountCents: 636, discountTaxCents: 36, shippingCostCents: 900, shippingDiscountCents: 100, rushFeeCents: 1060, rushFeeTaxCents: 60 }, [
      { productId: "tee", qty: 2, lineTotalCents: 4240, taxCents: 240, refundCents: 1060 },
      { productId: "hood", qty: 1, lineTotalCents: 2120, taxCents: 120 },
      { productId: "__giftcard__", name: "Gift card", qty: 1, lineTotalCents: 5000, manufacturedQty: 0 },
      { productId: "hood", qty: 5, lineTotalCents: 9999, cancelDate: "2026-11-01", manufacturedQty: 0 }]);
    pay(d1, "REV-1", { amountCents: 20000, feeCents: 200 });
    pay(d1, "REV-1", { amountCents: 5000, feeCents: 999, voidedAt: T });
    pay(d1, "REV-1", { amountCents: -300, kind: "refund", shippingCents: 300 });
    pay(d1, "REV-1", { amountCents: -1060, kind: "refund" });
    pay(d1, "REV-1", { amountCents: -530, kind: "dispute" });
    pay(d1, "REV-1", { amountCents: -5000, kind: "refund", voidedAt: T });
    const p = await P("REV-1");
    // Goods: 4000 + 2000 net of tax; the $6.00 discount shared 400 / 200; the tee's refund 1000 without its tax: 4400.
    // The $5.30 not tied to a line, its tax taken out (4400 of the 4724 paid for goods): 494 off — 3906.
    ok("goods: net of tax, less each line's share of the discount and its own refund (without tax), less refunds not tied to a line (without tax): 3906",
      p.revenue.goodsCents === 3906);
    ok("shipping charged: $9 less the $1 shipping code less the $3 shipping refund", p.revenue.shippingCents === 500);
    ok("rush: the fee without its tax", p.revenue.rushCents === 1000);
    ok("revenue is the three together; the gift card, the cancelled line and every bit of sales tax are left out", p.revenueCents === 5406);
    ok("card fees: those on live payment rows only (the voided row's are left out)", p.costs.cardFeesCents === 200);
    ok("supplies: the tees' own $0.50 × 2 and the hoodie's Pricing default $0.25 — the cancelled hoodies cost nothing", p.costs.suppliesCents === 125);
    ok("decoration: the hoodie's DTF at today's $1.20 a piece; the embroidered tees add nothing", p.costs.decorationCents === 120);
    ok("cost, profit and margin follow (fees 200 + supplies 125 + decoration 120 = 445; 4961; 91.8%)", p.costCents === 445 && p.profitCents === 4961 && p.marginPct === 91.8);
    ok("the notes say a refund came off the goods and the decoration uses today's settings, in that order", same(p.notes, [N_REFUND, N_DEC]));
    ok("…and nothing is estimated", p.estimated === false);
  }
  {
    order(d1, "REV-EXCL", { taxMode: "exclusive", discountCents: 600, discountTaxCents: 36, rushFeeCents: 1000, rushFeeTaxCents: 60 },
      [{ lineTotalCents: 4000, taxCents: 240 }]);
    const p = await P("REV-EXCL");
    ok("tax added on top (exclusive): the line and the discount are already net, so goods are 4000 − 600", p.revenue.goodsCents === 3400);
    ok("…and the rush fee is all revenue (its tax was on top)", p.revenue.rushCents === 1000 && p.revenueCents === 4400);
    ok("…margin to one decimal (4350 of 4400: 98.9%)", p.marginPct === 98.9);
  }
  {
    order(d1, "REV-SHIPREF", { shippingCostCents: 500 }, [{ lineTotalCents: 1000 }]);
    pay(d1, "REV-SHIPREF", { amountCents: -800, kind: "refund", shippingCents: 800 });
    const p = await P("REV-SHIPREF");
    ok("a shipping refund bigger than the shipping charged leaves shipping at 0, not below", p.revenue.shippingCents === 0);
    ok("…and, being shipping, takes nothing off the goods (no note)", p.revenue.goodsCents === 1000 && same(p.notes, []));
  }
  {
    order(d1, "REV-NOGOODS", {}, [{ lineTotalCents: 1000, refundCents: 1000 }]);
    pay(d1, "REV-NOGOODS", { amountCents: -1500, kind: "refund" });
    const p = await P("REV-NOGOODS");
    ok("a line refunded in full has no goods left, and a further refund takes nothing more (no note)", p.revenue.goodsCents === 0 && same(p.notes, []));
    ok("no revenue at all: the margin is null, not 0 or a division by zero", p.revenueCents === 0 && p.marginPct === null);
    ok("…while its costs still count: a loss of the supplies", p.profitCents === -50);
  }
  {
    order(d1, "REV-BIGREF", {}, [{ lineTotalCents: 1000 }]);
    pay(d1, "REV-BIGREF", { amountCents: -5000, kind: "refund" });
    const p = await P("REV-BIGREF");
    ok("a refund not tied to a line bigger than the goods takes them to 0, never below", p.revenue.goodsCents === 0 && same(p.notes, [N_REFUND]));
  }
  {
    order(d1, "REV-CANCELREF", {}, [{ lineTotalCents: 1000 }, { lineTotalCents: 800, refundCents: 800, cancelDate: "2026-11-02", manufacturedQty: 0 }]);
    pay(d1, "REV-CANCELREF", { amountCents: -800, kind: "refund" });
    const p = await P("REV-CANCELREF");
    ok("money refunded for a cancelled line is that line's own refund: it takes nothing off the goods still sold", p.revenue.goodsCents === 1000 && same(p.notes, []));
  }
  {
    order(d1, "REV-GIFTREF", {}, [{ lineTotalCents: 1000 }, { productId: "__giftcard__", name: "Gift card", lineTotalCents: 2500, refundCents: 2500, manufacturedQty: 0 }]);
    pay(d1, "REV-GIFTREF", { amountCents: -2500, kind: "refund" });
    const p = await P("REV-GIFTREF");
    ok("a refund matching a gift card line's own refund is not one of the goods' line refunds: it comes off the goods", p.revenue.goodsCents === 0 && same(p.notes, [N_REFUND]));
  }
  {
    order(d1, "REV-ALLCANCEL", { shippingCostCents: 900, rushFeeCents: 1000 }, [{ lineTotalCents: 1000, cancelDate: "2026-11-02", manufacturedQty: 0 }]);
    const p = await P("REV-ALLCANCEL");
    ok("every line cancelled: no goods, no shipping and no rush (nothing left on the order), and no costs", p.revenueCents === 0 && p.costCents === 0 && p.marginPct === null);
  }

  console.log("\n=== Costs used on the order ===");
  {
    const [it] = order(d1, "COST-1", {}, [{ qty: 3, lineTotalCents: 9000 }]);
    order(d1, "COST-OTHER", {}, [{ lineTotalCents: 100 }]);
    mv(d1, "inventory_movements", { blankId: 1, orderId: "COST-1", itemId: it, kind: "consume", qtyDelta: -3, unitCostCents: 400 });
    mv(d1, "inventory_movements", { blankId: 1, orderId: "COST-1", itemId: it, kind: "consume", qtyDelta: -1, unitCostCents: 999, voidedAt: T });
    mv(d1, "inventory_movements", { blankId: 1, orderId: "COST-1", itemId: it, kind: "consume", qtyDelta: -1, unitCostCents: 777, reason: "finished" });
    mv(d1, "inventory_movements", { blankId: 1, orderId: "COST-1", itemId: it, kind: "purchase", qtyDelta: 10, unitCostCents: 500 });
    mv(d1, "inventory_movements", { blankId: 1, orderId: "COST-OTHER", kind: "consume", qtyDelta: -1, unitCostCents: 5555 });
    mv(d1, "finished_goods_movements", { orgId: "club", productId: "tee", orderId: "COST-1", itemId: it, kind: "sell", qtyDelta: -2, unitCostCents: 900 });
    mv(d1, "finished_goods_movements", { orgId: "club", productId: "tee", orderId: "COST-1", itemId: it, kind: "return", qtyDelta: 1, unitCostCents: 900 });
    mv(d1, "finished_goods_movements", { orgId: "club", productId: "tee", orderId: "COST-1", itemId: it, kind: "sell", qtyDelta: -1, unitCostCents: 888, voidedAt: T });
    mv(d1, "finished_goods_movements", { orgId: "club", productId: "tee", orderId: "COST-1", itemId: it, kind: "make", qtyDelta: 4, unitCostCents: 600 });
    mv(d1, "transfer_movements", { transferId: 1, orderId: "COST-1", itemId: it, kind: "consume", qtyDelta: -3, unitCostCents: 150 });
    mv(d1, "transfer_movements", { transferId: 1, orderId: "COST-1", itemId: it, kind: "consume", qtyDelta: -1, unitCostCents: 999, voidedAt: T });
    mv(d1, "transfer_movements", { transferId: 1, orderId: "COST-1", itemId: it, kind: "consume", qtyDelta: -1, unitCostCents: 888, reason: "finished" });
    mv(d1, "transfer_movements", { transferId: 1, orderId: "COST-1", itemId: it, kind: "purchase", qtyDelta: 20, unitCostCents: 100 });
    ins(d1, "digitizing_jobs", { orderId: "COST-1", name: "Example Crest", sentAt: T, createdAt: T, costCents: 2500 });
    ins(d1, "digitizing_jobs", { orderId: "COST-1", name: "Example Crest (redo)", sentAt: T, createdAt: T, costCents: 4000, deletedAt: T });
    ins(d1, "shipping_labels", { orderId: "COST-1", shippoTransactionId: "tx-1", amountCents: 845, purchasedAt: T });
    ins(d1, "shipping_labels", { orderId: "COST-1", shippoTransactionId: "tx-2", amountCents: 600, purchasedAt: T, voidedAt: T });
    pay(d1, "COST-1", { amountCents: 9000, feeCents: 175 });
    pay(d1, "COST-1", { amountCents: 9000, feeCents: 999, voidedAt: T });
    const p = await P("COST-1");
    ok("blanks: the blanks consumed ($4 × 3) plus finished stock sold less returned ($9 × 2 − $9) — voided, finished-stock-making and received rows left out",
      p.costs.blanksCents === 2100);
    ok("transfers: those consumed ($1.50 × 3) — voided, finished-stock-making and received rows left out", p.costs.transfersCents === 450);
    ok("outside digitizing: live jobs only (the deleted redo is left out)", p.costs.digitizingCents === 2500);
    ok("postage: live labels only (the voided one is left out)", p.costs.postageCents === 845);
    ok("card fees: live payments only", p.costs.cardFeesCents === 175);
    ok("supplies: $0.50 × 3; decoration none (embroidery)", p.costs.suppliesCents === 150 && p.costs.decorationCents === 0);
    ok("another order's movements stay on that order", (await P("COST-OTHER")).costs.blanksCents === 5555);
    ok("cost 6220 of 9000: profit 2780, margin 30.9%", p.costCents === 6220 && p.profitCents === 2780 && p.marginPct === 30.9);
    ok("all of it recorded, so nothing is estimated and there are no notes", p.estimated === false && same(p.notes, []));
  }
  {
    order(d1, "COGS-EST", {}, [
      { lineTotalCents: 2000, cogsSource: "estimate", cogsCents: 333 },
      { lineTotalCents: 0, cogsSource: "estimate", cogsCents: 0 },
      { lineTotalCents: 0, cogsSource: "consumed", cogsCents: 999 }]);
    const p = await P("COGS-EST");
    ok("a line made before stock was tracked carries its estimated blank cost (cogsSource estimate); a recorded one's cogsCents isn't counted twice",
      p.costs.blanksCents === 333);
    ok("…and makes the profit an estimate, with the blank note", p.estimated === true && same(p.notes, [N_BLANK]));
  }

  console.log("\n=== Blanks for pieces not made yet ===");
  {
    order(d1, "BLANK-LINK", {}, [
      { productId: "tee", size: "L", qty: 4, manufacturedQty: 1, lineTotalCents: 6000, configJson: JSON.stringify({ garmentColor: "Navy" }) },
      { productId: "tee", size: "M", qty: 2, manufacturedQty: 0, lineTotalCents: 3000, configJson: JSON.stringify({ garmentColor: "Red" }) }]);
    const p = await P("BLANK-LINK");
    ok("the pieces left take the linked blank's price: the color's own link (Navy L, its vendor price $4.50 when the purchase price is 0) × 3 and the any-color link (M, its purchase price $3.80) × 2",
      p.costs.blanksCents === 1350 + 760);
    ok("…an estimate, with its note and no missing-cost note", p.estimated === true && same(p.notes, [N_BLANK]));
    ok("supplies count every piece ordered, made or not", p.costs.suppliesCents === 300);
  }
  {
    order(d1, "BLANK-STOCK", {}, [
      { productId: "stockp", size: "S", qty: 2, manufacturedQty: 0, fromStock: 1, lineTotalCents: 4000 },
      { productId: "stockp", size: "M", qty: 1, manufacturedQty: 0, fromStock: 1, stockVariant: "Navy", lineTotalCents: 2000 },
      { productId: "flatp", size: "XL", qty: 1, manufacturedQty: 0, fromStock: 1, lineTotalCents: 1500 }]);
    const p = await P("BLANK-STOCK");
    ok("a line filled from finished stock takes the stock's average cost: size S $7 × 2, size M in Navy $6.50, a flat-priced cap (no size) $3",
      p.costs.blanksCents === 1400 + 650 + 300);
    ok("…an estimate; no transfers are estimated for stock lines (they were used when the stock was made)", p.estimated === true && p.costs.transfersCents === 0 && same(p.notes, [N_BLANK]));
    ok("supplies: a product's own 0 stays 0, a product without its own takes the Pricing default", p.costs.suppliesCents === 25);
  }
  {
    order(d1, "BLANK-NOSTOCK", {}, [{ productId: "stockp", size: "XS", qty: 1, manufacturedQty: 0, fromStock: 1, lineTotalCents: 2000 }]);
    const p = await P("BLANK-NOSTOCK");
    ok("a stock line with no stock cost to go on: nothing added, not an estimate, and the missing-cost note", p.costs.blanksCents === 0 && p.estimated === false && same(p.notes, [N_MISSING]));
  }
  {
    order(d1, "BLANK-CUSTOM", {}, [{ productId: "__custom__", name: "Example custom job", qty: 2, manufacturedQty: 0, lineTotalCents: 5000 }]);
    const p = await P("BLANK-CUSTOM");
    ok("a custom line not made yet has no blank to price: the missing-cost note, nothing estimated, no supplies", p.costs.blanksCents === 0 && p.estimated === false &&
      p.costs.suppliesCents === 0 && same(p.notes, [N_MISSING]));
  }
  {
    order(d1, "BLANK-ZERO", {}, [{ productId: "zp", qty: 1, manufacturedQty: 0, lineTotalCents: 2000 }]);
    const p = await P("BLANK-ZERO");
    ok("a linked blank with no price: the missing-cost note, nothing estimated", p.costs.blanksCents === 0 && p.estimated === false && same(p.notes, [N_MISSING]));
  }
  {
    order(d1, "BLANK-NONE", {}, [
      { productId: "tee", size: "L", qty: 1, manufacturedQty: 0, customerOwned: 1, lineTotalCents: 1500, configJson: JSON.stringify({ garmentColor: "Navy" }) },
      { productId: "nbp", qty: 1, manufacturedQty: 0, lineTotalCents: 800 },
      { productId: "dl", qty: 1, manufacturedQty: 0, lineTotalCents: 500 }]);
    const p = await P("BLANK-NONE");
    ok("the customer's own garment, a no-blank product and a download need no blank: nothing estimated, no notes", p.costs.blanksCents === 0 && p.estimated === false && same(p.notes, []));
    ok("supplies: the customer-owned tee's and the patch's, never a download's", p.costs.suppliesCents === 60);
  }

  console.log("\n=== Transfers for lines not finished ===");
  {
    order(d1, "TR-PRODUCT", {}, [{ productId: "hood", qty: 3, manufacturedQty: 1, lineTotalCents: 9000 }]);
    const p = await P("TR-PRODUCT");
    ok("an unfinished line with no transfers used yet: the product's own transfer cost ($3) for every piece, made or not", p.costs.transfersCents === 900);
    ok("…its blanks left from the any-color link ($11 × 2) and its DTF decoration ($1.20 × 3)", p.costs.blanksCents === 2200 && p.costs.decorationCents === 360);
    ok("…estimated, with the blank, transfer and decoration notes in that order", p.estimated === true && same(p.notes, [N_BLANK, N_TRANSFER, N_DEC]));
  }
  {
    order(d1, "TR-CONFIG", {}, [{ productId: "tee", qty: 2, manufacturedQty: 0, customerOwned: 1, lineTotalCents: 6000,
      configJson: JSON.stringify({ locations: [{ location: "Front", kind: "transfer", transferId: 1 }, { location: "Back", kind: "transfer", transferId: 2 },
        { location: "Sleeve", kind: "transfer", transferId: 99 }] }) }]);
    const p = await P("TR-CONFIG");
    ok("a line's chosen transfers: their prices together ($2.10 + $0.90; one no longer on file adds nothing) for every piece", p.costs.transfersCents === 600);
    ok("…estimated, with the transfer note", p.estimated === true && p.notes.includes(N_TRANSFER) && !p.notes.includes(N_BLANK));
  }
  {
    const [a] = order(d1, "TR-USED", {}, [
      { productId: "hood", qty: 2, manufacturedQty: 1, lineTotalCents: 6000 },
      { productId: "hood", qty: 1, manufacturedQty: 0, lineTotalCents: 3000 }]);
    mv(d1, "transfer_movements", { transferId: 1, orderId: "TR-USED", itemId: a, kind: "consume", qtyDelta: -1, unitCostCents: 100 });
    const p = await P("TR-USED");
    ok("a line whose transfers were already consumed isn't estimated again; another unfinished line on the order still is ($1 used + $3 estimated)", p.costs.transfersCents === 400);
  }
  {
    order(d1, "TR-NONE", {}, [{ productId: "tee", qty: 2, manufacturedQty: 0, customerOwned: 1, lineTotalCents: 3000 }]);
    const p = await P("TR-NONE");
    ok("an unfinished line with no transfers and a product with no transfer cost: nothing, not an estimate", p.costs.transfersCents === 0 && p.estimated === false);
  }

  console.log("\n=== Decoration, at today's prices ===");
  {
    order(d1, "DEC-LOCS", {}, [{ productId: "tee", qty: 2, customerOwned: 1, lineTotalCents: 6000,
      configJson: JSON.stringify({ locations: [{ location: "Front", decoration: "screenprint", colors: 3 }, { location: "Back", kind: "transfer" },
        { location: "Sleeve", kind: "embroidery" }, { decoration: "vinyl" }] }) }]);
    const p = await P("DEC-LOCS");
    ok("each location priced by its own type: 3-color screen print ($0.40 × 3) + a transfer (DTF $1.20) + embroidery (0); an entry with no location is skipped; × 2 pieces",
      p.costs.decorationCents === (120 + 120) * 2);
    ok("…with the today's-settings note", same(p.notes, [N_DEC]));
  }
  {
    order(d1, "DEC-PRODUCT", {}, [{ productId: "vin", qty: 3, lineTotalCents: 6000 }]);
    const p = await P("DEC-PRODUCT");
    ok("a line with no locations takes its product's type (vinyl $0.70 × 3)", p.costs.decorationCents === 210);
    setting(d1, "decorationPricing", { dtf: { costCents: 120 }, screenprint: { costCents: 40 }, vinyl: { costCents: 100 } });
    const q2 = await P("DEC-PRODUCT");
    ok("…and today's price is used: the same order costs $1.00 × 3 once vinyl's cost changes", q2.costs.decorationCents === 300);
    setting(d1, "decorationPricing", { dtf: { costCents: 120 }, screenprint: { costCents: 40 }, vinyl: { costCents: 70 } });
  }

  console.log("\n=== Supplies ===");
  {
    order(d1, "SUP-DEFAULT", {}, [{ productId: "hood", qty: 2, lineTotalCents: 6000 }]);
    ok("a product with no supplies cost of its own takes the Pricing default per piece", (await P("SUP-DEFAULT")).costs.suppliesCents === 50);
    d1._raw.exec("DELETE FROM global_settings WHERE key = 'pricing'");
    ok("…which is 0 when Pricing was never saved", (await P("SUP-DEFAULT")).costs.suppliesCents === 0);
    setting(d1, "pricing", { suppliesCents: -40 });
    ok("…and never below 0", (await P("SUP-DEFAULT")).costs.suppliesCents === 0);
    setting(d1, "pricing", { suppliesCents: 25 });
  }

  console.log("\n=== Margin ===");
  {
    order(d1, "MARGIN-NEG", {}, [{ lineTotalCents: 1000 }]);
    ins(d1, "digitizing_jobs", { orderId: "MARGIN-NEG", name: "Example Logo", sentAt: T, createdAt: T, costCents: 2500 });
    const p = await P("MARGIN-NEG");
    ok("costs above revenue: a loss and a negative margin (−1550 on 1000: −155%)", p.profitCents === -1550 && p.marginPct === -155);
    order(d1, "MARGIN-THIRD", {}, [{ productId: "vin", lineTotalCents: 3000, customerOwned: 1 }]);
    ins(d1, "digitizing_jobs", { orderId: "MARGIN-THIRD", name: "Example Logo", sentAt: T, createdAt: T, costCents: 930 });
    ok("a margin is rounded to one decimal (2000 of 3000: 66.7%)", (await P("MARGIN-THIRD")).marginPct === 66.7);
  }

  console.log("\n=== The admin action ===");
  {
    const call = callOn(d1);
    const r = await call({ action: "getOrderProfit", orderId: "COST-1" });
    ok("getOrderProfit answers the order's profit, the same as db.js", r.status === 200 && same(r.body.profit, await P("COST-1")));
    ok("…an order that doesn't exist is not found", (await call({ action: "getOrderProfit", orderId: "NO-SUCH-1" })).status === 404);
    ok("…a role without costs.view (Production) is refused", (await call({ action: "getOrderProfit", orderId: "COST-1" }, "production")).status === 403);
  }

  // ---- The report ----
  console.log("\n=== The report: which orders (America/Chicago business days, November 2026) ===");
  const r2 = await fresh();
  product(r2, { productId: "tee", name: "Example Tee", designId: 7, suppliesCostCents: 50 });
  product(r2, { productId: "tee", orgId: "school", name: "Example Tee", designId: 7, suppliesCostCents: 50 });
  ins(r2, "blanks", { id: 1, name: "Example Blank Tee", createdAt: "t", updatedAt: "t" });
  ins(r2, "blank_sizes", { blankId: 1, color: "White", size: "M", purchasePriceCents: 400 });
  ins(r2, "product_blank_links", { orgId: "club", productId: "tee", productColor: "", productSize: "M", blankId: 1, blankColor: "White", blankSize: "M" });
  // Nov 1 2026 begins at 05:00 UTC in Chicago (still daylight time at midnight); Nov 30 ends at 05:59:59.999 UTC on Dec 1.
  order(r2, "R1", { customerId: 1, shippedAt: "2026-11-01T05:00:00.000Z", placedAt: "2026-10-30T18:00:00.000Z" }, [{ lineTotalCents: 10000 }]);
  pay(r2, "R1", { amountCents: 10000, feeCents: 300 });
  order(r2, "R2", { orgId: "school", customerId: 3, shippedAt: "2026-12-01T05:59:59.999Z", placedAt: "2026-11-20T18:00:00.000Z" }, [{ lineTotalCents: 5000 }]);
  ins(r2, "digitizing_jobs", { orderId: "R2", name: "Example Crest", sentAt: T, createdAt: T, costCents: 4000 });
  order(r2, "R4", { customerId: 99, customerName: "Walk-in Buyer", deliveredAt: "2026-11-10T18:00:00.000Z" }, [{ lineTotalCents: 2000 }]);
  ins(r2, "shipping_labels", { orderId: "R4", shippoTransactionId: "tx-r4", amountCents: 2500, purchasedAt: T });
  order(r2, "R5", { customerId: 2, completedAt: "2026-11-15T18:00:00.000Z" }, [{ lineTotalCents: 0 }]);
  order(r2, "R7", { customerName: "", contact: "buyer@example.com", shippedAt: "2026-11-20T18:00:00.000Z" },
    [{ size: "M", qty: 1, manufacturedQty: 0, lineTotalCents: 3000 }, { productId: "__giftcard__", name: "Gift card", lineTotalCents: 2500, manufacturedQty: 0 }]);
  order(r2, "R8", { customerId: 4, customerName: "Typed Name", shippedAt: "2026-11-25T18:00:00.000Z" }, [{ lineTotalCents: 10000 }]);
  pay(r2, "R8", { amountCents: 10000, feeCents: 300 });
  // Left out:
  order(r2, "R0", { shippedAt: "2026-11-01T04:59:59.999Z" }, [{ lineTotalCents: 1111 }]);                 // Oct 31 in Chicago
  order(r2, "R3", { shippedAt: "2026-12-01T06:00:00.000Z", placedAt: "2026-11-29T18:00:00.000Z" }, [{ lineTotalCents: 1111 }]);   // Dec 1 in Chicago
  order(r2, "R6", { placedAt: "2026-11-05T18:00:00.000Z" }, [{ lineTotalCents: 1111 }]);                    // not shipped yet
  order(r2, "RT", { isTest: 1, shippedAt: "2026-11-12T18:00:00.000Z" }, [{ lineTotalCents: 1111 }]);
  order(r2, "RV", { voidedAt: T, shippedAt: "2026-11-12T18:00:00.000Z" }, [{ lineTotalCents: 1111 }]);
  order(r2, "RG", { shippedAt: "2026-11-12T18:00:00.000Z" }, [{ productId: "__giftcard__", name: "Gift card", lineTotalCents: 5000, manufacturedQty: 0 }]);
  order(r2, "RGHOST", { orgId: "ghost", shippedAt: "2026-10-15T18:00:00.000Z" }, [{ lineTotalCents: 1111 }]);
  const R = (opts = {}) => L.getProfitReport(r2, Object.assign({ dateFrom: "2026-11-01", dateTo: "2026-11-30" }, opts));
  const ids = (rep) => rep.rows.map(r => r.orderId);
  {
    const rep = await R();
    ok("the report answers its dates, the sale-date basis, its sort, rows and totals",
      rep.dateFrom === "2026-11-01" && rep.dateTo === "2026-11-30" && rep.basis === "shipped" && rep.sort === "margin" && Array.isArray(rep.rows) && !!rep.totals);
    ok("orders sold in the business's November on the shipped basis (shipped, else delivered, else completed), from its first instant to its last",
      same([...ids(rep)].sort(), ["R1", "R2", "R4", "R5", "R7", "R8"]));
    ok("…not one shipped a millisecond before Nov 1 or after Nov 30 there, not one unshipped, not a test, void or gift-card-only order",
      !["R0", "R3", "R6", "RT", "RV", "RG"].some(id => ids(rep).includes(id)));
    const row = (id) => rep.rows.find(r => r.orderId === id);
    ok("a row has the order, its shop and name, customer, sale day, revenue, cost, profit, margin, estimated, the cost and revenue parts and notes",
      same(Object.keys(row("R1")), ["orderId", "orgId", "orgName", "customerName", "saleDate", "revenueCents", "costCents", "profitCents", "marginPct", "estimated", "costs", "revenue", "notes"]));
    ok("the sale day is the business's day: Nov 1 for the first instant, Nov 30 for 05:59 UTC on Dec 1", row("R1").saleDate === "2026-11-01" && row("R2").saleDate === "2026-11-30");
    ok("the shop's name", row("R1").orgName === "Example Club" && row("R2").orgName === "Example School District" && row("R2").orgId === "school");
    ok("the customer: the record's name, else its company, else its email", row("R1").customerName === "Pat Example" && row("R2").customerName === "Example Booster Club" &&
      row("R5").customerName === "sam@example.com");
    ok("…a record with nothing on it is named by its number", row("R8").customerName === "Customer 4");
    ok("…a customer number with no record: the name typed on the order; no name: the contact", row("R4").customerName === "Walk-in Buyer" && row("R7").customerName === "buyer@example.com");
    {
      const own = await L.getOrderProfit(r2, "R7");
      ok("each row carries the order's own profit", Object.keys(own).every(k => same(row("R7")[k], own[k])));
    }
    ok("the gift card sold on R7 is not revenue; its unmade tee's blank is estimated", row("R7").revenueCents === 3000 && row("R7").costs.blanksCents === 400 && row("R7").estimated === true);
    ok("totals: 6 orders, revenue 30000, cost 7800, profit 22200, margin 74%, 1 estimated",
      same(rep.totals, { orders: 6, revenueCents: 30000, costCents: 7800, profitCents: 22200, marginPct: 74, estimatedCount: 1 }));
    const sales = await L.getSalesReport(r2, { dateFrom: "2026-11-01", dateTo: "2026-11-30" });
    ok("the same orders as the sales report, and with no refunds the goods add up to its net sales",
      sales.totals.orders === rep.totals.orders && sales.totals.netCents === rep.rows.reduce((s, r) => s + r.revenue.goodsCents, 0));
  }
  {
    const oct = await R({ dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    ok("October holds the order shipped a millisecond before Chicago's Nov 1, dated Oct 31", oct.rows.some(r => r.orderId === "R0" && r.saleDate === "2026-10-31"));
    ok("an order whose shop is gone shows its shop id for the name", oct.rows.some(r => r.orderId === "RGHOST" && r.orgName === "ghost"));
  }

  console.log("\n=== The report's sorts ===");
  {
    ok("the sorts: margin, profit, revenue, date", same(L.PROFIT_REPORT_SORTS, ["margin", "profit", "revenue", "date"]));
    ok("by margin (the default): lowest first, a tie goes to the newer sale, no revenue last", same(ids(await R()), ["R4", "R2", "R7", "R8", "R1", "R5"]));
    ok("by profit: highest first, a tie to the newer sale", same(ids(await R({ sort: "profit" })), ["R8", "R1", "R7", "R2", "R5", "R4"]));
    ok("by revenue: most first, a tie to the newer sale", same(ids(await R({ sort: "revenue" })), ["R8", "R1", "R2", "R7", "R4", "R5"]));
    ok("by date: newest sale first", same(ids(await R({ sort: "date" })), ["R2", "R8", "R7", "R5", "R4", "R1"]));
    const odd = await R({ sort: "cost" });
    ok("a sort it doesn't know falls back to margin", odd.sort === "margin" && same(ids(odd), ["R4", "R2", "R7", "R8", "R1", "R5"]));
    order(r2, "R9", { shippedAt: "2026-11-25T20:00:00.000Z" }, [{ lineTotalCents: 10000 }]);
    pay(r2, "R9", { amountCents: 10000, feeCents: 300 });
    ok("the same sale day: the later order id first", same(ids(await R({ sort: "date" })).slice(0, 3), ["R2", "R9", "R8"]));
    r2._raw.exec("DELETE FROM order_payments WHERE orderId = 'R9'; DELETE FROM order_items WHERE orderId = 'R9'; DELETE FROM orders WHERE orderId = 'R9';");
  }

  console.log("\n=== The report narrowed, empty, refused and on the placed basis ===");
  {
    const school = await R({ orgId: "school" });
    ok("one shop only: its orders and their totals", same(ids(school), ["R2"]) && school.totals.orders === 1 && school.totals.revenueCents === 5000);
    ok("…the other shop's", same([...ids(await R({ orgId: "club" }))].sort(), ["R1", "R4", "R5", "R7", "R8"]));
    const none = await R({ dateFrom: "2025-01-01", dateTo: "2025-01-31" });
    ok("a month with no sales: no rows, zero totals and no margin",
      none.rows.length === 0 && same(none.totals, { orders: 0, revenueCents: 0, costCents: 0, profitCents: 0, marginPct: null, estimatedCount: 0 }));
    ok("a day not written YYYY-MM-DD is refused", (await R({ dateFrom: "2026-11-1" })).error === "Choose the dates as YYYY-MM-DD." &&
      (await L.getProfitReport(r2, {})).error === "Choose the dates as YYYY-MM-DD.");
    ok("a start after the end is refused", (await R({ dateFrom: "2026-12-01" })).error === "The start date is after the end date.");
    setting(r2, "accounting", { saleDate: "placed" });
    const placed = await R();
    ok("on the placed basis the sale day is the order date: placed in November (unshipped ones too), not before",
      placed.basis === "placed" && ids(placed).includes("R6") && ids(placed).includes("R3") && !ids(placed).includes("R1"));
    ok("…dated on the placed day", placed.rows.find(r => r.orderId === "R2").saleDate === "2026-11-20");
    const salesPlaced = await L.getSalesReport(r2, { dateFrom: "2026-11-01", dateTo: "2026-11-30" });
    ok("…still the sales report's orders", salesPlaced.totals.orders === placed.totals.orders);
    r2._raw.exec("DELETE FROM global_settings WHERE key = 'accounting'");
  }
  {
    const call = callOn(r2);
    const r = await call({ action: "getProfitReport", dateFrom: "2026-11-01", dateTo: "2026-11-30", sort: "profit" });
    ok("the getProfitReport action answers the report with its sort", r.status === 200 && r.body.sort === "profit" && same(r.body.rows.map(x => x.orderId), ids(await R({ sort: "profit" }))));
    ok("…a role without costs.view is refused", (await call({ action: "getProfitReport", dateFrom: "2026-11-01", dateTo: "2026-11-30" }, "production")).status === 403);
  }

  console.log("\n=== Many orders: batched reads ===");
  {
    const r3 = await fresh();
    product(r3, { productId: "tee", name: "Example Tee", designId: 7, suppliesCostCents: 50 });
    const COUNT = 905;
    let sql = "";
    for (let i = 0; i < COUNT; i++) {
      const id = "M" + String(i).padStart(4, "0"), day = String(1 + (i % 28)).padStart(2, "0");
      sql += insSql("orders", { orderId: id, orgId: "club", customerName: "Walk-in Buyer", contact: "buyer@example.com", placedAt: T, shippedAt: `2026-11-${day}T18:00:00.000Z`, customerId: 1 + (i % 3) });
      sql += insSql("order_items", { orderId: id, orgId: "club", productId: "tee", name: "Example line", type: "shirt", qty: 1, lineTotalCents: 1000 + i, manufacturedQty: 1 });
      sql += insSql("order_payments", { orderId: id, amountCents: 1000 + i, receivedAt: T, kind: "payment", feeCents: 10 });
      sql += insSql("shipping_labels", { orderId: id, shippoTransactionId: "tx-" + id, amountCents: 20, purchasedAt: T });
      sql += insSql("digitizing_jobs", { orderId: id, name: "Example Logo", sentAt: T, createdAt: T, costCents: 1 });
      sql += insSql("inventory_movements", { blankId: 1, orderId: id, kind: "consume", qtyDelta: -1, unitCostCents: 2, occurredAt: T, createdAt: T });
      sql += insSql("finished_goods_movements", { orgId: "club", productId: "tee", orderId: id, kind: "sell", qtyDelta: -1, unitCostCents: 3, occurredAt: T, createdAt: T });
      sql += insSql("transfer_movements", { transferId: 1, orderId: id, kind: "consume", qtyDelta: -1, unitCostCents: 4, occurredAt: T, createdAt: T });
    }
    r3._raw.exec(sql);
    const realPrepare = r3.prepare.bind(r3);
    let queries = 0;
    r3.prepare = (s) => { queries++; return realPrepare(s); };
    const rep = await L.getProfitReport(r3, { dateFrom: "2026-11-01", dateTo: "2026-11-30" });
    const revenue = COUNT * 1000 + (COUNT * (COUNT - 1)) / 2;
    ok("905 orders: every one is in the report", rep.rows.length === COUNT && rep.totals.orders === COUNT && new Set(ids(rep)).size === COUNT);
    ok("…every order's revenue counted once", rep.totals.revenueCents === revenue);
    ok("…and every cost part read for every order across the chunks (blanks, finished stock, transfers, digitizing, fees, postage, supplies)",
      rep.totals.costCents === COUNT * (2 + 3 + 4 + 1 + 10 + 20 + 50) && rep.rows.every(r => r.costs.blanksCents === 5 && r.costs.transfersCents === 4 &&
        r.costs.digitizingCents === 1 && r.costs.cardFeesCents === 10 && r.costs.postageCents === 20 && r.costs.suppliesCents === 50));
    ok("…every customer named", rep.rows.every(r => ["Pat Example", "sam@example.com", "Example Booster Club"].includes(r.customerName)));
    ok("…in a few dozen queries, not one or more per order", queries > 0 && queries <= 60);
    r3.prepare = realPrepare;
  }

  console.log("\n=== A database from before the stock, transfer and digitizing tables ===");
  {
    const r4 = await fresh();
    product(r4, { productId: "tee", name: "Example Tee", designId: 7, suppliesCostCents: 50 });
    const [it] = order(r4, "OLD-1", { customerId: 1, shippedAt: T }, [{ qty: 2, lineTotalCents: 4000 }, { qty: 1, manufacturedQty: 0, lineTotalCents: 2000, size: "M" }]);
    mv(r4, "inventory_movements", { blankId: 1, orderId: "OLD-1", itemId: it, kind: "consume", qtyDelta: -2, unitCostCents: 300 });
    ins(r4, "shipping_labels", { orderId: "OLD-1", shippoTransactionId: "tx-old", amountCents: 500, purchasedAt: T });
    const dropped = [];
    for (const t of ["finished_goods_movements", "transfer_movements", "digitizing_jobs", "product_designs", "transfers", "product_blank_links", "ready_to_ship", "customers"]) {
      try { r4._raw.exec("PRAGMA foreign_keys = OFF; DROP TABLE " + t); dropped.push(t); } catch (e) { console.log("could not drop " + t + " " + String(e.message).replace(/:/g, " ")); }
    }
    try { r4._raw.exec("ALTER TABLE inventory_movements DROP COLUMN reason"); dropped.push("reason"); } catch (e) { console.log("could not drop the reason column " + String(e.message).replace(/:/g, " ")); }
    ok("(the older database is set up: the newer tables and the movements' reason column are gone)", dropped.length === 9);
    const p = await L.getOrderProfit(r4, "OLD-1");
    ok("one order's profit still works: blanks from the movements it has, postage, supplies; the missing parts read 0",
      !!p && p.costs.blanksCents === 600 && p.costs.postageCents === 500 && p.costs.suppliesCents === 150 &&
      p.costs.transfersCents === 0 && p.costs.digitizingCents === 0 && p.revenueCents === 6000);
    ok("…the unmade line has no blank link table to go on: the missing-cost note", same(p.notes, [N_MISSING]) && p.estimated === false);
    const rep = await L.getProfitReport(r4, { dateFrom: "2026-11-01", dateTo: "2026-11-30" });
    ok("the report still works, naming the customer from the order when there's no customer table",
      rep.rows.length === 1 && rep.rows[0].customerName === "Walk-in Buyer" && rep.totals.costCents === p.costCents);
  }

  finished = true;
})();
