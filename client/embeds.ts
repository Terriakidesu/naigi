export type SafeEmbed =
  | { kind: "youtube"; id: string; url: string; embedUrl: string }
  | { kind: "social"; network: "x"; url: string; statusId: string };

const youtubeId = /^[A-Za-z0-9_-]{11}$/;
const statusPath = /^\/(?:[^/]+\/)?status\/([0-9]+)(?:\/|$)/i;

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
    const status = url.pathname.match(statusPath);
    if (status) return { kind: "social", network: "x", url: url.toString(), statusId: status[1] };
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
    frame.src = `${embed.embedUrl}?rel=0&modestbranding=1&playsinline=1`;
    frame.title = "YouTube video preview";
    frame.loading = "lazy";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
    frame.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture");
    card.append(frame);
  } else {
    const tweet = document.createElement("blockquote");
    tweet.className = "twitter-tweet";
    tweet.dataset.dnt = "true";
    tweet.dataset.theme = "dark";
    tweet.dataset.conversation = "none";
    tweet.dataset.chrome = "noheader nofooter noborders transparent";
    const link = document.createElement("a");
    link.href = embed.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = "Open X post";
    tweet.append(link);
    card.append(tweet);
    void loadXWidgets().then((widgets) => widgets.widgets.load(card)).catch(() => undefined);
  }

  parent.append(card);
}

type XWidgets = {
  widgets: { load(element?: HTMLElement): void };
};

declare global {
  interface Window {
    twttr?: XWidgets;
  }
}

let xWidgetsPromise: Promise<XWidgets> | undefined;

function loadXWidgets() {
  if (window.twttr?.widgets) return Promise.resolve(window.twttr);
  xWidgetsPromise ??= new Promise<XWidgets>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-priv-chat-x-widgets]");
    const script = existing ?? document.createElement("script");
    const finish = () => {
      if (window.twttr?.widgets) resolve(window.twttr);
      else reject(new Error("x_widgets_unavailable"));
    };
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => reject(new Error("x_widgets_failed")), { once: true });
    if (!existing) {
      script.async = true;
      script.src = "https://platform.x.com/widgets.js";
      script.dataset.privChatXWidgets = "true";
      document.head.append(script);
    }
  });
  return xWidgetsPromise;
}
