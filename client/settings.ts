import { ApiClient, ApiError } from "./api";
import { applyAppPreferences, defaultAppPreferences, loadAppPreferences, saveAppPreferences, type AppPreferences } from "./app-preferences";
import { CryptoClient, LocalCryptoStoreError } from "./crypto";
import { iconElement, renderIcons } from "./icons";
import { clearLocalData } from "./local-data";
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
const appPreferencesForm = document.getElementById("app-preferences-form") as HTMLFormElement;
const appTheme = document.getElementById("app-theme") as HTMLSelectElement;
const appAccent = document.getElementById("app-accent") as HTMLInputElement;
const appScale = document.getElementById("app-scale") as HTMLSelectElement;
const appSounds = document.getElementById("app-sounds") as HTMLInputElement;
const appAutoplayMedia = document.getElementById("app-autoplay-media") as HTMLInputElement;
const appExternalPreviews = document.getElementById("app-external-previews") as HTMLInputElement;
const appEnterToSend = document.getElementById("app-enter-to-send") as HTMLInputElement;
const appCompactMessages = document.getElementById("app-compact-messages") as HTMLInputElement;
const appReducedMotion = document.getElementById("app-reduced-motion") as HTMLInputElement;
let currentUserId: string | undefined;
let appPreferences: AppPreferences = { ...defaultAppPreferences };
let recoveryCrypto: CryptoClient | undefined;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
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

function syncSettingsNav() {
  const requestedHash = window.location.hash || "#profile";
  const views = [...document.querySelectorAll<HTMLElement>("[data-settings-view]")];
  const hash = views.some((view) => `#${view.id}` === requestedHash) ? requestedHash : "#profile";
  for (const view of views) view.hidden = `#${view.id}` !== hash;
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".settings-nav-item")) {
    const active = link.hash === hash;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}

window.addEventListener("hashchange", syncSettingsNav);
syncSettingsNav();
renderIcons();

function renderAppPreferences(preferences: AppPreferences) {
  appPreferences = applyAppPreferences(preferences);
  appTheme.value = appPreferences.theme;
  appAccent.value = appPreferences.accent;
  appScale.value = String(appPreferences.scale);
  appSounds.checked = appPreferences.sounds;
  appAutoplayMedia.checked = appPreferences.autoplayMedia;
  appExternalPreviews.checked = appPreferences.externalPreviews;
  appEnterToSend.checked = appPreferences.enterToSend;
  appCompactMessages.checked = appPreferences.compactMessages;
  appReducedMotion.checked = appPreferences.reducedMotion;
}

const profileSettings = setupProfileSettings(api, {
  name,
  avatar,
  banner,
  username,
  profileForm,
  displayNameInput,
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
    renderAppPreferences(loadAppPreferences(currentUserId));
    profileSettings.renderProfile(result.user);
    await loadDevices();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) window.location.assign("/");
    else setStatus(error instanceof Error ? error.message : "Unable to load settings.", true);
  }
}

appPreferencesForm.addEventListener("submit", (event) => {
  event.preventDefault();
  appPreferences = saveAppPreferences(currentUserId, {
    theme: appTheme.value as AppPreferences["theme"],
    accent: appAccent.value,
    scale: Number(appScale.value),
    sounds: appSounds.checked,
    autoplayMedia: appAutoplayMedia.checked,
    externalPreviews: appExternalPreviews.checked,
    enterToSend: appEnterToSend.checked,
    compactMessages: appCompactMessages.checked,
    reducedMotion: appReducedMotion.checked,
  });
  renderAppPreferences(appPreferences);
  setStatus("App settings saved on this browser.");
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
    const result = await clearLocalData(currentUserId);
    setStatus(result.cleared ? "Local data cleared from this browser." : "Local data was mostly cleared; a browser tab is still using one local database.", !result.cleared);
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
  await api.logout().catch(() => undefined);
  if (recoveryCrypto) await recoveryCrypto.close().catch(() => undefined);
  recoveryCrypto = undefined;
  clearSessionPassphrase();
  if (currentUserId) await forgetRememberedPassphrase(currentUserId).catch(() => undefined);
  window.location.assign("/");
});

void boot();
