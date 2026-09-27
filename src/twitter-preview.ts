import { config } from "./config";

export type TwitterPreviewMedia = {
  type: "image" | "video";
  url: string;
  thumbnailUrl?: string;
};

export type TwitterPreview = {
  id: string;
  text?: string;
  authorName?: string;
  authorHandle?: string;
  avatarUrl?: string;
  createdAt?: string;
  media: TwitterPreviewMedia[];
};

type ObjectValue = Record<string, unknown>;

const twitterHosts = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "fixupx.com",
  "www.fixupx.com",
  "fxtwitter.com",
  "www.fxtwitter.com",
  "vxtwitter.com",
  "www.vxtwitter.com",
  "fixvx.com",
  "www.fixvx.com",
]);
const twitterMediaHosts = new Set(["pbs.twimg.com", "video.twimg.com", "abs.twimg.com"]);
const statusPath = /^\/(?:[^/]+\/)?status\/(\d{2,20})(?:\/|$)/i;
const responseLimit = 2 * 1024 * 1024;

function objectValue(value: unknown): ObjectValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

function stringValue(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function identifierValue(value: unknown) {
  if (typeof value === "string" && /^\d{2,20}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 10) return String(value);
  return undefined;
}

function safeTwitterMediaUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (!twitterMediaHosts.has(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeAvatarUrl(value: unknown) {
  const url = safeTwitterMediaUrl(value);
  return url ?? undefined;
}

export function parseTwitterStatusUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port || !twitterHosts.has(url.hostname.toLowerCase())) return null;
  const match = url.pathname.match(statusPath);
  if (!match) return null;
  return {
    id: match[1],
    canonicalUrl: `https://x.com/i/status/${match[1]}`,
  };
}

function mediaFromProvider(value: unknown): TwitterPreviewMedia[] {
  const media = objectValue(value);
  const all = Array.isArray(value)
    ? value
    : media && Array.isArray(media.all)
      ? media.all
      : [
          ...(media && Array.isArray(media.photos) ? media.photos : []),
          ...(media && Array.isArray(media.videos) ? media.videos : []),
        ];
  const result: TwitterPreviewMedia[] = [];
  for (const item of all) {
    const entry = objectValue(item);
    if (!entry) continue;
    const type = stringValue(entry.type, 30)?.toLowerCase();
    const thumbnailUrl = safeTwitterMediaUrl(
      entry.thumbnail_url
      ?? entry.thumbnailUrl
      ?? entry.thumbnail
      ?? (type === "video" || type === "animated_gif" || type === "gif" ? entry.media_url_https : undefined),
    );
    if (type === "photo" || type === "image") {
      const imageUrl = safeTwitterMediaUrl(entry.url ?? entry.media_url_https ?? entry.media_url);
      if (imageUrl) result.push({ type: "image", url: imageUrl });
    } else if (type === "video" || type === "animated_gif" || type === "gif") {
      const videoInfo = objectValue(entry.video_info);
      const formats = [
        ...(Array.isArray(entry.formats) ? entry.formats : []),
        ...(videoInfo && Array.isArray(videoInfo.variants) ? videoInfo.variants : []),
      ];
      const videoUrls = formats
        .map((format) => objectValue(format))
        .filter((format): format is ObjectValue => Boolean(format))
        .map((format) => ({
          url: safeTwitterMediaUrl(format.url),
          bitrate: typeof format.bitrate === "number" ? format.bitrate : 0,
          contentType: stringValue(format.content_type ?? format.contentType, 80)?.toLowerCase(),
        }))
        .filter((format): format is { url: string; bitrate: number; contentType: string | undefined } => Boolean(format.url))
        .filter((format, _, formats) => formats.every((candidate) => !candidate.contentType?.includes("video/mp4")) || format.contentType?.includes("video/mp4"))
        .sort((left, right) => right.bitrate - left.bitrate);
      const videoUrl = safeTwitterMediaUrl(entry.url) ?? videoUrls[0]?.url;
      if (videoUrl) result.push({ ...(thumbnailUrl ? { thumbnailUrl } : {}), type: "video", url: videoUrl });
    }
    if (result.length === 4) break;
  }
  return result;
}

export function normalizeTwitterProviderResponse(value: unknown, id: string): TwitterPreview | null {
  const root = objectValue(value);
  if (!root || root.code !== undefined && root.code !== 200) return null;
  const status = objectValue(root.status) ?? root;
  const providerId = identifierValue(status.id ?? status.id_str);
  if (providerId && providerId !== id) return null;
  const author = objectValue(status.author) ?? objectValue(status.user);
  const legacy = objectValue(status.legacy);
  const textValue = objectValue(status.raw_text)?.text ?? status.text ?? status.full_text ?? legacy?.full_text;
  const text = stringValue(textValue, 12_000);
  const authorName = stringValue(author?.name, 160);
  const authorHandle = stringValue(author?.screen_name ?? author?.username, 80);
  const avatarUrl = safeAvatarUrl(author?.avatar_url ?? author?.profile_image_url_https);
  const createdAt = stringValue(status.created_at, 100);
  const media = [status.media, status.mediaDetails, status.photos]
    .map(mediaFromProvider)
    .find((candidate) => candidate.length > 0) ?? [];
  if (!text && !authorName && !authorHandle && !avatarUrl && !createdAt && media.length === 0) return null;
  return {
    id,
    ...(text ? { text } : {}),
    ...(authorName ? { authorName } : {}),
    ...(authorHandle ? { authorHandle } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(createdAt ? { createdAt } : {}),
    media,
  };
}

async function readResponseText(response: Response) {
  if (!response.body) {
    const text = await response.text();
    return text.length <= responseLimit ? text : null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let value = "";
  try {
    while (value.length <= responseLimit) {
      const chunk = await reader.read();
      if (chunk.done) {
        value += decoder.decode();
        return value.length <= responseLimit ? value : null;
      }
      value += decoder.decode(chunk.value, { stream: true });
      if (value.length > responseLimit) {
        await reader.cancel();
        return null;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return null;
}

async function responseJson(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > responseLimit) return null;
    const text = await readResponseText(response);
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFxEmbed(id: string) {
  const base = new URL(config.twitterPreviewApiUrl);
  base.pathname = `${base.pathname.replace(/\/$/, "")}/${id}`;
  base.searchParams.set("lang", "en");
  return responseJson(base.toString());
}

async function fetchSyndication(id: string) {
  const url = new URL("https://cdn.syndication.twimg.com/tweet-result");
  url.searchParams.set("id", id);
  url.searchParams.set("lang", "en");
  return responseJson(url.toString());
}

export async function fetchTwitterPreview(id: string) {
  const providers = {
    fx: fetchFxEmbed,
    syndication: fetchSyndication,
  } as const;
  for (const providerName of config.twitterPreviewProviders) {
    const provider = providers[providerName];
    const response = await provider(id);
    const preview = response ? normalizeTwitterProviderResponse(response, id) : null;
    if (preview) return preview;
  }
  return null;
}
