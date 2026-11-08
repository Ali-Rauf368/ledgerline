// Builds ~13 months of realistic history for a small coffee wholesaler, through the real posting engine:
// VAT (7% coffee / 19% goods), USD supplier invoices settled later at a moved rate, monthly VAT settlements,
// a fiscal-year close, budgets, a corrected keying error and a few planted anomalies for the detector.
import fs from "node:fs";
import { DEFAULT_DB_PATH, openDb } from "../lib/db.ts";
import {
  audit, closePeriod, createItem, createWarehouse, LedgerError, nextClosablePeriod, openForeignInvoices, positionOf,
  postAdjustment, postCash, postReceipt, postSale, postTransfer, rawBalance, reverseJournal, setBudget,
  settleForeignInvoice, today, vatPosition,
} from "../lib/ledger.ts";
import { ACC } from "../lib/accounts.ts";
import { verifyLedger } from "../lib/integrity.ts";

const file = process.env.LEDGER_DB ?? DEFAULT_DB_PATH;
for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
const db = openDb(file);

let s = 20261108;
const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

const main = createWarehouse(db, "BER", "Berlin Central");
const depot = createWarehouse(db, "LEJ", "Leipzig Depot");

const catalog = [
  { sku: "ETH-YRG-1K", name: "Ethiopia Yirgacheffe · 1 kg", category: "Coffee", unit: "bag", cost: 1450, price: 2690, vatRate: 7, usd: false },
  { sku: "COL-HUI-1K", name: "Colombia Huila · 1 kg", category: "Coffee", unit: "bag", cost: 1280, price: 2390, vatRate: 7, usd: false },
  { sku: "ESP-BLD-1K", name: "House Espresso Blend · 1 kg", category: "Coffee", unit: "bag", cost: 1120, price: 2190, vatRate: 7, usd: false },
  { sku: "GRN-BUR-01", name: "Conical Burr Grinder", category: "Equipment", unit: "pcs", cost: 6400, price: 11900, vatRate: 19, usd: false },
  { sku: "KTL-GSN-06", name: "Gooseneck Kettle 0.6 L", category: "Equipment", unit: "pcs", cost: 2350, price: 4490, vatRate: 19, usd: true },
  { sku: "DRP-CER-02", name: "Ceramic Dripper #02", category: "Brewing", unit: "pcs", cost: 890, price: 1990, vatRate: 19, usd: true },
  { sku: "FLT-PAP-100", name: "Paper Filters ×100", category: "Supplies", unit: "box", cost: 210, price: 590, vatRate: 19, usd: false },
  { sku: "CBK-KIT-01", name: "Cold Brew Kit", category: "Brewing", unit: "pcs", cost: 1680, price: 3490, vatRate: 19, usd: false },
];
const items = catalog.map((c) => ({ ...c, id: createItem(db, c, "seed") }));
const domestic = items.filter((i) => !i.usd);
const imported = items.filter((i) => i.usd);

const suppliers = ["Rösterei Nord GmbH", "Hario Europe", "Filterwerk AG"];
const customers = ["Café Kranich", "Büro Lichtblick", "Hotel Spreeblick", "Kiezbäckerei", "Coworking Mitte", "Online shop"];

const now = new Date();
const end = today();
const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1)).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const totalDays = Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
let clock = 0;
const at = (d: string, hour: number) => {
  const t = Math.min(Date.parse(`${d}T${String(hour).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}:00Z`), Date.now() - 60000);
  clock = Math.max(clock + 1000, t);
  return new Date(clock).toISOString();
};
/** USD→EUR drifts between ~0.88 and ~0.96 so settlements produce real gains and losses. */
const usdRate = (day: number) => (0.92 + 0.035 * Math.sin(day / 37) + (rnd() - 0.5) * 0.008).toFixed(4);

let posted = 0;
let skipped = 0;
const attempt = <T>(fn: () => T): T | undefined => {
  try {
    const r = fn();
    posted++;
    return r;
  } catch (e) {
    if (e instanceof LedgerError) skipped++;
    else throw e;
  }
};

attempt(() => postCash(db, { docDate: start, type: "CAPITAL", amount: 9000000, counterparty: "Founders", memo: "Initial capital", postedAt: at(start, 8) }));

let day = 0;
let correctionDone = false;
const planted = { spike: totalDays - 40, below: totalDays - 26, flood: totalDays - 13, dup: totalDays - 7 };

