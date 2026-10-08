/**
 * Space branding, custom emoji, and the audit log.
 *
 * Branding is validated by magic bytes and served with `nosniff`. Custom emoji files are opaque
 * encrypted bytes, so their declared type is only checked for shape. The audit log is readable by
 * anyone holding `view_audit_logs` and records moderation actions taken within the space.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { config } from "../config";
import { db } from "../db/client";
import { encodeBase64, InvalidEncodingError } from "../encoding";
import { attachmentPath, encryptedAttachmentExists } from "../attachments/storage";
import {
  AttachmentSizeMismatchError,
  AttachmentTooLargeError,
  removeEncryptedAttachment,
  storeEncryptedAttachment,
} from "../attachments/storage";
import { maxCustomEmojiBytes } from "../attachments/metadata";
import {
  ProfileImageInvalidError,
  profileImageMetadata,
  profileImagePath,
  removeProfileImage,
  storeProfileImage,
  validProfileImageBytes,
} from "../profile-images";
import { recordServerAudit } from "../http/audit";
import { respondError } from "../http/responses";
import { serverBrandingUrl } from "../http/shapes";
import { decodeEncryptedMetadata } from "../http/validation";
import { hasServerPermission, serverAuthorization, serverMembership } from "./permissions";

export const spaceMediaRoutes = new Elysia()
  .get("/v1/servers/:serverId/branding/:asset", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [server] = params.asset === "icon"
        ? await db<{ storage_key: string | null; mime_type: string | null }[]>`
            select s.icon_storage_key as storage_key, s.icon_mime_type as mime_type
             from servers s join server_members sm on sm.server_id = s.id
             where s.id = ${params.serverId} and sm.user_id = ${user.id} and sm.left_at is null
               and s.deactivated_at is null
          `
        : await db<{ storage_key: string | null; mime_type: string | null }[]>`
            select s.banner_storage_key as storage_key, s.banner_mime_type as mime_type
             from servers s join server_members sm on sm.server_id = s.id
             where s.id = ${params.serverId} and sm.user_id = ${user.id} and sm.left_at is null
               and s.deactivated_at is null
          `;
      if (!server?.storage_key || !server.mime_type) return respondError(set, 404, "server_branding_not_found");
      const path = profileImagePath(server.storage_key);
      if (!(await Bun.file(path).exists())) return respondError(set, 404, "server_branding_not_found");
      return new Response(Bun.file(path), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-type": server.mime_type,
          "x-content-type-options": "nosniff",
        },
      });
    }, {
      params: t.Object({
        serverId: t.String({ format: "uuid" }),
        asset: t.Union([t.Literal("icon"), t.Literal("banner")]),
      }),
    })
    .put("/v1/servers/:serverId/branding/:asset", async ({ headers, params, request, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "manage_server")) return respondError(set, 403, "insufficient_server_permissions");
      const metadata = profileImageMetadata(headers["content-type"]);
      if (!metadata) return respondError(set, 400, "unsupported_server_branding_type");
      const storageKey = `${crypto.randomUUID()}.${metadata.extension}`;
      let stored: { size: number };
      try {
        stored = await storeProfileImage(
          request,
          storageKey,
          config.maxProfileImageBytes,
          (bytes) => validProfileImageBytes(bytes, metadata.mimeType),
        );
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) return respondError(set, 413, "server_branding_too_large");
        if (error instanceof ProfileImageInvalidError) return respondError(set, 400, "invalid_server_branding");
        throw error;
      }

      let previousStorageKey: string | null = null;
      try {
        const updated = params.asset === "icon"
          ? await db.begin(async (transaction) => {
              const [current] = await transaction<{ storage_key: string | null }[]>`
                select icon_storage_key as storage_key from servers where id = ${params.serverId} for update
              `;
              if (!current) return false;
              await transaction`
                update servers
                set icon_storage_key = ${storageKey}, icon_mime_type = ${metadata.mimeType},
                  icon_size_bytes = ${stored.size}, updated_at = now()
                where id = ${params.serverId}
              `;
              previousStorageKey = current.storage_key;
              return true;
            })
          : await db.begin(async (transaction) => {
              const [current] = await transaction<{ storage_key: string | null }[]>`
                select banner_storage_key as storage_key from servers where id = ${params.serverId} for update
              `;
              if (!current) return false;
              await transaction`
                update servers
                set banner_storage_key = ${storageKey}, banner_mime_type = ${metadata.mimeType},
                  banner_size_bytes = ${stored.size}, updated_at = now()
                where id = ${params.serverId}
              `;
              previousStorageKey = current.storage_key;
              return true;
            });
        if (!updated) {
          await removeProfileImage(storageKey);
          return respondError(set, 404, "server_not_found");
        }
        if (previousStorageKey && previousStorageKey !== storageKey) await removeProfileImage(previousStorageKey);
        await recordServerAudit(params.serverId, user.id, `server.${params.asset}_updated`);
        return { url: serverBrandingUrl(params.serverId, params.asset, storageKey) };
      } catch (error) {
        await removeProfileImage(storageKey);
        throw error;
      }
    }, {
      params: t.Object({
        serverId: t.String({ format: "uuid" }),
        asset: t.Union([t.Literal("icon"), t.Literal("banner")]),
      }),
    })
    .delete("/v1/servers/:serverId/branding/:asset", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "manage_server")) return respondError(set, 403, "insufficient_server_permissions");
      const deleted = params.asset === "icon"
        ? await db.begin(async (transaction) => {
            const [current] = await transaction<{ storage_key: string | null }[]>`
              select icon_storage_key as storage_key from servers where id = ${params.serverId} for update
            `;
            if (!current?.storage_key) return null;
            await transaction`
              update servers
              set icon_storage_key = null, icon_mime_type = null, icon_size_bytes = null, updated_at = now()
              where id = ${params.serverId}
            `;
            return current.storage_key;
          })
        : await db.begin(async (transaction) => {
            const [current] = await transaction<{ storage_key: string | null }[]>`
              select banner_storage_key as storage_key from servers where id = ${params.serverId} for update
            `;
            if (!current?.storage_key) return null;
            await transaction`
              update servers
              set banner_storage_key = null, banner_mime_type = null, banner_size_bytes = null, updated_at = now()
              where id = ${params.serverId}
            `;
            return current.storage_key;
          });
      if (deleted) {
        await removeProfileImage(deleted);
        await recordServerAudit(params.serverId, user.id, `server.${params.asset}_removed`);
      }
      return { deleted: Boolean(deleted) };
    }, {
      params: t.Object({
        serverId: t.String({ format: "uuid" }),
        asset: t.Union([t.Literal("icon"), t.Literal("banner")]),
      }),
    })
    .get("/v1/servers/:serverId/emojis", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      const emojis = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        storage_key: string;
        expected_size_bytes: number | string;
        size_bytes: number | string | null;
        status: "pending" | "uploaded";
        created_at: Date;
        uploaded_at: Date | null;
      }[]>`
        select id, server_id, encrypted_metadata, storage_key, expected_size_bytes,
          size_bytes, status, created_at, uploaded_at
        from server_custom_emojis
        where server_id = ${params.serverId}
        order by created_at desc, id desc
      `;
      return {
        emojis: emojis.map((emoji) => ({
          id: emoji.id,
          serverId: emoji.server_id,
          encryptedMetadata: encodeBase64(emoji.encrypted_metadata),
          fileUrl: emoji.status === "uploaded"
            ? `/v1/servers/${encodeURIComponent(params.serverId)}/emojis/${encodeURIComponent(emoji.id)}/file`
            : null,
          expectedSizeBytes: Number(emoji.expected_size_bytes),
          sizeBytes: emoji.size_bytes === null ? null : Number(emoji.size_bytes),
          status: emoji.status,
          createdAt: emoji.created_at,
          uploadedAt: emoji.uploaded_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/emojis", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "manage_custom_emoji")) return respondError(set, 403, "insufficient_server_permissions");
      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }
      const id = crypto.randomUUID();
      const storageKey = `${id}.bin`;
      const [emoji] = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        expected_size_bytes: number | string;
        created_at: Date;
      }[]>`
        insert into server_custom_emojis (
          id, server_id, created_by, encrypted_metadata, storage_key, expected_size_bytes
        ) values (
          ${id}, ${params.serverId}, ${user.id}, ${metadata}, ${storageKey}, ${body.expectedSizeBytes}
        )
        returning id, server_id, encrypted_metadata, expected_size_bytes, created_at
      `;
      await recordServerAudit(params.serverId, user.id, "custom_emoji.created", id);
      set.status = 201;
      return {
        emoji: {
          id: emoji.id,
          serverId: emoji.server_id,
          encryptedMetadata: encodeBase64(emoji.encrypted_metadata),
          fileUrl: null,
          uploadPath: `/v1/servers/${encodeURIComponent(params.serverId)}/emojis/${encodeURIComponent(id)}/file`,
          expectedSizeBytes: Number(emoji.expected_size_bytes),
          sizeBytes: null,
          status: "pending" as const,
          createdAt: emoji.created_at,
          uploadedAt: null,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.String({ minLength: 1, maxLength: 90_000 }),
        expectedSizeBytes: t.Integer({ minimum: 1, maximum: maxCustomEmojiBytes }),
      }),
    })
    .put("/v1/servers/:serverId/emojis/:emojiId/file", async ({ headers, params, request, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "manage_custom_emoji")) return respondError(set, 403, "insufficient_server_permissions");
      const [emoji] = await db<{
        id: string;
        storage_key: string;
        expected_size_bytes: number | string;
        status: "pending" | "uploaded";
      }[]>`
        select id, storage_key, expected_size_bytes, status
        from server_custom_emojis
        where id = ${params.emojiId} and server_id = ${params.serverId}
      `;
      if (!emoji) return respondError(set, 404, "custom_emoji_not_found");
      if (emoji.status === "uploaded") return respondError(set, 409, "custom_emoji_already_uploaded");
      let stored: { size: number };
      try {
        stored = await storeEncryptedAttachment(request, emoji.storage_key, Number(emoji.expected_size_bytes));
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) return respondError(set, 413, "custom_emoji_too_large");
        if (error instanceof AttachmentSizeMismatchError) return respondError(set, 400, "custom_emoji_size_mismatch");
        throw error;
      }
      try {
        const [updated] = await db<{
          id: string;
          server_id: string;
          encrypted_metadata: Buffer;
          expected_size_bytes: number | string;
          size_bytes: number | string;
          status: "pending" | "uploaded";
          created_at: Date;
          uploaded_at: Date;
        }[]>`
          update server_custom_emojis
          set status = 'uploaded', size_bytes = ${stored.size}, uploaded_at = now()
          where id = ${emoji.id} and server_id = ${params.serverId} and status = 'pending'
          returning id, server_id, encrypted_metadata, expected_size_bytes, size_bytes,
            status, created_at, uploaded_at
        `;
        if (!updated) {
          await removeEncryptedAttachment(emoji.storage_key);
          return respondError(set, 409, "custom_emoji_already_uploaded");
        }
        await recordServerAudit(params.serverId, user.id, "custom_emoji.uploaded", emoji.id);
        return {
          emoji: {
            id: updated.id,
            serverId: updated.server_id,
            encryptedMetadata: encodeBase64(updated.encrypted_metadata),
            fileUrl: `/v1/servers/${encodeURIComponent(params.serverId)}/emojis/${encodeURIComponent(updated.id)}/file`,
            expectedSizeBytes: Number(updated.expected_size_bytes),
            sizeBytes: Number(updated.size_bytes),
            status: updated.status,
            createdAt: updated.created_at,
            uploadedAt: updated.uploaded_at,
          },
        };
      } catch (error) {
        await removeEncryptedAttachment(emoji.storage_key);
        throw error;
      }
    }, {
      params: t.Object({
        serverId: t.String({ format: "uuid" }),
        emojiId: t.String({ format: "uuid" }),
      }),
    })
    .get("/v1/servers/:serverId/emojis/:emojiId/file", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      const [emoji] = await db<{ id: string; storage_key: string; status: "pending" | "uploaded" }[]>`
        select id, storage_key, status from server_custom_emojis
        where id = ${params.emojiId} and server_id = ${params.serverId}
      `;
      if (!emoji || emoji.status !== "uploaded") return respondError(set, 404, "custom_emoji_not_found");
      if (!(await encryptedAttachmentExists(emoji.storage_key))) return respondError(set, 404, "custom_emoji_storage_missing");
      return new Response(Bun.file(attachmentPath(emoji.storage_key)), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${emoji.id}.bin"`,
          "x-content-type-options": "nosniff",
        },
      });
    }, {
      params: t.Object({
        serverId: t.String({ format: "uuid" }),
        emojiId: t.String({ format: "uuid" }),
      }),
    })
    .delete("/v1/servers/:serverId/emojis/:emojiId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "manage_custom_emoji")) return respondError(set, 403, "insufficient_server_permissions");
      const [deleted] = await db<{ id: string; storage_key: string }[]>`
        delete from server_custom_emojis
        where id = ${params.emojiId} and server_id = ${params.serverId}
        returning id, storage_key
      `;
      if (!deleted) return respondError(set, 404, "custom_emoji_not_found");
      await removeEncryptedAttachment(deleted.storage_key);
      await recordServerAudit(params.serverId, user.id, "custom_emoji.deleted", deleted.id);
      return { deleted: true };
    }, {
      params: t.Object({
        serverId: t.String({ format: "uuid" }),
        emojiId: t.String({ format: "uuid" }),
      }),
    })
    .patch("/v1/servers/:serverId/emojis/:emojiId", async ({ headers, params, body, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "manage_custom_emoji")) return respondError(set, 403, "insufficient_server_permissions");
      let metadata: Buffer;
      try { metadata = decodeEncryptedMetadata(body.encryptedMetadata); }
      catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }
      const [updated] = await db<{ id: string }[]>`
        update server_custom_emojis set encrypted_metadata = ${metadata}
        where id = ${params.emojiId} and server_id = ${params.serverId}
        returning id
      `;
      if (!updated) return respondError(set, 404, "custom_emoji_not_found");
      await recordServerAudit(params.serverId, user.id, "custom_emoji.updated", updated.id);
      return { updated: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), emojiId: t.String({ format: "uuid" }) }),
      body: t.Object({ encryptedMetadata: t.String({ minLength: 1, maxLength: 90_000 }) }),
    })
    .get("/v1/servers/:serverId/audit-logs", async ({ headers, params, query, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      if (!authorization) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(authorization, "view_audit_logs")) return respondError(set, 403, "insufficient_server_permissions");
      const parsedLimit = Number(query.limit ?? 100);
      const limit = Number.isInteger(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 100;
      const logs = await db<{
        id: bigint | number | string;
        action: string;
        target_id: string | null;
        target_user_id: string | null;
        actor_id: string;
        actor_username: string;
        actor_display_name: string;
        created_at: Date;
      }[]>`
        select l.id, l.action, l.target_id, l.target_user_id, l.actor_id,
          actor.username as actor_username, actor.display_name as actor_display_name, l.created_at
        from server_audit_logs l
        join users actor on actor.id = l.actor_id
        where l.server_id = ${params.serverId}
        order by l.created_at desc, l.id desc
        limit ${limit}
      `;
      return {
        logs: logs.map((log) => ({
          id: String(log.id),
          action: log.action,
          targetId: log.target_id,
          targetUserId: log.target_user_id,
          actor: {
            id: log.actor_id,
            username: log.actor_username,
            displayName: log.actor_display_name,
          },
          createdAt: log.created_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      query: t.Object({ limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })) }),
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
      const [branding] = await db<{ icon_storage_key: string | null; banner_storage_key: string | null }[]>`
        select icon_storage_key, banner_storage_key from servers where id = ${params.serverId}
      `;
      const emojiFiles = await db<{ storage_key: string }[]>`
        select storage_key from server_custom_emojis where server_id = ${params.serverId}
      `;
      const [deleted] = await db<{ id: string }[]>`
        delete from servers
        where id = ${params.serverId} and owner_id = ${user.id}
        returning id
      `;
      if (!deleted) return respondError(set, 404, "server_not_found");
      await Promise.all(attachments.map((attachment) => removeEncryptedAttachment(attachment.storage_key)));
      await Promise.all([
        branding?.icon_storage_key ? removeProfileImage(branding.icon_storage_key) : Promise.resolve(),
        branding?.banner_storage_key ? removeProfileImage(branding.banner_storage_key) : Promise.resolve(),
        ...emojiFiles.map((emoji) => removeEncryptedAttachment(emoji.storage_key)),
      ]);
      return { deleted: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    });
