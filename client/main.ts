import {
  ApiError,
  ApiClient,
  type Conversation,
  type ConversationMember,
  type CustomServerRole,
  type GifProvider,
  type GifProviderConfiguration,
  type MessageEnvelope,
  type MessagePage,
  type ModerationWarningNotice,
  type SpaceWarningNotice,
  type Server,
  type ServerCategory,
  type ServerChannel,
  type ServerPermission,
  type User,
} from "./api";
import { CryptoClient, LocalCryptoStoreError, MAX_MESSAGE_TEXT_LENGTH, type DecryptedMessage, type ReplyReference } from "./crypto";
import { roomKeyUnavailable } from "./decryption";
import { synchronizeFcmPush } from "./push-notifications";
import { encryptReportEvidence } from "./report-evidence";
import { appendSafeEmbed, extractEmbeds, normalizeStoredEmbeds, prepareEmbeds, type SafeEmbed } from "./embeds";
import { gifProviderLabel, loadGifProviderConfiguration, searchGifs, trendingGifs, type GifSearchResult } from "./gifs";
import { applyAppPreferences, defaultAppPreferences, loadAppPreferences, readableAccentText, saveAppPreferences, shouldNotifyAppMessage, type AppPreferences } from "./app-preferences";
import {
  emojiEntryAt,
  emojiShortcodeMatches,
  emojiShortcodeName,
  emojiShortcodeToken,
  emojiShortcodes,
  replaceEmojiShortcodes,
} from "./emoji";
import { renderAvatar, setAvatarStyle } from "./avatar";
import type { EmojiCategory } from "./emoji-data";
import { appendMarkdown } from "./markdown";
import { formatMessageMacrosAsText, freezeNowMessageMacros, refreshRelativeTimeMacros } from "./message-macros";
import { deleteCachedMessages, readCachedMessages, writeCachedMessages } from "./message-cache";
import { VoiceCallController, type VoiceCallView } from "./voice-calls";
import type { VoiceSignalBody } from "./voice-protocol";
import { VoiceRoomController, type VoiceRoomView } from "./voice-rooms";
import type { VoiceRoomSignalBody } from "./voice-room-protocol";
import { isEmojiOnlyMessage } from "./message-format";
import { renderHighlightedCode } from "./code-highlight";
import { messageGroupState, shouldGroupMessage, type MessageGroupState } from "./message-grouping";
import { highestSeparatedRole } from "./member-roles";
import { canReconcileLatestMessagePage } from "./message-window";
import { roomReferenceSlug, roomReferenceToken } from "./room-reference";
import { isPlaintextAttachment, readTextPreview, textLanguage, textPreviewExcerpt } from "./text-file";
import { confirmLocalUnlock, lockLocalSession, resolveLocalPassphrase } from "./unlock-vault";
import { iconElement, renderIcons } from "./icons";
import { askText, showOneTimeToken } from "./ui-dialog";

const api = new ApiClient();
let currentUser: User | undefined;
let appPreferences: AppPreferences = { ...defaultAppPreferences };

function setRoleTextColor(element: HTMLElement, color: string) {
  element.style.setProperty("--role-color", color);
  element.style.setProperty("--role-text-color", readableAccentText(color, appPreferences.theme));
}
let cryptoClient: CryptoClient | undefined;
let voiceCalls: VoiceCallController | undefined;
let voiceRooms: VoiceRoomController | undefined;
let selectedConversationId: string | undefined;
let selectedMembers: ConversationMember[] = [];
let conversations: Conversation[] = [];
let servers: Server[] = [];
let channels: ServerChannel[] = [];
const channelsByServer = new Map<string, ServerChannel[]>();
let categories: ServerCategory[] = [];
let serverRoles: CustomServerRole[] = [];
const serverRoleLabels = new Map<string, string>();
let selectedServerId: string | undefined;
let selectedChannelId: string | undefined;
let activeServerWelcome: {
  enabled: boolean;
  heading: string;
  description: string;
  rules: string;
  acknowledgement: boolean;
} | undefined;
const customEmojiAssets = new Map<string, { src: string; alt: string }>();
let customEmojiObjectUrls: string[] = [];
let customEmojiHydrationToken = 0;
const serverLabels = new Map<string, string>();
const channelLabels = new Map<string, string>();
const categoryLabels = new Map<string, string>();
const collapsedCategories = new Set<string>();
const mutedChannelIds = new Set<string>();
let realtime: WebSocket | undefined;
let realtimeReadySocket: WebSocket | undefined;
let realtimeHandshakeTimer: number | undefined;
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
const decryptedMessageCache = new Map<string, DecryptedMessage>();
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
type ComposerAttachmentStatus = "ready" | "uploading" | "error";
type ComposerAttachment = {
  id: string;
  file: File;
  spoiler: boolean;
  status: ComposerAttachmentStatus;
  progress: number;
  error?: string;
  previewUrl?: string;
  row?: HTMLElement;
  progressElement?: HTMLProgressElement;
  statusElement?: HTMLElement;
};
type MediaAlbumInfo = { id: string; index: number; total: number };
type MediaCardController = {
  filename: string;
  video: boolean;
  spoiler: boolean;
  blob?: Blob;
  isRevealed: () => boolean;
  reveal: () => void;
  load: () => Promise<Blob | undefined>;
};
type MediaViewerItem = MediaCardController;
type ReactionOption = { emoji: string; code: string; label: string };
type TwemojiOption = { emoji: string; code: string };
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
const emojiOptions = emojiShortcodes;
type EmojiPickerOption = (typeof emojiOptions)[number];
type EmojiPickerCategory = EmojiCategory;
const emojiPickerCategories: Array<{ id: EmojiPickerCategory; label: string; icon: string }> = [
  { id: "Smileys & Emotion", label: "Smileys and emotion", icon: "😀" },
  { id: "People & Body", label: "People and body", icon: "👋" },
  { id: "Animals & Nature", label: "Animals and nature", icon: "🐻" },
  { id: "Food & Drink", label: "Food and drink", icon: "🍔" },
  { id: "Travel & Places", label: "Travel and places", icon: "✈️" },
  { id: "Activities", label: "Activities", icon: "⚽" },
  { id: "Objects", label: "Objects", icon: "💡" },
  { id: "Symbols", label: "Symbols", icon: "❤️" },
  { id: "Flags", label: "Flags", icon: "🏳️" },
];
let emojiPickerCategory: EmojiPickerCategory = "Smileys & Emotion";
let emojiPickerObserver: IntersectionObserver | undefined;
const lazyEmojiOptions = new WeakMap<HTMLElement, EmojiPickerOption[]>();
let gifProviderConfiguration: GifProviderConfiguration | undefined;
let gifPickerProviderId: GifProvider["id"] | undefined;
let gifPickerSearchTimer: number | undefined;
let gifPickerSearchAbort: AbortController | undefined;
let gifPickerDownloadAbort: AbortController | undefined;
let gifPickerToken = 0;
let gifPickerDownloadInProgress = false;

function renderEmojiSectionItems(section: HTMLElement) {
  const items = section.querySelector<HTMLElement>(".emoji-category-items");
  const candidates = lazyEmojiOptions.get(section);
  if (!items || !candidates || items.dataset.rendered === "true") return;
  items.dataset.rendered = "true";
  items.style.minHeight = "";
  for (const option of candidates) {
    const button = document.createElement("button");
    button.type = "button";
    appendTwemoji(button, option);
    button.querySelector<HTMLImageElement>("img")!.loading = "lazy";
    button.title = `Insert :${option.name}:`;
    button.setAttribute("aria-label", `Insert :${option.name}:`);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => insertEmoji(option.emoji));
    items.append(button);
  }
}

function customEmojiPickerEntries(query: string) {
  return [...customEmojiAssets.entries()]
    .filter(([name]) => !query || name.includes(query))
    .sort(([left], [right]) => left.localeCompare(right));
}

function renderCustomEmojiPickerSection(query: string) {
  const candidates = customEmojiPickerEntries(query);
  if (candidates.length === 0) return false;
  const section = document.createElement("section");
  section.className = "emoji-category-section custom-emoji-category-section";
  const heading = document.createElement("h3");
  heading.className = "emoji-category-heading";
  heading.textContent = "Custom emoji";
  const items = document.createElement("div");
  items.className = "emoji-category-items";
  for (const [name, asset] of candidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = `Insert :${name}:`;
    button.setAttribute("aria-label", `Insert :${name}:`);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => insertEmoji(`:${name}:`));
    const image = document.createElement("img");
    image.className = "custom-emoji-picker-image";
    image.src = asset.src;
    image.alt = asset.alt;
    image.draggable = false;
    button.append(image);
    items.append(button);
  }
  section.append(heading, items);
  emojiPickerGrid.append(section);
  return true;
}
let editTarget: EditTarget | undefined;
let contextMessage: ContextMessage | undefined;
const messageContextTargets = new Map<string, ContextMessage>();
const unavailableMessageNotices = new Map<string, HTMLElement>();
const messageReactions = new Map<string, Map<string, Set<string>>>();
const reactionEvents = new Map<string, { targetId: string; key: string; senderKey: string; action: "add" | "remove" }>();
const pinnedMessageIds = new Set<string>();
const editedMessageBodies = new Map<string, { body: string; embeds: SafeEmbed[]; mentions: string[]; roleMentions: string[] }>();
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
const MESSAGE_DECRYPT_BATCH_SIZE = 24;
const DECRYPTED_MESSAGE_CACHE_LIMIT = 600;
const MAX_RENDERED_MESSAGES = 300;
const MAX_CATCH_UP_PAGES = 100;
const JUMP_TO_LATEST_SHOW_MIN_DISTANCE = 400;
const JUMP_TO_LATEST_HIDE_MIN_DISTANCE = 280;
const JUMP_TO_LATEST_SHOW_VIEWPORT_RATIO = 0.75;
const JUMP_TO_LATEST_HIDE_VIEWPORT_RATIO = 0.55;
let jumpLatestVisible = false;
let jumpLatestConversationId: string | undefined;
let selectionToken = 0;
let serverSelectionToken = 0;

function byId<T extends HTMLElement>(id: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element: ${id}`);
  return element as T;
}

const chatLayout = byId<HTMLElement>("chat-panel");
const chatMain = document.querySelector<HTMLElement>(".chat-main")!;
const sidebar = byId<HTMLElement>("workspace-sidebar");
const statusLine = byId<HTMLElement>("status-line");
const connectionIndicator = byId<HTMLElement>("connection-indicator");
const voiceCallButton = byId<HTMLButtonElement>("voice-call-button");
const voiceRoomPanel = byId<HTMLElement>("voice-room-panel");
const voiceRoomPanelTitle = byId<HTMLElement>("voice-room-panel-title");
const voiceRoomPanelStatus = byId<HTMLElement>("voice-room-panel-status");
const voiceRoomJoinButton = byId<HTMLButtonElement>("voice-room-join-button");
const voiceCallDialog = byId<HTMLDialogElement>("voice-call-dialog");
const voiceCallTitle = byId<HTMLElement>("voice-call-title");
const voiceCallStatus = byId<HTMLElement>("voice-call-status");
const voiceCallAudioOutput = byId<HTMLElement>("voice-call-audio-output");
const voiceCallAccept = byId<HTMLButtonElement>("voice-call-accept");
const voiceCallDecline = byId<HTMLButtonElement>("voice-call-decline");
const voiceCallMute = byId<HTMLButtonElement>("voice-call-mute");
const voiceCallEnd = byId<HTMLButtonElement>("voice-call-end");
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
const deactivatedSpaceView = byId<HTMLElement>("deactivated-space-view");
const deactivatedSpaceName = byId<HTMLElement>("deactivated-space-name");
const deactivatedSpaceNavigation = byId<HTMLButtonElement>("deactivated-space-navigation");
const messagesPanel = byId<HTMLElement>("messages");
const moderationNotices = byId<HTMLElement>("moderation-notices");
const memberList = byId<HTMLElement>("member-list");
const serverList = byId<HTMLElement>("server-list");
const channelSectionHeading = byId<HTMLElement>("channel-section-heading");
const channelSectionCount = byId<HTMLElement>("channel-section-count");
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
const chatContent = byId<HTMLElement>("chat-content");
const fileDropOverlay = byId<HTMLElement>("file-drop-overlay");
const composer = byId<HTMLFormElement>("composer");
const messageInputRendered = byId<HTMLElement>("message-input-rendered");
const messageInput = byId<HTMLTextAreaElement>("message-input");
const photoInput = byId<HTMLInputElement>("photo-input");
const sendButton = byId<HTMLButtonElement>("send-button");
const attachmentPreview = byId<HTMLElement>("attachment-preview");
const attachmentPreviewList = byId<HTMLElement>("attachment-preview-list");
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
const emojiSuggestions = byId<HTMLElement>("emoji-suggestions");
const macroSuggestions = byId<HTMLElement>("macro-suggestions");
const emojiPicker = byId<HTMLElement>("emoji-picker");
const emojiPickerSearch = byId<HTMLInputElement>("emoji-picker-search");
const emojiCategoryTabs = byId<HTMLElement>("emoji-category-tabs");
const emojiPickerGrid = byId<HTMLElement>("emoji-picker-grid");
const emojiToggle = byId<HTMLButtonElement>("emoji-toggle");
const gifPicker = byId<HTMLElement>("gif-picker");
const gifPickerProvider = byId<HTMLSelectElement>("gif-picker-provider");
const gifPickerSearch = byId<HTMLInputElement>("gif-picker-search");
const gifPickerClose = byId<HTMLButtonElement>("gif-picker-close");
const gifPickerNotice = byId<HTMLElement>("gif-picker-notice");
const gifPickerAttribution = byId<HTMLAnchorElement>("gif-picker-attribution");
const gifPickerResults = byId<HTMLElement>("gif-picker-results");
const gifToggle = byId<HTMLButtonElement>("gif-toggle");
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
const mediaViewerCopy = byId<HTMLButtonElement>("media-viewer-copy");
const mediaViewerPrevious = byId<HTMLButtonElement>("media-viewer-previous");
const mediaViewerNext = byId<HTMLButtonElement>("media-viewer-next");
const mediaViewerCount = byId<HTMLElement>("media-viewer-count");
const mediaViewerDownload = byId<HTMLAnchorElement>("media-viewer-download");
const mediaViewerClose = byId<HTMLButtonElement>("media-viewer-close");
let mediaViewerUrl: string | undefined;
let mediaViewerElement: HTMLElement | undefined;
let mediaViewerText: string | undefined;
let mediaViewerItems: MediaViewerItem[] = [];
let mediaViewerIndex = 0;
let mediaViewerRenderToken = 0;
const profileModal = byId<HTMLElement>("profile-modal");
const profileModalClose = byId<HTMLButtonElement>("profile-modal-close");
const profileModalBanner = byId<HTMLElement>("profile-modal-banner");
const profileModalAvatar = byId<HTMLElement>("profile-modal-avatar");
const profileModalName = byId<HTMLElement>("profile-modal-name");
const profileModalUsername = byId<HTMLElement>("profile-modal-username");
const profileModalCreated = byId<HTMLTimeElement>("profile-modal-created");
const profileModalEdit = byId<HTMLAnchorElement>("profile-modal-edit");
const profileModalSafetyActions = byId<HTMLElement>("profile-modal-safety-actions");
const profileModalReport = byId<HTMLButtonElement>("profile-modal-report");
const profileModalBlock = byId<HTMLButtonElement>("profile-modal-block");
const messageContextMenu = byId<HTMLElement>("message-context-menu");
const navigationContextMenu = byId<HTMLElement>("navigation-context-menu");
let profileRequest = 0;
let profileModalUserId: string | undefined;
let profileModalUserBlocked = false;
let modalReturnFocus: HTMLElement | null = null;
let activeSuggestionIndex = -1;
let composerAttachments: ComposerAttachment[] = [];
let composerAttachmentSequence = 0;
const mediaCardControllers = new WeakMap<HTMLElement, MediaCardController>();
const autoMediaLoadTargets = new Map<HTMLElement, () => Promise<void>>();
const autoMediaLoadQueue: Array<() => Promise<void>> = [];
let autoMediaLoadsInFlight = 0;
const MAX_AUTO_MEDIA_LOADS = 3;
let autoMediaLoadObserver: IntersectionObserver | undefined;

function setChannelIcon(name: string) {
  channelIcon.replaceChildren(iconElement(name));
  renderIcons(channelIcon);
}

function setStatus(message: string, error = false) {
  if (error) console.error(`[Naigi] ${message}`);
}

type ScopedWarningNotice = ModerationWarningNotice & { scope: "instance" | "space"; serverId?: string };
let instanceWarningNotices: ModerationWarningNotice[] = [];
let serverWarningNotices: SpaceWarningNotice[] = [];
let warningNoticeRequest = 0;

function renderModerationNotices() {
  moderationNotices.replaceChildren();
  const notices: ScopedWarningNotice[] = [
    ...instanceWarningNotices.map((warning) => ({ ...warning, scope: "instance" as const })),
    ...serverWarningNotices.map((warning) => ({ ...warning, scope: "space" as const })),
  ];
  moderationNotices.hidden = notices.length === 0;
  for (const warning of notices) {
    const item = document.createElement("article");
    item.className = "chat-moderation-notice";
    const copy = document.createElement("div");
    copy.className = "chat-moderation-notice-copy";
    const heading = document.createElement("strong");
    heading.textContent = warning.scope === "instance"
      ? "Instance-wide warning"
      : `Space warning · ${warning.serverId ? serverNameForId(warning.serverId) : "space"}`;
    const reason = document.createElement("p");
    reason.textContent = warning.reason;
    const issued = new Date(warning.createdAt);
    const expires = warning.expiresAt ? new Date(warning.expiresAt) : null;
    const details = document.createElement("small");
    details.textContent = `Issued ${Number.isNaN(issued.getTime()) ? "recently" : issued.toLocaleString()}${expires ? ` · expires ${Number.isNaN(expires.getTime()) ? "later" : expires.toLocaleString()}` : " · no expiry"}`;
    copy.append(heading, reason, details);
    const acknowledge = document.createElement("button");
    acknowledge.type = "button";
    acknowledge.className = "secondary";
    acknowledge.textContent = "Acknowledge";
    acknowledge.addEventListener("click", async () => {
      acknowledge.disabled = true;
      try {
        if (warning.scope === "instance") await api.acknowledgeInstanceWarning(warning.id);
        else await api.acknowledgeSpaceWarning(warning.id);
        if (warning.scope === "instance") instanceWarningNotices = instanceWarningNotices.filter((entry) => entry.id !== warning.id);
        else serverWarningNotices = serverWarningNotices.filter((entry) => entry.id !== warning.id);
        renderModerationNotices();
      } catch {
        acknowledge.disabled = false;
        acknowledge.textContent = "Retry acknowledgement";
      }
    });
    item.append(copy, acknowledge);
    moderationNotices.append(item);
  }
}

async function refreshModerationNotices(serverId = selectedServerId) {
  const request = ++warningNoticeRequest;
  const [instanceResult, serverResult] = await Promise.all([
    api.myInstanceWarnings().catch(() => null),
    api.mySpaceWarnings().catch(() => null),
  ]);
  if (request !== warningNoticeRequest || selectedServerId !== serverId) return;
  if (instanceResult) instanceWarningNotices = instanceResult.warnings;
  if (serverResult) serverWarningNotices = serverResult.warnings;
  renderModerationNotices();
}

function notificationsSupported() {
  return typeof Notification !== "undefined";
}

function externalPreviewsEnabled() {
  return appPreferences.externalPreviews;
}

function prepareAppEmbeds(text: string) {
  return externalPreviewsEnabled() ? prepareEmbeds(text) : Promise.resolve<SafeEmbed[]>([]);
}

function updateNotificationToggle() {
  const supported = notificationsSupported();
  const active = supported && notificationsEnabled && Notification.permission === "granted";
  notificationToggle.disabled = !supported;
  notificationToggle.setAttribute("aria-pressed", String(active));
  notificationToggle.title = !supported
    ? "Desktop notifications are unavailable"
    : active
      ? "Disable desktop notifications"
      : "Enable desktop notifications";
  notificationToggle.setAttribute("aria-label", notificationToggle.title);
}

function loadNotificationPreference() {
  notificationsEnabled = appPreferences.notificationMode !== "off"
    && notificationsSupported()
    && Notification.permission === "granted";
  updateNotificationToggle();
}

async function toggleNotifications() {
  if (!notificationsSupported()) {
    setStatus("This browser does not support desktop notifications.", true);
    return;
  }
  if (notificationsEnabled) {
    appPreferences = saveAppPreferences(currentUser?.id, { ...appPreferences, notificationMode: "off" });
    notificationsEnabled = false;
    if (currentUser) void synchronizeFcmPush(api, currentUser.id, appPreferences);
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
    if (notificationsEnabled) {
      const notificationMode = appPreferences.notificationMode === "off" ? "all" : appPreferences.notificationMode;
      appPreferences = saveAppPreferences(currentUser?.id, { ...appPreferences, notificationMode });
      if (currentUser) void synchronizeFcmPush(api, currentUser.id, appPreferences);
    }
    updateNotificationToggle();
    setStatus(notificationsEnabled ? "Desktop notifications enabled." : "Desktop notifications were not enabled.", !notificationsEnabled);
  } catch {
    notificationsEnabled = false;
    updateNotificationToggle();
    setStatus("Unable to request desktop notification permission.", true);
  }
}

async function notifyIfEncryptedMessageMentionsCurrentUser(conversationId: string, messageId: string, serverSequence: string) {
  const activeCryptoClient = cryptoClient;
  const user = currentUser;
  if (!activeCryptoClient || !user || appPreferences.notificationMode !== "mentions" || !notificationsEnabled) return;
  try {
    const sequence = BigInt(serverSequence);
    if (sequence < 1n) return;
    const page = await api.messages(conversationId, { after: String(sequence - 1n), limit: 1 });
    if (activeCryptoClient !== cryptoClient || !page.messages.some((message) => message.id === messageId)) return;
    const message = page.messages.find((candidate) => candidate.id === messageId)!;
    const [result] = await activeCryptoClient.decryptMessages(conversationId, [message]);
    if (!result || !("decrypted" in result) || activeCryptoClient !== cryptoClient) return;
    const content = result.decrypted.content;
    const mentions = Array.isArray(content.mentions) ? content.mentions.filter((value): value is string => typeof value === "string") : [];
    const roleMentions = Array.isArray(content.roleMentions) ? content.roleMentions.filter((value): value is string => typeof value === "string") : [];
    let isMention = mentions.includes(user.id);
    if (!isMention && roleMentions.length > 0) {
      const serverEntry = [...channelsByServer.entries()].find(([, serverChannels]) => serverChannels.some((channel) => channel.conversationId === conversationId));
      if (serverEntry) {
        const [serverId] = serverEntry;
        const [membersResult, rolesResult] = await Promise.all([
          api.conversationMembers(conversationId),
          api.serverRoles(serverId),
        ]);
        if (activeCryptoClient !== cryptoClient) return;
        const ownRoleIds = normalizeRoleIds(membersResult.members.find((member) => member.userId === user.id)?.roleIds);
        isMention = roleMentions.some((roleId) => ownRoleIds.includes(roleId)
          && rolesResult.roles.find((role) => role.id === roleId)?.systemKey !== "owner");
      }
    }
    if (isMention) notifyNewMessage(conversationId, messageId, true, true);
  } catch {
    // Mention checks are best effort; ciphertext and plaintext remain client-only.
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

function notifyNewMessage(conversationId: string, messageId?: string, force = false, isMention = false) {
  if (!notificationsSupported() || !notificationsEnabled || Notification.permission !== "granted") return;
  if (!shouldNotifyAppMessage(appPreferences, isMention)) return;
  const muted = [...channelsByServer.values()].some((serverChannels) => serverChannels.some((channel) => channel.conversationId === conversationId && mutedChannelIds.has(channel.id)));
  if (muted) return;
  if (messageId && notifiedRealtimeMessageIds.has(messageId)) return;
  const awayFromConversation = conversationId !== selectedConversationId
    || document.visibilityState === "hidden"
    || messagesPanel.scrollHeight - messagesPanel.scrollTop - messagesPanel.clientHeight >= 100;
  if (!force && !awayFromConversation) return;
  if (appPreferences.sounds) playNotificationSound();
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

function playNotificationSound() {
  if (!appPreferences.sounds || typeof AudioContext === "undefined") return;
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.035, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.13);
    oscillator.addEventListener("ended", () => void context.close());
  } catch {
    // Browsers may reject audio until the user has interacted with the page.
  }
}

function setConnectionStatus(message: string, state: "connected" | "connecting" | "offline") {
  statusLine.textContent = message;
  connectionIndicator.dataset.state = state;
  connectionIndicator.title = message;
}

function updateVoiceCallButton() {
  const conversation = selectedConversationId
    ? conversations.find((item) => item.id === selectedConversationId)
    : undefined;
  const channel = selectedChannelId ? channels.find((item) => item.id === selectedChannelId) : undefined;
  const voiceChannel = channel?.kind === "voice" ? channel : undefined;
  voiceCallButton.hidden = voiceChannel ? false : Boolean(selectedServerId) || conversation?.kind !== "dm";
  voiceCallButton.title = voiceChannel ? "Join voice room" : "Start end-to-end encrypted voice call";
  voiceCallButton.setAttribute("aria-label", voiceCallButton.title);
  voiceCallButton.replaceChildren(iconElement(voiceChannel ? "headphones" : "phone"));
  renderIcons(voiceCallButton);
  const roomState = voiceRooms?.currentState;
  const callState = voiceCalls?.currentState;
  const roomBusy = Boolean(roomState && roomState.status !== "idle");
  const callBusy = Boolean(callState && callState.status !== "idle");
  voiceCallButton.disabled = !conversationReady || roomBusy || callBusy;
  updateVoiceRoomPanel();
}

function updateVoiceRoomPanel() {
  const channel = selectedChannelId ? channels.find((item) => item.id === selectedChannelId && item.kind === "voice") : undefined;
  voiceRoomPanel.hidden = !channel;
  if (!channel) return;
  voiceRoomPanelTitle.textContent = channelDisplayName(channel);
  const roomState = voiceRooms?.currentState ?? { status: "idle" as const };
  const callState = voiceCalls?.currentState;
  const callBusy = Boolean(callState && callState.status !== "idle");
  const activeHere = roomState.channelId === channel.id;
  voiceRoomJoinButton.disabled = !conversationReady || callBusy || roomState.status !== "idle";
  if (activeHere && roomState.status === "joining") {
    voiceRoomJoinButton.textContent = "Joining…";
    voiceRoomPanelStatus.textContent = "Finding the active room and sharing its encrypted media key…";
  } else if (activeHere && roomState.status === "connecting") {
    voiceRoomJoinButton.textContent = "Connecting…";
    voiceRoomPanelStatus.textContent = "Connecting to the encrypted voice relay…";
  } else if (activeHere && roomState.status === "reconnecting") {
    voiceRoomJoinButton.textContent = "Reconnecting…";
    voiceRoomPanelStatus.textContent = "Trying to restore your encrypted audio connection…";
  } else if (activeHere && roomState.status === "connected") {
    voiceRoomJoinButton.textContent = "In voice room";
    const count = roomState.participantCount ?? 1;
    voiceRoomPanelStatus.textContent = `Connected · ${count} participant${count === 1 ? "" : "s"}`;
  } else if (roomState.status !== "idle") {
    voiceRoomJoinButton.textContent = "Leave the other room first";
    voiceRoomPanelStatus.textContent = "You can only join one voice room at a time.";
  } else if (callBusy) {
    voiceRoomJoinButton.textContent = "Finish your direct call first";
    voiceRoomPanelStatus.textContent = "You can only use one voice connection at a time.";
  } else {
    voiceRoomJoinButton.textContent = "Join voice room";
    voiceRoomPanelStatus.textContent = "Audio is end-to-end encrypted. Room capacity is determined by the host’s LiveKit deployment.";
  }
}

function renderVoiceCall(state: VoiceCallView) {
  if (state.status === "idle") {
    if (voiceRooms?.currentState.status === "idle" && voiceCallDialog.open) voiceCallDialog.close();
    updateVoiceCallButton();
    return;
  }

  if (!voiceCallDialog.open) voiceCallDialog.showModal();
  voiceCallTitle.textContent = state.status === "incoming" ? "Incoming voice call" : "Voice call";
  if (state.status === "incoming") voiceCallStatus.textContent = `${state.peerName} is calling you.`;
  else if (state.status === "calling") voiceCallStatus.textContent = `Calling ${state.peerName}…`;
  else if (state.status === "connecting") voiceCallStatus.textContent = `Connecting to ${state.peerName}…`;
  else if (state.status === "reconnecting") voiceCallStatus.textContent = `Reconnecting to ${state.peerName}…`;
  else voiceCallStatus.textContent = `Connected with ${state.peerName}.`;

  const incoming = state.status === "incoming";
  const connected = state.status === "connected" || state.status === "reconnecting";
  voiceCallAccept.hidden = !incoming;
  voiceCallDecline.hidden = !incoming;
  voiceCallMute.hidden = !connected;
  voiceCallEnd.hidden = incoming;
  voiceCallEnd.textContent = state.status === "calling" ? "Cancel call" : "Leave call";
  voiceCallMute.textContent = state.muted ? "Unmute microphone" : "Mute microphone";
  updateVoiceCallButton();
}

function renderVoiceRoom(state: VoiceRoomView) {
  if (state.status === "idle") {
    if (voiceCalls?.currentState.status === "idle" && voiceCallDialog.open) voiceCallDialog.close();
    updateVoiceCallButton();
    return;
  }
  if (!voiceCallDialog.open) voiceCallDialog.showModal();
  voiceCallTitle.textContent = "Voice room";
  if (state.status === "joining") voiceCallStatus.textContent = `Joining ${state.roomName ?? "voice room"}…`;
  else if (state.status === "connecting") voiceCallStatus.textContent = `Connecting to ${state.roomName ?? "voice room"}…`;
  else if (state.status === "reconnecting") voiceCallStatus.textContent = `Reconnecting to ${state.roomName ?? "voice room"}…`;
  else {
    const count = state.participantCount ?? 1;
    voiceCallStatus.textContent = `Connected to ${state.roomName ?? "voice room"} · ${count} participant${count === 1 ? "" : "s"}.`;
  }
  voiceCallAccept.hidden = true;
  voiceCallDecline.hidden = true;
  voiceCallMute.hidden = state.status !== "connected" && state.status !== "reconnecting";
  voiceCallEnd.hidden = false;
  voiceCallEnd.textContent = state.status === "joining" || state.status === "connecting" ? "Cancel join" : "Leave room";
  voiceCallMute.textContent = state.muted ? "Unmute microphone" : "Mute microphone";
  updateVoiceCallButton();
}

async function voiceConversationMembers(conversationId: string) {
  const result = await api.conversationMembers(conversationId);
  return result.members.map((member) => ({ ...member, roleIds: normalizeRoleIds(member.roleIds) }));
}

async function encryptVoiceSignal(conversationId: string, value: VoiceSignalBody) {
  if (!cryptoClient) throw new Error("crypto_not_initialized");
  const members = await voiceConversationMembers(conversationId);
  return cryptoClient.encryptMetadata(conversationId, members, value);
}

async function encryptVoiceRoomSignal(conversationId: string, value: VoiceRoomSignalBody) {
  if (!cryptoClient) throw new Error("crypto_not_initialized");
  const members = await voiceConversationMembers(conversationId);
  return cryptoClient.encryptMetadata(conversationId, members, value);
}

async function decryptVoiceSignal(conversationId: string, ciphertext: string) {
  const activeCrypto = cryptoClient;
  if (!activeCrypto) throw new Error("crypto_not_initialized");
  try {
    return await activeCrypto.decryptMetadata(conversationId, ciphertext);
  } catch {
    const members = await voiceConversationMembers(conversationId);
    await activeCrypto.prepareConversation(conversationId, members);
    await activeCrypto.syncToDevice().catch(() => undefined);
    return activeCrypto.decryptMetadata(conversationId, ciphertext);
  }
}

function voicePeerName(conversationId: string, senderUserId?: string) {
  const member = selectedConversationId === conversationId
    ? selectedMembers.find((candidate) => candidate.userId === senderUserId)
    : undefined;
  if (member) return member.displayName;
  return conversations.find((conversation) => conversation.id === conversationId)?.memberDisplayNames[0] ?? "Contact";
}

function initializeVoiceCalls(userId: string) {
  voiceCalls = new VoiceCallController({
    currentUserId: userId,
    requestToken: (conversationId, callId) => api.voiceToken(conversationId, callId),
    checkAccess: async (conversationId, callId) => {
      try {
        return (await api.voiceCallAuthorized(conversationId, callId)).authorized;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
        throw error;
      }
    },
    encryptSignal: encryptVoiceSignal,
    decryptSignal: decryptVoiceSignal,
    sendSignal: (conversationId, ciphertext) => sendRealtimeCommand({ type: "voice.signal", conversationId, ciphertext }),
    onState: renderVoiceCall,
    audioOutput: voiceCallAudioOutput,
  });
  voiceRooms = new VoiceRoomController({
    requestToken: (channelId) => api.voiceRoomToken(channelId),
    checkAccess: async (channelId) => {
      try {
        return (await api.voiceRoomAuthorized(channelId)).authorized;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
        throw error;
      }
    },
    encryptSignal: encryptVoiceRoomSignal,
    decryptSignal: decryptVoiceSignal,
    sendSignal: (conversationId, ciphertext) => sendRealtimeCommand({ type: "voice.signal", conversationId, ciphertext }),
    onState: renderVoiceRoom,
    audioOutput: voiceCallAudioOutput,
  });
  updateVoiceCallButton();
}

async function joinVoiceRoom(channel: ServerChannel) {
  if (channel.kind !== "voice" || !voiceRooms) return;
  voiceRoomPanelStatus.textContent = "Connecting to the voice room…";
  try {
    await voiceRooms.join({
      id: channel.id,
      conversationId: channel.conversationId,
      name: channelDisplayName(channel),
    });
  } catch (error) {
    voiceRoomPanelStatus.textContent = readableError(error);
    setStatus(readableError(error), true);
  }
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

function appendTwemoji(parent: HTMLElement | DocumentFragment, option: TwemojiOption, className = "twemoji") {
  const image = document.createElement("img");
  image.className = className;
  image.src = `/assets/twemoji/${option.code}.svg`;
  image.alt = option.emoji;
  image.draggable = false;
  parent.append(image);
  return image;
}

function renderMessageInput() {
  const value = messageInput.value;
  const fragment = document.createDocumentFragment();
  messageInputRendered.dataset.placeholder = messageInput.placeholder;
  let offset = 0;
  let textStart = 0;
  while (offset < value.length) {
    const emoji = emojiEntryAt(value, offset);
    if (!emoji) {
      const codePoint = value.codePointAt(offset);
      offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
      continue;
    }
    if (textStart < offset) fragment.append(value.slice(textStart, offset));
    appendTwemoji(fragment, emoji.entry, "composer-twemoji");
    offset += emoji.text.length;
    textStart = offset;
  }
  if (textStart < value.length) fragment.append(value.slice(textStart));
  messageInputRendered.replaceChildren(fragment);
  messageInputRendered.scrollTop = messageInput.scrollTop;
  messageInputRendered.scrollLeft = messageInput.scrollLeft;
}

function closeMessageContextMenu() {
  contextMessage?.article.classList.remove("message-actions-open");
  contextMessage?.article.querySelector<HTMLButtonElement>(".message-action-menu")?.setAttribute("aria-expanded", "false");
  messageContextMenu.hidden = true;
  messageContextMenu.replaceChildren();
  contextMessage = undefined;
}

function closeNavigationContextMenu() {
  navigationContextMenu.hidden = true;
  navigationContextMenu.replaceChildren();
}

function placeContextMenu(menu: HTMLElement, x: number, y: number) {
  menu.hidden = false;
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`;
}

