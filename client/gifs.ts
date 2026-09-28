import type { GifProvider, GifProviderConfiguration, GifProviderId, GifSearchProviderId } from "./api";

export type GifLink = {
  provider: GifProviderId;
  id: string;
  url: string;
  title: string;
  embedUrl?: string;
  mediaUrl?: string;
};

export type GifSearchResult = {
  provider: GifSearchProviderId;
  id: string;
  title: string;
  previewUrl: string;
  mediaUrl: string;
  pageUrl: string;
  sizeBytes?: number;
};

type MediaFormat = { url: string; sizeBytes?: number };

const providerLabels: Record<GifProviderId, string> = {
  tenor: "Tenor",
  klipy: "Klipy",
  giphy: "GIPHY",
};
const gifSearchProviderIds = new Set<GifSearchProviderId>(["klipy", "giphy"]);
const responseLimit = 1_500_000;
let providerConfigRequest: Promise<GifProviderConfiguration> | undefined;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown, maxLength = 2_048) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function identifierValue(value: unknown) {
  if (typeof value === "string" && value.length > 0) return value.slice(0, 160);
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}

function isSearchProviderId(value: unknown): value is GifSearchProviderId {
  return typeof value === "string" && gifSearchProviderIds.has(value as GifSearchProviderId);
}

function safeHttpsUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

function providerHostMatches(provider: GifProviderId, host: string) {
  const normalized = host.toLowerCase();
  if (provider === "tenor") return normalized === "tenor.com" || normalized.endsWith(".tenor.com");
  if (provider === "klipy") {
    return normalized === "klipy.com" || normalized.endsWith(".klipy.com");
  }
  return normalized === "giphy.com" || normalized.endsWith(".giphy.com");
}

export function safeGifMediaUrl(provider: GifProviderId, value: unknown) {
  const url = safeHttpsUrl(value);
  return url && providerHostMatches(provider, url.hostname) ? url.toString() : undefined;
}

function safeGifPageUrl(provider: GifProviderId, value: unknown) {
  const url = safeHttpsUrl(value);
  return url && providerHostMatches(provider, url.hostname) ? url.toString() : undefined;
}

export function gifProviderLabel(provider: GifProviderId) {
  return providerLabels[provider];
}

export function parseGifLink(url: URL): GifLink | null {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  if (host === "tenor.com" || host === "www.tenor.com") {
    const shortGif = segments.length === 1 ? last.match(/^([A-Za-z0-9_-]{3,160})\.gif$/i) : null;
    if (shortGif) {
      const id = shortGif[1]!;
      const mediaUrl = `https://tenor.com/${encodeURIComponent(id)}.gif`;
      return { provider: "tenor", id, url: url.toString(), title: "Tenor GIF", mediaUrl };
    }
    if (segments[0]?.toLowerCase() !== "view") return null;
    const pageSlug = last.replace(/\.gif$/i, "");
    const id = pageSlug.match(/(?:^|-)(\d{3,})$/)?.[1];
    return id ? { provider: "tenor", id, url: url.toString(), title: "Tenor GIF", embedUrl: `https://tenor.com/embed/${id}` } : null;
  }
  if (host === "giphy.com" || host === "www.giphy.com") {
    if (segments[0]?.toLowerCase() !== "gifs") return null;
    const id = last.match(/(?:^|-)([A-Za-z0-9]{3,})$/)?.[1];
    return id ? { provider: "giphy", id, url: url.toString(), title: "GIPHY GIF", embedUrl: `https://giphy.com/embed/${id}` } : null;
  }
  if (host === "klipy.com" || host === "www.klipy.com") {
    if (!new Set(["gifs", "clips", "stickers", "ai-gifs"]).has(segments[0]?.toLowerCase() ?? "")) return null;
    const id = url.searchParams.get("id") ?? last;
    return id && /^[A-Za-z0-9-]{1,160}$/.test(id)
      ? { provider: "klipy", id, url: url.toString(), title: "Klipy GIF" }
      : null;
  }
  return null;
}

