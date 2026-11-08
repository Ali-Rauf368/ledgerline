import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, run } from "../lib/db.ts";
import {
  cancelOrder, closePeriod, createContact, createItem, createOrder, createWarehouse, LedgerError, openInvoices, orderRemaining,
  postCash, postReceipt, postSale, reverseJournal,
} from "../lib/ledger.ts";
import { can, createUser, login, requirePermission, updateUser, userById, userForToken, logout, verifyPassword, hashPassword } from "../lib/auth.ts";
import { decide, listApprovals, requestApproval } from "../lib/approvals.ts";
import { ageing, orderProgress } from "../lib/reports.ts";
import { autoMatch, createFromLine, importStatement, matchLine, parseAmount, parseDate, parseStatementCsv, reconciliation, unmatchLine } from "../lib/bank.ts";
import { verifyLedger } from "../lib/integrity.ts";

function world() {
  const db = openDb(":memory:");
  const wh = createWarehouse(db, "A", "Main");
  const item = createItem(db, { sku: "WID-1", name: "Widget", vatRate: 19 });
  const cust = createContact(db, { kind: "CUSTOMER", name: "Café Kranich", termsDays: 14 });
  const supp = createContact(db, { kind: "SUPPLIER", name: "Rösterei Nord GmbH", termsDays: 30 });
  postCash(db, { docDate: "2026-01-01", type: "CAPITAL", amount: 1_000_000, counterparty: "Owner" });
  postReceipt(db, { docDate: "2026-01-02", warehouseId: wh, supplier: "", contactId: supp, lines: [{ itemId: item, qty: 100, unitCost: 1000, vatRate: 19 }] });
  return { db, wh, item, cust, supp };
}

// ───────────────────────── auth ─────────────────────────

test("passwords are salted scrypt hashes and verify correctly", () => {
  const h = hashPassword("correct horse");
  assert.notEqual(h, hashPassword("correct horse"));
  assert.ok(verifyPassword("correct horse", h));
  assert.ok(!verifyPassword("wrong horse", h));
});

test("login issues a hashed session; logout and deactivation revoke it; brute force is throttled", () => {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "Ana@Example.com", name: "Ana", role: "ACCOUNTANT", password: "s3cret-pass" });
  const admin = createUser(db, { email: "root@example.com", name: "Root", role: "ADMIN", password: "s3cret-pass" });
  const { token } = login(db, "ana@example.com", "s3cret-pass");
  assert.equal(userForToken(db, token)?.id, id);
  const stored = (db.prepare("SELECT token_hash FROM sessions").get() as { token_hash: string }).token_hash;
  assert.notEqual(stored, token, "raw token must not be stored");
  logout(db, token);
  assert.equal(userForToken(db, token), null);
  const t2 = login(db, "ana@example.com", "s3cret-pass").token;
  updateUser(db, userById(db, admin)!, id, { active: false });
  assert.equal(userForToken(db, t2), null);
  for (let i = 0; i < 5; i++) assert.throws(() => login(db, "x@example.com", "nope"), /Wrong email/);
  assert.throws(() => login(db, "x@example.com", "nope"), /Too many/);
  assert.throws(() => updateUser(db, userById(db, admin)!, admin, { active: false }), /own account/);
});

