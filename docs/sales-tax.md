# Sales tax

OpenDecoDesk handles the simple case: **one rate, charged on orders in your home state.** It is a
record-keeping aid, not tax advice — check what applies to you with your state and your accountant.

**A new install collects no sales tax** until you set a rate.

## The settings

Settings → Global settings → **Sales tax**:

- **Rate** — a percentage, 0 to 15.
- **Home state** — the 2-letter code of the state you collect tax for. (With Region → country
  `OTHER`, it is your region's name as free text.)
- **Prices include sales tax**, or **sales tax is added at checkout.**

Orders imported from another store (Orders → Import orders…) get **no** sales tax here: Etsy and
Shopify charged their own, and the order is recorded as tax-exempt so it isn't charged twice. The
import window names the tax the store charged.

Changing any of them affects **new orders only**. Every order keeps the rate, the mode and whether
it was exempt as they were when it was placed, so past reports don't change.

## Prices that include tax, or tax added on top

The tax is worked out **once per line of an order** (not per item), in whole cents.

**Prices include sales tax** (the default). The customer pays the listed price; the tax is the part
of it that is tax.

> A $16.00 cap at 6%: the customer pays **$16.00**. Of that, $15.09 is the sale and **$0.91** is tax.
> Three of them on one line ($48.00): $45.28 sale and **$2.72** tax.

**Sales tax is added at checkout.** The listed price is the sale; the tax is added to it.

> A $20.00 shirt at 7.25%: tax is **$1.45**, the customer pays **$21.45**.
> Three of them on one line ($60.00): tax is **$4.35**, the customer pays $64.35.

The two modes agree with each other: a $15.09 price with 6% added comes to $16.00 with $0.91 tax —
the same sale and the same tax as a $16.00 tax-included price.

The storefront tells the customer which it is: "Prices include 7.25% CA sales tax", or the tax shown
as its own line in the cart. Receipts and the order in the admin show the tax either way.

Because each order remembers its own mode, a reporting period that contains both kinds still adds up.

## What is taxed

A line of an order is taxed when **all** of these are true:

1. **The product is taxable.** Each product has a "taxable" setting (on by default). Turn it off for
   work that isn't taxable where you are. A custom line on a local sale or a quote chooses for
   itself, and so does a fee on a quote (setup, digitizing, art).
2. **Neither the shop nor the customer is tax-exempt** (below).
3. **The order is not shipped to another state.** An order with no shipping address — pickup, or
   one of a shop's own delivery options — counts as in your home state. If no home state is set,
   nothing counts as out of state.

Also:

- **Shipping and delivery fees are never taxed.**
- **A rush fee** is taxed only when Global settings → Rush orders → "Rush fee is taxable" is ticked
  (kept on each order as it was when the order was placed), and then like a taxable line: not for an
  exempt shop or customer, or an order shipped out of state. The tax is inside the fee when prices include tax, and
  added on top of it when tax is added on top.
- **A discount** reduces the tax in proportion to the taxable goods it was taken off.
- **Cancelled lines** carry no tax.
- **A refund** takes back its share of the tax, in the month it was refunded. You can say how much
  of a refund was shipping (which carried no tax). Money refunded for a cancelled line takes no tax
  back, because that line's tax is already gone: an order's refunds cover its cancelled lines first,
  and only what is refunded beyond them takes tax back.
- If you change an order — add or edit a line, change the discount, change the address — its tax is
  worked out again from **that order's own** rate and mode.

In the US, the ship-to state has to agree with the ZIP Code (the state decides the tax, so an
address can't claim another state to avoid it). See "ZIP Codes and states" in the README.

## Tax-exempt shops

A shop (a school, a charity, a government body) can be marked tax-exempt: Manage catalog → the shop
→ Edit → Sales tax. It needs the **certificate number**; an expiry date is optional, and the admin
warns you when it has passed. Orders for an exempt shop carry no tax, and the certificate details
are never sent to the storefront.

## Tax-exempt customers

One customer can be exempt in a shop that isn't: a church that orders from a team's shop, say.
Customers → the customer → **Tax exemption**: tick it, and enter the certificate number and, if the
certificate has one, the date it expires. Changing any of the three needs the full level of the
Customers permission ([operations.md](operations.md#users-and-roles)), and is written to the audit
log before it is saved.

An order carries no tax when you **picked** an exempt customer for it and they are exempt **on the
order's date**: the box is ticked, and the expiry date is empty or hasn't passed. An order dated
after the expiry is taxed like anyone else's, until you enter the new date.

Which customer an order belongs to is decided when it is placed:

- **A local sale** — the customer you picked in the Customer box. Their exemption applies. With none
  picked, as below.
- **Any other order** — the customer with the order's email address, for its history only. **The
  exemption does not apply**: an order placed on the storefront, or a sale where you only typed the
  email, is taxed as usual, because anyone can type an exempt customer's address. For an exempt
  customer, enter the sale yourself and pick them.
- An order with a phone number, or nothing, for its contact has no customer and is taxed as usual.

Things to know:

- It affects **new orders only**. Ticking the box doesn't take the tax off orders already placed,
  and unticking it doesn't add any.
- **Merging two customers doesn't carry the exemption over.** The customer you keep stays as it
  was — exempt or not — and the certificate on the one merged away is not copied. Enter it on the
  one you keep if it applies.
- A shop's exemption and a customer's are separate: either one makes the order exempt. They treat
  the expiry date differently: a customer's exemption stops on its own once the date has passed,
  while a shop's expiry date is only a reminder and the shop stays exempt until you untick it.
- The date an order is checked against is the day it was placed in the business's time zone
  (Global settings → Region).

## Quotes

A quote ([shops-and-domains.md](shops-and-domains.md#quotes)) shows its tax by the same rules as a
local sale for that customer: its product lines are taxable when the product is, its custom lines
and fees when you ticked them, and nothing is taxed when the shop or the customer is exempt. A
quote has no shipping address, so it counts as in your home state.

- **Until it is sent**, its tax follows the current settings.
- **Sending it keeps** the rate and whether prices include tax, as they were that moment (a rate of
  nothing when the shop or the customer was exempt). Changing the settings afterwards doesn't
  change a quote already sent; sending a revised one takes them again.
- **The order it becomes**, when it is accepted or converted, carries the quote's tax: a quote that
  was sent keeps the rate and mode it was sent with (and the exemptions as they were then), so the
  order and its invoice come to exactly the total the customer accepted, whatever the settings say
  that day. A quote converted while still a draft, or while waiting on changes, is taxed by the
  settings and exemptions of that day, as it shows them. After that the order is like any other:
  a delivery the customer chooses on the invoice can still change its tax (shipped out of state).
- Quotes aren't sales: they are not in the reports. The order is, from the month it was made.

## Fundraisers

A shop's fundraiser ([shops-and-domains.md](shops-and-domains.md#fundraising)) **doesn't change
the tax**. It is inside the price: the customer pays the same, the sale is the same amount, and the
tax on it is worked out exactly as without a fundraiser. What the group gets is part of your sale,
not a separate charge.

- A **percent** fundraiser is taken of the line's price **without** its tax: with prices that include
  tax, the tax is taken out of the price first; with tax added on top, the tax isn't counted.
- A **per piece** fundraiser is never more than the line before tax.
- **Paying the group** is recorded as an expense, in the built-in category "Fundraiser payouts"
  ([operations.md](operations.md#fundraising-the-report-and-payouts)), set up as a fully deductible
  "other expenses" category. It doesn't change the sales tax report. Whether that is right for you,
  or whether the group's share changes what you owe in your state, is a question for your
  accountant: the app only records it.

## Discount codes

A discount code ([operations.md](operations.md#discount-codes)) is an **order discount**, exactly like one
you type on an order: the tax is worked out as for any discount. Its share of the tax comes off with
it — the part of the discount that falls on taxable goods, in proportion — so with prices that include
tax the tax collected is less, and with tax added on top the tax added is less. It never comes off
shipping or the rush fee. The cart's tax estimate at checkout shrinks the same way; the order's real
figure is the server's.

## The reports

**Reports → Sales Tax Report**, for any range of months:

- The totals for the period: tax collected, tax refunded, use tax, and what is due.
- A month-by-month table laid out like a state sales and use tax return: gross sales, the amounts
  taken off for exempt shops and customers, out-of-state orders and non-taxable items, taxable sales, and tax.
- A breakdown by month, taxable or exempt, and ship-to state.

Things to know when reading it:

- It is on an **accrual basis**: an order counts in the month it was **placed**, paid or not.
- **Months are UTC months**, whatever your time zone (see "Region" in the README).
- Test orders and voided orders are left out.
- **Use tax**: an expense in a category marked "use-taxable", where you say the vendor did not
  charge sales tax, is counted as use tax owed at the current rate (Finance → Expenses, with the
  Bookkeeping feature on).

**Reports → Periods & Export** (Bookkeeping feature) produces the accountant's CSV files, which
include the sales tax collected and refunded per month.

## What it does not do

- Local (city or county) rates on top of the state rate.
- Collecting another state's tax on orders shipped there (destination-based tax).
- Taxed shipping.
- VAT or GST rules. Outside the US you still get one rate and one home region, nothing more.
- Filing anything. The report gives you the numbers to put on your return.
