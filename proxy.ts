import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Optimistic check only (cookie present). Every page, action and route re-validates the session server-side.
const PUBLIC = ["/login", "/api/health"];

export default function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const hasSession = !!req.cookies.get("ll_session")?.value;
  if (!hasSession && !PUBLIC.some((p) => path === p || path.startsWith(`${p}/`))) {
    const url = new URL("/login", req.nextUrl);
    if (path !== "/") url.searchParams.set("next", path + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico)$).*)"] };
