"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save, Sparkles } from "lucide-react";
import { generateCommentaryAction, saveBudgetAction } from "@/lib/actions";
import { fmtMonth, parseMoney } from "@/lib/money";
import { ErrorNote } from "./forms";

export function GenerateCommentaryButton({ period, label }: { period: string; label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        className="btn-ghost px-3! py-1.5! text-xs whitespace-nowrap"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await generateCommentaryAction(period);
            setNote(r.ok ? (r.notice ?? null) : r.error);
            router.refresh();
          })
        }
      >
        <Sparkles className={`size-3.5 text-accent ${pending ? "animate-pulse" : ""}`} />
        {pending ? "Writing…" : (label ?? `AI commentary for ${fmtMonth(period)}`)}
      </button>
      {note && <span className="max-w-60 text-right text-[11px] text-warn">{note}</span>}
    </span>
  );
}

type Row = { code: string; label: string; cells: { month: string; budget: number | null }[] };

export function BudgetEditor({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.flatMap((r) => r.cells.map((c) => [`${r.code}|${c.month}`, c.budget === null ? "" : (c.budget / 100).toFixed(0)]))),
  );
  const months = rows[0]?.cells.map((c) => c.month) ?? [];

  function fill(code: string) {
    const first = months.map((m) => values[`${code}|${m}`]).find((v) => v);
    if (!first) return;
    setValues((v) => ({ ...v, ...Object.fromEntries(months.map((m) => [`${code}|${m}`, v[`${code}|${m}`] || first])) }));
  }

  function save() {
    const entries: { period: string; account: string; amount: number }[] = [];
    for (const [k, v] of Object.entries(values)) {
      if (!v.trim()) continue;
      const amount = parseMoney(v);
      if (amount === null) return setError(`"${v}" is not a valid amount.`);
      const [account, period] = k.split("|");
      entries.push({ period, account, amount });
    }
    setError(null);
    start(async () => {
      const r = await saveBudgetAction(entries);
      if (r.ok) {
        setSaved(r.id ? `${r.id} figure(s) saved as a new version.` : "No changes.");
        router.refresh();
      } else setError(r.error);
    });
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="table min-w-[1100px]">
          <thead>
            <tr>
              <th>Account (EUR)</th>
              {months.map((m) => <th key={m} className="text-right!">{fmtMonth(m).slice(0, 3)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <td className="whitespace-nowrap">
                  <span className="block text-ink">{r.label}</span>
                  <button type="button" onClick={() => fill(r.code)} className="text-[11px] text-accent hover:underline">Fill empty months →</button>
                </td>
                {months.map((m) => (
                  <td key={m} className="px-1!">
                    <input
                      aria-label={`${r.label} ${m}`}
                      inputMode="decimal"
                      className="field num px-2! py-1.5! text-right text-xs"
                      value={values[`${r.code}|${m}`]}
                      onChange={(e) => setValues((v) => ({ ...v, [`${r.code}|${m}`]: e.target.value }))}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-4">
        <button className="btn-primary" disabled={pending} onClick={save}><Save className="size-4" /> {pending ? "Saving…" : "Save budget"}</button>
        <p className="text-xs text-muted">Every save creates a new version; earlier figures stay in the history.</p>
        {saved && <p className="text-xs text-pos">{saved}</p>}
        <div className="w-full"><ErrorNote message={error} /></div>
      </div>
    </div>
  );
}
