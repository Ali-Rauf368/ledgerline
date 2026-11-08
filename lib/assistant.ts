/**
 * Ledger Copilot: a Claude-powered assistant with READ-ONLY tools over the ledger.
 * It can look things up and explain them, but it cannot post, reverse or close anything,
 * so the integrity guarantees of the ledger never depend on the model.
 *
 * Without credentials it falls back to a small offline intent matcher over the same tools.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { DB } from "./db";
import { ACC, KIND_LABEL } from "./accounts";
import { verifyLedger } from "./integrity";
import { lockedThrough, monthEnd, openForeignInvoices, rawBalance, sha256, today, vatPosition } from "./ledger";
import type { CashType } from "./ledger";
import { detectAnomalies, forecastCash, forecastDemand } from "./analytics";
import type { TxDraft } from "./draft";
import { draftHref } from "./draft";
import { all, run } from "./db";
import { fmtMoney } from "./money";
import {
  budgetVsActual, fifoComparison, fxActivity, vatReport, warehouses,
  balanceSheet, dashboard, incomeStatement, inventoryValuation, itemsOverview, journalDetail, journalsList,
  reorderInsights, stockCard,
} from "./reports";

export type ChatTurn = { role: "user" | "assistant"; text: string };
export type DraftLink = { label: string; href: string };
export type AssistantReply = { text: string; tools: string[]; mode: "ai" | "offline"; notice?: string; drafts?: DraftLink[] };

const MODEL = "claude-opus-5-5";
const eur = (c: number) => fmtMoney(c);

const SYSTEM = `You are Ledger Copilot, the assistant inside Ledgerline, an append-only inventory ledger and financial reporting app for a small coffee wholesaler (currency EUR).

Use the tools to look up real figures before answering any question about stock, sales, costs, cash or the books; never guess numbers. Cite the figures you used, and mention journal ids as #123 and SKUs in backticks so the user can find them.

You are read-only: you never post anything yourself. When the user asks you to record a receipt, sale, transfer, adjustment or cash movement, call draft_transaction. The app shows the user a "Review & post" button that opens a pre-filled form they check and post. Say that you prepared a draft for review; never say it was posted. For reversals or period closes, explain the steps in the app (the Reverse button on a journal, or the Periods page).

The books have VAT (7% coffee, 19% other goods; input VAT 1400, output VAT 2100, settled monthly), foreign-currency purchase invoices with realised FX gains/losses on settlement, budgets by month, year-end closes into retained earnings (3100), statistical anomaly detection, and 30-day demand and cash forecasts. Use the matching tools. Ledger rules you can explain: entries are never edited, corrections are reversals; moving-average costing in cents; no backdating before an item's latest movement; closed months are locked and their snapshots verified; each journal is SHA-256 hash-chained.

Keep answers short and scannable: a direct answer first, then a few bullet points if useful. Use **bold** for key numbers. Today is ${today()}.`;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: "get_overview", description: "Headline KPIs: inventory value, cash, receivables, payables, revenue and gross margin this month and last month, units on hand.", input_schema: { type: "object", properties: {} } },
  { name: "list_inventory", description: "All items with on-hand quantity, moving-average cost and carrying value.", input_schema: { type: "object", properties: {} } },
  {
    name: "reorder_suggestions",
    description: "Replenishment analysis from 30-day sales velocity: days of stock cover, status (critical/low/healthy/slow) and suggested reorder quantity per item.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "item_history",
    description: "Recent stock movements (stock card) for one item, with running quantity and value.",
    input_schema: { type: "object", properties: { sku: { type: "string", description: "Item SKU, e.g. ETH-YRG-1K" }, limit: { type: "integer", description: "Max movements, default 15" } }, required: ["sku"] },
  },
  {
    name: "income_statement",
    description: "Profit and loss between two accounting dates (inclusive).",
    input_schema: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } }, required: ["from", "to"] },
  },
  {
    name: "balance_sheet",
    description: "Assets, liabilities and equity as of a date. Optionally 'known_at' (ISO timestamp) to reproduce the report as it looked at that moment.",
    input_schema: { type: "object", properties: { as_of: { type: "string", description: "YYYY-MM-DD" }, known_at: { type: "string" } }, required: ["as_of"] },
  },
  {
    name: "search_journal",
    description: "Search journal entries by text (memo, counterparty, reference) and/or kind. Returns newest first.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", enum: ["RECEIPT", "SALE", "TRANSFER", "ADJUSTMENT", "PAYMENT", "REVERSAL"] },
        limit: { type: "integer", description: "Default 10, max 30" },
      },
    },
  },
  {
    name: "get_journal",
    description: "Full detail of one journal entry: GL lines, stock moves, hash, and reversal links.",
    input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  },
  { name: "find_anomalies", description: "Statistically unusual activity: purchase cost spikes, below-cost or thin-margin sales, large write-offs, unusually large entries, late postings, possible duplicates. Optional 'since' date.", input_schema: { type: "object", properties: { since: { type: "string", description: "YYYY-MM-DD" } } } },
  { name: "demand_forecast", description: "30-day unit demand forecast per item (seasonal exponential smoothing) with an ~80% range, projected stock-out date and back-tested accuracy.", input_schema: { type: "object", properties: {} } },
  { name: "cash_forecast", description: "30-day cash projection from recent operating cash flow plus scheduled items (VAT settlement), with an ~80% band.", input_schema: { type: "object", properties: {} } },
  {
    name: "vat_summary",
    description: "VAT return for a date range (output VAT, input VAT, net payable, settlements) plus the current outstanding VAT position.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
  },
  { name: "budget_vs_actual", description: "Monthly budget vs actual for revenue, cost of goods sold and operating expenses for a year, with year-to-date variance (positive = favourable).", input_schema: { type: "object", properties: { year: { type: "string" } }, required: ["year"] } },
  { name: "fx_overview", description: "Open foreign-currency supplier invoices and realised FX gains/losses on settled ones.", input_schema: { type: "object", properties: {} } },
  { name: "fifo_comparison", description: "What inventory value and cost of goods sold would be under FIFO instead of the ledger's moving-average policy.", input_schema: { type: "object", properties: {} } },
  {
    name: "draft_transaction",
    description: "Prepare (NOT post) a transaction for the user to review and post. Amounts are in major units of the currency (e.g. 26.90). unit_amount is unit cost for receipts, unit price for sales, optional unit cost for positive adjustments. qty is negative for stock removals in adjustments.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["RECEIPT", "SALE", "TRANSFER", "ADJUSTMENT", "PAYMENT"] },
        warehouse_code: { type: "string", description: "BER or LEJ; default BER. For transfers this is the source." },
        to_warehouse_code: { type: "string" },
        counterparty: { type: "string" },
        paid: { type: "boolean", description: "Paid immediately instead of on account" },
        memo: { type: "string" },
        reference: { type: "string" },
        currency: { type: "string", enum: ["EUR", "USD", "GBP", "CHF", "JPY"] },
        fx_rate: { type: "string", description: "EUR per 1 unit of foreign currency" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: { sku: { type: "string" }, qty: { type: "integer" }, unit_amount: { type: "string" }, vat_rate: { type: "integer", enum: [0, 7, 19] } },
            required: ["sku", "qty"],
          },
        },
        cash_type: { type: "string", enum: ["PAY_SUPPLIER", "RECEIVE_CUSTOMER", "EXPENSE", "CAPITAL", "PAY_VAT"] },
        amount: { type: "string" },
      },
      required: ["kind"],
    },
  },
  { name: "run_integrity_check", description: "Run the independent ledger verification (hash chain, balancing, sub-ledger reconciliation, closed-period snapshots and more).", input_schema: { type: "object", properties: {} } },
];

export const TOOL_LABEL: Record<string, string> = {
  get_overview: "Overview KPIs",
  list_inventory: "Inventory",
  reorder_suggestions: "Reorder analysis",
  item_history: "Stock card",
  income_statement: "Income statement",
  balance_sheet: "Balance sheet",
  search_journal: "Journal search",
  get_journal: "Journal entry",
  run_integrity_check: "Integrity check",
  find_anomalies: "Anomaly scan",
  demand_forecast: "Demand forecast",
  cash_forecast: "Cash forecast",
  vat_summary: "VAT return",
  budget_vs_actual: "Budget vs actual",
  fx_overview: "FX",
  fifo_comparison: "FIFO comparison",
  draft_transaction: "Draft",
};

function buildDraft(db: DB, input: Record<string, unknown>): { draft?: TxDraft; label?: string; error?: string } {
  const whs = warehouses(db);
  const items = itemsOverview(db);
  const wh = (code: unknown) => whs.find((w) => w.code === String(code ?? "BER").toUpperCase())?.id;
  const kind = String(input.kind) as TxDraft["kind"];
  const d: TxDraft = {
    kind,
    warehouseId: wh(input.warehouse_code),
    toWarehouseId: input.to_warehouse_code ? wh(input.to_warehouse_code) : undefined,
    counterparty: input.counterparty ? String(input.counterparty) : undefined,
    paid: Boolean(input.paid),
    memo: input.memo ? String(input.memo) : undefined,
    reference: input.reference ? String(input.reference) : undefined,
    currency: input.currency ? String(input.currency) : undefined,
    fxRate: input.fx_rate ? String(input.fx_rate) : undefined,
  };
  if (kind === "PAYMENT") {
    d.cashType = (input.cash_type ? String(input.cash_type) : "EXPENSE") as CashType;
    d.amount = input.amount ? String(input.amount) : undefined;
    if (!d.amount && d.cashType !== "PAY_VAT") return { error: "A cash movement needs an amount." };
    return { draft: d, label: `${d.cashType.replaceAll("_", " ").toLowerCase()}${d.amount ? ` €${d.amount}` : ""}` };
  }
  const lines = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : [];
  if (!lines.length) return { error: "Add at least one line with a SKU and quantity." };
  d.lines = [];
  for (const l of lines) {
    const item = items.find((i) => i.sku === String(l.sku ?? "").toUpperCase());
    if (!item) return { error: `Unknown SKU ${l.sku}. Known: ${items.map((i) => i.sku).join(", ")}` };
    const vat = all<{ vat_rate: number }>(db, "SELECT vat_rate FROM items WHERE id = ?", item.id)[0]?.vat_rate ?? 19;
    d.lines.push({
      itemId: item.id,
      qty: String(l.qty),
      amount: l.unit_amount !== undefined ? String(l.unit_amount) : "",
      vatRate: kind === "RECEIPT" && d.currency && d.currency !== "EUR" ? 0 : l.vat_rate !== undefined ? Number(l.vat_rate) : vat,
    });
  }
  if (!d.warehouseId) return { error: "Unknown warehouse code; use BER or LEJ." };
  const what = lines.map((l) => `${l.qty} × ${String(l.sku).toUpperCase()}`).join(", ");
  return { draft: d, label: `${kind.toLowerCase()}: ${what}` };
}

function runTool(db: DB, name: string, input: Record<string, unknown>, drafts: DraftLink[] = []): unknown {
  switch (name) {
    case "find_anomalies":
      return detectAnomalies(db, { since: input.since ? String(input.since) : undefined }).slice(0, 25).map((a) => ({ severity: a.severity, type: a.type, title: a.title, detail: a.detail, date: a.date, journal: a.journalId ? `#${a.journalId}` : null }));
    case "demand_forecast":
      return forecastDemand(db).map((f) => ({ sku: f.sku, name: f.name, on_hand: f.onHand, forecast_30d: f.forecast30, range_80pct: `${f.low30}–${f.high30}`, projected_stockout: f.stockoutDate ?? "not within 30 days", backtest_accuracy: f.accuracy === null ? "n/a" : `${Math.round(f.accuracy * 100)}%` }));
    case "cash_forecast": {
      const c = forecastCash(db);
      return { cash_now: eur(c.current), projected_in_30_days: eur(c.projected), range_80pct: `${eur(c.low)} – ${eur(c.high)}`, avg_daily_operating_flow: eur(Math.round(c.dailyDrift)), scheduled: c.scheduled.map((x) => ({ ...x, amount: eur(x.amount) })) };
    }
    case "vat_summary": {
      const r = vatReport(db, { from: String(input.from), asOf: String(input.to) });
      return { output_vat: eur(r.output), input_vat: eur(r.input), net_payable: eur(r.net), net_sales: eur(r.taxableSales), effective_output_rate: `${(r.effectiveRate * 100).toFixed(1)}%`, settlements: r.settlements.map((x) => ({ journal: `#${x.id}`, date: x.doc_date, paid: eur(x.amount) })), currently_outstanding: eur(vatPosition(db).net) };
    }
    case "budget_vs_actual": {
      const b = budgetVsActual(db, String(input.year ?? today().slice(0, 4)));
      return b.rows.map((r) => ({ account: r.code, ytd_actual: eur(r.ytdActual), ytd_budget: eur(r.ytdBudget), ytd_variance_favourable: eur(r.ytdVariance), months: r.cells.filter((c) => c.actual !== null).map((c) => ({ month: c.month, actual: eur(c.actual!), budget: c.budget === null ? null : eur(c.budget) })) }));
    }
    case "fx_overview": {
      const f = fxActivity(db);
      return { open_invoices: openForeignInvoices(db).map((o) => ({ journal: `#${o.id}`, date: o.doc_date, supplier: o.counterparty, amount: `${(o.foreign_amount / 100).toFixed(2)} ${o.currency}`, booked_rate: o.fx_rate, booked_eur: eur(o.eur_amount) })), realised_net_gain: eur(f.netGain), settled: f.settled.slice(0, 10).map((x) => ({ journal: `#${x.id}`, invoice: `#${x.settles_id}`, booked_rate: x.booked_rate, paid_rate: x.fx_rate, gain: eur(x.gain) })) };
    }
    case "fifo_comparison": {
      const f = fifoComparison(db);
      return { inventory_fifo: eur(f.fifoValue), inventory_moving_average: eur(f.avgValue), cogs_to_date_fifo: eur(f.fifoCogs), cogs_to_date_moving_average: eur(f.avgCogs), items: f.rows.map((r) => ({ sku: r.sku, fifo: eur(r.fifoValue), moving_avg: eur(r.avgValue) })) };
    }
    case "draft_transaction": {
      const r = buildDraft(db, input);
      if (r.error) return { error: r.error };
      drafts.push({ label: r.label!, href: draftHref(r.draft!) });
      return { ok: true, prepared: r.label, note: "Draft ready. The user will review and post it with the button shown under your reply. Nothing has been posted." };
    }
    case "get_overview": {
      const d = dashboard(db);
      return {
        inventory_value: eur(d.inventory), cash: eur(d.cash), receivables: eur(d.receivables), payables: eur(d.payables),
        revenue_this_month_to_date: eur(d.revenueThisMonth), revenue_last_month: eur(d.revenueLastMonth),
        gross_margin_this_month: `${(d.marginThisMonth * 100).toFixed(1)}%`, gross_margin_last_month: `${(d.marginLastMonth * 100).toFixed(1)}%`,
        units_on_hand: d.units, journals: d.journalCount,
        monthly: d.months.map((m) => ({ month: m.month, revenue: eur(m.revenue), cost_of_sales: eur(m.cogs), gross_profit: eur(m.grossProfit) })),
      };
    }
    case "list_inventory":
      return itemsOverview(db).map((i) => ({ sku: i.sku, name: i.name, category: i.category, on_hand: `${i.qty} ${i.unit}`, avg_cost: eur(i.qty ? Math.round(i.value / i.qty) : 0), value: eur(i.value) }));
    case "reorder_suggestions":
      return reorderInsights(db).map((r) => ({
        sku: r.sku, name: r.name, on_hand: r.qty, sold_last_30_days: r.sold30, per_day: Number(r.perDay.toFixed(2)),
        days_of_cover: r.daysCover === null ? "no recent sales" : Math.round(r.daysCover), status: r.status, suggested_reorder_qty: r.suggested,
      }));
    case "item_history": {
      const sku = String(input.sku ?? "").toUpperCase();
      const item = itemsOverview(db).find((i) => i.sku === sku);
      if (!item) return { error: `No item with SKU ${sku}. Known SKUs: ${itemsOverview(db).map((i) => i.sku).join(", ")}` };
      return {
        item: item.name, on_hand: item.qty, value: eur(item.value),
        movements: stockCard(db, item.id).slice(0, Math.min(Number(input.limit) || 15, 40)).map((m) => ({
          journal: `#${m.journal_id}`, date: m.doc_date, type: KIND_LABEL[m.kind], warehouse: m.wh_code, qty: m.qty, value: eur(m.value), qty_after: m.qty_after, value_after: eur(m.value_after), party: m.counterparty || m.memo,
        })),
      };
    }
    case "income_statement": {
      const r = incomeStatement(db, { from: String(input.from), asOf: String(input.to) });
      const rows = (xs: typeof r.revenue) => xs.filter((x) => x.balance).map((x) => ({ account: x.name, amount: eur(x.balance) }));
      return { revenue: rows(r.revenue), cost_of_sales: rows(r.costOfSales), operating_expenses: rows(r.opex), total_revenue: eur(r.totalRevenue), gross_profit: eur(r.grossProfit), gross_margin: `${(r.grossMargin * 100).toFixed(1)}%`, net_income: eur(r.netIncome) };
    }
    case "balance_sheet": {
      const r = balanceSheet(db, { asOf: String(input.as_of), knownAt: input.known_at ? String(input.known_at) : undefined });
      const rows = (xs: { name: string; balance: number }[]) => xs.map((x) => ({ account: x.name, amount: eur(x.balance) }));
      return { assets: rows(r.assets), liabilities: rows(r.liabilities), equity: rows(r.equity), total_assets: eur(r.totalAssets), total_liabilities_and_equity: eur(r.totalLiabilities + r.totalEquity), balanced: r.balanced };
    }
    case "search_journal":
      return journalsList(db, { q: input.query ? String(input.query) : undefined, kind: input.kind ? String(input.kind) : undefined, limit: Math.min(Number(input.limit) || 10, 30) }).map((j) => ({
        id: `#${j.id}`, date: j.doc_date, type: KIND_LABEL[j.kind], party: j.counterparty, memo: j.memo, reference: j.reference, amount: eur(j.amount),
        status: j.reversed_by ? `reversed by #${j.reversed_by}` : j.reverses_id ? `reverses #${j.reverses_id}` : "posted",
      }));
    case "get_journal": {
      const d = journalDetail(db, Number(input.id));
      if (!d) return { error: `Journal #${input.id} does not exist.` };
      const j = d.journal;
      return {
        id: `#${j.id}`, type: KIND_LABEL[j.kind], date: j.doc_date, posted_at: j.posted_at, party: j.counterparty, memo: j.memo, reference: j.reference,
        reversed_by: j.reversed_by ? `#${j.reversed_by}` : null, reverses: j.reverses_id ? `#${j.reverses_id}` : null, in_closed_period: d.lockedPeriod,
        lines: d.lines.map((l) => ({ account: `${l.account_code} ${l.name}`, debit: l.debit ? eur(l.debit) : "", credit: l.credit ? eur(l.credit) : "" })),
        stock_moves: d.moves.map((m) => ({ sku: m.sku, warehouse: m.wh_code, qty: m.qty, value: eur(m.value), position_after: `${m.qty_after} / ${eur(m.value_after)}` })),
        hash: j.hash,
      };
    }
    case "run_integrity_check": {
      const v = verifyLedger(db);
      return { all_passed: v.ok, journals: v.journals, checks: v.checks.map((c) => ({ check: c.label, passed: c.ok, detail: c.detail })) };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

const hasCredentials = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);

export async function askLedger(db: DB, history: ChatTurn[]): Promise<AssistantReply> {
  const question = history.at(-1)?.text ?? "";
  if (!hasCredentials()) {
    return { ...offline(db, question), notice: "Offline mode: set ANTHROPIC_API_KEY to enable the full Claude assistant." };
  }

  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = history.slice(-12).map((t) => ({ role: t.role, content: t.text }));
  const used = new Set<string>();
  const drafts: DraftLink[] = [];

  try {
    for (let step = 0; step < 8; step++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });

      if (response.stop_reason === "refusal") {
        return { text: "I can't help with that one. Try asking about stock, sales, costs or the books.", tools: [...used], mode: "ai" };
      }
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || !toolUses.length) {
        const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
        return { text: text || "(No answer.)", tools: [...used], mode: "ai", drafts };
      }

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((t) => {
        used.add(TOOL_LABEL[t.name] ?? t.name);
        try {
          return { type: "tool_result", tool_use_id: t.id, content: JSON.stringify(runTool(db, t.name, (t.input ?? {}) as Record<string, unknown>, drafts)) };
        } catch (e) {
          return { type: "tool_result", tool_use_id: t.id, content: `Error: ${(e as Error).message}`, is_error: true };
        }
      });
      messages.push({ role: "user", content: results });
    }
    return { text: "That took too many lookups. Could you narrow the question?", tools: [...used], mode: "ai" };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      return { ...offline(db, question), notice: "The API key was rejected, so I answered in offline mode." };
    }
    if (e instanceof Anthropic.RateLimitError) {
      return { ...offline(db, question), notice: "Claude is rate-limited right now, so I answered in offline mode." };
    }
    if (e instanceof Anthropic.APIConnectionError) {
      return { ...offline(db, question), notice: "Couldn't reach the Claude API, so I answered in offline mode." };
    }
    if (e instanceof Anthropic.APIError) {
      return { text: `The AI service returned an error (${e.status}). Please try again.`, tools: [...used], mode: "ai" };
    }
    throw e;
  }
}

/** Keyword-routed answers so the assistant still helps without an API key. */
function offline(db: DB, q: string): Omit<AssistantReply, "notice"> {
  const s = q.toLowerCase();
  const has = (...w: string[]) => w.some((x) => s.includes(x));

  // "sell 3 ETH-YRG-1K to Café Kranich at 26.90" / "receive 20 COL-HUI-1K at 12.80 from Rösterei Nord"
  const m = q.match(/\b(sell|sold|receive|received|buy|bought|purchase)\s+(\d+)\s*(?:x\s*|×\s*)?([A-Za-z0-9-]{4,})(?:.*?(?:at|@|for)\s*€?\s*(\d+(?:[.,]\d{1,2})?))?(?:.*?\b(?:to|from)\s+(.+?))?(?:\s+(?:at|@|for)\b.*)?$/i);
  if (m) {
    const kind = /sell|sold/i.test(m[1]) ? "SALE" : "RECEIPT";
    const r = buildDraft(db, { kind, counterparty: m[5]?.trim(), lines: [{ sku: m[3], qty: Number(m[2]), unit_amount: m[4]?.replace(",", ".") }] });
    if (r.error) return { text: r.error, tools: [TOOL_LABEL.draft_transaction], mode: "offline" };
    return {
      text: `I prepared a draft **${r.label}**${m[5] ? ` with ${m[5].trim()}` : ""}${m[4] ? ` at €${m[4]} per unit` : ""}. Review it and post it yourself; nothing has been recorded yet.`,
      tools: [TOOL_LABEL.draft_transaction],
      mode: "offline",
      drafts: [{ label: r.label!, href: draftHref(r.draft!) }],
    };
  }
  if (has("anomal", "unusual", "suspicious", "fraud", "odd", "wrong")) {
    const a = detectAnomalies(db).filter((x) => x.severity !== "low").slice(0, 6);
    return {
      text: a.length ? `**${a.length} flagged item(s)** worth a look:\n${a.map((x) => `- ${x.title} (#${x.journalId}): ${x.detail}`).join("\n")}` : "Nothing unusual stands out: costs, margins and write-offs are all within their normal ranges.",
      tools: [TOOL_LABEL.find_anomalies],
      mode: "offline",
    };
  }
  if (has("forecast", "predict", "next month", "next 30", "projection", "stockout", "stock out")) {
    const c = forecastCash(db);
    const d = forecastDemand(db).filter((x) => x.stockoutDate).slice(0, 5);
    return {
      text: `Cash is projected at **${eur(c.projected)}** in 30 days (80% range ${eur(c.low)} – ${eur(c.high)}).\n${d.length ? `Likely stock-outs:\n${d.map((x) => `- \`${x.sku}\` around ${x.stockoutDate} (needs ~${x.forecast30} ${x.unit}, has ${x.onHand})`).join("\n")}` : "No item is projected to run out within 30 days."}`,
      tools: [TOOL_LABEL.cash_forecast, TOOL_LABEL.demand_forecast],
      mode: "offline",
    };
  }
  if (has("vat", "tax")) {
    const v = vatPosition(db);
    return {
      text: `Current VAT position: output **${eur(v.output)}**, input **${eur(v.input)}**, so the net ${v.net >= 0 ? "payable" : "refund"} is **${eur(Math.abs(v.net))}**. Settle it with *New transaction → Cash → Settle VAT*.`,
      tools: [TOOL_LABEL.vat_summary],
      mode: "offline",
    };
  }
  if (has("budget", "target", "plan")) {
    const b = budgetVsActual(db, today().slice(0, 4));
    return {
      text: `Year to date vs budget:\n${b.rows.map((r) => `- ${r.code === ACC.REVENUE ? "Revenue" : r.code === ACC.COGS ? "Cost of goods" : "Operating expenses"}: ${eur(r.ytdActual)} vs ${eur(r.ytdBudget)} (${r.ytdVariance >= 0 ? "favourable" : "unfavourable"} by ${eur(Math.abs(r.ytdVariance))})`).join("\n")}`,
      tools: [TOOL_LABEL.budget_vs_actual],
      mode: "offline",
    };
  }

  if (has("reorder", "low stock", "running out", "restock", "out of stock", "buy")) {
    const rows = reorderInsights(db).filter((r) => r.status === "critical" || r.status === "low");
    if (!rows.length) return { text: "Every item has at least two weeks of cover at the current sales pace. Nothing needs reordering yet.", tools: [TOOL_LABEL.reorder_suggestions], mode: "offline" };
    return {
      text: `**${rows.length} item(s)** need attention:\n${rows.map((r) => `- \`${r.sku}\` ${r.name}: **${Math.round(r.daysCover!)} days** of cover, reorder about **${r.suggested} ${r.unit}**`).join("\n")}`,
      tools: [TOOL_LABEL.reorder_suggestions],
      mode: "offline",
    };
  }
  if (has("integrity", "intact", "tamper", "verify", "hash", "audit", "trust")) {
    const v = verifyLedger(db);
    return {
      text: v.ok
        ? `**All ${v.checks.length} integrity checks passed** across ${v.journals} journals. The hash chain is intact, every entry balances, and closed periods match their sealed snapshots.`
        : `**Integrity problem detected:**\n${v.checks.filter((c) => !c.ok).map((c) => `- ${c.label}: ${c.detail}`).join("\n")}`,
      tools: [TOOL_LABEL.run_integrity_check],
      mode: "offline",
    };
  }
  if (has("reversal", "reversed", "correction", "mistake")) {
    const rows = journalsList(db, { kind: "REVERSAL", limit: 5 });
    if (!rows.length) return { text: "No reversals have been posted yet.", tools: [TOOL_LABEL.search_journal], mode: "offline" };
    return {
      text: `Latest corrections (each is a mirror entry; the original stays in the ledger):\n${rows.map((j) => `- #${j.id} on ${j.doc_date}: ${j.memo}${j.reverses_id ? ` (original #${j.reverses_id})` : ""}`).join("\n")}`,
      tools: [TOOL_LABEL.search_journal],
      mode: "offline",
    };
  }
  if (has("revenue", "sales", "profit", "margin", "income", "month", "compare", "briefing", "summar")) {
    const d = dashboard(db);
    return {
      text: `Revenue this month so far is **${eur(d.revenueThisMonth)}** at a **${(d.marginThisMonth * 100).toFixed(1)}%** gross margin. Last month: ${eur(d.revenueLastMonth)} at ${(d.marginLastMonth * 100).toFixed(1)}%.\n${d.months.slice(-4).map((m) => `- ${m.month}: revenue ${eur(m.revenue)}, gross profit ${eur(m.grossProfit)}`).join("\n")}`,
      tools: [TOOL_LABEL.get_overview],
      mode: "offline",
    };
  }
  if (has("cash", "bank", "owe", "payable", "receivable")) {
    return {
      text: `Cash at bank: **${eur(rawBalance(db, ACC.CASH))}**\n- Customers owe you ${eur(rawBalance(db, ACC.AR))}\n- You owe suppliers ${eur(-rawBalance(db, ACC.AP))}`,
      tools: [TOOL_LABEL.get_overview],
      mode: "offline",
    };
  }
  if (has("inventory", "stock", "value", "worth", "item")) {
    const v = inventoryValuation(db);
    const top = [...itemsOverview(db)].sort((a, b) => b.value - a.value).slice(0, 4);
    return {
      text: `Inventory is worth **${eur(v.total)}** at moving-average cost, and it reconciles with the GL (${v.reconciled ? "✓" : "✗"}).\nLargest positions:\n${top.map((i) => `- \`${i.sku}\` ${i.name}: ${i.qty} ${i.unit}, ${eur(i.value)}`).join("\n")}`,
      tools: [TOOL_LABEL.list_inventory],
      mode: "offline",
    };
  }
  return {
    text: "In offline mode I can answer questions about **inventory**, **reorder needs**, **revenue and margin**, **cash**, **VAT**, **budgets**, **forecasts**, **anomalies** and **integrity**, and draft entries like *\"sell 3 ETH-YRG-1K to Café Kranich at 26.90\"*.",
    tools: [],
    mode: "offline",
  };
}

// ───────────────────────── month-end commentary ─────────────────────────

export type Commentary = { id: number; period: string; created_at: string; source: string; text: string; data_hash: string };

export const commentaries = (db: DB, period?: string) =>
  all<Commentary>(db, `SELECT * FROM commentaries ${period ? "WHERE period = ?" : ""} ORDER BY id DESC LIMIT 24`, ...(period ? [period] : []));

function monthFacts(db: DB, period: string) {
  const [y, m] = period.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const cur = incomeStatement(db, { from: `${period}-01`, asOf: monthEnd(period) });
  const before = incomeStatement(db, { from: `${prev}-01`, asOf: monthEnd(prev) });
  const budget = budgetVsActual(db, String(y)).rows.map((r) => {
    const c = r.cells[m - 1];
    return { account: r.code, actual: c.actual, budget: c.budget };
  });
  const flags = detectAnomalies(db, { since: `${period}-01` }).filter((a) => a.date <= monthEnd(period) && a.severity !== "low").slice(0, 8);
  const vat = vatReport(db, { from: `${period}-01`, asOf: monthEnd(period) });
  const top = all<{ sku: string; units: number; revenue: number }>(
    db,
    `SELECT i.sku, -SUM(m.qty) units, 0 revenue FROM stock_moves m JOIN journals j ON j.id = m.journal_id JOIN items i ON i.id = m.item_id
     WHERE j.kind = 'SALE' AND m.doc_date BETWEEN ? AND ? GROUP BY i.sku ORDER BY units DESC LIMIT 3`,
    `${period}-01`,
    monthEnd(period),
  );
  return {
    period,
    closed: (lockedThrough(db) ?? "") >= period,
    revenue: cur.totalRevenue, revenue_prev: before.totalRevenue,
    gross_margin: cur.grossMargin, gross_margin_prev: before.grossMargin,
    opex: cur.totalOpex, fx_net: cur.otherNet, net_income: cur.netIncome, net_income_prev: before.netIncome,
    budget, vat_net: vat.net, top_sellers: top.map((t) => `${t.sku} (${t.units})`),
    flags: flags.map((f) => ({ title: f.title, detail: f.detail, journal: f.journalId })),
  };
}

function templateCommentary(f: ReturnType<typeof monthFacts>) {
  const pct = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(1)}%` : "n/a");
  const rev = f.budget.find((b) => b.account === ACC.REVENUE);
  const lines = [
    `**Summary.** Revenue was ${eur(f.revenue)} (${pct(f.revenue, f.revenue_prev)} vs the prior month) at a ${(f.gross_margin * 100).toFixed(1)}% gross margin (${((f.gross_margin - f.gross_margin_prev) * 100).toFixed(1)} pt). Net income: ${eur(f.net_income)}.`,
    rev?.budget ? `**Budget.** Revenue came in ${f.revenue >= rev.budget ? "ahead of" : "behind"} budget by ${eur(Math.abs(f.revenue - rev.budget))} (${pct(f.revenue, rev.budget)}).` : "",
    f.fx_net ? `**FX.** Realised currency ${f.fx_net >= 0 ? "gains" : "losses"} of ${eur(Math.abs(f.fx_net))} on supplier payments.` : "",
    `**VAT.** Net ${f.vat_net >= 0 ? "payable" : "refundable"} for the month: ${eur(Math.abs(f.vat_net))}.`,
    f.top_sellers.length ? `**Top sellers.** ${f.top_sellers.join(", ")}.` : "",
    f.flags.length ? `**Watch-outs.**\n${f.flags.map((x) => `- ${x.title}${x.journal ? ` (#${x.journal})` : ""}`).join("\n")}` : "**Watch-outs.** No significant anomalies were detected.",
  ];
  return lines.filter(Boolean).join("\n\n");
}

/** Writes an AI (or template) month-end commentary and stores it append-only with a hash of its source data. */
export async function generateCommentary(db: DB, period: string): Promise<Commentary & { notice?: string }> {
  const facts = monthFacts(db, period);
  const dataHash = sha256(JSON.stringify(facts));
  let text = "";
  let source = "template";
  let notice: string | undefined;
  if (hasCredentials()) {
    try {
      const client = new Anthropic();
      const r = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system:
          "You write concise month-end management commentary for a small wholesaler's owner. Use only the figures provided (amounts are EUR cents; convert to euros with 2 decimals). 4–6 short paragraphs with bold lead-ins: Summary, Margin, Budget, Cash & VAT, Watch-outs (cite journal ids as #123), Next steps. No preamble.",
        messages: [{ role: "user", content: `Facts for ${period}:\n${JSON.stringify(facts)}` }],
      });
      if (r.stop_reason !== "refusal") {
        text = r.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
        source = `claude:${r.model}`;
      }
    } catch (e) {
      if (!(e instanceof Anthropic.APIError)) throw e;
      notice = "Claude was unavailable, so a template commentary was written instead.";
    }
  }
  if (!text) text = templateCommentary(facts);
  const at = new Date().toISOString();
  const res = run(db, "INSERT INTO commentaries (period, created_at, source, text, data_hash) VALUES (?, ?, ?, ?, ?)", period, at, source, text, dataHash);
  return { id: Number(res.lastInsertRowid), period, created_at: at, source, text, data_hash: dataHash, notice };
}
