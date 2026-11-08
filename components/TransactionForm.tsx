"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Banknote, PackageMinus, PackagePlus, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { ACC, ACCOUNT_NAME } from "@/lib/accounts";
import type { JournalKind } from "@/lib/accounts";
import type { TxPayload } from "@/lib/actions";
import { postTransaction } from "@/lib/actions";
import type { CashType } from "@/lib/ledger";
import { fmtMoney, fmtMonth, fmtQty, parseMoney, parseQty } from "@/lib/money";
import { ErrorNote } from "./forms";

export type ItemOption = {
  id: number;
  sku: string;
  name: string;
  unit: string;
  byWarehouse: Record<number, { qty: number; value: number }>;
};
type Wh = { id: number; code: string; name: string };
type Kind = Exclude<JournalKind, "REVERSAL">;
type Row = { key: number; itemId: string; qty: string; amount: string };

const TABS: { kind: Kind; label: string; cta: string; icon: typeof Plus; help: string }[] = [
  { kind: "RECEIPT", label: "Receive", cta: "Post goods receipt", icon: PackagePlus, help: "Goods arrive from a supplier at a known cost." },
  { kind: "SALE", label: "Sell", cta: "Post sale", icon: ShoppingCart, help: "Goods leave at moving-average cost, and revenue is recognised." },
  { kind: "TRANSFER", label: "Transfer", cta: "Post transfer", icon: ArrowLeftRight, help: "Move stock between warehouses at cost, with no profit impact." },
  { kind: "ADJUSTMENT", label: "Adjust", cta: "Post adjustment", icon: PackageMinus, help: "Correct quantities after a count, damage or loss." },
  { kind: "PAYMENT", label: "Cash", cta: "Post cash movement", icon: Banknote, help: "Pay suppliers, collect from customers, pay expenses or add capital." },
];

const CASH_TYPES: { value: CashType; label: string }[] = [
  { value: "RECEIVE_CUSTOMER", label: "Receive from customer" },
  { value: "PAY_SUPPLIER", label: "Pay supplier" },
  { value: "EXPENSE", label: "Pay operating expense" },
  { value: "CAPITAL", label: "Owner adds capital" },
];

let rowKey = 1;
const blankRow = (): Row => ({ key: rowKey++, itemId: "", qty: "", amount: "" });

