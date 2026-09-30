import { DisconnectReason, ExternalE2EEKeyProvider, Room, RoomEvent, Track, TrackEvent } from "livekit-client";
import { parseVoiceRoomSignal, type VoiceRoomSignalBody } from "./voice-room-protocol";
import { assertVoiceSecureContext, waitForLocalVoiceEncryption } from "./voice-e2ee";
import { VoiceAudioProcessor, setProcessedMicrophone } from "./voice-audio-processor";
import { defaultVoiceAudioPreferences, voicePlaybackSettings, type VoiceAudioPreferences } from "./voice-audio-preferences";

export type VoiceRoomView = {
  status: "idle" | "joining" | "connecting" | "connected" | "reconnecting";
  channelId?: string;
  conversationId?: string;
  roomName?: string;
  participantCount?: number;
  muted?: boolean;
  deafened?: boolean;
  participants?: VoiceRoomParticipantView[];
  microphonePublished?: boolean;
  remoteAudioCount?: number;
  audioPlaybackBlocked?: boolean;
  audioIssue?: "microphone" | "subscription" | "encryption" | "playback";
};

export type VoiceRoomParticipantView = { identity: string; userId?: string; local: boolean; speaking?: boolean; muted?: boolean };

type RoomTicket = { url: string; token: string; canStart: boolean };
type RoomKey = { sessionId: string; mediaKey: string };

type ActiveRoom = {
  conversationId: string;
  channelId: string;
  roomName: string;
  sessionId?: string;
  mediaKey?: string;
  room?: Room;
  worker?: Worker;
  audioProcessor?: VoiceAudioProcessor;
  muted: boolean;
  deafened: boolean;
  participantUserIds: Map<string, string>;
  microphonePublished: boolean;
  remoteAudioTrackSids: Set<string>;
  speakingIdentities: Set<string>;
  presenceTimer?: number;
  audioPlaybackAllowed?: boolean;
  audioIssue?: "microphone" | "subscription" | "encryption" | "playback";
  accessTimer?: number;
  accessCheckInFlight: boolean;
  accessFailures: number;
  cleaningUp: boolean;
};

type PendingKeyRequest = {
  conversationId: string;
  channelId: string;
  requestId: string;
  resolve: (key: RoomKey | undefined) => void;
  timer?: number;
};

type KnownParticipant = { identity: string; userId: string; expiresAt: number };

type VoiceRoomOptions = {
  currentUserId: string;
  requestToken: (channelId: string) => Promise<RoomTicket>;
  checkAccess: (channelId: string) => Promise<boolean>;
  encryptSignal: (conversationId: string, value: VoiceRoomSignalBody) => Promise<string>;
  decryptSignal: (conversationId: string, ciphertext: string) => Promise<Record<string, unknown>>;
  sendSignal: (conversationId: string, ciphertext: string) => boolean;
  onState: (state: VoiceRoomView) => void;
  onAccessRevoked?: () => void;
  audioOutput: HTMLElement;
  getAudioInputDeviceId: () => string;
  getAudioOutputDeviceId: () => string;
  getInitialMuted?: () => boolean;
  getInitialDeafened?: () => boolean;
  getAudioPreferences?: () => VoiceAudioPreferences;
};

function randomMediaKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class VoiceRoomController {
  private readonly options: VoiceRoomOptions;
  private readonly instanceId = crypto.randomUUID();
  private active?: ActiveRoom;
  private pendingKeyRequest?: PendingKeyRequest;
  private readonly knownParticipants = new Map<string, Map<string, KnownParticipant>>();
  private readonly rosterRequests = new Map<string, number>();
  private rosterExpiryTimer?: number;

  constructor(options: VoiceRoomOptions) {
    this.options = options;
  }

  get currentState(): VoiceRoomView {
    const active = this.active;
    if (!active) return { status: "idle" };
    const status: VoiceRoomView["status"] = !active.room
      ? "joining"
      : active.room.state === "reconnecting"
        ? "reconnecting"
        : active.room.state === "connected"
          ? "connected"
          : "connecting";
    const joinedRoom = active.room?.state === "connected" || active.room?.state === "reconnecting"
      ? active.room
      : undefined;
    return {
      status,
      channelId: active.channelId,
      conversationId: active.conversationId,
      roomName: active.roomName,
      participantCount: joinedRoom ? joinedRoom.remoteParticipants.size + 1 : 0,
      muted: active.muted,
      deafened: active.deafened,
      microphonePublished: active.microphonePublished,
      remoteAudioCount: active.remoteAudioTrackSids.size,
      audioPlaybackBlocked: active.audioPlaybackAllowed === false && active.remoteAudioTrackSids.size > 0,
      audioIssue: active.audioIssue,
      participants: joinedRoom
        ? [
            {
              identity: joinedRoom.localParticipant.identity,
              userId: this.options.currentUserId,
              local: true,
              speaking: active.speakingIdentities.has(joinedRoom.localParticipant.identity),
              muted: active.muted,
            },
            ...Array.from(joinedRoom.remoteParticipants.values(), (participant) => ({
              identity: participant.identity,
              userId: active.participantUserIds.get(participant.identity),
              local: false,
              speaking: active.speakingIdentities.has(participant.identity),
              muted: !participant.isMicrophoneEnabled,
            })),
          ]
        : [],
    };
  }

  participantsForChannel(channelId: string): VoiceRoomParticipantView[] {
    const cached = this.knownParticipants.get(channelId);
    const active = this.active?.channelId === channelId ? this.currentState.participants ?? [] : [];
    const participants = active.map((participant) => ({
      ...participant,
      userId: participant.userId ?? cached?.get(participant.identity)?.userId,
    }));
    const identities = new Set(participants.map((participant) => participant.identity));
    for (const participant of cached?.values() ?? []) {
      if (participant.expiresAt <= Date.now() || identities.has(participant.identity)) continue;
      identities.add(participant.identity);
      participants.push({ identity: participant.identity, userId: participant.userId, local: false });
    }
    return participants;
  }

  async requestRoster(channelId: string, conversationId: string) {
    const now = Date.now();
    if (now - (this.rosterRequests.get(channelId) ?? 0) < 15_000) return;
    this.rosterRequests.set(channelId, now);
    try {
      const ciphertext = await this.options.encryptSignal(conversationId, {
        version: 1,
        kind: "naigi.voice.room",
        senderInstanceId: this.instanceId,
        channelId,
        action: "roster-request",
        expiresAt: now + 30_000,
      });
      if (!this.options.sendSignal(conversationId, ciphertext)) throw new Error("voice_signaling_unavailable");
    } catch (error) {
      if (this.rosterRequests.get(channelId) === now) this.rosterRequests.delete(channelId);
      throw error;
    }
  }

  async join(channel: { id: string; conversationId: string; name: string }) {
    assertVoiceSecureContext();
    if (this.active) throw new Error("voice_room_already_active");
    const active: ActiveRoom = {
      conversationId: channel.conversationId,
      channelId: channel.id,
      roomName: channel.name,
      muted: this.options.getInitialMuted?.() ?? false,
      deafened: this.options.getInitialDeafened?.() ?? false,
      participantUserIds: new Map(),
      microphonePublished: false,
      remoteAudioTrackSids: new Set(),
      speakingIdentities: new Set(),
      accessCheckInFlight: false,
      accessFailures: 0,
      cleaningUp: false,
    };
    this.active = active;
    this.emitState();

    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("voice_microphone_unavailable");
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of permissionStream.getTracks()) track.stop();
      if (!this.isActive(active)) return;
      for (let attempt = 0; attempt < 7; attempt += 1) {
        // Give a first participant time to finish LiveKit's E2EE handshake. If
        // its short bootstrap lease was abandoned, the last token refresh will
        // happen after that lease expires and can elect a new key owner.
        const key = await this.requestRoomKey(active, attempt === 0 ? 1_300 : 4_800);
        if (!this.isActive(active)) return;
        if (key) {
          active.sessionId = key.sessionId;
          active.mediaKey = key.mediaKey;
          await this.connect(active, await this.options.requestToken(active.channelId));
          return;
        }

        const ticket = await this.options.requestToken(active.channelId);
        if (!this.isActive(active)) return;
        if (ticket.canStart) {
          active.sessionId = crypto.randomUUID();
          active.mediaKey = randomMediaKey();
          await this.sendSignal(active, "room-open", { expiresAt: Date.now() + 15_000 });
          if (!this.isActive(active)) return;
          await this.connect(active, ticket);
          return;
        }
      }
      throw new Error("voice_room_key_unavailable");
    } catch (error) {
      await this.finish();
      throw error;
    }
  }

  async receiveSignal(channelId: string, conversationId: string, senderUserId: string, ciphertext: string) {
    if (ciphertext.length > 48_000) return;
    let value: Record<string, unknown>;
    try {
      value = await this.options.decryptSignal(conversationId, ciphertext);
    } catch {
      return;
    }
    const signal = parseVoiceRoomSignal(value);
    if (!signal || signal.channelId !== channelId || signal.senderInstanceId === this.instanceId) return;

    const active = this.active;
    if (signal.action === "participant-presence") {
      const participantIdentity = signal.participantIdentity!;
      const participants = this.knownParticipants.get(channelId) ?? new Map<string, KnownParticipant>();
      const previous = participants.get(participantIdentity);
      participants.set(participantIdentity, { identity: participantIdentity, userId: senderUserId, expiresAt: signal.expiresAt });
      this.knownParticipants.set(channelId, participants);
      this.ensureRosterExpiryTimer();
      const activeHere = active?.conversationId === conversationId && active.channelId === channelId;
      const newlySeen = !previous || previous.userId !== senderUserId || previous.expiresAt <= Date.now();
      const participantMappingChanged = activeHere && active.participantUserIds.get(participantIdentity) !== senderUserId;
      if (activeHere) active.participantUserIds.set(participantIdentity, senderUserId);
      if (newlySeen || participantMappingChanged) this.emitState();
      if (newlySeen && activeHere && active.room?.state === "connected") await this.announceParticipant(active);
      return;
    }
    if (signal.action === "participant-left") {
      const participantIdentity = signal.participantIdentity!;
      const participants = this.knownParticipants.get(channelId);
      const previous = participants?.get(participantIdentity);
      const activeHere = active?.conversationId === conversationId && active.channelId === channelId;
      if (previous?.userId === senderUserId) {
        participants?.delete(participantIdentity);
        if (participants?.size === 0) this.knownParticipants.delete(channelId);
      }
      if (activeHere && active.participantUserIds.get(participantIdentity) === senderUserId) {
        active.participantUserIds.delete(participantIdentity);
      }
      if (previous?.userId === senderUserId || activeHere) this.emitState();
      return;
    }
    if (signal.action === "roster-request") {
      if (active?.conversationId === conversationId && active.channelId === channelId
        && active.room?.state === "connected") await this.announceParticipant(active);
      return;
    }
    if (signal.action === "join-request") {
      if (!active || active.conversationId !== conversationId || active.channelId !== channelId
        || !active.sessionId || !active.mediaKey || active.room?.state !== "connected") return;
      await this.sendSignal(active, "room-key", {
        requestId: signal.requestId,
        expiresAt: Date.now() + 60_000,
      });
      return;
    }

    const pending = this.pendingKeyRequest;
    if (!pending || pending.conversationId !== conversationId || pending.channelId !== channelId) return;
    if (signal.action === "room-open"
      || signal.action === "room-key" && signal.requestId === pending.requestId) {
      this.resolvePendingKey({ sessionId: signal.sessionId!, mediaKey: signal.mediaKey! });
    }
  }

  async toggleMute() {
    const active = this.active;
    if (!active?.room) return;
    const muted = !active.muted;
    await setProcessedMicrophone(active.room, active.audioProcessor!, !muted, () => this.isActive(active));
    if (!this.isActive(active)) return;
    active.muted = muted;
    this.emitState();
  }

  async switchAudioInputDevice(deviceId: string) {
    const active = this.active;
    if (!active?.room) return;
    const switched = await active.room.switchActiveDevice("audioinput", deviceId || "default");
    if (!switched) throw new Error("voice_audio_input_unavailable");
  }

  async switchAudioOutputDevice(deviceId: string) {
    const active = this.active;
    if (!active?.room) return;
    const switched = await active.room.switchActiveDevice("audiooutput", deviceId);
    if (!switched) throw new Error("voice_audio_output_unavailable");
  }

  toggleDeafen() {
    const active = this.active;
    if (!active?.room) return;
    active.deafened = !active.deafened;
    this.refreshAudioPreferences();
    this.emitState();
  }

  setPushToTalk(pressed: boolean) { this.active?.audioProcessor?.setPushToTalk(pressed); }

  refreshAudioPreferences() {
    const active = this.active;
    if (!active) return;
    active.audioProcessor?.update();
    const preferences = this.options.getAudioPreferences?.() ?? defaultVoiceAudioPreferences;
    for (const audio of this.options.audioOutput.querySelectorAll<HTMLAudioElement>("audio[data-voice-room-audio]")) {
      const userId = active.participantUserIds.get(audio.dataset.voiceIdentity ?? "");
      const settings = voicePlaybackSettings(preferences, active.deafened, userId);
      audio.muted = settings.muted;
      audio.volume = settings.volume;
    }
  }

  async enableAudioPlayback() {
    const active = this.active;
    if (!active?.room) return;
    if (active.deafened) throw new Error("voice_audio_deafen_active");
    try {
      await active.room.startAudio();
      if (!this.isActive(active)) return;
      this.refreshAudioPreferences();
      active.audioPlaybackAllowed = true;
      if (active.audioIssue === "playback") active.audioIssue = undefined;
      this.emitState();
    } catch {
      if (!this.isActive(active)) return;
      active.audioPlaybackAllowed = false;
      active.audioIssue = "playback";
      this.emitState();
      throw new Error("voice_audio_playback_blocked");
    }
  }

  async leave() {
    await this.finish();
  }

  private async requestRoomKey(active: ActiveRoom, waitMs: number) {
    const requestId = crypto.randomUUID();
    const keyPromise = new Promise<RoomKey | undefined>((resolve) => {
      this.pendingKeyRequest = {
        conversationId: active.conversationId,
        channelId: active.channelId,
        requestId,
        resolve,
        timer: window.setTimeout(() => this.resolvePendingKey(undefined), waitMs),
      };
    });
    void this.sendSignal(active, "join-request", { requestId, expiresAt: Date.now() + 30_000 })
      .catch(() => this.resolvePendingKey(undefined));
    return keyPromise;
  }

  private async sendSignal(active: ActiveRoom, action: VoiceRoomSignalBody["action"], extra: Partial<VoiceRoomSignalBody>) {
    const ciphertext = await this.options.encryptSignal(active.conversationId, {
      version: 1,
      kind: "naigi.voice.room",
      senderInstanceId: this.instanceId,
      channelId: active.channelId,
      action,
      expiresAt: Date.now() + 60_000,
      ...(action === "room-open" || action === "room-key"
        ? { sessionId: active.sessionId, mediaKey: active.mediaKey }
        : {}),
      ...extra,
    } as VoiceRoomSignalBody);
    if (!this.options.sendSignal(active.conversationId, ciphertext)) throw new Error("voice_signaling_unavailable");
  }

  private async connect(active: ActiveRoom, ticket: RoomTicket) {
    if (!active.mediaKey) throw new Error("voice_room_key_unavailable");
    const worker = new Worker("/livekit-e2ee-worker.mjs", { type: "module" });
    const keyProvider = new ExternalE2EEKeyProvider();
    const audioInputDeviceId = this.options.getAudioInputDeviceId();
    const audioOutputDeviceId = this.options.getAudioOutputDeviceId();
    const audioProcessor = new VoiceAudioProcessor(() => this.options.getAudioPreferences?.() ?? defaultVoiceAudioPreferences);
    active.audioProcessor = audioProcessor;
    const room = new Room({
      encryption: { keyProvider, worker },
      audioCaptureDefaults: { ...(audioInputDeviceId ? { deviceId: audioInputDeviceId } : {}), autoGainControl: false },
      ...(audioOutputDeviceId ? { audioOutput: { deviceId: audioOutputDeviceId } } : {}),
    });
    active.room = room;
    active.worker = worker;
    this.emitStateIfActive(active);
    room.on(RoomEvent.ParticipantConnected, () => this.emitStateIfActive(active));
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      active.participantUserIds.delete(participant.identity);
      this.emitStateIfActive(active);
    });
    room.on(RoomEvent.TrackMuted, (publication) => {
      if (publication.source === Track.Source.Microphone) this.emitStateIfActive(active);
    });
    room.on(RoomEvent.TrackUnmuted, (publication) => {
      if (publication.source === Track.Source.Microphone) this.emitStateIfActive(active);
    });
    room.on(RoomEvent.Reconnecting, () => this.emitStateIfActive(active));
    room.on(RoomEvent.Reconnected, () => {
      if (this.isActive(active)) void this.announceParticipant(active).catch(() => undefined);
      this.emitStateIfActive(active);
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (!this.isActive(active)) return;
      active.speakingIdentities = new Set(speakers.map((speaker) => speaker.identity));
      this.emitState();
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, (allowed) => {
      if (!this.isActive(active)) return;
      active.audioPlaybackAllowed = allowed;
      if (allowed && active.audioIssue === "playback") active.audioIssue = undefined;
      else if (!allowed && active.remoteAudioTrackSids.size > 0) active.audioIssue = "playback";
      this.emitState();
    });
    room.on(RoomEvent.EncryptionError, () => {
      if (!this.isActive(active)) return;
      active.audioIssue = "encryption";
      console.warn("[voice-room] media encryption failed");
      this.emitState();
    });
    room.on(RoomEvent.TrackSubscriptionFailed, () => {
      if (!this.isActive(active)) return;
      active.audioIssue = "subscription";
      console.warn("[voice-room] remote track subscription failed");
      this.emitState();
    });
    room.on(RoomEvent.MediaDevicesError, (_error, kind) => {
      if (!this.isActive(active) || kind !== "audioinput") return;
      active.audioIssue = "microphone";
      this.emitState();
    });
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind !== Track.Kind.Audio || !this.isActive(active)) return;
      active.remoteAudioTrackSids.add(publication.trackSid);
      track.on(TrackEvent.AudioPlaybackFailed, () => {
        if (!this.isActive(active)) return;
        active.audioPlaybackAllowed = false;
        active.audioIssue = "playback";
        this.emitState();
      });
      track.on(TrackEvent.AudioPlaybackStarted, () => {
        if (!this.isActive(active)) return;
        active.audioPlaybackAllowed = true;
        if (active.audioIssue === "playback") active.audioIssue = undefined;
        this.emitState();
      });
      const element = document.createElement("audio");
      element.autoplay = true;
      element.muted = active.deafened;
      element.setAttribute("playsinline", "");
      element.dataset.voiceRoomAudio = "true";
      element.dataset.voiceIdentity = participant.identity;
      this.options.audioOutput.append(element);
      track.attach(element);
      this.refreshAudioPreferences();
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
      active.remoteAudioTrackSids.delete(publication.trackSid);
      if (active.remoteAudioTrackSids.size === 0 && active.audioIssue === "playback") active.audioIssue = undefined;
      for (const element of track.detach()) element.remove();
      this.emitStateIfActive(active);
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      if (!this.isActive(active) || active.cleaningUp) return;
      if (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED
        || reason === DisconnectReason.DUPLICATE_IDENTITY) this.options.onAccessRevoked?.();
      void this.finish();
    });

    await keyProvider.setKey(active.mediaKey);
    if (!this.isActive(active)) return;
    await room.setE2EEEnabled(true);
    await room.connect(ticket.url, ticket.token);
    if (!this.isActive(active)) return;
    await waitForLocalVoiceEncryption(room);
    if (!this.isActive(active)) return;
    await this.announceParticipant(active);
    if (!this.isActive(active)) return;
    active.presenceTimer = window.setInterval(() => {
      if (this.isActive(active) && active.room?.state === "connected") {
        void this.announceParticipant(active).catch(() => undefined);
      }
    }, 20_000);
    let microphone;
    try {
      microphone = await setProcessedMicrophone(room, audioProcessor, !active.muted, () => this.isActive(active));
    } catch (error) {
      if (error instanceof Error && ["NotAllowedError", "PermissionDeniedError", "NotFoundError"].includes(error.name)) throw error;
      console.warn("[voice-room] microphone publication failed", error instanceof Error ? error.name : "unknown");
      throw new Error("voice_microphone_publish_failed");
    }
    if (!this.isActive(active)) return;
    if (!active.muted && !microphone?.track) {
      console.warn("[voice-room] microphone publication returned no track");
      throw new Error("voice_microphone_publish_failed");
    }
    active.microphonePublished = Boolean(microphone?.track);
    active.audioIssue = undefined;
    this.beginAccessChecks(active);
    this.emitState();
  }

  private beginAccessChecks(active: ActiveRoom) {
    active.accessTimer = window.setInterval(() => {
      if (!this.isActive(active) || active.accessCheckInFlight) return;
      active.accessCheckInFlight = true;
      void this.options.checkAccess(active.channelId).then((authorized) => {
        if (!authorized && this.isActive(active)) this.options.onAccessRevoked?.();
        active.accessFailures = authorized ? 0 : active.accessFailures + 3;
      }).catch(() => {
        active.accessFailures += 1;
      }).finally(() => {
        active.accessCheckInFlight = false;
        if (this.isActive(active) && active.accessFailures >= 3) void this.finish();
      });
    }, 10_000);
  }

  private async announceParticipant(active: ActiveRoom) {
    const participantIdentity = active.room?.localParticipant.identity;
    if (!participantIdentity) return;
    await this.sendSignal(active, "participant-presence", {
      participantIdentity,
      expiresAt: Date.now() + 60_000,
    });
  }

  private ensureRosterExpiryTimer() {
    if (this.rosterExpiryTimer !== undefined) return;
    this.rosterExpiryTimer = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [channelId, participants] of this.knownParticipants) {
        for (const [identity, participant] of participants) {
          if (participant.expiresAt <= now) {
            participants.delete(identity);
            changed = true;
          }
        }
        if (participants.size === 0) this.knownParticipants.delete(channelId);
      }
      if (changed) this.emitState();
      if (this.knownParticipants.size === 0 && this.rosterExpiryTimer !== undefined) {
        window.clearInterval(this.rosterExpiryTimer);
        this.rosterExpiryTimer = undefined;
      }
    }, 5_000);
  }

  private resolvePendingKey(key: RoomKey | undefined) {
    const pending = this.pendingKeyRequest;
    if (!pending) return;
    this.pendingKeyRequest = undefined;
    window.clearTimeout(pending.timer);
    pending.resolve(key);
  }

  private emitStateIfActive(active: ActiveRoom) {
    if (this.isActive(active)) this.emitState();
  }

  private emitState() {
    this.refreshAudioPreferences();
    this.options.onState(this.currentState);
  }

  private isActive(active: ActiveRoom) {
    return this.active === active;
  }

  private async finish() {
    const active = this.active;
    if (!active) return;
    const participantIdentity = active.room?.localParticipant.identity;
    if (participantIdentity) {
      void this.sendSignal(active, "participant-left", {
        participantIdentity,
        expiresAt: Date.now() + 30_000,
      }).catch(() => undefined);
    }
    this.active = undefined;
    active.cleaningUp = true;
    this.resolvePendingKey(undefined);
    window.clearInterval(active.accessTimer);
    window.clearInterval(active.presenceTimer);
    this.options.audioOutput.replaceChildren();
    this.emitState();
    try {
      await active.room?.disconnect();
    } catch {
      // The room is already gone.
    }
    active.worker?.terminate();
    await active.audioProcessor?.destroy();
  }
}
