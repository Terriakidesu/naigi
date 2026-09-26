import {
  ApiError,
  ApiClient,
  type Conversation,
  type ConversationMember,
  type MessageEnvelope,
  type Server,
  type ServerCategory,
  type ServerChannel,
  type User,
} from "./api";
import { CryptoClient, type ReplyReference } from "./crypto";
import { appendSafeEmbed, extractEmbeds } from "./embeds";
import { appendMarkdown } from "./markdown";
import { clearSessionPassphrase, takeSessionPassphrase } from "./unlock-vault";

const api = new ApiClient();
let currentUser: User | undefined;
let cryptoClient: CryptoClient | undefined;
let selectedConversationId: string | undefined;
let selectedMembers: ConversationMember[] = [];
let conversations: Conversation[] = [];
let servers: Server[] = [];
let channels: ServerChannel[] = [];
let categories: ServerCategory[] = [];
let selectedServerId: string | undefined;
let selectedChannelId: string | undefined;
const serverLabels = new Map<string, string>();
const channelLabels = new Map<string, string>();
const categoryLabels = new Map<string, string>();
const collapsedCategories = new Set<string>();
let realtime: WebSocket | undefined;
let messagesLoading = false;
let olderMessagesLoading = false;
let lastMessagesKey = "__not-rendered__";
let loadedMessages: MessageEnvelope[] = [];
let nextBefore: string | null = null;
let nextAfter: string | null = null;
let latestObservedSequence: bigint | null = null;
let conversationSearchQuery = "";
let messageSearchQuery = "";
const drafts = new Map<string, string>();
let replyTarget: ReplyReference | undefined;
let unreadCount = 0;
let uploadAbortController: AbortController | undefined;
type UnreadMarker = { count: number; lastSequence: string };
const unreadMarkers = new Map<string, UnreadMarker>();
const redactedMessageIds = new Set<string>();
const redactionAuthors = new Map<string, string | null>();
const MESSAGE_PAGE_SIZE = 50;
const MAX_RENDERED_MESSAGES = 300;
const MAX_CATCH_UP_PAGES = 100;
let selectionToken = 0;
let serverSelectionToken = 0;

