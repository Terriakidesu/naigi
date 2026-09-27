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
import { CryptoClient, type DecryptedMessage, type ReplyReference } from "./crypto";
import { roomKeyUnavailable } from "./decryption";
import { appendSafeEmbed, extractEmbeds, type SafeEmbed } from "./embeds";
import { appendMarkdown } from "./markdown";
import { deleteCachedMessages, readCachedMessages, writeCachedMessages } from "./message-cache";
import { messageGroupState, shouldGroupMessage, type MessageGroupState } from "./message-grouping";
import { confirmLocalUnlock, lockLocalSession, resolveLocalPassphrase } from "./unlock-vault";
import { askText, showOneTimeToken } from "./ui-dialog";

const api = new ApiClient();
let currentUser: User | undefined;
let cryptoClient: CryptoClient | undefined;
let selectedConversationId: string | undefined;
let selectedMembers: ConversationMember[] = [];
let conversations: Conversation[] = [];
let servers: Server[] = [];
let channels: ServerChannel[] = [];
const channelsByServer = new Map<string, ServerChannel[]>();
let categories: ServerCategory[] = [];
let selectedServerId: string | undefined;
let selectedChannelId: string | undefined;
const serverLabels = new Map<string, string>();
const channelLabels = new Map<string, string>();
const categoryLabels = new Map<string, string>();
const collapsedCategories = new Set<string>();
let realtime: WebSocket | undefined;
let realtimeReadySocket: WebSocket | undefined;
const seenRealtimeMessageIds = new Set<string>();
const pendingMentionNotifications = new Set<string>();
const mentionHighlightMessageIds = new Set<string>();
const notifiedRealtimeMessageIds = new Set<string>();
let messagesLoading = false;
let olderMessagesLoading = false;
let lastMessagesKey = "__not-rendered__";
let loadedMessages: MessageEnvelope[] = [];
let nextBefore: string | null = null;
let nextAfter: string | null = null;
let latestObservedSequence: bigint | null = null;
let messageRenderToken = 0;
let messageRenderLock: Promise<void> | undefined;
const optimisticDecryptedMessages = new Map<string, DecryptedMessage>();
let conversationSearchQuery = "";
let messageSearchQuery = "";
const drafts = new Map<string, string>();
let replyTarget: ReplyReference | undefined;
let unreadCount = 0;
let uploadAbortController: AbortController | undefined;
let sendInProgress = false;
let conversationReady = false;
const pendingMediaLoads = new Map<HTMLElement, AbortController>();
type EditTarget = { messageId: string; body: string; sender: string };
type ContextMessage = { message: MessageEnvelope; article: HTMLElement; sender: string; body: string; editable: boolean };
type ReactionOption = { emoji: string; code: string; label: string };
const reactionOptions: ReactionOption[] = [
  { emoji: "👍", code: "1f44d", label: "Like" },
  { emoji: "❤️", code: "2764", label: "Love" },
  { emoji: "😂", code: "1f602", label: "Laugh" },
  { emoji: "😮", code: "1f62e", label: "Surprised" },
  { emoji: "😢", code: "1f622", label: "Sad" },
  { emoji: "😡", code: "1f621", label: "Angry" },
  { emoji: "🎉", code: "1f389", label: "Celebrate" },
  { emoji: "🚀", code: "1f680", label: "Boost" },
  { emoji: "👀", code: "1f440", label: "Watching" },
  { emoji: "✅", code: "2705", label: "Done" },
];
const emojiOptions = [
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣",
  "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩",
  "😘", "😎", "🤔", "🙄", "😴", "🤗", "🤭", "🤫",
  "😐", "😶", "😮", "😱", "😭", "😡", "🤝", "👍",
  "👎", "👏", "🙏", "💪", "❤️", "🔥", "✨", "🎉",
  "🚀", "✅", "❌", "💯", "👀", "🍕", "☕", "🎂",
];
let editTarget: EditTarget | undefined;
let contextMessage: ContextMessage | undefined;
const messageContextTargets = new Map<string, ContextMessage>();
const unavailableMessageNotices = new Map<string, HTMLElement>();
const messageReactions = new Map<string, Map<string, Set<string>>>();
const reactionEvents = new Map<string, { targetId: string; key: string; senderKey: string; action: "add" | "remove" }>();
const pinnedMessageIds = new Set<string>();
const editedMessageBodies = new Map<string, { body: string; embeds: SafeEmbed[]; mentions: string[] }>();
type UnreadMarker = { count: number; lastSequence: string };
type PresenceState = "online" | "idle" | "offline";
const unreadMarkers = new Map<string, UnreadMarker>();
const presenceByUser = new Map<string, PresenceState>();
const typingUsers = new Map<string, number>();
const typingTimers = new Map<string, number>();
let localTypingConversationId: string | undefined;
let localTypingStopTimer: number | undefined;
let lastRoomKeyRefreshAt = 0;
let notificationsEnabled = false;
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
const sidebar = byId<HTMLElement>("workspace-sidebar");
const statusLine = byId<HTMLElement>("status-line");
const connectionIndicator = byId<HTMLElement>("connection-indicator");
const chatToast = byId<HTMLElement>("chat-toast");
const chatToastText = byId<HTMLElement>("chat-toast-text");
const chatToastClose = byId<HTMLButtonElement>("chat-toast-close");
const outboxNotice = byId<HTMLElement>("outbox-notice");
const outboxLabel = byId<HTMLElement>("outbox-label");
const outboxRetry = byId<HTMLButtonElement>("outbox-retry");
const typingIndicator = byId<HTMLElement>("typing-indicator");
const userLabel = byId<HTMLElement>("user-label");
const selfAvatar = byId<HTMLElement>("self-avatar");
const selfProfileButton = byId<HTMLButtonElement>("self-profile-button");
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
const mobileCreateServerButton = byId<HTMLButtonElement>("mobile-create-server");
const mobileJoinServerButton = byId<HTMLButtonElement>("mobile-join-server");
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
const editPreview = byId<HTMLElement>("edit-preview");
const editPreviewText = byId<HTMLElement>("edit-preview-text");
const cancelEdit = byId<HTMLButtonElement>("cancel-edit");
const replyPreview = byId<HTMLElement>("reply-preview");
const replyPreviewText = byId<HTMLElement>("reply-preview-text");
const replyMentionToggle = byId<HTMLButtonElement>("reply-mention-toggle");
const cancelReply = byId<HTMLButtonElement>("cancel-reply");
const mentionSuggestions = byId<HTMLElement>("mention-suggestions");
const emojiPicker = byId<HTMLElement>("emoji-picker");
const emojiToggle = byId<HTMLButtonElement>("emoji-toggle");
const lockButton = byId<HTMLButtonElement>("lock-button");
const mobileSidebarToggle = byId<HTMLButtonElement>("mobile-sidebar-toggle");
const mobileSidebarClose = byId<HTMLButtonElement>("mobile-sidebar-close");
const mobileSidebarBackdrop = byId<HTMLButtonElement>("mobile-sidebar-backdrop");
const messageSearchToggle = byId<HTMLButtonElement>("message-search-toggle");
const notificationToggle = byId<HTMLButtonElement>("notification-toggle");
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
const mediaZoomOut = byId<HTMLButtonElement>("media-zoom-out");
const mediaZoomIn = byId<HTMLButtonElement>("media-zoom-in");
const mediaZoomReset = byId<HTMLButtonElement>("media-zoom-reset");
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
const messageContextMenu = byId<HTMLElement>("message-context-menu");
let toastTimeout: number | undefined;
let profileRequest = 0;
let modalReturnFocus: HTMLElement | null = null;

function setStatus(message: string, error = false) {
  window.clearTimeout(toastTimeout);
  chatToastText.textContent = message;
  chatToast.classList.toggle("error", error);
  chatToast.hidden = false;
  toastTimeout = window.setTimeout(() => { chatToast.hidden = true; }, error ? 8_000 : 4_000);
}

function notificationsSupported() {
  return typeof Notification !== "undefined";
}

function notificationStorageKey() {
  return currentUser ? `priv-chat.notifications.${currentUser.id}` : "priv-chat.notifications";
}

function saveNotificationPreference() {
  try {
    if (notificationsEnabled) localStorage.setItem(notificationStorageKey(), "enabled");
    else localStorage.removeItem(notificationStorageKey());
  } catch {
    // Notification preference is optional and never blocks chat startup.
  }
}

function updateNotificationToggle() {
  const supported = notificationsSupported();
  const active = supported && notificationsEnabled && Notification.permission === "granted";
  notificationToggle.disabled = !supported;
  notificationToggle.setAttribute("aria-pressed", String(active));
  notificationToggle.textContent = "♢";
  notificationToggle.title = !supported
    ? "Desktop notifications are unavailable"
    : active
      ? "Disable desktop notifications"
      : "Enable desktop notifications";
  notificationToggle.setAttribute("aria-label", notificationToggle.title);
}

function loadNotificationPreference() {
  let enabled = false;
  try {
    enabled = localStorage.getItem(notificationStorageKey()) === "enabled";
  } catch {
    // Continue with notifications disabled.
  }
  notificationsEnabled = enabled && notificationsSupported() && Notification.permission === "granted";
  updateNotificationToggle();
}

async function toggleNotifications() {
  if (!notificationsSupported()) {
    setStatus("This browser does not support desktop notifications.", true);
    return;
  }
  if (notificationsEnabled) {
    notificationsEnabled = false;
    saveNotificationPreference();
    updateNotificationToggle();
    setStatus("Desktop notifications disabled.");
    return;
  }
  if (Notification.permission === "denied") {
    setStatus("Notifications are blocked in this browser. Allow them in site settings first.", true);
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    notificationsEnabled = permission === "granted";
    saveNotificationPreference();
    updateNotificationToggle();
    setStatus(notificationsEnabled ? "Desktop notifications enabled." : "Desktop notifications were not enabled.", !notificationsEnabled);
  } catch {
    notificationsEnabled = false;
    updateNotificationToggle();
    setStatus("Unable to request desktop notification permission.", true);
  }
}

function rememberBounded(set: Set<string>, value: string, limit = 2_000) {
  if (set.has(value)) return false;
  set.add(value);
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (typeof oldest !== "string") break;
    set.delete(oldest);
  }
  return true;
}

function notifyNewMessage(conversationId: string, messageId?: string, force = false) {
  if (!notificationsSupported() || !notificationsEnabled || Notification.permission !== "granted") return;
  if (messageId && notifiedRealtimeMessageIds.has(messageId)) return;
  const awayFromConversation = conversationId !== selectedConversationId
    || document.visibilityState === "hidden"
    || messagesPanel.scrollHeight - messagesPanel.scrollTop - messagesPanel.clientHeight >= 100;
  if (!force && !awayFromConversation) return;
  try {
    const notification = new Notification("New encrypted message", {
      body: "A new encrypted message is waiting in Naigi.",
      tag: `priv-chat:${conversationId}`,
      icon: "/favicon.svg",
    });
    if (messageId) rememberBounded(notifiedRealtimeMessageIds, messageId);
    notification.onclick = () => {
      window.focus();
      const channel = channels.find((candidate) => candidate.conversationId === conversationId);
      if (channel) void selectChannel(channel.id);
      else if (conversations.some((conversation) => conversation.id === conversationId)) void openDirectMessage(conversationId);
      notification.close();
    };
    window.setTimeout(() => notification.close(), 8_000);
  } catch {
    // Browser notification failures must not affect encrypted message delivery.
  }
}

