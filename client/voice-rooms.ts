import { ExternalE2EEKeyProvider, Room, RoomEvent, Track } from "livekit-client";
import { parseVoiceRoomSignal, type VoiceRoomSignalBody } from "./voice-room-protocol";

export type VoiceRoomView = {
  status: "idle" | "joining" | "connecting" | "connected" | "reconnecting";
  channelId?: string;
  conversationId?: string;
  roomName?: string;
  participantCount?: number;
  muted?: boolean;
};

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
  muted: boolean;
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

type VoiceRoomOptions = {
  requestToken: (channelId: string) => Promise<RoomTicket>;
  checkAccess: (channelId: string) => Promise<boolean>;
  encryptSignal: (conversationId: string, value: VoiceRoomSignalBody) => Promise<string>;
  decryptSignal: (conversationId: string, ciphertext: string) => Promise<Record<string, unknown>>;
  sendSignal: (conversationId: string, ciphertext: string) => boolean;
  onState: (state: VoiceRoomView) => void;
  audioOutput: HTMLElement;
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
    return {
      status,
      channelId: active.channelId,
      conversationId: active.conversationId,
      roomName: active.roomName,
      participantCount: active.room?.state === "connected" ? active.room.remoteParticipants.size + 1 : 0,
      muted: active.muted,
    };
  }

  async join(channel: { id: string; conversationId: string; name: string }) {
    if (this.active) throw new Error("voice_room_already_active");
    const active: ActiveRoom = {
      conversationId: channel.conversationId,
      channelId: channel.id,
      roomName: channel.name,
      muted: false,
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

  async receiveSignal(conversationId: string, ciphertext: string) {
    if (ciphertext.length > 48_000) return;
    let value: Record<string, unknown>;
    try {
      value = await this.options.decryptSignal(conversationId, ciphertext);
    } catch {
      return;
    }
    const signal = parseVoiceRoomSignal(value);
    if (!signal || signal.senderInstanceId === this.instanceId) return;

    const active = this.active;
    if (signal.action === "join-request") {
      if (!active || active.conversationId !== conversationId || active.channelId !== signal.channelId
        || !active.sessionId || !active.mediaKey || active.room?.state !== "connected") return;
      await this.sendSignal(active, "room-key", {
        requestId: signal.requestId,
        expiresAt: Date.now() + 60_000,
      });
      return;
    }

    const pending = this.pendingKeyRequest;
    if (!pending || pending.conversationId !== conversationId || pending.channelId !== signal.channelId) return;
    if (signal.action === "room-open"
      || signal.action === "room-key" && signal.requestId === pending.requestId) {
      this.resolvePendingKey({ sessionId: signal.sessionId!, mediaKey: signal.mediaKey! });
    }
  }

  async toggleMute() {
    const active = this.active;
    if (!active?.room) return;
    const muted = !active.muted;
    await active.room.localParticipant.setMicrophoneEnabled(!muted);
    if (!this.isActive(active)) return;
    active.muted = muted;
    this.emitState();
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
    const room = new Room({ encryption: { keyProvider, worker } });
    active.room = room;
    active.worker = worker;
    this.emitStateIfActive(active);
    room.on(RoomEvent.ParticipantConnected, () => this.emitStateIfActive(active));
    room.on(RoomEvent.ParticipantDisconnected, () => this.emitStateIfActive(active));
    room.on(RoomEvent.Reconnecting, () => this.emitStateIfActive(active));
    room.on(RoomEvent.Reconnected, () => this.emitStateIfActive(active));
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio || !this.isActive(active)) return;
      const element = track.attach();
      element.autoplay = true;
      element.setAttribute("playsinline", "");
      element.dataset.voiceRoomAudio = "true";
      this.options.audioOutput.append(element);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const element of track.detach()) element.remove();
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.isActive(active) && !active.cleaningUp) void this.finish();
    });

    await keyProvider.setKey(active.mediaKey);
    if (!this.isActive(active)) return;
    await room.setE2EEEnabled(true);
    if (!room.isE2EEEnabled) throw new Error("voice_media_encryption_unavailable");
    await room.connect(ticket.url, ticket.token);
    if (!this.isActive(active)) return;
    await room.localParticipant.setMicrophoneEnabled(true);
    if (!this.isActive(active)) return;
    this.beginAccessChecks(active);
    this.emitState();
  }

  private beginAccessChecks(active: ActiveRoom) {
    active.accessTimer = window.setInterval(() => {
      if (!this.isActive(active) || active.accessCheckInFlight) return;
      active.accessCheckInFlight = true;
      void this.options.checkAccess(active.channelId).then((authorized) => {
        active.accessFailures = authorized ? 0 : active.accessFailures + 3;
      }).catch(() => {
        active.accessFailures += 1;
      }).finally(() => {
        active.accessCheckInFlight = false;
        if (this.isActive(active) && active.accessFailures >= 3) void this.finish();
      });
    }, 10_000);
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
    this.options.onState(this.currentState);
  }

  private isActive(active: ActiveRoom) {
    return this.active === active;
  }

  private async finish() {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.cleaningUp = true;
    this.resolvePendingKey(undefined);
    window.clearInterval(active.accessTimer);
    this.options.audioOutput.replaceChildren();
    this.emitState();
    try {
      await active.room?.disconnect();
    } catch {
      // The room is already gone.
    }
    active.worker?.terminate();
  }
}
