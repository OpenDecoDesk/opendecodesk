// One check, for new tests:
//   const { ok } = require("./testlib/check");
//   ok("a new install has it on", features.storefront === true);
// prints "a new install has it on: true" (or ": false", which run-tests.sh fails on), always as a boolean
// whatever the condition gives back, and a false one also makes the file exit non-zero — so a failed check
// fails the build even when its line is cut or reworded.
let passed = 0, failed = 0;
function ok(desc, cond) {
  const pass = !!cond;
  console.log(desc + ":", pass);
  if (pass) passed++;
  else { failed++; process.exitCode = 1; }
  return pass;
}
module.exports = { ok, counts: () => ({ passed, failed }) };
