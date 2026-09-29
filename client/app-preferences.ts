import {
  builtInThemeColors,
  defaultThemeDesign,
  normalizeCustomThemePresets,
  themeColorTokens,
  type CustomThemePreset,
  type ThemeDesign,
} from "./theme-presets";
import { applyThemeBackgroundImage } from "./theme-assets";

export type AppTheme = "dark" | "dim" | "light" | "black" | "momotalk";
export type NotificationMode = "off" | "all" | "mentions";
export type { CustomThemePreset } from "./theme-presets";

export type AppPreferences = {
  theme: AppTheme;
  themePreset: string;
  customThemes: CustomThemePreset[];
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
  themePreset: "dark",
  customThemes: [],
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

export function applyThemeDesign(target: HTMLElement, design: ThemeDesign, custom = true) {
  target.dataset.themeDesign = String(custom);
  target.dataset.themeBackground = design.backgroundMode;
  target.dataset.themeBorders = design.borderStyle;
  target.dataset.themeMotion = design.motion;
  target.dataset.themeContentWidth = design.contentWidth;
  target.dataset.themeDensity = design.density;
  target.dataset.themeShadow = design.shadow;
  target.style.setProperty("--theme-content-width", ({ narrow: "720px", comfortable: "920px", wide: "1180px" })[design.contentWidth]);
  target.style.setProperty("--theme-message-gap", ({ compact: "1px", comfortable: "4px", spacious: "10px" })[design.density]);
  target.style.setProperty("--theme-message-pad-y", ({ compact: "4px", comfortable: "10px", spacious: "16px" })[design.density]);
  target.style.setProperty("--theme-message-pad-x", ({ compact: "5px", comfortable: "11px", spacious: "17px" })[design.density]);
  target.style.setProperty("--theme-message-radius", `${design.radius}px`);
  target.style.setProperty("--theme-panel-radius", `${design.radius}px`);
  target.style.setProperty("--theme-control-radius", `${Math.round(design.radius * 0.72)}px`);
  target.style.setProperty("--theme-border-width", design.borderStyle === "none" ? "0px" : design.borderStyle === "solid" || design.borderStyle === "dashed" ? "2px" : "1px");
  target.style.setProperty("--theme-border-line-style", design.borderStyle === "dashed" ? "dashed" : "solid");
  target.style.setProperty("--theme-shadow", ({ none: "none", soft: "0 6px 20px rgba(0, 0, 0, 0.12)", deep: "0 12px 35px rgba(0, 0, 0, 0.28)" })[design.shadow]);
  target.style.setProperty("--theme-transition-time", ({ quick: "90ms", balanced: "160ms", slow: "300ms" })[design.transitionSpeed]);
  target.style.setProperty("--theme-transition-easing", ({ standard: "ease", smooth: "cubic-bezier(0.2, 0.7, 0.2, 1)", spring: "cubic-bezier(0.2, 0.9, 0.25, 1.3)" })[design.transitionEasing]);
  target.style.setProperty("--theme-motion-duration", ({ none: "0ms", fade: "180ms", slide: "220ms", pop: "240ms" })[design.motion]);
  target.style.setProperty("--theme-background-position", design.imagePosition);
  target.style.setProperty("--theme-background-size", design.imageFit);
  target.style.setProperty("--theme-background-overlay", String(design.overlay / 100));
  const gradient = `linear-gradient(${design.gradientAngle}deg, ${design.gradientStart}, ${design.gradientEnd})`;
  target.style.setProperty("--theme-chat-gradient", gradient);
  const background = design.backgroundMode === "gradient"
    ? gradient
    : design.backgroundMode === "image"
      ? `linear-gradient(rgba(0, 0, 0, ${design.overlay / 100}), rgba(0, 0, 0, ${design.overlay / 100})), var(--theme-background-image, none)`
      : "var(--bg)";
  target.style.setProperty("--theme-chat-background", background);
  applyThemeBackgroundImage(target, design.backgroundImageAssetId, custom && design.backgroundMode === "image");
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
  const lightTheme = theme === "light" || theme === "momotalk";
  const background = theme === "momotalk" ? "#d1cae8" : lightTheme ? "#ccddda" : "#33464d";
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
  const legacyTheme = input.theme === "dim" || input.theme === "light" || input.theme === "black" || input.theme === "momotalk" || input.theme === "dark"
    ? input.theme
    : defaultAppPreferences.theme;
  const customThemes = normalizeCustomThemePresets(input.customThemes);
  const requestedThemePreset = typeof input.themePreset === "string" ? input.themePreset : legacyTheme;
  const selectedCustomTheme = customThemes.find((candidate) => candidate.id === requestedThemePreset);
  const themePreset = selectedCustomTheme?.id
    ?? (requestedThemePreset === "dark" || requestedThemePreset === "dim" || requestedThemePreset === "light" || requestedThemePreset === "black" || requestedThemePreset === "momotalk"
      ? requestedThemePreset
      : legacyTheme);
  const theme: AppTheme = selectedCustomTheme?.baseTheme ?? themePreset as AppTheme;
  return {
    theme,
    themePreset,
    customThemes,
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

export function accentForAppPreferences(preferences: AppPreferences) {
  const customTheme = preferences.customThemes.find((candidate) => candidate.id === preferences.themePreset);
  if (customTheme) return customTheme.colors.accent;
  if (preferences.themePreset === "momotalk") return builtInThemeColors.momotalk.accent;
  return preferences.accent;
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
  const customTheme = normalized.customThemes.find((candidate) => candidate.id === normalized.themePreset);
  const colors = customTheme?.colors ?? builtInThemeColors[normalized.theme];
  const design = customTheme?.design ?? defaultThemeDesign;
  // MomoTalk's warm pink is part of its signature palette. Keep the user's
  // general accent preference untouched for the other built-in themes.
  const accent = accentForAppPreferences(normalized);
  const accentInk = accentForeground(accent);
  const accentHover = colors.accentHover;
  const accentHoverInk = accentForeground(accentHover);
  const accentText = readableAccentText(accent, normalized.theme);
  const targets = appRoot === root ? [root] : [root, appRoot];
  for (const target of targets) {
    target.dataset.appTheme = normalized.theme;
    target.dataset.themePreset = normalized.themePreset;
    for (const { key, variable } of themeColorTokens) {
      target.style.setProperty(variable, key === "accent" ? accent : colors[key]);
    }
    target.style.setProperty("--accent-ink", accentInk);
    target.style.setProperty("--accent-hover-ink", accentHoverInk);
    target.style.setProperty("--accent-text", accentText);
    applyThemeDesign(target, design, Boolean(customTheme));
  }
  root.dataset.reducedMotion = String(normalized.reducedMotion);
  root.style.setProperty("--app-scale", String(normalized.scale));
  root.style.setProperty("--message-text-size", `${normalized.messageTextSize}px`);
  appRoot.dataset.compactMessages = String(normalized.compactMessages);
  appRoot.dataset.autoLoadMedia = String(normalized.autoLoadMedia);
  appRoot.dataset.externalPreviews = String(normalized.externalPreviews);
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
