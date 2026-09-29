import { password } from "bun";
import { config } from "../config";
import { adminDb } from "../admin-db/client";
import type { AdminRole } from "./permissions";

type AdminUserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: AdminRole;
};

type AdminSessionRow = {
  expires_at: Date;
};

export type AuthenticatedAdmin = {
  id: string;
  username: string;
  role: AdminRole;
};

export function normalizeAdminUsername(username: string) {
  return username.normalize("NFKC").trim().toLowerCase();
}

function newSessionToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export async function hashAdminSessionToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest);
}

export async function createAdminSession(adminUserId: string) {
  const token = newSessionToken();
  const tokenHash = await hashAdminSessionToken(token);
  const [session] = await adminDb<AdminSessionRow[]>`
    insert into admin_sessions (admin_user_id, token_hash, expires_at)
    select id, ${tokenHash}, now() + make_interval(secs => ${config.sessionTtlSeconds})
    from admin_users where id = ${adminUserId} and disabled_at is null
    returning expires_at
  `;
  if (!session) return null;
  return { token, expiresAt: session.expires_at };
}

export function extractAdminCookieToken(cookieHeader: string | undefined) {
  const cookie = cookieHeader?.split(";").find((part) => part.trim().startsWith("priv_chat_admin_session="));
  if (!cookie) return;
  const token = cookie.slice(cookie.indexOf("=") + 1).trim();
  if (token.length < 20 || token.length > 128) return;
  return token;
}

export async function authenticateAdmin(cookieHeader?: string): Promise<AuthenticatedAdmin | null> {
  const token = extractAdminCookieToken(cookieHeader);
  if (!token) return null;
  const tokenHash = await hashAdminSessionToken(token);
  const [admin] = await adminDb<AdminUserRow[]>`
    select u.id, u.username, u.password_hash, u.role
    from admin_sessions s
    join admin_users u on u.id = s.admin_user_id
    where s.token_hash = ${tokenHash} and s.expires_at > now() and u.disabled_at is null
  `;
  if (!admin) return null;
  await adminDb`update admin_sessions set last_used_at = now() where token_hash = ${tokenHash}`;
  return { id: admin.id, username: admin.username, role: admin.role };
}

export async function deleteAdminSession(token: string | undefined) {
  if (!token) return;
  const tokenHash = await hashAdminSessionToken(token);
  await adminDb`delete from admin_sessions where token_hash = ${tokenHash}`;
}

export async function verifyAdminPassword(username: string, candidate: string) {
  const [admin] = await adminDb<AdminUserRow[]>`
    select id, username, password_hash, role from admin_users
    where username = ${normalizeAdminUsername(username)} and disabled_at is null
  `;
  if (!admin) {
    await password.hash(candidate);
    return null;
  }
  if (!(await password.verify(candidate, admin.password_hash))) return null;
  return { id: admin.id, username: admin.username, role: admin.role } satisfies AuthenticatedAdmin;
}
