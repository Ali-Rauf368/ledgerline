import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, run } from "../lib/db.ts";
import type { DB } from "../lib/db.ts";
import {
  closePeriod, createItem, createWarehouse, LedgerError, positionOf, postAdjustment, postCash,
  postReceipt, postSale, postTransfer, reverseJournal,
} from "../lib/ledger.ts";
import { balanceSheet, inventoryValuation, trialBalance } from "../lib/reports.ts";
import { verifyLedger } from "../lib/integrity.ts";

function setup() {
  const db = openDb(":memory:");
  const a = createWarehouse(db, "A", "Main");
  const b = createWarehouse(db, "B", "Depot");
  const item = createItem(db, { sku: "WID-1", name: "Widget" });
  return { db, a, b, item };
}

const count = (db: DB, table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

test("moving average cost, and the last unit clears the exact remaining value", () => {
  const { db, a, item } = setup();
  postReceipt(db, { docDate: "2026-01-02", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 3, unitCost: 100 }] });
  postReceipt(db, { docDate: "2026-01-03", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 4, unitCost: 101 }] });
  // 7 units worth 704 → avg 100.571…
  postSale(db, { docDate: "2026-01-04", warehouseId: a, customer: "C", lines: [{ itemId: item, qty: 1, unitPrice: 500 }] });
  assert.deepEqual(positionOf(db, item, a), { qty: 6, value: 603, lastDate: "2026-01-04" }); // 704 - round(100.57)
  postSale(db, { docDate: "2026-01-05", warehouseId: a, customer: "C", lines: [{ itemId: item, qty: 6, unitPrice: 500 }] });
  assert.equal(positionOf(db, item, a).value, 0);
  assert.equal(inventoryValuation(db).gl, 0);
  assert.ok(verifyLedger(db).ok);
});

test("rejects backdating that would rewrite already-posted costs", () => {
  const { db, a, item } = setup();
  postReceipt(db, { docDate: "2026-02-10", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 5, unitCost: 100 }] });
  assert.throws(
    () => postSale(db, { docDate: "2026-02-01", warehouseId: a, customer: "C", lines: [{ itemId: item, qty: 1, unitPrice: 200 }] }),
    /Backdating/,
  );
});

test("insufficient stock fails atomically: nothing is written", () => {
  const { db, a, item } = setup();
  postReceipt(db, { docDate: "2026-01-02", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 2, unitCost: 100 }] });
  const before = [count(db, "journals"), count(db, "journal_lines"), count(db, "stock_moves")];
  assert.throws(
    () => postSale(db, { docDate: "2026-01-03", warehouseId: a, customer: "C", lines: [{ itemId: item, qty: 3, unitPrice: 200 }] }),
    LedgerError,
  );
  assert.deepEqual([count(db, "journals"), count(db, "journal_lines"), count(db, "stock_moves")], before);
});

test("ledger tables are append-only at the database level", () => {
  const { db, a, item } = setup();
  postReceipt(db, { docDate: "2026-01-02", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 2, unitCost: 100 }] });
  assert.throws(() => run(db, "UPDATE journal_lines SET debit = 1"), /append-only/);
  assert.throws(() => run(db, "DELETE FROM journals"), /append-only/);
  assert.throws(() => run(db, "UPDATE stock_moves SET qty = 9"), /append-only/);
});

test("tampering is detected by the hash chain", () => {
  const { db, a, item } = setup();
  postReceipt(db, { docDate: "2026-01-02", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 2, unitCost: 100 }] });
  postCash(db, { docDate: "2026-01-03", type: "CAPITAL", amount: 1000, counterparty: "Owner" });
  db.exec("DROP TRIGGER journals_no_update");
  run(db, "UPDATE journals SET memo = 'edited' WHERE id = 1");
  const v = verifyLedger(db);
  assert.equal(v.ok, false);
  assert.equal(v.checks.find((c) => c.id === "chain")!.ok, false);
  assert.equal(v.checks.find((c) => c.id === "guards")!.ok, false);
});

