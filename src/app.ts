import { password } from "bun";
import { Elysia, t } from "elysia";
import { authenticate, createSession, normalizeUsername, verifyPassword } from "./auth/session";
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
    ciphertext: encodeBase64(message.ciphertext),
    protocolMetadata: encodeBase64(message.protocol_metadata),
    createdAt: message.created_at,
  };
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
]);

export function createApp() {
  const realtimeConnections = new WeakMap<object, RealtimeConnection>();

  return new Elysia()
    .onError(({ code, set }) => {
      if (code === "VALIDATION") return respondError(set, 422, "validation_error");
      console.error("Unhandled request error");
      return respondError(set, 500, "internal_error");
    })
    .get("/", () => ({ name: "priv-chat", version: "1.3.0" }))
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
    .get("/v1/me", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      return { user };
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

        return created;
      });

      set.status = 201;
      return { conversation };
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
      }[]>`
        select c.id, c.kind, c.encrypted_metadata, c.created_at
        from conversations c
        join conversation_members m on m.conversation_id = c.id
        where m.user_id = ${user.id} and m.left_at is null
        order by c.created_at desc
      `;

      return {
        conversations: conversations.map((conversation) => ({
          id: conversation.id,
          kind: conversation.kind,
          encryptedMetadata: encodeBase64(conversation.encrypted_metadata),
          createdAt: conversation.created_at,
        })),
      };
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
          select id, conversation_id, sender_device_id, client_message_id,
            server_sequence, protocol, ciphertext, protocol_metadata, created_at
          from messages
          where sender_device_id = ${body.senderDeviceId} and client_message_id = ${body.clientMessageId}
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

      if (!deduplicated) {
        await publishMessageCreated(params.conversationId, {
          type: "message.created",
          messageId: storedMessage.id,
          conversationId: storedMessage.conversation_id,
          serverSequence: String(storedMessage.server_sequence),
        });
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
      const rows = before === undefined
        ? await db<MessageRow[]>`
            select id, conversation_id, sender_device_id, client_message_id,
              server_sequence, protocol, ciphertext, protocol_metadata, created_at
            from messages
            where conversation_id = ${params.conversationId}
            order by server_sequence desc
            limit ${limit + 1}
          `
        : await db<MessageRow[]>`
            select id, conversation_id, sender_device_id, client_message_id,
              server_sequence, protocol, ciphertext, protocol_metadata, created_at
            from messages
            where conversation_id = ${params.conversationId} and server_sequence < ${before}
            order by server_sequence desc
            limit ${limit + 1}
          `;

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit).reverse();
      return {
        messages: page.map(toMessage),
        nextBefore: hasMore ? String(page[0]?.server_sequence) : null,
      };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
      query: t.Object({
        before: t.Optional(t.String({ pattern: "^[0-9]+$" })),
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
          realtimeConnections.set(ws, connection);
          ws.send(JSON.stringify({ type: "ready" }));
        } catch {
          ws.close(1013, "realtime_unavailable");
        }
      },
      message: async (ws, command) => {
        const connection = realtimeConnections.get(ws);
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

        await connection.unsubscribe(command.conversationId);
      },
      close: async (ws) => {
        const connection = realtimeConnections.get(ws);
        if (connection) await connection.close();
      },
    });
}
