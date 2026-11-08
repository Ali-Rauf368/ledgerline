import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, PackageCheck } from "lucide-react";
import { CancelOrderButton } from "@/components/v3-forms";
import { Badge, Card, CardHeader, Empty, Money, PageHeader } from "@/components/ui";
import { can } from "@/lib/auth";
import { all, get, getDb } from "@/lib/db";
import { draftHref } from "@/lib/draft";
import { orderRemaining } from "@/lib/ledger";
import { fmtDate, fmtTimestamp } from "@/lib/money";
import { orderProgress } from "@/lib/reports";
import { pageUser } from "@/lib/session";

const TONE = { OPEN: "accent", PARTIAL: "warn", FULFILLED: "pos", CANCELLED: "neutral", CLOSED: "neutral" } as const;

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageUser();
  const { id } = await params;
  const db = getDb();
  const o = get<{ id: number; kind: "PO" | "SO"; number: string; contact_id: number; contact: string; warehouse_id: number; warehouse: string; order_date: string; expected_date: string | null; currency: string; fx_rate: string | null; notes: string; cancelled_at: string | null; created_at: string; creator: string | null }>(
    db,
    `SELECT o.*, c.name contact, w.name warehouse, u.name creator FROM orders o JOIN contacts c ON c.id = o.contact_id JOIN warehouses w ON w.id = o.warehouse_id LEFT JOIN users u ON u.id = o.created_by WHERE o.id = ?`,
    Number(id),
  );
  if (!o) notFound();
  const lines = all<{ item_id: number; sku: string; name: string; qty: number; unit_amount: number; vat_rate: number }>(db, "SELECT l.item_id, i.sku, i.name, l.qty, l.unit_amount, l.vat_rate FROM order_lines l JOIN items i ON i.id = l.item_id WHERE l.order_id = ? ORDER BY l.id", o.id);
  const remaining = orderRemaining(db, o.id);
  const prog = orderProgress(db, o.id, o.cancelled_at);
  const docs = all<{ id: number; doc_date: string; reference: string; reversed: number; units: number }>(
    db,
    `SELECT j.id, j.doc_date, j.reference, EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = j.id) reversed, (SELECT SUM(ABS(qty)) FROM stock_moves WHERE journal_id = j.id) units
     FROM journals j WHERE j.order_id = ? ORDER BY j.id`,
    o.id,
  );
  const open = lines.filter((l) => (remaining.get(l.item_id) ?? 0) > 0);
  const kind = o.kind === "PO" ? "RECEIPT" : "SALE";
  const canPost = can(user, o.kind === "PO" ? "post:RECEIPT" : "post:SALE");
  const draft = draftHref({
    kind,
    warehouseId: o.warehouse_id,
    contactId: o.contact_id,
    orderId: o.id,
    counterparty: o.contact,
    reference: o.number,
    currency: o.currency !== "EUR" ? o.currency : undefined,
    fxRate: o.fx_rate ?? undefined,
    lines: open.map((l) => ({ itemId: l.item_id, qty: String(remaining.get(l.item_id)), amount: (l.unit_amount / 100).toFixed(2), vatRate: l.vat_rate })),
  });
  const fmt = (c: number) => (o.currency === "EUR" ? <Money cents={c} /> : <span className="num">{(c / 100).toFixed(2)} {o.currency}</span>);
  return (
    <>
      <Link href="/orders" className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink"><ArrowLeft className="size-3.5" /> Orders</Link>
      <PageHeader
        eyebrow={o.kind === "PO" ? "Purchase order" : "Sales order"}
        title={o.number}
        subtitle={<><Link href={`/contacts/${o.contact_id}`} className="text-accent">{o.contact}</Link> · {o.warehouse} · ordered {fmtDate(o.order_date)}{o.expected_date ? `, expected ${fmtDate(o.expected_date)}` : ""}{o.notes ? ` · ${o.notes}` : ""}</>}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[prog.status]} className="px-3! py-1.5! text-xs!">{prog.status.toLowerCase()}</Badge>
            {!o.cancelled_at && open.length > 0 && can(user, "orders:edit") && <CancelOrderButton id={o.id} />}
            {!o.cancelled_at && open.length > 0 && canPost && <Link href={draft} className="btn-primary"><PackageCheck className="size-4" /> {o.kind === "PO" ? "Receive remaining" : "Deliver remaining"}</Link>}
          </div>
        }
      />
      <Card>
        <CardHeader title="Lines" subtitle={`${prog.delivered} of ${prog.ordered} units ${o.kind === "PO" ? "received" : "delivered"}`} />
        <div className="overflow-x-auto">
          <table className="table min-w-[720px]">
            <thead><tr><th>Item</th><th className="text-right!">Ordered</th><th className="text-right!">{o.kind === "PO" ? "Received" : "Delivered"}</th><th className="text-right!">Outstanding</th><th className="text-right!">Unit</th><th className="text-right!">VAT</th><th className="text-right!">Net</th></tr></thead>
            <tbody>
              {lines.map((l) => {
                const rem = o.cancelled_at ? 0 : (remaining.get(l.item_id) ?? 0);
                return (
                  <tr key={l.item_id}>
                    <td><span className="font-mono text-xs text-muted">{l.sku}</span> {l.name}</td>
                    <td className="num text-right">{l.qty}</td>
                    <td className="num text-right">{l.qty - (remaining.get(l.item_id) ?? 0)}</td>
                    <td className="num text-right font-medium">{rem ? rem : <span className="text-pos">✓</span>}</td>
                    <td className="text-right">{fmt(l.unit_amount)}</td>
                    <td className="num text-right text-muted">{l.vat_rate}%</td>
                    <td className="text-right font-medium">{fmt(l.qty * l.unit_amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card className="mt-6">
        <CardHeader title={o.kind === "PO" ? "Receipts" : "Deliveries"} subtitle={`Created ${fmtTimestamp(o.created_at)}${o.creator ? ` by ${o.creator}` : ""}${o.cancelled_at ? ` · cancelled ${fmtTimestamp(o.cancelled_at)}` : ""}`} />
        {docs.length === 0 ? <Empty title="Nothing posted yet" /> : (
          <ul className="divide-y divide-line/70">{docs.map((d) => (
            <li key={d.id} className={`flex items-center justify-between px-5 py-3 text-sm ${d.reversed ? "opacity-50" : ""}`}>
              <span><Link href={`/transactions/${d.id}`} className="text-accent">#{d.id}</Link> <span className="text-muted">{fmtDate(d.doc_date)} · {d.reference}</span></span>
              <span className="num text-muted">{d.units} units {d.reversed ? <Badge tone="neg">reversed</Badge> : null}</span>
            </li>
          ))}</ul>
        )}
      </Card>
    </>
  );
}
