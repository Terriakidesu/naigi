import { emojiAssetCodes, emojiData, type EmojiCategory } from "./emoji-data";

export type EmojiShortcode = {
  emoji: string;
  name: string;
  aliases: readonly string[];
  code: string;
  category: EmojiCategory;
};

const assetCodeSet = new Set(emojiAssetCodes);
const normalizedAssetCodes = new Map<string, string>();
for (const code of emojiAssetCodes) {
  const normalized = code.split("-").filter((part) => part !== "fe0f").join("-");
  if (!normalizedAssetCodes.has(normalized)) normalizedAssetCodes.set(normalized, code);
}

const legacyAliases: Record<string, readonly string[]> = {
  "😀": ["grinning"],
  "😃": ["smiley"],
  "😄": ["smile"],
  "😁": ["grin"],
  "😆": ["laughing", "satisfied"],
  "😅": ["sweat_smile"],
  "😂": ["joy"],
  "🤣": ["rofl"],
  "🙂": ["slightly_smiling_face"],
  "🙃": ["upside_down_face"],
  "😉": ["wink"],
  "😊": ["blush"],
  "😇": ["innocent"],
  "🥰": ["smiling_face_with_three_hearts"],
  "😍": ["heart_eyes"],
  "🤩": ["star_struck"],
  "😘": ["kissing_heart"],
  "😎": ["sunglasses"],
  "🤔": ["thinking"],
  "🙄": ["rolling_eyes"],
  "😴": ["sleeping"],
  "🤗": ["hugging_face", "hugs"],
  "🤭": ["hand_over_mouth"],
  "🤫": ["shushing_face"],
  "😐": ["neutral_face"],
  "😶": ["no_mouth", "expressionless"],
  "😮": ["open_mouth"],
  "😱": ["scream"],
  "😭": ["sob"],
  "😡": ["angry", "rage", "pout"],
  "🤝": ["handshake"],
  "👍": ["+1", "thumbsup", "thumb_up"],
  "👎": ["-1", "thumbsdown", "thumb_down"],
  "👏": ["clap"],
  "🙏": ["pray"],
  "💪": ["muscle"],
  "❤️": ["heart", "red_heart"],
  "🔥": ["fire"],
  "✨": ["sparkles"],
  "🎉": ["tada", "party"],
  "🚀": ["rocket"],
  "✅": ["white_check_mark", "check_mark"],
  "❌": ["x", "cross_mark"],
  "💯": ["100"],
  "👀": ["eyes"],
  "🍕": ["pizza"],
  "☕": ["coffee"],
  "🎂": ["birthday", "cake"],
};

function codePointSequence(value: string) {
  return [...value].map((character) => character.codePointAt(0)!.toString(16)).join("-");
}

function assetCodeForSequence(parts: readonly string[]) {
  const exact = parts.join("-");
  if (assetCodeSet.has(exact)) return exact;
  const normalized = parts.filter((part) => part !== "fe0f").join("-");
  if (assetCodeSet.has(normalized)) return normalized;
  return normalizedAssetCodes.get(normalized);
}

function assetCodeForEmoji(emoji: string) {
  return assetCodeForSequence(codePointSequence(emoji).split("-")) ?? codePointSequence(emoji);
}

export const emojiShortcodes: readonly EmojiShortcode[] = emojiData.map(([emoji, name, aliases, category]) => ({
  emoji,
  name,
  aliases: [...new Set([...aliases, ...(legacyAliases[emoji] ?? [])])],
  code: assetCodeForEmoji(emoji),
  category,
}));

const emojiByText = new Map(emojiShortcodes.map((entry) => [entry.emoji, entry]));
const emojiByNormalizedText = new Map<string, EmojiShortcode>();
for (const entry of emojiShortcodes) {
  const normalized = entry.emoji.replaceAll("\uFE0F", "");
  if (!emojiByNormalizedText.has(normalized)) emojiByNormalizedText.set(normalized, entry);
}
const shortcodeEntries = new Map<string, EmojiShortcode>();

for (const [emoji, aliases] of Object.entries(legacyAliases)) {
  const entry = emojiByText.get(emoji);
  if (!entry) continue;
  for (const alias of aliases) shortcodeEntries.set(alias, entry);
}
for (const entry of emojiShortcodes) {
  for (const name of [entry.name, ...entry.aliases]) {
    if (!shortcodeEntries.has(name)) shortcodeEntries.set(name, entry);
  }
}

export function emojiForShortcode(name: string) {
  return shortcodeEntries.get(name.trim().toLowerCase())?.emoji;
}

export function emojiShortcodeMatches(query: string) {
  const normalized = query.trim().toLowerCase();
  return emojiShortcodes.filter((entry) => [entry.name, ...entry.aliases].some((name) => name.startsWith(normalized)));
}

export function emojiShortcodeName(entry: EmojiShortcode, query = "") {
  const normalized = query.trim().toLowerCase();
  return [entry.name, ...entry.aliases].find((name) => name.startsWith(normalized)) ?? entry.name;
}

export function emojiShortcodeToken(value: string, cursor = value.length) {
  const before = value.slice(0, cursor);
  const match = before.match(/(^|[\s([{:])(:[A-Za-z0-9_+-]*)$/);
  if (!match) return null;
  const shortcode = match[2];
  return {
    query: shortcode.slice(1).toLowerCase(),
    start: before.length - shortcode.length,
    end: cursor,
  };
}

export function replaceEmojiShortcodes(value: string) {
  return value.replace(/:[A-Za-z0-9_+-]+:/gi, (match, offset: number) => {
    if (offset > 0 && /[A-Za-z0-9_+-]/.test(value[offset - 1])) return match;
    const name = match.slice(1, -1);
    const emoji = emojiForShortcode(name);
    return emoji ?? match;
  });
}

function emojiAssetAt(value: string, offset: number) {
  let index = offset;
  const parts: string[] = [];
  let best: { code: string; end: number } | undefined;
  for (let count = 0; count < 12 && index < value.length; count += 1) {
    const codePoint = value.codePointAt(index)!;
    parts.push(codePoint.toString(16));
    index += codePoint > 0xffff ? 2 : 1;
    const code = assetCodeForSequence(parts);
    if (code) best = { code, end: index };
  }
  return best;
}

export function emojiEntryAt(value: string, offset: number) {
  const match = emojiAssetAt(value, offset);
  if (!match) return undefined;
  const text = value.slice(offset, match.end);
  const entry = emojiByText.get(text) ?? emojiByNormalizedText.get(text.replaceAll("\uFE0F", "")) ?? {
    emoji: text,
    name: "emoji",
    aliases: [],
    code: match.code,
    category: "Symbols",
  } satisfies EmojiShortcode;
  return { entry, text };
}