test("reversal mirrors the original and can only happen once", () => {
  const { db, a, b, item } = setup();
  postReceipt(db, { docDate: "2026-01-02", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 10, unitCost: 100 }] });
  const t = postTransfer(db, { docDate: "2026-01-03", fromWarehouseId: a, toWarehouseId: b, lines: [{ itemId: item, qty: 4 }] });
  const s = postSale(db, { docDate: "2026-01-04", warehouseId: a, customer: "C", lines: [{ itemId: item, qty: 2, unitPrice: 250 }] });
  const r = reverseJournal(db, { journalId: s.id, docDate: "2026-01-05", reason: "wrong customer" });
  assert.equal(r.reverses_id, s.id);
  assert.equal(positionOf(db, item, a).qty, 6);
  assert.throws(() => reverseJournal(db, { journalId: s.id, docDate: "2026-01-05", reason: "again" }), /already reversed/);
  assert.throws(() => reverseJournal(db, { journalId: r.id, docDate: "2026-01-05", reason: "x" }), /can't be reversed/);
  reverseJournal(db, { journalId: t.id, docDate: "2026-01-05", reason: "not shipped" });
  assert.deepEqual(positionOf(db, item, a), { qty: 10, value: 1000, lastDate: "2026-01-05" });
  assert.equal(positionOf(db, item, b).qty, 0);
  assert.ok(trialBalance(db).balanced);
  assert.ok(verifyLedger(db).ok);
});

test("closed periods are locked and their snapshot keeps verifying", () => {
  const { db, a, item } = setup();
  postCash(db, { docDate: "2026-01-02", type: "CAPITAL", amount: 100000, counterparty: "Owner" });
  postReceipt(db, { docDate: "2026-01-05", warehouseId: a, supplier: "S", paid: true, lines: [{ itemId: item, qty: 10, unitCost: 100 }] });
  closePeriod(db, "2026-01", "tester");
  assert.throws(() => postCash(db, { docDate: "2026-01-31", type: "EXPENSE", amount: 5, counterparty: "x" }), /closed through 2026-01/);
  assert.throws(() => closePeriod(db, "2026-03", "tester"), /close 2026-02 first/);
  postSale(db, { docDate: "2026-02-03", warehouseId: a, customer: "C", lines: [{ itemId: item, qty: 3, unitPrice: 300 }] });
  const v = verifyLedger(db);
  assert.ok(v.checks.find((c) => c.id === "periods")!.ok);
  assert.ok(balanceSheet(db).balanced);
});

test("idempotency key: retried submit posts once", () => {
  const { db, a, item } = setup();
  const input = { docDate: "2026-01-02", warehouseId: a, supplier: "S", idempotencyKey: "k-1", lines: [{ itemId: item, qty: 1, unitCost: 1 }] };
  const first = postReceipt(db, input);
  const second = postReceipt(db, input);
  assert.equal(first.id, second.id);
  assert.equal(count(db, "journals"), 1);
});

test("'as known at' reproduces an earlier version of a report", () => {
  const { db, a, item } = setup();
  postReceipt(db, { docDate: "2026-01-02", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 5, unitCost: 100 }], postedAt: "2026-01-02T10:00:00.000Z" });
  // A January invoice entered late, in February:
  postCash(db, { docDate: "2026-01-20", type: "EXPENSE", amount: 777, counterparty: "Landlord", postedAt: "2026-02-03T09:00:00.000Z" });
  const asReportedThen = trialBalance(db, { asOf: "2026-01-31", knownAt: "2026-02-01T00:00:00.000Z" });
  const now = trialBalance(db, { asOf: "2026-01-31" });
  const opex = (t: typeof now) => t.rows.find((r) => r.code === "6000")!.balance;
  assert.equal(opex(asReportedThen), 0);
  assert.equal(opex(now), 777);
});

test("adjustments need a reason and post to shrinkage", () => {
  const { db, a, item } = setup();
  postReceipt(db, { docDate: "2026-01-02", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 4, unitCost: 250 }] });
  assert.throws(() => postAdjustment(db, { docDate: "2026-01-03", warehouseId: a, lines: [{ itemId: item, qtyDelta: -1 }] }), /reason/);
  postAdjustment(db, { docDate: "2026-01-03", warehouseId: a, memo: "Broken in transit", lines: [{ itemId: item, qtyDelta: -1 }] });
  assert.equal(trialBalance(db).rows.find((r) => r.code === "5100")!.balance, 250);
  assert.ok(verifyLedger(db).ok);
});