function normalizeProviderConfig(value: unknown): GifProviderConfiguration {
  const root = objectValue(value);
  const providers = Array.isArray(root?.providers)
    ? root.providers.flatMap((candidate) => {
      const provider = objectValue(candidate);
      if (!provider || !isSearchProviderId(provider.id) || typeof provider.apiKey !== "string" || provider.apiKey.length === 0 || provider.apiKey.length > 512) return [];
      return [{ id: provider.id, apiKey: provider.apiKey } satisfies GifProvider];
    })
    : [];
  const maxAttachmentBytes = numberValue(root?.maxAttachmentBytes);
  return {
    providers,
    maxAttachmentBytes: Math.min(100 * 1024 * 1024, Math.max(1, maxAttachmentBytes ?? 25 * 1024 * 1024)),
  };
}

export function loadGifProviderConfiguration() {
  if (!providerConfigRequest) {
    providerConfigRequest = fetch("/v1/gifs/providers", {
      credentials: "include",
      headers: { accept: "application/json" },
      cache: "no-store",
    }).then(async (response) => {
      if (!response.ok) throw new Error("gif_provider_configuration_unavailable");
      return normalizeProviderConfig(await response.json() as unknown);
    }).catch((error) => {
      providerConfigRequest = undefined;
      throw error;
    });
  }
  return providerConfigRequest;
}

