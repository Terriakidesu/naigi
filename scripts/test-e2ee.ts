import assert from "node:assert/strict";
import { SQL } from "bun";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { chromium, type Dialog, type Page } from "playwright";

// I have nothing but my burger and I want nothing more
// Use the real HTTP, PostgreSQL, Redis, WASM and IndexedDB paths. A mock key
// directory cannot catch JSONB serialization breaking signed Matrix keys.
const admin = new SQL(Bun.env.DATABASE_URL ?? "postgres://localhost:5432/priv_chat");
const schema = `e2ee_test_${crypto.randomUUID().replaceAll("-", "")}`;
await admin.unsafe(`create schema ${schema}`);
const databaseUrl = new URL(Bun.env.DATABASE_URL ?? "postgres://localhost:5432/priv_chat");
databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
Bun.env.DATABASE_URL = databaseUrl.toString();
Bun.env.NODE_ENV = "test";
Bun.env.KLIPY_API_KEY = "e2ee-klipy-public-key";

const { closeDatabase } = await import("../src/db/client");
const { closeRedis } = await import("../src/redis/client");
const { migrate } = await import("../src/db/migrate");
const { createApp } = await import("../src/app");
const browser = await chromium.launch({ headless: true });
const app = createApp();
const errors: string[] = [];

