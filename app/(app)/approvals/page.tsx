import Link from "next/link";
import { CheckCheck, Clock } from "lucide-react";
import { ApprovalDecision } from "@/components/v3-forms";
import { Badge, Card, CardHeader, Empty, Money, PageHeader } from "@/components/ui";
import { APPROVAL_THRESHOLD, listApprovals } from "@/lib/approvals";
import { can } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fmtMoney, fmtTimestamp } from "@/lib/money";
import { pageUser } from "@/lib/session";

const TONE = { PENDING: "warn", APPROVED: "pos", REJECTED: "neg", FAILED: "neg" } as const;

export default async function ApprovalsPage() {
  const user = await pageUser();
  const all = listApprovals(getDb());
  const pending = all.filter((a) => a.status === "PENDING");
  const history = all.filter((a) => a.status !== "PENDING");
  const approver = can(user, "approve");
  return (
    <>
      <PageHeader
        eyebrow="Four-eyes control"
        title="Approvals"
        subtitle={<>Postings of {fmtMoney(APPROVAL_THRESHOLD)} or more, and every period close, need a second person. The approved journal records both the requester and the approver inside its hash.</>}
      />
      <Card className="mb-6">
        <CardHeader title={<span className="flex items-center gap-2"><Clock className="size-4 text-warn" /> Waiting for approval</span>} subtitle={approver ? "You can approve requests made by others." : "Your role can't approve; an accountant or admin will."} />
        {pending.length === 0 ? (
          <Empty title="Nothing waiting" body="New requests appear here and in the sidebar badge." />
        ) : (
          <ul className="divide-y divide-line/70">
            {pending.map((a) => (
              <li key={a.id} className="grid gap-4 px-5 py-4 lg:grid-cols-[1fr_320px]">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="warn">{a.kind === "PERIOD_CLOSE" ? "Period close" : "Posting"}</Badge>
                    <p className="text-sm font-medium text-ink">{a.summary}</p>
                  </div>
                  <p className="mt-1 text-xs text-muted">Requested by {a.requester} · {fmtTimestamp(a.requested_at)}{a.amount ? <> · <Money cents={a.amount} className="font-medium text-ink" /></> : null}</p>
                  {a.kind === "POSTING" && <PayloadPreview payload={a.payload} />}
                </div>
                {approver ? <ApprovalDecision id={a.id} own={a.requested_by === user.id} /> : <p className="text-xs text-muted">Read-only for your role.</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><CheckCheck className="size-4 text-pos" /> Decided</span>} />
        {history.length === 0 ? <Empty title="No decisions yet" /> : (
          <div className="overflow-x-auto">
            <table className="table min-w-[760px]">
              <thead><tr><th>Request</th><th>Requested by</th><th>Decision</th><th>Result</th></tr></thead>
              <tbody>
                {history.map((a) => (
                  <tr key={a.id}>
                    <td><span className="block text-ink">{a.summary}</span><span className="text-xs text-muted">{fmtTimestamp(a.requested_at)}</span></td>
                    <td className="text-muted">{a.requester}</td>
                    <td><Badge tone={TONE[a.status]}>{a.status.toLowerCase()}</Badge> <span className="text-xs text-muted">by {a.decider}{a.note ? ` · "${a.note}"` : ""}</span></td>
                    <td>{a.journal_id ? <Link href={`/transactions/${a.journal_id}`} className="text-accent">#{a.journal_id}</Link> : a.kind === "PERIOD_CLOSE" && a.status === "APPROVED" ? <Link href="/periods" className="text-accent">Periods</Link> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function PayloadPreview({ payload }: { payload: string }) {
  const p = JSON.parse(payload) as { kind: string; lines?: { itemId: number; qty: number; amount?: number }[]; memo?: string; reference?: string };
  return (
    <p className="mt-2 rounded-lg bg-surface-2/70 px-3 py-2 font-mono text-[11px] text-muted">
      {p.kind}{p.reference ? ` · ref ${p.reference}` : ""}{p.memo ? ` · ${p.memo}` : ""}
      {p.lines?.length ? ` · ${p.lines.map((l) => `${l.qty}× item#${l.itemId}${l.amount !== undefined ? ` @ ${(l.amount / 100).toFixed(2)}` : ""}`).join(", ")}` : ""}
    </p>
  );
}
