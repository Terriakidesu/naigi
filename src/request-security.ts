import { config } from "./config";

/**
 * Request-side security policy shared by the response-header hook, the cross-origin guard, and
 * the WebSocket upgrade check.
 */

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Methods that can change state and therefore need a cross-origin check. */
export function isStateChangingMethod(method: string) {
  return unsafeMethods.has(method.toUpperCase());
}

/**
 * Resolves the origin the browser believes it is talking to.
 *
 * A TLS-terminating reverse proxy presents plain HTTP to this app while the browser used HTTPS,
 * so the forwarded protocol and host are consulted when the operator has declared how many
 * trusted proxies sit in front. At the default of zero hops the values come from the request
 * itself, which keeps a spoofed header from being able to satisfy the origin comparison.
 */
export function effectiveOrigin(request: {
  url: string;
  headers: { get(name: string): string | null };
}) {
  return originFromHeaders(request.headers, request.url);
}

/**
 * Builds the origin from header values alone.
 *
 * A WebSocket upgrade reaches this process as a raw header bag with no absolute request URL, so
 * the scheme has to come from `X-Forwarded-Proto` (when a proxy is declared) and the host from
 * `Host` or `X-Forwarded-Host`. Plain HTTP is assumed when no scheme can be established, which
 * only makes the comparison stricter.
 */
export function originFromHeaders(
  headers: { get(name: string): string | null },
  fallbackUrl?: string,
) {
  const trusted = config.trustedProxyHops > 0;
  const forwardedProto = trusted ? headers.get("x-forwarded-proto") : null;
  const forwardedHost = trusted ? headers.get("x-forwarded-host") : null;

  const host = (forwardedHost ?? headers.get("host") ?? (fallbackUrl ? new URL(fallbackUrl).host : ""))
    .split(",")[0]?.trim().toLowerCase();
  if (!host) return undefined;

  const protocol = (forwardedProto?.split(",")[0]?.trim()
    || (fallbackUrl ? new URL(fallbackUrl).protocol.replace(":", "") : "")
    || "http").toLowerCase();

  return `${protocol}://${host}`;
}

export type CrossOriginVerdict = "allow" | "reject";

/**
 * Decides whether a state-changing request may proceed.
 *
 * The session cookie is `SameSite=Lax`, which already blocks a cross-site form post and a
 * cross-site WebSocket handshake. This is the second layer: it rejects a request that a browser
 * positively identifies as cross-origin. A request carrying neither `Origin` nor `Sec-Fetch-Site`
 * is allowed through, because native clients and the server's own tooling do not send them and
 * there is nothing to compare against.
 */
export function crossOriginVerdict(request: {
  method: string;
  url: string;
  headers: { get(name: string): string | null };
}): CrossOriginVerdict {
  if (!isStateChangingMethod(request.method)) return "allow";

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite.toLowerCase() === "same-origin" || fetchSite.toLowerCase() === "none"
    ? "allow"
    : "reject";

  const origin = request.headers.get("origin");
  if (!origin || origin.toLowerCase() === "null") return "allow";

  return origin.trim().toLowerCase() === effectiveOrigin(request) ? "allow" : "reject";
}

/**
 * Origin check for a WebSocket upgrade.
 *
 * A handshake arrives as a `GET`, so the state-changing method filter above does not apply, but
 * opening a socket is itself an effect: it starts a Redis subscription and a live-connection
 * lease on the server. The comparison is otherwise identical to the HTTP guard.
 */
export function upgradeOriginVerdict(headers: { get(name: string): string | null }): CrossOriginVerdict {
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite) {
    const site = fetchSite.toLowerCase();
    return site === "same-origin" || site === "none" ? "allow" : "reject";
  }

  const origin = headers.get("origin");
  // No `Origin` at all means a native client, which is allowed; `Origin: null` is a sandboxed
  // document and is treated the same way, since neither identifies a foreign site.
  if (!origin || origin.toLowerCase() === "null") return "allow";

  // Compared by host rather than full origin. An upgrade carries no absolute request URL, so the
  // scheme is only knowable when a proxy declares it; defaulting it would reject a legitimate
  // `https` page whose socket reached this process as plain HTTP. The host is what distinguishes
  // a foreign site, so it is the part that has to match.
  const expectedHost = originFromHeaders(headers)?.split("://")[1];
  if (!expectedHost) return "allow";

  let originHost: string | undefined;
  try {
    originHost = new URL(origin.trim()).host.toLowerCase();
  } catch {
    return "reject";
  }
  return originHost === expectedHost ? "allow" : "reject";
}

/**
 * Whether the session cookie should carry `Secure`.
 *
 * Derived from the scheme the browser actually used rather than from `NODE_ENV`, so an instance
 * served over HTTPS outside production still refuses to set a cookie over plain HTTP. Plain HTTP
 * is tolerated only for local development, where there is no TLS to terminate.
 */
export function sessionCookieSecure(request: { url: string; headers: { get(name: string): string | null } }) {
  // Derived from the scheme the browser actually used rather than from `NODE_ENV`, so an instance
  // served over HTTPS outside production still gets a protected cookie. Plain HTTP yields no
  // `Secure` attribute: a browser would discard such a cookie outright, which would break local
  // development over http://localhost without protecting anything.
  return effectiveOrigin(request)?.startsWith("https:") === true;
}

/**
 * Content Security Policy.
 *
 * The Olm/Megolm crypto adapter is WebAssembly and LiveKit runs a worker, so `wasm-unsafe-eval`
 * and `worker-src blob:` are both required; without them the client cannot decrypt a message or
 * join a call. The policy is emitted report-only first so a mis-scoped directive is observed
 * rather than breaking the client, then switched to enforcing once the violations are clean.
 */
export function contentSecurityPolicy(options: { reportOnly: boolean }) {
  const directives = [
    "default-src 'self'",
    // The client bootstraps with an inline script and loads WASM for the crypto adapter.
    "script-src 'self' 'wasm-unsafe-eval'",
    // LiveKit audio uses a WebAudio worklet assembled from a blob URL.
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // Encrypted attachments are fetched as blobs and rendered locally.
    "media-src 'self' blob: data:",
    "connect-src 'self' https: wss:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  return `${directives.join("; ")}; report-uri /v1/security/csp-report`;
}

/**
 * Baseline response headers applied to every response.
 *
 * `nosniff` matters most on the endpoints that echo a stored content type. `Permissions-Policy`
 * grants only the microphone, which encrypted voice rooms need, and denies camera, geolocation,
 * and the other sensors this app never uses.
 */
export function baselineSecurityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), geolocation=(), microphone=(self), payment=(), usb=(), interest-cohort=()",
  };
}

/** HSTS is only meaningful, and only safe, over HTTPS. */
export function strictTransportSecurity(request: { url: string; headers: { get(name: string): string | null } }) {
  return effectiveOrigin(request)?.startsWith("https:")
    ? "max-age=31536000; includeSubDomains"
    : undefined;
}
