import { notFound } from "next/navigation";
import { CreateUserForm, UserControls } from "@/components/v3-forms";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { can, listUsers, ROLE_LABEL, ROLE_PERMISSIONS } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fmtTimestamp } from "@/lib/money";
import { pageUser } from "@/lib/session";

const PERM_LABEL: Record<string, string> = {
  "post:RECEIPT": "Receive goods", "post:SALE": "Sell", "post:TRANSFER": "Transfer", "post:ADJUSTMENT": "Adjust stock", "post:PAYMENT": "Cash & payments",
  reverse: "Reverse entries", approve: "Approve (four-eyes)", "period:close": "Request period close", "budget:edit": "Edit budgets",
  "contacts:edit": "Manage contacts", "orders:edit": "Purchase orders", "bank:reconcile": "Bank reconciliation", "users:manage": "Manage users", "ai:commentary": "AI commentary",
};

export default async function UsersPage() {
  const me = await pageUser();
  if (!can(me, "users:manage")) notFound();
  const users = listUsers(getDb());
  const roles = Object.keys(ROLE_PERMISSIONS) as Role[];
  return (
    <>
      <PageHeader eyebrow="Administration" title="Users & roles" subtitle="Every posting, approval and change is attributed to the signed-in user. Deactivating a user ends their sessions immediately; their history stays." />
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title={`${users.length} users`} />
          <ul className="divide-y divide-line/70">
            {users.map((u) => (
              <li key={u.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-ink">{u.name} {u.id === me.id && <Badge tone="accent">you</Badge>} {!u.active && <Badge tone="neg">deactivated</Badge>}</p>
                  <p className="text-xs text-muted">{u.email} · {ROLE_LABEL[u.role]} · last sign-in {u.last_login_at ? fmtTimestamp(u.last_login_at) : "never"}</p>
                </div>
                <UserControls id={u.id} role={u.role} active={!!u.active} self={u.id === me.id} />
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Add user" />
          <div className="p-5"><CreateUserForm /></div>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader title="Permission matrix" subtitle="What each role may do" />
        <div className="overflow-x-auto">
          <table className="table min-w-[640px]">
            <thead><tr><th>Permission</th>{roles.map((r) => <th key={r} className="text-center!">{ROLE_LABEL[r]}</th>)}</tr></thead>
            <tbody>
              {Object.keys(PERM_LABEL).map((p) => (
                <tr key={p}>
                  <td className="text-ink">{PERM_LABEL[p]}</td>
                  {roles.map((r) => <td key={r} className="text-center">{ROLE_PERMISSIONS[r].includes(p as never) ? <span className="text-pos">●</span> : <span className="text-line">○</span>}</td>)}
                </tr>
              ))}
              <tr><td className="text-ink">View reports, insights, Copilot</td>{roles.map((r) => <td key={r} className="text-center text-pos">●</td>)}</tr>
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
