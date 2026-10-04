import { password } from "bun";
import { deviceClientName } from "./device-client";
import { createPublicKey } from "node:crypto";
import { Elysia, t } from "elysia";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import {
  AttachmentSizeMismatchError,
  AttachmentTooLargeError,
  attachmentPath,
  encryptedAttachmentExists,
  removeEncryptedAttachment,
  storeEncryptedAttachment,
} from "./attachments/storage";
import {
  authenticate,
  createSession,
  deleteSession,
  extractBearerToken,
  extractCookieToken,
  hashSessionToken,
  normalizeUsername,
  verifyPassword,
} from "./auth/session";
import {
  authenticateAdmin,
  createAdminSession,
  deleteAdminSession,
  extractAdminCookieToken,
  normalizeAdminUsername,
  verifyAdminPassword,
  type AuthenticatedAdmin,
} from "./admin-auth/session";
import { adminCan, type AdminCapability } from "./admin-auth/permissions";
import { config } from "./config";
import { getInstanceLiveResources, getInstanceOperationsOverview, getInstanceOperationsSnapshot } from "./admin-operations";
import {
  liveConnectionRefreshMs,
  refreshLiveConnections,
  registerLiveConnection,
  removeLiveConnection,
} from "./admin-operations/live-connections";
import {
  getStorageMaintenanceSummary,
  inspectStorageMaintenance,
  purgeExpiredQuarantinedStorage,
  quarantineOrphanedStorage,
  restoreQuarantinedStorage,
  StorageMaintenanceError,
} from "./admin-maintenance";
import { decodeBase64, encodeBase64, InvalidEncodingError } from "./encoding";
import { screenPassword } from "./password-policy";
import {
  baselineSecurityHeaders,
  contentSecurityPolicy,
  crossOriginVerdict,
  sessionCookieSecure,
  strictTransportSecurity,
  upgradeOriginVerdict,
} from "./request-security";

import {
  bumpRateLimit,
  peekRateLimit,
  rateLimitKey,
  resolveClientIp,
  type RateLimitVerdict,
} from "./rate-limit";
import { db, pingDatabase } from "./db/client";
import { adminDb, pingAdminDatabase } from "./admin-db/client";
import {
  ProfileImageInvalidError,
  profileBannerUrl,
  profileImageMetadata,
  profileImagePath,
  profileImageUrl,
  removeProfileImage,
  storeProfileImage,
  validProfileImageBytes,
} from "./profile-images";
import { connectRedis, evalRedisScript, pingRedis, publishMessageCreated, redis } from "./redis/client";
import {
  publicFirebaseMessagingConfiguration,
  registerFcmPushToken,
  removeFcmPushToken,
  sendGenericFcmPush,
} from "./push/fcm";
import { clearMembershipCacheFor, createRealtimeConnection, type RealtimeConnection } from "./realtime";
import { fetchTwitterPreview, parseTwitterStatusUrl } from "./twitter-preview";
import { historyRecoveryRoutes } from "./history-recovery";
import { serverVersionInfo } from "./server-version";
import { claimVoiceRoomDevice, VoiceRoomDeviceConflict, voiceRoomIdentity } from "./voice-room-device";

// Extracted collaborators. `app.ts` now holds route wiring only; the domain logic these routes
// depend on lives beside the module that owns it.
import { recordInstanceAdminAudit, recordServerAudit } from "./http/audit";
import {
  authRateLimitIpWindowSeconds,
  authRateLimitWindowSeconds,
  clientIpFor,
  enforceRateLimits,
} from "./http/limits";
import {
  clearAdminSessionCookie,
  clearSessionCookie,
  isUniqueViolation,
  respondError,
  setAdminSessionCookie,
  setSessionCookie,
} from "./http/responses";
import { publicFile } from "./http/static-files";
import { adminPageResponse } from "./admin/pages";
import { serverBrandingUrl, toMessage, toPublicUser, type MessageRow, type UserRow } from "./http/shapes";
import {
  decodeEncryptedMetadata,
  decodePageCursor,
  encodePageCursor,
  encryptedBytes,
  isCursorTimestamp,
  isUuid,
  matrixUserId,
  objectValue,
  parseCryptoUpload,
  prefixUpperBound,
  stringArray,
} from "./http/validation";
import {
  attachmentMetadata,
  maxCustomEmojiBytes,
  maxToDeviceDevicesPerRecipient,
  maxToDeviceEventBytes,
  maxToDeviceEventsPerRequest,
  maxToDeviceRecipients,
} from "./attachments/metadata";
import { directConversationIsBlocked, usersAreBlocked } from "./moderation/blocks";
import { isInstanceUserTimedOut, isUserTimedOut } from "./moderation/timeouts";
import {
  canManageRole,
  canManageRoleHierarchy,
  canModerateTarget,
  defaultRolePermissions,
  hasAnyServerPermission,
  hasServerPermission,
  highestRolePosition,
  permissionMap,
  serverAuthorization,
  serverMembership,
} from "./servers/permissions";
import {
  channelAuthorization,
  conversationChannelAuthorization,
  isMetadataChannel,
  visibleServerChannels,
} from "./servers/channel-access";
import { syncChannelConversationMembership, syncServerChannelMemberships } from "./servers/membership";
import { publicServerRole, rolePermissionInput, validRoleColor, type ServerRoleRow } from "./servers/roles";
import { hashInviteToken, newInviteToken } from "./servers/invite-tokens";
import { directVoiceCallAccessError, voiceRoomAccessError, voiceSignalAccessError } from "./voice/access";
import { deviceRoutes } from "./devices/routes";
import { cryptoRoutes } from "./crypto/routes";
import { realtimeSocketRoute } from "./realtime/route";
import { closeSocketsForUser } from "./realtime-registry";
import { conversationRoutes } from "./conversations/routes";
import { moderationRoutes } from "./servers/moderation";
import { serverRoutes } from "./servers/routes";
import { spaceMediaRoutes } from "./servers/media";
import { channelRoutes } from "./servers/channel-routes";
import { roleRoutes } from "./servers/role-routes";
import { attachmentRoutes } from "./attachments/routes";
import { messageRoutes } from "./conversations/messages";

const registrationBody = t.Object({
  username: t.String({ minLength: 3, maxLength: 32, pattern: "^[A-Za-z0-9_.-]+$" }),
  password: t.String({ minLength: 12, maxLength: 128 }),
  displayName: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
});

// Login deliberately accepts a short password. Sharing the registration schema meant a wrong
// password shorter than 12 characters returned 422 validation_error instead of 401
// invalid_credentials, which told an attacker their guess was too short rather than wrong and made
// the two failure modes distinguishable. Verification is what decides validity here.
const loginBody = t.Object({
  username: t.String({ minLength: 3, maxLength: 32, pattern: "^[A-Za-z0-9_.-]+$" }),
  password: t.String({ minLength: 1, maxLength: 128 }),
  displayName: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
});

const realtimeCommand = t.Union([
  t.Object({
    type: t.Literal("subscribe"),
    conversationId: t.String({ format: "uuid" }),
  }),
  t.Object({
    type: t.Literal("unsubscribe"),
    conversationId: t.String({ format: "uuid" }),
  }),
  t.Object({
    type: t.Literal("typing"),
    conversationId: t.String({ format: "uuid" }),
    isTyping: t.Boolean(),
  }),
  t.Object({
    type: t.Literal("presence"),
    conversationId: t.String({ format: "uuid" }),
    state: t.Union([t.Literal("online"), t.Literal("idle"), t.Literal("offline")]),
  }),
  t.Object({
    type: t.Literal("voice.signal"),
    conversationId: t.String({ format: "uuid" }),
    ciphertext: t.String({ minLength: 1, maxLength: config.maxProtocolMetadataBytes }),
  }),
]);

let liveKitRooms: RoomServiceClient | undefined;

function liveKitRoomService() {
  if (!config.liveKit) return undefined;
  liveKitRooms ??= new RoomServiceClient(config.liveKit.httpUrl, config.liveKit.apiKey, config.liveKit.apiSecret);
  return liveKitRooms;
}

/**
 * Voice token issuance budget.
 *
 * Each call mints a signed LiveKit token, so the count is charged per user per minute against a
 * Redis counter. This is the pre-existing voice-specific limit; the general limiter in
 * `http/limits.ts` covers the authentication routes.
 */
async function voiceTokenRateLimited(userId: string) {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `naigi:voice-token:${userId}:${minute}`;
  const count = Number(await evalRedisScript(
    "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count",
    1,
    key,
    120,
  ));
  return count > 12;
}

