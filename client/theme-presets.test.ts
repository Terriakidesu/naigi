import { describe, expect, test } from "bun:test";
import {
  builtInThemeColors,
  defaultThemeDesign,
  exportSharedTheme,
  exportThemePackage,
  importSharedTheme,
  normalizeCustomThemePresets,
  normalizeThemeDesign,
  normalizeThemeColors,
  normalizeThemeHex,
  setThemeBasePalette,
  type CustomThemePreset,
} from "./theme-presets";

describe("custom theme presets", () => {
  const theme: CustomThemePreset = {
    id: "custom-test-theme",
    name: "Blue Moon",
    baseTheme: "black",
    colors: { ...builtInThemeColors.black, accent: "#4d86c6" },
    design: { ...defaultThemeDesign, gradientStart: "#000000", gradientEnd: "#101010" },
  };

  test("normalizes only fixed-format hex colors", () => {
    expect(normalizeThemeHex(" #ABC ")).toBe("#aabbcc");
    expect(normalizeThemeHex("#AABBCC")).toBe("#aabbcc");
    expect(normalizeThemeHex("url(https://example.com/x.css)")).toBeUndefined();
    expect(normalizeThemeColors({ ...theme.colors, bg: "var(--danger)" })).toBeUndefined();
  });

  test("keeps valid custom presets and skips malformed stored entries", () => {
    expect(normalizeCustomThemePresets([null, theme, { ...theme, id: "dark" }])).toEqual([theme]);
  });

  test("switches a custom preset to the selected base palette and refreshes its gradient stops", () => {
    const customized: CustomThemePreset = {
      ...theme,
      colors: { ...theme.colors, bg: "#112233", accent: "#445566" },
      design: {
        ...theme.design,
        backgroundMode: "gradient",
        gradientStart: "#112233",
        gradientEnd: "#445566",
        radius: 22,
      },
    };
    const updated = setThemeBasePalette(customized, "light");

    expect(updated.baseTheme).toBe("light");
    expect(updated.colors).toEqual(builtInThemeColors.light);
    expect(updated.design.gradientStart).toBe(builtInThemeColors.light.bg);
    expect(updated.design.gradientEnd).toBe(builtInThemeColors.light.bgDeep);
    expect(updated.design.backgroundMode).toBe("gradient");
    expect(updated.design.radius).toBe(22);
    expect(customized.baseTheme).toBe("black");
    expect(customized.colors.bg).toBe("#112233");
  });

  test("backfills design defaults for saved presets and rejects unsafe design values", () => {
    const legacy = { id: theme.id, name: theme.name, baseTheme: "light", colors: builtInThemeColors.light };
    const [normalized] = normalizeCustomThemePresets([legacy]);
    expect(normalized.design.backgroundMode).toBe("solid");
    expect(normalized.design.gradientStart).toBe(builtInThemeColors.light.bg);
    expect(normalizeThemeDesign({ ...defaultThemeDesign, radius: 90 })).toBeUndefined();
    expect(normalizeThemeDesign({ ...defaultThemeDesign, transitionEasing: "steps(1)" })).toBeUndefined();
  });

  test("exports and imports a portable theme without account preferences or preset IDs", () => {
    const shared = { name: theme.name, baseTheme: theme.baseTheme, colors: theme.colors, design: theme.design };
    const code = exportSharedTheme(shared);
    expect(importSharedTheme(code)).toEqual({
      name: theme.name,
      baseTheme: theme.baseTheme,
      colors: theme.colors,
      design: theme.design,
    });
  });

  test("imports legacy v1 codes with a safe default design profile", () => {
    const imported = importSharedTheme(JSON.stringify({
      format: "naigi-theme",
      version: 1,
      name: theme.name,
      baseTheme: theme.baseTheme,
      colors: theme.colors,
    }));
    expect(imported.design.gradientStart).toBe(builtInThemeColors.black.bg);
    expect(imported.design.backgroundMode).toBe("solid");
  });

  test("exports image-free share codes and accepts bounded image packages", () => {
    const shared = { name: theme.name, baseTheme: theme.baseTheme, colors: theme.colors, design: { ...theme.design, backgroundMode: "image" as const } };
    const code = exportSharedTheme(shared);
    expect(importSharedTheme(code).design.backgroundMode).toBe("solid");
    const packageCode = exportThemePackage(shared, { mimeType: "image/png", base64: "iVBORw0KGgo=" });
    expect(importSharedTheme(packageCode).backgroundImage?.mimeType).toBe("image/png");
    expect(importSharedTheme(packageCode).design.backgroundMode).toBe("image");
  });

  test("backfills the new message colors when importing an earlier share code", () => {
    const legacyColors = { ...theme.colors };
    delete (legacyColors as Partial<typeof legacyColors>).workspaceRail;
    delete (legacyColors as Partial<typeof legacyColors>).messageBubble;
    delete (legacyColors as Partial<typeof legacyColors>).messageBubbleOwn;
    delete (legacyColors as Partial<typeof legacyColors>).messageBubbleText;
    delete (legacyColors as Partial<typeof legacyColors>).messageBubbleOwnText;
    const imported = importSharedTheme(JSON.stringify({
      format: "naigi-theme",
      version: 1,
      name: theme.name,
      baseTheme: theme.baseTheme,
      colors: legacyColors,
    }));
    expect(imported.colors.messageBubble).toBe(builtInThemeColors.black.messageBubble);
    expect(imported.colors.messageBubbleText).toBe(builtInThemeColors.black.messageBubbleText);
  });

  test("rejects unsupported versions, unsafe colors, and oversized codes", () => {
    expect(() => importSharedTheme(JSON.stringify({ format: "naigi-theme", version: 3 }))).toThrow();
    const unsafe = JSON.parse(exportSharedTheme({ name: theme.name, baseTheme: theme.baseTheme, colors: theme.colors, design: theme.design }));
    unsafe.colors.bg = "url(https://example.com/theme.css)";
    expect(() => importSharedTheme(JSON.stringify(unsafe))).toThrow();
    unsafe.colors = theme.colors;
    unsafe.design.gradientStart = "url(https://example.com/theme.css)";
    expect(() => importSharedTheme(JSON.stringify(unsafe))).toThrow();
    unsafe.design = { ...theme.design, backgroundImageAssetId: "theme-image-remote" };
    expect(() => importSharedTheme(JSON.stringify(unsafe))).toThrow();
    unsafe.design = theme.design;
    unsafe.backgroundImage = { mimeType: "image/svg+xml", base64: "PHN2Zy8+" };
    expect(() => importSharedTheme(JSON.stringify(unsafe))).toThrow();
    unsafe.backgroundImage = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
    expect(() => importSharedTheme(JSON.stringify(unsafe))).toThrow();
    expect(() => importSharedTheme("x".repeat(20_001))).toThrow();
  });
});
