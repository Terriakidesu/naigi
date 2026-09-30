import { Elysia, t } from "elysia";
import { authenticate } from "./auth/session";
import { db } from "./db/client";

const deviceId = t.String({ format: "uuid" });
const opaque = t.String({ minLength: 1, maxLength: 10 * 1024 * 1024 });
const fail = (set: { status?: number | string }, status: number, error: string) => { set.status = status; return { error }; };
async function activeDevice(userId: string, id: string) {
  const [device] = await db`select device_id from crypto_devices where user_id = ${userId} and device_id = ${id} and revoked_at is null`;
  return Boolean(device);
}

export const historyRecoveryRoutes = new Elysia({ prefix: "/v1/crypto/history" })
  .get("/status", async ({ headers, set }) => {
    const user = await authenticate(headers.authorization, headers.cookie);
    if (!user) return fail(set, 401, "unauthorized");
    const [backup] = await db`select backup_id as id, updated_at as "updatedAt" from encrypted_history_backups where user_id = ${user.id}`;
    const [{ count }] = await db`select count(*)::int as count from crypto_devices where user_id = ${user.id} and revoked_at is null`;
    return { backup: backup ?? null, deviceCount: count as number };
  })
  .get("/backup", async ({ headers, set }) => {
    const user = await authenticate(headers.authorization, headers.cookie);
    if (!user) return fail(set, 401, "unauthorized");
    const [backup] = await db`select backup_id as "id", revision::text, encrypted_key as "encryptedKey", encrypted_export as "encryptedExport", updated_at as "updatedAt" from encrypted_history_backups where user_id = ${user.id}`;
    return { backup: backup ?? null };
  })
  .put("/backup", async ({ headers, body, set }) => {
    const user = await authenticate(headers.authorization, headers.cookie);
    if (!user) return fail(set, 401, "unauthorized");
    if (!await activeDevice(user.id, body.deviceId)) return fail(set, 403, "device_not_active");
    const updated = body.revision === "0" ? await db`
      insert into encrypted_history_backups (user_id, backup_id, encrypted_key, encrypted_export)
      values (${user.id}, ${body.id}, ${body.encryptedKey}, ${body.encryptedExport})
      on conflict (user_id) do nothing returning revision::text
    ` : await db`
      update encrypted_history_backups set encrypted_export = ${body.encryptedExport}, revision = revision + 1, updated_at = now()
      where user_id = ${user.id} and backup_id = ${body.id} and revision = ${body.revision}::bigint and encrypted_key = ${body.encryptedKey}
      returning revision::text
    `;
    if (!updated.length) return fail(set, 409, "history_backup_conflict");
    return { revision: updated[0].revision as string };
  }, { body: t.Object({ deviceId, id: t.String({ format: "uuid" }), revision: t.String({ pattern: "^(0|[1-9][0-9]{0,17})$" }), encryptedKey: t.String({ minLength: 1, maxLength: 4096 }), encryptedExport: opaque }) })
  .delete("/backup", async ({ headers, body, set }) => {
    const user = await authenticate(headers.authorization, headers.cookie);
    if (!user) return fail(set, 401, "unauthorized");
    if (!await activeDevice(user.id, body.deviceId)) return fail(set, 403, "device_not_active");
    const rows = await db`delete from encrypted_history_backups where user_id = ${user.id} and backup_id = ${body.id} and revision = ${body.revision}::bigint returning user_id`;
    if (!rows.length) return fail(set, 409, "history_backup_conflict");
    return { deleted: true };
  }, { body: t.Object({ deviceId, id: t.String({ format: "uuid" }), revision: t.String({ pattern: "^[1-9][0-9]{0,17}$" }) }) })
  .post("/transfers", async ({ headers, body, set }) => {
    const user = await authenticate(headers.authorization, headers.cookie);
    if (!user) return fail(set, 401, "unauthorized");
    if (!await activeDevice(user.id, body.deviceId)) return fail(set, 403, "device_not_active");
    const [transfer] = await db.begin(async (sql) => {
      // Serialize limits per account; concurrent requests cannot bypass the cap.
      await sql`select id from users where id = ${user.id} for update`;
      await sql`delete from history_device_transfers where user_id = ${user.id} and expires_at <= now()`;
      const [{ count }] = await sql`select count(*)::int as count from history_device_transfers where user_id = ${user.id}`;
      if (count >= 5) return [];
      return sql`insert into history_device_transfers (id, user_id, requester_device_id, secret_hash)
        values (${body.id}, ${user.id}, ${body.deviceId}, ${body.secretHash}) on conflict (id) do nothing
        returning expires_at as "expiresAt"`;
    });
    if (!transfer) return fail(set, 429, "history_transfer_limit");
    return { expiresAt: transfer.expiresAt };
  }, { body: t.Object({ id: t.String({ format: "uuid" }), deviceId, secretHash: t.String({ pattern: "^[0-9a-f]{64}$" }) }) })
  .get("/transfers/:id", async ({ headers, params, set }) => {
    const user = await authenticate(headers.authorization, headers.cookie);
    if (!user) return fail(set, 401, "unauthorized");
    const [transfer] = await db`select t.id, t.requester_device_id as "deviceId", t.secret_hash as "secretHash", t.encrypted_payload as "encryptedPayload", t.expires_at as "expiresAt"
      from history_device_transfers t join crypto_devices d on d.device_id = t.requester_device_id
      where t.id = ${params.id} and t.user_id = ${user.id} and t.expires_at > now() and d.revoked_at is null
      and (t.approver_device_id is null or exists (select 1 from crypto_devices a where a.device_id = t.approver_device_id and a.revoked_at is null))`;
    if (!transfer) return fail(set, 404, "history_transfer_expired");
    return { transfer };
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }) })
  .put("/transfers/:id", async ({ headers, params, body, set }) => {
    const user = await authenticate(headers.authorization, headers.cookie);
    if (!user) return fail(set, 401, "unauthorized");
    if (!await activeDevice(user.id, body.deviceId)) return fail(set, 403, "device_not_active");
    const rows = await db`update history_device_transfers t set encrypted_payload = ${body.encryptedPayload}, approver_device_id = ${body.deviceId}
      where t.id = ${params.id} and t.user_id = ${user.id} and t.expires_at > now() and t.encrypted_payload is null
      and t.requester_device_id <> ${body.deviceId}
      and exists (select 1 from crypto_devices d where d.device_id = t.requester_device_id and d.revoked_at is null)
      returning t.id`;
    if (!rows.length) return fail(set, 409, "history_transfer_unavailable");
    return { approved: true };
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ deviceId, encryptedPayload: opaque }) })
  .delete("/transfers/:id", async ({ headers, params, set }) => {
    const user = await authenticate(headers.authorization, headers.cookie);
    if (!user) return fail(set, 401, "unauthorized");
    await db`delete from history_device_transfers where id = ${params.id} and user_id = ${user.id}`;
    return { deleted: true };
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }) });
