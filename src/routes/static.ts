/**
 * Static client assets and the HTML shells.
 *
 * Everything here is served from the built `public/` directory. Each name is validated against a
 * conservative character set before it is joined to the directory, which is what keeps a crafted
 * path from escaping it. Fingerprinted bundles are cached immutably; the shells and the service
 * worker are revalidated, because the worker in particular must not be pinned to a stale build.
 */

import { Elysia } from "elysia";
import { respondError } from "../http/responses";
import { publicAssetFile, publicFile } from "../http/static-files";
import { adminPageResponse } from "../admin/pages";
import { serverVersionInfo } from "../server-version";

export const staticRoutes = new Elysia()
  .get("/v1/version", () => serverVersionInfo())
    .get("/", async () => {
      return await publicFile("index.html", "text/html; charset=utf-8")
         ?? serverVersionInfo();
    })
    .get("/register", async ({ set }) => {
      const file = await publicFile("register.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/app", async ({ set }) => {
      const file = await publicFile("chat.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/channels/:serverId/:channelId", async ({ set }) => {
      const file = await publicFile("chat.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/unlock", async ({ set }) => {
      const file = await publicFile("unlock.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/new", async ({ set }) => {
      const file = await publicFile("new.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/settings", async ({ set }) => {
      const file = await publicFile("settings.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-admin", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-admin.html", "moderation");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/operations", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-operations.html", "platform");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/users", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-users.html", "moderation");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/spaces", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-spaces.html", "platform");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/maintenance", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-maintenance.html", "platform");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/operators", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-operators.html", "operatorManagement");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin-theme-init.js", async ({ set }) => {
      const file = await publicFile("instance-admin-theme-init.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/livekit-e2ee-worker.mjs", async ({ set }) => {
      const file = await publicFile("livekit-e2ee-worker.mjs", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/voice-audio-worklet.js", async ({ set }) => {
      const file = await publicFile("voice-audio-worklet.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/auth.js", async ({ set }) => {
      const file = await publicFile("auth.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/register.js", async ({ set }) => {
      const file = await publicFile("register.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/unlock.js", async ({ set }) => {
      const file = await publicFile("unlock.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/main.js", async ({ set }) => {
      const file = await publicFile("main.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/new.js", async ({ set }) => {
      const file = await publicFile("new.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/settings.js", async ({ set }) => {
      const file = await publicFile("settings.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-admin.js", async ({ set }) => {
      const file = await publicFile("instance-admin.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-operations.js", async ({ set }) => {
      const file = await publicFile("instance-operations.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-users.js", async ({ set }) => {
      const file = await publicFile("instance-users.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-operators.js", async ({ set }) => {
      const file = await publicFile("instance-operators.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-spaces.js", async ({ set }) => {
      const file = await publicFile("instance-spaces.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-maintenance.js", async ({ set }) => {
      const file = await publicFile("instance-maintenance.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-admin-login.js", async ({ set }) => {
      const file = await publicFile("instance-admin-login.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/server-settings", async ({ set }) => {
      const file = await publicFile("server-settings.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/server-settings.js", async ({ set }) => {
      const file = await publicFile("server-settings.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/app.css", async ({ set }) => {
      const file = await publicFile("app.css", "text/css; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-admin.css", async ({ set }) => {
      const file = await publicFile("instance-admin.css", "text/css; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/chunks/:chunk", async ({ params, set }) => {
      if (!/^[A-Za-z0-9_-]+\.js(?:\.LEGAL\.txt)?$/.test(params.chunk)) return respondError(set, 404, "asset_not_found");
      const file = publicAssetFile(`chunks/${params.chunk}`);
      if (!file || !await file.exists()) return respondError(set, 404, "asset_not_found");
      return new Response(file, { headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": params.chunk.endsWith(".txt") ? "text/plain; charset=utf-8" : "text/javascript; charset=utf-8",
      } });
    })
    .get("/version.json", async ({ set }) => {
      const file = await publicFile("version.json", "application/json; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-cache";
      return file;
    })
    .get("/LICENSE", async ({ set }) => {
      const file = await publicFile("LICENSE", "text/plain; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/third-party-licenses.txt", async ({ set }) => {
      const file = await publicFile("third-party-licenses.txt", "text/plain; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/favicon.svg", async ({ set }) => {
      const file = await publicFile("favicon.svg", "image/svg+xml");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/push-sw.js", async ({ set }) => {
      const file = await publicFile("push-sw.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["service-worker-allowed"] = "/";
      set.headers["cache-control"] = "no-cache";
      return file;
    })
    .get("/assets/twemoji/:asset", async ({ params, set }) => {
      if (!/^[A-Za-z0-9_.-]+$/.test(params.asset) || !params.asset.endsWith(".svg") && params.asset !== "NOTICE.txt" && params.asset !== "LICENSE-GRAPHICS") {
        return respondError(set, 404, "asset_not_found");
      }
      const file = publicAssetFile(`assets/twemoji/${params.asset}`);
      if (!file || !(await file.exists())) return respondError(set, 404, "asset_not_found");
      return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable", "content-type": params.asset.endsWith(".svg") ? "image/svg+xml" : "text/plain; charset=utf-8" } });
    })
    .get("/assets/:asset", async ({ params, set }) => {
      if (params.asset === "." || params.asset === ".." || !/^[A-Za-z0-9_.-]+$/.test(params.asset)) {
        return respondError(set, 404, "asset_not_found");
      }
      const file = publicAssetFile(`assets/${params.asset}`);
      if (!file || !(await file.exists())) return respondError(set, 404, "asset_not_found");
      const contentType = params.asset.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
      return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable", "content-type": contentType } });
    });
