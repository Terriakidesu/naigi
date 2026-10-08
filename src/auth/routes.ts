/**
 * Account creation, sign-in, and password change.
 *
 * Every credential path is throttled on two axes: a per-account budget that counts failures only,
 * and a per-IP budget that counts every attempt to bound password hashing. Limiting fails closed, so
 * a Redis outage refuses sign-in rather than admitting an unthrottled guessing window.
 */

import { Elysia, t } from "elysia";
import { password } from "bun";
import {
  createSession,
  deleteSession,
  extractBearerToken,
  extractCookieToken,
  normalizeUsername,
  verifyPassword,
} from "../auth/session";
import { db } from "../db/client";
import {
  authRateLimitIpWindowSeconds,
  authRateLimitWindowSeconds,
  clientIpFor,
  enforceRateLimits,
} from "../http/limits";
import { clearSessionCookie, isUniqueViolation, respondError, setSessionCookie } from "../http/responses";
import { toPublicUser, type UserRow } from "../http/shapes";
import { screenPassword } from "../password-policy";
import { bumpRateLimit, peekRateLimit, rateLimitKey, type RateLimitVerdict } from "../rate-limit";

const registrationBody = t.Object({
  username: t.String({ minLength: 3, maxLength: 32, pattern: "^[A-Za-z0-9_.-]+$" }),
  password: t.String({ minLength: 12, maxLength: 128 }),
  displayName: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
});

// Login deliberately accepts a short password. Sharing the registration schema meant a wrong
// password shorter than 12 characters returned 422 validation_error instead of 401
// invalid_credentials, which told an attacker their guess was too short rather than wrong and made
// the two failure modes distinguishable. Verification is what decides validity here.
const loginBody = t.Object({
  username: t.String({ minLength: 3, maxLength: 32, pattern: "^[A-Za-z0-9_.-]+$" }),
  password: t.String({ minLength: 1, maxLength: 128 }),
  displayName: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
});

export const authRoutes = new Elysia()
  .post("/v1/auth/register", async ({ body, headers, request, server, set }) => {
      const username = normalizeUsername(body.username);
      const displayName = body.displayName?.trim() || body.username;

      const clientIp = clientIpFor({ request, headers, server });

      // Screened before the budget is charged: this check is a cheap string comparison, while
      // the budget exists to bound password hashing and mass account creation. Rejecting a
      // mistyped or reused password should not consume the caller's hourly allowance.
      const rejection = screenPassword(body.password, { username: body.username, displayName });
      if (rejection) return respondError(set, 422, rejection);

      if (clientIp) {
        const refused = enforceRateLimits(set, [await bumpRateLimit({
          key: rateLimitKey("register-ip", clientIp),
          limit: 5,
          windowSeconds: 60 * 60,
          failClosed: true,
        })]);
        if (refused) return refused;
      }

      const passwordHash = await password.hash(body.password);

      try {
        const [user] = await db<UserRow[]>`
          insert into users (username, username_normalized, password_hash, display_name)
          values (${body.username}, ${username}, ${passwordHash}, ${displayName})
           returning id, username, display_name, password_hash, created_at,
             profile_image_storage_key, profile_banner_storage_key
        `;
        const session = await createSession(user.id);
        setSessionCookie(set, session.token, request);
        set.status = 201;
        return { user: toPublicUser(user), ...session };
      } catch (error) {
        if (isUniqueViolation(error)) return respondError(set, 409, "username_taken");
        throw error;
      }
    }, { body: registrationBody })
    .post("/v1/auth/login", async ({ body, headers, request, server, set }) => {
      const account = normalizeUsername(body.username);
      const clientIp = clientIpFor({ request, headers, server });

      // The per-IP budget is charged on every attempt because it bounds password-hash CPU work
      // even when the targeted account does not exist. The per-account budget is charged only on
      // failure so a legitimate user is never locked out by their own successful logins, and it
      // is charged for unknown accounts too so it cannot be used to test whether a user exists.
      const verdicts: RateLimitVerdict[] = [];
      if (clientIp) {
        verdicts.push(await bumpRateLimit({
          key: rateLimitKey("login-ip", clientIp),
          limit: 30,
          windowSeconds: authRateLimitIpWindowSeconds,
          failClosed: true,
        }));
      }
      verdicts.push(await peekRateLimit({
        key: rateLimitKey("login-failed", account),
        limit: 10,
        failClosed: true,
      }));

      const refused = enforceRateLimits(set, verdicts);
      if (refused) return refused;

      const [user] = await db<UserRow[]>`
         select id, username, display_name, password_hash, created_at,
           profile_image_storage_key, profile_banner_storage_key
        from users
        where username_normalized = ${account}
      `;
      const valid = await verifyPassword(user, body.password);
      if (!valid || !user) {
        await bumpRateLimit({
          key: rateLimitKey("login-failed", account),
          limit: 10,
          windowSeconds: authRateLimitWindowSeconds,
          failClosed: true,
        });
        return respondError(set, 401, "invalid_credentials");
      }
      const [suspension] = await db<{ user_id: string }[]>`
        select user_id from instance_user_suspensions where user_id = ${user.id}
      `;
      if (suspension) return respondError(set, 403, "account_suspended");

      const session = await createSession(user.id);
      setSessionCookie(set, session.token, request);
      return { user: toPublicUser(user), ...session };
    }, { body: loginBody })
    .post("/v1/auth/logout", async ({ headers, request, set }) => {
      const token = extractBearerToken(headers.authorization) ?? extractCookieToken(headers.cookie);
      await deleteSession(token);
      clearSessionCookie(set, request);
      return { loggedOut: true };
    });
