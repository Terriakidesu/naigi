import { forgetRememberedPassphrase } from "./unlock-vault";

const databaseNames = ["naigi-message-cache", "priv-chat-message-outbox", "priv-chat-unlock-vault", "priv-chat-fcm-preferences", "naigi-history-recovery"];

function deleteDatabase(name: string) {
  if (!globalThis.indexedDB) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(true), { once: true });
    request.addEventListener("error", () => resolve(false), { once: true });
    request.addEventListener("blocked", () => resolve(false), { once: true });
  });
}

function removeUserLocalStorage(userId: string) {
  try {
    const keys = [
      `priv-chat.device.${userId}`,
      `priv-chat.app-preferences.${userId}`,
      `priv-chat.voice-audio.${userId}`,
      `priv-chat.notifications.${userId}`,
      `priv-chat.muted-rooms.${userId}`,
      `priv-chat.unread.${userId}`,
    ];
    for (const key of keys) localStorage.removeItem(key);
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(`priv-chat.join-announcement.${userId}.`)) localStorage.removeItem(key);
    }
  } catch {
    // Local cleanup is best effort; unavailable storage must not block logout.
  }
}

export async function clearLocalData(userId: string) {
  await forgetRememberedPassphrase(userId).catch(() => undefined);
  const databaseResults = await Promise.all([
    ...databaseNames.map((name) => deleteDatabase(name)),
    deleteDatabase(`priv-chat-crypto-${userId}`),
  ]);
  removeUserLocalStorage(userId);
  try {
    sessionStorage.removeItem("priv-chat.local-passphrase");
    sessionStorage.removeItem("priv-chat.manual-lock");
    sessionStorage.removeItem(`naigi.voice-room-resume.${userId}`);
  } catch {
    // Session storage is optional.
  }
  return { cleared: databaseResults.every(Boolean), databases: databaseResults };
}
