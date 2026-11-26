const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { ok } = require("./testlib/check");

// run-tests.sh is what turns a failed check into a failed build: the tests print "description: true/false"
// rather than throw. It used to catch only a line ending ": false", so a check whose description had no colon,
// or one written `"desc:", a && b` (which prints a's own falsy value — 0, "", undefined, null — not false),
// passed silently. These run the runner's own pattern, and the runner itself, against each shape.
const runner = fs.readFileSync(path.join(__dirname, "run-tests.sh"), "utf8");
const pattern = (runner.match(/^FAIL_LINE='([^']+)'$/m) || [])[1];
ok("run-tests.sh keeps its failure pattern in one place (FAIL_LINE), and the loop uses it", !!pattern && /grep -E "\$FAIL_LINE"/.test(runner));

const matches = (line) => spawnSync("grep", ["-E", pattern || "^$"], { input: line + "\n", encoding: "utf8" }).status === 0;
const failing = {
  "a check that printed false": "a new install has it on: false",
  "…whose description ends without a colon": "“No embroidery design needed” products aren't flagged for a design… false",
  "…or is just the word": "false",
  "a `desc:`, a && b check whose a was 0": "the order has lines: 0",
  "…undefined": "the saved row comes back: undefined",
  "…null": "the saved row comes back: null",
  "…an empty string (nothing after the colon)": "the reply names the shop: ",
  "…or a bare trailing colon": "the reply names the shop:",
};
for (const [what, line] of Object.entries(failing)) ok("caught: " + what, matches(line));
const passing = ["a new install has it on: true", "the order has lines: 10", "total: $0.00", "3 passed, 0 failed", "=== Section ===",
  "  mismatch at 120 [ '2025-07-01', '2025-09-30' ]", "falsehoods are refused: true", "null values are kept: true", "Turnstile rejected: [ 'invalid-input-response' ]"];
const wrongly = passing.filter(matches);
if (wrongly.length) console.log("   wrongly caught:", wrongly.join(" | "));
ok("…and ordinary passing lines and log lines are not", wrongly.length === 0);

