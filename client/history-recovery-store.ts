import type { LocalRecoveryEnvelope } from "./history-recovery-crypto";
const databaseName = "naigi-history-recovery";
function openStore() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function readLocalRecovery(userId: string): Promise<LocalRecoveryEnvelope | undefined> {
  const db = await openStore();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("keys").objectStore("keys").get(userId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export async function writeLocalRecovery(userId: string, envelope?: LocalRecoveryEnvelope) {
  const db = await openStore();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      if (envelope) tx.objectStore("keys").put(envelope, userId); else tx.objectStore("keys").delete(userId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
