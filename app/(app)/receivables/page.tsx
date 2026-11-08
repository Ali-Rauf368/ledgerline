import Link from "next/link";
import { AskCopilotButton } from "@/components/AskCopilotButton";
import { Badge, Card, CardHeader, Empty, Money, PageHeader, Stat } from "@/components/ui";
import { getDb } from "@/lib/db";
import { today } from "@/lib/ledger";
import { fmtDate, fmtPct } from "@/lib/money";
import { AGE_BUCKETS, ageing } from "@/lib/reports";
import { pageUser } from "@/lib/session";

const BAR = ["bg-pos", "bg-warn/60", "bg-warn", "bg-neg/70", "bg-neg"];

export default async function ReceivablesPage({ searchParams }: { searchParams: Promise<{ side?: string; asOf?: string }> }) {
  await pageUser();
  const sp = await searchParams;
  const side = sp.side === "AP" ? "AP" : "AR";
  const asOf = sp.asOf && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : today();
  const a = ageing(getDb(), side, asOf);
  const label = side === "AR" ? "Receivables" : "Payables";
  return (
    <>
      <PageHeader
        eyebrow="Open items"
        title={`${label} ageing`}
        subtitle={side === "AR" ? "What customers owe you, by how long it is past due. Ties exactly to the Accounts receivable account (checked by Integrity)." : "What you owe suppliers, by how long it is past due. Ties exactly to Accounts payable."}
        actions={<AskCopilotButton question={side === "AR" ? "Which customers should I chase first and why? Draft a short, friendly reminder for the most overdue one." : "Which supplier invoices should I pay first this week?"} />}
      />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-xl bg-surface-2 p-1">
          {(["AR", "AP"] as const).map((x) => <Link key={x} href={`/receivables?side=${x}`} className={`rounded-lg px-4 py-2 text-sm font-medium ${side === x ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink"}`}>{x === "AR" ? "Receivables" : "Payables"}</Link>)}
        </div>
        <form className="flex items-center gap-2">
          <input type="hidden" name="side" value={side} />
          <label className="text-xs text-muted" htmlFor="asof">As of</label>
          <input id="asof" name="asOf" type="date" defaultValue={asOf} className="field w-auto! py-1.5!" />
          <button className="btn-ghost py-1.5!">Update</button>
        </form>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label={`Total ${label.toLowerCase()}`} value={<Money cents={a.total} />} hint={`${a.rows.reduce((t, r) => t + r.items.length, 0)} open invoices`} />
        <Stat label="Overdue" value={<Money cents={a.overdue} className={a.overdue ? "text-neg" : ""} />} hint={a.total ? `${fmtPct(a.overdue / a.total)} of the total` : "—"} />
        <Stat label="Unapplied payments" value={<Money cents={a.unappliedTotal} />} hint="received/paid but not matched to an invoice" />
      </div>
      <Card className="mt-6">
        <CardHeader title="Ageing buckets" subtitle={`Days past due as of ${fmtDate(asOf)}`} />
        <div className="px-5 py-4">
          <div className="flex h-3 overflow-hidden rounded-full bg-surface-2">{a.totals.map((t, i) => <div key={i} className={BAR[i]} style={{ width: `${a.total ? (t / a.total) * 100 : 0}%` }} title={AGE_BUCKETS[i]} />)}</div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {AGE_BUCKETS.map((b, i) => (
              <div key={b}><p className="flex items-center gap-1.5 text-xs text-muted"><span className={`size-2 rounded-full ${BAR[i]}`} />{b}{i ? " days" : ""}</p><Money cents={a.totals[i]} className="text-sm font-semibold" /></div>
            ))}
          </div>
        </div>
        {a.rows.length === 0 ? <Empty title="Nothing open" /> : (
          <div className="overflow-x-auto border-t border-line">
            <table className="table min-w-[860px]">
              <thead><tr><th>{side === "AR" ? "Customer" : "Supplier"}</th>{AGE_BUCKETS.map((b) => <th key={b} className="text-right!">{b}</th>)}<th className="text-right!">Total</th></tr></thead>
              <tbody>
                {a.rows.map((r) => (
                  <tr key={r.key}>
                    <td>
                      {r.contactId ? <Link href={`/contacts/${r.contactId}`} className="font-medium text-ink hover:text-accent">{r.name}</Link> : <span className="text-ink">{r.name}</span>}
                      <span className="block text-[11px] text-muted">{r.items.length} invoice(s) · oldest due {fmtDate(r.oldest)}</span>
                    </td>
                    {r.buckets.map((v, i) => <td key={i} className="text-right">{v ? <Money cents={v} className={i >= 3 ? "font-medium text-neg" : i ? "text-warn" : ""} /> : <span className="text-muted">—</span>}</td>)}
                    <td className="text-right font-semibold"><Money cents={r.total} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {a.unapplied.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="Unapplied payments" subtitle="Payments not linked to a customer or supplier invoice (e.g. booked without a contact)." />
          <ul className="divide-y divide-line/70 text-sm">{a.unapplied.slice(0, 12).map((u) => (
            <li key={u.id} className="flex justify-between px-5 py-2.5"><span><Link href={`/transactions/${u.id}`} className="text-accent">#{u.id}</Link> <span className="text-muted">{fmtDate(u.doc_date)} · {u.counterparty}</span></span><Money cents={u.amount} /></li>
          ))}</ul>
          {a.unapplied.length > 12 && <p className="px-5 py-2 text-xs text-muted">and {a.unapplied.length - 12} more <Badge>legacy</Badge></p>}
        </Card>
      )}
    </>
  );
}
