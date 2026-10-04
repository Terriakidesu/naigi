/**
 * Blocking between two accounts.
 *
 * A block is enforced wherever user-to-user content is exposed: direct-message creation, message
 * and attachment access, voice calls, and profile media. Every check is symmetric, so blocking works
 * in both directions regardless of who created it.
 */

import { db } from "../db/client";

/**
 * Whether a direct conversation between these two accounts is blocked in either direction.
 *
 * Only applies to `kind = 'dm'`; a group conversation is not blocked merely because two of its
 * members have blocked each other.
 */
export async function directConversationIsBlocked(conversationId: string, userId: string) {
  const [result] = await db<{ blocked: boolean }[]>`
    select exists (
      select 1
      from conversations c
      join conversation_members mine on mine.conversation_id = c.id
        and mine.user_id = ${userId} and mine.left_at is null
      join conversation_members other_member on other_member.conversation_id = c.id
        and other_member.user_id <> mine.user_id and other_member.left_at is null
      join user_blocks b on (b.blocker_user_id = mine.user_id and b.blocked_user_id = other_member.user_id)
        or (b.blocker_user_id = other_member.user_id and b.blocked_user_id = mine.user_id)
      where c.id = ${conversationId} and c.kind = 'dm'
    ) as blocked
  `;
  return result?.blocked === true;
}

/** Whether either account has blocked the other, independent of any conversation. */
export async function usersAreBlocked(oneUserId: string, otherUserId: string) {
  const [result] = await db<{ blocked: boolean }[]>`
    select exists (
      select 1 from user_blocks
      where (blocker_user_id = ${oneUserId} and blocked_user_id = ${otherUserId})
        or (blocker_user_id = ${otherUserId} and blocked_user_id = ${oneUserId})
    ) as blocked
  `;
  return result?.blocked === true;
}
