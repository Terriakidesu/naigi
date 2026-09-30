export type VoiceRoomSignalBody = {
  version: 1;
  kind: "naigi.voice.room";
  senderInstanceId: string;
  channelId: string;
  action: "join-request" | "room-open" | "room-key" | "participant-presence" | "participant-left" | "roster-request";
  requestId?: string;
  sessionId?: string;
  mediaKey?: string;
  participantIdentity?: string;
  expiresAt: number;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isMediaKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validExpiry(value: unknown, now: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= now && value <= now + 90_000;
}

export function parseVoiceRoomSignal(value: unknown, now = Date.now()): VoiceRoomSignalBody | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const signal = value as Record<string, unknown>;
  if (signal.version !== 1 || signal.kind !== "naigi.voice.room") return undefined;
  if (!isUuid(signal.senderInstanceId) || !isUuid(signal.channelId) || !validExpiry(signal.expiresAt, now)) return undefined;

  if (signal.action === "join-request" && isUuid(signal.requestId)) {
    return {
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId: signal.senderInstanceId,
      channelId: signal.channelId,
      action: "join-request",
      requestId: signal.requestId,
      expiresAt: signal.expiresAt as number,
    };
  }

  if (signal.action === "room-open" && isUuid(signal.sessionId) && isMediaKey(signal.mediaKey)) {
    return {
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId: signal.senderInstanceId,
      channelId: signal.channelId,
      action: "room-open",
      sessionId: signal.sessionId,
      mediaKey: signal.mediaKey,
      expiresAt: signal.expiresAt as number,
    };
  }

  if (signal.action === "room-key" && isUuid(signal.requestId) && isUuid(signal.sessionId) && isMediaKey(signal.mediaKey)) {
    return {
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId: signal.senderInstanceId,
      channelId: signal.channelId,
      action: "room-key",
      requestId: signal.requestId,
      sessionId: signal.sessionId,
      mediaKey: signal.mediaKey,
      expiresAt: signal.expiresAt as number,
    };
  }

  if (signal.action === "roster-request") {
    return {
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId: signal.senderInstanceId,
      channelId: signal.channelId,
      action: "roster-request",
      expiresAt: signal.expiresAt as number,
    };
  }

  if ((signal.action === "participant-presence" || signal.action === "participant-left") && isUuid(signal.participantIdentity)) {
    return {
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId: signal.senderInstanceId,
      channelId: signal.channelId,
      action: signal.action,
      participantIdentity: signal.participantIdentity,
      expiresAt: signal.expiresAt as number,
    };
  }

  return undefined;
}
