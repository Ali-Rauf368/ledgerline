/**
 * Read models. Every report accepts two time axes:
 *   asOf    – the accounting date (doc_date) the report is "as at"
 *   knownAt – the posting timestamp cut-off: "what did this report say at that moment?"
 * Because the ledger is append-only and posting time is monotonic, both are exact.
 */
import type { DB } from "./db.ts";
import { all, get } from "./db.ts";
import { ACC, COST_OF_SALES, OTHER_PNL, isDebitNormal } from "./accounts.ts";
import type { AccountType, JournalKind } from "./accounts.ts";
import { lockedThrough, monthEnd, nextClosablePeriod, nextMonth, openInvoices, today } from "./ledger.ts";

const MIN_DATE = "0000-01-01";
const MAX_DATE = "9999-12-31";
const MAX_TS = "9999-12-31T23:59:59.999Z";

export type Filter = { from?: string; asOf?: string; knownAt?: string; excludeClosing?: boolean };

export type AccountRow = { code: string; name: string; type: AccountType; debit: number; credit: number; balance: number };

export function accountActivity(db: DB, f: Filter = {}): AccountRow[] {
  const rows = all<Omit<AccountRow, "balance">>(
    db,
    `SELECT a.code, a.name, a.type, COALESCE(s.debit, 0) debit, COALESCE(s.credit, 0) credit
     FROM accounts a LEFT JOIN (
       SELECT l.account_code, SUM(l.debit) debit, SUM(l.credit) credit
       FROM journal_lines l JOIN journals j ON j.id = l.journal_id
       WHERE j.doc_date >= ? AND j.doc_date <= ? AND j.posted_at <= ? AND (? = 0 OR j.kind <> 'CLOSING')
       GROUP BY l.account_code
     ) s ON s.account_code = a.code
     ORDER BY a.code`,
    f.from ?? MIN_DATE,
    f.asOf ?? MAX_DATE,
    f.knownAt ?? MAX_TS,
    f.excludeClosing ? 1 : 0,
  );
  return rows.map((r) => ({ ...r, balance: isDebitNormal(r.type) ? r.debit - r.credit : r.credit - r.debit }));
}

export function trialBalance(db: DB, f: Filter = {}) {
  const rows = accountActivity(db, { asOf: f.asOf, knownAt: f.knownAt });
  const totals = rows.reduce(
    (t, r) => {
      const net = r.debit - r.credit;
      if (net > 0) t.debit += net;
      else t.credit -= net;
      return t;
    },
    { debit: 0, credit: 0 },
  );
  return { rows, totals, balanced: totals.debit === totals.credit };
}

/** Year-end closing entries are excluded: they move profit to equity and are not performance. */
export function incomeStatement(db: DB, f: Filter = {}) {
  const rows = accountActivity(db, { ...f, excludeClosing: true });
  const revenue = rows.filter((r) => r.type === "REVENUE" && !OTHER_PNL.includes(r.code));
  const costOfSales = rows.filter((r) => COST_OF_SALES.includes(r.code));
  const opex = rows.filter((r) => r.type === "EXPENSE" && !COST_OF_SALES.includes(r.code) && !OTHER_PNL.includes(r.code));
  const other = rows.filter((r) => OTHER_PNL.includes(r.code));
  const sum = (xs: AccountRow[]) => xs.reduce((s, r) => s + r.balance, 0);
  const totalRevenue = sum(revenue);
  const grossProfit = totalRevenue - sum(costOfSales);
  const operatingIncome = grossProfit - sum(opex);
  const otherNet = other.reduce((s, r) => s + (r.type === "REVENUE" ? r.balance : -r.balance), 0);
  return {
    revenue,
    costOfSales,
    opex,
    other: other.map((r) => ({ ...r, balance: r.type === "REVENUE" ? r.balance : -r.balance })),
    totalRevenue,
    totalCostOfSales: sum(costOfSales),
    totalOpex: sum(opex),
    grossProfit,
    grossMargin: totalRevenue ? grossProfit / totalRevenue : 0,
    operatingIncome,
    otherNet,
    netIncome: operatingIncome + otherNet,
  };
}

