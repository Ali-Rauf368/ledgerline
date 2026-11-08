// Transaction drafts proposed by Copilot. Pure module (client + server). A draft only pre-fills the
// New transaction form; a human always reviews and posts it, so the ledger is never written by AI.
import type { CashType } from "./ledger";

export type TxDraft = {
  kind: "RECEIPT" | "SALE" | "TRANSFER" | "ADJUSTMENT" | "PAYMENT";
  warehouseId?: number;
  toWarehouseId?: number;
  counterparty?: string;
  paid?: boolean;
  memo?: string;
  reference?: string;
  currency?: string;
  fxRate?: string;
  cashType?: CashType;
  amount?: string;
  lines?: { itemId: number; qty: string; amount: string; vatRate?: number }[];
};

export const draftHref = (d: TxDraft) => `/transactions/new?draft=${encodeURIComponent(JSON.stringify(d))}`;

export function parseDraft(raw: string | undefined): TxDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as TxDraft;
    return ["RECEIPT", "SALE", "TRANSFER", "ADJUSTMENT", "PAYMENT"].includes(d.kind) ? d : null;
  } catch {
    return null;
  }
}
