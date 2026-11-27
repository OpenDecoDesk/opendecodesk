// Email campaigns (migrations/0117): the themes and the one renderer that turns a campaign's design into an email.
// The admin's editor (public/admin-campaigns.js) draws its preview with it, and the server (functions/_lib/campaigns.js)
// sends what it makes, so what the owner sees is what customers get.
//
// A classic script with no imports or exports, so it loads both ways: the admin page adds it with a <script> tag, and
// the Worker imports it for its side effect. Either way it sets one global, OddCampaignRender.
//
// A design is { blocks: [...] } or { html: "..." } (written by hand on the HTML tab). Blocks, each with an optional
// pad (the space above and below it, 0–40 px):
//   banner   { h, s, art: "theme" | "image" | "none", img }   the theme's band: its picture, a headline and a tagline
//   heading  { x, align }
//   text     { x, align, color }   x is a little HTML (bold, italic, underline, links, line breaks, colour), cleaned
//   code     { x }                 the discount code box: x is the line over the code; the code is {code}
//   button   { x, url }            url "" = the shop
//   products { items: [{ name, price, image, url }] }   up to 4, side by side
//   image    { src, alt, url }
//   divider  {}
//   spacer   { h }
// Merge fields, filled per person (escaped): {first name} {name} {code} {shop} {expires} {business}.
// Emails are tables with inline styles at 600 px: what mail programs show reliably. No SVG, no web fonts, no scripts.
(function (root) {
  "use strict";

  // Each theme: its colours (band, text on it, accent, text on the accent), a sample headline, tagline, text, button
  // and subject, and its banner picture (public/email-art/<key>.png, original art).
  const THEMES = {
    blackfriday: { name: "Black Friday", bg: "#111111", fg: "#F6D34A", accent: "#F6D34A", accentText: "#111111",
      h: "BLACK FRIDAY", s: "Our biggest sale of the year", body: "Every shirt, hoodie and hat is on sale through Monday. Here's a code just for you.",
      button: "SHOP THE SALE", subject: "Black Friday: our biggest sale of the year" },
    cybermonday: { name: "Cyber Monday", bg: "#0B1E3F", fg: "#5EEAD4", accent: "#5EEAD4", accentText: "#0B1E3F",
      h: "CYBER MONDAY", s: "One more day of deals", body: "Missed the weekend? The sale runs one more day. Order online and we'll get started.",
      button: "SHOP NOW", subject: "Cyber Monday: one more day of deals" },
    christmas: { name: "Christmas", bg: "#14532D", fg: "#FFFFFF", accent: "#B91C1C", accentText: "#FFFFFF",
      h: "Merry and bright", s: "Gifts they'll actually wear", body: "Custom shirts, hoodies and hats make great gifts. Order early so they arrive before Christmas.",
      button: "SHOP GIFTS", subject: "Gifts they'll actually wear" },
    hanukkah: { name: "Hanukkah", bg: "#1E3A8A", fg: "#FFFFFF", accent: "#FACC15", accentText: "#1E3A8A",
      h: "Happy Hanukkah", s: "Eight nights of gifts", body: "Wishing you a warm and bright Hanukkah. Here's something for the season.",
      button: "SHOP NOW", subject: "Happy Hanukkah from all of us" },
    newyear: { name: "New Year", bg: "#18181B", fg: "#FDE68A", accent: "#FDE68A", accentText: "#18181B",
      h: "Happy New Year", s: "New year, new gear", body: "Thank you for a great year. Start the next one with something new.",
      button: "SEE WHAT'S NEW", subject: "New year, new gear" },
    valentine: { name: "Valentine's Day", bg: "#FCE7F3", fg: "#9D174D", accent: "#BE185D", accentText: "#FFFFFF",
      h: "Made with love", s: "Matching sets for two", body: "Treat someone special to something custom this Valentine's Day.",
      button: "SHOP NOW", subject: "Made with love: matching sets for two" },
    halloween: { name: "Halloween", bg: "#1C1917", fg: "#F97316", accent: "#F97316", accentText: "#1C1917",
      h: "SPOOKY SEASON", s: "Frightfully good deals", body: "Costume tees and team gear, ready before the 31st.",
      button: "SHOP NOW", subject: "Frightfully good deals this Halloween" },
    thanksgiving: { name: "Thanksgiving", bg: "#7C2D12", fg: "#FDE68A", accent: "#CA8A04", accentText: "#FFFFFF",
      h: "Thank you", s: "We're grateful for you", body: "A little thank-you for being part of our shop this year.",
      button: "SHOP NOW", subject: "A thank-you from our shop" },
    backtoschool: { name: "Back to school", bg: "#1E3A8A", fg: "#FFFFFF", accent: "#FACC15", accentText: "#1E3A8A",
      h: "Back to school", s: "Spirit wear is here", body: "Show your colors this year. Team and class orders welcome.",
      button: "SHOP SPIRIT WEAR", subject: "Back to school: spirit wear is here" },
    summer: { name: "Summer", bg: "#0E7490", fg: "#FFFFFF", accent: "#F59E0B", accentText: "#FFFFFF",
      h: "Summer sale", s: "Fresh styles for sunny days", body: "Light tees and tanks for every summer plan.",
      button: "SHOP SUMMER", subject: "Summer sale: fresh styles for sunny days" },
    plain: { name: "Plain", bg: "#1E7A4C", fg: "#FFFFFF", accent: "#1E7A4C", accentText: "#FFFFFF",
      h: "News from our shop", s: "", body: "Write your message here.",
      button: "VISIT THE SHOP", subject: "News from our shop" },
  };
  const THEME_KEYS = Object.keys(THEMES);
  const theme = (key) => THEMES[key] || THEMES.plain;
  const BLOCK_TYPES = ["banner", "heading", "text", "code", "button", "products", "image", "divider", "spacer"];
  const MAX_BLOCKS = 40;

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const COLOR_RE = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
  const color = (c, dflt) => COLOR_RE.test(String(c || "")) ? String(c) : dflt;
  const ALIGNS = ["left", "center", "right"];
  const align = (a, dflt) => ALIGNS.includes(a) ? a : dflt;
  const pad = (n, dflt) => { const v = Math.round(Number(n)); return Number.isFinite(v) ? Math.max(0, Math.min(40, v)) : dflt; };
  // A link a person can follow: http(s) or mailto, nothing else (no javascript:, no data:).
  function safeUrl(u) {
    const s = String(u == null ? "" : u).trim();
    if (/^https?:\/\/[^\s"'<>]+$/i.test(s) || /^mailto:[^\s"'<>]+$/i.test(s)) return s.slice(0, 1000);
    return "";
  }
  // A picture: an http(s) address, a cid: attachment, or a path on this site (made absolute by the caller's base).
  function safeImg(u, base) {
    const s = String(u == null ? "" : u).trim();
    if (/^https?:\/\/[^\s"'<>]+$/i.test(s) || /^cid:[\w.@-]+$/i.test(s)) return s.slice(0, 1000);
    if (/^\/[\w./-]+$/.test(s) && !s.includes("..")) return (base || "") + s;
    return "";
  }

  // The text blocks' little HTML: bold, italic, underline, line breaks, links (http, https, mailto) and a colour on a
  // span. Every other tag is dropped (its text kept), every other attribute too, and text is escaped.
  const KEEP = { b: "b", strong: "b", i: "i", em: "i", u: "u", br: "br", a: "a", span: "span", p: "br", div: "br" };
  function cleanInline(html) {
    const src = String(html == null ? "" : html).slice(0, 20000);
    let out = "", last = 0;
    const open = [];
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>/g;
    let m;
    const text = (t) => esc(t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    while ((m = re.exec(src))) {
      out += text(src.slice(last, m.index));
      last = re.lastIndex;
      const closing = !!m[1], tag = KEEP[m[2].toLowerCase()];
      if (!tag) continue;
      if (tag === "br") { if (!closing && m[2].toLowerCase() !== "br" && out && !/<br>$/.test(out)) out += "<br>"; else if (m[2].toLowerCase() === "br") out += "<br>"; continue; }
      if (closing) {
        const at = open.lastIndexOf(tag);
        if (at >= 0) { while (open.length > at) out += "</" + open.pop() + ">"; }
        continue;
      }
      let attrs = "";
      if (tag === "a") {
        const h = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3]);
        const url = h ? safeUrl((h[2] || h[3] || h[4] || "").replace(/&amp;/g, "&")) : "";
        if (!url) continue;
        attrs = ` href="${esc(url)}" style="color:inherit;text-decoration:underline"`;
      } else if (tag === "span") {
        // A colour as #hex, or as rgb(…) (how browsers write one picked in the editor).
        const c = /color\s*:\s*(#[0-9a-fA-F]{3,6})/.exec(m[3]), rgb = /color\s*:\s*rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/.exec(m[3]);
        const hex = c && COLOR_RE.test(c[1]) ? c[1] : rgb ? "#" + rgb.slice(1, 4).map(v => Math.min(255, Number(v)).toString(16).padStart(2, "0")).join("") : "";
        if (!hex) continue;
        attrs = ` style="color:${hex}"`;
      }
      out += "<" + tag + attrs + ">";
      open.push(tag);
    }
    out += text(src.slice(last));
    while (open.length) out += "</" + open.pop() + ">";
    return out.replace(/(<br>)+$/, "");
  }
  // Raw HTML written on the HTML tab: the owner's own, kept as written, less what never belongs in an email (scripts,
  // frames, forms, event handlers, javascript: links).
  function cleanRaw(html) {
    return String(html == null ? "" : html).slice(0, 200000)
      .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta|base)\b[\s\S]*?(<\/\s*\1\s*>|$)/gi, (m0, t) => /^(link|meta|base|input)$/i.test(t) ? "" : "")
      .replace(/<\s*(link|meta|base|input)\b[^>]*>/gi, "")
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/(href|src)\s*=\s*("|')?\s*(javascript|data|vbscript):[^"'>\s]*("|')?/gi, '$1="#"');
  }

  // The merge fields, filled with this person's values (escaped). Unknown {words} are left as typed.
  function merge(html, vars, escape) {
    const v = vars || {};
    const first = String(v.firstName || (v.name ? String(v.name).trim().split(/\s+/)[0] : "") || "there");
    const map = { "first name": first, "name": v.name || "", "code": v.code || "", "shop": v.shop || v.business || "", "expires": v.expires || "", "business": v.business || "" };
    return String(html).replace(/\{(first name|name|code|shop|expires|business)\}/gi, (m0, k) => escape ? esc(map[k.toLowerCase()]) : String(map[k.toLowerCase()]));
  }

  // A design as stored, made safe and complete: known blocks only, at most MAX_BLOCKS, each field cleaned.
  function normalizeDesign(d) {
    const src = d && typeof d === "object" ? d : {};
    if (typeof src.html === "string" && src.html.trim()) return { html: String(src.html).slice(0, 200000) };
    const blocks = (Array.isArray(src.blocks) ? src.blocks : []).filter(b => b && BLOCK_TYPES.includes(b.t)).slice(0, MAX_BLOCKS).map((b) => {
      const s = (v, n) => String(v == null ? "" : v).slice(0, n);
      const o = { t: b.t };
      if (b.pad != null) o.pad = pad(b.pad, 14);
      if (b.t === "banner") Object.assign(o, { h: s(b.h, 120), s: s(b.s, 200), art: ["theme", "image", "none"].includes(b.art) ? b.art : "theme", img: s(b.img, 1000) });
      else if (b.t === "heading") Object.assign(o, { x: s(b.x, 300), align: align(b.align, "left") });
      else if (b.t === "text") Object.assign(o, { x: s(b.x, 20000), align: align(b.align, "left"), ...(COLOR_RE.test(b.color || "") ? { color: b.color } : {}) });
      else if (b.t === "code") Object.assign(o, { x: s(b.x, 200) });
      else if (b.t === "button") Object.assign(o, { x: s(b.x, 60), url: s(b.url, 1000) });
      else if (b.t === "products") o.items = (Array.isArray(b.items) ? b.items : []).slice(0, 4).map(p => ({ name: s(p && p.name, 120), price: s(p && p.price, 30), image: s(p && p.image, 1000), url: s(p && p.url, 1000) }));
      else if (b.t === "image") Object.assign(o, { src: s(b.src, 1000), alt: s(b.alt, 200), url: s(b.url, 1000) });
      else if (b.t === "spacer") o.h = pad(b.h, 24);
      return o;
    });
    return { blocks };
  }

  // A new design for a theme: its banner, a greeting with its sample text, the code box (when there is a discount),
  // its button and a short sign-off.
  function starterDesign(key, withCode) {
    const th = theme(key);
    return { blocks: [
      { t: "banner", h: th.h, s: th.s, art: "theme" },
      { t: "text", x: "Hi {first name},<br>" + esc(th.body), align: "left" },
      ...(withCode ? [{ t: "code", x: "YOUR CODE" }] : []),
      { t: "button", x: th.button, url: "" },
      { t: "divider" },
      { t: "text", x: "Questions? Just reply to this email.", align: "center" },
    ] };
  }

  // One block's table row. opts: { th, assetBase, shopUrl, vars }.
  function blockHtml(b, opts) {
    const th = opts.th, p = pad(b.pad, 14), x = (n) => merge(n, opts.vars, true);
    const row = (inner, style) => `<tr><td style="padding:${p}px 28px;${style || ""}">${inner}</td></tr>`;
    if (b.t === "banner") {
      const art = b.art === "image" ? safeImg(b.img, opts.assetBase) : b.art === "theme" ? safeImg(opts.artUrl ? opts.artUrl(opts.themeKey) : "/email-art/" + opts.themeKey + ".png", opts.assetBase) : "";
      return `<tr><td style="background:${th.bg};color:${th.fg};text-align:center;padding:0;">`
        + (art ? `<img src="${esc(art)}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;">` : "")
        + `<div style="padding:${art ? 18 : 34}px 24px ${art ? 24 : 34}px;">`
        + (b.h ? `<div style="font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.15;letter-spacing:.03em;color:${th.fg};">${x(esc(b.h))}</div>` : "")
        + (b.s ? `<div style="font-size:15px;line-height:1.5;margin-top:8px;color:${th.fg};">${x(esc(b.s))}</div>` : "")
        + `</div></td></tr>`;
    }
    if (b.t === "heading") return row(`<div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.25;color:#232323;text-align:${align(b.align, "left")};">${x(esc(b.x))}</div>`);
    if (b.t === "text") return row(`<div style="font-size:15px;line-height:1.6;color:${color(b.color, "#232323")};text-align:${align(b.align, "left")};">${x(cleanInline(b.x))}</div>`);
    if (b.t === "code") {
      if (!opts.vars || !opts.vars.code) return opts.preview ? row(`<div style="border:2px dashed ${th.accent};padding:12px;text-align:center;color:#6b6558;font-size:13px;">The code box shows when the campaign has a discount (step 3).</div>`) : "";
      return row(`<div style="border:2px dashed ${th.accent};padding:14px;text-align:center;">`
        + (b.x ? `<div style="font-size:12px;letter-spacing:.06em;color:#6b6558;">${x(esc(b.x))}</div>` : "")
        + `<div style="font-family:'Courier New',monospace;font-size:24px;letter-spacing:.12em;color:#232323;margin-top:4px;">${esc(opts.vars.code)}</div>`
        + (opts.vars.codeLabel ? `<div style="font-size:12px;color:#6b6558;margin-top:4px;">${esc(opts.vars.codeLabel)}${opts.vars.expires ? " · until " + esc(opts.vars.expires) : ""}</div>` : "")
        + `</div>`);
    }
    if (b.t === "button") {
      const url = safeUrl(b.url) || safeUrl(opts.shopUrl) || "";
      const label = x(esc(b.x || "SHOP NOW"));
      const btn = `<span style="display:inline-block;background:${th.accent};color:${th.accentText};padding:12px 28px;border-radius:2px;font-size:14px;letter-spacing:.06em;text-decoration:none;">${label}</span>`;
      return row(`<div style="text-align:center;">${url ? `<a href="${esc(url)}" style="text-decoration:none;">${btn}</a>` : btn}</div>`);
    }
    if (b.t === "products") {
      const items = (b.items || []).slice(0, 4);
      if (!items.length) return opts.preview ? row(`<div style="border:1px dashed #ccc;padding:18px;text-align:center;color:#888;font-size:13px;">Pick products for this block.</div>`) : "";
      const w = Math.floor(100 / items.length);
      const cells = items.map((it) => {
        const img = safeImg(it.image, opts.assetBase), url = safeUrl(it.url) || safeUrl(opts.shopUrl);
        const inner = (img ? `<img src="${esc(img)}" alt="${esc(it.name)}" width="120" style="display:block;width:100%;max-width:160px;height:auto;margin:0 auto;border:0;">` : "")
          + `<div style="font-size:13px;color:#232323;margin-top:6px;">${esc(it.name)}</div>`
          + (it.price ? `<div style="font-size:13px;color:#6b6558;">${esc(it.price)}</div>` : "");
        return `<td width="${w}%" style="padding:0 6px;text-align:center;vertical-align:top;">${url ? `<a href="${esc(url)}" style="text-decoration:none;color:inherit;">${inner}</a>` : inner}</td>`;
      }).join("");
      return row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>`);
    }
    if (b.t === "image") {
      const src = safeImg(b.src, opts.assetBase);
      if (!src) return opts.preview ? row(`<div style="border:1px dashed #ccc;padding:18px;text-align:center;color:#888;font-size:13px;">Add a picture's web address.</div>`) : "";
      const img = `<img src="${esc(src)}" alt="${esc(b.alt)}" width="544" style="display:block;width:100%;height:auto;border:0;">`;
      const url = safeUrl(b.url);
      return row(url ? `<a href="${esc(url)}">${img}</a>` : img);
    }
    if (b.t === "divider") return row(`<div style="border-top:1px solid #e5e1d8;height:1px;line-height:1px;font-size:1px;">&nbsp;</div>`);
    if (b.t === "spacer") return `<tr><td style="height:${pad(b.h, 24)}px;line-height:1px;font-size:1px;">&nbsp;</td></tr>`;
    return "";
  }

  // The whole email: { html, text }. opts: theme (key), design, vars (the person's merge values, code, codeLabel,
  // expires), preheader, shopUrl, assetBase (made absolute: "https://site"), artUrl(key) (a picture's address for the
  // theme's banner — the desktop's cid:), footerHtml / footerText (the business block and the unsubscribe line),
  // preview (true in the editor: empty blocks say what to add).
  function render(opts) {
    const o = opts || {};
    const themeKey = THEMES[o.theme] ? o.theme : "plain";
    const th = theme(themeKey);
    const design = normalizeDesign(o.design);
    const ctx = { th, themeKey, assetBase: o.assetBase || "", artUrl: o.artUrl, shopUrl: o.shopUrl || "", vars: o.vars || {}, preview: !!o.preview };
    const body = design.html != null
      ? `<tr><td style="padding:0;">${merge(cleanRaw(design.html), ctx.vars, true)}</td></tr>`
      : design.blocks.map(b => blockHtml(b, ctx)).join("");
    const pre = o.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(merge(o.preheader, ctx.vars, false))}</div>` : "";
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.subject || "")}</title></head>`
      + `<body style="margin:0;padding:0;background:#F6F3EC;">${pre}`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F3EC;"><tr><td align="center" style="padding:20px 10px;">`
      + `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;font-family:Helvetica,Arial,sans-serif;color:#232323;">`
      + body
      + `<tr><td style="padding:18px 28px 24px;border-top:1px solid #eee;font-size:12px;line-height:1.5;color:#6b6558;text-align:center;">${o.footerHtml || ""}</td></tr>`
      + `</table></td></tr></table></body></html>`;
    return { html, text: textOf(design, ctx) + (o.footerText ? "\n\n--\n" + o.footerText : "") };
  }

  // The editor's canvas: one table row of HTML per block (the same rows render() puts in the email), so a block can be
  // picked by clicking it. opts as for render().
  function blockRows(opts) {
    const o = opts || {};
    const themeKey = THEMES[o.theme] ? o.theme : "plain";
    const design = normalizeDesign(o.design);
    if (design.html != null) return null;
    const ctx = { th: theme(themeKey), themeKey, assetBase: o.assetBase || "", artUrl: o.artUrl, shopUrl: o.shopUrl || "", vars: o.vars || {}, preview: true };
    return design.blocks.map(b => blockHtml(b, ctx) || `<tr><td style="padding:6px 28px;color:#999;font-size:12px;">(empty)</td></tr>`);
  }

  // The plain-text part: each block's words, in order.
  function textOf(design, ctx) {
    const plain = (h) => String(h).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    if (design.html != null) return plain(merge(cleanRaw(design.html), ctx.vars, false)).replace(/\n{3,}/g, "\n\n").trim();
    const out = [];
    for (const b of design.blocks) {
      if (b.t === "banner") out.push([b.h, b.s].filter(Boolean).join("\n"));
      else if (b.t === "heading") out.push(b.x);
      else if (b.t === "text") out.push(plain(cleanInline(b.x)));
      else if (b.t === "code" && ctx.vars.code) out.push((b.x ? b.x + ": " : "Your code: ") + ctx.vars.code + (ctx.vars.codeLabel ? " (" + ctx.vars.codeLabel + ")" : ""));
      else if (b.t === "button") { const u = safeUrl(b.url) || safeUrl(ctx.shopUrl); out.push((b.x || "Shop now") + (u ? ": " + u : "")); }
      else if (b.t === "products") out.push((b.items || []).map(p => "- " + p.name + (p.price ? " " + p.price : "")).join("\n"));
      else if (b.t === "image" && b.alt) out.push(b.alt);
      else if (b.t === "divider") out.push("----");
    }
    return merge(out.filter(Boolean).join("\n\n"), ctx.vars, false).trim();
  }

  root.OddCampaignRender = { THEMES, THEME_KEYS, BLOCK_TYPES, MAX_BLOCKS, theme, render, blockRows, normalizeDesign, starterDesign, cleanInline, cleanRaw, merge, safeUrl, esc };
})(typeof globalThis !== "undefined" ? globalThis : this);
