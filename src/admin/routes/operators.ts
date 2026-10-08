/**
 * Host-operator identities.
 *
 * Operator identities live in a database separate from chat accounts. An operator cannot disable or
 * demote the last remaining operator, which is what prevents the console from being locked out of
 * its own instance.
 */

import { Elysia, t } from "elysia";
import { password } from "bun";
import { authenticateAdmin, normalizeAdminUsername } from "../../admin-auth/session";
import { adminCan } from "../../admin-auth/permissions";
import { adminDb } from "../../admin-db/client";
import { isUniqueViolation, respondError } from "../../http/responses";

export const adminOperatorRoutes = new Elysia()
  .get("/v1/instance-admin/operators", async ({ headers, set }) => {
      const actor = await authenticateAdmin(headers.cookie);
      if (!actor) return respondError(set, 401, "unauthorized");
      if (!adminCan(actor.role, "operatorManagement")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const rows = await adminDb<{
        id: string;
        username: string;
        role: "admin" | "moderator";
        disabled_at: Date | null;
        created_at: Date;
      }[]>`
        select id, username, role, disabled_at, created_at
        from admin_users order by username collate "C" asc, id asc limit 201
      `;
      return { operators: rows.slice(0, 200).map((row) => ({
        id: row.id,
        username: row.username,
        role: row.role,
        disabled: row.disabled_at !== null,
        createdAt: row.created_at,
      })), truncated: rows.length > 200 };
    })
    .post("/v1/instance-admin/operators", async ({ body, headers, set }) => {
      const actor = await authenticateAdmin(headers.cookie);
      if (!actor) return respondError(set, 401, "unauthorized");
      if (!adminCan(actor.role, "operatorManagement")) return respondError(set, 403, "forbidden");
      const username = normalizeAdminUsername(body.username);
      if (!/^[a-z0-9_.-]{3,32}$/.test(username)) return respondError(set, 400, "invalid_operator_username");
      set.headers["cache-control"] = "no-store";
      const passwordHash = await password.hash(body.password);
      try {
        const created = await adminDb.begin(async (transaction) => {
          const [row] = await transaction<{ id: string; username: string; role: "admin" | "moderator"; created_at: Date }[]>`
            insert into admin_users (username, password_hash, role)
            values (${username}, ${passwordHash}, ${body.role})
            returning id, username, role, created_at
          `;
          if (!row) throw new Error("Operator creation returned no row");
          await transaction`
            insert into admin_user_audit_logs (
              actor_admin_user_id, actor_username, target_admin_user_id, target_username, action, details
            ) values (
              ${actor.id}, ${actor.username}, ${row.id}, ${row.username}, 'operator.created',
              ${JSON.stringify({ role: row.role })}::jsonb
            )
          `;
          return row;
        });
        set.status = 201;
        return { operator: { id: created.id, username: created.username, role: created.role, disabled: false, createdAt: created.created_at } };
      } catch (error) {
        if (isUniqueViolation(error)) return respondError(set, 409, "operator_username_taken");
        throw error;
      }
    }, {
      body: t.Object({
        username: t.String({ minLength: 3, maxLength: 32 }),
        password: t.String({ minLength: 12, maxLength: 1_024 }),
        role: t.Union([t.Literal("admin"), t.Literal("moderator")]),
      }),
    })
    .patch("/v1/instance-admin/operators/:operatorId", async ({ body, headers, params, set }) => {
      const actor = await authenticateAdmin(headers.cookie);
      if (!actor) return respondError(set, 401, "unauthorized");
      if (!adminCan(actor.role, "operatorManagement")) return respondError(set, 403, "forbidden");
      if (body.role === undefined && body.disabled === undefined) return respondError(set, 400, "operator_change_required");
      set.headers["cache-control"] = "no-store";
      const result = await adminDb.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtextextended('admin-operator-management', 0))`;
        const [current] = await transaction<{
          id: string;
          username: string;
          role: "admin" | "moderator";
          disabled_at: Date | null;
          created_at: Date;
        }[]>`
          select id, username, role, disabled_at, created_at
          from admin_users where id = ${params.operatorId} for update
        `;
        if (!current) return { kind: "not_found" as const };
        const nextRole = body.role ?? current.role;
        const wasDisabled = current.disabled_at !== null;
        const nextDisabled = body.disabled ?? wasDisabled;
        const roleChanged = nextRole !== current.role;
        const disabledChanged = nextDisabled !== wasDisabled;
        if (!roleChanged && !disabledChanged) return { kind: "unchanged" as const, operator: current };
        if (current.id === actor.id) return { kind: "self_change" as const };
        if (current.role === "admin" && !wasDisabled && (nextRole !== "admin" || nextDisabled)) {
          const [activeAdmins] = await transaction<{ count: string }[]>`
            select count(*)::text as count from admin_users where role = 'admin' and disabled_at is null
          `;
          if (Number(activeAdmins?.count ?? 0) <= 1) return { kind: "last_admin" as const };
        }
        const [updated] = await transaction<{
          id: string;
          username: string;
          role: "admin" | "moderator";
          disabled_at: Date | null;
          created_at: Date;
        }[]>`
          update admin_users set role = ${nextRole},
            disabled_at = case when ${nextDisabled} then coalesce(disabled_at, now()) else null end,
            updated_at = now()
          where id = ${current.id}
          returning id, username, role, disabled_at, created_at
        `;
        if (!updated) return { kind: "not_found" as const };
        if (roleChanged) {
          await transaction`
            insert into admin_user_audit_logs (
              actor_admin_user_id, actor_username, target_admin_user_id, target_username, action, details
            ) values (
              ${actor.id}, ${actor.username}, ${updated.id}, ${updated.username}, 'operator.role_changed',
              ${JSON.stringify({ from: current.role, to: updated.role })}::jsonb
            )
          `;
        }
        if (disabledChanged) {
          await transaction`
            insert into admin_user_audit_logs (
              actor_admin_user_id, actor_username, target_admin_user_id, target_username, action, details
            ) values (
              ${actor.id}, ${actor.username}, ${updated.id}, ${updated.username},
              ${nextDisabled ? "operator.disabled" : "operator.enabled"}, '{}'::jsonb
            )
          `;
        }
        if (roleChanged || nextDisabled) await transaction`delete from admin_sessions where admin_user_id = ${updated.id}`;
        return { kind: "changed" as const, operator: updated };
      });
      if (result.kind === "not_found") return respondError(set, 404, "operator_not_found");
      if (result.kind === "self_change") return respondError(set, 409, "cannot_change_own_operator");
      if (result.kind === "last_admin") return respondError(set, 409, "last_active_admin_required");
      return {
        changed: result.kind === "changed",
        operator: {
          id: result.operator.id,
          username: result.operator.username,
          role: result.operator.role,
          disabled: result.operator.disabled_at !== null,
          createdAt: result.operator.created_at,
        },
      };
    }, {
      params: t.Object({ operatorId: t.String({ format: "uuid" }) }),
      body: t.Object({
        role: t.Optional(t.Union([t.Literal("admin"), t.Literal("moderator")])),
        disabled: t.Optional(t.Boolean()),
      }),
    })
    .get("/v1/instance-admin/operators/audit", async ({ headers, query, set }) => {
      const actor = await authenticateAdmin(headers.cookie);
      if (!actor) return respondError(set, 401, "unauthorized");
      if (!adminCan(actor.role, "operatorManagement")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const requestedLimit = Number(query.limit ?? 50);
      const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
      const rows = await adminDb<{
        id: bigint | number | string;
        actor_username: string;
        target_username: string;
        action: string;
        details: Record<string, unknown>;
        created_at: Date;
      }[]>`
        select id, actor_username, target_username, action, details, created_at
        from admin_user_audit_logs order by created_at desc, id desc limit ${limit}
      `;
      return { logs: rows.map((row) => ({
        id: String(row.id),
        actorUsername: row.actor_username,
        targetUsername: row.target_username,
        action: row.action,
        details: row.details ?? {},
        createdAt: row.created_at,
      })) };
    }, {
      query: t.Object({ limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })) }),
    });
