import type { ReactNode } from "react";
import type { JournalKind } from "@/lib/accounts";
import { KIND_LABEL } from "@/lib/accounts";
import { fmtMoney } from "@/lib/money";

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow?: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1.5 text-xs font-semibold tracking-wider text-accent uppercase">{eyebrow}</p>}
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-line bg-surface shadow-card ${className}`}>{children}</section>;
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

type Tone = "neutral" | "accent" | "pos" | "neg" | "warn";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  accent: "bg-accent-soft text-accent",
  pos: "bg-pos-soft text-pos",
  neg: "bg-neg-soft text-neg",
  warn: "bg-warn-soft text-warn",
};

export function Badge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[tone]} ${className}`}>
      {children}
    </span>
  );
}

const KIND_TONE: Record<JournalKind, Tone> = {
  RECEIPT: "accent",
  SALE: "pos",
  TRANSFER: "neutral",
  ADJUSTMENT: "warn",
  PAYMENT: "neutral",
  REVERSAL: "neg",
  CLOSING: "accent",
};

export function KindBadge({ kind }: { kind: JournalKind }) {
  return <Badge tone={KIND_TONE[kind]}>{KIND_LABEL[kind]}</Badge>;
}

export function Money({ cents, className = "", colored = false }: { cents: number; className?: string; colored?: boolean }) {
  const tone = colored ? (cents < 0 ? "text-neg" : cents > 0 ? "text-pos" : "text-muted") : "";
  return <span className={`num whitespace-nowrap ${tone} ${className}`}>{fmtMoney(cents)}</span>;
}

export function Stat({
  label,
  value,
  hint,
  icon,
  trend,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  trend?: { value: string; up: boolean; good?: boolean };
}) {
  const good = trend ? (trend.good ?? trend.up) : false;
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted">{label}</p>
        {icon && <span className="grid size-8 place-items-center rounded-lg bg-accent-soft text-accent">{icon}</span>}
      </div>
      <p className="num mt-3 text-2xl font-semibold tracking-tight text-ink">{value}</p>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
        {trend && (
          <span className={`num font-medium ${good ? "text-pos" : "text-neg"}`}>
            {trend.up ? "▲" : "▼"} {trend.value}
          </span>
        )}
        {hint}
      </div>
    </Card>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Hash({ value, length = 10 }: { value: string; length?: number }) {
  return (
    <code title={value} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">
      {value.slice(0, length)}…
    </code>
  );
}
