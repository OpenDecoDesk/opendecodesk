// Email through the owner's own mailbox (SMTP) on a cloud install: Gmail, iCloud, Fastmail, the web
// host's mail… The desktop program does the same in Node with nodemailer (desktop/mailer.js); a Worker
// can't run nodemailer, so this speaks SMTP itself over Cloudflare's TCP sockets (cloudflare:sockets).
//
//   settings = { host, port, security: "starttls" | "tls", user, from }   (smtpCleanSettings)
//   the password is saved encrypted in D1 (db.js getEmailMailbox, vendorCredentials.js)
//
// Port 465 is encrypted from the start ("tls"); 587 starts plain and is encrypted with STARTTLS before
// signing in ("starttls"), and the password is never sent unless the connection is encrypted. Port 25 is
// refused (Cloudflare blocks it, and so does nearly every mail provider for sending).
//
// smtpVerify(settings, password) signs in without sending; smtpSend(settings, password, message) sends one
// message. Both answer { ok, message } in words the owner can act on, with the server's own answer after
// them, and never throw. `opts.connect` stands in for cloudflare:sockets' connect in the tests.

const SMTP_EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
const SMTP_TIMEOUT_MS = 20000;
// Attachments: pictures and PDFs, at most 5 and 20 MB in all (desktop/mailer.js's limits).
const SMTP_MAX_ATTACHMENTS = 5, SMTP_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// The settings as they will be saved, or an Error saying what's wrong — the same rules as the desktop's
// cleanSmtpSettings (desktop/mailer.js; test184 keeps them in step).
export function smtpCleanSettings(s) {
  s = s && typeof s === "object" ? s : {};
  const host = String(s.host || "").trim().toLowerCase();
  const port = Number(s.port);
  const security = s.security === "tls" ? "tls" : "starttls";
  const from = String(s.from || "").trim();
  const user = String(s.user || "").trim() || from;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) throw new Error("Enter the mail server's name, like smtp.gmail.com.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The port is a number, usually 587 or 465.");
  if (port === 25) throw new Error("Port 25 is for servers passing mail between them, and most internet providers block it. Use 587 or 465.");
  if (!SMTP_EMAIL_RE.test(from)) throw new Error("Enter the mailbox's email address.");
  if (user.length > 200) throw new Error("That username is too long.");
  return { host, port, security, user, from };
}

