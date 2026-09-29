export type AppTheme = "dark" | "dim" | "light";
export type NotificationMode = "off" | "all" | "mentions";

export type AppPreferences = {
  theme: AppTheme;
  accent: string;
  scale: number;
  sounds: boolean;
  autoLoadMedia: boolean;
  externalPreviews: boolean;
  enterToSend: boolean;
  compactMessages: boolean;
  reducedMotion: boolean;
  messageTextSize: number;
  notificationMode: NotificationMode;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
};

export const MIN_APP_SCALE = 0.85;
export const MAX_APP_SCALE = 2;
export const MIN_MESSAGE_TEXT_SIZE = 12;
export const MAX_MESSAGE_TEXT_SIZE = 24;
export const DEFAULT_MESSAGE_TEXT_SIZE = 14;

export const defaultAppPreferences: AppPreferences = {
  theme: "dark",
  accent: "#92aaa5",
  scale: 1,
  sounds: true,
  autoLoadMedia: true,
  externalPreviews: true,
  enterToSend: true,
  compactMessages: false,
  reducedMotion: false,
  messageTextSize: DEFAULT_MESSAGE_TEXT_SIZE,
  notificationMode: "off",
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
};

const notificationStorageKey = (userId?: string) => userId ? `priv-chat.notifications.${userId}` : "priv-chat.notifications";

function storageKey(userId?: string) {
  return userId ? `priv-chat.app-preferences.${userId}` : "priv-chat.app-preferences";
}

function validAccent(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function validTime(value: unknown, fallback: string) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function rgb(hex: string) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function relativeLuminance(hex: string) {
  const [red, green, blue] = rgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function mixHex(color: string, target: string, amount: number) {
  const channels = rgb(color).map((channel, index) => Math.round(channel * (1 - amount) + rgb(target)[index] * amount));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function accentForeground(accent: string) {
  const dark = "#000000";
  const light = "#ffffff";
  return contrastRatio(dark, accent) >= contrastRatio(light, accent) ? dark : light;
}

export function readableAccentText(accent: string, theme: AppTheme) {
  const lightTheme = theme === "light";
  const background = lightTheme ? "#ccddda" : "#33464d";
  const target = lightTheme ? "#10181c" : "#ffffff";
  for (let step = 0; step <= 100; step += 1) {
    const candidate = mixHex(accent, target, step / 100);
    if (contrastRatio(candidate, background) >= 4.5) return candidate;
  }
  return target;
}

export function normalizeAppPreferences(value: unknown): AppPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaultAppPreferences };
  const input = value as Record<string, unknown>;
  const scale = typeof input.scale === "number" && Number.isFinite(input.scale)
    ? Math.min(MAX_APP_SCALE, Math.max(MIN_APP_SCALE, input.scale))
    : defaultAppPreferences.scale;
  const legacyMessageTextScale = typeof input.messageTextScale === "number" && Number.isFinite(input.messageTextScale)
    ? Math.min(1.5, Math.max(0.8, input.messageTextScale))
    : undefined;
  const messageTextSize = typeof input.messageTextSize === "number" && Number.isFinite(input.messageTextSize)
    ? Math.round(Math.min(MAX_MESSAGE_TEXT_SIZE, Math.max(MIN_MESSAGE_TEXT_SIZE, input.messageTextSize)))
    : legacyMessageTextScale === undefined
      ? defaultAppPreferences.messageTextSize
      : Math.round(Math.min(MAX_MESSAGE_TEXT_SIZE, Math.max(MIN_MESSAGE_TEXT_SIZE, legacyMessageTextScale * 14.4)));
  const theme = input.theme === "dim" || input.theme === "light" || input.theme === "dark"
    ? input.theme
    : defaultAppPreferences.theme;
  return {
    theme,
    accent: validAccent(input.accent) ? input.accent : defaultAppPreferences.accent,
    scale,
    messageTextSize,
    sounds: typeof input.sounds === "boolean" ? input.sounds : defaultAppPreferences.sounds,
    autoLoadMedia: typeof input.autoLoadMedia === "boolean" ? input.autoLoadMedia : defaultAppPreferences.autoLoadMedia,
    externalPreviews: typeof input.externalPreviews === "boolean" ? input.externalPreviews : defaultAppPreferences.externalPreviews,
    enterToSend: typeof input.enterToSend === "boolean" ? input.enterToSend : defaultAppPreferences.enterToSend,
    compactMessages: typeof input.compactMessages === "boolean" ? input.compactMessages : defaultAppPreferences.compactMessages,
    reducedMotion: typeof input.reducedMotion === "boolean" ? input.reducedMotion : defaultAppPreferences.reducedMotion,
    notificationMode: input.notificationMode === "all" || input.notificationMode === "mentions" || input.notificationMode === "off"
      ? input.notificationMode
      : defaultAppPreferences.notificationMode,
    quietHoursEnabled: typeof input.quietHoursEnabled === "boolean" ? input.quietHoursEnabled : defaultAppPreferences.quietHoursEnabled,
    quietHoursStart: validTime(input.quietHoursStart, defaultAppPreferences.quietHoursStart),
    quietHoursEnd: validTime(input.quietHoursEnd, defaultAppPreferences.quietHoursEnd),
  };
}

export function loadAppPreferences(userId?: string): AppPreferences {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) {
      const wasEnabled = localStorage.getItem(notificationStorageKey(userId)) === "enabled";
      return { ...defaultAppPreferences, notificationMode: wasEnabled ? "all" : "off" };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !("notificationMode" in parsed)) {
      const wasEnabled = localStorage.getItem(notificationStorageKey(userId)) === "enabled";
      return normalizeAppPreferences({ ...parsed, notificationMode: wasEnabled ? "all" : "off" });
    }
    return normalizeAppPreferences(parsed);
  } catch {
    return { ...defaultAppPreferences };
  }
}

