import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { createApp } from "./app";

const publicRoot = `${import.meta.dir}/../public`;
const built = await Bun.file(`${publicRoot}/version.json`).exists();

test.skipIf(!built)("shared web bundles, licenses, and isolated admin styles are served", async () => {
  const app = createApp();
  const paths = ["/main.js", "/settings.js", "/app.css", "/instance-admin.css", "/instance-admin.js",
    "/version.json", "/LICENSE", "/third-party-licenses.txt", "/assets/twemoji/LICENSE-GRAPHICS",
    "/assets/matrix_sdk_crypto_wasm_bg.wasm", "/livekit-e2ee-worker.mjs", "/voice-audio-worklet.js"];
  const chunks = (await readdir(`${publicRoot}/chunks`)).filter((name) => name.endsWith(".js"));
  expect(chunks.length).toBeGreaterThan(0);
  paths.push(...chunks.map((name) => `/chunks/${name}`));
  for (const path of paths) {
    const response = await app.handle(new Request(`http://localhost${path}`));
    expect(response.status, path).toBe(200);
    if (path.endsWith(".js")) expect(response.headers.get("content-type"), path).toContain("text/javascript");
  }
  const metadata = await Bun.file(`${publicRoot}/version.json`).json();
  expect(metadata).toMatchObject({ name: "naigi-frontend", target: "web" });
  expect(await Bun.file(`${publicRoot}/settings.html`).text()).not.toContain('src="/desktop.js"');
  const admin = await Bun.file(`${publicRoot}/instance-admin.html`).text();
  expect(admin).toContain('href="/instance-admin.css"');
  expect(admin).not.toContain('href="/app.css"');
  expect((await app.handle(new Request("http://localhost/chunks/not-a-script.txt"))).status).toBe(404);
});
