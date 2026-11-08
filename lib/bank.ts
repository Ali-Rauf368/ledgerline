/**
 * Bank reconciliation. Statements are imported once (content-hashed) and never changed; matches are an
 * append-only event log (MATCH / UNMATCH), so who reconciled what, when and how is always reconstructable.
 */
import type { DB } from "./db.ts";
import { all, get, run } from "./db.ts";
import { ACC } from "./accounts.ts";
import type { CashType } from "./ledger.ts";
import { audit, LedgerError, lockedThrough, postCash, sha256 } from "./ledger.ts";

export type BankLine = { id: number; statement_id: number; date: string; description: string; reference: string; amount: number };
export type CashEntry = { id: number; doc_date: string; amount: number; counterparty: string; memo: string; reference: string; kind: string };
export type MatchState = { journal_id: number; method: string; score: number | null; at: string; by_name: string | null };

// ───────────────────────── CSV parsing ─────────────────────────

function splitCsvLine(line: string, sep: string) {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** "1.234,56" · "1,234.56" · "-12,5" · "1234.5" → cents */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[€\s]/g, "").replace(/^\+/, "");
  if (!s) return null;
  const neg = s.startsWith("-") || (s.startsWith("(") && s.endsWith(")"));
  s = s.replace(/[-()]/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const cents = Number(w) * 100 + Number(f.padEnd(2, "0"));
  return neg ? -cents : cents;
}

export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

const HEADERS: Record<string, string[]> = {
  date: ["date", "datum", "buchungstag", "booking date", "valuta", "wertstellung", "transaction date"],
  description: ["description", "verwendungszweck", "text", "payee", "beguenstigter/zahlungspflichtiger", "name", "details", "buchungstext"],
  reference: ["reference", "referenz", "ref", "mandatsreferenz", "kundenreferenz"],
  amount: ["amount", "betrag", "umsatz", "value"],
  balance: ["balance", "saldo", "kontostand"],
};

export function parseStatementCsv(text: string) {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (rows.length < 2) throw new LedgerError("The file has no transactions.");
  const sep = (rows[0].match(/;/g)?.length ?? 0) > (rows[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const header = splitCsvLine(rows[0], sep).map((h) => h.toLowerCase());
  const col = (k: string) => header.findIndex((h) => HEADERS[k].some((x) => h === x || h.includes(x)));
  const idx = { date: col("date"), description: col("description"), reference: col("reference"), amount: col("amount"), balance: col("balance") };
  if (idx.date < 0 || idx.amount < 0) throw new LedgerError('The CSV needs at least a "Date" and an "Amount" column (German bank exports with Buchungstag/Betrag work too).');
  const lines: { date: string; description: string; reference: string; amount: number }[] = [];
  let closing: number | null = null;
  rows.slice(1).forEach((r, n) => {
    const c = splitCsvLine(r, sep);
    const date = parseDate(c[idx.date] ?? "");
    const amount = parseAmount(c[idx.amount] ?? "");
    if (!date || amount === null) throw new LedgerError(`Row ${n + 2}: couldn't read the date or amount.`);
    if (amount === 0) return;
    lines.push({ date, amount, description: idx.description >= 0 ? (c[idx.description] ?? "") : "", reference: idx.reference >= 0 ? (c[idx.reference] ?? "") : "" });
    if (idx.balance >= 0) {
      const b = parseAmount(c[idx.balance] ?? "");
      if (b !== null) closing = b;
    }
  });
  if (!lines.length) throw new LedgerError("The file has no transactions.");
  lines.sort((a, b) => a.date.localeCompare(b.date));
  return { lines, closingBalance: closing as number | null };
}

// ───────────────────────── ledger side ─────────────────────────

export function cashEntries(db: DB, from: string, to: string): CashEntry[] {
  return all<CashEntry>(
    db,
    `SELECT j.id, j.doc_date, j.counterparty, j.memo, j.reference, j.kind, SUM(l.debit - l.credit) amount
     FROM journals j JOIN journal_lines l ON l.journal_id = j.id AND l.account_code = ?
     WHERE j.doc_date BETWEEN ? AND ? GROUP BY j.id HAVING amount <> 0 ORDER BY j.doc_date, j.id`,
    ACC.CASH,
    from,
    to,
  );
}

export function matchStates(db: DB) {
  const rows = all<{ bank_line_id: number; journal_id: number | null; action: string; method: string; score: number | null; at: string; by_name: string | null }>(
    db,
    `SELECT e.bank_line_id, e.journal_id, e.action, e.method, e.score, e.at, u.name by_name FROM bank_match_events e LEFT JOIN users u ON u.id = e.by_user
     WHERE e.id IN (SELECT MAX(id) FROM bank_match_events GROUP BY bank_line_id)`,
  );
  const byLine = new Map<number, MatchState>();
  for (const r of rows) if (r.action === "MATCH" && r.journal_id) byLine.set(r.bank_line_id, { journal_id: r.journal_id, method: r.method, score: r.score, at: r.at, by_name: r.by_name });
  const byJournal = new Map<number, number>();
  for (const [line, m] of byLine) byJournal.set(m.journal_id, line);
  return { byLine, byJournal };
}

// ───────────────────────── matching ─────────────────────────

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !["gmbh", "und", "the", "sepa", "eur", "ueberweisung", "lastschrift", "gutschrift"].includes(t)),
  );

