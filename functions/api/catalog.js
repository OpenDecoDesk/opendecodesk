/**
 * Serves each org's catalog AND identity server-side, so a customer on one
 * org's subdomain can never see any other org's name, products, pricing, or
 * even that it exists — not even by viewing page source. index.html carries
 * no org data at all; it asks this endpoint "who am I, and what do I sell."
 * ========================================================================
 * ---- HOW THIS HIDES OTHER ORGS ----
 * The real data — name, accent color, description, design preview images,
 * products, prices — lives in D1, read and edge-cached by
 * functions/_lib/catalogCache.js: getCatalogData(env) for the shop addresses
 * and settings, getCatalogShop(env, orgId) for the one shop this request is
 * for (no other shop is read). It's never embedded in index.html. The
 * client asks this endpoint for "my org's info," and this function decides
 * which org that is by reading the request's Host header itself — NOT by
 * trusting an org id the client sends. A locked subdomain always gets its
 * own data only, no matter what ?org= it's asked with. On
 * boot, the client calls this with no ?org= at all; a response of anything
 * other than status:"ok" (root domain, or an unrecognized host) is the
 * signal index.html uses to render the generic company page instead of
 * guessing at an org.
 *
 * The root domain (functions/_lib/hostConfig.js) serves no shop and ignores
 * ?org=; the admin host gets only a marker. Any OTHER hostname — a typo, a
 * probe, or (with wildcard DNS) a subdomain that was never set up — is
 * refused outright.
 *
 * ---- ADDING/EDITING ORGS ----
 * Not a code change — use the admin panel's Manage catalog screens, then
 * click "Publish." See docs/shops-and-domains.md.
 */

import { classifyHost } from "../_lib/hostConfig.js";
import { getCatalogData, getCatalogShop } from "../_lib/catalogCache.js";
import { jsonResponse } from "../_lib/http.js";
import { getReadyToShipByOrg, getBlankReadyByOrg, getDraftCatalogShop, verifyPreviewToken, pickTimeZone, localDayEndInstant, timeZoneShortName } from "../_lib/db.js";

