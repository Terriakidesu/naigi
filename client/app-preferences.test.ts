import { describe, expect, test } from "bun:test";
import { accentForeground, contrastRatio, DEFAULT_MESSAGE_TEXT_SIZE, isQuietHours, MAX_APP_SCALE, MAX_MESSAGE_TEXT_SIZE, MIN_APP_SCALE, MIN_MESSAGE_TEXT_SIZE, normalizeAppPreferences, readableAccentText, shouldNotifyAppMessage } from "./app-preferences";

describe("theme text contrast", () => {
  test("chooses readable text for custom accent and hover colors", () => {
    expect(contrastRatio(accentForeground("#808080"), "#808080")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(accentForeground("#a7bdb7"), "#a7bdb7")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(accentForeground("#ffffff"), "#527d75")).toBeGreaterThanOrEqual(4.5);
  });

  test("keeps accent labels readable against active surfaces in each theme", () => {
    expect(contrastRatio(readableAccentText("#92aaa5", "dark"), "#33464d")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readableAccentText("#ff6a00", "light"), "#ccddda")).toBeGreaterThanOrEqual(4.5);
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
