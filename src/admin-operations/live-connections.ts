import { createHash } from "node:crypto";
import { config } from "../config";
import { connectRedis, redis } from "../redis/client";

export const liveConnectionLeaseMs = 45_000;
export const liveConnectionRefreshMs = 15_000;
const maximumConnectionsForDistinctUserScan = 100_000;

const databaseUrl = new URL(config.databaseUrl);
const redisNamespace = createHash("sha256")
  .update(`${databaseUrl.hostname}:${databaseUrl.port}${databaseUrl.pathname}`)
  .digest("hex")
  .slice(0, 20);
const liveConnectionsKey = `naigi:${redisNamespace}:operations:live-connections`;

export type LiveConnectionCounts = {
  status: "available" | "limited" | "unavailable";
  connectedUsers: number | null;
  websocketConnections: number | null;
  leaseSeconds: number;
};

function userFingerprint(userId: string) {
  return createHash("sha256").update(userId).digest("hex");
}

export function countDistinctLiveUsers(members: string[]) {
  const users = new Set<string>();
  for (const member of members) {
    const separator = member.indexOf(":");
    if (separator !== 64 || !/^[a-f0-9]{64}$/.test(member.slice(0, separator))) return null;
    users.add(member.slice(0, separator));
  }
  return users.size;
}

export async function registerLiveConnection(userId: string) {
  await connectRedis();
  const member = `${userFingerprint(userId)}:${crypto.randomUUID()}`;
  const expiresAt = Date.now() + liveConnectionLeaseMs;
  await redis.zadd(liveConnectionsKey, expiresAt, member);
  await redis.expire(liveConnectionsKey, Math.ceil(liveConnectionLeaseMs * 2 / 1_000));
  return member;
}

export async function refreshLiveConnections(members: string[]) {
  if (members.length === 0) return;
  await connectRedis();
  const now = Date.now();
  await redis.zremrangebyscore(liveConnectionsKey, "-inf", now);
  const expiresAt = now + liveConnectionLeaseMs;
  await redis.zadd(liveConnectionsKey, ...members.flatMap((member) => [expiresAt, member]));
  await redis.expire(liveConnectionsKey, Math.ceil(liveConnectionLeaseMs * 2 / 1_000));
}

export async function removeLiveConnection(member: string) {
  await connectRedis();
  await redis.zrem(liveConnectionsKey, member);
}

export async function getLiveConnectionCounts(): Promise<LiveConnectionCounts> {
  const unavailable: LiveConnectionCounts = {
    status: "unavailable",
    connectedUsers: null,
    websocketConnections: null,
    leaseSeconds: liveConnectionLeaseMs / 1_000,
  };
  try {
    await connectRedis();
    const now = Date.now();
    await redis.zremrangebyscore(liveConnectionsKey, "-inf", now);
    const websocketConnections = await redis.zcard(liveConnectionsKey);
    if (websocketConnections > maximumConnectionsForDistinctUserScan) {
      return { ...unavailable, status: "limited", websocketConnections };
    }
    const members = await redis.zrangebyscore(liveConnectionsKey, now + 1, "+inf");
    const connectedUsers = countDistinctLiveUsers(members);
    if (connectedUsers === null) return { ...unavailable, status: "limited", websocketConnections };
    return {
      status: "available",
      connectedUsers,
      websocketConnections,
      leaseSeconds: liveConnectionLeaseMs / 1_000,
    };
  } catch {
    return unavailable;
  }
}
