import { RedisClient } from "bun";
import { config } from "../config";

export const redis = new RedisClient(config.redisUrl, {
  autoReconnect: true,
  enableOfflineQueue: false,
  maxRetries: 5,
});

let connection: Promise<void> | undefined;

export async function connectRedis() {
  if (redis.connected) return;
  connection ??= redis.connect().finally(() => {
    connection = undefined;
  });
  await connection;
}

export async function evalRedisScript(script: string, numKeys: number, ...keysAndArgs: (string | number)[]) {
  await connectRedis();
  return redis.send("EVAL", [script, String(numKeys), ...keysAndArgs.map(String)]);
}

export async function pingRedis() {
  await connectRedis();
  await redis.ping();
  return true;
}

export async function publishMessageCreated(conversationId: string, payload: object, recipientUserIds: string[] = []) {
  try {
    await connectRedis();
    const message = JSON.stringify(payload);
    await redis.publish(`conversation:${conversationId}`, message);
    await Promise.all([...new Set(recipientUserIds)].map((userId) =>
      redis.publish(`user:${userId}`, JSON.stringify({ ...payload, realtimeScope: "user" }))));
    return true;
  } catch {
    return false;
  }
}

export function closeRedis() {
  if (redis.connected) redis.close();
}
