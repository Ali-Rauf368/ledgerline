import { CheckCircle2, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { RefreshButton } from "@/components/forms";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { getDb } from "@/lib/db";
import { verifyLedger } from "@/lib/integrity";
import { fmtTimestamp } from "@/lib/money";

const GUARANTEES = [
  ["Append-only storage", "SQLite triggers abort any UPDATE or DELETE on journals, lines, stock moves, period snapshots and the audit log, whichever client sends it."],
  ["Atomic posting", "One business event is one transaction (BEGIN IMMEDIATE). Either all lines and movements land, or nothing does."],
  ["Integer money", "Amounts are whole cents. Moving-average cost is rounded once per movement, and selling the last unit takes the exact remainder, so no rounding drift builds up."],
  ["Immutable cost history", "Each movement stores the position it produced. Backdating before an item's latest movement is refused, so posted costs never change."],
  ["Corrections by reversal", "Mistakes are fixed by a linked mirror entry plus a new one. The original and the fix both stay visible."],
  ["Period locks", "Closed months accept no entries. Their sealed snapshot is recomputed on every check, so a change to closed history can't go unnoticed."],
  ["Idempotent submits", "Each form submit carries a key, so a double click or network retry posts exactly once."],
  ["Bitemporal reports", "Reports take an accounting date and a 'known at' time, so a report can be reproduced exactly as it was issued."],
];

export default function IntegrityPage() {
  const v = verifyLedger(getDb());
  return (
    <>
      <PageHeader
        eyebrow="Verification"
        title="Ledger integrity"
        subtitle="An independent pass recomputes every hash, balance and position from raw rows and compares it with what is stored."
        actions={<RefreshButton />}
      />

      <div className={`mb-6 flex items-center gap-4 overflow-hidden rounded-2xl p-6 text-white shadow-card ${v.ok ? "bg-gradient-to-br from-emerald-600 to-teal-700" : "bg-gradient-to-br from-rose-600 to-red-700"}`}>
        <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-white/15">
          {v.ok ? <ShieldCheck className="size-7" /> : <ShieldAlert className="size-7" />}
        </span>
        <div className="min-w-0">
          <p className="text-lg font-semibold">{v.ok ? "Ledger verified" : "Integrity violation detected"}</p>
          <p className="mt-0.5 text-sm text-white/80">
            {v.checks.filter((c) => c.ok).length}/{v.checks.length} checks passed · {v.journals} journals · {v.ms} ms · {fmtTimestamp(v.checkedAt)}
          </p>
          <p className="mt-1 truncate font-mono text-xs text-white/70">head {v.head}</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Checks" />
          <ul className="divide-y divide-line/70">
            {v.checks.map((c) => (
              <li key={c.id} className="flex gap-3.5 px-5 py-4">
                {c.ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-pos" /> : <XCircle className="mt-0.5 size-5 shrink-0 text-neg" />}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{c.label}</p>
                  <p className="mt-0.5 text-xs text-muted">{c.description}</p>
                  <p className={`mt-1.5 inline-block rounded-md px-2 py-0.5 font-mono text-[11px] ${c.ok ? "bg-surface-2 text-muted" : "bg-neg-soft text-neg"}`}>{c.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="How consistency is guaranteed" />
          <ul className="space-y-4 px-5 py-4">
            {GUARANTEES.map(([t, d]) => (
              <li key={t}>
                <p className="text-sm font-medium text-ink">{t}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{d}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
