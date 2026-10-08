/**
 * Per-channel visibility.
 *
 * Channel access is derived from a member's roles plus the per-role channel and category grants.
 * `canUpload` is always gated on `canView`, so a member cannot upload into a channel they cannot
 * read.
 */

import { db } from "../db/client";
import { hasServerPermission, serverAuthorization, type ServerAuthorization } from "./permissions";

export type ChannelAccess = {
  authorization: ServerAuthorization;
  canView: boolean;
  canUpload: boolean;
};

export async function channelAuthorization(
  serverId: string,
  userId: string,
  channelId: string,
): Promise<ChannelAccess | undefined> {
  const authorization = await serverAuthorization(serverId, userId);
  if (!authorization) return undefined;
  const [channel] = await db<{ id: string; category_id: string | null }[]>`
    select id, category_id from channels
    where id = ${channelId} and server_id = ${serverId} and archived_at is null
  `;
  if (!channel) return undefined;
  if (authorization.isOwner) return { authorization, canView: true, canUpload: true };
  // A member with no explicit role row predates the role system and follows the space-wide default.
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
              select 1
              from server_role_channel_access src
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
  return {
    authorization,
    canView: Boolean(access?.can_view),
    canUpload: Boolean(access?.can_upload && access?.can_view),
  };
}

/**
 * Resolves a conversation back to its channel, when it has one.
 *
 * Direct and group conversations have no channel, so `access` is `undefined` for them and callers
 * fall back to membership alone.
 */
export async function conversationChannelAuthorization(conversationId: string, userId: string) {
  const [channel] = await db<{ id: string; server_id: string; kind: string; archived_at: Date | null }[]>`
    select id, server_id, kind, archived_at from channels
    where conversation_id = ${conversationId}
  `;
  if (!channel) return undefined;
  const access = channel.archived_at
    ? undefined
    : await channelAuthorization(channel.server_id, userId, channel.id);
  return { channel, access };
}

/**
 * The oldest live channel in a space, which every member joins regardless of role grants.
 * It is the anchor for membership sync and cannot be deleted.
 */
export async function isMetadataChannel(serverId: string, channelId: string) {
  const [anchor] = await db<{ id: string }[]>`
    select id from channels
    where server_id = ${serverId} and archived_at is null
    order by created_at asc, id asc
    limit 1
  `;
  return anchor?.id === channelId;
}

/** The channels a member may see, each with whether they may upload or send there. */
export async function visibleServerChannels(serverId: string, userId: string) {
  const rows = await db<{
    id: string;
    server_id: string;
    conversation_id: string;
    encrypted_metadata: Buffer;
    category_id: string | null;
    kind: string;
    position: number;
    nsfw: boolean;
    spoiler: boolean;
    created_at: Date;
  }[]>`
    select id, server_id, conversation_id, encrypted_metadata, category_id, kind, position, nsfw, spoiler, created_at
    from channels
    where server_id = ${serverId} and archived_at is null
    order by position asc, created_at asc
  `;
  const visible = [];
  for (const channel of rows) {
    const access = await channelAuthorization(serverId, userId, channel.id);
    if (access?.canView) {
      visible.push({
        channel,
        canUpload: access.canUpload,
        canSend: hasServerPermission(access.authorization, "send_messages"),
      });
    }
  }
  return visible;
}
