import { ApiClient, type AdminOperator, type AdminOperatorAuditEntry } from "./api";
import { renderIcons } from "./icons";
import { initializeAdminDashboard } from "./instance-admin-dashboard";
import { initializeAdminTheme } from "./instance-admin-theme";

const api = new ApiClient();
const status = document.getElementById("instance-operators-status") as HTMLElement;
const createForm = document.getElementById("instance-operator-create-form") as HTMLFormElement;
const usernameInput = document.getElementById("instance-operator-username") as HTMLInputElement;
const passwordInput = document.getElementById("instance-operator-password") as HTMLInputElement;
const roleInput = document.getElementById("instance-operator-role") as HTMLSelectElement;
const createButton = document.getElementById("instance-operator-create") as HTMLButtonElement;
const refreshButton = document.getElementById("refresh-instance-operators") as HTMLButtonElement;
const refreshAuditButton = document.getElementById("refresh-instance-operator-audit") as HTMLButtonElement;
const operatorList = document.getElementById("instance-operators-list") as HTMLElement;
const auditList = document.getElementById("instance-operator-audit") as HTMLElement;
const logoutButton = document.getElementById("admin-logout-operators") as HTMLButtonElement;
let currentOperatorId = "";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.dataset.state = error ? "error" : "success";
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString();
}

function operatorRow(operator: AdminOperator) {
  const row = el("article", "instance-operator-row");
  const identity = el("div", "instance-operator-identity");
  identity.append(el("strong", undefined, `@${operator.username}`));
  identity.append(el("small", undefined, `Created ${dateLabel(operator.createdAt)}`));

  const roleWrap = el("label", "instance-operator-role");
  roleWrap.append(el("span", undefined, "Role"));
  const role = el("select");
  role.setAttribute("aria-label", `Role for ${operator.username}`);
  for (const [value, label] of [["admin", "Admin"], ["moderator", "Moderator"]]) {
    const option = el("option", undefined, label);
    option.value = value;
    role.append(option);
  }
  role.value = operator.role;
  role.disabled = operator.id === currentOperatorId;
  role.addEventListener("change", async () => {
    const nextRole = role.value as AdminOperator["role"];
    if (nextRole === "admin" && !window.confirm(`Grant Admin access to @${operator.username}? Admins can access platform controls and manage host operators.`)) {
      role.value = operator.role;
      return;
    }
    role.disabled = true;
    try {
      const result = await api.updateAdminOperator(operator.id, { role: nextRole });
      setStatus(result.changed ? `Updated @${operator.username} to ${result.operator.role}.` : "No changes were needed.");
      await Promise.all([loadOperators(), loadAudit()]);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to update the operator role.", true);
      await loadOperators();
    }
  });
  roleWrap.append(role);

  const state = el("span", `instance-operator-state${operator.disabled ? " is-disabled" : ""}`, operator.disabled ? "Disabled" : "Active");
  const disable = el("button", operator.disabled ? "secondary" : "danger-button", operator.disabled ? "Enable" : "Disable");
  disable.type = "button";
  disable.disabled = operator.id === currentOperatorId;
  disable.setAttribute("aria-label", `${operator.disabled ? "Enable" : "Disable"} operator ${operator.username}`);
  disable.addEventListener("click", async () => {
    const nextDisabled = !operator.disabled;
    if (nextDisabled && !window.confirm(`Disable @${operator.username}? Their active admin sessions will be revoked.`)) return;
    disable.disabled = true;
    try {
      await api.updateAdminOperator(operator.id, { disabled: nextDisabled });
      setStatus(`${nextDisabled ? "Disabled" : "Enabled"} @${operator.username}.`);
      await Promise.all([loadOperators(), loadAudit()]);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to update the operator.", true);
      await loadOperators();
    }
  });

  row.append(identity, roleWrap, state, disable);
  return row;
}

async function loadOperators() {
  operatorList.setAttribute("aria-busy", "true");
  try {
    const result = await api.adminOperators();
    operatorList.replaceChildren();
    if (result.operators.length === 0) {
      operatorList.append(el("p", "muted", "No host operators have been created."));
      return;
    }
    for (const operator of result.operators) operatorList.append(operatorRow(operator));
    if (result.truncated) operatorList.append(el("p", "muted small", "Showing the first 200 operators. Use the CLI for larger installations."));
  } catch (error) {
    operatorList.replaceChildren(el("p", "muted", "Unable to load operators."));
    setStatus(error instanceof Error ? error.message : "Unable to load operators.", true);
  } finally {
    operatorList.setAttribute("aria-busy", "false");
  }
}

function auditLabel(entry: AdminOperatorAuditEntry) {
  if (entry.action === "operator.created") {
    const role = entry.details.role === "admin" ? "Admin" : "Moderator";
    return `Created ${role} operator @${entry.targetUsername}`;
  }
  if (entry.action === "operator.role_changed") {
    const role = entry.details.to === "admin" ? "Admin" : "Moderator";
    return `Changed @${entry.targetUsername} to ${role}`;
  }
  if (entry.action === "operator.disabled") return `Disabled @${entry.targetUsername}`;
  if (entry.action === "operator.enabled") return `Enabled @${entry.targetUsername}`;
  if (entry.action === "operator.password_changed") return `Reset password for @${entry.targetUsername}`;
  return entry.action;
}

async function loadAudit() {
  refreshAuditButton.disabled = true;
  try {
    const result = await api.adminOperatorAudit();
    auditList.replaceChildren();
    if (result.logs.length === 0) {
      auditList.append(el("p", "muted", "No operator changes recorded yet."));
      return;
    }
    for (const entry of result.logs) {
      const row = el("div", "instance-admin-audit-row");
      const copy = el("div");
      copy.append(el("strong", undefined, auditLabel(entry)));
      copy.append(el("span", undefined, `By @${entry.actorUsername}`));
      const time = el("time", undefined, dateLabel(entry.createdAt));
      time.dateTime = entry.createdAt;
      row.append(copy, time);
      auditList.append(row);
    }
  } catch (error) {
    auditList.replaceChildren(el("p", "muted", "Unable to load operator history."));
    setStatus(error instanceof Error ? error.message : "Unable to load operator history.", true);
  } finally {
    refreshAuditButton.disabled = false;
  }
}

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (roleInput.value === "admin" && !window.confirm(`Create @${usernameInput.value.trim()} as an Admin? Admins can access platform controls and manage host operators.`)) return;
  createButton.disabled = true;
  try {
    const result = await api.createAdminOperator(usernameInput.value, passwordInput.value, roleInput.value as AdminOperator["role"]);
    setStatus(`Created ${result.operator.role} operator @${result.operator.username}. Share the initial password securely.`);
    createForm.reset();
    roleInput.value = "moderator";
    await Promise.all([loadOperators(), loadAudit()]);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to create the operator.", true);
  } finally {
    passwordInput.value = "";
    createButton.disabled = false;
  }
});

refreshButton.addEventListener("click", () => void loadOperators());
refreshAuditButton.addEventListener("click", () => void loadAudit());
logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    await api.adminLogout();
    window.location.assign("/instance-admin");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to sign out.", true);
    logoutButton.disabled = false;
  }
});

initializeAdminTheme();
renderIcons(document);
void initializeAdminDashboard(api).then((operator) => {
  currentOperatorId = operator.id;
  return Promise.all([loadOperators(), loadAudit()]);
}).catch((error) => setStatus(error instanceof Error ? error.message : "Unable to load operator management.", true));
