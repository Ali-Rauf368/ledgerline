#!/bin/sh
set -e
DB="${LEDGER_DB:-/app/data/ledger.db}"
if [ ! -f "$DB" ]; then
  if [ "${LEDGERLINE_DEMO:-1}" = "1" ]; then
    echo "No database at $DB, so seeding demo data (set LEDGERLINE_DEMO=0 to skip)…"
    node --no-warnings=ExperimentalWarning scripts/seed.ts
  else
    echo "No database at $DB; starting empty. Create the first admin with: docker compose exec app node scripts/create-admin.ts"
  fi
fi
exec node server.js