function byId<T extends HTMLElement>(id: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element: ${id}`);
  return element as T;
}

const chatLayout = byId<HTMLElement>("chat-panel");
const statusLine = byId<HTMLElement>("status-line");
const userLabel = byId<HTMLElement>("user-label");
const conversationList = byId<HTMLElement>("conversation-list");
const conversationSearch = byId<HTMLInputElement>("conversation-search");
const mobileServerSelect = byId<HTMLSelectElement>("mobile-server-select");
const conversationTitle = byId<HTMLElement>("conversation-title");
const conversationSubtitle = byId<HTMLElement>("conversation-subtitle");
const messagesPanel = byId<HTMLElement>("messages");
const memberList = byId<HTMLElement>("member-list");
const serverList = byId<HTMLElement>("server-list");
const channelSectionHeading = byId<HTMLElement>("channel-section-heading");
const channelList = byId<HTMLElement>("channel-list");
const directMessagesHeading = byId<HTMLElement>("direct-messages-heading");
const createConversationButton = byId<HTMLAnchorElement>("create-conversation-button");
const homeRailButton = byId<HTMLButtonElement>("home-rail-button");
const createServerButton = byId<HTMLButtonElement>("create-server-button");
const joinServerButton = byId<HTMLButtonElement>("join-server-button");
const createChannelButton = byId<HTMLButtonElement>("create-channel-button");
const serverInviteButton = byId<HTMLButtonElement>("server-invite-button");
const serverSettingsButton = byId<HTMLAnchorElement>("server-settings-button");
const workspaceName = byId<HTMLElement>("workspace-name");
const workspaceSubtitle = byId<HTMLElement>("workspace-subtitle");
const composer = byId<HTMLFormElement>("composer");
const messageInput = byId<HTMLTextAreaElement>("message-input");
const photoInput = byId<HTMLInputElement>("photo-input");
const sendButton = byId<HTMLButtonElement>("send-button");
const attachmentPreview = byId<HTMLElement>("attachment-preview");
const attachmentLabel = byId<HTMLElement>("attachment-label");
const uploadProgress = byId<HTMLProgressElement>("upload-progress");
const clearAttachment = byId<HTMLButtonElement>("clear-attachment");
const replyPreview = byId<HTMLElement>("reply-preview");
const replyPreviewText = byId<HTMLElement>("reply-preview-text");
const cancelReply = byId<HTMLButtonElement>("cancel-reply");
const mentionSuggestions = byId<HTMLElement>("mention-suggestions");
const lockButton = byId<HTMLButtonElement>("lock-button");
const mobileSidebarToggle = byId<HTMLButtonElement>("mobile-sidebar-toggle");
const mobileSidebarBackdrop = byId<HTMLButtonElement>("mobile-sidebar-backdrop");
const messageSearchToggle = byId<HTMLButtonElement>("message-search-toggle");
const messageSearchContainer = byId<HTMLElement>("message-search-container");
const messageSearch = byId<HTMLInputElement>("message-search");
const messageSearchClose = byId<HTMLButtonElement>("message-search-close");
const detailsToggle = byId<HTMLButtonElement>("details-toggle");
const detailsClose = byId<HTMLButtonElement>("details-close");
const channelIcon = byId<HTMLElement>("channel-icon");
const loadOlderButton = byId<HTMLButtonElement>("load-older-button");
const jumpLatestButton = byId<HTMLButtonElement>("jump-latest-button");
const mediaViewer = byId<HTMLElement>("media-viewer");
const mediaViewerTitle = byId<HTMLElement>("media-viewer-title");
const mediaViewerStage = byId<HTMLElement>("media-viewer-stage");
const mediaViewerZoom = byId<HTMLInputElement>("media-zoom");
const mediaViewerClose = byId<HTMLButtonElement>("media-viewer-close");
let mediaViewerUrl: string | undefined;
let mediaViewerElement: HTMLElement | undefined;
const profileModal = byId<HTMLElement>("profile-modal");
const profileModalClose = byId<HTMLButtonElement>("profile-modal-close");
const profileModalAvatar = byId<HTMLElement>("profile-modal-avatar");
const profileModalName = byId<HTMLElement>("profile-modal-name");
const profileModalUsername = byId<HTMLElement>("profile-modal-username");
const profileModalCreated = byId<HTMLElement>("profile-modal-created");
const profileModalEdit = byId<HTMLAnchorElement>("profile-modal-edit");

function setStatus(message: string, error = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", error);
}

function closeMediaViewer() {
  if (mediaViewerUrl) URL.revokeObjectURL(mediaViewerUrl);
  mediaViewerUrl = undefined;
  mediaViewerElement = undefined;
  mediaViewerStage.replaceChildren();
  mediaViewerZoom.value = "1";
  mediaViewer.hidden = true;
}

function openMediaViewer(blob: Blob, filename: string, video: boolean) {
  closeMediaViewer();
  mediaViewerUrl = URL.createObjectURL(blob);
  const element = document.createElement(video ? "video" : "img");
  element.className = video ? "media-viewer-video" : "media-viewer-image";
  element.src = mediaViewerUrl;
  if (video) {
    const player = element as HTMLVideoElement;
    player.controls = true;
    player.preload = "metadata";
  } else {
    (element as HTMLImageElement).alt = filename || "Encrypted media";
  }
  mediaViewerElement = element;
  mediaViewerTitle.textContent = filename || (video ? "Video viewer" : "Image viewer");
  mediaViewerStage.append(element);
  mediaViewer.hidden = false;
  mediaViewerZoom.value = "1";
  mediaViewerClose.focus();
}

async function openUserProfile(userId: string) {
  profileModal.hidden = false;
  profileModalName.textContent = "Loading profile…";
  profileModalUsername.textContent = "";
  profileModalCreated.textContent = "";
  profileModalEdit.hidden = true;
  try {
    const result = await api.user(userId);
    const user = result.user;
    profileModalAvatar.textContent = user.displayName.slice(0, 1).toUpperCase();
    setAvatarStyle(profileModalAvatar, user.id);
    profileModalName.textContent = user.displayName;
    profileModalUsername.textContent = `@${user.username}`;
    profileModalCreated.textContent = `Joined ${new Date(user.createdAt).toLocaleDateString()}`;
    profileModalEdit.hidden = user.id !== currentUser?.id;
  } catch (error) {
    profileModalName.textContent = "Profile unavailable";
    profileModalUsername.textContent = readableError(error);
  }
}

mediaViewerZoom.addEventListener("input", () => {
  if (mediaViewerElement) mediaViewerElement.style.transform = `scale(${mediaViewerZoom.value})`;
});

function clearReplyTarget() {
  replyTarget = undefined;
  replyPreview.hidden = true;
  replyPreviewText.textContent = "";
}

function setReplyTarget(target: ReplyReference) {
  replyTarget = target;
  const preview = target.body.replace(/\s+/g, " ").trim() || "Encrypted message";
  replyPreviewText.textContent = `Replying to ${target.sender}: ${preview.slice(0, 180)}`;
  replyPreview.hidden = false;
  messageInput.focus();
}

function mentionedUserIds(body: string) {
  const ids = new Set<string>();
  for (const match of body.matchAll(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]+)/g)) {
    const username = match[2].toLowerCase();
    const member = selectedMembers.find((candidate) => candidate.username.toLowerCase() === username);
    if (member) ids.add(member.userId);
  }
  return [...ids];
}

function mentionToken() {
  const cursor = messageInput.selectionStart ?? messageInput.value.length;
  const before = messageInput.value.slice(0, cursor);
  const match = before.match(/(^|\s)@([A-Za-z0-9_.-]*)$/);
  if (!match) return null;
  return {
    query: match[2].toLowerCase(),
    start: before.length - match[0].length + match[1].length,
    end: cursor,
  };
}

function hideMentionSuggestions() {
  mentionSuggestions.hidden = true;
  mentionSuggestions.replaceChildren();
}

function renderMentionSuggestions() {
  const token = mentionToken();
  if (!token) {
    hideMentionSuggestions();
    return;
  }
  const candidates = selectedMembers
    .filter((member) => !token.query || member.username.toLowerCase().startsWith(token.query))
    .slice(0, 8);
  mentionSuggestions.replaceChildren();
  if (candidates.length === 0) {
    hideMentionSuggestions();
    return;
  }
  for (const member of candidates) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "mention-suggestion";
    option.textContent = `@${member.username} · ${member.displayName || member.username}`;
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => {
      const replacement = `@${member.username} `;
      messageInput.value = `${messageInput.value.slice(0, token.start)}${replacement}${messageInput.value.slice(token.end)}`;
      const nextCursor = token.start + replacement.length;
      messageInput.setSelectionRange(nextCursor, nextCursor);
      hideMentionSuggestions();
      rememberDraft();
      resizeMessageInput();
      messageInput.focus();
    });
    mentionSuggestions.append(option);
  }
  mentionSuggestions.hidden = false;
}

function renderUnreadButton() {
  const distanceFromBottom = messagesPanel.scrollHeight - messagesPanel.scrollTop - messagesPanel.clientHeight;
  jumpLatestButton.textContent = unreadCount > 0
    ? `↓ ${unreadCount} new message${unreadCount === 1 ? "" : "s"}`
    : "↓ Jump to latest";
  jumpLatestButton.hidden = unreadCount === 0 && distanceFromBottom < 100;
}

function clearUnread() {
  unreadCount = 0;
  renderUnreadButton();
}

function unreadStorageKey() {
  return currentUser ? `priv-chat.unread.${currentUser.id}` : "priv-chat.unread";
}

function loadUnreadMarkers() {
  unreadMarkers.clear();
  try {
    const stored = JSON.parse(localStorage.getItem(unreadStorageKey()) ?? "{}") as Record<string, unknown>;
    for (const [conversationId, value] of Object.entries(stored)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const marker = value as Record<string, unknown>;
      if (typeof marker.count === "number" && Number.isInteger(marker.count) && marker.count > 0 && typeof marker.lastSequence === "string" && /^[0-9]+$/.test(marker.lastSequence)) {
        unreadMarkers.set(conversationId, { count: marker.count, lastSequence: marker.lastSequence });
      }
    }
  } catch {
    // Local unread state is optional and never blocks chat startup.
  }
}

function saveUnreadMarkers() {
  try {
    localStorage.setItem(unreadStorageKey(), JSON.stringify(Object.fromEntries(unreadMarkers)));
  } catch {
    // Local storage may be disabled or full.
  }
}

function markConversationUnread(conversationId: string, serverSequence?: string) {
  if (conversationId === selectedConversationId) return;
  const existing = unreadMarkers.get(conversationId);
  if (existing && serverSequence && BigInt(serverSequence) <= BigInt(existing.lastSequence)) return;
  unreadMarkers.set(conversationId, {
    count: (existing?.count ?? 0) + 1,
    lastSequence: serverSequence ?? existing?.lastSequence ?? "0",
  });
  saveUnreadMarkers();
  renderConversations();
  renderChannels();
}

function clearConversationUnread(conversationId: string) {
  if (!unreadMarkers.delete(conversationId)) return;
  saveUnreadMarkers();
  renderConversations();
  renderChannels();
}

type ScrollAnchor = {
  messageId: string;
  offset: number;
};

function messageSequence(message: MessageEnvelope) {
  return BigInt(message.serverSequence);
}

function sortMessages(messages: MessageEnvelope[]) {
  return [...messages].sort((left, right) => {
    const leftSequence = messageSequence(left);
    const rightSequence = messageSequence(right);
    return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
  });
}

function messagesKey(messages = loadedMessages) {
  return messages.map((message) => `${message.id}:${message.createdAt}`).join("|");
}

function observeLatestMessages(messages: MessageEnvelope[]) {
  for (const message of messages) {
    const sequence = messageSequence(message);
    if (latestObservedSequence === null || sequence > latestObservedSequence) latestObservedSequence = sequence;
  }
}

function countUnseenMessages(messages: MessageEnvelope[]) {
  const unseen = messages.filter((message) => latestObservedSequence === null || messageSequence(message) > latestObservedSequence).length;
  observeLatestMessages(messages);
  return unseen;
}

function mergeMessageWindow(messages: MessageEnvelope[], direction: "older" | "newer" | "latest") {
  const byId = new Map(loadedMessages.map((message) => [message.id, message]));
  for (const message of messages) byId.set(message.id, message);
  const merged = sortMessages([...byId.values()]);
  const trimmed = Math.max(0, merged.length - MAX_RENDERED_MESSAGES);
  loadedMessages = direction === "older"
    ? merged.slice(0, MAX_RENDERED_MESSAGES)
    : merged.slice(-MAX_RENDERED_MESSAGES);
  if (trimmed > 0 && loadedMessages.length > 0) {
    if (direction === "older") nextAfter = loadedMessages[loadedMessages.length - 1].serverSequence;
    else nextBefore = loadedMessages[0].serverSequence;
  }
  return { trimmed };
}

function captureScrollAnchor(): ScrollAnchor | null {
  const panelRect = messagesPanel.getBoundingClientRect();
  const anchor = [...messagesPanel.querySelectorAll<HTMLElement>(".message")].find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.bottom > panelRect.top && rect.top < panelRect.bottom;
  });
  if (!anchor?.dataset.messageId) return null;
  return {
    messageId: anchor.dataset.messageId,
    offset: anchor.getBoundingClientRect().top - panelRect.top,
  };
}

function restoreScrollAnchor(anchor: ScrollAnchor | undefined) {
  if (!anchor) return;
  const target = [...messagesPanel.querySelectorAll<HTMLElement>(".message")]
    .find((candidate) => candidate.dataset.messageId === anchor.messageId);
  if (!target) return;
  const panelRect = messagesPanel.getBoundingClientRect();
  messagesPanel.scrollTop += target.getBoundingClientRect().top - panelRect.top - anchor.offset;
}

function readableError(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return "Upload canceled.";
  if (error instanceof ApiError) {
    if (error.code === "invalid_credentials") return "The username or password is incorrect.";
    if (error.code === "username_taken") return "That username is already in use.";
    if (error.code === "server_owner_must_transfer_ownership") return "The server owner must transfer ownership before leaving.";
    if (error.code === "invite_not_found") return "That invite is not valid.";
    if (error.code === "invite_expired" || error.code === "invite_exhausted") return "That invite is no longer active.";
    if (error.code === "current_password_incorrect") return "The current password is incorrect.";
    if (error.code === "category_not_found") return "That category no longer exists.";
    if (error.code === "channel_not_found") return "That channel no longer exists.";
    if (error.code === "cannot_archive_last_channel") return "A server must keep one active text channel.";
    if (error.code === "cannot_archive_metadata_channel") return "The original channel anchors encrypted server metadata and cannot be archived.";
    return error.code;
  }
  return error instanceof Error ? error.message : "request_failed";
}

async function startCrypto() {
  if (!currentUser) throw new Error("not_authenticated");
  const localPassphrase = takeSessionPassphrase();
  if (!localPassphrase) {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/unlock?return=${encodeURIComponent(returnPath)}`);
    return;
  }
  loadUnreadMarkers();
  cryptoClient?.close();
  cryptoClient = new CryptoClient(api, currentUser.id, localPassphrase);
  await cryptoClient.initialize();
  const outbox = await cryptoClient.flushPendingMessages().catch(() => ({ sent: 0, pending: 0, failed: 0 }));
  userLabel.textContent = `${currentUser.displayName} (@${currentUser.username})`;
  await refreshServers();
  await refreshConversations();
  connectRealtime();
  setStatus(outbox.sent > 0 ? `${outbox.sent} queued message${outbox.sent === 1 ? "" : "s"} delivered.` : "Encrypted chat is ready.");
}

async function flushOutbox() {
  if (!cryptoClient) return;
  const result = await cryptoClient.flushPendingMessages();
  if (result.sent > 0) {
    setStatus(`${result.sent} queued message${result.sent === 1 ? "" : "s"} delivered.`);
    await refreshMessages();
  } else if (result.failed > 0) {
    setStatus(`${result.failed} queued message${result.failed === 1 ? "" : "s"} need attention.`, true);
  }
}

