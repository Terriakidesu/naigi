import { emojiEntryAt } from "./emoji";
import { iconElement, renderIcons } from "./icons";
import type { RoomMessageReference } from "./room-message-link";
import { guardExternalLink } from "./external-link";
import { formatMessageMacro, messageMacroTooltip, MAX_MESSAGE_MACROS, parseMessageMacro, type ParsedMessageMacro } from "./message-macros";

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
  hideBareLinks?: ReadonlySet<string>;
  onRoomReference?: (channelId: string) => void;
  resolveMessageLink?: (url: string) => RoomMessageReference | undefined;
  onMessageReference?: (reference: RoomMessageReference) => void;
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
  const pattern = /(:[A-Za-z0-9_+-]{1,32}:)|(\*\*|__)(.+?)\2|(\*|_)([^*_\n]+?)\4|~~([^~\n]+?)~~|\|\|([^|\n]+?)\|\||`([^`\n]+)`|\[([^\]\n]+)\]\((\S+?)\)|((?:https?:\/\/)[^\s<]+)/gi;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? offset;
    pushText(tokens, value.slice(offset, index));
    if (match[1] !== undefined) pushText(tokens, match[1]);
    else if (match[3] !== undefined) tokens.push({ kind: "strong", value: match[3] });
    else if (match[5] !== undefined) tokens.push({ kind: "emphasis", value: match[5] });
    else if (match[6] !== undefined) tokens.push({ kind: "strike", value: match[6] });
    else if (match[7] !== undefined) tokens.push({ kind: "spoiler", value: match[7] });
    else if (match[8] !== undefined) tokens.push({ kind: "code", value: match[8] });
    else if (match[9] !== undefined && match[10] !== undefined) {
      const url = safeLinkUrl(match[10].replace(/[),.!?:;]+$/g, ""));
      if (url) tokens.push({ kind: "link", label: match[9], url });
      else pushText(tokens, match[0]);
    } else if (match[11] !== undefined) {
      const raw = match[11].replace(/[),.!?:;]+$/g, "");
      const url = safeLinkUrl(raw);
      if (url) {
        tokens.push({ kind: "link", label: raw, url });
        pushText(tokens, match[11].slice(raw.length));
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

type MessageMacroRenderState = { count: number };

function isEscaped(value: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isInsideUrl(value: string, index: number) {
  return /https?:\/\/[^\s<>]*$/i.test(value.slice(0, index));
}

function appendMessageMacro(parent: HTMLElement, macro: ParsedMessageMacro, state: MessageMacroRenderState) {
  const element = document.createElement("time");
  element.className = "message-macro";
  element.dateTime = new Date(macro.timestampMs).toISOString();
  element.title = messageMacroTooltip(macro.timestampMs);
  element.tabIndex = 0;
  element.setAttribute("aria-label", `${formatMessageMacro(macro)} · ${element.title}`);
  element.textContent = formatMessageMacro(macro);
  element.dataset.messageMacro = "true";
  element.dataset.timestampMs = String(macro.timestampMs);
  element.dataset.macroFormat = macro.format;
  parent.append(element);
  state.count += 1;
}

function appendText(parent: HTMLElement, value: string, options: MarkdownRenderOptions = {}, macroState: MessageMacroRenderState = { count: 0 }, allowMacros = true) {
  const pattern = /@&([A-Za-z0-9_.-]+)|@([A-Za-z0-9_.-]+)/g;
  const roomPattern = /(^|[^A-Za-z0-9_.-])#([A-Za-z0-9_.-]+)/g;
  const customEmojiPattern = /:([A-Za-z0-9_+-]{1,32}):/g;
  const macroPattern = /\{[a-z][a-z0-9_-]*(?::[^{}\n]*)?\}/gi;
  let offset = 0;
  while (offset < value.length) {
    pattern.lastIndex = offset;
    roomPattern.lastIndex = offset;
    customEmojiPattern.lastIndex = offset;
    macroPattern.lastIndex = offset;
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
    let macroMatch: RegExpExecArray | null = null;
    if (allowMacros && macroState.count < MAX_MESSAGE_MACROS) {
      while (true) {
        const candidate = macroPattern.exec(value);
        if (!candidate) break;
        if (isEscaped(value, candidate.index) || isInsideUrl(value, candidate.index)) continue;
        if (parseMessageMacro(candidate[0])) {
          macroMatch = candidate;
          break;
        }
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
    const mentionIndex = mentionMatch?.index ?? Number.POSITIVE_INFINITY;
    const roomIndex = roomMatch ? (roomMatch.index ?? offset) + roomMatch[1].length : Number.POSITIVE_INFINITY;
    const macroIndex = macroMatch?.index ?? Number.POSITIVE_INFINITY;
    const customEmojiIndex = customEmojiMatch
      ? customEmojiMatch.index ?? offset
      : Number.POSITIVE_INFINITY;
    const nextIndex = Math.min(macroIndex, customEmojiIndex, emojiIndex, mentionIndex, roomIndex);
    if (!Number.isFinite(nextIndex)) {
      appendTextChunk(parent, value.slice(offset));
      break;
    }
    appendTextChunk(parent, value.slice(offset, nextIndex));
    if (macroMatch && macroIndex === nextIndex) {
      const macro = parseMessageMacro(macroMatch[0]);
      if (macro) appendMessageMacro(parent, macro, macroState);
      offset = macroIndex + macroMatch[0].length;
      continue;
    }
    if (customEmojiMatch && customEmojiIndex === nextIndex) {
      const asset = options.customEmoji?.get(customEmojiMatch[1].toLowerCase());
      if (asset) {
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
    if (emojiMatch && emojiIndex === nextIndex) {
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
    if (mentionMatch && mentionIndex === nextIndex) {
      const index = mentionMatch.index ?? offset;
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
    if (roomMatch && roomIndex === nextIndex) {
      const index = roomIndex;
      const slug = roomMatch[2].toLowerCase();
      const token = `#${roomMatch[2]}`;
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

