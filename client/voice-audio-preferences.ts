export type VoiceUserAudio = { muted: boolean; volume: number };
export type VoiceAudioPreferences = {
  mode: "activity" | "push-to-talk";
  pushToTalkKey: string;
  inputVolume: number;
  outputVolume: number;
  silenceThreshold: number;
  inputDeviceId: string;
  outputDeviceId: string;
  users: Record<string, VoiceUserAudio>;
};

export const defaultVoiceAudioPreferences: VoiceAudioPreferences = {
  mode: "activity", pushToTalkKey: "Space", inputVolume: 100, outputVolume: 100,
  silenceThreshold: -100, inputDeviceId: "", outputDeviceId: "", users: {},
};
export const voiceAudioStorageKey = (userId: string) => `priv-chat.voice-audio.${userId}`;

function bounded(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function normalizeVoiceAudioPreferences(value: unknown): VoiceAudioPreferences {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const users: Record<string, VoiceUserAudio> = {};
  if (input.users && typeof input.users === "object" && !Array.isArray(input.users)) {
    for (const [id, settings] of Object.entries(input.users).slice(0, 2_000)) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !settings || typeof settings !== "object") continue;
      const user = settings as Record<string, unknown>;
      users[id] = { muted: user.muted === true, volume: bounded(user.volume, 100, 0, 100) };
    }
  }
  const deviceId = (value: unknown) => typeof value === "string" && value.length <= 512 ? value : "";
  return {
    mode: input.mode === "push-to-talk" ? "push-to-talk" : "activity",
    pushToTalkKey: typeof input.pushToTalkKey === "string" && /^(Space|Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2]))$/.test(input.pushToTalkKey) ? input.pushToTalkKey : "Space",
    inputVolume: bounded(input.inputVolume, 100, 0, 200),
    outputVolume: bounded(input.outputVolume, 100, 0, 100),
    silenceThreshold: bounded(input.silenceThreshold, -100, -100, -10),
    inputDeviceId: deviceId(input.inputDeviceId), outputDeviceId: deviceId(input.outputDeviceId), users,
  };
}

export function loadVoiceAudioPreferences(userId: string): VoiceAudioPreferences {
  try { return normalizeVoiceAudioPreferences(JSON.parse(localStorage.getItem(voiceAudioStorageKey(userId)) ?? "null")); }
  catch { return normalizeVoiceAudioPreferences(undefined); }
}

export function saveVoiceAudioPreferences(userId: string, preferences: VoiceAudioPreferences) {
  const normalized = normalizeVoiceAudioPreferences(preferences);
  try { localStorage.setItem(voiceAudioStorageKey(userId), JSON.stringify(normalized)); }
  catch { /* Preferences still apply in memory if browser storage is unavailable. */ }
  return normalized;
}

export function voicePlaybackSettings(preferences: VoiceAudioPreferences, deafened: boolean, userId?: string) {
  const user = userId ? preferences.users[userId] : undefined;
  return { muted: deafened || Boolean(user?.muted), volume: preferences.outputVolume / 100 * (user?.volume ?? 100) / 100 };
}

export function voiceGateOpen(levelDb: number, preferences: Pick<VoiceAudioPreferences, "mode" | "silenceThreshold">, pressed: boolean) {
  return preferences.mode === "push-to-talk" ? pressed : preferences.silenceThreshold <= -100 || levelDb >= preferences.silenceThreshold;
}
