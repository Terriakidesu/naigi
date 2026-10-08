import { expect, test } from "bun:test";
import { channelFlagChange } from "./channel-flags";

test("an omitted marker is never a change", () => {
  expect(channelFlagChange(false, undefined, true)).toBe("none");
  expect(channelFlagChange(true, undefined, true)).toBe("none");
});

test("re-sending the marker a room already has is not a change", () => {
  expect(channelFlagChange(false, false, true)).toBe("none");
  expect(channelFlagChange(true, true, true)).toBe("none");
  // Clients send both markers on every save, so this is the common case, not an edge case.
  expect(channelFlagChange(false, true, false)).toBe("apply");
});

test("a room whose current value is unknown is not treated as marked", () => {
  // Refusing here would make the room unsaveable on the strength of a value we never read. The
  // column is NOT NULL, so this only guards a partial row.
  expect(channelFlagChange(undefined, false, true)).toBe("apply");
  expect(channelFlagChange(undefined, true, true)).toBe("apply");
});

test("marking an unmarked room applies", () => {
  expect(channelFlagChange(false, true, true)).toBe("apply");
  expect(channelFlagChange(undefined, true, true)).toBe("apply");
});

test("an adult-content mark cannot be cleared once set", () => {
  expect(channelFlagChange(true, false, true)).toBe("refuse_permanent");
});

test("a reversible marker can always be cleared", () => {
  expect(channelFlagChange(true, false, false)).toBe("apply");
  expect(channelFlagChange(false, false, false)).toBe("none");
});