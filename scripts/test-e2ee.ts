import assert from "node:assert/strict";
import { SQL } from "bun";
import { chromium, type Page } from "playwright";

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
  const users = [];
  for (const [page, name] of [[a, "alice"], [b, "bob"]] as const) {
    await page.goto(origin);
    const response = await request(page, "/v1/auth/register", {
      username: `e2ee_${name}`, password: "Account-password-for-e2ee-test!", displayName: name,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    users.push(response.body.user);
  }

  const createdServer = await request(a, "/v1/servers", {});
  assert.equal(createdServer.status, 201, JSON.stringify(createdServer.body));
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
  const rejoined = await request(b, `/v1/invites/${encodeURIComponent(secondInvite.body.invite.token)}/accept`, {});
  assert.equal(rejoined.status, 200, JSON.stringify(rejoined.body));

  await unlock(a, "/app");
  await unlock(b, "/app");
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

  async function send(sender: Page, recipient: Page, body: string) {
    await sender.locator("#message-input").fill(body);
    await sender.locator("#send-button").click();
    await sender.locator(".message").filter({ hasText: body }).waitFor({ timeout: 20_000 });
    await recipient.locator(".message").filter({ hasText: body }).waitFor({ timeout: 20_000 });
  }

  await a.goto(`${origin}/channels/@me/${room}`);
  await a.locator("#message-input:enabled").waitFor({ timeout: 20_000 });
  await send(a, b, "Alice to Bob: decrypted through the real transport");
  assert.equal(await b.locator(".message").filter({ hasText: "Alice to Bob: decrypted through the real transport" }).getByRole("button", { name: "Edit", exact: true }).count(), 0);
  await a.locator("#message-input").fill(":smi");
  await a.locator("#emoji-suggestions").waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await a.locator(".emoji-suggestion").filter({ hasText: ":smiley:" }).count(), 1);
  await a.locator(".emoji-suggestion").filter({ hasText: ":smiley:" }).click();
  assert.equal(await a.locator("#message-input").inputValue(), "😃");
  await a.locator("#message-input").fill(":smile: native 😄");
  await a.locator("#send-button").click();
  const emojiMessage = b.locator(".message").filter({ hasText: "native" });
  await emojiMessage.waitFor({ timeout: 20_000 });
  assert.equal(await emojiMessage.locator('img[src$="/assets/twemoji/1f604.svg"]').count(), 2);
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

  const deletedConversation = await request(a, `/v1/conversations/${room}`, undefined, "DELETE");
  assert.equal(deletedConversation.status, 200, JSON.stringify(deletedConversation.body));
  const deletedServer = await request(a, `/v1/servers/${createdServer.body.server.id}`, undefined, "DELETE");
  assert.equal(deletedServer.status, 200, JSON.stringify(deletedServer.body));
  console.log("PASS: two independent browser stores decrypt messages in both directions over the real server");
} finally {
  await browser.close();
  await app.stop();
  closeRedis();
  await closeDatabase();
  await admin.unsafe(`drop schema ${schema} cascade`);
  await admin.close();
}