function connectRealtime() {
  realtime?.close();
  const url = new URL("/v1/realtime", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  realtime = new WebSocket(url);
  realtime.addEventListener("open", () => {
    setStatus("Encrypted chat is connected.");
    subscribeKnownConversations();
  });
  realtime.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data) as { type?: string; conversationId?: string; serverSequence?: string };
      if (payload.type === "message.created" && payload.conversationId) {
        if (payload.conversationId === selectedConversationId) {
          void refreshMessages().catch((error) => setStatus(readableError(error), true));
        } else {
          markConversationUnread(payload.conversationId, payload.serverSequence);
        }
      }
    } catch {
      // Ignore malformed realtime notifications; history remains authoritative.
    }
  });
  realtime.addEventListener("error", () => {
    setStatus("Realtime connection unavailable; history still works.", true);
  });
  realtime.addEventListener("close", () => {
    setStatus("Reconnecting encrypted chat…");
    if (cryptoClient) window.setTimeout(connectRealtime, 1500);
  });
}

function subscribeRealtime(conversationId: string) {
  if (realtime?.readyState === WebSocket.OPEN) {
    realtime.send(JSON.stringify({ type: "subscribe", conversationId }));
  }
}

function subscribeKnownConversations() {
  const known = new Set(conversations.map((conversation) => conversation.id));
  for (const channel of channels) known.add(channel.conversationId);
  if (selectedConversationId) known.add(selectedConversationId);
  for (const conversationId of known) subscribeRealtime(conversationId);
}