// ───────────────────────── v2: VAT, FX, year-end, budgets, analytics ─────────────────────────
import { openForeignInvoices, setBudget, settleForeignInvoice, toEur, vatPosition } from "../lib/ledger.ts";
import { budgetVsActual, fifoComparison, incomeStatement, vatReport } from "../lib/reports.ts";
import { detectAnomalies, forecastCash, forecastDemand } from "../lib/analytics.ts";

test("VAT: input on purchases, output on sales, settled to zero", () => {
  const { db, a, item } = setup();
  postCash(db, { docDate: "2026-01-01", type: "CAPITAL", amount: 100000, counterparty: "Owner" });
  postReceipt(db, { docDate: "2026-01-02", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 10, unitCost: 1000, vatRate: 19 }] });
  postSale(db, { docDate: "2026-01-03", warehouseId: a, customer: "C", lines: [{ itemId: item, qty: 4, unitPrice: 2500, vatRate: 7 }] });
  assert.equal(positionOf(db, item, a).value, 6000); // inventory is net of VAT
  assert.deepEqual(vatPosition(db), { output: 700, input: 1900, net: -1200 });
  const r = vatReport(db, { from: "2026-01-01", asOf: "2026-01-31" });
  assert.equal(r.net, -1200);
  postCash(db, { docDate: "2026-01-10", type: "PAY_VAT", amount: 0, counterparty: "" });
  assert.deepEqual(vatPosition(db), { output: 0, input: 0, net: 0 });
  assert.ok(trialBalance(db).balanced && verifyLedger(db).ok);
});

test("FX: exact conversion, and realised gain/loss on settlement", () => {
  const { db, a, item } = setup();
  assert.equal(toEur(100000, "USD", "0.92"), 92000);
  assert.equal(toEur(12345, "JPY", "0.0061"), 7530); // ¥12,345 × 0.0061 = €75.30
  postCash(db, { docDate: "2026-01-01", type: "CAPITAL", amount: 500000, counterparty: "Owner" });
  const inv = postReceipt(db, { docDate: "2026-01-02", warehouseId: a, supplier: "Kalita", currency: "USD", fxRate: "0.9200", lines: [{ itemId: item, qty: 100, unitCost: 1000 }] });
  assert.equal(positionOf(db, item, a).value, 92000);
  assert.throws(() => postReceipt(db, { docDate: "2026-01-02", warehouseId: a, supplier: "K", currency: "USD", fxRate: "0.9", lines: [{ itemId: item, qty: 1, unitCost: 1, vatRate: 19 }] }), /import/);
  assert.equal(openForeignInvoices(db).length, 1);
  settleForeignInvoice(db, { docDate: "2026-01-20", receiptId: inv.id, fxRate: "0.9500" });
  assert.equal(openForeignInvoices(db).length, 0);
  assert.equal(trialBalance(db).rows.find((r) => r.code === "6900")!.balance, 3000); // paid €950 for a €920 payable
  assert.equal(trialBalance(db).rows.find((r) => r.code === "2000")!.balance, 0);
  assert.throws(() => reverseJournal(db, { journalId: inv.id, docDate: "2026-01-21", reason: "x" }), /paid by/);
  assert.equal(incomeStatement(db, { from: "2026-01-01", asOf: "2026-01-31" }).otherNet, -3000);
  assert.ok(verifyLedger(db).ok);
});