function textScore(line: BankLine, e: CashEntry) {
  const a = tokens(`${line.description} ${line.reference}`);
  const b = tokens(`${e.counterparty} ${e.memo} ${e.reference} ${e.id}`);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  const ref = e.reference && `${line.description} ${line.reference}`.toLowerCase().includes(e.reference.toLowerCase()) ? 0.5 : 0;
  return Math.min(1, hit / Math.min(a.size, b.size) + ref);
}

const dayGap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

/** Candidates: same exact amount, within ±7 days, not already matched. Score = date proximity + text similarity. */
export function candidatesFor(db: DB, line: BankLine, taken?: Set<number>) {
  const from = new Date(Date.parse(line.date) - 7 * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(line.date) + 7 * 86400000).toISOString().slice(0, 10);
  const matched = taken ?? new Set(matchStates(db).byJournal.keys());
  return cashEntries(db, from, to)
    .filter((e) => e.amount === line.amount && !matched.has(e.id))
    .map((e) => ({ entry: e, score: Number((0.6 * (1 - dayGap(line.date, e.doc_date) / 8) + 0.4 * textScore(line, e)).toFixed(3)) }))
    .sort((a, b) => b.score - a.score);
}

function matchEvent(db: DB, lineId: number, journalId: number | null, action: "MATCH" | "UNMATCH", method: string, score: number | null, userId: number | null) {
  run(db, "INSERT INTO bank_match_events (bank_line_id, journal_id, action, method, score, by_user, at) VALUES (?, ?, ?, ?, ?, ?, ?)", lineId, journalId, action, method, score, userId, new Date().toISOString());
}

/** Greedy best-first matching across all unmatched lines; accepts only confident, unambiguous pairs. */
export function autoMatch(db: DB, userId: number | null, statementId?: number) {
  const { byLine, byJournal } = matchStates(db);
  const taken = new Set(byJournal.keys());
  const lines = all<BankLine>(db, `SELECT * FROM bank_lines ${statementId ? "WHERE statement_id = ?" : ""} ORDER BY date, id`, ...(statementId ? [statementId] : [])).filter((l) => !byLine.has(l.id));
  const proposals = lines
    .map((l) => ({ line: l, cands: candidatesFor(db, l, taken) }))
    .filter((p) => p.cands.length && p.cands[0].score >= 0.55 && (p.cands.length === 1 || p.cands[0].score - p.cands[1].score >= 0.1))
    .sort((a, b) => b.cands[0].score - a.cands[0].score);
  let n = 0;
  for (const p of proposals) {
    const best = p.cands.find((c) => !taken.has(c.entry.id));
    if (!best || best.score < 0.55) continue;
    matchEvent(db, p.line.id, best.entry.id, "MATCH", "AUTO", best.score, userId);
    taken.add(best.entry.id);
    n++;
  }
  return n;
}

