"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, FileUp, Link2, Link2Off, Plus, Sparkles, Trash2, X } from "lucide-react";
import {
  bookLineAction, cancelOrderAction, createContactAction, createOrderAction, createUserAction, decideApprovalAction, importSampleStatementAction,
  importStatementAction, matchLineAction, unmatchLineAction, updateUserAction,
} from "@/lib/actions";
import type { Role } from "@/lib/auth";
import type { CashType } from "@/lib/ledger";
import { CURRENCIES, VAT_RATES } from "@/lib/accounts";
import { fmtMoney, parseMoney, parseQty } from "@/lib/money";
import { ErrorNote } from "./forms";

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>, onOk?: (r: Record<string, unknown>) => void) =>
    start(async () => {
      setError(null);
      setNotice(null);
      const r = await fn();
      if (r.ok) {
        onOk?.(r);
        router.refresh();
      } else setError(r.error ?? "Something went wrong.");
    });
  return { pending, error, notice, setNotice, run, router };
}

// ───────────────────────── approvals ─────────────────────────

export function ApprovalDecision({ id, own }: { id: number; own: boolean }) {
  const a = useAction();
  const [note, setNote] = useState("");
  if (own) return <p className="text-xs text-muted">Waiting for a colleague: you can&apos;t approve your own request.</p>;
  return (
    <div className="space-y-2">
      <input className="field text-xs" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2">
        <button className="btn-ghost flex-1 text-neg" disabled={a.pending} onClick={() => a.run(() => decideApprovalAction(id, "REJECT", note))}><X className="size-4" /> Reject</button>
        <button className="btn-primary flex-1" disabled={a.pending} onClick={() => a.run(() => decideApprovalAction(id, "APPROVE", note))}><Check className="size-4" /> {a.pending ? "Posting…" : "Approve"}</button>
      </div>
      <ErrorNote message={a.error} />
    </div>
  );
}

// ───────────────────────── users ─────────────────────────

const ROLES: { value: Role; label: string }[] = [
  { value: "ADMIN", label: "Administrator" },
  { value: "ACCOUNTANT", label: "Accountant" },
  { value: "WAREHOUSE", label: "Warehouse" },
  { value: "VIEWER", label: "Viewer" },
];

export function CreateUserForm() {
  const a = useAction();
  const [f, setF] = useState({ name: "", email: "", role: "ACCOUNTANT" as Role, password: "" });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        a.run(() => createUserAction(f), () => setF({ name: "", email: "", role: "ACCOUNTANT", password: "" }));
      }}
    >
      <div><label className="label" htmlFor="un">Name</label><input id="un" className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
      <div><label className="label" htmlFor="ue">Email</label><input id="ue" type="email" className="field" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></div>
      <div>
        <label className="label" htmlFor="ur">Role</label>
        <select id="ur" className="field" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
      </div>
      <div><label className="label" htmlFor="up">Initial password (min. 8)</label><input id="up" type="password" autoComplete="new-password" className="field" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} /></div>
      <ErrorNote message={a.error} />
      <button className="btn-primary w-full" disabled={a.pending}><Plus className="size-4" /> Create user</button>
    </form>
  );
}

export function UserControls({ id, role, active, self }: { id: number; role: Role; active: boolean; self: boolean }) {
  const a = useAction();
  const [pw, setPw] = useState("");
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <select aria-label="Role" className="field w-36! py-1.5! text-xs" value={role} disabled={a.pending} onChange={(e) => a.run(() => updateUserAction(id, { role: e.target.value as Role }))}>
        {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); a.run(() => updateUserAction(id, { password: pw }), () => setPw("")); }}>
        <input aria-label="New password" type="password" autoComplete="new-password" placeholder="New password" className="field w-32! py-1.5! text-xs" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button className="btn-ghost px-2! py-1.5! text-xs" disabled={!pw || a.pending}>Reset</button>
      </form>
      {!self && (
        <button className={`btn-ghost px-2.5! py-1.5! text-xs ${active ? "text-neg" : "text-pos"}`} disabled={a.pending} onClick={() => a.run(() => updateUserAction(id, { active: !active }))}>
          {active ? "Deactivate" : "Reactivate"}
        </button>
      )}
      {a.error && <p className="w-full text-right text-[11px] text-neg">{a.error}</p>}
    </div>
  );
}

