/**
 * Moderation reports and report-key management.
 *
 * Report evidence is encrypted to a host-managed public key and is never decrypted here; an operator
 * with the evidence capability receives the wrapped key material needed to decrypt it out of band.
 * The report key can be rotated, which is what invalidates evidence captured under an old key.
 */

import { Elysia, t } from "elysia";
import { authenticateAdmin } from "../../admin-auth/session";
import { adminCan } from "../../admin-auth/permissions";
import { db } from "../../db/client";
import { recordInstanceAdminAudit } from "../../http/audit";
import { isUniqueViolation, respondError } from "../../http/responses";
import { encodeBase64 } from "../../encoding";
import { publishMessageCreated } from "../../redis/client";

export const adminReportRoutes = new Elysia()
  .get("/v1/instance-admin/reports", async ({ headers, query, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const status = query.status ?? "open";
      const reports = await db<{
        id: string;
        reporter_user_id: string | null;
        reporter_username: string | null;
        reporter_display_name: string | null;
        target_user_id: string | null;
        target_username: string | null;
        target_display_name: string | null;
        conversation_id: string | null;
        message_id: string | null;
        reason: string;
        status: string;
        has_evidence: boolean;
        created_at: Date;
        reviewed_at: Date | null;
        suspended: boolean;
      }[]>`
        select r.id, r.reporter_user_id, reporter.username as reporter_username,
          reporter.display_name as reporter_display_name, r.target_user_id,
          target.username as target_username, target.display_name as target_display_name,
          r.conversation_id, r.message_id, r.reason, r.status,
          (r.evidence_ciphertext is not null) as has_evidence, r.created_at, r.reviewed_at,
          exists(select 1 from instance_user_suspensions s where s.user_id = r.target_user_id) as suspended
        from instance_reports r
        left join users reporter on reporter.id = r.reporter_user_id
        left join users target on target.id = r.target_user_id
        where (${status} = 'all' or r.status = ${status})
        order by case when r.status in ('open', 'reviewing') then 0 else 1 end,
          r.created_at desc
        limit 200
      `;
      return {
        reports: reports.map((report) => ({
          id: report.id,
          reporterUserId: report.reporter_user_id,
          reporterUsername: report.reporter_username,
          reporterDisplayName: report.reporter_display_name,
          targetUserId: report.target_user_id,
          targetUsername: report.target_username,
          targetDisplayName: report.target_display_name,
          conversationId: report.conversation_id,
          messageId: report.message_id,
          reason: report.reason,
          status: report.status,
          hasEvidence: user.role === "admin" && report.has_evidence,
          createdAt: report.created_at,
          reviewedAt: report.reviewed_at,
          suspended: report.suspended,
        })),
      };
    }, {
      query: t.Object({ status: t.Optional(t.Union([
        t.Literal("all"), t.Literal("open"), t.Literal("reviewing"), t.Literal("resolved"), t.Literal("dismissed"),
      ])) }),
    })
    .get("/v1/instance-admin/reports/:reportId", async ({ headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      const [report] = await db<{
        id: string;
        reporter_user_id: string | null;
        reporter_username: string | null;
        reporter_display_name: string | null;
        target_user_id: string | null;
        target_username: string | null;
        target_display_name: string | null;
        conversation_id: string | null;
        message_id: string | null;
        reason: string;
        status: string;
        evidence_key_id: string | null;
        evidence_ciphertext: Buffer | null;
        evidence_wrapped_key: Buffer | null;
        evidence_iv: Buffer | null;
        created_at: Date;
        reviewed_by: string | null;
        reviewed_at: Date | null;
      }[]>`
        select r.id, r.reporter_user_id, reporter.username as reporter_username,
          reporter.display_name as reporter_display_name, r.target_user_id,
          target.username as target_username, target.display_name as target_display_name,
          r.conversation_id, r.message_id, r.reason, r.status, r.evidence_key_id,
          r.evidence_ciphertext, r.evidence_wrapped_key, r.evidence_iv, r.created_at,
          r.reviewed_by, r.reviewed_at
        from instance_reports r
        left join users reporter on reporter.id = r.reporter_user_id
        left join users target on target.id = r.target_user_id
        where r.id = ${params.reportId}
      `;
      if (!report) return respondError(set, 404, "report_not_found");
      await recordInstanceAdminAudit(user, "report.viewed", report.id, report.target_user_id);
      set.headers["cache-control"] = "no-store";
      return {
        report: {
          id: report.id,
          reporterUserId: report.reporter_user_id,
          reporterUsername: report.reporter_username,
          reporterDisplayName: report.reporter_display_name,
          targetUserId: report.target_user_id,
          targetUsername: report.target_username,
          targetDisplayName: report.target_display_name,
          conversationId: report.conversation_id,
          messageId: report.message_id,
          reason: report.reason,
          status: report.status,
          createdAt: report.created_at,
          reviewedBy: report.reviewed_by,
          reviewedAt: report.reviewed_at,
          evidence: user.role === "admin" && report.evidence_ciphertext && report.evidence_wrapped_key && report.evidence_iv && report.evidence_key_id
            ? {
              keyId: report.evidence_key_id,
              ciphertext: encodeBase64(report.evidence_ciphertext),
              wrappedKey: encodeBase64(report.evidence_wrapped_key),
              iv: encodeBase64(report.evidence_iv),
            }
            : null,
        },
      };
    }, {
      params: t.Object({ reportId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/instance-admin/reports/:reportId/evidence-access", async ({ headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "evidenceKeys")) return respondError(set, 403, "forbidden");
      const [report] = await db<{ id: string; target_user_id: string | null; has_evidence: boolean }[]>`
        select id, target_user_id, evidence_ciphertext is not null as has_evidence
        from instance_reports where id = ${params.reportId}
      `;
      if (!report) return respondError(set, 404, "report_not_found");
      if (!report.has_evidence) return respondError(set, 409, "report_has_no_evidence");
      await recordInstanceAdminAudit(user, "report.evidence_accessed", report.id, report.target_user_id);
      return { audited: true };
    }, {
      params: t.Object({ reportId: t.String({ format: "uuid" }) }),
    })
    .patch("/v1/instance-admin/reports/:reportId", async ({ body, headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      let updated: { id: string; target_user_id: string | null } | undefined;
      try {
        updated = await db.begin(async (transaction) => {
          const [row] = await transaction<{ id: string; target_user_id: string | null }[]>`
            update instance_reports
            set status = ${body.status}, reviewed_by = ${user.id},
              reviewed_by_username = ${user.username}, reviewed_by_display_name = ${user.username}, reviewed_at = now()
            where id = ${params.reportId}
            returning id, target_user_id
          `;
          if (!row) return undefined;
          await transaction`
            insert into instance_admin_audit_logs (
              admin_user_id, admin_username, admin_display_name, action, report_id, target_user_id
            ) values (
              ${user.id}, ${user.username}, ${user.username}, ${`report.${body.status}`}, ${row.id}, ${row.target_user_id}
            )
          `;
          return row;
        });
      } catch (error) {
        if (isUniqueViolation(error)) return respondError(set, 409, "report_conflicts_with_open_report");
        throw error;
      }
      if (!updated) return respondError(set, 404, "report_not_found");
      return { updated: true };
    }, {
      params: t.Object({ reportId: t.String({ format: "uuid" }) }),
      body: t.Object({ status: t.Union([t.Literal("open"), t.Literal("reviewing"), t.Literal("resolved"), t.Literal("dismissed")]) }),
    })
    .post("/v1/instance-admin/reports/:reportId/remove-message", async ({ headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      const [report] = await db<{ id: string; target_user_id: string | null; message_id: string | null; conversation_id: string | null }[]>`
        select id, target_user_id, message_id, conversation_id
        from instance_reports where id = ${params.reportId}
      `;
      if (!report) return respondError(set, 404, "report_not_found");
      if (!report.message_id || !report.conversation_id) return respondError(set, 409, "report_has_no_message");
      const recipients = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${report.conversation_id} and left_at is null
      `;
      const deleted = await db.begin(async (transaction) => {
        const [row] = await transaction<{ id: string }[]>`
          delete from messages where id = ${report.message_id} and conversation_id = ${report.conversation_id}
          returning id
        `;
        if (!row) return undefined;
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, report_id, target_user_id
          ) values (
            ${user.id}, ${user.username}, ${user.username}, 'report.message_removed', ${report.id}, ${report.target_user_id}
          )
        `;
        return row;
      });
      if (!deleted) return respondError(set, 404, "message_not_found");
      await publishMessageCreated(report.conversation_id, {
        type: "message.deleted",
        messageId: deleted.id,
        conversationId: report.conversation_id,
      }, recipients.map((recipient) => recipient.user_id));
      return { removed: true };
    }, {
      params: t.Object({ reportId: t.String({ format: "uuid" }) }),
    });
