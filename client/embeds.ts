import { confirmExternalLink, confirmExternalMedia, guardExternalLink } from "./external-link";
import type { TwitterPreview } from "./api";
import { gifProviderLabel, parseGifLink, resolveGifLink, safeGifMediaUrl, type GifLink } from "./gifs";

export type SafeEmbed =
  | { kind: "youtube"; id: string; url: string; embedUrl: string }
  | ({ kind: "social"; network: "x"; url: string; statusId: string } & Partial<TwitterPreview>)
  | ({ kind: "gif" } & GifLink & { mediaUrl?: string; previewUrl?: string })
  | { kind: "media"; mediaType: "image" | "video"; url: string }
  | { kind: "link"; url: string; title: string; imageUrl?: string };

export type LinkMetadata = {
  title?: string;
  imageUrl?: string;
};

const youtubeId = /^[A-Za-z0-9_-]{11}$/;
const statusPath = /^\/(?:[^/]+\/)?status\/(\d{2,20})(?:\/|$)/i;
const imageExtension = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const videoExtension = /\.(?:m4v|mov|mp4|ogv|webm)$/i;
const metadataLimit = 1_000_000;
const linkMetadataCache = new Map<string, Promise<LinkMetadata>>();
const twitterPreviewCache = new Map<string, Promise<TwitterPreview | null>>();
const twitterMediaHosts = new Set(["pbs.twimg.com", "video.twimg.com", "abs.twimg.com"]);
const twitterStatusHosts = new Set([
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

function cleanUrl(value: string) {
  return value.replace(/[),.!?:;]+$/g, "");
}

function safeHttpUrl(value: string, base?: string) {
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  return url;
}

function siteTitle(url: URL) {
  return url.hostname.replace(/^www\./i, "") || url.hostname;
}

function directMediaType(url: URL): "image" | "video" | null {
  if (imageExtension.test(url.pathname)) return "image";
  if (videoExtension.test(url.pathname)) return "video";
  return null;
}

export function parseSafeEmbed(value: string): SafeEmbed | null {
  const url = safeHttpUrl(cleanUrl(value));
  if (!url) return null;

  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
    id = url.searchParams.get("v");
    const pathMatch = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/i);
    if (!id && pathMatch) id = pathMatch[1];
  } else if (host === "youtube-nocookie.com" || host === "www.youtube-nocookie.com") {
    const pathMatch = url.pathname.match(/^\/embed\/([^/]+)/i);
    id = pathMatch?.[1] ?? null;
  }

  if (id && youtubeId.test(id)) {
    return {
      kind: "youtube",
      id,
      url: url.toString(),
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
    };
  }

  if (twitterStatusHosts.has(host)) {
    const status = url.pathname.match(statusPath);
    if (status) return { kind: "social", network: "x", url: url.toString(), statusId: status[1] };
  }

  const gif = parseGifLink(url);
  if (gif) return { kind: "gif", ...gif };

  const mediaType = directMediaType(url);
  if (mediaType) return { kind: "media", mediaType, url: url.toString() };
  return { kind: "link", url: url.toString(), title: siteTitle(url) };
}

function asLinkEmbed(embed: SafeEmbed): Extract<SafeEmbed, { kind: "link" }> {
  if (embed.kind === "link") return embed;
  return { kind: "link", url: embed.url, title: siteTitle(new URL(embed.url)) };
}

export function extractEmbeds(text: string): SafeEmbed[] {
  const matches = text.match(/https?:\/\/[^\s<]+/gi) ?? [];
  const seen = new Set<string>();
  const embeds: SafeEmbed[] = [];
  for (const match of matches) {
    const parsed = parseSafeEmbed(match);
    if (!parsed) continue;
    const embed = parsed;
    if (seen.has(embed.url)) continue;
    seen.add(embed.url);
    embeds.push(embed);
    if (embeds.length === 4) break;
  }
  return embeds;
}

function storedText(value: unknown) {
  return typeof value === "string" ? cleanMetadataText(value) : undefined;
}

