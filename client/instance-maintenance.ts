import { ApiClient, ApiError, type StorageMaintenanceActionResult, type StorageMaintenancePreview, type StorageMaintenanceSummary } from "./api";
import { renderIcons } from "./icons";
import { initializeAdminTheme } from "./instance-admin-theme";
import { initializeAdminDashboard } from "./instance-admin-dashboard";

const api = new ApiClient();
const logoutButton = document.getElementById("admin-logout-maintenance") as HTMLButtonElement;
const inspectButton = document.getElementById("inspect-maintenance-storage") as HTMLButtonElement;
const candidateSummary = document.getElementById("maintenance-candidate-summary") as HTMLElement;
const scanStatus = document.getElementById("maintenance-scan-status") as HTMLElement;
const quarantineButton = document.getElementById("quarantine-orphaned-files") as HTMLButtonElement;
const refreshSummaryButton = document.getElementById("refresh-maintenance-summary") as HTMLButtonElement;
const quarantineSummary = document.getElementById("maintenance-quarantine-summary") as HTMLElement;
const restoreButton = document.getElementById("restore-quarantined-files") as HTMLButtonElement;
const purgeButton = document.getElementById("purge-expired-files") as HTMLButtonElement;
const actionStatus = document.getElementById("maintenance-action-status") as HTMLElement;
const summaryStatus = document.getElementById("maintenance-summary-status") as HTMLElement;
const recoveryWarning = document.getElementById("maintenance-recovery-warning") as HTMLElement;
const confirmation = document.getElementById("maintenance-confirmation") as HTMLDialogElement;
const confirmationTitle = document.getElementById("maintenance-confirmation-title") as HTMLElement;
const confirmationMessage = document.getElementById("maintenance-confirmation-message") as HTMLElement;
const confirmationPhraseRow = document.getElementById("maintenance-confirmation-phrase-row") as HTMLElement;
const confirmationPhrase = document.getElementById("maintenance-confirmation-phrase") as HTMLInputElement;
const confirmButton = document.getElementById("confirm-maintenance-action") as HTMLButtonElement;
const workflowSteps = {
  scan: document.getElementById("maintenance-step-scan") as HTMLElement,
  quarantine: document.getElementById("maintenance-step-quarantine") as HTMLElement,
  recovery: document.getElementById("maintenance-step-recovery") as HTMLElement,
  purge: document.getElementById("maintenance-step-purge") as HTMLElement,
};

const blockerLabels: Record<string, string> = {
  storage_directories_overlap: "The configured storage directories overlap. Fix the storage configuration before maintenance.",
  references_unavailable: "Database references are unavailable. No cleanup action is allowed.",
  reference_limit_reached: "The reference safety limit was reached. The scan is incomplete, so no cleanup action is allowed.",
  scan_incomplete: "The filesystem scan was incomplete. Resolve scan warnings before cleanup.",
  maintenance_scan_incomplete: "The fresh safety scan is incomplete. Nothing was moved.",
  storage_directory_unavailable: "A configured storage directory is unavailable. No files were changed.",
  quarantine_unavailable: "A safe same-filesystem quarantine directory could not be opened. No files were changed.",
  invalid_quarantine_record: "A maintenance record failed validation and was blocked.",
};

