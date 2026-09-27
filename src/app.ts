import { password } from "bun";
import { Elysia, t } from "elysia";
import {
  AttachmentSizeMismatchError,
  AttachmentTooLargeError,
  attachmentPath,
  encryptedAttachmentExists,
  removeEncryptedAttachment,
  storeEncryptedAttachment,
} from "./attachments/storage";
import {
  authenticate,
  createSession,
  deleteSession,
  extractBearerToken,
  extractCookieToken,
  hashSessionToken,
  normalizeUsername,
  verifyPassword,
} from "./auth/session";
import { config } from "./config";
import { decodeBase64, encodeBase64, InvalidEncodingError } from "./encoding";
import { db, pingDatabase } from "./db/client";
import { pingRedis, publishMessageCreated } from "./redis/client";
import { createRealtimeConnection, type RealtimeConnection } from "./realtime";

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_device_id: string;
  client_message_id: string;
  server_sequence: bigint | number | string;
  protocol: string;
  ciphertext: Buffer;
  protocol_metadata: Buffer;
  created_at: Date;
  sender_user_id?: string;
};

function respondError(set: { status?: number | string }, status: number, error: string) {
  set.status = status;
  return { error };
}

function setSessionCookie(set: { headers: Record<string, string | number | undefined> }, token: string) {
  const secure = config.environment === "production" ? "; Secure" : "";
  set.headers["set-cookie"] =
    `priv_chat_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionTtlSeconds}${secure}`;
}

