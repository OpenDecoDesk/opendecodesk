// The desktop program: one window on the server in server.js, and a menu for what a cloud install
// does elsewhere (backups, restoring one, getting back in when locked out).
//
//   cd desktop && npm install && npm start
//
// The data folder is the system's per-user app data folder (on a Mac ~/Library/Application
// Support/OpenDecoDesk, on Windows %APPDATA%\OpenDecoDesk) — never next to the program, which
// can be read-only or moved. `--data-dir=<folder>` uses another one.

const { app, BrowserWindow, Menu, dialog, shell, ipcMain, safeStorage, session, net, systemPreferences } = require("electron");
const fs = require("fs");
// A downloaded program refuses Chromium's remote-debugging switches: with them, anything else on this computer could
// drive the window (and the signed-in session) over a local port. Electron has no fuse for these, so the check is
// here, before a window or the server exists. `--inspect` and friends are switched off by the build's fuses
// (package.json → build.electronFuses). Run from the source (npm start) both still work, for development.
const DEBUG_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address", "remote-allow-origins"];
if (app.isPackaged && DEBUG_SWITCHES.some((s) => app.commandLine.hasSwitch(s))) {
  console.error("OpenDecoDesk: remote-debugging switches aren't allowed in the installed program.");
  app.exit(1);
}
const path = require("path");
const { menuGateDecision, confirmWithTouchId } = require("./menu-gate.js");
const { startServer, copyState, restoreState, resetSignIn, noteRestored, setShippoKey, setSupplierConnections, setSmtp, setEmailOn, savedSmtpPassword, recordBackup, stamp, IMAGES_HOST, desktopCsp } = require("./server.js");
const { Mailer, cleanSmtpSettings, cleanPdf } = require("./mailer.js");
const { createLog } = require("./log.js");
const { displayVersion } = require("./version.js");
const { networkFolder, networkFolderMessage } = require("./network-folder.js");

const SOURCE_URL = "https://github.com/opendecodesk/opendecodesk";
// The release's date and build number (version.js), or "dev" when run from the source.
const VERSION = displayVersion(app.getVersion());
// The About window (OpenDecoDesk → About on a Mac) shows the same, "Version 2026.11.01.01", not
// package.json's 2026.11.101; the empty build number keeps a second number out of it.
app.setAboutPanelOptions({ applicationName: "OpenDecoDesk", applicationVersion: VERSION, version: "" });
const argData = process.argv.find(a => a.startsWith("--data-dir="));
const dataDir = argData ? path.resolve(argData.slice("--data-dir=".length)) : path.join(app.getPath("appData"), "OpenDecoDesk");
app.setPath("userData", path.join(dataDir, "electron"));   // the window's own storage, kept with the data

let server = null, win = null, busy = false;

// Everything the program and the Worker print goes to logs/opendecodesk.log too (desktop/log.js;
// Help → Open the log), and anything that would otherwise vanish — an error nobody caught — is kept.
const logFile = createLog(dataDir);
const log = (m) => { console.log(m); logFile.write(m, "program"); };
// (Catching it would otherwise hide Electron's own error box, so it's still shown.)
process.on("uncaughtException", (e) => {
  logFile.write("Uncaught: " + ((e && e.stack) || e), "program");
  try { dialog.showErrorBox("OpenDecoDesk", String((e && e.message) || e) + "\n\nThe log is in " + logFile.file); } catch (_) {}
});
process.on("unhandledRejection", (e) => logFile.write("Unhandled: " + ((e && e.stack) || e), "program"));
// Run from a shared or network folder (in Parallels, often the Mac's own Downloads), Windows won't
// start the program's helper processes and it would close with nothing on screen
// (network-folder.js): it says so instead, before anything else starts.
const misplaced = process.platform === "win32" && app.isPackaged ? networkFolder(path.dirname(process.execPath)) : null;
if (misplaced) {
  log("Can't run from a shared or network folder: " + misplaced);
  dialog.showErrorBox("OpenDecoDesk can't run from this folder", networkFolderMessage(misplaced, app.getPath("home")));
  app.exit(1);
}
// A helper process Windows wouldn't start for another reason (antivirus, say) still closes the
// program; the log at least says which.
app.on("child-process-gone", (e, d) => {
  if (d.reason === "launch-failed") log("Windows wouldn't start the program's " + d.type + " process (error " + d.exitCode + "); it is in " + path.dirname(process.execPath));
});
// Two copies of the program on one database would each think they own it: the second one just
// brings the first one's window forward (and writes nothing to the log).
const primary = !misplaced && app.requestSingleInstanceLock();
if (primary) log("OpenDecoDesk " + VERSION + " starting (Electron " + process.versions.electron + ", " + process.platform + " " + process.arch + "), data in " + dataDir);

