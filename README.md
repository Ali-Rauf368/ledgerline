# Ledgerline

An inventory ledger and financial reporting system where history stays consistent and auditable.
Every stock movement and every euro is one balanced, hash-chained journal entry that is never
edited or deleted after posting.

![stack](https://img.shields.io/badge/Next.js-16-black) ![stack](https://img.shields.io/badge/SQLite-node%3Asqlite-blue) ![tests](https://img.shields.io/badge/tests-node%3Atest-green)

## Run with Docker

```bash
docker compose up -d --build        # http://localhost:3700
```

On first start the container seeds a demo company (set `LEDGERLINE_DEMO=0` to start empty and
create an admin with `docker compose exec app node scripts/create-admin.ts you@x.com "Your Name" 'password'`).
Data lives in the `ledger-data` volume. Pass `ANTHROPIC_API_KEY` to enable the full AI features.
`GET /api/health` is the health check. Any container host works (Fly.io, Render, Railway, a VPS):
mount a persistent volume at `/app/data` and serve over HTTPS.

## Demo accounts

All use the password `demo1234`. The sign-in page has one-click buttons.

| Account | Role | Can |
| --- | --- | --- |
| admin@ledgerline.demo | Administrator | everything, including users & roles |
| anna@ledgerline.demo / tom@ledgerline.demo | Accountant | post, reverse, approve (not their own requests), bank, budgets |
| wes@ledgerline.demo | Warehouse | receive goods, transfers, adjustments, purchase orders |
| vic@ledgerline.demo | Viewer | read-only: reports, insights, Copilot |

Try: sign in as **Tom** and approve Anna's pending sale and period close; as **Anna**, import the demo
bank statement on *Bank reconciliation* and book the two unmatched lines.

## Quick start (without Docker)

```bash
npm install
npm run seed     # 13 months of demo history: VAT, USD invoices, a closed fiscal year, budgets, planted anomalies
npm run dev      # http://localhost:3700
npm test         # ledger engine tests
```

Requires Node 24+ (uses the built-in `node:sqlite`, so there is no database server to run).
Data lives in `data/ledger.db`. Set `LEDGER_DB` to use another file.

### Enable the AI assistant (optional)

```bash
cp .env.example .env.local   # then paste your key: ANTHROPIC_API_KEY=sk-ant-...
```

Without a key, Copilot still works in **offline mode**, answering common questions (reorder,
revenue, cash, integrity, reversals) from the same data.

## What you can do

| Page | Purpose |
| --- | --- |
| **Overview** | KPIs, inventory and cash trend, revenue vs. cost of sales, live integrity status |
| **Inventory** | Stock per warehouse at moving-average cost; per-item stock card with running balances |
| **Journal** | Every entry in posting order; each one shows its GL lines, stock moves and hash link |
| **New transaction** | Receive, sell, transfer, adjust and cash movements, with a live double-entry preview |
| **Reports** | Income statement, balance sheet, trial balance, inventory valuation, VAT return, FX and FIFO comparison, for any date and "as known at" any moment |
| **Insights** | Anomalies, demand and cash forecasts, AI month-end commentary |
| **Budgets** | Monthly budgets with versioned edits and variance analysis |
| **Periods** | Close months in order; each close seals a SHA-256 snapshot |
| **Integrity** | Ten independent checks that recompute everything from raw rows |
| **Audit log** | Period closes, reversals, item creation and rejected posting attempts |

### Users, control and operations

- **Sign-in and roles:** scrypt password hashes, HTTP-only session cookies (only a SHA-256 of the token is
  stored), login throttling and four roles with per-action permissions enforced on the server.
  Every journal records **who posted it** inside its hash.
- **Four-eyes approvals:** postings of €5,000 or more and every period close are queued until a *different*
  user with approval rights signs off. The journal stores the requester and the approver.
- **Customers & suppliers:** payment terms set invoice due dates. Payments are applied to the oldest
  invoices first (or to chosen ones), with **AR/AP ageing** (current, 1–30, 31–60, 61–90, 90+ days). A new
  integrity check proves AR and AP equal the open items.
- **Purchase & sales orders:** commitments that are received or delivered in parts. Over-delivery is
  refused, reversals reopen quantities, and cancelling closes the rest.
- **Bank reconciliation:** import a CSV (German *Buchungstag/Betrag/Saldo* or international). Lines are
  auto-matched by amount, date and payee; unknown lines (fees, unannounced payments) get suggestions and
  are booked in one click; a reconciliation proof shows the difference, which must be €0.00. Imports are
  content-hashed (no double import) and matches are an append-only event log.

### Advanced accounting

- **VAT:** per-line rates (7% coffee, 19% other goods). Input VAT (1400) and output VAT (2100) are
  posted automatically; a one-click **Settle VAT** clears both exactly against the bank. VAT return report.
- **Multi-currency purchases:** USD, GBP, CHF and JPY invoices are converted with exact integer
  arithmetic. The foreign amount and rate are stored on the journal. Paying later at a new rate posts a
  **realised FX gain or loss** (4900/6900).
- **Year-end close:** closing December automatically posts a closing entry that moves the year's
  profit into **retained earnings** (3100). The P&L excludes it; an integrity check verifies that every
  closed year has a zero P&L.
- **Budgets vs actuals:** monthly budgets per account, versioned (append-only), with variance analysis.
- **FIFO comparison:** replays history through FIFO layers to show inventory and COGS under FIFO
  next to the ledger's moving-average policy.

### Productivity and AI

- **Ledger Copilot (⌘J):** a chat assistant built on Claude (`claude-opus-5-5`) with nine **read-only**
  tools: overview, inventory, reorder analysis, stock card, P&L, balance sheet, journal search,
  journal detail and integrity check. It looks up real figures, links journal ids, and shows which
  tools it used. It cannot post or change anything, so ledger integrity never depends on the model.
- **Copilot drafts transactions:** "sell 3 ETH-YRG-1K to Café Kranich at 26.90" produces a
  *Review & post* button that opens a pre-filled form. A human always posts; the AI never writes to the ledger.
- **Anomaly detection (Insights):** robust statistics flag purchase-cost spikes, below-cost and thin-margin
  sales, large write-offs, unusually large entries, late postings and possible duplicates, each with
  the reason and a link to the entry.
- **Forecasts:** a 30-day demand forecast per item (exponential smoothing with weekday seasonality,
  80% ranges, stock-out dates, back-tested accuracy) and a 30-day cash projection with a confidence band
  and scheduled VAT payments.
- **AI month-end commentary:** Claude writes a management briefing from ledger facts. Each version is
  stored append-only with a hash of the data it was based on; without a key, a template fills in.
- **Command palette (⌘K):** jump to any page, item or journal (`#123`), run actions, or send the
  query straight to Copilot.
- **Smart reorder:** days of cover from 30-day sales velocity, with suggested order quantities.
- **CSV export:** every report (respecting the as-of and known-at filters) and the full journal with hashes.
  Cells are protected against spreadsheet formula injection.

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
lib/actions.ts     Next.js server actions: permission checks, approvals, then the engine
lib/auth.ts        users, password hashing, sessions, roles & permissions
lib/approvals.ts   four-eyes approval queue
lib/bank.ts        statement import, matching, reconciliation
proxy.ts           redirects signed-out requests to /login
lib/assistant.ts   Ledger Copilot: Claude tool loop, drafts, month-end commentary, offline fallback
lib/analytics.ts   anomaly detection, demand and cash forecasting
lib/draft.ts       AI transaction drafts (pre-fill only)
app/api/export     CSV export route
app/               pages (App Router, server components)
components/        UI: forms, charts, design primitives
scripts/seed.ts    demo history generated through the real engine
tests/             node:test suite for the engine
```

## Notes

- Demo credentials are public; for a real deployment set `LEDGERLINE_DEMO=0`, create your own admin,
  and serve over HTTPS.
- The currency is EUR, and all amounts are stored as integer cents.

> **Upgrading from an earlier version:** the schema is now v3. Run `npm run seed` to rebuild the demo
> database; the app shows a clear message if it finds an older database.
