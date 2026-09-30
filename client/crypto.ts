import {
  Attachment,
  CollectStrategy,
  DecryptionSettings,
  DeviceId,
  DeviceLists,
  EncryptionAlgorithm,
  EncryptionSettings,
  EncryptedAttachment,
  HistoryVisibility,
  initAsync,
  OlmMachine,
  RequestType,
  RoomId,
  RoomSettings,
  TrustRequirement,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-wasm";
import { ApiError, type ApiClient, type ConversationMember, type MessageEnvelope, type UploadOptions } from "./api";
import { openRecovery, sealRecovery, parseRecoveryKey, randomRecoverySecret, recoverySecretHash, wrapLocalRecovery, unwrapLocalRecovery, type DevicePairing } from "./history-recovery-crypto";
import { readLocalRecovery, writeLocalRecovery } from "./history-recovery-store";
import { prepareMedia } from "./media";
import {
  enqueuePendingMessage,
  listPendingMessages,
  removePendingMessage,
  updatePendingMessage,
  type PendingMessage,
  type PendingMessagePayload,
} from "./outbox";

type OutgoingRequest = {
  type: RequestType;
  id: string;
  body: string;
  event_type?: string;
  txn_id?: string;
};

type MatrixEvent = {
  type: string;
  content: Record<string, unknown>;
  sender: string;
  event_id: string;
  room_id: string;
  origin_server_ts: number;
};

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function matrixUserId(userId: string) {
  return `@${userId}:priv-chat`;
}

export function matrixRoomId(conversationId: string) {
  return `!${conversationId}:priv-chat`;
}

function cryptoStoreName(userId: string) {
  return `priv-chat-crypto-${userId}`;
}

function localDeviceId(userId: string) {
  const key = `priv-chat.device.${userId}`;
  const stored = localStorage.getItem(key);
  if (stored && uuidPattern.test(stored)) return stored;
  const created = randomUuid();
  localStorage.setItem(key, created);
  return created;
}

function rememberLocalDeviceId(userId: string, deviceId: string) {
  localStorage.setItem(`priv-chat.device.${userId}`, deviceId);
}

function isStoreDeviceMismatch(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("account in the store doesn't match the account in the constructor");
}

function randomUuid() {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function jsonObject(value: string) {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_crypto_json");
  return parsed as Record<string, unknown>;
}

function copyOutgoingRequest(request: OutgoingRequest & { free?: () => void }): OutgoingRequest {
  const copy = {
    type: request.type,
    id: request.id,
    body: request.body,
    event_type: request.event_type,
    txn_id: request.txn_id,
  };
  request.free?.();
  return copy;
}

function eventForMessage(message: MessageEnvelope): MatrixEvent {
  const event = jsonObject(new TextDecoder().decode(decodeBase64Url(message.ciphertext))) as Partial<MatrixEvent>;
  if (event.type !== "m.room.encrypted" || !event.content || typeof event.content !== "object") {
    throw new Error("invalid_encrypted_event");
  }
  return {
    type: event.type,
    content: event.content as Record<string, unknown>,
    sender: typeof event.sender === "string" ? event.sender : matrixUserId(message.senderUserId ?? "unknown"),
    event_id: typeof event.event_id === "string" ? event.event_id : `$${message.id}:priv-chat`,
    room_id: typeof event.room_id === "string" ? event.room_id : matrixRoomId(message.conversationId),
    origin_server_ts: typeof event.origin_server_ts === "number" ? event.origin_server_ts : Date.now(),
  };
}

export type DecryptedMessage = {
  sender: string;
  content: Record<string, unknown>;
};

export const MAX_MESSAGE_TEXT_LENGTH = 4_000;

export type DecryptedMessageResult =
  | { messageId: string; decrypted: DecryptedMessage }
  | { messageId: string; error: unknown };

export type ReplyReference = {
  messageId: string;
  sender: string;
  body: string;
  userId?: string;
  username?: string;
  mentionSender?: boolean;
};

export type SendContentResult = {
  delivery: "sent" | "queued";
  pending?: PendingMessage;
  message?: MessageEnvelope;
  decrypted?: DecryptedMessage;
};

type MediaUploadOptions = UploadOptions & {
  spoiler?: boolean;
  album?: { id: string; index: number; total: number };
};

type MediaBatchOptions = UploadOptions & {
  body?: string;
  embeds?: unknown[];
  replyTo?: ReplyReference;
  mentions?: string[];
  roleMentions?: string[];
  onAttachmentStart?: (index: number) => void;
};

export class LocalCryptoStoreError extends Error {
  constructor() {
    super("local_crypto_store_unlock_failed");
    this.name = "LocalCryptoStoreError";
  }
}

function canRetryMessage(error: unknown) {
  return !(error instanceof ApiError) || error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

export class CryptoClient {
  private historyBackupState?: { id: string; dataKey: string; encryptedKey: string };
  private historyBackupTimer?: number;
  private historyBackupInFlight?: Promise<void>;
  private historyBackupMessage = "Automatic backup is not enabled on this device.";
  private historyBackupUnlocking = false;
  private closing = false;
  private reloadHistoryBackup = () => {
    if (!this.initialized || this.historyBackupState || this.historyBackupUnlocking) return;
    this.historyBackupUnlocking = true;
    void this.loadHistoryBackup().finally(() => { this.historyBackupUnlocking = false; });
  };
  private readonly api: ApiClient;
  private readonly accountUserId: string;
  private readonly storePassphrase: string;
  private requestedDeviceId: string;
  private machine?: OlmMachine;
  private initialized = false;
  private readonly preparingRooms = new Map<string, Promise<void>>();
  private cryptoOperation: Promise<void> = Promise.resolve();
  private syncPromise?: Promise<number>;
  private outboxPromise?: Promise<{ sent: number; pending: number; failed: number }>;

  constructor(api: ApiClient, accountUserId: string, storePassphrase: string) {
    this.api = api;
    this.accountUserId = accountUserId;
    this.storePassphrase = storePassphrase;
    this.requestedDeviceId = localDeviceId(accountUserId);
  }

  get deviceId() {
    return this.machine?.deviceId.toString() ?? this.requestedDeviceId;
  }

  async initialize(options: { syncToDevice?: boolean } = {}) {
    if (this.closing) throw new Error("crypto_client_closed");
    if (this.initialized) return;
    if (!this.storePassphrase) throw new Error("local_crypto_passphrase_required");

    await initAsync(`${window.location.origin}/assets/matrix_sdk_crypto_wasm_bg.wasm`);

    const candidateDeviceIds = [this.requestedDeviceId];
    for (let index = 0; index < candidateDeviceIds.length; index += 1) {
      const candidateDeviceId = candidateDeviceIds[index];
      try {
        this.machine = await OlmMachine.initialize(
          new UserId(matrixUserId(this.accountUserId)),
          new DeviceId(candidateDeviceId),
          cryptoStoreName(this.accountUserId),
          this.storePassphrase,
        );
        this.requestedDeviceId = candidateDeviceId;
        rememberLocalDeviceId(this.accountUserId, candidateDeviceId);
        break;
      } catch (error) {
        if (!isStoreDeviceMismatch(error)) throw new LocalCryptoStoreError();
        if (index === 0) {
          const knownDevices = await this.api.devices().catch(() => ({ devices: [] }));
          for (const device of knownDevices.devices) {
            if (uuidPattern.test(device.id) && !candidateDeviceIds.includes(device.id)) candidateDeviceIds.push(device.id);
          }
        }
      }
    }
    if (!this.machine) {
      throw new LocalCryptoStoreError();
    }
    this.initialized = true;
    this.state.roomKeyRequestsEnabled = true;
    if (options.syncToDevice === false) return;
    try {
      // Ask the SDK to request room keys when a device misses an original share.
      // Forwarding remains controlled by the SDK's device-trust rules.
      await this.processOutgoingRequests();
      await this.syncToDevice();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
    await this.loadHistoryBackup();
    window.addEventListener("focus", this.reloadHistoryBackup);
  }

  private async loadHistoryBackup() {
    try {
      const stored = await readLocalRecovery(this.accountUserId);
      if (stored && this.initialized && !this.closing) {
        const state = this.parseHistoryBackupState(JSON.parse(await unwrapLocalRecovery(this.storePassphrase, this.accountUserId, stored)));
        if (!this.initialized || this.closing) return;
        this.historyBackupState = state;
        this.startHistoryBackup();
      }
    } catch { this.historyBackupMessage = "Could not unlock automatic backup. Restore with your recovery key to re-enable it."; }
  }

  get historyBackupStatus() { return this.historyBackupMessage; }
  get hasHistoryBackupKey() { return Boolean(this.historyBackupState); }

  private parseHistoryBackupState(value: unknown) {
    const state = value as Record<string, unknown> | null;
    if (!state || typeof state.id !== "string" || !uuidPattern.test(state.id) || typeof state.dataKey !== "string"
      || typeof state.encryptedKey !== "string" || state.encryptedKey.length > 4096) throw new Error("invalid_history_backup_state");
    parseRecoveryKey(state.dataKey);
    return { id: state.id, dataKey: state.dataKey, encryptedKey: state.encryptedKey };
  }

  private async rememberHistoryBackup(state: { id: string; dataKey: string; encryptedKey: string }) {
    if (this.closing) throw new Error("crypto_client_closed");
    await writeLocalRecovery(this.accountUserId, await wrapLocalRecovery(this.storePassphrase, this.accountUserId, JSON.stringify(state)));
    if (this.closing) return;
    this.historyBackupState = state;
    this.startHistoryBackup();
  }

  private startHistoryBackup() {
    window.clearInterval(this.historyBackupTimer);
    this.historyBackupMessage = "Automatic backup enabled on this device.";
    this.historyBackupTimer = window.setInterval(() => { void this.backupHistoryNow().catch(() => undefined); }, 60_000);
    void this.backupHistoryNow().catch(() => undefined);
  }

  async enableHistoryBackup(recoveryKey: string) {
    const secret = parseRecoveryKey(recoveryKey);
    if ((await this.api.historyBackup()).backup) throw new Error("A backup already exists. Restore it with its recovery key instead of replacing it.");
    const id = crypto.randomUUID();
    const dataKey = randomRecoverySecret();
    const encryptedKey = await sealRecovery(secret, `backup-key/${this.accountUserId}/${id}`, dataKey);
    const encryptedExport = await this.exportRecovery(dataKey);
    await this.api.putHistoryBackup({ id, deviceId: this.deviceId, revision: "0", encryptedKey, encryptedExport });
    await this.rememberHistoryBackup({ id, dataKey, encryptedKey });
  }

  async restoreHistoryBackup(recoveryKey: string) {
    const backup = (await this.api.historyBackup()).backup;
    if (!backup) throw new Error("No encrypted history backup exists for this account.");
    const dataKey = await openRecovery(parseRecoveryKey(recoveryKey), `backup-key/${this.accountUserId}/${backup.id}`, backup.encryptedKey);
    parseRecoveryKey(dataKey);
    const imported = await this.importRecovery(backup.encryptedExport, dataKey);
    await this.rememberHistoryBackup({ id: backup.id, dataKey, encryptedKey: backup.encryptedKey });
    return imported;
  }

  backupHistoryNow(): Promise<void> {
    if (this.historyBackupInFlight) return this.historyBackupInFlight;
    const work = this.backupHistoryWithRetries();
    this.historyBackupInFlight = work;
    void work.finally(() => { if (this.historyBackupInFlight === work) this.historyBackupInFlight = undefined; }).catch(() => undefined);
    return work;
  }

  private async backupHistoryWithRetries() {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.backupHistoryInternal(); }
      catch (error) {
        if (this.closing || !(error instanceof ApiError) || error.code !== "history_backup_conflict" || attempt >= 2) throw error;
        // Fetch and merge the winning revision again; never reuse a stale export.
      }
    }
  }

  private async backupHistoryInternal() {
    const state = this.historyBackupState;
    if (!state || !this.initialized || this.closing) return;
    try {
      const backup = (await this.api.historyBackup()).backup;
      if (!backup || backup.id !== state.id || backup.encryptedKey !== state.encryptedKey) {
        window.clearInterval(this.historyBackupTimer);
        this.historyBackupState = undefined;
        await writeLocalRecovery(this.accountUserId);
        throw new Error("Backup was removed or changed. Restore with the current recovery key.");
      }
      // Merge other devices' keys before publishing. Revision checks reject concurrent overwrites.
      await this.importRecovery(backup.encryptedExport, state.dataKey);
      const encryptedExport = await this.exportRecovery(state.dataKey);
      if (!this.initialized || this.closing || this.historyBackupState !== state) return;
      await this.api.putHistoryBackup({ id: state.id, deviceId: this.deviceId, revision: backup.revision, encryptedKey: state.encryptedKey, encryptedExport });
      this.historyBackupMessage = `History backed up at ${new Date().toLocaleTimeString()}.`;
    } catch (error) {
      this.historyBackupMessage = error instanceof ApiError && error.code === "history_backup_conflict"
        ? "Another device updated the backup. Retrying on the next cycle."
        : "Automatic backup could not complete. Unlock a trusted device or restore your recovery key.";
      throw error;
    }
  }

  async disableHistoryBackup() {
    await this.historyBackupInFlight?.catch(() => undefined);
    const backup = (await this.api.historyBackup()).backup;
    if (backup) await this.api.deleteHistoryBackup({ deviceId: this.deviceId, id: backup.id, revision: backup.revision });
    window.clearInterval(this.historyBackupTimer);
    this.historyBackupState = undefined;
    await writeLocalRecovery(this.accountUserId);
    this.historyBackupMessage = "Server backup deleted. Local history keys remain on this device.";
  }

  async requestHistoryDeviceTransfer(): Promise<DevicePairing & { expiresAt: string }> {
    const pairing = { id: crypto.randomUUID(), deviceId: this.deviceId, secret: randomRecoverySecret() };
    const result = await this.api.createHistoryTransfer({ id: pairing.id, deviceId: pairing.deviceId, secretHash: await recoverySecretHash(pairing.secret) });
    return { ...pairing, expiresAt: result.expiresAt };
  }

  async approveHistoryDeviceTransfer(pairing: DevicePairing) {
    const { transfer } = await this.api.historyTransfer(pairing.id);
    if (transfer.deviceId !== pairing.deviceId || transfer.secretHash !== await recoverySecretHash(pairing.secret) || pairing.deviceId === this.deviceId) throw new Error("Device approval does not match this request.");
    if (this.historyBackupState) await this.backupHistoryNow();
    const encryptedExport = await this.exportRecovery(pairing.secret);
    const payload = JSON.stringify({ version: 1, encryptedExport, backup: this.historyBackupState ?? null });
    const encryptedPayload = await sealRecovery(pairing.secret, `transfer/${this.accountUserId}/${pairing.id}/${pairing.deviceId}`, payload);
    await this.api.approveHistoryTransfer(pairing.id, { deviceId: this.deviceId, encryptedPayload });
  }

  async finishHistoryDeviceTransfer(pairing: DevicePairing, isCurrent: () => boolean = () => true) {
    if (pairing.deviceId !== this.deviceId) throw new Error("This transfer belongs to another device.");
    const { transfer } = await this.api.historyTransfer(pairing.id);
    if (!isCurrent()) return null;
    if (transfer.deviceId !== pairing.deviceId || transfer.secretHash !== await recoverySecretHash(pairing.secret)) throw new Error("Device approval request changed.");
    if (!transfer.encryptedPayload) return null;
    const payload = JSON.parse(await openRecovery(pairing.secret, `transfer/${this.accountUserId}/${pairing.id}/${pairing.deviceId}`, transfer.encryptedPayload));
    if (payload.version !== 1 || typeof payload.encryptedExport !== "string") throw new Error("Invalid device history transfer.");
    const backup = payload.backup ? this.parseHistoryBackupState(payload.backup) : undefined;
    if (!isCurrent()) return null;
    const imported = await this.importRecovery(payload.encryptedExport, pairing.secret);
    if (backup) await this.rememberHistoryBackup(backup);
    await this.api.deleteHistoryTransfer(pairing.id).catch(() => undefined);
    return imported;
  }

  async exportRecovery(passphrase: string) {
    if (!passphrase) throw new Error("recovery_passphrase_required");
    return this.runCryptoOperation(async () => {
      const exported = await this.state.exportRoomKeys(() => true);
      return OlmMachine.encryptExportedRoomKeys(exported, passphrase, 100_000);
    });
  }

  async importRecovery(encryptedExport: string, passphrase: string) {
    if (!passphrase) throw new Error("recovery_passphrase_required");
    return this.runCryptoOperation(async () => {
      const exported = OlmMachine.decryptExportedRoomKeys(encryptedExport, passphrase);
      const result = await this.state.importExportedRoomKeys(exported, () => undefined);
      return { imported: result.importedCount, total: result.totalCount };
    });
  }

  private get state() {
    if (!this.machine || !this.initialized) throw new Error("crypto_not_initialized");
    return this.machine;
  }

  private runCryptoOperation<T>(operation: () => Promise<T>) {
    if (this.closing) return Promise.reject<T>(new Error("crypto_client_closed"));
    const next = this.cryptoOperation.then(operation, operation);
    this.cryptoOperation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async sendOutgoingRequest(request: OutgoingRequest) {
    let response: unknown;
    switch (request.type) {
      case RequestType.KeysUpload:
        {
          const body = jsonObject(request.body);
          // Matrix omits device_keys when it replenishes one-time keys. The
          // custom transport is session-authenticated rather than device-
          // authenticated, so include the local device id for that update.
          body.device_id = this.deviceId;
          response = await this.api.cryptoRequest("/v1/crypto/keys/upload", body);
        }
        break;
      case RequestType.KeysQuery:
        response = await this.api.cryptoRequest("/v1/crypto/keys/query", jsonObject(request.body));
        break;
      case RequestType.KeysClaim:
        response = await this.api.cryptoRequest("/v1/crypto/keys/claim", jsonObject(request.body));
        break;
      case RequestType.ToDevice:
        if (!request.event_type || !request.txn_id) throw new Error("invalid_to_device_request");
        response = await this.api.cryptoRequest(
          `/v1/crypto/send-to-device/${encodeURIComponent(request.event_type)}/${encodeURIComponent(request.txn_id)}`,
          jsonObject(request.body),
        );
        break;
      default:
        throw new Error(`unsupported_crypto_request_${request.type}`);
    }

    await this.state.markRequestAsSent(request.id, request.type, JSON.stringify(response));
  }

  private async processOutgoingRequests() {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const requests = await this.state.outgoingRequests() as unknown as OutgoingRequest[];
      if (requests.length === 0) return;
      // Marking a WASM request as sent can invalidate the other handles from
      // the same returned vector. Copy and free only the request we process,
      // then fetch the remaining queue again.
      await this.sendOutgoingRequest(copyOutgoingRequest(requests[0]));
    }
    throw new Error("crypto_request_loop");
  }

  private async sendToDeviceRequests(requests: OutgoingRequest[]) {
    const copied = requests.map((request) => copyOutgoingRequest(request));
    for (const request of copied) {
      if (request.type !== RequestType.ToDevice) throw new Error("unexpected_to_device_request");
      await this.sendOutgoingRequest(request);
    }
  }

  async prepareConversation(conversationId: string, members: ConversationMember[]) {
    const existingPreparation = this.preparingRooms.get(conversationId);
    if (existingPreparation) {
      await existingPreparation;
      return;
    }

    const preparation = this.runCryptoOperation(() => this.prepareConversationInternal(conversationId, members));
    this.preparingRooms.set(conversationId, preparation);
    try {
      await preparation;
    } finally {
      if (this.preparingRooms.get(conversationId) === preparation) this.preparingRooms.delete(conversationId);
    }
  }

  private async prepareConversationInternal(conversationId: string, members: ConversationMember[]) {
    const memberIds = [...new Set(members.map((member) => member.matrixUserId).concat(matrixUserId(this.accountUserId)))].sort();

    const roomId = new RoomId(matrixRoomId(conversationId));
    const roomSettings = new RoomSettings();
    roomSettings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2;
    roomSettings.encryptStateEvents = true;
    roomSettings.onlyAllowTrustedDevices = false;
    roomSettings.sessionRotationPeriodMessages = 100;
    roomSettings.sessionRotationPeriodMs = 7 * 24 * 60 * 60 * 1000;
    await this.state.setRoomSettings(roomId, roomSettings);
    roomSettings.free();

    await this.state.updateTrackedUsers(memberIds.map((id) => new UserId(id)));
    // The server does not maintain a Matrix sync token, so its device-list
    // change set is intentionally empty. Refresh tracked users explicitly so
    // a device opened after the first room-key share is discovered.
    await this.state.markAllTrackedUsersAsDirty();
    await this.processOutgoingRequests();

    const missingSessions = await this.state.getMissingSessions(memberIds.map((id) => new UserId(id)));
    if (missingSessions) {
      await this.sendOutgoingRequest(copyOutgoingRequest(missingSessions as unknown as OutgoingRequest & { free: () => void }));
    }

    const encryptionSettings = new EncryptionSettings();
    encryptionSettings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2;
    encryptionSettings.encryptStateEvents = true;
    encryptionSettings.historyVisibility = HistoryVisibility.Shared;
    encryptionSettings.rotationPeriodMessages = BigInt(100);
    encryptionSettings.rotationPeriod = BigInt(7 * 24 * 60 * 60 * 1_000_000);
    const strategy = CollectStrategy.allDevices();
    encryptionSettings.sharingStrategy = strategy;
    const roomKeyRequests = await this.state.shareRoomKey(
      roomId,
      memberIds.map((id) => new UserId(id)),
      encryptionSettings,
    );
    encryptionSettings.free();
    await this.sendToDeviceRequests(roomKeyRequests as unknown as OutgoingRequest[]);
    await this.processOutgoingRequests();
    roomId.free();
  }

  async syncToDevice() {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.runCryptoOperation(() => this.syncToDeviceInternal()).finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  private async syncToDeviceInternal() {
    const response = await this.api.toDevice(this.deviceId);
    if (response.events.length === 0) {
      await this.processOutgoingRequests();
      return 0;
    }

    const events = response.events.map((event) => ({
      type: event.type,
      sender: event.sender,
      content: event.content,
      event_id: `$${event.eventId}:priv-chat`,
      origin_server_ts: Date.now(),
    }));
    const changed = response.device_lists.changed.map((id) => new UserId(id));
    const left = response.device_lists.left.map((id) => new UserId(id));
    const deviceLists = new DeviceLists(changed, left);
    const oneTimeKeyCounts = new Map(Object.entries(response.one_time_keys_count).map(([name, count]) => [name, Number(count)]));
    const fallbackKeys = new Set(response.unused_fallback_key_types ?? []);
    // The WASM sync path invalidates this handle while processing events;
    // freeing it again triggers a Rust null-pointer panic.
    const settings = new DecryptionSettings(TrustRequirement.Untrusted);
    try {
      const processed = await this.state.receiveSyncChangesMsc4186(
        JSON.stringify(events),
        deviceLists,
        oneTimeKeyCounts,
        fallbackKeys,
        settings,
      );
      await this.processOutgoingRequests();
      await this.api.acknowledgeToDevice(this.deviceId, response.events.map((event) => event.eventId));
      for (const event of processed) event.free?.();
      return processed.length;
    } finally {
      deviceLists.free();
    }
  }

  private async encryptContent(conversationId: string, members: ConversationMember[], content: Record<string, unknown>) {
    await this.prepareConversation(conversationId, members);
    return this.runCryptoOperation(async () => {
      const roomId = new RoomId(matrixRoomId(conversationId));
      try {
        const encryptedContent = await this.state.encryptRoomEvent(roomId, "m.room.message", JSON.stringify(content));
        const event: MatrixEvent = {
          type: "m.room.encrypted",
          content: jsonObject(encryptedContent),
          sender: matrixUserId(this.accountUserId),
          event_id: `$${randomUuid()}:priv-chat`,
          room_id: matrixRoomId(conversationId),
          origin_server_ts: Date.now(),
        };
        return encodeBase64Url(new TextEncoder().encode(JSON.stringify(event)));
      } finally {
        roomId.free();
      }
    });
  }

  async encryptMetadata(conversationId: string, members: ConversationMember[], metadata: Record<string, unknown>) {
    return this.encryptContent(conversationId, members, {
      msgtype: "m.priv-chat.metadata",
      body: JSON.stringify(metadata),
    });
  }

  async decryptMetadata(conversationId: string, ciphertext: string) {
    const decrypted = await this.decryptMessage(conversationId, {
      id: randomUuid(),
      conversationId,
      senderDeviceId: this.deviceId,
      senderUserId: null,
      clientMessageId: randomUuid(),
      serverSequence: "0",
      protocol: "matrix-v1",
      ciphertext,
      protocolMetadata: "",
      createdAt: new Date().toISOString(),
    });
    if (decrypted.content.msgtype !== "m.priv-chat.metadata" || typeof decrypted.content.body !== "string") {
      throw new Error("invalid_encrypted_metadata");
    }
    return jsonObject(decrypted.content.body);
  }

  async sendContent(conversationId: string, members: ConversationMember[], content: Record<string, unknown>, attachmentIds?: string | string[]): Promise<SendContentResult> {
    const ciphertext = await this.encryptContent(conversationId, members, content);
    const decrypted: DecryptedMessage = {
      sender: matrixUserId(this.accountUserId),
      content,
    };
    const ids = typeof attachmentIds === "string" ? [attachmentIds] : [...new Set(attachmentIds ?? [])];
    const payload: PendingMessagePayload = {
      senderDeviceId: this.deviceId,
      clientMessageId: randomUuid(),
      protocol: "matrix-v1",
      ciphertext,
      ...(ids.length === 1 ? { attachmentId: ids[0] } : {}),
      ...(ids.length > 1 ? { attachmentIds: ids } : {}),
    };
    try {
      const result = await this.api.sendMessage(conversationId, payload);
      return { delivery: "sent", message: result.message, decrypted };
    } catch (error) {
      if (!canRetryMessage(error)) throw error;
      try {
        const pending = await enqueuePendingMessage(conversationId, payload);
        return { delivery: "queued", pending };
      } catch {
        throw error;
      }
    }
  }

  async flushPendingMessages() {
    if (this.outboxPromise) return this.outboxPromise;
    this.outboxPromise = this.flushPendingMessagesInternal().finally(() => {
      this.outboxPromise = undefined;
    });
    return this.outboxPromise;
  }

  async pendingMessages() {
    return (await listPendingMessages()).filter((record) => record.senderDeviceId === this.deviceId);
  }

  private async flushPendingMessagesInternal() {
    const records = await this.pendingMessages();
    let sent = 0;
    let pending = 0;
    let failed = 0;
    for (const record of records) {
      if (record.status === "failed") {
        failed += 1;
        continue;
      }
      try {
        await this.api.sendMessage(record.conversationId, {
          senderDeviceId: record.senderDeviceId,
          clientMessageId: record.clientMessageId,
          protocol: record.protocol,
          ciphertext: record.ciphertext,
          protocolMetadata: record.protocolMetadata,
          attachmentId: record.attachmentId,
          attachmentIds: record.attachmentIds,
        });
        await removePendingMessage(record.id);
        sent += 1;
      } catch (error) {
        record.attempts += 1;
        record.lastError = error instanceof Error ? error.message : "send_failed";
        if (!canRetryMessage(error)) {
          record.status = "failed";
          failed += 1;
        } else {
          pending += 1;
        }
        await updatePendingMessage(record);
      }
    }
    return { sent, pending, failed };
  }

  async retryFailedMessages() {
    if (this.outboxPromise) await this.outboxPromise;
    const records = await this.pendingMessages();
    for (const record of records) {
      if (record.status !== "failed") continue;
      record.status = "pending";
      record.lastError = undefined;
      await updatePendingMessage(record);
    }
    return this.flushPendingMessages();
  }

  async sendText(conversationId: string, members: ConversationMember[], body: string, embeds: unknown[], replyTo?: ReplyReference, mentions: string[] = [], roleMentions: string[] = []) {
    if (body.length > MAX_MESSAGE_TEXT_LENGTH) throw new Error("message_too_long");
    return this.sendContent(conversationId, members, {
      msgtype: "m.text",
      body,
      embeds,
      ...(mentions.length > 0 ? { mentions: [...new Set(mentions)].slice(0, 50) } : {}),
      ...(roleMentions.length > 0 ? { roleMentions: [...new Set(roleMentions)].slice(0, 25) } : {}),
      ...(replyTo ? {
        replyTo: {
          messageId: replyTo.messageId,
          sender: replyTo.sender.slice(0, 120),
          body: replyTo.body.slice(0, 1_000),
        },
      } : {}),
    });
  }

  async sendRedaction(conversationId: string, members: ConversationMember[], messageId: string) {
    return this.sendContent(conversationId, members, {
      msgtype: "m.redaction",
      redacts: messageId,
    });
  }

  async sendEdit(conversationId: string, members: ConversationMember[], messageId: string, body: string, embeds: unknown[], mentions: string[] = [], roleMentions: string[] = []) {
    if (body.length > MAX_MESSAGE_TEXT_LENGTH) throw new Error("message_too_long");
    return this.sendContent(conversationId, members, {
      msgtype: "m.replace",
      replaces: messageId,
      body,
      embeds,
      ...(mentions.length > 0 ? { mentions: [...new Set(mentions)].slice(0, 50) } : {}),
      ...(roleMentions.length > 0 ? { roleMentions: [...new Set(roleMentions)].slice(0, 25) } : {}),
    });
  }

  async sendReaction(conversationId: string, members: ConversationMember[], messageId: string, key: string, action: "add" | "remove") {
    return this.sendContent(conversationId, members, {
      msgtype: "m.reaction",
      relatesTo: messageId,
      key,
      action,
    });
  }

  async sendPin(conversationId: string, members: ConversationMember[], messageId: string, action: "add" | "remove") {
    return this.sendContent(conversationId, members, {
      msgtype: "m.pin",
      pins: messageId,
      action,
    });
  }

  private async uploadEncryptedMedia(conversationId: string, file: File, options: MediaUploadOptions = {}) {
    options.signal?.throwIfAborted();
    const compressed = await prepareMedia(file);
    options.signal?.throwIfAborted();
    const encrypted = Attachment.encrypt(new Uint8Array(await compressed.blob.arrayBuffer()));
    const encryptedBytes = encrypted.encryptedData;
    const mediaEncryptionInfo = encrypted.mediaEncryptionInfo;
    if (!mediaEncryptionInfo) {
      encrypted.free();
      throw new Error("missing_media_encryption_info");
    }

    try {
      options.signal?.throwIfAborted();
      const attachment = await this.api.createAttachment(
        conversationId,
        encryptedBytes.byteLength,
        compressed.extension,
        compressed.mimeType,
      );
      options.signal?.throwIfAborted();
      await this.api.putBytes(attachment.attachment.uploadPath, encryptedBytes, options);
      options.signal?.throwIfAborted();
      const mediaFile = {
        ...jsonObject(mediaEncryptionInfo),
        url: attachment.attachment.uploadPath,
      };
      return {
        attachmentId: attachment.attachment.id,
        content: {
          msgtype: compressed.mimeType.startsWith("video/")
            ? "m.video"
            : compressed.mimeType.startsWith("image/") ? "m.image" : "m.file",
          body: "",
          filename: compressed.name.slice(0, 255),
          info: {
            mimetype: compressed.mimeType,
            size: compressed.blob.size,
            w: compressed.width || undefined,
            h: compressed.height || undefined,
          },
          file: mediaFile,
          ...(options.spoiler ? { spoiler: true } : {}),
          ...(options.album ? { album: options.album } : {}),
        },
      };
    } finally {
      encrypted.free();
    }
  }

  async sendMedia(conversationId: string, members: ConversationMember[], file: File, options: MediaUploadOptions = {}) {
    const uploaded = await this.uploadEncryptedMedia(conversationId, file, options);
    return this.sendContent(conversationId, members, uploaded.content, uploaded.attachmentId);
  }

  async sendMediaBatch(
    conversationId: string,
    members: ConversationMember[],
    files: Array<{ file: File; spoiler?: boolean }>,
    options: MediaBatchOptions = {},
  ) {
    if (files.length === 0) throw new Error("empty_media_batch");
    const attachments: Record<string, unknown>[] = [];
    const attachmentIds: string[] = [];
    for (let index = 0; index < files.length; index += 1) {
      options.onAttachmentStart?.(index);
      const uploaded = await this.uploadEncryptedMedia(conversationId, files[index].file, {
        ...options,
        spoiler: files[index].spoiler,
      });
      attachments.push(uploaded.content);
      attachmentIds.push(uploaded.attachmentId);
    }
    const body = options.body ?? "";
    if (body.length > MAX_MESSAGE_TEXT_LENGTH) throw new Error("message_too_long");
    return this.sendContent(conversationId, members, {
      msgtype: "m.attachments",
      body,
      attachments,
      embeds: options.embeds ?? [],
      ...(options.mentions && options.mentions.length > 0 ? { mentions: [...new Set(options.mentions)].slice(0, 50) } : {}),
      ...(options.roleMentions && options.roleMentions.length > 0 ? { roleMentions: [...new Set(options.roleMentions)].slice(0, 25) } : {}),
      ...(options.replyTo ? {
        replyTo: {
          messageId: options.replyTo.messageId,
          sender: options.replyTo.sender.slice(0, 120),
          body: options.replyTo.body.slice(0, 1_000),
        },
      } : {}),
    }, attachmentIds);
  }

  async sendPhoto(conversationId: string, members: ConversationMember[], file: File, options: MediaUploadOptions = {}) {
    return this.sendMedia(conversationId, members, file, options);
  }

  private async decryptMessageInternal(conversationId: string, message: MessageEnvelope): Promise<DecryptedMessage> {
    if (message.protocol !== "matrix-v1") throw new Error("unsupported_message_protocol");
    const roomId = new RoomId(matrixRoomId(conversationId));
    // decryptRoomEvent invalidates its settings handle in the current WASM
    // binding, so do not manually free it after the call.
    const settings = new DecryptionSettings(TrustRequirement.Untrusted);
    try {
      const decrypted = await this.state.decryptRoomEvent(JSON.stringify(eventForMessage(message)), roomId, settings);
      const event = jsonObject(decrypted.event);
      const sender = decrypted.sender.toString();
      const content = jsonObject(JSON.stringify(event.content));
      decrypted.free();
      return { sender, content };
    } finally {
      roomId.free();
    }
  }

  async decryptMessage(conversationId: string, message: MessageEnvelope): Promise<DecryptedMessage> {
    return this.runCryptoOperation(() => this.decryptMessageInternal(conversationId, message));
  }

  async decryptMessages(conversationId: string, messages: MessageEnvelope[]): Promise<DecryptedMessageResult[]> {
    if (messages.length === 0) return [];
    return this.runCryptoOperation(async () => {
      const results: DecryptedMessageResult[] = [];
      for (const message of messages) {
        try {
          results.push({ messageId: message.id, decrypted: await this.decryptMessageInternal(conversationId, message) });
        } catch (error) {
          // One unavailable room key must not prevent the rest of the page
          // from being rendered.
          results.push({ messageId: message.id, error });
        }
      }
      return results;
    });
  }

  async decryptMedia(content: Record<string, unknown>, options: { signal?: AbortSignal; onProgress?: (loadedBytes: number, totalBytes: number) => void } = {}) {
    const file = content.file;
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("invalid_encrypted_photo");
    const fileObject = file as Record<string, unknown>;
    if (typeof fileObject.url !== "string") throw new Error("invalid_encrypted_photo_url");
    const mediaInfo = { ...fileObject };
    delete mediaInfo.url;
    const encryptedBytes = new Uint8Array(await this.api.downloadAttachment(fileObject.url, options));
    const encrypted = new EncryptedAttachment(encryptedBytes, JSON.stringify(mediaInfo));
    try {
      const clearBytes = Attachment.decrypt(encrypted);
      const info = content.info;
      const mimeType = info && typeof info === "object" && !Array.isArray(info) && typeof (info as Record<string, unknown>).mimetype === "string"
        ? (info as Record<string, unknown>).mimetype as string
        : "application/octet-stream";
      const clearCopy = new Uint8Array(clearBytes.byteLength);
      clearCopy.set(clearBytes);
      return new Blob([clearCopy.buffer], { type: mimeType });
    } finally {
      encrypted.free();
    }
  }

  async decryptPhoto(content: Record<string, unknown>, options: { signal?: AbortSignal; onProgress?: (loadedBytes: number, totalBytes: number) => void } = {}) {
    return this.decryptMedia(content, options);
  }

  async close() {
    this.closing = true;
    window.removeEventListener("focus", this.reloadHistoryBackup);
    window.clearInterval(this.historyBackupTimer);
    this.historyBackupState = undefined;
    await this.historyBackupInFlight?.catch(() => undefined);
    await this.cryptoOperation;
    this.preparingRooms.clear();
    this.machine?.close();
    this.machine = undefined;
    this.initialized = false;
  }
}
