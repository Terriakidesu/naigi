/**
 * Instance-wide space administration.
 *
 * Lets an operator inspect and deactivate any space, including one they are not a member of. Audit
 * history comes from the space's own log, so an operator sees the same record a space moderator
 * would.
 */

import { Elysia, t } from "elysia";
import { authenticateAdmin } from "../../admin-auth/session";
import { adminCan } from "../../admin-auth/permissions";
import { db } from "../../db/client";
import { respondError } from "../../http/responses";
import { decodePageCursor, encodePageCursor, isCursorTimestamp, isUuid } from "../../http/validation";

export const adminSpaceRoutes = new Elysia()
  .get("/v1/instance-admin/spaces", async ({ headers, query, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const status = query.status ?? "all";
      const requestedLimit = Number(query.limit ?? 50);
      const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
      const cursor = decodePageCursor(query.cursor);
      if (query.cursor && (!cursor || !isCursorTimestamp(cursor.createdAt) || !isUuid(cursor.id)
        || cursor.context !== status)) return respondError(set, 400, "invalid_cursor");
      const statusPredicate = status === "active"
        ? db`and s.deactivated_at is null`
        : status === "deactivated" ? db`and s.deactivated_at is not null` : db``;
      const cursorPredicate = cursor
        ? db`and (s.created_at, s.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
        : db``;
      const rows = await db<{
        id: string;
        created_at: Date;
        cursor_created_at: string;
        deactivated_at: Date | null;
        active_member_count: string;
      }[]>`
        select s.id, s.created_at, s.deactivated_at,
          to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at,
          (select count(*)::text from server_members sm where sm.server_id = s.id and sm.left_at is null) as active_member_count
        from servers s
        where true ${statusPredicate}
          ${cursorPredicate}
        order by s.created_at desc, s.id desc
        limit ${limit + 1}
      `;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        spaces: page.map((row) => ({
          id: row.id,
          createdAt: row.created_at,
          deactivatedAt: row.deactivated_at,
          activeMemberCount: Number(row.active_member_count) || 0,
        })),
        limit,
        nextCursor: hasMore && page.length
          ? encodePageCursor({ createdAt: page[page.length - 1]!.cursor_created_at, id: page[page.length - 1]!.id, context: status })
          : null,
      };
    }, {
      query: t.Object({
        status: t.Optional(t.Union([t.Literal("all"), t.Literal("active"), t.Literal("deactivated")])),
        limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })),
        cursor: t.Optional(t.String({ maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" })),
      }),
    })
    .patch("/v1/instance-admin/spaces/:serverId/activation", async ({ body, headers, params, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const reason = body.reason.trim();
      if (!reason) return respondError(set, 400, "reason_required");
      const result = await db.begin(async (transaction) => {
        const [space] = await transaction<{ id: string; created_at: Date; deactivated_at: Date | null }[]>`
          select id, created_at, deactivated_at from servers where id = ${params.serverId} for update
        `;
        if (!space) return undefined;
        const currentlyActive = space.deactivated_at === null;
        if (currentlyActive === body.active) return { space, changed: false };
        const [updated] = await transaction<{ id: string; created_at: Date; deactivated_at: Date | null }[]>`
          update servers set deactivated_at = ${body.active ? null : transaction`now()`}, updated_at = now()
          where id = ${space.id}
          returning id, created_at, deactivated_at
        `;
        const action = body.active ? "space.activated" : "space.deactivated";
        await transaction`
          insert into instance_server_audit_logs (server_id, admin_user_id, admin_username, action, reason)
          values (${space.id}, ${operator.id}, ${operator.username}, ${action}, ${reason})
        `;
        return { space: updated!, changed: true };
      });
      if (!result) return respondError(set, 404, "space_not_found");
      const [count] = await db<{ active_member_count: string }[]>`
        select count(*)::text as active_member_count from server_members
        where server_id = ${result.space.id} and left_at is null
      `;
      return {
        space: {
          id: result.space.id,
          createdAt: result.space.created_at,
          deactivatedAt: result.space.deactivated_at,
          activeMemberCount: Number(count?.active_member_count) || 0,
        },
        changed: result.changed,
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({ active: t.Boolean(), reason: t.String({ minLength: 1, maxLength: 240 }) }),
    })
    .get("/v1/instance-admin/spaces/:serverId/audit", async ({ headers, params, query, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const [exists] = await db<{ id: string }[]>`select id from servers where id = ${params.serverId}`;
      if (!exists) return respondError(set, 404, "space_not_found");
      const requestedLimit = Number(query.limit ?? 50);
      const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
      const cursor = decodePageCursor(query.cursor);
      if (query.cursor && (!cursor || !isCursorTimestamp(cursor.createdAt)
        || typeof cursor.id !== "string" || !/^\d+$/.test(cursor.id)
        || (cursor.source !== "space" && cursor.source !== "host") || cursor.context !== params.serverId)) {
        return respondError(set, 400, "invalid_cursor");
      }
      const cursorPredicate = cursor
        ? db`and (entry.created_at, entry.id, entry.source) < (${cursor.createdAt}::timestamptz, ${cursor.id}::bigint, ${cursor.source}::text)`
        : db``;
      const rows = await db<{
        id: bigint | number | string;
        source: "space" | "host";
        action: string;
        actor: string;
        target_id: string | null;
        target_user_id: string | null;
        reason: string | null;
        created_at: Date;
        cursor_created_at: string;
      }[]>`
        with audit_entries as (
          select l.id, 'space'::text as source, l.action,
            actor.username as actor, l.target_id::text as target_id,
            l.target_user_id::text as target_user_id, null::text as reason, l.created_at
          from server_audit_logs l
          join users actor on actor.id = l.actor_id
          where l.server_id = ${params.serverId}
          union all
          select l.id, 'host'::text as source, l.action,
            l.admin_username as actor, null::text as target_id,
            null::text as target_user_id, l.reason, l.created_at
          from instance_server_audit_logs l
          where l.server_id = ${params.serverId}
        )
        select entry.id, entry.source, entry.action, entry.actor, entry.target_id, entry.target_user_id,
          entry.reason, entry.created_at,
          to_char(entry.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
        from audit_entries entry
        where true ${cursorPredicate}
        order by entry.created_at desc, entry.id desc, entry.source desc
        limit ${limit + 1}
      `;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        logs: page.map((row) => ({
          id: `${row.source}-${row.id}`,
          source: row.source,
          action: row.action,
          actor: row.actor,
          targetId: row.target_id,
          targetUserId: row.target_user_id,
          reason: row.reason,
          createdAt: row.created_at,
        })),
        limit,
        nextCursor: hasMore && page.length
          ? encodePageCursor({ createdAt: page[page.length - 1]!.cursor_created_at, id: String(page[page.length - 1]!.id), source: page[page.length - 1]!.source, context: params.serverId })
          : null,
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      query: t.Object({
        limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })),
        cursor: t.Optional(t.String({ maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" })),
      }),
    });
