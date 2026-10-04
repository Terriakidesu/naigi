/**
 * The two rate-limit budgets every authenticated mutation shares.
 *
 * Kept beside the limiter itself so a route asks one question — may this proceed — and does not
 * have to know how a verdict is produced.
 */

import { resolveClientIp, type RateLimitVerdict } from "../rate-limit";
import { respondError } from "./responses";

/** The per-account budget only counts failures; the per-IP budget counts every attempt. */
export const authRateLimitWindowSeconds = 15 * 60;
export const authRateLimitIpWindowSeconds = 15 * 60;

export type RateLimitContext = {
  request: Request;
  headers: Record<string, string | undefined>;
  server: { requestIP(request: Request): { address: string } | null } | null;
};

/**
 * The address used for per-IP budgets.
 *
 * `X-Forwarded-For` is only consulted when `TRUSTED_PROXY_HOPS` declares how many proxies append
 * to it, so a client cannot spoof its way past a budget. Returns `undefined` when no address can be
 * established, in which case the caller skips the per-IP dimension rather than pooling everyone
 * into one bucket.
 */
export function clientIpFor(context: RateLimitContext) {
  return resolveClientIp({
    forwardedFor: context.headers["x-forwarded-for"],
    socketAddress: context.server?.requestIP(context.request)?.address,
  });
}

/**
 * Turns limiter verdicts into a response, or returns `undefined` to continue.
 *
 * A limiter that could not be evaluated is reported as a dependency outage rather than as a rate
 * limit, so the caller can distinguish "try again shortly" from "slow down".
 */
export function enforceRateLimits(
  set: { status?: number | string; headers: Record<string, string | number | undefined> },
  verdicts: RateLimitVerdict[],
) {
  const unavailable = verdicts.find((verdict) => verdict.unavailable);
  if (unavailable) {
    set.headers["retry-after"] = String(unavailable.retryAfterSeconds);
    return respondError(set, 503, "auth_temporarily_unavailable");
  }

  const limited = verdicts.find((verdict) => verdict.limited);
  if (limited) {
    set.headers["retry-after"] = String(limited.retryAfterSeconds);
    return respondError(set, 429, "rate_limited");
  }

  return undefined;
}

/** Ceiling on an encrypted custom emoji upload. */
export { maxCustomEmojiBytes } from "../attachments/metadata";
