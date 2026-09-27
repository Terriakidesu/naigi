import { expect, test } from "bun:test";
import { isEmojiOnlyMessage } from "./message-format";

test("recognizes messages made only of emoji and whitespace", () => {
  expect(isEmojiOnlyMessage("😀 🎉\n❤️")).toBe(true);
  expect(isEmojiOnlyMessage("  👩‍🚀  ")).toBe(true);
  expect(isEmojiOnlyMessage("😀 hello")).toBe(false);
  expect(isEmojiOnlyMessage("   ")).toBe(false);
});
