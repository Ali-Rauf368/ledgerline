import { TransactionForm } from "@/components/TransactionForm";
import { PageHeader } from "@/components/ui";
import { ACC } from "@/lib/accounts";
import { all, getDb } from "@/lib/db";
import { parseDraft } from "@/lib/draft";
import { lockedThrough, openForeignInvoices, rawBalance, today, vatPosition } from "@/lib/ledger";
import { itemsOverview, warehouses } from "@/lib/reports";
import { APPROVAL_THRESHOLD } from "@/lib/approvals";
import { can } from "@/lib/auth";
import { pageUser } from "@/lib/session";
import { notFound } from "next/navigation";

export default async function NewTransactionPage({ searchParams }: { searchParams: Promise<{ draft?: string }> }) {
  const { draft } = await searchParams;
  const user = await pageUser();
  const allowed = (["RECEIPT", "SALE", "TRANSFER", "ADJUSTMENT", "PAYMENT"] as const).filter((k) => can(user, `post:${k}`));
  if (!allowed.length) notFound();
  const db = getDb();
  const contacts = all<{ id: number; name: string; kind: "CUSTOMER" | "SUPPLIER"; currency: string }>(db, "SELECT id, name, kind, currency FROM contacts ORDER BY name");
  const vat = new Map(all<{ id: number; vat_rate: number }>(db, "SELECT id, vat_rate FROM items").map((r) => [r.id, r.vat_rate]));
  const items = itemsOverview(db).map(({ id, sku, name, unit, byWarehouse }) => ({ id, sku, name, unit, byWarehouse, vatRate: vat.get(id) ?? 19 }));
  return (
    <>
      <PageHeader eyebrow="Post to the journal" title="New transaction" subtitle="Each transaction becomes one atomic, balanced, hash-chained journal entry. Check the preview before posting." />
      <TransactionForm
        key={draft ?? "blank"}
        items={items}
        warehouses={warehouses(db)}
        today={today()}
        lockedThrough={lockedThrough(db)}
        payables={-rawBalance(db, ACC.AP)}
        receivables={rawBalance(db, ACC.AR)}
        vatNet={vatPosition(db).net}
        openInvoices={openForeignInvoices(db)}
        draft={parseDraft(draft)}
        contacts={contacts}
        allowed={[...allowed]}
        threshold={APPROVAL_THRESHOLD}
      />
    </>
  );
}
