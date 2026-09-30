import { emojiEntryAt } from "./emoji";

export function isEmojiOnlyMessage(value: string, customEmojiNames?: { has(name: string): boolean }) {
  let offset = 0;
  let foundEmoji = false;

  while (offset < value.length) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (/\s/u.test(character)) {
      offset += character.length;
      continue;
    }

    if (value[offset] === ":") {
      const customEmoji = /^:([A-Za-z0-9_+-]{1,32}):/.exec(value.slice(offset));
      if (customEmoji && customEmojiNames?.has(customEmoji[1].toLowerCase())) {
        foundEmoji = true;
        offset += customEmoji[0].length;
        continue;
      }
    }

    const emoji = emojiEntryAt(value, offset);
    if (!emoji) return false;
    foundEmoji = true;
    offset += emoji.text.length;
  }

  return foundEmoji;
}
