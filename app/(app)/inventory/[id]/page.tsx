import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Card, CardHeader, Empty, KindBadge, Money, PageHeader, Stat } from "@/components/ui";
import { getDb } from "@/lib/db";
import { fmtDate, fmtMoney, fmtQty } from "@/lib/money";
import { itemsOverview, stockCard, warehouses } from "@/lib/reports";

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const item = itemsOverview(db).find((i) => i.id === Number(id));
  if (!item) notFound();
  const card = stockCard(db, item.id);
  const whs = warehouses(db);

  return (
    <>
      <Link href="/inventory" className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> Inventory
      </Link>
      <PageHeader eyebrow={`${item.sku} · ${item.category}`} title={item.name} subtitle="Stock card: every movement with the position it left behind. Rows are permanent; corrections appear as new rows." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="On hand" value={`${fmtQty(item.qty)} ${item.unit}`} hint={whs.map((w) => `${w.code} ${fmtQty(item.byWarehouse[w.id]?.qty ?? 0)}`).join(" · ")} />
        <Stat label="Moving-average cost" value={fmtMoney(item.qty ? Math.round(item.value / item.qty) : 0)} hint="per unit, across warehouses" />
        <Stat label="Carrying value" value={fmtMoney(item.value)} />
        <Stat label="Movements" value={fmtQty(card.length)} hint={card[0] ? `last on ${fmtDate(card[0].doc_date)}` : undefined} />
      </div>

      <Card className="mt-6">
        <CardHeader title="Stock card" subtitle="Newest first. Unit cost = movement value ÷ quantity." />
        {card.length === 0 ? (
          <Empty title="No movements yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table min-w-[860px]">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Journal</th>
                  <th>Wh</th>
                  <th className="text-right!">Qty</th>
                  <th className="text-right!">Unit cost</th>
                  <th className="text-right!">Value</th>
                  <th className="text-right!">Qty after</th>
                  <th className="text-right!">Value after</th>
                </tr>
              </thead>
              <tbody>
                {card.map((m) => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap text-muted">{fmtDate(m.doc_date)}</td>
                    <td>
                      <Link href={`/transactions/${m.journal_id}`} className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted">#{m.journal_id}</span>
                        <KindBadge kind={m.kind} />
                        <span className="max-w-48 truncate text-xs text-muted">{m.counterparty || m.memo}</span>
                      </Link>
                    </td>
                    <td className="font-mono text-xs text-muted">{m.wh_code}</td>
                    <td className={`num text-right font-medium ${m.qty > 0 ? "text-pos" : "text-neg"}`}>{m.qty > 0 ? "+" : ""}{fmtQty(m.qty)}</td>
                    <td className="text-right text-muted"><Money cents={Math.round(Math.abs(m.value / m.qty))} /></td>
                    <td className="text-right"><Money cents={m.value} colored /></td>
                    <td className="num text-right text-ink">{fmtQty(m.qty_after)}</td>
                    <td className="text-right font-medium"><Money cents={m.value_after} /></td>
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
