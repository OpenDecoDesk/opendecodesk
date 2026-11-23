// A focused text box's ring is drawn inside the box, so it never covers the label written right above
// it (a tester saw the old ring — white, 3px outside every control — cut into labels). The dark order
// panel keeps a white ring; its rule must be at least as specific as the general one, or the general
// rule's color wins there.
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const html = storefrontPage();
const css = html.slice(html.indexOf("<style"), html.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// Each rule as { selectors: [...], body }.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selectors: m[1].split(",").map(s => s.trim()).filter(Boolean), body: m[2] }));
const ruleFor = (sel) => rules.find(r => r.selectors.includes(sel));
// Specificity as [ids, classes/attributes/pseudo-classes, elements]; :not(x) counts as x.
const specificity = (sel) => {
  const s = sel.replace(/:not\(([^)]*)\)/g, " $1");
  return [(s.match(/#[\w-]+/g) || []).length,
    (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length,
    (s.replace(/\[[^\]]+\]/g, "").match(/(^|[\s>+~])[a-z]+/g) || []).length];
};
const atLeast = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

const TEXT = "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):focus-visible";
const general = ruleFor(TEXT), dark = ruleFor(".ticket " + TEXT);
ok("text boxes, pick lists and text areas have their own focus rule", general && ["select:focus-visible", "textarea:focus-visible"].every(s => general.selectors.includes(s)));
ok("…a ring drawn inside the box (negative offset), so a label right above it is never covered", general && /outline-offset:\s*-\d+px/.test(general.body));
ok("…in the shop's (or the admin's) color, not white on a light panel", general && /outline:\s*2px solid var\(--org-accent, var\(--accent\)\)/.test(general.body));
const base = ruleFor(":focus-visible");
ok("checkboxes, radio buttons and buttons keep the ring outside", base && /outline:\s*2px solid #fff/.test(base.body) && /outline-offset:\s*3px/.test(base.body));
// A white ring alone hardly showed on the cream and white panels: a dark band fills the gap between
// the control and the white ring, so one of the two always stands out (WCAG 2.4.7 / 1.4.11).
const lum = (h) => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const band = base && (base.body.match(/box-shadow:\s*0 0 0 3px (#[0-9a-fA-F]{6})/) || [])[1];
ok("…with a dark band filling the 3px gap between the control and the white ring", !!band);
ok("…so the ring has at least 3:1 contrast on the dark page, the dark order panel, the cream panels and white boxes",
  !!band && ["#1B1D22", "#151619"].every(bg => contrast("#ffffff", bg) >= 3) && ["#F6F3EC", "#ffffff", "#E7F2EB"].every(bg => contrast(band, bg) >= 3));
ok("text boxes don't get the dark band (their ring is drawn inside the box)", general && /box-shadow:\s*none/.test(general.body));
ok("the dark order panel's fields get a white ring", dark && /outline-color:\s*#fff/.test(dark.body));
ok("…and that rule is at least as specific as the general one, so its color wins", dark && atLeast(specificity(".ticket " + TEXT), specificity(TEXT)));

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
