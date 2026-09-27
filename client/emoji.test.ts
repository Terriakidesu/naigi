import { expect, test } from "bun:test";
import { emojiEntryAt, emojiForShortcode, emojiShortcodeToken, replaceEmojiShortcodes } from "./emoji";

test("resolves common emoji shortcodes and leaves unknown names alone", () => {
  expect(replaceEmojiShortcodes(":smile: :+1: :heart: :not_an_emoji:")).toBe("😄 👍 ❤️ :not_an_emoji:");
  expect(replaceEmojiShortcodes(":sob::sob:")).toBe("😭😭");
  expect(emojiForShortcode("THUMBSUP")).toBe("👍");
  expect(emojiForShortcode("melting_face")).toBe("🫠");
});

test("finds the shortcode being typed at the cursor", () => {
  expect(emojiShortcodeToken("hello :smi", 10)).toEqual({ query: "smi", start: 6, end: 10 });
  expect(emojiShortcodeToken("hello :smile: ")).toBeNull();
  expect(emojiShortcodeToken("hello:smile")).toBeNull();
  expect(emojiShortcodeToken(":sob::sob", 9)).toEqual({ query: "sob", start: 5, end: 9 });
});

test("maps supported Unicode emoji to their local Twemoji asset", () => {
  expect(emojiEntryAt("hello 😄", 6)?.entry.code).toBe("1f604");
  expect(emojiEntryAt("❤", 0)?.entry.name).toBe("red_heart");
  expect(emojiEntryAt("🫠", 0)?.entry.code).toBe("1fae0");
  expect(emojiEntryAt("👩‍🚀", 0)?.entry.code).toBe("1f469-200d-1f680");
  expect(emojiEntryAt("x", 0)).toBeUndefined();
});