function avatarColor(seed: string) {
  const colors = ["#5865f2", "#3ba55d", "#ed4245", "#eb459e", "#faa61a", "#00b0f4", "#9b59b6"];
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

function setAvatarStyle(element: HTMLElement, seed: string) {
  element.style.setProperty("--avatar-color", avatarColor(seed));
}

function conversationDisplayName(conversation: Conversation) {
  const names = conversation.memberDisplayNames ?? [];
  if (conversation.kind === "dm") return names[0] || "Direct message";
  if (names.length === 0) return "Group conversation";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} + ${names.length - 2}`;
}

function serverDisplayName(server: Server) {
  const index = servers.findIndex((item) => item.id === server.id);
  return serverLabels.get(server.id) || `Server ${index >= 0 ? index + 1 : 1}`;
}

function serverNameForId(serverId: string) {
  const server = servers.find((item) => item.id === serverId);
  return server ? serverDisplayName(server) : "Server";
}

function channelDisplayName(channel: ServerChannel) {
  return channelLabels.get(channel.id) || (channel.position === 0 ? "general" : `channel-${channel.position + 1}`);
}

function categoryDisplayName(category: ServerCategory) {
  const index = categories.findIndex((item) => item.id === category.id);
  return categoryLabels.get(category.id) || `Category ${index + 1}`;
}

function renderServers() {
  serverList.replaceChildren();
  for (const server of servers) {
    const button = document.createElement("button");
    button.className = "server-rail-button";
    button.type = "button";
    button.title = serverDisplayName(server);
    button.setAttribute("aria-label", serverDisplayName(server));
    button.setAttribute("aria-pressed", String(server.id === selectedServerId));
    button.classList.toggle("selected", server.id === selectedServerId);
    button.textContent = serverDisplayName(server).slice(0, 1).toUpperCase();
    setAvatarStyle(button, server.id);
    button.addEventListener("click", () => void selectServer(server.id));
    serverList.append(button);
  }

  mobileServerSelect.replaceChildren();
  const homeOption = document.createElement("option");
  homeOption.value = "";
  homeOption.textContent = "Direct messages";
  mobileServerSelect.append(homeOption);
  for (const server of servers) {
    const option = document.createElement("option");
    option.value = server.id;
    option.textContent = serverDisplayName(server);
    mobileServerSelect.append(option);
  }
  mobileServerSelect.value = selectedServerId ?? "";

  homeRailButton.classList.toggle("rail-active", !selectedServerId);
  homeRailButton.setAttribute("aria-pressed", String(!selectedServerId));
  const activeServer = selectedServerId ? servers.find((server) => server.id === selectedServerId) : undefined;
  workspaceName.textContent = activeServer ? serverDisplayName(activeServer) : "Direct messages";
  workspaceSubtitle.textContent = selectedServerId ? "Private encrypted server" : "Encrypted workspace";
  const canManage = activeServer?.role === "owner" || activeServer?.role === "admin";
  createChannelButton.hidden = !canManage;
  serverInviteButton.hidden = !canManage;
  serverSettingsButton.hidden = !canManage;
  if (activeServer) serverSettingsButton.href = `/server-settings?server=${encodeURIComponent(activeServer.id)}`;
}

function renderChannels() {
  const visible = selectedServerId ? channels.filter((channel) => {
    const query = conversationSearchQuery.trim().toLowerCase();
    return !query || `${channelDisplayName(channel)} ${channel.id}`.toLowerCase().includes(query);
  }) : [];
  channelSectionHeading.hidden = !selectedServerId;
  channelList.hidden = !selectedServerId;
  channelList.replaceChildren();
  if (!selectedServerId) return;

  if (visible.length === 0) {
    const empty = document.createElement("span");
    empty.className = "muted channel-list-empty";
    empty.textContent = conversationSearchQuery.trim() ? "No channels match." : "No text channels yet.";
    channelList.append(empty);
    return;
  }

  const byCategory = new Map<string | null, ServerChannel[]>();
  for (const channel of visible) {
    const list = byCategory.get(channel.categoryId) ?? [];
    list.push(channel);
    byCategory.set(channel.categoryId, list);
  }

  const appendChannel = (channel: ServerChannel) => {
    const button = document.createElement("button");
    button.className = "channel-item";
    button.type = "button";
    button.dataset.channelId = channel.id;
    button.classList.toggle("selected", channel.id === selectedChannelId);
    button.setAttribute("aria-pressed", String(channel.id === selectedChannelId));
    const icon = document.createElement("span");
    icon.className = "channel-item-icon";
    icon.textContent = "#";
    const name = document.createElement("span");
    name.className = "channel-item-name";
    name.textContent = channelDisplayName(channel);
    button.append(icon, name);
    const unread = unreadMarkers.get(channel.conversationId)?.count ?? 0;
    if (unread > 0) {
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      badge.setAttribute("aria-label", `${unread} unread message${unread === 1 ? "" : "s"}`);
      button.append(badge);
    }
    button.addEventListener("click", () => void selectChannel(channel.id));
    channelList.append(button);
  };

  const appendCategory = (category: ServerCategory | null, categoryChannels: ServerChannel[]) => {
    const heading = document.createElement("button");
    heading.className = "category-heading";
    heading.type = "button";
    heading.setAttribute("aria-expanded", String(!category || !collapsedCategories.has(category.id)));
    const name = document.createElement("span");
    name.textContent = category ? categoryDisplayName(category) : "TEXT CHANNELS";
    const indicator = document.createElement("span");
    indicator.textContent = category && collapsedCategories.has(category.id) ? "▸" : "⌄";
    heading.append(name, indicator);
    if (category) {
      heading.addEventListener("click", () => {
        if (collapsedCategories.has(category.id)) collapsedCategories.delete(category.id);
        else collapsedCategories.add(category.id);
        renderChannels();
      });
    } else {
      heading.disabled = true;
      heading.classList.add("category-heading-uncategorized");
    }
    channelList.append(heading);
    if (!category || !collapsedCategories.has(category.id)) {
      for (const channel of categoryChannels) appendChannel(channel);
    }
  };

  const categoryIds = new Set(categories.map((category) => category.id));
  for (const category of categories) appendCategory(category, byCategory.get(category.id) ?? []);
  const uncategorized = visible.filter((channel) => !channel.categoryId || !categoryIds.has(channel.categoryId));
  if (uncategorized.length > 0 || categories.length === 0) appendCategory(null, uncategorized);
}

function renderConversationEmpty(message: string) {
  const empty = document.createElement("div");
  empty.className = "conversation-list-empty";
  const icon = document.createElement("span");
  icon.className = "empty-icon";
  icon.textContent = "⌕";
  const text = document.createElement("span");
  text.textContent = message;
  empty.append(icon, text);
  conversationList.append(empty);
}

function renderConversations() {
  const visibleInWorkspace = !selectedServerId;
  directMessagesHeading.hidden = !visibleInWorkspace;
  createConversationButton.hidden = !visibleInWorkspace;
  conversationList.hidden = !visibleInWorkspace;
  conversationSearch.placeholder = visibleInWorkspace ? "Find a conversation" : "Find a channel";
  conversationSearch.setAttribute("aria-label", visibleInWorkspace ? "Find a conversation" : "Find a channel");
  conversationList.replaceChildren();
  if (!visibleInWorkspace) return;
  if (conversations.length === 0) {
    renderConversationEmpty("No conversations yet.");
    return;
  }

  const query = conversationSearchQuery.trim().toLowerCase();
  const visible = conversations.filter((conversation) => {
    if (!query) return true;
    const kind = conversation.kind === "dm" ? "direct message" : "group conversation";
    return `${conversationDisplayName(conversation)} ${kind} ${conversation.id}`.toLowerCase().includes(query);
  });

  if (visible.length === 0) {
    renderConversationEmpty("No conversations match that search.");
    return;
  }

  for (const conversation of visible) {
    const button = document.createElement("button");
    button.className = "conversation-item";
    button.classList.toggle("selected", conversation.id === selectedConversationId);
    button.type = "button";
    button.dataset.conversationId = conversation.id;
    button.setAttribute("aria-pressed", conversation.id === selectedConversationId ? "true" : "false");
    const icon = document.createElement("span");
    icon.className = "conversation-icon";
    icon.textContent = conversation.kind === "dm" ? "@" : "#";
    setAvatarStyle(icon, conversation.id);
    const copy = document.createElement("span");
    copy.className = "conversation-copy";
    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = conversationDisplayName(conversation);
    const conversationStatus = document.createElement("span");
    conversationStatus.className = "conversation-status";
    const memberCount = (conversation.memberDisplayNames?.length ?? 0) + 1;
    conversationStatus.textContent = conversation.kind === "dm"
      ? "direct message · encrypted"
      : `${memberCount} members · encrypted`;
    copy.append(title, conversationStatus);
    button.append(icon, copy);
    const unread = unreadMarkers.get(conversation.id)?.count ?? 0;
    if (unread > 0) {
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      badge.setAttribute("aria-label", `${unread} unread message${unread === 1 ? "" : "s"}`);
      button.append(badge);
    }
    button.addEventListener("click", () => void openDirectMessage(conversation.id));
    conversationList.append(button);
  }
}

async function refreshServers() {
  const result = await api.servers();
  servers = result.servers;
  renderServers();

  const params = new URLSearchParams(window.location.search);
  const requestedServerId = params.get("server");
  const requestedChannelId = params.get("channel");
  const requestedServer = requestedServerId ? servers.find((server) => server.id === requestedServerId) : undefined;
  if (requestedServer) {
    await selectServer(requestedServer.id, requestedChannelId ?? undefined);
    return;
  }

  // A direct-message URL should stay on the DM home instead of being replaced by
  // the first server in the rail.
  if (params.has("conversation")) return;
  if (selectedServerId && servers.some((server) => server.id === selectedServerId)) {
    renderServers();
    return;
  }
  if (servers[0]) {
    await selectServer(servers[0].id);
    return;
  }
  selectedServerId = undefined;
  selectedChannelId = undefined;
  channels = [];
  categories = [];
  renderServers();
  renderChannels();
}

async function selectServer(serverId: string, requestedChannelId?: string) {
  const token = ++serverSelectionToken;
  selectedServerId = serverId;
  selectedChannelId = undefined;
  selectedConversationId = undefined;
  selectedMembers = [];
  channels = [];
  categories = [];
  selectionToken += 1;
  renderServers();
  renderConversations();
  renderChannels();
  renderMembers([]);
  updateComposerState();
  conversationTitle.textContent = serverNameForId(serverId);
  conversationSubtitle.textContent = "Loading encrypted channels…";
  channelIcon.textContent = "#";

  try {
    const [channelResult, categoryResult] = await Promise.all([
      api.serverChannels(serverId),
      api.serverCategories(serverId),
    ]);
    if (token !== serverSelectionToken) return;
    channels = channelResult.channels;
    categories = categoryResult.categories;
    subscribeKnownConversations();
    renderChannels();
    const requested = requestedChannelId && channels.find((channel) => channel.id === requestedChannelId);
    const channel = requested ?? channels[0];
    if (channel) await selectChannel(channel.id);
    else {
      conversationTitle.textContent = serverNameForId(serverId);
      conversationSubtitle.textContent = "Create a text channel to start chatting";
      renderConversationWelcome("No text channels yet", "Create a channel to start an encrypted server conversation.");
      setMobileSidebar(false);
    }
  } catch (error) {
    if (token !== serverSelectionToken) return;
    setStatus(readableError(error), true);
    renderConversationWelcome("Unable to load this server", "Try selecting it again after checking your connection.");
  }
}

async function selectChannel(channelId: string) {
  const channel = channels.find((item) => item.id === channelId);
  if (!channel) return;
  selectedChannelId = channel.id;
  selectedConversationId = channel.conversationId;
  renderChannels();
  await selectConversation(channel.conversationId, channel);
}

async function openDirectMessage(conversationId: string) {
  selectedServerId = undefined;
  selectedChannelId = undefined;
  channels = [];
  categories = [];
  selectedMembers = [];
  ++serverSelectionToken;
  renderServers();
  renderConversations();
  renderChannels();
  await selectConversation(conversationId);
}

async function showDirectMessages() {
  selectedServerId = undefined;
  selectedChannelId = undefined;
  channels = [];
  categories = [];
  selectedConversationId = undefined;
  selectedMembers = [];
  ++serverSelectionToken;
  renderServers();
  renderConversations();
  renderChannels();
  const requested = new URLSearchParams(window.location.search).get("conversation");
  const conversation = (requested && conversations.find((item) => item.id === requested)) ?? conversations[0];
  if (conversation) await selectConversation(conversation.id);
  else {
    conversationTitle.textContent = "Your conversations";
    conversationSubtitle.textContent = "Start a private conversation to begin chatting";
    channelIcon.textContent = "@";
    renderConversationWelcome("No conversations yet", "Create a direct message or group conversation to get started.");
    renderMembers([]);
    updateComposerState();
  }
}

async function refreshConversations() {
  const result = await api.conversations();
  conversations = result.conversations;
  subscribeKnownConversations();
  renderConversations();
  const selectedChannel = channels.some((channel) => channel.conversationId === selectedConversationId);
  if (selectedConversationId && !selectedChannel && !conversations.some((conversation) => conversation.id === selectedConversationId)) {
    selectedConversationId = undefined;
    selectedMembers = [];
  }
  const requested = new URLSearchParams(window.location.search).get("conversation");
  const requestedConversation = requested && conversations.find((conversation) => conversation.id === requested);
  if (!selectedServerId && !selectedConversationId && requestedConversation) await openDirectMessage(requestedConversation.id);
  else if (!selectedServerId && !selectedConversationId && conversations[0]) await openDirectMessage(conversations[0].id);
  else if (!selectedConversationId) {
    conversationTitle.textContent = "Your conversations";
    conversationSubtitle.textContent = "Start a private conversation to begin chatting";
    channelIcon.textContent = "@";
    renderConversationWelcome("No conversations yet", "Create a direct message or group conversation to get started.");
    renderMembers([]);
    updateComposerState();
    setMobileSidebar(false);
  }
}

function renderMembers(members: ConversationMember[]) {
  memberList.replaceChildren();
  if (members.length === 0) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "Choose a conversation";
    memberList.append(empty);
    return;
  }
  for (const member of members) {
    const row = document.createElement("button");
    const memberName = member.userId === currentUser?.id ? currentUser?.displayName ?? "You" : member.displayName || `@${member.username}`;
    row.className = "member-row profile-trigger";
    row.type = "button";
    row.title = `View ${memberName}'s profile`;
    row.addEventListener("click", () => void openUserProfile(member.userId));
    const avatar = document.createElement("span");
    avatar.className = "member-avatar";
    avatar.textContent = memberName.slice(0, 1).toUpperCase();
    setAvatarStyle(avatar, member.userId);
    const copy = document.createElement("div");
    copy.className = "member-copy";
    const name = document.createElement("strong");
    name.textContent = memberName;
    const identity = document.createElement("span");
    identity.textContent = member.userId === currentUser?.id ? "you · keys protected" : "keys protected";
    copy.append(name, identity);
    row.append(avatar, copy);
    memberList.append(row);
  }
}

function renderConversationWelcome(title: string, description: string) {
  messagesPanel.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "conversation-welcome";
  const icon = document.createElement("div");
  icon.className = "conversation-welcome-icon";
  icon.textContent = "✦";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = description;
  empty.append(icon, heading, body);
  messagesPanel.append(empty);
}

function updateComposerState() {
  const enabled = Boolean(selectedConversationId && cryptoClient);
  messageInput.disabled = !enabled;
  photoInput.disabled = !enabled;
  sendButton.disabled = !enabled;
  messageInput.placeholder = enabled ? "Message this conversation" : "Select a conversation to start chatting";
  if (!enabled) {
    attachmentPreview.hidden = true;
    uploadProgress.hidden = true;
    photoInput.value = "";
  }
}

function senderLabel(message: MessageEnvelope, decrypted: { sender: string } | null) {
  if (message.senderUserId && message.senderUserId === currentUser?.id) return currentUser?.displayName ?? "You";
  const member = message.senderUserId ? selectedMembers.find((item) => item.userId === message.senderUserId) : undefined;
  if (member) return member.displayName || `@${member.username}`;
  const raw = message.senderUserId ?? decrypted?.sender ?? "unknown";
  const userId = raw.replace(/^@/, "").split(":", 1)[0];
  return userId === currentUser?.id ? currentUser?.displayName ?? "You" : `Member ${userId.slice(0, 8)}`;
}

