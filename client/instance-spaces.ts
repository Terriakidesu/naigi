import { ApiClient, type InstanceSpaceAuditEntry, type InstanceSpaceDirectoryEntry } from "./api";
import { renderIcons } from "./icons";
import { initializeAdminTheme } from "./instance-admin-theme";
import { initializeAdminDashboard } from "./instance-admin-dashboard";

const api = new ApiClient();
const logoutButton = document.getElementById("admin-logout-spaces") as HTMLButtonElement;
const status = document.getElementById("instance-spaces-status") as HTMLElement;
const statusFilter = document.getElementById("instance-spaces-filter") as HTMLSelectElement;
const countLabel = document.getElementById("instance-spaces-count") as HTMLElement;
const spaceList = document.getElementById("instance-spaces-list") as HTMLElement;
const previousButton = document.getElementById("instance-spaces-previous") as HTMLButtonElement;
const nextButton = document.getElementById("instance-spaces-next") as HTMLButtonElement;
const pageLabel = document.getElementById("instance-spaces-page") as HTMLElement;
const detailPanel = document.getElementById("instance-space-detail") as HTMLElement;
const emptyPanel = document.getElementById("instance-space-empty") as HTMLElement;
const spaceId = document.getElementById("instance-space-id") as HTMLElement;
const spaceMeta = document.getElementById("instance-space-meta") as HTMLElement;
const spaceState = document.getElementById("instance-space-state") as HTMLElement;
const reasonInput = document.getElementById("instance-space-reason") as HTMLTextAreaElement;
const toggleButton = document.getElementById("instance-space-toggle") as HTMLButtonElement;
const controlTitle = document.getElementById("instance-space-control-title") as HTMLElement;
const controlCopy = document.getElementById("instance-space-control-copy") as HTMLElement;
const auditRoot = document.getElementById("instance-space-audit") as HTMLElement;
const auditPrevious = document.getElementById("instance-space-audit-previous") as HTMLButtonElement;
const auditNext = document.getElementById("instance-space-audit-next") as HTMLButtonElement;
const auditPageLabel = document.getElementById("instance-space-audit-page") as HTMLElement;

const pageSize = 50;
const auditPageSize = 50;
let spaceCursorStack: Array<string | undefined> = [undefined];
let auditCursorStack: Array<string | undefined> = [undefined];
let nextSpaceCursor: string | null = null;
let nextAuditCursor: string | null = null;
let selectedSpace: InstanceSpaceDirectoryEntry | undefined;
let listRequest = 0;
let auditRequest = 0;

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

function renderSpaceRow(space: InstanceSpaceDirectoryEntry) {
  const button = el("button", "instance-space-row");
  button.type = "button";
  button.setAttribute("role", "listitem");
  button.setAttribute("aria-current", String(space.id === selectedSpace?.id));
  const copy = el("span", "instance-space-row-copy");
  copy.append(el("code", "instance-space-row-id", space.id));
  copy.append(el("small", undefined, `${space.activeMemberCount.toLocaleString()} active member${space.activeMemberCount === 1 ? "" : "s"} · created ${new Date(space.createdAt).toLocaleDateString()}`));
  button.append(copy, el("span", `instance-space-state${space.deactivatedAt ? " is-deactivated" : ""}`, space.deactivatedAt ? "Deactivated" : "Active"));
  button.addEventListener("click", () => void selectSpace(space));
  return button;
}

async function loadSpaces() {
  const request = ++listRequest;
  spaceList.setAttribute("aria-busy", "true");
  spaceList.replaceChildren(el("p", "muted", "Loading spaces…"));
  setStatus("Loading a bounded page of host-visible space metadata…", "loading");
  try {
    const result = await api.instanceSpaces(statusFilter.value as "all" | "active" | "deactivated", pageSize, spaceCursorStack[spaceCursorStack.length - 1]);
    if (request !== listRequest) return;
    nextSpaceCursor = result.nextCursor;
    spaceList.replaceChildren();
    for (const space of result.spaces) spaceList.append(renderSpaceRow(space));
    if (!result.spaces.length) spaceList.append(el("p", "instance-users-empty muted", "No spaces on this page."));
    countLabel.textContent = `${result.spaces.length}${result.nextCursor ? "+" : ""} space${result.spaces.length === 1 && !result.nextCursor ? "" : "s"} on this page`;
    pageLabel.textContent = `Page ${spaceCursorStack.length}`;
    previousButton.disabled = spaceCursorStack.length <= 1;
    nextButton.disabled = !nextSpaceCursor;
    setStatus("Space activation preserves data and memberships; all state changes are audited.");
  } catch {
    if (request !== listRequest) return;
    spaceList.replaceChildren(el("p", "instance-users-empty", "Unable to load spaces. Check the operator session and try again."));
    setStatus("Unable to load the space directory.", "error");
  } finally {
    if (request === listRequest) spaceList.setAttribute("aria-busy", "false");
  }
}

