import { ApiClient, ApiError } from "./api";

const api = new ApiClient();
const form = document.getElementById("admin-auth-form") as HTMLFormElement;
const username = document.getElementById("admin-auth-username") as HTMLInputElement;
const password = document.getElementById("admin-auth-password") as HTMLInputElement;
const submit = document.getElementById("admin-auth-submit") as HTMLButtonElement;
const status = document.getElementById("admin-auth-status") as HTMLElement;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  setStatus("Signing you in…");
  try {
    await api.adminLogin(username.value.trim(), password.value);
    window.location.assign("/instance-admin");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setStatus("The operator username or password is incorrect.", true);
    } else {
      setStatus(error instanceof Error ? error.message : "Unable to sign in.", true);
    }
    submit.disabled = false;
  }
});

async function boot() {
  try {
    await api.adminMe();
    window.location.assign("/instance-admin");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) {
      setStatus(error instanceof Error ? error.message : "Unable to check operator session.", true);
    }
  }
}

void boot();
