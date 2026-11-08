import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await currentUser()) redirect(next?.startsWith("/") && !next.startsWith("//") ? next : "/");
  const demo = process.env.LEDGERLINE_DEMO !== "0";
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-sidebar p-12 text-white lg:flex lg:flex-col">
        <div className="pointer-events-none absolute -top-40 -left-40 size-[480px] rounded-full bg-indigo-600/30 blur-3xl" />
        <div className="pointer-events-none absolute -right-20 bottom-0 size-[380px] rounded-full bg-cyan-500/20 blur-3xl" />
        <div className="relative flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-500">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round"><path d="M5 4v16h14M9 15l3-4 3 2 4-6" /></svg>
          </span>
          <span className="text-lg font-semibold">Ledgerline</span>
        </div>
        <div className="relative mt-auto max-w-md">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">Books you can prove.</h1>
          <p className="mt-4 text-base text-white/70">
            An append-only inventory ledger: every entry hash-chained, every correction a reversal, every closed month sealed,
            and every action tied to a signed-in person.
          </p>
          <ul className="mt-8 grid grid-cols-2 gap-3 text-sm text-white/80">
            {["Four-eyes approvals", "Bank reconciliation", "VAT & multi-currency", "AI Copilot & forecasts"].map((f) => (
              <li key={f} className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2.5 ring-1 ring-white/10">
                <span className="size-1.5 rounded-full bg-emerald-400" /> {f}
              </li>
            ))}
          </ul>
        </div>
      </section>
      <section className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
          <p className="mt-1 text-sm text-muted">Welcome back. Use your work account.</p>
          <LoginForm next={next} demo={demo} />
        </div>
      </section>
    </div>
  );
}
