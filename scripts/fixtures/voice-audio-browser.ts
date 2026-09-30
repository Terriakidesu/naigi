import { LocalAudioTrack, Room, Track } from "livekit-client";
import { VoiceAudioProcessor, setProcessedMicrophone } from "../../client/voice-audio-processor";
import { normalizeVoiceAudioPreferences } from "../../client/voice-audio-preferences";
import { setupVoiceAudioSettings } from "../../client/voice-audio-settings";

const userId = "11111111-1111-4111-8111-111111111111";
for (const view of document.querySelectorAll<HTMLElement>("[data-settings-view]")) view.hidden = view.id !== "audio";
setupVoiceAudioSettings(userId);

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function exerciseProcessor() {
  let preferences = normalizeVoiceAudioPreferences(undefined);
  const context = new AudioContext();
  await context.resume();
  const oscillator = context.createOscillator();
  const inputGain = context.createGain();
  const capture = context.createMediaStreamDestination();
  oscillator.connect(inputGain).connect(capture);
  oscillator.start();
  const rawTrack = capture.stream.getAudioTracks()[0];
  const processor = new VoiceAudioProcessor(() => preferences);
  await processor.init({ kind: Track.Kind.Audio, track: rawTrack, audioContext: context });
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  const output = context.createMediaStreamSource(new MediaStream([processor.processedTrack!]));
  const silent = context.createGain();
  silent.gain.value = 0;
  output.connect(analyser).connect(silent).connect(context.destination);
  const samples = new Float32Array(analyser.fftSize);
  const measure = async () => {
    await pause(300);
    analyser.getFloatTimeDomainData(samples);
    return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  };
  const normal = await measure();
  preferences.inputVolume = 50;
  processor.update();
  const half = await measure();
  preferences.mode = "push-to-talk";
  processor.update();
  const closed = await measure();
  processor.setPushToTalk(true);
  const held = await measure();
  processor.setPushToTalk(false);
  const released = await measure();
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
  const shortcut = await measure();
  window.dispatchEvent(new Event("blur"));
  const blurred = await measure();
  const typing = document.createElement("textarea");
  document.body.append(typing);
  typing.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
  const whileTyping = await measure();
  typing.remove();
  preferences.mode = "activity";
  preferences.inputVolume = 100;
  preferences.silenceThreshold = -40;
  inputGain.gain.value = 0.001;
  processor.update();
  const quiet = await measure();
  inputGain.gain.value = 0.5;
  const loud = await measure();
  inputGain.gain.value = 0.001;
  const quietAgain = await measure();
  preferences.inputVolume = 0;
  processor.update();
  const zeroGain = await measure();
  const processedTrack = processor.processedTrack!;
  await processor.destroy();
  const ended = processedTrack.readyState === "ended";
  rawTrack.stop();
  oscillator.stop();
  output.disconnect();
  await context.close();
  return { normal, half, closed, held, released, shortcut, blurred, whileTyping, quiet, loud, quietAgain, zeroGain, ended };
}

async function exercisePublication() {
  const context = new AudioContext();
  await context.resume();
  const room = new Room({ audioCaptureDefaults: { autoGainControl: false } });
  room.localParticipant.setAudioContext(context);
  const preferences = normalizeVoiceAudioPreferences({ mode: "push-to-talk" });
  const processor = new VoiceAudioProcessor(() => preferences);
  let processedBeforePublication = false;
  let microphone: LocalAudioTrack | undefined;
  // Keep capture/processor initialization real; replace only the relay publication.
  room.localParticipant.publishTrack = async (track) => {
    if (!(track instanceof LocalAudioTrack)) throw new Error("Unexpected track kind");
    microphone = track;
    processedBeforePublication = track.getProcessor() === processor && track.mediaStreamTrack === processor.processedTrack;
    return { track } as any;
  };
  await setProcessedMicrophone(room, processor, true, () => true);
  if (!microphone) throw new Error("No microphone created");
  const samples = new Float32Array(512);
  const analyser = context.createAnalyser();
  analyser.fftSize = samples.length;
  const output = context.createMediaStreamSource(new MediaStream([microphone.mediaStreamTrack]));
  const silent = context.createGain();
  silent.gain.value = 0;
  output.connect(analyser).connect(silent).connect(context.destination);
  await pause(300);
  analyser.getFloatTimeDomainData(samples);
  const closedEnergy = samples.reduce((sum, sample) => sum + sample * sample, 0);
  await microphone.mute();
  processor.setPushToTalk(true);
  await pause(300);
  analyser.getFloatTimeDomainData(samples);
  const mutedEnergy = samples.reduce((sum, sample) => sum + sample * sample, 0);
  await microphone.restartTrack();
  const processorSurvivedDeviceRestart = microphone.getProcessor() === processor && microphone.mediaStreamTrack === processor.processedTrack;
  output.disconnect();
  const restartedOutput = context.createMediaStreamSource(new MediaStream([microphone.mediaStreamTrack]));
  restartedOutput.connect(analyser);
  processor.setPushToTalk(true);
  await pause(300);
  analyser.getFloatTimeDomainData(samples);
  const mutedEnergyAfterRestart = samples.reduce((sum, sample) => sum + sample * sample, 0);
  restartedOutput.disconnect();
  microphone.stop();
  await processor.destroy();
  await room.disconnect();
  await context.close();
  return { processedBeforePublication, closedEnergy, mutedEnergy, mutedEnergyAfterRestart, processorSurvivedDeviceRestart };
}

Object.assign(window, { voiceAudioTest: { exerciseProcessor, exercisePublication, userId } });
