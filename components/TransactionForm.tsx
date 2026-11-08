"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Banknote, Globe2, PackageMinus, PackagePlus, Plus, ShoppingCart, Sparkles, Trash2 } from "lucide-react";
import { ACC, ACCOUNT_NAME, CURRENCIES, CURRENCY_DECIMALS, VAT_RATES } from "@/lib/accounts";
import type { Currency } from "@/lib/accounts";
import type { TxPayload } from "@/lib/actions";
import { postTransaction } from "@/lib/actions";
import type { TxDraft } from "@/lib/draft";
import type { CashType, OpenForeignInvoice } from "@/lib/ledger";
import { fmtMoney, fmtMonth, fmtQty, parseMoney, parseQty } from "@/lib/money";
import { ErrorNote } from "./forms";

export type ItemOption = {
  id: number;
  sku: string;
  name: string;
  unit: string;
  vatRate: number;
  byWarehouse: Record<number, { qty: number; value: number }>;
};
type Wh = { id: number; code: string; name: string };
type Kind = "RECEIPT" | "SALE" | "TRANSFER" | "ADJUSTMENT" | "PAYMENT";
type Row = { key: number; itemId: string; qty: string; amount: string; vat: string };
type CashMode = CashType | "SETTLE_FX";

const TABS: { kind: Kind; label: string; cta: string; icon: typeof Plus; help: string }[] = [
  { kind: "RECEIPT", label: "Receive", cta: "Post goods receipt", icon: PackagePlus, help: "Goods arrive from a supplier. Enter net unit costs; VAT is added per line. Foreign-currency invoices are converted at the rate you enter." },
  { kind: "SALE", label: "Sell", cta: "Post sale", icon: ShoppingCart, help: "Goods leave at moving-average cost. Revenue is recognised net, and output VAT is added per line." },
  { kind: "TRANSFER", label: "Transfer", cta: "Post transfer", icon: ArrowLeftRight, help: "Move stock between warehouses at cost, with no profit impact." },
  { kind: "ADJUSTMENT", label: "Adjust", cta: "Post adjustment", icon: PackageMinus, help: "Correct quantities after a count, damage or loss." },
  { kind: "PAYMENT", label: "Cash", cta: "Post cash movement", icon: Banknote, help: "Pay suppliers (including foreign invoices), collect from customers, settle VAT, pay expenses or add capital." },
];

const CASH_TYPES: { value: CashMode; label: string }[] = [
  { value: "RECEIVE_CUSTOMER", label: "Receive from customer" },
  { value: "PAY_SUPPLIER", label: "Pay supplier (EUR)" },
  { value: "SETTLE_FX", label: "Pay foreign-currency invoice" },
  { value: "PAY_VAT", label: "Settle VAT with tax office" },
  { value: "EXPENSE", label: "Pay operating expense" },
  { value: "CAPITAL", label: "Owner adds capital" },
];

let rowKey = 1;
const blankRow = (): Row => ({ key: rowKey++, itemId: "", qty: "", amount: "", vat: "" });

/** Parse an amount in a currency's major units into minor units (JPY has no decimals). */
function parseIn(currency: Currency, s: string) {
  if (CURRENCY_DECIMALS[currency] === 0) return /^\d{1,12}$/.test(s.trim()) ? Number(s.trim()) : null;
  return parseMoney(s);
}

/** Client-side estimate only; the server converts with exact integer arithmetic. */
function estEur(minor: number, currency: Currency, rate: string) {
  const r = Number(rate);
  if (!r) return 0;
  return Math.round((minor / 10 ** CURRENCY_DECIMALS[currency]) * r * 100);
}

const fmtForeign = (minor: number, c: Currency) =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency: c }).format(minor / 10 ** CURRENCY_DECIMALS[c]);

export type ContactOption = { id: number; name: string; kind: "CUSTOMER" | "SUPPLIER"; currency: string };

