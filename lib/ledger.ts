/**
 * The posting engine. Every business event becomes ONE journal, written atomically:
 *   - balanced double-entry GL lines (debits = credits),
 *   - stock moves that carry an immutable running position (qty_after / value_after),
 *   - a SHA-256 hash chained to the previous journal.
 *
 * Invariants enforced here (and re-checked by integrity.ts):
 *   1. Nothing posted is ever updated or deleted (DB triggers). Mistakes are fixed by reversal.
 *   2. Inventory GL movement in a journal == sum of its stock move values (sub-ledger = control account).
 *   3. No backdating per item/warehouse: a move may not be dated before the latest move for that
 *      position, so already-posted costs never have to be recalculated.
 *   4. No postings into closed periods (lock date) and none in the future.
 *   5. Stock never goes negative; moving-average cost in integer cents with exact clearing at zero.
 */
import { createHash } from "node:crypto";
import type { DB } from "./db.ts";
import { all, get, run } from "./db.ts";
import { ACC, CURRENCIES, CURRENCY_DECIMALS, VAT_RATES } from "./accounts.ts";
import type { Currency, JournalKind } from "./accounts.ts";

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export const GENESIS_HASH = "0".repeat(64);

export type JournalRow = {
  id: number;
  kind: JournalKind;
  doc_date: string;
  posted_at: string;
  memo: string;
  reference: string;
  counterparty: string;
  reverses_id: number | null;
  idempotency_key: string | null;
  currency?: string | null;
  fx_rate?: string | null;
  foreign_amount?: number | null;
  settles_id?: number | null;
  created_by?: number | null;
  approved_by?: number | null;
  contact_id?: number | null;
  due_date?: string | null;
  order_id?: number | null;
  prev_hash: string;
  hash: string;
};
export type LineRow = { account_code: string; debit: number; credit: number };
export type MoveRow = {
  item_id: number;
  warehouse_id: number;
  doc_date: string;
  qty: number;
  value: number;
  qty_after: number;
  value_after: number;
};

type Line = { account: string; debit: number; credit: number };

// ───────────────────────── utilities ─────────────────────────

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function computeJournalHash(j: JournalRow, lines: LineRow[], moves: MoveRow[]) {
  const payload = JSON.stringify({
    id: j.id,
    kind: j.kind,
    docDate: j.doc_date,
    postedAt: j.posted_at,
    memo: j.memo,
    reference: j.reference,
    counterparty: j.counterparty,
    reverses: j.reverses_id ?? null,
    // v2 fields are only part of the payload when present, so v1 journals keep their original hashes.
    ...(j.currency ? { fx: [j.currency, j.fx_rate, j.foreign_amount] } : {}),
    ...(j.settles_id ? { settles: j.settles_id } : {}),
    // v3: who posted/approved it and the business document it belongs to.
    ...(j.created_by ? { by: j.created_by } : {}),
    ...(j.approved_by ? { approvedBy: j.approved_by } : {}),
    ...(j.contact_id ? { contact: j.contact_id } : {}),
    ...(j.due_date ? { due: j.due_date } : {}),
    ...(j.order_id ? { order: j.order_id } : {}),
    lines: lines.map((l) => [l.account_code, l.debit, l.credit]),
    moves: moves.map((m) => [m.item_id, m.warehouse_id, m.doc_date, m.qty, m.value, m.qty_after, m.value_after]),
  });
  return sha256(`${j.prev_hash}|${payload}`);
}

export const today = () => new Date().toISOString().slice(0, 10);

export function assertDate(d: string) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (!ok) throw new LedgerError(`"${d}" is not a valid date (YYYY-MM-DD).`);
}

export function monthEnd(period: string) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function nextMonth(period: string) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

function assertQty(q: number) {
  if (!Number.isSafeInteger(q) || q <= 0) throw new LedgerError("Quantities must be positive whole numbers.");
}

function assertCents(v: number, label: string) {
  if (!Number.isSafeInteger(v) || v < 0) throw new LedgerError(`${label} must be a non-negative amount.`);
}

function assertVat(rate: number) {
  if (!(VAT_RATES as readonly number[]).includes(rate)) throw new LedgerError(`VAT rate must be one of ${VAT_RATES.join(", ")}%.`);
}

/** VAT on a net amount, rounded half-up to the cent. */
export const vatOf = (net: number, rate: number) => Math.round((net * rate) / 100);

/** Parse an exchange rate ("EUR per 1 unit of foreign currency") into integer micro-units. */
export function parseRate(rate: string): bigint {
  if (!/^\d{1,6}(\.\d{1,6})?$/.test(rate)) throw new LedgerError("Exchange rate must be a positive number with up to 6 decimals, e.g. 0.9234.");
  const [w, f = ""] = rate.split(".");
  const micro = BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"));
  if (micro === 0n) throw new LedgerError("Exchange rate must be greater than zero.");
  return micro;
}

/** Convert foreign minor units to EUR cents with exact integer arithmetic (half-up). */
export function toEur(foreignMinor: number, currency: Currency, rate: string): number {
  const num = BigInt(foreignMinor) * parseRate(rate) * 100n;
  const den = 1_000_000n * 10n ** BigInt(CURRENCY_DECIMALS[currency]);
  return Number((num * 2n + den) / (2n * den));
}

function assertCurrency(c: string): asserts c is Currency {
  if (!(CURRENCIES as readonly string[]).includes(c)) throw new LedgerError(`Unsupported currency ${c}.`);
}

function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function audit(db: DB, actor: string, action: string, detail = "") {
  run(db, "INSERT INTO audit_events (at, actor, action, detail) VALUES (?, ?, ?, ?)", new Date().toISOString(), actor, action, detail);
}

/** Last closed period (YYYY-MM), or null. Everything up to and including it is locked. */
export function lockedThrough(db: DB): string | null {
  return get<{ p: string | null }>(db, "SELECT MAX(period) p FROM period_closes")?.p ?? null;
}

/** Raw debit-minus-credit balance of an account. */
export function rawBalance(db: DB, code: string) {
  return get<{ b: number }>(db, "SELECT COALESCE(SUM(debit - credit), 0) b FROM journal_lines WHERE account_code = ?", code)!.b;
}

