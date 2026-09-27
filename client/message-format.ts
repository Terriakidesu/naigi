import { emojiEntryAt } from "./emoji";

export function isEmojiOnlyMessage(value: string) {
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

    const emoji = emojiEntryAt(value, offset);
    if (!emoji) return false;
    foundEmoji = true;
    offset += emoji.text.length;
  }

  return foundEmoji;
}
