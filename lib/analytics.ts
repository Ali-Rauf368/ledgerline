/**
 * Statistical intelligence over the ledger: anomaly detection and forecasting.
 * Deterministic and explainable, so every flag says exactly why it was raised, and the AI layer
 * (Copilot, month-end commentary) builds on these facts instead of guessing.
 */
import type { DB } from "./db.ts";
import { all, get } from "./db.ts";
import { ACC } from "./accounts.ts";
import { today, vatPosition } from "./ledger.ts";
import { itemsOverview } from "./reports.ts";

export type Severity = "high" | "medium" | "low";
export type Anomaly = {
  key: string;
  severity: Severity;
  type: "cost_spike" | "below_cost_sale" | "margin_outlier" | "shrinkage" | "late_posting" | "large_amount" | "possible_duplicate";
  title: string;
  detail: string;
  date: string;
  journalId?: number;
  itemId?: number;
  score: number;
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const eur = (c: number) => `€${(c / 100).toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000);

/** Journals that were corrected are excluded: the correction already handled them. */
const LIVE = `j.kind NOT IN ('REVERSAL','CLOSING') AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = j.id)`;

export function detectAnomalies(db: DB, o: { since?: string } = {}): Anomaly[] {
  const since = o.since ?? "0000-01-01";
  const out: Anomaly[] = [];

  // 1. Purchase cost spikes: unit cost vs the item's own receipt history (robust z-score + % move).
  const receipts = all<{ journal_id: number; item_id: number; sku: string; doc_date: string; unit: number }>(
    db,
    `SELECT m.journal_id, m.item_id, i.sku, m.doc_date, CAST(m.value AS REAL) / m.qty unit
     FROM stock_moves m JOIN journals j ON j.id = m.journal_id JOIN items i ON i.id = m.item_id
     WHERE j.kind = 'RECEIPT' AND m.qty > 0 AND ${LIVE} ORDER BY m.id`,
  );
  const byItem = new Map<number, typeof receipts>();
  for (const r of receipts) (byItem.get(r.item_id) ?? byItem.set(r.item_id, []).get(r.item_id)!).push(r);
  for (const list of byItem.values()) {
    list.forEach((r, idx) => {
      const prior = list.slice(Math.max(0, idx - 12), idx).map((x) => x.unit);
      if (prior.length < 4 || r.doc_date < since) return;
      const m = mean(prior);
      const sd = Math.max(stdev(prior), m * 0.02);
      const z = (r.unit - m) / sd;
      const pct = (r.unit - m) / m;
      if (Math.abs(z) >= 3 && Math.abs(pct) >= 0.12) {
        out.push({
          key: `cost-${r.journal_id}-${r.item_id}`,
          severity: Math.abs(pct) >= 0.25 ? "high" : "medium",
          type: "cost_spike",
          title: `${r.sku} bought ${pct > 0 ? "above" : "below"} its usual cost`,
          detail: `Unit cost ${eur(Math.round(r.unit))} vs ${eur(Math.round(m))} average of the last ${prior.length} receipts (${pct > 0 ? "+" : ""}${(pct * 100).toFixed(0)}%, z=${z.toFixed(1)}).`,
          date: r.doc_date,
          journalId: r.journal_id,
          itemId: r.item_id,
          score: Math.abs(z),
        });
      }
    });
  }

  // 2. Sales: below cost, and margin outliers vs all other sales.
  const sales = all<{ id: number; doc_date: string; counterparty: string; revenue: number; cogs: number }>(
    db,
    `SELECT j.id, j.doc_date, j.counterparty,
       COALESCE((SELECT SUM(credit) FROM journal_lines WHERE journal_id = j.id AND account_code = '${ACC.REVENUE}'), 0) revenue,
       COALESCE((SELECT SUM(debit) FROM journal_lines WHERE journal_id = j.id AND account_code = '${ACC.COGS}'), 0) cogs
     FROM journals j WHERE j.kind = 'SALE' AND ${LIVE} ORDER BY j.id`,
  );
  const margins = sales.filter((s) => s.revenue > 0).map((s) => (s.revenue - s.cogs) / s.revenue);
  const mm = mean(margins);
  const ms = stdev(margins);
  for (const s of sales) {
    if (s.doc_date < since || !s.revenue) continue;
    const margin = (s.revenue - s.cogs) / s.revenue;
    if (s.revenue < s.cogs) {
      out.push({
        key: `below-${s.id}`, severity: "high", type: "below_cost_sale",
        title: `Sale to ${s.counterparty || "customer"} below cost`,
        detail: `Revenue ${eur(s.revenue)} vs cost of goods ${eur(s.cogs)}: a loss of ${eur(s.cogs - s.revenue)} (${(margin * 100).toFixed(0)}% margin).`,
        date: s.doc_date, journalId: s.id, score: 10,
      });
    } else if (ms > 0 && (margin - mm) / ms <= -3) {
      out.push({
        key: `margin-${s.id}`, severity: "medium", type: "margin_outlier",
        title: `Unusually thin margin on a sale to ${s.counterparty || "customer"}`,
        detail: `${(margin * 100).toFixed(1)}% gross margin vs ${(mm * 100).toFixed(1)}% typical (z=${((margin - mm) / ms).toFixed(1)}). Check pricing or discounts.`,
        date: s.doc_date, journalId: s.id, score: Math.abs((margin - mm) / ms),
      });
    }
  }

  // 3. Shrinkage: write-offs that are large in absolute terms or vs the usual adjustment.
  const adj = all<{ id: number; doc_date: string; memo: string; loss: number }>(
    db,
    `SELECT j.id, j.doc_date, j.memo, COALESCE((SELECT SUM(debit) FROM journal_lines WHERE journal_id = j.id AND account_code = '${ACC.SHRINK}'), 0) loss
     FROM journals j WHERE j.kind = 'ADJUSTMENT' AND ${LIVE} ORDER BY j.id`,
  );
  const losses = adj.map((a) => a.loss).filter((x) => x > 0).sort((a, b) => a - b);
  const median = losses.length ? losses[Math.floor(losses.length / 2)] : 0;
  for (const a of adj) {
    if (a.doc_date < since || !a.loss) continue;
    if (a.loss >= 25000 || (median && a.loss >= median * 5 && a.loss >= 20000)) {
      out.push({
        key: `shrink-${a.id}`, severity: a.loss >= 30000 ? "high" : "medium", type: "shrinkage",
        title: `Large stock write-off`,
        detail: `${eur(a.loss)} written off ("${a.memo}"); the typical adjustment is ${eur(median)}.`,
        date: a.doc_date, journalId: a.id, score: a.loss / Math.max(median, 1),
      });
    }
  }

  // 4. Large amounts vs the same kind of transaction (3σ), and late postings (> 3 days after the document date).
  // "face" = the largest single line, i.e. the invoice total the counterparty sees (COGS can differ by a cent).
  const js = all<{ id: number; kind: string; doc_date: string; posted_at: string; counterparty: string; memo: string; amount: number; face: number }>(
    db,
    `SELECT j.id, j.kind, j.doc_date, j.posted_at, j.counterparty, j.memo, COALESCE((SELECT SUM(debit) FROM journal_lines WHERE journal_id = j.id), 0) amount,
       COALESCE((SELECT MAX(MAX(debit), MAX(credit)) FROM journal_lines WHERE journal_id = j.id), 0) face
     FROM journals j WHERE ${LIVE} ORDER BY j.id`,
  );
  const byKind = new Map<string, number[]>();
  for (const j of js) (byKind.get(j.kind) ?? byKind.set(j.kind, []).get(j.kind)!).push(j.amount);
  for (const j of js) {
    if (j.doc_date < since) continue;
    const xs = byKind.get(j.kind)!;
    const m = mean(xs);
    const sd = stdev(xs);
    if (xs.length >= 10 && sd > 0 && (j.amount - m) / sd >= 3.5 && j.kind !== "PAYMENT") {
      out.push({
        key: `large-${j.id}`, severity: "medium", type: "large_amount",
        title: `Unusually large ${j.kind.toLowerCase()}`,
        detail: `${eur(j.amount)} vs ${eur(Math.round(m))} average for this type (${((j.amount - m) / sd).toFixed(1)}σ).`,
        date: j.doc_date, journalId: j.id, score: (j.amount - m) / sd,
      });
    }
    const lag = daysBetween(j.doc_date, j.posted_at);
    if (lag > 3) {
      out.push({
        key: `late-${j.id}`, severity: lag > 14 ? "medium" : "low", type: "late_posting",
        title: `Posted ${lag} days after the document date`,
        detail: `${j.counterparty || j.memo || j.kind} dated ${j.doc_date} was entered on ${j.posted_at.slice(0, 10)}. Earlier reports didn't include it.`,
        date: j.doc_date, journalId: j.id, score: lag / 7,
      });
    }
  }

  // 5. Possible duplicates: same kind, counterparty and amount within 3 days.
  for (let a = 0; a < js.length; a++) {
    for (let b = a + 1; b < js.length && b < a + 40; b++) {
      const x = js[a];
      const y = js[b];
      if (y.doc_date < since) continue;
      if (x.kind === y.kind && x.kind !== "PAYMENT" && x.counterparty && x.counterparty === y.counterparty && x.face === y.face && x.face > 0 && Math.abs(daysBetween(x.doc_date, y.doc_date)) <= 3) {
        out.push({
          key: `dup-${y.id}`, severity: "high", type: "possible_duplicate",
          title: `Possible duplicate of #${x.id}`,
          detail: `Same type, counterparty (${y.counterparty}) and invoice total (${eur(y.face)}) as #${x.id}, ${Math.abs(daysBetween(x.doc_date, y.doc_date))} day(s) apart.`,
          date: y.doc_date, journalId: y.id, score: 9,
        });
      }
    }
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.date.localeCompare(a.date) || b.score - a.score);
}