async function readJson(url: URL, signal?: AbortSignal) {
  const response = await fetch(url, {
    credentials: "omit",
    headers: { accept: "application/json" },
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error(`gif_provider_request_failed_${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > responseLimit) throw new Error("gif_provider_response_too_large");
  const text = await response.text();
  if (text.length > responseLimit) throw new Error("gif_provider_response_too_large");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("invalid_gif_provider_response");
  }
}

function formatFromValue(provider: GifProviderId, value: unknown): MediaFormat | undefined {
  const format = objectValue(value);
  const url = safeGifMediaUrl(provider, format?.url);
  const sizeBytes = numberValue(format?.size);
  return url ? { url, ...(sizeBytes ? { sizeBytes } : {}) } : undefined;
}

function firstFormat(provider: GifProviderId, formats: Record<string, unknown> | null, names: string[]) {
  for (const name of names) {
    const format = formatFromValue(provider, formats?.[name]);
    if (format) return format;
  }
  return undefined;
}

function klipyResult(value: unknown, maxBytes: number): GifSearchResult | null {
  const result = objectValue(value);
  const id = identifierValue(result?.id) ?? stringValue(result?.slug, 160);
  const files = objectValue(result?.file);
  const format = (size: string) => formatFromValue("klipy", objectValue(files?.[size])?.gif);
  const candidates = [format("md"), format("hd"), format("sm"), format("xs")].filter((candidate): candidate is MediaFormat => candidate !== undefined);
  const media = candidates.find((candidate) => !candidate.sizeBytes || candidate.sizeBytes <= maxBytes) ?? candidates[0];
  const preview = format("xs") ?? format("sm") ?? format("md") ?? format("hd");
  if (!id || !media || !preview) return null;
  const title = stringValue(result?.title ?? result?.slug, 240) || "Klipy GIF";
  const slug = stringValue(result?.slug, 160);
  const pageUrl = safeGifPageUrl("klipy", result?.url ?? result?.itemurl)
    ?? (slug && /^[A-Za-z0-9-]+$/.test(slug) ? `https://klipy.com/gifs/${encodeURIComponent(slug)}` : undefined)
    ?? media.url;
  return {
    provider: "klipy",
    id,
    title,
    previewUrl: preview.url,
    mediaUrl: media.url,
    pageUrl,
    ...(media.sizeBytes ? { sizeBytes: media.sizeBytes } : {}),
  };
}

function giphyResult(value: unknown): GifSearchResult | null {
  const result = objectValue(value);
  const id = identifierValue(result?.id);
  const images = objectValue(result?.images);
  const media = firstFormat("giphy", images, ["downsized_medium", "fixed_height", "fixed_width", "original"]);
  const preview = firstFormat("giphy", images, ["fixed_height_small", "fixed_width_small", "fixed_height", "fixed_width", "original"]);
  if (!id || !media || !preview) return null;
  const title = stringValue(result?.title ?? result?.slug, 240) || "GIPHY GIF";
  const pageUrl = safeGifPageUrl("giphy", result?.url) ?? media.url;
  return {
    provider: "giphy",
    id,
    title,
    previewUrl: preview.url,
    mediaUrl: media.url,
    pageUrl,
    ...(media.sizeBytes ? { sizeBytes: media.sizeBytes } : {}),
  };
}

function resultFromPayload(provider: GifSearchProviderId, payload: unknown, maxBytes: number) {
  const root = objectValue(payload);
  if (provider === "giphy") {
    return Array.isArray(root?.data) ? root.data.map(giphyResult).filter((result): result is GifSearchResult => Boolean(result)) : [];
  }
  const data = objectValue(root?.data);
  const results = Array.isArray(data?.data) ? data.data : [];
  return results.map((result) => klipyResult(result, maxBytes)).filter((result): result is GifSearchResult => Boolean(result));
}

function searchUrl(provider: GifProvider, query: string) {
  if (provider.id === "giphy") {
    const url = new URL("https://api.giphy.com/v1/gifs/search");
    url.searchParams.set("api_key", provider.apiKey);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "24");
    url.searchParams.set("rating", "g");
    url.searchParams.set("bundle", "messaging_non_clips");
    return url;
  }
  const url = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(provider.apiKey)}/gifs/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", "24");
  url.searchParams.set("content_filter", "low");
  url.searchParams.set("format_filter", "gif");
  return url;
}

function trendingUrl(provider: GifProvider) {
  if (provider.id === "giphy") {
    const url = new URL("https://api.giphy.com/v1/gifs/trending");
    url.searchParams.set("api_key", provider.apiKey);
    url.searchParams.set("limit", "24");
    url.searchParams.set("rating", "g");
    url.searchParams.set("bundle", "messaging_non_clips");
    return url;
  }
  const url = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(provider.apiKey)}/gifs/trending`);
  url.searchParams.set("per_page", "24");
  url.searchParams.set("content_filter", "low");
  url.searchParams.set("format_filter", "gif");
  return url;
}

function postUrl(provider: GifProvider, id: string) {
  if (provider.id === "giphy") {
    const url = new URL(`https://api.giphy.com/v1/gifs/${encodeURIComponent(id)}`);
    url.searchParams.set("api_key", provider.apiKey);
    return url;
  }
  const url = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(provider.apiKey)}/gifs/items`);
  url.searchParams.set("slugs", id);
  return url;
}

export async function searchGifs(provider: GifProvider, query: string, signal?: AbortSignal, maxBytes = 25 * 1024 * 1024) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  return resultFromPayload(provider.id, await readJson(searchUrl(provider, normalizedQuery.slice(0, 100)), signal), maxBytes);
}

export async function trendingGifs(provider: GifProvider, signal?: AbortSignal, maxBytes = 25 * 1024 * 1024) {
  return resultFromPayload(provider.id, await readJson(trendingUrl(provider), signal), maxBytes);
}

export async function resolveGifLink(link: GifLink) {
  // Tenor's public API was discontinued. A pasted Tenor page still has its
  // provider-hosted iframe preview, but it must never trigger an API request.
  if (link.provider === "tenor") return undefined;
  const config = await loadGifProviderConfiguration();
  const provider = config.providers.find((candidate) => candidate.id === link.provider);
  if (!provider) return undefined;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4_000);
  try {
    const results = resultFromPayload(provider.id, await readJson(postUrl(provider, link.id), controller.signal), config.maxAttachmentBytes);
    const result = results.find((candidate) => candidate.id === link.id
      || candidate.pageUrl.endsWith(`/gifs/${encodeURIComponent(link.id)}`)) ?? results[0];
    return result ? { mediaUrl: result.mediaUrl, previewUrl: result.previewUrl } : undefined;
  } finally {
    window.clearTimeout(timeout);
  }
}
