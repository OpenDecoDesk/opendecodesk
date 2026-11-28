const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Net 30 with a PO and customer-supplied garments (migrations/0121) in what the customer and the owner read:
//   functions/_lib/email.js — howToPay_'s Net 30 part (with a PO, without one, the days and when they start), the
//   invoice email (its subject, the terms under the totals, the due date counted from today on a first invoice),
//   the PDF (orderPdf) and the printable invoice (invoiceDocument) with their "Terms" line, the order received
//   email for a Net 30 order (nothing to pay now), the morning roll-up's Unpaid POs section, the new orders'
//   Payment cell, the quiet-morning email's watching line, and "(your garments)" on receipts and the quote view;
//   functions/api/daily-digest.js — the roll-up's part of the Unpaid POs report (POs to check, late ones, newly
//   late since the last roll-up, the totals), never a reason to send on its own;
//   public/admin-quotes.js — the quote editor's "Customer's own garment" tick (only with the feature on), saved as
//   customerOwned, and the Net 30 tick and PO box of Convert to order.
// Real SQL (sql.js), the real migrations, db.js, email.js, pdf.js, deliveryCheck.js, daily-digest.js, orders.js and
// the real admin page (jsdom). "Now" is fixed (the code's Date is replaced), and the business is in America/Chicago,
// so no check depends on this machine's date or zone. Invented people, shops and PO numbers only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js")), dbSrc = strip(read("functions/_lib/db.js"));
const emailSrc = strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" + strip(read("functions/_lib/email.js"));

// The code's clock: every `new Date()` / Date.now() inside the glued sources reads NOW.
let NOW = Date.parse("2026-12-01T15:00:00Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const M = new Function("Date", hostSrc + "\n" + httpSrc + "\n" +
  "function timingSafeEqual(a, b){ return typeof a === 'string' && a === b; }\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const checkSupplierShipments = async () => ({ checked: 0, errors: [] });\n" +
  dbSrc + "\n" + strip(read("functions/_lib/pdf.js")) + "\n" + emailSrc + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" + strip(read("functions/api/daily-digest.js")) + "\n" +
  "return { howToPay_, receiptLines_, orderPdf, invoiceDocument, buildInvoiceEmail, buildOrderReceivedEmail, previewMessage, sendDailyDigestEmail, sendDigestHeartbeatEmail, " +
  "  estimateLinesView, runDailyDigest, setTerms, setFeatures, createProduct, getTerms, setGlobalSettings, setBusinessProfile, insertOrder, setDigestState, getEstimate, fmt$ };")(FixedDate);

