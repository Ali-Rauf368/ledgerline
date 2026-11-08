import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "./db";
import type { Permission, User } from "./auth";
import { AuthError, can, requirePermission, SESSION_COOKIE, userForToken } from "./auth";

/** The signed-in user for this request, validated against the sessions table. */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return userForToken(getDb(), token);
}

/** For pages: redirect to login when signed out. */
export async function pageUser(): Promise<User> {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

/** For server actions and route handlers: throws AuthError when signed out or not allowed. */
export async function actionUser(p?: Permission): Promise<User> {
  const u = await currentUser();
  if (!u) throw new AuthError("Your session has expired. Please sign in again.");
  return p ? requirePermission(u, p) : u;
}

export { can };
