import { expect, test } from "bun:test";
import { normalizeVoiceAudioPreferences, voiceGateOpen, voicePlaybackSettings } from "./voice-audio-preferences";

const userId = "11111111-1111-4111-8111-111111111111";

test("audio preferences default to ungated activity and normal volume", () => {
  const preferences = normalizeVoiceAudioPreferences(undefined);
  expect(preferences.mode).toBe("activity");
  expect(preferences.silenceThreshold).toBe(-100);
  expect(voiceGateOpen(-100, preferences, false)).toBe(true);
  expect(voicePlaybackSettings(preferences, false)).toEqual({ muted: false, volume: 1 });
});

test("audio preferences validate shortcuts, devices, and volume limits", () => {
  const preferences = normalizeVoiceAudioPreferences({ mode: "bad", pushToTalkKey: "Enter", inputVolume: 999, outputVolume: -1, silenceThreshold: NaN, inputDeviceId: {}, outputDeviceId: "x".repeat(600) });
  expect(preferences).toMatchObject({ mode: "activity", pushToTalkKey: "Space", inputVolume: 200, outputVolume: 0, silenceThreshold: -100, inputDeviceId: "", outputDeviceId: "" });
  expect(normalizeVoiceAudioPreferences({ inputVolume: Infinity }).inputVolume).toBe(100);
});

test("per-user audio stores only UUID-keyed local playback choices", () => {
  const preferences = normalizeVoiceAudioPreferences({ users: { [userId]: { muted: true, volume: 40, name: "private name" }, arbitrary: { muted: true } }, name: "private" });
  expect(preferences.users).toEqual({ [userId]: { muted: true, volume: 40 } });
  expect("name" in preferences).toBe(false);
});

test("per-user volume composes with output volume, without bypassing deafen", () => {
  const preferences = normalizeVoiceAudioPreferences({ outputVolume: 50, users: { [userId]: { muted: false, volume: 40 } } });
  expect(voicePlaybackSettings(preferences, false, userId)).toEqual({ muted: false, volume: 0.2 });
  expect(voicePlaybackSettings(preferences, true, userId).muted).toBe(true);
  preferences.users[userId].muted = true;
  expect(voicePlaybackSettings(preferences, false, userId).muted).toBe(true);
});

test("push-to-talk remains closed until pressed and does not use activity threshold", () => {
  const preferences = normalizeVoiceAudioPreferences({ mode: "push-to-talk", silenceThreshold: -10 });
  expect(voiceGateOpen(0, preferences, false)).toBe(false);
  expect(voiceGateOpen(-100, preferences, true)).toBe(true);
});

test("silence threshold gates quiet activity", () => {
  const preferences = normalizeVoiceAudioPreferences({ silenceThreshold: -40 });
  expect(voiceGateOpen(-41, preferences, false)).toBe(false);
  expect(voiceGateOpen(-40, preferences, false)).toBe(true);
  expect(voiceGateOpen(-30, preferences, false)).toBe(true);
});