try {
  await migrate();
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${app.server!.port}`;
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const a = await alice.newPage();
  const b = await bob.newPage();
  async function request(page: Page, path: string, data?: object, method = data ? "POST" : "GET") {
    return page.evaluate(async ({ path, data }) => {
      const response = await fetch(path, {
        method: data?.method ?? "GET", credentials: "include",
        headers: { "content-type": "application/json" },
        body: data?.body ? JSON.stringify(data.body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    }, { path, data: { method, body: data } });
  }
  async function binaryRequest(page: Page, path: string, bytes: Uint8Array, contentType: string, method = "PUT") {
    return page.evaluate(async ({ path, bytes, contentType, method }) => {
      const init: RequestInit = {
        method,
        credentials: "include",
        headers: { "content-type": contentType },
      };
      if (method !== "GET" && method !== "HEAD") init.body = new Uint8Array(bytes);
      const response = await fetch(path, init);
      return { status: response.status, body: [...new Uint8Array(await response.arrayBuffer())] };
    }, { path, bytes: [...bytes], contentType, method });
  }
  const users: Array<{ id: string; username: string }> = [];
  for (const [page, name] of [[a, "alice"], [b, "bob"]] as const) {
    await page.goto(origin);
    const response = await request(page, "/v1/auth/register", {
      username: `e2ee_${name}`, password: "Account-password-for-e2ee-test!", displayName: name,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    users.push(response.body.user);
  }

  const rejectedTwitterPreview = await request(a, "/v1/previews/twitter", { url: "https://example.com/status/1234567890" });
  assert.equal(rejectedTwitterPreview.status, 400, JSON.stringify(rejectedTwitterPreview.body));

  const onePixelPng = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
    0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99,
    0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  function animatedGif() {
    const gif = GIFEncoder();
    for (const color of [[238, 120, 130, 255], [120, 180, 160, 255]]) {
      const data = new Uint8ClampedArray(4 * 4 * 4);
      for (let index = 0; index < data.length; index += 4) data.set(color, index);
      const palette = quantize(data, 256);
      gif.writeFrame(applyPalette(data, palette), 4, 4, { palette, delay: 100, repeat: 0 });
    }
    gif.finish();
    const bytes = gif.bytes();
    const output = new Uint8Array(bytes.byteLength);
    output.set(bytes);
    return output;
  }

  const klipyPreviewUrl = "https://static.klipy.com/ii/e2ee/preview.gif";
  const klipyMediaUrl = "https://static.klipy.com/ii/e2ee/full.gif";
  const klipySearchPayload = JSON.stringify({
    result: true,
    data: { data: [{
      id: "e2ee-wave",
      slug: "test-wave",
      title: "Test wave",
      file: {
        xs: { gif: { url: klipyPreviewUrl, size: animatedGif().byteLength } },
        md: { gif: { url: klipyMediaUrl, size: animatedGif().byteLength } },
      },
    }] },
  });
  const klipyItemPayload = JSON.stringify({
    result: true,
    data: { data: [{
      id: "e2ee-wave",
      slug: "test-wave",
      title: "Test wave",
      file: {
        xs: { gif: { url: klipyPreviewUrl, size: animatedGif().byteLength } },
        md: { gif: { url: klipyMediaUrl, size: animatedGif().byteLength } },
      },
    }] },
  });
  for (const context of [alice, bob]) {
    await context.route("https://tenor.com/uzlAQImG5tJ.gif", (route) => route.fulfill({
      contentType: "image/gif",
      body: Buffer.from(animatedGif()),
    }));
    await context.route("https://tenor.com/e2ee-missing.gif", (route) => route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "Not found",
    }));
    await context.route("https://media.example.test/**", (route) => route.fulfill({
      contentType: "image/png",
      body: Buffer.from(onePixelPng),
    }));
    await context.route("https://media-fail.example.test/**", (route) => route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "Not found",
    }));
    await context.route("https://api.klipy.com/api/v1/**", (route) => route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: route.request().url().includes("/gifs/items") ? klipyItemPayload : klipySearchPayload,
    }));
    await context.route("https://static.klipy.com/ii/e2ee/**", (route) => route.fulfill({
      contentType: "image/gif",
      headers: { "access-control-allow-origin": "*" },
      body: Buffer.from(animatedGif()),
    }));
  }

  await a.goto(`${origin}/settings`);
  await a.locator("#profile-image-input").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: Buffer.from(onePixelPng) });
  const editor = a.locator(".profile-image-editor");
  await editor.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await editor.locator("input[type=range]").isVisible(), true);
  assert.equal(await editor.locator("select").isVisible(), true);
  const pngUpload = a.waitForResponse((response) => response.url().endsWith("/v1/me/avatar") && response.request().method() === "PUT" && response.status() === 200);
  await a.getByRole("button", { name: "Use this image", exact: true }).click();
  await pngUpload;
  await a.locator("#settings-status").filter({ hasText: "Profile image updated." }).waitFor({ timeout: 20_000 });
  await a.locator("#settings-avatar img").waitFor({ timeout: 20_000 });
  assert.equal(await a.locator("#settings-avatar").evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
  const avatarUpload = await request(a, `/v1/me?check=${Date.now()}`);
  assert.equal(avatarUpload.status, 200, JSON.stringify(avatarUpload.body));
  assert.match(avatarUpload.body.user.avatarUrl, /^\/v1\/users\/[0-9a-f-]+\/avatar\?/);
  const avatarFetch = await a.evaluate(async (path) => {
    const response = await fetch(path, { credentials: "include" });
    return { status: response.status, contentType: response.headers.get("content-type") };
  }, avatarUpload.body.user.avatarUrl);
  assert.deepEqual(avatarFetch, { status: 200, contentType: "image/png" });
  await a.locator("#profile-image-input").setInputFiles({ name: "animated.gif", mimeType: "image/gif", buffer: Buffer.from(animatedGif()) });
  await editor.waitFor({ state: "visible", timeout: 20_000 });
  const gifUpload = a.waitForResponse((response) => response.url().endsWith("/v1/me/avatar") && response.request().method() === "PUT" && response.status() === 200);
  await a.getByRole("button", { name: "Use this image", exact: true }).click();
  await gifUpload;
  await a.locator("#settings-status").filter({ hasText: "Profile image updated." }).waitFor({ timeout: 20_000 });
  await a.locator("#settings-avatar img").waitFor({ timeout: 20_000 });
  const animatedAvatar = await request(a, `/v1/me?check=${Date.now()}`);
  const animatedFetch = await a.evaluate(async (path) => {
    const response = await fetch(path, { credentials: "include" });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, contentType: response.headers.get("content-type"), frames: bytes.filter((byte) => byte === 0x2c).length };
  }, animatedAvatar.body.user.avatarUrl);
  assert.equal(animatedFetch.status, 200);
  assert.equal(animatedFetch.contentType, "image/gif");
  assert.ok(animatedFetch.frames >= 2, "edited GIF should retain animation frames");
  const oversizedAvatar = await a.evaluate(async () => {
    const response = await fetch("/v1/me/avatar", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(5 * 1024 * 1024 + 1),
    });
    return response.status;
  });
  assert.equal(oversizedAvatar, 413);

  const createdServer = await request(a, "/v1/servers", {});
  assert.equal(createdServer.status, 201, JSON.stringify(createdServer.body));
  assert.equal(createdServer.body.server.landingChannelId, createdServer.body.channel.id);
  const bannerUpload = await binaryRequest(a, "/v1/me/banner", onePixelPng, "image/png");
  assert.equal(bannerUpload.status, 200);
  const bannerProfile = await request(a, "/v1/me");
  assert.match(bannerProfile.body.user.bannerUrl, /^\/v1\/users\/[0-9a-f-]+\/banner\?/);
  const bannerFetch = await binaryRequest(a, bannerProfile.body.user.bannerUrl, new Uint8Array(), "application/octet-stream", "GET");
  assert.equal(bannerFetch.status, 200);
  const independentRouting = await request(a, `/v1/servers/${createdServer.body.server.id}`, {
    onboardingChannelId: null,
    landingChannelId: createdServer.body.channel.id,
  }, "PATCH");
  assert.equal(independentRouting.status, 200, JSON.stringify(independentRouting.body));
  assert.equal(independentRouting.body.server.onboardingChannelId, null);
  assert.equal(independentRouting.body.server.landingChannelId, createdServer.body.channel.id);
  const metadataOnlyUpdate = await request(a, `/v1/servers/${createdServer.body.server.id}`, { encryptedMetadata: "AQI" }, "PATCH");
  assert.equal(metadataOnlyUpdate.status, 200, JSON.stringify(metadataOnlyUpdate.body));
  assert.equal(metadataOnlyUpdate.body.server.onboardingChannelId, null);
  assert.equal(metadataOnlyUpdate.body.server.landingChannelId, createdServer.body.channel.id);
  const brandingUpload = await binaryRequest(a, `/v1/servers/${createdServer.body.server.id}/branding/icon`, onePixelPng, "image/png");
  assert.equal(brandingUpload.status, 200);
  const brandedServer = await request(a, `/v1/servers/${createdServer.body.server.id}`);
  assert.match(brandedServer.body.server.iconUrl, /^\/v1\/servers\/[0-9a-f-]+\/branding\/icon\?/);
  const emoji = await request(a, `/v1/servers/${createdServer.body.server.id}/emojis`, {
    encryptedMetadata: "AQI",
    expectedSizeBytes: 3,
  });
  assert.equal(emoji.status, 201, JSON.stringify(emoji.body));
  const emojiBytes = Uint8Array.from([7, 8, 9]);
  const emojiUpload = await binaryRequest(a, `/v1/servers/${createdServer.body.server.id}/emojis/${emoji.body.emoji.id}/file`, emojiBytes, "application/octet-stream");
  assert.equal(emojiUpload.status, 200);
  const emojiFile = await binaryRequest(a, `/v1/servers/${createdServer.body.server.id}/emojis/${emoji.body.emoji.id}/file`, new Uint8Array(), "application/octet-stream", "GET");
  assert.deepEqual(emojiFile.body, [...emojiBytes]);
  const pendingEmoji = await request(a, `/v1/servers/${createdServer.body.server.id}/emojis`, {
    encryptedMetadata: "AQI",
    expectedSizeBytes: 4,
  });
  assert.equal(pendingEmoji.status, 201, JSON.stringify(pendingEmoji.body));
  const rejectedEmojiUpload = await binaryRequest(a, `/v1/servers/${createdServer.body.server.id}/emojis/${pendingEmoji.body.emoji.id}/file`, emojiBytes, "application/octet-stream");
  assert.equal(rejectedEmojiUpload.status, 400);
  const pendingEmojiFile = await binaryRequest(a, `/v1/servers/${createdServer.body.server.id}/emojis/${pendingEmoji.body.emoji.id}/file`, new Uint8Array(), "application/octet-stream", "GET");
  assert.equal(pendingEmojiFile.status, 404);
  const deletedPendingEmoji = await request(a, `/v1/servers/${createdServer.body.server.id}/emojis/${pendingEmoji.body.emoji.id}`, undefined, "DELETE");
  assert.equal(deletedPendingEmoji.status, 200, JSON.stringify(deletedPendingEmoji.body));
  const unauthorizedEmoji = await request(b, `/v1/servers/${createdServer.body.server.id}/emojis`, undefined, "GET");
  assert.equal(unauthorizedEmoji.status, 403, JSON.stringify(unauthorizedEmoji.body));
  const unauthorizedAudit = await request(b, `/v1/servers/${createdServer.body.server.id}/audit-logs`);
  assert.equal(unauthorizedAudit.status, 403, JSON.stringify(unauthorizedAudit.body));
  const audit = await request(a, `/v1/servers/${createdServer.body.server.id}/audit-logs`);
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  assert.ok(audit.body.logs.some((log: { action: string }) => log.action === "custom_emoji.uploaded"));
  const invite = await request(a, `/v1/servers/${createdServer.body.server.id}/invites`, { maxUses: 1 });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const joined = await request(b, `/v1/invites/${encodeURIComponent(invite.body.invite.token)}/accept`, {});
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const leftServer = await request(b, `/v1/servers/${createdServer.body.server.id}/leave`, {});
  assert.equal(leftServer.status, 200, JSON.stringify(leftServer.body));
  const blockedConversation = await request(a, "/v1/conversations", {
    kind: "dm", memberUserIds: [users[1].id],
  });
  assert.equal(blockedConversation.status, 403, JSON.stringify(blockedConversation.body));
  const secondInvite = await request(a, `/v1/servers/${createdServer.body.server.id}/invites`, { maxUses: 1 });
  assert.equal(secondInvite.status, 201, JSON.stringify(secondInvite.body));
  const listedInvites = await request(a, `/v1/servers/${createdServer.body.server.id}/invites`);
  assert.equal(listedInvites.status, 200, JSON.stringify(listedInvites.body));
  assert.equal(listedInvites.body.invites.filter((item: { revokedAt: string | null }) => !item.revokedAt).length, 1);
  const rejoined = await request(b, `/v1/invites/${encodeURIComponent(secondInvite.body.invite.token)}/accept`, {});
  assert.equal(rejoined.status, 200, JSON.stringify(rejoined.body));

  await unlock(a, "/app");
  await unlock(b, "/app");
  await a.goto(`${origin}/settings#recovery`);
  await a.locator("#recovery").waitFor({ state: "visible", timeout: 20_000 });
  await a.locator("#recovery-local-passphrase").fill("Independent-local-vault-passphrase!");
  await a.locator("#recovery-export-passphrase").fill("Recovery-passphrase-for-e2e-test!");
  await a.locator("#recovery-export-confirm").fill("Recovery-passphrase-for-e2e-test!");
  const recoveryDownloadPromise = a.waitForEvent("download");
  await a.locator("#export-recovery-button").click();
  const recoveryDownload = await recoveryDownloadPromise;
  const recoveryPath = await recoveryDownload.path();
  assert.ok(recoveryPath, "recovery backup should be downloadable");
  await a.locator("#settings-status").filter({ hasText: "Encrypted recovery backup downloaded." }).waitFor({ timeout: 20_000 });
  await a.locator("#recovery-file").setInputFiles(recoveryPath);
  await a.locator("#recovery-import-passphrase").fill("Recovery-passphrase-for-e2e-test!");
  await a.locator("#import-recovery-button").click();
  await a.locator("#settings-status").filter({ hasText: "Imported " }).waitFor({ timeout: 20_000 });
  await recoveryDownload.delete();
  await a.goto(`${origin}/app`);
  await a.locator("#status-line").filter({ hasText: "Connected" }).waitFor({ timeout: 20_000 });
  await recoverAfterDeviceIdLoss(a, users[0].id);
  await b.locator("#home-rail-button").click();

  const created = await request(a, "/v1/conversations", {
    kind: "dm", memberUserIds: [users[1].id],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const room = created.body.conversation.id;
  const duplicate = await request(a, "/v1/conversations", {
    kind: "dm", memberUserIds: [users[1].id],
  });
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.conversation.id, room);
  await a.goto(`${origin}/channels/@me/${room}`);
  await a.locator("#status-line").filter({ hasText: "Connected" }).waitFor({ timeout: 20_000 });

  async function unlock(page: Page, path: string) {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400 && response.url().includes("/v1/crypto/")) {
        errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });
    await page.goto(`${origin}/unlock?return=${encodeURIComponent(path)}`);
    await page.locator("#local-passphrase").fill("Independent-local-vault-passphrase!");
    await page.locator("#remember-device").check();
    await page.locator("#unlock-submit").click();
    try {
      await (path === "/app"
        ? page.locator("#status-line").filter({ hasText: "Connected" }).waitFor({ timeout: 20_000 })
        : page.locator("#message-input:enabled").waitFor({ timeout: 20_000 }));
    } catch (error) {
      throw new Error(`Unlock failed at ${page.url()}: ${await page.locator("body").innerText()}; ${errors.join(", ")}`, { cause: error });
    }
  }

  async function recoverAfterDeviceIdLoss(page: Page, userId: string) {
    await page.locator("#lock-button").click();
    await page.locator("#local-passphrase").waitFor({ timeout: 20_000 });
    await page.evaluate((id) => localStorage.removeItem(`priv-chat.device.${id}`), userId);
    await page.locator("#local-passphrase").fill("Independent-local-vault-passphrase!");
    await page.locator("#unlock-submit").click();
    try {
      await page.locator("#status-line").filter({ hasText: "Connected" }).waitFor({ timeout: 20_000 });
    } catch (error) {
      throw new Error(`Device ID recovery failed at ${page.url()}: ${await page.locator("body").innerText()}; ${errors.join(", ")}`, { cause: error });
    }
  }

  async function send(sender: Page, recipient: Page, body: string) {
    const senderMessageCount = await sender.locator(".message").count();
    const recipientMessageCount = await recipient.locator(".message").count();
    await sender.locator("#message-input").fill(body);
    await sender.locator("#send-button").click();
    await sender.locator(".message").nth(senderMessageCount).waitFor({ timeout: 20_000 });
    await recipient.locator(".message").nth(recipientMessageCount).waitFor({ timeout: 20_000 });
  }

  await a.goto(`${origin}/channels/@me/${room}`);
  await a.locator("#message-input:enabled").waitFor({ timeout: 20_000 });
  await a.locator("#member-list .member-avatar img").waitFor({ state: "attached", timeout: 20_000 });
  await send(a, b, "Alice to Bob: decrypted through the real transport");
  const gifProviders = await request(a, "/v1/gifs/providers", undefined, "GET");
  assert.equal(gifProviders.status, 200, JSON.stringify(gifProviders.body));
  assert.deepEqual(gifProviders.body.providers.map((provider: { id: string }) => provider.id), ["klipy"]);
  await send(a, b, "Tenor short link preview https://tenor.com/uzlAQImG5tJ.gif");
  const shortTenorGif = b.locator(".message").filter({ hasText: "Tenor short link preview" }).locator(".gif-embed-card");
  await shortTenorGif.locator(".embed-media-image").waitFor({ timeout: 20_000 });
  assert.equal(await shortTenorGif.locator(".gif-embed-frame").count(), 0, "Tenor short GIF links render as images, not blocked iframes");
  assert.equal(await shortTenorGif.locator(".embed-media-image").getAttribute("src"), "https://tenor.com/uzlAQImG5tJ.gif");
  await send(a, b, "Unavailable Tenor preview https://tenor.com/e2ee-missing.gif");
  await b.locator(".message").filter({ hasText: "Unavailable Tenor preview" }).locator(".gif-embed-unavailable").waitFor({ timeout: 20_000 });
  const directImageUrl = "https://media.example.test/attachments/example.png";
  await send(a, b, `Direct URL image ${directImageUrl}`);
  const directImageMessage = b.locator(".message").filter({ hasText: "Direct URL image" });
  const directImage = directImageMessage.locator(".embed-media-image");
  await directImage.waitFor({ timeout: 20_000 });
  assert.equal((await directImageMessage.locator(".markdown-body").innerText()).includes(directImageUrl), false, "direct image URLs are hidden once rendered as embeds");
  assert.equal(await directImageMessage.locator(".embed-media-card a").count(), 0, "embedded images are not external navigation links");
  const directImageAlignment = await directImage.evaluate((image) => image.getBoundingClientRect().left - image.parentElement!.getBoundingClientRect().left);
  assert.ok(Math.abs(directImageAlignment) < 1, "direct image embeds align with the left edge of the message content");
  let imageClickWarnings = 0;
  const handleImageDialog = async (dialog: Dialog) => {
    if (dialog.type() === "confirm") imageClickWarnings += 1;
    await dialog.dismiss();
  };
  b.on("dialog", handleImageDialog);
  await directImage.click();
  b.off("dialog", handleImageDialog);
  assert.equal(imageClickWarnings, 0, "viewing the embedded image does not trigger the external-link warning");
  await b.locator("#media-viewer").waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await b.locator("#media-viewer .media-viewer-image").getAttribute("src"), directImageUrl, "embedded images open in the app's enlargement viewer");
  const fitToScreen = await b.locator("#media-viewer .media-viewer-image").evaluate((image) => {
    image.style.width = "4000px";
    image.style.height = "4000px";
    const { width, height } = image.getBoundingClientRect();
    return { width, height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  assert.ok(fitToScreen.width < fitToScreen.viewportWidth && fitToScreen.height < fitToScreen.viewportHeight, "enlarged images stay within the viewport at the default fit zoom");
  assert.equal(await b.locator("dialog.external-link-dialog").count(), 0, "image enlargement stays inside Naigi without external confirmation");
  await b.locator("#media-viewer-close").click();
  const failedImageUrl = "https://media-fail.example.test/attachments/missing.png";
  await send(a, b, `Failed image link ${failedImageUrl}`);
  const failedImageLink = b.locator(".message").filter({ hasText: "Failed image link" }).locator(".embed-media-card a.embed-link");
  await failedImageLink.waitFor({ timeout: 20_000 });
  await failedImageLink.click();
  const externalLinkDialog = b.locator("dialog.external-link-dialog");
  await externalLinkDialog.waitFor({ state: "visible", timeout: 20_000 });
  assert.match(await externalLinkDialog.locator("h2").innerText(), /leaving Naigi/i);
  assert.equal(await externalLinkDialog.locator(".external-link-address").textContent(), failedImageUrl);
  await externalLinkDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await externalLinkDialog.waitFor({ state: "detached", timeout: 20_000 });
  await b.evaluate(() => {
    document.documentElement.dataset.openedExternalLink = "";
    window.open = ((url: string | URL) => {
      document.documentElement.dataset.openedExternalLink = String(url);
      return null;
    }) as typeof window.open;
  });
  await failedImageLink.click();
  await externalLinkDialog.waitFor({ state: "visible", timeout: 20_000 });
  await externalLinkDialog.getByRole("button", { name: "Open link", exact: true }).click();
  await b.waitForFunction((url) => document.documentElement.dataset.openedExternalLink === url, failedImageUrl);
  await send(a, b, "Klipy link preview https://klipy.com/gifs/test-wave");
  const linkedGif = b.locator(".message").filter({ hasText: "Klipy link preview" }).locator(".gif-embed-card .embed-media-image");
  await linkedGif.waitFor({ timeout: 20_000 });
  assert.equal(await linkedGif.getAttribute("src"), klipyMediaUrl);
  assert.equal(await b.locator(".message").filter({ hasText: "Alice to Bob: decrypted through the real transport" }).getByRole("button", { name: "Edit", exact: true }).count(), 0);
  assert.equal(await a.locator("#message-input").getAttribute("maxlength"), "4000");
  await a.locator("#message-input").evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "long pasted source\n".repeat(300));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  });
  await a.locator(".attachment-item").filter({ hasText: "pasted-text" }).waitFor({ timeout: 20_000 });
  await a.locator("#clear-attachment").click();
  await a.locator("#messages").evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["const dropped = true;"], "dropped-note.ts", { type: "text/plain" }));
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    if ((document.querySelector("#file-drop-overlay") as HTMLElement | null)?.hidden) throw new Error("file_drop_overlay_not_shown");
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await a.locator(".attachment-item").filter({ hasText: "dropped-note.ts" }).waitFor({ timeout: 20_000 });
  assert.equal(await a.locator("#file-drop-overlay").isHidden(), true, "drop overlay closes after queuing files");
  await a.locator("#clear-attachment").click();
  const positioningImage = await a.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas_context_unavailable");
    context.fillStyle = "#557788";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("canvas_encode_failed")), "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await a.locator("#message-input").evaluate((element, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "clipboard-image.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  }, positioningImage);
  await a.locator(".attachment-item").filter({ hasText: "clipboard-image.png" }).waitFor({ timeout: 20_000 });
  const queuedAttachmentBox = await a.locator("#attachment-preview").boundingBox();
  const composerBox = await a.locator(".composer-box").boundingBox();
  assert.ok(queuedAttachmentBox && composerBox && queuedAttachmentBox.y + queuedAttachmentBox.height <= composerBox.y, "queued attachments render above the message composer");
  await a.locator("#send-button").click();
  const pastedImage = b.locator('.encrypted-media-card[data-media-filename="clipboard-image.png"]').last();
  await pastedImage.locator(".media-preview").waitFor({ timeout: 20_000 });
  const imageBox = await pastedImage.locator(".media-preview").boundingBox();
  const imageDownloadBox = await pastedImage.locator(".media-file-download").boundingBox();
  assert.ok(imageBox && imageDownloadBox, "encrypted image preview and download action are rendered");
  assert.ok(imageDownloadBox.x + imageDownloadBox.width <= imageBox.x + imageBox.width + 1
    && imageDownloadBox.x + imageDownloadBox.width >= imageBox.x + imageBox.width - 12,
  "download action stays within the displayed image's right edge");
  assert.ok(imageDownloadBox.y + imageDownloadBox.height <= imageBox.y + imageBox.height + 1
    && imageDownloadBox.y + imageDownloadBox.height >= imageBox.y + imageBox.height - 12,
  "download action stays within the displayed image's bottom edge");
  const trendingGifsLoaded = a.waitForResponse((response) => response.url().includes("/gifs/trending") && response.status() === 200);
  await a.locator("#gif-toggle").click();
  await a.locator("#gif-picker").waitFor({ state: "visible", timeout: 20_000 });
  assert.deepEqual(await a.locator("#gif-picker-provider option").allTextContents(), ["Klipy"]);
  await trendingGifsLoaded;
  await a.locator(".gif-picker-result").first().waitFor({ timeout: 20_000 });
  assert.equal(await a.locator("#gif-picker-search").inputValue(), "", "opening the picker shows trending GIFs before a search is entered");
  const searchGifsLoaded = a.waitForResponse((response) => response.url().includes("/gifs/search") && response.status() === 200);
  await a.locator("#gif-picker-search").fill("wave");
  await searchGifsLoaded;
  const gifResult = a.locator(".gif-picker-result").first();
  await gifResult.waitFor({ timeout: 20_000 });
  const gifResultBox = await gifResult.boundingBox();
  assert.ok(gifResultBox && Math.abs(gifResultBox.width - gifResultBox.height) < 1, "GIF picker result tiles stay square while the grid scrolls");
  await gifResult.click();
  await a.locator(".attachment-item").filter({ hasText: "klipy-e2ee-wave.gif" }).waitFor({ timeout: 20_000 });
  await a.locator("#send-button").click();
  const pickerGif = b.locator('.encrypted-media-card[data-media-filename="klipy-e2ee-wave.gif"]').last();
  await pickerGif.locator(".media-preview").waitFor({ timeout: 20_000 });
  await a.locator("#photo-input").setInputFiles([
    { name: "pixel.png", mimeType: "image/png", buffer: Buffer.from(onePixelPng) },
    { name: "second-pixel.png", mimeType: "image/png", buffer: Buffer.from(onePixelPng) },
    {
      name: "example.ts",
      mimeType: "text/plain",
      buffer: Buffer.from(["const answer = 42;", ...Array.from({ length: 100 }, (_, index) => `const value_${index} = ${index};`)].join("\n") + "\n"),
    },
  ]);
  assert.equal(await a.locator(".attachment-item").count(), 3);
  await a.locator("#send-button").click();
  const mediaAlbum = b.locator(".media-album").last();
  await mediaAlbum.waitFor({ timeout: 20_000 });
  await mediaAlbum.locator(".media-preview").first().waitFor({ timeout: 20_000 });
  await mediaAlbum.locator(".media-preview").nth(1).waitFor({ timeout: 20_000 });
  const albumMessage = b.locator(".message:has(.media-album)").last();
  assert.equal(await b.locator(".message:has(.media-album)").count(), 1);
  assert.equal(await albumMessage.locator(".message-actions").count(), 1);
  assert.equal(await mediaAlbum.locator(".message-actions").count(), 0);
  assert.equal(await mediaAlbum.locator(".media-album-tile").count(), 2);
  assert.equal(await mediaAlbum.locator(".media-preview").count(), 2);
  assert.equal(await mediaAlbum.locator("a[download]").count(), 2);
  await mediaAlbum.locator(".media-preview").first().click();
  await b.locator("#media-viewer").waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await b.locator("#media-viewer-count").textContent(), "1 / 2");
  await b.locator("#media-viewer-next").click();
  assert.equal(await b.locator("#media-viewer-count").textContent(), "2 / 2");
  await b.locator("#media-viewer-close").click();
  const sourceMessage = b.locator(".message").filter({ hasText: "example.ts" }).last();
  await sourceMessage.waitFor({ timeout: 20_000 });
  const inlineTextPreview = sourceMessage.locator(".text-attachment-preview");
  await inlineTextPreview.waitFor({ timeout: 20_000 });
  assert.ok((await inlineTextPreview.locator(".text-attachment-preview-content").textContent())?.startsWith("const answer = 42;\n"));
  assert.equal(await inlineTextPreview.locator(".code-token-keyword").first().textContent(), "const", "recognized source files receive syntax highlighting");
  assert.equal(await inlineTextPreview.locator(".text-attachment-preview-content").evaluate((text) => getComputedStyle(text).whiteSpace), "pre-wrap");
  assert.ok((await sourceMessage.locator(".text-attachment-footer").innerText()).includes("characters more"), "inline preview reports the remaining character count");
  assert.ok(await inlineTextPreview.evaluate((preview) => preview.scrollHeight > preview.clientHeight), "inline code preview scrolls within its compact height");
  await sourceMessage.getByRole("button", { name: "Expand text preview", exact: true }).click();
  const fullTextViewer = b.locator(".text-file-viewer").filter({ hasText: "const answer = 42;" });
  await fullTextViewer.waitFor({ timeout: 20_000 });
  assert.equal(await fullTextViewer.locator(".code-token-keyword").first().textContent(), "const");
  assert.equal(await fullTextViewer.evaluate((text) => getComputedStyle(text).whiteSpace), "pre-wrap");
  await b.locator("#media-viewer-close").click();
  await a.locator("#photo-input").setInputFiles({ name: "spoiler.png", mimeType: "image/png", buffer: Buffer.from(onePixelPng) });
  await a.locator(".attachment-item input[type=checkbox]").check();
  await a.locator("#send-button").click();
  const spoilerMessage = b.locator(".message:has(.media-spoiler-cover)").last();
  await spoilerMessage.waitFor({ timeout: 20_000 });
  assert.equal(await spoilerMessage.locator(".media-preview").count(), 0);
  await spoilerMessage.locator(".media-spoiler-cover").click();
  await b.locator(".message .media-preview").last().waitFor({ timeout: 20_000 });
  await b.locator("#messages").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const jumpLatestVisibility = await b.locator("#messages").evaluate((messages) => {
    const button = document.querySelector<HTMLButtonElement>("#jump-latest-button");
    if (!button) throw new Error("jump_latest_button_missing");
    const maxScroll = messages.scrollHeight - messages.clientHeight;
    const showDistance = Math.max(400, messages.clientHeight * 0.75);
    const hideDistance = Math.max(280, messages.clientHeight * 0.55);
    if (maxScroll < showDistance + 1) throw new Error("not_enough_scroll_range_for_jump_button_test");
    messages.scrollTop = maxScroll - Math.max(hideDistance + 20, showDistance - 50);
    messages.dispatchEvent(new Event("scroll"));
    const hiddenBeforeShowThreshold = button.hidden;
    messages.scrollTop = maxScroll - (showDistance + 1);
    messages.dispatchEvent(new Event("scroll"));
    const visibleAfterShowThreshold = !button.hidden;
    messages.scrollTop = maxScroll - ((showDistance + hideDistance) / 2);
    messages.dispatchEvent(new Event("scroll"));
    const staysVisibleInHysteresisBand = !button.hidden;
    messages.scrollTop = maxScroll - (hideDistance - 1);
    messages.dispatchEvent(new Event("scroll"));
    const hiddenAfterReturningNearLatest = button.hidden;
    messages.scrollTop = messages.scrollHeight;
    messages.dispatchEvent(new Event("scroll"));
    return { hiddenBeforeShowThreshold, visibleAfterShowThreshold, staysVisibleInHysteresisBand, hiddenAfterReturningNearLatest, hiddenAtLatest: button.hidden };
  });
  assert.deepEqual(jumpLatestVisibility, {
    hiddenBeforeShowThreshold: true,
    visibleAfterShowThreshold: true,
    staysVisibleInHysteresisBand: true,
    hiddenAfterReturningNearLatest: true,
    hiddenAtLatest: true,
  }, "jump-to-latest uses responsive distance thresholds with hysteresis");
  const mentionPrefix = users[1].username.slice(0, -1);
  await a.locator("#message-input").fill(`@${mentionPrefix}`);
  await a.locator("#mention-suggestions").waitFor({ state: "visible", timeout: 20_000 });
  await a.locator("#message-input").press("ArrowDown");
  assert.equal(await a.locator("#message-input").inputValue(), `@${mentionPrefix}`);
  await a.locator("#message-input").press("Enter");
  assert.equal(await a.locator("#message-input").inputValue(), `@${users[1].username} `);
  await a.locator("#message-input").fill(":smi");
  await a.locator("#emoji-suggestions").waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await a.locator(".emoji-suggestion").filter({ hasText: ":smiley:" }).count(), 1);
  await a.locator("#message-input").press("ArrowDown");
  assert.equal(await a.locator("#message-input").inputValue(), ":smi");
  await a.locator("#message-input").press("Enter");
  assert.equal(await a.locator("#message-input").inputValue(), "😃");
  await a.locator("#emoji-toggle").click();
  await a.locator("#emoji-picker").waitFor({ state: "visible", timeout: 20_000 });
  await a.locator("#emoji-category-tab-animals-nature").click();
  assert.equal(await a.locator("#emoji-category-tab-animals-nature").getAttribute("aria-selected"), "true");
  await a.locator("#emoji-picker-search").fill("melting_face");
  await a.getByRole("button", { name: "Insert :melting_face:", exact: true }).waitFor({ timeout: 20_000 });
  await a.locator("#emoji-picker-search").press("Escape");
  await a.locator("#message-input").fill(":melting_face: full 👩‍🚀 😄");
  await a.locator("#send-button").click();
  const emojiMessage = b.locator(".message").filter({ hasText: "full" });
  await emojiMessage.waitFor({ timeout: 20_000 });
  assert.equal(await emojiMessage.locator('img[src$="/assets/twemoji/1fae0.svg"]').count(), 1);
  assert.equal(await emojiMessage.locator('img[src$="/assets/twemoji/1f469-200d-1f680.svg"]').count(), 1);
  assert.equal(await emojiMessage.locator('img[src$="/assets/twemoji/1f604.svg"]').count(), 1);
  await send(a, b, `Ping @${users[1].username}: mention styling and unread state`);
  await b.locator(".message").filter({ hasText: "mention styling" }).waitFor({ timeout: 20_000 });
  assert.equal(await b.locator(".message").filter({ hasText: "mention styling" }).count(), 1);
  assert.equal(await b.locator(".message-compact").filter({ hasText: "mention styling" }).count(), 1);
  assert.equal(await b.locator(".message-mention").filter({ hasText: "mention styling" }).count(), 1);
  assert.equal(await b.locator(".conversation-item .unread-badge").count(), 0);
  await send(b, a, "Bob to Alice: independent device keys work");
  assert.equal(await b.locator(".conversation-item .unread-badge").count(), 0);
  assert.equal(await b.locator(".message-mention").filter({ hasText: "mention styling" }).count(), 0);
  assert.equal(await a.locator(".message").filter({ hasText: "Bob to Alice: independent device keys work" }).getByRole("button", { name: "Edit", exact: true }).count(), 0);
  const bobMessage = a.locator(".message").filter({ hasText: "Bob to Alice: independent device keys work" });
  await bobMessage.hover();
  const actionPill = await bobMessage.locator(".message-actions-controls").boundingBox();
  const messageBody = await bobMessage.locator(".markdown-body").boundingBox();
  assert.ok(actionPill && messageBody, "message actions and body are rendered");
  assert.ok(actionPill.y <= messageBody.y, "the action pill stays above the message body");
  assert.ok(actionPill.x >= messageBody.x + messageBody.width - 1, "the action pill does not cover message text");
  await a.setViewportSize({ width: 390, height: 844 });
  await bobMessage.hover();
  const mobileActionPill = await bobMessage.locator(".message-actions-controls").boundingBox();
  const mobileMessageBody = await bobMessage.locator(".markdown-body").boundingBox();
  assert.ok(mobileActionPill && mobileMessageBody, "mobile message actions and body are rendered");
  assert.ok(mobileActionPill.y + mobileActionPill.height <= mobileMessageBody.y, "mobile actions stay above message text");
  await a.setViewportSize({ width: 1280, height: 720 });
  await bobMessage.hover();
  await bobMessage.getByRole("button", { name: "Reply", exact: true }).click();
  await a.locator("#reply-mention-toggle:not([hidden])").waitFor({ timeout: 20_000 });
  await a.locator("#reply-mention-toggle").filter({ hasText: "Mention" }).waitFor({ timeout: 20_000 });
  assert.equal(await a.locator("#reply-mention-toggle").getAttribute("aria-pressed"), "true");
  await a.locator("#reply-mention-toggle").click();
  assert.equal(await a.locator("#reply-mention-toggle").getAttribute("aria-pressed"), "false");
  await send(a, b, "Reply without a ping");
  const replyMessage = b.locator(".message").filter({ hasText: "Reply without a ping" });
  assert.equal(await replyMessage.getAttribute("data-mentions-current-user"), "false");
  await replyMessage.locator(".reply-context").waitFor({ timeout: 20_000 });
  assert.equal(await replyMessage.locator(".reply-context").filter({ hasText: "Encrypted message" }).count(), 0);
  assert.equal(await a.locator(".unavailable-history").count(), 0);
  assert.equal(await b.locator(".unavailable-history").count(), 0);
  assert.equal(await a.locator("#status-line").textContent(), "Connected");
  assert.equal(await b.locator("#status-line").textContent(), "Connected");
  assert.deepEqual(errors, []);

  const serverId = createdServer.body.server.id;
  const initialRoles = await request(a, `/v1/servers/${serverId}/roles`);
  assert.equal(initialRoles.status, 200, JSON.stringify(initialRoles.body));
  assert.equal(initialRoles.body.roles.some((role: { systemKey: string; mentionable: boolean }) => role.systemKey === "owner" && role.mentionable), false);
  const everyoneRole = initialRoles.body.roles.find((role: { id: string; systemKey: string; permissions: Record<string, boolean> }) => role.systemKey === "everyone");
  assert.ok(everyoneRole, "new servers include the Everyone role");
  assert.ok(initialRoles.body.assignments.find((assignment: { userId: string; roleIds: string[] }) => assignment.userId === users[0].id)?.roleIds.includes(everyoneRole.id));
  assert.ok(initialRoles.body.assignments.find((assignment: { userId: string; roleIds: string[] }) => assignment.userId === users[1].id)?.roleIds.includes(everyoneRole.id));
  const hiddenMemberPermission = await request(a, `/v1/servers/${serverId}/roles/${everyoneRole.id}`, {
    permissions: { ...everyoneRole.permissions, view_members: false },
  }, "PATCH");
  assert.equal(hiddenMemberPermission.status, 200, JSON.stringify(hiddenMemberPermission.body));
  const hiddenMembers = await request(b, `/v1/servers/${serverId}/members`);
  assert.equal(hiddenMembers.status, 403, JSON.stringify(hiddenMembers.body));
  const restoredMemberPermission = await request(a, `/v1/servers/${serverId}/roles/${everyoneRole.id}`, {
    permissions: everyoneRole.permissions,
  }, "PATCH");
  assert.equal(restoredMemberPermission.status, 200, JSON.stringify(restoredMemberPermission.body));
  const restrictedRole = await request(a, `/v1/servers/${serverId}/roles`, {
    encryptedMetadata: "",
    color: "#e05a7a",
    permissions: { view_channels: true, upload_files: true, mention_roles: true },
    mentionable: true,
    viewAllChannels: false,
  });
  assert.equal(restrictedRole.status, 201, JSON.stringify(restrictedRole.body));
  const extraChannel = await request(a, `/v1/servers/${serverId}/channels`, { encryptedMetadata: "" });
  assert.equal(extraChannel.status, 201, JSON.stringify(extraChannel.body));
  const assignedRole = await request(a, `/v1/servers/${serverId}/members/${users[1].id}/roles`, {
    roleIds: [restrictedRole.body.role.id],
  }, "PATCH");
  assert.equal(assignedRole.status, 200, JSON.stringify(assignedRole.body));
  const hiddenChannels = await request(b, `/v1/servers/${serverId}/channels`);
  assert.equal(hiddenChannels.status, 200, JSON.stringify(hiddenChannels.body));
  assert.equal(hiddenChannels.body.channels.some((channel: { id: string }) => channel.id === extraChannel.body.channel.id), false);
  const channelAccess = await request(a, `/v1/servers/${serverId}/roles/${restrictedRole.body.role.id}/channels/${extraChannel.body.channel.id}`, {
    canView: true,
    canUpload: true,
  }, "PATCH");
  assert.equal(channelAccess.status, 200, JSON.stringify(channelAccess.body));
  const visibleRestrictedChannel = await request(b, `/v1/servers/${serverId}/channels`);
  assert.equal(visibleRestrictedChannel.status, 200, JSON.stringify(visibleRestrictedChannel.body));
  const restrictedChannel = visibleRestrictedChannel.body.channels.find((channel: { id: string }) => channel.id === extraChannel.body.channel.id);
  assert.equal(restrictedChannel?.canSend, false);
  assert.equal(restrictedChannel?.canUpload, true);
  const deletedRole = await request(a, `/v1/servers/${serverId}/roles/${restrictedRole.body.role.id}`, undefined, "DELETE");
  assert.equal(deletedRole.status, 200, JSON.stringify(deletedRole.body));
  const restoredChannels = await request(b, `/v1/servers/${serverId}/channels`);
  const restoredChannel = restoredChannels.body.channels.find((channel: { id: string }) => channel.id === extraChannel.body.channel.id);
  assert.equal(restoredChannel?.canSend, true);
  assert.equal(restoredChannel?.canUpload, true);

  const deletedConversation = await request(a, `/v1/conversations/${room}`, undefined, "DELETE");
  assert.equal(deletedConversation.status, 200, JSON.stringify(deletedConversation.body));
  const deletedServer = await request(a, `/v1/servers/${createdServer.body.server.id}`, undefined, "DELETE");
  assert.equal(deletedServer.status, 200, JSON.stringify(deletedServer.body));
  console.log("PASS: two independent browser stores decrypt messages in both directions over the real server");
} finally {
  await browser.close();
  await app.stop(true);
  closeRedis();
  await closeDatabase();
  await admin.unsafe(`drop schema ${schema} cascade`);
  await admin.close();
}
