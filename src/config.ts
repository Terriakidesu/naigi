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

function adminDatabaseUrl(databaseUrl: string) {
  const value = Bun.env.ADMIN_DATABASE_URL;
  let url: URL;
  try {
    url = new URL(value ?? databaseUrl);
  } catch {
    throw new Error("ADMIN_DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (!value) {
    const databaseName = url.pathname.replace(/^\//, "");
    if (!databaseName) throw new Error("DATABASE_URL must include a database name to derive ADMIN_DATABASE_URL");
    url.pathname = `/${databaseName}_admin`;
  }

  const appUrl = new URL(databaseUrl);
  const postgresProtocols = new Set(["postgres:", "postgresql:"]);
  const sameDatabase = postgresProtocols.has(url.protocol)
    && postgresProtocols.has(appUrl.protocol)
    && url.hostname === appUrl.hostname
    && (url.port || "5432") === (appUrl.port || "5432")
    && decodeURIComponent(url.pathname) === decodeURIComponent(appUrl.pathname);
  if (sameDatabase && environment !== "test") {
    throw new Error("ADMIN_DATABASE_URL must point to a separate database from DATABASE_URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("ADMIN_DATABASE_URL must use the postgres or postgresql protocol");
  }

  return url.toString();
}

function firebaseMessagingConfiguration() {
  const serviceAccountJson = Bun.env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  const webConfigJson = Bun.env.FCM_WEB_CONFIG_JSON?.trim();
  const vapidKey = Bun.env.FCM_VAPID_KEY?.trim();
  if (!serviceAccountJson && !webConfigJson && !vapidKey) return undefined;
  if (!serviceAccountJson || !webConfigJson || !vapidKey) {
    throw new Error("FCM_SERVICE_ACCOUNT_JSON, FCM_WEB_CONFIG_JSON, and FCM_VAPID_KEY must be configured together");
  }

  let serviceAccount: Record<string, unknown>;
  let web: Record<string, unknown>;
  try {
    serviceAccount = JSON.parse(serviceAccountJson) as Record<string, unknown>;
    web = JSON.parse(webConfigJson) as Record<string, unknown>;
  } catch {
    throw new Error("FCM_SERVICE_ACCOUNT_JSON and FCM_WEB_CONFIG_JSON must contain valid JSON");
  }

  const projectId = typeof serviceAccount.project_id === "string" ? serviceAccount.project_id : "";
  const clientEmail = typeof serviceAccount.client_email === "string" ? serviceAccount.client_email : "";
  const privateKey = typeof serviceAccount.private_key === "string" ? serviceAccount.private_key.replace(/\\n/g, "\n") : "";
  const publicProjectId = typeof web.projectId === "string" ? web.projectId : "";
  const apiKey = typeof web.apiKey === "string" ? web.apiKey : "";
  const appId = typeof web.appId === "string" ? web.appId : "";
  const messagingSenderId = typeof web.messagingSenderId === "string" ? web.messagingSenderId : "";
  const authDomain = typeof web.authDomain === "string" ? web.authDomain : undefined;

  if (!projectId || !clientEmail || !privateKey || !privateKey.includes("PRIVATE KEY")) {
    throw new Error("FCM_SERVICE_ACCOUNT_JSON must include project_id, client_email, and private_key");
  }
  if (publicProjectId !== projectId || !apiKey || !appId || !messagingSenderId) {
    throw new Error("FCM_WEB_CONFIG_JSON must include apiKey, appId, messagingSenderId, and the matching projectId");
  }
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(vapidKey)) {
    throw new Error("FCM_VAPID_KEY must be a valid Firebase Web Push certificate key");
  }

  return {
    projectId,
    clientEmail,
    privateKey,
    vapidKey,
    webConfig: { apiKey, appId, messagingSenderId, projectId, ...(authDomain ? { authDomain } : {}) },
  };
}

const firebaseMessaging = firebaseMessagingConfiguration();
const databaseUrl = Bun.env.DATABASE_URL ?? "postgres://localhost:5432/priv_chat";

if (!["development", "test", "production"].includes(environment)) {
  throw new Error("NODE_ENV must be development, test, or production");
}

export const config = {
  environment: environment as "development" | "test" | "production",
  host: Bun.env.HOST ?? "127.0.0.1",
  port: integerEnvironment("PORT", 3000, 1, 65_535),
  databaseUrl,
  adminDatabaseUrl: adminDatabaseUrl(databaseUrl),
  redisUrl: Bun.env.REDIS_URL ?? "redis://localhost:6379",
  firebaseMessaging,
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
