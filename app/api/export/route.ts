import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { today } from "@/lib/ledger";
import { balanceSheet, incomeStatement, inventoryValuation, journalsList, trialBalance } from "@/lib/reports";

export const dynamic = "force-dynamic";

const cents = (c: number) => (c / 100).toFixed(2);
const cell = (v: string | number) => {
  const s = String(v);
  // Quote, and neutralise spreadsheet formula injection.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};
const isDate = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET(req: Request) {
  if (!(await currentUser())) return new Response("Sign in required", { status: 401 });
  const url = new URL(req.url);
  const report = url.searchParams.get("report") ?? "tb";
  const asOf = isDate(url.searchParams.get("asOf")) ? url.searchParams.get("asOf")! : today();
  const from = isDate(url.searchParams.get("from")) ? url.searchParams.get("from")! : `${asOf.slice(0, 7)}-01`;
  const k = url.searchParams.get("knownAt");
  const knownAt = k && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(k) ? `${k}:59.999Z` : undefined;
  const db = getDb();
  let rows: (string | number)[][];

  switch (report) {
    case "pl": {
      const r = incomeStatement(db, { from, asOf, knownAt });
      rows = [["Section", "Account", "Name", "Amount EUR"]];
      for (const [sec, xs] of [["Revenue", r.revenue], ["Cost of sales", r.costOfSales], ["Operating expenses", r.opex]] as const)
        for (const x of xs) rows.push([sec, x.code, x.name, cents(x.balance)]);
      rows.push(["Total", "", "Gross profit", cents(r.grossProfit)], ["Total", "", "Net income", cents(r.netIncome)]);
      break;
    }
    case "bs": {
      const r = balanceSheet(db, { asOf, knownAt });
      rows = [["Section", "Account", "Name", "Amount EUR"]];
      for (const [sec, xs] of [["Assets", r.assets], ["Liabilities", r.liabilities], ["Equity", r.equity]] as const)
        for (const x of xs) rows.push([sec, x.code, x.name, cents(x.balance)]);
      rows.push(["Total", "", "Total assets", cents(r.totalAssets)], ["Total", "", "Total liabilities & equity", cents(r.totalLiabilities + r.totalEquity)]);
      break;
    }
    case "inv": {
      const r = inventoryValuation(db, { asOf, knownAt });
      rows = [["SKU", "Item", "Warehouse", "Qty", "Avg cost EUR", "Value EUR"]];
      for (const p of r.rows) rows.push([p.sku, p.name, p.wh_name, p.qty, cents(Math.round(p.value / p.qty)), cents(p.value)]);
      rows.push(["", "Total", "", "", "", cents(r.total)]);
      break;
    }
    case "journal": {
      rows = [["Id", "Date", "Posted at", "Kind", "Counterparty", "Memo", "Reference", "Amount EUR", "Reverses", "Reversed by", "Hash"]];
      for (const j of journalsList(db, { limit: 100000 }).reverse())
        rows.push([j.id, j.doc_date, j.posted_at, j.kind, j.counterparty, j.memo, j.reference, cents(j.amount), j.reverses_id ?? "", j.reversed_by ?? "", j.hash]);
      break;
    }
    default: {
      const r = trialBalance(db, { asOf, knownAt });
      rows = [["Account", "Name", "Type", "Debit EUR", "Credit EUR"]];
      for (const a of r.rows) {
        const net = a.debit - a.credit;
        rows.push([a.code, a.name, a.type, net > 0 ? cents(net) : "", net < 0 ? cents(-net) : ""]);
      }
      rows.push(["", "Totals", "", cents(r.totals.debit), cents(r.totals.credit)]);
    }
  }

  const csv = "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ledgerline-${report}-${asOf}.csv"`,
    },
  });
}
