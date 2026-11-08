// Builds ~13 months of realistic history for a small coffee wholesaler, through the real posting engine:
// users and roles, customers and suppliers with payment terms, purchase/sales orders, VAT (7% coffee / 19% goods),
// USD supplier invoices settled at a moved rate, invoice-level payments (some customers pay late), monthly VAT
// settlements, a fiscal-year close, budgets, a corrected keying error, planted anomalies and live approval requests.
import fs from "node:fs";
import { DEFAULT_DB_PATH, openDb } from "../lib/db.ts";
import {
  addDaysIso, audit, closePeriod, createContact, createItem, createOrder, createWarehouse, LedgerError, nextClosablePeriod,
  openForeignInvoices, openInvoices, positionOf, postAdjustment, postCash, postReceipt, postSale, postTransfer, reverseJournal,
  setBudget, settleForeignInvoice, today, vatPosition,
} from "../lib/ledger.ts";
import { ACC } from "../lib/accounts.ts";
import { createUser } from "../lib/auth.ts";
import { requestApproval } from "../lib/approvals.ts";
import { verifyLedger } from "../lib/integrity.ts";

const file = process.env.LEDGER_DB ?? DEFAULT_DB_PATH;
for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
const db = openDb(file);

let s = 20261108;
const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

// ── people ──
const PW = process.env.SEED_PASSWORD ?? "demo1234";
const U = {
  lena: createUser(db, { email: "admin@ledgerline.demo", name: "Lena Admin", role: "ADMIN", password: PW }, "seed"),
  anna: createUser(db, { email: "anna@ledgerline.demo", name: "Anna Becker", role: "ACCOUNTANT", password: PW }, "seed"),
  tom: createUser(db, { email: "tom@ledgerline.demo", name: "Tom Krüger", role: "ACCOUNTANT", password: PW }, "seed"),
  wes: createUser(db, { email: "wes@ledgerline.demo", name: "Wes Lager", role: "WAREHOUSE", password: PW }, "seed"),
  vic: createUser(db, { email: "vic@ledgerline.demo", name: "Vic Auditor", role: "VIEWER", password: PW }, "seed"),
};
const userRow = (id: number) => db.prepare("SELECT id, email, name, role, active, created_at, last_login_at FROM users WHERE id = ?").get(id) as never;

// ── master data ──
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

const suppliers = [
  { name: "Rösterei Nord GmbH", terms: 30, email: "buchhaltung@roesterei-nord.example", vat: "DE281734559" },
  { name: "Hario Europe", terms: 30, email: "orders@hario-eu.example", vat: "NL859322471B01" },
  { name: "Filterwerk AG", terms: 14, email: "rechnung@filterwerk.example", vat: "DE193344812" },
].map((x) => ({ ...x, id: createContact(db, { kind: "SUPPLIER", name: x.name, email: x.email, vatId: x.vat, termsDays: x.terms }, "seed") }));
const kalita = createContact(db, { kind: "SUPPLIER", name: "Kalita Trading Co.", email: "export@kalita.example", termsDays: 30, currency: "USD" }, "seed");
// How many days after the due date each customer actually pays (negative = early).
const customers = [
  { name: "Café Kranich", terms: 14, delay: 0 },
  { name: "Büro Lichtblick", terms: 30, delay: 3 },
  { name: "Hotel Spreeblick", terms: 30, delay: 38 },
  { name: "Kiezbäckerei", terms: 14, delay: 12 },
  { name: "Coworking Mitte", terms: 14, delay: -2 },
  { name: "Online shop", terms: 0, delay: 0 },
].map((c) => ({ ...c, id: createContact(db, { kind: "CUSTOMER", name: c.name, email: `${c.name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.de`, termsDays: c.terms }, "seed") }));

// ── timeline ──
const now = new Date();
const end = today();
const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1)).toISOString().slice(0, 10);
const addDays = addDaysIso;
const totalDays = Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
let clock = 0;
const at = (d: string, hour: number) => {
  const t = Math.min(Date.parse(`${d}T${String(hour).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}:00Z`), Date.now() - 60000);
  clock = Math.max(clock + 1000, t);
  return new Date(clock).toISOString();
};
const usdRate = (day: number) => (0.92 + 0.035 * Math.sin(day / 37) + (rnd() - 0.5) * 0.008).toFixed(4);
const BIG = 500000;

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

attempt(() => postCash(db, { docDate: start, type: "CAPITAL", amount: 9000000, counterparty: "Founders", memo: "Initial capital", postedAt: at(start, 8), actorId: U.lena, approvedBy: U.anna }));

