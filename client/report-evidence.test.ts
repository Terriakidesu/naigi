import { describe, expect, test } from "bun:test";
import {
  createEncryptedPrivateKeyBackup,
  decryptReportEvidence,
  encryptReportEvidence,
  generateReportKeyPair,
  importEncryptedPrivateKeyBackup,
  makeReportPrivateKeyNonExtractable,
} from "./report-evidence";

function fromBase64Url(value: string) {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard + "=".repeat((4 - standard.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

describe("instance report evidence encryption", () => {
  test("only the matching host private key decrypts reporter evidence", async () => {
    const { publicKey, privateKey } = await generateReportKeyPair();
    const keyId = crypto.randomUUID();
    const envelope = await encryptReportEvidence(publicKey, keyId, {
      source: "reporter-selected-message",
      text: "An explicitly shared excerpt",
    });

    expect(envelope.keyId).toBe(keyId);
    expect(await decryptReportEvidence(envelope, privateKey)).toEqual({
      source: "reporter-selected-message",
      text: "An explicitly shared excerpt",
    });

    const unrelatedPair = await crypto.subtle.generateKey({
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    }, true, ["encrypt", "decrypt"]);
    await expect(decryptReportEvidence(envelope, unrelatedPair.privateKey)).rejects.toThrow();
  });

  test("encrypted key backups round-trip and imported keys are non-extractable", async () => {
    const { publicKey, privateKey } = await generateReportKeyPair();
    const keyId = crypto.randomUUID();
    const passphrase = "a sufficiently long test passphrase";
    const backup = await createEncryptedPrivateKeyBackup(keyId, privateKey, passphrase);
    const imported = await importEncryptedPrivateKeyBackup(backup, passphrase);
    const nonExtractable = await makeReportPrivateKeyNonExtractable(privateKey);
    const envelope = await encryptReportEvidence(publicKey, keyId, { text: "backup-restored evidence" });

    expect(imported.keyId).toBe(keyId);
    expect(nonExtractable.extractable).toBe(false);
    expect(imported.privateKey.extractable).toBe(false);
    expect(await decryptReportEvidence(envelope, imported.privateKey)).toEqual({ text: "backup-restored evidence" });
    await expect(importEncryptedPrivateKeyBackup(backup, "incorrect passphrase")).rejects.toThrow();
  });

  test("tampering with encrypted evidence is detected", async () => {
    const { publicKey, privateKey } = await generateReportKeyPair();
    const envelope = await encryptReportEvidence(publicKey, crypto.randomUUID(), { text: "tamper check" });
    const ciphertext = fromBase64Url(envelope.ciphertext);
    ciphertext[0] ^= 0xff;
    const tampered = {
      ...envelope,
      ciphertext: btoa(String.fromCharCode(...ciphertext)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""),
    };

    await expect(decryptReportEvidence(tampered, privateKey)).rejects.toThrow();
  });
});
