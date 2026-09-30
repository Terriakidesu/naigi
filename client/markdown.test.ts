import { expect, test } from "bun:test";
import { parseInlineMarkdown, parseMarkdown } from "./markdown";

test("markdown parser keeps supported formatting as safe tokens", () => {
  expect(parseInlineMarkdown("**bold** *italic* ~~gone~~ `code` [site](https://example.com)")).toEqual([
    { kind: "strong", value: "bold" },
    { kind: "text", value: " " },
    { kind: "emphasis", value: "italic" },
    { kind: "text", value: " " },
    { kind: "strike", value: "gone" },
    { kind: "text", value: " " },
    { kind: "code", value: "code" },
    { kind: "text", value: " " },
    { kind: "link", label: "site", url: "https://example.com/" },
  ]);
});

test("markdown parser keeps adjacent custom emoji shortcodes intact", () => {
  expect(parseInlineMarkdown(":raora_laugh::raora_laugh:")).toEqual([
    { kind: "text", value: ":raora_laugh::raora_laugh:" },
  ]);
});

test("markdown parser does not allow unsafe links", () => {
  expect(parseInlineMarkdown("[bad](javascript:alert(1))")).toEqual([
    { kind: "text", value: "[bad](javascript:alert(1))" },
  ]);
});

test("markdown parser recognizes spoilers without exposing their contents as formatting", () => {
  expect(parseInlineMarkdown("before ||secret text|| after")).toEqual([
    { kind: "text", value: "before " },
    { kind: "spoiler", value: "secret text" },
    { kind: "text", value: " after" },
  ]);
});

test("markdown parser supports code, quotes, lists, and paragraphs", () => {
  expect(parseMarkdown("> quote\n\n- one\n- two\n\n```ts\nconst x = 1;\n```")).toEqual([
    { kind: "quote", value: ["quote"] },
    { kind: "unordered-list", value: ["one", "two"] },
    { kind: "code-block", value: "const x = 1;", language: "ts" },
  ]);
});
