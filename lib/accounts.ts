// Chart of accounts. Pure module: safe to import from client and server code.

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export const ACC = {
  CASH: "1000",
  AR: "1100",
  INV: "1300",
  AP: "2000",
  EQUITY: "3000",
  REVENUE: "4000",
  COGS: "5000",
  SHRINK: "5100",
  VARIANCE: "5200",
  OPEX: "6000",
} as const;

export const ACCOUNTS: { code: string; name: string; type: AccountType }[] = [
  { code: ACC.CASH, name: "Cash at bank", type: "ASSET" },
  { code: ACC.AR, name: "Accounts receivable", type: "ASSET" },
  { code: ACC.INV, name: "Inventory", type: "ASSET" },
  { code: ACC.AP, name: "Accounts payable", type: "LIABILITY" },
  { code: ACC.EQUITY, name: "Owner's capital", type: "EQUITY" },
  { code: ACC.REVENUE, name: "Sales revenue", type: "REVENUE" },
  { code: ACC.COGS, name: "Cost of goods sold", type: "EXPENSE" },
  { code: ACC.SHRINK, name: "Inventory shrinkage & adjustments", type: "EXPENSE" },
  { code: ACC.VARIANCE, name: "Inventory cost variance", type: "EXPENSE" },
  { code: ACC.OPEX, name: "Operating expenses", type: "EXPENSE" },
];

export const ACCOUNT_NAME: Record<string, string> = Object.fromEntries(ACCOUNTS.map((a) => [a.code, a.name]));

/** Cost-of-sales accounts shown above gross profit. */
export const COST_OF_SALES = [ACC.COGS, ACC.SHRINK, ACC.VARIANCE] as string[];

export const isDebitNormal = (t: AccountType) => t === "ASSET" || t === "EXPENSE";

export type JournalKind = "RECEIPT" | "SALE" | "TRANSFER" | "ADJUSTMENT" | "PAYMENT" | "REVERSAL";

export const KIND_LABEL: Record<JournalKind, string> = {
  RECEIPT: "Goods receipt",
  SALE: "Sale",
  TRANSFER: "Transfer",
  ADJUSTMENT: "Stock adjustment",
  PAYMENT: "Cash movement",
  REVERSAL: "Reversal",
};