for (let d = start; d <= end; d = addDays(d, 1), day++) {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  const weekend = dow === 0 || dow === 6;
  const drift = 1 + day * 0.0006;
  const season = 1 + 0.18 * Math.sin(((Number(d.slice(5, 7)) - 3) / 12) * 2 * Math.PI); // busier in winter

  // Domestic replenishment on Mondays.
  if (dow === 1 || day === 0) {
    const lines = domestic
      .filter((i) => positionOf(db, i.id, main).qty < 45 || day === 0)
      .map((i) => ({ itemId: i.id, qty: int(20, 50), unitCost: Math.round(i.cost * drift * (0.97 + rnd() * 0.06)), vatRate: i.vatRate }));
    if (lines.length) attempt(() => postReceipt(db, { docDate: d, warehouseId: main, supplier: pick(suppliers), reference: `PO-${1000 + day}`, lines, postedAt: at(d, 9) }));

    // A mis-keyed receipt corrected the right way: reversal, then re-entry.
    if (!correctionDone && day > 300) {
      const it = items[3];
      const wrong = attempt(() => postReceipt(db, { docDate: d, warehouseId: main, supplier: "Hario Europe", reference: "PO-TYPO", memo: "Grinders delivery", lines: [{ itemId: it.id, qty: 60, unitCost: it.cost, vatRate: 19 }], postedAt: at(d, 10) }));
      if (wrong) {
        attempt(() => reverseJournal(db, { journalId: wrong.id, docDate: d, reason: "Quantity keyed as 60 instead of 6", postedAt: at(d, 11) }));
        attempt(() => postReceipt(db, { docDate: d, warehouseId: main, supplier: "Hario Europe", reference: "PO-TYPO", memo: "Grinders delivery (corrected)", lines: [{ itemId: it.id, qty: 6, unitCost: it.cost, vatRate: 19 }], postedAt: at(d, 11) }));
        correctionDone = true;
      }
    }
  }

  // Imported goods from Japan, invoiced in USD, roughly every three weeks.
  if (dow === 2 && day % 21 < 7) {
    const rate = usdRate(day);
    const lines = imported
      .filter((i) => positionOf(db, i.id, main).qty < 60)
      .map((i) => ({ itemId: i.id, qty: int(25, 45), unitCost: Math.round((i.cost * drift) / Number(rate)) }));
    if (lines.length) attempt(() => postReceipt(db, { docDate: d, warehouseId: main, supplier: "Kalita Trading Co.", reference: `KT-${2000 + day}`, currency: "USD", fxRate: rate, lines, postedAt: at(d, 9) }));
  }
  // Pay USD invoices ~4 weeks after receipt at that day's rate.
  for (const inv of openForeignInvoices(db)) {
    if (addDays(inv.doc_date, 28) <= d) attempt(() => settleForeignInvoice(db, { docDate: d, receiptId: inv.id, fxRate: usdRate(day), postedAt: at(d, 15) }));
  }

  // Planted anomaly: unusually expensive espresso delivery.
  if (day === planted.spike) {
    const it = items[2];
    attempt(() => postReceipt(db, { docDate: d, warehouseId: main, supplier: "Rösterei Nord GmbH", reference: "PO-RUSH", memo: "Rush order, air freight", lines: [{ itemId: it.id, qty: 30, unitCost: Math.round(it.cost * drift * 1.38), vatRate: 7 }], postedAt: at(d, 10) }));
  }

  // Depot restock every other Wednesday.
  if (dow === 3 && day % 14 < 7) {
    const lines = items
      .map((i) => ({ itemId: i.id, qty: Math.min(int(6, 14), positionOf(db, i.id, main).qty) }))
      .filter((l) => l.qty > 0)
      .slice(0, 5);
    if (lines.length) attempt(() => postTransfer(db, { docDate: d, fromWarehouseId: main, toWarehouseId: depot, memo: "Depot restock", lines, postedAt: at(d, 12) }));
  }

  // Sales.
  const salesToday = weekend ? int(0, 1) : Math.round(int(1, 3) * season);
  for (let n = 0; n < salesToday; n++) {
    const wh = rnd() < 0.7 ? main : depot;
    const chosen = [...items].sort(() => rnd() - 0.5).slice(0, int(1, 3));
    const lines = chosen
      .map((i) => ({ itemId: i.id, qty: Math.min(int(1, i.category === "Equipment" ? 2 : 8), positionOf(db, i.id, wh).qty), unitPrice: Math.round(i.price * (0.95 + rnd() * 0.08)), vatRate: i.vatRate }))
      .filter((l) => l.qty > 0);
    if (!lines.length) continue;
    const customer = pick(customers);
    attempt(() => postSale(db, { docDate: d, warehouseId: wh, customer, paid: customer === "Online shop", reference: `INV-${3000 + posted}`, lines, postedAt: at(d, 13 + n) }));
  }
  if (day === planted.below) {
    const it = items[3];
    attempt(() => postSale(db, { docDate: d, warehouseId: main, customer: "Café Kranich", reference: "INV-PROMO", memo: "Grinder clearance price", lines: [{ itemId: it.id, qty: 2, unitPrice: 5200, vatRate: 19 }], postedAt: at(d, 16) }));
  }
  if (day === planted.dup) {
    const it = items[0];
    for (let k = 0; k < 2; k++) {
      attempt(() => postSale(db, { docDate: d, warehouseId: main, customer: "Hotel Spreeblick", reference: `INV-HS-${k}`, lines: [{ itemId: it.id, qty: 4, unitPrice: 2690, vatRate: 7 }], postedAt: at(d, 17) }));
    }
  }

  // Cash cycle.
  if (day % 9 === 4) {
    const ap = -rawBalance(db, ACC.AP) - openForeignInvoices(db).reduce((t, o) => t + o.eur_amount, 0);
    if (ap > 0) attempt(() => postCash(db, { docDate: d, type: "PAY_SUPPLIER", amount: Math.round(ap * 0.75), counterparty: pick(suppliers), memo: "Supplier payment run", postedAt: at(d, 16) }));
    const ar = rawBalance(db, ACC.AR);
    if (ar > 0) attempt(() => postCash(db, { docDate: d, type: "RECEIVE_CUSTOMER", amount: Math.round(ar * 0.8), counterparty: "Customer remittances", memo: "Bank receipts", postedAt: at(d, 16) }));
  }

  // VAT settlement on the 10th.
  if (d.slice(8) === "10" && (vatPosition(db).output || vatPosition(db).input)) {
    attempt(() => postCash(db, { docDate: d, type: "PAY_VAT", amount: 0, counterparty: "Finanzamt Berlin", memo: "Monthly VAT settlement", postedAt: at(d, 10) }));
  }

  // Month-end: rent (entered two days late), utilities, stock count.
  const tomorrow = addDays(d, 1);
  if (tomorrow.slice(8) === "03" && day > 2) {
    attempt(() => postCash(db, { docDate: addDays(d, -2), type: "EXPENSE", amount: 250000, counterparty: "Hausverwaltung Mitte", memo: "Warehouse rent (entered late)", postedAt: at(d, 17) }));
  }
  if (d.slice(8) === "27") {
    const it = pick(items);
    if (positionOf(db, it.id, main).qty > 3) {
      attempt(() => postAdjustment(db, { docDate: d, warehouseId: main, memo: "Monthly stock count: damaged", lines: [{ itemId: it.id, qtyDelta: -int(1, 2) }], postedAt: at(d, 18) }));
    }
    attempt(() => postCash(db, { docDate: d, type: "EXPENSE", amount: int(30000, 70000), counterparty: "Various", memo: "Utilities & packaging", postedAt: at(d, 18) }));
  }
  if (day === planted.flood) {
    const it = items[3];
    attempt(() => postAdjustment(db, { docDate: d, warehouseId: main, memo: "Water damage in storeroom", lines: [{ itemId: it.id, qtyDelta: -Math.min(6, positionOf(db, it.id, main).qty) }], postedAt: at(d, 18) }));
  }
}