let preview: StorageMaintenancePreview | null = null;
let summary: StorageMaintenanceSummary | null = null;
let actionInProgress = false;
let summaryAvailable = false;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "Unavailable";
  if (value < 1_000) return `${Math.round(value)} B`;
  const units = ["kB", "MB", "GB", "TB", "PB"];
  let scaled = value;
  let unit = "B";
  for (const candidate of units) {
    scaled /= 1_000;
    unit = candidate;
    if (scaled < 1_000 || candidate === units[units.length - 1]) break;
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)} ${unit}`;
}

function formatCount(value: number) {
  return Math.max(0, Math.trunc(value)).toLocaleString();
}

function formatDate(value: string | null) {
  if (!value) return "None scheduled";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function appendMetric(parent: HTMLElement, label: string, value: string, detail: string) {
  const card = node("article", "instance-ops-card");
  card.append(
    node("span", "instance-ops-card-label", label),
    node("strong", undefined, value),
    node("small", undefined, detail),
  );
  parent.append(card);
}

function setStatus(target: HTMLElement, message: string, state?: "error" | "success" | "loading") {
  target.textContent = message;
  if (state) target.dataset.state = state;
  else delete target.dataset.state;
}

function presentError(error: unknown, fallback: string) {
  if (error instanceof ApiError) return blockerLabels[error.code] ?? fallback;
  return fallback;
}

function updateWorkflow() {
  const stepStates: Array<[HTMLElement, "current" | "done" | "upcoming" | "blocked"]> = [
    [workflowSteps.scan, "upcoming"],
    [workflowSteps.quarantine, "upcoming"],
    [workflowSteps.recovery, "upcoming"],
    [workflowSteps.purge, "upcoming"],
  ];
  if (!summaryAvailable) {
    stepStates[0] = [workflowSteps.scan, "blocked"];
  } else if (summary?.purgeableFileCount) {
    stepStates[0] = [workflowSteps.scan, "done"];
    stepStates[1] = [workflowSteps.quarantine, "done"];
    stepStates[2] = [workflowSteps.recovery, "done"];
    stepStates[3] = [workflowSteps.purge, "current"];
  } else if (summary?.quarantinedFileCount) {
    stepStates[0] = [workflowSteps.scan, "done"];
    stepStates[1] = [workflowSteps.quarantine, "done"];
    stepStates[2] = [workflowSteps.recovery, "current"];
  } else if (summary?.recoveryRequiredFileCount) {
    stepStates[0] = [workflowSteps.scan, "done"];
    stepStates[1] = [workflowSteps.quarantine, "done"];
    stepStates[2] = [workflowSteps.recovery, "blocked"];
  } else if (summary?.transitioningFileCount) {
    stepStates[0] = [workflowSteps.scan, "done"];
    stepStates[1] = [workflowSteps.quarantine, "done"];
    stepStates[2] = [workflowSteps.recovery, "current"];
  } else if (preview?.complete && preview.candidateFileCount > 0) {
    stepStates[0] = [workflowSteps.scan, "done"];
    stepStates[1] = [workflowSteps.quarantine, "current"];
  } else if (preview?.complete) {
    stepStates[0] = [workflowSteps.scan, "done"];
    stepStates[1] = [workflowSteps.quarantine, "done"];
  } else if (preview && !preview.complete) {
    stepStates[0] = [workflowSteps.scan, "blocked"];
  } else {
    stepStates[0] = [workflowSteps.scan, "current"];
  }
  for (const [element, state] of stepStates) {
    element.dataset.state = state;
    if (state === "current") element.setAttribute("aria-current", "step");
    else element.removeAttribute("aria-current");
    const label = element.querySelector("strong")?.textContent ?? "Maintenance step";
    element.setAttribute("aria-label", `${label}: ${state}`);
  }
}

function updateActionAvailability() {
  quarantineButton.disabled = actionInProgress || !summaryAvailable || !preview?.complete || preview.candidateFileCount === 0;
  restoreButton.disabled = actionInProgress || !summaryAvailable || !summary?.quarantinedFileCount;
  purgeButton.disabled = actionInProgress || !summaryAvailable || !summary?.purgeableFileCount;
  refreshSummaryButton.disabled = actionInProgress;
}

function renderPreview(value: StorageMaintenancePreview) {
  preview = value;
  candidateSummary.replaceChildren();
  candidateSummary.hidden = false;
  appendMetric(candidateSummary, "Eligible files", formatCount(value.candidateFileCount), `Older than ${value.minimumFileAgeHours} hours with no database reference`);
  appendMetric(candidateSummary, "Eligible storage", formatBytes(value.candidateBytes), `Estimated from the complete scan · ${new Date(value.scannedAt).toLocaleString()}`);
  appendMetric(candidateSummary, "Per-action limit", formatCount(value.actionLimit), `Up to ${formatCount(Math.min(value.actionLimit, value.candidateFileCount))} files per confirmed action`);
  quarantineButton.hidden = !value.complete || value.candidateFileCount === 0;
  quarantineButton.textContent = `Quarantine up to ${formatCount(Math.min(value.actionLimit, value.candidateFileCount))} files`;

  if (value.complete) {
    setStatus(scanStatus, value.candidateFileCount === 0
      ? "The scan is complete. No eligible orphaned files were found."
      : "The scan is complete. Review the aggregate estimate before choosing whether to quarantine.", "success");
  } else {
    const blockers = value.blockers.map((reason) => blockerLabels[reason] ?? "The scan reported a safety warning.");
    setStatus(scanStatus, blockers.length > 0 ? [...new Set(blockers)].join(" ") : "The scan was incomplete; cleanup is blocked.", "error");
  }
  updateWorkflow();
  updateActionAvailability();
}

function renderSummary(value: StorageMaintenanceSummary) {
  summary = value;
  quarantineSummary.replaceChildren();
  appendMetric(quarantineSummary, "In recovery quarantine", formatCount(value.quarantinedFileCount), `${formatBytes(value.quarantinedBytes)} retained · ${value.retentionDays}-day window`);
  appendMetric(quarantineSummary, "Eligible for permanent purge", formatCount(value.purgeableFileCount), `${formatBytes(value.purgeableBytes)} · manual action only`);
  appendMetric(quarantineSummary, value.purgeableFileCount > 0 ? "Oldest expired" : "Next expiry", formatDate(value.nextPurgeAt), "Quarantined files remain restorable until purged");
  appendMetric(quarantineSummary, "In progress", formatCount(value.transitioningFileCount), "Transitions older than one hour reconcile on refresh");
  appendMetric(quarantineSummary, "Needs recovery review", formatCount(value.recoveryRequiredFileCount), "No automated changes will be made to these files");
  updateWorkflow();
  updateActionAvailability();

  if (value.recoveryRequiredFileCount > 0) {
    recoveryWarning.hidden = false;
    recoveryWarning.textContent = `${formatCount(value.recoveryRequiredFileCount)} quarantine entries need manual recovery review. No files in this state can be restored or purged automatically.`;
  } else {
    recoveryWarning.hidden = true;
    recoveryWarning.textContent = "";
  }
  summaryStatus.setAttribute("aria-busy", "false");
}

async function loadSummary() {
  refreshSummaryButton.disabled = true;
  summaryStatus.setAttribute("aria-busy", "true");
  try {
    const value = await api.storageMaintenanceSummary();
    summaryAvailable = true;
    renderSummary(value);
    setStatus(summaryStatus, "Quarantine status is current. No background purge runs automatically.", "success");
  } catch {
    summary = null;
    summaryAvailable = false;
    quarantineSummary.replaceChildren();
    recoveryWarning.hidden = true;
    setStatus(summaryStatus, "Quarantine status is unavailable. The storage-maintenance migration may not be applied. Run bun run db:migrate on this installation, then refresh; maintenance actions stay disabled until the state can be verified.", "error");
    updateWorkflow();
    updateActionAvailability();
  } finally {
    summaryStatus.setAttribute("aria-busy", "false");
    refreshSummaryButton.disabled = actionInProgress;
  }
}

async function inspectStorage() {
  inspectButton.disabled = true;
  quarantineButton.hidden = true;
  preview = null;
  updateWorkflow();
  setStatus(scanStatus, "Scanning both storage roots and checking database references…", "loading");
  try {
    renderPreview(await api.inspectStorageMaintenance());
  } catch (error) {
    preview = null;
    candidateSummary.hidden = true;
    quarantineButton.hidden = true;
    setStatus(scanStatus, presentError(error, "Unable to inspect storage. No files were changed."), "error");
    updateWorkflow();
    updateActionAvailability();
  } finally {
    inspectButton.disabled = false;
  }
}

function confirmAction(title: string, message: string, requirePurgePhrase = false) {
  confirmationTitle.textContent = title;
  confirmationMessage.textContent = message;
  confirmationPhrase.value = "";
  confirmationPhraseRow.hidden = !requirePurgePhrase;
  confirmButton.disabled = requirePurgePhrase;
  const updatePhrase = () => {
    confirmButton.disabled = requirePurgePhrase && confirmationPhrase.value !== "PURGE";
  };
  confirmationPhrase.addEventListener("input", updatePhrase);
  confirmation.addEventListener("close", () => {
    confirmationPhrase.removeEventListener("input", updatePhrase);
  }, { once: true });
  confirmation.showModal();
  return new Promise<boolean>((resolve) => {
    confirmation.addEventListener("close", () => resolve(confirmation.returnValue === "confirm"), { once: true });
  });
}

async function runAction<T extends StorageMaintenanceActionResult>(
  action: () => Promise<T>,
  describe: (result: T) => string,
) {
  actionInProgress = true;
  preview = null;
  candidateSummary.hidden = true;
  quarantineButton.hidden = true;
  inspectButton.disabled = true;
  quarantineButton.disabled = true;
  refreshSummaryButton.disabled = true;
  restoreButton.disabled = true;
  purgeButton.disabled = true;
  setStatus(actionStatus, "Applying the confirmed maintenance action…", "loading");
  try {
    const result = await action();
    setStatus(actionStatus, describe(result), "success");
    preview = null;
    await loadSummary();
  } catch (error) {
    setStatus(actionStatus, presentError(error, "The maintenance action did not finish. Refresh status before trying again."), "error");
    await loadSummary();
  } finally {
    actionInProgress = false;
    inspectButton.disabled = false;
    updateActionAvailability();
  }
}

inspectButton.addEventListener("click", () => void inspectStorage());
refreshSummaryButton.addEventListener("click", () => void loadSummary());
quarantineButton.addEventListener("click", async () => {
  if (!summaryAvailable || !preview?.complete || preview.candidateFileCount === 0) return;
  const count = Math.min(preview.actionLimit, preview.candidateFileCount);
  const confirmed = await confirmAction(
    "Quarantine eligible files?",
    `A new complete scan will run and each file will be rechecked for current references. At most ${formatCount(count)} file(s) will be moved. They will remain recoverable for ${preview.retentionDays} days; nothing will be permanently deleted.`,
  );
  if (!confirmed) return;
  await runAction(
    () => api.quarantineOrphanedStorage(),
    (result) => `${formatCount(result.quarantinedFileCount ?? 0)} file(s) quarantined (${formatBytes(result.quarantinedBytes ?? 0)}). ${formatCount(result.skippedReferencedCount ?? 0)} newly referenced, ${formatCount(result.skippedChangedCount ?? 0)} changed, ${formatCount(result.skippedManagedCount ?? 0)} already-managed, and ${formatCount(result.failedCount ?? 0)} failed file(s) were skipped.${result.remainingCandidateCount ? ` ${formatCount(result.remainingCandidateCount)} more eligible file(s) remain for another reviewed batch.` : ""}`,
  );
  candidateSummary.hidden = true;
  quarantineButton.hidden = true;
});
restoreButton.addEventListener("click", async () => {
  const count = summary?.quarantinedFileCount ?? 0;
  if (count === 0) return;
  const confirmed = await confirmAction(
    "Restore quarantined files?",
    `Restore up to ${formatCount(Math.min(summary?.actionLimit ?? 0, count))} quarantined file(s) to their original storage locations. Existing files will never be overwritten.`,
  );
  if (!confirmed) return;
  await runAction(
    () => api.restoreQuarantinedStorage(),
    (result) => `${formatCount(result.restoredFileCount ?? 0)} file(s) restored (${formatBytes(result.restoredBytes ?? 0)}). ${formatCount(result.skippedCount ?? 0)} file(s) were skipped because their state changed or needs review.`,
  );
});
purgeButton.addEventListener("click", async () => {
  const count = summary?.purgeableFileCount ?? 0;
  if (count === 0) return;
  const confirmed = await confirmAction(
    "Permanently purge expired files?",
    `This irreversibly deletes up to ${formatCount(Math.min(summary?.actionLimit ?? 0, count))} quarantined file(s) (${formatBytes(summary?.purgeableBytes ?? 0)} eligible in total). Only files whose 30-day recovery period has expired can be purged.`,
    true,
  );
  if (!confirmed) return;
  await runAction(
    () => api.purgeExpiredQuarantinedStorage(),
    (result) => `${formatCount(result.purgedFileCount ?? 0)} expired file(s) permanently deleted (${formatBytes(result.purgedBytes ?? 0)}). ${formatCount(result.skippedCount ?? 0)} file(s) were skipped.${result.remainingEligibleCount ? ` ${formatCount(result.remainingEligibleCount)} eligible file(s) remain for another reviewed batch.` : ""}`,
  );
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
updateWorkflow();
void loadSummary();
