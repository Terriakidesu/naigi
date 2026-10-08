/**
 * Encrypted message history.
 *
 * Bodies are stored and returned as opaque ciphertext. Ordering uses a per-conversation
 * `server_sequence` rather than a timestamp, so two messages sent in the same millisecond still
 * have a total order and cursor pagination cannot skip or repeat one.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { config } from "../config";
import { db } from "../db/client";
import { decodeBase64, InvalidEncodingError } from "../encoding";
import { respondError } from "../http/responses";
import { toMessage, type MessageRow } from "../http/shapes";
import { directConversationIsBlocked } from "../moderation/blocks";
import { isInstanceUserTimedOut, isUserTimedOut } from "../moderation/timeouts";
import { conversationChannelAuthorization } from "../servers/channel-access";
import { hasAnyServerPermission, hasServerPermission } from "../servers/permissions";
import { publishMessageCreated } from "../redis/client";
import { sendGenericFcmPush } from "../push/fcm";

export const messageRoutes = new Elysia()
  .post("/v1/conversations/:conversationId/messages", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (await directConversationIsBlocked(params.conversationId, user.id)) return respondError(set, 403, "blocked_user");
      const attachmentIds = [...new Set([
        ...(body.attachmentIds ?? []),
        ...(body.attachmentId ? [body.attachmentId] : []),
      ])];
      const hasAttachments = attachmentIds.length > 0;
      const channelContext = await conversationChannelAuthorization(params.conversationId, user.id);
      if (channelContext) {
        if (!channelContext.access?.canView) return respondError(set, 403, "channel_not_visible");
        if (channelContext.channel.kind === "voice") return respondError(set, 403, "voice_channel_messages_unsupported");
        const canSendText = hasServerPermission(channelContext.access.authorization, "send_messages");
        if (!canSendText && !hasAttachments) {
          return respondError(set, 403, "insufficient_channel_permissions");
        }
        if (!canSendText && hasAttachments) {
          if (!channelContext.access.canUpload) return respondError(set, 403, "insufficient_channel_permissions");
        }
        if (await isUserTimedOut(channelContext.channel.server_id, user.id)) return respondError(set, 403, "member_timed_out");
      }

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      if (!membership) return respondError(set, 403, "not_a_conversation_member");
      if (await isInstanceUserTimedOut(user.id)) return respondError(set, 403, "instance_user_timed_out");

      if (hasAttachments) {
        const uploadedAttachments = await db<{ id: string }[]>`
          select id from attachments
          where id in ${db(attachmentIds)}
            and conversation_id = ${params.conversationId}
            and uploaded_by = ${user.id}
            and status = 'uploaded'
        `;
        if (uploadedAttachments.length !== attachmentIds.length) return respondError(set, 403, "invalid_attachment");
      }

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
        void sendGenericFcmPush(recipients.map((recipient) => recipient.user_id));
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
        attachmentId: t.Optional(t.String({ format: "uuid" })),
        attachmentIds: t.Optional(t.Array(t.String({ format: "uuid" }), { minItems: 1, maxItems: 20 })),
      }),
    })
    .get("/v1/conversations/:conversationId/messages", async ({ headers, params, query, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (await directConversationIsBlocked(params.conversationId, user.id)) return respondError(set, 403, "blocked_user");
      const channelContext = await conversationChannelAuthorization(params.conversationId, user.id);
      if (channelContext && !channelContext.access?.canView) return respondError(set, 403, "channel_not_visible");
      if (channelContext?.channel.kind === "voice") return respondError(set, 403, "voice_channel_messages_unsupported");

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
    .delete("/v1/conversations/:conversationId/messages/:messageId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const channelContext = await conversationChannelAuthorization(params.conversationId, user.id);
      if (!channelContext?.access?.canView) return respondError(set, 403, "channel_not_visible");
      if (!hasAnyServerPermission(channelContext.access.authorization, "delete_messages", "delete_others_messages")) {
        return respondError(set, 403, "insufficient_server_permissions");
      }
      const [message] = await db<{ id: string }[]>`
        select id from messages
        where id = ${params.messageId} and conversation_id = ${params.conversationId}
      `;
      if (!message) return respondError(set, 404, "message_not_found");
      const recipients = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id <> ${user.id} and left_at is null
      `;
      await db`delete from messages where id = ${message.id}`;
      await publishMessageCreated(params.conversationId, {
        type: "message.deleted",
        messageId: message.id,
        conversationId: params.conversationId,
      }, recipients.map((recipient) => recipient.user_id));
      return { deleted: true };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }), messageId: t.String({ format: "uuid" }) }),
    });
