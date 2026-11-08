// All amounts are integer cents. Floats never touch the ledger.

const eur = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const eurCompact = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  notation: "compact",
  maximumFractionDigits: 1,
});
const qtyFmt = new Intl.NumberFormat("en-IE");

export const fmtMoney = (cents: number) => eur.format(cents / 100);
export const fmtCompact = (cents: number) => eurCompact.format(cents / 100);
export const fmtQty = (n: number) => qtyFmt.format(n);
export const fmtPct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Parse "12", "12.5", "12.50" (also "12,50") into cents. Returns null when not a valid amount. */
export function parseMoney(input: string): number | null {
  const s = input.trim().replace(",", ".");
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function parseQty(input: string, allowNegative = false): number | null {
  const s = input.trim();
  const re = allowNegative ? /^-?\d{1,9}$/ : /^\d{1,9}$/;
  if (!re.test(s)) return null;
  const n = Number(s);
  return n === 0 ? null : n;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(d: string) {
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

export function fmtMonth(p: string) {
  const [y, m] = p.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function fmtTimestamp(iso: string) {
  return `${fmtDate(iso)}, ${iso.slice(11, 16)} UTC`;
}