export function createApp() {
  return new Elysia()
    .use(historyRecoveryRoutes)
    // Second layer behind the `SameSite` cookies: refuse a state-changing request that the
    // browser positively identifies as cross-origin. Requests that carry neither `Origin` nor
    // `Sec-Fetch-Site` are allowed, since native clients send neither.
    .onBeforeHandle({ as: "global" }, ({ request, set }) => {
      if (crossOriginVerdict({ method: request.method, url: request.url, headers: request.headers }) === "reject") {
        return respondError(set, 403, "cross_origin_request_rejected");
      }
    })
    // Report-only in this release. The Olm/Megolm adapter is WebAssembly and LiveKit runs a
    // worker, so an enforcing policy that omits `wasm-unsafe-eval` or blob workers would break
    // decryption and calling outright. Switched to enforcing once collected reports are clean.
    .onAfterHandle({ as: "global" }, ({ request, set }) => {
      for (const [header, value] of Object.entries(baselineSecurityHeaders())) {
        set.headers[header] ??= value;
      }
      const hsts = strictTransportSecurity({ url: request.url, headers: request.headers });
      if (hsts) set.headers["strict-transport-security"] ??= hsts;
      set.headers["content-security-policy-report-only"] ??= contentSecurityPolicy({ reportOnly: true });
    })
    .onError(({ code, error, request, set }) => {
      if (code === "VALIDATION") return respondError(set, 422, "validation_error");
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
      console.error(`[request-error] ${request.method} ${new URL(request.url).pathname} (${code})\n${detail}`);
      return respondError(set, 500, "internal_error");
    })
    .get("/v1/version", () => serverVersionInfo())
    .get("/", async () => {
      return await publicFile("index.html", "text/html; charset=utf-8")
         ?? serverVersionInfo();
    })
    .get("/register", async ({ set }) => {
      const file = await publicFile("register.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/app", async ({ set }) => {
      const file = await publicFile("chat.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/channels/:serverId/:channelId", async ({ set }) => {
      const file = await publicFile("chat.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/unlock", async ({ set }) => {
      const file = await publicFile("unlock.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/new", async ({ set }) => {
      const file = await publicFile("new.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/settings", async ({ set }) => {
      const file = await publicFile("settings.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-admin", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-admin.html", "moderation");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/operations", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-operations.html", "platform");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/users", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-users.html", "moderation");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/spaces", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-spaces.html", "platform");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/maintenance", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-maintenance.html", "platform");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin/operators", async ({ headers, set }) => {
      const file = await adminPageResponse(headers.cookie, "instance-operators.html", "operatorManagement");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-store";
      return file;
    })
    .get("/instance-admin-theme-init.js", async ({ set }) => {
      const file = await publicFile("instance-admin-theme-init.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/livekit-e2ee-worker.mjs", async ({ set }) => {
      const file = await publicFile("livekit-e2ee-worker.mjs", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/voice-audio-worklet.js", async ({ set }) => {
      const file = await publicFile("voice-audio-worklet.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/auth.js", async ({ set }) => {
      const file = await publicFile("auth.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/register.js", async ({ set }) => {
      const file = await publicFile("register.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/unlock.js", async ({ set }) => {
      const file = await publicFile("unlock.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/main.js", async ({ set }) => {
      const file = await publicFile("main.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/new.js", async ({ set }) => {
      const file = await publicFile("new.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/settings.js", async ({ set }) => {
      const file = await publicFile("settings.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-admin.js", async ({ set }) => {
      const file = await publicFile("instance-admin.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-operations.js", async ({ set }) => {
      const file = await publicFile("instance-operations.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-users.js", async ({ set }) => {
      const file = await publicFile("instance-users.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-operators.js", async ({ set }) => {
      const file = await publicFile("instance-operators.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-spaces.js", async ({ set }) => {
      const file = await publicFile("instance-spaces.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-maintenance.js", async ({ set }) => {
      const file = await publicFile("instance-maintenance.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-admin-login.js", async ({ set }) => {
      const file = await publicFile("instance-admin-login.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/server-settings", async ({ set }) => {
      const file = await publicFile("server-settings.html", "text/html; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/server-settings.js", async ({ set }) => {
      const file = await publicFile("server-settings.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/app.css", async ({ set }) => {
      const file = await publicFile("app.css", "text/css; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/instance-admin.css", async ({ set }) => {
      const file = await publicFile("instance-admin.css", "text/css; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/chunks/:chunk", async ({ params, set }) => {
      if (!/^[A-Za-z0-9_-]+\.js(?:\.LEGAL\.txt)?$/.test(params.chunk)) return respondError(set, 404, "asset_not_found");
      const file = Bun.file(`${import.meta.dir}/../public/chunks/${params.chunk}`);
      if (!await file.exists()) return respondError(set, 404, "asset_not_found");
      return new Response(file, { headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": params.chunk.endsWith(".txt") ? "text/plain; charset=utf-8" : "text/javascript; charset=utf-8",
      } });
    })
    .get("/version.json", async ({ set }) => {
      const file = await publicFile("version.json", "application/json; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["cache-control"] = "no-cache";
      return file;
    })
    .get("/LICENSE", async ({ set }) => {
      const file = await publicFile("LICENSE", "text/plain; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/third-party-licenses.txt", async ({ set }) => {
      const file = await publicFile("third-party-licenses.txt", "text/plain; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/favicon.svg", async ({ set }) => {
      const file = await publicFile("favicon.svg", "image/svg+xml");
      if (!file) return respondError(set, 404, "client_not_built");
      return file;
    })
    .get("/push-sw.js", async ({ set }) => {
      const file = await publicFile("push-sw.js", "text/javascript; charset=utf-8");
      if (!file) return respondError(set, 404, "client_not_built");
      set.headers["service-worker-allowed"] = "/";
      set.headers["cache-control"] = "no-cache";
      return file;
    })
    .get("/assets/twemoji/:asset", async ({ params, set }) => {
      if (!/^[A-Za-z0-9_.-]+$/.test(params.asset) || !params.asset.endsWith(".svg") && params.asset !== "NOTICE.txt" && params.asset !== "LICENSE-GRAPHICS") {
        return respondError(set, 404, "asset_not_found");
      }
      const file = Bun.file(`${import.meta.dir}/../public/assets/twemoji/${params.asset}`);
      if (!(await file.exists())) return respondError(set, 404, "asset_not_found");
      return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable", "content-type": params.asset.endsWith(".svg") ? "image/svg+xml" : "text/plain; charset=utf-8" } });
    })
    .get("/assets/:asset", async ({ params, set }) => {
      if (params.asset === "." || params.asset === ".." || !/^[A-Za-z0-9_.-]+$/.test(params.asset)) {
        return respondError(set, 404, "asset_not_found");
      }
      const file = Bun.file(`${import.meta.dir}/../public/assets/${params.asset}`);
      if (!(await file.exists())) return respondError(set, 404, "asset_not_found");
      const contentType = params.asset.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
      return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable", "content-type": contentType } });
    })
    .get("/health/live", () => ({ status: "ok" }))
    .get("/health/ready", async ({ set }) => {
      const [database, adminDatabase, redis] = await Promise.allSettled([
        pingDatabase(), pingAdminDatabase(), pingRedis(),
      ]);
      const ready = database.status === "fulfilled"
        && adminDatabase.status === "fulfilled"
        && redis.status === "fulfilled";
      const response = {
        status: ready ? "ok" : "degraded",
        dependencies: {
          database: database.status === "fulfilled" ? "ok" : "unavailable",
          adminDatabase: adminDatabase.status === "fulfilled" ? "ok" : "unavailable",
          redis: redis.status === "fulfilled" ? "ok" : "unavailable",
        },
      };

      if (!ready) set.status = 503;
      return response;
    })
    .get("/v1/push/config", ({ set }) => {
      set.headers["cache-control"] = "no-store";
      return publicFirebaseMessagingConfiguration();
    })
    .get("/v1/reports/public-key", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      const [key] = await db<{ id: string; public_key: Buffer }[]>`
        select id, public_key from instance_report_keys where active limit 1
      `;
      return key
        ? { configured: true, keyId: key.id, publicKey: encodeBase64(key.public_key) }
        : { configured: false as const };
    })
    .post("/v1/instance-admin/auth/login", async ({ body, headers, request, server, set }) => {
      set.headers["cache-control"] = "no-store";
      const existing = await authenticateAdmin(headers.cookie);
      if (existing) return { operator: existing };

      const account = normalizeAdminUsername(body.username);
      const clientIp = clientIpFor({ request, headers, server });

      // Stricter budgets than user login: this endpoint guards the whole instance, so the
      // per-IP window is short and the per-account failure budget is small.
      const verdicts: RateLimitVerdict[] = [];
      if (clientIp) {
        verdicts.push(await bumpRateLimit({
          key: rateLimitKey("admin-login-ip", clientIp),
          limit: 10,
          windowSeconds: authRateLimitIpWindowSeconds,
          failClosed: true,
        }));
      }
      verdicts.push(await peekRateLimit({
        key: rateLimitKey("admin-login-failed", account),
        limit: 5,
        failClosed: true,
      }));

      const refused = enforceRateLimits(set, verdicts);
      if (refused) return refused;

      const operator = await verifyAdminPassword(body.username, body.password);
      if (!operator) {
        await bumpRateLimit({
          key: rateLimitKey("admin-login-failed", account),
          limit: 5,
          windowSeconds: authRateLimitWindowSeconds,
          failClosed: true,
        });
        return respondError(set, 401, "invalid_credentials");
      }
      const session = await createAdminSession(operator.id);
      if (!session) return respondError(set, 401, "invalid_credentials");
      setAdminSessionCookie(set, session.token, request);
      return { operator };
    }, {
      body: t.Object({
        username: t.String({ minLength: 3, maxLength: 128 }),
        password: t.String({ minLength: 1, maxLength: 1_024 }),
      }),
    })
    .get("/v1/instance-admin/auth/me", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      return { operator };
    })
    .post("/v1/instance-admin/auth/logout", async ({ headers, request, set }) => {
      await deleteAdminSession(extractAdminCookieToken(headers.cookie));
      clearAdminSessionCookie(set, request);
      set.headers["cache-control"] = "no-store";
      return { loggedOut: true };
    })
    .get("/v1/instance-admin/reports", async ({ headers, query, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const status = query.status ?? "open";
      const reports = await db<{
        id: string;
        reporter_user_id: string | null;
        reporter_username: string | null;
        reporter_display_name: string | null;
        target_user_id: string | null;
        target_username: string | null;
        target_display_name: string | null;
        conversation_id: string | null;
        message_id: string | null;
        reason: string;
        status: string;
        has_evidence: boolean;
        created_at: Date;
        reviewed_at: Date | null;
        suspended: boolean;
      }[]>`
        select r.id, r.reporter_user_id, reporter.username as reporter_username,
          reporter.display_name as reporter_display_name, r.target_user_id,
          target.username as target_username, target.display_name as target_display_name,
          r.conversation_id, r.message_id, r.reason, r.status,
          (r.evidence_ciphertext is not null) as has_evidence, r.created_at, r.reviewed_at,
          exists(select 1 from instance_user_suspensions s where s.user_id = r.target_user_id) as suspended
        from instance_reports r
        left join users reporter on reporter.id = r.reporter_user_id
        left join users target on target.id = r.target_user_id
        where (${status} = 'all' or r.status = ${status})
        order by case when r.status in ('open', 'reviewing') then 0 else 1 end,
          r.created_at desc
        limit 200
      `;
      return {
        reports: reports.map((report) => ({
          id: report.id,
          reporterUserId: report.reporter_user_id,
          reporterUsername: report.reporter_username,
          reporterDisplayName: report.reporter_display_name,
          targetUserId: report.target_user_id,
          targetUsername: report.target_username,
          targetDisplayName: report.target_display_name,
          conversationId: report.conversation_id,
          messageId: report.message_id,
          reason: report.reason,
          status: report.status,
          hasEvidence: user.role === "admin" && report.has_evidence,
          createdAt: report.created_at,
          reviewedAt: report.reviewed_at,
          suspended: report.suspended,
        })),
      };
    }, {
      query: t.Object({ status: t.Optional(t.Union([
        t.Literal("all"), t.Literal("open"), t.Literal("reviewing"), t.Literal("resolved"), t.Literal("dismissed"),
      ])) }),
    })
    .get("/v1/instance-admin/reports/:reportId", async ({ headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      const [report] = await db<{
        id: string;
        reporter_user_id: string | null;
        reporter_username: string | null;
        reporter_display_name: string | null;
        target_user_id: string | null;
        target_username: string | null;
        target_display_name: string | null;
        conversation_id: string | null;
        message_id: string | null;
        reason: string;
        status: string;
        evidence_key_id: string | null;
        evidence_ciphertext: Buffer | null;
        evidence_wrapped_key: Buffer | null;
        evidence_iv: Buffer | null;
        created_at: Date;
        reviewed_by: string | null;
        reviewed_at: Date | null;
      }[]>`
        select r.id, r.reporter_user_id, reporter.username as reporter_username,
          reporter.display_name as reporter_display_name, r.target_user_id,
          target.username as target_username, target.display_name as target_display_name,
          r.conversation_id, r.message_id, r.reason, r.status, r.evidence_key_id,
          r.evidence_ciphertext, r.evidence_wrapped_key, r.evidence_iv, r.created_at,
          r.reviewed_by, r.reviewed_at
        from instance_reports r
        left join users reporter on reporter.id = r.reporter_user_id
        left join users target on target.id = r.target_user_id
        where r.id = ${params.reportId}
      `;
      if (!report) return respondError(set, 404, "report_not_found");
      await recordInstanceAdminAudit(user, "report.viewed", report.id, report.target_user_id);
      set.headers["cache-control"] = "no-store";
      return {
        report: {
          id: report.id,
          reporterUserId: report.reporter_user_id,
          reporterUsername: report.reporter_username,
          reporterDisplayName: report.reporter_display_name,
          targetUserId: report.target_user_id,
          targetUsername: report.target_username,
          targetDisplayName: report.target_display_name,
          conversationId: report.conversation_id,
          messageId: report.message_id,
          reason: report.reason,
          status: report.status,
          createdAt: report.created_at,
          reviewedBy: report.reviewed_by,
          reviewedAt: report.reviewed_at,
          evidence: user.role === "admin" && report.evidence_ciphertext && report.evidence_wrapped_key && report.evidence_iv && report.evidence_key_id
            ? {
              keyId: report.evidence_key_id,
              ciphertext: encodeBase64(report.evidence_ciphertext),
              wrappedKey: encodeBase64(report.evidence_wrapped_key),
              iv: encodeBase64(report.evidence_iv),
            }
            : null,
        },
      };
    }, {
      params: t.Object({ reportId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/instance-admin/reports/:reportId/evidence-access", async ({ headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "evidenceKeys")) return respondError(set, 403, "forbidden");
      const [report] = await db<{ id: string; target_user_id: string | null; has_evidence: boolean }[]>`
        select id, target_user_id, evidence_ciphertext is not null as has_evidence
        from instance_reports where id = ${params.reportId}
      `;
      if (!report) return respondError(set, 404, "report_not_found");
      if (!report.has_evidence) return respondError(set, 409, "report_has_no_evidence");
      await recordInstanceAdminAudit(user, "report.evidence_accessed", report.id, report.target_user_id);
      return { audited: true };
    }, {
      params: t.Object({ reportId: t.String({ format: "uuid" }) }),
    })
    .patch("/v1/instance-admin/reports/:reportId", async ({ body, headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      let updated: { id: string; target_user_id: string | null } | undefined;
      try {
        updated = await db.begin(async (transaction) => {
          const [row] = await transaction<{ id: string; target_user_id: string | null }[]>`
            update instance_reports
            set status = ${body.status}, reviewed_by = ${user.id},
              reviewed_by_username = ${user.username}, reviewed_by_display_name = ${user.username}, reviewed_at = now()
            where id = ${params.reportId}
            returning id, target_user_id
          `;
          if (!row) return undefined;
          await transaction`
            insert into instance_admin_audit_logs (
              admin_user_id, admin_username, admin_display_name, action, report_id, target_user_id
            ) values (
              ${user.id}, ${user.username}, ${user.username}, ${`report.${body.status}`}, ${row.id}, ${row.target_user_id}
            )
          `;
          return row;
        });
      } catch (error) {
        if (isUniqueViolation(error)) return respondError(set, 409, "report_conflicts_with_open_report");
        throw error;
      }
      if (!updated) return respondError(set, 404, "report_not_found");
      return { updated: true };
    }, {
      params: t.Object({ reportId: t.String({ format: "uuid" }) }),
      body: t.Object({ status: t.Union([t.Literal("open"), t.Literal("reviewing"), t.Literal("resolved"), t.Literal("dismissed")]) }),
    })
    .post("/v1/instance-admin/reports/:reportId/remove-message", async ({ headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      const [report] = await db<{ id: string; target_user_id: string | null; message_id: string | null; conversation_id: string | null }[]>`
        select id, target_user_id, message_id, conversation_id
        from instance_reports where id = ${params.reportId}
      `;
      if (!report) return respondError(set, 404, "report_not_found");
      if (!report.message_id || !report.conversation_id) return respondError(set, 409, "report_has_no_message");
      const recipients = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${report.conversation_id} and left_at is null
      `;
      const deleted = await db.begin(async (transaction) => {
        const [row] = await transaction<{ id: string }[]>`
          delete from messages where id = ${report.message_id} and conversation_id = ${report.conversation_id}
          returning id
        `;
        if (!row) return undefined;
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, report_id, target_user_id
          ) values (
            ${user.id}, ${user.username}, ${user.username}, 'report.message_removed', ${report.id}, ${report.target_user_id}
          )
        `;
        return row;
      });
      if (!deleted) return respondError(set, 404, "message_not_found");
      await publishMessageCreated(report.conversation_id, {
        type: "message.deleted",
        messageId: deleted.id,
        conversationId: report.conversation_id,
      }, recipients.map((recipient) => recipient.user_id));
      return { removed: true };
    }, {
      params: t.Object({ reportId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/instance-admin/users", async ({ headers, query, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "moderation")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const field = query.field ?? "username";
      const rawSearch = (query.search?.trim() ?? "").replaceAll("\u0000", "");
      const search = (field === "username" ? rawSearch.normalize("NFKC") : rawSearch).toLowerCase().slice(0, 100);
      const status = query.status ?? "all";
      const requestedLimit = Number(query.limit ?? 50);
      const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
      const cursor = decodePageCursor(query.cursor);
      if (query.cursor && (!cursor || typeof cursor.key !== "string" || cursor.key.length > 240
        || !isUuid(cursor.id) || cursor.context !== `${status}:${field}:${search}`)) {
        return respondError(set, 400, "invalid_cursor");
      }
      if (search.length < 2) return { users: [], limit, nextCursor: null };
      const searchColumn = field === "username"
        ? db`u.username_normalized collate "C"`
        : db`lower(u.display_name) collate "C"`;
      const upperBound = prefixUpperBound(search);
      const searchPredicate = upperBound
        ? db`${searchColumn} >= ${search}::text collate "C" and ${searchColumn} < ${upperBound}::text collate "C"`
        : db`${searchColumn} >= ${search}::text collate "C"`;
      const statusPredicate = status === "banned"
        ? db`and s.user_id is not null`
        : status === "active" ? db`and s.user_id is null` : db``;
      const cursorPredicate = cursor
        ? db`and (${searchColumn}, u.id) > (${cursor.key}::text collate "C", ${cursor.id}::uuid)`
        : db``;
      const users = await db<{
        id: string;
        username: string;
        display_name: string;
        created_at: Date;
        cursor_key: string;
        banned: boolean;
        timed_out: boolean;
        active_warning_count: string;
      }[]>`
        select u.id, u.username, u.display_name, u.created_at,
          ${searchColumn} as cursor_key,
          (s.user_id is not null) as banned,
          exists (
            select 1 from instance_user_timeouts t
            where t.user_id = u.id and t.revoked_at is null and t.expires_at > now()
          ) as timed_out,
          (select count(*)::text from instance_user_warnings w
            where w.user_id = u.id and w.revoked_at is null
              and (w.expires_at is null or w.expires_at > now())) as active_warning_count
        from users u
        left join instance_user_suspensions s on s.user_id = u.id
        where ${searchPredicate}
          ${statusPredicate}
          ${cursorPredicate}
        order by ${searchColumn} asc, u.id asc
        limit ${limit + 1}
      `;
      const hasMore = users.length > limit;
      const page = users.slice(0, limit);
      return {
        users: page.map((row) => ({
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          createdAt: row.created_at,
          banned: row.banned,
          timedOut: row.timed_out,
          activeWarningCount: Number(row.active_warning_count) || 0,
        })),
        limit,
        nextCursor: hasMore && page.length
          ? encodePageCursor({ key: page[page.length - 1]!.cursor_key, id: page[page.length - 1]!.id, context: `${status}:${field}:${search}` })
          : null,
      };
    }, {
      query: t.Object({
        search: t.Optional(t.String({ maxLength: 100 })),
        field: t.Optional(t.Union([t.Literal("username"), t.Literal("displayName")])),
        status: t.Optional(t.Union([t.Literal("all"), t.Literal("active"), t.Literal("banned")])),
        limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })),
        cursor: t.Optional(t.String({ maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" })),
      }),
    })
    .get("/v1/instance-admin/spaces", async ({ headers, query, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const status = query.status ?? "all";
      const requestedLimit = Number(query.limit ?? 50);
      const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
      const cursor = decodePageCursor(query.cursor);
      if (query.cursor && (!cursor || !isCursorTimestamp(cursor.createdAt) || !isUuid(cursor.id)
        || cursor.context !== status)) return respondError(set, 400, "invalid_cursor");
      const statusPredicate = status === "active"
        ? db`and s.deactivated_at is null`
        : status === "deactivated" ? db`and s.deactivated_at is not null` : db``;
      const cursorPredicate = cursor
        ? db`and (s.created_at, s.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
        : db``;
      const rows = await db<{
        id: string;
        created_at: Date;
        cursor_created_at: string;
        deactivated_at: Date | null;
        active_member_count: string;
      }[]>`
        select s.id, s.created_at, s.deactivated_at,
          to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at,
          (select count(*)::text from server_members sm where sm.server_id = s.id and sm.left_at is null) as active_member_count
        from servers s
        where true ${statusPredicate}
          ${cursorPredicate}
        order by s.created_at desc, s.id desc
        limit ${limit + 1}
      `;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        spaces: page.map((row) => ({
          id: row.id,
          createdAt: row.created_at,
          deactivatedAt: row.deactivated_at,
          activeMemberCount: Number(row.active_member_count) || 0,
        })),
        limit,
        nextCursor: hasMore && page.length
          ? encodePageCursor({ createdAt: page[page.length - 1]!.cursor_created_at, id: page[page.length - 1]!.id, context: status })
          : null,
      };
    }, {
      query: t.Object({
        status: t.Optional(t.Union([t.Literal("all"), t.Literal("active"), t.Literal("deactivated")])),
        limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })),
        cursor: t.Optional(t.String({ maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" })),
      }),
    })
    .patch("/v1/instance-admin/spaces/:serverId/activation", async ({ body, headers, params, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const reason = body.reason.trim();
      if (!reason) return respondError(set, 400, "reason_required");
      const result = await db.begin(async (transaction) => {
        const [space] = await transaction<{ id: string; created_at: Date; deactivated_at: Date | null }[]>`
          select id, created_at, deactivated_at from servers where id = ${params.serverId} for update
        `;
        if (!space) return undefined;
        const currentlyActive = space.deactivated_at === null;
        if (currentlyActive === body.active) return { space, changed: false };
        const [updated] = await transaction<{ id: string; created_at: Date; deactivated_at: Date | null }[]>`
          update servers set deactivated_at = ${body.active ? null : transaction`now()`}, updated_at = now()
          where id = ${space.id}
          returning id, created_at, deactivated_at
        `;
        const action = body.active ? "space.activated" : "space.deactivated";
        await transaction`
          insert into instance_server_audit_logs (server_id, admin_user_id, admin_username, action, reason)
          values (${space.id}, ${operator.id}, ${operator.username}, ${action}, ${reason})
        `;
        return { space: updated!, changed: true };
      });
      if (!result) return respondError(set, 404, "space_not_found");
      const [count] = await db<{ active_member_count: string }[]>`
        select count(*)::text as active_member_count from server_members
        where server_id = ${result.space.id} and left_at is null
      `;
      return {
        space: {
          id: result.space.id,
          createdAt: result.space.created_at,
          deactivatedAt: result.space.deactivated_at,
          activeMemberCount: Number(count?.active_member_count) || 0,
        },
        changed: result.changed,
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({ active: t.Boolean(), reason: t.String({ minLength: 1, maxLength: 240 }) }),
    })
    .get("/v1/instance-admin/spaces/:serverId/audit", async ({ headers, params, query, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const [exists] = await db<{ id: string }[]>`select id from servers where id = ${params.serverId}`;
      if (!exists) return respondError(set, 404, "space_not_found");
      const requestedLimit = Number(query.limit ?? 50);
      const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
      const cursor = decodePageCursor(query.cursor);
      if (query.cursor && (!cursor || !isCursorTimestamp(cursor.createdAt)
        || typeof cursor.id !== "string" || !/^\d+$/.test(cursor.id)
        || (cursor.source !== "space" && cursor.source !== "host") || cursor.context !== params.serverId)) {
        return respondError(set, 400, "invalid_cursor");
      }
      const cursorPredicate = cursor
        ? db`and (entry.created_at, entry.id, entry.source) < (${cursor.createdAt}::timestamptz, ${cursor.id}::bigint, ${cursor.source}::text)`
        : db``;
      const rows = await db<{
        id: bigint | number | string;
        source: "space" | "host";
        action: string;
        actor: string;
        target_id: string | null;
        target_user_id: string | null;
        reason: string | null;
        created_at: Date;
        cursor_created_at: string;
      }[]>`
        with audit_entries as (
          select l.id, 'space'::text as source, l.action,
            actor.username as actor, l.target_id::text as target_id,
            l.target_user_id::text as target_user_id, null::text as reason, l.created_at
          from server_audit_logs l
          join users actor on actor.id = l.actor_id
          where l.server_id = ${params.serverId}
          union all
          select l.id, 'host'::text as source, l.action,
            l.admin_username as actor, null::text as target_id,
            null::text as target_user_id, l.reason, l.created_at
          from instance_server_audit_logs l
          where l.server_id = ${params.serverId}
        )
        select entry.id, entry.source, entry.action, entry.actor, entry.target_id, entry.target_user_id,
          entry.reason, entry.created_at,
          to_char(entry.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
        from audit_entries entry
        where true ${cursorPredicate}
        order by entry.created_at desc, entry.id desc, entry.source desc
        limit ${limit + 1}
      `;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        logs: page.map((row) => ({
          id: `${row.source}-${row.id}`,
          source: row.source,
          action: row.action,
          actor: row.actor,
          targetId: row.target_id,
          targetUserId: row.target_user_id,
          reason: row.reason,
          createdAt: row.created_at,
        })),
        limit,
        nextCursor: hasMore && page.length
          ? encodePageCursor({ createdAt: page[page.length - 1]!.cursor_created_at, id: String(page[page.length - 1]!.id), source: page[page.length - 1]!.source, context: params.serverId })
          : null,
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      query: t.Object({
        limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })),
        cursor: t.Optional(t.String({ maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" })),
      }),
    })
    .get("/v1/instance-admin/users/:userId", async ({ headers, params, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "moderation")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const [target] = await db<{
        id: string;
        username: string;
        display_name: string;
        created_at: Date;
        banned_at: Date | null;
        ban_reason: string | null;
      }[]>`
        select u.id, u.username, u.display_name, u.created_at,
          s.created_at as banned_at, s.reason as ban_reason
        from users u
        left join instance_user_suspensions s on s.user_id = u.id
        where u.id = ${params.userId}
      `;
      if (!target) return respondError(set, 404, "user_not_found");
      const [warnings, timeouts, actions] = await Promise.all([
        db<{
          id: string;
          reason: string;
          created_by_username: string;
          created_at: Date;
          expires_at: Date | null;
          acknowledged_at: Date | null;
          revoked_at: Date | null;
        }[]>`
          select id, reason, created_by_username, created_at, expires_at, acknowledged_at, revoked_at
          from instance_user_warnings where user_id = ${params.userId}
          order by created_at desc limit 100
        `,
        db<{
          id: string;
          reason: string;
          created_by_username: string;
          created_at: Date;
          expires_at: Date;
          revoked_at: Date | null;
          revoked_by_username: string | null;
          revocation_action: "removed" | "replaced" | "expired" | null;
        }[]>`
          select id, reason, created_by_username, created_at, expires_at,
            revoked_at, revoked_by_username, revocation_action
          from instance_user_timeouts where user_id = ${params.userId}
          order by created_at desc, id desc limit 100
        `,
        db<{ id: bigint | number | string; action: string; admin_username: string; details: Record<string, unknown>; created_at: Date }[]>`
          select id, action, admin_username, details, created_at
          from instance_admin_audit_logs
          where target_user_id = ${params.userId}
          order by created_at desc, id desc limit 100
        `,
      ]);
      return {
        user: {
          id: target.id,
          username: target.username,
          displayName: target.display_name,
          createdAt: target.created_at,
          ban: target.banned_at ? { createdAt: target.banned_at, reason: target.ban_reason } : null,
        },
        warnings: warnings.map((warning) => ({
          id: warning.id,
          reason: warning.reason,
          createdByUsername: warning.created_by_username,
          createdAt: warning.created_at,
          expiresAt: warning.expires_at,
          acknowledgedAt: warning.acknowledged_at,
          revokedAt: warning.revoked_at,
          active: !warning.revoked_at && (!warning.expires_at || warning.expires_at > new Date()),
        })),
        timeouts: timeouts.map((timeout) => ({
          id: timeout.id,
          reason: timeout.reason,
          createdByUsername: timeout.created_by_username,
          createdAt: timeout.created_at,
          expiresAt: timeout.expires_at,
          revokedAt: timeout.revoked_at,
          revokedByUsername: timeout.revoked_by_username,
          revocationAction: timeout.revocation_action,
          active: !timeout.revoked_at && timeout.expires_at > new Date(),
        })),
        actions: actions.map((action) => ({
          id: String(action.id),
          action: action.action,
          operatorUsername: action.admin_username,
          details: action.details ?? {},
          createdAt: action.created_at,
        })),
      };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/instance-admin/users/:userId/timeout", async ({ body, headers, params, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "moderation")) return respondError(set, 403, "forbidden");
      const reason = body.reason.trim();
      if (!reason) return respondError(set, 422, "timeout_reason_required");
      set.headers["cache-control"] = "no-store";
      const result = await db.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtextextended(${`instance-user-timeout:${params.userId}`}, 0))`;
        const [target] = await transaction<{ id: string }[]>`
          select id from users where id = ${params.userId} for update
        `;
        if (!target) return { kind: "not_found" as const };

        await transaction`
          update instance_user_timeouts
          set revoked_at = now(), revocation_action = 'expired'
          where user_id = ${params.userId} and revoked_at is null and expires_at <= now()
        `;
        const [previous] = await transaction<{ id: string }[]>`
          select id from instance_user_timeouts
          where user_id = ${params.userId} and revoked_at is null
          for update
        `;
        if (previous) {
          await transaction`
            update instance_user_timeouts
            set revoked_at = now(), revoked_by_admin_id = ${operator.id},
              revoked_by_username = ${operator.username}, revocation_action = 'replaced'
            where id = ${previous.id}
          `;
          await transaction`
            insert into instance_admin_audit_logs (
              admin_user_id, admin_username, admin_display_name, action, target_user_id, details
            ) values (
              ${operator.id}, ${operator.username}, ${operator.username}, 'user.timeout_replaced', ${params.userId},
              ${JSON.stringify({ timeoutId: previous.id })}::jsonb
            )
          `;
        }
        const [created] = await transaction<{ id: string; created_at: Date; expires_at: Date }[]>`
          insert into instance_user_timeouts (
            user_id, created_by_admin_id, created_by_username, reason, expires_at
          ) values (
            ${params.userId}, ${operator.id}, ${operator.username}, ${reason},
            now() + make_interval(secs => ${body.durationSeconds})
          )
          returning id, created_at, expires_at
        `;
        if (!created) throw new Error("Instance timeout insert did not return a row");
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, target_user_id, details
          ) values (
            ${operator.id}, ${operator.username}, ${operator.username}, 'user.timed_out', ${params.userId},
            ${JSON.stringify({ timeoutId: created.id, reason, expiresAt: created.expires_at })}::jsonb
          )
        `;
        return { kind: "created" as const, timeout: created, replaced: Boolean(previous) };
      });
      if (result.kind === "not_found") return respondError(set, 404, "user_not_found");
      set.status = 201;
      return { timeout: result.timeout, replaced: result.replaced };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
      body: t.Object({
        reason: t.String({ minLength: 1, maxLength: 240 }),
        durationSeconds: t.Integer({ minimum: 60, maximum: 2_592_000 }),
      }),
    })
    .delete("/v1/instance-admin/users/:userId/timeout", async ({ headers, params, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "moderation")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const removed = await db.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtextextended(${`instance-user-timeout:${params.userId}`}, 0))`;
        const [timeout] = await transaction<{ id: string }[]>`
          select id from instance_user_timeouts
          where user_id = ${params.userId} and revoked_at is null and expires_at > now()
          for update
        `;
        if (!timeout) return undefined;
        await transaction`
          update instance_user_timeouts
          set revoked_at = now(), revoked_by_admin_id = ${operator.id},
            revoked_by_username = ${operator.username}, revocation_action = 'removed'
          where id = ${timeout.id}
        `;
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, target_user_id, details
          ) values (
            ${operator.id}, ${operator.username}, ${operator.username}, 'user.timeout_removed', ${params.userId},
            ${JSON.stringify({ timeoutId: timeout.id })}::jsonb
          )
        `;
        return timeout;
      });
      if (!removed) return respondError(set, 404, "timeout_not_found");
      return { removed: true };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/instance-admin/users/:userId/warnings", async ({ body, headers, params, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "moderation")) return respondError(set, 403, "forbidden");
      const reason = body.reason.trim();
      if (!reason) return respondError(set, 422, "warning_reason_required");
      const expiresInSeconds = body.expiresInSeconds ?? null;
      const [warning] = await db.begin(async (transaction) => {
        const [created] = await transaction<{ id: string; created_at: Date; expires_at: Date | null }[]>`
          insert into instance_user_warnings (
            user_id, created_by, created_by_username, reason, expires_at
          )
          select ${params.userId}, ${operator.id}, ${operator.username}, ${reason},
            case when ${expiresInSeconds}::integer is null then null::timestamptz
              else now() + make_interval(secs => ${expiresInSeconds}::integer) end
          where exists (select 1 from users where id = ${params.userId})
          returning id, created_at, expires_at
        `;
        if (!created) return [undefined];
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, target_user_id, details
          ) values (
            ${operator.id}, ${operator.username}, ${operator.username}, 'user.warned', ${params.userId},
            ${JSON.stringify({ warningId: created.id, expiresAt: created.expires_at })}::jsonb
          )
        `;
        return [created];
      });
      if (!warning) return respondError(set, 404, "user_not_found");
      set.status = 201;
      return { warning: { id: warning.id, createdAt: warning.created_at, expiresAt: warning.expires_at } };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
      body: t.Object({
        reason: t.String({ minLength: 1, maxLength: 240 }),
        expiresInSeconds: t.Optional(t.Integer({ minimum: 300, maximum: 31_536_000 })),
      }),
    })
    .delete("/v1/instance-admin/warnings/:warningId", async ({ headers, params, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "moderation")) return respondError(set, 403, "forbidden");
      const revoked = await db.begin(async (transaction) => {
        const [warning] = await transaction<{ id: string; user_id: string }[]>`
          update instance_user_warnings set revoked_at = coalesce(revoked_at, now())
          where id = ${params.warningId} and revoked_at is null
          returning id, user_id
        `;
        if (!warning) return undefined;
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, target_user_id, details
          ) values (
            ${operator.id}, ${operator.username}, ${operator.username}, 'user.warning_revoked', ${warning.user_id},
            ${JSON.stringify({ warningId: warning.id })}::jsonb
          )
        `;
        return warning;
      });
      if (!revoked) return respondError(set, 404, "warning_not_found");
      return { revoked: true };
    }, {
      params: t.Object({ warningId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/instance-admin/users/:userId/suspend", async ({ body, headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      const [target] = await db<{ id: string }[]>`select id from users where id = ${params.userId}`;
      if (!target) return respondError(set, 404, "user_not_found");
      if (body.reportId) {
        const [report] = await db<{ id: string }[]>`
          select id from instance_reports where id = ${body.reportId} and target_user_id = ${params.userId}
        `;
        if (!report) return respondError(set, 400, "report_target_mismatch");
      }
      await db.begin(async (transaction) => {
        await transaction`
          insert into instance_user_suspensions (
            user_id, created_by, created_by_username, created_by_display_name, report_id, reason
          ) values (
            ${params.userId}, ${user.id}, ${user.username}, ${user.username}, ${body.reportId ?? null}, ${body.reason?.trim() || null}
          )
          on conflict (user_id) do update
            set created_by = excluded.created_by,
              created_by_username = excluded.created_by_username,
              created_by_display_name = excluded.created_by_display_name,
              report_id = excluded.report_id, reason = excluded.reason, created_at = now()
        `;
        await transaction`delete from sessions where user_id = ${params.userId}`;
        await transaction`delete from fcm_push_subscriptions where user_id = ${params.userId}`;
        if (body.reportId) {
          await transaction`
            update instance_reports set status = 'resolved', reviewed_by = ${user.id},
              reviewed_by_username = ${user.username}, reviewed_by_display_name = ${user.username}, reviewed_at = now()
            where id = ${body.reportId}
          `;
        }
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, report_id, target_user_id, details
          ) values (
            ${user.id}, ${user.username}, ${user.username}, 'user.suspended', ${body.reportId ?? null}, ${params.userId},
            ${JSON.stringify({ reason: body.reason?.trim() || null })}::jsonb
          )
        `;
      });
      closeSocketsForUser(params.userId);
      return { suspended: true };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
      body: t.Object({
        reportId: t.Optional(t.String({ format: "uuid" })),
        reason: t.Optional(t.String({ maxLength: 240 })),
      }),
    })
    .delete("/v1/instance-admin/users/:userId/suspension", async ({ headers, params, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      const restored = await db.begin(async (transaction) => {
        const [row] = await transaction<{ report_id: string | null }[]>`
          delete from instance_user_suspensions where user_id = ${params.userId}
          returning report_id
        `;
        if (!row) return undefined;
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action, report_id, target_user_id
          ) values (
            ${user.id}, ${user.username}, ${user.username}, 'user.restored', ${row.report_id}, ${params.userId}
          )
        `;
        return row;
      });
      if (!restored) return respondError(set, 404, "user_not_suspended");
      return { restored: true };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/instance-admin/report-keys", async ({ headers, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "evidenceKeys")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const keys = await db<{ id: string; active: boolean; created_at: Date }[]>`
        select id, active, created_at from instance_report_keys order by created_at desc
      `;
      return { keys: keys.map((key) => ({ id: key.id, active: key.active, createdAt: key.created_at })) };
    })
    .post("/v1/instance-admin/report-keys", async ({ body, headers, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "evidenceKeys")) return respondError(set, 403, "forbidden");
      let publicKey: Buffer;
      try {
        publicKey = decodeBase64(body.publicKey, "publicKey", 2048);
        const parsedKey = createPublicKey({ key: publicKey, format: "der", type: "spki" });
        if (parsedKey.asymmetricKeyType !== "rsa" || (parsedKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
          return respondError(set, 400, "invalid_report_public_key");
        }
      } catch (error) {
        if (error instanceof InvalidEncodingError || error instanceof Error) return respondError(set, 400, "invalid_report_public_key");
        throw error;
      }
      const key = await db.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtextextended('instance-report-key', 0))`;
        await transaction`update instance_report_keys set active = false where active`;
        const [created] = await transaction<{ id: string; created_at: Date }[]>`
          insert into instance_report_keys (
            id, public_key, created_by, created_by_username, created_by_display_name, active
          ) values (
            ${body.keyId}, ${publicKey}, ${user.id}, ${user.username}, ${user.username}, true
          )
          returning id, created_at
        `;
        await transaction`
          insert into instance_admin_audit_logs (
            admin_user_id, admin_username, admin_display_name, action
          ) values (${user.id}, ${user.username}, ${user.username}, 'report_key.created')
        `;
        return created;
      });
      if (!key) throw new Error("report encryption key insert did not return a row");
      set.status = 201;
      return { key: { id: key.id, createdAt: key.created_at } };
    }, {
      body: t.Object({
        keyId: t.String({ format: "uuid" }),
        publicKey: t.String({ minLength: 300, maxLength: 4_096 }),
      }),
    })
    .get("/v1/instance-admin/operators", async ({ headers, set }) => {
      const actor = await authenticateAdmin(headers.cookie);
      if (!actor) return respondError(set, 401, "unauthorized");
      if (!adminCan(actor.role, "operatorManagement")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const rows = await adminDb<{
        id: string;
        username: string;
        role: "admin" | "moderator";
        disabled_at: Date | null;
        created_at: Date;
      }[]>`
        select id, username, role, disabled_at, created_at
        from admin_users order by username collate "C" asc, id asc limit 201
      `;
      return { operators: rows.slice(0, 200).map((row) => ({
        id: row.id,
        username: row.username,
        role: row.role,
        disabled: row.disabled_at !== null,
        createdAt: row.created_at,
      })), truncated: rows.length > 200 };
    })
    .post("/v1/instance-admin/operators", async ({ body, headers, set }) => {
      const actor = await authenticateAdmin(headers.cookie);
      if (!actor) return respondError(set, 401, "unauthorized");
      if (!adminCan(actor.role, "operatorManagement")) return respondError(set, 403, "forbidden");
      const username = normalizeAdminUsername(body.username);
      if (!/^[a-z0-9_.-]{3,32}$/.test(username)) return respondError(set, 400, "invalid_operator_username");
      set.headers["cache-control"] = "no-store";
      const passwordHash = await password.hash(body.password);
      try {
        const created = await adminDb.begin(async (transaction) => {
          const [row] = await transaction<{ id: string; username: string; role: "admin" | "moderator"; created_at: Date }[]>`
            insert into admin_users (username, password_hash, role)
            values (${username}, ${passwordHash}, ${body.role})
            returning id, username, role, created_at
          `;
          if (!row) throw new Error("Operator creation returned no row");
          await transaction`
            insert into admin_user_audit_logs (
              actor_admin_user_id, actor_username, target_admin_user_id, target_username, action, details
            ) values (
              ${actor.id}, ${actor.username}, ${row.id}, ${row.username}, 'operator.created',
              ${JSON.stringify({ role: row.role })}::jsonb
            )
          `;
          return row;
        });
        set.status = 201;
        return { operator: { id: created.id, username: created.username, role: created.role, disabled: false, createdAt: created.created_at } };
      } catch (error) {
        if (isUniqueViolation(error)) return respondError(set, 409, "operator_username_taken");
        throw error;
      }
    }, {
      body: t.Object({
        username: t.String({ minLength: 3, maxLength: 32 }),
        password: t.String({ minLength: 12, maxLength: 1_024 }),
        role: t.Union([t.Literal("admin"), t.Literal("moderator")]),
      }),
    })
    .patch("/v1/instance-admin/operators/:operatorId", async ({ body, headers, params, set }) => {
      const actor = await authenticateAdmin(headers.cookie);
      if (!actor) return respondError(set, 401, "unauthorized");
      if (!adminCan(actor.role, "operatorManagement")) return respondError(set, 403, "forbidden");
      if (body.role === undefined && body.disabled === undefined) return respondError(set, 400, "operator_change_required");
      set.headers["cache-control"] = "no-store";
      const result = await adminDb.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtextextended('admin-operator-management', 0))`;
        const [current] = await transaction<{
          id: string;
          username: string;
          role: "admin" | "moderator";
          disabled_at: Date | null;
          created_at: Date;
        }[]>`
          select id, username, role, disabled_at, created_at
          from admin_users where id = ${params.operatorId} for update
        `;
        if (!current) return { kind: "not_found" as const };
        const nextRole = body.role ?? current.role;
        const wasDisabled = current.disabled_at !== null;
        const nextDisabled = body.disabled ?? wasDisabled;
        const roleChanged = nextRole !== current.role;
        const disabledChanged = nextDisabled !== wasDisabled;
        if (!roleChanged && !disabledChanged) return { kind: "unchanged" as const, operator: current };
        if (current.id === actor.id) return { kind: "self_change" as const };
        if (current.role === "admin" && !wasDisabled && (nextRole !== "admin" || nextDisabled)) {
          const [activeAdmins] = await transaction<{ count: string }[]>`
            select count(*)::text as count from admin_users where role = 'admin' and disabled_at is null
          `;
          if (Number(activeAdmins?.count ?? 0) <= 1) return { kind: "last_admin" as const };
        }
        const [updated] = await transaction<{
          id: string;
          username: string;
          role: "admin" | "moderator";
          disabled_at: Date | null;
          created_at: Date;
        }[]>`
          update admin_users set role = ${nextRole},
            disabled_at = case when ${nextDisabled} then coalesce(disabled_at, now()) else null end,
            updated_at = now()
          where id = ${current.id}
          returning id, username, role, disabled_at, created_at
        `;
        if (!updated) return { kind: "not_found" as const };
        if (roleChanged) {
          await transaction`
            insert into admin_user_audit_logs (
              actor_admin_user_id, actor_username, target_admin_user_id, target_username, action, details
            ) values (
              ${actor.id}, ${actor.username}, ${updated.id}, ${updated.username}, 'operator.role_changed',
              ${JSON.stringify({ from: current.role, to: updated.role })}::jsonb
            )
          `;
        }
        if (disabledChanged) {
          await transaction`
            insert into admin_user_audit_logs (
              actor_admin_user_id, actor_username, target_admin_user_id, target_username, action, details
            ) values (
              ${actor.id}, ${actor.username}, ${updated.id}, ${updated.username},
              ${nextDisabled ? "operator.disabled" : "operator.enabled"}, '{}'::jsonb
            )
          `;
        }
        if (roleChanged || nextDisabled) await transaction`delete from admin_sessions where admin_user_id = ${updated.id}`;
        return { kind: "changed" as const, operator: updated };
      });
      if (result.kind === "not_found") return respondError(set, 404, "operator_not_found");
      if (result.kind === "self_change") return respondError(set, 409, "cannot_change_own_operator");
      if (result.kind === "last_admin") return respondError(set, 409, "last_active_admin_required");
      return {
        changed: result.kind === "changed",
        operator: {
          id: result.operator.id,
          username: result.operator.username,
          role: result.operator.role,
          disabled: result.operator.disabled_at !== null,
          createdAt: result.operator.created_at,
        },
      };
    }, {
      params: t.Object({ operatorId: t.String({ format: "uuid" }) }),
      body: t.Object({
        role: t.Optional(t.Union([t.Literal("admin"), t.Literal("moderator")])),
        disabled: t.Optional(t.Boolean()),
      }),
    })
    .get("/v1/instance-admin/operators/audit", async ({ headers, query, set }) => {
      const actor = await authenticateAdmin(headers.cookie);
      if (!actor) return respondError(set, 401, "unauthorized");
      if (!adminCan(actor.role, "operatorManagement")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const requestedLimit = Number(query.limit ?? 50);
      const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
      const rows = await adminDb<{
        id: bigint | number | string;
        actor_username: string;
        target_username: string;
        action: string;
        details: Record<string, unknown>;
        created_at: Date;
      }[]>`
        select id, actor_username, target_username, action, details, created_at
        from admin_user_audit_logs order by created_at desc, id desc limit ${limit}
      `;
      return { logs: rows.map((row) => ({
        id: String(row.id),
        actorUsername: row.actor_username,
        targetUsername: row.target_username,
        action: row.action,
        details: row.details ?? {},
        createdAt: row.created_at,
      })) };
    }, {
      query: t.Object({ limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })) }),
    })
    .get("/v1/instance-admin/audit", async ({ headers, query, set }) => {
      const user = await authenticateAdmin(headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!adminCan(user.role, "moderation")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      const limit = Math.min(Number(query.limit ?? 100), 200);
      const rows = await db<{
        id: bigint | number | string;
        admin_user_id: string;
        admin_username: string;
        admin_display_name: string;
        action: string;
        details: Record<string, unknown>;
        report_id: string | null;
        target_user_id: string | null;
        created_at: Date;
      }[]>`
        select l.id, l.admin_user_id, l.admin_username, l.admin_display_name, l.action, l.details, l.report_id,
          l.target_user_id, l.created_at
        from instance_admin_audit_logs l
        where (${user.role} = 'admin' or l.action like 'report.%' or l.action like 'user.%')
        order by l.created_at desc, l.id desc limit ${Number.isInteger(limit) ? limit : 100}
      `;
      return { logs: rows.map((row) => ({
        id: String(row.id),
        adminUserId: row.admin_user_id,
        adminUsername: row.admin_username,
        adminDisplayName: row.admin_display_name,
        action: row.action,
        details: row.details ?? {},
        reportId: row.report_id,
        targetUserId: row.target_user_id,
        createdAt: row.created_at,
      })) };
    }, {
      query: t.Object({ limit: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })) }),
    })
    .get("/v1/instance-admin/operations", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return await getInstanceOperationsSnapshot();
    })
    .get("/v1/instance-admin/operations/live", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return getInstanceLiveResources();
    })
    .get("/v1/instance-admin/operations/overview", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return await getInstanceOperationsOverview();
    })
    .get("/v1/instance-admin/maintenance/summary", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return await getStorageMaintenanceSummary(operator);
    })
    .post("/v1/instance-admin/maintenance/preview", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return await inspectStorageMaintenance();
    })
    .post("/v1/instance-admin/maintenance/quarantine", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      try {
        return await quarantineOrphanedStorage(operator);
      } catch (error) {
        if (error instanceof StorageMaintenanceError) return respondError(set, error.status, error.code);
        throw error;
      }
    })
    .post("/v1/instance-admin/maintenance/restore", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      try {
        return await restoreQuarantinedStorage(operator);
      } catch (error) {
        if (error instanceof StorageMaintenanceError) return respondError(set, error.status, error.code);
        throw error;
      }
    })
    .post("/v1/instance-admin/maintenance/purge", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      try {
        return await purgeExpiredQuarantinedStorage(operator);
      } catch (error) {
        if (error instanceof StorageMaintenanceError) return respondError(set, error.status, error.code);
        throw error;
      }
    })
    .post("/v1/previews/twitter", async ({ body, headers, request, server, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      // Limited because this is the one endpoint where an authenticated caller makes the server
      // issue outbound requests, up to two per call. Without a budget it is a request amplifier
      // pointed at a third party, and at the configured provider's expense as much as ours.
      // Fails open: losing previews is preferable to refusing an authenticated user.
      const clientIp = clientIpFor({ request, headers, server });
      if (clientIp) {
        const refused = enforceRateLimits(set, [await bumpRateLimit({
          key: rateLimitKey("twitter-preview-ip", clientIp),
          limit: 30,
          windowSeconds: 60 * 60,
          failClosed: false,
        })]);
        if (refused) return refused;
      }

      const parsed = parseTwitterStatusUrl(body.url);
      if (!parsed) return respondError(set, 400, "unsupported_twitter_url");
      const preview = await fetchTwitterPreview(parsed.id);
      set.headers["cache-control"] = "no-store";
      return { preview };
    }, {
      body: t.Object({ url: t.String({ minLength: 1, maxLength: 2_048 }) }),
    })
    .get("/v1/gifs/providers", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      return {
        providers: config.gifProviders,
        maxAttachmentBytes: config.maxAttachmentBytes,
      };
    })
    .post("/v1/auth/register", async ({ body, headers, request, server, set }) => {
      const username = normalizeUsername(body.username);
      const displayName = body.displayName?.trim() || body.username;

      const clientIp = clientIpFor({ request, headers, server });

      // Screened before the budget is charged: this check is a cheap string comparison, while
      // the budget exists to bound password hashing and mass account creation. Rejecting a
      // mistyped or reused password should not consume the caller's hourly allowance.
      const rejection = screenPassword(body.password, { username: body.username, displayName });
      if (rejection) return respondError(set, 422, rejection);

      if (clientIp) {
        const refused = enforceRateLimits(set, [await bumpRateLimit({
          key: rateLimitKey("register-ip", clientIp),
          limit: 5,
          windowSeconds: 60 * 60,
          failClosed: true,
        })]);
        if (refused) return refused;
      }

      const passwordHash = await password.hash(body.password);

      try {
        const [user] = await db<UserRow[]>`
          insert into users (username, username_normalized, password_hash, display_name)
          values (${body.username}, ${username}, ${passwordHash}, ${displayName})
           returning id, username, display_name, password_hash, created_at,
             profile_image_storage_key, profile_banner_storage_key
        `;
        const session = await createSession(user.id);
        setSessionCookie(set, session.token, request);
        set.status = 201;
        return { user: toPublicUser(user), ...session };
      } catch (error) {
        if (isUniqueViolation(error)) return respondError(set, 409, "username_taken");
        throw error;
      }
    }, { body: registrationBody })
    .post("/v1/auth/login", async ({ body, headers, request, server, set }) => {
      const account = normalizeUsername(body.username);
      const clientIp = clientIpFor({ request, headers, server });

      // The per-IP budget is charged on every attempt because it bounds password-hash CPU work
      // even when the targeted account does not exist. The per-account budget is charged only on
      // failure so a legitimate user is never locked out by their own successful logins, and it
      // is charged for unknown accounts too so it cannot be used to test whether a user exists.
      const verdicts: RateLimitVerdict[] = [];
      if (clientIp) {
        verdicts.push(await bumpRateLimit({
          key: rateLimitKey("login-ip", clientIp),
          limit: 30,
          windowSeconds: authRateLimitIpWindowSeconds,
          failClosed: true,
        }));
      }
      verdicts.push(await peekRateLimit({
        key: rateLimitKey("login-failed", account),
        limit: 10,
        failClosed: true,
      }));

      const refused = enforceRateLimits(set, verdicts);
      if (refused) return refused;

      const [user] = await db<UserRow[]>`
         select id, username, display_name, password_hash, created_at,
           profile_image_storage_key, profile_banner_storage_key
        from users
        where username_normalized = ${account}
      `;
      const valid = await verifyPassword(user, body.password);
      if (!valid || !user) {
        await bumpRateLimit({
          key: rateLimitKey("login-failed", account),
          limit: 10,
          windowSeconds: authRateLimitWindowSeconds,
          failClosed: true,
        });
        return respondError(set, 401, "invalid_credentials");
      }
      const [suspension] = await db<{ user_id: string }[]>`
        select user_id from instance_user_suspensions where user_id = ${user.id}
      `;
      if (suspension) return respondError(set, 403, "account_suspended");

      const session = await createSession(user.id);
      setSessionCookie(set, session.token, request);
      return { user: toPublicUser(user), ...session };
    }, { body: loginBody })
    .post("/v1/auth/logout", async ({ headers, request, set }) => {
      const token = extractBearerToken(headers.authorization) ?? extractCookieToken(headers.cookie);
      await deleteSession(token);
      clearSessionCookie(set, request);
      return { loggedOut: true };
    })
    .get("/v1/me", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      return { user };
    })
    .get("/v1/me/instance-warnings", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      const warnings = await db<{ id: string; reason: string; created_at: Date; expires_at: Date | null }[]>`
        select id, reason, created_at, expires_at
        from instance_user_warnings
        where user_id = ${user.id} and acknowledged_at is null and revoked_at is null
          and (expires_at is null or expires_at > now())
        order by created_at desc limit 25
      `;
      return { warnings: warnings.map((warning) => ({
        id: warning.id,
        reason: warning.reason,
        createdAt: warning.created_at,
        expiresAt: warning.expires_at,
      })) };
    })
    .patch("/v1/me/instance-warnings/:warningId/acknowledge", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      const [warning] = await db<{ id: string }[]>`
        update instance_user_warnings set acknowledged_at = coalesce(acknowledged_at, now())
        where id = ${params.warningId} and user_id = ${user.id} and revoked_at is null
          and (expires_at is null or expires_at > now())
        returning id
      `;
      if (!warning) return respondError(set, 404, "warning_not_found");
      return { acknowledged: true };
    }, {
      params: t.Object({ warningId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/push/subscriptions", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!config.firebaseMessaging) return respondError(set, 503, "push_not_configured");
      await registerFcmPushToken(user.id, body.token);
      set.status = 201;
      return { registered: true };
    }, {
      body: t.Object({ token: t.String({ minLength: 20, maxLength: 4096 }) }),
    })
    .post("/v1/push/subscriptions/remove", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const removed = await removeFcmPushToken(user.id, body.token);
      return { removed };
    }, {
      body: t.Object({ token: t.String({ minLength: 20, maxLength: 4096 }) }),
    })
    .patch("/v1/me", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const displayName = body.displayName.trim();
      if (!displayName) return respondError(set, 400, "invalid_display_name");
      const [updated] = await db<UserRow[]>`
        update users
        set display_name = ${displayName}, updated_at = now()
        where id = ${user.id}
         returning id, username, display_name, password_hash, created_at,
           profile_image_storage_key, profile_banner_storage_key
      `;
      return { user: toPublicUser(updated) };
    }, {
      body: t.Object({ displayName: t.String({ minLength: 1, maxLength: 80 }) }),
    })
    .post("/v1/auth/password", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      // Bounds attempts against a session that is already authenticated but possibly hijacked,
      // and bounds the password hashing that each attempt costs.
      const refused = enforceRateLimits(set, [await bumpRateLimit({
        key: rateLimitKey("password-change", user.id),
        limit: 5,
        windowSeconds: authRateLimitWindowSeconds,
        failClosed: true,
      })]);
      if (refused) return refused;

      const [record] = await db<UserRow[]>`
         select id, username, display_name, password_hash, created_at,
           profile_image_storage_key, profile_banner_storage_key
        from users where id = ${user.id}
      `;
      if (!await verifyPassword(record, body.currentPassword)) return respondError(set, 400, "current_password_incorrect");

      const rejection = screenPassword(body.newPassword, { username: record?.username, displayName: record?.display_name });
      if (rejection) return respondError(set, 422, rejection);

      const passwordHash = await password.hash(body.newPassword);
      await db`
        update users set password_hash = ${passwordHash}, updated_at = now()
        where id = ${user.id}
      `;
      const token = extractBearerToken(headers.authorization) ?? extractCookieToken(headers.cookie);
      if (token) {
        const tokenHash = await hashSessionToken(token);
        await db`
          delete from sessions where user_id = ${user.id} and token_hash <> ${tokenHash}
        `;
      }
      return { updated: true };
    }, {
      body: t.Object({
        currentPassword: t.String({ minLength: 1, maxLength: 128 }),
        newPassword: t.String({ minLength: 12, maxLength: 128 }),
      }),
    })
    .get("/v1/users/:userId/avatar", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      // A block is honoured here as it is for conversation content. Profile media is not
      // end-to-end encrypted, so a blocked party must not be able to keep fetching it by id.
      if (params.userId !== user.id && await usersAreBlocked(user.id, params.userId)) {
        return respondError(set, 403, "blocked_user");
      }
      const [profile] = await db<{ profile_image_storage_key: string | null; profile_image_mime_type: string | null }[]>`
        select profile_image_storage_key, profile_image_mime_type
        from users
        where id = ${params.userId}
      `;
      if (!profile?.profile_image_storage_key || !profile.profile_image_mime_type) {
        return respondError(set, 404, "profile_image_not_found");
      }
      const path = profileImagePath(profile.profile_image_storage_key);
      if (!(await Bun.file(path).exists())) return respondError(set, 404, "profile_image_not_found");
      return new Response(Bun.file(path), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-type": profile.profile_image_mime_type,
          "x-content-type-options": "nosniff",
        },
      });
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/users/:userId/banner", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (params.userId !== user.id && await usersAreBlocked(user.id, params.userId)) {
        return respondError(set, 403, "blocked_user");
      }
      const [profile] = await db<{ profile_banner_storage_key: string | null; profile_banner_mime_type: string | null }[]>`
        select profile_banner_storage_key, profile_banner_mime_type
        from users
        where id = ${params.userId}
      `;
      if (!profile?.profile_banner_storage_key || !profile.profile_banner_mime_type) {
        return respondError(set, 404, "profile_banner_not_found");
      }
      const path = profileImagePath(profile.profile_banner_storage_key);
      if (!(await Bun.file(path).exists())) return respondError(set, 404, "profile_banner_not_found");
      return new Response(Bun.file(path), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-type": profile.profile_banner_mime_type,
          "x-content-type-options": "nosniff",
        },
      });
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .put("/v1/me/avatar", async ({ headers, request, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const metadata = profileImageMetadata(headers["content-type"]);
      if (!metadata) return respondError(set, 400, "unsupported_profile_image_type");

      const storageKey = `${crypto.randomUUID()}.${metadata.extension}`;
      let stored: { size: number };
      try {
        stored = await storeProfileImage(
          request,
          storageKey,
          config.maxProfileImageBytes,
          (bytes) => validProfileImageBytes(bytes, metadata.mimeType),
        );
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) return respondError(set, 413, "profile_image_too_large");
        if (error instanceof ProfileImageInvalidError) return respondError(set, 400, "invalid_profile_image");
        throw error;
      }

      let previousStorageKey: string | null = null;
      try {
        const updated = await db.begin(async (transaction) => {
          const [current] = await transaction<{ profile_image_storage_key: string | null }[]>`
            select profile_image_storage_key
            from users
            where id = ${user.id}
            for update
          `;
          if (!current) return null;
          const [next] = await transaction<UserRow[]>`
            update users
            set profile_image_storage_key = ${storageKey},
              profile_image_mime_type = ${metadata.mimeType},
              profile_image_size_bytes = ${stored.size}
            where id = ${user.id}
             returning id, username, display_name, created_at,
               profile_image_storage_key, profile_banner_storage_key
          `;
          previousStorageKey = current.profile_image_storage_key;
          return next;
        });
        if (!updated) {
          await removeProfileImage(storageKey);
          return respondError(set, 404, "user_not_found");
        }
        if (previousStorageKey && previousStorageKey !== storageKey) await removeProfileImage(previousStorageKey);
        return { user: toPublicUser(updated) };
      } catch (error) {
        await removeProfileImage(storageKey);
        throw error;
      }
    })
    .delete("/v1/me/avatar", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const deleted = await db.begin(async (transaction) => {
        const [current] = await transaction<{ profile_image_storage_key: string | null }[]>`
          select profile_image_storage_key
          from users
          where id = ${user.id}
          for update
        `;
        if (!current) return null;
        await transaction`
          update users
          set profile_image_storage_key = null,
            profile_image_mime_type = null,
            profile_image_size_bytes = null
          where id = ${user.id}
        `;
        return current.profile_image_storage_key;
      });
      if (deleted) await removeProfileImage(deleted);
      return { deleted: Boolean(deleted) };
    })
    .put("/v1/me/banner", async ({ headers, request, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const metadata = profileImageMetadata(headers["content-type"]);
      if (!metadata) return respondError(set, 400, "unsupported_profile_banner_type");

      const storageKey = `${crypto.randomUUID()}.${metadata.extension}`;
      let stored: { size: number };
      try {
        stored = await storeProfileImage(
          request,
          storageKey,
          config.maxProfileImageBytes,
          (bytes) => validProfileImageBytes(bytes, metadata.mimeType),
        );
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) return respondError(set, 413, "profile_banner_too_large");
        if (error instanceof ProfileImageInvalidError) return respondError(set, 400, "invalid_profile_banner");
        throw error;
      }

      let previousStorageKey: string | null = null;
      try {
        const updated = await db.begin(async (transaction) => {
          const [current] = await transaction<{ profile_banner_storage_key: string | null }[]>`
            select profile_banner_storage_key
            from users
            where id = ${user.id}
            for update
          `;
          if (!current) return null;
          const [next] = await transaction<UserRow[]>`
            update users
            set profile_banner_storage_key = ${storageKey},
              profile_banner_mime_type = ${metadata.mimeType},
              profile_banner_size_bytes = ${stored.size}
            where id = ${user.id}
            returning id, username, display_name, created_at,
              profile_image_storage_key, profile_banner_storage_key
          `;
          previousStorageKey = current.profile_banner_storage_key;
          return next;
        });
        if (!updated) {
          await removeProfileImage(storageKey);
          return respondError(set, 404, "user_not_found");
        }
        if (previousStorageKey && previousStorageKey !== storageKey) await removeProfileImage(previousStorageKey);
        return { user: toPublicUser(updated) };
      } catch (error) {
        await removeProfileImage(storageKey);
        throw error;
      }
    })
    .delete("/v1/me/banner", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const deleted = await db.begin(async (transaction) => {
        const [current] = await transaction<{ profile_banner_storage_key: string | null }[]>`
          select profile_banner_storage_key
          from users
          where id = ${user.id}
          for update
        `;
        if (!current) return null;
        await transaction`
          update users
          set profile_banner_storage_key = null,
            profile_banner_mime_type = null,
            profile_banner_size_bytes = null
          where id = ${user.id}
        `;
        return current.profile_banner_storage_key;
      });
      if (deleted) await removeProfileImage(deleted);
      return { deleted: Boolean(deleted) };
    })
    .get("/v1/users/blocked", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      set.headers["cache-control"] = "no-store";
      const blocked = await db<{
        id: string;
        username: string;
        display_name: string;
        profile_image_storage_key: string | null;
      }[]>`
        select u.id, u.username, u.display_name, u.profile_image_storage_key
        from user_blocks b join users u on u.id = b.blocked_user_id
        where b.blocker_user_id = ${user.id}
        order by u.username
      `;
      return { users: blocked.map((blockedUser) => ({
        id: blockedUser.id,
        username: blockedUser.username,
        displayName: blockedUser.display_name,
        avatarUrl: profileImageUrl(blockedUser.id, blockedUser.profile_image_storage_key),
      })) };
    })
    .post("/v1/users/:userId/block", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (params.userId === user.id) return respondError(set, 400, "cannot_block_self");
      const [target] = await db<{ id: string }[]>`select id from users where id = ${params.userId}`;
      if (!target) return respondError(set, 404, "user_not_found");
      await db`
        insert into user_blocks (blocker_user_id, blocked_user_id)
        values (${user.id}, ${params.userId}) on conflict do nothing
      `;
      return { blocked: true };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .delete("/v1/users/:userId/block", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [deleted] = await db<{ blocker_user_id: string }[]>`
        delete from user_blocks where blocker_user_id = ${user.id} and blocked_user_id = ${params.userId}
        returning blocker_user_id
      `;
      return { unblocked: Boolean(deleted) };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/users/:userId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [profile] = await db<UserRow[]>`
         select id, username, display_name, created_at,
           profile_image_storage_key, profile_banner_storage_key
        from users
        where id = ${params.userId}
      `;
      if (!profile) return respondError(set, 404, "user_not_found");
      const [block] = await db<{ blocked: boolean }[]>`
        select exists(select 1 from user_blocks where blocker_user_id = ${user.id} and blocked_user_id = ${params.userId}) as blocked
      `;
      return { user: toPublicUser(profile), blockedByMe: block?.blocked === true };
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/reports", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (body.targetUserId === user.id) return respondError(set, 400, "cannot_report_self");

      const [target] = await db<{ id: string }[]>`select id from users where id = ${body.targetUserId}`;
      if (!target) return respondError(set, 404, "user_not_found");
      const [recentCount] = await db<{ count: number }[]>`
        select count(*)::int as count from instance_reports
        where reporter_user_id = ${user.id} and created_at > now() - interval '1 hour'
      `;
      if (recentCount.count >= 10) return respondError(set, 429, "report_rate_limited");

      if (body.messageId) {
        if (!body.conversationId) return respondError(set, 400, "invalid_report_reference");
        const channelContext = await conversationChannelAuthorization(body.conversationId, user.id);
        if (channelContext) {
          const channelAccess = channelContext.access;
          if (!channelAccess) return respondError(set, 400, "invalid_report_reference");
          if (!channelAccess.canView && !await isMetadataChannel(channelContext.channel.server_id, channelContext.channel.id)) {
            return respondError(set, 400, "invalid_report_reference");
          }
        }
        const [reportedMessage] = await db<{ sender_user_id: string }[]>`
          select d.user_id as sender_user_id
          from messages m join devices d on d.id = m.sender_device_id
          where m.id = ${body.messageId} and m.conversation_id = ${body.conversationId}
            and exists (
              select 1 from conversation_members cm
              where cm.conversation_id = m.conversation_id and cm.user_id = ${user.id} and cm.left_at is null
            )
        `;
        if (!reportedMessage || reportedMessage.sender_user_id !== body.targetUserId) {
          return respondError(set, 400, "invalid_report_reference");
        }
      } else {
        if (body.conversationId) return respondError(set, 400, "invalid_report_reference");
        const [sharedServer] = await db<{ shared: boolean }[]>`
          select exists (
            select 1 from server_members mine
            join server_members target on target.server_id = mine.server_id and target.left_at is null
            join servers s on s.id = mine.server_id and s.deactivated_at is null
            where mine.user_id = ${user.id} and mine.left_at is null and target.user_id = ${body.targetUserId}
          ) as shared
        `;
        if (!sharedServer?.shared) return respondError(set, 403, "report_target_not_shared");
      }

      let evidenceCiphertext: Buffer | null = null;
      let evidenceWrappedKey: Buffer | null = null;
      let evidenceIv: Buffer | null = null;
      let evidenceKeyId: string | null = null;
      if (body.encryptedEvidence) {
        try {
          evidenceCiphertext = decodeBase64(body.encryptedEvidence.ciphertext, "ciphertext", 128 * 1024);
          evidenceWrappedKey = decodeBase64(body.encryptedEvidence.wrappedKey, "wrappedKey", 2048);
          evidenceIv = decodeBase64(body.encryptedEvidence.iv, "iv", 32);
        } catch (error) {
          if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_report_evidence");
          throw error;
        }
        if (evidenceIv.byteLength !== 12 || evidenceWrappedKey.byteLength < 384) {
          return respondError(set, 400, "invalid_report_evidence");
        }
        const [key] = await db<{ id: string }[]>`
          select id from instance_report_keys where id = ${body.encryptedEvidence.keyId}
        `;
        if (!key) return respondError(set, 400, "invalid_report_evidence_key");
        evidenceKeyId = key.id;
      }

      try {
        const [report] = await db<{ id: string }[]>`
          insert into instance_reports (
            reporter_user_id, target_user_id, conversation_id, message_id, reason,
            evidence_key_id, evidence_ciphertext, evidence_wrapped_key, evidence_iv
          ) values (
            ${user.id}, ${body.targetUserId}, ${body.conversationId ?? null}, ${body.messageId ?? null}, ${body.reason},
            ${evidenceKeyId}, ${evidenceCiphertext}, ${evidenceWrappedKey}, ${evidenceIv}
          ) returning id
        `;
        set.status = 201;
        return { report: { id: report.id, submitted: true } };
      } catch (error) {
        if (isUniqueViolation(error)) return respondError(set, 409, "report_already_submitted");
        throw error;
      }
    }, {
      body: t.Object({
        targetUserId: t.String({ format: "uuid" }),
        reason: t.Union([
          t.Literal("spam"), t.Literal("harassment"), t.Literal("threats"), t.Literal("sexual_content"),
          t.Literal("illegal_content"), t.Literal("impersonation"), t.Literal("other"),
        ]),
        conversationId: t.Optional(t.String({ format: "uuid" })),
        messageId: t.Optional(t.String({ format: "uuid" })),
        encryptedEvidence: t.Optional(t.Object({
          keyId: t.String({ format: "uuid" }),
          ciphertext: t.String({ minLength: 24, maxLength: 180_000 }),
          wrappedKey: t.String({ minLength: 300, maxLength: 4_096 }),
          iv: t.String({ minLength: 16, maxLength: 64 }),
        })),
      }),
    })
    .use(serverRoutes)
    .use(spaceMediaRoutes)
    .use(channelRoutes)
    .use(roleRoutes)
    .use(moderationRoutes)
    .use(deviceRoutes)
    .get("/v1/users/:userId/devices/keys", async ({ headers, set }) => {
      // Withdrawn. This route published the identity key and signed prekey of any account in
      // the instance and, worse, permanently consumed one unclaimed one-time prekey per device
      // on every call. Any authenticated client could therefore drain a victim's prekey pool
      // and stop inbound Olm sessions, and because the state change rode on a GET carrying a
      // `SameSite=Lax` cookie, link prefetch could trigger it with no attacker script at all.
      //
      // Key claiming moved to `POST /v1/crypto/keys/claim`, which is scoped to the requesting
      // account's own devices. The route is kept as an explicit 410 for one release so that a
      // custom client sees a clear signal instead of a silent 404; it is deleted in the next
      // release.
      await authenticate(headers.authorization, headers.cookie);
      set.headers["cache-control"] = "no-store";
      set.headers["deprecation"] = "true";
      set.headers["link"] = '</v1/crypto/keys/claim>; rel="successor-version"';
      return respondError(set, 410, "endpoint_removed");
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/voice/token", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const accessError = await directVoiceCallAccessError(body.conversationId, user.id);
      if (accessError) return respondError(set, 403, accessError);
      if (!config.liveKit) return respondError(set, 503, "voice_service_not_configured");
      try {
        if (await voiceTokenRateLimited(user.id)) return respondError(set, 429, "voice_token_rate_limited");
      } catch {
        return respondError(set, 503, "voice_token_service_unavailable");
      }

      const roomDigest = Buffer.from(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${body.conversationId}:${body.callId}`),
      )).toString("base64url");
      const roomName = `naigi-voice-${roomDigest}`;
      const roomService = liveKitRoomService();
      if (!roomService) return respondError(set, 503, "voice_service_not_configured");
      try {
        await roomService.createRoom({ name: roomName, emptyTimeout: 45, departureTimeout: 30, maxParticipants: 2 });
      } catch (error) {
        const existingRooms = await roomService.listRooms([roomName]).catch(() => []);
        if (!existingRooms.some((room) => room.name === roomName)) throw error;
      }

      const accessToken = new AccessToken(config.liveKit.apiKey, config.liveKit.apiSecret, {
        identity: crypto.randomUUID(),
        ttl: "10m",
      });
      accessToken.addGrant({
        roomJoin: true,
        room: roomName,
        canPublishSources: [TrackSource.MICROPHONE],
        canSubscribe: true,
        canPublishData: false,
      });
      set.headers["cache-control"] = "no-store";
      return { url: config.liveKit.webSocketUrl, token: await accessToken.toJwt() };
    }, {
      body: t.Object({
        conversationId: t.String({ format: "uuid" }),
        callId: t.String({ format: "uuid" }),
      }),
    })
    .post("/v1/voice/check", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const accessError = await directVoiceCallAccessError(body.conversationId, user.id);
      if (accessError) return respondError(set, 403, accessError);
      set.headers["cache-control"] = "no-store";
      return { authorized: true };
    }, {
      body: t.Object({
        conversationId: t.String({ format: "uuid" }),
        callId: t.String({ format: "uuid" }),
      }),
    })
    .post("/v1/voice/room-token", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const access = await voiceRoomAccessError(body.channelId, user.id);
      if ("error" in access) return respondError(set, 403, access.error ?? "voice_room_not_found");
      if (!config.liveKit) return respondError(set, 503, "voice_service_not_configured");
      try {
        if (await voiceTokenRateLimited(user.id)) return respondError(set, 429, "voice_token_rate_limited");
      } catch {
        return respondError(set, 503, "voice_token_service_unavailable");
      }

      const roomDigest = Buffer.from(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`naigi-voice-channel:${access.channel.id}`),
      )).toString("base64url");
      const roomName = `naigi-voice-room-${roomDigest}`;
      const roomService = liveKitRoomService();
      if (!roomService) return respondError(set, 503, "voice_service_not_configured");
      let failureStage = "list_room";
      try {
        let rooms = await roomService.listRooms([roomName]);
        if (!rooms.some((room) => room.name === roomName)) {
          failureStage = "create_room";
          try {
            // Do not impose an application-wide participant count. LiveKit and
            // the host's deployment resources determine how many can join.
            await roomService.createRoom({ name: roomName, emptyTimeout: 60, departureTimeout: 30 });
          } catch {
            failureStage = "confirm_room_creation";
            rooms = await roomService.listRooms([roomName]);
            if (!rooms.some((room) => room.name === roomName)) throw new Error("voice_room_creation_failed");
          }
          failureStage = "verify_room";
          rooms = await roomService.listRooms([roomName]);
        }
        failureStage = "claim_device";
        const identity = voiceRoomIdentity(access.channel.id, user.id, config.liveKit.apiSecret);
        await claimVoiceRoomDevice(identity, body.instanceId ?? crypto.randomUUID(), body.replaceExisting === true,
          await roomService.listParticipants(roomName),
          async (participantIdentity, instanceId, replaceExisting) => Number(await evalRedisScript(
            "local owner = redis.call('GET', KEYS[1]); if owner and owner ~= ARGV[1] and ARGV[2] ~= '1' then return 0; end; redis.call('SET', KEYS[1], ARGV[1], 'EX', 60); return 1",
            1, `naigi:voice-room-device:${participantIdentity}`, instanceId, replaceExisting ? "1" : "0",
          )) === 1);
        const activeParticipants = rooms.find((room) => room.name === roomName)?.numParticipants ?? 0;
        const bootstrapKey = `naigi:voice-room-bootstrap:${access.channel.id}`;
        let canStart = false;
        failureStage = "bootstrap_lock";
        if (activeParticipants > 0) {
          await evalRedisScript("return redis.call('DEL', KEYS[1])", 1, bootstrapKey);
        } else {
          const acquired = await evalRedisScript(
            "if redis.call('EXISTS', KEYS[1]) == 0 then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); return 1; end; return 0",
            1,
            bootstrapKey,
            crypto.randomUUID(),
            30,
          );
          canStart = Number(acquired) === 1;
        }

        failureStage = "sign_token";
        const accessToken = new AccessToken(config.liveKit.apiKey, config.liveKit.apiSecret, {
          identity,
          ttl: "10m",
        });
        accessToken.addGrant({
          roomJoin: true,
          room: roomName,
          canPublishSources: [TrackSource.MICROPHONE],
          canSubscribe: true,
          canPublishData: false,
        });
        set.headers["cache-control"] = "no-store";
        return { url: config.liveKit.webSocketUrl, token: await accessToken.toJwt(), canStart };
      } catch (error) {
        if (error instanceof VoiceRoomDeviceConflict) return respondError(set, 409, "voice_room_active_on_another_device");
        const errorType = error instanceof Error ? error.name : typeof error;
        console.error(`[voice-room] room token failed at ${failureStage} (${errorType})`);
        return respondError(set, 503, "voice_room_service_unavailable");
      }
    }, {
      body: t.Object({
        channelId: t.String({ format: "uuid" }),
        instanceId: t.Optional(t.String({ format: "uuid" })),
        replaceExisting: t.Optional(t.Boolean()),
      }),
    })
    .post("/v1/voice/room-release", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!config.liveKit) return respondError(set, 503, "voice_service_not_configured");
      const identity = voiceRoomIdentity(body.channelId, user.id, config.liveKit.apiSecret);
      try {
        const released = await evalRedisScript(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]); end; return 0",
          1, `naigi:voice-room-device:${identity}`, body.instanceId,
        );
        set.headers["cache-control"] = "no-store";
        return { released: Number(released) === 1 };
      } catch {
        return respondError(set, 503, "voice_token_service_unavailable");
      }
    }, {
      body: t.Object({ channelId: t.String({ format: "uuid" }), instanceId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/voice/room-check", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const access = await voiceRoomAccessError(body.channelId, user.id);
      if ("error" in access) return respondError(set, 403, access.error ?? "voice_room_not_found");
      set.headers["cache-control"] = "no-store";
      return { authorized: true };
    }, {
      body: t.Object({ channelId: t.String({ format: "uuid" }) }),
    })
    .use(cryptoRoutes)
    .use(conversationRoutes)
    .use(attachmentRoutes)
    .use(messageRoutes)
    .use(realtimeSocketRoute)
}
