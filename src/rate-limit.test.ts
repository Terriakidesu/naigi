import { afterEach, describe, expect, test } from "bun:test";
import { config } from "./config";
import { rateLimitKey, resolveClientIp } from "./rate-limit";

const originalHops = config.trustedProxyHops;
const originalDatabaseUrl = config.databaseUrl;

afterEach(() => {
  config.trustedProxyHops = originalHops;
  config.databaseUrl = originalDatabaseUrl;
});

describe("rate limit client address resolution", () => {
  test("ignores a forwarded header when no trusted proxy is configured", () => {
    config.trustedProxyHops = 0;

    expect(resolveClientIp({
      forwardedFor: "203.0.113.7",
      socketAddress: "10.0.0.4",
    })).toBe("10.0.0.4");
  });

  test("uses the socket address when no header is present", () => {
    config.trustedProxyHops = 1;

    expect(resolveClientIp({ forwardedFor: undefined, socketAddress: "10.0.0.4" })).toBe("10.0.0.4");
  });

  test("reads the declared hop from the right of the forwarded chain", () => {
    config.trustedProxyHops = 1;

    expect(resolveClientIp({
      forwardedFor: "203.0.113.7, 198.51.100.2",
      socketAddress: "10.0.0.4",
    })).toBe("198.51.100.2");
  });

  test("reads the second-from-right hop when two proxies are trusted", () => {
    config.trustedProxyHops = 2;

    expect(resolveClientIp({
      forwardedFor: "203.0.113.7, 198.51.100.2, 192.0.2.9",
      socketAddress: "10.0.0.4",
    })).toBe("198.51.100.2");
  });

  test("cannot be fooled by a spoofed entry prepended to the forwarded chain", () => {
    config.trustedProxyHops = 1;

    // Each proxy appends the peer address it observed, so the real client address is the
    // rightmost entry and anything a client prepends sits to its left. A client that sends its
    // own `X-Forwarded-For` hoping to be counted under a different budget is ignored.
    expect(resolveClientIp({
      forwardedFor: "203.0.113.7, 198.51.100.2",
      socketAddress: "10.0.0.4",
    })).toBe("198.51.100.2");
  });

  test("reads the leftmost entry when the chain length equals the trusted hop count", () => {
    config.trustedProxyHops = 2;

    // Two proxies produce exactly two entries: the real client followed by the first proxy.
    // There is no room for a client to have prepended anything, so index 0 is the client.
    expect(resolveClientIp({
      forwardedFor: "203.0.113.7, 198.51.100.2",
      socketAddress: "10.0.0.4",
    })).toBe("203.0.113.7");
  });

  test("falls back to the socket address when the chain is shorter than the hop count", () => {
    config.trustedProxyHops = 3;

    expect(resolveClientIp({
      forwardedFor: "203.0.113.7",
      socketAddress: "10.0.0.4",
    })).toBe("10.0.0.4");
  });

  test("normalizes IPv6 and strips ports and zone indices", () => {
    config.trustedProxyHops = 0;

    expect(resolveClientIp({ forwardedFor: undefined, socketAddress: "2001:DB8::1" })).toBe("[2001:db8::1]");
    expect(resolveClientIp({ forwardedFor: undefined, socketAddress: "fe80::1%eth0" })).toBe("[fe80::1]");
    expect(resolveClientIp({ forwardedFor: undefined, socketAddress: "[2001:db8::1]:443" })).toBe("[2001:db8::1]");
    expect(resolveClientIp({ forwardedFor: undefined, socketAddress: "203.0.113.7" })).toBe("203.0.113.7");
  });

  test("returns undefined when no usable address exists", () => {
    config.trustedProxyHops = 0;

    expect(resolveClientIp({ forwardedFor: undefined, socketAddress: undefined })).toBeUndefined();
    expect(resolveClientIp({ forwardedFor: undefined, socketAddress: "   " })).toBeUndefined();
    expect(resolveClientIp({ forwardedFor: "not-an-address", socketAddress: undefined })).toBeUndefined();
  });
});

describe("rate limit keys", () => {
  test("namespaces by scope and drops absent parts", () => {
    expect(rateLimitKey("login-ip", "203.0.113.7")).toEndWith(":login-ip:203.0.113.7");
    expect(rateLimitKey("login-failed", "naigi")).toEndWith(":login-failed:naigi");
    expect(rateLimitKey("login-failed", undefined, "naigi")).toEndWith(":login-failed:naigi");
    expect(rateLimitKey("login-failed", "")).toEndWith(":login-failed");
  });

  test("starts with a stable instance namespace", () => {
    expect(rateLimitKey("login-ip", "203.0.113.7")).toStartWith("naigi:limit:");
  });

  test("separates budgets per instance so shared Redis cannot cross-charge deployments", () => {
    // Several deployments commonly share one Redis, and the test suite runs against temporary
    // database schemas. Without an instance namespace one instance's registrations would exhaust
    // another's budget.
    const original = rateLimitKey("register-ip", "127.0.0.1");
    config.databaseUrl = "postgres://localhost:5432/priv_chat";
    const same = rateLimitKey("register-ip", "127.0.0.1");
    config.databaseUrl = "postgres://localhost:5432/priv_chat_other";
    const different = rateLimitKey("register-ip", "127.0.0.1");

    expect(same).toBe(original);
    expect(different).not.toBe(original);
  });

  test("does not embed database credentials in the key", () => {
    config.databaseUrl = "postgres://operator:hunter2@db.internal:5432/priv_chat";
    const key = rateLimitKey("login-ip", "203.0.113.7");

    expect(key).not.toContain("hunter2");
    expect(key).not.toContain("operator");
  });
});