function senderKey(message: MessageEnvelope, decrypted: { sender: string } | null) {
  return message.senderUserId ?? decrypted?.sender ?? "unknown";
}

function mentionUsernames(content: Record<string, unknown>) {
  const values = Array.isArray(content.mentions) ? content.mentions.filter((value): value is string => typeof value === "string") : [];
  return new Set(selectedMembers.filter((member) => values.includes(member.userId)).map((member) => member.username.toLowerCase()));
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dateLabel(date: Date) {
  const today = new Date();
  const todayKey = dateKey(today);
  if (dateKey(date) === todayKey) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dateKey(date) === dateKey(yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function appendDateDivider(date: Date) {
  const divider = document.createElement("div");
  divider.className = "date-divider";
  const label = document.createElement("span");
  label.textContent = dateLabel(date);
  divider.append(label);
  messagesPanel.append(divider);
  return divider;
}

function applyMessageSearch() {
  const query = messageSearchQuery.trim().toLowerCase();
  let matches = 0;
  for (const message of messagesPanel.querySelectorAll<HTMLElement>(".message")) {
    const match = !query || (message.dataset.search ?? "").includes(query);
    message.hidden = !match;
    if (match) matches += 1;
  }
  for (const divider of messagesPanel.querySelectorAll<HTMLElement>(".date-divider")) divider.hidden = Boolean(query);

  const existing = messagesPanel.querySelector(".message-search-empty");
  existing?.remove();
  if (query && matches === 0 && messagesPanel.querySelector(".message")) {
    const empty = document.createElement("p");
    empty.className = "message-search-empty muted";
    empty.textContent = "No messages match your search.";
    messagesPanel.append(empty);
  }
}

function rememberDraft(conversationId = selectedConversationId) {
  if (!conversationId) return;
  const value = messageInput.value;
  if (value) drafts.set(conversationId, value);
  else drafts.delete(conversationId);
}

async function selectConversation(conversationId: string, channel?: ServerChannel) {
  if (!cryptoClient) return;
  rememberDraft();
  const token = ++selectionToken;
  selectedConversationId = conversationId;
  if (channel) selectedChannelId = channel.id;
  lastMessagesKey = "__not-rendered__";
  loadedMessages = [];
  nextBefore = null;
  nextAfter = null;
  latestObservedSequence = null;
  redactedMessageIds.clear();
  redactionAuthors.clear();
  clearUnread();
  clearConversationUnread(conversationId);
  clearReplyTarget();
  messageInput.value = drafts.get(conversationId) ?? "";
  resizeMessageInput();
  const conversation = conversations.find((item) => item.id === conversationId);
  conversationTitle.textContent = channel ? channelDisplayName(channel) : conversation ? conversationDisplayName(conversation) : "Conversation";
  conversationSubtitle.textContent = "Loading encrypted conversation…";
  channelIcon.textContent = channel ? "#" : conversation?.kind === "group" ? "#" : "@";
  updateComposerState();
  renderConversations();
  renderChannels();
  chatLayout.classList.remove("mobile-sidebar-open");
  const url = new URL(window.location.href);
  if (channel && selectedServerId) {
    url.searchParams.delete("conversation");
    url.searchParams.set("server", selectedServerId);
    url.searchParams.set("channel", channel.id);
  } else {
    url.searchParams.delete("server");
    url.searchParams.delete("channel");
    url.searchParams.set("conversation", conversationId);
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  subscribeRealtime(conversationId);
  const members = await api.conversationMembers(conversationId);
  if (token !== selectionToken) return;
  selectedMembers = members.members;
  renderMembers(selectedMembers);
  conversationSubtitle.textContent = `${selectedMembers.length} member${selectedMembers.length === 1 ? "" : "s"} · end-to-end encrypted`;
  await cryptoClient.prepareConversation(conversationId, selectedMembers);
  if (token !== selectionToken) return;
  await cryptoClient.syncToDevice().catch(() => undefined);
  if (channel?.encryptedMetadata) {
    try {
      const metadata = await cryptoClient.decryptMetadata(conversationId, channel.encryptedMetadata);
      if (typeof metadata.name === "string" && metadata.name.trim()) {
        channelLabels.set(channel.id, metadata.name.trim().slice(0, 80));
      }
    } catch {
      // Metadata is intentionally opaque; a missing room key should not block chat.
    }
  }
  const activeServer = selectedServerId ? servers.find((server) => server.id === selectedServerId) : undefined;
  const metadataChannel = activeServer
    ? [...channels].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0]
    : undefined;
  let metadataMembers = selectedMembers;
  if (metadataChannel && metadataChannel.conversationId !== conversationId) {
    try {
      metadataMembers = (await api.conversationMembers(metadataChannel.conversationId)).members;
      await cryptoClient.prepareConversation(metadataChannel.conversationId, metadataMembers);
      await cryptoClient.syncToDevice().catch(() => undefined);
    } catch {
      metadataMembers = selectedMembers;
    }
  }
  const metadataConversationId = metadataChannel?.conversationId ?? conversationId;
  if (activeServer?.encryptedMetadata) {
    try {
      const metadata = await cryptoClient.decryptMetadata(metadataConversationId, activeServer.encryptedMetadata);
      if (typeof metadata.name === "string" && metadata.name.trim()) {
        serverLabels.set(activeServer.id, metadata.name.trim().slice(0, 80));
      }
    } catch {
      // See the channel metadata note above.
    }
  }
  if (metadataChannel && categories.length > 0) {
    for (const category of categories) {
      if (!category.encryptedMetadata) continue;
      try {
        const metadata = await cryptoClient.decryptMetadata(metadataConversationId, category.encryptedMetadata);
        if (typeof metadata.name === "string" && metadata.name.trim()) categoryLabels.set(category.id, metadata.name.trim().slice(0, 80));
      } catch {
        // Category labels are opaque and should never block the conversation.
      }
    }
  }
  conversationTitle.textContent = channel ? channelDisplayName(channel) : conversation ? conversationDisplayName(conversation) : "Conversation";
  if (activeServer) renderServers();
  renderChannels();
  updateComposerState();
  renderConversations();
  await refreshMessages();
}

function replyReferenceFromContent(content: Record<string, unknown>) {
  const value = content.replyTo;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reply = value as Record<string, unknown>;
  if (typeof reply.messageId !== "string" || typeof reply.sender !== "string" || typeof reply.body !== "string") return null;
  return {
    messageId: reply.messageId,
    sender: reply.sender,
    body: reply.body,
  } satisfies ReplyReference;
}

function findMessageArticle(messageId: string) {
  return [...messagesPanel.querySelectorAll<HTMLElement>(".message")]
    .find((candidate) => candidate.dataset.messageId === messageId);
}

async function scrollToMessage(messageId: string) {
  let article = findMessageArticle(messageId);
  if (!article && nextAfter) {
    await refreshMessages({ forceScrollToBottom: true }).catch(() => undefined);
    article = findMessageArticle(messageId);
  }
  for (let attempt = 0; !article && nextBefore && attempt < MAX_CATCH_UP_PAGES; attempt += 1) {
    await loadOlderMessages();
    article = findMessageArticle(messageId);
  }
  if (!article) {
    setStatus("The replied-to message is not loaded in this view.", true);
    return;
  }
  article.scrollIntoView({ behavior: "smooth", block: "center" });
  article.classList.add("message-highlight");
  window.setTimeout(() => article.classList.remove("message-highlight"), 1_200);
}

function markMessageDeleted(messageId: string) {
  const article = [...messagesPanel.querySelectorAll<HTMLElement>(".message")]
    .find((candidate) => candidate.dataset.messageId === messageId);
  const content = article?.querySelector<HTMLElement>(".message-content");
  const header = content?.querySelector<HTMLElement>(".message-meta");
  if (!article || !content || !header) return;
  const deleted = document.createElement("p");
  deleted.className = "message-deleted muted";
  deleted.textContent = "Message deleted";
  content.replaceChildren(header, deleted);
  article.classList.add("message-deleted-row");
  article.dataset.search = "message deleted";
}

function appendMessageActions(parent: HTMLElement, message: MessageEnvelope, sender: string, body: string) {
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const reply = document.createElement("button");
  reply.className = "message-action";
  reply.type = "button";
  reply.textContent = "Reply";
  reply.addEventListener("click", () => setReplyTarget({
    messageId: message.id,
    sender,
    body: body || "Encrypted message",
  }));
  actions.append(reply);
  if (body) {
    const copy = document.createElement("button");
    copy.className = "message-action";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      try {
        if (!navigator.clipboard) throw new Error("clipboard_unavailable");
        await navigator.clipboard.writeText(body);
        setStatus("Message copied.");
      } catch {
        setStatus("Unable to copy this message.", true);
      }
    });
    actions.append(copy);
  }
  if (message.senderUserId === currentUser?.id) {
    const remove = document.createElement("button");
    remove.className = "message-action message-delete-action";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      if (!cryptoClient || !selectedConversationId || !window.confirm("Delete this message for everyone in this conversation?")) return;
      remove.disabled = true;
      try {
        const result = await cryptoClient.sendRedaction(selectedConversationId, selectedMembers, message.id);
        redactedMessageIds.add(message.id);
        markMessageDeleted(message.id);
        setStatus(result.delivery === "queued" ? "Deletion saved locally; it will retry when connected." : "Message deleted.");
      } catch (error) {
        remove.disabled = false;
        setStatus(readableError(error), true);
      }
    });
    actions.append(remove);
  }
  parent.append(actions);
}

