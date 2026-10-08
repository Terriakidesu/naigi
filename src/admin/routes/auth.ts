/**
 * Host-operator sign-in.
 *
 * The operator cookie is `SameSite=Strict` and uses a separate session table in the operator
 * database, so a chat session can never authenticate here. Sign-in is throttled per account and per
 * address more tightly than chat login, since this endpoint guards the whole instance, and it fails
 * closed if the limiter is unavailable.
 */

import { Elysia, t } from "elysia";
import {
  authenticateAdmin,
  createAdminSession,
  deleteAdminSession,
  extractAdminCookieToken,
  normalizeAdminUsername,
  verifyAdminPassword,
} from "../../admin-auth/session";
import {
  authRateLimitIpWindowSeconds,
  authRateLimitWindowSeconds,
  clientIpFor,
  enforceRateLimits,
} from "../../http/limits";
import { clearAdminSessionCookie, respondError, setAdminSessionCookie } from "../../http/responses";
import { bumpRateLimit, peekRateLimit, rateLimitKey, type RateLimitVerdict } from "../../rate-limit";

export const adminAuthRoutes = new Elysia()
  .post("/v1/instance-admin/auth/login", async ({ body, headers, request, server, set }) => {
      set.headers["cache-control"] = "no-store";
      const existing = await authenticateAdmin(headers.cookie);
      if (existing) return { operator: existing };

      const account = normalizeAdminUsername(body.username);
      const clientIp = clientIpFor({ request, headers, server });

      // Stricter budgets than user login: this endpoint guards the whole instance, so the
      // per-IP window is short and the per-account failure budget is small.
      const verdicts: RateLimitVerdict[] = [];
      if (clientIp) {
        verdicts.push(await bumpRateLimit({
          key: rateLimitKey("admin-login-ip", clientIp),
          limit: 10,
          windowSeconds: authRateLimitIpWindowSeconds,
          failClosed: true,
        }));
      }
      verdicts.push(await peekRateLimit({
        key: rateLimitKey("admin-login-failed", account),
        limit: 5,
        failClosed: true,
      }));

      const refused = enforceRateLimits(set, verdicts);
      if (refused) return refused;

      const operator = await verifyAdminPassword(body.username, body.password);
      if (!operator) {
        await bumpRateLimit({
          key: rateLimitKey("admin-login-failed", account),
          limit: 5,
          windowSeconds: authRateLimitWindowSeconds,
          failClosed: true,
        });
        return respondError(set, 401, "invalid_credentials");
      }
      const session = await createAdminSession(operator.id);
      if (!session) return respondError(set, 401, "invalid_credentials");
      setAdminSessionCookie(set, session.token, request);
      return { operator };
    }, {
      body: t.Object({
        username: t.String({ minLength: 3, maxLength: 128 }),
        password: t.String({ minLength: 1, maxLength: 1_024 }),
      }),
    })
    .get("/v1/instance-admin/auth/me", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      return { operator };
    })
    .post("/v1/instance-admin/auth/logout", async ({ headers, request, set }) => {
      await deleteAdminSession(extractAdminCookieToken(headers.cookie));
      clearAdminSessionCookie(set, request);
      set.headers["cache-control"] = "no-store";
      return { loggedOut: true };
    });
