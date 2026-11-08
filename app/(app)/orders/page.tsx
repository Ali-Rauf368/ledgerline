import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge, Card, Empty, Money, PageHeader } from "@/components/ui";
import { can } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fmtDate } from "@/lib/money";
import { ordersList } from "@/lib/reports";
import { pageUser } from "@/lib/session";

const STATUS_TONE = { OPEN: "accent", PARTIAL: "warn", FULFILLED: "pos", CANCELLED: "neutral", CLOSED: "neutral" } as const;

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const user = await pageUser();
  const { kind: k } = await searchParams;
  const kind = k === "SO" ? "SO" : k === "PO" ? "PO" : undefined;
  const orders = ordersList(getDb(), kind);
  const tab = (v?: "PO" | "SO", label = "") => (
    <Link href={v ? `/orders?kind=${v}` : "/orders"} className={`rounded-lg px-4 py-2 text-sm font-medium ${kind === v ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink"}`}>{label}</Link>
  );
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Orders"
        subtitle="Purchase and sales orders are commitments, not accounting entries. Receiving or delivering against an order posts the journal and tracks what is still outstanding."
        actions={
          <>
            {can(user, "orders:edit") && <Link href="/orders/new?kind=PO" className="btn-ghost"><Plus className="size-4" /> Purchase order</Link>}
            {can(user, "post:SALE") && <Link href="/orders/new?kind=SO" className="btn-primary"><Plus className="size-4" /> Sales order</Link>}
          </>
        }
      />
      <div className="mb-5 flex gap-1 rounded-xl bg-surface-2 p-1 sm:w-fit">{tab(undefined, "All")}{tab("PO", "Purchase")}{tab("SO", "Sales")}</div>
      <Card>
        {orders.length === 0 ? <Empty title="No orders yet" body="Create a purchase order to a supplier or a sales order for a customer." /> : (
          <div className="overflow-x-auto">
            <table className="table min-w-[820px]">
              <thead><tr><th>Order</th><th>Partner</th><th>Dates</th><th>Progress</th><th className="text-right!">Value (net)</th><th>Status</th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td><Link href={`/orders/${o.id}`} className="font-mono text-sm font-medium text-accent">{o.number}</Link><span className="block text-xs text-muted">{o.kind === "PO" ? "Purchase" : "Sales"} · {o.warehouse}</span></td>
                    <td className="text-ink">{o.contact}</td>
                    <td className="text-xs text-muted">{fmtDate(o.order_date)}{o.expected_date ? <> → {fmtDate(o.expected_date)}</> : ""}</td>
                    <td className="w-48">
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent" style={{ width: `${o.ordered ? (o.delivered / o.ordered) * 100 : 0}%` }} /></div>
                      <span className="num text-[11px] text-muted">{o.delivered} / {o.ordered} units</span>
                    </td>
                    <td className="text-right">{o.currency === "EUR" ? <Money cents={o.value} /> : <span className="num">{(o.value / 100).toFixed(2)} {o.currency}</span>}</td>
                    <td><Badge tone={STATUS_TONE[o.status]}>{o.status.toLowerCase()}</Badge></td>
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