function clearSessionCookie(set: { headers: Record<string, string | number | undefined> }) {
  const secure = config.environment === "production" ? "; Secure" : "";
  set.headers["set-cookie"] = `priv_chat_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

async function publicFile(name: string, contentType: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const file = Bun.file(`${import.meta.dir}/../public/${name}`);
  if (!(await file.exists())) return null;
  return new Response(file, { headers: { "cache-control": "no-cache", "content-type": contentType } });
}

function isUniqueViolation(error: unknown) {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "23505";
}

function toPublicUser(user: Pick<UserRow, "id" | "username" | "display_name" | "created_at">) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    createdAt: user.created_at,
  };
}

function toMessage(message: MessageRow) {
  return {
    id: message.id,
    conversationId: message.conversation_id,
    senderDeviceId: message.sender_device_id,
    clientMessageId: message.client_message_id,
    serverSequence: String(message.server_sequence),
    protocol: message.protocol,
    senderUserId: message.sender_user_id ?? null,
    ciphertext: encodeBase64(message.ciphertext),
    protocolMetadata: encodeBase64(message.protocol_metadata),
    createdAt: message.created_at,
  };
}

const imageMimeExtensions: Record<string, string[]> = {
  avif: ["image/avif"],
  gif: ["image/gif"],
  heic: ["image/heic"],
  jpeg: ["image/jpeg"],
  jpg: ["image/jpeg"],
  png: ["image/png"],
  webp: ["image/webp"],
};

const videoMimeExtensions: Record<string, string[]> = {
  mp4: ["video/mp4"],
  mov: ["video/quicktime"],
  ogg: ["video/ogg"],
  ogv: ["video/ogg"],
  webm: ["video/webm"],
};

function attachmentMetadata(extension: string, mimeType: string) {
  const normalizedExtension = extension.toLowerCase();
  const normalizedMimeType = mimeType.toLowerCase();
  const allowed = imageMimeExtensions[normalizedExtension] ?? videoMimeExtensions[normalizedExtension];
  if (allowed && !allowed.includes(normalizedMimeType)) return null;
  if (!allowed && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalizedMimeType)) return null;
  return { extension: normalizedExtension, mimeType: normalizedMimeType };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function validCryptoKey(value: unknown) {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > 16 * 1024) return false;
  if (typeof value === "string") return value.length > 0;
  const object = objectValue(value);
  return Boolean(object && typeof object.key === "string" && object.key.length > 0 && object.key.length <= 4096);
}

function matrixUserId(userId: string) {
  return `@${userId}:priv-chat`;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseCryptoUpload(value: unknown) {
  const body = objectValue(value);
  const deviceKeys = objectValue(body?.device_keys);
  const keys = objectValue(deviceKeys?.keys);
  const deviceId = deviceKeys?.device_id ?? body?.device_id;
  const oneTimeKeys = objectValue(body?.one_time_keys) ?? {};
  const fallbackKeys = objectValue(body?.fallback_keys) ?? {};
  if (!isUuid(deviceId)) return null;
  if (deviceKeys && (!keys || typeof deviceKeys.user_id !== "string" || deviceKeys.device_id !== deviceId)) return null;
  if (Object.keys(oneTimeKeys).length > 100 || Object.keys(fallbackKeys).length > 10) return null;
  if (keys && !Object.values(keys).every((key) => typeof key === "string")) return null;
  if (!Object.values(oneTimeKeys).every(validCryptoKey)) return null;
  if (!Object.values(fallbackKeys).every(validCryptoKey)) return null;
  return { deviceId, deviceKeys, oneTimeKeys, fallbackKeys };
}

function decodeEncryptedMetadata(value: string | undefined) {
  if (!value) return Buffer.alloc(0);
  return decodeBase64(value, "encryptedMetadata", 64 * 1024, true);
}

async function serverMembership(serverId: string, userId: string) {
  const [membership] = await db<{ role: "owner" | "admin" | "member" }[]>`
    select role from server_members
    where server_id = ${serverId} and user_id = ${userId} and left_at is null
  `;
  return membership;
}

function canManageServer(role: "owner" | "admin" | "member") {
  return role === "owner" || role === "admin";
}

function newInviteToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

async function hashInviteToken(token: string) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

const userBody = t.Object({
  username: t.String({ minLength: 3, maxLength: 32, pattern: "^[A-Za-z0-9_.-]+$" }),
  password: t.String({ minLength: 12, maxLength: 128 }),
  displayName: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
});

const encryptedBytes = (maxLength: number) => t.String({ minLength: 1, maxLength });

const realtimeCommand = t.Union([
  t.Object({
    type: t.Literal("subscribe"),
    conversationId: t.String({ format: "uuid" }),
  }),
  t.Object({
    type: t.Literal("unsubscribe"),
    conversationId: t.String({ format: "uuid" }),
  }),
  t.Object({
    type: t.Literal("typing"),
    conversationId: t.String({ format: "uuid" }),
    isTyping: t.Boolean(),
  }),
  t.Object({
    type: t.Literal("presence"),
    conversationId: t.String({ format: "uuid" }),
    state: t.Union([t.Literal("online"), t.Literal("idle"), t.Literal("offline")]),
  }),
]);

export function createApp() {
  const realtimeConnections = new WeakMap<object, RealtimeConnection>();

  return new Elysia()
    .onError(({ code, set }) => {
      if (code === "VALIDATION") return respondError(set, 422, "validation_error");
      console.error("Unhandled request error");
      return respondError(set, 500, "internal_error");
    })
    .get("/", async () => {
      return await publicFile("index.html", "text/html; charset=utf-8")
         ?? { name: "Naigi", version: "1.7.0" };
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
    .get("/favicon.svg", async ({ set }) => {
      const file = await publicFile("favicon.svg", "image/svg+xml");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/assets/twemoji/:asset", async ({ params, set }) => {
      if (!/^[A-Za-z0-9_.-]+$/.test(params.asset) || !params.asset.endsWith(".svg") && params.asset !== "NOTICE.txt") {
        return respondError(set, 404, "asset_not_found");
      }
      const file = Bun.file(`${import.meta.dir}/../public/assets/twemoji/${params.asset}`);
      if (!(await file.exists())) return respondError(set, 404, "asset_not_found");
      return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable", "content-type": params.asset.endsWith(".svg") ? "image/svg+xml" : "text/plain; charset=utf-8" } });
    })
    .get("/assets/:asset", async ({ params, set }) => {
      if (params.asset === "." || params.asset === ".." || !/^[A-Za-z0-9_.-]+$/.test(params.asset)) {
        return respondError(set, 404, "asset_not_found");
      }
      const file = Bun.file(`${import.meta.dir}/../public/assets/${params.asset}`);
      if (!(await file.exists())) return respondError(set, 404, "asset_not_found");
      const contentType = params.asset.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
      return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable", "content-type": contentType } });
    })
    .get("/health/live", () => ({ status: "ok" }))
    .get("/health/ready", async ({ set }) => {
      const [database, redis] = await Promise.allSettled([pingDatabase(), pingRedis()]);
      const ready = database.status === "fulfilled" && redis.status === "fulfilled";
      const response = {
        status: ready ? "ok" : "degraded",
        dependencies: {
          database: database.status === "fulfilled" ? "ok" : "unavailable",
          redis: redis.status === "fulfilled" ? "ok" : "unavailable",
        },
      };

      if (!ready) set.status = 503;
      return response;
    })
    .post("/v1/auth/register", async ({ body, set }) => {
      const username = normalizeUsername(body.username);
      const displayName = body.displayName?.trim() || body.username;
      const passwordHash = await password.hash(body.password);

      try {
        const [user] = await db<UserRow[]>`
          insert into users (username, username_normalized, password_hash, display_name)
          values (${body.username}, ${username}, ${passwordHash}, ${displayName})
          returning id, username, display_name, password_hash, created_at
        `;
        const session = await createSession(user.id);
        setSessionCookie(set, session.token);
        set.status = 201;
        return { user: toPublicUser(user), ...session };
      } catch (error) {
        if (isUniqueViolation(error)) return respondError(set, 409, "username_taken");
        throw error;
      }
    }, { body: userBody })
    .post("/v1/auth/login", async ({ body, set }) => {
      const [user] = await db<UserRow[]>`
        select id, username, display_name, password_hash, created_at
        from users
        where username_normalized = ${normalizeUsername(body.username)}
      `;
      const valid = await verifyPassword(user, body.password);
      if (!valid || !user) return respondError(set, 401, "invalid_credentials");

      const session = await createSession(user.id);
      setSessionCookie(set, session.token);
      return { user: toPublicUser(user), ...session };
    }, { body: userBody })
    .post("/v1/auth/logout", async ({ headers, set }) => {
      const token = extractBearerToken(headers.authorization) ?? extractCookieToken(headers.cookie);
      await deleteSession(token);
      clearSessionCookie(set);
      return { loggedOut: true };
    })
    .get("/v1/me", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      return { user };
    })
    .patch("/v1/me", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const displayName = body.displayName.trim();
      if (!displayName) return respondError(set, 400, "invalid_display_name");
      const [updated] = await db<UserRow[]>`
        update users
        set display_name = ${displayName}, updated_at = now()
        where id = ${user.id}
        returning id, username, display_name, password_hash, created_at
      `;
      return { user: toPublicUser(updated) };
    }, {
      body: t.Object({ displayName: t.String({ minLength: 1, maxLength: 80 }) }),
    })
    .post("/v1/auth/password", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [record] = await db<UserRow[]>`
        select id, username, display_name, password_hash, created_at
        from users where id = ${user.id}
      `;
      if (!await verifyPassword(record, body.currentPassword)) return respondError(set, 400, "current_password_incorrect");
      const passwordHash = await password.hash(body.newPassword);
      await db`
        update users set password_hash = ${passwordHash}, updated_at = now()
        where id = ${user.id}
      `;
      const token = extractBearerToken(headers.authorization) ?? extractCookieToken(headers.cookie);
      if (token) {
        const tokenHash = await hashSessionToken(token);
        await db`
          delete from sessions where user_id = ${user.id} and token_hash <> ${tokenHash}
        `;
      }
      return { updated: true };
    }, {
      body: t.Object({
        currentPassword: t.String({ minLength: 1, maxLength: 128 }),
        newPassword: t.String({ minLength: 12, maxLength: 128 }),
      }),
    })
    .get("/v1/users/:userId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [profile] = await db<UserRow[]>`
        select id, username, display_name, created_at
        from users
        where id = ${params.userId}
      `;
      if (!profile) return respondError(set, 404, "user_not_found");
      return { user: toPublicUser(profile) };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      const created = await db.begin(async (transaction) => {
        const [server] = await transaction<{ id: string; owner_id: string; created_at: Date }[]>`
          insert into servers (owner_id, encrypted_metadata)
          values (${user.id}, ${metadata})
          returning id, owner_id, created_at
        `;
        await transaction`
          insert into server_members (server_id, user_id, role)
          values (${server.id}, ${user.id}, 'owner')
        `;
        const [conversation] = await transaction<{ id: string }[]>`
          insert into conversations (kind, created_by)
          values ('channel', ${user.id})
          returning id
        `;
        await transaction`
          insert into conversation_members (conversation_id, user_id, role)
          values (${conversation.id}, ${user.id}, 'owner')
        `;
        const [channel] = await transaction<{ id: string; position: number; created_at: Date }[]>`
          insert into channels (server_id, conversation_id, created_by, position)
          values (${server.id}, ${conversation.id}, ${user.id}, 0)
          returning id, position, created_at
        `;
        return { server, channel, conversationId: conversation.id };
      });

      set.status = 201;
      return {
        server: {
          id: created.server.id,
          ownerId: created.server.owner_id,
          encryptedMetadata: encodeBase64(metadata),
          role: "owner",
          channelCount: 1,
          createdAt: created.server.created_at,
        },
        channel: {
          id: created.channel.id,
          serverId: created.server.id,
          conversationId: created.conversationId,
          encryptedMetadata: "",
          categoryId: null,
          kind: "text",
          position: created.channel.position,
          createdAt: created.channel.created_at,
        },
      };
    }, {
      body: t.Object({ encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })) }),
    })
    .get("/v1/servers", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const servers = await db<{
        id: string;
        owner_id: string;
        encrypted_metadata: Buffer;
        role: "owner" | "admin" | "member";
        channel_count: number;
        created_at: Date;
      }[]>`
        select s.id, s.owner_id, s.encrypted_metadata, sm.role,
          count(c.id)::int as channel_count, s.created_at
        from servers s
        join server_members sm on sm.server_id = s.id
        left join channels c on c.server_id = s.id and c.archived_at is null
        where sm.user_id = ${user.id} and sm.left_at is null
        group by s.id, s.owner_id, s.encrypted_metadata, sm.role, s.created_at
        order by s.created_at asc
      `;

      return {
        servers: servers.map((server) => ({
          id: server.id,
          ownerId: server.owner_id,
          encryptedMetadata: encodeBase64(server.encrypted_metadata),
          role: server.role,
          channelCount: server.channel_count,
          createdAt: server.created_at,
        })),
      };
    })
    .get("/v1/servers/:serverId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [server] = await db<{
        id: string;
        owner_id: string;
        encrypted_metadata: Buffer;
        role: "owner" | "admin" | "member";
        channel_count: number;
        created_at: Date;
      }[]>`
        select s.id, s.owner_id, s.encrypted_metadata, sm.role, s.created_at,
          count(c.id)::int as channel_count
        from servers s
        join server_members sm on sm.server_id = s.id
        left join channels c on c.server_id = s.id and c.archived_at is null
        where s.id = ${params.serverId} and sm.user_id = ${user.id} and sm.left_at is null
        group by s.id, s.owner_id, s.encrypted_metadata, sm.role, s.created_at
      `;
      if (!server) return respondError(set, 404, "server_not_found");
      return {
        server: {
          id: server.id,
          ownerId: server.owner_id,
          encryptedMetadata: encodeBase64(server.encrypted_metadata),
          role: server.role,
          channelCount: server.channel_count,
          createdAt: server.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .patch("/v1/servers/:serverId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!canManageServer(membership.role)) return respondError(set, 403, "insufficient_server_permissions");

      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      const [server] = await db<{
        id: string;
        owner_id: string;
        encrypted_metadata: Buffer;
        role: "owner" | "admin" | "member";
        channel_count: number;
        created_at: Date;
      }[]>`
        update servers s
        set encrypted_metadata = ${metadata}, updated_at = now()
        where s.id = ${params.serverId}
        returning s.id, s.owner_id, s.encrypted_metadata,
          (select role from server_members where server_id = s.id and user_id = ${user.id} and left_at is null) as role,
          (select count(*)::int from channels where server_id = s.id and archived_at is null) as channel_count,
          s.created_at
      `;
      if (!server) return respondError(set, 404, "server_not_found");
      return {
        server: {
          id: server.id,
          ownerId: server.owner_id,
          encryptedMetadata: encodeBase64(server.encrypted_metadata),
          role: server.role,
          channelCount: server.channel_count,
          createdAt: server.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({ encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })) }),
    })
    .delete("/v1/servers/:serverId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 404, "server_not_found");
      if (membership.role !== "owner") return respondError(set, 403, "only_server_owner_can_delete");

      const attachments = await db<{ storage_key: string }[]>`
        select a.storage_key
        from attachments a
        join channels c on c.conversation_id = a.conversation_id
        where c.server_id = ${params.serverId}
      `;
      const [deleted] = await db<{ id: string }[]>`
        delete from servers
        where id = ${params.serverId} and owner_id = ${user.id}
        returning id
      `;
      if (!deleted) return respondError(set, 404, "server_not_found");
      await Promise.all(attachments.map((attachment) => removeEncryptedAttachment(attachment.storage_key)));
      return { deleted: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/servers/:serverId/channels", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!await serverMembership(params.serverId, user.id)) return respondError(set, 403, "not_a_server_member");

      const channels = await db<{
        id: string;
        server_id: string;
        conversation_id: string;
        encrypted_metadata: Buffer;
        category_id: string | null;
        kind: string;
        position: number;
        created_at: Date;
      }[]>`
        select id, server_id, conversation_id, encrypted_metadata, category_id, kind, position, created_at
        from channels
        where server_id = ${params.serverId} and archived_at is null
        order by position asc, created_at asc
      `;
      return {
        channels: channels.map((channel) => ({
          id: channel.id,
          serverId: channel.server_id,
          conversationId: channel.conversation_id,
          encryptedMetadata: encodeBase64(channel.encrypted_metadata),
          categoryId: channel.category_id,
          kind: channel.kind,
          position: channel.position,
          createdAt: channel.created_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/channels", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!canManageServer(membership.role)) return respondError(set, 403, "insufficient_server_permissions");

      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      const created = await db.begin(async (transaction) => {
        const [position] = await transaction<{ next_position: number }[]>`
          select coalesce(max(position), -1) + 1 as next_position
          from channels where server_id = ${params.serverId} and archived_at is null
        `;
        if (body.categoryId !== null && body.categoryId !== undefined) {
          const [category] = await transaction<{ id: string }[]>`
            select id from categories
            where id = ${body.categoryId} and server_id = ${params.serverId} and archived_at is null
          `;
          if (!category) return { error: "category_not_found" as const };
        }
        const [conversation] = await transaction<{ id: string }[]>`
          insert into conversations (kind, created_by)
          values ('channel', ${user.id})
          returning id
        `;
        await transaction`
          insert into conversation_members (conversation_id, user_id, role)
          select ${conversation.id}, user_id, case when role = 'owner' then 'owner' else 'member' end
          from server_members
          where server_id = ${params.serverId} and left_at is null
          on conflict (conversation_id, user_id) do nothing
        `;
        const [channel] = await transaction<{ id: string; position: number; created_at: Date }[]>`
          insert into channels (server_id, conversation_id, created_by, encrypted_metadata, category_id, position)
          values (${params.serverId}, ${conversation.id}, ${user.id}, ${metadata}, ${body.categoryId ?? null}, ${body.position ?? position.next_position})
          returning id, position, created_at
        `;
        return { channel, conversationId: conversation.id };
      });

      if ("error" in created) return respondError(set, 404, "category_not_found");
      set.status = 201;
      return {
        channel: {
          id: created.channel.id,
          serverId: params.serverId,
          conversationId: created.conversationId,
          encryptedMetadata: encodeBase64(metadata),
          categoryId: body.categoryId ?? null,
          kind: "text",
          position: created.channel.position,
          createdAt: created.channel.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        categoryId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
      }),
    })
    .patch("/v1/servers/:serverId/channels/:channelId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!canManageServer(membership.role)) return respondError(set, 403, "insufficient_server_permissions");

      const [existing] = await db<{ id: string; encrypted_metadata: Buffer }[]>`
        select id, encrypted_metadata from channels
        where id = ${params.channelId} and server_id = ${params.serverId} and archived_at is null
      `;
      if (!existing) return respondError(set, 404, "channel_not_found");

      if (body.categoryId !== undefined && body.categoryId !== null) {
        const [category] = await db<{ id: string }[]>`
          select id from categories
          where id = ${body.categoryId} and server_id = ${params.serverId} and archived_at is null
        `;
        if (!category) return respondError(set, 404, "category_not_found");
      }

      let metadata: Buffer | undefined;
      try {
        metadata = body.encryptedMetadata === undefined
          ? undefined
          : decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      type ChannelUpdateRow = {
        id: string;
        server_id: string;
        conversation_id: string;
        encrypted_metadata: Buffer;
        category_id: string | null;
        kind: string;
        position: number;
        created_at: Date;
      };
      const channelRows = body.categoryId === undefined
        ? await db<ChannelUpdateRow[]>`
            update channels
            set encrypted_metadata = coalesce(${metadata ?? null}, encrypted_metadata),
                position = coalesce(${body.position ?? null}, position)
            where id = ${existing.id}
            returning id, server_id, conversation_id, encrypted_metadata, category_id, kind, position, created_at
          `
        : await db<ChannelUpdateRow[]>`
            update channels
            set encrypted_metadata = coalesce(${metadata ?? null}, encrypted_metadata),
                category_id = ${body.categoryId},
                position = coalesce(${body.position ?? null}, position)
            where id = ${existing.id}
            returning id, server_id, conversation_id, encrypted_metadata, category_id, kind, position, created_at
          `;
      const channel = channelRows[0];
      if (!channel) return respondError(set, 404, "channel_not_found");
      return {
        channel: {
          id: channel.id,
          serverId: channel.server_id,
          conversationId: channel.conversation_id,
          encryptedMetadata: encodeBase64(channel.encrypted_metadata),
          categoryId: channel.category_id,
          kind: channel.kind,
          position: channel.position,
          createdAt: channel.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), channelId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        categoryId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
      }),
    })
    .delete("/v1/servers/:serverId/channels/:channelId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!canManageServer(membership.role)) return respondError(set, 403, "insufficient_server_permissions");
      const [activeCount] = await db<{ count: number }[]>`
        select count(*)::int as count from channels
        where server_id = ${params.serverId} and archived_at is null
      `;
      if (activeCount.count <= 1) return respondError(set, 409, "cannot_archive_last_channel");
      const [metadataAnchor] = await db<{ id: string }[]>`
        select id from channels
        where server_id = ${params.serverId}
        order by created_at asc
        limit 1
      `;
      if (metadataAnchor?.id === params.channelId) return respondError(set, 409, "cannot_archive_metadata_channel");
      const [archived] = await db<{ id: string }[]>`
        update channels set archived_at = coalesce(archived_at, now())
        where id = ${params.channelId} and server_id = ${params.serverId} and archived_at is null
        returning id
      `;
      if (!archived) return respondError(set, 404, "channel_not_found");
      return { archived: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), channelId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/servers/:serverId/categories", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!await serverMembership(params.serverId, user.id)) return respondError(set, 403, "not_a_server_member");
      const categories = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        position: number;
        created_at: Date;
      }[]>`
        select id, server_id, encrypted_metadata, position, created_at
        from categories
        where server_id = ${params.serverId} and archived_at is null
        order by position asc, created_at asc
      `;
      return {
        categories: categories.map((category) => ({
          id: category.id,
          serverId: category.server_id,
          encryptedMetadata: encodeBase64(category.encrypted_metadata),
          position: category.position,
          createdAt: category.created_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/categories", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!canManageServer(membership.role)) return respondError(set, 403, "insufficient_server_permissions");

      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }
      const [position] = await db<{ next_position: number }[]>`
        select coalesce(max(position), -1) + 1 as next_position
        from categories where server_id = ${params.serverId} and archived_at is null
      `;
      const [category] = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        position: number;
        created_at: Date;
      }[]>`
        insert into categories (server_id, created_by, encrypted_metadata, position)
        values (${params.serverId}, ${user.id}, ${metadata}, ${body.position ?? position.next_position})
        returning id, server_id, encrypted_metadata, position, created_at
      `;
      set.status = 201;
      return {
        category: {
          id: category.id,
          serverId: category.server_id,
          encryptedMetadata: encodeBase64(category.encrypted_metadata),
          position: category.position,
          createdAt: category.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
      }),
    })
    .patch("/v1/servers/:serverId/categories/:categoryId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!canManageServer(membership.role)) return respondError(set, 403, "insufficient_server_permissions");

      const [existing] = await db<{ id: string }[]>`
        select id from categories
        where id = ${params.categoryId} and server_id = ${params.serverId} and archived_at is null
      `;
      if (!existing) return respondError(set, 404, "category_not_found");
      let metadata: Buffer | undefined;
      try {
        metadata = body.encryptedMetadata === undefined ? undefined : decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }
      const [category] = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        position: number;
        created_at: Date;
      }[]>`
        update categories
        set encrypted_metadata = coalesce(${metadata ?? null}, encrypted_metadata),
            position = coalesce(${body.position ?? null}, position)
        where id = ${existing.id}
        returning id, server_id, encrypted_metadata, position, created_at
      `;
      return {
        category: {
          id: category.id,
          serverId: category.server_id,
          encryptedMetadata: encodeBase64(category.encrypted_metadata),
          position: category.position,
          createdAt: category.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), categoryId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
      }),
    })
    .delete("/v1/servers/:serverId/categories/:categoryId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!canManageServer(membership.role)) return respondError(set, 403, "insufficient_server_permissions");
      const archived = await db.begin(async (transaction) => {
        const [category] = await transaction<{ id: string }[]>`
          update categories set archived_at = coalesce(archived_at, now())
          where id = ${params.categoryId} and server_id = ${params.serverId} and archived_at is null
          returning id
        `;
        if (!category) return false;
        await transaction`
          update channels set category_id = null
          where server_id = ${params.serverId} and category_id = ${params.categoryId}
        `;
        return true;
      });
      if (!archived) return respondError(set, 404, "category_not_found");
      return { archived: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), categoryId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/servers/:serverId/members", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!await serverMembership(params.serverId, user.id)) return respondError(set, 403, "not_a_server_member");

      const members = await db<{
        id: string;
        username: string;
        display_name: string;
        role: "owner" | "admin" | "member";
        joined_at: Date;
      }[]>`
        select u.id, u.username, u.display_name, sm.role, sm.joined_at
        from server_members sm
        join users u on u.id = sm.user_id
        where sm.server_id = ${params.serverId} and sm.left_at is null
        order by sm.joined_at asc
      `;
      return {
        members: members.map((member) => ({
          userId: member.id,
          username: member.username,
          displayName: member.display_name,
          role: member.role,
          joinedAt: member.joined_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/servers/:serverId/invites", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!canManageServer(membership.role)) return respondError(set, 403, "insufficient_server_permissions");
      const invites = await db<{
        id: string;
        max_uses: number;
        uses: number;
        expires_at: Date | null;
        revoked_at: Date | null;
        created_at: Date;
      }[]>`
        select id, max_uses, uses, expires_at, revoked_at, created_at
        from server_invites
        where server_id = ${params.serverId}
        order by created_at desc
        limit 100
      `;
      return {
        invites: invites.map((invite) => ({
          id: invite.id,
          maxUses: invite.max_uses,
          uses: invite.uses,
          expiresAt: invite.expires_at,
          revokedAt: invite.revoked_at,
          createdAt: invite.created_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/invites", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!canManageServer(membership.role)) return respondError(set, 403, "insufficient_server_permissions");

      const token = newInviteToken();
      const tokenHash = await hashInviteToken(token);
      const [invite] = await db<{
        id: string;
        expires_at: Date | null;
        max_uses: number;
      }[]>`
        insert into server_invites (server_id, created_by, token_hash, max_uses, expires_at)
        values (
          ${params.serverId}, ${user.id}, ${tokenHash}, ${body.maxUses ?? 0},
          ${body.expiresInSeconds ? db`now() + make_interval(secs => ${body.expiresInSeconds})` : null}
        )
        returning id, expires_at, max_uses
      `;
      set.status = 201;
      return { invite: { id: invite.id, token, maxUses: invite.max_uses, expiresAt: invite.expires_at } };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        maxUses: t.Optional(t.Integer({ minimum: 0, maximum: 100_000 })),
        expiresInSeconds: t.Optional(t.Integer({ minimum: 300, maximum: 2_592_000 })),
      }),
    })
    .post("/v1/invites/:token/accept", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const tokenHash = await hashInviteToken(params.token);

      const result = await db.begin(async (transaction) => {
        const [invite] = await transaction<{
          id: string;
          server_id: string;
          max_uses: number;
          uses: number;
          expires_at: Date | null;
          revoked_at: Date | null;
        }[]>`
          select id, server_id, max_uses, uses, expires_at, revoked_at
          from server_invites where token_hash = ${tokenHash} for update
        `;
        if (!invite) return { error: "invite_not_found" as const };
        if (invite.revoked_at || (invite.expires_at && invite.expires_at.getTime() <= Date.now())) {
          return { error: "invite_expired" as const };
        }
        if (invite.max_uses > 0 && invite.uses >= invite.max_uses) return { error: "invite_exhausted" as const };

        const [existingMember] = await transaction<{ left_at: Date | null }[]>`
          select left_at from server_members
          where server_id = ${invite.server_id} and user_id = ${user.id}
        `;
        if (existingMember && existingMember.left_at === null) {
          return { serverId: invite.server_id, joined: false };
        }

        await transaction`
          insert into server_members (server_id, user_id, role)
          values (${invite.server_id}, ${user.id}, 'member')
          on conflict (server_id, user_id) do update
          set role = case when server_members.role in ('owner', 'admin') then server_members.role else 'member' end,
              left_at = null,
              joined_at = now()
        `;
        await transaction`
          insert into conversation_members (conversation_id, user_id, role)
          select c.conversation_id, ${user.id}, 'member'
          from channels c
          where c.server_id = ${invite.server_id} and c.archived_at is null
          on conflict (conversation_id, user_id) do update set left_at = null
        `;
        await transaction`
          update server_invites set uses = uses + 1 where id = ${invite.id}
        `;
        return { serverId: invite.server_id, joined: true };
      });

      if ("error" in result) {
        const error = result.error ?? "invite_not_found";
        return respondError(set, error === "invite_not_found" ? 404 : 409, error);
      }
      return { serverId: result.serverId, joined: result.joined };
    }, {
      params: t.Object({ token: t.String({ minLength: 20, maxLength: 255 }) }),
    })
    .delete("/v1/servers/:serverId/members/:userId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!canManageServer(membership.role)) return respondError(set, 403, "insufficient_server_permissions");
      if (params.userId === user.id) return respondError(set, 400, "use_leave_server");

      const [target] = await db<{ role: "owner" | "admin" | "member" }[]>`
        select role from server_members
        where server_id = ${params.serverId} and user_id = ${params.userId} and left_at is null
      `;
      if (!target) return respondError(set, 404, "server_member_not_found");
      if (target.role === "owner") return respondError(set, 400, "cannot_remove_server_owner");
      if (membership.role === "admin" && target.role === "admin") return respondError(set, 403, "insufficient_server_permissions");

      await db.begin(async (transaction) => {
        await transaction`
          update server_members set left_at = now()
          where server_id = ${params.serverId} and user_id = ${params.userId}
        `;
        await transaction`
          update conversation_members cm
          set left_at = now()
          from channels c
          where c.server_id = ${params.serverId}
            and c.conversation_id = cm.conversation_id
            and cm.user_id = ${params.userId}
            and cm.left_at is null
        `;
      });
      return { removed: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), userId: t.String({ format: "uuid" }) }),
    })
    .patch("/v1/servers/:serverId/members/:userId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (membership.role !== "owner") return respondError(set, 403, "only_server_owner_can_change_roles");
      if (params.userId === user.id) return respondError(set, 400, "cannot_change_owner_role");

      const [target] = await db<{ role: "owner" | "admin" | "member" }[]>`
        select role from server_members
        where server_id = ${params.serverId} and user_id = ${params.userId} and left_at is null
      `;
      if (!target) return respondError(set, 404, "server_member_not_found");
      await db`
        update server_members set role = ${body.role}
        where server_id = ${params.serverId} and user_id = ${params.userId}
      `;
      return { updated: true, role: body.role };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), userId: t.String({ format: "uuid" }) }),
      body: t.Object({ role: t.Union([t.Literal("admin"), t.Literal("member")]) }),
    })
    .post("/v1/servers/:serverId/leave", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 404, "not_a_server_member");
      if (membership.role === "owner") return respondError(set, 400, "server_owner_must_transfer_ownership");

      await db.begin(async (transaction) => {
        await transaction`
          update server_members set left_at = now()
          where server_id = ${params.serverId} and user_id = ${user.id} and left_at is null
        `;
        await transaction`
          update conversation_members cm
          set left_at = now()
          from channels c
          where c.server_id = ${params.serverId}
            and c.conversation_id = cm.conversation_id
            and cm.user_id = ${user.id}
            and cm.left_at is null
        `;
      });
      return { left: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .delete("/v1/servers/:serverId/invites/:inviteId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverMembership(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!canManageServer(membership.role)) return respondError(set, 403, "insufficient_server_permissions");
      const [revoked] = await db<{ id: string }[]>`
        update server_invites
        set revoked_at = coalesce(revoked_at, now())
        where id = ${params.inviteId} and server_id = ${params.serverId}
        returning id
      `;
      if (!revoked) return respondError(set, 404, "invite_not_found");
      return { revoked: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), inviteId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/devices", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      let identityKey: Buffer;
      let signedPrekey: Buffer;
      try {
        identityKey = decodeBase64(body.identityKey, "identityKey", 4096);
        signedPrekey = decodeBase64(body.signedPrekey, "signedPrekey", 4096);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_key_encoding");
        throw error;
      }

      const prekeys: Buffer[] = [];
      try {
        for (const prekey of body.oneTimePrekeys ?? []) {
          prekeys.push(decodeBase64(prekey.publicKey, "oneTimePrekeys.publicKey", 4096));
        }
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_key_encoding");
        throw error;
      }

      const device = await db.begin(async (transaction) => {
        const [created] = await transaction<{ id: string; name: string; created_at: Date }[]>`
          insert into devices (user_id, name, identity_key, signed_prekey)
          values (${user.id}, ${body.name}, ${identityKey}, ${signedPrekey})
          returning id, name, created_at
        `;

        for (const [index, publicKey] of prekeys.entries()) {
          const keyId = body.oneTimePrekeys?.[index]?.keyId;
          if (keyId === undefined) throw new Error("prekey id missing after validation");
          await transaction`
            insert into one_time_prekeys (device_id, key_id, public_key)
            values (${created.id}, ${keyId}, ${publicKey})
          `;
        }

        return created;
      });

      set.status = 201;
      return { device };
    }, {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 80 }),
        identityKey: encryptedBytes(6_000),
        signedPrekey: encryptedBytes(6_000),
        oneTimePrekeys: t.Optional(t.Array(t.Object({
          keyId: t.Integer({ minimum: 0, maximum: 2_147_483_647 }),
          publicKey: encryptedBytes(6_000),
        }), { maxItems: 100 })),
      }),
    })
    .get("/v1/devices", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const devices = await db<{
        id: string;
        name: string;
        identity_key: Buffer;
        signed_prekey: Buffer;
        created_at: Date;
        revoked_at: Date | null;
      }[]>`
        select id, name, identity_key, signed_prekey, created_at, revoked_at
        from devices where user_id = ${user.id} order by created_at asc
      `;

      return {
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          identityKey: encodeBase64(device.identity_key),
          signedPrekey: encodeBase64(device.signed_prekey),
          createdAt: device.created_at,
          revokedAt: device.revoked_at,
        })),
      };
    })
    .post("/v1/devices/:deviceId/revoke", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [revokedDevice] = await db<{ id: string }[]>`
        update devices
        set revoked_at = coalesce(revoked_at, now())
        where id = ${params.deviceId} and user_id = ${user.id}
        returning id
      `;
      if (!revokedDevice) return respondError(set, 404, "device_not_found");
      await db`
        update crypto_devices
        set revoked_at = coalesce(revoked_at, now()), updated_at = now()
        where device_id = ${params.deviceId}
      `;
      return { revoked: true };
    }, {
      params: t.Object({ deviceId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/devices/:deviceId/prekeys", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [device] = await db<{ id: string }[]>`
        select id from devices
        where id = ${params.deviceId} and user_id = ${user.id} and revoked_at is null
      `;
      if (!device) return respondError(set, 404, "device_not_found");

      const prekeys: Array<{ keyId: number; publicKey: Buffer }> = [];
      try {
        for (const prekey of body.prekeys) {
          prekeys.push({
            keyId: prekey.keyId,
            publicKey: decodeBase64(prekey.publicKey, "prekeys.publicKey", 4096),
          });
        }
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_key_encoding");
        throw error;
      }

      await db.begin(async (transaction) => {
        for (const prekey of prekeys) {
          await transaction`
            insert into one_time_prekeys (device_id, key_id, public_key)
            values (${params.deviceId}, ${prekey.keyId}, ${prekey.publicKey})
            on conflict (device_id, key_id) do nothing
          `;
        }
      });

      return { accepted: prekeys.length };
    }, {
      params: t.Object({ deviceId: t.String({ format: "uuid" }) }),
      body: t.Object({
        prekeys: t.Array(t.Object({
          keyId: t.Integer({ minimum: 0, maximum: 2_147_483_647 }),
          publicKey: encryptedBytes(6_000),
        }), { minItems: 1, maxItems: 100 }),
      }),
    })
    .get("/v1/users/:userId/devices/keys", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const bundles = await db.begin(async (transaction) => {
        const devices = await transaction<{
          id: string;
          identity_key: Buffer;
          signed_prekey: Buffer;
        }[]>`
          select id, identity_key, signed_prekey
          from devices
          where user_id = ${params.userId} and revoked_at is null
          order by created_at asc
        `;

        const result = [];
        for (const device of devices) {
          const [prekey] = await transaction<{
            key_id: number;
            public_key: Buffer;
          }[]>`
            select key_id, public_key
            from one_time_prekeys
            where device_id = ${device.id} and consumed_at is null
            order by key_id asc
            limit 1
            for update skip locked
          `;

          if (prekey) {
            await transaction`
              update one_time_prekeys
              set consumed_at = now()
              where device_id = ${device.id} and key_id = ${prekey.key_id}
            `;
          }

          result.push({ device, prekey });
        }

        return result;
      });

      return {
        devices: bundles.map(({ device, prekey }) => ({
          deviceId: device.id,
          identityKey: encodeBase64(device.identity_key),
          signedPrekey: encodeBase64(device.signed_prekey),
          oneTimePrekey: prekey
            ? { keyId: prekey.key_id, publicKey: encodeBase64(prekey.public_key) }
            : null,
        })),
      };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/crypto/keys/upload", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const upload = parseCryptoUpload(body);
      if (!upload || (upload.deviceKeys && upload.deviceKeys.user_id !== matrixUserId(user.id))) {
        return respondError(set, 400, "invalid_crypto_key_upload");
      }

      const deviceId = upload.deviceId;
      const [knownCryptoDevice] = await db<{ user_id: string; revoked_at: Date | null }[]>`
        select user_id, revoked_at
        from crypto_devices
        where device_id = ${deviceId}
      `;
      if (!upload.deviceKeys && (!knownCryptoDevice || knownCryptoDevice.user_id !== user.id || knownCryptoDevice.revoked_at)) {
        return respondError(set, 400, "invalid_crypto_key_upload");
      }

      const publicKeyBytes = upload.deviceKeys ? Buffer.from(JSON.stringify(upload.deviceKeys)) : undefined;
      await db.begin(async (transaction) => {
        const [existingDevice] = await transaction<{ user_id: string; revoked_at: Date | null }[]>`
          select user_id, revoked_at from devices where id = ${deviceId}
        `;
        if (existingDevice && existingDevice.user_id !== user.id) {
          throw new Error("crypto device belongs to another user");
        }
        if (existingDevice?.revoked_at) {
          throw new Error("crypto device has been revoked");
        }

        if (!existingDevice && !upload.deviceKeys) {
          throw new Error("crypto device keys missing");
        }

        if (!existingDevice && upload.deviceKeys) {
          await transaction`
            insert into devices (id, user_id, name, identity_key, signed_prekey)
            values (
              ${deviceId}, ${user.id}, 'web', ${publicKeyBytes}, ${publicKeyBytes}
            )
          `;
        }

        if (upload.deviceKeys) {
          await transaction`
            insert into crypto_devices (device_id, user_id, matrix_user_id, device_keys, fallback_keys)
            values (
              ${deviceId}, ${user.id}, ${upload.deviceKeys.user_id},
              ${upload.deviceKeys}::jsonb, ${upload.fallbackKeys}::jsonb
            )
            on conflict (device_id) do update set
              device_keys = excluded.device_keys,
              fallback_keys = excluded.fallback_keys,
              updated_at = now(),
              revoked_at = null
          `;
        } else {
          await transaction`
            update crypto_devices
            set updated_at = now()
            where device_id = ${deviceId} and user_id = ${user.id} and revoked_at is null
          `;
        }

        for (const [keyId, key] of Object.entries(upload.oneTimeKeys)) {
          await transaction`
            insert into crypto_one_time_keys (device_id, key_id, key_json)
            values (${deviceId}, ${keyId}, ${key}::jsonb)
            on conflict (device_id, key_id) do update set
              key_json = excluded.key_json
            where crypto_one_time_keys.claimed_at is null
          `;
        }

        for (const [keyId, key] of Object.entries(upload.fallbackKeys)) {
          await transaction`
            insert into crypto_fallback_keys (device_id, key_id, key_json)
            values (${deviceId}, ${keyId}, ${key}::jsonb)
            on conflict (device_id, key_id) do update set
              key_json = excluded.key_json
            where crypto_fallback_keys.used_at is null
          `;
        }
      });

      const [count] = await db<{ count: string }[]>`
        select count(*)::text as count from crypto_one_time_keys
        where device_id = ${deviceId} and claimed_at is null
      `;
      const availableFallbackKeys = await db<{ key_id: string }[]>`
        select key_id from crypto_fallback_keys
        where device_id = ${deviceId} and used_at is null
      `;
      return {
        one_time_key_counts: { signed_curve25519: Number(count.count) },
        unused_fallback_key_types: [...new Set(availableFallbackKeys.map((key) => key.key_id.split(":", 1)[0]))],
      };
    }, { body: t.Any() })
    .post("/v1/crypto/keys/query", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const request = objectValue(body);
      const requested = objectValue(request?.device_keys);
      if (!requested || Object.keys(requested).length > 100) return respondError(set, 400, "invalid_crypto_key_query");

      const deviceKeys: Record<string, Record<string, unknown>> = {};
      for (const [requestedUserId, requestedDevices] of Object.entries(requested)) {
        if (!Array.isArray(requestedDevices) || requestedDevices.length > 100) {
          return respondError(set, 400, "invalid_crypto_key_query");
        }

        const rows = await db<{ device_id: string; device_keys: unknown }[]>`
          select device_id, device_keys
          from crypto_devices
          where matrix_user_id = ${requestedUserId} and revoked_at is null
        `;
        const allowed = new Set(requestedDevices.filter((deviceId): deviceId is string => typeof deviceId === "string"));
        const selected: Record<string, unknown> = {};
        for (const row of rows) {
          if (allowed.size > 0 && !allowed.has(row.device_id)) continue;
          selected[row.device_id] = row.device_keys;
        }
        // An empty device map is a successful response for a user who has
        // not registered a crypto device yet. Omitting the user leaves the
        // Matrix key-query state dirty and causes the client to retry forever.
        deviceKeys[requestedUserId] = selected;
      }

      return { device_keys: deviceKeys, failures: {} };
    }, { body: t.Any() })
    .post("/v1/crypto/keys/claim", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const request = objectValue(body);
      const requested = objectValue(request?.one_time_keys);
      if (!requested || Object.keys(requested).length > 100) return respondError(set, 400, "invalid_crypto_key_claim");

      const result: Record<string, Record<string, Record<string, unknown>>> = {};
      await db.begin(async (transaction) => {
        for (const [requestedUserId, requestedDevicesValue] of Object.entries(requested)) {
          const requestedDevices = objectValue(requestedDevicesValue);
          if (!requestedDevices) continue;

          for (const [deviceId, algorithmValue] of Object.entries(requestedDevices)) {
            if (typeof algorithmValue !== "string") continue;
            let [key] = await transaction<{
              key_id: string;
              key_json: unknown;
            }[]>`
              select k.key_id, k.key_json
              from crypto_one_time_keys k
              join crypto_devices d on d.device_id = k.device_id
              where d.matrix_user_id = ${requestedUserId}
                and d.device_id = ${deviceId}
                and d.revoked_at is null
                and k.claimed_at is null
                and k.key_id like ${`${algorithmValue}:%`}
              order by k.created_at asc
              limit 1
              for update skip locked
            `;
            let fallback = false;
            if (!key) {
              [key] = await transaction<{
                key_id: string;
                key_json: unknown;
              }[]>`
                select key_id, key_json
                from crypto_fallback_keys
                where device_id = ${deviceId}
                  and used_at is null
                  and key_id like ${`${algorithmValue}:%`}
                order by created_at asc
                limit 1
                for update skip locked
              `;
              fallback = Boolean(key);
            }
            if (!key) continue;

            if (fallback) {
              await transaction`
                update crypto_fallback_keys
                set used_at = now()
                where device_id = ${deviceId} and key_id = ${key.key_id}
              `;
            } else {
              await transaction`
                update crypto_one_time_keys
                set claimed_at = now()
                where device_id = ${deviceId} and key_id = ${key.key_id}
              `;
            }
            result[requestedUserId] ??= {};
            result[requestedUserId][deviceId] = { [key.key_id]: key.key_json };
          }
        }
      });

      return { one_time_keys: result, failures: {} };
    }, { body: t.Any() })
    .post("/v1/crypto/send-to-device/:eventType/:transactionId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const request = objectValue(body);
      const messages = objectValue(request?.messages);
      if (!messages || Object.keys(messages).length > 100) return respondError(set, 400, "invalid_to_device_message");

      await db.begin(async (transaction) => {
        for (const [requestedUserId, requestedDevicesValue] of Object.entries(messages)) {
          const requestedDevices = objectValue(requestedDevicesValue);
          if (!requestedDevices) continue;

          for (const [deviceId, content] of Object.entries(requestedDevices)) {
            if (!objectValue(content)) continue;
            const [target] = await transaction<{ device_id: string }[]>`
              select device_id from crypto_devices
              where device_id = ${deviceId}
                and matrix_user_id = ${requestedUserId}
                and revoked_at is null
            `;
            if (!target) continue;

            await transaction`
              insert into crypto_to_device_events (
                event_type, transaction_id, sender_user_id, recipient_device_id, content
              )
              values (
                ${params.eventType}, ${params.transactionId}, ${matrixUserId(user.id)},
                ${deviceId}, ${content}::jsonb
              )
              on conflict (event_type, transaction_id, sender_user_id, recipient_device_id) do nothing
            `;
          }
        }
      });

      return {};
    }, {
      params: t.Object({
        eventType: t.String({ minLength: 1, maxLength: 128 }),
        transactionId: t.String({ minLength: 1, maxLength: 255 }),
      }),
      body: t.Any(),
    })
    .get("/v1/crypto/to-device", async ({ headers, query, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [device] = await db<{ device_id: string }[]>`
        select device_id from crypto_devices
        where device_id = ${query.deviceId} and user_id = ${user.id} and revoked_at is null
      `;
      if (!device) return respondError(set, 404, "crypto_device_not_found");

      const [keyCount] = await db<{ count: string }[]>`
        select count(*)::text as count
        from crypto_one_time_keys
        where device_id = ${query.deviceId} and claimed_at is null
      `;
      const availableFallbackKeys = await db<{ key_id: string }[]>`
        select key_id from crypto_fallback_keys
        where device_id = ${query.deviceId} and used_at is null
      `;

      const events = await db<{
        id: bigint | number | string;
        event_type: string;
        sender_user_id: string;
        content: unknown;
      }[]>`
        select id, event_type, sender_user_id, content
        from crypto_to_device_events
        where recipient_device_id = ${query.deviceId} and delivered_at is null
        order by id asc
        limit 500
      `;

      return {
        events: events.map((event) => ({
          eventId: String(event.id),
          type: event.event_type,
          sender: event.sender_user_id,
          content: event.content,
        })),
        device_lists: { changed: [], left: [] },
        one_time_keys_count: { signed_curve25519: Number(keyCount.count) },
        unused_fallback_key_types: [...new Set(availableFallbackKeys.map((key) => key.key_id.split(":", 1)[0]))],
      };
    }, {
      query: t.Object({ deviceId: t.String({ minLength: 1, maxLength: 255 }) }),
    })
    .post("/v1/crypto/to-device/ack", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [device] = await db<{ device_id: string }[]>`
        select device_id from crypto_devices
        where device_id = ${body.deviceId} and user_id = ${user.id} and revoked_at is null
      `;
      if (!device) return respondError(set, 404, "crypto_device_not_found");
      if (body.eventIds.length === 0) return { acknowledged: 0 };

      const eventIds = body.eventIds.map((eventId) => BigInt(eventId));
      const updated = await db<{ id: bigint | number | string }[]>`
        update crypto_to_device_events
        set delivered_at = now()
        where recipient_device_id = ${body.deviceId}
          and id in ${db(eventIds)}
          and delivered_at is null
        returning id
      `;
      return { acknowledged: updated.length };
    }, {
      body: t.Object({
        deviceId: t.String({ minLength: 1, maxLength: 255 }),
        eventIds: t.Array(t.String({ pattern: "^[0-9]+$" }), { maxItems: 500 }),
      }),
    })
    .post("/v1/conversations", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const memberIds = [...new Set((body.memberUserIds ?? []).filter((id) => id !== user.id))];
      if (body.kind === "dm" && memberIds.length !== 1) {
        return respondError(set, 400, "dm_requires_one_other_member");
      }

      const existingUsers = memberIds.length === 0
        ? []
        : await db<{ id: string }[]>`
            select id from users where id in ${db(memberIds)}
          `;
      if (existingUsers.length !== memberIds.length) return respondError(set, 400, "unknown_member");

      // Private conversations are addressable only through an existing trust
      // boundary. A caller cannot use a guessed user id to create a room with
      // an unrelated account; every invitee must share an active server with
      // the creator.
      const sharedMembers = memberIds.length === 0
        ? []
        : await db<{ user_id: string }[]>`
            select distinct target.user_id
            from server_members mine
            join server_members target on target.server_id = mine.server_id
              and target.left_at is null
            where mine.user_id = ${user.id}
              and mine.left_at is null
              and target.user_id in ${db(memberIds)}
          `;
      if (sharedMembers.length !== memberIds.length) return respondError(set, 403, "conversation_member_not_shared");

      let metadata: Buffer;
      try {
        metadata = body.encryptedMetadata
          ? decodeBase64(body.encryptedMetadata, "encryptedMetadata", 64 * 1024, true)
          : Buffer.alloc(0);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      const conversation = await db.begin(async (transaction) => {
        if (body.kind === "dm") {
          const otherUserId = memberIds[0];
          const pairKey = [user.id, otherUserId].sort().join(":");
          // Serialize creation for a pair so two tabs cannot create duplicate
          // direct-message rooms at the same time.
          await transaction`select pg_advisory_xact_lock(hashtextextended(${pairKey}, 0))`;
          const [existing] = await transaction<{ id: string; created_at: Date; left_at: Date | null }[]>`
            select c.id, c.created_at, mine.left_at
            from conversations c
            join conversation_members mine
              on mine.conversation_id = c.id and mine.user_id = ${user.id}
            join conversation_members other_member
              on other_member.conversation_id = c.id and other_member.user_id = ${otherUserId}
            where c.kind = 'dm' and other_member.left_at is null
            order by c.created_at asc, c.id asc
            limit 1
            for update of c
          `;
          if (existing) {
            if (existing.left_at) {
              await transaction`
                update conversation_members
                set left_at = null, joined_at = now(), role = 'member'
                where conversation_id = ${existing.id} and user_id = ${user.id}
              `;
            }
            return { id: existing.id, kind: "dm", created_at: existing.created_at, reused: true };
          }
        }

        const [created] = await transaction<{ id: string; kind: string; created_at: Date }[]>`
          insert into conversations (kind, encrypted_metadata, created_by)
          values (${body.kind}, ${metadata}, ${user.id})
          returning id, kind, created_at
        `;

        await transaction`
          insert into conversation_members (conversation_id, user_id, role)
          values (${created.id}, ${user.id}, 'owner')
        `;
        for (const memberId of memberIds) {
          await transaction`
            insert into conversation_members (conversation_id, user_id, role)
            values (${created.id}, ${memberId}, 'member')
          `;
        }

        return { ...created, reused: false };
      });

      set.status = conversation.reused ? 200 : 201;
      return { conversation: { id: conversation.id, kind: conversation.kind, createdAt: conversation.created_at } };
    }, {
      body: t.Object({
        kind: t.Union([t.Literal("dm"), t.Literal("group")]),
        memberUserIds: t.Optional(t.Array(t.String({ format: "uuid" }), { maxItems: 100 })),
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
      }),
    })
    .get("/v1/conversations", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const conversations = await db<{
        id: string;
        kind: string;
        encrypted_metadata: Buffer;
        created_at: Date;
        member_display_names: string[];
      }[]>`
        select c.id, c.kind, c.encrypted_metadata, c.created_at,
          coalesce(
            array_agg(other_user.display_name order by other_member.joined_at)
              filter (where other_member.user_id <> ${user.id}),
            array[]::text[]
          ) as member_display_names
        from conversations c
        join conversation_members m on m.conversation_id = c.id
        join conversation_members other_member on other_member.conversation_id = c.id
          and other_member.user_id <> ${user.id} and other_member.left_at is null
        join users other_user on other_user.id = other_member.user_id
        where m.user_id = ${user.id} and m.left_at is null
          and not exists (
            select 1 from channels channel_filter where channel_filter.conversation_id = c.id
          )
          and not (
            c.kind = 'dm' and exists (
              select 1
              from conversations older
              join conversation_members older_mine
                on older_mine.conversation_id = older.id
                and older_mine.user_id = ${user.id} and older_mine.left_at is null
              join conversation_members older_other
                on older_other.conversation_id = older.id
                and older_other.user_id = other_member.user_id and older_other.left_at is null
              where older.kind = 'dm'
                and (older.created_at, older.id) < (c.created_at, c.id)
            )
          )
        group by c.id, c.kind, c.encrypted_metadata, c.created_at
        order by c.created_at desc
      `;

      return {
        conversations: conversations.map((conversation) => ({
          id: conversation.id,
          kind: conversation.kind,
          encryptedMetadata: encodeBase64(conversation.encrypted_metadata),
          memberDisplayNames: conversation.member_display_names,
          createdAt: conversation.created_at,
        })),
      };
    })
    .get("/v1/conversations/:conversationId/members", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      if (!membership) return respondError(set, 403, "not_a_conversation_member");

      const members = await db<{ id: string; username: string; display_name: string }[]>`
        select u.id, u.username, u.display_name
        from conversation_members m
        join users u on u.id = m.user_id
        where m.conversation_id = ${params.conversationId} and m.left_at is null
        order by m.joined_at asc
      `;
      return {
        members: members.map((member) => ({
          userId: member.id,
          matrixUserId: matrixUserId(member.id),
          username: member.username,
          displayName: member.display_name,
        })),
      };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
    })
    .delete("/v1/conversations/:conversationId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [conversation] = await db<{ kind: string; user_id: string }[]>`
        select c.kind, cm.user_id
        from conversations c
        join conversation_members cm on cm.conversation_id = c.id
        where c.id = ${params.conversationId} and cm.user_id = ${user.id} and cm.left_at is null
      `;
      if (!conversation) return respondError(set, 404, "conversation_not_found");
      if (conversation.kind === "channel") return respondError(set, 409, "cannot_delete_server_channel");

      await db`
        update conversation_members
        set left_at = coalesce(left_at, now())
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      return { deleted: true };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/conversations/:conversationId/attachments", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      if (!membership) return respondError(set, 403, "not_a_conversation_member");

      const metadata = attachmentMetadata(body.extension, body.mimeType);
      if (!metadata) return respondError(set, 400, "unsupported_attachment_type");

      const attachmentId = crypto.randomUUID();
      const storageKey = `${attachmentId}.${metadata.extension}`;
      const [attachment] = await db<{
        id: string;
        storage_key: string;
        file_extension: string;
        mime_type: string;
        expected_size_bytes: number;
        created_at: Date;
      }[]>`
        insert into attachments (
          id, conversation_id, uploaded_by, storage_key, file_extension, mime_type, expected_size_bytes
        )
        values (
          ${attachmentId}, ${params.conversationId}, ${user.id}, ${storageKey},
          ${metadata.extension}, ${metadata.mimeType}, ${body.expectedSizeBytes}
        )
        returning id, storage_key, file_extension, mime_type, expected_size_bytes, created_at
      `;

      set.status = 201;
      return {
        attachment: {
          id: attachment.id,
          extension: attachment.file_extension,
          mimeType: attachment.mime_type,
          expectedSizeBytes: Number(attachment.expected_size_bytes),
          uploadPath: `/v1/attachments/${attachment.id}`,
          createdAt: attachment.created_at,
        },
      };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
      body: t.Object({
        expectedSizeBytes: t.Integer({ minimum: 1, maximum: config.maxAttachmentBytes }),
        extension: t.String({ minLength: 1, maxLength: 12, pattern: "^[A-Za-z0-9]+$" }),
        mimeType: t.String({ minLength: 3, maxLength: 127, pattern: "^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$" }),
      }),
    })
    .put("/v1/attachments/:attachmentId", async ({ headers, params, request, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [attachment] = await db<{
        id: string;
        storage_key: string;
        expected_size_bytes: number;
        file_extension: string;
        mime_type: string;
        status: string;
      }[]>`
        select a.id, a.storage_key, a.expected_size_bytes, a.file_extension, a.mime_type, a.status
        from attachments a
        join conversation_members m on m.conversation_id = a.conversation_id
        where a.id = ${params.attachmentId} and m.user_id = ${user.id} and m.left_at is null
      `;
      if (!attachment) return respondError(set, 404, "attachment_not_found");
      if (attachment.status === "uploaded") return respondError(set, 409, "attachment_already_uploaded");

      let stored: { size: number; hash: Buffer };
      try {
        stored = await storeEncryptedAttachment(
          request,
          attachment.storage_key,
          Number(attachment.expected_size_bytes),
        );
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) return respondError(set, 413, "attachment_too_large");
        if (error instanceof AttachmentSizeMismatchError) return respondError(set, 400, "attachment_size_mismatch");
        throw error;
      }

      let updated: {
        id: string;
        size_bytes: number;
        sha256: Buffer;
        uploaded_at: Date;
      } | undefined;
      try {
        [updated] = await db<{
          id: string;
          size_bytes: number;
          sha256: Buffer;
          uploaded_at: Date;
        }[]>`
          update attachments
          set status = 'uploaded', size_bytes = ${stored.size}, sha256 = ${stored.hash}, uploaded_at = now()
          where id = ${attachment.id} and status = 'pending'
          returning id, size_bytes, sha256, uploaded_at
        `;
      } catch (error) {
        await removeEncryptedAttachment(attachment.storage_key);
        throw error;
      }
      if (!updated) {
        await removeEncryptedAttachment(attachment.storage_key);
        return respondError(set, 409, "attachment_already_uploaded");
      }

      return {
        attachment: {
          id: updated.id,
          sizeBytes: Number(updated.size_bytes),
          sha256: encodeBase64(updated.sha256),
          uploadedAt: updated.uploaded_at,
        },
      };
    }, {
      params: t.Object({ attachmentId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/attachments/:attachmentId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [attachment] = await db<{
        id: string;
        storage_key: string;
        file_extension: string;
        mime_type: string;
        size_bytes: number;
        status: string;
      }[]>`
        select a.id, a.storage_key, a.file_extension, a.mime_type, a.size_bytes, a.status
        from attachments a
        join conversation_members m on m.conversation_id = a.conversation_id
        where a.id = ${params.attachmentId} and m.user_id = ${user.id} and m.left_at is null
      `;
      if (!attachment || attachment.status !== "uploaded") {
        return respondError(set, 404, "attachment_not_found");
      }
      if (!(await encryptedAttachmentExists(attachment.storage_key))) {
        return respondError(set, 404, "attachment_storage_missing");
      }

      return new Response(Bun.file(attachmentPath(attachment.storage_key)), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-disposition": `attachment; filename="${attachment.id}.${attachment.file_extension}"`,
          "content-type": attachment.mime_type,
        },
      });
    }, {
      params: t.Object({ attachmentId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/conversations/:conversationId/messages", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      if (!membership) return respondError(set, 403, "not_a_conversation_member");

      const [device] = await db<{ id: string }[]>`
        select id from devices where id = ${body.senderDeviceId} and user_id = ${user.id} and revoked_at is null
      `;
      if (!device) return respondError(set, 403, "invalid_sender_device");

      let ciphertext: Buffer;
      let protocolMetadata: Buffer;
      try {
        ciphertext = decodeBase64(body.ciphertext, "ciphertext", config.maxEncryptedMessageBytes);
        protocolMetadata = body.protocolMetadata
          ? decodeBase64(body.protocolMetadata, "protocolMetadata", config.maxProtocolMetadataBytes, true)
          : Buffer.alloc(0);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_payload");
        throw error;
      }

      const message = await db.begin(async (transaction) => {
        const [created] = await transaction<MessageRow[]>`
          insert into messages (
            conversation_id, sender_device_id, client_message_id, protocol, ciphertext, protocol_metadata
          )
          values (
            ${params.conversationId}, ${body.senderDeviceId}, ${body.clientMessageId},
            ${body.protocol}, ${ciphertext}, ${protocolMetadata}
          )
          on conflict (sender_device_id, client_message_id) do nothing
          returning id, conversation_id, sender_device_id, client_message_id,
            server_sequence, protocol, ciphertext, protocol_metadata, created_at
        `;
        return created;
      });

      let deduplicated = false;
      let storedMessage = message;
      if (!storedMessage) {
        const [existing] = await db<MessageRow[]>`
          select m.id, m.conversation_id, m.sender_device_id, m.client_message_id,
            m.server_sequence, m.protocol, m.ciphertext, m.protocol_metadata, m.created_at,
            u.id as sender_user_id
          from messages m
          join devices d on d.id = m.sender_device_id
          join users u on u.id = d.user_id
          where m.sender_device_id = ${body.senderDeviceId} and m.client_message_id = ${body.clientMessageId}
        `;
        if (!existing) throw new Error("message insert did not return a row");
        if (
          existing.conversation_id !== params.conversationId ||
          existing.protocol !== body.protocol ||
          Buffer.compare(existing.ciphertext, ciphertext) !== 0 ||
          Buffer.compare(existing.protocol_metadata, protocolMetadata) !== 0
        ) {
          return respondError(set, 409, "message_id_reused");
        }
        deduplicated = true;
        storedMessage = existing;
      }

      if (!storedMessage.sender_user_id) storedMessage.sender_user_id = user.id;

      if (!deduplicated) {
        const recipients = await db<{ user_id: string }[]>`
          select user_id
          from conversation_members
          where conversation_id = ${params.conversationId}
            and user_id <> ${user.id}
            and left_at is null
        `;
        await publishMessageCreated(params.conversationId, {
          type: "message.created",
          messageId: storedMessage.id,
          conversationId: storedMessage.conversation_id,
          serverSequence: String(storedMessage.server_sequence),
        }, recipients.map((recipient) => recipient.user_id));
      }

      set.status = deduplicated ? 200 : 201;
      return { message: toMessage(storedMessage), deduplicated };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
      body: t.Object({
        senderDeviceId: t.String({ format: "uuid" }),
        clientMessageId: t.String({ format: "uuid" }),
        protocol: t.String({ minLength: 1, maxLength: 32, pattern: "^[a-z0-9._-]+$" }),
        ciphertext: t.String({ minLength: 1, maxLength: 6_000_000 }),
        protocolMetadata: t.Optional(t.String({ maxLength: 350_000 })),
      }),
    })
    .get("/v1/conversations/:conversationId/messages", async ({ headers, params, query, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      if (!membership) return respondError(set, 403, "not_a_conversation_member");

      const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
      const before = query.before ? BigInt(query.before) : undefined;
      const after = query.after ? BigInt(query.after) : undefined;
      if (before !== undefined && after !== undefined) return respondError(set, 400, "one_message_cursor_only");

      if (after !== undefined) {
        const rows = await db<MessageRow[]>`
          select m.id, m.conversation_id, m.sender_device_id, m.client_message_id,
            m.server_sequence, m.protocol, m.ciphertext, m.protocol_metadata, m.created_at,
            u.id as sender_user_id
          from messages m
          join devices d on d.id = m.sender_device_id
          join users u on u.id = d.user_id
          where m.conversation_id = ${params.conversationId} and m.server_sequence > ${after}
          order by m.server_sequence asc
          limit ${limit + 1}
        `;
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        return {
          messages: page.map(toMessage),
          nextBefore: null,
          nextAfter: hasMore ? String(page[page.length - 1]?.server_sequence) : null,
        };
      }

      const rows = before === undefined
        ? await db<MessageRow[]>`
          select m.id, m.conversation_id, m.sender_device_id, m.client_message_id,
            m.server_sequence, m.protocol, m.ciphertext, m.protocol_metadata, m.created_at,
            u.id as sender_user_id
          from messages m
          join devices d on d.id = m.sender_device_id
          join users u on u.id = d.user_id
          where m.conversation_id = ${params.conversationId}
          order by m.server_sequence desc
          limit ${limit + 1}
        `
        : await db<MessageRow[]>`
          select m.id, m.conversation_id, m.sender_device_id, m.client_message_id,
            m.server_sequence, m.protocol, m.ciphertext, m.protocol_metadata, m.created_at,
            u.id as sender_user_id
          from messages m
          join devices d on d.id = m.sender_device_id
          join users u on u.id = d.user_id
          where m.conversation_id = ${params.conversationId} and m.server_sequence < ${before}
          order by m.server_sequence desc
          limit ${limit + 1}
        `;

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit).reverse();
      return {
        messages: page.map(toMessage),
        nextBefore: hasMore ? String(page[0]?.server_sequence) : null,
        nextAfter: null,
      };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
      query: t.Object({
        before: t.Optional(t.String({ pattern: "^[0-9]+$" })),
        after: t.Optional(t.String({ pattern: "^[0-9]+$" })),
        limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })),
      }),
    })
    .ws("/v1/realtime", {
      body: realtimeCommand,
      open: async (ws) => {
        const data = ws.data as { headers?: Record<string, string | undefined> };
        const user = await authenticate(data.headers?.authorization, data.headers?.cookie);
        if (!user) {
          ws.close(4001, "unauthorized");
          return;
        }

        try {
          const connection = await createRealtimeConnection(ws, user.id);
          realtimeConnections.set(ws.raw, connection);
          ws.send(JSON.stringify({ type: "ready" }));
        } catch {
          ws.close(1013, "realtime_unavailable");
        }
      },
      message: async (ws, command) => {
        const connection = realtimeConnections.get(ws.raw);
        if (!connection) {
          ws.close(4001, "unauthorized");
          return;
        }

        if (command.type === "subscribe") {
          const subscribed = await connection.subscribe(command.conversationId);
          if (!subscribed) {
            ws.send(JSON.stringify({ type: "error", error: "not_a_conversation_member" }));
          }
          return;
        }

        if (command.type === "unsubscribe") {
          await connection.unsubscribe(command.conversationId);
          return;
        }

        if (command.type === "typing") {
          const published = await connection.publish(command.conversationId, {
            type: "typing",
            conversationId: command.conversationId,
            isTyping: command.isTyping,
          });
          if (!published) ws.send(JSON.stringify({ type: "error", error: "not_a_conversation_member" }));
          return;
        }

        if (command.type === "presence") {
          const published = await connection.publish(command.conversationId, {
            type: "presence",
            conversationId: command.conversationId,
            state: command.state,
          });
          if (!published) ws.send(JSON.stringify({ type: "error", error: "not_a_conversation_member" }));
          return;
        }

        ws.close(1003, "unsupported_realtime_command");
      },
      close: async (ws) => {
        const connection = realtimeConnections.get(ws.raw);
        realtimeConnections.delete(ws.raw);
        if (connection) await connection.close();
      },
    });
}
