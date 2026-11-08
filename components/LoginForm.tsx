"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LogIn } from "lucide-react";
import { loginAction } from "@/lib/actions";
import { ErrorNote } from "./forms";

const DEMO = [
  { email: "admin@ledgerline.demo", role: "Administrator", name: "Lena Admin" },
  { email: "anna@ledgerline.demo", role: "Accountant", name: "Anna Becker" },
  { email: "tom@ledgerline.demo", role: "Accountant", name: "Tom Krüger" },
  { email: "wes@ledgerline.demo", role: "Warehouse", name: "Wes Lager" },
  { email: "vic@ledgerline.demo", role: "Viewer", name: "Vic Auditor" },
];

export function LoginForm({ next, demo }: { next?: string; demo: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e?: React.FormEvent, creds?: { email: string; password: string }) => {
    e?.preventDefault();
    const c = creds ?? { email, password };
    start(async () => {
      const r = await loginAction(c.email, c.password);
      if (r.ok) {
        router.replace(next?.startsWith("/") && !next.startsWith("//") ? next : "/");
        router.refresh();
      } else setError(r.error);
    });
  };

  return (
    <>
      <form onSubmit={submit} className="mt-8 space-y-4">
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" className="field" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" className="field" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <ErrorNote message={error} />
        <button className="btn-primary w-full py-2.5" disabled={pending}><LogIn className="size-4" /> {pending ? "Signing in…" : "Sign in"}</button>
      </form>
      {demo && (
        <div className="mt-8">
          <p className="text-xs font-medium text-muted">Demo accounts (password <code className="font-mono">demo1234</code>)</p>
          <div className="mt-2 grid gap-1.5">
            {DEMO.map((d) => (
              <button
                key={d.email}
                type="button"
                disabled={pending}
                onClick={() => { setEmail(d.email); setPassword("demo1234"); submit(undefined, { email: d.email, password: "demo1234" }); }}
                className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2 text-left text-sm transition hover:border-accent"
              >
                <span><span className="block text-ink">{d.name}</span><span className="text-xs text-muted">{d.email}</span></span>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{d.role}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
