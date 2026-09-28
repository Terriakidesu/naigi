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

type TwitterPreviewProvider = "fx" | "syndication";
export type GifSearchProviderId = "klipy" | "giphy";
export type GifProviderConfig = {
  id: GifSearchProviderId;
  apiKey: string;
};

function twitterPreviewProviders() {
  const value = Bun.env.TWITTER_PREVIEW_PROVIDERS;
  if (value === undefined) return ["fx", "syndication"] as TwitterPreviewProvider[];

  const providers = value.split(",").map((provider) => provider.trim()).filter(Boolean);
  if (providers.length === 0 || providers.some((provider) => provider !== "fx" && provider !== "syndication")) {
    throw new Error("TWITTER_PREVIEW_PROVIDERS must contain only fx or syndication");
  }

  return [...new Set(providers)] as TwitterPreviewProvider[];
}

function twitterPreviewApiUrl() {
  const value = Bun.env.TWITTER_PREVIEW_API_URL ?? "https://api.fxtwitter.com/2/status";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TWITTER_PREVIEW_API_URL must be an absolute URL");
  }

  const localDevelopmentHost = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "https:" && !(environment !== "production" && url.protocol === "http:" && localDevelopmentHost.has(url.hostname))) {
    throw new Error("TWITTER_PREVIEW_API_URL must use HTTPS outside local development");
  }
  if (url.username || url.password) {
    throw new Error("TWITTER_PREVIEW_API_URL must not contain credentials");
  }
  return value;
}

function publicProviderKey(name: string, maxLength = 512) {
  const value = Bun.env[name]?.trim();
  if (!value) return undefined;
  if (value.length > maxLength || /[\u0000-\u001f\u007f\s]/.test(value)) {
    throw new Error(`${name} must be a non-whitespace public browser API key up to ${maxLength} characters`);
  }
  return value;
}

function gifProviders(): GifProviderConfig[] {
  const providers: GifProviderConfig[] = [];
  const klipyApiKey = publicProviderKey("KLIPY_API_KEY");
  if (klipyApiKey) providers.push({ id: "klipy", apiKey: klipyApiKey });
  const giphyApiKey = publicProviderKey("GIPHY_API_KEY");
  if (giphyApiKey) providers.push({ id: "giphy", apiKey: giphyApiKey });
  return providers;
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
  attachmentsDirectory: Bun.env.ATTACHMENTS_DIR ?? "./data/attachments",
  profileImagesDirectory: Bun.env.PROFILE_IMAGES_DIR ?? "./data/profile-images",
  twitterPreviewApiUrl: twitterPreviewApiUrl(),
  twitterPreviewProviders: twitterPreviewProviders(),
  gifProviders: gifProviders(),
  sessionTtlSeconds: integerEnvironment("SESSION_TTL_SECONDS", 60 * 60 * 24 * 30, 300, 60 * 60 * 24 * 365),
  maxProfileImageBytes: 5 * 1024 * 1024,
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
  maxAttachmentBytes: integerEnvironment(
    "MAX_ATTACHMENT_BYTES",
    25 * 1024 * 1024,
    1,
    100 * 1024 * 1024,
  ),
};
