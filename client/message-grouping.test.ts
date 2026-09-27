import { test, expect } from "bun:test";
import { messageGroupState, shouldGroupMessage } from "./message-grouping";

const first = messageGroupState("alice", "2026-09-27T10:00:00.000Z");

test("groups consecutive messages from the same sender within five minutes", () => {
  expect(shouldGroupMessage(first, messageGroupState("alice", "2026-09-27T10:05:00.000Z"))).toBe(true);
  expect(shouldGroupMessage(first, messageGroupState("alice", "2026-09-27T10:05:00.001Z"))).toBe(false);
});

test("does not group across sender, day, timestamp, or reply boundaries", () => {
  expect(shouldGroupMessage(first, messageGroupState("bob", "2026-09-27T10:01:00.000Z"))).toBe(false);
  expect(shouldGroupMessage(first, messageGroupState("alice", "2026-09-27T10:06:00.000Z"))).toBe(false);
  expect(shouldGroupMessage(first, messageGroupState("alice", "2026-09-27T09:59:00.000Z"))).toBe(false);
  expect(shouldGroupMessage(
    messageGroupState("alice", "2026-09-27T10:00:00.000Z", true),
    messageGroupState("alice", "2026-09-27T10:01:00.000Z"),
  )).toBe(false);
  expect(shouldGroupMessage(first, messageGroupState("alice", "2026-09-27T10:01:00.000Z", true))).toBe(false);
});

test("does not group messages separated by a local midnight", () => {
  const beforeMidnight = new Date(2026, 8, 27, 23, 59, 59);
  const afterMidnight = new Date(2026, 8, 28, 0, 0, 1);
  expect(shouldGroupMessage(
    messageGroupState("alice", beforeMidnight),
    messageGroupState("alice", afterMidnight),
  )).toBe(false);
});
