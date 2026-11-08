import { notFound } from "next/navigation";
import { OrderForm } from "@/components/v3-forms";
import { Card, PageHeader } from "@/components/ui";
import { can } from "@/lib/auth";
import { all, getDb } from "@/lib/db";
import { today } from "@/lib/ledger";
import { warehouses } from "@/lib/reports";
import { pageUser } from "@/lib/session";

export default async function NewOrderPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const user = await pageUser();
  const { kind: k } = await searchParams;
  const kind = k === "SO" ? "SO" : "PO";
  if (!can(user, kind === "SO" ? "post:SALE" : "orders:edit")) notFound();
  const db = getDb();
  const contacts = all<{ id: number; name: string; currency: string }>(db, "SELECT id, name, currency FROM contacts WHERE kind = ? ORDER BY name", kind === "PO" ? "SUPPLIER" : "CUSTOMER");
  const items = all<{ id: number; sku: string; name: string; vat_rate: number }>(db, "SELECT id, sku, name, vat_rate FROM items ORDER BY sku");
  const lastPrice = new Map(all<{ item_id: number; p: number }>(db, "SELECT m.item_id, CAST(AVG(l.credit) AS INTEGER) p FROM stock_moves m JOIN journals j ON j.id = m.journal_id JOIN journal_lines l ON l.journal_id = j.id AND l.account_code = '4000' WHERE j.kind = 'SALE' GROUP BY m.item_id").map((r) => [r.item_id, r.p]));
  return (
    <>
      <PageHeader eyebrow={kind === "PO" ? "Purchasing" : "Sales"} title={kind === "PO" ? "New purchase order" : "New sales order"} subtitle="Orders don't touch the books. Stock and money move when you receive or deliver against them." />
      <Card className="p-5">
        <OrderForm
          kind={kind}
          today={today()}
          contacts={contacts.map((c) => ({ id: c.id, label: c.name, currency: c.currency }))}
          items={items.map((i) => ({ id: i.id, label: `${i.sku} · ${i.name}`, vat: i.vat_rate, price: lastPrice.get(i.id) }))}
          warehouses={warehouses(db).map((w) => ({ id: w.id, label: w.name }))}
        />
      </Card>
    </>
  );
}