export function balanceSheet(db: DB, f: Filter = {}) {
  const rows = accountActivity(db, { asOf: f.asOf, knownAt: f.knownAt });
  const by = (t: AccountType) => rows.filter((r) => r.type === t);
  const sum = (xs: { balance: number }[]) => xs.reduce((s, r) => s + r.balance, 0);
  const netIncome = sum(by("REVENUE")) - sum(by("EXPENSE"));
  const equity = [...by("EQUITY"), { code: "—", name: "Current-year earnings", type: "EQUITY" as const, debit: 0, credit: 0, balance: netIncome }];
  const totalAssets = sum(by("ASSET"));
  const totalLiabilities = sum(by("LIABILITY"));
  const totalEquity = sum(equity);
  return {
    assets: by("ASSET"),
    liabilities: by("LIABILITY"),
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

export type PositionRow = {
  item_id: number;
  sku: string;
  name: string;
  category: string;
  unit: string;
  warehouse_id: number;
  wh_code: string;
  wh_name: string;
  qty: number;
  value: number;
};

/** Stock positions at a point in time. Running balances are stored on each move, so this is one lookup per position. */
export function positions(db: DB, f: Filter = {}): PositionRow[] {
  return all<PositionRow>(
    db,
    `SELECT i.id item_id, i.sku, i.name, i.category, i.unit, w.id warehouse_id, w.code wh_code, w.name wh_name,
            m.qty_after qty, m.value_after value
     FROM stock_moves m JOIN items i ON i.id = m.item_id JOIN warehouses w ON w.id = m.warehouse_id
     WHERE m.id IN (
       SELECT MAX(m2.id) FROM stock_moves m2 JOIN journals j2 ON j2.id = m2.journal_id
       WHERE m2.doc_date <= ? AND j2.posted_at <= ?
       GROUP BY m2.item_id, m2.warehouse_id)
     ORDER BY i.sku, w.code`,
    f.asOf ?? MAX_DATE,
    f.knownAt ?? MAX_TS,
  );
}

export function inventoryValuation(db: DB, f: Filter = {}) {
  const rows = positions(db, f).filter((r) => r.qty > 0);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const gl = accountActivity(db, f).find((r) => r.code === ACC.INV)!.balance;
  return { rows, total, gl, reconciled: total === gl };
}

export type ItemSummary = {
  id: number;
  sku: string;
  name: string;
  category: string;
  unit: string;
  qty: number;
  value: number;
  byWarehouse: Record<number, { qty: number; value: number }>;
};

export function itemsOverview(db: DB): ItemSummary[] {
  const items = all<{ id: number; sku: string; name: string; category: string; unit: string }>(db, "SELECT * FROM items ORDER BY sku");
  const pos = positions(db);
  return items.map((i) => {
    const mine = pos.filter((p) => p.item_id === i.id);
    return {
      ...i,
      qty: mine.reduce((s, p) => s + p.qty, 0),
      value: mine.reduce((s, p) => s + p.value, 0),
      byWarehouse: Object.fromEntries(mine.map((p) => [p.warehouse_id, { qty: p.qty, value: p.value }])),
    };
  });
}

export const warehouses = (db: DB) => all<{ id: number; code: string; name: string }>(db, "SELECT * FROM warehouses ORDER BY id");

export function stockCard(db: DB, itemId: number) {
  return all<{
    id: number;
    journal_id: number;
    doc_date: string;
    qty: number;
    value: number;
    qty_after: number;
    value_after: number;
    kind: JournalKind;
    memo: string;
    counterparty: string;
    posted_at: string;
    wh_code: string;
  }>(
    db,
    `SELECT m.id, m.journal_id, m.doc_date, m.qty, m.value, m.qty_after, m.value_after,
            j.kind, j.memo, j.counterparty, j.posted_at, w.code wh_code
     FROM stock_moves m JOIN journals j ON j.id = m.journal_id JOIN warehouses w ON w.id = m.warehouse_id
     WHERE m.item_id = ? ORDER BY m.id DESC`,
    itemId,
  );
}

export type JournalListRow = {
  id: number;
  kind: JournalKind;
  doc_date: string;
  posted_at: string;
  memo: string;
  reference: string;
  counterparty: string;
  reverses_id: number | null;
  hash: string;
  amount: number;
  units: number;
  reversed_by: number | null;
};

export function journalsList(db: DB, o: { kind?: string; limit?: number; q?: string } = {}) {
  const q = o.q?.trim() ? `%${o.q.trim()}%` : null;
  return all<JournalListRow>(
    db,
    `SELECT j.id, j.kind, j.doc_date, j.posted_at, j.memo, j.reference, j.counterparty, j.reverses_id, j.hash,
       MAX(COALESCE((SELECT SUM(debit) FROM journal_lines WHERE journal_id = j.id), 0),
           COALESCE((SELECT SUM(value) FROM stock_moves WHERE journal_id = j.id AND value > 0), 0)) amount,
       COALESCE((SELECT SUM(ABS(qty)) FROM stock_moves WHERE journal_id = j.id), 0) units,
       (SELECT r.id FROM journals r WHERE r.reverses_id = j.id) reversed_by
     FROM journals j
     WHERE (? IS NULL OR j.kind = ?)
       AND (? IS NULL OR j.memo LIKE ? OR j.counterparty LIKE ? OR j.reference LIKE ? OR CAST(j.id AS TEXT) = ?)
     ORDER BY j.id DESC LIMIT ?`,
    o.kind ?? null, o.kind ?? null, q, q, q, q, o.q?.trim().replace("#", "") ?? null, o.limit ?? 200,
  );
}

export function journalDetail(db: DB, id: number) {
  const j = get<JournalListRow & { prev_hash: string; idempotency_key: string | null }>(
    db,
    `SELECT j.*, (SELECT r.id FROM journals r WHERE r.reverses_id = j.id) reversed_by FROM journals j WHERE j.id = ?`,
    id,
  );
  if (!j) return null;
  const lines = all<{ account_code: string; name: string; debit: number; credit: number }>(
    db,
    "SELECT l.account_code, a.name, l.debit, l.credit FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE l.journal_id = ? ORDER BY l.id",
    id,
  );
  const moves = all<{ item_id: number; sku: string; name: string; wh_code: string; qty: number; value: number; qty_after: number; value_after: number }>(
    db,
    `SELECT m.item_id, i.sku, i.name, w.code wh_code, m.qty, m.value, m.qty_after, m.value_after
     FROM stock_moves m JOIN items i ON i.id = m.item_id JOIN warehouses w ON w.id = m.warehouse_id
     WHERE m.journal_id = ? ORDER BY m.id`,
    id,
  );
  const lock = lockedThrough(db);
  return { journal: j, lines, moves, lockedPeriod: !!lock && j.doc_date.slice(0, 7) <= lock };
}

export function chainHead(db: DB) {
  return get<{ id: number; hash: string; posted_at: string }>(db, "SELECT id, hash, posted_at FROM journals ORDER BY id DESC LIMIT 1") ?? null;
}

function monthsBetween(first: string, last: string) {
  const out: string[] = [];
  for (let m = first; m <= last; m = nextMonth(m)) out.push(m);
  return out;
}

export function monthly(db: DB) {
  const first = get<{ d: string | null }>(db, "SELECT MIN(doc_date) d FROM journals")?.d;
  if (!first) return [];
  const rows = all<{ m: string; code: string; dr: number; cr: number }>(
    db,
    `SELECT substr(j.doc_date, 1, 7) m, l.account_code code, SUM(l.debit) dr, SUM(l.credit) cr
     FROM journal_lines l JOIN journals j ON j.id = l.journal_id WHERE j.kind <> 'CLOSING' GROUP BY m, code`,
  );
  return monthsBetween(first.slice(0, 7), today().slice(0, 7)).map((m) => {
    const r = (code: string) => rows.find((x) => x.m === m && x.code === code);
    const revenue = (r(ACC.REVENUE)?.cr ?? 0) - (r(ACC.REVENUE)?.dr ?? 0);
    const cogs = COST_OF_SALES.reduce((s, c) => s + (r(c)?.dr ?? 0) - (r(c)?.cr ?? 0), 0);
    return { month: m, revenue, cogs, grossProfit: revenue - cogs };
  });
}

/** Daily closing balance of the given accounts (debit-positive), for trend charts. */
export function dailyBalances(db: DB, codes: string[], days: number) {
  const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const opening = Object.fromEntries(
    codes.map((c) => [
      c,
      get<{ b: number }>(
        db,
        "SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM journal_lines l JOIN journals j ON j.id = l.journal_id WHERE l.account_code = ? AND j.doc_date < ?",
        c,
        start,
      )!.b,
    ]),
  );
  const deltas = all<{ d: string; code: string; net: number }>(
    db,
    `SELECT j.doc_date d, l.account_code code, SUM(l.debit - l.credit) net
     FROM journal_lines l JOIN journals j ON j.id = l.journal_id
     WHERE j.doc_date >= ? GROUP BY d, code`,
    start,
  );
  const out: ({ date: string } & Record<string, number | string>)[] = [];
  const running = { ...opening };
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    for (const c of codes) running[c] += deltas.find((x) => x.d === date && x.code === c)?.net ?? 0;
    out.push({ date, ...running });
  }
  return out;
}

export function dashboard(db: DB) {
  const bal = (code: string) => get<{ b: number }>(db, "SELECT COALESCE(SUM(debit - credit), 0) b FROM journal_lines WHERE account_code = ?", code)!.b;
  const thisMonth = today().slice(0, 7);
  const months = monthly(db);
  const cur = months.find((m) => m.month === thisMonth) ?? { revenue: 0, cogs: 0, grossProfit: 0 };
  const prev = months[months.length - 2] ?? { revenue: 0, cogs: 0, grossProfit: 0 };
  const items = itemsOverview(db);
  return {
    inventory: bal(ACC.INV),
    cash: bal(ACC.CASH),
    receivables: bal(ACC.AR),
    payables: -bal(ACC.AP),
    revenueThisMonth: cur.revenue,
    revenueLastMonth: prev.revenue,
    marginThisMonth: cur.revenue ? cur.grossProfit / cur.revenue : 0,
    marginLastMonth: prev.revenue ? prev.grossProfit / prev.revenue : 0,
    units: items.reduce((s, i) => s + i.qty, 0),
    items,
    months,
    journalCount: get<{ n: number }>(db, "SELECT COUNT(*) n FROM journals")!.n,
  };
}

export function periodsOverview(db: DB) {
  const first = get<{ d: string | null }>(db, "SELECT MIN(doc_date) d FROM journals")?.d;
  const closes = all<{ period: string; closed_at: string; closed_by: string; last_journal_id: number; snapshot_hash: string }>(
    db,
    "SELECT period, closed_at, closed_by, last_journal_id, snapshot_hash FROM period_closes",
  );
  const counts = all<{ m: string; n: number }>(db, "SELECT substr(doc_date, 1, 7) m, COUNT(*) n FROM journals GROUP BY m");
  const closable = nextClosablePeriod(db);
  const cur = today().slice(0, 7);
  return monthsBetween(first ? first.slice(0, 7) : cur, cur)
    .reverse()
    .map((m) => {
      const close = closes.find((c) => c.period === m) ?? null;
      const pl = incomeStatement(db, { from: `${m}-01`, asOf: monthEnd(m) });
      return {
        period: m,
        end: monthEnd(m),
        journals: counts.find((c) => c.m === m)?.n ?? 0,
        revenue: pl.totalRevenue,
        netIncome: pl.netIncome,
        close,
        status: close ? ("closed" as const) : m === closable ? ("closable" as const) : m === cur ? ("current" as const) : ("open" as const),
      };
    });
}

export const auditEvents = (db: DB) =>
  all<{ id: number; at: string; actor: string; action: string; detail: string }>(db, "SELECT * FROM audit_events ORDER BY id DESC LIMIT 300");

export type ReorderRow = {
  id: number;
  sku: string;
  name: string;
  unit: string;
  qty: number;
  value: number;
  sold30: number;
  perDay: number;
  daysCover: number | null;
  suggested: number;
  status: "critical" | "low" | "healthy" | "slow";
};

/**
 * Demand-driven replenishment: 30-day sales velocity → days of cover.
 * Target: cover lead time (7 days) + 3 weeks of safety/cycle stock.
 */
export function reorderInsights(db: DB, o: { leadDays?: number; targetDays?: number } = {}): ReorderRow[] {
  const lead = o.leadDays ?? 7;
  const target = o.targetDays ?? 28;
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const sold = all<{ item_id: number; units: number }>(
    db,
    `SELECT m.item_id, -SUM(m.qty) units FROM stock_moves m JOIN journals j ON j.id = m.journal_id
     WHERE j.kind = 'SALE' AND m.doc_date >= ? GROUP BY m.item_id`,
    since,
  );
  const reversed = all<{ item_id: number; units: number }>(
    db,
    `SELECT m.item_id, SUM(m.qty) units FROM stock_moves m JOIN journals j ON j.id = m.journal_id
     JOIN journals o ON o.id = j.reverses_id
     WHERE j.kind = 'REVERSAL' AND o.kind = 'SALE' AND m.doc_date >= ? GROUP BY m.item_id`,
    since,
  );
  return itemsOverview(db)
    .map((i) => {
      const sold30 = Math.max(0, (sold.find((s) => s.item_id === i.id)?.units ?? 0) - (reversed.find((s) => s.item_id === i.id)?.units ?? 0));
      const perDay = sold30 / 30;
      const daysCover = perDay > 0 ? i.qty / perDay : null;
      const suggested = perDay > 0 ? Math.max(0, Math.ceil(perDay * target - i.qty)) : 0;
      const status: ReorderRow["status"] =
        daysCover === null ? "slow" : daysCover < lead ? "critical" : daysCover < lead * 2 ? "low" : "healthy";
      return { id: i.id, sku: i.sku, name: i.name, unit: i.unit, qty: i.qty, value: i.value, sold30, perDay, daysCover, suggested, status };
    })
    .sort((a, b) => (a.daysCover ?? Infinity) - (b.daysCover ?? Infinity));
}

// ───────────────────────── VAT ─────────────────────────

/** VAT return for a date range: output VAT on sales, input VAT on purchases, and settlements paid. */
export function vatReport(db: DB, f: { from: string; asOf: string }) {
  const sumWhere = (code: string, kindClause: string, sign: 1 | -1) =>
    get<{ v: number }>(
      db,
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) v FROM journal_lines l JOIN journals j ON j.id = l.journal_id
       WHERE l.account_code = ? AND j.doc_date BETWEEN ? AND ? AND ${kindClause}`,
      code,
      f.from,
      f.asOf,
    )!.v * sign;
  // A VAT settlement is a PAYMENT that touches both VAT accounts; everything else is a taxable transaction.
  const notSettlement = `NOT (j.kind = 'PAYMENT' AND EXISTS (SELECT 1 FROM journal_lines x WHERE x.journal_id = j.id AND x.account_code = '${ACC.VAT_OUT}'))`;
  const output = sumWhere(ACC.VAT_OUT, notSettlement, -1);
  const input = sumWhere(ACC.VAT_IN, notSettlement, 1);
  const settlements = all<{ id: number; doc_date: string; amount: number }>(
    db,
    `SELECT j.id, j.doc_date, COALESCE((SELECT SUM(credit - debit) FROM journal_lines WHERE journal_id = j.id AND account_code = ?), 0) amount
     FROM journals j WHERE j.kind = 'PAYMENT' AND j.doc_date BETWEEN ? AND ?
       AND EXISTS (SELECT 1 FROM journal_lines x WHERE x.journal_id = j.id AND x.account_code = ?)
     ORDER BY j.id`,
    ACC.CASH,
    f.from,
    f.asOf,
    ACC.VAT_OUT,
  );
  const taxableSales = -get<{ v: number }>(
    db,
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) v FROM journal_lines l JOIN journals j ON j.id = l.journal_id
     WHERE l.account_code = ? AND j.doc_date BETWEEN ? AND ? AND j.kind <> 'CLOSING'`,
    ACC.REVENUE,
    f.from,
    f.asOf,
  )!.v;
  const bal = accountActivity(db, { asOf: f.asOf });
  const outstanding = bal.find((a) => a.code === ACC.VAT_OUT)!.balance - bal.find((a) => a.code === ACC.VAT_IN)!.balance;
  return { output, input, net: output - input, settlements, taxableSales, effectiveRate: taxableSales ? output / taxableSales : 0, outstanding };
}

