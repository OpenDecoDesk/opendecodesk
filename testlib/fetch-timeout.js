// http.js's fetchWithTimeout as source text, for tests that paste a file importing it (email.js, deliveryCheck.js,
// stripeFees.js…) into a new Function with its imports stripped, without the rest of http.js:
//
//   const E = new Function(require("./testlib/fetch-timeout").source() + strip(read("functions/_lib/email.js")) + …)();
//
// It calls whatever `fetch` the pasted code sees, so the test's fetch mock still answers.
const fs = require("fs");
const path = require("path");

function source() {
  const http = fs.readFileSync(path.join(__dirname, "..", "functions", "_lib", "http.js"), "utf8");
  const start = http.indexOf("export function fetchWithTimeout(");
  const end = http.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error("fetchWithTimeout not found in http.js");
  return http.slice(start, end + 2).replace(/^export /, "") + "\n";
}

module.exports = { source };
