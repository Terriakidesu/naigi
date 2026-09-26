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

const statusLine = byId<HTMLElement>("status-line");
const userLabel = byId<HTMLElement>("user-label");
const conversationList = byId<HTMLElement>("conversation-list");
const conversationTitle = byId<HTMLElement>("conversation-title");
const messagesPanel = byId<HTMLElement>("messages");
const memberList = byId<HTMLElement>("member-list");
const composer = byId<HTMLFormElement>("composer");
const messageInput = byId<HTMLTextAreaElement>("message-input");
const photoInput = byId<HTMLInputElement>("photo-input");

function setStatus(message: string, error = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", error);
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
  const localPassphrase = sessionStorage.getItem("priv-chat.local-passphrase");
  if (!localPassphrase) {
    window.location.assign("/unlock");
    return;
  }
  sessionStorage.removeItem("priv-chat.local-passphrase");
  cryptoClient?.close();
  cryptoClient = new CryptoClient(api, currentUser.id, localPassphrase);
  await cryptoClient.initialize();
  userLabel.textContent = `${currentUser.displayName} (@${currentUser.username})`;
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
    const icon = document.createElement("span");
    icon.className = "conversation-icon";
    icon.textContent = conversation.kind === "dm" ? "#" : "⋯";
    const copy = document.createElement("span");
    copy.className = "conversation-copy";
    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = conversation.kind === "dm" ? "Direct message" : "Group conversation";
    const conversationStatus = document.createElement("span");
    conversationStatus.className = "conversation-status";
    conversationStatus.textContent = `encrypted · ${conversation.id.slice(0, 8)}`;
    copy.append(title, conversationStatus);
    button.append(icon, copy);
    button.addEventListener("click", () => void selectConversation(conversation.id));
    conversationList.append(button);
  }
}

async function refreshConversations() {
  const result = await api.conversations();
  renderConversations(result.conversations);
  const requested = new URLSearchParams(window.location.search).get("conversation");
  const requestedConversation = requested && result.conversations.find((conversation) => conversation.id === requested);
  if (!selectedConversationId && requestedConversation) await selectConversation(requestedConversation.id);
  else if (!selectedConversationId && result.conversations[0]) await selectConversation(result.conversations[0].id);
}

function renderMembers(members: ConversationMember[]) {
  memberList.replaceChildren();
  for (const member of members) {
    const row = document.createElement("div");
    row.className = "member-row";
    const avatar = document.createElement("span");
    avatar.className = "member-avatar";
    avatar.textContent = member.userId.slice(0, 1).toUpperCase();
    const copy = document.createElement("div");
    copy.className = "member-copy";
    const name = document.createElement("strong");
    name.textContent = member.userId === currentUser?.id ? "You" : `Member ${member.userId.slice(0, 8)}`;
    const identity = document.createElement("span");
    identity.textContent = "E2EE device keys active";
    copy.append(name, identity);
    row.append(avatar, copy);
    memberList.append(row);
  }
}

async function selectConversation(conversationId: string) {
  if (!cryptoClient) return;
  selectedConversationId = conversationId;
  conversationTitle.textContent = `Conversation ${conversationId.slice(0, 8)}`;
  subscribeRealtime(conversationId);
  const members = await api.conversationMembers(conversationId);
  selectedMembers = members.members;
  renderMembers(selectedMembers);
  await cryptoClient.prepareConversation(conversationId, selectedMembers);
  renderConversations((await api.conversations()).conversations);
  await refreshMessages();
}

function renderMessage(message: MessageEnvelope, decrypted: { sender: string; content: Record<string, unknown> } | null, error?: string) {
  const article = document.createElement("article");
  article.className = "message";
  const senderIdentity = decrypted?.sender ?? message.senderUserId ?? "unknown device";
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = senderIdentity.replace(/^@/, "").slice(0, 1).toUpperCase();
  const messageContent = document.createElement("div");
  messageContent.className = "message-content";
  const header = document.createElement("header");
  header.textContent = `${senderIdentity} · ${new Date(message.createdAt).toLocaleString()}`;
  messageContent.append(header);
  article.append(avatar, messageContent);

  if (!decrypted) {
    const failed = document.createElement("p");
    failed.className = "muted";
    failed.textContent = error ? `Unable to decrypt (${error}).` : "Unable to decrypt this message.";
    messageContent.append(failed);
    messagesPanel.append(article);
    return;
  }

  const content = decrypted.content;
  const body = typeof content.body === "string" ? content.body : "";
  if (content.msgtype === "m.text" || content.msgtype === "m.notice" || body) {
    const text = document.createElement("p");
    text.className = "message-body";
    text.textContent = body;
    messageContent.append(text);
    for (const embed of extractEmbeds(body)) appendSafeEmbed(messageContent, embed);
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
    messageContent.append(photoButton);
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

async function boot() {
  try {
    currentUser = (await api.me()).user;
    await startCrypto();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      window.location.assign("/");
      return;
    }
    window.location.assign(`/unlock?error=${encodeURIComponent(readableError(error))}`);
  }

  window.setInterval(() => {
    if (cryptoClient) void cryptoClient.syncToDevice().then(() => refreshMessages()).catch(() => undefined);
  }, 2000);
}

void boot();
