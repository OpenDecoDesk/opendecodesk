const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Customer order emails: prices before tax with a unit price, the sales tax above the total, how to pay
// and the business's details from the Business profile, clear subjects, a PDF invoice / receipt
// attached (functions/_lib/pdf.js — no browser), and Global settings → Customer emails (preview, sample
// PDF, the attach setting). Real SQL (sql.js), the real email.js / orders.js, the real admin page in jsdom,
// and the PDFs read back with pdf.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

// Every email the code sends, as the provider got it (attachments included).
const sent = [];
global.fetch = async (url, init) => {
  const u = String(url);
  if (/email\/sending\/send$/.test(u)) { sent.push({ via: "cloudflare", ...JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ success: true, result: {} }) }; }
  if (u === "https://api.resend.com/emails") { sent.push({ via: "resend", ...JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ id: "re_1" }) }; }
  throw new Error("unexpected fetch " + u);
};

const hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js")), dbSrc = strip(read("functions/_lib/db.js"));
const pdfSrc = strip(read("functions/_lib/pdf.js")), emailSrc = strip(read("functions/_lib/email.js")), statusSrc = strip(read("functions/_lib/setupStatus.js"));
const M = new Function(hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" + statusSrc + "\n" +
  "const requireAdmin = async (env, host, key) => (host.kind === 'admin' && key === 'x') ? null : jsonResponse({ status: 'error', message: 'Unauthorized' }, 401); const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async (env) => ({ subdomainMap: { acme: 'acme' }, orgs: {}, features: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  "const checkShippedDeliveries = async () => ({}), checkBlankShipments = async () => ({});\n" +
  dbSrc + "\n" + pdfSrc + "\n" + emailSrc + "\n" + strip(read("functions/api/orders.js")) + "\n" +
  "return { post: onRequestPost, receiptLines_, howToPay_, businessBlock_, buildOrderReceivedEmail, buildPaymentReceivedEmail, buildInvoiceEmail, orderPdf, previewMessage, send_, " +
  "  pdfDocument, pdfWrap, pdfTextWidth, setBusinessProfile, getBusinessProfile, setSalesTaxSettings, setGlobalSettings, getEmailSettings, setEmailSettings, setupStatus, ACTION_ROLE, sampleOrder_ };")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const tick = (ms) => new Promise(res => setTimeout(res, ms || 40));
