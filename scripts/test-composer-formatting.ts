import assert from "node:assert/strict";
import { chromium } from "playwright";

const build = await Bun.build({ entrypoints: ["client/composer-format-toolbar.ts"], target: "browser" });
if (!build.success) throw new Error(build.logs.map(String).join("\n"));
const js = `${await build.outputs[0].text()}\nsetupComposerFormatToolbar(document.querySelector('textarea'));`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  if (path === "/app.css") return new Response(Bun.file("public/app.css"), { headers: { "content-type": "text/css" } });
  return new Response('<link rel="stylesheet" href="/app.css"><div style="height:200px"></div><form class="composer"><div class="composer-box"><textarea maxlength="100" aria-label="Message"></textarea></div></form><button id="outside">Outside</button><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
} });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}`);
  const input = page.getByRole("textbox", { name: "Message" });
  const toolbar = page.getByRole("toolbar", { name: "Format selected text" });
  await page.waitForSelector(".composer-format-toolbar", { state: "attached" });
  let changes = 0;
  await page.exposeFunction("draftChanged", () => { changes += 1; });
  await input.evaluate((element) => element.addEventListener("input", () => { void (window as any).draftChanged(); }));
  await input.fill("hello world");
  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(6, 11));
  await toolbar.waitFor({ state: "visible" });
  assert.equal(await toolbar.locator("svg").count(), 4, "Toolbar uses icons");
  await toolbar.getByRole("button", { name: "Bold (Ctrl+B)", exact: true }).click();
  assert.equal(await input.inputValue(), "hello **world**");
  await page.keyboard.press("Control+b");
  assert.equal(await input.inputValue(), "hello world", "Shortcut toggles formatting");
  await page.keyboard.press("Control+i");
  assert.equal(await input.inputValue(), "hello _world_");
  await page.keyboard.press("Control+z");
  assert.equal(await input.inputValue(), "hello world", "Formatting participates in native undo");
  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(6, 11));
  await page.keyboard.press("Control+Shift+x");
  assert.equal(await input.inputValue(), "hello ~~world~~");
  await page.keyboard.press("Control+Shift+x");
  await page.keyboard.press("Control+Shift+s");
  assert.equal(await input.inputValue(), "hello ||world||");
  await page.keyboard.press("Escape");
  assert.equal(await toolbar.isVisible(), false);
  await input.fill("plain");
  await page.keyboard.press("End");
  await page.keyboard.press("Control+b");
  assert.equal(await input.inputValue(), "plain****");
  assert.equal(await input.evaluate((element) => (element as HTMLTextAreaElement).selectionStart), 7);
  await input.fill("a".repeat(100));
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+b");
  assert.equal((await input.inputValue()).length, 100, "Formatting respects maxlength");
  await page.locator("#outside").click();
  assert.equal(await toolbar.isVisible(), false);
  for (const width of [390, 1024]) {
    await page.setViewportSize({ width, height: 600 });
    await input.fill("mobile selection");
    await page.keyboard.press("Control+a");
    await toolbar.waitFor({ state: "visible" });
    const bounds = await toolbar.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, "Toolbar fits viewport");
  }
  await input.evaluate((element) => { (element as HTMLTextAreaElement).disabled = true; });
  await toolbar.waitFor({ state: "hidden" });
  assert.ok(changes >= 8, "Formatting updates draft/input listeners");
  console.log("Composer formatting checks passed: icon toolbar, toggles, shortcuts, cursor, undo, draft events, maxlength, dismissal, and mobile fit.");
} finally { await browser.close(); server.stop(true); }
