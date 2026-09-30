import { ExternalE2EEKeyProvider, Room, RoomEvent, Track } from "livekit-client";
import { assertVoiceSecureContext, waitForLocalVoiceEncryption } from "./voice-e2ee";
import { parseVoiceCallSignal, type VoiceSignalBody } from "./voice-protocol";
import { VoiceAudioProcessor, setProcessedMicrophone } from "./voice-audio-processor";
import { defaultVoiceAudioPreferences, voicePlaybackSettings, type VoiceAudioPreferences } from "./voice-audio-preferences";

export type VoiceCallView = {
  status: "idle" | "incoming" | "calling" | "connecting" | "connected" | "reconnecting";
  conversationId?: string;
  callId?: string;
  peerName?: string;
  muted?: boolean;
  deafened?: boolean;
};

type RoomTicket = { url: string; token: string };

type ActiveCall = {
  conversationId: string;
  callId: string;
  peerName: string;
  peerUserId?: string;
  mediaKey: string;
  direction: "outgoing" | "incoming";
  acceptedLocally?: boolean;
  room?: Room;
  worker?: Worker;
  audioProcessor?: VoiceAudioProcessor;
  muted: boolean;
  deafened: boolean;
  peerAccepted?: boolean;
  timer?: number;
  accessTimer?: number;
  accessCheckInFlight: boolean;
  accessFailures: number;
  cleaningUp: boolean;
};

