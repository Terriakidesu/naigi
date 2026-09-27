import { describe, expect, test } from "bun:test";
import { extractEmbeds, normalizeStoredEmbeds, parseLinkMetadata, parseSafeEmbed } from "./embeds";

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

  test("creates a safe link card for every ordinary website", () => {
    expect(parseSafeEmbed("https://example.com/status/123")).toEqual({
      kind: "link",
      url: "https://example.com/status/123",
      title: "example.com",
    });
    expect(parseSafeEmbed("https://x.com.evil.example/status/123")).toMatchObject({ kind: "link" });
    expect(parseSafeEmbed("javascript:alert(1)")).toBeNull();
  });

  test("recognizes directly linked images and videos", () => {
    expect(parseSafeEmbed("https://cdn.example/image.webp?size=large")).toEqual({
      kind: "media",
      mediaType: "image",
      url: "https://cdn.example/image.webp?size=large",
    });
    expect(parseSafeEmbed("https://cdn.example/clip.mp4")).toEqual({
      kind: "media",
      mediaType: "video",
      url: "https://cdn.example/clip.mp4",
    });
  });

  test("recognizes X status URLs for legacy compatibility", () => {
    expect(parseSafeEmbed("https://x.com/example/status/123")).toEqual({
      kind: "social",
      network: "x",
      url: "https://x.com/example/status/123",
      statusId: "123",
    });
    expect(parseSafeEmbed("https://fixupx.com/i/status/123")).toMatchObject({ kind: "social", statusId: "123" });
    expect(parseSafeEmbed("https://fxtwitter.com/example/status/123")).toMatchObject({ kind: "social", statusId: "123" });
    expect(parseSafeEmbed("https://vxtwitter.com/example/status/123")).toMatchObject({ kind: "social", statusId: "123" });
    expect(parseSafeEmbed("https://fixvx.com/example/status/123")).toMatchObject({ kind: "social", statusId: "123" });
    expect(parseSafeEmbed("https://x.com/example/status/1")).toEqual({
      kind: "link",
      url: "https://x.com/example/status/1",
      title: "x.com",
    });
  });

  test("extracts at most four website previews", () => {
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

  test("uses Twitter image metadata before Open Graph fallback", () => {
    expect(parseLinkMetadata(
      '<meta property="og:title" content="Open Graph title"><meta name="twitter:image" content="/social-card.png"><title>Page title</title>',
      "https://example.com/articles/one",
    )).toEqual({
      title: "Open Graph title",
      imageUrl: "https://example.com/social-card.png",
    });
  });

  test("keeps stored link metadata while rejecting unsafe fields", () => {
    expect(normalizeStoredEmbeds([
      {
        kind: "link",
        url: "https://example.com/article",
        title: "Example article",
        imageUrl: "https://cdn.example/card.png",
      },
      {
        kind: "link",
        url: "https://example.com/unsafe",
        title: "&#x110000;",
        imageUrl: "javascript:alert(1)",
      },
    ])).toEqual([
      {
        kind: "link",
        url: "https://example.com/article",
        title: "Example article",
        imageUrl: "https://cdn.example/card.png",
      },
      {
        kind: "link",
        url: "https://example.com/unsafe",
        title: "example.com",
      },
    ]);
  });

  test("keeps encrypted X preview fields while rejecting unsafe media", () => {
    expect(normalizeStoredEmbeds([{
      kind: "social",
      url: "https://fixupx.com/example/status/123",
      text: "An encrypted preview",
      authorName: "Example",
      authorHandle: "example",
      media: [
        { type: "image", url: "https://pbs.twimg.com/media/image.jpg" },
        { type: "video", url: "https://evil.example/video.mp4" },
      ],
    }])).toEqual([{
      kind: "social",
      network: "x",
      url: "https://fixupx.com/example/status/123",
      statusId: "123",
      text: "An encrypted preview",
      authorName: "Example",
      authorHandle: "example",
      media: [{ type: "image", url: "https://pbs.twimg.com/media/image.jpg" }],
    }]);
  });

  test("restores YouTube players from legacy link cards", () => {
    expect(normalizeStoredEmbeds([{
      kind: "link",
      url: "https://youtu.be/dQw4w9WgXcQ",
      title: "YouTube",
      imageUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    }])).toEqual([{
      kind: "youtube",
      id: "dQw4w9WgXcQ",
      url: "https://youtu.be/dQw4w9WgXcQ",
      embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    }]);
  });
});
