import type { AppTheme } from "./app-preferences";

export const themeColorTokens = [
  { group: "Surfaces", key: "bg", variable: "--bg", label: "Chat background" },
  { group: "Surfaces", key: "bgDeep", variable: "--bg-deep", label: "Deep background" },
  { group: "Surfaces", key: "bgSidebar", variable: "--bg-sidebar", label: "Sidebar" },
  { group: "Surfaces", key: "bgElevated", variable: "--bg-elevated", label: "Raised surfaces" },
  { group: "Surfaces", key: "bgInput", variable: "--bg-input", label: "Inputs and composer" },
  { group: "Surfaces", key: "bgHover", variable: "--bg-hover", label: "Hover surface" },
  { group: "Surfaces", key: "bgActive", variable: "--bg-active", label: "Selected surface" },
  { group: "Surfaces", key: "line", variable: "--line", label: "Strong borders" },
  { group: "Surfaces", key: "lineSoft", variable: "--line-soft", label: "Soft borders" },
  { group: "Navigation", key: "workspaceRail", variable: "--workspace-rail", label: "Workspace rail" },
  { group: "Text", key: "text", variable: "--text", label: "Main text" },
  { group: "Text", key: "textMuted", variable: "--text-muted", label: "Secondary text" },
  { group: "Text", key: "textFaint", variable: "--text-faint", label: "Muted text" },
  { group: "Text", key: "textPlaceholder", variable: "--text-placeholder", label: "Placeholder text" },
  { group: "Messages", key: "messageBubble", variable: "--message-bubble", label: "Received bubble" },
  { group: "Messages", key: "messageBubbleOwn", variable: "--message-bubble-own", label: "Sent bubble" },
  { group: "Messages", key: "messageBubbleText", variable: "--message-bubble-text", label: "Received bubble text" },
  { group: "Messages", key: "messageBubbleOwnText", variable: "--message-bubble-own-text", label: "Sent bubble text" },
  { group: "Accent", key: "accent", variable: "--accent", label: "Accent" },
  { group: "Accent", key: "accentHover", variable: "--accent-hover", label: "Accent hover" },
  { group: "Status", key: "green", variable: "--green", label: "Success" },
  { group: "Status", key: "greenText", variable: "--green-text", label: "Success text" },
  { group: "Status", key: "danger", variable: "--danger", label: "Danger" },
  { group: "Status", key: "dangerText", variable: "--danger-text", label: "Danger text" },
  { group: "Status", key: "dangerHoverBg", variable: "--danger-hover-bg", label: "Danger hover" },
  { group: "Status", key: "dangerInk", variable: "--danger-ink", label: "Text on danger badges" },
] as const;

export type ThemeColorKey = typeof themeColorTokens[number]["key"];
export type ThemeColors = Record<ThemeColorKey, string>;

export type ThemeBackgroundMode = "solid" | "gradient" | "image";
export type ThemeDensity = "compact" | "comfortable" | "spacious";
export type ThemeContentWidth = "narrow" | "comfortable" | "wide";
export type ThemeBorderStyle = "none" | "subtle" | "solid" | "dashed";
export type ThemeMotion = "none" | "fade" | "slide" | "pop";
export type ThemeTransitionSpeed = "quick" | "balanced" | "slow";
export type ThemeTransitionEasing = "standard" | "smooth" | "spring";

export type ThemeDesign = {
  backgroundMode: ThemeBackgroundMode;
  gradientStart: string;
  gradientEnd: string;
  gradientAngle: number;
  backgroundImageAssetId?: string;
  imageFit: "cover" | "contain";
  imagePosition: "center" | "top" | "bottom";
  overlay: number;
  contentWidth: ThemeContentWidth;
  density: ThemeDensity;
  radius: number;
  borderStyle: ThemeBorderStyle;
  shadow: "none" | "soft" | "deep";
  motion: ThemeMotion;
  transitionSpeed: ThemeTransitionSpeed;
  transitionEasing: ThemeTransitionEasing;
};