function safeTwitterUrl(value: unknown) {
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

function normalizeTwitterPreview(value: Record<string, unknown>) {
  const text = typeof value.text === "string" && value.text.trim() ? value.text.slice(0, 12_000) : undefined;
  const authorName = typeof value.authorName === "string" && value.authorName.trim() ? value.authorName.slice(0, 160) : undefined;
  const authorHandle = typeof value.authorHandle === "string" && value.authorHandle.trim() ? value.authorHandle.slice(0, 80) : undefined;
  const avatarUrl = safeTwitterUrl(value.avatarUrl);
  const createdAt = typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) ? value.createdAt.slice(0, 100) : undefined;
  const media = Array.isArray(value.media)
    ? value.media.slice(0, 4).flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const item = candidate as Record<string, unknown>;
      if (item.type !== "image" && item.type !== "video") return [];
      const url = safeTwitterUrl(item.url);
      if (!url) return [];
      const thumbnailUrl = safeTwitterUrl(item.thumbnailUrl);
      return [{ type: item.type, url, ...(thumbnailUrl ? { thumbnailUrl } : {}) } as { type: "image" | "video"; url: string; thumbnailUrl?: string }];
    })
    : [];
  return {
    ...(text ? { text } : {}),
    ...(authorName ? { authorName } : {}),
    ...(authorHandle ? { authorHandle } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(createdAt ? { createdAt } : {}),
    media,
  } satisfies Partial<TwitterPreview>;
}

export function normalizeStoredEmbeds(value: unknown): SafeEmbed[] {
  if (!Array.isArray(value)) return [];
  const embeds: SafeEmbed[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const stored = candidate as Record<string, unknown>;
    if (typeof stored.url !== "string") continue;
    const parsed = parseSafeEmbed(stored.url);
    if (!parsed) continue;
    if (stored.kind === "media" && parsed.kind === "media" && stored.mediaType === parsed.mediaType) {
      embeds.push(parsed);
    } else if (stored.kind === "social" && parsed.kind === "social") {
      embeds.push({ ...parsed, ...normalizeTwitterPreview(stored) });
    } else if (stored.kind === "gif" && parsed.kind === "gif") {
      const mediaUrl = safeGifMediaUrl(parsed.provider, stored.mediaUrl);
      const previewUrl = safeGifMediaUrl(parsed.provider, stored.previewUrl);
      embeds.push({
        ...parsed,
        ...(mediaUrl ? { mediaUrl } : {}),
        ...(previewUrl ? { previewUrl } : {}),
      });
    } else if (parsed.kind === "youtube" && (stored.kind === "youtube" || stored.kind === "link")) {
      embeds.push(parsed);
    } else if (parsed.kind === "gif" && stored.kind === "link") {
      embeds.push(parsed);
    } else if (stored.kind === "link" && parsed.kind === "social") {
      embeds.push({ ...parsed, ...normalizeTwitterPreview(stored) });
    } else if (stored.kind === "link" && parsed.kind === "link") {
      const link = asLinkEmbed(parsed);
      const image = typeof stored.imageUrl === "string" ? safeHttpUrl(stored.imageUrl) : null;
      embeds.push({
        ...link,
        ...(storedText(stored.title) ? { title: storedText(stored.title) } : {}),
        ...(image ? { imageUrl: image.toString() } : {}),
      });
    }
    if (embeds.length === 4) break;
  }
  return embeds;
}

function metadataAttribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match?.[1];
}

