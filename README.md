# Ledgerline

An inventory ledger and financial reporting system where history stays consistent and auditable.
Every stock movement and every euro is one balanced, hash-chained journal entry that is never
edited or deleted after posting.

![stack](https://img.shields.io/badge/Next.js-16-black) ![stack](https://img.shields.io/badge/SQLite-node%3Asqlite-blue) ![tests](https://img.shields.io/badge/tests-node%3Atest-green)

## Quick start

```bash
npm install
npm run seed     # 4 months of demo history for a coffee wholesaler (earlier months already closed)
npm run dev      # http://localhost:3700
npm test         # ledger engine tests
```

Requires Node 24+ (uses the built-in `node:sqlite`, so there is no database server to run).
Data lives in `data/ledger.db`. Set `LEDGER_DB` to use another file.

## What you can do

| Page | Purpose |
| --- | --- |
| **Overview** | KPIs, inventory and cash trend, revenue vs. cost of sales, live integrity status |
| **Inventory** | Stock per warehouse at moving-average cost; per-item stock card with running balances |
| **Journal** | Every entry in posting order; each one shows its GL lines, stock moves and hash link |
| **New transaction** | Receive, sell, transfer, adjust and cash movements, with a live double-entry preview |
| **Reports** | Income statement, balance sheet, trial balance and inventory valuation for any date, and "as known at" any moment |
| **Periods** | Close months in order; each close seals a SHA-256 snapshot |
| **Integrity** | Eight independent checks that recompute everything from raw rows |
| **Audit log** | Period closes, reversals, item creation and rejected posting attempts |

## How consistency is guaranteed

1. **Append-only at the database level.** Triggers abort `UPDATE` and `DELETE` on `journals`,
   `journal_lines`, `stock_moves`, `period_closes` and `audit_events`, whatever the client.
2. **One event, one atomic journal.** GL lines and stock moves are written in a single
   `BEGIN IMMEDIATE` transaction. If any rule fails, nothing is written.
3. **Double entry with a reconciled sub-ledger.** Debits equal credits, and the Inventory control
   account's movement equals the sum of the journal's stock-move values, checked on every posting.
4. **Immutable costing.** Moving-average cost in integer cents. Each stock move stores the position
   it produced (`qty_after`, `value_after`). Selling the last unit takes the exact remaining value,
   so rounding never drifts. Posting before an item's latest movement is refused, so already-posted
   costs never have to be recalculated.
5. **Corrections by reversal.** A reversal mirrors the original, links to it (`reverses_id`, unique)
   and is dated in an open period. If average cost has moved since, the difference goes to
   *Inventory cost variance*.
6. **Period close.** Months close strictly in order. Closed months accept no postings. The sealed
   snapshot of all account totals and stock positions is recomputed on every integrity run.
7. **Tamper evidence.** `hash = SHA-256(prev_hash | canonical content)` per journal. Changing any
   historical row through raw SQL breaks the chain from that point on.
8. **Idempotency.** Each submit carries a key (unique in the database), so retries post exactly once.
9. **Bitemporal reporting.** Every report takes an accounting date (`asOf`) and a posting cut-off
   (`knownAt`). Posting time is monotonic and positions are prefix-ordered, so a report can be
   reproduced exactly as it was issued, even after late entries.

## Project layout

```
lib/ledger.ts      posting engine: validation, costing, hash chain, reversals, period close
lib/integrity.ts   independent verifier (8 checks)
lib/reports.ts     read models: TB, P&L, balance sheet, valuation, stock card, dashboard
lib/db.ts          schema, append-only triggers, connection
lib/actions.ts     Next.js server actions (thin layer over the engine)
app/               pages (App Router, server components)
components/        UI: forms, charts, design primitives
scripts/seed.ts    demo history generated through the real engine
tests/             node:test suite for the engine
```

## Notes

- This is a demo with no authentication. Actions are attributed to "Demo user" in the audit trail.
- The currency is EUR, and all amounts are stored as integer cents.
