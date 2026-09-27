export function confirmExternalLink(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
  if (url.origin === window.location.origin) return true;

  const destination = `${url.hostname}${url.pathname}${url.search}${url.hash}`.slice(0, 240);
  return window.confirm(`You are about to visit an external link:\n\n${destination}\n\nContinue?`);
}

export function guardExternalLink(link: HTMLAnchorElement, value = link.href) {
  link.addEventListener("click", (event) => {
    if (!confirmExternalLink(value)) event.preventDefault();
  });
}
