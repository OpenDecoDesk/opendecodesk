const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

// Quantity breaks (migrations/0109), the database and pricing side in functions/_lib/db.js:
//   - products.qtyBreaksJson in the migration and in schema.sql, and a database without 0109 that still lists,
//     saves and prices products
//   - normalizeQtyBreaks_: every rule and message, with and without the product (flat, sized, color groups)
//   - qtyBreakOffCents: the deepest break that applies, from a stored list
//   - orderBreakQty_: pieces per product over an order's lines
//   - parseProduct_ (getProductsByOrg / getProductsByIds) answering qtyBreaks in dollars
//   - createProduct / updateProduct saving breaks, and copyProductsFromOrg carrying them
//   - priceItem with opts.breakQty: off the base price only, after the color-group price, never below $0,
//     with listUnitPrice and breakOff, for plain and configurable products
//   - the PUBLISHED snapshot carrying the breaks a product had when it was published
// Real SQL (sql.js) and the real db.js. Invented shops and products only; nothing here depends on today's date.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) +
  "\nreturn { normalizeQtyBreaks_, qtyBreakOffCents, orderBreakQty_, QTY_BREAKS_MAX, createProduct, updateProduct, getProductsByOrg, getProductsByIds," +
  " copyProductsFromOrg, priceItem, priceLookups, publishShop, createTransfer, createGraphic, setTierPrices };")();