// ---- The shop page's stock, kept 30 seconds ----
// Every view of a shop page needs the shop's finished stock (getReadyToShipByOrg), which of its digital products have
// files, and its blanks' free stock (getBlankReadyByOrg): about six D1 queries, two of them over every open order. A
// shop's launch (a team's parents opening the link at once) or a crawler would repeat them on every view, so the
// answers are kept SHOP_STOCK_TTL_MS per shop: in this isolate's memory (the shops used most recently, at most
// SHOP_STOCK_MEMORY_MAX), and in the Cache API for this colo's other isolates. So the stock badges and "ready to
// decorate" counts can be up to 30 seconds behind. Placing an order never reads them: a line is filled from stock
// only if the database still has the pieces when the order is written (db.js insertOrder's guarded statement).
// A read that failed isn't kept (the next view tries again), and an admin's draft preview always reads fresh.
// The key carries the request's host as well as the shop, so two environments on one zone never share an entry.
// Kept objects are shared between requests: they're only read, never changed.
const SHOP_STOCK_TTL_MS = 30_000;
const SHOP_STOCK_MEMORY_MAX = 50;
const SHOP_STOCK_READ_AT = "X-Stock-Read-At";
const _shopStock = new Map();   // key → { data, at }, the one used longest ago first
function rememberShopStock_(key, data, at){
  _shopStock.delete(key); _shopStock.set(key, { data, at });
  while(_shopStock.size > SHOP_STOCK_MEMORY_MAX) _shopStock.delete(_shopStock.keys().next().value);
}
// Test hook (the harnesses load this file's source): forgets every shop's stock kept in memory.
function _resetShopStock(){ _shopStock.clear(); }
// { stockRead, filesRead, blankRead }, each {v} or {e} (filesRead null when the files aren't wanted), as the page
// builds them; from memory, the Cache API, or fresh from D1 (and then kept, when all of them were read).
async function readShopStock_(env, orgId, { host = "", wantFiles = false, fresh = false, waitUntil } = {}){
  const key = "https://shop-stock.internal/" + encodeURIComponent(host) + "/" + encodeURIComponent(orgId);
  const fits = (d) => d && typeof d === "object" && (!wantFiles || Array.isArray(d.files));
  const asReads = (d) => ({ stockRead: { v: d.stock }, filesRead: wantFiles ? { v: { results: d.files } } : null, blankRead: { v: d.blank } });
  const cache = !fresh && typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  if(!fresh){
    const now = Date.now(), mem = _shopStock.get(key);
    if(mem && now - mem.at < SHOP_STOCK_TTL_MS && fits(mem.data)){ rememberShopStock_(key, mem.data, mem.at); return asReads(mem.data); }
    if(cache){
      try{
        const hit = await cache.match(key);
        const at = hit ? Number(hit.headers.get(SHOP_STOCK_READ_AT)) || 0 : 0;
        if(hit && now - at < SHOP_STOCK_TTL_MS){
          const data = await hit.json();
          if(fits(data)){ rememberShopStock_(key, data, at); return asReads(data); }
        }
      }catch(e){ /* a Cache API failure only costs fresh reads */ }
    }
  }
  // Three fresh reads, made at the same time. Each one failing only leaves its part out.
  const settle = (read) => Promise.resolve().then(read).then(v => ({ v }), e => ({ e }));
  const [stockRead, filesRead, blankRead] = await Promise.all([
    settle(() => getReadyToShipByOrg(env.DB, orgId)),
    wantFiles ? settle(() => env.DB.prepare("SELECT DISTINCT productId FROM product_files WHERE orgId = ?").bind(orgId).all()) : null,
    settle(() => getBlankReadyByOrg(env.DB, orgId)),
  ]);
  if(!fresh && !stockRead.e && !blankRead.e && !(filesRead && filesRead.e)){
    const at = Date.now();
    const data = { stock: stockRead.v, files: filesRead ? ((filesRead.v || {}).results || []) : null, blank: blankRead.v };
    rememberShopStock_(key, data, at);
    if(cache){
      try{
        const put = cache.put(key, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json",
          "Cache-Control": "max-age=" + Math.round(SHOP_STOCK_TTL_MS / 1000), [SHOP_STOCK_READ_AT]: String(at) } }));
        if(typeof waitUntil === "function") waitUntil(Promise.resolve(put).catch(() => {}));
        else await put;
      }catch(e){ /* kept in memory; another isolate reads it again */ }
    }
  }
  return { stockRead, filesRead, blankRead };
}

// Computes which payment methods are enabled for an org.
// Result is the intersection of:
//   - globalSettings.enabledPayments (admin-set global toggles)
//   - org.enabledPayments (per-org toggles — cannot re-enable a globally disabled method)
//   - Stripe being configured (for "Card" only)
// When either settings object is absent, every method defaults to enabled.
function computeEnabledPayments(org, globalSettings, stripeConfigured){
  const g = (globalSettings && globalSettings.enabledPayments) || {};
  const o = (org && org.enabledPayments) || {};
  const globalCard  = g.card  !== false;
  const globalVenmo = g.venmo !== false;
  const globalZelle = g.zelle !== false;
  const globalCheck = g.check !== false;
  const orgCard  = o.card  !== false;
  const orgVenmo = o.venmo !== false;
  const orgZelle = o.zelle !== false;
  const orgCheck = o.check !== false;
  const methods = [];
  if(globalCard  && orgCard  && stripeConfigured) methods.push("Card");
  if(globalVenmo && orgVenmo) methods.push("Venmo");
  if(globalZelle && orgZelle) methods.push("Zelle");
  if(globalCheck && orgCheck) methods.push("Check");
  return methods;
}