// ───────────────────────── FX ─────────────────────────

export function fxActivity(db: DB) {
  const settled = all<{ id: number; doc_date: string; counterparty: string; currency: string; fx_rate: string; foreign_amount: number; settles_id: number; booked_rate: string; gain: number }>(
    db,
    `SELECT s.id, s.doc_date, s.counterparty, s.currency, s.fx_rate, s.foreign_amount, s.settles_id, r.fx_rate booked_rate,
       COALESCE((SELECT SUM(credit - debit) FROM journal_lines WHERE journal_id = s.id AND account_code IN (?, ?)), 0) gain
     FROM journals s JOIN journals r ON r.id = s.settles_id
     WHERE NOT EXISTS (SELECT 1 FROM journals x WHERE x.reverses_id = s.id)
     ORDER BY s.id DESC`,
    ACC.FX_GAIN,
    ACC.FX_LOSS,
  );
  return { settled, netGain: settled.reduce((t, r) => t + r.gain, 0) };
}

// ───────────────────────── budgets ─────────────────────────

export const BUDGET_ACCOUNTS = [ACC.REVENUE, ACC.COGS, ACC.OPEX] as const;

export function budgetVsActual(db: DB, year: string) {
  const latest = all<{ period: string; account_code: string; amount: number }>(
    db,
    `SELECT b.period, b.account_code, b.amount FROM budget_entries b
     WHERE b.period LIKE ? AND b.id = (SELECT MAX(id) FROM budget_entries x WHERE x.period = b.period AND x.account_code = b.account_code)`,
    `${year}-%`,
  );
  const actuals = all<{ m: string; code: string; dr: number; cr: number }>(
    db,
    `SELECT substr(j.doc_date, 1, 7) m, l.account_code code, SUM(l.debit) dr, SUM(l.credit) cr
     FROM journal_lines l JOIN journals j ON j.id = l.journal_id
     WHERE j.doc_date LIKE ? AND j.kind <> 'CLOSING' GROUP BY m, code`,
    `${year}-%`,
  );
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const cur = today().slice(0, 7);
  const rows = BUDGET_ACCOUNTS.map((code) => {
    const isRevenue = code === ACC.REVENUE;
    const cells = months.map((m) => {
      const a = actuals.find((x) => x.m === m && x.code === code);
      const actual = a ? (isRevenue ? a.cr - a.dr : a.dr - a.cr) : 0;
      const budget = latest.find((b) => b.period === m && b.account_code === code)?.amount ?? null;
      const past = m <= cur;
      const variance = budget === null || !past ? null : isRevenue ? actual - budget : budget - actual; // positive = favourable
      return { month: m, actual: past ? actual : null, budget, variance, partial: m === cur };
    });
    const ytd = cells.filter((c) => c.actual !== null && c.budget !== null);
    const ytdActual = ytd.reduce((t, c) => t + (c.actual ?? 0), 0);
    const ytdBudget = ytd.reduce((t, c) => t + (c.budget ?? 0), 0);
    return { code, isRevenue, cells, ytdActual, ytdBudget, ytdVariance: isRevenue ? ytdActual - ytdBudget : ytdBudget - ytdActual, fullYearBudget: cells.reduce((t, c) => t + (c.budget ?? 0), 0) };
  });
  const history = all<{ period: string; account_code: string; amount: number; created_at: string; created_by: string }>(
    db,
    "SELECT period, account_code, amount, created_at, created_by FROM budget_entries WHERE period LIKE ? ORDER BY id DESC LIMIT 20",
    `${year}-%`,
  );
  return { year, months, rows, history };
}

