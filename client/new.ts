import { ApiClient, ApiError, type User } from "./api";

const api = new ApiClient();
const form = document.getElementById("new-conversation-form") as HTMLFormElement;
const search = document.getElementById("member-search") as HTMLInputElement;
const results = document.getElementById("member-results") as HTMLElement;
const selectedMembers = document.getElementById("selected-members") as HTMLElement;
const selectedCount = document.getElementById("selected-count") as HTMLElement;
const submit = document.getElementById("create-submit") as HTMLButtonElement;
const status = document.getElementById("new-status") as HTMLElement;

const selected = new Map<string, User>();
let searchTimer: number | undefined;
let searchRequest = 0;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function avatarColor(seed: string) {
  const colors = ["#5865f2", "#3ba55d", "#ed4245", "#eb459e", "#faa61a", "#00b0f4", "#9b59b6"];
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

function createAvatar(user: User, className: string) {
  const avatar = document.createElement("span");
  avatar.className = className;
  avatar.textContent = user.displayName.slice(0, 1).toUpperCase();
  avatar.style.setProperty("--avatar-color", avatarColor(user.id));
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

function renderSelected() {
  selectedMembers.replaceChildren();
  selectedCount.textContent = String(selected.size);
  submit.disabled = selected.size === 0;

  if (selected.size === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No members selected yet.";
    selectedMembers.append(empty);
    return;
  }

  for (const user of selected.values()) {
    const row = document.createElement("div");
    row.className = "selected-member";
    row.append(createAvatar(user, "picker-avatar"));
    const copy = document.createElement("div");
    copy.className = "picker-copy";
    const name = document.createElement("strong");
    name.textContent = user.displayName;
    const username = document.createElement("span");
    username.textContent = `@${user.username}`;
    copy.append(name, username);
    const remove = document.createElement("button");
    remove.className = "icon-button";
    remove.type = "button";
    remove.title = `Remove ${user.displayName}`;
    remove.setAttribute("aria-label", `Remove ${user.displayName}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      selected.delete(user.id);
      renderSelected();
      renderResults();
    });
    row.append(copy, remove);
    selectedMembers.append(row);
  }
}

let currentResults: User[] = [];

function renderResults() {
  results.replaceChildren();
  if (currentResults.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = search.value.trim().length < 2 ? "Type at least two characters to search." : "No matching people found.";
    results.append(empty);
    return;
  }

  for (const user of currentResults) {
    const row = document.createElement("button");
    row.className = "member-option";
    row.type = "button";
    row.disabled = selected.has(user.id);
    row.append(createAvatar(user, "picker-avatar"));
    const copy = document.createElement("span");
    copy.className = "picker-copy";
    const name = document.createElement("strong");
    name.textContent = user.displayName;
    const username = document.createElement("span");
    username.textContent = `@${user.username}`;
    copy.append(name, username);
    const action = document.createElement("span");
    action.className = "picker-action";
    action.textContent = selected.has(user.id) ? "Added" : "Add";
    row.append(copy, action);
    row.addEventListener("click", () => {
      selected.set(user.id, user);
      renderSelected();
      renderResults();
    });
    results.append(row);
  }
}

async function searchUsers() {
  const query = search.value.trim();
  const request = ++searchRequest;
  if (query.length < 2) {
    currentResults = [];
    renderResults();
    return;
  }

  results.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "muted";
  loading.textContent = "Searching…";
  results.append(loading);
  try {
    const users = (await api.searchUsers(query)).users;
    if (request !== searchRequest) return;
    currentResults = users;
    renderResults();
  } catch (error) {
    if (request !== searchRequest) return;
    currentResults = [];
    setStatus(error instanceof Error ? error.message : "Unable to search for members.", true);
    renderResults();
  }
}

search.addEventListener("input", () => {
  if (searchTimer !== undefined) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void searchUsers(), 220);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (selected.size === 0) return;
  submit.disabled = true;
  setStatus("Creating encrypted conversation…");
  try {
    const memberUserIds = [...selected.keys()];
    const result = await api.createConversation(memberUserIds.length === 1 ? "dm" : "group", memberUserIds);
    window.location.assign(`/app?conversation=${encodeURIComponent(result.conversation.id)}`);
  } catch (error) {
    setStatus(error instanceof ApiError ? error.code : error instanceof Error ? error.message : "request_failed", true);
    submit.disabled = false;
  }
});

renderSelected();
renderResults();

void api.me().catch((error) => {
  if (error instanceof ApiError && error.status === 401) window.location.assign("/");
  else setStatus(error instanceof Error ? error.message : "Unable to check the session.", true);
});
