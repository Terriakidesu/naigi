import { chromium } from "playwright";

const build = await Bun.build({ entrypoints: ["client/create-room-dialog.ts"], target: "browser" });
if (!build.success) throw new Error("Could not build room dialog fixture");
const js = `${await build.outputs[0].text()}
window.createdRoom = null;
window.failCreate = false;
document.querySelector('button').addEventListener('click', () => showCreateRoomDialog({
  spaceName: 'Space 1', categories: [{id: 'group', name: 'Gaming'}], initialCategoryId: 'group',
  create: async (room) => { if (window.failCreate) throw new Error('Permission denied'); window.createdRoom = room; },
  error: (error) => error.message
}));`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  if (path === "/app.css") return new Response(Bun.file("public/app.css"), { headers: { "content-type": "text/css" } });
  return new Response('<link rel="stylesheet" href="/app.css"><button>New room</button><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
} });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.getByRole("button", { name: "New room" }).click();
  if (await page.getByLabel("Category", { exact: true }).inputValue() !== "group") throw new Error("Context category not preselected");
  await page.getByRole("radio", { name: /Voice/ }).check();
  await page.getByLabel("Room name", { exact: true }).fill("  Lounge  ");
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  const voice = await page.evaluate(() => (window as any).createdRoom);
  if (voice.name !== "Lounge" || voice.kind !== "voice" || voice.categoryId !== "group") throw new Error("Voice room submission is incorrect");
  await page.getByRole("button", { name: "New room" }).click();
  await page.getByLabel("Room name", { exact: true }).fill("general");
  await page.getByLabel("Category", { exact: true }).selectOption("");
  await page.evaluate(() => { (window as any).failCreate = true; });
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await page.getByText("Permission denied", { exact: true }).waitFor();
  if (await page.getByLabel("Room name", { exact: true }).inputValue() !== "general") throw new Error("Creation error lost the name");
  await page.evaluate(() => { (window as any).failCreate = false; });
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  const text = await page.evaluate(() => (window as any).createdRoom);
  if (text.kind !== "text" || text.categoryId !== null) throw new Error("Text room defaults are incorrect");
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole("button", { name: "New room" }).click();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Dialog overflows mobile viewport");
  await page.keyboard.press("Escape");
  if (await page.locator("dialog").count()) throw new Error("Escape did not close room creation");
  console.log("Room creation checks passed: text/voice, category preselection, normalized names, retry, Escape, and mobile fit.");
} finally { await browser.close(); server.stop(true); }