let day = 0;
let correctionDone = false;
let poCount = 0;
const planted = { spike: totalDays - 40, below: totalDays - 26, flood: totalDays - 13, dup: totalDays - 7 };

for (let d = start; d <= end; d = addDays(d, 1), day++) {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  const weekend = dow === 0 || dow === 6;
  const drift = 1 + day * 0.0006;
  const season = 1 + 0.18 * Math.sin(((Number(d.slice(5, 7)) - 3) / 12) * 2 * Math.PI);

  // Domestic replenishment on Mondays, placed as a purchase order and received the same week.
  if (dow === 1 || day === 0) {
    const sup = pick(suppliers);
    const lines = domestic
      .filter((i) => positionOf(db, i.id, main).qty < 45 || day === 0)
      .map((i) => ({ itemId: i.id, qty: int(20, 50), unitCost: Math.round(i.cost * drift * (0.97 + rnd() * 0.06)), vatRate: i.vatRate }));
    if (lines.length) {
      const orderDate = addDays(d, -int(3, 6)) < start ? d : addDays(d, -int(3, 6));
      const po = createOrder(db, { kind: "PO", contactId: sup.id, warehouseId: main, orderDate, expectedDate: d, lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitAmount: l.unitCost, vatRate: l.vatRate })), actorId: U.anna }, "seed");
      poCount++;
      const face = lines.reduce((t, l) => t + Math.round(l.qty * l.unitCost * (1 + l.vatRate / 100)), 0);
      attempt(() => postReceipt(db, { docDate: d, warehouseId: main, supplier: "", contactId: sup.id, orderId: po.id, reference: po.number, lines, postedAt: at(d, 9), actorId: U.wes, approvedBy: face >= BIG ? U.anna : undefined }));
    }

    if (!correctionDone && day > 300) {
      const it = items[3];
      const hario = suppliers[1].id;
      const wrong = attempt(() => postReceipt(db, { docDate: d, warehouseId: main, supplier: "", contactId: hario, reference: "PO-TYPO", memo: "Grinders delivery", lines: [{ itemId: it.id, qty: 60, unitCost: it.cost, vatRate: 19 }], postedAt: at(d, 10), actorId: U.wes, approvedBy: U.tom }));
      if (wrong) {
        attempt(() => reverseJournal(db, { journalId: wrong.id, docDate: d, reason: "Quantity keyed as 60 instead of 6", postedAt: at(d, 11), actorId: U.anna }));
        attempt(() => postReceipt(db, { docDate: d, warehouseId: main, supplier: "", contactId: hario, reference: "PO-TYPO", memo: "Grinders delivery (corrected)", lines: [{ itemId: it.id, qty: 6, unitCost: it.cost, vatRate: 19 }], postedAt: at(d, 11), actorId: U.wes }));
        correctionDone = true;
      }
    }
  }

  // Imported goods from Japan, invoiced in USD, roughly every three weeks.
  if (dow === 2 && day % 21 < 7) {
    const rate = usdRate(day);
    const lines = imported.filter((i) => positionOf(db, i.id, main).qty < 60).map((i) => ({ itemId: i.id, qty: int(25, 45), unitCost: Math.round((i.cost * drift) / Number(rate)) }));
    if (lines.length) attempt(() => postReceipt(db, { docDate: d, warehouseId: main, supplier: "", contactId: kalita, reference: `KT-${2000 + day}`, currency: "USD", fxRate: rate, lines, postedAt: at(d, 9), actorId: U.wes }));
  }
  for (const inv of openForeignInvoices(db)) {
    if (addDays(inv.doc_date, 28) <= d) attempt(() => settleForeignInvoice(db, { docDate: d, receiptId: inv.id, fxRate: usdRate(day), postedAt: at(d, 15), actorId: U.anna }));
  }

  if (day === planted.spike) {
    const it = items[2];
    attempt(() => postReceipt(db, { docDate: d, warehouseId: main, supplier: "", contactId: suppliers[0].id, reference: "PO-RUSH", memo: "Rush order, air freight", lines: [{ itemId: it.id, qty: 30, unitCost: Math.round(it.cost * drift * 1.38), vatRate: 7 }], postedAt: at(d, 10), actorId: U.wes }));
  }

  if (dow === 3 && day % 14 < 7) {
    const lines = items.map((i) => ({ itemId: i.id, qty: Math.min(int(6, 14), positionOf(db, i.id, main).qty) })).filter((l) => l.qty > 0).slice(0, 5);
    if (lines.length) attempt(() => postTransfer(db, { docDate: d, fromWarehouseId: main, toWarehouseId: depot, memo: "Depot restock", lines, postedAt: at(d, 12), actorId: U.wes }));
  }

  // Sales, invoiced to customer accounts.
  const salesToday = weekend ? int(0, 1) : Math.round(int(1, 3) * season);
  for (let n = 0; n < salesToday; n++) {
    const wh = rnd() < 0.7 ? main : depot;
    const chosen = [...items].sort(() => rnd() - 0.5).slice(0, int(1, 3));
    const lines = chosen
      .map((i) => ({ itemId: i.id, qty: Math.min(int(1, i.category === "Equipment" ? 2 : 8), positionOf(db, i.id, wh).qty), unitPrice: Math.round(i.price * (0.95 + rnd() * 0.08)), vatRate: i.vatRate }))
      .filter((l) => l.qty > 0);
    if (!lines.length) continue;
    const c = pick(customers);
    attempt(() => postSale(db, { docDate: d, warehouseId: wh, customer: "", contactId: c.id, paid: c.name === "Online shop", reference: `INV-${3000 + posted}`, lines, postedAt: at(d, 13 + n), actorId: U.anna }));
  }
  if (day === planted.below) {
    const it = items[3];
    attempt(() => postSale(db, { docDate: d, warehouseId: main, customer: "", contactId: customers[0].id, reference: "INV-PROMO", memo: "Grinder clearance price", lines: [{ itemId: it.id, qty: 2, unitPrice: 5200, vatRate: 19 }], postedAt: at(d, 16), actorId: U.anna }));
  }
  if (day === planted.dup) {
    for (let k = 0; k < 2; k++) {
      attempt(() => postSale(db, { docDate: d, warehouseId: main, customer: "", contactId: customers[2].id, reference: `INV-HS-${k}`, lines: [{ itemId: items[0].id, qty: 4, unitPrice: 2690, vatRate: 7 }], postedAt: at(d, 17), actorId: U.anna }));
    }
  }

  // Customers pay their invoices (due date + their habitual delay); we pay suppliers on the due date.
  if (!weekend) {
    for (const c of customers) {
      const due = openInvoices(db, { side: "AR", contactId: c.id }).filter((i) => addDays(i.due_date ?? i.doc_date, c.delay) <= d);
      const amount = due.reduce((t, i) => t + i.open, 0);
      if (amount > 0) attempt(() => postCash(db, { docDate: d, type: "RECEIVE_CUSTOMER", amount, counterparty: "", contactId: c.id, invoiceIds: due.map((i) => i.id), memo: "Bank transfer", postedAt: at(d, 10), actorId: U.anna, approvedBy: amount >= BIG ? U.tom : undefined }));
    }
    for (const sup of suppliers) {
      const due = openInvoices(db, { side: "AP", contactId: sup.id }).filter((i) => (i.due_date ?? i.doc_date) <= d);
      const amount = due.reduce((t, i) => t + i.open, 0);
      if (amount > 0) attempt(() => postCash(db, { docDate: d, type: "PAY_SUPPLIER", amount, counterparty: "", contactId: sup.id, invoiceIds: due.map((i) => i.id), memo: "Payment run", postedAt: at(d, 16), actorId: U.anna, approvedBy: amount >= BIG ? U.tom : undefined }));
    }
  }

  if (d.slice(8) === "10" && (vatPosition(db).output || vatPosition(db).input)) {
    attempt(() => postCash(db, { docDate: d, type: "PAY_VAT", amount: 0, counterparty: "Finanzamt Berlin", memo: "Monthly VAT settlement", postedAt: at(d, 10), actorId: U.anna }));
  }

  const tomorrow = addDays(d, 1);
  if (tomorrow.slice(8) === "03" && day > 2) {
    attempt(() => postCash(db, { docDate: addDays(d, -2), type: "EXPENSE", amount: 250000, counterparty: "Hausverwaltung Mitte", memo: "Warehouse rent (entered late)", postedAt: at(d, 17), actorId: U.anna }));
  }
  if (d.slice(8) === "27") {
    const it = pick(items);
    if (positionOf(db, it.id, main).qty > 3) attempt(() => postAdjustment(db, { docDate: d, warehouseId: main, memo: "Monthly stock count: damaged", lines: [{ itemId: it.id, qtyDelta: -int(1, 2) }], postedAt: at(d, 18), actorId: U.wes }));
    attempt(() => postCash(db, { docDate: d, type: "EXPENSE", amount: int(30000, 70000), counterparty: "Stadtwerke Berlin", memo: "Utilities & packaging", postedAt: at(d, 18), actorId: U.anna }));
  }
  if (day === planted.flood) {
    const it = items[3];
    attempt(() => postAdjustment(db, { docDate: d, warehouseId: main, memo: "Water damage in storeroom", lines: [{ itemId: it.id, qtyDelta: -Math.min(6, positionOf(db, it.id, main).qty) }], postedAt: at(d, 18), actorId: U.wes }));
  }
}

