import Link from "next/link";
import { CheckCircle2, Clock, Download, XCircle } from "lucide-react";
import { Card, CardHeader, Money, PageHeader } from "@/components/ui";
import type { AccountRow } from "@/lib/reports";
import { balanceSheet, fifoComparison, fxActivity, incomeStatement, inventoryValuation, trialBalance, vatReport } from "@/lib/reports";
import { openForeignInvoices, vatPosition } from "@/lib/ledger";
import { getDb } from "@/lib/db";
import { today } from "@/lib/ledger";
import { fmtDate, fmtMoney, fmtPct, fmtQty, fmtTimestamp } from "@/lib/money";

const TABS = [
  { id: "pl", label: "Income statement" },
  { id: "bs", label: "Balance sheet" },
  { id: "tb", label: "Trial balance" },
  { id: "inv", label: "Inventory valuation" },
  { id: "vat", label: "VAT return" },
  { id: "fx", label: "Foreign currency" },
  { id: "fifo", label: "FIFO vs average" },
] as const;
const EXPORTABLE = ["pl", "bs", "tb", "inv"];
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
          EXPORTABLE.includes(tab) && <a className="btn-ghost" href={`/api/export?${new URLSearchParams(Object.entries({ report: tab, from: tab === "pl" ? from : "", asOf, knownAt: knownAtInput }).filter(([, v]) => v) as [string, string][])}`}>
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
          {(tab === "pl" || tab === "vat" || tab === "fifo") && (
            <div>
              <label className="label" htmlFor="from">From</label>
              <input id="from" name="from" type="date" defaultValue={from} className="field" />
            </div>
          )}
          <div>
            <label className="label" htmlFor="asOf">{tab === "pl" || tab === "vat" || tab === "fifo" ? "To" : "As of"}</label>
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
      {tab === "vat" && <Vat from={from} asOf={asOf} />}
      {tab === "fx" && <Fx />}
      {tab === "fifo" && <Fifo from={from} asOf={asOf} />}
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
          <Total label="Operating income" value={r.operatingIncome} />
          {r.other.some((x) => x.balance) && <Section title="Other income & expense" rows={r.other} total={r.otherNet} totalLabel="Net other income" />}
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
  function Vat({ from, asOf }: { from: string; asOf: string }) {
    const r = vatReport(db, { from, asOf });
    const now = vatPosition(db);
    return (
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader title="VAT return" subtitle={`${fmtDate(from)} to ${fmtDate(asOf)}. Output VAT on sales minus input VAT on purchases.`} />
          <div className="grid gap-3 p-5 sm:grid-cols-3">
            <Kpi label="Output VAT (sales)" value={r.output} />
            <Kpi label="Input VAT (purchases)" value={r.input} />
            <Kpi label={r.net >= 0 ? "Net payable" : "Net refundable"} value={Math.abs(r.net)} tone={r.net >= 0 ? "neg" : "pos"} />
          </div>
          <div className="border-t border-line px-5 py-4 text-sm text-muted">
            Net sales in the period: <Money cents={r.taxableSales} className="font-medium text-ink" /> · effective output rate {fmtPct(r.effectiveRate)} (mix of 7% coffee and 19% goods).
          </div>
          {r.settlements.length > 0 && (
            <table className="table">
              <thead><tr><th>Settlement</th><th>Date</th><th className="text-right!">Paid (−refund)</th></tr></thead>
              <tbody>{r.settlements.map((x) => <tr key={x.id}><td><Link className="text-accent" href={`/transactions/${x.id}`}>#{x.id}</Link></td><td>{fmtDate(x.doc_date)}</td><td className="text-right"><Money cents={x.amount} /></td></tr>)}</tbody>
            </table>
          )}
        </Card>
        <Card className="p-5">
          <h2 className="text-sm font-semibold">Current position</h2>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Output VAT owed</dt><dd><Money cents={now.output} /></dd></div>
            <div className="flex justify-between"><dt className="text-muted">Input VAT reclaimable</dt><dd><Money cents={now.input} /></dd></div>
            <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>{now.net >= 0 ? "To pay" : "To reclaim"}</dt><dd><Money cents={Math.abs(now.net)} /></dd></div>
          </dl>
          <Link href="/transactions/new" className="btn-primary mt-5 w-full">Settle VAT</Link>
          <p className="mt-2 text-center text-[11px] text-muted">New transaction → Cash → Settle VAT</p>
        </Card>
      </div>
    );
  }

  function Fx() {
    const open = openForeignInvoices(db);
    const f = fxActivity(db);
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader title="Open foreign-currency invoices" subtitle="Booked at the invoice-date rate. Paying at a different rate realises an FX gain or loss." />
          {open.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No open foreign invoices.</p> : (
            <div className="overflow-x-auto">
              <table className="table min-w-[640px]">
                <thead><tr><th>Invoice</th><th>Supplier</th><th className="text-right!">Amount</th><th className="text-right!">Booked rate</th><th className="text-right!">Booked EUR</th></tr></thead>
                <tbody>{open.map((o) => (
                  <tr key={o.id}>
                    <td><Link className="text-accent" href={`/transactions/${o.id}`}>#{o.id}</Link> <span className="text-xs text-muted">{fmtDate(o.doc_date)}</span></td>
                    <td>{o.counterparty}</td>
                    <td className="num text-right">{(o.foreign_amount / (o.currency === "JPY" ? 1 : 100)).toLocaleString("en-IE", { minimumFractionDigits: o.currency === "JPY" ? 0 : 2 })} {o.currency}</td>
                    <td className="num text-right text-muted">{o.fx_rate}</td>
                    <td className="text-right"><Money cents={o.eur_amount} /></td>
                  </tr>))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Settled invoices" subtitle={<>Net realised FX result: <Money cents={f.netGain} colored className="font-semibold" /></>} />
          <div className="overflow-x-auto">
            <table className="table min-w-[640px]">
              <thead><tr><th>Payment</th><th>Supplier</th><th className="text-right!">Amount</th><th className="text-right!">Booked → paid rate</th><th className="text-right!">Gain / loss</th></tr></thead>
              <tbody>{f.settled.map((x) => (
                <tr key={x.id}>
                  <td><Link className="text-accent" href={`/transactions/${x.id}`}>#{x.id}</Link> <span className="text-xs text-muted">for #{x.settles_id}</span></td>
                  <td>{x.counterparty}</td>
                  <td className="num text-right">{(x.foreign_amount / 100).toFixed(2)} {x.currency}</td>
                  <td className="num text-right text-muted">{x.booked_rate} → {x.fx_rate}</td>
                  <td className="text-right"><Money cents={x.gain} colored /></td>
                </tr>))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    );
  }

  function Fifo({ from, asOf }: { from: string; asOf: string }) {
    const r = fifoComparison(db, { from, asOf });
    return (
      <Card>
        <CardHeader title="FIFO vs moving average" subtitle="The ledger values stock at moving average. This replays every movement through FIFO layers for comparison. Sales COGS covers the selected range; values are as of the end date." />
        <div className="grid gap-3 p-5 sm:grid-cols-4">
          <Kpi label="Inventory · FIFO" value={r.fifoValue} />
          <Kpi label="Inventory · moving avg" value={r.avgValue} />
          <Kpi label="COGS in range · FIFO" value={r.fifoCogs} />
          <Kpi label="COGS in range · moving avg" value={r.avgCogs} />
        </div>
        <p className="px-5 pb-4 text-sm text-muted">
          With rising purchase costs, FIFO charges older (cheaper) layers to COGS: profit would be <Money cents={r.avgCogs - r.fifoCogs} colored className="font-medium" /> different in this range.
        </p>
        <div className="overflow-x-auto">
          <table className="table min-w-[720px]">
            <thead><tr><th>Item</th><th className="text-right!">Qty</th><th className="text-right!">FIFO value</th><th className="text-right!">Avg value</th><th className="text-right!">Difference</th><th className="text-right!">COGS FIFO</th><th className="text-right!">COGS avg</th></tr></thead>
            <tbody>{r.rows.map((x) => (
              <tr key={x.id}>
                <td><span className="font-mono text-xs text-muted">{x.sku}</span> {x.name}</td>
                <td className="num text-right">{x.qty}</td>
                <td className="text-right"><Money cents={x.fifoValue} /></td>
                <td className="text-right"><Money cents={x.avgValue} /></td>
                <td className="text-right"><Money cents={x.diff} colored /></td>
                <td className="text-right text-muted"><Money cents={x.fifoCogs} /></td>
                <td className="text-right text-muted"><Money cents={x.avgCogs} /></td>
              </tr>))}
            </tbody>
          </table>
        </div>
      </Card>
    );
  }
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "pos" | "neg" }) {
  return (
    <div className="rounded-xl bg-surface-2/70 p-4">
      <p className="text-xs text-muted">{label}</p>
      <Money cents={value} className={`mt-1 block text-xl font-semibold ${tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : ""}`} />
    </div>
  );
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
