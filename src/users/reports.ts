/**
 * User-submitted reports.
 *
 * Evidence is encrypted in the browser to a host-managed public key and is never decrypted here, so
 * the server stores opaque bytes plus a size and a reason. Submitting a report requires proof that
 * the reporter shares an active space with the reported account, which is the same trust boundary
 * that governs private conversations.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { db } from "../db/client";
import { decodeBase64, InvalidEncodingError } from "../encoding";
import { isUniqueViolation, respondError } from "../http/responses";
import {
  conversationChannelAuthorization,
  isMetadataChannel,
} from "../servers/channel-access";

export const reportRoutes = new Elysia()
  .post("/v1/reports", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (body.targetUserId === user.id) return respondError(set, 400, "cannot_report_self");

      const [target] = await db<{ id: string }[]>`select id from users where id = ${body.targetUserId}`;
      if (!target) return respondError(set, 404, "user_not_found");
      const [recentCount] = await db<{ count: number }[]>`
        select count(*)::int as count from instance_reports
        where reporter_user_id = ${user.id} and created_at > now() - interval '1 hour'
      `;
      if (recentCount.count >= 10) return respondError(set, 429, "report_rate_limited");

      if (body.messageId) {
        if (!body.conversationId) return respondError(set, 400, "invalid_report_reference");
        const channelContext = await conversationChannelAuthorization(body.conversationId, user.id);
        if (channelContext) {
          const channelAccess = channelContext.access;
          if (!channelAccess) return respondError(set, 400, "invalid_report_reference");
          if (!channelAccess.canView && !await isMetadataChannel(channelContext.channel.server_id, channelContext.channel.id)) {
            return respondError(set, 400, "invalid_report_reference");
          }
        }
        const [reportedMessage] = await db<{ sender_user_id: string }[]>`
          select d.user_id as sender_user_id
          from messages m join devices d on d.id = m.sender_device_id
          where m.id = ${body.messageId} and m.conversation_id = ${body.conversationId}
            and exists (
              select 1 from conversation_members cm
              where cm.conversation_id = m.conversation_id and cm.user_id = ${user.id} and cm.left_at is null
            )
        `;
        if (!reportedMessage || reportedMessage.sender_user_id !== body.targetUserId) {
          return respondError(set, 400, "invalid_report_reference");
        }
      } else {
        if (body.conversationId) return respondError(set, 400, "invalid_report_reference");
        const [sharedServer] = await db<{ shared: boolean }[]>`
          select exists (
            select 1 from server_members mine
            join server_members target on target.server_id = mine.server_id and target.left_at is null
            join servers s on s.id = mine.server_id and s.deactivated_at is null
            where mine.user_id = ${user.id} and mine.left_at is null and target.user_id = ${body.targetUserId}
          ) as shared
        `;
        if (!sharedServer?.shared) return respondError(set, 403, "report_target_not_shared");
      }

      let evidenceCiphertext: Buffer | null = null;
      let evidenceWrappedKey: Buffer | null = null;
      let evidenceIv: Buffer | null = null;
      let evidenceKeyId: string | null = null;
      if (body.encryptedEvidence) {
        try {
          evidenceCiphertext = decodeBase64(body.encryptedEvidence.ciphertext, "ciphertext", 128 * 1024);
          evidenceWrappedKey = decodeBase64(body.encryptedEvidence.wrappedKey, "wrappedKey", 2048);
          evidenceIv = decodeBase64(body.encryptedEvidence.iv, "iv", 32);
        } catch (error) {
          if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_report_evidence");
          throw error;
        }
        if (evidenceIv.byteLength !== 12 || evidenceWrappedKey.byteLength < 384) {
          return respondError(set, 400, "invalid_report_evidence");
        }
        const [key] = await db<{ id: string }[]>`
          select id from instance_report_keys where id = ${body.encryptedEvidence.keyId}
        `;
        if (!key) return respondError(set, 400, "invalid_report_evidence_key");
        evidenceKeyId = key.id;
      }

      try {
        const [report] = await db<{ id: string }[]>`
          insert into instance_reports (
            reporter_user_id, target_user_id, conversation_id, message_id, reason,
            evidence_key_id, evidence_ciphertext, evidence_wrapped_key, evidence_iv
          ) values (
            ${user.id}, ${body.targetUserId}, ${body.conversationId ?? null}, ${body.messageId ?? null}, ${body.reason},
            ${evidenceKeyId}, ${evidenceCiphertext}, ${evidenceWrappedKey}, ${evidenceIv}
          ) returning id
        `;
        set.status = 201;
        return { report: { id: report.id, submitted: true } };
      } catch (error) {
        if (isUniqueViolation(error)) return respondError(set, 409, "report_already_submitted");
        throw error;
      }
    }, {
      body: t.Object({
        targetUserId: t.String({ format: "uuid" }),
        reason: t.Union([
          t.Literal("spam"), t.Literal("harassment"), t.Literal("threats"), t.Literal("sexual_content"),
          t.Literal("illegal_content"), t.Literal("impersonation"), t.Literal("other"),
        ]),
        conversationId: t.Optional(t.String({ format: "uuid" })),
        messageId: t.Optional(t.String({ format: "uuid" })),
        encryptedEvidence: t.Optional(t.Object({
          keyId: t.String({ format: "uuid" }),
          ciphertext: t.String({ minLength: 24, maxLength: 180_000 }),
          wrappedKey: t.String({ minLength: 300, maxLength: 4_096 }),
          iv: t.String({ minLength: 16, maxLength: 64 }),
        })),
      }),
    });