// Close all completed months except the last one (so closing can be tried in the app).
// Closing December automatically posts the fiscal-year close into retained earnings.
const lastCompleted = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
for (;;) {
  const p = nextClosablePeriod(db);
  if (!p || p >= lastCompleted) break;
  closePeriod(db, p, "Finance team");
}

// Budgets for both years: revenue with a seasonal shape, COGS at 54%, opex flat.
const years = [...new Set([start.slice(0, 4), end.slice(0, 4)])];
for (const y of years) {
  const entries: { period: string; account: string; amount: number }[] = [];
  for (let m = 1; m <= 12; m++) {
    const period = `${y}-${String(m).padStart(2, "0")}`;
    const rev = Math.round((880000 * (1 + 0.18 * Math.sin(((m - 3) / 12) * 2 * Math.PI))) / 1000) * 1000;
    entries.push({ period, account: ACC.REVENUE, amount: rev }, { period, account: ACC.COGS, amount: Math.round(rev * 0.54) }, { period, account: ACC.OPEX, amount: 300000 });
  }
  setBudget(db, entries, "Finance team");
}

audit(db, "seed", "DEMO_DATA_LOADED", `${posted} journals posted, ${skipped} rejected by validation`);

const v = verifyLedger(db);
console.log(`Seeded ${posted} journals (${skipped} rejected by validation) from ${start} into ${file}`);
console.log(`Integrity: ${v.ok ? "all checks passed" : "FAILED"} · head ${v.head.slice(0, 16)}…`);
if (!v.ok) {
  console.log(v.checks.filter((c) => !c.ok));
  process.exit(1);
}
