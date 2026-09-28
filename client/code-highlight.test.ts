import { describe, expect, test } from "bun:test";
import { tokenizeCode } from "./code-highlight";

describe("plaintext code highlighting", () => {
  test("highlights common source tokens without changing source text", () => {
    const source = 'const answer = 42;\n// keep this comment\nconsole.log("<script>");';
    const tokens = tokenizeCode(source, "ts");
    expect(tokens.map((token) => token.value).join("")).toBe(source);
    expect(tokens.some((token) => token.kind === "keyword" && token.value === "const")).toBe(true);
    expect(tokens.some((token) => token.kind === "number" && token.value === "42")).toBe(true);
    expect(tokens.some((token) => token.kind === "comment" && token.value.includes("keep this comment"))).toBe(true);
    expect(tokens.some((token) => token.kind === "function" && token.value === "log")).toBe(true);
    expect(tokens.some((token) => token.kind === "string" && token.value === '"<script>"')).toBe(true);
  });

  test("recognizes JSON properties and markup tags while preserving text", () => {
    const json = '{"name":"Naigi","active":true}';
    const jsonTokens = tokenizeCode(json, "json");
    expect(jsonTokens.map((token) => token.value).join("")).toBe(json);
    expect(jsonTokens.some((token) => token.kind === "property" && token.value === '"name"')).toBe(true);
    expect(jsonTokens.some((token) => token.kind === "literal" && token.value === "true")).toBe(true);

    const markup = '<a href="/room">plain text</a>';
    const markupTokens = tokenizeCode(markup, "html");
    expect(markupTokens.map((token) => token.value).join("")).toBe(markup);
    expect(markupTokens.some((token) => token.kind === "tag" && token.value === "<a")).toBe(true);
    expect(markupTokens.some((token) => token.kind === "attribute" && token.value === "href")).toBe(true);
    expect(markupTokens.some((token) => token.kind === "plain" && token.value === "plain text")).toBe(true);
  });

  test("keeps prose as plain text and marks added or removed diff lines", () => {
    expect(tokenizeCode("a plain note", "txt")).toEqual([{ kind: "plain", value: "a plain note" }]);
    const diff = "-old line\n+new line\n";
    const tokens = tokenizeCode(diff, "diff");
    expect(tokens.map((token) => token.value).join("")).toBe(diff);
    expect(tokens.map((token) => token.kind)).toEqual(["deletion", "addition"]);
  });
});
