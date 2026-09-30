export type User = {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
};

export type Conversation = {
  id: string;
  kind: "dm" | "group";
  encryptedMetadata: string;
  memberDisplayNames: string[];
  createdAt: string;
};

export type ServerRole = "owner" | "admin" | "member";

export type ServerPermission =
  | "view_channels"
  | "send_messages"
  | "upload_files"
  | "view_members"
  | "mention_everyone"
  | "mention_here"
  | "mention_roles"
  | "manage_server"
  | "manage_channels"
  | "create_channels"
  | "edit_channels"
  | "reorder_channels"
  | "archive_channels"
  | "manage_categories"
  | "manage_channel_access"
  | "manage_invites"
  | "view_invites"
  | "create_invites"
  | "revoke_invites"
  | "manage_invite_limits"
  | "manage_roles"
  | "create_roles"
  | "edit_roles"
  | "delete_roles"
  | "assign_roles"
  | "reorder_roles"
  | "manage_role_permissions"
  | "manage_role_appearance"
  | "manage_members"
  | "kick_members"
  | "view_moderation_records"
  | "ban_members"
  | "unban_members"
  | "timeout_members"
  | "remove_timeouts"
  | "warn_members"
  | "revoke_warnings"
  | "pin_messages"
  | "delete_others_messages"
  | "delete_messages"
  | "manage_custom_emoji"
  | "view_audit_logs";

export type ServerPermissionMap = Record<ServerPermission, boolean>;

export type Server = {
  id: string;
  ownerId: string;
  encryptedMetadata: string;
  role: ServerRole;
  permissions: ServerPermissionMap;
  channelCount: number;
  onboardingChannelId: string | null;
  landingChannelId: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  deactivatedAt: string | null;
  createdAt: string;
};

export type ServerChannel = {
  id: string;
  serverId: string;
  conversationId: string;
  encryptedMetadata: string;
  categoryId: string | null;
  kind: "text" | "voice";
  position: number;
  canView?: boolean;
  canUpload?: boolean;
  canSend?: boolean;
  createdAt: string;
};

export type ServerCategory = {
  id: string;
  serverId: string;
  encryptedMetadata: string;
  position: number;
  createdAt: string;
};

export type ServerMember = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl?: string | null;
  role: ServerRole;
  roleIds: string[];
  joinedAt: string;
};

export type ConversationMember = {
  userId: string;
  matrixUserId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl?: string | null;
  roleIds?: string[];
};

export type ServerRoleChannelAccess = {
  channelId: string;
  canView: boolean;
  canUpload: boolean;
};

export type ServerRoleCategoryAccess = {
  categoryId: string;
  canView: boolean;
  canUpload: boolean;
};

export type CustomServerRole = {
  id: string;
  serverId: string;
  encryptedMetadata: string;
  color: string;
  position: number;
  permissions: ServerPermissionMap;
  mentionable: boolean;
  separateMembers: boolean;
  viewAllChannels: boolean;
  isSystem: boolean;
  systemKey: "owner" | "admin" | "everyone" | "member" | null;
  channelAccess: ServerRoleChannelAccess[];
  categoryAccess: ServerRoleCategoryAccess[];
  createdAt: string;
  updatedAt: string;
};

export type ServerRoleAssignment = { userId: string; roleIds: string[] };

export type ServerModeration = {
  bans: Array<{
    id: string;
    userId: string;
    username: string;
    displayName: string;
    reason: string | null;
    expiresAt: string | null;
    createdAt: string;
  }>;
  timeouts: Array<{
    id: string;
    userId: string;
    username: string;
    displayName: string;
    reason: string | null;
    expiresAt: string;
    createdAt: string;
  }>;
  warnings: Array<{
    id: string;
    userId: string;
    username: string;
    displayName: string;
    createdByUsername: string;
    reason: string;
    expiresAt: string | null;
    createdAt: string;
    acknowledgedAt: string | null;
    revokedAt: string | null;
    active: boolean;
  }>;
};

export type ModerationWarningNotice = {
  id: string;
  reason: string;
  createdAt: string;
  expiresAt: string | null;
};

export type SpaceWarningNotice = ModerationWarningNotice & { serverId: string };

export type InstanceUserDirectoryEntry = {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  banned: boolean;
  timedOut: boolean;
  activeWarningCount: number;
};

export type InstanceSpaceDirectoryEntry = {
  id: string;
  createdAt: string;
  deactivatedAt: string | null;
  activeMemberCount: number;
};

export type InstanceSpaceAuditEntry = {
  id: string;
  source: "space" | "host";
  action: string;
  actor: string;
  targetId: string | null;
  targetUserId: string | null;
  reason: string | null;
  createdAt: string;
};

export type AdminOperator = {
  id: string;
  username: string;
  role: "admin" | "moderator";
  disabled: boolean;
  createdAt: string;
};

export type AdminIdentity = Pick<AdminOperator, "id" | "username" | "role">;

