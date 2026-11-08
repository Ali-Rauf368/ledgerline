"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Boxes, CalendarCheck, CornerDownLeft, FileBarChart, FileText, LayoutDashboard, Package, Plus, Search, ShieldCheck, ScrollText, Sparkles } from "lucide-react";
import { openCopilot } from "./Copilot";

export type PaletteData = {
  items: { id: number; sku: string; name: string }[];
  journals: { id: number; label: string; kind: string }[];
};

type Cmd = { id: string; label: string; hint?: string; group: string; icon: typeof Search; run: () => void; keywords?: string };

export function openPalette() {
  window.dispatchEvent(new Event("palette:open"));
}

export function CommandPalette({ data }: { data: PaletteData }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("palette:open", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("palette:open", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);

  const go = (href: string) => () => router.push(href);
  const commands = useMemo<Cmd[]>(() => {
    const base: Cmd[] = [
      { id: "new", label: "New transaction", group: "Actions", icon: Plus, run: go("/transactions/new"), keywords: "post receipt sale transfer adjust" },
      { id: "receive", label: "Receive goods", group: "Actions", icon: Package, run: go("/transactions/new"), keywords: "purchase supplier" },
      { id: "close", label: "Close a period", group: "Actions", icon: CalendarCheck, run: go("/periods"), keywords: "month end lock" },
      { id: "verify", label: "Verify ledger integrity", group: "Actions", icon: ShieldCheck, run: go("/integrity"), keywords: "hash audit check" },
      { id: "export", label: "Export trial balance (CSV)", group: "Actions", icon: FileText, run: () => (window.location.href = "/api/export?report=tb"), keywords: "download excel csv" },
      { id: "p-over", label: "Overview", group: "Go to", icon: LayoutDashboard, run: go("/") },
      { id: "p-inv", label: "Inventory", group: "Go to", icon: Boxes, run: go("/inventory") },
      { id: "p-jr", label: "Journal", group: "Go to", icon: ArrowLeftRight, run: go("/transactions") },
      { id: "p-pl", label: "Income statement", group: "Go to", icon: FileBarChart, run: go("/reports?tab=pl"), keywords: "profit loss p&l" },
      { id: "p-bs", label: "Balance sheet", group: "Go to", icon: FileBarChart, run: go("/reports?tab=bs") },
      { id: "p-tb", label: "Trial balance", group: "Go to", icon: FileBarChart, run: go("/reports?tab=tb") },
      { id: "p-val", label: "Inventory valuation", group: "Go to", icon: FileBarChart, run: go("/reports?tab=inv") },
      { id: "p-per", label: "Periods", group: "Go to", icon: CalendarCheck, run: go("/periods") },
      { id: "p-aud", label: "Audit log", group: "Go to", icon: ScrollText, run: go("/audit") },
    ];
    const items: Cmd[] = data.items.map((i) => ({ id: `i${i.id}`, label: i.name, hint: i.sku, group: "Items", icon: Package, run: go(`/inventory/${i.id}`), keywords: i.sku }));
    const journals: Cmd[] = data.journals.map((j) => ({ id: `j${j.id}`, label: `#${j.id} · ${j.label}`, hint: j.kind, group: "Recent entries", icon: ArrowLeftRight, run: go(`/transactions/${j.id}`) }));
    return [...base, ...items, ...journals];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    let matched = s
      ? commands.filter((c) => `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(s))
      : commands.filter((c) => c.group !== "Items" && c.group !== "Recent entries").concat(commands.filter((c) => c.group === "Recent entries").slice(0, 4));
    const idMatch = s.match(/^#?(\d+)$/);
    if (idMatch) matched = [{ id: "jid", label: `Open journal #${idMatch[1]}`, group: "Jump", icon: ArrowLeftRight, run: go(`/transactions/${idMatch[1]}`) }, ...matched];
    if (s) matched.push({ id: "ai", label: `Ask Copilot: “${q.trim()}”`, group: "AI", icon: Sparkles, run: () => openCopilot(q.trim()) });
    return matched.slice(0, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, commands]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const run = (c: Cmd) => {
    setOpen(false);
    c.run();
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="size-4.5 text-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              if (e.key === "Enter" && results[sel]) { e.preventDefault(); run(results[sel]); }
            }}
            placeholder="Search pages, items, #journal, or ask AI…"
            className="h-14 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">Esc</kbd>
        </div>
        <div ref={list} className="max-h-[50vh] overflow-y-auto p-2">
          {results.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted">No results</p>}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold tracking-wider text-muted uppercase">{header}</p>}
                <button
                  data-idx={i}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(c)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${sel === i ? "bg-accent-soft text-accent" : "text-ink"}`}
                >
                  <c.icon className={`size-4 shrink-0 ${c.group === "AI" ? "text-accent" : sel === i ? "" : "text-muted"}`} />
                  <span className="flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="font-mono text-[11px] text-muted">{c.hint}</span>}
                  {sel === i && <CornerDownLeft className="size-3.5" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-muted">
          <span><kbd className="font-sans">↑↓</kbd> navigate</span>
          <span><kbd className="font-sans">↵</kbd> open</span>
          <span className="ml-auto"><kbd className="font-sans">⌘J</kbd> Copilot</span>
        </div>
      </div>
    </div>
  );
}
