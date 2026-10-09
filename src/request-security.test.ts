import { afterEach, describe, expect, test } from "bun:test";
import { config } from "./config";
import {
  baselineSecurityHeaders,
  contentSecurityPolicy,
  crossOriginVerdict,
  effectiveOrigin,
  isStateChangingMethod,
  originFromHeaders,
  sessionCookieSecure,
  strictTransportSecurity,
  upgradeOriginVerdict,
} from "./request-security";

const originalHops = config.trustedProxyHops;

afterEach(() => {
  config.trustedProxyHops = originalHops;
});

function request(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
}) {
  const entries = Object.entries(options.headers ?? {});
  return {
    method: options.method ?? "GET",
    url: options.url ?? "https://chat.example.com/v1/servers",
    headers: { get: (name: string) => entries.find(([key]) => key === name)?.[1] ?? null },
  };
}

describe("state-changing methods", () => {
  test("covers every method that can mutate state", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "delete"]) {
      expect(isStateChangingMethod(method)).toBe(true);
    }
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(isStateChangingMethod(method)).toBe(false);
  });
});

describe("effective origin", () => {
  test("uses the request origin when no proxy is trusted", () => {
    config.trustedProxyHops = 0;
    expect(effectiveOrigin(request({ url: "https://chat.example.com/v1/servers" }))).toBe("https://chat.example.com");
  });

  test("ignores forwarded headers when no proxy is trusted", () => {
    config.trustedProxyHops = 0;
    const spoofed = request({
      url: "http://127.0.0.1:3001/v1/servers",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "evil.example" },
    });
    expect(effectiveOrigin(spoofed)).toBe("http://127.0.0.1:3001");
  });

  test("honours forwarded protocol and host behind a declared proxy", () => {
    config.trustedProxyHops = 1;
    const proxied = request({
      url: "http://127.0.0.1:3001/v1/servers",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "chat.example.com" },
    });
    expect(effectiveOrigin(proxied)).toBe("https://chat.example.com");
  });

  test("reads only the first entry of a forwarded chain", () => {
    config.trustedProxyHops = 1;
    const chained = request({
      url: "http://127.0.0.1:3001/v1/servers",
      headers: { "x-forwarded-proto": "https, http", "x-forwarded-host": "chat.example.com, internal" },
    });
    expect(effectiveOrigin(chained)).toBe("https://chat.example.com");
  });
});

describe("http cross-origin guard scheme handling", () => {
  test("matches a forwarded scheme behind a declared proxy", () => {
    config.trustedProxyHops = 1;
    const proxied = request({
      method: "POST",
      url: "http://127.0.0.1:3001/v1/me",
      headers: {
        origin: "https://chat.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "chat.example.com",
      },
    });
    expect(crossOriginVerdict(proxied)).toBe("allow");
  });

  test("rejects a forwarded-host mismatch behind a declared proxy", () => {
    config.trustedProxyHops = 1;
    const proxied = request({
      method: "POST",
      url: "http://127.0.0.1:3001/v1/me",
      headers: {
        origin: "https://evil.example",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "chat.example.com",
      },
    });
    expect(crossOriginVerdict(proxied)).toBe("reject");
  });

  test("cannot satisfy the comparison with a spoofed forwarded host", () => {
    config.trustedProxyHops = 0;
    const spoofed = request({
      method: "POST",
      url: "http://127.0.0.1:3001/v1/me",
      headers: {
        origin: "https://evil.example",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example",
      },
    });
    expect(crossOriginVerdict(spoofed)).toBe("reject");
  });
});

