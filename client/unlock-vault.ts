const sessionPassphraseKey = "priv-chat.local-passphrase";
const vaultDatabaseName = "priv-chat-unlock-vault";
const vaultStoreName = "passphrases";

type VaultRecord = {
  userId: string;
  key: CryptoKey;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

function openVault() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(vaultDatabaseName, 1);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(vaultStoreName, { keyPath: "userId" });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("unlock_vault_unavailable")));
  });
}

function transactionResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("unlock_vault_failed")));
  });
}

export function takeSessionPassphrase() {
  const value = sessionStorage.getItem(sessionPassphraseKey);
  sessionStorage.removeItem(sessionPassphraseKey);
  return value;
}

export function setSessionPassphrase(value: string) {
  sessionStorage.setItem(sessionPassphraseKey, value);
}

export function clearSessionPassphrase() {
  sessionStorage.removeItem(sessionPassphraseKey);
}

export async function rememberPassphrase(userId: string, passphrase: string) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(passphrase),
  );
  const database = await openVault();
  try {
    const transaction = database.transaction(vaultStoreName, "readwrite");
    transaction.objectStore(vaultStoreName).put({
      userId,
      key,
      iv: iv.buffer,
      ciphertext,
    } satisfies VaultRecord);
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error ?? new Error("unlock_vault_failed")));
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("unlock_vault_failed")));
    });
  } finally {
    database.close();
  }
}

export async function recoverRememberedPassphrase(userId: string) {
  const database = await openVault();
  try {
    const transaction = database.transaction(vaultStoreName, "readonly");
    const record = await transactionResult(transaction.objectStore(vaultStoreName).get(userId)) as VaultRecord | undefined;
    if (!record) return null;
    try {
      const cleartext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: record.iv },
        record.key,
        record.ciphertext,
      );
      return new TextDecoder().decode(cleartext);
    } catch {
      await forgetRememberedPassphrase(userId);
      return null;
    }
  } finally {
    database.close();
  }
}

export async function forgetRememberedPassphrase(userId: string) {
  const database = await openVault();
  try {
    const transaction = database.transaction(vaultStoreName, "readwrite");
    transaction.objectStore(vaultStoreName).delete(userId);
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error ?? new Error("unlock_vault_failed")));
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("unlock_vault_failed")));
    });
  } finally {
    database.close();
  }
}