export function TransactionForm({
  items, warehouses, today, lockedThrough, payables, receivables,
}: {
  items: ItemOption[];
  warehouses: Wh[];
  today: string;
  lockedThrough: string | null;
  payables: number;
  receivables: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());

  const [kind, setKind] = useState<Kind>("RECEIPT");
  const [docDate, setDocDate] = useState(today);
  const [warehouseId, setWarehouseId] = useState(String(warehouses[0]?.id ?? ""));
  const [toWarehouseId, setToWarehouseId] = useState(String(warehouses[1]?.id ?? warehouses[0]?.id ?? ""));
  const [counterparty, setCounterparty] = useState("");
  const [reference, setReference] = useState("");
  const [memo, setMemo] = useState("");
  const [paid, setPaid] = useState(false);
  const [cashType, setCashType] = useState<CashType>("RECEIVE_CUSTOMER");
  const [cashAmount, setCashAmount] = useState("");
  const [rows, setRows] = useState<Row[]>([blankRow()]);

  const wh = Number(warehouseId);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const minDate = lockedThrough ? nextDay(lockedThrough) : undefined;

  const position = (itemId: number, w = wh) => itemById.get(itemId)?.byWarehouse[w] ?? { qty: 0, value: 0 };
  const avg = (itemId: number, w = wh) => {
    const p = position(itemId, w);
    return p.qty ? p.value / p.qty : 0;
  };

  // Client-side estimate of the journal. The server recomputes everything; this only shows intent.
  const preview = useMemo(() => {
    const parsed = rows.map((r) => ({
      itemId: Number(r.itemId),
      qty: parseQty(r.qty, kind === "ADJUSTMENT") ?? 0,
      amount: r.amount === "" ? null : parseMoney(r.amount),
    }));
    const valid = parsed.filter((p) => p.itemId && p.qty);
    const lines: { account: string; debit: number; credit: number }[] = [];
    let estimated = false;
    if (kind === "RECEIPT") {
      const total = valid.reduce((s, l) => s + l.qty * (l.amount ?? 0), 0);
      lines.push({ account: ACC.INV, debit: total, credit: 0 }, { account: paid ? ACC.CASH : ACC.AP, debit: 0, credit: total });
    } else if (kind === "SALE") {
      const rev = valid.reduce((s, l) => s + l.qty * (l.amount ?? 0), 0);
      const cogs = valid.reduce((s, l) => s + Math.round(l.qty * avg(l.itemId)), 0);
      estimated = true;
      lines.push(
        { account: paid ? ACC.CASH : ACC.AR, debit: rev, credit: 0 },
        { account: ACC.REVENUE, debit: 0, credit: rev },
        { account: ACC.COGS, debit: cogs, credit: 0 },
        { account: ACC.INV, debit: 0, credit: cogs },
      );
    } else if (kind === "ADJUSTMENT") {
      const net = valid.reduce((s, l) => s + Math.round(l.qty * (l.qty > 0 && l.amount !== null ? l.amount : avg(l.itemId))), 0);
      estimated = true;
      if (net >= 0) lines.push({ account: ACC.INV, debit: net, credit: 0 }, { account: ACC.SHRINK, debit: 0, credit: net });
      else lines.push({ account: ACC.SHRINK, debit: -net, credit: 0 }, { account: ACC.INV, debit: 0, credit: -net });
    } else if (kind === "PAYMENT") {
      const amt = parseMoney(cashAmount) ?? 0;
      const pairs: Record<CashType, [string, string]> = {
        PAY_SUPPLIER: [ACC.AP, ACC.CASH],
        RECEIVE_CUSTOMER: [ACC.CASH, ACC.AR],
        EXPENSE: [ACC.OPEX, ACC.CASH],
        CAPITAL: [ACC.CASH, ACC.EQUITY],
      };
      lines.push({ account: pairs[cashType][0], debit: amt, credit: 0 }, { account: pairs[cashType][1], debit: 0, credit: amt });
    }
    const value = kind === "TRANSFER" ? valid.reduce((s, l) => s + Math.round(l.qty * avg(l.itemId)), 0) : 0;
    return { lines, estimated, transferValue: value };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, kind, paid, cashType, cashAmount, warehouseId, items]);

  const setRow = (k: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...patch } : r)));

  function build(): TxPayload | string {
    const base = { docDate, reference, memo, idempotencyKey: key.current };
    if (kind === "PAYMENT") {
      const amount = parseMoney(cashAmount);
      if (!amount) return "Enter an amount, for example 120.50.";
      return { ...base, kind, cashType, amount, counterparty };
    }
    const lines: { itemId: number; qty: number; amount?: number }[] = [];
    for (const [n, r] of rows.entries()) {
      if (!r.itemId && !r.qty && !r.amount) continue;
      const item = itemById.get(Number(r.itemId));
      if (!item) return `Line ${n + 1}: choose an item.`;
      const qty = parseQty(r.qty, kind === "ADJUSTMENT");
      if (!qty) return `Line ${n + 1}: enter a whole-number quantity${kind === "ADJUSTMENT" ? " (negative to remove)" : ""}.`;
      let amount: number | undefined;
      if (kind === "RECEIPT" || kind === "SALE") {
        const a = parseMoney(r.amount);
        if (a === null) return `Line ${n + 1}: enter a unit ${kind === "SALE" ? "price" : "cost"}.`;
        amount = a;
      } else if (kind === "ADJUSTMENT" && r.amount.trim()) {
        const a = parseMoney(r.amount);
        if (a === null) return `Line ${n + 1}: unit cost is not a valid amount.`;
        amount = a;
      }
      lines.push({ itemId: item.id, qty, amount });
    }
    if (!lines.length) return "Add at least one line.";
    if (kind === "RECEIPT" || kind === "SALE") {
      return { ...base, kind, warehouseId: wh, counterparty, paid, lines: lines.map((l) => ({ ...l, amount: l.amount! })) };
    }
    if (kind === "TRANSFER") return { ...base, kind, warehouseId: wh, toWarehouseId: Number(toWarehouseId), lines };
    return { ...base, kind, warehouseId: wh, lines };
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const payload = build();
    if (typeof payload === "string") return setError(payload);
    setError(null);
    start(async () => {
      const r = await postTransaction(payload);
      if (r.ok) {
        key.current = crypto.randomUUID();
        router.push(`/transactions/${r.id}`);
      } else {
        setError(r.error);
        key.current = crypto.randomUUID();
      }
    });
  }

  const tab = TABS.find((t) => t.kind === kind)!;
  const amountLabel = kind === "SALE" ? "Unit price" : kind === "ADJUSTMENT" ? "Unit cost (optional)" : "Unit cost";
  const hasAmount = kind === "RECEIPT" || kind === "SALE" || kind === "ADJUSTMENT";
  const debits = preview.lines.reduce((s, l) => s + l.debit, 0);

  return (
    <form onSubmit={submit} className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {TABS.map(({ kind: k, label, icon: Icon }) => (
            <button
              type="button"
              key={k}
              onClick={() => { setKind(k); setError(null); }}
              className={`flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-sm font-medium transition ${
                kind === k ? "border-accent bg-accent-soft text-accent ring-4 ring-accent/10" : "border-line bg-surface text-muted hover:text-ink"
              }`}
            >
              <Icon className="size-5" />
              {label}
            </button>
          ))}
        </div>

        <section className="rounded-2xl border border-line bg-surface p-5 shadow-card">
          <p className="mb-5 text-sm text-muted">{tab.help}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="label" htmlFor="date">Document date</label>
              <input id="date" type="date" className="field" value={docDate} min={minDate} max={today} onChange={(e) => setDocDate(e.target.value)} required />
            </div>
            {kind !== "PAYMENT" && (
              <div>
                <label className="label" htmlFor="wh">{kind === "TRANSFER" ? "From warehouse" : "Warehouse"}</label>
                <select id="wh" className="field" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
            )}
            {kind === "TRANSFER" && (
              <div>
                <label className="label" htmlFor="to">To warehouse</label>
                <select id="to" className="field" value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
                  {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
            )}
            {kind === "PAYMENT" && (
              <>
                <div>
                  <label className="label" htmlFor="ctype">Type</label>
                  <select id="ctype" className="field" value={cashType} onChange={(e) => setCashType(e.target.value as CashType)}>
                    {CASH_TYPES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="amt">Amount (EUR)</label>
                  <input id="amt" inputMode="decimal" className="field num" placeholder="0.00" value={cashAmount} onChange={(e) => setCashAmount(e.target.value)} />
                  <p className="mt-1 text-[11px] text-muted">
                    {cashType === "PAY_SUPPLIER" && `Owed to suppliers: ${fmtMoney(payables)}`}
                    {cashType === "RECEIVE_CUSTOMER" && `Owed by customers: ${fmtMoney(receivables)}`}
                  </p>
                </div>
              </>
            )}
            {(kind === "RECEIPT" || kind === "SALE" || kind === "PAYMENT") && (
              <div>
                <label className="label" htmlFor="cp">{kind === "RECEIPT" ? "Supplier" : kind === "SALE" ? "Customer" : "Counterparty"}</label>
                <input id="cp" className="field" value={counterparty} onChange={(e) => setCounterparty(e.target.value)} placeholder={kind === "SALE" ? "Café Kranich" : "Rösterei Nord GmbH"} />
              </div>
            )}
            <div>
              <label className="label" htmlFor="ref">Reference</label>
              <input id="ref" className="field" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={kind === "SALE" ? "INV-2041" : "PO-1088"} />
            </div>
            <div className={kind === "ADJUSTMENT" ? "sm:col-span-2" : ""}>
              <label className="label" htmlFor="memo">{kind === "ADJUSTMENT" ? "Reason (required)" : "Memo"}</label>
              <input id="memo" className="field" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={kind === "ADJUSTMENT" ? "Stock count: 2 damaged" : "Optional"} />
            </div>
          </div>
          {(kind === "RECEIPT" || kind === "SALE") && (
            <label className="mt-4 flex w-fit cursor-pointer items-center gap-2.5 text-sm text-ink">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
              {kind === "RECEIPT" ? "Paid immediately (otherwise on account, as payable)" : "Paid immediately (otherwise invoiced, as receivable)"}
            </label>
          )}
        </section>

        {kind !== "PAYMENT" && (
          <section className="rounded-2xl border border-line bg-surface shadow-card">
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <h2 className="text-sm font-semibold">Lines</h2>
              <button type="button" className="btn-ghost px-2.5! py-1.5! text-xs" onClick={() => setRows((r) => [...r, blankRow()])}>
                <Plus className="size-3.5" /> Add line
              </button>
            </div>
            <div className="divide-y divide-line/70">
              {rows.map((r, n) => {
                const id = Number(r.itemId);
                const item = itemById.get(id);
                const pos = position(id);
                const qty = parseQty(r.qty, kind === "ADJUSTMENT") ?? 0;
                const amt = parseMoney(r.amount);
                const over = item && kind !== "RECEIPT" && (kind === "ADJUSTMENT" ? -qty : qty) > pos.qty;
                return (
                  <div key={r.key} className="grid grid-cols-12 items-start gap-3 px-5 py-4">
                    <div className="col-span-12 sm:col-span-5">
                      {n === 0 && <span className="label">Item</span>}
                      <select className="field" value={r.itemId} onChange={(e) => setRow(r.key, { itemId: e.target.value })}>
                        <option value="">Choose item…</option>
                        {items.map((i) => <option key={i.id} value={i.id}>{i.sku} · {i.name}</option>)}
                      </select>
                      {item && (
                        <p className={`num mt-1 text-[11px] ${over ? "text-neg" : "text-muted"}`}>
                          {fmtQty(pos.qty)} {item.unit} on hand · avg {fmtMoney(Math.round(avg(id)))}
                        </p>
                      )}
                    </div>
                    <div className={hasAmount ? "col-span-5 sm:col-span-2" : "col-span-10 sm:col-span-6"}>
                      {n === 0 && <span className="label">{kind === "ADJUSTMENT" ? "Qty ±" : "Qty"}</span>}
                      <input inputMode="numeric" className="field num" placeholder={kind === "ADJUSTMENT" ? "-2" : "10"} value={r.qty} onChange={(e) => setRow(r.key, { qty: e.target.value })} />
                    </div>
                    {hasAmount && (
                      <div className="col-span-5 sm:col-span-3">
                        {n === 0 && <span className="label">{amountLabel}</span>}
                        <input inputMode="decimal" className="field num" placeholder={kind === "ADJUSTMENT" ? "avg cost" : "0.00"} value={r.amount} onChange={(e) => setRow(r.key, { amount: e.target.value })} disabled={kind === "ADJUSTMENT" && qty < 0} />
                        {(kind === "RECEIPT" || kind === "SALE") && qty > 0 && amt !== null && (
                          <p className="num mt-1 text-[11px] text-muted">
                            = {fmtMoney(qty * amt)}
                            {kind === "SALE" && item && avg(id) > 0 && ` · margin ${(((amt - avg(id)) / amt) * 100 || 0).toFixed(0)}%`}
                          </p>
                        )}
                      </div>
                    )}
                    <div className="col-span-2 flex justify-end sm:col-span-1">
                      {n === 0 && <span className="label invisible">x</span>}
                      <button type="button" aria-label="Remove line" className="grid size-9 place-items-center rounded-lg text-muted hover:bg-neg-soft hover:text-neg disabled:opacity-30" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      <aside className="xl:sticky xl:top-8 xl:self-start">
        <section className="rounded-2xl border border-line bg-surface shadow-card">
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-sm font-semibold">Journal preview</h2>
            <p className="mt-0.5 text-xs text-muted">
              {preview.estimated ? "Cost at current moving average (estimate). The server computes the exact figures." : "The double entry this will post."}
            </p>
          </div>
          <div className="px-5 py-4">
            {kind === "TRANSFER" ? (
              <p className="text-sm text-muted">
                No general-ledger lines. About <span className="num font-medium text-ink">{fmtMoney(preview.transferValue)}</span> of inventory moves between locations at cost, so the total value is unchanged.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] tracking-wider text-muted uppercase">
                    <th className="pb-2 text-left font-semibold">Account</th>
                    <th className="pb-2 text-right font-semibold">Dr</th>
                    <th className="pb-2 text-right font-semibold">Cr</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((l, i) => (
                    <tr key={i} className="border-t border-line/70">
                      <td className={`py-2 ${l.credit ? "pl-4" : ""}`}>
                        <span className="block text-ink">{ACCOUNT_NAME[l.account]}</span>
                        <span className="font-mono text-[11px] text-muted">{l.account}</span>
                      </td>
                      <td className="num py-2 text-right">{l.debit ? fmtMoney(l.debit) : ""}</td>
                      <td className="num py-2 text-right">{l.credit ? fmtMoney(l.credit) : ""}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-line font-semibold">
                    <td className="py-2 text-xs text-muted">Balanced</td>
                    <td className="num py-2 text-right">{fmtMoney(debits)}</td>
                    <td className="num py-2 text-right">{fmtMoney(debits)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
          <div className="space-y-3 border-t border-line px-5 py-4">
            <ErrorNote message={error} />
            <button className="btn-primary w-full py-2.5" disabled={pending}>{pending ? "Posting…" : tab.cta}</button>
            <p className="text-center text-[11px] text-muted">
              Posted entries are permanent and hash-chained.{lockedThrough && ` Books are locked through ${fmtMonth(lockedThrough)}.`}
            </p>
          </div>
        </section>
      </aside>
    </form>
  );
}

function nextDay(period: string) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}
