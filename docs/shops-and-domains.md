# Shops and domains

## How addresses work

One install serves **one root domain**. Which page a visitor sees is decided by the address they
typed — the server reads the hostname of every request (`functions/_lib/hostConfig.js`).

| Address | What it is |
|---|---|
| `admin.myshop.com` | The admin panel. (`admin` is the default; `ADMIN_SUBDOMAIN` changes it.) |
| `league.myshop.com` | A shop — one per subdomain, each with its own products and settings. |
| `myshop.com`, `www.myshop.com` | The root domain: a generic page with your business name. No shop is shown here and no list of shops. |
| anything else | Refused. A mistyped subdomain is not quietly treated as the root. |

Three things follow from this:

- **A shop's customers can't discover your other shops.** The page they load contains no shop data
  at all; it asks the server "who am I?", and the server answers from the hostname with that one
  shop's name, products and prices. Nothing about any other shop is sent.
- **The admin only works on the admin address.** Admin requests are refused from a shop's address
  or the root domain, even with a valid sign-in.
- **Each hostname has to be attached to the Worker** before it loads. That is what the rest of this
  page is about.

The root domain does **not** have to point at OpenDecoDesk. If `myshop.com` is already your
business's website, leave it alone — only the admin and shop subdomains need to reach the Worker.

## The admin hostname

`npm run setup` adds your admin hostname to `wrangler.toml` as a **custom domain**:

```toml
routes = [
  { pattern = "admin.myshop.com", custom_domain = true },
]
```

With `custom_domain = true`, Cloudflare creates the DNS record and the certificate for that
hostname when the Worker is deployed. If the hostname **already has a DNS record**, the deploy is
refused — delete the old record in the Cloudflare dashboard first.

## Adding a shop

In the admin: **Manage catalog → ＋ New shop setup** (managers). A guided setup asks one question per
screen, with the steps down the side, and saves as it goes, so you can stop and resume (**Resume shop
setup**):

1. **Your shop:** its name — the shop ID and web address follow it — then decoration, delivery,
   payment, an order deadline and the shop's look. The web address is one word of lowercase letters
   and numbers; `www`, `api`, `images`, `mail`, `admin`, `all` and your own admin subdomain can't be
   used, nor one another shop has.
2. **Products:** pick blanks (or ＋ Enter a blank), then for each product its colors, decoration,
   designs, sizes and prices, and name and details.
3. **Check everything**, then **Go live** — the shop is ready and published.

Every catalog screen has the **shop bar** at the top: ← Manage catalog, the shop picker, Shop setup,
Shop settings (the shop's own form), Products, Designs and Graphics, and Publish. Products can also be
added later with **+ New Product**, **Import CSV** or **Copy from another shop…**. Attach the shop's
hostname (below).

Nothing here needs a code change. Attaching the hostname needs one `npm run deploy`, unless
automatic hostnames are set up.

## Publish

Each shop is published on its own. What shoppers see — and what orders are priced from — is the shop
as it was when it was last published: its settings and its products' rows (names, prices, sizes,
visibility, pictures). Edits in the admin are a **draft** until you press **Publish** for that shop
(Manage catalog or the shop's Products page, managers), or **Publish all shops**. A shop that has
never been published since this arrived is served live, as before.

- **Unpublished changes** are marked on Manage catalog and the Products page, product by product.
  **Discard changes…** on the shop bar (managers) puts the shop back to what was last published: its
  settings and products as they were, and a product added since removed (or hidden, if an order, a
  stock movement, an approval or a customer's upload already refers to it).
- **Preview** opens the shop's page with the draft, on the shop's own address, through a link signed
  with `SIGNING_SECRET` that works for an hour. Ordering is off in a preview.
- **Graphics, transfers, decoration locations, blank links and tier prices aren't part of the
  snapshot** — they apply as soon as they're saved.
- **These don't need Publish either**: the business profile, Region, Sales tax and the Feature
  switches.
- A product can't be saved without a price, and a new product starts hidden.

## Attaching a shop's hostname

### Automatically

If **Automatic hostnames for new shops** is set up (`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`,
`CF_WORKER_NAME` — the installer asks), creating a shop attaches `<subdomain>.<root domain>` to the
Worker as a custom domain. Cloudflare creates the DNS record and certificate.

- The result is shown when the shop is created and is written to the audit log. A failure never
  stops the shop from being created.
- The shop's **Edit** page has a **Custom domain** box showing the current state, with buttons to
  set it up or check again.
- A hostname that **already has a DNS record** is refused rather than overwritten — remove the
  record first.
- Changing a shop's subdomain later does **not** remove the old hostname; set up the new one from
  the Edit page and remove the old one in the Cloudflare dashboard.

**The API token.** It needs permission to edit Workers scripts on the account, to edit Workers
routes on the zone, and to read the zone's DNS (this is what `functions/_lib/customDomain.js`
documents; the exact permission names are Cloudflare's and may change). It is the most powerful
secret the site holds: it is only used by the admin's create-shop and set-up-domain actions and is
never sent to a browser, but create it for this one zone, with nothing more than it needs.

### By hand

After creating the shop in the admin, run:

```bash
npm run deploy
```

It reads every shop from the database, adds a line for each to the hostnames block the installer
wrote in `wrangler.toml`, and deploys. Cloudflare then creates the DNS record and certificate; a
hostname attached for the first time can take a few minutes to start answering.

```toml
routes = [
  { pattern = "admin.myshop.com", custom_domain = true },
  { pattern = "league.myshop.com", custom_domain = true },
]
```

> **Always deploy with `npm run deploy`, not a bare `npx wrangler deploy`.** A deploy makes the
> Worker's hostnames exactly the ones listed in `wrangler.toml`. A hostname attached any other
> way — in the Cloudflare dashboard (the Worker → Settings → Domains & Routes), or by the admin
> when a shop was created — is **detached by the next deploy**, with its DNS record, and the shop
> stops loading. This was seen on a real install. `npm run deploy` lists every shop first, so
> nothing is dropped; `npm run setup` does the same when it is run again.
>
> If a shop went offline this way, run `npm run deploy`. The hostname is attached again; give it
> a few minutes, since the address was briefly gone and computers remember that for a while.

**Before it deploys, `npm run deploy` checks with Cloudflare.** It reads the Worker's Custom Domains
and refuses to deploy when one of them isn't listed in `wrangler.toml` (the deploy would detach it),
when a shop or the admin isn't listed, or when the sign-in can't see your domain's zone (usually the
wrong Cloudflare account). It names each hostname and says what to do. `npm run deploy -- --check`
does the same checks and also lists the database migrations still to run, changing nothing — run it
before a deploy you're unsure of. `--skip-hostname-check` deploys without asking Cloudflare.

**Hostnames that already have their own DNS records** (a site that was served some other way before it
moved to this Worker) can stay **zone routes** instead of custom domains — no DNS change, no gap while
a record is replaced. Put them in the hostnames block like this; the deploy keeps them as they are and
adds only shops that have no line of their own:

```toml
routes = [
  { pattern = "admin.myshop.com/*", zone_name = "myshop.com" },
  { pattern = "league.myshop.com/*", zone_name = "myshop.com" },
  { pattern = "club.myshop.com", custom_domain = true },
]
```

## Turning the storefront off

With **Global settings → Features → Storefront** off, every shop address and the root domain show
"Online ordering isn't available here." and the server takes no customer orders. Shops, products,
"ready", Publish and hostnames all still work in the admin, ready for when it is turned back on.
An invoice you've sent (below) still works: its link opens card payment and shipping rates for
that one order.

## A shop's own settings

Manage catalog → the shop → **Edit**:

- **Delivery & pickup** — the list customers choose from: local pickup, carrier shipping (US, with
  the Shipping feature), and any number of your own options with a flat fee.
- **Payment methods** — a shop can turn off methods that are on site-wide; it can't turn on one
  that is off site-wide.
- **Payment on delivery** — follows Global settings: a shop can turn it off, or limit it to the
  Local sale window on Orders, but can't turn it on when it's off site-wide.
- **Order deadline** — a date, a message for afterwards, and whether orders are still accepted
  after it. The shop closes at 11:59 pm on that date in the business's time zone (Global settings →
  Region), for every shopper wherever they are; the banner names that time, and the server refuses
  orders after it unless late orders are allowed.
