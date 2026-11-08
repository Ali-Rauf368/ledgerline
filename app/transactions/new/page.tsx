import { TransactionForm } from "@/components/TransactionForm";
import { PageHeader } from "@/components/ui";
import { ACC } from "@/lib/accounts";
import { getDb } from "@/lib/db";
import { lockedThrough, rawBalance, today } from "@/lib/ledger";
import { itemsOverview, warehouses } from "@/lib/reports";

export default function NewTransactionPage() {
  const db = getDb();
  const items = itemsOverview(db).map(({ id, sku, name, unit, byWarehouse }) => ({ id, sku, name, unit, byWarehouse }));
  return (
    <>
      <PageHeader eyebrow="Post to the journal" title="New transaction" subtitle="Each transaction becomes one atomic, balanced, hash-chained journal entry. Check the preview before posting." />
      <TransactionForm
        items={items}
        warehouses={warehouses(db)}
        today={today()}
        lockedThrough={lockedThrough(db)}
        payables={-rawBalance(db, ACC.AP)}
        receivables={rawBalance(db, ACC.AR)}
      />
    </>
  );
}
