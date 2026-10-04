import assert from "node:assert/strict";
import { SQL } from "bun";

// Exercises the object-level authorization fixes over real HTTP against a temporary database
// schema: attachment upload ownership, warning revocation against a departed member, and the block
// check on profile media.

const appDatabaseBaseUrl = Bun.env.DATABASE_URL ?? "postgres://localhost:5432/priv_chat";
const adminDatabaseBaseUrl = Bun.env.ADMIN_DATABASE_URL ?? appDatabaseBaseUrl;
const appDatabaseAdmin = new SQL(appDatabaseBaseUrl);
const adminDatabaseAdmin = new SQL(adminDatabaseBaseUrl);
const schema = `access_control_test_${crypto.randomUUID().replaceAll("-", "")}`;
const adminSchema = `access_control_admin_${crypto.randomUUID().replaceAll("-", "")}`;
await appDatabaseAdmin.unsafe(`create schema ${schema}`);
await adminDatabaseAdmin.unsafe(`create schema ${adminSchema}`);
const databaseUrl = new URL(appDatabaseBaseUrl);
databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
Bun.env.DATABASE_URL = databaseUrl.toString();
const isolatedAdminDatabaseUrl = new URL(adminDatabaseBaseUrl);
isolatedAdminDatabaseUrl.searchParams.set("options", `-c search_path=${adminSchema}`);
Bun.env.ADMIN_DATABASE_URL = isolatedAdminDatabaseUrl.toString();
Bun.env.NODE_ENV = "test";
Bun.env.KLIPY_API_KEY = "access-control-klipy-public-key";
Bun.env.ATTACHMENTS_DIR = `${schema}-attachments`;

// Authentication limits are charged per instance and per client address, so the run gets its own
// Redis database and a clean slate.
const testRedisUrl = new URL(Bun.env.REDIS_URL ?? "redis://localhost:6379");
testRedisUrl.pathname = "/13";
Bun.env.REDIS_URL = testRedisUrl.toString();
{
  const { RedisClient } = await import("bun");
  const flush = new RedisClient(testRedisUrl.toString(), { autoReconnect: false, maxRetries: 1 });
  try {
    await flush.connect();
    await flush.send("FLUSHDB", []);
  } catch {
    // A Redis that cannot be reached surfaces as a limiter outage inside the assertions.
  } finally {
    if (flush.connected) flush.close();
  }
}

const { closeDatabase, db } = await import("../src/db/client");
const { closeAdminDatabase } = await import("../src/admin-db/client");
const { closeRedis } = await import("../src/redis/client");
const { migrate } = await import("../src/db/migrate");
const { migrateAdminDatabase } = await import("../src/admin-db/migrate");
const { createApp } = await import("../src/app");

const app = createApp();
let failure: unknown;

