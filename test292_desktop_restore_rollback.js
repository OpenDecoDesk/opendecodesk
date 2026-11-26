const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const server = require("./desktop/server.js");

// The desktop program's File → Restore a backup… must leave the data exactly as it was when the
// backup can't be copied in whole.
//
// Before: restoreState moved the live data aside and then copied the backup into its place, with
// nothing to undo it. A backup that could only be read part-way (a USB stick pulled out, a
// cloud-synced folder with files not downloaded, a half-made backup) left half a database — or none,
// and the program then made a new empty one and opened on it.
// Now: the backup is copied into a folder beside the data (state.restoring) and checked for its
// database first; only then is the data moved aside and the copy renamed into place. Any failure
// removes the copy and leaves, or puts back, the data that was there.
//
// Real folders in a temporary directory; the failures are a copy function that stops part-way, a
// rename that fails, and (for the real fs.cpSync) a file that can't be read.
const ok = (d, c) => { console.log(d + ":", !!c); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odd-desktop-restore-"));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
// Every folder and file under dir, with each file's contents: two trees are the same when this is.
const tree = (dir) => {
  const out = [];
  const walk = (d, rel) => {
    for (const x of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const p = path.join(d, x.name), r = rel + "/" + x.name;
      if (x.isDirectory()) { out.push(r + "/"); walk(p, r); }
      else out.push(r + " " + crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out.join("\n");
};
const stateIn = (dir, what) => {
  write(path.join(dir, "d1/miniflare-D1DatabaseObject/abc.sqlite"), "the database: " + what);
  write(path.join(dir, "d1/miniflare-D1DatabaseObject/abc.sqlite-wal"), "its journal: " + what);
  write(path.join(dir, "files/IMAGES/p/one.png"), "picture: " + what);
  write(path.join(dir, "files/RECEIPTS/receipts/2026/r.pdf"), "receipt: " + what);
  write(path.join(dir, "do/mailbox"), "mailbox: " + what);
};
// A data folder in use ("today") and a backup of an earlier day ("last week").
let n = 0;
const setUp = () => {
  const data = path.join(tmp, "data" + (++n)), backup = path.join(tmp, "usb" + n, "OpenDecoDesk backup 2026-11-18_09-00-00");
  stateIn(path.join(data, "state"), "today"); stateIn(backup, "last week");
  write(path.join(data, "desktop.json"), "{}");
  return { data, backup, state: path.join(data, "state"), live: tree(path.join(data, "state")), saved: tree(backup) };
};
const asides = (data) => fs.existsSync(path.join(data, "backups")) ? fs.readdirSync(path.join(data, "backups")) : [];
const leftovers = (data) => fs.readdirSync(data).filter(x => x !== "state" && x !== "desktop.json" && x !== "backups");
// Exactly as it was: the same state, no half-made folder beside it, nothing moved aside.
const untouched = (s) => tree(s.state) === s.live && leftovers(s.data).length === 0 && asides(s.data).length === 0;
// fs.cpSync that stops after `n` files; what it copied so far stays behind, as it would.
const failingCopy = (count, skip = () => false, code = "EIO", message = "EIO: i/o error, read") => (from, to) => {
  let copied = 0;
  const walk = (a, b) => {
    fs.mkdirSync(b, { recursive: true });
    for (const x of fs.readdirSync(a, { withFileTypes: true }).sort((p, q) => p.name < q.name ? -1 : 1)) {
      if (x.isDirectory()) walk(path.join(a, x.name), path.join(b, x.name));
      else if (skip(x.name)) continue;
      else { if (copied >= count) throw Object.assign(new Error(message), { code }); fs.copyFileSync(path.join(a, x.name), path.join(b, x.name)); copied++; }
    }
  };
  walk(from, to);
};
const thrown = (fn) => { try { fn(); return null; } catch (e) { return e; } };

(async () => {
  console.log("=== A backup that copies in whole ===");
  {
    const s = setUp();
    const r = server.restoreState(s.data, s.backup);
    ok("the data is now the backup, file for file", tree(s.state) === s.saved && s.saved !== s.live);
    ok("what was there is kept, whole, in backups/before-restore-…", !!r.aside && /backups[\\/]before-restore-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(r.aside) && tree(r.aside) === s.live && asides(s.data).length === 1);
    ok("no half-made folder is left beside it, and the backup itself is unchanged", leftovers(s.data).length === 0 && tree(s.backup) === s.saved);
    const fresh = path.join(tmp, "fresh");
    fs.mkdirSync(fresh);
    const r2 = server.restoreState(fresh, s.backup);
    ok("a data folder with nothing in it yet takes the backup too (nothing to move aside)", r2.aside === null && tree(path.join(fresh, "state")) === s.saved);
  }

  console.log("\n=== A backup that can't be copied in whole ===");
  {
    const s = setUp();
    const e = thrown(() => server.restoreState(s.data, s.backup, { cp: failingCopy(2) }));
    ok("the copy stops after two files: restoreState throws", !!e);
    ok("…the data is byte for byte what it was, with no half-made folder and nothing moved aside", untouched(s));
    ok("…and the message says the restore did not happen, the data is unchanged, and why", /^The backup was not restored, and your data is unchanged: /.test(e.message) && /copying the backup did not finish/.test(e.message) && /the disk reported an error/.test(e.message));
    const e0 = thrown(() => server.restoreState(s.data, s.backup, { cp: failingCopy(0) }));
    ok("the same when not one file could be copied", !!e0 && untouched(s));
    // The copy "finishes" but the database didn't come across (files only in the cloud, say).
    const e2 = thrown(() => server.restoreState(s.data, s.backup, { cp: failingCopy(99, (name) => /\.sqlite/.test(name)) }));
    ok("a copy that arrives without its database is not put in place", !!e2 && /unchanged/.test(e2.message) && /has no database in it/.test(e2.message) && untouched(s));
    const r = server.restoreState(s.data, s.backup);
    ok("after those failures the same backup still restores once it can be read", tree(s.state) === s.saved && tree(r.aside) === s.live && leftovers(s.data).length === 0);
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0 && process.platform !== "win32") {
    // The real fs.cpSync, no stand-in: one file of the backup can't be read.
    const s = setUp();
    const locked = path.join(s.backup, "files/RECEIPTS/receipts/2026/r.pdf");
    fs.chmodSync(locked, 0o000);
    const e = thrown(() => server.restoreState(s.data, s.backup));
    fs.chmodSync(locked, 0o600);
    ok("a file of the backup that can't be read stops the real copy: the data is exactly as it was", !!e && /^The backup was not restored, and your data is unchanged: /.test(e.message) && untouched(s));
  } else ok("(the unreadable-file check needs an ordinary user on a Mac or Linux: skipped here)", true);

  console.log("\n=== Folders that aren't a whole backup ===");
  {
    const s = setUp();
    const noDb = path.join(tmp, "usb-empty", "OpenDecoDesk backup 2026-11-10_09-00-00");
    fs.mkdirSync(path.join(noDb, "d1/miniflare-D1DatabaseObject"), { recursive: true });
    write(path.join(noDb, "files/IMAGES/p/one.png"), "a picture");
    const e = thrown(() => server.restoreState(s.data, noDb));
    ok("a folder whose d1 folder has no database in it is refused before anything is touched", !!e && /isn't a whole OpenDecoDesk backup/.test(e.message) && untouched(s));
    write(path.join(noDb, "d1/miniflare-D1DatabaseObject/abc.sqlite"), "");
    ok("…an empty database file doesn't count either", !!thrown(() => server.restoreState(s.data, noDb)) && untouched(s));
    const partial = s.backup + ".partial";
    stateIn(partial, "half a copy");
    const e2 = thrown(() => server.restoreState(s.data, partial));
    ok("a backup that didn't finish (….partial) is never restored, even when it has a database", !!e2 && /didn't finish/.test(e2.message) && untouched(s) && !!thrown(() => server.restoreState(s.data, partial + path.sep)));
    const e3 = thrown(() => server.restoreState(s.data, path.join(tmp, "usb-empty")));
    ok("a folder that isn't a backup at all is refused as before", !!e3 && /isn't an OpenDecoDesk backup \(it has no d1 folder\)/.test(e3.message) && untouched(s));
  }

  console.log("\n=== A failure while swapping the folders ===");
  {
    const s = setUp();
    // The data moves aside, then the copy can't be renamed into place.
    let calls = 0;
    const e = thrown(() => server.restoreState(s.data, s.backup, { rename: (a, b) => { if (++calls === 2) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); fs.renameSync(a, b); } }));
    ok("the copy can't be moved into place: the data that was moved aside is put back, exactly as it was", !!e && calls === 2 && untouched(s) && /^The backup was not restored, and your data is unchanged: /.test(e.message));
    calls = 0;
    const e2 = thrown(() => server.restoreState(s.data, s.backup, { rename: () => { calls++; throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" }); } }));
    ok("the data can't be moved aside at all: nothing has changed, and the copy is removed", !!e2 && calls === 1 && untouched(s));
    // A restore cut off without a chance to tidy up left its folder behind.
    write(path.join(s.state + ".restoring", "files/IMAGES/p/stale.png"), "from the restore that was cut off");
    const r = server.restoreState(s.data, s.backup);
    ok("a folder left by a restore that was cut off is cleared first, not mixed into the next one", tree(s.state) === s.saved && tree(r.aside) === s.live && leftovers(s.data).length === 0);
  }

  console.log("\n=== File → Restore a backup… (desktop/main.js) ===");
  {
    const main = fs.readFileSync(__dirname + "/desktop/main.js", "utf8");
    const fnSrc = (name) => { const i = main.indexOf("async function " + name + "("), j = main.indexOf("\n}\n", i); if (i < 0 || j < 0) throw new Error("main.js has no " + name); return main.slice(i, j + 3); };
    // Who may restore, and Touch ID, are test358's (desktop/menu-gate.js): here always yes, and the note for the next
    // start's audit entry is counted.
    const build = new Function("d", "let { dialog, restoreState, log, stop, start, showPage, dataDir, win, server, noteRestored } = d; let busy = false;\n" +
      "const menuActionMayRun = async () => true, confirmWithTouchId = async () => true, crypt = () => ({}), systemPreferences = null;\n" +
      fnSrc("whileStopped") + fnSrc("restore") + "\nreturn { restore };");
    const s = setUp();
    const seen = { errors: [], starts: 0, stops: 0, notes: 0 };
    const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [s.backup] }), showMessageBox: async () => ({ response: 0 }), showErrorBox: (title, text) => seen.errors.push(text) };
    const program = (restoreState) => build({ dialog, restoreState, log: () => {}, stop: async () => { seen.stops++; }, start: async () => { seen.starts++; if (!fs.existsSync(path.join(s.state, "d1"))) throw new Error("started on no database"); },
      showPage: () => {}, dataDir: s.data, win: {}, server: { url: "http://localhost:1/" }, noteRestored: () => { seen.notes++; } });
    await program((d, from) => server.restoreState(d, from, { cp: failingCopy(3) })).restore();
    ok("a restore that fails shows the reason once, and the program starts again on the data it had", seen.errors.length === 1 && /^The backup was not restored, and your data is unchanged/.test(seen.errors[0]) && seen.stops === 1 && seen.starts === 1 && untouched(s) && seen.notes === 0);
    await program(server.restoreState).restore();
    ok("one that works starts again on the backup, with no error", seen.errors.length === 1 && seen.starts === 2 && tree(s.state) === s.saved && asides(s.data).length === 1 && seen.notes === 1);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(err => { console.error("test292 crashed:", err); console.log("test292 crashed: false"); process.exit(1); });