export function positionOf(db: DB, itemId: number, warehouseId: number) {
  const r = get<{ qty_after: number; value_after: number; doc_date: string }>(
    db,
    "SELECT qty_after, value_after, doc_date FROM stock_moves WHERE item_id = ? AND warehouse_id = ? ORDER BY id DESC LIMIT 1",
    itemId,
    warehouseId,
  );
  return { qty: r?.qty_after ?? 0, value: r?.value_after ?? 0, lastDate: r?.doc_date ?? null };
}

function checkPostingDate(db: DB, docDate: string) {
  assertDate(docDate);
  if (docDate > today()) throw new LedgerError(`${docDate} is in the future. Ledgers only record what has happened.`);
  const lock = lockedThrough(db);
  if (lock && docDate.slice(0, 7) <= lock) {
    throw new LedgerError(
      `The books are closed through ${lock}, so nothing can be dated ${docDate}. Post a correcting entry in an open period instead.`,
    );
  }
}

// ───────────────────────── stock planner ─────────────────────────

type Planned = { itemId: number; warehouseId: number; qty: number; value: number; qtyAfter: number; valueAfter: number };

function planner(db: DB, docDate: string) {
  const positions = new Map<string, { qty: number; value: number; sku: string }>();
  const moves: Planned[] = [];

  function current(itemId: number, warehouseId: number) {
    const key = `${itemId}:${warehouseId}`;
    let p = positions.get(key);
    if (!p) {
      const item = get<{ sku: string }>(db, "SELECT sku FROM items WHERE id = ?", itemId);
      if (!item) throw new LedgerError(`Unknown item #${itemId}.`);
      if (!get(db, "SELECT id FROM warehouses WHERE id = ?", warehouseId)) throw new LedgerError(`Unknown warehouse #${warehouseId}.`);
      const pos = positionOf(db, itemId, warehouseId);
      if (pos.lastDate && pos.lastDate > docDate) {
        throw new LedgerError(
          `${item.sku} already has a movement dated ${pos.lastDate}. Backdating to ${docDate} would change the cost of transactions already posted, so use ${pos.lastDate} or later.`,
        );
      }
      p = { qty: pos.qty, value: pos.value, sku: item.sku };
      positions.set(key, p);
    }
    return p;
  }

  function apply(itemId: number, warehouseId: number, qty: number, value: number) {
    const p = current(itemId, warehouseId);
    const qtyAfter = p.qty + qty;
    const valueAfter = p.value + value;
    if (qtyAfter < 0) throw new LedgerError(`Not enough ${p.sku} in stock: ${p.qty} on hand, ${-qty} needed.`);
    if (valueAfter < 0 || (qtyAfter === 0 && valueAfter !== 0)) {
      throw new LedgerError(`${p.sku}: this would leave an invalid valuation. Post a stock adjustment instead.`);
    }
    p.qty = qtyAfter;
    p.value = valueAfter;
    moves.push({ itemId, warehouseId, qty, value, qtyAfter, valueAfter });
    return value;
  }

  return {
    moves,
    current,
    /** Goods in at a known total cost. */
    inbound(itemId: number, warehouseId: number, qty: number, value: number) {
      assertQty(qty);
      assertCents(value, "Cost");
      return apply(itemId, warehouseId, qty, value);
    },
    /** Goods out at moving-average cost. Taking the last unit takes the exact remaining value: no rounding drift. */
    outbound(itemId: number, warehouseId: number, qty: number) {
      assertQty(qty);
      const p = current(itemId, warehouseId);
      if (qty > p.qty) throw new LedgerError(`Not enough ${p.sku} in stock: ${p.qty} on hand, ${qty} requested.`);
      const cost = qty === p.qty ? p.value : Math.round((p.value * qty) / p.qty);
      apply(itemId, warehouseId, -qty, -cost);
      return cost;
    },
    /** Undo a historical move at its original value; if the position empties, clear its exact remainder. */
    undo(itemId: number, warehouseId: number, qty: number, value: number) {
      const p = current(itemId, warehouseId);
      const v = p.qty + qty === 0 ? -p.value : value;
      return apply(itemId, warehouseId, qty, v);
    },
  };
}

// ───────────────────────── commit ─────────────────────────

type Draft = {
  kind: JournalKind;
  docDate: string;
  memo?: string;
  reference?: string;
  counterparty?: string;
  reversesId?: number;
  idempotencyKey?: string;
  postedAt?: string;
  currency?: string;
  fxRate?: string;
  foreignAmount?: number;
  settlesId?: number;
  actorId?: number;
  approvedBy?: number;
  contactId?: number;
  dueDate?: string;
  orderId?: number;
  lines: Line[];
  moves: Planned[];
};