// ───────────────────────── demand forecast ─────────────────────────

export type DemandForecast = {
  id: number;
  sku: string;
  name: string;
  unit: string;
  onHand: number;
  forecast30: number;
  low30: number;
  high30: number;
  perDay: number;
  stockoutDate: string | null;
  accuracy: number | null;
  daily: number[];
};

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

/** Simple exponential smoothing on deseasonalised daily sales, times a weekday index. */
function fit(series: { date: string; units: number }[], alpha = 0.25) {
  const overall = mean(series.map((s) => s.units)) || 0;
  const idx = Array.from({ length: 7 }, (_, d) => {
    const xs = series.filter((s) => dow(s.date) === d).map((s) => s.units);
    // Shrink weekday effects toward 1 when data is thin.
    const raw = overall ? mean(xs) / overall : 1;
    return xs.length ? (raw * xs.length + 1 * 2) / (xs.length + 2) : 1;
  });
  let level = overall;
  const residuals: number[] = [];
  for (const s of series) {
    const f = level * idx[dow(s.date)];
    residuals.push(s.units - f);
    level = alpha * (s.units / (idx[dow(s.date)] || 1)) + (1 - alpha) * level;
  }
  return { level, idx, sigma: stdev(residuals) };
}

export function forecastDemand(db: DB, horizon = 30, historyDays = 84): DemandForecast[] {
  const t = today();
  const start = addDays(t, -historyDays);
  const rows = all<{ item_id: number; d: string; units: number }>(
    db,
    `SELECT m.item_id, m.doc_date d, -SUM(m.qty) units FROM stock_moves m JOIN journals j ON j.id = m.journal_id
     WHERE j.kind = 'SALE' AND m.doc_date >= ? AND m.doc_date < ?
       AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = j.id)
     GROUP BY m.item_id, m.doc_date`,
    start,
    t,
  );
  const dates = Array.from({ length: historyDays }, (_, i) => addDays(start, i));
  return itemsOverview(db).map((item) => {
    const series = dates.map((date) => ({ date, units: rows.find((r) => r.item_id === item.id && r.d === date)?.units ?? 0 }));
    // Back-test what we actually promise, the 4-week total: fit on the first 8 weeks, forecast the last 4.
    const cut = series.length - 28;
    const bt = fit(series.slice(0, cut));
    const test = series.slice(cut);
    const act = test.reduce((t, s) => t + s.units, 0);
    const fc = test.reduce((t, s) => t + bt.level * bt.idx[dow(s.date)], 0);
    const accuracy = act > 0 ? Math.max(0, 1 - Math.abs(act - fc) / act) : null;

    const m = fit(series);
    const daily = Array.from({ length: horizon }, (_, i) => Math.max(0, m.level * m.idx[dow(addDays(t, i))]));
    const total = daily.reduce((a, b) => a + b, 0);
    const band = 1.28 * m.sigma * Math.sqrt(horizon); // ~80% interval on the 30-day total
    let cum = 0;
    let stockoutDate: string | null = null;
    for (let i = 0; i < horizon; i++) {
      cum += daily[i];
      if (cum > item.qty) {
        stockoutDate = addDays(t, i);
        break;
      }
    }
    return {
      id: item.id, sku: item.sku, name: item.name, unit: item.unit, onHand: item.qty,
      forecast30: Math.round(total), low30: Math.max(0, Math.round(total - band)), high30: Math.round(total + band),
      perDay: total / horizon, stockoutDate, accuracy, daily: daily.map((x) => Number(x.toFixed(2))),
    };
  });
}

