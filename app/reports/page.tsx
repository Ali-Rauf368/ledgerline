import Link from "next/link";
import { CheckCircle2, Clock, Download, XCircle } from "lucide-react";
import { Card, CardHeader, Money, PageHeader } from "@/components/ui";
import type { AccountRow } from "@/lib/reports";
import { balanceSheet, incomeStatement, inventoryValuation, trialBalance } from "@/lib/reports";
import { getDb } from "@/lib/db";
import { today } from "@/lib/ledger";
import { fmtDate, fmtMoney, fmtPct, fmtQty, fmtTimestamp } from "@/lib/money";

const TABS = [
  { id: "pl", label: "Income statement" },
  { id: "bs", label: "Balance sheet" },
  { id: "tb", label: "Trial balance" },
  { id: "inv", label: "Inventory valuation" },
] as const;
type TabId = (typeof TABS)[number]["id"];

type SP = { tab?: string; from?: string; asOf?: string; knownAt?: string };
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const tab: TabId = TABS.some((t) => t.id === sp.tab) ? (sp.tab as TabId) : "pl";
  const t = today();
  const asOf = isDate(sp.asOf) ? sp.asOf! : t;
  const from = isDate(sp.from) ? sp.from! : `${asOf.slice(0, 7)}-01`;
  const knownAtInput = sp.knownAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sp.knownAt) ? sp.knownAt : "";
  const knownAt = knownAtInput ? `${knownAtInput}:59.999Z` : undefined;
  const db = getDb();
  const qs = (patch: Partial<SP>) => `/reports?${new URLSearchParams(Object.entries({ ...sp, tab, ...patch }).filter(([, v]) => v) as [string, string][])}`;

  return (
    <>
      <PageHeader
        eyebrow="Financial reporting"
        title="Reports"
        subtitle="Generated live from the journal. Pick any accounting date, and optionally a moment in time, to see the report exactly as it would have looked then."
        actions={
          <a className="btn-ghost" href={`/api/export?${new URLSearchParams(Object.entries({ report: tab, from: tab === "pl" ? from : "", asOf, knownAt: knownAtInput }).filter(([, v]) => v) as [string, string][])}`}>
            <Download className="size-4" /> Export CSV
          </a>
        }
      />

      <div className="mb-5 flex gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1 [scrollbar-width:none] sm:w-fit">
        {TABS.map((x) => (
          <Link key={x.id} href={qs({ tab: x.id })} className={`shrink-0 rounded-lg px-3.5 py-2 text-sm font-medium transition ${tab === x.id ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink"}`}>
            {x.label}
          </Link>
        ))}
      </div>

      <Card className="mb-6 p-4">
        <form className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto]">
          <input type="hidden" name="tab" value={tab} />
          {tab === "pl" && (
            <div>
              <label className="label" htmlFor="from">From</label>
              <input id="from" name="from" type="date" defaultValue={from} className="field" />
            </div>
          )}
          <div>
            <label className="label" htmlFor="asOf">{tab === "pl" ? "To" : "As of"}</label>
            <input id="asOf" name="asOf" type="date" defaultValue={asOf} className="field" />
          </div>
          <div>
            <label className="label flex items-center gap-1" htmlFor="knownAt"><Clock className="size-3" /> As known at (UTC, optional)</label>
            <input id="knownAt" name="knownAt" type="datetime-local" defaultValue={knownAtInput} className="field" />
          </div>
          <div className="flex gap-2">
            <button className="btn-primary">Run report</button>
            <Link href={`/reports?tab=${tab}`} className="btn-ghost">Reset</Link>
          </div>
        </form>
        {knownAt && (
          <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
            Point-in-time view: only entries posted before {fmtTimestamp(knownAt)} are included. Anything entered later, including late-entered or backdated invoices, is left out.
          </p>
        )}
      </Card>

      {tab === "pl" && <IncomeStatement from={from} asOf={asOf} knownAt={knownAt} />}
      {tab === "bs" && <BalanceSheet asOf={asOf} knownAt={knownAt} />}
      {tab === "tb" && <TrialBalance asOf={asOf} knownAt={knownAt} />}
      {tab === "inv" && <Valuation asOf={asOf} knownAt={knownAt} />}
    </>
  );

  function IncomeStatement({ from, asOf, knownAt }: { from: string; asOf: string; knownAt?: string }) {
    const r = incomeStatement(db, { from, asOf, knownAt });
    return (
      <Card className="max-w-3xl">
        <CardHeader title="Income statement" subtitle={`${fmtDate(from)} to ${fmtDate(asOf)}`} />
        <div className="px-5 py-2">
          <Section title="Revenue" rows={r.revenue} total={r.totalRevenue} />
          <Section title="Cost of sales" rows={r.costOfSales} total={r.totalCostOfSales} negative />
          <Total label="Gross profit" value={r.grossProfit} note={`margin ${fmtPct(r.grossMargin)}`} />
          <Section title="Operating expenses" rows={r.opex} total={r.totalOpex} negative />
          <Total label="Net income" value={r.netIncome} strong />
        </div>
      </Card>
    );
  }

  function BalanceSheet({ asOf, knownAt }: { asOf: string; knownAt?: string }) {
    const r = balanceSheet(db, { asOf, knownAt });
    return (
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Assets" subtitle={`As of ${fmtDate(asOf)}`} />
          <div className="px-5 py-2">
            <Section rows={r.assets} total={r.totalAssets} totalLabel="Total assets" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Liabilities & equity" subtitle={`As of ${fmtDate(asOf)}`} action={<Balanced ok={r.balanced} />} />
          <div className="px-5 py-2">
            <Section title="Liabilities" rows={r.liabilities} total={r.totalLiabilities} />
            <Section title="Equity" rows={r.equity} total={r.totalEquity} />
            <Total label="Total liabilities & equity" value={r.totalLiabilities + r.totalEquity} strong />
          </div>
        </Card>
      </div>
    );
  }

  function TrialBalance({ asOf, knownAt }: { asOf: string; knownAt?: string }) {
    const r = trialBalance(db, { asOf, knownAt });
    return (
      <Card className="max-w-4xl">
        <CardHeader title="Trial balance" subtitle={`As of ${fmtDate(asOf)}`} action={<Balanced ok={r.balanced} />} />
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Account</th><th>Type</th><th className="text-right!">Debit</th><th className="text-right!">Credit</th></tr></thead>
            <tbody>
              {r.rows.map((a) => {
                const net = a.debit - a.credit;
                return (
                  <tr key={a.code}>
                    <td><span className="font-mono text-xs text-muted">{a.code}</span> <span className="text-ink">{a.name}</span></td>
                    <td className="text-xs text-muted capitalize">{a.type.toLowerCase()}</td>
                    <td className="text-right">{net > 0 ? <Money cents={net} /> : ""}</td>
                    <td className="text-right">{net < 0 ? <Money cents={-net} /> : ""}</td>
                  </tr>
                );
              })}
              <tr className="bg-surface-2/60 font-semibold">
                <td colSpan={2}>Totals</td>
                <td className="text-right"><Money cents={r.totals.debit} /></td>
                <td className="text-right"><Money cents={r.totals.credit} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    );
  }

  function Valuation({ asOf, knownAt }: { asOf: string; knownAt?: string }) {
    const r = inventoryValuation(db, { asOf, knownAt });
    return (
      <Card>
        <CardHeader
          title="Inventory valuation"
          subtitle={`Moving-average cost as of ${fmtDate(asOf)}`}
          action={
            <span className={`flex items-center gap-1.5 text-xs font-medium ${r.reconciled ? "text-pos" : "text-neg"}`}>
              {r.reconciled ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
              Sub-ledger {fmtMoney(r.total)} {r.reconciled ? "=" : "≠"} GL {fmtMoney(r.gl)}
            </span>
          }
        />
        <div className="overflow-x-auto">
          <table className="table min-w-[640px]">
            <thead><tr><th>Item</th><th>Warehouse</th><th className="text-right!">Qty</th><th className="text-right!">Avg cost</th><th className="text-right!">Value</th></tr></thead>
            <tbody>
              {r.rows.map((p) => (
                <tr key={`${p.item_id}-${p.warehouse_id}`}>
                  <td><Link href={`/inventory/${p.item_id}`} className="hover:text-accent"><span className="font-mono text-xs text-muted">{p.sku}</span> <span className="text-ink">{p.name}</span></Link></td>
                  <td className="text-muted">{p.wh_name}</td>
                  <td className="num text-right">{fmtQty(p.qty)}</td>
                  <td className="text-right text-muted"><Money cents={Math.round(p.value / p.qty)} /></td>
                  <td className="text-right font-medium"><Money cents={p.value} /></td>
                </tr>
              ))}
              <tr className="bg-surface-2/60 font-semibold">
                <td colSpan={4}>Total inventory</td>
                <td className="text-right"><Money cents={r.total} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    );
  }
}

