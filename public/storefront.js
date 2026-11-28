// storefront.js — the page's script (index.html loads it at the end of <body>, so the page's markup is
// there when it runs; it was the page's own inline <script> until the Content-Security-Policy in
// public/_headers stopped allowing inline script). The shop, and on the admin host the sign-in and
// the loading of admin.js, which shares this file's globals (see the top of admin.js).
/* BACKEND: every order and admin call goes to this site's own API (/api/…). The browser never
   talks to any other backend and never holds a secret. */

// Who runs this site — name, contact and how to pay by Venmo / Zelle / check. It comes with every
// /api/catalog answer (Global settings → Business profile in the admin) and is never baked into
// this page. applyBusiness_ puts it into the header, the footer and the title.
const BUSINESS_NAME_FALLBACK = "Our shop";
let business = { name: "", legalName: "", tagline: "", supportEmail: "", mailingAddress: "", venmo: "", zelle: "", footer: "" };
function bizName_(){ return business.name || BUSINESS_NAME_FALLBACK; }
// Where the business is, for address formats only (Global settings → Region; comes with every
// /api/catalog answer). "US": 5-digit ZIP, 2-letter state, the ZIP-vs-state check, carrier rates by
// ZIP. "OTHER": postal code and state / region are free text, and there are no carrier rates.
let siteCountry = "US";
function isUS_(){ return siteCountry !== "OTHER"; }
function applyCountry_(c){ siteCountry = String(c || "").toUpperCase() === "OTHER" ? "OTHER" : "US"; }
// Global settings → Features: which optional parts of the site are on. Arrives with /api/catalog;
// a feature is on unless it was explicitly switched off (so nothing saved = everything on).
let siteFeatures = {};
function applyFeatures_(f){ siteFeatures = (f && typeof f === "object") ? f : {}; }
function featureOn_(key){ return siteFeatures[key] !== false; }
// Global settings → Decoration types: which kinds of decoration the shop offers (embroidery, dtf, screenprint, vinyl, dtg,
// sublimation). Arrives with /api/catalog as `decorationTypes`; null = not known (an older answer, or the admin before its
// settings load), and then every type counts as on, like featureOn_. Also called by the admin when Global settings are saved.
let siteDecorations = null;
function applyDecorationTypes_(list){ siteDecorations = Array.isArray(list) ? list.map(String) : null; }
function decorationOn_(key){ return siteDecorations === null || siteDecorations.includes(String(key)); }
// The words a product's decoration is shown with (the registry's made-labels, the top of functions/_lib/db.js).
const DECORATION_MADE_LABELS_ = { embroidery: "Embroidered", dtf: "Printed (DTF)", screenprint: "Screen printed", vinyl: "Vinyl", dtg: "DTG printed", sublimation: "Sublimated" };
// Whether a product is embroidered (so "Name to embroider" makes sense). Its stored type, when set, decides; a product
// with none is worked out as before (any product may be embroidered). Embroidery switched off: never.
function productEmbroidered_(p){
  if(!decorationOn_("embroidery")) return false;
  const t = String((p && (p.decorationType || "")) || "");
  return !t || t === "embroidery";
}
// A printed (not embroidered) decoration type: the custom-design hints say "printed" for these.
function printedDecoration_(p){
  const t = String((p && p.decorationType) || "");
  if(t && t !== "embroidery") return true;
  return !!(p && p.customDesign && p.customDesign.kind === "transfer");
}
// "desktop" when the admin runs inside the desktop program (desktop/, /api/catalog's edition): the
// admin then leaves out what needs the internet. Only the admin answer carries it, with the
// program's version.
let siteEdition = "", siteDesktopSuppliers = false, siteDesktopEmail = false;
function applyEdition_(e, suppliers, email, version){
  siteEdition = e === "desktop" ? "desktop" : ""; siteDesktopSuppliers = siteEdition === "desktop" && suppliers === true; siteDesktopEmail = siteEdition === "desktop" && email === true;
  applyDesktopMark_(version);
}
// In the desktop program, a small line above the business's name in the header: OpenDecoDesk's
// mark, its name and the version ("2026.11.01.01", or "dev" run from the source). The business's
// name stays the heading. Never on a cloud install, nor on a shop's pages.
function applyDesktopMark_(version){
  const brand = document.getElementById("brandName");
  let mark = document.getElementById("desktopMark");
  if(siteEdition !== "desktop" || !brand){ if(mark) mark.remove(); return; }
  if(!mark){ mark = document.createElement("div"); mark.id = "desktopMark"; mark.className = "desktop-mark"; brand.parentNode.insertBefore(mark, brand); }
  mark.innerHTML = `<img src="/images/icon.svg" alt="" width="18" height="18"><b>OpenDecoDesk</b><span>${escapeHtml(String(version || "dev"))}</span>`;
}
// The admin's tab and home-screen icon: OpenDecoDesk's logo (the website's, and the desktop
// program's). Only the admin: a shop and its customers' pages are the business's, not ours.
function applyAdminIcon_(){
  if(document.querySelector('link[rel="icon"]')) return;
  for(const [rel, href, type] of [["icon", "/images/icon.svg", "image/svg+xml"], ["apple-touch-icon", "/images/icon-180.png", ""]]){
    const l = document.createElement("link");
    l.rel = rel; l.href = href; if(type) l.type = type;
    document.head.appendChild(l);
  }
}
function applyBusiness_(b){
  if(b && typeof b === "object") business = Object.assign({}, business, b);
  VENMO_USERNAME = business.venmo || "";
  const brand = document.getElementById("brandName"); if(brand) brand.textContent = bizName_();
  const foot = document.getElementById("siteFooter");
  if(foot){
    const mail = business.supportEmail ? `Questions? <a href="mailto:${escapeHtml(business.supportEmail)}" style="color:var(--dim);">${escapeHtml(business.supportEmail)}</a>` : "";
    foot.innerHTML = [business.footer ? escapeHtml(business.footer) : "", mail].filter(Boolean).join(" &nbsp;&middot;&nbsp; ");
  }
  if(/^Order shop$/.test(document.title)) document.title = bizName_();
}

// The business's Venmo username, without the @ (Business profile). Used to build a pre-filled
// "Pay with Venmo" link on the confirmation screen when a customer
// selects Venmo — this is a plain deep link (venmo.com/u/...), not an
// API call. Venmo retired their programmatic payment-request API for
// new developers, so nothing can be sent automatically; this just
// saves the customer from typing the amount/note themselves. Blank
// until the profile sets one: the customer is then told they'll be contacted.
let VENMO_USERNAME = "";

// Whether "Credit / Debit Card" shows as a payment option is resolved
// server-side per request (enabledPayments in /api/catalog — see
// functions/api/catalog.js), not by a constant here. The page needs no
// Stripe publishable key: Card checkout redirects to Stripe's hosted
// page, there's no client-side Stripe.js/Elements. Deriving the flag from
// the server's own STRIPE_SECRET_KEY also means a test install running on
// test keys can never create a real charge.

// Set to a number (e.g. 2) to show a note on the checkout screen and
// confirmation email that a discount of that percentage applies to orders
// paid by Check or Zelle (avoiding card processing fees). Set to 0 or
// null to hide the discount mention entirely.
// NOTE: this is informational only — it tells customers about the discount
// but does NOT automatically adjust the order total. Price the discount
// into your catalog pricing, or mention it when collecting payment.
const CASH_DISCOUNT_PERCENT = 0;

/* =========================================================
   No org data lives here at all, on purpose. A static table of every
   org's name/description/accent color would ship in the page source to
   every visitor on every subdomain, so anyone could "view source", read
   the entire client list, then guess at the subdomains directly. Instead
   the client asks functions/api/catalog.js "who am I" on load; the server answers
   using the Host header, and a customer's browser only ever learns
   about the ONE org its own subdomain resolves to. See currentOrg below.
   ========================================================= */

const SIZE_ORDER = ["XS","S","M","L","XL","2XL","3XL","4XL"];   // the standard run
// Every size in display order: the standard run, then the big sizes some styles come in. A product can
// also carry a size that's in neither list (LT, "S/M"…) — productSizes_ puts those last, as given.
const SIZE_ORDER_ALL = SIZE_ORDER.concat(["5XL","6XL"]);
function productSizes_(sizePricing){
  const keys = Object.keys(sizePricing || {});
  const rank = (s) => { const i = SIZE_ORDER_ALL.indexOf(s); return i === -1 ? SIZE_ORDER_ALL.length + keys.indexOf(s) : i; };
  return keys.sort((a, b) => rank(a) - rank(b));
}
// The storefront's sections come from the shop's catalog answer (`categories`: the managed list from
// admin → Catalog → Product categories, in its order). This built-in list is only what a catalog answer
// from before that list existed falls back to.
const DEFAULT_CATEGORIES = [{key:"shirt", label:"Shirts"}, {key:"sweatshirt", label:"Sweatshirts"}, {key:"cap", label:"Caps"}];
// A product has sizes when it's priced by size; a flat-priced product is one size ("OSFA") whatever
// its category — so a new category (a patch, a hoodie) needs no code of its own.
function productIsSized_(p){ return !!(p && p.sizePricing && Object.keys(p.sizePricing).length); }

// Escapes any customer-supplied text before it's inserted into innerHTML,
// so a submitted name/contact/personalization can never execute as HTML/JS
// in the browser of whoever views it (you, in the Admin panel; or a
// customer, in their own cart preview).
// "#fff" or the page ink, whichever has the higher WCAG contrast on a #rgb/#rrggbb background.
function readableInkOn(hex){
  let h = String(hex || "").replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return "#fff";
  const lum = (x) => { const r = [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2]; };
  const L = lum(h), white = 1.05 / (L + 0.05), ink = (L + 0.05) / (lum("232323") + 0.05);
  return white >= ink ? "#fff" : "#232323";
}

// style="" value for a shop's colour: the colour itself plus a text colour that's readable on it
// (white on dark green, dark ink on a light orange). Buttons filled with the shop colour use
// color:var(--org-accent-ink, #fff).
function orgAccentVars(accent){
  const a = String(accent || "");
  return `--org-accent:${escapeHtml(a)};--org-accent-ink:${readableInkOn(a.trim())}`;
}

function escapeHtml(str){
  if(str == null) return "";
  return String(str).replace(/[&<>"']/g, function(ch){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch];
  });
}

// Replaces alert() with a dismissible, non-blocking toast tied to an
// aria-live region — alert() can't be styled, blocks the whole page, and
// its accessible behavior varies across screen readers/browsers in a way
// a real aria-live region doesn't. Clicking it, or its ✕, dismisses it.
// An error stays until it is dismissed or the screen changes: it is often the only
// explanation of why something didn't happen, and someone who looked away (or a
// screen reader still reading something else) must not miss it (review #111).
// Anything else goes by itself after 6–15 seconds, longer for longer text, and
// waits while the pointer or keyboard focus is on it.
const TOAST_MAX_ = 3;   // at most this many at once: the oldest goes first
function toastDuration_(message){
  return Math.min(15000, Math.max(6000, 60 * String(message == null ? "" : message).length));
}
function showToast(message, isError){
  let region = document.getElementById("toastRegion");
  if(!region){
    region = document.createElement("div");
    region.id = "toastRegion";
    region.className = "toast-region";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "assertive");
    document.body.appendChild(region);
  }
  if(!showToast.watching_){
    // A new screen clears the errors left from the one before. One shown just before the change
    // (under a second) stays: it is the reason for the change ("…, so you're back on Orders").
    showToast.watching_ = true;
    window.addEventListener("hashchange", () => {
      const now = Date.now();
      document.querySelectorAll("#toastRegion .toast-error").forEach(t => {
        if(now - Number(t.dataset.shownAt || 0) >= 1000) t.remove();
      });
    });
  }
  const text = String(message == null ? "" : message);
  // The same error twice (a button clicked again) isn't stacked: the one already showing stays.
  if(isError){
    const same = [...region.querySelectorAll(".toast-error")].find(t => t.dataset.message === text);
    if(same) return;
  }
  const toast = document.createElement("div");
  toast.className = "toast" + (isError ? " toast-error" : "");
  if(isError) toast.setAttribute("role", "alert");
  toast.dataset.message = text;
  toast.dataset.shownAt = String(Date.now());
  // The message alone is the toast's text; the ✕ draws its mark from the style sheet (.toast-close::before),
  // so reading the toast's text gives the message and nothing else.
  toast.appendChild(document.createTextNode(text));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss");
  toast.appendChild(close);
  region.appendChild(toast);
  let timer = null, left = isError ? 0 : toastDuration_(text), startedAt = 0;
  const dismiss = () => { clearTimeout(timer); if(toast.parentNode) toast.parentNode.removeChild(toast); };
  const start = () => { if(!left) return; clearTimeout(timer); startedAt = Date.now(); timer = setTimeout(dismiss, left); };
  const pause = () => { if(!left || timer == null) return; clearTimeout(timer); timer = null; left = Math.max(2000, left - (Date.now() - startedAt)); };
  toast.addEventListener("click", dismiss);
  toast.addEventListener("mouseenter", pause);
  toast.addEventListener("focusin", pause);
  toast.addEventListener("mouseleave", start);
  toast.addEventListener("focusout", start);
  start();
  const shown = region.querySelectorAll(".toast");
  for(let i = 0; i < shown.length - TOAST_MAX_; i++) shown[i].remove();
}

