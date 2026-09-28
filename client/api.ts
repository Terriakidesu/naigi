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
  createdAt: string;
};

export type ServerChannel = {
  id: string;
  serverId: string;
  conversationId: string;
  encryptedMetadata: string;
  categoryId: string | null;
  kind: "text";
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

  user(userId: string) {
    return this.get<{ user: User }>(`/v1/users/${encodeURIComponent(userId)}`);
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

  serverAuditLogs(serverId: string, limit = 100) {
    return this.get<{ logs: ServerAuditLog[] }>(`/v1/servers/${serverId}/audit-logs?limit=${Math.min(100, Math.max(1, limit))}`);
  }

  deleteServer(serverId: string) {
    return this.delete<{ deleted: boolean }>(`/v1/servers/${serverId}`);
  }

  createChannel(serverId: string, encryptedMetadata = "", categoryId: string | null = null) {
    return this.post<{ channel: ServerChannel }>(`/v1/servers/${serverId}/channels`, { encryptedMetadata, categoryId });
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