function Section({ title, rows, total, negative, totalLabel }: { title?: string; rows: AccountRow[]; total: number; negative?: boolean; totalLabel?: string }) {
  return (
    <div className="py-3">
      {title && <p className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">{title}</p>}
      {rows.map((r) => (
        <div key={r.code + r.name} className="flex justify-between gap-4 py-1.5 text-sm">
          <span className="text-ink">{r.code !== "—" && <span className="mr-2 font-mono text-xs text-muted">{r.code}</span>}{r.name}</span>
          <Money cents={negative ? -r.balance : r.balance} className="text-muted" />
        </div>
      ))}
      <div className="mt-1 flex justify-between gap-4 border-t border-line pt-2 text-sm font-medium">
        <span>{totalLabel ?? `Total ${title?.toLowerCase()}`}</span>
        <Money cents={negative ? -total : total} />
      </div>
    </div>
  );
}

function Total({ label, value, note, strong }: { label: string; value: number; note?: string; strong?: boolean }) {
  return (
    <div className={`-mx-5 flex items-baseline justify-between gap-4 px-5 py-3 ${strong ? "bg-accent-soft" : "bg-surface-2/60"}`}>
      <span className={`text-sm font-semibold ${strong ? "text-accent" : "text-ink"}`}>
        {label} {note && <span className="ml-1 text-xs font-normal text-muted">{note}</span>}
      </span>
      <Money cents={value} className={`font-semibold ${strong ? "text-lg text-accent" : ""}`} />
    </div>
  );
}

function Balanced({ ok }: { ok: boolean }) {
  return (
    <span className={`flex items-center gap-1.5 text-xs font-medium ${ok ? "text-pos" : "text-neg"}`}>
      {ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />} {ok ? "Balanced" : "Out of balance"}
    </span>
  );
}
