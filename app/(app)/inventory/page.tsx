import Link from "next/link";
import { NewItemForm } from "@/components/forms";
import { Badge, Card, CardHeader, Empty, Money, PageHeader } from "@/components/ui";
import { getDb } from "@/lib/db";
import { fmtMoney, fmtQty } from "@/lib/money";
import { itemsOverview, reorderInsights, warehouses } from "@/lib/reports";
import { AskCopilotButton } from "@/components/AskCopilotButton";
import { pageUser } from "@/lib/session";
import { can } from "@/lib/auth";

export default async function InventoryPage() {
  const user = await pageUser();
  const db = getDb();
  const items = itemsOverview(db);
  const whs = warehouses(db);
  const total = items.reduce((s, i) => s + i.value, 0);
  const reorder = reorderInsights(db);
  const urgent = reorder.filter((r) => r.status === "critical" || r.status === "low");
  const STATUS = {
    critical: { label: "Reorder now", tone: "neg" as const, bar: "bg-neg" },
    low: { label: "Reorder soon", tone: "warn" as const, bar: "bg-warn" },
    healthy: { label: "Healthy", tone: "pos" as const, bar: "bg-pos" },
    slow: { label: "No recent sales", tone: "neutral" as const, bar: "bg-muted" },
  };

  return (
    <>
      <PageHeader
        eyebrow="Stock sub-ledger"
        title="Inventory"
        subtitle="Positions are read from the running balance stored on each stock movement, valued at moving-average cost in whole cents."
      />

      <Card className="mb-6">
        <CardHeader
          title={<span className="flex items-center gap-2">Smart reorder <Badge tone={urgent.length ? "warn" : "pos"}>{urgent.length ? `${urgent.length} need attention` : "All covered"}</Badge></span>}
          subtitle="Days of cover from 30-day sales velocity. Suggested quantities target 4 weeks of stock (7-day lead time)."
          action={<AskCopilotButton question="What should I reorder this week, and roughly what will it cost at current average cost?" />}
        />
        <div className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-4">
          {reorder.map((r) => {
            const st = STATUS[r.status];
            const pct = r.daysCover === null ? 100 : Math.min(100, (r.daysCover / 42) * 100);
            return (
              <Link key={r.id} href={`/inventory/${r.id}`} className="group bg-surface p-4 transition hover:bg-surface-2/60">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink group-hover:text-accent">{r.name}</span>
                    <span className="font-mono text-[11px] text-muted">{r.sku}</span>
                  </span>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className={`h-full rounded-full ${st.bar}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="num mt-2 flex justify-between text-[11px] text-muted">
                  <span>{r.daysCover === null ? "—" : `${Math.round(r.daysCover)} days cover`} · {r.perDay.toFixed(1)}/day</span>
                  {r.suggested > 0 && (r.status === "critical" || r.status === "low") && <span className="font-medium text-ink">order {fmtQty(r.suggested)}</span>}
                </div>
              </Link>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader
            title={`${items.length} items`}
            subtitle={<>Carrying value <span className="num font-medium text-ink">{fmtMoney(total)}</span></>}
          />
          {items.length === 0 ? (
            <Empty title="No items yet" body="Create your first item to start receiving stock." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table min-w-[720px]">
                <thead>
                  <tr>
                    <th>Item</th>
                    {whs.map((w) => (
                      <th key={w.id} className="text-right!" title={w.name}>{w.code}</th>
                    ))}
                    <th className="text-right!">On hand</th>
                    <th className="text-right!">Avg cost</th>
                    <th className="text-right!">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link href={`/inventory/${i.id}`} className="group block">
                          <span className="font-medium text-ink group-hover:text-accent">{i.name}</span>
                          <span className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                            <span className="font-mono">{i.sku}</span>
                            <Badge>{i.category}</Badge>
                            {i.qty > 0 && i.qty < 12 && <Badge tone="warn">Low stock</Badge>}
                            {i.qty === 0 && <Badge tone="neg">Out of stock</Badge>}
                          </span>
                        </Link>
                      </td>
                      {whs.map((w) => (
                        <td key={w.id} className="num text-right text-muted">{fmtQty(i.byWarehouse[w.id]?.qty ?? 0)}</td>
                      ))}
                      <td className="num text-right font-medium text-ink">{fmtQty(i.qty)} <span className="text-xs font-normal text-muted">{i.unit}</span></td>
                      <td className="text-right text-muted"><Money cents={i.qty ? Math.round(i.value / i.qty) : 0} /></td>
                      <td className="text-right font-medium"><Money cents={i.value} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-6">
          {can(user, "post:RECEIPT") && <Card>
            <CardHeader title="New item" subtitle="Items are master data; their stock history is immutable." />
            <div className="p-5">
              <NewItemForm />
            </div>
          </Card>}
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink">Warehouses</h2>
            <ul className="mt-3 space-y-3">
              {whs.map((w) => {
                const v = items.reduce((s, i) => s + (i.byWarehouse[w.id]?.value ?? 0), 0);
                return (
                  <li key={w.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate text-ink">{w.name}</span>
                      <span className="font-mono text-xs text-muted">{w.code}</span>
                    </span>
                    <Money cents={v} className="font-medium" />
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
