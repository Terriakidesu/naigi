import { ApiClient, ApiError } from "./api";
import { accentForeground, applyAppPreferences, applyThemeDesign as applyAppThemeDesign, contrastRatio, defaultAppPreferences, loadAppPreferences, readableAccentText, saveAppPreferences, type AppPreferences, type AppTheme } from "./app-preferences";
import {
  builtInThemeColors,
  cloneCustomThemePresets,
  defaultThemeDesign,
  exportSharedTheme,
  exportThemePackage,
  importSharedTheme,
  MAX_CUSTOM_THEME_PRESETS,
  MAX_THEME_IMAGE_BYTES,
  MAX_THEME_PACKAGE_LENGTH,
  MAX_THEME_NAME_LENGTH,
  normalizeThemeHex,
  setThemeBasePalette,
  themeImageMimeTypes,
  themeColorTokens,
  type CustomThemePreset,
  type ImportedSharedThemePreset,
  type SharedThemePreset,
  type ThemeColors,
  type ThemeDesign,
} from "./theme-presets";
import { deleteThemeBackgroundImages, readThemeBackgroundImage, saveThemeBackgroundImage } from "./theme-assets";
import { CryptoClient, LocalCryptoStoreError } from "./crypto";
import { iconElement, renderIcons } from "./icons";
import { clearLocalData } from "./local-data";
import { disableFcmPush, synchronizeFcmPush } from "./push-notifications";
import { cachedMessageCacheStats, clearCachedMessages } from "./message-cache";
import { setupProfileSettings } from "./profile-settings";
import { setupVoiceAudioSettings } from "./voice-audio-settings";
import { setupHistoryRecovery } from "./history-recovery-settings";
import { clearSessionPassphrase, forgetRememberedPassphrase, lockLocalSession } from "./unlock-vault";

type Device = {
  id: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
};

const api = new ApiClient();
const name = document.getElementById("settings-name") as HTMLElement;
const avatar = document.getElementById("settings-avatar") as HTMLElement;
const banner = document.getElementById("settings-banner") as HTMLElement;
const username = document.getElementById("settings-username") as HTMLElement;
const deviceList = document.getElementById("device-list") as HTMLElement;
const status = document.getElementById("settings-status") as HTMLElement;
const logout = document.getElementById("logout-button") as HTMLButtonElement;
const profileForm = document.getElementById("profile-form") as HTMLFormElement;
const displayNameInput = document.getElementById("settings-display-name") as HTMLInputElement;
const profileFormState = document.getElementById("profile-form-state") as HTMLElement;
const discardProfileChanges = document.getElementById("discard-profile-changes") as HTMLButtonElement;
const profileImageInput = document.getElementById("profile-image-input") as HTMLInputElement;
const removeProfileImage = document.getElementById("remove-profile-image") as HTMLButtonElement;
const profileBannerInput = document.getElementById("profile-banner-input") as HTMLInputElement;
const removeProfileBanner = document.getElementById("remove-profile-banner") as HTMLButtonElement;
const passwordForm = document.getElementById("password-form") as HTMLFormElement;
const currentPassword = document.getElementById("current-password") as HTMLInputElement;
const newPassword = document.getElementById("new-password") as HTMLInputElement;
const confirmPassword = document.getElementById("confirm-password") as HTMLInputElement;
const lockNow = document.getElementById("lock-now-button") as HTMLButtonElement;
const forgetDevice = document.getElementById("forget-device-button") as HTMLButtonElement;
const localUnlockStatus = document.getElementById("local-unlock-status") as HTMLElement;
const recoveryLocalPassphrase = document.getElementById("recovery-local-passphrase") as HTMLInputElement;
const recoveryExportPassphrase = document.getElementById("recovery-export-passphrase") as HTMLInputElement;
const recoveryExportConfirm = document.getElementById("recovery-export-confirm") as HTMLInputElement;
const exportRecoveryButton = document.getElementById("export-recovery-button") as HTMLButtonElement;
const recoveryFile = document.getElementById("recovery-file") as HTMLInputElement;
const recoveryImportPassphrase = document.getElementById("recovery-import-passphrase") as HTMLInputElement;
const importRecoveryButton = document.getElementById("import-recovery-button") as HTMLButtonElement;
const clearLocalDataButton = document.getElementById("clear-local-data-button") as HTMLButtonElement;
const messageCacheStatus = document.getElementById("message-cache-status") as HTMLElement;
const clearMessageCacheButton = document.getElementById("clear-message-cache-button") as HTMLButtonElement;
const blockedUsersList = document.getElementById("blocked-users-list") as HTMLElement;
const appPreferencesForm = document.getElementById("app-preferences-form") as HTMLFormElement;
const appTheme = document.getElementById("app-theme") as HTMLSelectElement;
const themePresetCards = document.getElementById("theme-preset-cards") as HTMLElement;
const appAccent = document.getElementById("app-accent") as HTMLInputElement;
const appAccentRow = document.getElementById("app-accent-row") as HTMLElement;
const createThemePresetButton = document.getElementById("create-theme-preset") as HTMLButtonElement;
const editThemePresetButton = document.getElementById("edit-theme-preset") as HTMLButtonElement;
const openThemeImportButton = document.getElementById("open-theme-import") as HTMLButtonElement;
const deleteThemePresetButton = document.getElementById("delete-theme-preset") as HTMLButtonElement;
const customThemeEditor = document.getElementById("custom-theme-editor") as HTMLDialogElement;
const customThemeEditorHeading = document.getElementById("custom-theme-editor-heading") as HTMLElement;
const closeThemeEditorButton = document.getElementById("close-theme-editor") as HTMLButtonElement;
const cancelThemeEditorButton = document.getElementById("cancel-theme-editor") as HTMLButtonElement;
const doneThemeEditorButton = document.getElementById("done-theme-editor") as HTMLButtonElement;
const customThemeName = document.getElementById("custom-theme-name") as HTMLInputElement;
const customThemeBase = document.getElementById("custom-theme-base") as HTMLSelectElement;
const themeColorControls = document.getElementById("theme-color-controls") as HTMLElement;
const themeContrastWarning = document.getElementById("theme-contrast-warning") as HTMLElement;
const themeBackgroundMode = document.getElementById("theme-background-mode") as HTMLSelectElement;
const themeGradientControls = document.getElementById("theme-gradient-controls") as HTMLElement;
const themeGradientStart = document.getElementById("theme-gradient-start") as HTMLInputElement;
const themeGradientEnd = document.getElementById("theme-gradient-end") as HTMLInputElement;
const themeGradientAngle = document.getElementById("theme-gradient-angle") as HTMLSelectElement;
const themeImageControls = document.getElementById("theme-image-controls") as HTMLElement;
const themeBackgroundFile = document.getElementById("theme-background-file") as HTMLInputElement;
const themeImageStatus = document.getElementById("theme-image-status") as HTMLElement;
const themeImageFit = document.getElementById("theme-image-fit") as HTMLSelectElement;
const themeImagePosition = document.getElementById("theme-image-position") as HTMLSelectElement;
const themeBackgroundOverlay = document.getElementById("theme-background-overlay") as HTMLInputElement;
const themeBackgroundOverlayValue = document.getElementById("theme-background-overlay-value") as HTMLOutputElement;
const removeThemeBackgroundButton = document.getElementById("remove-theme-background") as HTMLButtonElement;
const themeContentWidth = document.getElementById("theme-content-width") as HTMLSelectElement;
const themeDensity = document.getElementById("theme-density") as HTMLSelectElement;
const themeRadius = document.getElementById("theme-radius") as HTMLInputElement;
const themeRadiusValue = document.getElementById("theme-radius-value") as HTMLOutputElement;
const themeShadow = document.getElementById("theme-shadow") as HTMLSelectElement;
const themeBorderStyle = document.getElementById("theme-border-style") as HTMLSelectElement;
const themeMotion = document.getElementById("theme-motion") as HTMLSelectElement;
const themeTransitionSpeed = document.getElementById("theme-transition-speed") as HTMLSelectElement;
const themeTransitionEasing = document.getElementById("theme-transition-easing") as HTMLSelectElement;
const copyThemePresetButton = document.getElementById("copy-theme-preset") as HTMLButtonElement;
const downloadThemePresetButton = document.getElementById("download-theme-preset") as HTMLButtonElement;
const themeShareCodeDetails = document.getElementById("theme-share-code-details") as HTMLDetailsElement;
const themeExportCode = document.getElementById("theme-export-code") as HTMLTextAreaElement;
const themeImportDialog = document.getElementById("theme-import-dialog") as HTMLDialogElement;
const closeThemeImportButton = document.getElementById("close-theme-import") as HTMLButtonElement;
const cancelThemeImportButton = document.getElementById("cancel-theme-import") as HTMLButtonElement;
const themeImportCode = document.getElementById("theme-import-code") as HTMLTextAreaElement;
const themeImportFile = document.getElementById("theme-import-file") as HTMLInputElement;
const reviewThemeImportButton = document.getElementById("review-theme-import") as HTMLButtonElement;
const importThemePresetButton = document.getElementById("import-theme-preset") as HTMLButtonElement;
const themeImportStatus = document.getElementById("theme-import-status") as HTMLElement;
const themeImportReviewPanel = document.getElementById("theme-import-review-panel") as HTMLElement;
const themeImportPreviewName = document.getElementById("theme-import-preview-name") as HTMLElement;
const themeImportPreviewBase = document.getElementById("theme-import-preview-base") as HTMLElement;
const themeEditorPreview = document.getElementById("theme-editor-preview") as HTMLElement;
const themeImportPreview = document.getElementById("theme-import-preview") as HTMLElement;
const appScale = document.getElementById("app-scale") as HTMLInputElement;
const appScaleValue = document.getElementById("app-scale-value") as HTMLOutputElement;
const appMessageTextSize = document.getElementById("app-message-text-size") as HTMLInputElement;
const appMessageTextSizeValue = document.getElementById("app-message-text-size-value") as HTMLOutputElement;
const appMessageSizePreview = document.getElementById("app-message-size-preview") as HTMLElement;
const appMessageSizePreviewText = document.getElementById("app-message-size-preview-text") as HTMLElement;
const appSounds = document.getElementById("app-sounds") as HTMLInputElement;
const appAutoLoadMedia = document.getElementById("app-auto-load-media") as HTMLInputElement;
const appExternalPreviews = document.getElementById("app-external-previews") as HTMLInputElement;
const appEnterToSend = document.getElementById("app-enter-to-send") as HTMLInputElement;
const appCompactMessages = document.getElementById("app-compact-messages") as HTMLInputElement;
const appReducedMotion = document.getElementById("app-reduced-motion") as HTMLInputElement;
const appNotificationMode = document.getElementById("app-notification-mode") as HTMLSelectElement;
const appQuietHoursEnabled = document.getElementById("app-quiet-hours-enabled") as HTMLInputElement;
const appQuietHoursStart = document.getElementById("app-quiet-hours-start") as HTMLInputElement;
const appQuietHoursEnd = document.getElementById("app-quiet-hours-end") as HTMLInputElement;
const appPreferencesStatus = document.getElementById("app-preferences-status") as HTMLElement;
const discardAppPreferencesButton = document.getElementById("discard-app-preferences-button") as HTMLButtonElement;
const saveAppPreferencesButton = document.getElementById("save-app-preferences-button") as HTMLButtonElement;
const settingsLayout = document.getElementById("settings-layout") as HTMLElement;
const settingsSidebar = document.getElementById("settings-sidebar") as HTMLElement;
const mobileSidebarToggle = document.getElementById("settings-mobile-sidebar-toggle") as HTMLButtonElement;
const mobileSidebarClose = document.getElementById("settings-mobile-sidebar-close") as HTMLButtonElement;
const mobileSidebarBackdrop = document.getElementById("settings-mobile-sidebar-backdrop") as HTMLButtonElement;
const settingsPageTitle = document.getElementById("settings-page-title") as HTMLElement;
const settingsPageDescription = document.getElementById("settings-page-description") as HTMLElement;
let currentUserId: string | undefined;
let appPreferences: AppPreferences = { ...defaultAppPreferences };
let appPreferencesLoaded = false;
let draftCustomThemes: CustomThemePreset[] = [];
let builtInAccentDraft = defaultAppPreferences.accent;
let editorThemeId: string | undefined;
let editorThemeSnapshot: CustomThemePreset | undefined;
let editorThemeIsNew = false;
let editorPreviousSelection = "dark";
let stagedImportedTheme: ImportedSharedThemePreset | undefined;
let stagedImportedImage: Blob | undefined;
let stagedThemePreviewUrl: string | undefined;
const unsavedThemeImageIds = new Set<string>();
let recoveryCrypto: CryptoClient | undefined;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function setMobileSidebar(open: boolean, focusNavigation = false) {
  settingsLayout.classList.toggle("mobile-sidebar-open", open);
  mobileSidebarToggle.setAttribute("aria-expanded", String(open));
  mobileSidebarToggle.setAttribute("aria-label", open ? "Hide settings navigation" : "Show settings navigation");
  settingsSidebar.inert = window.matchMedia("(max-width: 760px)").matches && !open;
  if (open && focusNavigation && window.matchMedia("(max-width: 760px)").matches) {
    settingsSidebar.querySelector<HTMLElement>(".settings-nav-item.active")?.focus();
  }
}

