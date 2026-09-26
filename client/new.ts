import { ApiClient, ApiError } from "./api";

const api = new ApiClient();
const form = document.getElementById("new-conversation-form") as HTMLFormElement;
const members = document.getElementById("new-member-id") as HTMLInputElement;
const submit = document.getElementById("create-submit") as HTMLButtonElement;
const status = document.getElementById("new-status") as HTMLElement;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const memberUserIds = members.value.split(",").map((id) => id.trim()).filter(Boolean);
  if (memberUserIds.length === 0) {
    setStatus("Enter at least one member UUID.", true);
    return;
  }
  submit.disabled = true;
  setStatus("Creating encrypted conversation…");
  try {
    const result = await api.createConversation(memberUserIds.length === 1 ? "dm" : "group", memberUserIds);
    window.location.assign(`/app?conversation=${encodeURIComponent(result.conversation.id)}`);
  } catch (error) {
    setStatus(error instanceof ApiError ? error.code : error instanceof Error ? error.message : "request_failed", true);
    submit.disabled = false;
  }
});

void api.me().catch((error) => {
  if (error instanceof ApiError && error.status === 401) window.location.assign("/");
  else setStatus(error instanceof Error ? error.message : "Unable to check the session.", true);
});
