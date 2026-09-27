import { ApiClient, ApiError } from "./api";
import { renderIcons } from "./icons";
import {
  clearSessionPassphrase,
  forgetRememberedPassphrase,
  localSessionLocked,
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
  remember.title = "Remembered unlock requires a secure browser context (HTTPS or localhost).";
  const hint = document.createElement("p");
  hint.className = "muted small";
  hint.textContent = window.isSecureContext
    ? "Remembered unlock is unavailable in this browser. Check that Web Crypto and IndexedDB are enabled."
    : "This address is not secure. To remember your passphrase, open Naigi over HTTPS (or localhost). Plain HTTP on another device cannot safely remember an unlock.";
  remember.closest("label")?.after(hint);
}

function destination() {
  const requested = new URLSearchParams(window.location.search).get("return");
  return requested && requested.startsWith("/") && !requested.startsWith("//") ? requested : "/app";
}

function readableError(error: unknown) {
  if (error instanceof Error && error.message === "remembered_unlock_requires_secure_context") {
    return "Remembered unlock requires HTTPS or localhost with Web Crypto and IndexedDB available.";
  }
  return error instanceof Error ? error.message : "Unable to unlock this browser.";
}

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function unlockFailureMessage(reason: string | null) {
  if (reason === "local_crypto_store_unlock_failed") {
    return "Naigi could not open this browser’s encrypted key store. Check the local encryption passphrase, and make sure you are using the same browser profile.";
  }
  return "Naigi could not finish opening encrypted chat. Try again.";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  try {
    if (remember.checked) await rememberPassphrase(currentUserId ?? (await api.me()).user.id, passphrase.value);
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
  if (reason) setStatus(unlockFailureMessage(reason), true);
  try {
    const result = await api.me();
    currentUserId = result.user.id;
    if (!reason && !manualUnlock && !localSessionLocked()) {
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

renderIcons();
void boot();
