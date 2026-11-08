import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AskCopilotButton } from "@/components/AskCopilotButton";
import { Badge, Card, CardHeader, Empty, KindBadge, Money, PageHeader, Stat } from "@/components/ui";
import { all, get, getDb } from "@/lib/db";
import type { JournalKind } from "@/lib/accounts";
import { openInvoices, today } from "@/lib/ledger";
import { fmtDate } from "@/lib/money";
import { draftHref } from "@/lib/draft";
import { ordersList } from "@/lib/reports";
import { pageUser } from "@/lib/session";
import { can } from "@/lib/auth";

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageUser();
  const { id } = await params;
  const db = getDb();
  const c = get<{ id: number; kind: "CUSTOMER" | "SUPPLIER"; name: string; email: string; vat_id: string; terms_days: number; currency: string }>(db, "SELECT * FROM contacts WHERE id = ?", Number(id));
  if (!c) notFound();
  const side = c.kind === "CUSTOMER" ? "AR" : "AP";
  const open = openInvoices(db, { side, contactId: c.id });
  const t = today();
  const history = all<{ id: number; kind: JournalKind; doc_date: string; due_date: string | null; reference: string; memo: string; amount: number; reversed: number }>(
    db,
    `SELECT j.id, j.kind, j.doc_date, j.due_date, j.reference, j.memo,
       COALESCE((SELECT MAX(MAX(debit), MAX(credit)) FROM journal_lines WHERE journal_id = j.id), 0) amount,
       EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = j.id) reversed
     FROM journals j WHERE j.contact_id = ? ORDER BY j.id DESC LIMIT 60`,
    c.id,
  );
  const orders = ordersList(db).filter((o) => o.contact_id === c.id).slice(0, 8);
  const openTotal = open.reduce((s, o) => s + o.open, 0);
  const overdue = open.filter((o) => (o.due_date ?? o.doc_date) < t);
  const payType = side === "AR" ? "RECEIVE_CUSTOMER" : "PAY_SUPPLIER";
  return (
    <>
      <Link href={`/contacts?kind=${c.kind}`} className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink"><ArrowLeft className="size-3.5" /> {c.kind === "CUSTOMER" ? "Customers" : "Suppliers"}</Link>
      <PageHeader
        eyebrow={c.kind === "CUSTOMER" ? "Customer" : "Supplier"}
        title={c.name}
        subtitle={[c.email, c.vat_id && `VAT ${c.vat_id}`, `${c.terms_days}-day terms`, c.currency !== "EUR" && `invoices in ${c.currency}`].filter(Boolean).join(" · ")}
        actions={
          <>
            <AskCopilotButton question={`Summarise our account with ${c.name}: open and overdue invoices, payment behaviour, and anything I should follow up.`} />
            {can(user, "post:PAYMENT") && openTotal > 0 && c.currency === "EUR" && (
              <Link className="btn-primary" href={draftHref({ kind: "PAYMENT", cashType: payType, amount: (openTotal / 100).toFixed(2), counterparty: c.name, contactId: c.id })}>
                {side === "AR" ? "Record payment received" : "Record payment made"}
              </Link>
            )}
          </>
        }
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label={side === "AR" ? "Owed to you" : "You owe"} value={<Money cents={openTotal} />} hint={`${open.length} open invoice(s)`} />
        <Stat label="Overdue" value={<Money cents={overdue.reduce((s, o) => s + o.open, 0)} className={overdue.length ? "text-neg" : ""} />} hint={overdue.length ? `${overdue.length} invoice(s) past due` : "all on time"} />
        <Stat label="Documents" value={history.length} hint={`${orders.length} order(s)`} />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Open invoices" subtitle="Oldest due first; payments are applied in this order" />
          {open.length === 0 ? <Empty title="All settled" /> : (
            <table className="table">
              <thead><tr><th>Invoice</th><th>Due</th><th className="text-right!">Total</th><th className="text-right!">Open</th></tr></thead>
              <tbody>{open.map((o) => {
                const late = (o.due_date ?? o.doc_date) < t;
                return (
                  <tr key={o.id}>
                    <td><Link href={`/transactions/${o.id}`} className="text-accent">#{o.id}</Link> <span className="text-xs text-muted">{o.reference} · {fmtDate(o.doc_date)}</span></td>
                    <td>{o.due_date ? <Badge tone={late ? "neg" : "neutral"}>{fmtDate(o.due_date)}</Badge> : "—"}</td>
                    <td className="text-right text-muted"><Money cents={o.gross} /></td>
                    <td className="text-right font-medium"><Money cents={o.open} /></td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </Card>
        <Card>
          <CardHeader title="Orders" action={<Link href={`/orders/new?kind=${c.kind === "CUSTOMER" ? "SO" : "PO"}`} className="text-xs font-medium text-accent">New order</Link>} />
          {orders.length === 0 ? <Empty title="No orders" /> : (
            <ul className="divide-y divide-line/70">{orders.map((o) => (
              <li key={o.id}><Link href={`/orders/${o.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-2/60">
                <span><span className="font-mono text-sm text-ink">{o.number}</span> <span className="text-xs text-muted">{fmtDate(o.order_date)}</span></span>
                <span className="flex items-center gap-2 text-xs text-muted">{o.delivered}/{o.ordered} <Badge tone={o.status === "FULFILLED" ? "pos" : o.status === "PARTIAL" ? "warn" : o.status === "OPEN" ? "accent" : "neutral"}>{o.status.toLowerCase()}</Badge></span>
              </Link></li>
            ))}</ul>
          )}
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader title="Account history" />
        <div className="overflow-x-auto">
          <table className="table min-w-[640px]">
            <tbody>{history.map((h) => (
              <tr key={h.id} className={h.reversed ? "opacity-50" : ""}>
                <td className="w-16"><Link href={`/transactions/${h.id}`} className="font-mono text-xs text-accent">#{h.id}</Link></td>
                <td className="text-muted">{fmtDate(h.doc_date)}</td>
                <td><KindBadge kind={h.kind} /></td>
                <td className="text-xs text-muted">{[h.reference, h.memo].filter(Boolean).join(" · ")}</td>
                <td className="text-right"><Money cents={h.amount} className={h.reversed ? "line-through" : ""} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
