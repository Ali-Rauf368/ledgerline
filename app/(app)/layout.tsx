import { CommandPalette } from "@/components/CommandPalette";
import { Copilot } from "@/components/Copilot";
import { Sidebar } from "@/components/Sidebar";
import { pendingCount } from "@/lib/approvals";
import { ROLE_LABEL, ROLE_PERMISSIONS } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { chainHead, itemsOverview, journalsList } from "@/lib/reports";
import { pageUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await pageUser();
  const db = getDb();
  const head = chainHead(db);
  const palette = {
    items: itemsOverview(db).map(({ id, sku, name }) => ({ id, sku, name })),
    journals: journalsList(db, { limit: 25 }).map((j) => ({ id: j.id, label: j.counterparty || j.memo || j.kind, kind: j.kind.toLowerCase() })),
  };
  return (
    <>
      <div className="lg:flex">
        <Sidebar
          head={head}
          user={{ name: user.name, email: user.email, role: ROLE_LABEL[user.role] }}
          perms={ROLE_PERMISSIONS[user.role]}
          pending={ROLE_PERMISSIONS[user.role].includes("approve") ? pendingCount(db) : 0}
        />
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-7xl px-4 py-7 sm:px-8 sm:py-10">{children}</div>
        </main>
      </div>
      <CommandPalette data={palette} />
      <Copilot />
    </>
  );
}
