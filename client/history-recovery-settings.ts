import QRCode from "qrcode";
import { ApiClient } from "./api";
import type { CryptoClient } from "./crypto";
import { pairingLink, parsePairingLink, pairingVerificationCode, randomRecoverySecret, recoveryKeyText, type DevicePairing } from "./history-recovery-crypto";

// Consume the fragment before loading profile/network data; never retain pairing secrets in the URL.
let incomingApproval = "";
if (window.location.hash.startsWith("#approve-device=")) {
  incomingApproval = window.location.href;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#recovery`);
}

export function setupHistoryRecovery(api: ApiClient, unlock: () => Promise<CryptoClient>) {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const status = byId<HTMLElement>("history-recovery-status");
  const backupStatus = byId<HTMLElement>("history-backup-status");
  const keyField = byId<HTMLInputElement>("history-generated-key");
  const saved = byId<HTMLInputElement>("history-key-saved");
  const generated = byId<HTMLElement>("history-generated-key-panel");
  const activate = byId<HTMLButtonElement>("history-enable-backup");
  const restoreKey = byId<HTMLInputElement>("history-restore-key");
  const linkField = byId<HTMLTextAreaElement>("history-pairing-link");
  const pairingPanel = byId<HTMLElement>("history-pairing-panel");
  const canvas = byId<HTMLCanvasElement>("history-pairing-qr");
  const code = byId<HTMLElement>("history-pairing-code");
  const approveLink = byId<HTMLInputElement>("history-approval-link");
  const approvalPanel = byId<HTMLElement>("history-approval-panel");
  const approveCode = byId<HTMLElement>("history-approval-code");
  const confirmDevice = byId<HTMLInputElement>("history-device-confirm");
  const approve = byId<HTMLButtonElement>("history-approve-device");
  let pairing: (DevicePairing & { expiresAt: string }) | undefined;
  let approval: DevicePairing | undefined;
  let timer: number | undefined;
  let polling = false;
  let generation = 0;
  const report = (error: unknown) => { status.textContent = error instanceof Error ? error.message : "History recovery failed."; };
  const busy = (id: string, work: () => Promise<void>) => {
    const button = byId<HTMLButtonElement>(id);
    button.addEventListener("click", () => {
      button.disabled = true;
      status.textContent = "Working…";
      void work().catch(report).finally(() => { button.disabled = false; });
    });
  };
  const refresh = async () => {
    const { backup } = await api.historyRecoveryStatus();
    backupStatus.textContent = backup ? `Encrypted server backup last updated ${new Date(backup.updatedAt).toLocaleString()}.`
      : "No automatic backup exists yet. Enable one on a device that can read your history.";
  };
  const clearPairing = () => {
    generation += 1;
    window.clearInterval(timer);
    pairing = undefined;
    pairingPanel.hidden = true;
    linkField.value = "";
    code.textContent = "";
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  };
  byId<HTMLButtonElement>("history-generate-key").addEventListener("click", () => {
    keyField.value = recoveryKeyText(randomRecoverySecret());
    generated.hidden = false;
    saved.checked = false;
    activate.disabled = true;
    status.textContent = "Save this key in your password manager. It is not your account password and cannot be recovered by Naigi.";
  });
  saved.addEventListener("change", () => { activate.disabled = !saved.checked; });
  activate.addEventListener("click", () => {
    if (!saved.checked || !keyField.value) return;
    activate.disabled = true;
    const key = keyField.value;
    status.textContent = "Encrypting your history backup…";
    void (async () => {
      await (await unlock()).enableHistoryBackup(key);
      keyField.value = "";
      generated.hidden = true;
      await refresh();
      status.textContent = "Automatic encrypted backup enabled. Keep your recovery key safe; it will not be shown again.";
    })().catch(report).finally(() => { activate.disabled = !saved.checked; });
  });
  busy("history-restore-backup", async () => {
    const key = restoreKey.value;
    if (!key) throw new Error("Enter your recovery key.");
    const imported = await (await unlock()).restoreHistoryBackup(key);
    restoreKey.value = "";
    await refresh();
    status.textContent = `Restored ${imported.imported} of ${imported.total} history keys. Reopen the conversation to read its history. Automatic backup is now enabled on this device.`;
  });
  busy("history-backup-now", async () => {
    const client = await unlock();
    if (!client.hasHistoryBackupKey) throw new Error("Restore your backup or approve this device first.");
    await client.backupHistoryNow();
    await refresh();
    status.textContent = client.historyBackupStatus;
  });
  busy("history-delete-backup", async () => {
    if (!window.confirm("Delete the encrypted server backup? Devices retain their local keys, but recovery with this backup will no longer work.")) { status.textContent = "Backup deletion cancelled."; return; }
    await (await unlock()).disableHistoryBackup();
    await refresh();
    status.textContent = "Encrypted server backup deleted. Local room keys were not removed.";
  });
  busy("history-request-device", async () => {
    if (pairing) await api.deleteHistoryTransfer(pairing.id).catch(() => undefined);
    clearPairing();
    const token = generation;
    const client = await unlock();
    const request = await client.requestHistoryDeviceTransfer();
    if (token !== generation) { await api.deleteHistoryTransfer(request.id).catch(() => undefined); return; }
    pairing = request;
    const link = pairingLink(window.location.origin, request);
    linkField.value = link;
    code.textContent = await pairingVerificationCode(request.secret);
    pairingPanel.hidden = false;
    await QRCode.toCanvas(canvas, link, { width: 200, margin: 1, errorCorrectionLevel: "M" });
    status.textContent = "On a device that can read your history, scan this QR or open this link. Sign in to the same account, unlock, and compare both verification codes before approving. Expires in 10 minutes.";
    timer = window.setInterval(() => {
      if (!pairing || polling) return;
      if (Date.parse(pairing.expiresAt) <= Date.now()) { clearPairing(); status.textContent = "Device approval expired. Request a new approval."; return; }
      const request = pairing;
      polling = true;
      void client.finishHistoryDeviceTransfer(request, () => generation === token).then((result) => {
        if (generation !== token || !result) return;
        clearPairing();
        status.textContent = `Device approved. Imported ${result.imported} of ${result.total} history keys. Reopen your conversation to read the restored history.`;
        void refresh().catch(() => undefined);
      }).catch((error) => {
        if (generation !== token) return;
        clearPairing();
        report(error);
      }).finally(() => { polling = false; });
    }, 2_000);
  });
  byId<HTMLButtonElement>("history-cancel-device").addEventListener("click", () => {
    const id = pairing?.id;
    clearPairing();
    if (id) void api.deleteHistoryTransfer(id).catch(() => undefined);
    status.textContent = "Device approval cancelled.";
  });
  busy("history-review-device", async () => {
    approval = undefined;
    approvalPanel.hidden = true;
    const candidate = parsePairingLink(approveLink.value, window.location.origin);
    const { transfer } = await api.historyTransfer(candidate.id);
    if (transfer.deviceId !== candidate.deviceId || Date.parse(transfer.expiresAt) <= Date.now()) throw new Error("This approval is expired or belongs to another account.");
    if ((await unlock()).deviceId === candidate.deviceId) throw new Error("Open this link on a different device that already has your history.");
    approval = candidate;
    approveCode.textContent = await pairingVerificationCode(candidate.secret);
    confirmDevice.checked = false;
    approve.disabled = true;
    approvalPanel.hidden = false;
    status.textContent = `Confirm the code matches the new device you control. Device ID: ${candidate.deviceId}. Do not approve a request sent by someone else.`;
  });
  confirmDevice.addEventListener("change", () => { approve.disabled = !confirmDevice.checked || !approval; });
  approve.addEventListener("click", () => {
    if (!approval || !confirmDevice.checked) return;
    const request = approval;
    approval = undefined;
    approve.disabled = true;
    status.textContent = "Encrypting history for the new device…";
    void (async () => {
      await (await unlock()).approveHistoryDeviceTransfer(request);
      approveLink.value = "";
      approvalPanel.hidden = true;
      status.textContent = "History transfer approved. The new device can now import the encrypted keys.";
    })().catch(report);
  });
  approveLink.addEventListener("input", () => { approval = undefined; approvalPanel.hidden = true; });
  if (incomingApproval) {
    approveLink.value = incomingApproval;
    incomingApproval = "";
    status.textContent = "Unlock this trusted browser, then review the device approval request and compare codes.";
  }
  window.addEventListener("pagehide", () => {
    clearPairing();
    approval = undefined;
    keyField.value = "";
    restoreKey.value = "";
    approveLink.value = "";
  });
  void refresh().catch(report);
}
