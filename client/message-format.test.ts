import { expect, test } from "bun:test";
import { isEmojiOnlyMessage } from "./message-format";

test("recognizes messages made only of emoji and whitespace", () => {
  expect(isEmojiOnlyMessage("😀 🎉\n❤️")).toBe(true);
  expect(isEmojiOnlyMessage("  👩‍🚀  ")).toBe(true);
  expect(isEmojiOnlyMessage("😀 hello")).toBe(false);
  expect(isEmojiOnlyMessage("   ")).toBe(false);
});

test("recognizes custom emoji-only messages when the shortcode exists in this space", () => {
  const customEmojiNames = new Set(["raora_laugh"]);
  expect(isEmojiOnlyMessage(":raora_laugh::raora_laugh:", customEmojiNames)).toBe(true);
  expect(isEmojiOnlyMessage("😂 :raora_laugh:", customEmojiNames)).toBe(true);
  expect(isEmojiOnlyMessage(":unknown_emoji:", customEmojiNames)).toBe(false);
});