export function matchLine(db: DB, userId: number, actor: string, lineId: number, journalId: number, method: "MANUAL" | "AI" = "MANUAL") {
  const line = get<BankLine>(db, "SELECT * FROM bank_lines WHERE id = ?", lineId);
  if (!line) throw new LedgerError("Unknown bank line.");
  const { byLine, byJournal } = matchStates(db);
  if (byLine.has(lineId)) throw new LedgerError("This bank line is already matched. Unmatch it first.");
  if (byJournal.has(journalId)) throw new LedgerError(`Journal #${journalId} is already matched to another bank line.`);
  const e = cashEntries(db, "0000-01-01", "9999-12-31").find((x) => x.id === journalId);
  if (!e) throw new LedgerError(`Journal #${journalId} doesn't move cash.`);
  if (e.amount !== line.amount) throw new LedgerError(`Amounts differ: bank ${(line.amount / 100).toFixed(2)} vs ledger ${(e.amount / 100).toFixed(2)}.`);
  matchEvent(db, lineId, journalId, "MATCH", method, null, userId);
  audit(db, actor, "BANK_MATCHED", `line ${lineId} ↔ #${journalId}`);
}

export function unmatchLine(db: DB, userId: number, actor: string, lineId: number) {
  const m = matchStates(db).byLine.get(lineId);
  if (!m) throw new LedgerError("This bank line isn't matched.");
  matchEvent(db, lineId, null, "UNMATCH", "MANUAL", null, userId);
  audit(db, actor, "BANK_UNMATCHED", `line ${lineId} ↮ #${m.journal_id}`);
}

/** Book a bank line that has no ledger entry yet (fees, interest, an unannounced customer payment), then match it. */
export function createFromLine(
  db: DB,
  user: { id: number; email: string },
  lineId: number,
  o: { type: CashType; contactId?: number; counterparty?: string },
) {
  const line = get<BankLine>(db, "SELECT * FROM bank_lines WHERE id = ?", lineId);
  if (!line) throw new LedgerError("Unknown bank line.");
  if (matchStates(db).byLine.has(lineId)) throw new LedgerError("Already matched.");
  const inflow = line.amount > 0;
  const allowed: CashType[] = inflow ? ["RECEIVE_CUSTOMER", "CAPITAL"] : ["EXPENSE", "PAY_SUPPLIER"];
  if (!allowed.includes(o.type)) throw new LedgerError(`A ${inflow ? "receipt" : "payment"} can't be booked as ${o.type.toLowerCase().replace("_", " ")}.`);
  const lock = lockedThrough(db);
  if (lock && line.date.slice(0, 7) <= lock) throw new LedgerError(`${line.date} is in a closed period. Book it manually in an open month, then match it.`);
  const j = postCash(db, {
    docDate: line.date,
    type: o.type,
    amount: Math.abs(line.amount),
    counterparty: o.counterparty ?? line.description.slice(0, 60),
    memo: `Bank: ${line.description}`.slice(0, 120),
    reference: line.reference,
    contactId: o.contactId,
    actorId: user.id,
    idempotencyKey: `bank-line-${lineId}`,
  });
  matchEvent(db, lineId, j.id, "MATCH", "CREATED", 1, user.id);
  audit(db, user.email, "BANK_BOOKED", `line ${lineId} → #${j.id}`);
  return j.id;
}

// ───────────────────────── statements ─────────────────────────

