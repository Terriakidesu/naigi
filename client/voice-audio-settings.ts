import { Track } from "livekit-client";
import { VoiceAudioProcessor } from "./voice-audio-processor";
import { loadVoiceAudioPreferences, saveVoiceAudioPreferences, voiceAudioStorageKey, type VoiceAudioPreferences } from "./voice-audio-preferences";

export function setupVoiceAudioSettings(userId: string) {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const form = element<HTMLFormElement>("voice-audio-form");
  const mode = element<HTMLSelectElement>("audio-input-mode");
  const key = element<HTMLButtonElement>("audio-ptt-key");
  const input = element<HTMLSelectElement>("audio-default-input");
  const output = element<HTMLSelectElement>("audio-default-output");
  const inputVolume = element<HTMLInputElement>("audio-input-volume");
  const outputVolume = element<HTMLInputElement>("audio-output-volume");
  const threshold = element<HTMLInputElement>("audio-silence-threshold");
  const start = element<HTMLButtonElement>("audio-mic-test");
  const hold = element<HTMLButtonElement>("audio-test-ptt");
  const listen = element<HTMLInputElement>("audio-test-listen");
  const meter = element<HTMLElement>("audio-test-meter");
  const testStatus = element<HTMLElement>("audio-test-status");
  const saveStatus = element<HTMLElement>("audio-save-status");
  let preferences = loadVoiceAudioPreferences(userId);
  let recordingKey = false;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let processor: VoiceAudioProcessor | undefined;
  let playback: HTMLAudioElement | undefined;
  let running = false;
  let generation = 0;
  let testTimer: number | undefined;

  const render = () => {
    mode.value = preferences.mode;
    for (const [select, selected] of [[input, preferences.inputDeviceId], [output, preferences.outputDeviceId]] as const) {
      if (selected && ![...select.options].some((option) => option.value === selected)) select.add(new Option("Saved device", selected));
      select.value = selected;
    }
    inputVolume.value = String(preferences.inputVolume);
    outputVolume.value = String(preferences.outputVolume);
    threshold.value = String(preferences.silenceThreshold);
    key.textContent = preferences.pushToTalkKey === "Space" ? "Space" : preferences.pushToTalkKey.replace(/^Key|^Digit/, "");
    element<HTMLElement>("audio-input-volume-value").textContent = `${preferences.inputVolume}%`;
    element<HTMLElement>("audio-output-volume-value").textContent = `${preferences.outputVolume}%`;
    element<HTMLElement>("audio-threshold-value").textContent = preferences.silenceThreshold <= -100 ? "Off" : `${preferences.silenceThreshold} dBFS`;
    key.disabled = mode.value !== "push-to-talk";
    threshold.disabled = mode.value === "push-to-talk";
    hold.hidden = !running || mode.value !== "push-to-talk";
  };

  const enumerate = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      input.disabled = true;
      output.disabled = true;
      start.disabled = true;
      saveStatus.textContent = "Microphone access requires a supported browser and trusted HTTPS.";
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [select, kind, selected] of [[input, "audioinput", preferences.inputDeviceId], [output, "audiooutput", preferences.outputDeviceId]] as const) {
      const defaultOption = new Option(kind === "audioinput" ? "System default microphone" : "System default output", "");
      const choices = devices.filter((device) => device.kind === kind && device.deviceId && device.deviceId !== "default");
      select.replaceChildren(defaultOption, ...choices.map((device, index) => new Option(device.label || `${kind === "audioinput" ? "Microphone" : "Speaker"} ${index + 1}`, device.deviceId)));
      if (selected && !choices.some((device) => device.deviceId === selected)) select.add(new Option("Saved device (currently unavailable)", selected));
      select.value = selected;
    }
    output.disabled = !("setSinkId" in HTMLAudioElement.prototype);
    if (output.disabled) output.title = "Output selection is not supported by this browser. Use your operating system settings.";
  };

  const stopTest = async () => {
    const token = ++generation;
    running = false;
    window.clearTimeout(testTimer);
    start.textContent = "Start mic test";
    start.disabled = false;
    hold.hidden = true;
    hold.setAttribute("aria-pressed", "false");
    playback?.pause();
    if (playback) playback.srcObject = null;
    playback?.remove();
    playback = undefined;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = undefined;
    const oldProcessor = processor;
    const oldContext = context;
    processor = undefined;
    context = undefined;
    await oldProcessor?.destroy();
    await oldContext?.close();
    if (token !== generation) return;
    meter.style.setProperty("--audio-level", "0%");
    meter.setAttribute("aria-valuenow", "-100");
    testStatus.textContent = "Mic test stopped.";
  };

  const save = () => {
    preferences = saveVoiceAudioPreferences(userId, {
      ...preferences, mode: mode.value as VoiceAudioPreferences["mode"],
      inputVolume: Number(inputVolume.value), outputVolume: Number(outputVolume.value), silenceThreshold: Number(threshold.value),
      inputDeviceId: input.value, outputDeviceId: output.value,
    });
    processor?.update();
    if (playback) playback.volume = preferences.outputVolume / 100;
    saveStatus.textContent = "Saved on this browser. Changes apply to active audio in other Naigi tabs.";
    render();
  };

  form.addEventListener("submit", (event) => event.preventDefault());
  for (const field of [mode, inputVolume, outputVolume, threshold]) field.addEventListener("input", save);
  for (const field of [input, output]) field.addEventListener("change", () => { save(); void stopTest(); });

  key.addEventListener("click", () => { recordingKey = true; key.textContent = "Press a key… (Esc cancels)"; });
  key.addEventListener("keydown", (event) => {
    if (!recordingKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.code !== "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && /^(Space|Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2]))$/.test(event.code)) {
      preferences.pushToTalkKey = event.code;
      save();
    }
    recordingKey = false;
    render();
  });
  key.addEventListener("blur", () => { recordingKey = false; render(); });

  start.addEventListener("click", () => {
    if (running) { void stopTest(); return; }
    void (async () => {
      const token = ++generation;
      running = true;
      start.textContent = "Stop mic test";
      testStatus.textContent = "Requesting microphone access…";
      render();
      try {
        if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) throw new Error("Mic test requires trusted HTTPS and microphone permission.");
        const newContext = new AudioContext();
        context = newContext;
        await newContext.resume();
        if (token !== generation) return;
        const capture = await navigator.mediaDevices.getUserMedia({ audio: { ...(preferences.inputDeviceId ? { deviceId: { exact: preferences.inputDeviceId } } : {}), autoGainControl: false, echoCancellation: true, noiseSuppression: true } });
        if (token !== generation) { capture.getTracks().forEach((track) => track.stop()); return; }
        stream = capture;
        const newProcessor = new VoiceAudioProcessor(() => preferences, (level, open) => {
          meter.style.setProperty("--audio-level", `${Math.max(0, Math.min(100, level + 100))}%`);
          meter.setAttribute("aria-valuenow", String(Math.round(level)));
          meter.dataset.open = String(open);
          testStatus.textContent = `${open ? "Audio passes" : "Audio gated"} · local test only`;
        });
        processor = newProcessor;
        await newProcessor.init({ kind: Track.Kind.Audio, track: capture.getAudioTracks()[0], audioContext: newContext });
        if (token !== generation) { await newProcessor.destroy(); return; }
        playback = document.createElement("audio");
        const newPlayback = playback;
        playback.srcObject = new MediaStream([newProcessor.processedTrack!]);
        playback.muted = !listen.checked;
        playback.volume = preferences.outputVolume / 100;
        if (preferences.outputDeviceId && "setSinkId" in newPlayback) await newPlayback.setSinkId(preferences.outputDeviceId);
        if (token !== generation) return;
        form.append(newPlayback);
        await newPlayback.play();
        await enumerate();
        if (token !== generation) return;
        testTimer = window.setTimeout(() => void stopTest(), 60_000);
      } catch (error) {
        if (token !== generation) return;
        await stopTest();
        testStatus.textContent = error instanceof Error ? error.message || error.name || "Mic test failed." : "Mic test failed.";
      }
    })();
  });

  const setHeld = (pressed: boolean) => { processor?.setPushToTalk(pressed); hold.setAttribute("aria-pressed", String(pressed)); };
  hold.addEventListener("pointerdown", (event) => { hold.setPointerCapture(event.pointerId); setHeld(true); });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) hold.addEventListener(name, () => setHeld(false));
  hold.addEventListener("keydown", (event) => { if (event.code === "Space" || event.code === "Enter") { event.preventDefault(); setHeld(true); } });
  hold.addEventListener("keyup", () => setHeld(false));
  listen.addEventListener("change", () => { if (playback) playback.muted = !listen.checked; });
  element<HTMLButtonElement>("audio-device-permission").addEventListener("click", () => {
    void (async () => {
      try {
        const capture = await navigator.mediaDevices.getUserMedia({ audio: true });
        capture.getTracks().forEach((track) => track.stop());
        await enumerate();
        saveStatus.textContent = "Device list refreshed. No audio was sent.";
      } catch { saveStatus.textContent = "Unable to access microphone devices. Check HTTPS and browser permissions."; }
    })();
  });
  window.addEventListener("pagehide", () => void stopTest());
  window.addEventListener("hashchange", () => { if (window.location.hash !== "#audio") void stopTest(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) void stopTest(); });
  navigator.mediaDevices?.addEventListener("devicechange", () => { void stopTest(); void enumerate().catch(() => undefined); });
  window.addEventListener("storage", (event) => {
    if (event.key !== voiceAudioStorageKey(userId)) return;
    preferences = loadVoiceAudioPreferences(userId);
    render();
    processor?.update();
    void enumerate().catch(() => undefined);
  });
  render();
  void enumerate().catch(() => { saveStatus.textContent = "Unable to enumerate audio devices."; });
}
