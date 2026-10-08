/**
 * Instance-wide user administration.
 *
 * These routes act outside any space, so they are gated on the host operator's capability rather
 * than a space role. Suspension revokes every session and closes the account's open realtime
 * sockets; a timeout only blocks writes, leaving reads available.
 */

import { Elysia, t } from "elysia";
import { authenticateAdmin } from "../../admin-auth/session";
import { adminCan } from "../../admin-auth/permissions";
import { db } from "../../db/client";
import { respondError } from "../../http/responses";
import { closeSocketsForUser } from "../../realtime-registry";

export const adminUserRoutes = new Elysia()
  .get("/v1/instance-admin/users/:userId", async ({ headers, params, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "moderation")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const [target] = await db<{
        id: string;
        username: string;
        display_name: string;
        created_at: Date;
        banned_at: Date | null;
        ban_reason: string | null;
      }[]>`
        select u.id, u.username, u.display_name, u.created_at,
          s.created_at as banned_at, s.reason as ban_reason
        from users u
        left join instance_user_suspensions s on s.user_id = u.id
        where u.id = ${params.userId}
      `;
      if (!target) return respondError(set, 404, "user_not_found");
      const [warnings, timeouts, actions] = await Promise.all([
        db<{
          id: string;
          reason: string;
          created_by_username: string;
          created_at: Date;
          expires_at: Date | null;
          acknowledged_at: Date | null;
          revoked_at: Date | null;
        }[]>`
          select id, reason, created_by_username, created_at, expires_at, acknowledged_at, revoked_at
          from instance_user_warnings where user_id = ${params.userId}
          order by created_at desc limit 100
        `,
        db<{
          id: string;
          reason: string;
          created_by_username: string;
          created_at: Date;
          expires_at: Date;
          revoked_at: Date | null;
          revoked_by_username: string | null;
          revocation_action: "removed" | "replaced" | "expired" | null;
        }[]>`
          select id, reason, created_by_username, created_at, expires_at,
            revoked_at, revoked_by_username, revocation_action
          from instance_user_timeouts where user_id = ${params.userId}
          order by created_at desc, id desc limit 100
        `,
        db<{ id: bigint | number | string; action: string; admin_username: string; details: Record<string, unknown>; created_at: Date }[]>`
          select id, action, admin_username, details, created_at
          from instance_admin_audit_logs
          where target_user_id = ${params.userId}
          order by created_at desc, id desc limit 100
        `,
      ]);
      return {
        user: {
          id: target.id,
          username: target.username,
          displayName: target.display_name,
          createdAt: target.created_at,
          ban: target.banned_at ? { createdAt: target.banned_at, reason: target.ban_reason } : null,
        },
        warnings: warnings.map((warning) => ({
          id: warning.id,
          reason: warning.reason,
          createdByUsername: warning.created_by_username,
          createdAt: warning.created_at,
          expiresAt: warning.expires_at,
          acknowledgedAt: warning.acknowledged_at,
          revokedAt: warning.revoked_at,
          active: !warning.revoked_at && (!warning.expires_at || warning.expires_at > new Date()),
        })),
        timeouts: timeouts.map((timeout) => ({
          id: timeout.id,
          reason: timeout.reason,
          createdByUsername: timeout.created_by_username,
          createdAt: timeout.created_at,
          expiresAt: timeout.expires_at,
          revokedAt: timeout.revoked_at,
          revokedByUsername: timeout.revoked_by_username,
          revocationAction: timeout.revocation_action,
          active: !timeout.revoked_at && timeout.expires_at > new Date(),
        })),
        actions: actions.map((action) => ({
          id: String(action.id),
          action: action.action,
          operatorUsername: action.admin_username,
          details: action.details ?? {},
          createdAt: action.created_at,
        })),
      };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/instance-admin/users/:userId/timeout", async ({ body, headers, params, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "moderation")) return respondError(set, 403, "forbidden");
      const reason = body.reason.trim();
      if (!reason) return respondError(set, 422, "timeout_reason_required");
      set.headers["cache-control"] = "no-store";
      const result = await db.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtextextended(${`instance-user-timeout:${params.userId}`}, 0))`;
        const [target] = await transaction<{ id: string }[]>`
          select id from users where id = ${params.userId} for update
        `;
        if (!target) return { kind: "not_found" as const };

        await transaction`
          update instance_user_timeouts
          set revoked_at = now(), revocation_action = 'expired'
          where user_id = ${params.userId} and revoked_at is null and expires_at <= now()
        `;
        const [previous] = await transaction<{ id: string }[]>`
          select id from instance_user_timeouts
          where user_id = ${params.userId} and revoked_at is null
          for update
        `;
        if (previous) {
          await transaction`
            update instance_user_timeouts
            set revoked_at = now(), revoked_by_admin_id = ${operator.id},
              revoked_by_username = ${operator.username}, revocation_action = 'replaced'
            where id = ${previous.id}
          `;
          await transaction`
            insert into instance_admin_audit_logs (
              admin_user_id, admin_username, admin_display_name, action, target_user_id, details
            ) values (
              ${operator.id}, ${operator.username}, ${operator.username}, 'user.timeout_replaced', ${params.userId},
              ${JSON.stringify({ timeoutId: previous.id })}::jsonb
            )
          `;
        }
        const [created] = await transaction<{ id: string; created_at: Date; expires_at: Date }[]>`
          insert into instance_user_timeouts (
            user_id, created_by_admin_id, created_by_username, reason, expires_at
          ) values (
            ${params.userId}, ${operator.id}, ${operator.username}, ${reason},
            now() + make_interval(secs => ${body.durationSeconds})
          )
          returning id, created_at, expires_at
        `;
        if (!created) throw new Error("Instance timeout insert did not return a row");
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, target_user_id, details
          ) values (
            ${operator.id}, ${operator.username}, ${operator.username}, 'user.timed_out', ${params.userId},
            ${JSON.stringify({ timeoutId: created.id, reason, expiresAt: created.expires_at })}::jsonb
          )
        `;
        return { kind: "created" as const, timeout: created, replaced: Boolean(previous) };
      });
      if (result.kind === "not_found") return respondError(set, 404, "user_not_found");
      set.status = 201;
      return { timeout: result.timeout, replaced: result.replaced };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
      body: t.Object({
        reason: t.String({ minLength: 1, maxLength: 240 }),
        durationSeconds: t.Integer({ minimum: 60, maximum: 2_592_000 }),
      }),
    })
    .delete("/v1/instance-admin/users/:userId/timeout", async ({ headers, params, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "moderation")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const removed = await db.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtextextended(${`instance-user-timeout:${params.userId}`}, 0))`;
        const [timeout] = await transaction<{ id: string }[]>`
          select id from instance_user_timeouts
          where user_id = ${params.userId} and revoked_at is null and expires_at > now()
          for update
        `;
        if (!timeout) return undefined;
        await transaction`
          update instance_user_timeouts
          set revoked_at = now(), revoked_by_admin_id = ${operator.id},
            revoked_by_username = ${operator.username}, revocation_action = 'removed'
          where id = ${timeout.id}
        `;
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, target_user_id, details
          ) values (
            ${operator.id}, ${operator.username}, ${operator.username}, 'user.timeout_removed', ${params.userId},
            ${JSON.stringify({ timeoutId: timeout.id })}::jsonb
          )
        `;
        return timeout;
      });
      if (!removed) return respondError(set, 404, "timeout_not_found");
      return { removed: true };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/instance-admin/users/:userId/warnings", async ({ body, headers, params, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "moderation")) return respondError(set, 403, "forbidden");
      const reason = body.reason.trim();
      if (!reason) return respondError(set, 422, "warning_reason_required");
      const expiresInSeconds = body.expiresInSeconds ?? null;
      const [warning] = await db.begin(async (transaction) => {
        const [created] = await transaction<{ id: string; created_at: Date; expires_at: Date | null }[]>`
          insert into instance_user_warnings (
            user_id, created_by, created_by_username, reason, expires_at
          )
          select ${params.userId}, ${operator.id}, ${operator.username}, ${reason},
            case when ${expiresInSeconds}::integer is null then null::timestamptz
              else now() + make_interval(secs => ${expiresInSeconds}::integer) end
          where exists (select 1 from users where id = ${params.userId})
          returning id, created_at, expires_at
        `;
        if (!created) return [undefined];
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, target_user_id, details
          ) values (
            ${operator.id}, ${operator.username}, ${operator.username}, 'user.warned', ${params.userId},
            ${JSON.stringify({ warningId: created.id, expiresAt: created.expires_at })}::jsonb
          )
        `;
        return [created];
      });
      if (!warning) return respondError(set, 404, "user_not_found");
      set.status = 201;
      return { warning: { id: warning.id, createdAt: warning.created_at, expiresAt: warning.expires_at } };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
      body: t.Object({
        reason: t.String({ minLength: 1, maxLength: 240 }),
        expiresInSeconds: t.Optional(t.Integer({ minimum: 300, maximum: 31_536_000 })),
      }),
    })
    .delete("/v1/instance-admin/warnings/:warningId", async ({ headers, params, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "moderation")) return respondError(set, 403, "forbidden");
      const revoked = await db.begin(async (transaction) => {
        const [warning] = await transaction<{ id: string; user_id: string }[]>`
          update instance_user_warnings set revoked_at = coalesce(revoked_at, now())
          where id = ${params.warningId} and revoked_at is null
          returning id, user_id
        `;
        if (!warning) return undefined;
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, target_user_id, details
          ) values (
            ${operator.id}, ${operator.username}, ${operator.username}, 'user.warning_revoked', ${warning.user_id},
            ${JSON.stringify({ warningId: warning.id })}::jsonb
          )
        `;
        return warning;
      });
      if (!revoked) return respondError(set, 404, "warning_not_found");
      return { revoked: true };
    }, {
      params: t.Object({ warningId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/instance-admin/users/:userId/suspend", async ({ body, headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      const [target] = await db<{ id: string }[]>`select id from users where id = ${params.userId}`;
      if (!target) return respondError(set, 404, "user_not_found");
      if (body.reportId) {
        const [report] = await db<{ id: string }[]>`
          select id from instance_reports where id = ${body.reportId} and target_user_id = ${params.userId}
        `;
        if (!report) return respondError(set, 400, "report_target_mismatch");
      }
      await db.begin(async (transaction) => {
        await transaction`
          insert into instance_user_suspensions (
            user_id, created_by, created_by_username, created_by_display_name, report_id, reason
          ) values (
            ${params.userId}, ${user.id}, ${user.username}, ${user.username}, ${body.reportId ?? null}, ${body.reason?.trim() || null}
          )
          on conflict (user_id) do update
            set created_by = excluded.created_by,
              created_by_username = excluded.created_by_username,
              created_by_display_name = excluded.created_by_display_name,
              report_id = excluded.report_id, reason = excluded.reason, created_at = now()
        `;
        await transaction`delete from sessions where user_id = ${params.userId}`;
        await transaction`delete from fcm_push_subscriptions where user_id = ${params.userId}`;
        if (body.reportId) {
          await transaction`
            update instance_reports set status = 'resolved', reviewed_by = ${user.id},
              reviewed_by_username = ${user.username}, reviewed_by_display_name = ${user.username}, reviewed_at = now()
            where id = ${body.reportId}
          `;
        }
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, report_id, target_user_id, details
          ) values (
            ${user.id}, ${user.username}, ${user.username}, 'user.suspended', ${body.reportId ?? null}, ${params.userId},
            ${JSON.stringify({ reason: body.reason?.trim() || null })}::jsonb
          )
        `;
      });
      closeSocketsForUser(params.userId);
      return { suspended: true };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
      body: t.Object({
        reportId: t.Optional(t.String({ format: "uuid" })),
        reason: t.Optional(t.String({ maxLength: 240 })),
      }),
    })
    .delete("/v1/instance-admin/users/:userId/suspension", async ({ headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      const restored = await db.begin(async (transaction) => {
        const [row] = await transaction<{ report_id: string | null }[]>`
          delete from instance_user_suspensions where user_id = ${params.userId}
          returning report_id
        `;
        if (!row) return undefined;
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, report_id, target_user_id
          ) values (
            ${user.id}, ${user.username}, ${user.username}, 'user.restored', ${row.report_id}, ${params.userId}
          )
        `;
        return row;
      });
      if (!restored) return respondError(set, 404, "user_not_suspended");
      return { restored: true };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    });
