import { expect, mock, test } from "bun:test";
import { claimVoiceRoomDevice, VoiceRoomDeviceConflict, voiceRoomIdentity } from "./voice-room-device";

test("the same account has one opaque UUID identity per voice room", () => {
  const identity = voiceRoomIdentity("room", "user", "secret");
  expect(identity).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(voiceRoomIdentity("room", "user", "secret")).toBe(identity);
  expect(voiceRoomIdentity("other-room", "user", "secret")).not.toBe(identity);
  expect(voiceRoomIdentity("room", "other-user", "secret")).not.toBe(identity);
  expect(voiceRoomIdentity("room", "user", "other-secret")).not.toBe(identity);
});

test("an existing participant requires explicit transfer confirmation", async () => {
  const reserve = mock(async () => true);
  await expect(claimVoiceRoomDevice("identity", "device", false, [{ identity: "identity" }], reserve)).rejects.toBeInstanceOf(VoiceRoomDeviceConflict);
  expect(reserve).not.toHaveBeenCalled();
  await claimVoiceRoomDevice("identity", "device", true, [{ identity: "identity" }], reserve);
  expect(reserve).toHaveBeenCalledWith("identity", "device", true);
});

test("other accounts do not prevent joining", async () => {
  const reserve = mock(async () => true);
  await claimVoiceRoomDevice("identity", "device", false, [{ identity: "other" }], reserve);
  expect(reserve).toHaveBeenCalledWith("identity", "device", false);
});

test("a simultaneous pending join also requires confirmation", async () => {
  await expect(claimVoiceRoomDevice("identity", "device", false, [], async () => false)).rejects.toBeInstanceOf(VoiceRoomDeviceConflict);
});

test("reservation failures fail closed rather than minting a duplicate token", async () => {
  await expect(claimVoiceRoomDevice("identity", "device", true, [], async () => { throw new Error("redis unavailable"); })).rejects.toThrow("redis unavailable");
});
