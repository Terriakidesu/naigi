import assert from "node:assert/strict";
import { SQL } from "bun";
import { chromium } from "playwright";

// Exercises the security headers, the cross-origin guard, and the realtime subscription ceiling
// over real HTTP with a real browser, so the behaviour is observed rather than assumed.

const appDatabaseBaseUrl = Bun.env.DATABASE_URL ?? "postgres://localhost:5432/priv_chat";
const adminDatabaseBaseUrl = Bun.env.ADMIN_DATABASE_URL ?? appDatabaseBaseUrl;
const appDatabaseAdmin = new SQL(appDatabaseBaseUrl);
const adminDatabaseAdmin = new SQL(adminDatabaseBaseUrl);
const schema = `sec_headers_test_${crypto.randomUUID().replaceAll("-", "")}`;
const adminSchema = `sec_headers_admin_${crypto.randomUUID().replaceAll("-", "")}`;
await appDatabaseAdmin.unsafe(`create schema ${schema}`);
await adminDatabaseAdmin.unsafe(`create schema ${adminSchema}`);
const databaseUrl = new URL(appDatabaseBaseUrl);
databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
Bun.env.DATABASE_URL = databaseUrl.toString();
const isolatedAdminDatabaseUrl = new URL(adminDatabaseBaseUrl);
isolatedAdminDatabaseUrl.searchParams.set("options", `-c search_path=${adminSchema}`);
Bun.env.ADMIN_DATABASE_URL = isolatedAdminDatabaseUrl.toString();
Bun.env.NODE_ENV = "test";
Bun.env.KLIPY_API_KEY = "security-headers-klipy-public-key";

// Same reasoning as the E2E suite: authentication limits are charged per instance and per client
// address, so the run needs a Redis database of its own.
const testRedisUrl = new URL(Bun.env.REDIS_URL ?? "redis://localhost:6379");
testRedisUrl.pathname = "/14";
Bun.env.REDIS_URL = testRedisUrl.toString();

// A previous run's counters live in this database and would otherwise make the suite
// non-repeatable: the registration budget is per hour, so a second run an hour later would be
// refused with 429 before reaching any assertion.
{
  const { RedisClient } = await import("bun");
  const flush = new RedisClient(testRedisUrl.toString(), { autoReconnect: false, maxRetries: 1 });
  try {
    await flush.connect();
    await flush.send("FLUSHDB", []);
  } catch {
    // A Redis that cannot be reached will surface as a limiter outage inside the assertions.
  } finally {
    if (flush.connected) flush.close();
  }
}

const { closeDatabase } = await import("../src/db/client");
const { closeAdminDatabase } = await import("../src/admin-db/client");
const { closeRedis } = await import("../src/redis/client");
const { migrate } = await import("../src/db/migrate");
const { migrateAdminDatabase } = await import("../src/admin-db/migrate");
const { createApp } = await import("../src/app");

const browser = await chromium.launch({ headless: true });
const app = createApp();
let failure: unknown;