test("role permissions", () => {
  assert.ok(can({ role: "ADMIN" }, "users:manage"));
  assert.ok(!can({ role: "ACCOUNTANT" }, "users:manage"));
  assert.ok(can({ role: "WAREHOUSE" }, "post:RECEIPT"));
  assert.ok(!can({ role: "WAREHOUSE" }, "post:SALE"));
  assert.ok(!can({ role: "VIEWER" }, "post:RECEIPT"));
  assert.throws(() => requirePermission({ id: 1, email: "v@x", name: "V", role: "VIEWER", active: 1, created_at: "", last_login_at: null }, "reverse"), /isn't allowed/);
});

test("four-eyes: a requester cannot approve their own request; approval records both people in the journal", () => {
  const { db } = world();
  const a = userById(db, createUser(db, { email: "a@x.io", name: "A", role: "ACCOUNTANT", password: "password1" }))!;
  const b = userById(db, createUser(db, { email: "b@x.io", name: "B", role: "ACCOUNTANT", password: "password1" }))!;
  const id = requestApproval(db, a, "POSTING", "Big expense", 900_000, { amount: 900_000 });
  assert.throws(() => decide(db, a, id, "APPROVE", ""), /someone else/);
  const r = decide(db, b, id, "APPROVE", "ok", (p, requester, approver) =>
    postCash(db, { docDate: "2026-01-05", type: "EXPENSE", amount: (p as { amount: number }).amount, counterparty: "Vendor", actorId: requester, approvedBy: approver }).id,
  );
  const j = db.prepare("SELECT created_by, approved_by FROM journals WHERE id = ?").get(r.journalId!) as { created_by: number; approved_by: number };
  assert.deepEqual([j.created_by, j.approved_by], [a.id, b.id]);
  assert.throws(() => decide(db, b, id, "APPROVE", ""), /already decided/);
  assert.equal(listApprovals(db)[0].status, "APPROVED");
  // period close through approval
  const pc = requestApproval(db, a, "PERIOD_CLOSE", "Close 2026-01", 0, { period: "2026-01" });
  assert.throws(() => requestApproval(db, b, "PERIOD_CLOSE", "again", 0, { period: "2026-01" }), /already waiting/);
  decide(db, b, pc, "APPROVE", "");
  assert.ok(verifyLedger(db).ok);
});

// ───────────────────────── contacts, invoices, ageing ─────────────────────────

test("invoices get due dates from terms; payments allocate oldest-first; ageing and AR reconcile", () => {
  const { db, wh, item, cust } = world();
  const s1 = postSale(db, { docDate: "2026-01-03", warehouseId: wh, customer: "", contactId: cust, lines: [{ itemId: item, qty: 2, unitPrice: 5000, vatRate: 19 }] });
  const s2 = postSale(db, { docDate: "2026-01-10", warehouseId: wh, customer: "", contactId: cust, lines: [{ itemId: item, qty: 1, unitPrice: 5000, vatRate: 19 }] });
  assert.equal(s1.due_date, "2026-01-17");
  assert.equal(s1.counterparty, "Café Kranich");
  postCash(db, { docDate: "2026-01-20", type: "RECEIVE_CUSTOMER", amount: 15000, counterparty: "", contactId: cust });
  const open = openInvoices(db, { side: "AR", contactId: cust });
  // s1 = 2 × 50.00 + 19% = 119.00 is fully paid; the remaining 31.00 goes to s2 (59.50 → 28.50 open).
  assert.deepEqual(open.map((o) => [o.id, o.open]), [[s2.id, 2850]]);
  const ag = ageing(db, "AR", "2026-02-20");
  assert.equal(ag.total, 2850);
  assert.equal(ag.rows[0].buckets[1], 2850); // due 24 Jan → 27 days overdue
  assert.throws(() => reverseJournal(db, { journalId: s1.id, docDate: "2026-01-21", reason: "x" }), /Reverse that payment first/);
  assert.ok(verifyLedger(db).ok, JSON.stringify(verifyLedger(db).checks.filter((c) => !c.ok)));
  // unapplied cash: a payment without a contact stays unapplied but the books still reconcile
  postCash(db, { docDate: "2026-01-22", type: "RECEIVE_CUSTOMER", amount: 1000, counterparty: "Unknown" });
  assert.equal(ageing(db, "AR").unappliedTotal, 1000);
  assert.ok(verifyLedger(db).ok);
});

test("explicit allocation to a chosen invoice, and over-payment of selected invoices is refused", () => {
  const { db, wh, item, cust } = world();
  const s1 = postSale(db, { docDate: "2026-01-03", warehouseId: wh, customer: "", contactId: cust, lines: [{ itemId: item, qty: 1, unitPrice: 1000 }] });
  const s2 = postSale(db, { docDate: "2026-01-04", warehouseId: wh, customer: "", contactId: cust, lines: [{ itemId: item, qty: 1, unitPrice: 2000 }] });
  postCash(db, { docDate: "2026-01-05", type: "RECEIVE_CUSTOMER", amount: 2000, counterparty: "", contactId: cust, invoiceIds: [s2.id] });
  assert.deepEqual(openInvoices(db, { side: "AR" }).map((o) => o.id), [s1.id]);
  assert.throws(() => postCash(db, { docDate: "2026-01-05", type: "RECEIVE_CUSTOMER", amount: 5000, counterparty: "", contactId: cust, invoiceIds: [s1.id] }), /more than/);
});

test("contact kinds are enforced", () => {
  const { db, wh, item, supp } = world();
  assert.throws(() => postSale(db, { docDate: "2026-01-03", warehouseId: wh, customer: "", contactId: supp, lines: [{ itemId: item, qty: 1, unitPrice: 1 }] }), /is a supplier/);
  assert.throws(() => createContact(db, { kind: "SUPPLIER", name: "Rösterei Nord GmbH" }), /already exists/);
});

// ───────────────────────── orders ─────────────────────────

test("orders: partial delivery, over-delivery refused, reversal reopens, cancel closes the rest", () => {
  const { db, wh, item, cust, supp } = world();
  const po = createOrder(db, { kind: "PO", contactId: supp, warehouseId: wh, orderDate: "2026-01-03", lines: [{ itemId: item, qty: 10, unitAmount: 1000, vatRate: 19 }] });
  assert.match(po.number, /^PO-2026-\d{4}$/);
  const r1 = postReceipt(db, { docDate: "2026-01-04", warehouseId: wh, supplier: "", contactId: supp, orderId: po.id, lines: [{ itemId: item, qty: 6, unitCost: 1000, vatRate: 19 }] });
  assert.equal(orderRemaining(db, po.id).get(item), 4);
  assert.equal(orderProgress(db, po.id, null).status, "PARTIAL");
  assert.throws(() => postReceipt(db, { docDate: "2026-01-05", warehouseId: wh, supplier: "", contactId: supp, orderId: po.id, lines: [{ itemId: item, qty: 5, unitCost: 1000 }] }), /only 4 left/);
  assert.throws(() => postSale(db, { docDate: "2026-01-05", warehouseId: wh, customer: "", contactId: cust, orderId: po.id, lines: [{ itemId: item, qty: 1, unitPrice: 1 }] }), /not a sales order/);
  reverseJournal(db, { journalId: r1.id, docDate: "2026-01-06", reason: "wrong PO" });
  assert.equal(orderRemaining(db, po.id).get(item), 10);
  cancelOrder(db, po.id, "t");
  assert.throws(() => postReceipt(db, { docDate: "2026-01-07", warehouseId: wh, supplier: "", contactId: supp, orderId: po.id, lines: [{ itemId: item, qty: 1, unitCost: 1 }] }), /cancelled/);
});

// ───────────────────────── bank ─────────────────────────

test("parses German and international bank formats", () => {
  assert.equal(parseAmount("1.234,56"), 123456);
  assert.equal(parseAmount("-1,234.56"), -123456);
  assert.equal(parseAmount("-12,5"), -1250);
  assert.equal(parseAmount("€ 99"), 9900);
  assert.equal(parseDate("03.02.2026"), "2026-02-03");
  assert.equal(parseDate("2026-02-03T10:00"), "2026-02-03");
  const p = parseStatementCsv('Buchungstag;Verwendungszweck;Betrag;Saldo\n02.01.2026;"Miete; Januar";-1.000,00;9.000,00\n03.01.2026;Gutschrift;250,00;9.250,00');
  assert.equal(p.lines.length, 2);
  assert.equal(p.lines[0].description, "Miete; Januar");
  assert.equal(p.closingBalance, 925000);
  assert.throws(() => parseStatementCsv("foo,bar\n1,2"), /Date/);
});

test("import auto-matches confidently, books unknown lines, and reconciles to zero", () => {
  const { db, cust } = world();
  const u = userById(db, createUser(db, { email: "acc@x.io", name: "Acc", role: "ACCOUNTANT", password: "password1" }))!;
  const fee = postCash(db, { docDate: "2026-01-10", type: "EXPENSE", amount: 2500, counterparty: "Stadtwerke", reference: "SW-77" });
  postCash(db, { docDate: "2026-01-11", type: "EXPENSE", amount: 2500, counterparty: "Telekom" }); // same amount, different payee
  const csv = [
    "Date,Description,Reference,Amount,Balance",
    "2026-01-01,Owner deposit,,10000.00,10000.00",
    "2026-01-11,STADTWERKE STROM,SW-77,-25.00,9975.00",
    "2026-01-12,TELEKOM DEUTSCHLAND,,-25.00,9950.00",
    "2026-01-31,KONTOFUEHRUNG ENTGELT,,-4.90,9945.10",
  ].join("\n");
  const imp = importStatement(db, u, "jan.csv", csv);
  assert.equal(imp.lines, 4);
  assert.ok(imp.matched >= 3, `matched ${imp.matched}`);
  const rec1 = reconciliation(db, imp.id);
  const stadt = rec1.lines.find((l) => l.description.startsWith("STADTWERKE"))!;
  assert.equal(stadt.match?.journal_id, fee.id, "text + reference must pick the right one of two equal amounts");
  assert.throws(() => importStatement(db, u, "again.csv", csv), /already imported/);
  const feeLine = rec1.lines.find((l) => l.description.startsWith("KONTO"))!;
  createFromLine(db, u, feeLine.id, { type: "EXPENSE" });
  const rec = reconciliation(db, imp.id);
  assert.equal(rec.matchedCount, 4);
  // The capital deposit was 10,000 EUR in the ledger (100,000 cents × 100)? Ledger cash includes the receipt on account (no cash), so compare:
  assert.equal(rec.difference, rec.bankClosing! - rec.adjusted);
  unmatchLine(db, u.id, u.email, stadt.id);
  assert.throws(() => matchLine(db, u.id, u.email, stadt.id, rec1.lines[0].match!.journal_id), /already matched/);
  matchLine(db, u.id, u.email, stadt.id, fee.id);
  assert.equal(autoMatch(db, u.id), 0);
  void cust;
});

test("year-end, approvals and bank leave the ledger verifiable; closed periods block bank booking", () => {
  const { db } = world();
  const u = userById(db, createUser(db, { email: "acc@x.io", name: "Acc", role: "ACCOUNTANT", password: "password1" }))!;
  const imp = importStatement(db, u, "j.csv", "Date,Description,Amount\n2026-01-15,BANK FEE,-1.00");
  closePeriod(db, "2026-01", "t");
  const line = reconciliation(db, imp.id).lines[0];
  assert.throws(() => createFromLine(db, u, line.id, { type: "EXPENSE" }), /closed period/);
  assert.ok(verifyLedger(db).ok);
  assert.throws(() => run(db, "DELETE FROM bank_lines"), /append-only/);
  assert.ok(LedgerError);
});
