export type SafeEmbed =
  | { kind: "youtube"; id: string; url: string; embedUrl: string }
  | { kind: "image"; url: string }
  | { kind: "social"; network: "x"; url: string };

const youtubeId = /^[A-Za-z0-9_-]{11}$/;
const statusPath = /^\/(?:[^/]+\/)?status\/([0-9]+)(?:\/|$)/i;
const imagePath = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const imageHosts = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "pbs.twimg.com",
]);

function cleanUrl(value: string) {
  return value.replace(/[),.!?:;]+$/g, "");
}

export function parseSafeEmbed(value: string): SafeEmbed | null {
  let url: URL;
  try {
    url = new URL(cleanUrl(value));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;

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
    if (statusPath.test(url.pathname)) return { kind: "social", network: "x", url: url.toString() };
  }

  if (url.protocol === "https:" && (imagePath.test(url.pathname) || imageHosts.has(host))) {
    return { kind: "image", url: url.toString() };
  }

  return null;
}

export function extractEmbeds(text: string): SafeEmbed[] {
  const matches = text.match(/https?:\/\/[^\s<]+/gi) ?? [];
  const seen = new Set<string>();
  const embeds: SafeEmbed[] = [];
  for (const match of matches) {
    const embed = parseSafeEmbed(match);
    if (!embed || seen.has(embed.url)) continue;
    seen.add(embed.url);
    embeds.push(embed);
    if (embeds.length === 4) break;
  }
  return embeds;
}

export function appendSafeEmbed(parent: HTMLElement, embed: SafeEmbed) {
  const card = document.createElement("div");
  card.className = "embed-card";

  if (embed.kind === "youtube") {
    const frame = document.createElement("iframe");
    frame.src = embed.embedUrl;
    frame.title = "YouTube video preview";
    frame.loading = "lazy";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.setAttribute("sandbox", "allow-scripts allow-presentation");
    frame.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture");
    card.append(frame);
  } else if (embed.kind === "image") {
    const image = document.createElement("img");
    image.className = "embed-image";
    image.src = embed.url;
    image.alt = "Linked image";
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => card.remove(), { once: true });
    card.append(image);
  } else {
    const link = document.createElement("a");
    link.href = embed.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = "Open X post";
    card.append(link);
  }

  parent.append(card);
}
