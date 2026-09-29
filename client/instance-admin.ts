import { ApiClient, ApiError, type InstanceReport, type InstanceReportSummary } from "./api";
import {
  createEncryptedPrivateKeyBackup,
  decryptReportEvidence,
  generateReportKeyPair,
  importEncryptedPrivateKeyBackup,
  makeReportPrivateKeyNonExtractable,
} from "./report-evidence";
import { renderIcons } from "./icons";

const api = new ApiClient();
const status = document.getElementById("instance-admin-status") as HTMLElement;
const statusFilter = document.getElementById("report-status-filter") as HTMLSelectElement;
const reportList = document.getElementById("instance-report-list") as HTMLElement;
const refreshReportsButton = document.getElementById("refresh-reports") as HTMLButtonElement;
const emptyDetail = document.getElementById("instance-report-empty") as HTMLElement;
const detail = document.getElementById("instance-report-detail") as HTMLElement;
const detailTitle = document.getElementById("report-detail-title") as HTMLElement;
const detailStatus = document.getElementById("report-detail-status") as HTMLElement;
const metadata = document.getElementById("report-detail-metadata") as HTMLElement;
const evidenceSection = document.getElementById("report-evidence-section") as HTMLElement;
const decryptEvidenceButton = document.getElementById("decrypt-report-evidence") as HTMLButtonElement;
const evidencePlaintext = document.getElementById("report-evidence-plaintext") as HTMLElement;
const markReviewingButton = document.getElementById("mark-report-reviewing") as HTMLButtonElement;
const removeMessageButton = document.getElementById("remove-reported-message") as HTMLButtonElement;
const suspendUserButton = document.getElementById("suspend-reported-user") as HTMLButtonElement;
const restoreUserButton = document.getElementById("restore-reported-user") as HTMLButtonElement;
const resolveReportButton = document.getElementById("resolve-report") as HTMLButtonElement;
const dismissReportButton = document.getElementById("dismiss-report") as HTMLButtonElement;
const createKeyButton = document.getElementById("create-report-key") as HTMLButtonElement;
const newKeyPassphrase = document.getElementById("new-report-key-passphrase") as HTMLInputElement;
const confirmKeyPassphrase = document.getElementById("confirm-report-key-passphrase") as HTMLInputElement;
const backupFile = document.getElementById("report-key-backup-file") as HTMLInputElement;
const importKeyPassphrase = document.getElementById("import-report-key-passphrase") as HTMLInputElement;
const importKeyButton = document.getElementById("import-report-key") as HTMLButtonElement;
const keyList = document.getElementById("report-key-list") as HTMLElement;
const auditList = document.getElementById("instance-admin-audit") as HTMLElement;
const refreshAuditButton = document.getElementById("refresh-admin-audit") as HTMLButtonElement;
const logoutButton = document.getElementById("admin-logout") as HTMLButtonElement;

const unlockedKeys = new Map<string, CryptoKey>();
let reports: InstanceReportSummary[] = [];
let selectedReport: InstanceReport | undefined;
let detailRequest = 0;

const reasonLabels: Record<InstanceReportSummary["reason"], string> = {
  spam: "Spam or scams",
  harassment: "Harassment or bullying",
  threats: "Threats or violence",
  sexual_content: "Sexual content",
  illegal_content: "Illegal content",
  impersonation: "Impersonation",
  other: "Other concern",
};

function setStatus(message: string, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function setEmptyDetail() {
  selectedReport = undefined;
  detail.hidden = true;
  emptyDetail.hidden = false;
}

function addMetadata(label: string, value: string) {
  const item = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value;
  item.append(term, description);
  metadata.append(item);
}

function userLabel(displayName: string | null, username: string | null, userId: string | null) {
  if (displayName || username) return `${displayName ?? username}${username ? ` (@${username})` : ""}`;
  return userId ? `Deleted account · ${userId}` : "Unavailable";
}

function readableDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function renderReportList() {
  reportList.replaceChildren();
  if (reports.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No reports in this queue.";
    reportList.append(empty);
    return;
  }
  for (const report of reports) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "instance-report-item";
    button.setAttribute("aria-current", String(report.id === selectedReport?.id));
    const line = document.createElement("span");
    line.className = "instance-report-reason";
    const reason = document.createElement("strong");
    reason.textContent = reasonLabels[report.reason] ?? "Other concern";
    const state = document.createElement("span");
    state.className = "instance-report-status";
    state.textContent = report.status;
    line.append(reason, state);
    const target = document.createElement("span");
    target.textContent = `Reported: ${userLabel(report.targetDisplayName, report.targetUsername, report.targetUserId)}`;
    const reporter = document.createElement("span");
    reporter.textContent = `By: ${userLabel(report.reporterDisplayName, report.reporterUsername, report.reporterUserId)}`;
    const date = document.createElement("time");
    date.dateTime = report.createdAt;
    date.textContent = readableDate(report.createdAt);
    button.append(line, target, reporter, date);
    if (report.hasEvidence) {
      const evidence = document.createElement("span");
      evidence.textContent = "Encrypted evidence attached";
      button.append(evidence);
    }
    button.addEventListener("click", () => void openReport(report.id));
    reportList.append(button);
  }
}