function setConnectionStatus(message: string, state: "connected" | "connecting" | "offline") {
  statusLine.textContent = message;
  connectionIndicator.dataset.state = state;
  connectionIndicator.title = message;
}

function sendRealtimeCommand(command: Record<string, unknown>) {
  if (realtimeReadySocket !== realtime || realtime?.readyState !== WebSocket.OPEN) return false;
  realtime.send(JSON.stringify(command));
  return true;
}

function knownConversationIds() {
  const known = new Set(conversations.map((conversation) => conversation.id));
  for (const channel of channels) known.add(channel.conversationId);
  if (selectedConversationId) known.add(selectedConversationId);
  return known;
}

function publishPresence(state: PresenceState) {
  for (const conversationId of knownConversationIds()) {
    sendRealtimeCommand({ type: "presence", conversationId, state });
  }
}

function stopLocalTyping() {
  window.clearTimeout(localTypingStopTimer);
  localTypingStopTimer = undefined;
  if (localTypingConversationId) {
    sendRealtimeCommand({ type: "typing", conversationId: localTypingConversationId, isTyping: false });
    localTypingConversationId = undefined;
  }
}

function updateLocalTyping() {
  if (!selectedConversationId || !conversationReady || !messageInput.value.trim()) {
    stopLocalTyping();
    return;
  }
  const conversationId = selectedConversationId;
  if (localTypingConversationId !== conversationId) {
    stopLocalTyping();
    localTypingConversationId = conversationId;
    sendRealtimeCommand({ type: "typing", conversationId, isTyping: true });
  }
  window.clearTimeout(localTypingStopTimer);
  localTypingStopTimer = window.setTimeout(stopLocalTyping, 2_500);
}

function renderTypingIndicator() {
  const names = [...typingUsers.keys()]
    .map((userId) => selectedMembers.find((member) => member.userId === userId)?.displayName
      || selectedMembers.find((member) => member.userId === userId)?.username
      || "Someone")
    .filter((name, index, values) => values.indexOf(name) === index);
  if (names.length === 0) {
    typingIndicator.hidden = true;
    typingIndicator.dataset.active = "false";
    typingIndicator.textContent = "";
    return;
  }
  typingIndicator.hidden = false;
  typingIndicator.dataset.active = "true";
  typingIndicator.textContent = names.length === 1
    ? `${names[0]} is typing…`
    : names.length === 2
      ? `${names[0]} and ${names[1]} are typing…`
      : `${names[0]}, ${names[1]}, and ${names.length - 2} others are typing…`;
}

function receiveTyping(conversationId: string, userId: string, isTyping: boolean) {
  if (conversationId !== selectedConversationId || userId === currentUser?.id) return;
  const previousTimer = typingTimers.get(userId);
  if (previousTimer !== undefined) window.clearTimeout(previousTimer);
  if (!isTyping) {
    typingUsers.delete(userId);
    typingTimers.delete(userId);
    renderTypingIndicator();
    return;
  }
  typingUsers.set(userId, Date.now());
  typingTimers.set(userId, window.setTimeout(() => {
    typingUsers.delete(userId);
    typingTimers.delete(userId);
    renderTypingIndicator();
  }, 4_000));
  renderTypingIndicator();
}

function receivePresence(conversationId: string, userId: string, state: PresenceState) {
  if (conversationId !== selectedConversationId || userId === currentUser?.id) return;
  presenceByUser.set(userId, state);
  renderMembers(selectedMembers);
}

function appendTwemoji(parent: HTMLElement, option: ReactionOption, className = "twemoji") {
  const image = document.createElement("img");
  image.className = className;
  image.src = `/assets/twemoji/${option.code}.svg`;
  image.alt = option.emoji;
  image.draggable = false;
  parent.append(image);
  return image;
}

function closeMessageContextMenu() {
  messageContextMenu.hidden = true;
  messageContextMenu.replaceChildren();
  contextMessage = undefined;
}

function contextMenuAction(label: string, action: () => void | Promise<void>, options: { danger?: boolean; shortcut?: string; icon?: string } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `message-context-action${options.danger ? " danger" : ""}`;
  button.setAttribute("role", "menuitem");
  if (options.icon) {
    const icon = document.createElement("span");
    icon.className = "message-context-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = options.icon;
    button.append(icon);
  }
  const text = document.createElement("span");
  text.className = "message-context-label";
  text.textContent = label;
  button.append(text);
  if (options.shortcut) {
    const shortcut = document.createElement("span");
    shortcut.className = "message-context-shortcut";
    shortcut.textContent = options.shortcut;
    button.append(shortcut);
  }
  button.addEventListener("click", () => {
    closeMessageContextMenu();
    void action();
  });
  messageContextMenu.append(button);
  return button;
}

function currentReactionSenders(messageId: string, key: string) {
  return messageReactions.get(messageId)?.get(key) ?? new Set<string>();
}

function renderMessageReactions(messageId: string) {
  const article = findMessageArticle(messageId);
  if (!article) return;
  const existing = article.querySelector<HTMLElement>(".message-reactions");
  if (redactedMessageIds.has(messageId)) {
    existing?.remove();
    return;
  }
  const reactions = messageReactions.get(messageId);
  if (!reactions || [...reactions.values()].every((senders) => senders.size === 0)) {
    existing?.remove();
    return;
  }
  const bar = existing ?? document.createElement("div");
  bar.className = "message-reactions";
  bar.replaceChildren();
  for (const [key, senders] of reactions) {
    if (senders.size === 0) continue;
    const option = reactionOptions.find((candidate) => candidate.emoji === key);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-reaction";
    button.setAttribute("aria-pressed", String(Boolean(currentUser?.id && senders.has(currentUser.id))));
    button.setAttribute("aria-label", `${option?.label ?? key}: ${senders.size}`);
    if (option) appendTwemoji(button, option);
    else {
      const text = document.createElement("span");
      text.textContent = key;
      button.append(text);
    }
    const count = document.createElement("span");
    count.className = "message-reaction-count";
    count.textContent = String(senders.size);
    button.append(count);
    button.addEventListener("click", () => void toggleReaction(messageId, key));
    bar.append(button);
  }
  if (!bar.isConnected) {
    article.querySelector<HTMLElement>(".message-content")?.append(bar);
  }
}

function applyReactionEvent(eventId: string, targetId: string, key: string, senderKey: string, action: "add" | "remove") {
  const previous = reactionEvents.get(eventId);
  if (previous) {
    const previousSenders = currentReactionSenders(previous.targetId, previous.key);
    if (previous.action === "add") previousSenders.delete(previous.senderKey);
    else previousSenders.add(previous.senderKey);
  }
  const senders = currentReactionSenders(targetId, key);
  if (!messageReactions.has(targetId)) messageReactions.set(targetId, new Map());
  if (action === "add") senders.add(senderKey);
  else senders.delete(senderKey);
  messageReactions.get(targetId)!.set(key, senders);
  reactionEvents.set(eventId, { targetId, key, senderKey, action });
  renderMessageReactions(targetId);
}

function applyPinEvent(targetId: string, action: "add" | "remove") {
  if (action === "add") pinnedMessageIds.add(targetId);
  else pinnedMessageIds.delete(targetId);
  const article = findMessageArticle(targetId);
  article?.classList.toggle("message-pinned", pinnedMessageIds.has(targetId));
  const header = article?.querySelector<HTMLElement>(".message-meta");
  if (!header) return;
  const existing = header.querySelector(".message-pin-badge");
  if (pinnedMessageIds.has(targetId) && !existing) {
    const badge = document.createElement("span");
    badge.className = "message-pin-badge";
    badge.textContent = "Pinned";
    header.append(badge);
  } else if (!pinnedMessageIds.has(targetId)) {
    existing?.remove();
  }
}

function applyEditedBody(messageId: string, body: string, embeds: SafeEmbed[], mentions: string[]) {
  editedMessageBodies.set(messageId, { body, embeds, mentions });
  if (redactedMessageIds.has(messageId)) return;
  const article = findMessageArticle(messageId);
  const message = loadedMessages.find((candidate) => candidate.id === messageId);
  if (!article || !message) return;
  const content = article.querySelector<HTMLElement>(".message-content");
  const header = content?.querySelector<HTMLElement>(".message-meta");
  if (!content || !header) return;
  const reply = content.querySelector<HTMLElement>(".reply-context");
  reply?.remove();
  content.replaceChildren(header);
  header.querySelector(".edited-label")?.remove();
  const editedLabel = document.createElement("span");
  editedLabel.className = "edited-label";
  editedLabel.textContent = "(edited)";
  header.append(editedLabel);
  const mentionNames = new Set(selectedMembers.filter((member) => mentions.includes(member.userId)).map((member) => member.username.toLowerCase()));
  article.dataset.mentionsCurrentUser = String(Boolean(currentUser && mentions.includes(currentUser.id)));
  article.classList.toggle("message-mention", Boolean(currentUser && mentions.includes(currentUser.id)
    && (mentionHighlightMessageIds.has(messageId) || hasUnreadConversation())));
  if (body) appendMarkdown(content, body, { mentionUsernames: mentionNames });
  for (const embed of embeds) appendSafeEmbed(content, embed);
  if (reply) content.insertBefore(reply, content.children[1] ?? null);
  const editable = isOwnMessage(message);
  appendMessageActions(content, message, article.querySelector(".message-sender-link")?.textContent ?? "Member", body, editable);
  article.dataset.search = `${article.querySelector(".message-sender-link")?.textContent ?? ""} ${body}`.toLowerCase();
  const contextTarget = messageContextTargets.get(messageId);
  if (contextTarget) {
    contextTarget.body = body;
    contextTarget.editable = editable;
  }
  renderMessageReactions(messageId);
}

function setEditTarget(target: EditTarget) {
  editTarget = target;
  clearReplyTarget();
  editPreviewText.textContent = `Editing ${target.sender}: ${target.body.replace(/\s+/g, " ").slice(0, 180)}`;
  editPreview.hidden = false;
  messageInput.value = target.body;
  resizeMessageInput();
  updateComposerState();
  messageInput.focus();
}

function clearEditTarget(clearInput = true) {
  editTarget = undefined;
  editPreview.hidden = true;
  editPreviewText.textContent = "";
  if (clearInput) {
    messageInput.value = "";
    resizeMessageInput();
  }
  updateComposerState();
}

function messageLink(messageId: string) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `message=${encodeURIComponent(messageId)}`;
  return url.toString();
}

function markUnreadFromMessage(message: MessageEnvelope) {
  if (!selectedConversationId) return;
  const existing = unreadMarkers.get(selectedConversationId);
  unreadMarkers.set(selectedConversationId, {
    count: Math.max(1, existing?.count ?? 0),
    lastSequence: message.serverSequence,
  });
  unreadCount = Math.max(1, unreadCount);
  saveUnreadMarkers();
  renderConversations();
  renderChannels();
  updateMentionHighlights();
  renderUnreadButton();
  setStatus("Conversation marked unread from here.");
}

async function copyMessageBody(body: string) {
  try {
    if (!navigator.clipboard) throw new Error("clipboard_unavailable");
    await navigator.clipboard.writeText(body);
    setStatus("Message copied.");
  } catch {
    setStatus("Unable to copy this message.", true);
  }
}

async function toggleReaction(messageId: string, key: string) {
  if (!cryptoClient || !selectedConversationId || !currentUser) return;
  const senders = currentReactionSenders(messageId, key);
  const action = senders.has(currentUser.id) ? "remove" : "add";
  try {
    const result = await cryptoClient.sendReaction(selectedConversationId, selectedMembers, messageId, key, action);
    applyReactionEvent(`local:${globalThis.crypto.randomUUID()}`, messageId, key, currentUser.id, action);
    setStatus(result.delivery === "queued" ? "Reaction queued on this device." : "Reaction added.");
    if (result.delivery === "queued") void refreshOutboxNotice().catch(() => undefined);
  } catch (error) {
    setStatus(readableError(error), true);
  }
}

