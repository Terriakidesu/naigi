import { ApiClient, type InstanceUserDirectoryEntry, type InstanceUserModeration } from "./api";
import { renderIcons } from "./icons";
import { initializeAdminTheme } from "./instance-admin-theme";
import { initializeAdminDashboard } from "./instance-admin-dashboard";

const api = new ApiClient();
const logoutButton = document.getElementById("admin-logout-users") as HTMLButtonElement;
const status = document.getElementById("instance-users-status") as HTMLElement;
const searchForm = document.getElementById("instance-users-search-form") as HTMLFormElement;
const searchInput = document.getElementById("instance-users-search") as HTMLInputElement;
const searchField = document.getElementById("instance-users-search-field") as HTMLSelectElement;
const statusFilter = document.getElementById("instance-users-filter") as HTMLSelectElement;
const countLabel = document.getElementById("instance-users-count") as HTMLElement;
const userList = document.getElementById("instance-users-list") as HTMLElement;
const previousButton = document.getElementById("instance-users-previous") as HTMLButtonElement;
const nextButton = document.getElementById("instance-users-next") as HTMLButtonElement;
const pageLabel = document.getElementById("instance-users-page") as HTMLElement;
const detailPanel = document.getElementById("instance-user-detail") as HTMLElement;
const emptyPanel = document.getElementById("instance-user-empty") as HTMLElement;
const title = document.getElementById("instance-user-title") as HTMLElement;
const meta = document.getElementById("instance-user-meta") as HTMLElement;
const accountState = document.getElementById("instance-user-state") as HTMLElement;
const banDetail = document.getElementById("instance-user-ban-detail") as HTMLElement;
const banReason = document.getElementById("instance-user-ban-reason") as HTMLTextAreaElement;
const banReasonWrap = document.getElementById("instance-user-ban-reason-wrap") as HTMLLabelElement;
const banButton = document.getElementById("instance-user-ban") as HTMLButtonElement;
const restoreButton = document.getElementById("instance-user-restore") as HTMLButtonElement;
const timeoutForm = document.getElementById("instance-user-timeout-form") as HTMLFormElement;
const timeoutReason = document.getElementById("instance-user-timeout-reason") as HTMLTextAreaElement;
const timeoutDuration = document.getElementById("instance-user-timeout-duration") as HTMLSelectElement;
const timeoutSubmit = document.getElementById("instance-user-timeout-submit") as HTMLButtonElement;
const timeoutRemove = document.getElementById("instance-user-timeout-remove") as HTMLButtonElement;
const timeoutState = document.getElementById("instance-user-timeout-state") as HTMLElement;
const timeoutDetail = document.getElementById("instance-user-timeout-detail") as HTMLElement;
const timeoutList = document.getElementById("instance-user-timeouts") as HTMLElement;
const warningForm = document.getElementById("instance-user-warning-form") as HTMLFormElement;
const warningReason = document.getElementById("instance-user-warning-reason") as HTMLTextAreaElement;
const warningDuration = document.getElementById("instance-user-warning-duration") as HTMLSelectElement;
const warningList = document.getElementById("instance-user-warnings") as HTMLElement;
const actionsList = document.getElementById("instance-user-actions-history") as HTMLElement;

const pageSize = 50;
let cursorStack: Array<string | undefined> = [undefined];
let nextCursor: string | null = null;
let selectedUserId: string | undefined;
let selectedDetails: InstanceUserModeration | undefined;
let listRequest = 0;
let detailRequest = 0;
let searchDebounceTimer: number | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setStatus(message: string, state: "success" | "warning" | "error" | "loading" = "success") {
  status.dataset.state = state;
  status.textContent = message;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString();
}

