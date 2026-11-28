const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

// Decoration types (phase 5, 2026-11), the pure registry and the two migrations:
//   the registry at the top of functions/_lib/db.js   DECORATION_TYPES / KEYS / DEFAULT_DECORATIONS,
//     normalizeDecorationTypes (registry order, duplicates, unknown keys, text, empty / invalid -> the default),
//     decorationLabel / decorationMadeLabel (each key, unknown), graphicDecoration (each kind and decoration),
//     DEFAULT_DECORATION_PRICING and normalizeDecorationPricing (missing keys, non-numbers, negatives, bounds,
//     maxColors 1..12, rounding down), priceDecoration (every type and branch) and decorationCostCents.
//   migrations/0118 and 0119 against schema.sql   every column, CHECK, default and index, digitizing_jobs, the
//     owner_notices rebuild keeping every row and id and taking quote / gift_card / po, and migrationList.js.
// The real files, glued as the other tests do; real SQL (sql.js). Invented data only; nothing here depends on the date.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
global.fetch = async (url) => { throw new Error("unexpected fetch " + url); };

const lib = new Function(strip(read("functions/_lib/db.js")) +
  "\nreturn { DECORATION_TYPES, DECORATION_KEYS, DEFAULT_DECORATIONS, normalizeDecorationTypes, decorationLabel, decorationMadeLabel," +
  " graphicDecoration, DEFAULT_DECORATION_PRICING, normalizeDecorationPricing, priceDecoration, decorationCostCents };")();
const { MIGRATIONS } = new Function(strip(read("functions/_lib/migrationList.js")) + "\nreturn { MIGRATIONS };")();
const L = lib;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const say = (line) => console.log("\n" + line);
const KEYS = ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"];

const migrationFiles = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function makeDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrationFiles) if (!before || f < before) d1.execFile(read("migrations/" + f));
  return d1;
}
const fails = (d1, sql, ...p) => { try { d1.q(sql, ...p); return ""; } catch (e) { return String(e && e.message || e); } };
const tableSql = (d1, name) => { const r = d1.q("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", name)[0]; return r ? r.sql.replace(/\s+/g, " ").replace(/ IF NOT EXISTS/i, "").trim() : ""; };
const indexSql = (d1, name) => { const r = d1.q("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", name)[0]; return r ? r.sql.replace(/\s+/g, " ").replace(/ IF NOT EXISTS/i, "").trim() : ""; };
// Column by column, by name: an old table's new column comes last, in schema.sql it sits where it was written.
const shape = (d1, table) => JSON.stringify(d1.q(`PRAGMA table_info(${table})`).map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk]).sort((a, b) => a[0] < b[0] ? -1 : 1));
const col = (d1, table, name) => d1.q(`PRAGMA table_info(${table})`).find(c => c.name === name);
const CHECK = /CHECK constraint failed/;