function renderDevices(devices: Device[]) {
  deviceList.replaceChildren();
  if (devices.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No registered devices.";
    deviceList.append(empty);
    return;
  }
  for (const device of devices) {
    const row = document.createElement("div");
    row.className = "device-row";
    const icon = document.createElement("span");
    icon.className = "member-avatar device-icon";
    icon.append(iconElement("monitor"));
    renderIcons(icon);
    const copy = document.createElement("div");
    copy.className = "device-copy";
    const title = document.createElement("strong");
    title.textContent = device.name || "Browser device";
    const details = document.createElement("span");
    details.textContent = `${device.id} · added ${new Date(device.createdAt).toLocaleDateString()}`;
    copy.append(title, details);
    row.append(icon, copy);
    if (device.revokedAt) {
      const revoked = document.createElement("span");
      revoked.className = "device-revoked";
      revoked.textContent = "Revoked";
      row.append(revoked);
    } else {
      const revoke = document.createElement("button");
      revoke.className = "secondary device-revoke";
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", async () => {
        if (!window.confirm(`Revoke ${device.name || "this browser"}? It will lose future server access, but locally stored keys cannot be erased remotely.`)) return;
        revoke.disabled = true;
        try {
          await api.revokeDevice(device.id);
          await loadDevices();
          setStatus("Device revoked.");
        } catch (error) {
          revoke.disabled = false;
          setStatus(error instanceof Error ? error.message : "Unable to revoke device.", true);
        }
      });
      row.append(revoke);
    }
    deviceList.append(row);
  }
}

function currentSettingsHash() {
  const requestedHash = window.location.hash === "#app" ? "#appearance" : window.location.hash || "#profile";
  const views = [...document.querySelectorAll<HTMLElement>("[data-settings-view]")];
  return views.some((view) => `#${view.id}` === requestedHash) ? requestedHash : "#profile";
}

let lastSettingsHash = currentSettingsHash();

function syncSettingsNav() {
  const hash = currentSettingsHash();
  appPreferencesForm.hidden = !["#appearance", "#accessibility", "#chat-media", "#notifications"].includes(hash);
  const views = [...document.querySelectorAll<HTMLElement>("[data-settings-view]")];
  for (const view of views) view.hidden = `#${view.id}` !== hash;
  let activeLink: HTMLAnchorElement | undefined;
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".settings-nav-item")) {
    const active = link.hash === hash;
    link.classList.toggle("active", active);
    if (active) {
      activeLink = link;
      link.setAttribute("aria-current", "location");
    }
    else link.removeAttribute("aria-current");
  }
  settingsPageTitle.textContent = activeLink?.dataset.title ?? "Settings";
  settingsPageDescription.textContent = activeLink?.dataset.description ?? "Manage your Naigi account and this browser.";
}

for (const link of document.querySelectorAll<HTMLAnchorElement>(".settings-nav-item")) {
  link.addEventListener("click", (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const targetHash = link.hash;
    if (currentSettingsHash() !== targetHash && appPreferencesAreDirty()) {
      event.preventDefault();
      void (async () => {
        if (!await resolveAppPreferencesBeforeLeave()) return;
        if (window.matchMedia("(max-width: 760px)").matches) setMobileSidebar(false);
        window.location.hash = targetHash;
      })();
      return;
    }
    if (window.matchMedia("(max-width: 760px)").matches) setMobileSidebar(false);
  });
}

