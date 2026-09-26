import { db } from "./db/client";
import { connectRedis, redis } from "./redis/client";

export interface RealtimeSocket {
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

export type RealtimeConnection = {
  subscribe(conversationId: string): Promise<boolean>;
  unsubscribe(conversationId: string): Promise<void>;
  close(): Promise<void>;
};

export async function createRealtimeConnection(socket: RealtimeSocket, userId: string): Promise<RealtimeConnection> {
  await connectRedis();
  const subscriber = await redis.duplicate();
  await subscriber.connect();
  const channels = new Set<string>();

  const sendControl = (payload: object) => {
    socket.send(JSON.stringify(payload));
  };

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

    async close() {
      if (subscriber.connected) {
        await subscriber.unsubscribe();
        subscriber.close();
      }
      channels.clear();
    },
  };
}