(async () => {
  // =====================================================================================================
  say("=== The list of decoration types ===");
  ok("the registry has six types, in this order: embroidery, DTF, screen print, vinyl, DTG, sublimation",
    same(L.DECORATION_TYPES.map(t => t.key), KEYS));
  ok("DECORATION_KEYS is the registry's keys in order", same(L.DECORATION_KEYS, KEYS));
  ok("a new install does embroidery and DTF (what it did before types existed)", same(L.DEFAULT_DECORATIONS, ["embroidery", "dtf"]));
  ok("embroidery is the only machine type; DTF is the only one with transfer sheets",
    same(L.DECORATION_TYPES.filter(t => t.machine).map(t => t.key), ["embroidery"]) && same(L.DECORATION_TYPES.filter(t => t.sheets).map(t => t.key), ["dtf"]));
  ok("embroidery's graphics are embroidery graphics; every other type's are transfer graphics",
    L.DECORATION_TYPES.every(t => t.graphicKind === (t.key === "embroidery" ? "embroidery" : "transfer")));
  ok("each type has its own label and storefront word", new Set(L.DECORATION_TYPES.map(t => t.label)).size === 6 && new Set(L.DECORATION_TYPES.map(t => t.made)).size === 6 && L.DECORATION_TYPES.every(t => t.label && t.made));

  say("=== normalizeDecorationTypes: what is stored is cleaned to known types in registry order ===");
  ok("a list of known keys is kept", same(L.normalizeDecorationTypes(["embroidery", "screenprint"]), ["embroidery", "screenprint"]));
  ok("the answer is in registry order whatever order it was given", same(L.normalizeDecorationTypes(["sublimation", "dtf", "embroidery"]), ["embroidery", "dtf", "sublimation"]));
  ok("a type given twice comes once", same(L.normalizeDecorationTypes(["dtg", "dtg", "dtg"]), ["dtg"]));
  ok("an unknown key is dropped and the rest kept", same(L.normalizeDecorationTypes(["bogus", "vinyl", "Vinyl", 5, null]), ["vinyl"]));
  ok("all six can be on", same(L.normalizeDecorationTypes(KEYS.slice().reverse()), KEYS));
  ok("a stored JSON text is read", same(L.normalizeDecorationTypes('["dtg","embroidery","dtg","bogus"]'), ["embroidery", "dtg"]));
  ok("text that is not JSON gives the default", same(L.normalizeDecorationTypes("not json"), ["embroidery", "dtf"]));
  ok("nothing stored (null, undefined) gives the default", same(L.normalizeDecorationTypes(null), ["embroidery", "dtf"]) && same(L.normalizeDecorationTypes(undefined), ["embroidery", "dtf"]));
  ok("something that is not a list (an object, a number, JSON of a number) gives the default",
    same(L.normalizeDecorationTypes({ 0: "dtg" }), ["embroidery", "dtf"]) && same(L.normalizeDecorationTypes(7), ["embroidery", "dtf"]) && same(L.normalizeDecorationTypes("7"), ["embroidery", "dtf"]));
  ok("an empty list gives the default (a shop always has a type)", same(L.normalizeDecorationTypes([]), ["embroidery", "dtf"]) && same(L.normalizeDecorationTypes("[]"), ["embroidery", "dtf"]));
  ok("a list of only unknown keys gives the default", same(L.normalizeDecorationTypes(["bogus", "x"]), ["embroidery", "dtf"]));
  const dflt = L.normalizeDecorationTypes(null); dflt.push("dtg");
  ok("the default is a copy: changing an answer does not change DEFAULT_DECORATIONS", same(L.DEFAULT_DECORATIONS, ["embroidery", "dtf"]) && same(L.normalizeDecorationTypes(""), ["embroidery", "dtf"]));

  say("=== decorationLabel and decorationMadeLabel ===");
  const labels = { embroidery: "Embroidery", dtf: "DTF transfer", screenprint: "Screen print", vinyl: "Vinyl / heat transfer", dtg: "DTG", sublimation: "Sublimation" };
  const mades = { embroidery: "Embroidered", dtf: "Printed (DTF)", screenprint: "Screen printed", vinyl: "Vinyl", dtg: "DTG printed", sublimation: "Sublimated" };
  for (const k of KEYS) {
    ok(`${k} is labelled "${labels[k]}"`, L.decorationLabel(k) === labels[k]);
    ok(`${k} is made-labelled "${mades[k]}" on the storefront`, L.decorationMadeLabel(k) === mades[k]);
  }
  ok("an unknown key, an empty one and nothing give an empty label",
    L.decorationLabel("bogus") === "" && L.decorationLabel("") === "" && L.decorationLabel(undefined) === "" && L.decorationLabel("Dtf") === "");
  ok("an unknown key, an empty one and nothing give an empty made-label",
    L.decorationMadeLabel("bogus") === "" && L.decorationMadeLabel("") === "" && L.decorationMadeLabel(null) === "" && L.decorationMadeLabel("DTF") === "");

  say("=== graphicDecoration: the type a graphic is made with ===");
  ok("an embroidery graphic is embroidery", L.graphicDecoration({ kind: "embroidery" }) === "embroidery");
  ok("an embroidery graphic is embroidery even if its decoration column names a printed type", L.graphicDecoration({ kind: "embroidery", decoration: "dtg" }) === "embroidery");
  for (const k of KEYS.slice(1))
    ok(`a transfer graphic with decoration '${k}' is ${k}`, L.graphicDecoration({ kind: "transfer", decoration: k }) === k);
  ok("a transfer graphic with no decoration ('') is DTF (it always meant DTF)", L.graphicDecoration({ kind: "transfer", decoration: "" }) === "dtf");
  ok("a transfer graphic with the decoration column missing is DTF", L.graphicDecoration({ kind: "transfer" }) === "dtf");
  ok("a transfer graphic that says 'embroidery' is DTF (the column never holds it)", L.graphicDecoration({ kind: "transfer", decoration: "embroidery" }) === "dtf");
  ok("a transfer graphic with an unknown decoration is DTF", L.graphicDecoration({ kind: "transfer", decoration: "bogus" }) === "dtf");
  ok("a graphic of another kind, or with no kind, is DTF even with a printed decoration",
    L.graphicDecoration({ kind: "other", decoration: "vinyl" }) === "dtf" && L.graphicDecoration({ decoration: "vinyl" }) === "dtf");
  ok("nothing at all (null, undefined, {}) is DTF", L.graphicDecoration(null) === "dtf" && L.graphicDecoration(undefined) === "dtf" && L.graphicDecoration({}) === "dtf");

  // =====================================================================================================
  say("=== The default prices ===");
  const D = L.DEFAULT_DECORATION_PRICING;
  ok("every type has a price entry", same(Object.keys(D), KEYS));
  ok("embroidery: stitch pricing off, nothing per 1,000, no minimums", same(D.embroidery, { stitchPricing: false, centsPer1000: 0, minStitches: 0, minCents: 0 }));
  ok("screen print: no ink, screen, reorder or cost figures, up to 6 colours", same(D.screenprint, { inkColorCents: 0, screenSetupCents: 0, reorderSetupCents: 0, costCents: 0, maxColors: 6 }));
  ok("DTF, vinyl, DTG and sublimation: a cost, a price and a setup, all 0",
    ["dtf", "vinyl", "dtg", "sublimation"].every(k => same(D[k], { costCents: 0, priceCents: 0, setupCents: 0 })));

  say("=== normalizeDecorationPricing: missing, wrong and out-of-range figures are made safe ===");
  const N = L.normalizeDecorationPricing;
  ok("nothing stored (null, undefined, '') gives the defaults", same(N(null), D) && same(N(undefined), D) && same(N(""), D));
  ok("text that is not JSON, a list, a number or an empty object also give the defaults", same(N("{oops"), D) && same(N([1]), D) && same(N(5), D) && same(N({}), D));
  ok("a stored JSON text is read", N('{"dtf":{"priceCents":300}}').dtf.priceCents === 300);
  ok("missing types and missing figures are filled from the defaults", same(Object.keys(N({ dtg: { priceCents: 500 } })), KEYS) && same(N({ dtg: { priceCents: 500 } }).dtg, { costCents: 0, priceCents: 500, setupCents: 0 }) && same(N({ dtg: { priceCents: 500 } }).vinyl, D.vinyl));
  ok("a type whose entry is not an object (text, a list, null) is filled from the defaults", same(N({ dtf: "x", vinyl: [1], dtg: null }).dtf, D.dtf) && same(N({ vinyl: [1] }).vinyl, D.vinyl) && same(N({ dtg: null }).dtg, D.dtg));
  ok("unknown types and unknown figures are dropped", same(Object.keys(N({ bogus: { a: 1 } })), KEYS) && !("extra" in N({ dtf: { extra: 5 } }).dtf));
  const mix = N({ dtf: { costCents: "250", priceCents: 12.9, setupCents: "" }, vinyl: { costCents: -5, priceCents: "abc", setupCents: NaN }, dtg: { costCents: Infinity, priceCents: true, setupCents: null } });
  ok("a figure given as text is read as a number ('250' is 250)", mix.dtf.costCents === 250);
  ok("a fraction of a cent is rounded down (12.9 is 12)", mix.dtf.priceCents === 12);
  ok("an empty text is 0", mix.dtf.setupCents === 0);
  ok("a negative figure is 0", mix.vinyl.costCents === 0);
  ok("a figure that is not a number is 0", mix.vinyl.priceCents === 0 && mix.vinyl.setupCents === 0);
  ok("infinity, true and null are 0", mix.dtg.costCents === 0 && mix.dtg.priceCents === 0 && mix.dtg.setupCents === 0);
  ok("100,000,000 cents is kept and anything above is held at it", N({ dtf: { costCents: 100000000, priceCents: 100000001, setupCents: 9e15 } }).dtf.costCents === 100000000
    && N({ dtf: { priceCents: 100000001 } }).dtf.priceCents === 100000000 && N({ dtf: { setupCents: 9e15 } }).dtf.setupCents === 100000000);
  ok("stitch pricing is on only for true, 1 or '1'", N({ embroidery: { stitchPricing: true } }).embroidery.stitchPricing === true && N({ embroidery: { stitchPricing: 1 } }).embroidery.stitchPricing === true && N({ embroidery: { stitchPricing: "1" } }).embroidery.stitchPricing === true);
  ok("…and off for false, 0, 'true', 'yes', 2 or missing", [false, 0, "true", "yes", 2, null, undefined].every(v => N({ embroidery: { stitchPricing: v } }).embroidery.stitchPricing === false));
  const e = N({ embroidery: { stitchPricing: true, centsPer1000: "80", minStitches: 4000.7, minCents: -1 } }).embroidery;
  ok("embroidery's per-1,000 price, minimum stitches and minimum price are whole cents / stitches in range", e.centsPer1000 === 80 && e.minStitches === 4000 && e.minCents === 0);
  const sp = N({ screenprint: { inkColorCents: 150, screenSetupCents: "2000", reorderSetupCents: 500.5, costCents: 40 } }).screenprint;
  ok("screen print's ink, screen setup, reorder setup and cost figures are kept as whole cents", sp.inkColorCents === 150 && sp.screenSetupCents === 2000 && sp.reorderSetupCents === 500 && sp.costCents === 40);
  const mc = (v) => N({ screenprint: { maxColors: v } }).screenprint.maxColors;
  ok("max colours left out is 6", mc(undefined) === 6);
  ok("max colours 1 and 12 are kept", mc(1) === 1 && mc(12) === 12 && mc(7) === 7);
  ok("max colours above 12 is held at 12", mc(13) === 12 && mc(99) === 12 && mc(1e12) === 12);
  ok("max colours of 0, below 0 or text that is not a number is the default 6", mc(0) === 6 && mc(-5) === 6 && mc("x") === 6 && mc(null) === 6);
  ok("max colours as text ('3') or with a fraction (2.7) is read and rounded down", mc("3") === 3 && mc(2.7) === 2);
  const given = { dtf: { priceCents: 300 } }; const out = N(given); out.dtf.priceCents = 1; out.vinyl.priceCents = 9;
  ok("what comes back is new: changing it changes neither the input nor the defaults", given.dtf.priceCents === 300 && D.vinyl.priceCents === 0 && N(null).vinyl.priceCents === 0);
  ok("normalizing a normalized answer changes nothing", same(N(N({ screenprint: { maxColors: 20, inkColorCents: "99" }, embroidery: { stitchPricing: 1 } })), N({ screenprint: { maxColors: 20, inkColorCents: "99" }, embroidery: { stitchPricing: 1 } })));

  // =====================================================================================================
  say("=== priceDecoration: what a decoration adds to a line ===");
  const P = L.priceDecoration;
  const emb = (o) => ({ embroidery: Object.assign({ stitchPricing: true, centsPer1000: 100, minStitches: 0, minCents: 0 }, o) });
  ok("embroidery with stitch pricing off adds nothing and says so", same(P("embroidery", { stitches: 8500 }, null), { unitCents: 0, setupCents: 0, note: "Stitch pricing is off" }));
  ok("…also when the stored setting says off explicitly", P("embroidery", { stitches: 8500 }, { embroidery: { stitchPricing: false, centsPer1000: 100 } }).unitCents === 0);
  const e1 = P("embroidery", { stitches: 8500 }, emb());
  ok("embroidery at $1.00 per 1,000 for 8,500 stitches is 850 cents", e1.unitCents === 850);
  ok("embroidery has no setup charge", e1.setupCents === 0);
  ok("embroidery's note reads the stitches with a thousands comma and the rate", e1.note === "8,500 stitches × $1.00 per 1,000");
  ok("a design under the minimum stitches is billed at the minimum (3,000 of 5,000 -> 500)", P("embroidery", { stitches: 3000 }, emb({ minStitches: 5000 })).unitCents === 500);
  ok("…and the note names the billed stitches, not the real ones", P("embroidery", { stitches: 3000 }, emb({ minStitches: 5000 })).note === "5,000 stitches × $1.00 per 1,000");
  ok("a design over the minimum stitches is billed as it is", P("embroidery", { stitches: 9000 }, emb({ minStitches: 5000 })).unitCents === 900);
  ok("the minimum price lifts a small price (500 -> 700)", P("embroidery", { stitches: 5000 }, emb({ minCents: 700 })).unitCents === 700);
  ok("the minimum price does not lower a larger one", P("embroidery", { stitches: 9000 }, emb({ minCents: 700 })).unitCents === 900);
  ok("embroidery rounds half a cent up (500 stitches at 1 cent per 1,000 = 0.5 -> 1)", P("embroidery", { stitches: 500 }, emb({ centsPer1000: 1 })).unitCents === 1);
  ok("…and under half down (499 -> 0)", P("embroidery", { stitches: 499 }, emb({ centsPer1000: 1 })).unitCents === 0);
  ok("1,500 stitches at 1 cent per 1,000 (1.5) is 2", P("embroidery", { stitches: 1500 }, emb({ centsPer1000: 1 })).unitCents === 2);
  ok("stitches as text ('8500') are read", P("embroidery", { stitches: "8500" }, emb()).unitCents === 850);
  ok("stitches missing, negative or not a number count as 0 (or the minimum)", P("embroidery", {}, emb()).unitCents === 0 && P("embroidery", { stitches: -4000 }, emb()).unitCents === 0
    && P("embroidery", { stitches: "lots" }, emb()).unitCents === 0 && P("embroidery", { stitches: "lots" }, emb({ minStitches: 2000 })).unitCents === 200);
  ok("no params at all (null, undefined) do not crash embroidery", P("embroidery", null, emb()).unitCents === 0 && P("embroidery", undefined, emb()).unitCents === 0);
  ok("a rate with cents shows as dollars and cents in the note ($0.85)", P("embroidery", { stitches: 1000 }, emb({ centsPer1000: 85 })).note === "1,000 stitches × $0.85 per 1,000");

  const SP = { screenprint: { inkColorCents: 150, screenSetupCents: 2000, reorderSetupCents: 500, costCents: 40, maxColors: 6 } };
  const s1 = P("screenprint", { colors: 2, locations: 1 }, SP);
  ok("screen print, 2 colours, 1 location at $1.50 an ink colour is 300 each", s1.unitCents === 300);
  ok("…with a setup of $20 per colour (4000)", s1.setupCents === 4000);
  ok("…and the note says 2 colours × 1 location", s1.note === "2 colours × 1 location");
  ok("one colour says 'colour' and one location says 'location'", P("screenprint", { colors: 1, locations: 1 }, SP).note === "1 colour × 1 location");
  const s2 = P("screenprint", { colors: 3, locations: 2 }, SP);
  ok("each location multiplies the price (3 colours × 2 locations = 900) and the setup (3 × 2 × 2000 = 12000)", s2.unitCents === 900 && s2.setupCents === 12000);
  ok("…and the note says 3 colours × 2 locations", s2.note === "3 colours × 2 locations");
  const s3 = P("screenprint", { colors: 2, locations: 1, reorder: true }, SP);
  ok("a reorder uses the reorder setup (2 × 500 = 1000), not the screen setup", s3.setupCents === 1000);
  ok("a reorder costs the same per piece", s3.unitCents === 300);
  ok("…and the note says reorder", s3.note === "2 colours × 1 location, reorder");
  ok("only true counts as a reorder ('true', 1 do not)", P("screenprint", { colors: 2, reorder: "true" }, SP).setupCents === 4000 && P("screenprint", { colors: 2, reorder: 1 }, SP).setupCents === 4000);
  ok("colours above the shop's maximum are held at it (10 of 6 -> 6)", P("screenprint", { colors: 10 }, SP).unitCents === 900 && P("screenprint", { colors: 10 }, SP).note === "6 colours × 1 location");
  ok("a lower maximum is used (max 2: 5 colours -> 2)", P("screenprint", { colors: 5 }, { screenprint: Object.assign({}, SP.screenprint, { maxColors: 2 }) }).unitCents === 300);
  ok("colours of 0, negative, missing or text that is not a number count as 1", [0, -3, undefined, "x"].every(c => P("screenprint", { colors: c }, SP).unitCents === 150 && P("screenprint", { colors: c }, SP).setupCents === 2000));
  ok("colours with a fraction are rounded down (2.9 -> 2) and text numbers read ('3')", P("screenprint", { colors: 2.9 }, SP).unitCents === 300 && P("screenprint", { colors: "3" }, SP).unitCents === 450);
  ok("locations missing, 0 or negative count as 1", P("screenprint", { colors: 1 }, SP).unitCents === 150 && P("screenprint", { colors: 1, locations: 0 }, SP).unitCents === 150 && P("screenprint", { colors: 1, locations: -2 }, SP).unitCents === 150);
  ok("screen print with no prices set adds nothing but still says what it was", same(P("screenprint", { colors: 2, locations: 1 }, null), { unitCents: 0, setupCents: 0, note: "2 colours × 1 location" }));
  ok("no params at all give 1 colour × 1 location", P("screenprint", null, SP).note === "1 colour × 1 location" && P("screenprint", undefined, SP).unitCents === 150);

  const FL = { dtf: { costCents: 100, priceCents: 300, setupCents: 1500 }, vinyl: { costCents: 120, priceCents: 400, setupCents: 1000 },
    dtg: { costCents: 200, priceCents: 600, setupCents: 0 }, sublimation: { costCents: 150, priceCents: 450, setupCents: 500 } };
  for (const k of ["dtf", "vinyl", "dtg", "sublimation"]) {
    const r = P(k, { locations: 1 }, FL);
    ok(`${k}: one location is its price (${FL[k].priceCents}) with its setup (${FL[k].setupCents})`, r.unitCents === FL[k].priceCents && r.setupCents === FL[k].setupCents);
    ok(`${k}: the note says 1 location × the price`, r.note === "1 location × $" + (FL[k].priceCents / 100).toFixed(2));
    const r3 = P(k, { locations: 3 }, FL);
    ok(`${k}: three locations triple the price but not the setup`, r3.unitCents === FL[k].priceCents * 3 && r3.setupCents === FL[k].setupCents && r3.note === "3 locations × $" + (FL[k].priceCents / 100).toFixed(2));
    ok(`${k}: locations missing or 0 count as 1; text '2' is read`, P(k, {}, FL).unitCents === FL[k].priceCents && P(k, { locations: 0 }, FL).unitCents === FL[k].priceCents && P(k, { locations: "2" }, FL).unitCents === FL[k].priceCents * 2);
    ok(`${k}: with no prices set it adds nothing`, same(P(k, { locations: 2 }, null), { unitCents: 0, setupCents: 0, note: "2 locations × $0.00" }));
  }
  ok("a type each has its own prices (DTG is not DTF)", P("dtg", {}, FL).unitCents !== P("dtf", {}, FL).unitCents);
  ok("an unknown type adds nothing and has no note", same(P("bogus", { colors: 3, stitches: 9000 }, FL), { unitCents: 0, setupCents: 0, note: "" }));
  ok("no type at all adds nothing", same(P(undefined, {}, FL), { unitCents: 0, setupCents: 0, note: "" }) && same(P("", null, null), { unitCents: 0, setupCents: 0, note: "" }));
  ok("the prices may be given as the stored JSON text", P("dtf", {}, JSON.stringify(FL)).unitCents === 300);
  ok("bad stored figures are cleaned first (negative price is 0)", P("dtf", {}, { dtf: { priceCents: -300, setupCents: "x" } }).unitCents === 0);

  say("=== decorationCostCents: what a decoration costs the shop per piece ===");
  const C = L.decorationCostCents;
  ok("screen print costs per colour and per location (40 × 2 × 3 = 240)", C("screenprint", { colors: 2, locations: 3 }, SP) === 240);
  ok("screen print with no params is 1 colour × 1 location (40)", C("screenprint", null, SP) === 40 && C("screenprint", {}, SP) === 40);
  ok("screen print colours are held at the shop's maximum (cost 40 × 6)", C("screenprint", { colors: 20 }, SP) === 240);
  ok("screen print: colours or locations of 0 count as 1", C("screenprint", { colors: 0, locations: 0 }, SP) === 40);
  for (const k of ["dtf", "vinyl", "dtg", "sublimation"]) {
    ok(`${k} costs its cost per location (${FL[k].costCents} × 1 and × 2)`, C(k, {}, FL) === FL[k].costCents && C(k, { locations: 2 }, FL) === FL[k].costCents * 2);
    ok(`${k}'s colours do not matter`, C(k, { colors: 5 }, FL) === FL[k].costCents);
  }
  ok("embroidery's cost here is 0 (it stays run minutes plus supplies)", C("embroidery", { stitches: 9000, locations: 2 }, emb()) === 0);
  ok("an unknown type or none costs 0", C("bogus", {}, FL) === 0 && C(undefined, {}, FL) === 0);
  ok("with no prices set every cost is 0", KEYS.every(k => C(k, { colors: 3, locations: 2 }, null) === 0));
  ok("the prices may be stored JSON text, and no params do not crash", C("vinyl", undefined, JSON.stringify(FL)) === 120);

  // =====================================================================================================
  say("=== The database: migrations/0118 and schema.sql ===");
  const before118 = await makeDb("0118");
  const after118 = await makeDb("0119");
  const fresh = await createD1();
  fresh._raw.exec(read("schema.sql"));
  const full = await makeDb();

  ok("before 0118 there is no digitizing table and none of the new columns",
    !tableSql(before118, "digitizing_jobs") && !col(before118, "graphics", "decoration") && !col(before118, "products", "decorationType") && !col(before118, "order_items", "decStartedAt")
    && !col(before118, "order_items", "decMadeAt") && !col(before118, "vendors", "forDigitizing") && !col(before118, "expenses", "orderId"));
  for (const t of ["digitizing_jobs", "graphics", "products", "order_items", "vendors", "expenses", "owner_notices"])
    ok(`${t}: schema.sql's table is the migrations' table, column for column (names, types, NOT NULL, defaults, key)`, shape(fresh, t) === shape(full, t) && shape(full, t) !== "[]");
  ok("digitizing_jobs: its CREATE statement (with every CHECK) is the same text in schema.sql and the migration", !!tableSql(full, "digitizing_jobs") && tableSql(fresh, "digitizing_jobs") === tableSql(full, "digitizing_jobs"));
  for (const ix of ["idx_digitizing_order", "idx_expenses_order", "idx_owner_notices_unsent"])
    ok(`the index ${ix} is the same in schema.sql and the migrations`, !!indexSql(full, ix) && indexSql(fresh, ix) === indexSql(full, ix));
  ok("digitizing jobs are found by order (an index on digitizing_jobs.orderId)", indexSql(full, "idx_digitizing_order") === "CREATE INDEX idx_digitizing_order ON digitizing_jobs(orderId)");
  ok("an order's expenses are found through a partial index that skips expenses with no order",
    indexSql(full, "idx_expenses_order") === "CREATE INDEX idx_expenses_order ON expenses(orderId) WHERE orderId <> ''");
  ok("the unsent-notices index is on (sentAt, id)", indexSql(full, "idx_owner_notices_unsent") === "CREATE INDEX idx_owner_notices_unsent ON owner_notices(sentAt, id)");
  ok("the old copy of the notices table is gone after 0119", !tableSql(full, "owner_notices_old"));

  // Existing rows before 0118 take the "as before" defaults.
  const b = before118;
  b._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t0','t0');
    INSERT INTO graphics (orgId, name, createdAt, updatedAt) VALUES ('club','Example Club crest','t0','t0');
    INSERT INTO products (productId, orgId, type, name, createdAt, updatedAt) VALUES ('cap','club','cap','Cap','t0','t0');
    INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('O1','club','Pat Example','pat@example.com','2026-06-15T12:00:00.000Z');
    INSERT INTO order_items (orderId, orgId, name, type) VALUES ('O1','club','Cap','cap');
    INSERT INTO vendors (name, createdAt, updatedAt) VALUES ('Example Supply','t0','t0');`);
  const cat = b.q("SELECT id FROM expense_categories ORDER BY id LIMIT 1")[0];
  b._raw.run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt) VALUES ('2026-06-01','Thread',?,1200,'t0','t0')", [cat.id]);
  b.execFile(read("migrations/0118_decoration_types.sql"));
  ok("an existing graphic keeps working: its decoration is '' (DTF, as before)", b.q("SELECT decoration FROM graphics")[0].decoration === "");
  ok("an existing product's decorationType is '' (worked out as before)", b.q("SELECT decorationType FROM products")[0].decorationType === "");
  const oi = b.q("SELECT decStartedAt, decMadeAt FROM order_items")[0];
  ok("an existing order line has not been started or made", oi.decStartedAt === null && oi.decMadeAt === null);
  ok("an existing vendor does not digitize", b.q("SELECT forDigitizing FROM vendors")[0].forDigitizing === 0);
  ok("an existing expense is for no order ('')", b.q("SELECT orderId FROM expenses")[0].orderId === "");
  ok("the existing rows are all still there", b.q("SELECT COUNT(*) n FROM graphics")[0].n === 1 && b.q("SELECT COUNT(*) n FROM products")[0].n === 1 && b.q("SELECT COUNT(*) n FROM order_items")[0].n === 1 && b.q("SELECT COUNT(*) n FROM vendors")[0].n === 1 && b.q("SELECT COUNT(*) n FROM expenses")[0].n === 1);
  ok("the digitizing table starts empty", b.q("SELECT COUNT(*) n FROM digitizing_jobs")[0].n === 0);

  for (const [d1, built] of [[full, "after the migrations"], [fresh, "in a new database from schema.sql"]]) {
    say(`Columns, CHECKs and defaults, ${built}`);
    d1._raw.exec(`INSERT OR IGNORE INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t0','t0');`);
    let n = 0;
    const gfx = (v) => fails(d1, "INSERT INTO graphics (orgId, name, decoration, createdAt, updatedAt) VALUES ('club', ?, ?, 't0', 't0')", "g" + (++n), v);
    for (const v of ["", "dtf", "screenprint", "vinyl", "dtg", "sublimation"]) ok(`a graphic's decoration '${v}' is taken, ${built}`, gfx(v) === "");
    ok(`a graphic's decoration 'embroidery' is refused (an embroidery graphic keeps ''), ${built}`, CHECK.test(gfx("embroidery")));
    ok(`a graphic's decoration 'DTF' (another case) and 'bogus' are refused, ${built}`, CHECK.test(gfx("DTF")) && CHECK.test(gfx("bogus")));
    ok(`a graphic's decoration left out is '', ${built}`, (d1._raw.run("INSERT INTO graphics (orgId, name, createdAt, updatedAt) VALUES ('club','gd','t0','t0')"), d1.q("SELECT decoration FROM graphics WHERE name = 'gd'")[0].decoration === ""));
    ok(`a graphic's decoration may not be NULL, ${built}`, /NOT NULL constraint failed: graphics\.decoration/.test(gfx(null)));
    const prod = (v) => fails(d1, "INSERT INTO products (productId, orgId, type, name, decorationType, createdAt, updatedAt) VALUES (?, 'club', 'cap', 'Cap', ?, 't0', 't0')", "p" + (++n), v);
    for (const v of ["", "embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"]) ok(`a product's decorationType '${v}' is taken, ${built}`, prod(v) === "");
    ok(`a product's decorationType 'bogus' and 'Embroidery' are refused, ${built}`, CHECK.test(prod("bogus")) && CHECK.test(prod("Embroidery")));
    ok(`a product's decorationType may not be NULL, ${built}`, /NOT NULL constraint failed: products\.decorationType/.test(prod(null)));
    d1._raw.run("INSERT INTO products (productId, orgId, type, name, createdAt, updatedAt) VALUES ('pd','club','cap','Cap','t0','t0')");
    ok(`a product's decorationType left out is '', ${built}`, d1.q("SELECT decorationType FROM products WHERE productId = 'pd'")[0].decorationType === "");
    ok(`order_items.decStartedAt and decMadeAt are optional text with no default, ${built}`,
      ["decStartedAt", "decMadeAt"].every(c => { const x = col(d1, "order_items", c); return x && x.type === "TEXT" && x.notnull === 0 && x.dflt_value === null; }));
    const ven = (v) => fails(d1, "INSERT INTO vendors (name, forDigitizing, createdAt, updatedAt) VALUES (?, ?, 't0', 't0')", "v" + (++n), v);
    ok(`a vendor's forDigitizing 0 and 1 are taken, ${built}`, ven(0) === "" && ven(1) === "");
    ok(`a vendor's forDigitizing 2, -1 and NULL are refused, ${built}`, CHECK.test(ven(2)) && CHECK.test(ven(-1)) && /NOT NULL constraint failed: vendors\.forDigitizing/.test(ven(null)));
    d1._raw.run("INSERT INTO vendors (name, createdAt, updatedAt) VALUES ('vd','t0','t0')");
    ok(`a vendor left out does not digitize, ${built}`, d1.q("SELECT forDigitizing FROM vendors WHERE name = 'vd'")[0].forDigitizing === 0);
    const ec = d1.q("SELECT id FROM expense_categories ORDER BY id LIMIT 1")[0].id;
    d1._raw.run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt) VALUES ('2026-06-01','Thread',?,1200,'t0','t0')", [ec]);
    d1._raw.run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, orderId, createdAt, updatedAt) VALUES ('2026-06-02','Digitizing: Example Club crest',?,2500,'O9','t0','t0')", [ec]);
    ok(`an expense left out is for no order (''), and can name one, ${built}`, d1.q("SELECT orderId FROM expenses WHERE description = 'Thread'")[0].orderId === "" && d1.q("SELECT orderId FROM expenses WHERE description LIKE 'Digitizing%'")[0].orderId === "O9");
    ok(`an expense's orderId may not be NULL, ${built}`, /NOT NULL constraint failed: expenses\.orderId/.test(fails(d1, "INSERT INTO expenses (expenseDate, description, categoryId, amountCents, orderId, createdAt, updatedAt) VALUES ('2026-06-03','x',?,100,NULL,'t0','t0')", ec)));
    ok(`an expense's orderId is not a foreign key (an order that is gone leaves it), ${built}`, d1.q("PRAGMA foreign_key_list(expenses)").every(k => k.from !== "orderId"));

    say(`digitizing_jobs, ${built}`);
    const jc = (c) => c.name;
    ok(`digitizing_jobs has these columns in order, ${built}`, same(d1.q("PRAGMA table_info(digitizing_jobs)").map(jc),
      ["id", "orderId", "itemId", "designId", "estimateId", "name", "vendor", "sentAt", "returnedAt", "costCents", "expenseId", "note", "createdAt", "createdBy", "deletedAt"]));
    ok(`its id is the key and counts up, ${built}`, col(d1, "digitizing_jobs", "id").pk === 1);
    const job = (cols) => { const c = Object.assign({ sentAt: "2026-06-01", createdAt: "t0" }, cols); const k = Object.keys(c); return fails(d1, `INSERT INTO digitizing_jobs (${k.join(", ")}) VALUES (${k.map(() => "?").join(", ")})`, ...k.map(x => c[x])); };
    ok(`a job with just sentAt and createdAt is taken, ${built}`, job({}) === "");
    const row = d1.q("SELECT * FROM digitizing_jobs ORDER BY id LIMIT 1")[0];
    ok(`left out: no order, name, vendor, note or maker ('' each), no cost (0), and no line, design, quote, return date, expense or delete date, ${built}`,
      row.orderId === "" && row.name === "" && row.vendor === "" && row.note === "" && row.createdBy === "" && row.costCents === 0
      && row.itemId === null && row.designId === null && row.estimateId === null && row.returnedAt === null && row.expenseId === null && row.deletedAt === null);
    ok(`a job's id counts up from 1, ${built}`, Number.isInteger(row.id) && row.id >= 1);
    ok(`sentAt is required, ${built}`, /NOT NULL constraint failed: digitizing_jobs\.sentAt/.test(job({ sentAt: null })));
    ok(`createdAt is required, ${built}`, /NOT NULL constraint failed: digitizing_jobs\.createdAt/.test(job({ createdAt: null })));
    ok(`a cost of 0 and of 2500 are taken, ${built}`, job({ costCents: 0 }) === "" && job({ costCents: 2500 }) === "");
    ok(`a negative cost is refused, ${built}`, CHECK.test(job({ costCents: -1 })));
    ok(`a full job (order, line, design, quote, vendor, dates, cost, expense, note, maker) is taken, ${built}`,
      job({ orderId: "O1", itemId: 4, designId: 7, estimateId: 3, name: "Example Club left chest logo", vendor: "Example Digitizing", returnedAt: "2026-06-04", costCents: 3500, expenseId: 12, note: "Rush", createdBy: "pat@example.com", deletedAt: "t9" }) === "");
    ok(`the order, line, design, quote and expense are plain numbers and text with no foreign keys (a job outlives what it points at), ${built}`, d1.q("PRAGMA foreign_key_list(digitizing_jobs)").length === 0);
  }

  // =====================================================================================================
  say("=== migrations/0119: owner_notices is rebuilt and keeps every row ===");
  const m = await makeDb("0119");
  const old = [
    ["payment", "O1", "club", "Paid $20", "", "[]", 0, "2026-11-01T10:00:00Z", "2026-11-02T06:00:00Z"],
    ["refund", "O2", "club", "Refunded $5", "partial", "[]", 0, "2026-11-01T11:00:00Z", null],
    ["dispute", "O3", "club", "Dispute filed", "Respond by the date", "[]", 1, "2026-11-03T10:00:00Z", null],
    ["design", "O4", "works", "Design approved", "", "[\"https://example.test/a.png\",\"https://example.test/b.png\"]", 0, "2026-11-03T11:00:00Z", "2026-11-04T06:00:00Z"],
    ["delivered", "O5", "works", "Delivered", "", "[]", 0, "2026-11-04T10:00:00Z", null],
    ["invoice", "O6", "club", "Delivery chosen", "d", "[]", 1, "2026-11-04T11:00:00Z", null],
    ["picked_up", "O7", "club", "Picked up", "", "[]", 0, "2026-11-05T10:00:00Z", null],
  ];
  const ins = "INSERT INTO owner_notices (kind, orderId, orgId, summary, detail, imageUrls, urgent, createdAt, sentAt) VALUES (?,?,?,?,?,?,?,?,?)";
  ok("before 0119 a 'quote', a 'gift_card' and a 'po' notice are each refused",
    ["quote", "gift_card", "po"].every(k => CHECK.test(fails(m, ins, k, "O", "club", "x", "", "[]", 0, "t", null))));
  for (const r of old) m._raw.run(ins, r);
  m._raw.run("DELETE FROM owner_notices WHERE kind = 'refund'");   // a gap: new ids must carry on past the highest, not refill it
  const kept = m.q("SELECT * FROM owner_notices ORDER BY id");
  const maxBefore = Math.max(...kept.map(r => r.id));
  m.execFile(read("migrations/0119_quote_notices.sql"));
  const nowRows = m.q("SELECT * FROM owner_notices ORDER BY id");
  ok("every notice is still there (six of the seven; one was deleted before)", kept.length === 6 && nowRows.length === 6);
  ok("each keeps its id", same(kept.map(r => r.id), nowRows.map(r => r.id)));
  ok("each keeps every field (kind, order, shop, summary, detail, images, urgent, created, sent)", same(kept, nowRows));
  ok("a notice already sent keeps its sent time, an unsent one stays unsent", nowRows.find(r => r.kind === "payment").sentAt === "2026-11-02T06:00:00Z" && nowRows.find(r => r.kind === "dispute").sentAt === null);
  ok("an urgent notice is still urgent", nowRows.find(r => r.kind === "dispute").urgent === 1 && nowRows.find(r => r.kind === "payment").urgent === 0);
  ok("the old copy is dropped and the unsent-notices index is back", !tableSql(m, "owner_notices_old") && indexSql(m, "idx_owner_notices_unsent") === "CREATE INDEX idx_owner_notices_unsent ON owner_notices(sentAt, id)");
  for (const k of ["payment", "refund", "dispute", "design", "delivered", "invoice", "picked_up", "quote", "gift_card", "po"])
    ok(`a '${k}' notice is accepted`, fails(m, ins, k, "O9", "club", "A notice", "", "[]", 0, "2026-11-06T10:00:00Z", null) === "");
  ok("an unknown kind ('bogus', 'Quote', '') is still refused", ["bogus", "Quote", ""].every(k => CHECK.test(fails(m, ins, k, "O9", "club", "x", "", "[]", 0, "t", null))));
  ok("no kind is refused", /NOT NULL constraint failed: owner_notices\.kind/.test(fails(m, ins, null, "O9", "club", "x", "", "[]", 0, "t", null)));
  ok("a new notice's id carries on after the highest old one", Math.min(...m.q("SELECT id FROM owner_notices WHERE summary = 'A notice'").map(r => r.id)) > maxBefore);
  ok("a notice with no summary is refused, with imageUrls that are not JSON refused, with urgent 2 refused",
    /NOT NULL constraint failed: owner_notices\.summary/.test(fails(m, ins, "quote", "O", "club", null, "", "[]", 0, "t", null))
    && CHECK.test(fails(m, ins, "quote", "O", "club", "x", "", "{oops", 0, "t", null)) && CHECK.test(fails(m, ins, "quote", "O", "club", "x", "", "[]", 2, "t", null)));
  const q = m.q("SELECT * FROM owner_notices WHERE kind = 'quote' LIMIT 1")[0];
  ok("a notice with only the required fields has the defaults (no order, shop or detail, no images, not urgent, unsent)",
    (m._raw.run("INSERT INTO owner_notices (kind, summary, createdAt) VALUES ('po','Bare','t')"), true)
    && (() => { const r = m.q("SELECT * FROM owner_notices WHERE summary = 'Bare'")[0]; return r.orderId === "" && r.orgId === "" && r.detail === "" && r.imageUrls === "[]" && r.urgent === 0 && r.sentAt === null; })());
  ok("a quote notice can be read back as written", q && q.summary === "A notice" && q.createdAt === "2026-11-06T10:00:00Z");
  ok("owner_notices after the migration is the same table as schema.sql's, column for column and CHECK for CHECK", tableSql(fresh, "owner_notices") === tableSql(m, "owner_notices") && shape(fresh, "owner_notices") === shape(m, "owner_notices"));
  ok("the allowed kinds are exactly the ten of the contract", /CHECK \(kind IN \('payment', 'refund', 'dispute', 'design', 'delivered', 'invoice', 'picked_up', 'quote', 'gift_card', 'po'\)\)/.test(tableSql(m, "owner_notices")));
  const none = await makeDb("0119"); none.execFile(read("migrations/0119_quote_notices.sql"));
  ok("on a database with no notices the rebuild just leaves an empty table that takes a quote", none.q("SELECT COUNT(*) n FROM owner_notices")[0].n === 0 && fails(none, ins, "quote", "O", "club", "x", "", "[]", 0, "t", null) === "");

  say("=== The shipped migration list ===");
  const names = migrationFiles.map(f => f);
  ok("migrationList.js lists 0118_decoration_types.sql and 0119_quote_notices.sql, in that order, then 0120 (phase 6) and 0121 (phase 7) last",
    MIGRATIONS.slice(-4).join(",") === "0118_decoration_types.sql,0119_quote_notices.sql,0120_gift_cards_multi_codes.sql,0121_terms_and_own_garments.sql");
  ok("each of them exists in migrations/", names.includes("0118_decoration_types.sql") && names.includes("0119_quote_notices.sql"));
  ok("the list and the migrations folder are the same files in the same order", same(MIGRATIONS.filter(f => f >= "0006"), names));
  ok("no name is listed twice", new Set(MIGRATIONS).size === MIGRATIONS.length);
})().catch(e => { console.log("test crashed: " + (e && e.stack || e)); process.exit(1); });
