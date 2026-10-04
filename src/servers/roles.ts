/**
 * Role presentation and input validation.
 */

import { encodeBase64 } from "../encoding";
import { objectValue } from "../http/validation";
import {
  defaultRolePermissions,
  permissionMap,
  serverPermissionNames,
  type ServerSystemKey,
} from "./permissions";

export type ServerRoleRow = {
  id: string;
  server_id: string;
  encrypted_metadata: Buffer;
  color: string;
  position: number;
  permissions: unknown;
  mentionable: boolean;
  separate_members: boolean;
  view_all_channels: boolean;
  is_system: boolean;
  system_key: ServerSystemKey | null;
  created_at: Date;
  updated_at: Date;
};

export function validRoleColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

/**
 * Validates a permission map supplied by a client.
 *
 * Rejects unknown keys and non-boolean values outright rather than silently dropping them, so a
 * caller cannot believe it set a permission that was quietly discarded.
 */
export function rolePermissionInput(value: unknown) {
  const input = objectValue(value);
  if (!input) return null;
  if (Object.keys(input).some((key) => !(serverPermissionNames as readonly string[]).includes(key))) return null;
  if (Object.values(input).some((item) => typeof item !== "boolean")) return null;
  return permissionMap(input);
}

/** Serialises a role for the API. The display name stays encrypted and is never decrypted here. */
export function publicServerRole(
  role: ServerRoleRow,
  channelAccess: Array<{ channel_id: string; can_view: boolean; can_upload: boolean }> = [],
  categoryAccess: Array<{ category_id: string; can_view: boolean; can_upload: boolean }> = [],
) {
  return {
    id: role.id,
    serverId: role.server_id,
    encryptedMetadata: encodeBase64(role.encrypted_metadata),
    color: role.color,
    position: role.position,
    permissions: permissionMap(role.permissions, role.system_key ? defaultRolePermissions(role.system_key) : undefined),
    mentionable: role.mentionable,
    separateMembers: role.separate_members,
    viewAllChannels: role.view_all_channels,
    isSystem: role.is_system,
    systemKey: role.system_key,
    channelAccess: channelAccess.map((access) => ({
      channelId: access.channel_id,
      canView: access.can_view,
      canUpload: access.can_upload,
    })),
    categoryAccess: categoryAccess.map((access) => ({
      categoryId: access.category_id,
      canView: access.can_view,
      canUpload: access.can_upload,
    })),
    createdAt: role.created_at,
    updatedAt: role.updated_at,
  };
}
