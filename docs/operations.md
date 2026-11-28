# Running it

## The morning roll-up

Only emails to customers go out immediately. Everything addressed to **you** is collected into one
email a day.

**How it runs.** The Worker has a cron trigger that wakes it **every hour** (`wrangler.toml`,
`crons = ["0 * * * *"]`). Cron runs on UTC, so each hour the Worker checks whether it is now the
roll-up's hour in **your** time zone — `DIGEST_HOUR` (default 6) in the zone set under Global
settings → Region (else the `TIMEZONE` variable, else UTC). Two ticks a day do something: the
roll-up's, and the daily housekeeping an hour before it; the other 22 do one small database read and
stop. This keeps the roll-up at the same local hour through daylight-saving changes.

**The housekeeping tick** (an hour before the roll-up) runs on its own, so its requests never come out
of the roll-up's allowance (Cloudflare limits how many outside requests one run can make: 50 on the
Free plan). A clean-up that fails is recorded and reported in the roll-up an hour later.

- Fills in Stripe fees that weren't available when a card payment was first recorded.
- Deletes vendor web-service logs older than 30 days.
- Deletes customers' design uploads (see [shops-and-domains.md](shops-and-domains.md#customers-own-designs))
  that are older than 48 hours and on no order — up to 200 a day, in one go; any more wait for the next day.