try {
  await migrate();
  await migrateAdminDatabase();
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${app.server!.port}`;

  async function register(username: string) {
    const response = await fetch(`${origin}/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        // Distinct, unrelated, and off the blocklist so registration is not refused with 422.
        password: `unrelated-passphrase-${username}-91`,
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 201, `register ${username}: ${text}`);
    return JSON.parse(text) as { user: { id: string }; token: string };
  }

  async function api(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json",
    raw?: Uint8Array,
  ) {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let payload: BodyInit | undefined;
    if (raw) {
      headers["content-type"] = contentType;
      payload = new Uint8Array(raw);
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${origin}${path}`, { method, headers, body: payload });
    const text = await response.text();
    // A profile-media read answers with image bytes rather than JSON.
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      parsed = { bytes: text.length };
    }
    return { status: response.status, body: parsed };
  }

  const alice = await register("access_alice");
  const bob = await register("access_bob");

  // A shared space is created first: private conversations are addressable only through an
  // existing trust boundary, so the two accounts need a common server before they can message.
  const server = await api(bob.token, "POST", "/v1/servers", {
    name: Buffer.from("access-control-space").toString("base64url"),
  });
  assert.equal(server.status, 201, `create server: ${JSON.stringify(server.body)}`);
  const serverId = (server.body.server as { id: string }).id;

  const invite = await api(bob.token, "POST", `/v1/servers/${serverId}/invites`, {});
  assert.equal(invite.status, 201, `create invite: ${JSON.stringify(invite.body)}`);
  const inviteToken = (invite.body.invite as { token: string }).token;

  const accepted = await api(alice.token, "POST", `/v1/invites/${inviteToken}/accept`, {});
  assert.equal(accepted.status, 200, `accept invite: ${JSON.stringify(accepted.body)}`);

  // 1. Attachment upload ownership.
  //
  // Bob opens a direct conversation with Alice and raises a pending attachment in it. Alice must
  // not be able to write its bytes, even though she is a member of the same conversation.
  const conversation = await api(bob.token, "POST", "/v1/conversations", {
    kind: "dm",
    memberUserIds: [alice.user.id],
  });
  assert.equal(conversation.status, 201, `create conversation: ${JSON.stringify(conversation.body)}`);
  const conversationId = (conversation.body.conversation as { id: string }).id;

  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const created = await api(bob.token, "POST", `/v1/conversations/${conversationId}/attachments`, {
    expectedSizeBytes: payload.byteLength,
    extension: "bin",
    mimeType: "application/octet-stream",
  });
  assert.equal(created.status, 201, `create attachment: ${JSON.stringify(created.body)}`);
  const attachmentId = (created.body.attachment as { id: string }).id;

  // Alice is a member of the conversation but not the uploader.
  const aliceUpload = await api(alice.token, "PUT", `/v1/attachments/${attachmentId}`, undefined, "application/octet-stream", payload);
  assert.equal(
    aliceUpload.status,
    404,
    `a non-uploader conversation member must not write the attachment, got ${JSON.stringify(aliceUpload.body)}`,
  );

  // The uploader still can, proving the check is scoped rather than simply closed.
  const bobUpload = await api(bob.token, "PUT", `/v1/attachments/${attachmentId}`, undefined, "application/octet-stream", payload);
  assert.equal(bobUpload.status, 200, `the uploader can still upload: ${JSON.stringify(bobUpload.body)}`);

  const stored = await db<{ uploaded_by: string; status: string }[]>`
    select uploaded_by, status from attachments where id = ${attachmentId}
  `;
  assert.equal(stored[0]?.uploaded_by, bob.user.id, "the attachment still records Bob as uploader");

  // 2. Warning revocation against a member who has left.
  //
  // Bob warns Alice, then Alice leaves. The hierarchy check used to be skipped entirely when the
  // target no longer resolved to a member, so the revocation went through unchecked.
  const warned = await api(bob.token, "POST", `/v1/servers/${serverId}/members/${alice.user.id}/warnings`, {
    reason: "access control probe",
  });
  assert.equal(warned.status, 201, `warn member: ${JSON.stringify(warned.body)}`);
  const warningId = (warned.body.warning as { id: string }).id;

  // Alice leaves, so the warning target no longer resolves to a member.
  const left = await api(alice.token, "POST", `/v1/servers/${serverId}/leave`, {});
  assert.equal(left.status, 200, `leave server: ${JSON.stringify(left.body)}`);

  const [departedWarning] = await db<{ user_id: string }[]>`
    select user_id from server_member_warnings where id = ${warningId}
  `;
  assert.equal(departedWarning?.user_id, alice.user.id, "the warning still targets the departed member");

  const revoke = await api(bob.token, "DELETE", `/v1/servers/${serverId}/warnings/${warningId}`);
  assert.equal(
    revoke.status,
    403,
    `revoking a warning against a departed member must fail closed, got ${JSON.stringify(revoke.body)}`,
  );

  const stillActive = await db<{ revoked_at: Date | null }[]>`
    select revoked_at from server_member_warnings where id = ${warningId}
  `;
  assert.equal(stillActive[0]?.revoked_at, null, "the warning was not revoked");

  // 3. Profile media honours a block.
  //
  // Alice blocks Bob. Bob must no longer be able to fetch her avatar or banner by id, even though
  // both are otherwise readable by any authenticated account.
  await api(alice.token, "PUT", "/v1/me/avatar", undefined, "image/png", new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  ]));
  await api(alice.token, "PUT", "/v1/me/banner", undefined, "image/png", new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  ]));

  const beforeBlock = await api(bob.token, "GET", `/v1/users/${alice.user.id}/avatar`);
  assert.equal(beforeBlock.status, 200, "profile media is readable before a block");

  const block = await api(alice.token, "POST", `/v1/users/${bob.user.id}/block`, {});
  assert.equal(block.status, 200, `block user: ${JSON.stringify(block.body)}`);

  const blockedAvatar = await api(bob.token, "GET", `/v1/users/${alice.user.id}/avatar`);
  assert.equal(blockedAvatar.status, 403, `a blocked party must not read the blocker's avatar, got ${JSON.stringify(blockedAvatar.body)}`);
  assert.equal(blockedAvatar.body.error, "blocked_user", JSON.stringify(blockedAvatar.body));

  const blockedBanner = await api(bob.token, "GET", `/v1/users/${alice.user.id}/banner`);
  assert.equal(blockedBanner.status, 403, `a blocked party must not read the blocker's banner, got ${JSON.stringify(blockedBanner.body)}`);

  // The blocker can still read her own media.
  const ownAvatar = await api(alice.token, "GET", `/v1/users/${alice.user.id}/avatar`);
  assert.equal(ownAvatar.status, 200, "the blocker can still read her own avatar");

  console.log("PASS: attachment ownership, warning revocation, and block-scoped profile media are enforced");
} catch (error) {
  failure = error;
} finally {
  await app.stop(true);
  closeRedis();
  await closeDatabase();
  await closeAdminDatabase();
  await appDatabaseAdmin.unsafe(`drop schema ${schema} cascade`);
  await adminDatabaseAdmin.unsafe(`drop schema ${adminSchema} cascade`);
  await Bun.$`rm -rf ${Bun.env.ATTACHMENTS_DIR!}`.quiet().catch(() => undefined);
}

if (failure) throw failure;
process.exit(0);
