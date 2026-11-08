// Usage: node scripts/create-admin.ts <email> <name> <password>
import { DEFAULT_DB_PATH, openDb } from "../lib/db.ts";
import { createUser } from "../lib/auth.ts";

const [email, name, password] = process.argv.slice(2);
if (!email || !name || !password) {
  console.error("Usage: node scripts/create-admin.ts <email> <name> <password>");
  process.exit(1);
}
const db = openDb(process.env.LEDGER_DB ?? DEFAULT_DB_PATH);
const id = createUser(db, { email, name, role: "ADMIN", password }, "cli");
console.log(`Created administrator #${id} (${email}).`);