function navigationContextAction(label: string, action: () => void | Promise<void>, options: { icon?: string } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-context-action";
  button.setAttribute("role", "menuitem");
  if (options.icon) button.append(iconElement(options.icon, "message-context-icon"));
  const text = document.createElement("span");
  text.className = "message-context-label";
  text.textContent = label;
  button.append(text);
  button.addEventListener("click", () => {
    closeNavigationContextMenu();
    void action();
  });
  navigationContextMenu.append(button);
  return button;
}

function mutedStorageKey() {
  return currentUser ? `priv-chat.muted-rooms.${currentUser.id}` : "priv-chat.muted-rooms";
}

function loadMutedChannels() {
  mutedChannelIds.clear();
  try {
    const value = JSON.parse(localStorage.getItem(mutedStorageKey()) ?? "[]") as unknown;
    if (Array.isArray(value)) {
      for (const channelId of value) if (typeof channelId === "string") mutedChannelIds.add(channelId);
    }
  } catch {
    // Local mute state is optional.
  }
}

function saveMutedChannels() {
  try {
    localStorage.setItem(mutedStorageKey(), JSON.stringify([...mutedChannelIds]));
  } catch {
    // Local storage may be disabled or full.
  }
}

function toggleChannelMuted(channelId: string) {
  if (mutedChannelIds.has(channelId)) mutedChannelIds.delete(channelId);
  else mutedChannelIds.add(channelId);
  saveMutedChannels();
  renderChannels();
  setStatus(mutedChannelIds.has(channelId) ? "Room muted on this browser." : "Room unmuted on this browser.");
}

function copyRoomLink(serverId: string, channelId: string) {
  if (!navigator.clipboard) {
    setStatus("Unable to copy the room link.", true);
    return;
  }
  void navigator.clipboard.writeText(new URL(channelLocation(serverId, channelId), window.location.origin).toString())
    .then(() => setStatus("Room link copied."))
    .catch(() => setStatus("Unable to copy the room link.", true));
}

function openNavigationContextMenu(target: { kind: "channel"; channel: ServerChannel } | { kind: "category"; category: ServerCategory }, x: number, y: number) {
  closeMessageContextMenu();
  navigationContextMenu.replaceChildren();
  if (target.kind === "channel") {
    const { channel } = target;
    navigationContextAction("Open room", () => void selectChannel(channel.id), { icon: "message-square" });
    navigationContextAction("Mark unread from here", () => markConversationUnread(channel.conversationId, loadedMessages.length > 0 ? loadedMessages[loadedMessages.length - 1].serverSequence : "0", { force: true }), { icon: "clock" });
    navigationContextAction(mutedChannelIds.has(channel.id) ? "Unmute room" : "Mute room", () => toggleChannelMuted(channel.id), { icon: mutedChannelIds.has(channel.id) ? "bell" : "bell-off" });
    navigationContextAction("Copy room link", () => copyRoomLink(channel.serverId, channel.id), { icon: "link" });
    if (selectedServerId && (hasActiveServerPermission("manage_channels") || hasActiveServerPermission("edit_channels"))) {
      navigationContextAction("Room settings", () => window.location.assign(`/server-settings?server=${encodeURIComponent(channel.serverId)}#rooms`), { icon: "settings-2" });
    }
  } else {
    const collapsed = collapsedCategories.has(target.category.id);
    navigationContextAction(collapsed ? "Expand category" : "Collapse category", () => {
      if (collapsed) collapsedCategories.delete(target.category.id);
      else collapsedCategories.add(target.category.id);
      renderChannels();
    }, { icon: collapsed ? "chevron-down" : "chevron-right" });
    navigationContextAction("Create room in category", () => void createChannel(target.category.id), { icon: "plus" });
    if (selectedServerId && (hasActiveServerPermission("manage_channels") || hasActiveServerPermission("manage_categories"))) {
      navigationContextAction("Category settings", () => window.location.assign(`/server-settings?server=${encodeURIComponent(target.category.serverId)}#rooms`), { icon: "settings-2" });
    }
  }
  renderIcons(navigationContextMenu);
  placeContextMenu(navigationContextMenu, x, y);
  navigationContextMenu.querySelector<HTMLButtonElement>("button")?.focus();
}

function contextMenuAction(label: string, action: () => void | Promise<void>, options: { danger?: boolean; shortcut?: string; icon?: string } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `message-context-action${options.danger ? " danger" : ""}`;
  button.setAttribute("role", "menuitem");
  if (options.icon) button.append(iconElement(options.icon, "message-context-icon"));
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
    const twemoji = emojiEntryAt(key, 0);
    if (option) appendTwemoji(button, option);
    else if (twemoji?.text === key) appendTwemoji(button, twemoji.entry);
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

function embeddedImageLinks(embeds: SafeEmbed[]) {
  return new Set(embeds.flatMap((embed) => {
    if (embed.kind === "media" && embed.mediaType === "image") return [embed.url];
    if (embed.kind === "gif" && embed.mediaUrl) return [embed.url];
    return [];
  }));
}

function searchableMessageBody(body: string, referenceMs = Date.now()) {
  return `${body} ${formatMessageMacrosAsText(body, referenceMs)}`.toLowerCase();
}

function applyEditedBody(messageId: string, body: string, embeds: SafeEmbed[], mentions: string[], roleMentions: string[] = []) {
  editedMessageBodies.set(messageId, { body, embeds, mentions, roleMentions });
  if (redactedMessageIds.has(messageId)) return;
  const article = findMessageArticle(messageId);
  const message = loadedMessages.find((candidate) => candidate.id === messageId);
  if (!article || !message) return;
  const content = article.querySelector<HTMLElement>(".message-content");
  const header = content?.querySelector<HTMLElement>(".message-meta");
  if (!content || !header) return;
  const reply = article.querySelector<HTMLElement>(".reply-context");
  reply?.remove();
  article.querySelector<HTMLElement>(".message-actions")?.remove();
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
  const mentionRoleNames = new Set(roleMentions
    .map((roleId) => serverRoles.find((role) => role.id === roleId))
    .filter((role): role is CustomServerRole => role !== undefined && role.systemKey !== "owner")
    .map(serverRoleSlug));
  if (body) appendMarkdown(content, body, {
    mentionUsernames: mentionNames,
    mentionRoleNames,
    customEmoji: customEmojiAssets,
    roomReferences: roomReferenceMap(),
    hideBareLinks: embeddedImageLinks(embeds),
    onRoomReference: (channelId) => void selectChannel(channelId),
  });
  for (const embed of embeds) appendSafeEmbed(content, embed, openExternalImageViewer);
  article.classList.toggle("message-emoji-only", isEmojiOnlyMessage(body));
  if (reply) article.insertBefore(reply, article.querySelector(".message-avatar") ?? content);
  const editable = isOwnMessage(message);
  appendMessageActions(article, message, article.querySelector(".message-sender-link")?.textContent ?? "Member", body, editable);
  article.dataset.search = `${article.querySelector(".message-sender-link")?.textContent ?? ""} ${searchableMessageBody(body)}`;
  const contextTarget = messageContextTargets.get(messageId);
  if (contextTarget) {
    contextTarget.body = body;
    contextTarget.editable = editable;
  }
  renderMessageReactions(messageId);
}

function setEditTarget(target: EditTarget) {
  editTarget = target;
  clearComposerAttachments();
  clearReplyTarget();
  editPreviewText.textContent = `Editing ${target.sender}: ${formatMessageMacrosAsText(target.body).replace(/\s+/g, " ").slice(0, 180)}`;
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
  if (!cryptoClient || !selectedConversationId || (selectedServerId && !hasActiveServerPermission("pin_messages"))) return;
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

async function moderateDeleteMessage(message: MessageEnvelope) {
  if (!selectedConversationId || !selectedServerId
    || (!hasActiveServerPermission("delete_messages") && !hasActiveServerPermission("delete_others_messages"))
    || !window.confirm("Permanently delete this encrypted message for everyone?")) return;
  try {
    await api.deleteMessage(selectedConversationId, message.id);
    await refreshMessages({ forceScrollToBottom: false });
    setStatus("Message deleted for everyone.");
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

  contextMenuAction("Reply", () => setReplyTarget(replyReferenceForMessage(target.message, target.sender, target.body || "Encrypted message")), { shortcut: "R", icon: "corner-up-left" });
  if (target.editable) contextMenuAction("Edit message", () => setEditTarget({ messageId: target.message.id, sender: target.sender, body: target.body }), { shortcut: "E", icon: "pencil" });
  if (target.body) contextMenuAction("Copy text", () => copyMessageBody(target.body), { shortcut: "C", icon: "copy" });
  contextMenuAction("Copy message link", async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(messageLink(target.message.id));
      setStatus("Message link copied.");
    } catch {
      setStatus("Unable to copy the message link.", true);
    }
  }, { icon: "link" });
  if (target.message.senderUserId && target.message.senderUserId !== currentUser?.id) {
    contextMenuAction("Report message", () => openReportDialog({
      targetUserId: target.message.senderUserId!,
      conversationId: target.message.conversationId,
      messageId: target.message.id,
      defaultEvidenceText: target.body,
    }), { danger: true, icon: "gavel" });
  }
  contextMenuAction("Mark unread from here", () => markUnreadFromMessage(target.message), { icon: "clock" });
  if (!selectedServerId || hasActiveServerPermission("pin_messages")) {
    contextMenuAction(pinnedMessageIds.has(target.message.id) ? "Unpin message" : "Pin message", () => togglePin(target.message.id), { icon: "pin" });
  }
  if (isOwnMessage(target.message)) {
    const divider = document.createElement("div");
    divider.className = "message-context-divider";
    messageContextMenu.append(divider);
    contextMenuAction("Delete message", () => deleteMessage(target.message), { danger: true, icon: "trash-2" });
  } else if (selectedServerId && (hasActiveServerPermission("delete_messages") || hasActiveServerPermission("delete_others_messages"))) {
    contextMenuAction("Delete for everyone", () => moderateDeleteMessage(target.message), { danger: true, icon: "trash-2" });
  }

  renderIcons(messageContextMenu);
  messageContextMenu.hidden = false;
  const margin = 8;
  const rect = messageContextMenu.getBoundingClientRect();
  messageContextMenu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`;
  messageContextMenu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`;
  const firstAction = messageContextMenu.querySelector<HTMLButtonElement>(".message-context-reaction, .message-context-action");
  firstAction?.focus();
}

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
  mediaViewerRenderToken += 1;
  if (mediaViewerUrl) URL.revokeObjectURL(mediaViewerUrl);
  mediaViewerUrl = undefined;
  mediaViewerElement = undefined;
  mediaViewerText = undefined;
  mediaViewerItems = [];
  mediaViewerIndex = 0;
  mediaViewerCopy.hidden = true;
  mediaViewerPrevious.hidden = true;
  mediaViewerNext.hidden = true;
  mediaViewerCount.hidden = true;
  mediaViewerDownload.hidden = true;
  mediaViewerDownload.removeAttribute("href");
  mediaViewerStage.replaceChildren();
  mediaViewerZoom.value = "1";
  mediaZoomReset.textContent = "100%";
  hideDialog(mediaViewer);
}

function openExternalImageViewer(url: string, title: string) {
  closeMediaViewer();
  mediaViewerTitle.textContent = title || "Image";
  mediaViewerCopy.hidden = true;
  mediaViewerPrevious.hidden = true;
  mediaViewerNext.hidden = true;
  mediaViewerCount.hidden = true;
  mediaViewerDownload.hidden = true;
  mediaViewerDownload.removeAttribute("href");
  const image = document.createElement("img");
  image.className = "media-viewer-image";
  image.src = url;
  image.alt = title || "Linked image";
  image.referrerPolicy = "no-referrer";
  mediaViewerElement = image;
  mediaViewerStage.append(image);
  showDialog(mediaViewer, mediaViewerClose);
  setMediaZoom(1);
}

function setMediaZoom(value: number) {
  const zoom = Math.max(1, Math.min(3, Math.round(value * 10) / 10));
  mediaViewerZoom.value = String(zoom);
  mediaZoomReset.textContent = `${Math.round(zoom * 100)}%`;
  if (mediaViewerElement) mediaViewerElement.style.transform = `scale(${zoom})`;
}

function clearMediaViewerMedia() {
  if (mediaViewerUrl) URL.revokeObjectURL(mediaViewerUrl);
  mediaViewerUrl = undefined;
  mediaViewerElement = undefined;
  mediaViewerDownload.hidden = true;
  mediaViewerDownload.removeAttribute("href");
  mediaViewerStage.replaceChildren();
}

async function renderMediaViewerItem(index: number) {
  if (mediaViewerItems.length === 0) return;
  const item = mediaViewerItems[(index + mediaViewerItems.length) % mediaViewerItems.length];
  mediaViewerIndex = (index + mediaViewerItems.length) % mediaViewerItems.length;
  const token = ++mediaViewerRenderToken;
  clearMediaViewerMedia();
  mediaViewerCopy.hidden = true;
  mediaViewerTitle.textContent = item.filename || (item.video ? "Video" : "Image");
  mediaViewerCount.hidden = mediaViewerItems.length < 2;
  mediaViewerCount.textContent = `${mediaViewerIndex + 1} / ${mediaViewerItems.length}`;
  mediaViewerPrevious.hidden = mediaViewerItems.length < 2;
  mediaViewerNext.hidden = mediaViewerItems.length < 2;
  setMediaZoom(1);

  if (!item.isRevealed()) {
    const spoiler = document.createElement("div");
    spoiler.className = "media-viewer-spoiler";
    const label = document.createElement("strong");
    label.textContent = "Spoiler media";
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "secondary";
    reveal.textContent = "Reveal";
    reveal.addEventListener("click", () => {
      item.reveal();
      void renderMediaViewerItem(mediaViewerIndex);
    });
    spoiler.append(label, reveal);
    mediaViewerStage.append(spoiler);
    return;
  }

  let blob = item.blob;
  if (!blob) {
    const loading = document.createElement("span");
    loading.className = "media-viewer-loading";
    loading.textContent = "Loading media…";
    mediaViewerStage.append(loading);
    blob = await item.load();
    if (token !== mediaViewerRenderToken || mediaViewer.hidden) return;
    if (!blob) {
      loading.textContent = "Media unavailable";
      return;
    }
    item.blob = blob;
  }
  if (token !== mediaViewerRenderToken || mediaViewer.hidden) return;

  mediaViewerUrl = URL.createObjectURL(blob);
  const element = document.createElement(item.video ? "video" : "img");
  element.className = item.video ? "media-viewer-video" : "media-viewer-image";
  element.src = mediaViewerUrl;
  if (item.video) {
    const player = element as HTMLVideoElement;
    player.controls = true;
    player.playsInline = true;
    player.preload = "metadata";
  } else {
    (element as HTMLImageElement).alt = item.filename || "Encrypted media";
  }
  mediaViewerElement = element;
  mediaViewerDownload.href = mediaViewerUrl;
  mediaViewerDownload.download = item.filename || "encrypted-media";
  mediaViewerDownload.hidden = false;
  mediaViewerStage.append(element);
  setMediaZoom(1);
}

function openMediaViewer(blob: Blob, filename: string, video: boolean, items: MediaViewerItem[] = []) {
  closeMediaViewer();
  const fallback: MediaViewerItem = {
    filename,
    video,
    spoiler: false,
    isRevealed: () => true,
    reveal: () => undefined,
    load: async () => blob,
    blob,
  };
  mediaViewerItems = items.length > 0 ? items : [fallback];
  const initialIndex = mediaViewerItems.findIndex((item) => item.blob === blob);
  showDialog(mediaViewer, mediaViewerClose);
  void renderMediaViewerItem(initialIndex >= 0 ? initialIndex : 0);
}

async function openTextViewer(blob: Blob, filename: string, mimeType: string) {
  try {
    const preview = await readTextPreview(blob);
    if (mediaViewer.hidden === false) closeMediaViewer();
    const language = textLanguage(filename, mimeType);
    mediaViewerText = preview.text;
    mediaViewerTitle.textContent = `${filename || "Text file"} · ${language}`;
    const pre = document.createElement("pre");
    pre.className = "text-file-viewer";
    renderHighlightedCode(pre, preview.text, language);
    mediaViewerElement = pre;
    mediaViewerCopy.hidden = false;
    mediaViewerStage.replaceChildren(pre);
    showDialog(mediaViewer, mediaViewerClose);
    setMediaZoom(1);
  } catch (error) {
    setStatus(`Text preview unavailable: ${readableError(error)}`, true);
  }
}

function mediaViewerItemsForCard(card: HTMLElement) {
  const album = card.closest<HTMLElement>(".media-album");
  const cards = album
    ? [...album.querySelectorAll<HTMLElement>(".encrypted-media-card")]
    : [card];
  return cards
    .map((candidate) => mediaCardControllers.get(candidate))
    .filter((controller): controller is MediaViewerItem => Boolean(controller));
}

async function openMediaViewerForCard(card: HTMLElement) {
  const controller = mediaCardControllers.get(card);
  if (!controller || !controller.isRevealed()) return;
  const blob = controller.blob ?? await controller.load();
  if (!blob) return;
  openMediaViewer(blob, controller.filename, controller.video, mediaViewerItemsForCard(card));
}

function closeProfileModal() {
  profileRequest += 1;
  hideDialog(profileModal);
}

type ReportDialogTarget = {
  targetUserId: string;
  conversationId?: string;
  messageId?: string;
  defaultEvidenceText?: string;
};