// A quieter, invisible aria-live announcer for routine status changes
// (cart updates) that don't warrant a visible toast — the visible cart
// total already updates on screen; this just makes sure a screen reader
// user hears the same change, not just sighted users.
function announceStatus(message){
  let region = document.getElementById("statusRegion");
  if(!region){
    region = document.createElement("div");
    region.id = "statusRegion";
    region.className = "sr-only";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  region.textContent = message;
}

// Maps a full-size LOCAL image path to its small, fast-loading thumbnail —
// e.g. "images/polo-a-front.jpg" -> "images/thumbs/polo-a-front.jpg".
// The page always displays the thumbnail; clicking still opens the
// full-size original (see the <a href> wrapping each thumbnail below).
// Admin-supplied external URLs (http[s]://...) are returned unchanged —
// there's no local /thumbs/ variant of an off-site image, so rewriting
// the path would just produce a dead link.
// iPhone and iPad photos are HEIC, which the server doesn't take (it reads PNG, JPEG, WebP and GIF).
// The file boxes list HEIC so an iPad lets it be picked at all (it greys out — and won't open — a file
// whose type a box doesn't list), and a HEIC is redrawn as a JPEG here before it's sent. Safari draws
// HEIC; a browser that can't is told to save the photo as a JPG. The long side is capped at `maxSide`
// (an iPad canvas stops at about 16 million pixels). Any other file is returned as it is.
function isHeicFile_(f){ return /\.(heic|heif)$/i.test((f && f.name) || "") || /^image\/hei[cf]/i.test((f && f.type) || ""); }
async function heicToJpeg_(file, maxSide = 4096){
  if(!isHeicFile_(file)) return file;
  const cant = "This browser can't open that photo (HEIC) — save it as a JPG or PNG and choose that.";
  let src = null;
  try{ if(typeof createImageBitmap === "function") src = await createImageBitmap(file); }catch(e){ src = null; }
  if(!src){
    // A HEIC from Files may come with no type: say what it is, so the image decoder is used.
    const blob = file.type ? file : new Blob([file], { type: "image/heic" });
    const url = URL.createObjectURL(blob);
    try{ src = await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = url; }); }
    catch(e){ throw new Error(cant); }
    finally{ URL.revokeObjectURL(url); }
  }
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  if(!w0 || !h0) throw new Error(cant);
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w0 * scale); canvas.height = Math.round(h0 * scale);
  canvas.getContext("2d").drawImage(src, 0, 0, canvas.width, canvas.height);
  if(src.close) src.close();
  const jpeg = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.92));
  if(!jpeg) throw new Error(cant);
  return new File([jpeg], String(file.name || "photo").replace(/\.(heic|heif)$/i, "") + ".jpg", { type: "image/jpeg" });
}
// A missing "-thumb" copy never shows as a broken image: fall back to the full image (an image copied from a vendor
// before its thumbnail existed, or a thumbnail upload that failed). Error events don't bubble, so listen in the
// capture phase — one listener covers every <img> on the storefront and in the admin.
document.addEventListener("error", function(e){
  var t = e.target;
  if(!t || t.tagName !== "IMG" || t.getAttribute("data-thumb-fallback")) return;
  var src = t.getAttribute("src") || "";
  if(!/-thumb\.[a-z0-9]+([?#]|$)/i.test(src)) return;
  t.setAttribute("data-thumb-fallback", "1");
  t.setAttribute("src", src.replace(/-thumb(\.[a-z0-9]+)(?=[?#]|$)/i, "$1"));
}, true);
function thumbUrl(fullPath){
  if(!fullPath) return fullPath;
  // Normalize bare-domain URLs (missing https:// scheme) so they aren't
  // treated as relative paths by the browser.
  if(!/^https?:\/\//i.test(fullPath) && !fullPath.startsWith('/')){
    const firstSlash = fullPath.indexOf('/');
    const hostPart = firstSlash === -1 ? fullPath : fullPath.slice(0, firstSlash);
    if(hostPart.includes('.') && !hostPart.startsWith('.')) fullPath = 'https://' + fullPath;
  }
  if(/^https?:\/\//i.test(fullPath)){
    // R2 uploads are stored under /uploads/ with a paired -thumb variant
    // uploaded at 320px by uploadImage(). External URLs have no thumbnail
    // and pass through unchanged.
    if(fullPath.indexOf("/uploads/") !== -1){
      return fullPath.replace(/(\.[^./?#]+)(\?[^#]*)?(#.*)?$/, "-thumb$1$2$3");
    }
    return fullPath;
  }
  const parts = fullPath.split("/");
  const filename = parts.pop();
  const base = filename.replace(/\.[^.]+$/, "");
  return parts.join("/") + "/thumbs/" + base + ".jpg";
}

/* ---------------- routing (pure JS state — no URL/hash navigation,
   so nothing here is ever mistaken for a real link) ---------------- */
let route = {view:"generic"};
let currentOrgId = null;

// The ONE org this browser is entitled to see this session — populated
// once at boot from /api/catalog, which resolves identity from the
// request's Host header server-side. null on the root/generic domain
// or an unrecognized host; this session then never learns any org exists.
let currentOrg = null;
// On the admin host: { rootDomain } from /api/catalog ("" until the site has a domain). admin.js reads it.
let siteInfo_ = {};
// On the admin host: the version of admin.js to load (/api/catalog's adminScript — a hash of the file, or the desktop
// program's version), so the browser keeps the file between visits and fetches it again only after it changes.
let adminScriptVersion_ = "";

async function resolveCurrentOrg(){
  try{
    // The admin's draft preview (?preview=<signed token>, migrations/0076) is passed through; the server decides.
    // On a site with no domain yet it opens on the admin's workers.dev address and names its shop (?shop=).
    const qs = new URLSearchParams(window.location.search), pv = qs.get("preview"), pvShop = qs.get("shop");
    const res = await fetch("/api/catalog" + (pv ? "?preview=" + encodeURIComponent(pv) + (pvShop ? "&shop=" + encodeURIComponent(pvShop) : "") : ""));
    if(!res.ok){
      try{ const d = await res.json(); applyBusiness_(d.business); applyCountry_(d.country); applyFeatures_(d.features); applyDecorationTypes_(d.decorationTypes); }catch(e){}
      // 404 is the server's real "no shop at this address" answer. Anything else (a 5xx, a rate limit)
      // is a passing failure: say so and offer a retry, rather than telling the visitor (or the owner on
      // the admin address) that their link is probably mistyped.
      return res.status === 404 ? null : {error:true};
    }
    const data = await res.json();
    applyBusiness_(data.business);
    applyCountry_(data.country);
    applyFeatures_(data.features);
    applyDecorationTypes_(data.decorationTypes);
    if(data.status === "admin"){ applyEdition_(data.edition, data.desktopSuppliers, data.desktopEmail, data.version); applyAdminIcon_(); siteInfo_ = data.site || {};
      adminScriptVersion_ = typeof data.adminScript === "string" ? data.adminScript : ""; return {admin:true}; }
    // Global settings → Features → Storefront is off: no shop is served here (see catalog.js).
    if(data.status === "closed") return {closed:true};
    if(data.status !== "ok") return null;
    return Object.assign({orgId: data.orgId, preview: data.preview === true}, data.catalog);
  }catch(e){
    // No answer at all (offline, dropped connection) or a reply that wasn't the catalog: a passing failure too.
    console.error("Could not resolve current org:", e);
    return {error:true};
  }
}

// Lazily loads admin.js — the admin panel (org/product management, order
// lookup, image uploads) is a large script used by nobody except the admin
// subdomain, so it isn't shipped to every storefront visitor. Loaded via
// a real <script src> tag (not fetch()+eval()) so it never needs
// 'unsafe-eval' in the CSP (see _headers) — a classic script's top-level
// let/const/function declarations attach to the same shared global script
// scope as this file's own, so admin.js's functions (renderAdminPicker,
// etc.) become callable here exactly as if they'd always been in this
// file. Cached after the first successful load — every subsequent call
// (there's only ever one entry point, but this stays safe if that changes)
// reuses the same promise instead of injecting a second <script> tag.
let adminScriptPromise = null;
function loadAdminScript(){
  if(adminScriptPromise) return adminScriptPromise;
  // Under its version (adminScriptVersion_), so it's kept between visits; with none known, fresh every time.
  const version = adminScriptVersion_ ? "?v=" + encodeURIComponent(adminScriptVersion_) : "?t=" + Date.now();
  // The admin's styles (admin.css, review #104) come with it, under the same version, and the admin is shown
  // only once both are in, so its screens never draw unstyled. A stylesheet that fails to load doesn't stop the
  // admin (it works, plainly); a script that fails does.
  const styled = new Promise((done) => {
    if(document.querySelector("[data-admin-css]")) return done();   // already on the page (a retry after a failed script)
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "admin.css" + version;
    l.setAttribute("data-admin-css", "");
    l.onload = () => done();
    l.onerror = () => { console.error("Could not load admin.css"); done(); };
    document.head.appendChild(l);
  });
  const script = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "admin.js" + version;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load admin.js"));
    document.head.appendChild(s);
  });
  adminScriptPromise = Promise.all([script, styled]).then(() => {});
  adminScriptPromise.catch(() => { adminScriptPromise = null; });
  return adminScriptPromise;
}

function go(view, orgId){
  // This site only ever shows the one org currentOrg resolved to at
  // boot — there is no other org or hub to navigate to.
  if(currentOrg){
    orgId = currentOrg.orgId;
  }
  route = orgId ? {view, org:orgId} : {view};
  render();
}

/* ---------------- cart state (per org, in-memory) ---------------- */
let cart = [];
let activeCatalog = null; // currentOrg's own products/pricing — never contains other orgs' data

// Shipping state — only meaningful when the shop offers shipping (offersShipping_).
// null shippingQuote = "Local delivery" (free, default). A non-null value is
// one of the objects returned by /api/shipping and selected by the customer.
let shippingZip = "";
// The ZIP the current carrier rates were priced for (each rate's signed quote is tied to it). The order
// must ship to this ZIP, so the address box checks it before sending.
let shippingQuotedZip = "";
// The last address typed in the shipping-address box (in this page only), so reopening it after a
// Cancel or a refused order doesn't make the customer type the street address again.
let lastShipAddr_ = null;
let shippingRates = [];    // rates fetched from /api/shipping (up to 3)
let shippingQuote = null;  // null = local delivery; {provider,service,amount,estimatedDays} = carrier
let shippingManual = false; // true when order doesn't fit a known box — no rates shown, admin follows up
// Delivery choice (the shop's list: local pickup, carrier shipping, its own flat-fee options).
// deliveryOptId = the picked pickup/custom option (null = the first one offered); a carrier rate lives
// in shippingQuote and wins while set; shippingManualPicked = "ship it, quote to follow" is chosen.
let deliveryOptId = null;
// Rush (migrations/0082): asked for, and the optional "needed by" date. The fee itself is the server's.
let rushOn = false, rushNeededBy = "";
let shippingManualPicked = false;
function deliveryOptions_(org){
  if(org && Array.isArray(org.deliveryOptions) && org.deliveryOptions.length) return org.deliveryOptions;
  // A catalog answer without the list: free local pickup, plus shipping when enabled.
  return [{id:"pickup", type:"pickup", label:"Local pickup", fee:0}].concat(org && org.shippingEnabled ? [{id:"shipping", type:"shipping", label:"Shipping", fee:null}] : []);
}
function offersShipping_(org){ return deliveryOptions_(org).some(o => o.type === "shipping"); }
// What's chosen right now → {kind: "quote"|"manual"|"option"|"none", fee, label, option}.
// Digital products (migrations/0086): a cart of only those has nothing to deliver.
function cartDigitalOnly_(org){
  const prods = (org && org.products) || [];
  return cart.length > 0 && cart.every(c => { const p = prods.find(x => x.id === c.productId); return !!(p && p.digital); });
}
function currentDelivery_(org){
  if(cartDigitalOnly_(org)) return {kind:"digital", fee:0, label:"Instant download"};
  if(offersShipping_(org) && shippingQuote) return {kind:"quote", fee:shippingQuote.amount, label:shippingQuote.provider + " " + shippingQuote.service};
  if(offersShipping_(org) && shippingManual && shippingManualPicked) return {kind:"manual", fee:0, label:"Shipping — quote to follow"};
  const choices = deliveryOptions_(org).filter(o => o.type !== "shipping");
  const o = choices.find(x => x.id === deliveryOptId) || choices[0];
  return o ? {kind:"option", option:o, fee:Number(o.fee) || 0, label:o.label} : {kind:"none", fee:0, label:""};
}
let shippingLoading = false;
let shippingDebounce = null;

function priceFor(product, size){
  if(!productIsSized_(product)) return product.flatPrice;
  return product.sizePricing[size];
}
// A configurable product's base price for a garment color (migrations/0064): the color's price group, if it
// is in one and that group prices the size; otherwise the product's own price. The server prices it the same.
function colorGroupOf_(product, color){
  return color ? (product.colorGroups || []).find(g => (g.colors || []).includes(color)) || null : null;
}
function cfgBasePrice_(product, color, size){
  const g = colorGroupOf_(product, color);
  if(productIsSized_(product)){
    const v = g && g.sizePricing ? g.sizePricing[size] : undefined;
    return typeof v === "number" ? v : ((product.sizePricing || {})[size] || 0);
  }
  return g && typeof g.flatPrice === "number" ? g.flatPrice : (product.flatPrice || 0);
}

function render(){
  const app = document.getElementById("app");
  document.querySelector(".shell").classList.toggle("admin-wide", route.view === "admin");

  // The admin subdomain has no org of its own — handle it before the
  // "no org resolved" fallback below would otherwise catch it. admin.js
  // is loaded on demand (see loadAdminScript() above) — show a minimal
  // loading state immediately, then swap in the real picker once it's
  // ready. If it were already loaded (adminScriptPromise resolved), this
  // still resolves on the same tick before the next paint, so there's no
  // visible flash for a warm reload.
  if(route.view === "admin"){
    app.innerHTML = `<div class="admin-summary">Loading&hellip;</div>`;
    loadAdminScript()
      .then(() => adminRoute())
      .catch((err) => {
        console.error("Could not load admin.js:", err);
        app.innerHTML = `<div class="admin-empty">Could not load the admin panel. Please refresh and try again.</div>`;
      });
    return;
  }

  // Design verification page — token-gated, works on any subdomain (or even
  // the root domain); doesn't need currentOrg resolved.
  if(route.view === "design-verify"){ renderDesignVerify(app, route.token); return; }
  // The customer's invoice page — token-gated, and it works with the storefront switched off too.
  if(route.view === "invoice"){ renderInvoice(app, route.token, route.justPaid); return; }
  // The customer's quote page (?estimate=) — token-gated like the invoice, and it works with the storefront switched off.
  if(route.view === "estimate"){ renderEstimate(app, route.token); return; }

  // Storefront switched off: the same short page on every shop address and the main one.
  if(route.view === "closed"){ currentOrgId = null; renderStorefrontOff(app, route); return; }

  // The server couldn't be reached (or had a passing error): not the same as an unknown address.
  if(route.view === "load-error"){ currentOrgId = null; renderLoadError(app); return; }

  // No org resolved (root/generic domain, or an unrecognized host) —
  // or route.org somehow doesn't match the one org this session knows
  // about. Either way, show the generic page; there's nothing else to show.
  if(route.view === "generic" || !currentOrg || route.org !== currentOrg.orgId){
    currentOrgId = null;
    route = {view:"generic"};
    renderGenericFallback(app);
    return;
  }

  if(route.view === "stripe-success"){ renderStripeSuccess(app, currentOrg.orgId, currentOrg, route.orderId); return; }

  // org order page — reset cart and shipping state when switching to a *different* org
  if(currentOrgId !== currentOrg.orgId){
    clearCart_();
    discountReset_();
    currentOrgId = currentOrg.orgId;
    restoreCart_();
    shippingZip = ""; shippingRates = []; shippingQuote = null; shippingLoading = false; shippingManual = false; deliveryOptId = null; shippingManualPicked = false;
    if(shippingDebounce){ clearTimeout(shippingDebounce); shippingDebounce = null; }
  }
  renderOrgPage(app, currentOrg.orgId, currentOrg);
  if(unpaidCardNotice){ const hero = app.querySelector(".org-hero"); if(hero) hero.insertAdjacentHTML("afterend", unpaidCardBannerHtml_()); }
  // A draft preview says so, and can't take orders (it shows changes not yet published).
  if(currentOrg.preview) app.insertAdjacentHTML("afterbegin", `<div class="preview-bar" role="status">Preview of unpublished changes — this is what the shop will look like after Publish. Ordering is off here.</div>`);
}

function renderStripeSuccess(app, orgId, org, orderId){
  document.title = org.name + " — Payment received";
  // Paid: forget the pending card order and the cart it came from.
  writePendingCard_(orgId, null); unpaidCardNotice = null;
  clearCart_(); try{ sessionStorage.removeItem("cart:" + orgId); }catch(_){}
  // Back from buying a gift card (giftBuySubmit_ left a note in this tab): the card goes to the recipient.
  let gift = null;
  try{ gift = JSON.parse(sessionStorage.getItem("giftCardBuy:" + orgId) || "null"); if(gift && orderId && gift.orderId !== orderId) gift = null; }catch(_){}
  if(gift){ try{ sessionStorage.removeItem("giftCardBuy:" + orgId); }catch(_){} }
  app.innerHTML = `
    <div class="confirmation" style="${orgAccentVars(org.accent)}">
      <div class="stitch"></div>
      <h2>Thank you — your payment went through.</h2>
      <div class="order-number">${escapeHtml(orderId || "")}</div>
      ${gift ? `<p>Your gift card for ${escapeHtml(gift.recipientName || "your recipient")} is on its way: we're emailing it to ${escapeHtml(gift.recipientEmail || "them")} now. Stripe emails you a receipt for the card payment. A gift card never expires.</p>`
      : `<p>Your order for ${escapeHtml(org.name)} is in. Stripe emails you a receipt for the card payment, and we'll email you once we've confirmed your order.</p>`}
      <p>Questions about your order? Reply to your order email.</p>
      <br>
      <button class="confirmation-back" data-action="go-org" data-org="${orgId}" style="background:none; border:none; margin-top:12px;">&larr; Back to ${escapeHtml(org.name)}</button>
    </div>
  `;
}

// ---- Buy a gift card (migrations/0120) ----
// Shown when Global settings → Gift cards sells them online (catalog.giftCards.sellOnline: also needs the Gift cards
// feature and card payments at this shop). A shop page's "Gift cards" button opens this form: amount buttons plus an
// amount of the buyer's own within the limits, who it is for, who is buying, a message. The order is a card order
// (buyGiftCard), paid through Stripe Checkout exactly like any other; the card is made and emailed to the recipient once
// the payment is in (the server does that, from Stripe's notice), never before. The server checks every number again.
const gb_ = { amount: 0, custom: "", recipientName: "", recipientEmail: "", buyerName: "", buyerEmail: "", message: "", busy: false, err: "", attempt: null };
const GIFT_MESSAGE_MAX_ = 300;
function giftSellOn_(org){ return !!(org && org.giftCards && org.giftCards.sellOnline === true && Array.isArray(org.giftCards.amounts) && !org.preview); }
function giftBuyCents_(){
  const custom = String(gb_.custom || "").replace(/[$,\s]/g, "");
  const dollars = custom ? (/^\d+(\.\d{1,2})?$/.test(custom) ? Number(custom) : NaN) : gb_.amount;
  return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
}
function giftBuyMsgEl_(text){
  gb_.err = text || "";
  const el = document.getElementById("gbMsg");
  if(el){ el.textContent = gb_.err; el.hidden = !gb_.err; }
}
function renderGiftBuy_(){
  const org = currentOrg, app = document.getElementById("app");
  if(!org || !app || !giftSellOn_(org)) return;
  document.title = org.name + " — Gift cards";
  const g = org.giftCards, money = (n) => "$" + Number(n).toFixed(Number(n) % 1 ? 2 : 0);
  const field = (key, label, attrs) => `<label class="gb-field">${label}<input type="${attrs.type || "text"}" data-gb="${key}" value="${escapeHtml(gb_[key])}" maxlength="${attrs.max}" autocomplete="${attrs.auto}"${attrs.mode ? ` inputmode="${attrs.mode}"` : ""}></label>`;
  app.innerHTML = `
    <div class="confirmation giftbuy" style="${orgAccentVars(org.accent)}">
      <div class="stitch"></div>
      <h2>Gift cards</h2>
      <p>Give a gift card for ${escapeHtml(org.name)}. We email it to the person you choose once your payment goes through. It can be used at checkout and never expires.</p>
      <div class="gb-form">
        <div class="gb-label" id="gbAmountLabel">Amount</div>
        <div class="gb-amounts" role="group" aria-labelledby="gbAmountLabel">
          ${g.amounts.map(a => `<button type="button" class="gb-amount${gb_.amount === a && !gb_.custom ? " on" : ""}" data-action="giftbuy-amount" data-amount="${escapeHtml(String(a))}" aria-pressed="${gb_.amount === a && !gb_.custom ? "true" : "false"}">${escapeHtml(money(a))}</button>`).join("")}
        </div>
        <label class="gb-field">Or another amount (${escapeHtml(money(g.min))} to ${escapeHtml(money(g.max))})
          <input type="text" data-gb="custom" value="${escapeHtml(gb_.custom)}" maxlength="9" inputmode="decimal" autocomplete="off" placeholder="e.g. 40"></label>
        ${field("recipientName", "Who is it for? (name)", { max: 100, auto: "off" })}
        ${field("recipientEmail", "Their email address", { type: "email", max: 254, auto: "off" })}
        ${field("buyerName", "Your name", { max: 100, auto: "name" })}
        ${field("buyerEmail", "Your email address (for your receipt)", { type: "email", max: 254, auto: "email" })}
        <label class="gb-field">Message (optional)
          <textarea data-gb="message" rows="3" maxlength="${GIFT_MESSAGE_MAX_}">${escapeHtml(gb_.message)}</textarea></label>
        <div class="gb-count" id="gbCount" aria-hidden="true">${gb_.message.length} / ${GIFT_MESSAGE_MAX_}</div>
        <div class="checkout-msg" id="gbMsg" role="alert"${gb_.err ? "" : " hidden"}>${escapeHtml(gb_.err)}</div>
        <button type="button" class="place-order-btn" id="gbSubmit" data-action="giftbuy-submit"${gb_.busy ? " disabled" : ""}>${gb_.busy ? "Processing…" : "Pay by card"}</button>
      </div>
      <br>
      <button class="confirmation-back" data-action="go-org" data-org="${escapeHtml(org.orgId)}" style="background:none; border:none; margin-top:12px;">&larr; Back to ${escapeHtml(org.name)}</button>
    </div>`;
  window.scrollTo(0, 0);
}
function giftBuyInput_(el){
  const key = el.dataset.gb;
  if(!(key in gb_) || key === "amount") return;
  gb_[key] = el.value;
  if(gb_.err) giftBuyMsgEl_("");
  if(key === "custom" && el.value.trim()){ gb_.amount = 0; document.querySelectorAll(".gb-amount").forEach(b => { b.classList.remove("on"); b.setAttribute("aria-pressed", "false"); }); }
  if(key === "message"){ const c = document.getElementById("gbCount"); if(c) c.textContent = el.value.length + " / " + GIFT_MESSAGE_MAX_; }
}
function giftBuyPickAmount_(v){
  gb_.amount = Number(v) || 0; gb_.custom = "";
  const c = document.querySelector('[data-gb="custom"]'); if(c) c.value = "";
  document.querySelectorAll(".gb-amount").forEach(b => { const on = Number(b.dataset.amount) === gb_.amount; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
  if(gb_.err) giftBuyMsgEl_("");
}
async function giftBuySubmit_(){
  const org = currentOrg;
  if(!giftSellOn_(org) || gb_.busy) return;
  const cents = giftBuyCents_(), g = org.giftCards;
  const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
  const fail = (msg, focus) => { giftBuyMsgEl_(msg); const f = focus && document.querySelector('[data-gb="' + focus + '"]'); if(f) f.focus(); };
  const inList = g.amounts.some(a => Math.round(a * 100) === cents);
  if(!cents || (!inList && (cents < Math.round(g.min * 100) || cents > Math.round(g.max * 100)))){
    return fail("Choose an amount, or type one between $" + Number(g.min).toFixed(2) + " and $" + Number(g.max).toFixed(2) + ".", gb_.amount ? "" : "custom");
  }
  if(!gb_.recipientName.trim()) return fail("Please add the name of the person it is for.", "recipientName");
  if(!emailOk(gb_.recipientEmail)) return fail("Please add a valid email address for the person it is for — the gift card is sent there.", "recipientEmail");
  if(!gb_.buyerName.trim()) return fail("Please add your name.", "buyerName");
  if(!emailOk(gb_.buyerEmail)) return fail("Please add a valid email address for your receipt.", "buyerEmail");
  const body = { action: "buyGiftCard", orgId: org.orgId, amountCents: cents, recipientName: gb_.recipientName.trim(), recipientEmail: gb_.recipientEmail.trim(),
    buyerName: gb_.buyerName.trim(), buyerEmail: gb_.buyerEmail.trim(), message: gb_.message.trim().slice(0, GIFT_MESSAGE_MAX_) };
  // The same request id for the same gift until it is placed, so a retry after a lost answer is the same order.
  const sig = JSON.stringify(body);
  if(!gb_.attempt || gb_.attempt.sig !== sig) gb_.attempt = { sig, id: "GC-" + Date.now().toString(36).toUpperCase() + "-" + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase() };
  body.requestId = gb_.attempt.id;
  gb_.busy = true; giftBuyMsgEl_("");
  const btn = document.getElementById("gbSubmit"); if(btn){ btn.disabled = true; btn.textContent = "Processing…"; }
  const done = (msg) => { gb_.busy = false; if(btn){ btn.disabled = false; btn.textContent = "Pay by card"; } if(msg) giftBuyMsgEl_(msg); };
  try{
    const turnstileToken = await getTurnstileToken();
    if(turnstileToken) body.turnstileToken = turnstileToken;
    const res = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if(!res.ok || !data || data.status !== "ok"){
      if(res.status === 429) return done("Too many tries — please wait a minute and try again.");
      return done(data && data.message && res.status < 500 ? String(data.message) : "We couldn't start your gift card order just now. Please try again in a moment.");
    }
    // Card payment: the order exists; Stripe's hosted page takes the card (as for any card order), and the server makes
    // and emails the gift card when Stripe says the payment went through.
    let url = data.url || "";
    if(!url){
      const co = await fetch("/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: data.orderId, orgId: org.orgId, checkoutToken: data.checkoutToken || null }) });
      const cd = await co.json().catch(() => null);
      url = cd && cd.url ? cd.url : "";
    }
    if(!url) return done("Your gift card order is saved, but the card payment couldn't be started. Please try again.");
    try{
      sessionStorage.setItem("giftCardBuy:" + org.orgId, JSON.stringify({ orderId: data.orderId, recipientName: body.recipientName, recipientEmail: body.recipientEmail }));
    }catch(_){}
    writePendingCard_(org.orgId, { orderId: data.orderId, token: data.checkoutToken || null, total: cents / 100 });
    gb_.attempt = null;
    window.location.href = url;
  }catch(err){
    console.error("Gift card order failed:", err);
    done("We couldn't reach the server — check your connection and try again.");
  }
}

// ---- Invoice page (/?invoice=<token>) ---------------------------------------------------------
// Opened from the link in an invoice email (admin → Orders → Send invoice…). Shows the order and
// what's owed, lets the customer choose how they'll get it — the shop's delivery & pickup options,
// with carrier rates for an address — and pay the balance. Everything comes from /api/invoice; a
// delivery choice is saved there (the fee is the server's) and the page is redrawn from its answer.
const _inv = { token: "", data: null, pick: "", rates: [], ratesZip: "", rateIdx: -1, manual: false, addr: {}, busy: "", err: "", paidNote: false,
  codeText: "", codeMsg: "", giftText: "", giftMsg: "", giftOk: "", poText: "", poMsg: "", poOk: "" };
const invMoney_ = (n) => "$" + Number(n || 0).toFixed(2);
async function renderInvoice(app, token, justPaid){
  document.title = "Invoice";
  Object.assign(_inv, { token, data: null, pick: "", rates: [], ratesZip: "", rateIdx: -1, manual: false, addr: {}, busy: "", err: "", paidNote: !!justPaid,
    codeText: "", codeMsg: "", giftText: "", giftMsg: "", giftOk: "", poText: "", poMsg: "", poOk: "" });
  app.innerHTML = `<div class="inv" role="status">Loading your invoice…</div>`;
  let res, data;
  try { res = await fetch("/api/invoice?token=" + encodeURIComponent(token)); data = await res.json(); }
  catch (e) { app.innerHTML = `<div class="inv"><p class="inv-err">We couldn't load your invoice. Check your connection and try the link again.</p></div>`; return; }
  if (!data || data.status !== "ok") {
    app.innerHTML = `<div class="inv"><p class="inv-err">${escapeHtml((data && data.message) || "This invoice link isn't valid.")}</p></div>`;
    return;
  }
  invApply_(data.invoice);
  // Back from paying by card: the payment is recorded by Stripe's notice to us, which can trail the
  // redirect by a few seconds — look again, twice, rather than leave the customer wondering.
  if (justPaid && !_inv.data.paid) [3000, 9000].forEach(ms => setTimeout(async () => {
    if (!_inv.data || _inv.data.paid) return;
    try { const d = await (await fetch("/api/invoice?token=" + encodeURIComponent(token))).json(); if (d && d.status === "ok") invApply_(d.invoice); } catch (e) {}
  }, ms));
}
// Takes a fresh answer from the server and redraws. The selection starts on what the order has now.
function invApply_(invoice){
  _inv.data = invoice;
  const d = invoice.delivery || {}, cur = d.current;
  if (!_inv.pick) {
    if (cur && (cur.kind === "shipping" || cur.kind === "shipping-quote")) _inv.pick = "ship";
    else if (cur && cur.kind === "pickup") _inv.pick = "o:" + ((d.options.find(o => o.type === "pickup") || {}).id || "pickup");
    else if (cur && cur.kind === "option") _inv.pick = "o:" + ((d.options.find(o => o.type === "custom" && o.label === cur.label) || {}).id || "");
    else if (d.options && d.options.length === 1 && d.options[0].type === "shipping") _inv.pick = "ship";
  }
  if (d.address && !Object.keys(_inv.addr).length) _inv.addr = Object.assign({}, d.address);
  document.title = "Invoice — " + invoice.orderId;
  invDraw_();
}
function invNeedsChoice_(){
  const d = _inv.data.delivery || {};
  return !!(d.options && d.options.length) && !d.locked && !d.chosen;
}
function invDraw_(){
  const app = document.getElementById("app"), v = _inv.data, d = v.delivery || {};
  if (!app || !v) return;
  const restoreFocus = keepFocus_(app);
  const acc = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(v.orgAccent || "")) ? v.orgAccent : "#1d4ed8";
  const itemRows = v.items.map(it => `<tr>
      <td>${escapeHtml(it.name)}${it.size ? ` <span class="inv-detail">· ${escapeHtml(it.size)}</span>` : ""}${it.detail ? `<div class="inv-detail">${escapeHtml(it.detail)}</div>` : ""}</td>
      <td class="num">${Number(it.qty) || 1}</td><td class="num">${invMoney_(it.lineTotal)}</td></tr>`).join("");
  const cur = d.current;
  const deliveryRow = cur
    ? `<tr><td>${escapeHtml(cur.label)}</td><td class="num">${cur.fee == null ? "To follow" : Number(cur.fee) > 0 ? invMoney_(cur.fee) : "Free"}</td></tr>`
    : (v.shipping > 0 ? `<tr><td>Delivery</td><td class="num">${invMoney_(v.shipping)}</td></tr>` : "");
  // What free-shipping codes took off the shipping (migrations/0120).
  const freeShipRow = Number(v.shippingDiscount) > 0
    ? `<tr><td>Free shipping${(v.discountCodes || []).length ? " (" + escapeHtml(v.discountCodes.join(", ")) + ")" : ""}</td><td class="num">−${invMoney_(v.shippingDiscount)}</td></tr>` : "";
  // Gift cards are a payment: listed as paid, and out of "Paid so far" so nothing is counted twice.
  const giftPaid = (v.giftCardPaid || []).filter(g => Number(g.amount) > 0);
  const giftRows = giftPaid.map(g => `<tr class="inv-gift"><td>Paid by ${escapeHtml(String(g.label || "gift card").replace(/^Gift card/i, "gift card"))}</td><td class="num">−${invMoney_(g.amount)}</td></tr>`).join("");
  const otherReceived = Math.round((Number(v.received) - giftPaid.reduce((n, g) => n + Math.round(g.amount * 100), 0) / 100) * 100) / 100;
  // Sales tax added on top of the prices (taxMode "exclusive") is its own line in the totals; tax
  // included in them is noted under the totals.
  const taxOnTop = v.taxMode === "exclusive";
  const taxWhat = "Sales tax" + (v.taxRate ? " (" + v.taxRate + "%" + (v.taxJurisdiction ? " " + escapeHtml(v.taxJurisdiction) : "") + ")" : "");
  const taxRow = taxOnTop && v.salesTax > 0 ? `<tr><td>${taxWhat}</td><td class="num">${invMoney_(v.salesTax)}</td></tr>` : "";
  const taxNote = !taxOnTop && v.salesTax > 0 ? `<div class="inv-tax">Includes ${taxWhat.charAt(0).toLowerCase() + taxWhat.slice(1)} ${invMoney_(v.salesTax)}</div>` : "";
  // A rush order's payment deadline (migrations/0083): full payment by this date, or the rush date can't be
  // guaranteed — at the top and again by the pay buttons. Once it's paid in full there's nothing to warn about.
  const longDay = (day) => { const d = new Date(String(day) + "T12:00:00Z"); return isNaN(d) ? String(day || "") : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }); };
  let rushHtml = "", rushShort = "";
  if (v.rushRequested && v.rushPayBy && !(v.paid && !v.rushFeePending)) {
    const pay = longDay(v.rushPayBy), need = v.neededBy ? longDay(v.neededBy) : "";
    if (v.rushPayByPassed) {
      rushHtml = `<div class="inv-rush passed" role="alert"><b class="t">⚡ Rush order — the payment date has passed</b>
        Full payment was due by ${escapeHtml(pay)} to keep the rush delivery date${need ? " of " + escapeHtml(need) : ""}.
        <b class="w">Because we haven't received full payment, we can no longer guarantee the rush delivery date. Please pay as soon as you can and contact us — we'll do our best.</b></div>`;
      rushShort = `<p class="inv-rush-short">The rush payment date (${escapeHtml(pay)}) has passed — the rush delivery date can no longer be guaranteed.</p>`;
    } else {
      rushHtml = `<div class="inv-rush" role="note"><b class="t">⚡ Rush order — full payment due by ${escapeHtml(pay)}</b>
        ${need ? `Rush delivery date: <b>${escapeHtml(need)}</b>. To keep that date, we` : "To keep the rush, we"} must receive full payment by <b>${escapeHtml(pay)}</b>${v.rushFeePending ? " — including the rush fee, which we'll send you separately" : ""}. A mailed check has to arrive by then.
        <b class="w">If we have not received full payment by ${escapeHtml(pay)}, we cannot guarantee the rush delivery date${need ? " of " + escapeHtml(need) : ""}.</b></div>`;
      rushShort = `<p class="inv-rush-short">Pay in full by ${escapeHtml(pay)} to keep your rush delivery date.</p>`;
    }
  } else if (v.rushRequested && v.neededBy) {
    rushHtml = `<div class="inv-note">⚡ Rush order — rush delivery date ${escapeHtml(longDay(v.neededBy))}.</div>`;
  }

  // Delivery: a choice to make, or (once it can't be changed) just what was chosen.
  let deliveryHtml = "";
  if (d.options && d.options.length && !d.locked) {
    const fee = (f) => Number(f) > 0 ? invMoney_(f) : "Free";
    const a = _inv.addr, val = (k) => escapeHtml(a[k] || "");
    const rateRows = _inv.rates.map((r, i) => `<label class="inv-opt"><input type="radio" name="invRate" value="${i}"${_inv.rateIdx === i ? " checked" : ""}>
        <span>${escapeHtml(r.provider)} ${escapeHtml(r.service)} — <b>${invMoney_(r.amount)}</b>${r.estimatedDays ? ` <span class="inv-detail">(about ${r.estimatedDays} day${r.estimatedDays !== 1 ? "s" : ""})</span>` : ""}</span></label>`).join("");
    const manualRow = _inv.manual ? `<label class="inv-opt"><input type="radio" name="invRate" value="manual"${_inv.rateIdx === -2 ? " checked" : ""}>
        <span>Ship to this address — <b>we'll send you the shipping cost</b></span></label>
        <div class="inv-detail" style="margin-left:24px;">This order needs a shipping quote by hand. You can pay for the items now; the shipping is billed separately.</div>` : "";
    const shipBlock = `<div class="inv-ship" id="invShip"${_inv.pick === "ship" ? "" : " hidden"}>
        <div class="inv-grid">
          <label class="f full">Name<input type="text" id="invAName" autocomplete="name" maxlength="200" value="${val("name")}"></label>
          <label class="f full">Street address<input type="text" id="invALine1" autocomplete="address-line1" maxlength="200" value="${val("line1")}"></label>
          <label class="f full">Apartment, suite… (optional)<input type="text" id="invALine2" autocomplete="address-line2" maxlength="200" value="${val("line2")}"></label>
          <label class="f">City<input type="text" id="invACity" autocomplete="address-level2" maxlength="100" value="${val("city")}"></label>
          <label class="f">State<input type="text" id="invAState" autocomplete="address-level1" maxlength="2" placeholder="NY" value="${val("state")}" style="text-transform:uppercase;"></label>
          <label class="f">ZIP<input type="text" id="invAZip" autocomplete="postal-code" inputmode="numeric" maxlength="5" value="${val("zip")}"></label>
        </div>
        <div style="margin-top:10px;"><button type="button" class="inv-btn second" id="invRatesBtn"${_inv.busy === "rates" ? " disabled" : ""}>${_inv.busy === "rates" ? "Getting rates…" : (_inv.rates.length || _inv.manual ? "Update shipping options" : "Show shipping options")}</button></div>
        <div id="invRates" style="margin-top:8px;">${rateRows}${manualRow}</div>
      </div>`;
    const rows = d.options.map(o => o.type === "shipping"
      ? `<label class="inv-opt"><input type="radio" name="invDelivery" value="ship"${_inv.pick === "ship" ? " checked" : ""}><span>${escapeHtml(o.label || "Shipping")} — <b>rates by address</b></span></label>${shipBlock}`
      : `<label class="inv-opt"><input type="radio" name="invDelivery" value="o:${escapeHtml(o.id)}"${_inv.pick === "o:" + o.id ? " checked" : ""}><span>${escapeHtml(o.label)} — <b>${fee(o.fee)}</b></span></label>`).join("");
    deliveryHtml = `<h2>How would you like to get your order?</h2>
      <div role="radiogroup" aria-label="Delivery">${rows}</div>
      <div class="inv-err" id="invDelErr" role="alert">${escapeHtml(_inv.err)}</div>
      <button type="button" class="inv-btn${d.chosen ? " second" : ""}" id="invSaveDelivery"${_inv.busy === "save" ? " disabled" : ""}>${_inv.busy === "save" ? "Saving…" : d.chosen ? "Change my choice" : "Save my choice"}</button>
      ${d.chosen && cur ? `<span class="inv-detail" style="margin-left:10px;">Saved: ${escapeHtml(cur.label)}</span>` : ""}`;
  } else if (cur) {
    const ad = d.address;
    deliveryHtml = `<h2>Delivery</h2><div>${escapeHtml(cur.label)}${ad ? `<div class="inv-detail">${escapeHtml([ad.name, ad.line1, ad.line2, `${ad.city}, ${ad.state} ${ad.zip}`].filter(Boolean).join(" · "))}</div>` : ""}</div>`;
  }

  // Net 30 terms (migrations/0121): the PO and when payment is due, and — while the order has no PO — a box for it. The
  // PO the customer types is checked by the shop (Accept PO) before the order counts as cleared; until then it says so.
  const termsHtml = invTermsHtml_(v);

  // Paying.
  let payHtml;
  if (v.paid) {
    payHtml = `<div class="inv-banner inv-ok" role="status"><b>Paid in full — thank you!</b>${v.received > 0 ? " We received " + invMoney_(v.received) + "." : ""}</div>`;
  } else {
    const due = invMoney_(v.balanceDue), wait = invNeedsChoice_();
    const how = [];
    if (v.payments.includes("Card")) how.push(`<button type="button" class="inv-btn" id="invPayCard"${wait || _inv.busy === "card" ? " disabled" : ""}>${_inv.busy === "card" ? "Opening secure checkout…" : "Pay " + due + " by card"}</button>`);
    if (v.payments.includes("Venmo") && typeof VENMO_USERNAME === "string" && VENMO_USERNAME) {
      const link = `https://venmo.com/u/${encodeURIComponent(VENMO_USERNAME)}?txn=pay&amount=${Number(v.balanceDue).toFixed(2)}&note=${encodeURIComponent(v.orgId + " order " + v.orderId)}`;
      how.push(wait ? `<span class="inv-btn second" aria-disabled="true" style="opacity:.5;">Pay ${due} with Venmo</span>` : `<a class="inv-btn second" id="invPayVenmo" href="${link}" target="_blank" rel="noopener">Pay ${due} with Venmo</a>`);
    }
    // Zelle / check name an amount, so they wait for the delivery choice too (it changes the total).
    // Who to pay comes from Global settings → Business profile (the same details the order confirmation shows).
    if (!wait && v.payments.includes("Zelle")) how.push(`<div class="inv-how"><b class="t">Zelle</b>${business.zelle ? `Send ${due} to <b>${escapeHtml(business.zelle)}</b>` : `Amount due: <b>${due}</b> — we'll send you the Zelle details`} — put <b>${escapeHtml(v.orderId)}</b> in the memo.</div>`);
    if (!wait && v.payments.includes("Check")) how.push(`<div class="inv-how"><b class="t">Check</b>Make it payable to <b>${escapeHtml(business.legalName || bizName_())}</b>, write <b>${escapeHtml(v.orderId)}</b> in the memo${business.mailingAddress ? ` and mail it to <b>${escapeHtml(business.mailingAddress)}</b>` : " — we'll tell you where to send it"}.</div>`);
    // A discount code and/or a gift card, before paying the balance (what the server allows now is v.addOns).
    const ao = v.addOns || {};
    const addOnHtml = !wait && (ao.code || ao.giftCard) ? `<div class="inv-addons">
        ${ao.code ? `<div class="inv-addon"><label for="invCode">${(v.discountCodes || []).length ? "Another discount code" : "Have a discount code?"}</label>
          <div class="inv-addon-row"><input type="text" id="invCode" maxlength="64" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${escapeHtml(_inv.codeText)}" aria-describedby="invCodeMsg">
          <button type="button" class="inv-btn second" id="invCodeBtn"${_inv.busy === "code" ? " disabled" : ""}>${_inv.busy === "code" ? "Checking…" : "Apply"}</button></div>
          <div class="inv-err" id="invCodeMsg" role="alert">${escapeHtml(_inv.codeMsg)}</div></div>` : ""}
        ${ao.giftCard ? `<div class="inv-addon"><label for="invGift">Have a gift card?</label>
          <div class="inv-addon-row"><input type="text" id="invGift" maxlength="24" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX" value="${escapeHtml(_inv.giftText)}" aria-describedby="invGiftMsg">
          <button type="button" class="inv-btn second" id="invGiftBtn"${_inv.busy === "gift" ? " disabled" : ""}>${_inv.busy === "gift" ? "Checking…" : "Use gift card"}</button></div>
          <div class="inv-detail" style="margin-top:4px;">It pays up to what is on the card, of what you owe.</div>
          <div class="${_inv.giftOk ? "inv-detail" : "inv-err"}" id="invGiftMsg" role="alert">${escapeHtml(_inv.giftMsg)}</div></div>` : ""}
      </div>` : "";
    payHtml = `${_inv.paidNote ? `<div class="inv-banner inv-wait" role="status">Thanks — your payment is being confirmed. This page will update in a moment.</div>` : ""}
      ${addOnHtml}
      ${wait ? `<p class="inv-detail" style="font-size:14px;">Choose how you'd like to get your order above — the total depends on it — then pay here.</p>` : ""}
      ${rushShort}
      <div class="inv-pay">${how.join("") || `<p>We'll be in touch about payment.</p>`}</div>
      <div class="inv-err" id="invPayErr" role="alert"></div>`;
  }

  app.innerHTML = `<div class="inv" style="--inv-accent:${acc};--inv-accent-ink:${typeof readableInkOn === "function" ? readableInkOn(acc) : "#fff"};">
      <h1>${escapeHtml(v.orgName)}</h1>
      <div class="inv-sub">Invoice for order <b>${escapeHtml(v.orderId)}</b>${v.customerName ? " · " + escapeHtml(v.customerName) : ""}${v.placedAt ? " · " + escapeHtml(new Date(v.placedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })) : ""}</div>
      ${rushHtml}
      ${v.message ? `<div class="inv-note">${escapeHtml(v.message)}</div>` : ""}
      <table class="inv-items"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>${itemRows}</tbody></table>
      <table class="inv-totals"><tbody>
        <tr><td>Subtotal</td><td class="num">${invMoney_(v.subtotal)}</td></tr>
        ${v.discount > 0 ? `<tr><td>Discount${v.discountNote ? " (" + escapeHtml(v.discountNote) + ")" : ""}</td><td class="num">−${invMoney_(v.discount)}</td></tr>` : ""}
        ${deliveryRow}
        ${freeShipRow}
        ${v.rushRequested ? `<tr><td>Rush fee</td><td class="num">${v.rushFeePending ? "To follow" : invMoney_(v.rushFee)}</td></tr>` : ""}
        ${taxRow}
        <tr class="inv-total"><td>Total</td><td class="num">${invMoney_(v.total)}</td></tr>
        ${giftRows}
        ${otherReceived > 0 ? `<tr><td>Paid so far</td><td class="num">−${invMoney_(otherReceived)}</td></tr>` : ""}
        ${v.paid ? "" : `<tr class="inv-due"><td>Balance due</td><td class="num">${invMoney_(v.balanceDue)}</td></tr>`}
      </tbody></table>
      ${taxNote}
      ${deliveryHtml}
      ${termsHtml}
      <h2>${v.paid ? "Payment" : "Pay"}</h2>
      ${payHtml}
    </div>`;
  invWire_();
  restoreFocus();
}
// "Dec 31, 2026" from "2026-12-31" (a calendar day: no time zone can move it).
function invShortDay_(day){
  const d = new Date(String(day || "") + "T12:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) && !isNaN(d) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
}
// The Net 30 block: "Net 30 — PO 1001 — due Dec 31, 2026", or "PO needed" with the box to add it. Nothing for an order
// without terms; once it's paid in full only the PO is worth repeating.
function invTermsHtml_(v){
  const t = v.terms;
  if (!t || !t.net30) return "";
  const label = "Net " + (Number(t.termsDays) > 0 ? Number(t.termsDays) : 30);
  const due = invShortDay_(t.dueDate);
  const whenDue = due ? "due " + escapeHtml(due) : (t.dueText ? escapeHtml(t.dueText) : "");
  // "PO 1001", but not "PO PO-1001" for a number that already says it.
  const po = (n) => (/^P\.?O\b/i.test(String(n)) ? "" : "PO ") + escapeHtml(n);
  if (v.paid) return t.poNumber ? `<div class="inv-note inv-terms">${escapeHtml(label)} — ${po(t.poNumber)}</div>` : "";
  const thanks = _inv.poOk ? `<div class="inv-detail" role="status">${escapeHtml(_inv.poOk)}</div>` : "";
  if (t.poNumber) {
    return `<h2>Terms</h2><div class="inv-note inv-terms">${escapeHtml(label)} — ${po(t.poNumber)}${whenDue ? " — " + whenDue : ""}${
      t.poStatus === "PO to check" && !_inv.poOk ? `<div class="inv-detail">We'll confirm your PO number.</div>` : ""}</div>${thanks}`;
  }
  const box = t.canSetPo ? `<div class="inv-addon"><label for="invPo">Your PO number</label>
        <div class="inv-addon-row"><input type="text" id="invPo" maxlength="60" autocomplete="off" spellcheck="false" value="${escapeHtml(_inv.poText)}" aria-describedby="invPoMsg">
        <button type="button" class="inv-btn second" id="invPoBtn"${_inv.busy === "po" ? " disabled" : ""}>${_inv.busy === "po" ? "Saving…" : "Add PO number"}</button></div>
        <div class="inv-err" id="invPoMsg" role="alert">${escapeHtml(_inv.poMsg)}</div></div>` : "";
  return `<h2>Terms</h2><div class="inv-note inv-terms">${escapeHtml(label)}${whenDue ? " — " + whenDue : ""}<div><b>PO needed:</b> ${t.canSetPo ? "add your PO number below." : "please send us your PO number."}</div></div>${box}`;
}
// A PO number typed on the invoice (setInvoicePo): saved on this order as the customer's, for the shop to confirm.
async function invSetPo_(){
  const text = _inv.poText.trim();
  if (!text) { _inv.poMsg = "Enter your PO number."; invDraw_(); return; }
  if (text.length > 60) { _inv.poMsg = "A PO number can be up to 60 characters."; invDraw_(); return; }
  _inv.poMsg = ""; _inv.busy = "po"; invDraw_();
  try {
    const res = await fetch("/api/invoice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: _inv.token, action: "setInvoicePo", poNumber: text }) });
    const data = await res.json().catch(() => null);
    _inv.busy = "";
    if (data && data.status === "ok") {
      _inv.poText = ""; _inv.poOk = "Thanks — we'll confirm your PO.";
      announceStatus(_inv.poOk);
      invApply_(data.invoice);
    } else {
      _inv.poMsg = res.status === 429 ? "Too many tries — please wait a minute and try again." : (data && data.message && res.status < 500 ? String(data.message) : "We couldn't save that just now. Please try again.");
      invDraw_();
    }
  } catch (e) { _inv.busy = ""; _inv.poMsg = "We couldn't reach the server — try again."; invDraw_(); }
}
function invReadAddr_(){
  const g = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
  if (document.getElementById("invALine1")) _inv.addr = { name: g("invAName"), line1: g("invALine1"), line2: g("invALine2"), city: g("invACity"), state: g("invAState").toUpperCase(), zip: g("invAZip") };
  return _inv.addr;
}
function invWire_(){
  document.querySelectorAll('input[name="invDelivery"]').forEach(r => r.addEventListener("change", () => {
    invReadAddr_(); _inv.pick = r.value; _inv.err = "";
    const ship = document.getElementById("invShip"); if (ship) ship.hidden = _inv.pick !== "ship";
  }));
  document.querySelectorAll('input[name="invRate"]').forEach(r => r.addEventListener("change", () => { _inv.rateIdx = r.value === "manual" ? -2 : Number(r.value); }));
  const ratesBtn = document.getElementById("invRatesBtn"); if (ratesBtn) ratesBtn.onclick = invGetRates_;
  // The rates are priced for the ZIP they were asked for: changing the ZIP drops them (in place, so the
  // customer keeps typing in the box) and asks for new ones, instead of the save being refused later.
  const zipBox = document.getElementById("invAZip");
  if (zipBox) zipBox.addEventListener("input", () => {
    if (!_inv.rates.length || zipBox.value.trim() === _inv.ratesZip) return;
    _inv.rates = []; _inv.rateIdx = -1; _inv.manual = false;
    _inv.err = "The ZIP changed — tap “Show shipping options” for rates to the new ZIP.";
    const list = document.getElementById("invRates"); if (list) list.innerHTML = "";
    if (ratesBtn) ratesBtn.textContent = "Show shipping options";
    const e = document.getElementById("invDelErr"); if (e) e.textContent = _inv.err;
  });
  const save = document.getElementById("invSaveDelivery"); if (save) save.onclick = invSaveDelivery_;
  const card = document.getElementById("invPayCard"); if (card) card.onclick = invPayCard_;
  const codeBtn = document.getElementById("invCodeBtn"); if (codeBtn) codeBtn.onclick = () => invAddOn_("applyCode");
  const giftBtn = document.getElementById("invGiftBtn"); if (giftBtn) giftBtn.onclick = () => invAddOn_("applyGiftCard");
  const codeBox = document.getElementById("invCode");
  if (codeBox) { codeBox.oninput = () => { _inv.codeText = codeBox.value; }; codeBox.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); invAddOn_("applyCode"); } }; }
  const poBtn = document.getElementById("invPoBtn"); if (poBtn) poBtn.onclick = invSetPo_;
  const poBox = document.getElementById("invPo");
  if (poBox) { poBox.oninput = () => { _inv.poText = poBox.value; if (_inv.poMsg) { _inv.poMsg = ""; const m = document.getElementById("invPoMsg"); if (m) m.textContent = ""; } }; poBox.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); invSetPo_(); } }; }
  const giftBox = document.getElementById("invGift");
  if (giftBox) { giftBox.oninput = () => { _inv.giftText = giftBox.value; }; giftBox.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); invAddOn_("applyGiftCard"); } }; }
}
// A discount code or a gift card typed on the invoice. The server (the shop's rules) decides; its answer is the invoice as
// it is now, or a sentence to show under the box. Nothing is kept of a gift card number once it has been tried.
async function invAddOn_(action){
  const isCode = action === "applyCode";
  const text = (isCode ? _inv.codeText : _inv.giftText).trim();
  const setMsg = (m, ok) => { if (isCode) _inv.codeMsg = m; else { _inv.giftMsg = m; _inv.giftOk = ok ? "1" : ""; } };
  if (!text) { setMsg(isCode ? "Enter a discount code." : "Enter your gift card number."); invDraw_(); return; }
  setMsg(""); _inv.busy = isCode ? "code" : "gift"; invDraw_();
  try {
    const res = await fetch("/api/invoice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: _inv.token, action, code: text }) });
    const data = await res.json().catch(() => null);
    _inv.busy = "";
    if (data && data.status === "ok") {
      const before = Number(_inv.data.balanceDue) || 0;
      if (isCode) _inv.codeText = ""; else _inv.giftText = "";
      setMsg("");
      announceStatus(isCode ? "Discount code applied." : "Gift card used.");
      invApply_(data.invoice);
      if (!isCode) { const took = before - (Number(data.invoice.balanceDue) || 0); if (took > 0 && !data.invoice.paid) { setMsg("The gift card paid " + invMoney_(took) + ". The rest is still due below.", true); invDraw_(); } }
    } else {
      setMsg(res.status === 429 ? "Too many tries — please wait a minute and try again." : (data && data.message && res.status < 500 ? String(data.message) : "We couldn't do that just now. Please try again."));
      invDraw_();
    }
  } catch (e) { _inv.busy = ""; setMsg("We couldn't reach the server — try again."); invDraw_(); }
}
// Carrier rates for the typed ZIP, from the same /api/shipping the storefront uses (each rate comes
// back signed for this shop, these items and that ZIP — that signature is what gets saved).
async function invGetRates_(){
  const a = invReadAddr_(), v = _inv.data;
  if (!/^\d{5}$/.test(a.zip || "")) { _inv.err = "Enter the 5-digit ZIP code to ship to."; invDraw_(); return; }
  _inv.err = ""; _inv.rates = []; _inv.rateIdx = -1; _inv.manual = false;
  if (!v.delivery.quotable) { _inv.manual = true; _inv.rateIdx = -2; invDraw_(); return; }
  _inv.busy = "rates"; invDraw_();
  try {
    const res = await fetch("/api/shipping", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zip: a.zip, org: v.orgId, invoiceToken: _inv.token, items: v.items.map(it => ({ productId: it.productId, qty: it.qty })) }) });
    const data = await res.json();
    if (data.status === "ok") { _inv.rates = (data.rates || []).filter(r => r.quoteToken); _inv.ratesZip = a.zip; _inv.manual = !!data.manualShipping || !_inv.rates.length; if (_inv.manual && !_inv.rates.length) _inv.rateIdx = -2; }
    else _inv.err = "We couldn't get shipping rates — check the ZIP and try again.";
  } catch (e) { _inv.err = "We couldn't reach the shipping service — try again."; }
  _inv.busy = ""; invDraw_();
}
async function invSaveDelivery_(){
  const a = invReadAddr_();
  const body = { token: _inv.token, action: "setDelivery" };
  if (_inv.pick === "ship") {
    if (!a.line1 || !a.city || !/^\d{5}$/.test(a.zip || "")) { _inv.err = "Enter the street address, city and ZIP to ship to."; invDraw_(); return; }
    if (_inv.rateIdx === -2) body.manualShipping = true;
    else if (_inv.rateIdx >= 0 && _inv.rates[_inv.rateIdx]) {
      if (_inv.ratesZip && a.zip !== _inv.ratesZip) { _inv.err = "The ZIP changed — tap “Show shipping options” for rates to the new ZIP."; invDraw_(); return; }
      body.quoteToken = _inv.rates[_inv.rateIdx].quoteToken;
    }
    else { _inv.err = _inv.rates.length || _inv.manual ? "Choose one of the shipping options." : "Tap “Show shipping options”, then choose one."; invDraw_(); return; }
    body.shippingAddress = a;
  } else if (_inv.pick.startsWith("o:") && _inv.pick.length > 2) body.deliveryOptionId = _inv.pick.slice(2);
  else { _inv.err = "Choose how you'd like to get your order."; invDraw_(); return; }
  _inv.err = ""; _inv.busy = "save"; invDraw_();
  try {
    const res = await fetch("/api/invoice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    _inv.busy = "";
    if (data.status === "ok") { announceStatus("Saved. " + ((data.invoice.delivery.current || {}).label || "")); invApply_(data.invoice); }
    else { _inv.err = data.message || "We couldn't save that — try again."; invDraw_(); }
  } catch (e) { _inv.busy = ""; _inv.err = "We couldn't reach the server — try again."; invDraw_(); }
}
async function invPayCard_(){
  const v = _inv.data, err = () => document.getElementById("invPayErr");
  _inv.busy = "card"; invDraw_();
  try {
    const res = await fetch("/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: v.orderId, orgId: v.orgId, invoiceToken: _inv.token }) });
    const data = await res.json();
    if (data.status === "ok" && data.url) { window.location.href = data.url; return; }
    _inv.busy = ""; invDraw_(); if (err()) err().textContent = data.message || "We couldn't start the card payment — try again.";
  } catch (e) { _inv.busy = ""; invDraw_(); if (err()) err().textContent = "We couldn't reach the server — try again."; }
}

// ---- Quote page (/?estimate=<token>) ----------------------------------------------------------
// Opened from the link in a quote email (admin → Quotes → Send). ("Quote" to people; "estimate" in the code, where
// a quote is already the signed shipping rate.) Shows the quote as the shop sent it — the prices are the ones
// frozen when it was sent — and lets the customer accept it (which places the order) or ask for changes. Built
// like the invoice page above: everything comes from /api/estimate, and every answer redraws the page from what
// the server says the quote is now; the page itself decides nothing about whether it can be accepted.
const _est = { token: "", data: null, busy: "", err: "", confirming: false, asking: false, note: "", done: "" };
async function renderEstimate(app, token){
  document.title = "Quote";
  Object.assign(_est, { token, data: null, busy: "", err: "", confirming: false, asking: false, note: "", done: "" });
  app.innerHTML = `<div class="inv" role="status">Loading your quote…</div>`;
  let data;
  try { const res = await fetch("/api/estimate?token=" + encodeURIComponent(token)); data = await res.json(); }
  catch (e) { app.innerHTML = `<div class="inv"><p class="inv-err" role="alert">We couldn't load your quote. Check your connection and try the link again.</p></div>`; return; }
  if (!data || data.status !== "ok" || !data.estimate) {
    app.innerHTML = `<div class="inv"><p class="inv-err" role="alert">${escapeHtml((data && data.message) || "This quote link isn't valid.")}</p></div>`;
    return;
  }
  estApply_(data.estimate);
}
function estApply_(estimate){
  _est.data = estimate;
  document.title = "Quote" + (estimate.number ? " — " + estimate.number : "");
  estDraw_();
}
// What the page may offer. The server's canAccept is the answer; the status rule is only for an answer without it
// (accepting is refused once the quote is expired, cancelled, accepted or converted).
function estCanRespond_(v){
  if (typeof v.canAccept === "boolean") return v.canAccept;
  return (v.status === "sent" || v.status === "changes") && !v.expired;
}
const estLongDay_ = (day) => { const d = new Date(String(day || "").slice(0, 10) + "T12:00:00Z"); return isNaN(d) ? String(day || "") : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }); };
const EST_FEE_LABELS_ = { setup: "Setup", digitizing: "Digitizing", art: "Art", other: "" };
function estDraw_(){
  const app = document.getElementById("app"), v = _est.data;
  if (!app || !v) return;
  const restoreFocus = keepFocus_(app);
  const acc = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(v.orgAccent || "")) ? v.orgAccent : "#1d4ed8";
  // /api/estimate sends the product and custom lines as `lines` and the one-time charges as `fees`.
  const all = (v.lines || v.items || []).concat(Array.isArray(v.fees) ? v.fees.map(f => Object.assign({ kind: "fee" }, f)) : []);
  const lines = all.filter(it => it.kind !== "fee"), fees = all.filter(it => it.kind === "fee");
  // A quantity price shows the list price it came down from ("was"), as the cart does.
  const was = (it) => { const w = Number(it.wasPrice != null ? it.wasPrice : it.wasUnitPrice != null ? it.wasUnitPrice : it.listUnitPrice); return Number.isFinite(w) && w > Number(it.unitPrice) + 0.004 ? w : null; };
  const lineRows = lines.map(it => { const w = was(it); return `<tr>
      <td>${escapeHtml(it.name)}${it.size && it.size !== "OSFA" ? ` <span class="inv-detail">· ${escapeHtml(it.size)}</span>` : ""}${it.detail ? `<div class="inv-detail">${escapeHtml(it.detail)}</div>` : ""}${it.personalized && it.persName ? `<div class="inv-detail">Personalization: “${escapeHtml(it.persName)}”</div>` : ""}</td>
      <td class="num">${Number(it.qty) || 1}</td>
      <td class="num">${invMoney_(it.unitPrice)}${w != null ? `<div class="inv-detail">was <del>${invMoney_(w)}</del></div>` : ""}</td>
      <td class="num">${invMoney_(it.lineTotal)}</td></tr>`; }).join("");
  const feeRows = fees.map(f => { const kind = EST_FEE_LABELS_[f.feeKind] || "", name = String(f.name || "");
    const label = kind && !name.toLowerCase().includes(kind.toLowerCase()) ? kind + (name ? " — " + name : " fee") : (name || "Fee");
    return `<tr><td>${escapeHtml(label)}</td><td class="num">${invMoney_(f.lineTotal != null ? f.lineTotal : f.amount)}</td></tr>`; }).join("");
  const taxOnTop = v.taxMode === "exclusive", tax = Number(v.tax != null ? v.tax : v.salesTax) || 0;
  const taxWhat = "Sales tax" + (v.taxRate ? " (" + escapeHtml(String(v.taxRate)) + "%" + (v.taxJurisdiction ? " " + escapeHtml(v.taxJurisdiction) : "") + ")" : "");
  const taxRow = taxOnTop && tax > 0 ? `<tr><td>${taxWhat}</td><td class="num">${invMoney_(tax)}</td></tr>` : "";
  const taxNote = !taxOnTop && tax > 0 ? `<div class="inv-tax">Includes ${taxWhat.charAt(0).toLowerCase() + taxWhat.slice(1)} ${invMoney_(tax)}</div>` : "";

  // Where the quote stands. Right after this customer acted, that comes first; otherwise the status the server gave.
  const st = v.status || "";
  const orderRef = v.orderId ? ` <b>${escapeHtml(v.orderId)}</b>` : "";
  let stateHtml = "";
  // Accepted here: the order is normally made at once; if it couldn't be (the shop is told), say only what is true.
  if (_est.done === "accepted") stateHtml = v.orderId
    ? `<div class="inv-banner inv-ok" role="status" id="estState" tabindex="-1"><b>Thank you — your order${orderRef} is placed.</b> ${v.invoiceSent === false ? "We'll be in touch about payment." : "Your invoice is on its way by email."}</div>`
    : `<div class="inv-banner inv-ok" role="status" id="estState" tabindex="-1"><b>Thank you — you've accepted this quote.</b> We'll be in touch about your order and payment.</div>`;
  else if (_est.done === "changes") stateHtml = `<div class="inv-banner inv-ok" role="status" id="estState" tabindex="-1"><b>Thanks — we've sent your message to ${escapeHtml(v.orgName || bizName_())}.</b> We'll get back to you with a revised quote.</div>`;
  else if (st === "accepted" || st === "converted") stateHtml = `<div class="inv-banner inv-ok" role="status">This quote has been accepted${v.orderId ? " — it's order" + orderRef : ""}.${v.acceptedAt ? " (" + escapeHtml(estLongDay_(v.acceptedAt)) + ")" : ""}</div>`;
  else if (st === "cancelled") stateHtml = `<div class="inv-banner inv-wait" role="status">This quote has been withdrawn, so it can't be accepted. Please contact us if you'd still like to order.</div>`;
  else if (v.expired) stateHtml = `<div class="inv-banner inv-wait" role="status">This quote expired${v.expiresOn ? " on " + escapeHtml(estLongDay_(v.expiresOn)) : ""}, so it can't be accepted. Please contact us for an updated quote.</div>`;
  else if (st === "changes") stateHtml = `<div class="inv-banner inv-wait" role="status">You asked for changes${v.respondedAt ? " on " + escapeHtml(estLongDay_(v.respondedAt)) : ""}. We'll send you a revised quote.${v.customerNote ? `<div class="inv-detail" style="white-space:pre-wrap;margin-top:6px;">Your message: ${escapeHtml(v.customerNote)}</div>` : ""}</div>`;

  // Accept / ask for changes, while the quote can still be answered (and not just answered from this page).
  let actHtml = "";
  if (estCanRespond_(v) && !_est.done) {
    const busy = !!_est.busy;
    const acceptPart = _est.confirming
      ? `<div class="inv-how" id="estConfirm" role="group" aria-labelledby="estConfirmText">
          <p id="estConfirmText" style="margin:0 0 10px;"><b>Accept this quote and place the order for ${invMoney_(v.total)}?</b> We'll start on it and email you the invoice.</p>
          <button type="button" class="inv-btn" id="estAcceptYes"${busy ? " disabled" : ""}>${_est.busy === "accept" ? "Placing your order…" : "Yes, accept and order"}</button>
          <button type="button" class="inv-btn second" id="estAcceptNo"${busy ? " disabled" : ""}>Not yet</button>
        </div>`
      : `<button type="button" class="inv-btn" id="estAccept"${busy ? " disabled" : ""}>Accept quote</button>`;
    const askPart = _est.asking
      ? `<div class="inv-how" id="estAsk">
          <label class="f" for="estNote" style="display:block;font-weight:600;margin-bottom:4px;">What would you like changed?</label>
          <textarea id="estNote" rows="4" maxlength="2000" style="width:100%;box-sizing:border-box;padding:8px 9px;border:1px solid #bbb;border-radius:4px;font:inherit;font-size:16px;background:#fff;color:#111;">${escapeHtml(_est.note)}</textarea>
          <div style="margin-top:8px;display:flex;gap:10px;flex-wrap:wrap;">
            <button type="button" class="inv-btn" id="estAskSend"${busy ? " disabled" : ""}>${_est.busy === "changes" ? "Sending…" : "Send my request"}</button>
            <button type="button" class="inv-btn second" id="estAskCancel"${busy ? " disabled" : ""}>Cancel</button>
          </div>
        </div>`
      : (_est.confirming ? "" : `<button type="button" class="inv-btn second" id="estAskOpen"${busy ? " disabled" : ""}>Ask for changes</button>`);
    actHtml = `<h2>Your answer</h2>
      ${v.expiresOn ? `<p class="inv-detail" style="font-size:14px;margin:0 0 10px;">You can accept this quote until ${escapeHtml(estLongDay_(v.expiresOn))}.</p>` : ""}
      <div class="inv-pay">${_est.asking ? "" : acceptPart}${askPart}</div>
      <div class="inv-err" id="estErr" role="alert">${escapeHtml(_est.err)}</div>`;
  } else if (_est.err) {
    // Refused because the quote changed meanwhile (the server's answer redrew it): the buttons are gone, and the
    // reason stays in view.
    actHtml = `<div class="inv-err" id="estErr" role="alert">${escapeHtml(_est.err)}</div>`;
  }

  const sub = [v.number ? `Quote <b>${escapeHtml(v.number)}</b>` : "Quote", v.customerName ? escapeHtml(v.customerName) : "",
    v.sentAt ? escapeHtml(estLongDay_(v.sentAt)) : ""].filter(Boolean).join(" · ");
  app.innerHTML = `<div class="inv" style="--inv-accent:${acc};--inv-accent-ink:${typeof readableInkOn === "function" ? readableInkOn(acc) : "#fff"};">
      <h1>${escapeHtml(v.orgName || bizName_())}</h1>
      <div class="inv-sub">${sub}</div>
      ${stateHtml}
      ${v.title ? `<h2 style="border-top:none;padding-top:0;margin-top:0;">${escapeHtml(v.title)}</h2>` : ""}
      ${v.message ? `<div class="inv-note">${escapeHtml(v.message)}</div>` : ""}
      ${lineRows ? `<table class="inv-items"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Each</th><th class="num">Amount</th></tr></thead><tbody>${lineRows}</tbody></table>` : ""}
      ${feeRows ? `<table class="inv-items" style="margin-top:14px;"><thead><tr><th>One-time charges</th><th class="num">Amount</th></tr></thead><tbody>${feeRows}</tbody></table>` : ""}
      <table class="inv-totals"><tbody>
        <tr><td>Subtotal</td><td class="num">${invMoney_(v.subtotal)}</td></tr>
        ${estDiscountRows_(v)}
        ${taxRow}
        <tr class="inv-total"><td>Total</td><td class="num">${invMoney_(v.total)}</td></tr>
      </tbody></table>
      ${taxNote}
      ${!v.expired && v.expiresOn && !actHtml && st !== "accepted" && st !== "converted" && st !== "cancelled" ? `<p class="inv-detail">Valid until ${escapeHtml(estLongDay_(v.expiresOn))}.</p>` : ""}
      ${actHtml}
    </div>`;
  estWire_();
  restoreFocus();
}
// The discount codes on a quote (migrations/0120): one line per code when the quote names each code's share, else one
// line for them all; then free shipping. The total already has them taken off.
function estDiscountRows_(v){
  const per = Array.isArray(v.discounts) ? v.discounts.filter(d => d && Number(d.amount) > 0) : [];
  const codes = Array.isArray(v.discountCodes) ? v.discountCodes.map(c => String(c && typeof c === "object" ? c.code : c || "")).filter(Boolean) : [];
  let rows = "";
  if (per.length > 1) rows = per.map(d => `<tr><td>Discount${d.code ? " (" + escapeHtml(d.code) + ")" : ""}</td><td class="num">−${invMoney_(Number(d.amount))}</td></tr>`).join("");
  else if (Number(v.discount) > 0) rows = `<tr><td>Discount${codes.length ? " (" + escapeHtml(codes.join(", ")) + ")" : ""}</td><td class="num">−${invMoney_(Number(v.discount))}</td></tr>`;
  if (Number(v.shippingOff) > 0) rows += `<tr><td>Free shipping</td><td class="num">−${invMoney_(Number(v.shippingOff))}</td></tr>`;
  return rows;
}
function estWire_(){
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  const focus = (id) => { const el = document.getElementById(id); if (el) try { el.focus({ preventScroll: false }); } catch (_) { el.focus(); } };
  on("estAccept", () => { _est.confirming = true; _est.err = ""; estDraw_(); focus("estAcceptYes"); });
  on("estAcceptNo", () => { _est.confirming = false; estDraw_(); focus("estAccept"); });
  on("estAcceptYes", () => estRespond_("accept"));
  on("estAskOpen", () => { _est.asking = true; _est.err = ""; estDraw_(); focus("estNote"); });
  on("estAskCancel", () => { estReadNote_(); _est.asking = false; _est.err = ""; estDraw_(); focus("estAskOpen"); });
  on("estAskSend", () => estRespond_("changes"));
  const note = document.getElementById("estNote");
  if (note) note.addEventListener("input", () => { _est.note = note.value; });
  // Escape steps back out of the confirmation or the message box, as a pop-up would close.
  const box = document.getElementById("estConfirm") || document.getElementById("estAsk");
  if (box) box.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || _est.busy) return;
    e.preventDefault();
    const was = _est.confirming ? "estAccept" : "estAskOpen";
    estReadNote_(); _est.confirming = false; _est.asking = false; estDraw_(); focus(was);
  });
}
function estReadNote_(){ const el = document.getElementById("estNote"); if (el) _est.note = el.value; }
async function estRespond_(action){
  estReadNote_();
  const note = _est.note.trim();
  if (action === "changes" && !note) { _est.err = "Tell us what you'd like changed."; estDraw_(); const el = document.getElementById("estNote"); if (el) el.focus(); return; }
  if (note.length > 2000) { _est.err = "Please keep your message under 2,000 characters."; estDraw_(); return; }
  _est.err = ""; _est.busy = action; estDraw_();
  let data = null;
  try {
    const res = await fetch("/api/estimate", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action === "changes" ? { token: _est.token, action, note } : { token: _est.token, action }) });
    data = await res.json();
  } catch (e) { data = null; }
  _est.busy = "";
  if (!data) {
    // No answer: the accept may still have gone through. Look again before offering the button twice.
    _est.err = action === "accept" ? "We couldn't confirm that reached us. Reload this page to see whether your order was placed before trying again." : "We couldn't reach the server — try again.";
    estDraw_(); return;
  }
  if (data.status !== "ok") {
    _est.err = data.message || "We couldn't do that — try again.";
    // The quote may have changed meanwhile (expired, withdrawn, accepted): redraw from what the server says it is.
    if (data.estimate) _est.data = data.estimate;
    _est.confirming = false; estDraw_(); return;
  }
  _est.confirming = false; _est.asking = false; _est.note = "";
  _est.done = action === "accept" ? "accepted" : "changes";
  const next = data.estimate || Object.assign({}, _est.data, { status: action === "accept" ? "converted" : "changes" });
  if (data.orderId && !next.orderId) next.orderId = data.orderId;
  if (typeof data.invoiceSent === "boolean") next.invoiceSent = data.invoiceSent;
  estApply_(next);
  const st = document.getElementById("estState"); if (st) st.focus();
  announceStatus(action === "accept" ? "Your order is placed." : "Your message was sent.");
}

