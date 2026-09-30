import { chromium } from "playwright";

const bundle = await Bun.build({ entrypoints: ["client/space-settings-layout.ts"], target: "browser" });
if (!bundle.success) throw new Error("Could not build settings fixture");
const js = `${await bundle.outputs[0].text()}\nsetupSpaceSettingsLists();`;
const html = (await Bun.file("client/server-settings.html").text()).replace("/server-settings.js", "/layout-fixture.js");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/layout-fixture.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  if (path === "/app.css") return new Response(Bun.file("public/app.css"), { headers: { "content-type": "text/css" } });
  return new Response(html, { headers: { "content-type": "text/html" } });
} });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
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
  console.log("Space settings checks passed: eight views at four widths, local filtering, and empty states.");
} finally { await browser.close(); server.stop(true); }