function renderUserRow(user: InstanceUserDirectoryEntry) {
  const button = el("button", "instance-user-row");
  button.type = "button";
  button.setAttribute("aria-pressed", String(user.id === selectedUserId));
  button.dataset.userId = user.id;
  const identity = el("span", "instance-user-row-identity");
  identity.append(el("strong", undefined, user.displayName), el("small", undefined, `@${user.username} · joined ${new Date(user.createdAt).toLocaleDateString()}`));
  const state = el(
    "span",
    `instance-user-badge${user.banned ? " is-banned" : user.timedOut ? " is-timed-out" : ""}`,
    user.banned ? "Banned" : user.timedOut ? "Timed out" : "Active",
  );
  button.append(identity, state);
  const warnings = el("span", "instance-user-warning-count", `${user.activeWarningCount} active warning${user.activeWarningCount === 1 ? "" : "s"}`);
  button.append(warnings);
  button.addEventListener("click", () => void loadUser(user.id));
  return button;
}

async function loadUsers() {
  const request = ++listRequest;
  const search = searchInput.value.trim();
  if (search.length < 2) {
    nextCursor = null;
    userList.replaceChildren(el("p", "muted", "Enter at least two characters to search usernames and display names."));
    countLabel.textContent = "Search required";
    pageLabel.textContent = "";
    previousButton.disabled = true;
    nextButton.disabled = true;
    userList.setAttribute("aria-busy", "false");
    setStatus("Account lookup is search-first; no full directory scan or account total is requested.");
    return;
  }
  userList.setAttribute("aria-busy", "true");
  userList.replaceChildren(el("p", "muted", "Loading accounts…"));
  setStatus("Loading the host-only chat account directory…", "loading");
  try {
    const result = await api.instanceUsers(search, searchField.value as "username" | "displayName", statusFilter.value as "all" | "active" | "banned", pageSize, cursorStack[cursorStack.length - 1]);
    if (request !== listRequest) return;
    nextCursor = result.nextCursor;
    userList.replaceChildren();
    for (const user of result.users) userList.append(renderUserRow(user));
    if (result.users.length === 0) userList.append(el("p", "instance-users-empty muted", "No accounts match this search."));
    countLabel.textContent = `${result.users.length}${result.nextCursor ? "+" : ""} result${result.users.length === 1 && !result.nextCursor ? "" : "s"} on this page`;
    pageLabel.textContent = `Page ${cursorStack.length}`;
    previousButton.disabled = cursorStack.length <= 1;
    nextButton.disabled = !nextCursor;
    setStatus(`Showing matching chat accounts · global bans and warnings are audited.`, "success");
  } catch {
    if (request !== listRequest) return;
    userList.replaceChildren(el("p", "instance-users-empty", "Unable to load accounts. Check the operator session and try again."));
    setStatus("Unable to load the chat account directory.", "error");
  } finally {
    if (request === listRequest) userList.setAttribute("aria-busy", "false");
  }
}

function warningState(warning: InstanceUserModeration["warnings"][number]) {
  if (warning.revokedAt) return "Revoked";
  if (!warning.active) return "Expired";
  return "Active";
}

function resetUserCursor() {
  cursorStack = [undefined];
  nextCursor = null;
  if (searchDebounceTimer !== undefined) window.clearTimeout(searchDebounceTimer);
  searchDebounceTimer = undefined;
  listRequest += 1;
  userList.setAttribute("aria-busy", "false");
  previousButton.disabled = true;
  nextButton.disabled = true;
}

function clearSelectedUser() {
  selectedUserId = undefined;
  selectedDetails = undefined;
  detailRequest += 1;
  detailPanel.hidden = true;
  detailPanel.setAttribute("aria-busy", "false");
  emptyPanel.hidden = false;
  for (const row of userList.querySelectorAll<HTMLButtonElement>(".instance-user-row")) {
    row.setAttribute("aria-pressed", "false");
  }
}

function scheduleUserSearch() {
  resetUserCursor();
  clearSelectedUser();
  if (searchDebounceTimer !== undefined) window.clearTimeout(searchDebounceTimer);
  searchDebounceTimer = undefined;
  const search = searchInput.value.trim();
  if (search.length < 2) {
    void loadUsers();
    return;
  }
  userList.setAttribute("aria-busy", "true");
  userList.replaceChildren(el("p", "muted", "Searching as you type…"));
  countLabel.textContent = "Searching…";
  setStatus("Waiting for the search prefix to settle…", "loading");
  searchDebounceTimer = window.setTimeout(() => {
    searchDebounceTimer = undefined;
    void loadUsers();
  }, 300);
}

