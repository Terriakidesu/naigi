import { RedisClient } from "bun";
import { config } from "../config";

export const redis = new RedisClient(config.redisUrl, {
  autoReconnect: true,
  enableOfflineQueue: false,
  maxRetries: 5,
});

let connection: Promise<void> | undefined;

/**
 * Pool of subscriber connections shared by every WebSocket.
 *
 * A Redis connection in subscriber mode cannot serve ordinary commands, so each realtime socket
 * needs its own. Creating one per socket without a ceiling lets a single authenticated client
 * open connections until the Redis server refuses more. Connections are handed out on demand and
 * returned when a socket closes, which caps the total at the number of concurrently connected
 * sockets instead of the number of sockets ever opened.
 */
const subscriberPool: RedisClient[] = [];
type SubscriberWaiter = {
  resolve: (subscriber: RedisClient) => void;
  reject: (error: Error) => void;
};
let subscriberPoolWaiters: SubscriberWaiter[] = [];

async function createSubscriber() {
  const subscriber = await redis.duplicate();
  await subscriber.connect();
  return subscriber;
}

export async function acquireSubscriber(): Promise<RedisClient> {
  const pooled = subscriberPool.pop();
  if (pooled) return pooled;

  // With no idle connection, hand the request straight to a new one. Connections are only
  // created on demand, so the count never exceeds the number of sockets asking at once.
  return createSubscriber();
}

function releaseSubscriber(subscriber: RedisClient) {
  const waiter = subscriberPoolWaiters.shift();
  if (waiter) {
    waiter.resolve(subscriber);
    return;
  }
  subscriberPool.push(subscriber);
}

/** Fails every queued waiter so nothing is left awaiting a connection during shutdown. */
function drainSubscriberWaiters() {
  const waiters = subscriberPoolWaiters;
  subscriberPoolWaiters = [];
  for (const waiter of waiters) waiter.reject(new Error("redis subscriber pool closed"));
}

/** Closes every pooled subscriber connection. The base client is closed separately. */
export function closeSubscriberPool() {
  const pooled = subscriberPool.splice(0, subscriberPool.length);
  drainSubscriberWaiters();
  for (const subscriber of pooled) {
    if (subscriber.connected) subscriber.close();
  }
}

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
  closeSubscriberPool();
  if (redis.connected) redis.close();
}

export { releaseSubscriber };
