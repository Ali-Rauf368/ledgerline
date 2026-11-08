import Link from "next/link";
import { ArrowRight, Banknote, Boxes, Percent, ShieldCheck, ShieldAlert, TrendingUp } from "lucide-react";
import { AskCopilotButton } from "@/components/AskCopilotButton";
import { BalanceTrend, RevenueChart } from "@/components/charts";
import { Badge, Card, CardHeader, Empty, KindBadge, Money, PageHeader, Stat } from "@/components/ui";
import { ACC } from "@/lib/accounts";
import { getDb } from "@/lib/db";
import { verifyLedger } from "@/lib/integrity";
import { fmtDate, fmtMoney, fmtPct, fmtQty } from "@/lib/money";
import { chainHead, dailyBalances, dashboard, journalsList } from "@/lib/reports";
import { today } from "@/lib/ledger";

export default function Overview() {
  const db = getDb();
  const d = dashboard(db);
  const integrity = verifyLedger(db);
  const head = chainHead(db);
  const trend = dailyBalances(db, [ACC.INV, ACC.CASH], 120).map((r) => ({ date: r.date, inventory: Number(r[ACC.INV]), cash: Number(r[ACC.CASH]) }));
  const recent = journalsList(db, { limit: 7 });
  const top = [...d.items].sort((a, b) => b.value - a.value).slice(0, 6);

  if (!d.journalCount) {
    return (
      <>
        <PageHeader title="Welcome to Ledgerline" subtitle="Your ledger is empty." />
        <Card>
          <Empty title="No transactions yet" body="Run npm run seed for four months of demo history, or post your first goods receipt." action={<Link href="/transactions/new" className="btn-primary">New transaction</Link>} />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={fmtDate(today())}
        title="Overview"
        subtitle="Live figures computed straight from the append-only journal. Every number below can be traced to the entries that produced it."
        actions={
          <>
            <AskCopilotButton label="Summarize this month" question="Give me a short briefing on this month so far: sales, margin, cash, anything that needs my attention." />
            <Link href="/reports" className="btn-ghost">Reports</Link>
            <Link href="/transactions/new" className="btn-primary">New transaction</Link>
          </>
        }
      />

      <Link
        href="/integrity"
        className={`group mb-6 flex flex-col gap-3 rounded-2xl border p-4 transition sm:flex-row sm:items-center ${
          integrity.ok ? "border-pos/25 bg-pos-soft hover:border-pos/50" : "border-neg/30 bg-neg-soft hover:border-neg/60"
        }`}
      >
        <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${integrity.ok ? "bg-pos/15 text-pos" : "bg-neg/15 text-neg"}`}>
          {integrity.ok ? <ShieldCheck className="size-5" /> : <ShieldAlert className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${integrity.ok ? "text-pos" : "text-neg"}`}>
            {integrity.ok ? `All ${integrity.checks.length} integrity checks passed` : "Integrity check failed: review now"}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted">
            {integrity.journals} chained journals · head <span className="font-mono">{head?.hash.slice(0, 16)}…</span> · verified in {integrity.ms} ms
          </p>
        </div>
        <span className="flex items-center gap-1 text-xs font-medium text-muted group-hover:text-ink">
          Details <ArrowRight className="size-3.5" />
        </span>
      </Link>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Inventory value" value={fmtMoney(d.inventory)} icon={<Boxes className="size-4" />} hint={`${fmtQty(d.units)} units on hand`} />
        <Stat
          label="Revenue this month"
          value={fmtMoney(d.revenueThisMonth)}
          icon={<TrendingUp className="size-4" />}
          hint={<>Month to date · last month {fmtMoney(d.revenueLastMonth)}</>}
        />
        <Stat
          label="Gross margin"
          value={fmtPct(d.marginThisMonth)}
          icon={<Percent className="size-4" />}
          trend={{ value: `${Math.abs((d.marginThisMonth - d.marginLastMonth) * 100).toFixed(1)} pt`, up: d.marginThisMonth >= d.marginLastMonth }}
          hint="vs. last month"
        />
        <Stat label="Cash at bank" value={fmtMoney(d.cash)} icon={<Banknote className="size-4" />} hint={<>AR {fmtMoney(d.receivables)} · AP {fmtMoney(d.payables)}</>} />
      </div>

      <div className="mt-6 grid items-start gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Inventory & cash, last 120 days"
            subtitle="Daily closing balances from the general ledger"
            action={
              <div className="flex gap-3 text-xs text-muted">
                <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-[var(--chart-1)]" />Inventory</span>
                <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-[var(--chart-2)]" />Cash</span>
              </div>
            }
          />
          <div className="px-2 pt-4 pb-2">
            <BalanceTrend data={trend} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Where the value sits" subtitle="Top items by carrying value" action={<Link href="/inventory" className="text-xs font-medium text-accent">All items</Link>} />
          <ul className="divide-y divide-line/70">
            {top.map((i) => (
              <li key={i.id}>
                <Link href={`/inventory/${i.id}`} className="block px-5 py-3 transition hover:bg-surface-2/60">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm text-ink">{i.name}</span>
                    <Money cents={i.value} className="text-sm font-medium" />
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-gradient-to-r from-[var(--chart-1)] to-[var(--chart-2)]" style={{ width: `${d.inventory ? (i.value / d.inventory) * 100 : 0}%` }} />
                  </div>
                  <p className="num mt-1 text-[11px] text-muted">{fmtQty(i.qty)} {i.unit} · {d.inventory ? fmtPct(i.value / d.inventory) : "0%"} of stock</p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-6 grid items-start gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-2">
          <CardHeader title="Revenue vs. cost of sales" subtitle="By month, all periods" />
          <div className="px-2 pt-4 pb-2">
            <RevenueChart data={d.months} />
          </div>
        </Card>
        <Card className="xl:col-span-3">
          <CardHeader title="Latest journal entries" action={<Link href="/transactions" className="text-xs font-medium text-accent">Open journal</Link>} />
          <div className="overflow-x-auto">
            <table className="table">
              <tbody>
                {recent.map((j) => (
                  <tr key={j.id}>
                    <td className="w-14 font-mono text-xs text-muted">
                      <Link href={`/transactions/${j.id}`} className="hover:text-accent">#{j.id}</Link>
                    </td>
                    <td>
                      <Link href={`/transactions/${j.id}`} className="block">
                        <span className="block truncate text-ink">{j.counterparty || j.memo || "—"}</span>
                        <span className="text-xs text-muted">{fmtDate(j.doc_date)}</span>
                      </Link>
                    </td>
                    <td><KindBadge kind={j.kind} /></td>
                    <td className="text-right">
                      <Money cents={j.amount} className={j.reversed_by ? "text-muted line-through" : "font-medium"} />
                      {j.reversed_by && <Badge tone="neg" className="ml-2">reversed</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
