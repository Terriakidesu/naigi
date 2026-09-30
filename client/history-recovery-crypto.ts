const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const randomRecoverySecret = () => encodeRecoveryBytes(crypto.getRandomValues(new Uint8Array(32)));
export function encodeRecoveryBytes(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeRecoveryBytes(text: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("invalid_recovery_secret");
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}
export function recoveryKeyText(secret: string) { return `NCR1-${secret}`; }
export function parseRecoveryKey(text: string) {
  const secret = text.trim().replace(/^NCR1-/, "");
  if (decodeRecoveryBytes(secret).length !== 32) throw new Error("invalid_recovery_key");
  return secret;
}
async function contextKey(secret: string, context: string) {
  const bytes = decodeRecoveryBytes(secret);
  if (bytes.length !== 32) throw new Error("invalid_recovery_secret");
  const key = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("naigi-history-v1"), info: encoder.encode(context) }, key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function sealRecovery(secret: string, context: string, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, await contextKey(secret, context), encoder.encode(plaintext)));
  return `${encodeRecoveryBytes(iv)}.${encodeRecoveryBytes(ciphertext)}`;
}
export async function openRecovery(secret: string, context: string, envelope: string) {
  const parts = envelope.split(".");
  if (parts.length !== 2) throw new Error("invalid_recovery_envelope");
  const iv = decodeRecoveryBytes(parts[0]);
  if (iv.length !== 12) throw new Error("invalid_recovery_envelope");
  return decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, await contextKey(secret, context), decodeRecoveryBytes(parts[1])));
}
export async function recoverySecretHash(secret: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", decodeRecoveryBytes(secret)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function pairingVerificationCode(secret: string) {
  return (await recoverySecretHash(secret)).slice(0, 12).match(/.{4}/g)!.join(" ").toUpperCase();
}
export type LocalRecoveryEnvelope = { salt: string; payload: string };
async function localSecret(passphrase: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: decodeRecoveryBytes(salt), iterations: 310_000, hash: "SHA-256" }, key, 256);
  return encodeRecoveryBytes(new Uint8Array(bits));
}
export async function wrapLocalRecovery(passphrase: string, userId: string, plaintext: string): Promise<LocalRecoveryEnvelope> {
  const salt = encodeRecoveryBytes(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, payload: await sealRecovery(await localSecret(passphrase, salt), `local-history/${userId}`, plaintext) };
}
export async function unwrapLocalRecovery(passphrase: string, userId: string, envelope: LocalRecoveryEnvelope) {
  if (decodeRecoveryBytes(envelope.salt).length !== 16) throw new Error("invalid_recovery_envelope");
  return openRecovery(await localSecret(passphrase, envelope.salt), `local-history/${userId}`, envelope.payload);
}

export type DevicePairing = { id: string; deviceId: string; secret: string };
export function pairingLink(origin: string, pairing: DevicePairing) {
  return `${origin}/settings#approve-device=${pairing.id}.${pairing.deviceId}.${pairing.secret}`;
}
export function parsePairingLink(value: string, origin: string): DevicePairing {
  const url = new URL(value, origin);
  if (url.origin !== origin || url.pathname !== "/settings" || url.username || url.password) throw new Error("invalid_pairing_link");
  const parts = url.hash.replace(/^#approve-device=/, "").split(".");
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  if (parts.length !== 3 || !uuid.test(parts[0]) || !uuid.test(parts[1]) || decodeRecoveryBytes(parts[2]).length !== 32) throw new Error("invalid_pairing_link");
  return { id: parts[0], deviceId: parts[1], secret: parts[2] };
}
