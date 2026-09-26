import { ApiClient, ApiError } from "./api";

const api = new ApiClient();
const form = document.getElementById("register-form") as HTMLFormElement;
const username = document.getElementById("register-username") as HTMLInputElement;
const displayName = document.getElementById("register-display-name") as HTMLInputElement;
const password = document.getElementById("register-password") as HTMLInputElement;
const submit = document.getElementById("register-submit") as HTMLButtonElement;
const status = document.getElementById("register-status") as HTMLElement;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  setStatus("Creating your account…");
  try {
    await api.register(username.value.trim(), password.value, displayName.value.trim());
    window.location.assign("/unlock");
  } catch (error) {
    if (error instanceof ApiError && error.code === "username_taken") setStatus("That username is already in use.", true);
    else setStatus(error instanceof Error ? error.message : "Unable to create account.", true);
    submit.disabled = false;
  }
});

void api.me().then(() => window.location.assign("/unlock")).catch(() => undefined);
