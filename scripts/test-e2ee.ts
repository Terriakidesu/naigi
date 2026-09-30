import assert from "node:assert/strict";
import { password, SQL } from "bun";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { chromium, type Dialog, type Page } from "playwright";

// I have nothing but my burger and I want nothing more
// Use the real HTTP, PostgreSQL, Redis, WASM and IndexedDB paths. A mock key
// directory cannot catch JSONB serialization breaking signed Matrix keys.
const appDatabaseBaseUrl = Bun.env.DATABASE_URL ?? "postgres://localhost:5432/priv_chat";
const adminDatabaseBaseUrl = Bun.env.ADMIN_DATABASE_URL ?? appDatabaseBaseUrl;
const appDatabaseAdmin = new SQL(appDatabaseBaseUrl);
const adminDatabaseAdmin = new SQL(adminDatabaseBaseUrl);
const schema = `e2ee_test_${crypto.randomUUID().replaceAll("-", "")}`;
const adminSchema = `e2ee_admin_test_${crypto.randomUUID().replaceAll("-", "")}`;
await appDatabaseAdmin.unsafe(`create schema ${schema}`);
await adminDatabaseAdmin.unsafe(`create schema ${adminSchema}`);
const databaseUrl = new URL(appDatabaseBaseUrl);
databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
Bun.env.DATABASE_URL = databaseUrl.toString();
const isolatedAdminDatabaseUrl = new URL(adminDatabaseBaseUrl);
isolatedAdminDatabaseUrl.searchParams.set("options", `-c search_path=${adminSchema}`);
Bun.env.ADMIN_DATABASE_URL = isolatedAdminDatabaseUrl.toString();
Bun.env.NODE_ENV = "test";
Bun.env.KLIPY_API_KEY = "e2ee-klipy-public-key";

const { closeDatabase } = await import("../src/db/client");
const { adminDb, closeAdminDatabase } = await import("../src/admin-db/client");
const { closeRedis } = await import("../src/redis/client");
const { migrate } = await import("../src/db/migrate");
const { migrateAdminDatabase } = await import("../src/admin-db/migrate");
const { createApp } = await import("../src/app");
  const browser = await chromium.launch({ headless: true });
  const app = createApp();
  const errors: string[] = [];

