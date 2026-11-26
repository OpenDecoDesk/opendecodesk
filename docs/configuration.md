# Configuration reference

OpenDecoDesk is configured in three places:

1. **`wrangler.toml`** — the things the Worker is attached to (database, buckets, hostnames) and
   the plain, non-secret settings (`[vars]`).
2. **Secrets** — keys and passwords, stored encrypted by Cloudflare. They are never written in a
   file in this repository.
3. **Global settings** — everything about the business itself, edited in the admin under
   **Settings → Global settings** and stored in the database.

`npm run setup` fills in 1 and 2 for you (see [setup.md](setup.md)). The admin's
**Settings → Global settings → Setup status** list shows which of these are set on a running install —
only whether each is set, never its value.

Everything below was read from the code (`env.NAME` in `functions/` and `src/`); the file named in
each row is where to look.

## Bindings (`wrangler.toml`)

| Binding | Kind | Required | What it is |
|---|---|---|---|
| `DB` | D1 database | yes | Everything: orders, shops, products, payments, inventory, settings, admin sessions, rate-limit counters. |
| `IMAGES` | R2 bucket, **public** | for picture uploads | Product and shop pictures, and pictures customers attach to a design approval. Needs `R2_PUBLIC_BASE` too. |
| `RECEIPTS` | R2 bucket, **private** | for receipts | Expense receipts and vendor invoices attached to stock received. Opened only through short-lived signed links. |
| `DESIGNS` | R2 bucket, **private** | for design files and digital products | Embroidery design files, files attached to order lines, and the files digital products sell. Opened only through short-lived signed links, or a paid order's own download link. |
| `AI` | Workers AI | no | Reads a vendor PDF with a model when Blanks → Import from PDF's own reader can't (see [AI reading of vendor PDFs](#ai-reading-of-vendor-pdfs)). Without it, the import uses its own reader only. |
| `AGENT_MAILBOX` | Durable Object | for the send-agent relay | Holds jobs for the send-agent while a phone or tablet waits for the answer (`functions/_lib/agentMailbox.js`). |
| `ASSETS` | static assets | yes | Serves `public/` (the storefront and admin pages). |
| `EMAIL` | `send_email` binding | no | An alternative way to reach Cloudflare Email Service. Not declared in the shipped `wrangler.toml`; the installer uses the API-token route instead. |

Also in `wrangler.toml`: the **hostnames** the Worker serves (`routes`), and the **cron trigger**
(hourly — see [operations.md](operations.md)).

### AI reading of vendor PDFs

Blanks → Import from PDF first reads the PDF itself, by its layout (tuned to S&S and SanMar invoices).
When that finds nothing, a line has no price or total, or the lines don't add up to the subtotal printed
on the PDF, the PDF's text is sent to a Workers AI model (named at the top of
`functions/_lib/invoiceAi.js`). The preview's **Read with AI** button does the same for any PDF. Only the text goes:
the PDF is read in the browser, and the model runs in your own Cloudflare account. Nothing is saved
until you check the lines and save Receive order. Each quantity, price and total the model returns is
checked against the PDF's text and the subtotal, and any that don't match are listed above the preview.

**Cost.** Workers AI is billed in neurons. Every account gets **10,000 neurons a day** at no charge, on
the free plan and the $5 plan alike. A 1–2 page invoice uses about **150–350 neurons**, and a 5-page one
about 900, on the default model (Llama 3.3 70B). On the $5 plan, use past 10,000 a day is
**$0.011 per 1,000 neurons**, so about $0.002–0.004 an invoice. On the free plan the AI reader stops for
the rest of the day (it resets at 00:00 UTC) and says so. PDFs the layout reader handles cost nothing.
Usage shows in the Cloudflare dashboard under **AI → Workers AI**.

To switch it off, remove the `[ai]` block from `wrangler.toml`.

## Plain settings (`[vars]` in `wrangler.toml`)

| Name | Required | Default | What it does |
|---|---|---|---|
| `ROOT_DOMAIN` | **yes** | `example.com` (a placeholder nobody can use) | Your domain, without `www.`. The admin is `<admin>.<root>`, each shop `<shop>.<root>`. Also used for links in emails and the default sender address. (`functions/_lib/hostConfig.js`) |
| `ADMIN_SUBDOMAIN` | no | `admin` | The admin panel's subdomain. Several may be given, comma-separated; the first is used in emailed links. |
| `TIMEZONE` | no | `UTC` | The install's time zone (an IANA name such as `Europe/London`). **Global settings → Region overrides it** when a zone is saved there. |
| `DIGEST_HOUR` | no | `6` | The local hour (0–23) the morning roll-up goes out. |
| `R2_PUBLIC_BASE` | for picture uploads | — | The public address of the `IMAGES` bucket (`https://…`). Without it, uploads are refused. |
| `EMAIL_FROM` | no | `orders@<root domain>` | The address emails are sent from. Must be on a domain verified with your email provider. |
| `EMAIL_BCC` | no | — | An inbox that gets a hidden copy of every email. Overrides the "Receipts inbox" in the business profile. |
| `OWNER_EMAIL` | no | `owner@<root domain>` | Where notices to the owner go, **if** no inbox is saved in the business profile. |
| `EMAIL_SUBJECT_TAG` | no | — | Text put in front of every email subject (for telling a test install's emails from the real one's). |
| `CF_ACCOUNT_ID` | with Cloudflare email or automatic hostnames | — | Your Cloudflare account id. |
| `CF_ZONE_ID` | with automatic hostnames | — | The zone id of your domain. |
| `CF_WORKER_NAME` | with automatic hostnames | — | This Worker's name (the `name` in `wrangler.toml`). |
| `TURNSTILE_SITE_KEY` | with Turnstile | — | The public half of a Turnstile widget; sent to the storefront, and to the admin's sign-in page when it asks for the check. |
| `ADMIN_AUTH_GLOBAL_LIMIT` | no | `100` | Failed sign-ins allowed across the whole site, from any address, per 15 minutes. Past it, a sign-in from an address that hasn't signed in here in the last 30 days must pass a Turnstile check first; on a site without the Turnstile keys it waits for the window to end (people already signed in aren't affected). `0` turns it off, with the per-account limit. Each address also has its own limit of 10 a minute, and may use no more than a fifth of this budget (20 by default) before it is refused on its own, so one address can't lock everyone else out. |
| `ADMIN_AUTH_ACCOUNT_LIMIT` | no | `10` | Failed sign-ins allowed for one account (one email), from any address, per 15 minutes; past it, that account's sign-ins are held up the same way (a Turnstile check, or a wait), from every address, including one that signed in here lately. Counted under a hash of the email. |
| `PASSWORD_ITERATIONS` | no | `10000` | PBKDF2 rounds for each stored password: more makes a stolen copy of the database slower to guess from, and each sign-in use more CPU. The default fits the Workers Free plan's CPU limit per request; on a paid plan it can go up to `100000` (the most allowed; a bigger number is taken as that, a smaller one as `10000`). A password stored with fewer rounds is remade with the new number the next time its user signs in. The desktop edition always uses `100000`. |
| `LEGACY_LABEL_PREFIX` | no | — | Only for a database made by an earlier copy of this code under another name. That copy signed passwords, admin sessions, shipping quotes, card-checkout tokens and draft previews with labels starting with its own name (e.g. `myshop-…`) instead of `odd-…`; set this to that name (letters and digits) and they keep working: nobody's password is voided and nobody is signed out. New ones are made with `odd-…`, and each password is re-marked the first time it's typed, so the setting can be removed once everyone has signed in. See [operations.md](operations.md), "A database from an earlier copy". |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | with Cloudflare Access | — | Turn on Cloudflare Access checking for the admin. See the warning below. |
| `EDITION` | no | — | Set to `desktop` **only by the desktop program** ([desktop.md](desktop.md)), never on a cloud install: `localhost` becomes the admin, the storefront, carrier shipping and design approval are locked off, and actions that need the internet are refused. There, `SHIPPO_API_KEY` is set by the program when the owner saves a Shippo key, and unlocks carrier shipping, `DESKTOP_SUPPLIERS` is `on` when the owner has turned on supplier connections (Vendor integrations), and `DESKTOP_EMAIL` is `on` when the owner has set up their mailbox (Global settings → Email): email then goes out through the `MAILER` binding, which the program answers by sending over SMTP (`desktop/mailer.js`), from `EMAIL_FROM`, the mailbox's address. `DESKTOP_VERSION` is the program's version (the release's date and build number, or `dev`), shown in the admin's header. (`functions/_lib/hostConfig.js`) |

Older names the code still reads, for installs that already use them — don't set these on a new
install: `CF_PAGES_PROJECT` (custom domains for a Cloudflare Pages deployment),
`SHIP_FROM_NAME` / `_STREET1` / `_CITY` / `_STATE` / `_ZIP` / `_PHONE` / `_EMAIL` (the ship-from
address, now a Global setting; a saved value wins).

## Secrets

Set by `npm run setup`, or one at a time with `npx wrangler secret put NAME`.

| Name | Required | What it does |
|---|---|---|
| `PROXY_ADMIN_PASSPHRASE` | **yes** | The way in to a new install, and the key every user's password (without `PASSWORD_PEPPER`) and two-step secret is stored under. Without it nobody can sign in. The installer generates one and shows it once; the first sign-in with it creates the first admin, and from then on it opens nothing. Replacing it (`npm run setup -- --new-passphrase`) gets a locked-out admin back in, and voids **every** user's password and two-step sign-in (an admin resets each user's: Users → Reset two-step). |
| `PASSWORD_PEPPER` | no | A random secret of its own that stored passwords are keyed with instead of the passphrase. The installer (and the desktop program) makes one when there is none and never replaces it: a new one would void every password made under the old. Added to an install that didn't have one, nobody's password stops working: each is remade under it the next time its user signs in. |
| `SIGNING_SECRET` | **yes** | Signs carrier shipping quotes (so a customer can't change the price) the short-lived links that open receipts and design files, and a shop's draft preview link. Any long random string. A site installed with the Deploy button has none at first: it makes one and keeps it in the database until **Your domain** (Global settings) saves it as this Worker secret, after which the database copy is deleted. Meanwhile Setup status warns about it (the Worker marks that case with `SIGNING_SECRET_FROM_DB` for itself; never set that by hand). |
| `CRON_SECRET` | no | Only for starting the morning roll-up by hand (`POST /api/daily-digest` with `{"key": …}`). The scheduled roll-up doesn't use it. |
| `STRIPE_SECRET_KEY` | for card payments | Your Stripe secret key. Without it "Card" isn't offered at checkout. |
| `STRIPE_WEBHOOK_SECRET` | with Stripe | The signing secret of the Stripe webhook endpoint. **Without it, card payments are taken but never recorded on their orders** — the webhook is refused. |
| `SHIPPO_API_KEY` | for carrier shipping | Your Shippo API token: rate quotes, labels, tracking checks. |
| `RESEND_API_KEY` | one email provider | Send email through Resend. When set, Resend is used for everything. |
| `CF_EMAIL_API_TOKEN` | one email provider | A Cloudflare API token with only the Email Sending permission (used with `CF_ACCOUNT_ID`). |
| `TURNSTILE_SECRET_KEY` | with Turnstile | The secret half of the Turnstile widget. **Set it together with `TURNSTILE_SITE_KEY`** — the secret alone refuses every order. |
| `CF_API_TOKEN` | with automatic hostnames | A Cloudflare API token that can attach hostnames to this Worker. It can change your account, so give it the narrowest permissions that work (see [shops-and-domains.md](shops-and-domains.md)). |
| `VENDOR_CREDENTIALS_KEY` | with vendor connections, or email through your own mailbox | Encrypts the logins saved under Settings → Vendor integrations (PromoStandards), and the mailbox password saved under Global settings → Email (docs/email.md). Any long random string, set once: changing it makes the saved logins and password unreadable (enter them again). Without it vendors can't be connected and your own mailbox can't be used; everything else works. |
| `AGENT_TOKEN` | with the send-agent relay | Shared with the send-agent program; at least 32 characters, or the relay stays off. |

Older names still read as fallbacks: `QUOTE_SIGNING_SECRET` and `LINK_SIGNING_SECRET` (used when
`SIGNING_SECRET` isn't set; `STRIPE_SECRET_KEY` is no longer used as a signing key — an install
that relied on it runs `npm run setup`, which makes a `SIGNING_SECRET`), and
`TOTP_SECRET` (a two-step sign-in secret set by hand on the oldest installs; it is read once,
when that install's owner becomes its first user, and each user's own secret is used after that).

### Two settings that lock things when half-set

- **Cloudflare Access** (`ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`): once both are set, every admin
  request must carry a valid Access sign-in or it is refused. Create the Access application for your
  admin hostname *first*, then set them. If you take card payments, Stripe's webhook address on
  that hostname needs its own exemption, and the send-agent relay can't sign in through Access
  either — see [accounts-and-keys.md](accounts-and-keys.md).
- **Turnstile**: `TURNSTILE_SECRET_KEY` turns the check on. Without `TURNSTILE_SITE_KEY` the
  storefront can't show the widget, so no order can pass. With both set, the admin's sign-in page
  also asks for the check once failed sign-ins have used up the site's budget (instead of refusing
  everyone until it runs out).

## Global settings (in the admin, stored in the database)

**Settings → Global settings.** All of these take effect without a deploy.

| Section | What it holds | Default | Notes |
|---|---|---|---|
| **Setup status** | Read-only: which of the things on this page are set. | — | |
| **Business profile** | Business name, one-line description, footer line, contact email shown to customers, phone, website, your own inbox, a receipts inbox, Venmo username, Zelle contact, "checks payable to", "mail checks to", a payment note (e.g. "Cash is fine at pickup"), the purchase order prefix for orders placed with suppliers. The order emails and their PDFs print the contact details and how to pay from here ([email.md](email.md)). | all blank ("Our shop" stands in for a missing name) | Live as soon as saved. |
| **Customer emails** | Whether the order emails carry a PDF invoice / receipt; **Preview emails…** and **View sample PDF receipt…** ([email.md](email.md)). | PDF attached | Live as soon as saved. |
| **Region** | Time zone; country (`US` or `OTHER`). | time zone from `TIMEZONE`, else UTC; country `US` | Country `OTHER` makes addresses free text and turns carrier shipping off. |
| **Features** | Eight switches: Storefront, Production, Bookkeeping, Shipping, Design approval, Digital products, Quotes, Discount codes. A ticked one opens a panel with its settings (Production: Machine Files; Shipping: the Shippo key and the ship-from address; Digital products: the download limits and email). | all on | See the README. Live within about half a minute. |
| **Payment methods** | Which of Card, Venmo, Zelle, Check are offered, site-wide. Each shop can turn more off, never back on. | all on (Card also needs Stripe) | **The one section that needs Publish** (Manage catalog → Publish) to reach the storefront. |
| **Payment on delivery** (under Payment methods) | Whether orders may be set to pay on delivery: their steps (blanks, digitizing, the run, packing, delivery) go ahead before they're paid, and they're completed once paid in full. **Only for local sales** limits it to the Local sale window on Orders. Each shop can turn it off or limit it to local sales, never turn it on when it's off here. Setting an order to it needs the role function **Set orders to pay on delivery** (Manager and Admin by default). | off | Live as soon as saved; no Publish needed. |
| **Sales tax** | Rate, home state (or region), and whether prices include the tax or it is added at checkout. | no rate: nothing is taxed | Applies to new orders. See [sales-tax.md](sales-tax.md). |
| **Ship-from address** | The sender's name, address, phone and email for shipping quotes and labels. | blank | In the Shipping feature's panel. Every field is required while Shipping is on: nothing saves until it's complete. |
| **Machine Files** | Whether delete buttons are shown on the Machine Files page. | off | In the Production feature's panel. |

Settings kept elsewhere in the admin: **package sizes** (Catalog → Package sizes), the **accounts
that postage is paid from and Stripe pays out to** (Finance → Accounts & money), and each shop's
own settings (Manage catalog → Edit) — delivery options, payment methods, order deadline,
tax exemption.

The database also keeps a few values the site maintains itself in the same table
(`global_settings`): the catalog version, the roll-up's progress and last run, counted failed
sign-ins, problems waiting for the next roll-up, and the two-step sign-in secret. They aren't
edited by hand.
