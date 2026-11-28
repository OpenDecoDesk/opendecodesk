# End-to-end tests (Playwright)

These tests drive the real app in a real browser (Playwright's Chromium) against a **fresh local install**
that the suite builds on every run. They complement the jsdom/unit tests (`npm test`): those check the code
piece by piece, these check that the pieces work together as a person uses them.

Nothing here talks to Cloudflare. Every `wrangler` command the suite runs is `--local`, and no Stripe,
Shippo or email keys are used.

## Setting up (once)

```bash
npm ci
npx playwright install chromium      # the browser Playwright drives (about 150 MB, kept in your user cache)
```

## Running

| Command | What it does |
|---|---|
| `npm run e2e` | The whole suite, from scratch, headless. |
| `npm run e2e:headed` | The same, with the browser windows visible. |
| `npm run e2e -- e2e/specs/orders.spec.mjs` | One spec (the setup project runs first, because every spec needs its users). |
| `npm run e2e -- -g "Local sale"` | Only the tests whose title matches. |
| `npm run e2e:spec -- e2e/specs/orders.spec.mjs` | Same as one spec, limited to the `chromium` project's file list. |
| `npm run e2e:report` | Opens the HTML report of the last run (traces and screenshots of failures). |

Useful variables:

- `E2E_WORKERS=1` runs one test file at a time (default 3).
- `E2E_REUSE=1` keeps the install: the first run builds it and leaves it running, later runs reuse it (no rebuild,
  no first-run setup again) and never stop it. Handy while writing a test. Stop it with a normal run, which
  stops and rebuilds it, or by killing the `wrangler dev` on port 8897.
- `E2E_KEEP=1` builds from scratch as usual but leaves the server running afterwards, to look around by hand
  at http://admin.localhost:8897 (the sign-in details are in `e2e/.auth/credentials.json`).
- `E2E_PORT` changes the port (default 8897).

A full run takes a little over two minutes on a recent Mac.

GitHub runs the whole suite on every push and pull request, as the `e2e` job of the test workflow
(`.github/workflows/test.yml`), one file at a time (with two workers the runner's one local server fell behind);
a desktop release waits for it too. When it fails, the run's Artifacts hold `e2e-report`: the HTML report, the
traces and screenshots of the failed tests, and the local server's log.

## What a run does

1. **Builds a new install** (`e2e/global-setup.mjs`, `e2e/lib/install.mjs`):
   - `e2e/wrangler.e2e.toml` is generated from `wrangler.toml` for this computer only: no Workers AI binding,
     no cron trigger, the three R2 buckets switched on (wrangler simulates them), `ROOT_DOMAIN = "localhost"`,
     so `admin.localhost` is the admin and `<shop>.localhost` each shop. Chromium sends `*.localhost` to
     127.0.0.1 by itself.
   - `e2e/.dev.vars` gets freshly generated test secrets: the setup passphrase (`PROXY_ADMIN_PASSPHRASE`),
     `SIGNING_SECRET`, `LINK_SIGNING_SECRET`, `CRON_SECRET`, `VENDOR_CREDENTIALS_KEY`. Never real keys.
   - The state directory (`$TMPDIR/opendecodesk-e2e-8897`, outside the iCloud-synced Documents folder) is
     wiped, the database is built the way `npm run setup` builds a new one (`schema.sql` plus the record that
     every migration is in it), and `wrangler d1 migrations apply --local` must then find nothing to apply.
   - `wrangler dev` starts on 127.0.0.1:8897. The suite waits until it answers, and stops it at the end
     (`e2e/global-teardown.mjs`).
2. **First run, through the pages** (`e2e/setup/first-run.setup.mjs`, the `setup` project): a wrong setup
   passphrase is refused; the real one opens *Finish setting up*; the owner chooses a name, email and password;
   the passphrase stops working; the owner signs in, adds a *Read only* role, and adds a Manager, a Back office
   user, a Production user, a Read only user and a second manager. Each of them replaces their temporary
   password at the first sign-in. The last one turns on two-step sign-in, and the test computes the
   authenticator's codes itself (`e2e/lib/totp.mjs`, RFC 6238 with node's crypto). Every user's signed-in
   browser is saved in `e2e/.auth/<role>.json`, and the generated passwords, TOTP key and recovery codes in
   `e2e/.auth/credentials.json`. Both are git-ignored and only belong to the install they were made on.
3. **The specs** (`e2e/specs/`, the `chromium` project) run as the owner by default. `as("staff")` etc. open
   another user's browser, `as(null)` a signed-out one. The data a test needs before it opens a page (a shop,
   products, an order) is made with the owner's signed-in session, through the same `/api/orders` requests the
   admin pages send (`e2e/lib/data.mjs`), never with the setup passphrase. The thing a test is about is done
   through the page.

### Things the fixtures do for every test (`e2e/fixtures.mjs`)

