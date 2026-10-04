/**
 * Space (server) role resolution and permission checks.
 *
 * A user's effective permissions are the union of their assigned roles, with the `everyone` role
 * ignored as soon as any non-`everyone` role is assigned. This module is the single place that
 * decides what a member may do, so every route asks it rather than re-deriving permissions.
 */

import { db } from "../db/client";
import { objectValue } from "../http/validation";

export const serverPermissionNames = [
  "view_channels",
  "send_messages",
  "upload_files",
  "view_members",
  "mention_everyone",
  "mention_here",
  "mention_roles",
  "manage_server",
  "manage_channels",
  "create_channels",
  "edit_channels",
  "reorder_channels",
  "archive_channels",
  "manage_categories",
  "manage_channel_access",
  "manage_invites",
  "view_invites",
  "create_invites",
  "revoke_invites",
  "manage_invite_limits",
  "manage_roles",
  "create_roles",
  "edit_roles",
  "delete_roles",
  "assign_roles",
  "reorder_roles",
  "manage_role_permissions",
  "manage_role_appearance",
  "manage_members",
  "kick_members",
  "view_moderation_records",
  "ban_members",
  "unban_members",
  "timeout_members",
  "remove_timeouts",
  "warn_members",
  "revoke_warnings",
  "pin_messages",
  "delete_others_messages",
  "delete_messages",
  "manage_custom_emoji",
  "view_audit_logs",
] as const;

export type ServerPermission = typeof serverPermissionNames[number];
export type ServerPermissionMap = Record<ServerPermission, boolean>;
export type ServerSystemKey = "owner" | "admin" | "everyone" | "member";

export type ServerAuthorizationRole = {
  id: string;
  permissions: unknown;
  view_all_channels: boolean;
  position: number;
  is_system: boolean;
  system_key: ServerSystemKey | null;
};

export type ServerAuthorization = {
  role: "owner" | "admin" | "member";
  ownerId: string;
  isOwner: boolean;
  roles: ServerAuthorizationRole[];
  permissions: ServerPermissionMap;
};

/** The shape a role needs for a hierarchy comparison, without pulling in the full row type. */
export type PositionedRole = { position: number; is_system: boolean };

export function permissionMap(value: unknown, fallback: Partial<ServerPermissionMap> = {}) {
  const object = objectValue(value);
  return Object.fromEntries(serverPermissionNames.map((name) => [
    name,
    object && Object.prototype.hasOwnProperty.call(object, name)
      ? object[name] === true
      : fallback[name] === true,
  ])) as ServerPermissionMap;
}

/** Permissions for a role that predates the per-role system, derived from the membership tier. */
export function defaultRolePermissions(systemKey: ServerSystemKey): ServerPermissionMap {
  if (systemKey === "owner") {
    return permissionMap(undefined, Object.fromEntries(serverPermissionNames.map((name) => [name, true])));
  }
  if (systemKey === "admin") {
    return permissionMap(undefined, {
      view_channels: true,
      send_messages: true,
      upload_files: true,
      view_members: true,
      mention_everyone: true,
      mention_here: true,
      mention_roles: true,
      manage_server: true,
      manage_custom_emoji: true,
      view_audit_logs: true,
      manage_channels: true,
      create_channels: true,
      edit_channels: true,
      reorder_channels: true,
      archive_channels: true,
      manage_categories: true,
      manage_channel_access: true,
      manage_invites: true,
      view_invites: true,
      create_invites: true,
      revoke_invites: true,
      manage_invite_limits: true,
      manage_members: true,
      kick_members: true,
      view_moderation_records: true,
      ban_members: true,
      unban_members: true,
      timeout_members: true,
      remove_timeouts: true,
      warn_members: true,
      revoke_warnings: true,
      pin_messages: true,
      delete_others_messages: true,
      delete_messages: true,
    });
  }
  return permissionMap(undefined, {
    view_channels: true,
    send_messages: true,
    upload_files: true,
    view_members: true,
    pin_messages: true,
  });
}

/** Owners bypass every permission check, so this is the shape every guard funnels through. */
export function hasServerPermission(authorization: ServerAuthorization, permission: ServerPermission) {
  return authorization.isOwner || authorization.permissions[permission];
}

