import { createHmac } from "node:crypto";

export class VoiceRoomDeviceConflict extends Error {}

// Room-scoped opaque UUIDs retain the encrypted roster protocol's UUID contract.
export function voiceRoomIdentity(channelId: string, userId: string, secret: string) {
  const bytes = createHmac("sha256", secret).update(`naigi.voice.room:${channelId}:${userId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function claimVoiceRoomDevice(
  identity: string,
  instanceId: string,
  replaceExisting: boolean,
  participants: Array<{ identity: string }>,
  reserve: (identity: string, instanceId: string, replaceExisting: boolean) => Promise<boolean>,
) {
  if (!replaceExisting && participants.some((participant) => participant.identity === identity)) throw new VoiceRoomDeviceConflict();
  // Reserve pending joins too, so simultaneous devices cannot both join silently.
  if (!await reserve(identity, instanceId, replaceExisting)) throw new VoiceRoomDeviceConflict();
}
