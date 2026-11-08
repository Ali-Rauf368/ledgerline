// Builds ~4 months of realistic history for a small coffee wholesaler, through the real posting engine.
import fs from "node:fs";
import { DEFAULT_DB_PATH, openDb } from "../lib/db.ts";
import {
  audit, closePeriod, createItem, createWarehouse, LedgerError, nextClosablePeriod, positionOf,
  postAdjustment, postCash, postReceipt, postSale, postTransfer, rawBalance, reverseJournal, today,
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
  { sku: "ETH-YRG-1K", name: "Ethiopia Yirgacheffe · 1 kg", category: "Coffee", unit: "bag", cost: 1450, price: 2690 },
  { sku: "COL-HUI-1K", name: "Colombia Huila · 1 kg", category: "Coffee", unit: "bag", cost: 1280, price: 2390 },
  { sku: "ESP-BLD-1K", name: "House Espresso Blend · 1 kg", category: "Coffee", unit: "bag", cost: 1120, price: 2190 },
  { sku: "GRN-BUR-01", name: "Conical Burr Grinder", category: "Equipment", unit: "pcs", cost: 6400, price: 11900 },
  { sku: "KTL-GSN-06", name: "Gooseneck Kettle 0.6 L", category: "Equipment", unit: "pcs", cost: 2350, price: 4490 },
  { sku: "DRP-CER-02", name: "Ceramic Dripper #02", category: "Brewing", unit: "pcs", cost: 890, price: 1990 },
  { sku: "FLT-PAP-100", name: "Paper Filters ×100", category: "Supplies", unit: "box", cost: 210, price: 590 },
  { sku: "CBK-KIT-01", name: "Cold Brew Kit", category: "Brewing", unit: "pcs", cost: 1680, price: 3490 },
];
const items = catalog.map((c) => ({ ...c, id: createItem(db, c, "seed") }));

const suppliers = ["Rösterei Nord GmbH", "Hario Europe", "Kalita Trading", "Filterwerk AG"];
const customers = ["Café Kranich", "Büro Lichtblick", "Hotel Spreeblick", "Kiezbäckerei", "Coworking Mitte", "Online shop"];

const end = today();
const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 4, 1)).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
let clock = 0;
const at = (d: string, hour: number) => {
  const t = Math.min(Date.parse(`${d}T${String(hour).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}:00Z`), Date.now() - 60000);
  clock = Math.max(clock + 1000, t);
  return new Date(clock).toISOString();
};

let posted = 0;
let skipped = 0;
const attempt = (fn: () => unknown) => {
  try { fn(); posted++; } catch (e) { if (e instanceof LedgerError) skipped++; else throw e; }
};

attempt(() => postCash(db, { docDate: start, type: "CAPITAL", amount: 8000000, counterparty: "Founders", memo: "Initial capital", postedAt: at(start, 8) }));