// ───────────────────────── contacts ─────────────────────────

export function ContactForm({ kind }: { kind: "CUSTOMER" | "SUPPLIER" }) {
  const a = useAction();
  const blank = { name: "", email: "", vatId: "", termsDays: kind === "CUSTOMER" ? "14" : "30", currency: "EUR" };
  const [f, setF] = useState(blank);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        a.run(() => createContactAction({ kind, name: f.name, email: f.email, vatId: f.vatId, termsDays: Number(f.termsDays), currency: f.currency }), () => setF(blank));
      }}
    >
      <div><label className="label" htmlFor="cn">Name</label><input id="cn" className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
      <div><label className="label" htmlFor="ce">Email</label><input id="ce" type="email" className="field" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label" htmlFor="ct">Terms (days)</label><input id="ct" inputMode="numeric" className="field num" value={f.termsDays} onChange={(e) => setF({ ...f, termsDays: e.target.value })} /></div>
        <div>
          <label className="label" htmlFor="cc">Currency</label>
          <select id="cc" className="field" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} disabled={kind === "CUSTOMER"}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
        </div>
      </div>
      <div><label className="label" htmlFor="cv">VAT ID</label><input id="cv" className="field font-mono" placeholder="DE123456789" value={f.vatId} onChange={(e) => setF({ ...f, vatId: e.target.value })} /></div>
      <ErrorNote message={a.error} />
      <button className="btn-primary w-full" disabled={a.pending}><Plus className="size-4" /> Add {kind === "CUSTOMER" ? "customer" : "supplier"}</button>
    </form>
  );
}

// ───────────────────────── orders ─────────────────────────

type Opt = { id: number; label: string; vat?: number; currency?: string; price?: number };