function commit(db: DB, d: Draft): JournalRow {
  const lines = d.lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  let debits = 0;
  let credits = 0;
  let inventoryGl = 0;
  for (const l of lines) {
    assertCents(l.debit, "Debit");
    assertCents(l.credit, "Credit");
    if (l.debit && l.credit) throw new LedgerError("A line cannot be both debit and credit.");
    if (!get(db, "SELECT code FROM accounts WHERE code = ?", l.account)) throw new LedgerError(`Unknown account ${l.account}.`);
    debits += l.debit;
    credits += l.credit;
    if (l.account === ACC.INV) inventoryGl += l.debit - l.credit;
  }
  if (!lines.length && !d.moves.length) throw new LedgerError("Nothing to post.");
  if (debits !== credits) throw new LedgerError(`Unbalanced entry: debits ${debits} ≠ credits ${credits}.`);
  const inventoryMoves = d.moves.reduce((s, m) => s + m.value, 0);
  if (inventoryGl !== inventoryMoves) {
    throw new LedgerError(`Inventory control account (${inventoryGl}) would not match the stock sub-ledger (${inventoryMoves}).`);
  }

  const prev = get<{ id: number; hash: string; posted_at: string }>(db, "SELECT id, hash, posted_at FROM journals ORDER BY id DESC LIMIT 1");
  const now = d.postedAt ?? new Date().toISOString();
  const j: JournalRow = {
    id: (prev?.id ?? 0) + 1,
    kind: d.kind,
    doc_date: d.docDate,
    // Posting time never runs backwards, so "as known at" queries see a clean prefix of the chain.
    posted_at: prev && prev.posted_at > now ? prev.posted_at : now,
    memo: (d.memo ?? "").trim(),
    reference: (d.reference ?? "").trim(),
    counterparty: (d.counterparty ?? "").trim(),
    reverses_id: d.reversesId ?? null,
    idempotency_key: d.idempotencyKey ?? null,
    currency: d.currency ?? null,
    fx_rate: d.currency ? (d.fxRate ?? null) : null,
    foreign_amount: d.currency ? (d.foreignAmount ?? null) : null,
    settles_id: d.settlesId ?? null,
    created_by: d.actorId ?? null,
    approved_by: d.approvedBy ?? null,
    contact_id: d.contactId ?? null,
    due_date: d.dueDate ?? null,
    order_id: d.orderId ?? null,
    prev_hash: prev?.hash ?? GENESIS_HASH,
    hash: "",
  };
  const lineRows: LineRow[] = lines.map((l) => ({ account_code: l.account, debit: l.debit, credit: l.credit }));
  const moveRows: MoveRow[] = d.moves.map((m) => ({
    item_id: m.itemId,
    warehouse_id: m.warehouseId,
    doc_date: d.docDate,
    qty: m.qty,
    value: m.value,
    qty_after: m.qtyAfter,
    value_after: m.valueAfter,
  }));
  j.hash = computeJournalHash(j, lineRows, moveRows);

  run(
    db,
    `INSERT INTO journals (id, kind, doc_date, posted_at, memo, reference, counterparty, reverses_id, idempotency_key,
       currency, fx_rate, foreign_amount, settles_id, created_by, approved_by, contact_id, due_date, order_id, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    j.id, j.kind, j.doc_date, j.posted_at, j.memo, j.reference, j.counterparty, j.reverses_id, j.idempotency_key,
    j.currency ?? null, j.fx_rate ?? null, j.foreign_amount ?? null, j.settles_id ?? null,
    j.created_by ?? null, j.approved_by ?? null, j.contact_id ?? null, j.due_date ?? null, j.order_id ?? null, j.prev_hash, j.hash,
  );
  for (const l of lineRows) {
    run(db, "INSERT INTO journal_lines (journal_id, account_code, debit, credit) VALUES (?, ?, ?, ?)", j.id, l.account_code, l.debit, l.credit);
  }
  for (const m of moveRows) {
    run(
      db,
      "INSERT INTO stock_moves (journal_id, item_id, warehouse_id, doc_date, qty, value, qty_after, value_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      j.id, m.item_id, m.warehouse_id, m.doc_date, m.qty, m.value, m.qty_after, m.value_after,
    );
  }
  return j;
}

/** Atomic + idempotent: replaying the same key returns the journal already posted. */
function posting(db: DB, key: string | undefined, build: () => JournalRow): JournalRow {
  return tx(db, () => {
    if (key) {
      const existing = get<JournalRow>(db, "SELECT * FROM journals WHERE idempotency_key = ?", key);
      if (existing) return existing;
    }
    return build();
  });
}

// ───────────────────────── contacts, invoices, orders ─────────────────────────

export type ContactKind = "CUSTOMER" | "SUPPLIER";
type ContactRow = { id: number; kind: ContactKind; name: string; terms_days: number; currency: string };

function contactFor(db: DB, id: number | undefined, kind: ContactKind): ContactRow | undefined {
  if (!id) return undefined;
  const c = get<ContactRow>(db, "SELECT id, kind, name, terms_days, currency FROM contacts WHERE id = ?", id);
  if (!c) throw new LedgerError(`Unknown contact #${id}.`);
  if (c.kind !== kind) throw new LedgerError(`${c.name} is a ${c.kind.toLowerCase()}, not a ${kind.toLowerCase()}.`);
  return c;
}

export const addDaysIso = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Remaining quantity per item on an order (ordered − delivered by un-reversed journals). */
export function orderRemaining(db: DB, orderId: number) {
  const lines = all<{ item_id: number; qty: number }>(db, "SELECT item_id, SUM(qty) qty FROM order_lines WHERE order_id = ? GROUP BY item_id", orderId);
  const done = all<{ item_id: number; qty: number }>(
    db,
    `SELECT m.item_id, SUM(ABS(m.qty)) qty FROM stock_moves m JOIN journals j ON j.id = m.journal_id
     WHERE j.order_id = ? AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = j.id) GROUP BY m.item_id`,
    orderId,
  );
  return new Map(lines.map((l) => [l.item_id, l.qty - (done.find((d) => d.item_id === l.item_id)?.qty ?? 0)]));
}

function checkOrder(db: DB, orderId: number | undefined, kind: "PO" | "SO", contactId: number | undefined, lines: { itemId: number; qty: number }[]) {
  if (!orderId) return;
  const o = get<{ kind: string; contact_id: number; cancelled_at: string | null; number: string }>(db, "SELECT kind, contact_id, cancelled_at, number FROM orders WHERE id = ?", orderId);
  if (!o) throw new LedgerError(`Unknown order #${orderId}.`);
  if (o.kind !== kind) throw new LedgerError(`${o.number} is not a ${kind === "PO" ? "purchase" : "sales"} order.`);
  if (o.cancelled_at) throw new LedgerError(`${o.number} was cancelled.`);
  if (contactId && o.contact_id !== contactId) throw new LedgerError(`${o.number} belongs to a different ${kind === "PO" ? "supplier" : "customer"}.`);
  const remaining = orderRemaining(db, orderId);
  const want = new Map<number, number>();
  for (const l of lines) want.set(l.itemId, (want.get(l.itemId) ?? 0) + l.qty);
  for (const [item, qty] of want) {
    const left = remaining.get(item);
    if (left === undefined) throw new LedgerError(`Item #${item} is not on ${o.number}.`);
    if (qty > left) throw new LedgerError(`${o.number} has only ${left} left to ${kind === "PO" ? "receive" : "deliver"} for item #${item}, not ${qty}.`);
  }
}

export type OpenInvoice = {
  id: number;
  kind: "SALE" | "RECEIPT";
  doc_date: string;
  due_date: string | null;
  contact_id: number | null;
  counterparty: string;
  reference: string;
  gross: number;
  paid: number;
  open: number;
  currency: string | null;
};

/**
 * Open receivables (sales on account) or payables (receipts on account): gross on the AR/AP line minus
 * allocations from payments that were not reversed. Reversed invoices drop out entirely.
 */
export function openInvoices(db: DB, o: { side: "AR" | "AP"; contactId?: number; includeSettled?: boolean }): OpenInvoice[] {
  const acc = o.side === "AR" ? ACC.AR : ACC.AP;
  const col = o.side === "AR" ? "debit" : "credit";
  const rows = all<OpenInvoice>(
    db,
    `SELECT j.id, j.kind, j.doc_date, j.due_date, j.contact_id, j.counterparty, j.reference, j.currency,
       (SELECT SUM(${col}) FROM journal_lines WHERE journal_id = j.id AND account_code = ?) gross,
       COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.invoice_id = j.id
                 AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = a.payment_id)), 0) paid,
       0 open
     FROM journals j
     WHERE j.kind = ? AND EXISTS (SELECT 1 FROM journal_lines x WHERE x.journal_id = j.id AND x.account_code = ? AND x.${col} > 0)
       AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = j.id)
       AND (? IS NULL OR j.contact_id = ?)
     ORDER BY COALESCE(j.due_date, j.doc_date), j.id`,
    acc,
    o.side === "AR" ? "SALE" : "RECEIPT",
    acc,
    o.contactId ?? null,
    o.contactId ?? null,
  );
  return rows.map((r) => ({ ...r, open: r.gross - r.paid })).filter((r) => o.includeSettled || r.open > 0);
}

/** Apply a payment to invoices: explicit ones first (in the given order), otherwise oldest due first. */
function allocate(db: DB, paymentId: number, side: "AR" | "AP", contactId: number | undefined, amount: number, invoiceIds?: number[]) {
  let left = amount;
  const candidates = openInvoices(db, { side, contactId });
  const ordered = invoiceIds?.length
    ? invoiceIds.map((id) => {
        const inv = candidates.find((c) => c.id === id);
        if (!inv) throw new LedgerError(`Invoice #${id} is not open${contactId ? " for this contact" : ""}.`);
        return inv;
      })
    : contactId
      ? candidates
      : [];
  for (const inv of ordered) {
    if (left <= 0) break;
    const take = Math.min(left, inv.open);
    if (take > 0) run(db, "INSERT INTO allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)", paymentId, inv.id, take);
    left -= take;
  }
  return amount - left;
}

// ───────────────────────── public posting API ─────────────────────────

type Common = {
  docDate: string;
  memo?: string;
  reference?: string;
  idempotencyKey?: string;
  postedAt?: string;
  /** User who posted it, and (for four-eyes postings) who approved it. */
  actorId?: number;
  approvedBy?: number;
  /** Customer/supplier and sales/purchase order the entry belongs to. */
  contactId?: number;
  orderId?: number;
  /** Due date for invoices on account; defaults to the contact's payment terms. */
  dueDate?: string;
};

/**
 * Goods in. Unit costs are net of VAT, in the invoice currency's minor units.
 * Foreign-currency invoices are converted at the given rate (EUR per unit); the foreign amount is kept
 * on the journal so the payable can later be settled at the then-current rate (realised FX gain/loss).
 */
export function postReceipt(
  db: DB,
  i: Common & {
    warehouseId: number;
    supplier: string;
    paid?: boolean;
    currency?: string;
    fxRate?: string;
    lines: { itemId: number; qty: number; unitCost: number; vatRate?: number }[];
  },
) {
  return posting(db, i.idempotencyKey, () => {
    checkPostingDate(db, i.docDate);
    if (!i.lines.length) throw new LedgerError("Add at least one item.");
    const supplier = contactFor(db, i.contactId, "SUPPLIER");
    checkOrder(db, i.orderId, "PO", i.contactId, i.lines);
    const currency = i.currency && i.currency !== "EUR" ? i.currency : undefined;
    if (currency) {
      assertCurrency(currency);
      if (!i.fxRate) throw new LedgerError(`Enter the ${currency} → EUR exchange rate.`);
      parseRate(i.fxRate);
    }
    const p = planner(db, i.docDate);
    let net = 0;
    let vat = 0;
    let foreign = 0;
    for (const l of i.lines) {
      assertCents(l.unitCost, "Unit cost");
      const rate = l.vatRate ?? 0;
      assertVat(rate);
      if (currency && rate) throw new LedgerError("Foreign-currency purchases are imports: enter them with 0% VAT (import VAT is settled at customs).");
      const lineForeign = l.qty * l.unitCost;
      const lineNet = currency ? toEur(lineForeign, currency as Currency, i.fxRate!) : lineForeign;
      foreign += lineForeign;
      net += p.inbound(l.itemId, i.warehouseId, l.qty, lineNet);
      vat += vatOf(lineNet, rate);
    }
    return commit(db, {
      ...i,
      kind: "RECEIPT",
      counterparty: i.supplier || supplier?.name || "",
      dueDate: i.paid ? undefined : (i.dueDate ?? (supplier ? addDaysIso(i.docDate, supplier.terms_days) : undefined)),
      currency,
      fxRate: currency ? i.fxRate : undefined,
      foreignAmount: currency ? foreign : undefined,
      lines: [
        { account: ACC.INV, debit: net, credit: 0 },
        { account: ACC.VAT_IN, debit: vat, credit: 0 },
        { account: i.paid ? ACC.CASH : ACC.AP, debit: 0, credit: net + vat },
      ],
      moves: p.moves,
    });
  });
}

export function postSale(
  db: DB,
  i: Common & { warehouseId: number; customer: string; paid?: boolean; lines: { itemId: number; qty: number; unitPrice: number; vatRate?: number }[] },
) {
  return posting(db, i.idempotencyKey, () => {
    checkPostingDate(db, i.docDate);
    if (!i.lines.length) throw new LedgerError("Add at least one item.");
    const customer = contactFor(db, i.contactId, "CUSTOMER");
    checkOrder(db, i.orderId, "SO", i.contactId, i.lines);
    const p = planner(db, i.docDate);
    let revenue = 0;
    let vat = 0;
    let cogs = 0;
    for (const l of i.lines) {
      assertCents(l.unitPrice, "Unit price");
      const rate = l.vatRate ?? 0;
      assertVat(rate);
      cogs += p.outbound(l.itemId, i.warehouseId, l.qty);
      revenue += l.qty * l.unitPrice;
      vat += vatOf(l.qty * l.unitPrice, rate);
    }
    return commit(db, {
      ...i,
      kind: "SALE",
      counterparty: i.customer || customer?.name || "",
      dueDate: i.paid ? undefined : (i.dueDate ?? (customer ? addDaysIso(i.docDate, customer.terms_days) : undefined)),
      lines: [
        { account: i.paid ? ACC.CASH : ACC.AR, debit: revenue + vat, credit: 0 },
        { account: ACC.REVENUE, debit: 0, credit: revenue },
        { account: ACC.VAT_OUT, debit: 0, credit: vat },
        { account: ACC.COGS, debit: cogs, credit: 0 },
        { account: ACC.INV, debit: 0, credit: cogs },
      ],
      moves: p.moves,
    });
  });
}

export function postTransfer(
  db: DB,
  i: Common & { fromWarehouseId: number; toWarehouseId: number; lines: { itemId: number; qty: number }[] },
) {
  return posting(db, i.idempotencyKey, () => {
    checkPostingDate(db, i.docDate);
    if (i.fromWarehouseId === i.toWarehouseId) throw new LedgerError("Choose two different warehouses.");
    if (!i.lines.length) throw new LedgerError("Add at least one item.");
    const p = planner(db, i.docDate);
    for (const l of i.lines) {
      const cost = p.outbound(l.itemId, i.fromWarehouseId, l.qty);
      p.inbound(l.itemId, i.toWarehouseId, l.qty, cost);
    }
    // Value moves between locations; the GL total is unchanged, so no lines are needed.
    return commit(db, { ...i, kind: "TRANSFER", lines: [], moves: p.moves });
  });
}

export function postAdjustment(
  db: DB,
  i: Common & { warehouseId: number; lines: { itemId: number; qtyDelta: number; unitCost?: number }[] },
) {
  return posting(db, i.idempotencyKey, () => {
    checkPostingDate(db, i.docDate);
    if (!i.lines.length) throw new LedgerError("Add at least one item.");
    if (!i.memo?.trim()) throw new LedgerError("Adjustments need a reason, for example \"stock count\" or \"damaged\".");
    const p = planner(db, i.docDate);
    let net = 0;
    for (const l of i.lines) {
      if (l.qtyDelta < 0) {
        net -= p.outbound(l.itemId, i.warehouseId, -l.qtyDelta);
      } else {
        const cur = p.current(l.itemId, i.warehouseId);
        let unit = l.unitCost;
        if (unit === undefined) {
          if (cur.qty === 0) throw new LedgerError(`${cur.sku} has no stock to take an average cost from, so enter a unit cost.`);
          unit = Math.round(cur.value / cur.qty);
        }
        assertCents(unit, "Unit cost");
        net += p.inbound(l.itemId, i.warehouseId, l.qtyDelta, l.qtyDelta * unit);
      }
    }
    const lines: Line[] =
      net >= 0
        ? [{ account: ACC.INV, debit: net, credit: 0 }, { account: ACC.SHRINK, debit: 0, credit: net }]
        : [{ account: ACC.SHRINK, debit: -net, credit: 0 }, { account: ACC.INV, debit: 0, credit: -net }];
    return commit(db, { ...i, kind: "ADJUSTMENT", lines, moves: p.moves });
  });
}

export type CashType = "PAY_SUPPLIER" | "RECEIVE_CUSTOMER" | "EXPENSE" | "CAPITAL" | "PAY_VAT";

/** Net VAT position: positive = owed to the tax office, negative = refund due. */
export function vatPosition(db: DB) {
  const output = 0 - rawBalance(db, ACC.VAT_OUT) || 0;
  const input = rawBalance(db, ACC.VAT_IN);
  return { output, input, net: output - input };
}

export function postCash(db: DB, i: Common & { type: CashType; amount: number; counterparty: string; invoiceIds?: number[] }) {
  return posting(db, i.idempotencyKey, () => {
    checkPostingDate(db, i.docDate);
    if (i.type === "PAY_VAT") {
      // Clears both VAT accounts against the bank: the amount is always the exact net position.
      const v = vatPosition(db);
      if (!v.output && !v.input) throw new LedgerError("There is no VAT to settle.");
      const lines: Line[] = [
        { account: ACC.VAT_OUT, debit: v.output, credit: 0 },
        { account: ACC.VAT_IN, debit: 0, credit: v.input },
        v.net >= 0 ? { account: ACC.CASH, debit: 0, credit: v.net } : { account: ACC.CASH, debit: -v.net, credit: 0 },
      ];
      return commit(db, { ...i, kind: "PAYMENT", counterparty: i.counterparty || "Finanzamt", memo: i.memo || "VAT settlement", lines, moves: [] });
    }
    assertCents(i.amount, "Amount");
    if (i.amount === 0) throw new LedgerError("Amount must be greater than zero.");
    const pair: Record<CashType, [string, string]> = {
      PAY_SUPPLIER: [ACC.AP, ACC.CASH],
      RECEIVE_CUSTOMER: [ACC.CASH, ACC.AR],
      EXPENSE: [ACC.OPEX, ACC.CASH],
      CAPITAL: [ACC.CASH, ACC.EQUITY],
      PAY_VAT: [ACC.VAT_OUT, ACC.CASH],
    };
    if (i.type === "PAY_SUPPLIER" && i.amount > -rawBalance(db, ACC.AP)) {
      throw new LedgerError("That's more than is owed to suppliers.");
    }
    if (i.type === "RECEIVE_CUSTOMER" && i.amount > rawBalance(db, ACC.AR)) {
      throw new LedgerError("That's more than customers owe.");
    }
    const [dr, cr] = pair[i.type];
    const side = i.type === "RECEIVE_CUSTOMER" ? "AR" : i.type === "PAY_SUPPLIER" ? "AP" : null;
    const contact = side ? contactFor(db, i.contactId, side === "AR" ? "CUSTOMER" : "SUPPLIER") : undefined;
    if (side && i.invoiceIds?.length) {
      const open = openInvoices(db, { side, contactId: i.contactId });
      const sum = i.invoiceIds.reduce((t, id) => t + (open.find((o) => o.id === id)?.open ?? 0), 0);
      if (i.amount > sum) throw new LedgerError("The amount is more than the open balance of the selected invoices.");
    }
    const j = commit(db, {
      ...i,
      kind: "PAYMENT",
      counterparty: i.counterparty || contact?.name || "",
      lines: [
        { account: dr, debit: i.amount, credit: 0 },
        { account: cr, debit: 0, credit: i.amount },
      ],
      moves: [],
    });
    if (side) allocate(db, j.id, side, i.contactId, i.amount, i.invoiceIds);
    return j;
  });
}

export type OpenForeignInvoice = {
  id: number;
  doc_date: string;
  counterparty: string;
  reference: string;
  currency: Currency;
  fx_rate: string;
  foreign_amount: number;
  eur_amount: number;
};

/** Foreign-currency receipts on account that are neither reversed nor settled (by an un-reversed settlement). */
export function openForeignInvoices(db: DB): OpenForeignInvoice[] {
  return all<OpenForeignInvoice>(
    db,
    `SELECT j.id, j.doc_date, j.counterparty, j.reference, j.currency, j.fx_rate, j.foreign_amount,
            (SELECT credit FROM journal_lines WHERE journal_id = j.id AND account_code = ?) eur_amount
     FROM journals j
     WHERE j.kind = 'RECEIPT' AND j.currency IS NOT NULL
       AND EXISTS (SELECT 1 FROM journal_lines WHERE journal_id = j.id AND account_code = ?)
       AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = j.id)
       AND NOT EXISTS (SELECT 1 FROM journals s WHERE s.settles_id = j.id AND NOT EXISTS (SELECT 1 FROM journals rr WHERE rr.reverses_id = s.id))
     ORDER BY j.id`,
    ACC.AP,
    ACC.AP,
  );
}

/**
 * Pays a foreign-currency invoice in full at today's rate. The payable is cleared at its booked EUR value;
 * the difference to what the bank actually paid is a realised FX gain or loss.
 */
export function settleForeignInvoice(db: DB, i: Common & { receiptId: number; fxRate: string }) {
  return posting(db, i.idempotencyKey, () => {
    checkPostingDate(db, i.docDate);
    const inv = openForeignInvoices(db).find((o) => o.id === i.receiptId);
    if (!inv) throw new LedgerError(`Journal #${i.receiptId} is not an open foreign-currency invoice.`);
    if (i.docDate < inv.doc_date) throw new LedgerError("A payment cannot be dated before its invoice.");
    const paid = toEur(inv.foreign_amount, inv.currency, i.fxRate);
    const diff = paid - inv.eur_amount;
    const lines: Line[] = [
      { account: ACC.AP, debit: inv.eur_amount, credit: 0 },
      { account: ACC.CASH, debit: 0, credit: paid },
    ];
    if (diff > 0) lines.push({ account: ACC.FX_LOSS, debit: diff, credit: 0 });
    if (diff < 0) lines.push({ account: ACC.FX_GAIN, debit: 0, credit: -diff });
    const j = commit(db, {
      ...i,
      kind: "PAYMENT",
      counterparty: inv.counterparty,
      reference: i.reference || inv.reference,
      memo: i.memo || `Settles #${inv.id} (${inv.currency} at ${i.fxRate}, booked at ${inv.fx_rate})`,
      currency: inv.currency,
      fxRate: i.fxRate,
      foreignAmount: inv.foreign_amount,
      settlesId: inv.id,
      contactId: i.contactId ?? get<{ c: number | null }>(db, "SELECT contact_id c FROM journals WHERE id = ?", inv.id)?.c ?? undefined,
      lines,
      moves: [],
    });
    allocate(db, j.id, "AP", undefined, inv.eur_amount, [inv.id]);
    return j;
  });
}

/**
 * Corrects a posted journal without touching it: posts its exact mirror image, dated in an open period.
 * If moving-average cost has shifted since, the difference goes to "Inventory cost variance" so
 * GL and stock sub-ledger stay in agreement.
 */
export function reverseJournal(
  db: DB,
  i: { journalId: number; docDate: string; reason: string; idempotencyKey?: string; postedAt?: string; actorId?: number; approvedBy?: number },
) {
  return posting(db, i.idempotencyKey, () => {
    checkPostingDate(db, i.docDate);
    if (!i.reason.trim()) throw new LedgerError("Give a reason for the reversal; it becomes part of the audit trail.");
    const orig = get<JournalRow>(db, "SELECT * FROM journals WHERE id = ?", i.journalId);
    if (!orig) throw new LedgerError(`Journal #${i.journalId} does not exist.`);
    if (orig.kind === "REVERSAL") throw new LedgerError("A reversal can't be reversed. Post a new transaction instead.");
    if (orig.kind === "CLOSING") throw new LedgerError("Year-end closing entries are part of a sealed year and can't be reversed.");
    const settlement = get<{ id: number }>(
      db,
      "SELECT s.id FROM journals s WHERE s.settles_id = ? AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = s.id)",
      orig.id,
    );
    if (settlement) throw new LedgerError(`This invoice was paid by #${settlement.id}. Reverse that payment first.`);
    const paidBy = get<{ p: number }>(
      db,
      "SELECT a.payment_id p FROM allocations a WHERE a.invoice_id = ? AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_id = a.payment_id) LIMIT 1",
      orig.id,
    );
    if (paidBy) throw new LedgerError(`Payment #${paidBy.p} has been applied to this invoice. Reverse that payment first.`);
    const already = get<{ id: number }>(db, "SELECT id FROM journals WHERE reverses_id = ?", orig.id);
    if (already) throw new LedgerError(`Journal #${orig.id} was already reversed by #${already.id}.`);
    if (i.docDate < orig.doc_date) throw new LedgerError("A reversal cannot be dated before the original entry.");

    const lines = all<LineRow>(db, "SELECT account_code, debit, credit FROM journal_lines WHERE journal_id = ? ORDER BY id", orig.id);
    const moves = all<MoveRow>(db, "SELECT * FROM stock_moves WHERE journal_id = ? ORDER BY id", orig.id);
    const p = planner(db, i.docDate);
    let actual = 0;
    for (const m of [...moves].reverse()) actual += p.undo(m.item_id, m.warehouse_id, -m.qty, -m.value);

    const mirrored: Line[] = lines.map((l) => ({ account: l.account_code, debit: l.credit, credit: l.debit }));
    const glInventory = mirrored.filter((l) => l.account === ACC.INV).reduce((s, l) => s + l.debit - l.credit, 0);
    const diff = actual - glInventory;
    if (diff > 0) mirrored.push({ account: ACC.INV, debit: diff, credit: 0 }, { account: ACC.VARIANCE, debit: 0, credit: diff });
    if (diff < 0) mirrored.push({ account: ACC.VARIANCE, debit: -diff, credit: 0 }, { account: ACC.INV, debit: 0, credit: -diff });

    return commit(db, {
      kind: "REVERSAL",
      docDate: i.docDate,
      postedAt: i.postedAt,
      actorId: i.actorId,
      approvedBy: i.approvedBy,
      contactId: orig.contact_id ?? undefined,
      idempotencyKey: i.idempotencyKey,
      reversesId: orig.id,
      memo: `Reversal of #${orig.id}: ${i.reason.trim()}`,
      reference: orig.reference,
      counterparty: orig.counterparty,
      lines: mirrored,
      moves: p.moves,
    });
  });
}

// ───────────────────────── period close ─────────────────────────

/** Deterministic picture of the books at month end: every account total and every stock position. */
export function periodSnapshot(db: DB, period: string) {
  const end = monthEnd(period);
  const accounts = all<{ code: string; debit: number; credit: number }>(
    db,
    `SELECT l.account_code code, SUM(l.debit) debit, SUM(l.credit) credit
     FROM journal_lines l JOIN journals j ON j.id = l.journal_id
     WHERE j.doc_date <= ? GROUP BY l.account_code ORDER BY l.account_code`,
    end,
  );
  const stock = all<{ item: number; wh: number; qty: number; value: number }>(
    db,
    `SELECT item_id item, warehouse_id wh, qty_after qty, value_after value FROM stock_moves
     WHERE id IN (SELECT MAX(id) FROM stock_moves WHERE doc_date <= ? GROUP BY item_id, warehouse_id)
     ORDER BY item_id, warehouse_id`,
    end,
  );
  return {
    period,
    asOf: end,
    accounts: accounts.map((a) => [a.code, a.debit, a.credit]),
    stock: stock.map((s) => [s.item, s.wh, s.qty, s.value]),
  };
}

/** Months close strictly in order. Closing is permanent and seals a hashed snapshot. */
export function nextClosablePeriod(db: DB): string | null {
  const lock = lockedThrough(db);
  const first = get<{ d: string | null }>(db, "SELECT MIN(doc_date) d FROM journals")?.d;
  const candidate = lock ? nextMonth(lock) : first ? first.slice(0, 7) : null;
  if (!candidate || monthEnd(candidate) >= today()) return null;
  return candidate;
}

export function closePeriod(db: DB, period: string, actor: string, closedAt?: string) {
  return tx(db, () => {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new LedgerError("Period must look like YYYY-MM.");
    const lock = lockedThrough(db);
    if (lock && period <= lock) throw new LedgerError(`${period} is already closed.`);
    const expected = nextClosablePeriod(db);
    if (period !== expected) {
      throw new LedgerError(expected ? `Periods close in order: close ${expected} first.` : `${period} can't be closed yet.`);
    }
    let closingId: number | null = null;
    if (period.endsWith("-12")) closingId = postYearEndClose(db, period.slice(0, 4), closedAt);
    const snapshot = JSON.stringify(periodSnapshot(db, period));
    const hash = sha256(snapshot);
    const last = get<{ id: number | null }>(db, "SELECT MAX(id) id FROM journals")!.id ?? 0;
    run(
      db,
      "INSERT INTO period_closes (period, closed_at, closed_by, last_journal_id, snapshot, snapshot_hash) VALUES (?, ?, ?, ?, ?, ?)",
      period, closedAt ?? new Date().toISOString(), actor, last, snapshot, hash,
    );
    audit(db, actor, "PERIOD_CLOSED", `${period} sealed with snapshot ${hash.slice(0, 16)}… (through journal #${last})`);
    if (closingId) audit(db, actor, "YEAR_CLOSED", `FY${period.slice(0, 4)} profit transferred to retained earnings by #${closingId}`);
    return { period, hash, closingId };
  });
}

/**
 * Year-end: zero every revenue and expense account for the year into Retained earnings,
 * dated 31 Dec. Runs inside closePeriod's transaction, before December is sealed.
 */
function postYearEndClose(db: DB, year: string, postedAt?: string): number | null {
  const end = `${year}-12-31`;
  const balances = all<{ code: string; bal: number }>(
    db,
    `SELECT l.account_code code, SUM(l.debit - l.credit) bal
     FROM journal_lines l JOIN journals j ON j.id = l.journal_id JOIN accounts a ON a.code = l.account_code
     WHERE j.doc_date <= ? AND a.type IN ('REVENUE', 'EXPENSE')
     GROUP BY l.account_code HAVING bal <> 0 ORDER BY l.account_code`,
    end,
  );
  if (!balances.length) return null;
  const lines: Line[] = balances.map((b) => (b.bal > 0 ? { account: b.code, debit: 0, credit: b.bal } : { account: b.code, debit: -b.bal, credit: 0 }));
  const profit = -balances.reduce((s, b) => s + b.bal, 0);
  lines.push(profit >= 0 ? { account: ACC.RETAINED, debit: 0, credit: profit } : { account: ACC.RETAINED, debit: -profit, credit: 0 });
  return commit(db, {
    kind: "CLOSING",
    docDate: end,
    postedAt,
    memo: `FY${year} close: ${profit >= 0 ? "profit" : "loss"} of ${(Math.abs(profit) / 100).toFixed(2)} EUR to retained earnings`,
    lines,
    moves: [],
  }).id;
}

// ───────────────────────── master data ─────────────────────────

export function createWarehouse(db: DB, code: string, name: string) {
  const r = run(db, "INSERT INTO warehouses (code, name) VALUES (?, ?)", code, name);
  return Number(r.lastInsertRowid);
}

export function createItem(db: DB, i: { sku: string; name: string; unit?: string; category?: string; vatRate?: number }, actor = "system") {
  const sku = i.sku.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,23}$/.test(sku)) throw new LedgerError("SKU: 2–24 characters, letters, digits and dashes.");
  if (!i.name.trim()) throw new LedgerError("Give the item a name.");
  assertVat(i.vatRate ?? 19);
  if (get(db, "SELECT id FROM items WHERE sku = ?", sku)) throw new LedgerError(`SKU ${sku} already exists.`);
  const r = run(
    db,
    "INSERT INTO items (sku, name, unit, category, vat_rate, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    sku, i.name.trim(), i.unit?.trim() || "pcs", i.category?.trim() || "General", i.vatRate ?? 19, new Date().toISOString(),
  );
  audit(db, actor, "ITEM_CREATED", `${sku} · ${i.name.trim()}`);
  return Number(r.lastInsertRowid);
}

