const preferencesDatabase = "priv-chat-fcm-preferences";
const preferencesStore = "preferences";
const preferencesKey = "current";

function openPreferencesDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(preferencesDatabase, 1);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(preferencesStore);
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

async function readPreferences() {
  const database = await openPreferencesDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(preferencesStore, "readonly");
      const request = transaction.objectStore(preferencesStore).get(preferencesKey);
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
  } finally {
    database.close();
  }
}

async function writePreferences(preferences) {
  const database = await openPreferencesDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(preferencesStore, "readwrite");
      transaction.objectStore(preferencesStore).put(preferences, preferencesKey);
      transaction.addEventListener("complete", resolve, { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    });
  } finally {
    database.close();
  }
}

function isQuietHours(preferences, now = new Date()) {
  if (!preferences.quietHoursEnabled || preferences.quietHoursStart === preferences.quietHoursEnd) return false;
  const [startHour, startMinute] = String(preferences.quietHoursStart ?? "22:00").split(":").map(Number);
  const [endHour, endMinute] = String(preferences.quietHoursEnd ?? "08:00").split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "naigi:push-preferences" || !event.data.preferences) return;
  event.waitUntil(writePreferences(event.data.preferences).catch(() => undefined));
});

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (payload?.data?.type !== "new_encrypted_message") return;

  event.waitUntil((async () => {
    let preferences;
    try {
      preferences = await readPreferences();
    } catch {
      return;
    }
    // Fail closed: no persisted local preference means no background notification.
    if (!preferences || preferences.notificationMode !== "all" || isQuietHours(preferences)) return;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(preferences.quietHoursStart)
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(preferences.quietHoursEnd)) return;

    const openClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const chatIsOpen = openClients.some((client) => {
      try {
        const path = new URL(client.url).pathname;
        return path === "/app" || path.startsWith("/channels/");
      } catch {
        return false;
      }
    });
    if (chatIsOpen) return;

    await self.registration.showNotification("New encrypted message", {
      body: "A new encrypted message is waiting in Naigi.",
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      tag: "naigi-background-message",
      renotify: false,
      silent: !preferences.sounds,
      data: { url: "/app" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL("/app", self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client && new URL(client.url).origin === self.location.origin) {
        await client.focus();
        const path = new URL(client.url).pathname;
        if ("navigate" in client && path !== "/app" && !path.startsWith("/channels/")) await client.navigate(url);
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