export function OrderForm({ kind, contacts, items, warehouses, today }: { kind: "PO" | "SO"; contacts: Opt[]; items: Opt[]; warehouses: Opt[]; today: string }) {
  const a = useAction();
  const [contactId, setContactId] = useState(String(contacts[0]?.id ?? ""));
  const [warehouseId, setWarehouseId] = useState(String(warehouses[0]?.id ?? ""));
  const [orderDate, setOrderDate] = useState(today);
  const [expected, setExpected] = useState("");
  const [fxRate, setFxRate] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState([{ k: 1, itemId: "", qty: "", amount: "", vat: "" }]);
  const contact = contacts.find((c) => String(c.id) === contactId);
  const currency = kind === "PO" ? (contact?.currency ?? "EUR") : "EUR";
  const foreign = currency !== "EUR";
  const total = rows.reduce((t, r) => t + (parseQty(r.qty) ?? 0) * (parseMoney(r.amount) ?? 0), 0);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const lines: { itemId: number; qty: number; unitAmount: number; vatRate: number }[] = [];
    for (const [n, r] of rows.entries()) {
      if (!r.itemId) continue;
      const qty = parseQty(r.qty);
      const amt = parseMoney(r.amount);
      if (!qty || amt === null) return a.setNotice(`Line ${n + 1}: enter quantity and unit ${kind === "PO" ? "cost" : "price"}.`);
      const item = items.find((i) => String(i.id) === r.itemId);
      lines.push({ itemId: Number(r.itemId), qty, unitAmount: amt, vatRate: foreign ? 0 : r.vat !== "" ? Number(r.vat) : (item?.vat ?? 19) });
    }
    if (!lines.length) return a.setNotice("Add at least one line.");
    a.run(
      () => createOrderAction({ kind, contactId: Number(contactId), warehouseId: Number(warehouseId), orderDate, expectedDate: expected || undefined, currency, fxRate: foreign ? fxRate : undefined, notes, lines }),
      (r) => a.router.push(`/orders/${r.id}`),
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="oc">{kind === "PO" ? "Supplier" : "Customer"}</label>
          <select id="oc" className="field" value={contactId} onChange={(e) => setContactId(e.target.value)}>{contacts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
        </div>
        <div>
          <label className="label" htmlFor="ow">{kind === "PO" ? "Deliver to" : "Ship from"}</label>
          <select id="ow" className="field" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</select>
        </div>
        <div><label className="label" htmlFor="od">Order date</label><input id="od" type="date" className="field" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} /></div>
        <div><label className="label" htmlFor="oe">Expected</label><input id="oe" type="date" className="field" value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
        {foreign && <div><label className="label" htmlFor="ofx">Expected rate (EUR per 1 {currency})</label><input id="ofx" inputMode="decimal" className="field num" value={fxRate} onChange={(e) => setFxRate(e.target.value)} placeholder="0.92" /></div>}
        <div className={foreign ? "sm:col-span-1 lg:col-span-3" : "sm:col-span-2 lg:col-span-4"}><label className="label" htmlFor="on">Notes</label><input id="on" className="field" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      </div>
      <div className="rounded-xl border border-line">
        {rows.map((r, n) => (
          <div key={r.k} className="grid grid-cols-12 items-end gap-2 border-b border-line/70 p-3 last:border-0">
            <div className="col-span-12 sm:col-span-5">
              {n === 0 && <span className="label">Item</span>}
              <select className="field" value={r.itemId} onChange={(e) => setRows(rows.map((x) => (x.k === r.k ? { ...x, itemId: e.target.value, amount: x.amount || (kind === "SO" ? ((items.find((i) => String(i.id) === e.target.value)?.price ?? 0) / 100).toFixed(2) : "") } : x)))}>
                <option value="">Choose item…</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
              </select>
            </div>
            <div className="col-span-3 sm:col-span-2">{n === 0 && <span className="label">Qty</span>}<input inputMode="numeric" className="field num" value={r.qty} onChange={(e) => setRows(rows.map((x) => (x.k === r.k ? { ...x, qty: e.target.value } : x)))} /></div>
            <div className="col-span-4 sm:col-span-2">{n === 0 && <span className="label">Unit {kind === "PO" ? "cost" : "price"} ({currency})</span>}<input inputMode="decimal" className="field num" value={r.amount} onChange={(e) => setRows(rows.map((x) => (x.k === r.k ? { ...x, amount: e.target.value } : x)))} /></div>
            <div className="col-span-3 sm:col-span-2">
              {n === 0 && <span className="label">VAT</span>}
              <select className="field" disabled={foreign} value={foreign ? "0" : r.vat !== "" ? r.vat : String(items.find((i) => String(i.id) === r.itemId)?.vat ?? 19)} onChange={(e) => setRows(rows.map((x) => (x.k === r.k ? { ...x, vat: e.target.value } : x)))}>
                {VAT_RATES.map((v) => <option key={v} value={v}>{v}%</option>)}
              </select>
            </div>
            <div className="col-span-2 flex justify-end sm:col-span-1">
              <button type="button" aria-label="Remove line" disabled={rows.length === 1} className="grid size-9 place-items-center rounded-lg text-muted hover:bg-neg-soft hover:text-neg disabled:opacity-30" onClick={() => setRows(rows.filter((x) => x.k !== r.k))}><Trash2 className="size-4" /></button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-ghost" onClick={() => setRows([...rows, { k: Date.now(), itemId: "", qty: "", amount: "", vat: "" }])}><Plus className="size-4" /> Add line</button>
        <span className="ml-auto text-sm text-muted">Net total <span className="num font-semibold text-ink">{currency === "EUR" ? fmtMoney(total) : `${(total / 100).toFixed(2)} ${currency}`}</span></span>
        <button className="btn-primary" disabled={a.pending}>{a.pending ? "Saving…" : `Create ${kind === "PO" ? "purchase" : "sales"} order`}</button>
      </div>
      <ErrorNote message={a.error ?? a.notice} />
    </form>
  );
}

export function CancelOrderButton({ id }: { id: number }) {
  const a = useAction();
  const [sure, setSure] = useState(false);
  return sure ? (
    <span className="flex items-center gap-2">
      <button className="btn-ghost" onClick={() => setSure(false)}>Keep</button>
      <button className="btn-danger" disabled={a.pending} onClick={() => a.run(() => cancelOrderAction(id))}>Cancel remaining</button>
      {a.error && <span className="text-xs text-neg">{a.error}</span>}
    </span>
  ) : (
    <button className="btn-ghost" onClick={() => setSure(true)}>Cancel order</button>
  );
}

// ───────────────────────── bank ─────────────────────────

export function BankImport() {
  const a = useAction();
  const file = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const upload = async (f: File) => {
    const text = await f.text();
    a.run(() => importStatementAction(f.name, text), (r) => { a.setNotice(`Imported ${r.lines} lines; ${r.matched} matched automatically.`); a.router.push(`/bank?statement=${r.id}`); });
  };
  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) upload(f); }}
        className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition ${drag ? "border-accent bg-accent-soft" : "border-line"}`}
      >
        <FileUp className="size-7 text-accent" />
        <p className="mt-2 text-sm font-medium text-ink">Drop a bank statement CSV here</p>
        <p className="mt-0.5 text-xs text-muted">German exports (Buchungstag; Betrag; Saldo) and international formats are detected automatically.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button className="btn-primary" disabled={a.pending} onClick={() => file.current?.click()}>{a.pending ? "Importing…" : "Choose file"}</button>
          <button className="btn-ghost" disabled={a.pending} onClick={() => a.run(() => importSampleStatementAction(), (r) => { a.setNotice(`Imported ${r.lines} lines; ${r.matched} matched automatically.`); a.router.push(`/bank?statement=${r.id}`); })}>
            <Sparkles className="size-4 text-accent" /> Import last month&apos;s demo statement
          </button>
        </div>
        <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
      </div>
      {a.notice && <p className="mt-2 text-sm text-pos">{a.notice}</p>}
      <div className="mt-2"><ErrorNote message={a.error} /></div>
    </div>
  );
}

export function BankLineActions({
  lineId, amount, matched, candidates, suggestion, contacts,
}: {
  lineId: number;
  amount: number;
  matched: boolean;
  candidates: { id: number; label: string; score: number }[];
  suggestion: { type: CashType; contactId?: number; label: string; reason: string } | null;
  contacts: { id: number; name: string; kind: string }[];
}) {
  const a = useAction();
  const [pick, setPick] = useState(String(candidates[0]?.id ?? ""));
  const [type, setType] = useState<CashType>(suggestion?.type ?? (amount > 0 ? "RECEIVE_CUSTOMER" : "EXPENSE"));
  const [contactId, setContactId] = useState(String(suggestion?.contactId ?? ""));
  if (matched) {
    return <button className="btn-ghost px-2.5! py-1.5! text-xs" disabled={a.pending} onClick={() => a.run(() => unmatchLineAction(lineId))}><Link2Off className="size-3.5" /> Unmatch</button>;
  }
  const types: { v: CashType; l: string }[] = amount > 0
    ? [{ v: "RECEIVE_CUSTOMER", l: "Customer payment" }, { v: "CAPITAL", l: "Owner capital" }]
    : [{ v: "EXPENSE", l: "Expense / fee" }, { v: "PAY_SUPPLIER", l: "Supplier payment" }];
  const kind = type === "RECEIVE_CUSTOMER" ? "CUSTOMER" : type === "PAY_SUPPLIER" ? "SUPPLIER" : null;
  return (
    <div className="space-y-2">
      {candidates.length > 0 && (
        <div className="flex gap-1.5">
          <select aria-label="Ledger entry" className="field py-1.5! text-xs" value={pick} onChange={(e) => setPick(e.target.value)}>
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.label} · {Math.round(c.score * 100)}%</option>)}
          </select>
          <button className="btn-primary shrink-0 px-2.5! py-1.5! text-xs" disabled={a.pending || !pick} onClick={() => a.run(() => matchLineAction(lineId, Number(pick)))}><Link2 className="size-3.5" /> Match</button>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <select aria-label="Book as" className="field w-auto! py-1.5! text-xs" value={type} onChange={(e) => setType(e.target.value as CashType)}>
          {types.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
        </select>
        {kind && (
          <select aria-label="Contact" className="field w-auto! max-w-44 py-1.5! text-xs" value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">No contact</option>
            {contacts.filter((c) => c.kind === kind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <button className="btn-ghost shrink-0 px-2.5! py-1.5! text-xs" disabled={a.pending} onClick={() => a.run(() => bookLineAction(lineId, type, contactId ? Number(contactId) : undefined))}><Plus className="size-3.5" /> Book &amp; match</button>
      </div>
      {suggestion && <p className="flex items-start gap-1 text-[11px] text-accent"><Sparkles className="mt-0.5 size-3 shrink-0" /> Suggested: {suggestion.label}. {suggestion.reason}</p>}
      {a.error && <p className="text-[11px] text-neg">{a.error}</p>}
    </div>
  );
}
