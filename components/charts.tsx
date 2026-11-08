"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtCompact, fmtDate, fmtMoney, fmtMonth } from "@/lib/money";

const tooltipStyle = {
  contentStyle: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    boxShadow: "var(--shadow)",
    fontSize: 12,
    color: "var(--text)",
  },
  labelStyle: { color: "var(--muted)", marginBottom: 4 },
};
const axis = { stroke: "var(--muted)", fontSize: 11, tickLine: false, axisLine: false } as const;

export function BalanceTrend({ data }: { data: { date: string; inventory: number; cash: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {["1", "2"].map((n) => (
            <linearGradient key={n} id={`g${n}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={`var(--chart-${n})`} stopOpacity={0.28} />
              <stop offset="100%" stopColor={`var(--chart-${n})`} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" {...axis} tickFormatter={(d: string) => fmtDate(d).replace(/ \d{4}$/, "")} minTickGap={40} />
        <YAxis {...axis} tickFormatter={(v: number) => fmtCompact(v)} width={56} />
        <Tooltip {...tooltipStyle} labelFormatter={(d) => fmtDate(String(d))} formatter={(v, n) => [fmtMoney(Number(v)), n === "inventory" ? "Inventory" : "Cash"]} />
        <Area type="monotone" dataKey="cash" stroke="var(--chart-2)" strokeWidth={2} fill="url(#g2)" />
        <Area type="monotone" dataKey="inventory" stroke="var(--chart-1)" strokeWidth={2} fill="url(#g1)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function RevenueChart({ data }: { data: { month: string; revenue: number; cogs: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={4}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="month" {...axis} tickFormatter={(m: string) => fmtMonth(m).slice(0, 3)} />
        <YAxis {...axis} tickFormatter={(v: number) => fmtCompact(v)} width={56} />
        <Tooltip
          {...tooltipStyle}
          cursor={{ fill: "var(--surface-2)" }}
          labelFormatter={(m) => fmtMonth(String(m))}
          formatter={(v, n) => [fmtMoney(Number(v)), n === "revenue" ? "Revenue" : "Cost of sales"]}
        />
        <Legend iconType="circle" iconSize={8} formatter={(n) => <span className="text-xs text-muted">{n === "revenue" ? "Revenue" : "Cost of sales"}</span>} />
        <Bar dataKey="revenue" fill="var(--chart-1)" radius={[6, 6, 0, 0]} maxBarSize={36} />
        <Bar dataKey="cogs" fill="var(--chart-2)" radius={[6, 6, 0, 0]} maxBarSize={36} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CashForecastChart({ data, today }: { data: { date: string; actual?: number; forecast?: number; low?: number; high?: number }[]; today: string }) {
  const rows = data.map((d) => ({ ...d, band: d.low !== undefined && d.high !== undefined ? [d.low, d.high] : undefined }));
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" {...axis} tickFormatter={(d: string) => fmtDate(d).replace(/ \d{4}$/, "")} minTickGap={40} />
        <YAxis {...axis} tickFormatter={(v: number) => fmtCompact(v)} width={56} domain={["auto", "auto"]} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(d) => fmtDate(String(d))}
          formatter={(v, n) => {
            if (Array.isArray(v)) return [`${fmtMoney(Number(v[0]))} – ${fmtMoney(Number(v[1]))}`, "80% range"];
            return [fmtMoney(Number(v)), n === "actual" ? "Actual" : "Forecast"];
          }}
        />
        <ReferenceLine x={today} stroke="var(--muted)" strokeDasharray="4 4" label={{ value: "today", position: "insideTopRight", fill: "var(--muted)", fontSize: 11 }} />
        <Area type="monotone" dataKey="band" stroke="none" fill="var(--chart-1)" fillOpacity={0.12} />
        <Line type="monotone" dataKey="actual" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="forecast" stroke="var(--chart-1)" strokeWidth={2} strokeDasharray="5 4" dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function BudgetChart({ data }: { data: { month: string; actual: number | null; budget: number | null }[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="month" {...axis} tickFormatter={(m: string) => fmtMonth(m).slice(0, 3)} />
        <YAxis {...axis} tickFormatter={(v: number) => fmtCompact(v)} width={56} />
        <Tooltip {...tooltipStyle} cursor={{ fill: "var(--surface-2)" }} labelFormatter={(m) => fmtMonth(String(m))} formatter={(v, n) => [v === null ? "—" : fmtMoney(Number(v)), n === "actual" ? "Actual" : "Budget"]} />
        <Legend iconType="circle" iconSize={8} formatter={(n) => <span className="text-xs text-muted">{n === "actual" ? "Actual" : "Budget"}</span>} />
        <Bar dataKey="actual" fill="var(--chart-1)" radius={[6, 6, 0, 0]} maxBarSize={28} />
        <Line type="stepAfter" dataKey="budget" stroke="var(--chart-3)" strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 0.0001);
  const w = 96;
  const h = 24;
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="overflow-visible">
      <polyline points={pts} fill="none" stroke="var(--chart-1)" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