function openReportDialog(target: ReportDialogTarget) {
  const dialog = document.createElement("dialog");
  dialog.className = "app-dialog report-dialog";
  dialog.setAttribute("aria-labelledby", "report-dialog-title");
  const title = document.createElement("h2");
  title.id = "report-dialog-title";
  title.textContent = target.messageId ? "Report message" : "Report user";
  const explanation = document.createElement("p");
  explanation.className = "muted";
  explanation.textContent = "Reports are reviewed by the host operator. Message content is never included unless you choose to share an encrypted copy.";

  const reasonLabel = document.createElement("label");
  reasonLabel.textContent = "Reason";
  const reason = document.createElement("select");
  for (const [value, label] of [
    ["spam", "Spam or scams"],
    ["harassment", "Harassment or bullying"],
    ["threats", "Threats or violence"],
    ["sexual_content", "Sexual content"],
    ["illegal_content", "Illegal content"],
    ["impersonation", "Impersonation"],
    ["other", "Other concern"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    reason.append(option);
  }
  reasonLabel.append(reason);

  const evidenceLabel = document.createElement("label");
  evidenceLabel.textContent = target.messageId ? "Evidence text (optional)" : "Details for the host (optional)";
  const evidenceText = document.createElement("textarea");
  evidenceText.rows = 5;
  evidenceText.maxLength = 20_000;
  evidenceText.value = target.defaultEvidenceText ?? "";
  evidenceText.placeholder = "Add only details you want the instance operator to see.";
  evidenceLabel.append(evidenceText);

  const shareRow = document.createElement("label");
  shareRow.className = "checkbox-label report-evidence-choice";
  const shareEvidence = document.createElement("input");
  shareEvidence.type = "checkbox";
  shareEvidence.checked = false;
  shareEvidence.disabled = true;
  const shareText = document.createElement("span");
  shareText.textContent = "Share this evidence encrypted to the host operator";
  shareRow.append(shareEvidence, shareText);

  const keyInfo = document.createElement("p");
  keyInfo.className = "muted small";
  keyInfo.textContent = "Checking whether this installation has an evidence encryption key…";
  const status = document.createElement("p");
  status.className = "form-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const actions = document.createElement("div");
  actions.className = "app-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "Cancel";
  const submit = document.createElement("button");
  submit.type = "button";
  submit.textContent = "Submit report";
  actions.append(cancel, submit);
  dialog.append(title, explanation, reasonLabel, evidenceLabel, shareRow, keyInfo, status, actions);
  document.body.append(dialog);

  let reportKey: { keyId: string; publicKey: string } | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    dialog.close();
    dialog.remove();
  };
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  shareEvidence.addEventListener("change", () => {
    evidenceText.disabled = !reportKey || !shareEvidence.checked;
  });
  evidenceText.disabled = true;

  void api.reportPublicKey().then((result) => {
    if (closed) return;
    if (result.configured) {
      reportKey = { keyId: result.keyId, publicKey: result.publicKey };
      keyInfo.textContent = "If selected, this reporter-submitted evidence is encrypted in your browser. Only an instance operator holding the matching private key can decrypt it; its accuracy is not independently verified.";
      shareEvidence.disabled = false;
      evidenceText.disabled = !shareEvidence.checked;
    } else {
      keyInfo.textContent = "The host has not configured an evidence key. You can still submit this report without sharing text.";
      shareEvidence.disabled = true;
      evidenceText.disabled = true;
    }
  }).catch(() => {
    if (closed) return;
    keyInfo.textContent = "Unable to load the host evidence key. Submit without sharing text or try again later.";
    shareEvidence.disabled = true;
  });

  submit.addEventListener("click", async () => {
    submit.disabled = true;
    cancel.disabled = true;
    status.textContent = "Submitting report…";
    try {
      let encryptedEvidence: { keyId: string; ciphertext: string; wrappedKey: string; iv: string } | undefined;
      if (shareEvidence.checked) {
        if (!reportKey) throw new Error("Report evidence encryption is not configured.");
        encryptedEvidence = await encryptReportEvidence(reportKey.publicKey, reportKey.keyId, {
          source: "reporter-submitted-text",
          text: evidenceText.value,
        });
      }
      await api.reportUser({
        targetUserId: target.targetUserId,
        reason: reason.value as import("./api").UserReportReason,
        ...(target.conversationId ? { conversationId: target.conversationId } : {}),
        ...(target.messageId ? { messageId: target.messageId } : {}),
        ...(encryptedEvidence ? { encryptedEvidence } : {}),
      });
      close();
      setStatus("Report submitted to the host operator.");
    } catch (error) {
      status.textContent = error instanceof ApiError && error.code === "report_already_submitted"
        ? "You already have an open report for this message."
        : error instanceof ApiError && error.code === "report_rate_limited"
          ? "You’ve submitted several reports recently. Please try again later."
          : error instanceof Error ? error.message : "Unable to submit this report.";
      submit.disabled = false;
      cancel.disabled = false;
    }
  });

  dialog.showModal();
  reason.focus();
}

function updateProfileSafetyButtons() {
  const visible = Boolean(profileModalUserId && profileModalUserId !== currentUser?.id);
  profileModalSafetyActions.hidden = !visible;
  profileModalBlock.textContent = profileModalUserBlocked ? "Unblock user" : "Block user";
}

async function openUserProfile(userId: string) {
  const request = ++profileRequest;
  profileModalUserId = userId;
  profileModalUserBlocked = false;
  updateProfileSafetyButtons();
  profileModalName.textContent = "Loading profile…";
  profileModalUsername.textContent = "";
  profileModalCreated.textContent = "";
  profileModalCreated.dateTime = "";
  profileModalBanner.replaceChildren();
  profileModalBanner.dataset.empty = "true";
  renderAvatar(profileModalAvatar, "?", userId, null);
  profileModalEdit.hidden = true;
  showDialog(profileModal, profileModalClose);
  try {
    const result = await api.user(userId);
    if (request !== profileRequest || profileModal.hidden) return;
    const user = result.user;
    profileModalUserBlocked = result.blockedByMe;
    updateProfileSafetyButtons();
    profileModalBanner.replaceChildren();
    if (user.bannerUrl) {
      const banner = document.createElement("img");
      banner.src = user.bannerUrl;
      banner.alt = "";
      profileModalBanner.append(banner);
      delete profileModalBanner.dataset.empty;
    } else {
      profileModalBanner.dataset.empty = "true";
    }
    renderAvatar(profileModalAvatar, user.displayName, user.id, user.avatarUrl, user.displayName);
    profileModalName.textContent = user.displayName;
    profileModalUsername.textContent = `@${user.username}`;
    const createdAt = new Date(user.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      profileModalCreated.textContent = "Date unavailable";
      profileModalCreated.dateTime = "";
    } else {
      profileModalCreated.dateTime = createdAt.toISOString();
      profileModalCreated.textContent = createdAt.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    }
    profileModalEdit.hidden = user.id !== currentUser?.id;
  } catch (error) {
    if (request !== profileRequest || profileModal.hidden) return;
    profileModalName.textContent = "Profile unavailable";
    profileModalUsername.textContent = readableError(error);
  }
}

profileModalReport.addEventListener("click", () => {
  if (profileModalUserId && profileModalUserId !== currentUser?.id) {
    openReportDialog({ targetUserId: profileModalUserId });
  }
});

profileModalBlock.addEventListener("click", async () => {
  const userId = profileModalUserId;
  if (!userId || userId === currentUser?.id) return;
  const wasBlocked = profileModalUserBlocked;
  if (!wasBlocked && !window.confirm("Block this user from direct conversations? Shared-space access and messages will not change.")) return;
  profileModalBlock.disabled = true;
  try {
    if (wasBlocked) await api.unblockUser(userId);
    else await api.blockUser(userId);
    profileModalUserBlocked = !wasBlocked;
    updateProfileSafetyButtons();
    if (!wasBlocked && !selectedServerId && selectedMembers.some((member) => member.userId === userId)) {
      window.location.assign("/app");
      return;
    }
    setStatus(wasBlocked ? "User unblocked." : "User blocked from direct conversations.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to update this block.", true);
  } finally {
    profileModalBlock.disabled = false;
  }
});

mediaViewerZoom.addEventListener("input", () => {
  setMediaZoom(Number(mediaViewerZoom.value));
});
mediaZoomOut.addEventListener("click", () => setMediaZoom(Number(mediaViewerZoom.value) - 0.1));
mediaZoomIn.addEventListener("click", () => setMediaZoom(Number(mediaViewerZoom.value) + 0.1));
mediaZoomReset.addEventListener("click", () => setMediaZoom(1));
mediaViewerPrevious.addEventListener("click", () => void renderMediaViewerItem(mediaViewerIndex - 1));
mediaViewerNext.addEventListener("click", () => void renderMediaViewerItem(mediaViewerIndex + 1));
mediaViewerCopy.addEventListener("click", async () => {
  if (mediaViewerText === undefined) return;
  try {
    await navigator.clipboard.writeText(mediaViewerText);
    setStatus("Text copied to the clipboard.");
  } catch {
    setStatus("Clipboard access is unavailable.", true);
  }
});
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
  const preview = formatMessageMacrosAsText(target.body).replace(/\s+/g, " ").trim() || "Encrypted message";
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

function mentionedRoleIds(body: string) {
  if (!selectedServerId || !hasActiveServerPermission("mention_roles")) return [];
  const ids = new Set<string>();
  for (const match of body.matchAll(/(^|[^A-Za-z0-9_.-])@&([A-Za-z0-9_.-]+)/g)) {
    const slug = match[2].toLowerCase();
    const role = serverRoles.find((candidate) => candidate.mentionable && candidate.systemKey !== "owner" && serverRoleSlug(candidate) === slug);
    if (role) ids.add(role.id);
  }
  return [...ids];
}

function messageMentionsCurrentUser(mentions: readonly string[], roleMentions: readonly string[]) {
  if (!currentUser) return false;
  const currentRoleIds = normalizeRoleIds(selectedMembers.find((member) => member.userId === currentUser?.id)?.roleIds);
  return mentions.includes(currentUser.id)
    || roleMentions.some((roleId) => currentRoleIds.includes(roleId)
      && serverRoles.find((role) => role.id === roleId)?.systemKey !== "owner");
}

function blockedSpecialMentions(body: string) {
  if (!selectedServerId) return undefined;
  if (!hasActiveServerPermission("mention_everyone") && /(^|\s)@everyone\b/i.test(body)) return "@everyone";
  if (!hasActiveServerPermission("mention_here") && /(^|\s)@here\b/i.test(body)) return "@here";
  return undefined;
}

function mentionToken() {
  const cursor = messageInput.selectionStart ?? messageInput.value.length;
  const before = messageInput.value.slice(0, cursor);
  const roomMatch = roomReferenceToken(messageInput.value, cursor);
  if (roomMatch) {
    return {
      kind: "room" as const,
      query: roomMatch.query,
      start: roomMatch.start,
      end: roomMatch.end,
    };
  }
  const roleMatch = before.match(/(^|\s)@&([A-Za-z0-9_.-]*)$/);
  if (roleMatch) {
    return {
      kind: "role" as const,
      query: roleMatch[2].toLowerCase(),
      start: before.length - roleMatch[0].length + roleMatch[1].length,
      end: cursor,
    };
  }
  const match = before.match(/(^|\s)@([A-Za-z0-9_.-]*)$/);
  if (!match) return null;
  return {
    kind: "user" as const,
    query: match[2].toLowerCase(),
    start: before.length - match[0].length + match[1].length,
    end: cursor,
  };
}

function hideMentionSuggestions() {
  mentionSuggestions.hidden = true;
  mentionSuggestions.replaceChildren();
  activeSuggestionIndex = -1;
}

function hideEmojiSuggestions() {
  emojiSuggestions.hidden = true;
  emojiSuggestions.replaceChildren();
  activeSuggestionIndex = -1;
}

function hideMacroSuggestions() {
  macroSuggestions.hidden = true;
  macroSuggestions.replaceChildren();
  activeSuggestionIndex = -1;
}

function activeSuggestionContainer() {
  if (!mentionSuggestions.hidden) return mentionSuggestions;
  if (!emojiSuggestions.hidden) return emojiSuggestions;
  if (!macroSuggestions.hidden) return macroSuggestions;
  return undefined;
}

function setActiveSuggestion(index: number) {
  const container = activeSuggestionContainer();
  if (!container) return;
  const options = [...container.querySelectorAll<HTMLButtonElement>("button")];
  if (options.length === 0) return;
  activeSuggestionIndex = (index + options.length) % options.length;
  for (const [optionIndex, option] of options.entries()) {
    const active = optionIndex === activeSuggestionIndex;
    option.classList.toggle("suggestion-active", active);
    option.setAttribute("aria-selected", String(active));
  }
  options[activeSuggestionIndex]?.scrollIntoView({ block: "nearest" });
}

function handleSuggestionKeydown(event: KeyboardEvent) {
  const container = activeSuggestionContainer();
  if (!container) return false;
  const options = [...container.querySelectorAll<HTMLButtonElement>("button")];
  if (options.length === 0) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    setActiveSuggestion(activeSuggestionIndex + (event.key === "ArrowDown" ? 1 : -1));
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    options[activeSuggestionIndex < 0 ? 0 : activeSuggestionIndex]?.click();
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    if (!mentionSuggestions.hidden) hideMentionSuggestions();
    if (!emojiSuggestions.hidden) hideEmojiSuggestions();
    if (!macroSuggestions.hidden) hideMacroSuggestions();
    return true;
  }
  return false;
}

function closeEmojiPicker() {
  emojiPicker.hidden = true;
  emojiToggle.setAttribute("aria-expanded", "false");
  emojiPickerSearch.value = "";
  emojiPickerCategory = emojiPickerCategories[0].id;
  emojiPickerGrid.scrollTop = 0;
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
  renderInputSuggestions();
  messageInput.focus();
}

function emojiCategorySlug(category: EmojiPickerCategory) {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderEmojiCategoryTabs() {
  emojiCategoryTabs.replaceChildren();
  for (const category of emojiPickerCategories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji-category-tab";
    button.id = `emoji-category-tab-${emojiCategorySlug(category.id)}`;
    button.dataset.emojiCategory = category.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(emojiPickerCategory === category.id));
    button.setAttribute("aria-label", category.label);
    button.title = category.label;
    const icon = document.createElement("span");
    icon.className = "emoji-category-icon";
    icon.setAttribute("aria-hidden", "true");
    const iconEntry = emojiEntryAt(category.icon, 0);
    if (iconEntry) appendTwemoji(icon, iconEntry.entry, "emoji-category-twemoji");
    else icon.textContent = category.icon;
    button.append(icon);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      emojiPickerCategory = category.id;
      const hadSearch = Boolean(emojiPickerSearch.value.trim());
      emojiPickerSearch.value = "";
      if (hadSearch) {
        emojiPickerGrid.scrollTop = 0;
        renderEmojiPickerGrid();
      }
      updateEmojiCategoryTabState();
      const sections = [...emojiPickerGrid.querySelectorAll<HTMLElement>("[data-emoji-category]")];
      const target = sections.find((section) => section.dataset.emojiCategory === category.id);
      if (target) renderEmojiSectionItems(target);
      scrollToEmojiCategory(category.id);
      emojiPickerSearch.focus();
    });
    emojiCategoryTabs.append(button);
  }
}

function updateEmojiCategoryTabState() {
  for (const button of emojiCategoryTabs.querySelectorAll<HTMLButtonElement>(".emoji-category-tab")) {
    button.setAttribute("aria-selected", String(button.dataset.emojiCategory === emojiPickerCategory));
  }
}

function renderEmojiPickerGrid() {
  const query = emojiPickerSearch.value.trim().toLowerCase();
  emojiPickerObserver?.disconnect();
  emojiPickerObserver = undefined;
  emojiPickerGrid.replaceChildren();
  const lazySections: HTMLElement[] = [];
  let sectionCount = renderCustomEmojiPickerSection(query) ? 1 : 0;
  for (const category of emojiPickerCategories) {
    const candidates = emojiOptions.filter((option) => option.category === category.id
      && (!query || [option.name, ...option.aliases].some((name) => name.includes(query))));
    if (candidates.length === 0) continue;
    sectionCount += 1;
    const section = document.createElement("section");
    section.className = "emoji-category-section";
    section.dataset.emojiCategory = category.id;
    const heading = document.createElement("h3");
    heading.className = "emoji-category-heading";
    heading.textContent = category.label;
    const items = document.createElement("div");
    items.className = "emoji-category-items";
    section.append(heading, items);
    lazyEmojiOptions.set(section, candidates);
    if (query || sectionCount === 1) {
      renderEmojiSectionItems(section);
    } else {
      items.style.minHeight = `${Math.ceil(candidates.length / 8) * 30}px`;
      lazySections.push(section);
    }
    emojiPickerGrid.append(section);
    // The section's placeholder height keeps jump offsets stable until its
    // buttons are needed. IntersectionObserver renders it near the viewport.
  }
  if (!query && lazySections.length > 0) {
    emojiPickerObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const section = entry.target as HTMLElement;
        renderEmojiSectionItems(section);
        emojiPickerObserver?.unobserve(section);
      }
    }, { root: emojiPickerGrid, rootMargin: "40px 0px" });
    for (const section of lazySections) emojiPickerObserver.observe(section);
  }
  if (sectionCount === 0) {
    const empty = document.createElement("p");
    empty.className = "emoji-picker-empty";
    empty.textContent = "No emojis found.";
    emojiPickerGrid.append(empty);
  }
}

function scrollToEmojiCategory(category: EmojiPickerCategory) {
  const section = [...emojiPickerGrid.querySelectorAll<HTMLElement>("[data-emoji-category]")]
    .find((candidate) => candidate.dataset.emojiCategory === category);
  if (section) emojiPickerGrid.scrollTo({ top: Math.max(0, section.offsetTop - 4), behavior: "auto" });
}

function updateActiveEmojiCategory() {
  const gridTop = emojiPickerGrid.getBoundingClientRect().top + 12;
  const sections = [...emojiPickerGrid.querySelectorAll<HTMLElement>("[data-emoji-category]")];
  let active = sections[0]?.dataset.emojiCategory as EmojiCategory | undefined ?? emojiPickerCategories[0].id;
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= gridTop) active = section.dataset.emojiCategory as EmojiCategory;
    else break;
  }
  if (active !== emojiPickerCategory) {
    emojiPickerCategory = active;
    updateEmojiCategoryTabState();
  }
}

function renderEmojiPicker() {
  renderEmojiCategoryTabs();
  renderEmojiPickerGrid();
  updateActiveEmojiCategory();
}

function toggleEmojiPicker() {
  if (emojiPicker.hidden) {
    closeGifPicker();
    renderEmojiPicker();
    emojiPicker.hidden = false;
    emojiToggle.setAttribute("aria-expanded", "true");
    emojiPickerSearch.focus();
  } else {
    closeEmojiPicker();
  }
}

function activeGifProvider() {
  return gifProviderConfiguration?.providers.find((provider) => provider.id === gifPickerProviderId);
}

function gifPickerHelpText(provider: GifProvider) {
  return `Searches go directly to ${gifProviderLabel(provider.id)}. Selected GIFs are encrypted before upload.`;
}

function setGifPickerNotice(message: string) {
  gifPickerNotice.textContent = message;
}

function renderGifPickerEmpty(message: string) {
  gifPickerResults.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "gif-picker-empty";
  empty.textContent = message;
  gifPickerResults.append(empty);
}

function renderGifPickerAttribution(provider?: GifProvider) {
  gifPickerAttribution.hidden = !provider;
  if (!provider) return;
  gifPickerAttribution.href = provider.id === "klipy" ? "https://klipy.com" : "https://giphy.com";
  gifPickerAttribution.textContent = provider.id === "klipy" ? "Powered by KLIPY" : "GIFs by GIPHY";
}

function renderGifPickerProviders() {
  gifPickerProvider.replaceChildren();
  const providers = gifProviderConfiguration?.providers ?? [];
  if (providers.length === 0) {
    gifPickerProvider.hidden = true;
    gifPickerProvider.disabled = true;
    gifPickerSearch.disabled = true;
    renderGifPickerAttribution();
    return;
  }
  gifPickerProvider.hidden = false;
  gifPickerProvider.disabled = false;
  gifPickerSearch.disabled = false;
  if (!gifPickerProviderId || !providers.some((provider) => provider.id === gifPickerProviderId)) {
    gifPickerProviderId = providers[0]?.id;
  }
  for (const provider of providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = gifProviderLabel(provider.id);
    gifPickerProvider.append(option);
  }
  if (gifPickerProviderId) gifPickerProvider.value = gifPickerProviderId;
  renderGifPickerAttribution(activeGifProvider());
}

function closeGifPicker() {
  gifPickerToken += 1;
  if (gifPickerSearchTimer !== undefined) {
    window.clearTimeout(gifPickerSearchTimer);
    gifPickerSearchTimer = undefined;
  }
  gifPickerSearchAbort?.abort();
  gifPickerSearchAbort = undefined;
  gifPickerDownloadAbort?.abort();
  gifPickerDownloadAbort = undefined;
  gifPickerDownloadInProgress = false;
  gifPicker.hidden = true;
  gifToggle.setAttribute("aria-expanded", "false");
  gifPickerSearch.value = "";
  setGifPickerNotice("");
  gifPickerResults.replaceChildren();
}

function gifDownloadError(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return "GIF download canceled.";
  if (error instanceof Error && error.message === "gif_download_too_large") return "That GIF is too large to send as an encrypted attachment.";
  if (error instanceof Error && error.message === "gif_download_not_gif") return "The provider did not return a GIF file.";
  return "Unable to download that GIF from the provider.";
}

async function readBoundedGifBlob(response: Response, maxBytes: number) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (contentType && contentType !== "image/gif") throw new Error("gif_download_not_gif");
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) throw new Error("gif_download_too_large");
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > maxBytes) throw new Error("gif_download_too_large");
    return blob;
  }
  const chunks: ArrayBuffer[] = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("gif_download_too_large");
      }
      const copy = new Uint8Array(chunk.value.byteLength);
      copy.set(chunk.value);
      chunks.push(copy.buffer);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("gif_download_too_large");
  return new Blob(chunks, { type: "image/gif" });
}

async function isGifBlob(blob: Blob) {
  const header = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
  const signature = String.fromCharCode(...header);
  return signature === "GIF87a" || signature === "GIF89a";
}

async function queueGifAttachment(result: GifSearchResult) {
  if (gifPickerDownloadInProgress) return;
  const configuration = gifProviderConfiguration;
  if (!configuration) return;
  if (result.sizeBytes && result.sizeBytes > configuration.maxAttachmentBytes) {
    setGifPickerNotice("That GIF is too large to send as an encrypted attachment.");
    return;
  }
  gifPickerDownloadInProgress = true;
  gifPickerSearchAbort?.abort();
  for (const button of gifPickerResults.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
  setGifPickerNotice("Downloading GIF for encrypted upload…");
  const pickerToken = gifPickerToken;
  const controller = new AbortController();
  gifPickerDownloadAbort = controller;
  try {
    const response = await fetch(result.mediaUrl, {
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("gif_download_failed");
    const blob = await readBoundedGifBlob(response, configuration.maxAttachmentBytes);
    if (!await isGifBlob(blob)) throw new Error("gif_download_not_gif");
    const filenameId = result.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "animation";
    const added = addComposerFiles([new File([blob], `${result.provider}-${filenameId}.gif`, { type: "image/gif" })]);
    if (added === 0) {
      setGifPickerNotice("The attachment queue is full.");
      return;
    }
    closeGifPicker();
    setStatus("GIF added as an encrypted attachment.");
    messageInput.focus();
  } catch (error) {
    if (pickerToken === gifPickerToken && !gifPicker.hidden && !(error instanceof Error && error.name === "AbortError")) {
      setGifPickerNotice(gifDownloadError(error));
    }
  } finally {
    if (gifPickerDownloadAbort === controller) {
      gifPickerDownloadAbort = undefined;
      gifPickerDownloadInProgress = false;
      if (!gifPicker.hidden) {
        for (const button of gifPickerResults.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false;
      }
    }
  }
}

function renderGifSearchResults(results: GifSearchResult[]) {
  gifPickerResults.replaceChildren();
  const maxAttachmentBytes = gifProviderConfiguration?.maxAttachmentBytes ?? 0;
  const sendable = results.filter((result) => !result.sizeBytes || result.sizeBytes <= maxAttachmentBytes);
  if (sendable.length === 0) {
    renderGifPickerEmpty(results.length > 0 ? "The available GIFs are too large to send." : "No GIFs found.");
    return;
  }
  for (const result of sendable) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gif-picker-result";
    button.setAttribute("role", "option");
    button.setAttribute("aria-label", `Add ${result.title} as an encrypted GIF attachment`);
    button.title = `Add ${result.title}`;
    const image = document.createElement("img");
    image.src = result.previewUrl;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => button.remove(), { once: true });
    const label = document.createElement("span");
    label.className = "gif-picker-result-label";
    label.textContent = result.title;
    button.append(image, label);
    button.addEventListener("click", () => void queueGifAttachment(result));
    gifPickerResults.append(button);
  }
}

async function searchGifPicker() {
  const provider = activeGifProvider();
  const query = gifPickerSearch.value.trim();
  gifPickerSearchAbort?.abort();
  gifPickerSearchAbort = undefined;
  const token = ++gifPickerToken;
  if (!provider) {
    renderGifPickerEmpty("No GIF provider is configured.");
    return;
  }
  if (query.length === 1) {
    renderGifPickerEmpty("Type at least two characters to search.");
    setGifPickerNotice(gifPickerHelpText(provider));
    return;
  }
  const controller = new AbortController();
  gifPickerSearchAbort = controller;
  renderGifPickerEmpty(query ? "Searching…" : "Loading trending GIFs…");
  setGifPickerNotice(query ? `Searching ${gifProviderLabel(provider.id)}…` : `Loading trending GIFs from ${gifProviderLabel(provider.id)}…`);
  try {
    const results = query
      ? await searchGifs(provider, query, controller.signal, gifProviderConfiguration?.maxAttachmentBytes)
      : await trendingGifs(provider, controller.signal, gifProviderConfiguration?.maxAttachmentBytes);
    if (token !== gifPickerToken || gifPicker.hidden) return;
    renderGifSearchResults(results);
    setGifPickerNotice(results.length > 0
      ? gifPickerHelpText(provider)
      : query ? "No GIFs found. Try a different search." : "No trending GIFs are available right now.");
  } catch (error) {
    if (token !== gifPickerToken || gifPicker.hidden || error instanceof Error && error.name === "AbortError") return;
    renderGifPickerEmpty(query ? "GIF search is unavailable." : "Trending GIFs are unavailable.");
    setGifPickerNotice(query
      ? `Unable to search ${gifProviderLabel(provider.id)} right now.`
      : `Unable to load trending GIFs from ${gifProviderLabel(provider.id)} right now.`);
  } finally {
    if (gifPickerSearchAbort === controller) gifPickerSearchAbort = undefined;
  }
}

function scheduleGifSearch() {
  if (gifPickerSearchTimer !== undefined) window.clearTimeout(gifPickerSearchTimer);
  gifPickerSearchTimer = window.setTimeout(() => {
    gifPickerSearchTimer = undefined;
    void searchGifPicker();
  }, 220);
}

async function openGifPicker() {
  closeEmojiPicker();
  gifPicker.hidden = false;
  gifToggle.setAttribute("aria-expanded", "true");
  renderGifPickerEmpty("Loading GIF providers…");
  setGifPickerNotice("Loading GIF providers…");
  const token = ++gifPickerToken;
  try {
    gifProviderConfiguration ??= await loadGifProviderConfiguration();
    if (token !== gifPickerToken || gifPicker.hidden) return;
    renderGifPickerProviders();
    const provider = activeGifProvider();
    if (!provider) {
      renderGifPickerEmpty("No GIF provider is configured. Ask your server operator to enable Klipy or GIPHY.");
      setGifPickerNotice("GIF provider searches stay in your browser and are never sent through Naigi.");
      return;
    }
    setGifPickerNotice(gifPickerHelpText(provider));
    gifPickerSearch.focus();
    void searchGifPicker();
  } catch {
    if (token !== gifPickerToken || gifPicker.hidden) return;
    renderGifPickerEmpty("GIF providers are unavailable.");
    setGifPickerNotice("Unable to load GIF provider settings.");
  }
}

function toggleGifPicker() {
  if (gifPicker.hidden) void openGifPicker();
  else closeGifPicker();
}

function renderMentionSuggestions() {
  const token = mentionToken();
  if (!token) {
    hideMentionSuggestions();
    return;
  }
  const candidates = token.kind === "room"
    ? channels
      .filter((channel) => channel.canView !== false)
      .filter((channel) => !token.query || roomMentionSlug(channel).startsWith(token.query))
      .filter((channel, index, visible) => visible.findIndex((candidate) => roomMentionSlug(candidate) === roomMentionSlug(channel)) === index)
      .slice(0, 8)
    : token.kind === "role"
      ? (selectedServerId && hasActiveServerPermission("mention_roles") ? serverRoles : [])
        .filter((role) => role.mentionable && role.systemKey !== "owner")
        .filter((role) => !token.query || serverRoleSlug(role).startsWith(token.query))
        .slice(0, 8)
      : selectedMembers
        .filter((member) => !token.query || member.username.toLowerCase().startsWith(token.query))
        .slice(0, 8);
  activeSuggestionIndex = -1;
  mentionSuggestions.replaceChildren();
  if (candidates.length === 0) {
    hideMentionSuggestions();
    return;
  }
  mentionSuggestions.setAttribute("aria-label", token.kind === "room" ? "Room suggestions" : "Mention suggestions");
  for (const candidate of candidates) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "mention-suggestion";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.textContent = token.kind === "room"
      ? `#${roomMentionSlug(candidate as ServerChannel)} · ${channelDisplayName(candidate as ServerChannel)}`
      : token.kind === "role"
        ? `@&${serverRoleSlug(candidate as CustomServerRole)} · ${serverRoleName(candidate as CustomServerRole)}`
        : `@${(candidate as ConversationMember).username} · ${(candidate as ConversationMember).displayName || (candidate as ConversationMember).username}`;
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => {
      const replacement = token.kind === "room"
        ? `#${roomMentionSlug(candidate as ServerChannel)} `
        : token.kind === "role"
          ? `@&${serverRoleSlug(candidate as CustomServerRole)} `
          : `@${(candidate as ConversationMember).username} `;
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

function renderEmojiSuggestions() {
  const token = emojiShortcodeToken(messageInput.value, messageInput.selectionStart ?? messageInput.value.length);
  if (!token) {
    hideEmojiSuggestions();
    return;
  }
  const customCandidates = customEmojiPickerEntries(token.query).slice(0, 8);
  const candidates = emojiShortcodeMatches(token.query)
    .filter((candidate) => !customEmojiAssets.has(candidate.name.toLowerCase()))
    .slice(0, Math.max(0, 8 - customCandidates.length));
  activeSuggestionIndex = -1;
  emojiSuggestions.replaceChildren();
  if (customCandidates.length === 0 && candidates.length === 0) {
    hideEmojiSuggestions();
    return;
  }
  hideMentionSuggestions();
  for (const [name, asset] of customCandidates) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "emoji-suggestion";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    const preview = document.createElement("span");
    preview.className = "emoji-suggestion-preview";
    const image = document.createElement("img");
    image.className = "custom-emoji-picker-image";
    image.src = asset.src;
    image.alt = asset.alt;
    image.draggable = false;
    preview.append(image);
    const label = document.createElement("span");
    label.className = "emoji-suggestion-label";
    label.textContent = `:${name}:`;
    option.append(preview, label);
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => {
      const replacement = `:${name}:`;
      messageInput.value = `${messageInput.value.slice(0, token.start)}${replacement}${messageInput.value.slice(token.end)}`;
      const nextCursor = token.start + replacement.length;
      messageInput.setSelectionRange(nextCursor, nextCursor);
      hideEmojiSuggestions();
      rememberDraft();
      resizeMessageInput();
      updateLocalTyping();
      messageInput.focus();
    });
    emojiSuggestions.append(option);
  }
  for (const candidate of candidates) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "emoji-suggestion";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    const preview = document.createElement("span");
    preview.className = "emoji-suggestion-preview";
    appendTwemoji(preview, candidate);
    const label = document.createElement("span");
    label.className = "emoji-suggestion-label";
    label.textContent = `:${emojiShortcodeName(candidate, token.query)}:`;
    option.append(preview, label);
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => {
      const replacement = candidate.emoji;
      messageInput.value = `${messageInput.value.slice(0, token.start)}${replacement}${messageInput.value.slice(token.end)}`;
      const nextCursor = token.start + replacement.length;
      messageInput.setSelectionRange(nextCursor, nextCursor);
      hideEmojiSuggestions();
      rememberDraft();
      resizeMessageInput();
      updateLocalTyping();
      messageInput.focus();
    });
    emojiSuggestions.append(option);
  }
  emojiSuggestions.hidden = false;
}

