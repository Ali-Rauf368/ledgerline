"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, RefreshCw, Undo2 } from "lucide-react";
import { closePeriodAction, createItemAction, reverseAction } from "@/lib/actions";
import { fmtMonth } from "@/lib/money";

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="rounded-lg border border-neg/25 bg-neg-soft px-3 py-2.5 text-sm text-neg">{message}</p>;
}

export function NewItemForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ sku: "", name: "", category: "", unit: "pcs" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await createItemAction(form);
          if (r.ok) {
            setForm({ sku: "", name: "", category: "", unit: "pcs" });
            setError(null);
            router.push(`/inventory/${r.id}`);
          } else setError(r.error);
        });
      }}
    >
      <div>
        <label className="label" htmlFor="sku">SKU</label>
        <input id="sku" className="field font-mono uppercase" placeholder="TMP-STL-58" value={form.sku} onChange={set("sku")} required />
      </div>
      <div>
        <label className="label" htmlFor="name">Name</label>
        <input id="name" className="field" placeholder="Steel Tamper 58 mm" value={form.name} onChange={set("name")} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="cat">Category</label>
          <input id="cat" className="field" placeholder="Equipment" value={form.category} onChange={set("category")} />
        </div>
        <div>
          <label className="label" htmlFor="unit">Unit</label>
          <input id="unit" className="field" value={form.unit} onChange={set("unit")} />
        </div>
      </div>
      <ErrorNote message={error} />
      <button className="btn-primary w-full" disabled={pending}>{pending ? "Creating…" : "Create item"}</button>
    </form>
  );
}

export function ReverseForm({ journalId, today }: { journalId: number; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(today);
  const key = useRef(crypto.randomUUID());

  if (!open) {
    return (
      <button className="btn-ghost w-full" onClick={() => setOpen(true)}>
        <Undo2 className="size-4" /> Reverse this entry
      </button>
    );
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await reverseAction(journalId, date, reason, key.current);
          if (r.ok) router.push(`/transactions/${r.id}`);
          else {
            setError(r.error);
            key.current = crypto.randomUUID();
          }
        });
      }}
    >
      <p className="text-xs text-muted">
        This posts a mirror-image entry. The original stays exactly as it was, and both remain in the chain.
      </p>
      <div>
        <label className="label" htmlFor="reason">Reason (recorded in the audit trail)</label>
        <input id="reason" className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wrong quantity keyed" required />
      </div>
      <div>
        <label className="label" htmlFor="rdate">Reversal date</label>
        <input id="rdate" type="date" className="field" value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
      </div>
      <ErrorNote message={error} />
      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn-danger flex-1" disabled={pending}>{pending ? "Posting…" : "Post reversal"}</button>
      </div>
    </form>
  );
}

export function ClosePeriodButton({ period }: { period: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <button className="btn-primary" onClick={() => setConfirming(true)}>
        <Lock className="size-4" /> Request close of {fmtMonth(period)}
      </button>
    );
  }
  return (
    <div className="w-full space-y-2 sm:w-auto">
      <p className="text-xs text-muted sm:max-w-xs">Closing is permanent: no entry can be dated in {fmtMonth(period)} afterwards and a hashed snapshot is sealed. A second person must approve it.</p>
      <ErrorNote message={error} />
      <div className="flex gap-2">
        <button className="btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
        <button
          className="btn-danger"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await closePeriodAction(period);
              if (r.ok) {
                setConfirming(false);
                router.push("/approvals");
              } else setError(r.error);
            })
          }
        >
          {pending ? "Sending…" : "Send for approval"}
        </button>
      </div>
    </div>
  );
}

export function RefreshButton({ label = "Re-run checks" }: { label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button className="btn-ghost" disabled={pending} onClick={() => start(() => router.refresh())}>
      <RefreshCw className={`size-4 ${pending ? "animate-spin" : ""}`} /> {label}
    </button>
  );
}
