"use client";

import { Fragment, useEffect, useRef, useState, useTransition } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUp, Bot, Eraser, FilePen, Sparkles, Wrench, X } from "lucide-react";
import type { AssistantReply, ChatTurn } from "@/lib/assistant";
import { askAssistant } from "@/lib/actions";

type Msg = ChatTurn & { tools?: string[]; notice?: string; mode?: AssistantReply["mode"]; drafts?: AssistantReply["drafts"] };

const SUGGESTIONS = [
  "Anything unusual in the books?",
  "Forecast cash and stock-outs for the next 30 days",
  "How are we tracking against budget?",
  "What's our VAT position?",
  "Sell 3 ETH-YRG-1K to Café Kranich at 26.90",
  "Is the ledger intact?",
];

const STORAGE_KEY = "ledgerline.copilot.v1";

export function openCopilot(question?: string) {
  window.dispatchEvent(new CustomEvent("copilot:open", { detail: question }));
}

export function Copilot() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, start] = useTransition();
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) setMsgs(JSON.parse(saved));
    } catch {}
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(msgs.slice(-30)));
    } catch {}
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [msgs, pending]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      setOpen(true);
      const q = (e as CustomEvent<string | undefined>).detail;
      if (q) send(q);
      else setTimeout(() => field.current?.focus(), 50);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("copilot:open", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("copilot:open", onOpen);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function send(text: string) {
    const q = text.trim();
    if (!q) return;
    const next: Msg[] = [...msgsRef.current, { role: "user", text: q }];
    setMsgs(next);
    setInput("");
    start(async () => {
      try {
        const r = await askAssistant(next.map(({ role, text }) => ({ role, text })));
        setMsgs((m) => [...m, { role: "assistant", text: r.text, tools: r.tools, notice: r.notice, mode: r.mode, drafts: r.drafts }]);
      } catch {
        setMsgs((m) => [...m, { role: "assistant", text: "Something went wrong reaching the assistant. Please try again.", mode: "offline" }]);
      }
    });
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Open Ledger Copilot"
        className={`fixed right-4 bottom-4 z-40 flex items-center gap-2 rounded-full bg-gradient-to-br from-indigo-500 to-cyan-500 py-3 pr-4 pl-3.5 text-sm font-medium text-white shadow-xl shadow-indigo-500/30 transition hover:scale-[1.03] active:scale-95 sm:right-6 sm:bottom-6 ${open ? "pointer-events-none scale-90 opacity-0" : ""}`}
      >
        <Sparkles className="size-4.5" />
        <span className="hidden sm:inline">Ask Copilot</span>
        <kbd className="hidden rounded bg-white/20 px-1.5 py-0.5 font-sans text-[10px] sm:inline">⌘J</kbd>
      </button>

      {open && <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px] sm:hidden" onClick={() => setOpen(false)} />}

      <section
        aria-label="Ledger Copilot"
        className={`fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] flex-col overflow-hidden rounded-t-3xl border border-line bg-surface shadow-2xl transition duration-300 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:h-[min(640px,calc(100dvh-3rem))] sm:w-[400px] sm:rounded-3xl ${
          open ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-8 opacity-0"
        }`}
      >
        <header className="relative flex items-center gap-3 overflow-hidden bg-sidebar px-4 py-3.5 text-white">
          <div className="pointer-events-none absolute -top-10 -right-10 size-32 rounded-full bg-indigo-500/30 blur-2xl" />
          <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-500">
            <Bot className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Ledger Copilot</p>
            <p className="truncate text-[11px] text-white/60">Read-only AI · answers from your live ledger</p>
          </div>
          {msgs.length > 0 && (
            <button onClick={() => setMsgs([])} className="grid size-8 place-items-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white" aria-label="Clear conversation" title="Clear">
              <Eraser className="size-4" />
            </button>
          )}
          <button onClick={() => setOpen(false)} className="grid size-8 place-items-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white" aria-label="Close">
            <X className="size-4.5" />
          </button>
        </header>

        <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {msgs.length === 0 && (
            <div className="pt-4">
              <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent">
                <Sparkles className="size-6" />
              </div>
              <p className="mt-3 text-center text-sm font-medium text-ink">Ask anything about your books</p>
              <p className="mx-auto mt-1 max-w-[280px] text-center text-xs text-muted">
                Copilot looks up real figures, spots anomalies, forecasts, and drafts entries for you to review. It never posts on its own.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink transition hover:border-accent hover:text-accent">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm whitespace-pre-wrap text-white">{m.text}</p>
              </div>
            ) : (
              <div key={i} className="flex gap-2.5">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                  <Bot className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  {m.tools && m.tools.length > 0 && (
                    <p className="mb-1.5 flex flex-wrap items-center gap-1 text-[10px] text-muted">
                      <Wrench className="size-3" /> {m.tools.map((t) => <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5">{t}</span>)}
                    </p>
                  )}
                  <div className="rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2.5 text-sm leading-relaxed text-ink">
                    <RichText text={m.text} />
                  </div>
                  {m.drafts?.map((d) => (
                    <Link key={d.href} href={d.href} onClick={() => setOpen(false)} className="mt-2 flex items-center gap-2 rounded-xl border border-accent/30 bg-accent-soft px-3 py-2 text-xs font-medium text-accent transition hover:border-accent">
                      <FilePen className="size-3.5" /> Review &amp; post draft: <span className="truncate font-normal">{d.label}</span>
                    </Link>
                  ))}
                  {m.notice && <p className="mt-1.5 text-[11px] text-warn">{m.notice}</p>}
                </div>
              </div>
            ),
          )}

          {pending && (
            <div className="flex gap-2.5">
              <span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent"><Bot className="size-4" /></span>
              <div className="flex items-center gap-1 rounded-2xl rounded-tl-md bg-surface-2 px-4 py-3">
                {[0, 1, 2].map((d) => <span key={d} className="size-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: `${d * 120}ms` }} />)}
              </div>
            </div>
          )}
        </div>

        <form
          className="border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <div className="flex items-end gap-2 rounded-2xl border border-line bg-bg p-1.5 transition focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10">
            <textarea
              ref={field}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder="Ask about stock, sales, cash…"
              className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-ink outline-none placeholder:text-muted"
            />
            <button disabled={pending || !input.trim()} className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-white transition disabled:opacity-40" aria-label="Send">
              <ArrowUp className="size-4" />
            </button>
          </div>
          <p className="mt-1.5 text-center text-[10px] text-muted">AI can make mistakes. Figures link back to the ledger, so verify them there.</p>
        </form>
      </section>
    </>
  );
}

/** Tiny safe renderer: paragraphs, bullet lists, **bold**, `code`, and #123 journal links. */
function RichText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        const isList = lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l) || !l.trim());
        if (isList) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-4 marker:text-muted">
              {lines.filter((l) => l.trim()).map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>)}
            </ul>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => {
              const bullet = /^\s*[-*•]\s+/.test(l);
              return (
                <Fragment key={j}>
                  {j > 0 && <br />}
                  {bullet ? <span className="ml-1">• {inline(l.replace(/^\s*[-*•]\s+/, ""))}</span> : inline(l.replace(/^#{1,4}\s+/, ""))}
                </Fragment>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|#\d+\b)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={m.index} className="font-semibold">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={m.index} className="rounded bg-surface px-1 py-0.5 font-mono text-[11px]">{t.slice(1, -1)}</code>);
    else out.push(<Link key={m.index} href={`/transactions/${t.slice(1)}`} className="font-medium text-accent hover:underline">{t}</Link>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
