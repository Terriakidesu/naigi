/**
 * Optional third-party integrations.
 *
 * The Twitter/X preview is the one place the server fetches a URL on a caller's behalf. The host is
 * an operator-configured provider and the caller contributes only a validated numeric post id, so
 * this is not a general-purpose fetch. GIF search keys are browser-public and go straight to the
 * provider from the browser, never through here.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { config } from "../config";
import { bumpRateLimit, rateLimitKey } from "../rate-limit";
import { clientIpFor, enforceRateLimits } from "../http/limits";
import { respondError } from "../http/responses";
import { fetchTwitterPreview, parseTwitterStatusUrl } from "../twitter-preview";

export const integrationRoutes = new Elysia()
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
    });
