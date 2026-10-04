/**
 * Encrypted attachment upload and download.
 *
 * Bytes are ciphertext the backend cannot read. Both directions resolve the attachment through
 * conversation membership rather than by id alone, and the upload additionally requires the caller
 * to be the account that raised it, so a pending attachment cannot be filled in by another member.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { config } from "../config";
import { db } from "../db/client";
import { attachmentMetadata } from "../attachments/metadata";
import { encodeBase64 } from "../encoding";
import {
  AttachmentSizeMismatchError,
  AttachmentTooLargeError,
  attachmentPath,
  encryptedAttachmentExists,
  removeEncryptedAttachment,
  storeEncryptedAttachment,
} from "../attachments/storage";
import { respondError } from "../http/responses";
import { directConversationIsBlocked } from "../moderation/blocks";
import { isInstanceUserTimedOut, isUserTimedOut } from "../moderation/timeouts";
import { conversationChannelAuthorization } from "../servers/channel-access";

export const attachmentRoutes = new Elysia()
  .post("/v1/conversations/:conversationId/attachments", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (await directConversationIsBlocked(params.conversationId, user.id)) return respondError(set, 403, "blocked_user");
      const channelContext = await conversationChannelAuthorization(params.conversationId, user.id);
      if (channelContext) {
        if (!channelContext.access?.canView) return respondError(set, 403, "channel_not_visible");
        if (!channelContext.access.canUpload) return respondError(set, 403, "insufficient_channel_permissions");
        if (await isUserTimedOut(channelContext.channel.server_id, user.id)) return respondError(set, 403, "member_timed_out");
      }

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      if (!membership) return respondError(set, 403, "not_a_conversation_member");
      if (await isInstanceUserTimedOut(user.id)) return respondError(set, 403, "instance_user_timed_out");

      const metadata = attachmentMetadata(body.extension, body.mimeType);
      if (!metadata) return respondError(set, 400, "unsupported_attachment_type");

      const attachmentId = crypto.randomUUID();
      const storageKey = `${attachmentId}.${metadata.extension}`;
      const [attachment] = await db<{
        id: string;
        conversation_id: string;
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
        conversation_id: string;
        storage_key: string;
        expected_size_bytes: number;
        file_extension: string;
        mime_type: string;
        status: string;
      }[]>`
        select a.id, a.conversation_id, a.storage_key, a.expected_size_bytes, a.file_extension, a.mime_type, a.status
        from attachments a
        join conversation_members m on m.conversation_id = a.conversation_id
        where a.id = ${params.attachmentId} and m.user_id = ${user.id} and m.left_at is null
          and a.uploaded_by = ${user.id}
      `;
      if (!attachment) return respondError(set, 404, "attachment_not_found");
      // Scoped to the uploader as well as to conversation membership. Creation records the sender
      // and checks it, so without this any member of the conversation could write the bytes of a
      // pending attachment raised by a different member.
      if (await isInstanceUserTimedOut(user.id)) return respondError(set, 403, "instance_user_timed_out");
      if (await directConversationIsBlocked(attachment.conversation_id, user.id)) return respondError(set, 403, "blocked_user");
      const channelContext = await conversationChannelAuthorization(attachment.conversation_id, user.id);
      if (channelContext) {
        if (!channelContext.access?.canView) return respondError(set, 403, "channel_not_visible");
        if (!channelContext.access.canUpload) return respondError(set, 403, "insufficient_channel_permissions");
        if (await isUserTimedOut(channelContext.channel.server_id, user.id)) return respondError(set, 403, "member_timed_out");
      }
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
        conversation_id: string;
        storage_key: string;
        file_extension: string;
        mime_type: string;
        size_bytes: number;
        status: string;
      }[]>`
        select a.id, a.conversation_id, a.storage_key, a.file_extension, a.mime_type, a.size_bytes, a.status
        from attachments a
        join conversation_members m on m.conversation_id = a.conversation_id
        where a.id = ${params.attachmentId} and m.user_id = ${user.id} and m.left_at is null
      `;
      if (!attachment || attachment.status !== "uploaded") {
        return respondError(set, 404, "attachment_not_found");
      }
      if (await directConversationIsBlocked(attachment.conversation_id, user.id)) return respondError(set, 403, "blocked_user");
      const channelContext = await conversationChannelAuthorization(attachment.conversation_id, user.id);
      if (channelContext && !channelContext.access?.canView) return respondError(set, 403, "channel_not_visible");
      if (!(await encryptedAttachmentExists(attachment.storage_key))) {
        return respondError(set, 404, "attachment_storage_missing");
      }

      return new Response(Bun.file(attachmentPath(attachment.storage_key)), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-disposition": `attachment; filename="${attachment.id}.${attachment.file_extension}"`,
          // The stored content type is chosen by the uploading client, so it is not trusted to
          // keep the browser from sniffing a different type. `Content-Disposition: attachment`
          // already forces a download; `nosniff` closes the gap if that ever changes.
          "content-type": attachment.mime_type,
          "x-content-type-options": "nosniff",
        },
      });
    }, {
      params: t.Object({ attachmentId: t.String({ format: "uuid" }) }),
    });
