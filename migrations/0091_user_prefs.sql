-- Each user's own settings (admin-users "me" / "savePrefs"): a JSON object, NULL = the defaults. Kept on the
-- account, not in the browser, so they follow the user to any browser or device. First use: which blocks Home
-- hides, {"home":{"hidden":["inout","pies"]}} (hidden, so a block added later shows by default).
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
ALTER TABLE users ADD COLUMN prefs TEXT;