async function togglePin(messageId: string) {
  if (!cryptoClient || !selectedConversationId) return;
  const action = pinnedMessageIds.has(messageId) ? "remove" : "add";
  try {
    const result = await cryptoClient.sendPin(selectedConversationId, selectedMembers, messageId, action);
    applyPinEvent(messageId, action);
    setStatus(result.delivery === "queued" ? `Message ${action === "add" ? "pin" : "unpin"} queued on this device.` : `Message ${action === "add" ? "pinned" : "unpinned"}.`);
    if (result.delivery === "queued") void refreshOutboxNotice().catch(() => undefined);
  } catch (error) {
    setStatus(readableError(error), true);
  }
}

async function deleteMessage(message: MessageEnvelope) {
  if (!cryptoClient || !selectedConversationId || !window.confirm("Delete this message for everyone in this conversation?")) return;
  try {
    const result = await cryptoClient.sendRedaction(selectedConversationId, selectedMembers, message.id);
    redactedMessageIds.add(message.id);
    markMessageDeleted(message.id);
    setStatus(result.delivery === "queued" ? "Deletion saved locally; it will retry when connected." : "Message deleted.");
    if (result.delivery === "queued") void refreshOutboxNotice().catch(() => undefined);
  } catch (error) {
    setStatus(readableError(error), true);
  }
}

function openMessageContextMenu(target: ContextMessage, x: number, y: number) {
  contextMessage = target;
  messageContextMenu.replaceChildren();
  const title = document.createElement("div");
  title.className = "message-context-title";
  title.textContent = "Message actions";
  messageContextMenu.append(title);

  const reactions = document.createElement("div");
  reactions.className = "message-context-reactions";
  for (const option of reactionOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-context-reaction";
    button.setAttribute("role", "menuitem");
    button.title = option.label;
    button.setAttribute("aria-label", option.label);
    button.setAttribute("aria-pressed", String(Boolean(currentUser?.id && currentReactionSenders(target.message.id, option.emoji).has(currentUser.id))));
    appendTwemoji(button, option);
    button.addEventListener("click", () => {
      closeMessageContextMenu();
      void toggleReaction(target.message.id, option.emoji);
    });
    reactions.append(button);
  }
  messageContextMenu.append(reactions);

  contextMenuAction("Reply", () => setReplyTarget(replyReferenceForMessage(target.message, target.sender, target.body || "Encrypted message")), { shortcut: "R", icon: "↩" });
  if (target.editable) contextMenuAction("Edit message", () => setEditTarget({ messageId: target.message.id, sender: target.sender, body: target.body }), { shortcut: "E", icon: "✎" });
  if (target.body) contextMenuAction("Copy text", () => copyMessageBody(target.body), { shortcut: "C", icon: "⧉" });
  contextMenuAction("Copy message link", async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(messageLink(target.message.id));
      setStatus("Message link copied.");
    } catch {
      setStatus("Unable to copy the message link.", true);
    }
  }, { icon: "↗" });
  contextMenuAction("Mark unread from here", () => markUnreadFromMessage(target.message), { icon: "◷" });
  contextMenuAction(pinnedMessageIds.has(target.message.id) ? "Unpin message" : "Pin message", () => togglePin(target.message.id), { icon: "⚑" });
  if (isOwnMessage(target.message)) {
    const divider = document.createElement("div");
    divider.className = "message-context-divider";
    messageContextMenu.append(divider);
    contextMenuAction("Delete message", () => deleteMessage(target.message), { danger: true, icon: "⌫" });
  }

  messageContextMenu.hidden = false;
  const margin = 8;
  const rect = messageContextMenu.getBoundingClientRect();
  messageContextMenu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`;
  messageContextMenu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`;
  const firstAction = messageContextMenu.querySelector<HTMLButtonElement>(".message-context-reaction, .message-context-action");
  firstAction?.focus();
}

chatToastClose.addEventListener("click", () => {
  window.clearTimeout(toastTimeout);
  chatToast.hidden = true;
});

outboxRetry.addEventListener("click", async () => {
  if (!cryptoClient) return;
  outboxRetry.disabled = true;
  try {
    const result = await cryptoClient.retryFailedMessages();
    await refreshOutboxNotice();
    if (result.sent > 0) await refreshMessages();
    setStatus(result.failed + result.pending === 0 ? "Queued messages delivered." : "Some messages are still awaiting delivery.", result.failed > 0);
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    outboxRetry.disabled = false;
  }
});

function showDialog(dialog: HTMLElement, focus: HTMLElement) {
  if (mediaViewer !== dialog && !mediaViewer.hidden) closeMediaViewer();
  if (profileModal !== dialog && !profileModal.hidden) closeProfileModal();
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.hidden = false;
  chatLayout.inert = true;
  focus.focus();
}

function hideDialog(dialog: HTMLElement) {
  if (dialog.hidden) return;
  dialog.hidden = true;
  if (mediaViewer.hidden && profileModal.hidden) {
    chatLayout.inert = false;
    if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
    modalReturnFocus = null;
  }
}

async function refreshOutboxNotice() {
  if (!cryptoClient) return;
  const records = await cryptoClient.pendingMessages();
  const failed = records.filter((record) => record.status === "failed").length;
  outboxNotice.hidden = records.length === 0;
  outboxLabel.textContent = records.length === 0 ? "" : `${records.length} encrypted message${records.length === 1 ? "" : "s"} awaiting delivery${failed ? ` · ${failed} need attention` : ""}`;
  outboxRetry.textContent = failed > 0 ? "Retry failed" : "Retry now";
}

function closeMediaViewer() {
  if (mediaViewerUrl) URL.revokeObjectURL(mediaViewerUrl);
  mediaViewerUrl = undefined;
  mediaViewerElement = undefined;
  mediaViewerStage.replaceChildren();
  mediaViewerZoom.value = "1";
  mediaZoomReset.textContent = "100%";
  hideDialog(mediaViewer);
}

function setMediaZoom(value: number) {
  const zoom = Math.max(1, Math.min(3, Math.round(value * 10) / 10));
  mediaViewerZoom.value = String(zoom);
  mediaZoomReset.textContent = `${Math.round(zoom * 100)}%`;
  if (mediaViewerElement) mediaViewerElement.style.transform = `scale(${zoom})`;
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
  showDialog(mediaViewer, mediaViewerClose);
  setMediaZoom(1);
}

function closeProfileModal() {
  profileRequest += 1;
  hideDialog(profileModal);
}

async function openUserProfile(userId: string) {
  const request = ++profileRequest;
  profileModalName.textContent = "Loading profile…";
  profileModalUsername.textContent = "";
  profileModalCreated.textContent = "";
  profileModalAvatar.textContent = "?";
  profileModalEdit.hidden = true;
  showDialog(profileModal, profileModalClose);
  try {
    const result = await api.user(userId);
    if (request !== profileRequest || profileModal.hidden) return;
    const user = result.user;
    profileModalAvatar.textContent = user.displayName.slice(0, 1).toUpperCase();
    setAvatarStyle(profileModalAvatar, user.id);
    profileModalName.textContent = user.displayName;
    profileModalUsername.textContent = `@${user.username}`;
    profileModalCreated.textContent = `Joined ${new Date(user.createdAt).toLocaleDateString()}`;
    profileModalEdit.hidden = user.id !== currentUser?.id;
  } catch (error) {
    if (request !== profileRequest || profileModal.hidden) return;
    profileModalName.textContent = "Profile unavailable";
    profileModalUsername.textContent = readableError(error);
  }
}

mediaViewerZoom.addEventListener("input", () => {
  setMediaZoom(Number(mediaViewerZoom.value));
});
mediaZoomOut.addEventListener("click", () => setMediaZoom(Number(mediaViewerZoom.value) - 0.1));
mediaZoomIn.addEventListener("click", () => setMediaZoom(Number(mediaViewerZoom.value) + 0.1));
mediaZoomReset.addEventListener("click", () => setMediaZoom(1));
mediaViewerStage.addEventListener("dblclick", () => setMediaZoom(Number(mediaViewerZoom.value) === 1 ? 2 : 1));
mediaViewerStage.addEventListener("wheel", (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  setMediaZoom(Number(mediaViewerZoom.value) + (event.deltaY > 0 ? -0.1 : 0.1));
}, { passive: false });

function clearReplyTarget() {
  replyTarget = undefined;
  replyPreview.hidden = true;
  replyPreviewText.textContent = "";
  replyMentionToggle.hidden = true;
  replyMentionToggle.setAttribute("aria-pressed", "false");
  replyMentionToggle.setAttribute("aria-label", "Mention replied-to sender");
  replyMentionToggle.title = "Mention replied-to sender";
  replyMentionToggle.textContent = "";
}

function replyReferenceForMessage(message: MessageEnvelope, sender: string, body: string): ReplyReference {
  const member = message.senderUserId
    ? selectedMembers.find((candidate) => candidate.userId === message.senderUserId)
    : undefined;
  const canMention = Boolean(message.senderUserId && message.senderUserId !== currentUser?.id);
  return {
    messageId: message.id,
    sender,
    body,
    userId: canMention ? message.senderUserId ?? undefined : undefined,
    username: canMention ? member?.username : undefined,
    mentionSender: canMention,
  };
}

function setReplyTarget(target: ReplyReference) {
  if (editTarget) clearEditTarget();
  const canMention = Boolean(target.userId && target.userId !== currentUser?.id);
  replyTarget = {
    ...target,
    mentionSender: canMention && target.mentionSender !== false,
  };
  const preview = target.body.replace(/\s+/g, " ").trim() || "Encrypted message";
  replyPreviewText.textContent = `Replying to ${target.sender}: ${preview.slice(0, 180)}`;
  replyMentionToggle.hidden = !canMention;
  replyMentionToggle.setAttribute("aria-pressed", String(Boolean(replyTarget.mentionSender)));
  const mentionLabel = target.username ? `@${target.username}` : "sender";
  replyMentionToggle.setAttribute("aria-label", replyTarget.mentionSender ? `Mention ${mentionLabel}` : `Do not mention ${mentionLabel}`);
  replyMentionToggle.title = "Toggle mention of the replied-to sender";
  replyMentionToggle.textContent = replyTarget.mentionSender ? `Mention ${mentionLabel}` : `No mention`;
  replyPreview.hidden = false;
  messageInput.focus();
}

replyMentionToggle.addEventListener("click", () => {
  if (!replyTarget?.userId) return;
  replyTarget.mentionSender = !replyTarget.mentionSender;
  replyMentionToggle.setAttribute("aria-pressed", String(Boolean(replyTarget.mentionSender)));
  const mentionLabel = replyTarget.username ? `@${replyTarget.username}` : "sender";
  replyMentionToggle.setAttribute("aria-label", replyTarget.mentionSender ? `Mention ${mentionLabel}` : `Do not mention ${mentionLabel}`);
  replyMentionToggle.textContent = replyTarget.mentionSender ? `Mention ${mentionLabel}` : "No mention";
});

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

function closeEmojiPicker() {
  emojiPicker.hidden = true;
  emojiToggle.setAttribute("aria-expanded", "false");
}

