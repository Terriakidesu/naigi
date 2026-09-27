export type User = {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
};

export type Conversation = {
  id: string;
  kind: "dm" | "group";
  encryptedMetadata: string;
  memberDisplayNames: string[];
  createdAt: string;
};

export type ServerRole = "owner" | "admin" | "member";

export type Server = {
  id: string;
  ownerId: string;
  encryptedMetadata: string;
  role: ServerRole;
  channelCount: number;
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
  role: ServerRole;
  joinedAt: string;
};

export type ConversationMember = {
  userId: string;
  matrixUserId: string;
  username: string;
  displayName: string;
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

  async putBytes(path: string, bytes: Uint8Array, options: UploadOptions = {}) {
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return await new Promise<{
      attachment: { id: string; sizeBytes: number; sha256: string; uploadedAt: string };
    }>((resolve, reject) => {
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
      request.setRequestHeader("content-type", "application/octet-stream");
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

  createServer(encryptedMetadata = "") {
    return this.post<{ server: Server; channel: ServerChannel }>("/v1/servers", { encryptedMetadata });
  }

  updateServer(serverId: string, encryptedMetadata: string) {
    return this.patch<{ server: Server }>(`/v1/servers/${serverId}`, { encryptedMetadata });
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
    return this.post<{ serverId: string; joined: boolean }>(`/v1/invites/${encodeURIComponent(token)}/accept`, {});
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
  }) {
    return this.post<{ message: MessageEnvelope; deduplicated: boolean }>(
      `/v1/conversations/${conversationId}/messages`,
      message,
    );
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
