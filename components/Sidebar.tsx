"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRight, Boxes, CalendarCheck, FileBarChart, LayoutDashboard, Plus, ScrollText, ShieldCheck } from "lucide-react";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/transactions", label: "Journal", icon: ArrowLeftRight },
  { href: "/reports", label: "Reports", icon: FileBarChart },
  { href: "/periods", label: "Periods", icon: CalendarCheck },
  { href: "/integrity", label: "Integrity", icon: ShieldCheck },
  { href: "/audit", label: "Audit log", icon: ScrollText },
];

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-500 shadow-lg shadow-indigo-500/30">
        <svg viewBox="0 0 24 24" className="size-4.5 text-white" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
          <path d="M5 4v16h14M9 15l3-4 3 2 4-6" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-white">Ledgerline</span>
    </Link>
  );
}

export function Sidebar({ head }: { head: { id: number; hash: string } | null }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

  return (
    <>
      {/* Desktop */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col bg-sidebar px-4 py-6 lg:flex">
        <div className="px-2">
          <Logo />
        </div>
        <Link href="/transactions/new" className="mt-7 flex items-center justify-center gap-2 rounded-lg bg-white/10 px-3 py-2.5 text-sm font-medium text-white ring-1 ring-white/10 transition hover:bg-white/15">
          <Plus className="size-4" /> New transaction
        </Link>
        <nav className="mt-6 flex flex-col gap-0.5">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                active(href) ? "bg-sidebar-2 text-white" : "text-sidebar-ink hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon className={`size-4 ${active(href) ? "text-indigo-300" : "opacity-70 group-hover:opacity-100"}`} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto rounded-xl bg-sidebar-2 p-3.5 ring-1 ring-white/5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-300">
            <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400" /> Append-only ledger
          </p>
          <p className="mt-2 text-[11px] text-sidebar-ink">Chain head</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-white/80" title={head?.hash}>
            {head ? `#${head.id} · ${head.hash.slice(0, 14)}…` : "Empty ledger"}
          </p>
        </div>
      </aside>

      {/* Mobile */}
      <div className="sticky top-0 z-20 bg-sidebar lg:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Logo />
          <Link href="/transactions/new" className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white">
            <Plus className="size-3.5" /> New
          </Link>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2.5 [scrollbar-width:none]">
          {NAV.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${active(href) ? "bg-white text-sidebar" : "text-sidebar-ink"}`}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </>
  );
}
