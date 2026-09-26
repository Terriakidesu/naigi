const sessionPassphraseKey = "priv-chat.local-passphrase";
const manualLockKey = "priv-chat.manual-lock";
const vaultDatabaseName = "priv-chat-unlock-vault";
const vaultStoreName = "passphrases";

type VaultRecord = {
  userId: string;
  key: CryptoKey;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

function subtleCrypto() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("remembered_unlock_requires_secure_context");
  return subtle;
}

export function rememberedUnlockSupported() {
  return Boolean(globalThis.crypto?.subtle && globalThis.indexedDB);
}

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

export function lockLocalSession() {
  clearSessionPassphrase();
  sessionStorage.setItem(manualLockKey, "1");
}

export function localSessionLocked() {
  return sessionStorage.getItem(manualLockKey) === "1";
}

export function confirmLocalUnlock() {
  sessionStorage.removeItem(manualLockKey);
}

// The navigation handoff is one-time; subsequent pages can recover only from
// the opt-in, encrypted device vault on a secure origin.
export async function resolveLocalPassphrase(userId: string) {
  const handoff = takeSessionPassphrase();
  if (handoff) return handoff;
  if (localSessionLocked()) return null;
  return recoverRememberedPassphrase(userId).catch(() => null);
}

export async function rememberPassphrase(userId: string, passphrase: string) {
  if (!rememberedUnlockSupported()) throw new Error("remembered_unlock_requires_secure_context");
  const subtle = subtleCrypto();
  const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt(
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
  if (!rememberedUnlockSupported()) return null;
  const database = await openVault();
  try {
    const transaction = database.transaction(vaultStoreName, "readonly");
    const record = await transactionResult(transaction.objectStore(vaultStoreName).get(userId)) as VaultRecord | undefined;
    if (!record) return null;
    try {
      const cleartext = await subtleCrypto().decrypt(
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
  if (!globalThis.indexedDB) return;
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