type VoiceCallOptions = {
  currentUserId: string;
  requestToken: (conversationId: string, callId: string) => Promise<RoomTicket>;
  checkAccess: (conversationId: string, callId: string) => Promise<boolean>;
  encryptSignal: (conversationId: string, value: VoiceSignalBody) => Promise<string>;
  decryptSignal: (conversationId: string, ciphertext: string) => Promise<Record<string, unknown>>;
  sendSignal: (conversationId: string, ciphertext: string) => boolean;
  onState: (state: VoiceCallView) => void;
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

export class VoiceCallController {
  private readonly options: VoiceCallOptions;
  private readonly instanceId = crypto.randomUUID();
  private active?: ActiveCall;

  constructor(options: VoiceCallOptions) {
    this.options = options;
  }

  get currentState(): VoiceCallView {
    if (!this.active) return { status: "idle" };
    const status = this.active.room
      ? this.active.room.state === "reconnecting"
        ? "reconnecting"
        : this.active.room.remoteParticipants.size > 0
          ? "connected"
          : this.active.direction === "outgoing"
            ? this.active.peerAccepted ? "connecting" : "calling"
            : "connecting"
      : this.active.direction === "incoming"
        ? this.active.acceptedLocally ? "connecting" : "incoming"
        : this.active.peerAccepted ? "connecting" : "calling";
    return {
      status,
      conversationId: this.active.conversationId,
      callId: this.active.callId,
      peerName: this.active.peerName,
      muted: this.active.muted,
      deafened: this.active.deafened,
    };
  }

  async start(conversationId: string, peerName: string, peerUserId?: string) {
    assertVoiceSecureContext();
    if (this.active) throw new Error("voice_call_already_active");
    const active: ActiveCall = {
      conversationId,
      callId: crypto.randomUUID(),
      peerName,
      peerUserId,
      mediaKey: randomMediaKey(),
      direction: "outgoing",
      muted: this.options.getInitialMuted?.() ?? false,
      deafened: this.options.getInitialDeafened?.() ?? false,
      accessCheckInFlight: false,
      accessFailures: 0,
      cleaningUp: false,
    };
    this.active = active;
    this.emitState();

    try {
      const ticket = await this.options.requestToken(conversationId, active.callId);
      if (!this.isActive(active)) return;
      await this.sendAction(active, "invite", { expiresAt: Date.now() + 60_000 });
      if (!this.isActive(active)) return;
      this.armPeerTimeout(active);
      await this.connect(active, ticket);
      this.emitState();
    } catch (error) {
      void this.sendAction(active, "end").catch(() => undefined);
      await this.finish();
      throw error;
    }
  }

  async receiveSignal(conversationId: string, senderUserId: string, ciphertext: string, peerName: string) {
    if (ciphertext.length > 48_000) return;
    let value: Record<string, unknown>;
    try {
      value = await this.options.decryptSignal(conversationId, ciphertext);
    } catch {
      return;
    }
    const signal = parseVoiceCallSignal(value);
    if (!signal) return;
    if (signal.senderInstanceId === this.instanceId) return;
    if (signal.action === "invite") {
      if (senderUserId === this.options.currentUserId) return;
      if (this.active) return;
      this.active = {
        conversationId,
        callId: signal.callId,
        peerName,
        peerUserId: senderUserId,
        mediaKey: signal.mediaKey!,
        direction: "incoming",
        acceptedLocally: false,
        muted: this.options.getInitialMuted?.() ?? false,
        deafened: this.options.getInitialDeafened?.() ?? false,
        accessCheckInFlight: false,
        accessFailures: 0,
        cleaningUp: false,
      };
      const active = this.active;
      active.timer = window.setTimeout(() => {
        if (this.isActive(active) && active.direction === "incoming") void this.decline();
      }, Math.min(45_000, Math.max(1_000, signal.expiresAt! - Date.now())));
      this.emitState();
      return;
    }

    const active = this.active;
    if (!active || active.callId !== signal.callId) return;
    if (signal.action === "accept") {
      if (active.direction === "incoming" && !active.room) await this.finish();
      else if (active.direction === "outgoing") {
        active.peerAccepted = true;
        this.emitState();
      }
      return;
    }
    if (signal.action === "decline" || signal.action === "end") {
      await this.finish();
    }
  }

  async accept() {
    const active = this.active;
    if (!active || active.direction !== "incoming") return;
    assertVoiceSecureContext();
    window.clearTimeout(active.timer);
    active.timer = undefined;
    active.acceptedLocally = true;
    this.emitState();
    try {
      void this.sendAction(active, "accept").catch(() => undefined);
      this.armPeerTimeout(active);
      const ticket = await this.options.requestToken(active.conversationId, active.callId);
      if (!this.isActive(active)) return;
      await this.connect(active, ticket);
      this.emitState();
    } catch (error) {
      void this.sendAction(active, "decline").catch(() => undefined);
      await this.finish();
      throw error;
    }
  }

  async decline() {
    const active = this.active;
    if (!active || active.direction !== "incoming") return;
    void this.sendAction(active, "decline").catch(() => undefined);
    await this.finish();
  }

  async end() {
    const active = this.active;
    if (!active) return;
    const action = active.direction === "incoming" && !active.acceptedLocally ? "decline" : "end";
    void this.sendAction(active, action).catch(() => undefined);
    await this.finish();
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
    const settings = voicePlaybackSettings(this.options.getAudioPreferences?.() ?? defaultVoiceAudioPreferences, active.deafened, active.peerUserId);
    for (const audio of this.options.audioOutput.querySelectorAll<HTMLAudioElement>("audio[data-voice-call-audio]")) {
      audio.muted = settings.muted;
      audio.volume = settings.volume;
    }
  }

  private async sendAction(active: ActiveCall, action: VoiceSignalBody["action"], extra: Pick<VoiceSignalBody, "expiresAt"> = {}) {
    const ciphertext = await this.options.encryptSignal(active.conversationId, {
      version: 1,
      kind: "naigi.voice.call",
      senderInstanceId: this.instanceId,
      action,
      callId: active.callId,
      ...extra,
      ...(action === "invite" ? { mediaKey: active.mediaKey } : {}),
    });
    if (!this.options.sendSignal(active.conversationId, ciphertext)) throw new Error("voice_signaling_unavailable");
  }

  private async connect(active: ActiveCall, ticket: RoomTicket) {
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
    room.on(RoomEvent.ParticipantConnected, () => {
      if (!this.isActive(active)) return;
      window.clearTimeout(active.timer);
      active.timer = undefined;
      this.emitState();
    });
    room.on(RoomEvent.ParticipantDisconnected, () => {
      if (!this.isActive(active)) return;
      if (room.remoteParticipants.size === 0) this.armPeerTimeout(active);
      this.emitState();
    });
    room.on(RoomEvent.Reconnecting, () => this.emitStateIfActive(active));
    room.on(RoomEvent.Reconnected, () => this.emitStateIfActive(active));
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio || !this.isActive(active)) return;
      const element = document.createElement("audio");
      element.autoplay = true;
      element.muted = active.deafened;
      element.setAttribute("playsinline", "");
      element.dataset.voiceCallAudio = "true";
      this.options.audioOutput.append(element);
      track.attach(element);
      this.refreshAudioPreferences();
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
    await room.connect(ticket.url, ticket.token);
    if (!this.isActive(active)) return;
    await waitForLocalVoiceEncryption(room);
    if (!this.isActive(active)) return;
    await setProcessedMicrophone(room, audioProcessor, !active.muted, () => this.isActive(active));
    if (!this.isActive(active)) return;
    this.beginAccessChecks(active);
    this.emitState();
  }

  private beginAccessChecks(active: ActiveCall) {
    active.accessTimer = window.setInterval(() => {
      if (!this.isActive(active) || active.accessCheckInFlight) return;
      active.accessCheckInFlight = true;
      void this.options.checkAccess(active.conversationId, active.callId).then((authorized) => {
        active.accessFailures = authorized ? 0 : active.accessFailures + 3;
      }).catch(() => {
        active.accessFailures += 1;
      }).finally(() => {
        active.accessCheckInFlight = false;
        if (this.isActive(active) && active.accessFailures >= 3) void this.finish();
      });
    }, 10_000);
  }

  private armPeerTimeout(active: ActiveCall) {
    window.clearTimeout(active.timer);
    active.timer = window.setTimeout(() => {
      if (this.isActive(active) && (!active.room || active.room.remoteParticipants.size === 0)) void this.end();
    }, 60_000);
  }

  private emitStateIfActive(active: ActiveCall) {
    if (this.isActive(active)) this.emitState();
  }

  private emitState() {
    this.refreshAudioPreferences();
    this.options.onState(this.currentState);
  }

  private isActive(active: ActiveCall) {
    return this.active === active;
  }

  private async finish() {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.cleaningUp = true;
    window.clearTimeout(active.timer);
    window.clearInterval(active.accessTimer);
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
