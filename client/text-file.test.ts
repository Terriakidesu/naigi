import { describe, expect, test } from "bun:test";
import { isPlaintextAttachment, readTextPreview, textLanguage, textPreviewExcerpt } from "./text-file";

describe("plaintext attachments", () => {
  test("recognizes source, markdown, and text files", () => {
    expect(isPlaintextAttachment("main.ts", "application/octet-stream")).toBe(true);
    expect(isPlaintextAttachment("README.md", "application/octet-stream")).toBe(true);
    expect(isPlaintextAttachment("notes.txt", "text/plain")).toBe(true);
    expect(isPlaintextAttachment("photo.png", "image/png")).toBe(false);
  });

  test("derives a safe display language", () => {
    expect(textLanguage("app.ts", "application/octet-stream")).toBe("ts");
    expect(textLanguage("README", "text/markdown")).toBe("markdown");
    expect(textLanguage("payload", "application/json")).toBe("json");
    expect(textLanguage("script", "application/javascript")).toBe("javascript");
  });

  test("bounds previews without interpreting their contents", async () => {
    const result = await readTextPreview(new Blob(["<script>alert(1)</script>\nline two"]), 20);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("<script>");
    expect(result.text).toContain("Preview truncated");
  });

  test("creates a short line-aware excerpt and counts the remaining characters", () => {
    const result = textPreviewExcerpt("alpha\nbeta\ngamma", 8);
    expect(result).toEqual({ text: "alpha\n…", remainingCharacters: 10 });
    expect(textPreviewExcerpt("short text", 20)).toEqual({ text: "short text", remainingCharacters: 0 });
  });
});
