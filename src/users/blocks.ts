/**
 * Blocks between accounts.
 *
 * A block is symmetric and takes effect everywhere user-to-user content is exposed. Blocking is not
 * a privacy setting against the instance operator, who can still see both accounts; it is a
 * boundary between two people.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { db } from "../db/client";
import { respondError } from "../http/responses";
import { profileImageUrl } from "../profile-images";

export const blockRoutes = new Elysia()
  .get("/v1/users/blocked", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      const blocked = await db<{
        id: string;
        username: string;
        display_name: string;
        profile_image_storage_key: string | null;
      }[]>`
        select u.id, u.username, u.display_name, u.profile_image_storage_key
        from user_blocks b join users u on u.id = b.blocked_user_id
        where b.blocker_user_id = ${user.id}
        order by u.username
      `;
      return { users: blocked.map((blockedUser) => ({
        id: blockedUser.id,
        username: blockedUser.username,
        displayName: blockedUser.display_name,
        avatarUrl: profileImageUrl(blockedUser.id, blockedUser.profile_image_storage_key),
      })) };
    })
    .post("/v1/users/:userId/block", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (params.userId === user.id) return respondError(set, 400, "cannot_block_self");
      const [target] = await db<{ id: string }[]>`select id from users where id = ${params.userId}`;
      if (!target) return respondError(set, 404, "user_not_found");
      await db`
        insert into user_blocks (blocker_user_id, blocked_user_id)
        values (${user.id}, ${params.userId}) on conflict do nothing
      `;
      return { blocked: true };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .delete("/v1/users/:userId/block", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [deleted] = await db<{ blocker_user_id: string }[]>`
        delete from user_blocks where blocker_user_id = ${user.id} and blocked_user_id = ${params.userId}
        returning blocker_user_id
      `;
      return { unblocked: Boolean(deleted) };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    });
