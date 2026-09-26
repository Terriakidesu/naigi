import { expect, test } from "bun:test";
import { DecryptionErrorCode } from "@matrix-org/matrix-sdk-crypto-wasm";
import { roomKeyUnavailable } from "./decryption";

test("only missing or too-old room keys are grouped as unavailable history", () => {
  expect(roomKeyUnavailable({ code: DecryptionErrorCode.MissingRoomKey, description: "not shared" })).toBe(true);
  expect(roomKeyUnavailable({ code: DecryptionErrorCode.UnknownMessageIndex, description: "ratcheted" })).toBe(true);
  expect(roomKeyUnavailable({ code: DecryptionErrorCode.MismatchedIdentityKeys, description: "identity changed" })).toBe(false);
  expect(roomKeyUnavailable({ code: DecryptionErrorCode.MissingRoomKey })).toBe(false);
  expect(roomKeyUnavailable(new Error("invalid encrypted event"))).toBe(false);
});
