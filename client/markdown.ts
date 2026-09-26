export type MarkdownInline =
  | { kind: "text"; value: string }
  | { kind: "strong" | "emphasis" | "strike" | "code"; value: string }
  | { kind: "link"; label: string; url: string };

export type MarkdownBlock =
  | { kind: "paragraph" | "heading" | "quote" | "unordered-list" | "ordered-list"; value: string | string[]; level?: number }
  | { kind: "code-block"; value: string; language?: string };

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
  const pattern = /(\*\*|__)(.+?)\1|(\*|_)([^*_\n]+?)\3|~~([^~\n]+?)~~|`([^`\n]+)`|\[([^\]\n]+)\]\((\S+?)\)|((?:https?:\/\/)[^\s<]+)/gi;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? offset;
    pushText(tokens, value.slice(offset, index));
    if (match[2] !== undefined) tokens.push({ kind: "strong", value: match[2] });
    else if (match[4] !== undefined) tokens.push({ kind: "emphasis", value: match[4] });
    else if (match[5] !== undefined) tokens.push({ kind: "strike", value: match[5] });
    else if (match[6] !== undefined) tokens.push({ kind: "code", value: match[6] });
    else if (match[7] !== undefined && match[8] !== undefined) {
      const url = safeLinkUrl(match[8].replace(/[),.!?:;]+$/g, ""));
      if (url) tokens.push({ kind: "link", label: match[7], url });
      else pushText(tokens, match[0]);
    } else if (match[9] !== undefined) {
      const raw = match[9].replace(/[),.!?:;]+$/g, "");
      const url = safeLinkUrl(raw);
      if (url) {
        tokens.push({ kind: "link", label: raw, url });
        pushText(tokens, match[9].slice(raw.length));
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

function appendInline(parent: HTMLElement, value: string) {
  for (const token of parseInlineMarkdown(value)) {
    if (token.kind === "text") {
      const text = token.value.split("\n");
      text.forEach((part, index) => {
        if (index) parent.append(document.createElement("br"));
        parent.append(document.createTextNode(part));
      });
      continue;
    }
    if (token.kind === "link") {
      const link = document.createElement("a");
      link.href = token.url;
      link.target = "_blank";
      link.rel = "noreferrer noopener nofollow";
      link.textContent = token.label;
      parent.append(link);
      continue;
    }
    const element = document.createElement(token.kind === "strong" ? "strong" : token.kind === "emphasis" ? "em" : token.kind === "strike" ? "del" : "code");
    element.textContent = token.value;
    parent.append(element);
  }
}

export function appendMarkdown(parent: HTMLElement, value: string) {
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
      appendInline(heading, block.value as string);
      markdown.append(heading);
      continue;
    }
    if (block.kind === "quote") {
      const quote = document.createElement("blockquote");
      appendInline(quote, (block.value as string[]).join("\n"));
      markdown.append(quote);
      continue;
    }
    if (block.kind === "unordered-list" || block.kind === "ordered-list") {
      const list = document.createElement(block.kind === "unordered-list" ? "ul" : "ol");
      for (const item of block.value as string[]) {
        const listItem = document.createElement("li");
        appendInline(listItem, item);
        list.append(listItem);
      }
      markdown.append(list);
      continue;
    }
    const paragraph = document.createElement("p");
    appendInline(paragraph, block.value as string);
    markdown.append(paragraph);
  }
  parent.append(markdown);
  return markdown;
}
