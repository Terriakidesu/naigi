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

export async function pingRedis() {
  await connectRedis();
  await redis.ping();
  return true;
}

export async function publishMessageCreated(conversationId: string, payload: object) {
  try {
    await connectRedis();
    await redis.publish(`conversation:${conversationId}`, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function closeRedis() {
  if (redis.connected) redis.close();
}
