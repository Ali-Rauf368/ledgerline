/**
 * Four-eyes control. Postings at or above the threshold, and every period close, are queued as a request
 * and executed only when a *different* user with the approve permission signs off. The resulting journal
 * records both people (created_by = requester, approved_by = approver), inside the hash.
 */
import type { DB } from "./db.ts";
import { all, get, run } from "./db.ts";
import type { User } from "./auth.ts";
import { requirePermission } from "./auth.ts";
import { audit, closePeriod, LedgerError } from "./ledger.ts";

export const APPROVAL_THRESHOLD = 500000; // €5,000

export type ApprovalRow = {
  id: number;
  kind: "POSTING" | "PERIOD_CLOSE";
  summary: string;
  amount: number;
  payload: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "FAILED";
  requested_by: number;
  requester: string;
  requested_at: string;
  decided_by: number | null;
  decider: string | null;
  decided_at: string | null;
  note: string;
  journal_id: number | null;
};

export function listApprovals(db: DB, status?: ApprovalRow["status"]) {
  return all<ApprovalRow>(
    db,
    `SELECT a.*, r.name requester, d.name decider FROM approvals a JOIN users r ON r.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by
     ${status ? "WHERE a.status = ?" : ""} ORDER BY CASE a.status WHEN 'PENDING' THEN 0 ELSE 1 END, a.id DESC LIMIT 100`,
    ...(status ? [status] : []),
  );
}

export const pendingCount = (db: DB) => get<{ n: number }>(db, "SELECT COUNT(*) n FROM approvals WHERE status = 'PENDING'")!.n;

export function requestApproval(db: DB, by: User, kind: ApprovalRow["kind"], summary: string, amount: number, payload: unknown) {
  if (kind === "PERIOD_CLOSE") {
    const p = (payload as { period: string }).period;
    if (get(db, "SELECT id FROM approvals WHERE kind = 'PERIOD_CLOSE' AND status = 'PENDING' AND payload = ?", JSON.stringify({ period: p }))) {
      throw new LedgerError(`A close of ${p} is already waiting for approval.`);
    }
  }
  const r = run(
    db,
    "INSERT INTO approvals (kind, summary, amount, payload, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)",
    kind, summary, amount, JSON.stringify(payload), by.id, new Date().toISOString(),
  );
  audit(db, by.email, "APPROVAL_REQUESTED", summary);
  return Number(r.lastInsertRowid);
}

/**
 * Approve and execute. `execute` performs the posting for POSTING requests (supplied by the action layer,
 * which knows the payload shapes); period closes are executed here.
 */
export function decide(
  db: DB,
  by: User,
  id: number,
  decision: "APPROVE" | "REJECT",
  note: string,
  execute?: (payload: unknown, requesterId: number, approverId: number) => number,
) {
  requirePermission(by, "approve");
  const a = get<ApprovalRow>(db, "SELECT * FROM approvals WHERE id = ?", id);
  if (!a) throw new LedgerError("Unknown request.");
  if (a.status !== "PENDING") throw new LedgerError("This request was already decided.");
  if (a.requested_by === by.id) throw new LedgerError("Four-eyes rule: someone else has to approve your own request.");
  const at = new Date().toISOString();
  if (decision === "REJECT") {
    run(db, "UPDATE approvals SET status = 'REJECTED', decided_by = ?, decided_at = ?, note = ? WHERE id = ?", by.id, at, note, id);
    audit(db, by.email, "APPROVAL_REJECTED", `${a.summary}${note ? `: ${note}` : ""}`);
    return { status: "REJECTED" as const, journalId: null };
  }
  try {
    let journalId: number | null = null;
    if (a.kind === "PERIOD_CLOSE") {
      const requester = get<{ name: string }>(db, "SELECT name FROM users WHERE id = ?", a.requested_by)!;
      const r = closePeriod(db, (JSON.parse(a.payload) as { period: string }).period, `${requester.name} (approved by ${by.name})`);
      journalId = r.closingId ?? null;
    } else {
      if (!execute) throw new LedgerError("No executor for postings.");
      journalId = execute(JSON.parse(a.payload), a.requested_by, by.id);
    }
    run(db, "UPDATE approvals SET status = 'APPROVED', decided_by = ?, decided_at = ?, note = ?, journal_id = ? WHERE id = ?", by.id, at, note, journalId, id);
    audit(db, by.email, "APPROVAL_GRANTED", `${a.summary}${journalId ? ` → #${journalId}` : ""}`);
    return { status: "APPROVED" as const, journalId };
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    run(db, "UPDATE approvals SET status = 'FAILED', decided_by = ?, decided_at = ?, note = ? WHERE id = ?", by.id, at, e.message, id);
    audit(db, by.email, "APPROVAL_FAILED", `${a.summary}: ${e.message}`);
    throw e;
  }
}

/** Whether a posting by this user needs a second approver. */
export const needsApproval = (amount: number) => amount >= APPROVAL_THRESHOLD;