// Normalizes a stored image URL that is missing its scheme. If R2_PUBLIC_BASE
// is set without "https://", uploads are stored as
// "images.example.com/uploads/..." instead of
// "https://images.example.com/uploads/...", which browsers treat as relative
// (prepending the current page URL) rather than as absolute.
// Safe to call on any URL: absolute https:// and site-relative paths pass
// through unchanged; only bare-domain strings get the scheme prepended.
function normImageUrl(url){
  if(!url) return url;
  // Allowlist, not a blocklist: only http(s):// or a plain site path survives
  // (the same rule as cleanImageUrl in _lib/catalogValidation.js, which
  // orders.js applies on every save). Defense in depth for anything already
  // stored — e.g. " javascript:…" or "java\tscript:…", which a ^javascript:
  // blocklist would let through.
  url = String(url).trim();
  if(/[\u0000-\u001f\u007f\\<>"'`]/.test(url)) return "";
  if(!/^https?:\/\//i.test(url) && (url.startsWith("//") || url.includes(":"))) return "";
  if(/^https?:\/\//i.test(url)) return url; // already absolute
  if(url.startsWith('/')) return url;        // site-relative — intentional
  const firstSlash = url.indexOf('/');
  const hostPart = firstSlash === -1 ? url : url.slice(0, firstSlash);
  // If the segment before the first slash looks like a hostname (has a dot,
  // doesn't start with one), it's a bare-domain URL — prepend https://.
  if(hostPart.includes('.') && !hostPart.startsWith('.')) return 'https://' + url;
  return url;
}

// A product's quantity breaks as the shop page gets them. db.js validated them when they were saved
// (normalizeQtyBreaks_); this only keeps the two fields the page reads, in order, so an entry cached before
// migrations/0109 (no qtyBreaks at all) or a malformed one reads as "no breaks" rather than breaking the page.
function clientQtyBreaks_(list){
  if(!Array.isArray(list)) return [];
  return list.map(b => ({ minQty: Number(b && b.minQty), off: Number(b && b.off) }))
    .filter(b => Number.isInteger(b.minQty) && b.minQty >= 2 && Number.isFinite(b.off) && b.off > 0)
    .sort((a, b) => a.minQty - b.minQty).slice(0, 6);
}

// The shop's fundraiser (migrations/0110) as the shop page shows it: one sentence, and only when the shop ticked
// "Show on the shop". db.js validated it when it was saved (normalizeFundraiser_); the raw setup — mode, amount, the
// tick box — never leaves the server, and anything malformed (or an entry cached before 0110, with no fundraiser at
// all) reads as "nothing to show" rather than a broken sentence. null = say nothing.
function fundraiserShopText_(f){
  if(!f || typeof f !== "object" || f.showOnShop !== true) return null;
  const label = String(f.label || "").trim().slice(0, 80);
  if(!label) return null;
  if(f.mode === "perPiece"){
    const amount = Number(f.amount);
    if(!Number.isFinite(amount) || amount <= 0) return null;
    return "$" + amount.toFixed(2) + " of every item supports " + label;
  }
  if(f.mode === "percent"){
    const pct = Number(f.percent);
    if(!Number.isFinite(pct) || pct <= 0) return null;
    // 10 → "10%", 2.5 → "2.5%": at most the two decimals the setting allows, no trailing zeros.
    return String(Math.round(pct * 100) / 100) + "% of every purchase supports " + label;
  }
  return null;
}

// Whether the checkout shows its "Discount code" box (migrations/0115): some code that's switched on, not used up and not
// past its last day works at this shop (its own or an every-shop code). Read fresh on every request, never cached with the
// published shop — saving or switching off a code needs no Publish. Only a yes/no leaves the server: no code, value or
// count. The expiry test is loose by a day on purpose (any time zone's today is at least yesterday in UTC), so the box can
// show a few hours after a code's last day — the server refuses the code then — but never hides while one still works.
// No 0115 yet (no such table) or any failure: no box.
const DISCOUNT_BOX_SQL_ = `SELECT 1 AS ok FROM discount_codes d
  WHERE d.active = 1 AND (d.orgId IS NULL OR d.orgId = ?) AND (d.expiresOn IS NULL OR d.expiresOn >= ?)
    AND (SELECT COUNT(*) FROM discount_code_uses u WHERE u.codeId = d.id AND u.releasedAt IS NULL) < d.maxUses
  LIMIT 1`;
function discountBoxSince_(now){ return new Date(now.getTime() - 86400000).toISOString().slice(0, 10); }

// Maps a stored product (productId/pricingMode/flatPrice/sizePricing) to the
// shape storefront.js's rendering expects (id, and sizePricing OR flatPrice —
// no pricingMode field).
function toClientProduct(p){
  const out = {
    id: p.productId, type: p.type, name: p.name, sub: p.sub,
    images: p.images.map(normImageUrl), features: p.features,
    personalizationPrice: p.personalizationPrice,
    personalizationOptions: p.personalizationOptions || [],
    weightOz: p.shipWeightOz ?? p.weightOz ?? null
  };
  if(p.pricingMode === "flat"){
    out.flatPrice = p.flatPrice;
  } else {
    out.sizePricing = p.sizePricing;
  }
  // Quantity breaks (migrations/0109): [{ minQty, off }] in dollars, fewest pieces first; [] when none. The shop page
  // shows them as a table and the cart mirrors them; the order is priced by the server (priceItem's breakQty).
  out.qtyBreaks = clientQtyBreaks_(p.qtyBreaks);
  // Only said when it isn't (the cart's tax estimate skips the line); taxable is the default.
  if(p.taxable === false) out.taxable = false;
  // Sold as files (migrations/0086): no delivery, an "Instant download" tag.
  if(p.digital) out.digital = true;
  // The customer may upload their own design (migrations/0054): how it's made, its add-on per piece
  // (null = free), and whether the product can only be ordered with one.
  if(p.customDesign){
    out.customDesign = { kind: p.customDesign, price: p.customDesignPrice ?? null, required: !!p.customDesignRequired };
  }
  // Versions of a product (migrations/0059): the shop page shows products sharing a versionGroup as one
  // card with a toggle labelled by versionLabel ("Short sleeve | Long sleeve").
  // What decorates it, in words (name + decoration location), so the shop page can say so with or without a picture.
  if(Array.isArray(p.decorations) && p.decorations.length) out.decorations = p.decorations.slice(0, 12).map(d => ({
    kind: String(d.kind || ""), name: String(d.name || ""), location: String(d.location || "") }));
  if(p.versionGroup){ out.versionGroup = String(p.versionGroup); out.versionLabel = String(p.versionLabel || ""); }
  // Configurable products (migrations/0036): per-location option menus + garment colors.
  if(p.configurable){
    out.configurable = true;
    out.garmentColors = p.garmentColors || [];
    out.locations = p.locations || [];
    // Printed transfers that are part of the product (migrations/0068): it's decorated without any pick, so every
    // location may be left at None. Only the fact is sent — which graphics they are is the shop's business.
    if((p.fixedTransfers || []).length) out.hasFixedTransfers = true;
    // Color price groups (migrations/0064): a color in a group is priced by its group, else by sizePricing/flatPrice.
    if((p.colorGroups || []).length) out.colorGroups = p.colorGroups.map(g => ({ label: g.label, colors: g.colors || [],
      ...(g.flatPrice != null ? { flatPrice: g.flatPrice } : { sizePricing: g.sizePricing || {} }) }));
  }
  // Per-color images from the product's linked blank colors (migrations/0037); the storefront
  // prefers these over the product's own images. Image URLs re-normalised on the way out.
  if(p.colorImages && typeof p.colorImages === "object"){
    const ci = {};
    for(const k of Object.keys(p.colorImages)){
      const imgs = (p.colorImages[k] || []).map(normImageUrl).filter(Boolean);
      if(imgs.length) ci[k] = imgs;
    }
    if(Object.keys(ci).length) out.colorImages = ci;
  }
  // Per-location graphic mockups (migrations/0042): { "<locationId>|<graphicId>|<color>": imageUrl }.
  // The storefront shows the matching mockup for the picked color + each location's graphic.
  if(p.graphicImages && typeof p.graphicImages === "object"){
    const gi = {};
    for(const k of Object.keys(p.graphicImages)){
      const u = normImageUrl(p.graphicImages[k]);
      if(u) gi[k] = u;
    }
    if(Object.keys(gi).length) out.graphicImages = gi;
    // Which keys are its printed transfers' (migrations/0068): shown with the configurable preview, or as a plain
    // product's first pictures. Only location / graphic ids and the location's name.
    if(Array.isArray(p.fixedMockups) && p.fixedMockups.length) out.fixedMockups = p.fixedMockups.map(f => ({
      locationId: Number(f.locationId), graphicId: Number(f.graphicId), label: String(f.label || "") }));
  }
  return out;
}

// A version for the admin's script (public/admin.js, about 2 MB): the assets layer's ETag for it — a hash of the file
// — else, in the desktop program, the program's version. The page loads admin.js?v=<it>, so the browser keeps the
// file (and its compiled code) from one visit to the next and fetches it again only when a deploy or an update
// changes it. "" when neither is known: the page then loads it fresh every time, as it used to.
async function adminScriptVersion(env, url){
  try{
    if(env && env.ASSETS && typeof env.ASSETS.fetch === "function"){
      const res = await env.ASSETS.fetch(new Request(new URL("/admin.js", url).toString(), { method: "HEAD" }));
      const tag = String((res && res.ok && res.headers.get("ETag")) || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 64);
      if(tag) return tag;
    }
  }catch(e){ /* no assets binding here: fall through */ }
  const v = String((env && env.DESKTOP_VERSION) || "").trim().replace(/[^A-Za-z0-9.]/g, "").slice(0, 40);
  return v && v !== "dev" ? "desktop-" + v : "";
}

// When a shop's ordering closes: 11:59:59 pm on its deadline day in the business's time zone (Global settings →
// Region, else the TIMEZONE variable, else UTC), the same moment order placement refuses orders from (orders.js).
// orderClosesAt is that moment (ISO), orderTimeZone the zone (the storefront counts "days left" on its calendar),
// orderZoneLabel its short name then ("GMT+9", "UTC"). Worked out from the cached settings alone, so every shopper — and
// every request — gets the same answer. Nothing for no deadline, nor from a settings entry cached before it carried
// the zone: the storefront then keeps its old end-of-day check until the entry is rebuilt.
function orderClosing_(deadline, locale, env){
  if(!deadline || !locale || typeof locale.timeZone !== "string") return {};
  const zone = pickTimeZone(locale.timeZone, env);
  const at = localDayEndInstant(deadline, zone);
  return at ? { orderClosesAt: at, orderTimeZone: zone, orderZoneLabel: timeZoneShortName(at, zone) } : {};
}

export async function onRequestGet(context){
  const { request, env } = context;
  const url = new URL(request.url);

  let catalogData;
  try{
    catalogData = await getCatalogData(env, { waitUntil: context.waitUntil?.bind(context) });
  }catch(err){
    return jsonResponse({status:"error", message:"Catalog temporarily unavailable"}, 503);
  }

  // Global settings → Region: which address format the forms use. Anything but "OTHER" is "US".
  const country = ((catalogData.locale || {}).country === "OTHER") ? "OTHER" : "US";
  // Global settings → Features: which optional parts of the site are on. Sent with every answer so
  // the storefront and the admin know without another request; a missing key means on.
  const features = catalogData.features || {};
  // Carrier shipping needs both a US install and the Shipping feature.
  const carrierShipping = country === "US" && features.shipping !== false;

  const host = classifyHost(url.hostname, catalogData.subdomainMap, env);

  // A draft preview on a site with no domain yet (a Deploy-button install): the admin's own workers.dev
  // address serves it, as ?shop=<shop ID>&preview=<token signed for that shop>. Anything short of a valid
  // token for that very shop gets the admin answer below, so shop IDs can't be probed this way.
  let previewHere = false;
  if(host.kind === "admin" && !(env && env.ROOT_DOMAIN) && /\.workers\.dev$/i.test(url.hostname) && env.DB && url.searchParams.get("shop")){
    try{ previewHere = await verifyPreviewToken(env, url.searchParams.get("shop"), url.searchParams.get("preview")); }
    catch(e){ previewHere = false; }
  }

  let orgId;
  if(host.kind === "locked"){
    orgId = host.orgId; // ignore any ?org= param entirely — always serve the locked org
  } else if(previewHere){
    orgId = url.searchParams.get("shop");
  } else if(host.kind === "root"){
    // The root domain serves no shop at all, and ignores ?org=: answering ?org=<guess> with that
    // shop's catalog would let anyone confirm which org IDs exist. A shop is reached only through
    // its own subdomain; nothing in the site calls this with ?org=.
    orgId = null;
  } else if(host.kind === "admin"){
    // The admin subdomain isn't a storefront for any single org — it
    // has no catalog to serve. Return a marker so the client renders
    // the admin panel instead of guessing at an org. Deliberately no
    // org names/list here — that stays gated behind the passphrase in
    // orders.js (action: "listOrgs"), so hitting this subdomain alone
    // can't be used to scrape the client list.
    // site.rootDomain: where shops live (<subdomain>.<root>); "" while the site has no domain yet
    // (a Deploy-button install on its workers.dev address) — the admin must not guess it. Cleaned up
    // as hostConfig's rootDomain() does, written out here because older tests load this file with
    // its hostConfig import line removed.
    const siteRoot = env && env.ROOT_DOMAIN ? String(env.ROOT_DOMAIN).trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "") : "";
    // edition: "desktop" tells the admin it runs inside the desktop program (hostConfig.js), so it
    // leaves out what needs the internet; desktopSuppliers / desktopEmail: the owner turned supplier
    // connections on there, or set up email (hostConfig.js desktopSuppliersOn / desktopEmailOn,
    // repeated here to keep this file's one import). version: the program's (DESKTOP_VERSION, set by
    // desktop/server.js), shown above the business's name in the admin's header.
    // adminScript: the version to load admin.js under (adminScriptVersion above).
    return jsonResponse({status:"admin", business: catalogData.business || {}, country, features, site: { rootDomain: siteRoot },
      adminScript: await adminScriptVersion(env, url),
      ...(host.desktop ? {edition:"desktop", version: String(env.DESKTOP_VERSION || "").trim().slice(0, 40) || "dev",
        ...(String(env.DESKTOP_SUPPLIERS || "") === "on" ? {desktopSuppliers:true} : {}),
        ...(String(env.DESKTOP_EMAIL || "") === "on" ? {desktopEmail:true} : {})} : {})});
  } else {
    // Unknown hostname — refuse rather than treating it like a known host.
    return jsonResponse({status:"error", message:"Unrecognized host", business: catalogData.business || {}, country, features}, 404);
  }

  // Storefront switched off (Global settings → Features): a shop host and the root domain get the
  // same short answer — who runs the site and that ordering isn't available — and nothing about any
  // shop: no name, no products, no prices. Not an error (200), so the page can tell it from a
  // mistyped address. The admin host was answered above and is unaffected.
  if(features.storefront === false){
    return jsonResponse({status:"closed", message:"Online ordering isn't available here.", business: catalogData.business || {}, country, features});
  }

  // Only this shop's catalog is read (catalogCache.js caches each shop apart), never the other shops'.
  let org = null;
  if(orgId){
    try{ org = await getCatalogShop(env, orgId, { waitUntil: context.waitUntil?.bind(context) }); }
    catch(err){ return jsonResponse({status:"error", message:"Catalog temporarily unavailable"}, 503); }
  }
  // The admin's draft preview (migrations/0076): ?preview=<token signed for THIS shop> serves the shop's live,
  // unpublished rows (never cached). Anything else — a bad or expired token — is just the published shop.
  let preview = false;
  const previewToken = url.searchParams.get("preview");
  if((org || previewHere) && previewToken && (host.kind === "locked" || previewHere) && env.DB && await verifyPreviewToken(env, orgId, previewToken)){
    try{ const draft = await getDraftCatalogShop(env.DB, orgId); if(draft){ org = draft; preview = true; } }
    catch(e){ console.error("draft preview failed:", e); }
  }
  if(!org){
    // The root domain always lands here (it serves no shop): one answer, 200,
    // whatever ?org= says, so probing ?org=<guess> can't enumerate org IDs.
    // Locked subdomains keep the 404 — their hostname is already the org
    // identity signal.
    if(host.kind === "root"){
      return jsonResponse({status:"error", message:"Unknown org", business: catalogData.business || {}, country, features});
    }
    return jsonResponse({status:"error", message:"Unknown org", business: catalogData.business || {}, country, features}, 404);
  }

  const enabledPayments = computeEnabledPayments(org, catalogData.globalSettings, !!env.STRIPE_SECRET_KEY);
  const fundraiserText = fundraiserShopText_(org.fundraiser);

  // The shop's stock block — finished stock, the digital products' files and the blanks' free stock — kept up to 30
  // seconds per shop (readShopStock_ above; a draft preview reads it fresh). Each part that can't be read is left out.
  let shownProducts = org.products;
  const wantFiles = !!(shownProducts.some(p => p.digital) && env.DB && features.digital !== false);
  // The discount box's yes/no (DISCOUNT_BOX_SQL_): read fresh, not with the stock block, so a code saved a moment ago
  // shows its box at once; read at the same time, and only while the Discount codes feature is on.
  const wantDiscounts = !!(env.DB && features.discounts !== false);
  const settle = (read) => Promise.resolve().then(read).then(v => ({ v }), e => ({ e }));
  const [{ stockRead, filesRead, blankRead }, discountRead] = await Promise.all([
    env.DB
      ? readShopStock_(env, orgId, { host: url.host, wantFiles, fresh: preview, waitUntil: context.waitUntil?.bind(context) })
      : { stockRead: null, filesRead: null, blankRead: null },
    wantDiscounts ? settle(() => env.DB.prepare(DISCOUNT_BOX_SQL_).bind(orgId, discountBoxSince_(new Date())).first()) : null,
  ]);
  const discountCodes = !!(discountRead && !discountRead.e && discountRead.v);
  if(discountRead && discountRead.e && !/no such table/i.test(String(discountRead.e.message))) console.error("discount code check failed:", discountRead.e);

  // Ready-to-ship stock (up to 30 seconds old; an order is still filled from stock only if the database has the pieces).
  // stock: {size: n} for a product with no choices; stockVariants: {combination key: {size: n}} for one with
  // color and graphic choices (migrations/0080 — storefront.js's stockVariantKey_ builds the key from the picks).
  let stockByProduct = {}, stockByVariant = {};
  if(env.DB){
    try{
      if(stockRead.e) throw stockRead.e;
      const stockRows = stockRead.v;
      for(const row of stockRows){
        if(row.variant){
          const byKey = (stockByVariant[row.productId] = stockByVariant[row.productId] || {});
          (byKey[row.variant] = byKey[row.variant] || {})[row.size] = row.quantity;
          continue;
        }
        if(!stockByProduct[row.productId]) stockByProduct[row.productId] = {};
        stockByProduct[row.productId][row.size] = row.quantity;
      }
    }catch(e){
      // Non-fatal — stock display degrades gracefully to "no stock info"
      console.error("ready_to_ship fetch failed:", e);
    }
  }
  // Digital products (migrations/0086) are only shown with at least one file to download, and not at all while the
  // Digital products feature is off (they can't be ordered then). Which have files is read with the stock: adding one
  // shows the product within 30 seconds (at once in the draft preview). If they can't be read, the digital products are
  // left out rather than sold with nothing to send.
  if(shownProducts.some(p => p.digital)){
    let withFiles = new Set();
    if(wantFiles){
      try{
        if(filesRead.e) throw filesRead.e;
        const { results } = filesRead.v;
        withFiles = new Set((results || []).map(r => String(r.productId)));
      }catch(e){ console.error("product files fetch failed:", e); }
    }
    shownProducts = shownProducts.filter(p => !p.digital || withFiles.has(String(p.productId)));
  }
  // "Ready to decorate": the linked blank's free stock per color + size (display only; non-fatal).
  let blankReady = {};
  if(env.DB){
    try{ if(blankRead.e) throw blankRead.e; blankReady = blankRead.v; }
    catch(e){ console.error("blank-ready fetch failed:", e); }
  }

  return jsonResponse({
    status:"ok", orgId, ...(preview ? { preview: true } : {}),
    business: catalogData.business || {},   // who runs the site: name, contact, how to pay by Venmo/Zelle/check
    country,   // "US" or "OTHER" (Global settings → Region): which address format the forms use
    features,  // Global settings → Features ({} or a missing key = on)
    catalog: {
      name: org.name, eyebrow: org.eyebrow, accent: org.accent, ready: org.ready,
      desc: org.desc, designImages: {
        shirt: normImageUrl(org.designImages.shirt),
        cap:   normImageUrl(org.designImages.cap),
        detail: normImageUrl(org.designImages.detail)
      }, shippingEnabled: org.shippingEnabled === true && carrierShipping,
      // What the customer picks from at checkout (migrations/0045): pickup / shipping / the shop's own.
      // Carrier rates need a US ZIP, so outside the US the shipping entry isn't offered — nor when
      // the Shipping feature is switched off.
      deliveryOptions: (org.deliveryOptions || []).filter(o => carrierShipping || o.type !== "shipping").map(o => ({ id: o.id, type: o.type, label: o.label, fee: o.fee })),
      // The storefront's sections, in the managed order (migrations/0056) — only the ones this shop uses.
      categories: (catalogData.categories || []).filter(c => shownProducts.some(p => p.type === c.key)).map(c => ({ key: c.key, label: c.label })),
      products: shownProducts.map(p => ({ ...toClientProduct(p), stock: stockByProduct[p.productId] || null,
        ...(stockByVariant[p.productId] ? { stockVariants: stockByVariant[p.productId] } : {}), blankStock: blankReady[p.productId] || null })),
      // Configurable-product option catalog + tier prices (migrations/0036); only present when the
      // org has configurable products. Image URLs re-normalised on the way out.
      graphics: (org.graphics || []).map(g => ({ ...g, imageUrl: normImageUrl(g.imageUrl), thumbUrl: normImageUrl(g.thumbUrl) })),
      tierPricesCents: org.tierPricesCents || null,
      // enabledPayments is the intersection of global payment toggles,
      // per-org payment toggles, and (for Card) Stripe being configured.
      // An empty array means no payment method is shown at checkout —
      // the order still goes through, just without a payment selection.
      enabledPayments,
      orderDeadline: org.orderDeadline || null,
      ...orderClosing_(org.orderDeadline, catalogData.locale, env),
      closedMessage: org.closedMessage || null,
      allowOrdersAfterDeadline: org.allowOrdersAfterDeadline !== false,
      // For the storefront's "Prices include x% <state> sales tax" disclosure.
      // 0 for a tax-exempt org (nothing to disclose). Certificate details are
      // never sent to the browser.
      salesTaxRate: org.taxExempt ? 0 : (((catalogData.globalSettings || {}).salesTax || {}).rateBps || 0) / 100,
      salesTaxJurisdiction: ((catalogData.globalSettings || {}).salesTax || {}).jurisdiction || "",
      // "inclusive": the listed prices include the tax; "exclusive": the cart adds it (the server
      // works out the real figure when the order is placed).
      salesTaxMode: ((catalogData.globalSettings || {}).salesTax || {}).taxMode === "exclusive" ? "exclusive" : "inclusive",
      // The rush fee this shop offers (migrations/0082): its own rule, else the global one; null = no rush.
      rush: org.rushOffer || null,
      // The shop's fundraiser (migrations/0110), only as the sentence under its heading and only when it's to be shown;
      // left out otherwise. It's inside the prices, so nothing in the cart depends on it.
      ...(fundraiserText ? { fundraiser: { text: fundraiserText } } : {}),
      // The checkout's "Discount code" box: true only when a code could work here now (DISCOUNT_BOX_SQL_). The server
      // checks the code itself, and decides the discount, when it's applied and again when the order is placed.
      discountCodes,
      // Public Turnstile site key (not secret) — only when server-side
      // verification is actually on, so the widget never renders for nothing.
      turnstileSiteKey: (env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY) ? env.TURNSTILE_SITE_KEY : null
    }
  });
}