- **Sales tax** — tax exemption (see [sales-tax.md](sales-tax.md)).
- **Rush orders** — use the global rush fee, don't offer rush, or a rule of the shop's own (see
  "Rush orders" below).
- **Fundraiser** — none, a percent of each item's price, or an amount per piece, for the group the
  shop raises money for (see "Fundraising" below).
- **Reorder QR code & option prices** — for configurable products.

## Product categories

A product's category (Catalog → **Product categories**) decides which section of the shop's page it is
listed under, in the order set there, and what it packs like when a box is chosen for shipping (a
shirt, a sweatshirt, a cap, or "other" — no automatic box, the shipping is quoted by hand). The list
starts with Shirt, Sweatshirt, Cap, T Shirt, Hoodie, Patch and Other, and is yours to change. A category
in use by a product or a blank can't be deleted. Whether a product has sizes doesn't depend on its
category: it follows the product's pricing (by size, or one flat price).

On Manage catalog → the shop → **Products** the list is drawn the way the shop's page is, a section per
category, and ↑ ↓ move a product within its section (Publish to show the new order). On a configurable
product, the colors offered can be put in order too (↑ ↓ / First under the color boxes): that is the
order customers see the swatches in, and the first one is shown when the product opens.

## The product form

A product's page is a set of cards: Basics, **What does the customer choose?**, Blank & colors, On
every piece, The customer's pick, Customer's own design, Personalization, Prices & costs, and Pictures &
shop page. The first question has three answers: **Nothing** (every piece is the same), **A color**, or
**A color and a graphic** (the customer picks a graphic at one or more decoration locations). The page
then shows only the cards that kind of product uses.

The designs under **On every piece** are stitched on every piece, *as well as* the graphic the customer
picks, then the pick, then any personalization. Under the question, **What Run Order will do** lists
those hoopings as last saved, worked out by the same code Run Order uses, so a pick that can't be run
shows here first.

The catalog check also warns about settings that contradict each other:
- designs stitched on top of the customer's pick;
- a mockup graphic that repeats a pick, or that nothing stitches;
- **No embroidery design needed** or **No blank needed** ticked on a product that has designs or blank
  links;
- a pick list with personalization off;
- graphic options on a product that isn't configurable.

Each problem is outlined in the card that fixes it. An open order line placed before such a change is
marked **Check line — doesn't match catalog** on the Orders page; Edit items → **Update from catalog**
brings it up to date. It lists each change per line with a tick, so you can take some and leave others.
For a reorder QR or Printed transfer the catalog still has, it also offers (unticked) to remove it from a
line made without it. It works on made and completed orders too: only the order's record changes, so follow
it with **Use transfers for past orders** for the stock. On a line that already took its transfers out of
stock, every change starts unticked. With the Production feature off, the stitching parts (designs, What
Run Order will do, and their warnings) are left out.

## Versions of a product

A shirt sold in short and long sleeve is two products shown as **one card** on the shop page, with a
toggle between them. On the product form, **Versions** → **Add a version (e.g. long sleeve)…** makes
the second one: a new product, hidden until you tick Visible, with the first one's shared settings
(name, description, category, features, personalization, the customer's own design, No blank needed,
configurable locations, designs). Each version keeps its own sizes and prices, weight, colors,
pictures, overlay mockups and blank links, so give the new one its own blank. **Copy settings** brings
the shared settings across again after you change them on the other version; **Separate** makes them
two ordinary products.

Order lines are named with the version — "Club Tee (Long sleeve)". Both versions must be in the same
category (the card sits in one section); the catalog check warns when they aren't. The Products list
keeps them together, the second one indented.

## Quantity breaks

A product can cost less per piece in bulk. On the product form, **Quantity breaks** → add a row for
each step: from how many pieces, and how much comes off each piece — "from 12 pieces, $2.00 off
each; from 48, $3.50 off each". Up to six rows. Each row starts at more pieces than the one before
(from 2 up to 100,000) and takes more off, and no row can take a piece down to nothing: the amount
off has to be less than the product's lowest price. That holds when you lower a price, too: a
price at or under a break's amount is refused until the break is lowered.