function decodeHtml(value: string) {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  const decodeCodePoint = (code: string, radix: number) => {
    const point = Number.parseInt(code, radix);
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => decodeCodePoint(code, 16))
    .replace(/&#(\d+);/g, (_, code: string) => decodeCodePoint(code, 10))
    .replace(/&([a-z]+);/gi, (_, name: string) => entities[name.toLowerCase()] ?? `&${name};`);
}

function cleanMetadataText(value: string | undefined) {
  if (!value) return undefined;
  const cleaned = decodeHtml(value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
  return cleaned ? cleaned.slice(0, 240) : undefined;
}

function metaContent(html: string, names: string[]) {
  const tags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
  for (const name of names) {
    for (const tag of tags) {
      const key = metadataAttribute(tag, "property") ?? metadataAttribute(tag, "name");
      const content = metadataAttribute(tag, "content");
      if (key?.toLowerCase() === name.toLowerCase() && content) return content;
    }
  }
  return undefined;
}

export function parseLinkMetadata(html: string, pageUrl: string): LinkMetadata {
  const page = safeHttpUrl(pageUrl);
  if (!page) return {};
  const title = cleanMetadataText(metaContent(html, ["og:title", "twitter:title"]))
    ?? cleanMetadataText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const rawImage = metaContent(html, ["twitter:image", "twitter:image:src", "og:image", "og:image:url"]);
  const image = rawImage ? safeHttpUrl(decodeHtml(rawImage.trim()), page.toString()) : null;
  return {
    ...(title ? { title } : {}),
    ...(image ? { imageUrl: image.toString() } : {}),
  };
}

async function readResponseText(response: Response) {
  if (!response.body) return (await response.text()).slice(0, metadataLimit);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let value = "";
  try {
    while (value.length < metadataLimit) {
      const chunk = await reader.read();
      if (chunk.done) {
        value += decoder.decode();
        break;
      }
      value += decoder.decode(chunk.value, { stream: true });
      if (value.length >= metadataLimit) await reader.cancel();
    }
  } finally {
    reader.releaseLock();
  }
  return value.slice(0, metadataLimit);
}

async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(url, {
      credentials: "omit",
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) return {};
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) return {};
    return parseLinkMetadata(await readResponseText(response), response.url || url);
  } catch {
    return {};
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function fetchTwitterPreview(url: string): Promise<TwitterPreview | null> {
  try {
    const response = await fetch("/v1/previews/twitter", {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { preview?: unknown };
    const preview = payload.preview && typeof payload.preview === "object" && !Array.isArray(payload.preview)
      ? normalizeTwitterPreview(payload.preview as Record<string, unknown>)
      : {};
    return Object.keys(preview).length > 0
      ? { id: "", media: [], ...preview }
      : null;
  } catch {
    return null;
  }
}

function loadLinkMetadata(url: string) {
  const cached = linkMetadataCache.get(url);
  if (cached) return cached;
  const request = fetchLinkMetadata(url);
  linkMetadataCache.set(url, request);
  if (linkMetadataCache.size > 100) linkMetadataCache.delete(linkMetadataCache.keys().next().value as string);
  return request;
}

function loadTwitterPreview(url: string) {
  const cached = twitterPreviewCache.get(url);
  if (cached) return cached;
  const request = fetchTwitterPreview(url);
  twitterPreviewCache.set(url, request);
  if (twitterPreviewCache.size > 100) twitterPreviewCache.delete(twitterPreviewCache.keys().next().value as string);
  return request;
}

export async function prepareEmbeds(text: string) {
  const embeds = extractEmbeds(text);
  return await Promise.all(embeds.map(async (embed) => {
    if (embed.kind === "social") {
      const preview = await loadTwitterPreview(embed.url);
      return preview ? { ...embed, ...preview, id: embed.statusId } : embed;
    }
    if (embed.kind === "gif") {
      try {
        const resolved = await resolveGifLink(embed);
        return resolved ? { ...embed, ...resolved } : embed;
      } catch {
        return embed;
      }
    }
    if (embed.kind !== "link") return embed;
    const metadata = await loadLinkMetadata(embed.url);
    return {
      ...embed,
      ...metadata,
    } satisfies Extract<SafeEmbed, { kind: "link" }>;
  }));
}

function createExternalAnchor(url: string, className?: string) {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer noopener nofollow";
  if (className) link.className = className;
  guardExternalLink(link, url);
  return link;
}

function appendMediaEmbed(
  parent: HTMLElement,
  embed: Extract<SafeEmbed, { kind: "media" }>,
  onOpenImage?: (url: string, title: string) => void,
) {
  const card = document.createElement("div");
  card.className = "embed-card embed-media-card";
  if (embed.mediaType === "image") {
    const image = document.createElement("img");
    image.className = "embed-media-image";
    image.src = embed.url;
    image.alt = "Linked image";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    if (onOpenImage) {
      image.tabIndex = 0;
      image.setAttribute("role", "button");
      image.setAttribute("aria-label", "Enlarge linked image");
      const open = () => onOpenImage(embed.url, image.alt);
      image.addEventListener("click", open);
      image.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      });
    }
    image.addEventListener("error", () => {
      const link = createExternalAnchor(embed.url, "embed-link");
      link.textContent = embed.url;
      card.replaceChildren(link);
    }, { once: true });
    card.append(image);
  } else {
    const video = document.createElement("video");
    video.className = "embed-media-video";
    video.controls = true;
    video.preload = "metadata";
    video.src = embed.url;
    video.setAttribute("referrerpolicy", "no-referrer");
    video.addEventListener("play", () => requestExternalVideoPlayback(embed.url, video));
    card.append(video);
  }
  parent.append(card);
}

function requestExternalVideoPlayback(url: string, video: HTMLVideoElement) {
  if (video.dataset.externalLinkConfirmation === "approved" || video.dataset.externalLinkConfirmation === "pending") return;
  video.dataset.externalLinkConfirmation = "pending";
  video.pause();
  void confirmExternalMedia(url).then((approved) => {
    if (!video.isConnected) return;
    if (!approved) {
      delete video.dataset.externalLinkConfirmation;
      return;
    }
    video.dataset.externalLinkConfirmation = "approved";
    void video.play().catch(() => undefined);
  });
}

function createExternalMediaAnchor(url: string, className?: string) {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer noopener nofollow";
  if (className) link.className = className;
  return link;
}

function appendYoutubeEmbed(parent: HTMLElement, embed: Extract<SafeEmbed, { kind: "youtube" }>) {
  const card = document.createElement("div");
  card.className = "embed-card youtube-embed-card";
  const frame = document.createElement("iframe");
  frame.className = "youtube-embed-frame";
  frame.src = `${embed.embedUrl}?rel=0&modestbranding=1&playsinline=1`;
  frame.title = "YouTube video preview";
  frame.loading = "lazy";
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
  frame.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
  card.append(frame);
  parent.append(card);
}

function appendGifEmbed(parent: HTMLElement, embed: Extract<SafeEmbed, { kind: "gif" }>) {
  if (!embed.mediaUrl) {
    if (embed.embedUrl) {
      const card = document.createElement("div");
      card.className = "embed-card gif-embed-card";
      const frame = document.createElement("iframe");
      frame.className = "gif-embed-frame";
      frame.src = embed.embedUrl;
      frame.title = `${gifProviderLabel(embed.provider)} GIF preview`;
      frame.loading = "lazy";
      frame.referrerPolicy = "no-referrer";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
      card.append(frame);
      parent.append(card);
      return;
    }
    appendLinkEmbed(parent, asLinkEmbed(embed));
    return;
  }
  const card = document.createElement("div");
  card.className = "embed-card embed-media-card gif-embed-card";
  const link = createExternalAnchor(embed.url, "embed-media-link");
  link.setAttribute("aria-label", `Open GIF on ${gifProviderLabel(embed.provider)} (external link)`);
  const image = document.createElement("img");
  image.className = "embed-media-image";
  image.src = embed.mediaUrl;
  image.alt = embed.title || `${gifProviderLabel(embed.provider)} GIF`;
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => {
    if (embed.provider !== "tenor") {
      card.remove();
      return;
    }
    const unavailable = document.createElement("span");
    unavailable.className = "gif-embed-unavailable";
    unavailable.textContent = "Preview unavailable · Open on Tenor";
    link.replaceChildren(unavailable);
  }, { once: true });
  const source = document.createElement("span");
  source.className = "gif-embed-source";
  source.textContent = `GIF · ${gifProviderLabel(embed.provider)}`;
  link.append(image, source);
  card.append(link);
  parent.append(card);
}

function appendTwitterEmbed(parent: HTMLElement, source: Extract<SafeEmbed, { kind: "social" }>) {
  const card = document.createElement("article");
  card.className = "embed-card twitter-embed-card";

  const render = (embed: Extract<SafeEmbed, { kind: "social" }>) => {
    const mediaItems = embed.media ?? [];
    card.replaceChildren();
    const header = document.createElement("div");
    header.className = "twitter-embed-header";
    if (embed.avatarUrl) {
      const avatar = document.createElement("img");
      avatar.className = "twitter-embed-avatar";
      avatar.src = embed.avatarUrl;
      avatar.alt = embed.authorName ? `${embed.authorName} avatar` : "";
      avatar.loading = "lazy";
      avatar.referrerPolicy = "no-referrer";
      avatar.addEventListener("error", () => avatar.remove(), { once: true });
      header.append(avatar);
    }
    const author = document.createElement("div");
    author.className = "twitter-embed-author";
    const authorName = document.createElement("strong");
    authorName.textContent = embed.authorName || "X post";
    author.append(authorName);
    if (embed.authorHandle) {
      const handle = document.createElement("span");
      handle.textContent = `@${embed.authorHandle.replace(/^@/, "")}`;
      author.append(handle);
    }
    header.append(author);
    const open = createExternalAnchor(embed.url, "twitter-embed-open");
    open.textContent = "Open on X";
    open.setAttribute("aria-label", "Open this post on X (external link)");
    header.append(open);
    card.append(header);

    if (embed.text) {
      const text = document.createElement("p");
      text.className = "twitter-embed-text";
      text.textContent = embed.text;
      card.append(text);
    }
    if (embed.createdAt) {
      const timeValue = new Date(embed.createdAt);
      if (!Number.isNaN(timeValue.valueOf())) {
        const time = document.createElement("time");
        time.className = "twitter-embed-time";
        time.dateTime = timeValue.toISOString();
        time.textContent = timeValue.toLocaleString();
        card.append(time);
      }
    }
    if (mediaItems.length > 0) {
      const media = document.createElement("div");
      media.className = "twitter-embed-media";
      for (const item of mediaItems) {
        if (item.type === "image") {
          const link = createExternalMediaAnchor(item.url, "twitter-embed-media-link");
          link.setAttribute("aria-label", "Open image at full size");
          const image = document.createElement("img");
          image.src = item.url;
          image.alt = "Post media";
          image.loading = "lazy";
          image.referrerPolicy = "no-referrer";
          image.addEventListener("error", () => link.remove(), { once: true });
          link.append(image);
          media.append(link);
        } else {
          const link = document.createElement("div");
          link.className = "twitter-embed-media-link";
          const video = document.createElement("video");
          video.controls = true;
          video.preload = "metadata";
          video.src = item.url;
          video.setAttribute("referrerpolicy", "no-referrer");
          if (item.thumbnailUrl) video.poster = item.thumbnailUrl;
          link.append(video);
          media.append(link);
        }
      }
      card.append(media);
    }
  };

  render(source);
  parent.append(card);
  if (!source.text && !source.authorName && (source.media?.length ?? 0) === 0) {
    void loadTwitterPreview(source.url).then((preview) => {
      if (preview) render({ ...source, ...preview, id: source.statusId });
    });
  }
}

function appendLinkEmbed(parent: HTMLElement, source: Extract<SafeEmbed, { kind: "link" }>) {
  const card = document.createElement("div");
  card.className = "embed-card";
  const link = createExternalAnchor(source.url, "embed-link");
  const title = document.createElement("span");
  title.className = "embed-title";
  title.textContent = source.title || siteTitle(new URL(source.url));
  link.setAttribute("aria-label", `${title.textContent} (external link)`);
  link.append(title);
  card.append(link);

  const appendImage = (value: string) => {
    const imageUrl = safeHttpUrl(value);
    if (!imageUrl || link.querySelector(".embed-image")) return;
    const image = document.createElement("img");
    image.className = "embed-image";
    image.src = imageUrl.toString();
    image.alt = title.textContent || "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    link.prepend(image);
  };
  if (source.imageUrl) appendImage(source.imageUrl);
  parent.append(card);

  if (!source.imageUrl || source.title === siteTitle(new URL(source.url))) {
    void loadLinkMetadata(source.url).then((metadata) => {
      if (metadata.title) title.textContent = metadata.title;
      if (metadata.imageUrl) appendImage(metadata.imageUrl);
      link.setAttribute("aria-label", `${title.textContent} (external link)`);
    });
  }
}

export function appendSafeEmbed(parent: HTMLElement, embed: SafeEmbed, onOpenImage?: (url: string, title: string) => void) {
  if (embed.kind === "media") appendMediaEmbed(parent, embed, onOpenImage);
  else if (embed.kind === "social") appendTwitterEmbed(parent, embed);
  else if (embed.kind === "gif") appendGifEmbed(parent, embed);
  else if (embed.kind === "youtube") appendYoutubeEmbed(parent, embed);
  else appendLinkEmbed(parent, asLinkEmbed(embed));
}