test("year-end close moves profit to retained earnings and keeps the P&L clean", () => {
  const { db, a, item } = setup();
  postCash(db, { docDate: "2025-11-01", type: "CAPITAL", amount: 100000, counterparty: "Owner" });
  postReceipt(db, { docDate: "2025-11-02", warehouseId: a, supplier: "S", paid: true, lines: [{ itemId: item, qty: 10, unitCost: 1000 }] });
  postSale(db, { docDate: "2025-12-05", warehouseId: a, customer: "C", paid: true, lines: [{ itemId: item, qty: 4, unitPrice: 2500 }] });
  closePeriod(db, "2025-11", "t");
  const r = closePeriod(db, "2025-12", "t");
  assert.ok(r.closingId);
  const tb = trialBalance(db);
  assert.equal(tb.rows.find((x) => x.code === "4000")!.balance, 0);
  assert.equal(tb.rows.find((x) => x.code === "3100")!.balance, 6000); // 10,000 revenue − 4,000 COGS
  assert.equal(incomeStatement(db, { from: "2025-12-01", asOf: "2025-12-31" }).netIncome, 6000);
  assert.ok(balanceSheet(db).balanced);
  assert.throws(() => reverseJournal(db, { journalId: r.closingId!, docDate: "2026-01-02", reason: "x" }), /closed|sealed/);
  const v = verifyLedger(db);
  assert.ok(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok)));
});

test("budgets are versioned: latest wins, history kept, unchanged values skipped", () => {
  const { db } = setup();
  assert.equal(setBudget(db, [{ period: "2026-01", account: "4000", amount: 100000 }], "t"), 1);
  assert.equal(setBudget(db, [{ period: "2026-01", account: "4000", amount: 100000 }], "t"), 0);
  setBudget(db, [{ period: "2026-01", account: "4000", amount: 120000 }], "t");
  const b = budgetVsActual(db, "2026");
  assert.equal(b.rows[0].cells[0].budget, 120000);
  assert.equal(b.history.length, 2);
  assert.throws(() => setBudget(db, [{ period: "2026-01", account: "1000", amount: 1 }], "t"), /revenue and expense/);
});

test("FIFO comparison differs from moving average when costs change", () => {
  const { db, a, item } = setup();
  postReceipt(db, { docDate: "2026-01-02", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 10, unitCost: 100 }] });
  postReceipt(db, { docDate: "2026-01-03", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 10, unitCost: 200 }] });
  postSale(db, { docDate: "2026-01-04", warehouseId: a, customer: "C", lines: [{ itemId: item, qty: 10, unitPrice: 500 }] });
  const f = fifoComparison(db);
  assert.equal(f.fifoCogs, 1000); // oldest layer
  assert.equal(f.avgCogs, 1500); // average 150
  assert.equal(f.fifoValue, 2000);
  assert.equal(f.avgValue, 1500);
});

test("anomaly detection flags a cost spike, a below-cost sale and a large write-off", () => {
  const { db, a, item } = setup();
  postCash(db, { docDate: "2026-01-01", type: "CAPITAL", amount: 9_000_000, counterparty: "Owner" });
  for (let d = 2; d <= 7; d++) postReceipt(db, { docDate: `2026-01-0${d}`, warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 10, unitCost: 1000 + d }] });
  postReceipt(db, { docDate: "2026-01-08", warehouseId: a, supplier: "S", lines: [{ itemId: item, qty: 10, unitCost: 1500 }] });
  postSale(db, { docDate: "2026-01-09", warehouseId: a, customer: "Cheap Co", lines: [{ itemId: item, qty: 5, unitPrice: 500 }] });
  postAdjustment(db, { docDate: "2026-01-10", warehouseId: a, memo: "Flood", lines: [{ itemId: item, qtyDelta: -40 }] });
  const types = detectAnomalies(db).map((x) => x.type);
  for (const t of ["cost_spike", "below_cost_sale", "shrinkage"]) assert.ok(types.includes(t as never), `missing ${t}: ${types}`);
});

test("forecasts produce finite, non-negative projections", () => {
  const { db, a, item } = setup();
  postCash(db, { docDate: "2026-01-01", type: "CAPITAL", amount: 100000, counterparty: "Owner" });
  postReceipt(db, { docDate: "2026-01-02", warehouseId: a, supplier: "S", paid: true, lines: [{ itemId: item, qty: 50, unitCost: 100 }] });
  const d = forecastDemand(db)[0];
  assert.ok(Number.isFinite(d.forecast30) && d.forecast30 >= 0);
  const c = forecastCash(db);
  assert.ok(Number.isFinite(c.projected) && c.points.length > 30);
});
