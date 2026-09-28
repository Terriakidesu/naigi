import { emojiEntryAt } from "./emoji";
import { guardExternalLink } from "./external-link";

export type MarkdownInline =
  | { kind: "text"; value: string }
  | { kind: "strong" | "emphasis" | "strike" | "code" | "spoiler"; value: string }
  | { kind: "link"; label: string; url: string };

export type MarkdownBlock =
  | { kind: "paragraph" | "heading" | "quote" | "unordered-list" | "ordered-list"; value: string | string[]; level?: number }
  | { kind: "code-block"; value: string; language?: string };

export type MarkdownRenderOptions = {
  mentionUsernames?: Set<string>;
  mentionRoleNames?: Set<string>;
  customEmoji?: ReadonlyMap<string, { src: string; alt: string }>;
  roomReferences?: Map<string, string>;
  onRoomReference?: (channelId: string) => void;
};

function safeLinkUrl(value: string) {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function pushText(tokens: MarkdownInline[], value: string) {
  if (!value) return;
  const previous = tokens[tokens.length - 1];
  if (previous?.kind === "text") previous.value += value;
  else tokens.push({ kind: "text", value });
}

export function parseInlineMarkdown(value: string): MarkdownInline[] {
  const tokens: MarkdownInline[] = [];
  const pattern = /(\*\*|__)(.+?)\1|(\*|_)([^*_\n]+?)\3|~~([^~\n]+?)~~|\|\|([^|\n]+?)\|\||`([^`\n]+)`|\[([^\]\n]+)\]\((\S+?)\)|((?:https?:\/\/)[^\s<]+)/gi;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? offset;
    pushText(tokens, value.slice(offset, index));
    if (match[2] !== undefined) tokens.push({ kind: "strong", value: match[2] });
    else if (match[4] !== undefined) tokens.push({ kind: "emphasis", value: match[4] });
    else if (match[5] !== undefined) tokens.push({ kind: "strike", value: match[5] });
    else if (match[6] !== undefined) tokens.push({ kind: "spoiler", value: match[6] });
    else if (match[7] !== undefined) tokens.push({ kind: "code", value: match[7] });
    else if (match[8] !== undefined && match[9] !== undefined) {
      const url = safeLinkUrl(match[9].replace(/[),.!?:;]+$/g, ""));
      if (url) tokens.push({ kind: "link", label: match[8], url });
      else pushText(tokens, match[0]);
    } else if (match[10] !== undefined) {
      const raw = match[10].replace(/[),.!?:;]+$/g, "");
      const url = safeLinkUrl(raw);
      if (url) {
        tokens.push({ kind: "link", label: raw, url });
        pushText(tokens, match[10].slice(raw.length));
      }
      else pushText(tokens, match[0]);
    } else {
      pushText(tokens, match[0]);
    }
    offset = index + match[0].length;
  }
  pushText(tokens, value.slice(offset));
  return tokens;
}

export function parseMarkdown(value: string): MarkdownBlock[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let codeLanguage: string | undefined;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", value: paragraph.join("\n") });
    paragraph = [];
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      if (code) {
        blocks.push({ kind: "code-block", value: code.join("\n"), language: codeLanguage || undefined });
        code = null;
        codeLanguage = undefined;
      } else {
        flushParagraph();
        code = [];
        codeLanguage = fence[1] || undefined;
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, value: heading[2] });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quoteLines = [line.replace(/^\s*>\s?/, "")];
      blocks.push({ kind: "quote", value: quoteLines });
      continue;
    }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === "unordered-list") (previous.value as string[]).push(unordered[1]);
      else blocks.push({ kind: "unordered-list", value: [unordered[1]] });
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === "ordered-list") (previous.value as string[]).push(ordered[1]);
      else blocks.push({ kind: "ordered-list", value: [ordered[1]] });
      continue;
    }
    paragraph.push(line);
  }

  if (code) blocks.push({ kind: "code-block", value: code.join("\n"), language: codeLanguage });
  flushParagraph();
  return blocks;
}

function appendTextChunk(parent: HTMLElement, value: string) {
  value.split("\n").forEach((part, line) => {
    if (line) parent.append(document.createElement("br"));
    if (part) parent.append(document.createTextNode(part));
  });
}

function appendText(parent: HTMLElement, value: string, options: MarkdownRenderOptions = {}) {
  const pattern = /@&([A-Za-z0-9_.-]+)|@([A-Za-z0-9_.-]+)/g;
  const roomPattern = /(^|[^A-Za-z0-9_.-])#([A-Za-z0-9_.-]+)/g;
  const customEmojiPattern = /:([A-Za-z0-9_+-]{1,32}):/g;
  let offset = 0;
  while (offset < value.length) {
    pattern.lastIndex = offset;
    roomPattern.lastIndex = offset;
    customEmojiPattern.lastIndex = offset;
    const mentionMatch = pattern.exec(value);
    const roomMatch = roomPattern.exec(value);
    let customEmojiMatch: RegExpExecArray | null = null;
    while (true) {
      const candidate = customEmojiPattern.exec(value);
      if (!candidate) break;
      if (options.customEmoji?.has(candidate[1].toLowerCase())) {
        customEmojiMatch = candidate;
        break;
      }
    }
    const mentionIndex = mentionMatch?.index ?? Number.POSITIVE_INFINITY;
    const roomIndex = roomMatch ? (roomMatch.index ?? offset) + roomMatch[1].length : Number.POSITIVE_INFINITY;
    const customEmojiIndex = customEmojiMatch
      ? customEmojiMatch.index ?? offset
      : Number.POSITIVE_INFINITY;
    if (customEmojiMatch && customEmojiIndex <= mentionIndex && customEmojiIndex <= roomIndex) {
      const asset = options.customEmoji?.get(customEmojiMatch[1].toLowerCase());
      if (asset) {
        appendTextChunk(parent, value.slice(offset, customEmojiIndex));
        const image = document.createElement("img");
        image.className = "custom-emoji inline-custom-emoji";
        image.src = asset.src;
        image.alt = asset.alt;
        image.title = `:${customEmojiMatch[1]}:`;
        image.draggable = false;
        parent.append(image);
        offset = customEmojiIndex + customEmojiMatch[0].length;
        continue;
      }
    }
    let emojiIndex = Number.POSITIVE_INFINITY;
    let emojiMatch: ReturnType<typeof emojiEntryAt> = undefined;
    for (let index = offset; index < value.length; index += Math.max(1, value.codePointAt(index)! > 0xffff ? 2 : 1)) {
      const candidate = emojiEntryAt(value, index);
      if (candidate) {
        emojiIndex = index;
        emojiMatch = candidate;
        break;
      }
    }
    if (emojiMatch && emojiIndex < mentionIndex && emojiIndex < roomIndex) {
      appendTextChunk(parent, value.slice(offset, emojiIndex));
      const image = document.createElement("img");
      image.className = "twemoji inline-twemoji";
      image.src = `/assets/twemoji/${emojiMatch.entry.code}.svg`;
      image.alt = emojiMatch.entry.emoji;
      image.title = `:${emojiMatch.entry.name}:`;
      image.draggable = false;
      parent.append(image);
      offset = emojiIndex + emojiMatch.text.length;
      continue;
    }
    if (mentionMatch && mentionIndex <= roomIndex) {
      const index = mentionMatch.index ?? offset;
      appendTextChunk(parent, value.slice(offset, index));
      const roleName = mentionMatch[1]?.toLowerCase();
      const username = mentionMatch[2]?.toLowerCase();
      if ((roleName && options.mentionRoleNames?.has(roleName)) || (username && options.mentionUsernames?.has(username))) {
        const mention = document.createElement("span");
        mention.className = roleName ? "role-mention" : "user-mention";
        mention.textContent = mentionMatch[0];
        parent.append(mention);
      } else {
        parent.append(document.createTextNode(mentionMatch[0]));
      }
      offset = index + mentionMatch[0].length;
      continue;
    }
    if (roomMatch) {
      const index = roomIndex;
      const slug = roomMatch[2].toLowerCase();
      const token = `#${roomMatch[2]}`;
      appendTextChunk(parent, value.slice(offset, index));
      const channelId = options.roomReferences?.get(slug);
      if (channelId && options.onRoomReference) {
        const room = document.createElement("button");
        room.type = "button";
        room.className = "room-reference";
        room.textContent = token;
        room.title = `Open ${token}`;
        room.setAttribute("aria-label", `Open ${token}`);
        room.addEventListener("click", () => options.onRoomReference?.(channelId));
        parent.append(room);
      } else {
        parent.append(document.createTextNode(token));
      }
      offset = index + token.length;
      continue;
    }
    appendTextChunk(parent, value.slice(offset));
    break;
  }
}