if (!primary) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

// The secrets in desktop.json are encrypted with the operating system's keychain when it has one.
const crypt = () => safeStorage.isEncryptionAvailable() ? {
  protect: (s) => safeStorage.encryptString(s).toString("base64"),
  unprotect: (s) => safeStorage.decryptString(Buffer.from(s, "base64")),
} : {};

// A page made into a PDF (the invoice: email.js invoiceDocument) with Chromium's own printing. The
// page is drawn in a hidden window of its own, on a session of its own kept in memory, with
// JavaScript off and every request but the page itself refused: it can't run anything or reach
// anything, on this computer or off it. Returns the PDF as a Buffer.
let pdfSession = null;
async function renderPdf(html, pageSize) {
  if (!pdfSession) {
    pdfSession = session.fromPartition("odd-pdf");
    pdfSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith("data:text/html") }));
    pdfSession.setPermissionRequestHandler((wc, permission, cb) => cb(false));
  }
  const page = new BrowserWindow({ show: false, webPreferences: { partition: "odd-pdf", javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await page.loadURL("data:text/html;charset=utf-8;base64," + Buffer.from(String(html)).toString("base64"));
    return await page.webContents.printToPDF({ pageSize: pageSize === "A4" ? "A4" : "Letter", printBackground: true, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
  } finally { page.destroy(); }
}

async function start() {
  server = await startServer({ dataDir, port: 47830, ...crypt(), log, onOutput: (t) => logFile.write(t, "worker"), renderPdf });
  log("Server ready on " + server.url + (server.migrations.isNew ? " (new database)" : server.migrations.applied.length ? " (database updated: " + server.migrations.applied.join(", ") + ")" : ""));
  return server;
}
async function stop() {
  if (server) { const s = server; server = null; await s.stop(); }
}
const isOurs = (u) => { try { const x = new URL(u); return x.hostname === "localhost" && server && Number(x.port) === server.port; } catch (e) { return false; } };

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, title: "OpenDecoDesk " + VERSION,
    // Windows and Linux show this in the title bar and taskbar; a Mac uses the app's icon.icns.
    ...(process.platform === "darwin" ? {} : { icon: path.join(__dirname, "icons", "icon.png") }),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !app.isPackaged },
  });
  // Links to anywhere else open in the person's browser, not in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Printing labels and packing slips opens an empty window the page writes into; a receipt or
    // design file opens from this server.
    if (isOurs(url) || url === "" || url === "about:blank") return { action: "allow" };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isOurs(url)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
  // The title bar keeps the program's name and version: the page's own title (the business, the
  // admin page open) would otherwise replace it.
  win.on("page-title-updated", (e) => e.preventDefault());
  win.loadURL(server.url);
}

