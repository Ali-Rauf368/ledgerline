// Chart of accounts. Pure module: safe to import from client and server code.

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export const ACC = {
  CASH: "1000",
  AR: "1100",
  INV: "1300",
  VAT_IN: "1400",
  AP: "2000",
  VAT_OUT: "2100",
  EQUITY: "3000",
  RETAINED: "3100",
  REVENUE: "4000",
  FX_GAIN: "4900",
  COGS: "5000",
  SHRINK: "5100",
  VARIANCE: "5200",
  OPEX: "6000",
  FX_LOSS: "6900",
} as const;

export const ACCOUNTS: { code: string; name: string; type: AccountType }[] = [
  { code: ACC.CASH, name: "Cash at bank", type: "ASSET" },
  { code: ACC.AR, name: "Accounts receivable", type: "ASSET" },
  { code: ACC.INV, name: "Inventory", type: "ASSET" },
  { code: ACC.VAT_IN, name: "Input VAT receivable", type: "ASSET" },
  { code: ACC.AP, name: "Accounts payable", type: "LIABILITY" },
  { code: ACC.VAT_OUT, name: "Output VAT payable", type: "LIABILITY" },
  { code: ACC.EQUITY, name: "Owner's capital", type: "EQUITY" },
  { code: ACC.RETAINED, name: "Retained earnings", type: "EQUITY" },
  { code: ACC.REVENUE, name: "Sales revenue", type: "REVENUE" },
  { code: ACC.FX_GAIN, name: "Realised FX gains", type: "REVENUE" },
  { code: ACC.COGS, name: "Cost of goods sold", type: "EXPENSE" },
  { code: ACC.SHRINK, name: "Inventory shrinkage & adjustments", type: "EXPENSE" },
  { code: ACC.VARIANCE, name: "Inventory cost variance", type: "EXPENSE" },
  { code: ACC.OPEX, name: "Operating expenses", type: "EXPENSE" },
  { code: ACC.FX_LOSS, name: "Realised FX losses", type: "EXPENSE" },
];

export const VAT_RATES = [0, 7, 19] as const;
export type VatRate = (typeof VAT_RATES)[number];

export const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY"] as const;
export type Currency = (typeof CURRENCIES)[number];
/** Minor units per major unit. */
export const CURRENCY_DECIMALS: Record<Currency, number> = { EUR: 2, USD: 2, GBP: 2, CHF: 2, JPY: 0 };

/** Other income / expense shown below operating result. */
export const OTHER_PNL = [ACC.FX_GAIN, ACC.FX_LOSS] as string[];

export const ACCOUNT_NAME: Record<string, string> = Object.fromEntries(ACCOUNTS.map((a) => [a.code, a.name]));

/** Cost-of-sales accounts shown above gross profit. */
export const COST_OF_SALES = [ACC.COGS, ACC.SHRINK, ACC.VARIANCE] as string[];

export const isDebitNormal = (t: AccountType) => t === "ASSET" || t === "EXPENSE";

export type JournalKind = "RECEIPT" | "SALE" | "TRANSFER" | "ADJUSTMENT" | "PAYMENT" | "REVERSAL" | "CLOSING";

export const KIND_LABEL: Record<JournalKind, string> = {
  RECEIPT: "Goods receipt",
  SALE: "Sale",
  TRANSFER: "Transfer",
  ADJUSTMENT: "Stock adjustment",
  PAYMENT: "Cash movement",
  REVERSAL: "Reversal",
  CLOSING: "Year-end close",
};