const messageMacroSuggestions = [
  { name: "time", description: "Localized time", insert: "{time:now}" },
  { name: "date", description: "Localized date", insert: "{date:now}" },
  { name: "timestamp", description: "Date/time; flags t/T/d/D/f/F/R/I/U/s/ms", insert: "{timestamp:now:f}" },
  { name: "datetime", description: "Alias for timestamp", insert: "{datetime:now}" },
  { name: "relative", description: "Offsets: 2h, -30m, 1d2h, 2mo, 1y", insert: "{relative:now}" },
  { name: "time12", description: "12-hour clock time", insert: "{time12:now}" },
  { name: "time24", description: "24-hour clock time", insert: "{time24:now}" },
  { name: "iso", description: "ISO 8601 timestamp", insert: "{iso:now}" },
  { name: "dateiso", description: "Alias for an ISO 8601 timestamp", insert: "{dateiso:now}" },
  { name: "unix", description: "Unix timestamp in seconds", insert: "{unix:now}" },
  { name: "epoch", description: "Alias for Unix timestamp", insert: "{epoch:now}" },
  { name: "weekday", description: "Localized weekday name", insert: "{weekday:now}" },
  { name: "dayofweek", description: "Alias for weekday", insert: "{dayofweek:now}" },
  { name: "dayofyear", description: "Day number within the year", insert: "{dayofyear:now}" },
  { name: "month", description: "Localized month name", insert: "{month:now}" },
  { name: "day", description: "Day of the month", insert: "{day:now}" },
  { name: "year", description: "Year number", insert: "{year:now}" },
  { name: "hour", description: "Hour in your local time zone", insert: "{hour:now}" },
  { name: "minute", description: "Minute of the hour", insert: "{minute:now}" },
  { name: "second", description: "Second of the minute", insert: "{second:now}" },
  { name: "millisecond", description: "Millisecond of the second", insert: "{millisecond:now}" },
  { name: "week", description: "ISO week number", insert: "{week:now}" },
  { name: "quarter", description: "Quarter of the year", insert: "{quarter:now}" },
  { name: "timezone", description: "Your local time-zone name", insert: "{timezone:now}" },
  { name: "zone", description: "Alias for time zone", insert: "{zone:now}" },
] as const;

const macroArgumentSuggestions = [
  { value: "now", description: "At send time" },
  { value: "2h", description: "Two hours from now" },
  { value: "-30m", description: "Thirty minutes ago" },
  { value: "1d", description: "One day from now" },
  { value: "1d2h", description: "One day and two hours from now" },
] as const;