export function saveAppPreferences(userId: string | undefined, preferences: AppPreferences) {
  const normalized = normalizeAppPreferences(preferences);
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(normalized));
    if (normalized.notificationMode === "off") localStorage.removeItem(notificationStorageKey(userId));
    else localStorage.setItem(notificationStorageKey(userId), "enabled");
    window.dispatchEvent(new CustomEvent("priv-chat:app-preferences", { detail: normalized }));
  } catch {
    // Local application preferences are optional and must never block chat.
  }
  return normalized;
}

export function applyAppPreferences(preferences: AppPreferences, appRoot: HTMLElement = document.documentElement) {
  const normalized = normalizeAppPreferences(preferences);
  const root = document.documentElement;
  const accentInk = accentForeground(normalized.accent);
  const accentHover = normalized.theme === "light" ? "#527d75" : "#a7bdb7";
  const accentHoverInk = accentForeground(accentHover);
  const accentText = readableAccentText(normalized.accent, normalized.theme);
  root.dataset.appTheme = normalized.theme;
  root.dataset.reducedMotion = String(normalized.reducedMotion);
  root.style.setProperty("--app-scale", String(normalized.scale));
  root.style.setProperty("--message-text-size", `${normalized.messageTextSize}px`);
  root.style.setProperty("--accent", normalized.accent);
  root.style.setProperty("--accent-ink", accentInk);
  root.style.setProperty("--accent-hover-ink", accentHoverInk);
  root.style.setProperty("--accent-text", accentText);
  appRoot.dataset.appTheme = normalized.theme;
  appRoot.dataset.compactMessages = String(normalized.compactMessages);
  appRoot.dataset.autoLoadMedia = String(normalized.autoLoadMedia);
  appRoot.dataset.externalPreviews = String(normalized.externalPreviews);
  appRoot.style.setProperty("--accent", normalized.accent);
  appRoot.style.setProperty("--accent-ink", accentInk);
  appRoot.style.setProperty("--accent-hover-ink", accentHoverInk);
  appRoot.style.setProperty("--accent-text", accentText);
  return normalized;
}

export function isQuietHours(preferences: Pick<AppPreferences, "quietHoursEnabled" | "quietHoursStart" | "quietHoursEnd">, now = new Date()) {
  if (!preferences.quietHoursEnabled || preferences.quietHoursStart === preferences.quietHoursEnd) return false;
  const [startHour, startMinute] = preferences.quietHoursStart.split(":").map(Number);
  const [endHour, endMinute] = preferences.quietHoursEnd.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function shouldNotifyAppMessage(preferences: Pick<AppPreferences, "notificationMode" | "quietHoursEnabled" | "quietHoursStart" | "quietHoursEnd">, isMention: boolean, now = new Date()) {
  if (preferences.notificationMode === "off" || preferences.notificationMode === "mentions" && !isMention) return false;
  return !isQuietHours(preferences, now);
}
