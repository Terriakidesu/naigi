import { RedisClient } from "bun";
import { config } from "../config";

export const redis = new RedisClient(config.redisUrl, {
  autoReconnect: true,
  enableOfflineQueue: false,
  maxRetries: 5,
});

let connection: Promise<void> | undefined;

/**
 * Rejects rather than hanging when the client cannot reach Redis.
 *
 * The client is configured with `autoReconnect`, so once a connection attempt fails the client
 * keeps retrying in the background and `connectRedis()` can stay unsettled indefinitely. Callers
 * on the request path need a definite answer, so the attempt is bounded and the shared promise
 * is released on failure, letting the next caller retry instead of joining a stalled attempt.
 */
function withTimeout(operation: Promise<unknown>, timeoutMs: number) {
  // Keep a handler attached so that a rejection arriving after the timeout wins does not
  // surface as an unhandled rejection.
  operation.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis connect timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([operation, guard]).finally(() => clearTimeout(timer));
}

export async function connectRedis(timeoutMs = 2_000) {
  if (redis.connected) return;
  connection ??= withTimeout(redis.connect(), timeoutMs).then(() => {}).finally(() => {
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