- **A client address per test.** The app limits sign-ins (10 a minute) and orders (20 a minute) per client
  address, which Cloudflare gives it in the `CF-Connecting-IP` header. Locally that header passes through, so
  each browser and API client says it comes from an address of its own (10.x.y.z). On the real site every
  person has their own address too. One test checks the limit itself.
- **Pictures.** Uploads go to the local R2 bucket, and their public address is
  `https://images.example.test/…` (`R2_PUBLIC_BASE`). Nothing answers there, so every browser context serves
  those addresses from the app's own `/api/image-proxy`, which reads the same bucket.
- **Links to shops.** The app writes shop links (invoice, preview, design approval) as
  `https://<shop>.localhost/…`, correct for a real install. The specs that follow them reopen them on the
  local port.

## The specs

| File | Tests | Covers |
|---|---|---|
| `setup/first-run.setup.mjs` | 8 | Setup passphrase, Finish setting up, the passphrase stops working, owner sign-in, a custom Read only role (made through the owner's session), users of every role with temporary passwords, the first sign-in password change, turning on two-step sign-in. |
| `specs/auth.spec.mjs` | 17 | + Add role under Roles and permissions; Wrong password and unknown email, sign out (the server forgets the session), two-step sign-in with a wrong and a right code, a recovery code works once, the sign-in rate limit, a session ended elsewhere (the next save asks to sign in and still goes through), reload after the session ended, Sign out everywhere, Change password, what Production, Back office, Manager and Read only see and what the server refuses them, no changing your own role, a role change, disabling and enabling a user, resetting a password. |
| `specs/shops.spec.mjs` | 9 | The New shop setup wizard (name, decoration, delivery, payment, deadline, look), turning a quick blank into a product with an uploaded graphic, Go live and Publish, the shop at its own address, Shop settings as a draft with Preview, the Live / Coming soon switch, Back office has no shop setup or Publish. |
| `specs/catalog.spec.mjs` | 10 | Product categories, the product form (validation, a flat-price product, an uploaded picture that loads back, a personalised product), drafts until Publish, personalisation in the cart, a price change stays a draft until Publish, hiding a product, Read only can't change products. |
| `specs/storefront.spec.mjs` | 14 | Categories and products with prices (no card without Stripe), the cart (add, quantity, + and −, remove, survives a reload), what Place order asks for, delivery fees vs pickup, checkout by Check, Venmo and Zelle with the confirmation, a closed shop, an unknown address, the customer's invoice page (delivery choice, what's owed), a broken invoice link, design approval (approve, request changes) and a broken approval link. |
| `specs/orders.spec.mjs` | 17 | A new order on the Orders page and on Home (opened from the keyboard), every fulfillment step to completed and Include completed, payments (partial Venmo, Zelle, cash refund), Mark as paid and a discount, Edit items, cancelling a line, Local sale (and a double click makes one order), bulk due date and stage, filters, what Production and Read only may do, the invoice PDF, Void with the password asked again, Ship without Shippo. |
| `specs/inventory.spec.mjs` | 9 | A blank with colour, sizes, price and stock; stock adjustments; Receive order at landed cost; write-off; Count stock; reorder point and Blanks to order; a transfer sheet received and counted; ready-to-ship stock count; Read only vs Back office buttons. |
| `specs/production.spec.mjs` | 10 | Threads and search, a thread without a brand, spool sizes and spools in stock, hoops and decoration locations, a machine's needles threaded with the searchable thread picker (keyboard), machine maintenance, abort reasons, a design with an uploaded generated `.dst` (needle stops read and threaded), a piece run on Run Order from start to done, Production can't change threads. |
| `specs/money.spec.mjs` | 8 | Home's order cards, accounts and money entries, expenses (and Home's expenses), Revenue, Sales tax and Inventory & COGS reports, closing and reopening a month (last year's) with a payment refused while closed, downloading the accountant's CSV export. |
| `specs/settings.spec.mjs` | 9 | Business profile (admin titles, shop page, Setup status), region and time zone, the Digital products and Shipping feature switches, sales tax rate, rush fee (in a shop's cart), pricing settings, the audit log listing those changes. |
| `specs/accessibility.spec.mjs` | 41 | Every page of the admin menu reached with the keyboard only (Tab, Enter) with its own title, the menu closed and no console errors or uncaught exceptions; a visible focus ring on the menu; the storefront cart operated by keyboard without console errors. |

152 tests in all. None is marked as an expected failure: every test checks behaviour that works.

Tests in a file run in order; files run side by side (3 workers) on the same install. Every test makes its own
data with unique names, so a file passes on its own as well as with the others, and tests never assert
install-wide totals that another file changes. A test that changes an install-wide setting (sales tax rate,
rush fee, pricing, a feature switch) sets it back in a `finally`, and picks values that can't disturb the others
(shops made by `makeShop` are tax-exempt; only the Digital products switch is toggled; the time zone stays UTC).
Nothing is retried on your computer: a flaky test is a bug to fix. On GitHub a failed test runs once more, as its
slower runner shows timing faults a fast machine hides; a test that passes the second time is listed as "flaky" in
the run's summary and report, to be fixed, and one that fails twice fails the run.

## Bugs the suite found, now fixed

The first version of the suite found these and pinned each with a test of the correct behaviour (marked as an
expected failure). They are fixed, and those tests now pass like any other:

1. **Users → Roles and permissions → Add role always answered "No such role."** The page sends its credential as
   `key` with every request, and `saveRole` read `key` as the role to change. The role to change is now `roleKey`.
   (`specs/auth.spec.mjs`)
2. **Shop setup, Designs and Graphics broke when chosen from the menu while a shop existed:** `adminRoute`
   assigned to `const raw`. (`specs/accessibility.spec.mjs`)
3. **A new install without a Shippo key couldn't save Global settings,** because Shipping starts switched on.
   Only switching Shipping on now needs the key and the ship-from address. (`specs/settings.spec.mjs`)
4. **Paying in full from 💰 Payments left the order row "Unpaid"** until a reload. Money actions now return the
   order's paid state, and the row follows it. (`specs/orders.spec.mjs`)
5. **On a published shop, the Live switch only changed the draft.** It now changes the published copy too, so
   "Show coming soon" stops orders at once. (`specs/shops.spec.mjs`)
6. **A new shop answered 404 at its own address** for up to 5 minutes. Creating a shop now refreshes the catalog.
   (`specs/shops.spec.mjs`)
7. **The order confirmation promised an email** even on an install that can't send one. It now says so only when
   email is set up. (`specs/storefront.spec.mjs`)
8. **The shop bar's Publish button stayed "✓ Published"** for up to 15 seconds after a product was saved. It now
   follows the page's own publish state. (`specs/catalog.spec.mjs`)

Also seen, not marked: Edit items' "+ Add item" can miss a click straight after typing a quantity (the
quantity's `change` redraws the rows between mouse-down and mouse-up); Run Order and Machine files log console
errors when no send-agent is running (a CORS error for `127.0.0.1:8787/ping` and a 503 from
`/api/agent?op=status`), which the accessibility spec allows on those two pages only.

## Not covered, and why

- **Card payments, carrier rates and labels, email** need Stripe, Shippo or an email provider. The suite checks
  that card isn't offered, that Ship says carrier shipping isn't set up, and that the invoice window shows its
  link when it can't email. Card checkout, webhooks, labels and sent mail are not tested.
- **The install-wide Storefront, Production, Bookkeeping, Shipping and Design approval switches** are not
  toggled. Other files use those pages at the same time. Only Digital products is toggled, and Shipping's refusal
  is checked.
- **Saving Global settings with its Save button** (bug 3). The settings spec sends the request the button sends
  and checks what the pages then show.
- **Require two-step sign-in for everyone** would change every later sign-in of the shared users.
- **Configurable products** (customer picks from options) and **pick-list personalisation** need graphics,
  tier prices and a stitch file per word. Only typed-in personalisation is tested.
- **Embroidery machines and the send-agent** (machine scan, stitch counts, Send to machine) need hardware.
- **Vendor connections, PDF/CSV imports, AI invoice reading** need outside services or vendor files.
- **Reconcile, Account viewer, Shop rate, recurring expenses, receipt uploads, Copy from another shop, mockup
  dragging, run abort and the run-times report, order import, rush on an order, packing labels.** Left out to
  keep the suite to a couple of minutes. They are the next candidates.
- **The desktop edition** (`desktop/`) runs the same pages in another shell; not driven here.
- **axe-core** is not used: it would be a new dependency. The accessibility spec checks keyboard reach, focus
  and console errors instead.

## Writing a test

- `import { test, expect, openAdmin, … } from "../fixtures.mjs"`. Make data with `api(action, body)`,
  `makeShop(api, …)` and `placeOrder(page, shop, …)` from `../lib/data.mjs`, and do the thing under test
  through the page.
- Use unique names (`uniq("Sample Tee")`, `slug("shop")`). Other files run against the same install at the same
  time, and with `E2E_REUSE=1` earlier runs' data is still there.
- Prefer roles, labels, ids and `data-*` attributes. When only text works, say so in a comment.
- No fixed sleeps; `expect(...)` waits. `openAdmin(page, hash)` always loads the page afresh.
- Customer pages: use `as(null)`, not `browser.newPage()`, so the customer gets their own client address.
- Invented data only: Example Club, Sample Tee, Test Thread Co, `@example.test`.
- Never commit `e2e/.auth/`, `e2e/.results/`, `e2e/.report/`, `e2e/wrangler.e2e.toml` or `e2e/.dev.vars`;
  `.gitignore` already keeps them out.