function renderAuditEntry(entry: InstanceSpaceAuditEntry) {
  const row = el("article", "instance-space-audit-row");
  const heading = el("div", "instance-space-audit-heading");
  heading.append(el("strong", undefined, entry.action.replaceAll(".", " · ")));
  heading.append(el("span", `instance-space-audit-source${entry.source === "host" ? " is-host" : ""}`, entry.source === "host" ? "Host operator" : "Space action"));
  const copy = el("div", "instance-space-audit-copy");
  copy.append(el("p", undefined, `${entry.actor} · ${dateLabel(entry.createdAt)}`));
  if (entry.reason) copy.append(el("p", undefined, `Reason: ${entry.reason}`));
  if (entry.targetId) copy.append(el("p", undefined, `Target ID: ${entry.targetId}${entry.targetUserId ? ` · User ID: ${entry.targetUserId}` : ""}`));
  row.append(heading, copy);
  return row;
}

async function loadAudit() {
  if (!selectedSpace) return;
  const request = ++auditRequest;
  auditRoot.setAttribute("aria-busy", "true");
  auditRoot.replaceChildren(el("p", "muted", "Loading audit history…"));
  try {
    const result = await api.instanceSpaceAudit(selectedSpace.id, auditPageSize, auditCursorStack[auditCursorStack.length - 1]);
    if (request !== auditRequest) return;
    nextAuditCursor = result.nextCursor;
    auditRoot.replaceChildren();
    for (const entry of result.logs) auditRoot.append(renderAuditEntry(entry));
    if (!result.logs.length) auditRoot.append(el("p", "muted", "No audit entries have been recorded for this space."));
    auditPageLabel.textContent = `Page ${auditCursorStack.length}`;
    auditPrevious.disabled = auditCursorStack.length <= 1;
    auditNext.disabled = !nextAuditCursor;
  } catch {
    if (request !== auditRequest) return;
    auditRoot.replaceChildren(el("p", "instance-users-empty", "Unable to load this space’s audit history."));
  } finally {
    if (request === auditRequest) auditRoot.setAttribute("aria-busy", "false");
  }
}

function syncSelectedSpace() {
  if (!selectedSpace) return;
  spaceId.textContent = selectedSpace.id;
  spaceMeta.textContent = `Created ${dateLabel(selectedSpace.createdAt)} · ${selectedSpace.activeMemberCount.toLocaleString()} active members`;
  const active = selectedSpace.deactivatedAt === null;
  spaceState.textContent = active ? "Active" : "Deactivated";
  spaceState.classList.toggle("is-deactivated", !active);
  controlTitle.textContent = active ? "Deactivate this space?" : "Reactivate this space?";
  controlCopy.textContent = active
    ? "Existing members and new joins will lose access. Space data and memberships are retained for reactivation."
    : "Restore access for existing members and allow new joins again. This does not change retained data or memberships.";
  toggleButton.textContent = active ? "Deactivate space" : "Reactivate space";
  toggleButton.classList.toggle("danger-button", active);
  toggleButton.classList.toggle("secondary", !active);
}

async function selectSpace(space: InstanceSpaceDirectoryEntry) {
  selectedSpace = space;
  detailPanel.hidden = false;
  emptyPanel.hidden = true;
  syncSelectedSpace();
  for (const row of spaceList.querySelectorAll<HTMLButtonElement>(".instance-space-row")) {
    row.setAttribute("aria-current", String(row.querySelector("code")?.textContent === space.id));
  }
  auditCursorStack = [undefined];
  nextAuditCursor = null;
  await loadAudit();
}

statusFilter.addEventListener("change", () => {
  spaceCursorStack = [undefined];
  nextSpaceCursor = null;
  void loadSpaces();
});
previousButton.addEventListener("click", () => {
  if (spaceCursorStack.length <= 1) return;
  spaceCursorStack.pop();
  nextSpaceCursor = null;
  void loadSpaces();
});
nextButton.addEventListener("click", () => {
  if (!nextSpaceCursor) return;
  spaceCursorStack.push(nextSpaceCursor);
  nextSpaceCursor = null;
  void loadSpaces();
});
auditPrevious.addEventListener("click", () => {
  if (auditCursorStack.length <= 1) return;
  auditCursorStack.pop();
  nextAuditCursor = null;
  void loadAudit();
});
auditNext.addEventListener("click", () => {
  if (!nextAuditCursor) return;
  auditCursorStack.push(nextAuditCursor);
  nextAuditCursor = null;
  void loadAudit();
});

toggleButton.addEventListener("click", async () => {
  if (!selectedSpace) return;
  const reason = reasonInput.value.trim();
  if (!reason) {
    reasonInput.focus();
    setStatus("Enter an audit reason before changing space access.", "warning");
    return;
  }
  const active = selectedSpace.deactivatedAt === null;
  const action = active ? "deactivate" : "reactivate";
  if (!window.confirm(`${active ? "Deactivate" : "Reactivate"} space ${selectedSpace.id}? ${active ? "All member access and new joins will be blocked; data and memberships will be retained." : "Member access and new joins will be restored."}`)) return;
  toggleButton.disabled = true;
  try {
    const result = await api.setInstanceSpaceActivation(selectedSpace.id, !active, reason);
    selectedSpace = result.space;
    reasonInput.value = "";
    syncSelectedSpace();
    setStatus(`Space ${action}d${result.changed ? " and audited" : "; no state change was needed"}.`);
    void loadSpaces();
    auditCursorStack = [undefined];
    await loadAudit();
  } catch {
    setStatus(`Unable to ${action} this space.`, "error");
  } finally {
    toggleButton.disabled = false;
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
void initializeAdminDashboard(api).catch((error) => console.error("Unable to load operator identity", error));
void loadSpaces();