function macroSuggestionToken() {
  const cursor = messageInput.selectionStart ?? messageInput.value.length;
  if (messageInput.selectionEnd !== cursor) return undefined;
  const before = messageInput.value.slice(0, cursor);
  const argumentMatch = before.match(/\{([a-z][a-z0-9_-]*):([^{}]*)$/i);
  const argumentMacro = argumentMatch
    ? messageMacroSuggestions.find((candidate) => candidate.name === argumentMatch[1].toLowerCase())
    : undefined;
  const nameMatch = argumentMacro ? undefined : before.match(/\{([a-z][a-z0-9_-]*)?$/i);
  const match = argumentMacro ? argumentMatch : nameMatch;
  if (!match) return undefined;
  const start = cursor - match[0].length;
  const prefix = before.slice(0, start);
  if (/https?:\/\/\S*$/i.test(prefix)) return undefined;
  const precedingSlashes = prefix.match(/\\+$/)?.[0].length ?? 0;
  if (precedingSlashes % 2 === 1) return undefined;
  if ((before.match(/```/g)?.length ?? 0) % 2 === 1) return undefined;
  const currentLine = before.slice(before.lastIndexOf("\n") + 1);
  if (/(^|[^\\])`[^`]*$/.test(currentLine)) return undefined;
  return argumentMacro && argumentMatch
    ? { kind: "argument" as const, macroName: argumentMacro.name, query: argumentMatch[2].toLowerCase(), start, end: cursor }
    : { kind: "name" as const, query: nameMatch?.[1]?.toLowerCase() ?? "", start, end: cursor };
}

function renderMacroSuggestions() {
  const token = macroSuggestionToken();
  if (!token) {
    hideMacroSuggestions();
    return;
  }
  const candidates = token.kind === "argument"
    ? macroArgumentSuggestions
      .filter((candidate) => candidate.value.startsWith(token.query))
      .map((candidate) => ({
        name: `${token.macroName} · ${candidate.value}`,
        description: candidate.description,
        insert: `{${token.macroName}:${candidate.value}}`,
      }))
    : messageMacroSuggestions
      .filter((candidate) => !token.query || candidate.name.startsWith(token.query))
      .slice(0, 8);
  macroSuggestions.replaceChildren();
  if (candidates.length === 0) {
    hideMacroSuggestions();
    return;
  }
  hideMentionSuggestions();
  hideEmojiSuggestions();
  macroSuggestions.hidden = true;
  activeSuggestionIndex = -1;
  for (const candidate of candidates) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "macro-suggestion";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    const name = document.createElement("span");
    name.className = "macro-suggestion-name";
    name.textContent = candidate.name;
    const details = document.createElement("span");
    details.className = "macro-suggestion-details";
    details.textContent = `${candidate.insert} · ${candidate.description}`;
    option.append(name, details);
    option.title = `${candidate.insert} — ${candidate.description}`;
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => {
      messageInput.value = `${messageInput.value.slice(0, token.start)}${candidate.insert}${messageInput.value.slice(token.end)}`;
      const nextCursor = token.start + candidate.insert.length;
      messageInput.setSelectionRange(nextCursor, nextCursor);
      hideMacroSuggestions();
      rememberDraft();
      resizeMessageInput();
      updateLocalTyping();
      messageInput.focus();
    });
    macroSuggestions.append(option);
  }
  macroSuggestions.hidden = false;
}

function renderInputSuggestions() {
  renderMentionSuggestions();
  renderEmojiSuggestions();
  renderMacroSuggestions();
}

type RenderDecryption = {
  decrypted: DecryptedMessage | null;
  error?: unknown;
};

function decryptedCacheKey(conversationId: string, messageId: string) {
  return `${conversationId}:${messageId}`;
}

function rememberDecryptedMessage(conversationId: string, messageId: string, decrypted: DecryptedMessage) {
  const key = decryptedCacheKey(conversationId, messageId);
  decryptedMessageCache.delete(key);
  decryptedMessageCache.set(key, decrypted);
  while (decryptedMessageCache.size > DECRYPTED_MESSAGE_CACHE_LIMIT) {
    const oldest = decryptedMessageCache.keys().next().value;
    if (typeof oldest !== "string") break;
    decryptedMessageCache.delete(oldest);
  }
}

function cachedDecryptedMessage(conversationId: string, messageId: string) {
  const optimistic = optimisticDecryptedMessages.get(messageId);
  if (optimistic) return optimistic;
  const key = decryptedCacheKey(conversationId, messageId);
  const cached = decryptedMessageCache.get(key);
  if (!cached) return undefined;
  // Keep recently rendered messages in the bounded in-memory cache.
  decryptedMessageCache.delete(key);
  decryptedMessageCache.set(key, cached);
  return cached;
}

async function decryptMessagesForRender(
  conversationId: string,
  messages: MessageEnvelope[],
  activeCryptoClient: CryptoClient,
) {
  const results = new Map<string, RenderDecryption>();
  const pending: MessageEnvelope[] = [];
  for (const message of messages) {
    const cached = cachedDecryptedMessage(conversationId, message.id);
    if (cached) results.set(message.id, { decrypted: cached });
    else pending.push(message);
  }
  if (pending.length === 0) return results;

  const decrypted = await activeCryptoClient.decryptMessages(conversationId, pending);
  const canCache = conversationId === selectedConversationId && activeCryptoClient === cryptoClient;
  for (const result of decrypted) {
    if ("decrypted" in result) {
      if (canCache) rememberDecryptedMessage(conversationId, result.messageId, result.decrypted);
      results.set(result.messageId, { decrypted: result.decrypted });
    } else {
      results.set(result.messageId, { decrypted: null, error: result.error });
    }
  }
  return results;
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

function renderUnreadButton() {
  const distanceFromBottom = messagesPanel.scrollHeight - messagesPanel.scrollTop - messagesPanel.clientHeight;
  if (jumpLatestConversationId !== selectedConversationId) {
    jumpLatestConversationId = selectedConversationId;
    jumpLatestVisible = false;
  }
  const showDistance = Math.max(JUMP_TO_LATEST_SHOW_MIN_DISTANCE, messagesPanel.clientHeight * JUMP_TO_LATEST_SHOW_VIEWPORT_RATIO);
  const hideDistance = Math.max(JUMP_TO_LATEST_HIDE_MIN_DISTANCE, messagesPanel.clientHeight * JUMP_TO_LATEST_HIDE_VIEWPORT_RATIO);
  if (jumpLatestVisible ? distanceFromBottom <= hideDistance : distanceFromBottom >= showDistance) {
    jumpLatestVisible = !jumpLatestVisible;
  }
  const mentionCount = mentionHighlightMessageIds.size;
  const hasMention = mentionCount > 0;
  const label = document.createElement("span");
  label.textContent = hasMention
    ? `${mentionCount} new mention${mentionCount === 1 ? "" : "s"}`
    : unreadCount > 0
      ? `${unreadCount} new message${unreadCount === 1 ? "" : "s"}`
      : "Jump to latest";
  jumpLatestButton.replaceChildren(iconElement(hasMention ? "at-sign" : "arrow-down"), label);
  jumpLatestButton.classList.toggle("jump-latest-mention", hasMention);
  jumpLatestButton.title = hasMention ? "Jump to new mention" : "Jump to latest messages";
  jumpLatestButton.setAttribute("aria-label", hasMention ? `Jump to ${mentionCount} new mention${mentionCount === 1 ? "" : "s"}` : "Jump to latest messages");
  renderIcons(jumpLatestButton);
  jumpLatestButton.hidden = !jumpLatestVisible;
}

async function detectUnreadMentions(messages: MessageEnvelope[], conversationId: string, activeCryptoClient: CryptoClient) {
  if (!currentUser || messages.length === 0 || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
  let changed = false;
  const userId = currentUser.id;
  const candidates = messages.filter((message) => !mentionHighlightMessageIds.has(message.id) && message.senderUserId !== userId);
  const decryptedMessages = await decryptMessagesForRender(conversationId, candidates, activeCryptoClient);
  for (const message of candidates) {
    if (conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    const result = decryptedMessages.get(message.id);
    if (!result?.decrypted || result.error !== undefined) continue;
    const decrypted = result.decrypted;
    pendingMentionNotifications.delete(message.id);
    const mentions = Array.isArray(decrypted.content.mentions)
      ? decrypted.content.mentions.filter((value): value is string => typeof value === "string")
      : [];
    const roleMentions = Array.isArray(decrypted.content.roleMentions)
      ? decrypted.content.roleMentions.filter((value): value is string => typeof value === "string")
      : [];
    if (!messageMentionsCurrentUser(mentions, roleMentions)) continue;
    mentionHighlightMessageIds.add(message.id);
    changed = true;
  }
  if (changed) renderUnreadButton();
}

function isAtLatestMessage() {
  return messagesPanel.scrollHeight - messagesPanel.scrollTop - messagesPanel.clientHeight < 100;
}

function scrollToLatest() {
  const setLatestScrollPosition = () => {
    messagesPanel.scrollTop = messagesPanel.scrollHeight;
  };
  setLatestScrollPosition();
  // Decrypted media and late layout changes can increase scrollHeight after
  // the initial render. Re-apply the position after the browser has painted.
  window.requestAnimationFrame(() => {
    setLatestScrollPosition();
    window.requestAnimationFrame(setLatestScrollPosition);
  });
}

function waitForScrollSettled() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
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
  if (error instanceof Error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) return "Allow microphone access in your browser to join voice.";
  if (error instanceof Error && error.name === "NotFoundError") return "No microphone was found for voice.";
  if (error instanceof Error && error.message === "voice_microphone_unavailable") return "This browser does not have microphone access available.";
  if (error instanceof Error && error.message === "message_too_long") return "Messages are limited to 4,000 characters. Long pasted text is sent as a text file.";
  if (error instanceof Error && error.message === "voice_signaling_unavailable") return "Realtime is unavailable. Reconnect before starting or joining voice.";
  if (error instanceof Error && error.message === "voice_media_encryption_unavailable") return "This browser could not enable encrypted audio, so voice was not connected.";
  if (error instanceof Error && error.message === "voice_room_key_unavailable") return "Could not get the active room’s encrypted media key. Try joining again.";
  if (error instanceof ApiError) {
    if (error.code === "voice_service_not_configured") return "Voice calls are not configured by this server's host.";
    if (error.code === "voice_token_rate_limited") return "Too many voice call or join attempts. Wait a minute and try again.";
    if (error.code === "voice_token_service_unavailable") return "The voice service is temporarily unavailable. Try again shortly.";
    if (error.code === "voice_room_service_unavailable") return "The voice room service is temporarily unavailable. Try again shortly.";
    if (error.code === "voice_room_not_found" || error.code === "not_a_voice_room_member") return "You no longer have access to that voice room.";
    if (error.code === "voice_room_key_unavailable") return "Could not get the active room’s encrypted media key. Try joining again.";
    if (error.code === "blocked_user") return "Voice calls are unavailable because this direct conversation is blocked.";
    if (error.code === "account_suspended") return "This account cannot use voice calls or rooms while suspended.";
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
    if (error.code === "cannot_archive_last_channel") return "A space must keep one active encrypted room.";
    if (error.code === "cannot_archive_metadata_channel") return "The original channel anchors encrypted server metadata and cannot be archived.";
    if (error.code === "channel_not_visible") return "You no longer have access to that channel.";
    if (error.code === "insufficient_channel_permissions") return "Your role cannot send messages or upload files here.";
    if (error.code === "member_timed_out") return "You are temporarily timed out in this server.";
    if (error.code === "instance_user_timed_out") return "A host moderator has temporarily restricted sending for this account. You can still read messages; try again after the timeout expires.";
    if (error.code === "message_not_found") return "That message was already deleted.";
    if (error.code === "server_banned") return "This account is banned from that server.";
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
  appPreferences = applyAppPreferences(loadAppPreferences(currentUser.id), chatLayout);
  const localPassphrase = await resolveLocalPassphrase(currentUser.id);
  if (!localPassphrase) {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/unlock?return=${encodeURIComponent(returnPath)}`);
    return;
  }
  loadUnreadMarkers();
  loadMutedChannels();
  loadNotificationPreference();
  void synchronizeFcmPush(api, currentUser.id, appPreferences);
  optimisticDecryptedMessages.clear();
  decryptedMessageCache.clear();
  await cryptoClient?.close();
  const nextCryptoClient = new CryptoClient(api, currentUser.id, localPassphrase);
  try {
    // Open the local store first. Room selection can render locally cached
    // ciphertext before any initial to-device network sync completes.
    await nextCryptoClient.initialize({ syncToDevice: false });
  } catch (error) {
    await nextCryptoClient.close().catch(() => undefined);
    throw error;
  }
  cryptoClient = nextCryptoClient;
  confirmLocalUnlock();
  initializeVoiceCalls(currentUser.id);
  connectRealtime();
  userLabel.textContent = `${currentUser.displayName} (@${currentUser.username})`;
  renderAvatar(selfAvatar, currentUser.displayName, currentUser.id, currentUser.avatarUrl);
  void cryptoClient.flushPendingMessages().then(async (outbox) => {
    if (cryptoClient !== nextCryptoClient) return;
    await refreshOutboxNotice();
    if (outbox.sent > 0) setStatus(`${outbox.sent} queued message${outbox.sent === 1 ? "" : "s"} delivered.`);
  }).catch(() => undefined);
  await refreshServers();
  await refreshConversations();
  await refreshOutboxNotice().catch(() => undefined);
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
  window.clearTimeout(realtimeHandshakeTimer);
  realtimeHandshakeTimer = undefined;
  realtime?.close();
  realtimeReadySocket = undefined;
  const url = new URL("/v1/realtime", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  setConnectionStatus("Connecting…", "connecting");
  const socket = new WebSocket(url);
  realtime = socket;
  realtimeHandshakeTimer = window.setTimeout(() => {
    if (socket !== realtime || (socket.readyState !== WebSocket.CONNECTING && socket.readyState !== WebSocket.OPEN)) return;
    setConnectionStatus("History available · realtime unavailable", "offline");
    socket.close();
  }, 10_000);
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
        ciphertext?: string;
        isTyping?: boolean;
        state?: PresenceState;
      };
      if (payload.type === "ready") {
        window.clearTimeout(realtimeHandshakeTimer);
        realtimeHandshakeTimer = undefined;
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
      if (payload.type === "voice.signal" && payload.conversationId && payload.userId && payload.ciphertext) {
        const conversation = conversations.find((item) => item.id === payload.conversationId);
        if (conversation?.kind === "dm" && voiceRooms?.currentState.status === "idle") {
          const peerName = voicePeerName(payload.conversationId, payload.userId);
          void voiceCalls?.receiveSignal(payload.conversationId, payload.userId, payload.ciphertext, peerName).catch(() => undefined);
        }
        const voiceChannel = channels.some((channel) => channel.kind === "voice" && channel.conversationId === payload.conversationId);
        if (voiceChannel || voiceRooms?.currentState.conversationId === payload.conversationId) {
          void voiceRooms?.receiveSignal(payload.conversationId, payload.ciphertext).catch(() => undefined);
        }
        return;
      }
      if (payload.type === "message.deleted" && payload.conversationId) {
        if (payload.conversationId === selectedConversationId) {
          void refreshMessages({ forceScrollToBottom: false }).catch((error) => setStatus(readableError(error), true));
        }
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
          if (payload.messageId && payload.serverSequence && appPreferences.notificationMode === "mentions") {
            void notifyIfEncryptedMessageMentionsCurrentUser(payload.conversationId, payload.messageId, payload.serverSequence);
          }
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
    window.clearTimeout(realtimeHandshakeTimer);
    realtimeHandshakeTimer = undefined;
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

function conversationDisplayName(conversation: Conversation) {
  const names = conversation.memberDisplayNames ?? [];
  if (conversation.kind === "dm") return names[0] || "Direct message";
  if (names.length === 0) return "Group conversation";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} + ${names.length - 2}`;
}

function serverDisplayName(server: Server) {
  const index = servers.findIndex((item) => item.id === server.id);
  return serverLabels.get(server.id) || `Space ${index >= 0 ? index + 1 : 1}`;
}

function serverNameForId(serverId: string) {
  const server = servers.find((item) => item.id === serverId);
  return server ? serverDisplayName(server) : "Space";
}

function activeServer() {
  return selectedServerId ? servers.find((server) => server.id === selectedServerId) : undefined;
}

function hasActiveServerPermission(permission: ServerPermission) {
  const server = activeServer();
  return Boolean(server?.permissions[permission]);
}

function serverRoleName(role: CustomServerRole) {
  if (role.systemKey === "owner") return "Owner";
  if (role.systemKey === "everyone") return "All members";
  if (serverRoleLabels.has(role.id)) return serverRoleLabels.get(role.id)!;
  if (role.systemKey === "admin") return "Administrator";
  if (role.systemKey === "member") return "Member";
  return "Role";
}

function serverRoleSlug(role: CustomServerRole) {
  return serverRoleName(role).trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-|-$/g, "");
}

function activeChannelPermissions() {
  const channel = selectedChannelId ? channels.find((candidate) => candidate.id === selectedChannelId) : undefined;
  return {
    canSend: !channel || channel.canSend !== false,
    canUpload: !channel || channel.canUpload !== false,
  };
}

function normalizeRoleIds(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || value.length < 2 || value[0] !== "{" || value[value.length - 1] !== "}") return [];
  return value.slice(1, -1).split(",").map((item) => item.replace(/^"|"$/g, "")).filter(Boolean);
}

function highestServerRole(roleIds: unknown) {
  return normalizeRoleIds(roleIds)
    .map((id) => serverRoles.find((role) => role.id === id))
    .filter((role): role is CustomServerRole => Boolean(role))
    .sort((left, right) => right.position - left.position)[0];
}

function channelDisplayName(channel: ServerChannel) {
  return channelLabels.get(channel.id) || (channel.position === 0 ? "lobby" : `room-${channel.position + 1}`);
}

function roomMentionSlug(channel: ServerChannel) {
  return roomReferenceSlug(channelDisplayName(channel), `room-${channel.position + 1}`);
}

function roomReferenceMap() {
  const references = new Map<string, string>();
  for (const channel of channels) {
    const slug = roomMentionSlug(channel);
    if (!references.has(slug)) references.set(slug, channel.id);
  }
  return references;
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
    button.className = "space-rail-button";
    button.type = "button";
    const deactivated = Boolean(server.deactivatedAt);
    const unread = deactivated ? 0 : serverUnreadCount(server.id);
    button.title = [serverDisplayName(server), deactivated ? "Deactivated" : "", unread > 0 ? `${unread} unread` : ""]
      .filter(Boolean).join(" · ");
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(server.id === selectedServerId));
    button.classList.toggle("selected", server.id === selectedServerId);
    button.classList.toggle("deactivated", deactivated);
    if (server.iconUrl) {
      const icon = document.createElement("img");
      icon.className = "space-rail-image";
      icon.src = server.iconUrl;
      icon.alt = "";
      button.append(icon);
    } else {
      button.textContent = serverDisplayName(server).slice(0, 1).toUpperCase();
      setAvatarStyle(button, server.id);
    }
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
  homeOption.textContent = "Private inbox";
  mobileServerSelect.append(homeOption);
  for (const server of servers) {
    const option = document.createElement("option");
    option.value = server.id;
    option.textContent = `${serverDisplayName(server)}${server.deactivatedAt ? " · Deactivated" : ""}`;
    mobileServerSelect.append(option);
  }
  mobileServerSelect.value = selectedServerId ?? "";

  homeRailButton.classList.toggle("rail-active", !selectedServerId);
  homeRailButton.setAttribute("aria-pressed", String(!selectedServerId));
  const activeServer = selectedServerId ? servers.find((server) => server.id === selectedServerId) : undefined;
  workspaceName.textContent = activeServer ? serverDisplayName(activeServer) : "Private inbox";
  workspaceSubtitle.textContent = activeServer?.deactivatedAt
    ? "Space deactivated"
    : selectedServerId ? "Private encrypted space" : "Encrypted home";
  const canManageChannels = Boolean(activeServer && (
    activeServer.permissions.manage_channels
    || activeServer.permissions.create_channels
    || activeServer.permissions.edit_channels
    || activeServer.permissions.reorder_channels
    || activeServer.permissions.archive_channels
    || activeServer.permissions.manage_categories
    || activeServer.permissions.manage_channel_access
  ));
  const canManageInvites = Boolean(activeServer && (
    activeServer.permissions.manage_invites || activeServer.permissions.create_invites
  ));
  const canManageSettings = Boolean(activeServer && (
    activeServer.permissions.manage_server
    || activeServer.permissions.manage_channels
    || activeServer.permissions.create_channels
    || activeServer.permissions.edit_channels
    || activeServer.permissions.reorder_channels
    || activeServer.permissions.archive_channels
    || activeServer.permissions.manage_categories
    || activeServer.permissions.manage_roles
    || activeServer.permissions.create_roles
    || activeServer.permissions.edit_roles
    || activeServer.permissions.delete_roles
    || activeServer.permissions.reorder_roles
    || activeServer.permissions.manage_role_permissions
    || activeServer.permissions.manage_role_appearance
    || activeServer.permissions.manage_channel_access
    || activeServer.permissions.manage_invites
    || activeServer.permissions.create_invites
    || activeServer.permissions.assign_roles
    || activeServer.permissions.view_invites
    || activeServer.permissions.revoke_invites
    || activeServer.permissions.manage_invite_limits
    || activeServer.permissions.view_moderation_records
    || activeServer.permissions.manage_members
    || activeServer.permissions.kick_members
    || activeServer.permissions.ban_members
    || activeServer.permissions.unban_members
    || activeServer.permissions.timeout_members
    || activeServer.permissions.remove_timeouts
    || activeServer.permissions.warn_members
    || activeServer.permissions.revoke_warnings
    || activeServer.permissions.manage_custom_emoji
    || activeServer.permissions.view_audit_logs
  ));
  createChannelButton.hidden = !canManageChannels;
  serverInviteButton.hidden = !canManageInvites;
  serverSettingsButton.hidden = !canManageSettings;
  if (activeServer) serverSettingsButton.href = `/server-settings?server=${encodeURIComponent(activeServer.id)}`;
}

function renderChannels() {
  const visible = selectedServerId ? channels.filter((channel) => {
    const query = conversationSearchQuery.trim().toLowerCase();
    return !query || `${channelDisplayName(channel)} ${channel.id}`.toLowerCase().includes(query);
  }) : [];
  const deactivated = Boolean(activeServer()?.deactivatedAt);
  channelSectionHeading.hidden = !selectedServerId || deactivated;
  channelList.hidden = !selectedServerId || deactivated;
  channelList.replaceChildren();
  if (!selectedServerId) return;
  channelSectionCount.textContent = conversationSearchQuery.trim()
    ? `${visible.length} of ${channels.length}`
    : `${channels.length} ${channels.length === 1 ? "room" : "rooms"}`;

  if (visible.length === 0) {
    const empty = document.createElement("span");
    empty.className = "muted channel-list-empty";
    empty.textContent = conversationSearchQuery.trim() ? "No rooms match." : "No encrypted rooms yet.";
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
    const unread = unreadMarkers.get(channel.conversationId)?.count ?? 0;
    button.dataset.unread = String(unread > 0);
    button.classList.toggle("selected", channel.id === selectedChannelId);
    button.setAttribute("aria-pressed", String(channel.id === selectedChannelId));
    if (channel.id === selectedChannelId) button.setAttribute("aria-current", "page");
    const channelName = channelDisplayName(channel);
    const muted = mutedChannelIds.has(channel.id);
    button.title = [channelName, muted ? "Muted on this browser" : "", unread > 0 ? `${unread} unread` : ""].filter(Boolean).join(" · ");
    button.setAttribute("aria-label", [channelName, muted ? "muted on this browser" : "", unread > 0 ? `${unread} unread messages` : ""].filter(Boolean).join(", "));
    const icon = document.createElement("span");
    icon.className = "channel-item-icon";
    icon.append(iconElement(channel.kind === "voice" ? "headphones" : "hash"));
    const name = document.createElement("span");
    name.className = "channel-item-name";
    name.textContent = channelName;
    button.append(icon, name);
    if (muted) {
      const muteIndicator = document.createElement("span");
      muteIndicator.className = "channel-muted-indicator";
      muteIndicator.title = "Muted on this browser";
      muteIndicator.setAttribute("aria-label", "Muted on this browser");
      muteIndicator.append(iconElement("bell-off"));
      button.append(muteIndicator);
    }
    if (unread > 0) {
      const badge = document.createElement("span");
      badge.className = "unread-badge channel-unread-count";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      badge.setAttribute("aria-label", `${unread} unread message${unread === 1 ? "" : "s"}`);
      button.append(badge);
    }
    button.addEventListener("click", () => void selectChannel(channel.id));
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openNavigationContextMenu({ kind: "channel", channel }, event.clientX, event.clientY);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      event.preventDefault();
      const rect = button.getBoundingClientRect();
      openNavigationContextMenu({ kind: "channel", channel }, rect.right, rect.bottom);
    });
    channelList.append(button);
  };

  const appendCategory = (category: ServerCategory | null, categoryChannels: ServerChannel[]) => {
    if (categoryChannels.length === 0) return;
    const unread = categoryChannels.reduce((count, channel) => count + (unreadMarkers.get(channel.conversationId)?.count ?? 0), 0);
    const heading = document.createElement(category ? "button" : "div");
    heading.className = "category-heading";
    if (category) {
      const categoryButton = heading as HTMLButtonElement;
      categoryButton.type = "button";
      heading.setAttribute("aria-expanded", String(!collapsedCategories.has(category.id)));
      heading.setAttribute("aria-label", `${categoryDisplayName(category)}, ${categoryChannels.length} room${categoryChannels.length === 1 ? "" : "s"}${unread > 0 ? `, ${unread} unread messages` : ""}`);
    } else {
      heading.classList.add("category-heading-uncategorized");
      heading.setAttribute("role", "heading");
      heading.setAttribute("aria-level", "3");
    }
    const indicator = document.createElement("span");
    indicator.className = "category-heading-indicator";
    if (category) indicator.append(iconElement(collapsedCategories.has(category.id) ? "chevron-right" : "chevron-down"));
    const categoryIcon = document.createElement("span");
    categoryIcon.className = "category-heading-icon";
    categoryIcon.append(iconElement(category && !collapsedCategories.has(category.id) ? "folder-open" : "folder"));
    const name = document.createElement("span");
    name.className = "category-heading-name";
    name.textContent = category ? categoryDisplayName(category) : "Uncategorized";
    const meta = document.createElement("span");
    meta.className = "category-heading-meta";
    const roomCount = document.createElement("span");
    roomCount.className = "category-room-count";
    roomCount.textContent = String(categoryChannels.length);
    roomCount.setAttribute("aria-hidden", "true");
    meta.append(roomCount);
    if (unread > 0) {
      const unreadCount = document.createElement("span");
      unreadCount.className = "category-unread-count";
      unreadCount.textContent = unread > 99 ? "99+" : String(unread);
      unreadCount.setAttribute("aria-label", `${unread} unread messages`);
      meta.append(unreadCount);
    }
    heading.append(indicator, categoryIcon, name, meta);
    if (category) {
      const categoryButton = heading as HTMLButtonElement;
      categoryButton.addEventListener("click", () => {
        if (collapsedCategories.has(category.id)) collapsedCategories.delete(category.id);
        else collapsedCategories.add(category.id);
        renderChannels();
      });
      categoryButton.addEventListener("contextmenu", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        openNavigationContextMenu({ kind: "category", category }, event.clientX, event.clientY);
      });
      categoryButton.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
        event.preventDefault();
        const rect = heading.getBoundingClientRect();
        openNavigationContextMenu({ kind: "category", category }, rect.right, rect.bottom);
      });
    }
    channelList.append(heading);
    if (!category || !collapsedCategories.has(category.id)) {
      for (const channel of categoryChannels) appendChannel(channel);
    }
  };

  const categoryIds = new Set(categories.map((category) => category.id));
  for (const category of categories) appendCategory(category, byCategory.get(category.id) ?? []);
  const uncategorized = visible.filter((channel) => !channel.categoryId || !categoryIds.has(channel.categoryId));
  if (categories.length > 0) {
    appendCategory(null, uncategorized);
  } else {
    for (const channel of uncategorized) appendChannel(channel);
  }
  renderIcons(channelList);
}

function renderConversationEmpty(message: string) {
  const empty = document.createElement("div");
  empty.className = "conversation-list-empty";
  const icon = document.createElement("span");
  icon.className = "empty-icon";
  icon.append(iconElement("search"));
  const text = document.createElement("span");
  text.textContent = message;
  empty.append(icon, text);
  conversationList.append(empty);
  renderIcons(conversationList);
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
       renderConversationWelcome("Your private threads", "Start a private conversation to begin chatting.");
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
  updateVoiceCallButton();
  const visibleInWorkspace = !selectedServerId;
  directMessagesHeading.hidden = !visibleInWorkspace;
  createConversationButton.hidden = !visibleInWorkspace;
  conversationList.hidden = !visibleInWorkspace;
  conversationSearch.placeholder = visibleInWorkspace ? "Find a private thread" : "Find a room";
  conversationSearch.setAttribute("aria-label", visibleInWorkspace ? "Find a private thread" : "Find a room");
  conversationList.replaceChildren();
  if (!visibleInWorkspace) return;
  if (conversations.length === 0) {
    renderConversationEmpty("No private threads yet.");
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
    icon.append(iconElement(conversation.kind === "dm" ? "user-round" : "users-round"));
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
      ? "private message · encrypted"
      : `${memberCount} people · encrypted`;
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
    remove.append(iconElement("trash-2"));
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void removeConversation(conversation);
    });
    row.append(button, remove);
    conversationList.append(row);
  }
  renderIcons(conversationList);
}

async function refreshServers() {
  const result = await api.servers();
  servers = result.servers;
  renderServers();
  void Promise.all(servers.filter((server) => !server.deactivatedAt).map(async (server) => {
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
    if (servers.find((server) => server.id === selectedServerId)?.deactivatedAt
      || chatMain.classList.contains("is-space-deactivated")) {
      await selectServer(selectedServerId);
      return;
    }
    renderServers();
    return;
  }
  const initialServer = servers.find((server) => !server.deactivatedAt) ?? servers[0];
  if (initialServer) {
    await selectServer(initialServer.id);
    return;
  }
  selectedServerId = undefined;
  selectedChannelId = undefined;
  clearDeactivatedSpaceView();
  channels = [];
  categories = [];
  renderServers();
  renderChannels();
}

function decodeBase64Bytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function clearCustomEmojiAssets() {
  for (const url of customEmojiObjectUrls) URL.revokeObjectURL(url);
  customEmojiObjectUrls = [];
  customEmojiAssets.clear();
  customEmojiHydrationToken += 1;
}

async function hydrateServerCustomEmojis(serverId: string, metadataConversationId: string, selectionTokenForServer: number) {
  const activeCrypto = cryptoClient;
  if (!activeCrypto) return;
  const hydrationToken = ++customEmojiHydrationToken;
  try {
    const result = await api.serverCustomEmojis(serverId);
    const definitions = await Promise.all(result.emojis.map(async (emoji) => {
      if (emoji.status !== "uploaded" || !emoji.fileUrl) return undefined;
      try {
        const metadata = await activeCrypto.decryptMetadata(metadataConversationId, emoji.encryptedMetadata);
        const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
        const key = typeof metadata.key === "string" ? decodeBase64Bytes(metadata.key) : undefined;
        const iv = typeof metadata.iv === "string" ? decodeBase64Bytes(metadata.iv) : undefined;
        const mimeType = typeof metadata.mimeType === "string" && /^image\/(?:avif|gif|jpeg|png|webp)$/i.test(metadata.mimeType)
          ? metadata.mimeType
          : undefined;
        if (!/^[A-Za-z0-9_+-]{1,32}$/.test(name) || !key || !iv || !mimeType || ![16, 24, 32].includes(key.byteLength) || iv.byteLength !== 12) return undefined;
        const response = await fetch(emoji.fileUrl, { credentials: "include" });
        if (!response.ok) return undefined;
        const encrypted = new Uint8Array(await response.arrayBuffer());
        if (encrypted.byteLength < 13 || encrypted.byteLength > 10 * 1024 * 1024) return undefined;
        const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
        const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, encrypted.subarray(12));
        return { name: name.toLowerCase(), blob: new Blob([clear], { type: mimeType }) };
      } catch {
        return undefined;
      }
    }));
    if (selectionTokenForServer !== serverSelectionToken || selectedServerId !== serverId || cryptoClient !== activeCrypto || hydrationToken !== customEmojiHydrationToken) return;
    const hadCustomEmojiAssets = customEmojiAssets.size > 0;
    clearCustomEmojiAssets();
    for (const definition of definitions) {
      if (!definition || customEmojiAssets.has(definition.name)) continue;
      const src = URL.createObjectURL(definition.blob);
      customEmojiObjectUrls.push(src);
      customEmojiAssets.set(definition.name, { src, alt: `:${definition.name}:` });
    }
    if (!emojiPicker.hidden) renderEmojiPicker();
    if ((hadCustomEmojiAssets || customEmojiAssets.size > 0) && loadedMessages.length > 0 && selectedServerId === serverId) {
      refreshRenderedMessageMarkdown();
    }
  } catch {
    // Custom emoji are optional encrypted metadata and must not block chat.
  }
}

async function selectServer(serverId: string, requestedChannelId?: string) {
  rememberDraft();
  uploadAbortController?.abort();
  hideMentionSuggestions();
  const token = ++serverSelectionToken;
  clearDeactivatedSpaceView();
  selectedServerId = serverId;
  chatContent.dataset.voiceRoom = "false";
  voiceRoomPanel.hidden = true;
  messageSearchToggle.hidden = false;
  messageSearchContainer.hidden = false;
  void refreshModerationNotices(serverId);
  selectedChannelId = undefined;
  activeServerWelcome = undefined;
  clearCustomEmojiAssets();
  selectedConversationId = undefined;
  conversationReady = false;
  selectedMembers = [];
  channels = [];
  categories = [];
  serverRoles = [];
  serverRoleLabels.clear();
  selectionToken += 1;
  renderServers();
  renderConversations();
  renderChannels();
  renderMembers([]);
  updateComposerState();
  renderConversationWelcome("Opening space…", "Loading its encrypted rooms.");
  conversationTitle.textContent = serverNameForId(serverId);
  conversationSubtitle.textContent = "Loading encrypted channels…";
  setChannelIcon("message-square");

  if (servers.find((server) => server.id === serverId)?.deactivatedAt) {
    renderDeactivatedSpace(serverId);
    return;
  }

  try {
    const [channelResult, categoryResult, roleResult] = await Promise.all([
      api.serverChannels(serverId),
      api.serverCategories(serverId),
      api.serverRoles(serverId),
    ]);
    if (token !== serverSelectionToken) return;
    channels = channelResult.channels;
    channelsByServer.set(serverId, channels);
    categories = categoryResult.categories;
    serverRoles = roleResult.roles;
    subscribeKnownConversations();
    renderChannels();
    renderServers();
    const configuredLandingChannel = servers.find((server) => server.id === serverId)?.landingChannelId;
    const requested = requestedChannelId && channels.find((channel) => channel.id === requestedChannelId);
    const landing = configuredLandingChannel && channels.find((channel) => channel.id === configuredLandingChannel);
    const channel = requested ?? landing ?? channels[0];
    if (channel) {
      await selectChannel(channel.id);
      void hydrateChannelLabels(serverId, channels.slice(), token);
    }
    else {
      conversationTitle.textContent = serverNameForId(serverId);
      conversationSubtitle.textContent = "Create an encrypted room to start chatting";
      renderConversationWelcome("No encrypted rooms yet", "Create a room to start a private space conversation.");
      setMobileSidebar(false);
    }
    if (roleResult.metadataConversationId && cryptoClient) {
      void hydrateServerCustomEmojis(serverId, roleResult.metadataConversationId, token);
    }
    // Role labels are optional encrypted metadata. Defer their network and
    // crypto work until the selected room has had a chance to show its cache.
    if (roleResult.metadataConversationId && cryptoClient) {
      try {
        const metadataMembers = (await api.conversationMembers(roleResult.metadataConversationId)).members;
        await cryptoClient.prepareConversation(roleResult.metadataConversationId, metadataMembers);
        await cryptoClient.syncToDevice().catch(() => undefined);
        for (const role of serverRoles) {
          if (!role.encryptedMetadata) continue;
          try {
            const metadata = await cryptoClient.decryptMetadata(roleResult.metadataConversationId, role.encryptedMetadata);
            if (typeof metadata.name === "string" && metadata.name.trim()) {
              serverRoleLabels.set(role.id, metadata.name.trim().slice(0, 80));
            }
          } catch {
            // A role label is optional UI metadata and should not block the server.
          }
        }
        renderMembers(selectedMembers);
      } catch {
        // Role labels are encrypted metadata and are optional for opening a channel.
      }
    }
  } catch (error) {
    if (token !== serverSelectionToken) return;
    if (error instanceof ApiError && error.code === "not_a_server_member") {
      try {
        const refreshed = await api.servers();
        if (token !== serverSelectionToken) return;
        servers = refreshed.servers;
        renderServers();
        if (servers.find((server) => server.id === serverId)?.deactivatedAt) {
          renderDeactivatedSpace(serverId);
          return;
        }
      } catch {
        // Keep the original access error if the membership refresh also fails.
      }
    }
    setStatus(readableError(error), true);
    renderConversationWelcome("Unable to load this space", "Try selecting it again after checking your connection.");
  }
}

async function selectChannel(channelId: string) {
  const channel = channels.find((item) => item.id === channelId);
  if (!channel) return;
  selectedChannelId = channel.id;
  await selectConversation(channel.conversationId, channel);
}

async function hydrateChannelLabels(serverId: string, snapshot: ServerChannel[], token: number) {
  const activeCrypto = cryptoClient;
  if (!activeCrypto || selectedServerId !== serverId) return;
  const targets = snapshot.filter((channel) => channel.encryptedMetadata && !channelLabels.has(channel.id));
  if (targets.length === 0) return;
  const prepared = (await Promise.all(targets.map(async (channel) => {
    try {
      const members = (await api.conversationMembers(channel.conversationId)).members;
      await activeCrypto.prepareConversation(channel.conversationId, members);
      return channel;
    } catch {
      return undefined;
    }
  }))).filter((channel): channel is ServerChannel => Boolean(channel));
  if (serverSelectionToken !== token || selectedServerId !== serverId || cryptoClient !== activeCrypto || prepared.length === 0) return;
  await activeCrypto.syncToDevice().catch(() => undefined);
  const metadata = await Promise.all(prepared.map(async (channel) => {
    try {
      return await activeCrypto.decryptMetadata(channel.conversationId, channel.encryptedMetadata);
    } catch {
      return undefined;
    }
  }));
  if (serverSelectionToken !== token || selectedServerId !== serverId || cryptoClient !== activeCrypto) return;
  for (const [index, value] of metadata.entries()) {
    if (typeof value?.name === "string" && value.name.trim()) {
      channelLabels.set(prepared[index].id, value.name.trim().slice(0, 80));
    }
  }
  renderChannels();
  renderInputSuggestions();
  if (loadedMessages.length > 0) {
    refreshRenderedMessageMarkdown();
  }
}

async function openDirectMessage(conversationId: string) {
  clearDeactivatedSpaceView();
  selectedServerId = undefined;
  void refreshModerationNotices(undefined);
  selectedChannelId = undefined;
  channels = [];
  categories = [];
  serverRoles = [];
  clearCustomEmojiAssets();
  serverRoleLabels.clear();
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
  clearDeactivatedSpaceView();
  selectedServerId = undefined;
  selectedChannelId = undefined;
  chatContent.dataset.voiceRoom = "false";
  voiceRoomPanel.hidden = true;
  messageSearchToggle.hidden = false;
  messageSearchContainer.hidden = false;
  clearCustomEmojiAssets();
  channels = [];
  categories = [];
  serverRoles = [];
  serverRoleLabels.clear();
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
    setChannelIcon("inbox");
    renderConversationWelcome("No conversations yet", "Create a direct message or group conversation to get started.");
    renderMembers([]);
    updateComposerState();
    setMobileSidebar(false);
  }
}

async function refreshConversations() {
  const requested = chatLocation().conversationId;
  if (!selectedServerId && !selectedConversationId && requested) {
    // The URL already identifies this thread. Start its local-cache restore
    // without waiting for the inbox API to finish loading.
    void openDirectMessage(requested);
  }
  const result = await api.conversations();
  conversations = result.conversations;
  subscribeKnownConversations();
  renderConversations();
  const selectedChannel = channels.some((channel) => channel.conversationId === selectedConversationId);
  if (selectedConversationId && !selectedChannel && !conversations.some((conversation) => conversation.id === selectedConversationId)) {
    selectedConversationId = undefined;
    selectedMembers = [];
  }
  const requestedConversation = requested && conversations.find((conversation) => conversation.id === requested);
  if (!selectedServerId && !selectedConversationId && requestedConversation) await openDirectMessage(requestedConversation.id);
  else if (!selectedServerId && !selectedConversationId && conversations[0]) await openDirectMessage(conversations[0].id);
  else if (!selectedConversationId) {
    conversationTitle.textContent = "Your conversations";
    conversationSubtitle.textContent = "Start a private conversation to begin chatting";
    setChannelIcon("inbox");
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
  type MemberGroup = { roleId?: string; label: string; color?: string; position: number; members: ConversationMember[] };
  const groups = new Map<string, MemberGroup>();
  const allMembersRole = selectedServerId ? serverRoles.find((role) => role.systemKey === "everyone") : undefined;
  for (const member of members) {
    const separatedRole = selectedServerId
      ? highestSeparatedRole(normalizeRoleIds(member.roleIds), serverRoles)
      : undefined;
    const key = separatedRole?.id ?? allMembersRole?.id ?? "participants";
    const group = groups.get(key) ?? {
      roleId: separatedRole?.id ?? allMembersRole?.id,
      label: separatedRole ? serverRoleName(separatedRole) : allMembersRole ? serverRoleName(allMembersRole) : "Participants",
      color: separatedRole?.color ?? allMembersRole?.color,
      position: separatedRole?.position ?? -1,
      members: [],
    };
    group.members.push(member);
    groups.set(key, group);
  }

  for (const group of [...groups.values()].sort((left, right) => right.position - left.position || left.label.localeCompare(right.label))) {
    const heading = document.createElement("div");
    heading.className = "member-group-heading";
    if (group.roleId) heading.dataset.roleId = group.roleId;
    if (group.color) setRoleTextColor(heading, group.color);
    heading.textContent = group.label;
    memberList.append(heading);
    for (const member of group.members.sort((left, right) => left.displayName.localeCompare(right.displayName))) {
      const memberRole = highestServerRole(member.roleIds);
      const row = document.createElement("button");
      const memberName = member.userId === currentUser?.id ? currentUser?.displayName ?? "You" : member.displayName || `@${member.username}`;
      row.className = "member-row compact-member-row profile-trigger";
      row.type = "button";
      row.dataset.roleGroupId = group.roleId ?? "participants";
      row.title = `View ${memberName}'s profile`;
      row.addEventListener("click", () => void openUserProfile(member.userId));
      const state = member.userId === currentUser?.id ? "online" : presenceByUser.get(member.userId) ?? "offline";
      const presence = document.createElement("span");
      presence.className = "member-presence-dot";
      presence.dataset.state = state;
      presence.setAttribute("aria-hidden", "true");
      const avatar = document.createElement("span");
      avatar.className = "member-avatar";
      renderAvatar(avatar, memberName, member.userId, member.avatarUrl);
      avatar.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "compact-member-name";
      if (memberRole?.color) setRoleTextColor(name, memberRole.color);
      name.textContent = member.userId === currentUser?.id ? `${memberName} · you` : memberName;
      row.append(avatar, presence, name);
      memberList.append(row);
    }
  }
}

function renderConversationWelcome(title: string, description: string) {
  releaseMediaResources(messagesPanel);
  messagesPanel.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "conversation-welcome";
  const icon = document.createElement("div");
  icon.className = "conversation-welcome-icon";
  icon.textContent = "N";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = description;
  empty.append(icon, heading, body);
  messagesPanel.append(empty);
}

// I have nothing but my burger and I want nothing more
function renderDeactivatedSpace(serverId: string) {
  selectedChannelId = undefined;
  selectedConversationId = undefined;
  chatContent.dataset.voiceRoom = "false";
  voiceRoomPanel.hidden = true;
  messageSearchToggle.hidden = true;
  selectedMembers = [];
  conversationReady = false;
  channels = [];
  categories = [];
  serverRoles = [];
  activeServerWelcome = undefined;
  clearCustomEmojiAssets();
  renderServers();
  renderChannels();
  renderMembers([]);
  updateComposerState();
  conversationTitle.textContent = serverNameForId(serverId);
  conversationSubtitle.textContent = "Space deactivated";
  setChannelIcon("lock-keyhole");
  releaseMediaResources(messagesPanel);
  messagesPanel.replaceChildren();
  deactivatedSpaceName.textContent = serverNameForId(serverId);
  chatMain.classList.add("is-space-deactivated");
  deactivatedSpaceView.hidden = false;
  renderIcons(deactivatedSpaceView);
  deactivatedSpaceView.focus({ preventScroll: true });
  setMobileSidebar(false);
}

function clearDeactivatedSpaceView() {
  chatMain.classList.remove("is-space-deactivated");
  deactivatedSpaceView.hidden = true;
}

function renderServerWelcome() {
  const welcome = activeServerWelcome;
  if (!welcome?.enabled) {
    renderConversationWelcome("This is the beginning", "Send a message to start this encrypted conversation.");
    return;
  }
  releaseMediaResources(messagesPanel);
  messagesPanel.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "conversation-welcome server-welcome";
  const icon = document.createElement("div");
  icon.className = "conversation-welcome-icon";
  const server = selectedServerId ? servers.find((candidate) => candidate.id === selectedServerId) : undefined;
  if (server?.iconUrl) {
    const image = document.createElement("img");
    image.src = server.iconUrl;
    image.alt = "";
    icon.append(image);
  } else {
    icon.textContent = server ? serverDisplayName(server).slice(0, 1).toUpperCase() : "N";
  }
  const heading = document.createElement("h3");
  heading.textContent = welcome.heading || "Welcome";
  const body = document.createElement("p");
  body.textContent = welcome.description || "Welcome to this private space.";
  empty.append(icon, heading, body);
  if (welcome.rules) {
    const rules = document.createElement("pre");
    rules.className = "server-welcome-rules";
    rules.textContent = welcome.rules;
    empty.append(rules);
  }
  if (welcome.acknowledgement) {
    const acknowledgement = document.createElement("span");
    acknowledgement.className = "muted small server-welcome-acknowledgement";
    acknowledgement.textContent = "Please acknowledge these rules before participating.";
    empty.append(acknowledgement);
  }
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

function drainAutoMediaLoads() {
  while (autoMediaLoadsInFlight < MAX_AUTO_MEDIA_LOADS && autoMediaLoadQueue.length > 0) {
    const load = autoMediaLoadQueue.shift()!;
    autoMediaLoadsInFlight += 1;
    void load().catch(() => undefined).finally(() => {
      autoMediaLoadsInFlight -= 1;
      drainAutoMediaLoads();
    });
  }
}

function queueAutoMediaLoad(load: () => Promise<void>) {
  autoMediaLoadQueue.push(load);
  drainAutoMediaLoads();
}

function registerAutoMediaLoad(target: HTMLElement, load: () => Promise<void>) {
  if (typeof IntersectionObserver === "undefined") {
    if (target.isConnected) queueAutoMediaLoad(load);
    else window.setTimeout(() => {
      if (target.isConnected) queueAutoMediaLoad(load);
    }, 0);
    return;
  }
  if (!autoMediaLoadObserver) {
    autoMediaLoadObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target as HTMLElement;
        const loader = autoMediaLoadTargets.get(element);
        if (!loader) continue;
        autoMediaLoadTargets.delete(element);
        autoMediaLoadObserver?.unobserve(element);
        queueAutoMediaLoad(loader);
      }
    }, { root: messagesPanel, rootMargin: "420px 0px" });
  }
  autoMediaLoadTargets.set(target, load);
  if (target.isConnected) autoMediaLoadObserver.observe(target);
  else window.setTimeout(() => {
    if (autoMediaLoadTargets.get(target) === load && target.isConnected) autoMediaLoadObserver?.observe(target);
  }, 0);
}

function releaseMediaResources(root: HTMLElement) {
  for (const [button, controller] of pendingMediaLoads) {
    if (root.contains(button)) {
      controller.abort();
      pendingMediaLoads.delete(button);
    }
  }
  for (const target of autoMediaLoadTargets.keys()) {
    if (!root.contains(target)) continue;
    autoMediaLoadObserver?.unobserve(target);
    autoMediaLoadTargets.delete(target);
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-media-url]")) {
    if (element.dataset.mediaUrl) URL.revokeObjectURL(element.dataset.mediaUrl);
    delete element.dataset.mediaUrl;
  }
}

const MAX_COMPOSER_ATTACHMENTS = 10;
const MAX_AUTO_TEXT_PREVIEW_BYTES = 128 * 1024;

function fileSizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function openComposerAttachmentViewer(attachment: ComposerAttachment, video: boolean) {
  let revealed = !attachment.spoiler;
  const item: MediaViewerItem = {
    filename: attachment.file.name,
    video,
    spoiler: attachment.spoiler,
    blob: attachment.file,
    isRevealed: () => revealed,
    reveal: () => { revealed = true; },
    load: async () => attachment.file,
  };
  openMediaViewer(attachment.file, attachment.file.name, video, [item]);
}

function composerAttachmentKind(file: File): "image" | "video" | "text" | "file" {
  if (isPlaintextAttachment(file.name, file.type)) return "text";
  if (file.type.toLowerCase().startsWith("video/")) return "video";
  if (file.type.toLowerCase().startsWith("image/")) return "image";
  return "file";
}

function revokeComposerAttachment(attachment: ComposerAttachment) {
  if (!attachment.previewUrl) return;
  URL.revokeObjectURL(attachment.previewUrl);
  attachment.previewUrl = undefined;
}

function renderComposerAttachments() {
  attachmentPreviewList.replaceChildren();
  attachmentPreview.hidden = composerAttachments.length === 0;
  if (composerAttachments.length === 0) {
    attachmentLabel.textContent = "";
    uploadProgress.hidden = true;
    uploadProgress.value = 0;
    return;
  }

  const totalSize = composerAttachments.reduce((total, attachment) => total + attachment.file.size, 0);
  const uploading = composerAttachments.filter((attachment) => attachment.status === "uploading");
  const failed = composerAttachments.filter((attachment) => attachment.status === "error").length;
  attachmentLabel.textContent = `${composerAttachments.length} file${composerAttachments.length === 1 ? "" : "s"} · ${fileSizeLabel(totalSize)}${failed ? ` · ${failed} failed` : ""}`;
  uploadProgress.hidden = uploading.length === 0;
  uploadProgress.value = uploading.length === 0
    ? 0
    : uploading.reduce((total, attachment) => total + attachment.progress, 0) / uploading.length;

  for (const attachment of composerAttachments) {
    const kind = composerAttachmentKind(attachment.file);
    const row = document.createElement("article");
    row.className = `attachment-item attachment-item-${kind}${kind === "image" || kind === "video" ? " attachment-item-media" : ""}${attachment.status === "error" ? " attachment-item-error" : ""}`;
    row.dataset.attachmentId = attachment.id;
    attachment.row = row;

    const isMedia = kind === "image" || kind === "video";
    const visual = document.createElement(isMedia ? "button" : "div");
    visual.className = `attachment-item-visual attachment-item-${kind}${attachment.spoiler ? " attachment-item-spoiler" : ""}`;
    if (visual instanceof HTMLButtonElement) {
      visual.type = "button";
      visual.setAttribute("aria-label", `Open larger preview of ${attachment.file.name || "attachment"}`);
      visual.addEventListener("click", () => openComposerAttachmentViewer(attachment, kind === "video"));
    }
    if (kind === "image" || kind === "video") {
      attachment.previewUrl ??= URL.createObjectURL(attachment.file);
      const preview = document.createElement(kind === "video" ? "video" : "img");
      preview.className = "attachment-item-thumb";
      preview.src = attachment.previewUrl;
      if (kind === "video") {
        const player = preview as HTMLVideoElement;
        player.muted = true;
        player.preload = "metadata";
      } else {
        (preview as HTMLImageElement).alt = attachment.file.name;
      }
      visual.append(preview);
    } else {
      const extension = attachment.file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toUpperCase() || (kind === "text" ? "TXT" : "FILE");
      const extensionLabel = document.createElement("strong");
      extensionLabel.textContent = extension;
      visual.append(extensionLabel);
    }
    if (attachment.spoiler) {
      const spoilerCover = document.createElement("span");
      spoilerCover.className = "attachment-item-spoiler-label";
      spoilerCover.textContent = "Spoiler";
      visual.append(spoilerCover);
    }

    const copy = document.createElement("div");
    copy.className = "attachment-item-copy";
    const name = document.createElement("strong");
    name.textContent = attachment.file.name || "Untitled file";
    name.title = attachment.file.name;
    const meta = document.createElement("span");
    meta.textContent = `${kind === "text" ? "Plaintext" : kind[0].toUpperCase() + kind.slice(1)} · ${fileSizeLabel(attachment.file.size)}`;
    const status = document.createElement("small");
    status.className = "attachment-item-status";
    status.textContent = attachment.status === "uploading"
      ? `Uploading · ${Math.round(attachment.progress)}%`
      : attachment.error ?? (attachment.status === "error" ? "Upload failed" : "");
    attachment.statusElement = status;
    copy.append(name, meta, status);

    const actions = document.createElement("div");
    actions.className = "attachment-item-actions";
    if (kind === "text") {
      const previewButton = document.createElement("button");
      previewButton.type = "button";
      previewButton.className = "secondary";
      previewButton.textContent = "Preview";
      previewButton.disabled = attachment.status === "uploading";
      previewButton.addEventListener("click", () => void openTextViewer(attachment.file, attachment.file.name, attachment.file.type));
      actions.append(previewButton);
    }
    const spoilerLabel = document.createElement("label");
    spoilerLabel.className = "attachment-spoiler-toggle";
    const spoiler = document.createElement("input");
    spoiler.type = "checkbox";
    spoiler.checked = attachment.spoiler;
    spoiler.disabled = attachment.status === "uploading";
    spoiler.addEventListener("change", () => {
      attachment.spoiler = spoiler.checked;
      renderComposerAttachments();
    });
    spoilerLabel.append(spoiler, document.createTextNode("Spoiler"));
    actions.append(spoilerLabel);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.title = "Remove attachment";
    remove.setAttribute("aria-label", `Remove ${attachment.file.name || "attachment"}`);
    remove.textContent = "×";
    remove.disabled = attachment.status === "uploading";
    remove.addEventListener("click", () => removeComposerAttachment(attachment.id));
    actions.append(remove);

    const progress = document.createElement("progress");
    progress.className = "attachment-item-progress";
    progress.max = 100;
    progress.value = attachment.progress;
    progress.hidden = attachment.status !== "uploading";
    attachment.progressElement = progress;
    row.append(visual, copy, actions, progress);
    attachmentPreviewList.append(row);
  }
}

function removeComposerAttachment(id: string) {
  const index = composerAttachments.findIndex((attachment) => attachment.id === id);
  if (index < 0) return;
  const [removed] = composerAttachments.splice(index, 1);
  if (removed) revokeComposerAttachment(removed);
  renderComposerAttachments();
}

function clearComposerAttachments() {
  for (const attachment of composerAttachments) revokeComposerAttachment(attachment);
  composerAttachments = [];
  photoInput.value = "";
  renderComposerAttachments();
}

function addComposerFiles(files: File[]) {
  const available = Math.max(0, MAX_COMPOSER_ATTACHMENTS - composerAttachments.length);
  const accepted = files.filter((file) => file.size > 0).slice(0, available);
  for (const file of accepted) {
    composerAttachments.push({
      id: `attachment-${Date.now()}-${composerAttachmentSequence += 1}`,
      file,
      spoiler: false,
      status: "ready",
      progress: 0,
    });
  }
  if (files.length > accepted.length) {
    setStatus(`Only ${MAX_COMPOSER_ATTACHMENTS} attachments can be queued, and empty files are ignored.`, true);
  }
  if (accepted.length > 0) renderComposerAttachments();
  photoInput.value = "";
  return accepted.length;
}

function hasFileDrag(dataTransfer: DataTransfer | null) {
  return Boolean(dataTransfer && (dataTransfer.types.includes("Files") || dataTransfer.files.length > 0));
}

function canDropComposerFiles() {
  return !photoInput.disabled && !editTarget && !sendInProgress;
}

function resetFileDropOverlay() {
  fileDropOverlay.hidden = true;
  chatContent.classList.remove("file-drop-active");
}

function handleFileDrop(event: DragEvent) {
  if (!hasFileDrag(event.dataTransfer)) return;
  // I have nothing but my burger and I want nothing more
  event.preventDefault();
  const droppedInsideChat = event.target instanceof Node && chatContent.contains(event.target);
  resetFileDropOverlay();
  if (!droppedInsideChat) return;
  if (editTarget) {
    setStatus("Attachments cannot be added while editing a message.", true);
    return;
  }
  if (!canDropComposerFiles()) {
    setStatus("You cannot upload files in this conversation right now.", true);
    return;
  }
  const files = [...(event.dataTransfer?.files ?? [])];
  const added = addComposerFiles(files);
  if (added > 0) setStatus(`${added} dropped file${added === 1 ? "" : "s"} added for encrypted upload.`);
}

function clipboardImageExtension(mimeType: string) {
  const subtype = mimeType.toLowerCase().match(/^image\/([a-z0-9.+-]+)$/)?.[1];
  if (subtype === "jpeg") return "jpg";
  if (subtype && /^[a-z0-9]{1,12}$/.test(subtype)) return subtype;
  return "png";
}

function clipboardImageFiles(clipboard: DataTransfer | null) {
  if (!clipboard) return [];
  const fromItems = [...clipboard.items]
    .filter((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  const files = fromItems.length > 0
    ? fromItems
    : [...clipboard.files].filter((file) => file.type.toLowerCase().startsWith("image/"));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return files.map((file, index) => {
    if (/\.[a-z0-9]{1,12}$/i.test(file.name)) return file;
    return new File([file], `pasted-image-${timestamp}-${index + 1}.${clipboardImageExtension(file.type)}`, { type: file.type });
  });
}

function setComposerAttachmentProgress(attachment: ComposerAttachment, loadedBytes: number, totalBytes: number) {
  attachment.progress = totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : 0;
  if (attachment.progressElement) attachment.progressElement.value = attachment.progress;
  if (attachment.statusElement) attachment.statusElement.textContent = `Uploading · ${Math.round(attachment.progress)}%`;
  const uploading = composerAttachments.filter((candidate) => candidate.status === "uploading");
  if (uploading.length > 0) uploadProgress.value = uploading.reduce((total, candidate) => total + candidate.progress, 0) / uploading.length;
}

function updateComposerState() {
  const selectedChannel = selectedChannelId ? channels.find((channel) => channel.id === selectedChannelId) : undefined;
  const enabled = Boolean(selectedConversationId && cryptoClient && conversationReady && selectedChannel?.kind !== "voice");
  const channelPermissions = activeChannelPermissions();
  messageInput.disabled = !enabled || sendInProgress || !channelPermissions.canSend;
  photoInput.disabled = !enabled || sendInProgress || Boolean(editTarget) || !channelPermissions.canUpload;
  sendButton.disabled = !enabled || sendInProgress;
  emojiToggle.disabled = !enabled || sendInProgress || Boolean(editTarget);
  gifToggle.disabled = !enabled || sendInProgress || Boolean(editTarget) || !channelPermissions.canUpload;
  messageSearchToggle.disabled = !enabled;
  messageInput.placeholder = !enabled
    ? "Select a conversation to start chatting"
    : !channelPermissions.canSend
      ? "You can view this channel but cannot send messages"
      : "Message this conversation";
  renderMessageInput();
  if (!enabled) {
    closeEmojiPicker();
    closeGifPicker();
    clearComposerAttachments();
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

function refreshRelativeMessageDisplays() {
  const nowMs = Date.now();
  refreshRelativeTimeMacros(messagesPanel, nowMs);
  for (const target of messageContextTargets.values()) {
    if (redactedMessageIds.has(target.message.id)) continue;
    target.article.dataset.search = `${target.sender} ${searchableMessageBody(target.body, nowMs)}`.toLowerCase();
  }
  if (replyTarget && !replyPreview.hidden) {
    const preview = formatMessageMacrosAsText(replyTarget.body, nowMs).replace(/\s+/g, " ").trim() || "Encrypted message";
    replyPreviewText.textContent = `Replying to ${replyTarget.sender}: ${preview.slice(0, 180)}`;
  }
  if (editTarget && !editPreview.hidden) {
    const preview = formatMessageMacrosAsText(editTarget.body, nowMs).replace(/\s+/g, " ").slice(0, 180);
    editPreviewText.textContent = `Editing ${editTarget.sender}: ${preview}`;
  }
  applyMessageSearch();
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
  const isVoiceRoom = channel?.kind === "voice";
  selectedConversationId = conversationId;
  conversationReady = false;
  lastRoomKeyRefreshAt = 0;
  if (channel) selectedChannelId = channel.id;
  chatContent.dataset.voiceRoom = channel?.kind === "voice" ? "true" : "false";
  voiceRoomPanel.hidden = channel?.kind !== "voice";
  messageSearchToggle.hidden = channel?.kind === "voice";
  messageSearchContainer.hidden = channel?.kind === "voice";
  setDetailsForConversation(Boolean(channel));
  lastMessagesKey = "__not-rendered__";
  loadedMessages = [];
  nextBefore = null;
  nextAfter = null;
  latestObservedSequence = null;
  optimisticDecryptedMessages.clear();
  decryptedMessageCache.clear();
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
  clearComposerAttachments();
  messageInput.value = drafts.get(conversationId) ?? "";
  resizeMessageInput();
  const conversation = conversations.find((item) => item.id === conversationId);
  conversationTitle.textContent = channel ? channelDisplayName(channel) : conversation ? conversationDisplayName(conversation) : "Conversation";
  conversationSubtitle.textContent = isVoiceRoom ? "End-to-end encrypted voice room" : "Loading encrypted conversation…";
  if (isVoiceRoom) messagesPanel.replaceChildren();
  else renderMessageSkeletons();
  setChannelIcon(channel ? channel.kind === "voice" ? "headphones" : "message-square" : conversation?.kind === "group" ? "users-round" : "user-round");
  updateComposerState();
  renderConversations();
  renderChannels();
  const wasSidebarOpen = chatLayout.classList.contains("mobile-sidebar-open") && window.matchMedia("(max-width: 760px)").matches;
  setMobileSidebar(false);
  hideMentionSuggestions();
  hideEmojiSuggestions();
  hideMacroSuggestions();
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
    // Start the network requests together, but don't make the local cache wait
    // for the member list or device-key exchange before rendering.
    const initialHistoryPromise = isVoiceRoom
      ? Promise.resolve(undefined)
      : api.messages(conversationId, { limit: MESSAGE_PAGE_SIZE }).catch(() => undefined);
    const membersPromise = api.conversationMembers(conversationId);
    const cached = currentUser && !isVoiceRoom
      ? await readCachedMessages(currentUser.id, conversationId)
      : [];
    if (token !== selectionToken) return;
    if (cached.length > 0) {
      loadedMessages = sortMessages(cached).slice(-MAX_RENDERED_MESSAGES);
      nextBefore = null;
      nextAfter = null;
      latestObservedSequence = null;
      observeLatestMessages(loadedMessages);
      lastMessagesKey = messagesKey();
      conversationSubtitle.textContent = "Showing cached encrypted history · syncing";
      await renderMessageHistory({ scrollToBottom: true });
    }
    // This first sync may need the network, so only queue it after rendering
    // cached messages with the locally stored room keys.
    void cryptoClient.syncToDevice().catch(() => undefined);
    const members = await membersPromise;
    if (token !== selectionToken) return;
    selectedMembers = members.members.map((member) => ({ ...member, roleIds: normalizeRoleIds(member.roleIds) }));
    renderMembers(selectedMembers);
    conversationSubtitle.textContent = isVoiceRoom
      ? `${selectedMembers.length} member${selectedMembers.length === 1 ? "" : "s"} · voice room · end-to-end encrypted`
      : `${selectedMembers.length} member${selectedMembers.length === 1 ? "" : "s"} · end-to-end encrypted`;
    await cryptoClient.prepareConversation(conversationId, selectedMembers);
    if (token !== selectionToken) return;
    const [initialHistory] = await Promise.all([
      initialHistoryPromise,
      cryptoClient.syncToDevice().catch(() => undefined),
    ]);
    if (token !== selectionToken) return;
    // Cache is already on screen. Rebuild only when the early render found
    // missing room keys that the completed to-device sync may have supplied.
    if (cached.length > 0 && unavailableMessageNotices.size > 0) {
      const wasAtLatest = isAtLatestMessage();
      const scrollAnchor = wasAtLatest ? null : captureScrollAnchor();
      const scrollTop = messagesPanel.scrollTop;
      await renderMessageHistory({
        scrollAnchor: scrollAnchor ?? undefined,
        scrollToBottom: wasAtLatest,
      });
      if (!wasAtLatest && !scrollAnchor) messagesPanel.scrollTop = scrollTop;
    }
    conversationReady = true;
    updateComposerState();
    updateVoiceCallButton();
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
        const welcome = metadata.welcome && typeof metadata.welcome === "object" && !Array.isArray(metadata.welcome)
          ? metadata.welcome as Record<string, unknown>
          : undefined;
        activeServerWelcome = welcome ? {
          enabled: welcome.enabled === true,
          heading: typeof welcome.heading === "string" ? welcome.heading.slice(0, 120) : "",
          description: typeof welcome.description === "string" ? welcome.description.slice(0, 500) : "",
          rules: typeof welcome.rules === "string" ? welcome.rules.slice(0, 2_000) : "",
          acknowledgement: welcome.acknowledgement === true,
        } : undefined;
      } catch {
        // See the channel metadata note above.
        activeServerWelcome = undefined;
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
    if (!isVoiceRoom) await refreshMessages({ forceScrollToBottom: true, initialPage: initialHistory });
    if (token !== selectionToken) return;
    if (messageTarget) await scrollToMessage(messageTarget);
    if (wasSidebarOpen) {
      if (isVoiceRoom) voiceRoomJoinButton.focus();
      else messageInput.focus();
    }
  } catch (error) {
    if (token !== selectionToken) return;
    const canSend = conversationReady;
    updateComposerState();
    if (loadedMessages.length > 0) {
      conversationSubtitle.textContent = "Showing locally cached encrypted history";
      // The cache has already been rendered; don't tear it down again if a
      // later metadata/network step failed without changing the message set.
      if (lastMessagesKey !== messagesKey()) await renderMessageHistory({ scrollToBottom: true });
    } else {
      conversationSubtitle.textContent = canSend ? "Message history unavailable" : "Could not load this conversation";
      renderConversationWelcome(canSend ? "History unavailable" : "Unable to open conversation", canSend
        ? "Check your connection to load history. You can still queue encrypted messages on this device."
        : "Check your connection and select this conversation again to retry.");
    }
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
  const article = [...messagesPanel.querySelectorAll<HTMLElement>(".message")]
    .find((candidate) => candidate.dataset.messageId === messageId);
  if (article?.classList.contains("media-album-member")) {
    const albumId = article.dataset.mediaAlbumId;
    return albumId
      ? [...messagesPanel.querySelectorAll<HTMLElement>(`.message[data-media-album-id="${CSS.escape(albumId)}"]`)]
        .find((candidate) => !candidate.classList.contains("media-album-member")) ?? article
      : article;
  }
  return article;
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
  const mediaTile = [...messagesPanel.querySelectorAll<HTMLElement>(".media-album-tile")]
    .find((tile) => tile.dataset.messageId === messageId);
  if (mediaTile) {
    releaseMediaResources(mediaTile);
    mediaTile.replaceChildren();
    const deleted = document.createElement("span");
    deleted.className = "message-deleted muted";
    deleted.textContent = "Deleted";
    mediaTile.append(deleted);
    mediaTile.classList.add("media-album-tile-deleted");
    mediaTile.querySelector<HTMLElement>(".message-actions")?.remove();
    return;
  }
  const article = [...messagesPanel.querySelectorAll<HTMLElement>(".message")]
    .find((candidate) => candidate.dataset.messageId === messageId);
  const content = article?.querySelector<HTMLElement>(".message-content");
  const header = content?.querySelector<HTMLElement>(".message-meta");
  if (!article || !content || !header) return;
  releaseMediaResources(article);
  article.querySelector<HTMLElement>(".message-actions")?.remove();
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
  const controls = document.createElement("div");
  controls.className = "message-actions-controls";
  const reaction = document.createElement("button");
  reaction.className = "message-action";
  reaction.type = "button";
  reaction.append(iconElement("smile"));
  reaction.title = "Add reaction";
  reaction.setAttribute("aria-label", `Add reaction to message from ${sender}`);
  reaction.addEventListener("click", (event) => {
    event.stopPropagation();
    const article = parent.closest<HTMLElement>(".message");
    if (!article) return;
    const rect = reaction.getBoundingClientRect();
    openMessageContextMenu({ message, article, sender, body, editable }, rect.left, rect.bottom + 4);
  });
  controls.append(reaction);

  if (editable) {
    const edit = document.createElement("button");
    edit.className = "message-action";
    edit.type = "button";
    edit.append(iconElement("pencil"));
    edit.title = "Edit";
    edit.setAttribute("aria-label", "Edit");
    edit.addEventListener("click", () => {
      parent.closest<HTMLElement>(".message")?.classList.remove("message-actions-open");
      setEditTarget({ messageId: message.id, sender, body });
    });
    controls.append(edit);
  }

  const reply = document.createElement("button");
  reply.className = "message-action";
  reply.type = "button";
  reply.append(iconElement("corner-up-left"));
  reply.title = "Reply";
  reply.setAttribute("aria-label", "Reply");
  reply.addEventListener("click", () => {
    parent.closest(".message")?.classList.remove("message-actions-open");
    setReplyTarget(replyReferenceForMessage(message, sender, body || "Encrypted message"));
  });
  controls.append(reply);

  const menu = document.createElement("button");
  menu.className = "message-action message-action-menu";
  menu.type = "button";
  menu.append(iconElement("more-horizontal"));
  menu.title = "Message actions";
  menu.setAttribute("aria-label", `Actions for message from ${sender}`);
  menu.setAttribute("aria-expanded", "false");
  menu.setAttribute("aria-haspopup", "menu");
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
    const article = parent.closest<HTMLElement>(".message");
    if (!article) return;
    article.classList.add("message-actions-open");
    menu.setAttribute("aria-expanded", "true");
    const rect = menu.getBoundingClientRect();
    openMessageContextMenu({ message, article, sender, body, editable }, rect.right, rect.bottom + 4);
  });
  controls.append(menu);
  actions.append(controls);
  parent.append(actions);
  renderIcons(actions);
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
  const tile = event.target instanceof Element ? event.target.closest<HTMLElement>(".media-album-tile") : null;
  const messageId = tile?.dataset.messageId ?? target?.dataset.messageId;
  const contextTarget = messageId ? messageContextTargets.get(messageId) : undefined;
  if (!contextTarget) return;
  event.preventDefault();
  openMessageContextMenu(contextTarget, event.clientX, event.clientY);
});

document.addEventListener("pointerdown", (event) => {
  if (!messageContextMenu.hidden && event.target instanceof Node && !messageContextMenu.contains(event.target)) closeMessageContextMenu();
  if (!navigationContextMenu.hidden && event.target instanceof Node && !navigationContextMenu.contains(event.target)) closeNavigationContextMenu();
  if (!emojiPicker.hidden && event.target instanceof Node && !emojiPicker.contains(event.target) && event.target !== emojiToggle) closeEmojiPicker();
  if (!gifPicker.hidden && event.target instanceof Node && !gifPicker.contains(event.target) && event.target !== gifToggle) closeGifPicker();
  if (!emojiSuggestions.hidden && event.target instanceof Node && !emojiSuggestions.contains(event.target) && event.target !== messageInput) hideEmojiSuggestions();
  if (!mentionSuggestions.hidden && event.target instanceof Node && !mentionSuggestions.contains(event.target) && event.target !== messageInput) hideMentionSuggestions();
  if (!macroSuggestions.hidden && event.target instanceof Node && !macroSuggestions.contains(event.target) && event.target !== messageInput) hideMacroSuggestions();
});
window.addEventListener("resize", closeMessageContextMenu);
window.addEventListener("resize", closeNavigationContextMenu);
messagesPanel.addEventListener("scroll", closeMessageContextMenu, { passive: true });
channelList.addEventListener("scroll", closeNavigationContextMenu, { passive: true });

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
    icon.append(iconElement("key-round"));
    const copy = document.createElement("div");
    const heading = document.createElement("strong");
    heading.className = "unavailable-history-title";
    const explanation = document.createElement("p");
    explanation.textContent = "These messages are still encrypted, but this browser doesn't have the keys to read them. Your passphrase can't restore missing keys. Try the browser you used before.";
    copy.append(heading, explanation);
    notice.append(icon, copy);
    messagesPanel.append(notice);
    renderIcons(notice);
  }
  const count = Number(notice.dataset.count ?? "0") + 1;
  notice.dataset.count = String(count);
  notice.querySelector<HTMLElement>(".unavailable-history-title")!.textContent =
    `${count} message${count === 1 ? " is" : "s are"} locked on this device`;
  unavailableMessageNotices.set(messageId, notice);
}

