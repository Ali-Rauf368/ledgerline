import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { ACCOUNTS } from "./accounts.ts";

export type DB = DatabaseSync;
type Param = string | number | null;

// node:sqlite returns null-prototype rows; spread them into plain objects so they serialize everywhere.
export const all = <T>(db: DB, sql: string, ...p: Param[]) => db.prepare(sql).all(...p).map((r) => ({ ...r })) as unknown as T[];
export const get = <T>(db: DB, sql: string, ...p: Param[]) => {
  const r = db.prepare(sql).get(...p);
  return (r ? { ...r } : undefined) as unknown as T | undefined;
};
export const run = (db: DB, sql: string, ...p: Param[]) => db.prepare(sql).run(...p);

/** Tables that may only ever grow. Enforced by the database itself, not just the app. */
export const APPEND_ONLY_TABLES = ["journals", "journal_lines", "stock_moves", "period_closes", "audit_events", "budget_entries", "commentaries"];

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE'))
);
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  category TEXT NOT NULL DEFAULT 'General',
  vat_rate INTEGER NOT NULL DEFAULT 19 CHECK (vat_rate IN (0, 7, 19)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS journals (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('RECEIPT','SALE','TRANSFER','ADJUSTMENT','PAYMENT','REVERSAL','CLOSING')),
  doc_date TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  counterparty TEXT NOT NULL DEFAULT '',
  reverses_id INTEGER UNIQUE REFERENCES journals(id),
  idempotency_key TEXT UNIQUE,
  currency TEXT,
  fx_rate TEXT,
  foreign_amount INTEGER,
  settles_id INTEGER REFERENCES journals(id),
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  CHECK ((currency IS NULL) = (fx_rate IS NULL) AND (currency IS NULL) = (foreign_amount IS NULL))
);
CREATE INDEX IF NOT EXISTS ix_journals_date ON journals(doc_date);
CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY,
  journal_id INTEGER NOT NULL REFERENCES journals(id),
  account_code TEXT NOT NULL REFERENCES accounts(code),
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  CHECK (debit >= 0 AND credit >= 0 AND ((debit = 0) <> (credit = 0)))
);
CREATE INDEX IF NOT EXISTS ix_lines_journal ON journal_lines(journal_id);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY,
  journal_id INTEGER NOT NULL REFERENCES journals(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  doc_date TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty <> 0),
  value INTEGER NOT NULL,
  qty_after INTEGER NOT NULL CHECK (qty_after >= 0),
  value_after INTEGER NOT NULL CHECK (value_after >= 0),
  CHECK (qty_after > 0 OR value_after = 0)
);
CREATE INDEX IF NOT EXISTS ix_moves_position ON stock_moves(item_id, warehouse_id, id);
CREATE INDEX IF NOT EXISTS ix_moves_journal ON stock_moves(journal_id);
CREATE TABLE IF NOT EXISTS period_closes (
  period TEXT PRIMARY KEY,
  closed_at TEXT NOT NULL,
  closed_by TEXT NOT NULL,
  last_journal_id INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_entries (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_budget ON budget_entries(period, account_code, id);
CREATE TABLE IF NOT EXISTS commentaries (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  text TEXT NOT NULL,
  data_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journals'").get();
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (existing && version < SCHEMA_VERSION) {
    throw new Error(`The database at ${file} uses an older schema (v${version}). Run "npm run seed" to rebuild it with the v${SCHEMA_VERSION} schema.`);
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  for (const t of APPEND_ONLY_TABLES) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t}
      BEGIN SELECT RAISE(ABORT, 'append-only ledger: ${t} rows cannot be updated'); END;
      CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t}
      BEGIN SELECT RAISE(ABORT, 'append-only ledger: ${t} rows cannot be deleted'); END;
    `);
  }
  const ins = db.prepare("INSERT OR IGNORE INTO accounts (code, name, type) VALUES (?, ?, ?)");
  for (const a of ACCOUNTS) ins.run(a.code, a.name, a.type);
  return db;
}

export const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "ledger.db");

const g = globalThis as unknown as { __ledgerDb?: DB };

/** Process-wide connection (survives Next.js hot reloads). */
export function getDb(): DB {
  g.__ledgerDb ??= openDb(process.env.LEDGER_DB ?? DEFAULT_DB_PATH);
  return g.__ledgerDb;
}
