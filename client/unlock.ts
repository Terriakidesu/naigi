import { ApiClient, ApiError } from "./api";
import {
  clearSessionPassphrase,
  forgetRememberedPassphrase,
  recoverRememberedPassphrase,
  rememberPassphrase,
  rememberedUnlockSupported,
  setSessionPassphrase,
} from "./unlock-vault";

const api = new ApiClient();
const form = document.getElementById("unlock-form") as HTMLFormElement;
const passphrase = document.getElementById("local-passphrase") as HTMLInputElement;
const submit = document.getElementById("unlock-submit") as HTMLButtonElement;
const remember = document.getElementById("remember-device") as HTMLInputElement;
const status = document.getElementById("unlock-status") as HTMLElement;
const logout = document.getElementById("unlock-logout") as HTMLButtonElement;
let currentUserId: string | undefined;

if (!rememberedUnlockSupported()) {
  remember.disabled = true;
  remember.title = "Remembered unlock requires HTTPS or localhost.";
  const hint = document.createElement("p");
  hint.className = "muted small";
  hint.textContent = "Remembered unlock is unavailable here; use HTTPS or localhost to enable it.";
  remember.closest("label")?.after(hint);
}

function destination() {
  const requested = new URLSearchParams(window.location.search).get("return");
  return requested && requested.startsWith("/") && !requested.startsWith("//") ? requested : "/app";
}

function readableError(error: unknown) {
  if (error instanceof Error && error.message === "remembered_unlock_requires_secure_context") {
    return "Remembered unlock requires HTTPS or localhost.";
  }
  return error instanceof Error ? error.message : "Unable to unlock this browser.";
}

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  try {
    if (remember.checked && currentUserId) await rememberPassphrase(currentUserId, passphrase.value);
    setSessionPassphrase(passphrase.value);
    window.location.assign(destination());
  } catch (error) {
    setStatus(readableError(error), true);
    submit.disabled = false;
  }
});

logout.addEventListener("click", async () => {
  await api.logout().catch(() => undefined);
  clearSessionPassphrase();
  if (currentUserId) await forgetRememberedPassphrase(currentUserId).catch(() => undefined);
  window.location.assign("/");
});

async function boot() {
  const reason = new URLSearchParams(window.location.search).get("error");
  const manualUnlock = new URLSearchParams(window.location.search).get("manual") === "1";
  if (reason) setStatus("That passphrase did not unlock this browser. Try again.", true);
  try {
    const result = await api.me();
    currentUserId = result.user.id;
    if (!reason && !manualUnlock) {
      const rememberedPassphrase = await recoverRememberedPassphrase(currentUserId).catch(() => null);
      if (rememberedPassphrase) {
        setStatus("Unlocking this browser…");
        setSessionPassphrase(rememberedPassphrase);
        window.location.assign(destination());
        return;
      }
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) window.location.assign("/");
    else setStatus(error instanceof Error ? error.message : "Unable to check the session.", true);
  }
}

void boot();
