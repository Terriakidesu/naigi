const avatarColors = ["#92aaa5", "#7fa0ad", "#a28f99", "#8e99ad", "#9f9a7d", "#759b9c", "#8d9aa4"];

export function avatarColor(seed: string) {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return avatarColors[hash % avatarColors.length];
}

export function setAvatarStyle(element: HTMLElement, seed: string) {
  element.style.setProperty("--avatar-color", avatarColor(seed));
  element.style.setProperty("--avatar-ink", "#10181c");
}

export function renderAvatar(element: HTMLElement, displayName: string, seed: string, avatarUrl: string | null | undefined, alt = "") {
  setAvatarStyle(element, seed);
  element.replaceChildren();
  element.classList.remove("avatar-image");

  const fallback = () => {
    element.replaceChildren();
    element.classList.remove("avatar-image");
    element.style.removeProperty("background");
    element.textContent = displayName.slice(0, 1).toUpperCase() || "?";
  };

  if (!avatarUrl) {
    fallback();
    return;
  }

  const image = document.createElement("img");
  image.src = avatarUrl;
  image.alt = alt;
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("error", fallback, { once: true });
  element.classList.add("avatar-image");
  element.style.background = "transparent";
  element.append(image);
}
