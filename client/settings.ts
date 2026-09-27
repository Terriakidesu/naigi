import { ApiClient, ApiError } from "./api";
import { iconElement, renderIcons } from "./icons";
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
const username = document.getElementById("settings-username") as HTMLElement;
const deviceList = document.getElementById("device-list") as HTMLElement;
const status = document.getElementById("settings-status") as HTMLElement;
const logout = document.getElementById("logout-button") as HTMLButtonElement;
const profileForm = document.getElementById("profile-form") as HTMLFormElement;
const displayNameInput = document.getElementById("settings-display-name") as HTMLInputElement;
const profileImageInput = document.getElementById("profile-image-input") as HTMLInputElement;
const removeProfileImage = document.getElementById("remove-profile-image") as HTMLButtonElement;
const passwordForm = document.getElementById("password-form") as HTMLFormElement;
const currentPassword = document.getElementById("current-password") as HTMLInputElement;
const newPassword = document.getElementById("new-password") as HTMLInputElement;
const confirmPassword = document.getElementById("confirm-password") as HTMLInputElement;
const lockNow = document.getElementById("lock-now-button") as HTMLButtonElement;
const forgetDevice = document.getElementById("forget-device-button") as HTMLButtonElement;
const localUnlockStatus = document.getElementById("local-unlock-status") as HTMLElement;
let currentUserId: string | undefined;

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

const profileSettings = setupProfileSettings(api, {
  name,
  avatar,
  username,
  profileForm,
  displayNameInput,
  profileImageInput,
  removeProfileImage,
}, setStatus);

async function loadDevices() {
  renderDevices((await api.devices()).devices as Device[]);
}

async function boot() {
  try {
    const result = await api.me();
    currentUserId = result.user.id;
    profileSettings.renderProfile(result.user);
    await loadDevices();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) window.location.assign("/");
    else setStatus(error instanceof Error ? error.message : "Unable to load settings.", true);
  }
}

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
  clearSessionPassphrase();
  if (currentUserId) await forgetRememberedPassphrase(currentUserId).catch(() => undefined);
  window.location.assign("/");
});

void boot();
