import { config } from "../config";
import { sessionCookieSecure } from "../request-security";

/** The subset of an Elysia response context these helpers need. */
export type ResponseHeaders = {
  headers: Record<string, string | number | undefined>;
};

/**
 * The single error shape every endpoint returns on failure.
 *
 * Clients branch on the HTTP status and this code rather than on prose, so no exception message
 * or stack ever reaches a response.
 */
export function respondError(set: { status?: number | string }, status: number, error: string) {
  set.status = status;
  return { error };
}

function secureCookieSuffix(request: Request) {
  return sessionCookieSecure({ url: request.url, headers: request.headers }) ? "; Secure" : "";
}

/**
 * `Secure` follows the scheme the browser actually used rather than `NODE_ENV`, so an HTTPS
 * instance outside production is protected. Plain HTTP yields no attribute, because a browser
 * discards a `Secure` cookie delivered over it.
 */
export function setSessionCookie(set: ResponseHeaders, token: string, request: Request) {
  set.headers["set-cookie"] =
    `priv_chat_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionTtlSeconds}${secureCookieSuffix(request)}`;
}

export function clearSessionCookie(set: ResponseHeaders, request: Request) {
  set.headers["set-cookie"] =
    `priv_chat_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieSuffix(request)}`;
}

/**
 * The operator cookie is `SameSite=Strict`, which is safe here because the console is only ever
 * reached by top-level navigation to it, never by a cross-site request that would carry it.
 */
export function setAdminSessionCookie(set: ResponseHeaders, token: string, request: Request) {
  set.headers["set-cookie"] =
    `priv_chat_admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionTtlSeconds}${secureCookieSuffix(request)}`;
}

export function clearAdminSessionCookie(set: ResponseHeaders, request: Request) {
  set.headers["set-cookie"] =
    `priv_chat_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookieSuffix(request)}`;
}

/** Recognises a PostgreSQL unique-constraint violation, including through a wrapped `cause`. */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const postgresError = error as { code?: string; errno?: string | number; cause?: unknown };
  return postgresError.code === "23505"
    || String(postgresError.errno ?? "") === "23505"
    || isUniqueViolation(postgresError.cause);
}