// ───────────────────────── budgets ─────────────────────────

/** Budgets are versioned, not edited: each save appends a row and the latest row per month/account wins. */
export function setBudget(db: DB, entries: { period: string; account: string; amount: number }[], actor: string) {
  return tx(db, () => {
    const at = new Date().toISOString();
    let changed = 0;
    for (const e of entries) {
      if (!/^\d{4}-\d{2}$/.test(e.period)) throw new LedgerError("Budget period must be YYYY-MM.");
      assertCents(e.amount, "Budget amount");
      if (!get(db, "SELECT code FROM accounts WHERE code = ? AND type IN ('REVENUE','EXPENSE')", e.account)) {
        throw new LedgerError(`Budgets can only be set for revenue and expense accounts (${e.account}).`);
      }
      const cur = get<{ amount: number }>(db, "SELECT amount FROM budget_entries WHERE period = ? AND account_code = ? ORDER BY id DESC LIMIT 1", e.period, e.account);
      if (cur?.amount === e.amount) continue;
      run(db, "INSERT INTO budget_entries (period, account_code, amount, created_at, created_by) VALUES (?, ?, ?, ?, ?)", e.period, e.account, e.amount, at, actor);
      changed++;
    }
    if (changed) audit(db, actor, "BUDGET_UPDATED", `${changed} budget figure(s) changed`);
    return changed;
  });
}

