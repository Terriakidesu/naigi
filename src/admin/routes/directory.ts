/**
 * Instance-wide audit log.
 *
 * Reads the host-operator audit trail, which records moderation and administrative actions taken
 * across the whole instance rather than within a single space.
 */

import { Elysia, t } from "elysia";
import { authenticateAdmin } from "../../admin-auth/session";
import { adminCan } from "../../admin-auth/permissions";
import { db } from "../../db/client";
import { respondError } from "../../http/responses";

export const adminDirectoryRoutes = new Elysia()
  .get("/v1/instance-admin/audit", async ({ headers, query, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const limit = Math.min(Number(query.limit ?? 100), 200);
      const rows = await db<{
        id: bigint | number | string;
        admin_user_id: string;
        admin_username: string;
        admin_display_name: string;
        action: string;
        details: Record<string, unknown>;
        report_id: string | null;
        target_user_id: string | null;
        created_at: Date;
      }[]>`
        select l.id, l.admin_user_id, l.admin_username, l.admin_display_name, l.action, l.details, l.report_id,
          l.target_user_id, l.created_at
        from instance_admin_audit_logs l
        where (${user.role} = 'admin' or l.action like 'report.%' or l.action like 'user.%')
        order by l.created_at desc, l.id desc limit ${Number.isInteger(limit) ? limit : 100}
      `;
      return { logs: rows.map((row) => ({
        id: String(row.id),
        adminUserId: row.admin_user_id,
        adminUsername: row.admin_username,
        adminDisplayName: row.admin_display_name,
        action: row.action,
        details: row.details ?? {},
        reportId: row.report_id,
        targetUserId: row.target_user_id,
        createdAt: row.created_at,
      })) };
    }, {
      query: t.Object({ limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })) }),
    });
