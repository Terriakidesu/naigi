import { RoomEvent, type Participant, type Room } from "livekit-client";

export function assertVoiceSecureContext() {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    throw new Error("voice_secure_context_required");
  }
}

export function waitForLocalVoiceEncryption(room: Room, timeoutMs = 5_000) {
  if (room.isE2EEEnabled) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      room.off(RoomEvent.ParticipantEncryptionStatusChanged, onStatusChanged);
      room.off(RoomEvent.EncryptionError, onEncryptionError);
    };
    const onStatusChanged = (enabled: boolean, participant?: Participant) => {
      if (!enabled || participant !== room.localParticipant) return;
      cleanup();
      resolve();
    };
    const onEncryptionError = (_error: Error, participant?: Participant) => {
      if (participant && participant !== room.localParticipant) return;
      cleanup();
      reject(new Error("voice_media_encryption_unavailable"));
    };

    room.on(RoomEvent.ParticipantEncryptionStatusChanged, onStatusChanged);
    room.on(RoomEvent.EncryptionError, onEncryptionError);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("voice_media_encryption_unavailable"));
    }, timeoutMs);

    // The worker can acknowledge encryption between connection completion and
    // listener registration, so re-check after subscribing to the events.
    if (room.isE2EEEnabled) {
      cleanup();
      resolve();
    }
  });
}
