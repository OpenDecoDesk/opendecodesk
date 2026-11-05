// The vendors the tests name, on the vendor list (migrations/0084). The site refuses a vendor name that isn't on the
// list, so a test that records one puts it there first, as the owner would with Manage vendors. SanMar and S&S ship
// free at $200 and Otto Cap at 25 pieces.
//   seedVendors(d1, ["Extra Vendor", …])  — safe on a database from before 0084 (does nothing).
const TEST_VENDORS = [
  // [name, forBlanks, freeShipOverCents, freeShipMinQty]
  ["SanMar", 1, 20000, null], ["S&S", 1, 20000, null], ["Otto Cap", 1, null, 25], ["Amazon", 1, null, null], ["Jiffy", 1, null, null],
  ["Supplier", 1, null, null], ["Alpha Broder", 1, null, null], ["Walmart", 0, null, null], ["Ninja Transfers", 0, null, null],
  ["Adobe", 0, null, null], ["Verizon", 0, null, null], ["Tajima", 0, null, null], ["Panera", 0, null, null], ["Venmo", 0, null, null], ["Stripe", 0, null, null],
];
function seedVendors(d1, extra = []) {
  const now = new Date().toISOString();
  try {
    for (const [name, forBlanks, over, qty] of TEST_VENDORS.concat(extra.map(n => [n, 1, null, null]))) {
      d1._raw.run("INSERT OR IGNORE INTO vendors (name, forBlanks, freeShipOverCents, freeShipMinQty, createdAt, updatedAt) VALUES (?,?,?,?,?,?)", [name, forBlanks, over, qty, now, now]);
    }
  } catch (e) { if (!/no such table/.test(String(e && e.message))) throw e; }
}
module.exports = { seedVendors, TEST_VENDORS };
