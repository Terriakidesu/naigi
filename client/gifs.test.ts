import { afterEach, describe, expect, test } from "bun:test";
import { parseGifLink, resolveGifLink, searchGifs, trendingGifs } from "./gifs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GIF providers", () => {
  test("searches Klipy through its native GIF API and normalizes native results", async () => {
    let requestUrl: URL | undefined;
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (input: RequestInfo | URL): Promise<Response> => {
      requestUrl = new URL(input instanceof Request ? input.url : String(input));
      return Response.json({
        result: true,
        data: {
          data: [{
            id: 123,
            slug: "hello-hi-123",
            title: "Hello",
            file: {
              hd: { gif: { url: "https://static.klipy.com/ii/test/hd.gif", size: 5_000 } },
              md: { gif: { url: "https://static.klipy.com/ii/test/md.gif", size: 500 } },
              xs: { gif: { url: "https://static.klipy.com/ii/test/xs.gif", size: 50 } },
            },
          }],
        },
      });
    } });

    const results = await searchGifs({ id: "klipy", apiKey: "browser-key" }, "hello wave", undefined, 1_000);
    expect(requestUrl?.origin).toBe("https://api.klipy.com");
    expect(requestUrl?.pathname).toBe("/api/v1/browser-key/gifs/search");
    expect(requestUrl?.searchParams.get("q")).toBe("hello wave");
    expect(requestUrl?.searchParams.get("per_page")).toBe("24");
    expect(requestUrl?.searchParams.get("format_filter")).toBe("gif");
    expect(results).toEqual([{
      provider: "klipy",
      id: "123",
      title: "Hello",
      previewUrl: "https://static.klipy.com/ii/test/xs.gif",
      mediaUrl: "https://static.klipy.com/ii/test/md.gif",
      pageUrl: "https://klipy.com/gifs/hello-hi-123",
      sizeBytes: 500,
    }]);
  });

  test("loads Klipy trending GIFs on the native trending endpoint", async () => {
    let requestUrl: URL | undefined;
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (input: RequestInfo | URL): Promise<Response> => {
      requestUrl = new URL(input instanceof Request ? input.url : String(input));
      return Response.json({
        result: true,
        data: { data: [{
          id: 456,
          slug: "trending-wave-456",
          title: "Trending wave",
          file: {
            xs: { gif: { url: "https://static.klipy.com/ii/trending/preview.gif", size: 100 } },
            md: { gif: { url: "https://static.klipy.com/ii/trending/full.gif", size: 500 } },
          },
        }] },
      });
    } });

    const results = await trendingGifs({ id: "klipy", apiKey: "browser-key" }, undefined, 1_000);
    expect(requestUrl?.pathname).toBe("/api/v1/browser-key/gifs/trending");
    expect(requestUrl?.searchParams.get("per_page")).toBe("24");
    expect(requestUrl?.searchParams.get("content_filter")).toBe("low");
    expect(requestUrl?.searchParams.get("format_filter")).toBe("gif");
    expect(results[0]).toMatchObject({
      provider: "klipy",
      id: "456",
      title: "Trending wave",
      previewUrl: "https://static.klipy.com/ii/trending/preview.gif",
      mediaUrl: "https://static.klipy.com/ii/trending/full.gif",
    });
  });

  test("loads GIPHY trending results with the configured content filters", async () => {
    let requestUrl: URL | undefined;
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (input: RequestInfo | URL): Promise<Response> => {
      requestUrl = new URL(input instanceof Request ? input.url : String(input));
      return Response.json({
        data: [{
          id: "giphy-trend-1",
          title: "Trending GIPHY",
          url: "https://giphy.com/gifs/giphy-trend-1",
          images: {
            downsized_medium: { url: "https://media.giphy.com/media/trend/full.gif", size: "500" },
            fixed_height_small: { url: "https://media.giphy.com/media/trend/preview.gif", size: "100" },
          },
        }],
      });
    } });

    const results = await trendingGifs({ id: "giphy", apiKey: "browser-key" });
    expect(requestUrl?.pathname).toBe("/v1/gifs/trending");
    expect(requestUrl?.searchParams.get("api_key")).toBe("browser-key");
    expect(requestUrl?.searchParams.get("limit")).toBe("24");
    expect(requestUrl?.searchParams.get("rating")).toBe("g");
    expect(requestUrl?.searchParams.get("bundle")).toBe("messaging_non_clips");
    expect(results[0]).toMatchObject({
      provider: "giphy",
      id: "giphy-trend-1",
      title: "Trending GIPHY",
      previewUrl: "https://media.giphy.com/media/trend/preview.gif",
      mediaUrl: "https://media.giphy.com/media/trend/full.gif",
    });
  });

  test("parses Klipy slugs and keeps Tenor links away from all provider APIs", async () => {
    expect(parseGifLink(new URL("https://klipy.com/gifs/hello-hi-123"))).toMatchObject({
      provider: "klipy",
      id: "hello-hi-123",
    });

    let requests = 0;
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (): Promise<Response> => {
      requests += 1;
      return Response.json({});
    } });
    const shortTenorLink = parseGifLink(new URL("https://tenor.com/uzlAQImG5tJ.gif"));
    expect(shortTenorLink).toMatchObject({
      provider: "tenor",
      id: "uzlAQImG5tJ",
      mediaUrl: "https://tenor.com/uzlAQImG5tJ.gif",
    });
    await expect(resolveGifLink(shortTenorLink!)).resolves.toBeUndefined();
    await expect(resolveGifLink({
      provider: "tenor",
      id: "123456789",
      url: "https://tenor.com/view/example-123456789",
      title: "Tenor GIF",
      embedUrl: "https://tenor.com/embed/123456789",
    })).resolves.toBeUndefined();
    expect(requests).toBe(0);
  });
});
