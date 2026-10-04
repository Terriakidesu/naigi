import { describe, expect, test } from "bun:test";
import { maxSubscriptionsPerSocket } from "./realtime";

describe("realtime subscription ceiling", () => {
  test("is a positive integer well above normal client use", () => {
    expect(Number.isInteger(maxSubscriptionsPerSocket)).toBe(true);
    expect(maxSubscriptionsPerSocket).toBeGreaterThan(0);
  });

  test("allows a client following many conversations without tripping the limit", () => {
    // A real client follows a handful of conversations; the ceiling exists to stop a single
    // socket registering channels without bound, not to constrain ordinary use.
    expect(maxSubscriptionsPerSocket).toBeGreaterThanOrEqual(50);
  });
});