// ───────────────────────── FIFO comparison ─────────────────────────

/**
 * Re-values history under FIFO for comparison. The ledger's policy stays moving average; this replays
 * every stock movement per item (company-wide; transfers net to zero) through FIFO layers.
 */
export function fifoComparison(db: DB, f: { from?: string; asOf?: string } = {}) {
  const from = f.from ?? MIN_DATE;
  const asOf = f.asOf ?? MAX_DATE;
  const moves = all<{ item_id: number; qty: number; value: number; doc_date: string; kind: string; orig_kind: string | null }>(
    db,
    `SELECT m.item_id, m.qty, m.value, m.doc_date, j.kind, o.kind orig_kind
     FROM stock_moves m JOIN journals j ON j.id = m.journal_id LEFT JOIN journals o ON o.id = j.reverses_id
     WHERE m.doc_date <= ? AND j.kind <> 'TRANSFER' AND NOT (j.kind = 'REVERSAL' AND o.kind = 'TRANSFER')
     ORDER BY m.id`,
    asOf,
  );
  const items = itemsOverview(db);
  const state = new Map<number, { layers: { qty: number; unit: number }[]; fifoCogs: number; avgCogs: number }>();
  for (const m of moves) {
    const st = state.get(m.item_id) ?? { layers: [], fifoCogs: 0, avgCogs: 0 };
    state.set(m.item_id, st);
    const isSale = m.kind === "SALE" || (m.kind === "REVERSAL" && m.orig_kind === "SALE");
    if (m.qty > 0) {
      st.layers.push({ qty: m.qty, unit: m.value / m.qty });
      if (isSale && m.doc_date >= from) {
        st.fifoCogs -= m.value; // sale reversal returns at the cost originally charged
        st.avgCogs -= m.value;
      }
      continue;
    }
    let need = -m.qty;
    let cost = 0;
    while (need > 0 && st.layers.length) {
      const l = st.layers[0];
      const take = Math.min(need, l.qty);
      cost += take * l.unit;
      l.qty -= take;
      need -= take;
      if (l.qty === 0) st.layers.shift();
    }
    if (isSale && m.doc_date >= from) {
      st.fifoCogs += cost;
      st.avgCogs += -m.value;
    }
  }
  const rows = items.map((i) => {
    const st = state.get(i.id);
    const qty = st ? st.layers.reduce((t, l) => t + l.qty, 0) : 0;
    const fifoValue = Math.round(st ? st.layers.reduce((t, l) => t + l.qty * l.unit, 0) : 0);
    const avg = positions(db, { asOf }).filter((p) => p.item_id === i.id);
    const avgValue = avg.reduce((t, p) => t + p.value, 0);
    return {
      id: i.id, sku: i.sku, name: i.name, qty, fifoValue, avgValue, diff: fifoValue - avgValue,
      fifoCogs: Math.round(st?.fifoCogs ?? 0), avgCogs: Math.round(st?.avgCogs ?? 0),
    };
  });
  const sum = (k: "fifoValue" | "avgValue" | "fifoCogs" | "avgCogs") => rows.reduce((t, r) => t + r[k], 0);
  return { rows, fifoValue: sum("fifoValue"), avgValue: sum("avgValue"), fifoCogs: sum("fifoCogs"), avgCogs: sum("avgCogs") };
}

