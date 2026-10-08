/**
 * Device registration and the Matrix Olm key endpoints.
 *
 * The backend is a relay for key material: public identity keys, signed prekeys, and one-time
 * prekeys are stored and returned without inspection, and no private key ever reaches it. What is
 * enforced here is ownership (a device belongs to exactly one account) and the per-request size
 * bounds that stop a caller persisting an unbounded key set.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { db } from "../db/client";
import { decodeBase64, encodeBase64, InvalidEncodingError } from "../encoding";
import { respondError } from "../http/responses";
import { encryptedBytes } from "../http/validation";

/** Base64 prekey bodies are decoded against this ceiling before any database work. */
const maxKeyBytes = 4096;

export const deviceRoutes = new Elysia()
  .post("/v1/devices", async ({ body, headers, set }) => {
    const user = await authenticate(headers.authorization, headers.cookie);
    if (!user) return respondError(set, 401, "unauthorized");

    let identityKey: Buffer;
    let signedPrekey: Buffer;
    try {
      identityKey = decodeBase64(body.identityKey, "identityKey", maxKeyBytes);
      signedPrekey = decodeBase64(body.signedPrekey, "signedPrekey", maxKeyBytes);
    } catch (error) {
      if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_key_encoding");
      throw error;
    }

    const prekeys: Buffer[] = [];
    try {
      for (const prekey of body.oneTimePrekeys ?? []) {
        prekeys.push(decodeBase64(prekey.publicKey, "oneTimePrekeys.publicKey", maxKeyBytes));
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
    // The Matrix-side record is revoked too, so a revoked device stops receiving to-device events
    // even though it still holds keys the server published earlier.
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
          publicKey: decodeBase64(prekey.publicKey, "prekeys.publicKey", maxKeyBytes),
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
  });
