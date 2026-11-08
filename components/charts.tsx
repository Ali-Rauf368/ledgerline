"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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