// The runner itself, on a folder of tiny tests: each failing shape fails the run, and only those.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odd-runner-"));
try {
  fs.copyFileSync(path.join(__dirname, "run-tests.sh"), path.join(dir, "run-tests.sh"));
  const tests = {
    "test1_pass.js": 'console.log("it works:", true); console.log("rows:", 3);',
    "test2_false.js": 'console.log("it works:", false);',
    "test3_nocolon.js": 'console.log("it works…", false);',
    "test4_zero.js": 'const rows = []; console.log("there are rows:", rows.length && rows[0].id === 1);',
    "test5_undef.js": 'const saved = undefined; console.log("it was saved:", saved && saved.id === 1);',
    "test6_empty.js": 'const name = ""; console.log("it has a name:", name && name.length > 2);',
    "test7_exit.js": 'console.log("it works:", true); process.exit(3);',
    "test9_stack.js": 'console.log("it works:", true); console.error("Error: Could not load link\\n    at process.processTicksAndRejections (node:internal) AggregateError [ECONNREFUSED]: ");',
    "test8_check.js": 'const { ok } = require(' + JSON.stringify(path.join(__dirname, "testlib/check.js")) + '); ok("it was saved", undefined && 1);',
  };
  for (const [f, src] of Object.entries(tests)) fs.writeFileSync(path.join(dir, f), src + "\n");
  const r = spawnSync("bash", ["run-tests.sh"], { cwd: dir, encoding: "utf8" });
  const result = (f) => (r.stdout.match(new RegExp("^(PASS|FAIL)[^\\n]*: " + f.replace(".", "\\.") + "$", "m")) || [])[1];
  ok("the runner passes a passing test", result("test1_pass.js") === "PASS");
  ok("…and one that logs an error's stack, whose line ends in a colon (a stack line is never a check)", result("test9_stack.js") === "PASS");
  ok("…and fails each failing shape: false, no colon, 0, undefined, an empty string, a non-zero exit",
    ["test2_false.js", "test3_nocolon.js", "test4_zero.js", "test5_undef.js", "test6_empty.js", "test7_exit.js"].every(f => result(f) === "FAIL"));
  ok("…and the run as a whole fails", r.status === 1);

  // testlib/check.js: what new tests use. It prints a boolean whatever the condition is, and a false one
  // also fails the file by its exit code.
  ok("check.js prints `desc: false` for a falsy non-boolean, and exits non-zero", result("test8_check.js") === "FAIL" &&
    /it was saved: false/.test(spawnSync(process.execPath, [path.join(dir, "test8_check.js")], { encoding: "utf8" }).stdout) &&
    spawnSync(process.execPath, [path.join(dir, "test8_check.js")]).status === 1);
  const good = spawnSync(process.execPath, ["-e", 'const { ok, counts } = require(' + JSON.stringify(path.join(__dirname, "testlib/check.js")) + '); ok("one", "yes"); ok("two", 1); console.log(JSON.stringify(counts()));'], { encoding: "utf8" });
  ok("…and `desc: true` for a truthy one, leaving the exit code alone", good.status === 0 && good.stdout === 'one: true\ntwo: true\n{"passed":2,"failed":0}\n');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// A test file that hangs: where a `timeout` command exists (Linux, so CI) the runner gives each file 5 minutes and
// fails one it had to stop with its own line; where there is none (macOS) it runs node as before. Both are run
// here with a PATH of just node, grep and tail, plus, for the first, a stand-in `timeout` that records how it
// was called and answers 124 (what timeout exits with when it stops a command) for the "hang" file at once.
{
  ok("run-tests.sh uses timeout only when the command exists, at 300 seconds a file", /command -v timeout >\/dev\/null/.test(runner) && /^TIME_LIMIT=300$/m.test(runner));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odd-runner-time-"));
  try {
    fs.copyFileSync(path.join(__dirname, "run-tests.sh"), path.join(dir, "run-tests.sh"));
    const which = (cmd) => spawnSync("bash", ["-c", "command -v " + cmd], { encoding: "utf8" }).stdout.trim();
    const bin = (name, extra) => {
      const b = path.join(dir, name);
      fs.mkdirSync(b);
      fs.symlinkSync(process.execPath, path.join(b, "node"));
      for (const c of ["grep", "tail"]) fs.symlinkSync(which(c), path.join(b, c));
      if (extra) { fs.writeFileSync(path.join(b, "timeout"), extra); fs.chmodSync(path.join(b, "timeout"), 0o755); }
      return b;
    };
    const calls = path.join(dir, "calls.txt");
    const withTimeout = bin("with", "#!/bin/bash\necho \"$*\" >> " + JSON.stringify(calls) + "\ncase \"$3\" in *hang*) echo \"still going\"; exit 124;; esac\nshift\nexec \"$@\"\n");
    const without = bin("without");
    fs.writeFileSync(path.join(dir, "test1_pass.js"), 'console.log("it works:", true);\n');
    fs.writeFileSync(path.join(dir, "test2_hang.js"), 'console.log("it works:", true);\n');
    fs.writeFileSync(path.join(dir, "test3_exit124.js"), 'console.log("it works:", true); process.exit(124);\n');
    const run = (b) => spawnSync("/bin/bash", ["run-tests.sh"], { cwd: dir, encoding: "utf8", env: { PATH: b } });

    const a = run(withTimeout);
    const logged = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
    ok("with timeout: each file runs as `timeout 300 node <file>`", /^300 node test1_pass\.js$/m.test(logged) && /^300 node test2_hang\.js$/m.test(logged));
    ok("…a file it stopped fails with a line saying it timed out, and shows what it printed", /^FAIL \(timed out after 300s\): test2_hang\.js$/m.test(a.stdout) && /still going/.test(a.stdout));
    ok("…the others still pass, and the run as a whole fails", /^PASS: test1_pass\.js$/m.test(a.stdout) && a.status === 1);

    const b = run(without);
    ok("without timeout: files run with plain node (the \"hang\" file isn't stopped and passes)", /^PASS: test1_pass\.js$/m.test(b.stdout) && /^PASS: test2_hang\.js$/m.test(b.stdout));
    ok("…and a file that exits 124 by itself is an ordinary failed exit, not a timeout", /^FAIL \(exit 124\): test3_exit124\.js$/m.test(b.stdout) && !/timed out/.test(b.stdout) && b.status === 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The check that started this: its description had no colon.
ok("test74's design check has its colon", /products aren't flagged for a design:", !prod\.dtf/.test(fs.readFileSync(path.join(__dirname, "test74_catalog_issues.js"), "utf8")));
