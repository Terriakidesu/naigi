/**
 * Application assembly.
 *
 * This module owns the HTTP surface and nothing else: the global middleware, and the order in
 * which the domain route modules are registered. The logic behind each group of endpoints lives in
 * the module that owns it:
 *
 * - `routes/`       static client assets, health probes
 * - `admin/routes/` host-operator console, one module per capability
 * - `auth/`         account creation, sign-in, password change
 * - `users/`        own account, profile media, blocks, reports
 * - `servers/`      spaces, channels, categories, roles, invites, moderation
 * - `conversations/`, `attachments/` conversations, message history, encrypted uploads
 * - `devices/`, `crypto/` device registration and the Matrix key relay
 * - `voice/`        LiveKit token issuance and signalling
 * - `realtime/`     the WebSocket route; `realtime-registry.ts` tracks live sockets
 *
 * Registration order is preserved from when these routes lived here, so path matching is unchanged.
 */

import { Elysia } from "elysia";
import { respondError } from "./http/responses";
import {
  baselineSecurityHeaders,
  contentSecurityPolicy,
  crossOriginVerdict,
  strictTransportSecurity,
} from "./request-security";
import { historyRecoveryRoutes } from "./history-recovery";

// Route modules, registered in the order their paths previously appeared.
import { staticRoutes } from "./routes/static";
import { healthRoutes } from "./routes/health";
import { pushRoutes } from "./routes/push";
import { integrationRoutes } from "./routes/integrations";
import { userRoutes } from "./users/routes";
import { adminAuthRoutes } from "./admin/routes/auth";
import { adminReportRoutes } from "./admin/routes/reports";
import { adminUserDirectoryRoutes } from "./admin/routes/user-directory";
import { adminSpaceRoutes } from "./admin/routes/spaces";
import { adminUserRoutes } from "./admin/routes/users";
import { adminReportKeyRoutes } from "./admin/routes/report-keys";
import { adminOperatorRoutes } from "./admin/routes/operators";
import { adminDirectoryRoutes } from "./admin/routes/directory";
import { adminOperationsRoutes } from "./admin/routes/operations";
import { adminMaintenanceRoutes } from "./admin/routes/maintenance";
import { authRoutes } from "./auth/routes";
import { accountRoutes } from "./users/account";
import { profileMediaRoutes } from "./users/profile-media";
import { blockRoutes } from "./users/blocks";
import { userDirectoryRoutes } from "./users/directory";
import { reportRoutes } from "./users/reports";
import { serverRoutes } from "./servers/routes";
import { spaceMediaRoutes } from "./servers/media";
import { channelRoutes } from "./servers/channel-routes";
import { roleRoutes } from "./servers/role-routes";
import { moderationRoutes } from "./servers/moderation";
import { deviceRoutes } from "./devices/routes";
import { withdrawnDeviceKeysRoute } from "./devices/withdrawn";
import { voiceRoutes } from "./voice/routes";
import { cryptoRoutes } from "./crypto/routes";
import { conversationRoutes } from "./conversations/routes";
import { attachmentRoutes } from "./attachments/routes";
import { messageRoutes } from "./conversations/messages";
import { realtimeSocketRoute } from "./realtime/route";

/**
 * Assembles the HTTP application.
 *
 * Middleware is registered before the routes so the origin guard runs ahead of every handler, and
 * the error mapper sits above them all so a thrown error anywhere still returns the same opaque
 * body rather than leaking a message or stack to the client.
 */
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
      // Logged with the path only: no query string, body, cookie, or token, so an error never
      // writes user content to disk.
      console.error(`[request-error] ${request.method} ${new URL(request.url).pathname} (${code})\n${detail}`);
      return respondError(set, 500, "internal_error");
    })
    .use(staticRoutes)
    .use(healthRoutes)
    .use(pushRoutes)
    .use(userRoutes)
    .use(adminAuthRoutes)
    .use(adminReportRoutes)
    .use(adminUserDirectoryRoutes)
    .use(adminSpaceRoutes)
    .use(adminUserRoutes)
    .use(adminReportKeyRoutes)
    .use(adminOperatorRoutes)
    .use(adminDirectoryRoutes)
    .use(adminOperationsRoutes)
    .use(adminMaintenanceRoutes)
    .use(integrationRoutes)
    .use(authRoutes)
    .use(accountRoutes)
    .use(profileMediaRoutes)
    .use(blockRoutes)
    .use(userDirectoryRoutes)
    .use(reportRoutes)
    .use(serverRoutes)
    .use(spaceMediaRoutes)
    .use(channelRoutes)
    .use(roleRoutes)
    .use(moderationRoutes)
    .use(deviceRoutes)
    .use(withdrawnDeviceKeysRoute)
    .use(voiceRoutes)
    .use(cryptoRoutes)
    .use(conversationRoutes)
    .use(attachmentRoutes)
    .use(messageRoutes)
    .use(realtimeSocketRoute);
}
