import { expect, test } from "bun:test";
import { normalizeTwitterProviderResponse, parseTwitterStatusUrl } from "./twitter-preview";

test("normalizes original and rewritten Twitter status URLs", () => {
  expect(parseTwitterStatusUrl("https://x.com/example/status/1234567890?utm_source=test")).toEqual({
    id: "1234567890",
    canonicalUrl: "https://x.com/i/status/1234567890",
  });
  expect(parseTwitterStatusUrl("https://fixupx.com/i/status/1234567890")).toEqual({
    id: "1234567890",
    canonicalUrl: "https://x.com/i/status/1234567890",
  });
  expect(parseTwitterStatusUrl("https://twitter.example/status/1234567890")).toBeNull();
  expect(parseTwitterStatusUrl("https://x.com/user/status/1")).toBeNull();
  expect(parseTwitterStatusUrl("https://x.com/user/status/12345678901234567890/photo/1")).toEqual({
    id: "12345678901234567890",
    canonicalUrl: "https://x.com/i/status/12345678901234567890",
  });
  expect(parseTwitterStatusUrl("https://x.com@evil.example/user/status/1234567890")).toBeNull();
});

test("normalizes syndication media fields", () => {
  expect(normalizeTwitterProviderResponse({
    id_str: "1234567890",
    text: "Syndicated post",
    user: {
      name: "Syndicated User",
      screen_name: "syndicated",
      profile_image_url_https: "https://pbs.twimg.com/profile_images/avatar.jpg",
    },
    mediaDetails: [
      { type: "photo", media_url_https: "https://pbs.twimg.com/media/photo.jpg" },
      {
        type: "video",
        media_url_https: "https://pbs.twimg.com/media/poster.jpg",
        video_info: {
          variants: [
            { content_type: "application/x-mpegURL", url: "https://video.twimg.com/ext.m3u8" },
            { content_type: "video/mp4", url: "https://video.twimg.com/ext.mp4", bitrate: 900 },
          ],
        },
      },
    ],
  }, "1234567890")).toMatchObject({
    id: "1234567890",
    text: "Syndicated post",
    authorName: "Syndicated User",
    authorHandle: "syndicated",
    media: [
      { type: "image", url: "https://pbs.twimg.com/media/photo.jpg" },
      { type: "video", url: "https://video.twimg.com/ext.mp4", thumbnailUrl: "https://pbs.twimg.com/media/poster.jpg" },
    ],
  });
});

test("normalizes provider text, author, and safe media", () => {
  expect(normalizeTwitterProviderResponse({
    code: 200,
    status: {
      id: "1234567890",
      text: "Hello from X",
      created_at: "2026-09-27T12:00:00.000Z",
      author: {
        name: "Example User",
        screen_name: "example",
        avatar_url: "https://pbs.twimg.com/profile_images/avatar.jpg",
      },
      media: {
        all: [
          { type: "photo", url: "https://pbs.twimg.com/media/card.jpg" },
          { type: "video", formats: [{ url: "https://video.twimg.com/ext.mp4", bitrate: 100 }], thumbnail_url: "https://pbs.twimg.com/media/poster.jpg" },
          { type: "photo", url: "https://evil.example/card.jpg" },
        ],
      },
    },
  }, "1234567890")).toEqual({
    id: "1234567890",
    text: "Hello from X",
    authorName: "Example User",
    authorHandle: "example",
    avatarUrl: "https://pbs.twimg.com/profile_images/avatar.jpg",
    createdAt: "2026-09-27T12:00:00.000Z",
    media: [
      { type: "image", url: "https://pbs.twimg.com/media/card.jpg" },
      { type: "video", url: "https://video.twimg.com/ext.mp4", thumbnailUrl: "https://pbs.twimg.com/media/poster.jpg" },
    ],
  });
});