function appendInline(parent: HTMLElement, value: string, options: MarkdownRenderOptions = {}, macroState: MessageMacroRenderState = { count: 0 }) {
  for (const token of parseInlineMarkdown(value)) {
    if (token.kind === "text") {
      appendText(parent, token.value, options, macroState);
      continue;
    }
    if (token.kind === "link") {
      const reference = options.resolveMessageLink?.(token.url);
      if (reference) {
        const link = document.createElement("a");
        link.className = "room-reference room-message-reference";
        link.href = reference.href;
        link.setAttribute("aria-label", `Jump to message in ${reference.name}`);
        link.title = `Jump to message in ${reference.name}`;
        const roomIcon = iconElement(reference.kind === "voice" ? "headphones" : "hash");
        const name = document.createElement("span");
        name.textContent = reference.name;
        link.append(roomIcon, name, iconElement("arrow-right"), iconElement("message-square"));
        if (options.onMessageReference) link.addEventListener("click", (event) => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          options.onMessageReference?.(reference);
        });
        parent.append(link);
        renderIcons(link);
        continue;
      }
      if (token.label === token.url && options.hideBareLinks?.has(token.url)) continue;
      const link = document.createElement("a");
      link.href = token.url;
      link.target = "_blank";
      link.rel = "noreferrer noopener nofollow";
      guardExternalLink(link, token.url);
      appendText(link, token.label, options, macroState, false);
      parent.append(link);
      continue;
    }
    if (token.kind === "spoiler") {
      const spoiler = document.createElement("span");
      spoiler.className = "spoiler";
      spoiler.tabIndex = 0;
      spoiler.setAttribute("role", "button");
      spoiler.setAttribute("aria-label", "Reveal spoiler");
      appendText(spoiler, token.value, options, macroState);
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
    else appendText(element, token.value, options, macroState);
    parent.append(element);
  }
}

export function appendMarkdown(parent: HTMLElement, value: string, options: MarkdownRenderOptions = {}) {
  const markdown = document.createElement("div");
  markdown.className = "markdown-body";
  const macroState: MessageMacroRenderState = { count: 0 };
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
      appendInline(heading, block.value as string, options, macroState);
      markdown.append(heading);
      continue;
    }
    if (block.kind === "quote") {
      const quote = document.createElement("blockquote");
      appendInline(quote, (block.value as string[]).join("\n"), options, macroState);
      markdown.append(quote);
      continue;
    }
    if (block.kind === "unordered-list" || block.kind === "ordered-list") {
      const list = document.createElement(block.kind === "unordered-list" ? "ul" : "ol");
      for (const item of block.value as string[]) {
        const listItem = document.createElement("li");
        appendInline(listItem, item, options, macroState);
        list.append(listItem);
      }
      markdown.append(list);
      continue;
    }
    const paragraph = document.createElement("p");
    appendInline(paragraph, block.value as string, options, macroState);
    markdown.append(paragraph);
  }
  parent.append(markdown);
  return markdown;
}
