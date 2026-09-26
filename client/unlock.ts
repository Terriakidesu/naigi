import { ApiClient, ApiError } from "./api";

const api = new ApiClient();
const form = document.getElementById("unlock-form") as HTMLFormElement;
const passphrase = document.getElementById("local-passphrase") as HTMLInputElement;
const submit = document.getElementById("unlock-submit") as HTMLButtonElement;
const status = document.getElementById("unlock-status") as HTMLElement;
const logout = document.getElementById("unlock-logout") as HTMLButtonElement;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    sessionStorage.setItem("priv-chat.local-passphrase", passphrase.value);
    window.location.assign("/app");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to unlock this browser.", true);
  }
});

logout.addEventListener("click", async () => {
  await api.logout().catch(() => undefined);
  window.location.assign("/");
});

async function boot() {
  const reason = new URLSearchParams(window.location.search).get("error");
  if (reason) setStatus("That passphrase did not unlock this browser. Try again.", true);
  try {
    await api.me();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) window.location.assign("/");
    else setStatus(error instanceof Error ? error.message : "Unable to check the session.", true);
  }
}

void boot();
