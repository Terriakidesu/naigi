import { password } from "bun";
import { createPublicKey } from "node:crypto";
import { Elysia, t } from "elysia";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import {
  AttachmentSizeMismatchError,
  AttachmentTooLargeError,
  attachmentPath,
  encryptedAttachmentExists,
  removeEncryptedAttachment,
  storeEncryptedAttachment,
} from "./attachments/storage";
import {
  authenticate,
  createSession,
  deleteSession,
  extractBearerToken,
  extractCookieToken,
  hashSessionToken,
  normalizeUsername,
  verifyPassword,
} from "./auth/session";
import {
  authenticateAdmin,
  createAdminSession,
  deleteAdminSession,
  extractAdminCookieToken,
  normalizeAdminUsername,
  verifyAdminPassword,
  type AuthenticatedAdmin,
} from "./admin-auth/session";
import { adminCan, type AdminCapability } from "./admin-auth/permissions";
import { config } from "./config";
import { getInstanceLiveResources, getInstanceOperationsOverview, getInstanceOperationsSnapshot } from "./admin-operations";
import {
  liveConnectionRefreshMs,
  refreshLiveConnections,
  registerLiveConnection,
  removeLiveConnection,
} from "./admin-operations/live-connections";
import {
  getStorageMaintenanceSummary,
  inspectStorageMaintenance,
  purgeExpiredQuarantinedStorage,
  quarantineOrphanedStorage,
  restoreQuarantinedStorage,
  StorageMaintenanceError,
} from "./admin-maintenance";
import { decodeBase64, encodeBase64, InvalidEncodingError } from "./encoding";
import { db, pingDatabase } from "./db/client";
import { adminDb, pingAdminDatabase } from "./admin-db/client";
import {
  ProfileImageInvalidError,
  profileBannerUrl,
  profileImageMetadata,
  profileImagePath,
  profileImageUrl,
  removeProfileImage,
  storeProfileImage,
  validProfileImageBytes,
} from "./profile-images";
import { connectRedis, evalRedisScript, pingRedis, publishMessageCreated, redis } from "./redis/client";
import {
  publicFirebaseMessagingConfiguration,
  registerFcmPushToken,
  removeFcmPushToken,
  sendGenericFcmPush,
} from "./push/fcm";
import { createRealtimeConnection, type RealtimeConnection } from "./realtime";
import { fetchTwitterPreview, parseTwitterStatusUrl } from "./twitter-preview";

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
  profile_image_storage_key?: string | null;
  profile_image_mime_type?: string | null;
  profile_image_size_bytes?: number | string | null;
  profile_banner_storage_key?: string | null;
  profile_banner_mime_type?: string | null;
  profile_banner_size_bytes?: number | string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_device_id: string;
  client_message_id: string;
  server_sequence: bigint | number | string;
  protocol: string;
  ciphertext: Buffer;
  protocol_metadata: Buffer;
  created_at: Date;
  sender_user_id?: string;
};

function respondError(set: { status?: number | string }, status: number, error: string) {
  set.status = status;
  return { error };
}

function setSessionCookie(set: { headers: Record<string, string | number | undefined> }, token: string) {
  const secure = config.environment === "production" ? "; Secure" : "";
  set.headers["set-cookie"] =
    `priv_chat_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionTtlSeconds}${secure}`;
}

function clearSessionCookie(set: { headers: Record<string, string | number | undefined> }) {
  const secure = config.environment === "production" ? "; Secure" : "";
  set.headers["set-cookie"] = `priv_chat_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function setAdminSessionCookie(set: { headers: Record<string, string | number | undefined> }, token: string) {
  const secure = config.environment === "production" ? "; Secure" : "";
  set.headers["set-cookie"] =
    `priv_chat_admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionTtlSeconds}${secure}`;
}

function clearAdminSessionCookie(set: { headers: Record<string, string | number | undefined> }) {
  const secure = config.environment === "production" ? "; Secure" : "";
  set.headers["set-cookie"] = `priv_chat_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

async function publicFile(name: string, contentType: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const file = Bun.file(`${import.meta.dir}/../public/${name}`);
  if (!(await file.exists())) return null;
  return new Response(file, { headers: { "cache-control": "no-cache", "content-type": contentType } });
}

async function adminPageResponse(cookie: string | undefined, page: string, requiredCapability?: AdminCapability) {
  const operator = await authenticateAdmin(cookie);
  if (!operator) return publicFile("instance-admin-login.html", "text/html; charset=utf-8");
  if (requiredCapability && !adminCan(operator.role, requiredCapability)) {
    return new Response(null, { status: 302, headers: { location: "/instance-admin", "cache-control": "no-store" } });
  }
  return publicFile(page, "text/html; charset=utf-8");
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const postgresError = error as { code?: string; errno?: string | number; cause?: unknown };
  return postgresError.code === "23505"
    || String(postgresError.errno ?? "") === "23505"
    || isUniqueViolation(postgresError.cause);
}

async function recordInstanceAdminAudit(
  operator: AuthenticatedAdmin,
  action: string,
  reportId: string | null = null,
  targetUserId: string | null = null,
  details: Record<string, unknown> = {},
) {
  await db`
    insert into instance_admin_audit_logs (
      admin_user_id, admin_username, admin_display_name, action, report_id, target_user_id, details
    ) values (
      ${operator.id}, ${operator.username}, ${operator.username}, ${action}, ${reportId}, ${targetUserId}, ${JSON.stringify(details)}::jsonb
    )
  `;
}

async function directConversationIsBlocked(conversationId: string, userId: string) {
  const [result] = await db<{ blocked: boolean }[]>`
    select exists (
      select 1
      from conversations c
      join conversation_members mine on mine.conversation_id = c.id
        and mine.user_id = ${userId} and mine.left_at is null
      join conversation_members other_member on other_member.conversation_id = c.id
        and other_member.user_id <> mine.user_id and other_member.left_at is null
      join user_blocks b on (b.blocker_user_id = mine.user_id and b.blocked_user_id = other_member.user_id)
        or (b.blocker_user_id = other_member.user_id and b.blocked_user_id = mine.user_id)
      where c.id = ${conversationId} and c.kind = 'dm'
    ) as blocked
  `;
  return result?.blocked === true;
}

async function directVoiceCallAccessError(conversationId: string, userId: string) {
  const [suspension] = await db<{ user_id: string }[]>`
    select user_id from instance_user_suspensions where user_id = ${userId}
  `;
  if (suspension) return "account_suspended";
  const [membership] = await db<{ id: string }[]>`
    select c.id
    from conversations c
    join conversation_members cm on cm.conversation_id = c.id
      and cm.user_id = ${userId} and cm.left_at is null
    where c.id = ${conversationId} and c.kind = 'dm'
  `;
  if (!membership) return "not_a_conversation_member";
  if (await directConversationIsBlocked(conversationId, userId)) return "blocked_user";
  return undefined;
}

async function voiceRoomAccessError(channelId: string, userId: string) {
  const [suspension] = await db<{ user_id: string }[]>`
    select user_id from instance_user_suspensions where user_id = ${userId}
  `;
  if (suspension) return { error: "account_suspended" as const };
  const [channel] = await db<{
    id: string;
    server_id: string;
    conversation_id: string;
    kind: string;
    archived_at: Date | null;
  }[]>`
    select id, server_id, conversation_id, kind, archived_at
    from channels where id = ${channelId}
  `;
  if (!channel || channel.kind !== "voice" || channel.archived_at) return { error: "voice_room_not_found" as const };
  const access = await channelAuthorization(channel.server_id, userId, channel.id);
  if (!access?.canView) return { error: "not_a_voice_room_member" as const };
  const [conversationMember] = await db<{ user_id: string }[]>`
    select user_id from conversation_members
    where conversation_id = ${channel.conversation_id} and user_id = ${userId} and left_at is null
  `;
  if (!conversationMember) return { error: "not_a_voice_room_member" as const };
  return { channel };
}

async function voiceSignalAccessError(conversationId: string, userId: string) {
  const [channel] = await db<{ id: string; kind: string }[]>`
    select id, kind from channels
    where conversation_id = ${conversationId} and archived_at is null
  `;
  if (channel?.kind === "voice") {
    const access = await voiceRoomAccessError(channel.id, userId);
    return "error" in access ? access.error : undefined;
  }
  return directVoiceCallAccessError(conversationId, userId);
}

function toPublicUser(user: Pick<UserRow, "id" | "username" | "display_name" | "created_at"> & Partial<Pick<UserRow, "profile_image_storage_key" | "profile_banner_storage_key">>) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    createdAt: user.created_at,
    avatarUrl: profileImageUrl(user.id, user.profile_image_storage_key),
    bannerUrl: profileBannerUrl(user.id, user.profile_banner_storage_key),
  };
}

function serverBrandingUrl(serverId: string, asset: "icon" | "banner", storageKey: string | null | undefined) {
  return storageKey
    ? `/v1/servers/${encodeURIComponent(serverId)}/branding/${asset}?v=${encodeURIComponent(storageKey)}`
    : null;
}

async function recordServerAudit(
  serverId: string,
  actorId: string,
  action: string,
  targetId: string | null = null,
  targetUserId: string | null = null,
) {
  await db`
    insert into server_audit_logs (server_id, actor_id, action, target_id, target_user_id)
    values (${serverId}, ${actorId}, ${action}, ${targetId}, ${targetUserId})
  `;
}

const maxCustomEmojiBytes = 10 * 1024 * 1024;

function toMessage(message: MessageRow) {
  return {
    id: message.id,
    conversationId: message.conversation_id,
    senderDeviceId: message.sender_device_id,
    clientMessageId: message.client_message_id,
    serverSequence: String(message.server_sequence),
    protocol: message.protocol,
    senderUserId: message.sender_user_id ?? null,
    ciphertext: encodeBase64(message.ciphertext),
    protocolMetadata: encodeBase64(message.protocol_metadata),
    createdAt: message.created_at,
  };
}

const imageMimeExtensions: Record<string, string[]> = {
  avif: ["image/avif"],
  gif: ["image/gif"],
  heic: ["image/heic"],
  jpeg: ["image/jpeg"],
  jpg: ["image/jpeg"],
  png: ["image/png"],
  webp: ["image/webp"],
};

const videoMimeExtensions: Record<string, string[]> = {
  mp4: ["video/mp4"],
  mov: ["video/quicktime"],
  ogg: ["video/ogg"],
  ogv: ["video/ogg"],
  webm: ["video/webm"],
};

function attachmentMetadata(extension: string, mimeType: string) {
  const normalizedExtension = extension.toLowerCase();
  const normalizedMimeType = mimeType.toLowerCase();
  const allowed = imageMimeExtensions[normalizedExtension] ?? videoMimeExtensions[normalizedExtension];
  if (allowed && !allowed.includes(normalizedMimeType)) return null;
  if (!allowed && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalizedMimeType)) return null;
  return { extension: normalizedExtension, mimeType: normalizedMimeType };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  if (value.startsWith("{") && value.endsWith("}")) return value.slice(1, -1).split(",").map((item) => item.replace(/^"|"$/g, "")).filter(Boolean);
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function validCryptoKey(value: unknown) {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > 16 * 1024) return false;
  if (typeof value === "string") return value.length > 0;
  const object = objectValue(value);
  return Boolean(object && typeof object.key === "string" && object.key.length > 0 && object.key.length <= 4096);
}

function matrixUserId(userId: string) {
  return `@${userId}:priv-chat`;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function encodePageCursor(value: Record<string, string>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodePageCursor(value: string | undefined) {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return objectValue(decoded) ?? undefined;
  } catch {
    return undefined;
  }
}

function isCursorTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value);
}

function prefixUpperBound(value: string) {
  const characters = Array.from(value);
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    let codePoint = characters[index]!.codePointAt(0)!;
    if (codePoint >= 0x10ffff) continue;
    codePoint += 1;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xe000;
    return characters.slice(0, index).join("") + String.fromCodePoint(codePoint);
  }
  return undefined;
}

function parseCryptoUpload(value: unknown) {
  const body = objectValue(value);
  const deviceKeys = objectValue(body?.device_keys);
  const keys = objectValue(deviceKeys?.keys);
  const deviceId = deviceKeys?.device_id ?? body?.device_id;
  const oneTimeKeys = objectValue(body?.one_time_keys) ?? {};
  const fallbackKeys = objectValue(body?.fallback_keys) ?? {};
  if (!isUuid(deviceId)) return null;
  if (deviceKeys && (!keys || typeof deviceKeys.user_id !== "string" || deviceKeys.device_id !== deviceId)) return null;
  if (Object.keys(oneTimeKeys).length > 100 || Object.keys(fallbackKeys).length > 10) return null;
  if (keys && !Object.values(keys).every((key) => typeof key === "string")) return null;
  if (!Object.values(oneTimeKeys).every(validCryptoKey)) return null;
  if (!Object.values(fallbackKeys).every(validCryptoKey)) return null;
  return { deviceId, deviceKeys, oneTimeKeys, fallbackKeys };
}

function decodeEncryptedMetadata(value: string | undefined) {
  if (!value) return Buffer.alloc(0);
  return decodeBase64(value, "encryptedMetadata", 64 * 1024, true);
}

async function serverMembership(serverId: string, userId: string) {
  const [membership] = await db<{ role: "owner" | "admin" | "member" }[]>`
    select sm.role from server_members sm
    join servers s on s.id = sm.server_id
    where sm.server_id = ${serverId} and sm.user_id = ${userId} and sm.left_at is null
      and s.deactivated_at is null
  `;
  return membership;
}