export function hasAnyServerPermission(authorization: ServerAuthorization, ...permissions: ServerPermission[]) {
  return authorization.isOwner || permissions.some((permission) => authorization.permissions[permission]);
}

export function highestRolePosition(authorization: ServerAuthorization) {
  return Math.max(...authorization.roles.map((role) => role.position), 0);
}

export function canManageRoleHierarchy(authorization: ServerAuthorization, role: PositionedRole) {
  if (authorization.isOwner) return true;
  return !role.is_system && role.position < highestRolePosition(authorization);
}

export function canManageRole(
  authorization: ServerAuthorization,
  role: PositionedRole,
  ...permissions: ServerPermission[]
) {
  const requiredPermissions: ServerPermission[] = permissions.length > 0 ? permissions : ["manage_roles"];
  if (!hasAnyServerPermission(authorization, ...requiredPermissions, "manage_roles")) return false;
  return canManageRoleHierarchy(authorization, role);
}

/**
 * Whether `actor` outranks `target`.
 *
 * A moderator can only act on someone strictly below them. Used by ban, kick, timeout, and warning
 * routes, and deliberately strict: a self-comparison fails because the positions are equal.
 */
export function canModerateTarget(actor: ServerAuthorization, target: ServerAuthorization) {
  if (actor.isOwner) return true;
  return highestRolePosition(target) < highestRolePosition(actor);
}

export async function serverMembership(serverId: string, userId: string) {
  const [membership] = await db<{ role: "owner" | "admin" | "member" }[]>`
    select sm.role from server_members sm
    join servers s on s.id = sm.server_id
    where sm.server_id = ${serverId} and sm.user_id = ${userId} and sm.left_at is null
      and s.deactivated_at is null
  `;
  return membership;
}

/**
 * Resolves a member's effective roles and permissions, or `undefined` when they are not an active
 * member of an active space.
 */
export async function serverAuthorization(serverId: string, userId: string) {
  const [membership] = await db<{
    role: "owner" | "admin" | "member";
    owner_id: string;
  }[]>`
    select sm.role, s.owner_id
    from server_members sm
    join servers s on s.id = sm.server_id
    where sm.server_id = ${serverId} and sm.user_id = ${userId} and sm.left_at is null
      and s.deactivated_at is null
  `;
  if (!membership) return undefined;

  const roles = await db<ServerAuthorizationRole[]>`
    select sr.id, sr.permissions, sr.view_all_channels, sr.position, sr.is_system, sr.system_key
    from server_member_roles smr
    join server_roles sr on sr.id = smr.role_id and sr.server_id = smr.server_id
    where smr.server_id = ${serverId} and smr.user_id = ${userId}
    order by sr.position desc, sr.created_at asc
  `;
  // An assigned non-default role replaces `everyone` rather than adding to it, so an elevated
  // member does not silently keep the default role's grants.
  const assignedRoles = roles.some((role) => role.system_key !== "everyone")
    ? roles.filter((role) => role.system_key !== "everyone")
    : roles;
  const effectiveRoles: ServerAuthorizationRole[] = assignedRoles.length > 0
    ? assignedRoles
    : [{
      id: "legacy",
      permissions: defaultRolePermissions(membership.role === "member" ? "everyone" : membership.role),
      view_all_channels: true,
      position: membership.role === "owner" ? 100_000 : membership.role === "admin" ? 90_000 : 0,
      is_system: true,
      system_key: (membership.role === "member" ? "everyone" : membership.role) as ServerSystemKey,
    }];
  const permissions = permissionMap(undefined);
  for (const role of effectiveRoles) {
    const rolePermissions = permissionMap(
      role.permissions,
      role.system_key ? defaultRolePermissions(role.system_key) : undefined,
    );
    for (const name of serverPermissionNames) permissions[name] ||= rolePermissions[name];
  }
  return {
    role: membership.role,
    ownerId: membership.owner_id,
    isOwner: membership.owner_id === userId || membership.role === "owner",
    roles: effectiveRoles,
    permissions,
  } satisfies ServerAuthorization;
}
