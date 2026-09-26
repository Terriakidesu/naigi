import { DecryptionErrorCode } from "@matrix-org/matrix-sdk-crypto-wasm";

// Other decryption errors (corrupt ciphertext, unsupported protocols, etc.)
// should remain visible instead of being mistaken for missing local history.
export function roomKeyUnavailable(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; description?: unknown };
  return typeof value.description === "string" && (
    value.code === DecryptionErrorCode.MissingRoomKey ||
    value.code === DecryptionErrorCode.UnknownMessageIndex
  );
}