- Deletes receipts and design, order and digital-product files uploaded more than 30 days ago that nothing in
  the database names (their form was never saved) — up to 1,000 a day, looking through at most 8,000 files a run
  (and 20 seconds); the next day carries on where it stopped. A storage bucket that isn't set up is skipped.
  The 30 days are there for a restored database: see [Restoring](#restoring).

**What the roll-up's tick does**, in order:

1. With the Shipping feature on: checks tracking on labels waiting for pickup and orders in transit,
   oldest first. An order whose label has been scanned is marked shipped and its customer is emailed;
   one that was delivered is marked delivered. It also checks suppliers' shipment notices and
   shipments of blanks you're waiting on. All of these share one limit of 40 outside requests a run
   (each lookup, each "your order has shipped" email and each supplier call counts, with room kept
   for the roll-up email itself); the rest wait for tomorrow.
2. Collects what is new since the last roll-up: orders (not test or voided ones), payments, refunds
   and disputes, gift cards sold online, customers' answers to design proofs, deliveries and pickups, failed admin sign-ins,
   and problems (an email that couldn't be sent, a Stripe webhook that failed, a roll-up that
   failed). A customer's answer to a quote shows as **Quote** (not Invoice). With the Production feature on, it also lists machine maintenance that's due (never a
   reason to send on its own). An **Unpaid POs** section lists POs waiting to be accepted and Net 30
   orders that have become late, with totals, or a line saying it is watching when there are none
   (never a reason to send on its own either; see [Net 30 terms and POs](#net-30-terms-and-pos)). In the
   new-orders table a Net 30 order's Payment reads "Net 30 · PO needed" or "Net 30 · PO 1001".
3. Sends one email. If there is **nothing new**, the scheduled run sends a short "nothing new"
   email instead, so a quiet morning can't be mistaken for "it didn't run".

Progress is only saved after the email is sent, so a failed send is retried the next day. If the
run itself fails, that is recorded and reported in the next one.

**In the admin:** Settings → **Communications** shows what the next roll-up will contain, when the
last one ran and what it found, and has a **Check now** button for the tracking checks.

**By hand:** `POST https://admin.<your domain>/api/daily-digest` with the JSON body
`{"key": "<CRON_SECRET>"}` runs it immediately. A manual run sends nothing when there is nothing new.
The installer generates `CRON_SECRET` and never shows it, so to use this call first set it to a
value you know: `npx wrangler secret put CRON_SECRET`. With Cloudflare Access in front of the
admin hostname, send the call to one of your shop hostnames instead, since Access stops it at
the admin's (not tried with Access on).

**Needs email.** With no email provider set up, the roll-up has nowhere to go — see
[email.md](email.md).

## Backups

Your orders, customers and books live in one D1 database. Back it up somewhere you control.

### The backup script

`scripts/d1-backup.sh` exports the whole database as SQL, compresses it, and uploads it to a
**private** R2 bucket as `<database>/daily/<UTC timestamp>.sql.gz`. When the month (UTC) has no
`<database>/monthly/<YYYY-MM>.sql.gz` yet, it also uploads the same file under that name, so the
first run of the month that works makes the month's copy (a failed or missed run on the 1st doesn't
leave the month without one). If it can't tell whether the month's copy is there, it uploads it
again. It refuses to upload an export that has no tables or no data in it.

One-time setup: the bucket, and a rule that deletes each daily copy after 35 days (so a nightly
backup doesn't pile up forever). There is no rule for `monthly/`: one copy a month is kept
indefinitely, for the records that need years.

```bash
npx wrangler r2 bucket create opendecodesk-db-backups
npx wrangler r2 bucket lifecycle add opendecodesk-db-backups expire-daily-backups "opendecodesk-db/daily/" --expire-days 35
```

(With another bucket or database name, use those names; the rule's prefix is `<database>/daily/`.
`npx wrangler r2 bucket lifecycle list opendecodesk-db-backups` shows the rules.)

Keep that bucket **private**: the files contain your customers' names, emails and addresses.

**Backups from before this layout** sit directly under `<database>/` (`<database>/<UTC timestamp>.sql.gz`).
The rule doesn't touch them, because they aren't under `daily/`. Keep one from the start of each
month you want kept and delete the rest by hand in the dashboard (R2 → the bucket), or leave them;
nothing new is written there.

Run it by hand:

```bash
CLOUDFLARE_ACCOUNT_ID=<your account id> npm run db:backup:now
```

It uses your `wrangler login`. A different bucket name can be given with `BACKUP_BUCKET=…`, and a
different database name as the script's first argument.

### Nightly, from GitHub Actions

`.github/workflows/d1-backup.yml` runs the same script every night — **but only in a repository
where you have switched it on.** In a fresh fork or copy it does nothing, so it can't fail every
night (or run against the wrong account) just because the repository was copied.

To switch it on, in your own (private) repository's settings:

1. **Secrets** (Settings → Secrets and variables → Actions → Secrets):
   - `CLOUDFLARE_API_TOKEN` — a Cloudflare API token that can read D1 and write to R2, and nothing
     else.
   - `CLOUDFLARE_ACCOUNT_ID` — your account id.
2. **Variable** (same page → Variables): `D1_BACKUP_ENABLED` = `true`.

It can also be started by hand from the Actions tab (it still needs the variable and the secrets).
Check the first run's log, and check that a file really appeared in the bucket.

GitHub pauses scheduled workflows in a repository that has had no activity for a while; if you
rely on this, look at the bucket now and then.

### Restoring

Restore into a **new** database first, look at it, and only then switch over.

```bash
# 1. Get a backup and unpack it
npx wrangler r2 object get opendecodesk-db-backups/opendecodesk-db/daily/<file>.sql.gz --remote --file backup.sql.gz
# (or …/opendecodesk-db/monthly/<YYYY-MM>.sql.gz for an older one)
gunzip backup.sql.gz

# 2. Load it into a new database
npx wrangler d1 create opendecodesk-db-restore
npx wrangler d1 execute opendecodesk-db-restore --remote --file backup.sql
```

To switch the site to the restored database, put its id in `database_id` (and its name in
`database_name`) in `wrangler.toml` and run `npm run deploy`. Keep the old database until you
are sure.

For a mistake made recently, D1 also has a point-in-time restore of its own
(`npx wrangler d1 time-travel restore <database> --timestamp=<time>`), which rewinds the database in
place. How far back it reaches depends on your Cloudflare plan — see Cloudflare's D1 documentation.
It is not a substitute for backups you hold yourself.

**Files are not in the database.** Pictures, receipts and design files are in the R2 buckets. This
script does not copy them; protect those buckets separately if losing them would hurt.

**After a restore, re-enter what was lost within 30 days.** A restored database no longer names the
receipts and design, order and digital-product files that were saved after the restore point. The
files themselves are still in the buckets, and the daily housekeeping leaves each one alone until
30 days after it was uploaded. Re-enter those records within that time, uploading each file again
(`npx wrangler r2 object get <bucket>/<file> --remote --file <name>` fetches one from a bucket if you
no longer have it). After the 30 days, the housekeeping deletes any file the database still doesn't
name, for good.

## Migrations

The database's structure changes only through the files in `migrations/`, applied in order. Each
is applied once; `wrangler` keeps the list of applied ones in the database (table `d1_migrations`).

```bash
npm run db:pending    # which migrations has this database not had yet?
npm run db:migrate    # apply them
```

- A **new** database is not built by running the migrations (the earliest ones change tables that
  must already exist). It is built from `schema.sql`, with every migration recorded as already
  applied — `npm run setup` does this. See [setup.md](setup.md).
- `schema.sql` always equals "every migration applied"; a test fails if they drift apart.
- Apply migrations **before** deploying code that needs them. If code runs without them (a bare
  `wrangler deploy`, or a migration that failed partway), some pages can show $0 or empty lists. The
  app checks for this: Global settings → Setup status marks the **Database** line as not ready and
  names the updates it hasn't had, and the morning roll-up reports it until they are applied.
- According to `wrangler`'s own help, a migration that fails is rolled back and the ones before it
  stay applied. Back up first anyway.

### A database without a migration record

If a database has its tables but `d1_migrations` is empty or missing, `wrangler` would try to apply
every migration from the first and fail. `npm run setup` fixes this by itself for an **empty**
database (no orders). For a database **with orders** it stops, because it can't know which
migrations that database has really had.

If you are certain the database's structure matches a particular version of this repository, check
out that version, and record its migrations as applied:

```bash
node -e 'import("./scripts/setup.mjs").then(S => console.log(S.migrationRecordSql(require("fs").readdirSync("migrations"))))' > record.sql
npx wrangler d1 execute DB --remote --file record.sql
```

Then return to the current version and run `npm run db:migrate`. Take a backup first.

### A database from an earlier copy

A database made by an earlier copy of this code — an install from before OpenDecoDesk, or a private fork —
has had the same migrations under **other numbers** (`0056_users_and_roles.sql` where this repository has
`0053_users_and_roles.sql`), and `wrangler` decides what to run by file name, so `npm run db:migrate` would
try to run them again. `scripts/adopt-db.mjs` matches them by their description (the part after the number)
and records this repository's names for the ones already applied; the old rows stay, so the old code still
works against the same database. It only prints SQL — read it before running it:

```bash
npm run db:backup:now
npx wrangler d1 execute DB --remote --json --command "SELECT name FROM d1_migrations ORDER BY id" > applied.json
node scripts/adopt-db.mjs applied.json                 # what it matched, what's still to run, what it doesn't know
node scripts/adopt-db.mjs applied.json --sql > adopt.sql
npx wrangler d1 execute DB --remote --file adopt.sql
npm run db:pending                                     # only this repository's own additions should be listed
npm run db:migrate
```

`--undo-sql` writes the SQL that removes the names it recorded. Migrations the database has that this
repository doesn't (a data fix only that install needed) are listed and left alone — check each one.

That copy also signed passwords, sessions and links under its own name: set `LEGACY_LABEL_PREFIX`
([configuration.md](configuration.md)) before the first deploy, or every password stops working. Its
business details (name, payment instructions, inboxes) were part of its code; fill them in under
Global settings → Business profile before opening the shops. Pictures it kept under `public/images/`
aren't here: copy them to your pictures bucket and point the products at them.

## Upgrading to a newer version

1. **Back up** (above).
2. Get the new code: `git pull` (or merge the new release into your copy), then `npm ci`.
   Your `wrangler.toml` has your own database id, hostnames and settings in it. Keep those changes
   — commit them on a branch of your own, or set them aside and put them back — and don't publish
   that file. A fork of a public repository on GitHub is public too, so keep your own copy in a
   private repository or a branch that only exists on your computer.
3. Read the release notes for anything to do by hand.
4. `npm run deploy` — it applies new migrations, lists every shop's hostname in `wrangler.toml`,
   checks with Cloudflare that no hostname the Worker has would be dropped, and then deploys, in that
   order, stopping at the first failure (`npm run deploy -- --check` does the checks and lists the
   migrations still to run, changing nothing). Don't use a bare
   `npx wrangler deploy` on an installed site: it detaches any shop hostname that isn't listed in
   `wrangler.toml` ([shops-and-domains.md](shops-and-domains.md#by-hand)), and code deployed
   before its migration has run refuses sign-in until the migration is applied.

   **A restore point before migrations.** When the database has migrations to apply, `npm run deploy`
   first asks D1 Time Travel for a bookmark of the database as it is, and prints it with the command
   that puts the database back:

   ```bash
   npx wrangler d1 time-travel restore opendecodesk-db --bookmark=<bookmark>
   ```

   If the bookmark can't be had, it stops before changing anything. `npm run deploy -- --no-backup`
   applies the migrations without one (the nightly backup above is then what you go back to). In
   Cloudflare's build (an install made with the Deploy button, deploying on each push) a missing
   bookmark is only a warning, since nobody is there to add the flag: the migrations go ahead, and
   Time Travel can still restore to a time before the deploy. If the
   deploy itself fails after the migrations ran, the message names the migrations that were applied,
   gives that restore command, and says whether `wrangler.toml` was updated. Restoring also undoes
   anything written to the database after the bookmark, so use it only when the old version can't run
   on the new tables; usually it is enough to fix the problem and run `npm run deploy` again.
5. Open the admin, look at Settings → Global settings → Setup status, and check a shop's page loads.

**Coming from a version with one shared admin password:** nothing is lost. Everyone is signed
out once. Sign in with the password you had and any email (or none); with two-step sign-in on,
it asks for your code as before. You are then asked once for your name and email, and from then
on you sign in with that email. You are the first admin; add the others under Settings → Users.

`npm run setup` is also safe to run again at any time: it changes nothing you don't re-enter.

There are no numbered releases yet, and upgrading an install made from this repository has not
been done by anyone. Treat the first upgrade with care.

## Users and roles

People sign in with their own email and password. An admin manages them under
**Settings → Users**.

| Role | Shown as | Can use |
|---|---|---|
| `staff` | Back office | Orders, payments and refunds, shipping labels, production, inventory, catalog content, equipment lists, expenses, reports, design files |
| `manager` | Manager | All of that, plus creating and editing shops, custom domains, Publish, package sizes, the books (accounts and money, reconciling, expense categories, closing periods, the accountant's export) |
| `admin` | Admin | Everything, plus Users, the "Require two-step sign-in" switch, the audit log and Global settings |

What a role can't use isn't shown: no menu entry, link or button for it.

**Customers** is a permission of its own, "Customer records". Each role starts with the same level
there as it has for order details, so Back office can open, add and edit customers and archive
them, and Production can look at them. Changing a customer's tax exemption and merging two
customers need the full level, which Manager and Admin have. A role without the permission sees
no Customers button, no customer search on a local sale, and no link from an order to its
customer. A role you made yourself, or a built-in one whose permissions you have changed, starts
without it: set it under Settings → Users → Roles and permissions.

**Quotes** is a permission of its own too, "Quotes". Back office can open, make, edit, send and
convert quotes; Manager and Admin can also cancel one (the full level); Production can't open them.
Converting a quote makes an order, so it also needs the edit level of order details, and a price of
your own on a quote's product line needs the edit level of payments, discounts and refunds, as on a
local sale. A role without the permission sees no Quotes button and no quotes on a customer's page.
As with Customers, a role you made yourself, or a built-in one you have changed, starts without it.
The page also needs the **Quotes** feature (Global settings → Features), on unless you turned it off:
off, the page is hidden for everyone and a quote link a customer already has answers "Quotes aren't
available." Turning it back on brings every quote back as it was.

**Fundraising** is a permission of its own under Reports, "Fundraising report". Manager and Admin
have it in full and Back office can read the report; Production can't open it. Recording a payout to
the group is an expense, so it needs the edit level of Expenses too (Manager and Admin) and the
Bookkeeping feature; setting up a shop's fundraiser needs the edit level of the shop's settings. As
with Customers, a role you made yourself, or a built-in one you have changed, starts without it
([Fundraising](#fundraising-the-report-and-payouts) below).

**Discount codes** is a permission of its own, "Discount codes". Manager and Admin can make, change,
switch off and delete codes; Back office can look at them and the orders that used them; Production
can't open the page. As with Customers, a role you made yourself, or a built-in one you have changed,
starts without it ([Discount codes](#discount-codes) below). On the Roles screen it is listed under **Marketing**.

**Gift cards** is a permission of its own, "Gift cards": Admin and Manager in full (including adjusting and
voiding), Back office can look, issue and resend, Production can't open the page. As with Customers, a
role you made yourself, or a built-in one you have changed, starts without it ([Gift
cards](#gift-cards) below).

**Net 30 terms** — putting an order on Net 30 and accepting its PO — is a permission of its own in the
Orders area: Admin and Manager in full, Back office edit, Production none. The **Unpaid POs** report is
one of its own under Reports: Admin and Manager in full, Back office can read it, Production can't open
it ([Net 30 terms and POs](#net-30-terms-and-pos) below).

**Sales by…**, **Profit per job** and **QuickBooks export** are permissions of their own under Reports.
Sales by… and Profit per job: Admin and Manager, nobody else; Profit per job, and the Profit box on an
order, also need "Money, costs and margins (everywhere)". QuickBooks export: Admin and Manager in full, Back office can
download, Production can't open it. The **Gift card liability** report goes with the Gift cards
permission. As with Customers, a role you made yourself, or a built-in one you have changed, starts
without them ([Sales and profit reports](#sales-and-profit-reports), [QuickBooks
export](#quickbooks-export) below).

- **Adding someone:** name, email, role. You are shown a temporary password once; give it to
  them. They must choose their own the first time they sign in.
- **Someone leaves:** disable them. They are signed out at once and can't sign in. Users are
  never deleted, so the audit log keeps their name; enable them again if they come back.
- **Forgotten password, or a lost phone:** Reset password or Reset two-step in the list. Both
  sign that person out.
- **Changing a role** signs that person out; they sign in again as what they now are.
- **There is always an active admin.** The last one can't be demoted or disabled, and nobody
  changes their own role.
- **Require two-step sign-in** (the checkbox under the list): nobody is signed out. At their
  next sign-in, anyone without an authenticator app must set one up before anything else opens,
  and is given ten recovery codes. Turn your own on first.
- **A lost or shared computer:** Settings → **Sign out everywhere** ends every session you have, on
  every device, this one included. Turning your two-step sign-in on or off also signs your other
  devices out.
- **Failed sign-ins are limited:** 10 a minute from one address (an IPv6 address counts by its /64),
  10 every 15 minutes for one account, and 100 every 15 minutes across the whole site from anywhere
  (`ADMIN_AUTH_ACCOUNT_LIMIT`, `ADMIN_AUTH_GLOBAL_LIMIT`, see [configuration.md](configuration.md)).
  One address may use no more than a fifth of the site-wide budget (20 failures in 15 minutes)
  before it is refused on its own. Past the site's budget or an account's, a sign-in is asked for a
  Turnstile check first — when the Turnstile keys are set; without them it waits for the window to
  end. An address that signed in here in the last 30 days is let past the site's budget, so the
  people who work here keep signing in during a flood; it is never let past an account's own.
  Someone already signed in is never locked out by them. Against a flood from many addresses, add
  a Cloudflare rate-limiting rule (WAF → Rate limiting rules; the free plan includes one) for the
  path `/api/admin-session`.
- **Everything above is in the audit log** (Reports → Audit Log → Security & users).

### Locked out

If the only admin has lost their password, or their phone and their recovery codes, run this on
the computer the site was installed from:

```bash
npm run setup -- --new-passphrase
```

It prints a new passphrase. Sign in with it (any email, or none): you are the first admin again,
your two-step sign-in is cleared, and you choose a new password. **Every other user's password
stops working too** — the list under Settings → Users marks them "password needs a reset", and
you reset each one. That is the price of passwords that a stolen database backup can't be used
to guess.

### Resetting a demo or test site

There is no reset script in this repository. If you write one that wipes and reseeds the
business data of a demo site, leave these alone so the people testing it keep their sign-in:
the `users` table, `admin_sessions`, `audit_log`, and in `global_settings` the keys `require2fa`
and `adminSecretMark` (plus `adminPassword`, `totpSecret` and `totpLastCounter` on an install
that hasn't been signed in to since it gained users). `global_settings` also holds the shop's
own settings, so reset it key by key, not as a whole table.

## Keeping an eye on it

- **Settings → Communications** — problems since the last roll-up (emails that failed, webhooks that
  failed), and when the roll-up last ran.
- **Reports → Audit Log** — who changed what: prices, settings, voids, refunds, sign-in changes.
- **Settings → Global settings → Setup status** — anything not configured.
- **The Worker's logs in the Cloudflare dashboard** — errors the code logged (`wrangler.toml` turns
  on `[observability]`).

## When things happened (order dates)

Every step recorded on an order — paid, manufactured, shipped, delivered, completed, a cancelled line, a
payment or refund, a local sale, a stock count correction or a transfer write-off — asks when it happened,
with the date and time defaulting to now, so a step entered later still carries its real date. A date in
the future, or one out of order (shipped before it was made), is refused. An order's **Dates…** window
changes or clears any of its dates at once. A date in a closed period (Periods & Export) is refused, both
into and out of it, so a filed month never changes.

## Machine maintenance

Each run adds to its machine's stitch count and run time: the design's stitch count comes from its
machine file when Designs can read it (see the formats under Shops and domains → Embroidery files), or type it
on the design version, and a run stopped
part-way can say how many stitches it got through. On **Machines**, type a reading from the
machine's own counter to set it straight.

Production → **Machine maintenance** keeps a list of jobs per machine — oil the hook every 8 run hours,
change the needles every 2 million stitches — and a log of when each was done. Run Order warns when
a job on the machine is due, the morning roll-up and Communications list what's due, and the Run
Times report shows stitches per run. It's part of the Production feature.

## Cleaning up images

- **Blanks → More → Find duplicate photos** looks through each color's photos for copies of the same picture
  (the same address, the same file, or one that looks the same) and lets you remove the extras. A
  garment's front and back are never called duplicates, and a color always keeps at least one photo.
  **More → Repair photo thumbnails** remakes missing small copies.
- **Settings → Orphaned images** (admins) lists files in the image store that nothing points to any more —
  a photo replaced or removed, an upload whose form was never saved. **Scan the image store**, then
  **Download selected (.zip)** to keep a copy and **Remove selected from storage**. Anything uploaded in
  the last day is left alone, and each file is checked again just before it's removed. The scan works
  through the database in steps and shows how far it is. A mention in the audit log (or another record of
  the past) doesn't count as a use, so a photo you replaced is listed; a picture on an order still counts.

Admin screens keep your place after a change: the scroll position, open sections, ticked boxes and
search stay as they were, and what changed is briefly highlighted.

## The books: the Account viewer and receipts

**Finance → Account viewer** shows one account's register: pick the account and dates (the last 32 days
to start), then Search. Newest first, with the date, category, description, amount and the running
balance, so it ends on the balance Accounts & money shows. Every row has a receipt button: view it, or
attach or replace one with **＋ Receipt** / **Replace** (allowed in a closed month — it doesn't change
the books).

A stock purchase is **one row**, as it is on the card or bank statement, even though Receive order wrote
a line per blank and size (plus any R&D or personal part); open it to see the parts. Reconcile treats it
the same way: one item to match, and auto-match tries the whole receipt against a statement line.

Paid it from the wrong account? Accounts & money → Blanks & transfers bought → **Change account…** moves
the whole receipt — every stock line, its R&D / written-off expense and its personal-items draw — in one
step. It's refused when the receipt is matched to a statement line, falls in a reconciled or closed month,
or would move to Personal funds while a personal draw exists. These are managers' pages, and part of
Bookkeeping.

## Recurring expenses

A subscription, phone bill, insurance premium or rent that costs the same every period is set up once:
Finance → Expenses → Add expense → **Repeats** (weekly, every 2 weeks, monthly, every 3 months, every
6 months, yearly), with an optional **Ends** date. It's **recorded automatically** on each date it comes
due, as an ordinary expense with a 🔁 tag — at the start of the morning roll-up, whenever the Expenses
screen opens, and straight away for a first date in the past. Dates count from the first date, so a
monthly one on the 31st lands on the last day of shorter months and comes back to the 31st.

The **🔁 Recurring expenses** section on the Expenses screen lists them: **Edit…** changes only what's
still to come (the first date is locked once one has been recorded), **Stop** ends it today, **Delete**
removes it and keeps what it recorded. Each recorded expense can be edited, deleted or given a receipt
like any other; a deleted one isn't recorded again. Refused: a Depreciation category, a refund, a first
date more than a year ahead, and anything that would land in a closed month. A rule paid from an account
that was made inactive is skipped and reported as a problem in the roll-up until the account is active
again. The roll-up and Communications list what was recorded. Part of Bookkeeping: nothing is recorded
while it's switched off.

## Shop rate

Finance → **Shop rate** (admins) works out what an hour of production costs, from your expenses:

- **Running costs:** each expense category's total over the period (the last 12 months, or a calendar
  year), at its business-use share. Change any figure, untick a category to leave it out, or add a cost
  that isn't in the expenses (a share of the household electricity). Shop supplies start left out, since
  each product already carries a supplies cost.
- **Equipment** (the Depreciation categories) is spread over its life: 7 years for MACRS 7, otherwise 5,
  and you can change any item's life. An item counts in full every year until its life is used up, also
  when it was bought before the period.
- **Your pay and profit:** what you want to pay yourself a year, and a profit % on top. Both are optional.
- **Hours:** production hours a week × weeks a year. The machine time actually timed on Run order over the
  same period is shown beside them as a guide.

The result is the **overhead per hour**, your pay and profit per hour, and the **shop rate**. **Save shop
rate** keeps the figures and your changes, and price analysis then uses them (see Pricing in
[shops-and-domains.md](shops-and-domains.md#pricing-what-an-item-costs-and-leaves)). The page works the
numbers out again as you type; nothing is used until it's saved. Part of Bookkeeping.

## Fundraising: the report and payouts

A shop can raise money for its group: a percent of each item's price, or an amount per piece, inside
the prices (set up in the shop's settings, see
[shops-and-domains.md](shops-and-domains.md#fundraising)). Each order line keeps what it raised,
worked out when it was priced.

**Reports → Fundraising** shows, for a range of dates (with presets, as on the Revenue report) and one
shop or all of them:

- **Per shop:** the orders, pieces and sales, what they **raised**, what was **paid out** to the group,
  and what is still **owed** — with totals across the shops. A shop is listed when it has a
  fundraiser now, or raised or paid out something in the range.
- **Per order**, below it: each order with its date, customer, pieces, sales and what it raised.
  **Export CSV** downloads these rows.

What counts:

- **Only paid orders raise money.** An order still owing raises nothing until it is paid in full; test
  and voided orders never do.
- A **cancelled line** raises nothing, and a **refunded** one raises less in proportion to the share of
  the line refunded (never below nothing).
- Orders are dated as the Revenue report dates them — when they ship or are delivered, or when they were
  placed, as Global settings → Bookkeeping says.
- **Paid out** is the payouts dated in the range. **Owed** is everything raised up to the end of the
  range less everything paid out up to then — not only the range's — so it is what you owe the group as
  of that date.

**Record payout…** on a shop's row records money you gave the group: the amount (it starts at what is
owed), the date, the account it was paid from and a note. It is an expense in the built-in category
**Fundraiser payouts**, tied to the shop, so it shows wherever expenses do — Expenses, the Account
viewer, Reconcile and the accountant's export — and the report lists each shop's payouts. Like any
expense it can't be dated in a closed month, and it is in the audit log. Deleting it in Expenses takes
it off the report. Recording a payout needs the Bookkeeping feature and the edit level of Expenses; the
report itself works without Bookkeeping ([Users and roles](#users-and-roles)).

The built-in category (named "Fundraiser payouts (built in)" if you already had a category called
"Fundraiser payouts") can be renamed but not deleted. Nothing is paid to the group automatically: the report tells
you what is owed, and you pay it the way you always have.

## Sales and profit reports

Two reports under **Reports** look at the same orders in the same way:

- **Which orders.** Not test orders, not voided ones, and not an order that is only a gift card. An order
  is dated by its **sale date**, as the Revenue report dates it — when it shipped or was delivered (or
  completed), or when it was placed, as Global settings → Bookkeeping says; the page says which.
- **Business days.** The dates are your days, in the business time zone (Global settings → Region): "to
  Jan 31" runs to midnight at the end of Jan 31 where you are, not in UTC. Months are your months too.
- **Gift cards are never sales.** A gift card line is left out of both: selling a card is a liability
  (see [Gift card liability](#gift-card-liability)); the sale counts when the card pays for an order.
- Cancelled lines are left out.

### Sales by customer, product, shop and decoration

The **Sales by…** report (in the Reports menu) groups the goods sold in a range of dates (this month to date to start, with
quarter and year presets), for one shop or all, by **Customer**, **Product**, **Shop** or
**Decoration**. Each row: the orders, pieces, **gross** (the lines before any discount), **discount**
(the order's discount — codes and a discount typed by staff alike — shared across its lines by their
amount), **refunds** (line refunds), **net** (gross less discount less refunds) and its share of the
total net, largest first.

- **Customer:** the customer record; an order without one is grouped by its email, as "No customer
  record: <email>".
- **Product:** the product; a custom line is grouped by its own name.
- **Decoration:** the line's decoration type. A line decorated two ways (embroidered and printed) counts
  its pieces under each and splits its money evenly between them; a line with none is "No decoration".

Shipping, rush and sales tax aren't sales of goods: they are shown as totals under the table, not in the
rows. **Export CSV** downloads the rows.

### Profit per job

**Reports → Profit per job** shows, for each order in the range, what it brought in, what it cost and
what it left, lowest margin first to start (or highest profit, most revenue, newest). The strip at the top
totals them and says how many use estimates; a row opens to show its costs part by part, and **Export
CSV** has each part as a column. The order window shows the same figures in a **Profit** box under its
money table.

**Revenue** is the goods after discounts and refunds, plus the shipping charged (after any free-shipping
code or shipping refund) and the rush fee. Sales tax is never revenue, and a gift card line is left out.

**Costs:**

- **Blanks** — the blanks and finished stock used for the order's lines, at what they cost. A line that
  hasn't been made yet (and needs a blank — not a customer's own garment) is **estimated** from the
  blank's purchase price for the pieces still to make.
- **Transfers** — the transfers used; for a line not yet made, the product's transfer cost for the pieces
  still to make (an estimate).
- **Decoration** — each line's decoration cost from Global settings → Decoration types, **at today's
  settings** (embroidery has none here).
- **Supplies** — the product's supplies cost per piece, or the default from the pricing settings when the
  product has none.
- **Outside digitizing** — the digitizing jobs recorded for the order.
- **Card fees** — the processor's fees on the order's payments.
- **Postage** — the shipping labels bought for it.
- **Labor isn't counted yet.** Production time will be added in a later version.

**Margin** is profit as a percent of revenue (none when there is no revenue). An order using an estimate
is marked **est.** and its notes say which part.

**Who can.** Both reports are permissions of their own under Reports, "Sales by customer, product, shop and
decoration" and "Profit per job": Admin and Manager, nobody else to start. Profit also needs **Money, costs
and margins (everywhere)**: without it there is no Profit per job report and no Profit box on an
order, and the server never sends the figures ([Users and roles](#users-and-roles)).

## Gift card liability

**Reports → Gift card liability** is the gift cards' money month by month, for a range of dates (this
year to start), in your business time zone. For each month:

- **Opening** — what was on cards at the start of the month.
- **Sold** — cards bought (online, as an order).
- **Given** — cards staff issued, not paid for.
- **Spent** — what cards paid for orders.
- **Put back** — refunds and voided gift card payments that went back onto cards.
- **Adjusted** — Adjust… on a card, up or down.
- **Voided** — balances taken off by Void….
- **Closing** — opening plus the month's changes.

Every month in the range is listed, even an empty one, with totals below, and **On cards right now**
(every active card's balance today). The closing figure as of today is that same amount. **Export CSV**
downloads the months. It needs the Gift cards feature and the Gift cards permission.

## QuickBooks export

The **QuickBooks export** page turns a range of dates into files QuickBooks imports, in either form:

- **QuickBooks Online** — CSV files: the sales as sales receipts or invoices (QuickBooks Online's own
  import columns, one row per line, with **Shipping**, **Rush**, **Discount** and **Gift card** as lines of
  their own), and payments, expenses and deposits as bank files (Date, Description, Amount) — **one file
  per bank account**.
- **QuickBooks Desktop** — one IIF file with every part ticked in it.

Pick the dates (this month, last month, this quarter or last year to start), the form, and the parts. The
page shows what each part holds (how many, and the total) before **Download**. The form you pick last is
remembered.

**What each part holds** (dates are your business days):

- **Sales** — the same orders as the sales report, dated by their sale date, **with** gift-card-only
  orders: each line, shipping, rush, the discount, sales tax, and any gift card sold, which goes to the
  **gift card liability** account, never to sales. A Net 30 order is always an invoice, with its due
  date and PO.
- **Payments** — every payment and refund by the day it was received (refunds negative). A gift card
  payment moves money off the gift card liability account; it isn't money in a bank. Card (Stripe)
  fees go to the card fees account with the payment, since a Stripe payout is already net of them. A
  payment recorded straight into a bank account (a check) goes to that account, not to Undeposited
  Funds.
- **Expenses** — by expense date, from the account they were paid from to the expense account their
  category maps to. A vendor refund is the reverse. Shipping labels go in here too, to the postage
  account, from the account each label was paid from.
- **Deposits** — Stripe payouts and cashouts into your accounts: money moved from Undeposited Funds to
  the bank account. A Venmo or cash cash-out carries its fees to the card fees account.

**Account mapping**, on the same page, says which QuickBooks account each kind of money goes to. It starts
with QuickBooks' usual names — Sales, Shipping Income, Discounts Given, Sales Tax Payable, Gift Cards
Outstanding, Undeposited Funds, Merchant Fees, Postage and Delivery, Accounts Receivable (rush goes to
Sales) — and each of your accounts and expense categories under its own name. Type the names exactly as
they are in your QuickBooks chart of accounts. Also: **Sales go in as** sales receipts (paid at once) or
invoices, and **Customer name** — the customer, or the shop (one customer per shop in QuickBooks). A name
is 1 to 100 characters, without tabs or line breaks. Saved in the `quickbooks` setting.

**Importing.** **Make a backup of your company file first.**

- **QuickBooks Online:** the sales file through Settings ▸ Import data (Invoices); each bank file
  through Banking ▸ Upload, picking the matching bank account.
- **QuickBooks Desktop:** File ▸ Utilities ▸ Import ▸ IIF Files. A sale is a cash sale into Undeposited
  Funds, or an invoice into Accounts Receivable; an expense is a check, or a credit card charge for a
  credit card account; a deposit moves Undeposited Funds to the bank. **Every transaction in the file
  balances to the cent**: the page refuses to make a file where one doesn't, rather than hand QuickBooks
  something it would import wrong.

Check the mapping before the first import: a name that doesn't match an account in your QuickBooks
won't land where you expect. The importing steps have not been tried against a
real QuickBooks company file. Each download is in the audit log (`report.quickbooks_export`), and so is
a change to the mapping (`settings.quickbooks`).

**Who can.** "QuickBooks export" is a permission of its own under Reports: Admin and Manager in full
(they can change the mapping), Back office can download, Production can't open it. It needs the
Bookkeeping feature ([Users and roles](#users-and-roles)).

## Discount codes

Codes a customer types at checkout on a shop's page, made on the **Discount codes** tab of the **Marketing** page (in the menu
after Quotes). Each code is either:

- **For one person** — tied to one email address. It works once, and only on an order placed with that
  email (spaces and capitals don't matter). Anyone else typing it is told the code isn't valid; the
  address is never shown.
- **For anyone** — it works a set number of times in all (1 to 100,000), by whoever has it. Tick
  **Once per email address** to stop the same email using it twice.

Either kind takes a **percent off** (0.01% to 100%) — with an optional **max discount**, the most it
takes off one order (20% off, up to $25) — or an **amount off** ($0.01 to $10,000), or is a **Free
shipping only** code (no percent or amount: it just makes delivery free). Any percent or amount code
can also tick **Free shipping**, to take its discount off the goods and make delivery free. A code can
have a **minimum order** ($0.01 to $100,000, counted on the goods): below it, the customer is told "This code
needs an order of at least $X." A code works at **all shops or one**, and can have a **last day** (it works through the end of that day, in the
business's time zone — Global settings → Region), and a private note. Leave the code blank and one is
made for you; codes are letters, digits, `-` and `_`, 3 to 32 characters, and read the same in any case.

**What it takes off.** The discount is off the order's goods — the lines as priced, quantity breaks and
personalization included — never the rush fee. A percent is rounded to the cent; an
amount is never more than the goods. It is stored as the order's discount, like one you type on an
order (its note says "Code SAVE10", or "Codes SAVE10, TEAM5"), so the balance, card checkout, the reports and the Fundraising
report treat it the same. The Orders page shows "Code SAVE10" next to it. A free-shipping code takes the
delivery charge off as well; the order keeps what it took off delivery, and the balance, the tax on
delivery (if delivery is taxed) and the reports all use the lower delivery.

**One code or more.** **Global settings → Discount codes** has the rule, **Allow more than one code on an
order**, off to start. Off: one code per order ("Only one discount code can be used on an order.").
On: a customer can add up to five. **Percent codes add up** (10% and 15% is 25%, never more than 100%
of the goods — each code's own max discount still limits its share), then **amount codes** come off what
is left, and a free-shipping code makes delivery free once. The same code twice is refused ("That code
is already applied."). The rule is read fresh each time, so changing it needs no Publish; orders that
already have several codes keep them. A **gift card is not a code** — see [Gift cards](#gift-cards): it
pays, it doesn't discount, so a customer can use a code and a gift card together even when only one
code is allowed.

**At checkout.** The shop page shows a **Discount code** box only while the shop has a code that can be
used — switched on, not used up and not past its last day, for that shop or all shops. **Apply** checks
the code (with the email typed so far) and shows the discount in the totals; changing the cart checks it
again. With more than one code allowed, an **Add another code** link shows each code with a ×, the total
discount, and "Free shipping (CODE)". A second code that is refused shows the reason. The server checks
them once more when the order is placed and decides the discount; two orders racing for a code's last
use can't both get it. An order the codes cover in full has nothing to pay and skips the card step.

**Codes for a list of emails…** makes one single-use code per address for up to 500 pasted emails (one
per line or separated by commas), all with the same discount, shop, last day and note, and an optional
prefix. Duplicates and addresses that aren't emails are skipped and listed. **Copy as CSV** and
**Download CSV** give you `email,code` to send — the app doesn't email codes; you send them.

**Uses.** The list shows each code's uses ("3 of 50") and its status: active, switched off, expired or
used up. Opening a code lists the orders that used it. **Voiding or deleting an order gives its use
back**, so a customer whose order never went ahead can use the code again; the code's list still shows
that order, marked "given back".

**Changing a code.** Until it is used, anything can change. Once it has been used, only its last day,
its number of uses (never below the uses so far), its note and whether it is switched on — so the
orders that used it keep meaning what they did. **Switch it off** to stop it working; switch it on again
later. A code can be **deleted only while it has never been used**.

**Who can.** The **Discount codes** permission: Admin and Manager can make and change codes, Back office
can see them, Production has no access ([Users and roles](#users-and-roles)). Making, changing,
switching and deleting codes are in the audit log (for a list of emails, only how many were made). The
page also needs the **Discount codes** feature (Global settings → Features), on unless you turned it
off: off, the page is hidden, the checkout has no code box and an order sent with a code is refused.

**On a Local sale.** The Local sale window has a **Discount code** box (web and desktop): **Apply**
checks the code against the items, the shop and the customer (a code for one person must be the
picked customer's, or the email typed under Customer info) and shows the discount in the price line.
**Record sale** checks it again and books it exactly as at checkout. With more than one code allowed the
box takes several (**Add another code**, each with a ×). The same window has a **Gift card** box.

**On an order.** The order window's discount area has **Add code**, beside the typed discount, and lists the
codes on the order with a × to take one off. The code is checked against the order's goods, shop and
email like any other, and the order's discount, tax and balance are worked out again from all its codes.
A code can't go on an order that has a typed discount ("take the discount off first"), and a typed
discount can't go on an order with a code ("This order has a discount code; take the code off first.").
Not on an order that is void, completed or fully refunded ("This order can't take a code now."). It needs the
same permission as typing a discount, the Discount codes feature, and an open month; both are in the audit
log (`order.discount_code_applied`, `order.discount_code_removed`).

**On the customer's invoice page.** Before paying the balance, a customer can type a discount code (only
while the order has no typed discount and the rules allow it) and/or a gift card. The server applies them
only to that invoice's order, only while it has a balance and isn't paid, and answers the same refusals;
wrong tries are limited, and a wrong code never says whom it belongs to.

**On a quote.** The quote editor has a **Discount codes** box under the lines (one, or several when the rule
allows). It checks them against the quote's goods, shop and customer email, and the quote's totals, the
quote page and the quote email show each code's discount and free shipping. Sending the quote checks the
codes again, and a refused code stops the send with its reason. A code is claimed only when the quote
becomes an order.

## Gift cards

A gift card is a **payment, not a discount**: tax is worked out on the goods after any codes, then gift
cards pay part or all of what is owed. So a code and a gift card always work together, even when only one
code is allowed. Cards are on the **Gift cards** page (in the menu), and the **Gift cards** feature
(Global settings → Features) is on unless you turned it off: off, the page is hidden and a card can't be
bought, issued or spent.

**Making one.** **Issue gift card** takes an amount ($1 to $1,000,000), the recipient's name and email, a
message, a private note, and **Email it now**. The full code is shown once, with **Copy**. A code is 16
letters and digits without look-alikes, shown in four groups (`XXXX-XXXX-XXXX-XXXX`). Afterwards the page
shows it masked (`••••-••••-••••-1234`); **Show** reveals it and is audited (`giftcard.code_shown`).

**Selling them online.** **Global settings → Gift cards**: **Sell gift cards online** (off to start), the
amount buttons (to start $25, $50 and $100) and the lowest and highest custom amount (to start $5 and
$500). With it on and card payments on, every shop page has a **Gift cards** button: amount, recipient
name and email, the buyer's name and email, and a message (up to 300 characters). It is an ordinary card
order with one line, "Gift card for <recipient>". The card is made and emailed to the recipient once the
card payment is confirmed — a repeated confirmation makes no second card or email — and the buyer's receipt
says so. The gift card line is never taxed, raises nothing for a fundraiser and isn't made or packed.

**Spending one.** At checkout ("Have a gift card?": the number, **Check** shows the balance, **Apply**;
up to three cards), on a Local sale, in the order window's payment form (method **Gift card**) and on the
customer's invoice page. A card pays up to its balance or what is owed, whichever is less; the balance
carries over to the next order. When cards cover everything the order is paid and the card step is
skipped. At checkout a card that is refused doesn't fail the order — the rest is paid the usual way. A
wrong number just says "That gift card number isn't right." (never whether a card exists), and tries are
limited to 10 a minute for each address. The Gift card payment method has a tick in Global settings →
Payment methods, on to start.

**Refunds and voids.** Voiding a gift-card payment, or refunding it, puts the money **back on the card**; it
is never paid out in cash. The card's history lists every sale, use, refund and adjustment.

**Never expire, never cashed out.** A card has no last day and can't be turned into money. **Adjust…**
adds or takes off a balance (a note is required, and the balance can't go below nothing); **Void…** takes
the balance to nothing and the card stops working. Both need full access and are in the audit log.

**In the books.** A card is a **liability** until it is spent, not revenue: selling one is not a sale, and the
gift card line is left out of Revenue, Sales tax, Fundraising, cost and pricing reports and the Home
page's money. The sale is revenue when the card pays for an order. A gift card payment is not money in
a bank account, so it is never on the deposits list or in an account's balance. The page's top strip shows
what is **outstanding** (all active balances), and what was sold and spent this month; the
[Gift card liability](#gift-card-liability) report has it month by month.

**Who can.** The **Gift cards** permission: Admin and Manager have it in full, Back office can look and
issue or resend, Production has no access ([Users and roles](#users-and-roles)). Taking a card as payment
on an order needs the same permission as any payment; refunding to a card needs the refund permission.
Issuing, showing a code, adjusting, voiding and resending are in the audit log. The morning roll-up has a
**Gift cards sold** line for each card bought online ("Gift card $50 for Pat — order X").

## Net 30 terms and POs

Net 30 lets a customer — a school district, a club — have the order now and pay by invoice within a set
number of days, against their purchase order (PO). It is a payment method, not a feature switch: tick
**Net 30 (with a PO)** in Global settings → Payment methods (off to start). Each shop can turn it off in
its own payment methods.

**The terms.** Global settings → **Net 30 terms**: the default days (30 to start, 1 to 365) and **Terms
start** — when the invoice is sent (the default; an order whose invoice was never sent counts from its
order date), the order date, or when the order is completed (shipped or picked up; until then it isn't
due yet). Only the **first** invoice sent counts: sending it again doesn't move the date. A customer can
have days of their own (**Terms (days)** on their page, for Net 45; blank uses the default), and putting
one of their orders on Net 30 copies them to the order, which can also be given its own. The due date is
worked out whenever it is read, from today's setting; it is never stored.

**Who can use it.** Staff can put any order on Net 30: the order window's Terms area (a **Net 30** tick,
the days, the PO box and the due date), or the Local sale window's Payment choice, with a PO box and the
days. A customer can pick it at checkout only when their record has **Allow Net 30** ticked
([shops-and-domains.md](shops-and-domains.md#net-30-at-checkout)).

**A PO typed by staff or by the customer.** A PO you type counts at once. A PO the customer types — at
checkout or on their invoice page — shows as **PO to check** until someone presses **Accept PO** (in the
order window, or on the report below). Without one the order shows **PO needed**. Clearing the PO clears
its acceptance. A PO is up to 60 characters. A voided order's terms can't be changed.

**An accepted PO clears the work, not the money.** A Net 30 order with an accepted PO counts as paid for
the **work**: it goes ahead through blanks, the run, packing and delivery, its digital downloads are
released, it counts in the Fundraising report, and it can be completed while money is still owed — a
Local sale on Net 30 with a PO goes ahead at once. Until its PO is accepted it waits like any unpaid
order, and Home shows it under **New**. The money is unchanged: revenue and the books count only payments
that arrive, and the order stays on the Unpaid POs report until its balance is nothing. Record the payment
when it comes, as any other.

**On the Orders page** the payment tag says "Net 30 — PO needed", "PO to check" or "PO 1001 · due Dec 31".

**Invoices and emails.** The invoice email and its PDF say "Terms: Net 30 · PO 1001 · Due Dec 31, 2026".
Their how-to-pay part says "Payment is due within N days of the invoice (PO 1001)", or asks for the PO
number while there is none, and the order-received email for a Net 30 order says no payment is needed
now. The customer's invoice page shows the terms and, while there is no PO, a box to type it in
([shops-and-domains.md](shops-and-domains.md#net-30-at-checkout)).

**The Unpaid POs report** (Reports → Unpaid POs) lists every Net 30 order that still owes money — not
voided, not a test order — as of a date (today to start), for one shop or all and one customer or all.
What is owed is worked out as on the order, gift card lines included. A strip at the top groups the
orders — **No PO yet**, **PO to check**, **Not yet due** (with completion as the start, that includes
orders not yet completed), then **1–30**, **31–60**, **61–90** and **90+** days late — with each group's
count and what it owes; an order due today isn't late. Below are a table per customer and the orders
themselves: order, customer, PO, status, invoiced, due, days late and owed. A "PO to check" row has
**Accept PO** (for a role that can set terms). **Export CSV** downloads the rows. With Net 30 off and no
Net 30 orders, the page says so.

**On Home**, the **Unpaid POs** block (after the totals) shows how many orders are owed, what they owe,
what is late and how many POs are waiting to be checked, with a link to the report; the money figures
only for roles that see revenue. The **New** tile counts POs to check too.

**In the morning roll-up**, see [The morning roll-up](#the-morning-roll-up).

**Who can.** See [Users and roles](#users-and-roles). No money moves when terms are set or a PO is
accepted, so a closed month doesn't stop either. Both are in the audit log (`order.terms_set`, with what
changed, and `order.po_accepted`).

## Reorder

The order window and each past order on a customer's page have a **Reorder** button (for anyone who can
see the order and make a Local sale). It opens the Local sale window filled with the same customer and
the same lines — size, quantity, personalization, design and price for a custom line — leaving out
cancelled lines, gift cards and fees. **Prices are today's**: a note lists any that changed since the
original order, and you can edit it before **Record sale**. The new order remembers which it was a
reorder of.

## Email campaigns

Marketing emails to your customers, on the **Marketing** page's **Email campaigns** tab. The tab
shows once email is set up (Global settings → Email on the website; the mailbox in the desktop
program), for a role with the **Email campaigns** permission (Admin and Manager by default: read sees
campaigns, edit writes them and sends tests, full sends, schedules, cancels and deletes). The feature
switch is **Email campaigns** (Global settings → Features).

**Who gets it.** Any mix of: the **shops** they ordered from; when they **last ordered** (more than or
less than N days or months ago, or before a date); **how many orders** (at least, at most, exactly);
and addresses you **type** (tick **Only these addresses** to send to just those). Test and voided
orders don't count. The count updates as you change it; **See the list** shows who. Anyone who
unsubscribed is always left out, and one campaign goes to at most 5,000 people.

**The email.** Pick a **theme** (Black Friday, Cyber Monday, Christmas, Hanukkah, New Year,
Valentine's Day, Halloween, Thanksgiving, Back to school, Summer or Plain): it fills in a banner
picture, sample words, colours and a button. Then add, move, copy or remove **blocks** — banner,
heading, text (bold, italic, underline, links, colours), discount code, button, up to four products,
a picture, a divider, space — and see it as on a desktop or a phone. Fill-ins: {first name}, {name},
{code}, {shop}, {expires}. The **HTML** tab shows the email as HTML; change it there and it is
edited as HTML from then on. Undo and redo go back 50 steps. A draft saves itself as you go.

**The discount.** None; **one code for everyone** (an existing, usable code); or **a code for each
person** — single use, tied to their email, made when the campaign starts (with a percent and an
optional max, or an amount, an expiry, a shop and a prefix). The campaign's codes appear on the Codes
tab, and the campaign list shows how many were used. **Email this code** on a code starts a campaign
with it.

**Sending.** **Send me a test** first. Then **Send now**, or **Schedule** a time. Emails go a few at a
time: the website sends with its hourly run and while the campaign's page is open; the desktop program
sends every minute while it's open (a time that passes while it's closed sends when it next opens). A
campaign that is sending can be stopped; the emails not yet sent are skipped. A sent campaign can be
copied to start a new one.

**Saying yes, and unsubscribing.** The checkout and the Local sale window have a box, ticked to start
with, **Email me shop news and discounts**, with the note that the customer's information is never
sold or shared. Unticked, the address goes on the no-marketing list; ticked later at checkout takes
it off again (but never undoes an unsubscribe). Every campaign email says how to stop: a one-click
**Unsubscribe** link on the website; in the desktop program, "reply with UNSUBSCRIBE" — then press
**Stop marketing email** on the customer's page. The customer page shows whether they're subscribed,
and **Subscribe again** if they ask. Receipts, invoices and other order emails always go.

**Audit log.** Campaigns made, started, scheduled, canceled and deleted (with how many people, never
the addresses), and marketing choices changed from the admin.
