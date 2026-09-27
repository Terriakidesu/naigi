import { expect, test } from "bun:test";
import { emojiEntryAt, emojiForShortcode, emojiShortcodeToken, replaceEmojiShortcodes } from "./emoji";

test("resolves common emoji shortcodes and leaves unknown names alone", () => {
  expect(replaceEmojiShortcodes(":smile: :+1: :heart: :not_an_emoji:")).toBe("😄 👍 ❤️ :not_an_emoji:");
  expect(emojiForShortcode("THUMBSUP")).toBe("👍");
});

test("finds the shortcode being typed at the cursor", () => {
  expect(emojiShortcodeToken("hello :smi", 10)).toEqual({ query: "smi", start: 6, end: 10 });
  expect(emojiShortcodeToken("hello :smile: ")).toBeNull();
  expect(emojiShortcodeToken("hello:smile")).toBeNull();
});

test("maps supported Unicode emoji to their local Twemoji asset", () => {
  expect(emojiEntryAt("hello 😄", 6)?.entry.code).toBe("1f604");
  expect(emojiEntryAt("❤", 0)?.entry.name).toBe("heart");
  expect(emojiEntryAt("x", 0)).toBeUndefined();
});
