"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  ArrowLeftRight, Boxes, CalendarCheck, CheckCheck, ClipboardList, FileBarChart, Landmark, LayoutDashboard, Lightbulb,
  LogOut, Plus, ScrollText, Search, ShieldCheck, Sparkles, Target, Users, Contact, Clock4,
} from "lucide-react";
import type { Permission } from "@/lib/auth";
import { logoutAction } from "@/lib/actions";
import { openPalette } from "./CommandPalette";
import { openCopilot } from "./Copilot";

type Nav = { href: string; label: string; icon: typeof Boxes; perm?: Permission; badge?: "pending" };
const SECTIONS: { title: string; items: Nav[] }[] = [
  {
    title: "Operate",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/inventory", label: "Inventory", icon: Boxes },
      { href: "/orders", label: "Orders", icon: ClipboardList },
      { href: "/contacts", label: "Customers & suppliers", icon: Contact },
      { href: "/transactions", label: "Journal", icon: ArrowLeftRight },
    ],
  },
  {
    title: "Finance",
    items: [
      { href: "/receivables", label: "Receivables & payables", icon: Clock4 },
      { href: "/bank", label: "Bank reconciliation", icon: Landmark },
      { href: "/reports", label: "Reports", icon: FileBarChart },
      { href: "/insights", label: "Insights", icon: Lightbulb },
      { href: "/budgets", label: "Budgets", icon: Target },
    ],
  },
  {
    title: "Control",
    items: [
      { href: "/approvals", label: "Approvals", icon: CheckCheck, badge: "pending" },
      { href: "/periods", label: "Periods", icon: CalendarCheck },
      { href: "/integrity", label: "Integrity", icon: ShieldCheck },
      { href: "/audit", label: "Audit log", icon: ScrollText },
      { href: "/users", label: "Users & roles", icon: Users, perm: "users:manage" },
    ],
  },
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

const initials = (n: string) => n.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

export function Sidebar({
  head, user, perms, pending,
}: {
  head: { id: number; hash: string } | null;
  user: { name: string; email: string; role: string };
  perms: Permission[];
  pending: number;
}) {
  const path = usePathname();
  const router = useRouter();
  const [signingOut, start] = useTransition();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const canPost = perms.some((p) => p.startsWith("post:"));
  const visible = (n: Nav) => !n.perm || perms.includes(n.perm);
  const signOut = () => start(async () => { await logoutAction(); router.replace("/login"); router.refresh(); });

  return (
    <>
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col overflow-y-auto bg-sidebar px-4 py-5 [scrollbar-width:thin] lg:flex">
        <div className="px-2"><Logo /></div>
        {canPost && (
          <Link href="/transactions/new" className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-white/10 px-3 py-2.5 text-sm font-medium text-white ring-1 ring-white/10 transition hover:bg-white/15">
            <Plus className="size-4" /> New transaction
          </Link>
        )}
        <button onClick={openPalette} className="mt-3 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-sidebar-ink ring-1 ring-white/5 transition hover:bg-white/5 hover:text-white">
          <Search className="size-4 opacity-70" /> Search
          <kbd className="ml-auto rounded bg-white/10 px-1.5 py-0.5 text-[10px]">⌘K</kbd>
        </button>
        <nav className="mt-4 flex flex-col gap-4">
          {SECTIONS.map((s) => (
            <div key={s.title}>
              <p className="px-3 pb-1 text-[10px] font-semibold tracking-wider text-sidebar-ink/60 uppercase">{s.title}</p>
              <div className="flex flex-col gap-0.5">
                {s.items.filter(visible).map(({ href, label, icon: Icon, badge }) => (
                  <Link
                    key={href}
                    href={href}
                    className={`group flex items-center gap-3 rounded-lg px-3 py-1.5 text-[13px] transition ${active(href) ? "bg-sidebar-2 text-white" : "text-sidebar-ink hover:bg-white/5 hover:text-white"}`}
                  >
                    <Icon className={`size-4 ${active(href) ? "text-indigo-300" : "opacity-70 group-hover:opacity-100"}`} />
                    <span className="flex-1">{label}</span>
                    {badge === "pending" && pending > 0 && <span className="rounded-full bg-amber-400 px-1.5 text-[10px] font-semibold text-black">{pending}</span>}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <button onClick={() => openCopilot()} className="mt-5 flex items-center gap-3 rounded-xl bg-gradient-to-br from-indigo-500/20 to-cyan-500/10 p-3 text-left ring-1 ring-indigo-400/20 transition hover:ring-indigo-400/50">
          <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-500 text-white"><Sparkles className="size-4" /></span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-white">Ledger Copilot</span>
            <span className="block text-[11px] text-sidebar-ink">Ask about your books · ⌘J</span>
          </span>
        </button>
        <div className="mt-auto pt-4">
          <p className="truncate px-2 font-mono text-[10px] text-sidebar-ink/70" title={head?.hash}>
            <span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-400" /> {head ? `#${head.id} · ${head.hash.slice(0, 16)}…` : "Empty ledger"}
          </p>
          <div className="mt-3 flex items-center gap-3 rounded-xl bg-sidebar-2 p-2.5 ring-1 ring-white/5">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-indigo-500/30 text-xs font-semibold text-indigo-100">{initials(user.name)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-white">{user.name}</span>
              <span className="block truncate text-[11px] text-sidebar-ink">{user.role}</span>
            </span>
            <button onClick={signOut} disabled={signingOut} title="Sign out" aria-label="Sign out" className="grid size-8 place-items-center rounded-lg text-sidebar-ink hover:bg-white/10 hover:text-white">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      <div className="sticky top-0 z-20 bg-sidebar lg:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Logo />
          <div className="flex items-center gap-1.5">
            <button onClick={openPalette} aria-label="Search" className="grid size-8 place-items-center rounded-lg bg-white/10 text-white"><Search className="size-4" /></button>
            {canPost && (
              <Link href="/transactions/new" className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white">
                <Plus className="size-3.5" /> New
              </Link>
            )}
            <button onClick={signOut} aria-label="Sign out" className="grid size-8 place-items-center rounded-lg bg-white/10 text-white"><LogOut className="size-4" /></button>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2.5 [scrollbar-width:none]">
          {SECTIONS.flatMap((s) => s.items).filter(visible).map(({ href, label, badge }) => (
            <Link key={href} href={href} className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${active(href) ? "bg-white text-sidebar" : "text-sidebar-ink"}`}>
              {label}{badge === "pending" && pending > 0 ? ` (${pending})` : ""}
            </Link>
          ))}
        </nav>
      </div>
    </>
  );
}
