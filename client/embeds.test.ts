import { describe, expect, test } from "bun:test";
import { extractEmbeds, parseSafeEmbed } from "./embeds";

describe("safe embeds", () => {
  test("normalizes supported YouTube URLs to the privacy host", () => {
    const embed = parseSafeEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    expect(embed).toEqual({
      kind: "youtube",
      id: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    });
  });

  test("does not turn arbitrary URLs into embeds", () => {
    expect(parseSafeEmbed("https://example.com/status/123")).toBeNull();
    expect(parseSafeEmbed("https://x.com.evil.example/status/123")).toBeNull();
    expect(parseSafeEmbed("javascript:alert(1)")).toBeNull();
  });

  test("extracts an X status ID for the official widget", () => {
    expect(parseSafeEmbed("https://x.com/example/status/123")).toEqual({
      kind: "social",
      network: "x",
      url: "https://x.com/example/status/123",
      statusId: "123",
    });
  });

  test("extracts at most four allowlisted previews", () => {
    const embeds = extractEmbeds([
      "https://youtu.be/dQw4w9WgXcQ",
      "https://x.com/example/status/123",
      "https://twitter.com/example/status/456",
      "https://www.youtube.com/shorts/9bZkp7q19f0",
      "https://www.youtube.com/watch?v=oHg5SJYRHA0",
    ].join(" "));

    expect(embeds).toHaveLength(4);
    expect(embeds.map((embed) => embed.kind)).toEqual(["youtube", "social", "social", "youtube"]);
  });
});
