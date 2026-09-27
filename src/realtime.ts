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

export async function createRealtimeConnection(socket: RealtimeSocket, userId: string): Promise<RealtimeConnection> {
  await connectRedis();
  const subscriber = await redis.duplicate();
  await subscriber.connect();
  const channels = new Set<string>();
  const userChannel = `user:${userId}`;

  const sendControl = (payload: object) => {
    socket.send(JSON.stringify(payload));
  };

  await subscriber.subscribe(userChannel, (message) => {
    const status = socket.send(message);
    if (status <= 0) socket.close(1013, "realtime_backpressure");
  });

  return {
    async subscribe(conversationId) {
      if (channels.has(conversationId)) return true;

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${conversationId} and user_id = ${userId} and left_at is null
      `;
      if (!membership) return false;

      const channel = `conversation:${conversationId}`;
      await subscriber.subscribe(channel, (message) => {
        const status = socket.send(message);
        if (status <= 0) socket.close(1013, "realtime_backpressure");
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
