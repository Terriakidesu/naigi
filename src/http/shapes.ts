/**
 * Presentation shapes for rows that leave the API.
 *
 * These are the only places a database column is renamed for a response, so a client contract
 * change has one home. Encrypted fields are passed through as base64 and never decrypted.
 */

import { encodeBase64 } from "../encoding";
import { profileBannerUrl, profileImageUrl } from "../profile-images";

export type UserRow = {
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

/** Only the fields a client needs; `password_hash` is never included. */
export function toPublicUser(
  user: Pick<UserRow, "id" | "username" | "display_name" | "created_at">
    & Partial<Pick<UserRow, "profile_image_storage_key" | "profile_banner_storage_key">>,
) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    createdAt: user.created_at,
    avatarUrl: profileImageUrl(user.id, user.profile_image_storage_key),
    bannerUrl: profileBannerUrl(user.id, user.profile_banner_storage_key),
  };
}

export type MessageRow = {
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

/**
 * `server_sequence` is a bigint, so it is stringified rather than serialised as a number, which
 * would lose precision past 2^53 and break cursor pagination.
 */
export function toMessage(message: MessageRow) {
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

/** Cache-busting branding URL; the storage key is a UUID, so it changes when the asset does. */
export function serverBrandingUrl(serverId: string, asset: "icon" | "banner", storageKey: string | null | undefined) {
  return storageKey
    ? `/v1/servers/${encodeURIComponent(serverId)}/branding/${asset}?v=${encodeURIComponent(storageKey)}`
    : null;
}
