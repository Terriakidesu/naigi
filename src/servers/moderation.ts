/**
 * Space moderation, invites, and membership changes.
 *
 * Every action here requires the actor to outrank the target, and the hierarchy check fails closed:
 * an unresolvable target is refused rather than allowed. Actions that remove access also invalidate
 * the realtime membership cache, so an open socket stops delivering immediately rather than after
 * the cache expires.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { db } from "../db/client";
import { recordServerAudit } from "../http/audit";
import { respondError } from "../http/responses";
import { clearMembershipCacheFor } from "../realtime";
import { hashInviteToken, newInviteToken } from "./invite-tokens";
import { syncServerChannelMemberships } from "./membership";
import {
  canModerateTarget,
  hasAnyServerPermission,
  serverAuthorization,
  serverMembership,
} from "./permissions";

export const moderationRoutes = new Elysia()
  .get("/v1/me/server-warnings", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      const warnings = await db<{
        id: string;
        server_id: string;
        reason: string;
        created_at: Date;
        expires_at: Date | null;
      }[]>`
        select id, server_id, reason, created_at, expires_at
        from server_member_warnings
        where user_id = ${user.id} and acknowledged_at is null and revoked_at is null
          and (expires_at is null or expires_at > now())
        order by created_at desc limit 50
      `;
      return { warnings: warnings.map((warning) => ({
        id: warning.id,
        serverId: warning.server_id,
        reason: warning.reason,
        createdAt: warning.created_at,
        expiresAt: warning.expires_at,
      })) };
    })
    .patch("/v1/me/server-warnings/:warningId/acknowledge", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      const [warning] = await db<{ id: string }[]>`
        update server_member_warnings set acknowledged_at = coalesce(acknowledged_at, now())
        where id = ${params.warningId} and user_id = ${user.id} and revoked_at is null
          and (expires_at is null or expires_at > now())
        returning id
      `;
      if (!warning) return respondError(set, 404, "warning_not_found");
      return { acknowledged: true };
    }, {
      params: t.Object({ warningId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/members/:userId/warnings", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(authorization, "manage_members", "warn_members")) return respondError(set, 403, "insufficient_server_permissions");
      if (params.userId === user.id) return respondError(set, 400, "cannot_moderate_self");
      const target = await serverAuthorization(params.serverId, params.userId);
      if (!target) return respondError(set, 404, "server_member_not_found");
      if (target.isOwner || !canModerateTarget(authorization, target)) return respondError(set, 403, "insufficient_server_permissions");
      const reason = body.reason.trim();
      if (!reason) return respondError(set, 422, "warning_reason_required");
      const expiresInSeconds = body.expiresInSeconds ?? null;
      const warning = await db.begin(async (transaction) => {
        const [created] = await transaction<{ id: string; created_at: Date; expires_at: Date | null }[]>`
          insert into server_member_warnings (server_id, user_id, created_by, reason, expires_at)
          values (
            ${params.serverId}, ${params.userId}, ${user.id}, ${reason},
            case when ${expiresInSeconds}::integer is null then null::timestamptz
              else now() + make_interval(secs => ${expiresInSeconds}::integer) end
          ) returning id, created_at, expires_at
        `;
        await transaction`
          insert into server_audit_logs (server_id, actor_id, action, target_id, target_user_id)
          values (${params.serverId}, ${user.id}, 'member.warned', ${created.id}, ${params.userId})
        `;
        return created;
      });
      set.status = 201;
      return { warning: { id: warning.id, createdAt: warning.created_at, expiresAt: warning.expires_at } };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), userId: t.String({ format: "uuid" }) }),
      body: t.Object({
        reason: t.String({ minLength: 1, maxLength: 240 }),
        expiresInSeconds: t.Optional(t.Integer({ minimum: 300, maximum: 31_536_000 })),
      }),
    })
    .delete("/v1/servers/:serverId/warnings/:warningId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(authorization, "manage_members", "revoke_warnings")) return respondError(set, 403, "insufficient_server_permissions");
      const [warning] = await db<{ id: string; user_id: string }[]>`
        select id, user_id from server_member_warnings
        where id = ${params.warningId} and server_id = ${params.serverId} and revoked_at is null
      `;
      if (!warning) return respondError(set, 404, "warning_not_found");
      // Fails closed. The previous guard only ran when the target still resolved to a member, so a
      // warning against someone who had since left the server skipped the hierarchy check entirely
      // and could be revoked by anyone holding `revoke_warnings`. An ex-member cannot outrank the
      // actor, but the safe reading of an unresolvable target is to refuse rather than allow.
      const target = await serverAuthorization(params.serverId, warning.user_id);
      if (!target) return respondError(set, 403, "insufficient_server_permissions");
      if (target.isOwner || !canModerateTarget(authorization, target)) {
        return respondError(set, 403, "insufficient_server_permissions");
      }
      const revoked = await db.begin(async (transaction) => {
        const [row] = await transaction<{ id: string }[]>`
          update server_member_warnings set revoked_at = coalesce(revoked_at, now())
          where id = ${warning.id} and revoked_at is null returning id
        `;
        if (!row) return undefined;
        await transaction`
          insert into server_audit_logs (server_id, actor_id, action, target_id, target_user_id)
          values (${params.serverId}, ${user.id}, 'member.warning_revoked', ${warning.id}, ${warning.user_id})
        `;
        return row;
      });
      if (!revoked) return respondError(set, 404, "warning_not_found");
      return { revoked: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), warningId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/members/:userId/ban", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(authorization, "manage_members", "ban_members")) return respondError(set, 403, "insufficient_server_permissions");
      if (params.userId === user.id) return respondError(set, 400, "cannot_moderate_self");
      const target = await serverAuthorization(params.serverId, params.userId);
      if (!target) return respondError(set, 404, "server_member_not_found");
      if (target.isOwner || !canModerateTarget(authorization, target)) return respondError(set, 403, "insufficient_server_permissions");

      await db.begin(async (transaction) => {
        await transaction`
          update server_bans set revoked_at = now()
          where server_id = ${params.serverId} and user_id = ${params.userId} and revoked_at is null
        `;
        await transaction`
          insert into server_bans (server_id, user_id, created_by, reason, expires_at)
          values (
            ${params.serverId}, ${params.userId}, ${user.id}, ${body.reason ?? null},
            ${body.expiresInSeconds ? db`now() + make_interval(secs => ${body.expiresInSeconds})` : null}
          )
        `;
        await transaction`
          update server_members set left_at = now()
          where server_id = ${params.serverId} and user_id = ${params.userId} and left_at is null
        `;
        await transaction`
          update conversation_members cm set left_at = now()
          from channels c
          where c.server_id = ${params.serverId} and c.conversation_id = cm.conversation_id
            and cm.user_id = ${params.userId} and cm.left_at is null
        `;
      });
      // Drop memoised realtime membership for the banned user so their open sockets stop
      // receiving events immediately rather than after the cache TTL.
      clearMembershipCacheFor(params.serverId, params.userId);
      await recordServerAudit(params.serverId, user.id, "member.banned", params.userId, params.userId);
      return { banned: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), userId: t.String({ format: "uuid" }) }),
      body: t.Object({
        reason: t.Optional(t.String({ maxLength: 240 })),
        expiresInSeconds: t.Optional(t.Integer({ minimum: 300, maximum: 31_536_000 })),
      }),
    })
    .delete("/v1/servers/:serverId/bans/:userId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(authorization, "manage_members", "unban_members")) return respondError(set, 403, "insufficient_server_permissions");
      const [revoked] = await db<{ id: string }[]>`
        update server_bans set revoked_at = coalesce(revoked_at, now())
        where server_id = ${params.serverId} and user_id = ${params.userId} and revoked_at is null
        returning id
      `;
      if (!revoked) return respondError(set, 404, "ban_not_found");
      await recordServerAudit(params.serverId, user.id, "member.unbanned", params.userId, params.userId);
      return { revoked: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), userId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/members/:userId/timeout", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(authorization, "manage_members", "timeout_members")) return respondError(set, 403, "insufficient_server_permissions");
      if (params.userId === user.id) return respondError(set, 400, "cannot_moderate_self");
      const target = await serverAuthorization(params.serverId, params.userId);
      if (!target) return respondError(set, 404, "server_member_not_found");
      if (target.isOwner || !canModerateTarget(authorization, target)) return respondError(set, 403, "insufficient_server_permissions");
      const [timeout] = await db<{ id: string; expires_at: Date }[]>`
        insert into server_timeouts (server_id, user_id, created_by, reason, expires_at)
        values (
          ${params.serverId}, ${params.userId}, ${user.id}, ${body.reason ?? null},
          now() + make_interval(secs => ${body.durationSeconds})
        )
        on conflict (server_id, user_id) where revoked_at is null do update set
          created_by = excluded.created_by,
          reason = excluded.reason,
          expires_at = excluded.expires_at,
          created_at = now(),
          revoked_at = null
        returning id, expires_at
      `;
      await recordServerAudit(params.serverId, user.id, "member.timed_out", params.userId, params.userId);
      return { timedOut: true, expiresAt: timeout.expires_at };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), userId: t.String({ format: "uuid" }) }),
      body: t.Object({
        durationSeconds: t.Integer({ minimum: 60, maximum: 2_592_000 }),
        reason: t.Optional(t.String({ maxLength: 240 })),
      }),
    })
    .delete("/v1/servers/:serverId/timeouts/:userId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(authorization, "manage_members", "remove_timeouts")) return respondError(set, 403, "insufficient_server_permissions");
      const [revoked] = await db<{ id: string }[]>`
        update server_timeouts set revoked_at = coalesce(revoked_at, now())
        where server_id = ${params.serverId} and user_id = ${params.userId} and revoked_at is null
        returning id
      `;
      if (!revoked) return respondError(set, 404, "timeout_not_found");
      await recordServerAudit(params.serverId, user.id, "member.timeout_removed", params.userId, params.userId);
      return { revoked: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), userId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/servers/:serverId/invites", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_invites", "view_invites")) return respondError(set, 403, "insufficient_server_permissions");
      const invites = await db<{
        id: string;
        max_uses: number;
        uses: number;
        expires_at: Date | null;
        revoked_at: Date | null;
        created_at: Date;
      }[]>`
        select id, max_uses, uses, expires_at, revoked_at, created_at
        from server_invites
        where server_id = ${params.serverId}
        order by created_at desc
        limit 100
      `;
      return {
        invites: invites.map((invite) => ({
          id: invite.id,
          maxUses: invite.max_uses,
          uses: invite.uses,
          expiresAt: invite.expires_at,
          revokedAt: invite.revoked_at,
          createdAt: invite.created_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/invites", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_invites", "create_invites")) return respondError(set, 403, "insufficient_server_permissions");
      if ((body.maxUses !== undefined || body.expiresInSeconds !== undefined)
        && !hasAnyServerPermission(membership, "manage_invites", "manage_invite_limits")) {
        return respondError(set, 403, "insufficient_server_permissions");
      }

      const token = newInviteToken();
      const tokenHash = await hashInviteToken(token);
      const [invite] = await db.begin(async (transaction) => {
        await transaction`
          update server_invites
          set revoked_at = coalesce(revoked_at, now())
          where server_id = ${params.serverId} and revoked_at is null
        `;
        return transaction<{
          id: string;
          expires_at: Date | null;
          max_uses: number;
        }[]>`
          insert into server_invites (server_id, created_by, token_hash, max_uses, expires_at)
          values (
            ${params.serverId}, ${user.id}, ${tokenHash}, ${body.maxUses ?? 0},
            ${body.expiresInSeconds ? transaction`now() + make_interval(secs => ${body.expiresInSeconds})` : null}
          )
          returning id, expires_at, max_uses
        `;
      });
      set.status = 201;
      await recordServerAudit(params.serverId, user.id, "invite.created", invite.id);
      return { invite: { id: invite.id, token, maxUses: invite.max_uses, expiresAt: invite.expires_at } };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        maxUses: t.Optional(t.Integer({ minimum: 0, maximum: 100_000 })),
        expiresInSeconds: t.Optional(t.Integer({ minimum: 300, maximum: 2_592_000 })),
      }),
    })
    .post("/v1/invites/:token/accept", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const tokenHash = await hashInviteToken(params.token);

      const result = await db.begin(async (transaction) => {
        const [invite] = await transaction<{
          id: string;
          server_id: string;
          deactivated_at: Date | null;
          onboarding_channel_id: string | null;
          max_uses: number;
          uses: number;
          expires_at: Date | null;
          revoked_at: Date | null;
        }[]>`
           select i.id, i.server_id, s.deactivated_at, s.onboarding_channel_id,
             i.max_uses, i.uses, i.expires_at, i.revoked_at
           from server_invites i
           join servers s on s.id = i.server_id
           where i.token_hash = ${tokenHash} for update of i, s
         `;
        if (!invite) return { error: "invite_not_found" as const };
        if (invite.deactivated_at) return { error: "space_deactivated" as const };
        if (invite.revoked_at || (invite.expires_at && invite.expires_at.getTime() <= Date.now())) {
          return { error: "invite_expired" as const };
        }
        if (invite.max_uses > 0 && invite.uses >= invite.max_uses) return { error: "invite_exhausted" as const };
        const [activeBan] = await transaction<{ id: string }[]>`
          select id from server_bans
          where server_id = ${invite.server_id} and user_id = ${user.id}
            and revoked_at is null and (expires_at is null or expires_at > now())
          limit 1
        `;
        if (activeBan) return { error: "server_banned" as const };

        const [existingMember] = await transaction<{ left_at: Date | null }[]>`
          select left_at from server_members
          where server_id = ${invite.server_id} and user_id = ${user.id}
        `;
        if (existingMember && existingMember.left_at === null) {
          return { serverId: invite.server_id, onboardingChannelId: invite.onboarding_channel_id, joined: false };
        }

        await transaction`
          insert into server_members (server_id, user_id, role)
          values (${invite.server_id}, ${user.id}, 'member')
          on conflict (server_id, user_id) do update
          set role = case when server_members.role in ('owner', 'admin') then server_members.role else 'member' end,
              left_at = null,
               joined_at = now()
        `;
        await transaction`
          insert into server_member_roles (server_id, user_id, role_id)
          select ${invite.server_id}, ${user.id}, id
          from server_roles
          where server_id = ${invite.server_id}
            and system_key = 'everyone'
          on conflict do nothing
        `;
        await transaction`
          insert into conversation_members (conversation_id, user_id, role)
          select c.conversation_id, ${user.id}, 'member'
          from channels c
          join servers s on s.id = c.server_id
          where c.server_id = ${invite.server_id} and c.archived_at is null
            and (
              c.id = (select anchor.id from channels anchor where anchor.server_id = c.server_id and anchor.archived_at is null order by anchor.created_at asc, anchor.id asc limit 1)
              or exists (
                select 1
                from server_member_roles smr
                join server_roles sr on sr.id = smr.role_id
                where smr.server_id = c.server_id and smr.user_id = ${user.id}
                  and sr.permissions->>'view_channels' = 'true'
                  and not (
                    sr.system_key is not distinct from 'everyone'
                    and exists (
                      select 1
                      from server_member_roles elevated_smr
                      join server_roles elevated_sr on elevated_sr.id = elevated_smr.role_id
                      where elevated_smr.server_id = smr.server_id
                        and elevated_smr.user_id = smr.user_id
                        and elevated_sr.system_key is distinct from 'everyone'
                    )
                  )
                   and (
                     sr.view_all_channels
                     or exists (
                       select 1 from server_role_category_access src
                       where src.role_id = sr.id and src.category_id = c.category_id
                         and (src.can_view or src.can_upload)
                     )
                   )
              )
            )
          on conflict (conversation_id, user_id) do update set left_at = null
        `;
        await transaction`
          update server_invites set uses = uses + 1 where id = ${invite.id}
        `;
        return { serverId: invite.server_id, onboardingChannelId: invite.onboarding_channel_id, joined: true };
      });

      if ("error" in result) {
        const error = result.error ?? "invite_not_found";
        return respondError(set, error === "invite_not_found" ? 404 : 409, error);
      }
      if (result.joined) await recordServerAudit(result.serverId, user.id, "member.joined", user.id, user.id);
      return { serverId: result.serverId, onboardingChannelId: result.onboardingChannelId, joined: result.joined };
    }, {
      params: t.Object({ token: t.String({ minLength: 20, maxLength: 255 }) }),
    })
    .delete("/v1/servers/:serverId/members/:userId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_members", "kick_members")) return respondError(set, 403, "insufficient_server_permissions");
      if (params.userId === user.id) return respondError(set, 400, "use_leave_server");

      const [target] = await db<{ role: "owner" | "admin" | "member" }[]>`
        select role from server_members
        where server_id = ${params.serverId} and user_id = ${params.userId} and left_at is null
      `;
      if (!target) return respondError(set, 404, "server_member_not_found");
      if (target.role === "owner") return respondError(set, 400, "cannot_remove_server_owner");
      const targetAuthorization = await serverAuthorization(params.serverId, params.userId);
      if (!targetAuthorization || !canModerateTarget(membership, targetAuthorization)) {
        return respondError(set, 403, "role_hierarchy_violation");
      }

      await db.begin(async (transaction) => {
        await transaction`
          update server_members set left_at = now()
          where server_id = ${params.serverId} and user_id = ${params.userId}
        `;
        await transaction`
          update conversation_members cm
          set left_at = now()
          from channels c
          where c.server_id = ${params.serverId}
            and c.conversation_id = cm.conversation_id
            and cm.user_id = ${params.userId}
            and cm.left_at is null
        `;
      });
      clearMembershipCacheFor(params.serverId, params.userId);
      await recordServerAudit(params.serverId, user.id, "member.kicked", params.userId, params.userId);
      return { removed: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), userId: t.String({ format: "uuid" }) }),
    })
    .patch("/v1/servers/:serverId/members/:userId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!membership.isOwner) return respondError(set, 403, "only_server_owner_can_change_roles");
      if (params.userId === user.id) return respondError(set, 400, "cannot_change_owner_role");

      const [target] = await db<{ role: "owner" | "admin" | "member" }[]>`
        select role from server_members
        where server_id = ${params.serverId} and user_id = ${params.userId} and left_at is null
      `;
      if (!target) return respondError(set, 404, "server_member_not_found");
      await db.begin(async (transaction) => {
        await transaction`
          update server_members set role = ${body.role}
          where server_id = ${params.serverId} and user_id = ${params.userId}
        `;
        await transaction`
          delete from server_member_roles smr
          using server_roles sr
          where smr.role_id = sr.id and smr.server_id = ${params.serverId}
            and smr.user_id = ${params.userId} and sr.system_key = 'admin'
        `;
        await transaction`
          insert into server_member_roles (server_id, user_id, role_id)
          select ${params.serverId}, ${params.userId}, id
          from server_roles
          where server_id = ${params.serverId} and system_key = 'everyone'
          on conflict do nothing
        `;
        if (body.role === "admin") {
          await transaction`
            insert into server_member_roles (server_id, user_id, role_id)
            select ${params.serverId}, ${params.userId}, id
            from server_roles
            where server_id = ${params.serverId} and system_key = 'admin'
            on conflict do nothing
          `;
        }
      });
      await syncServerChannelMemberships(params.serverId);
      await recordServerAudit(params.serverId, user.id, "member.legacy_role_updated", params.userId, params.userId);
      return { updated: true, role: body.role };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), userId: t.String({ format: "uuid" }) }),
      body: t.Object({ role: t.Union([t.Literal("admin"), t.Literal("member")]) }),
    })
    .post("/v1/servers/:serverId/leave", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 404, "not_a_server_member");
      if (membership.role === "owner") return respondError(set, 400, "server_owner_must_transfer_ownership");

      await db.begin(async (transaction) => {
        await transaction`
          update server_members set left_at = now()
          where server_id = ${params.serverId} and user_id = ${user.id} and left_at is null
        `;
        await transaction`
          update conversation_members cm
          set left_at = now()
          from channels c
          where c.server_id = ${params.serverId}
            and c.conversation_id = cm.conversation_id
            and cm.user_id = ${user.id}
            and cm.left_at is null
        `;
      });
      await recordServerAudit(params.serverId, user.id, "member.left", user.id, user.id);
      return { left: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .delete("/v1/servers/:serverId/invites/:inviteId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_invites", "revoke_invites")) return respondError(set, 403, "insufficient_server_permissions");
      const [revoked] = await db<{ id: string }[]>`
        update server_invites
        set revoked_at = coalesce(revoked_at, now())
        where id = ${params.inviteId} and server_id = ${params.serverId}
        returning id
      `;
      if (!revoked) return respondError(set, 404, "invite_not_found");
      await recordServerAudit(params.serverId, user.id, "invite.revoked", params.inviteId);
      return { revoked: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), inviteId: t.String({ format: "uuid" }) }),
    });
