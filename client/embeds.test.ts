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

  test("recognizes GIF provider page links without relying on the retired Tenor API", () => {
    expect(parseSafeEmbed("https://tenor.com/view/celebrate-party-gif-123456789")).toEqual({
      kind: "gif",
      provider: "tenor",
      id: "123456789",
      url: "https://tenor.com/view/celebrate-party-gif-123456789",
      title: "Tenor GIF",
      embedUrl: "https://tenor.com/embed/123456789",
    });
    expect(parseSafeEmbed("https://tenor.com/uzlAQImG5tJ.gif")).toEqual({
      kind: "gif",
      provider: "tenor",
      id: "uzlAQImG5tJ",
      url: "https://tenor.com/uzlAQImG5tJ.gif",
      title: "Tenor GIF",
      mediaUrl: "https://tenor.com/uzlAQImG5tJ.gif",
    });
    expect(parseSafeEmbed("https://tenor.com/view/celebrate-party-gif-123456789.gif")).toEqual({
      kind: "gif",
      provider: "tenor",
      id: "123456789",
      url: "https://tenor.com/view/celebrate-party-gif-123456789.gif",
      title: "Tenor GIF",
      embedUrl: "https://tenor.com/embed/123456789",
    });
    expect(parseSafeEmbed("https://giphy.com/gifs/example-abcDEF123")).toEqual({
      kind: "gif",
      provider: "giphy",
      id: "abcDEF123",
      url: "https://giphy.com/gifs/example-abcDEF123",
      title: "GIPHY GIF",
      embedUrl: "https://giphy.com/embed/abcDEF123",
    });
    expect(parseSafeEmbed("https://klipy.com/gifs/join-us-5")).toEqual({
      kind: "gif",
      provider: "klipy",
      id: "join-us-5",
      url: "https://klipy.com/gifs/join-us-5",
      title: "Klipy GIF",
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

  test("keeps provider-hosted GIF media in encrypted preview metadata only", () => {
    expect(normalizeStoredEmbeds([{
      kind: "gif",
      url: "https://klipy.com/gifs/join-us-5",
      mediaUrl: "https://static.klipy.com/ii/example/full.gif",
      previewUrl: "https://static.klipy.com/ii/example/preview.gif",
    }, {
      kind: "gif",
      url: "https://giphy.com/gifs/example-abcDEF123",
      mediaUrl: "https://evil.example/not-a-gif.gif",
      previewUrl: "javascript:alert(1)",
    }])).toEqual([{
      kind: "gif",
      provider: "klipy",
      id: "join-us-5",
      url: "https://klipy.com/gifs/join-us-5",
      title: "Klipy GIF",
      mediaUrl: "https://static.klipy.com/ii/example/full.gif",
      previewUrl: "https://static.klipy.com/ii/example/preview.gif",
    }, {
      kind: "gif",
      provider: "giphy",
      id: "abcDEF123",
      url: "https://giphy.com/gifs/example-abcDEF123",
      title: "GIPHY GIF",
      embedUrl: "https://giphy.com/embed/abcDEF123",
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