// ───────────────────────── receivables / payables ─────────────────────────

export const AGE_BUCKETS = ["Current", "1–30", "31–60", "61–90", "90+"] as const;

/** Open-item ageing by days past due (as of a date). Unapplied payments are shown as credits per contact. */
export function ageing(db: DB, side: "AR" | "AP", asOf = today()) {
  const items = openInvoices(db, { side }).filter((i) => i.doc_date <= asOf);
  const contacts = all<{ id: number; name: string; email: string; terms_days: number }>(db, "SELECT id, name, email, terms_days FROM contacts WHERE kind = ?", side === "AR" ? "CUSTOMER" : "SUPPLIER");
  const bucketOf = (due: string | null, doc: string) => {
    const days = Math.floor((Date.parse(asOf) - Date.parse(due ?? doc)) / 86400000);
    return days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
  };
  const rows = new Map<string, { key: string; contactId: number | null; name: string; buckets: number[]; total: number; oldest: string; items: (typeof items[number] & { bucket: number; daysOverdue: number })[] }>();
  for (const i of items) {
    const key = i.contact_id ? `c${i.contact_id}` : `n${i.counterparty || "Unassigned"}`;
    const name = contacts.find((c) => c.id === i.contact_id)?.name ?? (i.counterparty || "Unassigned");
    const r = rows.get(key) ?? { key, contactId: i.contact_id, name, buckets: [0, 0, 0, 0, 0], total: 0, oldest: i.due_date ?? i.doc_date, items: [] };
    const b = bucketOf(i.due_date, i.doc_date);
    r.buckets[b] += i.open;
    r.total += i.open;
    if ((i.due_date ?? i.doc_date) < r.oldest) r.oldest = i.due_date ?? i.doc_date;
    r.items.push({ ...i, bucket: b, daysOverdue: Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(i.due_date ?? i.doc_date)) / 86400000)) });
    rows.set(key, r);
  }
  const unapplied = unappliedPayments(db, side);
  const list = [...rows.values()].sort((a, b) => b.total - a.total);
  const totals = AGE_BUCKETS.map((_, k) => list.reduce((t, r) => t + r.buckets[k], 0));
  const overdue = totals.slice(1).reduce((a, b) => a + b, 0);
  const grand = totals.reduce((a, b) => a + b, 0);
  return { side, asOf, rows: list, totals, total: grand, overdue, unapplied, unappliedTotal: unapplied.reduce((t, u) => t + u.amount, 0) };
}