function appendDeletedMessage(messageContent: HTMLElement) {
  const deleted = document.createElement("p");
  deleted.className = "message-deleted muted";
  deleted.textContent = "Message deleted";
  messageContent.append(deleted);
}

function renderMessage(
  message: MessageEnvelope,
  decrypted: { sender: string; content: Record<string, unknown> } | null,
  error?: string,
  options: { grouped: boolean } = { grouped: false },
): boolean {
  const article = document.createElement("article");
  article.className = "message";
  if (options.grouped) article.classList.add("message-compact");
  const senderIdentity = senderLabel(message, decrypted);
  const searchBody = decrypted && typeof decrypted.content.body === "string" ? decrypted.content.body : "";
  article.dataset.messageId = message.id;
  article.dataset.search = `${senderIdentity} ${searchBody} ${error ?? ""}`.toLowerCase();
  article.dataset.senderKey = senderKey(message, decrypted);
  article.dataset.createdAt = message.createdAt;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = senderIdentity.slice(0, 1).toUpperCase();
  avatar.setAttribute("aria-hidden", "true");
  setAvatarStyle(avatar, senderKey(message, decrypted));
  const messageContent = document.createElement("div");
  messageContent.className = "message-content";
  const header = document.createElement("header");
  header.className = "message-meta";
  const sender = document.createElement("button");
  sender.className = "message-sender-link";
  sender.type = "button";
  sender.textContent = senderIdentity;
  if (message.senderUserId) sender.addEventListener("click", () => void openUserProfile(message.senderUserId as string));
  const time = document.createElement("time");
  const createdAt = new Date(message.createdAt);
  time.dateTime = createdAt.toISOString();
  time.title = createdAt.toLocaleString();
  time.textContent = createdAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  header.append(sender, time);
  messageContent.append(header);
  article.append(avatar, messageContent);

  if (!decrypted) {
    const failed = document.createElement("p");
    failed.className = "muted";
    failed.textContent = error ? `Unable to decrypt (${error}).` : "Unable to decrypt this message.";
    messageContent.append(failed);
    messagesPanel.append(article);
    return true;
  }

  const content = decrypted.content;
  if (content.msgtype === "m.redaction" && typeof content.redacts === "string") {
    const target = loadedMessages.find((candidate) => candidate.id === content.redacts);
    if (target?.senderUserId && message.senderUserId && target.senderUserId !== message.senderUserId) return false;
    redactionAuthors.set(content.redacts, message.senderUserId);
    redactedMessageIds.add(content.redacts);
    markMessageDeleted(content.redacts);
    return false;
  }
  const redactionAuthor = redactionAuthors.get(message.id);
  if (redactionAuthor !== undefined && redactionAuthor && message.senderUserId && redactionAuthor !== message.senderUserId) {
    redactedMessageIds.delete(message.id);
    redactionAuthors.delete(message.id);
  }
  if (redactedMessageIds.has(message.id)) appendDeletedMessage(messageContent);
  const body = typeof content.body === "string" ? content.body : "";
  const mediaMessage = content.msgtype === "m.image" || content.msgtype === "m.video" || content.msgtype === "m.file";
  const mentionNames = mentionUsernames(content);
  const mentionedIds = Array.isArray(content.mentions) ? content.mentions : [];
  if (currentUser && mentionedIds.includes(currentUser.id)) article.classList.add("message-mention");
  if (!redactedMessageIds.has(message.id) && !mediaMessage && (content.msgtype === "m.text" || content.msgtype === "m.notice" || body)) {
    appendMarkdown(messageContent, body, { mentionUsernames: mentionNames });
    for (const embed of extractEmbeds(body)) appendSafeEmbed(messageContent, embed);
  }

  if (!redactedMessageIds.has(message.id) && mediaMessage) {
    const fileMessage = content.msgtype === "m.file";
    const video = content.msgtype === "m.video";
    const filename = typeof content.filename === "string" ? content.filename : "";
    const mediaButton = document.createElement("button");
    mediaButton.className = "encrypted-media-button secondary";
    mediaButton.type = "button";
    mediaButton.textContent = `Load encrypted ${fileMessage ? "file" : video ? "video" : "image"}`;
    const mediaProgress = document.createElement("progress");
    mediaProgress.className = "media-load-progress";
    mediaProgress.max = 100;
    mediaProgress.value = 0;
    mediaProgress.hidden = true;
    mediaButton.addEventListener("click", async () => {
      const controller = new AbortController();
      mediaButton.disabled = true;
      mediaProgress.hidden = false;
      mediaButton.textContent = `Loading encrypted ${fileMessage ? "file" : video ? "video" : "image"}…`;
      try {
        const blob = await cryptoClient?.decryptMedia(content, {
          signal: controller.signal,
          onProgress: (loadedBytes, totalBytes) => {
            mediaButton.textContent = totalBytes > 0
              ? `Loading encrypted ${fileMessage ? "file" : video ? "video" : "image"} · ${Math.round((loadedBytes / totalBytes) * 100)}%`
              : `Loading encrypted ${fileMessage ? "file" : video ? "video" : "image"}…`;
            if (totalBytes > 0) mediaProgress.value = Math.round((loadedBytes / totalBytes) * 100);
          },
        });
        if (!blob) throw new Error("crypto_not_initialized");
        if (fileMessage) {
          const download = document.createElement("a");
          download.className = "media-file-download";
          download.href = URL.createObjectURL(blob);
          download.download = filename || "encrypted-file.bin";
          download.textContent = `Download ${filename || "encrypted file"}`;
          mediaProgress.remove();
          mediaButton.replaceWith(download);
          return;
        }
        const preview = document.createElement(video ? "video" : "img");
        preview.className = `media-preview${video ? " video" : ""}`;
        const previewUrl = URL.createObjectURL(blob);
        preview.src = previewUrl;
        if (video) {
          const player = preview as HTMLVideoElement;
          player.controls = true;
          player.preload = "metadata";
        } else {
          (preview as HTMLImageElement).alt = "Encrypted image";
        }
        const mediaWrap = document.createElement("div");
        mediaWrap.className = "media-preview-wrap";
        const viewButton = document.createElement("button");
        viewButton.className = "media-view-button secondary";
        viewButton.type = "button";
        viewButton.textContent = `Open ${video ? "video" : "image"} viewer`;
        viewButton.addEventListener("click", () => openMediaViewer(blob, filename, video));
        if (!video) preview.addEventListener("click", () => openMediaViewer(blob, filename, false));
        mediaWrap.append(preview, viewButton);
        mediaProgress.remove();
        mediaButton.replaceWith(mediaWrap);
      } catch (loadError) {
        mediaButton.disabled = false;
        mediaProgress.hidden = true;
        mediaButton.textContent = `${fileMessage ? "File" : video ? "Video" : "Image"} unavailable: ${readableError(loadError)}`;
      }
    });
    messageContent.append(mediaButton, mediaProgress);
  }

  const reply = replyReferenceFromContent(content);
  if (reply) {
    const replyContext = document.createElement("button");
    replyContext.className = "reply-context";
    replyContext.type = "button";
    replyContext.title = "Jump to replied message";
    replyContext.textContent = `↪ ${reply.sender}: ${(reply.body || "Encrypted message").replace(/\s+/g, " ").slice(0, 180)}`;
    replyContext.addEventListener("click", () => void scrollToMessage(reply.messageId));
    messageContent.insertBefore(replyContext, messageContent.children[1] ?? null);
  }
  if (!redactedMessageIds.has(message.id)) appendMessageActions(messageContent, message, senderIdentity, body);

  messagesPanel.append(article);
  return true;
}

