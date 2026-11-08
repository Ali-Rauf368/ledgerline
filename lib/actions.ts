"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { getDb } from "./db";
import type { DB } from "./db";
import type { CashType } from "./ledger";
import {
  audit, cancelOrder, createContact, createItem, createOrder, LedgerError, openForeignInvoices, postAdjustment, postCash, postReceipt,
  postSale, postTransfer, reverseJournal, setBudget, settleForeignInvoice, toEur, vatPosition,
} from "./ledger";
import type { Currency } from "./accounts";
import type { Permission, Role, User } from "./auth";
import { AuthError, createUser, login, logout, SESSION_COOKIE, SESSION_DAYS, updateUser } from "./auth";
import { decide, needsApproval, requestApproval } from "./approvals";
import { createFromLine, importStatement, matchLine, sampleStatementCsv, unmatchLine } from "./bank";
import type { AssistantReply, ChatTurn } from "./assistant";
import { askLedger, generateCommentary } from "./assistant";
import { positionOf } from "./ledger";
import { actionUser } from "./session";

export type ActionResult = { ok: true; id: number; approval?: number } | { ok: false; error: string };

type Common = { docDate: string; reference?: string; memo?: string; idempotencyKey: string; contactId?: number; orderId?: number };
export type TxPayload =
  | (Common & { kind: "RECEIPT"; warehouseId: number; counterparty: string; paid: boolean; currency?: string; fxRate?: string; lines: { itemId: number; qty: number; amount: number; vatRate?: number }[] })
  | (Common & { kind: "SALE"; warehouseId: number; counterparty: string; paid: boolean; lines: { itemId: number; qty: number; amount: number; vatRate?: number }[] })
  | (Common & { kind: "SETTLE_FX"; receiptId: number; fxRate: string })
  | (Common & { kind: "TRANSFER"; warehouseId: number; toWarehouseId: number; lines: { itemId: number; qty: number }[] })
  | (Common & { kind: "ADJUSTMENT"; warehouseId: number; lines: { itemId: number; qty: number; amount?: number }[] })
  | (Common & { kind: "PAYMENT"; cashType: CashType; amount: number; counterparty: string; invoiceIds?: number[] });

function fail(db: DB, actor: string, what: string, e: unknown): { ok: false; error: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof LedgerError) {
    audit(db, actor, e instanceof AuthError ? "ACCESS_DENIED" : "POSTING_REJECTED", `${what}: ${msg}`);
    return { ok: false, error: msg };
  }
  console.error(e);
  return { ok: false, error: `Unexpected error: ${msg}` };
}

/** Run an action as the signed-in user with a permission check, mapping errors to messages. */
async function as<T>(perm: Permission | undefined, what: string, fn: (db: DB, u: User) => T | Promise<T>): Promise<T | { ok: false; error: string }> {
  const db = getDb();
  let u: User;
  try {
    u = await actionUser(perm);
  } catch (e) {
    return fail(db, "anonymous", what, e);
  }
  try {
    return await fn(db, u);
  } catch (e) {
    return fail(db, u.email, what, e);
  }
}

const done = <T extends object>(r: T) => {
  revalidatePath("/", "layout");
  return r;
};

// ───────────────────────── auth ─────────────────────────

export async function loginAction(email: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getDb();
  try {
    const h = await headers();
    const { token, expires } = login(db, String(email), String(password), h.get("user-agent") ?? "");
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && process.env.LEDGERLINE_INSECURE_COOKIES !== "1",
      path: "/",
      expires: new Date(expires),
      maxAge: SESSION_DAYS * 86400,
    });
    return { ok: true };
  } catch (e) {
    return fail(db, String(email), "Sign in", e);
  }
}