window.addEventListener("hashchange", () => {
  const nextHash = currentSettingsHash();
  const previousHash = lastSettingsHash;
  if (previousHash !== nextHash && appPreferencesAreDirty()) {
    void (async () => {
      if (!await resolveAppPreferencesBeforeLeave()) {
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${previousHash}`);
        syncSettingsNav();
        return;
      }
      lastSettingsHash = nextHash;
      syncSettingsNav();
    })();
    return;
  }
  lastSettingsHash = nextHash;
  syncSettingsNav();
});
syncSettingsNav();
for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href="/app"]')) {
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !appPreferencesAreDirty()) return;
    event.preventDefault();
    void resolveAppPreferencesBeforeLeave().then((leave) => {
      if (leave) window.location.assign(link.href);
    }).catch((error) => setStatus(error instanceof Error ? error.message : "Unable to close settings."));
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || event.repeat || event.isComposing
    || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || document.querySelector("dialog[open]")) return;
  event.preventDefault();
  document.querySelector<HTMLAnchorElement>(".settings-close-button")?.click();
});
mobileSidebarToggle.addEventListener("click", () => {
  setMobileSidebar(!settingsLayout.classList.contains("mobile-sidebar-open"), true);
});
mobileSidebarClose.addEventListener("click", () => {
  setMobileSidebar(false);
  mobileSidebarToggle.focus();
});
mobileSidebarBackdrop.addEventListener("click", () => {
  setMobileSidebar(false);
  mobileSidebarToggle.focus();
});
window.addEventListener("resize", () => setMobileSidebar(settingsLayout.classList.contains("mobile-sidebar-open")));
setMobileSidebar(settingsLayout.classList.contains("mobile-sidebar-open"));
renderIcons();

const builtInThemeOptions: Array<{ id: AppTheme; name: string }> = [
  { id: "dark", name: "Dark" },
  { id: "dim", name: "Dim" },
  { id: "light", name: "Light" },
  { id: "black", name: "Black (OLED)" },
  { id: "momotalk", name: "MomoTalk" },
];

function selectedCustomTheme() {
  return draftCustomThemes.find((theme) => theme.id === appTheme.value);
}

function isAppTheme(value: string): value is AppTheme {
  return value === "dark" || value === "dim" || value === "light" || value === "black" || value === "momotalk";
}

function renderThemeOptions(selectedId: string) {
  appTheme.replaceChildren();
  const builtIns = document.createElement("optgroup");
  builtIns.label = "Built-in themes";
  for (const theme of builtInThemeOptions) {
    const option = document.createElement("option");
    option.value = theme.id;
    option.textContent = theme.name;
    builtIns.append(option);
  }
  appTheme.append(builtIns);
  if (draftCustomThemes.length > 0) {
    const custom = document.createElement("optgroup");
    custom.label = "Your presets";
    for (const theme of draftCustomThemes) {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.name;
      custom.append(option);
    }
    appTheme.append(custom);
  }
  appTheme.value = selectedId;
  renderThemeCards(selectedId);
}

function colorsForPreset(id: string): ThemeColors {
  const customTheme = draftCustomThemes.find((theme) => theme.id === id);
  if (customTheme) return customTheme.colors;
  if (!isAppTheme(id)) return builtInThemeColors.dark;
  const colors = { ...builtInThemeColors[id] };
  if (id !== "momotalk") colors.accent = builtInAccentDraft;
  return colors;
}

function renderThemeCards(selectedId: string) {
  themePresetCards.replaceChildren();
  const choices = [
    ...builtInThemeOptions.map((theme) => ({ id: theme.id, name: theme.name, description: "Built-in theme" })),
    ...draftCustomThemes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      description: `${builtInThemeOptions.find((item) => item.id === theme.baseTheme)?.name ?? "Theme"} · custom`,
    })),
  ];
  for (const choice of choices) {
    const colors = colorsForPreset(choice.id);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "theme-preset-card";
    card.dataset.themeId = choice.id;
    card.setAttribute("aria-pressed", String(choice.id === selectedId));
    card.addEventListener("click", () => selectThemePreset(choice.id));

    const sample = document.createElement("span");
    sample.className = "theme-card-sample";
    sample.setAttribute("aria-hidden", "true");
    for (const [property, value] of Object.entries({
      "--card-bg": colors.bg,
      "--card-sidebar": colors.bgSidebar,
      "--card-rail": colors.workspaceRail,
      "--card-accent": colors.accent,
      "--card-bubble": colors.messageBubble,
    })) sample.style.setProperty(property, value);
    const sampleRail = document.createElement("i");
    const sampleSide = document.createElement("i");
    const sampleChat = document.createElement("i");
    sample.append(sampleRail, sampleSide, sampleChat);

    const copy = document.createElement("span");
    copy.className = "theme-preset-card-copy";
    const title = document.createElement("strong");
    title.textContent = choice.name;
    const description = document.createElement("small");
    description.textContent = choice.description;
    copy.append(title, description);

    const check = document.createElement("span");
    check.className = "theme-preset-card-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";
    card.append(sample, copy, check);
    themePresetCards.append(card);
  }
}

function selectThemePreset(id: string) {
  if (appTheme.value === id) return;
  appTheme.value = id;
  invalidateThemeShareCode();
  renderThemeCards(id);
  renderCustomThemeEditor();
  syncAppPreferencesDirty();
}

function createThemePreviewMarkup(preview: HTMLElement) {
  if (preview.firstElementChild) return;
  const window = document.createElement("div");
  window.className = "theme-preview-window";
  const topbar = document.createElement("header");
  topbar.className = "theme-preview-titlebar";
  const title = document.createElement("strong");
  title.className = "theme-preview-title";
  const windowAction = document.createElement("span");
  windowAction.className = "theme-preview-window-action";
  windowAction.textContent = "×";
  topbar.append(title, windowAction);

  const body = document.createElement("div");
  body.className = "theme-preview-body";
  const rail = document.createElement("aside");
  rail.className = "theme-preview-rail";
  for (const text of ["N", "✦", "＋"]) {
    const item = document.createElement("span");
    item.textContent = text;
    rail.append(item);
  }
  const sidebar = document.createElement("aside");
  sidebar.className = "theme-preview-sidebar";
  const sidebarHeading = document.createElement("strong");
  sidebarHeading.textContent = "Messages";
  const rows = document.createElement("div");
  rows.className = "theme-preview-list";
  for (const [person, subtitle] of [["Riley", "See you soon"], ["Kai", "That looks great"], ["Studio", "3 new updates"]]) {
    const row = document.createElement("div");
    row.className = "theme-preview-list-row";
    const avatar = document.createElement("i");
    avatar.textContent = person[0];
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = person;
    const previewText = document.createElement("small");
    previewText.textContent = subtitle;
    text.append(name, previewText);
    row.append(avatar, text);
    rows.append(row);
  }
  sidebar.append(sidebarHeading, rows);
  const sidebarSurface = document.createElement("div");
  sidebarSurface.className = "theme-preview-surface-samples";
  const raisedSurface = document.createElement("span");
  raisedSurface.textContent = "Raised surface";
  const hoverSurface = document.createElement("span");
  hoverSurface.textContent = "Hover state";
  const success = document.createElement("span");
  success.className = "theme-preview-success";
  success.textContent = "Online";
  const danger = document.createElement("span");
  danger.className = "theme-preview-danger";
  danger.textContent = "Remove";
  sidebarSurface.append(raisedSurface, hoverSurface, success, danger);
  sidebar.append(sidebarSurface);

  const chat = document.createElement("section");
  chat.className = "theme-preview-chat";
  const chatHeader = document.createElement("header");
  chatHeader.className = "theme-preview-chat-header";
  const chatTitle = document.createElement("strong");
  chatTitle.textContent = "# lobby";
  const chatStatus = document.createElement("small");
  chatStatus.textContent = "2 members · encrypted";
  chatHeader.append(chatTitle, chatStatus);
  const messages = document.createElement("div");
  messages.className = "theme-preview-messages";
  const received = document.createElement("div");
  received.className = "theme-preview-message theme-preview-received";
  received.textContent = "Hey! What do you think of this?";
  const sent = document.createElement("div");
  sent.className = "theme-preview-message theme-preview-sent";
  sent.textContent = "Love it ✨";
  messages.append(received, sent);
  const composer = document.createElement("div");
  composer.className = "theme-preview-composer";
  composer.textContent = "Message this conversation…";
  const statuses = document.createElement("div");
  statuses.className = "theme-preview-statuses";
  const successStatus = document.createElement("span");
  successStatus.className = "theme-preview-success-status";
  successStatus.textContent = "Saved";
  const dangerStatus = document.createElement("span");
  dangerStatus.className = "theme-preview-danger-status";
  dangerStatus.textContent = "Needs attention";
  statuses.append(successStatus, dangerStatus);
  chat.append(chatHeader, messages, composer, statuses);
  body.append(rail, sidebar, chat);
  const palette = document.createElement("div");
  palette.className = "theme-preview-palette";
  palette.setAttribute("aria-label", "Every theme color token");
  for (const token of themeColorTokens) {
    const item = document.createElement("div");
    item.className = "theme-preview-palette-item";
    item.dataset.colorKey = token.key;
    const swatch = document.createElement("i");
    swatch.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = token.label;
    const value = document.createElement("code");
    item.append(swatch, label, value);
    palette.append(item);
  }
  const designSummary = document.createElement("div");
  designSummary.className = "theme-preview-design-summary";
  window.append(topbar, body, palette, designSummary);
  preview.replaceChildren(window);
}

function renderThemePreview(preview: HTMLElement, name: string, baseTheme: AppTheme, colors: ThemeColors, design: ThemeDesign = defaultThemeDesign) {
  createThemePreviewMarkup(preview);
  const frame = preview.firstElementChild as HTMLElement;
  frame.dataset.appTheme = baseTheme;
  frame.style.colorScheme = baseTheme === "light" || baseTheme === "momotalk" ? "light" : "dark";
  for (const { key, variable } of themeColorTokens) frame.style.setProperty(variable, colors[key]);
  frame.style.setProperty("--accent-ink", accentForeground(colors.accent));
  frame.style.setProperty("--accent-hover-ink", accentForeground(colors.accentHover));
  frame.style.setProperty("--accent-text", readableAccentText(colors.accent, baseTheme));
  frame.style.setProperty("--workspace-rail-ink", accentForeground(colors.workspaceRail));
  applyAppThemeDesign(frame, design, true);
  const title = frame.querySelector<HTMLElement>(".theme-preview-title");
  if (title) title.textContent = name.trim() || "Untitled theme";
  for (const token of themeColorTokens) {
    const item = frame.querySelector<HTMLElement>(`.theme-preview-palette-item[data-color-key="${token.key}"]`);
    if (!item) continue;
    const swatch = item.querySelector<HTMLElement>("i");
    const value = item.querySelector<HTMLElement>("code");
    if (swatch) swatch.style.backgroundColor = colors[token.key];
    if (value) value.textContent = colors[token.key].toUpperCase();
    item.title = `${token.label}: ${colors[token.key].toUpperCase()}`;
  }
  const background = design.backgroundMode === "solid"
    ? "Solid"
    : design.backgroundMode === "gradient"
      ? `Gradient · ${design.gradientAngle}° · ${design.gradientStart.toUpperCase()} → ${design.gradientEnd.toUpperCase()}`
      : `Image · ${design.imageFit === "cover" ? "Fill area" : "Fit inside"} · ${design.imagePosition} · ${design.overlay}% overlay`;
  const specs: [string, string][] = [
    ["Starting palette", builtInThemeOptions.find((theme) => theme.id === baseTheme)?.name ?? baseTheme],
    ["Backdrop", background],
    ["Message width", design.contentWidth],
    ["Spacing", design.density],
    ["Corners", `${design.radius}px`],
    ["Borders", design.borderStyle],
    ["Shadows", design.shadow],
    ["Entrance", design.motion],
    ["Transition", `${design.transitionSpeed} · ${design.transitionEasing}`],
  ];
  const summary = frame.querySelector<HTMLElement>(".theme-preview-design-summary");
  summary?.replaceChildren(...specs.map(([label, value]) => {
    const item = document.createElement("span");
    item.className = "theme-preview-design-chip";
    const key = document.createElement("strong");
    key.textContent = `${label}: `;
    item.append(key, document.createTextNode(value));
    return item;
  }));
}

function renderThemeDesignControls(theme?: CustomThemePreset) {
  if (!theme) return;
  const design = theme.design;
  themeBackgroundMode.value = design.backgroundMode;
  themeGradientControls.hidden = design.backgroundMode !== "gradient";
  themeImageControls.hidden = design.backgroundMode !== "image";
  themeGradientStart.value = design.gradientStart;
  themeGradientEnd.value = design.gradientEnd;
  themeGradientAngle.value = String(design.gradientAngle);
  themeImageFit.value = design.imageFit;
  themeImagePosition.value = design.imagePosition;
  themeBackgroundOverlay.value = String(design.overlay);
  themeBackgroundOverlayValue.value = `${design.overlay}%`;
  themeImageStatus.textContent = design.backgroundImageAssetId
    ? "Background image ready. It stays in this browser unless you include it in a theme file."
    : "PNG, JPEG, or WebP up to 1 MB. Stored in this browser only.";
  removeThemeBackgroundButton.hidden = !design.backgroundImageAssetId;
  removeThemeBackgroundButton.disabled = !design.backgroundImageAssetId;
  themeContentWidth.value = design.contentWidth;
  themeDensity.value = design.density;
  themeRadius.value = String(design.radius);
  themeRadiusValue.value = `${design.radius} px`;
  themeShadow.value = design.shadow;
  themeBorderStyle.value = design.borderStyle;
  themeMotion.value = design.motion;
  themeTransitionSpeed.value = design.transitionSpeed;
  themeTransitionEasing.value = design.transitionEasing;
}

function updateSelectedThemeDesign(update: Partial<ThemeDesign>) {
  const theme = selectedCustomTheme();
  if (!theme) return;
  Object.assign(theme.design, update);
  renderThemeDesignControls(theme);
  renderThemePreview(themeEditorPreview, theme.name, theme.baseTheme, theme.colors, theme.design);
  invalidateThemeShareCode();
  syncAppPreferencesDirty();
}

function newThemeImageAssetId() {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `theme-image-${random}`;
}

async function validateThemeImage(image: Blob, mimeType: string) {
  if (!themeImageMimeTypes.includes(mimeType as typeof themeImageMimeTypes[number])) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }
  if (image.size === 0 || image.size > MAX_THEME_IMAGE_BYTES) throw new Error("Theme background images must be 1 MB or smaller.");
  const header = new Uint8Array(await image.slice(0, 12).arrayBuffer());
  const signatureMatches = mimeType === "image/png"
    ? header.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)
    : mimeType === "image/jpeg"
      ? header.length >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255
      : header.length >= 12 && String.fromCharCode(...header.slice(0, 4)) === "RIFF" && String.fromCharCode(...header.slice(8, 12)) === "WEBP";
  if (!signatureMatches) throw new Error("The image file type does not match its contents.");
  if (typeof createImageBitmap === "undefined") throw new Error("This browser cannot safely preview theme images.");
  const bitmap = await createImageBitmap(image);
  try {
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 25_000_000) {
      throw new Error("Theme background images must be no larger than 8192 × 8192 pixels.");
    }
  } finally {
    bitmap.close();
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToThemeImage(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

function themeImageIds(themes: readonly CustomThemePreset[]) {
  return new Set(themes.map((theme) => theme.design.backgroundImageAssetId).filter((id): id is string => Boolean(id)));
}

async function discardUnreferencedDraftThemeImages() {
  const referenced = themeImageIds([...appPreferences.customThemes, ...draftCustomThemes]);
  const abandoned = [...unsavedThemeImageIds].filter((id) => !referenced.has(id));
  if (abandoned.length === 0) return;
  await deleteThemeBackgroundImages(abandoned);
  for (const id of abandoned) unsavedThemeImageIds.delete(id);
}

async function onThemeBackgroundFile() {
  const file = themeBackgroundFile.files?.[0];
  themeBackgroundFile.value = "";
  const theme = selectedCustomTheme();
  if (!file || !theme) return;
  themeImageStatus.textContent = "Checking image…";
  try {
    await validateThemeImage(file, file.type);
    const id = newThemeImageAssetId();
    await saveThemeBackgroundImage(id, file);
    unsavedThemeImageIds.add(id);
    updateSelectedThemeDesign({ backgroundMode: "image", backgroundImageAssetId: id });
    themeImageStatus.textContent = "Background image ready. It stays in this browser unless you include it in a theme file.";
  } catch (error) {
    themeImageStatus.textContent = error instanceof Error ? error.message : "Unable to use that image.";
    setStatus(themeImageStatus.textContent, true);
  }
}

function sharedThemeForSelected(): SharedThemePreset | undefined {
  const theme = selectedCustomTheme();
  if (!theme) return undefined;
  const name = theme.name.trim();
  if (!name || name.length > MAX_THEME_NAME_LENGTH) {
    setStatus(`Preset names must be 1–${MAX_THEME_NAME_LENGTH} characters long.`, true);
    customThemeName.focus();
    return undefined;
  }
  const { backgroundImageAssetId: _localAsset, ...design } = theme.design;
  if (design.backgroundMode === "image") design.backgroundMode = "solid";
  return { name, baseTheme: theme.baseTheme, colors: { ...theme.colors }, design };
}

async function themePackageForSelected() {
  const theme = selectedCustomTheme();
  const shared = sharedThemeForSelected();
  if (!theme || !shared) return undefined;
  const imageId = theme.design.backgroundImageAssetId;
  if (theme.design.backgroundMode !== "image" || !imageId) return exportThemePackage(shared);
  const image = await readThemeBackgroundImage(imageId);
  if (!image || !themeImageMimeTypes.includes(image.type as typeof themeImageMimeTypes[number])) {
    throw new Error("The local background image is unavailable. Choose it again before exporting the theme file.");
  }
  const base64 = bytesToBase64(new Uint8Array(await image.arrayBuffer()));
  const packagedDesign = { ...theme.design };
  delete packagedDesign.backgroundImageAssetId;
  return exportThemePackage({ ...shared, design: packagedDesign }, { mimeType: image.type as typeof themeImageMimeTypes[number], base64 });
}

function renderThemeColorControls(theme?: CustomThemePreset) {
  themeColorControls.replaceChildren();
  if (!theme) return;
  let activeGroup: string | undefined;
  let groupFields: HTMLElement | undefined;
  for (const token of themeColorTokens) {
    if (token.group !== activeGroup) {
      activeGroup = token.group;
      groupFields = document.createElement("div");
      groupFields.className = "theme-color-fields";
      if (token.group === "Status") {
        const advancedDetails = document.createElement("details");
        advancedDetails.className = "theme-color-advanced";
        const summary = document.createElement("summary");
        summary.textContent = "Advanced · status colors";
        advancedDetails.append(summary, groupFields);
        themeColorControls.append(advancedDetails);
      } else {
        const group = document.createElement("details");
        group.className = "theme-color-group";
        group.open = token.group === "Surfaces";
        const summary = document.createElement("summary");
        summary.textContent = token.group;
        group.append(summary, groupFields);
        themeColorControls.append(group);
      }
    }
    const control = document.createElement("div");
    control.className = "theme-color-control";
    const label = document.createElement("label");
    label.className = "theme-color-label";
    label.textContent = token.label;
    const fields = document.createElement("span");
    fields.className = "theme-color-inputs";
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = theme.colors[token.key];
    colorInput.id = `theme-color-${token.key}`;
    label.htmlFor = colorInput.id;
    colorInput.setAttribute("aria-label", `${token.label} color picker`);
    const hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.className = "theme-color-hex";
    hexInput.value = theme.colors[token.key];
    hexInput.maxLength = 7;
    hexInput.spellcheck = false;
    hexInput.autocomplete = "off";
    hexInput.setAttribute("aria-label", `${token.label} hex value`);
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "theme-color-reset secondary";
    reset.textContent = "Reset";
    reset.setAttribute("aria-label", `Reset ${token.label} to the ${theme.baseTheme} palette`);

    const applyColor = (value: string) => {
      const selected = selectedCustomTheme();
      const normalized = normalizeThemeHex(value);
      if (!selected || !normalized) return false;
      selected.colors[token.key] = normalized;
      colorInput.value = normalized;
      hexInput.value = normalized;
      invalidateThemeShareCode();
      renderThemePreview(themeEditorPreview, selected.name, selected.baseTheme, selected.colors, selected.design);
      renderThemeContrastWarning(selected);
      renderThemeCards(appTheme.value);
      syncAppPreferencesDirty();
      return true;
    };
    colorInput.addEventListener("input", () => applyColor(colorInput.value));
    hexInput.addEventListener("change", () => {
      const normalized = normalizeThemeHex(hexInput.value);
      if (!normalized) hexInput.value = selectedCustomTheme()?.colors[token.key] ?? theme.colors[token.key];
      else applyColor(normalized);
    });
    hexInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        hexInput.blur();
      }
    });
    reset.addEventListener("click", () => applyColor(builtInThemeColors[theme.baseTheme][token.key]));
    fields.append(colorInput, hexInput, reset);
    control.append(label, fields);
    groupFields?.append(control);
  }
}

function renderThemeContrastWarning(theme = selectedCustomTheme()) {
  if (!theme) {
    themeContrastWarning.hidden = true;
    themeContrastWarning.textContent = "";
    return;
  }
  const lowContrast = [
    ["main text", theme.colors.text, theme.colors.bg],
    ["secondary text", theme.colors.textMuted, theme.colors.bg],
    ["muted text", theme.colors.textFaint, theme.colors.bg],
    ["placeholder text", theme.colors.textPlaceholder, theme.colors.bgInput],
    ["received bubble text", theme.colors.messageBubbleText, theme.colors.messageBubble],
    ["sent bubble text", theme.colors.messageBubbleOwnText, theme.colors.messageBubbleOwn],
  ].filter(([, foreground, background]) => contrastRatio(foreground, background) < 4.5);
  themeContrastWarning.hidden = lowContrast.length === 0;
  themeContrastWarning.textContent = lowContrast.length > 0
    ? `Low contrast: ${lowContrast.map(([label]) => label).join(", ")}. Aim for at least 4.5:1 for readable text.`
    : "Text contrast meets the 4.5:1 guideline for the checked surfaces.";
  themeContrastWarning.classList.toggle("has-low-contrast", lowContrast.length > 0);
}

function invalidateThemeShareCode() {
  themeExportCode.value = "";
  themeShareCodeDetails.open = false;
}

function renderCustomThemeEditor() {
  const theme = selectedCustomTheme();
  const custom = Boolean(theme);
  customThemeName.disabled = !custom;
  customThemeName.required = custom && customThemeEditor.open;
  customThemeBase.disabled = !custom;
  deleteThemePresetButton.hidden = !custom;
  editThemePresetButton.hidden = !custom;
  copyThemePresetButton.disabled = !custom;
  downloadThemePresetButton.disabled = !custom;
  appAccentRow.hidden = custom || appTheme.value === "momotalk";
  if (theme) {
    customThemeName.value = theme.name;
    customThemeBase.value = theme.baseTheme;
    customThemeEditorHeading.textContent = editorThemeIsNew && editorThemeId === theme.id ? "Create preset" : "Edit preset";
    renderThemeColorControls(theme);
    renderThemeContrastWarning(theme);
    renderThemeDesignControls(theme);
    renderThemePreview(themeEditorPreview, theme.name, theme.baseTheme, theme.colors, theme.design);
  } else {
    renderThemeColorControls();
    renderThemeContrastWarning();
    invalidateThemeShareCode();
  }
}

function appPreferencesDraft(): AppPreferences {
  const presetId = appTheme.value;
  const customTheme = draftCustomThemes.find((theme) => theme.id === presetId);
  const baseTheme = customTheme?.baseTheme ?? (isAppTheme(presetId) ? presetId : appPreferences.theme);
  return {
    ...readAppPreferencesForm(),
    theme: baseTheme,
    themePreset: presetId,
    customThemes: cloneCustomThemePresets(draftCustomThemes),
  };
}

function renderAppPreferences(preferences: AppPreferences) {
  appPreferences = applyAppPreferences(preferences, settingsLayout);
  draftCustomThemes = cloneCustomThemePresets(appPreferences.customThemes);
  builtInAccentDraft = appPreferences.accent;
  renderThemeOptions(appPreferences.themePreset);
  appAccent.value = appPreferences.accent;
  renderCustomThemeEditor();
  appScale.value = String(Math.round(appPreferences.scale * 100));
  updateAppScaleValue();
  appMessageTextSize.value = String(appPreferences.messageTextSize);
  updateMessageTextSizeValue();
  appSounds.checked = appPreferences.sounds;
  appAutoLoadMedia.checked = appPreferences.autoLoadMedia;
  appExternalPreviews.checked = appPreferences.externalPreviews;
  appEnterToSend.checked = appPreferences.enterToSend;
  appCompactMessages.checked = appPreferences.compactMessages;
  appReducedMotion.checked = appPreferences.reducedMotion;
  appNotificationMode.value = appPreferences.notificationMode;
  appNotificationMode.disabled = typeof Notification === "undefined";
  appQuietHoursEnabled.checked = appPreferences.quietHoursEnabled;
  appQuietHoursStart.value = appPreferences.quietHoursStart;
  appQuietHoursEnd.value = appPreferences.quietHoursEnd;
  syncAppPreferencesDirty();
}

function readAppPreferencesForm(notificationMode = appNotificationMode.value as AppPreferences["notificationMode"]): AppPreferences {
  const customTheme = selectedCustomTheme();
  return {
    theme: customTheme?.baseTheme ?? (isAppTheme(appTheme.value) ? appTheme.value : appPreferences.theme),
    themePreset: appTheme.value,
    customThemes: cloneCustomThemePresets(draftCustomThemes),
    accent: builtInAccentDraft,
    scale: Number(appScale.value) / 100,
    messageTextSize: Number(appMessageTextSize.value),
    sounds: appSounds.checked,
    autoLoadMedia: appAutoLoadMedia.checked,
    externalPreviews: appExternalPreviews.checked,
    enterToSend: appEnterToSend.checked,
    compactMessages: appCompactMessages.checked,
    reducedMotion: appReducedMotion.checked,
    notificationMode,
    quietHoursEnabled: appQuietHoursEnabled.checked,
    quietHoursStart: appQuietHoursStart.value,
    quietHoursEnd: appQuietHoursEnd.value,
  };
}

function syncAppPreferencesDirty() {
  const dirty = appPreferencesAreDirty();
  appPreferencesStatus.textContent = dirty ? "Unsaved changes" : "No unsaved changes";
  appPreferencesStatus.dataset.state = dirty ? "dirty" : "saved";
  discardAppPreferencesButton.hidden = !dirty;
  saveAppPreferencesButton.disabled = !dirty;
}

function appPreferencesAreDirty() {
  if (!appPreferencesLoaded) return false;
  const draft = readAppPreferencesForm();
  return (Object.keys(draft) as (keyof AppPreferences)[]).some((key) => key === "customThemes"
    ? JSON.stringify(draft.customThemes) !== JSON.stringify(appPreferences.customThemes)
    : draft[key] !== appPreferences[key]);
}

function createCustomThemeId() {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `custom-${random}`;
}

function createThemePreset() {
  if (draftCustomThemes.length >= MAX_CUSTOM_THEME_PRESETS) {
    setStatus(`You can keep up to ${MAX_CUSTOM_THEME_PRESETS} custom presets on this browser.`, true);
    return;
  }
  const previousSelection = appTheme.value;
  const current = appPreferencesDraft();
  const baseName = selectedCustomTheme()?.name ?? builtInThemeOptions.find((theme) => theme.id === current.theme)?.name ?? "Theme";
  const theme: CustomThemePreset = {
    id: createCustomThemeId(),
    name: `${baseName} custom`.slice(0, MAX_THEME_NAME_LENGTH),
    baseTheme: current.theme,
    colors: colorsForPreset(current.themePreset),
    design: { ...defaultThemeDesign },
  };
  theme.design.gradientStart = theme.colors.bg;
  theme.design.gradientEnd = theme.colors.bgDeep;
  draftCustomThemes.push(theme);
  renderThemeOptions(theme.id);
  renderCustomThemeEditor();
  openThemeEditor(theme, true, previousSelection);
  syncAppPreferencesDirty();
}

function openThemeEditor(theme: CustomThemePreset, isNew = false, previousSelection = appTheme.value) {
  appTheme.value = theme.id;
  editorThemeId = theme.id;
  editorThemeSnapshot = isNew ? undefined : cloneCustomThemePresets([theme])[0];
  editorThemeIsNew = isNew;
  editorPreviousSelection = previousSelection;
  invalidateThemeShareCode();
  renderThemeCards(theme.id);
  renderCustomThemeEditor();
  customThemeName.required = true;
  customThemeEditor.returnValue = "";
  customThemeEditor.showModal();
  customThemeName.focus();
  customThemeName.select();
}

function editSelectedThemePreset() {
  const theme = selectedCustomTheme();
  if (!theme) return;
  openThemeEditor(theme);
}

function deleteThemePreset() {
  const theme = selectedCustomTheme();
  if (!theme || !window.confirm(`Delete the “${theme.name}” preset? Save preferences to keep this deletion.`)) return;
  draftCustomThemes = draftCustomThemes.filter((candidate) => candidate.id !== theme.id);
  appTheme.value = theme.baseTheme;
  customThemeEditor.close("deleted");
}

async function copyThemePreset() {
  const sharedTheme = sharedThemeForSelected();
  if (!sharedTheme) return;
  const code = exportSharedTheme(sharedTheme);
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
    await navigator.clipboard.writeText(code);
    setStatus("Theme share code copied.");
  } catch {
    themeExportCode.value = code;
    themeShareCodeDetails.open = true;
    themeExportCode.focus();
    themeExportCode.select();
    setStatus("Clipboard unavailable. The share code is open and selected so you can copy it.");
  }
}

async function downloadThemePreset() {
  const sharedTheme = sharedThemeForSelected();
  if (!sharedTheme) return;
  try {
    const code = await themePackageForSelected();
    if (!code) return;
    const slug = sharedTheme.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "theme";
    const url = URL.createObjectURL(new Blob([code], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slug}.naigi-theme.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to export this theme file.", true);
  }
}

async function reviewThemeImport() {
  const code = themeImportCode.value.trim();
  if (!code) {
    stagedImportedTheme = undefined;
    themeImportReviewPanel.hidden = true;
    importThemePresetButton.disabled = true;
    themeImportStatus.textContent = "Paste a theme code or choose a theme file to review.";
    themeImportStatus.dataset.state = "error";
    return;
  }
  if (code.length > MAX_THEME_PACKAGE_LENGTH) {
    stagedImportedTheme = undefined;
    themeImportReviewPanel.hidden = true;
    importThemePresetButton.disabled = true;
    themeImportStatus.textContent = "Theme file is too large to import.";
    themeImportStatus.dataset.state = "error";
    return;
  }
  reviewThemeImportButton.disabled = true;
  themeImportStatus.textContent = "Validating theme…";
  try {
    stagedImportedTheme = importSharedTheme(code);
    stagedImportedImage = undefined;
    if (stagedImportedTheme.backgroundImage) {
      const { base64, mimeType } = stagedImportedTheme.backgroundImage;
      const image = base64ToThemeImage(base64, mimeType);
      await validateThemeImage(image, mimeType);
      stagedImportedImage = image;
    }
    themeImportPreviewName.textContent = stagedImportedTheme.name;
    themeImportPreviewBase.textContent = `Based on ${builtInThemeOptions.find((theme) => theme.id === stagedImportedTheme?.baseTheme)?.name ?? "a built-in theme"}`;
    renderThemePreview(themeImportPreview, stagedImportedTheme.name, stagedImportedTheme.baseTheme, stagedImportedTheme.colors, stagedImportedTheme.design);
    if (stagedImportedImage) {
      stagedThemePreviewUrl = URL.createObjectURL(stagedImportedImage);
      const frame = themeImportPreview.firstElementChild as HTMLElement;
      frame.style.setProperty("--theme-background-image", `url("${stagedThemePreviewUrl}")`);
    }
    themeImportReviewPanel.hidden = false;
    importThemePresetButton.disabled = false;
    themeImportStatus.textContent = "Theme looks valid. Review the preview, then choose Import & use preset.";
    themeImportStatus.dataset.state = "valid";
  } catch (error) {
    stagedImportedTheme = undefined;
    stagedImportedImage = undefined;
    if (stagedThemePreviewUrl) URL.revokeObjectURL(stagedThemePreviewUrl);
    stagedThemePreviewUrl = undefined;
    themeImportReviewPanel.hidden = true;
    importThemePresetButton.disabled = true;
    themeImportStatus.textContent = error instanceof Error ? error.message : "Unable to review this theme code.";
    themeImportStatus.dataset.state = "error";
  } finally {
    reviewThemeImportButton.disabled = false;
  }
}

async function loadThemeImportFile() {
  const file = themeImportFile.files?.[0];
  if (!file) return;
  clearThemeImportReview();
  if (file.size > MAX_THEME_PACKAGE_LENGTH) {
    themeImportStatus.textContent = "Theme file is too large to import.";
    themeImportStatus.dataset.state = "error";
    themeImportFile.value = "";
    return;
  }
  try {
    themeImportCode.value = await file.text();
    reviewThemeImport();
  } catch {
    themeImportStatus.textContent = "Unable to read that theme file.";
    themeImportStatus.dataset.state = "error";
  } finally {
    themeImportFile.value = "";
  }
}

function clearThemeImportReview() {
  stagedImportedTheme = undefined;
  stagedImportedImage = undefined;
  if (stagedThemePreviewUrl) URL.revokeObjectURL(stagedThemePreviewUrl);
  stagedThemePreviewUrl = undefined;
  themeImportReviewPanel.hidden = true;
  themeImportPreview.replaceChildren();
  importThemePresetButton.disabled = true;
}

function openThemeImport() {
  if (draftCustomThemes.length >= MAX_CUSTOM_THEME_PRESETS) {
    setStatus(`You can keep up to ${MAX_CUSTOM_THEME_PRESETS} custom presets on this browser.`, true);
    return;
  }
  themeImportStatus.textContent = "";
  themeImportStatus.dataset.state = "";
  clearThemeImportReview();
  themeImportDialog.returnValue = "";
  themeImportDialog.showModal();
  themeImportCode.focus();
}

async function importThemePreset() {
  if (!stagedImportedTheme) return;
  if (draftCustomThemes.length >= MAX_CUSTOM_THEME_PRESETS) {
    themeImportStatus.textContent = `You can keep up to ${MAX_CUSTOM_THEME_PRESETS} custom presets on this browser.`;
    themeImportStatus.dataset.state = "error";
    return;
  }
  let backgroundImageAssetId: string | undefined;
  if (stagedImportedImage) {
    backgroundImageAssetId = newThemeImageAssetId();
    try {
      await saveThemeBackgroundImage(backgroundImageAssetId, stagedImportedImage);
      unsavedThemeImageIds.add(backgroundImageAssetId);
    } catch (error) {
      themeImportStatus.textContent = error instanceof Error ? error.message : "Unable to store the imported image locally.";
      themeImportStatus.dataset.state = "error";
      return;
    }
  }
  const theme: CustomThemePreset = {
    id: createCustomThemeId(),
    name: stagedImportedTheme.name,
    baseTheme: stagedImportedTheme.baseTheme,
    colors: { ...stagedImportedTheme.colors },
    design: { ...stagedImportedTheme.design, ...(backgroundImageAssetId ? { backgroundImageAssetId } : {}) },
  };
  draftCustomThemes.push(theme);
  renderThemeOptions(theme.id);
  renderCustomThemeEditor();
  syncAppPreferencesDirty();
  themeImportDialog.close("imported");
  setStatus(`Imported “${theme.name}” and selected it. Save preferences to keep it on this browser.`);
}

type LeavePreferencesChoice = "save" | "discard" | "stay";

function promptToLeaveAppPreferences(): Promise<LeavePreferencesChoice> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "app-dialog app-preferences-leave-dialog";
    const title = document.createElement("h2");
    title.textContent = "Unsaved changes";
    title.id = "app-preferences-leave-title";
    const description = document.createElement("p");
    description.className = "muted";
    description.textContent = "Save your preference changes before leaving, discard them, or stay here to keep editing.";
    description.id = "app-preferences-leave-description";
    dialog.setAttribute("aria-labelledby", title.id);
    dialog.setAttribute("aria-describedby", description.id);

    const actions = document.createElement("div");
    actions.className = "app-dialog-actions app-preferences-leave-actions";
    const stay = document.createElement("button");
    stay.className = "secondary";
    stay.type = "button";
    stay.textContent = "Stay here";
    const discard = document.createElement("button");
    discard.className = "secondary";
    discard.type = "button";
    discard.textContent = "Discard changes";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save changes";
    actions.append(stay, discard, save);
    dialog.append(title, description, actions);
    document.body.append(dialog);

    let choice: LeavePreferencesChoice = "stay";
    const closeWith = (nextChoice: LeavePreferencesChoice) => {
      choice = nextChoice;
      dialog.close();
    };
    stay.addEventListener("click", () => closeWith("stay"));
    discard.addEventListener("click", () => closeWith("discard"));
    save.addEventListener("click", () => closeWith("save"));
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(choice);
    }, { once: true });
    dialog.showModal();
    stay.focus();
  });
}

async function resolveAppPreferencesBeforeLeave() {
  if (!appPreferencesAreDirty()) return true;
  const choice = await promptToLeaveAppPreferences();
  if (choice === "stay") return false;
  if (choice === "discard") {
    renderAppPreferences(appPreferences);
    appPreferencesStatus.textContent = "Unsaved changes discarded.";
    return true;
  }
  return saveAppPreferencesDraft();
}

function updateAppScaleValue() {
  const value = `${appScale.value}%`;
  appScaleValue.value = value;
  appScaleValue.textContent = value;
  appScale.setAttribute("aria-valuetext", value);
  appMessageSizePreview.style.setProperty("--preview-interface-scale", String(Number(appScale.value) / 100));
}

function updateMessageTextSizeValue() {
  const value = `${appMessageTextSize.value}px`;
  appMessageTextSizeValue.value = value;
  appMessageTextSizeValue.textContent = value;
  appMessageTextSize.setAttribute("aria-valuetext", value);
  appMessageSizePreviewText.style.setProperty("--preview-message-text-size", value);
}

function formatCacheSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshMessageCacheStatus() {
  if (!currentUserId) return;
  try {
    const stats = await cachedMessageCacheStats(currentUserId);
    if (!stats) {
      messageCacheStatus.textContent = "Encrypted message cache is unavailable in this browser.";
      clearMessageCacheButton.disabled = true;
      return;
    }
    messageCacheStatus.textContent = `${stats.messages.toLocaleString()} cached encrypted ${stats.messages === 1 ? "message" : "messages"} · approximately ${formatCacheSize(stats.bytes)}`;
    clearMessageCacheButton.disabled = stats.messages === 0;
  } catch {
    messageCacheStatus.textContent = "Unable to read encrypted message cache usage.";
    clearMessageCacheButton.disabled = true;
  }
}

async function loadBlockedUsers() {
  blockedUsersList.replaceChildren();
  try {
    const result = await api.blockedUsers();
    if (result.users.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "You have not blocked anyone.";
      blockedUsersList.append(empty);
      return;
    }
    for (const user of result.users) {
      const row = document.createElement("div");
      row.className = "settings-list-row";
      const copy = document.createElement("div");
      copy.className = "settings-row-copy";
      const displayName = document.createElement("strong");
      displayName.textContent = user.displayName;
      const usernameLabel = document.createElement("span");
      usernameLabel.className = "muted small";
      usernameLabel.textContent = `@${user.username}`;
      copy.append(displayName, usernameLabel);
      const unblock = document.createElement("button");
      unblock.type = "button";
      unblock.className = "secondary";
      unblock.textContent = "Unblock";
      unblock.addEventListener("click", async () => {
        unblock.disabled = true;
        try {
          await api.unblockUser(user.id);
          await loadBlockedUsers();
          setStatus(`@${user.username} unblocked.`);
        } catch (error) {
          unblock.disabled = false;
          setStatus(error instanceof Error ? error.message : "Unable to unblock this user.", true);
        }
      });
      row.append(copy, unblock);
      blockedUsersList.append(row);
    }
  } catch (error) {
    const message = document.createElement("p");
    message.className = "muted";
    message.textContent = "Unable to load blocked users.";
    blockedUsersList.append(message);
    setStatus(error instanceof Error ? error.message : "Unable to load blocked users.", true);
  }
}

const profileSettings = setupProfileSettings(api, {
  name,
  avatar,
  banner,
  username,
  profileForm,
  displayNameInput,
  profileFormState,
  discardProfileChanges,
  profileImageInput,
  removeProfileImage,
  profileBannerInput,
  removeProfileBanner,
}, setStatus);

async function loadDevices() {
  renderDevices((await api.devices()).devices as Device[]);
}

async function boot() {
  try {
    const result = await api.me();
    currentUserId = result.user.id;
    setupVoiceAudioSettings(currentUserId);
    setupHistoryRecovery(api, ensureRecoveryCrypto);
    const preferences = loadAppPreferences(currentUserId);
    appPreferencesLoaded = true;
    renderAppPreferences(preferences);
    profileSettings.renderProfile(result.user);
    await Promise.all([loadDevices(), loadBlockedUsers()]);
    await refreshMessageCacheStatus();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) window.location.assign("/");
    else setStatus(error instanceof Error ? error.message : "Unable to load settings.", true);
  }
}

async function saveAppPreferencesDraft() {
  let notificationMode = appNotificationMode.value as AppPreferences["notificationMode"];
  let notificationPermissionMessage = "";
  if (notificationMode !== "off") {
    if (typeof Notification === "undefined") {
      notificationMode = "off";
      notificationPermissionMessage = "Desktop notifications are unavailable in this browser.";
    } else if (Notification.permission !== "granted") {
      let granted = false;
      if (Notification.permission !== "denied") {
        try {
          granted = await Notification.requestPermission() === "granted";
        } catch {
          granted = false;
        }
      }
      if (!granted) {
        notificationMode = "off";
        notificationPermissionMessage = Notification.permission === "denied"
          ? " Allow notifications in browser site settings to enable them."
          : " Notification permission was not granted.";
      }
    }
  }
  const previousImageIds = themeImageIds(appPreferences.customThemes);
  appPreferences = saveAppPreferences(currentUserId, readAppPreferencesForm(notificationMode));
  const saved = loadAppPreferences(currentUserId);
  const savedImageIds = themeImageIds(saved.customThemes);
  const persistedImageIds = themeImageIds(appPreferences.customThemes);
  const persisted = saved.themePreset === appPreferences.themePreset
    && JSON.stringify(saved.customThemes) === JSON.stringify(appPreferences.customThemes)
    && [...persistedImageIds].every((id) => savedImageIds.has(id));
  if (persisted) {
    const obsolete = [...new Set([...previousImageIds, ...unsavedThemeImageIds])].filter((id) => !persistedImageIds.has(id));
    await deleteThemeBackgroundImages(obsolete);
    unsavedThemeImageIds.clear();
  }
  if (currentUserId) void synchronizeFcmPush(api, currentUserId, appPreferences);
  renderAppPreferences(appPreferences);
  appPreferencesStatus.textContent = "Changes saved on this browser.";
  setStatus(`App settings saved on this browser.${notificationPermissionMessage}`);
  return true;
}

appPreferencesForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveAppPreferencesDraft();
});

appTheme.addEventListener("change", () => {
  invalidateThemeShareCode();
  renderThemeCards(appTheme.value);
  renderCustomThemeEditor();
  void discardUnreferencedDraftThemeImages();
  syncAppPreferencesDirty();
});
appAccent.addEventListener("input", () => {
  builtInAccentDraft = appAccent.value;
  renderThemeCards(appTheme.value);
  syncAppPreferencesDirty();
});
  customThemeName.addEventListener("input", () => {
  const theme = selectedCustomTheme();
  if (!theme) return;
  theme.name = customThemeName.value;
  invalidateThemeShareCode();
  renderThemePreview(themeEditorPreview, theme.name, theme.baseTheme, theme.colors, theme.design);
  syncAppPreferencesDirty();
});
customThemeName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") event.preventDefault();
});
customThemeBase.addEventListener("change", () => {
  const theme = selectedCustomTheme();
  if (!theme) return;
  const updatedTheme = setThemeBasePalette(theme, customThemeBase.value as AppTheme);
  const themeIndex = draftCustomThemes.findIndex((candidate) => candidate.id === theme.id);
  if (themeIndex < 0) return;
  draftCustomThemes[themeIndex] = updatedTheme;
  invalidateThemeShareCode();
  renderThemeColorControls(updatedTheme);
  renderThemeDesignControls(updatedTheme);
  renderThemeCards(updatedTheme.id);
  renderThemePreview(themeEditorPreview, updatedTheme.name, updatedTheme.baseTheme, updatedTheme.colors, updatedTheme.design);
  renderThemeContrastWarning(updatedTheme);
  syncAppPreferencesDirty();
});
themeBackgroundMode.addEventListener("change", () => updateSelectedThemeDesign({ backgroundMode: themeBackgroundMode.value as ThemeDesign["backgroundMode"] }));
themeGradientStart.addEventListener("input", () => updateSelectedThemeDesign({ gradientStart: themeGradientStart.value }));
themeGradientEnd.addEventListener("input", () => updateSelectedThemeDesign({ gradientEnd: themeGradientEnd.value }));
themeGradientAngle.addEventListener("change", () => updateSelectedThemeDesign({ gradientAngle: Number(themeGradientAngle.value) }));
themeImageFit.addEventListener("change", () => updateSelectedThemeDesign({ imageFit: themeImageFit.value as ThemeDesign["imageFit"] }));
themeImagePosition.addEventListener("change", () => updateSelectedThemeDesign({ imagePosition: themeImagePosition.value as ThemeDesign["imagePosition"] }));
themeBackgroundOverlay.addEventListener("input", () => updateSelectedThemeDesign({ overlay: Number(themeBackgroundOverlay.value) }));
themeContentWidth.addEventListener("change", () => updateSelectedThemeDesign({ contentWidth: themeContentWidth.value as ThemeDesign["contentWidth"] }));
themeDensity.addEventListener("change", () => updateSelectedThemeDesign({ density: themeDensity.value as ThemeDesign["density"] }));
themeRadius.addEventListener("input", () => updateSelectedThemeDesign({ radius: Number(themeRadius.value) }));
themeShadow.addEventListener("change", () => updateSelectedThemeDesign({ shadow: themeShadow.value as ThemeDesign["shadow"] }));
themeBorderStyle.addEventListener("change", () => updateSelectedThemeDesign({ borderStyle: themeBorderStyle.value as ThemeDesign["borderStyle"] }));
themeMotion.addEventListener("change", () => updateSelectedThemeDesign({ motion: themeMotion.value as ThemeDesign["motion"] }));
themeTransitionSpeed.addEventListener("change", () => updateSelectedThemeDesign({ transitionSpeed: themeTransitionSpeed.value as ThemeDesign["transitionSpeed"] }));
themeTransitionEasing.addEventListener("change", () => updateSelectedThemeDesign({ transitionEasing: themeTransitionEasing.value as ThemeDesign["transitionEasing"] }));
themeBackgroundFile.addEventListener("change", () => void onThemeBackgroundFile());
removeThemeBackgroundButton.addEventListener("click", () => {
  updateSelectedThemeDesign({ backgroundMode: "solid", backgroundImageAssetId: undefined });
  themeImageStatus.textContent = "Image removed from this preset draft. Save preferences to keep the change.";
  void discardUnreferencedDraftThemeImages();
});
createThemePresetButton.addEventListener("click", createThemePreset);
editThemePresetButton.addEventListener("click", editSelectedThemePreset);
deleteThemePresetButton.addEventListener("click", deleteThemePreset);
closeThemeEditorButton.addEventListener("click", () => customThemeEditor.close("cancel"));
cancelThemeEditorButton.addEventListener("click", () => customThemeEditor.close("cancel"));
doneThemeEditorButton.addEventListener("click", () => {
  const theme = selectedCustomTheme();
  if (!theme || !theme.name.trim() || theme.name.trim().length > MAX_THEME_NAME_LENGTH) {
    setStatus(`Preset names must be 1–${MAX_THEME_NAME_LENGTH} characters long.`, true);
    customThemeName.focus();
    return;
  }
  customThemeEditor.close("done");
});
customThemeEditor.addEventListener("close", () => {
  const accepted = customThemeEditor.returnValue === "done" || customThemeEditor.returnValue === "deleted";
  if (!accepted) {
    if (editorThemeIsNew && editorThemeId) {
      draftCustomThemes = draftCustomThemes.filter((theme) => theme.id !== editorThemeId);
    } else if (editorThemeSnapshot && editorThemeId) {
      const index = draftCustomThemes.findIndex((theme) => theme.id === editorThemeId);
      if (index >= 0) draftCustomThemes[index] = editorThemeSnapshot;
    }
    appTheme.value = editorPreviousSelection;
  }
  const deleted = customThemeEditor.returnValue === "deleted";
  editorThemeId = undefined;
  editorThemeSnapshot = undefined;
  editorThemeIsNew = false;
  customThemeName.required = false;
  renderThemeOptions(appTheme.value);
  renderCustomThemeEditor();
  syncAppPreferencesDirty();
  if (deleted) setStatus("Preset removed from this draft. Save preferences to keep the deletion.");
  else if (accepted) setStatus("Preset edits are in your draft. Save preferences to keep the changes.");
});
copyThemePresetButton.addEventListener("click", () => void copyThemePreset());
downloadThemePresetButton.addEventListener("click", downloadThemePreset);
themeShareCodeDetails.addEventListener("toggle", () => {
  if (!themeShareCodeDetails.open || themeExportCode.value) return;
  const sharedTheme = sharedThemeForSelected();
  if (sharedTheme) themeExportCode.value = exportSharedTheme(sharedTheme);
  else themeShareCodeDetails.open = false;
});
openThemeImportButton.addEventListener("click", openThemeImport);
closeThemeImportButton.addEventListener("click", () => themeImportDialog.close("cancel"));
cancelThemeImportButton.addEventListener("click", () => themeImportDialog.close("cancel"));
reviewThemeImportButton.addEventListener("click", () => void reviewThemeImport());
themeImportCode.addEventListener("input", () => {
  clearThemeImportReview();
  themeImportStatus.textContent = "";
  themeImportStatus.dataset.state = "";
});
themeImportFile.addEventListener("change", () => void loadThemeImportFile());
importThemePresetButton.addEventListener("click", () => void importThemePreset());
themeImportDialog.addEventListener("close", clearThemeImportReview);

appScale.addEventListener("input", updateAppScaleValue);
appMessageTextSize.addEventListener("input", updateMessageTextSizeValue);
appPreferencesForm.addEventListener("input", syncAppPreferencesDirty);
appPreferencesForm.addEventListener("change", syncAppPreferencesDirty);
discardAppPreferencesButton.addEventListener("click", () => {
  renderAppPreferences(appPreferences);
  void discardUnreferencedDraftThemeImages();
  appPreferencesStatus.textContent = "Unsaved changes discarded.";
});

clearMessageCacheButton.addEventListener("click", async () => {
  if (!currentUserId) return;
  if (!window.confirm("Clear only this browser’s cached encrypted messages? This does not affect server history, queued messages, local keys, or device settings.")) return;
  clearMessageCacheButton.disabled = true;
  try {
    const cleared = await clearCachedMessages(currentUserId);
    await refreshMessageCacheStatus();
    setStatus(`Cleared ${cleared.toLocaleString()} cached encrypted ${cleared === 1 ? "message" : "messages"}. Server history and local keys are unchanged.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to clear the encrypted message cache.", true);
    clearMessageCacheButton.disabled = false;
  }
});

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (newPassword.value !== confirmPassword.value) {
    setStatus("The new passwords do not match.", true);
    return;
  }
  const button = passwordForm.querySelector<HTMLButtonElement>("button[type=submit]");
  if (button) button.disabled = true;
  try {
    await api.updatePassword(currentPassword.value, newPassword.value);
    passwordForm.reset();
    setStatus("Password changed.");
  } catch (error) {
    setStatus(error instanceof ApiError && error.code === "current_password_incorrect"
      ? "The current password is incorrect."
      : error instanceof Error ? error.message : "Unable to change password.", true);
  } finally {
    if (button) button.disabled = false;
  }
});

async function ensureRecoveryCrypto() {
  if (!currentUserId) throw new Error("not_authenticated");
  if (recoveryCrypto) return recoveryCrypto;
  const passphrase = recoveryLocalPassphrase.value;
  if (!passphrase) throw new Error("Enter this browser's local encryption passphrase first.");
  const client = new CryptoClient(api, currentUserId, passphrase);
  try {
    await client.initialize();
  } catch (error) {
    await client.close().catch(() => undefined);
    if (error instanceof LocalCryptoStoreError) throw new Error("The browser passphrase did not unlock this device.");
    throw error;
  }
  recoveryLocalPassphrase.value = "";
  recoveryCrypto = client;
  return client;
}

exportRecoveryButton.addEventListener("click", async () => {
  if (recoveryExportPassphrase.value.length < 12) {
    setStatus("Use a recovery passphrase of at least 12 characters.", true);
    return;
  }
  if (recoveryExportPassphrase.value !== recoveryExportConfirm.value) {
    setStatus("The recovery passphrases do not match.", true);
    return;
  }
  exportRecoveryButton.disabled = true;
  try {
    const encrypted = await (await ensureRecoveryCrypto()).exportRecovery(recoveryExportPassphrase.value);
    const payload = JSON.stringify({ format: "naigi-room-key-recovery", version: 1, encrypted });
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `naigi-recovery-${new Date().toISOString().slice(0, 10)}.naigi-recovery`;
    link.click();
    URL.revokeObjectURL(url);
    recoveryExportPassphrase.value = "";
    recoveryExportConfirm.value = "";
    setStatus("Encrypted recovery backup downloaded. Store it separately from its passphrase.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to export room keys.", true);
  } finally {
    exportRecoveryButton.disabled = false;
  }
});

importRecoveryButton.addEventListener("click", async () => {
  const file = recoveryFile.files?.[0];
  if (!file || !recoveryImportPassphrase.value) {
    setStatus("Choose a recovery file and enter its passphrase.", true);
    return;
  }
  importRecoveryButton.disabled = true;
  try {
    const raw = await file.text();
    if (raw.length > 50 * 1024 * 1024) throw new Error("Recovery backup is too large.");
    const parsed = JSON.parse(raw) as { format?: unknown; version?: unknown; encrypted?: unknown };
    if (parsed.format !== "naigi-room-key-recovery" || parsed.version !== 1 || typeof parsed.encrypted !== "string") {
      throw new Error("That is not a Naigi recovery backup.");
    }
    const result = await (await ensureRecoveryCrypto()).importRecovery(parsed.encrypted, recoveryImportPassphrase.value);
    recoveryImportPassphrase.value = "";
    setStatus(`Imported ${result.imported} of ${result.total} room keys.`, false);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to import room keys.", true);
  } finally {
    importRecoveryButton.disabled = false;
  }
});

clearLocalDataButton.addEventListener("click", async () => {
  if (!currentUserId) return;
  if (!window.confirm("Clear encrypted caches, local keys, remembered unlock, and device-only settings from this browser?")) return;
  clearLocalDataButton.disabled = true;
  try {
    if (recoveryCrypto) await recoveryCrypto.close().catch(() => undefined);
    recoveryCrypto = undefined;
    const pushRegistrationRemoved = await disableFcmPush(api, currentUserId);
    const result = await clearLocalData(currentUserId);
    setStatus(result.cleared && pushRegistrationRemoved
      ? "Local data cleared from this browser."
      : result.cleared
        ? "Local data cleared, but the push registration could not be removed; its token was retained so removal can be retried."
        : "Local data was mostly cleared; a browser tab is still using one local database.", !result.cleared || !pushRegistrationRemoved);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to clear local data.", true);
  } finally {
    clearLocalDataButton.disabled = false;
  }
});

lockNow.addEventListener("click", () => {
  lockLocalSession();
  window.location.assign(`/unlock?manual=1&return=${encodeURIComponent("/settings")}`);
});

forgetDevice.addEventListener("click", async () => {
  if (!currentUserId) return;
  forgetDevice.disabled = true;
  try {
    await forgetRememberedPassphrase(currentUserId);
    localUnlockStatus.textContent = "Remembered unlock removed from this browser.";
  } catch {
    localUnlockStatus.textContent = "Unable to remove the remembered unlock.";
  } finally {
    forgetDevice.disabled = false;
  }
});

logout.addEventListener("click", async () => {
  if (currentUserId) await disableFcmPush(api, currentUserId);
  await api.logout().catch(() => undefined);
  if (recoveryCrypto) await recoveryCrypto.close().catch(() => undefined);
  recoveryCrypto = undefined;
  clearSessionPassphrase();
  if (currentUserId) await forgetRememberedPassphrase(currentUserId).catch(() => undefined);
  window.location.assign("/");
});

void boot();