async function renderDesignVerify(app, token){
  document.title = "Design Verification";
  // The page sits on a white card (like the invoice page): the site's page background is dark.
  const msg = (text, err) => `<div class="dv"><div class="dv-msg${err ? " err" : ""}"${err ? ' role="alert"' : ""}>${text}</div></div>`;
  app.innerHTML = msg("Loading your design…");
  let data;
  try{
    const res = await fetch("/api/verify?token=" + encodeURIComponent(token));
    data = await res.json();
  }catch{
    app.innerHTML = msg("Could not load design verification. Please check your link or contact us.", true);
    return;
  }
  if(data && data.status === "unavailable"){
    // Design approval is switched off for this site: say so plainly (it isn't a broken link).
    app.innerHTML = msg(escapeHtml(data.message || "Design approval isn't available right now. Please contact us about your order."));
    return;
  }
  if(!data || data.status !== "ok"){
    app.innerHTML = msg("This verification link is invalid or has expired.", true);
    return;
  }

  document.title = "Design Verification — " + data.orderId;
  const accent = String(data.orgAccent || "#1d4ed8").trim();
  // A text colour readable on the shop colour, for the filled buttons; and the shop name in the shop
  // colour only when that colour is dark enough to read on white.
  const accentInk = readableInkOn(accent);
  const accentText = accentInk === "#fff" ? accent : "#1a1a1a";
  const alreadyResponded = data.verificationStatus !== "pending";

  const imagesHtml = (data.imageUrls || []).filter(Boolean).map(
    u => `<div class="dv-img"><img src="${escapeHtml(u)}" alt="Design image"></div>`
  ).join("");

  const respondedBanner = alreadyResponded ? `
    <div class="dv-banner ${data.verificationStatus==='approved'?'ok':'wait'}">
      <strong>${data.verificationStatus === 'approved' ? '✓ You approved this design' : '⚠ You requested revisions'}</strong>
      ${data.respondedAt ? ` on ${new Date(data.respondedAt).toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}` : ""}
      ${data.customerNote ? `<br><span class="dv-soft">Your note: ${escapeHtml(data.customerNote)}</span>` : ""}
    </div>` : "";

  app.innerHTML = `
    <div class="dv" style="--dv-accent:${escapeHtml(accent)};--dv-accent-ink:${accentInk};--dv-accent-text:${escapeHtml(accentText)};">
      <div class="dv-org">${escapeHtml(data.orgName)}</div>
      <div class="dv-sub">Design verification for order <strong>${escapeHtml(data.orderId)}</strong></div>
      ${respondedBanner}
      <div class="dv-message">${escapeHtml(data.message)}</div>
      ${imagesHtml}
      ${alreadyResponded ? "" : `
        <div id="dvFormArea" class="dv-form">
          <div class="dv-h" id="dvChoiceLabel">Your response</div>
          <div class="dv-choices" role="group" aria-labelledby="dvChoiceLabel">
            <button type="button" id="dvApproveBtn" class="dv-choice" aria-pressed="false" data-action="dv-choose" data-choice="approved">
              ✓ Approve design
            </button>
            <button type="button" id="dvRevisionBtn" class="dv-choice" aria-pressed="false" data-action="dv-choose" data-choice="revision">
              ✏ Request changes
            </button>
          </div>
          <div id="dvRevisionArea" style="display:none;margin-bottom:16px;">
            <label for="dvNote" class="dv-label">Describe the changes needed <span class="dv-req" aria-hidden="true">*</span></label>
            <textarea id="dvNote" class="dv-field" rows="4" required placeholder="Please be as specific as possible about what needs to change."></textarea>
            <div class="dv-label" style="margin-top:12px;">Supporting images (optional)</div>
            ${[1,2].map(i => `
              <div class="dv-img-row">
                <input type="text" id="dvCustImg${i}" class="dv-field" aria-label="Supporting image ${i} link" placeholder="https://... or upload below">
                <label class="dv-upload">
                  <input type="file" class="sr-only" aria-label="Upload supporting image ${i}" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif" data-target="dvCustImg${i}" data-token="${escapeHtml(token)}" data-change="dv-upload">
                  <span aria-hidden="true">Upload</span>
                </label>
                <span id="dvCustImg${i}Status" class="dv-up-status" aria-live="polite"></span>
              </div>`).join("")}
          </div>
          <div id="dvError" class="dv-err" role="alert"></div>
          <button type="button" id="dvSubmit" class="dv-submit" data-token="${escapeHtml(token)}" data-action="dv-submit" style="display:none;">Submit response</button>
        </div>
      `}
    </div>`;

  window._dvAction = null;

  window.dvSelectAction = function(action){
    window._dvAction = action;
    const approveBtn = document.getElementById("dvApproveBtn");
    const revisionBtn = document.getElementById("dvRevisionBtn");
    const revArea = document.getElementById("dvRevisionArea");
    const submitBtn = document.getElementById("dvSubmit");
    // The chosen button is filled with the shop colour (CSS on aria-pressed), and screen readers hear "pressed".
    approveBtn.setAttribute("aria-pressed", action === "approved" ? "true" : "false");
    revisionBtn.setAttribute("aria-pressed", action === "approved" ? "false" : "true");
    revArea.style.display = action === "approved" ? "none" : "block";
    submitBtn.style.display = "block";
    document.getElementById("dvError").textContent = "";
  };

  window.handleCustVerifyUpload = async function(input){
    const targetId = input.dataset.target;
    const tok = input.dataset.token;
    const statusEl = document.getElementById(targetId + "Status");
    let file = input.files && input.files[0];
    if(!file) return;
    statusEl.classList.remove("err");
    statusEl.textContent = "Uploading…";
    try{
      file = await heicToJpeg_(file);
      const res = await fetch("/api/upload-verify?token=" + encodeURIComponent(tok), {
        method:"POST", headers:{"Content-Type":file.type}, body:file
      });
      const d = await res.json().catch(() => ({}));
      if(!res.ok || d.status !== "ok") throw new Error(d.message || "Upload failed — please try again.");
      document.getElementById(targetId).value = d.url;
      statusEl.textContent = "✓ Uploaded";
    }catch(e){
      // Say why (too big, wrong kind of file, link expired…) rather than a bare "Failed".
      statusEl.classList.add("err");
      statusEl.textContent = (e && e.message && !/^(Failed to fetch|NetworkError|Load failed)/i.test(e.message))
        ? e.message : "Upload failed — check your connection and try again.";
    }
  };

  window.dvSubmitResponse = async function(tok){
    const action = window._dvAction;
    if(!action){ document.getElementById("dvError").textContent = "Please choose Approve or Request changes."; return; }
    const note = action === "revision" ? (document.getElementById("dvNote")||{}).value?.trim() : "";
    if(action === "revision" && !note){ document.getElementById("dvError").textContent = "Please describe the changes needed."; return; }
    const imageUrls = [1,2].map(i => {
      const el = document.getElementById("dvCustImg"+i);
      return el ? el.value.trim() : "";
    }).filter(Boolean);

    const submitBtn = document.getElementById("dvSubmit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    document.getElementById("dvError").textContent = "";

    try{
      const res = await fetch("/api/verify", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({token:tok, action, note, imageUrls})
      });
      const d = await res.json();
      if(!res.ok || d.status !== "ok") throw new Error(d.message || "Could not submit response");
      document.getElementById("dvFormArea").innerHTML = `
        <div class="dv-banner ${action==='approved'?'ok':'wait'}" role="status" style="padding:18px;font-size:15px;text-align:center;margin-bottom:0;">
          <div style="font-size:20px;margin-bottom:6px;">${action==='approved'?'✓ Design approved!':'⚠ Revision request sent'}</div>
          <div class="dv-soft" style="font-size:14px;">${action==='approved'?'Thank you! We\'ll proceed with your order.':'We\'ll review your feedback and be in touch.'}</div>
        </div>`;
    }catch(e){
      document.getElementById("dvError").textContent = e.message || "Could not submit response.";
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit response";
    }
  };
}

// Shown for any hostname that isn't a recognized org subdomain (the
// root domain, a typo, stale DNS, an unconfigured
// wildcard, etc.). Deliberately generic — no client/org names, so a
// misrouted visitor doesn't see a list of every business this site
// hosts. Just enough for them to know whose site this is and how to
// reach out.
function renderGenericFallback(app){
  document.title = bizName_();
  app.innerHTML = `
    <div class="org-hero" style="--org-accent:var(--accent);">
      <div class="org-eyebrow-lg">Custom apparel</div>
      <h1>${escapeHtml(bizName_())}</h1>
      <div class="stitch stitch-thick"></div>
      <p class="desc">${escapeHtml(business.tagline || "Custom decorated apparel for organizations, teams, and businesses.")}</p>
    </div>
    <div class="not-ready" style="--org-accent:var(--accent);">
      <div class="stitch"></div>
      <h2>Looking for your organization's order page?</h2>
      <p>Each client gets their own dedicated ordering link. If you were expecting one here, the link may be mistyped — reach out and we'll get you sorted.</p>
      ${business.supportEmail ? `<p style="margin-top:14px;"><a href="mailto:${escapeHtml(business.supportEmail)}" style="color:var(--accent); font-weight:600;">${escapeHtml(business.supportEmail)}</a></p>` : ""}
    </div>
  `;
}

// Shown when /api/catalog didn't answer (offline, a dropped connection, a passing server error): the
// address may be perfectly good, so say so and offer to try again, which reloads the page and asks again.
function renderLoadError(app){
  document.title = bizName_();
  app.innerHTML = `
    <div class="not-ready" id="loadError" role="alert" style="--org-accent:var(--accent);">
      <div class="stitch"></div>
      <h2>We couldn't load this page</h2>
      <p>This is usually brief. Check your connection, then try again.</p>
      <div class="admin-actions"><button type="button" class="admin-btn" id="loadErrorRetry">Try again</button></div>
      ${business.supportEmail ? `<p style="margin-top:14px;">Still not loading? Email <a href="mailto:${escapeHtml(business.supportEmail)}" style="color:var(--accent); font-weight:600;">${escapeHtml(business.supportEmail)}</a></p>` : ""}
    </div>
  `;
  const btn = document.getElementById("loadErrorRetry");
  if(btn) btn.addEventListener("click", () => { btn.disabled = true; btn.textContent = "Loading…"; window.location.reload(); });
}

