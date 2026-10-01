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
    status.textContent = imported.imported > 0
      ? `Backup processed: added ${imported.imported} new or earlier history keys from ${imported.total} supplied. Open chat to retry locked messages. Automatic backup is now enabled.`
      : `Backup processed, but none of its ${imported.total} keys added earlier history access. This browser already has the same or better keys. If messages remain locked, use a device or backup that can read those specific messages.`;
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
  busy("history-check-keys", async () => {
    const output = byId<HTMLElement>("history-diagnostics-result");
    output.textContent = "Checking…";
    try {
      const url = new URL(byId<HTMLInputElement>("history-diagnostics-link").value, window.location.origin);
      const parts = url.pathname.split("/");
      const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
      if (url.origin !== window.location.origin || url.username || url.password || parts.length !== 4 || parts[1] !== "channels" || !uuid.test(parts[2]) || !uuid.test(parts[3])) throw new Error("Paste the affected room’s /channels/space-id/room-id link from this host.");
      const { channels } = await api.serverChannels(parts[2]);
      const channel = channels.find((channel) => channel.id === parts[3]);
      if (!channel) throw new Error("This account cannot access the selected room.");
      const report = await (await unlock()).diagnoseHistory(channel.conversationId);
      output.textContent = `History check: ${report.sampled} messages sampled; ${report.readable} readable; ${report.missingKeys} missing keys; ${report.earlierKeysNeeded} need earlier keys; ${report.otherErrors} other errors. Export contains ${report.roomKeys} room keys, matching ${report.matchingSessions} of ${report.requiredSessions} message sessions. Check version: 1.`;
      status.textContent = "History check complete. Compare this summary with the same check in the original browser. You can share these counts, but never share your recovery key, passphrase, or approval link.";
    } catch (error) { output.textContent = "Check did not complete."; throw error; }
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
        status.textContent = result.imported > 0
          ? `Device approved. Added ${result.imported} new or earlier history keys from ${result.total} supplied. Open chat to retry locked messages; already-open chats refresh automatically.`
          : `Device approved, but no new or earlier keys were added (${result.total} supplied). This browser already has the same or better keys. If messages remain locked, request approval from a device that can read those specific messages.`;
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
