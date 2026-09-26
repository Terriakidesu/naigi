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
import { CryptoClient } from "./crypto";
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
let conversationSearchQuery = "";
let messageSearchQuery = "";
const drafts = new Map<string, string>();
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
const conversationTitle = byId<HTMLElement>("conversation-title");
const conversationSubtitle = byId<HTMLElement>("conversation-subtitle");
const messagesPanel = byId<HTMLElement>("messages");
const memberList = byId<HTMLElement>("member-list");
const serverList = byId<HTMLElement>("server-list");
const channelSectionHeading = byId<HTMLElement>("channel-section-heading");
const channelList = byId<HTMLElement>("channel-list");
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
const clearAttachment = byId<HTMLButtonElement>("clear-attachment");
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

function setStatus(message: string, error = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", error);
}

function readableError(error: unknown) {
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
  cryptoClient?.close();
  cryptoClient = new CryptoClient(api, currentUser.id, localPassphrase);
  await cryptoClient.initialize();
  userLabel.textContent = `${currentUser.displayName} (@${currentUser.username})`;
  await refreshServers();
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
    setStatus("Encrypted chat is connected.");
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
  conversationList.replaceChildren();
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
    const row = document.createElement("div");
    const memberName = member.userId === currentUser?.id ? currentUser?.displayName ?? "You" : member.displayName || `@${member.username}`;
    row.className = "member-row";
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
  jumpLatestButton.hidden = true;
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

function renderMessage(
  message: MessageEnvelope,
  decrypted: { sender: string; content: Record<string, unknown> } | null,
  error?: string,
  options: { grouped: boolean } = { grouped: false },
) {
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
  const sender = document.createElement("strong");
  sender.textContent = senderIdentity;
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
    return;
  }

  const content = decrypted.content;
  const body = typeof content.body === "string" ? content.body : "";
  if (content.msgtype === "m.text" || content.msgtype === "m.notice" || body) {
    appendMarkdown(messageContent, body);
    for (const embed of extractEmbeds(body)) appendSafeEmbed(messageContent, embed);
  }

  if (content.msgtype === "m.image") {
    const photoButton = document.createElement("button");
    photoButton.className = "encrypted-photo-button secondary";
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

async function renderMessageHistory(options: { previousScrollTop?: number; preserveScroll?: boolean } = {}) {
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
    if (currentDay !== previousDay) {
      appendDateDivider(created);
      previousDay = currentDay;
    }
    const currentSender = senderKey(message, decrypted);
    const currentTimestamp = created.getTime();
    const grouped = sameDay && currentSender === previousSender && currentTimestamp - previousTimestamp <= 5 * 60 * 1000;
    renderMessage(message, decrypted, error, { grouped });
    previousSender = currentSender;
    previousTimestamp = currentTimestamp;
  }
  applyMessageSearch();
  if (options.preserveScroll && options.previousScrollTop !== undefined) {
    messagesPanel.scrollTop = options.previousScrollTop;
  } else {
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
    if (!sameDay) {
      appendDateDivider(created);
      previousDay = currentDay;
    }
    const grouped = sameDay && currentSender === previousSender && currentTimestamp - previousTimestamp <= 5 * 60 * 1000;
    renderMessage(message, decrypted, error, { grouped });
    previousSender = currentSender;
    previousTimestamp = currentTimestamp;
  }
  applyMessageSearch();
}

async function refreshMessages(options: { forceScrollToBottom?: boolean } = {}) {
  if (!selectedConversationId || !cryptoClient || messagesLoading) return;
  const conversationId = selectedConversationId;
  const activeCryptoClient = cryptoClient;
  messagesLoading = true;
  try {
    await activeCryptoClient.syncToDevice();
    if (conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    const result = await api.messages(conversationId);
    if (conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    const previousMessages = loadedMessages;
    const previousIds = new Set(previousMessages.map((message) => message.id));
    const newMessages = result.messages.filter((message) => !previousIds.has(message.id));
    const previousLastSequence = previousMessages[previousMessages.length - 1]?.serverSequence;
    const appendOnly = Boolean(previousLastSequence && newMessages.length > 0 && newMessages.every((message) => BigInt(message.serverSequence) > BigInt(previousLastSequence)));
    const wasNearBottom = messagesPanel.scrollHeight - messagesPanel.scrollTop - messagesPanel.clientHeight < 100;
    const followLatest = options.forceScrollToBottom || wasNearBottom;
    const previousScrollTop = messagesPanel.scrollTop;
    const byId = new Map(previousMessages.map((message) => [message.id, message]));
    for (const message of result.messages) byId.set(message.id, message);
    loadedMessages = [...byId.values()].sort((left, right) => Number(BigInt(left.serverSequence) - BigInt(right.serverSequence)));
    if (previousMessages.length === 0) nextBefore = result.nextBefore;
    else if (nextBefore === null) nextBefore = result.nextBefore;
    const messageKey = loadedMessages.map((message) => `${message.id}:${message.createdAt}`).join("|");
    if (messageKey === lastMessagesKey) {
      applyMessageSearch();
      loadOlderButton.hidden = !nextBefore;
      if (followLatest) {
        messagesPanel.scrollTop = messagesPanel.scrollHeight;
        jumpLatestButton.hidden = true;
      }
      return;
    }
    lastMessagesKey = messageKey;
    if (appendOnly) {
      await appendNewMessages(newMessages, conversationId, activeCryptoClient);
      if (followLatest) {
        messagesPanel.scrollTop = messagesPanel.scrollHeight;
        jumpLatestButton.hidden = true;
      } else {
        jumpLatestButton.hidden = false;
      }
    } else {
      await renderMessageHistory({
        previousScrollTop,
        preserveScroll: !followLatest && previousMessages.length > 0,
      });
      jumpLatestButton.hidden = followLatest || previousMessages.length === 0;
    }
  } finally {
    messagesLoading = false;
  }
}

async function loadOlderMessages() {
  if (!selectedConversationId || !nextBefore || olderMessagesLoading) return;
  olderMessagesLoading = true;
  loadOlderButton.disabled = true;
  const beforeHeight = messagesPanel.scrollHeight;
  const beforeTop = messagesPanel.scrollTop;
  try {
    const result = await api.messages(selectedConversationId, nextBefore);
    const byId = new Map(result.messages.concat(loadedMessages).map((message) => [message.id, message]));
    loadedMessages = [...byId.values()].sort((left, right) => Number(BigInt(left.serverSequence) - BigInt(right.serverSequence)));
    nextBefore = result.nextBefore;
    lastMessagesKey = loadedMessages.map((message) => `${message.id}:${message.createdAt}`).join("|");
    await renderMessageHistory();
    messagesPanel.scrollTop = beforeTop + (messagesPanel.scrollHeight - beforeHeight);
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    olderMessagesLoading = false;
    loadOlderButton.disabled = false;
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
  try {
    if (text) await cryptoClient.sendText(selectedConversationId, selectedMembers, text, extractEmbeds(text));
    if (file) await cryptoClient.sendPhoto(selectedConversationId, selectedMembers, file);
    messageInput.value = "";
    if (selectedConversationId) drafts.delete(selectedConversationId);
    photoInput.value = "";
    attachmentPreview.hidden = true;
    resizeMessageInput();
    await refreshMessages({ forceScrollToBottom: true });
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    updateComposerState();
  }
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

messageInput.addEventListener("input", resizeMessageInput);
messageInput.addEventListener("input", () => rememberDraft());

photoInput.addEventListener("change", () => {
  const file = photoInput.files?.[0];
  attachmentPreview.hidden = !file;
  if (file) attachmentLabel.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
});

clearAttachment.addEventListener("click", () => {
  photoInput.value = "";
  attachmentPreview.hidden = true;
});

conversationSearch.addEventListener("input", () => {
  conversationSearchQuery = conversationSearch.value;
  renderConversations();
  renderChannels();
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
  messagesPanel.scrollTo({ top: messagesPanel.scrollHeight, behavior: "smooth" });
  jumpLatestButton.hidden = true;
});
messagesPanel.addEventListener("scroll", () => {
  if (messagesPanel.scrollHeight - messagesPanel.scrollTop - messagesPanel.clientHeight < 100) jumpLatestButton.hidden = true;
});
lockButton.addEventListener("click", () => {
  clearSessionPassphrase();
  cryptoClient?.close();
  const returnPath = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/unlock?return=${encodeURIComponent(returnPath)}`);
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
    if (cryptoClient) void cryptoClient.syncToDevice().then(() => refreshMessages()).catch(() => undefined);
  }, 2000);
}

void boot();
