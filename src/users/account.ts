/**
 * The authenticated account's own view of itself.
 *
 * Read and write of one's own profile, plus push token registration and acknowledgement of
 * instance warnings. Changing the password revokes every other session for the account, so a
 * stolen session cannot outlive a credential change.
 */

import { Elysia, t } from "elysia";
import { password } from "bun";
import {
  authenticate,
  extractBearerToken,
  extractCookieToken,
  hashSessionToken,
  verifyPassword,
} from "../auth/session";
import { config } from "../config";
import { db } from "../db/client";
import { respondError } from "../http/responses";
import { toPublicUser, type UserRow } from "../http/shapes";
import { registerFcmPushToken, removeFcmPushToken } from "../push/fcm";
import { screenPassword } from "../password-policy";
import { authRateLimitWindowSeconds, enforceRateLimits } from "../http/limits";
import { bumpRateLimit, rateLimitKey } from "../rate-limit";

export const accountRoutes = new Elysia()
  .get("/v1/me", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      return { user };
    })
    .get("/v1/me/instance-warnings", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      const warnings = await db<{ id: string; reason: string; created_at: Date; expires_at: Date | null }[]>`
        select id, reason, created_at, expires_at
        from instance_user_warnings
        where user_id = ${user.id} and acknowledged_at is null and revoked_at is null
          and (expires_at is null or expires_at > now())
        order by created_at desc limit 25
      `;
      return { warnings: warnings.map((warning) => ({
        id: warning.id,
        reason: warning.reason,
        createdAt: warning.created_at,
        expiresAt: warning.expires_at,
      })) };
    })
    .patch("/v1/me/instance-warnings/:warningId/acknowledge", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      const [warning] = await db<{ id: string }[]>`
        update instance_user_warnings set acknowledged_at = coalesce(acknowledged_at, now())
        where id = ${params.warningId} and user_id = ${user.id} and revoked_at is null
          and (expires_at is null or expires_at > now())
        returning id
      `;
      if (!warning) return respondError(set, 404, "warning_not_found");
      return { acknowledged: true };
    }, {
      params: t.Object({ warningId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/push/subscriptions", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!config.firebaseMessaging) return respondError(set, 503, "push_not_configured");
      await registerFcmPushToken(user.id, body.token);
      set.status = 201;
      return { registered: true };
    }, {
      body: t.Object({ token: t.String({ minLength: 20, maxLength: 4096 }) }),
    })
    .post("/v1/push/subscriptions/remove", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const removed = await removeFcmPushToken(user.id, body.token);
      return { removed };
    }, {
      body: t.Object({ token: t.String({ minLength: 20, maxLength: 4096 }) }),
    })
    .patch("/v1/me", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const displayName = body.displayName.trim();
      if (!displayName) return respondError(set, 400, "invalid_display_name");
      const [updated] = await db<UserRow[]>`
        update users
        set display_name = ${displayName}, updated_at = now()
        where id = ${user.id}
         returning id, username, display_name, password_hash, created_at,
           profile_image_storage_key, profile_banner_storage_key
      `;
      return { user: toPublicUser(updated) };
    }, {
      body: t.Object({ displayName: t.String({ minLength: 1, maxLength: 80 }) }),
    })
    .post("/v1/auth/password", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      // Bounds attempts against a session that is already authenticated but possibly hijacked,
      // and bounds the password hashing that each attempt costs.
      const refused = enforceRateLimits(set, [await bumpRateLimit({
        key: rateLimitKey("password-change", user.id),
        limit: 5,
        windowSeconds: authRateLimitWindowSeconds,
        failClosed: true,
      })]);
      if (refused) return refused;

      const [record] = await db<UserRow[]>`
         select id, username, display_name, password_hash, created_at,
           profile_image_storage_key, profile_banner_storage_key
        from users where id = ${user.id}
      `;
      if (!await verifyPassword(record, body.currentPassword)) return respondError(set, 400, "current_password_incorrect");

      const rejection = screenPassword(body.newPassword, { username: record?.username, displayName: record?.display_name });
      if (rejection) return respondError(set, 422, rejection);

      const passwordHash = await password.hash(body.newPassword);
      await db`
        update users set password_hash = ${passwordHash}, updated_at = now()
        where id = ${user.id}
      `;
      const token = extractBearerToken(headers.authorization) ?? extractCookieToken(headers.cookie);
      if (token) {
        const tokenHash = await hashSessionToken(token);
        await db`
          delete from sessions where user_id = ${user.id} and token_hash <> ${tokenHash}
        `;
      }
      return { updated: true };
    }, {
      body: t.Object({
        currentPassword: t.String({ minLength: 1, maxLength: 128 }),
        newPassword: t.String({ minLength: 12, maxLength: 128 }),
      }),
    });