// Global settings → Features → Storefront is off: the site is back office only. Every shop address
// and the main address show this — who runs the site and how to reach them, no shop, no products,
// no cart. A customer coming back from a card payment the business emailed them a link for
// (?stripe=success) is told the payment went through.
function renderStorefrontOff(app, r){
  const paid = !!(r && r.paid);
  document.title = bizName_();
  app.innerHTML = `
    <div class="not-ready" id="storefrontOff" style="--org-accent:var(--accent);">
      <div class="stitch"></div>
      ${paid ? `<h2>Payment confirmed!</h2>
      ${r.orderId ? `<div class="order-number">${escapeHtml(r.orderId)}</div>` : ""}
      <p>Your card payment was processed successfully. You'll receive a Stripe receipt by email.</p>`
      : `<h2>Online ordering isn't available here.</h2>`}
      ${business.name ? `<p style="margin-top:14px;font-weight:600;">${escapeHtml(business.name)}</p>` : ""}
      ${business.supportEmail ? `<p style="margin-top:6px;"><a href="mailto:${escapeHtml(business.supportEmail)}" style="color:var(--accent); font-weight:600;">${escapeHtml(business.supportEmail)}</a></p>` : ""}
    </div>
  `;
}

// When the shop stops taking orders (ms): the catalog's orderClosesAt — 11:59:59 pm on the deadline day in the
// business's time zone, the moment the server refuses orders from (catalog.js orderClosing_). A catalog cached before
// it was sent has none: then the end of the deadline day on this computer's clock, as before. NaN for no deadline.
function orderClosesAtMs_(org){
  if(!org || !org.orderDeadline) return NaN;
  const at = org.orderClosesAt ? Date.parse(org.orderClosesAt) : NaN;
  return Number.isFinite(at) ? at : new Date(String(org.orderDeadline).slice(0, 10) + "T23:59:59").getTime();
}
// Today (YYYY-MM-DD) on the business's calendar when the catalog names its zone, else on this computer's.
function shopToday_(org, now){
  if(org && org.orderClosesAt && org.orderTimeZone){
    try{
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: org.orderTimeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
      const get = (t) => (parts.find(p => p.type === t) || {}).value;
      return get("year") + "-" + get("month") + "-" + get("day");
    }catch(e){ /* a zone this browser doesn't know: this computer's calendar */ }
  }
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
}

// Returns an HTML string for the order deadline banner, or "" if no deadline. `now` (a Date) is for the tests.
// urgency: >7 days = normal, 1-7 days = urgent, 0 = "closes today", past = "closed". Days are counted on the
// business's calendar, and the closing time is named in its zone ("at 11:59 pm" and the zone's short name).
function deadlineBannerHtml(org, now){
  const deadline = org && org.orderDeadline;
  if(!deadline) return "";
  now = now || new Date();
  const accent = org.accent;
  const day = String(deadline).slice(0, 10);
  const diffMs = orderClosesAtMs_(org) - now.getTime();
  const [y, m, d] = day.split("-").map(Number);
  const [ty, tm, td] = shopToday_(org, now).split("-").map(Number);
  const diffDays = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
  const accentStyle = accent ? ` style="${orgAccentVars(accent)}"` : "";
  // The deadline is a calendar day: written as that day wherever the shopper is.
  const formatted = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {month:"long", day:"numeric", year:"numeric", timeZone:"UTC"});
  const at = org.orderClosesAt && org.orderZoneLabel ? " at 11:59 pm " + escapeHtml(org.orderZoneLabel) : "";
  if(diffMs < 0){
    const closedMsg = escapeHtml((org.closedMessage || "").trim() || "Ordering for this period has closed.");
    if(org.allowOrdersAfterDeadline !== false){
      // Late orders are taken: say so plainly (the shop's own closed message, if it wrote one, comes first).
      const ownMsg = escapeHtml((org.closedMessage || "").trim());
      return `<div class="deadline-banner closed"${accentStyle}><span class="deadline-badge">Deadline was ${formatted}</span> ${ownMsg ? ownMsg + " " : ""}Late orders are still being accepted.</div>`;
    }
    return `<div class="deadline-banner closed"${accentStyle}><span class="deadline-badge">Closed ${formatted}</span> ${closedMsg}</div>`;
  }
  if(diffDays <= 0){
    return `<div class="deadline-banner urgent"${accentStyle}><span class="deadline-badge">Today</span> Ordering closes today${at} — submit your order now.</div>`;
  }
  const urgency = diffDays <= 7 ? " urgent" : "";
  const label = diffDays === 1 ? "1 day left" : diffDays + " days left";
  return `<div class="deadline-banner${urgency}"${accentStyle}><span class="deadline-badge">${label}</span> Ordering closes ${formatted}${at}.</div>`;
}

function renderOrgPage(app, orgId, org){
  document.title = org.name + " — Order";
  if(!org.ready && !org.preview){
    app.innerHTML = `
      <div class="org-hero" style="${orgAccentVars(org.accent)}">
        <div class="org-eyebrow-lg">${escapeHtml(org.eyebrow)}</div>
        <h1>${escapeHtml(org.name)}</h1>
        <div class="stitch stitch-thick"></div>
      </div>
      <div class="not-ready" style="${orgAccentVars(org.accent)}">
        <div class="stitch"></div>
        <h2>Catalog coming soon</h2>
        <p>${escapeHtml(org.desc) || "This shop hasn't been set up yet."} Check back once products and pricing are finalized, or reach out directly if you have an order ready to go.</p>
      </div>
    `;
    return;
  }

  // Design preview images are optional and per-URL — render only the ones
  // that actually have a URL, and skip the whole block if none do. Without
  // this, a shop with empty design-image fields would render three
  // dead <a href=""><img src=".../thumbs/.jpg"> links (the designImages
  // object always exists — {shirt:"",cap:"",detail:""} even when unset).
  const di = org.designImages || {};
  const previewImgs = [
    { url: di.detail, alt: "Embroidery detail close-up", w: 156, h: 150 },
    { url: di.shirt,  alt: "Design on shirt",            w: 130, h: 150 },
    { url: di.cap,    alt: "Design on cap",              w: 188, h: 150 }
  ].filter(function(it){ return it.url; });
  const previewHtml = previewImgs.length ? `
    <div class="design-preview">
      <div class="design-preview-imgs">
        ${previewImgs.map(function(it){
          return `<a class="zoom-link" href="${escapeHtml(it.url)}"><img src="${escapeHtml(thumbUrl(it.url))}" alt="${escapeHtml(it.alt)} — click to view full size" width="${it.w}" height="${it.h}"></a>`;
        }).join("")}
      </div>
      <div class="design-preview-caption">Actual crest design — placement and size shown are approximate on other fabric options.</div>
    </div>
  ` : "";

  // org already carries its own products (came back in the same
  // /api/catalog response that resolved which org this is) — no
  // separate fetch or loading state needed here.
  activeCatalog = org;

  // Group products by category in the shop's managed order, keeping the server's product order within
  // each group. A product whose category isn't in the list (it was deleted) still shows, after the rest.
  const categories = (Array.isArray(org.categories) && org.categories.length) ? org.categories : DEFAULT_CATEGORIES;
  const CATEGORY_LABELS = {};
  for(const c of categories) CATEGORY_LABELS[c.key] = c.label;
  const byCategory = {};
  for(const p of org.products) (byCategory[p.type] = byCategory[p.type] || []).push(p);
  const activeCategories = categories.map(c => c.key).filter(t => byCategory[t])
    .concat(Object.keys(byCategory).filter(t => !Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, t)));

  // Only show the nav when there are at least 2 categories.
  const catNavHtml = activeCategories.length > 1
    ? `<nav class="cat-nav" aria-label="Jump to category">${activeCategories.map(t =>
        `<a class="cat-nav-link" href="#cat-${escapeHtml(t)}">${escapeHtml(CATEGORY_LABELS[t] || t)}</a>`
      ).join("")}</nav>`
    : "";

  const sectionsHtml = activeCategories.map(t => `
    <section class="cat-section" id="cat-${escapeHtml(t)}" aria-label="${escapeHtml(CATEGORY_LABELS[t] || t)}">
      ${activeCategories.length > 1 ? `<h2 class="cat-heading">${escapeHtml(CATEGORY_LABELS[t] || t)}</h2>` : `<h2 class="cat-heading">Products</h2>`}
      ${versionCardsHtml_(byCategory[t], org)}
    </section>
  `).join("");

  const bannerHtml = deadlineBannerHtml(org);

  // Past the moment the server stops taking orders (orderClosesAtMs_), the same for every shopper.
  const deadlinePast = !!org.orderDeadline && orderClosesAtMs_(org) < Date.now();
  const ordersBlocked = deadlinePast && org.allowOrdersAfterDeadline === false;

  // The shop's fundraiser (migrations/0110), as the catalog words it ("$2.00 of every item supports …"); only sent when
  // the shop chose to show it. The shop typed the label, so it's escaped like any other shop text.
  const fundraiserText = org.fundraiser && typeof org.fundraiser.text === "string" ? org.fundraiser.text.trim() : "";
  const fundraiserHtml = fundraiserText ? `<p class="desc fundraiser-line" style="margin-top:8px;">${escapeHtml(fundraiserText)}</p>` : "";

  app.innerHTML = `
    <div class="org-hero" style="${orgAccentVars(org.accent)}">
      <div class="org-eyebrow-lg">${escapeHtml(org.eyebrow)}</div>
      <h1>${escapeHtml(org.name)}</h1>
      <div class="stitch stitch-thick"></div>
      <p class="desc">${escapeHtml(org.desc)}</p>
      ${fundraiserHtml}
      ${giftSellOn_(org) ? `<p class="gift-buy-row"><button type="button" class="gift-buy-btn" data-action="giftbuy-open">Gift cards</button></p>` : ""}
    </div>
    ${previewHtml}
    ${bannerHtml}
    ${ordersBlocked ? "" : `
    <div class="layout" style="${orgAccentVars(org.accent)}">
      <div class="catalog" id="catalogArea">
        ${catNavHtml}
        ${sectionsHtml}
      </div>
      <div class="ticket" id="ticketPanel"></div>
    </div>
    <button type="button" class="cart-bar" id="cartBar" data-action="view-cart" hidden></button>`}
  `;

  if(!ordersBlocked){
    renderTicket(org, orgId);
    // Populate each configurable product's per-location option menus for the default color.
    // (Only the cards on the page: a product shown as the other version of a card isn't drawn yet.)
    (org.products || []).forEach(p => { if(p.configurable && document.getElementById("gcolor-" + p.id)) cfgRefresh_(p.id); });
  }
}

// Images to show for a product in a given garment color: the product's OWN images first, in the order
// set on the product, then the linked blank's photos for that color (migrations/0037) — the exact
// color, else the classic default (''), else any blank color. (The blank's photos are ADDED, never
// a replacement: otherwise a product's own pictures would disappear once its blank got photos.)
// A picture that is in both lists is shown once.
// What decorates a product, in words — "Embroidered: Crest — Left chest" — so a customer knows what they get and where,
// even when there's no picture of it (decorations from /api/catalog; every value escaped).
function decorationsHtml_(p){
  // A decoration whose type is switched off in Global settings isn't listed (the server leaves them out too; this covers a
  // page loaded before the switch).
  const list = ((p && p.decorations) || []).filter(d => !d.type || decorationOn_(d.type));
  if (!list.length) return "";
  return `<ul class="product-decor" aria-label="Decoration">${list.map(d => `<li><span class="decor-kind">${escapeHtml((d.type && DECORATION_MADE_LABELS_[d.type]) || d.kind || "Decorated")}:</span> ${escapeHtml(d.name)}${d.location ? ` — ${escapeHtml(d.location)}` : ""}</li>`).join("")}</ul>`;
}
function productImages_(p, color){
  const ci = p.colorImages || {};
  const key = color != null ? color : "";
  const first = Object.keys(ci)[0];
  const blank = (ci[key] && ci[key].length) ? ci[key]
    : (ci[""] && ci[""].length) ? ci[""]
    : (first && ci[first] && ci[first].length) ? ci[first] : [];
  // A product that isn't configurable shows the mockups of its printed transfers first (migrations/0068) — the
  // product as it will look. A configurable product shows its mockups in the live preview instead.
  const gi = p.graphicImages || {};
  const mock = p.configurable ? [] : (p.fixedMockups || []).map(f => gi[f.locationId + "|" + f.graphicId + "|"]).filter(Boolean);
  const out = [];
  for(const src of mock.concat(p.images || [], blank)) if(src && !out.includes(src)) out.push(src);
  return out;
}
function imageRowHtml_(p, imgs){
  return (imgs && imgs.length)
    ? `<div class="product-images">${imgs.map(src => `<a class="zoom-link" href="${escapeHtml(src)}"><img src="${escapeHtml(thumbUrl(src))}" alt="${escapeHtml(p.name)}" loading="lazy"></a>`).join("")}</div>`
    : "";
}
// Personalization is opt-in per product. null/absent price = not offered for this item. A product with a
// preset word list (personalizationOptions, e.g. a cap's closure words) gets a dropdown, otherwise a free
// text box for the name. Shared by plain and configurable products; the change handler shows/hides the field.
function personalizeHtml_(p){
  const persPrice = (p.personalizationPrice != null) ? p.personalizationPrice : null;
  if(persPrice == null || !productEmbroidered_(p)) return "";   // typed names are embroidered
  const persOptions = (p.personalizationOptions && p.personalizationOptions.length) ? p.personalizationOptions : null;
  const persInput = persOptions
    ? `<select id="pers-name-${p.id}" aria-label="Personalization option for ${escapeHtml(p.name)}" style="margin-top:8px; width:100%; display:none;">
        <option value="">— choose an option —</option>
        ${persOptions.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("")}
       </select>`
    : `<input type="text" id="pers-name-${p.id}" placeholder="Name to embroider" aria-label="Name to embroider on ${escapeHtml(p.name)}" maxlength="60" style="margin-top:8px; width:100%; display:none;" />`;
  return `
    <label class="personalize-row">
      <input type="checkbox" id="pers-${p.id}" data-pid="${p.id}"> Add personalization (+$${persPrice.toFixed(2)})
    </label>
    ${persInput}
  `;
}
// ---- Versions of a product (migrations/0059): short / long sleeve, or any two named versions --------
// Products sharing a versionGroup are separate products (own sizes and prices, colors, images, overlay
// mockups) shown as ONE card with a toggle. The card is the shown version's own renderProductRow, with
// the toggle row put at its top, so every id on it stays that product's. Switching redraws the card as
// the other version, keeping the color, size and quantity when that version has them.
const _versionGroups_ = {};   // group → product ids on this page, in order
function productCartName_(p){ return p && p.versionGroup && p.versionLabel ? `${p.name} (${p.versionLabel})` : (p ? p.name : ""); }
function versionCardsHtml_(products, org){
  const out = [], seen = new Set();
  for(const p of products){
    if(!p.versionGroup){ out.push(renderProductRow(p, org)); continue; }
    if(seen.has(p.versionGroup)) continue;
    seen.add(p.versionGroup);
    const members = products.filter(x => x.versionGroup === p.versionGroup);
    if(members.length < 2){ out.push(renderProductRow(p, org)); continue; }
    _versionGroups_[p.versionGroup] = members.map(x => x.id);
    out.push(versionCardHtml_(p.versionGroup, p.id, org));
  }
  return out.join("");
}
function versionCardHtml_(group, activeId, org){
  const members = (_versionGroups_[group] || []).map(id => activeCatalog.products.find(x => x.id === id)).filter(Boolean);
  const active = members.find(x => x.id === activeId) || members[0];
  const toggle = `<div class="version-toggle cfg-swatches" role="radiogroup" aria-label="Version">${members.map(m =>
    `<button type="button" class="cfg-swatch${m.id === active.id ? " sel" : ""}" role="radio" aria-checked="${m.id === active.id}" data-vgroup="${escapeHtml(group)}" data-vpid="${escapeHtml(m.id)}" data-action="version">${escapeHtml(m.versionLabel || m.name)}</button>`).join("")}</div>`;
  return renderProductRow(active, org).replace('<div class="product">', `<div class="product" data-vgroup="${escapeHtml(group)}" data-vactive="${escapeHtml(active.id)}">${toggle}`);
}
function versionSwitch_(group, pid){
  const card = [...document.querySelectorAll(".product[data-vgroup]")].find(el => el.dataset.vgroup === group);
  if(!card || card.dataset.vactive === pid) return;
  const was = card.dataset.vactive;
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : ""; };
  const keep = { color: val("gcolor-" + was), size: val("size-" + was), qty: val("qty-" + was) };
  card.outerHTML = versionCardHtml_(group, pid, currentOrg);
  const p = activeCatalog.products.find(x => x.id === pid);
  if(!p) return;
  const sizeEl = document.getElementById("size-" + pid);
  if(sizeEl && keep.size && [...sizeEl.options].some(o => o.value === keep.size)) sizeEl.value = keep.size;
  const qtyEl = document.getElementById("qty-" + pid);
  if(qtyEl && keep.qty) qtyEl.value = keep.qty;
  if(p.configurable){
    const sw = [...document.querySelectorAll("#gcolorwrap-" + pid + " .cfg-swatch")].find(b => b.dataset.color === keep.color);
    if(sw) cfgPickColor_(pid, sw); else cfgRefresh_(pid);
  } else if(typeof updateProductPrice === "function") updateProductPrice(pid);
  const btn = [...document.querySelectorAll('.version-toggle button')].find(b => b.dataset.vgroup === group && b.dataset.vpid === pid);
  if(btn) btn.focus();
  if(typeof announceStatus === "function") announceStatus(productCartName_(p));
}

function renderProductRow(p, org){
  if(p.configurable) return renderConfigurableProduct(p, org);
  // Not every garment supports the full XS–4XL range — restrict the dropdown
  // to whatever sizePricing actually has, in SIZE_ORDER's order, so an
  // unpriced size can never be selected.
  const isSized = productIsSized_(p);
  const sizeChoices = isSized ? productSizes_(p.sizePricing) : [];
  const defaultSize = sizeChoices[0];
  // A design the customer must upload (migrations/0054) is part of the price from the start.
  const requiredAddOn = p.customDesign && p.customDesign.required ? customDesignAddOnCents_(p) / 100 : 0;
  // Sizes priced differently: "from" the lowest until a size is picked (updateProductPrice then shows that size's).
  const sizePrices = isSized ? sizeChoices.map(s => Number(p.sizePricing[s])).filter(Number.isFinite) : [];
  const pricesVary = sizePrices.length > 1 && Math.min(...sizePrices) !== Math.max(...sizePrices);
  const priceLabel = !isSized
    ? `$${(Number(p.flatPrice || 0) + requiredAddOn).toFixed(2)}`
    : pricesVary ? `from $${(Math.min(...sizePrices) + requiredAddOn).toFixed(2)}`
    : `$${((priceFor(p, defaultSize) || Math.min(...Object.values(p.sizePricing))) + requiredAddOn).toFixed(2)}`;

  const sizeOptions = isSized
    ? `<select id="size-${p.id}" aria-label="Size for ${escapeHtml(p.name)}" data-pid="${p.id}">${sizeChoices.map(s=>`<option value="${s}">${s}</option>`).join("")}</select>`
    : p.digital ? `<span class="stock-badge">Instant download</span>`
    : `<span class="mono" style="font-size:13px; color:var(--ink-soft);">One size fits all</span>`;

  // Stock badge for the current size: finished "N in stock", else "N ready to decorate" (readyBadgeHtml_).
  const initialSize = isSized ? defaultSize : "";
  const stockEl = (p.stock || p.blankStock)
    ? `<span id="stock-${p.id}" class="stock-badge-wrap">${readyBadgeHtml_(p, "", initialSize)}</span>`
    : "";

  const featureList = (p.features && p.features.length)
    ? `<ul class="feature-list">${p.features.map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`
    : "";

  const imageRow = (productImages_(p).length)
    ? `<div class="product-images">${productImages_(p).map(src => `<a class="zoom-link" href="${escapeHtml(src)}"><img src="${escapeHtml(thumbUrl(src))}" alt="${escapeHtml(p.name)} — click to view full size" loading="lazy"></a>`).join("")}</div>`
    : "";

  const personalizeRow = personalizeHtml_(p);

  return `
    <div class="product">
      <div class="product-head">
        <h3>${escapeHtml(p.name)}</h3>
        <div class="product-price" id="price-${p.id}">${priceLabel}</div>
      </div>
      <div class="product-desc">${escapeHtml(p.sub)}</div>
      ${decorationsHtml_(p)}
      ${imageRow}
      ${featureList}
      ${qtyBreaksHtml_(p)}
      ${isSized ? `<div class="product-controls">${sizeOptions}</div>` : ""}
      ${personalizeRow}
      ${plainCustomDesignHtml_(p)}
      <div class="product-controls">
        ${isSized ? "" : sizeOptions}
        <input class="qty-input" type="number" min="1" max="50" step="1" inputmode="numeric" id="qty-${p.id}" value="1" aria-label="Quantity for ${escapeHtml(p.name)}">
        <button class="add-btn" data-action="add" data-pid="${p.id}">Add to cart</button>
      </div>
      ${stockEl}
      <div class="card-msg" id="cmsg-${p.id}" role="alert" hidden></div>
    </div>
  `;
}

// Configurable products (migrations/0036): per-location graphic options, tier add-ons, live preview.
function cfgGraphics_(org){ return (org && org.graphics) || (activeCatalog && activeCatalog.graphics) || []; }
function cfgOptionsForLocation_(p, org, loc, color){
  const byId = {}; cfgGraphics_(org).forEach(g => { byId[g.id] = g; });
  return (loc.graphicIds || []).map(id => byId[id]).filter(Boolean)
    .filter(g => !g.decoration || decorationOn_(g.decoration))   // its decoration type is switched off in Global settings
    .filter(g => (!g.allowedLocations || !g.allowedLocations.length || g.allowedLocations.includes(loc.key)))
    .filter(g => (!g.allowedGarmentColors || !g.allowedGarmentColors.length || !color || g.allowedGarmentColors.includes(color)))
    .filter(g => !(color && (p.blockedGraphicColors || []).some(b => Number(b.graphicId) === g.id && b.color === color)));   // this product doesn't offer it on this color
}
// The combination key finished stock of a product with choices is kept under (migrations/0080): the garment color +
// [location, graphicId, ink] per pick, in location order. db.js's stockVariantKey builds the same string — keep them
// equal (test178). A graphic with inks and none picked counts as its first ink, as the order does. null = the
// customer's own design (never from stock).
function stockVariantKey_(color, picks){
  if((picks || []).some(x => x.custom)) return null;
  const list = (picks || []).filter(x => x.graphic && Number(x.graphic.id))
    .map(x => [String(x.location), Number(x.graphic.id), String(x.ink || ((x.graphic.inkColors || [])[0]) || "")])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const c = String(color || "");
  return !c && !list.length ? "" : JSON.stringify([c, list]);
}
// The stock badge for a product in a color + size: pieces already decorated ("N in stock", finished stock —
// p.stock, keyed by size; a product with choices: p.stockVariants, by the picks' combination `key`, then size) win;
// else the linked blank's free stock ("N ready to decorate" — p.blankStock, keyed by color then size; a plain
// product's color and a flat product's size are ""). Nothing at 0.
function readyBadgeHtml_(p, color, size, key){
  const done = key ? Number(((p && p.stockVariants && p.stockVariants[key]) || {})[size || ""] || 0)
    : p && p.stock ? Number(p.stock[size] || 0) : 0;
  if(done > 0) return `<span class="stock-badge">${done} in stock</span>`;
  const bySize = p && p.blankStock ? (p.blankStock[color || ""] || {}) : {};
  const ready = Number(bySize[size || ""] || 0);
  return ready > 0 ? `<span class="ready-badge">Ships faster — in stock</span>` : "";
}
function renderConfigurableProduct(p, org){
  const isSized = productIsSized_(p);
  const sizeChoices = isSized ? productSizes_(p.sizePricing) : [];
  const colors = p.garmentColors || [];
  const base = cfgBasePrice_(p, colors[0] || "", sizeChoices[0] || "");
  const swatches = colors.length
    ? `<div class="cfg-swatches" id="gcolorwrap-${p.id}" role="group" aria-label="Garment color">${colors.map((c, i) => `<button type="button" class="cfg-swatch${i === 0 ? " sel" : ""}" aria-pressed="${i === 0}" data-pid="${p.id}" data-color="${escapeHtml(c)}" data-action="color">${escapeHtml(c)}</button>`).join("")}</div><input type="hidden" id="gcolor-${p.id}" value="${escapeHtml(colors[0] || "")}">`
    : `<input type="hidden" id="gcolor-${p.id}" value="">`;
  const sizeOptions = isSized
    ? `<select id="size-${p.id}" aria-label="Size for ${escapeHtml(p.name)}" data-pid="${p.id}">${sizeChoices.map(s => `<option value="${s}">${s}</option>`).join("")}</select>`
    : `<span class="mono" style="font-size:13px;color:var(--ink-soft);">One size fits all</span>`;
  const locBlocks = (p.locations || []).map(loc => `
    <div class="cfg-loc" data-key="${escapeHtml(loc.key)}">
      <label class="cfg-loc-label">${escapeHtml(loc.label || loc.key)}
        <select id="loc-${p.id}-${escapeHtml(loc.key)}" data-pid="${p.id}" class="cfg-loc-select"></select>
      </label>
      <select id="ink-${p.id}-${escapeHtml(loc.key)}" data-pid="${p.id}" class="cfg-ink-select" aria-label="Thread color for ${escapeHtml(loc.label || loc.key)}" style="display:none;margin-top:4px;"></select>
      ${p.customDesign ? customDesignHtml_(p, loc.key, true) : ""}
    </div>`).join("");
  // Swapped per garment color by cfgImages_ (migrations/0037): the selected color's blank images.
  const imageRow = `<div id="cfgimg-${p.id}">${imageRowHtml_(p, productImages_(p, colors[0] || ""))}</div>`;
  const featureList = (p.features && p.features.length)
    ? `<ul class="feature-list">${p.features.map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`
    : "";
  return `
    <div class="product">
      <div class="product-head">
        <h3>${escapeHtml(p.name)}</h3>
        <div class="product-price" id="price-${p.id}">$${base.toFixed(2)}</div>
      </div>
      <div class="product-desc">${escapeHtml(p.sub)}</div>
      ${decorationsHtml_(p)}
      ${imageRow}
      ${featureList}
      ${qtyBreaksHtml_(p)}
      ${colors.length ? `<div class="cfg-field-label">Garment color</div>${swatches}` : swatches}
      ${(p.colorGroups || []).length ? `<div class="cfg-color-note" style="font-size:12px;color:var(--ink-soft);margin-top:4px;">Some colors are priced differently — the price follows the color you pick.</div>` : ""}
      ${(p.locations || []).length ? `<div class="cfg-field-label" style="margin-top:8px;">Designs</div>` : ""}
      <div class="cfg-locs">${locBlocks}</div>
      ${personalizeHtml_(p)}
      <div class="cfg-preview" id="cpreview-${p.id}"></div>
      <div class="cfg-breakdown" id="cbd-${p.id}"></div>
      <div class="product-controls" style="margin-top:8px;">
        ${sizeOptions}
        <input class="qty-input" type="number" min="1" max="50" step="1" inputmode="numeric" id="qty-${p.id}" value="1" aria-label="Quantity for ${escapeHtml(p.name)}">
        <button class="add-btn" id="cadd-${p.id}" data-action="add" data-pid="${p.id}" disabled>Add to cart</button>
      </div>
      ${p.blankStock || p.stock || p.stockVariants ? `<span id="stock-${p.id}" class="stock-badge-wrap"></span>` : ""}
      <div class="card-msg" id="cmsg-${p.id}" role="alert" hidden></div>
      <div class="cfg-hint" id="chint-${p.id}" style="font-size:12px;color:var(--ink-soft);margin-top:6px;">Choose a graphic for at least one location.</div>
    </div>`;
}
// (Re)builds a configurable product's option menus for the current color, then updates preview/price.
function cfgRefresh_(pid){
  const p = activeCatalog.products.find(x => x.id === pid); if (!p || !p.configurable) return;
  const org = currentOrg;
  const color = (document.getElementById("gcolor-" + pid) || {}).value || "";
  for (const loc of (p.locations || [])) {
    const sel = document.getElementById("loc-" + pid + "-" + loc.key); if (!sel) continue;
    const prev = sel.value;
    const opts = cfgOptionsForLocation_(p, org, loc, color);
    // The customer's own design is one more choice at every location (migrations/0054).
    const custom = !!p.customDesign;
    // A product with a single graphic location has nothing to leave blank (a blank garment can't be ordered),
    // so there's no "None" and the first option is preselected; with several locations "None" stays.
    // A product with printed transfers of its own (migrations/0068) is decorated already, so None is offered.
    const onlyLoc = (p.locations || []).length === 1 && (opts.length > 0 || custom) && !p.hasFixedTransfers;
    sel.innerHTML = (onlyLoc ? "" : `<option value="">None</option>`) + opts.map(g => `<option value="${g.id}">${escapeHtml(g.name)}${g.addOnCents ? " (+$" + (g.addOnCents / 100).toFixed(2) + ")" : ""}</option>`).join("") +
      (custom ? `<option value="custom">${escapeHtml(customDesignOptionLabel_(p, loc))}</option>` : "");
    if (prev && (opts.some(g => String(g.id) === prev) || (prev === "custom" && custom))) sel.value = prev; // keep a still-valid pick
    else if (onlyLoc) sel.value = opts.length ? String(opts[0].id) : "custom";
    // Ink select for the chosen graphic (shown only when >1 ink).
    const ink = document.getElementById("ink-" + pid + "-" + loc.key);
    const g = opts.find(x => String(x.id) === sel.value);
    if (ink) {
      // Redrawn on every change, so the ink already picked is kept while the graphic still offers it.
      const prevInk = ink.value;
      if (g && g.inkColors && g.inkColors.length > 1) { ink.innerHTML = g.inkColors.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join(""); ink.style.display = ""; if (g.inkColors.includes(prevInk)) ink.value = prevInk; }
      else { ink.innerHTML = ""; ink.style.display = "none"; }
    }
  }
  cfgImages_(pid, color);
  cfgUpdate_(pid);
}
// Swaps a configurable product's photos to the selected garment color's blank images.
function cfgImages_(pid, color){
  const p = activeCatalog.products.find(x => x.id === pid); if (!p) return;
  const box = document.getElementById("cfgimg-" + pid); if (!box) return;
  box.innerHTML = imageRowHtml_(p, productImages_(p, color || ""));
}
function cfgPickColor_(pid, btn){
  document.querySelectorAll("#gcolorwrap-" + pid + " .cfg-swatch").forEach(b => { b.classList.remove("sel"); b.setAttribute("aria-pressed", "false"); });
  btn.classList.add("sel"); btn.setAttribute("aria-pressed", "true");
  const h = document.getElementById("gcolor-" + pid); if (h) h.value = btn.dataset.color;
  cfgRefresh_(pid);
}
// Reads the current picks → live preview (thumbnails badged by location) + price breakdown + Add state.
function cfgPicks_(pid){
  const p = activeCatalog.products.find(x => x.id === pid); const org = currentOrg;
  const byId = {}; cfgGraphics_(org).forEach(g => { byId[g.id] = g; });
  const color = (document.getElementById("gcolor-" + pid) || {}).value || "";
  const picks = [];
  for (const loc of (p.locations || [])) {
    const sel = document.getElementById("loc-" + pid + "-" + loc.key); if (!sel || !sel.value) continue;
    if (sel.value === "custom" && p.customDesign) {
      // The customer's own design: a stand-in graphic, so the price and preview code treat it like any other.
      const up = customDesignUploads_[pid + "|" + loc.key] || null;
      const preview = up && up.status === "done" ? up.previewUrl : "";
      picks.push({ location: loc.key, locationId: loc.locationId || null, label: loc.label || loc.key, custom: true, upload: up,
        graphic: { id: "custom", name: "Your own design", addOnCents: customDesignAddOnCents_(p, loc), imageUrl: preview, thumbUrl: preview }, ink: "" });
      continue;
    }
    const g = byId[Number(sel.value)]; if (!g) continue;
    const inkEl = document.getElementById("ink-" + pid + "-" + loc.key);
    const ink = inkEl && inkEl.style.display !== "none" ? inkEl.value : (g.inkColors && g.inkColors.length === 1 ? g.inkColors[0] : "");
    picks.push({ location: loc.key, locationId: loc.locationId || null, label: loc.label || loc.key, graphic: g, ink });
  }
  return { color, picks };
}
function cfgUpdate_(pid){
  const p = activeCatalog.products.find(x => x.id === pid); if (!p) return;
  const isSized = productIsSized_(p);
  const sizeEl = document.getElementById("size-" + pid);
  const { color, picks } = cfgPicks_(pid);
  const base = cfgBasePrice_(p, color, isSized && sizeEl ? sizeEl.value : "");
  const group = colorGroupOf_(p, color);
  const addOns = picks.reduce((s, x) => s + (x.graphic.addOnCents || 0), 0) / 100;
  const persEl = document.getElementById("pers-" + pid);
  const persFee = (persEl && persEl.checked && p.personalizationPrice != null) ? p.personalizationPrice : 0;
  const total = base + addOns + persFee;
  const priceEl = document.getElementById("price-" + pid); if (priceEl) priceEl.textContent = "$" + total.toFixed(2);
  const stockWrap = document.getElementById("stock-" + pid);
  if (stockWrap) stockWrap.innerHTML = readyBadgeHtml_(p, color, isSized && sizeEl ? sizeEl.value : "", stockVariantKey_(color, picks));
  const bd = document.getElementById("cbd-" + pid);
  if (bd) bd.innerHTML = `<div class="cfg-bd-row"><span>Garment${group ? " (" + escapeHtml(color) + ")" : ""}</span><span>$${base.toFixed(2)}</span></div>` +
    picks.map(x => `<div class="cfg-bd-row"><span>${escapeHtml(x.label)}: ${escapeHtml(x.graphic.name)}${x.ink ? " (" + escapeHtml(x.ink) + ")" : ""}</span><span>${x.graphic.addOnCents ? "+$" + (x.graphic.addOnCents / 100).toFixed(2) : "Included"}</span></div>`).join("") +
    (persFee ? `<div class="cfg-bd-row"><span>Personalization</span><span>+$${persFee.toFixed(2)}</span></div>` : "");
  // One preview image per location: the composed mockup (the graphic ON the garment in this color,
  // migrations/0042) when one exists for this color+location+graphic, else the graphic's own image.
  const mockups = p.graphicImages || {};
  const prev = document.getElementById("cpreview-" + pid);
  if (prev) prev.innerHTML = picks.map(x => {
    const mockup = x.locationId ? mockups[x.locationId + "|" + x.graphic.id + "|" + color] : null;
    // full = the image opened full-size on click; thumb = the small preview (the thumbnail variant).
    const full = mockup || x.graphic.imageUrl || x.graphic.thumbUrl;
    const thumb = mockup ? thumbUrl(mockup) : (x.graphic.thumbUrl || x.graphic.imageUrl);
    if (!full) return "";
    return `<div class="cfg-prev-item${mockup ? " cfg-prev-mockup" : ""}"><a class="zoom-link" href="${escapeHtml(full)}" title="View full size"><img src="${escapeHtml(thumb)}" alt="${escapeHtml(x.graphic.name)}" loading="lazy"></a><span class="cfg-prev-badge">${escapeHtml(x.label)}</span></div>`;
  }).filter(Boolean).join("") +
    // …then the product's printed transfers (migrations/0068), always on it: their mockup for this color, if made.
    (p.fixedMockups || []).map(f => { const m = mockups[f.locationId + "|" + f.graphicId + "|" + color]; if (!m) return "";
      return `<div class="cfg-prev-item cfg-prev-mockup"><a class="zoom-link" href="${escapeHtml(m)}" title="View full size"><img src="${escapeHtml(thumbUrl(m))}" alt="${escapeHtml(f.label || "Printed design")}" loading="lazy"></a><span class="cfg-prev-badge">${escapeHtml(f.label || "Printed")}</span></div>`; }).join("");
  // The upload box shows under each location set to Custom; Add waits until every one has finished.
  for (const loc of (p.locations || [])) {
    const box = document.getElementById(customDesignBoxId_(pid, loc.key));
    if (box) box.hidden = !picks.some(x => x.custom && x.location === loc.key);
  }
  const waiting = picks.filter(x => x.custom && !(x.upload && x.upload.status === "done"));
  const add = document.getElementById("cadd-" + pid), hint = document.getElementById("chint-" + pid);
  // Printed transfers (0067) decorate it already; a product offering no options at all (colors only) needs no pick.
  const nonePicked = picks.length === 0 && !p.hasFixedTransfers && (p.locations || []).length > 0;
  if (add) add.disabled = nonePicked || waiting.length > 0;
  if (hint) {
    hint.textContent = nonePicked ? "Choose a graphic for at least one location."
      : waiting.some(x => x.upload && x.upload.status === "uploading") ? "Your design is uploading…" : "Upload your design to add this to your cart.";
    hint.style.display = nonePicked || waiting.length ? "" : "none";
  }
}

// ---- The customer's own design (migrations/0054) ----------------------------------------------
// A product set to take it shows an upload box: under an ordinary product (required when the product
// has no design of its own, else "Use my own design instead"), or under each location of a
// configurable product when "Custom — upload your own" is picked. The image is checked here, then
// uploaded to /api/customer-design, which checks it again and returns an id the cart line carries.
// Uploads are kept per product + location (pid|loc) while the page is open, so the same image can go
// on another size; the preview is an object URL of the chosen file.
const CUSTOM_DESIGN_LIMITS = { types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 10 * 1024 * 1024, minLongSide: 500, maxSide: 10000, softTransferSide: 1500 };
const customDesignUploads_ = {};   // "pid|loc" → {status: "uploading"|"done"|"error", uploadId, file, fileName, previewUrl, width, height, message, warning}
const CUSTOM_PLAIN_LOC = "customdesign";
// The add-on: a configurable location's own (customDesignPriceCents), else the product's (null = free).
function customDesignAddOnCents_(p, loc){
  if(loc && loc.customDesignPriceCents != null && Number.isFinite(Number(loc.customDesignPriceCents))) return Math.max(0, Number(loc.customDesignPriceCents));
  const c = p && p.customDesign; return c && c.price != null ? Math.round(Number(c.price) * 100) || 0 : 0;
}
function customDesignPriceText_(p, loc){ const c = customDesignAddOnCents_(p, loc); return c ? "+$" + (c / 100).toFixed(2) : ""; }
function customDesignOptionLabel_(p, loc){ const t = customDesignPriceText_(p, loc); return "Custom — upload your own" + (t ? " (" + t + ")" : ""); }
function customDesignBoxId_(pid, loc){ return "cd-" + pid + "-" + loc; }
// The upload box. `hidden` = drawn hidden (a configurable location until Custom is picked).
function customDesignHtml_(p, locKey, hidden){
  const st = customDesignUploads_[p.id + "|" + locKey] || null;
  const transfer = p.customDesign && p.customDesign.kind === "transfer";
  const hint = (transfer || printedDecoration_(p)) ? "Printed from your image — a sharp image about 3000 px across prints best at 10 inches."
    : "A clear logo with solid colors works best — we'll email you a proof.";
  const head = locKey === CUSTOM_PLAIN_LOC ? "" : `<div class="cd-head">Your design</div>`;
  return `<div class="cd-box" id="${customDesignBoxId_(p.id, locKey)}" data-cd-pid="${escapeHtml(p.id)}" data-cd-loc="${escapeHtml(locKey)}"${hidden ? " hidden" : ""}>
      ${head}
      <input type="file" class="cd-file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif,application/pdf,.pdf,image/svg+xml,.svg" aria-label="Upload your design for ${escapeHtml(p.name)}">
      <div class="cd-rules">PNG, JPG or WebP (an iPhone or iPad photo is fine) · up to 10 MB · at least 500 px on the long side.</div>
      <div class="cd-hint">${escapeHtml(hint)}</div>
      <div class="cd-status${st && st.status === "error" ? " cd-err" : st && st.warning ? " cd-warn" : ""}" role="alert">${escapeHtml(customDesignStatusText_(st))}</div>
      <div class="cd-preview">${st && st.status === "done" && st.previewUrl ? `<a class="zoom-link" href="${escapeHtml(st.previewUrl)}" title="View full size"><img src="${escapeHtml(st.previewUrl)}" alt="Your design — click to view full size"></a>` : ""}</div>
      <div class="cd-ts"></div>
    </div>`;
}
function customDesignStatusText_(st){
  if(!st) return "";
  if(st.status === "uploading") return "Uploading " + st.fileName + "…";
  if(st.status === "error") return st.message || "That upload didn't work — please try again.";
  return "Uploaded: " + st.fileName + " (" + st.width + " × " + st.height + " px)" + (st.warning ? " — " + st.warning : "");
}
// An ordinary product: the required box, or the "Use my own design instead" switch and its box.
function plainCustomDesignHtml_(p){
  const c = p.customDesign; if(!c) return "";
  const price = customDesignPriceText_(p);
  if(c.required) return `<div class="cd-head" style="margin-top:12px;">Your design (required)${price ? " " + price : ""}</div>${customDesignHtml_(p, CUSTOM_PLAIN_LOC, false)}`;
  const on = !!customDesignUploads_[p.id + "|" + CUSTOM_PLAIN_LOC];
  return `<label class="personalize-row"><input type="checkbox" id="cdon-${escapeHtml(p.id)}" data-pid="${escapeHtml(p.id)}"${on ? " checked" : ""}> Use my own design instead${price ? " (" + price + ")" : ""}</label>
    ${customDesignHtml_(p, CUSTOM_PLAIN_LOC, !on)}`;
}
// Is an ordinary product's own-design box in use? (Required, or the switch is on.)
function plainCustomOn_(p){
  if(!p || !p.customDesign || p.configurable) return false;
  if(p.customDesign.required) return true;
  const el = document.getElementById("cdon-" + p.id);
  return !!(el && el.checked);
}
// Redraws a box from its upload's state (the page may have been redrawn while it uploaded).
function customDesignRedraw_(pid, loc){
  const p = activeCatalog && activeCatalog.products.find(x => x.id === pid);
  const box = document.getElementById(customDesignBoxId_(pid, loc));
  if(!p || !box) return;
  const st = customDesignUploads_[pid + "|" + loc] || null;
  const status = box.querySelector(".cd-status");
  status.textContent = customDesignStatusText_(st);
  status.className = "cd-status" + (st && st.status === "error" ? " cd-err" : st && st.warning ? " cd-warn" : "");
  box.querySelector(".cd-preview").innerHTML = st && st.status === "done" && st.previewUrl
    ? `<a class="zoom-link" href="${escapeHtml(st.previewUrl)}" title="View full size"><img src="${escapeHtml(st.previewUrl)}" alt="Your design — click to view full size"></a>` : "";
  if(p.configurable) cfgUpdate_(pid); else updateProductPrice(pid);
}
async function handleCustomDesignFile_(input){
  const box = input.closest(".cd-box"); if(!box) return;
  const pid = box.dataset.cdPid, loc = box.dataset.cdLoc, key = pid + "|" + loc;
  const p = activeCatalog && activeCatalog.products.find(x => x.id === pid);
  let file = input.files && input.files[0];
  if(!p || !p.customDesign || !file) return;
  const old = customDesignUploads_[key];
  const fail = (message) => {
    if(old && old.previewUrl) URL.revokeObjectURL(old.previewUrl);
    customDesignUploads_[key] = { status: "error", message, fileName: file.name };
    input.value = "";
    customDesignRedraw_(pid, loc);
  };
  const L = CUSTOM_DESIGN_LIMITS;
  // A PDF or SVG can be picked (an iPad won't let a file the box doesn't list be chosen at all, which
  // looks broken), but the print and the digitizing need a picture: say how to get one.
  if(/pdf|svg|postscript|illustrator/i.test(file.type) || /\.(pdf|svg|ai|eps)$/i.test(file.name || ""))
    return fail("We need a picture of your design — a PNG or JPG. Export it from your design app as a PNG (or take a screenshot of it) and choose that.");
  if(isHeicFile_(file)){ try{ file = await heicToJpeg_(file); }catch(e){ return fail(e.message); } }
  if(!L.types.includes(file.type)) return fail("Please choose a PNG, JPG or WebP image.");
  if(file.size > L.maxBytes) return fail("That image is too large — the limit is 10 MB.");
  if(!file.size) return fail("That file is empty.");
  let width = 0, height = 0;
  if(typeof window.createImageBitmap === "function"){
    try{ const bmp = await createImageBitmap(file); width = bmp.width; height = bmp.height; if(bmp.close) bmp.close(); }
    catch(e){ return fail("We couldn't read that image — please save it as a PNG or JPG and try again."); }
    if(Math.max(width, height) < L.minLongSide) return fail(`That image is too small to reproduce (${width} × ${height} px) — please use one at least ${L.minLongSide} px on the long side.`);
    if(width > L.maxSide || height > L.maxSide) return fail(`That image is too large (${width} × ${height} px) — please use one at most 10,000 px on each side.`);
  }
  if(old && old.previewUrl) URL.revokeObjectURL(old.previewUrl);
  const st = { status: "uploading", file, fileName: file.name, previewUrl: "" };
  customDesignUploads_[key] = st;
  customDesignRedraw_(pid, loc);
  try{
    const token = await getTurnstileToken(box.querySelector(".cd-ts"));
    const headers = { "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name.slice(0, 200)) };
    if(token) headers["X-Turnstile-Token"] = token;
    const res = await fetch("/api/customer-design?product=" + encodeURIComponent(pid), { method: "POST", headers, body: file });
    const data = await res.json().catch(() => null);
    if(customDesignUploads_[key] !== st) return;   // another file was chosen meanwhile
    if(!res.ok || !data || data.status !== "ok") return fail((data && data.message) || "That upload didn't work — please try again.");
    Object.assign(st, { status: "done", uploadId: data.uploadId, width: data.width, height: data.height, previewUrl: URL.createObjectURL(file),
      warning: printedDecoration_(p) && Math.max(data.width, data.height) < L.softTransferSide ? "it may print soft — about 3000 px is best for a 10-inch print." : "" });
    const box2 = document.getElementById(customDesignBoxId_(pid, loc)); const ts = box2 && box2.querySelector(".cd-ts"); if(ts) ts.innerHTML = "";
    customDesignRedraw_(pid, loc);
  }catch(e){
    if(customDesignUploads_[key] === st) fail((e && e.message) || "That upload didn't work — please try again.");
  }
}
// A cart line's own copies of its design previews (object URLs), so removing the line can free them
// without touching the product card's preview.
function cartDesignPreviews_(pid, locs, labelOf){
  return locs.map(loc => { const st = customDesignUploads_[pid + "|" + loc];
    return st && st.file ? { label: labelOf(loc), fileName: st.fileName, url: URL.createObjectURL(st.file) } : null; }).filter(Boolean);
}
function revokeCartPreviews_(lines){
  for(const c of lines || []) for(const d of (c.cdPreviews || [])) if(d.url) URL.revokeObjectURL(d.url);
}
function clearCart_(){ revokeCartPreviews_(cart); cart = []; }
// The cart survives a refresh, a back-swipe and the trip to Stripe: kept in sessionStorage per shop (this tab
// only). A design preview is this page's own object URL, so a restored line keeps the file name, not the picture.
// A line whose product is gone is dropped; the server prices every line again when the order is placed.
function cartKey_(){ return currentOrg && !currentOrg.preview ? "cart:" + currentOrg.orgId : ""; }
function saveCart_(){
  const k = cartKey_(); if(!k) return;
  try{ sessionStorage.setItem(k, JSON.stringify(cart.map(c => c.cdPreviews ? Object.assign({}, c, { cdPreviews: c.cdPreviews.map(({ url, ...d }) => d) }) : c))); }catch(_){}
}
function restoreCart_(){
  const k = cartKey_(); if(!k) return;
  let saved = null;
  try{ saved = JSON.parse(sessionStorage.getItem(k) || "null"); }catch(_){}
  if(!Array.isArray(saved)) return;
  const ids = new Set((currentOrg.products || []).map(p => p.id));
  cart = saved.filter(c => c && ids.has(c.productId) && Number.isInteger(c.qty) && c.qty >= 1 && c.qty <= 50 && Number.isFinite(Number(c.lineTotal))).slice(0, 20);
  // The shop's breaks may have changed since: the kept lines are priced by today's.
  cartReprice_();
}
// One cart line's price per piece (personalization included, after any quantity break) — what the +/− steppers multiply.
function cartUnit_(c){ return Number(c.unitPrice || 0) + Number(c.personalizationFee || 0); }

// ---- Quantity breaks (migrations/0109) ----
// A product's breaks come with the catalog as [{ minQty, off }] (dollars, fewest pieces first): from minQty pieces of
// that product in one order, every piece of it costs `off` less — the deepest break reached. Pieces count across all of
// the product's lines (sizes, colors, designs), never across products. The server prices the order the same way
// (priceItem with breakQty); the cart only mirrors it, so what it shows is what the order comes to.
function qtyBreaksOf_(p){ return (p && Array.isArray(p.qtyBreaks)) ? p.qtyBreaks.filter(b => b && Number(b.minQty) >= 2 && Number(b.off) > 0) : []; }
function qtyBreakFor_(p, pieces){
  let hit = null;
  for(const b of qtyBreaksOf_(p)) if(pieces >= Number(b.minQty) && (!hit || Number(b.minQty) > Number(hit.minQty))) hit = b;
  return hit;
}
function cartPiecesByProduct_(){
  const m = new Map();
  for(const c of cart) m.set(c.productId, (m.get(c.productId) || 0) + (Number(c.qty) || 0));
  return m;
}
function cartProducts_(){ return (currentOrg && currentOrg.products) || (activeCatalog && activeCatalog.products) || []; }
// Sets every line's unitPrice (after the break), breakOff and lineTotal from its listUnitPrice (before the break), in
// cents so the totals add up as the server's do. The break comes off the product's base price only — never below zero,
// and never off personalization or add-ons (a design, a graphic's tier) — so a line keeps its basePrice. A line kept
// from before breaks existed has neither: its unitPrice is its list price.
function cartReprice_(){
  const pieces = cartPiecesByProduct_(), products = cartProducts_();
  for(const c of cart){
    if(c.listUnitPrice == null) c.listUnitPrice = Number(c.unitPrice || 0);
    const listCents = Math.round(Number(c.listUnitPrice) * 100);
    const baseCents = c.basePrice != null ? Math.round(Number(c.basePrice) * 100) : listCents;
    const b = qtyBreakFor_(products.find(p => p.id === c.productId), pieces.get(c.productId) || 0);
    const offCents = b ? Math.max(0, Math.min(Math.round(Number(b.off) * 100), baseCents, listCents)) : 0;
    c.breakOff = offCents / 100;
    c.breakMin = b ? Number(b.minQty) : 0;
    c.unitPrice = (listCents - offCents) / 100;
    c.lineTotal = ((listCents - offCents) + Math.round(Number(c.personalizationFee || 0) * 100)) * (Number(c.qty) || 0) / 100;
  }
}
// The break table on a product card: "12+ pieces: $2.00 off each". Empty for a product without breaks.
function qtyBreaksHtml_(p){
  const list = qtyBreaksOf_(p);
  if(!list.length) return "";
  const rows = list.map(b => `<tr><th scope="row" style="text-align:left;font-weight:600;padding:2px 12px 2px 0;">${Number(b.minQty)}+ pieces</th><td style="padding:2px 0;">$${Number(b.off).toFixed(2)} off each</td></tr>`).join("");
  return `<table class="qty-breaks" style="font-size:13px;margin:8px 0 2px;border-collapse:collapse;">
      <caption style="text-align:left;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-soft);padding-bottom:2px;">Quantity pricing</caption>
      <tbody>${rows}</tbody></table>
    <div class="qty-breaks-note" style="font-size:12px;color:var(--ink-soft);margin-bottom:8px;">Counts every size${p.configurable ? ", color and design" : ""} of this item in your order.</div>`;
}
// Under a cart line: the next break this product could reach ("Add 3 more … for $2.00 off each"), on its last line only.
function cartNextBreakHtml_(c, idx, pieces){
  if(idx !== cart.map(x => x.productId).lastIndexOf(c.productId)) return "";
  const have = pieces.get(c.productId) || 0;
  const next = qtyBreaksOf_(cartProducts_().find(p => p.id === c.productId)).find(b => Number(b.minQty) > have);
  if(!next) return "";
  return `<small class="qty-break-next">Add ${Number(next.minQty) - have} more ${escapeHtml(c.name)} for $${Number(next.off).toFixed(2)} off each.</small>`;
}
function changeCartQty_(idx, delta){
  const c = cart[idx]; if(!c) return;
  const q = c.qty + delta;
  if(q < 1){ removeFromCart(idx, currentOrgId); return; }
  if(q > 50){ checkoutMsg_ = "You can order up to 50 of an item at a time. For more, please contact the shop."; renderTicket(currentOrg, currentOrgId); return; }
  c.qty = q; cartReprice_();
  checkoutMsg_ = "";
  renderTicket(currentOrg, currentOrgId);
  scheduleShippingUpdate();
  announceStatus(c.name + ": " + q + ". " + cartSummaryText());
}
// A card order sent to Stripe is remembered (this tab) until it's paid, so coming back with Cancel offers
// to pay that order again instead of leaving the shopper to order twice.
function pendingCardKey_(orgId){ return "pendingCard:" + orgId; }
function readPendingCard_(orgId){ try{ return JSON.parse(sessionStorage.getItem(pendingCardKey_(orgId)) || "null"); }catch(_){ return null; } }
function writePendingCard_(orgId, v){ try{ if(v) sessionStorage.setItem(pendingCardKey_(orgId), JSON.stringify(v)); else sessionStorage.removeItem(pendingCardKey_(orgId)); }catch(_){} }
let unpaidCardNotice = null;   // {orderId, token?, total?} after a cancelled card payment
function unpaidCardBannerHtml_(){
  const u = unpaidCardNotice; if(!u) return "";
  const amount = Number.isFinite(Number(u.total)) ? " ($" + Number(u.total).toFixed(2) + ")" : "";
  return `<div class="unpaid-bar" id="unpaidBar" role="alert">
    <strong>Your card payment wasn't finished.</strong> Order <span class="mono">${escapeHtml(u.orderId)}</span>${amount} is saved but not paid — you don't need to order again.
    ${u.token ? `<div><button type="button" data-action="retry-card">Pay${amount ? " $" + Number(u.total).toFixed(2) : ""} by card</button><button type="button" class="link" data-action="dismiss-unpaid">Close</button></div>` : `<div><button type="button" class="link" data-action="dismiss-unpaid">Close</button></div>`}
    <div style="font-size:13px;margin-top:6px;">To pay another way or change the order, contact the shop — your order email has the details.</div>
  </div>`;
}
async function retryCardPayment_(btn){
  const u = unpaidCardNotice; if(!u || !u.token || !currentOrg) return;
  if(btn){ btn.disabled = true; btn.textContent = "Opening checkout…"; }
  try{
    const res = await fetch("/api/checkout", { method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ orderId: u.orderId, orgId: currentOrg.orgId, checkoutToken: u.token }) });
    const data = await res.json().catch(() => ({}));
    if(data.url){ window.location.href = data.url; return; }
    showToast(data.message || "Could not start the card payment. Please contact the shop.", true);
  }catch(_){ showToast("Could not start the card payment. Check your connection and try again.", true); }
  if(btn){ btn.disabled = false; btn.textContent = "Pay by card"; }
}
// Errors shown next to the thing to fix instead of a pop-up: on a product card, and in the order panel.
let checkoutMsg_ = "";
function cardMsg_(pid, msg){
  const el = document.getElementById("cmsg-" + pid);
  if(!el){ if(msg) showToast(msg, true); return; }
  el.textContent = msg || ""; el.hidden = !msg;
}
function checkoutError_(msg, focusId){
  checkoutMsg_ = msg;
  const el = document.getElementById("checkoutMsg");
  if(el){ el.textContent = msg; el.hidden = !msg; } else if(msg) showToast(msg, true);
  const f = focusId && document.getElementById(focusId);
  if(f && f.focus) f.focus();
}
// ---- Discount codes (migrations/0115; more than one at a time: migrations/0120) ----
// The checkout's "Discount code" box, shown only when the catalog says a code could work at this shop
// (catalog.discountCodes) and the Discount codes feature is on. Apply asks the server (checkDiscountCode, with the
// email typed so far, the cart's lines and the codes already applied); the SERVER decides the discount — again when the
// order is placed — so what the cart shows is only its answer for the cart as it was then. A changed cart asks again
// (debounced). When Global settings → Discount codes allows more than one (catalog.discountRules.multiple) the box
// takes up to DISCOUNT_MAX_CODES_ of them, each with its own ×; the server says each code's share (percent codes add
// up, amount codes come off what is left), the page only adds those shares up.
let discountApplied_ = null;   // null, or a list of { code, label, discount (dollars, this code's share), freeShipping, sig (the cart it was worked out for) }
let discountInput_ = "";       // what's typed in the box, kept across the panel's redraws
let discountMsg_ = "";         // the server's refusal (or a note), shown under the box
let discountBusy_ = false, discountTimer_ = null, discountSeq_ = 0;
let discountAdding_ = false;   // more than one code allowed: the box for another code is open
const DISCOUNT_MAX_CODES_ = 5;
function discountBoxOn_(org){ return !!(org && org.discountCodes === true && featureOn_("discounts") && !org.preview); }
function discountMulti_(org){ return !!(org && org.discountRules && org.discountRules.multiple === true); }
// Takes the codes off (not the gift cards: those are a payment, kept when a code comes off).
function discountClear_(){
  discountApplied_ = null; discountInput_ = ""; discountMsg_ = ""; discountBusy_ = false; discountAdding_ = false; discountSeq_++;
  if(discountTimer_){ clearTimeout(discountTimer_); discountTimer_ = null; }
}
// Everything the checkout holds beyond the cart: the codes and the gift cards (a placed order, another shop).
function discountReset_(){ discountClear_(); giftReset_(); }
// The lines as the server prices them: a change to any of these can change the discount (a percent of the subtotal,
// an amount capped at it).
function discountCartSig_(){ return JSON.stringify(cart.map(c => [c.productId, c.size || "", c.qty, c.lineTotal])); }
// The discount the cart shows now: the server's answers added up, never more than the goods subtotal.
function discountNow_(subtotal){
  if(!discountApplied_) return 0;
  const cents = discountApplied_.reduce((s, e) => s + Math.max(0, Math.round(Number(e.discount || 0) * 100)), 0);
  return Math.min(cents, Math.round(subtotal * 100)) / 100;
}
// A code (or codes) that makes shipping free: the delivery fee shows as $0.00 and the total drops it. The server
// takes it off the order's shipping when the order is placed.
function discountFreeShipping_(){ return !!discountApplied_ && discountApplied_.some(e => e.freeShipping); }
function discountCodesOf_(pred){ return (discountApplied_ || []).filter(pred || (() => true)).map(e => e.code).join(", "); }
// A refusal that's about the email address (a code for one person): typing another address makes it stale.
function discountMsgAboutEmail_(m){ return /check the email address|Enter your email address first/i.test(String(m || "")); }
function discountMsgEl_(text){
  discountMsg_ = text || "";
  const el = document.getElementById("discountMsg");
  if(el){ el.textContent = discountMsg_; el.hidden = !discountMsg_; }
}
async function askDiscountCode_(code, others){
  const contactEl = document.getElementById("custContact");
  const res = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "checkDiscountCode", orgId: currentOrg.orgId, code, others: others || [],
      email: contactEl ? contactEl.value.trim() : "", items: cart.map(({ cdPreviews, ...line }) => line) }) });
  const data = await res.json().catch(() => null);
  if(res.ok && data && data.status === "ok") return { ok: true, data };
  // A refusal the customer can act on comes back as the server's own sentence; anything else is a passing failure.
  if(res.status === 429) return { ok: false, message: "Too many tries — please wait a minute and try again." };
  if(data && data.message && res.status < 500) return { ok: false, message: String(data.message) };
  return { ok: false, failed: true, message: "We couldn't check that code just now. Please try again." };
}
const sameCode_ = (a, b) => String(a || "").trim().toUpperCase() === String(b || "").trim().toUpperCase();
// One code's row from the server's answer. Free shipping is the code's own flag (the answer's `freeShipping`, or its
// entry in `combined.perCode`, or a "shipping" kind) — not the shipping amount, which isn't known until delivery is chosen.
function discountEntryFrom_(d, typed, sig){
  const code = String(d.code || typed.toUpperCase());
  const perList = d.combined && (Array.isArray(d.combined.perCode) ? d.combined.perCode : Array.isArray(d.combined.codes) ? d.combined.codes : null);
  const per = perList ? perList.find(p => sameCode_(p.code, code)) : null;
  const free = d.freeShipping === true || d.kind === "shipping" || !!(per && (per.freeShipping === true || Number(per.shippingOffCents) > 0));
  return { code, label: String(d.label || (free && !(Number(d.discount) > 0) ? "Free shipping" : "")), discount: Number(d.discount) || 0, freeShipping: free, sig };
}
// With several codes the answer carries the whole picture (`combined`): each code's share of the goods now, which is
// not what each was worth alone (percent codes add up, an amount code takes only what is left). Without it, the answer
// is for this code alone and the others keep their shares.
function discountApplyCombined_(list, d){
  const c = d && d.combined;
  if(!c || list.length < 2) return list;
  if(Array.isArray(c.perCode)){
    return list.map(e => {
      const per = c.perCode.find(p => sameCode_(p.code, e.code));
      if(!per) return e;
      return Object.assign({}, e, { discount: Math.max(0, Number(per.goodsOffCents) || 0) / 100,
        freeShipping: e.freeShipping || per.freeShipping === true || Number(per.shippingOffCents) > 0 });
    });
  }
  // The server's answer (orders.js codeCheckAnswer_): `combined.codes` [{ code, discount (dollars), freeShipping }].
  if(Array.isArray(c.codes)){
    return list.map(e => {
      const per = c.codes.find(p => sameCode_(p.code, e.code));
      if(!per) return e;
      return Object.assign({}, e, { discount: Math.max(0, Number(per.discount) || 0), freeShipping: e.freeShipping || per.freeShipping === true });
    });
  }
  if(typeof c.goodsOffCents === "number"){
    const others = list.slice(0, -1).reduce((s, e) => s + Math.round(e.discount * 100), 0);
    return list.map((e, i) => i === list.length - 1 ? Object.assign({}, e, { discount: Math.max(0, c.goodsOffCents - others) / 100 }) : e);
  }
  return list;
}
async function applyDiscountCode_(){
  const code = discountInput_.trim();
  if(!code){ discountMsgEl_("Enter a discount code."); return; }
  if(!cart.length) return;
  const list = discountApplied_ || [];
  if(list.some(e => sameCode_(e.code, code))){ discountMsgEl_("That code is already applied."); return; }
  if(list.length >= DISCOUNT_MAX_CODES_){ discountMsgEl_("That's the most codes one order can take."); return; }
  const seq = ++discountSeq_, sig = discountCartSig_();
  discountBusy_ = true; discountMsg_ = "";
  renderTicket(currentOrg, currentOrgId);
  let r;
  try{ r = await askDiscountCode_(code, list.map(e => e.code)); }
  catch(_){ r = { ok: false, failed: true, message: "We couldn't check that code — check your connection and try again." }; }
  if(seq !== discountSeq_) return;   // removed, or asked again, meanwhile
  discountBusy_ = false;
  let entry = null;
  if(r.ok){
    entry = discountEntryFrom_(r.data, code, sig);
    discountApplied_ = discountApplyCombined_(list.map(e => Object.assign({}, e, { sig })).concat(entry), r.data);
    discountInput_ = discountMulti_(currentOrg) ? "" : entry.code;
    discountAdding_ = false;
    discountMsg_ = "";
  } else discountMsg_ = r.message;
  renderTicket(currentOrg, currentOrgId);
  announceStatus(r.ok ? entry.code + " applied: " + (entry.label || "discount") + ". " : discountMsg_);
}
// × on one code (with several allowed) or Remove (the one code). Taking one off changes the others' shares (percent codes
// add up, an amount code takes what is left), so the rest are asked about again at once.
function removeDiscountCode_(code){
  const list = discountApplied_ || [];
  const target = code ? list.find(e => e.code === code) : null;
  if(discountMulti_(currentOrg) && target && list.length > 1){
    discountApplied_ = list.filter(e => e !== target);
    discountMsg_ = ""; discountSeq_++;
    if(discountTimer_){ clearTimeout(discountTimer_); discountTimer_ = null; }
    renderTicket(currentOrg, currentOrgId);
    announceStatus("Discount code " + target.code + " removed.");
    const f = document.getElementById("discountCodeInput") || document.querySelector('[data-action="discount-add"]'); if(f) f.focus();
    recheckDiscountCode_();
    return;
  }
  const gone = list.map(e => e.code).join(", ");
  discountClear_();
  renderTicket(currentOrg, currentOrgId);
  const box = document.getElementById("discountCodeInput"); if(box) box.focus();
  if(gone) announceStatus("Discount code " + (code || gone) + " removed.");
}
// The cart (or the email, for a code for one person) changed since the code was applied: ask again, after a pause so
// a run of +/− clicks is one request. Refused now → the code comes off, with the reason.
function scheduleDiscountRecheck_(){
  if(!discountApplied_) return;
  if(discountTimer_) clearTimeout(discountTimer_);
  discountTimer_ = setTimeout(recheckDiscountCode_, 700);
}
// Each code is asked about in turn with the ones kept so far, so the last answer's `combined` is the picture of them all.
async function recheckDiscountCode_(){
  discountTimer_ = null;
  if(!discountApplied_ || !currentOrg) return;
  if(!cart.length){ discountApplied_ = null; renderTicket(currentOrg, currentOrgId); return; }
  const applied = discountApplied_, seq = ++discountSeq_, sig = discountCartSig_();
  const kept = [], notes = [];
  let lastAnswer = null;
  for(const e of applied){
    let r;
    try{ r = await askDiscountCode_(e.code, kept.map(k => k.code)); }catch(_){ r = { ok: false, failed: true }; }
    if(seq !== discountSeq_ || discountApplied_ !== applied) return;
    if(r.ok){ kept.push(Object.assign(discountEntryFrom_(r.data, e.code, sig), { label: String(r.data.label || e.label) })); lastAnswer = r.data; }
    else if(r.failed) kept.push(Object.assign({}, e, { sig }));   // no answer: keep it — the order is checked anyway
    else notes.push(e.code + " no longer applies: " + r.message);
  }
  const next = discountApplyCombined_(kept, lastAnswer);
  discountApplied_ = next.length ? next : null;
  if(notes.length){ discountMsg_ = notes.join(" "); announceStatus(discountMsg_); }
  renderTicket(currentOrg, currentOrgId);
}
// ---- Net 30 (pay by invoice, migrations/0121) ----
// Never in the catalog's payment list: a customer the shop allows Net 30 (admin → Customers → Allow Net 30) sees it once
// the email they type is one the server recognises. The page asks checkNet30 {orgId, email} after a pause in typing
// (and at once when the field is left); the answer is { ok, termsDays } or just { ok: false } — the same for an address
// that isn't a customer at all, so the box can't be used to find out who is one. The server checks again when the order
// is placed, so this is only what the select offers. A PO number is optional here: it can be added from the invoice.
const NET30_METHOD_ = "Net 30";
const NET30_PO_MAX_ = 60;
let net30_ = { key: "", ok: false, termsDays: null };   // the answer for `key` (shop + address as typed, lower case)
let net30Seq_ = 0, net30Timer_ = null;
let net30Po_ = "";                                     // the PO number typed, kept across the panel's redraws
const net30Key_ = (orgId, email) => String(orgId || "") + "|" + String(email || "").trim().toLowerCase();
const net30EmailOk_ = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
// Offered at this shop for the address in the box now (a stale answer for another address offers nothing).
function net30Offered_(org){
  const el = document.getElementById("custContact");
  return !!(org && !org.preview && org.net30Offered === true && net30_.ok && net30_.key === net30Key_(org.orgId, el ? el.value : ""));
}
async function askNet30_(orgId, email){
  const res = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "checkNet30", orgId, email }) });
  const data = await res.json().catch(() => null);
  if(!res.ok || !data || data.ok !== true) return { ok: false };
  const days = Number(data.termsDays);
  return { ok: true, termsDays: Number.isInteger(days) && days > 0 ? days : null };
}
// Asks about the address in the box now (unless that answer is already in hand) and redraws the checkout when what the
// select offers changes. A reply for an address typed over meanwhile is dropped.
async function checkNet30_(){
  if(net30Timer_){ clearTimeout(net30Timer_); net30Timer_ = null; }
  const org = currentOrg, el = document.getElementById("custContact");
  // Only where asking can say yes (/api/catalog's net30Offered: Net 30 ticked in Global settings, not off for this shop),
  // so a shop without Net 30 sends nothing while the customer types.
  if(!org || org.preview || !el || org.net30Offered !== true) return;
  const email = el.value.trim(), key = net30Key_(org.orgId, email);
  if(key === net30_.key) return;
  // What the select shows now (net30Offered_ can't say: the box already holds the new address, so it is never true here).
  const before = !!document.querySelector('#custPaymentMethod option[value="' + NET30_METHOD_ + '"]');
  const seq = ++net30Seq_;
  if(!net30EmailOk_(email)){ net30_ = { key, ok: false, termsDays: null }; if(before) renderTicket(org, currentOrgId); return; }
  let r;
  try{ r = await askNet30_(org.orgId, email); }catch(_){ r = { ok: false, failed: true }; }
  if(seq !== net30Seq_ || currentOrg !== org) return;
  // No answer (offline, a server error): nothing is remembered, so leaving the field or ordering asks again.
  net30_ = r.failed ? { key: "", ok: false, termsDays: null } : { key, ok: r.ok, termsDays: r.termsDays };
  if(net30Offered_(org) !== before){
    renderTicket(org, currentOrgId);
    if(net30Offered_(org)) announceStatus("Net 30 (pay by invoice) is available for this order.");
  }
}
function scheduleNet30Check_(){
  if(net30Timer_) clearTimeout(net30Timer_);
  net30Timer_ = setTimeout(checkNet30_, 700);
}
// The PO number box under the select: shown while Net 30 is chosen.
function net30PoHtml_(show){
  return `<div class="net30-po" id="net30PoWrap"${show ? "" : " hidden"}>
        <input type="text" id="custPoNumber" maxlength="${NET30_PO_MAX_}" autocomplete="off" spellcheck="false" placeholder="PO number (optional)" aria-label="PO number" aria-describedby="custPoHint" value="${escapeHtml(net30Po_)}">
        <div class="form-hint" id="custPoHint">Your PO number, if you have it — you can add it later from your invoice.</div>
      </div>`;
}
function net30Days_(n){ const d = Number(n); return Number.isInteger(d) && d > 0 ? d : null; }

// Shop news and discounts (email campaigns, migrations/0117): a box under the email address, ticked to start with.
// Unticked, the order puts the address on the no-marketing list; ticked takes off only what an earlier checkout put
// there. Kept across redraws; shown while the Email campaigns feature is on (never on a preview).
let marketingOptIn_ = true;
function marketingBoxOn_(org){ return !!(org && featureOn_("emailCampaigns") && !org.preview); }
function marketingBoxHtml_(org){
  if(!marketingBoxOn_(org)) return "";
  return `<label class="marketing-optin">
        <input type="checkbox" id="custMarketing" data-change="marketing"${marketingOptIn_ ? " checked" : ""}>
        <span><span class="marketing-optin-title">Email me shop news and discounts</span>
        <span class="marketing-optin-note">We'll never sell your information or share it with anyone else. You can unsubscribe from any email.</span></span>
      </label>`;
}
// The box, above the totals: the code field with Apply, or (once applied) the code, its label and Remove. With several
// codes allowed: each applied code with its ×, and "Add another code" (up to DISCOUNT_MAX_CODES_) that opens the field.
function discountSectionHtml_(org){
  if(!discountBoxOn_(org) || !cart.length) return "";
  const list = discountApplied_ || [];
  if(!discountMulti_(org)){
    const a = list[0] || null;
    return `
    <div class="shipping-section discount-section">
      <label class="shipping-section-label" for="discountCodeInput">Discount code</label>
      <div class="discount-row">
        <input type="text" id="discountCodeInput" class="shipping-zip-input discount-input" maxlength="32" autocomplete="off" autocapitalize="characters" spellcheck="false"
          value="${escapeHtml(a ? a.code : discountInput_)}"${a ? " readonly" : ""} aria-describedby="discountMsg discountOn">
        ${a ? `<button type="button" class="discount-btn" data-action="discount-remove">Remove</button>`
          : `<button type="button" class="discount-btn" data-action="discount-apply"${discountBusy_ ? " disabled" : ""}>${discountBusy_ ? "Checking…" : "Apply"}</button>`}
      </div>
      <div class="discount-on" id="discountOn"${a ? "" : " hidden"}>${a ? escapeHtml(a.code + (a.label ? " — " + a.label : "")) : ""}</div>
      <div class="discount-msg" id="discountMsg" aria-live="polite"${discountMsg_ ? "" : " hidden"}>${escapeHtml(discountMsg_)}</div>
    </div>`;
  }
  const showInput = !list.length || discountAdding_ || discountBusy_;
  return `
    <div class="shipping-section discount-section">
      ${showInput ? `<label class="shipping-section-label" for="discountCodeInput">${list.length ? "Another discount code" : "Discount code"}</label>`
        : `<div class="shipping-section-label" id="discountListLabel">Discount codes</div>`}
      <ul class="discount-list" id="discountOn" aria-describedby="discountMsg"${list.length ? "" : " hidden"}>
        ${list.map(e => `<li class="discount-chip"><span>${escapeHtml(e.code + (e.label ? " — " + e.label : ""))}</span>
          <button type="button" class="discount-x" data-action="discount-remove" data-code="${escapeHtml(e.code)}" aria-label="Remove code ${escapeHtml(e.code)}">&times;</button></li>`).join("")}
      </ul>
      ${showInput ? `<div class="discount-row">
        <input type="text" id="discountCodeInput" class="shipping-zip-input discount-input" maxlength="32" autocomplete="off" autocapitalize="characters" spellcheck="false"
          value="${escapeHtml(discountInput_)}" aria-describedby="discountMsg discountOn">
        <button type="button" class="discount-btn" data-action="discount-apply"${discountBusy_ ? " disabled" : ""}>${discountBusy_ ? "Checking…" : "Apply"}</button>
      </div>`
      : list.length < DISCOUNT_MAX_CODES_ ? `<button type="button" class="discount-link" data-action="discount-add">Add another code</button>` : ""}
      <div class="discount-msg" id="discountMsg" aria-live="polite"${discountMsg_ ? "" : " hidden"}>${escapeHtml(discountMsg_)}</div>
    </div>`;
}

// ---- Gift cards at checkout (migrations/0120) ----
// A gift card is a payment, not a discount: it comes after the codes, the shipping and the tax, and it works alongside
// codes even when only one code is allowed. "Have a gift card?" → the number → Check (the server says the balance, and
// nothing else about the card) → Apply, up to GIFT_MAX_CARDS_. Each card pays up to its balance of what is still owed;
// the order sends the numbers and the amounts the page showed, the server redeems each up to what is really due and
// answers what each took. Card numbers are kept in this page's memory only (never in the saved cart or the attempt record).
let giftCards_ = [];       // [{ code, last4, balance (dollars) }] — applied
let giftChecked_ = null;   // { code, last4, balance } — checked, waiting for Apply
let giftInput_ = "", giftMsg_ = "", giftBusy_ = false, giftOpen_ = false, giftSeq_ = 0;
const GIFT_MAX_CARDS_ = 3;
function giftBoxOn_(org){ return !!(org && org.giftCardPay === true && !org.preview); }
function giftReset_(){ giftCards_ = []; giftChecked_ = null; giftInput_ = ""; giftMsg_ = ""; giftBusy_ = false; giftOpen_ = false; giftSeq_++; }
const giftNormalize_ = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function giftMsgEl_(text){
  giftMsg_ = text || "";
  const el = document.getElementById("giftMsg");
  if(el){ el.textContent = giftMsg_; el.hidden = !giftMsg_; }
}
// What each card pays of `due` dollars, in order: [{ card, take (dollars) }]. Cents throughout.
function giftPlan_(due){
  let left = Math.max(0, Math.round((Number(due) || 0) * 100));
  return giftCards_.map(card => {
    const takeCents = Math.min(Math.max(0, Math.round(card.balance * 100)), left);
    left -= takeCents;
    return { card, take: takeCents / 100 };
  });
}
async function checkGiftCard_(){
  const code = giftNormalize_(giftInput_);
  if(!code){ giftMsgEl_("Enter your gift card number."); return; }
  if(code.length !== 16){ giftMsgEl_("That gift card number isn't right."); return; }
  if(giftCards_.some(c => c.code === code)){ giftMsgEl_("That gift card is already added."); return; }
  const seq = ++giftSeq_;
  giftBusy_ = true; giftMsg_ = ""; giftChecked_ = null;
  renderTicket(currentOrg, currentOrgId);
  let msg = "", card = null;
  try{
    const res = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "checkGiftCard", orgId: currentOrg.orgId, code }) });
    const data = await res.json().catch(() => null);
    const c = data && (data.card || data);
    if(res.ok && data && data.status === "ok" && data.ok !== false && c && c.last4) card = { code, last4: String(c.last4), balance: Number(c.balance) || 0 };
    else if(res.status === 429) msg = "Too many tries — please wait a minute and try again.";
    else if(data && (data.message || data.reason) && res.status < 500) msg = String(data.message || data.reason);
    else msg = "We couldn't check that gift card just now. Please try again.";
  }catch(_){ msg = "We couldn't check that gift card — check your connection and try again."; }
  if(seq !== giftSeq_) return;
  giftBusy_ = false;
  if(card){ giftChecked_ = card; giftMsg_ = "Gift card ••" + card.last4 + " has $" + card.balance.toFixed(2) + " on it. Press Apply to use it."; }
  else giftMsg_ = msg;
  renderTicket(currentOrg, currentOrgId);
  announceStatus(giftMsg_);
}
function applyGiftCard_(){
  const c = giftChecked_;
  if(!c) return;
  if(giftCards_.length >= GIFT_MAX_CARDS_ || giftCards_.some(x => x.code === c.code)) return;
  giftCards_ = giftCards_.concat(c);
  giftChecked_ = null; giftInput_ = ""; giftMsg_ = ""; giftOpen_ = false;
  renderTicket(currentOrg, currentOrgId);
  announceStatus("Gift card ••" + c.last4 + " added.");
  const f = document.querySelector('[data-action="gift-open"]'); if(f) f.focus();
}
function removeGiftCard_(idx){
  const c = giftCards_[idx];
  if(!c) return;
  giftCards_ = giftCards_.filter((_, i) => i !== idx);
  renderTicket(currentOrg, currentOrgId);
  announceStatus("Gift card ••" + c.last4 + " removed.");
  const f = document.querySelector('[data-action="gift-open"]'); if(f) f.focus();
}
function giftSectionHtml_(org){
  if(!giftBoxOn_(org) || !cart.length) return "";
  const room = giftCards_.length < GIFT_MAX_CARDS_;
  const chips = giftCards_.length ? `<ul class="discount-list" aria-label="Gift cards added">${giftCards_.map((c, i) => `<li class="discount-chip"><span>Gift card ••${escapeHtml(c.last4)} — $${c.balance.toFixed(2)} on it</span>
      <button type="button" class="discount-x" data-action="gift-remove" data-idx="${i}" aria-label="Remove gift card ending ${escapeHtml(c.last4)}">&times;</button></li>`).join("")}</ul>` : "";
  const open = room && (giftOpen_ || giftBusy_ || giftChecked_ || giftMsg_);
  const field = open ? `<div class="discount-row">
        <input type="text" id="giftCardInput" class="shipping-zip-input discount-input gift-input" maxlength="24" autocomplete="off" autocapitalize="characters" spellcheck="false"
          placeholder="XXXX-XXXX-XXXX-XXXX" value="${escapeHtml(giftInput_)}" aria-label="Gift card number" aria-describedby="giftMsg">
        ${giftChecked_ ? `<button type="button" class="discount-btn" data-action="gift-apply">Apply</button>`
          : `<button type="button" class="discount-btn" data-action="gift-check"${giftBusy_ ? " disabled" : ""}>${giftBusy_ ? "Checking…" : "Check"}</button>`}
      </div>`
    : room ? `<button type="button" class="discount-link" data-action="gift-open">${giftCards_.length ? "Add another gift card" : "Have a gift card?"}</button>` : "";
  return `
    <div class="shipping-section gift-section">
      ${giftCards_.length || open ? `<div class="shipping-section-label">Gift card</div>` : ""}
      ${chips}
      ${field}
      <div class="discount-msg gift-msg" id="giftMsg" aria-live="polite"${giftMsg_ ? "" : " hidden"}>${escapeHtml(giftMsg_)}</div>
    </div>`;
}
// What the whole cart comes to as the page works it out (the server prices the order itself): the goods less the codes,
// the delivery (free when a code makes it so), the rush fee and the sales tax added on top.
function cartGrand_(org, delivery, rush){
  const subtotal = cart.reduce((s, c) => s + c.lineTotal, 0);
  const discount = discountNow_(subtotal);
  const rushFee = rush ? rush.fee : 0;
  const shipping = discountFreeShipping_() ? 0 : delivery.fee;
  return Math.round((subtotal - discount + shipping + rushFee + cartTax_(org, delivery, rushFee, discount).tax) * 100) / 100;
}
// "Your gift card covers it" — the cards pay everything this page knows is owed. Not while the shipping cost or a rush
// fee is still to follow: more will be owed.
function giftCovers_(org, delivery, rush){
  if(!giftBoxOn_(org) || !giftCards_.length || !cart.length) return false;
  if((delivery && delivery.kind === "manual") || (rush && rush.pending)) return false;
  const grand = cartGrand_(org, delivery, rush);
  return giftPlan_(grand).reduce((s, p) => s + Math.round(p.take * 100), 0) >= Math.round(grand * 100);
}
function flashAdded_(pid){
  const b = document.querySelector('.add-btn[data-pid="' + (window.CSS && CSS.escape ? CSS.escape(pid) : pid) + '"]'); if(!b) return;
  b.textContent = "Added ✓"; b.classList.add("added");
  setTimeout(() => { b.textContent = "Add to cart"; b.classList.remove("added"); }, 1500);
}

// Delegated handlers for product controls and cart/order actions — uses
// data-* attributes instead of splicing server IDs into inline onclick strings.

// ---- Image viewer ("zoom") -------------------------------------------------
// Clicking a product/option/design picture opens it in a near-full-screen viewer instead of a new tab.
// The pictures are every a.zoom-link inside the same product card (or the org's design-preview strip),
// so the arrows walk the blank photos AND the configured option previews currently shown. It closes only
// from the Close button or Escape (never a stray click outside — same rule as every other pop-up).
// Zoom: the − / + buttons (or the - / + keys; 0 = back to fit) step through LB_ZOOM_STEPS. A zoomed
// picture is simply drawn bigger inside the scrolling stage, so it's moved with a finger, the
// scroll wheel / trackpad, or by dragging with the mouse. Going to another picture returns to fit.
const LB_ZOOM_STEPS = [1, 1.5, 2, 3, 4];
function openImageViewer_(links, startIdx){
  const items = links.map(a => { const img = a.querySelector("img"); const badge = a.parentElement && a.parentElement.querySelector(".cfg-prev-badge");
    return { src: a.getAttribute("href"), alt: (img && img.alt || "").replace(/\s*[—-]\s*click to view full size$/, ""), label: badge ? badge.textContent : "" }; }).filter(it => it.src);
  if (!items.length) return;
  let i = Math.max(0, Math.min(items.length - 1, startIdx || 0));
  const opener = document.activeElement;
  const ov = document.createElement("div");
  ov.className = "lb-overlay"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true"); ov.setAttribute("aria-label", "Image viewer");
  ov.innerHTML = `<div class="lb-box"><div class="lb-stage"><img class="lb-img" alt="" draggable="false"></div><div class="lb-cap"><span class="lb-text"></span><span class="lb-count"></span><span class="lb-zoom" aria-live="polite"></span></div>
    <button type="button" class="lb-btn lb-prev" aria-label="Previous image">&#8249;</button>
    <button type="button" class="lb-btn lb-next" aria-label="Next image">&#8250;</button>
    <button type="button" class="lb-btn lb-zoom-out" aria-label="Zoom out" title="Zoom out">&minus;</button>
    <button type="button" class="lb-btn lb-zoom-in" aria-label="Zoom in" title="Zoom in">+</button>
    <button type="button" class="lb-btn lb-close" aria-label="Close">&#10005;</button></div>`;
  const stage = ov.querySelector(".lb-stage"), imgEl = ov.querySelector(".lb-img"), textEl = ov.querySelector(".lb-text"), countEl = ov.querySelector(".lb-count"), zoomEl = ov.querySelector(".lb-zoom");
  const prev = ov.querySelector(".lb-prev"), next = ov.querySelector(".lb-next"), closeBtn = ov.querySelector(".lb-close");
  const zoomOutBtn = ov.querySelector(".lb-zoom-out"), zoomInBtn = ov.querySelector(".lb-zoom-in");
  // zi indexes LB_ZOOM_STEPS (0 = fitted to the screen). The zoomed size is the FITTED size times the
  // step, so it's measured with the inline size cleared first; the point at the middle of the view
  // stays in the middle. Runs again when the picture finishes loading or the window changes size.
  let zi = 0;
  const applyZoom = () => {
    const z = LB_ZOOM_STEPS[zi];
    const fx = stage.scrollWidth ? (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth : .5;
    const fy = stage.scrollHeight ? (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight : .5;
    imgEl.style.width = imgEl.style.height = imgEl.style.maxWidth = imgEl.style.maxHeight = "";
    if (z > 1) {
      const r = imgEl.getBoundingClientRect();
      if (r.width && r.height) {
        imgEl.style.maxWidth = imgEl.style.maxHeight = "none";
        imgEl.style.width = Math.round(r.width * z) + "px"; imgEl.style.height = Math.round(r.height * z) + "px";
      }
    }
    ov.classList.toggle("lb-zoomed", z > 1);
    stage.scrollLeft = fx * stage.scrollWidth - stage.clientWidth / 2;
    stage.scrollTop = fy * stage.scrollHeight - stage.clientHeight / 2;
    zoomEl.textContent = z > 1 ? Math.round(z * 100) + "%" : "";
    const focused = document.activeElement;
    zoomOutBtn.disabled = zi <= 0; zoomInBtn.disabled = zi >= LB_ZOOM_STEPS.length - 1;
    // A button that just reached its limit is disabled and would drop focus — hand it to the other one.
    if ((focused === zoomOutBtn || focused === zoomInBtn) && focused.disabled) (focused === zoomOutBtn ? zoomInBtn : zoomOutBtn).focus();
  };
  const setZoom = (n) => { zi = Math.max(0, Math.min(LB_ZOOM_STEPS.length - 1, n)); applyZoom(); };
  const show = (n) => { i = (n + items.length) % items.length; const it = items[i];
    imgEl.src = it.src; imgEl.alt = it.alt || it.label || "Product image";
    textEl.textContent = [it.label, it.alt].filter(Boolean).filter((v, k, a) => a.indexOf(v) === k).join(" — ");
    countEl.textContent = items.length > 1 ? (i + 1) + " / " + items.length : "";
    setZoom(0); };
  prev.hidden = next.hidden = items.length < 2;
  const close = () => { document.removeEventListener("keydown", onKey, true); window.removeEventListener("resize", applyZoom); ov.remove(); document.body.style.overflow = prevOverflow; if (opener && opener.focus) try { opener.focus(); } catch (e) {} };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowLeft" && items.length > 1) { e.preventDefault(); show(i - 1); }
    else if (e.key === "ArrowRight" && items.length > 1) { e.preventDefault(); show(i + 1); }
    else if ((e.key === "+" || e.key === "=") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setZoom(zi + 1); }
    else if ((e.key === "-" || e.key === "_") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setZoom(zi - 1); }
    else if (e.key === "0" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setZoom(0); }
    else if (e.key === "Tab") { const f = [zoomOutBtn, zoomInBtn, closeBtn, prev, next].filter(b => !b.disabled && !b.hidden); const k = f.indexOf(document.activeElement);
      e.preventDefault(); f[(k + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus(); }
  };
  prev.onclick = () => show(i - 1); next.onclick = () => show(i + 1); closeBtn.onclick = close;
  zoomInBtn.onclick = () => setZoom(zi + 1); zoomOutBtn.onclick = () => setZoom(zi - 1);
  imgEl.addEventListener("load", applyZoom);
  window.addEventListener("resize", applyZoom);
  // Drag a zoomed picture with the mouse. (A finger scrolls the stage natively.)
  let drag = null;
  stage.addEventListener("mousedown", (e) => { if (zi === 0 || e.button !== 0) return; e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop }; stage.classList.add("lb-dragging"); });
  ov.addEventListener("mousemove", (e) => { if (!drag) return; stage.scrollLeft = drag.left - (e.clientX - drag.x); stage.scrollTop = drag.top - (e.clientY - drag.y); });
  const endDrag = () => { drag = null; stage.classList.remove("lb-dragging"); };
  ov.addEventListener("mouseup", endDrag); ov.addEventListener("mouseleave", endDrag);
  // Swipe on a touch screen — only at fit: on a zoomed picture a finger moves the picture instead.
  let tx = null;
  ov.addEventListener("touchstart", (e) => { tx = e.touches.length === 1 && zi === 0 ? e.touches[0].clientX : null; }, { passive: true });
  ov.addEventListener("touchend", (e) => { if (tx == null || items.length < 2 || zi !== 0) return; const dx = (e.changedTouches[0].clientX - tx); tx = null; if (Math.abs(dx) > 50) show(i + (dx < 0 ? 1 : -1)); }, { passive: true });
  const prevOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(ov); show(i); closeBtn.focus();
  return { ov, close, show, setZoom };
}
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a.zoom-link"); if (!a) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;   // let "open in new tab" shortcuts work
  e.preventDefault();
  const scope = a.closest(".product, .design-preview") || a.parentElement;
  const links = Array.from(scope.querySelectorAll("a.zoom-link"));
  openImageViewer_(links, links.indexOf(a));
});

document.addEventListener("click", (e)=>{
  const btn = e.target.closest("[data-action]");
  if(!btn) return;
  const a = btn.dataset.action;
  if(a === "add") addToCart(btn.dataset.pid);
  else if(a === "remove") removeFromCart(Number(btn.dataset.idx), btn.dataset.org);
  else if(a === "qty") changeCartQty_(Number(btn.dataset.idx), Number(btn.dataset.d));
  else if(a === "view-cart"){ const t = document.getElementById("ticketPanel"); if(t){ t.scrollIntoView({behavior: "smooth", block: "start"}); const h = t.querySelector("h2"); if(h){ h.setAttribute("tabindex", "-1"); h.focus({preventScroll: true}); } } }
  else if(a === "retry-card") retryCardPayment_(btn);
  else if(a === "dismiss-unpaid"){ unpaidCardNotice = null; writePendingCard_(currentOrgId, null); const b = document.getElementById("unpaidBar"); if(b) b.remove(); }
  else if(a === "place-order") placeOrder(btn.dataset.org);
  else if(a === "discount-apply") applyDiscountCode_();
  else if(a === "discount-remove") removeDiscountCode_(btn.dataset.code);
  else if(a === "discount-add"){ discountAdding_ = true; renderTicket(currentOrg, currentOrgId); const f = document.getElementById("discountCodeInput"); if(f) f.focus(); }
  else if(a === "gift-open"){ giftOpen_ = true; renderTicket(currentOrg, currentOrgId); const f = document.getElementById("giftCardInput"); if(f) f.focus(); }
  else if(a === "gift-check") checkGiftCard_();
  else if(a === "gift-apply") applyGiftCard_();
  else if(a === "gift-remove") removeGiftCard_(Number(btn.dataset.idx));
  else if(a === "giftbuy-open") renderGiftBuy_();
  else if(a === "giftbuy-amount") giftBuyPickAmount_(btn.dataset.amount);
  else if(a === "giftbuy-submit") giftBuySubmit_();
  else if(a === "go-org") go("org", btn.dataset.org);
  else if(a === "version") versionSwitch_(btn.dataset.vgroup, btn.dataset.vpid);
  else if(a === "color") cfgPickColor_(btn.dataset.pid, btn);
  else if(a === "dv-choose") window.dvSelectAction(btn.dataset.choice);
  else if(a === "dv-submit") window.dvSubmitResponse(btn.dataset.token);
});

document.addEventListener("keydown", (e)=>{
  if(e.key === "Enter" && e.target && e.target.id === "discountCodeInput" && !e.target.readOnly && !discountBusy_){ e.preventDefault(); applyDiscountCode_(); }
  if(e.key === "Enter" && e.target && e.target.id === "giftCardInput" && !giftBusy_){ e.preventDefault(); if(giftChecked_) applyGiftCard_(); else checkGiftCard_(); }
});

document.addEventListener("change", (e)=>{
  // Fields that name what a change does (the page has no inline handlers: public/_headers runs no inline script).
  const ch = e.target.dataset && e.target.dataset.change;
  // The email box left (or filled in by the browser): ask about Net 30 for it now rather than after the pause.
  if(e.target.id === "custContact"){ checkNet30_(); return; }
  if(ch){
    if(ch === "rush") setRush_(e.target.checked);
    else if(ch === "rush-date"){ rushNeededBy = e.target.value; renderTicket(currentOrg, currentOrgId); }
    else if(ch === "payment-method") updatePaymentHint(e.target.value);
    else if(ch === "marketing") marketingOptIn_ = !!e.target.checked;
    else if(ch === "dv-upload") window.handleCustVerifyUpload(e.target);
    return;
  }
  // The customer's own design: a file was chosen.
  if(e.target.classList && e.target.classList.contains("cd-file")){ handleCustomDesignFile_(e.target); return; }
  // "Use my own design instead": show/hide its box.
  if(e.target.id && e.target.id.startsWith("cdon-")){
    const box = document.getElementById(customDesignBoxId_(e.target.id.slice(5), CUSTOM_PLAIN_LOC));
    if(box) box.hidden = !e.target.checked;
  }
  // Size select / personalization checkbox: update the displayed price.
  if(e.target.dataset.pid){
    const cp = activeCatalog && activeCatalog.products && activeCatalog.products.find(x => x.id === e.target.dataset.pid);
    if(cp && cp.configurable) cfgRefresh_(e.target.dataset.pid);
    else updateProductPrice(e.target.dataset.pid);
  }
  // Personalization checkbox: show/hide the name field.
  if(e.target.id && e.target.id.startsWith("pers-") && !e.target.id.startsWith("pers-name-")){
    const pid = e.target.id.replace("pers-","");
    const nameField = document.getElementById("pers-name-"+pid);
    if(nameField) nameField.style.display = e.target.checked ? "block" : "none";
  }
  // Shipping delivery option: update selected quote and re-render totals.
  if(e.target.name === "shippingChoice"){
    const val = e.target.value;
    if(val.startsWith("o:")){            // local pickup or one of the shop's own options
      deliveryOptId = val.slice(2); shippingQuote = null; shippingManualPicked = false;
    }else if(val === "manual"){          // ship it — the quote follows by email
      shippingQuote = null; shippingManualPicked = true;
    }else{
      const idx = parseInt(val, 10);
      shippingQuote = (Number.isFinite(idx) && shippingRates[idx]) ? shippingRates[idx] : null;
      shippingManualPicked = false;
    }
    if(currentOrg && currentOrgId) renderTicket(currentOrg, currentOrgId);
  }
});

document.addEventListener("input", (e)=>{
  if(e.target.id === "discountCodeInput"){ discountInput_ = e.target.value; if(discountMsg_) discountMsgEl_(""); return; }
  if(e.target.id === "giftCardInput"){
    giftInput_ = e.target.value; if(giftMsg_) giftMsgEl_("");
    // Another number than the one checked: back to Check (in place, so the customer keeps typing).
    if(giftChecked_ && giftNormalize_(giftInput_) !== giftChecked_.code){
      giftChecked_ = null;
      const b = document.querySelector('[data-action="gift-apply"]'); if(b){ b.dataset.action = "gift-check"; b.textContent = "Check"; }
    }
    return;
  }
  if(e.target.dataset && e.target.dataset.gb){ giftBuyInput_(e.target); return; }
  // Another email address: a refusal about the address no longer holds, and a code for one person is asked about again.
  if(e.target.id === "custContact"){
    if(discountMsgAboutEmail_(discountMsg_)) discountMsgEl_("");
    if(discountApplied_) scheduleDiscountRecheck_();
    scheduleNet30Check_();   // Net 30 is offered per address (after a pause in typing)
    return;
  }
  if(e.target.id === "custPoNumber"){ net30Po_ = e.target.value.slice(0, NET30_PO_MAX_); return; }
  if(e.target.id === "shippingZipInput"){
    shippingZip = isUS_() ? e.target.value.replace(/\D/g,"").slice(0,5) : e.target.value.slice(0,20);
    e.target.value = shippingZip; // normalize in-place (US: strip non-digits)
    scheduleShippingUpdate();
  }
});

// Renders the delivery/shipping section inside the ticket panel.
// The Delivery choices: the shop's list in its own order — local pickup and its custom options as
// radios with their fee, and (when the shop ships) a ZIP box that brings up carrier rates to pick
// from. A shop that only offers free local pickup shows nothing.
function renderShippingSection(org){
  if(!org) return "";
  if(cartDigitalOnly_(org)) return `
    <div class="shipping-section">
      <div class="shipping-section-label">Delivery</div>
      <div class="shipping-option">Instant download — paying by card takes you straight to the files; otherwise the shop sends them once your payment is in.</div>
    </div>`;
  const options = deliveryOptions_(org);
  if(options.length === 1 && options[0].type === "pickup") return "";
  const ships = offersShipping_(org);
  const cur = currentDelivery_(org);
  const fee = (f) => Number(f) > 0 ? `$${Number(f).toFixed(2)}` : "Free";

  const rateOptions = shippingRates.map((r, i) => {
    const sel = cur.kind === "quote" && shippingQuote.provider === r.provider && shippingQuote.service === r.service;
    const days = r.estimatedDays ? ` <small>(~${r.estimatedDays} day${r.estimatedDays !== 1 ? "s" : ""})</small>` : "";
    return `<label class="shipping-option">
      <input type="radio" name="shippingChoice" value="${i}"${sel ? " checked" : ""}>
      <span>${escapeHtml(r.provider)} ${escapeHtml(r.service)} &mdash; <strong>$${r.amount.toFixed(2)}</strong>${days}</span>
    </label>`;
  }).join("");
  const manualOption = shippingManual
    ? `<label class="shipping-option">
        <input type="radio" name="shippingChoice" value="manual"${cur.kind === "manual" ? " checked" : ""}>
        <span>Ship to ${escapeHtml(shippingZip)} &mdash; <strong>quote to follow</strong></span>
      </label>
      <div class="shipping-manual-notice" role="status">
        <strong>Shipping quote pending</strong> — your order requires a custom shipping quote.
        We'll follow up via email with the shipping cost, updated total, and payment options.
        You can still place your order now.
       </div>`
    : "";
  const shippingBlock = !ships ? "" : `
      ${rateOptions}
      ${manualOption}
      <div class="shipping-zip-row">
        <label class="shipping-zip-label" for="shippingZipInput">${options.length === 1 ? `${isUS_() ? "ZIP" : "Postal code"} for shipping rates` : `Ship it instead? ${isUS_() ? "ZIP" : "Postal code"} for carrier rates`}</label>
        <input type="text" id="shippingZipInput" ${isUS_() ? 'inputmode="numeric" maxlength="5" placeholder="12345"' : 'maxlength="20" placeholder="Postal code"'}
          value="${escapeHtml(shippingZip)}"
          class="shipping-zip-input" aria-label="${isUS_() ? "ZIP code" : "Postal code"} for carrier shipping rates">
        ${shippingLoading ? '<span class="shipping-loading" role="status" aria-live="polite">Calculating&hellip;</span>' : ""}
      </div>`;

  // In the shop's order; the shipping entry is where the ZIP box and the carrier rates go.
  const rows = options.map(o => o.type === "shipping" ? shippingBlock : `
      <label class="shipping-option">
        <input type="radio" name="shippingChoice" value="o:${escapeHtml(o.id)}"${cur.kind === "option" && cur.option.id === o.id ? " checked" : ""}>
        <span>${escapeHtml(o.label)} &mdash; <strong>${fee(o.fee)}</strong></span>
      </label>`).join("");

  return `
    <div class="shipping-section">
      <div class="shipping-section-label">Delivery</div>
      ${rows}
    </div>`;
}

// Debounces shipping quote fetches — called whenever the zip changes or
// the cart changes while a zip is already set. Cancels if zip is not yet
// 5 digits; resets to local delivery if it was previously a carrier rate.
function scheduleShippingUpdate(){
  if(!currentOrg || !offersShipping_(currentOrg)) return;
  if(shippingDebounce) clearTimeout(shippingDebounce);
  if(isUS_() ? !/^\d{5}$/.test(shippingZip) : !shippingZip.trim()){
    const had = shippingQuote !== null || shippingManual;
    shippingRates = []; shippingManual = false; shippingManualPicked = false; shippingQuote = null;
    if(had) renderTicket(currentOrg, currentOrgId);
    return;
  }
  shippingDebounce = setTimeout(fetchShippingQuote, 1000);
}

async function fetchShippingQuote(){
  if(!currentOrg || !offersShipping_(currentOrg) || cart.length === 0) return;
  shippingLoading = true;
  renderTicket(currentOrg, currentOrgId);

  const items = cart.map(c => {
    const prod = (currentOrg.products || []).find(p => p.id === c.productId) || {};
    return { productId: c.productId, qty: c.qty, weightOz: prod.weightOz || 0, type: prod.type || "" };
  });

  const reqZip = shippingZip;
  try{
    const res = await fetch("/api/shipping", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({zip: reqZip, items, org: currentOrgId})
    });
    const data = await res.json();
    if(data.status === "ok"){
      shippingQuotedZip = reqZip;
      shippingManual = !!data.manualShipping;
      // An order that needs a custom quote ships by default once a ZIP is typed; the
      // customer can still switch back to pickup or another option.
      shippingManualPicked = shippingManual;
      shippingRates = data.rates || [];
      shippingQuote = null; // clear selection whenever rates refresh
      // If the previously selected carrier is no longer in the returned set,
      // fall back to local delivery so there's never a stale/hidden selection.
      if(!shippingManual && shippingQuote !== null){
        const stillPresent = shippingRates.find(
          r => r.provider === shippingQuote.provider && r.service === shippingQuote.service
        );
        if(!stillPresent) shippingQuote = null;
      }
    }else{
      shippingRates = [];
      shippingManual = false; shippingManualPicked = false;
      showToast(isUS_() ? "Could not get shipping rates — check the ZIP and try again." : (data.message || "Could not get shipping rates."), true);
    }
  }catch(e){
    shippingRates = [];
    shippingManual = false; shippingManualPicked = false;
    showToast("Could not reach the shipping service.", true);
  }

  shippingLoading = false;
  renderTicket(currentOrg, currentOrgId);
}

