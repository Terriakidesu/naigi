// Notifications only: never put room keys, exports, passphrases, or message text here.
const eventName = "naigi:history-keys-changed";
const keyFor = (userId: string) => `naigi.history-keys.${userId}`;
type Notice = { userId: string; sourceId: string; changeId: string };

export function notifyHistoryKeysChanged(userId: string, sourceId: string) {
  const notice: Notice = { userId, sourceId, changeId: crypto.randomUUID() };
  try { localStorage.setItem(keyFor(userId), JSON.stringify(notice)); } catch { /* Same-page notifications still work. */ }
  window.dispatchEvent(new CustomEvent(eventName, { detail: notice }));
}

export function subscribeHistoryKeysChanged(userId: string, sourceId: string, onChange: () => void) {
  let lastChange = "";
  const receive = (notice: Partial<Notice> | null) => {
    if (!notice || notice.userId !== userId || typeof notice.sourceId !== "string" || notice.sourceId === sourceId
      || typeof notice.changeId !== "string" || notice.changeId === lastChange) return;
    lastChange = notice.changeId;
    onChange();
  };
  const storage = (event: StorageEvent) => {
    if (event.key !== keyFor(userId) || !event.newValue) return;
    try { receive(JSON.parse(event.newValue)); } catch { /* Ignore malformed local notifications. */ }
  };
  const local = (event: Event) => receive((event as CustomEvent<Notice>).detail);
  window.addEventListener("storage", storage);
  window.addEventListener(eventName, local);
  return () => { window.removeEventListener("storage", storage); window.removeEventListener(eventName, local); };
}
