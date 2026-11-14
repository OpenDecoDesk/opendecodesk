// A cloud install can send through the owner's own mailbox (SMTP), as the desktop version does, instead
// of a hosted service (Resend / Cloudflare Email Service). functions/_lib/smtp.js speaks SMTP over
// Cloudflare's TCP sockets — here over a fake mail server (testlib/smtp-fake.js) — and email.js sends
// through it when Global settings → Email says so. The password is stored encrypted and never returned.
const fs = require("fs");
const path = require("path");
const { JSDOM, ResourceLoader } = require("jsdom");
const { fakeSmtp, parseMessage, decodeWords } = require("./testlib/smtp-fake");
const { makeAuth } = require("./testlib/auth-harness");
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

const SMTP = new Function(strip(read("functions/_lib/smtp.js")) + "\nreturn { smtpSend, smtpVerify, smtpCleanSettings, smtpBuildMessage };")();
const GMAIL = { host: "smtp.gmail.com", port: 587, security: "starttls", from: "me@mail.test", user: "" };
const MSG = { to: "pat@cust.test", fromName: "Acme Tees", replyTo: "owner@acme.test", bcc: ["receipts@acme.test"], subject: "Order received — A1 · $20.00 due",
  html: "<p>Thanks, Pat</p><img src=\"cid:proof1\">", text: "Thanks, Pat\n.a line that starts with a dot",
  attachments: [{ filename: "Invoice-A1.pdf", contentType: "application/pdf", contentBase64: Buffer.from("%PDF-1.4 fake").toString("base64") },
    { filename: "proof.png", contentType: "image/png", contentBase64: Buffer.from("PNGDATA").toString("base64"), cid: "proof1" }] };

