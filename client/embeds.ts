import { confirmExternalLink, guardExternalLink } from "./external-link";

export type SafeEmbed =
  | { kind: "youtube"; id: string; url: string; embedUrl: string }
  | { kind: "social"; network: "x"; url: string; statusId: string }
  | { kind: "media"; mediaType: "image" | "video"; url: string }
  | { kind: "link"; url: string; title: string; imageUrl?: string };

export type LinkMetadata = {
  title?: string;
  imageUrl?: string;
};

const youtubeId = /^[A-Za-z0-9_-]{11}$/;
const statusPath = /^\/(?:[^/]+\/)?status\/([0-9]+)(?:\/|$)/i;
const imageExtension = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const videoExtension = /\.(?:m4v|mov|mp4|ogv|webm)$/i;
const metadataLimit = 1_000_000;
const linkMetadataCache = new Map<string, Promise<LinkMetadata>>();

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

  if (host === "x.com" || host === "www.x.com" || host === "twitter.com" || host === "www.twitter.com") {
    const status = url.pathname.match(statusPath);
    if (status) return { kind: "social", network: "x", url: url.toString(), statusId: status[1] };
  }

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
    const embed = parsed.kind === "youtube" || parsed.kind === "social" ? asLinkEmbed(parsed) : parsed;
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
    } else if (stored.kind === "link" && (parsed.kind === "link" || parsed.kind === "youtube" || parsed.kind === "social")) {
      const link = asLinkEmbed(parsed);
      const image = typeof stored.imageUrl === "string" ? safeHttpUrl(stored.imageUrl) : null;
      embeds.push({
        ...link,
        ...(storedText(stored.title) ? { title: storedText(stored.title) } : {}),
        ...(image ? { imageUrl: image.toString() } : {}),
      });
    } else if (stored.kind === "youtube" && parsed.kind === "youtube") {
      embeds.push(parsed);
    } else if (stored.kind === "social" && parsed.kind === "social") {
      embeds.push(parsed);
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

function loadLinkMetadata(url: string) {
  const cached = linkMetadataCache.get(url);
  if (cached) return cached;
  const request = fetchLinkMetadata(url);
  linkMetadataCache.set(url, request);
  if (linkMetadataCache.size > 100) linkMetadataCache.delete(linkMetadataCache.keys().next().value as string);
  return request;
}

export async function prepareEmbeds(text: string) {
  const embeds = extractEmbeds(text);
  return await Promise.all(embeds.map(async (embed) => {
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

function appendMediaEmbed(parent: HTMLElement, embed: Extract<SafeEmbed, { kind: "media" }>) {
  const card = document.createElement("div");
  card.className = "embed-card embed-media-card";
  if (embed.mediaType === "image") {
    const link = createExternalAnchor(embed.url, "embed-media-link");
    const image = document.createElement("img");
    image.className = "embed-media-image";
    image.src = embed.url;
    image.alt = "Linked image";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    link.append(image);
    card.append(link);
  } else {
    const video = document.createElement("video");
    video.className = "embed-media-video";
    video.controls = true;
    video.preload = "metadata";
    video.src = embed.url;
    video.setAttribute("referrerpolicy", "no-referrer");
    video.addEventListener("play", () => {
      if (!confirmExternalMedia(embed.url)) video.pause();
    });
    card.append(video);
  }
  parent.append(card);
}

function confirmExternalMedia(url: string) {
  return confirmExternalLink(url);
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

export function appendSafeEmbed(parent: HTMLElement, embed: SafeEmbed) {
  if (embed.kind === "media") appendMediaEmbed(parent, embed);
  else appendLinkEmbed(parent, asLinkEmbed(embed));
}
