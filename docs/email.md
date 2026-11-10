# Email

The site sends email through **one** provider — never two, and there is no fallback. If a send
fails it is not retried somewhere else; it is recorded as a problem, shown on the admin's
**Communications** page and reported in the next morning roll-up.

With **no provider set up, no email is sent at all.** Orders still work; customers just get no
confirmation, and each attempted email is listed as a problem.

## Choosing a provider

Global settings → **Email** chooses between two ways of sending:

- **A hosted email service**: Cloudflare Email Service or Resend, sending from an address on your
  own domain. This is the default.
- **Your own mailbox**: Gmail, iCloud, Fastmail, Zoho or your web host's mail, over SMTP, the same
  setup as the desktop version (see [Your own mailbox](#your-own-mailbox-smtp) below).

| | Cloudflare Email Service | Resend | Your own mailbox |
|---|---|---|---|
| Needs | Cloudflare's **paid Workers plan** | A Resend account | A mailbox, and its app password |
| Set | `CF_EMAIL_API_TOKEN` (secret) + `CF_ACCOUNT_ID` | `RESEND_API_KEY` (secret) | Global settings → Email, plus `VENDOR_CREDENTIALS_KEY` (secret) |
| Sends from | `EMAIL_FROM`, on your verified domain | `EMAIL_FROM`, on your verified domain | The mailbox's own address |
| Limits | The provider's | The provider's | The mailbox's (Gmail: about 500 a day) |
| Bounces | A customer address that permanently bounces is reported back at once, and the send counts as failed | Not reported back to the site (Resend reports bounces later, in its own dashboard) | Not reported back to the site (the bounce arrives in the mailbox) |

**With your own mailbox chosen, it is used for everything**, whatever secrets are set. Otherwise,
**if `RESEND_API_KEY` is set, Resend is used for everything**. To switch back to Cloudflare, remove
that secret.

`npm run setup` asks which one you want and stores the key. By hand: `npx wrangler secret put
RESEND_API_KEY`, or `npx wrangler secret put CF_EMAIL_API_TOKEN` plus `CF_ACCOUNT_ID` in `[vars]`.

For Cloudflare, the API token should have **only** the Email Sending permission. Do not reuse the
token used for automatic hostnames (`CF_API_TOKEN`), which can change your account.

## Verifying your sending domain

Either provider will only send mail **from a domain you have proved is yours**. Until that is done,
every send fails. This is done with the provider, not in OpenDecoDesk, and the site can't check it
for you — the Setup status list only shows whether a key is set.

- **Resend**: add your domain in Resend's dashboard. It gives you DNS records; add them in the
  Cloudflare dashboard (DNS) for your domain and wait for Resend to show the domain as verified.
- **Cloudflare Email Service**: follow Cloudflare's own steps for turning on Email Sending for your
  domain (they are not part of this project, and are not repeated here because they may change).

If your domain already has SPF, DKIM or DMARC records (for example because you send mail from it
with another service), read the provider's instructions carefully — the new records have to be
combined with the old ones, not added alongside.

The domain to verify is the one in the sender address: by default `orders@<your root domain>`,
or whatever you set as `EMAIL_FROM`.

## Your own mailbox (SMTP)

There's no domain to verify: emails go out from the mailbox's own address, as if you had sent them,
and copies land in its Sent folder with Gmail, iCloud and most others.

1. Set the key the mailbox's password is stored with, once (the same key that protects vendor
   logins; skip this if it's already set):

   ```bash
   openssl rand -hex 32 | npx wrangler secret put VENDOR_CREDENTIALS_KEY
   ```

2. In Global settings → **Email**, choose **Your own mailbox**. Pick the mailbox (the presets fill
   in the server), and enter its address and its password. Gmail and iCloud need an **app password**
   (made in the account's security settings), not the normal one. **Check the mailbox** signs in
   without sending anything.
3. **Save global settings**. The site signs in to the mailbox first; nothing is saved if it can't.
   Then **Send a test email**.

The password is stored encrypted in the database and never sent back to the browser. Changing
`VENDOR_CREDENTIALS_KEY` makes it unreadable: enter it again. Switching back to a hosted service
keeps the mailbox's settings and password for later.

Port 587 is STARTTLS and 465 is SSL/TLS; the connection is always encrypted before the password is
sent. Port 25 isn't allowed (Cloudflare blocks it). Microsoft 365 and Outlook.com mailboxes aren't
supported yet: they need "Sign in with Microsoft".

## Who sends, who receives

Every email is sent **from** `EMAIL_FROM` (default `orders@<root domain>`) — or, through your own
mailbox, from the mailbox's address — under your business name, with **reply-to set to your own
inbox**, so a customer who replies reaches you.

| Inbox | Set in | Used for |
|---|---|---|
| **Your inbox** (owner) | Global settings → Business profile → "Your inbox". Falls back to the `OWNER_EMAIL` variable, then `owner@<root domain>`. | The morning roll-up, and the reply-to on every email. Not shown to customers. |
| **Receipts inbox** | Global settings → Business profile → "Receipts inbox", or the `EMAIL_BCC` variable (which wins). Optional. | Gets a hidden copy (BCC) of every email the site sends — skipped when the email is already addressed to that inbox. |
| **Contact email** | Global settings → Business profile → "Contact email". | Shown to customers on the storefront. Not used for sending. |

Make sure "Your inbox" is filled in. If it isn't, notices go to `owner@<root domain>`, which
probably doesn't exist.

## What gets sent

To customers, as things happen:

- **Order received** — when an order is placed. Subject "Order received — <order> · $X due", or
  "Order received and paid — <order>" when it was paid by card at checkout. While something is owed
  it says **how to pay** (below).
- **Payment received** — when you record a payment (Mark as paid, or a payment in the payments
  window), or press the order's **Resend** button once it is paid. Subject "Payment received —
  <order> · paid in full", or "· $X still due" for a part payment. A card payment does not email the
  customer by itself: it is recorded and reported to you in the roll-up. (Stripe can send its own
  receipt, depending on your Stripe settings.)
- **Your order has shipped** — once, when an order becomes shipped (Shipping feature).
- **Design proof** — when you send a design for approval (Design approval feature).
- **Payment request** — when you email a payment link.
- **Cancellation** — when you cancel items on an order that has an email address.

### What's in the order emails

- **The items, priced before tax.** Item · Size · Qty · Unit price · Amount. When your prices include
  tax (Global settings → Sales tax), each line's tax is taken out, so the amounts are before tax; then
  Subtotal, Shipping, Rush fee, Discount (before tax), **Sales tax**, and the **Total** the customer
  pays. A unit price that had to be rounded to the cent says so (the line amounts stay exact).
  Tax added on top reads the same way; a tax-exempt order says "Tax-exempt" above the total.
- **How to pay**, while something is owed: the way the customer chose first — a check (payable to
  your legal name, else your business name; mailed to your "Mail checks to" address; the order
  number on the memo line), Venmo (with a link carrying the amount and the order number), Zelle —
  then the other ways you take (Global settings → Payment methods, and the shop's own), then your
  payment note.
- **Who it's from**, at the bottom: your business name, legal name, mailing address, phone, contact
  email and website, then your footer line.
- **A PDF**: an invoice while something is owed, a receipt once it's paid ("Invoice <order>.pdf" /
  "Receipt <order>.pdf"). It's made by the site itself (no browser, nothing to pay for) and attached
  on every provider. Turn it off with Global settings → Customer emails → "Attach a PDF to order
  emails". Orders → **Invoice PDF** / **Receipt PDF** downloads the same file.

All of it comes from **Global settings → Business profile**. Setup status lists "Payment details on
emails" until what the emails need is filled in (where to mail a check, your Venmo name and Zelle
address if you take those, and a contact email or phone).

### Seeing them before a customer does

Global settings → **Customer emails** → **Preview emails…** shows any of them — Order received,
Payment received, Invoice, Shipped — for a sample order **with shipping** (a carrier, a discount) or
**without** (pickup, an untaxed item), paid by Check, Venmo, Zelle or Card. It shows the subject, the
email as it will look, the plain-text version, and the PDF. Nothing is saved or sent. **Send me this
sample** (admins) emails it to your inbox with "[Sample]" in front of the subject; **View sample PDF
receipt…** opens straight on the PDF. The preview uses the saved Business profile, so save first.

To you:

- **The morning roll-up** — one email a day with everything new. See
  [operations.md](operations.md).

## Checking it works

The quickest check is Tools → **Communications** → **Send a test email** (admins only). It sends
one short message the same way order emails go, and shows what happened:

- which provider was used (or your own mailbox), and the From, Reply-to and BCC addresses;
- what the provider answered: its HTTP status and its own message (and, from Resend, the email's id
  to look up on its Logs page);
- whether `RESEND_API_KEY` looks right: its length, that it starts with `re_`, and no stray space or
  line break (the key itself is never shown);
- what to do about the usual problems: the sending domain not verified in Resend, Resend's testing
  mode (it only sends to your own address until a domain is verified), a refused key, or a From
  address still on `example.com` because `ROOT_DOMAIN` isn't set.

A test send is not recorded as a failed email. Up to 10 a minute.

Or place a test order on a shop with your own email address. If nothing arrives:

1. Tools → Global settings → **Setup status**: is Email "Ready", and which provider does it name?
2. Tools → **Communications**: is there a problem listed for that email?
3. In your provider's dashboard: is the domain verified, and does it show the send?