const serverPermissionNames = [
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

type ServerPermission = typeof serverPermissionNames[number];
type ServerPermissionMap = Record<ServerPermission, boolean>;
type ServerSystemKey = "owner" | "admin" | "everyone" | "member";
type ServerAuthorizationRole = {
  id: string;
  permissions: unknown;
  view_all_channels: boolean;
  position: number;
  is_system: boolean;
  system_key: ServerSystemKey | null;
};
type ServerAuthorization = {
  role: "owner" | "admin" | "member";
  ownerId: string;
  isOwner: boolean;
  roles: ServerAuthorizationRole[];
  permissions: ServerPermissionMap;
};

function permissionMap(value: unknown, fallback: Partial<ServerPermissionMap> = {}) {
  const object = objectValue(value);
  return Object.fromEntries(serverPermissionNames.map((name) => [
    name,
    object && Object.prototype.hasOwnProperty.call(object, name)
      ? object[name] === true
      : fallback[name] === true,
  ])) as ServerPermissionMap;
}

function defaultRolePermissions(systemKey: ServerSystemKey): ServerPermissionMap {
  if (systemKey === "owner") return permissionMap(undefined, Object.fromEntries(serverPermissionNames.map((name) => [name, true])));
  if (systemKey === "admin") return permissionMap(undefined, {
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
  return permissionMap(undefined, {
    view_channels: true,
    send_messages: true,
    upload_files: true,
    view_members: true,
    pin_messages: true,
  });
}

function hasServerPermission(authorization: ServerAuthorization, permission: ServerPermission) {
  return authorization.isOwner || authorization.permissions[permission];
}

function hasAnyServerPermission(authorization: ServerAuthorization, ...permissions: ServerPermission[]) {
  return authorization.isOwner || permissions.some((permission) => authorization.permissions[permission]);
}

function highestRolePosition(authorization: ServerAuthorization) {
  return Math.max(...authorization.roles.map((role) => role.position), 0);
}

function canManageRoleHierarchy(
  authorization: ServerAuthorization,
  role: ServerAuthorizationRole | Pick<ServerRoleRow, "position" | "is_system">,
) {
  if (authorization.isOwner) return true;
  return !role.is_system && role.position < highestRolePosition(authorization);
}

function canManageRole(
  authorization: ServerAuthorization,
  role: ServerAuthorizationRole | Pick<ServerRoleRow, "position" | "is_system">,
  ...permissions: ServerPermission[]
) {
  const requiredPermissions: ServerPermission[] = permissions.length > 0 ? permissions : ["manage_roles"];
  if (!hasAnyServerPermission(authorization, ...requiredPermissions, "manage_roles")) return false;
  return canManageRoleHierarchy(authorization, role);
}

function canModerateTarget(actor: ServerAuthorization, target: ServerAuthorization) {
  if (actor.isOwner) return true;
  const actorPosition = highestRolePosition(actor);
  const targetPosition = highestRolePosition(target);
  return targetPosition < actorPosition;
}

async function serverAuthorization(serverId: string, userId: string) {
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
    const rolePermissions = permissionMap(role.permissions, role.system_key ? defaultRolePermissions(role.system_key) : undefined);
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

async function channelAuthorization(serverId: string, userId: string, channelId: string) {
  const authorization = await serverAuthorization(serverId, userId);
  if (!authorization) return undefined;
  const [channel] = await db<{ id: string; category_id: string | null }[]>`
    select id, category_id from channels
    where id = ${channelId} and server_id = ${serverId} and archived_at is null
  `;
  if (!channel) return undefined;
  if (authorization.isOwner) return { authorization, canView: true, canUpload: true };
  if (authorization.roles.some((role) => role.id === "legacy")) {
    return {
      authorization,
      canView: authorization.permissions.view_channels,
      canUpload: authorization.permissions.view_channels && authorization.permissions.upload_files,
    };
  }

  const [access] = await db<{ can_view: boolean; can_upload: boolean }[]>`
    select
      exists (
        select 1
        from server_member_roles smr
        join server_roles sr on sr.id = smr.role_id
        where smr.server_id = ${serverId}
          and smr.user_id = ${userId}
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
              select 1 from server_role_channel_access src
              where src.role_id = sr.id and src.channel_id = ${channelId}
                and (src.can_view or src.can_upload)
            )
            or exists (
              select 1 from server_role_category_access src
              where src.role_id = sr.id and src.category_id = ${channel.category_id}
                and (src.can_view or src.can_upload)
            )
          )
      ) as can_view,
      exists (
        select 1
        from server_member_roles smr
        join server_roles sr on sr.id = smr.role_id
        where smr.server_id = ${serverId}
          and smr.user_id = ${userId}
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
            (sr.permissions->>'upload_files' = 'true' and sr.view_all_channels)
            or exists (
              select 1 from server_role_channel_access src
              where src.role_id = sr.id and src.channel_id = ${channelId}
                and src.can_upload and sr.permissions->>'upload_files' = 'true'
            )
            or exists (
              select 1 from server_role_category_access src
              where src.role_id = sr.id and src.category_id = ${channel.category_id}
                and src.can_upload and sr.permissions->>'upload_files' = 'true'
            )
          )
      ) as can_upload
  `;
  return { authorization, canView: Boolean(access?.can_view), canUpload: Boolean(access?.can_upload && access?.can_view) };
}

async function conversationChannelAuthorization(conversationId: string, userId: string) {
  const [channel] = await db<{ id: string; server_id: string; kind: string; archived_at: Date | null }[]>`
    select id, server_id, kind, archived_at from channels
    where conversation_id = ${conversationId}
  `;
  if (!channel) return undefined;
  const access = channel.archived_at ? undefined : await channelAuthorization(channel.server_id, userId, channel.id);
  return { channel, access };
}

async function isMetadataChannel(serverId: string, channelId: string) {
  const [anchor] = await db<{ id: string }[]>`
    select id from channels
    where server_id = ${serverId} and archived_at is null
    order by created_at asc, id asc
    limit 1
  `;
  return anchor?.id === channelId;
}

async function visibleServerChannels(serverId: string, userId: string) {
  const rows = await db<{
    id: string;
    server_id: string;
    conversation_id: string;
    encrypted_metadata: Buffer;
    category_id: string | null;
    kind: string;
    position: number;
    created_at: Date;
  }[]>`
    select id, server_id, conversation_id, encrypted_metadata, category_id, kind, position, created_at
    from channels
    where server_id = ${serverId} and archived_at is null
    order by position asc, created_at asc
  `;
  const visible = [];
  for (const channel of rows) {
    const access = await channelAuthorization(serverId, userId, channel.id);
    if (access?.canView) visible.push({ channel, canUpload: access.canUpload, canSend: hasServerPermission(access.authorization, "send_messages") });
  }
  return visible;
}

async function syncChannelConversationMembership(serverId: string, channelId: string) {
  await db`
    insert into server_member_roles (server_id, user_id, role_id)
    select sm.server_id, sm.user_id, sr.id
    from server_members sm
    join server_roles sr on sr.server_id = sm.server_id
      and sr.system_key = 'everyone'
    where sm.server_id = ${serverId}
      and sm.left_at is null
    on conflict do nothing
  `;
  const [channel] = await db<{ conversation_id: string; category_id: string | null }[]>`
    select conversation_id, category_id from channels
    where id = ${channelId} and server_id = ${serverId} and archived_at is null
  `;
  if (!channel) return;
  const [anchor] = await db<{ id: string }[]>`
    select id from channels
    where server_id = ${serverId} and archived_at is null
    order by created_at asc, id asc
    limit 1
  `;

  await db.begin(async (transaction) => {
    await transaction`
      insert into conversation_members (conversation_id, user_id, role)
      select ${channel.conversation_id}, sm.user_id, case when sm.role = 'owner' then 'owner' else 'member' end
      from server_members sm
      join servers s on s.id = sm.server_id
      where sm.server_id = ${serverId} and sm.left_at is null
        and (
          ${anchor?.id === channelId}
          or sm.user_id = s.owner_id
          or exists (
            select 1
            from server_member_roles smr
            join server_roles sr on sr.id = smr.role_id
            where smr.server_id = sm.server_id and smr.user_id = sm.user_id
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
                  select 1 from server_role_channel_access src
                  where src.role_id = sr.id and src.channel_id = ${channelId}
                    and (src.can_view or src.can_upload)
                )
                or exists (
                  select 1 from server_role_category_access src
                  where src.role_id = sr.id and src.category_id = ${channel.category_id}
                    and (src.can_view or src.can_upload)
                )
              )
          )
        )
      on conflict (conversation_id, user_id) do update set left_at = null, joined_at = now()
    `;
    await transaction`
      update conversation_members cm
      set left_at = coalesce(cm.left_at, now())
      where cm.conversation_id = ${channel.conversation_id}
        and cm.left_at is null
        and not ${anchor?.id === channelId}
        and not exists (
          select 1
          from server_members sm
          join servers s on s.id = sm.server_id
          where sm.server_id = ${serverId} and sm.user_id = cm.user_id and sm.left_at is null
            and (
              sm.user_id = s.owner_id
              or exists (
                select 1
                from server_member_roles smr
                join server_roles sr on sr.id = smr.role_id
                where smr.server_id = sm.server_id and smr.user_id = sm.user_id
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
                        select 1 from server_role_channel_access src
                        where src.role_id = sr.id and src.channel_id = ${channelId}
                          and (src.can_view or src.can_upload)
                      )
                      or exists (
                        select 1 from server_role_category_access src
                        where src.role_id = sr.id and src.category_id = ${channel.category_id}
                          and (src.can_view or src.can_upload)
                      )
                  )
              )
            )
        )
    `;
  });
}

async function syncServerChannelMemberships(serverId: string) {
  const channels = await db<{ id: string }[]>`
    select id from channels where server_id = ${serverId} and archived_at is null
  `;
  for (const channel of channels) await syncChannelConversationMembership(serverId, channel.id);
}

function validRoleColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function rolePermissionInput(value: unknown) {
  const input = objectValue(value);
  if (!input) return null;
  if (Object.keys(input).some((key) => !(serverPermissionNames as readonly string[]).includes(key))) return null;
  if (Object.values(input).some((item) => typeof item !== "boolean")) return null;
  return permissionMap(input);
}

type ServerRoleRow = {
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

function publicServerRole(
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

async function isUserTimedOut(serverId: string, userId: string) {
  const [timeout] = await db<{ id: string }[]>`
    select id from server_timeouts
    where server_id = ${serverId} and user_id = ${userId}
      and revoked_at is null and expires_at > now()
    limit 1
  `;
  return Boolean(timeout);
}

async function isInstanceUserTimedOut(userId: string) {
  const [timeout] = await db<{ id: string }[]>`
    select id from instance_user_timeouts
    where user_id = ${userId} and revoked_at is null and expires_at > now()
    limit 1
  `;
  return Boolean(timeout);
}

function newInviteToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

async function hashInviteToken(token: string) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

const userBody = t.Object({
  username: t.String({ minLength: 3, maxLength: 32, pattern: "^[A-Za-z0-9_.-]+$" }),
  password: t.String({ minLength: 12, maxLength: 128 }),
  displayName: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
});

const encryptedBytes = (maxLength: number) => t.String({ minLength: 1, maxLength });

const realtimeCommand = t.Union([
  t.Object({
    type: t.Literal("subscribe"),
    conversationId: t.String({ format: "uuid" }),
  }),
  t.Object({
    type: t.Literal("unsubscribe"),
    conversationId: t.String({ format: "uuid" }),
  }),
  t.Object({
    type: t.Literal("typing"),
    conversationId: t.String({ format: "uuid" }),
    isTyping: t.Boolean(),
  }),
  t.Object({
    type: t.Literal("presence"),
    conversationId: t.String({ format: "uuid" }),
    state: t.Union([t.Literal("online"), t.Literal("idle"), t.Literal("offline")]),
  }),
  t.Object({
    type: t.Literal("voice.signal"),
    conversationId: t.String({ format: "uuid" }),
    ciphertext: t.String({ minLength: 1, maxLength: config.maxProtocolMetadataBytes }),
  }),
]);

let liveKitRooms: RoomServiceClient | undefined;

function liveKitRoomService() {
  if (!config.liveKit) return undefined;
  liveKitRooms ??= new RoomServiceClient(config.liveKit.httpUrl, config.liveKit.apiKey, config.liveKit.apiSecret);
  return liveKitRooms;
}

async function voiceTokenRateLimited(userId: string) {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `naigi:voice-token:${userId}:${minute}`;
  const count = Number(await evalRedisScript(
    "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count",
    1,
    key,
    120,
  ));
  return count > 12;
}

export function createApp() {
  const realtimeConnections = new Map<object, {
    userId: string;
    connection: RealtimeConnection;
    close: () => void;
    operationsMember: string;
  }>();
  let liveConnectionRefreshTimer: ReturnType<typeof setInterval> | undefined;

  function ensureLiveConnectionRefresh() {
    if (liveConnectionRefreshTimer) return;
    liveConnectionRefreshTimer = setInterval(() => {
      const members = [...realtimeConnections.values()].map((active) => active.operationsMember);
      void refreshLiveConnections(members).catch(() => {
        // Connection leases expire on their own if Redis is temporarily unavailable.
      });
    }, liveConnectionRefreshMs);
  }

  function stopLiveConnectionRefreshIfIdle() {
    if (realtimeConnections.size > 0 || !liveConnectionRefreshTimer) return;
    clearInterval(liveConnectionRefreshTimer);
    liveConnectionRefreshTimer = undefined;
  }

  return new Elysia()
    .onError(({ code, error, request, set }) => {
      if (code === "VALIDATION") return respondError(set, 422, "validation_error");
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
      console.error(`[request-error] ${request.method} ${new URL(request.url).pathname} (${code})\n${detail}`);
      return respondError(set, 500, "internal_error");
    })
    .get("/", async () => {
      return await publicFile("index.html", "text/html; charset=utf-8")
         ?? { name: "Naigi", version: "0.22.0" };
    })
    .get("/register", async ({ set }) => {
      const file = await publicFile("register.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/app", async ({ set }) => {
      const file = await publicFile("chat.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/channels/:serverId/:channelId", async ({ set }) => {
      const file = await publicFile("chat.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/unlock", async ({ set }) => {
      const file = await publicFile("unlock.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/new", async ({ set }) => {
      const file = await publicFile("new.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/settings", async ({ set }) => {
      const file = await publicFile("settings.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-admin", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-admin.html", "moderation");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/operations", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-operations.html", "platform");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/users", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-users.html", "moderation");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/spaces", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-spaces.html", "platform");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/maintenance", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-maintenance.html", "platform");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/operators", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-operators.html", "operatorManagement");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin-theme-init.js", async ({ set }) => {
      const file = await publicFile("instance-admin-theme-init.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/livekit-e2ee-worker.mjs", async ({ set }) => {
      const file = await publicFile("livekit-e2ee-worker.mjs", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/voice-audio-worklet.js", async ({ set }) => {
      const file = await publicFile("voice-audio-worklet.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/auth.js", async ({ set }) => {
      const file = await publicFile("auth.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/register.js", async ({ set }) => {
      const file = await publicFile("register.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/unlock.js", async ({ set }) => {
      const file = await publicFile("unlock.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/main.js", async ({ set }) => {
      const file = await publicFile("main.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/new.js", async ({ set }) => {
      const file = await publicFile("new.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/settings.js", async ({ set }) => {
      const file = await publicFile("settings.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-admin.js", async ({ set }) => {
      const file = await publicFile("instance-admin.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-operations.js", async ({ set }) => {
      const file = await publicFile("instance-operations.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-users.js", async ({ set }) => {
      const file = await publicFile("instance-users.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-operators.js", async ({ set }) => {
      const file = await publicFile("instance-operators.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-spaces.js", async ({ set }) => {
      const file = await publicFile("instance-spaces.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-maintenance.js", async ({ set }) => {
      const file = await publicFile("instance-maintenance.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-admin-login.js", async ({ set }) => {
      const file = await publicFile("instance-admin-login.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/server-settings", async ({ set }) => {
      const file = await publicFile("server-settings.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/server-settings.js", async ({ set }) => {
      const file = await publicFile("server-settings.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/app.css", async ({ set }) => {
      const file = await publicFile("app.css", "text/css; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/favicon.svg", async ({ set }) => {
      const file = await publicFile("favicon.svg", "image/svg+xml");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/push-sw.js", async ({ set }) => {
      const file = await publicFile("push-sw.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["service-worker-allowed"] = "/";
      set.headers["cache-control"] = "no-cache";
      return file;
    })
    .get("/assets/twemoji/:asset", async ({ params, set }) => {
      if (!/^[A-Za-z0-9_.-]+$/.test(params.asset) || !params.asset.endsWith(".svg") && params.asset !== "NOTICE.txt") {
        return respondError(set, 404, "asset_not_found");
      }
      const file = Bun.file(`${import.meta.dir}/../public/assets/twemoji/${params.asset}`);
      if (!(await file.exists())) return respondError(set, 404, "asset_not_found");
      return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable", "content-type": params.asset.endsWith(".svg") ? "image/svg+xml" : "text/plain; charset=utf-8" } });
    })
    .get("/assets/:asset", async ({ params, set }) => {
      if (params.asset === "." || params.asset === ".." || !/^[A-Za-z0-9_.-]+$/.test(params.asset)) {
        return respondError(set, 404, "asset_not_found");
      }
      const file = Bun.file(`${import.meta.dir}/../public/assets/${params.asset}`);
      if (!(await file.exists())) return respondError(set, 404, "asset_not_found");
      const contentType = params.asset.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
      return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable", "content-type": contentType } });
    })
    .get("/health/live", () => ({ status: "ok" }))
    .get("/health/ready", async ({ set }) => {
      const [database, adminDatabase, redis] = await Promise.allSettled([
        pingDatabase(), pingAdminDatabase(), pingRedis(),
      ]);
      const ready = database.status === "fulfilled"
        && adminDatabase.status === "fulfilled"
        && redis.status === "fulfilled";
      const response = {
        status: ready ? "ok" : "degraded",
        dependencies: {
          database: database.status === "fulfilled" ? "ok" : "unavailable",
          adminDatabase: adminDatabase.status === "fulfilled" ? "ok" : "unavailable",
          redis: redis.status === "fulfilled" ? "ok" : "unavailable",
        },
      };

      if (!ready) set.status = 503;
      return response;
    })
    .get("/v1/push/config", ({ set }) => {
      set.headers["cache-control"] = "no-store";
      return publicFirebaseMessagingConfiguration();
    })
    .get("/v1/reports/public-key", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      const [key] = await db<{ id: string; public_key: Buffer }[]>`
        select id, public_key from instance_report_keys where active limit 1
      `;
      return key
        ? { configured: true, keyId: key.id, publicKey: encodeBase64(key.public_key) }
        : { configured: false as const };
    })
    .post("/v1/instance-admin/auth/login", async ({ body, headers, set }) => {
      set.headers["cache-control"] = "no-store";
      const existing = await authenticateAdmin(headers.cookie);
      if (existing) return { operator: existing };
      const operator = await verifyAdminPassword(body.username, body.password);
      if (!operator) return respondError(set, 401, "invalid_credentials");
      const session = await createAdminSession(operator.id);
      if (!session) return respondError(set, 401, "invalid_credentials");
      setAdminSessionCookie(set, session.token);
      return { operator };
    }, {
      body: t.Object({
        username: t.String({ minLength: 3, maxLength: 128 }),
        password: t.String({ minLength: 1, maxLength: 1_024 }),
      }),
    })
    .get("/v1/instance-admin/auth/me", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      return { operator };
    })
    .post("/v1/instance-admin/auth/logout", async ({ headers, set }) => {
      await deleteAdminSession(extractAdminCookieToken(headers.cookie));
      clearAdminSessionCookie(set);
      set.headers["cache-control"] = "no-store";
      return { loggedOut: true };
    })
    .get("/v1/instance-admin/reports", async ({ headers, query, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const status = query.status ?? "open";
      const reports = await db<{
        id: string;
        reporter_user_id: string | null;
        reporter_username: string | null;
        reporter_display_name: string | null;
        target_user_id: string | null;
        target_username: string | null;
        target_display_name: string | null;
        conversation_id: string | null;
        message_id: string | null;
        reason: string;
        status: string;
        has_evidence: boolean;
        created_at: Date;
        reviewed_at: Date | null;
        suspended: boolean;
      }[]>`
        select r.id, r.reporter_user_id, reporter.username as reporter_username,
          reporter.display_name as reporter_display_name, r.target_user_id,
          target.username as target_username, target.display_name as target_display_name,
          r.conversation_id, r.message_id, r.reason, r.status,
          (r.evidence_ciphertext is not null) as has_evidence, r.created_at, r.reviewed_at,
          exists(select 1 from instance_user_suspensions s where s.user_id = r.target_user_id) as suspended
        from instance_reports r
        left join users reporter on reporter.id = r.reporter_user_id
        left join users target on target.id = r.target_user_id
        where (${status} = 'all' or r.status = ${status})
        order by case when r.status in ('open', 'reviewing') then 0 else 1 end,
          r.created_at desc
        limit 200
      `;
      return {
        reports: reports.map((report) => ({
          id: report.id,
          reporterUserId: report.reporter_user_id,
          reporterUsername: report.reporter_username,
          reporterDisplayName: report.reporter_display_name,
          targetUserId: report.target_user_id,
          targetUsername: report.target_username,
          targetDisplayName: report.target_display_name,
          conversationId: report.conversation_id,
          messageId: report.message_id,
          reason: report.reason,
          status: report.status,
          hasEvidence: user.role === "admin" && report.has_evidence,
          createdAt: report.created_at,
          reviewedAt: report.reviewed_at,
          suspended: report.suspended,
        })),
      };
    }, {
      query: t.Object({ status: t.Optional(t.Union([
        t.Literal("all"), t.Literal("open"), t.Literal("reviewing"), t.Literal("resolved"), t.Literal("dismissed"),
      ])) }),
    })
    .get("/v1/instance-admin/reports/:reportId", async ({ headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      const [report] = await db<{
        id: string;
        reporter_user_id: string | null;
        reporter_username: string | null;
        reporter_display_name: string | null;
        target_user_id: string | null;
        target_username: string | null;
        target_display_name: string | null;
        conversation_id: string | null;
        message_id: string | null;
        reason: string;
        status: string;
        evidence_key_id: string | null;
        evidence_ciphertext: Buffer | null;
        evidence_wrapped_key: Buffer | null;
        evidence_iv: Buffer | null;
        created_at: Date;
        reviewed_by: string | null;
        reviewed_at: Date | null;
      }[]>`
        select r.id, r.reporter_user_id, reporter.username as reporter_username,
          reporter.display_name as reporter_display_name, r.target_user_id,
          target.username as target_username, target.display_name as target_display_name,
          r.conversation_id, r.message_id, r.reason, r.status, r.evidence_key_id,
          r.evidence_ciphertext, r.evidence_wrapped_key, r.evidence_iv, r.created_at,
          r.reviewed_by, r.reviewed_at
        from instance_reports r
        left join users reporter on reporter.id = r.reporter_user_id
        left join users target on target.id = r.target_user_id
        where r.id = ${params.reportId}
      `;
      if (!report) return respondError(set, 404, "report_not_found");
      await recordInstanceAdminAudit(user, "report.viewed", report.id, report.target_user_id);
      set.headers["cache-control"] = "no-store";
      return {
        report: {
          id: report.id,
          reporterUserId: report.reporter_user_id,
          reporterUsername: report.reporter_username,
          reporterDisplayName: report.reporter_display_name,
          targetUserId: report.target_user_id,
          targetUsername: report.target_username,
          targetDisplayName: report.target_display_name,
          conversationId: report.conversation_id,
          messageId: report.message_id,
          reason: report.reason,
          status: report.status,
          createdAt: report.created_at,
          reviewedBy: report.reviewed_by,
          reviewedAt: report.reviewed_at,
          evidence: user.role === "admin" && report.evidence_ciphertext && report.evidence_wrapped_key && report.evidence_iv && report.evidence_key_id
            ? {
              keyId: report.evidence_key_id,
              ciphertext: encodeBase64(report.evidence_ciphertext),
              wrappedKey: encodeBase64(report.evidence_wrapped_key),
              iv: encodeBase64(report.evidence_iv),
            }
            : null,
        },
      };
    }, {
      params: t.Object({ reportId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/instance-admin/reports/:reportId/evidence-access", async ({ headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "evidenceKeys")) return respondError(set, 403, "forbidden");
      const [report] = await db<{ id: string; target_user_id: string | null; has_evidence: boolean }[]>`
        select id, target_user_id, evidence_ciphertext is not null as has_evidence
        from instance_reports where id = ${params.reportId}
      `;
      if (!report) return respondError(set, 404, "report_not_found");
      if (!report.has_evidence) return respondError(set, 409, "report_has_no_evidence");
      await recordInstanceAdminAudit(user, "report.evidence_accessed", report.id, report.target_user_id);
      return { audited: true };
    }, {
      params: t.Object({ reportId: t.String({ format: "uuid" }) }),
    })
    .patch("/v1/instance-admin/reports/:reportId", async ({ body, headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      let updated: { id: string; target_user_id: string | null } | undefined;
      try {
        updated = await db.begin(async (transaction) => {
          const [row] = await transaction<{ id: string; target_user_id: string | null }[]>`
            update instance_reports
            set status = ${body.status}, reviewed_by = ${user.id},
              reviewed_by_username = ${user.username}, reviewed_by_display_name = ${user.username}, reviewed_at = now()
            where id = ${params.reportId}
            returning id, target_user_id
          `;
          if (!row) return undefined;
          await transaction`
            insert into instance_admin_audit_logs (
              admin_user_id, admin_username, admin_display_name, action, report_id, target_user_id
            ) values (
              ${user.id}, ${user.username}, ${user.username}, ${`report.${body.status}`}, ${row.id}, ${row.target_user_id}
            )
          `;
          return row;
        });
      } catch (error) {
        if (isUniqueViolation(error)) return respondError(set, 409, "report_conflicts_with_open_report");
        throw error;
      }
      if (!updated) return respondError(set, 404, "report_not_found");
      return { updated: true };
    }, {
      params: t.Object({ reportId: t.String({ format: "uuid" }) }),
      body: t.Object({ status: t.Union([t.Literal("open"), t.Literal("reviewing"), t.Literal("resolved"), t.Literal("dismissed")]) }),
    })
    .post("/v1/instance-admin/reports/:reportId/remove-message", async ({ headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      const [report] = await db<{ id: string; target_user_id: string | null; message_id: string | null; conversation_id: string | null }[]>`
        select id, target_user_id, message_id, conversation_id
        from instance_reports where id = ${params.reportId}
      `;
      if (!report) return respondError(set, 404, "report_not_found");
      if (!report.message_id || !report.conversation_id) return respondError(set, 409, "report_has_no_message");
      const recipients = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${report.conversation_id} and left_at is null
      `;
      const deleted = await db.begin(async (transaction) => {
        const [row] = await transaction<{ id: string }[]>`
          delete from messages where id = ${report.message_id} and conversation_id = ${report.conversation_id}
          returning id
        `;
        if (!row) return undefined;
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, report_id, target_user_id
          ) values (
            ${user.id}, ${user.username}, ${user.username}, 'report.message_removed', ${report.id}, ${report.target_user_id}
          )
        `;
        return row;
      });
      if (!deleted) return respondError(set, 404, "message_not_found");
      await publishMessageCreated(report.conversation_id, {
        type: "message.deleted",
        messageId: deleted.id,
        conversationId: report.conversation_id,
      }, recipients.map((recipient) => recipient.user_id));
      return { removed: true };
    }, {
      params: t.Object({ reportId: t.String({ format: "uuid" }) }),
    })
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
    })
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
    })
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
      for (const active of realtimeConnections.values()) {
        if (active.userId === params.userId) active.close();
      }
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
    })
    .get("/v1/instance-admin/report-keys", async ({ headers, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "evidenceKeys")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const keys = await db<{ id: string; active: boolean; created_at: Date }[]>`
        select id, active, created_at from instance_report_keys order by created_at desc
      `;
      return { keys: keys.map((key) => ({ id: key.id, active: key.active, createdAt: key.created_at })) };
    })
    .post("/v1/instance-admin/report-keys", async ({ body, headers, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "evidenceKeys")) return respondError(set, 403, "forbidden");
      let publicKey: Buffer;
      try {
        publicKey = decodeBase64(body.publicKey, "publicKey", 2048);
        const parsedKey = createPublicKey({ key: publicKey, format: "der", type: "spki" });
        if (parsedKey.asymmetricKeyType !== "rsa" || (parsedKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
          return respondError(set, 400, "invalid_report_public_key");
        }
      } catch (error) {
        if (error instanceof InvalidEncodingError || error instanceof Error) return respondError(set, 400, "invalid_report_public_key");
        throw error;
      }
      const key = await db.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtextextended('instance-report-key', 0))`;
        await transaction`update instance_report_keys set active = false where active`;
        const [created] = await transaction<{ id: string; created_at: Date }[]>`
          insert into instance_report_keys (
            id, public_key, created_by, created_by_username, created_by_display_name, active
          ) values (
            ${body.keyId}, ${publicKey}, ${user.id}, ${user.username}, ${user.username}, true
          )
          returning id, created_at
        `;
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action
          ) values (${user.id}, ${user.username}, ${user.username}, 'report_key.created')
        `;
        return created;
      });
      if (!key) throw new Error("report encryption key insert did not return a row");
      set.status = 201;
      return { key: { id: key.id, createdAt: key.created_at } };
    }, {
      body: t.Object({
        keyId: t.String({ format: "uuid" }),
        publicKey: t.String({ minLength: 300, maxLength: 4_096 }),
      }),
    })
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
    })
    .get("/v1/instance-admin/audit", async ({ headers, query, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const limit = Math.min(Number(query.limit ?? 100), 200);
      const rows = await db<{
        id: bigint | number | string;
        admin_user_id: string;
        admin_username: string;
        admin_display_name: string;
        action: string;
        details: Record<string, unknown>;
        report_id: string | null;
        target_user_id: string | null;
        created_at: Date;
      }[]>`
        select l.id, l.admin_user_id, l.admin_username, l.admin_display_name, l.action, l.details, l.report_id,
          l.target_user_id, l.created_at
        from instance_admin_audit_logs l
        where (${user.role} = 'admin' or l.action like 'report.%' or l.action like 'user.%')
        order by l.created_at desc, l.id desc limit ${Number.isInteger(limit) ? limit : 100}
      `;
      return { logs: rows.map((row) => ({
        id: String(row.id),
        adminUserId: row.admin_user_id,
        adminUsername: row.admin_username,
        adminDisplayName: row.admin_display_name,
        action: row.action,
        details: row.details ?? {},
        reportId: row.report_id,
        targetUserId: row.target_user_id,
        createdAt: row.created_at,
      })) };
    }, {
      query: t.Object({ limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })) }),
    })
    .get("/v1/instance-admin/operations", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return await getInstanceOperationsSnapshot();
    })
    .get("/v1/instance-admin/operations/live", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return getInstanceLiveResources();
    })
    .get("/v1/instance-admin/operations/overview", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return await getInstanceOperationsOverview();
    })
    .get("/v1/instance-admin/maintenance/summary", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return await getStorageMaintenanceSummary(operator);
    })
    .post("/v1/instance-admin/maintenance/preview", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return await inspectStorageMaintenance();
    })
    .post("/v1/instance-admin/maintenance/quarantine", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      try {
        return await quarantineOrphanedStorage(operator);
      } catch (error) {
        if (error instanceof StorageMaintenanceError) return respondError(set, error.status, error.code);
        throw error;
      }
    })
    .post("/v1/instance-admin/maintenance/restore", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      try {
        return await restoreQuarantinedStorage(operator);
      } catch (error) {
        if (error instanceof StorageMaintenanceError) return respondError(set, error.status, error.code);
        throw error;
      }
    })
    .post("/v1/instance-admin/maintenance/purge", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      try {
        return await purgeExpiredQuarantinedStorage(operator);
      } catch (error) {
        if (error instanceof StorageMaintenanceError) return respondError(set, error.status, error.code);
        throw error;
      }
    })
    .post("/v1/previews/twitter", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const parsed = parseTwitterStatusUrl(body.url);
      if (!parsed) return respondError(set, 400, "unsupported_twitter_url");
      const preview = await fetchTwitterPreview(parsed.id);
      set.headers["cache-control"] = "no-store";
      return { preview };
    }, {
      body: t.Object({ url: t.String({ minLength: 1, maxLength: 2_048 }) }),
    })
    .get("/v1/gifs/providers", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      return {
        providers: config.gifProviders,
        maxAttachmentBytes: config.maxAttachmentBytes,
      };
    })
    .post("/v1/auth/register", async ({ body, set }) => {
      const username = normalizeUsername(body.username);
      const displayName = body.displayName?.trim() || body.username;
      const passwordHash = await password.hash(body.password);

      try {
        const [user] = await db<UserRow[]>`
          insert into users (username, username_normalized, password_hash, display_name)
          values (${body.username}, ${username}, ${passwordHash}, ${displayName})
           returning id, username, display_name, password_hash, created_at,
             profile_image_storage_key, profile_banner_storage_key
        `;
        const session = await createSession(user.id);
        setSessionCookie(set, session.token);
        set.status = 201;
        return { user: toPublicUser(user), ...session };
      } catch (error) {
        if (isUniqueViolation(error)) return respondError(set, 409, "username_taken");
        throw error;
      }
    }, { body: userBody })
    .post("/v1/auth/login", async ({ body, set }) => {
      const [user] = await db<UserRow[]>`
         select id, username, display_name, password_hash, created_at,
           profile_image_storage_key, profile_banner_storage_key
        from users
        where username_normalized = ${normalizeUsername(body.username)}
      `;
      const valid = await verifyPassword(user, body.password);
      if (!valid || !user) return respondError(set, 401, "invalid_credentials");
      const [suspension] = await db<{ user_id: string }[]>`
        select user_id from instance_user_suspensions where user_id = ${user.id}
      `;
      if (suspension) return respondError(set, 403, "account_suspended");

      const session = await createSession(user.id);
      setSessionCookie(set, session.token);
      return { user: toPublicUser(user), ...session };
    }, { body: userBody })
    .post("/v1/auth/logout", async ({ headers, set }) => {
      const token = extractBearerToken(headers.authorization) ?? extractCookieToken(headers.cookie);
      await deleteSession(token);
      clearSessionCookie(set);
      return { loggedOut: true };
    })
    .get("/v1/me", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      return { user };
    })
    .get("/v1/me/instance-warnings", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      const warnings = await db<{ id: string; reason: string; created_at: Date; expires_at: Date | null }[]>`
        select id, reason, created_at, expires_at
        from instance_user_warnings
        where user_id = ${user.id} and acknowledged_at is null and revoked_at is null
          and (expires_at is null or expires_at > now())
        order by created_at desc limit 25
      `;
      return { warnings: warnings.map((warning) => ({
        id: warning.id,
        reason: warning.reason,
        createdAt: warning.created_at,
        expiresAt: warning.expires_at,
      })) };
    })
    .patch("/v1/me/instance-warnings/:warningId/acknowledge", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      const [warning] = await db<{ id: string }[]>`
        update instance_user_warnings set acknowledged_at = coalesce(acknowledged_at, now())
        where id = ${params.warningId} and user_id = ${user.id} and revoked_at is null
          and (expires_at is null or expires_at > now())
        returning id
      `;
      if (!warning) return respondError(set, 404, "warning_not_found");
      return { acknowledged: true };
    }, {
      params: t.Object({ warningId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/push/subscriptions", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!config.firebaseMessaging) return respondError(set, 503, "push_not_configured");
      await registerFcmPushToken(user.id, body.token);
      set.status = 201;
      return { registered: true };
    }, {
      body: t.Object({ token: t.String({ minLength: 20, maxLength: 4096 }) }),
    })
    .post("/v1/push/subscriptions/remove", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const removed = await removeFcmPushToken(user.id, body.token);
      return { removed };
    }, {
      body: t.Object({ token: t.String({ minLength: 20, maxLength: 4096 }) }),
    })
    .patch("/v1/me", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const displayName = body.displayName.trim();
      if (!displayName) return respondError(set, 400, "invalid_display_name");
      const [updated] = await db<UserRow[]>`
        update users
        set display_name = ${displayName}, updated_at = now()
        where id = ${user.id}
         returning id, username, display_name, password_hash, created_at,
           profile_image_storage_key, profile_banner_storage_key
      `;
      return { user: toPublicUser(updated) };
    }, {
      body: t.Object({ displayName: t.String({ minLength: 1, maxLength: 80 }) }),
    })
    .post("/v1/auth/password", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [record] = await db<UserRow[]>`
         select id, username, display_name, password_hash, created_at,
           profile_image_storage_key, profile_banner_storage_key
        from users where id = ${user.id}
      `;
      if (!await verifyPassword(record, body.currentPassword)) return respondError(set, 400, "current_password_incorrect");
      const passwordHash = await password.hash(body.newPassword);
      await db`
        update users set password_hash = ${passwordHash}, updated_at = now()
        where id = ${user.id}
      `;
      const token = extractBearerToken(headers.authorization) ?? extractCookieToken(headers.cookie);
      if (token) {
        const tokenHash = await hashSessionToken(token);
        await db`
          delete from sessions where user_id = ${user.id} and token_hash <> ${tokenHash}
        `;
      }
      return { updated: true };
    }, {
      body: t.Object({
        currentPassword: t.String({ minLength: 1, maxLength: 128 }),
        newPassword: t.String({ minLength: 12, maxLength: 128 }),
      }),
    })
    .get("/v1/users/:userId/avatar", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [profile] = await db<{ profile_image_storage_key: string | null; profile_image_mime_type: string | null }[]>`
        select profile_image_storage_key, profile_image_mime_type
        from users
        where id = ${params.userId}
      `;
      if (!profile?.profile_image_storage_key || !profile.profile_image_mime_type) {
        return respondError(set, 404, "profile_image_not_found");
      }
      const path = profileImagePath(profile.profile_image_storage_key);
      if (!(await Bun.file(path).exists())) return respondError(set, 404, "profile_image_not_found");
      return new Response(Bun.file(path), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-type": profile.profile_image_mime_type,
          "x-content-type-options": "nosniff",
        },
      });
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/users/:userId/banner", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [profile] = await db<{ profile_banner_storage_key: string | null; profile_banner_mime_type: string | null }[]>`
        select profile_banner_storage_key, profile_banner_mime_type
        from users
        where id = ${params.userId}
      `;
      if (!profile?.profile_banner_storage_key || !profile.profile_banner_mime_type) {
        return respondError(set, 404, "profile_banner_not_found");
      }
      const path = profileImagePath(profile.profile_banner_storage_key);
      if (!(await Bun.file(path).exists())) return respondError(set, 404, "profile_banner_not_found");
      return new Response(Bun.file(path), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-type": profile.profile_banner_mime_type,
          "x-content-type-options": "nosniff",
        },
      });
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .put("/v1/me/avatar", async ({ headers, request, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const metadata = profileImageMetadata(headers["content-type"]);
      if (!metadata) return respondError(set, 400, "unsupported_profile_image_type");

      const storageKey = `${crypto.randomUUID()}.${metadata.extension}`;
      let stored: { size: number };
      try {
        stored = await storeProfileImage(
          request,
          storageKey,
          config.maxProfileImageBytes,
          (bytes) => validProfileImageBytes(bytes, metadata.mimeType),
        );
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) return respondError(set, 413, "profile_image_too_large");
        if (error instanceof ProfileImageInvalidError) return respondError(set, 400, "invalid_profile_image");
        throw error;
      }

      let previousStorageKey: string | null = null;
      try {
        const updated = await db.begin(async (transaction) => {
          const [current] = await transaction<{ profile_image_storage_key: string | null }[]>`
            select profile_image_storage_key
            from users
            where id = ${user.id}
            for update
          `;
          if (!current) return null;
          const [next] = await transaction<UserRow[]>`
            update users
            set profile_image_storage_key = ${storageKey},
              profile_image_mime_type = ${metadata.mimeType},
              profile_image_size_bytes = ${stored.size}
            where id = ${user.id}
             returning id, username, display_name, created_at,
               profile_image_storage_key, profile_banner_storage_key
          `;
          previousStorageKey = current.profile_image_storage_key;
          return next;
        });
        if (!updated) {
          await removeProfileImage(storageKey);
          return respondError(set, 404, "user_not_found");
        }
        if (previousStorageKey && previousStorageKey !== storageKey) await removeProfileImage(previousStorageKey);
        return { user: toPublicUser(updated) };
      } catch (error) {
        await removeProfileImage(storageKey);
        throw error;
      }
    })
    .delete("/v1/me/avatar", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const deleted = await db.begin(async (transaction) => {
        const [current] = await transaction<{ profile_image_storage_key: string | null }[]>`
          select profile_image_storage_key
          from users
          where id = ${user.id}
          for update
        `;
        if (!current) return null;
        await transaction`
          update users
          set profile_image_storage_key = null,
            profile_image_mime_type = null,
            profile_image_size_bytes = null
          where id = ${user.id}
        `;
        return current.profile_image_storage_key;
      });
      if (deleted) await removeProfileImage(deleted);
      return { deleted: Boolean(deleted) };
    })
    .put("/v1/me/banner", async ({ headers, request, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const metadata = profileImageMetadata(headers["content-type"]);
      if (!metadata) return respondError(set, 400, "unsupported_profile_banner_type");

      const storageKey = `${crypto.randomUUID()}.${metadata.extension}`;
      let stored: { size: number };
      try {
        stored = await storeProfileImage(
          request,
          storageKey,
          config.maxProfileImageBytes,
          (bytes) => validProfileImageBytes(bytes, metadata.mimeType),
        );
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) return respondError(set, 413, "profile_banner_too_large");
        if (error instanceof ProfileImageInvalidError) return respondError(set, 400, "invalid_profile_banner");
        throw error;
      }

      let previousStorageKey: string | null = null;
      try {
        const updated = await db.begin(async (transaction) => {
          const [current] = await transaction<{ profile_banner_storage_key: string | null }[]>`
            select profile_banner_storage_key
            from users
            where id = ${user.id}
            for update
          `;
          if (!current) return null;
          const [next] = await transaction<UserRow[]>`
            update users
            set profile_banner_storage_key = ${storageKey},
              profile_banner_mime_type = ${metadata.mimeType},
              profile_banner_size_bytes = ${stored.size}
            where id = ${user.id}
            returning id, username, display_name, created_at,
              profile_image_storage_key, profile_banner_storage_key
          `;
          previousStorageKey = current.profile_banner_storage_key;
          return next;
        });
        if (!updated) {
          await removeProfileImage(storageKey);
          return respondError(set, 404, "user_not_found");
        }
        if (previousStorageKey && previousStorageKey !== storageKey) await removeProfileImage(previousStorageKey);
        return { user: toPublicUser(updated) };
      } catch (error) {
        await removeProfileImage(storageKey);
        throw error;
      }
    })
    .delete("/v1/me/banner", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const deleted = await db.begin(async (transaction) => {
        const [current] = await transaction<{ profile_banner_storage_key: string | null }[]>`
          select profile_banner_storage_key
          from users
          where id = ${user.id}
          for update
        `;
        if (!current) return null;
        await transaction`
          update users
          set profile_banner_storage_key = null,
            profile_banner_mime_type = null,
            profile_banner_size_bytes = null
          where id = ${user.id}
        `;
        return current.profile_banner_storage_key;
      });
      if (deleted) await removeProfileImage(deleted);
      return { deleted: Boolean(deleted) };
    })
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
    })
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
    })
    .post("/v1/reports", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (body.targetUserId === user.id) return respondError(set, 400, "cannot_report_self");

      const [target] = await db<{ id: string }[]>`select id from users where id = ${body.targetUserId}`;
      if (!target) return respondError(set, 404, "user_not_found");
      const [recentCount] = await db<{ count: number }[]>`
        select count(*)::int as count from instance_reports
        where reporter_user_id = ${user.id} and created_at > now() - interval '1 hour'
      `;
      if (recentCount.count >= 10) return respondError(set, 429, "report_rate_limited");

      if (body.messageId) {
        if (!body.conversationId) return respondError(set, 400, "invalid_report_reference");
        const channelContext = await conversationChannelAuthorization(body.conversationId, user.id);
        if (channelContext) {
          const channelAccess = channelContext.access;
          if (!channelAccess) return respondError(set, 400, "invalid_report_reference");
          if (!channelAccess.canView && !await isMetadataChannel(channelContext.channel.server_id, channelContext.channel.id)) {
            return respondError(set, 400, "invalid_report_reference");
          }
        }
        const [reportedMessage] = await db<{ sender_user_id: string }[]>`
          select d.user_id as sender_user_id
          from messages m join devices d on d.id = m.sender_device_id
          where m.id = ${body.messageId} and m.conversation_id = ${body.conversationId}
            and exists (
              select 1 from conversation_members cm
              where cm.conversation_id = m.conversation_id and cm.user_id = ${user.id} and cm.left_at is null
            )
        `;
        if (!reportedMessage || reportedMessage.sender_user_id !== body.targetUserId) {
          return respondError(set, 400, "invalid_report_reference");
        }
      } else {
        if (body.conversationId) return respondError(set, 400, "invalid_report_reference");
        const [sharedServer] = await db<{ shared: boolean }[]>`
          select exists (
            select 1 from server_members mine
            join server_members target on target.server_id = mine.server_id and target.left_at is null
            join servers s on s.id = mine.server_id and s.deactivated_at is null
            where mine.user_id = ${user.id} and mine.left_at is null and target.user_id = ${body.targetUserId}
          ) as shared
        `;
        if (!sharedServer?.shared) return respondError(set, 403, "report_target_not_shared");
      }

      let evidenceCiphertext: Buffer | null = null;
      let evidenceWrappedKey: Buffer | null = null;
      let evidenceIv: Buffer | null = null;
      let evidenceKeyId: string | null = null;
      if (body.encryptedEvidence) {
        try {
          evidenceCiphertext = decodeBase64(body.encryptedEvidence.ciphertext, "ciphertext", 128 * 1024);
          evidenceWrappedKey = decodeBase64(body.encryptedEvidence.wrappedKey, "wrappedKey", 2048);
          evidenceIv = decodeBase64(body.encryptedEvidence.iv, "iv", 32);
        } catch (error) {
          if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_report_evidence");
          throw error;
        }
        if (evidenceIv.byteLength !== 12 || evidenceWrappedKey.byteLength < 384) {
          return respondError(set, 400, "invalid_report_evidence");
        }
        const [key] = await db<{ id: string }[]>`
          select id from instance_report_keys where id = ${body.encryptedEvidence.keyId}
        `;
        if (!key) return respondError(set, 400, "invalid_report_evidence_key");
        evidenceKeyId = key.id;
      }

      try {
        const [report] = await db<{ id: string }[]>`
          insert into instance_reports (
            reporter_user_id, target_user_id, conversation_id, message_id, reason,
            evidence_key_id, evidence_ciphertext, evidence_wrapped_key, evidence_iv
          ) values (
            ${user.id}, ${body.targetUserId}, ${body.conversationId ?? null}, ${body.messageId ?? null}, ${body.reason},
            ${evidenceKeyId}, ${evidenceCiphertext}, ${evidenceWrappedKey}, ${evidenceIv}
          ) returning id
        `;
        set.status = 201;
        return { report: { id: report.id, submitted: true } };
      } catch (error) {
        if (isUniqueViolation(error)) return respondError(set, 409, "report_already_submitted");
        throw error;
      }
    }, {
      body: t.Object({
        targetUserId: t.String({ format: "uuid" }),
        reason: t.Union([
          t.Literal("spam"), t.Literal("harassment"), t.Literal("threats"), t.Literal("sexual_content"),
          t.Literal("illegal_content"), t.Literal("impersonation"), t.Literal("other"),
        ]),
        conversationId: t.Optional(t.String({ format: "uuid" })),
        messageId: t.Optional(t.String({ format: "uuid" })),
        encryptedEvidence: t.Optional(t.Object({
          keyId: t.String({ format: "uuid" }),
          ciphertext: t.String({ minLength: 24, maxLength: 180_000 }),
          wrappedKey: t.String({ minLength: 300, maxLength: 4_096 }),
          iv: t.String({ minLength: 16, maxLength: 64 }),
        })),
      }),
    })
    .post("/v1/servers", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      const created = await db.begin(async (transaction) => {
        const [server] = await transaction<{ id: string; owner_id: string; created_at: Date }[]>`
          insert into servers (owner_id, encrypted_metadata)
          values (${user.id}, ${metadata})
          returning id, owner_id, created_at
        `;
        const systemRoles = [
          { systemKey: "owner", color: "#f0b232", position: 100_000, separateMembers: true, permissions: defaultRolePermissions("owner") },
          { systemKey: "admin", color: "#92aaa5", position: 90_000, separateMembers: true, permissions: defaultRolePermissions("admin") },
          { systemKey: "everyone", color: "#99aab5", position: 0, separateMembers: false, permissions: defaultRolePermissions("everyone") },
        ] as const;
        for (const systemRole of systemRoles) {
          await transaction`
            insert into server_roles (
              server_id, color, position, permissions, mentionable, separate_members, view_all_channels, is_system, system_key
            ) values (
              ${server.id}, ${systemRole.color}, ${systemRole.position}, ${systemRole.permissions}::jsonb,
              false, ${systemRole.separateMembers}, true, true, ${systemRole.systemKey}
            )
          `;
        }
        await transaction`
          insert into server_members (server_id, user_id, role)
          values (${server.id}, ${user.id}, 'owner')
        `;
        await transaction`
          insert into server_member_roles (server_id, user_id, role_id)
          select ${server.id}, ${user.id}, id
          from server_roles
          where server_id = ${server.id} and system_key in ('owner', 'everyone')
        `;
        const [conversation] = await transaction<{ id: string }[]>`
          insert into conversations (kind, created_by)
          values ('channel', ${user.id})
          returning id
        `;
        await transaction`
          insert into conversation_members (conversation_id, user_id, role)
          values (${conversation.id}, ${user.id}, 'owner')
        `;
        const [channel] = await transaction<{ id: string; position: number; created_at: Date }[]>`
          insert into channels (server_id, conversation_id, created_by, position)
          values (${server.id}, ${conversation.id}, ${user.id}, 0)
          returning id, position, created_at
        `;
        await transaction`
          update servers
          set onboarding_channel_id = ${channel.id}, landing_channel_id = ${channel.id}
          where id = ${server.id}
        `;
        return { server, channel, conversationId: conversation.id };
      });
      await recordServerAudit(created.server.id, user.id, "server.created", created.server.id);

      set.status = 201;
      return {
        server: {
          id: created.server.id,
          ownerId: created.server.owner_id,
          encryptedMetadata: encodeBase64(metadata),
          role: "owner",
          permissions: defaultRolePermissions("owner"),
          channelCount: 1,
          onboardingChannelId: created.channel.id,
          landingChannelId: created.channel.id,
          iconUrl: null,
          bannerUrl: null,
          deactivatedAt: null,
          createdAt: created.server.created_at,
        },
        channel: {
          id: created.channel.id,
          serverId: created.server.id,
          conversationId: created.conversationId,
          encryptedMetadata: "",
          categoryId: null,
          kind: "text",
          position: created.channel.position,
          createdAt: created.channel.created_at,
        },
      };
    }, {
      body: t.Object({ encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })) }),
    })
    .get("/v1/servers", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const servers = await db<{
        id: string;
        owner_id: string;
        encrypted_metadata: Buffer;
        role: "owner" | "admin" | "member";
        channel_count: number;
        onboarding_channel_id: string | null;
        landing_channel_id: string | null;
        icon_storage_key: string | null;
        banner_storage_key: string | null;
        deactivated_at: Date | null;
        created_at: Date;
      }[]>`
        select s.id, s.owner_id, s.encrypted_metadata, sm.role,
          count(c.id)::int as channel_count, s.onboarding_channel_id,
          s.landing_channel_id, s.deactivated_at,
          s.icon_storage_key, s.banner_storage_key, s.created_at
        from servers s
        join server_members sm on sm.server_id = s.id
        left join channels c on c.server_id = s.id and c.archived_at is null
        where sm.user_id = ${user.id} and sm.left_at is null
          group by s.id, s.owner_id, s.encrypted_metadata, sm.role, s.created_at,
            s.onboarding_channel_id, s.landing_channel_id, s.deactivated_at,
            s.icon_storage_key, s.banner_storage_key
        order by s.created_at asc
      `;

      return {
        servers: await Promise.all(servers.map(async (server) => ({
          id: server.id,
          ownerId: server.owner_id,
          encryptedMetadata: encodeBase64(server.encrypted_metadata),
          role: server.role,
          permissions: server.deactivated_at
            ? permissionMap(undefined)
            : (await serverAuthorization(server.id, user.id))?.permissions ?? permissionMap(undefined),
          channelCount: server.channel_count,
          onboardingChannelId: server.onboarding_channel_id,
          landingChannelId: server.landing_channel_id,
          iconUrl: server.deactivated_at ? null : serverBrandingUrl(server.id, "icon", server.icon_storage_key),
          bannerUrl: server.deactivated_at ? null : serverBrandingUrl(server.id, "banner", server.banner_storage_key),
          deactivatedAt: server.deactivated_at,
          createdAt: server.created_at,
        }))),
      };
    })
    .get("/v1/servers/:serverId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [server] = await db<{
        id: string;
        owner_id: string;
        encrypted_metadata: Buffer;
        role: "owner" | "admin" | "member";
        channel_count: number;
        onboarding_channel_id: string | null;
        landing_channel_id: string | null;
        icon_storage_key: string | null;
        banner_storage_key: string | null;
        created_at: Date;
      }[]>`
         select s.id, s.owner_id, s.encrypted_metadata, sm.role, s.created_at,
           s.onboarding_channel_id, s.landing_channel_id,
           s.icon_storage_key, s.banner_storage_key,
           count(c.id)::int as channel_count
        from servers s
        join server_members sm on sm.server_id = s.id
        left join channels c on c.server_id = s.id and c.archived_at is null
         where s.id = ${params.serverId} and sm.user_id = ${user.id} and sm.left_at is null
           and s.deactivated_at is null
         group by s.id, s.owner_id, s.encrypted_metadata, sm.role, s.created_at,
            s.onboarding_channel_id, s.landing_channel_id,
            s.icon_storage_key, s.banner_storage_key
      `;
      if (!server) return respondError(set, 404, "server_not_found");
      const authorization = await serverAuthorization(params.serverId, user.id);
      return {
        server: {
          id: server.id,
          ownerId: server.owner_id,
          encryptedMetadata: encodeBase64(server.encrypted_metadata),
          role: server.role,
          permissions: authorization?.permissions ?? permissionMap(undefined),
          channelCount: server.channel_count,
          onboardingChannelId: server.onboarding_channel_id,
          landingChannelId: server.landing_channel_id,
          iconUrl: serverBrandingUrl(server.id, "icon", server.icon_storage_key),
          bannerUrl: serverBrandingUrl(server.id, "banner", server.banner_storage_key),
          deactivatedAt: null,
          createdAt: server.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .patch("/v1/servers/:serverId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      const membership = authorization;
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(membership, "manage_server")) return respondError(set, 403, "insufficient_server_permissions");

      let metadata: Buffer | undefined;
      try {
        metadata = body.encryptedMetadata === undefined ? undefined : decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      if (body.onboardingChannelId || body.landingChannelId) {
        const requestedChannels = [body.onboardingChannelId, body.landingChannelId].filter(
          (channelId): channelId is string => typeof channelId === "string",
        );
        const channels = await db<{ id: string }[]>`
          select id from channels
          where id in ${db(requestedChannels)}
            and server_id = ${params.serverId} and archived_at is null
        `;
        if (body.onboardingChannelId && !channels.some((channel) => channel.id === body.onboardingChannelId)) {
          return respondError(set, 404, "onboarding_channel_not_found");
        }
        if (body.landingChannelId && !channels.some((channel) => channel.id === body.landingChannelId)) {
          return respondError(set, 404, "landing_channel_not_found");
        }
      }

      type ServerUpdateRow = {
        id: string;
        owner_id: string;
        encrypted_metadata: Buffer;
        role: "owner" | "admin" | "member";
        channel_count: number;
        onboarding_channel_id: string | null;
        landing_channel_id: string | null;
        icon_storage_key: string | null;
        banner_storage_key: string | null;
        created_at: Date;
      };
      const onboardingChannel = body.onboardingChannelId === undefined
        ? db`s.onboarding_channel_id`
        : db`${body.onboardingChannelId}`;
      const landingChannel = body.landingChannelId === undefined
        ? db`s.landing_channel_id`
        : db`${body.landingChannelId}`;
      const [server] = await db<ServerUpdateRow[]>`
        update servers s
        set encrypted_metadata = coalesce(${metadata ?? null}, s.encrypted_metadata),
            onboarding_channel_id = ${onboardingChannel},
            landing_channel_id = ${landingChannel},
            updated_at = now()
        where s.id = ${params.serverId}
        returning s.id, s.owner_id, s.encrypted_metadata, s.onboarding_channel_id,
          s.landing_channel_id,
          s.icon_storage_key, s.banner_storage_key,
          (select role from server_members where server_id = s.id and user_id = ${user.id} and left_at is null) as role,
          (select count(*)::int from channels where server_id = s.id and archived_at is null) as channel_count,
          s.created_at
      `;
      if (!server) return respondError(set, 404, "server_not_found");
      await recordServerAudit(params.serverId, user.id, "server.settings_updated", params.serverId);
      return {
        server: {
          id: server.id,
          ownerId: server.owner_id,
          encryptedMetadata: encodeBase64(server.encrypted_metadata),
          role: server.role,
          permissions: membership.permissions,
          channelCount: server.channel_count,
          onboardingChannelId: server.onboarding_channel_id,
          landingChannelId: server.landing_channel_id,
          iconUrl: serverBrandingUrl(server.id, "icon", server.icon_storage_key),
          bannerUrl: serverBrandingUrl(server.id, "banner", server.banner_storage_key),
          deactivatedAt: null,
          createdAt: server.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        onboardingChannelId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
        landingChannelId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
      }),
    })
    .get("/v1/servers/:serverId/branding/:asset", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [server] = params.asset === "icon"
        ? await db<{ storage_key: string | null; mime_type: string | null }[]>`
            select s.icon_storage_key as storage_key, s.icon_mime_type as mime_type
             from servers s join server_members sm on sm.server_id = s.id
             where s.id = ${params.serverId} and sm.user_id = ${user.id} and sm.left_at is null
               and s.deactivated_at is null
          `
        : await db<{ storage_key: string | null; mime_type: string | null }[]>`
            select s.banner_storage_key as storage_key, s.banner_mime_type as mime_type
             from servers s join server_members sm on sm.server_id = s.id
             where s.id = ${params.serverId} and sm.user_id = ${user.id} and sm.left_at is null
               and s.deactivated_at is null
          `;
      if (!server?.storage_key || !server.mime_type) return respondError(set, 404, "server_branding_not_found");
      const path = profileImagePath(server.storage_key);
      if (!(await Bun.file(path).exists())) return respondError(set, 404, "server_branding_not_found");
      return new Response(Bun.file(path), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-type": server.mime_type,
          "x-content-type-options": "nosniff",
        },
      });
    }, {
      params: t.Object({
        serverId: t.String({ format: "uuid" }),
        asset: t.Union([t.Literal("icon"), t.Literal("banner")]),
      }),
    })
    .put("/v1/servers/:serverId/branding/:asset", async ({ headers, params, request, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "manage_server")) return respondError(set, 403, "insufficient_server_permissions");
      const metadata = profileImageMetadata(headers["content-type"]);
      if (!metadata) return respondError(set, 400, "unsupported_server_branding_type");
      const storageKey = `${crypto.randomUUID()}.${metadata.extension}`;
      let stored: { size: number };
      try {
        stored = await storeProfileImage(
          request,
          storageKey,
          config.maxProfileImageBytes,
          (bytes) => validProfileImageBytes(bytes, metadata.mimeType),
        );
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) return respondError(set, 413, "server_branding_too_large");
        if (error instanceof ProfileImageInvalidError) return respondError(set, 400, "invalid_server_branding");
        throw error;
      }

      let previousStorageKey: string | null = null;
      try {
        const updated = params.asset === "icon"
          ? await db.begin(async (transaction) => {
              const [current] = await transaction<{ storage_key: string | null }[]>`
                select icon_storage_key as storage_key from servers where id = ${params.serverId} for update
              `;
              if (!current) return false;
              await transaction`
                update servers
                set icon_storage_key = ${storageKey}, icon_mime_type = ${metadata.mimeType},
                  icon_size_bytes = ${stored.size}, updated_at = now()
                where id = ${params.serverId}
              `;
              previousStorageKey = current.storage_key;
              return true;
            })
          : await db.begin(async (transaction) => {
              const [current] = await transaction<{ storage_key: string | null }[]>`
                select banner_storage_key as storage_key from servers where id = ${params.serverId} for update
              `;
              if (!current) return false;
              await transaction`
                update servers
                set banner_storage_key = ${storageKey}, banner_mime_type = ${metadata.mimeType},
                  banner_size_bytes = ${stored.size}, updated_at = now()
                where id = ${params.serverId}
              `;
              previousStorageKey = current.storage_key;
              return true;
            });
        if (!updated) {
          await removeProfileImage(storageKey);
          return respondError(set, 404, "server_not_found");
        }
        if (previousStorageKey && previousStorageKey !== storageKey) await removeProfileImage(previousStorageKey);
        await recordServerAudit(params.serverId, user.id, `server.${params.asset}_updated`);
        return { url: serverBrandingUrl(params.serverId, params.asset, storageKey) };
      } catch (error) {
        await removeProfileImage(storageKey);
        throw error;
      }
    }, {
      params: t.Object({
        serverId: t.String({ format: "uuid" }),
        asset: t.Union([t.Literal("icon"), t.Literal("banner")]),
      }),
    })
    .delete("/v1/servers/:serverId/branding/:asset", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "manage_server")) return respondError(set, 403, "insufficient_server_permissions");
      const deleted = params.asset === "icon"
        ? await db.begin(async (transaction) => {
            const [current] = await transaction<{ storage_key: string | null }[]>`
              select icon_storage_key as storage_key from servers where id = ${params.serverId} for update
            `;
            if (!current?.storage_key) return null;
            await transaction`
              update servers
              set icon_storage_key = null, icon_mime_type = null, icon_size_bytes = null, updated_at = now()
              where id = ${params.serverId}
            `;
            return current.storage_key;
          })
        : await db.begin(async (transaction) => {
            const [current] = await transaction<{ storage_key: string | null }[]>`
              select banner_storage_key as storage_key from servers where id = ${params.serverId} for update
            `;
            if (!current?.storage_key) return null;
            await transaction`
              update servers
              set banner_storage_key = null, banner_mime_type = null, banner_size_bytes = null, updated_at = now()
              where id = ${params.serverId}
            `;
            return current.storage_key;
          });
      if (deleted) {
        await removeProfileImage(deleted);
        await recordServerAudit(params.serverId, user.id, `server.${params.asset}_removed`);
      }
      return { deleted: Boolean(deleted) };
    }, {
      params: t.Object({
        serverId: t.String({ format: "uuid" }),
        asset: t.Union([t.Literal("icon"), t.Literal("banner")]),
      }),
    })
    .get("/v1/servers/:serverId/emojis", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      const emojis = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        storage_key: string;
        expected_size_bytes: number | string;
        size_bytes: number | string | null;
        status: "pending" | "uploaded";
        created_at: Date;
        uploaded_at: Date | null;
      }[]>`
        select id, server_id, encrypted_metadata, storage_key, expected_size_bytes,
          size_bytes, status, created_at, uploaded_at
        from server_custom_emojis
        where server_id = ${params.serverId}
        order by created_at desc, id desc
      `;
      return {
        emojis: emojis.map((emoji) => ({
          id: emoji.id,
          serverId: emoji.server_id,
          encryptedMetadata: encodeBase64(emoji.encrypted_metadata),
          fileUrl: emoji.status === "uploaded"
            ? `/v1/servers/${encodeURIComponent(params.serverId)}/emojis/${encodeURIComponent(emoji.id)}/file`
            : null,
          expectedSizeBytes: Number(emoji.expected_size_bytes),
          sizeBytes: emoji.size_bytes === null ? null : Number(emoji.size_bytes),
          status: emoji.status,
          createdAt: emoji.created_at,
          uploadedAt: emoji.uploaded_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/emojis", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "manage_custom_emoji")) return respondError(set, 403, "insufficient_server_permissions");
      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }
      const id = crypto.randomUUID();
      const storageKey = `${id}.bin`;
      const [emoji] = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        expected_size_bytes: number | string;
        created_at: Date;
      }[]>`
        insert into server_custom_emojis (
          id, server_id, created_by, encrypted_metadata, storage_key, expected_size_bytes
        ) values (
          ${id}, ${params.serverId}, ${user.id}, ${metadata}, ${storageKey}, ${body.expectedSizeBytes}
        )
        returning id, server_id, encrypted_metadata, expected_size_bytes, created_at
      `;
      await recordServerAudit(params.serverId, user.id, "custom_emoji.created", id);
      set.status = 201;
      return {
        emoji: {
          id: emoji.id,
          serverId: emoji.server_id,
          encryptedMetadata: encodeBase64(emoji.encrypted_metadata),
          fileUrl: null,
          uploadPath: `/v1/servers/${encodeURIComponent(params.serverId)}/emojis/${encodeURIComponent(id)}/file`,
          expectedSizeBytes: Number(emoji.expected_size_bytes),
          sizeBytes: null,
          status: "pending" as const,
          createdAt: emoji.created_at,
          uploadedAt: null,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.String({ minLength: 1, maxLength: 90_000 }),
        expectedSizeBytes: t.Integer({ minimum: 1, maximum: maxCustomEmojiBytes }),
      }),
    })
    .put("/v1/servers/:serverId/emojis/:emojiId/file", async ({ headers, params, request, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "manage_custom_emoji")) return respondError(set, 403, "insufficient_server_permissions");
      const [emoji] = await db<{
        id: string;
        storage_key: string;
        expected_size_bytes: number | string;
        status: "pending" | "uploaded";
      }[]>`
        select id, storage_key, expected_size_bytes, status
        from server_custom_emojis
        where id = ${params.emojiId} and server_id = ${params.serverId}
      `;
      if (!emoji) return respondError(set, 404, "custom_emoji_not_found");
      if (emoji.status === "uploaded") return respondError(set, 409, "custom_emoji_already_uploaded");
      let stored: { size: number };
      try {
        stored = await storeEncryptedAttachment(request, emoji.storage_key, Number(emoji.expected_size_bytes));
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) return respondError(set, 413, "custom_emoji_too_large");
        if (error instanceof AttachmentSizeMismatchError) return respondError(set, 400, "custom_emoji_size_mismatch");
        throw error;
      }
      try {
        const [updated] = await db<{
          id: string;
          server_id: string;
          encrypted_metadata: Buffer;
          expected_size_bytes: number | string;
          size_bytes: number | string;
          status: "pending" | "uploaded";
          created_at: Date;
          uploaded_at: Date;
        }[]>`
          update server_custom_emojis
          set status = 'uploaded', size_bytes = ${stored.size}, uploaded_at = now()
          where id = ${emoji.id} and server_id = ${params.serverId} and status = 'pending'
          returning id, server_id, encrypted_metadata, expected_size_bytes, size_bytes,
            status, created_at, uploaded_at
        `;
        if (!updated) {
          await removeEncryptedAttachment(emoji.storage_key);
          return respondError(set, 409, "custom_emoji_already_uploaded");
        }
        await recordServerAudit(params.serverId, user.id, "custom_emoji.uploaded", emoji.id);
        return {
          emoji: {
            id: updated.id,
            serverId: updated.server_id,
            encryptedMetadata: encodeBase64(updated.encrypted_metadata),
            fileUrl: `/v1/servers/${encodeURIComponent(params.serverId)}/emojis/${encodeURIComponent(updated.id)}/file`,
            expectedSizeBytes: Number(updated.expected_size_bytes),
            sizeBytes: Number(updated.size_bytes),
            status: updated.status,
            createdAt: updated.created_at,
            uploadedAt: updated.uploaded_at,
          },
        };
      } catch (error) {
        await removeEncryptedAttachment(emoji.storage_key);
        throw error;
      }
    }, {
      params: t.Object({
        serverId: t.String({ format: "uuid" }),
        emojiId: t.String({ format: "uuid" }),
      }),
    })
    .get("/v1/servers/:serverId/emojis/:emojiId/file", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      const [emoji] = await db<{ id: string; storage_key: string; status: "pending" | "uploaded" }[]>`
        select id, storage_key, status from server_custom_emojis
        where id = ${params.emojiId} and server_id = ${params.serverId}
      `;
      if (!emoji || emoji.status !== "uploaded") return respondError(set, 404, "custom_emoji_not_found");
      if (!(await encryptedAttachmentExists(emoji.storage_key))) return respondError(set, 404, "custom_emoji_storage_missing");
      return new Response(Bun.file(attachmentPath(emoji.storage_key)), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${emoji.id}.bin"`,
        },
      });
    }, {
      params: t.Object({
        serverId: t.String({ format: "uuid" }),
        emojiId: t.String({ format: "uuid" }),
      }),
    })
    .delete("/v1/servers/:serverId/emojis/:emojiId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "manage_custom_emoji")) return respondError(set, 403, "insufficient_server_permissions");
      const [deleted] = await db<{ id: string; storage_key: string }[]>`
        delete from server_custom_emojis
        where id = ${params.emojiId} and server_id = ${params.serverId}
        returning id, storage_key
      `;
      if (!deleted) return respondError(set, 404, "custom_emoji_not_found");
      await removeEncryptedAttachment(deleted.storage_key);
      await recordServerAudit(params.serverId, user.id, "custom_emoji.deleted", deleted.id);
      return { deleted: true };
    }, {
      params: t.Object({
        serverId: t.String({ format: "uuid" }),
        emojiId: t.String({ format: "uuid" }),
      }),
    })
    .patch("/v1/servers/:serverId/emojis/:emojiId", async ({ headers, params, body, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "manage_custom_emoji")) return respondError(set, 403, "insufficient_server_permissions");
      let metadata: Buffer;
      try { metadata = decodeEncryptedMetadata(body.encryptedMetadata); }
      catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }
      const [updated] = await db<{ id: string }[]>`
        update server_custom_emojis set encrypted_metadata = ${metadata}
        where id = ${params.emojiId} and server_id = ${params.serverId}
        returning id
      `;
      if (!updated) return respondError(set, 404, "custom_emoji_not_found");
      await recordServerAudit(params.serverId, user.id, "custom_emoji.updated", updated.id);
      return { updated: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), emojiId: t.String({ format: "uuid" }) }),
      body: t.Object({ encryptedMetadata: t.String({ minLength: 1, maxLength: 90_000 }) }),
    })
    .get("/v1/servers/:serverId/audit-logs", async ({ headers, params, query, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "view_audit_logs")) return respondError(set, 403, "insufficient_server_permissions");
      const parsedLimit = Number(query.limit ?? 100);
      const limit = Number.isInteger(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 100;
      const logs = await db<{
        id: bigint | number | string;
        action: string;
        target_id: string | null;
        target_user_id: string | null;
        actor_id: string;
        actor_username: string;
        actor_display_name: string;
        created_at: Date;
      }[]>`
        select l.id, l.action, l.target_id, l.target_user_id, l.actor_id,
          actor.username as actor_username, actor.display_name as actor_display_name, l.created_at
        from server_audit_logs l
        join users actor on actor.id = l.actor_id
        where l.server_id = ${params.serverId}
        order by l.created_at desc, l.id desc
        limit ${limit}
      `;
      return {
        logs: logs.map((log) => ({
          id: String(log.id),
          action: log.action,
          targetId: log.target_id,
          targetUserId: log.target_user_id,
          actor: {
            id: log.actor_id,
            username: log.actor_username,
            displayName: log.actor_display_name,
          },
          createdAt: log.created_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      query: t.Object({ limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })) }),
    })
    .delete("/v1/servers/:serverId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 404, "server_not_found");
      if (membership.role !== "owner") return respondError(set, 403, "only_server_owner_can_delete");

      const attachments = await db<{ storage_key: string }[]>`
        select a.storage_key
        from attachments a
        join channels c on c.conversation_id = a.conversation_id
        where c.server_id = ${params.serverId}
      `;
      const [branding] = await db<{ icon_storage_key: string | null; banner_storage_key: string | null }[]>`
        select icon_storage_key, banner_storage_key from servers where id = ${params.serverId}
      `;
      const emojiFiles = await db<{ storage_key: string }[]>`
        select storage_key from server_custom_emojis where server_id = ${params.serverId}
      `;
      const [deleted] = await db<{ id: string }[]>`
        delete from servers
        where id = ${params.serverId} and owner_id = ${user.id}
        returning id
      `;
      if (!deleted) return respondError(set, 404, "server_not_found");
      await Promise.all(attachments.map((attachment) => removeEncryptedAttachment(attachment.storage_key)));
      await Promise.all([
        branding?.icon_storage_key ? removeProfileImage(branding.icon_storage_key) : Promise.resolve(),
        branding?.banner_storage_key ? removeProfileImage(branding.banner_storage_key) : Promise.resolve(),
        ...emojiFiles.map((emoji) => removeEncryptedAttachment(emoji.storage_key)),
      ]);
      return { deleted: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/servers/:serverId/channels", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!await serverMembership(params.serverId, user.id)) return respondError(set, 403, "not_a_server_member");

      const channels = await visibleServerChannels(params.serverId, user.id);
      return {
        channels: channels.map(({ channel, canUpload, canSend }) => ({
          id: channel.id,
          serverId: channel.server_id,
          conversationId: channel.conversation_id,
          encryptedMetadata: encodeBase64(channel.encrypted_metadata),
          categoryId: channel.category_id,
          kind: channel.kind,
          position: channel.position,
          canView: true,
          canUpload,
          canSend,
          createdAt: channel.created_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/channels", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_channels", "create_channels")) return respondError(set, 403, "insufficient_server_permissions");

      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      const created = await db.begin(async (transaction) => {
        const [position] = await transaction<{ next_position: number }[]>`
          select coalesce(max(position), -1) + 1 as next_position
          from channels where server_id = ${params.serverId} and archived_at is null
        `;
        if (body.categoryId !== null && body.categoryId !== undefined) {
          const [category] = await transaction<{ id: string }[]>`
            select id from categories
            where id = ${body.categoryId} and server_id = ${params.serverId} and archived_at is null
          `;
          if (!category) return { error: "category_not_found" as const };
        }
        const [conversation] = await transaction<{ id: string }[]>`
          insert into conversations (kind, created_by)
          values ('channel', ${user.id})
          returning id
        `;
        const channelKind = body.kind ?? "text";
        const [channel] = await transaction<{ id: string; kind: string; position: number; created_at: Date }[]>`
          insert into channels (server_id, conversation_id, created_by, encrypted_metadata, category_id, kind, position)
          values (${params.serverId}, ${conversation.id}, ${user.id}, ${metadata}, ${body.categoryId ?? null}, ${channelKind}, ${body.position ?? position.next_position})
          returning id, kind, position, created_at
        `;
        await transaction`
          insert into conversation_members (conversation_id, user_id, role)
          select ${conversation.id}, sm.user_id, case when sm.role = 'owner' then 'owner' else 'member' end
          from server_members sm
          where sm.server_id = ${params.serverId} and sm.left_at is null
            and (
              sm.user_id = ${user.id}
              or exists (
                select 1
                from server_member_roles smr
                join server_roles sr on sr.id = smr.role_id
                where smr.server_id = sm.server_id and smr.user_id = sm.user_id
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
                      where src.role_id = sr.id and src.category_id = ${body.categoryId ?? null}
                        and (src.can_view or src.can_upload)
                    )
                  )
              )
            )
          on conflict (conversation_id, user_id) do nothing
        `;
        return { channel, conversationId: conversation.id };
      });

      if ("error" in created) return respondError(set, 404, "category_not_found");
      await recordServerAudit(params.serverId, user.id, "channel.created", created.channel.id);
      set.status = 201;
      return {
        channel: {
          id: created.channel.id,
          serverId: params.serverId,
          conversationId: created.conversationId,
          encryptedMetadata: encodeBase64(metadata),
          categoryId: body.categoryId ?? null,
          kind: created.channel.kind,
          position: created.channel.position,
          canView: true,
          canUpload: true,
          canSend: true,
          createdAt: created.channel.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        categoryId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
        kind: t.Optional(t.Union([t.Literal("text"), t.Literal("voice")])),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
      }),
    })
    .patch("/v1/servers/:serverId/channels/:channelId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_channels", "edit_channels", "reorder_channels")) return respondError(set, 403, "insufficient_server_permissions");
      if (body.encryptedMetadata !== undefined && !hasAnyServerPermission(membership, "manage_channels", "edit_channels")) return respondError(set, 403, "insufficient_server_permissions");
      if (body.categoryId !== undefined && !hasAnyServerPermission(membership, "manage_channels", "edit_channels")) return respondError(set, 403, "insufficient_server_permissions");
      if (body.position !== undefined && !hasAnyServerPermission(membership, "manage_channels", "reorder_channels")) return respondError(set, 403, "insufficient_server_permissions");

      const [existing] = await db<{ id: string; encrypted_metadata: Buffer }[]>`
        select id, encrypted_metadata from channels
        where id = ${params.channelId} and server_id = ${params.serverId} and archived_at is null
      `;
      if (!existing) return respondError(set, 404, "channel_not_found");

      if (body.categoryId !== undefined && body.categoryId !== null) {
        const [category] = await db<{ id: string }[]>`
          select id from categories
          where id = ${body.categoryId} and server_id = ${params.serverId} and archived_at is null
        `;
        if (!category) return respondError(set, 404, "category_not_found");
      }

      let metadata: Buffer | undefined;
      try {
        metadata = body.encryptedMetadata === undefined
          ? undefined
          : decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      type ChannelUpdateRow = {
        id: string;
        server_id: string;
        conversation_id: string;
        encrypted_metadata: Buffer;
        category_id: string | null;
        kind: string;
        position: number;
        created_at: Date;
      };
      const channelRows = body.categoryId === undefined
        ? await db<ChannelUpdateRow[]>`
            update channels
            set encrypted_metadata = coalesce(${metadata ?? null}, encrypted_metadata),
                position = coalesce(${body.position ?? null}, position)
            where id = ${existing.id}
            returning id, server_id, conversation_id, encrypted_metadata, category_id, kind, position, created_at
          `
        : await db<ChannelUpdateRow[]>`
            update channels
            set encrypted_metadata = coalesce(${metadata ?? null}, encrypted_metadata),
                category_id = ${body.categoryId},
                position = coalesce(${body.position ?? null}, position)
            where id = ${existing.id}
            returning id, server_id, conversation_id, encrypted_metadata, category_id, kind, position, created_at
          `;
      const channel = channelRows[0];
      if (!channel) return respondError(set, 404, "channel_not_found");
      const access = await channelAuthorization(params.serverId, user.id, channel.id);
      await recordServerAudit(params.serverId, user.id, "channel.updated", channel.id);
      return {
        channel: {
          id: channel.id,
          serverId: channel.server_id,
          conversationId: channel.conversation_id,
          encryptedMetadata: encodeBase64(channel.encrypted_metadata),
          categoryId: channel.category_id,
          kind: channel.kind,
          position: channel.position,
          canView: Boolean(access?.canView),
          canUpload: Boolean(access?.canUpload),
          canSend: Boolean(access && hasServerPermission(access.authorization, "send_messages")),
          createdAt: channel.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), channelId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        categoryId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
      }),
    })
    .delete("/v1/servers/:serverId/channels/:channelId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_channels", "archive_channels")) return respondError(set, 403, "insufficient_server_permissions");
      const [activeCount] = await db<{ count: number }[]>`
        select count(*)::int as count from channels
        where server_id = ${params.serverId} and archived_at is null
      `;
      if (activeCount.count <= 1) return respondError(set, 409, "cannot_archive_last_channel");
      const [metadataAnchor] = await db<{ id: string }[]>`
        select id from channels
        where server_id = ${params.serverId}
        order by created_at asc
        limit 1
      `;
      if (metadataAnchor?.id === params.channelId) return respondError(set, 409, "cannot_archive_metadata_channel");
      const [archived] = await db<{ id: string }[]>`
        update channels set archived_at = coalesce(archived_at, now())
        where id = ${params.channelId} and server_id = ${params.serverId} and archived_at is null
        returning id
      `;
      if (!archived) return respondError(set, 404, "channel_not_found");
      await recordServerAudit(params.serverId, user.id, "channel.archived", archived.id);
      return { archived: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), channelId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/servers/:serverId/categories", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!await serverMembership(params.serverId, user.id)) return respondError(set, 403, "not_a_server_member");
      const categories = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        position: number;
        created_at: Date;
      }[]>`
        select id, server_id, encrypted_metadata, position, created_at
        from categories
        where server_id = ${params.serverId} and archived_at is null
        order by position asc, created_at asc
      `;
      return {
        categories: categories.map((category) => ({
          id: category.id,
          serverId: category.server_id,
          encryptedMetadata: encodeBase64(category.encrypted_metadata),
          position: category.position,
          createdAt: category.created_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/categories", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_channels", "manage_categories")) return respondError(set, 403, "insufficient_server_permissions");

      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }
      const [position] = await db<{ next_position: number }[]>`
        select coalesce(max(position), -1) + 1 as next_position
        from categories where server_id = ${params.serverId} and archived_at is null
      `;
      const [category] = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        position: number;
        created_at: Date;
      }[]>`
        insert into categories (server_id, created_by, encrypted_metadata, position)
        values (${params.serverId}, ${user.id}, ${metadata}, ${body.position ?? position.next_position})
        returning id, server_id, encrypted_metadata, position, created_at
      `;
      await recordServerAudit(params.serverId, user.id, "category.created", category.id);
      set.status = 201;
      return {
        category: {
          id: category.id,
          serverId: category.server_id,
          encryptedMetadata: encodeBase64(category.encrypted_metadata),
          position: category.position,
          createdAt: category.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
      }),
    })
    .patch("/v1/servers/:serverId/categories/:categoryId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_channels", "manage_categories")) return respondError(set, 403, "insufficient_server_permissions");

      const [existing] = await db<{ id: string }[]>`
        select id from categories
        where id = ${params.categoryId} and server_id = ${params.serverId} and archived_at is null
      `;
      if (!existing) return respondError(set, 404, "category_not_found");
      let metadata: Buffer | undefined;
      try {
        metadata = body.encryptedMetadata === undefined ? undefined : decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }
      const [category] = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        position: number;
        created_at: Date;
      }[]>`
        update categories
        set encrypted_metadata = coalesce(${metadata ?? null}, encrypted_metadata),
            position = coalesce(${body.position ?? null}, position)
        where id = ${existing.id}
        returning id, server_id, encrypted_metadata, position, created_at
      `;
      await recordServerAudit(params.serverId, user.id, "category.updated", category.id);
      return {
        category: {
          id: category.id,
          serverId: category.server_id,
          encryptedMetadata: encodeBase64(category.encrypted_metadata),
          position: category.position,
          createdAt: category.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), categoryId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
      }),
    })
    .delete("/v1/servers/:serverId/categories/:categoryId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_channels", "manage_categories")) return respondError(set, 403, "insufficient_server_permissions");
      const archived = await db.begin(async (transaction) => {
        const [category] = await transaction<{ id: string }[]>`
          update categories set archived_at = coalesce(archived_at, now())
          where id = ${params.categoryId} and server_id = ${params.serverId} and archived_at is null
          returning id
        `;
        if (!category) return false;
        await transaction`
          update channels set category_id = null
          where server_id = ${params.serverId} and category_id = ${params.categoryId}
        `;
        return true;
      });
      if (!archived) return respondError(set, 404, "category_not_found");
      await recordServerAudit(params.serverId, user.id, "category.archived", params.categoryId);
      return { archived: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), categoryId: t.String({ format: "uuid" }) }),
    })
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
    })
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
      const target = await serverAuthorization(params.serverId, warning.user_id);
      if (target && (target.isOwner || !canModerateTarget(authorization, target))) return respondError(set, 403, "insufficient_server_permissions");
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
    })
    .post("/v1/devices", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      let identityKey: Buffer;
      let signedPrekey: Buffer;
      try {
        identityKey = decodeBase64(body.identityKey, "identityKey", 4096);
        signedPrekey = decodeBase64(body.signedPrekey, "signedPrekey", 4096);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_key_encoding");
        throw error;
      }

      const prekeys: Buffer[] = [];
      try {
        for (const prekey of body.oneTimePrekeys ?? []) {
          prekeys.push(decodeBase64(prekey.publicKey, "oneTimePrekeys.publicKey", 4096));
        }
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_key_encoding");
        throw error;
      }

      const device = await db.begin(async (transaction) => {
        const [created] = await transaction<{ id: string; name: string; created_at: Date }[]>`
          insert into devices (user_id, name, identity_key, signed_prekey)
          values (${user.id}, ${body.name}, ${identityKey}, ${signedPrekey})
          returning id, name, created_at
        `;

        for (const [index, publicKey] of prekeys.entries()) {
          const keyId = body.oneTimePrekeys?.[index]?.keyId;
          if (keyId === undefined) throw new Error("prekey id missing after validation");
          await transaction`
            insert into one_time_prekeys (device_id, key_id, public_key)
            values (${created.id}, ${keyId}, ${publicKey})
          `;
        }

        return created;
      });

      set.status = 201;
      return { device };
    }, {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 80 }),
        identityKey: encryptedBytes(6_000),
        signedPrekey: encryptedBytes(6_000),
        oneTimePrekeys: t.Optional(t.Array(t.Object({
          keyId: t.Integer({ minimum: 0, maximum: 2_147_483_647 }),
          publicKey: encryptedBytes(6_000),
        }), { maxItems: 100 })),
      }),
    })
    .get("/v1/devices", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const devices = await db<{
        id: string;
        name: string;
        identity_key: Buffer;
        signed_prekey: Buffer;
        created_at: Date;
        revoked_at: Date | null;
      }[]>`
        select id, name, identity_key, signed_prekey, created_at, revoked_at
        from devices where user_id = ${user.id} order by created_at asc
      `;

      return {
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          identityKey: encodeBase64(device.identity_key),
          signedPrekey: encodeBase64(device.signed_prekey),
          createdAt: device.created_at,
          revokedAt: device.revoked_at,
        })),
      };
    })
    .post("/v1/devices/:deviceId/revoke", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [revokedDevice] = await db<{ id: string }[]>`
        update devices
        set revoked_at = coalesce(revoked_at, now())
        where id = ${params.deviceId} and user_id = ${user.id}
        returning id
      `;
      if (!revokedDevice) return respondError(set, 404, "device_not_found");
      await db`
        update crypto_devices
        set revoked_at = coalesce(revoked_at, now()), updated_at = now()
        where device_id = ${params.deviceId}
      `;
      return { revoked: true };
    }, {
      params: t.Object({ deviceId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/devices/:deviceId/prekeys", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [device] = await db<{ id: string }[]>`
        select id from devices
        where id = ${params.deviceId} and user_id = ${user.id} and revoked_at is null
      `;
      if (!device) return respondError(set, 404, "device_not_found");

      const prekeys: Array<{ keyId: number; publicKey: Buffer }> = [];
      try {
        for (const prekey of body.prekeys) {
          prekeys.push({
            keyId: prekey.keyId,
            publicKey: decodeBase64(prekey.publicKey, "prekeys.publicKey", 4096),
          });
        }
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_key_encoding");
        throw error;
      }

      await db.begin(async (transaction) => {
        for (const prekey of prekeys) {
          await transaction`
            insert into one_time_prekeys (device_id, key_id, public_key)
            values (${params.deviceId}, ${prekey.keyId}, ${prekey.publicKey})
            on conflict (device_id, key_id) do nothing
          `;
        }
      });

      return { accepted: prekeys.length };
    }, {
      params: t.Object({ deviceId: t.String({ format: "uuid" }) }),
      body: t.Object({
        prekeys: t.Array(t.Object({
          keyId: t.Integer({ minimum: 0, maximum: 2_147_483_647 }),
          publicKey: encryptedBytes(6_000),
        }), { minItems: 1, maxItems: 100 }),
      }),
    })
    .get("/v1/users/:userId/devices/keys", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const bundles = await db.begin(async (transaction) => {
        const devices = await transaction<{
          id: string;
          identity_key: Buffer;
          signed_prekey: Buffer;
        }[]>`
          select id, identity_key, signed_prekey
          from devices
          where user_id = ${params.userId} and revoked_at is null
          order by created_at asc
        `;

        const result = [];
        for (const device of devices) {
          const [prekey] = await transaction<{
            key_id: number;
            public_key: Buffer;
          }[]>`
            select key_id, public_key
            from one_time_prekeys
            where device_id = ${device.id} and consumed_at is null
            order by key_id asc
            limit 1
            for update skip locked
          `;

          if (prekey) {
            await transaction`
              update one_time_prekeys
              set consumed_at = now()
              where device_id = ${device.id} and key_id = ${prekey.key_id}
            `;
          }

          result.push({ device, prekey });
        }

        return result;
      });

      return {
        devices: bundles.map(({ device, prekey }) => ({
          deviceId: device.id,
          identityKey: encodeBase64(device.identity_key),
          signedPrekey: encodeBase64(device.signed_prekey),
          oneTimePrekey: prekey
            ? { keyId: prekey.key_id, publicKey: encodeBase64(prekey.public_key) }
            : null,
        })),
      };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/voice/token", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const accessError = await directVoiceCallAccessError(body.conversationId, user.id);
      if (accessError) return respondError(set, 403, accessError);
      if (!config.liveKit) return respondError(set, 503, "voice_service_not_configured");
      try {
        if (await voiceTokenRateLimited(user.id)) return respondError(set, 429, "voice_token_rate_limited");
      } catch {
        return respondError(set, 503, "voice_token_service_unavailable");
      }

      const roomDigest = Buffer.from(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${body.conversationId}:${body.callId}`),
      )).toString("base64url");
      const roomName = `naigi-voice-${roomDigest}`;
      const roomService = liveKitRoomService();
      if (!roomService) return respondError(set, 503, "voice_service_not_configured");
      try {
        await roomService.createRoom({ name: roomName, emptyTimeout: 45, departureTimeout: 30, maxParticipants: 2 });
      } catch (error) {
        const existingRooms = await roomService.listRooms([roomName]).catch(() => []);
        if (!existingRooms.some((room) => room.name === roomName)) throw error;
      }

      const accessToken = new AccessToken(config.liveKit.apiKey, config.liveKit.apiSecret, {
        identity: crypto.randomUUID(),
        ttl: "10m",
      });
      accessToken.addGrant({
        roomJoin: true,
        room: roomName,
        canPublishSources: [TrackSource.MICROPHONE],
        canSubscribe: true,
        canPublishData: false,
      });
      set.headers["cache-control"] = "no-store";
      return { url: config.liveKit.webSocketUrl, token: await accessToken.toJwt() };
    }, {
      body: t.Object({
        conversationId: t.String({ format: "uuid" }),
        callId: t.String({ format: "uuid" }),
      }),
    })
    .post("/v1/voice/check", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const accessError = await directVoiceCallAccessError(body.conversationId, user.id);
      if (accessError) return respondError(set, 403, accessError);
      set.headers["cache-control"] = "no-store";
      return { authorized: true };
    }, {
      body: t.Object({
        conversationId: t.String({ format: "uuid" }),
        callId: t.String({ format: "uuid" }),
      }),
    })
    .post("/v1/voice/room-token", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const access = await voiceRoomAccessError(body.channelId, user.id);
      if ("error" in access) return respondError(set, 403, access.error ?? "voice_room_not_found");
      if (!config.liveKit) return respondError(set, 503, "voice_service_not_configured");
      try {
        if (await voiceTokenRateLimited(user.id)) return respondError(set, 429, "voice_token_rate_limited");
      } catch {
        return respondError(set, 503, "voice_token_service_unavailable");
      }

      const roomDigest = Buffer.from(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`naigi-voice-channel:${access.channel.id}`),
      )).toString("base64url");
      const roomName = `naigi-voice-room-${roomDigest}`;
      const roomService = liveKitRoomService();
      if (!roomService) return respondError(set, 503, "voice_service_not_configured");
      let failureStage = "list_room";
      try {
        let rooms = await roomService.listRooms([roomName]);
        if (!rooms.some((room) => room.name === roomName)) {
          failureStage = "create_room";
          try {
            // Do not impose an application-wide participant count. LiveKit and
            // the host's deployment resources determine how many can join.
            await roomService.createRoom({ name: roomName, emptyTimeout: 60, departureTimeout: 30 });
          } catch {
            failureStage = "confirm_room_creation";
            rooms = await roomService.listRooms([roomName]);
            if (!rooms.some((room) => room.name === roomName)) throw new Error("voice_room_creation_failed");
          }
          failureStage = "verify_room";
          rooms = await roomService.listRooms([roomName]);
        }
        const activeParticipants = rooms.find((room) => room.name === roomName)?.numParticipants ?? 0;
        const bootstrapKey = `naigi:voice-room-bootstrap:${access.channel.id}`;
        let canStart = false;
        failureStage = "bootstrap_lock";
        if (activeParticipants > 0) {
          await evalRedisScript("return redis.call('DEL', KEYS[1])", 1, bootstrapKey);
        } else {
          const acquired = await evalRedisScript(
            "if redis.call('EXISTS', KEYS[1]) == 0 then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); return 1; end; return 0",
            1,
            bootstrapKey,
            crypto.randomUUID(),
            30,
          );
          canStart = Number(acquired) === 1;
        }

        failureStage = "sign_token";
        const accessToken = new AccessToken(config.liveKit.apiKey, config.liveKit.apiSecret, {
          identity: crypto.randomUUID(),
          ttl: "10m",
        });
        accessToken.addGrant({
          roomJoin: true,
          room: roomName,
          canPublishSources: [TrackSource.MICROPHONE],
          canSubscribe: true,
          canPublishData: false,
        });
        set.headers["cache-control"] = "no-store";
        return { url: config.liveKit.webSocketUrl, token: await accessToken.toJwt(), canStart };
      } catch (error) {
        const errorType = error instanceof Error ? error.name : typeof error;
        console.error(`[voice-room] room token failed at ${failureStage} (${errorType})`);
        return respondError(set, 503, "voice_room_service_unavailable");
      }
    }, {
      body: t.Object({ channelId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/voice/room-check", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const access = await voiceRoomAccessError(body.channelId, user.id);
      if ("error" in access) return respondError(set, 403, access.error ?? "voice_room_not_found");
      set.headers["cache-control"] = "no-store";
      return { authorized: true };
    }, {
      body: t.Object({ channelId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/crypto/keys/upload", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const upload = parseCryptoUpload(body);
      if (!upload || (upload.deviceKeys && upload.deviceKeys.user_id !== matrixUserId(user.id))) {
        return respondError(set, 400, "invalid_crypto_key_upload");
      }

      const deviceId = upload.deviceId;
      const [knownCryptoDevice] = await db<{ user_id: string; revoked_at: Date | null }[]>`
        select user_id, revoked_at
        from crypto_devices
        where device_id = ${deviceId}
      `;
      if (!upload.deviceKeys && (!knownCryptoDevice || knownCryptoDevice.user_id !== user.id || knownCryptoDevice.revoked_at)) {
        return respondError(set, 400, "invalid_crypto_key_upload");
      }

      const publicKeyBytes = upload.deviceKeys ? Buffer.from(JSON.stringify(upload.deviceKeys)) : undefined;
      await db.begin(async (transaction) => {
        const [existingDevice] = await transaction<{ user_id: string; revoked_at: Date | null }[]>`
          select user_id, revoked_at from devices where id = ${deviceId}
        `;
        if (existingDevice && existingDevice.user_id !== user.id) {
          throw new Error("crypto device belongs to another user");
        }
        if (existingDevice?.revoked_at) {
          throw new Error("crypto device has been revoked");
        }

        if (!existingDevice && !upload.deviceKeys) {
          throw new Error("crypto device keys missing");
        }

        if (!existingDevice && upload.deviceKeys) {
          await transaction`
            insert into devices (id, user_id, name, identity_key, signed_prekey)
            values (
              ${deviceId}, ${user.id}, 'web', ${publicKeyBytes}, ${publicKeyBytes}
            )
          `;
        }

        if (upload.deviceKeys) {
          await transaction`
            insert into crypto_devices (device_id, user_id, matrix_user_id, device_keys, fallback_keys)
            values (
              ${deviceId}, ${user.id}, ${upload.deviceKeys.user_id},
              ${upload.deviceKeys}::jsonb, ${upload.fallbackKeys}::jsonb
            )
            on conflict (device_id) do update set
              device_keys = excluded.device_keys,
              fallback_keys = excluded.fallback_keys,
              updated_at = now(),
              revoked_at = null
          `;
        } else {
          await transaction`
            update crypto_devices
            set updated_at = now()
            where device_id = ${deviceId} and user_id = ${user.id} and revoked_at is null
          `;
        }

        for (const [keyId, key] of Object.entries(upload.oneTimeKeys)) {
          await transaction`
            insert into crypto_one_time_keys (device_id, key_id, key_json)
            values (${deviceId}, ${keyId}, ${key}::jsonb)
            on conflict (device_id, key_id) do update set
              key_json = excluded.key_json
            where crypto_one_time_keys.claimed_at is null
          `;
        }

        for (const [keyId, key] of Object.entries(upload.fallbackKeys)) {
          await transaction`
            insert into crypto_fallback_keys (device_id, key_id, key_json)
            values (${deviceId}, ${keyId}, ${key}::jsonb)
            on conflict (device_id, key_id) do update set
              key_json = excluded.key_json
            where crypto_fallback_keys.used_at is null
          `;
        }
      });

      const [count] = await db<{ count: string }[]>`
        select count(*)::text as count from crypto_one_time_keys
        where device_id = ${deviceId} and claimed_at is null
      `;
      const availableFallbackKeys = await db<{ key_id: string }[]>`
        select key_id from crypto_fallback_keys
        where device_id = ${deviceId} and used_at is null
      `;
      return {
        one_time_key_counts: { signed_curve25519: Number(count.count) },
        unused_fallback_key_types: [...new Set(availableFallbackKeys.map((key) => key.key_id.split(":", 1)[0]))],
      };
    }, { body: t.Any() })
    .post("/v1/crypto/keys/query", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const request = objectValue(body);
      const requested = objectValue(request?.device_keys);
      if (!requested || Object.keys(requested).length > 100) return respondError(set, 400, "invalid_crypto_key_query");

      const deviceKeys: Record<string, Record<string, unknown>> = {};
      for (const [requestedUserId, requestedDevices] of Object.entries(requested)) {
        if (!Array.isArray(requestedDevices) || requestedDevices.length > 100) {
          return respondError(set, 400, "invalid_crypto_key_query");
        }

        const rows = await db<{ device_id: string; device_keys: unknown }[]>`
          select device_id, device_keys
          from crypto_devices
          where matrix_user_id = ${requestedUserId} and revoked_at is null
        `;
        const allowed = new Set(requestedDevices.filter((deviceId): deviceId is string => typeof deviceId === "string"));
        const selected: Record<string, unknown> = {};
        for (const row of rows) {
          if (allowed.size > 0 && !allowed.has(row.device_id)) continue;
          selected[row.device_id] = row.device_keys;
        }
        // An empty device map is a successful response for a user who has
        // not registered a crypto device yet. Omitting the user leaves the
        // Matrix key-query state dirty and causes the client to retry forever.
        deviceKeys[requestedUserId] = selected;
      }

      return { device_keys: deviceKeys, failures: {} };
    }, { body: t.Any() })
    .post("/v1/crypto/keys/claim", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const request = objectValue(body);
      const requested = objectValue(request?.one_time_keys);
      if (!requested || Object.keys(requested).length > 100) return respondError(set, 400, "invalid_crypto_key_claim");

      const result: Record<string, Record<string, Record<string, unknown>>> = {};
      await db.begin(async (transaction) => {
        for (const [requestedUserId, requestedDevicesValue] of Object.entries(requested)) {
          const requestedDevices = objectValue(requestedDevicesValue);
          if (!requestedDevices) continue;

          for (const [deviceId, algorithmValue] of Object.entries(requestedDevices)) {
            if (typeof algorithmValue !== "string") continue;
            let [key] = await transaction<{
              key_id: string;
              key_json: unknown;
            }[]>`
              select k.key_id, k.key_json
              from crypto_one_time_keys k
              join crypto_devices d on d.device_id = k.device_id
              where d.matrix_user_id = ${requestedUserId}
                and d.device_id = ${deviceId}
                and d.revoked_at is null
                and k.claimed_at is null
                and k.key_id like ${`${algorithmValue}:%`}
              order by k.created_at asc
              limit 1
              for update skip locked
            `;
            let fallback = false;
            if (!key) {
              [key] = await transaction<{
                key_id: string;
                key_json: unknown;
              }[]>`
                select key_id, key_json
                from crypto_fallback_keys
                where device_id = ${deviceId}
                  and used_at is null
                  and key_id like ${`${algorithmValue}:%`}
                order by created_at asc
                limit 1
                for update skip locked
              `;
              fallback = Boolean(key);
            }
            if (!key) continue;

            if (fallback) {
              await transaction`
                update crypto_fallback_keys
                set used_at = now()
                where device_id = ${deviceId} and key_id = ${key.key_id}
              `;
            } else {
              await transaction`
                update crypto_one_time_keys
                set claimed_at = now()
                where device_id = ${deviceId} and key_id = ${key.key_id}
              `;
            }
            result[requestedUserId] ??= {};
            result[requestedUserId][deviceId] = { [key.key_id]: key.key_json };
          }
        }
      });

      return { one_time_keys: result, failures: {} };
    }, { body: t.Any() })
    .post("/v1/crypto/send-to-device/:eventType/:transactionId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const request = objectValue(body);
      const messages = objectValue(request?.messages);
      if (!messages || Object.keys(messages).length > 100) return respondError(set, 400, "invalid_to_device_message");

      await db.begin(async (transaction) => {
        for (const [requestedUserId, requestedDevicesValue] of Object.entries(messages)) {
          const requestedDevices = objectValue(requestedDevicesValue);
          if (!requestedDevices) continue;

          for (const [deviceId, content] of Object.entries(requestedDevices)) {
            if (!objectValue(content)) continue;
            const [target] = await transaction<{ device_id: string }[]>`
              select device_id from crypto_devices
              where device_id = ${deviceId}
                and matrix_user_id = ${requestedUserId}
                and revoked_at is null
            `;
            if (!target) continue;

            await transaction`
              insert into crypto_to_device_events (
                event_type, transaction_id, sender_user_id, recipient_device_id, content
              )
              values (
                ${params.eventType}, ${params.transactionId}, ${matrixUserId(user.id)},
                ${deviceId}, ${content}::jsonb
              )
              on conflict (event_type, transaction_id, sender_user_id, recipient_device_id) do nothing
            `;
          }
        }
      });

      return {};
    }, {
      params: t.Object({
        eventType: t.String({ minLength: 1, maxLength: 128 }),
        transactionId: t.String({ minLength: 1, maxLength: 255 }),
      }),
      body: t.Any(),
    })
    .get("/v1/crypto/to-device", async ({ headers, query, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [device] = await db<{ device_id: string }[]>`
        select device_id from crypto_devices
        where device_id = ${query.deviceId} and user_id = ${user.id} and revoked_at is null
      `;
      if (!device) return respondError(set, 404, "crypto_device_not_found");

      const [keyCount] = await db<{ count: string }[]>`
        select count(*)::text as count
        from crypto_one_time_keys
        where device_id = ${query.deviceId} and claimed_at is null
      `;
      const availableFallbackKeys = await db<{ key_id: string }[]>`
        select key_id from crypto_fallback_keys
        where device_id = ${query.deviceId} and used_at is null
      `;

      const events = await db<{
        id: bigint | number | string;
        event_type: string;
        sender_user_id: string;
        content: unknown;
      }[]>`
        select id, event_type, sender_user_id, content
        from crypto_to_device_events
        where recipient_device_id = ${query.deviceId} and delivered_at is null
        order by id asc
        limit 500
      `;

      return {
        events: events.map((event) => ({
          eventId: String(event.id),
          type: event.event_type,
          sender: event.sender_user_id,
          content: event.content,
        })),
        device_lists: { changed: [], left: [] },
        one_time_keys_count: { signed_curve25519: Number(keyCount.count) },
        unused_fallback_key_types: [...new Set(availableFallbackKeys.map((key) => key.key_id.split(":", 1)[0]))],
      };
    }, {
      query: t.Object({ deviceId: t.String({ minLength: 1, maxLength: 255 }) }),
    })
    .post("/v1/crypto/to-device/ack", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [device] = await db<{ device_id: string }[]>`
        select device_id from crypto_devices
        where device_id = ${body.deviceId} and user_id = ${user.id} and revoked_at is null
      `;
      if (!device) return respondError(set, 404, "crypto_device_not_found");
      if (body.eventIds.length === 0) return { acknowledged: 0 };

      const eventIds = body.eventIds.map((eventId) => BigInt(eventId));
      const updated = await db<{ id: bigint | number | string }[]>`
        update crypto_to_device_events
        set delivered_at = now()
        where recipient_device_id = ${body.deviceId}
          and id in ${db(eventIds)}
          and delivered_at is null
        returning id
      `;
      return { acknowledged: updated.length };
    }, {
      body: t.Object({
        deviceId: t.String({ minLength: 1, maxLength: 255 }),
        eventIds: t.Array(t.String({ pattern: "^[0-9]+$" }), { maxItems: 500 }),
      }),
    })
    .post("/v1/conversations", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const memberIds = [...new Set((body.memberUserIds ?? []).filter((id) => id !== user.id))];
      if (body.kind === "dm" && memberIds.length !== 1) {
        return respondError(set, 400, "dm_requires_one_other_member");
      }

      const existingUsers = memberIds.length === 0
        ? []
        : await db<{ id: string }[]>`
            select id from users where id in ${db(memberIds)}
          `;
      if (existingUsers.length !== memberIds.length) return respondError(set, 400, "unknown_member");
      if (body.kind === "dm" && memberIds.length > 0) {
        const blocked = await db<{ blocked_user_id: string }[]>`
          select distinct blocked_user_id from user_blocks
          where (blocker_user_id = ${user.id} and blocked_user_id in ${db(memberIds)})
             or (blocked_user_id = ${user.id} and blocker_user_id in ${db(memberIds)})
        `;
        if (blocked.length > 0) return respondError(set, 403, "blocked_user");
      }

      // Private conversations are addressable only through an existing trust
      // boundary. A caller cannot use a guessed user id to create a room with
      // an unrelated account; every invitee must share an active server with
      // the creator.
      const sharedMembers = memberIds.length === 0
        ? []
        : await db<{ user_id: string }[]>`
            select distinct target.user_id
            from server_members mine
            join server_members target on target.server_id = mine.server_id
              and target.left_at is null
            join servers s on s.id = mine.server_id and s.deactivated_at is null
            where mine.user_id = ${user.id}
              and mine.left_at is null
              and target.user_id in ${db(memberIds)}
          `;
      if (sharedMembers.length !== memberIds.length) return respondError(set, 403, "conversation_member_not_shared");

      let metadata: Buffer;
      try {
        metadata = body.encryptedMetadata
          ? decodeBase64(body.encryptedMetadata, "encryptedMetadata", 64 * 1024, true)
          : Buffer.alloc(0);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      const conversation = await db.begin(async (transaction) => {
        if (body.kind === "dm") {
          const otherUserId = memberIds[0];
          const pairKey = [user.id, otherUserId].sort().join(":");
          // Serialize creation for a pair so two tabs cannot create duplicate
          // direct-message rooms at the same time.
          await transaction`select pg_advisory_xact_lock(hashtextextended(${pairKey}, 0))`;
          const [existing] = await transaction<{ id: string; created_at: Date; left_at: Date | null }[]>`
            select c.id, c.created_at, mine.left_at
            from conversations c
            join conversation_members mine
              on mine.conversation_id = c.id and mine.user_id = ${user.id}
            join conversation_members other_member
              on other_member.conversation_id = c.id and other_member.user_id = ${otherUserId}
            where c.kind = 'dm' and other_member.left_at is null
            order by c.created_at asc, c.id asc
            limit 1
            for update of c
          `;
          if (existing) {
            if (existing.left_at) {
              await transaction`
                update conversation_members
                set left_at = null, joined_at = now(), role = 'member'
                where conversation_id = ${existing.id} and user_id = ${user.id}
              `;
            }
            return { id: existing.id, kind: "dm", created_at: existing.created_at, reused: true };
          }
        }

        const [created] = await transaction<{ id: string; kind: string; created_at: Date }[]>`
          insert into conversations (kind, encrypted_metadata, created_by)
          values (${body.kind}, ${metadata}, ${user.id})
          returning id, kind, created_at
        `;

        await transaction`
          insert into conversation_members (conversation_id, user_id, role)
          values (${created.id}, ${user.id}, 'owner')
        `;
        for (const memberId of memberIds) {
          await transaction`
            insert into conversation_members (conversation_id, user_id, role)
            values (${created.id}, ${memberId}, 'member')
          `;
        }

        return { ...created, reused: false };
      });

      set.status = conversation.reused ? 200 : 201;
      return { conversation: { id: conversation.id, kind: conversation.kind, createdAt: conversation.created_at } };
    }, {
      body: t.Object({
        kind: t.Union([t.Literal("dm"), t.Literal("group")]),
        memberUserIds: t.Optional(t.Array(t.String({ format: "uuid" }), { maxItems: 100 })),
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
      }),
    })
    .get("/v1/conversations", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const conversations = await db<{
        id: string;
        kind: string;
        encrypted_metadata: Buffer;
        created_at: Date;
        member_display_names: string[];
      }[]>`
        select c.id, c.kind, c.encrypted_metadata, c.created_at,
          coalesce(
            array_agg(other_user.display_name order by other_member.joined_at)
              filter (where other_member.user_id <> ${user.id}),
            array[]::text[]
          ) as member_display_names
        from conversations c
        join conversation_members m on m.conversation_id = c.id
        join conversation_members other_member on other_member.conversation_id = c.id
          and other_member.user_id <> ${user.id} and other_member.left_at is null
        join users other_user on other_user.id = other_member.user_id
        where m.user_id = ${user.id} and m.left_at is null
          and not exists (
            select 1 from channels channel_filter where channel_filter.conversation_id = c.id
          )
          and not (
            c.kind = 'dm' and exists (
              select 1 from conversation_members blocked_member
              join user_blocks b on (b.blocker_user_id = ${user.id} and b.blocked_user_id = blocked_member.user_id)
                or (b.blocked_user_id = ${user.id} and b.blocker_user_id = blocked_member.user_id)
              where blocked_member.conversation_id = c.id
                and blocked_member.user_id <> ${user.id} and blocked_member.left_at is null
            )
          )
          and not (
            c.kind = 'dm' and exists (
              select 1
              from conversations older
              join conversation_members older_mine
                on older_mine.conversation_id = older.id
                and older_mine.user_id = ${user.id} and older_mine.left_at is null
              join conversation_members older_other
                on older_other.conversation_id = older.id
                and older_other.user_id = other_member.user_id and older_other.left_at is null
              where older.kind = 'dm'
                and (older.created_at, older.id) < (c.created_at, c.id)
            )
          )
        group by c.id, c.kind, c.encrypted_metadata, c.created_at
        order by c.created_at desc
      `;

      return {
        conversations: conversations.map((conversation) => ({
          id: conversation.id,
          kind: conversation.kind,
          encryptedMetadata: encodeBase64(conversation.encrypted_metadata),
          memberDisplayNames: conversation.member_display_names,
          createdAt: conversation.created_at,
        })),
      };
    })
    .get("/v1/conversations/:conversationId/members", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (await directConversationIsBlocked(params.conversationId, user.id)) return respondError(set, 403, "blocked_user");
      const channelContext = await conversationChannelAuthorization(params.conversationId, user.id);
      if (channelContext) {
        const channelAccess = channelContext.access;
        if (!channelAccess) return respondError(set, 403, "channel_not_visible");
        if (!channelAccess.canView && !await isMetadataChannel(channelContext.channel.server_id, channelContext.channel.id)) {
          return respondError(set, 403, "channel_not_visible");
        }
      }

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      if (!membership) return respondError(set, 403, "not_a_conversation_member");

      const members = await db<{
        id: string;
        username: string;
        display_name: string;
        profile_image_storage_key: string | null;
        profile_banner_storage_key: string | null;
        role_ids: string[];
      }[]>`
        select u.id, u.username, u.display_name, u.profile_image_storage_key,
          u.profile_banner_storage_key,
          coalesce(array_agg(smr.role_id order by smr.assigned_at asc) filter (where smr.role_id is not null), array[]::uuid[]) as role_ids
        from conversation_members m
        join users u on u.id = m.user_id
        left join channels c on c.conversation_id = m.conversation_id
        left join server_member_roles smr on smr.server_id = c.server_id and smr.user_id = m.user_id
        where m.conversation_id = ${params.conversationId} and m.left_at is null
        group by u.id, u.username, u.display_name, u.profile_image_storage_key,
          u.profile_banner_storage_key, m.joined_at
        order by m.joined_at asc
      `;
      return {
        members: members.map((member) => ({
          userId: member.id,
          matrixUserId: matrixUserId(member.id),
            username: member.username,
            displayName: member.display_name,
            avatarUrl: profileImageUrl(member.id, member.profile_image_storage_key),
            bannerUrl: profileBannerUrl(member.id, member.profile_banner_storage_key),
            roleIds: stringArray(member.role_ids),
          })),
      };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
    })
    .delete("/v1/conversations/:conversationId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [conversation] = await db<{ kind: string; user_id: string }[]>`
        select c.kind, cm.user_id
        from conversations c
        join conversation_members cm on cm.conversation_id = c.id
        where c.id = ${params.conversationId} and cm.user_id = ${user.id} and cm.left_at is null
      `;
      if (!conversation) return respondError(set, 404, "conversation_not_found");
      if (conversation.kind === "channel") return respondError(set, 409, "cannot_delete_server_channel");

      await db`
        update conversation_members
        set left_at = coalesce(left_at, now())
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      return { deleted: true };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/conversations/:conversationId/attachments", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (await directConversationIsBlocked(params.conversationId, user.id)) return respondError(set, 403, "blocked_user");
      const channelContext = await conversationChannelAuthorization(params.conversationId, user.id);
      if (channelContext) {
        if (!channelContext.access?.canView) return respondError(set, 403, "channel_not_visible");
        if (!channelContext.access.canUpload) return respondError(set, 403, "insufficient_channel_permissions");
        if (await isUserTimedOut(channelContext.channel.server_id, user.id)) return respondError(set, 403, "member_timed_out");
      }

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      if (!membership) return respondError(set, 403, "not_a_conversation_member");
      if (await isInstanceUserTimedOut(user.id)) return respondError(set, 403, "instance_user_timed_out");

      const metadata = attachmentMetadata(body.extension, body.mimeType);
      if (!metadata) return respondError(set, 400, "unsupported_attachment_type");

      const attachmentId = crypto.randomUUID();
      const storageKey = `${attachmentId}.${metadata.extension}`;
      const [attachment] = await db<{
        id: string;
        conversation_id: string;
        storage_key: string;
        file_extension: string;
        mime_type: string;
        expected_size_bytes: number;
        created_at: Date;
      }[]>`
        insert into attachments (
          id, conversation_id, uploaded_by, storage_key, file_extension, mime_type, expected_size_bytes
        )
        values (
          ${attachmentId}, ${params.conversationId}, ${user.id}, ${storageKey},
          ${metadata.extension}, ${metadata.mimeType}, ${body.expectedSizeBytes}
        )
        returning id, storage_key, file_extension, mime_type, expected_size_bytes, created_at
      `;

      set.status = 201;
      return {
        attachment: {
          id: attachment.id,
          extension: attachment.file_extension,
          mimeType: attachment.mime_type,
          expectedSizeBytes: Number(attachment.expected_size_bytes),
          uploadPath: `/v1/attachments/${attachment.id}`,
          createdAt: attachment.created_at,
        },
      };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
      body: t.Object({
        expectedSizeBytes: t.Integer({ minimum: 1, maximum: config.maxAttachmentBytes }),
        extension: t.String({ minLength: 1, maxLength: 12, pattern: "^[A-Za-z0-9]+$" }),
        mimeType: t.String({ minLength: 3, maxLength: 127, pattern: "^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$" }),
      }),
    })
    .put("/v1/attachments/:attachmentId", async ({ headers, params, request, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [attachment] = await db<{
        id: string;
        conversation_id: string;
        storage_key: string;
        expected_size_bytes: number;
        file_extension: string;
        mime_type: string;
        status: string;
      }[]>`
        select a.id, a.conversation_id, a.storage_key, a.expected_size_bytes, a.file_extension, a.mime_type, a.status
        from attachments a
        join conversation_members m on m.conversation_id = a.conversation_id
        where a.id = ${params.attachmentId} and m.user_id = ${user.id} and m.left_at is null
      `;
      if (!attachment) return respondError(set, 404, "attachment_not_found");
      if (await isInstanceUserTimedOut(user.id)) return respondError(set, 403, "instance_user_timed_out");
      if (await directConversationIsBlocked(attachment.conversation_id, user.id)) return respondError(set, 403, "blocked_user");
      const channelContext = await conversationChannelAuthorization(attachment.conversation_id, user.id);
      if (channelContext) {
        if (!channelContext.access?.canView) return respondError(set, 403, "channel_not_visible");
        if (!channelContext.access.canUpload) return respondError(set, 403, "insufficient_channel_permissions");
        if (await isUserTimedOut(channelContext.channel.server_id, user.id)) return respondError(set, 403, "member_timed_out");
      }
      if (attachment.status === "uploaded") return respondError(set, 409, "attachment_already_uploaded");

      let stored: { size: number; hash: Buffer };
      try {
        stored = await storeEncryptedAttachment(
          request,
          attachment.storage_key,
          Number(attachment.expected_size_bytes),
        );
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) return respondError(set, 413, "attachment_too_large");
        if (error instanceof AttachmentSizeMismatchError) return respondError(set, 400, "attachment_size_mismatch");
        throw error;
      }

      let updated: {
        id: string;
        size_bytes: number;
        sha256: Buffer;
        uploaded_at: Date;
      } | undefined;
      try {
        [updated] = await db<{
          id: string;
          size_bytes: number;
          sha256: Buffer;
          uploaded_at: Date;
        }[]>`
          update attachments
          set status = 'uploaded', size_bytes = ${stored.size}, sha256 = ${stored.hash}, uploaded_at = now()
          where id = ${attachment.id} and status = 'pending'
          returning id, size_bytes, sha256, uploaded_at
        `;
      } catch (error) {
        await removeEncryptedAttachment(attachment.storage_key);
        throw error;
      }
      if (!updated) {
        await removeEncryptedAttachment(attachment.storage_key);
        return respondError(set, 409, "attachment_already_uploaded");
      }

      return {
        attachment: {
          id: updated.id,
          sizeBytes: Number(updated.size_bytes),
          sha256: encodeBase64(updated.sha256),
          uploadedAt: updated.uploaded_at,
        },
      };
    }, {
      params: t.Object({ attachmentId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/attachments/:attachmentId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [attachment] = await db<{
        id: string;
        conversation_id: string;
        storage_key: string;
        file_extension: string;
        mime_type: string;
        size_bytes: number;
        status: string;
      }[]>`
        select a.id, a.conversation_id, a.storage_key, a.file_extension, a.mime_type, a.size_bytes, a.status
        from attachments a
        join conversation_members m on m.conversation_id = a.conversation_id
        where a.id = ${params.attachmentId} and m.user_id = ${user.id} and m.left_at is null
      `;
      if (!attachment || attachment.status !== "uploaded") {
        return respondError(set, 404, "attachment_not_found");
      }
      if (await directConversationIsBlocked(attachment.conversation_id, user.id)) return respondError(set, 403, "blocked_user");
      const channelContext = await conversationChannelAuthorization(attachment.conversation_id, user.id);
      if (channelContext && !channelContext.access?.canView) return respondError(set, 403, "channel_not_visible");
      if (!(await encryptedAttachmentExists(attachment.storage_key))) {
        return respondError(set, 404, "attachment_storage_missing");
      }

      return new Response(Bun.file(attachmentPath(attachment.storage_key)), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-disposition": `attachment; filename="${attachment.id}.${attachment.file_extension}"`,
          "content-type": attachment.mime_type,
        },
      });
    }, {
      params: t.Object({ attachmentId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/conversations/:conversationId/messages", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (await directConversationIsBlocked(params.conversationId, user.id)) return respondError(set, 403, "blocked_user");
      const attachmentIds = [...new Set([
        ...(body.attachmentIds ?? []),
        ...(body.attachmentId ? [body.attachmentId] : []),
      ])];
      const hasAttachments = attachmentIds.length > 0;
      const channelContext = await conversationChannelAuthorization(params.conversationId, user.id);
      if (channelContext) {
        if (!channelContext.access?.canView) return respondError(set, 403, "channel_not_visible");
        if (channelContext.channel.kind === "voice") return respondError(set, 403, "voice_channel_messages_unsupported");
        const canSendText = hasServerPermission(channelContext.access.authorization, "send_messages");
        if (!canSendText && !hasAttachments) {
          return respondError(set, 403, "insufficient_channel_permissions");
        }
        if (!canSendText && hasAttachments) {
          if (!channelContext.access.canUpload) return respondError(set, 403, "insufficient_channel_permissions");
        }
        if (await isUserTimedOut(channelContext.channel.server_id, user.id)) return respondError(set, 403, "member_timed_out");
      }

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      if (!membership) return respondError(set, 403, "not_a_conversation_member");
      if (await isInstanceUserTimedOut(user.id)) return respondError(set, 403, "instance_user_timed_out");

      if (hasAttachments) {
        const uploadedAttachments = await db<{ id: string }[]>`
          select id from attachments
          where id in ${db(attachmentIds)}
            and conversation_id = ${params.conversationId}
            and uploaded_by = ${user.id}
            and status = 'uploaded'
        `;
        if (uploadedAttachments.length !== attachmentIds.length) return respondError(set, 403, "invalid_attachment");
      }

      const [device] = await db<{ id: string }[]>`
        select id from devices where id = ${body.senderDeviceId} and user_id = ${user.id} and revoked_at is null
      `;
      if (!device) return respondError(set, 403, "invalid_sender_device");

      let ciphertext: Buffer;
      let protocolMetadata: Buffer;
      try {
        ciphertext = decodeBase64(body.ciphertext, "ciphertext", config.maxEncryptedMessageBytes);
        protocolMetadata = body.protocolMetadata
          ? decodeBase64(body.protocolMetadata, "protocolMetadata", config.maxProtocolMetadataBytes, true)
          : Buffer.alloc(0);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_payload");
        throw error;
      }

      const message = await db.begin(async (transaction) => {
        const [created] = await transaction<MessageRow[]>`
          insert into messages (
            conversation_id, sender_device_id, client_message_id, protocol, ciphertext, protocol_metadata
          )
          values (
            ${params.conversationId}, ${body.senderDeviceId}, ${body.clientMessageId},
            ${body.protocol}, ${ciphertext}, ${protocolMetadata}
          )
          on conflict (sender_device_id, client_message_id) do nothing
          returning id, conversation_id, sender_device_id, client_message_id,
            server_sequence, protocol, ciphertext, protocol_metadata, created_at
        `;
        return created;
      });

      let deduplicated = false;
      let storedMessage = message;
      if (!storedMessage) {
        const [existing] = await db<MessageRow[]>`
          select m.id, m.conversation_id, m.sender_device_id, m.client_message_id,
            m.server_sequence, m.protocol, m.ciphertext, m.protocol_metadata, m.created_at,
            u.id as sender_user_id
          from messages m
          join devices d on d.id = m.sender_device_id
          join users u on u.id = d.user_id
          where m.sender_device_id = ${body.senderDeviceId} and m.client_message_id = ${body.clientMessageId}
        `;
        if (!existing) throw new Error("message insert did not return a row");
        if (
          existing.conversation_id !== params.conversationId ||
          existing.protocol !== body.protocol ||
          Buffer.compare(existing.ciphertext, ciphertext) !== 0 ||
          Buffer.compare(existing.protocol_metadata, protocolMetadata) !== 0
        ) {
          return respondError(set, 409, "message_id_reused");
        }
        deduplicated = true;
        storedMessage = existing;
      }

      if (!storedMessage.sender_user_id) storedMessage.sender_user_id = user.id;

      if (!deduplicated) {
        const recipients = await db<{ user_id: string }[]>`
          select user_id
          from conversation_members
          where conversation_id = ${params.conversationId}
            and user_id <> ${user.id}
            and left_at is null
        `;
        await publishMessageCreated(params.conversationId, {
          type: "message.created",
          messageId: storedMessage.id,
          conversationId: storedMessage.conversation_id,
          serverSequence: String(storedMessage.server_sequence),
        }, recipients.map((recipient) => recipient.user_id));
        void sendGenericFcmPush(recipients.map((recipient) => recipient.user_id));
      }

      set.status = deduplicated ? 200 : 201;
      return { message: toMessage(storedMessage), deduplicated };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
      body: t.Object({
        senderDeviceId: t.String({ format: "uuid" }),
        clientMessageId: t.String({ format: "uuid" }),
        protocol: t.String({ minLength: 1, maxLength: 32, pattern: "^[a-z0-9._-]+$" }),
        ciphertext: t.String({ minLength: 1, maxLength: 6_000_000 }),
        protocolMetadata: t.Optional(t.String({ maxLength: 350_000 })),
        attachmentId: t.Optional(t.String({ format: "uuid" })),
        attachmentIds: t.Optional(t.Array(t.String({ format: "uuid" }), { minItems: 1, maxItems: 20 })),
      }),
    })
    .get("/v1/conversations/:conversationId/messages", async ({ headers, params, query, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (await directConversationIsBlocked(params.conversationId, user.id)) return respondError(set, 403, "blocked_user");
      const channelContext = await conversationChannelAuthorization(params.conversationId, user.id);
      if (channelContext && !channelContext.access?.canView) return respondError(set, 403, "channel_not_visible");
      if (channelContext?.channel.kind === "voice") return respondError(set, 403, "voice_channel_messages_unsupported");

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      if (!membership) return respondError(set, 403, "not_a_conversation_member");

      const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
      const before = query.before ? BigInt(query.before) : undefined;
      const after = query.after ? BigInt(query.after) : undefined;
      if (before !== undefined && after !== undefined) return respondError(set, 400, "one_message_cursor_only");

      if (after !== undefined) {
        const rows = await db<MessageRow[]>`
          select m.id, m.conversation_id, m.sender_device_id, m.client_message_id,
            m.server_sequence, m.protocol, m.ciphertext, m.protocol_metadata, m.created_at,
            u.id as sender_user_id
          from messages m
          join devices d on d.id = m.sender_device_id
          join users u on u.id = d.user_id
          where m.conversation_id = ${params.conversationId} and m.server_sequence > ${after}
          order by m.server_sequence asc
          limit ${limit + 1}
        `;
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        return {
          messages: page.map(toMessage),
          nextBefore: null,
          nextAfter: hasMore ? String(page[page.length - 1]?.server_sequence) : null,
        };
      }

      const rows = before === undefined
        ? await db<MessageRow[]>`
          select m.id, m.conversation_id, m.sender_device_id, m.client_message_id,
            m.server_sequence, m.protocol, m.ciphertext, m.protocol_metadata, m.created_at,
            u.id as sender_user_id
          from messages m
          join devices d on d.id = m.sender_device_id
          join users u on u.id = d.user_id
          where m.conversation_id = ${params.conversationId}
          order by m.server_sequence desc
          limit ${limit + 1}
        `
        : await db<MessageRow[]>`
          select m.id, m.conversation_id, m.sender_device_id, m.client_message_id,
            m.server_sequence, m.protocol, m.ciphertext, m.protocol_metadata, m.created_at,
            u.id as sender_user_id
          from messages m
          join devices d on d.id = m.sender_device_id
          join users u on u.id = d.user_id
          where m.conversation_id = ${params.conversationId} and m.server_sequence < ${before}
          order by m.server_sequence desc
          limit ${limit + 1}
        `;

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit).reverse();
      return {
        messages: page.map(toMessage),
        nextBefore: hasMore ? String(page[0]?.server_sequence) : null,
        nextAfter: null,
      };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
      query: t.Object({
        before: t.Optional(t.String({ pattern: "^[0-9]+$" })),
        after: t.Optional(t.String({ pattern: "^[0-9]+$" })),
        limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })),
      }),
    })
    .delete("/v1/conversations/:conversationId/messages/:messageId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const channelContext = await conversationChannelAuthorization(params.conversationId, user.id);
      if (!channelContext?.access?.canView) return respondError(set, 403, "channel_not_visible");
      if (!hasAnyServerPermission(channelContext.access.authorization, "delete_messages", "delete_others_messages")) {
        return respondError(set, 403, "insufficient_server_permissions");
      }
      const [message] = await db<{ id: string }[]>`
        select id from messages
        where id = ${params.messageId} and conversation_id = ${params.conversationId}
      `;
      if (!message) return respondError(set, 404, "message_not_found");
      const recipients = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id <> ${user.id} and left_at is null
      `;
      await db`delete from messages where id = ${message.id}`;
      await publishMessageCreated(params.conversationId, {
        type: "message.deleted",
        messageId: message.id,
        conversationId: params.conversationId,
      }, recipients.map((recipient) => recipient.user_id));
      return { deleted: true };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }), messageId: t.String({ format: "uuid" }) }),
    })
    .ws("/v1/realtime", {
      body: realtimeCommand,
      open: async (ws) => {
        const data = ws.data as { headers?: Record<string, string | undefined> };
        const user = await authenticate(data.headers?.authorization, data.headers?.cookie);
        if (!user) {
          ws.close(4001, "unauthorized");
          return;
        }
        let connection: RealtimeConnection | undefined;
        let operationsMember: string | undefined;
        try {
          connection = await createRealtimeConnection(ws, user.id);
          operationsMember = await registerLiveConnection(user.id);
          realtimeConnections.set(ws.raw, {
            userId: user.id,
            connection,
            close: () => ws.close(4003, "account_suspended"),
            operationsMember,
          });
          ensureLiveConnectionRefresh();
          ws.send(JSON.stringify({ type: "ready" }));
        } catch {
          if (operationsMember) await removeLiveConnection(operationsMember).catch(() => undefined);
          realtimeConnections.delete(ws.raw);
          if (connection) await connection.close().catch(() => undefined);
          stopLiveConnectionRefreshIfIdle();
          ws.close(1013, "realtime_unavailable");
        }
      },
      message: async (ws, command) => {
        const active = realtimeConnections.get(ws.raw);
        if (!active) {
          ws.close(4001, "unauthorized");
          return;
        }
        const connection = active.connection;

        if (command.type === "subscribe") {
          const subscribed = await connection.subscribe(command.conversationId);
          if (!subscribed) {
            ws.send(JSON.stringify({ type: "error", error: "not_a_conversation_member" }));
          }
          return;
        }

        if (command.type === "unsubscribe") {
          await connection.unsubscribe(command.conversationId);
          return;
        }

        if (command.type === "typing") {
          const published = await connection.publish(command.conversationId, {
            type: "typing",
            conversationId: command.conversationId,
            isTyping: command.isTyping,
          });
          if (!published) ws.send(JSON.stringify({ type: "error", error: "not_a_conversation_member" }));
          return;
        }

        if (command.type === "presence") {
          const published = await connection.publish(command.conversationId, {
            type: "presence",
            conversationId: command.conversationId,
            state: command.state,
          });
          if (!published) ws.send(JSON.stringify({ type: "error", error: "not_a_conversation_member" }));
          return;
        }

        if (command.type === "voice.signal") {
          const accessError = await voiceSignalAccessError(command.conversationId, active.userId);
          if (accessError) {
            ws.send(JSON.stringify({ type: "error", error: accessError, conversationId: command.conversationId }));
            return;
          }
          const published = await connection.publish(command.conversationId, {
            type: "voice.signal",
            conversationId: command.conversationId,
            ciphertext: command.ciphertext,
          });
          if (!published) ws.send(JSON.stringify({ type: "error", error: "voice_signal_rejected", conversationId: command.conversationId }));
          return;
        }

        ws.close(1003, "unsupported_realtime_command");
      },
      close: async (ws) => {
        const active = realtimeConnections.get(ws.raw);
        realtimeConnections.delete(ws.raw);
        if (active) {
          await removeLiveConnection(active.operationsMember).catch(() => undefined);
          await active.connection.close();
        }
        stopLiveConnectionRefreshIfIdle();
      },
    });
}
