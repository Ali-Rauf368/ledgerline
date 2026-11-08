import Link from "next/link";
import { ContactForm } from "@/components/v3-forms";
import { Badge, Card, CardHeader, Empty, Money, PageHeader } from "@/components/ui";
import { can } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { contactsOverview } from "@/lib/reports";
import { pageUser } from "@/lib/session";

export default async function ContactsPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const user = await pageUser();
  const { kind: k } = await searchParams;
  const kind = k === "SUPPLIER" ? "SUPPLIER" : "CUSTOMER";
  const rows = contactsOverview(getDb(), kind);
  const totalOpen = rows.reduce((t, r) => t + r.open, 0);
  const totalOverdue = rows.reduce((t, r) => t + r.overdue, 0);
  return (
    <>
      <PageHeader eyebrow="Business partners" title="Customers & suppliers" subtitle="Payment terms set invoice due dates automatically; payments are applied to the oldest open invoice first." />
      <div className="mb-5 flex gap-1 rounded-xl bg-surface-2 p-1 sm:w-fit">
        {(["CUSTOMER", "SUPPLIER"] as const).map((x) => (
          <Link key={x} href={`/contacts?kind=${x}`} className={`rounded-lg px-4 py-2 text-sm font-medium ${kind === x ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink"}`}>{x === "CUSTOMER" ? "Customers" : "Suppliers"}</Link>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title={`${rows.length} ${kind === "CUSTOMER" ? "customers" : "suppliers"}`} subtitle={<>{kind === "CUSTOMER" ? "Owed to you" : "You owe"}: <Money cents={totalOpen} className="font-medium text-ink" /> · overdue <Money cents={totalOverdue} className={totalOverdue ? "font-medium text-neg" : ""} /></>} />
          {rows.length === 0 ? <Empty title="No contacts yet" /> : (
            <div className="overflow-x-auto">
              <table className="table min-w-[720px]">
                <thead><tr><th>Name</th><th>Terms</th><th className="text-right!">Last 12 months</th><th className="text-right!">Open</th><th className="text-right!">Overdue</th></tr></thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/contacts/${c.id}`} className="group block">
                          <span className="font-medium text-ink group-hover:text-accent">{c.name}</span>
                          <span className="mt-0.5 flex gap-2 text-xs text-muted">{c.email || "no email"}{c.currency !== "EUR" && <Badge tone="accent">{c.currency}</Badge>}</span>
                        </Link>
                      </td>
                      <td className="text-muted">{c.terms_days} days</td>
                      <td className="text-right"><Money cents={c.volume12m} /> <span className="text-xs text-muted">({c.docs12m})</span></td>
                      <td className="text-right font-medium"><Money cents={c.open} /> {c.invoices > 0 && <span className="text-xs font-normal text-muted">({c.invoices})</span>}</td>
                      <td className="text-right">{c.overdue ? <Money cents={c.overdue} className="font-medium text-neg" /> : <span className="text-muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {can(user, "contacts:edit") && (
          <Card>
            <CardHeader title={`New ${kind === "CUSTOMER" ? "customer" : "supplier"}`} />
            <div className="p-5"><ContactForm kind={kind} /></div>
          </Card>
        )}
      </div>
    </>
  );
}
