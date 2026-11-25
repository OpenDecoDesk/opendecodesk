// Helpers for the money, settings and accessibility specs.
import { openAdmin, leaveAdmin } from "../fixtures.mjs";

// openAdmin, always as a fresh page load. (Going to the address the page is already on only moves within the
// page — the browser doesn't load it again — so a screen opened twice in a row would show what it drew before.)
export async function freshAdmin(page, hash) {
  if (page.url() !== "about:blank") await leaveAdmin(page);
  await openAdmin(page, hash);
}