async function loadReports(keepSelection = true) {
  refreshReportsButton.disabled = true;
  try {
    const previousId = keepSelection ? selectedReport?.id : undefined;
    const result = await api.instanceReports(statusFilter.value as "all" | "open" | "reviewing" | "resolved" | "dismissed");
    reports = result.reports;
    renderReportList();
    if (previousId && reports.some((report) => report.id === previousId)) {
      await openReport(previousId);
    } else if (!previousId) {
      setEmptyDetail();
    } else {
      setEmptyDetail();
    }
  } catch (error) {
    reportList.replaceChildren();
    const errorMessage = document.createElement("p");
    errorMessage.className = "muted";
     errorMessage.textContent = "Unable to load reports. Sign in with a host operator identity.";
    reportList.append(errorMessage);
    setStatus(error instanceof Error ? error.message : "Unable to load reports.", true);
  } finally {
    refreshReportsButton.disabled = false;
  }
}

async function openReport(reportId: string) {
  const request = ++detailRequest;
  const summary = reports.find((report) => report.id === reportId);
  if (!summary) return;
  selectedReport = undefined;
  for (const button of [
    markReviewingButton, removeMessageButton, suspendUserButton, restoreUserButton,
    resolveReportButton, dismissReportButton, decryptEvidenceButton,
  ]) button.disabled = true;
  renderReportList();
  emptyDetail.hidden = true;
  detail.hidden = false;
  detailTitle.textContent = "Loading report…";
  metadata.replaceChildren();
  evidenceSection.hidden = true;
  evidencePlaintext.hidden = true;
  evidencePlaintext.textContent = "";
  try {
    const result = await api.instanceReport(reportId);
    if (request !== detailRequest) return;
    selectedReport = result.report;
    detailTitle.textContent = `Report ${result.report.id.slice(0, 8)}`;
    detailStatus.textContent = result.report.status;
    metadata.replaceChildren();
    addMetadata("Reported account", userLabel(result.report.targetDisplayName, result.report.targetUsername, result.report.targetUserId));
    addMetadata("Reporter", userLabel(result.report.reporterDisplayName, result.report.reporterUsername, result.report.reporterUserId));
    addMetadata("Reason", reasonLabels[result.report.reason]);
    addMetadata("Submitted", readableDate(result.report.createdAt));
    addMetadata("Conversation", result.report.conversationId ?? "Not supplied");
    addMetadata("Message reference", result.report.messageId ?? "Not supplied");
    addMetadata("Review status", result.report.status);
    addMetadata("Reviewed", result.report.reviewedAt ? readableDate(result.report.reviewedAt) : "Not reviewed");
    evidenceSection.hidden = !result.report.evidence;
    decryptEvidenceButton.disabled = !result.report.evidence || !unlockedKeys.has(result.report.evidence.keyId);
    decryptEvidenceButton.textContent = result.report.evidence && !unlockedKeys.has(result.report.evidence.keyId)
      ? `Matching key ${result.report.evidence.keyId.slice(0, 8)} not unlocked`
      : "Decrypt in this browser";
    removeMessageButton.hidden = !result.report.messageId || !result.report.conversationId;
    suspendUserButton.hidden = !result.report.targetUserId || summary.suspended;
    restoreUserButton.hidden = !result.report.targetUserId || !summary.suspended;
    markReviewingButton.hidden = result.report.status !== "open";
    resolveReportButton.hidden = result.report.status === "resolved";
    dismissReportButton.hidden = result.report.status === "dismissed";
    for (const button of [
      markReviewingButton, removeMessageButton, suspendUserButton, restoreUserButton,
      resolveReportButton, dismissReportButton,
    ]) button.disabled = false;
    decryptEvidenceButton.disabled = !result.report.evidence || !unlockedKeys.has(result.report.evidence.keyId);
    setStatus("");
  } catch (error) {
    if (request !== detailRequest) return;
    detailTitle.textContent = "Unable to load report";
    setStatus(error instanceof Error ? error.message : "Unable to load this report.", true);
  }
}

