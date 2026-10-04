/**
 * Timeouts.
 *
 * Two scopes exist: a space-level timeout, and an instance-level timeout applied by a host
 * operator. Both are checked before any content-producing action, so a timed-out member can read
 * but not write.
 */

import { db } from "../db/client";

export async function isUserTimedOut(serverId: string, userId: string) {
  const [timeout] = await db<{ id: string }[]>`
    select id from server_timeouts
    where server_id = ${serverId} and user_id = ${userId}
      and revoked_at is null and expires_at > now()
    limit 1
  `;
  return Boolean(timeout);
}

export async function isInstanceUserTimedOut(userId: string) {
  const [timeout] = await db<{ id: string }[]>`
    select id from instance_user_timeouts
    where user_id = ${userId} and revoked_at is null and expires_at > now()
    limit 1
  `;
  return Boolean(timeout);
}
