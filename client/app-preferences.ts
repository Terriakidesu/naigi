export type AppTheme = "dark" | "dim" | "light";

export type AppPreferences = {
  theme: AppTheme;
  accent: string;
  scale: number;
  sounds: boolean;
  autoplayMedia: boolean;
  externalPreviews: boolean;
  enterToSend: boolean;
  compactMessages: boolean;
  reducedMotion: boolean;
};

export const defaultAppPreferences: AppPreferences = {
  theme: "dark",
  accent: "#92aaa5",
  scale: 1,
  sounds: true,
  autoplayMedia: false,
  externalPreviews: true,
  enterToSend: true,
  compactMessages: false,
  reducedMotion: false,
};

function storageKey(userId?: string) {
  return userId ? `priv-chat.app-preferences.${userId}` : "priv-chat.app-preferences";
}

function validAccent(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function normalizePreferences(value: unknown): AppPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaultAppPreferences };
  const input = value as Record<string, unknown>;
  const scale = typeof input.scale === "number" && Number.isFinite(input.scale)
    ? Math.min(1.25, Math.max(0.85, input.scale))
    : defaultAppPreferences.scale;
  const theme = input.theme === "dim" || input.theme === "light" || input.theme === "dark"
    ? input.theme
    : defaultAppPreferences.theme;
  return {
    theme,
    accent: validAccent(input.accent) ? input.accent : defaultAppPreferences.accent,
    scale,
    sounds: typeof input.sounds === "boolean" ? input.sounds : defaultAppPreferences.sounds,
    autoplayMedia: typeof input.autoplayMedia === "boolean" ? input.autoplayMedia : defaultAppPreferences.autoplayMedia,
    externalPreviews: typeof input.externalPreviews === "boolean" ? input.externalPreviews : defaultAppPreferences.externalPreviews,
    enterToSend: typeof input.enterToSend === "boolean" ? input.enterToSend : defaultAppPreferences.enterToSend,
    compactMessages: typeof input.compactMessages === "boolean" ? input.compactMessages : defaultAppPreferences.compactMessages,
    reducedMotion: typeof input.reducedMotion === "boolean" ? input.reducedMotion : defaultAppPreferences.reducedMotion,
  };
}

export function loadAppPreferences(userId?: string): AppPreferences {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw ? normalizePreferences(JSON.parse(raw) as unknown) : { ...defaultAppPreferences };
  } catch {
    return { ...defaultAppPreferences };
  }
}

export function saveAppPreferences(userId: string | undefined, preferences: AppPreferences) {
  const normalized = normalizePreferences(preferences);
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(normalized));
    window.dispatchEvent(new CustomEvent("priv-chat:app-preferences", { detail: normalized }));
  } catch {
    // Local application preferences are optional and must never block chat.
  }
  return normalized;
}

export function applyAppPreferences(preferences: AppPreferences, appRoot: HTMLElement = document.documentElement) {
  const normalized = normalizePreferences(preferences);
  const root = document.documentElement;
  root.dataset.appTheme = normalized.theme;
  root.dataset.reducedMotion = String(normalized.reducedMotion);
  root.style.setProperty("--app-scale", String(normalized.scale));
  root.style.setProperty("--accent", normalized.accent);
  appRoot.dataset.appTheme = normalized.theme;
  appRoot.dataset.compactMessages = String(normalized.compactMessages);
  appRoot.dataset.autoplayMedia = String(normalized.autoplayMedia);
  appRoot.dataset.externalPreviews = String(normalized.externalPreviews);
  appRoot.style.setProperty("--accent", normalized.accent);
  return normalized;
}