async function updateReportStatus(nextStatus: InstanceReport["status"]) {
  if (!selectedReport) return;
  const reportId = selectedReport.id;
  try {
    await api.updateInstanceReport(reportId, nextStatus);
    setStatus(`Report marked ${nextStatus}.`);
    await loadReports();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to update the report.", true);
  }
}

async function refreshSelectedReport() {
  if (!selectedReport) return;
  await openReport(selectedReport.id);
}

function downloadBackup(contents: string, keyId: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `naigi-report-key-${keyId}.naigi-report-key`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function createReportKey() {
  const passphrase = newKeyPassphrase.value;
  if (passphrase.length < 12) {
    setStatus("Choose a key-backup passphrase of at least 12 characters.", true);
    newKeyPassphrase.focus();
    return;
  }
  if (passphrase !== confirmKeyPassphrase.value) {
    setStatus("The key-backup passphrases do not match.", true);
    confirmKeyPassphrase.focus();
    return;
  }
  createKeyButton.disabled = true;
  setStatus("Generating an RSA-3072 evidence key in this browser…");
  try {
    const keyId = crypto.randomUUID();
    const { publicKey, privateKey } = await generateReportKeyPair();
    const backup = await createEncryptedPrivateKeyBackup(keyId, privateKey, passphrase);
    const workingKey = await makeReportPrivateKeyNonExtractable(privateKey);
    // Start the encrypted backup download before activating the public key so
    // the server cannot begin receiving evidence for a key the operator lost.
    downloadBackup(backup, keyId);
    const created = await api.createInstanceReportKey(keyId, publicKey);
    unlockedKeys.set(created.key.id, workingKey);
    newKeyPassphrase.value = "";
    confirmKeyPassphrase.value = "";
    await Promise.all([loadReportKeys(), refreshSelectedReport()]);
    setStatus("Evidence key activated. Store the downloaded backup and its passphrase separately.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to create the evidence key.", true);
  } finally {
    createKeyButton.disabled = false;
  }
}

async function importReportKey() {
  const file = backupFile.files?.[0];
  if (!file) {
    setStatus("Choose an encrypted report-key backup file first.", true);
    backupFile.focus();
    return;
  }
  if (file.size > 100_000) {
    setStatus("The selected backup file is too large.", true);
    return;
  }
  if (!importKeyPassphrase.value) {
    setStatus("Enter the backup passphrase.", true);
    importKeyPassphrase.focus();
    return;
  }
  importKeyButton.disabled = true;
  setStatus("Unlocking the evidence key locally…");
  try {
    const imported = await importEncryptedPrivateKeyBackup(await file.text(), importKeyPassphrase.value);
    const knownKey = (await api.instanceReportKeys()).keys.some((key) => key.id === imported.keyId);
    if (!knownKey) throw new Error("This key ID is not registered on this Naigi instance.");
    unlockedKeys.set(imported.keyId, imported.privateKey);
    importKeyPassphrase.value = "";
    await Promise.all([loadReportKeys(), refreshSelectedReport()]);
    setStatus(`Evidence key ${imported.keyId.slice(0, 8)} unlocked in memory for this page.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to unlock this key backup.", true);
  } finally {
    importKeyButton.disabled = false;
  }
}

async function decryptEvidence() {
  const report = selectedReport;
  if (!report?.evidence) return;
  const privateKey = unlockedKeys.get(report.evidence.keyId);
  if (!privateKey) {
    setStatus("Unlock the matching encrypted key backup in this browser first.", true);
    return;
  }
  decryptEvidenceButton.disabled = true;
  try {
    const plaintext = await decryptReportEvidence(report.evidence, privateKey);
    await api.auditReportEvidence(report.id);
    evidencePlaintext.textContent = JSON.stringify(plaintext, null, 2);
    evidencePlaintext.hidden = false;
    setStatus("Evidence decrypted locally. The server received only the encrypted envelope.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to decrypt this evidence.", true);
  } finally {
    decryptEvidenceButton.disabled = false;
  }
}

async function removeReportedMessage() {
  if (!selectedReport?.messageId) return;
  if (!window.confirm("Remove this encrypted message from server history for every participant? This cannot be undone.")) return;
  removeMessageButton.disabled = true;
  try {
    await api.removeReportedMessage(selectedReport.id);
    removeMessageButton.hidden = true;
    setStatus("Reported message removed from server history.");
    await refreshSelectedReport();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to remove this message.", true);
  } finally {
    removeMessageButton.disabled = false;
  }
}

async function suspendReportedUser() {
  if (!selectedReport?.targetUserId) return;
  if (!window.confirm("Suspend this account from the instance? This revokes its sessions and prevents future sign-in.")) return;
  suspendUserButton.disabled = true;
  try {
    await api.suspendInstanceUser(selectedReport.targetUserId, selectedReport.id);
    setStatus("Account suspended and report resolved.");
    await loadReports();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to suspend this account.", true);
  } finally {
    suspendUserButton.disabled = false;
  }
}

async function restoreReportedUser() {
  if (!selectedReport?.targetUserId) return;
  if (!window.confirm("Restore this account so it can sign in again?")) return;
  restoreUserButton.disabled = true;
  try {
    await api.restoreInstanceUser(selectedReport.targetUserId);
    setStatus("Account suspension removed.");
    await loadReports();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to restore this account.", true);
  } finally {
    restoreUserButton.disabled = false;
  }
}

async function loadReportKeys() {
  const result = await api.instanceReportKeys();
  keyList.replaceChildren();
  if (result.keys.length === 0) {
    const empty = document.createElement("span");
    empty.className = "muted small";
    empty.textContent = "No evidence keys configured.";
    keyList.append(empty);
  }
  for (const key of result.keys) {
    const badge = document.createElement("span");
    badge.className = "instance-report-key-badge";
    const activeLabel = key.active ? " · active" : " · retired";
    const unlockedLabel = unlockedKeys.has(key.id) ? " · unlocked here" : "";
    badge.textContent = `${key.id}${activeLabel}${unlockedLabel} · ${readableDate(key.createdAt)}`;
    keyList.append(badge);
  }
}

async function loadAudit() {
  refreshAuditButton.disabled = true;
  try {
    const result = await api.instanceAdminAudit();
    auditList.replaceChildren();
    if (result.logs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No admin actions recorded yet.";
      auditList.append(empty);
      return;
    }
    for (const log of result.logs) {
      const row = document.createElement("div");
      row.className = "instance-admin-audit-row";
      const description = document.createElement("div");
      const action = document.createElement("strong");
      action.textContent = log.action;
      const actor = document.createElement("span");
      actor.textContent = log.adminDisplayName === log.adminUsername
        ? `@${log.adminUsername}`
        : `${log.adminDisplayName} (@${log.adminUsername})`;
      const target = document.createElement("span");
      target.textContent = log.reportId
        ? ` · report ${log.reportId.slice(0, 8)}${log.targetUserId ? ` · user ${log.targetUserId.slice(0, 8)}` : ""}`
        : log.targetUserId ? ` · user ${log.targetUserId.slice(0, 8)}` : "";
      description.append(action, actor, target);
      const time = document.createElement("time");
      time.dateTime = log.createdAt;
      time.textContent = readableDate(log.createdAt);
      row.append(description, time);
      auditList.append(row);
    }
  } catch (error) {
    auditList.replaceChildren();
    const failure = document.createElement("p");
    failure.className = "muted";
    failure.textContent = "Unable to load the admin audit log.";
    auditList.append(failure);
    setStatus(error instanceof Error ? error.message : "Unable to load audit records.", true);
  } finally {
    refreshAuditButton.disabled = false;
  }
}

statusFilter.addEventListener("change", () => void loadReports(false));
refreshReportsButton.addEventListener("click", () => void loadReports());
markReviewingButton.addEventListener("click", () => void updateReportStatus("reviewing"));
resolveReportButton.addEventListener("click", () => void updateReportStatus("resolved"));
dismissReportButton.addEventListener("click", () => void updateReportStatus("dismissed"));
removeMessageButton.addEventListener("click", () => void removeReportedMessage());
suspendUserButton.addEventListener("click", () => void suspendReportedUser());
restoreUserButton.addEventListener("click", () => void restoreReportedUser());
decryptEvidenceButton.addEventListener("click", () => void decryptEvidence());
createKeyButton.addEventListener("click", () => void createReportKey());
importKeyButton.addEventListener("click", () => void importReportKey());
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

renderIcons(document);
void Promise.all([loadReports(false), loadReportKeys(), loadAudit()]).catch((error) => {
  setStatus(error instanceof Error ? error.message : "Unable to load the instance admin console.", true);
});
