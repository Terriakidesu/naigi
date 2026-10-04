import { createHash } from "node:crypto";
import { config } from "./config";
import { evalRedisScript } from "./redis/client";

export type RateLimitVerdict = {
  /** True when the request must be rejected. */
  limited: boolean;
  /**
   * True when the limiter itself could not be evaluated, for example because Redis is
   * unavailable. Callers decide whether that denies (`failClosed`) or permits the request.
   */
  unavailable: boolean;
  retryAfterSeconds: number;
};

const permitVerdict: RateLimitVerdict = { limited: false, unavailable: false, retryAfterSeconds: 0 };

// Fixed-window counter. `EXPIRE` is only set on creation so the window cannot be extended by
// a burst of requests, and the remaining TTL is returned so callers can send `Retry-After`.
const bumpScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

const peekScript = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

type Counter = { count: number; ttl: number };

// A limiter that hangs is worse than one that refuses: an unreachable Redis would otherwise hold
// the request open instead of producing a verdict, so every counter read is bounded.
const rateLimitTimeoutMs = 1_500;

async function runCounter(script: string, key: string, windowSeconds: number): Promise<Counter> {
  const operation = evalRedisScript(script, 1, key, windowSeconds) as Promise<(number | string)[]>;
  // Keep a handler attached so a rejection arriving after the timeout wins is not unhandled.
  operation.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("rate limit backend timed out")), rateLimitTimeoutMs);
  });

  try {
    const [count, ttl] = await Promise.race([operation, guard]);
    return { count: Number(count), ttl: Number(ttl) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records one attempt against `key` and reports whether the attempt exceeds `limit`.
 * `failClosed` selects the behaviour when Redis cannot be reached: authentication routes deny
 * the request so a Redis outage cannot become an unthrottled brute-force window, while
 * non-security routes stay available.
 */
export async function bumpRateLimit(options: {
  key: string;
  limit: number;
  windowSeconds: number;
  failClosed: boolean;
}): Promise<RateLimitVerdict> {
  let counter: Counter;
  try {
    counter = await runCounter(bumpScript, options.key, options.windowSeconds);
  } catch {
    return { limited: options.failClosed, unavailable: true, retryAfterSeconds: options.failClosed ? 60 : 0 };
  }

  if (counter.count > options.limit) {
    return { limited: true, unavailable: false, retryAfterSeconds: Math.max(1, counter.ttl) };
  }
  return permitVerdict;
}

/** Reads the current counter without recording an attempt. */
export async function peekRateLimit(options: {
  key: string;
  limit: number;
  failClosed: boolean;
}): Promise<RateLimitVerdict> {
  let counter: Counter;
  try {
    counter = await runCounter(peekScript, options.key, 0);
  } catch {
    return { limited: options.failClosed, unavailable: true, retryAfterSeconds: options.failClosed ? 60 : 0 };
  }

  if (counter.count > options.limit) {
    return { limited: true, unavailable: false, retryAfterSeconds: Math.max(1, counter.ttl) };
  }
  return permitVerdict;
}

function normalizeIpAddress(value: string) {
  // Strip an IPv4 port suffix and any IPv6 zone index, then lowercase the remainder.
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  const withoutZone = trimmed.split("%")[0];
  const bracketed = /^\[([^\]]+)](?::\d+)?$/.exec(withoutZone);
  if (bracketed) return `[${bracketed[1]}]`;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(withoutZone)) return withoutZone;
  if (withoutZone.includes(":")) return `[${withoutZone}]`;
  return undefined;
}

/**
 * Resolves the address used for per-IP limits.
 *
 * `X-Forwarded-For` is attacker-controlled, so it is only read when the operator declares how
 * many trusted reverse proxies sit in front of the app via `TRUSTED_PROXY_HOPS`. Each proxy
 * appends the peer address it observed, so the rightmost entries are the ones a client cannot
 * forge, and the address is read that many positions from the right. With the default of zero
 * hops the header is ignored entirely and the transport address is used.
 */
export function resolveClientIp(options: {
  forwardedFor: string | undefined;
  socketAddress: string | undefined;
}) {
  const hops = config.trustedProxyHops;
  if (hops > 0 && options.forwardedFor) {
    const chain = options.forwardedFor.split(",").map((entry) => entry.trim()).filter(Boolean);
    const index = chain.length - hops;
    if (index >= 0) {
      const trusted = normalizeIpAddress(chain[index]);
      if (trusted) return trusted;
    }
  }
  return normalizeIpAddress(options.socketAddress ?? "");
}

/**
 * Instance namespace for rate-limit keys.
 *
 * Deployments frequently share one Redis, and the test suite runs each case against a temporary
 * database schema. Deriving the namespace from the database identity, as the live-connection
 * lease already does, keeps one instance's traffic from exhausting another's budget. Only the
 * host, port, and database name are hashed, so no credential is ever placed in a key.
 */
function instanceNamespace() {
  try {
    const databaseUrl = new URL(config.databaseUrl);
    return createHash("sha256")
      .update(`${databaseUrl.hostname}:${databaseUrl.port}${databaseUrl.pathname}`)
      .digest("hex")
      .slice(0, 20);
  } catch {
    return "unknown";
  }
}

/** Builds a stable, low-cardinality Redis key. Callers must keep raw secrets out of it. */
export function rateLimitKey(scope: string, ...parts: (string | undefined)[]) {
  const suffix = parts.filter((part) => part !== undefined && part !== "").join(":");
  const prefix = `naigi:limit:${instanceNamespace()}:${scope}`;
  return suffix ? `${prefix}:${suffix}` : prefix;
}
