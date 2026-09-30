import { expect, test } from "bun:test";
import { openRecovery, sealRecovery, randomRecoverySecret, recoveryKeyText, parseRecoveryKey, wrapLocalRecovery, unwrapLocalRecovery, pairingLink, parsePairingLink, pairingVerificationCode } from "./history-recovery-crypto";

test("recovery envelopes authenticate secrets, account context, and ciphertext", async () => {
  const secret = randomRecoverySecret();
  const encrypted = await sealRecovery(secret, "backup-key/account/backup", "private room key");
  expect(encrypted).not.toContain("private room key");
  expect(await openRecovery(secret, "backup-key/account/backup", encrypted)).toBe("private room key");
  await expect(openRecovery(randomRecoverySecret(), "backup-key/account/backup", encrypted)).rejects.toThrow();
  await expect(openRecovery(secret, "backup-key/other/backup", encrypted)).rejects.toThrow();
  await expect(openRecovery(secret, "backup-key/account/backup", `${encrypted.slice(0, -3)}AAA`)).rejects.toThrow();
});
test("recovery keys are generated secrets, not account passwords", () => {
  const secret = randomRecoverySecret();
  expect(parseRecoveryKey(recoveryKeyText(secret))).toBe(secret);
  expect(() => parseRecoveryKey("ordinary account password")).toThrow();
  expect(() => parseRecoveryKey("NCR1-short")).toThrow();
});
test("persisted backup keys are encrypted under the local passphrase and account", async () => {
  const wrapped = await wrapLocalRecovery("local passphrase", "account", "secret data key");
  expect(JSON.stringify(wrapped)).not.toContain("secret data key");
  expect(await unwrapLocalRecovery("local passphrase", "account", wrapped)).toBe("secret data key");
  await expect(unwrapLocalRecovery("wrong passphrase", "account", wrapped)).rejects.toThrow();
  await expect(unwrapLocalRecovery("local passphrase", "other", wrapped)).rejects.toThrow();
});
test("pairing links keep secrets in fragments, enforce the origin, and have stable comparison codes", async () => {
  const pairing = { id: crypto.randomUUID(), deviceId: crypto.randomUUID(), secret: randomRecoverySecret() };
  const link = pairingLink("https://naigi.test", pairing);
  expect(new URL(link).search).toBe("");
  expect(parsePairingLink(link, "https://naigi.test")).toEqual(pairing);
  expect(() => parsePairingLink(link, "https://other.test")).toThrow();
  expect(await pairingVerificationCode(pairing.secret)).toMatch(/^[A-F0-9]{4} [A-F0-9]{4} [A-F0-9]{4}$/);
});
