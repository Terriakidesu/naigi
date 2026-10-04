import type { RedisClient } from "bun";
import { db } from "./db/client";
import { acquireSubscriber, connectRedis, redis, releaseSubscriber } from "./redis/client";

export interface RealtimeSocket {
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

/**
 * Ceiling on the conversations one socket may hold at once.
 *
 * Every subscription adds an entry to the per-socket set and a channel registration on that
 * socket's dedicated Redis connection, so an unbounded count lets one authenticated socket
 * exhaust server memory and Redis connections. A real client follows a handful of conversations
 * at a time, so this is well above normal use and only trips on abuse.
 */
export const maxSubscriptionsPerSocket = 200;

export type RealtimeConnection = {
  subscribe(conversationId: string): Promise<boolean>;
  unsubscribe(conversationId: string): Promise<void>;
  publish(conversationId: string, payload: object): Promise<boolean>;
  close(): Promise<void>;
};

async function directConversationIsBlocked(conversationId: string, userId: string) {
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

async function accountIsSuspended(userId: string) {
  const [result] = await db<{ suspended: boolean }[]>`
    select exists(select 1 from instance_user_suspensions where user_id = ${userId}) as suspended
  `;
  return result?.suspended === true;
}

async function conversationIsInDeactivatedSpace(conversationId: string) {
  const [result] = await db<{ deactivated: boolean }[]>`
    select exists (
      select 1 from channels c
      join servers s on s.id = c.server_id
      where c.conversation_id = ${conversationId} and s.deactivated_at is not null
    ) as deactivated
  `;
  return result?.deactivated === true;
}

/**
 * Membership is re-checked on delivery as well as on subscribe.
 *
 * `subscribe` verifies membership once, but a member removed afterwards keeps the subscription
 * until they unsubscribe or disconnect, and would otherwise continue to receive events for a
 * conversation they are no longer in. Removal is rare compared to delivery, so a positive result
 * is memoised briefly to keep this off the hot path.
 */
const membershipCache = new Map<string, { expiresAt: number }>();
const membershipCacheTtlMs = 30_000;
const membershipCacheLimit = 20_000;

async function isActiveMember(conversationId: string, userId: string) {
  const cacheKey = `${conversationId}:${userId}`;
  const cached = membershipCache.get(cacheKey);
  const now = Date.now();
  if (cached) {
    if (cached.expiresAt > now) return true;
    membershipCache.delete(cacheKey);
  }

  const [membership] = await db<{ user_id: string }[]>`
    select user_id from conversation_members
    where conversation_id = ${conversationId} and user_id = ${userId} and left_at is null
  `;
  if (!membership) return false;

  if (membershipCache.size >= membershipCacheLimit) {
    // Cheap eviction: drop the entries closest to expiry rather than tracking insertion order.
    const sorted = [...membershipCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [key] of sorted.slice(0, Math.ceil(membershipCacheLimit / 4))) membershipCache.delete(key);
  }
  membershipCache.set(cacheKey, { expiresAt: now + membershipCacheTtlMs });
  return true;
}

/**
 * Drops memoised membership so a removal takes effect without waiting for the cache TTL.
 *
 * Called when a member leaves or is removed, because those are the events where continuing to
 * deliver for up to the TTL would be the actual leak.
 */
export function clearMembershipCacheFor(conversationId: string, userId?: string) {
  if (userId) {
    membershipCache.delete(`${conversationId}:${userId}`);
    return;
  }
  const suffix = `:${conversationId}:`;
  for (const key of membershipCache.keys()) {
    if (key.includes(suffix)) membershipCache.delete(key);
  }
}

export async function createRealtimeConnection(socket: RealtimeSocket, userId: string): Promise<RealtimeConnection> {
  await connectRedis();
  // Drawn from a shared pool rather than created per socket, so the number of Redis connections
  // tracks concurrent sockets instead of accumulating over the lifetime of the process.
  const subscriber: RedisClient = await acquireSubscriber();
  const channels = new Set<string>();
  const userChannel = `user:${userId}`;

  const sendControl = (payload: object) => {
    socket.send(JSON.stringify(payload));
  };

  const deliver = (message: string, conversationId?: string) => {
    void (async () => {
      if (await accountIsSuspended(userId)) {
        socket.close(4003, "account_suspended");
        return;
      }
      let scopedConversationId = conversationId;
      if (!scopedConversationId) {
        const payload = JSON.parse(message) as { conversationId?: unknown };
        if (typeof payload.conversationId === "string") scopedConversationId = payload.conversationId;
      }
      if (scopedConversationId) {
        if (await directConversationIsBlocked(scopedConversationId, userId)) return;
        if (await conversationIsInDeactivatedSpace(scopedConversationId)) return;
        // Re-check membership here so a member removed after subscribing stops receiving events
        // without having to unsubscribe first.
        if (!await isActiveMember(scopedConversationId, userId)) return;
      }
      const status = socket.send(message);
      if (status <= 0) socket.close(1013, "realtime_backpressure");
    })().catch(() => {
      // Fail closed: a database outage must not bypass an account block.
    });
  };

  await subscriber.subscribe(userChannel, (message) => {
    deliver(message);
  });

  return {
    async subscribe(conversationId) {
      if (channels.has(conversationId)) return true;
      if (channels.size >= maxSubscriptionsPerSocket) {
        sendControl({ type: "error", error: "too_many_subscriptions" });
        return false;
      }
      if (await accountIsSuspended(userId)) {
        socket.close(4003, "account_suspended");
        return false;
      }
      if (await directConversationIsBlocked(conversationId, userId)) return false;
      if (await conversationIsInDeactivatedSpace(conversationId)) return false;

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${conversationId} and user_id = ${userId} and left_at is null
      `;
      if (!membership) return false;

      const channel = `conversation:${conversationId}`;
      await subscriber.subscribe(channel, (message) => {
        deliver(message, conversationId);
      });
      channels.add(conversationId);
      sendControl({ type: "subscribed", conversationId });
      return true;
    },

    async unsubscribe(conversationId) {
      if (!channels.delete(conversationId)) return;
      await subscriber.unsubscribe(`conversation:${conversationId}`);
      sendControl({ type: "unsubscribed", conversationId });
    },

    async publish(conversationId, payload) {
      if (await accountIsSuspended(userId)) {
        socket.close(4003, "account_suspended");
        return false;
      }
      if (await directConversationIsBlocked(conversationId, userId)) return false;
      if (await conversationIsInDeactivatedSpace(conversationId)) return false;
      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${conversationId} and user_id = ${userId} and left_at is null
      `;
      if (!membership) return false;
      try {
        await redis.publish(`conversation:${conversationId}`, JSON.stringify({ ...payload, userId }));
        return true;
      } catch {
        return false;
      }
    },

    async close() {
      for (const conversationId of channels) {
        try {
          await redis.publish(`conversation:${conversationId}`, JSON.stringify({
            type: "presence",
            conversationId,
            userId,
            state: "offline",
          }));
        } catch {
          // Presence is best effort and must never block socket cleanup.
        }
      }
      if (subscriber.connected) {
        await subscriber.unsubscribe();
      }
      channels.clear();
      // Returned to the pool for another socket. A subscriber that failed mid-session is closed
      // rather than handed on, since its state is unknown.
      if (subscriber.connected) releaseSubscriber(subscriber);
      else subscriber.close();
    },
  };
}