/** Payments (receipts from customers / payments to suppliers) not fully applied to invoices. */
export function unappliedPayments(db: DB, side: "AR" | "AP") {
  const acc = side === "AR" ? ACC.AR : ACC.AP;
  const col = side === "AR" ? "credit" : "debit";
  return all<{ id: number; doc_date: string; counterparty: string; contact_id: number | null; amount: number }>(
    db,
    `SELECT j.id, j.doc_date, j.counterparty, j.contact_id,
       (SELECT SUM(${col}) FROM journal_lines WHERE journal_id = j.id AND account_code = ?) - COALESCE((SELECT SUM(amount) FROM allocations WHERE payment_id = j.id), 0) amount
     FROM journals j WHERE j.kind = 'PAYMENT'
       AND EXISTS (SELECT 1 FROM journal_lines x WHERE x.journal_id = j.id AND x.account_code = ? AND x.${col} > 0)
       AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = j.id)
     ORDER BY j.id`,
    acc,
    acc,
  ).filter((p) => p.amount > 0);
}

export function contactsOverview(db: DB, kind: "CUSTOMER" | "SUPPLIER") {
  const contacts = all<{ id: number; name: string; email: string; vat_id: string; terms_days: number; currency: string; created_at: string }>(db, "SELECT * FROM contacts WHERE kind = ? ORDER BY name", kind);
  const open = openInvoices(db, { side: kind === "CUSTOMER" ? "AR" : "AP" });
  const t = today();
  const volume = all<{ contact_id: number; n: number; total: number }>(
    db,
    `SELECT j.contact_id, COUNT(*) n, SUM((SELECT MAX(MAX(debit), MAX(credit)) FROM journal_lines WHERE journal_id = j.id)) total
     FROM journals j WHERE j.kind = ? AND j.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = j.id) AND j.doc_date >= ?
     GROUP BY j.contact_id`,
    kind === "CUSTOMER" ? "SALE" : "RECEIPT",
    new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10),
  );
  return contacts.map((c) => {
    const mine = open.filter((o) => o.contact_id === c.id);
    return {
      ...c,
      open: mine.reduce((s, o) => s + o.open, 0),
      overdue: mine.filter((o) => (o.due_date ?? o.doc_date) < t).reduce((s, o) => s + o.open, 0),
      invoices: mine.length,
      volume12m: volume.find((v) => v.contact_id === c.id)?.total ?? 0,
      docs12m: volume.find((v) => v.contact_id === c.id)?.n ?? 0,
    };
  });
}