// ---- Encoding -----------------------------------------------------------------------------------------
const smtpEnc_ = new TextEncoder();
function smtpB64Bytes_(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const smtpB64_ = (str) => smtpB64Bytes_(smtpEnc_.encode(String(str)));
// Base64 in lines of 76, as MIME wants.
const smtpWrap76_ = (b64) => String(b64).replace(/\s+/g, "").replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
// A header value: as is when it's plain ASCII, else RFC 2047 encoded-words (UTF-8, base64).
function smtpHeaderText_(s) {
  s = String(s || "").replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let chunk = "";
  for (const ch of s) {   // whole characters, each word at most ~45 bytes of text
    if (smtpEnc_.encode(chunk + ch).length > 45) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => "=?UTF-8?B?" + smtpB64_(w) + "?=").join("\r\n ");
}
// "Name" <address>, the name quoted or encoded as needed.
function smtpAddress_(name, address) {
  name = String(name || "").replace(/[<>"\r\n]/g, "").trim().slice(0, 100);
  if (!name) return address;
  return (/^[\x20-\x7e]*$/.test(name) ? '"' + name.replace(/\\/g, "") + '"' : smtpHeaderText_(name)) + " <" + address + ">";
}
const smtpBoundary_ = () => "=_odd_" + Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");

// [{ filename, contentType, contentBase64, cid }] → checked attachments, or { error }.
function smtpAttachments_(list) {
  if (list == null) return { attachments: [] };
  if (!Array.isArray(list) || list.length > SMTP_MAX_ATTACHMENTS) return { error: "At most " + SMTP_MAX_ATTACHMENTS + " attachments." };
  let total = 0;
  const attachments = [];
  for (const a of list) {
    const type = String((a && a.contentType) || "");
    if (!/^(image\/(jpeg|png|gif|webp|heic|heif)|application\/pdf)$/.test(type)) return { error: "Only pictures and PDFs can be attached." };
    const b64 = String((a && a.contentBase64) || "").replace(/\s+/g, "");
    const bytes = Math.floor(b64.length * 3 / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
    total += bytes;
    if (!b64 || bytes <= 0 || total > SMTP_MAX_ATTACHMENT_BYTES) return { error: "The attachments are too big for one email." };
    const filename = String(a.filename || "attachment").replace(/[^A-Za-z0-9 ._-]/g, "_").slice(0, 80);
    const cid = /^[A-Za-z0-9._-]{1,60}$/.test(String(a.cid || "")) ? String(a.cid) : "";
    attachments.push({ filename, contentType: type, b64, cid });
  }
  return { attachments };
}

// The whole message (headers + body), CRLF line ends. BCC addresses are never written into it: they
// only go in the envelope (RCPT TO).
export function smtpBuildMessage({ from, fromName, to, replyTo, subject, text, html, attachments = [], now = new Date(), messageId } = {}) {
  const domain = String(from).split("@")[1] || "localhost";
  const head = [
    "From: " + smtpAddress_(fromName, from),
    "To: " + to,
    ...(replyTo ? ["Reply-To: " + replyTo] : []),
    "Subject: " + smtpHeaderText_(String(subject || "").slice(0, 300)),
    "Date: " + now.toUTCString().replace(/GMT$/, "+0000"),
    "Message-ID: <" + (messageId || (crypto.randomUUID() + "@" + domain)) + ">",
    "MIME-Version: 1.0",
  ];
  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", smtpWrap76_(smtpB64_(text || "(no plain-text body)"))].join("\r\n");
  let body;
  if (html) {
    const b = smtpBoundary_();
    body = ["Content-Type: multipart/alternative; boundary=\"" + b + "\"", "", "--" + b, textPart, "--" + b,
      ["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", smtpWrap76_(smtpB64_(html))].join("\r\n"), "--" + b + "--"].join("\r\n");
  } else body = textPart;
  const part = (a, inline) => ["Content-Type: " + a.contentType + "; name=\"" + a.filename + "\"", "Content-Transfer-Encoding: base64",
    "Content-Disposition: " + (inline ? "inline" : "attachment") + "; filename=\"" + a.filename + "\"", ...(inline ? ["Content-ID: <" + a.cid + ">"] : []), "", smtpWrap76_(a.b64)].join("\r\n");
  const inline = attachments.filter(a => a.cid && html), files = attachments.filter(a => !(a.cid && html));
  if (inline.length) {   // pictures the HTML shows (cid:…): multipart/related around it
    const b = smtpBoundary_();
    body = ["Content-Type: multipart/related; boundary=\"" + b + "\"", "", "--" + b, body, ...inline.flatMap(a => ["--" + b, part(a, true)]), "--" + b + "--"].join("\r\n");
  }
  if (files.length) {
    const b = smtpBoundary_();
    body = ["Content-Type: multipart/mixed; boundary=\"" + b + "\"", "", "--" + b, body, ...files.flatMap(a => ["--" + b, part(a, false)]), "--" + b + "--"].join("\r\n");
  }
  return head.join("\r\n") + "\r\n" + body + "\r\n";
}

// ---- The conversation -----------------------------------------------------------------------------------
class SmtpError extends Error {
  constructor(kind, message, reply) { super(message); this.kind = kind; this.reply = reply || ""; }
}

// One connection: reads replies (multi-line ones joined), writes commands, switches to TLS.
class SmtpConn {
  constructor(socket) { this.attach(socket); this.buf = ""; }
  attach(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.dec = new TextDecoder();
  }
  async line_(deadline) {
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i >= 0) { const l = this.buf.slice(0, i).replace(/\r$/, ""); this.buf = this.buf.slice(i + 1); return l; }
      let timer;
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new SmtpError("timeout", "timeout")), Math.max(1, deadline - Date.now())); });
      let r;
      try { r = await Promise.race([this.reader.read(), timeout]); } finally { clearTimeout(timer); }
      if (r.done) throw new SmtpError("closed", "The mail server closed the connection.");
      this.buf += this.dec.decode(r.value, { stream: true });
      if (this.buf.length > 64 * 1024) throw new SmtpError("protocol", "The mail server's answer was too long.");
    }
  }
  // → { code, text, lines }
  async reply(timeoutMs = SMTP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    const lines = [];
    for (;;) {
      const l = await this.line_(deadline);
      const m = /^(\d{3})([ -]?)(.*)$/.exec(l);
      if (!m) throw new SmtpError("protocol", "That doesn't look like a mail server.", l);
      lines.push(m[3]);
      if (m[2] !== "-") return { code: Number(m[1]), text: lines.join(" ").trim(), lines };
    }
  }
  async send(raw) { await this.writer.write(smtpEnc_.encode(raw)); }
  // A command and its answer; anything but `expect` (a number or list) is an error of `kind`.
  async cmd(line, expect, kind, timeoutMs) {
    if (line != null) await this.send(line + "\r\n");
    const r = await this.reply(timeoutMs);
    const ok = Array.isArray(expect) ? expect.includes(r.code) : r.code === expect;
    if (!ok) throw new SmtpError(kind, r.code + " " + r.text, r.code + " " + r.text);
    return r;
  }
  async startTls() {
    try { this.reader.releaseLock(); } catch (e) {}
    try { this.writer.releaseLock(); } catch (e) {}
    this.attach(this.socket.startTls());
    this.buf = "";
  }
  async close() {
    try { await this.send("QUIT\r\n"); } catch (e) {}
    try { await this.socket.close(); } catch (e) {}
  }
}

