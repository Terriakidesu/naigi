import { describe, expect, test } from "bun:test";
import { screenPassword } from "./password-policy";

describe("password screening", () => {
  test("accepts a password that is long and unrelated to the account", () => {
    expect(screenPassword("correct-horse-battery-staple-42", { username: "naigi", displayName: "Naigi" })).toBeUndefined();
    expect(screenPassword("Tr0ub4dor&3xx", { username: "naigi" })).toBeUndefined();
  });

  test("rejects passwords that lead public credential-stuffing lists", () => {
    expect(screenPassword("password1234")).toBe("password_too_common");
    expect(screenPassword("qwertyuiop12")).toBe("password_too_common");
    expect(screenPassword("123456789012")).toBe("password_too_common");
  });

  test("matches the common list after case folding and unicode normalization", () => {
    expect(screenPassword("PASSWORD1234")).toBe("password_too_common");
    expect(screenPassword("PassWord1234")).toBe("password_too_common");
  });

  test("rejects passwords built from the username or display name", () => {
    expect(screenPassword("naigi", { username: "naigi" })).toBe("password_too_similar");
    expect(screenPassword("naigi123", { username: "naigi" })).toBe("password_too_similar");
    expect(screenPassword("naigi-2024", { username: "naigi" })).toBe("password_too_similar");
    expect(screenPassword("terriaki99", { username: "naigi", displayName: "Terriaki" })).toBe("password_too_similar");
  });

  test("rejects an identity plus a short suffix even when the identity is long", () => {
    // Usernames may be 32 characters, so an allowance measured in a few trailing characters
    // would let a long username plus digits through as a "password".
    expect(screenPassword("smoke179109196812345", { username: "smoke1791091968" })).toBe("password_too_similar");
    expect(screenPassword("smoke1791091968-24", { username: "smoke1791091968" })).toBe("password_too_similar");
  });

  test("does not reject a long password that merely shares a prefix with the username", () => {
    expect(screenPassword("naigipeople-very-secret-88", { username: "naigi" })).toBeUndefined();
  });

  test("ignores identities too short to be meaningful", () => {
    expect(screenPassword("naigi-very-secret-passphrase", { username: "a", displayName: "b" })).toBeUndefined();
    expect(screenPassword("very-secret-passphrase", { username: "ab" })).toBeUndefined();
  });

  test("works without an identity at all", () => {
    expect(screenPassword("password1234")).toBe("password_too_common");
    expect(screenPassword("9Zt!qL2vXw#pR")).toBeUndefined();
  });
});