// Collects a full shipping address via a modal overlay before the order is
// submitted. Resolves to the address object on confirm, or null on cancel.
// Which state(s) a ZIP is in, from its first three digits — the same table as zipStates in
// functions/_lib/db.js — both are written by scripts/zip-prefix-table.py from USPS's ZIP list, so
// regenerate them together. Many prefixes straddle a state line, hence a list; one not in use gives [].
const ZIP3_STATES_ = "005:NY 006-007:PR 008:VI 009:PR 010-027:MA 028-029:RI 029:MA 030-038:NH 036:VT 039-049:ME 039:NH 050-054:VT 055:MA "
  + "056-059:VT 060-069:CT 063:NY 070-099:NJ 090:AE 091:AE 092:AE 093:AE 094:AE 095:AE 096:AE 097:AE 098:AE 099:AE "
  + "100-149:NY 150-196:PA 197-199:DE 199:MD 200:DC 200:MD 200:VA 201:VA 201:DC 202-205:DC 205:MD 205:VA 206-212:MD "
  + "214-219:MD 218:DE 220-246:VA 241:WV 246:WV 247-268:WV 270-289:NC 290-299:SC 300-319:GA 307:TN 320-342:FL 340:AA 344:FL "
  + "346-347:FL 349:FL 350-352:AL 354-369:AL 357:TN 370-385:TN 373:GA 376:VA 382:KY 386-397:MS 398-399:GA 400-418:KY 410:OH "
  + "411:WV 415:WV 420-427:KY 430-459:OH 452:KY 453:IN 460-479:IN 470:OH 471:KY 480-499:MI 500-516:IA 515:NE 520-528:IA "
  + "530-532:WI 534-535:WI 537-549:WI 550-551:MN 553-567:MN 565:ND 567:ND 570-577:SD 576:ND 580-588:ND 585:SD 590-599:MT "
  + "593:SD 600-620:IL 612:IA 622-629:IL 630-631:MO 633-641:MO 644-658:MO 660-662:KS 664-679:KS 666:MO 680-681:NE "
  + "683-693:NE 700-701:LA 703-708:LA 710-714:LA 716-729:AR 718:TX 730-731:OK 733:TX 734-741:OK 739:TX 743-749:OK "
  + "750-770:TX 755:AR 772-799:TX 798:NM 800-816:CO 820-831:WY 832-838:ID 834:WY 838:WA 840-847:UT 847:AZ 850-853:AZ "
  + "855-857:AZ 859-860:AZ 860:UT 863-865:AZ 870-871:NM 873-884:NM 885:TX 890-891:NV 893-895:NV 897-898:NV 900-908:CA "
  + "910-928:CA 930-966:CA 962:AP 963:AP 964:AP 965:AP 966:AP 966:NJ 967-968:HI 967:AS 969:GU 969:FM 969:MH 969:MP 969:PW "
  + "970-979:OR 979:ID 980-986:WA 988-994:WA 994:ID 995-999:AK";
