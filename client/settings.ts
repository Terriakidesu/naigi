import { ApiClient, ApiError, type User } from "./api";

type Device = {
  id: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
};

const api = new ApiClient();
const name = document.getElementById("settings-name") as HTMLElement;
const username = document.getElementById("settings-username") as HTMLElement;
const deviceList = document.getElementById("device-list") as HTMLElement;
const status = document.getElementById("settings-status") as HTMLElement;
const logout = document.getElementById("logout-button") as HTMLButtonElement;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function renderProfile(user: User) {
  name.textContent = user.displayName;
  username.textContent = `@${user.username}`;
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
    icon.className = "member-avatar";
    icon.textContent = "⌁";
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

async function loadDevices() {
  renderDevices((await api.devices()).devices as Device[]);
}

async function boot() {
  try {
    const result = await api.me();
    renderProfile(result.user);
    await loadDevices();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) window.location.assign("/");
    else setStatus(error instanceof Error ? error.message : "Unable to load settings.", true);
  }
}

logout.addEventListener("click", async () => {
  await api.logout().catch(() => undefined);
  window.location.assign("/");
});

void boot();
