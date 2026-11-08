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
import { rawBalance, today } from "./ledger";
import { fmtMoney } from "./money";
import {
  balanceSheet, dashboard, incomeStatement, inventoryValuation, itemsOverview, journalDetail, journalsList,
  reorderInsights, stockCard,
} from "./reports";

export type ChatTurn = { role: "user" | "assistant"; text: string };
export type AssistantReply = { text: string; tools: string[]; mode: "ai" | "offline"; notice?: string };

const MODEL = "claude-opus-5-5";
const eur = (c: number) => fmtMoney(c);

const SYSTEM = `You are Ledger Copilot, the assistant inside Ledgerline, an append-only inventory ledger and financial reporting app for a small coffee wholesaler (currency EUR).

Use the tools to look up real figures before answering any question about stock, sales, costs, cash or the books; never guess numbers. Cite the figures you used, and mention journal ids as #123 and SKUs in backticks so the user can find them.

You are read-only. If the user wants to post, reverse or close something, explain the steps in the app (New transaction, the Reverse button on a journal, or the Periods page) instead of claiming you did it. Ledger rules you can explain: entries are never edited, corrections are reversals; moving-average costing in cents; no backdating before an item's latest movement; closed months are locked and their snapshots verified; each journal is SHA-256 hash-chained.

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
};

function runTool(db: DB, name: string, input: Record<string, unknown>): unknown {
  switch (name) {
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
        return { text: text || "(No answer.)", tools: [...used], mode: "ai" };
      }

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((t) => {
        used.add(TOOL_LABEL[t.name] ?? t.name);
        try {
          return { type: "tool_result", tool_use_id: t.id, content: JSON.stringify(runTool(db, t.name, (t.input ?? {}) as Record<string, unknown>)) };
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
    text: "In offline mode I can answer questions about **inventory value**, **reorder needs**, **revenue and margin**, **cash and balances**, and **ledger integrity**. Try one of the suggestions below.",
    tools: [],
    mode: "offline",
  };
}