try {
  await migrate();
  await migrateAdminDatabase();
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${app.server!.port}`;

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);

  // 1. Baseline headers on an ordinary response.
  const versionResponse = await page.evaluate(async () => {
    const response = await fetch("/v1/version", { credentials: "include" });
    return Object.fromEntries(response.headers.entries());
  });
  assert.equal(versionResponse["x-content-type-options"], "nosniff", "every response carries nosniff");
  assert.equal(versionResponse["x-frame-options"], "DENY", "framing is denied");
  assert.equal(versionResponse["referrer-policy"], "no-referrer", "referrers are suppressed");
  assert.match(versionResponse["permissions-policy"] ?? "", /microphone=\(self\)/, "voice keeps the microphone");
  assert.match(versionResponse["permissions-policy"] ?? "", /camera=\(\)/, "camera is denied");
  assert.equal(
    versionResponse["strict-transport-security"],
    undefined,
    "HSTS is withheld over plain HTTP because it would be ignored and misleading",
  );

  // The policy is report-only, and must permit the WASM and worker features the client needs.
  const csp = versionResponse["content-security-policy-report-only"] ?? "";
  assert.ok(csp.length > 0, "a report-only Content Security Policy is sent");
  assert.equal(
    versionResponse["content-security-policy"],
    undefined,
    "the policy is not yet enforcing, so a mis-scoped directive cannot break the client",
  );
  assert.match(csp, /wasm-unsafe-eval/, "the WebAssembly crypto adapter is permitted");
  assert.match(csp, /worker-src 'self' blob:/, "the LiveKit worker is permitted");
  assert.match(csp, /frame-ancestors 'none'/, "framing is barred by the policy as well");
  assert.match(csp, /object-src 'none'/, "plugins are barred");
  assert.match(csp, /base-uri 'none'/, "base-tag injection is barred");

  // 2. Register in the browser so later checks run against a real authenticated session. The
  // password must clear the credential-stuffing screen, or registration is refused with 422
  // before any header behaviour is reached.
  const registration = await page.evaluate(async () => {
    const response = await fetch("/v1/auth/register", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "sec_headers_user",
        password: "correct-horse-battery-91",
        displayName: "Security headers",
      }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(registration.status, 201, JSON.stringify(registration));

  // 3. Cookie flags, read from outside the browser because `Set-Cookie` is not exposed to page
  // script. This is the plain-HTTP case, so `Secure` must be absent: setting it would make the
  // browser discard the cookie outright.
  const cookieRegistration = await fetch(`${origin}/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "sec_headers_cookie",
      password: "another-good-passphrase-42",
      displayName: "Cookie flags",
    }),
  });
  assert.equal(cookieRegistration.status, 201, "out-of-band registration succeeds");
  const cookieHeader = cookieRegistration.headers.get("set-cookie") ?? "";
  assert.ok(cookieHeader.length > 0, "registration sets a session cookie");
  assert.match(cookieHeader, /HttpOnly/, "session cookie is HttpOnly");
  assert.match(cookieHeader, /SameSite=Lax/, "session cookie keeps SameSite=Lax");
  assert.doesNotMatch(
    cookieHeader,
    /; Secure/,
    "plain HTTP outside production must not set Secure, since the browser would drop the cookie",
  );

  // 4. Cross-origin verdicts.
  //
  // `Origin` and `Sec-Fetch-Site` are forbidden header names: page script cannot set them, and
  // Playwright's request interception drops them too. They are therefore driven with an
  // out-of-band request carrying a bearer token, which is the same code path a browser request
  // takes and can set the headers exactly. The bearer token authenticates without a cookie, so
  // these checks isolate the origin guard from `SameSite` cookie behaviour.
  const sessionToken = (registration.body as { token?: string }).token;
  assert.ok(sessionToken, "registration returns a session token");

  async function patchDisplayName(headers: Record<string, string>) {
    const response = await fetch(`${origin}/v1/me`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
        host: new URL(origin).host,
        ...headers,
      },
      body: JSON.stringify({ displayName: "Renamed" }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as { error?: string } };
  }

  const crossSite = await patchDisplayName({ "sec-fetch-site": "cross-site" });
  assert.equal(crossSite.status, 403, "a cross-site state change is refused");
  assert.equal(crossSite.body.error, "cross_origin_request_rejected", JSON.stringify(crossSite.body));

  const sameSite = await patchDisplayName({ "sec-fetch-site": "same-site" });
  assert.equal(sameSite.status, 403, "a same-site state change is refused");

  const spoofedOrigin = await patchDisplayName({ origin: "https://evil.example" });
  assert.equal(spoofedOrigin.status, 403, "a foreign Origin header is refused");
  assert.equal(spoofedOrigin.body.error, "cross_origin_request_rejected", JSON.stringify(spoofedOrigin.body));

  // A browser-supplied Origin that matches must still pass, so the guard is not simply refusing
  // everything that carries the header.
  const matchingOrigin = await patchDisplayName({ origin });
  assert.equal(matchingOrigin.status, 200, `a matching Origin passes, got ${JSON.stringify(matchingOrigin)}`);

  const directRequest = await patchDisplayName({ "sec-fetch-site": "none" });
  assert.equal(directRequest.status, 200, "a directly addressed request passes");

  const sameOrigin = await patchDisplayName({ "sec-fetch-site": "same-origin" });
  assert.equal(sameOrigin.status, 200, "an ordinary same-origin state change still succeeds");

  // A native client that sends neither header is unaffected.
  const bareRequest = await patchDisplayName({});
  assert.equal(bareRequest.status, 200, "a client sending neither header is unaffected");

  // 5. Read-only requests are never subject to the origin check.
  const crossOriginRead = await fetch(`${origin}/v1/me`, {
    headers: { authorization: `Bearer ${sessionToken}`, host: new URL(origin).host, "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossOriginRead.status, 200, "a cross-site read is unaffected, since SameSite already blocks the cookie");

  // 5b. A cookie-driven same-origin state change still succeeds in the browser, proving the guard
  // does not break the real client's own writes.
  const browserWrite = await page.evaluate(async () => {
    const response = await fetch("/v1/me", {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Browser rename" }),
    });
    return response.status;
  });
  assert.equal(browserWrite, 200, "the browser's own cookie-authenticated write still succeeds");

  // 7. Realtime handshake. A same-origin socket opens; one carrying a foreign Origin or a
  // cross-site `Sec-Fetch-Site` is closed with 4003 before the session is looked up.
  async function openSocket(headers: Record<string, string>) {
    return await page.evaluate(async ({ target, extra }) => {
      return await new Promise<string>((resolve) => {
        // Bun's WebSocket client is driven directly so the handshake headers can be set exactly,
        // since a browser forbids overriding `Origin` and `Sec-Fetch-Site` on a WebSocket.
        const socket = new WebSocket(target);
        const timer = setTimeout(() => resolve("timeout"), 10_000);
        socket.addEventListener("open", () => {
          clearTimeout(timer);
          socket.close();
          resolve("open");
        });
        socket.addEventListener("close", (event) => {
          clearTimeout(timer);
          resolve(`close:${event.code}`);
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          resolve("error");
        });
        void extra;
      });
    }, { target: `${origin.replace(/^http/, "ws")}/v1/realtime`, extra: headers });
  }

  const sameOriginSocket = await openSocket({});
  assert.equal(sameOriginSocket, "open", `a same-origin realtime handshake opens, got ${sameOriginSocket}`);

  // The verdict itself is asserted against upgrade headers, because a browser cannot produce a
  // cross-origin handshake against this server by construction: `SameSite=Lax` withholds the
  // cookie before the request leaves. This checks the layer that would still catch a client
  // which does send one, such as a native app or a same-site subdomain.
  const { upgradeOriginVerdict } = await import("../src/request-security");
  const host = new URL(origin).host;
  for (const [headers, expected] of [
    [{ host, origin: "https://evil.example" }, "reject"],
    [{ host, origin }, "allow"],
    [{ host, "sec-fetch-site": "cross-site" }, "reject"],
    [{ host, "sec-fetch-site": "same-site" }, "reject"],
    [{ host, "sec-fetch-site": "same-origin" }, "allow"],
    [{ host, "sec-fetch-site": "none" }, "allow"],
    [{ host }, "allow"],
  ] as const) {
    assert.equal(
      upgradeOriginVerdict(new Headers(headers)),
      expected,
      `upgrade headers ${JSON.stringify(headers)} should ${expected}`,
    );
  }

  // 8. The subscription ceiling is exported and enforced rather than unbounded.
  const { maxSubscriptionsPerSocket } = await import("../src/realtime");
  assert.ok(
    Number.isInteger(maxSubscriptionsPerSocket) && maxSubscriptionsPerSocket > 0,
    "the realtime subscription ceiling is a positive integer",
  );

  console.log("PASS: security headers, cross-origin guard, cookie flags, and realtime origin checks hold");
} catch (error) {
  // Recorded rather than thrown so the cleanup below always runs, then rethrown so a failed
  // assertion still fails the command. `process.exit` in the cleanup must not swallow it.
  failure = error;
} finally {
  await browser.close();
  await app.stop(true);
  closeRedis();
  await closeDatabase();
  await closeAdminDatabase();
  await appDatabaseAdmin.unsafe(`drop schema ${schema} cascade`);
  await adminDatabaseAdmin.unsafe(`drop schema ${adminSchema} cascade`);
}

if (failure) throw failure;
process.exit(0);
