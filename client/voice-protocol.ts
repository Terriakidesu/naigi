export type VoiceSignalBody = {
  version: 1;
  kind: "naigi.voice.call";
  senderInstanceId: string;
  action: "invite" | "accept" | "decline" | "end";
  callId: string;
  mediaKey?: string;
  expiresAt?: number;
};

function validCallId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validMediaKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function parseVoiceCallSignal(value: unknown, now = Date.now()): VoiceSignalBody | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const signal = value as Record<string, unknown>;
  if (signal.version !== 1 || signal.kind !== "naigi.voice.call" || !validCallId(signal.callId) || !validCallId(signal.senderInstanceId)) return undefined;
  if (signal.action === "invite") {
    if (!validMediaKey(signal.mediaKey) || typeof signal.expiresAt !== "number") return undefined;
    if (!Number.isSafeInteger(signal.expiresAt) || signal.expiresAt < now || signal.expiresAt > now + 90_000) return undefined;
    return {
      version: 1,
      kind: "naigi.voice.call",
      senderInstanceId: signal.senderInstanceId,
      action: "invite",
      callId: signal.callId,
      mediaKey: signal.mediaKey,
      expiresAt: signal.expiresAt,
    };
  }
  if (signal.action === "accept" || signal.action === "decline" || signal.action === "end") {
    return {
      version: 1,
      kind: "naigi.voice.call",
      senderInstanceId: signal.senderInstanceId,
      action: signal.action,
      callId: signal.callId,
    };
  }
  return undefined;
}