// ───────────────────────── contacts & orders (master/operational data) ─────────────────────────

export function createContact(
  db: DB,
  c: { kind: ContactKind; name: string; email?: string; vatId?: string; termsDays?: number; currency?: string },
  actor = "system",
) {
  const name = c.name.trim();
  if (!name) throw new LedgerError("Give the contact a name.");
  if (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email.trim())) throw new LedgerError("That email address doesn't look right.");
  const terms = c.termsDays ?? 14;
  if (!Number.isInteger(terms) || terms < 0 || terms > 180) throw new LedgerError("Payment terms must be 0–180 days.");
  const cur = c.currency ?? "EUR";
  assertCurrency(cur);
  if (get(db, "SELECT id FROM contacts WHERE kind = ? AND name = ?", c.kind, name)) throw new LedgerError(`A ${c.kind.toLowerCase()} called ${name} already exists.`);
  const r = run(
    db,
    "INSERT INTO contacts (kind, name, email, vat_id, terms_days, currency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    c.kind, name, c.email?.trim() ?? "", c.vatId?.trim() ?? "", terms, cur, new Date().toISOString(),
  );
  audit(db, actor, "CONTACT_CREATED", `${c.kind.toLowerCase()} ${name}`);
  return Number(r.lastInsertRowid);
}

