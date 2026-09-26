import { password } from "bun";
import { config } from "../config";
import { db } from "../db/client";

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
};

type SessionRow = {
  expires_at: Date;
};

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
};

export function normalizeUsername(username: string) {
  return username.normalize("NFKC").trim().toLowerCase();
}

function newSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

async function hashSessionToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest);
}

export async function createSession(userId: string) {
  const token = newSessionToken();
  const tokenHash = await hashSessionToken(token);
  const [session] = await db<SessionRow[]>`
    insert into sessions (user_id, token_hash, expires_at)
    values (${userId}, ${tokenHash}, now() + make_interval(secs => ${config.sessionTtlSeconds}))
    returning expires_at
  `;

  return { token, expiresAt: session.expires_at };
}

export function extractBearerToken(authorization: string | undefined) {
  if (!authorization?.startsWith("Bearer ")) return;
  const token = authorization.slice("Bearer ".length).trim();
  if (token.length < 20 || token.length > 128) return;
  return token;
}

export async function authenticate(authorization: string | undefined): Promise<AuthenticatedUser | null> {
  const token = extractBearerToken(authorization);
  if (!token) return null;

  const tokenHash = await hashSessionToken(token);
  const [user] = await db<UserRow[]>`
    select u.id, u.username, u.display_name, u.password_hash, u.created_at
    from sessions s
    join users u on u.id = s.user_id
    where s.token_hash = ${tokenHash} and s.expires_at > now()
  `;

  if (!user) return null;

  await db`update sessions set last_used_at = now() where token_hash = ${tokenHash}`;
  return { id: user.id, username: user.username, displayName: user.display_name };
}

export async function verifyPassword(user: UserRow | undefined, candidate: string) {
  if (!user) {
    await password.hash(candidate);
    return false;
  }

  return password.verify(candidate, user.password_hash);
}