function appendDownloadButton(parent: HTMLElement, url: string, filename: string) {
  const download = document.createElement("a");
  download.className = "media-file-download";
  download.href = url;
  download.download = filename || "encrypted-file.bin";
  download.title = `Download ${filename || "file"}`;
  download.setAttribute("aria-label", `Download ${filename || "file"}`);
  download.append(iconElement("download"));
  renderIcons(download);
  parent.append(download);
}

function mediaAlbumFromContent(content: Record<string, unknown>): MediaAlbumInfo | undefined {
  const value = content.album;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const album = value as Record<string, unknown>;
  if (typeof album.id !== "string" || album.id.length === 0 || album.id.length > 120) return undefined;
  if (!Number.isInteger(album.index) || !Number.isInteger(album.total)) return undefined;
  const index = album.index as number;
  const total = album.total as number;
  if (index < 0 || total < 2 || index >= total || total > 20) return undefined;
  return { id: album.id, index, total };
}

function mediaAttachmentsFromContent(content: Record<string, unknown>) {
  if (content.msgtype === "m.attachments") {
    return Array.isArray(content.attachments)
      ? content.attachments.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)))
      : [];
  }
  return content.msgtype === "m.image" || content.msgtype === "m.video" || content.msgtype === "m.file" ? [content] : [];
}