function appendInline(parent: HTMLElement, value: string, options: MarkdownRenderOptions = {}) {
  for (const token of parseInlineMarkdown(value)) {
    if (token.kind === "text") {
      appendText(parent, token.value, options);
      continue;
    }
    if (token.kind === "link") {
      const link = document.createElement("a");
      link.href = token.url;
      link.target = "_blank";
      link.rel = "noreferrer noopener nofollow";
      guardExternalLink(link, token.url);
      appendText(link, token.label, options);
      parent.append(link);
      continue;
    }
    if (token.kind === "spoiler") {
      const spoiler = document.createElement("span");
      spoiler.className = "spoiler";
      spoiler.tabIndex = 0;
      spoiler.setAttribute("role", "button");
      spoiler.setAttribute("aria-label", "Reveal spoiler");
      appendText(spoiler, token.value, options);
      const reveal = () => {
        spoiler.classList.toggle("revealed");
        spoiler.setAttribute("aria-label", spoiler.classList.contains("revealed") ? "Hide spoiler" : "Reveal spoiler");
      };
      spoiler.addEventListener("click", reveal);
      spoiler.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          reveal();
        }
      });
      parent.append(spoiler);
      continue;
    }
    const element = document.createElement(token.kind === "strong" ? "strong" : token.kind === "emphasis" ? "em" : token.kind === "strike" ? "del" : "code");
    if (token.kind === "code") element.textContent = token.value;
    else appendText(element, token.value, options);
    parent.append(element);
  }
}

