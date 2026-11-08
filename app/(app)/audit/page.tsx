import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { getDb } from "@/lib/db";
import { fmtTimestamp } from "@/lib/money";
import { auditEvents } from "@/lib/reports";

const TONE: Record<string, "pos" | "neg" | "warn" | "accent" | "neutral"> = {
  PERIOD_CLOSED: "accent",
  POSTING_REJECTED: "neg",
  JOURNAL_REVERSED: "warn",
  ITEM_CREATED: "pos",
};

export default function AuditPage() {
  const events = auditEvents(getDb());
  return (
    <>
      <PageHeader
        eyebrow="Append-only"
        title="Audit log"
        subtitle="Control events that aren't journal entries themselves: period closes, reversals, master-data changes and rejected posting attempts."
      />
      <Card>
        {events.length === 0 ? (
          <Empty title="No events yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table min-w-[720px]">
              <thead><tr><th>When</th><th>Actor</th><th>Event</th><th>Detail</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-xs text-muted">{fmtTimestamp(e.at)}</td>
                    <td className="whitespace-nowrap text-ink">{e.actor}</td>
                    <td><Badge tone={TONE[e.action] ?? "neutral"}>{e.action.replaceAll("_", " ").toLowerCase()}</Badge></td>
                    <td className="text-muted">{e.detail}</td>
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
