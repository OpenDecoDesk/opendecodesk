// The downloaded desktop program can't be opened up for debugging from outside.
// Found while testing a packaged build on a Mac: it accepted --inspect (a debugger on the main process, which
// holds the keys) and --remote-debugging-port (anything on the computer could drive the signed-in window).
// The build now flips Electron's fuses for the Node switches, and main.js refuses Chromium's remote-debugging
// switches, for which Electron has no fuse. Checked by hand on a packaged arm64 build: the app still starts,
// `npx @electron/fuses read` lists the fuses as disabled, --remote-debugging-port exits at once with no port
// opened, --inspect opens no debugger, ELECTRON_RUN_AS_NODE doesn't run it as Node and NODE_OPTIONS is ignored.
const fs = require("fs");
const ok = (label, v) => console.log(label + ":", !!v);
const pkg = JSON.parse(fs.readFileSync(__dirname + "/desktop/package.json", "utf8"));
const main = fs.readFileSync(__dirname + "/desktop/main.js", "utf8");
const fuses = (pkg.build && pkg.build.electronFuses) || {};

ok("the build sets Electron's fuses", pkg.build && pkg.build.electronFuses);
ok("…the binary can't be run as plain Node (ELECTRON_RUN_AS_NODE)", fuses.runAsNode === false);
ok("…NODE_OPTIONS and NODE_EXTRA_CA_CERTS are ignored", fuses.enableNodeOptionsEnvironmentVariable === false);
ok("…--inspect and SIGUSR1 open no debugger on the main process", fuses.enableNodeCliInspectArguments === false);
ok("…file:// pages get no extra privileges (the window loads the local server, never file://)", fuses.grantFileProtocolExtraPrivileges === false && !/loadFile\(/.test(main));
ok("…the unsigned Mac build is signed again ad hoc after the fuses change it (Apple silicon won't start it otherwise)", fuses.resetAdHocDarwinSignature === true);
ok("…the asar-only fuses stay off: the build doesn't use asar", pkg.build.asar === false && !fuses.onlyLoadAppFromAsar && !fuses.enableEmbeddedAsarIntegrityValidation);
ok("…cookie encryption stays off: it is one-way, and a data folder restored on another computer would lose its sign-in", !fuses.enableCookieEncryption);

const guardAt = main.indexOf("const DEBUG_SWITCHES");
ok("main.js refuses the remote-debugging switches in the installed program",
  guardAt > 0 && /if \(app\.isPackaged && DEBUG_SWITCHES\.some\(\(s\) => app\.commandLine\.hasSwitch\(s\)\)\) \{[\s\S]*?app\.exit\(1\);/.test(main)
  && ["remote-debugging-port", "remote-debugging-pipe"].every(s => main.slice(guardAt, guardAt + 300).includes('"' + s + '"')));
ok("…before the data folder, the log, the server or a window exist",
  guardAt < main.indexOf("app.setPath(\"userData\"") && guardAt < main.indexOf("createLog(") && guardAt < main.indexOf("startServer("));
ok("…and only when installed: run from the source (npm start) the switches still work for development", /app\.isPackaged && DEBUG_SWITCHES/.test(main));
