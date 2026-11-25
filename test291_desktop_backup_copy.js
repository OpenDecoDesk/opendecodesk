const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const server = require("./desktop/server.js");

// The desktop program's File → Back up… must never say "Backed up." over half a backup.
//
// Before: copyState copied straight into the backup's folder, so a copy that stopped part-way (a full
// USB stick, a network folder that went away) left a folder that looked like a backup; and backUp
// showed "Backed up." whenever that folder existed, straight after the error box.
// Now: the copy is made as "<backup>.partial" and renamed only when every file is there; a failed copy
// removes it and throws; and "Backed up." (with the log line and the reminder's date) needs both the
// copy's folder back and whileStopped's word that nothing went wrong.
//
// copyState runs here on real folders in a temporary directory. backUp and whileStopped are
// desktop/main.js's own source, run with stand-ins for Electron's dialogs (main.js itself needs Electron).
const ok = (d, c) => { console.log(d + ":", !!c); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odd-desktop-backup-"));
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
const dataFolder = (name) => {
  const dir = path.join(tmp, name);
  write(path.join(dir, "state/d1/miniflare-D1DatabaseObject/abc.sqlite"), "the database " + name);
  write(path.join(dir, "state/files/IMAGES/p/one.png"), "picture one");
  write(path.join(dir, "state/files/RECEIPTS/receipts/2026/r.pdf"), "a receipt");
  write(path.join(dir, "state/files/DESIGNS/designs/7/d.dst"), "a design");
  return dir;
};
// fs.cpSync that stops after `n` files, the way a full disk does: what it copied so far stays behind.
const failingCopy = (n, code = "ENOSPC", message = "ENOSPC: no space left on device, copyfile") => (from, to) => {
  let copied = 0;
  const walk = (a, b) => {
    fs.mkdirSync(b, { recursive: true });
    for (const x of fs.readdirSync(a, { withFileTypes: true })) {
      if (x.isDirectory()) walk(path.join(a, x.name), path.join(b, x.name));
      else { if (copied >= n) throw Object.assign(new Error(message), { code }); fs.copyFileSync(path.join(a, x.name), path.join(b, x.name)); copied++; }
    }
  };
  walk(from, to);
};
const thrown = (fn) => { try { fn(); return null; } catch (e) { return e; } };

(async () => {
  console.log("=== copyState: the copy gets its name only when it is whole ===");
  {
    const data = dataFolder("ok"), dest = path.join(tmp, "usb", "OpenDecoDesk backup 2026-11-25_10-00-00");
    const made = server.copyState(data, dest);
    ok("a copy that finishes is returned, and holds exactly what the data folder's state does", made === dest && tree(dest) === tree(path.join(data, "state")) && tree(dest).split("\n").length > 8);
    ok("…and nothing else is left beside it", fs.readdirSync(path.join(tmp, "usb")).join() === "OpenDecoDesk backup 2026-11-25_10-00-00");
    const again = thrown(() => server.copyState(data, dest));
    ok("a folder that is already there is never copied over", again && /already a folder/.test(again.message) && tree(dest) === tree(path.join(data, "state")));
    ok("with no data yet there is nothing to copy", server.copyState(path.join(tmp, "nothing-here"), path.join(tmp, "usb", "none")) === null && !fs.existsSync(path.join(tmp, "usb", "none")));
  }
  {
    const data = dataFolder("full"), folder = path.join(tmp, "full-usb"), dest = path.join(folder, "OpenDecoDesk backup 2026-11-25_10-00-01");
    const before = tree(path.join(data, "state"));
    const e = thrown(() => server.copyState(data, dest, { cp: failingCopy(2) }));
    ok("the disk fills up after two files: copyState throws", !!e && e.code === "COPY_FAILED");
    ok("…no folder with the backup's name exists, and the half-made copy is gone too", !fs.existsSync(dest) && !fs.existsSync(dest + ".partial") && fs.readdirSync(folder).length === 0);
    ok("…the message says the copy did not finish and why, in plain words", /did not finish: the disk is full/.test(e.message) && /The half-made copy was removed/.test(e.message) && e.message.includes(dest));
    ok("…and the data itself is untouched", tree(path.join(data, "state")) === before);
    const e2 = thrown(() => server.copyState(data, dest, { cp: failingCopy(1, "EWEIRD", "something odd happened") }));
    ok("an error it has no plain words for is passed on as it is", !!e2 && /did not finish: something odd happened\./.test(e2.message) && !fs.existsSync(dest + ".partial"));
    // A copy cut off without a chance to tidy up (the program was closed): its .partial folder is still there.
    write(path.join(dest + ".partial", "files/IMAGES/p/stale.png"), "from the copy that was cut off");
    const made = server.copyState(data, dest);
    ok("a .partial folder left by a copy that was cut off is replaced, not mixed in", made === dest && tree(dest) === before && !fs.existsSync(dest + ".partial"));
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0 && process.platform !== "win32") {
    // The real thing, no stand-in: a file the program can't read makes fs.cpSync fail part-way.
    const data = dataFolder("unreadable"), folder = path.join(tmp, "unreadable-usb"), dest = path.join(folder, "OpenDecoDesk backup 2026-11-25_10-00-02");
    const locked = path.join(data, "state/files/RECEIPTS/receipts/2026/r.pdf");
    fs.chmodSync(locked, 0o000);
    const e = thrown(() => server.copyState(data, dest));
    fs.chmodSync(locked, 0o600);
    ok("a file that can't be read stops the real copy the same way: an error, and no folder left", !!e && e.code === "COPY_FAILED" && /isn't allowed to read or write there/.test(e.message) &&
      !fs.existsSync(dest) && !fs.existsSync(dest + ".partial"));
  } else ok("(the unreadable-file check needs an ordinary user on a Mac or Linux: skipped here)", true);

  console.log("\n=== Copies made before an update ===");
  {
    const data = dataFolder("update");
    const mk = (name) => write(path.join(data, "backups", name, "d1/x.sqlite"), "x");
    const stamps = ["2026-01-01_00-00-00", "2026-02-01_00-00-00", "2026-03-01_00-00-00"];
    stamps.forEach(s => mk("before-update-" + s));
    mk("before-update-2026-04-01_00-00-00.partial");   // newer than all three, and not a copy
    mk("before-restore-2026-04-01_00-00-00"); mk("my own notes.partial");
    const removed = server.pruneUpdateCopies(data);
    const left = fs.readdirSync(path.join(data, "backups")).sort();
    ok("a .partial folder is not counted as one of the three copies to keep", removed.length === 0 && stamps.every(s => left.includes("before-update-" + s)));
    ok("…and is deleted, while nothing else is touched", !left.includes("before-update-2026-04-01_00-00-00.partial") && left.includes("before-restore-2026-04-01_00-00-00") && left.includes("my own notes.partial") &&
      tree(path.join(data, "state")).length > 0);
    const src = fs.readFileSync(__dirname + "/desktop/server.js", "utf8");
    ok("the copy before an update is made by copyState, so it is whole or not there", /copyState\(dataDir, path\.join\(dataDir, "backups", "before-update-" \+ stamp\(\)\)\)/.test(src));
    const dest = path.join(data, "backups", "before-update-2026-05-01_00-00-00");
    const e = thrown(() => server.copyState(data, dest, { cp: failingCopy(1) }));
    ok("…a failed one leaves nothing that could push a good copy out", !!e && fs.readdirSync(path.join(data, "backups")).filter(n => /2026-05-01/.test(n)).length === 0);
  }

  console.log("\n=== File → Back up… (desktop/main.js) ===");
  {
    const main = fs.readFileSync(__dirname + "/desktop/main.js", "utf8");
    const fnSrc = (name) => { const i = main.indexOf("async function " + name + "("), j = main.indexOf("\n}\n", i); if (i < 0 || j < 0) throw new Error("main.js has no " + name); return main.slice(i, j + 3); };
    // main.js's own two functions, with everything they reach for handed in.
    const build = new Function("d", "let { dialog, copyState, recordBackup, log, stop, start, showPage, path, stamp, dataDir, crypt, win, server, fs } = d; let busy = false;\n" +
      fnSrc("whileStopped") + fnSrc("backUp") + "\nreturn { backUp, setBusy: (b) => { busy = b; } };");
    const program = ({ data, folder, cp, cancel = false }) => {
      const seen = { errors: [], messages: [], logs: [], recorded: 0, stops: 0, starts: 0, reloads: 0 };
      const dialog = {
        showOpenDialog: async () => (cancel ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [folder] }),
        showErrorBox: (title, text) => seen.errors.push(text),
        showMessageBox: (w, o) => { seen.messages.push(o); return Promise.resolve({ response: 0 }); },
      };
      const p = build({ dialog, copyState: (d, dest) => server.copyState(d, dest, cp ? { cp } : {}), recordBackup: () => { seen.recorded++; }, log: (m) => seen.logs.push(m),
        stop: async () => { seen.stops++; }, start: async () => { seen.starts++; }, showPage: () => { seen.reloads++; }, path, stamp: () => "2026-11-25_12-00-00", dataDir: data, crypt: () => ({}),
        win: {}, server: { url: "http://localhost:1/" }, fs });
      return { ...p, seen };
    };
    const saidBackedUp = (seen) => seen.messages.some(m => /Backed up/.test(m.message)) || seen.logs.some(l => /Backed up to/.test(l));

    const data = dataFolder("menu"), folder = path.join(tmp, "menu-usb");
    fs.mkdirSync(folder, { recursive: true });
    const good = program({ data, folder });
    await good.backUp();
    const dest = path.join(folder, "OpenDecoDesk backup 2026-11-25_12-00-00");
    ok("a copy that finishes: \"Backed up.\" with the folder, a log line, and the reminder's date set", good.seen.messages.length === 1 && good.seen.messages[0].message === "Backed up." && good.seen.messages[0].detail.includes(dest) &&
      good.seen.logs.join() === "Backed up to " + dest && good.seen.recorded === 1 && good.seen.errors.length === 0 && tree(dest) === tree(path.join(data, "state")));
    ok("…with the server stopped for it and started again", good.seen.stops === 1 && good.seen.starts === 1);

    const folder2 = path.join(tmp, "menu-usb-full");
    fs.mkdirSync(folder2, { recursive: true });
    const bad = program({ data, folder: folder2, cp: failingCopy(2) });
    await bad.backUp();
    ok("a copy that stops part-way: no \"Backed up.\", no \"Backed up to\" in the log, and the reminder's date is not set", !saidBackedUp(bad.seen) && bad.seen.messages.length === 0 && bad.seen.recorded === 0);
    ok("…one error, saying the backup was not made, why, and that the data is unchanged", bad.seen.errors.length === 1 && /^The backup was not made\./.test(bad.seen.errors[0]) && /the disk is full/.test(bad.seen.errors[0]) &&
      /Your data is unchanged/.test(bad.seen.errors[0]));
    ok("…nothing is left in the chosen folder, and the server is started again", fs.readdirSync(folder2).length === 0 && bad.seen.starts === 1);

    const busy = program({ data, folder: path.join(tmp, "menu-usb-busy") });
    busy.setBusy(true);
    await busy.backUp();
    ok("while the program is busy with something else nothing is copied, and nothing claims a backup", !saidBackedUp(busy.seen) && busy.seen.recorded === 0 && !fs.existsSync(path.join(tmp, "menu-usb-busy")));
    const none = program({ data: path.join(tmp, "no-data-yet"), folder });
    await none.backUp();
    ok("with nothing to copy yet, nothing claims a backup either", !saidBackedUp(none.seen) && none.seen.recorded === 0);
    const cancelled = program({ data, folder, cancel: true });
    await cancelled.backUp();
    ok("choosing no folder does nothing", cancelled.seen.stops === 0 && cancelled.seen.messages.length === 0 && cancelled.seen.logs.length === 0);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(err => { console.error("test291 crashed:", err); console.log("test291 crashed: false"); process.exit(1); });
