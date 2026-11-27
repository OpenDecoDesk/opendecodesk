OpenDecoDesk's back office as a program on one computer, for a shop that doesn't sell online. You
don't need a Cloudflare account, a domain or a web shop. Orders entered by hand, production,
inventory and cost of goods, and the books, with everything kept on your own computer.

**This is an early release.** Make backups (File → Back up…).

**New in this release:**

- **Discount codes** (Discount codes, with the Discount codes feature on): percent or amount off,
  for all shops or one, with an optional expiry. A percent code can have a most it takes off
  ("20% off, up to $25.00"). Codes can be single-use for one customer's email, or good for a set
  number of uses, and you can make one code each for a whole list of emails. Type a code on a
  **Local sale** (Orders → + Local sale): the sale shows the discount before you save it, and
  voiding the order gives the use back.
- **Email campaigns** (Discount codes → Email campaigns, once email is set up): marketing emails
  to your customers. Choose who gets one by shop, when they last ordered, how many orders they've
  placed, or addresses you type in. Start from a theme (Black Friday, Christmas, Halloween,
  Thanksgiving and others), build the email from blocks (banner, text, button, products, a
  discount code) or edit its HTML, and add a code: one for everyone, or one of their own each.
  Send yourself a test, then send it now or schedule it. A scheduled campaign goes out while the
  program is open; one that came due while it was closed goes when you next open it. Each email
  tells the customer to reply UNSUBSCRIBE; press **Stop marketing email** on their customer page
  when they do. The Local sale form has a box for whether the customer wants these emails.
  Receipts, invoices and other order emails always go.
- **Tax packet** (Reports → Tax packet): one printable document for your accountant, for any date
  range: expenses by Schedule C line, sales tax, revenue, cost of goods sold, money owed and
  more, each part taken from the report it matches. **Save PDF…** saves it directly.
- **Fixes:** refunds of cancelled lines now count in the balance due, and two refunds at once
  can't both go through; transfer stock counts come from the history; the order deadline closes
  at 11:59 pm in your business's time zone; and each role sees prices and costs as its setup says.

## Downloads

- **Windows:** `OpenDecoDesk-Windows.zip`. Unzip it to a folder of its own on the computer's own
  disk (say `C:\Users\<you>\OpenDecoDesk`) and run `OpenDecoDesk.exe` from there. There's no
  installer. Not a shared or network folder: the program can't open its window from one. In
  Parallels, Windows' Desktop, Documents and Downloads are often the Mac's own folders. The first
  time, Windows warns about an unknown publisher: choose *More info → Run anyway*.
- **Mac with Apple silicon (M1 or later):** `OpenDecoDesk-macOS-AppleSilicon.zip`.
- **Mac with an Intel processor:** `OpenDecoDesk-macOS-Intel.zip`.

On a Mac, unzip it and move OpenDecoDesk to Applications. The first time, macOS won't open it
because it isn't from an identified developer: open *System Settings → Privacy & Security* and
choose *Open Anyway*. If macOS asks whether OpenDecoDesk may use its keychain item, choose
*Always Allow*.

The downloads aren't signed yet, which is why Windows and macOS warn about them.

## What's in it

- **First start:** set up your account (name, email, password), then your business's details in
  Global settings. A shop, "My shop", is ready for the orders you enter (Orders → + Local sale).
- **Back office:** production (Run order, digitizing, machines through the send-agent on the same
  computer), blanks and stock, cost of goods, expenses, accounts, reconciling, closing months and
  the accountant export.
- **Optional, each needing the internet** (Global settings → Features: tick one and its panel asks
  for what it needs):
  - **Shipping:** carrier rates, labels and tracking with your Shippo key. Without it, shipping is
    by hand: an order's address, carrier, charge and tracking number.
  - **Email:** from your own mailbox (Gmail, iCloud, Fastmail, Zoho or any SMTP server): order
    emails, invoices with a PDF of the invoice attached, and the morning roll-up.
    - **Design approval:** proofs emailed with the pictures attached, approved by reply.
    - **Email campaigns:** marketing emails to your customers, with discount codes.
  - **Supplier connections:** a supplier's live product data and prices (PromoStandards),
    ordering blanks, and shipment notices.
- **Save invoice PDF…** on any order, to print or send yourself.
- **Your data** is in `%APPDATA%\OpenDecoDesk` (Windows) or
  `~/Library/Application Support/OpenDecoDesk` (Mac), and **File → Open the data folder** opens
  it. A newer version keeps it.
- **Help → Open the log** for reporting a problem. **Help → Locked out? Reset sign-in…** if you
  can't get in. Your data isn't touched.

## Not in the desktop version

The web shop, card payments (Stripe), payment links, and anything that sends a customer to a web
page. Import from PDF uses its layout reader only (Read with AI needs Cloudflare). Microsoft 365
and Outlook.com mailboxes aren't supported yet.

## Tested so far

The Mac Apple-silicon download on a real Mac, and the Windows download on Windows 11 for ARM in
Parallels. Not yet run: Windows on an Intel or AMD PC, and the Intel Mac download.

The full guide is in `docs/desktop.md` in the repository.