function zipStates_(zip){
  const m = /^(\d{3})\d{2}/.exec(String(zip || "").trim());
  if(!m) return [];
  const n = Number(m[1]), out = [];
  for(const part of ZIP3_STATES_.split(" ")){
    const [range, st] = part.split(":"), [a, b] = range.split("-").map(Number);
    if(n >= a && n <= (b === undefined ? a : b) && !out.includes(st)) out.push(st);
  }
  return out;
}
// quotedZip: when the customer picked a carrier rate, the ZIP it was priced for. The address must use
// that ZIP (the server refuses any other), so a different one is caught here, with the address kept.
function collectShippingAddress(quotedZip){
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "ship-addr-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Shipping address");
    // Carry the shop's accent onto the overlay (it lives outside .layout), with a text colour that's
    // readable on it — a light accent (e.g. orange) gets dark text instead of white.
    const acc = String((currentOrg && currentOrg.accent) || "").trim();
    if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(acc)) {
      overlay.style.setProperty("--org-accent", acc);
      overlay.style.setProperty("--org-accent-ink", readableInkOn(acc));
    }

    const last = lastShipAddr_ || {};
    const prefillName = last.name || (document.getElementById("custName") || {}).value || "";
    const prefillZip = shippingZip || last.zip || "";

    overlay.innerHTML = `
      <div class="ship-addr-box">
        <h2>Shipping address</h2>
        <div class="ship-addr-fields">
          <input type="text" id="shipName" placeholder="Full name" aria-label="Full name" autocomplete="name" value="${escapeHtml(prefillName)}">
          <input type="text" id="shipLine1" placeholder="Address line 1" aria-label="Address line 1" autocomplete="address-line1" value="${escapeHtml(last.line1 || "")}">
          <input type="text" id="shipLine2" placeholder="Apt, suite, etc. (optional)" aria-label="Address line 2" autocomplete="address-line2" value="${escapeHtml(last.line2 || "")}">
          <div class="ship-addr-row">
            <input type="text" id="shipCity" placeholder="City" aria-label="City" autocomplete="address-level2" class="ship-addr-city" value="${escapeHtml(last.city || "")}">
            ${isUS_()
              ? `<input type="text" id="shipState" placeholder="ST" aria-label="State (2 letters)" autocomplete="address-level1" maxlength="2" class="ship-addr-state" value="${escapeHtml(last.state || "")}">
            <input type="text" id="shipZip" placeholder="ZIP" aria-label="ZIP code" inputmode="numeric" maxlength="5" autocomplete="postal-code" class="ship-addr-zip" value="${escapeHtml(prefillZip)}">`
              : `<input type="text" id="shipState" placeholder="State / region" aria-label="State / region" autocomplete="address-level1" maxlength="50" class="ship-addr-city" value="${escapeHtml(last.state || "")}">
            <input type="text" id="shipZip" placeholder="Postal code" aria-label="Postal code" maxlength="20" autocomplete="postal-code" class="ship-addr-zip" style="flex:0 0 130px;width:130px;" value="${escapeHtml(prefillZip)}">`}
          </div>
          <div class="ship-addr-error" id="shipAddrError" role="alert"></div>
        </div>
        <div class="ship-addr-actions">
          <button class="ship-addr-cancel" id="shipCancelBtn">Cancel</button>
          <button class="ship-addr-confirm" id="shipConfirmBtn">Confirm address</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    overlay.querySelector("#shipName").focus();

    // Whatever was typed is remembered (even on Cancel), so the next time the box opens it's filled in.
    function remember(){
      const v = (id) => { const el = overlay.querySelector(id); return el ? el.value.trim() : ""; };
      lastShipAddr_ = { name: v("#shipName"), line1: v("#shipLine1"), line2: v("#shipLine2"), city: v("#shipCity"), state: v("#shipState"), zip: v("#shipZip") };
    }
    function close(result){ remember(); overlay.remove(); resolve(result); }

    overlay.querySelector("#shipCancelBtn").addEventListener("click", () => close(null));
    overlay.addEventListener("keydown", e => { if(e.key === "Escape") close(null); });


    function confirm(){
      const errEl = overlay.querySelector("#shipAddrError");
      const name  = overlay.querySelector("#shipName").value.trim();
      const line1 = overlay.querySelector("#shipLine1").value.trim();
      const line2 = overlay.querySelector("#shipLine2").value.trim();
      const city  = overlay.querySelector("#shipCity").value.trim();
      const us = isUS_();
      const state = us ? overlay.querySelector("#shipState").value.trim().toUpperCase() : overlay.querySelector("#shipState").value.trim();
      const zipEl = overlay.querySelector("#shipZip");
      const zip   = zipEl.value.trim();
      errEl.textContent = "";
      zipEl.removeAttribute("aria-invalid");
      // Outside the US the region is optional (not every country has one) and neither it nor the
      // postal code has a fixed format.
      if(!name || !line1 || !city || (us && !state) || !zip){
        errEl.textContent = "Please fill in all required fields.";
        return;
      }
      // The shipping rate was priced for one ZIP; the server refuses an address with another. Say so
      // here, with everything typed still in the box, rather than after the order is sent.
      if(quotedZip && zip !== quotedZip){
        const word = us ? "ZIP" : "postal code";
        errEl.textContent = `Shipping was priced for ${word} ${quotedZip}. To ship to ${zip}, press Cancel, change the ${word} under Delivery and pick a new rate. Your address will still be here.`;
        zipEl.setAttribute("aria-invalid", "true");
        zipEl.focus();
        return;
      }
      if(!us){ close({ name, line1, line2: line2 || null, city, state, zip }); return; }
      if(!/^[A-Z]{2}$/.test(state)){
        errEl.textContent = "State must be a 2-letter abbreviation (e.g. NY).";
        return;
      }
      if(!/^\d{5}$/.test(zip)){
        errEl.textContent = "ZIP must be 5 digits.";
        return;
      }
      // The server refuses a state that contradicts the ZIP (the state decides sales tax), so catch
      // it here first.
      const zipSt = zipStates_(zip);
      if(zipSt.length && !zipSt.includes(state)){
        errEl.textContent = `ZIP ${zip} is in ${zipSt.join(" or ")}, but the state says ${state}. Please check the address.`;
        return;
      }
      close({ name, line1, line2: line2 || null, city, state, zip });
    }

    overlay.querySelector("#shipConfirmBtn").addEventListener("click", confirm);
    overlay.querySelector("#shipZip").addEventListener("keydown", e => {
      if(e.key === "Enter") confirm();
    });
  });
}

function addToCart(productId){
  const catalog = activeCatalog;
  const product = catalog.products.find(p=>p.id===productId);
  const qtyEl = document.getElementById("qty-"+productId);
  const qty = Math.max(1, parseInt(qtyEl.value,10) || 1);
  cardMsg_(productId, "");
  // The server takes up to 20 lines of 1 to 50 each (and refuses, rather than trims, anything else).
  if(qty > 50){ cardMsg_(productId, "You can add up to 50 of an item at a time. For a larger order, please contact the shop."); return; }
  if(cart.length >= 20){ cardMsg_(productId, "Your cart is full (20 lines). To order more, please place this order first or contact the shop."); return; }
  const sizeEl = document.getElementById("size-"+productId);
  const size = sizeEl ? sizeEl.value : "OSFA";

  // Configurable product: build the per-location config; the server reprices + rebuilds the snapshot.
  if(product.configurable){
    const { color, picks } = cfgPicks_(productId);
    if(!picks.length && !product.hasFixedTransfers && (product.locations || []).length){ cardMsg_(productId, "Choose a graphic for at least one location."); return; }
    const pending = picks.filter(x => x.custom && !(x.upload && x.upload.status === "done"));
    if(pending.length){ cardMsg_(productId, pending.some(x => x.upload && x.upload.status === "uploading") ? "Your design is still uploading — please wait a moment." : "Upload your design to add this to your cart."); return; }
    const isSized = productIsSized_(product);
    const base = cfgBasePrice_(product, color, isSized ? size : "");
    const unitPrice = base + picks.reduce((s, x) => s + (x.graphic.addOnCents || 0), 0) / 100;
    const config = { garmentColor: color, locations: picks.map(x => x.custom ? { location: x.location, custom: true, uploadId: x.upload.uploadId }
      : ({ location: x.location, graphicId: x.graphic.id, ink: x.ink || "" })) };
    const cdPreviews = cartDesignPreviews_(productId, picks.filter(x => x.custom).map(x => x.location), loc => (picks.find(x => x.location === loc) || {}).label || loc);
    const summary = (color ? color + " · " : "") + picks.map(x => `${x.label}: ${x.graphic.name}${x.ink ? " (" + x.ink + ")" : ""}`).join(" · ");
    // Optional personalization (typed name, or one of the product's preset words) on top of the graphics.
    const cPersEl = document.getElementById("pers-"+productId), cPersNameEl = document.getElementById("pers-name-"+productId);
    const cPersonalized = !!(cPersEl && cPersEl.checked);
    const cPersName = cPersonalized && cPersNameEl ? (cPersNameEl.value || "").trim() : "";
    if(cPersonalized && !cPersName){ cardMsg_(productId, cPersNameEl && cPersNameEl.tagName === "SELECT" ? "Choose a personalization option, or untick personalization." : "Type the name to embroider, or untick personalization."); return; }
    const cPersFee = cPersonalized ? (product.personalizationPrice || 0) : 0;
    cart.push({ productId, name: productCartName_(product), type: product.type, size: isSized ? size : "OSFA",
      qty, unitPrice, listUnitPrice: unitPrice, basePrice: base, personalized: cPersonalized, persName: cPersName, cfgText: summary, personalizationFee: cPersFee, lineTotal: (unitPrice + cPersFee) * qty, config,
      ...(cdPreviews.length ? { cdPreviews } : {}) });
    if(cPersEl){ cPersEl.checked = false; }
    if(cPersNameEl){ cPersNameEl.value = ""; cPersNameEl.style.display = "none"; }
    qtyEl.value = 1;
    renderTicket(currentOrg, route.org);
    scheduleShippingUpdate();
    announceStatus("Added " + product.name + " to cart. " + cartSummaryText());
    flashAdded_(productId);
    return;
  }

  const persEl = document.getElementById("pers-"+productId);
  const persNameEl = document.getElementById("pers-name-"+productId);
  const personalized = persEl && persEl.checked;
  const persName = personalized ? (persNameEl.value || "").trim() : "";
  if(personalized && !persName){ cardMsg_(productId, persNameEl && persNameEl.tagName === "SELECT" ? "Choose a personalization option, or untick personalization." : "Type the name to embroider, or untick personalization."); return; }

  // The customer's own design: required, or chosen with "Use my own design instead". The upload stays
  // picked after adding, so the same image can go on another size.
  const customOn = plainCustomOn_(product);
  const up = customOn ? customDesignUploads_[productId + "|" + CUSTOM_PLAIN_LOC] : null;
  if(customOn && !(up && up.status === "done")){
    cardMsg_(productId, up && up.status === "uploading" ? "Your design is still uploading — please wait a moment."
      : product.customDesign.required ? "Upload your design to order this item." : "Upload your design, or untick “Use my own design instead”.");
    return;
  }

  const unitPrice = priceFor(product, size) + (customOn ? customDesignAddOnCents_(product) / 100 : 0);
  const persPrice = (product.personalizationPrice != null) ? product.personalizationPrice : 0;
  const total = unitPrice*qty + (personalized ? persPrice*qty : 0);
  const cdPreviews = customOn ? cartDesignPreviews_(productId, [CUSTOM_PLAIN_LOC], () => "Your design") : [];

  cart.push({
    productId, name: productCartName_(product), type: product.type,
    size: productIsSized_(product) ? size : "OSFA",
    qty, unitPrice, listUnitPrice: unitPrice, basePrice: priceFor(product, size), personalized, persName,
    personalizationFee: personalized ? (product.personalizationPrice || 0) : 0,
    lineTotal: total,
    ...(customOn ? { customUploadId: up.uploadId, cdPreviews } : {})
  });

  qtyEl.value = 1;
  if(persEl){ persEl.checked = false; }
  if(persNameEl){ persNameEl.value=""; persNameEl.style.display="none"; }

  renderTicket(currentOrg, route.org);
  scheduleShippingUpdate();
  announceStatus("Added " + product.name + " to cart. " + cartSummaryText());
  flashAdded_(productId);
}

function removeFromCart(idx, orgId){
  revokeCartPreviews_(cart.splice(idx,1));
  checkoutMsg_ = "";
  renderTicket(currentOrg, orgId);
  scheduleShippingUpdate();
  announceStatus("Removed item from cart. " + cartSummaryText());
}

// Screen-reader-only summary announced via announceStatus() whenever the
// cart changes — the visible total already updates in the ticket panel,
// this just makes sure a screen reader user hears the same change.
function cartSummaryText(){
  if(cart.length === 0) return "Cart is empty.";
  const total = cart.reduce((s,c)=>s+c.lineTotal,0);
  return cart.length + (cart.length === 1 ? " item" : " items") + " in cart, total $" + total.toFixed(2) + ".";
}

// Sales tax the cart ADDS to the listed prices — only when the shop's prices don't include it
// (org.salesTaxMode "exclusive"; with tax-included prices there is nothing to add). Worked out the
// way the server does when the order is placed: per line, on taxable products, at the shop's rate,
// and not at all when the order ships to another state than the shop's (known here from the ZIP
// typed for shipping rates; pickup and the shop's own delivery options are in state). An estimate
// for display — the order's real figure is the server's (saveOrder returns it).
// `discount` (dollars, a discount code's): comes off the taxable goods in proportion, as the server takes the
// discount's tax share (its taxable part, taxed at the rate).
function cartTax_(org, delivery, rushFee, discount){
  const rate = Number(org && org.salesTaxRate) || 0;
  if(!org || org.salesTaxMode !== "exclusive" || !rate) return { added: false, tax: 0, outOfState: false };
  const home = org.salesTaxJurisdiction || "";
  const shipping = delivery && (delivery.kind === "quote" || delivery.kind === "manual");
  const zipSt = shipping && isUS_() ? zipStates_(shippingZip) : [];
  if(home && zipSt.length && !zipSt.includes(home)) return { added: true, tax: 0, outOfState: true };
  const bps = Math.round(rate * 100);
  let itemsCents = 0, taxableCents = 0;
  const cents = cart.reduce((sum, c) => {
    const p = (org.products || []).find(x => x.id === c.productId);
    const line = Math.round(c.lineTotal * 100);
    itemsCents += line;
    if(p && p.taxable === false) return sum;
    taxableCents += line;
    return sum + Math.round(line * bps / 10000);
  }, 0) + (org.rush && org.rush.taxable && rushFee > 0 ? Math.round(Math.round(rushFee * 100) * bps / 10000) : 0);   // a taxed rush fee
  const discountCents = Math.min(Math.round((Number(discount) || 0) * 100), itemsCents);
  const discountTaxCents = discountCents > 0 && itemsCents > 0 ? Math.round(Math.round(discountCents * taxableCents / itemsCents) * bps / 10000) : 0;
  return { added: true, tax: Math.max(0, cents - discountTaxCents) / 100, outOfState: false };
}
// The rush fee this shop offers (org.rush from /api/catalog: its own rule, else the global one) on
// `subtotal` dollars of merchandise: {fee, pending, text}. The server works it out the same way.
function rushQuote_(org, subtotal){
  const r = org && org.rush;
  if(!r || r.mode === "off") return null;
  const money = (n) => "$" + Number(n).toFixed(2).replace(/\.00$/, "");
  const pctFee = Math.round(Math.max(0, subtotal) * 100 * (Number(r.pct) || 0) / 100) / 100;
  if(r.mode === "follow"){
    const est = r.estLow != null && r.estHigh != null ? `usually ${money(r.estLow)}–${money(r.estHigh)}`
      : r.estLow != null ? `usually from ${money(r.estLow)}` : r.estHigh != null ? `usually up to ${money(r.estHigh)}` : "";
    return { fee: 0, pending: true, text: "Fee to follow" + (est ? " — " + est : "") + ". We'll confirm it and send it separately." };
  }
  if(r.mode === "fixed") return { fee: Number(r.amount) || 0, pending: false, text: "+" + money(r.amount) };
  if(r.mode === "percent") return { fee: pctFee, pending: false, text: `${Number(r.pct)}% of your items (+${money(pctFee)})` };
  const fee = Math.max(Number(r.amount) || 0, pctFee);
  return { fee, pending: false, text: `${money(r.amount)} or ${Number(r.pct)}% of your items, whichever is more (+${money(fee)})` };
}
function rushSectionHtml_(org, subtotal){
  const q = rushQuote_(org, subtotal);
  if(!q || cart.length === 0) return "";
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return `
    <div class="shipping-section rush-section">
      <div class="shipping-section-label">Need it sooner?</div>
      <label class="shipping-option"><input type="checkbox" id="rushOrder"${rushOn ? " checked" : ""} data-change="rush">
        <span>${escapeHtml(org.rush.label || "Rush my order")} <small>${escapeHtml(q.text)}</small></span></label>
      ${org.rush.note ? `<div class="rush-note">${escapeHtml(org.rush.note)}</div>` : ""}
      ${rushOn ? `<div class="rush-date"><label for="rushNeededBy" class="shipping-zip-label">Needed by (optional)</label>
        <input type="date" id="rushNeededBy" min="${today}" value="${escapeHtml(rushNeededBy)}" data-change="rush-date"></div>
        ${rushPayByHtml_(org, rushNeededBy, today)}` : ""}
    </div>`;
}
// With a needed-by date and a rule that sets one (migrations/0083): the date full payment must be received by —
// the server works it out the same way (rushPayByFor) — and that without it the date can't be guaranteed.
function rushPayByDate_(org, neededBy, today){
  const days = org && org.rush ? org.rush.payByDays : null;
  if(!Number.isInteger(days) || !/^\d{4}-\d{2}-\d{2}$/.test(String(neededBy || ""))) return "";
  const d = new Date(neededBy + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - days);
  const day = d.toISOString().slice(0, 10);
  return today && day < today ? today : day;
}
function rushPayByHtml_(org, neededBy, today){
  const day = rushPayByDate_(org, neededBy, today);
  if(!day) return "";
  const nice = new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  return `<div class="rush-payby" id="rushPayByNote">Full payment must be received by ${escapeHtml(nice)}. If it isn't, we can't guarantee this date.</div>`;
}
function setRush_(on){
  rushOn = !!on;
  if(!rushOn) rushNeededBy = "";
  if(currentOrg && currentOrgId) renderTicket(currentOrg, currentOrgId);
}

// The order panel and the invoice page are redrawn whole (innerHTML) on every quantity change, delivery
// or payment choice and rate update, which used to drop keyboard focus to the top of the page. This notes
// which control inside `root` has focus (by id, by its data-action + line, or by radio name + value, else
// by its place in the panel), and the returned function puts focus — and the text cursor — back on the
// matching control after the redraw. When that control is gone (a removed line) focus goes to the one now
// in its place, else the panel's heading. When it's there but disabled while busy ("Getting rates…"),
// focus waits on the control just before it and goes back to it on the next redraw, once it's enabled.
// Nothing happens when focus was outside `root`.
const FOCUSABLE_ = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
let focusPending_ = null;   // { key, placed }: a busy control whose focus is being held next to it
function keepFocus_(root){
  const el = document.activeElement;
  let key = null;
  if(focusPending_ && el && focusPending_.placed === el && el.isConnected && root && root.contains(el)) key = focusPending_.key;
  focusPending_ = null;
  if(!key){
    if(!root || !el || el === root || !root.contains(el)) return () => {};
    const all = [...root.querySelectorAll(FOCUSABLE_)];
    key = { id: el.id || "", action: el.getAttribute("data-action") || "", idx: el.getAttribute("data-idx"), d: el.getAttribute("data-d"),
      name: el.getAttribute("name") || "", value: el.value, type: el.type || "", order: all.indexOf(el), caret: null };
    try{ if(typeof el.selectionStart === "number") key.caret = [el.selectionStart, el.selectionEnd]; }catch(_){}
  }
  return function restore(){
    const now = [...root.querySelectorAll(FOCUSABLE_)];
    const usable = (x) => !!x && !x.disabled && !x.hidden && !x.closest("[hidden]");
    let target = null, holding = false;
    if(key.id) target = now.find(x => x.id === key.id);
    if(!target && key.action) target = now.find(x => x.getAttribute("data-action") === key.action && x.getAttribute("data-idx") === key.idx && x.getAttribute("data-d") === key.d);
    if(!target && key.name && (key.type === "radio" || key.type === "checkbox")) target = now.find(x => x.getAttribute("name") === key.name && x.value === key.value);
    if(target && !usable(target)){
      // A "+" that just reached its limit: its line's "−" is the nearest control.
      const sameLine = key.action ? now.find(x => usable(x) && x.getAttribute("data-action") === key.action && x.getAttribute("data-idx") === key.idx) : null;
      if(sameLine) target = sameLine;
      else {
        const pos = now.indexOf(target);
        target = now.slice(0, pos).reverse().find(usable) || now.find(usable) || null;
        holding = !!target;
      }
    }
    if(!usable(target) && key.order >= 0){
      const live = now.filter(usable);
      target = live[Math.min(key.order, live.length - 1)] || null;
    }
    if(!usable(target)){
      target = root.querySelector("h1, h2");
      if(target && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    }
    if(!target) return;
    try{ target.focus({ preventScroll: true }); }catch(_){ target.focus(); }
    if(holding) focusPending_ = { key, placed: target };
    else if(key.caret && key.id && target.id === key.id && typeof target.setSelectionRange === "function"){
      try{ target.setSelectionRange(key.caret[0], key.caret[1]); }catch(_){}
    }
  };
}

function renderTicket(org, orgId){
  // Every change to the cart comes through here: the quantity breaks follow the pieces now in it.
  cartReprice_();
  saveCart_();
  const panel = document.getElementById("ticketPanel");
  if(!panel) return;
  // The phone cart bar (fixed at the bottom; scrolls to this panel) and the item count.
  const pieces = cart.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const bar = document.getElementById("cartBar");
  if(bar){
    bar.hidden = cart.length === 0;
    bar.textContent = "View cart (" + pieces + ") · $" + cart.reduce((s,c) => s + c.lineTotal, 0).toFixed(2);
    document.body.classList.toggle("has-cart-bar", cart.length > 0);
  }

  const piecesOf = cartPiecesByProduct_();
  const lines = cart.map((c,idx)=>`
    <div class="cart-line">
      <div class="l-desc">
        ${escapeHtml(c.name)}${(c.size && c.size !== "OSFA") ? " · size "+escapeHtml(c.size) : ""}
        ${c.personalized ? `<small>+ personalization: "${escapeHtml(c.persName) || "—"}"</small>` : ""}
        ${c.config ? `<small>${escapeHtml(c.cfgText || "")}</small>` : ""}
        ${(c.cdPreviews || []).map(d => `<small class="cd-cart">${d.url ? `<img src="${escapeHtml(d.url)}" alt="" width="32" height="32">` : ""}${escapeHtml(d.label)}: ${escapeHtml(d.fileName)}</small>`).join("")}
        <div class="l-qty">
          <button type="button" class="qty-step" data-action="qty" data-idx="${idx}" data-d="-1" aria-label="One fewer ${escapeHtml(c.name)}">&minus;</button>
          <span aria-label="Quantity">${c.qty}</span>
          <button type="button" class="qty-step" data-action="qty" data-idx="${idx}" data-d="1" aria-label="One more ${escapeHtml(c.name)}"${c.qty >= 50 ? " disabled" : ""}>+</button>
          <span>&times; $${cartUnit_(c).toFixed(2)} each${c.breakOff > 0 ? ` <span class="cart-was">(was <del>$${(cartUnit_(c) + c.breakOff).toFixed(2)}</del>)</span>` : ""}</span>
        </div>
        ${c.breakOff > 0 ? `<small class="qty-break-on">Quantity price: ${c.breakMin}+ pieces, $${Number(c.breakOff).toFixed(2)} off each</small>` : ""}
        ${cartNextBreakHtml_(c, idx, piecesOf)}
      </div>
      <div class="l-price">$${c.lineTotal.toFixed(2)}<button class="remove-x" data-action="remove" data-idx="${idx}" data-org="${orgId}" aria-label="Remove ${escapeHtml(c.name)}">&times;</button></div>
    </div>
  `).join("");

  const cartSubtotal = cart.reduce((s,c) => s+c.lineTotal, 0);
  // What the quantity breaks take off, in cents (shown under the lines; the subtotal already has it).
  const breakSavingsCents = cart.reduce((s, c) => s + Math.round(Number(c.breakOff || 0) * 100) * (Number(c.qty) || 0), 0);
  const delivery = currentDelivery_(org);
  const rush = rushOn ? rushQuote_(org, cartSubtotal) : null;
  if(rushOn && !rush) rushOn = false;      // the shop stopped offering it
  const rushFee = rush ? rush.fee : 0;
  // A discount code: off the goods only (not delivery, not the rush fee). Not shown for a shop without the box.
  if(!discountBoxOn_(org) || !cart.length){ if(discountApplied_) discountApplied_ = null; }
  else if(discountApplied_ && discountApplied_.some(e => e.sig !== discountCartSig_())) scheduleDiscountRecheck_();
  const discount = discountNow_(cartSubtotal);
  // A free-shipping code: the delivery fee is not charged (the line below says so); the server does the same.
  const shippingFull = delivery.fee;
  const freeShip = discountFreeShipping_() && shippingFull > 0;
  const shippingCost = freeShip ? 0 : shippingFull;
  const cartTax = cartTax_(org, delivery, rushFee, discount);
  const grandTotal   = Math.round((cartSubtotal - discount + shippingCost + rushFee + cartTax.tax) * 100) / 100;
  // Gift cards pay part or all of the total (a payment after the codes, shipping and tax).
  const giftPlan = giftBoxOn_(org) && cart.length ? giftPlan_(grandTotal).filter(p => p.take > 0) : [];
  const giftTakenCents = giftPlan.reduce((s, p) => s + Math.round(p.take * 100), 0);
  const stillToPay = Math.max(0, Math.round(grandTotal * 100) - giftTakenCents) / 100;
  const giftAll = giftCovers_(org, delivery, rush);

  // Check the currently-selected payment method to decide whether to
  // show the discounted total. Reading from the DOM directly here since
  // renderTicket is called on every cart change, including before the
  // checkout fields are rendered (when cart is empty).
  const paymentEl = document.getElementById("custPaymentMethod");
  const paymentMethod = paymentEl ? paymentEl.value : "";
  const discountEligible = CASH_DISCOUNT_PERCENT && (paymentMethod === "Zelle" || paymentMethod === "Check");
  const discountedTotal = discountEligible ? grandTotal * (1 - CASH_DISCOUNT_PERCENT / 100) : null;

  const totalHtml = discountedTotal !== null
    ? `<div class="t-label">Total<br><small style="font-size:10px; letter-spacing:.04em;">${CASH_DISCOUNT_PERCENT}% discount applied</small></div>
       <div class="t-amount">
         <span style="font-size:14px; text-decoration:line-through; opacity:.45; margin-right:6px;">$${grandTotal.toFixed(2)}</span>$${discountedTotal.toFixed(2)}
       </div>`
    : `<div class="t-label">Total</div><div class="t-amount">$${grandTotal.toFixed(2)}</div>`;
  // Tax-included pricing must be disclosed to the buyer; tax added on top gets its own row in the
  // breakdown below, and a line saying so.
  const taxWhat = `${escapeHtml(String(org.salesTaxRate))}% ${escapeHtml(org.salesTaxJurisdiction || "")}`.trim() + " sales tax";
  const taxNote = cart.length > 0 && org.salesTaxRate && cartTax.added
    ? `<div class="ticket-tax-note" style="font-size:12px;opacity:.7;margin-top:4px;">${cartTax.outOfState
        ? `No ${escapeHtml(org.salesTaxJurisdiction || "")} sales tax on orders shipped to another state.`
        : `${taxWhat} is added to the listed prices${offersShipping_(org) ? "; shipping is not taxed" : (shippingCost > 0 ? "; the delivery fee is not taxed" : "")}.`}</div>`
    : cart.length > 0 && org.salesTaxRate
    ? `<div class="ticket-tax-note" style="font-size:12px;opacity:.7;margin-top:4px;">Prices include ${escapeHtml(String(org.salesTaxRate))}% ${escapeHtml(org.salesTaxJurisdiction || "")} sales tax${offersShipping_(org) ? "; shipping is not taxed" : (shippingCost > 0 ? "; the delivery fee is not taxed" : "")}.</div>`
    : "";

  // When shipping is active, show a breakdown above the total line so the
  // customer can see merchandise vs. shipping separately.
  const breakdownHtml = (shippingCost > 0 || freeShip || cartTax.tax > 0 || rush || discount > 0) ? `
    <div class="ticket-breakdown">
      <div class="ticket-breakdown-line"><span>Merchandise</span><span>$${cartSubtotal.toFixed(2)}</span></div>
      ${discount > 0 ? `<div class="ticket-breakdown-line ticket-discount-line"><span>Discount (${escapeHtml(discountCodesOf_(e => e.discount > 0) || discountCodesOf_())})</span><span>&minus;$${discount.toFixed(2)}</span></div>` : ""}
      ${freeShip ? `<div class="ticket-breakdown-line ticket-discount-line ticket-freeship-line"><span>Free shipping (${escapeHtml(discountCodesOf_(e => e.freeShipping))})</span><span>$0.00</span></div>` : ""}
      ${shippingCost > 0 ? `<div class="ticket-breakdown-line">
        <span>${escapeHtml(delivery.label)}</span>
        <span>$${shippingCost.toFixed(2)}</span>
      </div>` : ""}
      ${rush ? `<div class="ticket-breakdown-line"><span>Rush fee</span><span>${rush.pending ? "to follow" : "$" + rushFee.toFixed(2)}</span></div>` : ""}
      ${cartTax.tax > 0 ? `<div class="ticket-breakdown-line ticket-tax-line"><span>Sales tax (${escapeHtml(String(org.salesTaxRate))}%)</span><span>$${cartTax.tax.toFixed(2)}</span></div>` : ""}
    </div>` : "";

  // Save the current payment selection and whatever the customer has
  // already typed before re-rendering — innerHTML replaces these
  // elements entirely, which would otherwise wipe them on every cart
  // change or payment-method switch.
  const savedPayment = paymentEl ? paymentEl.value : "";
  const nameEl = document.getElementById("custName");
  const contactEl = document.getElementById("custContact");
  const savedName = nameEl ? nameEl.value : "";
  const savedContact = contactEl ? contactEl.value : "";
  const restoreFocus = keepFocus_(panel);

  panel.innerHTML = `
    <h2>Your order${pieces ? ` <span class="mono" style="font-size:.7em;opacity:.7;">(${pieces} ${pieces === 1 ? "item" : "items"})</span>` : ""}</h2>
    ${cart.length===0 ? '<div class="cart-empty">Nothing added yet.</div>' : lines}
    ${breakSavingsCents > 0 ? `<div class="cart-savings" style="font-size:13px;margin:6px 0;">Quantity savings: $${(breakSavingsCents / 100).toFixed(2)} (already taken off the prices above)</div>` : ""}
    ${renderShippingSection(org)}
    ${rushSectionHtml_(org, cartSubtotal)}
    ${discountSectionHtml_(org)}
    ${giftSectionHtml_(org)}
    ${breakdownHtml}
    <div class="ticket-total">
      ${totalHtml}
    </div>
    ${giftPlan.length ? `<div class="ticket-breakdown ticket-gift">
      ${giftPlan.map(p => `<div class="ticket-breakdown-line ticket-gift-line"><span>Gift card ••${escapeHtml(p.card.last4)}</span><span>&minus;$${p.take.toFixed(2)}</span></div>`).join("")}
      <div class="ticket-breakdown-line ticket-topay-line"><span>Still to pay</span><span>$${stillToPay.toFixed(2)}</span></div>
    </div>` : ""}
    ${taxNote}
    <div class="checkout-fields">
      <input type="text" id="custName" placeholder="Your name" aria-label="Your name" value="${escapeHtml(savedName)}">
      <input type="email" id="custContact" required placeholder="Email address" aria-label="Email address" value="${escapeHtml(savedContact)}">
      ${marketingBoxHtml_(currentOrg)}
      ${(function(){
        // Net 30 joins the shop's methods only for an address the server said yes to (checkNet30_).
        const net30 = net30Offered_(currentOrg);
        const methods = (currentOrg.enabledPayments || []).filter(m => m !== NET30_METHOD_).concat(net30 ? [NET30_METHOD_] : []);
        if(giftAll) return '<div class="form-hint gift-covers" id="paymentHint" role="status">Your gift card covers it — there\'s nothing to pay.</div>';
        if(methods.length === 0) return '<div class="form-hint">Payment is handled separately — your order will be recorded and we\'ll follow up with payment details.</div>';
        const labels = {"Card":"Credit / Debit Card","Venmo":"Venmo","Zelle":"Zelle","Check":"Check","Net 30":"Net 30 (pay by invoice)"};
        const opts = methods.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(labels[m] || m)}</option>`).join("");
        return `<select id="custPaymentMethod" aria-label="Payment method" data-change="payment-method">
        <option value="">How will you pay?</option>
        ${opts}
      </select>
      ${net30 ? net30PoHtml_(savedPayment === NET30_METHOD_) : ""}
      <div class="form-hint" id="paymentHint">Choose how you'll pay — you'll see how to pay after you place the order.</div>`;
      })()}
      <div class="checkout-msg" id="checkoutMsg" role="alert"${checkoutMsg_ ? "" : " hidden"}>${escapeHtml(checkoutMsg_)}</div>
      <button class="place-order-btn" id="placeOrderBtn" ${cart.length===0 ? "disabled":""} data-action="place-order" data-org="${orgId}">Place order</button>
    </div>
  `;

  // Restore the payment method selection (if the select exists — it's omitted
  // when no payment methods are enabled) and update the hint.
  if(savedPayment){
    const newSelect = document.getElementById("custPaymentMethod");
    if(newSelect){
      newSelect.value = savedPayment;
      // What the select really holds: a method no longer offered (Net 30 after the email changed) leaves it blank, and
      // the hint follows it rather than describing the method that went.
      updatePaymentHint(newSelect.value, true); // skipTicketRender=true to avoid recursion
    }
  }
  restoreFocus();
}

/* ---------------- backend (/api) ---------------- */
// ---- Turnstile (bot check on order submission) ----
// Only active when /api/catalog hands us a site key (i.e. the server has
// TURNSTILE_SECRET_KEY set). The script loads lazily at submit time, so
// visitors who never place an order never fetch it.
let _turnstileLoad = null;
function loadTurnstile(){
  if(_turnstileLoad) return _turnstileLoad;
  _turnstileLoad = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => { _turnstileLoad = null; reject(new Error("Could not load the bot check")); };
    document.head.appendChild(s);
  });
  return _turnstileLoad;
}
// `container`: where the challenge shows, when it isn't the order button's (a design upload's box).
async function getTurnstileToken(container){
  const siteKey = currentOrg && currentOrg.turnstileSiteKey;
  if(!siteKey) return null;
  const ts = await loadTurnstile();
  let box = container || document.getElementById("turnstileBox");
  if(!box){
    box = document.createElement("div");
    box.id = "turnstileBox";
    box.style.marginTop = "10px";
    const btn = document.getElementById("placeOrderBtn");
    (btn && btn.parentNode ? btn.parentNode : document.body).appendChild(box);
  }
  box.innerHTML = "";
  return new Promise((resolve, reject) => {
    ts.render(box, {
      sitekey: siteKey,
      appearance: "interaction-only",
      callback: (t) => resolve(t),
      "error-callback": () => reject(new Error("Bot check failed — please try again")),
      "expired-callback": () => reject(new Error("Bot check expired — please try again")),
    });
  });
}

