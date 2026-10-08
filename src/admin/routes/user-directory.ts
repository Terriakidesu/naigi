/**
 * Instance user directory.
 *
 * A paginated prefix search over accounts, available to operators with moderation or platform
 * capability. The search is a bounded range scan on the normalized username, so a caller cannot turn
 * it into a full table scan.
 */

import { Elysia, t } from "elysia";
import { authenticateAdmin } from "../../admin-auth/session";
import { adminCan } from "../../admin-auth/permissions";
import { db } from "../../db/client";
import { respondError } from "../../http/responses";
import { decodePageCursor, encodePageCursor, isUuid, prefixUpperBound } from "../../http/validation";

export const adminUserDirectoryRoutes = new Elysia()
  .get("/v1/instance-admin/users", async ({ headers, query, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "moderation")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const field = query.field ?? "username";
      const rawSearch = (query.search?.trim() ?? "").replaceAll("\u0000", "");
      const search = (field === "username" ? rawSearch.normalize("NFKC") : rawSearch).toLowerCase().slice(0, 100);
      const status = query.status ?? "all";
      const requestedLimit = Number(query.limit ?? 50);
      const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
      const cursor = decodePageCursor(query.cursor);
      if (query.cursor && (!cursor || typeof cursor.key !== "string" || cursor.key.length > 240
        || !isUuid(cursor.id) || cursor.context !== `${status}:${field}:${search}`)) {
        return respondError(set, 400, "invalid_cursor");
      }
      if (search.length < 2) return { users: [], limit, nextCursor: null };
      const searchColumn = field === "username"
        ? db`u.username_normalized collate "C"`
        : db`lower(u.display_name) collate "C"`;
      const upperBound = prefixUpperBound(search);
      const searchPredicate = upperBound
        ? db`${searchColumn} >= ${search}::text collate "C" and ${searchColumn} < ${upperBound}::text collate "C"`
        : db`${searchColumn} >= ${search}::text collate "C"`;
      const statusPredicate = status === "banned"
        ? db`and s.user_id is not null`
        : status === "active" ? db`and s.user_id is null` : db``;
      const cursorPredicate = cursor
        ? db`and (${searchColumn}, u.id) > (${cursor.key}::text collate "C", ${cursor.id}::uuid)`
        : db``;
      const users = await db<{
        id: string;
        username: string;
        display_name: string;
        created_at: Date;
        cursor_key: string;
        banned: boolean;
        timed_out: boolean;
        active_warning_count: string;
      }[]>`
        select u.id, u.username, u.display_name, u.created_at,
          ${searchColumn} as cursor_key,
          (s.user_id is not null) as banned,
          exists (
            select 1 from instance_user_timeouts t
            where t.user_id = u.id and t.revoked_at is null and t.expires_at > now()
          ) as timed_out,
          (select count(*)::text from instance_user_warnings w
            where w.user_id = u.id and w.revoked_at is null
              and (w.expires_at is null or w.expires_at > now())) as active_warning_count
        from users u
        left join instance_user_suspensions s on s.user_id = u.id
        where ${searchPredicate}
          ${statusPredicate}
          ${cursorPredicate}
        order by ${searchColumn} asc, u.id asc
        limit ${limit + 1}
      `;
      const hasMore = users.length > limit;
      const page = users.slice(0, limit);
      return {
        users: page.map((row) => ({
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          createdAt: row.created_at,
          banned: row.banned,
          timedOut: row.timed_out,
          activeWarningCount: Number(row.active_warning_count) || 0,
        })),
        limit,
        nextCursor: hasMore && page.length
          ? encodePageCursor({ key: page[page.length - 1]!.cursor_key, id: page[page.length - 1]!.id, context: `${status}:${field}:${search}` })
          : null,
      };
    }, {
      query: t.Object({
        search: t.Optional(t.String({ maxLength: 100 })),
        field: t.Optional(t.Union([t.Literal("username"), t.Literal("displayName")])),
        status: t.Optional(t.Union([t.Literal("all"), t.Literal("active"), t.Literal("banned")])),
        limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })),
        cursor: t.Optional(t.String({ maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" })),
      }),
    });
