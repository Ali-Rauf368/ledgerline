import Link from "next/link";
import { BudgetEditor } from "@/components/ai-forms";
import { AskCopilotButton } from "@/components/AskCopilotButton";
import { BudgetChart } from "@/components/charts";
import { Card, CardHeader, Money, PageHeader } from "@/components/ui";
import { ACC, ACCOUNT_NAME } from "@/lib/accounts";
import { getDb } from "@/lib/db";
import { today } from "@/lib/ledger";
import { fmtMonth, fmtPct, fmtTimestamp, fmtMoney } from "@/lib/money";
import { budgetVsActual } from "@/lib/reports";
import { pageUser } from "@/lib/session";
import { can } from "@/lib/auth";

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const sp = await searchParams;
  const year = sp.year && /^\d{4}$/.test(sp.year) ? sp.year : today().slice(0, 4);
  const user = await pageUser();
  const b = budgetVsActual(getDb(), year);
  const label = (c: string) => (c === ACC.REVENUE ? "Revenue" : c === ACC.COGS ? "Cost of goods sold" : "Operating expenses");
  const revenue = b.rows.find((r) => r.code === ACC.REVENUE)!;

  return (
    <>
      <PageHeader
        eyebrow="Planning"
        title={`Budget ${year}`}
        subtitle="Monthly targets against actuals from the ledger. Variance is shown as favourable (green) or unfavourable (red); the current month is month-to-date."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/budgets?year=${Number(year) - 1}`} className="btn-ghost">← {Number(year) - 1}</Link>
            <Link href={`/budgets?year=${Number(year) + 1}`} className="btn-ghost">{Number(year) + 1} →</Link>
            <AskCopilotButton question={`How are we tracking against the ${year} budget, and which months or lines explain the variance?`} />
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {b.rows.map((r) => (
          <Card key={r.code} className="p-5">
            <p className="text-xs font-medium text-muted">{label(r.code)} · YTD</p>
            <p className="num mt-2 text-2xl font-semibold tracking-tight">{fmtMoney(r.ytdActual)}</p>
            <p className="num mt-1 text-xs text-muted">
              budget {fmtMoney(r.ytdBudget)} ·{" "}
              <span className={r.ytdVariance >= 0 ? "font-medium text-pos" : "font-medium text-neg"}>
                {r.ytdVariance >= 0 ? "▲" : "▼"} {fmtMoney(Math.abs(r.ytdVariance))} {r.ytdBudget ? `(${fmtPct(Math.abs(r.ytdVariance) / r.ytdBudget)})` : ""}
              </span>
            </p>
            <p className="mt-1 text-[11px] text-muted">Full-year budget {fmtMoney(r.fullYearBudget)}</p>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader title="Revenue: actual vs budget" />
        <div className="px-2 pt-4 pb-2"><BudgetChart data={revenue.cells.map((c) => ({ month: c.month, actual: c.actual, budget: c.budget }))} /></div>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Variance by month" subtitle="Actual / variance vs budget" />
        <div className="overflow-x-auto">
          <table className="table min-w-[1100px]">
            <thead><tr><th>Account</th>{b.months.map((m) => <th key={m} className="text-right!">{fmtMonth(m).slice(0, 3)}</th>)}</tr></thead>
            <tbody>
              {b.rows.map((r) => (
                <tr key={r.code}>
                  <td className="whitespace-nowrap"><span className="font-mono text-xs text-muted">{r.code}</span> {ACCOUNT_NAME[r.code]}</td>
                  {r.cells.map((c) => (
                    <td key={c.month} className="text-right text-xs">
                      {c.actual === null ? <span className="text-muted">—</span> : <Money cents={c.actual} className="block whitespace-nowrap" />}
                      {c.variance !== null && (
                        <span className={`num block whitespace-nowrap text-[11px] ${c.variance >= 0 ? "text-pos" : "text-neg"}`}>
                          {c.variance >= 0 ? "+" : "−"}{fmtMoney(Math.abs(c.variance)).replace("€", "€")}{c.partial ? "*" : ""}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-5 py-3 text-[11px] text-muted">* month to date</p>
      </Card>

      {can(user, "budget:edit") && <Card className="mt-6">
        <CardHeader title="Edit budget" subtitle="Whole euros per month." />
        <BudgetEditor rows={b.rows.map((r) => ({ code: r.code, label: label(r.code), cells: r.cells.map((c) => ({ month: c.month, budget: c.budget })) }))} />
      </Card>}

      {b.history.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="Change history" subtitle="Budget figures are versioned and never overwritten" />
          <ul className="divide-y divide-line/70 text-sm">
            {b.history.slice(0, 8).map((h, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2 px-5 py-2.5">
                <span>{label(h.account_code)} · {fmtMonth(h.period)} → <Money cents={h.amount} className="font-medium" /></span>
                <span className="text-xs text-muted">{h.created_by} · {fmtTimestamp(h.created_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
