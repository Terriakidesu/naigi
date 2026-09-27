export type EmojiShortcode = {
  emoji: string;
  name: string;
  aliases: readonly string[];
  code: string;
};

export const emojiShortcodes: readonly EmojiShortcode[] = [
  { emoji: "😀", name: "grinning", aliases: [], code: "1f600" },
  { emoji: "😃", name: "smiley", aliases: [], code: "1f603" },
  { emoji: "😄", name: "smile", aliases: [], code: "1f604" },
  { emoji: "😁", name: "grin", aliases: [], code: "1f601" },
  { emoji: "😆", name: "laughing", aliases: ["satisfied"], code: "1f606" },
  { emoji: "😅", name: "sweat_smile", aliases: [], code: "1f605" },
  { emoji: "😂", name: "joy", aliases: [], code: "1f602" },
  { emoji: "🤣", name: "rofl", aliases: [], code: "1f923" },
  { emoji: "🙂", name: "slightly_smiling_face", aliases: [], code: "1f642" },
  { emoji: "🙃", name: "upside_down_face", aliases: [], code: "1f643" },
  { emoji: "😉", name: "wink", aliases: [], code: "1f609" },
  { emoji: "😊", name: "blush", aliases: [], code: "1f60a" },
  { emoji: "😇", name: "innocent", aliases: [], code: "1f607" },
  { emoji: "🥰", name: "smiling_face_with_three_hearts", aliases: [], code: "1f970" },
  { emoji: "😍", name: "heart_eyes", aliases: [], code: "1f60d" },
  { emoji: "🤩", name: "star_struck", aliases: [], code: "1f929" },
  { emoji: "😘", name: "kissing_heart", aliases: [], code: "1f618" },
  { emoji: "😎", name: "sunglasses", aliases: [], code: "1f60e" },
  { emoji: "🤔", name: "thinking", aliases: [], code: "1f914" },
  { emoji: "🙄", name: "rolling_eyes", aliases: [], code: "1f644" },
  { emoji: "😴", name: "sleeping", aliases: [], code: "1f634" },
  { emoji: "🤗", name: "hugging_face", aliases: ["hugs"], code: "1f917" },
  { emoji: "🤭", name: "hand_over_mouth", aliases: [], code: "1f92d" },
  { emoji: "🤫", name: "shushing_face", aliases: [], code: "1f92b" },
  { emoji: "😐", name: "neutral_face", aliases: [], code: "1f610" },
  { emoji: "😶", name: "no_mouth", aliases: ["expressionless"], code: "1f636" },
  { emoji: "😮", name: "open_mouth", aliases: [], code: "1f62e" },
  { emoji: "😱", name: "scream", aliases: [], code: "1f631" },
  { emoji: "😭", name: "sob", aliases: [], code: "1f62d" },
  { emoji: "😡", name: "angry", aliases: ["rage", "pout"], code: "1f621" },
  { emoji: "🤝", name: "handshake", aliases: [], code: "1f91d" },
  { emoji: "👍", name: "+1", aliases: ["thumbsup", "thumb_up"], code: "1f44d" },
  { emoji: "👎", name: "-1", aliases: ["thumbsdown", "thumb_down"], code: "1f44e" },
  { emoji: "👏", name: "clap", aliases: [], code: "1f44f" },
  { emoji: "🙏", name: "pray", aliases: [], code: "1f64f" },
  { emoji: "💪", name: "muscle", aliases: [], code: "1f4aa" },
  { emoji: "❤️", name: "heart", aliases: ["red_heart"], code: "2764" },
  { emoji: "🔥", name: "fire", aliases: [], code: "1f525" },
  { emoji: "✨", name: "sparkles", aliases: [], code: "2728" },
  { emoji: "🎉", name: "tada", aliases: ["party"], code: "1f389" },
  { emoji: "🚀", name: "rocket", aliases: [], code: "1f680" },
  { emoji: "✅", name: "white_check_mark", aliases: ["check_mark"], code: "2705" },
  { emoji: "❌", name: "x", aliases: ["cross_mark"], code: "274c" },
  { emoji: "💯", name: "100", aliases: [], code: "1f4af" },
  { emoji: "👀", name: "eyes", aliases: [], code: "1f440" },
  { emoji: "🍕", name: "pizza", aliases: [], code: "1f355" },
  { emoji: "☕", name: "coffee", aliases: [], code: "2615" },
  { emoji: "🎂", name: "birthday", aliases: ["cake"], code: "1f382" },
];

const shortcodeEntries = new Map<string, EmojiShortcode>();
for (const entry of emojiShortcodes) {
  shortcodeEntries.set(entry.name, entry);
  for (const alias of entry.aliases) shortcodeEntries.set(alias, entry);
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
  const match = before.match(/(^|[\s([{])(:[A-Za-z0-9_+-]*)$/);
  if (!match) return null;
  const shortcode = match[2];
  return {
    query: shortcode.slice(1).toLowerCase(),
    start: before.length - shortcode.length,
    end: cursor,
  };
}

export function replaceEmojiShortcodes(value: string) {
  return value.replace(/(^|[^A-Za-z0-9_+:-]):([A-Za-z0-9_+-]+):/gi, (match, prefix: string, name: string) => {
    const emoji = emojiForShortcode(name);
    return emoji ? `${prefix}${emoji}` : match;
  });
}

export function emojiEntryAt(value: string, offset: number) {
  for (const entry of emojiShortcodes) {
    if (value.startsWith(entry.emoji, offset)) return { entry, text: entry.emoji };
  }
  if (value.startsWith("❤", offset)) {
    const entry = shortcodeEntries.get("heart");
    if (entry) return { entry, text: "❤" };
  }
  return undefined;
}
