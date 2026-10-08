/**
 * Withdrawn endpoint, kept for one release.
 *
 * `GET /v1/users/:userId/devices/keys` published the identity key and signed prekey of any account
 * in the instance and, worse, permanently consumed one unclaimed one-time prekey per device on every
 * call. Any authenticated client could therefore drain a victim's prekey pool and stop inbound Olm
 * sessions, and because the state change rode on a GET carrying a `SameSite=Lax` cookie, link
 * prefetch could trigger it with no attacker script at all.
 *
 * Key claiming moved to `POST /v1/crypto/keys/claim`, which is scoped to the requesting account's
 * own devices. The route answers an explicit 410 with a deprecation signal and a successor link so
 * a custom client sees a clear message instead of a silent 404. It is deleted in the next release.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { respondError } from "../http/responses";

export const withdrawnDeviceKeysRoute = new Elysia()
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
    });