async function saveOrder(order){
  const turnstileToken = await getTurnstileToken();
  if(turnstileToken) order = Object.assign({}, order, { turnstileToken });
  const res = await fetch("/api/orders", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(order)
  });
  // Throw on ANY failure — an HTTP error or a {status:"error"} body sent
  // with HTTP 200. placeOrder() treats a throw as "order NOT recorded": it
  // keeps the cart and never shows the confirmation page, instead of
  // silently pretending the order went through.
  if(!res.ok){
    const errText = await res.text().catch(()=>"");
    console.error("Order submission failed — HTTP " + res.status, errText);
    // Surface the server's own message (e.g. "Shipping quote expired —
    // please refresh shipping rates") rather than a bare status code.
    let serverMsg = "";
    try{ serverMsg = (JSON.parse(errText) || {}).message || ""; }catch(_){}
    // `refused`: the server answered and turned the order down (a 4xx with its reason), so nothing was
    // recorded. A 5xx or no answer at all can't say that — the order may have been saved before it failed.
    throw Object.assign(new Error(serverMsg || ("Order submission failed (HTTP " + res.status + ")")), { refused: res.status < 500 && !!serverMsg });
  }
  const data = await res.json().catch(() => null);
  if(data && data.status === "error"){
    throw Object.assign(new Error(data.message || "Order submission failed"), { refused: true });
  }
  return data || {};   // when sales tax is added on top: the order's real {total, salesTax}
}

