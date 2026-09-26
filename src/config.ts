const environment = Bun.env.NODE_ENV ?? "development";

function integerEnvironment(name: string, fallback: number, min: number, max: number) {
  const value = Bun.env[name];
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  return parsed;
}

if (!["development", "test", "production"].includes(environment)) {
  throw new Error("NODE_ENV must be development, test, or production");
}

export const config = {
  environment: environment as "development" | "test" | "production",
  host: Bun.env.HOST ?? "127.0.0.1",
  port: integerEnvironment("PORT", 3000, 1, 65_535),
  databaseUrl: Bun.env.DATABASE_URL ?? "postgres://localhost:5432/priv_chat",
  redisUrl: Bun.env.REDIS_URL ?? "redis://localhost:6379",
  sessionTtlSeconds: integerEnvironment("SESSION_TTL_SECONDS", 60 * 60 * 24 * 30, 300, 60 * 60 * 24 * 365),
  maxEncryptedMessageBytes: integerEnvironment(
    "MAX_ENCRYPTED_MESSAGE_BYTES",
    256 * 1024,
    1,
    4 * 1024 * 1024,
  ),
  maxProtocolMetadataBytes: integerEnvironment(
    "MAX_PROTOCOL_METADATA_BYTES",
    32 * 1024,
    0,
    256 * 1024,
  ),
};