try {
  await migrate();
  await migrateAdminDatabase();
  const adminPassword = "Host-operator-password-for-e2ee-test!";
  await adminDb`
    insert into admin_users (username, password_hash)
    values ('e2ee_operator', ${await password.hash(adminPassword)})
  `;
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${app.server!.port}`;
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const operatorContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  const a = await alice.newPage();
  const b = await bob.newPage();
  const operator = await operatorContext.newPage();
  const outsider = await outsiderContext.newPage();
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
  await outsider.goto(origin);
  const outsiderRegistration = await request(outsider, "/v1/auth/register", {
    username: "e2ee_outsider", password: "Account-password-for-e2ee-test!", displayName: "outsider",
  });
  assert.equal(outsiderRegistration.status, 201, JSON.stringify(outsiderRegistration.body));
  await operator.goto(`${origin}/instance-admin`);
  assert.equal(await operator.locator("#admin-auth-form").count(), 1, "unauthenticated operators receive the admin-only login page");
  const operatorLogin = await request(operator, "/v1/instance-admin/auth/login", {
    username: "e2ee_operator", password: adminPassword,
  });
  assert.equal(operatorLogin.status, 200, JSON.stringify(operatorLogin.body));
  assert.equal((await request(operator, "/v1/me")).status, 401, "admin sessions cannot authenticate chat accounts");
  assert.equal((await request(a, `/v1/users/${operatorLogin.body.operator.id}`)).status, 404, "host operators have no chat profiles");
  assert.equal((await request(operator, "/v1/auth/login", {
    username: "e2ee_operator", password: adminPassword,
  })).status, 401, "admin identities are not chat accounts");
  assert.equal((await request(a, "/v1/instance-admin/auth/me")).status, 401, "chat sessions cannot authenticate host operators");
  const anonymousAdminResponse = await fetch(`${origin}/v1/instance-admin/reports`);
  assert.equal(anonymousAdminResponse.status, 401, "instance administration requires authentication");
  const spaceOwnerAdminResponse = await request(a, "/v1/instance-admin/reports");
  assert.equal(spaceOwnerAdminResponse.status, 401, "chat identity cookies do not grant instance administration");

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
  assert.equal(await a.locator("[data-settings-view].panel").count(), 0, "account settings sections use the open layout rather than stacked cards");
  await a.setViewportSize({ width: 390, height: 844 });
  await a.locator("#settings-mobile-sidebar-close").click();
  const mobileSettingsOverflow = await a.locator(".settings-main-content").evaluate((element) => element.scrollWidth - element.clientWidth);
  assert.ok(mobileSettingsOverflow <= 1, `settings content should fit a mobile viewport, overflow: ${mobileSettingsOverflow}px`);
  await a.setViewportSize({ width: 1280, height: 720 });
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
  assert.equal(await a.locator("#settings-page-title").textContent(), "Profile", "settings header identifies the current section");
  assert.deepEqual(await a.locator(".settings-nav-group-title").allTextContents(), ["ACCOUNT", "PRIVACY & DATA", "PREFERENCES"]);
  const displayNameField = a.locator("#settings-display-name");
  const savedDisplayName = await displayNameField.inputValue();
  await displayNameField.fill(`${savedDisplayName} draft`);
  assert.equal(await a.locator("#save-profile-button").isDisabled(), false, "profile save enables only when the name changes");
  assert.equal(await a.locator("#discard-profile-changes").isVisible(), true, "profile discard appears for unsaved changes");
  await a.locator("#discard-profile-changes").click();
  assert.equal(await displayNameField.inputValue(), savedDisplayName, "discard restores the saved profile name");
  assert.equal(await a.locator("#save-profile-button").isDisabled(), true, "profile save disables after discarding changes");
  await a.locator('.settings-nav-item[href="#devices"]').click();
  await a.waitForFunction(() => document.getElementById("settings-page-title")?.textContent === "Devices");
  await a.locator('.settings-nav-item[href="#profile"]').click();
  await a.waitForFunction(() => document.getElementById("settings-page-title")?.textContent === "Profile");
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
  const createdVoiceChannel = await request(a, `/v1/servers/${createdServer.body.server.id}/channels`, {
    kind: "voice",
    encryptedMetadata: "",
  });
  assert.equal(createdVoiceChannel.status, 201, JSON.stringify(createdVoiceChannel.body));
  assert.equal(createdVoiceChannel.body.channel.kind, "voice");
  const listedChannels = await request(a, `/v1/servers/${createdServer.body.server.id}/channels`);
  assert.ok(listedChannels.body.channels.some((channel: { id: string; kind: string }) =>
    channel.id === createdVoiceChannel.body.channel.id && channel.kind === "voice"));
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
  const ownerVoiceAccess = await request(a, "/v1/voice/room-check", { channelId: createdVoiceChannel.body.channel.id });
  assert.equal(ownerVoiceAccess.status, 200, JSON.stringify(ownerVoiceAccess.body));
  assert.equal(ownerVoiceAccess.body.authorized, true);
  const voiceHistory = await request(a, `/v1/conversations/${createdVoiceChannel.body.channel.conversationId}/messages`, undefined, "GET");
  assert.equal(voiceHistory.status, 403, JSON.stringify(voiceHistory.body));
  const voiceMessage = await request(a, `/v1/conversations/${createdVoiceChannel.body.channel.conversationId}/messages`, {
    senderDeviceId: "00000000-0000-4000-8000-000000000001",
    clientMessageId: "00000000-0000-4000-8000-000000000002",
    protocol: "test",
    ciphertext: "AA",
  });
  assert.equal(voiceMessage.status, 403, JSON.stringify(voiceMessage.body));
  const memberVoiceAccess = await request(b, "/v1/voice/room-check", { channelId: createdVoiceChannel.body.channel.id });
  assert.equal(memberVoiceAccess.status, 200, JSON.stringify(memberVoiceAccess.body));
  assert.equal(memberVoiceAccess.body.authorized, true);
  const outsiderVoiceAccess = await request(outsider, "/v1/voice/room-check", { channelId: createdVoiceChannel.body.channel.id });
  assert.equal(outsiderVoiceAccess.status, 403, JSON.stringify(outsiderVoiceAccess.body));
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
  await a.locator(".history-manual-backup > summary").click();
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
  await a.locator("#self-profile-button").click();
  await a.locator("#profile-modal").waitFor({ state: "visible", timeout: 20_000 });
  await a.waitForFunction(() => document.getElementById("profile-modal-name")?.textContent === "alice", undefined, { timeout: 20_000 });
  assert.equal((await a.locator("#profile-modal-name").textContent())?.trim(), "alice", "profile popup shows the display name");
  assert.equal((await a.locator("#profile-modal-username").textContent())?.trim(), "@e2ee_alice", "profile popup shows the account handle");
  assert.equal(await a.locator("#profile-modal-created").getAttribute("datetime") !== null, true, "profile popup exposes the join date semantically");
  assert.equal(await a.locator("#profile-modal-edit").isVisible(), true, "own profile popup provides an edit action");
  await a.locator("#profile-modal-close").click();
  await a.locator("#profile-modal").waitFor({ state: "hidden" });
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

  const invalidReportReference = await request(a, "/v1/reports", {
    targetUserId: users[1].id,
    reason: "harassment",
    conversationId: room,
    messageId: crypto.randomUUID(),
  });
  assert.equal(invalidReportReference.status, 400, "report message references must identify a message authored by the reported user");
  const unsupportedProfileReport = await request(a, "/v1/reports", {
    targetUserId: outsiderRegistration.body.user.id,
    reason: "other",
  });
  assert.equal(unsupportedProfileReport.status, 403, "profile reports must stay within the shared-server trust boundary");

  const blocked = await request(a, `/v1/users/${users[1].id}/block`, {});
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  const blockedHistoryFromAlice = await request(a, `/v1/conversations/${room}/messages`);
  const blockedHistoryFromBob = await request(b, `/v1/conversations/${room}/messages`);
  const blockedMembers = await request(a, `/v1/conversations/${room}/members`);
  const blockedDirectSend = await request(a, `/v1/conversations/${room}/messages`, {
    senderDeviceId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    protocol: "m.room.encrypted",
    ciphertext: "AQ",
  });
  const sharedSpaceHistory = await request(b, `/v1/conversations/${createdServer.body.channel.conversationId}/messages`);
  assert.equal(blockedHistoryFromAlice.status, 403);
  assert.equal(blockedHistoryFromBob.status, 403, "a block is enforced in both directions");
  assert.equal(blockedMembers.status, 403);
  assert.equal(blockedDirectSend.status, 403, "blocked direct messages cannot be sent");
  assert.equal(sharedSpaceHistory.status, 200, "blocking does not remove shared-space access");
  const blockedConversationList = await request(a, "/v1/conversations");
  assert.equal(blockedConversationList.body.conversations.some((conversation: { id: string }) => conversation.id === room), false);
  const unblocked = await request(a, `/v1/users/${users[1].id}/block`, undefined, "DELETE");
  assert.equal(unblocked.status, 200, JSON.stringify(unblocked.body));
  assert.equal((await request(a, `/v1/conversations/${room}/messages`)).status, 200);

  await operator.goto(`${origin}/instance-admin`);
  await operator.locator("#instance-report-list").waitFor({ timeout: 20_000 });
  await operator.locator("#new-report-key-passphrase").fill("Report-key-backup-passphrase-for-e2ee!");
  await operator.locator("#confirm-report-key-passphrase").fill("Report-key-backup-passphrase-for-e2ee!");
  const reportKeyDownloadPromise = operator.waitForEvent("download");
  await operator.locator("#create-report-key").click();
  const reportKeyDownload = await reportKeyDownloadPromise;
  await operator.locator("#instance-admin-status").filter({ hasText: "Evidence key activated." }).waitFor({ timeout: 20_000 });
  const reportKeyBackupPath = await reportKeyDownload.path();
  assert.ok(reportKeyBackupPath, "report-key backup should be downloadable");
  await reportKeyDownload.delete();
  const publicReportKey = await request(a, "/v1/reports/public-key");
  assert.equal(publicReportKey.status, 200);
  assert.ok(publicReportKey.body.configured);
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
  assert.ok(queuedAttachmentBox && composerBox && Math.abs(queuedAttachmentBox.width - composerBox.width) <= 1, "queued attachment tray spans the composer width");
  const queuedImagePreview = a.locator(".attachment-item-media .attachment-item-visual").last();
  await queuedImagePreview.click();
  await a.locator("#media-viewer .media-viewer-image").waitFor({ timeout: 20_000 });
  assert.equal(await a.locator("#media-viewer .media-viewer-image").getAttribute("alt"), "clipboard-image.png", "queued images open in the fitted media viewer");
  await a.locator("#media-viewer-close").click();
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
  const bobChatUrl = b.url();
  await b.goto(`${origin}/settings#accessibility`);
  assert.equal(await b.locator("#settings-page-title").textContent(), "Accessibility");
  assert.equal(await b.locator("#save-app-preferences-button").isDisabled(), true, "app preference save is disabled without edits");
  assert.deepEqual(await b.locator(".app-scale-range-interface .app-scale-ticks span").allTextContents(), ["85%", "100%", "125%", "150%", "175%", "200%"]);
  assert.deepEqual(await b.locator(".app-scale-range-message .app-scale-ticks span").allTextContents(), ["12px", "14px", "16px", "18px", "20px", "22px", "24px"]);
  const savedTextSize = await b.locator("#app-message-text-size").inputValue();
  await b.locator("#app-message-text-size").evaluate((element) => {
    const slider = element as HTMLInputElement;
    slider.value = "18";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await b.locator("#app-message-text-size-value").textContent(), "18px");
  assert.equal(await b.locator("#app-preferences-status").textContent(), "Unsaved changes");
  await b.locator("#discard-app-preferences-button").click();
  assert.equal(await b.locator("#app-message-text-size").inputValue(), savedTextSize, "discard restores saved app preferences");
  await b.locator("#app-message-text-size").evaluate((element) => {
    const slider = element as HTMLInputElement;
    slider.value = "18";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await b.locator("#app-message-text-size-value").textContent(), "18px");
  await b.locator('a[href="#chat-media"]').click();
  await b.locator(".app-preferences-leave-dialog").getByRole("button", { name: "Save changes" }).click();
  await b.locator("#app-auto-load-media").uncheck();
  await b.locator('a[href="#notifications"]').click();
  await b.locator(".app-preferences-leave-dialog").getByRole("button", { name: "Save changes" }).click();
  await b.locator("#app-notification-mode").selectOption("off");
  await b.locator("#app-quiet-hours-enabled").check();
  await b.locator("#app-quiet-hours-start").fill("23:00");
  await b.locator("#app-quiet-hours-end").fill("07:00");
  await b.locator("#app-preferences-form button[type=submit]").click();
  await b.locator("#app-preferences-status").filter({ hasText: "Changes saved on this browser." }).waitFor({ timeout: 20_000 });
  assert.equal(await b.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--message-text-size").trim()), "18px");
  await b.goto(bobChatUrl);
  const spoilerImageBytes = await a.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas_context_unavailable");
    context.fillStyle = "#557788";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("canvas_encode_failed")), "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await a.locator("#photo-input").setInputFiles({ name: "manual.png", mimeType: "image/png", buffer: Buffer.from(spoilerImageBytes) });
  await a.locator("#send-button").click();
  const manualMediaMessage = b.locator('.message:has([data-media-filename="manual.png"])').last();
  await manualMediaMessage.waitFor({ timeout: 20_000 });
  const manualMediaPreview = manualMediaMessage.locator(".media-preview");
  assert.equal(await manualMediaPreview.count(), 0, "manual media preference defers encrypted image downloads");
  await manualMediaMessage.getByRole("button", { name: "Load image", exact: true }).click();
  await manualMediaPreview.waitFor({ timeout: 20_000 });
  await a.locator("#photo-input").setInputFiles({ name: "spoiler.png", mimeType: "image/png", buffer: Buffer.from(spoilerImageBytes) });
  await a.locator(".attachment-item input[type=checkbox]").check();
  await a.locator("#send-button").click();
  const spoilerMessage = b.locator('.message:has([data-media-filename="spoiler.png"])').last();
  await spoilerMessage.waitFor({ timeout: 20_000 });
  await spoilerMessage.locator(".media-spoiler-cover").waitFor({ timeout: 20_000 });
  await spoilerMessage.scrollIntoViewIfNeeded();
  const blurredSpoilerPreview = spoilerMessage.locator(".media-preview");
  try {
    await blurredSpoilerPreview.waitFor({ timeout: 5_000 });
  } catch {
    const spoilerState = await spoilerMessage.innerText();
    throw new Error(`Blurred spoiler preview did not load: ${spoilerState}`);
  }
  await blurredSpoilerPreview.evaluate(async (image) => { await (image as HTMLImageElement).decode(); });
  const spoilerPreviewAppearance = await blurredSpoilerPreview.evaluate((image) => {
    const { width, height } = image.getBoundingClientRect();
    return { filter: getComputedStyle(image).filter, naturalWidth: (image as HTMLImageElement).naturalWidth, naturalHeight: (image as HTMLImageElement).naturalHeight, width, height };
  });
  assert.match(spoilerPreviewAppearance.filter, /blur\(/, "spoiler media is blurred rather than hidden behind an opaque cover");
  assert.ok(Math.abs(spoilerPreviewAppearance.width / spoilerPreviewAppearance.height - spoilerPreviewAppearance.naturalWidth / spoilerPreviewAppearance.naturalHeight) < 0.01, "spoiler preview retains the media's intrinsic aspect ratio");
  assert.ok(Math.abs(spoilerPreviewAppearance.width - spoilerPreviewAppearance.naturalWidth) <= 1
    && Math.abs(spoilerPreviewAppearance.height - spoilerPreviewAppearance.naturalHeight) <= 1,
  "spoiler preview keeps the original display dimensions when it fits the chat column");
  await spoilerMessage.locator(".media-spoiler-cover").click();
  await blurredSpoilerPreview.waitFor({ timeout: 20_000 });
  assert.equal(await blurredSpoilerPreview.evaluate((image) => getComputedStyle(image).filter), "none", "revealing spoiler media removes the blur");
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
  const reportHistory = await request(a, `/v1/conversations/${room}/messages?limit=100`);
  assert.equal(reportHistory.status, 200, JSON.stringify(reportHistory.body));
  const bobAuthoredMessage = reportHistory.body.messages
    .filter((message: { senderUserId: string | null }) => message.senderUserId === users[1].id)
    .at(-1);
  assert.ok(bobAuthoredMessage, "the reported message is authored by the named target");
  const reporterEvidenceText = "report evidence plaintext sentinel";
  const bobMessageForReport = a.locator(".message").filter({ hasText: "Bob to Alice: independent device keys work" });
  await bobMessageForReport.hover();
  await bobMessageForReport.getByRole("button", { name: "Actions for message from bob" }).click();
  await a.locator("#message-context-menu").getByText("Report message", { exact: true }).click();
  const reportDialog = a.locator(".report-dialog");
  await reportDialog.waitFor({ state: "visible", timeout: 20_000 });
  await a.waitForFunction(() => {
    const checkbox = document.querySelector<HTMLInputElement>(".report-dialog input[type='checkbox']");
    return checkbox !== null && !checkbox.disabled;
  }, undefined, { timeout: 20_000 });
  await reportDialog.locator("select").selectOption("harassment");
  await reportDialog.locator("input[type='checkbox']").check();
  await reportDialog.locator("textarea").fill(reporterEvidenceText);
  await reportDialog.getByRole("button", { name: "Submit report" }).click();
  await reportDialog.waitFor({ state: "detached", timeout: 20_000 });
  const queuedReportList = await request(operator, "/v1/instance-admin/reports?status=open");
  const submittedReportId = queuedReportList.body.reports.find(
    (report: { messageId: string | null }) => report.messageId === bobAuthoredMessage.id,
  )?.id;
  assert.ok(submittedReportId, "the message-report UI submits a report to the host queue");
  const duplicateMessageReport = await request(a, "/v1/reports", {
    targetUserId: users[1].id,
    reason: "harassment",
    conversationId: room,
    messageId: bobAuthoredMessage.id,
  });
  assert.equal(duplicateMessageReport.status, 409, "duplicate open reports by one reporter are rejected");
  const nonAdminReportDetail = await request(a, `/v1/instance-admin/reports/${submittedReportId}`);
  assert.equal(nonAdminReportDetail.status, 401, "chat sessions cannot open instance-wide report details");
  const reportDetail = await request(operator, `/v1/instance-admin/reports/${submittedReportId}`);
  assert.equal(reportDetail.status, 200, JSON.stringify(reportDetail.body));
  assert.equal(reportDetail.body.report.evidence.keyId, publicReportKey.body.keyId);
  assert.equal(JSON.stringify(reportDetail.body).includes(reporterEvidenceText), false, "the API returns ciphertext, never report plaintext");
  const reportList = await request(operator, "/v1/instance-admin/reports?status=open");
  assert.equal(reportList.status, 200);
  assert.equal(reportList.body.reports.find((report: { id: string }) => report.id === submittedReportId)?.hasEvidence, true);
  assert.equal("ciphertext" in reportList.body.reports.find((report: { id: string }) => report.id === submittedReportId), false);

  await operator.locator("#refresh-reports").click();
  const reportQueueItem = operator.locator(".instance-report-item").filter({ hasText: "e2ee_bob" });
  await reportQueueItem.waitFor({ timeout: 20_000 });
  await reportQueueItem.click();
  await operator.locator("#report-detail-title").filter({ hasText: submittedReportId.slice(0, 8) }).waitFor({ timeout: 20_000 });
  await operator.locator("#decrypt-report-evidence").click();
  await operator.locator("#report-evidence-plaintext").filter({ hasText: reporterEvidenceText }).waitFor({ timeout: 20_000 });
  const reportAudit = await request(operator, "/v1/instance-admin/audit?limit=200");
  assert.ok(reportAudit.body.logs.some((log: { action: string; adminUsername: string }) =>
    log.action === "report.evidence_accessed" && log.adminUsername === "e2ee_operator"),
  "admin audit attribution uses the separate operator identity");
  await operator.locator("#mark-report-reviewing").click();
  await operator.locator("#instance-admin-status").filter({ hasText: "Report marked reviewing." }).waitFor({ timeout: 20_000 });

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
  const ownerRole = initialRoles.body.roles.find((role: { id: string; systemKey: string; separateMembers: boolean }) => role.systemKey === "owner");
  assert.equal(ownerRole?.separateMembers, true, "the owner keeps a separate group by default");
  assert.equal(everyoneRole.separateMembers, false, "All members is the unseparated fallback group");
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
  const rejectedEveryoneSeparation = await request(a, `/v1/servers/${serverId}/roles/${everyoneRole.id}`, { separateMembers: true }, "PATCH");
  assert.equal(rejectedEveryoneSeparation.status, 400, JSON.stringify(rejectedEveryoneSeparation.body));
  const restrictedRole = await request(a, `/v1/servers/${serverId}/roles`, {
    encryptedMetadata: "",
    color: "#e05a7a",
    permissions: { view_channels: true, upload_files: true, mention_roles: true },
    mentionable: true,
    viewAllChannels: false,
  });
  assert.equal(restrictedRole.status, 201, JSON.stringify(restrictedRole.body));
  assert.equal(restrictedRole.body.role.separateMembers, false, "new roles join members normally unless separation is enabled");
  const separatedRestrictedRole = await request(a, `/v1/servers/${serverId}/roles/${restrictedRole.body.role.id}`, { separateMembers: true }, "PATCH");
  assert.equal(separatedRestrictedRole.status, 200, JSON.stringify(separatedRestrictedRole.body));
  assert.equal(separatedRestrictedRole.body.role.separateMembers, true);
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

  await b.goto(`${origin}/settings#local-data`);
  const encryptedCacheStatus = b.locator("#message-cache-status");
  await encryptedCacheStatus.waitFor({ timeout: 20_000 });
  await b.waitForFunction(() => !document.querySelector("#message-cache-status")?.textContent?.includes("Checking"), undefined, { timeout: 20_000 });
  const cacheStatusText = await encryptedCacheStatus.innerText();
  const cachedMessageCount = Number(cacheStatusText.match(/([\d,]+) cached encrypted messages?/)?.[1]?.replaceAll(",", "") ?? 0);
  assert.ok(cachedMessageCount > 0, `browser reports encrypted message cache usage: ${cacheStatusText}`);
  b.once("dialog", (dialog) => { void dialog.accept(); });
  await b.locator("#clear-message-cache-button").click();
  await b.locator("#settings-status").filter({ hasText: "Cleared " }).waitFor({ timeout: 20_000 });
  await b.waitForFunction(() => document.querySelector("#message-cache-status")?.textContent?.startsWith("0 cached encrypted messages"), undefined, { timeout: 20_000 });
  await b.goto(bobChatUrl);
  await b.locator("#message-input:enabled").waitFor({ timeout: 20_000 });
  await send(a, b, "Cache-only cleanup kept local room keys working");
  await b.locator(".message").filter({ hasText: "Cache-only cleanup kept local room keys working" }).waitFor({ timeout: 20_000 });

  const removeReportedMessage = await request(operator, `/v1/instance-admin/reports/${submittedReportId}/remove-message`, {});
  assert.equal(removeReportedMessage.status, 200, JSON.stringify(removeReportedMessage.body));
  const historyAfterModeration = await request(a, `/v1/conversations/${room}/messages?limit=100`);
  assert.equal(historyAfterModeration.body.messages.some((message: { id: string }) => message.id === bobAuthoredMessage.id), false);
  const unauthorizedSuspension = await request(a, `/v1/instance-admin/users/${users[1].id}/suspend`, {});
  assert.equal(unauthorizedSuspension.status, 401, "space owners cannot suspend accounts instance-wide");
  const suspendedBob = await request(operator, `/v1/instance-admin/users/${users[1].id}/suspend`, {
    reportId: submittedReportId,
  });
  assert.equal(suspendedBob.status, 200, JSON.stringify(suspendedBob.body));
  const suspendedSession = await request(b, "/v1/me");
  assert.equal(suspendedSession.status, 401, "account suspension revokes existing sessions");
  const suspendedLogin = await request(b, "/v1/auth/login", {
    username: "e2ee_bob", password: "Account-password-for-e2ee-test!",
  });
  assert.equal(suspendedLogin.status, 403);
  assert.equal(suspendedLogin.body.error, "account_suspended");
  const restoredBob = await request(operator, `/v1/instance-admin/users/${users[1].id}/suspension`, undefined, "DELETE");
  assert.equal(restoredBob.status, 200, JSON.stringify(restoredBob.body));
  const restoredLogin = await request(b, "/v1/auth/login", {
    username: "e2ee_bob", password: "Account-password-for-e2ee-test!",
  });
  assert.equal(restoredLogin.status, 200, JSON.stringify(restoredLogin.body));
  assert.equal((await request(operator, "/v1/instance-admin/auth/logout", {})).status, 200);
  assert.equal((await request(operator, "/v1/instance-admin/auth/me")).status, 401, "operator logout revokes the separate admin session");

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
  await closeAdminDatabase();
  await appDatabaseAdmin.unsafe(`drop schema ${schema} cascade`);
  await adminDatabaseAdmin.unsafe(`drop schema ${adminSchema} cascade`);
  await appDatabaseAdmin.close();
  await adminDatabaseAdmin.close();
}
