import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Link2, Lock } from "lucide-react";
import { ReverseForm } from "@/components/forms";
import { Badge, Card, CardHeader, KindBadge, Money, PageHeader } from "@/components/ui";
import { getDb } from "@/lib/db";
import { computeJournalHash, today } from "@/lib/ledger";
import { all } from "@/lib/db";
import type { LineRow, MoveRow } from "@/lib/ledger";
import { fmtDate, fmtQty, fmtTimestamp } from "@/lib/money";
import { journalDetail } from "@/lib/reports";
import { pageUser } from "@/lib/session";
import { can } from "@/lib/auth";
import { get } from "@/lib/db";

export default async function JournalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageUser();
  const { id } = await params;
  const db = getDb();
  const d = journalDetail(db, Number(id));
  if (!d) notFound();
  const { journal: j, lines, moves } = d;

  const rawLines = all<LineRow>(db, "SELECT account_code, debit, credit FROM journal_lines WHERE journal_id = ? ORDER BY id", j.id);
  const rawMoves = all<MoveRow>(db, "SELECT * FROM stock_moves WHERE journal_id = ? ORDER BY id", j.id);
  const hashOk = computeJournalHash(j as never, rawLines, rawMoves) === j.hash;
  const debits = lines.reduce((s, l) => s + l.debit, 0);
  const credits = lines.reduce((s, l) => s + l.credit, 0);
  const fx = j as unknown as { currency: string | null; fx_rate: string | null; foreign_amount: number | null; settles_id: number | null };
  const settledBy = all<{ id: number }>(db, "SELECT s.id FROM journals s WHERE s.settles_id = ? AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = s.id)", j.id)[0]?.id;
  const canReverse = can(user, "reverse") && j.kind !== "REVERSAL" && j.kind !== "CLOSING" && !j.reversed_by && !settledBy;
  const meta = get<{ by: string | null; appr: string | null; contact_id: number | null; contact: string | null; due_date: string | null; order_id: number | null; order_no: string | null }>(
    db,
    `SELECT u.name by, a.name appr, j.contact_id, c.name contact, j.due_date, j.order_id, o.number order_no FROM journals j
     LEFT JOIN users u ON u.id = j.created_by LEFT JOIN users a ON a.id = j.approved_by LEFT JOIN contacts c ON c.id = j.contact_id LEFT JOIN orders o ON o.id = j.order_id
     WHERE j.id = ?`,
    j.id,
  )!;

  return (
    <>
      <Link href="/transactions" className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> Journal
      </Link>
      <PageHeader
        eyebrow={`Journal #${j.id}`}
        title={j.counterparty || j.memo || `Journal #${j.id}`}
        subtitle={j.counterparty && j.memo ? j.memo : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <KindBadge kind={j.kind} />
            {j.reversed_by && <Link href={`/transactions/${j.reversed_by}`}><Badge tone="neg">Reversed by #{j.reversed_by}</Badge></Link>}
            {j.reverses_id && <Link href={`/transactions/${j.reverses_id}`}><Badge tone="warn">Reverses #{j.reverses_id}</Badge></Link>}
            {d.lockedPeriod && <Badge><Lock className="size-3" /> Closed period</Badge>}
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="General ledger lines" subtitle={lines.length ? "Debits always equal credits" : "Transfers move value between locations and have no GL impact"} />
            {lines.length > 0 && (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr><th>Account</th><th className="text-right!">Debit</th><th className="text-right!">Credit</th></tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i}>
                        <td className={l.credit ? "pl-10!" : ""}>
                          <span className="font-mono text-xs text-muted">{l.account_code}</span> <span className="text-ink">{l.name}</span>
                        </td>
                        <td className="text-right">{l.debit ? <Money cents={l.debit} /> : ""}</td>
                        <td className="text-right">{l.credit ? <Money cents={l.credit} /> : ""}</td>
                      </tr>
                    ))}
                    <tr className="bg-surface-2/50 font-semibold">
                      <td className="text-xs text-muted">{debits === credits ? "Balanced ✓" : "UNBALANCED"}</td>
                      <td className="text-right"><Money cents={debits} /></td>
                      <td className="text-right"><Money cents={credits} /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {moves.length > 0 && (
            <Card>
              <CardHeader title="Stock movements" subtitle="Each carries the resulting position, which is never recomputed later" />
              <div className="overflow-x-auto">
                <table className="table min-w-[680px]">
                  <thead>
                    <tr>
                      <th>Item</th><th>Wh</th>
                      <th className="text-right!">Qty</th><th className="text-right!">Unit cost</th><th className="text-right!">Value</th>
                      <th className="text-right!">Position after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {moves.map((m, i) => (
                      <tr key={i}>
                        <td>
                          <Link href={`/inventory/${m.item_id}`} className="hover:text-accent">
                            <span className="block text-ink">{m.name}</span>
                            <span className="font-mono text-[11px] text-muted">{m.sku}</span>
                          </Link>
                        </td>
                        <td className="font-mono text-xs text-muted">{m.wh_code}</td>
                        <td className={`num text-right font-medium ${m.qty > 0 ? "text-pos" : "text-neg"}`}>{m.qty > 0 ? "+" : ""}{fmtQty(m.qty)}</td>
                        <td className="text-right text-muted"><Money cents={Math.round(Math.abs(m.value / m.qty))} /></td>
                        <td className="text-right"><Money cents={m.value} colored /></td>
                        <td className="num text-right text-muted">{fmtQty(m.qty_after)} · <Money cents={m.value_after} className="text-ink" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="text-sm font-semibold">Record</h2>
            <dl className="mt-4 space-y-3 text-sm">
              {[
                ["Document date", fmtDate(j.doc_date)],
                ["Posted at", fmtTimestamp(j.posted_at)],
                ["Reference", j.reference || "—"],
                ["Posted by", meta.by ?? "system / import"],
                ...(meta.appr ? [["Approved by", `${meta.appr} (four-eyes)`]] : []),
                ...(meta.contact ? [["Account", <Link key="c" href={`/contacts/${meta.contact_id}`} className="text-accent">{meta.contact}</Link>]] : []),
                ...(meta.due_date ? [["Due", fmtDate(meta.due_date)]] : []),
                ...(meta.order_no ? [["Order", <Link key="o" href={`/orders/${meta.order_id}`} className="font-mono text-accent">{meta.order_no}</Link>]] : []),
                ...(fx.currency ? [["Currency", `${(fx.foreign_amount! / (fx.currency === "JPY" ? 1 : 100)).toFixed(fx.currency === "JPY" ? 0 : 2)} ${fx.currency} @ ${fx.fx_rate}`]] : []),
                ...(fx.settles_id ? [["Settles invoice", <Link key="s" href={`/transactions/${fx.settles_id}`} className="text-accent">#{fx.settles_id}</Link>]] : []),
                ...(settledBy ? [["Paid by", <Link key="p" href={`/transactions/${settledBy}`} className="text-accent">#{settledBy}</Link>]] : []),
                ["Idempotency key", j.idempotency_key ? <code key="k" className="font-mono text-[11px]">{j.idempotency_key.slice(0, 18)}…</code> : "—"],
              ].map(([k, v]) => (
                <div key={String(k)} className="flex justify-between gap-4">
                  <dt className="text-muted">{k}</dt>
                  <dd className="text-right text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Link2 className="size-4 text-accent" /> Hash chain</h2>
              <Badge tone={hashOk ? "pos" : "neg"}>{hashOk ? "Content verified" : "Hash mismatch"}</Badge>
            </div>
            <div className="mt-4 space-y-3">
              <div>
                <p className="label">Previous</p>
                {j.id > 1 ? (
                  <Link href={`/transactions/${j.id - 1}`} className="block break-all font-mono text-[11px] text-muted hover:text-accent">{j.prev_hash}</Link>
                ) : (
                  <p className="break-all font-mono text-[11px] text-muted">{j.prev_hash} (genesis)</p>
                )}
              </div>
              <div>
                <p className="label">This entry, SHA-256(previous | content)</p>
                <p className="break-all rounded-lg bg-surface-2 p-2.5 font-mono text-[11px] text-ink">{j.hash}</p>
              </div>
            </div>
          </Card>

          {canReverse && (
            <Card className="p-5">
              <h2 className="mb-3 text-sm font-semibold">Correct this entry</h2>
              <ReverseForm journalId={j.id} today={today()} />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
