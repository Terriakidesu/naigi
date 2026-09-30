import { LocalAudioTrack, Track, type AudioProcessorOptions, type Room, type TrackProcessor } from "livekit-client";
import type { VoiceAudioPreferences } from "./voice-audio-preferences";

const modules = new WeakMap<AudioContext, Promise<void>>();

export async function setProcessedMicrophone(room: Room, processor: VoiceAudioProcessor, enabled: boolean, isActive: () => boolean) {
  const participant = room.localParticipant;
  if (!enabled || participant.getTrackPublication(Track.Source.Microphone)) return participant.setMicrophoneEnabled(enabled);
  // Initialize processing before publication, so PTT never leaks ungated microphone frames.
  // createTracks also supplies the SDK AudioContext before we install the processor.
  const tracks = await participant.createTracks({ audio: true, video: false });
  const track = tracks.find((candidate): candidate is LocalAudioTrack => candidate instanceof LocalAudioTrack);
  try {
    if (!track) throw new Error("voice_microphone_unavailable");
    await track.setProcessor(processor);
    if (!isActive()) { tracks.forEach((candidate) => candidate.stop()); return; }
    return await participant.publishTrack(track, { source: Track.Source.Microphone });
  } catch (error) {
    tracks.forEach((candidate) => candidate.stop());
    await processor.destroy();
    throw error;
  }
}

export class VoiceAudioProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "Naigi voice audio";
  processedTrack?: MediaStreamTrack;
  private source?: MediaStreamAudioSourceNode;
  private node?: AudioWorkletNode;
  private destination?: MediaStreamAudioDestinationNode;
  private context?: AudioContext;
  private keyPressed = false;
  private buttonPressed = false;
  private lastKey = "";
  private lastMode?: VoiceAudioPreferences["mode"];
  private lastControls = "";
  private generation = 0;

  constructor(private readonly preferences: () => VoiceAudioPreferences, private readonly onLevel?: (level: number, open: boolean) => void) {}

  async init(options: AudioProcessorOptions) {
    const generation = ++this.generation;
    const context = options.audioContext;
    if (!context?.audioWorklet) throw new Error("voice_audio_processing_unavailable");
    this.context = context;
    let ready = modules.get(context);
    if (!ready) {
      ready = context.audioWorklet.addModule("/voice-audio-worklet.js");
      modules.set(context, ready);
      void ready.catch(() => modules.delete(context));
    }
    await ready;
    if (generation !== this.generation) throw new DOMException("Audio setup cancelled", "AbortError");
    // SDK device restarts acquire an enabled raw track before restoring its mute flag.
    // Keep it silent throughout graph setup and sender replacement when manually muted.
    if (options.localTrack?.isMuted) options.track.enabled = false;
    this.node = new AudioWorkletNode(context, "naigi-voice-audio", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.source = context.createMediaStreamSource(new MediaStream([options.track]));
    this.destination = context.createMediaStreamDestination();
    this.source.connect(this.node);
    this.node.connect(this.destination);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
    this.node.port.onmessage = (event: MessageEvent<{ level: number; open: boolean }>) => this.onLevel?.(event.data.level, event.data.open);
    this.update();
    window.addEventListener("keydown", this.keyDown);
    window.addEventListener("keyup", this.keyUp);
    window.addEventListener("blur", this.release);
    document.addEventListener("visibilitychange", this.visibilityChange);
    await context.resume();
  }

  update() {
    const preferences = this.preferences();
    if (this.lastMode !== preferences.mode) { this.keyPressed = false; this.buttonPressed = false; }
    this.lastMode = preferences.mode;
    if (this.lastKey !== preferences.pushToTalkKey) this.keyPressed = false;
    this.lastKey = preferences.pushToTalkKey;
    const controls = { mode: preferences.mode, silenceThreshold: preferences.silenceThreshold, inputVolume: preferences.inputVolume, pressed: this.keyPressed || this.buttonPressed };
    const signature = JSON.stringify(controls);
    if (this.node && signature !== this.lastControls) {
      this.node.port.postMessage(controls);
      this.lastControls = signature;
    }
  }

  setPushToTalk(pressed: boolean) { this.buttonPressed = pressed; this.update(); }

  private keyDown = (event: KeyboardEvent) => {
    const preferences = this.preferences();
    if (preferences.mode !== "push-to-talk" || event.code !== preferences.pushToTalkKey || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, button, a, [contenteditable]:not([contenteditable='false'])")) return;
    event.preventDefault();
    this.keyPressed = true;
    this.update();
  };

  private keyUp = (event: KeyboardEvent) => {
    if (event.code !== this.lastKey) return;
    this.keyPressed = false;
    this.update();
  };
  private release = () => { this.keyPressed = false; this.buttonPressed = false; this.update(); };
  private visibilityChange = () => { if (document.hidden) this.release(); };

  async restart(options: AudioProcessorOptions) {
    // LiveKit's generic track restart omits the AudioContext despite its audio processor type.
    const audioContext = options.audioContext ?? this.context;
    await this.destroy();
    if (!audioContext) throw new Error("voice_audio_processing_unavailable");
    await this.init({ ...options, audioContext });
  }

  async destroy() {
    this.generation += 1;
    window.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("keyup", this.keyUp);
    window.removeEventListener("blur", this.release);
    document.removeEventListener("visibilitychange", this.visibilityChange);
    this.source?.disconnect();
    this.node?.disconnect();
    if (this.node) { this.node.port.onmessage = null; this.node.port.close(); }
    this.destination?.disconnect();
    this.processedTrack?.stop();
    this.node = undefined;
    this.source = undefined;
    this.destination = undefined;
    this.context = undefined;
    this.processedTrack = undefined;
    this.keyPressed = false;
    this.buttonPressed = false;
    this.lastControls = "";
    this.lastMode = undefined;
  }
}