function setUpSession() {
  const ses = session.defaultSession;
  // Pictures are stored as https://images.desktop.invalid/<key> (server.js): answered here from
  // the IMAGES bucket. Any other https address is fetched as normal (a picture linked from a
  // supplier's site, when there is a connection).
  ses.protocol.handle("https", async (req) => {
    const u = new URL(req.url);
    if (u.hostname !== IMAGES_HOST) return net.fetch(req, { bypassCustomProtocolHandlers: true });
    let key = u.pathname.replace(/^\/+/, "");
    try { key = decodeURIComponent(key); } catch (e) {}
    const img = server && key && !key.includes("..") ? await server.image(key).catch(() => null) : null;
    if (!img) return new Response("Not found", { status: 404 });
    return new Response(img.body, { headers: { "Content-Type": img.contentType, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
  });
  // public/_headers is written for the web: here the page's fonts are bundled, there is no
  // Cloudflare analytics or bot check, and no HTTPS to insist on.
  ses.webRequest.onHeadersReceived((details, cb) => {
    if (!isOurs(details.url)) return cb({});
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) {
      const l = k.toLowerCase();
      if (l === "strict-transport-security") delete headers[k];
      else if (l === "content-security-policy") headers[k] = headers[k].map(desktopCsp);
    }
    cb({ responseHeaders: headers });
  });
  // The page asks for nothing on this computer (no camera, location, …).
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(permission === "clipboard-sanitized-write"));
}

// Opens `url` in the window, reloading it when the window is already there: loading the same
// address again (…/#settings from …/#settings) would only move within the page.
function showPage(url) {
  if (win.webContents.getURL() === url) win.webContents.reload();
  else win.loadURL(url);
}

// Stops the server, does `work` while nothing is using the database, starts it again and reloads
// (at `hash`, an admin page such as "settings", when given) — or not, with { reload: false }, when
// the page carries on itself (Global settings → Save).
async function whileStopped(work, hash, { reload = true } = {}) {
  if (busy) return false;
  busy = true;
  try {
    await stop();
    try { await work(); }
    finally { await start(); if (win && reload) showPage(server.url + (hash ? "#" + hash : "")); }
    return true;
  } catch (e) {
    log("Failed: " + ((e && e.stack) || e));
    dialog.showErrorBox("OpenDecoDesk", String((e && e.message) || e));
    return false;
  } finally { busy = false; }
}

// Tracking checks (carrier shipping with a Shippo key; suppliers' shipment notices with supplier
// connections on) and the morning roll-up email (with email set up): there is no cron on this
// computer, so the Worker's scheduled handler (src/worker.js) runs a minute after the program opens
// and every two hours while it stays open. With none of them turned on it isn't called.
const TRACKING_EVERY_MS = 2 * 60 * 60 * 1000;
function startTrackingChecks() {
  const run = async () => {
    if (!server || busy || !(server.hasShippoKey() || server.suppliersOn() || server.emailSettings())) return;
    try { await server.runScheduled(); }
    catch (e) { log("Tracking check failed: " + ((e && e.stack) || e)); }
  };
  setTimeout(run, 60 * 1000);
  setInterval(run, TRACKING_EVERY_MS);
}

async function backUp() {
  const r = await dialog.showOpenDialog(win, { title: "Back up to which folder?", buttonLabel: "Back up here", properties: ["openDirectory", "createDirectory"] });
  if (r.canceled || !r.filePaths[0]) return;
  const dest = path.join(r.filePaths[0], "OpenDecoDesk backup " + stamp());
  // "Backed up." only when the copy finished: copyState gives the folder back once every file is in
  // it, and throws (leaving nothing behind) when the copy stopped part-way. whileStopped shows the error.
  let made = null;
  const done = await whileStopped(async () => {
    try { made = copyState(dataDir, dest); }
    catch (e) { made = null; throw new Error("The backup was not made.\n\n" + String((e && e.message) || e) + "\n\nYour data is unchanged. Check the folder you chose and try again."); }
    if (made) recordBackup(dataDir, crypt());
  });
  if (!done || !made) return;
  log("Backed up to " + made);
  dialog.showMessageBox(win, { message: "Backed up.", detail: "Everything — orders, books, stock, pictures and files — is in\n" + made + "\n\nKeep a copy somewhere other than this computer." });
}

// Restore and Reset sign-in each hand the program to whoever uses them (menu-gate.js): only with nobody or an
// Admin signed in in the window. Says why when not. True to go on.
async function menuActionMayRun() {
  let answer;
  try { answer = await askWhoIsSignedIn(); }
  catch (err) { log("Couldn't check who is signed in: " + ((err && err.message) || err)); answer = { error: true }; }
  const d = menuGateDecision(answer);
  if (!d.ok) {
    log("Refused from the menu: " + d.message);
    await dialog.showMessageBox(win, { type: "warning", message: d.message, detail: d.detail });
  }
  return d.ok;
}

async function restore() {
  if (!(await menuActionMayRun())) return;
  const r = await dialog.showOpenDialog(win, { title: "Restore which backup?", buttonLabel: "Restore", properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return;
  const ok = await dialog.showMessageBox(win, { type: "warning", buttons: ["Restore", "Cancel"], defaultId: 1, cancelId: 1,
    message: "Replace everything with this backup?",
    detail: "What is here now is not deleted: it is moved to the backups folder inside the data folder first.\n\nYou sign in with the password that was in use when the backup was made." });
  if (ok.response !== 0) return;
  if (!(await confirmWithTouchId({ platform: process.platform, systemPreferences }, "restore a backup"))) return;
  await whileStopped(async () => {
    restoreState(dataDir, r.filePaths[0]);
    // Written in the restored database's audit log at the start just after this (server.js recordDesktopEvents).
    noteRestored(dataDir, crypt());
  });
}

async function resetSignInMenu() {
  if (!(await menuActionMayRun())) return;
  const ok = await dialog.showMessageBox(win, { type: "warning", buttons: ["Reset sign-in", "Cancel"], defaultId: 1, cancelId: 1,
    message: "Locked out?",
    detail: "This clears every password and two-step sign-in. You then set up your account again (name, email, password); other users get a new password from you under Settings → Users.\n\nNo orders, books or settings are changed. The reset is written in the audit log." });
  if (ok.response !== 0) return;
  if (!(await confirmWithTouchId({ platform: process.platform, systemPreferences }, "reset sign-in"))) return;
  await whileStopped(async () => {
    resetSignIn(dataDir, crypt());
    await session.defaultSession.clearStorageData({ storages: ["cookies", "localstorage"] });
  });
}

function buildMenu() {
  const mac = process.platform === "darwin";
  const template = [
    ...(mac ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      { label: "Back up…", click: backUp },
      { label: "Restore a backup…", click: restore },
      { type: "separator" },
      { label: "Open the data folder", click: () => shell.openPath(dataDir) },
      { type: "separator" },
      mac ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      // The developer tools only when run from the source: in the installed program they would let anyone
      // at the computer call the program's own functions from the page.
      ...(app.isPackaged ? [] : [{ type: "separator" }, { role: "toggleDevTools" }])] },
    { role: "windowMenu" },
    { label: "Settings", submenu: [
      // Global settings has the Email and Carrier shipping (Shippo) sections near the top in the desktop version.
      { label: "Global settings, email and shipping…", click: () => { if (win && server) win.loadURL(server.url + "#settings"); } },
    ] },
    { role: "help", submenu: [
      { label: "Locked out? Reset sign-in…", click: resetSignInMenu },
      { label: "Open the log", click: () => shell.openPath(logFile.file) },
      { type: "separator" },
      { label: "Source code and licence (AGPL-3.0)", click: () => shell.openExternal(SOURCE_URL) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Global settings → Features: what the program itself keeps for the page's Shipping, Email and
// Supplier connections panels — never a key or password, only whether one is saved.
ipcMain.handle("odd:has-shippo-key", async (e) => !!(isOurs(e.senderFrame && e.senderFrame.url) && server && server.hasShippoKey()));
ipcMain.handle("odd:suppliers-on", async (e) => !!(isOurs(e.senderFrame && e.senderFrame.url) && server && server.suppliersOn()));
ipcMain.handle("odd:email-settings", async (e) => (isOurs(e.senderFrame && e.senderFrame.url) && server ? server.emailSettings() : null));

// Whether whoever is signed in on the window may change Global settings (settings.global at edit, as
// the server asks of the page's own Save): asked of the server itself with the window's session
// cookie, so the program's settings follow the same roles as everything else.
const NOT_YOURS = { ok: false, message: "Your role can't change Global settings. Ask an admin." };
async function signedInMayEditSettings() {
  if (!server) return false;
  try {
    const answer = await askWhoIsSignedIn();
    if (!answer) return false;
    const level = answer.body && answer.body.permissions && answer.body.permissions["settings.global"];
    return answer.status === 200 && answer.body.status === "ok" && !answer.body.pending && (level === "edit" || level === "full");
  } catch (err) {
    log("Couldn't check who is signed in: " + ((err && err.message) || err));
    return false;
  }
}
// The server's answer to { action: "me" } for the window's session cookie ({ status, body }), or null when the
// window has none. Throws when the server can't be asked.
async function askWhoIsSignedIn() {
  if (!server) throw new Error("the server isn't running");
  // By domain, not URL: the session cookie is a Secure one, and the page's address is plain http on localhost.
  const cookies = await session.defaultSession.cookies.get({ domain: "localhost" });
  if (!cookies.length) return null;
  const origin = new URL(server.url).origin, body = JSON.stringify({ action: "me" });
  return await new Promise((resolve, reject) => {
    // To 127.0.0.1, where the server listens (server.js), under the page's own name and origin.
    const req = require("http").request({ host: "127.0.0.1", port: server.port, path: "/api/admin-users", method: "POST", headers: {
      Host: "localhost:" + server.port, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Origin: origin,
      Cookie: cookies.map(c => c.name + "=" + c.value).join("; ") } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { text += d; if (text.length > 1e6) req.destroy(new Error("too long")); });
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (err) { reject(err); } });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("timed out")));
    req.end(body);
  });
}

// A mailbox's settings, tried before Global settings saves anything: signs in to the server, sends
// nothing, saves nothing. An empty password tries the saved one, and only on the server and username
// it was saved for. { ok, message }.
ipcMain.handle("odd:check-email", async (e, settings, password) => {
  if (!isOurs(e.senderFrame && e.senderFrame.url)) return { ok: false, message: "Not allowed." };
  if (!(await signedInMayEditSettings())) return NOT_YOURS;
  let clean, pass;
  try {
    clean = cleanSmtpSettings(settings);
    pass = String(password || "") || savedSmtpPassword(dataDir, crypt(), clean);
  } catch (err) { return { ok: false, message: err.message }; }
  if (!pass) return { ok: false, message: "Enter the mailbox's password (or app password)." };
  const tried = await new Mailer(clean, pass).verify();
  if (!tried.ok) log("Email settings not saved: " + tried.message);
  return tried;
});

// Global settings → Save: the program's part of it, all at once, with one restart of the server (the
// page then saves the rest, to the restarted server, and reloads itself):
//   shippoKey   a new key, null to remove it, or left out
//   email       { on, settings, password } — on with the mailbox (an empty password keeps the saved
//               one), or { on: false } to stop sending and keep the mailbox — or left out
//   suppliers   true / false, or left out
// The page has checked the mailbox first (odd:check-email). { ok, message }.
ipcMain.handle("odd:apply-settings", async (e, s) => {
  if (!isOurs(e.senderFrame && e.senderFrame.url)) return { ok: false, message: "Not allowed." };
  if (!(await signedInMayEditSettings())) return NOT_YOURS;
  s = s && typeof s === "object" ? s : {};
  let key;
  if (s.shippoKey !== undefined) {
    key = s.shippoKey == null ? null : String(s.shippoKey).trim();
    if (key !== null && (!key || key.length > 200 || /\s/.test(key))) return { ok: false, message: "That doesn't look like a Shippo API token." };
  }
  let mail = null;
  if (s.email && typeof s.email === "object") {
    if (s.email.on) {
      try {
        mail = { on: true, settings: cleanSmtpSettings(s.email.settings), password: String(s.email.password || "") };
        if (!mail.password && !savedSmtpPassword(dataDir, crypt(), mail.settings)) return { ok: false, message: "Enter the mailbox's password (or app password)." };
      } catch (err) { return { ok: false, message: err.message }; }
    } else mail = { on: false };
  }
  const suppliers = typeof s.suppliers === "boolean" ? s.suppliers : undefined;
  const ok = await whileStopped(async () => {
    if (key !== undefined) setShippoKey(dataDir, key, crypt());
    if (mail && mail.on) setSmtp(dataDir, mail.settings, mail.password, crypt());
    if (mail) setEmailOn(dataDir, mail.on, crypt());
    if (suppliers !== undefined) setSupplierConnections(dataDir, suppliers, crypt());
  }, null, { reload: false });
  if (ok) log("Settings applied:" + [key !== undefined ? (key ? " Shippo key saved" : " Shippo key removed") : "", mail ? (mail.on ? " email on (" + mail.settings.host + ")" : " email off") : "",
    suppliers !== undefined ? " supplier connections " + (suppliers ? "on" : "off") : ""].join(""));
  return { ok, message: ok ? "" : "The program's settings couldn't be saved." };
});

// Orders → Save invoice PDF…: the invoice page the admin got from the server (orders.js
// getInvoiceDocument) made into a PDF, saved where the owner chooses. { ok, path } or { ok: false }.
ipcMain.handle("odd:save-invoice-pdf", async (e, doc) => {
  if (!isOurs(e.senderFrame && e.senderFrame.url)) return { ok: false, message: "Not allowed." };
  const d = cleanPdf(doc);
  if (!d) return { ok: false, message: "That isn't an invoice." };
  const r = await dialog.showSaveDialog(win, { title: "Save the invoice", buttonLabel: "Save", defaultPath: path.join(app.getPath("documents"), d.filename), filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, await renderPdf(d.html, d.pageSize));
    log("Saved " + d.filename);
    return { ok: true, path: r.filePath };
  } catch (err) {
    log("Couldn't save " + d.filename + ": " + ((err && err.message) || err));
    return { ok: false, message: "Couldn't save the PDF: " + ((err && err.message) || err) };
  }
});

// The backup reminder in the admin (admin.js adminDesktopBackupNudge_): when this data folder was first
// used and last backed up, and a button that opens File → Back up….
ipcMain.handle("odd:backup-status", async (e) => isOurs(e.senderFrame && e.senderFrame.url) && server ? server.backupStatus() : null);
ipcMain.handle("odd:back-up", async (e) => { if (isOurs(e.senderFrame && e.senderFrame.url)) await backUp(); });

ipcMain.handle("odd:first-run-key", async (e) => {
  // Only the program's own page may ask.
  if (!isOurs(e.senderFrame && e.senderFrame.url)) return null;
  return server ? server.firstRunKey() : null;
});

app.whenReady().then(async () => {
  if (misplaced) return;
  // Run from the source (npm start) on a Mac, the dock would show Electron's own icon.
  if (process.platform === "darwin" && !app.isPackaged) app.dock.setIcon(path.join(__dirname, "icons", "dock.png"));
  try { await start(); }
  catch (e) {
    let started = false;
    if (e && e.code === "SECRETS_UNREADABLE") {
      const r = await dialog.showMessageBox({ type: "warning", buttons: ["Reset sign-in and open", "Quit"], defaultId: 1, cancelId: 1,
        message: "OpenDecoDesk can't read its saved sign-in secret on this computer.",
        detail: "This happens when the data folder was copied from another computer, or the system's keychain isn't available.\n\nResetting sign-in keeps every order, book and setting; you set up your account (name, email, password) again.\n\nData folder: " + dataDir });
      if (r.response === 0) {
        try { resetSignIn(dataDir, crypt()); await start(); started = true; } catch (e2) { e = e2; }
      } else { app.exit(0); return; }
    }
    if (!started) {
      log("Couldn't start: " + ((e && e.stack) || e));
      dialog.showErrorBox("OpenDecoDesk couldn't start", String((e && e.message) || e) + "\n\nData folder: " + dataDir + "\nThe log is in " + logFile.file);
      app.exit(1);
      return;
    }
  }
  setUpSession();
  buildMenu();
  createWindow();
  startTrackingChecks();
});

app.on("window-all-closed", () => app.quit());
// The database is closed properly before the program ends.
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  quitting = true;
  stop().catch(() => {}).finally(() => app.quit());
});