function renderWarning(warning: InstanceUserModeration["warnings"][number]) {
  const row = el("article", "instance-user-history-row");
  const copy = el("div", "instance-user-history-copy");
  copy.append(
    el("strong", undefined, warning.reason),
    el("p", undefined, `Issued by @${warning.createdByUsername} · ${dateLabel(warning.createdAt)}`),
    el("p", undefined, warning.expiresAt ? `Expires ${dateLabel(warning.expiresAt)}` : "Does not expire"),
    el("p", undefined, warning.acknowledgedAt ? `Acknowledged ${dateLabel(warning.acknowledgedAt)}` : "Awaiting user acknowledgement"),
  );
  const actions = el("div", "instance-user-history-actions");
  actions.append(el("span", `instance-user-badge${warning.active ? " is-warning" : ""}`, warningState(warning)));
  if (warning.active) {
    const revoke = el("button", "secondary", "Revoke");
    revoke.type = "button";
    revoke.addEventListener("click", async () => {
      revoke.disabled = true;
      try {
        await api.revokeInstanceWarning(warning.id);
        setStatus("Instance warning revoked.");
        await loadUser(selectedUserId!);
      } catch {
        revoke.disabled = false;
        setStatus("Unable to revoke this warning.", "error");
      }
    });
    actions.append(revoke);
  }
  row.append(copy, actions);
  return row;
}

function renderTimeout(timeout: InstanceUserModeration["timeouts"][number]) {
  const row = el("article", "instance-user-history-row");
  const copy = el("div", "instance-user-history-copy");
  copy.append(
    el("strong", undefined, timeout.reason),
    el("p", undefined, `Issued by @${timeout.createdByUsername} · ${dateLabel(timeout.createdAt)}`),
    el("p", undefined, `Expires ${dateLabel(timeout.expiresAt)}`),
  );
  const actions = el("div", "instance-user-history-actions");
  const state = timeout.active
    ? "Active"
    : timeout.revocationAction === "replaced" ? "Replaced"
      : timeout.revocationAction === "removed" ? "Removed" : "Expired";
  actions.append(el("span", `instance-user-badge${timeout.active ? " is-timed-out" : ""}`, state));
  if (timeout.revokedAt && timeout.revokedByUsername) {
    copy.append(el("p", undefined, `${timeout.revocationAction === "replaced" ? "Replaced" : "Removed"} by @${timeout.revokedByUsername} · ${dateLabel(timeout.revokedAt)}`));
  }
  row.append(copy, actions);
  return row;
}

const actionLabels: Record<string, string> = {
  "user.suspended": "Account banned",
  "user.restored": "Account restored",
  "user.warned": "Instance warning issued",
  "user.warning_revoked": "Instance warning revoked",
  "user.timed_out": "Installation-wide send timeout issued",
  "user.timeout_removed": "Installation-wide send timeout removed",
  "user.timeout_replaced": "Installation-wide send timeout updated",
};

function renderAction(action: InstanceUserModeration["actions"][number]) {
  const row = el("article", "instance-user-action-row");
  const summary = el("strong", undefined, actionLabels[action.action] ?? action.action);
  const detail = el("span", undefined, `@${action.operatorUsername} · ${dateLabel(action.createdAt)}`);
  row.append(summary, detail);
  if (typeof action.details.reason === "string" && action.details.reason) row.append(el("p", undefined, `Reason: ${action.details.reason}`));
  return row;
}

