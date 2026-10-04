import { db } from "../db/client";
import type { AuthenticatedAdmin } from "../admin-auth/session";

/**
 * Audit trail writers.
 *
 * A failure propagates: a moderation action that cannot be recorded should not be reported to the
 * caller as having happened. Writes that must share a caller's transaction are inlined there
 * instead, since a tagged-template `db` call cannot join an open transaction.
 */

export async function recordServerAudit(
  serverId: string,
  actorId: string,
  action: string,
  targetId: string | null = null,
  targetUserId: string | null = null,
) {
  await db`
    insert into server_audit_logs (server_id, actor_id, action, target_id, target_user_id)
    values (${serverId}, ${actorId}, ${action}, ${targetId}, ${targetUserId})
  `;
}

/**
 * Host-operator audit trail.
 *
 * Written to the application database rather than the separate operator database, so an operator
 * action can be correlated with the server state it changed. Only the username is stored, never a
 * credential and never conversation content.
 */
export async function recordInstanceAdminAudit(
  operator: AuthenticatedAdmin,
  action: string,
  reportId: string | null = null,
  targetUserId: string | null = null,
  details: Record<string, unknown> = {},
) {
  await db`
    insert into instance_admin_audit_logs (
      admin_user_id, admin_username, admin_display_name, action, report_id, target_user_id, details
    ) values (
      ${operator.id}, ${operator.username}, ${operator.username}, ${action}, ${reportId}, ${targetUserId}, ${JSON.stringify(details)}::jsonb
    )
  `;
}