// ── open orders at the end of the history ──
const nextWeek = addDays(end, 7);
createOrder(db, { kind: "PO", contactId: suppliers[2].id, warehouseId: main, orderDate: addDays(end, -1), expectedDate: nextWeek, notes: "Filters for Q1", lines: [{ itemId: items[6].id, qty: 120, unitAmount: 225, vatRate: 19 }], actorId: U.anna }, "seed");
const partialPo = createOrder(db, { kind: "PO", contactId: suppliers[1].id, warehouseId: main, orderDate: addDays(end, -6), expectedDate: addDays(end, 3), lines: [{ itemId: items[3].id, qty: 10, unitAmount: 6600, vatRate: 19 }, { itemId: items[7].id, qty: 20, unitAmount: 1750, vatRate: 19 }], actorId: U.anna }, "seed");
attempt(() => postReceipt(db, { docDate: end, warehouseId: main, supplier: "", contactId: suppliers[1].id, orderId: partialPo.id, reference: partialPo.number, memo: "First delivery", lines: [{ itemId: items[7].id, qty: 20, unitCost: 1750, vatRate: 19 }], postedAt: at(end, 11), actorId: U.wes }));
const so = createOrder(db, { kind: "SO", contactId: customers[2].id, warehouseId: main, orderDate: addDays(end, -3), expectedDate: addDays(end, 5), notes: "Hotel breakfast bar refit", lines: [{ itemId: items[0].id, qty: 20, unitAmount: 2590, vatRate: 7 }, { itemId: items[4].id, qty: 6, unitAmount: 4290, vatRate: 19 }], actorId: U.anna }, "seed");
attempt(() => postSale(db, { docDate: end, warehouseId: main, customer: "", contactId: customers[2].id, orderId: so.id, reference: so.number, lines: [{ itemId: items[4].id, qty: 6, unitPrice: 4290, vatRate: 19 }], postedAt: at(end, 12), actorId: U.anna }));

