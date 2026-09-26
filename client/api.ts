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
  createdAt: string;
};

export type ConversationMember = {
  userId: string;
  matrixUserId: string;
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

export type AttachmentInfo = {
  id: string;
  extension: string;
  mimeType: string;
  expectedSizeBytes: number;
  uploadPath: string;
  createdAt: string;
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

  async putBytes(path: string, bytes: Uint8Array) {
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const response = await fetch(path, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
    if (!response.ok) {
      let code = "upload_failed";
      try {
        const body = await response.json() as { error?: unknown };
        if (typeof body.error === "string") code = body.error;
      } catch {
        // Keep the generic upload error.
      }
      throw new ApiError(response.status, code);
    }
    return await response.json() as {
      attachment: { id: string; sizeBytes: number; sha256: string; uploadedAt: string };
    };
  }

  async downloadAttachment(path: string) {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin || !/^\/v1\/attachments\/[0-9a-f-]{36}$/i.test(url.pathname)) {
      throw new Error("invalid attachment URL");
    }

    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new ApiError(response.status, "attachment_download_failed");
    return await response.arrayBuffer();
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

  logout() {
    return this.post<{ loggedOut: boolean }>("/v1/auth/logout", {});
  }

  conversations() {
    return this.get<{ conversations: Conversation[] }>("/v1/conversations");
  }

  conversationMembers(conversationId: string) {
    return this.get<{ members: ConversationMember[] }>(`/v1/conversations/${conversationId}/members`);
  }

  createConversation(kind: "dm" | "group", memberUserIds: string[]) {
    return this.post<{ conversation: Conversation }>("/v1/conversations", {
      kind,
      memberUserIds,
    });
  }

  messages(conversationId: string, before?: string) {
    const params = new URLSearchParams({ limit: "100" });
    if (before) params.set("before", before);
    return this.get<{ messages: MessageEnvelope[]; nextBefore: string | null }>(
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
