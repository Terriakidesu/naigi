/**
 * Report public key and push configuration.
 *
 * Both are deliberately readable by any authenticated account: the report key has to be reachable
 * before a user can encrypt evidence, and the Firebase web config plus VAPID key are browser-public
 * values that never include the service-account private key.
 */

import { Elysia } from "elysia";
import { authenticate } from "../auth/session";
import { db } from "../db/client";
import { encodeBase64 } from "../encoding";
import { respondError } from "../http/responses";

export const userRoutes = new Elysia()
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
    });