// ── close completed months (four-eyes: requested by Anna, approved by Tom) except the last one ──
const lastCompleted = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
for (;;) {
  const p = nextClosablePeriod(db);
  if (!p || p >= lastCompleted) break;
  closePeriod(db, p, "Anna Becker (approved by Tom Krüger)");
}

// ── live approval requests to try in the app ──
requestApproval(db, userRow(U.anna), "PERIOD_CLOSE", `Close ${lastCompleted}`, 0, { period: lastCompleted });
const bigSale = {
  kind: "SALE", docDate: end, warehouseId: main, counterparty: "Coworking Mitte", contactId: customers[4].id, paid: false,
  reference: "INV-CW-FITOUT", memo: "New coffee bar fit-out", idempotencyKey: "seed-big-sale",
  lines: [{ itemId: items[3].id, qty: 4, amount: 11500, vatRate: 19 }, { itemId: items[0].id, qty: 40, amount: 2590, vatRate: 7 }],
};
requestApproval(db, userRow(U.anna), "POSTING", `Sale €6,584.12 · Coworking Mitte (dated ${end})`, 658412, bigSale);

// ── budgets ──
for (const y of [...new Set([start.slice(0, 4), end.slice(0, 4)])]) {
  const entries: { period: string; account: string; amount: number }[] = [];
  for (let m = 1; m <= 12; m++) {
    const period = `${y}-${String(m).padStart(2, "0")}`;
    const rev = Math.round((880000 * (1 + 0.18 * Math.sin(((m - 3) / 12) * 2 * Math.PI))) / 1000) * 1000;
    entries.push({ period, account: ACC.REVENUE, amount: rev }, { period, account: ACC.COGS, amount: Math.round(rev * 0.54) }, { period, account: ACC.OPEX, amount: 300000 });
  }
  setBudget(db, entries, "anna@ledgerline.demo");
}

audit(db, "seed", "DEMO_DATA_LOADED", `${posted} journals posted, ${skipped} rejected by validation, ${poCount} purchase orders`);

const v = verifyLedger(db);
console.log(`Seeded ${posted} journals (${skipped} rejected by validation), ${poCount + 3} orders, 5 users from ${start} into ${file}`);
console.log(`Sign in with admin@ledgerline.demo / ${PW} (or anna, tom, wes, vic @ledgerline.demo)`);
console.log(`Integrity: ${v.ok ? "all checks passed" : "FAILED"} · head ${v.head.slice(0, 16)}…`);
if (!v.ok) {
  console.log(v.checks.filter((c) => !c.ok));
  process.exit(1);
}
