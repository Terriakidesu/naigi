import { describe, expect, test } from "bun:test";
import { canReconcileLatestMessagePage } from "./message-window";
import type { MessageEnvelope } from "./api";

function message(sequence: number, overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: `message-${sequence}`,
    conversationId: "conversation-1",
    senderDeviceId: "device-1",
    senderUserId: "user-1",
    clientMessageId: `client-${sequence}`,
    serverSequence: String(sequence),
    protocol: "m.megolm.v1.aes-sha2",
    ciphertext: `ciphertext-${sequence}`,
    protocolMetadata: `metadata-${sequence}`,
    createdAt: `2026-09-28T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

describe("cached message window reconciliation", () => {
  test("keeps an already-rendered cache when the server confirms its tail", () => {
    expect(canReconcileLatestMessagePage(
      [message(1), message(2), message(3)],
      [message(2), message(3)],
    )).toBe(true);
  });

  test("allows matching cached messages followed by new server messages", () => {
    expect(canReconcileLatestMessagePage(
      [message(1), message(2), message(3)],
      [message(2), message(3), message(4)],
    )).toBe(true);
  });

  test("requires exact envelopes and rejects unknown older messages", () => {
    expect(canReconcileLatestMessagePage(
      [message(1), message(2), message(3)],
      [message(2, { ciphertext: "changed" }), message(3)],
    )).toBe(false);
    expect(canReconcileLatestMessagePage(
      [message(3), message(4)],
      [message(2), message(3), message(4)],
    )).toBe(false);
  });
});