(async () => {
  console.log("=== The SMTP client (smtp.js) ===");
  let srv = fakeSmtp({ user: "me@mail.test", pass: "app-pass" });
  let r = await SMTP.smtpSend(GMAIL, "app-pass", MSG, { connect: srv.connect });
  ok("587 connects for STARTTLS, upgrades before signing in, and the server takes it", r.ok && /250/.test(r.message) && srv.opens[0].port === 587 &&
    srv.opens[0].secureTransport === "starttls" && srv.log.includes("STARTTLS") && srv.authedOverTls === true);
  ok("…signs in with AUTH PLAIN as the mailbox (the username is the address when none is given)", srv.log.some(l => l.startsWith("AUTH PLAIN ")) &&
    Buffer.from(srv.log.find(l => l.startsWith("AUTH PLAIN ")).slice(11), "base64").toString() === "\0me@mail.test\0app-pass");
  const m = srv.messages[0], parsed = parseMessage(m.data);
  ok("envelope: from the mailbox, to the customer, and the receipts inbox as a BCC copy", m.from === "me@mail.test" && m.rcpt.join() === "pat@cust.test,receipts@acme.test");
  ok("the BCC is never written in the message itself", !/receipts@acme\.test/.test(m.data) && !/^bcc:/im.test(m.data));
  ok("From is the mailbox under the business's name; Reply-To the owner", parsed.headers.from === "\"Acme Tees\" <me@mail.test>" && parsed.headers["reply-to"] === "owner@acme.test" && parsed.headers.to === "pat@cust.test");
  ok("a subject with — and · goes as UTF-8 encoded words and reads back the same", /=\?UTF-8\?B\?/.test(parsed.headers.subject) && decodeWords(parsed.headers.subject) === MSG.subject);
  ok("Date, Message-ID on the mailbox's domain, MIME-Version", /\+0000$/.test(parsed.headers.date) && /@mail\.test>$/.test(parsed.headers["message-id"]) && parsed.headers["mime-version"] === "1.0");
  const types = parsed.parts.map(p => p.headers["content-type"].split(";")[0]);
  ok("parts: plain text, HTML, the inline proof picture (cid) and the PDF attached", types.join() === "text/plain,text/html,image/png,application/pdf");
  ok("…the text and HTML decode back exactly, the dot-line included (dot-stuffing undone by the server)", parsed.parts[0].text === MSG.text && parsed.parts[1].text === MSG.html);
  ok("…the picture is inline with its Content-ID; the PDF is an attachment with its name", /inline/.test(parsed.parts[2].headers["content-disposition"]) && parsed.parts[2].headers["content-id"] === "<proof1>" &&
    /attachment; filename="Invoice-A1\.pdf"/.test(parsed.parts[3].headers["content-disposition"]) && parsed.parts[3].text === "%PDF-1.4 fake");
  ok("it says goodbye and closes", srv.log[srv.log.length - 1] === "QUIT" && srv.closed >= 1);

  srv = fakeSmtp({ user: "me@mail.test", pass: "app-pass", auth: ["LOGIN"] });
  r = await SMTP.smtpSend({ ...GMAIL, host: "smtp.fastmail.com", port: 465, security: "tls" }, "app-pass", { to: "pat@cust.test", subject: "Hi", text: "Plain only" }, { connect: srv.connect });
  ok("465 is encrypted from the start (no STARTTLS), and AUTH LOGIN works when PLAIN isn't offered", r.ok && srv.opens[0].secureTransport === "on" && !srv.log.includes("STARTTLS") &&
    srv.log.includes("AUTH LOGIN") && srv.authedOverTls === true);
  ok("a plain-text-only message is just text/plain", parseMessage(srv.messages[0].data).parts.map(p => p.headers["content-type"].split(";")[0]).join() === "text/plain");

  console.log("\n=== When it doesn't work ===");
  srv = fakeSmtp({ user: "me@mail.test", pass: "app-pass" });
  r = await SMTP.smtpSend(GMAIL, "wrong", MSG, { connect: srv.connect });
  ok("a refused password: says to use an app password, with the server's answer, and nothing is sent", !r.ok && /app password/.test(r.message) && /535/.test(r.message) && !srv.messages.length);
  srv = fakeSmtp({ starttls: false });
  r = await SMTP.smtpVerify(GMAIL, "app-pass", { connect: srv.connect });
  ok("a server that won't encrypt on 587: the password is never sent", !r.ok && /secure connection/.test(r.message) && !srv.log.some(l => /^AUTH/.test(l)));
  srv = fakeSmtp({ refuseRcpt: ["pat@cust.test"] });
  r = await SMTP.smtpSend(GMAIL, "app-pass", MSG, { connect: srv.connect });
  ok("a refused recipient is a failure in words", !r.ok && /didn't accept the address/.test(r.message) && /550/.test(r.message));
  srv = fakeSmtp({ refuseRcpt: ["receipts@acme.test"] });
  r = await SMTP.smtpSend(GMAIL, "app-pass", MSG, { connect: srv.connect });
  ok("…but a refused BCC copy doesn't stop the customer's email", r.ok && srv.messages[0].rcpt.join() === "pat@cust.test");
  srv = fakeSmtp({ refuseFrom: true });
  r = await SMTP.smtpSend(GMAIL, "app-pass", MSG, { connect: srv.connect });
  ok("a refused sender says to use the mailbox's own address", !r.ok && /as the sender/.test(r.message));
  srv = fakeSmtp({ failConnect: "connection refused" });
  r = await SMTP.smtpVerify(GMAIL, "app-pass", { connect: srv.connect });
  ok("can't connect: check the server and port", !r.ok && /Couldn't connect to smtp\.gmail\.com:587/.test(r.message));
  srv = fakeSmtp({ greeting: "HTTP/1.1 400 Bad Request" });
  r = await SMTP.smtpVerify(GMAIL, "app-pass", { connect: srv.connect });
  ok("something that isn't a mail server is named as such", !r.ok && /doesn't look like a mail server|didn't talk like one/.test(r.message));
  srv = fakeSmtp({ user: "me@mail.test", pass: "app-pass" });
  r = await SMTP.smtpVerify(GMAIL, "app-pass", { connect: srv.connect });
  ok("verify signs in and sends nothing", r.ok && /Signed in to smtp\.gmail\.com/.test(r.message) && !srv.log.some(l => /^(MAIL|DATA)/.test(l)));
  ok("port 25 and a made-up server name are refused before connecting", !(await SMTP.smtpVerify({ ...GMAIL, port: 25 }, "x")).ok &&
    /Port 25/.test((await SMTP.smtpVerify({ ...GMAIL, port: 25 }, "x")).message) && /server's name/.test((await SMTP.smtpVerify({ ...GMAIL, host: "not a host" }, "x")).message));
  r = await SMTP.smtpSend(GMAIL, "app-pass", { ...MSG, attachments: [{ filename: "x.exe", contentType: "application/x-msdownload", contentBase64: "AAAA" }] }, { connect: fakeSmtp().connect });
  ok("only pictures and PDFs can be attached", !r.ok && /Only pictures and PDFs/.test(r.message));

  console.log("\n=== The same rules as the desktop's mailbox ===");
  const { cleanSmtpSettings } = require("./desktop/mailer.js");
  const cases = [GMAIL, { ...GMAIL, port: 465, security: "tls", user: "login-name" }, { ...GMAIL, port: 25 }, { ...GMAIL, host: "bad host" }, { ...GMAIL, from: "nope" }, { ...GMAIL, port: "x" }, { ...GMAIL, host: "SMTP.Gmail.com " }];
  const same = cases.every(c => { let a, b; try { a = SMTP.smtpCleanSettings(c); } catch (e) { a = "ERR " + e.message; } try { b = cleanSmtpSettings(c); } catch (e) { b = "ERR " + e.message; } return JSON.stringify(a) === JSON.stringify(b); });
  ok("smtpCleanSettings answers exactly as desktop/mailer.js cleanSmtpSettings, for good and bad settings", same);

  console.log("\n=== email.js: which way an email goes ===");
  const issues = [];
  global.__mailbox = { via: "mailbox", host: "smtp.gmail.com", port: 587, security: "starttls", user: "", from: "me@mail.test", password: "" };
  const E = new Function("issues", "const addOwnerNotice = async () => {}; const recordSystemIssue = async (db, kind) => issues.push(kind);\n" +
    "const getBusinessProfile = async () => ({ name: 'Acme Tees', ownerEmail: 'owner@acme.test', receiptsEmail: 'receipts@acme.test' }); const resolveTimeZone = () => 'UTC';\n" +
    "const getEmailMailbox = async () => global.__mailbox;\n" +
    strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" + strip(read("functions/_lib/email.js")) +
    "\nreturn { send_, sendTestEmail, encryptVendorCredentials };")(issues);
  const KEY = "a-long-random-master-key-for-tests";
  global.__mailbox.password = await E.encryptVendorCredentials({ VENDOR_CREDENTIALS_KEY: KEY }, { id: "smtp", password: "app-pass" });
  let fetched = [];
  global.fetch = async (url) => { fetched.push(String(url)); return { ok: true, status: 200, json: async () => ({ id: "re_1" }) }; };
  srv = fakeSmtp({ user: "me@mail.test", pass: "app-pass" });
  const env = { ROOT_DOMAIN: "acme.test", RESEND_API_KEY: "re_key123", VENDOR_CREDENTIALS_KEY: KEY, __SMTP_CONNECT_FOR_TESTS: srv.connect };
  let sent = await E.send_(env, { to: "pat@cust.test", subject: "Order received", html: "<p>Hi %%BUSINESS%%</p>", text: "Hi %%BUSINESS%%",
    attachments: [{ filename: "Receipt.pdf", contentType: "application/pdf", contentBase64: Buffer.from("%PDF").toString("base64") }] });
  const p1 = srv.messages[0] && parseMessage(srv.messages[0].data);
  ok("with the mailbox chosen, an email goes through it — not Resend, even with RESEND_API_KEY set", sent === true && srv.messages.length === 1 && fetched.length === 0);
  ok("…from the mailbox under the business name, reply-to the owner, BCC the receipts inbox, placeholders filled, PDF attached", p1.headers.from === "\"Acme Tees\" <me@mail.test>" &&
    p1.headers["reply-to"] === "owner@acme.test" && srv.messages[0].rcpt.includes("receipts@acme.test") && p1.parts[0].text === "Hi Acme Tees" &&
    p1.parts.some(p => /Receipt\.pdf/.test(p.headers["content-disposition"] || "")));
  srv = fakeSmtp({ user: "me@mail.test", pass: "changed-since" });
  issues.length = 0;
  sent = await E.send_({ ...env, __SMTP_CONNECT_FOR_TESTS: srv.connect }, { to: "pat@cust.test", subject: "Order received", text: "x" });
  ok("a mailbox that refuses: not sent, recorded as email_failed, and no other way tried", sent === false && issues.join() === "email_failed" && fetched.length === 0);
  issues.length = 0;
  sent = await E.send_({ ...env, VENDOR_CREDENTIALS_KEY: "" }, { to: "pat@cust.test", subject: "Order received", text: "x" });
  ok("without VENDOR_CREDENTIALS_KEY the password can't be read: a failure, not a quiet switch", sent === false && issues.join() === "email_failed" && fetched.length === 0);
  global.__mailbox = { ...global.__mailbox, via: "hosted" };
  sent = await E.send_(env, { to: "pat@cust.test", subject: "Order received", text: "x" });
  ok("with a hosted service chosen (the default), it goes through Resend as before", sent === true && fetched[0] === "https://api.resend.com/emails");
  global.__mailbox = { ...global.__mailbox, via: "mailbox" };
  srv = fakeSmtp({ user: "me@mail.test", pass: "app-pass" });
  const rep = await E.sendTestEmail({ ...env, __SMTP_CONNECT_FOR_TESTS: srv.connect }, "me@mail.test");
  ok("the test send reports the mailbox: provider smtp, from its address, the server's answer, no Resend hints", rep.ok && rep.provider === "smtp" && rep.from === "me@mail.test" &&
    /250/.test(rep.providerMessage) && rep.key === null && rep.hints.some(h => /Sent folder/.test(h)));
  ok("…and a desktop install is untouched by the setting (it has its own mailbox)", (await E.sendTestEmail({ EDITION: "desktop" }, "me@mail.test")).provider === "none");

  console.log("\n=== Global settings → Email: the server's side ===");
  const auth = await makeAuth();
  const cookie = await auth.firstAdmin();
  srv = fakeSmtp({ user: "me@mail.test", pass: "app-pass" });
  Object.assign(auth.env, { VENDOR_CREDENTIALS_KEY: KEY, __SMTP_CONNECT_FOR_TESTS: srv.connect, RESEND_API_KEY: "re_key123" });
  let a = await auth.orders({ action: "getEmailSettings" }, cookie);
  ok("a new install sends through a hosted service, and says which one is set up", a.body.status === "ok" && a.body.mailbox.via === "hosted" && a.body.hosted.resend === true && a.body.credentialsReady === true);
  const box = { via: "mailbox", host: "smtp.gmail.com", port: 587, security: "starttls", from: "me@mail.test", user: "" };
  a = await auth.orders({ action: "updateEmailSettings", emailSettings: { attachPdf: true }, mailbox: { ...box, password: "wrong" } }, cookie);
  ok("a mailbox that doesn't sign in isn't saved, and says why", a.status === 400 && /Not saved: The mailbox refused the sign-in/.test(a.body.message) &&
    (await auth.orders({ action: "getEmailSettings" }, cookie)).body.mailbox.via === "hosted");
  a = await auth.orders({ action: "updateEmailSettings", emailSettings: { attachPdf: true }, mailbox: { ...box } }, cookie);
  ok("…nor one with no password", a.status === 400 && /password/.test(a.body.message));
  a = await auth.orders({ action: "updateEmailSettings", emailSettings: { attachPdf: true }, mailbox: { ...box, password: "app-pass" } }, cookie);
  ok("a mailbox that signs in is saved and chosen", a.body.status === "ok" && a.body.mailbox.via === "mailbox" && a.body.mailbox.from === "me@mail.test" && a.body.mailbox.passwordSaved === true);
  const stored = auth.d1.q("SELECT value FROM global_settings WHERE key='emailMailbox'")[0].value;
  ok("the password is stored encrypted, and no answer ever carries it", !stored.includes("app-pass") && JSON.parse(stored).password.length > 20 &&
    !JSON.stringify(a.body).includes("app-pass") && !JSON.stringify((await auth.orders({ action: "getEmailSettings" }, cookie)).body).includes(JSON.parse(stored).password));
  a = await auth.orders({ action: "checkMailbox", mailbox: { ...box } }, cookie);
  ok("Check the mailbox signs in with the saved password when none is typed", a.body.ok === true && /Signed in/.test(a.body.message));
  a = await auth.orders({ action: "updateEmailSettings", emailSettings: { attachPdf: true }, mailbox: { ...box, port: 465, security: "tls" } }, cookie);
  ok("changing the server keeps the saved password (checked again before saving)", a.body.status === "ok" && a.body.mailbox.port === 465 &&
    JSON.parse(auth.d1.q("SELECT value FROM global_settings WHERE key='emailMailbox'")[0].value).password === JSON.parse(stored).password);
  a = await auth.orders({ action: "updateEmailSettings", emailSettings: { attachPdf: true }, mailbox: { via: "hosted" } }, cookie);
  ok("switching back to the hosted service keeps the mailbox for later", a.body.mailbox.via === "hosted" && a.body.mailbox.from === "me@mail.test" && a.body.mailbox.passwordSaved);
  ok("each change is in the audit log, without the password", auth.audit("settings.email_set").length >= 3 && !JSON.stringify(auth.audit("settings.email_set")).includes("app-pass") &&
    auth.audit("settings.email_set").some(x => /"to":"mailbox"/.test(x.detail || x.details || JSON.stringify(x))));
  auth.env.VENDOR_CREDENTIALS_KEY = "";
  a = await auth.orders({ action: "updateEmailSettings", mailbox: { ...box, password: "app-pass" } }, cookie);
  ok("without VENDOR_CREDENTIALS_KEY a mailbox can't be saved, and it says what to set", a.status === 400 && /VENDOR_CREDENTIALS_KEY/.test(a.body.message));
  const manager = await auth.addUser(cookie, "manager", "Max Manager", "max@myshop.com");
  a = await auth.orders({ action: "checkMailbox", mailbox: { ...box, password: "app-pass" } }, manager);
  const b = await auth.orders({ action: "updateEmailSettings", mailbox: { ...box, password: "app-pass" } }, manager);
  ok("a manager can't check or change the mailbox (admin only)", a.status === 403 && b.status === 403);
  const setup = read("functions/_lib/setupStatus.js");
  const setupStatus = new Function(strip(setup) + "\nreturn setupStatus;")();
  const emailItem = (env, mb) => setupStatus(env, { mailbox: mb }).find(i => i.key === "email");
  ok("setup status: a complete mailbox counts as email set up, with no hosted service", emailItem({ VENDOR_CREDENTIALS_KEY: KEY }, { via: "mailbox", host: "smtp.gmail.com", from: "me@mail.test", passwordSaved: true }).ready &&
    /your own mailbox \(me@mail\.test\)/.test(emailItem({ VENDOR_CREDENTIALS_KEY: KEY }, { via: "mailbox", host: "smtp.gmail.com", from: "me@mail.test", passwordSaved: true }).note));
  ok("…and a chosen but unreadable one doesn't", !emailItem({ RESEND_API_KEY: "re_x" }, { via: "mailbox", host: "smtp.gmail.com", from: "me@mail.test", passwordSaved: true }).ready);

  console.log("\n=== Global settings → Email: the page ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){
    if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs));
    const local = new URL(url).pathname.match(/^\/vendor\/fonts\/[a-z0-9.-]+$/);
    return local ? Promise.resolve(fs.readFileSync(__dirname + "/public" + local[0])) : super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.acme.test/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); win.confirm = () => true; } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 200));
  await w.loadAdminScript();
  await new Promise(res => setTimeout(res, 100));
  if (!w.document.getElementById("adminPanel")) { const d = w.document.createElement("div"); d.id = "adminPanel"; w.document.body.appendChild(d); }
  w.eval("adminCan_ = () => true;");
  const sending = { mailbox: { via: "hosted", host: "", port: 587, security: "starttls", user: "", from: "", passwordSaved: false }, hosted: { resend: true, cloudflare: false }, credentialsReady: true };
  w.document.getElementById("adminPanel").innerHTML = w.customerEmailsBoxHtml_({ attachPdf: true }, sending);
  w.eval("window")._gSettingsCtx = { desktop: false, emailSending: sending };
  w.wireGlobalFeatures_({ desktop: false, emailSending: sending });
  const $ = (id) => w.document.getElementById(id);
  ok("the page offers a hosted service (chosen, Resend named as set up) or your own mailbox", !!w.document.querySelector('input[name="gEmailVia"][value="hosted"]:checked') &&
    !!w.document.querySelector('input[name="gEmailVia"][value="mailbox"]') && /Resend is set up/.test($("gEmailVia").textContent) && $("gEmailMailboxPanel").hidden);
  const mbox = w.document.querySelector('input[name="gEmailVia"][value="mailbox"]');
  mbox.checked = true; mbox.dispatchEvent(new w.Event("change"));
  ok("choosing the mailbox opens the desktop's mailbox form (presets, address, password, server) with Check the mailbox", !$("gEmailMailboxPanel").hidden &&
    !!$("gEmailPreset") && !!$("gEmailFrom") && !!$("gEmailPass") && !!$("gEmailHost") && !!$("gEmailCheck"));
  ok("an empty mailbox can't be saved: the page says what's missing", /Your own mailbox needs the email address.*the password/.test(w.globalSettingsProblem_()));
  $("gEmailFrom").value = "me@mail.test"; $("gEmailPass").value = "app-pass";
  ok("filled in (Gmail's preset gives the server), it can", w.globalSettingsProblem_() === "" && $("gEmailHost").value === "smtp.gmail.com");
  const change = w.emailSendingChanges_();
  ok("…and the save sends the mailbox with the typed password", change.via === "mailbox" && change.from === "me@mail.test" && change.host === "smtp.gmail.com" && change.port === 587 && change.password === "app-pass");
  const noKey = { ...sending, credentialsReady: false };
  w.document.getElementById("adminPanel").innerHTML = w.customerEmailsBoxHtml_({ attachPdf: true }, noKey);
  w.eval("window")._gSettingsCtx = { desktop: false, emailSending: noKey };
  ok("without VENDOR_CREDENTIALS_KEY the panel says what to set", /VENDOR_CREDENTIALS_KEY/.test($("gEmailMailboxPanel").textContent));
  ok("the desktop version has no such choice (its mailbox is under Features → Email)", !/gEmailVia/.test(w.customerEmailsBoxHtml_({ attachPdf: true }, null)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