export function createOrder(
  db: DB,
  o: {
    kind: "PO" | "SO";
    contactId: number;
    warehouseId: number;
    orderDate: string;
    expectedDate?: string;
    currency?: string;
    fxRate?: string;
    notes?: string;
    lines: { itemId: number; qty: number; unitAmount: number; vatRate?: number }[];
    actorId?: number;
  },
  actor = "system",
) {
  return tx(db, () => {
    assertDate(o.orderDate);
    if (o.expectedDate) assertDate(o.expectedDate);
    contactFor(db, o.contactId, o.kind === "PO" ? "SUPPLIER" : "CUSTOMER");
    if (!get(db, "SELECT id FROM warehouses WHERE id = ?", o.warehouseId)) throw new LedgerError("Unknown warehouse.");
    if (!o.lines.length) throw new LedgerError("Add at least one line.");
    const currency = o.currency && o.currency !== "EUR" ? o.currency : "EUR";
    assertCurrency(currency);
    if (o.kind === "SO" && currency !== "EUR") throw new LedgerError("Sales orders are in EUR.");
    if (currency !== "EUR") {
      if (!o.fxRate) throw new LedgerError(`Enter the expected ${currency} → EUR rate.`);
      parseRate(o.fxRate);
    }
    for (const l of o.lines) {
      assertQty(l.qty);
      assertCents(l.unitAmount, "Unit amount");
      assertVat(currency !== "EUR" ? 0 : (l.vatRate ?? 0));
      if (!get(db, "SELECT id FROM items WHERE id = ?", l.itemId)) throw new LedgerError(`Unknown item #${l.itemId}.`);
    }
    const seq = (get<{ n: number }>(db, "SELECT COUNT(*) n FROM orders WHERE kind = ?", o.kind)!.n + 1).toString().padStart(4, "0");
    const number = `${o.kind}-${o.orderDate.slice(0, 4)}-${seq}`;
    const r = run(
      db,
      `INSERT INTO orders (kind, number, contact_id, warehouse_id, order_date, expected_date, currency, fx_rate, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      o.kind, number, o.contactId, o.warehouseId, o.orderDate, o.expectedDate ?? null, currency, currency !== "EUR" ? o.fxRate! : null,
      o.notes?.trim() ?? "", o.actorId ?? null, new Date().toISOString(),
    );
    const id = Number(r.lastInsertRowid);
    for (const l of o.lines) {
      run(db, "INSERT INTO order_lines (order_id, item_id, qty, unit_amount, vat_rate) VALUES (?, ?, ?, ?, ?)", id, l.itemId, l.qty, l.unitAmount, currency !== "EUR" ? 0 : (l.vatRate ?? 0));
    }
    audit(db, actor, "ORDER_CREATED", `${number}`);
    return { id, number };
  });
}

export function cancelOrder(db: DB, orderId: number, actor: string) {
  const o = get<{ number: string; cancelled_at: string | null }>(db, "SELECT number, cancelled_at FROM orders WHERE id = ?", orderId);
  if (!o) throw new LedgerError("Unknown order.");
  if (o.cancelled_at) throw new LedgerError(`${o.number} is already cancelled.`);
  const rem = [...orderRemaining(db, orderId).values()].reduce((a, b) => a + b, 0);
  if (rem === 0) throw new LedgerError(`${o.number} is already fully delivered.`);
  run(db, "UPDATE orders SET cancelled_at = ? WHERE id = ?", new Date().toISOString(), orderId);
  audit(db, actor, "ORDER_CANCELLED", `${o.number} (remaining quantities closed)`);
}