describe("origin from headers alone", () => {
  function headerBag(values: Record<string, string>) {
    const entries = Object.entries(values);
    return { get: (name: string) => entries.find(([key]) => key === name)?.[1] ?? null };
  }

  test("uses Host when no proxy is declared", () => {
    config.trustedProxyHops = 0;
    expect(originFromHeaders(headerBag({ host: "chat.example.com" }))).toBe("http://chat.example.com");
  });

  test("uses the forwarded scheme and host behind a declared proxy", () => {
    config.trustedProxyHops = 1;
    expect(originFromHeaders(headerBag({
      host: "127.0.0.1:3001",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "chat.example.com",
    }))).toBe("https://chat.example.com");
  });

  test("ignores a spoofed Host when no proxy is declared", () => {
    config.trustedProxyHops = 0;
    expect(originFromHeaders(headerBag({
      host: "evil.example",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "chat.example.com",
    }))).toBe("http://evil.example");
  });

  test("prefers a forwarded host over Host behind a declared proxy", () => {
    config.trustedProxyHops = 1;
    expect(originFromHeaders(headerBag({
      host: "127.0.0.1:3001",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "chat.example.com",
    }))).toBe("https://chat.example.com");
  });

  test("returns undefined when no host can be established", () => {
    expect(originFromHeaders(headerBag({}))).toBeUndefined();
  });

  test("falls back to the request URL host when the header bag has none", () => {
    expect(originFromHeaders(headerBag({}), "https://chat.example.com/v1/realtime")).toBe("https://chat.example.com");
  });
});

describe("cross-origin guard", () => {
  test("allows same-origin state changes", () => {
    expect(crossOriginVerdict(request({
      method: "POST",
      headers: { origin: "https://chat.example.com" },
    }))).toBe("allow");
  });

  test("rejects a cross-origin state change", () => {
    expect(crossOriginVerdict(request({
      method: "POST",
      headers: { origin: "https://evil.example" },
    }))).toBe("reject");
  });

  test("never checks read-only methods", () => {
    expect(crossOriginVerdict(request({ method: "GET", headers: { origin: "https://evil.example" } }))).toBe("allow");
  });

  test("allows a request that identifies as same-origin via Sec-Fetch-Site", () => {
    expect(crossOriginVerdict(request({ method: "POST", headers: { "sec-fetch-site": "same-origin" } }))).toBe("allow");
  });

  test("allows a directly addressed request, such as a bookmark", () => {
    expect(crossOriginVerdict(request({ method: "POST", headers: { "sec-fetch-site": "none" } }))).toBe("allow");
  });

  test("rejects cross-site, same-site, and same-origin-attacker requests", () => {
    for (const site of ["cross-site", "same-site"]) {
      expect(crossOriginVerdict(request({ method: "POST", headers: { "sec-fetch-site": site } }))).toBe("reject");
    }
  });

  test("prefers Sec-Fetch-Site over Origin when both are present", () => {
    expect(crossOriginVerdict(request({
      method: "POST",
      headers: { origin: "https://chat.example.com", "sec-fetch-site": "cross-site" },
    }))).toBe("reject");
  });

  test("allows a client that sends neither header", () => {
    expect(crossOriginVerdict(request({ method: "POST" }))).toBe("allow");
    expect(crossOriginVerdict(request({ method: "POST", headers: { origin: "null" } }))).toBe("allow");
  });

  test("compares the origin case-insensitively and ignores surrounding whitespace", () => {
    expect(crossOriginVerdict(request({
      method: "POST",
      headers: { origin: "  HTTPS://Chat.Example.com  " },
    }))).toBe("allow");
  });

  test("does not accept a prefix match of the origin", () => {
    expect(crossOriginVerdict(request({
      method: "POST",
      headers: { origin: "https://chat.example.com.evil.example" },
    }))).toBe("reject");
  });

  test("accepts a matching origin behind a declared proxy", () => {
    config.trustedProxyHops = 1;
    expect(crossOriginVerdict(request({
      method: "POST",
      url: "http://127.0.0.1:3001/v1/servers",
      headers: {
        origin: "https://chat.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "chat.example.com",
      },
    }))).toBe("allow");
  });

  test("rejects a mismatch behind a declared proxy", () => {
    config.trustedProxyHops = 1;
    expect(crossOriginVerdict(request({
      method: "POST",
      url: "http://127.0.0.1:3001/v1/servers",
      headers: {
        origin: "https://evil.example",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "chat.example.com",
      },
    }))).toBe("reject");
  });
});

