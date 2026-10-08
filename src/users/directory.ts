/**
 * Public user profile lookup.
 *
 * Readable by any authenticated account so a shared space can render its member list. It exposes
 * only the fields a client already receives from a member list, and no credential or session state.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { db } from "../db/client";
import { respondError } from "../http/responses";
import { toPublicUser, type UserRow } from "../http/shapes";

export const userDirectoryRoutes = new Elysia()
  .get("/v1/users/:userId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [profile] = await db<UserRow[]>`
         select id, username, display_name, created_at,
           profile_image_storage_key, profile_banner_storage_key
        from users
        where id = ${params.userId}
      `;
      if (!profile) return respondError(set, 404, "user_not_found");
      const [block] = await db<{ blocked: boolean }[]>`
        select exists(select 1 from user_blocks where blocker_user_id = ${user.id} and blocked_user_id = ${params.userId}) as blocked
      `;
      return { user: toPublicUser(profile), blockedByMe: block?.blocked === true };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    });
