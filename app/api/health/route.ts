import { getDb, SCHEMA_VERSION } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    const n = (getDb().prepare("SELECT COUNT(*) n FROM journals").get() as { n: number }).n;
    return Response.json({ ok: true, schema: SCHEMA_VERSION, journals: n });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 503 });
  }
}
