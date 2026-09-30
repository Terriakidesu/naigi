export type VoiceRoomResume = {
  serverId: string;
  channelId: string;
  muted: boolean;
  deafened: boolean;
};

export function parseVoiceRoomResume(value: string | null): VoiceRoomResume | undefined {
  if (!value) return;
  try {
    const parsed = JSON.parse(value);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!parsed || typeof parsed.serverId !== "string" || typeof parsed.channelId !== "string"
      || !uuid.test(parsed.serverId) || !uuid.test(parsed.channelId)
      || typeof parsed.muted !== "boolean" || typeof parsed.deafened !== "boolean") return;
    // Never retain names, media keys, or arbitrary stored properties.
    return { serverId: parsed.serverId, channelId: parsed.channelId, muted: parsed.muted, deafened: parsed.deafened };
  } catch {
    return;
  }
}

export function voiceRoomResumeDelay(attempt: number) {
  return Math.min(30_000, 2_000 * 2 ** Math.min(Math.max(attempt, 0), 4));
}