export type SharedThemeDesign = Omit<ThemeDesign, "backgroundImageAssetId">;

export type CustomThemePreset = {
  id: string;
  name: string;
  baseTheme: AppTheme;
  colors: ThemeColors;
  design: ThemeDesign;
};

export type SharedThemePreset = Omit<CustomThemePreset, "id" | "design"> & { design: SharedThemeDesign };
export type ImportedSharedThemePreset = SharedThemePreset & {
  backgroundImage?: { mimeType: "image/png" | "image/jpeg" | "image/webp"; base64: string };
};

export const MAX_CUSTOM_THEME_PRESETS = 32;
export const MAX_THEME_NAME_LENGTH = 48;
export const MAX_SHARED_THEME_LENGTH = 20_000;
export const MAX_THEME_IMAGE_BYTES = 1_000_000;
export const MAX_THEME_PACKAGE_LENGTH = 1_500_000;
export const themeImageMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;

export const defaultThemeDesign: ThemeDesign = {
  backgroundMode: "solid",
  gradientStart: "#161d24",
  gradientEnd: "#0d1319",
  gradientAngle: 135,
  imageFit: "cover",
  imagePosition: "center",
  overlay: 35,
  contentWidth: "comfortable",
  density: "comfortable",
  radius: 12,
  borderStyle: "subtle",
  shadow: "soft",
  motion: "fade",
  transitionSpeed: "balanced",
  transitionEasing: "smooth",
};

export const builtInThemeColors: Record<AppTheme, ThemeColors> = {
  dark: {
    bg: "#161d24",
    bgDeep: "#0d1319",
    bgSidebar: "#131a21",
    bgElevated: "#1c252d",
    bgInput: "#202b33",
    bgHover: "#26343b",
    bgActive: "#2c3b42",
    workspaceRail: "#0d1319",
    line: "#0d141a",
    lineSoft: "#37464d",
    text: "#e7eceb",
    textMuted: "#b1bec0",
    textFaint: "#a7b3b5",
    textPlaceholder: "#a5b3b5",
    messageBubble: "#26343b",
    messageBubbleOwn: "#30414a",
    messageBubbleText: "#e7eceb",
    messageBubbleOwnText: "#f4f7f6",
    accent: "#92aaa5",
    accentHover: "#a7bdb7",
    green: "#78b39b",
    greenText: "#96d7b4",
    danger: "#d57f86",
    dangerText: "#ffb3b5",
    dangerHoverBg: "#60343a",
    dangerInk: "#10181c",
  },
  dim: {
    bg: "#1a2026",
    bgDeep: "#11171d",
    bgSidebar: "#161d23",
    bgElevated: "#202a31",
    bgInput: "#253039",
    bgHover: "#2b3a42",
    bgActive: "#33464d",
    workspaceRail: "#11171d",
    line: "#0d141a",
    lineSoft: "#37464d",
    text: "#e7eceb",
    textMuted: "#b1bec0",
    textFaint: "#a7b3b5",
    textPlaceholder: "#a5b3b5",
    messageBubble: "#2b3a42",
    messageBubbleOwn: "#33464d",
    messageBubbleText: "#e7eceb",
    messageBubbleOwnText: "#f4f7f6",
    accent: "#92aaa5",
    accentHover: "#a7bdb7",
    green: "#78b39b",
    greenText: "#96d7b4",
    danger: "#d57f86",
    dangerText: "#ffb3b5",
    dangerHoverBg: "#60343a",
    dangerInk: "#10181c",
  },
  light: {
    bg: "#eef3f2",
    bgDeep: "#dfe8e6",
    bgSidebar: "#e7efed",
    bgElevated: "#f8fbfa",
    bgInput: "#ffffff",
    bgHover: "#dbe7e4",
    bgActive: "#ccddda",
    workspaceRail: "#dfe8e6",
    line: "#c3d3d0",
    lineSoft: "#b5c8c4",
    text: "#1f2c2d",
    textMuted: "#405154",
    textFaint: "#516265",
    textPlaceholder: "#516265",
    messageBubble: "#e3e9e8",
    messageBubbleOwn: "#d7e6e2",
    messageBubbleText: "#1f2c2d",
    messageBubbleOwnText: "#1f2c2d",
    accent: "#92aaa5",
    accentHover: "#527d75",
    green: "#78b39b",
    greenText: "#246b49",
    danger: "#d57f86",
    dangerText: "#8e1d28",
    dangerHoverBg: "#f6c6c6",
    dangerInk: "#10181c",
  },
  black: {
    bg: "#000000",
    bgDeep: "#000000",
    bgSidebar: "#030303",
    bgElevated: "#090909",
    bgInput: "#101010",
    bgHover: "#181818",
    bgActive: "#222222",
    workspaceRail: "#000000",
    line: "#080808",
    lineSoft: "#292929",
    text: "#f5f5f5",
    textMuted: "#c2c2c2",
    textFaint: "#9b9b9b",
    textPlaceholder: "#929292",
    messageBubble: "#171d22",
    messageBubbleOwn: "#202a30",
    messageBubbleText: "#f5f5f5",
    messageBubbleOwnText: "#f5f5f5",
    accent: "#92aaa5",
    accentHover: "#a7bdb7",
    green: "#78b39b",
    greenText: "#96d7b4",
    danger: "#d57f86",
    dangerText: "#ffb3b5",
    dangerHoverBg: "#60343a",
    dangerInk: "#10181c",
  },
  momotalk: {
    bg: "#ffffff",
    bgDeep: "#e2e9ef",
    bgSidebar: "#e9e6f4",
    bgElevated: "#fbfaff",
    bgInput: "#f5f3fb",
    bgHover: "#ded9ef",
    bgActive: "#d1cae8",
    workspaceRail: "#536d80",
    line: "#c9c5d9",
    lineSoft: "#d6d2e4",
    text: "#263548",
    textMuted: "#526176",
    textFaint: "#67758b",
    textPlaceholder: "#737f94",
    messageBubble: "#43586d",
    messageBubbleOwn: "#536d82",
    messageBubbleText: "#ffffff",
    messageBubbleOwnText: "#ffffff",
    accent: "#ed8ca7",
    accentHover: "#d96f90",
    green: "#498968",
    greenText: "#246b49",
    danger: "#d45b74",
    dangerText: "#8e1d36",
    dangerHoverBg: "#f4c8d2",
    dangerInk: "#ffffff",
  },
};

