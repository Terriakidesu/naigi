import { voiceGateOpen } from "./voice-audio-preferences";

type GateControls = { mode: "activity" | "push-to-talk"; silenceThreshold: number; inputVolume: number; pressed: boolean };
declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class VoiceAudioGate extends AudioWorkletProcessor {
  private controls: GateControls = { mode: "push-to-talk", silenceThreshold: -100, inputVolume: 0, pressed: false };
  private holdFrames = 0;
  private meterFrames = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<GateControls>) => {
      this.controls = event.data;
      // Changing modes or releasing PTT must close immediately, not use the activity hangover.
      this.holdFrames = 0;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    const frames = output[0]?.length ?? 128;
    let energy = 0;
    let samples = 0;
    for (const channel of input) for (const sample of channel) { energy += sample * sample; samples += 1; }
    const level = samples ? Math.max(-100, 10 * Math.log10(Math.max(energy / samples, 1e-10))) : -100;
    const detected = voiceGateOpen(level, this.controls, this.controls.pressed);
    if (this.controls.mode === "activity" && detected) this.holdFrames = sampleRate * 0.2;
    const open = this.controls.mode === "push-to-talk" ? detected : detected || this.holdFrames > 0;
    this.holdFrames = Math.max(0, this.holdFrames - frames);
    const gain = open ? this.controls.inputVolume / 100 : 0;
    for (let channel = 0; channel < output.length; channel += 1) {
      const source = input[channel] ?? input[0];
      for (let frame = 0; frame < output[channel].length; frame += 1) output[channel][frame] = Math.max(-1, Math.min(1, (source?.[frame] ?? 0) * gain));
    }
    this.meterFrames += frames;
    if (this.meterFrames >= sampleRate / 20) {
      this.port.postMessage({ level, open });
      this.meterFrames = 0;
    }
    return true;
  }
}

registerProcessor("naigi-voice-audio", VoiceAudioGate);
