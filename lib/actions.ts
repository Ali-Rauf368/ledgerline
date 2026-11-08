"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "./db";
import type { CashType } from "./ledger";
import {
  audit, closePeriod, createItem, LedgerError, postAdjustment, postCash, postReceipt, postSale, postTransfer, reverseJournal,
} from "./ledger";

// No authentication in this demo; every action is attributed to this actor in the audit trail.
const ACTOR = "Demo user";

export type ActionResult = { ok: true; id: number } | { ok: false; error: string };

type Common = { docDate: string; reference?: string; memo?: string; idempotencyKey: string };
export type TxPayload =
  | (Common & { kind: "RECEIPT"; warehouseId: number; counterparty: string; paid: boolean; lines: { itemId: number; qty: number; amount: number }[] })
  | (Common & { kind: "SALE"; warehouseId: number; counterparty: string; paid: boolean; lines: { itemId: number; qty: number; amount: number }[] })
  | (Common & { kind: "TRANSFER"; warehouseId: number; toWarehouseId: number; lines: { itemId: number; qty: number }[] })
  | (Common & { kind: "ADJUSTMENT"; warehouseId: number; lines: { itemId: number; qty: number; amount?: number }[] })
  | (Common & { kind: "PAYMENT"; cashType: CashType; amount: number; counterparty: string });

function fail(db: ReturnType<typeof getDb>, what: string, e: unknown): ActionResult {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof LedgerError) {
    audit(db, ACTOR, "POSTING_REJECTED", `${what}: ${msg}`);
    return { ok: false, error: msg };
  }
  return { ok: false, error: `Unexpected error: ${msg}` };
}

export async function postTransaction(p: TxPayload): Promise<ActionResult> {
  const db = getDb();
  try {
    const base = { docDate: p.docDate, reference: p.reference, memo: p.memo, idempotencyKey: p.idempotencyKey };
    let j;
    switch (p.kind) {
      case "RECEIPT":
        j = postReceipt(db, { ...base, warehouseId: p.warehouseId, supplier: p.counterparty, paid: p.paid, lines: p.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitCost: l.amount })) });
        break;
      case "SALE":
        j = postSale(db, { ...base, warehouseId: p.warehouseId, customer: p.counterparty, paid: p.paid, lines: p.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitPrice: l.amount })) });
        break;
      case "TRANSFER":
        j = postTransfer(db, { ...base, fromWarehouseId: p.warehouseId, toWarehouseId: p.toWarehouseId, lines: p.lines });
        break;
      case "ADJUSTMENT":
        j = postAdjustment(db, { ...base, warehouseId: p.warehouseId, lines: p.lines.map((l) => ({ itemId: l.itemId, qtyDelta: l.qty, unitCost: l.amount })) });
        break;
      case "PAYMENT":
        j = postCash(db, { ...base, type: p.cashType, amount: p.amount, counterparty: p.counterparty });
        break;
    }
    revalidatePath("/", "layout");
    return { ok: true, id: j.id };
  } catch (e) {
    return fail(db, p.kind, e);
  }
}

export async function reverseAction(journalId: number, docDate: string, reason: string, idempotencyKey: string): Promise<ActionResult> {
  const db = getDb();
  try {
    const j = reverseJournal(db, { journalId, docDate, reason, idempotencyKey });
    audit(db, ACTOR, "JOURNAL_REVERSED", `#${journalId} reversed by #${j.id}: ${reason}`);
    revalidatePath("/", "layout");
    return { ok: true, id: j.id };
  } catch (e) {
    return fail(db, `Reverse #${journalId}`, e);
  }
}

export async function closePeriodAction(period: string): Promise<ActionResult> {
  const db = getDb();
  try {
    closePeriod(db, period, ACTOR);
    revalidatePath("/", "layout");
    return { ok: true, id: 0 };
  } catch (e) {
    return fail(db, `Close ${period}`, e);
  }
}

export async function createItemAction(input: { sku: string; name: string; category: string; unit: string }): Promise<ActionResult> {
  const db = getDb();
  try {
    const id = createItem(db, input, ACTOR);
    revalidatePath("/", "layout");
    return { ok: true, id };
  } catch (e) {
    return fail(db, "Create item", e);
  }
}
