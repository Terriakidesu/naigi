import { expect, test } from "bun:test";
import { parseVoiceRoomResume, voiceRoomResumeDelay } from "./voice-room-resume";

const intent = {
  serverId: "11111111-1111-4111-8111-111111111111",
  channelId: "22222222-2222-4222-8222-222222222222",
  muted: true,
  deafened: false,
};

test("voice room resume retains only opaque room IDs and local audio choices", () => {
  expect(parseVoiceRoomResume(JSON.stringify({ ...intent, name: "private", mediaKey: "secret" }))).toEqual(intent);
});

test("voice room resume rejects invalid stored intent", () => {
  for (const value of [null, "bad json", "null", "{}", JSON.stringify({ ...intent, channelId: "bad" }), JSON.stringify({ ...intent, muted: "false" })]) {
    expect(parseVoiceRoomResume(value)).toBeUndefined();
  }
});

test("voice room recovery backs off with a bounded delay", () => {
  expect([0, 1, 2, 3, 4, 20].map(voiceRoomResumeDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
});
