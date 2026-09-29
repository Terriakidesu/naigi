import { createSign } from "node:crypto";
import { config } from "../config";
import { db } from "../db/client";

type OAuthResponse = { access_token?: unknown; expires_in?: unknown };

let cachedAccessToken: { value: string; expiresAt: number } | undefined;

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

async function firebaseAccessToken() {
  const firebase = config.firebaseMessaging;
  if (!firebase) throw new Error("fcm_not_configured");
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) return cachedAccessToken.value;

  const now = Math.floor(Date.now() / 1000);
  const claims = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: firebase.clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsignedToken = `${claims}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsignedToken).end().sign(firebase.privateKey, "base64url");
  const assertion = `${unsignedToken}.${signature}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`fcm_oauth_failed_${response.status}`);
  const result = await response.json() as OAuthResponse;
  if (typeof result.access_token !== "string" || typeof result.expires_in !== "number") {
    throw new Error("fcm_oauth_invalid_response");
  }
  cachedAccessToken = { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
  return result.access_token;
}

export function publicFirebaseMessagingConfiguration() {
  const firebase = config.firebaseMessaging;
  if (!firebase) return { configured: false as const };
  return {
    configured: true as const,
    firebaseConfig: firebase.webConfig,
    vapidKey: firebase.vapidKey,
  };
}

export async function registerFcmPushToken(userId: string, token: string) {
  await db`
    insert into fcm_push_subscriptions (user_id, token)
    values (${userId}, ${token})
    on conflict (token) do update
      set user_id = excluded.user_id, updated_at = now()
  `;
}

export async function removeFcmPushToken(userId: string, token: string) {
  const result = await db`
    delete from fcm_push_subscriptions
    where user_id = ${userId} and token = ${token}
  `;
  return result.count > 0;
}

async function sendToToken(token: string, accessToken: string) {
  const firebase = config.firebaseMessaging;
  if (!firebase) return;
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(firebase.projectId)}/messages:send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token,
        // Deliberately data-only: never send message content, room IDs, names, or mention data to FCM.
        data: { type: "new_encrypted_message" },
        webpush: { headers: { TTL: "300" } },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) return;

  let errorCode = "";
  try {
    const result = await response.json() as { error?: { status?: unknown; details?: Array<{ errorCode?: unknown }> } };
    errorCode = [result.error?.status, ...(result.error?.details ?? []).map((detail) => detail.errorCode)]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
  } catch {
    // Invalid-token cleanup is best effort; never log a registration token or FCM response body.
  }
  if (errorCode.includes("UNREGISTERED")) {
    await db`delete from fcm_push_subscriptions where token = ${token}`;
  }
}

export async function sendGenericFcmPush(userIds: readonly string[]) {
  if (!config.firebaseMessaging || userIds.length === 0) return;
  try {
    const recipients = [...new Set(userIds)];
    const subscriptions = await db<{ token: string }[]>`
      select token from fcm_push_subscriptions where user_id in ${db(recipients)}
    `;
    if (subscriptions.length === 0) return;
    const accessToken = await firebaseAccessToken();
    for (let offset = 0; offset < subscriptions.length; offset += 20) {
      await Promise.allSettled(subscriptions.slice(offset, offset + 20).map(({ token }) => sendToToken(token, accessToken)));
    }
  } catch {
    // Push delivery is best effort and must never block message persistence or realtime delivery.
  }
}
