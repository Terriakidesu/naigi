import { db } from "./db/client";
import { connectRedis, redis } from "./redis/client";

export interface RealtimeSocket {
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

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

export async function createRealtimeConnection(socket: RealtimeSocket, userId: string): Promise<RealtimeConnection> {
  await connectRedis();
  const subscriber = await redis.duplicate();
  await subscriber.connect();
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
      if (scopedConversationId && await directConversationIsBlocked(scopedConversationId, userId)) return;
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
      if (await accountIsSuspended(userId)) {
        socket.close(4003, "account_suspended");
        return false;
      }
      if (await directConversationIsBlocked(conversationId, userId)) return false;

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
        subscriber.close();
      }
      channels.clear();
    },
  };
}
