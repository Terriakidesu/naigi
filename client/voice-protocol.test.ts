import { expect, test } from "bun:test";
import { parseVoiceCallSignal } from "./voice-protocol";

const now = Date.parse("2026-09-30T12:00:00.000Z");
const callId = "340a0b0f-f205-419e-9d2c-f5c38f6dc779";
const senderInstanceId = "ecac4aa5-e9e2-48af-94e7-70317d7cc7a4";
const mediaKey = "A".repeat(43);

test("voice invites require a valid key and short future expiration", () => {
  expect(parseVoiceCallSignal({
    version: 1,
    kind: "naigi.voice.call",
    senderInstanceId,
    action: "invite",
    callId,
    mediaKey,
    expiresAt: now + 60_000,
  }, now)).toMatchObject({ action: "invite", callId, mediaKey });

  expect(parseVoiceCallSignal({
    version: 1,
    kind: "naigi.voice.call",
    senderInstanceId,
    action: "invite",
    callId,
    mediaKey,
    expiresAt: now - 1,
  }, now)).toBeUndefined();
  expect(parseVoiceCallSignal({
    version: 1,
    kind: "naigi.voice.call",
    senderInstanceId,
    action: "invite",
    callId,
    mediaKey,
    expiresAt: now + 90_001,
  }, now)).toBeUndefined();
  expect(parseVoiceCallSignal({
    version: 1,
    kind: "naigi.voice.call",
    senderInstanceId,
    action: "invite",
    callId,
    mediaKey: "short",
    expiresAt: now + 10_000,
  }, now)).toBeUndefined();
});

test("voice call controls accept only known actions and UUIDv4 identifiers", () => {
  expect(parseVoiceCallSignal({ version: 1, kind: "naigi.voice.call", senderInstanceId, action: "accept", callId }, now))
    .toMatchObject({ action: "accept", callId, senderInstanceId });
  expect(parseVoiceCallSignal({ version: 1, kind: "naigi.voice.call", senderInstanceId, action: "decline", callId }, now))
    .toMatchObject({ action: "decline" });
  expect(parseVoiceCallSignal({ version: 1, kind: "naigi.voice.call", senderInstanceId, action: "end", callId }, now))
    .toMatchObject({ action: "end" });
  expect(parseVoiceCallSignal({ version: 2, kind: "naigi.voice.call", senderInstanceId, action: "end", callId }, now)).toBeUndefined();
  expect(parseVoiceCallSignal({ version: 1, kind: "naigi.voice.call", senderInstanceId, action: "answer", callId }, now)).toBeUndefined();
  expect(parseVoiceCallSignal({ version: 1, kind: "naigi.voice.call", senderInstanceId, action: "end", callId: "not-a-uuid" }, now)).toBeUndefined();
  expect(parseVoiceCallSignal({ version: 1, kind: "naigi.voice.call", senderInstanceId: callId, action: "end", callId }, now)).toBeDefined();
  expect(parseVoiceCallSignal({ version: 1, kind: "naigi.voice.call", senderInstanceId: "not-a-uuid", action: "end", callId }, now)).toBeUndefined();
});
