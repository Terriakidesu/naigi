import { describe, expect, test } from "bun:test";
import { countDistinctLiveUsers } from "./live-connections";

describe("aggregate realtime connection counts", () => {
  test("counts distinct accounts separately from their open sockets", () => {
    const firstUser = "a".repeat(64);
    const secondUser = "b".repeat(64);

    expect(countDistinctLiveUsers([
      `${firstUser}:socket-one`,
      `${firstUser}:socket-two`,
      `${secondUser}:socket-three`,
    ])).toBe(2);
  });

  test("returns zero for an empty active lease set", () => {
    expect(countDistinctLiveUsers([])).toBe(0);
  });

  test("fails closed on malformed lease members", () => {
    expect(countDistinctLiveUsers(["not-a-valid-member"])).toBeNull();
  });
});