export async function logoutAction() {
  const jar = await cookies();
  logout(getDb(), jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
}

// ───────────────────────── postings ─────────────────────────

const PERM: Record<TxPayload["kind"], Permission> = {
  RECEIPT: "post:RECEIPT",
  SALE: "post:SALE",
  TRANSFER: "post:TRANSFER",
  ADJUSTMENT: "post:ADJUSTMENT",
  PAYMENT: "post:PAYMENT",
  SETTLE_FX: "post:PAYMENT",
};

/** Gross amount a posting puts at stake, used for the four-eyes threshold. */
function faceAmount(db: DB, p: TxPayload): number {
  const withVat = (net: number, rate = 0) => net + Math.round((net * rate) / 100);
  switch (p.kind) {
    case "RECEIPT":
      return p.lines.reduce((t, l) => {
        const net = p.currency && p.currency !== "EUR" && p.fxRate ? toEur(l.qty * l.amount, p.currency as Currency, p.fxRate) : l.qty * l.amount;
        return t + withVat(net, l.vatRate);
      }, 0);
    case "SALE":
      return p.lines.reduce((t, l) => t + withVat(l.qty * l.amount, l.vatRate), 0);
    case "PAYMENT":
      return p.cashType === "PAY_VAT" ? Math.abs(vatPosition(db).net) : p.amount;
    case "SETTLE_FX":
      return openForeignInvoices(db).find((o) => o.id === p.receiptId)?.eur_amount ?? 0;
    case "ADJUSTMENT":
      return p.lines.reduce((t, l) => {
        const pos = positionOf(db, l.itemId, p.warehouseId);
        return t + Math.abs(l.qty) * (l.amount ?? (pos.qty ? Math.round(pos.value / pos.qty) : 0));
      }, 0);
    case "TRANSFER":
      return 0; // value-neutral
  }
}

function summarize(p: TxPayload, amount: number) {
  const eur = `€${(amount / 100).toLocaleString("en-IE", { minimumFractionDigits: 2 })}`;
  const who = "counterparty" in p && p.counterparty ? ` · ${p.counterparty}` : "";
  const label = { RECEIPT: "Goods receipt", SALE: "Sale", TRANSFER: "Transfer", ADJUSTMENT: "Stock adjustment", PAYMENT: "Cash movement", SETTLE_FX: "Foreign invoice payment" }[p.kind];
  return `${label} ${eur}${who} (dated ${p.docDate})`;
}

/** Executes a posting payload. Used directly and when an approval is granted. */
function execute(db: DB, p: TxPayload, actorId: number, approvedBy?: number) {
  const base = { docDate: p.docDate, reference: p.reference, memo: p.memo, idempotencyKey: p.idempotencyKey, actorId, approvedBy, contactId: p.contactId, orderId: p.orderId };
  switch (p.kind) {
    case "RECEIPT":
      return postReceipt(db, { ...base, warehouseId: p.warehouseId, supplier: p.counterparty, paid: p.paid, currency: p.currency, fxRate: p.fxRate, lines: p.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitCost: l.amount, vatRate: l.vatRate })) });
    case "SALE":
      return postSale(db, { ...base, warehouseId: p.warehouseId, customer: p.counterparty, paid: p.paid, lines: p.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitPrice: l.amount, vatRate: l.vatRate })) });
    case "TRANSFER":
      return postTransfer(db, { ...base, fromWarehouseId: p.warehouseId, toWarehouseId: p.toWarehouseId, lines: p.lines });
    case "ADJUSTMENT":
      return postAdjustment(db, { ...base, warehouseId: p.warehouseId, lines: p.lines.map((l) => ({ itemId: l.itemId, qtyDelta: l.qty, unitCost: l.amount })) });
    case "PAYMENT":
      return postCash(db, { ...base, type: p.cashType, amount: p.amount, counterparty: p.counterparty, invoiceIds: p.invoiceIds });
    case "SETTLE_FX":
      return settleForeignInvoice(db, { ...base, receiptId: p.receiptId, fxRate: p.fxRate });
  }
}

export async function postTransaction(p: TxPayload): Promise<ActionResult> {
  return as(PERM[p.kind], p.kind, (db, u) => {
    const amount = faceAmount(db, p);
    if (needsApproval(amount)) {
      const existing = db.prepare("SELECT id FROM approvals WHERE status = 'PENDING' AND payload LIKE ?").get(`%"idempotencyKey":"${p.idempotencyKey}"%`) as { id: number } | undefined;
      const id = existing?.id ?? requestApproval(db, u, "POSTING", summarize(p, amount), amount, p);
      return done({ ok: true as const, id: 0, approval: id });
    }
    return done({ ok: true as const, id: execute(db, p, u.id).id });
  });
}

export async function decideApprovalAction(id: number, decision: "APPROVE" | "REJECT", note: string): Promise<ActionResult> {
  return as("approve", `Approval #${id}`, (db, u) => {
    const r = decide(db, u, id, decision, note.slice(0, 300), (payload, requester, approver) => execute(db, payload as TxPayload, requester, approver).id);
    return done({ ok: true as const, id: r.journalId ?? 0 });
  });
}

export async function reverseAction(journalId: number, docDate: string, reason: string, idempotencyKey: string): Promise<ActionResult> {
  return as("reverse", `Reverse #${journalId}`, (db, u) => {
    const j = reverseJournal(db, { journalId, docDate, reason, idempotencyKey, actorId: u.id });
    audit(db, u.email, "JOURNAL_REVERSED", `#${journalId} reversed by #${j.id}: ${reason}`);
    return done({ ok: true as const, id: j.id });
  });
}

/** Period closes always need a second person. */
export async function closePeriodAction(period: string): Promise<ActionResult> {
  return as("period:close", `Close ${period}`, (db, u) => {
    const id = requestApproval(db, u, "PERIOD_CLOSE", `Close ${period}${period.endsWith("-12") ? " and the fiscal year" : ""}`, 0, { period });
    return done({ ok: true as const, id: 0, approval: id });
  });
}

// ───────────────────────── master data ─────────────────────────