// A failure, in words the owner can act on, with the server's own answer after it (desktop/mailer.js
// explain(), for the same mistakes).
function smtpExplain_(e, settings) {
  const where = settings.host + ":" + settings.port;
  const said = String((e && (e.reply || e.message)) || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const kind = (e && e.kind) || "";
  let what;
  if (kind === "auth") what = "The mailbox refused the sign-in. Gmail and iCloud need an app password (made in the account's security settings), not the normal password.";
  else if (kind === "noauth") what = "The mail server at " + where + " doesn't offer a way to sign in. Check the server and port.";
  else if (kind === "tls") what = "The secure connection to " + where + " failed. Port 465 is usually \"SSL/TLS\" and 587 \"STARTTLS\"; check the one chosen matches the port.";
  else if (kind === "from") what = "The mail server didn't accept " + settings.from + " as the sender. Use the mailbox's own address.";
  else if (kind === "rcpt") what = "The mail server didn't accept the address it was sent to.";
  else if (kind === "data") what = "The mail server didn't take the email.";
  else if (kind === "timeout") what = "The mail server at " + where + " didn't answer in time. Check the server and port.";
  else if (kind === "closed" || kind === "protocol") what = "The mail server at " + where + " didn't talk like one. Check the server, the port and the security setting.";
  else if (kind === "connect" || /connect|refused|reset|unreachable|resolve|dns|network|lookup/i.test(said)) what = "Couldn't connect to " + where + ". Check the server and port.";
  else if (/tls|ssl|certificate|handshake/i.test(said)) what = "The secure connection to " + where + " failed. Port 465 is usually \"SSL/TLS\" and 587 \"STARTTLS\"; check the one chosen matches the port.";
  else what = "The mail server didn't take the email.";
  return said && kind !== "timeout" && !what.includes(said) ? what + " (" + said + ")" : what;
}

async function smtpConnectFn_(opts) {
  if (opts && typeof opts.connect === "function") return opts.connect;
  const mod = await import("cloudflare:sockets");
  return mod.connect;
}

// Opens the connection and signs in. → an SmtpConn ready for MAIL FROM.
async function smtpOpen_(settings, password, opts) {
  const connect = await smtpConnectFn_(opts);
  let socket;
  try {
    socket = connect({ hostname: settings.host, port: settings.port }, { secureTransport: settings.security === "tls" ? "on" : "starttls", allowHalfOpen: false });
    if (socket.opened) await socket.opened;
  } catch (e) { throw new SmtpError(settings.security === "tls" && /tls|ssl|certificate|handshake/i.test(String(e && e.message)) ? "tls" : "connect", String((e && e.message) || e)); }
  const conn = new SmtpConn(socket);
  try {
    await conn.cmd(null, 220, "protocol");
    const helo = "EHLO " + (String(settings.from).split("@")[1] || "localhost");
    let ehlo = await conn.cmd(helo, 250, "protocol");
    let secure = settings.security === "tls";
    if (!secure) {
      if (!ehlo.lines.some(l => /^STARTTLS\b/i.test(l))) throw new SmtpError("tls", "The server doesn't offer STARTTLS.");
      await conn.cmd("STARTTLS", 220, "tls");
      try { await conn.startTls(); } catch (e) { throw new SmtpError("tls", String((e && e.message) || e)); }
      secure = true;
      ehlo = await conn.cmd(helo, 250, "tls");
    }
    const auth = (ehlo.lines.find(l => /^AUTH[ =]/i.test(l)) || "").toUpperCase().split(/[ =]+/).slice(1);
    if (!secure) throw new SmtpError("tls", "not encrypted");   // never reached: the password only goes over TLS
    if (auth.includes("PLAIN")) {
      await conn.cmd("AUTH PLAIN " + smtpB64_("\0" + settings.user + "\0" + password), 235, "auth");
    } else if (auth.includes("LOGIN")) {
      await conn.cmd("AUTH LOGIN", 334, "auth");
      await conn.cmd(smtpB64_(settings.user), 334, "auth");
      await conn.cmd(smtpB64_(password), 235, "auth");
    } else throw new SmtpError("noauth", ehlo.text);
    return conn;
  } catch (e) {
    await conn.close();
    throw e;
  }
}

// Signs in without sending anything. { ok, message }.
export async function smtpVerify(settings, password, opts = {}) {
  let s;
  try { s = smtpCleanSettings(settings); } catch (e) { return { ok: false, message: e.message }; }
  if (!password) return { ok: false, message: "Enter the mailbox's password or app password." };
  try {
    const conn = await smtpOpen_(s, password, opts);
    await conn.close();
    return { ok: true, message: "Signed in to " + s.host + "." };
  } catch (e) { return { ok: false, message: smtpExplain_(e, s) }; }
}

// One message, from the mailbox's own address (a mailbox rewrites or refuses any other) under the
// business's name. { ok, message }.
export async function smtpSend(settings, password, { to, fromName, replyTo, bcc, subject, html, text, attachments } = {}, opts = {}) {
  let s;
  try { s = smtpCleanSettings(settings); } catch (e) { return { ok: false, message: e.message }; }
  to = String(to || "").trim();
  if (!SMTP_EMAIL_RE.test(to)) return { ok: false, message: "That isn't an email address: " + to.slice(0, 100) };
  const att = smtpAttachments_(attachments);
  if (att.error) return { ok: false, message: att.error };
  const bccList = (Array.isArray(bcc) ? bcc : bcc ? [bcc] : []).map(String).filter(a => SMTP_EMAIL_RE.test(a) && a.toLowerCase() !== to.toLowerCase());
  const reply = SMTP_EMAIL_RE.test(String(replyTo || "")) && String(replyTo).toLowerCase() !== s.from.toLowerCase() ? String(replyTo) : "";
  const raw = smtpBuildMessage({ from: s.from, fromName, to, replyTo: reply, subject, text, html, attachments: att.attachments, now: opts.now, messageId: opts.messageId });
  let conn;
  try {
    conn = await smtpOpen_(s, password, opts);
    await conn.cmd("MAIL FROM:<" + s.from + ">", 250, "from");
    await conn.cmd("RCPT TO:<" + to + ">", [250, 251], "rcpt");
    for (const b of bccList) { try { await conn.cmd("RCPT TO:<" + b + ">", [250, 251], "rcpt"); } catch (e) { /* the copy, not the customer's email */ } }
    await conn.cmd("DATA", 354, "data");
    // Dot-stuffing: a line starting with "." gets a second one; then the end mark.
    await conn.send(raw.replace(/(^|\r\n)\./g, "$1..") + ".\r\n");
    const done = await conn.cmd(null, 250, "data", 60000);
    await conn.close();
    return { ok: true, message: (done.code + " " + done.text).slice(0, 300) };
  } catch (e) {
    if (conn) await conn.close();
    return { ok: false, message: smtpExplain_(e, s) };
  }
}
