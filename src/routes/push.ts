/**
 * Push notification configuration.
 *
 * Unauthenticated by design: the service worker has to read this before a user has a session, and
 * the values are browser-public. The Firebase web config and the VAPID key are meant to reach the
 * browser; the service-account private key and the admin API key are not part of this payload.
 */

import { Elysia } from "elysia";
import { publicFirebaseMessagingConfiguration } from "../push/fcm";

export const pushRoutes = new Elysia()
  .get("/v1/push/config", ({ set }) => {
    set.headers["cache-control"] = "no-store";
    return publicFirebaseMessagingConfiguration();
  });
