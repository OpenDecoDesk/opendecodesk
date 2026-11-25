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
- Deletes receipts and design, order and digital-product files uploaded more than 48 hours ago that nothing in
  the database names (their form was never saved) — up to 1,000 a day, looking through at most 8,000 files a run
  (and 20 seconds); the next day carries on where it stopped. A storage bucket that isn't set up is skipped.

**What the roll-up's tick does**, in order:

1. With the Shipping feature on: checks tracking on labels waiting for pickup and orders in transit,
   oldest first. An order whose label has been scanned is marked shipped and its customer is emailed;
   one that was delivered is marked delivered. It also checks suppliers' shipment notices and
   shipments of blanks you're waiting on. All of these share one limit of 40 outside requests a run
   (each lookup, each "your order has shipped" email and each supplier call counts, with room kept
   for the roll-up email itself); the rest wait for tomorrow.
2. Collects what is new since the last roll-up: orders (not test or voided ones), payments, refunds
   and disputes, customers' answers to design proofs, deliveries and pickups, failed admin sign-ins,
   and problems (an email that couldn't be sent, a Stripe webhook that failed, a roll-up that
   failed). With the Production feature on, it also lists machine maintenance that's due (never a
   reason to send on its own).
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
**private** R2 bucket as `<database>/daily/<UTC timestamp>.sql.gz`. On the 1st of each month (UTC)
it also uploads the same file as `<database>/monthly/<YYYY-MM>.sql.gz`. It refuses to upload an
export that has no tables or no data in it.

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
  before it is refused on its own. Past the site's budget or an account's, a sign-in from an address
  that hasn't signed in here in the last 30 days is asked for a Turnstile check first — when the
  Turnstile keys are set; without them it waits for the window to end. Someone already signed in is
  never locked out by them. Against a flood from many addresses, add a Cloudflare rate-limiting rule
  (WAF → Rate limiting rules; the free plan includes one) for the path `/api/admin-session`.
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
  the last day is left alone, and each file is checked again just before it's removed.

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

