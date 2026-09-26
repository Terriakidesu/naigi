import { ApiClient, ApiError } from "./api";

const api = new ApiClient();
const form = document.getElementById("auth-form") as HTMLFormElement;
const username = document.getElementById("auth-username") as HTMLInputElement;
const password = document.getElementById("auth-password") as HTMLInputElement;
const submit = document.getElementById("auth-submit") as HTMLButtonElement;
const status = document.getElementById("auth-status") as HTMLElement;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function readableError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "invalid_credentials") return "The username or password is incorrect.";
    if (error.code === "username_taken") return "That username is already in use.";
    return error.code;
  }
  return error instanceof Error ? error.message : "request_failed";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  setStatus("Signing you in…");
  try {
    await api.login(username.value.trim(), password.value);
    window.location.assign("/unlock");
  } catch (error) {
    setStatus(readableError(error), true);
    submit.disabled = false;
  }
});

async function boot() {
  try {
    await api.me();
    window.location.assign("/unlock");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) setStatus(readableError(error), true);
  }
}

void boot();
