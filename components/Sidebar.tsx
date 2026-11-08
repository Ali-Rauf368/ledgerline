"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { openPalette } from "./CommandPalette";
import { openCopilot } from "./Copilot";
import { Search, Sparkles, ArrowLeftRight, Boxes, CalendarCheck, FileBarChart, LayoutDashboard, Plus, ScrollText, ShieldCheck } from "lucide-react";

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
        <button onClick={openPalette} className="mt-3 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-sidebar-ink ring-1 ring-white/5 transition hover:bg-white/5 hover:text-white">
          <Search className="size-4 opacity-70" /> Search
          <kbd className="ml-auto rounded bg-white/10 px-1.5 py-0.5 text-[10px]">⌘K</kbd>
        </button>
        <nav className="mt-5 flex flex-col gap-0.5">
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
        <button onClick={() => openCopilot()} className="mt-auto mb-3 flex items-center gap-3 rounded-xl bg-gradient-to-br from-indigo-500/20 to-cyan-500/10 p-3 text-left ring-1 ring-indigo-400/20 transition hover:ring-indigo-400/50">
          <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-500 text-white"><Sparkles className="size-4" /></span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-white">Ledger Copilot</span>
            <span className="block text-[11px] text-sidebar-ink">Ask about your books · ⌘J</span>
          </span>
        </button>
        <div className="rounded-xl bg-sidebar-2 p-3.5 ring-1 ring-white/5">
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
          <div className="flex items-center gap-1.5">
          <button onClick={openPalette} aria-label="Search" className="grid size-8 place-items-center rounded-lg bg-white/10 text-white"><Search className="size-4" /></button>
          <Link href="/transactions/new" className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white">
            <Plus className="size-3.5" /> New
          </Link>
          </div>
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
