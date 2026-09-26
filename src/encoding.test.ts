import { describe, expect, test } from "bun:test";
import { decodeBase64, encodeBase64, InvalidEncodingError } from "./encoding";

describe("encrypted payload encoding", () => {
  test("round-trips binary payloads as unpadded base64url", () => {
    const payload = Uint8Array.from([0, 1, 2, 127, 128, 255]);
    const encoded = encodeBase64(payload);

    expect(encoded).toBe("AAECf4D_");
    expect(decodeBase64(encoded, "ciphertext", payload.byteLength)).toEqual(Buffer.from(payload));
  });

  test("rejects malformed or oversized payloads before database insertion", () => {
    expect(() => decodeBase64("not+base64", "ciphertext", 64)).toThrow(InvalidEncodingError);
    expect(() => decodeBase64("abcd", "ciphertext", 2)).toThrow(InvalidEncodingError);
    expect(() => decodeBase64("", "ciphertext", 64)).toThrow(InvalidEncodingError);
    expect(decodeBase64("", "protocolMetadata", 64, true)).toEqual(Buffer.alloc(0));
  });
});
