import { chromium } from "playwright";

const result = await Bun.build({ entrypoints: ["scripts/fixtures/voice-audio-browser.ts"], target: "browser" });
if (!result.success) throw new Error(result.logs.map(String).join("\n"));
const fixture = await result.outputs[0].text();
const html = (await Bun.file("client/settings.html").text()).replace("/settings.js", "/voice-audio-test.js");
const chatFixture = (await Bun.file("client/chat.html").text()).replace(/<script[\s\S]*?<\/script>/g, "");
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/voice-controls-fixture") return new Response(chatFixture, { headers: { "Content-Type": "text/html" } });
    if (path === "/voice-audio-test.js") return new Response(fixture, { headers: { "Content-Type": "text/javascript" } });
    if (path === "/voice-audio-worklet.js") return new Response(Bun.file("public/voice-audio-worklet.js"), { headers: { "Content-Type": "text/javascript" } });
    if (path === "/app.css") return new Response(Bun.file("public/app.css"), { headers: { "Content-Type": "text/css" } });
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  },
});
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const errors: string[] = [];
let stage = "load";
try {
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/#audio`);
  await page.waitForFunction(() => "voiceAudioTest" in window);
  const measurements = await page.evaluate(async () => (window as any).voiceAudioTest.exerciseProcessor()) as Record<string, number | boolean>;
  const nearSilence = ["closed", "released", "blurred", "whileTyping", "quiet", "quietAgain", "zeroGain"];
  for (const field of nearSilence) if (Number(measurements[field]) > 0.00001) throw new Error(`${field} leaked audio: ${measurements[field]}`);
  if (Number(measurements.normal) < 0.5 || Number(measurements.held) < 0.2 || Number(measurements.shortcut) < 0.2 || Number(measurements.loud) < 0.2) throw new Error("Open audio gate did not pass audio");
  const ratio = Number(measurements.half) / Number(measurements.normal);
  if (ratio < 0.45 || ratio > 0.55) throw new Error(`Input gain ratio was ${ratio}`);
  if (!measurements.ended) throw new Error("Processed track was not stopped");
  stage = "publication";
  const publication = await page.evaluate(async () => (window as any).voiceAudioTest.exercisePublication());
  if (!publication.processedBeforePublication || !publication.processorSurvivedDeviceRestart || publication.closedEnergy > 0.00001 || publication.mutedEnergy > 0.00001 || publication.mutedEnergyAfterRestart > 0.00001) throw new Error(`Microphone publication safety check failed: ${JSON.stringify(publication)}`);
  await page.locator("#audio-input-mode").selectOption("push-to-talk");
  stage = "mic test";
  await page.locator("#audio-ptt-key").click();
  await page.keyboard.press("v");
  const preferences = await page.evaluate(() => JSON.parse(localStorage.getItem(`priv-chat.voice-audio.${(window as any).voiceAudioTest.userId}`) ?? "null"));
  if (preferences.mode !== "push-to-talk" || preferences.pushToTalkKey !== "KeyV") throw new Error("PTT preferences did not save");
  await page.locator("#audio-mic-test").click();
  await page.waitForFunction(() => document.querySelector("#audio-test-status")?.textContent?.includes("local test only"));
  await page.locator("#audio-mic-test").click();
  await page.waitForFunction(() => document.querySelector("#audio-test-status")?.textContent === "Mic test stopped.");
  if (await page.locator("#voice-audio-form audio").count()) throw new Error("Mic-test playback element remained after stop");
  await page.locator("#audio-device-permission").click();
  stage = "device permission";
  await page.waitForFunction(() => document.querySelector("#audio-save-status")?.textContent === "Device list refreshed. No audio was sent.");
  const inputDevices = await page.locator("#audio-default-input option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  const chosenDevice = inputDevices.find((id) => id !== "");
  if (!chosenDevice) throw new Error("No fake microphone enumerated");
  await page.locator("#audio-default-input").selectOption(chosenDevice);
  await page.reload();
  stage = "reload";
  await page.waitForFunction(() => "voiceAudioTest" in window);
  if (await page.locator("#audio-default-input").inputValue() !== chosenDevice) throw new Error("Default microphone did not survive reload");
  if (await page.locator("#audio-ptt-key").textContent() !== "V") throw new Error("PTT shortcut did not survive reload");
  // Stop during asynchronous capture/setup must not leave a test stream behind.
  stage = "cancel pending mic test";
  await page.locator("#audio-mic-test").evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelector("#audio-test-status")?.textContent === "Mic test stopped.");
  if (await page.locator("#voice-audio-form audio").count()) throw new Error("Cancelled mic test left playback behind");
  stage = "cancel pending permission/capture";
  await page.locator("#audio-default-input").selectOption("");
  await page.evaluate(() => {
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    const pending: { capture?: MediaStream; deliver?: () => void; restore: () => void } = { restore: () => { media.getUserMedia = original; } };
    media.getUserMedia = async (constraints) => {
      const capture = await original(constraints);
      return new Promise<MediaStream>((resolve) => {
        pending.capture = capture;
        pending.deliver = () => resolve(capture);
      });
    };
    Object.assign(window, { pendingVoiceCapture: pending });
  });
  await page.locator("#audio-mic-test").click();
  await page.waitForFunction(() => Boolean((window as any).pendingVoiceCapture.deliver));
  await page.locator("#audio-mic-test").click();
  await page.evaluate(() => {
    (window as any).pendingVoiceCapture.restore();
    (window as any).pendingVoiceCapture.deliver();
  });
  await page.waitForFunction(() => (window as any).pendingVoiceCapture.capture.getTracks().every((track: MediaStreamTrack) => track.readyState === "ended"));
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error(`Audio settings overflow at ${width}px`);
  }
  stage = "device picker and settings hit targets";
  const controls = await browser.newPage();
  await controls.goto(`http://127.0.0.1:${server.port}/voice-controls-fixture`);
  await controls.locator("#sidebar-voice-output-device").evaluate((select: HTMLSelectElement) => {
    select.add(new Option("Speakers (2- Realtek(R) Audio) — a long device label", "speakers"));
  });
  for (const width of [1280, 800, 390]) {
    await controls.setViewportSize({ width, height: 900 });
    const targets = await controls.evaluate(() => {
      const picker = document.querySelector("#sidebar-voice-output-device") as HTMLSelectElement;
      const label = picker.closest(".voice-device-picker")!.getBoundingClientRect();
      const rect = picker.getBoundingClientRect();
      const gear = document.querySelector(".sidebar-user > a")!;
      const settings = gear.getBoundingClientRect();
      return { contained: rect.right <= label.right + 0.5 && rect.left >= label.left - 0.5, gearClickable: gear.contains(document.elementFromPoint(settings.x + settings.width / 2, settings.y + settings.height / 2)) };
    });
    if (!targets.contained || !targets.gearClickable) throw new Error(`Device dropdown overlaps settings at ${width}px: ${JSON.stringify(targets)}`);
  }
  await controls.locator("#sidebar-voice-output-device").click();
  await controls.keyboard.press("ArrowDown");
  await controls.keyboard.press("Enter");
  const popupPromise = controls.waitForEvent("popup");
  await controls.locator(".sidebar-user > a").click();
  const settingsTab = await popupPromise;
  await settingsTab.waitForLoadState();
  if (!settingsTab.url().endsWith("/settings#audio")) throw new Error("Settings gear did not open audio settings");
  await settingsTab.close();
  await controls.close();
  if (errors.length) throw new Error(errors.join("\n"));
  if (process.env.VOICE_AUDIO_SCREENSHOT) {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.locator("#audio").screenshot({ path: process.env.VOICE_AUDIO_SCREENSHOT });
  }
  console.log("Voice audio browser checks passed: gain, PTT, mute precedence, pre-publication gating, device restart, silence threshold, mic-test cleanup, saved defaults, and responsive controls.");
} catch (error) {
  console.error("Voice audio test state:", stage, await page.evaluate(() => ({ test: document.querySelector("#audio-test-status")?.textContent, save: document.querySelector("#audio-save-status")?.textContent, button: document.querySelector("#audio-mic-test")?.textContent })), errors);
  throw error;
} finally {
  await browser.close();
  server.stop(true);
}
