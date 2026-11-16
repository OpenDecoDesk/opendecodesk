# Scale test

How the admin's order operations slow down as a shop's order history grows. It runs against the
**desktop program**: the real server from `desktop/server.js` (Miniflare → workerd → the Worker),
its SQLite file, and no Electron window. Nothing is sent to Cloudflare, so a run costs nothing.

```bash
npm run perf                                   # 1k → 5k → 25k → 100k → 250k orders, about 15–40 minutes
npm run perf -- --max 25000 --runs 2           # a quicker ladder
npm run perf -- --tiers 1000,5000 --only open-orders,orders-30d
npm run perf -- --max 1000000                  # adds 500k and 1M steps (hours, several GB)
npm run perf -- --keep-data                    # keep the database, for the profiler
npm run perf:profile -- --data <folder>        # where the time goes, query by query
npm run perf -- --compare perf/results/<run>/results.json    # after a fix: this run ÷ that one
```

The output goes to `perf/results/<date>-<commit>/`:
- `report.html`: charts, findings and every timing
- `results.json`: the raw numbers

That folder is git-ignored. The databases go to `~/Library/Caches/opendecodesk-perf` on a Mac, or to the temp folder elsewhere, and are deleted at the end unless you pass `--keep-data`. Change the location with `--data-root`, but **never use a synced folder** such as iCloud's `~/Documents`. A synced SQLite file gets "database is locked" errors, and the sync uploads gigabytes.

`npm test` does not run this; it takes too long. `test188_perf_cloner.js` does run there and checks the part most likely to break: the cloner, after a migration.

## How the data is made

1. **Templates.** Through the real admin API, the run creates 3 invented shops, two blanks, 60 products, and 42 orders. It takes those orders through what a working shop does to them:
   - paid in full or in part, or left unpaid
   - each stage, from blank ordered to delivered
   - completed, refunded or voided
   - PDFs, invoices and customer edits
2. **Copies.** `perf/lib/clone.js` copies template orders straight into the SQLite file, with the server stopped. Every row that hangs off an order is copied with it:
   - **What's copied:** lines, payments, stock movements, audit entries, and so on.
   - **What changes:** each copy gets a new order ID and an invented customer at example.com. Every date moves by the same amount, so a copy keeps the shape of its template at a new date.
   - **How columns are found:** from the schema itself, so new columns and order-linked tables are picked up.
3. **Growth.** Orders arrive at a steady 25 a day across the 3 shops, and each step extends the history further back:
   - Recent orders are still being worked on; older ones are finished.
   - About 4% are refunded or voided, and 1% are test sales.
   - The last 30 days and the open orders therefore stay about the same size at every step.
   - The catalog grows too (up to 700 products per shop), since some screens read it whole.
4. **Checks at each step.** `PRAGMA quick_check`, `PRAGMA foreign_key_check`, and three copies read back through `getOrders` must match their templates' totals, lines and states.

## What is timed

Every operation is the same request `public/admin.js` sends to `/api/orders`. Each is run once to warm up and then 5 times; the report keeps the median, p95, answer size and row count. The list and the limits are in `perf/lib/ops.js`:

| Group | Limit (p95) | Judged up to |
|---|---|---|
| Screens people wait on: order lists, open orders, queues, PDFs, audit log | 1 s | 25k orders |
| Single changes: new sale, payment, stage, customer edit | 1 s | 25k orders |
| Bulk changes: stage on 100 orders; complete or reopen 500 | 10 s | 25k orders |
| Reports: revenue, sales tax, accountant export | 5 s | 100k orders |
| Whole history: order list with no dates, all-time revenue | none | |

**How writes are kept separate.** Writes run on a work pool of recent orders, cloned in just for them. The database is copied aside first, which is the same copy File → Back up makes, and that copy is timed. Afterwards the database is put back, so the writes don't change the next step.

**Program-level numbers.** Each step also records:
- the time to start the program on that database
- the database file size
- peak memory of the workerd process

## Reading the report

- **Growth** is the slope of log(time) against log(orders): about 0 is flat, 1 grows in step with the history, and above 1.2 is flagged.
- **A fixed window that slows down** is the clearest kind of problem. This is a 30-day list, open orders or a queue whose answer stays the same size while it takes longer: it reads more than its window.
- **Where the time goes** comes from `npm run perf:profile`. It runs the same requests through the app's handler code on Node's own SQLite against a copy of the kept database, timing every statement, and shows each statement's call count and query plan. A full table scan is marked.
