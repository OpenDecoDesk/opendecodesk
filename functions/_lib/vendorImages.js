// Copies one vendor image into the shop's public image bucket (IMAGES) — the fallback for an image a vendor
// lists that isn't in the local bulk-image download the admin picked. Normally images go through the admin's
// own upload (resized in the browser by /api/upload). Same rules as upload.js: real raster images only,
// checked by magic bytes, 5 MB at most (read under the cap, never buffered whole first), and the object key is
// made here — the caller never picks it.
import { readBodyWithLimit, hasValidMagicBytes } from "./fileUpload.js";

const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
export const VENDOR_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

// Addresses an image link may never point at: this machine, the private networks behind it, and the blocks
// reserved for anything but the public internet. Without this the server could be pointed at its own network
// (an internal admin page, a cloud metadata address). The hostname is URL.hostname: lower-case, an IPv4 address
// already in dotted form ("2130706433" and "0x7f.1" both become 127.0.0.1), an IPv6 address in brackets.
// Only the address written in the link is known here; a name that resolves to a private address is refused
// on the desktop by its outbound rule (desktop/server.js), and on Cloudflare its fetch can't reach the
// network the Worker runs in.
const PRIVATE_V4_ = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
function v4Number_(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some(n => n > 255) ? null : ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function privateV4_(n) {
  return PRIVATE_V4_.some(([base, bits]) => ((n ^ v4Number_(base)) >>> (32 - bits)) === 0);
}
// An IPv6 address as its eight 16-bit groups, or null. "::" and a dotted IPv4 tail are read.
function v6Groups_(s) {
  let tail = null;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const n = v4Number_(dotted[2]);
    if (n == null) return null;
    s = dotted[1] + "0:0";
    tail = [n >>> 16, n & 0xffff];
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h) => (h ? h.split(":") : []);
  const a = part(halves[0]), b = halves.length === 2 ? part(halves[1]) : [];
  if (a.concat(b).some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const fill = 8 - a.length - b.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = a.concat(Array(halves.length === 2 ? fill : 0).fill("0"), b).map(g => parseInt(g, 16));
  if (tail) { groups[6] = tail[0]; groups[7] = tail[1]; }
  return groups;
}
export function privateHost_(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.startsWith("[") || h.includes(":")) {
    const g = v6Groups_(h.replace(/^\[|\]$/g, ""));
    if (!g) return true;                                                // not an address that can be read: refused
    const v4 = () => ((g[6] << 16) >>> 0) + g[7];
    if (g.slice(0, 6).every(x => x === 0)) return true;                // ::, ::1 and the old IPv4-compatible ::a.b.c.d
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return privateV4_(v4());   // ::ffff:a.b.c.d (IPv4-mapped)
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return privateV4_(v4());   // 64:ff9b::a.b.c.d (NAT64)
    if ((g[0] & 0xfe00) === 0xfc00) return true;                       // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true;                       // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true;                       // fec0::/10 the old site-local
    if ((g[0] & 0xff00) === 0xff00) return true;                       // ff00::/8 multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;               // 2001:db8::/32 documentation
    return false;
  }
  const n = v4Number_(h);
  if (n != null) return privateV4_(n);
  if (/^[\d.]+$/.test(h)) return true;                                  // digits URL didn't read as an address
  return !h.includes(".");                                              // a bare name (a host on the local network)
}

// Why a link (or a redirect's address) can't be fetched, or null when it can.
function refuseTarget_(u) {
  if (u.protocol !== "https:" || u.username || u.password) return "Only https image links can be downloaded.";
  if (privateHost_(u.hostname)) return "That address can't be downloaded.";
  return null;
}
const MAX_REDIRECTS_ = 3;

export async function copyVendorImage(env, url, fetchImpl = fetch) {
  if (!env.IMAGES || !env.R2_PUBLIC_BASE) return { ok: false, message: "Image storage isn't set up on this site." };
  let u;
  try { u = new URL(String(url || "")); } catch { return { ok: false, message: "That isn't a web address." }; }
  // Redirects are followed here, one hop at a time, so each new address is checked like the first: a public
  // host can't send the request on to a private one (or to plain http).
  let res;
  for (let hop = 0; ; hop++) {
    const refused = refuseTarget_(u);
    if (refused) return { ok: false, message: refused };
    try { res = await fetchImpl(u.toString(), { redirect: "manual", headers: { Accept: "image/*" } }); }
    catch (e) { return { ok: false, message: "The vendor's server couldn't be reached." }; }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("Location") : null;
    if (!location) break;
    try { if (res.body) await res.body.cancel(); } catch (e) { /* nothing to free */ }
    if (hop >= MAX_REDIRECTS_) return { ok: false, message: "The image link redirects too many times." };
    try { u = new URL(location, u); } catch { return { ok: false, message: "The vendor's server redirected to an address that isn't valid." }; }
  }
  if (!res.ok) return { ok: false, message: `The vendor's server answered ${res.status}.` };
  const type = String(res.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const ext = TYPES[type];
  if (!ext) return { ok: false, message: "That link isn't a JPEG, PNG, WebP or GIF image." };
  const read = await readBodyWithLimit(res, VENDOR_IMAGE_MAX_BYTES).catch(() => null);
  if (!read) return { ok: false, message: "The image couldn't be read." };
  if (read.tooLarge) return { ok: false, message: "The image is over 5 MB — use the copy in your downloaded image folder instead." };
  if (!read.bytes || !read.bytes.byteLength || !hasValidMagicBytes(read.bytes, type)) return { ok: false, message: "The file isn't the image type it claims to be." };
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^a-z0-9]/gi, "").slice(0, 32).toLowerCase();
  const key = "uploads/blanks/" + id + "." + ext;
  try {
    await env.IMAGES.put(key, read.bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
  } catch (e) { return { ok: false, message: "The image couldn't be stored." }; }
  // Same base as upload.js: some environments hold R2_PUBLIC_BASE without the scheme.
  const rawBase = String(env.R2_PUBLIC_BASE).replace(/\/+$/, "");
  const base = /^https?:\/\//i.test(rawBase) ? rawBase : "https://" + rawBase;
  // The browser then makes its 320px thumbnail (…/<id>-thumb.<ext>, what thumbUrl() shows) through /api/upload?thumbFor=<id>.
  return { ok: true, url: base + "/" + key, id };
}
