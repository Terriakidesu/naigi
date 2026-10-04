import { describe, expect, test } from "bun:test";

// `config` validates the environment once at module load, so each case is exercised in a fresh
// module instance with its own environment. Bun caches modules per resolved path, and the
// query string makes each import distinct.
async function loadConfig(env: Record<string, string | undefined>) {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, Bun.env[key]);
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
  try {
    const module = await import(`./config?case=${encodeURIComponent(JSON.stringify(env))}`);
    return module.config;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
}

async function loadFailure(env: Record<string, string | undefined>) {
  try {
    await loadConfig(env);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const baseEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://localhost:5432/priv_chat",
  ADMIN_DATABASE_URL: "postgres://localhost:5432/priv_chat_admin",
  REDIS_URL: "redis://localhost:6379",
};

describe("redis url validation", () => {
  test("accepts a plaintext loopback connection", async () => {
    const config = await loadConfig({ ...baseEnv, REDIS_URL: "redis://127.0.0.1:6379" });
    expect(config.redisUrl).toBe("redis://127.0.0.1:6379");
  });

  test("accepts credentials in the url", async () => {
    const config = await loadConfig({ ...baseEnv, REDIS_URL: "redis://user:password@localhost:6379" });
    expect(config.redisUrl).toContain("password");
  });

  test("accepts a TLS connection to a remote host", async () => {
    const config = await loadConfig({ ...baseEnv, REDIS_URL: "rediss://cache.internal:6380" });
    expect(config.redisUrl).toBe("rediss://cache.internal:6380");
  });

  test("rejects a plaintext remote connection in production", async () => {
    const message = await loadFailure({ ...baseEnv, REDIS_URL: "redis://cache.internal:6379" });
    expect(message).toContain("rediss");
  });

  test("permits a plaintext remote connection outside production", async () => {
    const config = await loadConfig({
      ...baseEnv,
      NODE_ENV: "development",
      REDIS_URL: "redis://cache.internal:6379",
    });
    expect(config.redisUrl).toBe("redis://cache.internal:6379");
  });

  test("rejects an unsupported protocol", async () => {
    expect(await loadFailure({ ...baseEnv, REDIS_URL: "http://localhost:6379" })).toContain("protocol");
  });

  test("rejects a malformed url", async () => {
    expect(await loadFailure({ ...baseEnv, REDIS_URL: "not a url" })).toContain("valid URL");
  });

  test("rejects a fragment", async () => {
    expect(await loadFailure({ ...baseEnv, REDIS_URL: "redis://localhost:6379#fragment" })).toContain("fragment");
  });

  test("still rejects a shared application and admin database", async () => {
    expect(await loadFailure({
      ...baseEnv,
      ADMIN_DATABASE_URL: "postgres://localhost:5432/priv_chat",
    })).toContain("separate database");
  });
});
