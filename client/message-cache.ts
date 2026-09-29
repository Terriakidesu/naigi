import type { MessageEnvelope } from "./api";

const databaseName = "naigi-message-cache";
const storeName = "conversations";

type CacheRecord = {
  key: string;
  messages: MessageEnvelope[];
  updatedAt: number;
};

function cacheKey(userId: string, conversationId: string) {
  return `${userId}:${conversationId}`;
}

function openCache() {
  if (!globalThis.indexedDB) return Promise.resolve<IDBDatabase | undefined>(undefined);
  return new Promise<IDBDatabase | undefined>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(storeName, { keyPath: "key" });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("message_cache_unavailable")));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("message_cache_failed")));
  });
}

export async function readCachedMessages(userId: string, conversationId: string) {
  try {
    const database = await openCache();
    if (!database) return [];
    const transaction = database.transaction(storeName, "readonly");
    const record = await requestResult<CacheRecord | undefined>(transaction.objectStore(storeName).get(cacheKey(userId, conversationId)));
    database.close();
    return record?.messages ?? [];
  } catch {
    return [];
  }
}

export async function writeCachedMessages(userId: string, conversationId: string, messages: MessageEnvelope[]) {
  try {
    const database = await openCache();
    if (!database) return;
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put({
      key: cacheKey(userId, conversationId),
      // Cache ciphertext and transport metadata only; plaintext never enters
      // this store.
      messages: messages.slice(-300),
      updatedAt: Date.now(),
    } satisfies CacheRecord);
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error ?? new Error("message_cache_failed")));
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("message_cache_failed")));
    });
    database.close();
  } catch {
    // A cache miss must never block encrypted chat.
  }
}

export async function deleteCachedMessages(userId: string, conversationId: string) {
  try {
    const database = await openCache();
    if (!database) return;
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(cacheKey(userId, conversationId));
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error ?? new Error("message_cache_failed")));
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("message_cache_failed")));
    });
    database.close();
  } catch {
    // Cache cleanup is best effort.
  }
}

export async function cachedMessageCacheStats(userId: string) {
  const database = await openCache();
  if (!database) return undefined;
  try {
    const transaction = database.transaction(storeName, "readonly");
    const records = await requestResult<CacheRecord[]>(transaction.objectStore(storeName).getAll());
    const messages = records
      .flatMap((record) => typeof record?.key === "string" && record.key.startsWith(`${userId}:`) && Array.isArray(record.messages)
        ? record.messages
        : []);
    const bytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
    return { messages: messages.length, bytes };
  } finally {
    database.close();
  }
}

export async function clearCachedMessages(userId: string) {
  const database = await openCache();
  if (!database) return 0;
  try {
    return await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const cursorRequest = store.openCursor();
      let deletedMessages = 0;
      cursorRequest.addEventListener("success", () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const record = cursor.value as Partial<CacheRecord> | null;
        if (typeof record?.key === "string" && record.key.startsWith(`${userId}:`)) {
          if (Array.isArray(record.messages)) deletedMessages += record.messages.length;
          cursor.delete();
        }
        cursor.continue();
      });
      cursorRequest.addEventListener("error", () => reject(cursorRequest.error ?? new Error("message_cache_failed")));
      transaction.addEventListener("complete", () => resolve(deletedMessages));
      transaction.addEventListener("error", () => reject(transaction.error ?? new Error("message_cache_failed")));
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("message_cache_failed")));
    });
  } finally {
    database.close();
  }
}