export function ordersList(db: DB, kind?: "PO" | "SO") {
  const orders = all<{ id: number; kind: "PO" | "SO"; number: string; contact_id: number; contact: string; order_date: string; expected_date: string | null; currency: string; cancelled_at: string | null; warehouse: string }>(
    db,
    `SELECT o.id, o.kind, o.number, o.contact_id, c.name contact, o.order_date, o.expected_date, o.currency, o.cancelled_at, w.name warehouse
     FROM orders o JOIN contacts c ON c.id = o.contact_id JOIN warehouses w ON w.id = o.warehouse_id
     ${kind ? "WHERE o.kind = ?" : ""} ORDER BY o.id DESC`,
    ...(kind ? [kind] : []),
  );
  return orders.map((o) => ({ ...o, ...orderProgress(db, o.id, o.cancelled_at) }));
}

export function orderProgress(db: DB, orderId: number, cancelledAt: string | null) {
  const lines = all<{ item_id: number; qty: number; unit_amount: number; vat_rate: number }>(db, "SELECT item_id, qty, unit_amount, vat_rate FROM order_lines WHERE order_id = ?", orderId);
  const done = all<{ item_id: number; qty: number }>(
    db,
    `SELECT m.item_id, SUM(ABS(m.qty)) qty FROM stock_moves m JOIN journals j ON j.id = m.journal_id
     WHERE j.order_id = ? AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = j.id) GROUP BY m.item_id`,
    orderId,
  );
  const ordered = lines.reduce((t, l) => t + l.qty, 0);
  const delivered = done.reduce((t, d) => t + d.qty, 0);
  const value = lines.reduce((t, l) => t + l.qty * l.unit_amount, 0);
  const status = cancelledAt ? (delivered ? "CLOSED" : "CANCELLED") : delivered === 0 ? "OPEN" : delivered >= ordered ? "FULFILLED" : "PARTIAL";
  return { ordered, delivered, value, status: status as "OPEN" | "PARTIAL" | "FULFILLED" | "CANCELLED" | "CLOSED" };
}
