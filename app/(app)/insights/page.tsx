import Link from "next/link";
import { AlertTriangle, Brain, CalendarClock, Info, LineChart, ShieldAlert, Sparkles } from "lucide-react";
import { AskCopilotButton } from "@/components/AskCopilotButton";
import { GenerateCommentaryButton } from "@/components/ai-forms";
import { CashForecastChart, Sparkline } from "@/components/charts";
import { RichTextStatic } from "@/components/RichTextStatic";
import { Badge, Card, CardHeader, Empty, Money, PageHeader, Stat } from "@/components/ui";
import { detectAnomalies, forecastCash, forecastDemand } from "@/lib/analytics";
import { commentaries } from "@/lib/assistant";
import { getDb } from "@/lib/db";
import { lockedThrough, today } from "@/lib/ledger";
import { fmtDate, fmtMoney, fmtMonth, fmtTimestamp } from "@/lib/money";
import { pageUser } from "@/lib/session";
import { can } from "@/lib/auth";

const SEV = {
  high: { tone: "neg" as const, icon: ShieldAlert, label: "High" },
  medium: { tone: "warn" as const, icon: AlertTriangle, label: "Medium" },
  low: { tone: "neutral" as const, icon: Info, label: "Low" },
};
const TYPE_LABEL: Record<string, string> = {
  cost_spike: "Cost spike",
  below_cost_sale: "Below-cost sale",
  margin_outlier: "Thin margin",
  shrinkage: "Write-off",
  late_posting: "Late posting",
  large_amount: "Large amount",
  possible_duplicate: "Possible duplicate",
};