function insertEmoji(emoji: string) {
  const start = messageInput.selectionStart ?? messageInput.value.length;
  const end = messageInput.selectionEnd ?? start;
  messageInput.value = `${messageInput.value.slice(0, start)}${emoji}${messageInput.value.slice(end)}`;
  const cursor = start + emoji.length;
  messageInput.setSelectionRange(cursor, cursor);
  rememberDraft();
  resizeMessageInput();
  updateLocalTyping();
  renderMentionSuggestions();
  messageInput.focus();
}

function renderEmojiPicker() {
  emojiPicker.replaceChildren();
  for (const emoji of emojiOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = emoji;
    button.title = `Insert ${emoji}`;
    button.setAttribute("aria-label", `Insert ${emoji}`);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => insertEmoji(emoji));
    emojiPicker.append(button);
  }
}

function toggleEmojiPicker() {
  if (emojiPicker.hidden) {
    renderEmojiPicker();
    emojiPicker.hidden = false;
    emojiToggle.setAttribute("aria-expanded", "true");
  } else {
    closeEmojiPicker();
  }
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

function isAtLatestMessage() {
  return messagesPanel.scrollHeight - messagesPanel.scrollTop - messagesPanel.clientHeight < 100;
}

function hasUnreadConversation() {
  return unreadCount > 0 || Boolean(selectedConversationId && unreadMarkers.has(selectedConversationId));
}

function updateMentionHighlights() {
  for (const article of messagesPanel.querySelectorAll<HTMLElement>(".message[data-mentions-current-user='true']")) {
    const messageId = article.dataset.messageId;
    article.classList.toggle("message-mention", Boolean(messageId && mentionHighlightMessageIds.has(messageId)) || hasUnreadConversation());
  }
}

function clearUnread(options: { clearMentionHighlights?: boolean } = {}) {
  unreadCount = 0;
  if (options.clearMentionHighlights !== false) {
    mentionHighlightMessageIds.clear();
    pendingMentionNotifications.clear();
  }
  if (selectedConversationId) clearConversationUnread(selectedConversationId);
  updateMentionHighlights();
  renderUnreadButton();
  renderServers();
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

function markConversationUnread(conversationId: string, serverSequence?: string, options: { force?: boolean } = {}) {
  if (conversationId === selectedConversationId && !options.force) return;
  const existing = unreadMarkers.get(conversationId);
  if (existing && serverSequence && BigInt(serverSequence) <= BigInt(existing.lastSequence)) return;
  unreadMarkers.set(conversationId, {
    count: (existing?.count ?? 0) + 1,
    lastSequence: serverSequence ?? existing?.lastSequence ?? "0",
  });
  saveUnreadMarkers();
  renderConversations();
  renderChannels();
  renderServers();
  updateMentionHighlights();
}

function clearConversationUnread(conversationId: string) {
  if (!unreadMarkers.delete(conversationId)) return;
  saveUnreadMarkers();
  renderConversations();
  renderChannels();
  renderServers();
  updateMentionHighlights();
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
    if (error.code === "only_server_owner_can_delete") return "Only the server owner can delete this server.";
    if (error.code === "server_not_found") return "That server no longer exists.";
    if (error.code === "conversation_not_found") return "That conversation no longer exists.";
    if (error.code === "conversation_member_not_shared") return "You can only message members of a shared server.";
    if (error.code === "cannot_delete_server_channel") return "Server channels are deleted with the server.";
    if (error.code === "category_not_found") return "That category no longer exists.";
    if (error.code === "channel_not_found") return "That channel no longer exists.";
    if (error.code === "cannot_archive_last_channel") return "A server must keep one active text channel.";
    if (error.code === "cannot_archive_metadata_channel") return "The original channel anchors encrypted server metadata and cannot be archived.";
    return error.code;
  }
  return error instanceof Error ? error.message : "request_failed";
}

type ChatLocation = {
  serverId?: string;
  channelId?: string;
  conversationId?: string;
};

function chatLocation(): ChatLocation {
  const segments = window.location.pathname.split("/").filter(Boolean);
  if (segments.length === 3 && segments[0] === "channels") {
    const first = decodeURIComponent(segments[1]);
    const second = decodeURIComponent(segments[2]);
    return first === "@me"
      ? { conversationId: second }
      : { serverId: first, channelId: second };
  }

  // Keep old links working while they naturally migrate to the canonical path.
  const params = new URLSearchParams(window.location.search);
  return {
    serverId: params.get("server") ?? undefined,
    channelId: params.get("channel") ?? undefined,
    conversationId: params.get("conversation") ?? undefined,
  };
}

function channelLocation(serverId: string, channelId: string) {
  return `/channels/${encodeURIComponent(serverId)}/${encodeURIComponent(channelId)}`;
}

function conversationLocation(conversationId: string) {
  return `/channels/@me/${encodeURIComponent(conversationId)}`;
}

async function startCrypto() {
  if (!currentUser) throw new Error("not_authenticated");
  const localPassphrase = await resolveLocalPassphrase(currentUser.id);
  if (!localPassphrase) {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/unlock?return=${encodeURIComponent(returnPath)}`);
    return;
  }
  loadUnreadMarkers();
  loadNotificationPreference();
  await cryptoClient?.close();
  cryptoClient = new CryptoClient(api, currentUser.id, localPassphrase);
  await cryptoClient.initialize();
  confirmLocalUnlock();
  const outbox = await cryptoClient.flushPendingMessages().catch(() => ({ sent: 0, pending: 0, failed: 0 }));
  userLabel.textContent = `${currentUser.displayName} (@${currentUser.username})`;
  selfAvatar.textContent = currentUser.displayName.slice(0, 1).toUpperCase();
  setAvatarStyle(selfAvatar, currentUser.id);
  await refreshServers();
  await refreshConversations();
  connectRealtime();
  await refreshOutboxNotice().catch(() => undefined);
  if (outbox.sent > 0) setStatus(`${outbox.sent} queued message${outbox.sent === 1 ? "" : "s"} delivered.`);
}

async function flushOutbox() {
  if (!cryptoClient) return;
  const result = await cryptoClient.flushPendingMessages();
  if (result.sent > 0) {
    setStatus(`${result.sent} queued message${result.sent === 1 ? "" : "s"} delivered.`);
    await refreshMessages();
  }
  await refreshOutboxNotice();
}

async function refreshSelectedRoomKeys() {
  if (!cryptoClient || !selectedConversationId || !conversationReady || selectedMembers.length === 0) return;
  if (Date.now() - lastRoomKeyRefreshAt < 10_000) return;
  const activeCryptoClient = cryptoClient;
  const conversationId = selectedConversationId;
  const members = [...selectedMembers];
  lastRoomKeyRefreshAt = Date.now();
  await activeCryptoClient.prepareConversation(conversationId, members);
}

function connectRealtime() {
  realtime?.close();
  realtimeReadySocket = undefined;
  const url = new URL("/v1/realtime", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  setConnectionStatus("Connecting…", "connecting");
  const socket = new WebSocket(url);
  realtime = socket;
  socket.addEventListener("open", () => {
    if (socket !== realtime) return;
    setConnectionStatus("Authenticating…", "connecting");
  });
  socket.addEventListener("message", (event) => {
    if (socket !== realtime) return;
    try {
      const payload = JSON.parse(event.data) as {
        type?: string;
        conversationId?: string;
        messageId?: string;
        serverSequence?: string;
        userId?: string;
        isTyping?: boolean;
        state?: PresenceState;
      };
      if (payload.type === "ready") {
        realtimeReadySocket = socket;
        setConnectionStatus("Connected", "connected");
        subscribeKnownConversations();
        publishPresence(document.visibilityState === "hidden" ? "idle" : "online");
        void refreshMessages().catch((error) => setStatus(readableError(error), true));
        return;
      }
      if (payload.type === "typing" && payload.conversationId && payload.userId && typeof payload.isTyping === "boolean") {
        receiveTyping(payload.conversationId, payload.userId, payload.isTyping);
        return;
      }
      if (payload.type === "presence" && payload.conversationId && payload.userId && payload.state) {
        receivePresence(payload.conversationId, payload.userId, payload.state);
        return;
      }
      if (payload.type === "message.created" && payload.conversationId) {
        if (payload.messageId && !rememberBounded(seenRealtimeMessageIds, payload.messageId)) return;
        if (!knownConversationIds().has(payload.conversationId)) {
          // A DM can be created by another member while this device is open;
          // the user inbox event is the first signal that the conversation
          // exists locally.
          void refreshConversations().catch(() => undefined);
        }
        if (payload.conversationId === selectedConversationId) {
          const readingConversation = document.visibilityState === "visible" && isAtLatestMessage();
          if (readingConversation) {
            clearUnread({ clearMentionHighlights: false });
          } else {
            markConversationUnread(payload.conversationId, payload.serverSequence, { force: true });
          }
          if (payload.messageId) pendingMentionNotifications.add(payload.messageId);
          void refreshMessages().catch((error) => setStatus(readableError(error), true));
        } else {
          markConversationUnread(payload.conversationId, payload.serverSequence);
        }
        notifyNewMessage(payload.conversationId, payload.messageId);
      }
    } catch {
      // Ignore malformed realtime notifications; history remains authoritative.
    }
  });
  socket.addEventListener("error", () => {
    if (socket === realtime) setConnectionStatus("History available · reconnecting", "offline");
  });
  socket.addEventListener("close", () => {
    if (socket !== realtime) return;
    realtimeReadySocket = undefined;
    setConnectionStatus("Reconnecting…", "offline");
    if (cryptoClient) window.setTimeout(connectRealtime, 1500);
  });
}

function subscribeRealtime(conversationId: string) {
  sendRealtimeCommand({ type: "subscribe", conversationId });
}

function subscribeKnownConversations() {
  for (const conversationId of knownConversationIds()) subscribeRealtime(conversationId);
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

function serverUnreadCount(serverId: string) {
  return (channelsByServer.get(serverId) ?? []).reduce(
    (count, channel) => count + (unreadMarkers.get(channel.conversationId)?.count ?? 0),
    0,
  );
}

function renderServers() {
  serverList.replaceChildren();
  for (const server of servers) {
    const button = document.createElement("button");
    button.className = "server-rail-button";
    button.type = "button";
    const unread = serverUnreadCount(server.id);
    button.title = unread > 0 ? `${serverDisplayName(server)} · ${unread} unread` : serverDisplayName(server);
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(server.id === selectedServerId));
    button.classList.toggle("selected", server.id === selectedServerId);
    button.textContent = serverDisplayName(server).slice(0, 1).toUpperCase();
    setAvatarStyle(button, server.id);
    if (unread > 0) {
      const badge = document.createElement("span");
      badge.className = "unread-badge server-unread-badge";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      badge.setAttribute("aria-label", `${unread} unread message${unread === 1 ? "" : "s"}`);
      button.append(badge);
    }
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

async function removeConversation(conversation: Conversation) {
  if (!currentUser || !window.confirm(`Remove your ${conversationDisplayName(conversation)} conversation from this device?`)) return;
  try {
    await api.deleteConversation(conversation.id);
    sendRealtimeCommand({ type: "unsubscribe", conversationId: conversation.id });
    await deleteCachedMessages(currentUser.id, conversation.id);
    unreadMarkers.delete(conversation.id);
    saveUnreadMarkers();
    if (selectedConversationId === conversation.id) {
      selectionToken += 1;
      selectedConversationId = undefined;
      selectedMembers = [];
      conversationReady = false;
      loadedMessages = [];
      nextBefore = null;
      nextAfter = null;
      renderMembers([]);
      renderConversationWelcome("Your conversations", "Start a private conversation to begin chatting.");
      window.history.replaceState(null, "", "/app");
    }
    await refreshConversations();
    renderServers();
    setStatus("Conversation removed.");
  } catch (error) {
    setStatus(readableError(error), true);
  }
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
    const row = document.createElement("div");
    row.className = "conversation-row";
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
    const remove = document.createElement("button");
    remove.className = "conversation-delete icon-button";
    remove.type = "button";
    remove.title = "Remove conversation";
    remove.setAttribute("aria-label", `Remove ${conversationDisplayName(conversation)} conversation`);
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void removeConversation(conversation);
    });
    row.append(button, remove);
    conversationList.append(row);
  }
}

async function refreshServers() {
  const result = await api.servers();
  servers = result.servers;
  renderServers();
  void Promise.all(servers.map(async (server) => {
    try {
      const result = await api.serverChannels(server.id);
      channelsByServer.set(server.id, result.channels);
      renderServers();
    } catch {
      // The active server request below remains authoritative.
    }
  }));

  const requestedLocation = chatLocation();
  const requestedServerId = requestedLocation.serverId;
  const requestedChannelId = requestedLocation.channelId;
  const requestedServer = requestedServerId ? servers.find((server) => server.id === requestedServerId) : undefined;
  if (requestedServer) {
    await selectServer(requestedServer.id, requestedChannelId ?? undefined);
    return;
  }

  // A direct-message URL should stay on the DM home instead of being replaced by
  // the first server in the rail.
  if (requestedLocation.conversationId) return;
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
  rememberDraft();
  uploadAbortController?.abort();
  hideMentionSuggestions();
  const token = ++serverSelectionToken;
  selectedServerId = serverId;
  selectedChannelId = undefined;
  selectedConversationId = undefined;
  conversationReady = false;
  selectedMembers = [];
  channels = [];
  categories = [];
  selectionToken += 1;
  renderServers();
  renderConversations();
  renderChannels();
  renderMembers([]);
  updateComposerState();
  renderConversationWelcome("Opening server…", "Loading its encrypted channels.");
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
    channelsByServer.set(serverId, channels);
    categories = categoryResult.categories;
    subscribeKnownConversations();
    renderChannels();
    renderServers();
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
  rememberDraft();
  uploadAbortController?.abort();
  hideMentionSuggestions();
  selectionToken += 1;
  selectedServerId = undefined;
  selectedChannelId = undefined;
  channels = [];
  categories = [];
  selectedConversationId = undefined;
  conversationReady = false;
  selectedMembers = [];
  ++serverSelectionToken;
  window.history.replaceState(null, "", "/app");
  renderServers();
  renderConversations();
  renderChannels();
  const conversation = conversations[0];
  if (conversation) await selectConversation(conversation.id);
  else {
    conversationTitle.textContent = "Your conversations";
    conversationSubtitle.textContent = "Start a private conversation to begin chatting";
    channelIcon.textContent = "@";
    renderConversationWelcome("No conversations yet", "Create a direct message or group conversation to get started.");
    renderMembers([]);
    updateComposerState();
    setMobileSidebar(false);
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
  const requested = chatLocation().conversationId;
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
    identity.className = "member-presence";
    const state = member.userId === currentUser?.id ? "online" : presenceByUser.get(member.userId) ?? "offline";
    identity.dataset.state = state;
    identity.textContent = member.userId === currentUser?.id
      ? `you · ${state}`
      : `${state} · keys protected`;
    copy.append(name, identity);
    row.append(avatar, copy);
    memberList.append(row);
  }
}

function renderConversationWelcome(title: string, description: string) {
  releaseMediaResources(messagesPanel);
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

function renderMessageSkeletons(count = 7) {
  releaseMediaResources(messagesPanel);
  messagesPanel.replaceChildren();
  messagesPanel.append(loadOlderButton);
  loadOlderButton.hidden = true;
  const list = document.createElement("div");
  list.className = "message-skeleton-list";
  for (let index = 0; index < count; index += 1) {
    const row = document.createElement("div");
    row.className = "message-skeleton";
    const avatar = document.createElement("div");
    avatar.className = "message-skeleton-avatar";
    const copy = document.createElement("div");
    copy.className = "message-skeleton-copy";
    const name = document.createElement("div");
    name.className = `message-skeleton-line ${index % 3 === 0 ? "short" : "medium"}`;
    const body = document.createElement("div");
    body.className = `message-skeleton-line ${index % 2 === 0 ? "medium" : "short"}`;
    copy.append(name, body);
    row.append(avatar, copy);
    list.append(row);
  }
  messagesPanel.append(list);
}

function releaseMediaResources(root: HTMLElement) {
  for (const [button, controller] of pendingMediaLoads) {
    if (root.contains(button)) {
      controller.abort();
      pendingMediaLoads.delete(button);
    }
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-media-url]")) {
    if (element.dataset.mediaUrl) URL.revokeObjectURL(element.dataset.mediaUrl);
    delete element.dataset.mediaUrl;
  }
}

function updateComposerState() {
  const enabled = Boolean(selectedConversationId && cryptoClient && conversationReady);
  messageInput.disabled = !enabled || sendInProgress;
  photoInput.disabled = !enabled || sendInProgress || Boolean(editTarget);
  sendButton.disabled = !enabled || sendInProgress;
  emojiToggle.disabled = !enabled || sendInProgress || Boolean(editTarget);
  messageSearchToggle.disabled = !enabled;
  messageInput.placeholder = enabled ? "Message this conversation" : "Select a conversation to start chatting";
  if (!enabled) {
    closeEmojiPicker();
    attachmentPreview.hidden = true;
    uploadProgress.hidden = true;
    photoInput.value = "";
  }
  if (editTarget) {
    attachmentPreview.hidden = true;
    uploadProgress.hidden = true;
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

function isOwnMessage(message: MessageEnvelope) {
  return Boolean(currentUser?.id && message.senderUserId && message.senderUserId === currentUser.id);
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
  for (const notice of messagesPanel.querySelectorAll<HTMLElement>(".unavailable-history")) notice.hidden = Boolean(query);

  const existing = messagesPanel.querySelector(".message-search-empty");
  existing?.remove();
  if (query && matches === 0 && messagesPanel.querySelector(".message, .unavailable-history")) {
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
  uploadAbortController?.abort();
  stopLocalTyping();
  const token = ++selectionToken;
  selectedConversationId = conversationId;
  conversationReady = false;
  lastRoomKeyRefreshAt = 0;
  if (channel) selectedChannelId = channel.id;
  setDetailsForConversation(Boolean(channel));
  lastMessagesKey = "__not-rendered__";
  loadedMessages = [];
  nextBefore = null;
  nextAfter = null;
  latestObservedSequence = null;
  optimisticDecryptedMessages.clear();
  redactedMessageIds.clear();
  redactionAuthors.clear();
  messageReactions.clear();
  reactionEvents.clear();
  pinnedMessageIds.clear();
  editedMessageBodies.clear();
  closeMessageContextMenu();
  messageContextTargets.clear();
  unavailableMessageNotices.clear();
  typingUsers.clear();
  for (const timer of typingTimers.values()) window.clearTimeout(timer);
  typingTimers.clear();
  presenceByUser.clear();
  renderTypingIndicator();
  clearEditTarget(false);
  clearUnread();
  clearConversationUnread(conversationId);
  clearReplyTarget();
  photoInput.value = "";
  attachmentPreview.hidden = true;
  uploadProgress.hidden = true;
  messageInput.value = drafts.get(conversationId) ?? "";
  resizeMessageInput();
  const conversation = conversations.find((item) => item.id === conversationId);
  conversationTitle.textContent = channel ? channelDisplayName(channel) : conversation ? conversationDisplayName(conversation) : "Conversation";
  conversationSubtitle.textContent = "Loading encrypted conversation…";
  renderMessageSkeletons();
  channelIcon.textContent = channel ? "#" : conversation?.kind === "group" ? "#" : "@";
  updateComposerState();
  renderConversations();
  renderChannels();
  const wasSidebarOpen = chatLayout.classList.contains("mobile-sidebar-open") && window.matchMedia("(max-width: 760px)").matches;
  setMobileSidebar(false);
  hideMentionSuggestions();
  const hashTarget = messageTargetFromHash();
  const currentLocation = chatLocation();
  const messageTarget = hashTarget && (channel && selectedServerId
    ? currentLocation.serverId === selectedServerId && currentLocation.channelId === channel.id
    : currentLocation.conversationId === conversationId)
    ? hashTarget
    : undefined;
  const location = channel && selectedServerId
    ? channelLocation(selectedServerId, channel.id)
    : conversationLocation(conversationId);
  window.history.replaceState(null, "", `${location}${messageTarget ? `#message=${encodeURIComponent(messageTarget)}` : ""}`);
  subscribeRealtime(conversationId);
  try {
    const members = await api.conversationMembers(conversationId);
    if (token !== selectionToken) return;
    selectedMembers = members.members;
    renderMembers(selectedMembers);
    conversationSubtitle.textContent = `${selectedMembers.length} member${selectedMembers.length === 1 ? "" : "s"} · end-to-end encrypted`;
    await cryptoClient.prepareConversation(conversationId, selectedMembers);
    if (token !== selectionToken) return;
    const cached = currentUser ? await readCachedMessages(currentUser.id, conversationId) : [];
    if (token !== selectionToken) return;
    if (cached.length > 0) {
      loadedMessages = sortMessages(cached).slice(-MAX_RENDERED_MESSAGES);
      nextBefore = null;
      nextAfter = null;
      latestObservedSequence = null;
      observeLatestMessages(loadedMessages);
      lastMessagesKey = messagesKey();
      await renderMessageHistory({ scrollToBottom: true });
    }
    await cryptoClient.syncToDevice().catch(() => undefined);
    if (token !== selectionToken) return;
    conversationReady = true;
    updateComposerState();
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
    if (metadataChannel && metadataChannel.conversationId !== conversationId) {
      try {
        const metadataMembers = (await api.conversationMembers(metadataChannel.conversationId)).members;
        await cryptoClient.prepareConversation(metadataChannel.conversationId, metadataMembers);
        await cryptoClient.syncToDevice().catch(() => undefined);
      } catch {
        // The selected channel can still open without the server's metadata key.
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
    if (token !== selectionToken) return;
    conversationTitle.textContent = channel ? channelDisplayName(channel) : conversation ? conversationDisplayName(conversation) : "Conversation";
    if (activeServer) renderServers();
    renderChannels();
    updateComposerState();
    renderConversations();
    await refreshMessages({ forceScrollToBottom: true });
    if (token !== selectionToken) return;
    if (messageTarget) await scrollToMessage(messageTarget);
    if (wasSidebarOpen) messageInput.focus();
  } catch (error) {
    if (token !== selectionToken) return;
    const canSend = conversationReady;
    updateComposerState();
    conversationSubtitle.textContent = canSend ? "Message history unavailable" : "Could not load this conversation";
    renderConversationWelcome(canSend ? "History unavailable" : "Unable to open conversation", canSend
      ? "Check your connection to load history. You can still queue encrypted messages on this device."
      : "Check your connection and select this conversation again to retry.");
    if (wasSidebarOpen) (canSend ? messageInput : mobileSidebarToggle).focus();
    setStatus(readableError(error), true);
  }
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

function messageBreaksGrouping(decrypted: { content: Record<string, unknown> } | null) {
  const reply = decrypted?.content.replyTo;
  return Boolean(reply && typeof reply === "object" && !Array.isArray(reply));
}

function groupStateForMessage(message: MessageEnvelope, decrypted: { sender: string; content: Record<string, unknown> } | null) {
  return messageGroupState(senderKey(message, decrypted), message.createdAt, messageBreaksGrouping(decrypted));
}

function groupStateFromArticle(article: HTMLElement | undefined): MessageGroupState | undefined {
  if (!article?.dataset.senderKey || !article.dataset.createdAt) return undefined;
  return messageGroupState(article.dataset.senderKey, article.dataset.createdAt, article.dataset.groupBreak === "true");
}

function findMessageArticle(messageId: string) {
  return [...messagesPanel.querySelectorAll<HTMLElement>(".message")]
    .find((candidate) => candidate.dataset.messageId === messageId);
}

function messageTargetFromHash() {
  const hash = window.location.hash;
  if (!hash.startsWith("#message=")) return undefined;
  try {
    const value = decodeURIComponent(hash.slice("#message=".length));
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function scrollToMessage(messageId: string) {
  let article = findMessageArticle(messageId);
  let unavailable = unavailableMessageNotices.get(messageId);
  if (!article && !unavailable && nextAfter) {
    await refreshMessages({ forceScrollToBottom: true }).catch(() => undefined);
    article = findMessageArticle(messageId);
    unavailable = unavailableMessageNotices.get(messageId);
  }
  for (let attempt = 0; !article && !unavailable && nextBefore && attempt < MAX_CATCH_UP_PAGES; attempt += 1) {
    await loadOlderMessages();
    article = findMessageArticle(messageId);
    unavailable = unavailableMessageNotices.get(messageId);
  }
  if (unavailable) {
    unavailable.scrollIntoView({ behavior: "smooth", block: "center" });
    setStatus("That message is locked on this device. Its keys may still be in your original browser.");
    return;
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
  messageContextTargets.delete(messageId);
  const article = [...messagesPanel.querySelectorAll<HTMLElement>(".message")]
    .find((candidate) => candidate.dataset.messageId === messageId);
  const content = article?.querySelector<HTMLElement>(".message-content");
  const header = content?.querySelector<HTMLElement>(".message-meta");
  if (!article || !content || !header) return;
  releaseMediaResources(article);
  const deleted = document.createElement("p");
  deleted.className = "message-deleted muted";
  deleted.textContent = "Message deleted";
  content.replaceChildren(header, deleted);
  article.classList.add("message-deleted-row");
  article.dataset.search = "message deleted";
}

function appendMessageActions(parent: HTMLElement, message: MessageEnvelope, sender: string, body: string, editable = false) {
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const menu = document.createElement("button");
  menu.className = "message-action message-action-menu";
  menu.type = "button";
  menu.textContent = "⋯";
  menu.title = "Message actions";
  menu.setAttribute("aria-label", `Actions for message from ${sender}`);
  menu.setAttribute("aria-expanded", "false");
  menu.setAttribute("aria-haspopup", "menu");
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
    const article = parent.closest<HTMLElement>(".message");
    if (!article) return;
    const rect = menu.getBoundingClientRect();
    openMessageContextMenu({ message, article, sender, body, editable }, rect.right, rect.bottom + 4);
  });
  actions.append(menu);
  const reply = document.createElement("button");
  reply.className = "message-action";
  reply.type = "button";
  reply.textContent = "Reply";
  reply.addEventListener("click", () => {
    parent.closest(".message")?.classList.remove("message-actions-open");
    menu.setAttribute("aria-expanded", "false");
    setReplyTarget(replyReferenceForMessage(message, sender, body || "Encrypted message"));
  });
  actions.append(reply);
  if (editable) {
    const edit = document.createElement("button");
    edit.className = "message-action";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => setEditTarget({ messageId: message.id, sender, body }));
    actions.append(edit);
  }
  if (body) {
    const copy = document.createElement("button");
    copy.className = "message-action";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => void copyMessageBody(body));
    actions.append(copy);
  }
  if (isOwnMessage(message)) {
    const remove = document.createElement("button");
    remove.className = "message-action message-delete-action";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => void deleteMessage(message));
    actions.append(remove);
  }
  parent.append(actions);
}

messagesPanel.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest(".message-actions")) return;
  for (const open of messagesPanel.querySelectorAll<HTMLElement>(".message-actions-open")) {
    open.classList.remove("message-actions-open");
    open.querySelector(".message-action-menu")?.setAttribute("aria-expanded", "false");
  }
});

messagesPanel.addEventListener("contextmenu", (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".message") : null;
  const contextTarget = target?.dataset.messageId ? messageContextTargets.get(target.dataset.messageId) : undefined;
  if (!contextTarget) return;
  event.preventDefault();
  openMessageContextMenu(contextTarget, event.clientX, event.clientY);
});

document.addEventListener("pointerdown", (event) => {
  if (!messageContextMenu.hidden && event.target instanceof Node && !messageContextMenu.contains(event.target)) closeMessageContextMenu();
  if (!emojiPicker.hidden && event.target instanceof Node && !emojiPicker.contains(event.target) && event.target !== emojiToggle) closeEmojiPicker();
});
window.addEventListener("resize", closeMessageContextMenu);
messagesPanel.addEventListener("scroll", closeMessageContextMenu, { passive: true });

function appendDeletedMessage(messageContent: HTMLElement) {
  const deleted = document.createElement("p");
  deleted.className = "message-deleted muted";
  deleted.textContent = "Message deleted";
  messageContent.append(deleted);
}

function appendUnavailableMessage(messageId: string) {
  let notice: HTMLElement | null = messagesPanel.lastElementChild instanceof HTMLElement ? messagesPanel.lastElementChild : null;
  if (!notice || !notice.classList.contains("unavailable-history")) {
    notice = document.createElement("section");
    notice.className = "unavailable-history";
    notice.setAttribute("role", "note");
    const icon = document.createElement("span");
    icon.className = "unavailable-history-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⌑";
    const copy = document.createElement("div");
    const heading = document.createElement("strong");
    heading.className = "unavailable-history-title";
    const explanation = document.createElement("p");
    explanation.textContent = "These messages are still encrypted, but this browser doesn't have the keys to read them. Your passphrase can't restore missing keys. Try the browser you used before.";
    copy.append(heading, explanation);
    notice.append(icon, copy);
    messagesPanel.append(notice);
  }
  const count = Number(notice.dataset.count ?? "0") + 1;
  notice.dataset.count = String(count);
  notice.querySelector<HTMLElement>(".unavailable-history-title")!.textContent =
    `${count} message${count === 1 ? " is" : "s are"} locked on this device`;
  unavailableMessageNotices.set(messageId, notice);
}

function renderMessage(
  message: MessageEnvelope,
  decrypted: { sender: string; content: Record<string, unknown> } | null,
  error?: string,
  options: { grouped: boolean } = { grouped: false },
): boolean {
  const wasRealtimeMessage = pendingMentionNotifications.delete(message.id);
  const article = document.createElement("article");
  article.className = "message";
  if (options.grouped) article.classList.add("message-compact");
  const senderIdentity = senderLabel(message, decrypted);
  const edited = editedMessageBodies.get(message.id);
  const originalBody = decrypted && typeof decrypted.content.body === "string" ? decrypted.content.body : "";
  const body = edited?.body ?? originalBody;
  const effectiveEmbeds = edited?.embeds ?? extractEmbeds(body);
  const effectiveMentions = edited?.mentions ?? (Array.isArray(decrypted?.content.mentions)
    ? decrypted.content.mentions.filter((value): value is string => typeof value === "string")
    : []);
  article.dataset.messageId = message.id;
  article.id = `message-${message.id}`;
  article.dataset.search = `${senderIdentity} ${body} ${error ?? ""}`.toLowerCase();
  article.dataset.senderKey = senderKey(message, decrypted);
  article.dataset.createdAt = message.createdAt;
  article.dataset.groupBreak = String(messageBreaksGrouping(decrypted));
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
    if (!target?.senderUserId || !message.senderUserId || target.senderUserId !== message.senderUserId) return false;
    redactionAuthors.set(content.redacts, message.senderUserId);
    redactedMessageIds.add(content.redacts);
    markMessageDeleted(content.redacts);
    return false;
  }
  if (content.msgtype === "m.reaction" && typeof content.relatesTo === "string" && typeof content.key === "string") {
    const action = content.action === "remove" ? "remove" : "add";
    applyReactionEvent(message.id, content.relatesTo, content.key, message.senderUserId ?? decrypted.sender, action);
    return false;
  }
  if (content.msgtype === "m.pin" && typeof content.pins === "string") {
    applyPinEvent(content.pins, content.action === "remove" ? "remove" : "add");
    return false;
  }
  if (content.msgtype === "m.replace" && typeof content.replaces === "string" && typeof content.body === "string") {
    const target = loadedMessages.find((candidate) => candidate.id === content.replaces);
    if (!target?.senderUserId || !message.senderUserId || target.senderUserId !== message.senderUserId) return false;
    const embeds = extractEmbeds(content.body);
    const mentions = Array.isArray(content.mentions) ? content.mentions.filter((value): value is string => typeof value === "string") : [];
    applyEditedBody(content.replaces, content.body, embeds, mentions);
    return false;
  }
  const redactionAuthor = redactionAuthors.get(message.id);
  if (redactionAuthor !== undefined && redactionAuthor && message.senderUserId && redactionAuthor !== message.senderUserId) {
    redactedMessageIds.delete(message.id);
    redactionAuthors.delete(message.id);
  }
  if (redactedMessageIds.has(message.id)) appendDeletedMessage(messageContent);
  const mediaMessage = content.msgtype === "m.image" || content.msgtype === "m.video" || content.msgtype === "m.file";
  const mentionNames = new Set(selectedMembers.filter((member) => effectiveMentions.includes(member.userId)).map((member) => member.username.toLowerCase()));
  const mentionedIds = effectiveMentions;
  const mentionsCurrentUser = Boolean(currentUser && mentionedIds.includes(currentUser.id));
  article.dataset.mentionsCurrentUser = String(mentionsCurrentUser);
  if (mentionsCurrentUser && wasRealtimeMessage && selectedConversationId === message.conversationId && message.senderUserId !== currentUser?.id) {
    mentionHighlightMessageIds.add(message.id);
  }
  article.classList.toggle("message-mention", mentionsCurrentUser
    && (mentionHighlightMessageIds.has(message.id) || hasUnreadConversation()));
  if (mentionsCurrentUser) {
    if (wasRealtimeMessage && selectedConversationId === message.conversationId && message.senderUserId !== currentUser?.id) {
      // The realtime handler owns unread state. Rendering a decrypted mention
      // may happen after the user has already reached the latest message, so
      // do not recreate a badge that was just cleared while the render was in
      // flight.
      if (unreadMarkers.has(message.conversationId)) notifyNewMessage(message.conversationId, message.id, true);
    }
  }
  if (!redactedMessageIds.has(message.id) && !mediaMessage && (content.msgtype === "m.text" || content.msgtype === "m.notice" || body)) {
    appendMarkdown(messageContent, body, { mentionUsernames: mentionNames });
    for (const embed of effectiveEmbeds) appendSafeEmbed(messageContent, embed);
  }
  if (edited) {
    const editedLabel = document.createElement("span");
    editedLabel.className = "edited-label";
    editedLabel.textContent = "(edited)";
    header.append(editedLabel);
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
    mediaProgress.removeAttribute("value");
    mediaProgress.hidden = true;
    mediaButton.addEventListener("click", async () => {
      const controller = new AbortController();
      pendingMediaLoads.set(mediaButton, controller);
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
        if (!mediaButton.isConnected || controller.signal.aborted) return;
        if (fileMessage) {
          const download = document.createElement("a");
          download.className = "media-file-download";
          download.href = URL.createObjectURL(blob);
          download.dataset.mediaUrl = download.href;
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
        mediaWrap.dataset.mediaUrl = previewUrl;
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
        if (!mediaButton.isConnected || controller.signal.aborted) return;
        mediaButton.disabled = false;
        mediaProgress.hidden = true;
        mediaButton.textContent = `${fileMessage ? "File" : video ? "Video" : "Image"} unavailable: ${readableError(loadError)}`;
      } finally {
        pendingMediaLoads.delete(mediaButton);
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
  const editable = !mediaMessage && (content.msgtype === "m.text" || content.msgtype === "m.notice" || Boolean(body)) && isOwnMessage(message);
  if (!redactedMessageIds.has(message.id)) appendMessageActions(messageContent, message, senderIdentity, body, editable);

  if (!redactedMessageIds.has(message.id)) {
    const target: ContextMessage = { message, article, sender: senderIdentity, body, editable };
    messageContextTargets.set(message.id, target);
  }
  messagesPanel.append(article);
  if (pinnedMessageIds.has(message.id)) applyPinEvent(message.id, "add");
  renderMessageReactions(message.id);
  return true;
}

async function withMessageRenderLock<T>(operation: () => Promise<T>) {
  while (messageRenderLock) await messageRenderLock;
  let release!: () => void;
  const lock = new Promise<void>((resolve) => { release = resolve; });
  messageRenderLock = lock;
  try {
    return await operation();
  } finally {
    if (messageRenderLock === lock) messageRenderLock = undefined;
    release();
  }
}

async function renderMessageHistory(options: { scrollAnchor?: ScrollAnchor; scrollToBottom?: boolean } = {}) {
  return withMessageRenderLock(() => renderMessageHistoryInternal(options));
}

async function renderMessageHistoryInternal(options: { scrollAnchor?: ScrollAnchor; scrollToBottom?: boolean } = {}) {
  if (!selectedConversationId || !cryptoClient) return;
  const conversationId = selectedConversationId;
  const activeCryptoClient = cryptoClient;
  if (conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
  const renderToken = ++messageRenderToken;
  messageContextTargets.clear();
  unavailableMessageNotices.clear();
  messageReactions.clear();
  reactionEvents.clear();
  pinnedMessageIds.clear();
  editedMessageBodies.clear();
  releaseMediaResources(messagesPanel);
  messagesPanel.replaceChildren();
  messagesPanel.append(loadOlderButton);
  loadOlderButton.hidden = !nextBefore;
  if (loadedMessages.length === 0) {
    renderConversationWelcome("This is the beginning", "Send a message to start this encrypted conversation.");
    return;
  }

  let previousDay = "";
  let previousGroup: MessageGroupState | undefined;
  for (const message of loadedMessages) {
    if (renderToken !== messageRenderToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    let decrypted: { sender: string; content: Record<string, unknown> } | null = optimisticDecryptedMessages.get(message.id) ?? null;
    let error: string | undefined;
    if (!decrypted) {
      try {
        decrypted = await activeCryptoClient.decryptMessage(conversationId, message);
      } catch (caught) {
        if (roomKeyUnavailable(caught)) {
          appendUnavailableMessage(message.id);
          previousGroup = undefined;
          continue;
        }
        error = readableError(caught);
      }
    }
    if (renderToken !== messageRenderToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
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
    const currentGroup = groupStateForMessage(message, decrypted);
    const grouped = shouldGroupMessage(previousGroup, currentGroup);
    const rendered = renderMessage(message, decrypted, error, { grouped });
    if (!rendered) {
      divider?.remove();
      previousDay = previousDayBeforeMessage;
      continue;
    }
    previousGroup = currentGroup;
  }
  applyMessageSearch();
  if (options.scrollAnchor) {
    restoreScrollAnchor(options.scrollAnchor);
  } else if (options.scrollToBottom !== false) {
    messagesPanel.scrollTop = messagesPanel.scrollHeight;
  }
}

async function appendNewMessages(messages: MessageEnvelope[], conversationId: string, activeCryptoClient: CryptoClient) {
  return withMessageRenderLock(() => appendNewMessagesInternal(messages, conversationId, activeCryptoClient));
}

async function appendNewMessagesInternal(messages: MessageEnvelope[], conversationId: string, activeCryptoClient: CryptoClient) {
  const renderToken = ++messageRenderToken;
  const renderedMessageIds = new Set(
    [...messagesPanel.querySelectorAll<HTMLElement>(".message")]
      .map((article) => article.dataset.messageId)
      .filter((messageId): messageId is string => Boolean(messageId)),
  );
  messagesPanel.querySelector(".conversation-welcome")?.remove();
  messagesPanel.querySelector(".message-search-empty")?.remove();
  const lastElement = messagesPanel.lastElementChild;
  const previousArticle = lastElement instanceof HTMLElement && lastElement.classList.contains("message") && !lastElement.hidden
    ? lastElement
    : undefined;
  let previousDay = previousArticle?.dataset.createdAt ? dateKey(new Date(previousArticle.dataset.createdAt)) : "";
  let previousGroup = groupStateFromArticle(previousArticle);

  for (const message of messages) {
    if (renderToken !== messageRenderToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    if (renderedMessageIds.has(message.id)) continue;
    renderedMessageIds.add(message.id);
    let decrypted: { sender: string; content: Record<string, unknown> } | null = optimisticDecryptedMessages.get(message.id) ?? null;
    let error: string | undefined;
    if (!decrypted) {
      try {
        decrypted = await activeCryptoClient.decryptMessage(conversationId, message);
      } catch (caught) {
        if (roomKeyUnavailable(caught)) {
          appendUnavailableMessage(message.id);
          previousGroup = undefined;
          continue;
        }
        error = readableError(caught);
      }
    }
    if (renderToken !== messageRenderToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    const created = new Date(message.createdAt);
    const currentDay = dateKey(created);
    const sameDay = currentDay === previousDay;
    const dayChanged = !sameDay;
    const previousDayBeforeMessage = previousDay;
    let divider: HTMLElement | undefined;
    if (dayChanged) {
      divider = appendDateDivider(created);
      previousDay = currentDay;
    }
    const currentGroup = groupStateForMessage(message, decrypted);
    const grouped = shouldGroupMessage(previousGroup, currentGroup);
    const rendered = renderMessage(message, decrypted, error, { grouped });
    if (!rendered) {
      divider?.remove();
      previousDay = previousDayBeforeMessage;
      continue;
    }
    previousGroup = currentGroup;
  }
  applyMessageSearch();
}

async function appendOptimisticMessage(message: MessageEnvelope) {
  if (!selectedConversationId || !cryptoClient || message.conversationId !== selectedConversationId) return;
  const conversationId = selectedConversationId;
  const activeCryptoClient = cryptoClient;
  const previousMessages = loadedMessages;
  const merged = mergeMessageWindow([message], "newer");
  observeLatestMessages([message]);
  nextAfter = null;
  lastMessagesKey = messagesKey();
  if (merged.trimmed === 0 && previousMessages.length > 0) {
    await appendNewMessages([message], conversationId, activeCryptoClient);
  } else {
    await renderMessageHistory({ scrollToBottom: true });
  }
  messagesPanel.scrollTop = messagesPanel.scrollHeight;
  clearUnread();
  if (currentUser) void writeCachedMessages(currentUser.id, conversationId, loadedMessages);
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
    const syncPromise = activeCryptoClient.syncToDevice();
    if (selection !== selectionToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) {
      await syncPromise;
      return;
    }

    if (options.forceScrollToBottom || loadedMessages.length === 0) {
      const [result] = await Promise.all([
        api.messages(conversationId, { limit: MESSAGE_PAGE_SIZE }),
        syncPromise,
      ]);
      if (selection !== selectionToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
      loadedMessages = sortMessages(result.messages).slice(-MAX_RENDERED_MESSAGES);
      nextBefore = result.nextBefore;
      nextAfter = null;
      observeLatestMessages(loadedMessages);
      lastMessagesKey = messagesKey();
      await renderMessageHistory({ scrollToBottom: true });
      if (currentUser) void writeCachedMessages(currentUser.id, conversationId, loadedMessages);
      clearUnread({ clearMentionHighlights: false });
      return;
    }

    const previousMessages = loadedMessages;
    const wasNearBottom = messagesPanel.scrollHeight - messagesPanel.scrollTop - messagesPanel.clientHeight < 100;
    const followLatest = options.forceScrollToBottom || wasNearBottom;
    const previousLast = previousMessages[previousMessages.length - 1];
    if (!previousLast) {
      await syncPromise;
      return;
    }
    const catchUpCursor = followLatest || latestObservedSequence === null
      ? previousLast.serverSequence
      : latestObservedSequence.toString();
    const [caughtUp] = await Promise.all([
      fetchNewerMessages(conversationId, activeCryptoClient, selection, catchUpCursor),
      syncPromise,
    ]);
    if (!caughtUp || selection !== selectionToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    const unseen = countUnseenMessages(caughtUp.messages);
    const currentIds = new Set(loadedMessages.map((message) => message.id));
    const newMessages = caughtUp.messages.filter((message) => !currentIds.has(message.id));

    if (!followLatest) {
      if (unseen > 0) {
        unreadCount += unseen;
        updateMentionHighlights();
      }
      nextAfter = caughtUp.messages.length > 0 ? previousLast.serverSequence : caughtUp.nextAfter;
      renderUnreadButton();
      return;
    }

    if (newMessages.length === 0) {
      nextAfter = caughtUp.nextAfter;
      messagesPanel.scrollTop = messagesPanel.scrollHeight;
       clearUnread({ clearMentionHighlights: false });
      return;
    }

    const merged = mergeMessageWindow(newMessages, "newer");
    nextAfter = caughtUp.nextAfter;
    lastMessagesKey = messagesKey();
    const appendOnly = merged.trimmed === 0 && previousMessages.length > 0;
    if (appendOnly) await appendNewMessages(newMessages, conversationId, activeCryptoClient);
    else await renderMessageHistory({ scrollToBottom: true });
    messagesPanel.scrollTop = messagesPanel.scrollHeight;
    if (currentUser) void writeCachedMessages(currentUser.id, conversationId, loadedMessages);
     clearUnread({ clearMentionHighlights: false });
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
    if (currentUser) void writeCachedMessages(currentUser.id, conversationId, loadedMessages);
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
  const name = await askText("Create a server", "Only members you invite can join. The name is encrypted before it leaves this device.", "Server name", "My private server");
  if (!name) return;
  createServerButton.disabled = true;
  mobileCreateServerButton.disabled = true;
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
    mobileCreateServerButton.disabled = false;
    renderServers();
  }
}

async function createChannel() {
  const server = selectedServerId ? servers.find((item) => item.id === selectedServerId) : undefined;
  if (!server || !cryptoClient) return;
  const name = await askText("Create a text channel", "Channel names are encrypted. Each channel has its own conversation key.", "Channel name", "new-channel");
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
    await showOneTimeToken(result.invite.token);
    setStatus("Invite created. Anyone with the token can request access.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    serverInviteButton.disabled = false;
  }
}

async function joinServer() {
  const token = await askText("Join a server", "Ask a server admin for an invite token. It grants access to current channels, not older message history.", "Invite token");
  if (!token) return;
  joinServerButton.disabled = true;
  mobileJoinServerButton.disabled = true;
  try {
    const result = await api.acceptInvite(token);
    await refreshServers();
    await selectServer(result.serverId);
    setStatus("You joined the encrypted server.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    joinServerButton.disabled = false;
    mobileJoinServerButton.disabled = false;
  }
}

function resizeMessageInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`;
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedConversationId || !cryptoClient || sendInProgress) return;
  const conversationId = selectedConversationId;
  const activeCryptoClient = cryptoClient;
  const members = [...selectedMembers];
  const selection = selectionToken;
  const stillHere = () => selection === selectionToken && selectedConversationId === conversationId && cryptoClient === activeCryptoClient;
  const activeEdit = editTarget;
  const text = messageInput.value.trim();
  const file = activeEdit ? undefined : photoInput.files?.[0];
  if (!text && !file) return;
  stopLocalTyping();
  sendInProgress = true;
  updateComposerState();
  hideMentionSuggestions();
  closeEmojiPicker();
  const uploadController = file ? new AbortController() : undefined;
  uploadAbortController = uploadController;
  let textSent = false;
  let editSent = false;
  let queued = false;
  let deliveredMessageCount = 0;
  try {
    if (activeEdit) {
      const embeds = extractEmbeds(text);
      const mentions = mentionedUserIds(text);
      const result = await activeCryptoClient.sendEdit(conversationId, members, activeEdit.messageId, text, embeds, mentions);
      queued = result.delivery === "queued";
      editSent = true;
      if (stillHere()) {
        applyEditedBody(activeEdit.messageId, text, embeds, mentions);
        clearEditTarget();
        setStatus(queued ? "Edit queued on this device; it will retry automatically." : "Message edited.");
        try {
          await refreshMessages({ forceScrollToBottom: false });
        } catch (error) {
          setStatus(`Edit saved, but history could not refresh: ${readableError(error)}`, true);
        }
      }
      return;
    }
    if (text) {
      const mentions = mentionedUserIds(text);
      if (replyTarget?.mentionSender && replyTarget.userId) {
        mentions.push(replyTarget.userId);
      }
      const result = await activeCryptoClient.sendText(conversationId, members, text, extractEmbeds(text), replyTarget, mentions);
      queued = result.delivery === "queued";
      textSent = true;
      if (result.message) {
        deliveredMessageCount += 1;
        if (stillHere()) {
          if (result.decrypted) optimisticDecryptedMessages.set(result.message.id, result.decrypted);
          await appendOptimisticMessage(result.message);
        }
      }
      drafts.delete(conversationId);
      if (stillHere()) {
        messageInput.value = "";
        clearReplyTarget();
        resizeMessageInput();
        clearUnread();
      }
    }
    if (file) {
      const attachmentKind = file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : "file";
      if (stillHere()) {
        attachmentLabel.textContent = `Preparing encrypted ${attachmentKind}…`;
        uploadProgress.removeAttribute("value");
        uploadProgress.hidden = false;
      }
      const result = await activeCryptoClient.sendMedia(conversationId, members, file, {
        signal: uploadController?.signal,
        onProgress: (loadedBytes, totalBytes) => {
          if (!stillHere()) return;
          const percent = totalBytes > 0 ? Math.round((loadedBytes / totalBytes) * 100) : 0;
          attachmentLabel.textContent = totalBytes > 0 ? `Uploading encrypted ${attachmentKind} · ${percent}%` : `Uploading encrypted ${attachmentKind}…`;
          if (totalBytes > 0) uploadProgress.value = percent;
        },
      });
      queued = queued || result.delivery === "queued";
      if (result.message) {
        deliveredMessageCount += 1;
        if (stillHere()) {
          if (result.decrypted) optimisticDecryptedMessages.set(result.message.id, result.decrypted);
          await appendOptimisticMessage(result.message);
        }
      }
      if (stillHere()) {
        photoInput.value = "";
        attachmentPreview.hidden = true;
        uploadProgress.hidden = true;
      }
    }
    if (stillHere()) {
      if (queued) setStatus("Encrypted message queued on this device; it will retry automatically.");
      if (deliveredMessageCount > 0) {
        void refreshMessages({ forceScrollToBottom: true }).catch((error) => {
          setStatus(`Message saved, but history could not refresh: ${readableError(error)}`, true);
        });
      }
    }
  } catch (error) {
    if (stillHere()) {
      setStatus(editSent ? `Edit ${queued ? "queued" : "sent"}, but history refresh failed: ${readableError(error)}` : textSent ? `Text ${queued ? "queued" : "sent"}, but attachment failed: ${readableError(error)}` : readableError(error), true);
      if (file) {
        attachmentLabel.textContent = `${file.name} · ${error instanceof Error && error.name === "AbortError" ? "canceled" : "retry to send"}`;
        uploadProgress.hidden = true;
      }
      if (textSent) void refreshMessages({ forceScrollToBottom: true }).catch(() => undefined);
    }
  } finally {
    if (uploadAbortController === uploadController) uploadAbortController = undefined;
    sendInProgress = false;
    updateComposerState();
    if (stillHere() && mediaViewer.hidden && profileModal.hidden) messageInput.focus();
    void refreshOutboxNotice().catch(() => undefined);
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
messageInput.addEventListener("input", () => {
  if (!editTarget) rememberDraft();
  updateLocalTyping();
});
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
cancelEdit.addEventListener("click", () => clearEditTarget());
emojiToggle.addEventListener("click", toggleEmojiPicker);
notificationToggle.addEventListener("click", () => void toggleNotifications());

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
mobileCreateServerButton.addEventListener("click", () => void createServer());
mobileJoinServerButton.addEventListener("click", () => void joinServer());
createChannelButton.addEventListener("click", () => void createChannel());
serverInviteButton.addEventListener("click", () => void createInvite());
selfProfileButton.addEventListener("click", () => {
  if (currentUser) void openUserProfile(currentUser.id);
});

document.addEventListener("keydown", (event) => {
  if (document.querySelector("dialog[open]")) return;
  const dialog = !mediaViewer.hidden ? mediaViewer : !profileModal.hidden ? profileModal : null;
  if (dialog) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (dialog === mediaViewer) closeMediaViewer();
      else closeProfileModal();
    } else if (event.key === "Tab") {
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button, a[href], input, video[controls]")]
        .filter((element) => !element.closest("[hidden]") && !element.hasAttribute("disabled"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first && last && (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    } else if (dialog === mediaViewer && !event.altKey && !event.ctrlKey && !event.metaKey && document.activeElement !== mediaViewerZoom) {
      if (event.key === "+" || event.key === "=") setMediaZoom(Number(mediaViewerZoom.value) + 0.1);
      if (event.key === "-") setMediaZoom(Number(mediaViewerZoom.value) - 0.1);
      if (event.key === "0") setMediaZoom(1);
    }
    return;
  }
  if (!messageContextMenu.hidden && event.key === "Escape") {
    event.preventDefault();
    closeMessageContextMenu();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (window.matchMedia("(max-width: 760px)").matches) setMobileSidebar(true);
    conversationSearch.focus();
    conversationSearch.select();
  }
  if (event.key === "Escape") {
    if (!emojiPicker.hidden) closeEmojiPicker();
    else if (!mentionSuggestions.hidden) hideMentionSuggestions();
    else if (editTarget && document.activeElement === messageInput) clearEditTarget();
    else if (replyTarget && document.activeElement === messageInput) clearReplyTarget();
    else if (!messageSearchContainer.hidden) closeMessageSearch();
    else if (chatLayout.classList.contains("mobile-sidebar-open")) {
      setMobileSidebar(false);
      mobileSidebarToggle.focus();
    } else if (chatLayout.classList.contains("details-open")) closeDetails();
  }
});

function closeMessageSearch() {
  messageSearchQuery = "";
  messageSearch.value = "";
  messageSearchContainer.hidden = true;
  messageSearchToggle.setAttribute("aria-expanded", "false");
  applyMessageSearch();
  messageSearchToggle.focus();
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
profileModalClose.addEventListener("click", closeProfileModal);
profileModal.addEventListener("click", (event) => {
  if (event.target === profileModal) closeProfileModal();
});

detailsToggle.addEventListener("click", () => {
  const compact = window.matchMedia("(max-width: 1120px)").matches;
  const open = compact
    ? chatLayout.classList.toggle("details-open")
    : !chatLayout.classList.toggle("details-hidden");
  detailsToggle.setAttribute("aria-expanded", String(open));
});

function closeDetails() {
  if (window.matchMedia("(max-width: 1120px)").matches) chatLayout.classList.remove("details-open");
  else chatLayout.classList.add("details-hidden");
  detailsToggle.setAttribute("aria-expanded", "false");
  detailsToggle.focus();
}

detailsClose.addEventListener("click", closeDetails);

loadOlderButton.addEventListener("click", () => void loadOlderMessages());
jumpLatestButton.addEventListener("click", () => {
  clearUnread();
  void refreshMessages({ forceScrollToBottom: true }).catch((error) => setStatus(readableError(error), true));
});
messagesPanel.addEventListener("scroll", () => {
  if (isAtLatestMessage()) {
    clearUnread();
    if (nextAfter) void refreshMessages();
  } else renderUnreadButton();
  if (messagesPanel.scrollTop < 240 && nextBefore) void loadOlderMessages();
});
lockButton.addEventListener("click", () => {
  lockLocalSession();
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

function setDetailsForConversation(showByDefault: boolean) {
  if (window.matchMedia("(max-width: 1120px)").matches) {
    chatLayout.classList.remove("details-hidden", "details-open");
  } else {
    chatLayout.classList.toggle("details-hidden", !showByDefault);
    chatLayout.classList.remove("details-open");
  }
  syncDetailsButton();
}

window.addEventListener("resize", syncDetailsButton);
syncDetailsButton();

function setMobileSidebar(open: boolean, focusSearch = false) {
  chatLayout.classList.toggle("mobile-sidebar-open", open);
  mobileSidebarToggle.setAttribute("aria-expanded", String(open));
  mobileSidebarToggle.setAttribute("aria-label", open ? "Hide conversations" : "Show conversations");
  sidebar.inert = window.matchMedia("(max-width: 760px)").matches && !open;
  if (open && focusSearch && window.matchMedia("(max-width: 760px)").matches) mobileServerSelect.focus();
}

mobileSidebarToggle.addEventListener("click", () => {
  setMobileSidebar(!chatLayout.classList.contains("mobile-sidebar-open"), true);
});
mobileSidebarClose.addEventListener("click", () => {
  setMobileSidebar(false);
  mobileSidebarToggle.focus();
});
mobileSidebarBackdrop.addEventListener("click", () => {
  setMobileSidebar(false);
  mobileSidebarToggle.focus();
});

window.addEventListener("resize", () => setMobileSidebar(chatLayout.classList.contains("mobile-sidebar-open")));
setMobileSidebar(chatLayout.classList.contains("mobile-sidebar-open"));
document.addEventListener("visibilitychange", () => {
  publishPresence(document.visibilityState === "hidden" ? "idle" : "online");
  if (document.visibilityState === "visible" && selectedConversationId && isAtLatestMessage()) {
    clearUnread();
    void refreshMessages().catch((error) => setStatus(readableError(error), true));
  }
});
window.addEventListener("focus", () => {
  if (!selectedConversationId || !isAtLatestMessage()) return;
  clearUnread();
  void refreshMessages().catch((error) => setStatus(readableError(error), true));
});
window.addEventListener("pagehide", () => {
  stopLocalTyping();
  publishPresence("offline");
});

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
        .then(() => refreshSelectedRoomKeys().catch(() => undefined))
        .then(() => flushOutbox())
        .then(() => refreshMessages())
        .catch(() => undefined);
    }
  }, 2000);
}

void boot();