let day = 0;
let correctionDone = false;
for (let d = start; d <= end; d = addDays(d, 1), day++) {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  const weekend = dow === 0 || dow === 6;
  const drift = 1 + day * 0.0009; // supplier prices creep up → moving average moves

  // Weekly replenishment on Mondays (first day too).
  if (dow === 1 || day === 0) {
    const lines = items
      .filter((i) => positionOf(db, i.id, main).qty < 45 || day === 0)
      .map((i) => ({ itemId: i.id, qty: int(20, 50), unitCost: Math.round(i.cost * drift * (0.97 + rnd() * 0.06)) }));
    if (lines.length) {
      attempt(() => postReceipt(db, { docDate: d, warehouseId: main, supplier: pick(suppliers), reference: `PO-${1000 + day}`, lines, postedAt: at(d, 9) }));
    }
    // A mis-keyed receipt that gets corrected the right way: reversal, then re-entry.
    if (!correctionDone && day > 35) {
      const it = items[3];
      let wrong: number | undefined;
      try {
        wrong = postReceipt(db, { docDate: d, warehouseId: main, supplier: "Hario Europe", reference: "PO-TYPO", memo: "Grinders delivery", lines: [{ itemId: it.id, qty: 60, unitCost: it.cost }], postedAt: at(d, 10) }).id;
        posted++;
      } catch { skipped++; }
      if (wrong) {
        attempt(() => reverseJournal(db, { journalId: wrong!, docDate: d, reason: "Quantity keyed as 60 instead of 6", postedAt: at(d, 11) }));
        attempt(() => postReceipt(db, { docDate: d, warehouseId: main, supplier: "Hario Europe", reference: "PO-TYPO", memo: "Grinders delivery (corrected)", lines: [{ itemId: it.id, qty: 6, unitCost: it.cost }], postedAt: at(d, 11) }));
        correctionDone = true;
      }
    }
  }

  // Restock the depot every other Wednesday.
  if (dow === 3 && day % 14 < 7) {
    const lines = items
      .map((i) => ({ itemId: i.id, qty: Math.min(int(6, 14), positionOf(db, i.id, main).qty) }))
      .filter((l) => l.qty > 0)
      .slice(0, 5);
    if (lines.length) attempt(() => postTransfer(db, { docDate: d, fromWarehouseId: main, toWarehouseId: depot, memo: "Depot restock", lines, postedAt: at(d, 12) }));
  }

  // Sales.
  const salesToday = weekend ? int(0, 1) : int(1, 3);
  for (let n = 0; n < salesToday; n++) {
    const wh = rnd() < 0.7 ? main : depot;
    const chosen = [...items].sort(() => rnd() - 0.5).slice(0, int(1, 3));
    const lines = chosen
      .map((i) => ({ itemId: i.id, qty: Math.min(int(1, i.category === "Equipment" ? 2 : 8), positionOf(db, i.id, wh).qty), unitPrice: Math.round(i.price * (0.95 + rnd() * 0.08)) }))
      .filter((l) => l.qty > 0);
    if (!lines.length) continue;
    const customer = pick(customers);
    attempt(() => postSale(db, { docDate: d, warehouseId: wh, customer, paid: customer === "Online shop", reference: `INV-${2000 + posted}`, lines, postedAt: at(d, 13 + n) }));
  }

  // Cash cycle.
  if (day % 9 === 4) {
    const ap = -rawBalance(db, ACC.AP);
    if (ap > 0) attempt(() => postCash(db, { docDate: d, type: "PAY_SUPPLIER", amount: Math.round(ap * 0.75), counterparty: pick(suppliers), memo: "Supplier payment run", postedAt: at(d, 16) }));
    const ar = rawBalance(db, ACC.AR);
    if (ar > 0) attempt(() => postCash(db, { docDate: d, type: "RECEIVE_CUSTOMER", amount: Math.round(ar * 0.8), counterparty: "Customer remittances", memo: "Bank receipts", postedAt: at(d, 16) }));
  }

  // Month-end: rent (entered two days late, so "as known at" reports differ), stock count.
  const tomorrow = addDays(d, 1);
  if (tomorrow.slice(8) === "03" && day > 2) {
    const rentDate = addDays(d, -2);
    attempt(() => postCash(db, { docDate: rentDate, type: "EXPENSE", amount: 250000, counterparty: "Hausverwaltung Mitte", memo: "Warehouse rent (entered late)", postedAt: at(d, 17) }));
  }
  if (d.slice(8) === "27") {
    const it = pick(items);
    if (positionOf(db, it.id, main).qty > 3) {
      attempt(() => postAdjustment(db, { docDate: d, warehouseId: main, memo: "Monthly stock count: damaged", lines: [{ itemId: it.id, qtyDelta: -int(1, 2) }], postedAt: at(d, 18) }));
    }
    attempt(() => postCash(db, { docDate: d, type: "EXPENSE", amount: int(30000, 70000), counterparty: "Various", memo: "Utilities & packaging", postedAt: at(d, 18) }));
  }
}

// Close all completed months except the last one, so closing can be tried in the app.
for (;;) {
  const p = nextClosablePeriod(db);
  if (!p) break;
  const lastCompleted = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  if (p >= lastCompleted) break;
  closePeriod(db, p, "Finance team");
}
audit(db, "seed", "DEMO_DATA_LOADED", `${posted} journals posted, ${skipped} rejected by validation`);

const v = verifyLedger(db);
console.log(`Seeded ${posted} journals (${skipped} rejected by validation) into ${file}`);
console.log(`Integrity: ${v.ok ? "all checks passed" : "FAILED"} · head ${v.head.slice(0, 16)}…`);
if (!v.ok) {
  console.log(v.checks.filter((c) => !c.ok));
  process.exit(1);
}
