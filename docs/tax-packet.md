# Tax packet

**Reports → Tax packet** (Bookkeeping feature) prints one document for your accountant, for any
date range: this year so far, a whole year, or last year. Tick the parts you want, then use
**Print / Save as PDF**. The print window can save it as a PDF. In the desktop program,
**Save PDF…** saves it directly. Your ticks are remembered on that computer.

Every figure comes from a report the admin already has: Expenses, Sales tax, Revenue, Inventory
and COGS, and the accountant's export (Periods & export). So the packet always agrees with those
screens. Test and voided orders are left out everywhere.

## The parts

| Part | What it shows |
|------|---------------|
| Cover page | Totals at a glance for the parts you ticked, how the figures are counted, and a checklist of other papers to bring |
| Expenses | Spending by Schedule C line (from each expense category's setup), then by category, then equipment to depreciate with its placed-in-service date, business use and the method you noted |
| Sales & use tax | The annual figures laid out like a state return, a table by month, purchases that owe use tax, and a **for review** list (below) |
| Revenue | Proposed Schedule C lines 1, 2 and 6, a table by month, and a cash view (money actually received) for comparison |
| Cost of goods sold | Schedule C Part III (lines 35–42) from the inventory roll-forward, inventory by group, a table by month, and warnings for estimated or missing costs |
| First-year decisions | A checklist of choices made on the first return (accounting method, start-up costs, depreciation, vehicle, home office, estimated tax and others), with space to write each decision |
| Owner money & start-up costs | Money the owner put in and took out by month, and expenses dated before the first sale (possible start-up costs, §195) |
| Money owed & 1099-K | Orders that still had a balance owing on the end date, and card payments, refunds and fees by month, to check against the 1099-K |
| Exempt sales & by state | Sales to tax-exempt customers, flagging any without a certificate on file (or with one that has expired), and sales by ship-to state |

## "Proposed"

Anything marked **proposed** is a suggestion for where an amount goes on the return. The
accountant decides where it actually goes:

- Card processing fees go on line 10 (commissions and fees), and postage bought in the app goes on
  line 27a. Neither is entered as an expense, so neither is in the Expenses report.
- Meals appear on line 24b at the 50% limit.
- Line 1 gross receipts is sales before tax plus shipping charged. Line 2 is refunds less the
  sales tax in them.
- Line 39 holds the stock-count corrections.

## Use tax: the "for review" list

Blanks bought tax-free for resale but then used by the shop itself may owe use tax on their cost.
The packet lists them for the accountant to decide:

- resale blanks written off for testing or "other" (damaged and lost stock wasn't used, so it isn't listed)
- blanks kept for testing or shop use that were bought without tax
- written-off transfer sheets, whose reason isn't recorded

The list is **not** added to the use tax that the Sales tax report or the packet show as due.

## Money owed at the end date

An order counts as owing when it was placed by the end date and payments received by then are less
than what it comes to now. Refunds don't count against it: money given back isn't money the customer
still owes. The figures come from `getTaxPacketExtras` (functions/_lib/db.js), the one action the
packet adds.
