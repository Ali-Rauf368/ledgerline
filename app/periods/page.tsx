import Link from "next/link";
import { CalendarClock, Lock, LockOpen } from "lucide-react";
import { ClosePeriodButton } from "@/components/forms";
import { Badge, Card, Money, PageHeader } from "@/components/ui";
import { getDb } from "@/lib/db";
import { verifyLedger } from "@/lib/integrity";
import { lockedThrough } from "@/lib/ledger";
import { fmtDate, fmtMonth, fmtTimestamp } from "@/lib/money";
import { periodsOverview } from "@/lib/reports";

export default function PeriodsPage() {
  const db = getDb();
  const periods = periodsOverview(db);
  const lock = lockedThrough(db);
  const snapshotsOk = verifyLedger(db).checks.find((c) => c.id === "periods")!.ok;

  return (
    <>
      <PageHeader
        eyebrow="Period control"
        title="Accounting periods"
        subtitle="Closing a month locks it permanently and seals a SHA-256 snapshot of every balance. Later corrections go into an open month, so reported history never moves."
        actions={lock ? <Badge tone="accent" className="px-3! py-1.5! text-xs!"><Lock className="size-3.5" /> Books locked through {fmtMonth(lock)}</Badge> : undefined}
      />

      <ol className="relative space-y-4 before:absolute before:top-4 before:bottom-4 before:left-5 before:w-px before:bg-line">
        {periods.map((p) => (
          <li key={p.period} className="relative pl-14">
            <span
              className={`absolute top-5 left-0 grid size-10 place-items-center rounded-full ring-4 ring-bg ${
                p.status === "closed" ? "bg-accent text-white" : p.status === "closable" ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"
              }`}
            >
              {p.status === "closed" ? <Lock className="size-4" /> : p.status === "current" ? <CalendarClock className="size-4" /> : <LockOpen className="size-4" />}
            </span>
            <Card className="p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-ink">{fmtMonth(p.period)}</h2>
                    {p.status === "closed" && <Badge tone="accent">Closed</Badge>}
                    {p.status === "closable" && <Badge tone="warn">Ready to close</Badge>}
                    {p.status === "current" && <Badge>Current month</Badge>}
                    {p.status === "open" && <Badge>Open</Badge>}
                    {p.close && <Badge tone={snapshotsOk ? "pos" : "neg"}>{snapshotsOk ? "Snapshot verified" : "Snapshot mismatch"}</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    <Link href={`/reports?tab=pl&from=${p.period}-01&asOf=${p.end}`} className="hover:text-accent">
                      {p.journals} entries · revenue <Money cents={p.revenue} /> · net income <Money cents={p.netIncome} />
                    </Link>
                  </p>
                </div>
                {p.status === "closable" && <ClosePeriodButton period={p.period} />}
                {p.status === "current" && <p className="text-xs text-muted">Can be closed after {fmtDate(p.end)}</p>}
              </div>
              {p.close && (
                <div className="mt-4 grid gap-3 rounded-xl bg-surface-2/70 p-3.5 text-xs sm:grid-cols-3">
                  <div><p className="text-muted">Closed</p><p className="mt-0.5 text-ink">{fmtTimestamp(p.close.closed_at)} · {p.close.closed_by}</p></div>
                  <div><p className="text-muted">Sealed through</p><p className="mt-0.5"><Link href={`/transactions/${p.close.last_journal_id}`} className="text-accent">journal #{p.close.last_journal_id}</Link></p></div>
                  <div className="min-w-0"><p className="text-muted">Snapshot hash</p><p className="mt-0.5 truncate font-mono text-ink" title={p.close.snapshot_hash}>{p.close.snapshot_hash}</p></div>
                </div>
              )}
            </Card>
          </li>
        ))}
      </ol>
    </>
  );
}