function isVisualMediaContent(content: Record<string, unknown>) {
  const info = content.info && typeof content.info === "object" && !Array.isArray(content.info) ? content.info as Record<string, unknown> : {};
  const mimeType = typeof info.mimetype === "string" ? info.mimetype.toLowerCase() : "";
  const filename = typeof content.filename === "string" ? content.filename : "";
  return !isPlaintextAttachment(filename, mimeType)
    && (content.msgtype === "m.image" || content.msgtype === "m.video" || mimeType.startsWith("image/") || mimeType.startsWith("video/"));
}

function appendEncryptedMedia(
  parent: HTMLElement,
  content: Record<string, unknown>,
  filename: string,
  fileMessage: boolean,
  videoMessage: boolean,
  album?: MediaAlbumInfo,
) {
  const info = content.info && typeof content.info === "object" && !Array.isArray(content.info) ? content.info as Record<string, unknown> : {};
  const mimeType = typeof info.mimetype === "string" ? info.mimetype : "application/octet-stream";
  const isText = isPlaintextAttachment(filename, mimeType);
  const isVideo = !isText && (videoMessage || mimeType.toLowerCase().startsWith("video/"));
  const isImage = !isText && !isVideo && (content.msgtype === "m.image" || mimeType.toLowerCase().startsWith("image/"));
  const isVisual = isImage || isVideo;
  const isSpoiler = content.spoiler === true;
  const mediaWidth = typeof info.w === "number" && Number.isFinite(info.w) && info.w > 0 ? info.w : undefined;
  const mediaHeight = typeof info.h === "number" && Number.isFinite(info.h) && info.h > 0 ? info.h : undefined;
  const kindLabel = isText ? "text file" : fileMessage ? "file" : isVideo ? "video" : "image";
  const attachmentSize = typeof info.size === "number" && Number.isFinite(info.size) ? info.size : undefined;
  const size = attachmentSize === undefined ? "" : ` · ${fileSizeLabel(attachmentSize)}`;
  const card = document.createElement("div");
  card.className = `encrypted-media-card ${isVisual ? "media-attachment-card" : "file-attachment-card"}${isText ? " text-attachment-card" : ""}`;
  card.dataset.mediaFilename = filename;
  if (isVisual && mediaWidth && mediaHeight) card.style.aspectRatio = `${mediaWidth} / ${mediaHeight}`;
  if (album) {
    card.dataset.mediaAlbumId = album.id;
    card.dataset.mediaAlbumIndex = String(album.index);
  }
  let revealed = !isSpoiler;
  let loadedBlob: Blob | undefined;
  let loadPromise: Promise<Blob | undefined> | undefined;
  let mediaProgress: HTMLProgressElement | undefined;
  let mediaStatus: HTMLElement | undefined;
  const shouldAutoPreviewText = isText && attachmentSize !== undefined && attachmentSize <= MAX_AUTO_TEXT_PREVIEW_BYTES;

  const renderPending = (failure?: string) => {
    card.replaceChildren();
    card.classList.remove("media-loaded");
    card.classList.toggle("encrypted-media-spoiler", isSpoiler && !revealed);
    mediaProgress = undefined;
    mediaStatus = undefined;

    if (isVisual) {
      if (!revealed) {
        const placeholder = document.createElement("div");
        placeholder.className = "media-placeholder media-spoiler-placeholder";
        const mark = document.createElement("span");
        mark.textContent = isVideo ? "VIDEO" : "IMAGE";
        mediaStatus = document.createElement("span");
        mediaStatus.className = "media-loading-label";
        mediaStatus.textContent = failure ? `Blurred preview unavailable · ${failure}` : "Preparing blurred preview…";
        placeholder.append(mark, mediaStatus);
        card.append(placeholder, createMediaSpoilerCover());
        mediaProgress = document.createElement("progress");
        mediaProgress.className = "media-load-progress";
        mediaProgress.max = 100;
        mediaProgress.removeAttribute("value");
        mediaProgress.hidden = true;
        card.append(mediaProgress);
        return;
      }
      const placeholder = document.createElement("div");
      placeholder.className = "media-placeholder";
      const mark = document.createElement("span");
      mark.textContent = isVideo ? "VIDEO" : "IMAGE";
      placeholder.append(mark);
      mediaStatus = document.createElement("span");
      mediaStatus.className = "media-loading-label";
      const clickToLoad = !appPreferences.autoLoadMedia && !isSpoiler;
      mediaStatus.textContent = failure
        ? `Unavailable · ${failure}`
        : clickToLoad ? "Encrypted preview not loaded" : "Loading…";
      placeholder.append(mediaStatus);
      card.append(placeholder);
      if (clickToLoad && !failure) {
        const load = document.createElement("button");
        load.type = "button";
        load.className = "media-load-button secondary";
        load.textContent = `Load ${isVideo ? "video" : "image"}`;
        load.addEventListener("click", () => void loadMedia());
        placeholder.append(load);
      }
      if (failure) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "media-retry-button";
        retry.textContent = "Retry";
        retry.addEventListener("click", () => void loadMedia());
        card.append(retry);
      }
      mediaProgress = document.createElement("progress");
      mediaProgress.className = "media-load-progress";
      mediaProgress.max = 100;
      mediaProgress.removeAttribute("value");
      mediaProgress.hidden = true;
      card.append(mediaProgress);
      return;
    }

    const row = document.createElement("div");
    row.className = "file-attachment-row";
    const mark = document.createElement("span");
    mark.className = "file-attachment-mark";
    mark.textContent = isText ? "TXT" : "FILE";
    const copy = document.createElement("div");
    copy.className = "file-attachment-copy";
    const title = document.createElement("strong");
    title.textContent = revealed ? (filename || `Encrypted ${kindLabel}`) : "Spoiler attachment";
    const meta = document.createElement("span");
    meta.textContent = revealed ? `${isText ? textLanguage(filename, mimeType) : kindLabel}${size}` : "Hidden until revealed";
    copy.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "file-attachment-actions";
    if (!revealed) {
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "secondary";
      reveal.textContent = "Reveal";
      reveal.addEventListener("click", () => {
        revealed = true;
        renderPending();
        void loadMedia();
      });
      actions.append(reveal);
    } else {
      if (!isText || !shouldAutoPreviewText) {
        const load = document.createElement("button");
        load.type = "button";
        load.className = "secondary";
        load.textContent = isText ? "Load preview" : "Prepare";
        load.addEventListener("click", () => void loadMedia());
        actions.append(load);
      }
    }
    if (failure) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "secondary";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => void loadMedia());
      actions.append(retry);
    }
    row.append(mark, copy, actions);
    card.append(row);
    if (isText && revealed) {
      const previewState = document.createElement("div");
      previewState.className = "text-attachment-state";
      previewState.textContent = failure
        ? "Preview unavailable"
        : shouldAutoPreviewText ? "Preview will load when visible" : "Preview not loaded";
      card.append(previewState);
    }
  };

  const revealSpoiler = () => {
    if (revealed) return;
    revealed = true;
    if (loadedBlob) {
      card.classList.remove("encrypted-media-spoiler");
      card.querySelector(".media-spoiler-cover")?.remove();
      const image = card.querySelector<HTMLImageElement>("img.media-preview");
      if (image) image.alt = filename || "Encrypted image";
      return;
    }
    renderPending();
    void loadMedia();
  };

  const createMediaSpoilerCover = () => {
    const cover = document.createElement("button");
    cover.type = "button";
    cover.className = "media-spoiler-cover";
    cover.setAttribute("aria-label", `Reveal ${kindLabel} spoiler`);
    const label = document.createElement("span");
    label.textContent = "Reveal";
    cover.append(label);
    cover.addEventListener("click", revealSpoiler);
    return cover;
  };

  const loadMedia = (): Promise<Blob | undefined> => {
    if (loadPromise) return loadPromise;
    if (!card.isConnected) return Promise.resolve(undefined);
    const activeCryptoClient = cryptoClient;
    if (!activeCryptoClient) return Promise.resolve(undefined);
    const preserveLatestPosition = isVisual && isAtLatestMessage();
    const requestController = new AbortController();
    pendingMediaLoads.set(card, requestController);
    if (mediaStatus) mediaStatus.textContent = "Loading…";
    const textStatus = card.querySelector<HTMLElement>(".text-attachment-state");
    if (textStatus) textStatus.textContent = "Decrypting secure preview…";
    if (mediaProgress) mediaProgress.hidden = false;
    for (const button of card.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
    loadPromise = (async () => {
      try {
        const blob = await activeCryptoClient.decryptMedia(content, {
          signal: requestController.signal,
          onProgress: (loadedBytes, totalBytes) => {
            if (!card.isConnected || requestController.signal.aborted) return;
            if (mediaStatus) mediaStatus.textContent = totalBytes > 0
              ? `Loading · ${Math.round((loadedBytes / totalBytes) * 100)}%`
              : "Loading…";
            if (mediaProgress && totalBytes > 0) mediaProgress.value = Math.round((loadedBytes / totalBytes) * 100);
          },
        });
        if (!blob) throw new Error("crypto_not_initialized");
        if (!card.isConnected || requestController.signal.aborted) return undefined;
        loadedBlob = blob;
        controller.blob = blob;
        const url = URL.createObjectURL(blob);
        card.dataset.mediaUrl = url;
        card.classList.add("media-loaded");
        const concealedSpoiler = isSpoiler && !revealed;
        card.replaceChildren();
        card.classList.toggle("encrypted-media-spoiler", concealedSpoiler);
        if (isText || fileMessage && !isVisual) {
          const row = document.createElement("div");
          row.className = "file-attachment-row";
          const mark = document.createElement("span");
          mark.className = "file-attachment-mark";
          mark.textContent = isText ? "TXT" : "FILE";
          const copy = document.createElement("div");
          copy.className = "file-attachment-copy";
          const title = document.createElement("strong");
          title.textContent = filename || "Encrypted file";
          const meta = document.createElement("span");
          meta.textContent = `${isText ? textLanguage(filename, mimeType) : "File"}${size}`;
          copy.append(title, meta);
          const actions = document.createElement("div");
          actions.className = "file-attachment-actions";
          appendDownloadButton(actions, url, filename);
          row.append(mark, copy, actions);
          card.append(row);
          if (isText) {
            const preview = await readTextPreview(blob);
            const fullPreviewText = preview.truncated
              ? preview.text.replace(/\n\n\[Preview truncated after \d+ KiB\.\]$/, "")
              : preview.text;
            const excerpt = textPreviewExcerpt(fullPreviewText);
            const previewPanel = document.createElement("div");
            previewPanel.className = "text-attachment-preview";
            previewPanel.tabIndex = 0;
            previewPanel.setAttribute("role", "region");
            previewPanel.setAttribute("aria-label", `${filename || "Text file"} preview excerpt`);
            const previewText = document.createElement("pre");
            previewText.className = "text-attachment-preview-content";
            renderHighlightedCode(previewText, excerpt.text, textLanguage(filename, mimeType));
            previewPanel.append(previewText);
            const footer = document.createElement("div");
            footer.className = "text-attachment-footer";
            const more = document.createElement("span");
            more.className = "text-attachment-more";
            more.textContent = preview.truncated
              ? "Preview limited to first 512 KiB"
              : excerpt.remainingCharacters > 0
                ? `${excerpt.remainingCharacters.toLocaleString()} ${excerpt.remainingCharacters === 1 ? "character" : "characters"} more`
                : `${fullPreviewText.length.toLocaleString()} characters · complete file`;
            const expand = document.createElement("button");
            expand.type = "button";
            expand.className = "text-attachment-expand";
            expand.title = "Expand text preview";
            expand.setAttribute("aria-label", "Expand text preview");
            expand.append(iconElement("expand"));
            expand.addEventListener("click", () => void openTextViewer(blob, filename, mimeType));
            footer.append(more, expand);
            card.append(previewPanel, footer);
            renderIcons(expand);
          }
        } else {
          const preview = document.createElement(isVideo ? "video" : "img");
          preview.className = `media-preview${isVideo ? " video" : ""}`;
          preview.src = url;
          preview.tabIndex = 0;
          preview.setAttribute("role", "button");
          preview.setAttribute("aria-label", `Open ${isVideo ? "video" : "image"}${filename ? ` ${filename}` : ""}`);
          const open = () => void openMediaViewerForCard(card);
          preview.addEventListener("click", open);
          preview.addEventListener("keydown", (event) => {
            const keyboardEvent = event as KeyboardEvent;
            if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
            keyboardEvent.preventDefault();
            open();
          });
          if (isVideo) {
            const player = preview as HTMLVideoElement;
            player.muted = true;
            player.playsInline = true;
            player.preload = concealedSpoiler ? "auto" : "metadata";
            const playMark = document.createElement("span");
            playMark.className = "media-play-mark";
            playMark.setAttribute("aria-hidden", "true");
            playMark.textContent = "▶";
            card.append(preview, playMark);
          } else {
            (preview as HTMLImageElement).alt = concealedSpoiler ? "Blurred image spoiler" : filename || "Encrypted image";
            (preview as HTMLImageElement).loading = "eager";
            card.append(preview);
          }
          const actions = document.createElement("div");
          actions.className = "media-card-actions";
          appendDownloadButton(actions, url, filename);
          card.append(actions);
          if (concealedSpoiler) card.append(createMediaSpoilerCover());
        }
        if (preserveLatestPosition) scrollToLatest();
        return blob;
      } catch (error) {
        if (!card.isConnected || requestController.signal.aborted) return undefined;
        loadPromise = undefined;
        renderPending(readableError(error));
        return undefined;
      } finally {
        pendingMediaLoads.delete(card);
      }
    })();
    return loadPromise;
  };

  const controller: MediaCardController = {
    filename,
    video: isVideo,
    spoiler: isSpoiler,
    isRevealed: () => revealed,
    reveal: () => {
      revealSpoiler();
    },
    load: () => loadMedia(),
    get blob() {
      return loadedBlob;
    },
    set blob(value: Blob | undefined) {
      loadedBlob = value;
    },
  };
  mediaCardControllers.set(card, controller);
  renderPending();
  parent.append(card);
  if (isVisual && (revealed || isSpoiler) && (appPreferences.autoLoadMedia || isSpoiler)
    || shouldAutoPreviewText && revealed) {
    const autoLoad = async () => { await loadMedia(); };
    registerAutoMediaLoad(card, autoLoad);
    if (isVisual && isSpoiler && typeof IntersectionObserver !== "undefined") {
      window.requestAnimationFrame(() => {
        if (!card.isConnected || autoMediaLoadTargets.get(card) !== autoLoad) return;
        const cardBounds = card.getBoundingClientRect();
        const panelBounds = messagesPanel.getBoundingClientRect();
        if (cardBounds.bottom < panelBounds.top - 420 || cardBounds.top > panelBounds.bottom + 420) return;
        autoMediaLoadTargets.delete(card);
        autoMediaLoadObserver?.unobserve(card);
        queueAutoMediaLoad(autoLoad);
      });
    }
  }
  return card;
}

function collapseMediaAlbums() {
  const groups = new Map<string, HTMLElement[]>();
  for (const article of messagesPanel.querySelectorAll<HTMLElement>(".message[data-media-album-id]")) {
    const albumId = article.dataset.mediaAlbumId;
    if (!albumId) continue;
    const group = groups.get(albumId) ?? [];
    group.push(article);
    groups.set(albumId, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((left, right) => Number(left.dataset.mediaAlbumIndex) - Number(right.dataset.mediaAlbumIndex));
    const root = ordered.find((article) => !article.classList.contains("media-album-member")) ?? ordered[0];
    const content = root.querySelector<HTMLElement>(".message-content");
    const header = content?.querySelector<HTMLElement>(".message-meta");
    if (!content || !root || !header) continue;
    let album = content.querySelector<HTMLElement>(":scope > .media-album");
    if (!album) {
      album = document.createElement("div");
      album.className = "media-album";
      album.dataset.mediaAlbumId = root.dataset.mediaAlbumId ?? "";
      header.insertAdjacentElement("afterend", album);
    }

    const filenames: string[] = [];
    for (const source of ordered) {
      const messageId = source.dataset.messageId;
      if (!messageId) continue;
      const existingTile = [...album.querySelectorAll<HTMLElement>(".media-album-tile")]
        .find((tile) => tile.dataset.messageId === messageId);
      const cards = [...source.querySelectorAll<HTMLElement>(".encrypted-media-card")]
        .filter((card) => card.closest(".media-album") !== album);
      const card = cards[0];
      const action = source.querySelector<HTMLElement>(":scope > .message-actions");
      const tile = existingTile ?? document.createElement("div");
      tile.className = "media-album-tile";
      tile.dataset.messageId = messageId;
      tile.dataset.albumIndex = source.dataset.mediaAlbumIndex ?? "0";
      if (card && !tile.contains(card)) tile.append(card);
      tile.querySelector<HTMLElement>(".message-actions")?.remove();
      if (source !== root) action?.remove();
      if (!existingTile) album.append(tile);
      const filename = source.querySelector<HTMLElement>(".encrypted-media-card")?.dataset.mediaFilename;
      if (filename) filenames.push(filename);
      if (source !== root) {
        source.classList.add("media-album-member");
        source.replaceChildren();
      }
    }
    for (const tile of [...album.querySelectorAll<HTMLElement>(":scope > .media-album-tile")]
      .sort((left, right) => Number(left.dataset.albumIndex) - Number(right.dataset.albumIndex))) {
      album.append(tile);
    }
    root.classList.add("media-album-root");
    root.dataset.search = [root.dataset.search, ...filenames].filter(Boolean).join(" ");
  }
}

function renderMessage(
  message: MessageEnvelope,
  decrypted: { sender: string; content: Record<string, unknown> } | null,
  error?: string,
  options: { grouped: boolean; animate?: boolean } = { grouped: false },
): boolean {
  const wasRealtimeMessage = pendingMentionNotifications.delete(message.id);
  const article = document.createElement("article");
  article.className = "message";
  article.classList.toggle("message-own", isOwnMessage(message));
  if (options.grouped) article.classList.add("message-compact");
  if (options.animate) {
    article.classList.add("message-entering");
    article.addEventListener("animationend", () => article.classList.remove("message-entering"), { once: true });
  }
  const senderIdentity = senderLabel(message, decrypted);
  const edited = editedMessageBodies.get(message.id);
  const originalBody = decrypted && typeof decrypted.content.body === "string" ? decrypted.content.body : "";
  const body = edited?.body ?? originalBody;
  const storedEmbeds = normalizeStoredEmbeds(decrypted?.content.embeds);
  const effectiveEmbeds = externalPreviewsEnabled()
    ? edited?.embeds ?? (storedEmbeds.length > 0 ? storedEmbeds : extractEmbeds(body))
    : [];
  const effectiveMentions = edited?.mentions ?? (Array.isArray(decrypted?.content.mentions)
    ? decrypted.content.mentions.filter((value): value is string => typeof value === "string")
    : []);
  const effectiveRoleMentions = edited?.roleMentions ?? (Array.isArray(decrypted?.content.roleMentions)
    ? decrypted.content.roleMentions.filter((value): value is string => typeof value === "string")
    : []);
  article.dataset.messageId = message.id;
  article.id = `message-${message.id}`;
  article.dataset.search = `${senderIdentity} ${searchableMessageBody(body)} ${error ?? ""}`.toLowerCase();
  article.dataset.senderKey = senderKey(message, decrypted);
  article.dataset.createdAt = message.createdAt;
  article.dataset.groupBreak = String(messageBreaksGrouping(decrypted));
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.setAttribute("aria-hidden", "true");
  const senderMember = message.senderUserId ? selectedMembers.find((member) => member.userId === message.senderUserId) : undefined;
  renderAvatar(avatar, senderIdentity, senderKey(message, decrypted), senderMember?.avatarUrl ?? (message.senderUserId === currentUser?.id ? currentUser.avatarUrl : null));
  const messageContent = document.createElement("div");
  messageContent.className = "message-content";
  const header = document.createElement("header");
  header.className = "message-meta";
  const sender = document.createElement("button");
  sender.className = "message-sender-link";
  sender.type = "button";
  sender.textContent = senderIdentity;
  const senderRole = highestServerRole(senderMember?.roleIds);
  if (senderRole?.color) setRoleTextColor(sender, senderRole.color);
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
    const storedEmbeds = normalizeStoredEmbeds(content.embeds);
     const embeds = externalPreviewsEnabled()
       ? storedEmbeds.length > 0 ? storedEmbeds : extractEmbeds(content.body)
       : [];
    const mentions = Array.isArray(content.mentions) ? content.mentions.filter((value): value is string => typeof value === "string") : [];
    const roleMentions = Array.isArray(content.roleMentions) ? content.roleMentions.filter((value): value is string => typeof value === "string") : [];
    applyEditedBody(content.replaces, content.body, embeds, mentions, roleMentions);
    return false;
  }
  const redactionAuthor = redactionAuthors.get(message.id);
  if (redactionAuthor !== undefined && redactionAuthor && message.senderUserId && redactionAuthor !== message.senderUserId) {
    redactedMessageIds.delete(message.id);
    redactionAuthors.delete(message.id);
  }
  if (redactedMessageIds.has(message.id)) appendDeletedMessage(messageContent);
  const mediaAttachments = mediaAttachmentsFromContent(content);
  const mediaMessage = mediaAttachments.length > 0;
  const mediaAlbum = mediaMessage ? mediaAlbumFromContent(content) : undefined;
  article.classList.toggle("message-emoji-only", !mediaMessage && isEmojiOnlyMessage(body));
  const mentionNames = new Set(selectedMembers.filter((member) => effectiveMentions.includes(member.userId)).map((member) => member.username.toLowerCase()));
  const mentionRoleNames = new Set(effectiveRoleMentions
    .map((roleId) => serverRoles.find((role) => role.id === roleId))
    .filter((role): role is CustomServerRole => role !== undefined && role.systemKey !== "owner")
    .map(serverRoleSlug));
  const mentionsCurrentUser = messageMentionsCurrentUser(effectiveMentions, effectiveRoleMentions);
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
      if (unreadMarkers.has(message.conversationId)) notifyNewMessage(message.conversationId, message.id, true, true);
      renderUnreadButton();
    }
  }
  if (!redactedMessageIds.has(message.id) && (!mediaMessage || body) && (content.msgtype === "m.text" || content.msgtype === "m.notice" || body)) {
    appendMarkdown(messageContent, body, {
      mentionUsernames: mentionNames,
      mentionRoleNames,
      customEmoji: customEmojiAssets,
      roomReferences: roomReferenceMap(),
      hideBareLinks: embeddedImageLinks(effectiveEmbeds),
      onRoomReference: (channelId) => void selectChannel(channelId),
    });
    for (const embed of effectiveEmbeds) appendSafeEmbed(messageContent, embed, openExternalImageViewer);
  }
  if (edited) {
    const editedLabel = document.createElement("span");
    editedLabel.className = "edited-label";
    editedLabel.textContent = "(edited)";
    header.append(editedLabel);
  }

  if (!redactedMessageIds.has(message.id) && mediaMessage) {
    const visualAttachments = mediaAttachments.filter(isVisualMediaContent);
    const otherAttachments = mediaAttachments.filter((attachment) => !isVisualMediaContent(attachment));
    if (visualAttachments.length > 1) {
      const album = document.createElement("div");
      album.className = "media-album";
      for (const attachment of visualAttachments) {
        const fileMessage = attachment.msgtype === "m.file";
        const video = attachment.msgtype === "m.video";
        const filename = typeof attachment.filename === "string" ? attachment.filename : "";
        const tile = document.createElement("div");
        tile.className = "media-album-tile";
        appendEncryptedMedia(tile, attachment, filename, fileMessage, video);
        album.append(tile);
      }
      messageContent.append(album);
    } else {
      for (const attachment of visualAttachments) {
        const fileMessage = attachment.msgtype === "m.file";
        const video = attachment.msgtype === "m.video";
        const filename = typeof attachment.filename === "string" ? attachment.filename : "";
        appendEncryptedMedia(messageContent, attachment, filename, fileMessage, video);
      }
    }
    for (const attachment of otherAttachments) {
      const fileMessage = attachment.msgtype === "m.file";
      const video = attachment.msgtype === "m.video";
      const filename = typeof attachment.filename === "string" ? attachment.filename : "";
      appendEncryptedMedia(messageContent, attachment, filename, fileMessage, video);
    }
    if (mediaAlbum && (content.msgtype === "m.image" || content.msgtype === "m.video")) {
      article.dataset.mediaAlbumId = mediaAlbum.id;
      article.dataset.mediaAlbumIndex = String(mediaAlbum.index);
      article.dataset.mediaAlbumTotal = String(mediaAlbum.total);
    }
  }

  const reply = replyReferenceFromContent(content);
  if (reply) {
    const replyContext = document.createElement("button");
    replyContext.className = "reply-context";
    replyContext.type = "button";
    replyContext.title = "Jump to replied message";
    const replyLabel = document.createElement("span");
    replyLabel.textContent = `${reply.sender}: ${formatMessageMacrosAsText(reply.body || "Encrypted message").replace(/\s+/g, " ").slice(0, 180)}`;
    replyContext.append(iconElement("corner-up-left"), replyLabel);
    renderIcons(replyContext);
    replyContext.addEventListener("click", () => void scrollToMessage(reply.messageId));
    article.insertBefore(replyContext, avatar);
  }
  const editable = !mediaMessage && (content.msgtype === "m.text" || content.msgtype === "m.notice" || Boolean(body)) && isOwnMessage(message);
  if (!redactedMessageIds.has(message.id)) appendMessageActions(article, message, senderIdentity, body, editable);

  if (!redactedMessageIds.has(message.id)) {
    const target: ContextMessage = { message, article, sender: senderIdentity, body, editable };
    messageContextTargets.set(message.id, target);
  }
  messagesPanel.append(article);
  if (pinnedMessageIds.has(message.id)) applyPinEvent(message.id, "add");
  renderMessageReactions(message.id);
  return true;
}

