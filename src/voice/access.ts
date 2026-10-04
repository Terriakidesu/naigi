/**
 * Access checks for voice.
 *
 * Each returns either an error code for the API response or `undefined` when access is allowed, so
 * a route reads as a single guard rather than a chain of conditionals.
 */

import { db } from "../db/client";
import { directConversationIsBlocked } from "../moderation/blocks";
import { channelAuthorization } from "../servers/channel-access";

export type VoiceChannelRow = {
  id: string;
  server_id: string;
  conversation_id: string;
  kind: string;
  archived_at: Date | null;
};

async function accountIsSuspended(userId: string) {
  const [suspension] = await db<{ user_id: string }[]>`
    select user_id from instance_user_suspensions where user_id = ${userId}
  `;
  return Boolean(suspension);
}

/** Access to a one-to-one call. */
export async function directVoiceCallAccessError(conversationId: string, userId: string) {
  if (await accountIsSuspended(userId)) return "account_suspended";
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

/** Access to a joinable space voice room, which additionally requires channel visibility. */
export async function voiceRoomAccessError(channelId: string, userId: string) {
  if (await accountIsSuspended(userId)) return { error: "account_suspended" as const };

  const [channel] = await db<VoiceChannelRow[]>`
    select id, server_id, conversation_id, kind, archived_at
    from channels where id = ${channelId}
  `;
  if (!channel || channel.kind !== "voice" || channel.archived_at) {
    return { error: "voice_room_not_found" as const };
  }

  const access = await channelAuthorization(channel.server_id, userId, channel.id);
  if (!access?.canView) return { error: "not_a_voice_room_member" as const };

  const [conversationMember] = await db<{ user_id: string }[]>`
    select user_id from conversation_members
    where conversation_id = ${channel.conversation_id} and user_id = ${userId} and left_at is null
  `;
  if (!conversationMember) return { error: "not_a_voice_room_member" as const };

  return { channel };
}

/**
 * Access for a realtime signalling message.
 *
 * Dispatches on the conversation's shape: a voice channel's conversation follows the room rules,
 * anything else follows the direct-call rules.
 */
export async function voiceSignalAccessError(conversationId: string, userId: string) {
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
