import Link from "next/link";
import { Search } from "lucide-react";
import { Badge, Card, Empty, Hash, KindBadge, Money, PageHeader } from "@/components/ui";
import type { JournalKind } from "@/lib/accounts";
import { KIND_LABEL } from "@/lib/accounts";
import { getDb } from "@/lib/db";
import { fmtDate, fmtTimestamp } from "@/lib/money";
import { journalsList } from "@/lib/reports";

const KINDS = Object.keys(KIND_LABEL) as JournalKind[];

export default async function JournalPage({ searchParams }: { searchParams: Promise<{ kind?: string; q?: string }> }) {
  const sp = await searchParams;
  const kind = KINDS.includes(sp.kind as JournalKind) ? sp.kind : undefined;
  const rows = journalsList(getDb(), { kind, q: sp.q, limit: 300 });
  const href = (k?: string) => {
    const p = new URLSearchParams();
    if (k) p.set("kind", k);
    if (sp.q) p.set("q", sp.q);
    return `/transactions${p.size ? `?${p}` : ""}`;
  };

  return (
    <>
      <PageHeader
        eyebrow="General journal"
        title="Journal"
        subtitle="Every entry in posting order. Entries are never edited: a correction is a reversal linked to its original."
        actions={
          <>
            <a href="/api/export?report=journal" className="btn-ghost">Export CSV</a>
            <Link href="/transactions/new" className="btn-primary">New transaction</Link>
          </>
        }
      />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {[undefined, ...KINDS].map((k) => (
            <Link
              key={k ?? "all"}
              href={href(k)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${kind === k ? "bg-ink text-bg" : "bg-surface text-muted ring-1 ring-line hover:text-ink"}`}
            >
              {k ? KIND_LABEL[k] : "All"}
            </Link>
          ))}
        </div>
        <form className="relative lg:w-72">
          {kind && <input type="hidden" name="kind" value={kind} />}
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input name="q" defaultValue={sp.q} placeholder="Search memo, party, ref or #id" className="field pl-9" />
        </form>
      </div>

      <Card>
        {rows.length === 0 ? (
          <Empty title="No matching entries" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table min-w-[900px]">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th className="text-right!">Amount</th>
                  <th>Status</th>
                  <th>Hash</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((j) => (
                  <tr key={j.id}>
                    <td className="font-mono text-xs"><Link href={`/transactions/${j.id}`} className="text-accent hover:underline">#{j.id}</Link></td>
                    <td className="whitespace-nowrap">
                      <span className="block text-ink">{fmtDate(j.doc_date)}</span>
                      {j.posted_at.slice(0, 10) !== j.doc_date && <span className="text-[11px] text-warn" title={fmtTimestamp(j.posted_at)}>posted {fmtDate(j.posted_at)}</span>}
                    </td>
                    <td><KindBadge kind={j.kind} /></td>
                    <td className="max-w-sm">
                      <Link href={`/transactions/${j.id}`} className="block truncate text-ink hover:text-accent">{j.counterparty || j.memo || "—"}</Link>
                      <span className="block truncate text-xs text-muted">{[j.reference, j.counterparty && j.memo].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td className="text-right font-medium"><Money cents={j.amount} className={j.reversed_by ? "text-muted line-through" : ""} /></td>
                    <td>
                      {j.reversed_by ? (
                        <Link href={`/transactions/${j.reversed_by}`}><Badge tone="neg">Reversed by #{j.reversed_by}</Badge></Link>
                      ) : j.reverses_id ? (
                        <Link href={`/transactions/${j.reverses_id}`}><Badge tone="warn">Reverses #{j.reverses_id}</Badge></Link>
                      ) : (
                        <Badge tone="pos">Posted</Badge>
                      )}
                    </td>
                    <td><Hash value={j.hash} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
