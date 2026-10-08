/**
 * Member lists, roles, and per-role channel and category grants.
 *
 * Role edits are the most privilege-sensitive operations in the app, so each one re-derives the
 * actor's authorization, checks the hierarchy against the role being changed, and resynchronises
 * channel membership afterwards so a permission change takes effect for message history rather
 * than only for new sends.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { db } from "../db/client";
import { InvalidEncodingError } from "../encoding";
import { profileBannerUrl, profileImageUrl } from "../profile-images";
import { recordServerAudit } from "../http/audit";
import { respondError } from "../http/responses";
import { decodeEncryptedMetadata, stringArray } from "../http/validation";
import { syncChannelConversationMembership, syncServerChannelMemberships } from "./membership";
import {
  canManageRole,
  canManageRoleHierarchy,
  canModerateTarget,
  defaultRolePermissions,
  hasAnyServerPermission,
  hasServerPermission,
  highestRolePosition,
  serverAuthorization,
} from "./permissions";
import { publicServerRole, rolePermissionInput, validRoleColor, type ServerRoleRow } from "./roles";

export const roleRoutes = new Elysia()
  .get("/v1/servers/:serverId/members", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "view_members")) return respondError(set, 403, "insufficient_server_permissions");

      const members = await db<{
        id: string;
        username: string;
        display_name: string;
        profile_image_storage_key: string | null;
        profile_banner_storage_key: string | null;
        role: "owner" | "admin" | "member";
        role_ids: string[];
        joined_at: Date;
      }[]>`
        select u.id, u.username, u.display_name, u.profile_image_storage_key,
          u.profile_banner_storage_key, sm.role,
          coalesce(array_agg(smr.role_id order by smr.assigned_at asc) filter (where smr.role_id is not null), array[]::uuid[]) as role_ids,
          sm.joined_at
        from server_members sm
        join users u on u.id = sm.user_id
        left join server_member_roles smr on smr.server_id = sm.server_id and smr.user_id = sm.user_id
        where sm.server_id = ${params.serverId} and sm.left_at is null
        group by u.id, u.username, u.display_name, u.profile_image_storage_key,
          u.profile_banner_storage_key, sm.role, sm.joined_at
        order by sm.joined_at asc
      `;
      return {
        members: members.map((member) => ({
          userId: member.id,
          username: member.username,
          displayName: member.display_name,
          avatarUrl: profileImageUrl(member.id, member.profile_image_storage_key),
          bannerUrl: profileBannerUrl(member.id, member.profile_banner_storage_key),
          role: member.role,
          roleIds: stringArray(member.role_ids),
          joinedAt: member.joined_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/servers/:serverId/roles", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");

      const roles = await db<ServerRoleRow[]>`
        select id, server_id, encrypted_metadata, color, position, permissions,
          mentionable, separate_members, view_all_channels, is_system, system_key, created_at, updated_at
        from server_roles
        where server_id = ${params.serverId}
        order by position desc, created_at asc
      `;
      const roleIds = roles.map((role) => role.id);
      const access = roleIds.length === 0
        ? []
        : await db<{ role_id: string; channel_id: string; can_view: boolean; can_upload: boolean }[]>`
            select role_id, channel_id, can_view, can_upload
            from server_role_channel_access
            where role_id in ${db(roleIds)}
          `;
      const categoryAccess = roleIds.length === 0
        ? []
        : await db<{ role_id: string; category_id: string; can_view: boolean; can_upload: boolean }[]>`
            select role_id, category_id, can_view, can_upload
            from server_role_category_access
            where role_id in ${db(roleIds)}
          `;
      const assignments = await db<{ user_id: string; role_ids: string[] }[]>`
        select user_id,
          coalesce(array_agg(role_id order by assigned_at asc), array[]::uuid[]) as role_ids
        from server_member_roles
        where server_id = ${params.serverId}
        group by user_id
      `;
      const [metadataChannel] = await db<{ conversation_id: string }[]>`
        select conversation_id from channels
        where server_id = ${params.serverId} and archived_at is null
        order by created_at asc, id asc
        limit 1
      `;
      return {
        metadataConversationId: metadataChannel?.conversation_id ?? null,
        permissions: authorization.permissions,
         roles: roles.map((role) => publicServerRole(
           role,
           access.filter((item) => item.role_id === role.id),
           categoryAccess.filter((item) => item.role_id === role.id),
         )),
        assignments: assignments.map((assignment) => ({ userId: assignment.user_id, roleIds: stringArray(assignment.role_ids) })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/roles", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(authorization, "manage_roles", "create_roles")) return respondError(set, 403, "insufficient_server_permissions");
      if (body.color !== undefined && !validRoleColor(body.color)) return respondError(set, 400, "invalid_role_color");
      const permissions = body.permissions === undefined ? defaultRolePermissions("everyone") : rolePermissionInput(body.permissions);
      if (!permissions) return respondError(set, 400, "invalid_role_permissions");

      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }
      const [position] = await db<{ next_position: number }[]>`
        select coalesce(max(position), 0) + 1 as next_position
        from server_roles where server_id = ${params.serverId} and is_system = false
      `;
      const rolePosition = body.position ?? position.next_position;
      if (!authorization.isOwner && rolePosition >= highestRolePosition(authorization)) {
        return respondError(set, 403, "role_hierarchy_violation");
      }
      const [role] = await db<ServerRoleRow[]>`
        insert into server_roles (
          server_id, encrypted_metadata, color, position, permissions, mentionable, separate_members, view_all_channels
        ) values (
          ${params.serverId}, ${metadata}, ${body.color ?? "#92aaa5"}, ${rolePosition},
          ${permissions}::jsonb, ${body.mentionable ?? false}, ${body.separateMembers ?? false}, ${body.viewAllChannels ?? true}
        )
        returning id, server_id, encrypted_metadata, color, position, permissions,
          mentionable, separate_members, view_all_channels, is_system, system_key, created_at, updated_at
      `;
      set.status = 201;
      await recordServerAudit(params.serverId, user.id, "role.created", role.id);
      return { role: publicServerRole(role) };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        color: t.Optional(t.String({ minLength: 7, maxLength: 7 })),
        position: t.Optional(t.Integer({ minimum: 1, maximum: 1_000_000 })),
        permissions: t.Optional(t.Any()),
        mentionable: t.Optional(t.Boolean()),
        separateMembers: t.Optional(t.Boolean()),
        viewAllChannels: t.Optional(t.Boolean()),
      }),
    })
    .patch("/v1/servers/:serverId/roles/:roleId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      const [existing] = await db<ServerRoleRow[]>`
        select id, server_id, encrypted_metadata, color, position, permissions,
          mentionable, separate_members, view_all_channels, is_system, system_key, created_at, updated_at
        from server_roles where id = ${params.roleId} and server_id = ${params.serverId}
      `;
      if (!existing) return respondError(set, 404, "role_not_found");
      if (!canManageRoleHierarchy(authorization, existing)) {
        return respondError(set, 403, "insufficient_server_permissions");
      }
      if (existing.system_key === "owner" && (
        body.encryptedMetadata !== undefined
        || body.color !== undefined
        || body.position !== undefined
        || body.permissions !== undefined
        || body.mentionable !== undefined
        || body.separateMembers !== undefined
        || body.viewAllChannels !== undefined
      )) {
        return respondError(set, 400, "owner_role_is_not_customizable");
      }
      if (existing.system_key === "everyone" && (
        body.encryptedMetadata !== undefined
        || body.color !== undefined
        || body.position !== undefined
        || body.mentionable !== undefined
        || body.separateMembers !== undefined
      )) {
        return respondError(set, 400, "everyone_role_identity_is_not_customizable");
      }
      if (body.encryptedMetadata !== undefined && !hasAnyServerPermission(authorization, "manage_roles", "edit_roles", "manage_role_appearance")) {
        return respondError(set, 403, "insufficient_server_permissions");
      }
      if (body.color !== undefined && !hasAnyServerPermission(authorization, "manage_roles", "manage_role_appearance")) {
        return respondError(set, 403, "insufficient_server_permissions");
      }
      if (body.position !== undefined && !hasAnyServerPermission(authorization, "manage_roles", "reorder_roles")) {
        return respondError(set, 403, "insufficient_server_permissions");
      }
      if (body.permissions !== undefined && !hasAnyServerPermission(authorization, "manage_roles", "manage_role_permissions")) {
        return respondError(set, 403, "insufficient_server_permissions");
      }
      if (body.mentionable !== undefined && !hasAnyServerPermission(authorization, "manage_roles", "manage_role_appearance")) {
        return respondError(set, 403, "insufficient_server_permissions");
      }
      if (body.separateMembers !== undefined && !hasAnyServerPermission(authorization, "manage_roles", "manage_role_appearance")) {
        return respondError(set, 403, "insufficient_server_permissions");
      }
      if (body.viewAllChannels !== undefined && !hasAnyServerPermission(authorization, "manage_roles", "manage_channel_access")) {
        return respondError(set, 403, "insufficient_server_permissions");
      }
      if (body.color !== undefined && !validRoleColor(body.color)) return respondError(set, 400, "invalid_role_color");
      const permissions = body.permissions === undefined ? undefined : rolePermissionInput(body.permissions);
      if (body.permissions !== undefined && !permissions) return respondError(set, 400, "invalid_role_permissions");
      if (!authorization.isOwner && body.position !== undefined && body.position >= highestRolePosition(authorization)) {
        return respondError(set, 403, "role_hierarchy_violation");
      }
      let metadata: Buffer | undefined;
      try {
        metadata = body.encryptedMetadata === undefined ? undefined : decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }
      const [role] = await db<ServerRoleRow[]>`
        update server_roles
        set encrypted_metadata = coalesce(${metadata ?? null}, encrypted_metadata),
            color = coalesce(${body.color ?? null}, color),
            position = coalesce(${body.position ?? null}, position),
            permissions = coalesce(${permissions ?? null}::jsonb, permissions),
            mentionable = coalesce(${body.mentionable ?? null}, mentionable),
            separate_members = coalesce(${body.separateMembers ?? null}, separate_members),
            view_all_channels = coalesce(${body.viewAllChannels ?? null}, view_all_channels),
            updated_at = now()
        where id = ${existing.id}
        returning id, server_id, encrypted_metadata, color, position, permissions,
          mentionable, separate_members, view_all_channels, is_system, system_key, created_at, updated_at
      `;
      await syncServerChannelMemberships(params.serverId);
      await recordServerAudit(params.serverId, user.id, "role.updated", role.id);
      return { role: publicServerRole(role) };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), roleId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        color: t.Optional(t.String({ minLength: 7, maxLength: 7 })),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
        permissions: t.Optional(t.Any()),
        mentionable: t.Optional(t.Boolean()),
        separateMembers: t.Optional(t.Boolean()),
        viewAllChannels: t.Optional(t.Boolean()),
      }),
    })
    .delete("/v1/servers/:serverId/roles/:roleId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      const [role] = await db<{ id: string; is_system: boolean; position: number }[]>`
        select id, is_system, position from server_roles where id = ${params.roleId} and server_id = ${params.serverId}
      `;
      if (!role) return respondError(set, 404, "role_not_found");
      if (role.is_system) return respondError(set, 409, "cannot_delete_system_role");
      if (!canManageRole(authorization, role, "delete_roles")) return respondError(set, 403, "insufficient_server_permissions");
      await db`delete from server_roles where id = ${role.id}`;
      await syncServerChannelMemberships(params.serverId);
      await recordServerAudit(params.serverId, user.id, "role.deleted", role.id);
      return { deleted: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), roleId: t.String({ format: "uuid" }) }),
    })
    .patch("/v1/servers/:serverId/roles/:roleId/channels/:channelId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      const [role] = await db<Pick<ServerRoleRow, "id" | "position" | "is_system" | "system_key">[]>`
        select id, position, is_system, system_key from server_roles where id = ${params.roleId} and server_id = ${params.serverId}
      `;
      const [channel] = await db<{ id: string }[]>`
        select id from channels where id = ${params.channelId} and server_id = ${params.serverId} and archived_at is null
      `;
      if (!role) return respondError(set, 404, "role_not_found");
      if (!channel) return respondError(set, 404, "channel_not_found");
      if (role.is_system && role.system_key === "owner") return respondError(set, 400, "owner_role_is_not_customizable");
      if (!canManageRole(authorization, role, "manage_channel_access")) return respondError(set, 403, "insufficient_server_permissions");
      const canView = body.canView === true || body.canUpload === true;
      const canUpload = body.canUpload === true;
      await db`
        insert into server_role_channel_access (role_id, channel_id, can_view, can_upload)
        values (${role.id}, ${channel.id}, ${canView}, ${canUpload})
        on conflict (role_id, channel_id) do update set
          can_view = excluded.can_view,
          can_upload = excluded.can_upload
      `;
      await syncChannelConversationMembership(params.serverId, channel.id);
      await recordServerAudit(params.serverId, user.id, "role.channel_access_updated", channel.id);
      return { updated: true, canView, canUpload };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), roleId: t.String({ format: "uuid" }), channelId: t.String({ format: "uuid" }) }),
      body: t.Object({ canView: t.Optional(t.Boolean()), canUpload: t.Optional(t.Boolean()) }),
    })
    .delete("/v1/servers/:serverId/roles/:roleId/channels/:channelId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      const [role] = await db<Pick<ServerRoleRow, "id" | "position" | "is_system" | "system_key">[]>`
        select id, position, is_system, system_key from server_roles
        where id = ${params.roleId} and server_id = ${params.serverId}
      `;
      const [channel] = await db<{ id: string }[]>`
        select id from channels
        where id = ${params.channelId} and server_id = ${params.serverId} and archived_at is null
      `;
      if (!role) return respondError(set, 404, "role_not_found");
      if (!channel) return respondError(set, 404, "channel_not_found");
      if (role.is_system && role.system_key === "owner") return respondError(set, 400, "owner_role_is_not_customizable");
      if (!canManageRole(authorization, role, "manage_channel_access")) return respondError(set, 403, "insufficient_server_permissions");
      await db`
        delete from server_role_channel_access src
        using server_roles sr, channels c
        where src.role_id = sr.id and src.channel_id = c.id
          and sr.id = ${params.roleId} and sr.server_id = ${params.serverId}
          and c.id = ${params.channelId} and c.server_id = ${params.serverId}
      `;
      await syncChannelConversationMembership(params.serverId, params.channelId);
      await recordServerAudit(params.serverId, user.id, "role.channel_access_removed", params.channelId);
      return { deleted: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), roleId: t.String({ format: "uuid" }), channelId: t.String({ format: "uuid" }) }),
    })
    .patch("/v1/servers/:serverId/roles/:roleId/categories/:categoryId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      const [role] = await db<Pick<ServerRoleRow, "id" | "position" | "is_system" | "system_key">[]>`
        select id, position, is_system, system_key from server_roles
        where id = ${params.roleId} and server_id = ${params.serverId}
      `;
      const [category] = await db<{ id: string }[]>`
        select id from categories
        where id = ${params.categoryId} and server_id = ${params.serverId} and archived_at is null
      `;
      if (!role) return respondError(set, 404, "role_not_found");
      if (!category) return respondError(set, 404, "category_not_found");
      if (role.is_system && role.system_key === "owner") return respondError(set, 400, "owner_role_is_not_customizable");
      if (!canManageRole(authorization, role, "manage_channel_access")) return respondError(set, 403, "insufficient_server_permissions");
      const canView = body.canView === true || body.canUpload === true;
      const canUpload = body.canUpload === true;
      await db`
        insert into server_role_category_access (role_id, category_id, can_view, can_upload)
        values (${role.id}, ${category.id}, ${canView}, ${canUpload})
        on conflict (role_id, category_id) do update set
          can_view = excluded.can_view,
          can_upload = excluded.can_upload
      `;
      await syncServerChannelMemberships(params.serverId);
      await recordServerAudit(params.serverId, user.id, "role.category_access_updated", category.id);
      return { updated: true, canView, canUpload };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), roleId: t.String({ format: "uuid" }), categoryId: t.String({ format: "uuid" }) }),
      body: t.Object({ canView: t.Optional(t.Boolean()), canUpload: t.Optional(t.Boolean()) }),
    })
    .delete("/v1/servers/:serverId/roles/:roleId/categories/:categoryId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      const [role] = await db<Pick<ServerRoleRow, "id" | "position" | "is_system" | "system_key">[]>`
        select id, position, is_system, system_key from server_roles
        where id = ${params.roleId} and server_id = ${params.serverId}
      `;
      const [category] = await db<{ id: string }[]>`
        select id from categories
        where id = ${params.categoryId} and server_id = ${params.serverId} and archived_at is null
      `;
      if (!role) return respondError(set, 404, "role_not_found");
      if (!category) return respondError(set, 404, "category_not_found");
      if (role.is_system && role.system_key === "owner") return respondError(set, 400, "owner_role_is_not_customizable");
      if (!canManageRole(authorization, role, "manage_channel_access")) return respondError(set, 403, "insufficient_server_permissions");
      await db`
        delete from server_role_category_access
        where role_id = ${role.id} and category_id = ${category.id}
      `;
      await syncServerChannelMemberships(params.serverId);
      await recordServerAudit(params.serverId, user.id, "role.category_access_removed", category.id);
      return { deleted: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), roleId: t.String({ format: "uuid" }), categoryId: t.String({ format: "uuid" }) }),
    })
    .patch("/v1/servers/:serverId/members/:userId/roles", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(authorization, "manage_roles", "assign_roles")) return respondError(set, 403, "insufficient_server_permissions");
      if (params.userId === user.id && authorization.isOwner) return respondError(set, 400, "cannot_change_owner_role");
      const [target] = await db<{ role: "owner" | "admin" | "member" }[]>`
        select role from server_members
        where server_id = ${params.serverId} and user_id = ${params.userId} and left_at is null
      `;
      if (!target) return respondError(set, 404, "server_member_not_found");
      if (target.role === "owner") return respondError(set, 400, "cannot_change_owner_role");
      const targetAuthorization = await serverAuthorization(params.serverId, params.userId);
      if (!targetAuthorization || !canModerateTarget(authorization, targetAuthorization)) {
        return respondError(set, 403, "role_hierarchy_violation");
      }
      const roleIds = [...new Set(body.roleIds)];
      const roles = roleIds.length === 0 ? [] : await db<{ id: string; is_system: boolean; system_key: string | null; position: number }[]>`
        select id, is_system, system_key, position from server_roles
        where server_id = ${params.serverId} and id in ${db(roleIds)}
      `;
      if (roles.length !== roleIds.length) return respondError(set, 400, "invalid_role_assignment");
      const [defaultRole] = await db<{ id: string; is_system: boolean; system_key: string | null; position: number }[]>`
        select id, is_system, system_key, position
        from server_roles
        where server_id = ${params.serverId} and system_key = 'everyone'
      `;
      if (!defaultRole) return respondError(set, 500, "everyone_role_missing");
      const selectedRoles = roles.filter((role) => role.system_key !== "everyone");
      const assignedRoles = [defaultRole, ...selectedRoles];
      if (assignedRoles.some((role) => role.system_key === "owner")) return respondError(set, 400, "cannot_assign_owner_role");
      if (!authorization.isOwner && assignedRoles.some((role) => role.system_key !== "everyone" && role.position >= highestRolePosition(authorization))) {
        return respondError(set, 403, "role_hierarchy_violation");
      }
      const effectiveRoleIds = assignedRoles.map((role) => role.id);
      await db.begin(async (transaction) => {
        await transaction`
          delete from server_member_roles
          where server_id = ${params.serverId} and user_id = ${params.userId}
        `;
        for (const roleId of effectiveRoleIds) {
          await transaction`
            insert into server_member_roles (server_id, user_id, role_id)
            values (${params.serverId}, ${params.userId}, ${roleId})
          `;
        }
        await transaction`
          update server_members
          set role = case when exists (
            select 1 from server_member_roles smr
            join server_roles sr on sr.id = smr.role_id
            where smr.server_id = ${params.serverId} and smr.user_id = ${params.userId} and sr.system_key = 'admin'
          ) then 'admin' else 'member' end
          where server_id = ${params.serverId} and user_id = ${params.userId}
        `;
      });
      await syncServerChannelMemberships(params.serverId);
      await recordServerAudit(params.serverId, user.id, "member.roles_updated", params.userId, params.userId);
      return { updated: true, roleIds: effectiveRoleIds };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), userId: t.String({ format: "uuid" }) }),
      body: t.Object({ roleIds: t.Array(t.String({ format: "uuid" }), { maxItems: 50 }) }),
    })
    .get("/v1/servers/:serverId/moderation", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(authorization, "manage_members", "view_moderation_records")) return respondError(set, 403, "insufficient_server_permissions");
      const bans = await db<{
        id: string;
        user_id: string;
        username: string;
        display_name: string;
        reason: string | null;
        expires_at: Date | null;
        created_at: Date;
      }[]>`
        select b.id, b.user_id, u.username, u.display_name, b.reason, b.expires_at, b.created_at
        from server_bans b
        join users u on u.id = b.user_id
        where b.server_id = ${params.serverId}
          and b.revoked_at is null and (b.expires_at is null or b.expires_at > now())
        order by b.created_at desc
      `;
      const timeouts = await db<{
        id: string;
        user_id: string;
        username: string;
        display_name: string;
        reason: string | null;
        expires_at: Date;
        created_at: Date;
      }[]>`
        select t.id, t.user_id, u.username, u.display_name, t.reason, t.expires_at, t.created_at
        from server_timeouts t
        join users u on u.id = t.user_id
        where t.server_id = ${params.serverId}
          and t.revoked_at is null and t.expires_at > now()
        order by t.expires_at asc
      `;
      const warnings = await db<{
        id: string;
        user_id: string;
        username: string;
        display_name: string;
        created_by_username: string;
        reason: string;
        expires_at: Date | null;
        created_at: Date;
        acknowledged_at: Date | null;
        revoked_at: Date | null;
        active: boolean;
      }[]>`
        select w.id, w.user_id, u.username, u.display_name,
          creator.username as created_by_username, w.reason, w.expires_at, w.created_at, w.acknowledged_at, w.revoked_at,
          (w.revoked_at is null and (w.expires_at is null or w.expires_at > now())) as active
        from server_member_warnings w
        join users u on u.id = w.user_id
        join users creator on creator.id = w.created_by
        where w.server_id = ${params.serverId}
        order by w.created_at desc limit 100
      `;
      return {
        bans: bans.map((ban) => ({
          id: ban.id,
          userId: ban.user_id,
          username: ban.username,
          displayName: ban.display_name,
          reason: ban.reason,
          expiresAt: ban.expires_at,
          createdAt: ban.created_at,
        })),
        timeouts: timeouts.map((timeout) => ({
          id: timeout.id,
          userId: timeout.user_id,
          username: timeout.username,
          displayName: timeout.display_name,
          reason: timeout.reason,
          expiresAt: timeout.expires_at,
          createdAt: timeout.created_at,
        })),
        warnings: warnings.map((warning) => ({
          id: warning.id,
          userId: warning.user_id,
          username: warning.username,
          displayName: warning.display_name,
          createdByUsername: warning.created_by_username,
          reason: warning.reason,
          expiresAt: warning.expires_at,
          createdAt: warning.created_at,
          acknowledgedAt: warning.acknowledged_at,
          revokedAt: warning.revoked_at,
          active: warning.active,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    });