export default async function InsightsPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const sp = await searchParams;
  const user = await pageUser();
  const db = getDb();
  const t = today();
  const anomalies = detectAnomalies(db);
  const shown = sp.all ? anomalies : anomalies.filter((a) => a.severity !== "low");
  const demand = forecastDemand(db);
  const cash = forecastCash(db);
  const notes = commentaries(db);
  const lock = lockedThrough(db);
  const lastMonth = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const stockouts = demand.filter((d) => d.stockoutDate).sort((a, b) => a.stockoutDate!.localeCompare(b.stockoutDate!));
  const acc = demand.filter((d) => d.accuracy !== null);
  const avgAcc = acc.length ? acc.reduce((s, d) => s + d.accuracy!, 0) / acc.length : null;

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Insights"
        subtitle="Statistical anomaly detection and 30-day forecasts computed from the ledger, plus AI-written commentary. Every flag explains why it was raised and links to the entry."
        actions={<AskCopilotButton label="Ask about these insights" question="Walk me through the most important anomalies and forecast risks right now, and what I should do about each." />}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Open flags" value={anomalies.filter((a) => a.severity !== "low").length} icon={<ShieldAlert className="size-4" />} hint={`${anomalies.filter((a) => a.severity === "high").length} high severity`} />
        <Stat label="Cash in 30 days" value={fmtMoney(cash.projected)} icon={<LineChart className="size-4" />} hint={`80%: ${fmtMoney(cash.low)} – ${fmtMoney(cash.high)}`} />
        <Stat label="Projected stock-outs" value={stockouts.length} icon={<CalendarClock className="size-4" />} hint={stockouts[0] ? `first: ${stockouts[0].sku} on ${fmtDate(stockouts[0].stockoutDate!)}` : "none within 30 days"} />
        <Stat label="Forecast accuracy" value={avgAcc === null ? "—" : `${Math.round(avgAcc * 100)}%`} icon={<Brain className="size-4" />} hint="back-test on the last 4 weeks" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader
            title="Anomalies"
            subtitle="Robust z-scores against each item's and each transaction type's own history"
            action={<Link href={sp.all ? "/insights" : "/insights?all=1"} className="text-xs font-medium text-accent">{sp.all ? "Hide low severity" : "Show all"}</Link>}
          />
          {shown.length === 0 ? (
            <Empty title="Nothing unusual" body="Costs, margins, write-offs and timing are within their normal ranges." />
          ) : (
            <ul className="max-h-[560px] divide-y divide-line/70 overflow-y-auto">
              {shown.map((a) => {
                const s = SEV[a.severity];
                return (
                  <li key={a.key} className="flex gap-3 px-5 py-3.5">
                    <s.icon className={`mt-0.5 size-4.5 shrink-0 ${a.severity === "high" ? "text-neg" : a.severity === "medium" ? "text-warn" : "text-muted"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-ink">{a.title}</p>
                        <Badge tone={s.tone}>{TYPE_LABEL[a.type]}</Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted">{a.detail}</p>
                      <p className="mt-1 text-[11px] text-muted">
                        {fmtDate(a.date)}
                        {a.journalId && <> · <Link href={`/transactions/${a.journalId}`} className="font-medium text-accent hover:underline">#{a.journalId}</Link></>}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-accent" /> Month-end commentary</span>}
            subtitle="Written by Claude from ledger facts. Each version is stored append-only with a hash of its source data."
            action={can(user, "ai:commentary") && <GenerateCommentaryButton period={lock && lock >= lastMonth ? lastMonth : lastMonth} label={`Write for ${fmtMonth(lastMonth)}`} />}
          />
          {notes.length === 0 ? (
            <Empty title="No commentary yet" body={`Generate a briefing for ${fmtMonth(lastMonth)}.`} />
          ) : (
            <div className="max-h-[560px] overflow-y-auto px-5 py-4">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <Badge tone="accent">{fmtMonth(notes[0].period)}</Badge>
                <span>{notes[0].source.startsWith("claude") ? "Claude" : "Template (offline)"}</span>·<span>{fmtTimestamp(notes[0].created_at)}</span>
              </div>
              <div className="text-sm leading-relaxed text-ink"><RichTextStatic text={notes[0].text} /></div>
              {notes.length > 1 && (
                <details className="mt-4 text-xs text-muted">
                  <summary className="cursor-pointer">Earlier versions ({notes.length - 1})</summary>
                  <ul className="mt-2 space-y-1">
                    {notes.slice(1).map((n) => <li key={n.id}>{fmtMonth(n.period)} · {n.source.split(":")[0]} · {fmtTimestamp(n.created_at)} · data {n.data_hash.slice(0, 10)}…</li>)}
                  </ul>
                </details>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Cash forecast, next 30 days"
          subtitle={<>Average operating cash flow of <Money cents={Math.round(cash.dailyDrift)} />/day, plus scheduled items{cash.scheduled.map((s) => ` · ${s.label} ${fmtMoney(s.amount)} on ${fmtDate(s.date)}`).join("")}. The shaded band is the 80% range.</>}
        />
        <div className="px-2 pt-4 pb-2">
          <CashForecastChart data={cash.points.slice(-75)} today={t} />
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Demand forecast, next 30 days" subtitle="Exponential smoothing with weekday seasonality over 12 weeks of sales, back-tested by forecasting the latest 4 weeks from the 8 before." />
        <div className="overflow-x-auto">
          <table className="table min-w-[820px]">
            <thead>
              <tr><th>Item</th><th>Next 30 days</th><th className="text-right!">Forecast</th><th className="text-right!">80% range</th><th className="text-right!">On hand</th><th>Stock-out</th><th className="text-right!">Accuracy</th></tr>
            </thead>
            <tbody>
              {demand.map((d) => (
                <tr key={d.id}>
                  <td><Link href={`/inventory/${d.id}`} className="hover:text-accent"><span className="block text-ink">{d.name}</span><span className="font-mono text-[11px] text-muted">{d.sku}</span></Link></td>
                  <td><Sparkline values={d.daily} /></td>
                  <td className="num text-right font-medium">{d.forecast30} {d.unit}</td>
                  <td className="num text-right text-muted">{d.low30}–{d.high30}</td>
                  <td className="num text-right">{d.onHand}</td>
                  <td>{d.stockoutDate ? <Badge tone={d.stockoutDate <= new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10) ? "neg" : "warn"}>{fmtDate(d.stockoutDate)}</Badge> : <Badge tone="pos">Covered</Badge>}</td>
                  <td className="num text-right text-muted">{d.accuracy === null ? "—" : `${Math.round(d.accuracy * 100)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