const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&rarr;/g, "→").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const b64bytes = (b64) => Uint8Array.from(Buffer.from(b64, "base64"));
let pdfjs = null;
const pdfText = async (bytes) => {
  if (!pdfjs) pdfjs = await import("./node_modules/pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  let out = [];
  for (let n = 1; n <= doc.numPages; n++) out.push((await (await doc.getPage(n)).getTextContent()).items.map(i => i.str).join(" "));
  return { pages: doc.numPages, text: out.join("\n").replace(/\s+/g, " "), size: (await doc.getPage(1)).view };
};
// A saved order as the loaders give it, tax included in the price (6%).
const order = (o = {}) => Object.assign({
  orderId: "ACME-1", orgId: "acme", customerName: "Alex Sample", contact: "alex@example.net", paymentMethod: "Check",
  items: [{ name: "Polo", size: "M", qty: 2, unitPrice: 25, lineTotal: 50, tax: 2.83, taxable: true }, { name: "Cap", size: "", qty: 1, unitPrice: 18, lineTotal: 18, tax: 1.02, taxable: true }],
  shippingCost: 8.25, shippingMethod: "USPS Ground Advantage", discountAmount: 5.3, discountTax: 0.3, discountNote: "Club", taxRate: 6, taxMode: "inclusive", taxExempt: false,
  salesTax: 3.55, effectiveTotal: 70.95, total: 70.95, amountReceived: 0, balanceDue: 70.95, paid: false }, o);

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);
  const env = { DB: d1, ROOT_DOMAIN: "example.com", SIGNING_SECRET: "s", CF_EMAIL_API_TOKEN: "t", CF_ACCOUNT_ID: "a" };
  const ctx = (request) => ({ env, request, waitUntil: (p) => p.then(() => {}, () => {}) });
  const post = async (body, host = "admin") => { const res = await M.post(ctx({ url: `https://${host}.example.com/api/orders`, json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } }));
    const text = await res.text(); return { status: res.status, body: JSON.parse(text), text }; };
  await M.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH" });

  console.log("=== Prices before tax, the tax above the total ===");
  let r = M.receiptLines_(order());
  ok("each line is shown before tax: Polo 2 × $23.59 = $47.17, Cap $16.98", r.lines[0].amountCents === 4717 && r.lines[0].unitCents === 2359 && r.lines[1].amountCents === 1698 && r.lines[1].unitCents === 1698);
  ok("the rows are Subtotal · Shipping · Discount (before tax) · Sales tax · Total, in that order",
    r.rows.map(x => x.label).join("|") === "Subtotal|Shipping (USPS Ground Advantage)|Discount (Club)|Sales tax (6%)|Total" &&
    r.rows.map(x => x.value).join("|") === "$64.15|$8.25|−$5.00|$3.55|$70.95");
  ok("they add up to the cent: 64.15 + 8.25 − 5.00 + 3.55 = 70.95", 6415 + 825 - 500 + 355 === r.totalCents);
  ok("a unit price that had to be rounded says so (2 × $23.59 isn't $47.17)", r.roundedUnits && /Prices are shown before sales tax\. Unit prices are rounded to the cent/.test(r.note));
  r = M.receiptLines_(order({ items: [{ name: "Tee", size: "L", qty: 3, unitPrice: 10.6, lineTotal: 31.8, tax: 1.8, taxable: true }], shippingCost: 0, shippingMethod: "", discountAmount: 0, discountTax: 0, salesTax: 1.8, effectiveTotal: 31.8 }));
  ok("an even split needs no rounding note: 3 × $10.00 = $30.00, tax $1.80, total $31.80", !r.roundedUnits && r.lines[0].unitCents === 1000 && r.rows.map(x => x.value).join("|") === "$30.00|$1.80|$31.80" && r.note === "Prices are shown before sales tax.");
  r = M.receiptLines_(order({ taxMode: "exclusive", items: [{ name: "Tee", size: "L", qty: 2, unitPrice: 10, lineTotal: 20, tax: 1.2, taxable: true }], shippingCost: 0, shippingMethod: "", discountAmount: 0, discountTax: 0, salesTax: 1.2, effectiveTotal: 21.2 }));
  ok("tax added on top: the prices as listed, then the tax, then the total", r.lines[0].amountCents === 2000 && r.rows.map(x => x.label + " " + x.value).join("|") === "Subtotal $20.00|Sales tax (6%) $1.20|Total $21.20");
  r = M.receiptLines_(order({ taxExempt: true, items: [{ name: "Tee", size: "L", qty: 2, unitPrice: 10, lineTotal: 20, tax: 0, taxable: true }], shippingCost: 0, shippingMethod: "", discountAmount: 0, discountTax: 0, salesTax: 0, effectiveTotal: 20 }));
  ok("a tax-exempt order says so above the total, adds nothing, and has no 'before tax' note", r.rows.map(x => x.label + " " + x.value).join("|") === "Subtotal $20.00|Sales tax Tax-exempt|Total $20.00" && !r.note);
  r = M.receiptLines_(order({ items: [{ name: "Tee", size: "L", qty: 2, unitPrice: 10, lineTotal: 20, tax: 0, taxable: true }], shippingCost: 0, shippingMethod: "", discountAmount: 0, discountTax: 0, salesTax: 0, effectiveTotal: 20, shippingAddress: { state: "CA" } }));
  ok("shipped out of state (no tax on its lines): no tax row, no note", r.rows.map(x => x.label).join("|") === "Subtotal|Total" && !r.note);
  r = M.receiptLines_({ orderId: "N1", items: [{ name: "Polo", qty: 2, lineTotal: 50 }], taxRate: 6, shippingCost: 0 });
  ok("a new order with only the rate snapshot works the tax out per line, as db.js does", r.lines[0].amountCents === 4717 && r.rows.find(x => /Sales tax/.test(x.label)).value === "$2.83" && r.totalCents === 5000);

  console.log("\n=== How to pay, and who it's from ===");
  await M.setBusinessProfile(d1, { name: "Acme Stitch <Co>", legalName: "Acme Stitch LLC", mailingAddress: "1 Main St\nColumbus OH 43215", supportEmail: "help@acme.test",
    phone: "555-0100", website: "acme.test", venmo: "acmestitch", zelle: "pay@acme.test", paymentNote: "Cash is fine at pickup.", ownerEmail: "owner@acme.test" });
  const prof = await M.getBusinessProfile(d1);
  ok("the Business profile keeps the new fields; a website without https:// gets it", prof.phone === "555-0100" && prof.website === "https://acme.test" && prof.paymentNote === "Cash is fine at pickup.");
  let bad = null; try { await M.setBusinessProfile(d1, { ...prof, website: "javascript:alert(1)" }); } catch (e) { bad = e; }
  ok("…and refuses a website that isn't a web address", bad && bad.userFacing);
  let pay = await M.howToPay_(env, order());
  ok("check: payable to the legal name, mailed to the mailing address, the order number on the memo", /payable to “Acme Stitch LLC” and mail it to 1 Main St, Columbus OH 43215/.test(pay.text) && /ACME-1 on the memo line/.test(pay.text) && pay.first.title === "Check");
  ok("…then the other ways the shop takes, and the shop's own note", /Other ways to pay/.test(pay.text) && /Venmo/.test(pay.text) && /Zelle/.test(pay.text) && /Cash is fine at pickup\./.test(pay.text));
  pay = await M.howToPay_(env, order({ paymentMethod: "Venmo" }));
  ok("Venmo first when that's how they chose to pay, with a link carrying the amount and the order", pay.first.title === "Venmo" && /venmo\.com\/u\/acmestitch\?txn=pay&amount=70\.95&note=Order%20ACME-1/.test(pay.text));
  await M.setGlobalSettings(d1, { enabledPayments: { card: false, venmo: false, zelle: true, check: true } });
  pay = await M.howToPay_(env, order({ paymentMethod: "Zelle" }));
  ok("a payment method the shop turned off isn't offered", /Zelle/.test(pay.text) && !/Venmo/.test(pay.text));
  await M.setGlobalSettings(d1, { enabledPayments: { card: true, venmo: true, zelle: true, check: true } });
  let blk = await M.businessBlock_(prof, env);
  ok("the business block: name, legal name, address, phone, email, website — escaped", /Acme Stitch &lt;Co&gt;/.test(blk.html) && !/<Co>/.test(blk.html) && /Acme Stitch LLC/.test(blk.text) && /555-0100/.test(blk.text) && /help@acme\.test/.test(blk.text) && /\nacme\.test$/.test(blk.text));
  ok("…the address keeps its lines (one line in the email's small print, separate lines in the text)", /1 Main St, Columbus OH 43215/.test(blk.html) && /1 Main St\nColumbus OH 43215/.test(blk.text));
  blk = await M.businessBlock_({ name: "Solo" }, env);
  ok("…empty fields are simply left out", blk.text.trim() === "Solo" || /^Solo\s*(\n.*example\.com)?$/.test(blk.text.trim()));

  console.log("\n=== The emails: subjects, content, the PDF ===");
  let m = await M.buildOrderReceivedEmail(env, order());
  let pv = await M.previewMessage(env, m);
  ok("order received, something owed: “Order received — <id> · $X due”", pv.subject === "Order received — ACME-1 · $70.95 due");
  ok("…it lists the lines with a unit price, the totals, how to pay and the business block", /Item Size Qty Unit price Amount Polo M 2 \$23\.59 \$47\.17/.test(plain(pv.html)) &&
    /Sales tax \(6%\) \$3\.55 Total \$70\.95/.test(plain(pv.html)) && /payable to “Acme Stitch LLC”/.test(pv.html) && /555-0100/.test(pv.html) && !/%%/.test(pv.html + pv.text + pv.subject));
  ok("…the plain text says the same", /2 × Polo \(M\)\s+\$23\.59 each\s+\$47\.17/.test(pv.text) && /Sales tax \(6%\): \$3\.55\nTotal: \$70\.95/.test(pv.text) && /mail it to 1 Main St/.test(pv.text));
  ok("…and the invoice PDF is attached", pv.attachments.length === 1 && /^Invoice ACME-1\.pdf$/.test(pv.attachments[0].filename) && pv.attachments[0].bytes > 1000);
  m = await M.buildOrderReceivedEmail(env, order({ paymentMethod: "Card", paid: true, amountReceived: 70.95, balanceDue: 0 }));
  pv = await M.previewMessage(env, m);
  ok("paid by card at checkout: “Order received and paid — <id>”, no how-to-pay", pv.subject === "Order received and paid — ACME-1" && !/payable to/.test(pv.html) && /Receipt ACME-1\.pdf/.test(pv.attachments[0].filename));
  ok("…its heading says paid, and it calls the attachment a receipt", /<h2[^>]*>Order received — paid<\/h2>/.test(pv.html) && /Your receipt is attached/.test(pv.html + pv.text) && !/invoice is attached/.test(pv.html + pv.text));
  m = await M.buildPaymentReceivedEmail(env, order({ paid: true, amountReceived: 70.95, balanceDue: 0 }), "2026-10-20T15:00:00Z");
  pv = await M.previewMessage(env, m);
  ok("payment recorded, paid in full: “Payment received — <id> · paid in full”, and its heading says the same", pv.subject === "Payment received — ACME-1 · paid in full" && /<h2[^>]*>Payment received<\/h2>/.test(pv.html) && !/confirmed/i.test(pv.subject + pv.html));
  ok("…with what was paid, how, the balance and a receipt PDF", /\$70\.95 by Check/.test(plain(pv.html)) && /Balance due \$0\.00/.test(plain(pv.html)) && /^Receipt ACME-1\.pdf$/.test(pv.attachments[0].filename));
  m = await M.buildPaymentReceivedEmail(env, order({ amountReceived: 40, balanceDue: 30.95 }), "2026-10-20T15:00:00Z");
  pv = await M.previewMessage(env, m);
  ok("part paid: “Payment received — <id> · $X still due”, and it says how to pay the rest", pv.subject === "Payment received — ACME-1 · $30.95 still due" && /payable to/.test(pv.html));

  const pdf = await M.orderPdf(env, order(), { kind: "invoice", orgName: "Acme" });
  const head = Buffer.from(pdf.bytes.slice(0, 8)).toString("latin1"), whole = Buffer.from(pdf.bytes).toString("latin1");
  ok("the PDF is a real PDF: header, cross-reference table, trailer", head === "%PDF-1.4" && /\nxref\n0 \d+\n0000000000 65535 f /.test(whole) && /startxref\n\d+\n%%EOF\n$/.test(whole));
  ok("…every cross-reference offset points at its object", (() => { const n = Number(/xref\n0 (\d+)/.exec(whole)[1]); const offs = [...whole.matchAll(/^(\d{10}) 00000 n $/gm)].map(x => Number(x[1]));
    return offs.length === n - 1 && offs.every((o, i) => whole.slice(o, o + 12).startsWith(`${i + 1} 0 obj`)); })());
  let t = await pdfText(pdf.bytes);
  ok("pdf.js reads it back: the business, the lines with unit prices, the tax above the total, balance due, how to pay",
    /Acme Stitch/.test(t.text) && /INVOICE/.test(t.text) && /Polo/.test(t.text) && /\$23\.59/.test(t.text) && /\$47\.17/.test(t.text) &&
    t.text.indexOf("Sales tax (6%)") > -1 && t.text.indexOf("Sales tax (6%)") < t.text.lastIndexOf("$70.95") && /Balance due/.test(t.text) && /Acme Stitch LLC/.test(t.text) && /1 Main St/.test(t.text));
  ok("…Letter in the US", Math.round(t.size[2]) === 612 && Math.round(t.size[3]) === 792);
  t = await pdfText((await M.orderPdf(env, order({ paid: true, amountReceived: 70.95, balanceDue: 0 }), { kind: "receipt" })).bytes);
  ok("a receipt says Paid in full", /RECEIPT/.test(t.text) && /Paid in full/.test(t.text));
  const many = order({ items: Array.from({ length: 60 }, (_, i) => ({ name: "Item " + (i + 1) + " — “quoted” café ½ ✓ 漢", size: "M", qty: 1, unitPrice: 10, lineTotal: 10, tax: 0.57, taxable: true })) });
  t = await pdfText((await M.orderPdf(env, many, { kind: "invoice" })).bytes);
  ok("a long order runs onto more pages; characters a PDF font can't show are replaced, never an error", t.pages > 1 && /Item 60/.test(t.text) && /café/.test(t.text) && /“quoted”/.test(t.text));
  const doc = M.pdfDocument({ pageSize: "A4" }); doc.text(50, 50, "(paren) \\ back");
  t = await pdfText(doc.bytes());
  ok("A4 paper, and ( ) \\ survive", Math.round(t.size[2]) === 595 && Math.round(t.size[3]) === 842 && /\(paren\) \\ back/.test(t.text));
  ok("wrapping keeps every line inside the width", M.pdfWrap("A fairly long sentence that has to wrap onto several lines here", 80, 10).every(l => M.pdfTextWidth(l, 10) <= 80));

  console.log("\n=== Sending: the PDF goes with the email, on every provider ===");
  sent.length = 0;
  await M.send_(env, await M.buildOrderReceivedEmail(env, order()));
  let a = (sent[0].attachments || [])[0] || {};
  ok("Cloudflare Email Service: an attachment with the PDF in base64", sent[0].via === "cloudflare" && a.filename === "Invoice ACME-1.pdf" && a.type === "application/pdf" && a.disposition === "attachment" && Buffer.from(a.content, "base64").slice(0, 5).toString() === "%PDF-");
  sent.length = 0;
  await M.send_({ ...env, RESEND_API_KEY: "re_test" }, await M.buildOrderReceivedEmail(env, order()));
  a = (sent[0].attachments || [])[0] || {};
  ok("Resend: an attachment with the PDF in base64", sent[0].via === "resend" && a.filename === "Invoice ACME-1.pdf" && Buffer.from(a.content, "base64").slice(0, 5).toString() === "%PDF-");
  let bound = null;
  await M.send_({ ...env, EMAIL: { send: async (msg) => { bound = msg; } } }, await M.buildOrderReceivedEmail(env, order()));
  ok("the Cloudflare binding gets the PDF's bytes", bound && bound.attachments[0].filename === "Invoice ACME-1.pdf" && Buffer.from(bound.attachments[0].content).slice(0, 5).toString() === "%PDF-");
  await M.setEmailSettings(d1, { attachPdf: false });
  m = await M.buildOrderReceivedEmail(env, order());
  ok("with “Attach a PDF” off, the email goes without one", !(m.attachments || []).length && (await M.getEmailSettings(d1)).attachPdf === false);
  await M.setEmailSettings(d1, { attachPdf: true });


  console.log("\n=== Global settings → Customer emails (the server) ===");
  const before = d1.q("SELECT count(*) n FROM orders")[0].n;
  r = await post({ action: "previewCustomerEmail", kind: "received", example: "shipping", method: "Check" });
  const ship = r.body.preview;
  ok("a preview: subject, HTML and text of the real template, for a sample order", r.status === 200 && /^Order received — SAMPLE-1001 · \$[\d.]+ due$/.test(ship.subject) && /Alex Sample/.test(ship.html) && /SAMPLE-1001/.test(ship.text));
  ok("…with shipping: the carrier line and a discount", /Shipping \(USPS Ground Advantage\)/.test(plain(ship.html)) && /Discount \(Club discount\)/.test(plain(ship.html)));
  r = await post({ action: "previewCustomerEmail", kind: "received", example: "pickup", method: "Venmo" });
  const pick = r.body.preview;
  ok("…without shipping: no shipping line, an untaxed item, and Venmo first", !/Shipping/.test(plain(pick.html)) && /Sticker pack/.test(pick.html) && /How to pay[\s\S]*Venmo[\s\S]*Other ways to pay/.test(plain(pick.html)));
  ok("…built from the real Business profile", /Acme Stitch LLC/.test(ship.html) && /555-0100/.test(ship.html));
  r = await post({ action: "previewCustomerEmail", kind: "payment", example: "shipping", method: "Card" });
  ok("the payment email's preview", /^Payment received — SAMPLE-1001 · paid in full$/.test(r.body.preview.subject));
  r = await post({ action: "previewCustomerEmail", kind: "invoice" }); const r2 = await post({ action: "previewCustomerEmail", kind: "shipped" });
  ok("the invoice and shipped previews", /^Invoice — SAMPLE-1001/.test(r.body.preview.subject) && r2.status === 200 && /shipped/i.test(r2.body.preview.subject));
  r = await post({ action: "samplePdf", kind: "payment", example: "pickup" });
  t = await pdfText(b64bytes(r.body.file.contentBase64));
  ok("a sample PDF receipt", r.status === 200 && /\.pdf$/.test(r.body.file.filename) && /RECEIPT/.test(t.text) && /Club T-shirt/.test(t.text));
  ok("previews write nothing: no order, no email", d1.q("SELECT count(*) n FROM orders")[0].n === before && sent.length === 0 || sent.every(s => !/SAMPLE/.test(s.subject)));
  sent.length = 0;
  r = await post({ action: "sendSampleEmail", kind: "received", example: "shipping" });
  ok("Send me this sample: one email to the owner, marked [Sample]", r.status === 200 && sent.length === 1 && sent[0].to === "owner@acme.test" && /^\[Sample\] Order received — SAMPLE-1001/.test(sent[0].subject));
  r = await post({ action: "updateEmailSettings", emailSettings: { attachPdf: false } });
  ok("the attach setting saves, and is audited", r.status === 200 && r.body.emailSettings.attachPdf === false && d1.q("SELECT count(*) n FROM audit_log WHERE action='settings.email_set'")[0].n === 1);
  await post({ action: "updateEmailSettings", emailSettings: { attachPdf: true } });
  r = await post({ action: "previewCustomerEmail" }, "acme");
  ok("only from the admin address", r.status === 401);
  ok("roles: preview and the sample PDF are a manager's, saving and sending a sample an admin's, the order PDF staff's",
    M.ACTION_ROLE.previewCustomerEmail === "manager" && M.ACTION_ROLE.samplePdf === "manager" && M.ACTION_ROLE.getEmailSettings === "manager" &&
    M.ACTION_ROLE.updateEmailSettings === "admin" && M.ACTION_ROLE.sendSampleEmail === "admin" && M.ACTION_ROLE.getOrderPdf === "staff");

  console.log("\n=== An order's own PDF (Orders → Invoice PDF) ===");
  r = await post({ action: "createLocalSale", org: "acme", paymentMethod: "Check", customerName: "Alex Sample", contact: "alex@example.net",
    items: [{ productId: "__custom__", name: "Polo", qty: 2, customUnitPrice: 25, type: "shirt", taxable: true }] });
  const saleId = r.body.orderId;
  r = await post({ action: "getOrderPdf", org: "acme", orderId: saleId });
  t = await pdfText(b64bytes(r.body.file.contentBase64));
  ok("the order's invoice as a PDF, priced before tax", r.status === 200 && r.body.file.filename === `Invoice ${saleId}.pdf` && /\$47\.17/.test(t.text) && /Sales tax \(6%\) \$2\.83/.test(t.text) && /\$50\.00/.test(t.text));
  r = await post({ action: "getOrderPdf", org: "other", orderId: saleId });
  ok("…not for another shop's order", r.status === 404);

  console.log("\n=== Setup status names what's missing ===");
  const st = (biz, payments) => M.setupStatus({ DB: {} }, { business: biz, payments, salesTax: {}, locale: {} }).find(i => i.key === "paymentDetails");
  ok("a blank profile: where to mail a check, Venmo, Zelle and a contact are all named", (s => !s.ready && /Mail checks to/.test(s.note) && /Venmo/.test(s.note) && /Zelle/.test(s.note) && /contact/.test(s.note))(st({}, null)));
  ok("only the methods the shop takes are asked for", (s => !s.ready && !/Venmo|Zelle/.test(s.note) && /Mail checks to/.test(s.note))(st({ phone: "1" }, { venmo: false, zelle: false, check: true })));
  ok("filled in: ready", st({ mailingAddress: "x", venmo: "v", zelle: "z", supportEmail: "e@x.co" }, null).ready);

  console.log("\n=== The admin's Customer emails box and preview window ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const calls = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async (url, opts) => {
        if (String(url).includes("/api/orders") && opts && opts.body) {
          const b = JSON.parse(opts.body); calls.push(b);
          const res = await post(b);
          return { ok: res.status < 400, status: res.status, json: async () => res.body };
        }
        if (String(url).includes("/api/catalog")) return { ok: true, status: 200, json: async () => ({ status: "admin", business: {}, features: {}, country: "US" }) };
        if (String(url).includes("127.0.0.1")) throw new Error("no agent in tests");
        return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
      };
      win.URL.createObjectURL = () => "blob:x"; win.URL.revokeObjectURL = () => {};
    } });
  const w = dom.window, docu = w.document;
  await tick(150); await w.loadAdminScript();
  w.eval('adminKey = "x"; adminOrgs = [{orgId:"acme", name:"Acme"}]; window.__role = "admin"; try { adminUser = { role: "admin" }; } catch (e) {}');
  w.location.hash = "#settings"; await w.adminRoute();
  for (let i = 0; i < 80 && !docu.getElementById("gEmailPreviewBtn"); i++) await tick(25);
  ok("Global settings has a Customer emails box: the attach setting, Preview emails…, View sample PDF receipt…", !!docu.getElementById("gEmailAttachPdf") && docu.getElementById("gEmailAttachPdf").checked &&
    !!docu.getElementById("gEmailPreviewBtn") && [...docu.querySelectorAll("button")].some(b => /View sample PDF receipt/.test(b.textContent)));
  ok("…and the Business profile has phone, website and a payment note", !!docu.getElementById("gBizPhone") && !!docu.getElementById("gBizWebsite") && !!docu.getElementById("gBizPaymentNote") && docu.getElementById("gBizPhone").value === "555-0100");
  docu.getElementById("gEmailPreviewBtn").click();
  for (let i = 0; i < 80 && !/SAMPLE/.test((docu.getElementById("epSubject") || {}).textContent || ""); i++) await tick(25);
  const frame = docu.getElementById("epFrame");
  ok("Preview: the subject line and the email in a sandboxed frame (no scripts)", /^Order received — SAMPLE-1001/.test(docu.getElementById("epSubject").textContent) &&
    frame.getAttribute("sandbox") === "" && /Alex Sample/.test(frame.getAttribute("srcdoc")) && /Attached: Invoice SAMPLE-1001\.pdf/.test(docu.getElementById("epAttach").textContent));
  docu.getElementById("epTabText").click();
  ok("…the plain-text tab", docu.getElementById("epText").style.display === "" && /SAMPLE-1001/.test(docu.getElementById("epText").textContent));
  const ex = docu.getElementById("epExample"); ex.value = "pickup"; ex.dispatchEvent(new w.Event("change"));
  for (let i = 0; i < 40 && !/Sticker pack/.test(docu.getElementById("epText").textContent); i++) await tick(25);
  ok("…switching to Without shipping redraws it", /Sticker pack/.test(docu.getElementById("epText").textContent) && calls.filter(c => c.action === "previewCustomerEmail").pop().example === "pickup");
  const kind = docu.getElementById("epKind"); kind.value = "payment"; kind.dispatchEvent(new w.Event("change"));
  for (let i = 0; i < 40 && !/Payment received/.test(docu.getElementById("epSubject").textContent); i++) await tick(25);
  ok("…and to Payment received", /^Payment received — SAMPLE-1001/.test(docu.getElementById("epSubject").textContent));
  let saved = null; const realClick = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = function(){ saved = this.download; };
  docu.getElementById("epDownload").click();
  for (let i = 0; i < 40 && !saved; i++) await tick(25);
  w.HTMLAnchorElement.prototype.click = realClick;
  ok("…Download PDF saves the sample", /^Receipt SAMPLE-1001\.pdf$/.test(saved || ""));
  ok("…Send me this sample is there for an admin", !!docu.getElementById("epSend"));

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exitCode = 1; });
