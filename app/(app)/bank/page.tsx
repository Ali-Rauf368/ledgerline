import Link from "next/link";
import { CheckCircle2, CircleDashed, Landmark, XCircle } from "lucide-react";
import { BankImport, BankLineActions } from "@/components/v3-forms";
import { Badge, Card, CardHeader, Empty, Money, PageHeader, Stat } from "@/components/ui";
import { can } from "@/lib/auth";
import { candidatesFor, reconciliation, statements, suggestForLine } from "@/lib/bank";
import { all, getDb } from "@/lib/db";
import { fmtDate, fmtTimestamp } from "@/lib/money";
import { pageUser } from "@/lib/session";

const METHOD: Record<string, string> = { AUTO: "auto-matched", MANUAL: "matched by hand", CREATED: "booked from bank", AI: "AI-matched" };

export default async function BankPage({ searchParams }: { searchParams: Promise<{ statement?: string; filter?: string }> }) {
  const user = await pageUser();
  const sp = await searchParams;
  const db = getDb();
  const list = statements(db);
  const editable = can(user, "bank:reconcile");
  const current = list.find((s) => String(s.id) === sp.statement) ?? list[0];
  const rec = current ? reconciliation(db, current.id) : null;
  const contacts = all<{ id: number; name: string; kind: string }>(db, "SELECT id, name, kind FROM contacts ORDER BY name");
  const showAll = sp.filter === "all";
  const lines = rec ? (showAll ? rec.lines : rec.lines.filter((l) => !l.match)) : [];

  return (
    <>
      <PageHeader
        eyebrow="Cash control"
        title="Bank reconciliation"
        subtitle="Import a bank statement and prove that the bank and the books agree. Lines are matched to ledger entries automatically by amount, date and payee; unknown lines like fees can be booked in one click."
      />
      {editable && <Card className="mb-6 p-5"><BankImport /></Card>}

      {!rec ? (
        <Card><Empty title="No statements yet" body="Import your bank's CSV export, or try the demo statement built from last month's cash movements." /></Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {list.map((s) => (
              <Link key={s.id} href={`/bank?statement=${s.id}`} className={`rounded-full px-3 py-1.5 text-xs font-medium ring-1 ${s.id === current!.id ? "bg-ink text-bg ring-ink" : "bg-surface text-muted ring-line hover:text-ink"}`}>
                <Landmark className="mr-1 inline size-3" />{s.filename}
              </Link>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Bank closing balance" value={rec.bankClosing === null ? "—" : <Money cents={rec.bankClosing} />} hint={`${fmtDate(rec.statement.period_from)} – ${fmtDate(rec.statement.period_to)}`} />
            <Stat label="Ledger cash" value={<Money cents={rec.ledgerCash} />} hint={`as of ${fmtDate(rec.statement.period_to)}`} />
            <Stat label="Matched" value={`${rec.matchedCount} / ${rec.lines.length}`} hint={`${rec.inTransit.length} ledger entries in transit`} />
            <Card className={`p-5 ${rec.difference === 0 ? "border-pos/40 bg-pos-soft" : rec.difference === null ? "" : "border-warn/40 bg-warn-soft"}`}>
              <p className="text-xs font-medium text-muted">Difference</p>
              <p className={`mt-3 flex items-center gap-2 text-2xl font-semibold ${rec.difference === 0 ? "text-pos" : "text-warn"}`}>
                {rec.difference === 0 ? <CheckCircle2 className="size-6" /> : rec.difference === null ? <CircleDashed className="size-6" /> : <XCircle className="size-6" />}
                {rec.difference === null ? "n/a" : <Money cents={rec.difference} />}
              </p>
              <p className="mt-1.5 text-xs text-muted">{rec.difference === 0 ? "Reconciled: bank and books agree." : rec.difference === null ? "Statement has no balance column." : "Match or book the open lines below."}</p>
            </Card>
          </div>

          <Card className="mt-6">
            <CardHeader
              title="Reconciliation proof"
              subtitle="Ledger cash − entries not yet on the statement + statement lines not yet in the ledger = bank balance"
            />
            <dl className="grid gap-2 px-5 py-4 text-sm sm:max-w-xl">
              <div className="flex justify-between"><dt className="text-muted">Ledger cash at {fmtDate(rec.statement.period_to)}</dt><dd><Money cents={rec.ledgerCash} /></dd></div>
              <div className="flex justify-between"><dt className="text-muted">− In transit ({rec.inTransit.length} entries)</dt><dd><Money cents={-rec.inTransit.reduce((t, e) => t + e.amount, 0)} /></dd></div>
              <div className="flex justify-between"><dt className="text-muted">+ Unbooked bank lines ({rec.lines.length - rec.matchedCount})</dt><dd><Money cents={rec.lines.filter((l) => !l.match).reduce((t, l) => t + l.amount, 0)} /></dd></div>
              <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>= Expected bank balance</dt><dd><Money cents={rec.adjusted} /></dd></div>
              {rec.bankClosing !== null && <div className="flex justify-between"><dt className="text-muted">Statement says</dt><dd><Money cents={rec.bankClosing} /></dd></div>}
            </dl>
          </Card>

          <Card className="mt-6">
            <CardHeader
              title={showAll ? "All statement lines" : "Lines to reconcile"}
              subtitle={showAll ? undefined : `${lines.length} unmatched`}
              action={<Link href={`/bank?statement=${current!.id}${showAll ? "" : "&filter=all"}`} className="text-xs font-medium text-accent">{showAll ? "Only unmatched" : "Show all"}</Link>}
            />
            {lines.length === 0 ? <Empty title="Everything is matched" body="Every bank line is linked to a ledger entry." /> : (
              <ul className="divide-y divide-line/70">
                {lines.map((l) => {
                  const cands = !l.match ? candidatesFor(db, l).slice(0, 5) : [];
                  const sug = !l.match && !cands.length ? suggestForLine(db, l) : null;
                  return (
                    <li key={l.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[1fr_auto_minmax(280px,380px)] lg:items-start">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-ink">{l.description || "—"}</p>
                        <p className="text-xs text-muted">{fmtDate(l.date)}{l.reference ? ` · ${l.reference}` : ""}</p>
                        {l.match && (
                          <p className="mt-1 text-xs">
                            <Badge tone="pos">{METHOD[l.match.method]}</Badge> <Link href={`/transactions/${l.match.journal_id}`} className="text-accent">#{l.match.journal_id}</Link>
                            <span className="text-muted"> · {l.match.by_name ?? "system"} · {fmtTimestamp(l.match.at)}{l.match.score ? ` · ${Math.round(l.match.score * 100)}% confidence` : ""}</span>
                          </p>
                        )}
                      </div>
                      <Money cents={l.amount} colored className="text-sm font-semibold lg:text-right" />
                      {editable ? (
                        <BankLineActions
                          lineId={l.id}
                          amount={l.amount}
                          matched={!!l.match}
                          candidates={cands.map((c) => ({ id: c.entry.id, label: `#${c.entry.id} ${fmtDate(c.entry.doc_date)} ${c.entry.counterparty || c.entry.memo}`.slice(0, 60), score: c.score }))}
                          suggestion={sug}
                          contacts={contacts}
                        />
                      ) : <span />}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {rec.inTransit.length > 0 && (
            <Card className="mt-6">
              <CardHeader title="In transit" subtitle="Ledger cash entries in the statement period that the bank hasn't shown yet" />
              <ul className="divide-y divide-line/70 text-sm">{rec.inTransit.map((e) => (
                <li key={e.id} className="flex justify-between px-5 py-2.5"><span><Link href={`/transactions/${e.id}`} className="text-accent">#{e.id}</Link> <span className="text-muted">{fmtDate(e.doc_date)} · {e.counterparty || e.memo}</span></span><Money cents={e.amount} colored /></li>
              ))}</ul>
            </Card>
          )}
        </>
      )}
    </>
  );
}
