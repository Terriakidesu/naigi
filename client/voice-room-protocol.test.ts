import { describe, expect, it } from "bun:test";
import { parseVoiceRoomSignal } from "./voice-room-protocol";

const channelId = "a4c3d342-62ad-4c04-8e09-41a6935ed5e6";
const senderInstanceId = "529a4e83-3fbd-43b1-87f8-5ce61a8d592f";
const requestId = "90d9922c-eb1f-4503-8590-f05182d949c2";
const sessionId = "48b0d4dd-a2f2-4545-817d-96b87e97c295";
const mediaKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const participantIdentity = "72d55ee8-4283-491d-bb8c-8b977ddac43f";

describe("voice-room signaling", () => {
  it("accepts an unexpired join request", () => {
    expect(parseVoiceRoomSignal({
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId,
      channelId,
      action: "join-request",
      requestId,
      expiresAt: 60_000,
    }, 10_000)?.action).toBe("join-request");
  });

  it("accepts room keys only with valid session and media keys", () => {
    expect(parseVoiceRoomSignal({
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId,
      channelId,
      action: "room-open",
      sessionId,
      mediaKey,
      expiresAt: 60_000,
    }, 10_000)?.mediaKey).toBe(mediaKey);
    expect(parseVoiceRoomSignal({
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId,
      channelId,
      action: "room-key",
      requestId,
      sessionId,
      mediaKey,
      expiresAt: 60_000,
    }, 10_000)?.action).toBe("room-key");
  });

  it("accepts participant identities only inside valid encrypted presence signals", () => {
    expect(parseVoiceRoomSignal({
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId,
      channelId,
      action: "participant-presence",
      participantIdentity,
      expiresAt: 60_000,
    }, 10_000)?.participantIdentity).toBe(participantIdentity);
    expect(parseVoiceRoomSignal({
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId,
      channelId,
      action: "participant-presence",
      participantIdentity: "not-a-uuid",
      expiresAt: 60_000,
    }, 10_000)).toBeUndefined();
  });

  it("accepts encrypted roster requests and participant departures", () => {
    expect(parseVoiceRoomSignal({
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId,
      channelId,
      action: "roster-request",
      expiresAt: 60_000,
    }, 10_000)?.action).toBe("roster-request");
    expect(parseVoiceRoomSignal({
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId,
      channelId,
      action: "participant-left",
      participantIdentity,
      expiresAt: 60_000,
    }, 10_000)?.action).toBe("participant-left");
  });

  it("rejects malformed, unknown, and expired room signals", () => {
    const signal = {
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId,
      channelId,
      action: "room-open",
      sessionId,
      mediaKey,
      expiresAt: 10_000,
    };
    expect(parseVoiceRoomSignal(signal, 10_001)).toBeUndefined();
    expect(parseVoiceRoomSignal({ ...signal, mediaKey: "bad" }, 1)).toBeUndefined();
    expect(parseVoiceRoomSignal({ ...signal, action: "leave" }, 1)).toBeUndefined();
  });
});