const sent = [];
global.fetch = async (url, init) => { if (captureMail(url, init, sent)) return MAIL_OK; return { ok: true, status: 200, json: async () => ({}) }; };
const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&rarr;/g, "→").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let pdfjs = null;
const pdfText = async (bytes) => {
  if (!pdfjs) pdfjs = await import("./node_modules/pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) out.push((await (await doc.getPage(n)).getTextContent()).items.map(i => i.str).join(" "));
  return out.join("\n").replace(/\s+/g, " ");
};
// A saved order as the loaders give it (no tax), $100.00 owed.
const order = (o = {}) => Object.assign({
  orderId: "EX-1001", orgId: "club", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check",
  items: [{ name: "Polo", size: "M", qty: 4, unitPrice: 25, lineTotal: 100, taxable: true }],
  shippingCost: 0, taxRate: 0, taxMode: "inclusive", salesTax: 0, effectiveTotal: 100, total: 100, amountReceived: 0, balanceDue: 100, paid: false,
  placedAt: "2026-11-20T16:00:00Z" }, o);
const net30 = (o = {}) => order(Object.assign({ paymentMethod: "Net 30", net30: true, poNumber: "1001", poAcceptedAt: "2026-11-21T16:00:00Z", poAcceptedBy: "pat@example.test",
  termsDays: null, invoicedAt: "2026-12-01T16:00:00Z", termsDueDate: "2026-12-31" }, o));
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1), ('school','school','Example School District','t','t',1);`);
  const env = { DB: d1, ROOT_DOMAIN: "example.com", SIGNING_SECRET: "s", TIMEZONE: "America/Chicago", CRON_SECRET: "c", ...MAIL_ENV };
  await M.setBusinessProfile(d1, { name: "Example Stitch", legalName: "Example Stitch LLC", mailingAddress: "1 Main St\nSpringfield", supportEmail: "help@example.com" });
  await M.setGlobalSettings(d1, { enabledPayments: { card: false, venmo: false, zelle: false, check: true } });

  console.log("=== How to pay: the Net 30 part ===");
  let pay = await M.howToPay_(env, net30());
  ok("a Net 30 order with a PO: “Net 30 · PO 1001 · Due Dec 31, 2026”", pay.terms && pay.terms.label === "Net 30 · PO 1001 · Due Dec 31, 2026");
  ok("…and “Payment is due within 30 days of the invoice (PO 1001).”", pay.terms.ask === "Payment is due within 30 days of the invoice (PO 1001).");
  ok("…both in the email's text, first under How to pay", /^How to pay \$100\.00:\n {2}Terms: Net 30 · PO 1001 · Due Dec 31, 2026\n {2}Payment is due within 30 days of the invoice \(PO 1001\)\.\nWays to pay:\n {2}Check:/.test(pay.text));
  ok("…and in its HTML, before the ways to pay", /<strong>Terms:<\/strong> Net 30 · PO 1001 · Due Dec 31, 2026<br>Payment is due within 30 days of the invoice \(PO 1001\)\.<\/div>\s*<div style="color:#555;margin:6px 0 2px">Ways to pay:<\/div><ul[^>]*><li><strong>Check:/.test(pay.html));
  ok("…its PO is known to be accepted", pay.terms.accepted === true && pay.terms.po === "1001" && pay.terms.days === 30 && pay.terms.startsAt === "invoice" && pay.terms.dueDay === "2026-12-31");
  ok("a PO typed by the customer and not yet accepted isn't counted as accepted", (await M.howToPay_(env, net30({ poAcceptedAt: "" }))).terms.accepted === false);
  pay = await M.howToPay_(env, net30({ poNumber: "PO-1001" }));
  ok("a PO number that already starts with “PO” is shown as it is: “Net 30 · PO-1001 · …”", pay.terms.label === "Net 30 · PO-1001 · Due Dec 31, 2026" && /\(PO-1001\)\.$/.test(pay.terms.ask));
  pay = await M.howToPay_(env, net30({ poNumber: "", poAcceptedAt: "" }));
  ok("no PO yet: the label has no PO, and the email asks for one — reply to this email", pay.terms.label === "Net 30 · Due Dec 31, 2026" &&
    pay.terms.ask === "Payment is due within 30 days of the invoice. Please send your PO number — reply to this email." && pay.terms.accepted === false);
  pay = await M.howToPay_(env, net30({ poNumber: "", poAcceptedAt: "" }), { inEmail: false });
  ok("…on paper (not an email) it asks without “reply to this email”", pay.terms.ask === "Payment is due within 30 days of the invoice. Please send your PO number.");
  pay = await M.howToPay_(env, net30({ termsDays: 45 }));
  ok("the order's own days: “Net 45”, “within 45 days”", pay.terms.label.startsWith("Net 45 · ") && /within 45 days/.test(pay.terms.ask));
  pay = await M.howToPay_(env, net30({ termsDueDate: "" }));
  ok("a due date not known yet is left out: “Net 30 · PO 1001”", pay.terms.label === "Net 30 · PO 1001" && pay.terms.due === "");
  pay = await M.howToPay_(env, net30({ termsDueDate: "soon" }));
  ok("…and so is one that isn't a day", pay.terms.label === "Net 30 · PO 1001");
  pay = await M.howToPay_(env, net30({ poNumber: "<b>1</b>" }));
  ok("a PO is text, never HTML, in the email", /PO &lt;b&gt;1&lt;\/b&gt;/.test(pay.html) && !/<b>1<\/b>/.test(pay.html));
  await M.setTerms(d1, { defaultDays: 60, startsAt: "order" });
  pay = await M.howToPay_(env, net30());
  ok("Global settings → Net 30 terms: 60 days from the order date — “Net 60”, “within 60 days of the order date”", pay.terms.label.startsWith("Net 60 · ") && pay.terms.ask === "Payment is due within 60 days of the order date (PO 1001).");
  ok("…the order's own days still win over the setting", (await M.howToPay_(env, net30({ termsDays: 15 }))).terms.label.startsWith("Net 15 · "));
  await M.setTerms(d1, { defaultDays: 30, startsAt: "completed" });
  pay = await M.howToPay_(env, net30());
  ok("days that start when the order is completed: “within 30 days of when your order ships or is picked up”", pay.terms.ask === "Payment is due within 30 days of when your order ships or is picked up (PO 1001).");
  await M.setTerms(d1, { defaultDays: 30, startsAt: "invoice" });
  pay = await M.howToPay_({}, net30({ orderId: "EX-2" }));
  ok("with no database to read the setting from, the terms are 30 days from the invoice", pay.terms.label === "Net 30 · PO 1001 · Due Dec 31, 2026" && /within 30 days of the invoice/.test(pay.terms.ask));
  pay = await M.howToPay_(env, order());
  ok("an order not on Net 30 has no terms part", pay.terms === null && !/Terms:/.test(pay.text + pay.html));
  await M.setGlobalSettings(d1, { enabledPayments: { card: false, venmo: false, zelle: false, check: false } });
  ok("with no way to pay offered at all, a Net 30 order's How to pay still has something to say (the terms)",
    (await M.howToPay_(env, net30({ paymentMethod: "" }))).any === true && (await M.howToPay_(env, order({ paymentMethod: "" }))).any === false);
  await M.setGlobalSettings(d1, { enabledPayments: { card: false, venmo: false, zelle: false, check: true } });

  console.log("\n=== The invoice PDF and the printable invoice ===");
  let t = await pdfText((await M.orderPdf(env, net30(), { kind: "invoice", orgName: "Example Club" })).bytes);
  ok("the PDF's details say “Terms Net 30 · PO 1001 · Due Dec 31, 2026”", /Terms Net 30 · PO 1001 · Due Dec 31, 2026/.test(t));
  ok("…and How to pay starts with the terms and what they mean", /How to pay \$100\.00 Terms: Net 30 · PO 1001 · Due Dec 31, 2026 Payment is due within 30 days of the invoice \(PO 1001\)\./.test(t));
  t = await pdfText((await M.orderPdf(env, net30({ paid: true, amountReceived: 100, balanceDue: 0 }), { kind: "receipt" })).bytes);
  ok("a Net 30 order paid in full: its receipt has no terms", /RECEIPT/.test(t) && !/Terms/.test(t));
  t = await pdfText((await M.orderPdf(env, order(), { kind: "invoice" })).bytes);
  ok("an invoice not on Net 30 has no terms", /INVOICE/.test(t) && !/Terms/.test(t));
  let doc = await M.invoiceDocument(env, net30(), { orgName: "Example Club" });
  ok("the printable invoice's details have a Terms row: Net 30 · PO 1001 · Due Dec 31, 2026", /<tr><td class="muted">Terms<\/td><td>Net 30 · PO 1001 · Due Dec 31, 2026<\/td><\/tr><\/table>/.test(doc.html));
  ok("…and its How to pay has the terms too", /<strong>Terms:<\/strong> Net 30 · PO 1001 · Due Dec 31, 2026<br>Payment is due within 30 days of the invoice \(PO 1001\)\./.test(doc.html));
  doc = await M.invoiceDocument(env, net30({ paid: true, amountReceived: 100, balanceDue: 0 }));
  ok("…paid in full: no Terms row", !/Terms/.test(doc.html) && /Paid in full/.test(doc.html));
  ok("…an order not on Net 30: no Terms row", !/Terms/.test((await M.invoiceDocument(env, order())).html));

  console.log("\n=== The invoice email ===");
  let m = await M.buildInvoiceEmail(env, { order: net30(), orgName: "Example Club", invoiceUrl: "https://club.example.com/?invoice=tok" });
  ok("subject: “Invoice — EX-1001 · $100.00 due by Dec 31, 2026”", m.subject === "Invoice — EX-1001 · $100.00 due by Dec 31, 2026");
  ok("…under the totals: the terms and what they mean", /<p style="font-size:14px"><strong>Terms:<\/strong> Net 30 · PO 1001 · Due Dec 31, 2026<br>Payment is due within 30 days of the invoice \(PO 1001\)\.<\/p>/.test(m.html));
  ok("…the same in the text, before the link", /Terms: Net 30 · PO 1001 · Due Dec 31, 2026\nPayment is due within 30 days of the invoice \(PO 1001\)\.\n\nView and pay: https:\/\/club\.example\.com\/\?invoice=tok/.test(m.text));
  NOW = Date.parse("2026-12-01T03:00:00Z");   // 9 pm on Nov 30 in Chicago
  m = await M.buildInvoiceEmail(env, { order: net30({ invoicedAt: "", termsDueDate: "2026-12-20" }), invoiceUrl: "https://club.example.com/?invoice=tok" });
  ok("the first invoice, days from the invoice: due 30 days from the business's today (Nov 30 in Chicago → Dec 30), not from the order date", m.subject === "Invoice — EX-1001 · $100.00 due by Dec 30, 2026" && /Due Dec 30, 2026/.test(m.text));
  m = await M.buildInvoiceEmail(env, { order: net30({ invoicedAt: "", termsDueDate: "2026-12-20", termsDays: 45 }), invoiceUrl: "https://club.example.com/?invoice=tok" });
  ok("…with the order's own 45 days: Jan 14, 2027", m.subject === "Invoice — EX-1001 · $100.00 due by Jan 14, 2027");
  m = await M.buildInvoiceEmail(env, { order: net30({ termsDueDate: "2026-12-20" }), invoiceUrl: "https://club.example.com/?invoice=tok" });
  ok("an invoice sent again keeps the due date from the first one", m.subject === "Invoice — EX-1001 · $100.00 due by Dec 20, 2026");
  await M.setTerms(d1, { startsAt: "order" });
  m = await M.buildInvoiceEmail(env, { order: net30({ invoicedAt: "", termsDueDate: "2026-12-20" }), invoiceUrl: "https://club.example.com/?invoice=tok" });
  ok("days from the order date: a first invoice keeps the order's due date", m.subject === "Invoice — EX-1001 · $100.00 due by Dec 20, 2026");
  await M.setTerms(d1, { startsAt: "completed" });
  m = await M.buildInvoiceEmail(env, { order: net30({ invoicedAt: "", termsDueDate: "" }), invoiceUrl: "https://club.example.com/?invoice=tok" });
  ok("days from completion, not completed yet: no date, the subject says “· Net 30”", m.subject === "Invoice — EX-1001 · $100.00 due · Net 30" && /Terms: Net 30 · PO 1001\n/.test(m.text));
  await M.setTerms(d1, { startsAt: "invoice" });
  NOW = Date.parse("2026-12-01T15:00:00Z");
  m = await M.buildInvoiceEmail(env, { order: order(), invoiceUrl: "https://club.example.com/?invoice=tok" });
  ok("an invoice not on Net 30: “Invoice — EX-1001 · $100.00 due”, no terms", m.subject === "Invoice — EX-1001 · $100.00 due" && !/Terms/.test(m.html + m.text));
  m = await M.buildInvoiceEmail(env, { order: net30({ paid: true, amountReceived: 100, balanceDue: 0 }), invoiceUrl: "https://club.example.com/?invoice=tok" });
  ok("a Net 30 order paid in full: no amount, no terms", m.subject === "Invoice — EX-1001" && !/Terms/.test(m.html + m.text));
  m = await M.buildInvoiceEmail(env, { order: net30(), orgName: "Example Club", invoiceUrl: "" });
  ok("with no invoice page (the desktop program): the terms come once, in How to pay", (m.text.match(/Terms: Net 30 · PO 1001 · Due Dec 31, 2026/g) || []).length === 1 && /How to pay \$100\.00:\n {2}Terms:/.test(m.text));
  ok("…and its printable invoice has the Terms row", m.pdf && /<td class="muted">Terms<\/td><td>Net 30 · PO 1001 · Due Dec 31, 2026<\/td>/.test(m.pdf.html));

  console.log("\n=== The order received email for a Net 30 order ===");
  m = await M.buildOrderReceivedEmail(env, net30({ invoicedAt: "" }));
  let pv = await M.previewMessage(env, m);
  ok("subject: “Order received — EX-1001 · Net 30, nothing to pay now”", pv.subject === "Order received — EX-1001 · Net 30, nothing to pay now");
  ok("…it says no payment is needed now, the invoice comes later, and when payment is due", /thank you — we received your order\. No payment is needed now: we'll send you an invoice, and payment is due within 30 days of the invoice\./.test(plain(pv.html)) &&
    /we received your order\. No payment is needed now: we'll send you an invoice, and payment is due within 30 days of the invoice\./.test(pv.text));
  ok("…not that work starts once it's paid, and no How to pay", !/once it's paid/.test(pv.html + pv.text) && !/How to pay/.test(pv.html + pv.text) && !/payable to/.test(pv.html + pv.text));
  ok("…its PDF is “a copy of your order”, not an invoice to pay", /A copy of your order is attached as a PDF\./.test(pv.html) && /A copy of your order is attached as a PDF\./.test(pv.text) && !/Your invoice is attached/.test(pv.html + pv.text));
  ok("…a Terms box: the PO is on file, work starts", /Terms: Net 30 · PO 1001 · Due Dec 31, 2026 Your PO 1001 is on file — we'll start on your order\./.test(plain(pv.html)) &&
    /\nTerms: Net 30 · PO 1001 · Due Dec 31, 2026\nYour PO 1001 is on file — we'll start on your order\.\n/.test(pv.text));
  pv = await M.previewMessage(env, await M.buildOrderReceivedEmail(env, net30({ poAcceptedAt: "" })));
  ok("a PO the customer typed: “We'll confirm your PO 1001 and then start on your order.”", /We'll confirm your PO 1001 and then start on your order\./.test(plain(pv.html)) && /We'll confirm your PO 1001 and then start on your order\./.test(pv.text));
  pv = await M.previewMessage(env, await M.buildOrderReceivedEmail(env, net30({ poNumber: "", poAcceptedAt: "" })));
  ok("no PO yet: “Please send us your PO number (reply to this email) — we'll start on your order once we have it.”",
    /Please send us your PO number \(reply to this email\) — we'll start on your order once we have it\./.test(plain(pv.html)) && /Terms: Net 30 · Due Dec 31, 2026\nPlease send us your PO number/.test(pv.text));
  await M.setTerms(d1, { startsAt: "completed" });
  pv = await M.previewMessage(env, await M.buildOrderReceivedEmail(env, net30({ termsDays: 45, termsDueDate: "" })));
  ok("45 days from completion: “payment is due within 45 days of when your order ships or is picked up”, “Terms: Net 45 · PO 1001”",
    /payment is due within 45 days of when your order ships or is picked up\./.test(pv.text) && /\nTerms: Net 45 · PO 1001\n/.test(pv.text));
  await M.setTerms(d1, { startsAt: "invoice" });
  pv = await M.previewMessage(env, await M.buildOrderReceivedEmail(env, net30({ paid: true, amountReceived: 100, balanceDue: 0 })));
  ok("a Net 30 order already paid: the ordinary “Order received and paid”, no terms", pv.subject === "Order received and paid — EX-1001" && !/Terms|Net 30, nothing/.test(pv.html + pv.text.replace(/Payment: Net 30/, "")));
  pv = await M.previewMessage(env, await M.buildOrderReceivedEmail(env, net30({ manualShipping: true })));
  ok("a Net 30 order waiting on a shipping quote: “Order received — EX-1001”, no terms yet (nothing is known to be owed)", pv.subject === "Order received — EX-1001" && !/Terms:|No payment is needed/.test(pv.html + pv.text));
  pv = await M.previewMessage(env, await M.buildOrderReceivedEmail(env, order()));
  ok("an unpaid order not on Net 30 is as before: “· $100.00 due”, work starts once it's paid, How to pay", pv.subject === "Order received — EX-1001 · $100.00 due" && /will start on it once it's paid/.test(pv.html) && /How to pay/.test(pv.text) && !/Terms/.test(pv.html + pv.text));

  console.log("\n=== The customer's own garments on receipts and the quote ===");
  let r = M.receiptLines_(order({ items: [{ name: "Polo", size: "M", qty: 2, lineTotal: 50, customerOwned: 1 }, { name: "Cap", qty: 1, lineTotal: 50, customerOwned: 0 }] }));
  ok("a receipt line on the customer's own garments reads “Polo (your garments)”; others as they are", r.lines[0].name === "Polo (your garments)" && r.lines[1].name === "Cap");
  pv = await M.previewMessage(env, await M.buildOrderReceivedEmail(env, order({ items: [{ name: "Polo", size: "M", qty: 4, lineTotal: 100, customerOwned: true }] })));
  ok("…so the order email lists it that way", /Polo \(your garments\)/.test(pv.text) && /Polo \(your garments\)/.test(plain(pv.html)));
  let v = M.estimateLinesView([{ kind: "product", name: "Polo", size: "M", qty: 12, unitPrice: 8, lineTotal: 96, customerOwned: true },
    { kind: "custom", name: "Left chest logo", qty: 12, unitPrice: 6, lineTotal: 72, customerOwned: 1 },
    { kind: "product", name: "Cap", size: "OSFA", qty: 1, unitPrice: 20, lineTotal: 20, customerOwned: false },
    { kind: "fee", feeKind: "setup", name: "", unitPrice: 25, lineTotal: 25, customerOwned: true }]);
  ok("the customer's quote view: product and custom lines on their own garments read “… (your garments)”", v.lines[0].name === "Polo (your garments)" && v.lines[1].name === "Left chest logo (your garments)");
  ok("…a line that isn't, and a fee, read as they are", v.lines[2].name === "Cap" && v.fees.length === 1 && !/garments/.test(v.fees[0].name));

  console.log("\n=== The morning roll-up: new orders on Net 30 ===");
  const newOrder = (o) => Object.assign({ orderId: "EX-2001", orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-12-01T12:00:00Z", total: 100, paid: false,
    items: [{ name: "Polo", size: "M", qty: 4 }] }, o);
  sent.length = 0;
  await M.sendDailyDigestEmail(env, { orgNames: { club: "Example Club" }, adminUrl: "https://admin.example.com", orders: [
    newOrder({ orderId: "EX-2001", paymentMethod: "Net 30", net30: true, poNumber: "1001", poAcceptedAt: "2026-12-01T12:00:00Z", poStatus: "accepted" }),
    newOrder({ orderId: "EX-2002", paymentMethod: "Net 30", net30: true, poNumber: "PO-77", poAcceptedAt: "", poStatus: "PO to check", termsDays: 45 }),
    newOrder({ orderId: "EX-2003", paymentMethod: "Net 30", net30: true, poNumber: "", poStatus: "PO needed" }),
    newOrder({ orderId: "EX-2004", paymentMethod: "Venmo", items: [{ name: "Tee", size: "L", qty: 3, customerOwned: 1 }] }),
    newOrder({ orderId: "EX-2005", paymentMethod: "Net 30", net30: true, poNumber: "1005", poAcceptedAt: "2026-12-01T12:00:00Z", paid: true }),
    newOrder({ orderId: "EX-2006", paymentMethod: "Net 30", net30: true, poNumber: "1006", poAcceptedAt: "" }),
  ] });
  let mail = sent[0] || { body: "", htmlBody: "" };
  const cell = (id) => { const row = mail.htmlBody.split("<tr").find(x => x.includes(">" + id + "<")) || ""; const tds = row.split("<td").slice(1); return plain("<td" + (tds[3] || "")); };
  ok("an accepted PO: “Net 30 · PO 1001”, Unpaid", cell("EX-2001") === "Net 30 · PO 1001 Unpaid");
  ok("a PO the customer typed: “Net 45 · PO-77” (its own days), tagged “PO to check”", cell("EX-2002") === "Net 45 · PO-77 PO to check");
  ok("no PO yet: “Net 30 · PO needed”, Unpaid", cell("EX-2003") === "Net 30 · PO needed Unpaid");
  ok("not on Net 30: the method as chosen", cell("EX-2004") === "Venmo Unpaid");
  ok("paid: Paid, whatever its PO", cell("EX-2005") === "Net 30 · PO 1005 Paid");
  ok("a PO typed but not accepted counts as “PO to check” even without its status", cell("EX-2006") === "Net 30 · PO 1006 PO to check");
  ok("the text says the same: “Net 45 · PO-77 (po to check)”, “Net 30 · PO needed (unpaid)”, “Net 30 · PO 1005 (paid)”",
    /EX-2002 {2}Pat Example <pat@example\.com> {2}Net 45 · PO-77 \(po to check\)/.test(mail.body) && /EX-2003 .*Net 30 · PO needed \(unpaid\)/.test(mail.body) && /EX-2005 .*Net 30 · PO 1005 \(paid\)/.test(mail.body) && /EX-2004 .*Venmo \(unpaid\)/.test(mail.body));
  ok("a line on the customer's own garments says so: “3× Tee (L) — customer's own garments”", /3× Tee \(L\) — customer's own garments/.test(mail.body) && /3× Tee \(L\) — customer&#39;s own garments|3× Tee \(L\) — customer's own garments/.test(mail.htmlBody) && !/4× Polo \(M\) — customer/.test(mail.body));
  ok("no Unpaid POs section when none were given", !/Unpaid POs|UNPAID POS/.test(mail.htmlBody + mail.body));
  await M.setTerms(d1, { defaultDays: 60 });
  sent.length = 0;
  await M.sendDailyDigestEmail(env, { orgNames: { club: "Example Club" }, orders: [
    newOrder({ orderId: "EX-2001", paymentMethod: "Net 30", net30: true, poNumber: "1001", poAcceptedAt: "2026-12-01T12:00:00Z", termsDays: null }),
    newOrder({ orderId: "EX-2002", paymentMethod: "Net 30", net30: true, poNumber: "PO-77", poAcceptedAt: "", termsDays: 45 })] });
  mail = sent[0] || { body: "", htmlBody: "" };
  ok("with Global settings' terms at 60 days, an order without days of its own reads “Net 60 · PO 1001”; one with its own 45 still “Net 45”",
    cell("EX-2001") === "Net 60 · PO 1001 Unpaid" && cell("EX-2002") === "Net 45 · PO-77 PO to check" && /EX-2001 .*Net 60 · PO 1001 \(unpaid\)/.test(mail.body));
  await M.setTerms(d1, { defaultDays: 30 });

  console.log("\n=== The morning roll-up: the Unpaid POs section ===");
  const row = (o) => Object.assign({ orgId: "club", orgName: "Example Club", customerName: "Pat Example", company: "", poNumber: "1001", owedCents: 25000, dueDate: "2026-12-31", daysLate: 0 }, o);
  const up = { toCheck: [row({ orderId: "EX-3001", poNumber: "PO-31", company: "Example School District", orgName: "", orgId: "school" })],
    late: [row({ orderId: "EX-3002", dueDate: "2026-11-01", daysLate: 30, owedCents: 50000 }), row({ orderId: "EX-3003", poNumber: "", dueDate: "2026-11-30", daysLate: 1, newlyLate: true, company: "Pat Example", owedCents: 12550 })],
    totals: { count: 3, owedCents: 87550, lateCents: 62550, toCheck: 1 } };
  sent.length = 0;
  await M.sendDailyDigestEmail(env, { orgNames: { club: "Example Club", school: "Example School District" }, adminUrl: "https://admin.example.com", orders: [newOrder({ paymentMethod: "Venmo" })], unpaidPos: up });
  mail = sent[0];
  const fmt = M.fmt$;
  ok("a “📄 Unpaid POs” section with the totals: how many, owed, and how much of it late", /<h3[^>]*>📄 Unpaid POs<\/h3>/.test(mail.htmlBody) && plain(mail.htmlBody).includes(`3 unpaid POs in all: ${fmt(875.5)} owed, ${fmt(625.5)} of it late.`));
  ok("…“POs to check — 1”, saying to accept each one so the work can start", /POs to check — 1<\/h4>/.test(mail.htmlBody) && plain(mail.htmlBody).includes("The customer typed these. Accept each one on the order (or on the Unpaid POs report) so the work can start."));
  ok("…each PO on a line: order, customer and company, shop (from the shop list when the row has no name), PO, owed, due",
    plain(mail.htmlBody).includes(`EX-3001 — Pat Example, Example School District (Example School District) · PO-31 · ${fmt(250)} owed · due Dec 31, 2026`));
  ok("…“Late — 2”, past the due date and still owed, the newly late ones in bold", /Late — 2<\/h4>/.test(mail.htmlBody) && plain(mail.htmlBody).includes("Past the due date and still owed; the ones in bold became late since the last roll-up."));
  ok("…a late line says how late: “30 days late”", plain(mail.htmlBody).includes(`EX-3002 — Pat Example (Example Club) · PO 1001 · ${fmt(500)} owed · due Nov 1, 2026 · 30 days late`) && !/EX-3002[^<]*newly late/.test(mail.htmlBody));
  ok("…one day late, no PO, a company that is the customer's own name not repeated, newly late and in bold",
    /<li style="font-weight:600">EX-3003 — Pat Example \(Example Club\) · no PO · [^<]* owed · due Nov 30, 2026 · 1 day late · newly late<\/li>/.test(mail.htmlBody));
  ok("…a link to the Unpaid POs report", /<a href="https:\/\/admin\.example\.com\/#unpaidpos">Unpaid POs report<\/a>/.test(mail.htmlBody));
  ok("the text: “UNPAID POS — …”, POs to check, Late, each line indented, and the report's address",
    mail.body.includes(`UNPAID POS — 3 unpaid POs in all: ${fmt(875.5)} owed, ${fmt(625.5)} of it late.\nPOs to check — 1\n  EX-3001 — Pat Example, Example School District (Example School District) · PO-31`) &&
    /\nLate — 2\n {2}EX-3002 .*30 days late\n {2}EX-3003 .*1 day late · newly late\nhttps:\/\/admin\.example\.com\/#unpaidpos/.test(mail.body));
  sent.length = 0;
  await M.sendDailyDigestEmail(env, { orgNames: {}, adminUrl: "", orders: [newOrder({ paymentMethod: "Venmo" })],
    unpaidPos: { toCheck: [], late: [row({ orderId: "EX-3002", dueDate: "2026-11-01", daysLate: 30 })], totals: { count: 1, owedCents: 25000, lateCents: 25000, toCheck: 0 } } });
  mail = sent[0];
  ok("only late ones, none newly: no POs to check part, no word about bold, “1 unpaid PO in all”", !/POs to check/.test(mail.htmlBody + mail.body) && plain(mail.htmlBody).includes("Past the due date and still owed.") && !/in bold/.test(mail.htmlBody) &&
    plain(mail.htmlBody).includes(`1 unpaid PO in all: ${fmt(250)} owed, ${fmt(250)} of it late.`));
  ok("…with no admin address, no link", !/#unpaidpos/.test(mail.htmlBody + mail.body));
  sent.length = 0;
  await M.sendDailyDigestEmail(env, { orgNames: {}, orders: [newOrder({ paymentMethod: "Venmo" })], unpaidPos: { toCheck: [], late: [], totals: { count: 2, owedCents: 50000, lateCents: 0, toCheck: 0 } } });
  ok("POs owed but none to check or late: no section", sent.length === 1 && !/Unpaid POs|UNPAID POS/.test(sent[0].htmlBody + sent[0].body));
  sent.length = 0;
  const many = Array.from({ length: 53 }, (_, i) => row({ orderId: "EX-4" + String(i).padStart(3, "0") }));
  await M.sendDailyDigestEmail(env, { orgNames: {}, orders: [newOrder({ paymentMethod: "Venmo" })], unpaidPos: { toCheck: many, late: [], totals: { count: 53, owedCents: 53 * 25000, lateCents: 0, toCheck: 53 } } });
  mail = sent[0];
  ok("a long list shows 50 and “…and 3 more”", (mail.htmlBody.match(/EX-4\d{3}/g) || []).length === 50 && /<li>…and 3 more<\/li>/.test(mail.htmlBody) && /\n {2}…and 3 more/.test(mail.body) && !/EX-4050/.test(mail.htmlBody + mail.body));
  sent.length = 0;
  ok("Unpaid POs alone never send a roll-up", (await M.sendDailyDigestEmail(env, { orgNames: {}, orders: [], unpaidPos: up })) === false && sent.length === 0);

  console.log("\n=== The quiet-morning email: what's still being watched ===");
  sent.length = 0;
  await M.sendDigestHeartbeatEmail(env, { adminUrl: "", unpaidPos: up });
  ok("“3 unpaid POs (… owed, … late, 1 to check)”", sent[0].body.includes(`3 unpaid POs (${fmt(875.5)} owed, ${fmt(625.5)} late, 1 to check)`));
  sent.length = 0;
  await M.sendDigestHeartbeatEmail(env, { adminUrl: "", unpaidPos: { toCheck: [], late: [], totals: { count: 1, owedCents: 25000, lateCents: 0, toCheck: 0 } } });
  ok("one, nothing late or to check: “1 unpaid PO (… owed)”", sent[0].body.includes(`1 unpaid PO (${fmt(250)} owed)`) && !/late,|to check/.test(sent[0].body));
  sent.length = 0;
  await M.sendDigestHeartbeatEmail(env, { adminUrl: "", unpaidPos: { toCheck: [], late: [], totals: { count: 0, owedCents: 0, lateCents: 0, toCheck: 0 } } });
  await M.sendDigestHeartbeatEmail(env, { adminUrl: "" });
  ok("none, or no report at all: no word about POs", sent.length === 2 && sent.every(x => !/unpaid PO/i.test(x.body + x.htmlBody)));

  await rollupRun(d1, env);
  await quoteEditor(d1);
})().catch((e) => { console.error(e); ok("the test ran to the end", false); });

// ---- functions/api/daily-digest.js: the roll-up's part of the Unpaid POs report, on the real database -------------
async function rollupRun(d1, env) {
  console.log("\n=== The roll-up run: POs to check, late ones and newly late ones, from the database ===");
  NOW = Date.parse("2026-12-01T15:00:00Z");   // 9 am on Dec 1 in Chicago
  const add = async (orderId, dollars, set) => {
    await M.insertOrder(d1, { orderId, orgId: "club", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Net 30", placedAt: set.placedAt || "2026-09-01T17:00:00Z" },
      [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: dollars }]);
    d1._raw.run(`UPDATE orders SET net30 = 1, poNumber = ?, poAcceptedAt = ?, invoicedAt = ?, voidedAt = ? WHERE orderId = ?`,
      [set.po || "", set.accepted ? "2026-09-02T17:00:00Z" : null, set.invoicedAt || null, set.voided ? "2026-09-03T17:00:00Z" : null, orderId]);
  };
  await add("EX-5001", 120, { po: "PO-1001", invoicedAt: "2026-11-25T17:00:00Z" });               // to check, due Dec 25
  await add("EX-5002", 200, { po: "1002", accepted: true, invoicedAt: "2026-10-01T17:00:00Z" });   // due Oct 31: 31 days late
  await add("EX-5003", 150, { po: "1003", accepted: true, invoicedAt: "2026-10-28T17:00:00Z" });   // due Nov 27: 4 days late
  await add("EX-5004", 80, {});                                                                     // no PO, due Oct 1: 61 days late
  await add("EX-5005", 90, { po: "1005", accepted: true, invoicedAt: "2026-11-20T17:00:00Z" });    // not yet due
  await add("EX-5006", 60, { po: "1006", accepted: true, invoicedAt: "2026-11-01T17:00:00Z" });    // due today: not late
  await add("EX-5007", 500, { po: "1007", accepted: true, voided: true });                          // voided: never listed
  const newest = d1.q("SELECT insertedAt, orderId FROM orders ORDER BY insertedAt DESC, orderId DESC LIMIT 1")[0];
  const lastRollup = { afterInsertedAt: newest.insertedAt, afterOrderId: newest.orderId, sentAt: "2026-11-28T03:00:00Z" };   // Nov 27, 9 pm in Chicago
  await M.setDigestState(d1, lastRollup);
  await add("EX-5099", 50, { po: "PO-2002", placedAt: "2026-12-01T13:00:00Z" });                  // today's new order, its PO typed by the customer
  const fmt = M.fmt$;
  const run = async (trigger, e = env) => { sent.length = 0; const log = console.log; console.log = () => {}; let res; try { res = await M.runDailyDigest(e, trigger); } finally { console.log = log; } return { status: res.status, body: JSON.parse(await res.text()), mail: sent[sent.length - 1] || { body: "", htmlBody: "" } }; };
  const html = (x) => plain(x.mail.htmlBody);

  let r = await run("manual");
  ok("a new order sends the roll-up", r.status === 200 && r.body.sent === true && sent.length === 1);
  ok("…its Payment cell, from the saved order: “Net 30 · PO-2002”, “PO to check”", /Net 30 · PO-2002 PO to check/.test(html(r)) && /EX-5099 .*Net 30 · PO-2002 \(po to check\)/.test(r.mail.body));
  ok("the Unpaid POs totals: 7 owed in all (not the voided one), $750.00, $430.00 of it late (due today isn't late)", html(r).includes(`7 unpaid POs in all: ${fmt(750)} owed, ${fmt(430)} of it late.`));
  const toCheckPart = r.mail.body.slice(r.mail.body.indexOf("POs to check — "), r.mail.body.indexOf("\nLate — "));
  ok("POs to check — 2: the ones the customer typed, by due date (EX-5001, then today's EX-5099)", /^POs to check — 2\n {2}EX-5001 — Pat Example \(Example Club\) · PO-1001 · \$120\.00 owed · due Dec 25, 2026\n {2}EX-5099 .*PO-2002 · \$50\.00 owed · due Dec 31, 2026$/.test(toCheckPart));
  const latePart = r.mail.body.slice(r.mail.body.indexOf("\nLate — "));
  ok("Late — 3, most days late first: EX-5004 (61, no PO), EX-5002 (31), EX-5003 (4)", /^\nLate — 3\n {2}EX-5004 .*no PO · \$80\.00 owed · due Oct 1, 2026 · 61 days late\n {2}EX-5002 .*PO 1002 .*due Oct 31, 2026 · 31 days late\n {2}EX-5003 .*due Nov 27, 2026 · 4 days late · newly late\n/.test(latePart));
  ok("…only EX-5003 became late since the last roll-up (on Nov 27 in Chicago): it alone is newly late and in bold",
    (r.mail.body.match(/newly late/g) || []).length === 1 && (r.mail.htmlBody.match(/font-weight:600"/g) || []).length === 1 && /<li style="font-weight:600">EX-5003/.test(r.mail.htmlBody));
  ok("not yet due, due today and voided orders are in neither list", !/EX-5005|EX-5006|EX-5007/.test(r.mail.body + r.mail.htmlBody));

  await M.setDigestState(d1, lastRollup);
  r = await run("manual", { ...env, TIMEZONE: "UTC" });
  ok("in UTC the last roll-up was on Nov 28, so the order due Nov 27 was already late then: nothing newly late", r.body.sent === true && !/newly late|in bold/.test(r.mail.body + r.mail.htmlBody) && /EX-5003 .*4 days late\n/.test(r.mail.body));

  await M.setDigestState(d1, { afterInsertedAt: lastRollup.afterInsertedAt, afterOrderId: lastRollup.afterOrderId });
  r = await run("manual");
  ok("with no last roll-up time, nothing counts as newly late", r.body.sent === true && /Late — 3/.test(r.mail.body) && !/newly late|in bold/.test(r.mail.body + r.mail.htmlBody));

  r = await run("scheduled");
  ok("a quiet morning (no new orders): Unpaid POs alone don't send the roll-up; the short email goes instead", r.body.sent === false && r.body.heartbeat === "sent" && !/UNPAID POS/.test(r.mail.body));
  ok("…and counts them among what's being watched: “7 unpaid POs ($750.00 owed, $430.00 late, 2 to check)”", r.mail.body.includes(`7 unpaid POs (${fmt(750)} owed, ${fmt(430)} late, 2 to check)`));
  d1._raw.run("UPDATE orders SET net30 = 0");
  r = await run("scheduled");
  ok("with no Net 30 orders owed, the quiet-morning email says nothing about POs", r.body.heartbeat === "sent" && !/unpaid PO/i.test(r.mail.body + r.mail.htmlBody));
  d1._raw.run("UPDATE orders SET net30 = 1");

  const failing = Object.create(d1);
  failing.prepare = (sql) => { if (/o\.net30 = 1/.test(sql)) throw new Error("the report broke"); return d1.prepare(sql); };
  await M.setDigestState(d1, lastRollup);
  const errors = [], realError = console.error;
  console.error = (...a) => errors.push(a.map(String).join(" "));
  try { r = await run("manual", { ...env, DB: failing }); } finally { console.error = realError; }
  ok("a report that can't be read: the roll-up still goes, without the Unpaid POs section, and the failure is logged",
    r.body.sent === true && /EX-5099/.test(r.mail.body) && !/UNPAID POS|Unpaid POs/.test(r.mail.body + r.mail.htmlBody) && errors.some(x => /getUnpaidPoReport failed/.test(x)));
}

// ---- public/admin-quotes.js: the quote editor in the real admin page, the real orders.js behind it ---------------
async function quoteEditor(d1) {
  console.log("\n=== The quote editor: a line on the customer's own garment ===");
  const api = new Function(hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
    "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role407] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
    "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role407" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {}, features: { ownGarments: true } });\n" +
    "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false;\n" +
    "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
    dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
  globalThis.__role407 = "admin";
  const call = async (body) => {
    const waits = [];
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const pause = (ms) => new Promise(r => setTimeout(r, ms));
  const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
  const itemsOf = (id) => d1.q("SELECT * FROM estimate_items WHERE estimateId = ? ORDER BY position", id);

  const cust = await call({ action: "saveCustomer", name: "Sam Example", company: "Example School District", email: "sam@example.com", phone: "", address: null, notes: "", taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" });
  await M.createProduct(d1, "club", { productId: "polo", type: "shirt", name: "Club polo", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  await M.setFeatures(d1, { ownGarments: true });
  const ce = await call({ action: "createEstimate", org: "club", customerId: cust.body.id, title: "Team polos" });
  const QID = ce.body.id;

  const adminJs = read("public/admin.js"), custJs = read("public/admin-customers.js"), quotesJs = read("public/admin-quotes.js");
  const sentBodies = [], toasts = [];
  let scripted = null;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      if (/\/admin-quotes\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(quotesJs));
      if (/\/admin-customers\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(custJs));
      if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs));
      return Promise.resolve(Buffer.from(""));
    }
  }
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) console.error(e); });
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sentBodies.push(b);
        if (scripted && scripted.action === b.action) { const s = scripted; scripted = null; return reply(200, s.body); }
        const x = await call(b);
        return reply(x.status, x.body);
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC"); adminOrgs = [{ orgId: "club", name: "Example Club" }];');
  w.eval(roles.asRole("admin", { name: "Tester", email: "tester@example.test" }));
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const of = (action) => sentBodies.filter(b => b.action === action);
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const page = () => d.getElementById("qtPage");
  const oneDrawn = () => !!(page() && (q("#qtForm") || page().querySelector(".cust-err")));
  const openQ = async () => { const old = page(); if (w.location.hash === "#quotes/" + QID) w.adminRoute(); else w.location.hash = "#quotes/" + QID; return wait(() => page() && page() !== old && oneDrawn()); };
  const lines = () => qa("#qtLines table.qt-lines tbody tr");
  const sub = (i) => { const el = lines()[i] && lines()[i].querySelector(".qt-line-sub"); return el ? el.textContent : ""; };
  const openDialog = async (btn, form) => { const n = qa(".admin-modal").length; btn.click(); return wait(() => qa(".admin-modal").length === n + 1 && !!modal().querySelector(form)); };
  const submitIn = async (formSel) => { const m = modal(); const n = of("saveEstimate").length; m.querySelector(formSel).dispatchEvent(new w.Event("submit", { cancelable: true }));
    await wait(() => !m.isConnected || m.querySelector(".cust-err").textContent !== ""); await wait(() => of("saveEstimate").length > n && !!page() && oneDrawn()); await pause(30); return m; };
  const fill = (vals) => { for (const [sel, v] of Object.entries(vals)) { const el = modal().querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); } };
  const lastSaved = () => of("saveEstimate")[of("saveEstimate").length - 1];
  const features = (f) => w.applyFeatures_(f);

  features({});
  await openQ();
  await openDialog(q("#qtAddProduct"), "#qtProdForm");
  ok("with Customer-supplied garments not switched on (it starts off), + Product has no “Customer's own garment” tick", !modal().querySelector("#qtProdOwnGarment"));
  modal().querySelector("#qtProdCancel, .cust-dialog-actions button[type=button]").click(); await wait(() => !modal());
  await openDialog(q("#qtAddCustom"), "#qtOtherForm");
  ok("…nor + Custom line", !modal().querySelector("#qtOtherOwnGarment"));
  modal().querySelector(".cust-dialog-actions button[type=button]").click(); await wait(() => !modal());

  features({ ownGarments: true });
  await openDialog(q("#qtAddProduct"), "#qtProdForm");
  const prodTick = () => modal().querySelector("#qtProdOwnGarment");
  ok("switched on: + Product has the tick, not ticked, labelled with what it means",
    !!prodTick() && !prodTick().checked && prodTick().type === "checkbox" &&
    prodTick().closest("label").textContent.replace(/\s+/g, " ").trim() === "Customer's own garment (the customer brings the garments: no blank is ordered and the price is for the decoration)");
  prodTick().checked = true;
  modal().querySelector("#qtProdQty").value = "12";
  await submitIn("#qtProdForm");
  ok("ticked, Add line saves the line as customerOwned", same(lastSaved().items, [{ kind: "product", productId: "polo", size: "OSFA", qty: 12, personalized: false, persName: "", customerOwned: true }]));
  ok("…the quote keeps it", Number(itemsOf(QID)[0].customerOwned) === 1);
  ok("…and the line says “Customer's own garment” under its name", sub(0) === "Customer's own garment");

  await openDialog(q("#qtAddCustom"), "#qtOtherForm");
  const otherTick = () => modal().querySelector("#qtOtherOwnGarment");
  ok("+ Custom line has the tick too, not ticked", !!otherTick() && !otherTick().checked);
  fill({ "#qtOtherName": "Left chest logo", "#qtOtherQty": "12", "#qtOtherPrice": "6" });
  otherTick().checked = true;
  await submitIn("#qtOtherForm");
  ok("ticked, a custom line is saved as customerOwned", same(lastSaved().items[1], { kind: "custom", name: "Left chest logo", qty: 12, unitPrice: 6, taxable: true, customerOwned: true }) && Number(itemsOf(QID)[1].customerOwned) === 1);
  ok("…and says “Custom line · Customer's own garment”", sub(1) === "Custom line · Customer's own garment");
  await openDialog(q("#qtAddCustom"), "#qtOtherForm");
  fill({ "#qtOtherName": "Name tapes", "#qtOtherQty": "12", "#qtOtherPrice": "2" });
  await submitIn("#qtOtherForm");
  ok("left unticked, a line isn't the customer's own garment (nothing about it is sent)", !("customerOwned" in lastSaved().items[2]) && Number(itemsOf(QID)[2].customerOwned) === 0 && sub(2) === "Custom line");
  { const v = M.estimateLinesView((await M.getEstimate(d1, QID)).items);
    ok("the customer's view of this quote: “Club polo (your garments)”, “Left chest logo (your garments)”, “Name tapes”", same(v.lines.map(l => l.name), ["Club polo (your garments)", "Left chest logo (your garments)", "Name tapes"])); }
  await openDialog(q("#qtAddFee"), "#qtOtherForm");
  ok("+ Fee never has the tick", !otherTick());
  modal().querySelector(".cust-dialog-actions button[type=button]").click(); await wait(() => !modal());

  { const box = lines()[0].querySelector("input.qt-qty"); box.focus(); box.value = "24"; box.dispatchEvent(new w.Event("change", { bubbles: true }));
    await wait(() => of("saveEstimate").length && lastSaved().items[0].qty === 24); await wait(() => oneDrawn()); await pause(30); }
  ok("any other save keeps the lines that are on the customer's own garments", lastSaved().items[0].customerOwned === true && lastSaved().items[1].customerOwned === true && !("customerOwned" in lastSaved().items[2]));

  await openDialog(lines()[0].querySelector("[data-qt-edit]"), "#qtProdForm");
  ok("Change on such a line: the tick is ticked", !!prodTick() && prodTick().checked);
  prodTick().checked = false;
  await submitIn("#qtProdForm");
  ok("…unticked and saved, the line is no longer the customer's own garment", !("customerOwned" in lastSaved().items[0]) && Number(itemsOf(QID)[0].customerOwned) === 0 && sub(0) === "");

  features({});
  await openQ();
  await openDialog(lines()[1].querySelector("[data-qt-edit]"), "#qtOtherForm");
  ok("switched off later: a line that has it still shows the tick, ticked, so it can be taken off", !!otherTick() && otherTick().checked);
  otherTick().checked = false;
  await submitIn("#qtOtherForm");
  ok("…and taking it off is saved", !("customerOwned" in lastSaved().items[1]) && Number(itemsOf(QID)[1].customerOwned) === 0);
  await openDialog(lines()[0].querySelector("[data-qt-edit]"), "#qtProdForm");
  ok("…a line without it shows no tick", !prodTick());
  modal().querySelector(".cust-dialog-actions button[type=button]").click(); await wait(() => !modal());
  features({ ownGarments: "yes" });
  await openDialog(q("#qtAddProduct"), "#qtProdForm");
  ok("only a switch that is really on (true) counts", !prodTick());
  modal().querySelector(".cust-dialog-actions button[type=button]").click(); await wait(() => !modal());

  console.log("\n=== Convert to order: Net 30 and a PO ===");
  features({ ownGarments: true });
  const convOpen = async () => { await openQ(); q("#qtConvert").click(); return wait(() => !!modal() && !!modal().querySelector("#qtConvForm")); };
  const convGo = async (answer) => { scripted = { action: "convertEstimate", body: answer || { status: "ok", orderId: "EX-9001" } }; const n = of("convertEstimate").length;
    modal().querySelector("#qtConvForm").dispatchEvent(new w.Event("submit", { cancelable: true })); await wait(() => of("convertEstimate").length > n && !modal()); await pause(30); return of("convertEstimate")[n]; };
  await convOpen();
  const net30Box = () => modal().querySelector("#qtConvNet30"), poWrap = () => modal().querySelector("#qtConvPoWrap"), poBox = () => modal().querySelector("#qtConvPo");
  ok("a role that may set an order's terms gets “Net 30 terms (the customer pays by invoice)”, not ticked", !!net30Box() && !net30Box().checked && net30Box().closest("label").textContent.trim() === "Net 30 terms (the customer pays by invoice)");
  ok("…the PO box is hidden until it is ticked", poWrap().hidden && poBox().maxLength === 60 && poBox().placeholder === "PO-1001");
  net30Box().checked = true; net30Box().dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("ticked: the PO box shows, saying a PO typed here counts as accepted", !poWrap().hidden && poWrap().querySelector("span").textContent === "PO number (optional — a PO typed here counts as accepted)");
  net30Box().checked = false; net30Box().dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("…unticked again, hidden again", poWrap().hidden);
  let body = await convGo();
  ok("not ticked: the order is made as before, nothing about Net 30 sent", body && !("net30" in body) && !("poNumber" in body) && toasts.some(t => t.m === "Order EX-9001 made from quote " + d1.q("SELECT number FROM estimates WHERE id = ?", QID)[0].number + "."));
  await convOpen();
  net30Box().checked = true; net30Box().dispatchEvent(new w.Event("change", { bubbles: true }));
  poBox().value = "  PO-1001  ";
  body = await convGo();
  ok("ticked with a PO: net30 and the PO (trimmed) are sent", body && body.net30 === true && body.poNumber === "PO-1001");
  await convOpen();
  net30Box().checked = true; net30Box().dispatchEvent(new w.Event("change", { bubbles: true }));
  poBox().value = "   ";
  body = await convGo();
  ok("ticked with no PO: net30 alone", body && body.net30 === true && !("poNumber" in body));
  w.eval(`adminPerms = Object.assign({}, adminPerms, { "orders.terms": "read" });`);
  await convOpen();
  ok("a role without Edit on Net 30 terms isn't offered the tick or the PO box", !net30Box() && !poBox() && !!modal().querySelector("#qtConvGo"));
  modal().querySelector("#qtConvCancel").click(); await wait(() => !modal());
  w.close();
}