export function importStatement(db: DB, user: { id: number; email: string }, filename: string, text: string) {
  const parsed = parseStatementCsv(text);
  const hash = sha256(text.replace(/\r\n/g, "\n").trim());
  const dupe = get<{ id: number; filename: string }>(db, "SELECT id, filename FROM bank_statements WHERE content_hash = ?", hash);
  if (dupe) throw new LedgerError(`This statement was already imported (as "${dupe.filename}").`);
  const from = parsed.lines[0].date;
  const to = parsed.lines[parsed.lines.length - 1].date;
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = run(
      db,
      "INSERT INTO bank_statements (filename, content_hash, period_from, period_to, closing_balance, imported_by, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      filename.slice(0, 120), hash, from, to, parsed.closingBalance, user.id, new Date().toISOString(),
    );
    const id = Number(r.lastInsertRowid);
    for (const l of parsed.lines) run(db, "INSERT INTO bank_lines (statement_id, date, description, reference, amount) VALUES (?, ?, ?, ?, ?)", id, l.date, l.description.slice(0, 200), l.reference.slice(0, 80), l.amount);
    const matched = autoMatch(db, user.id, id);
    audit(db, user.email, "BANK_IMPORTED", `${filename}: ${parsed.lines.length} lines, ${matched} auto-matched`);
    db.exec("COMMIT");
    return { id, lines: parsed.lines.length, matched };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const statements = (db: DB) =>
  all<{ id: number; filename: string; period_from: string; period_to: string; closing_balance: number | null; imported_at: string; importer: string | null; lines: number }>(
    db,
    `SELECT s.*, u.name importer, (SELECT COUNT(*) FROM bank_lines WHERE statement_id = s.id) lines
     FROM bank_statements s LEFT JOIN users u ON u.id = s.imported_by ORDER BY s.id DESC`,
  );

/**
 * Reconciliation for a statement:
 *   bank closing balance  =  ledger cash at period end  −  ledger cash entries not yet on the bank (in transit)
 *                                                      +  bank lines not yet in the ledger
 * A zero difference proves the books and the bank agree.
 */
export function reconciliation(db: DB, statementId: number) {
  const st = get<{ id: number; period_from: string; period_to: string; closing_balance: number | null }>(db, "SELECT * FROM bank_statements WHERE id = ?", statementId);
  if (!st) throw new LedgerError("Unknown statement.");
  const lines = all<BankLine>(db, "SELECT * FROM bank_lines WHERE statement_id = ? ORDER BY date, id", statementId);
  const { byLine, byJournal } = matchStates(db);
  const entries = cashEntries(db, st.period_from, st.period_to);
  const ledgerCash = get<{ b: number }>(
    db,
    "SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM journal_lines l JOIN journals j ON j.id = l.journal_id WHERE l.account_code = ? AND j.doc_date <= ?",
    ACC.CASH,
    st.period_to,
  )!.b;
  const unmatchedBank = lines.filter((l) => !byLine.has(l.id));
  const inTransit = entries.filter((e) => !byJournal.has(e.id));
  const adjusted = ledgerCash - inTransit.reduce((t, e) => t + e.amount, 0) + unmatchedBank.reduce((t, l) => t + l.amount, 0);
  return {
    statement: st,
    lines: lines.map((l) => ({ ...l, match: byLine.get(l.id) ?? null })),
    inTransit,
    ledgerCash,
    adjusted,
    bankClosing: st.closing_balance,
    difference: st.closing_balance === null ? null : st.closing_balance - adjusted,
    matchedCount: lines.length - unmatchedBank.length,
  };
}

// ───────────────────────── suggestions & demo data ─────────────────────────

export type LineSuggestion = { type: CashType; contactId?: number; label: string; confidence: number; reason: string };

/** Deterministic suggestion for an unmatched line: keywords and fuzzy contact-name matching. */
export function suggestForLine(db: DB, line: BankLine): LineSuggestion | null {
  const text = `${line.description} ${line.reference}`.toLowerCase();
  const contacts = all<{ id: number; kind: string; name: string }>(db, "SELECT id, kind, name FROM contacts");
  const want = line.amount > 0 ? "CUSTOMER" : "SUPPLIER";
  const words = tokens(text);
  const contact = contacts
    .filter((c) => c.kind === want)
    .map((c) => {
      const t = tokens(c.name);
      let hit = 0;
      for (const x of t) if (words.has(x)) hit++;
      return { c, s: t.size ? hit / t.size : 0 };
    })
    .sort((a, b) => b.s - a.s)[0];
  if (contact && contact.s >= 0.5) {
    return line.amount > 0
      ? { type: "RECEIVE_CUSTOMER", contactId: contact.c.id, label: `Payment from ${contact.c.name}`, confidence: contact.s, reason: `Description mentions "${contact.c.name}".` }
      : { type: "PAY_SUPPLIER", contactId: contact.c.id, label: `Payment to ${contact.c.name}`, confidence: contact.s, reason: `Description mentions "${contact.c.name}".` };
  }
  if (line.amount < 0 && /(geb(ü|ue)hr|entgelt|kontof(ü|ue)hrung|fee|charge|porto)/.test(text)) {
    return { type: "EXPENSE", label: "Bank fee → operating expenses", confidence: 0.9, reason: "Looks like a bank or account fee." };
  }
  if (line.amount > 0 && /(zins|interest)/.test(text)) {
    return { type: "CAPITAL", label: "Interest income (book as other income manually)", confidence: 0.4, reason: "Looks like interest; no income account exists for it yet." };
  }
  if (line.amount < 0) return { type: "EXPENSE", label: "Operating expense", confidence: 0.3, reason: "Outgoing payment with no matching supplier." };
  return null;
}

/**
 * A realistic demo statement for a date range, built from the ledger's own cash movements with bank-style
 * descriptions, 0–2 day value-date shifts, two items still in transit, a fee, and an unannounced customer payment.
 */
export function sampleStatementCsv(db: DB, from: string, to: string) {
  const entries = cashEntries(db, from, to);
  const opening = get<{ b: number }>(
    db,
    "SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM journal_lines l JOIN journals j ON j.id = l.journal_id WHERE l.account_code = ? AND j.doc_date < ?",
    ACC.CASH,
    from,
  )!.b;
  const shift = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
  const rows: { date: string; text: string; ref: string; amount: number }[] = [];
  const transit = new Set(entries.slice(-2).map((e) => e.id));
  for (const e of entries) {
    if (transit.has(e.id)) continue;
    const who = (e.counterparty || e.memo || "Transfer").toUpperCase();
    const text = e.amount > 0 ? `GUTSCHRIFT ${who}` : `${e.kind === "PAYMENT" && e.memo.includes("VAT") ? "FINANZAMT USt" : "UEBERWEISUNG"} ${who}`;
    rows.push({ date: to < shift(e.doc_date, e.id % 3) ? e.doc_date : shift(e.doc_date, e.id % 3), text, ref: e.reference || `#${e.id}`, amount: e.amount });
  }
  const mid = shift(from, 14) <= to ? shift(from, 14) : to;
  rows.push({ date: to, text: "KONTOFUEHRUNG ENTGELT", ref: "", amount: -490 });
  const customer = get<{ name: string }>(db, "SELECT name FROM contacts WHERE kind = 'CUSTOMER' ORDER BY id LIMIT 1");
  if (customer) rows.push({ date: mid, text: `GUTSCHRIFT ${customer.name.toUpperCase()} RECHNUNG`, ref: "RE-PAYMENT", amount: 15000 });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  let bal = opening;
  const q = (s: string) => (/[;"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  const out = ["Buchungstag;Verwendungszweck;Referenz;Betrag;Saldo"];
  for (const r of rows) {
    bal += r.amount;
    const fmt = (c: number) => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100).toLocaleString("de-DE")},${String(Math.abs(c) % 100).padStart(2, "0")}`;
    out.push([r.date.split("-").reverse().join("."), q(r.text), q(r.ref), fmt(r.amount), fmt(bal)].join(";"));
  }
  return out.join("\r\n");
}
