import { describe, expect, test } from "bun:test";
import { accentForAppPreferences, accentForeground, contrastRatio, DEFAULT_MESSAGE_TEXT_SIZE, isQuietHours, MAX_APP_SCALE, MAX_MESSAGE_TEXT_SIZE, MIN_APP_SCALE, MIN_MESSAGE_TEXT_SIZE, normalizeAppPreferences, readableAccentText, shouldNotifyAppMessage } from "./app-preferences";
import { builtInThemeColors } from "./theme-presets";

describe("theme text contrast", () => {
  test("chooses readable text for custom accent and hover colors", () => {
    expect(contrastRatio(accentForeground("#808080"), "#808080")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(accentForeground("#a7bdb7"), "#a7bdb7")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(accentForeground("#ffffff"), "#527d75")).toBeGreaterThanOrEqual(4.5);
  });

  test("keeps accent labels readable against active surfaces in each theme", () => {
    expect(contrastRatio(readableAccentText("#92aaa5", "dark"), "#33464d")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readableAccentText("#ff6a00", "light"), "#ccddda")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readableAccentText("#92aaa5", "black"), "#222222")).toBeGreaterThanOrEqual(4.5);
  });

  test("retains the OLED black theme when loading saved preferences", () => {
    expect(normalizeAppPreferences({ theme: "black" }).theme).toBe("black");
  });

  test("recognizes MomoTalk as a built-in light theme", () => {
    const preferences = normalizeAppPreferences({ theme: "momotalk", accent: "#92aaa5" });
    expect(preferences.theme).toBe("momotalk");
    expect(preferences.themePreset).toBe("momotalk");
    expect(accentForAppPreferences(preferences)).toBe("#ed8ca7");
    expect(contrastRatio("#ffffff", builtInThemeColors.momotalk.messageBubble)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ffffff", builtInThemeColors.momotalk.messageBubbleOwn)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readableAccentText("#ed8ca7", "momotalk"), "#d1cae8")).toBeGreaterThanOrEqual(4.5);
  });

  test("keeps a saved custom accent on non-MomoTalk themes", () => {
    const preferences = normalizeAppPreferences({ theme: "dark", accent: "#52a8d8" });
    expect(accentForAppPreferences(preferences)).toBe("#52a8d8");
  });

  test("selects a saved custom preset and uses its base appearance", () => {
    const customTheme = {
      id: "custom-test-theme",
      name: "Lavender chat",
      baseTheme: "light",
      colors: builtInThemeColors.light,
      design: {
        backgroundMode: "gradient" as const,
        gradientStart: "#ffffff",
        gradientEnd: "#ccddda",
        gradientAngle: 135,
        imageFit: "cover" as const,
        imagePosition: "center" as const,
        overlay: 35,
        contentWidth: "wide" as const,
        density: "spacious" as const,
        radius: 20,
        borderStyle: "solid" as const,
        shadow: "deep" as const,
        motion: "slide" as const,
        transitionSpeed: "slow" as const,
        transitionEasing: "spring" as const,
      },
    } as const;
    const preferences = normalizeAppPreferences({
      theme: "dark",
      themePreset: customTheme.id,
      customThemes: [customTheme],
    });

    expect(preferences.themePreset).toBe(customTheme.id);
    expect(preferences.theme).toBe("light");
    expect(preferences.customThemes).toHaveLength(1);
    expect(preferences.customThemes[0].design.contentWidth).toBe("wide");
    expect(preferences.customThemes[0].design.motion).toBe("slide");
  });

  test("allows custom presets to use MomoTalk as their base appearance", () => {
    const customTheme = {
      id: "custom-momo-variant",
      name: "My Momo colors",
      baseTheme: "momotalk",
      colors: builtInThemeColors.momotalk,
    } as const;
    const preferences = normalizeAppPreferences({ themePreset: customTheme.id, customThemes: [customTheme] });
    expect(preferences.theme).toBe("momotalk");
    expect(preferences.themePreset).toBe(customTheme.id);
  });
});

describe("interface scale preferences", () => {
  test("clamps below the supported minimum", () => {
    expect(normalizeAppPreferences({ scale: 0.5 }).scale).toBe(MIN_APP_SCALE);
  });

  test("supports scaling up to 200 percent", () => {
    expect(normalizeAppPreferences({ scale: 1.75 }).scale).toBe(1.75);
    expect(normalizeAppPreferences({ scale: 2.5 }).scale).toBe(MAX_APP_SCALE);
  });

  test("normalizes pixel message text size and migrates saved percentage preferences", () => {
    expect(normalizeAppPreferences({ messageTextSize: 8 }).messageTextSize).toBe(MIN_MESSAGE_TEXT_SIZE);
    expect(normalizeAppPreferences({ messageTextSize: 30 }).messageTextSize).toBe(MAX_MESSAGE_TEXT_SIZE);
    expect(normalizeAppPreferences({ messageTextSize: 18.4 }).messageTextSize).toBe(18);
    expect(normalizeAppPreferences({}).messageTextSize).toBe(DEFAULT_MESSAGE_TEXT_SIZE);
    expect(normalizeAppPreferences({ messageTextScale: 0.5 }).messageTextSize).toBe(12);
    expect(normalizeAppPreferences({ messageTextScale: 1.25 }).messageTextSize).toBe(18);
    expect(normalizeAppPreferences({ messageTextScale: 2 }).messageTextSize).toBe(22);
    expect(normalizeAppPreferences({}).autoLoadMedia).toBe(true);
    expect(normalizeAppPreferences({ autoLoadMedia: false }).autoLoadMedia).toBe(false);
  });

  test("handles same-day and overnight quiet-hour windows", () => {
    const quietHours = { quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "08:00" };
    expect(isQuietHours(quietHours, new Date(2026, 0, 1, 23, 30))).toBe(true);
    expect(isQuietHours(quietHours, new Date(2026, 0, 1, 7, 59))).toBe(true);
    expect(isQuietHours(quietHours, new Date(2026, 0, 1, 8, 0))).toBe(false);
    expect(isQuietHours({ ...quietHours, quietHoursStart: "09:00", quietHoursEnd: "17:00" }, new Date(2026, 0, 1, 12, 0))).toBe(true);
    expect(isQuietHours({ ...quietHours, quietHoursEnabled: false }, new Date(2026, 0, 1, 23, 30))).toBe(false);
  });

  test("notification modes honor mentions-only and quiet-hour settings", () => {
    const mentionsOnly = { ...normalizeAppPreferences({ notificationMode: "mentions" }), quietHoursEnabled: false };
    expect(shouldNotifyAppMessage(mentionsOnly, false)).toBe(false);
    expect(shouldNotifyAppMessage(mentionsOnly, true)).toBe(true);
    expect(shouldNotifyAppMessage({ ...mentionsOnly, notificationMode: "off" }, true)).toBe(false);
    expect(shouldNotifyAppMessage({ ...mentionsOnly, quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "08:00" }, true, new Date(2026, 0, 1, 23, 0))).toBe(false);
  });
});
