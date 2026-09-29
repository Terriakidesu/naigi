import { ApiClient, ApiError } from "./api";
import { applyAppPreferences, defaultAppPreferences, loadAppPreferences, saveAppPreferences, type AppPreferences } from "./app-preferences";
import { CryptoClient, LocalCryptoStoreError } from "./crypto";
import { iconElement, renderIcons } from "./icons";
import { clearLocalData } from "./local-data";
import { disableFcmPush, synchronizeFcmPush } from "./push-notifications";
import { cachedMessageCacheStats, clearCachedMessages } from "./message-cache";
import { setupProfileSettings } from "./profile-settings";
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
const appAccent = document.getElementById("app-accent") as HTMLInputElement;
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
  const requestedHash = window.location.hash || "#profile";
  const views = [...document.querySelectorAll<HTMLElement>("[data-settings-view]")];
  return views.some((view) => `#${view.id}` === requestedHash) ? requestedHash : "#profile";
}

let lastSettingsHash = currentSettingsHash();

function syncSettingsNav() {
  const hash = currentSettingsHash();
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
    if (currentSettingsHash() === "#app" && targetHash !== "#app" && appPreferencesAreDirty()) {
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
  if (previousHash === "#app" && nextHash !== "#app" && appPreferencesAreDirty()) {
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

function renderAppPreferences(preferences: AppPreferences) {
  appPreferences = applyAppPreferences(preferences, settingsLayout);
  appTheme.value = appPreferences.theme;
  appAccent.value = appPreferences.accent;
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
  return {
    theme: appTheme.value as AppPreferences["theme"],
    accent: appAccent.value,
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
  return (Object.keys(draft) as (keyof AppPreferences)[]).some((key) => draft[key] !== appPreferences[key]);
}

type LeavePreferencesChoice = "save" | "discard" | "stay";

function promptToLeaveAppPreferences(): Promise<LeavePreferencesChoice> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "app-dialog app-preferences-leave-dialog";
    const title = document.createElement("h2");
    title.textContent = "Unsaved app preferences";
    title.id = "app-preferences-leave-title";
    const description = document.createElement("p");
    description.className = "muted";
    description.textContent = "Save your changes before leaving App preferences, discard them, or stay here to keep editing.";
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
  appPreferences = saveAppPreferences(currentUserId, readAppPreferencesForm(notificationMode));
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

appScale.addEventListener("input", updateAppScaleValue);
appMessageTextSize.addEventListener("input", updateMessageTextSizeValue);
appPreferencesForm.addEventListener("input", syncAppPreferencesDirty);
appPreferencesForm.addEventListener("change", syncAppPreferencesDirty);
discardAppPreferencesButton.addEventListener("click", () => {
  renderAppPreferences(appPreferences);
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