export function appendMarkdown(parent: HTMLElement, value: string, options: MarkdownRenderOptions = {}) {
  const markdown = document.createElement("div");
  markdown.className = "markdown-body";
  for (const block of parseMarkdown(value)) {
    if (block.kind === "code-block") {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (block.language) code.dataset.language = block.language;
      code.textContent = block.value;
      pre.append(code);
      markdown.append(pre);
      continue;
    }
    if (block.kind === "heading") {
      const heading = document.createElement(block.level && block.level <= 2 ? "h3" : "h4");
      appendInline(heading, block.value as string, options);
      markdown.append(heading);
      continue;
    }
    if (block.kind === "quote") {
      const quote = document.createElement("blockquote");
      appendInline(quote, (block.value as string[]).join("\n"), options);
      markdown.append(quote);
      continue;
    }
    if (block.kind === "unordered-list" || block.kind === "ordered-list") {
      const list = document.createElement(block.kind === "unordered-list" ? "ul" : "ol");
      for (const item of block.value as string[]) {
        const listItem = document.createElement("li");
         appendInline(listItem, item, options);
        list.append(listItem);
      }
      markdown.append(list);
      continue;
    }
    const paragraph = document.createElement("p");
    appendInline(paragraph, block.value as string, options);
    markdown.append(paragraph);
  }
  parent.append(markdown);
  return markdown;
}