// One order id per checkout attempt (placeOrder): kept — in this tab, across a reload — until the order is saved or
// the cart, details or delivery change, so a retry after a lost answer sends the same order again.
let pendingOrderAttempt_ = null;
function orderIdForAttempt_(prefix, signature){
  if(!pendingOrderAttempt_){ try{ pendingOrderAttempt_ = JSON.parse(sessionStorage.getItem("pendingOrderAttempt") || "null"); }catch(_){} }
  if(pendingOrderAttempt_ && pendingOrderAttempt_.sig === signature && pendingOrderAttempt_.id) return pendingOrderAttempt_.id;
  const id = prefix + "-" + Date.now().toString(36).toUpperCase() + "-" + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase();
  pendingOrderAttempt_ = { id, sig: signature };
  try{ sessionStorage.setItem("pendingOrderAttempt", JSON.stringify(pendingOrderAttempt_)); }catch(_){}
  return id;
}
function clearOrderAttempt_(){
  pendingOrderAttempt_ = null;
  try{ sessionStorage.removeItem("pendingOrderAttempt"); }catch(_){}
}

async function placeOrder(orgId){
  if(currentOrg && currentOrg.preview){ showToast("This is a preview of unpublished changes — ordering is off here.", true); return; }
  const name = document.getElementById("custName").value.trim();
  const contact = document.getElementById("custContact").value.trim();
  const paymentEl = document.getElementById("custPaymentMethod");
  const paymentMethod = paymentEl ? paymentEl.value : "";
  checkoutError_("");
  if(!name){ checkoutError_("Please add your name.", "custName"); return; }
  if(!contact || !contact.includes("@") || !contact.includes(".")){
    checkoutError_("Please add a valid email address — your order details are sent there.", "custContact");
    return;
  }
  const enabledPayments = (currentOrg && currentOrg.enabledPayments) || [];
  // Gift cards that cover everything: nothing to pay, so no payment method to choose.
  const giftAllNow = giftCovers_(currentOrg, currentDelivery_(currentOrg), rushOn ? rushQuote_(currentOrg, cart.reduce((s, c) => s + c.lineTotal, 0)) : null);
  if(enabledPayments.length > 0 && !paymentMethod && !giftAllNow){
    checkoutError_("Please choose how you'll pay.", "custPaymentMethod");
    return;
  }
  if(cart.length===0) return;
  // Net 30 chosen while the address was being changed: ask about this address before sending it (the server decides
  // again anyway, and refuses with its own sentence).
  const net30Chosen = paymentMethod === NET30_METHOD_ && !giftAllNow;
  if(net30Chosen && !net30Offered_(currentOrg)){
    await checkNet30_();
    if(!net30Offered_(currentOrg)){
      checkoutError_("Net 30 isn't available for this email address — please choose another way to pay.", "custPaymentMethod");
      return;
    }
  }
  const poEl = document.getElementById("custPoNumber");
  if(poEl) net30Po_ = poEl.value.slice(0, NET30_PO_MAX_);
  const poNumber = net30Chosen ? net30Po_.trim() : "";
  // A code typed but not applied isn't sent unseen: the customer sees what it does (or why not) first.
  const codeBoxOn = discountBoxOn_(currentOrg);
  if(codeBoxOn && discountInput_.trim() && (!discountApplied_ || discountMulti_(currentOrg))){
    checkoutError_(discountBusy_ ? "Checking your discount code — one moment." : "Press Apply to use your discount code, or clear the box to order without it.", "discountCodeInput");
    return;
  }
  const discountCodeList = codeBoxOn && discountApplied_ ? discountApplied_.map(e => e.code) : [];
  const discountCode = discountCodeList.join(", ");
  // What the codes do to shipping, for the confirmation (the server takes it off the order's shipping itself).
  const freeShipCodes = codeBoxOn ? discountCodesOf_(e => e.freeShipping) : "";
  const freeShipNow = !!freeShipCodes;

  // When the customer chose carrier shipping OR manual shipping is pending,
  // collect their full address before submission so the admin knows where to ship.
  let shippingAddress = null;
  let orderShippingCost = 0;
  const delivery = currentDelivery_(currentOrg);
  if(delivery.kind === "none"){
    // The shop only ships (no pickup, no options of its own) and no rate is chosen yet.
    checkoutError_(offersShipping_(currentOrg) ? `Enter your ${isUS_() ? "ZIP" : "postal code"} under Delivery and choose a shipping rate.` : "Please choose a delivery option.", "shippingZipInput");
    return;
  }
  if(delivery.kind === "quote" || delivery.kind === "manual"){
    shippingAddress = await collectShippingAddress(delivery.kind === "quote" ? (shippingQuotedZip || shippingZip) : "");
    if(!shippingAddress) return; // user cancelled the address modal
  }
  orderShippingCost = delivery.fee;
  const manualNow = delivery.kind === "manual";

  cartReprice_();   // current already from the last redraw; this keeps the lines sent and the total shown in step
  const cartSubtotal = cart.reduce((s,c) => s+c.lineTotal, 0);
  // Rush: asked for here; the server prices it from the shop's rule (this is only what the page showed).
  const rush = rushOn ? rushQuote_(currentOrg, cartSubtotal) : null;
  const neededByEl = document.getElementById("rushNeededBy");
  if(neededByEl) rushNeededBy = neededByEl.value;
  // The gift cards and what each is to pay of the total as the page worked it out (the server redeems each up to what is
  // really due and answers what it took). After the codes, shipping and tax; always allowed alongside a code.
  const giftPlanNow = giftBoxOn_(currentOrg) ? giftPlan_(cartGrand_(currentOrg, delivery, rush)).filter(p => p.take > 0) : [];
  const _orderPrefix = ((orgId || "ORD").replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase()) || "ORD";
  // The same order id for the same checkout (same cart, details and delivery) until it's saved: a retry after a
  // lost answer resends THIS order, which the server recognises, instead of placing a second one.
  const _attemptSig = JSON.stringify([orgId, name, contact, paymentMethod, cart.map(({ cdPreviews, ...line }) => line),
    delivery.kind, delivery.label || "", delivery.kind === "option" ? delivery.option.id : null, shippingAddress, orderShippingCost, !!rush, rushNeededBy || "", discountCode,
    giftPlanNow.map(p => [p.card.last4, p.take]), poNumber]);   // never the card numbers: this record is kept in the tab's session storage
  const order = {
    orderId: orderIdForAttempt_(_orderPrefix, _attemptSig),
    orgId, customerName: name, contact, paymentMethod,
    // The design previews are this page's own object URLs — never sent.
    items: cart.map(({ cdPreviews, ...line }) => line),
    subtotal: cartSubtotal,
    shippingCost: orderShippingCost,
    shippingAddress,
    shippingMethod: delivery.kind === "quote" ? delivery.label : (delivery.kind === "option" && delivery.option.type === "custom" ? delivery.label : ""),
    // Local pickup or one of the shop's own options; the server looks the fee up from the shop's list.
    deliveryOptionId: delivery.kind === "option" ? delivery.option.id : null,
    // The server ignores shippingCost above and charges only what this
    // signed quote (from /api/shipping) says — see functions/_lib/quoteToken.js.
    shippingQuoteToken: delivery.kind === "quote" ? (shippingQuote.quoteToken || null) : null,
    manualShipping: manualNow,
    totalWeightOz: cart.reduce((s, it) => {
      const p = currentOrg && (currentOrg.products || []).find(p => p.id === it.productId);
      return s + ((p && p.weightOz) ? p.weightOz * it.qty : 8 * it.qty);
    }, 0),
    // What the cart showed (the server prices the order itself and ignores this).
    total: cartGrand_(currentOrg, delivery, rush),
    // The discount codes (migrations/0115, 0120): the server checks each again, works out the discount and records the
    // uses. One code goes as `discountCode` (as ever), more than one as the list `discountCodes`.
    ...(discountCodeList.length === 1 ? { discountCode, discount: discountNow_(cartSubtotal) } : {}),
    ...(discountCodeList.length > 1 ? { discountCodes: discountCodeList, discount: discountNow_(cartSubtotal) } : {}),
    // Gift cards (migrations/0120): number and the amount the page showed it paying (dollars).
    ...(giftPlanNow.length ? { giftCards: giftPlanNow.map(p => ({ code: p.card.code, amount: p.take })) } : {}),
    // Shop news and discounts (migrations/0117): only sent when the box was shown.
    ...(marketingBoxOn_(currentOrg) ? { marketingOptIn: !!marketingOptIn_ } : {}),
    ...(rush ? { rush: true, rushFee: rush.fee, rushFeePending: rush.pending } : {}),
    ...(rush && rushNeededBy ? { neededBy: rushNeededBy } : {}),
    // Net 30 (migrations/0121): the server checks the address allows it and saves the PO as typed by the customer —
    // staff accept it before the order counts as cleared for work.
    ...(net30Chosen && poNumber ? { poNumber } : {}),
    placedAt: new Date().toISOString(),
    paid: false
  };

  // Disable button to prevent double-submission
  const btn = document.getElementById("placeOrderBtn");
  if(btn){ btn.disabled = true; btn.textContent = "Processing…"; }

  let saved = null;
  try{
    saved = await saveOrder(order);
    clearOrderAttempt_();   // saved: the next checkout is a new order
    lastShipAddr_ = null;   // and the address box starts empty for it
    // Tax added on top: the confirmation (and the Venmo/Zelle amount) uses the recorded total.
    if(saved && typeof saved.total === "number"){ order.total = saved.total; order.salesTax = saved.salesTax; }
    // A discount code: what the server took off, and what's still to pay (0 when the code covers it all).
    if(saved && typeof saved.discount === "number"){
      order.discount = saved.discount;
      order.discountCode = String(saved.discountCode || (Array.isArray(saved.discountCodes) ? saved.discountCodes.join(", ") : "") || discountCode);
    }
    if(freeShipNow) order.freeShippingCodes = freeShipCodes;
    if(saved && typeof saved.owed === "number") order.owed = saved.owed;
    // Net 30: the days the invoice gives (the server's word when it says, else what checkNet30 said).
    if(net30Chosen){
      order.termsDays = net30Days_(saved && saved.termsDays) || net30Days_(net30_.termsDays);
      net30Po_ = "";
    }
    // Gift cards: what each took (a card the server turned down is told to the customer; the rest is paid the usual way).
    if(giftPlanNow.length){
      const got = Array.isArray(saved && saved.giftCards) ? saved.giftCards : [];
      order.giftCardUse = giftPlanNow.map((p, i) => {
        const g = got[i] || got.find(x => x && String(x.last4) === p.card.last4) || null;
        // No word from the server about this card: it is taken to have paid what the page showed.
        let taken = p.take, refused = false, reason = "";
        if(g){
          if(typeof g.taken === "number") taken = g.taken;
          else if(typeof g.takenCents === "number") taken = g.takenCents / 100;
          else if(g.ok === false) taken = 0;
          reason = String(g.reason || "");
          refused = g.ok === false || !(taken > 0);
        }
        return { last4: p.card.last4, taken, refused, reason };
      });
      order.giftTaken = Math.round(order.giftCardUse.reduce((s, u) => s + Math.round(u.taken * 100), 0)) / 100;
    }
    // No email set up on this install: the confirmation doesn't promise a copy by email.
    if(saved && saved.emailOn === false) order.noEmail = true;
  }catch(err){
    // No confirmation page (and no hand-off to Stripe) without the server's word that the order exists.
    // The cart is left intact for a retry, which resends the same order id (orderIdForAttempt_), so trying
    // again can't place it twice. Only a refusal from the server means nothing was recorded; with no answer
    // (a dropped connection, a server error) the order may well have been saved.
    console.error("Could not save order", err);
    checkoutError_(err && err.refused
      ? "Sorry — your order could not be submitted" + (err.message ? " (" + err.message + ")" : "") +
        ". Nothing was recorded; your cart is unchanged. Please try again in a moment."
      : "We couldn't confirm your order went through. Your cart is unchanged — please press Place order again; if the first try did reach us, it won't be placed twice.");
    if(btn){ btn.disabled = false; btn.textContent = "Place order"; }
    return;
  }

  // Card payment: create a Stripe Checkout Session server-side and
  // redirect the customer to Stripe's hosted payment page. On success
  // Stripe sends a webhook that records the payment on the order.
  // No `total` sent here — /api/checkout looks up the real, server-
  // calculated balance from the database itself (the saveOrder()
  // call above just wrote it), never trusting a client-supplied amount.
  // Nothing left to pay (a code took it all off): no card step — the confirmation says so.
  if(paymentMethod === "Card" && enabledPayments.includes("Card") && !manualNow && order.owed !== 0){
    try{
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        // checkoutToken: the order endpoint's proof that this browser placed this order (http.js).
        body: JSON.stringify({
          orderId: order.orderId, orgId,
          checkoutToken: (saved && saved.checkoutToken) || null
        })
      });
      const data = await res.json();
      if(data.url){
        // The order exists now: remember it (so Cancel on Stripe offers to pay it, not to order again) and
        // empty the cart, then hand off to Stripe's hosted payment page.
        writePendingCard_(orgId, { orderId: order.orderId, token: (saved && saved.checkoutToken) || null, total: payDue_(order) });
        clearCart_(); saveCart_(); discountReset_();
        window.location.href = data.url;
        return;
      }
      console.error("Stripe checkout session failed:", data);
      // The order is saved; only the card step failed. Show it as placed, with how to pay.
      clearCart_(); saveCart_(); discountReset_();
      unpaidCardNotice = (saved && saved.checkoutToken) ? { orderId: order.orderId, token: saved.checkoutToken, total: payDue_(order) } : null;
      showConfirmation(orgId, Object.assign({}, order, { cardStartFailed: true }));
      return;
    }catch(err){
      console.error("Stripe checkout error:", err);
      clearCart_(); saveCart_(); discountReset_();
      unpaidCardNotice = (saved && saved.checkoutToken) ? { orderId: order.orderId, token: saved.checkoutToken, total: payDue_(order) } : null;
      showConfirmation(orgId, Object.assign({}, order, { cardStartFailed: true }));
      return;
    }
  }

  clearCart_(); saveCart_(); checkoutMsg_ = ""; discountReset_();
  rushOn = false; rushNeededBy = "";
  showConfirmation(orgId, order);
}

// Updates the displayed price for a product when the size or personalization
// changes — shows the true per-unit price (base + personalization if checked).
function updateProductPrice(productId){
  const priceEl = document.getElementById("price-" + productId);
  const sizeEl  = document.getElementById("size-" + productId);
  const persEl  = document.getElementById("pers-" + productId);
  if(!priceEl || !activeCatalog) return;
  const product = activeCatalog.products.find(p => p.id === productId);
  if(!product) return;
  const base = !productIsSized_(product)
    ? product.flatPrice
    : (sizeEl ? priceFor(product, sizeEl.value) : null);
  if(base == null) return;
  const personalized = persEl && persEl.checked;
  const persFee = (personalized && product.personalizationPrice != null) ? product.personalizationPrice : 0;
  const customFee = plainCustomOn_(product) ? customDesignAddOnCents_(product) / 100 : 0;
  priceEl.textContent = "$" + (base + persFee + customFee).toFixed(2);

  // Update the stock badge for the newly selected size.
  const stockWrap = document.getElementById("stock-" + productId);
  if(stockWrap) stockWrap.innerHTML = readyBadgeHtml_(product, "", productIsSized_(product) && sizeEl ? sizeEl.value : "");
}

// Updates the payment hint text dynamically when the customer changes
// their payment method selection, showing relevant instructions inline.
function updatePaymentHint(method, skipTicketRender){
  const hint = document.getElementById("paymentHint");
  if(!hint) return;

  const hints = {
    "Card": "You’ll be redirected to Stripe’s secure checkout to enter your card details.",
    "Venmo": "After placing your order, you’ll get a pre-filled Venmo link to send payment.",
    "Zelle": business.zelle ? `Send payment to ${business.zelle} — include your order number in the memo.` : "After placing your order, you’ll be contacted with Zelle details.",
    "Check": `Make check payable to “${business.legalName || bizName_()}”` + (business.mailingAddress ? ` and mail to ${business.mailingAddress}.` : " — you’ll be told where to send it.")
  };
  const days = net30Days_(net30_.termsDays);
  hints[NET30_METHOD_] = "No payment now — we'll send you an invoice" + (days ? ", due within " + days + " days" : "") + ".";
  // The PO box belongs to Net 30: shown while it's chosen (what was typed is kept if the customer switches back).
  const poWrap = document.getElementById("net30PoWrap");
  if(poWrap) poWrap.hidden = method !== NET30_METHOD_;
  const baseHint = hints[method] || "Choose how you'll pay — you'll see how to pay after you place the order.";
  const discountNote = (CASH_DISCOUNT_PERCENT && (method === "Zelle" || method === "Check"))
    ? " A " + CASH_DISCOUNT_PERCENT + "% discount applies — mention this when sending payment."
    : "";
  hint.textContent = baseHint + discountNote;

  // Re-render the ticket total so the discount (if any) appears/disappears
  // immediately when the payment method changes, without waiting for an add.
  // Skip when called from renderTicket itself to avoid infinite recursion.
  if(!skipTicketRender){
    if(currentOrg && currentOrgId) renderTicket(currentOrg, currentOrgId);
  }
}

// Builds a Venmo deep link with the amount and a short note pre-filled.
// This is just a link (venmo.com/u/...), not an API call — the customer
// still has to open it and tap confirm themselves. Returns null if
// VENMO_USERNAME isn't configured.
function venmoPayLink(order){
  if(!VENMO_USERNAME) return null;
  const note = `${order.orgId} order ${order.orderId}`;
  return `https://venmo.com/u/${encodeURIComponent(VENMO_USERNAME)}` +
    `?txn=pay&amount=${payDue_(order).toFixed(2)}&note=${encodeURIComponent(note)}`;
}

// What happens next with payment, in words that fit how the shopper chose to pay.
function confirmationPaymentText_(order){
  // A rush fee still to follow is sent separately; it never holds up paying for the rest.
  const rushLater = order.rush && order.rushFeePending ? " The rush fee will follow — we'll confirm it and send it separately." : "";
  return confirmationPaymentBase_(order) + rushLater;
}
// What is still to be paid on a just-placed order: the total less what gift cards took.
function payDue_(order){
  return Number(order.giftTaken) > 0 && typeof order.owed === "number" ? order.owed : Number(order.total) || 0;
}
function confirmationPaymentBase_(order){
  const m = order.paymentMethod;
  if(order.manualShipping) return "The shipping cost still has to be worked out — we'll email you the total and how to pay.";
  if(order.owed === 0) return Number(order.giftTaken) > 0 ? "Your order is in. Your gift card covers it — there's nothing to pay." : "Your order is in. Your discount covers it — there's nothing to pay.";
  if(m === "Card") return order.cardStartFailed ? "Your order is saved, but the card payment couldn't be started. Try it again below, or contact the shop to pay another way — there's no need to order again." : "Your order is saved.";
  if(m === "Venmo" || m === "Zelle" || m === "Check") return "Your order is in. Please pay using the details below — we'll email you once your payment is received.";
  if(m === NET30_METHOD_){
    const days = net30Days_(order.termsDays);
    return "Your order is in — there's nothing to pay now. We'll send an invoice; payment is due within " + (days ? days + " days" : "the terms on it") + "." +
      (order.poNumber ? " Your PO number " + order.poNumber + " is on the order; we'll confirm it." : " Add your PO number from your invoice when you have it.");
  }
  return "Your order is in. We'll contact you about payment.";
}
// The items, delivery and total, so the shopper can see what they ordered.
function confirmationSummaryHtml_(order){
  const rows = (order.items || []).map(it => `<div class="row"><span>${escapeHtml(it.name)}${it.size && it.size !== "OSFA" ? " · " + escapeHtml(it.size) : ""} &times; ${Number(it.qty) || 1}${it.personalized && it.persName ? `<br><small>Personalization: “${escapeHtml(it.persName)}”</small>` : ""}${it.cfgText ? `<br><small>${escapeHtml(it.cfgText)}</small>` : ""}</span><span>$${Number(it.lineTotal || 0).toFixed(2)}</span></div>`).join("");
  const opt = order.deliveryOptionId ? (deliveryOptions_(currentOrg).find(o => o.id === order.deliveryOptionId) || {}) : null;
  const deliveryLabel = order.manualShipping ? "Shipping — cost to follow" : order.shippingMethod || (opt && opt.label) || (order.shippingAddress ? "Shipping" : "");
  const delivery = order.freeShippingCodes && !order.manualShipping
    ? `<div class="row"><span>${escapeHtml(deliveryLabel || "Shipping")}</span><span>$0.00</span></div><div class="row"><span>Free shipping (${escapeHtml(order.freeShippingCodes)})</span><span>Free</span></div>`
    : deliveryLabel ? `<div class="row"><span>${escapeHtml(deliveryLabel)}</span><span>${order.manualShipping ? "TBD" : Number(order.shippingCost) ? "$" + Number(order.shippingCost).toFixed(2) : "Free"}</span></div>` : "";
  const rush = order.rush ? `<div class="row"><span>Rush fee${order.neededBy ? ` <small>(needed by ${escapeHtml(order.neededBy)})</small>` : ""}</span><span>${order.rushFeePending ? "To follow" : "$" + Number(order.rushFee || 0).toFixed(2)}</span></div>` : "";
  const discount = Number(order.discount) > 0 ? `<div class="row"><span>Discount${order.discountCode ? " (" + escapeHtml(order.discountCode) + ")" : ""}</span><span>&minus;$${Number(order.discount).toFixed(2)}</span></div>` : "";
  // Gift cards: each card's part of the payment (a payment, not a discount), then what is left to pay.
  const gifts = (order.giftCardUse || []).filter(u => u.taken > 0).map(u => `<div class="row"><span>Paid by gift card ••${escapeHtml(u.last4)}</span><span>&minus;$${Number(u.taken).toFixed(2)}</span></div>`).join("");
  const giftDue = gifts && typeof order.owed === "number" ? `<div class="row"><span>Still to pay</span><span>$${Number(order.owed).toFixed(2)}</span></div>` : "";
  return `<div class="conf-items">${rows}${discount}${delivery}${rush}<div class="row total"><span>Total</span><span>$${Number(order.total || 0).toFixed(2)}${order.manualShipping ? " + shipping" : ""}</span></div>${gifts}${giftDue}</div>`;
}

function showConfirmation(orgId, order){
  const org = currentOrg;
  const app = document.getElementById("app");

  let paymentHtml = "";
  if(order.owed === 0){ /* a discount code covered it all: nothing to pay, so no payment details */ }
  else if(order.paymentMethod === "Venmo"){
    const link = venmoPayLink(order);
    paymentHtml = link
      ? `<a class="confirmation-back" href="${link}" target="_blank" rel="noopener" style="display:inline-block; margin-top:16px; text-decoration:none;">Pay $${payDue_(order).toFixed(2)} with Venmo &rarr;</a>`
      : `<p style="margin-top:16px;"><em>Venmo isn't set up yet — you'll be contacted with payment instructions.</em></p>`;
  } else if(order.paymentMethod === "Zelle"){
    const zelleDiscount = CASH_DISCOUNT_PERCENT ? `<div class="pi-discount">✓ ${CASH_DISCOUNT_PERCENT}% discount applied — mention this when sending payment.</div>` : "";
    paymentHtml = `<div class="payment-instructions">
      <div class="pi-label">Zelle payment</div>
      <div class="pi-value">${business.zelle ? `Send $${payDue_(order).toFixed(2)} to <strong>${escapeHtml(business.zelle)}</strong>` : `Amount due: <strong>$${payDue_(order).toFixed(2)}</strong> — you'll be contacted with Zelle details.`}</div>
      <div class="pi-note">Include <strong>${order.orderId}</strong> in the memo so we can match it to your order.</div>
      ${zelleDiscount}
    </div>`;
  } else if(order.paymentMethod === "Check"){
    const checkDiscount = CASH_DISCOUNT_PERCENT ? `<div class="pi-discount">✓ ${CASH_DISCOUNT_PERCENT}% discount applied — note this on your check or in a note.</div>` : "";
    paymentHtml = `<div class="payment-instructions">
      <div class="pi-label">Check payment</div>
      <div class="pi-value">Make check payable to <strong>${escapeHtml(business.legalName || bizName_())}</strong></div>
      <div class="pi-value">${business.mailingAddress ? `Mail to <strong>${escapeHtml(business.mailingAddress)}</strong>` : "You'll be told where to send it."}</div>
      <div class="pi-note">Write <strong>${order.orderId}</strong> in the memo line.</div>
      ${checkDiscount}
    </div>`;
  }

  app.innerHTML = `
    <div class="confirmation" style="${orgAccentVars(org.accent)}">
      <div class="stitch"></div>
      <h2>Order received, ${escapeHtml(order.customerName.split(" ")[0])}.</h2>
      <div class="order-number">${order.orderId} &middot; $${order.total.toFixed(2)}</div>
      <p>${escapeHtml(confirmationPaymentText_(order))}</p>
      ${confirmationSummaryHtml_(order)}
      ${(order.giftCardUse || []).filter(u => u.refused).map(u => `<p class="gift-refused" role="status">Gift card ••${escapeHtml(u.last4)} couldn't be used${u.reason ? ": " + escapeHtml(u.reason) : ""}. The rest of your order is paid the usual way.</p>`).join("")}
      ${order.cardStartFailed && unpaidCardNotice ? unpaidCardBannerHtml_() : ""}
      ${paymentHtml}
      ${order.noEmail ? `<p style="font-size:13px;opacity:.8;">Keep your order number for any question about this order.</p>`
        : `<p style="font-size:13px;opacity:.8;">We'll email a copy to ${escapeHtml(order.contact)} — keep your order number ${escapeHtml(order.orderId)} in case it doesn't arrive.</p>`}
      <br>
      <button class="confirmation-back" data-action="go-org" data-org="${orgId}" style="background:none; border:none; margin-top:12px;">&larr; Back to ${escapeHtml(org.name)}</button>
    </div>
  `;
}

(async function boot(){
  // Ask the server who we are (Host header-based) before rendering
  // anything — there's no static subdomain table left client-side to
  // decide this synchronously. currentOrg stays null on the root/generic
  // domain or an unrecognized host, and route falls back to "generic".
  const resolved = await resolveCurrentOrg();

  // Check for ?verify=TOKEN first — works on any subdomain including admin.
  const params = new URLSearchParams(window.location.search);
  const verifyToken = params.get("verify");
  if(verifyToken){
    history.replaceState({}, "", window.location.pathname);
    route = {view:"design-verify", token:verifyToken};
    render();
    return;
  }

  // ?invoice=TOKEN — the customer's invoice page (works on any address the site answers on). The
  // token stays in the address so a reload, or coming back from the card checkout, lands here again;
  // only the one-time "&paid=1" is dropped.
  const invoiceToken = params.get("invoice");
  if(invoiceToken){
    const justPaid = params.get("paid") === "1";
    if(justPaid) history.replaceState({}, "", window.location.pathname + "?invoice=" + encodeURIComponent(invoiceToken));
    route = {view:"invoice", token:invoiceToken, justPaid};
    render();
    return;
  }

  // ?estimate=TOKEN — the customer's quote page, from the link in a quote email. The token stays in the address,
  // so a reload shows the quote as it is now (accepted, say).
  const estimateToken = params.get("estimate");
  if(estimateToken){
    route = {view:"estimate", token:estimateToken};
    render();
    return;
  }

  if(resolved && resolved.error){
    route = {view:"load-error"};
    render();
    return;
  }
  if(resolved && resolved.admin){
    route = {view:"admin"};
    render();
    return;
  }
  if(resolved && resolved.closed){
    const paid = params.get("stripe") === "success";
    const paidOrderId = params.get("orderId");
    if(params.get("stripe")) history.replaceState({}, "", window.location.pathname);
    route = {view:"closed", paid, orderId: paid ? paidOrderId : null};
    render();
    return;
  }
  currentOrg = resolved;
  route = currentOrg ? {view:"org", org:currentOrg.orgId} : {view:"generic"};

  // Stripe Checkout returns here with ?stripe=success&orderId=...&org=...
  // (success) or ?stripe=cancel&org=... (customer hit back/cancel on Stripe).
  // Detect this before the normal render so we can show the right screen.
  const stripeResult = params.get("stripe");
  const returnOrg = params.get("org") || (currentOrg ? currentOrg.orgId : null);
  const returnOrderId = params.get("orderId");
  if(stripeResult && returnOrg){
    // Clean the query string from the URL bar without causing a reload
    history.replaceState({}, "", window.location.pathname);

    if(stripeResult === "success"){
      // Order already saved + paid via webhook — show a clean paid confirmation
      route = {view:"stripe-success", org:returnOrg, orderId:returnOrderId};
    } else if(stripeResult === "cancel"){
      // Customer left Stripe Checkout without paying — the order is already saved. Back to the shop with a
      // banner that says so and (when this tab started it) offers to pay that same order by card.
      route = {view:"org", org:returnOrg};
      const pending = readPendingCard_(returnOrg);
      if(pending && (!returnOrderId || pending.orderId === returnOrderId)) unpaidCardNotice = pending;
      else if(returnOrderId) unpaidCardNotice = { orderId: returnOrderId };
    }
  }

  render();
})();
