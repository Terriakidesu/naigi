/**
 * Report key rotation.
 *
 * The host-managed key pair used to encrypt report evidence. Rotating deactivates the previous
 * public key, which is what makes evidence captured under it unrecoverable, so this is gated on the
 * evidence capability and audited.
 */

import { Elysia, t } from "elysia";
import { createPublicKey } from "node:crypto";
import { authenticateAdmin } from "../../admin-auth/session";
import { adminCan } from "../../admin-auth/permissions";
import { db } from "../../db/client";
import { respondError } from "../../http/responses";
import { decodeBase64, InvalidEncodingError } from "../../encoding";

export const adminReportKeyRoutes = new Elysia()
  .get("/v1/instance-admin/report-keys", async ({ headers, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "evidenceKeys")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const keys = await db<{ id: string; active: boolean; created_at: Date }[]>`
        select id, active, created_at from instance_report_keys order by created_at desc
      `;
      return { keys: keys.map((key) => ({ id: key.id, active: key.active, createdAt: key.created_at })) };
    })
    .post("/v1/instance-admin/report-keys", async ({ body, headers, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "evidenceKeys")) return respondError(set, 403, "forbidden");
      let publicKey: Buffer;
      try {
        publicKey = decodeBase64(body.publicKey, "publicKey", 2048);
        const parsedKey = createPublicKey({ key: publicKey, format: "der", type: "spki" });
        if (parsedKey.asymmetricKeyType !== "rsa" || (parsedKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
          return respondError(set, 400, "invalid_report_public_key");
        }
      } catch (error) {
        if (error instanceof InvalidEncodingError || error instanceof Error) return respondError(set, 400, "invalid_report_public_key");
        throw error;
      }
      const key = await db.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtextextended('instance-report-key', 0))`;
        await transaction`update instance_report_keys set active = false where active`;
        const [created] = await transaction<{ id: string; created_at: Date }[]>`
          insert into instance_report_keys (
            id, public_key, created_by, created_by_username, created_by_display_name, active
          ) values (
            ${body.keyId}, ${publicKey}, ${user.id}, ${user.username}, ${user.username}, true
          )
          returning id, created_at
        `;
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action
          ) values (${user.id}, ${user.username}, ${user.username}, 'report_key.created')
        `;
        return created;
      });
      if (!key) throw new Error("report encryption key insert did not return a row");
      set.status = 201;
      return { key: { id: key.id, createdAt: key.created_at } };
    }, {
      body: t.Object({
        keyId: t.String({ format: "uuid" }),
        publicKey: t.String({ minLength: 300, maxLength: 4_096 }),
      }),
    });