function renderUserDetails(details: InstanceUserModeration) {
  selectedDetails = details;
  const { user } = details;
  const activeTimeout = details.timeouts.find((timeout) => timeout.active);
  title.textContent = `${user.displayName} (@${user.username})`;
  meta.textContent = `Chat account created ${dateLabel(user.createdAt)} · ${user.id}`;
  accountState.className = `instance-user-state${user.ban ? " is-banned" : activeTimeout ? " is-timed-out" : ""}`;
  accountState.textContent = user.ban ? "Banned from instance" : activeTimeout ? "Timed out" : "Active account";
  banDetail.textContent = user.ban
    ? `Banned ${dateLabel(user.ban.createdAt)}${user.ban.reason ? ` · ${user.ban.reason}` : ""}. The user cannot sign in until restored.`
    : "A global ban blocks account sign-in across the installation. It is separate from space bans.";
  banReason.value = "";
  banReason.required = !user.ban;
  banReasonWrap.hidden = Boolean(user.ban);
  banButton.hidden = Boolean(user.ban);
  restoreButton.hidden = !user.ban;
  timeoutState.hidden = !activeTimeout;
  timeoutState.textContent = activeTimeout ? "Timed out" : "Not timed out";
  timeoutDetail.textContent = activeTimeout
    ? `Can sign in and read messages, but cannot send anywhere until ${dateLabel(activeTimeout.expiresAt)}.`
    : "Blocks sending messages and uploads in all spaces and direct conversations. Sign-in, reading, and receiving remain available.";
  timeoutReason.value = "";
  timeoutSubmit.textContent = activeTimeout ? "Update timeout" : "Apply timeout";
  timeoutSubmit.disabled = Boolean(user.ban);
  timeoutRemove.hidden = !activeTimeout;
  timeoutList.replaceChildren();
  if (details.timeouts.length === 0) timeoutList.append(el("p", "muted small", "No installation-wide timeouts have been issued."));
  else for (const timeout of details.timeouts) timeoutList.append(renderTimeout(timeout));
  warningList.replaceChildren();
  if (details.warnings.length === 0) warningList.append(el("p", "muted small", "No instance warnings have been issued."));
  else for (const warning of details.warnings) warningList.append(renderWarning(warning));
  actionsList.replaceChildren();
  if (details.actions.length === 0) actionsList.append(el("p", "muted small", "No host moderation actions recorded for this account."));
  else for (const action of details.actions) actionsList.append(renderAction(action));
  detailPanel.hidden = false;
  emptyPanel.hidden = true;
}

async function loadUser(userId: string) {
  selectedUserId = userId;
  selectedDetails = undefined;
  const request = ++detailRequest;
  detailPanel.hidden = false;
  emptyPanel.hidden = true;
  detailPanel.setAttribute("aria-busy", "true");
  title.textContent = "Loading account…";
  meta.textContent = "Fetching access status and moderation history.";
  accountState.className = "instance-user-state is-loading";
  accountState.textContent = "Loading";
  for (const row of userList.querySelectorAll<HTMLButtonElement>(".instance-user-row")) {
    row.setAttribute("aria-pressed", String(row.dataset.userId === userId));
  }
  try {
    const details = await api.instanceUser(userId);
    if (request !== detailRequest || selectedUserId !== userId) return;
    renderUserDetails(details);
  } catch {
    if (request !== detailRequest) return;
    title.textContent = "Account details unavailable";
    meta.textContent = "The directory selection is unchanged. Retry by selecting the account again.";
    accountState.className = "instance-user-state is-error";
    accountState.textContent = "Unavailable";
    setStatus("Unable to load moderation details for this account.", "error");
  } finally {
    if (request === detailRequest) detailPanel.setAttribute("aria-busy", "false");
  }
}

async function refreshSelectedUser() {
  const userId = selectedUserId;
  if (!userId) return loadUsers();
  await loadUsers();
  if (selectedUserId !== userId) return;
  await loadUser(userId);
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  resetUserCursor();
  clearSelectedUser();
  if (searchDebounceTimer !== undefined) window.clearTimeout(searchDebounceTimer);
  searchDebounceTimer = undefined;
  void loadUsers();
});
searchInput.addEventListener("input", scheduleUserSearch);
searchField.addEventListener("change", () => {
  resetUserCursor();
  clearSelectedUser();
  void loadUsers();
});
statusFilter.addEventListener("change", () => {
  resetUserCursor();
  clearSelectedUser();
  void loadUsers();
});
previousButton.addEventListener("click", () => {
  if (cursorStack.length <= 1) return;
  cursorStack.pop();
  nextCursor = null;
  void loadUsers();
});
nextButton.addEventListener("click", () => {
  if (!nextCursor) return;
  cursorStack.push(nextCursor);
  nextCursor = null;
  void loadUsers();
});

