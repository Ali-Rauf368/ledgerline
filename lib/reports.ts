/**
 * Read models. Every report accepts two time axes:
 *   asOf    – the accounting date (doc_date) the report is "as at"
 *   knownAt – the posting timestamp cut-off: "what did this report say at that moment?"
 * Because the ledger is append-only and posting time is monotonic, both are exact.
 */
import type { DB } from "./db.ts";
import { all, get } from "./db.ts";
import { ACC, COST_OF_SALES, isDebitNormal } from "./accounts.ts";
import type { AccountType, JournalKind } from "./accounts.ts";
import { lockedThrough, monthEnd, nextClosablePeriod, nextMonth, today } from "./ledger.ts";

const MIN_DATE = "0000-01-01";
const MAX_DATE = "9999-12-31";
const MAX_TS = "9999-12-31T23:59:59.999Z";

export type Filter = { from?: string; asOf?: string; knownAt?: string };

export type AccountRow = { code: string; name: string; type: AccountType; debit: number; credit: number; balance: number };

export function accountActivity(db: DB, f: Filter = {}): AccountRow[] {
  const rows = all<Omit<AccountRow, "balance">>(
    db,
    `SELECT a.code, a.name, a.type, COALESCE(s.debit, 0) debit, COALESCE(s.credit, 0) credit
     FROM accounts a LEFT JOIN (
       SELECT l.account_code, SUM(l.debit) debit, SUM(l.credit) credit
       FROM journal_lines l JOIN journals j ON j.id = l.journal_id
       WHERE j.doc_date >= ? AND j.doc_date <= ? AND j.posted_at <= ?
       GROUP BY l.account_code
     ) s ON s.account_code = a.code
     ORDER BY a.code`,
    f.from ?? MIN_DATE,
    f.asOf ?? MAX_DATE,
    f.knownAt ?? MAX_TS,
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

export function incomeStatement(db: DB, f: Filter = {}) {
  const rows = accountActivity(db, f);
  const revenue = rows.filter((r) => r.type === "REVENUE");
  const costOfSales = rows.filter((r) => COST_OF_SALES.includes(r.code));
  const opex = rows.filter((r) => r.type === "EXPENSE" && !COST_OF_SALES.includes(r.code));
  const sum = (xs: AccountRow[]) => xs.reduce((s, r) => s + r.balance, 0);
  const totalRevenue = sum(revenue);
  const grossProfit = totalRevenue - sum(costOfSales);
  const netIncome = grossProfit - sum(opex);
  return {
    revenue,
    costOfSales,
    opex,
    totalRevenue,
    totalCostOfSales: sum(costOfSales),
    totalOpex: sum(opex),
    grossProfit,
    grossMargin: totalRevenue ? grossProfit / totalRevenue : 0,
    netIncome,
  };
}

export function balanceSheet(db: DB, f: Filter = {}) {
  const rows = accountActivity(db, { asOf: f.asOf, knownAt: f.knownAt });
  const by = (t: AccountType) => rows.filter((r) => r.type === t);
  const sum = (xs: { balance: number }[]) => xs.reduce((s, r) => s + r.balance, 0);
  const netIncome = sum(by("REVENUE")) - sum(by("EXPENSE"));
  const equity = [...by("EQUITY"), { code: "—", name: "Earnings to date", type: "EQUITY" as const, debit: 0, credit: 0, balance: netIncome }];
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
     FROM journal_lines l JOIN journals j ON j.id = l.journal_id GROUP BY m, code`,
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
