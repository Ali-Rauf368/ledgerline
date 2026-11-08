/**
 * Users, sessions and role-based permissions.
 * Passwords: scrypt with a per-user salt. Sessions: 256-bit random tokens; only their SHA-256 is stored,
 * so a database leak does not leak usable sessions.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";
import { all, get, run } from "./db.ts";
import { audit, LedgerError, sha256 } from "./ledger.ts";

export type Role = "ADMIN" | "ACCOUNTANT" | "WAREHOUSE" | "VIEWER";
export type User = { id: number; email: string; name: string; role: Role; active: number; created_at: string; last_login_at: string | null };

export type Permission =
  | "post:RECEIPT" | "post:SALE" | "post:TRANSFER" | "post:ADJUSTMENT" | "post:PAYMENT"
  | "reverse" | "approve" | "period:close" | "budget:edit" | "contacts:edit" | "orders:edit"
  | "bank:reconcile" | "users:manage" | "ai:commentary";

const ALL: Permission[] = [
  "post:RECEIPT", "post:SALE", "post:TRANSFER", "post:ADJUSTMENT", "post:PAYMENT", "reverse", "approve", "period:close",
  "budget:edit", "contacts:edit", "orders:edit", "bank:reconcile", "users:manage", "ai:commentary",
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: ALL,
  ACCOUNTANT: ALL.filter((p) => p !== "users:manage"),
  WAREHOUSE: ["post:RECEIPT", "post:TRANSFER", "post:ADJUSTMENT", "orders:edit"],
  VIEWER: [],
};

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Administrator",
  ACCOUNTANT: "Accountant",
  WAREHOUSE: "Warehouse",
  VIEWER: "Viewer",
};

export const can = (u: Pick<User, "role"> | null | undefined, p: Permission) => !!u && ROLE_PERMISSIONS[u.role].includes(p);

export class AuthError extends LedgerError {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function requirePermission(u: User | null, p: Permission): User {
  if (!u) throw new AuthError("Please sign in again.");
  if (!can(u, p)) throw new AuthError(`Your role (${ROLE_LABEL[u.role]}) isn't allowed to do this.`);
  return u;
}

// ───────────────────────── passwords ─────────────────────────

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string) {
  const [alg, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

function checkPasswordStrength(pw: string) {
  if (pw.length < 8) throw new LedgerError("Passwords need at least 8 characters.");
}

// ───────────────────────── users ─────────────────────────

const USER_COLS = "id, email, name, role, active, created_at, last_login_at";

export function createUser(db: DB, u: { email: string; name: string; role: Role; password: string }, actor = "system") {
  const email = u.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new LedgerError("Enter a valid email address.");
  if (!u.name.trim()) throw new LedgerError("Enter a name.");
  if (!(u.role in ROLE_PERMISSIONS)) throw new LedgerError("Unknown role.");
  checkPasswordStrength(u.password);
  if (get(db, "SELECT id FROM users WHERE email = ?", email)) throw new LedgerError(`${email} already has an account.`);
  const r = run(
    db,
    "INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    email, u.name.trim(), u.role, hashPassword(u.password), new Date().toISOString(),
  );
  audit(db, actor, "USER_CREATED", `${email} as ${ROLE_LABEL[u.role]}`);
  return Number(r.lastInsertRowid);
}

export const listUsers = (db: DB) => all<User>(db, `SELECT ${USER_COLS} FROM users ORDER BY active DESC, name`);
export const userById = (db: DB, id: number) => get<User>(db, `SELECT ${USER_COLS} FROM users WHERE id = ?`, id) ?? null;

export function updateUser(db: DB, by: User, id: number, patch: { role?: Role; active?: boolean; password?: string }) {
  const target = userById(db, id);
  if (!target) throw new LedgerError("Unknown user.");
  const admins = () => get<{ n: number }>(db, "SELECT COUNT(*) n FROM users WHERE role = 'ADMIN' AND active = 1")!.n;
  if (patch.role && patch.role !== target.role) {
    if (target.role === "ADMIN" && admins() === 1) throw new LedgerError("There must always be at least one active administrator.");
    run(db, "UPDATE users SET role = ? WHERE id = ?", patch.role, id);
    audit(db, by.email, "USER_ROLE_CHANGED", `${target.email}: ${ROLE_LABEL[target.role]} → ${ROLE_LABEL[patch.role]}`);
  }
  if (patch.active !== undefined && Boolean(target.active) !== patch.active) {
    if (!patch.active && target.id === by.id) throw new LedgerError("You can't deactivate your own account.");
    if (!patch.active && target.role === "ADMIN" && admins() === 1) throw new LedgerError("There must always be at least one active administrator.");
    run(db, "UPDATE users SET active = ? WHERE id = ?", patch.active ? 1 : 0, id);
    if (!patch.active) run(db, "DELETE FROM sessions WHERE user_id = ?", id);
    audit(db, by.email, patch.active ? "USER_REACTIVATED" : "USER_DEACTIVATED", target.email);
  }
  if (patch.password) {
    checkPasswordStrength(patch.password);
    run(db, "UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(patch.password), id);
    run(db, "DELETE FROM sessions WHERE user_id = ?", id);
    audit(db, by.email, "USER_PASSWORD_RESET", target.email);
  }
}

// ───────────────────────── sessions ─────────────────────────

export const SESSION_COOKIE = "ll_session";
export const SESSION_DAYS = 7;

// Simple in-process throttle: 5 failed attempts per email per 10 minutes.
const failures = new Map<string, number[]>();

export function login(db: DB, email: string, password: string, userAgent = "") {
  const key = email.trim().toLowerCase();
  const now = Date.now();
  const recent = (failures.get(key) ?? []).filter((t) => now - t < 10 * 60_000);
  if (recent.length >= 5) throw new AuthError("Too many failed attempts. Try again in a few minutes.");
  const row = get<User & { password_hash: string }>(db, `SELECT ${USER_COLS}, password_hash FROM users WHERE email = ?`, key);
  // Always run scrypt so response time doesn't reveal whether the email exists.
  const ok = verifyPassword(password, row?.password_hash ?? hashPassword("timing-equaliser"));
  if (!row || !ok || !row.active) {
    failures.set(key, [...recent, now]);
    audit(db, key || "unknown", "LOGIN_FAILED", row && !row.active ? "account deactivated" : "wrong email or password");
    throw new AuthError("Wrong email or password.");
  }
  failures.delete(key);
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(now + SESSION_DAYS * 86400000).toISOString();
  run(db, "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)", sha256(token), row.id, new Date(now).toISOString(), expires, userAgent.slice(0, 200));
  run(db, "UPDATE users SET last_login_at = ? WHERE id = ?", new Date(now).toISOString(), row.id);
  run(db, "DELETE FROM sessions WHERE expires_at < ?", new Date(now).toISOString());
  audit(db, row.email, "LOGIN", userAgent.slice(0, 80));
  return { token, expires };
}

export function userForToken(db: DB, token: string | undefined): User | null {
  if (!token) return null;
  const u = get<User & { expires_at: string }>(
    db,
    `SELECT u.id, u.email, u.name, u.role, u.active, u.created_at, u.last_login_at, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    sha256(token),
  );
  if (!u || !u.active || u.expires_at < new Date().toISOString()) return null;
  const { expires_at: _, ...user } = u;
  return user;
}

export function logout(db: DB, token: string | undefined) {
  if (token) run(db, "DELETE FROM sessions WHERE token_hash = ?", sha256(token));
}