export type AdminOperatorAuditEntry = {
  id: string;
  actorUsername: string;
  targetUsername: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type InstanceUserModeration = {
  user: {
    id: string;
    username: string;
    displayName: string;
    createdAt: string;
    ban: { createdAt: string; reason: string | null } | null;
  };
  warnings: Array<{
    id: string;
    reason: string;
    createdByUsername: string;
    createdAt: string;
    expiresAt: string | null;
    acknowledgedAt: string | null;
    revokedAt: string | null;
    active: boolean;
  }>;
  timeouts: Array<{
    id: string;
    reason: string;
    createdByUsername: string;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
    revokedByUsername: string | null;
    revocationAction: "removed" | "replaced" | "expired" | null;
    active: boolean;
  }>;
  actions: Array<{
    id: string;
    action: string;
    operatorUsername: string;
    details: Record<string, unknown>;
    createdAt: string;
  }>;
};

export type UserReportReason = "spam" | "harassment" | "threats" | "sexual_content" | "illegal_content" | "impersonation" | "other";

export type InstanceReportSummary = {
  id: string;
  reporterUserId: string | null;
  reporterUsername: string | null;
  reporterDisplayName: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  targetDisplayName: string | null;
  conversationId: string | null;
  messageId: string | null;
  reason: UserReportReason;
  status: "open" | "reviewing" | "resolved" | "dismissed";
  hasEvidence: boolean;
  createdAt: string;
  reviewedAt: string | null;
  suspended: boolean;
};

export type InstanceReport = Omit<InstanceReportSummary, "hasEvidence" | "suspended"> & {
  reviewedBy: string | null;
  evidence: {
    keyId: string;
    ciphertext: string;
    wrappedKey: string;
    iv: string;
  } | null;
};

export type InstanceOperationsStorageKind = "attachments" | "customEmoji" | "avatars" | "banners" | "serverBranding" | "shared";

export type InstanceOperationsStorageScan = {
  complete: boolean;
  orphanDetectionAvailable: boolean;
  scannedEntries: number;
  fileCount: number;
  fileBytes: number;
  quarantinedFileCount: number;
  quarantinedBytes: number;
  referencedFileCount: number;
  referencedBytes: number;
  orphanedFileCount: number;
  orphanedBytes: number;
  recentUnreferencedFileCount: number;
  recentUnreferencedBytes: number;
  unverifiedFileCount: number;
  unverifiedBytes: number;
  missingFileCount: number | null;
  temporaryFileCount: number;
  temporaryBytes: number;
  staleTemporaryFileCount: number;
  staleTemporaryBytes: number;
  categories: Record<InstanceOperationsStorageKind, { fileCount: number; bytes: number }>;
  volume: { totalBytes: number; availableBytes: number } | null;
  warnings: string[];
};

export type InstanceOperationsDatabase = {
  status: "available" | "unavailable";
  sizeBytes: number | null;
  tables: Array<{ name: string; sizeBytes: number; estimatedRows: number }>;
  estimatedRows: Record<string, number>;
};

export type InstanceOperationsOverview = {
  generatedAt: string;
  appDatabase: "available" | "unavailable";
  accounts: {
    totalUsers: number | null;
    authenticatedUsers24h: number | null;
    newUsers24h: number | null;
    newUsers7d: number | null;
    activeDevices: number | null;
  };
  realtime: {
    status: "available" | "limited" | "unavailable";
    connectedUsers: number | null;
    websocketConnections: number | null;
    leaseSeconds: number;
  };
  community: { spaces: number | null; activeRooms: number | null };
  activity: {
    messageEnvelopesEstimate: number | null;
    attachmentRecordsEstimate: number | null;
    customEmojiRecordsEstimate: number | null;
    daily: {
      status: "available" | "unavailable";
      days: Array<{
        day: string;
        newUsers: number;
        messageEnvelopes: number;
        attachmentRecords: number;
        customEmojiRecords: number;
      }>;
    };
  };
  moderation: {
    status: "available" | "unavailable";
    openReports: number | null;
    reviewingReports: number | null;
    suspendedAccounts: number | null;
  };
};

export type InstanceOperationsSnapshot = {
  generatedAt: string;
  runtime: {
    uptimeSeconds: number;
    bunVersion: string;
    memory: { residentBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number };
    hostMemory: { totalBytes: number; availableBytes: number };
    loadAverage: [number, number, number];
  };
  services: {
    appDatabase: "available" | "unavailable";
    adminDatabase: "available" | "unavailable";
    redis: "available" | "unavailable";
  };
  databases: { app: InstanceOperationsDatabase; admin: InstanceOperationsDatabase };
  storage: {
    available: boolean;
    attachmentFiles: InstanceOperationsStorageScan | null;
    profileMediaFiles: InstanceOperationsStorageScan | null;
    directoriesOverlap: boolean;
  };
};

export type InstanceLiveResources = {
  sampledAt: string;
  intervalMs: number | null;
  uptimeSeconds: number;
  logicalCores: number;
  appProcessPercent: number | null;
  hostPercent: number | null;
  memory: { residentBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number };
  hostMemory: { totalBytes: number; availableBytes: number };
  loadAverage: [number, number, number];
};

export type StorageMaintenancePreview = {
  complete: boolean;
  blockers: string[];
  candidateFileCount: number;
  candidateBytes: number;
  actionLimit: number;
  minimumFileAgeHours: number;
  retentionDays: number;
  scannedAt: string;
};

export type StorageMaintenanceSummary = {
  quarantinedFileCount: number;
  quarantinedBytes: number;
  purgeableFileCount: number;
  purgeableBytes: number;
  transitioningFileCount: number;
  recoveryRequiredFileCount: number;
  nextPurgeAt: string | null;
  retentionDays: number;
  actionLimit: number;
};

export type StorageMaintenanceActionResult = {
  quarantinedFileCount?: number;
  quarantinedBytes?: number;
  skippedReferencedCount?: number;
  skippedChangedCount?: number;
  skippedManagedCount?: number;
  failedCount?: number;
  remainingCandidateCount?: number;
  restoredFileCount?: number;
  restoredBytes?: number;
  skippedCount?: number;
  remainingCount?: number;
  purgedFileCount?: number;
  purgedBytes?: number;
  remainingEligibleCount?: number;
  retentionDays?: number;
};

export type ServerCustomEmoji = {
  id: string;
  serverId: string;
  encryptedMetadata: string;
  fileUrl: string | null;
  expectedSizeBytes: number;
  sizeBytes: number | null;
  status: "pending" | "uploaded";
  createdAt: string;
  uploadedAt: string | null;
};

export type HistoryBackup = { id: string; revision: string; encryptedKey: string; encryptedExport: string; updatedAt: string };
export type HistoryTransfer = { id: string; deviceId: string; secretHash: string; encryptedPayload: string | null; expiresAt: string };

export type ServerAuditLog = {
  id: string;
  action: string;
  targetId: string | null;
  targetUserId: string | null;
  actor: {
    id: string;
    username: string;
    displayName: string;
  };
  createdAt: string;
};

export type MessageEnvelope = {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  senderUserId: string | null;
  clientMessageId: string;
  serverSequence: string;
  protocol: string;
  ciphertext: string;
  protocolMetadata: string;
  createdAt: string;
};

export type MessagePage = {
  messages: MessageEnvelope[];
  nextBefore: string | null;
  nextAfter: string | null;
};

export type MessagePageOptions = {
  before?: string;
  after?: string;
  limit?: number;
};

export type AttachmentInfo = {
  id: string;
  extension: string;
  mimeType: string;
  expectedSizeBytes: number;
  uploadPath: string;
  createdAt: string;
};

export type Device = {
  id: string;
  name: string;
  identityKey: string;
  signedPrekey: string;
  createdAt: string;
  revokedAt: string | null;
};

export type TwitterPreview = {
  id: string;
  text?: string;
  authorName?: string;
  authorHandle?: string;
  avatarUrl?: string;
  createdAt?: string;
  media: Array<{ type: "image" | "video"; url: string; thumbnailUrl?: string }>;
};

export type GifProviderId = "tenor" | "klipy" | "giphy";
export type GifSearchProviderId = Exclude<GifProviderId, "tenor">;

export type GifProvider = {
  id: GifSearchProviderId;
  apiKey: string;
};

export type GifProviderConfiguration = {
  providers: GifProvider[];
  maxAttachmentBytes: number;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`${code} (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export type UploadOptions = {
  signal?: AbortSignal;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
  contentType?: string;
};

export type DownloadOptions = {
  signal?: AbortSignal;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
};

function jsonHeaders() {
  return { "content-type": "application/json" };
}

export class ApiClient {
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(init.body instanceof FormData ? {} : jsonHeaders()),
        ...init.headers,
      },
    });

    if (!response.ok) {
      let code = "request_failed";
      try {
        const body = await response.json() as { error?: unknown };
        if (typeof body.error === "string") code = body.error;
      } catch {
        // Keep the status-based error when the server did not return JSON.
      }
      throw new ApiError(response.status, code);
    }

    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  get<T>(path: string) {
    return this.request<T>(path);
  }

  historyBackup() { return this.get<{ backup: HistoryBackup | null }>("/v1/crypto/history/backup"); }
  historyRecoveryStatus() { return this.get<{ backup: { id: string; updatedAt: string } | null; deviceCount: number }>("/v1/crypto/history/status"); }
  putHistoryBackup(body: { deviceId: string; id: string; revision: string; encryptedKey: string; encryptedExport: string }) {
    return this.request<{ revision: string }>("/v1/crypto/history/backup", { method: "PUT", body: JSON.stringify(body) });
  }
  deleteHistoryBackup(body: { deviceId: string; id: string; revision: string }) {
    return this.request<{ deleted: boolean }>("/v1/crypto/history/backup", { method: "DELETE", body: JSON.stringify(body) });
  }
  createHistoryTransfer(body: { id: string; deviceId: string; secretHash: string }) {
    return this.post<{ expiresAt: string }>("/v1/crypto/history/transfers", body);
  }
  historyTransfer(id: string) { return this.get<{ transfer: HistoryTransfer }>(`/v1/crypto/history/transfers/${encodeURIComponent(id)}`); }
  approveHistoryTransfer(id: string, body: { deviceId: string; encryptedPayload: string }) {
    return this.request<{ approved: boolean }>(`/v1/crypto/history/transfers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });
  }
  deleteHistoryTransfer(id: string) { return this.delete<{ deleted: boolean }>(`/v1/crypto/history/transfers/${encodeURIComponent(id)}`); }

  post<T>(path: string, body: unknown) {
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  patch<T>(path: string, body: unknown) {
    return this.request<T>(path, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  delete<T>(path: string) {
    return this.request<T>(path, { method: "DELETE" });
  }

  twitterPreview(url: string) {
    return this.post<{ preview: TwitterPreview | null }>("/v1/previews/twitter", { url });
  }

  async putBytes<T = { attachment: { id: string; sizeBytes: number; sha256: string; uploadedAt: string } }>(path: string, bytes: Uint8Array, options: UploadOptions = {}) {
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return await new Promise<T>((resolve, reject) => {
      const request = new XMLHttpRequest();
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        callback();
      };
      const abort = () => request.abort();
      request.open("PUT", path);
      request.withCredentials = true;
      request.setRequestHeader("content-type", options.contentType ?? "application/octet-stream");
      request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
      });
      request.addEventListener("load", () => {
        if (request.status < 200 || request.status >= 300) {
          let code = "upload_failed";
          try {
            const response = JSON.parse(request.responseText) as { error?: unknown };
            if (typeof response.error === "string") code = response.error;
          } catch {
            // Keep the generic upload error.
          }
          finish(() => reject(new ApiError(request.status, code)));
          return;
        }
        try {
          finish(() => resolve(JSON.parse(request.responseText)));
        } catch {
          finish(() => reject(new Error("invalid_upload_response")));
        }
      });
      request.addEventListener("error", () => finish(() => reject(new Error("upload_failed"))));
      request.addEventListener("abort", () => {
        const error = new Error("upload_aborted");
        error.name = "AbortError";
        finish(() => reject(error));
      });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      request.send(body);
    });
  }

  async downloadAttachment(path: string, options: DownloadOptions = {}) {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin || !/^\/v1\/attachments\/[0-9a-f-]{36}$/i.test(url.pathname)) {
      throw new Error("invalid attachment URL");
    }

    const response = await fetch(url, { credentials: "include", signal: options.signal });
    if (!response.ok) throw new ApiError(response.status, "attachment_download_failed");
    const totalBytes = Number(response.headers.get("content-length") ?? 0);
    if (!response.body) return await response.arrayBuffer();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        loadedBytes += value.byteLength;
        chunks.push(value);
        options.onProgress?.(loadedBytes, totalBytes);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(loadedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  }

  register(username: string, password: string, displayName: string) {
    return this.post<{ user: User }>("/v1/auth/register", {
      username,
      password,
      displayName: displayName || undefined,
    });
  }

  login(username: string, password: string) {
    return this.post<{ user: User }>("/v1/auth/login", {
      username,
      password,
    });
  }

  me() {
    return this.get<{ user: User }>("/v1/me");
  }

  updateProfile(displayName: string) {
    return this.patch<{ user: User }>("/v1/me", { displayName });
  }

  async uploadProfileImage(file: File, options: UploadOptions = {}) {
    return this.putBytes<{ user: User }>("/v1/me/avatar", new Uint8Array(await file.arrayBuffer()), {
      ...options,
      contentType: file.type,
    });
  }

  removeProfileImage() {
    return this.delete<{ deleted: boolean }>("/v1/me/avatar");
  }

  async uploadProfileBanner(file: File, options: UploadOptions = {}) {
    return this.putBytes<{ user: User }>("/v1/me/banner", new Uint8Array(await file.arrayBuffer()), {
      ...options,
      contentType: file.type,
    });
  }

  removeProfileBanner() {
    return this.delete<{ deleted: boolean }>("/v1/me/banner");
  }

  updatePassword(currentPassword: string, newPassword: string) {
    return this.post<{ updated: boolean }>("/v1/auth/password", { currentPassword, newPassword });
  }

  devices() {
    return this.get<{ devices: Device[] }>("/v1/devices");
  }

  firebaseMessagingConfig() {
    return this.get<{
      configured: boolean;
      firebaseConfig?: {
        apiKey: string;
        appId: string;
        messagingSenderId: string;
        projectId: string;
        authDomain?: string;
      };
      vapidKey?: string;
    }>("/v1/push/config");
  }

  registerPushToken(token: string) {
    return this.post<{ registered: boolean }>("/v1/push/subscriptions", { token });
  }

  removePushToken(token: string) {
    return this.post<{ removed: boolean }>("/v1/push/subscriptions/remove", { token });
  }

  user(userId: string) {
    return this.get<{ user: User; blockedByMe: boolean }>(`/v1/users/${encodeURIComponent(userId)}`);
  }

  blockedUsers() {
    return this.get<{ users: Array<Pick<User, "id" | "username" | "displayName" | "avatarUrl">> }>("/v1/users/blocked");
  }

  blockUser(userId: string) {
    return this.post<{ blocked: boolean }>(`/v1/users/${encodeURIComponent(userId)}/block`, {});
  }

  unblockUser(userId: string) {
    return this.delete<{ unblocked: boolean }>(`/v1/users/${encodeURIComponent(userId)}/block`);
  }

  reportUser(body: {
    targetUserId: string;
    reason: UserReportReason;
    conversationId?: string;
    messageId?: string;
    encryptedEvidence?: { keyId: string; ciphertext: string; wrappedKey: string; iv: string };
  }) {
    return this.post<{ report: { id: string; submitted: boolean } }>("/v1/reports", body);
  }

  reportPublicKey() {
    return this.get<{ configured: false } | { configured: true; keyId: string; publicKey: string }>("/v1/reports/public-key");
  }

  instanceReports(status: "all" | "open" | "reviewing" | "resolved" | "dismissed" = "open") {
    return this.get<{ reports: InstanceReportSummary[] }>(`/v1/instance-admin/reports?status=${status}`);
  }

  instanceUsers(search: string, field: "username" | "displayName", status: "all" | "active" | "banned", limit: number, cursor?: string) {
    const query = new URLSearchParams({ search, field, status, limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return this.get<{ users: InstanceUserDirectoryEntry[]; limit: number; nextCursor: string | null }>(`/v1/instance-admin/users?${query}`);
  }

  instanceSpaces(status: "all" | "active" | "deactivated", limit: number, cursor?: string) {
    const query = new URLSearchParams({ status, limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return this.get<{ spaces: InstanceSpaceDirectoryEntry[]; limit: number; nextCursor: string | null }>(`/v1/instance-admin/spaces?${query}`);
  }

  setInstanceSpaceActivation(serverId: string, active: boolean, reason: string) {
    return this.patch<{ space: InstanceSpaceDirectoryEntry; changed: boolean }>(`/v1/instance-admin/spaces/${encodeURIComponent(serverId)}/activation`, { active, reason });
  }

  instanceSpaceAudit(serverId: string, limit: number, cursor?: string) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return this.get<{ logs: InstanceSpaceAuditEntry[]; limit: number; nextCursor: string | null }>(`/v1/instance-admin/spaces/${encodeURIComponent(serverId)}/audit?${query}`);
  }

  instanceUser(userId: string) {
    return this.get<InstanceUserModeration>(`/v1/instance-admin/users/${encodeURIComponent(userId)}`);
  }

  adminLogin(username: string, password: string) {
    return this.post<{ operator: AdminIdentity }>("/v1/instance-admin/auth/login", {
      username,
      password,
    });
  }

  adminMe() {
    return this.get<{ operator: AdminIdentity }>("/v1/instance-admin/auth/me");
  }

  adminLogout() {
    return this.post<{ loggedOut: boolean }>("/v1/instance-admin/auth/logout", {});
  }

  adminOperators() {
    return this.get<{ operators: AdminOperator[]; truncated: boolean }>("/v1/instance-admin/operators");
  }

  createAdminOperator(username: string, password: string, role: AdminOperator["role"]) {
    return this.post<{ operator: AdminOperator }>("/v1/instance-admin/operators", { username, password, role });
  }

  updateAdminOperator(operatorId: string, changes: { role?: AdminOperator["role"]; disabled?: boolean }) {
    return this.patch<{ changed: boolean; operator: AdminOperator }>(
      `/v1/instance-admin/operators/${encodeURIComponent(operatorId)}`,
      changes,
    );
  }

  adminOperatorAudit(limit = 50) {
    return this.get<{ logs: AdminOperatorAuditEntry[] }>(`/v1/instance-admin/operators/audit?limit=${limit}`);
  }

  instanceReport(reportId: string) {
    return this.get<{ report: InstanceReport }>(`/v1/instance-admin/reports/${encodeURIComponent(reportId)}`);
  }

  updateInstanceReport(reportId: string, status: InstanceReport["status"]) {
    return this.patch<{ updated: boolean }>(`/v1/instance-admin/reports/${encodeURIComponent(reportId)}`, { status });
  }

  removeReportedMessage(reportId: string) {
    return this.post<{ removed: boolean }>(`/v1/instance-admin/reports/${encodeURIComponent(reportId)}/remove-message`, {});
  }

  auditReportEvidence(reportId: string) {
    return this.post<{ audited: boolean }>(`/v1/instance-admin/reports/${encodeURIComponent(reportId)}/evidence-access`, {});
  }

  suspendInstanceUser(userId: string, reportId?: string) {
    return this.post<{ suspended: boolean }>(`/v1/instance-admin/users/${encodeURIComponent(userId)}/suspend`, { ...(reportId ? { reportId } : {}) });
  }

  banInstanceUser(userId: string, reason: string) {
    return this.post<{ suspended: boolean }>(`/v1/instance-admin/users/${encodeURIComponent(userId)}/suspend`, { reason });
  }

  timeoutInstanceUser(userId: string, reason: string, durationSeconds: number) {
    return this.post<{ timeout: { id: string; createdAt: string; expiresAt: string }; replaced: boolean }>(
      `/v1/instance-admin/users/${encodeURIComponent(userId)}/timeout`,
      { reason, durationSeconds },
    );
  }

  removeInstanceUserTimeout(userId: string) {
    return this.delete<{ removed: boolean }>(`/v1/instance-admin/users/${encodeURIComponent(userId)}/timeout`);
  }

  restoreInstanceUser(userId: string) {
    return this.delete<{ restored: boolean }>(`/v1/instance-admin/users/${encodeURIComponent(userId)}/suspension`);
  }

  warnInstanceUser(userId: string, reason: string, expiresInSeconds?: number) {
    return this.post<{ warning: { id: string; createdAt: string; expiresAt: string | null } }>(
      `/v1/instance-admin/users/${encodeURIComponent(userId)}/warnings`,
      { reason, ...(expiresInSeconds ? { expiresInSeconds } : {}) },
    );
  }

  revokeInstanceWarning(warningId: string) {
    return this.delete<{ revoked: boolean }>(`/v1/instance-admin/warnings/${encodeURIComponent(warningId)}`);
  }

  instanceReportKeys() {
    return this.get<{ keys: Array<{ id: string; active: boolean; createdAt: string }> }>("/v1/instance-admin/report-keys");
  }

  createInstanceReportKey(keyId: string, publicKey: string) {
    return this.post<{ key: { id: string; createdAt: string } }>("/v1/instance-admin/report-keys", { keyId, publicKey });
  }

  instanceAdminAudit() {
    return this.get<{ logs: Array<{
      id: string;
      adminUserId: string;
      adminUsername: string;
      adminDisplayName: string;
      action: string;
      details: Record<string, unknown>;
      reportId: string | null;
      targetUserId: string | null;
      createdAt: string;
    }> }>("/v1/instance-admin/audit?limit=200");
  }

  myInstanceWarnings() {
    return this.get<{ warnings: ModerationWarningNotice[] }>("/v1/me/instance-warnings");
  }

  mySpaceWarnings() {
    return this.get<{ warnings: SpaceWarningNotice[] }>("/v1/me/server-warnings");
  }

  acknowledgeInstanceWarning(warningId: string) {
    return this.patch<{ acknowledged: boolean }>(`/v1/me/instance-warnings/${encodeURIComponent(warningId)}/acknowledge`, {});
  }

  acknowledgeSpaceWarning(warningId: string) {
    return this.patch<{ acknowledged: boolean }>(`/v1/me/server-warnings/${encodeURIComponent(warningId)}/acknowledge`, {});
  }

  instanceOperations() {
    return this.get<InstanceOperationsSnapshot>("/v1/instance-admin/operations");
  }

  instanceOperationsOverview() {
    return this.get<InstanceOperationsOverview>("/v1/instance-admin/operations/overview");
  }

  instanceLiveResources() {
    return this.get<InstanceLiveResources>("/v1/instance-admin/operations/live");
  }

  storageMaintenanceSummary() {
    return this.get<StorageMaintenanceSummary>("/v1/instance-admin/maintenance/summary");
  }

  inspectStorageMaintenance() {
    return this.post<StorageMaintenancePreview>("/v1/instance-admin/maintenance/preview", {});
  }

  quarantineOrphanedStorage() {
    return this.post<StorageMaintenanceActionResult>("/v1/instance-admin/maintenance/quarantine", {});
  }

  restoreQuarantinedStorage() {
    return this.post<StorageMaintenanceActionResult>("/v1/instance-admin/maintenance/restore", {});
  }

  purgeExpiredQuarantinedStorage() {
    return this.post<StorageMaintenanceActionResult>("/v1/instance-admin/maintenance/purge", {});
  }

  revokeDevice(deviceId: string) {
    return this.post<{ revoked: boolean }>(`/v1/devices/${deviceId}/revoke`, {});
  }

  logout() {
    return this.post<{ loggedOut: boolean }>("/v1/auth/logout", {});
  }

  conversations() {
    return this.get<{ conversations: Conversation[] }>("/v1/conversations");
  }

  voiceToken(conversationId: string, callId: string) {
    return this.post<{ url: string; token: string }>("/v1/voice/token", { conversationId, callId });
  }

  voiceCallAuthorized(conversationId: string, callId: string) {
    return this.post<{ authorized: boolean }>("/v1/voice/check", { conversationId, callId });
  }

  voiceRoomToken(channelId: string) {
    return this.post<{ url: string; token: string; canStart: boolean }>("/v1/voice/room-token", { channelId });
  }

  voiceRoomAuthorized(channelId: string) {
    return this.post<{ authorized: boolean }>("/v1/voice/room-check", { channelId });
  }

  servers() {
    return this.get<{ servers: Server[] }>("/v1/servers");
  }

  server(serverId: string) {
    return this.get<{ server: Server }>(`/v1/servers/${serverId}`);
  }

  serverChannels(serverId: string) {
    return this.get<{ channels: ServerChannel[] }>(`/v1/servers/${serverId}/channels`);
  }

  serverMembers(serverId: string) {
    return this.get<{ members: ServerMember[] }>(`/v1/servers/${serverId}/members`);
  }

  serverRoles(serverId: string) {
    return this.get<{
      metadataConversationId: string | null;
      permissions: ServerPermissionMap;
      roles: CustomServerRole[];
      assignments: ServerRoleAssignment[];
    }>(`/v1/servers/${serverId}/roles`);
  }

  createServerRole(serverId: string, body: {
    encryptedMetadata?: string;
    color?: string;
    position?: number;
    permissions?: Partial<ServerPermissionMap>;
    mentionable?: boolean;
    separateMembers?: boolean;
    viewAllChannels?: boolean;
  }) {
    return this.post<{ role: CustomServerRole }>(`/v1/servers/${serverId}/roles`, body);
  }

  updateServerRole(serverId: string, roleId: string, body: {
    encryptedMetadata?: string;
    color?: string;
    position?: number;
    permissions?: Partial<ServerPermissionMap>;
    mentionable?: boolean;
    separateMembers?: boolean;
    viewAllChannels?: boolean;
  }) {
    return this.patch<{ role: CustomServerRole }>(`/v1/servers/${serverId}/roles/${roleId}`, body);
  }

  deleteServerRole(serverId: string, roleId: string) {
    return this.delete<{ deleted: boolean }>(`/v1/servers/${serverId}/roles/${roleId}`);
  }

  updateServerRoleChannelAccess(serverId: string, roleId: string, channelId: string, canView: boolean, canUpload: boolean) {
    return this.patch<{ updated: boolean; canView: boolean; canUpload: boolean }>(
      `/v1/servers/${serverId}/roles/${roleId}/channels/${channelId}`,
      { canView, canUpload },
    );
  }

  removeServerRoleChannelAccess(serverId: string, roleId: string, channelId: string) {
    return this.delete<{ deleted: boolean }>(`/v1/servers/${serverId}/roles/${roleId}/channels/${channelId}`);
  }

  updateServerRoleCategoryAccess(serverId: string, roleId: string, categoryId: string, canView: boolean, canUpload: boolean) {
    return this.patch<{ updated: boolean; canView: boolean; canUpload: boolean }>(
      `/v1/servers/${serverId}/roles/${roleId}/categories/${categoryId}`,
      { canView, canUpload },
    );
  }

  removeServerRoleCategoryAccess(serverId: string, roleId: string, categoryId: string) {
    return this.delete<{ deleted: boolean }>(`/v1/servers/${serverId}/roles/${roleId}/categories/${categoryId}`);
  }

  updateServerMemberRoles(serverId: string, userId: string, roleIds: string[]) {
    return this.patch<{ updated: boolean; roleIds: string[] }>(`/v1/servers/${serverId}/members/${userId}/roles`, { roleIds });
  }

  serverModeration(serverId: string) {
    return this.get<ServerModeration>(`/v1/servers/${serverId}/moderation`);
  }

  warnServerMember(serverId: string, userId: string, reason: string, expiresInSeconds?: number) {
    return this.post<{ warning: { id: string; createdAt: string; expiresAt: string | null } }>(
      `/v1/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/warnings`,
      { reason, ...(expiresInSeconds ? { expiresInSeconds } : {}) },
    );
  }

  revokeServerWarning(serverId: string, warningId: string) {
    return this.delete<{ revoked: boolean }>(`/v1/servers/${encodeURIComponent(serverId)}/warnings/${encodeURIComponent(warningId)}`);
  }

  banServerMember(serverId: string, userId: string, options: { reason?: string; expiresInSeconds?: number } = {}) {
    return this.post<{ banned: boolean }>(`/v1/servers/${serverId}/members/${userId}/ban`, options);
  }

  unbanServerMember(serverId: string, userId: string) {
    return this.delete<{ revoked: boolean }>(`/v1/servers/${serverId}/bans/${userId}`);
  }

  timeoutServerMember(serverId: string, userId: string, durationSeconds: number, reason?: string) {
    return this.post<{ timedOut: boolean; expiresAt: string }>(`/v1/servers/${serverId}/members/${userId}/timeout`, {
      durationSeconds,
      ...(reason ? { reason } : {}),
    });
  }

  removeServerMemberTimeout(serverId: string, userId: string) {
    return this.delete<{ revoked: boolean }>(`/v1/servers/${serverId}/timeouts/${userId}`);
  }

  createServer(encryptedMetadata = "") {
    return this.post<{ server: Server; channel: ServerChannel }>("/v1/servers", { encryptedMetadata });
  }

  updateServer(serverId: string, encryptedMetadata: string) {
    return this.patch<{ server: Server }>(`/v1/servers/${serverId}`, { encryptedMetadata });
  }

  updateServerSettings(serverId: string, body: {
    encryptedMetadata?: string;
    onboardingChannelId?: string | null;
    landingChannelId?: string | null;
  }) {
    return this.patch<{ server: Server }>(`/v1/servers/${serverId}`, body);
  }

  async uploadServerBranding(serverId: string, asset: "icon" | "banner", file: File, options: UploadOptions = {}) {
    return this.putBytes<{ url: string }>(`/v1/servers/${serverId}/branding/${asset}`, new Uint8Array(await file.arrayBuffer()), {
      ...options,
      contentType: file.type,
    });
  }

  removeServerBranding(serverId: string, asset: "icon" | "banner") {
    return this.delete<{ deleted: boolean }>(`/v1/servers/${serverId}/branding/${asset}`);
  }

  serverCustomEmojis(serverId: string) {
    return this.get<{ emojis: ServerCustomEmoji[] }>(`/v1/servers/${serverId}/emojis`);
  }

  createServerCustomEmoji(serverId: string, body: { encryptedMetadata: string; expectedSizeBytes: number }) {
    return this.post<{ emoji: ServerCustomEmoji & { uploadPath: string } }>(`/v1/servers/${serverId}/emojis`, body);
  }

  uploadServerCustomEmoji(serverId: string, emojiId: string, bytes: Uint8Array, options: UploadOptions = {}) {
    return this.putBytes<{ emoji: ServerCustomEmoji }>(`/v1/servers/${serverId}/emojis/${emojiId}/file`, bytes, options);
  }

  removeServerCustomEmoji(serverId: string, emojiId: string) {
    return this.delete<{ deleted: boolean }>(`/v1/servers/${serverId}/emojis/${emojiId}`);
  }

  updateServerCustomEmoji(serverId: string, emojiId: string, encryptedMetadata: string) {
    return this.patch<{ updated: boolean }>(`/v1/servers/${serverId}/emojis/${emojiId}`, { encryptedMetadata });
  }

  serverAuditLogs(serverId: string, limit = 100) {
    return this.get<{ logs: ServerAuditLog[] }>(`/v1/servers/${serverId}/audit-logs?limit=${Math.min(100, Math.max(1, limit))}`);
  }

  deleteServer(serverId: string) {
    return this.delete<{ deleted: boolean }>(`/v1/servers/${serverId}`);
  }

  createChannel(serverId: string, encryptedMetadata = "", categoryId: string | null = null, kind: ServerChannel["kind"] = "text") {
    return this.post<{ channel: ServerChannel }>(`/v1/servers/${serverId}/channels`, { encryptedMetadata, categoryId, kind });
  }

  updateChannel(serverId: string, channelId: string, changes: { encryptedMetadata?: string; position?: number; categoryId?: string | null }) {
    return this.patch<{ channel: ServerChannel }>(`/v1/servers/${serverId}/channels/${channelId}`, changes);
  }

  deleteChannel(serverId: string, channelId: string) {
    return this.delete<{ archived: boolean }>(`/v1/servers/${serverId}/channels/${channelId}`);
  }

  serverCategories(serverId: string) {
    return this.get<{ categories: ServerCategory[] }>(`/v1/servers/${serverId}/categories`);
  }

  createCategory(serverId: string, encryptedMetadata = "", position?: number) {
    return this.post<{ category: ServerCategory }>(`/v1/servers/${serverId}/categories`, {
      encryptedMetadata,
      ...(position === undefined ? {} : { position }),
    });
  }

  updateCategory(serverId: string, categoryId: string, changes: { encryptedMetadata?: string; position?: number }) {
    return this.patch<{ category: ServerCategory }>(`/v1/servers/${serverId}/categories/${categoryId}`, changes);
  }

  deleteCategory(serverId: string, categoryId: string) {
    return this.delete<{ archived: boolean }>(`/v1/servers/${serverId}/categories/${categoryId}`);
  }

  createServerInvite(serverId: string, options: { maxUses?: number; expiresInSeconds?: number } = {}) {
    return this.post<{ invite: { id: string; token: string; maxUses: number; expiresAt: string | null } }>(
      `/v1/servers/${serverId}/invites`,
      options,
    );
  }

  serverInvites(serverId: string) {
    return this.get<{ invites: Array<{
      id: string;
      maxUses: number;
      uses: number;
      expiresAt: string | null;
      revokedAt: string | null;
      createdAt: string;
    }> }>(`/v1/servers/${serverId}/invites`);
  }

  revokeServerInvite(serverId: string, inviteId: string) {
    return this.delete<{ revoked: boolean }>(`/v1/servers/${serverId}/invites/${inviteId}`);
  }

  acceptInvite(token: string) {
    return this.post<{ serverId: string; onboardingChannelId: string | null; joined: boolean }>(`/v1/invites/${encodeURIComponent(token)}/accept`, {});
  }

  leaveServer(serverId: string) {
    return this.post<{ left: boolean }>(`/v1/servers/${serverId}/leave`, {});
  }

  removeServerMember(serverId: string, userId: string) {
    return this.delete<{ removed: boolean }>(`/v1/servers/${serverId}/members/${userId}`);
  }

  updateServerMemberRole(serverId: string, userId: string, role: "admin" | "member") {
    return this.patch<{ updated: boolean; role: "admin" | "member" }>(`/v1/servers/${serverId}/members/${userId}`, { role });
  }

  conversationMembers(conversationId: string) {
    return this.get<{ members: ConversationMember[] }>(`/v1/conversations/${conversationId}/members`);
  }

  createConversation(kind: "dm" | "group", memberUserIds: string[]) {
    return this.post<{ conversation: { id: string } }>("/v1/conversations", {
      kind,
      memberUserIds,
    });
  }

  deleteConversation(conversationId: string) {
    return this.delete<{ deleted: boolean }>(`/v1/conversations/${conversationId}`);
  }

  messages(conversationId: string, options: MessagePageOptions = {}) {
    const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.before) params.set("before", options.before);
    if (options.after) params.set("after", options.after);
    return this.get<MessagePage>(
      `/v1/conversations/${conversationId}/messages?${params.toString()}`,
    );
  }

  sendMessage(conversationId: string, message: {
    senderDeviceId: string;
    clientMessageId: string;
    protocol: string;
    ciphertext: string;
    protocolMetadata?: string;
    attachmentId?: string;
    attachmentIds?: string[];
  }) {
    return this.post<{ message: MessageEnvelope; deduplicated: boolean }>(
      `/v1/conversations/${conversationId}/messages`,
      message,
    );
  }

  deleteMessage(conversationId: string, messageId: string) {
    return this.delete<{ deleted: boolean }>(`/v1/conversations/${conversationId}/messages/${messageId}`);
  }

  createAttachment(conversationId: string, expectedSizeBytes: number, extension: string, mimeType: string) {
    return this.post<{ attachment: AttachmentInfo }>(
      `/v1/conversations/${conversationId}/attachments`,
      { expectedSizeBytes, extension, mimeType },
    );
  }

  cryptoRequest<T>(path: string, body: unknown) {
    return this.post<T>(path, body);
  }

  toDevice(deviceId: string) {
    return this.get<{
      events: Array<{
        eventId: string;
        type: string;
        sender: string;
        content: Record<string, unknown>;
      }>;
      device_lists: { changed: string[]; left: string[] };
      one_time_keys_count: Record<string, number>;
      unused_fallback_key_types?: string[];
    }>(`/v1/crypto/to-device?deviceId=${encodeURIComponent(deviceId)}`);
  }

  acknowledgeToDevice(deviceId: string, eventIds: string[]) {
    return this.post<{ acknowledged: number }>("/v1/crypto/to-device/ack", {
      deviceId,
      eventIds,
    });
  }
}