// ───────────────────────── cash forecast ─────────────────────────

export type CashPoint = { date: string; actual?: number; forecast?: number; low?: number; high?: number };

/**
 * Cash projection: recent average daily operating cash flow (owner capital excluded), plus known
 * scheduled items, currently the VAT settlement due on the 10th. The band widens with √t.
 */
export function forecastCash(db: DB, horizon = 30, historyDays = 90) {
  const t = today();
  const start = addDays(t, -historyDays);
  const opening = get<{ b: number }>(
    db,
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM journal_lines l JOIN journals j ON j.id = l.journal_id WHERE l.account_code = ? AND j.doc_date < ?`,
    ACC.CASH,
    start,
  )!.b;
  const flows = all<{ d: string; net: number; capital: number; vat: number }>(
    db,
    `SELECT j.doc_date d, SUM(l.debit - l.credit) net,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM journal_lines e WHERE e.journal_id = j.id AND e.account_code = '${ACC.EQUITY}') THEN l.debit - l.credit ELSE 0 END) capital,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM journal_lines v WHERE v.journal_id = j.id AND v.account_code = '${ACC.VAT_OUT}') AND j.kind = 'PAYMENT' THEN l.debit - l.credit ELSE 0 END) vat
     FROM journal_lines l JOIN journals j ON j.id = l.journal_id
     WHERE l.account_code = ? AND j.doc_date >= ? AND j.doc_date <= ? GROUP BY j.doc_date`,
    ACC.CASH,
    start,
    t,
  );
  const points: CashPoint[] = [];
  let bal = opening;
  const operating: number[] = [];
  for (let i = 0; i <= historyDays; i++) {
    const d = addDays(start, i);
    const f = flows.find((x) => x.d === d);
    bal += f?.net ?? 0;
    // VAT settlements are modelled separately as a scheduled item.
    operating.push((f?.net ?? 0) - (f?.capital ?? 0) - (f?.vat ?? 0));
    points.push({ date: d, actual: bal });
  }
  const drift = mean(operating);
  const sd = stdev(operating);
  const vatDue = Math.max(0, vatPosition(db).net);
  let next10 = t.slice(8) < "10" ? `${t.slice(0, 8)}10` : `${addDays(`${t.slice(0, 8)}01`, 32).slice(0, 8)}10`;
  if (next10 <= t) next10 = addDays(t, 1);
  points[points.length - 1].forecast = bal;
  points[points.length - 1].low = bal;
  points[points.length - 1].high = bal;
  let proj = bal;
  for (let i = 1; i <= horizon; i++) {
    const d = addDays(t, i);
    proj += drift - (d === next10 ? vatDue : 0);
    const band = 1.28 * sd * Math.sqrt(i);
    points.push({ date: d, forecast: Math.round(proj), low: Math.round(proj - band), high: Math.round(proj + band) });
  }
  const end = points[points.length - 1];
  return {
    points,
    current: bal,
    projected: end.forecast!,
    low: end.low!,
    high: end.high!,
    dailyDrift: drift,
    scheduled: vatDue ? [{ date: next10, label: "VAT settlement", amount: -vatDue }] : [],
  };
}