describe("websocket upgrade origin guard", () => {
  test("rejects a foreign Origin", () => {
    expect(upgradeOriginVerdict(new Headers({ host: "chat.example.com", origin: "https://evil.example" }))).toBe("reject");
  });

  test("accepts a matching Origin", () => {
    expect(upgradeOriginVerdict(new Headers({ host: "chat.example.com", origin: "https://chat.example.com" }))).toBe("allow");
  });

  test("rejects cross-site and same-site, accepts same-origin and none", () => {
    const verdict = (site: string) => upgradeOriginVerdict(new Headers({ host: "chat.example.com", "sec-fetch-site": site }));
    expect(verdict("cross-site")).toBe("reject");
    expect(verdict("same-site")).toBe("reject");
    expect(verdict("same-origin")).toBe("allow");
    expect(verdict("none")).toBe("allow");
  });

  test("allows a native client that sends no Origin", () => {
    expect(upgradeOriginVerdict(new Headers({ host: "chat.example.com" }))).toBe("allow");
  });

  test("treats a sandboxed null Origin as unattributable and allows it", () => {
    expect(upgradeOriginVerdict(new Headers({ host: "chat.example.com", origin: "null" }))).toBe("allow");
  });

  test("compares against the forwarded host behind a declared proxy", () => {
    config.trustedProxyHops = 1;
    const proxied = { host: "127.0.0.1:3001", "x-forwarded-proto": "https", "x-forwarded-host": "chat.example.com" };
    expect(upgradeOriginVerdict(new Headers({ ...proxied, origin: "https://chat.example.com" }))).toBe("allow");
    expect(upgradeOriginVerdict(new Headers({ ...proxied, origin: "https://evil.example" }))).toBe("reject");
  });

  test("ignores the scheme, which an upgrade cannot establish on its own", () => {
    // A browser on https reaches this process as plain HTTP when a proxy terminates TLS, so
    // requiring a scheme match here would refuse legitimate clients.
    expect(upgradeOriginVerdict(new Headers({ host: "chat.example.com", origin: "https://chat.example.com" }))).toBe("allow");
    expect(upgradeOriginVerdict(new Headers({ host: "chat.example.com", origin: "http://chat.example.com" }))).toBe("allow");
  });

  test("still requires the host to match when the scheme differs", () => {
    expect(upgradeOriginVerdict(new Headers({ host: "chat.example.com", origin: "http://evil.example" }))).toBe("reject");
  });

  test("rejects an unparseable Origin", () => {
    expect(upgradeOriginVerdict(new Headers({ host: "chat.example.com", origin: "not-a-url" }))).toBe("reject");
  });

  test("cannot be satisfied by a spoofed forwarded host", () => {
    config.trustedProxyHops = 0;
    expect(upgradeOriginVerdict(new Headers({
      host: "chat.example.com",
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
    }))).toBe("reject");
  });
});

describe("session cookie security", () => {
  test("marks the cookie Secure over HTTPS", () => {
    expect(sessionCookieSecure(request({ url: "https://chat.example.com/v1/me" }))).toBe(true);
  });

  test("marks the cookie Secure behind a TLS-terminating proxy", () => {
    config.trustedProxyHops = 1;
    expect(sessionCookieSecure(request({
      url: "http://127.0.0.1:3001/v1/me",
      headers: { "x-forwarded-proto": "https" },
    }))).toBe(true);
  });

  test("does not mark the cookie Secure over plain HTTP", () => {
    // A browser discards a `Secure` cookie received over plain HTTP, so setting it there would
    // break local development without protecting anything.
    for (const url of ["http://chat.example.com/v1/me", "http://127.0.0.1:3001/v1/me", "http://localhost:3001/v1/me"]) {
      expect(sessionCookieSecure(request({ url }))).toBe(false);
    }
  });
});

describe("response headers", () => {
  test("denies framing, referrers, and unused sensors while allowing same-origin voice/video capture", () => {
    const headers = baselineSecurityHeaders();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["permissions-policy"]).toContain("microphone=(self)");
    expect(headers["permissions-policy"]).toContain("camera=(self)");
    expect(headers["permissions-policy"]).toContain("display-capture=(self)");
    expect(headers["permissions-policy"]).toContain("geolocation=()");
  });

  test("sends HSTS only over HTTPS", () => {
    expect(strictTransportSecurity(request({ url: "https://chat.example.com/v1/me" }))).toContain("max-age=31536000");
    expect(strictTransportSecurity(request({ url: "http://chat.example.com/v1/me" }))).toBeUndefined();
  });

  test("permits the WASM and worker features the client requires", () => {
    const policy = contentSecurityPolicy({ reportOnly: true });
    expect(policy).toContain("wasm-unsafe-eval");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("report-uri /v1/security/csp-report");
  });
});
