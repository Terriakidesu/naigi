import { getApps, initializeApp } from "firebase/app";
import { deleteToken, getMessaging, getToken, isSupported } from "firebase/messaging";
import type { ApiClient } from "./api";
import type { AppPreferences } from "./app-preferences";

type PushPreferences = Pick<AppPreferences, "notificationMode" | "sounds" | "quietHoursEnabled" | "quietHoursStart" | "quietHoursEnd">;

function tokenStorageKey(userId: string) {
  return `priv-chat.fcm-token.${userId}`;
}

function readStoredToken(userId: string) {
  try {
    return localStorage.getItem(tokenStorageKey(userId));
  } catch {
    return null;
  }
}

function writeStoredToken(userId: string, token: string | null) {
  try {
    if (token) localStorage.setItem(tokenStorageKey(userId), token);
    else localStorage.removeItem(tokenStorageKey(userId));
  } catch {
    // Firebase keeps its own registration record; this copy only helps remove a stale server token.
  }
}

async function updateWorkerPreferences(preferences: PushPreferences, registration?: ServiceWorkerRegistration) {
  if (!("serviceWorker" in navigator)) return;
  const activeRegistration = registration ?? await navigator.serviceWorker.getRegistration("/").catch(() => undefined);
  const worker = activeRegistration?.active;
  worker?.postMessage({
    type: "naigi:push-preferences",
    preferences: {
      notificationMode: preferences.notificationMode,
      sounds: preferences.sounds,
      quietHoursEnabled: preferences.quietHoursEnabled,
      quietHoursStart: preferences.quietHoursStart,
      quietHoursEnd: preferences.quietHoursEnd,
    },
  });
}

export async function synchronizeFcmPush(api: ApiClient, userId: string, preferences: PushPreferences) {
  await updateWorkerPreferences(preferences).catch(() => undefined);
  if (preferences.notificationMode !== "all") {
    await disableFcmPush(api, userId);
    return false;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || !navigator.serviceWorker || !window.isSecureContext) {
    await disableFcmPush(api, userId);
    return false;
  }

  try {
    const configuration = await api.firebaseMessagingConfig();
    if (!configuration.configured || !configuration.firebaseConfig || !configuration.vapidKey || !await isSupported()) return false;

    const app = getApps().find((candidate) => candidate.name === "naigi-fcm")
      ?? initializeApp(configuration.firebaseConfig, "naigi-fcm");
    const messaging = getMessaging(app);
    const registration = await navigator.serviceWorker.register("/push-sw.js", { scope: "/" });
    const readyRegistration = await navigator.serviceWorker.ready;
    await updateWorkerPreferences(preferences, readyRegistration);

    const token = await getToken(messaging, {
      vapidKey: configuration.vapidKey,
      serviceWorkerRegistration: readyRegistration ?? registration,
    });
    if (!token) return false;

    const previousToken = readStoredToken(userId);
    if (previousToken && previousToken !== token) await api.removePushToken(previousToken).catch(() => undefined);
    await api.registerPushToken(token);
    writeStoredToken(userId, token);
    return true;
  } catch {
    // Push setup is optional; native in-page notifications continue to work without FCM.
    return false;
  }
}

export async function disableFcmPush(api: ApiClient, userId: string) {
  await updateWorkerPreferences({
    notificationMode: "off",
    sounds: false,
    quietHoursEnabled: false,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
  }).catch(() => undefined);

  const storedToken = readStoredToken(userId);
  let serverRegistrationRemoved = true;
  if (storedToken) {
    try {
      await api.removePushToken(storedToken);
      writeStoredToken(userId, null);
    } catch {
      // Keep the token locally so a later disable/logout can retry removal.
      serverRegistrationRemoved = false;
    }
  }

  if (!storedToken || typeof Notification === "undefined" || Notification.permission !== "granted" || !navigator.serviceWorker || !window.isSecureContext) {
    return serverRegistrationRemoved;
  }
  try {
    const configuration = await api.firebaseMessagingConfig();
    if (!configuration.configured || !configuration.firebaseConfig || !await isSupported()) return;
    const app = getApps().find((candidate) => candidate.name === "naigi-fcm")
      ?? initializeApp(configuration.firebaseConfig, "naigi-fcm");
    const messaging = getMessaging(app);
    await deleteToken(messaging);
  } catch {
    // Server registration removal above is the important privacy action; SDK cleanup is best effort.
  }
  return serverRegistrationRemoved;
}