function refreshRenderedMessageMarkdown() {
  const conversationId = selectedConversationId;
  if (!conversationId) return;
  const scrollAnchor = captureScrollAnchor();
  for (const message of loadedMessages) {
    const article = messagesPanel.querySelector<HTMLElement>(`.message[data-message-id="${CSS.escape(message.id)}"]`);
    const previousMarkdown = article?.querySelector<HTMLElement>(".markdown-body");
    if (!article || !previousMarkdown || redactedMessageIds.has(message.id)) continue;
    const decrypted = cachedDecryptedMessage(conversationId, message.id);
    if (!decrypted) continue;

    const content = decrypted.content;
    const edited = editedMessageBodies.get(message.id);
    const body = edited?.body ?? (typeof content.body === "string" ? content.body : "");
    const mediaMessage = mediaAttachmentsFromContent(content).length > 0;
    if ((mediaMessage && !body) || (content.msgtype !== "m.text" && content.msgtype !== "m.notice" && !body)) continue;

    const storedEmbeds = normalizeStoredEmbeds(content.embeds);
    const embeds = externalPreviewsEnabled()
      ? edited?.embeds ?? (storedEmbeds.length > 0 ? storedEmbeds : extractEmbeds(body))
      : [];
    const mentions = edited?.mentions ?? (Array.isArray(content.mentions)
      ? content.mentions.filter((value): value is string => typeof value === "string")
      : []);
    const roleMentions = edited?.roleMentions ?? (Array.isArray(content.roleMentions)
      ? content.roleMentions.filter((value): value is string => typeof value === "string")
      : []);
    const mentionNames = new Set(selectedMembers.filter((member) => mentions.includes(member.userId)).map((member) => member.username.toLowerCase()));
    const mentionRoleNames = new Set(roleMentions
      .map((roleId) => serverRoles.find((role) => role.id === roleId))
      .filter((role): role is CustomServerRole => role !== undefined && role.systemKey !== "owner")
      .map(serverRoleSlug));
    const replacement = document.createElement("div");
    appendMarkdown(replacement, body, {
      mentionUsernames: mentionNames,
      mentionRoleNames,
      customEmoji: customEmojiAssets,
      roomReferences: roomReferenceMap(),
      hideBareLinks: embeddedImageLinks(embeds),
      onRoomReference: (channelId) => void selectChannel(channelId),
    });
    const nextMarkdown = replacement.firstElementChild;
    if (nextMarkdown) previousMarkdown.replaceWith(nextMarkdown);
  }
  applyMessageSearch();
  restoreScrollAnchor(scrollAnchor ?? undefined);
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
    const activeServer = selectedServerId ? servers.find((server) => server.id === selectedServerId) : undefined;
    const landingChannelId = activeServer?.landingChannelId ?? channels[0]?.id;
    if (activeServer && selectedChannelId === landingChannelId) renderServerWelcome();
    else renderConversationWelcome("This is the beginning", "Send a message to start this encrypted conversation.");
    return;
  }

  let previousDay = "";
  let previousGroup: MessageGroupState | undefined;
  for (let offset = 0; offset < loadedMessages.length; offset += MESSAGE_DECRYPT_BATCH_SIZE) {
    if (renderToken !== messageRenderToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    const batch = loadedMessages.slice(offset, offset + MESSAGE_DECRYPT_BATCH_SIZE);
    const decryptedMessages = await decryptMessagesForRender(conversationId, batch, activeCryptoClient);
    if (renderToken !== messageRenderToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    for (const message of batch) {
      const result = decryptedMessages.get(message.id);
      if (result?.error !== undefined && roomKeyUnavailable(result.error)) {
        appendUnavailableMessage(message.id);
        previousGroup = undefined;
        continue;
      }
      const decrypted = result?.decrypted ?? null;
      const error = result && result.error !== undefined ? readableError(result.error) : result ? undefined : "Encrypted message unavailable";
      const created = new Date(message.createdAt);
      const currentDay = dateKey(created);
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
    if (offset + batch.length < loadedMessages.length) await yieldToBrowser();
  }
  collapseMediaAlbums();
  applyMessageSearch();
  if (options.scrollAnchor) {
    restoreScrollAnchor(options.scrollAnchor);
  } else if (options.scrollToBottom !== false) {
    scrollToLatest();
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

  const newMessages = messages.filter((message) => !renderedMessageIds.has(message.id));
  for (let offset = 0; offset < newMessages.length; offset += MESSAGE_DECRYPT_BATCH_SIZE) {
    if (renderToken !== messageRenderToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    const batch = newMessages.slice(offset, offset + MESSAGE_DECRYPT_BATCH_SIZE);
    const decryptedMessages = await decryptMessagesForRender(conversationId, batch, activeCryptoClient);
    if (renderToken !== messageRenderToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    for (const message of batch) {
      renderedMessageIds.add(message.id);
      const result = decryptedMessages.get(message.id);
      if (result?.error !== undefined && roomKeyUnavailable(result.error)) {
        appendUnavailableMessage(message.id);
        previousGroup = undefined;
        continue;
      }
      const decrypted = result?.decrypted ?? null;
      const error = result && result.error !== undefined ? readableError(result.error) : result ? undefined : "Encrypted message unavailable";
      const created = new Date(message.createdAt);
      const currentDay = dateKey(created);
      const dayChanged = currentDay !== previousDay;
      const previousDayBeforeMessage = previousDay;
      let divider: HTMLElement | undefined;
      if (dayChanged) {
        divider = appendDateDivider(created);
        previousDay = currentDay;
      }
      const currentGroup = groupStateForMessage(message, decrypted);
      const grouped = shouldGroupMessage(previousGroup, currentGroup);
      const rendered = renderMessage(message, decrypted, error, { grouped, animate: true });
      if (!rendered) {
        divider?.remove();
        previousDay = previousDayBeforeMessage;
        continue;
      }
      previousGroup = currentGroup;
    }
    if (offset + batch.length < newMessages.length) await yieldToBrowser();
  }
  collapseMediaAlbums();
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
  scrollToLatest();
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

async function refreshMessages(options: { forceScrollToBottom?: boolean; initialPage?: MessagePage } = {}) {
  if (selectedChannelId && channels.some((channel) => channel.id === selectedChannelId && channel.kind === "voice")) return;
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
      const pagePromise = options.initialPage
        ? Promise.resolve(options.initialPage)
        : api.messages(conversationId, { limit: MESSAGE_PAGE_SIZE });
      const [result] = await Promise.all([
        pagePromise,
        syncPromise,
      ]);
      if (selection !== selectionToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
      const latestPage = sortMessages(result.messages).slice(-MAX_RENDERED_MESSAGES);
      if (canReconcileLatestMessagePage(loadedMessages, latestPage)) {
        const currentIds = new Set(loadedMessages.map((message) => message.id));
        const newMessages = latestPage.filter((message) => !currentIds.has(message.id));
        let trimmed = 0;
        if (newMessages.length > 0) {
          trimmed = mergeMessageWindow(newMessages, "newer").trimmed;
        }
        nextBefore = loadedMessages.length > latestPage.length
          ? loadedMessages[0]?.serverSequence ?? result.nextBefore
          : result.nextBefore;
        nextAfter = null;
        observeLatestMessages(latestPage);
        lastMessagesKey = messagesKey();
        if (newMessages.length > 0) {
          if (trimmed > 0) await renderMessageHistory({ scrollToBottom: true });
          else await appendNewMessages(newMessages, conversationId, activeCryptoClient);
          scrollToLatest();
        } else {
          scrollToLatest();
        }
        if (currentUser) void writeCachedMessages(currentUser.id, conversationId, loadedMessages);
        clearUnread({ clearMentionHighlights: false });
        return;
      }

      loadedMessages = latestPage;
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
      await detectUnreadMentions(newMessages, conversationId, activeCryptoClient);
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
       scrollToLatest();
       clearUnread({ clearMentionHighlights: false });
      return;
    }

    const merged = mergeMessageWindow(newMessages, "newer");
    nextAfter = caughtUp.nextAfter;
    lastMessagesKey = messagesKey();
    const appendOnly = merged.trimmed === 0 && previousMessages.length > 0;
    if (appendOnly) await appendNewMessages(newMessages, conversationId, activeCryptoClient);
    else await renderMessageHistory({ scrollToBottom: true });
    scrollToLatest();
    if (currentUser) void writeCachedMessages(currentUser.id, conversationId, loadedMessages);
    clearUnread({ clearMentionHighlights: false });
    await waitForScrollSettled();
    if (selection !== selectionToken || conversationId !== selectedConversationId || activeCryptoClient !== cryptoClient) return;
    await detectUnreadMentions(newMessages, conversationId, activeCryptoClient);
    updateMentionHighlights();
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
    kind: channel.kind,
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
  const name = await askText("Create a private space", "Only people you invite can join. The name is encrypted before it leaves this device.", "Space name", "My private space");
  if (!name) return;
  createServerButton.disabled = true;
  mobileCreateServerButton.disabled = true;
  setStatus("Creating encrypted space…");
  try {
    const result = await api.createServer();
    await encryptAndStoreMetadata(result.server.id, result.channel, "lobby", name);
    serverLabels.set(result.server.id, name.slice(0, 80));
    channelLabels.set(result.channel.id, "lobby");
    await refreshServers();
    await selectServer(result.server.id, result.channel.id);
    setStatus("Encrypted space is ready.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    createServerButton.disabled = false;
    mobileCreateServerButton.disabled = false;
    renderServers();
  }
}

async function createChannel(categoryId?: string) {
  const server = selectedServerId ? servers.find((item) => item.id === selectedServerId) : undefined;
  if (!server || !cryptoClient) return;
  const name = await askText("Create an encrypted room", "Room names are encrypted. Each room has its own conversation key.", "Room name", "new-room");
  if (!name) return;
  createChannelButton.disabled = true;
  setStatus("Creating encrypted room…");
  try {
    const result = await api.createChannel(server.id, "", categoryId ?? null);
    await encryptAndStoreMetadata(server.id, result.channel, name);
    await refreshServers();
    await selectServer(server.id, result.channel.id);
    setStatus("Encrypted room is ready.");
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

async function sendJoinAnnouncement(serverId: string, channelId: string | null) {
  if (!channelId || !currentUser || !cryptoClient) return;
  const storageKey = `priv-chat.join-announcement.${currentUser.id}.${serverId}`;
  try {
    if (localStorage.getItem(storageKey) === "sent") return;
  } catch {
    // Continue if local storage is unavailable; the encrypted message is still safe.
  }
  const channel = (await api.serverChannels(serverId)).channels.find((candidate) => candidate.id === channelId);
  if (!channel) return;
  const members = (await api.conversationMembers(channel.conversationId)).members;
  await cryptoClient.prepareConversation(channel.conversationId, members);
  await cryptoClient.syncToDevice().catch(() => undefined);
  await cryptoClient.sendContent(channel.conversationId, members, {
    msgtype: "m.notice",
    body: `${currentUser.displayName} joined this encrypted space.`,
    onboarding: true,
  });
  try {
    localStorage.setItem(storageKey, "sent");
  } catch {
    // The notice was already encrypted and delivered; a future duplicate is preferable to blocking the join.
  }
}

async function joinServer() {
  const token = await askText("Join a private space", "Ask a space steward for an invite token. It grants access to current rooms, not older message history.", "Invite token");
  if (!token) return;
  joinServerButton.disabled = true;
  mobileJoinServerButton.disabled = true;
  try {
    const result = await api.acceptInvite(token);
    await refreshServers();
    await selectServer(result.serverId);
    if (result.joined) await sendJoinAnnouncement(result.serverId, result.onboardingChannelId).catch(() => undefined);
    setStatus("You joined the encrypted space.");
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
  renderMessageInput();
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
  const sentAtMs = Date.now();
  const text = freezeNowMessageMacros(replaceEmojiShortcodes(messageInput.value.trim()), sentAtMs);
  const attachmentsToSend = activeEdit ? [] : composerAttachments.filter((attachment) => attachment.status !== "uploading");
  if (!text && attachmentsToSend.length === 0) return;
  if (text.length > MAX_MESSAGE_TEXT_LENGTH) {
    setStatus("Messages are limited to 4,000 characters. Long pasted text is sent as a text file.", true);
    return;
  }
  const blockedMention = blockedSpecialMentions(text);
  if (blockedMention) {
    setStatus(`You do not have permission to use ${blockedMention}.`, true);
    return;
  }
  stopLocalTyping();
  sendInProgress = true;
  updateComposerState();
  hideMentionSuggestions();
  hideEmojiSuggestions();
  hideMacroSuggestions();
  closeEmojiPicker();
  closeGifPicker();
  const uploadController = attachmentsToSend.length > 0 ? new AbortController() : undefined;
  uploadAbortController = uploadController;
  let textSent = false;
  let editSent = false;
  let queued = false;
  let deliveredMessageCount = 0;
  let sentAttachmentCount = 0;
  const failedAttachments: ComposerAttachment[] = [];
  const sendAsSingleBatch = attachmentsToSend.length > 1;
  let activeBatchAttachmentIndex = -1;
  try {
    if (activeEdit) {
      const embeds = await prepareAppEmbeds(text);
      const mentions = mentionedUserIds(text);
      const roleMentions = mentionedRoleIds(text);
      const result = await activeCryptoClient.sendEdit(conversationId, members, activeEdit.messageId, text, embeds, mentions, roleMentions);
      queued = result.delivery === "queued";
      editSent = true;
      if (stillHere()) {
        applyEditedBody(activeEdit.messageId, text, embeds, mentions, roleMentions);
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
    if (text && !sendAsSingleBatch) {
      const mentions = mentionedUserIds(text);
      const roleMentions = mentionedRoleIds(text);
      if (replyTarget?.mentionSender && replyTarget.userId) {
        mentions.push(replyTarget.userId);
      }
       const result = await activeCryptoClient.sendText(conversationId, members, text, await prepareAppEmbeds(text), replyTarget, mentions, roleMentions);
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
    if (sendAsSingleBatch) {
      try {
        const mentions = mentionedUserIds(text);
        const roleMentions = mentionedRoleIds(text);
        if (replyTarget?.mentionSender && replyTarget.userId) mentions.push(replyTarget.userId);
        const result = await activeCryptoClient.sendMediaBatch(
          conversationId,
          members,
          attachmentsToSend.map((attachment) => ({ file: attachment.file, spoiler: attachment.spoiler })),
          {
            signal: uploadController?.signal,
            body: text,
             embeds: await prepareAppEmbeds(text),
            replyTo: replyTarget,
            mentions,
            roleMentions,
            onAttachmentStart: (index) => {
              activeBatchAttachmentIndex = index;
              for (const candidate of attachmentsToSend) {
                if (candidate.status === "uploading") candidate.status = "ready";
              }
              const attachment = attachmentsToSend[index];
              attachment.status = "uploading";
              attachment.error = undefined;
              attachment.progress = 0;
              renderComposerAttachments();
            },
            onProgress: (loadedBytes, totalBytes) => {
              const attachment = attachmentsToSend[activeBatchAttachmentIndex];
              if (attachment && stillHere()) setComposerAttachmentProgress(attachment, loadedBytes, totalBytes);
            },
          },
        );
        queued = result.delivery === "queued";
        textSent = Boolean(text);
        sentAttachmentCount = attachmentsToSend.length;
        if (result.message) {
          deliveredMessageCount += 1;
          if (stillHere()) {
            if (result.decrypted) optimisticDecryptedMessages.set(result.message.id, result.decrypted);
            await appendOptimisticMessage(result.message);
          }
        }
        drafts.delete(conversationId);
        if (stillHere()) {
          clearComposerAttachments();
          messageInput.value = "";
          clearReplyTarget();
          resizeMessageInput();
          clearUnread();
        }
      } catch (error) {
        const attachment = attachmentsToSend[activeBatchAttachmentIndex] ?? attachmentsToSend[0];
        if (attachment) {
          attachment.status = "error";
          attachment.error = error instanceof Error && error.name === "AbortError" ? "Canceled" : readableError(error);
          failedAttachments.push(attachment);
          renderComposerAttachments();
        }
      }
    } else {
      for (const attachment of attachmentsToSend) {
        if (!stillHere()) break;
        attachment.status = "uploading";
        attachment.error = undefined;
        attachment.progress = 0;
        renderComposerAttachments();
        try {
          const result = await activeCryptoClient.sendMedia(conversationId, members, attachment.file, {
            signal: uploadController?.signal,
            spoiler: attachment.spoiler,
            onProgress: (loadedBytes, totalBytes) => {
              if (!stillHere()) return;
              setComposerAttachmentProgress(attachment, loadedBytes, totalBytes);
            },
          });
          queued = queued || result.delivery === "queued";
          sentAttachmentCount += 1;
          if (result.message) {
            deliveredMessageCount += 1;
            if (stillHere()) {
              if (result.decrypted) optimisticDecryptedMessages.set(result.message.id, result.decrypted);
              await appendOptimisticMessage(result.message);
            }
          }
          if (composerAttachments.includes(attachment)) removeComposerAttachment(attachment.id);
        } catch (error) {
          attachment.status = "error";
          attachment.error = error instanceof Error && error.name === "AbortError" ? "Canceled" : readableError(error);
          failedAttachments.push(attachment);
          renderComposerAttachments();
          if (error instanceof Error && error.name === "AbortError") break;
        }
      }
    }
    if (stillHere()) {
      const remainingFailures = failedAttachments.filter((attachment) => composerAttachments.includes(attachment));
      if (remainingFailures.length > 0) {
        setStatus(`${remainingFailures.length} attachment${remainingFailures.length === 1 ? "" : "s"} failed. Remove or retry them.`, true);
      } else if (queued) {
        setStatus("Encrypted message queued on this device; it will retry automatically.");
      } else if (sentAttachmentCount > 0) {
        setStatus(`${sentAttachmentCount} encrypted attachment${sentAttachmentCount === 1 ? "" : "s"} sent.`);
      }
      if (deliveredMessageCount > 0) {
        void refreshMessages({ forceScrollToBottom: true }).catch((error) => {
          setStatus(`Message saved, but history could not refresh: ${readableError(error)}`, true);
        });
      }
    }
  } catch (error) {
    if (stillHere()) {
      setStatus(editSent ? `Edit ${queued ? "queued" : "sent"}, but history refresh failed: ${readableError(error)}` : textSent ? `Text ${queued ? "queued" : "sent"}, but attachment failed: ${readableError(error)}` : readableError(error), true);
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
  if (handleSuggestionKeydown(event)) return;
  if (appPreferences.enterToSend && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

messageInput.addEventListener("input", resizeMessageInput);
messageInput.addEventListener("scroll", () => {
  messageInputRendered.scrollTop = messageInput.scrollTop;
  messageInputRendered.scrollLeft = messageInput.scrollLeft;
});
messageInput.addEventListener("input", () => {
  if (!editTarget) rememberDraft();
  updateLocalTyping();
});
messageInput.addEventListener("input", renderInputSuggestions);
messageInput.addEventListener("paste", (event) => {
  const pastedText = event.clipboardData?.getData("text/plain") ?? "";
  const images = clipboardImageFiles(event.clipboardData);
  if (images.length > 0) {
    if (editTarget) {
      setStatus("Images cannot be pasted while editing a message.", true);
    } else if (photoInput.disabled) {
      setStatus("You cannot upload images in this conversation right now.", true);
    } else {
      const added = addComposerFiles(images);
      if (added > 0) setStatus(`${added} pasted image${added === 1 ? "" : "s"} added for encrypted upload.`);
    }
    if (!pastedText) event.preventDefault();
  }
  if (pastedText.length <= MAX_MESSAGE_TEXT_LENGTH) return;
  event.preventDefault();
  if (editTarget) {
    setStatus("Long pasted text cannot be inserted while editing a message.", true);
    return;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const added = addComposerFiles([new File([pastedText], `pasted-text-${timestamp}.txt`, { type: "text/plain" })]);
  if (added > 0) setStatus("Long pasted text was added as an encrypted text file.");
});

photoInput.addEventListener("change", () => addComposerFiles([...photoInput.files ?? []]));

document.addEventListener("dragenter", (event) => {
  if (!hasFileDrag(event.dataTransfer)) return;
  event.preventDefault();
  if (!(event.target instanceof Node) || !chatContent.contains(event.target) || !canDropComposerFiles()) return;
  fileDropOverlay.hidden = false;
  chatContent.classList.add("file-drop-active");
});

document.addEventListener("dragover", (event) => {
  if (!hasFileDrag(event.dataTransfer)) return;
  // Prevent the browser from navigating to dropped files, even outside the chat target.
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  if (event.target instanceof Node && chatContent.contains(event.target) && canDropComposerFiles()) {
    fileDropOverlay.hidden = false;
    chatContent.classList.add("file-drop-active");
  }
});

document.addEventListener("dragleave", (event) => {
  if (!hasFileDrag(event.dataTransfer)) return;
  if (event.relatedTarget instanceof Node && chatContent.contains(event.relatedTarget)) return;
  const bounds = chatContent.getBoundingClientRect();
  if (event.clientX >= bounds.left && event.clientX <= bounds.right
    && event.clientY >= bounds.top && event.clientY <= bounds.bottom) return;
  resetFileDropOverlay();
});

document.addEventListener("drop", handleFileDrop);

clearAttachment.addEventListener("click", () => {
  uploadAbortController?.abort();
  clearComposerAttachments();
});

cancelReply.addEventListener("click", clearReplyTarget);
cancelEdit.addEventListener("click", () => clearEditTarget());
emojiToggle.addEventListener("click", toggleEmojiPicker);
gifToggle.addEventListener("click", toggleGifPicker);
gifPickerClose.addEventListener("click", () => {
  closeGifPicker();
  gifToggle.focus();
});
gifPickerSearch.addEventListener("input", scheduleGifSearch);
gifPickerSearch.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeGifPicker();
  gifToggle.focus();
});
  gifPickerProvider.addEventListener("change", () => {
    const provider = gifProviderConfiguration?.providers.find((candidate) => candidate.id === gifPickerProvider.value);
    if (!provider) return;
    gifPickerProviderId = provider.id;
    renderGifPickerAttribution(provider);
    scheduleGifSearch();
});
emojiPickerSearch.addEventListener("input", () => {
  if (emojiPickerSearch.value.trim()) emojiPickerCategory = emojiPickerCategories[0].id;
  emojiPickerGrid.scrollTop = 0;
  renderEmojiPicker();
});
emojiPickerGrid.addEventListener("scroll", updateActiveEmojiCategory, { passive: true });
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
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        void renderMediaViewerItem(mediaViewerIndex - 1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        void renderMediaViewerItem(mediaViewerIndex + 1);
      }
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
  if (!navigationContextMenu.hidden && event.key === "Escape") {
    event.preventDefault();
    closeNavigationContextMenu();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (window.matchMedia("(max-width: 760px)").matches) setMobileSidebar(true);
    conversationSearch.focus();
    conversationSearch.select();
  }
  if (event.key === "Escape") {
    if (!gifPicker.hidden) closeGifPicker();
    else if (!emojiPicker.hidden) closeEmojiPicker();
    else if (!emojiSuggestions.hidden) hideEmojiSuggestions();
    else if (!mentionSuggestions.hidden) hideMentionSuggestions();
    else if (!macroSuggestions.hidden) hideMacroSuggestions();
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
window.addEventListener("resize", renderUnreadButton);
lockButton.addEventListener("click", () => {
  void voiceCalls?.end();
  lockLocalSession();
  optimisticDecryptedMessages.clear();
  decryptedMessageCache.clear();
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
deactivatedSpaceNavigation.addEventListener("click", () => setMobileSidebar(true, true));
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
  if (document.visibilityState === "visible") {
    refreshRelativeMessageDisplays();
    void refreshModerationNotices(selectedServerId);
  }
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
  void voiceCalls?.end();
  void voiceRooms?.leave();
});

voiceCallButton.addEventListener("click", () => {
  const channel = selectedChannelId ? channels.find((item) => item.id === selectedChannelId) : undefined;
  if (channel?.kind === "voice") {
    void joinVoiceRoom(channel);
    return;
  }
  const conversation = conversations.find((item) => item.id === selectedConversationId);
  if (!selectedConversationId || conversation?.kind !== "dm" || !voiceCalls) return;
  void voiceCalls.start(selectedConversationId, conversationDisplayName(conversation))
    .catch((error) => setStatus(readableError(error), true));
});
voiceCallAccept.addEventListener("click", () => {
  void voiceCalls?.accept().catch((error) => setStatus(readableError(error), true));
});
voiceCallDecline.addEventListener("click", () => void voiceCalls?.decline());
voiceCallMute.addEventListener("click", () => {
  if (voiceRooms?.currentState.status !== undefined && voiceRooms.currentState.status !== "idle") {
    void voiceRooms.toggleMute().catch((error) => setStatus(readableError(error), true));
  } else {
    void voiceCalls?.toggleMute().catch((error) => setStatus(readableError(error), true));
  }
});
voiceCallEnd.addEventListener("click", () => {
  if (voiceRooms?.currentState.status !== undefined && voiceRooms.currentState.status !== "idle") void voiceRooms.leave();
  else void voiceCalls?.end();
});
voiceRoomJoinButton.addEventListener("click", () => {
  const channel = selectedChannelId ? channels.find((item) => item.id === selectedChannelId && item.kind === "voice") : undefined;
  if (channel) void joinVoiceRoom(channel);
});
voiceCallDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  if (voiceRooms?.currentState.status !== undefined && voiceRooms.currentState.status !== "idle") void voiceRooms.leave();
  else void voiceCalls?.end();
});

updateComposerState();
resizeMessageInput();
renderIcons();

async function boot() {
  try {
    currentUser = (await api.me()).user;
    void refreshModerationNotices(undefined);
    window.setInterval(() => {
      if (!document.hidden) void refreshModerationNotices(selectedServerId);
    }, 60_000);
    await startCrypto();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      window.location.assign("/");
      return;
    }
    if (error instanceof LocalCryptoStoreError) {
      const returnPath = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/unlock?error=${encodeURIComponent(error.message)}&return=${encodeURIComponent(returnPath)}`);
      return;
    }
    window.clearTimeout(realtimeHandshakeTimer);
    realtimeHandshakeTimer = undefined;
    const failedRealtime = realtime;
    realtime = undefined;
    realtimeReadySocket = undefined;
    failedRealtime?.close();
    await cryptoClient?.close().catch(() => undefined);
    cryptoClient = undefined;
    setStatus(readableError(error), true);
    return;
  }

  if (!cryptoClient) return;
  window.setInterval(() => {
    if (!document.hidden) refreshRelativeMessageDisplays();
  }, 30_000);
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
