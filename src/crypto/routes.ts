/**
 * Matrix Olm/Megolm key relay and the to-device event queue.
 *
 * The backend stores and returns key material without inspecting it: no private key reaches it, and
 * `device_keys` and `key_json` are opaque JSONB. What is enforced is device ownership, the bounds on
 * how much a single request may store, and the single-use semantics of a claimed prekey.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { db } from "../db/client";
import {
  maxToDeviceDevicesPerRecipient,
  maxToDeviceEventBytes,
  maxToDeviceEventsPerRequest,
  maxToDeviceRecipients,
} from "../attachments/metadata";
import { respondError } from "../http/responses";
import { encryptedBytes, matrixUserId, objectValue, parseCryptoUpload } from "../http/validation";

export const cryptoRoutes = new Elysia()
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
              ${deviceId}, ${user.id}, ${upload.deviceName ?? "web"}, ${publicKeyBytes}, ${publicKeyBytes}
            )
          `;
        }

        if (existingDevice && upload.deviceName) {
          await transaction`
            update devices set name = ${upload.deviceName}
            where id = ${deviceId} and user_id = ${user.id} and revoked_at is null
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
      if (!messages || Object.keys(messages).length > maxToDeviceRecipients) {
        return respondError(set, 400, "invalid_to_device_message");
      }

      // Validate shape and size before opening a transaction so an oversized fan-out costs no
      // database work, and so the whole request is rejected rather than silently truncated.
      // The value kept for insertion is the original object, not its serialized form: Bun binds
      // a JS string to `::jsonb` as a JSON string scalar, which fails the
      // `crypto_to_device_content_object` check constraint.
      const pending: { matrixUserId: string; deviceId: string; content: Record<string, unknown> }[] = [];
      for (const [requestedUserId, requestedDevicesValue] of Object.entries(messages)) {
        const requestedDevices = objectValue(requestedDevicesValue);
        if (!requestedDevices) continue;

        const deviceEntries = Object.entries(requestedDevices);
        if (deviceEntries.length > maxToDeviceDevicesPerRecipient) {
          return respondError(set, 400, "invalid_to_device_message");
        }

        for (const [deviceId, content] of deviceEntries) {
          const eventContent = objectValue(content);
          if (!eventContent) continue;
          if (Buffer.byteLength(JSON.stringify(eventContent), "utf8") > maxToDeviceEventBytes) {
            return respondError(set, 413, "to_device_event_too_large");
          }
          if (pending.length >= maxToDeviceEventsPerRequest) {
            return respondError(set, 400, "invalid_to_device_message");
          }
          pending.push({ matrixUserId: requestedUserId, deviceId, content: eventContent });
        }
      }

      await db.begin(async (transaction) => {
        for (const event of pending) {
          const [target] = await transaction<{ device_id: string }[]>`
            select device_id from crypto_devices
            where device_id = ${event.deviceId}
              and matrix_user_id = ${event.matrixUserId}
              and revoked_at is null
          `;
          if (!target) continue;

          await transaction`
            insert into crypto_to_device_events (
              event_type, transaction_id, sender_user_id, recipient_device_id, content
            )
            values (
              ${params.eventType}, ${params.transactionId}, ${matrixUserId(user.id)},
              ${event.deviceId}, ${event.content}::jsonb
            )
            on conflict (event_type, transaction_id, sender_user_id, recipient_device_id) do nothing
          `;
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
