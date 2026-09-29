import { ApiClient, type InstanceUserDirectoryEntry, type InstanceUserModeration } from "./api";
import { renderIcons } from "./icons";

const api = new ApiClient();
const logoutButton = document.getElementById("admin-logout-users") as HTMLButtonElement;
const status = document.getElementById("instance-users-status") as HTMLElement;
const searchForm = document.getElementById("instance-users-search-form") as HTMLFormElement;
const searchInput = document.getElementById("instance-users-search") as HTMLInputElement;
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
const warningForm = document.getElementById("instance-user-warning-form") as HTMLFormElement;
const warningReason = document.getElementById("instance-user-warning-reason") as HTMLTextAreaElement;
const warningDuration = document.getElementById("instance-user-warning-duration") as HTMLSelectElement;
const warningList = document.getElementById("instance-user-warnings") as HTMLElement;
const actionsList = document.getElementById("instance-user-actions-history") as HTMLElement;

const pageSize = 50;
let offset = 0;
let total = 0;
let selectedUserId: string | undefined;
let selectedDetails: InstanceUserModeration | undefined;
let listRequest = 0;
let detailRequest = 0;

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
  button.setAttribute("role", "listitem");
  button.setAttribute("aria-current", String(user.id === selectedUserId));
  const identity = el("span", "instance-user-row-identity");
  identity.append(el("strong", undefined, user.displayName), el("small", undefined, `@${user.username} · joined ${new Date(user.createdAt).toLocaleDateString()}`));
  const state = el("span", `instance-user-badge${user.banned ? " is-banned" : ""}`, user.banned ? "Banned" : "Active");
  button.append(identity, state);
  const warnings = el("span", "instance-user-warning-count", `${user.activeWarningCount} active warning${user.activeWarningCount === 1 ? "" : "s"}`);
  button.append(warnings);
  button.addEventListener("click", () => void loadUser(user.id));
  return button;
}

async function loadUsers() {
  const request = ++listRequest;
  userList.setAttribute("aria-busy", "true");
  userList.replaceChildren(el("p", "muted", "Loading accounts…"));
  setStatus("Loading the host-only chat account directory…", "loading");
  try {
    const result = await api.instanceUsers(searchInput.value.trim(), statusFilter.value as "all" | "active" | "banned", pageSize, offset);
    if (request !== listRequest) return;
    total = result.total;
    userList.replaceChildren();
    for (const user of result.users) userList.append(renderUserRow(user));
    if (result.users.length === 0) userList.append(el("p", "instance-users-empty muted", "No accounts match this search."));
    const currentPage = Math.floor(offset / pageSize) + 1;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    countLabel.textContent = `${total.toLocaleString()} account${total === 1 ? "" : "s"}`;
    pageLabel.textContent = `Page ${currentPage} of ${totalPages}`;
    previousButton.disabled = offset === 0;
    nextButton.disabled = offset + pageSize >= total;
    setStatus(`${total.toLocaleString()} chat accounts · global bans and warnings are audited.`, "success");
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

const actionLabels: Record<string, string> = {
  "user.suspended": "Account banned",
  "user.restored": "Account restored",
  "user.warned": "Instance warning issued",
  "user.warning_revoked": "Instance warning revoked",
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
  title.textContent = `${user.displayName} (@${user.username})`;
  meta.textContent = `Chat account created ${dateLabel(user.createdAt)} · ${user.id}`;
  accountState.className = `instance-user-state${user.ban ? " is-banned" : ""}`;
  accountState.textContent = user.ban ? "Banned from instance" : "Active account";
  banDetail.textContent = user.ban
    ? `Banned ${dateLabel(user.ban.createdAt)}${user.ban.reason ? ` · ${user.ban.reason}` : ""}. The user cannot sign in until restored.`
    : "A global ban blocks account sign-in across the installation. It is separate from space bans.";
  banReason.value = "";
  banReason.required = !user.ban;
  banReasonWrap.hidden = Boolean(user.ban);
  banButton.hidden = Boolean(user.ban);
  restoreButton.hidden = !user.ban;
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
  detailPanel.setAttribute("aria-busy", "true");
  await loadUsers();
  try {
    const details = await api.instanceUser(userId);
    if (request !== detailRequest || selectedUserId !== userId) return;
    renderUserDetails(details);
  } catch {
    if (request !== detailRequest) return;
    detailPanel.hidden = true;
    emptyPanel.hidden = false;
    setStatus("Unable to load moderation details for this account.", "error");
  } finally {
    if (request === detailRequest) detailPanel.setAttribute("aria-busy", "false");
  }
}

async function refreshSelectedUser() {
  if (selectedUserId) await loadUser(selectedUserId);
  else await loadUsers();
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  offset = 0;
  void loadUsers();
});
statusFilter.addEventListener("change", () => {
  offset = 0;
  void loadUsers();
});
previousButton.addEventListener("click", () => {
  offset = Math.max(0, offset - pageSize);
  void loadUsers();
});
nextButton.addEventListener("click", () => {
  if (offset + pageSize >= total) return;
  offset += pageSize;
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
  if (!window.confirm(`Ban @${selectedDetails.user.username} from the entire instance? They will be signed out and unable to sign in.`)) return;
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
  if (!window.confirm(`Restore @${selectedDetails.user.username}'s access to this instance?`)) return;
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

renderIcons(document);
void loadUsers();