export function TransactionForm({
  items, warehouses, today, lockedThrough, payables, receivables, vatNet, openInvoices, draft, contacts, allowed, threshold,
}: {
  contacts: ContactOption[];
  allowed: Kind[];
  threshold: number;
  items: ItemOption[];
  warehouses: Wh[];
  today: string;
  lockedThrough: string | null;
  payables: number;
  receivables: number;
  vatNet: number;
  openInvoices: OpenForeignInvoice[];
  draft: TxDraft | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());

  const [kind, setKind] = useState<Kind>(draft?.kind && allowed.includes(draft.kind) ? draft.kind : (allowed[0] ?? "RECEIPT"));
  const [contactId, setContactId] = useState(draft?.contactId ? String(draft.contactId) : "");
  const [queued, setQueued] = useState<number | null>(null);
  const orderId = draft?.orderId;
  const [docDate, setDocDate] = useState(today);
  const [warehouseId, setWarehouseId] = useState(String(draft?.warehouseId ?? warehouses[0]?.id ?? ""));
  const [toWarehouseId, setToWarehouseId] = useState(String(draft?.toWarehouseId ?? warehouses[1]?.id ?? warehouses[0]?.id ?? ""));
  const [counterparty, setCounterparty] = useState(draft?.counterparty ?? "");
  const [reference, setReference] = useState(draft?.reference ?? "");
  const [memo, setMemo] = useState(draft?.memo ?? "");
  const [paid, setPaid] = useState(draft?.paid ?? false);
  const [currency, setCurrency] = useState<Currency>((draft?.currency as Currency) ?? "EUR");
  const [fxRate, setFxRate] = useState(draft?.fxRate ?? "");
  const [cashType, setCashType] = useState<CashMode>(draft?.cashType ?? "RECEIVE_CUSTOMER");
  const [cashAmount, setCashAmount] = useState(draft?.amount ?? "");
  const [settleId, setSettleId] = useState(String(openInvoices[0]?.id ?? ""));
  const [rows, setRows] = useState<Row[]>(
    draft?.lines?.length
      ? draft.lines.map((l) => ({ key: rowKey++, itemId: String(l.itemId), qty: l.qty, amount: l.amount, vat: l.vatRate !== undefined ? String(l.vatRate) : "" }))
      : [blankRow()],
  );

  const wh = Number(warehouseId);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const minDate = lockedThrough ? nextDay(lockedThrough) : undefined;
  const foreign = kind === "RECEIPT" && currency !== "EUR";
  const invoice = openInvoices.find((o) => String(o.id) === settleId);

  const position = (itemId: number, w = wh) => itemById.get(itemId)?.byWarehouse[w] ?? { qty: 0, value: 0 };
  const avg = (itemId: number, w = wh) => {
    const p = position(itemId, w);
    return p.qty ? p.value / p.qty : 0;
  };
  const vatFor = (r: Row) => (foreign ? 0 : r.vat !== "" ? Number(r.vat) : (itemById.get(Number(r.itemId))?.vatRate ?? 19));

  const preview = useMemo(() => {
    const parsed = rows.map((r) => ({
      itemId: Number(r.itemId),
      qty: parseQty(r.qty, kind === "ADJUSTMENT") ?? 0,
      amount: r.amount === "" ? null : kind === "RECEIPT" ? parseIn(currency, r.amount) : parseMoney(r.amount),
      vat: vatFor(r),
    }));
    const valid = parsed.filter((p) => p.itemId && p.qty);
    const lines: { account: string; debit: number; credit: number }[] = [];
    let estimated = false;
    if (kind === "RECEIPT") {
      const net = valid.reduce((s, l) => s + (foreign ? estEur(l.qty * (l.amount ?? 0), currency, fxRate) : l.qty * (l.amount ?? 0)), 0);
      const vat = valid.reduce((s, l) => s + Math.round(((foreign ? 0 : l.qty * (l.amount ?? 0)) * l.vat) / 100), 0);
      estimated = foreign;
      lines.push({ account: ACC.INV, debit: net, credit: 0 });
      if (vat) lines.push({ account: ACC.VAT_IN, debit: vat, credit: 0 });
      lines.push({ account: paid ? ACC.CASH : ACC.AP, debit: 0, credit: net + vat });
    } else if (kind === "SALE") {
      const rev = valid.reduce((s, l) => s + l.qty * (l.amount ?? 0), 0);
      const vat = valid.reduce((s, l) => s + Math.round((l.qty * (l.amount ?? 0) * l.vat) / 100), 0);
      const cogs = valid.reduce((s, l) => s + Math.round(l.qty * avg(l.itemId)), 0);
      estimated = true;
      lines.push(
        { account: paid ? ACC.CASH : ACC.AR, debit: rev + vat, credit: 0 },
        { account: ACC.REVENUE, debit: 0, credit: rev },
      );
      if (vat) lines.push({ account: ACC.VAT_OUT, debit: 0, credit: vat });
      lines.push({ account: ACC.COGS, debit: cogs, credit: 0 }, { account: ACC.INV, debit: 0, credit: cogs });
    } else if (kind === "ADJUSTMENT") {
      const net = valid.reduce((s, l) => s + Math.round(l.qty * (l.qty > 0 && l.amount !== null ? l.amount : avg(l.itemId))), 0);
      estimated = true;
      if (net >= 0) lines.push({ account: ACC.INV, debit: net, credit: 0 }, { account: ACC.SHRINK, debit: 0, credit: net });
      else lines.push({ account: ACC.SHRINK, debit: -net, credit: 0 }, { account: ACC.INV, debit: 0, credit: -net });
    } else if (kind === "PAYMENT") {
      if (cashType === "SETTLE_FX") {
        if (invoice) {
          const paidEur = estEur(invoice.foreign_amount, invoice.currency, fxRate);
          const diff = paidEur - invoice.eur_amount;
          estimated = true;
          lines.push({ account: ACC.AP, debit: invoice.eur_amount, credit: 0 }, { account: ACC.CASH, debit: 0, credit: paidEur });
          if (diff > 0) lines.push({ account: ACC.FX_LOSS, debit: diff, credit: 0 });
          if (diff < 0) lines.push({ account: ACC.FX_GAIN, debit: 0, credit: -diff });
        }
      } else if (cashType === "PAY_VAT") {
        lines.push(vatNet >= 0 ? { account: ACC.VAT_OUT, debit: vatNet, credit: 0 } : { account: ACC.CASH, debit: -vatNet, credit: 0 });
        lines.push(vatNet >= 0 ? { account: ACC.CASH, debit: 0, credit: vatNet } : { account: ACC.VAT_IN, debit: 0, credit: -vatNet });
      } else {
        const amt = parseMoney(cashAmount) ?? 0;
        const pairs: Record<Exclude<CashMode, "SETTLE_FX" | "PAY_VAT">, [string, string]> = {
          PAY_SUPPLIER: [ACC.AP, ACC.CASH],
          RECEIVE_CUSTOMER: [ACC.CASH, ACC.AR],
          EXPENSE: [ACC.OPEX, ACC.CASH],
          CAPITAL: [ACC.CASH, ACC.EQUITY],
        };
        lines.push({ account: pairs[cashType][0], debit: amt, credit: 0 }, { account: pairs[cashType][1], debit: 0, credit: amt });
      }
    }
    const value = kind === "TRANSFER" ? valid.reduce((s, l) => s + Math.round(l.qty * avg(l.itemId)), 0) : 0;
    return { lines, estimated, transferValue: value };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, kind, paid, cashType, cashAmount, warehouseId, items, currency, fxRate, settleId, vatNet]);

  const setRow = (k: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...patch } : r)));

  const contactKind = kind === "SALE" || (kind === "PAYMENT" && cashType === "RECEIVE_CUSTOMER") ? "CUSTOMER" : kind === "RECEIPT" || (kind === "PAYMENT" && cashType === "PAY_SUPPLIER") ? "SUPPLIER" : null;
  const contactChoices = contacts.filter((c) => c.kind === contactKind);
  function chooseContact(id: string) {
    setContactId(id);
    const c = contacts.find((x) => String(x.id) === id);
    if (c) {
      setCounterparty(c.name);
      if (kind === "RECEIPT") setCurrency(c.currency as Currency);
    }
  }

  function build(): TxPayload | string {
    const validContact = contactKind && contacts.some((c) => String(c.id) === contactId && c.kind === contactKind);
    const base = { docDate, reference, memo, idempotencyKey: key.current, contactId: validContact ? Number(contactId) : undefined, orderId: kind === "RECEIPT" || kind === "SALE" ? orderId : undefined };
    if (kind === "PAYMENT") {
      if (cashType === "SETTLE_FX") {
        if (!invoice) return "Choose the foreign-currency invoice to pay.";
        if (!fxRate.trim()) return "Enter today's exchange rate.";
        return { ...base, kind: "SETTLE_FX", receiptId: invoice.id, fxRate: fxRate.trim() };
      }
      if (cashType === "PAY_VAT") return { ...base, kind, cashType, amount: 0, counterparty };
      const amount = parseMoney(cashAmount);
      if (!amount) return "Enter an amount, for example 120.50.";
      return { ...base, kind, cashType, amount, counterparty };
    }
    if (foreign && !fxRate.trim()) return `Enter the ${currency} → EUR exchange rate.`;
    const lines: { itemId: number; qty: number; amount?: number; vatRate?: number }[] = [];
    for (const [n, r] of rows.entries()) {
      if (!r.itemId && !r.qty && !r.amount) continue;
      const item = itemById.get(Number(r.itemId));
      if (!item) return `Line ${n + 1}: choose an item.`;
      const qty = parseQty(r.qty, kind === "ADJUSTMENT");
      if (!qty) return `Line ${n + 1}: enter a whole-number quantity${kind === "ADJUSTMENT" ? " (negative to remove)" : ""}.`;
      let amount: number | undefined;
      if (kind === "RECEIPT" || kind === "SALE") {
        const a = kind === "RECEIPT" ? parseIn(currency, r.amount) : parseMoney(r.amount);
        if (a === null) return `Line ${n + 1}: enter a unit ${kind === "SALE" ? "price" : "cost"}.`;
        amount = a;
      } else if (kind === "ADJUSTMENT" && r.amount.trim()) {
        const a = parseMoney(r.amount);
        if (a === null) return `Line ${n + 1}: unit cost is not a valid amount.`;
        amount = a;
      }
      lines.push({ itemId: item.id, qty, amount, vatRate: kind === "RECEIPT" || kind === "SALE" ? vatFor(r) : undefined });
    }
    if (!lines.length) return "Add at least one line.";
    if (kind === "RECEIPT") {
      return { ...base, kind, warehouseId: wh, counterparty, paid, currency, fxRate: foreign ? fxRate.trim() : undefined, lines: lines.map((l) => ({ ...l, amount: l.amount! })) };
    }
    if (kind === "SALE") return { ...base, kind, warehouseId: wh, counterparty, paid, lines: lines.map((l) => ({ ...l, amount: l.amount! })) };
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
      key.current = crypto.randomUUID();
      if (r.ok && r.approval) setQueued(r.approval);
      else if (r.ok) router.push(`/transactions/${r.id}`);
      else setError(r.error);
    });
  }

  const tab = TABS.find((t) => t.kind === kind)!;
  const amountLabel = kind === "SALE" ? "Unit price (net)" : kind === "ADJUSTMENT" ? "Unit cost (opt.)" : `Unit cost (net${foreign ? `, ${currency}` : ""})`;
  const hasAmount = kind === "RECEIPT" || kind === "SALE" || kind === "ADJUSTMENT";
  const hasVat = kind === "RECEIPT" || kind === "SALE";
  const debits = preview.lines.reduce((s, l) => s + l.debit, 0);
  const face = preview.lines.reduce((m, l) => Math.max(m, l.debit, l.credit), 0);

  if (queued) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-warn/40 bg-warn-soft p-8 text-center">
        <p className="text-lg font-semibold text-ink">Sent for approval</p>
        <p className="mt-2 text-sm text-muted">This entry is {fmtMoney(threshold)} or more, so a second person has to approve it before it is posted (request #{queued}).</p>
        <div className="mt-5 flex justify-center gap-2">
          <a href="/approvals" className="btn-primary">View approvals</a>
          <button className="btn-ghost" onClick={() => { setQueued(null); setRows([blankRow()]); }}>New transaction</button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        {draft && (
          <div className="flex items-start gap-3 rounded-2xl border border-accent/30 bg-accent-soft p-4 text-sm">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" />
            <p className="text-ink">
              <span className="font-semibold text-accent">Drafted by Copilot.</span> Check every field below. Nothing has been posted; it is recorded only when you click <span className="font-medium">{tab.cta}</span>.
            </p>
          </div>
        )}
        {orderId && (
          <p className="rounded-xl bg-surface-2 px-4 py-2.5 text-sm text-muted">Posting against order <span className="font-mono font-medium text-ink">{reference}</span>. Quantities can&apos;t exceed what is still outstanding.</p>
        )}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {TABS.filter((t) => allowed.includes(t.kind)).map(({ kind: k, label, icon: Icon }) => (
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
            {kind === "RECEIPT" && (
              <div>
                <label className="label flex items-center gap-1" htmlFor="cur"><Globe2 className="size-3" /> Invoice currency</label>
                <div className="flex gap-2">
                  <select id="cur" className="field w-24!" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                    {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                  {foreign && <input aria-label="Exchange rate" inputMode="decimal" className="field num" placeholder={`EUR per 1 ${currency}`} value={fxRate} onChange={(e) => setFxRate(e.target.value)} />}
                </div>
                {foreign && <p className="mt-1 text-[11px] text-muted">Imports post with 0% VAT. Pay later via Cash → Pay foreign-currency invoice.</p>}
              </div>
            )}
            {kind === "PAYMENT" && (
              <>
                <div>
                  <label className="label" htmlFor="ctype">Type</label>
                  <select id="ctype" className="field" value={cashType} onChange={(e) => setCashType(e.target.value as CashMode)}>
                    {CASH_TYPES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                {cashType === "SETTLE_FX" ? (
                  <>
                    <div>
                      <label className="label" htmlFor="inv">Open invoice</label>
                      <select id="inv" className="field" value={settleId} onChange={(e) => setSettleId(e.target.value)}>
                        {openInvoices.length === 0 && <option value="">No open foreign invoices</option>}
                        {openInvoices.map((o) => (
                          <option key={o.id} value={o.id}>#{o.id} · {o.counterparty} · {fmtForeign(o.foreign_amount, o.currency)}</option>
                        ))}
                      </select>
                      {invoice && <p className="mt-1 text-[11px] text-muted">Booked at {invoice.fx_rate} = {fmtMoney(invoice.eur_amount)} on {invoice.doc_date}</p>}
                    </div>
                    <div>
                      <label className="label" htmlFor="rate">Today&apos;s rate (EUR per 1 {invoice?.currency ?? "unit"})</label>
                      <input id="rate" inputMode="decimal" className="field num" placeholder={invoice?.fx_rate ?? "0.92"} value={fxRate} onChange={(e) => setFxRate(e.target.value)} />
                    </div>
                  </>
                ) : cashType === "PAY_VAT" ? (
                  <div>
                    <span className="label">Amount (computed)</span>
                    <p className="field num bg-surface-2!">{vatNet >= 0 ? `Pay ${fmtMoney(vatNet)}` : `Refund ${fmtMoney(-vatNet)}`}</p>
                    <p className="mt-1 text-[11px] text-muted">Clears output and input VAT exactly.</p>
                  </div>
                ) : (
                  <div>
                    <label className="label" htmlFor="amt">Amount (EUR)</label>
                    <input id="amt" inputMode="decimal" className="field num" placeholder="0.00" value={cashAmount} onChange={(e) => setCashAmount(e.target.value)} />
                    <p className="mt-1 text-[11px] text-muted">
                      {cashType === "PAY_SUPPLIER" && `Owed to suppliers: ${fmtMoney(payables)}`}
                      {cashType === "RECEIVE_CUSTOMER" && `Owed by customers: ${fmtMoney(receivables)}`}
                    </p>
                  </div>
                )}
              </>
            )}
            {contactKind && (
              <div>
                <label className="label" htmlFor="contact">{contactKind === "CUSTOMER" ? "Customer account" : "Supplier account"}</label>
                <select id="contact" className="field" value={contactId} onChange={(e) => chooseContact(e.target.value)}>
                  <option value="">— none (one-off) —</option>
                  {contactChoices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <p className="mt-1 text-[11px] text-muted">{kind === "PAYMENT" ? "Applied to the oldest open invoices first." : "Sets the due date from the payment terms."}</p>
              </div>
            )}
            {(kind === "RECEIPT" || kind === "SALE" || (kind === "PAYMENT" && cashType !== "SETTLE_FX")) && (
              <div>
                <label className="label" htmlFor="cp">{kind === "RECEIPT" ? "Supplier" : kind === "SALE" ? "Customer" : "Counterparty"}</label>
                <input id="cp" className="field" value={counterparty} onChange={(e) => setCounterparty(e.target.value)} placeholder={kind === "SALE" ? "Café Kranich" : cashType === "PAY_VAT" ? "Finanzamt" : "Rösterei Nord GmbH"} />
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
                const amt = kind === "RECEIPT" ? parseIn(currency, r.amount) : parseMoney(r.amount);
                const over = item && kind !== "RECEIPT" && (kind === "ADJUSTMENT" ? -qty : qty) > pos.qty;
                return (
                  <div key={r.key} className="grid grid-cols-12 items-start gap-3 px-5 py-4">
                    <div className={`col-span-12 ${hasVat ? "sm:col-span-4" : "sm:col-span-5"}`}>
                      {n === 0 && <span className="label">Item</span>}
                      <select className="field" value={r.itemId} onChange={(e) => setRow(r.key, { itemId: e.target.value, vat: "" })}>
                        <option value="">Choose item…</option>
                        {items.map((i) => <option key={i.id} value={i.id}>{i.sku} · {i.name}</option>)}
                      </select>
                      {item && (
                        <p className={`num mt-1 text-[11px] ${over ? "text-neg" : "text-muted"}`}>
                          {fmtQty(pos.qty)} {item.unit} on hand · avg {fmtMoney(Math.round(avg(id)))}
                        </p>
                      )}
                    </div>
                    <div className={hasAmount ? "col-span-4 sm:col-span-2" : "col-span-10 sm:col-span-6"}>
                      {n === 0 && <span className="label">{kind === "ADJUSTMENT" ? "Qty ±" : "Qty"}</span>}
                      <input inputMode="numeric" className="field num" placeholder={kind === "ADJUSTMENT" ? "-2" : "10"} value={r.qty} onChange={(e) => setRow(r.key, { qty: e.target.value })} />
                    </div>
                    {hasAmount && (
                      <div className={hasVat ? "col-span-4 sm:col-span-3" : "col-span-6 sm:col-span-4"}>
                        {n === 0 && <span className="label truncate">{amountLabel}</span>}
                        <input inputMode="decimal" className="field num" placeholder={kind === "ADJUSTMENT" ? "avg cost" : "0.00"} value={r.amount} onChange={(e) => setRow(r.key, { amount: e.target.value })} disabled={kind === "ADJUSTMENT" && qty < 0} />
                        {(kind === "RECEIPT" || kind === "SALE") && qty > 0 && amt !== null && (
                          <p className="num mt-1 text-[11px] text-muted">
                            = {foreign ? `${fmtForeign(qty * amt, currency)} ≈ ${fmtMoney(estEur(qty * amt, currency, fxRate))}` : fmtMoney(qty * amt)}
                            {kind === "SALE" && item && avg(id) > 0 && ` · margin ${(((amt - avg(id)) / amt) * 100 || 0).toFixed(0)}%`}
                          </p>
                        )}
                      </div>
                    )}
                    {hasVat && (
                      <div className="col-span-3 sm:col-span-2">
                        {n === 0 && <span className="label">VAT</span>}
                        <select className="field" value={foreign ? "0" : String(vatFor(r))} disabled={foreign} onChange={(e) => setRow(r.key, { vat: e.target.value })}>
                          {VAT_RATES.map((v) => <option key={v} value={v}>{v}%</option>)}
                        </select>
                      </div>
                    )}
                    <div className="col-span-1 flex justify-end">
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
              {preview.estimated ? "Estimated at the current average cost or rate. The server computes the exact figures." : "The double entry this will post."}
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
            {face >= threshold && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">Over {fmtMoney(threshold)}: this will be sent to a colleague for approval before posting.</p>}
            <button className="btn-primary w-full py-2.5" disabled={pending}>{pending ? "Posting…" : face >= threshold ? "Submit for approval" : tab.cta}</button>
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