async function renderMessageHistory(options: { scrollAnchor?: ScrollAnchor; scrollToBottom?: boolean } = {}) {
  if (!selectedConversationId || !cryptoClient) return;
  const conversationId = selectedConversationId;
  const activeCryptoClient = cryptoClient;
  if (conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
  messagesPanel.replaceChildren();
  messagesPanel.append(loadOlderButton);
  loadOlderButton.hidden = !nextBefore;
  if (loadedMessages.length === 0) {
    renderConversationWelcome("This is the beginning", "Send a message to start this encrypted conversation.");
    return;
  }

  let previousSender = "";
  let previousTimestamp = 0;
  let previousDay = "";
  for (const message of loadedMessages) {
    if (conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    let decrypted: { sender: string; content: Record<string, unknown> } | null = null;
    let error: string | undefined;
    try {
      decrypted = await activeCryptoClient.decryptMessage(conversationId, message);
    } catch (caught) {
      error = readableError(caught);
    }
    const created = new Date(message.createdAt);
    const currentDay = dateKey(created);
    const sameDay = currentDay === previousDay;
    const dayChanged = currentDay !== previousDay;
    const previousDayBeforeMessage = previousDay;
    let divider: HTMLElement | undefined;
    if (dayChanged) {
      divider = appendDateDivider(created);
      previousDay = currentDay;
    }
    const currentSender = senderKey(message, decrypted);
    const currentTimestamp = created.getTime();
    const grouped = sameDay && currentSender === previousSender && currentTimestamp - previousTimestamp <= 5 * 60 * 1000;
    const rendered = renderMessage(message, decrypted, error, { grouped });
    if (!rendered) {
      divider?.remove();
      previousDay = previousDayBeforeMessage;
      continue;
    }
    previousSender = currentSender;
    previousTimestamp = currentTimestamp;
  }
  applyMessageSearch();
  if (options.scrollAnchor) {
    restoreScrollAnchor(options.scrollAnchor);
  } else if (options.scrollToBottom !== false) {
    messagesPanel.scrollTop = messagesPanel.scrollHeight;
  }
}

async function appendNewMessages(messages: MessageEnvelope[], conversationId: string, activeCryptoClient: CryptoClient) {
  const previousArticle = messagesPanel.querySelector<HTMLElement>(".message:last-of-type");
  let previousDay = previousArticle?.dataset.createdAt ? dateKey(new Date(previousArticle.dataset.createdAt)) : "";
  let previousSender = previousArticle?.dataset.senderKey ?? "";
  let previousTimestamp = previousArticle?.dataset.createdAt ? Date.parse(previousArticle.dataset.createdAt) : 0;

  for (const message of messages) {
    if (conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    let decrypted: { sender: string; content: Record<string, unknown> } | null = null;
    let error: string | undefined;
    try {
      decrypted = await activeCryptoClient.decryptMessage(conversationId, message);
    } catch (caught) {
      error = readableError(caught);
    }
    const created = new Date(message.createdAt);
    const currentDay = dateKey(created);
    const currentSender = senderKey(message, decrypted);
    const currentTimestamp = created.getTime();
    const sameDay = currentDay === previousDay;
    const dayChanged = !sameDay;
    const previousDayBeforeMessage = previousDay;
    let divider: HTMLElement | undefined;
    if (dayChanged) {
      divider = appendDateDivider(created);
      previousDay = currentDay;
    }
    const grouped = sameDay && currentSender === previousSender && currentTimestamp - previousTimestamp <= 5 * 60 * 1000;
    const rendered = renderMessage(message, decrypted, error, { grouped });
    if (!rendered) {
      divider?.remove();
      previousDay = previousDayBeforeMessage;
      continue;
    }
    previousSender = currentSender;
    previousTimestamp = currentTimestamp;
  }
  applyMessageSearch();
}

async function fetchNewerMessages(conversationId: string, activeCryptoClient: CryptoClient, selection: number, after: string) {
  const messages: MessageEnvelope[] = [];
  let cursor = after;
  let nextCursor: string | null = null;
  for (let page = 0; page < MAX_CATCH_UP_PAGES; page += 1) {
    const result = await api.messages(conversationId, { after: cursor, limit: MESSAGE_PAGE_SIZE });
    if (selection !== selectionToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return null;
    messages.push(...result.messages);
    nextCursor = result.nextAfter;
    if (!result.nextAfter || result.nextAfter === cursor || result.messages.length === 0) break;
    cursor = result.nextAfter;
  }
  return { messages, nextAfter: nextCursor };
}

async function refreshMessages(options: { forceScrollToBottom?: boolean } = {}) {
  if (!selectedConversationId || !cryptoClient || messagesLoading || olderMessagesLoading) return;
  const conversationId = selectedConversationId;
  const activeCryptoClient = cryptoClient;
  const selection = selectionToken;
  messagesLoading = true;
  try {
    await activeCryptoClient.syncToDevice();
    if (selection !== selectionToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;

    if (options.forceScrollToBottom || loadedMessages.length === 0) {
      const result = await api.messages(conversationId, { limit: MESSAGE_PAGE_SIZE });
      if (selection !== selectionToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
      loadedMessages = sortMessages(result.messages).slice(-MAX_RENDERED_MESSAGES);
      nextBefore = result.nextBefore;
      nextAfter = null;
      observeLatestMessages(loadedMessages);
      lastMessagesKey = messagesKey();
      await renderMessageHistory({ scrollToBottom: true });
      clearUnread();
      return;
    }

    const previousMessages = loadedMessages;
    const previousIds = new Set(previousMessages.map((message) => message.id));
    const wasNearBottom = messagesPanel.scrollHeight - messagesPanel.scrollTop - messagesPanel.clientHeight < 100;
    const followLatest = options.forceScrollToBottom || wasNearBottom;
    const previousLast = previousMessages[previousMessages.length - 1];
    if (!previousLast) return;
    const catchUpCursor = followLatest || latestObservedSequence === null
      ? previousLast.serverSequence
      : latestObservedSequence.toString();
    const caughtUp = await fetchNewerMessages(conversationId, activeCryptoClient, selection, catchUpCursor);
    if (!caughtUp || selection !== selectionToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    const unseen = countUnseenMessages(caughtUp.messages);
    const newMessages = caughtUp.messages.filter((message) => !previousIds.has(message.id));

    if (!followLatest) {
      if (unseen > 0) {
        unreadCount += unseen;
      }
      nextAfter = caughtUp.messages.length > 0 ? previousLast.serverSequence : caughtUp.nextAfter;
      renderUnreadButton();
      return;
    }

    if (newMessages.length === 0) {
      nextAfter = caughtUp.nextAfter;
      messagesPanel.scrollTop = messagesPanel.scrollHeight;
      clearUnread();
      return;
    }

    const merged = mergeMessageWindow(newMessages, "newer");
    nextAfter = caughtUp.nextAfter;
    lastMessagesKey = messagesKey();
    const appendOnly = merged.trimmed === 0 && previousMessages.length > 0;
    if (appendOnly) await appendNewMessages(newMessages, conversationId, activeCryptoClient);
    else await renderMessageHistory({ scrollToBottom: true });
    messagesPanel.scrollTop = messagesPanel.scrollHeight;
    clearUnread();
  } finally {
    messagesLoading = false;
  }
}

async function loadOlderMessages() {
  if (!selectedConversationId || !cryptoClient || !nextBefore || olderMessagesLoading || messagesLoading) return;
  const conversationId = selectedConversationId;
  const activeCryptoClient = cryptoClient;
  const selection = selectionToken;
  const cursor = nextBefore;
  olderMessagesLoading = true;
  loadOlderButton.disabled = true;
  loadOlderButton.textContent = "Loading older messages…";
  const beforeHeight = messagesPanel.scrollHeight;
  const beforeTop = messagesPanel.scrollTop;
  const scrollAnchor = captureScrollAnchor();
  try {
    const result = await api.messages(conversationId, { before: cursor, limit: MESSAGE_PAGE_SIZE });
    if (selection !== selectionToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    const merged = mergeMessageWindow(result.messages, "older");
    nextBefore = result.nextBefore;
    lastMessagesKey = messagesKey();
    await renderMessageHistory({ scrollAnchor: scrollAnchor ?? undefined, scrollToBottom: false });
    if (!scrollAnchor) messagesPanel.scrollTop = beforeTop + (messagesPanel.scrollHeight - beforeHeight);
    if (merged.trimmed > 0 && loadedMessages.length > 0) nextAfter = loadedMessages[loadedMessages.length - 1].serverSequence;
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    olderMessagesLoading = false;
    loadOlderButton.disabled = false;
    loadOlderButton.textContent = "Load older messages";
    loadOlderButton.hidden = !nextBefore;
  }
}

async function encryptAndStoreMetadata(serverId: string, channel: ServerChannel, channelName: string, serverName?: string) {
  if (!cryptoClient) throw new Error("crypto_not_initialized");
  const members = (await api.conversationMembers(channel.conversationId)).members;
  const normalizedChannelName = channelName.trim().slice(0, 80);
  const channelCiphertext = await cryptoClient.encryptMetadata(channel.conversationId, members, {
    name: normalizedChannelName,
    kind: "text",
  });
  await api.updateChannel(serverId, channel.id, { encryptedMetadata: channelCiphertext });
  channelLabels.set(channel.id, normalizedChannelName);
  if (serverName) {
    const serverCiphertext = await cryptoClient.encryptMetadata(channel.conversationId, members, {
      name: serverName.trim().slice(0, 80),
      kind: "server",
    });
    await api.updateServer(serverId, serverCiphertext);
    serverLabels.set(serverId, serverName.trim().slice(0, 80));
  }
}

async function createServer() {
  if (!cryptoClient) return;
  const name = window.prompt("Name this private server", "My private server")?.trim();
  if (!name) return;
  createServerButton.disabled = true;
  setStatus("Creating encrypted server…");
  try {
    const result = await api.createServer();
    await encryptAndStoreMetadata(result.server.id, result.channel, "general", name);
    serverLabels.set(result.server.id, name.slice(0, 80));
    channelLabels.set(result.channel.id, "general");
    await refreshServers();
    await selectServer(result.server.id, result.channel.id);
    setStatus("Encrypted server is ready.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    createServerButton.disabled = false;
    renderServers();
  }
}

async function createChannel() {
  const server = selectedServerId ? servers.find((item) => item.id === selectedServerId) : undefined;
  if (!server || !cryptoClient) return;
  const name = window.prompt("Name this encrypted text channel", "new-channel")?.trim();
  if (!name) return;
  createChannelButton.disabled = true;
  setStatus("Creating encrypted channel…");
  try {
    const result = await api.createChannel(server.id);
    await encryptAndStoreMetadata(server.id, result.channel, name);
    await refreshServers();
    await selectServer(server.id, result.channel.id);
    setStatus("Encrypted channel is ready.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    createChannelButton.disabled = false;
    renderServers();
  }
}

async function createInvite() {
  const server = selectedServerId ? servers.find((item) => item.id === selectedServerId) : undefined;
  if (!server) return;
  serverInviteButton.disabled = true;
  try {
    const result = await api.createServerInvite(server.id, { maxUses: 0, expiresInSeconds: 7 * 24 * 60 * 60 });
    const token = result.invite.token;
    try {
      await navigator.clipboard?.writeText(token);
    } catch {
      // Clipboard permissions are optional; the token is still shown once below.
    }
    window.alert(`Invite token (copy it now):\n\n${token}`);
    setStatus("Invite created. Anyone with the token can request access.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    serverInviteButton.disabled = false;
  }
}

async function joinServer() {
  const token = window.prompt("Paste a server invite token")?.trim();
  if (!token) return;
  joinServerButton.disabled = true;
  try {
    const result = await api.acceptInvite(token);
    await refreshServers();
    await selectServer(result.serverId);
    setStatus("You joined the encrypted server.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    joinServerButton.disabled = false;
  }
}

function resizeMessageInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`;
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedConversationId || !cryptoClient) return;
  const text = messageInput.value.trim();
  const file = photoInput.files?.[0];
  if (!text && !file) return;
  sendButton.disabled = true;
  const uploadController = file ? new AbortController() : undefined;
  uploadAbortController = uploadController;
  try {
    let queued = false;
    if (text) queued = (await cryptoClient.sendText(selectedConversationId, selectedMembers, text, extractEmbeds(text), replyTarget, mentionedUserIds(text))).delivery === "queued";
    if (file) {
      const attachmentKind = file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : "file";
      attachmentLabel.textContent = `Preparing encrypted ${attachmentKind}…`;
      uploadProgress.value = 0;
      uploadProgress.hidden = false;
      queued ||= (await cryptoClient.sendMedia(selectedConversationId, selectedMembers, file, {
        signal: uploadController?.signal,
        onProgress: (loadedBytes, totalBytes) => {
          const percent = totalBytes > 0 ? Math.round((loadedBytes / totalBytes) * 100) : 0;
          attachmentLabel.textContent = `Uploading encrypted ${attachmentKind} · ${percent}%`;
          uploadProgress.value = percent;
        },
      })).delivery === "queued";
    }
    messageInput.value = "";
    if (selectedConversationId) drafts.delete(selectedConversationId);
    clearReplyTarget();
    photoInput.value = "";
    attachmentPreview.hidden = true;
    uploadProgress.hidden = true;
    resizeMessageInput();
    setStatus(queued ? "Message saved locally; it will retry when connected." : "Encrypted message sent.");
    await refreshMessages({ forceScrollToBottom: true });
  } catch (error) {
    setStatus(readableError(error), true);
    if (error instanceof Error && error.name === "AbortError") attachmentLabel.textContent = "Upload canceled · remove or retry";
  } finally {
    if (uploadAbortController === uploadController) uploadAbortController = undefined;
    updateComposerState();
  }
});

messageInput.addEventListener("keydown", (event) => {
  if (!mentionSuggestions.hidden && (event.key === "Tab" || event.key === "ArrowDown")) {
    event.preventDefault();
    mentionSuggestions.querySelector<HTMLButtonElement>("button")?.focus();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

messageInput.addEventListener("input", resizeMessageInput);
messageInput.addEventListener("input", () => rememberDraft());
messageInput.addEventListener("input", renderMentionSuggestions);

photoInput.addEventListener("change", () => {
  const file = photoInput.files?.[0];
  attachmentPreview.hidden = !file;
  uploadProgress.hidden = true;
  uploadProgress.value = 0;
  if (file) attachmentLabel.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
});

clearAttachment.addEventListener("click", () => {
  if (uploadAbortController) {
    uploadAbortController.abort();
    return;
  }
  photoInput.value = "";
  attachmentPreview.hidden = true;
  uploadProgress.hidden = true;
  uploadProgress.value = 0;
});

cancelReply.addEventListener("click", clearReplyTarget);

conversationSearch.addEventListener("input", () => {
  conversationSearchQuery = conversationSearch.value;
  renderConversations();
  renderChannels();
});

mobileServerSelect.addEventListener("change", () => {
  if (mobileServerSelect.value) void selectServer(mobileServerSelect.value);
  else void showDirectMessages();
});

homeRailButton.addEventListener("click", () => void showDirectMessages());
createServerButton.addEventListener("click", () => void createServer());
joinServerButton.addEventListener("click", () => void joinServer());
createChannelButton.addEventListener("click", () => void createChannel());
serverInviteButton.addEventListener("click", () => void createInvite());

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    conversationSearch.focus();
    conversationSearch.select();
  }
  if (event.key === "Escape" && !messageSearchContainer.hidden) closeMessageSearch();
  if (event.key === "Escape" && !mentionSuggestions.hidden) hideMentionSuggestions();
  if (event.key === "Escape" && !mediaViewer.hidden) closeMediaViewer();
  if (event.key === "Escape" && !profileModal.hidden) profileModal.hidden = true;
});

function closeMessageSearch() {
  messageSearchQuery = "";
  messageSearch.value = "";
  messageSearchContainer.hidden = true;
  messageSearchToggle.setAttribute("aria-expanded", "false");
  applyMessageSearch();
}

messageSearchToggle.addEventListener("click", () => {
  messageSearchContainer.hidden = false;
  messageSearchToggle.setAttribute("aria-expanded", "true");
  messageSearch.focus();
});

messageSearchClose.addEventListener("click", closeMessageSearch);
messageSearch.addEventListener("input", () => {
  messageSearchQuery = messageSearch.value;
  applyMessageSearch();
});

mediaViewerClose.addEventListener("click", closeMediaViewer);
mediaViewer.addEventListener("click", (event) => {
  if (event.target === mediaViewer) closeMediaViewer();
});
profileModalClose.addEventListener("click", () => { profileModal.hidden = true; });
profileModal.addEventListener("click", (event) => {
  if (event.target === profileModal) profileModal.hidden = true;
});

detailsToggle.addEventListener("click", () => {
  const compact = window.matchMedia("(max-width: 1120px)").matches;
  const open = compact
    ? chatLayout.classList.toggle("details-open")
    : !chatLayout.classList.toggle("details-hidden");
  detailsToggle.setAttribute("aria-expanded", String(open));
});

detailsClose.addEventListener("click", () => {
  if (window.matchMedia("(max-width: 1120px)").matches) chatLayout.classList.remove("details-open");
  else chatLayout.classList.add("details-hidden");
  detailsToggle.setAttribute("aria-expanded", "false");
});

loadOlderButton.addEventListener("click", () => void loadOlderMessages());
jumpLatestButton.addEventListener("click", () => {
  void refreshMessages({ forceScrollToBottom: true }).catch((error) => setStatus(readableError(error), true));
});
messagesPanel.addEventListener("scroll", () => {
  const distanceFromBottom = messagesPanel.scrollHeight - messagesPanel.scrollTop - messagesPanel.clientHeight;
  if (distanceFromBottom < 100) {
    clearUnread();
    if (nextAfter) void refreshMessages();
  } else renderUnreadButton();
  if (messagesPanel.scrollTop < 240 && nextBefore) void loadOlderMessages();
});
lockButton.addEventListener("click", () => {
  clearSessionPassphrase();
  cryptoClient?.close();
  const returnPath = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/unlock?manual=1&return=${encodeURIComponent(returnPath)}`);
});

function syncDetailsButton() {
  const compact = window.matchMedia("(max-width: 1120px)").matches;
  if (compact) chatLayout.classList.remove("details-hidden");
  else chatLayout.classList.remove("details-open");
  const open = compact ? chatLayout.classList.contains("details-open") : !chatLayout.classList.contains("details-hidden");
  detailsToggle.setAttribute("aria-expanded", String(open));
}

window.addEventListener("resize", syncDetailsButton);
syncDetailsButton();

function setMobileSidebar(open: boolean) {
  chatLayout.classList.toggle("mobile-sidebar-open", open);
  mobileSidebarToggle.setAttribute("aria-expanded", String(open));
}

mobileSidebarToggle.addEventListener("click", () => {
  setMobileSidebar(!chatLayout.classList.contains("mobile-sidebar-open"));
});
mobileSidebarBackdrop.addEventListener("click", () => setMobileSidebar(false));

updateComposerState();
resizeMessageInput();

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
    if (cryptoClient) {
      void cryptoClient.syncToDevice()
        .then(() => flushOutbox())
        .then(() => refreshMessages())
        .catch(() => undefined);
    }
  }, 2000);
}

void boot();
