/**
 * Input-shape helpers shared by the route modules.
 *
 * These normalise untrusted values before they reach a query or a validator. The `objectValue`
 * and `stringArray` helpers exist because several endpoints accept JSON either as a parsed body or
 * as a serialised string depending on the client.
 */

import { t } from "elysia";
import { deviceClientName } from "../device-client";
import { decodeBase64 } from "../encoding";

/** Returns a plain object, parsing a JSON string first, or `null` for anything else. */
export function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Accepts an array, a PostgreSQL array literal, or a JSON array, and yields only strings. */
export function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  if (value.startsWith("{") && value.endsWith("}")) {
    return value.slice(1, -1).split(",").map((item) => item.replace(/^"|"$/g, "")).filter(Boolean);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function matrixUserId(userId: string) {
  return `@${userId}:priv-chat`;
}

export const encryptedBytes = (maxLength: number) => t.String({ minLength: 1, maxLength });

// A Matrix key is opaque to the backend: it is stored and returned without inspection. These bounds
// only stop a caller persisting an unbounded document under a key's name.
function validCryptoKey(value: unknown) {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > 16 * 1024) return false;
  if (typeof value === "string") return value.length > 0;
  const object = objectValue(value);
  return Boolean(object && typeof object.key === "string" && object.key.length > 0 && object.key.length <= 4096);
}

/**
 * Validates a Matrix key upload.
 *
 * Rejects an unparseable device id, a mismatched `user_id`/`device_id` pair, and oversized key
 * sets, so a malformed upload cannot reach the database.
 */
export function parseCryptoUpload(value: unknown) {
  const body = objectValue(value);
  const deviceName = deviceClientName(body?.device_client);
  if (deviceName === null) return null;
  const deviceKeys = objectValue(body?.device_keys);
  const keys = objectValue(deviceKeys?.keys);
  const deviceId = deviceKeys?.device_id ?? body?.device_id;
  const oneTimeKeys = objectValue(body?.one_time_keys) ?? {};
  const fallbackKeys = objectValue(body?.fallback_keys) ?? {};
  if (!isUuid(deviceId)) return null;
  if (deviceKeys && (!keys || typeof deviceKeys.user_id !== "string" || deviceKeys.device_id !== deviceId)) return null;
  if (Object.keys(oneTimeKeys).length > 100 || Object.keys(fallbackKeys).length > 10) return null;
  if (keys && !Object.values(keys).every((key) => typeof key === "string")) return null;
  if (!Object.values(oneTimeKeys).every(validCryptoKey)) return null;
  if (!Object.values(fallbackKeys).every(validCryptoKey)) return null;
  return { deviceId, deviceKeys, oneTimeKeys, fallbackKeys, deviceName };
}

/** Encrypted channel, space, and role names arrive as base64 and are never decrypted here. */
export function decodeEncryptedMetadata(value: string | undefined) {
  if (!value) return Buffer.alloc(0);
  return decodeBase64(value, "encryptedMetadata", 64 * 1024, true);
}

/** Opaque keyset cursor. Rejects anything that is not short base64url before decoding. */
export function encodePageCursor(value: Record<string, string>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodePageCursor(value: string | undefined) {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return objectValue(decoded) ?? undefined;
  } catch {
    return undefined;
  }
}

export function isCursorTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value);
}

/**
 * Exclusive upper bound for a prefix search under a `C` collation.
 *
 * Used as `col < prefixUpperBound(prefix)` so a prefix match is a range scan rather than a leading
 * wildcard, which is what keeps the directory and member searches on an index.
 */
export function prefixUpperBound(value: string) {
  const characters = Array.from(value);
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    let codePoint = characters[index]!.codePointAt(0)!;
    if (codePoint >= 0x10ffff) continue;
    codePoint += 1;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xe000;
    return characters.slice(0, index).join("") + String.fromCodePoint(codePoint);
  }
  return undefined;
}