export function setThemeBasePalette(theme: CustomThemePreset, baseTheme: AppTheme): CustomThemePreset {
  const colors = builtInThemeColors[baseTheme];
  return {
    ...theme,
    baseTheme,
    colors: { ...colors },
    design: {
      ...theme.design,
      gradientStart: colors.bg,
      gradientEnd: colors.bgDeep,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const enumValue = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && allowed.includes(value as T);

export function normalizeThemeDesign(value: unknown, options: { allowLocalImage?: boolean; baseTheme?: AppTheme } = {}): ThemeDesign | undefined {
  const base = builtInThemeColors[options.baseTheme ?? "dark"];
  if (value === undefined) return { ...defaultThemeDesign, gradientStart: base.bg, gradientEnd: base.bgDeep };
  if (!isRecord(value)) return undefined;
  const backgroundMode = enumValue(value.backgroundMode, ["solid", "gradient", "image"] as const) ? value.backgroundMode : undefined;
  const imageFit = enumValue(value.imageFit, ["cover", "contain"] as const) ? value.imageFit : undefined;
  const imagePosition = enumValue(value.imagePosition, ["center", "top", "bottom"] as const) ? value.imagePosition : undefined;
  const contentWidth = enumValue(value.contentWidth, ["narrow", "comfortable", "wide"] as const) ? value.contentWidth : undefined;
  const density = enumValue(value.density, ["compact", "comfortable", "spacious"] as const) ? value.density : undefined;
  const borderStyle = enumValue(value.borderStyle, ["none", "subtle", "solid", "dashed"] as const) ? value.borderStyle : undefined;
  const shadow = enumValue(value.shadow, ["none", "soft", "deep"] as const) ? value.shadow : undefined;
  const motion = enumValue(value.motion, ["none", "fade", "slide", "pop"] as const) ? value.motion : undefined;
  const transitionSpeed = enumValue(value.transitionSpeed, ["quick", "balanced", "slow"] as const) ? value.transitionSpeed : undefined;
  const transitionEasing = enumValue(value.transitionEasing, ["standard", "smooth", "spring"] as const) ? value.transitionEasing : undefined;
  const gradientStart = normalizeThemeHex(value.gradientStart);
  const gradientEnd = normalizeThemeHex(value.gradientEnd);
  const gradientAngle = value.gradientAngle;
  const overlay = value.overlay;
  const radius = value.radius;
  if (!backgroundMode || !imageFit || !imagePosition || !contentWidth || !density || !borderStyle || !shadow || !motion || !transitionSpeed || !transitionEasing
    || !gradientStart || !gradientEnd
    || typeof gradientAngle !== "number" || ![0, 45, 90, 135, 180, 225, 270, 315].includes(gradientAngle)
    || typeof overlay !== "number" || !Number.isInteger(overlay) || overlay < 0 || overlay > 80
    || typeof radius !== "number" || !Number.isInteger(radius) || radius < 0 || radius > 28) return undefined;

  const result: ThemeDesign = {
    backgroundMode,
    gradientStart,
    gradientEnd,
    gradientAngle,
    imageFit,
    imagePosition,
    overlay,
    contentWidth,
    density,
    radius,
    borderStyle,
    shadow,
    motion,
    transitionSpeed,
    transitionEasing,
  };
  if (value.backgroundImageAssetId !== undefined) {
    if (!options.allowLocalImage || typeof value.backgroundImageAssetId !== "string" || !/^theme-image-[a-z0-9-]{1,80}$/i.test(value.backgroundImageAssetId)) return undefined;
    result.backgroundImageAssetId = value.backgroundImageAssetId;
  }
  return result;
}

export function normalizeThemeHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex.toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase() : undefined;
}

export function normalizeThemeColors(value: unknown, baseTheme: AppTheme = "dark"): ThemeColors | undefined {
  if (!isRecord(value)) return undefined;
  const colors = {} as ThemeColors;
  for (const { key } of themeColorTokens) {
    // Theme codes created before message bubbles were customizable don't
    // include these fields. Backfill them from that theme's current palette.
    const legacyBuiltInColor = key === "workspaceRail" || key === "messageBubble" || key === "messageBubbleOwn"
      || key === "messageBubbleText" || key === "messageBubbleOwnText"
      ? builtInThemeColors[baseTheme][key]
      : undefined;
    const color = normalizeThemeHex(value[key]) ?? (value[key] === undefined ? legacyBuiltInColor : undefined);
    if (!color) return undefined;
    colors[key] = color;
  }
  return colors;
}

export function normalizeCustomThemePresets(value: unknown): CustomThemePreset[] {
  if (!Array.isArray(value)) return [];
  const result: CustomThemePreset[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (result.length >= MAX_CUSTOM_THEME_PRESETS) break;
    if (!isRecord(candidate)) continue;
    const { id, name, baseTheme } = candidate;
    if (typeof id !== "string" || !/^custom-[a-z0-9-]{1,80}$/i.test(id) || ids.has(id)) continue;
    if (typeof name !== "string" || !name.trim() || name.trim().length > MAX_THEME_NAME_LENGTH) continue;
    if (baseTheme !== "dark" && baseTheme !== "dim" && baseTheme !== "light" && baseTheme !== "black" && baseTheme !== "momotalk") continue;
    const colors = normalizeThemeColors(candidate.colors, baseTheme);
    if (!colors) continue;
    const design = normalizeThemeDesign(candidate.design, { allowLocalImage: true, baseTheme });
    if (!design) continue;
    ids.add(id);
    result.push({ id, name: name.trim(), baseTheme, colors, design });
  }
  return result;
}

export function cloneCustomThemePresets(themes: readonly CustomThemePreset[]): CustomThemePreset[] {
  return themes.map((theme) => ({ ...theme, colors: { ...theme.colors }, design: { ...theme.design } }));
}

export function readThemeColors(element: Element): ThemeColors {
  const computed = getComputedStyle(element);
  const colors = {} as ThemeColors;
  for (const { key, variable } of themeColorTokens) {
    colors[key] = normalizeThemeHex(computed.getPropertyValue(variable)) ?? builtInThemeColors.dark[key];
  }
  return colors;
}

export function exportSharedTheme(theme: SharedThemePreset): string {
  const design = { ...theme.design, backgroundImageAssetId: undefined } as SharedThemeDesign;
  if (design.backgroundMode === "image") design.backgroundMode = "solid";
  return JSON.stringify({ format: "naigi-theme", version: 2, ...theme, design });
}

export function exportThemePackage(theme: SharedThemePreset, backgroundImage?: { mimeType: typeof themeImageMimeTypes[number]; base64: string }): string {
  const design = { ...theme.design };
  if (backgroundImage && theme.design.backgroundMode === "image") {
    if (!themeImageMimeTypes.includes(backgroundImage.mimeType)
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(backgroundImage.base64)
      || backgroundImage.base64.length === 0
      || backgroundImage.base64.length > Math.ceil(MAX_THEME_IMAGE_BYTES / 3) * 4) {
      throw new Error("The theme package background image is invalid or too large.");
    }
    return JSON.stringify({ format: "naigi-theme", version: 2, ...theme, design, backgroundImage });
  }
  return exportSharedTheme(theme);
}

export function importSharedTheme(source: string): ImportedSharedThemePreset {
  if (source.length > MAX_THEME_PACKAGE_LENGTH) throw new Error("Theme file is too large.");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Theme code must be valid JSON.");
  }
  if (!isRecord(value) || value.format !== "naigi-theme" || value.version !== 1 && value.version !== 2) {
    throw new Error("This is not a supported Naigi theme code.");
  }
  if (source.length > MAX_SHARED_THEME_LENGTH && value.backgroundImage === undefined) throw new Error("Theme code is too large.");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > MAX_THEME_NAME_LENGTH) throw new Error("Theme names must be 1–48 characters long.");
  const baseTheme = value.baseTheme;
  if (baseTheme !== "dark" && baseTheme !== "dim" && baseTheme !== "light" && baseTheme !== "black" && baseTheme !== "momotalk") {
    throw new Error("The shared theme has an unsupported base appearance.");
  }
  const colors = normalizeThemeColors(value.colors, baseTheme);
  if (!colors) throw new Error("The shared theme contains missing or invalid colors.");
  const rawDesign = value.version === 1 ? undefined : value.design;
  const design = normalizeThemeDesign(rawDesign, { baseTheme });
  if (!design) throw new Error("The shared theme contains unsupported design settings.");
  let backgroundImage: ImportedSharedThemePreset["backgroundImage"];
  if (value.backgroundImage !== undefined) {
    if (!isRecord(value.backgroundImage) || !themeImageMimeTypes.includes(value.backgroundImage.mimeType as typeof themeImageMimeTypes[number])
      || typeof value.backgroundImage.base64 !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.backgroundImage.base64)
      || value.backgroundImage.base64.length === 0
      || value.backgroundImage.base64.length > Math.ceil(MAX_THEME_IMAGE_BYTES / 3) * 4) {
      throw new Error("The theme file contains an unsupported or oversized background image.");
    }
    backgroundImage = {
      mimeType: value.backgroundImage.mimeType as NonNullable<ImportedSharedThemePreset["backgroundImage"]>["mimeType"],
      base64: value.backgroundImage.base64,
    };
    if (design.backgroundMode !== "image") throw new Error("A packaged background image requires image mode in the theme design.");
  }
  if (design.backgroundMode === "image" && !backgroundImage) design.backgroundMode = "solid";
  return { name, baseTheme, colors, design, ...(backgroundImage ? { backgroundImage } : {}) };
}
