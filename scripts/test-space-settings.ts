import { chromium } from "playwright";
import { defaultAppPreferences } from "../client/app-preferences";

const bundle = await Bun.build({ entrypoints: ["client/space-settings-layout.ts"], target: "browser" });
if (!bundle.success) throw new Error("Could not build settings fixture");
const js = `${await bundle.outputs[0].text()}\nsetupSpaceSettingsLists();`;
const html = (await Bun.file("client/server-settings.html").text()).replace("/server-settings.js", "/layout-fixture.js");
const themeHtml = await Bun.file("client/server-settings.html").text();
const userId = "11111111-1111-4111-8111-111111111111";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/theme-fixture") return new Response(themeHtml, { headers: { "content-type": "text/html" } });
  if (path === "/server-settings.js") return new Response(Bun.file("public/server-settings.js"), { headers: { "content-type": "text/javascript" } });
  if (path === "/v1/me") return Response.json({ user: { id: userId, username: "fixture", displayName: "Fixture", createdAt: "2026-01-01T00:00:00Z", avatarUrl: null, bannerUrl: null } });
  // Keep the real settings module on this page without initializing a crypto account.
  if (path === "/unlock") return new Response(null, { status: 204 });
  if (path.startsWith("/v1/")) return Response.json({ error: "fixture_no_crypto" }, { status: 403 });
  if (path === "/layout-fixture.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  if (path === "/app.css") return new Response(Bun.file("public/app.css"), { headers: { "content-type": "text/css" } });
  return new Response(html, { headers: { "content-type": "text/html" } });
} });
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.waitForSelector(".space-list-toolbar", { state: "attached" });
  await page.evaluate(() => {
    for (const id of ["category-settings-list", "channel-settings-list", "member-settings-list", "audit-log-list"]) {
      const list = document.getElementById(id)!;
      for (const name of ["General", "Design", "Engineering"]) {
        const row = document.createElement("div");
        row.className = "settings-list-row";
        const copy = document.createElement("div");
        copy.className = "settings-row-copy";
        copy.textContent = name;
        row.append(copy);
        if (id === "channel-settings-list") {
          const input = document.createElement("input");
          input.value = name;
          const select = document.createElement("select");
          select.add(new Option("Project team", "team"));
          row.append(input, select);
        }
        for (const action of ["Save", "Delete"]) {
          const button = document.createElement("button");
          button.textContent = action;
          row.append(button);
        }
        list.append(row);
      }
    }
  });
  for (const width of [1440, 1024, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ["overview", "rooms", "access", "members", "moderation", "invites", "emoji", "audit"]) {
      await page.evaluate((id) => {
        for (const section of document.querySelectorAll<HTMLElement>("[data-settings-view]")) section.hidden = section.id !== id;
      }, view);
      const overflow = await page.evaluate(() => {
        const content = document.querySelector(".server-settings-main-content")!;
        return content.scrollWidth > content.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth;
      });
      if (overflow) throw new Error(`${view} overflows at ${width}px`);
    }
  }
  await page.getByRole("searchbox", { name: "Filter activity" }).fill("Engineering");
  if (await page.locator("#audit-log-list > :visible").count() !== 1) throw new Error("List search did not filter rows");
  await page.getByRole("searchbox", { name: "Filter activity" }).fill("missing");
  if (!await page.getByText("No matching results.", { exact: true }).last().isVisible()) throw new Error("Missing search empty state");
  await page.evaluate(({ userId, preferences }) => {
    localStorage.setItem(`priv-chat.app-preferences.${userId}`, JSON.stringify(preferences));
  }, { userId, preferences: { ...defaultAppPreferences, theme: "black", themePreset: "black", accent: "#2255cc", scale: 1.2 } });
  await page.goto(`http://127.0.0.1:${server.port}/theme-fixture?server=${userId}`);
  await page.waitForFunction(() => document.documentElement.dataset.appTheme === "black");
  const applied = await page.evaluate(() => ({
    theme: document.querySelector<HTMLElement>("#server-settings-layout")?.dataset.appTheme,
    scale: document.documentElement.style.getPropertyValue("--app-scale"),
    accent: document.documentElement.style.getPropertyValue("--accent"),
  }));
  if (applied.theme !== "black" || applied.scale !== "1.2" || applied.accent !== "#2255cc") throw new Error(`Space settings did not apply saved preferences: ${JSON.stringify(applied)}`);
  const otherTab = await page.context().newPage();
  await otherTab.goto(`http://127.0.0.1:${server.port}`);
  await otherTab.evaluate(({ userId, preferences }) => {
    localStorage.setItem(`priv-chat.app-preferences.${userId}`, JSON.stringify(preferences));
  }, { userId, preferences: { ...defaultAppPreferences, theme: "light", themePreset: "light" } });
  await page.waitForFunction(() => document.documentElement.dataset.appTheme === "light");
  await otherTab.close();
  console.log("Space settings checks passed: responsive views, filtering, saved theme/accent/scale, and cross-tab theme updates.");
} finally { await browser.close(); server.stop(true); }