- **What counts.** The pieces of that product in one order, across all its sizes and colors, added
  together. Other products don't count towards it, and neither do cancelled lines. A version of a
  product (short and long sleeve) is a product of its own, so its pieces are counted on their own.
- **What it takes off.** The deepest break the order reaches, from every piece of that product.
  It comes off the product's own price only: personalization and add-ons cost the same as ever.
- **Where it applies.** On the shop page, local sales and quotes. The shop page shows the breaks on
  the product ("12+ pieces: $2.00 off each"), and the cart shows each line at its price after the
  break, with the price it was. What the page shows is only a preview: the server works every price
  out again when the order is placed, as it does for a local sale when it is recorded.
- **Edit items** counts the order as it will be after the edit. Only the lines you change or add
  are priced again: a line already on the order keeps the price it was sold at, even if the edit
  takes the order past a break.
- **MAP.** The deepest break is a price like any other: a break that takes a piece under the
  blank's MAP is refused when you save, and one that falls under a MAP that rose later is flagged in
  Price analysis. Managers see the deepest break's price and what it leaves in the pricing panel
  ([Pricing](#pricing-what-an-item-costs-and-leaves)).
- Like prices, a change to the breaks reaches the shop page, and the orders priced from it, when the
  shop is published.

## Copying products from another shop

Manage catalog → the shop → Products → **Copy from another shop…**: pick the shop, tick its products,
and set each copy's ID, name, subtitle, category, version name and whether it's visible. A copy takes
the product's prices and sizes, weight, features, personalization, colors, locations (with their upload
prices), settings and blank links, and its pictures if you tick that. It never takes overlay mockups or
ready-to-ship stock. Graphics and designs belong to a shop: each one is matched to this shop's graphic
or design of the same name, or left out, and the result lists which — except a **global** graphic or
design, which every shop can use, so the copy keeps it. Versions of a product are copied together. Nothing is copied unless every copy is valid. A new shop's "copy products from" does the
same.

## Global graphics

A graphic can be made **Global** (the graphic form's Global box): every shop can offer it, and it's kept
in one place with its home shop, like a global design. A global graphic can only link a global design
and a transfer open to every shop, and it can't be made shop-only again while another shop's products
use it. The Graphics list shows them under "🌐 Global — every shop", and graphic pickers mark them 🌐.

## Products without a blank

Linking a product to a blank (Blank links on the product) is optional. Without one the product
saves and sells as usual; the catalog check marks it in amber, because its stock and cost of goods
aren't tracked. A configurable product's colors normally come from the blanks ticked for it — with
no blank, type the colors in by name instead.

A product that is made with **no blank at all** — a patch cut from twill on hand — gets **No blank
needed** on the product form. Its order lines then skip Blank ordered / received, go to Run Order once
paid (and the design is ready), stay off Blanks to Order, and the catalog check stops asking for a
blank link. Record its materials under Expenses as supplies.

## Blanks from stock

Blanks come out of stock when an order's pieces are made, not when they're received. An order whose
blanks are already on the shelf shows **In stock** on Run Order's "Paid, not yet run" list, with **Use
from stock**; on the Orders page the stage menu has **Use blanks from stock**. Either marks the order's
blanks ordered and received from "In stock" in one go. Stock is offered to orders soonest due first,
and only when it covers the whole order; otherwise you're told what's short, and nothing changes.

The Blanks screen shows, next to what's on hand, how many are **set aside**: promised to orders whose
blanks are in but not made yet. The shop page and the Products list show how many of a product's blank
are on the shelf for the color and size picked ("N ready to decorate") — what's on hand less what's set
aside. It's only a count: nothing is held for the customer. Finished stock ("N in stock") is shown
instead when there is some.

**Run Transfer Sheets** knows what's on the shelf too: a line whose transfers were already used, were
marked received, or are covered by transfer stock is ready to press, and the card says which (or what's
short). Stock is shared out soonest due first, and the gang sheet counts only what still has to be
printed. An order that has shipped, been delivered or been completed drops off the run pages and stops
holding blanks, even if it was never marked made. Blanks are received with **Receive order** (or Import from PDF), so
every receipt is against a vendor order.

**Correcting a transfer sheet.** Each row of a received sheet sets a per-item price: its % of the sheet ÷ its
count. To fix a sheet, open it from **Accounts & money → Blanks & transfers bought** (filter to *Transfer
sheets*, then **Edit sheet…**) or from **Transfers → History → Open sheet**. The list also shows each
transfer's per-item price on its sheet, so a sheet can be checked without opening it. The edit form is the
Receive form, filled in. **Preview changes** shows each row's per-item price before → after, each transfer's
new average cost, and the order lines that will be re-costed; **Save changes** applies it in one step. The
sheet's old entries are voided ("Sheet edited", and can't be restored one by one) and the corrected ones are
recorded in their place. Its written-off expense and personal draw follow. Uses already recorded are re-costed
to the corrected average, with two exceptions: a use in a closed month keeps its cost, and so does a piece made
for stock (that cost is already in the finished piece). A sheet matched to a bank-statement line, or in a
reconciled month, can still have its rows changed as long as its total, date, paid-from and written-off /
personal amounts stay the same.

**Transfers for past orders.** A line takes its transfers out of stock when it's marked fully made, using
the transfers it saved when it was placed. A line placed before its product carried a transfer (say,
before the shop's reorder QR was turned on) saved none, so making it took nothing out. **Inventory & COGS →
Use transfers for past orders…** lists every made line whose transfers never left stock, grouped by shop. A
line whose saved options name its transfers is ticked. A line worked out from what its product carries
*today* is marked so and starts unticked, because it may have been made without one: tick the shop, or the
lines, you know used it. So does a Printed transfer the product has now that a line's saved options don't
name (it was set up after the order was placed), marked **added from the product**. Each transfer on a line
has its own tick, and the strip above the table ticks one transfer on every line, so you can take a shirt's
front and back prints and leave out a QR it was made without. Applying takes each one out dated the day
the order was made, at the transfer's
average cost that day, and adds it to the line's cost of goods sold. Because a use dated in the past
changes how many were on hand when later sheets came in, later uses whose average moved are re-costed too
(not in a closed month, and not pieces made for stock). A line in a closed month can't be applied.

**Counting stock.** **Blanks → Count stock…** and **Transfers → Count stock…** open one window for a
shelf count. Each row is a blank color and size, or a transfer. It shows the stock on record (read
only), a **Counted** box that starts at that number, and the difference. Type what you counted; a row
that's off shows how to settle it:

- **Past orders…** (when short): the Use blanks / transfers for past orders window, listing only that
  item's made lines that never took it out of stock. Try this first. Stock an order used is cost of
  goods, not a loss. A transfer line that also uses other transfers takes those out too.
- **Write off…** (when short): damaged, lost, used for testing or other, up to the shortfall, at the
  average cost.
- **Correct count** (short or over): records the difference as a correction (an `adjust` entry at the
  average cost, so the average doesn't move). It shows in History and under corrections in
  Inventory & COGS.
- **History**: the item's entries, where a use recorded by mistake can be voided. That's usually
  why a count comes out over.

**Correct all remaining differences** records a correction for every row still off, after listing
them. Everything is dated **When was it counted?**, so a count dated in a closed month is refused.
What you typed stays while the window is open. The numbers on record reload after each step, so a
settled row's difference drops to 0. If an item's stock changed while you were counting (an order
was made, a sheet received), its correction is refused and the row is marked: count that row again.
Corrections are audited as "Blank / Transfer stock count corrected". Writing off and correcting need
full access to Blanks or Transfers, like a plain write-off.

## Blanks from vendors, and their prices

**Vendor prices** are kept apart from what your stock cost. On a blank's form each color and size has a
**Vendor price** (what the vendor charges now) beside a read-only average cost (what what's on the shelf
cost, landed). Typing a new vendor price never rewrites the average. **Same for all colors**, **Prices
are current**, **Price history…** and **Re-work average cost** are there too. When a vendor price
changes, every product priced on that blank is flagged (the catalog check, and on the product) until
you update its prices or click **Prices still OK**. Every 30 days the morning roll-up and Communications
list the blanks on products for sale whose prices haven't been checked.

**Blanks from a vendor's file:** Blanks → **Import → Vendor product file — new blanks…** (or **— update
prices…**) reads SanMar's product file (SDL CSV) or S&S's Data Library (Products + Styles .xlsx).
Pick the styles; each comes up for review — colors, sizes, prices per color, description, features and
photos (from a folder of the vendor's images on your computer, or downloaded from the vendor) — and
nothing changes until **Create / apply**. An update only takes what you tick, and never touches stock
or average cost. On a product, **Copy from blank** brings in the blank's description and features.

**Live from a vendor (PromoStandards):** Settings → **Vendor integrations** (admins) connects suppliers
that offer PromoStandards web services, with a login the vendor gives you, stored encrypted (it needs
the `VENDOR_CREDENTIALS_KEY` secret — see [accounts-and-keys.md](accounts-and-keys.md)). Then Blanks →
**Connected vendor → Refresh prices and colors…** and **Look up a style → new blank…** bring live data
into the same review. (The Connected vendor menu appears on Blanks only once a vendor is connected.)
A blank made or updated from a connection stays linked to it. Each connection's **Logs…** (admins) lists
every call to the vendor's web services — when, what, the answer or the vendor's error, how long — with
the full request (the password blanked) and response; logs are kept 30 days. A picture a vendor repeats on
every color (a catalog shot) isn't taken as any one color's, and SanMar's parts each bring their own color.

**Ordering blanks from a supplier** (admins): on Blanks to Order, a supplier whose connection offers
PromoStandards Purchase Order gets **Order from <supplier>…**. The window checks each line's part and
the supplier's stock, then places the order, shipped to your ship-from address (Global settings →
Ship-from), and marks the order lines "blanks ordered" with the PO number. PO numbers start with the
Business profile's **Purchase order prefix** (blank = `PO`), then the date. The supplier's shipment
notices become blank shipments — in the morning roll-up and on **Check shipments** — and **Receive…**
fills in Receive order. A line whose blank isn't linked to a connection is named under the table.
Suppliers turn ordering on separately (SanMar after a test order on its test service), and it charges
the payment method the supplier has on file for you — S&S needs an **integration payment method** (card
or bank) in your S&S account settings first. **A supplier's test service isn't a promise**: one has
placed a real order. On a test connection the PO number starts `TEST-` and the order says "TEST ORDER —
DO NOT PROCESS OR SHIP", but a supplier's system may ignore both, so check with the supplier. **Mark
cancelled…** records an order you cancelled with the supplier (it doesn't contact them): its lines that
haven't shipped or arrived go back on Blanks to Order, and its shipments stop being checked.

**Brand rules:** some brands may only be resold on the supplier's terms — most only decorated, and a
large order (100 pieces of one style by default) only after the supplier approves the logo. Catalog →
**Brand rules** (managers read it, admins change it) starts with the brands SanMar and S&S publish as
restricted — verify each with the supplier you buy it from — and per brand sets the large quantity,
whether it must be decorated (with categories that may be sold plain), whether a large order needs
approval, a note, and the logo concerns. A product on such a brand is flagged by the catalog check, an
order with a large quantity of one style gets a **Supplier review** pill, and Blanks to Order marks it.
**Price rule:** Brand rules also sets a price over MAP — dollars or percent, generally and per brand.
The setup wizard and the product form's **Work out the prices from the blank's cost or MAP…** start a
blank with a MAP at that price, and a price under the rule (but not under MAP) is a warning on the
Pricing panel, Price analysis, the Products list and the catalog check. **Show price impact…** lists
every product price on a blank with a MAP, in every shop — before, after the rule, and the change — and
a manager can apply the ticked prices (then Publish each shop).
A manager records the supplier's approval on the product's form, with the supplier's reply attached;
**Order from <supplier>…** refuses a large quantity without one unless an admin gives a reason
(audited).

**The vendor list:** every vendor box — a blank, Receive order, Import from PDF, Mark blank ordered, a
transfer sheet, an expense — picks from one list (**Manage…** beside the box, for a manager), so one
supplier isn't spelled two ways. Each vendor can be **For blanks** (offered where a blank's vendor is
chosen and in Blanks to Order), carry its free shipping, or be **Hidden** (no longer offered, kept on
its records). Records keep the vendor's name, so renaming a vendor renames every record that names it;
a vendor can be deleted only while nothing names it. A name that isn't on the list is refused (the
expense CSV import leaves it blank, the blank CSV import flags the row). The first upgrade builds the
list from the names already in use.

**Reorder points and free shipping:** a supplier charges marked-up freight on a small order, so keep
the blanks you sell most in stock and top each order up to the free-shipping amount. The blank form's
**Keep** column is a reorder point per color and size ("keep at least N" not set aside); Blanks shows
a chip and a **Below reorder point** filter, and Blanks to Order adds the restock under each row's
count, with an **Include restock** box — change a row's restock or leave it out (✕), and ↺ puts the
suggestion back. Restock you've already ordered (from the Order window, or **Mark as ordered**) isn't
suggested again until it arrives. Each vendor's free shipping — a dollar amount ($0 = every order ships
free) or a piece count, or none — is set on the vendor in the vendor list (✎ on its Blanks to Order
block, or **Manage…** beside any vendor box); SanMar and S&S start at their published $200. **Get me to free shipping** fills an order up to it: reorder
shortfalls first, then your best sellers (by the last 90 and 365 days), plus anything you add — then
Copy / CSV, Mark as ordered, or continue to the Order window.

