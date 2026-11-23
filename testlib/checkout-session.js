// The real createCheckoutSession (functions/_lib/db.js, review #7) for tests that load checkout.js or orders.js
// with their db.js imports stripped and stub checkoutSessionState / expireCheckoutSession / saveCheckoutSession
// on `global`. The function is compiled at global scope, so those names resolve to the test's stubs, and fetch
// to the test's fetch. Call install() once the stubs are in place (it reads them when it runs, not before).
const fs = require("fs");
const path = require("path");

function source() {
  const db = fs.readFileSync(path.join(__dirname, "..", "functions", "_lib", "db.js"), "utf8");
  const start = db.indexOf("export const CHECKOUT_LINK_SECONDS");
  const fnStart = db.indexOf("export async function createCheckoutSession", start);
  const end = db.indexOf("\n}\n", fnStart);
  if (start < 0 || fnStart < 0 || end < 0) throw new Error("createCheckoutSession not found in db.js");
  return db.slice(start, end + 2).replace(/export (const|async function)/g, "$1");
}

function install() {
  const made = new Function(source() + "\nreturn { CHECKOUT_LINK_SECONDS, createCheckoutSession };")();
  global.CHECKOUT_LINK_SECONDS = made.CHECKOUT_LINK_SECONDS;
  global.createCheckoutSession = made.createCheckoutSession;
  return made;
}

module.exports = { install, source };
