// A fake mail server for functions/_lib/smtp.js: `connect` stands in for cloudflare:sockets' connect,
// and the "server" answers like a real one (EHLO, STARTTLS, AUTH PLAIN / LOGIN, MAIL, RCPT, DATA, QUIT).
// Everything the client said, and every message it delivered, is kept for the test to look at.
//
//   const srv = fakeSmtp({ user: "me@x.test", pass: "app-pass", auth: ["PLAIN", "LOGIN"], refuseRcpt: ["bad@x.test"] });
//   smtpSend(settings, "app-pass", message, { connect: srv.connect })
//   srv.log      — the client's lines (passwords as sent, base64)
//   srv.messages — [{ from, rcpt: [...], data }]
//   srv.opens    — [{ hostname, port, secureTransport }]
//   srv.tls      — whether the current connection was encrypted (STARTTLS or "on") when AUTH came
function fakeSmtp(opts = {}) {
  const o = Object.assign({ user: "me@mail.test", pass: "app-pass", auth: ["PLAIN", "LOGIN"], refuseRcpt: [], refuseFrom: false, starttls: true,
    greeting: "220 mail.test ESMTP ready", failConnect: null, silent: false }, opts);
  const srv = { log: [], messages: [], opens: [], authedOverTls: null, closed: 0 };
  srv.connect = (addr, options) => {
    srv.opens.push({ hostname: addr.hostname, port: addr.port, secureTransport: options && options.secureTransport });
    if (o.failConnect) throw new Error(o.failConnect);
    const state = { tls: options && options.secureTransport === "on", mode: "cmd", data: "", from: "", rcpt: [], loginStep: 0, loginUser: "" };
    const make = () => {
      let ctrl;
      const sock = {};
      sock.readable = new ReadableStream({ start(c) { ctrl = c; } });
      const say = (s) => { try { ctrl.enqueue(new TextEncoder().encode(s.endsWith("\r\n") ? s : s + "\r\n")); } catch (e) {} };
      let buf = "";
      sock.writable = new WritableStream({ write(chunk) {
        buf += new TextDecoder().decode(chunk);
        for (;;) {
          if (state.mode === "data") {
            const end = buf.indexOf("\r\n.\r\n");
            if (end < 0) return;
            const data = buf.slice(0, end + 2); buf = buf.slice(end + 5);
            srv.messages.push({ from: state.from, rcpt: state.rcpt.slice(), data: data.replace(/(^|\r\n)\.\./g, "$1.") });
            state.mode = "cmd"; state.rcpt = [];
            say("250 2.0.0 OK queued as 12345");
            continue;
          }
          const i = buf.indexOf("\r\n");
          if (i < 0) return;
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          srv.log.push(line);
          handle(line, say);
        }
      } });
      sock.opened = Promise.resolve();
      sock.startTls = () => { state.tls = true; const next = make(); return next; };
      sock.close = async () => { srv.closed++; try { ctrl.close(); } catch (e) {} };
      sock._say = say;
      return sock;
    };
    const handle = (line, say) => {
      if (o.silent) return;
      const up = line.toUpperCase();
      if (state.loginStep === 1) { state.loginUser = Buffer.from(line, "base64").toString(); state.loginStep = 2; return say("334 UGFzc3dvcmQ6"); }
      if (state.loginStep === 2) {
        state.loginStep = 0; srv.authedOverTls = state.tls;
        return Buffer.from(line, "base64").toString() === o.pass && state.loginUser === o.user ? say("235 2.7.0 Accepted") : say("535 5.7.8 Username and Password not accepted");
      }
      if (/^EHLO /.test(up)) {
        const caps = ["250-mail.test Hello"];
        if (!state.tls && o.starttls) caps.push("250-STARTTLS");
        if (o.auth.length) caps.push("250-AUTH " + o.auth.join(" "));
        caps.push("250 SIZE 35882577");
        return say(caps.join("\r\n"));
      }
      if (up === "STARTTLS") return say("220 2.0.0 Ready to start TLS");
      if (/^AUTH PLAIN /.test(up)) {
        srv.authedOverTls = state.tls;
        const [, u, p] = Buffer.from(line.slice(11), "base64").toString().split("\0");
        return u === o.user && p === o.pass ? say("235 2.7.0 Accepted") : say("535 5.7.8 Username and Password not accepted");
      }
      if (up === "AUTH LOGIN") { state.loginStep = 1; return say("334 VXNlcm5hbWU6"); }
      if (/^MAIL FROM:/.test(up)) { if (o.refuseFrom) return say("553 5.7.1 Sender address rejected"); state.from = line.slice(10).replace(/[<>]/g, ""); return say("250 2.1.0 OK"); }
      if (/^RCPT TO:/.test(up)) { const a = line.slice(8).replace(/[<>]/g, ""); if (o.refuseRcpt.includes(a)) return say("550 5.1.1 No such user"); state.rcpt.push(a); return say("250 2.1.5 OK"); }
      if (up === "DATA") { state.mode = "data"; return say("354 Go ahead"); }
      if (up === "QUIT") return say("221 2.0.0 Bye");
      return say("502 5.5.1 Unrecognized command");
    };
    const first = make();
    queueMicrotask(() => first._say(o.greeting));
    return first;
  };
  return srv;
}

// A delivered message, taken apart: headers (lower-case names, unfolded) and its MIME parts, each with
// its headers and body decoded from base64.
function parseMessage(data) {
  const split = (raw) => { const i = raw.indexOf("\r\n\r\n"); return [raw.slice(0, i), raw.slice(i + 4)]; };
  const headers = (h) => { const out = {}; for (const l of h.replace(/\r\n[ \t]+/g, " ").split("\r\n")) { const i = l.indexOf(":"); if (i > 0) out[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); } return out; };
  const parts = [];
  const walk = (raw) => {
    const [h, body] = split(raw), hd = headers(h);
    const b = /boundary="([^"]+)"/.exec(hd["content-type"] || "");
    if (b) { for (const p of body.split("--" + b[1]).slice(1)) { if (p.startsWith("--")) break; walk(p.replace(/^\r\n/, "").replace(/\r\n$/, "")); } return; }
    const decoded = /base64/i.test(hd["content-transfer-encoding"] || "") ? Buffer.from(body.replace(/\s+/g, ""), "base64") : Buffer.from(body);
    parts.push({ headers: hd, bytes: decoded, text: decoded.toString("utf8") });
  };
  const [h] = split(data);
  walk(data);
  return { headers: headers(h), parts };
}
// "=?UTF-8?B?…?=" words back to text.
const decodeWords = (s) => String(s).replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/g, (_, b) => Buffer.from(b, "base64").toString("utf8")).trim();

module.exports = { fakeSmtp, parseMessage, decodeWords };