**MAP (minimum advertised price):** S&S's files (`MAPPrice`; $0.01 means none) and SanMar's
(`MAP_PRICING`) carry each size's MAP, and it can be typed on the blank's form. A product's price for a
size can't be below the MAP of the blank sizes it's linked to (the highest across a color group's
colors): saving such a price is refused, and so is a link that would cause it. A product left below a
MAP that rose later is a catalog error, flagged in Price analysis, on the Products list (**⚠ Below
MAP**) and in the morning roll-up. PromoStandards has no MAP, so a refresh from it leaves MAP alone.
MAP is the vendor's public price, so staff see these warnings too.

**Color price groups:** a configurable product's colors can be grouped, each group with its own price
per size — heathers dearer, white cheaper (the product form's **Color price groups**, with **Suggest
from blank prices**). A color in no group keeps the product's own price.

**Weights:** each color and size of a blank can have a weight (the blank form's Weight column, filled
in from S&S's and SanMar's product files and from PromoStandards). Shipping quotes and package
weights use it for every product linked to that size; a weight typed on the product overrides it.

**Importing a vendor's invoice PDF:** a line for a color or size the blank doesn't have yet is added to
the blank (nothing in stock, no cost) instead of being left out.

**Embroidery files** in any format are accepted as a design's files; a known stitch format can't be the
editable design file and a known project format can't be the machine file. A design version needs its machine
file; the editable design file is optional (the versions list shows — where there's none). These machine files get needle
stops, a stitch count and a preview:

| Format | Machines | Thread colors in the file |
|---|---|---|
| `.dst` | Tajima | Only when the design software wrote `TC:` thread lines in its header |
| `.dsb`, `.u01` | Barudan | No (needle numbers only) |
| `.dsz` | ZSK | No (needle numbers only) |
| `.exp`, `.stx` | Melco, Bernina, Data Stitch | No |
| `.tap`, `.10o`, `.gt`, `.inb`, `.ksm`, `.max`, `.emd`, `.new` | Happy, Toyota, Gold Thread, Inbro, Pfaff, Elna, Ameco | No |
| `.pes` | Brother, Babylock | Yes — version 5 and later list each thread's brand, number, name and color; older ones a Brother chart color |
| `.pec`, `.phb`, `.phc` | Brother | Yes — a Brother chart color |
| `.jef` | Janome, Elna | Yes — a Janome chart color with Janome's thread number |
| `.sew` | Janome (older) | Yes — a Janome chart color |
| `.vp3` | Pfaff, Husqvarna Viking | Yes — each thread's brand, number, name and color |
| `.hus` | Husqvarna Viking | Yes — a Viking chart color with Viking's thread number |
| `.shv` | Husqvarna Viking | Yes — a Viking chart color (larger `.shv` files can't be read yet) |
| `.xxx`, `.pcs` | Singer, Pfaff | Yes — a color for each thread |
| `.pcm` | Pfaff | Yes — one of 16 plain colors |
| `.tbf` | Tajima | Yes — a color for each needle |

`.vip`, `.csd`, `.sst` and `.fdr` can be stored but not previewed (no public description of them exists), and
neither can design-software files such as `.emb`, `.jdx` or `.art`.

When the machine file names its threads, the preview starts in the file's own colors and each needle stop
the file names gets the matching thread from the thread catalog: the same brand and thread number first,
then the same name for a maker's chart color, then the exact same color. A stop whose color matches nothing
in the catalog is flagged red, **Not in thread catalog**, with the three closest catalog colors to pick from;
a picked thread with none on hand (when the shop keeps thread stock) is flagged amber, **None on hand**. Any
stop can still be given any thread: a match only fills a stop that's empty, never one picked by hand or
copied from the previous version.

## Digital products: selling files

A product can be sold as **files the customer downloads**: a digitized design in the formats people
ask for (DST, PES, JEF…), a PDF of instructions, or a zip with all of them. Tick **Digital product** on
the product's form. It then needs no blank, no design and no shipping, and has one price.

- **Files:** once the product is saved, upload its files on the form (any embroidery format, PDFs and
  zip files, up to 20 MB each, at most 20), or add a design from the Designs library (its latest
  version's file). They're kept in the private `DESIGNS` bucket.
- **In the shop:** it shows **Instant download**, but only once it has at least one file. Until then it
  isn't shown, and its product lists the problem. While Digital products is switched off, no digital
  product is shown. A cart of only digital products skips the delivery step. A mixed cart is delivered
  as usual for the rest, and the files add nothing to the parcel.
- **Once the order is paid** each file is granted to the order, with the limits as they are then:
  - Card payments are paid as soon as Stripe confirms them, and the customer lands straight on the
    order's **download page**.
  - For Venmo, Zelle or check, the files are granted when you record the payment (Mark paid or Add
    payment).
- **The email:** the customer gets one **"Your downloads"** email with the link. The files are attached
  too when they fit (10 MB in all by default: mailboxes refuse messages over about 25 MB, and attaching
  makes files a third bigger). Over that, the email says they're too large to attach and to use the link.
- **Limits:** the link works for a number of days, and each file can be downloaded a number of times
  (7 days and 5 downloads unless you change them in Global settings → Features → Digital products, or
  on the product). Blank means no limit. Emailed files don't use up downloads.
- **An order of only downloads** has no stages: there's nothing to make, pack or ship. It goes from
  received to paid to completed: once it's paid, its row offers **Mark completed**, with no stage list,
  shipping or rush. It isn't in Run Order's backlog either. An order with downloads and other items
  goes through its stages as usual for the rest.
- **On the order:** once it's paid, **Resend downloads** on its row emails the customer a new link, with
  the files when they fit; the old link stops working. **Downloads…** shows each file's downloads and
  expiry, with the same **Resend link**. **Reset downloads** sets the counts back to 0 with a new expiry.
  **Revoke** stops the downloads; voiding the order does too. A refund doesn't revoke on its own: use
  Revoke if you want it to.

The download link is the customer's key: there's no sign-in. It's long, random, specific to the order,
and never cached or indexed. Every download is logged with the time and the customer's network, in case
of a dispute. Whether digital goods carry sales tax depends on the state: the product's **Taxable**
box decides it here, as for any product. The desktop version doesn't sell online, so it has no digital
products.

## Pricing: what an item costs and leaves

Managers see, on a product's form, what each item costs the shop under its price and what's left:
the blank (its vendor price, else the average cost), the card fee, sales tax, transfers (the reorder QR,
printed transfers and the product's own **DTF / transfer cost per item**) and **Shop supplies per
item**. Give it a **Run time** and it shows the hourly rate too (or the average of its timed runs on
Run Order). When sales tax is added on top of your prices, the tax isn't a cost; the card fee is then
on the price plus the tax.

Global settings → **Pricing** sets the card fee, the default supplies cost and two optional targets —
**Target income per item** and **Target effective hourly rate**. Meeting either target is enough: a price
is below target only when it misses every one that applies (the hourly one needs a run time). Such a product is flagged
on its form, on the Products list, in **Price analysis** (on Manage catalog and the Products list) and
by the catalog check, and the morning roll-up lists products that slip below one (a blank's cost, a fee
or a target changed). Staff can edit products but don't see costs and margins.

Once a **shop rate** is saved (Finance → Shop rate, [operations.md](operations.md#shop-rate)), each item
also carries its share of the business's **overhead**: its run time × the overhead per hour, shown in an
**Overhead** column, and the income is what's left after it. The hourly target is then the rest of the
shop rate (your pay and profit per hour), unless you type your own **Target effective hourly rate**.

## Printed transfers and mockups

A product can carry **Printed transfers (DTF)** at fixed locations — a crest on the back of an
embroidered shirt. They're part of its price; the customer doesn't choose them. Every order line gets
them, so Run Transfer Sheets, transfer stock and cost of goods handle them like the reorder QR.

Mockups work for any product, not only configurable ones: the product form has a mockup table per
location, with the graphics offered there and its printed transfers. A plain product's embroidery comes
from its designs, which have no location, so **Embroidered graphics (for mockups)** names the
embroidery graphic to picture at each location — for pictures only, never the order or the price.

## Finished stock

Pieces made ahead — a shop's caps already embroidered and on the shelf — are **finished stock**. On
Manage catalog → the shop → Products, a product's **Stock** button opens its stock window:

- **Make for stock** takes the linked blanks out of blank stock — and the transfers each piece carries
  (its printed transfers, the reorder QR, a transfer graphic picked for it) out of transfer stock — and
  adds the finished pieces at their cost. It isn't cost of goods yet; that's counted when a piece is
  sold. Transfer stock isn't a limit: it can go below zero until the sheet is received, and the stock
  window says what's short.
- **Correct count** sets the number on hand after a count. A product made with no blank (a patch) has
  no blanks to take out, so its count is entered this way.
- **History** lists every change, and each can be voided (a Make for stock entry puts its blanks and
  transfers back).
  Entries in a closed month can't be changed.

An order from the shop page, or a local sale, for a size that's in stock is **filled from stock**
automatically: it skips the blank, design and making steps, and the order lines say "From stock". The
pieces are set aside until the order is marked made (a local sale is handed over, so at once), then
leave stock with their cost. Cancelling or voiding before it ships puts them back, and two orders can't
both get the last piece. A personalized line, or one with the customer's own design, is always made,
never taken from stock. Each version of a product has its own stock.

A product with color and graphic choices is stocked per **combination**: the garment color, the graphic
(and ink) at each spot, and the size — "Navy · Left chest: Crest (Gold) · M". The stock window lists
each combination you have and has **Add stock of a combination** to make or count a new one; it's
checked the way an order's choices are. An order is filled from stock only when its color, graphics,
ink and size all match, and the shop page shows "N in stock" once the customer's picks match.

Blanks bought for testing or shop use are marked **For testing / shop use** on the blank (TESTING on
the Blanks screen); they're used up with Write off → testing. Every write-off records why: testing,
damaged, lost or other. Reports → **Inventory & COGS** shows the three groups — blanks for sale, blanks
for testing, finished stock — with cost of goods split into blanks used on orders and finished stock
sold, write-offs by reason, and a roll-forward that says whether it adds up (transfers pressed onto
finished stock come into it from the Transfer sheets section, where they're shown as "Into finished
stock" rather than cost of goods). Periods & Export's
year-end files carry the same figures, with an "Inventory by group" file.

## Invoices

Orders → **Send invoice…** (on any order that still owes), or "Email the customer an invoice" on the
Local sale form, emails the customer a link to an invoice page on the shop's own address. On it they
see the lines and what's owed, choose how they'll get the order — the shop's pickup and delivery
options, or carrier rates for their address — and pay by card, or see how to pay by Venmo, Zelle or
check (from Global settings → Business profile). Their delivery choice is written to the order: the fee
comes from the shop's list or a signed carrier rate, never from the page, and the sales tax follows the
address. "Shipping — cost to follow" is only offered when no box fits the order. The choice can't be
changed once the order is paid, shipped or in a closed month, or when the invoice was sent with the
delivery fixed. Sending again keeps the same link and renews it for 60 days; the customer's choice is
in the morning roll-up.

## Customers

**Customers**, next to Orders, keeps one record per customer: name, company, email, phone, address
and notes, with the customer's orders across every shop, how many there are, what they've spent
and what they still owe. (The amounts are shown to the roles that see order totals.) Each order
number opens that order.

- **Where they come from.** Every order with an email address is linked to the customer with that
  email, and a customer is made the first time an email is seen. Capitals and spaces around it
  don't matter. An order whose contact is a phone number, or empty, has no customer. Orders you
  already had were linked the same way when this was added. A test order joins a customer that
  exists but never makes one.
- **The list** searches name, company, email and phone as you type. Archived customers are hidden
  until you tick **Show archived**.
- **+ New customer** needs a name or a company. Two customers can't have the same email.
- **On a local sale**, type in the **Customer** box and pick one: the name and contact are filled
  in and the sale is linked to that customer. Change the email afterwards, or press **Clear**, and
  it is linked by its email like any other order. **New sale for this customer**, on the
  customer's page, opens the form with them picked.
- **On an order**, the customer's name opens their page. **Link to a customer…** puts an order
  that has none (or the wrong one, after **Unlink customer**) on a customer you search for. Linking
  or unlinking changes only whose history the order is in; the order's own name, contact and tax
  stay as they were. A voided order keeps the customer it had.
- **Archive** hides a customer from the list and keeps everything. An archived customer's later
  orders are still linked to it. **Restore** brings it back.
- **Merge into another customer…** is for duplicates — the same person under two emails. Every
  order moves to the customer you choose, after a confirmation that says how many. Blanks on that
  customer (email, phone, company, address, notes) are filled from the one merged away, and
  nothing already there is overwritten. The merged record is archived, and a later order with its
  email goes to the customer you kept. A merge can't be undone. A tax exemption is not carried
  over ([sales-tax.md](sales-tax.md#tax-exempt-customers)).

There is no customer sign-in: the records are for the back office, and nothing about them is sent
to the storefront.

## Quotes

**Quotes**, next to Customers, is for an order you price before the customer says yes: a team's
shirts with a setup fee, say. A quote belongs to one customer (a customer record — make one first
if they're new) and one shop, and is numbered Q-00001, Q-00002 and on. **+ New quote** asks for
both; **New quote for this customer**, on a customer's page, starts one with them picked, and the
customer's page lists their quotes. The list filters by status and shop, and searches as you type.

A quote has a title, a **message** to the customer, an **internal note** they never see, an
**expiry date** (the last day it can be accepted; leave it empty for none) and up to 100 lines:

- **A product** from the shop, with its size, quantity (up to 5,000) and personalization, priced
  as a local sale would be: quantity breaks count every product line on the quote
  ([Quantity breaks](#quantity-breaks)), and the line shows the list price, the break and the price
  each. A price of your own for the line needs the payments permission (payments, discounts and
  refunds) at Edit.
- **A custom line**: a description, quantity, price each, and whether it is taxable.
- **A fee**: setup, digitizing, art or other, with a description and one amount, taxable or not. A
  fee is charged once, whatever the quantity.

The totals follow each **Save**.

**Send** emails the customer a link to the quote on the shop's own address, with your message: to
the customer's email, or another address you type. On it they see the shop, the lines and fees (a
line with a break shows the price it was), the totals and the expiry date, and can **Accept** it
(after a confirmation) or **Ask for changes** with a message. Each answer is emailed to you.
Sending fixes the prices: a product's price or break changed afterwards doesn't change the quote,
and neither does the tax rate ([sales-tax.md](sales-tax.md#quotes)).

- **Once sent, a quote can't be edited** (only its internal note) — until the customer asks for changes. Their message is
  shown on the quote; change it, **Revise** (which saves it), and send it again. Sending again
  keeps the same link. To change a sent quote they haven't answered, cancel it and make a new one.
- **Accepted** — the customer's yes makes the order straight away and, when the site sends email,
  emails them its invoice ([Invoices](#invoices)) to choose delivery and pay. **Convert to order**
  does the same from the back office (tick the box to email the invoice), when the customer says
  yes another way.
- **The order** is a local sale in the quote's shop, linked to the customer, at the prices and
  with the tax quoted ([sales-tax.md](sales-tax.md#quotes)). Each fee becomes a line of its own ("Setup fee — …").
  The order shows **From quote Q-…**, and the quote links to the order. A quote makes one order:
  converting it again only gives you the same order, and the customer's link, once accepted, names it.
  Staff can convert a quote whatever its expiry date; only a cancelled one can't be.
- **What can't be accepted:** a quote that has expired (from the day after its expiry date, in the
  business's time zone), was cancelled, or has already become an order. The link says which.
- **Cancel quote** (Manager and Admin by default): the customer's link then says it was cancelled
  and can't be accepted. A cancelled quote stays in the list.

Making a quote needs the Quotes permission, and converting one also needs to be allowed to enter
orders ([operations.md](operations.md#users-and-roles)). With the Quotes feature switched off, the
page is hidden and the links answer "Quotes aren't available."

A local sale takes as large an order as a quote: up to 5,000 pieces a line and 100 lines. The shop
page keeps its own limits — 50 of an item at a time and 20 lines in the cart, with a note to contact
the shop for more.

## Fundraising

A team, school or club shop often raises money for the group: part of every sale goes back to it. A
shop's settings (above) can say how much, so the admin works it out for you instead of you doing it
by hand:

- **None** — the default.
- **Percent** — a percentage of each item's price, from 0.01% to 50%.
- **Per piece** — an amount for every piece sold, from $0.01 to $1,000.

A fundraiser also needs **Supports** — who the money is for ("Example Boosters", up to 80
characters) — and has a **Show on the shop** tick box.

**It is inside your prices.** The customer pays the same; the amount is yours to give back to the
group. Nothing is added at checkout, and the tax doesn't change
([sales-tax.md](sales-tax.md#fundraisers)).

What each line of an order raises is worked out **when the line is priced**, and kept on the line:
an order from the shop page, a local sale, a quote turned into an order, an imported order, and a
line added or changed with Edit items. So changing the fundraiser, or turning it off, affects new
orders only; what earlier orders raised stays as it was.

- **Percent** is taken of the line's price before tax — with prices that include tax, the tax is
  taken out first — and personalization counts as part of the price.
- **Per piece** is the amount times the quantity, but never more than the line itself comes to
  before tax.
- A custom line and a fee (on a local sale or from a quote) raise nothing. A piece filled from
  finished stock raises like any other.

**Show on the shop** puts one line under the shop's name on its page: "$2.00 of every item supports
Example Boosters", or "10% of every purchase supports Example Boosters". Only that sentence reaches
the storefront, never the setting itself. Unlike the shop's other settings, the fundraiser doesn't
wait for [Publish](#publish): orders raise money by it, and the shop page shows its line, as soon as
it's saved. It is never one of the shop's "unpublished changes", and Discard changes doesn't undo it.

**Reports → Fundraising** shows what each shop raised, what you've paid the group, and what you
still owe it; recording a payout is on the same page. See
[operations.md](operations.md#fundraising-the-report-and-payouts).

## Discount codes at checkout

A shop's checkout shows a **Discount code** box, above the totals, only while some code can be used
there: switched on, not used up and not past its last day, made for that shop or for all shops — and the
Discount codes feature is on. With none, there is no box. This is worked out on every visit, so a new
code (or one switched off) shows at once, without [Publish](#publish).

The customer types the code and presses **Apply**; the totals show the discount ("Discount (SAVE10)
−$4.00") and the total less it. A code for one person needs the email typed first. Changing the cart
checks the code again. The order is checked once more when it is placed, and the confirmation and the
order-received email show the discount. Making codes is on the Discount codes page
([operations.md](operations.md#discount-codes)).

## Rush orders

A customer can ask for an order to be rushed. What it costs is a rule, set in Global settings → **Rush
orders** and followed by every shop unless the shop's own settings turn rush off or give it a rule of
its own (a shop's rule is part of what Publish snapshots; the global one takes effect at once):

- **Off** — rush isn't offered.
- **Fixed** — an amount.
- **% of the items** — a percentage of the merchandise.
- **The greater of the two** — the amount or the percentage, whichever is more.
- **Fee to follow** — for costs you can't know up front (overtime, expedited shipping): the customer
  asks for rush, you work out the fee and set it on the order afterwards. An optional estimate ("usually
  $15–$40") is shown at checkout.

The rule also has the words the customer ticks, an optional note, and optionally **Full payment due —
days before the needed-by date**.

At checkout, **Need it sooner?** offers the rule's fee and an optional **Needed by** date, which becomes
the order's due date (the run queues put it first). The fee is worked out on the server from the shop's
published rule; nothing about it comes from the browser. When the rule has a number of days, the order
gets a **full payment received by** date: the needed-by date less those days, never before today (in
the Region time zone).

On any order, **Rush…** turns rush on or off, sets or changes the fee (or marks it to follow), the due
date, and the full-payment date (which can't be after the due date). It works whether or not the shop
offers rush, and every change is in the audit log.

- The fee is part of what's owed. A fee still to follow never holds up paying for the rest; collect it
  afterwards, for example with Send invoice.
- **An unpaid rush fee doesn't hold up production.** An order paid for everything except the rush fee
  goes on to Run Order, Run Transfer Sheets and Blanks to Order; marking it completed still needs it paid
  in full.
- With a full-payment date, the invoice email (its subject too), the order-received email and the
  invoice page say plainly that without full payment by then the rush delivery date can't be
  guaranteed — and the invoice page says so in red once the date has passed with money still owed. The
  Orders page flags it too.
- Rush fees are on the receipts, the invoice page, the reports and exports, and the morning roll-up lists
  orders whose fee is still to set.
- A percentage fee is worked out when the order is placed; editing the items later doesn't change it
  (Rush… does).

## Customers' own designs

A product can let the customer upload their own artwork (Manage catalog → the product → **Customer's
own design**):

- **Embroidery** — you digitize the customer's image and upload the stitch file for that line (Orders
  → Edit items → Files → Order design) before Digitizing complete. The customer approves the proof
  as for a typed-in name, and Run Order runs the stitch file you uploaded.
- **Transfer** — the line goes to Run Transfer Sheets with the customer's image, printed as uploaded.
- **Add-on per piece** — added to the price, like a graphic's add-on. Blank means free. A
  configurable product can set its own add-on at each location (under the location, in the product's
  graphics); a location left blank uses the product's.

On an ordinary product with no design of its own the upload is **required** (and the catalog check
doesn't flag the product for having no design). On one with a design the customer can choose
**Use my own design instead**, which replaces that design on that item. A configurable product
offers **Custom — upload your own** at each location, and the customer can use it at as many
locations as they like. Stitched, each of those locations gets its own order design: Files shows
an **Order design** slot per location, and each one's hooping on Run Order waits for its stitch file.

What the shop page accepts: PNG, JPG or WebP, up to 10 MB, at least 500 px on the long side and at
most 10,000 px on either side. A transfer under 1,500 px gets a warning that it may print soft. The
server checks all of this again. Uploads go to the private `DESIGNS` bucket (see
[configuration.md](configuration.md)), so the setting needs file storage. An upload that never
made it onto an order is deleted after 48 hours.

The customer's file is on the order line under **Files**, with a picture; it can be downloaded but
not deleted. Adding a customer's design from the admin (Edit items, a local sale) isn't offered:
attach the file under Files instead.