export async function createItemAction(input: { sku: string; name: string; category: string; unit: string; vatRate?: number }): Promise<ActionResult> {
  return as("post:RECEIPT", "Create item", (db, u) => done({ ok: true as const, id: createItem(db, input, u.email) }));
}

export async function createContactAction(input: { kind: "CUSTOMER" | "SUPPLIER"; name: string; email?: string; vatId?: string; termsDays?: number; currency?: string }): Promise<ActionResult> {
  return as("contacts:edit", "Create contact", (db, u) => done({ ok: true as const, id: createContact(db, input, u.email) }));
}

export async function createOrderAction(input: Parameters<typeof createOrder>[1]): Promise<ActionResult> {
  return as(input.kind === "SO" ? "post:SALE" : "orders:edit", "Create order", (db, u) => done({ ok: true as const, id: createOrder(db, { ...input, actorId: u.id }, u.email).id }));
}

export async function cancelOrderAction(id: number): Promise<ActionResult> {
  return as("orders:edit", `Cancel order ${id}`, (db, u) => {
    cancelOrder(db, id, u.email);
    return done({ ok: true as const, id });
  });
}

export async function saveBudgetAction(entries: { period: string; account: string; amount: number }[]): Promise<ActionResult> {
  return as("budget:edit", "Budget", (db, u) => done({ ok: true as const, id: setBudget(db, entries, u.email) }));
}

// ───────────────────────── users ─────────────────────────

export async function createUserAction(input: { email: string; name: string; role: Role; password: string }): Promise<ActionResult> {
  return as("users:manage", "Create user", (db, u) => done({ ok: true as const, id: createUser(db, input, u.email) }));
}

export async function updateUserAction(id: number, patch: { role?: Role; active?: boolean; password?: string }): Promise<ActionResult> {
  return as("users:manage", `Update user ${id}`, (db, u) => {
    updateUser(db, u, id, patch);
    return done({ ok: true as const, id });
  });
}

// ───────────────────────── bank ─────────────────────────

export async function importStatementAction(filename: string, text: string): Promise<ActionResult & { matched?: number; lines?: number }> {
  return as("bank:reconcile", "Bank import", (db, u) => {
    if (text.length > 2_000_000) throw new LedgerError("The file is too large (max 2 MB).");
    const r = importStatement(db, u, filename, text);
    return done({ ok: true as const, id: r.id, matched: r.matched, lines: r.lines });
  });
}

export async function importSampleStatementAction(): Promise<ActionResult & { matched?: number; lines?: number }> {
  return as("bank:reconcile", "Bank import", (db, u) => {
    const t = new Date();
    const from = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0)).toISOString().slice(0, 10);
    const r = importStatement(db, u, `Sparkasse_${from.slice(0, 7)}.csv`, sampleStatementCsv(db, from, to));
    return done({ ok: true as const, id: r.id, matched: r.matched, lines: r.lines });
  });
}

export async function matchLineAction(lineId: number, journalId: number): Promise<ActionResult> {
  return as("bank:reconcile", "Bank match", (db, u) => {
    matchLine(db, u.id, u.email, lineId, journalId);
    return done({ ok: true as const, id: lineId });
  });
}

export async function unmatchLineAction(lineId: number): Promise<ActionResult> {
  return as("bank:reconcile", "Bank unmatch", (db, u) => {
    unmatchLine(db, u.id, u.email, lineId);
    return done({ ok: true as const, id: lineId });
  });
}

export async function bookLineAction(lineId: number, type: CashType, contactId?: number): Promise<ActionResult> {
  return as("bank:reconcile", "Bank booking", (db, u) => done({ ok: true as const, id: createFromLine(db, u, lineId, { type, contactId }) }));
}

// ───────────────────────── AI ─────────────────────────

export async function generateCommentaryAction(period: string): Promise<{ ok: true; notice?: string } | { ok: false; error: string }> {
  if (!/^\d{4}-\d{2}$/.test(period)) return { ok: false, error: "Invalid period." };
  return as("ai:commentary", "Commentary", async (db, u) => {
    const c = await generateCommentary(db, period);
    audit(db, u.email, "COMMENTARY_WRITTEN", `${period} by ${c.source} (data ${c.data_hash.slice(0, 12)}…)`);
    return done({ ok: true as const, notice: c.notice });
  });
}

export async function askAssistant(history: ChatTurn[]): Promise<AssistantReply> {
  const r = await as(undefined, "Copilot", (db) => {
    const clean = history
      .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.trim())
      .map((t) => ({ role: t.role, text: t.text.slice(0, 4000) }));
    if (!clean.length || clean.at(-1)!.role !== "user") return { text: "Ask me something about your ledger.", tools: [], mode: "offline" as const };
    return askLedger(db, clean);
  });
  return "ok" in r && r.ok === false ? { text: r.error, tools: [], mode: "offline" } : (r as AssistantReply);
}

