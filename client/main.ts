import { ApiError, ApiClient, type Conversation, type ConversationMember, type MessageEnvelope, type User } from "./api";
import { CryptoClient } from "./crypto";
import { appendSafeEmbed, extractEmbeds } from "./embeds";

const api = new ApiClient();
let currentUser: User | undefined;
let cryptoClient: CryptoClient | undefined;
let selectedConversationId: string | undefined;
let selectedMembers: ConversationMember[] = [];
let realtime: WebSocket | undefined;
let messagesLoading = false;

function byId<T extends HTMLElement>(id: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element: ${id}`);
  return element as T;
}

const authPanel = byId<HTMLElement>("auth-panel");
const chatPanel = byId<HTMLElement>("chat-panel");
const authForm = byId<HTMLFormElement>("auth-form");
const authMode = byId<HTMLSelectElement>("auth-mode");
const authUsername = byId<HTMLInputElement>("auth-username");
const authPassword = byId<HTMLInputElement>("auth-password");
const authDisplayName = byId<HTMLInputElement>("auth-display-name");
const localPassphrase = byId<HTMLInputElement>("local-passphrase");
const authSubmit = byId<HTMLButtonElement>("auth-submit");
const statusLine = byId<HTMLElement>("status-line");
const userLabel = byId<HTMLElement>("user-label");
const conversationList = byId<HTMLElement>("conversation-list");
const conversationTitle = byId<HTMLElement>("conversation-title");
const messagesPanel = byId<HTMLElement>("messages");
const composer = byId<HTMLFormElement>("composer");
const messageInput = byId<HTMLTextAreaElement>("message-input");
const photoInput = byId<HTMLInputElement>("photo-input");
const newConversationForm = byId<HTMLFormElement>("new-conversation-form");
const newMemberInput = byId<HTMLInputElement>("new-member-id");
const logoutButton = byId<HTMLButtonElement>("logout-button");

function setStatus(message: string, error = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", error);
}

function showAuth(unlock = false) {
  authPanel.hidden = false;
  chatPanel.hidden = true;
  authUsername.closest("label")?.toggleAttribute("hidden", unlock);
  authPassword.closest("label")?.toggleAttribute("hidden", unlock);
  authDisplayName.closest("label")?.toggleAttribute("hidden", unlock || authMode.value !== "register");
  authMode.closest("label")?.toggleAttribute("hidden", unlock);
  authSubmit.textContent = unlock ? "Unlock encrypted chat" : authMode.value === "register" ? "Create account" : "Sign in";
}

function showChat() {
  authPanel.hidden = true;
  chatPanel.hidden = false;
  userLabel.textContent = currentUser ? `${currentUser.displayName} (@${currentUser.username})` : "";
}

function readableError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "invalid_credentials") return "The username or password is incorrect.";
    if (error.code === "username_taken") return "That username is already in use.";
    return error.code;
  }
  return error instanceof Error ? error.message : "request_failed";
}

async function startCrypto() {
  if (!currentUser) throw new Error("not_authenticated");
  cryptoClient?.close();
  cryptoClient = new CryptoClient(api, currentUser.id, localPassphrase.value);
  await cryptoClient.initialize();
  showChat();
  await refreshConversations();
  connectRealtime();
  setStatus("Encrypted chat is ready.");
}

function connectRealtime() {
  realtime?.close();
  const url = new URL("/v1/realtime", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  realtime = new WebSocket(url);
  realtime.addEventListener("open", () => {
    if (selectedConversationId) subscribeRealtime(selectedConversationId);
  });
  realtime.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data) as { type?: string; conversationId?: string };
      if (payload.type === "message.created" && payload.conversationId === selectedConversationId) {
        void refreshMessages();
      }
    } catch {
      // Ignore malformed realtime notifications; history remains authoritative.
    }
  });
  realtime.addEventListener("close", () => {
    if (cryptoClient) window.setTimeout(connectRealtime, 1500);
  });
}

function subscribeRealtime(conversationId: string) {
  if (realtime?.readyState === WebSocket.OPEN) {
    realtime.send(JSON.stringify({ type: "subscribe", conversationId }));
  }
}

function renderConversations(conversations: Conversation[]) {
  conversationList.replaceChildren();
  if (conversations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No conversations yet.";
    conversationList.append(empty);
    return;
  }

  for (const conversation of conversations) {
    const button = document.createElement("button");
    button.className = "conversation-item";
    button.classList.toggle("selected", conversation.id === selectedConversationId);
    button.type = "button";
    button.textContent = `${conversation.kind === "dm" ? "Direct message" : "Group"} · ${conversation.id.slice(0, 8)}`;
    button.addEventListener("click", () => void selectConversation(conversation.id));
    conversationList.append(button);
  }
}

async function refreshConversations() {
  const result = await api.conversations();
  renderConversations(result.conversations);
  if (!selectedConversationId && result.conversations[0]) await selectConversation(result.conversations[0].id);
}

async function selectConversation(conversationId: string) {
  if (!cryptoClient) return;
  selectedConversationId = conversationId;
  conversationTitle.textContent = `Conversation ${conversationId.slice(0, 8)}`;
  subscribeRealtime(conversationId);
  const members = await api.conversationMembers(conversationId);
  selectedMembers = members.members;
  await cryptoClient.prepareConversation(conversationId, selectedMembers);
  renderConversations((await api.conversations()).conversations);
  await refreshMessages();
}

function renderMessage(message: MessageEnvelope, decrypted: { sender: string; content: Record<string, unknown> } | null, error?: string) {
  const article = document.createElement("article");
  article.className = "message";
  const header = document.createElement("header");
  header.textContent = `${decrypted?.sender ?? message.senderUserId ?? "unknown device"} · ${new Date(message.createdAt).toLocaleString()}`;
  article.append(header);

  if (!decrypted) {
    const failed = document.createElement("p");
    failed.className = "muted";
    failed.textContent = error ? `Unable to decrypt (${error}).` : "Unable to decrypt this message.";
    article.append(failed);
    messagesPanel.append(article);
    return;
  }

  const content = decrypted.content;
  const body = typeof content.body === "string" ? content.body : "";
  if (content.msgtype === "m.text" || content.msgtype === "m.notice" || body) {
    const text = document.createElement("p");
    text.className = "message-body";
    text.textContent = body;
    article.append(text);
    for (const embed of extractEmbeds(body)) appendSafeEmbed(article, embed);
  }

  if (content.msgtype === "m.image") {
    const photoButton = document.createElement("button");
    photoButton.type = "button";
    photoButton.textContent = `Load encrypted photo${body ? ` · ${body}` : ""}`;
    photoButton.addEventListener("click", async () => {
      photoButton.disabled = true;
      try {
        const blob = await cryptoClient?.decryptPhoto(content);
        if (!blob) throw new Error("crypto_not_initialized");
        const image = document.createElement("img");
        image.className = "photo-preview";
        image.alt = body || "Encrypted photo";
        image.src = URL.createObjectURL(blob);
        photoButton.replaceWith(image);
      } catch (loadError) {
        photoButton.disabled = false;
        photoButton.textContent = `Photo unavailable: ${readableError(loadError)}`;
      }
    });
    article.append(photoButton);
  }

  messagesPanel.append(article);
}

async function refreshMessages() {
  if (!selectedConversationId || !cryptoClient || messagesLoading) return;
  messagesLoading = true;
  try {
    await cryptoClient.syncToDevice();
    const result = await api.messages(selectedConversationId);
    messagesPanel.replaceChildren();
    for (const message of result.messages) {
      try {
        const decrypted = await cryptoClient.decryptMessage(selectedConversationId, message);
        renderMessage(message, decrypted);
      } catch (error) {
        renderMessage(message, null, readableError(error));
      }
    }
    messagesPanel.scrollTop = messagesPanel.scrollHeight;
  } finally {
    messagesLoading = false;
  }
}

authMode.addEventListener("change", () => showAuth(false));
authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authSubmit.disabled = true;
  setStatus("Working…");
  try {
    if (currentUser) {
      await startCrypto();
    } else {
      const result = authMode.value === "register"
        ? await api.register(authUsername.value.trim(), authPassword.value, authDisplayName.value.trim())
        : await api.login(authUsername.value.trim(), authPassword.value);
      currentUser = result.user;
      await startCrypto();
    }
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    authSubmit.disabled = false;
  }
});

newConversationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) return;
  try {
    const memberIds = newMemberInput.value.split(",").map((id) => id.trim()).filter(Boolean);
    if (memberIds.length === 0) throw new Error("enter at least one member UUID");
    await api.createConversation(memberIds.length === 1 ? "dm" : "group", memberIds);
    newMemberInput.value = "";
    await refreshConversations();
    setStatus("Conversation created.");
  } catch (error) {
    setStatus(readableError(error), true);
  }
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedConversationId || !cryptoClient) return;
  const text = messageInput.value.trim();
  const file = photoInput.files?.[0];
  if (!text && !file) return;
  const sendButton = composer.querySelector("button[type=submit]") as HTMLButtonElement | null;
  if (sendButton) sendButton.disabled = true;
  try {
    if (text) await cryptoClient.sendText(selectedConversationId, selectedMembers, text, extractEmbeds(text));
    if (file) await cryptoClient.sendPhoto(selectedConversationId, selectedMembers, file);
    messageInput.value = "";
    photoInput.value = "";
    await refreshMessages();
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    if (sendButton) sendButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  realtime?.close();
  realtime = undefined;
  cryptoClient?.close();
  cryptoClient = undefined;
  currentUser = undefined;
  selectedConversationId = undefined;
  selectedMembers = [];
  try {
    await api.logout();
  } catch {
    // The local client is reset even if the session was already gone.
  }
  showAuth(false);
  setStatus("Signed out.");
});

async function boot() {
  try {
    currentUser = (await api.me()).user;
    showAuth(true);
    setStatus("Enter your local encryption passphrase to unlock this browser.");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) setStatus(readableError(error), true);
    showAuth(false);
  }

  window.setInterval(() => {
    if (cryptoClient) void cryptoClient.syncToDevice().then(() => refreshMessages()).catch(() => undefined);
  }, 2000);
}

void boot();