const MIGRATIONS = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function makeDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of MIGRATIONS) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('beta','beta','Example League','t','t');`);
  return d1;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const thrown = async (fn) => { try { await fn(); return null; } catch (e) { return e || new Error("thrown"); } };
const refused = (d1, sql) => { try { d1._raw.run(sql); return ""; } catch (e) { return String((e && e.message) || e); } };
const say = (line) => console.log("\n=== " + line + " ===");

(async () => {
  // =====================================================================================================
  say("The column: migrations/0109 and schema.sql");
  const d1 = await makeDb();
  const col = (db) => db.q("PRAGMA table_info(products)").find(c => c.name === "qtyBreaksJson");
  const c = col(d1);
  ok("products has a qtyBreaksJson column of text that can't be empty", !!c && c.type === "TEXT" && c.notnull === 1);
  ok("…its default is an empty list", !!c && c.dflt_value === "'[]'");
  ok("migrationList.js names 0109_estimates.sql", /"0109_estimates\.sql"/.test(read("functions/_lib/migrationList.js")));
  d1._raw.run(`INSERT INTO products (productId, orgId, type, name, pricingMode, flatPriceCents, createdAt, updatedAt) VALUES ('plain','acme','shirt','Plain','flat',1000,'t','t')`);
  ok("a product added without breaks gets []", d1.q("SELECT qtyBreaksJson FROM products WHERE productId='plain'")[0].qtyBreaksJson === "[]");
  ok("a value that isn't JSON is refused by the database", /CHECK constraint failed/i.test(refused(d1, "UPDATE products SET qtyBreaksJson='not json' WHERE productId='plain'")));
  d1._raw.run("DELETE FROM products WHERE productId='plain'");

  const fresh = await createD1();
  fresh._raw.exec(read("schema.sql"));
  const fc = col(fresh);
  ok("schema.sql's products.qtyBreaksJson has the same type, not-null and default as the migrated one",
    !!fc && fc.type === c.type && fc.notnull === c.notnull && fc.dflt_value === c.dflt_value);
  fresh._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPriceCents, createdAt, updatedAt) VALUES ('plain','acme','shirt','Plain','flat',1000,'t','t');`);
  ok("…and refuses a value that isn't JSON there too", /CHECK constraint failed/i.test(refused(fresh, "UPDATE products SET qtyBreaksJson='{oops' WHERE productId='plain'")));

  const old = await makeDb("0109");
  await lib.createProduct(old, "acme", { productId: "early", type: "shirt", name: "Early Tee", pricingMode: "flat", flatPrice: 20, visible: true, images: [], features: [] });
  old.execFile(read("migrations/0109_estimates.sql"));
  ok("a product that was there before the migration gets [] when it runs", old.q("SELECT qtyBreaksJson FROM products WHERE productId='early'")[0].qtyBreaksJson === "[]");

  // =====================================================================================================
  say("Checking a list of breaks without the product (normalizeQtyBreaks_)");
  const N = lib.normalizeQtyBreaks_;
  const MIN_MSG = "A quantity break starts at a whole number of pieces from 2 to 100,000.";
  ok("no list, null or an empty string is no breaks", same(N(), { breaks: [] }) && same(N(null), { breaks: [] }) && same(N(""), { breaks: [] }));
  ok("an empty list is no breaks", same(N([]), { breaks: [] }));
  ok("something that isn't a list is refused: \"Quantity breaks must be a list.\"",
    N({ minQty: 12, off: 1 }).error === "Quantity breaks must be a list." && N("12:1").error === "Quantity breaks must be a list." && N(12).error === "Quantity breaks must be a list.");
  ok("at most 6 breaks: QTY_BREAKS_MAX is 6", lib.QTY_BREAKS_MAX === 6);
  const six = [2, 3, 4, 5, 6, 7].map((q, i) => ({ minQty: q, off: i + 1 }));
  ok("six breaks are taken", Array.isArray(N(six).breaks) && N(six).breaks.length === 6);
  ok("a seventh is refused: \"Up to 6 quantity breaks.\"", N([...six, { minQty: 8, off: 7 }]).error === "Up to 6 quantity breaks.");
  ok("a break from 2 pieces and one from 100,000 are taken", same(N([{ minQty: 2, off: 1 }, { minQty: 100000, off: 2 }]).breaks, [{ minQty: 2, off: 1 }, { minQty: 100000, off: 2 }]));
  ok("a break from 1 piece is refused with the pieces message", N([{ minQty: 1, off: 1 }]).error === MIN_MSG);
  ok("…so is 0, a negative count and 100,001", N([{ minQty: 0, off: 1 }]).error === MIN_MSG && N([{ minQty: -12, off: 1 }]).error === MIN_MSG && N([{ minQty: 100001, off: 1 }]).error === MIN_MSG);
  ok("…and a count that isn't whole, or isn't a number, or is missing", N([{ minQty: 12.5, off: 1 }]).error === MIN_MSG && N([{ minQty: "a dozen", off: 1 }]).error === MIN_MSG && N([{ off: 1 }]).error === MIN_MSG);
  ok("…and an entry that isn't a break at all", N([null]).error === MIN_MSG && N([7]).error === MIN_MSG);
  ok("a count typed as text (\"12\") is read as the number", same(N([{ minQty: "12", off: "1.50" }]).breaks, [{ minQty: 12, off: 1.5 }]));
  const OFF_MSG = "The break from 12 pieces needs an amount off each piece, more than $0.";
  ok("an amount of $0 is refused: \"The break from 12 pieces needs an amount off each piece, more than $0.\"", N([{ minQty: 12, off: 0 }]).error === OFF_MSG);
  ok("…so is a negative amount, a blank one, a missing one and one that isn't a number",
    N([{ minQty: 12, off: -1 }]).error === OFF_MSG && N([{ minQty: 12, off: "" }]).error === OFF_MSG && N([{ minQty: 12 }]).error === OFF_MSG &&
    N([{ minQty: 12, off: null }]).error === OFF_MSG && N([{ minQty: 12, off: "lots" }]).error === OFF_MSG);
  ok("…and an amount that rounds to less than a cent", N([{ minQty: 12, off: 0.004 }]).error === OFF_MSG);
  ok("…and one over $100,000 (the most is $100,000)", N([{ minQty: 12, off: 100000.01 }]).error === OFF_MSG && same(N([{ minQty: 12, off: 100000 }]).breaks, [{ minQty: 12, off: 100000 }]));
  ok("the message names the break's own count", N([{ minQty: 48, off: 0 }]).error === "The break from 48 pieces needs an amount off each piece, more than $0.");
  ok("the amount is rounded to the cent", same(N([{ minQty: 12, off: 1.234 }]).breaks, [{ minQty: 12, off: 1.23 }]));
  ok("breaks come back sorted by count, in dollars", same(N([{ minQty: 48, off: 5 }, { minQty: 12, off: 1 }, { minQty: 24, off: 2.5 }]),
    { breaks: [{ minQty: 12, off: 1 }, { minQty: 24, off: 2.5 }, { minQty: 48, off: 5 }] }));
  ok("two breaks from the same count are refused: \"Two quantity breaks start at 12 pieces.\"",
    N([{ minQty: 12, off: 1 }, { minQty: 12, off: 2 }]).error === "Two quantity breaks start at 12 pieces.");
  ok("a deeper break taking the same off as the one before is refused: \"The break from 24 pieces must take more off than the break from 12.\"",
    N([{ minQty: 12, off: 2 }, { minQty: 24, off: 2 }]).error === "The break from 24 pieces must take more off than the break from 12.");
  ok("…and so is one taking less, whatever order they were typed in",
    N([{ minQty: 24, off: 1 }, { minQty: 12, off: 2 }]).error === "The break from 24 pieces must take more off than the break from 12.");
  ok("without the product, any amount up to $100,000 is taken (the price isn't known)", same(N([{ minQty: 12, off: 500 }]).breaks, [{ minQty: 12, off: 500 }]));

  // =====================================================================================================
  say("Checking breaks against the product's lowest price");
  const flatTee = { pricingMode: "flat", flatPrice: 10 };
  ok("a flat product: a break taking off less than its price is taken", same(N([{ minQty: 12, off: 9.99 }], flatTee).breaks, [{ minQty: 12, off: 9.99 }]));
  ok("…one taking off the whole price is refused, in plain words with both amounts",
    N([{ minQty: 12, off: 1 }, { minQty: 24, off: 10 }], flatTee).error === "The break from 24 pieces takes $10.00 off — it must be less than the lowest price, $10.00.");
  ok("…and one taking off more", N([{ minQty: 12, off: 12.5 }], flatTee).error === "The break from 12 pieces takes $12.50 off — it must be less than the lowest price, $10.00.");
  ok("a flat product's size prices don't count", same(N([{ minQty: 12, off: 9 }], { pricingMode: "flat", flatPrice: 10, sizePricing: { S: 5 } }).breaks, [{ minQty: 12, off: 9 }]));
  const sizedTee = { pricingMode: "sized", sizePricing: { S: 20, M: 15, XL: 22 } };
  ok("a sized product is held to its cheapest size: $15", N([{ minQty: 12, off: 15 }], sizedTee).error === "The break from 12 pieces takes $15.00 off — it must be less than the lowest price, $15.00." &&
    same(N([{ minQty: 12, off: 14.99 }], sizedTee).breaks, [{ minQty: 12, off: 14.99 }]));
  ok("…its flat price doesn't count", same(N([{ minQty: 12, off: 14 }], { ...sizedTee, flatPrice: 3 }).breaks, [{ minQty: 12, off: 14 }]));
  ok("…a size left blank or without a price is passed over",
    same(N([{ minQty: 12, off: 14 }], { pricingMode: "sized", sizePricing: { S: 20, M: 15, L: "", XL: null, "2XL": "n/a", "3XL": -1 } }).breaks, [{ minQty: 12, off: 14 }]));
  const grouped = { pricingMode: "sized", sizePricing: { S: 20, M: 20 }, colorGroups: [{ label: "Value", colors: ["Ash"], sizePricing: { S: 12, M: 13 } }, null] };
  ok("a sized product's color group with a lower price sets the lowest price: $12",
    N([{ minQty: 12, off: 12 }], grouped).error === "The break from 12 pieces takes $12.00 off — it must be less than the lowest price, $12.00." &&
    same(N([{ minQty: 12, off: 11.99 }], grouped).breaks, [{ minQty: 12, off: 11.99 }]));
  const flatGrouped = { pricingMode: "flat", flatPrice: 16, colorGroups: [{ label: "Value", colors: ["Ash"], flatPrice: 8 }] };
  ok("a flat product's color group with a lower flat price sets it too: $8",
    N([{ minQty: 12, off: 8 }], flatGrouped).error === "The break from 12 pieces takes $8.00 off — it must be less than the lowest price, $8.00." &&
    same(N([{ minQty: 12, off: 7.5 }], flatGrouped).breaks, [{ minQty: 12, off: 7.5 }]));
  ok("a product with no price yet isn't checked against one", same(N([{ minQty: 12, off: 50 }], { pricingMode: "sized", sizePricing: {} }).breaks, [{ minQty: 12, off: 50 }]) &&
    same(N([{ minQty: 12, off: 50 }], { pricingMode: "flat" }).breaks, [{ minQty: 12, off: 50 }]));
  ok("something that isn't a product isn't checked against one", same(N([{ minQty: 12, off: 50 }], "flat").breaks, [{ minQty: 12, off: 50 }]));
  ok("an empty list is fine with any product", same(N([], flatTee), { breaks: [] }));
  ok("the other rules still come first with a product", N([{ minQty: 1, off: 50 }], flatTee).error === MIN_MSG);

  // =====================================================================================================
  say("Cents off for a number of pieces (qtyBreakOffCents)");
  const OFF = lib.qtyBreakOffCents;
  const stored = JSON.stringify([{ minQty: 12, offCents: 150 }, { minQty: 24, offCents: 300 }, { minQty: 48, offCents: 500 }]);
  ok("fewer pieces than the first break: nothing off", OFF(stored, 11) === 0 && OFF(stored, 1) === 0);
  ok("exactly the first break's count: its amount", OFF(stored, 12) === 150);
  ok("between two breaks: the lower one", OFF(stored, 23) === 150 && OFF(stored, 47) === 300);
  ok("at and past the deepest: the deepest only (breaks never add up)", OFF(stored, 48) === 500 && OFF(stored, 5000) === 500);
  ok("a list stored out of order still gives the deepest that applies", OFF(JSON.stringify([{ minQty: 48, offCents: 500 }, { minQty: 12, offCents: 150 }]), 30) === 150);
  ok("the list itself (not JSON text) works the same", OFF([{ minQty: 12, offCents: 150 }], 12) === 150);
  ok("a count given as text is read as the number", OFF(stored, "24") === 300);
  ok("no count, or one that isn't a number, is nothing off", OFF(stored) === 0 && OFF(stored, "many") === 0);
  ok("no breaks, null, unreadable JSON or JSON that isn't a list: nothing off",
    OFF("[]", 100) === 0 && OFF(null, 100) === 0 && OFF(undefined, 100) === 0 && OFF("{oops", 100) === 0 && OFF('{"minQty":2,"offCents":100}', 100) === 0);
  ok("stored entries that make no sense are left out (count 0 or not whole, amount 0, negative or missing)",
    OFF([{ minQty: 0, offCents: 900 }, { minQty: 2.5, offCents: 800 }, { minQty: 3, offCents: 0 }, { minQty: 4, offCents: -100 }, { minQty: 5 }, null, { minQty: 6, offCents: 50 }], 100) === 50);

  // =====================================================================================================
  say("Counting an order's pieces per product (orderBreakQty_)");
  const Q = lib.orderBreakQty_;
  const m = Q([
    { productId: "tee", size: "S", qty: 5 },
    { productId: "tee", size: "XL", qty: 4, config: { garmentColor: "Navy" } },
    { productId: "tee", size: "M", qty: 3, config: { garmentColor: "Ash" }, kind: "product" },
    { productId: "cap", qty: 2 },
    { productId: "tee-long", qty: 6, versionLabel: "Long sleeve" },
    { productId: "tee", qty: 10, cancelled: 1 },
    { productId: "tee", qty: 10, cancelDate: "2026-01-02" },
    { productId: "tee", qty: 10, kind: "custom" },
    { productId: "tee", qty: 10, kind: "fee" },
    { productId: "", qty: 10 }, { productId: null, qty: 10 }, { qty: 10, name: "Setup fee" }, null,
  ]);
  ok("every size and color line of one product is counted together", m.get("tee") === 12);
  ok("another product is counted apart", m.get("cap") === 2);
  ok("a version of a product is its own product (versions aren't added together)", m.get("tee-long") === 6);
  ok("cancelled lines (cancelled or with a cancel date), custom and fee lines, and lines with no product aren't counted", m.size === 3);
  ok("an id given as a number counts with the same id as text", Q([{ productId: 7, qty: 2 }, { productId: "7", qty: 3 }]).get("7") === 5);
  const frac = Q([{ productId: "a", qty: 2.9 }, { productId: "b", qty: 0 }, { productId: "c", qty: -4 }, { productId: "d", qty: "many" }, { productId: "e", qty: "3" }]);
  ok("a part piece is rounded down, and no pieces (0, negative, not a number) leaves the product out", frac.get("a") === 2 && !frac.has("b") && !frac.has("c") && !frac.has("d") && frac.get("e") === 3);
  ok("no list at all is an empty map", Q(null) instanceof Map && Q(null).size === 0 && Q("tee").size === 0);

  // =====================================================================================================
  say("Saving breaks with a product (createProduct / updateProduct) and reading them back");
  const stor = (db, org, id) => { const r = db.q("SELECT qtyBreaksJson FROM products WHERE orgId=? AND productId=?", org, id)[0]; return r ? JSON.parse(r.qtyBreaksJson) : null; };
  const prod = async (db, org, id) => (await lib.getProductsByOrg(db, org)).find(p => p.productId === id);
  const tee = { productId: "tee", type: "shirt", name: "Example Tee", pricingMode: "flat", flatPrice: 20, personalizationPrice: 5, visible: true, noDesignNeeded: true,
    customDesign: "embroidery", customDesignPrice: 6, images: [], features: [] };
  await lib.createProduct(d1, "acme", { ...tee, qtyBreaks: [{ minQty: 24, off: 3.5 }, { minQty: 12, off: "2" }] });
  ok("createProduct stores the breaks in cents, sorted", same(stor(d1, "acme", "tee"), [{ minQty: 12, offCents: 200 }, { minQty: 24, offCents: 350 }]));
  ok("the product reads back with qtyBreaks in dollars", same((await prod(d1, "acme", "tee")).qtyBreaks, [{ minQty: 12, off: 2 }, { minQty: 24, off: 3.5 }]));
  ok("…from getProductsByIds as well", same((await lib.getProductsByIds(d1, "acme", ["tee"]))[0].qtyBreaks, [{ minQty: 12, off: 2 }, { minQty: 24, off: 3.5 }]));
  const capDef = { productId: "cap", type: "cap", name: "Example Cap", pricingMode: "flat", flatPrice: 15, visible: true, images: [], features: [] };
  // updateProduct is sent the whole product, as the product form sends it.
  const upd = (db, org, base, extra) => lib.updateProduct(db, org, { ...base, ...extra });
  await lib.createProduct(d1, "acme", capDef);
  ok("a product created without breaks has none: [] stored, [] read", same(stor(d1, "acme", "cap"), []) && same((await prod(d1, "acme", "cap")).qtyBreaks, []));
  let e = await thrown(() => lib.createProduct(d1, "acme", { productId: "bad", type: "shirt", name: "Bad Breaks", pricingMode: "flat", flatPrice: 20, visible: true, images: [], features: [],
    qtyBreaks: [{ minQty: 1, off: 1 }] }));
  ok("createProduct refuses breaks that break a rule, with the rule's message for the person", !!e && e.userFacing === true && e.message === MIN_MSG);
  ok("…and stores none of them", same(stor(d1, "acme", "bad"), []));
  e = await thrown(() => upd(d1, "acme", capDef, { qtyBreaks: { minQty: 12, off: 1 } }));
  ok("updateProduct refuses a value that isn't a list: \"Quantity breaks must be a list.\"", !!e && e.userFacing === true && e.message === "Quantity breaks must be a list.");
  await upd(d1, "acme", capDef, { qtyBreaks: [{ minQty: 6, off: 1 }] });
  ok("updateProduct saves new breaks", same(stor(d1, "acme", "cap"), [{ minQty: 6, offCents: 100 }]));
  await upd(d1, "acme", capDef, { runMinutes: 4 });
  ok("an update that doesn't send qtyBreaks leaves them as they were", same(stor(d1, "acme", "cap"), [{ minQty: 6, offCents: 100 }]));
  await lib.createProduct(d1, "beta", { ...capDef, qtyBreaks: [{ minQty: 50, off: 4 }] });
  await upd(d1, "acme", capDef, { qtyBreaks: [] });
  ok("sending an empty list clears them", same(stor(d1, "acme", "cap"), []));
  ok("…in that shop only: another shop's product with the same id keeps its own", same(stor(d1, "beta", "cap"), [{ minQty: 50, offCents: 400 }]));
  await upd(d1, "beta", capDef, { qtyBreaks: null });
  ok("sending null clears them too", same(stor(d1, "beta", "cap"), []));
  await upd(d1, "beta", capDef, { qtyBreaks: [{ minQty: 12, off: 50 }] });
  ok("saving doesn't check the price (the admin action does that first): $50 off a $15 cap is stored", same(stor(d1, "beta", "cap"), [{ minQty: 12, offCents: 5000 }]));
  d1._raw.run(`UPDATE products SET qtyBreaksJson='{"minQty":12}' WHERE orgId='acme' AND productId='cap'`);
  ok("a stored value that isn't a list reads back as no breaks", same((await prod(d1, "acme", "cap")).qtyBreaks, []));
  d1._raw.run(`UPDATE products SET qtyBreaksJson='[{"minQty":24,"offCents":300},{"minQty":0,"offCents":100},{"minQty":12,"offCents":0},{"minQty":6,"offCents":125}]' WHERE orgId='acme' AND productId='cap'`);
  ok("stored entries that make no sense are left out of what reads back, the rest sorted", same((await prod(d1, "acme", "cap")).qtyBreaks, [{ minQty: 6, off: 1.25 }, { minQty: 24, off: 3 }]));
  d1._raw.run(`UPDATE products SET qtyBreaksJson='[]' WHERE orgId='acme' AND productId='cap'`);

  // =====================================================================================================
  say("Copying products to another shop (copyProductsFromOrg)");
  const copied = await lib.copyProductsFromOrg(d1, "acme", "beta", [
    { fromProductId: "tee", productId: "tee-copy", name: "Example Tee", sub: "", type: "shirt", visible: true },
    { fromProductId: "cap", productId: "cap-copy", name: "Example Cap", sub: "", type: "cap", visible: true }]);
  ok("the copy carries the product's breaks", copied.length === 2 && same(stor(d1, "beta", "tee-copy"), [{ minQty: 12, offCents: 200 }, { minQty: 24, offCents: 350 }]) &&
    same((await prod(d1, "beta", "tee-copy")).qtyBreaks, [{ minQty: 12, off: 2 }, { minQty: 24, off: 3.5 }]));
  ok("…and a product with none is copied with none", same(stor(d1, "beta", "cap-copy"), []));
  ok("…and the original keeps its own", same(stor(d1, "acme", "tee"), [{ minQty: 12, offCents: 200 }, { minQty: 24, offCents: 350 }]));

  // =====================================================================================================
  say("Pricing a plain product with breaks (priceItem)");
  const P = (productId, size, qty, personalized, config, opts) => lib.priceItem(d1, "acme", productId, size, qty, personalized, config, opts);
  let r = await P("tee", null, 1, false, null);
  ok("one piece: $20, nothing off, the list price $20", r.unitPrice === 20 && r.breakOff === 0 && r.listUnitPrice === 20);
  r = await P("tee", null, 12, false, null);
  ok("with no breakQty the line's own qty counts: 12 pieces take the $2 break → $18", r.unitPrice === 18 && r.breakOff === 2 && r.listUnitPrice === 20);
  r = await P("tee", null, 12, false, null, { breakQty: null });
  ok("…breakQty null is the same as none", r.unitPrice === 18);
  r = await P("tee", null, 1, false, null, { breakQty: 12 });
  ok("breakQty (the whole order's pieces of this product) is what counts: 1 piece in an order of 12 → $18", r.unitPrice === 18 && r.breakOff === 2);
  r = await P("tee", null, 30, false, null, { breakQty: 5 });
  ok("…even when it is lower than the line's qty: 30 on the line, breakQty 5 → $20", r.unitPrice === 20 && r.breakOff === 0);
  r = await P("tee", null, 30, false, null, { breakQty: 0 });
  ok("…and breakQty 0 is nothing off", r.unitPrice === 20 && r.breakOff === 0);
  ok("11 pieces: no break; 23: the $2 one; 24 and 1,000: the deepest, $3.50 only",
    (await P("tee", null, 1, false, null, { breakQty: 11 })).unitPrice === 20 && (await P("tee", null, 1, false, null, { breakQty: 23 })).unitPrice === 18 &&
    (await P("tee", null, 1, false, null, { breakQty: 24 })).unitPrice === 16.5 && (await P("tee", null, 1, false, null, { breakQty: 1000 })).breakOff === 3.5);
  r = await P("tee", null, 1, true, null, { breakQty: 24 });
  ok("personalization isn't discounted: $5 personalization stays $5 at the deepest break", r.unitPrice === 16.5 && r.personalizationFee === 5 && r.listUnitPrice === 20);
  r = await P("tee", null, 1, false, null, { breakQty: 24, custom: { customdesign: null } });
  ok("the customer's own design add-on isn't discounted: $20 − $3.50 + $6 = $22.50, list $26", r.unitPrice === 22.5 && r.breakOff === 3.5 && r.listUnitPrice === 26);
  r = await P("tee", null, 1, false, null, { breakQty: 24, lookups: lib.priceLookups() });
  ok("priced with a request's lookups, the break is the same", r.unitPrice === 16.5 && r.breakOff === 3.5);

  await lib.createProduct(d1, "acme", { productId: "hood", type: "shirt", name: "Example Hoodie", pricingMode: "sized", sizePricing: { S: 15, XL: 18 }, visible: true, noDesignNeeded: true,
    images: [], features: [], qtyBreaks: [{ minQty: 10, off: 1 }] });
  ok("a sized product: the break comes off each size's price (S $15 → $14, XL $18 → $17)",
    (await P("hood", "S", 1, false, null, { breakQty: 10 })).unitPrice === 14 && (await P("hood", "XL", 1, false, null, { breakQty: 10 })).unitPrice === 17 &&
    (await P("hood", "XL", 1, false, null, { breakQty: 10 })).listUnitPrice === 18);

  await lib.createProduct(d1, "acme", { productId: "patch", type: "patch", name: "Example Patch", pricingMode: "flat", flatPrice: 2, personalizationPrice: 5, visible: true, noDesignNeeded: true,
    customDesign: "embroidery", customDesignPrice: 6, images: [], features: [], qtyBreaks: [{ minQty: 10, off: 5 }] });
  r = await P("patch", null, 1, false, null, { breakQty: 10 });
  ok("a break bigger than the price never takes it below $0: $5 off a $2 patch → $0, $2 off, list $2", r.unitPrice === 0 && r.breakOff === 2 && r.listUnitPrice === 2);
  r = await P("patch", null, 1, true, null, { breakQty: 10, custom: { customdesign: null } });
  ok("…and what's taken off stops at the base price, so personalization ($5) and the design add-on ($6) are still charged", r.unitPrice === 6 && r.personalizationFee === 5 && r.breakOff === 2 && r.listUnitPrice === 8);

  // =====================================================================================================
  say("Pricing a configurable product with breaks");
  const t = await lib.createTransfer(d1, { name: "Crest sheet" });
  const g = await lib.createGraphic(d1, "acme", { name: "Crest", kind: "transfer", transferId: t, tier: "medium" });
  await lib.setTierPrices(d1, "acme", { small: 1, medium: 2, large: 4 });
  await lib.createProduct(d1, "acme", { productId: "polo", type: "shirt", name: "Example Polo", pricingMode: "sized", sizePricing: { S: 30 }, personalizationPrice: 3, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Black", "Oxford Heather"], locations: [{ key: "front", label: "Front", graphicIds: [g] }], images: [], features: [],
    colorGroupsCents: [{ key: "heathers", label: "Heathers", colors: ["Oxford Heather"], sizePricingCents: { S: 3400 } }], qtyBreaks: [{ minQty: 12, off: 4 }] });
  const cfg = (color) => ({ garmentColor: color, locations: { front: { graphicId: g } } });
  r = await P("polo", "S", 1, false, cfg("Black"), { breakQty: 11 });
  ok("under the break: $30 + the $2 graphic = $32, nothing off, list $32", r.unitPrice === 32 && r.breakOff === 0 && r.listUnitPrice === 32);
  r = await P("polo", "S", 1, false, cfg("Black"), { breakQty: 12 });
  ok("at the break: $30 − $4 + $2 = $28 (the graphic add-on isn't discounted), list $32, $4 off", r.unitPrice === 28 && r.breakOff === 4 && r.listUnitPrice === 32);
  r = await P("polo", "S", 1, false, cfg("Oxford Heather"), { breakQty: 12 });
  ok("a color in a price group: the break comes off the group's price, $34 − $4 + $2 = $32, list $36", r.unitPrice === 32 && r.breakOff === 4 && r.listUnitPrice === 36);
  r = await P("polo", "S", 12, true, cfg("Black"));
  ok("…12 on the line with no breakQty takes the break too, and personalization ($3) isn't discounted", r.unitPrice === 28 && r.personalizationFee === 3 && !!r.config);
  d1._raw.run(`UPDATE products SET qtyBreaksJson='[{"minQty":12,"offCents":3200}]' WHERE orgId='acme' AND productId='polo'`);
  const blackDeep = await P("polo", "S", 1, false, cfg("Black"), { breakQty: 12 }), heatherDeep = await P("polo", "S", 1, false, cfg("Oxford Heather"), { breakQty: 12 });
  ok("the cap at $0 is worked out after the group price: a $32 break takes all $30 off Black but only $32 of Heathers' $34",
    blackDeep.breakOff === 30 && blackDeep.unitPrice === 2 && heatherDeep.breakOff === 32 && heatherDeep.unitPrice === 4);
  ok("…and the graphic add-on is still charged on both, with the list price before the break", blackDeep.listUnitPrice === 32 && heatherDeep.listUnitPrice === 36);
  d1._raw.run(`UPDATE products SET qtyBreaksJson='[{"minQty":12,"offCents":400}]' WHERE orgId='acme' AND productId='polo'`);

  // =====================================================================================================
  say("The published catalog carries the breaks");
  await lib.publishShop(d1, "acme", "owner@example.com");
  await upd(d1, "acme", tee, { qtyBreaks: [{ minQty: 6, off: 1 }] });
  await upd(d1, "acme", capDef, { qtyBreaks: [{ minQty: 2, off: 3 }] });
  ok("after publishing, a change to the live breaks doesn't change the price: 6 pieces still pay $20, 12 still $18",
    (await P("tee", null, 1, false, null, { breakQty: 6 })).unitPrice === 20 && (await P("tee", null, 1, false, null, { breakQty: 12 })).unitPrice === 18);
  ok("…with the request's lookups too", (await P("tee", null, 1, false, null, { breakQty: 6, lookups: lib.priceLookups() })).unitPrice === 20);
  ok("a product published with no breaks gets none from breaks added since", (await P("cap", null, 1, false, null, { breakQty: 2 })).breakOff === 0);
  await lib.publishShop(d1, "acme", "owner@example.com");
  ok("publishing again brings the new breaks: 6 pieces → $19, 12 → $19 (the old $2 break is gone)",
    (await P("tee", null, 1, false, null, { breakQty: 6 })).unitPrice === 19 && (await P("tee", null, 1, false, null, { breakQty: 12 })).unitPrice === 19);
  ok("…and the cap's: 2 pieces → $12", (await P("cap", null, 1, false, null, { breakQty: 2 })).unitPrice === 12);

  // =====================================================================================================
  say("A database without migrations/0109");
  const pre = await makeDb("0109");
  ok("it has no qtyBreaksJson column", !pre.q("PRAGMA table_info(products)").some(x => x.name === "qtyBreaksJson"));
  e = await thrown(() => lib.createProduct(pre, "acme", { ...tee, qtyBreaks: [{ minQty: 12, off: 2 }] }));
  ok("createProduct with breaks still saves the product (the breaks are left out)", e === null && pre.q("SELECT count(*) AS n FROM products WHERE productId='tee'")[0].n === 1);
  e = await thrown(() => upd(pre, "acme", tee, { qtyBreaks: [{ minQty: 12, off: 2 }] }));
  ok("updateProduct with breaks goes through", e === null);
  ok("the product is listed, with no breaks", same((await prod(pre, "acme", "tee")).qtyBreaks, []) && (await prod(pre, "acme", "tee")).name === "Example Tee");
  r = await lib.priceItem(pre, "acme", "tee", null, 100, false, null, { breakQty: 100 });
  ok("it is priced at its full price: $20, nothing off, list $20", r.unitPrice === 20 && r.breakOff === 0 && r.listUnitPrice === 20);
  await lib.publishShop(pre, "acme", "owner@example.com");
  pre.execFile(read("migrations/0109_estimates.sql"));
  await upd(pre, "acme", tee, { qtyBreaks: [{ minQty: 12, off: 2 }] });
  ok("after 0109 runs, the breaks can be saved", same(stor(pre, "acme", "tee"), [{ minQty: 12, offCents: 200 }]));
  r = await lib.priceItem(pre, "acme", "tee", null, 100, false, null, { breakQty: 100 });
  ok("…but a snapshot published before 0109 has no breaks, so the price stays $20 until the shop is published again", r.unitPrice === 20 && r.breakOff === 0);
  await lib.publishShop(pre, "acme", "owner@example.com");
  ok("…and once it is, the break applies: $18", (await lib.priceItem(pre, "acme", "tee", null, 100, false, null, { breakQty: 100 })).unitPrice === 18);
})().catch((e) => { console.log("the test file ran to the end", false); console.error(e); process.exitCode = 1; });
