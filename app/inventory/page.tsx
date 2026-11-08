import Link from "next/link";
import { NewItemForm } from "@/components/forms";
import { Badge, Card, CardHeader, Empty, Money, PageHeader } from "@/components/ui";
import { getDb } from "@/lib/db";
import { fmtMoney, fmtQty } from "@/lib/money";
import { itemsOverview, warehouses } from "@/lib/reports";

export default function InventoryPage() {
  const db = getDb();
  const items = itemsOverview(db);
  const whs = warehouses(db);
  const total = items.reduce((s, i) => s + i.value, 0);

  return (
    <>
      <PageHeader
        eyebrow="Stock sub-ledger"
        title="Inventory"
        subtitle="Positions are read from the running balance stored on each stock movement, valued at moving-average cost in whole cents."
      />

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
          <Card>
            <CardHeader title="New item" subtitle="Items are master data; their stock history is immutable." />
            <div className="p-5">
              <NewItemForm />
            </div>
          </Card>
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
