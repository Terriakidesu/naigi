import { describe, expect, it } from "bun:test";
import { RoomEvent, type Room } from "livekit-client";
import { waitForLocalVoiceEncryption } from "./voice-e2ee";

class FakeRoom {
  isE2EEEnabled = false;
  localParticipant = {};
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

describe("voice media encryption readiness", () => {
  it("returns immediately when local encryption is already enabled", async () => {
    const room = new FakeRoom();
    room.isE2EEEnabled = true;
    await expect(waitForLocalVoiceEncryption(room as unknown as Room)).resolves.toBeUndefined();
  });

  it("waits for the local participant's encryption status", async () => {
    const room = new FakeRoom();
    const ready = waitForLocalVoiceEncryption(room as unknown as Room, 100);
    room.emit(RoomEvent.ParticipantEncryptionStatusChanged, true, room.localParticipant);
    await expect(ready).resolves.toBeUndefined();
  });

  it("rejects encryption errors and ignores remote participant status", async () => {
    const room = new FakeRoom();
    const ready = waitForLocalVoiceEncryption(room as unknown as Room, 10);
    room.emit(RoomEvent.ParticipantEncryptionStatusChanged, true, {});
    await expect(ready).rejects.toThrow("voice_media_encryption_unavailable");

    const failingRoom = new FakeRoom();
    const failed = waitForLocalVoiceEncryption(failingRoom as unknown as Room, 100);
    failingRoom.emit(RoomEvent.EncryptionError, new Error("worker failed"), failingRoom.localParticipant);
    await expect(failed).rejects.toThrow("voice_media_encryption_unavailable");
  });
});
