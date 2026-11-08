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