banButton.addEventListener("click", async () => {
  if (!selectedUserId || !selectedDetails || selectedDetails.user.ban) return;
  const reason = banReason.value.trim();
  if (!reason) {
    banReason.focus();
    setStatus("Add a reason before applying an instance-wide ban.", "warning");
    return;
  }
  if (!window.confirm(`Ban @${selectedDetails.user.username} from this instance? Their active sessions will be revoked and they will be unable to sign in until restored. Account data is not deleted. The reason will be kept in the audit history.`)) return;
  banButton.disabled = true;
  try {
    await api.banInstanceUser(selectedUserId, reason);
    setStatus("Account banned from the instance.");
    await refreshSelectedUser();
  } catch {
    setStatus("Unable to ban this account.", "error");
  } finally {
    banButton.disabled = false;
  }
});

restoreButton.addEventListener("click", async () => {
  if (!selectedUserId || !selectedDetails?.user.ban) return;
  if (!window.confirm(`Restore @${selectedDetails.user.username}'s sign-in access? Previously revoked sessions will not be restored.`)) return;
  restoreButton.disabled = true;
  try {
    await api.restoreInstanceUser(selectedUserId);
    setStatus("Account access restored.");
    await refreshSelectedUser();
  } catch {
    setStatus("Unable to restore this account.", "error");
  } finally {
    restoreButton.disabled = false;
  }
});

timeoutForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedUserId || !selectedDetails || selectedDetails.user.ban) return;
  const reason = timeoutReason.value.trim();
  if (!reason) {
    timeoutReason.focus();
    setStatus("Add a reason before applying an instance-wide send timeout.", "warning");
    return;
  }
  const activeTimeout = selectedDetails.timeouts.find((timeout) => timeout.active);
  if (activeTimeout && !window.confirm(`Replace the existing send timeout for @${selectedDetails.user.username}? The new duration starts from now.`)) return;
  timeoutSubmit.disabled = true;
  try {
    const result = await api.timeoutInstanceUser(selectedUserId, reason, Number(timeoutDuration.value));
    timeoutReason.value = "";
    setStatus(`Sending is blocked until ${dateLabel(result.timeout.expiresAt)}.`);
    await refreshSelectedUser();
  } catch {
    setStatus("Unable to apply the installation-wide timeout.", "error");
  } finally {
    timeoutSubmit.disabled = false;
  }
});

timeoutRemove.addEventListener("click", async () => {
  if (!selectedUserId || !selectedDetails?.timeouts.some((timeout) => timeout.active)) return;
  if (!window.confirm(`Remove the installation-wide send timeout for @${selectedDetails.user.username}?`)) return;
  timeoutRemove.disabled = true;
  try {
    await api.removeInstanceUserTimeout(selectedUserId);
    setStatus("Installation-wide send timeout removed.");
    await refreshSelectedUser();
  } catch {
    setStatus("Unable to remove the timeout.", "error");
  } finally {
    timeoutRemove.disabled = false;
  }
});

warningForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedUserId) return;
  const reason = warningReason.value.trim();
  if (!reason) {
    warningReason.focus();
    return;
  }
  const expiresInSeconds = warningDuration.value === "never" ? undefined : Number(warningDuration.value);
  const submit = warningForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
  submit.disabled = true;
  try {
    await api.warnInstanceUser(selectedUserId, reason, expiresInSeconds);
    warningForm.reset();
    setStatus("Instance warning issued. The user will see it in chat.");
    await refreshSelectedUser();
  } catch {
    setStatus("Unable to issue this warning.", "error");
  } finally {
    submit.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    await api.adminLogout();
    window.location.assign("/instance-admin");
  } catch {
    logoutButton.disabled = false;
  }
});

initializeAdminTheme();
renderIcons(document);
void initializeAdminDashboard(api).catch((error) => setStatus(error instanceof Error ? error.message : "Unable to load operator access.", "error"));
void loadUsers();
