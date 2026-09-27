export type PendingMessagePayload = {
  senderDeviceId: string;
  clientMessageId: string;
  protocol: string;
  ciphertext: string;
  protocolMetadata?: string;
  attachmentId?: string;
  attachmentIds?: string[];
};

export type PendingMessage = PendingMessagePayload & {
  id: string;
  conversationId: string;
  createdAt: string;
  attempts: number;
  status: "pending" | "failed";
  lastError?: string;
};

const databaseName = "priv-chat-message-outbox";
const storeName = "messages";

function randomId() {
  return globalThis.crypto.randomUUID();
}

function openOutbox() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.addEventListener("upgradeneeded", () => {
      const store = request.result.createObjectStore(storeName, { keyPath: "id" });
      store.createIndex("conversationId", "conversationId", { unique: false });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("outbox_unavailable")));
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("outbox_failed")));
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("outbox_failed")));
  });
}

function transactionResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("outbox_failed")));
  });
}

export function outboxSupported() {
  return Boolean(globalThis.indexedDB);
}

export async function enqueuePendingMessage(conversationId: string, payload: PendingMessagePayload) {
  if (!outboxSupported()) throw new Error("outbox_unavailable");
  const record: PendingMessage = {
    ...payload,
    id: randomId(),
    conversationId,
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: "pending",
  };
  const database = await openOutbox();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(record);
    await transactionComplete(transaction);
    return record;
  } finally {
    database.close();
  }
}

export async function listPendingMessages() {
  if (!outboxSupported()) return [];
  const database = await openOutbox();
  try {
    const transaction = database.transaction(storeName, "readonly");
    const records = await transactionResult(transaction.objectStore(storeName).getAll()) as PendingMessage[];
    return records.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  } finally {
    database.close();
  }
}

export async function removePendingMessage(id: string) {
  if (!outboxSupported()) return;
  const database = await openOutbox();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(id);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function updatePendingMessage(record: PendingMessage) {
  if (!outboxSupported()) return;
  const database = await openOutbox();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(record);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}
