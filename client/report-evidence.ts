const backupFormat = "naigi-instance-report-key-v1";
const backupIterations = 310_000;

export type EncryptedReportEvidence = {
  keyId: string;
  ciphertext: string;
  wrappedKey: string;
  iv: string;
};

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_report_key_data");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function deriveBackupKey(passphrase: string, salt: Uint8Array, iterations: number, usage: KeyUsage[]) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usage,
  );
}

export async function generateReportKeyPair() {
  const pair = await crypto.subtle.generateKey({
    name: "RSA-OAEP",
    modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["encrypt", "decrypt"]);
  const publicKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  return { publicKey, privateKey: pair.privateKey };
}

export async function encryptReportEvidence(
  publicKeyEncoded: string,
  keyId: string,
  evidence: Record<string, unknown>,
): Promise<EncryptedReportEvidence> {
  const publicKey = await crypto.subtle.importKey(
    "spki",
    base64UrlToBytes(publicKeyEncoded),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawContentKey = await crypto.subtle.exportKey("raw", contentKey);
  const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawContentKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    contentKey,
    new TextEncoder().encode(JSON.stringify(evidence)),
  );
  return {
    keyId,
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedKey)),
    iv: bytesToBase64Url(iv),
  };
}

export async function createEncryptedPrivateKeyBackup(keyId: string, privateKey: CryptoKey, passphrase: string) {
  if (passphrase.length < 12) throw new Error("report_key_passphrase_too_short");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptionKey = await deriveBackupKey(passphrase, salt, backupIterations, ["encrypt"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  const encryptedPrivateKey = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encryptionKey, pkcs8);
  return JSON.stringify({
    format: backupFormat,
    keyId,
    iterations: backupIterations,
    salt: bytesToBase64Url(salt),
    iv: bytesToBase64Url(iv),
    encryptedPrivateKey: bytesToBase64Url(new Uint8Array(encryptedPrivateKey)),
  }, null, 2);
}

export async function makeReportPrivateKeyNonExtractable(privateKey: CryptoKey) {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  return await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
}

export async function importEncryptedPrivateKeyBackup(fileText: string, passphrase: string) {
  const value = JSON.parse(fileText) as Record<string, unknown>;
  if (value.format !== backupFormat || typeof value.keyId !== "string"
    || typeof value.iterations !== "number" || value.iterations < 100_000 || value.iterations > 1_000_000
    || typeof value.salt !== "string" || typeof value.iv !== "string" || typeof value.encryptedPrivateKey !== "string") {
    throw new Error("invalid_report_key_backup");
  }
  const salt = base64UrlToBytes(value.salt);
  const iv = base64UrlToBytes(value.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error("invalid_report_key_backup");
  const encryptionKey = await deriveBackupKey(passphrase, salt, value.iterations, ["decrypt"]);
  const pkcs8 = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, encryptionKey, base64UrlToBytes(value.encryptedPrivateKey));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  return { keyId: value.keyId, privateKey };
}

export async function decryptReportEvidence(evidence: EncryptedReportEvidence, privateKey: CryptoKey) {
  const rawContentKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, base64UrlToBytes(evidence.wrappedKey));
  const contentKey = await crypto.subtle.importKey("raw", rawContentKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(evidence.iv) },
    contentKey,
    base64UrlToBytes(evidence.ciphertext),
  );
  const value = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_report_evidence");
  return value as Record<string, unknown>;
}
