import {
  ApiClient,
  ApiError,
  type ConversationMember,
  type CustomServerRole,
  type Server,
  type ServerAuditLog,
  type ServerCategory,
  type ServerChannel,
  type ServerCustomEmoji,
  type ServerMember,
  type ServerModeration,
  type ServerPermission,
  type ServerPermissionMap,
} from "./api";
import { renderAvatar } from "./avatar";
import { applyAppPreferences, loadAppPreferences, readableAccentText, type AppTheme } from "./app-preferences";
import { CryptoClient, LocalCryptoStoreError } from "./crypto";
import { iconElement, renderIcons } from "./icons";
import { highestSeparatedRole } from "./member-roles";
import { setupSpaceSettingsLists } from "./space-settings-layout";
import { decryptCustomEmojiImage } from "./custom-emoji-media";
import { roomDropUpdates } from "./room-order";
import { roleDropUpdates } from "./role-order";
import { memberRolePicker } from "./member-role-picker";
import { showAnchoredPopover } from "./anchored-popover";
import { showMemberProfile } from "./member-profile";

setupSpaceSettingsLists();
import { previewChannelCapabilities, previewRoleFeatures } from "./role-preview";
import { showOneTimeToken, promptUnsavedChanges } from "./ui-dialog";
import {
  confirmLocalUnlock,
  resolveLocalPassphrase,
} from "./unlock-vault";

const api = new ApiClient();

function currentAppTheme(): AppTheme {
  const theme = document.documentElement.dataset.appTheme;
  return theme === "light" || theme === "dim" || theme === "black" || theme === "momotalk" ? theme : "dark";
}

const serverId = new URLSearchParams(window.location.search).get("server");
const title = document.getElementById("server-settings-title") as HTMLElement;
const settingsLayout = document.getElementById("server-settings-layout") as HTMLElement;
function applySavedTheme() {
  if (currentUserId) applyAppPreferences(loadAppPreferences(currentUserId), settingsLayout);
}
window.addEventListener("focus", applySavedTheme);
window.addEventListener("storage", (event) => {
  if (currentUserId && (event.key === null || event.key === `priv-chat.app-preferences.${currentUserId}`)) applySavedTheme();
});
const settingsSidebar = document.getElementById("server-settings-sidebar") as HTMLElement;
const mobileSidebarToggle = document.getElementById("server-settings-mobile-sidebar-toggle") as HTMLButtonElement;
const mobileSidebarClose = document.getElementById("server-settings-mobile-sidebar-close") as HTMLButtonElement;
const mobileSidebarBackdrop = document.getElementById("server-settings-mobile-sidebar-backdrop") as HTMLButtonElement;
const settingsPageTitle = document.getElementById("server-settings-page-title") as HTMLElement;
const settingsPageDescription = document.getElementById("server-settings-page-description") as HTMLElement;
const roleLabel = document.getElementById("server-settings-role") as HTMLElement;
const serverForm = document.getElementById("server-form") as HTMLFormElement;
const serverName = document.getElementById("server-name") as HTMLInputElement;
const serverDescription = document.getElementById("server-description") as HTMLTextAreaElement;
const onboardingChannel = document.getElementById("onboarding-channel") as HTMLSelectElement;
const landingChannel = document.getElementById("landing-channel") as HTMLSelectElement;
const serverIconPreview = document.getElementById("server-icon-preview") as HTMLElement;
const serverIconInput = document.getElementById("server-icon-input") as HTMLInputElement;
const removeServerIcon = document.getElementById("remove-server-icon") as HTMLButtonElement;
const serverBannerPreview = document.getElementById("server-banner-preview") as HTMLElement;
const serverBannerInput = document.getElementById("server-banner-input") as HTMLInputElement;
const removeServerBanner = document.getElementById("remove-server-banner") as HTMLButtonElement;
const welcomeEnabled = document.getElementById("welcome-enabled") as HTMLInputElement;
const welcomeHeading = document.getElementById("welcome-heading") as HTMLInputElement;
const welcomeDescription = document.getElementById("welcome-description") as HTMLTextAreaElement;
const welcomeRules = document.getElementById("welcome-rules") as HTMLTextAreaElement;
const welcomeAcknowledgement = document.getElementById("welcome-acknowledgement") as HTMLInputElement;
const saveServer = document.getElementById("save-server-button") as HTMLButtonElement;
const deleteServer = document.getElementById("delete-server-button") as HTMLButtonElement;
const categoryForm = document.getElementById("category-form") as HTMLFormElement;
const newCategoryName = document.getElementById("new-category-name") as HTMLInputElement;
const categoryList = document.getElementById("category-settings-list") as HTMLElement;
const channelForm = document.getElementById("channel-form") as HTMLFormElement;
const newChannelName = document.getElementById("new-channel-name") as HTMLInputElement;
const newChannelKind = document.getElementById("new-channel-kind") as HTMLSelectElement;
const newChannelCategory = document.getElementById("new-channel-category") as HTMLSelectElement;
const channelList = document.getElementById("channel-settings-list") as HTMLElement;
const roleForm = document.getElementById("role-form") as HTMLFormElement;
const newRoleName = document.getElementById("new-role-name") as HTMLInputElement;
const newRoleColor = document.getElementById("new-role-color") as HTMLInputElement;
const roleList = document.getElementById("role-settings-list") as HTMLElement;
const rolePreview = document.getElementById("role-preview") as HTMLDialogElement;
const rolePreviewTitle = document.getElementById("role-preview-title") as HTMLElement;
const rolePreviewDescription = document.getElementById("role-preview-description") as HTMLElement;
const rolePreviewBanner = document.getElementById("role-preview-banner") as HTMLElement;
const rolePreviewContent = document.getElementById("role-preview-content") as HTMLElement;
const exitRolePreview = document.getElementById("exit-role-preview") as HTMLButtonElement;
const previewRoomToggle = document.getElementById("role-preview-room-toggle") as HTMLButtonElement;
const previewInspectorToggle = document.getElementById("role-preview-inspector-toggle") as HTMLButtonElement;
const previewRoomBackdrop = document.getElementById("role-preview-room-backdrop") as HTMLButtonElement;
const previewInspectorBackdrop = document.getElementById("role-preview-inspector-backdrop") as HTMLButtonElement;
const previewSidebar = document.getElementById("role-preview-sidebar") as HTMLElement;
const previewMain = document.getElementById("role-preview-main") as HTMLElement;
const previewInspector = document.getElementById("role-preview-inspector") as HTMLElement;
const memberList = document.getElementById("member-settings-list") as HTMLElement;
const moderationList = document.getElementById("moderation-settings-list") as HTMLElement;
const moderationActionDialog = document.getElementById("moderation-action-dialog") as HTMLDialogElement;
const moderationActionForm = document.getElementById("moderation-action-form") as HTMLFormElement;
const moderationActionTitle = document.getElementById("moderation-action-title") as HTMLElement;
const moderationActionDescription = document.getElementById("moderation-action-description") as HTMLElement;
const moderationActionReason = document.getElementById("moderation-action-reason") as HTMLTextAreaElement;
const moderationActionDuration = document.getElementById("moderation-action-duration") as HTMLSelectElement;
const moderationActionSubmit = document.getElementById("moderation-action-submit") as HTMLButtonElement;
const moderationActionCancel = document.getElementById("moderation-action-cancel") as HTMLButtonElement;
const createInvite = document.getElementById("create-invite-settings") as HTMLButtonElement;
const inviteList = document.getElementById("invite-settings-list") as HTMLElement;
const emojiForm = document.getElementById("emoji-form") as HTMLFormElement;
const newEmojiName = document.getElementById("new-emoji-name") as HTMLInputElement;
const newEmojiFile = document.getElementById("new-emoji-file") as HTMLInputElement;
const emojiList = document.getElementById("emoji-settings-list") as HTMLElement;
const auditList = document.getElementById("audit-log-list") as HTMLElement;
const refreshAuditLog = document.getElementById("refresh-audit-log") as HTMLButtonElement;
const status = document.getElementById("server-settings-status") as HTMLElement;
const backToServer = document.getElementById("back-to-server") as HTMLAnchorElement;

let currentUserId: string | undefined;
let currentServer: Server | undefined;
let channels: ServerChannel[] = [];
let categories: ServerCategory[] = [];
let members: ServerMember[] = [];
let roles: CustomServerRole[] = [];
let roleAssignments = new Map<string, string[]>();
let moderation: ServerModeration = { bans: [], timeouts: [], warnings: [] };
let pendingModerationAction: { kind: "warn" | "ban" | "timeout"; member: ServerMember } | undefined;
let customEmojis: ServerCustomEmoji[] = [];
let auditLogs: ServerAuditLog[] = [];
let cryptoClient: CryptoClient | undefined;
let metadataConversationId: string | undefined;
let metadataMembers: Awaited<ReturnType<ApiClient["conversationMembers"]>>["members"] = [];
let selectedRoleId: string | undefined;
let previewRoleId: string | undefined;
let previewChannelId: string | undefined;
let roleSearchQuery = "";
let roleEditorDirty = false;
let roleEditorOpen = false;
let draggedRoleId: string | undefined;
let roleSortSaving = false;
let metadataReady = false;
let metadataHydrationVersion = 0;
const categoryNames = new Map<string, string>();
const channelNames = new Map<string, string>();
const roleNames = new Map<string, string>();
const customEmojiNames = new Map<string, string>();
const customEmojiMetadata = new Map<string, Record<string, unknown>>();
const customEmojiPreviewUrls = new Map<string, string>();
function clearCustomEmojiPreviews() {
  for (const url of customEmojiPreviewUrls.values()) URL.revokeObjectURL(url);
  customEmojiPreviewUrls.clear();
}
window.addEventListener("pagehide", () => { metadataHydrationVersion += 1; clearCustomEmojiPreviews(); });

const permissionDefinitions: Array<{ id: ServerPermission; label: string; description: string }> = [
  { id: "view_channels", label: "View rooms", description: "See rooms and read encrypted history." },
  { id: "send_messages", label: "Send messages", description: "Post encrypted messages in visible channels." },
  { id: "upload_files", label: "Upload files", description: "Upload encrypted files in all unrestricted rooms." },
  { id: "view_members", label: "View people", description: "See the space people directory." },
  { id: "mention_everyone", label: "Broadcast to all", description: "Use the all-people broadcast mention." },
  { id: "mention_here", label: "Mention active people", description: "Use the active-people broadcast mention." },
  { id: "mention_roles", label: "Mention roles", description: "Ping roles marked as mentionable." },
  { id: "manage_server", label: "Manage space", description: "Edit space details and space-wide settings." },
  { id: "manage_custom_emoji", label: "Manage custom emoji", description: "Upload and remove encrypted custom emoji." },
  { id: "view_audit_logs", label: "View audit log", description: "Review space management actions." },
  { id: "manage_channels", label: "Manage all rooms", description: "Legacy shortcut for every room management action." },
  { id: "create_channels", label: "Create rooms", description: "Create new encrypted rooms." },
  { id: "edit_channels", label: "Edit rooms", description: "Rename rooms and change their groups." },
  { id: "reorder_channels", label: "Reorder rooms", description: "Change room ordering." },
  { id: "archive_channels", label: "Archive rooms", description: "Archive rooms that are no longer needed." },
  { id: "manage_categories", label: "Manage room groups", description: "Create, edit, reorder, and archive room groups." },
  { id: "manage_channel_access", label: "Manage room access", description: "Set role-specific room visibility and uploads." },
  { id: "manage_invites", label: "Manage all invites", description: "Legacy shortcut for every invite action." },
  { id: "view_invites", label: "View invites", description: "See existing invite links and usage." },
  { id: "create_invites", label: "Create invites", description: "Create new invite links." },
  { id: "revoke_invites", label: "Revoke invites", description: "Disable existing invite links." },
  { id: "manage_invite_limits", label: "Manage invite limits", description: "Set invite expiration and usage limits." },
  { id: "manage_roles", label: "Manage all roles", description: "Legacy shortcut for every role action." },
  { id: "create_roles", label: "Create roles", description: "Create new roles." },
  { id: "edit_roles", label: "Edit roles", description: "Rename roles." },
  { id: "delete_roles", label: "Delete roles", description: "Delete custom roles." },
  { id: "assign_roles", label: "Assign roles", description: "Assign existing roles to members." },
  { id: "reorder_roles", label: "Reorder roles", description: "Change role hierarchy positions." },
  { id: "manage_role_permissions", label: "Manage role permissions", description: "Change role permissions and channel defaults." },
  { id: "manage_role_appearance", label: "Manage role appearance", description: "Change role names and colors." },
  { id: "manage_members", label: "Manage all people", description: "Legacy shortcut for people and moderation actions." },
  { id: "kick_members", label: "Kick members", description: "Remove members without banning them." },
  { id: "view_moderation_records", label: "View moderation records", description: "See active bans, timeouts, and warnings." },
  { id: "ban_members", label: "Ban members", description: "Ban members and block future invites." },
  { id: "unban_members", label: "Unban members", description: "Revoke active member bans." },
  { id: "timeout_members", label: "Timeout members", description: "Temporarily prevent messaging and uploads." },
  { id: "remove_timeouts", label: "Remove timeouts", description: "Restore members before their timeout expires." },
  { id: "warn_members", label: "Warn members", description: "Issue a space-scoped warning with a reason and expiry." },
  { id: "revoke_warnings", label: "Revoke warnings", description: "Revoke active warnings before they expire." },
  { id: "pin_messages", label: "Pin messages", description: "Pin and unpin encrypted messages." },
  { id: "delete_others_messages", label: "Delete others' messages", description: "Permanently remove encrypted messages for everyone." },
  { id: "delete_messages", label: "Delete messages (legacy)", description: "Legacy shortcut for moderator message deletion." },
];

const previewPermissionGroups: Array<{ label: string; permissions: ServerPermission[] }> = [
  { label: "Messages", permissions: ["view_channels", "send_messages", "upload_files", "pin_messages", "delete_others_messages", "delete_messages"] },
  { label: "People and mentions", permissions: ["view_members", "mention_everyone", "mention_here", "mention_roles"] },
  { label: "Rooms", permissions: ["manage_channels", "create_channels", "edit_channels", "reorder_channels", "archive_channels", "manage_categories", "manage_channel_access"] },
  { label: "Invites", permissions: ["manage_invites", "view_invites", "create_invites", "revoke_invites", "manage_invite_limits"] },
  { label: "Roles", permissions: ["manage_roles", "create_roles", "edit_roles", "delete_roles", "assign_roles", "reorder_roles", "manage_role_permissions", "manage_role_appearance"] },
  { label: "Moderation", permissions: ["manage_server", "manage_members", "kick_members", "view_moderation_records", "ban_members", "unban_members", "timeout_members", "remove_timeouts", "warn_members", "revoke_warnings", "manage_custom_emoji", "view_audit_logs"] },
];

function normalizeRoleIds(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || value.length < 2 || value[0] !== "{" || value[value.length - 1] !== "}") return [];
  return value.slice(1, -1).split(",").map((item) => item.replace(/^"|"$/g, "")).filter(Boolean);
}

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function syncSettingsNav() {
  const requestedHash = window.location.hash || "#overview";
  const views = [...document.querySelectorAll<HTMLElement>("[data-settings-view]")];
  const hash = views.some((view) => `#${view.id}` === requestedHash) ? requestedHash : "#overview";
  if (hash !== "#members") {
    document.querySelectorAll<HTMLElement>(".member-actions-popover:popover-open, .member-role-dialog:popover-open").forEach((popover) => popover.hidePopover());
  }
  for (const view of views) view.hidden = `#${view.id}` !== hash;
  let activeLink: HTMLAnchorElement | undefined;
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".server-settings-nav-item")) {
    const active = link.hash === hash;
    link.classList.toggle("active", active);
    if (active) {
      activeLink = link;
      link.setAttribute("aria-current", "location");
    } else link.removeAttribute("aria-current");
  }
  settingsPageTitle.textContent = activeLink?.dataset.title ?? "Space settings";
  settingsPageDescription.textContent = activeLink?.dataset.description ?? "Manage this private space.";
}

function setMobileSidebar(open: boolean, focusNavigation = false) {
  settingsLayout.classList.toggle("mobile-sidebar-open", open);
  mobileSidebarToggle.setAttribute("aria-expanded", String(open));
  mobileSidebarToggle.setAttribute("aria-label", open ? "Hide settings navigation" : "Show settings navigation");
  settingsSidebar.inert = window.matchMedia("(max-width: 760px)").matches && !open;
  if (open && focusNavigation && window.matchMedia("(max-width: 760px)").matches) {
    settingsSidebar.querySelector<HTMLElement>(".server-settings-nav-item.active")?.focus();
  }
}

for (const link of document.querySelectorAll<HTMLAnchorElement>(".server-settings-nav-item")) {
  link.addEventListener("click", (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void resolveSettingsBeforeLeave().then((leave) => {
      if (!leave) return;
      if (window.matchMedia("(max-width: 760px)").matches) setMobileSidebar(false);
      window.location.hash = link.hash;
    });
  });
}

backToServer.addEventListener("click", (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void resolveSettingsBeforeLeave().then((leave) => { if (leave) window.location.assign(backToServer.href); });
});

mobileSidebarToggle.addEventListener("click", () => {
  setMobileSidebar(!settingsLayout.classList.contains("mobile-sidebar-open"), true);
});
mobileSidebarClose.addEventListener("click", () => {
  setMobileSidebar(false);
  mobileSidebarToggle.focus();
});
mobileSidebarBackdrop.addEventListener("click", () => {
  setMobileSidebar(false);
  mobileSidebarToggle.focus();
});
window.addEventListener("resize", () => setMobileSidebar(settingsLayout.classList.contains("mobile-sidebar-open")));
setMobileSidebar(settingsLayout.classList.contains("mobile-sidebar-open"));
let previousSettingsHash = window.location.hash || "#overview";
window.addEventListener("hashchange", () => {
  const nextHash = window.location.hash || "#overview";
  void resolveSettingsBeforeLeave().then((leave) => {
    if (!leave) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${previousSettingsHash}`);
    else previousSettingsHash = nextHash;
    syncSettingsNav();
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat
    || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
    || document.querySelector("dialog[open], [popover]:popover-open")) return;
  event.preventDefault();
  if (roleEditorOpen && !document.getElementById("access")?.hidden) closeRoleEditor();
  else backToServer.click();
});
syncSettingsNav();
renderIcons();

const overviewFields = [serverName, serverDescription, onboardingChannel, landingChannel, welcomeEnabled,
  welcomeHeading, welcomeDescription, welcomeRules, welcomeAcknowledgement];
let savedOverview: string | undefined;
let leavingSettings = false;
function overviewSnapshot() {
  return JSON.stringify(overviewFields.map((field) => field instanceof HTMLInputElement && field.type === "checkbox" ? field.checked : field.value));
}
async function resolveSettingsBeforeLeave() {
  if (leavingSettings) return false;
  leavingSettings = true;
  try {
    if (roleEditorOpen && !closeRoleEditor(false)) return false;
    if (!metadataReady || !savedOverview || overviewSnapshot() === savedOverview) return true;
    const choice = await promptUnsavedChanges();
    if (choice === "stay") return false;
    if (choice === "save") return await saveSpaceSettings();
    const values = JSON.parse(savedOverview) as (string | boolean)[];
    overviewFields.forEach((field, index) => {
      if (field instanceof HTMLInputElement && field.type === "checkbox") field.checked = Boolean(values[index]);
      else field.value = String(values[index]);
    });
    return true;
  } finally { leavingSettings = false; }
}

function readableError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "current_password_incorrect") return "The current password is incorrect.";
    if (error.code === "insufficient_server_permissions") return "You do not have permission to manage this server.";
    if (error.code === "insufficient_channel_permissions") return "This role cannot use that channel.";
    if (error.code === "invalid_role_permissions") return "The role permissions were invalid.";
    if (error.code === "owner_role_is_not_customizable") return "The owner role cannot be pinged or restricted.";
    if (error.code === "everyone_role_identity_is_not_customizable") return "The All members role identity cannot be changed.";
    if (error.code === "cannot_delete_system_role") return "System roles cannot be deleted.";
    if (error.code === "invalid_role_assignment") return "One or more selected roles are no longer available.";
    if (error.code === "cannot_assign_owner_role") return "The owner role cannot be assigned.";
    if (error.code === "role_hierarchy_violation") return "You can only manage roles below your highest role.";
    if (error.code === "server_banned") return "This account is banned from the server.";
    if (error.code === "cannot_archive_last_channel") return "A space must keep one active encrypted room.";
    if (error.code === "cannot_archive_metadata_channel") return "The original channel anchors encrypted server metadata and cannot be archived.";
    if (error.code === "unsupported_server_branding_type") return "That image type is not supported.";
    if (error.code === "invalid_server_branding") return "The image bytes were not valid.";
    if (error.code === "server_branding_too_large") return "That image is larger than 5 MiB.";
    if (error.code === "custom_emoji_too_large") return "That emoji is larger than 10 MiB.";
    if (error.code === "custom_emoji_size_mismatch") return "The encrypted emoji upload was incomplete.";
    if (error.code === "insufficient_server_permissions" && window.location.hash === "#audit") return "You do not have permission to view the audit log.";
    return error.code;
  }
  return error instanceof Error ? error.message : "request_failed";
}

function destination(channelId?: string) {
  if (serverId && channelId) return `/channels/${encodeURIComponent(serverId)}/${encodeURIComponent(channelId)}`;
  return "/app";
}

async function ensureCrypto() {
  if (!currentUserId) throw new Error("not_authenticated");
  const passphrase = await resolveLocalPassphrase(currentUserId);
  if (!passphrase) {
    window.location.assign(`/unlock?return=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
    return;
  }
  const nextCryptoClient = new CryptoClient(api, currentUserId, passphrase);
  try {
    await nextCryptoClient.initialize();
  } catch (error) {
    await nextCryptoClient.close().catch(() => undefined);
    throw error;
  }
  cryptoClient = nextCryptoClient;
  confirmLocalUnlock();
}

async function prepareConversation(conversationId: string, sync = true, knownMembers?: ConversationMember[]) {
  if (!cryptoClient) throw new Error("crypto_not_initialized");
  const members = knownMembers ?? (await api.conversationMembers(conversationId)).members;
  await cryptoClient.prepareConversation(conversationId, members);
  if (sync) await cryptoClient.syncToDevice().catch(() => undefined);
  return members;
}

async function decryptMetadata(conversationId: string, encryptedMetadata: string) {
  if (!cryptoClient || !encryptedMetadata) return {};
  try {
    return await cryptoClient.decryptMetadata(conversationId, encryptedMetadata);
  } catch {
    return {};
  }
}

async function encryptMetadata(conversationId: string, value: Record<string, unknown>) {
  if (!cryptoClient) throw new Error("crypto_not_initialized");
  return cryptoClient.encryptMetadata(conversationId, metadataMembers, value);
}

function roleName(role: CustomServerRole) {
  if (role.systemKey === "owner") return "Owner";
  if (role.systemKey === "everyone") return "All members";
  if (roleNames.has(role.id)) return roleNames.get(role.id)!;
  if (role.systemKey === "admin") return "Administrator";
  if (role.systemKey === "member") return "Member";
  return "Unnamed role";
}

function defaultRolePermissions(): Partial<ServerPermissionMap> {
  return { view_channels: true };
}

function hasPermission(permission: ServerPermission) {
  return currentServer?.role === "owner" || Boolean(currentServer?.permissions[permission]);
}

function hasAnyPermission(...permissions: ServerPermission[]) {
  return permissions.some((permission) => hasPermission(permission));
}

function canEditRoleAppearance() {
  return hasAnyPermission("manage_roles", "manage_role_appearance");
}

function canEditRoleName() {
  return hasAnyPermission("manage_roles", "edit_roles", "manage_role_appearance");
}

function canEditRolePermissions() {
  return hasAnyPermission("manage_roles", "manage_role_permissions");
}

function canReorderRoles() {
  return hasAnyPermission("manage_roles", "reorder_roles");
}

function canManageRoleAccess() {
  return hasAnyPermission("manage_roles", "manage_channel_access");
}

function canAssignRoles() {
  return hasAnyPermission("manage_roles", "assign_roles");
}

function previewPermissions(role: CustomServerRole) {
  const permissions = {} as ServerPermissionMap;
  for (const definition of permissionDefinitions) permissions[definition.id] = role.permissions[definition.id] === true;
  return permissions;
}

// I have nothing but my burger and I want nothing more
function rolePreviewStatus(label: string, allowed: boolean) {
  const status = document.createElement("span");
  status.className = `role-preview-action ${allowed ? "allowed" : "blocked"}`;
  status.textContent = `${label} · ${allowed ? "Allowed" : "Blocked"}`;
  return status;
}

function rolePreviewIcon(name: string) {
  const icon = document.createElement("i");
  icon.dataset.lucide = name;
  return icon;
}

function setPreviewRoomNavigation(open: boolean) {
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  rolePreviewContent.classList.toggle("role-preview-room-nav-open", mobile && open);
  previewRoomToggle.setAttribute("aria-expanded", String(mobile && open));
  previewRoomToggle.setAttribute("aria-label", mobile && open ? "Hide rooms" : "Show rooms");
  previewSidebar.inert = mobile && !open;
}

function setPreviewInspector(open: boolean) {
  const compact = window.matchMedia("(max-width: 1000px)").matches;
  rolePreviewContent.classList.toggle("role-preview-inspector-open", compact && open);
  previewInspectorToggle.setAttribute("aria-expanded", String(compact && open));
  previewInspector.inert = compact && !open;
}

function renderRolePreview() {
  const role = previewRoleId ? roles.find((candidate) => candidate.id === previewRoleId) : undefined;
  if (!role) {
    previewSidebar.replaceChildren();
    previewMain.replaceChildren();
    previewInspector.replaceChildren();
    return;
  }

  const permissions = previewPermissions(role);
  const features = previewRoleFeatures(role);
  const visibleChannels = [...channels]
    .filter((channel) => previewChannelCapabilities(role, channel).canView)
    .sort((left, right) => left.position - right.position);
  const selectedChannel = visibleChannels.find((channel) => channel.id === previewChannelId) ?? visibleChannels[0];
  previewChannelId = selectedChannel?.id;
  const capabilities = selectedChannel
    ? previewChannelCapabilities(role, selectedChannel)
    : { canView: false, canSend: false, canUpload: false };
  const unavailableToCurrentAccount = Math.max(0, (currentServer?.channelCount ?? channels.length) - channels.length);

  rolePreview.style.setProperty("--role-color", role.color);
  rolePreviewTitle.textContent = `Viewing as ${roleName(role)}`;
  rolePreviewDescription.textContent = "Read-only · no member impersonation, message history, sends, uploads, or settings changes.";
  rolePreviewBanner.querySelector<HTMLElement>(".role-preview-swatch")?.style.setProperty("background", role.color);

  previewSidebar.replaceChildren();
  previewMain.replaceChildren();
  previewInspector.replaceChildren();

  const feedback = document.createElement("p");
  feedback.className = "role-preview-feedback";
  feedback.setAttribute("role", "status");
  feedback.textContent = "Preview only · no server actions are performed.";

  const spaceHeading = document.createElement("div");
  spaceHeading.className = "role-preview-space-heading";
  const spaceIcon = document.createElement("span");
  spaceIcon.className = "role-preview-space-icon";
  if (currentServer?.iconUrl) {
    const image = document.createElement("img");
    image.src = currentServer.iconUrl;
    image.alt = "";
    spaceIcon.append(image);
  } else {
    spaceIcon.textContent = (serverName.value.trim() || "N").slice(0, 1).toLocaleUpperCase();
  }
  const spaceIdentity = document.createElement("div");
  spaceIdentity.className = "role-preview-space-identity";
  const spaceName = document.createElement("strong");
  spaceName.textContent = serverName.value.trim() || "Private space";
  const roleLabel = document.createElement("span");
  roleLabel.textContent = `As ${roleName(role)}`;
  spaceIdentity.append(spaceName, roleLabel);
  spaceHeading.append(spaceIcon, spaceIdentity);
  previewSidebar.append(spaceHeading);

  const roomHeading = document.createElement("div");
  roomHeading.className = "role-preview-sidebar-heading";
  const roomHeadingLabel = document.createElement("strong");
  roomHeadingLabel.textContent = "ROOMS";
  const roomCount = document.createElement("span");
  roomCount.textContent = `${visibleChannels.length}`;
  roomHeading.append(roomHeadingLabel, roomCount);
  previewSidebar.append(roomHeading);

  const roomNavigation = document.createElement("nav");
  roomNavigation.className = "role-preview-room-list";
  roomNavigation.setAttribute("aria-label", "Rooms visible to this role");
  const visibleByCategory = new Map<string | null, ServerChannel[]>();
  for (const channel of visibleChannels) {
    const grouped = visibleByCategory.get(channel.categoryId) ?? [];
    grouped.push(channel);
    visibleByCategory.set(channel.categoryId, grouped);
  }
  const appendRoom = (channel: ServerChannel, parent: HTMLElement) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "role-preview-room-item";
    button.classList.toggle("selected", channel.id === selectedChannel?.id);
    button.setAttribute("aria-pressed", String(channel.id === selectedChannel?.id));
    if (channel.id === selectedChannel?.id) button.setAttribute("aria-current", "page");
    button.append(rolePreviewIcon(channel.kind === "voice" ? "headphones" : "hash"));
    const name = document.createElement("span");
    name.textContent = channelName(channel);
    button.append(name);
    button.addEventListener("click", () => {
      previewChannelId = channel.id;
      renderRolePreview();
      setPreviewRoomNavigation(false);
    });
    parent.append(button);
  };
  const categoryIds = new Set(categories.map((category) => category.id));
  for (const category of [...categories].sort((left, right) => left.position - right.position)) {
    const categoryChannels = visibleByCategory.get(category.id) ?? [];
    if (categoryChannels.length === 0) continue;
    const group = document.createElement("details");
    group.className = "role-preview-room-group";
    group.open = true;
    const summary = document.createElement("summary");
    summary.textContent = categoryName(category);
    const count = document.createElement("span");
    count.textContent = String(categoryChannels.length);
    summary.append(count);
    group.append(summary);
    for (const channel of categoryChannels) appendRoom(channel, group);
    roomNavigation.append(group);
  }
  const uncategorizedChannels = visibleChannels.filter((channel) => !channel.categoryId || !categoryIds.has(channel.categoryId));
  if (categories.length === 0) {
    for (const channel of uncategorizedChannels) appendRoom(channel, roomNavigation);
  } else if (uncategorizedChannels.length > 0) {
    const group = document.createElement("details");
    group.className = "role-preview-room-group";
    group.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "Uncategorized";
    const count = document.createElement("span");
    count.textContent = String(uncategorizedChannels.length);
    summary.append(count);
    group.append(summary);
    for (const channel of uncategorizedChannels) appendRoom(channel, group);
    roomNavigation.append(group);
  }
  if (visibleChannels.length === 0) {
    const empty = document.createElement("p");
    empty.className = "role-preview-empty small";
    empty.textContent = "No rooms are visible with this role.";
    roomNavigation.append(empty);
  }
  previewSidebar.append(roomNavigation);

  if (visibleChannels.length < channels.length) {
    const hiddenRooms = document.createElement("p");
    hiddenRooms.className = "role-preview-hidden-rooms";
    hiddenRooms.textContent = `${channels.length - visibleChannels.length} room${channels.length - visibleChannels.length === 1 ? " is" : "s are"} hidden with this role.`;
    previewSidebar.append(hiddenRooms);
  }
  if (unavailableToCurrentAccount > 0) {
    const notAvailable = document.createElement("p");
    notAvailable.className = "role-preview-hidden-rooms";
    notAvailable.textContent = `${unavailableToCurrentAccount} other room${unavailableToCurrentAccount === 1 ? " is" : "s are"} outside your account's access and can't be previewed.`;
    previewSidebar.append(notAvailable);
  }

  const addSidebarAction = (label: string, iconName: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "role-preview-sidebar-action";
    button.append(rolePreviewIcon(iconName));
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    button.addEventListener("click", () => {
      feedback.textContent = "Preview only · this action is visible to the role but wasn't performed.";
    });
    previewSidebar.append(button);
  };
  if (features.canManageChannels) addSidebarAction("Create or manage rooms", "plus");
  if (features.canManageInvites) addSidebarAction("Invite people", "link");
  if (features.canManageSettings) addSidebarAction("Space settings", "settings-2");

  const chatHeader = document.createElement("header");
  chatHeader.className = "role-preview-chat-header";
  const roomIdentity = document.createElement("div");
  roomIdentity.className = "role-preview-chat-room";
  const roomIcon = document.createElement("span");
  roomIcon.className = "role-preview-chat-icon";
  roomIcon.append(rolePreviewIcon("hash"));
  const roomCopy = document.createElement("div");
  const roomTitle = document.createElement("h2");
  roomTitle.textContent = selectedChannel ? channelName(selectedChannel) : "No visible room";
  const roomSubtitle = document.createElement("span");
  roomSubtitle.textContent = selectedChannel
    ? "Encrypted room · message history is not loaded in preview"
    : "This role has no visible rooms";
  roomCopy.append(roomTitle, roomSubtitle);
  roomIdentity.append(roomIcon, roomCopy);
  chatHeader.append(roomIdentity);
  const chatActions = document.createElement("div");
  chatActions.className = "role-preview-chat-actions";
  if (features.canViewMembers) {
    const peopleButton = document.createElement("button");
    peopleButton.type = "button";
    peopleButton.className = "icon-button";
    peopleButton.title = "Show people visible to this role";
    peopleButton.setAttribute("aria-label", "Show people visible to this role");
    peopleButton.append(rolePreviewIcon("users-round"));
    peopleButton.addEventListener("click", () => setPreviewInspector(true));
    chatActions.append(peopleButton);
  }
  if (features.canManageInvites) {
    const inviteButton = document.createElement("button");
    inviteButton.type = "button";
    inviteButton.className = "icon-button";
    inviteButton.title = "Create invite (preview only)";
    inviteButton.setAttribute("aria-label", "Create invite (preview only)");
    inviteButton.append(rolePreviewIcon("link"));
    inviteButton.addEventListener("click", () => {
      feedback.textContent = "Preview only · no invite was created.";
    });
    chatActions.append(inviteButton);
  }
  if (chatActions.childElementCount > 0) chatHeader.append(chatActions);
  previewMain.append(chatHeader, feedback);

  if (selectedChannel) {
    const channelCapabilities = document.createElement("div");
    channelCapabilities.className = "role-preview-channel-capabilities";
    channelCapabilities.append(
      rolePreviewStatus("View", capabilities.canView),
      rolePreviewStatus("Send", capabilities.canSend),
      rolePreviewStatus("Upload", capabilities.canUpload),
    );
    previewMain.append(channelCapabilities);
  }

  const messageArea = document.createElement("section");
  messageArea.className = "role-preview-message-area";
  const messageEmpty = document.createElement("div");
  messageEmpty.className = "role-preview-message-empty";
  const emptyIcon = document.createElement("span");
  emptyIcon.className = "role-preview-message-empty-icon";
  emptyIcon.append(rolePreviewIcon(selectedChannel ? "lock-keyhole" : "eye-off"));
  const emptyTitle = document.createElement("h3");
  emptyTitle.textContent = selectedChannel ? "Message history isn't loaded" : "No rooms available";
  const emptyDescription = document.createElement("p");
  emptyDescription.textContent = selectedChannel
    ? "This role preview never fetches or decrypts messages. Your own access and keys are unchanged."
    : "No room that your account can inspect is visible to this role.";
  messageEmpty.append(emptyIcon, emptyTitle, emptyDescription);
  messageArea.append(messageEmpty);
  previewMain.append(messageArea);

  if (selectedChannel) {
    const composer = document.createElement("form");
    composer.className = "role-preview-composer";
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      feedback.textContent = "Preview only · no message was sent.";
      messageInput.value = "";
    });
    const composerBox = document.createElement("div");
    composerBox.className = "role-preview-composer-box";
    const uploadButton = document.createElement("button");
    uploadButton.type = "button";
    uploadButton.className = "icon-button";
    uploadButton.disabled = !capabilities.canUpload;
    uploadButton.title = capabilities.canUpload ? "Upload allowed · preview only" : "Uploads blocked for this role in this room";
    uploadButton.setAttribute("aria-label", uploadButton.title);
    uploadButton.append(rolePreviewIcon("paperclip"));
    uploadButton.addEventListener("click", () => {
      feedback.textContent = "Preview only · no file was uploaded.";
    });
    const messageInput = document.createElement("textarea");
    messageInput.rows = 1;
    messageInput.maxLength = 4000;
    messageInput.disabled = !capabilities.canSend;
    messageInput.placeholder = capabilities.canSend ? `Message #${channelName(selectedChannel)}` : "Sending is blocked for this role";
    messageInput.setAttribute("aria-label", "Preview message; not sent");
    const sendButton = document.createElement("button");
    sendButton.type = "submit";
    sendButton.disabled = !capabilities.canSend;
    sendButton.textContent = "Send";
    sendButton.title = capabilities.canSend ? "Send allowed · preview only" : "Sending blocked for this role";
    composerBox.append(uploadButton, messageInput, sendButton);
    composer.append(composerBox);
    const composerNote = document.createElement("span");
    composerNote.textContent = capabilities.canSend
      ? "Sending allowed · this preview never sends"
      : "Sending is blocked by this role";
    composer.append(composerNote);
    previewMain.append(composer);
  }

  const inspectorHeading = document.createElement("div");
  inspectorHeading.className = "role-preview-inspector-heading";
  const inspectorTitle = document.createElement("strong");
  inspectorTitle.textContent = "Role access";
  const inspectorTag = document.createElement("span");
  inspectorTag.textContent = "PREVIEW INSPECTOR";
  inspectorHeading.append(inspectorTitle, inspectorTag);
  previewInspector.append(inspectorHeading);
  const inspectorNote = document.createElement("p");
  inspectorNote.className = "role-preview-inspector-note";
  inspectorNote.textContent = "Only you can see these details. Member-specific bans and timeouts aren't simulated.";
  previewInspector.append(inspectorNote);

  const selectedRoomAccess = document.createElement("section");
  selectedRoomAccess.className = "role-preview-inspector-section";
  const selectedRoomHeading = document.createElement("h3");
  selectedRoomHeading.textContent = selectedChannel ? `#${channelName(selectedChannel)}` : "Room access";
  selectedRoomAccess.append(selectedRoomHeading);
  for (const [label, allowed] of [
    ["View room", capabilities.canView],
    ["Send messages", capabilities.canSend],
    ["Upload files", capabilities.canUpload],
  ] as const) {
    selectedRoomAccess.append(rolePreviewStatus(label, allowed));
  }
  const featureRows: Array<[string, boolean]> = [
    ["View people", features.canViewMembers],
    ["Manage rooms", features.canManageChannels],
    ["Manage invites", features.canManageInvites],
    ["Open space settings", features.canManageSettings],
  ];
  for (const [label, allowed] of featureRows) selectedRoomAccess.append(rolePreviewStatus(label, allowed));
  previewInspector.append(selectedRoomAccess);

  const peopleSection = document.createElement("section");
  peopleSection.className = "role-preview-inspector-section role-preview-people-section";
  const peopleHeading = document.createElement("h3");
  peopleHeading.textContent = "People";
  const peopleCount = document.createElement("span");
  peopleCount.className = "muted small";
  peopleCount.textContent = features.canViewMembers ? `${members.length} visible` : "Hidden by role";
  peopleHeading.append(peopleCount);
  peopleSection.append(peopleHeading);
  if (features.canViewMembers) {
    const peopleList = document.createElement("div");
    peopleList.className = "role-preview-people-list";
    const allMembersRole = roles.find((candidate) => candidate.systemKey === "everyone");
    const groups = new Map<string, { role?: CustomServerRole; members: ServerMember[] }>();
    for (const member of members) {
      const roleIds = normalizeRoleIds(member.roleIds ?? roleAssignments.get(member.userId) ?? []);
      const memberGroupRole = highestSeparatedRole(roleIds, roles) ?? allMembersRole;
      const key = memberGroupRole?.id ?? "participants";
      const group = groups.get(key) ?? { role: memberGroupRole, members: [] };
      group.members.push(member);
      groups.set(key, group);
    }
    let renderedMembers = 0;
    for (const group of [...groups.values()].sort((left, right) =>
      (right.role?.position ?? -1) - (left.role?.position ?? -1)
      || (left.role ? roleName(left.role) : "Participants").localeCompare(right.role ? roleName(right.role) : "Participants"))) {
      if (renderedMembers >= 12) break;
      const groupHeading = document.createElement("h4");
      groupHeading.className = "role-preview-member-group-heading";
      groupHeading.textContent = group.role ? roleName(group.role) : "Participants";
      if (group.role?.color) groupHeading.style.color = readableAccentText(group.role.color, currentAppTheme());
      peopleList.append(groupHeading);
      for (const member of group.members.sort((left, right) => left.displayName.localeCompare(right.displayName))) {
        if (renderedMembers >= 12) break;
        const row = document.createElement("div");
        row.className = "role-preview-person";
        const avatar = document.createElement("span");
        avatar.className = "member-avatar";
        renderAvatar(avatar, member.displayName, member.userId, member.avatarUrl);
        avatar.setAttribute("aria-hidden", "true");
        const copy = document.createElement("span");
        copy.className = "role-preview-person-copy";
        const name = document.createElement("strong");
        name.textContent = member.displayName;
        const username = document.createElement("small");
        username.textContent = `@${member.username}`;
        copy.append(name, username);
        row.append(avatar, copy);
        peopleList.append(row);
        renderedMembers += 1;
      }
    }
    if (members.length > 12) {
      const more = document.createElement("p");
      more.className = "muted small";
      more.textContent = `And ${members.length - 12} more people.`;
      peopleList.append(more);
    }
    if (members.length === 0) {
      const empty = document.createElement("p");
      empty.className = "role-preview-empty small";
      empty.textContent = "No other members.";
      peopleList.append(empty);
    }
    peopleSection.append(peopleList);
  } else {
    const hidden = document.createElement("p");
    hidden.className = "role-preview-empty small";
    hidden.textContent = "The people directory is hidden for this role.";
    peopleSection.append(hidden);
  }
  previewInspector.append(peopleSection);

  const permissionsSection = document.createElement("section");
  permissionsSection.className = "role-preview-inspector-section";
  const permissionsHeading = document.createElement("h3");
  permissionsHeading.textContent = "Permissions";
  permissionsSection.append(permissionsHeading);
  const permissionGroups = document.createElement("div");
  permissionGroups.className = "role-preview-permission-groups";
  for (const [groupIndex, group] of previewPermissionGroups.entries()) {
    const groupDefinitions = group.permissions
      .map((permissionId) => permissionDefinitions.find((definition) => definition.id === permissionId))
      .filter((definition): definition is typeof permissionDefinitions[number] => Boolean(definition));
    const groupDetails = document.createElement("details");
    groupDetails.className = "role-preview-permission-group";
    groupDetails.open = groupIndex === 0;
    const groupSummary = document.createElement("summary");
    const groupTitle = document.createElement("strong");
    groupTitle.textContent = group.label;
    const allowedCount = groupDefinitions.filter((definition) => permissions[definition.id]).length;
    const groupCount = document.createElement("small");
    groupCount.textContent = `${allowedCount}/${groupDefinitions.length}`;
    groupSummary.append(groupTitle, groupCount);
    const groupList = document.createElement("div");
    groupList.className = "role-preview-permission-list";
    for (const definition of groupDefinitions) {
      const allowed = permissions[definition.id];
      const row = document.createElement("div");
      row.className = `role-preview-permission ${allowed ? "allowed" : "blocked"}`;
      const statusLabel = document.createElement("span");
      statusLabel.className = "role-preview-permission-status";
      statusLabel.textContent = allowed ? "Allowed" : "Blocked";
      const text = document.createElement("span");
      text.className = "role-preview-permission-copy";
      const label = document.createElement("strong");
      label.textContent = definition.label;
      const description = document.createElement("small");
      description.textContent = definition.description;
      text.append(label, description);
      row.append(statusLabel, text);
      groupList.append(row);
    }
    groupDetails.append(groupSummary, groupList);
    permissionGroups.append(groupDetails);
  }
  permissionsSection.append(permissionGroups);
  previewInspector.append(permissionsSection);
  renderIcons(rolePreviewContent);
}

function startRolePreview(roleId: string) {
  if (roleEditorDirty && !window.confirm("This preview uses the last saved role settings. Continue without previewing your unsaved changes?")) return;
  previewRoleId = roleId;
  previewChannelId = undefined;
  renderRolePreview();
  setPreviewRoomNavigation(false);
  setPreviewInspector(!window.matchMedia("(max-width: 1000px)").matches);
  rolePreview.showModal();
}

function categoryName(category: ServerCategory) {
  return categoryNames.get(category.id) || "Unnamed category";
}

function channelName(channel: ServerChannel) {
  return channelNames.get(channel.id) || (channel.position === 0 ? "general" : `channel-${channel.position + 1}`);
}

function categoryOptions(selected: string | null) {
  const fragment = document.createDocumentFragment();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No category";
  none.selected = !selected;
  fragment.append(none);
  for (const category of categories) {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent = categoryName(category);
    option.selected = category.id === selected;
    fragment.append(option);
  }
  return fragment;
}

function renderCategoryOptions() {
  newChannelCategory.replaceChildren(categoryOptions(null));
}

function renderOnboardingOptions() {
  onboardingChannel.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No join announcements";
  none.selected = !currentServer?.onboardingChannelId;
  onboardingChannel.append(none);
  for (const channel of [...channels].sort((left, right) => left.position - right.position)) {
    const option = document.createElement("option");
    option.value = channel.id;
    option.textContent = channelName(channel);
    option.selected = channel.id === currentServer?.onboardingChannelId;
    onboardingChannel.append(option);
  }
  onboardingChannel.disabled = !hasPermission("manage_server");
}

function renderLandingOptions() {
  landingChannel.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "First visible room";
  none.selected = !currentServer?.landingChannelId;
  landingChannel.append(none);
  for (const channel of [...channels].sort((left, right) => left.position - right.position)) {
    const option = document.createElement("option");
    option.value = channel.id;
    option.textContent = channelName(channel);
    option.selected = channel.id === currentServer?.landingChannelId;
    landingChannel.append(option);
  }
  landingChannel.disabled = !hasPermission("manage_server");
}

function renderBranding() {
  serverIconPreview.replaceChildren();
  if (currentServer?.iconUrl) {
    const image = document.createElement("img");
    image.src = currentServer.iconUrl;
    image.alt = "";
    serverIconPreview.append(image);
  } else {
    serverIconPreview.textContent = serverName.value.trim().slice(0, 1).toUpperCase() || "N";
  }
  serverBannerPreview.replaceChildren();
  if (currentServer?.bannerUrl) {
    const image = document.createElement("img");
    image.src = currentServer.bannerUrl;
    image.alt = "";
    serverBannerPreview.append(image);
    delete serverBannerPreview.dataset.empty;
  } else {
    serverBannerPreview.dataset.empty = "true";
  }
  removeServerIcon.disabled = !currentServer?.iconUrl || !hasPermission("manage_server");
  removeServerBanner.disabled = !currentServer?.bannerUrl || !hasPermission("manage_server");
  serverIconInput.disabled = !hasPermission("manage_server");
  serverBannerInput.disabled = !hasPermission("manage_server");
}

function renderWelcome(metadata?: Record<string, unknown>) {
  const welcome = metadata?.welcome && typeof metadata.welcome === "object" && !Array.isArray(metadata.welcome)
    ? metadata.welcome as Record<string, unknown>
    : {};
  welcomeEnabled.checked = welcome.enabled === true;
  welcomeHeading.value = typeof welcome.heading === "string" ? welcome.heading : "";
  welcomeDescription.value = typeof welcome.description === "string" ? welcome.description : "";
  welcomeRules.value = typeof welcome.rules === "string" ? welcome.rules : "";
  welcomeAcknowledgement.checked = welcome.acknowledgement === true;
}

function renderAuditLogs() {
  auditList.replaceChildren();
  if (auditLogs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = hasPermission("view_audit_logs") ? "No space activity has been recorded yet." : "You do not have permission to view this log.";
    auditList.append(empty);
    return;
  }
  for (const log of auditLogs) {
    const row = document.createElement("div");
    row.className = "settings-list-row audit-log-row";
    const icon = document.createElement("span");
    icon.className = "audit-log-icon";
    icon.textContent = "•";
    const copy = document.createElement("div");
    copy.className = "settings-row-copy";
    const action = document.createElement("strong");
    action.textContent = log.action.replaceAll(".", " · ");
    const details = document.createElement("span");
    const target = log.targetId ? ` · ${log.targetId.slice(0, 8)}` : "";
    details.textContent = `${log.actor.displayName} (@${log.actor.username})${target} · ${new Date(log.createdAt).toLocaleString()}`;
    copy.append(action, details);
    row.append(icon, copy);
    auditList.append(row);
  }
}

function renderCustomEmojis() {
  emojiList.replaceChildren();
  if (customEmojis.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "No custom emoji yet.";
    emojiList.append(empty);
    return;
  }
  for (const emoji of customEmojis) {
    const row = document.createElement("div");
    row.className = "settings-list-row custom-emoji-row";
    row.dataset.emojiId = emoji.id;
    const preview = document.createElement("span");
    preview.className = "custom-emoji-preview";
    preview.textContent = "✦";
    const previewUrl = customEmojiPreviewUrls.get(emoji.id);
    if (previewUrl) {
      const image = document.createElement("img");
      image.src = previewUrl;
      image.alt = `:${customEmojiNames.get(emoji.id) ?? "emoji"}:`;
      preview.replaceChildren(image);
    } else preview.title = emoji.status === "uploaded" ? "Preview unavailable or still loading" : "Upload pending";
    const copy = document.createElement("div");
    copy.className = "settings-row-copy";
    const name = document.createElement("strong");
    name.textContent = `:${customEmojiNames.get(emoji.id) ?? "encrypted_emoji"}:`;
    const details = document.createElement("span");
    details.textContent = emoji.status === "uploaded"
      ? `${Math.round((emoji.sizeBytes ?? emoji.expectedSizeBytes) / 1024)} KiB · encrypted`
      : "Upload pending";
    copy.append(name, details);
    row.append(preview, copy);
    if (hasPermission("manage_custom_emoji")) {
      const metadata = customEmojiMetadata.get(emoji.id);
      if (metadata && customEmojiNames.has(emoji.id)) {
        const form = document.createElement("form");
        form.className = "emoji-rename-form";
        const input = document.createElement("input");
        input.value = customEmojiNames.get(emoji.id)!;
        input.maxLength = 32;
        input.pattern = "[A-Za-z0-9_+-]+";
        input.required = true;
        input.setAttribute("aria-label", `Name for ${input.value}`);
        const save = document.createElement("button");
        save.type = "submit";
        save.className = "secondary";
        save.textContent = "Save";
        save.disabled = true;
        input.addEventListener("input", () => { save.disabled = input.value.trim() === customEmojiNames.get(emoji.id); });
        form.append(input, save);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const nextName = input.value.trim();
          if (!metadataReady || !metadataConversationId || !/^[A-Za-z0-9_+-]{1,32}$/.test(nextName)) return;
          if ([...customEmojiNames].some(([id, name]) => id !== emoji.id && name.toLowerCase() === nextName.toLowerCase())) {
            setStatus("That custom emoji name is already in use.", true);
            return;
          }
          save.disabled = true;
          input.disabled = true;
          try {
            const encryptedMetadata = await encryptMetadata(metadataConversationId, { ...metadata, name: nextName });
            await api.updateServerCustomEmoji(currentServer!.id, emoji.id, encryptedMetadata);
            await loadData();
            setStatus("Custom emoji renamed.");
          } catch (error) {
            input.disabled = false;
            save.disabled = false;
            setStatus(readableError(error), true);
          }
        });
        row.append(form);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await api.removeServerCustomEmoji(currentServer!.id, emoji.id);
          customEmojiNames.delete(emoji.id);
          await loadData();
          setStatus("Custom emoji removed.");
        } catch (error) {
          setStatus(readableError(error), true);
          remove.disabled = false;
        }
      });
      row.append(remove);
    }
    emojiList.append(row);
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function encryptCustomEmoji(file: File) {
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const bytes = new Uint8Array(iv.byteLength + encrypted.byteLength);
  bytes.set(iv, 0);
  bytes.set(encrypted, iv.byteLength);
  return {
    bytes,
    key: bytesToBase64(rawKey),
    iv: bytesToBase64(iv),
  };
}

function renderCategories() {
  categoryList.replaceChildren();
  if (categories.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "No categories yet.";
    categoryList.append(empty);
    renderCategoryOptions();
    return;
  }
  for (const category of categories) {
    const row = document.createElement("div");
    row.className = "settings-list-row";
    bindRoomDropTarget(row, category.id);
    const name = document.createElement("input");
    name.value = categoryName(category);
    name.maxLength = 80;
    name.setAttribute("aria-label", "Category name");
    const position = document.createElement("input");
    position.type = "number";
    position.min = "0";
    position.value = String(category.position);
    position.className = "position-input";
    position.setAttribute("aria-label", "Category order");
    const canEditCategories = hasAnyPermission("manage_channels", "manage_categories");
    name.disabled = !canEditCategories || !metadataReady;
    position.disabled = !canEditCategories || !metadataReady;
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save";
    save.disabled = !canEditCategories || !metadataReady;
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const normalized = name.value.trim();
        if (!normalized) throw new Error("Category name is required.");
        const encryptedMetadata = await encryptMetadata(metadataConversationId!, { name: normalized, kind: "category" });
        await api.updateCategory(currentServer!.id, category.id, { encryptedMetadata, position: Math.max(0, Number(position.value) || 0) });
        categoryNames.set(category.id, normalized);
        setStatus("Category saved.");
        await loadData();
      } catch (error) {
        setStatus(readableError(error), true);
      } finally {
        save.disabled = false;
      }
    });
    const archive = document.createElement("button");
    archive.className = "danger-button";
    archive.type = "button";
    archive.textContent = "Archive";
    archive.disabled = !canEditCategories;
    archive.addEventListener("click", async () => {
      if (!window.confirm(`Archive ${name.value || "this group"}? Rooms will become ungrouped.`)) return;
      archive.disabled = true;
      try {
        await api.deleteCategory(currentServer!.id, category.id);
        await loadData();
        setStatus("Category archived.");
      } catch (error) {
        setStatus(readableError(error), true);
        archive.disabled = false;
      }
    });
    row.append(name, position, save, archive);
    categoryList.append(row);
  }
  renderCategoryOptions();
}

async function saveChannel(channel: ServerChannel, name: HTMLInputElement, category: HTMLSelectElement, position: HTMLInputElement, button: HTMLButtonElement) {
  button.disabled = true;
  try {
    const normalized = name.value.trim();
    if (!normalized) throw new Error("Channel name is required.");
    const updates: Parameters<ApiClient["updateChannel"]>[2] = {};
    if (hasAnyPermission("manage_channels", "edit_channels")) {
      const channelMembers = await prepareConversation(channel.conversationId);
      updates.encryptedMetadata = await cryptoClient!.encryptMetadata(channel.conversationId, channelMembers, { name: normalized, kind: channel.kind });
      updates.categoryId = category.value || null;
    }
    if (hasAnyPermission("manage_channels", "reorder_channels")) {
      updates.position = Math.max(0, Number(position.value) || 0);
    }
    if (Object.keys(updates).length === 0) return;
    await api.updateChannel(currentServer!.id, channel.id, updates);
    channelNames.set(channel.id, normalized);
    setStatus("Channel saved.");
    await loadData();
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    button.disabled = false;
  }
}

function renderChannels() {
  channelList.replaceChildren();
  const groups = [
    { id: null as string | null, name: "No category" },
    ...[...categories].sort((a, b) => a.position - b.position).map((category) => ({ id: category.id, name: categoryNames.get(category.id) ?? "Encrypted group" })),
  ];
  for (const group of groups) {
    const heading = document.createElement("div");
    heading.className = "room-sort-group";
    heading.textContent = group.name;
    heading.setAttribute("aria-label", `${group.name} — drop a room here`);
    bindRoomDropTarget(heading, group.id);
    channelList.append(heading);
    for (const channel of channels.filter((room) => room.categoryId === group.id).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))) {
    const row = document.createElement("div");
    row.className = "settings-list-row channel-settings-row";
    row.dataset.channelId = channel.id;
    bindRoomDropTarget(row, group.id, channel.id);
    const handle = document.createElement("span");
    handle.className = "room-drag-handle";
    handle.textContent = "⠿";
    handle.title = "Drag to reorder or move to a group. You can also use the category and order fields.";
    handle.setAttribute("aria-hidden", "true");
    handle.draggable = metadataReady && hasAnyPermission("manage_channels", "reorder_channels", "edit_channels");
    handle.addEventListener("dragstart", (event) => {
      if (roomSortSaving || !handle.draggable || !event.dataTransfer) { event.preventDefault(); return; }
      draggedRoomId = channel.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", channel.id);
      row.classList.add("room-dragging");
    });
    handle.addEventListener("dragend", () => {
      draggedRoomId = undefined;
      row.classList.remove("room-dragging");
      document.querySelectorAll(".room-drop-target").forEach((target) => target.classList.remove("room-drop-target"));
    });
    const name = document.createElement("input");
    const fallbackName = channelName(channel);
    name.value = fallbackName;
    name.dataset.fallbackName = fallbackName;
    name.maxLength = 80;
    name.setAttribute("aria-label", "Channel name");
    const category = document.createElement("select");
    category.setAttribute("aria-label", "Channel category");
    category.append(categoryOptions(channel.categoryId));
    const kind = document.createElement("span");
    kind.className = "channel-kind-badge";
    kind.textContent = channel.kind === "voice" ? "Voice" : "Text";
    const position = document.createElement("input");
    position.type = "number";
    position.min = "0";
    position.value = String(channel.position);
    position.className = "position-input";
    position.setAttribute("aria-label", "Channel order");
    name.disabled = !hasAnyPermission("manage_channels", "edit_channels") || !metadataReady;
    category.disabled = !hasAnyPermission("manage_channels", "edit_channels") || !metadataReady;
    position.disabled = !hasAnyPermission("manage_channels", "reorder_channels") || !metadataReady;
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save";
    save.disabled = !hasAnyPermission("manage_channels", "edit_channels", "reorder_channels") || !metadataReady;
    save.addEventListener("click", () => void saveChannel(channel, name, category, position, save));
    const archive = document.createElement("button");
    archive.className = "danger-button";
    archive.type = "button";
    archive.textContent = "Archive";
    archive.disabled = !hasAnyPermission("manage_channels", "archive_channels");
    archive.addEventListener("click", async () => {
      if (!window.confirm(`Archive ${name.value || "this channel"}?`)) return;
      archive.disabled = true;
      try {
        await api.deleteChannel(currentServer!.id, channel.id);
        await loadData();
        setStatus("Channel archived.");
      } catch (error) {
        setStatus(readableError(error), true);
        archive.disabled = false;
      }
    });
    row.append(handle, name, kind, category, position, save, archive);
    channelList.append(row);
    }
  }
  if (channels.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "No active encrypted rooms.";
    channelList.append(empty);
  }
}

let draggedRoomId: string | undefined;
let roomSortSaving = false;

function bindRoomDropTarget(target: HTMLElement, categoryId: string | null, beforeId?: string) {
  const allowed = () => {
    const room = channels.find((channel) => channel.id === draggedRoomId);
    if (!room || !metadataReady || roomSortSaving || beforeId === room.id) return false;
    if (room.categoryId !== categoryId && !hasAnyPermission("manage_channels", "edit_channels")) return false;
    return !beforeId || hasAnyPermission("manage_channels", "reorder_channels");
  };
  target.addEventListener("dragover", (event) => {
    if (!allowed()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    target.classList.add("room-drop-target");
  });
  target.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
    target.classList.remove("room-drop-target");
  });
  target.addEventListener("drop", (event) => {
    target.classList.remove("room-drop-target");
    if (!allowed() || !draggedRoomId) return;
    event.preventDefault();
    const roomId = draggedRoomId;
    draggedRoomId = undefined;
    void persistRoomDrop(roomId, categoryId, beforeId);
  });
}

async function persistRoomDrop(roomId: string, categoryId: string | null, beforeId?: string) {
  if (!currentServer || roomSortSaving) return;
  const unsaved = [...channelList.querySelectorAll<HTMLElement>(".channel-settings-row")].some((row) => {
    const channel = channels.find((room) => room.id === row.dataset.channelId);
    const name = row.querySelector<HTMLInputElement>('input[aria-label="Channel name"]');
    const category = row.querySelector<HTMLSelectElement>("select");
    const position = row.querySelector<HTMLInputElement>('input[type="number"]');
    return channel && (name?.value !== name?.dataset.fallbackName || (category?.value || null) !== channel.categoryId || Number(position?.value) !== channel.position);
  });
  if (unsaved && !window.confirm("Moving this room will reload the list and discard unsaved room fields. Continue?")) return;
  const canReorder = hasAnyPermission("manage_channels", "reorder_channels");
  const updates = canReorder ? roomDropUpdates(channels, roomId, categoryId, beforeId)
    : channels.find((room) => room.id === roomId)?.categoryId !== categoryId ? [{ id: roomId, categoryId }] : [];
  if (!updates.length) return;
  roomSortSaving = true;
  channelList.setAttribute("aria-busy", "true");
  try {
    for (const { id, ...update } of updates) await api.updateChannel(currentServer.id, id, update);
    setStatus("Room order saved.");
  } catch (error) {
    setStatus(`Could not finish moving the room: ${readableError(error)}`, true);
  } finally {
    roomSortSaving = false;
    channelList.removeAttribute("aria-busy");
    await loadData().catch((error) => setStatus(readableError(error), true));
  }
}

function closeRoleEditor(focusList = true) {
  if (!roleEditorOpen) return true;
  if (roleEditorDirty && !window.confirm("Discard unsaved role changes?")) return false;
  roleEditorOpen = false;
  roleEditorDirty = false;
  renderRoles();
  if (focusList) {
    roleList.scrollIntoView({ block: "start" });
    const row = [...roleList.querySelectorAll<HTMLElement>("[data-role-id]")].find((item) => item.dataset.roleId === selectedRoleId);
    (row?.querySelector<HTMLButtonElement>("button") ?? roleList.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
  }
  return true;
}

function renderRoles() {
  roleList.replaceChildren();
  if (roles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "No roles have been configured yet.";
    roleList.append(empty);
    renderRolePreview();
    renderOnboardingOptions();
    renderLandingOptions();
    return;
  }
  const editableRoles = roles.filter((role) => role.systemKey !== "owner");
  if (editableRoles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "No editable roles have been configured yet.";
    roleList.append(empty);
    renderRolePreview();
    return;
  }
  if (!selectedRoleId || !editableRoles.some((role) => role.id === selectedRoleId)) {
    selectedRoleId = editableRoles[0].id;
    roleEditorDirty = false;
  }
  const canManageRoles = hasAnyPermission(
    "manage_roles",
    "delete_roles",
    "edit_roles",
    "reorder_roles",
    "manage_role_permissions",
    "manage_role_appearance",
    "manage_channel_access",
  );
  const manager = roleList;
  manager.classList.toggle("role-manager-editing", roleEditorOpen);

  const selectRoleEditor = (id: string) => {
    if (roleEditorDirty && !window.confirm("Discard unsaved role changes?")) return;
    selectedRoleId = id;
    roleEditorDirty = false;
    roleEditorOpen = true;
    renderRoles();
  };
  const ownRoleIds = normalizeRoleIds(members.find((member) => member.userId === currentUserId)?.roleIds ?? roleAssignments.get(currentUserId ?? "") ?? []);
  const hierarchyCeiling = currentServer?.role === "owner" ? Infinity : Math.max(0, ...roles.filter((role) => ownRoleIds.includes(role.id)).map((role) => role.position));
  const canDragRole = (role: CustomServerRole) => metadataReady && canReorderRoles() && !roleSortSaving && !role.isSystem && role.position < hierarchyCeiling;

  const listPanel = document.createElement("aside");
  listPanel.className = "role-list-panel";
  const listHeading = document.createElement("div");
  listHeading.className = "role-list-heading";
  const listTitle = document.createElement("strong");
  listTitle.textContent = "Roles";
  const listCount = document.createElement("span");
  listCount.className = "muted small";
  listCount.textContent = `${editableRoles.filter((role) => role.systemKey !== "everyone").length} roles`;
  listHeading.append(listTitle, listCount);
  const search = document.createElement("input");
  search.type = "search";
  search.className = "role-search";
  search.placeholder = "Find a role";
  search.setAttribute("aria-label", "Find a role");
  search.value = roleSearchQuery;
  const listItems = document.createElement("div");
  listItems.className = "role-list-items";
  listItems.setAttribute("role", "list");
  listItems.setAttribute("aria-label", "Roles");

  const renderRoleList = () => {
    listItems.replaceChildren();
    const query = roleSearchQuery.trim().toLocaleLowerCase();
    const visibleRoles = editableRoles.filter((role) => role.systemKey !== "everyone" && (!query || roleName(role).toLocaleLowerCase().includes(query)))
      .sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
    if (visibleRoles.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small role-list-empty";
      empty.textContent = "No matching roles.";
      listItems.append(empty);
      return;
    }
    for (const role of visibleRoles) {
      const item = document.createElement("div");
      item.className = "role-list-item";
      item.setAttribute("role", "listitem");
      item.dataset.roleId = role.id;
      const grip = document.createElement("span");
      grip.className = "role-drag-grip";
      grip.textContent = "⠿";
      grip.draggable = canDragRole(role);
      grip.title = grip.draggable ? "Drag to reorder role" : "Role ordering is restricted by permissions and hierarchy";
      grip.setAttribute("aria-hidden", "true");
      grip.addEventListener("dragstart", (event) => {
        if (!canDragRole(role) || !event.dataTransfer) { event.preventDefault(); return; }
        draggedRoleId = role.id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", role.id);
        item.classList.add("role-dragging");
      });
      grip.addEventListener("dragend", () => {
        draggedRoleId = undefined;
        item.classList.remove("role-dragging");
        listItems.querySelectorAll(".role-drop-before, .role-drop-after").forEach((row) => row.classList.remove("role-drop-before", "role-drop-after"));
      });
      let dropAfter = false;
      item.addEventListener("dragover", (event) => {
        if (!draggedRoleId || draggedRoleId === role.id || !canDragRole(role)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        const rect = item.getBoundingClientRect();
        dropAfter = event.clientY >= rect.top + rect.height / 2;
        item.classList.toggle("role-drop-before", !dropAfter);
        item.classList.toggle("role-drop-after", dropAfter);
      });
      item.addEventListener("dragleave", (event) => {
        if (event.relatedTarget instanceof Node && item.contains(event.relatedTarget)) return;
        item.classList.remove("role-drop-before", "role-drop-after");
      });
      item.addEventListener("drop", (event) => {
        item.classList.remove("role-drop-before", "role-drop-after");
        if (!draggedRoleId || !canDragRole(role)) return;
        event.preventDefault();
        const movedId = draggedRoleId;
        draggedRoleId = undefined;
        void (async () => {
          if (roleEditorDirty && !window.confirm("Discard unsaved role changes and reorder?")) return;
          roleSortSaving = true;
          manager.setAttribute("aria-busy", "true");
          try {
            for (const update of roleDropUpdates(roles, movedId, role.id, dropAfter, hierarchyCeiling)) {
              await api.updateServerRole(currentServer!.id, update.id, { position: update.position });
            }
            roleEditorDirty = false;
            setStatus("Role order saved.");
          } catch (error) { setStatus(readableError(error), true); }
          finally {
            roleSortSaving = false;
            manager.removeAttribute("aria-busy");
            await loadData().catch((error) => setStatus(readableError(error), true));
          }
        })();
      });
      item.style.setProperty("--role-color", role.color);
      item.style.setProperty("--role-text-color", readableAccentText(role.color, currentAppTheme()));
      const swatch = document.createElement("span");
      swatch.className = "role-color-swatch";
      swatch.style.background = role.color;
      const copy = document.createElement("span");
      copy.className = "role-list-copy";
      const name = document.createElement("strong");
      name.textContent = roleName(role);
      const meta = document.createElement("span");
      meta.textContent = role.isSystem ? "System role" : "";
      copy.append(name, meta);
      const count = document.createElement("span");
      count.className = "role-member-count";
      const memberCount = members.filter((member) => normalizeRoleIds(member.roleIds ?? roleAssignments.get(member.userId) ?? []).includes(role.id)).length;
      count.textContent = String(memberCount);
      count.setAttribute("aria-label", `${memberCount} members`);
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "icon-button";
      edit.append(iconElement("pencil"));
      edit.title = `Edit ${roleName(role)}`;
      edit.setAttribute("aria-label", edit.title);
      edit.addEventListener("click", () => selectRoleEditor(role.id));
      const menu = document.createElement("details");
      menu.className = "role-row-menu";
      const summary = document.createElement("summary");
      summary.textContent = "•••";
      summary.setAttribute("aria-label", `Actions for ${roleName(role)}`);
      const actions = document.createElement("div");
      const permissions = document.createElement("button");
      permissions.type = "button";
      permissions.textContent = "Permissions & access";
      permissions.addEventListener("click", () => selectRoleEditor(role.id));
      actions.append(permissions);
      if (!role.isSystem && hasAnyPermission("manage_roles", "delete_roles") && role.position < hierarchyCeiling) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "danger-button";
        remove.textContent = "Delete role";
        remove.addEventListener("click", async () => {
          if (!currentServer || !window.confirm(`Delete ${roleName(role)}? Members keep access only through other roles.`)) return;
          remove.disabled = true;
          try { await api.deleteServerRole(currentServer.id, role.id); await loadData(); setStatus("Role deleted."); }
          catch (error) { remove.disabled = false; setStatus(readableError(error), true); }
        });
        actions.append(remove);
      }
      menu.append(summary, actions);
      item.append(grip, swatch, copy, count, edit, menu);
      listItems.append(item);
    }
  };
  search.addEventListener("input", () => {
    roleSearchQuery = search.value;
    renderRoleList();
  });
  listPanel.append(listHeading, search, listItems);
  const columns = document.createElement("div");
  columns.className = "role-list-columns";
  const roleColumn = document.createElement("span");
  roleColumn.textContent = "Role";
  const memberColumn = document.createElement("span");
  memberColumn.textContent = "Members";
  columns.append(roleColumn, memberColumn);
  listItems.before(columns);
  const everyone = editableRoles.find((role) => role.systemKey === "everyone");
  if (everyone) {
    const defaults = document.createElement("button");
    defaults.type = "button";
    defaults.className = "role-default-permissions";
    const title = document.createElement("strong");
    title.textContent = "Default permissions";
    const description = document.createElement("span");
    description.textContent = "All members · applies to everyone in this space";
    defaults.append(title, description, iconElement("chevron-right"));
    defaults.addEventListener("click", () => selectRoleEditor(everyone.id));
    listPanel.prepend(defaults);
  }

  const role = editableRoles.find((candidate) => candidate.id === selectedRoleId) ?? editableRoles[0];
  const ownerRole = role.systemKey === "owner";
  const everyoneRole = role.systemKey === "everyone";
  const editableSystemRole = currentServer?.role === "owner" && role.systemKey !== "owner";
  const canEditThisRole = (!role.isSystem && role.position < hierarchyCeiling) || editableSystemRole;
  const canEditName = canEditThisRole && canEditRoleName();
  const canEditAppearance = canEditThisRole && canEditRoleAppearance();
  const canEditPermissions = canEditThisRole && canEditRolePermissions();
  const canEditRolePosition = canEditThisRole && canReorderRoles();
  const canEditChannelAccess = canEditThisRole && canManageRoleAccess();
  const canEditSeparation = canEditThisRole && !everyoneRole && canEditRoleAppearance();
  const card = document.createElement("article");
  card.className = "role-settings-card role-editor";
  card.style.setProperty("--role-color", role.color);

  const markDirty = () => {
    roleEditorDirty = true;
  };
  const heading = document.createElement("div");
  heading.className = "role-card-heading";
  const identity = document.createElement("div");
  identity.className = "role-card-identity";
  const swatch = document.createElement("span");
  swatch.className = "role-color-swatch";
  swatch.style.background = role.color;
  const headingCopy = document.createElement("div");
  const headingName = document.createElement("strong");
  headingName.textContent = roleName(role);
  const headingMeta = document.createElement("span");
  headingMeta.textContent = role.isSystem
    ? `System role · position ${role.position}`
    : `Custom role · position ${role.position}`;
  headingCopy.append(headingName, headingMeta);
  identity.append(swatch, headingCopy);
  heading.append(identity);
  const back = document.createElement("button");
  back.type = "button";
  back.className = "secondary";
  back.textContent = "Back to roles";
  back.addEventListener("click", () => closeRoleEditor());
  heading.append(back);
  if (role.systemKey === "owner") {
    const owner = members.find((member) => member.userId === currentServer?.ownerId);
    const ownerLabel = document.createElement("span");
    ownerLabel.className = "role-system-owner";
    ownerLabel.textContent = owner ? `${owner.displayName} · cannot be pinged` : "Space owner · cannot be pinged";
    heading.append(ownerLabel);
  }
  card.append(heading);

  const form = document.createElement("div");
  form.className = "role-card-form";
  const name = document.createElement("input");
  name.value = roleName(role);
  name.maxLength = 80;
  name.setAttribute("aria-label", `${roleName(role)} name`);
  name.disabled = ownerRole || everyoneRole || !canEditName || !metadataReady;
  name.addEventListener("input", markDirty);
  const color = document.createElement("input");
  color.type = "color";
  color.value = role.color;
  color.setAttribute("aria-label", `${roleName(role)} color`);
  color.disabled = ownerRole || everyoneRole || !canEditAppearance || !metadataReady;
  color.addEventListener("change", markDirty);
  const position = document.createElement("input");
  position.type = "number";
  position.min = "0";
  position.max = "1000000";
  position.value = String(role.position);
  position.className = "position-input";
  position.setAttribute("aria-label", `${roleName(role)} position`);
  position.disabled = ownerRole || everyoneRole || !canEditRolePosition || !metadataReady;
  position.addEventListener("input", markDirty);
  form.append(name, color, position);
  card.append(form);

  const controls = document.createElement("div");
  controls.className = "role-card-controls";
  const mentionableLabel = document.createElement("label");
  mentionableLabel.className = "checkbox-label role-toggle";
  const mentionable = document.createElement("input");
  mentionable.type = "checkbox";
  mentionable.checked = role.mentionable;
  mentionable.disabled = ownerRole || everyoneRole || !canEditAppearance || !metadataReady;
  mentionable.addEventListener("change", markDirty);
  const mentionableText = document.createElement("span");
  mentionableText.textContent = "Mentionable role";
  mentionableLabel.append(mentionable, mentionableText);
  const separateMembersLabel = document.createElement("label");
  separateMembersLabel.className = "checkbox-label role-toggle role-separation-toggle";
  const separateMembers = document.createElement("input");
  separateMembers.type = "checkbox";
  separateMembers.checked = role.separateMembers;
  separateMembers.disabled = !canEditSeparation || !metadataReady;
  separateMembers.addEventListener("change", markDirty);
  const separateMembersCopy = document.createElement("span");
  separateMembersCopy.className = "role-separation-copy";
  const separateMembersText = document.createElement("strong");
  separateMembersText.textContent = "Separate from others";
  const separateMembersDescription = document.createElement("small");
  separateMembersDescription.textContent = everyoneRole
    ? "All members is already the default group."
    : "Members with multiple separated roles are grouped by their highest-priority role.";
  separateMembersCopy.append(separateMembersText, separateMembersDescription);
  separateMembersLabel.append(separateMembers, separateMembersCopy);
  const viewAllLabel = document.createElement("label");
  viewAllLabel.className = "checkbox-label role-toggle";
  const viewAll = document.createElement("input");
  viewAll.type = "checkbox";
  viewAll.checked = role.viewAllChannels;
  viewAll.disabled = ownerRole || !canEditChannelAccess || !metadataReady;
  viewAll.addEventListener("change", markDirty);
  const viewAllText = document.createElement("span");
  viewAllText.textContent = "View every room";
  viewAllLabel.append(viewAll, viewAllText);
  controls.append(mentionableLabel, viewAllLabel, separateMembersLabel);
  card.append(controls);

  const permissionsHeading = document.createElement("h3");
  permissionsHeading.className = "role-card-subheading";
  permissionsHeading.textContent = "Permissions";
  card.append(permissionsHeading);
  const permissionSections = document.createElement("div");
  permissionSections.className = "role-permission-groups";
  const permissionInputs = new Map<ServerPermission, HTMLInputElement>();
  for (const [groupIndex, group] of previewPermissionGroups.entries()) {
    const definitions = permissionDefinitions.filter((definition) => group.permissions.includes(definition.id));
    const section = document.createElement("details");
    section.className = "role-permission-section";
    section.open = groupIndex === 0;
    const summary = document.createElement("summary");
    summary.className = "role-permission-summary";
    const groupName = document.createElement("strong");
    groupName.textContent = group.label;
    const enabledCount = document.createElement("span");
    enabledCount.className = "muted small";
    const updateEnabledCount = () => {
      const enabled = definitions.filter((definition) => permissionInputs.get(definition.id)?.checked).length;
      enabledCount.textContent = `${enabled} of ${definitions.length} enabled`;
    };
    summary.append(groupName, enabledCount);
    const permissionGrid = document.createElement("div");
    permissionGrid.className = "role-permission-grid";
    for (const definition of definitions) {
      const label = document.createElement("label");
      label.className = "permission-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = role.permissions[definition.id];
      checkbox.disabled = ownerRole || !canEditPermissions || !metadataReady;
      checkbox.addEventListener("change", () => {
        markDirty();
        updateEnabledCount();
      });
      permissionInputs.set(definition.id, checkbox);
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = definition.label;
      const description = document.createElement("small");
      description.textContent = definition.description;
      copy.append(title, description);
      label.append(checkbox, copy);
      permissionGrid.append(label);
    }
    updateEnabledCount();
    section.append(summary, permissionGrid);
    permissionSections.append(section);
  }
  card.append(permissionSections);

  const channelSection = document.createElement("details");
  channelSection.className = "role-access-section";
  const channelSummary = document.createElement("summary");
  channelSummary.className = "role-access-summary";
  channelSummary.textContent = `Room access · ${channels.length} rooms`;
  channelSection.append(channelSummary);
  const accessGrid = document.createElement("div");
  accessGrid.className = "role-channel-access-grid";
  const channelInputs = new Map<string, { view: HTMLInputElement; upload: HTMLInputElement }>();
  for (const channel of channels) {
    const access = role.channelAccess.find((item) => item.channelId === channel.id);
    const row = document.createElement("div");
    row.className = "role-channel-access-row";
    row.dataset.channelId = channel.id;
    const label = document.createElement("strong");
    label.className = "role-channel-name";
    label.textContent = channelName(channel);
    const viewLabel = document.createElement("label");
    viewLabel.className = "checkbox-label";
    const view = document.createElement("input");
    view.type = "checkbox";
    view.checked = Boolean(access?.canView || access?.canUpload);
    view.disabled = ownerRole || !canEditChannelAccess || role.viewAllChannels || !metadataReady;
    view.addEventListener("change", markDirty);
    const viewText = document.createElement("span");
    viewText.textContent = "View";
    viewLabel.append(view, viewText);
    const uploadLabel = document.createElement("label");
    uploadLabel.className = "checkbox-label";
    const upload = document.createElement("input");
    upload.type = "checkbox";
    upload.checked = Boolean(access?.canUpload);
    upload.disabled = ownerRole || !canEditChannelAccess || role.viewAllChannels || !role.permissions.upload_files || !metadataReady;
    upload.addEventListener("change", () => {
      markDirty();
      if (upload.checked) view.checked = true;
    });
    const uploadText = document.createElement("span");
    uploadText.textContent = "Upload";
    uploadLabel.append(upload, uploadText);
    row.append(label, viewLabel, uploadLabel);
    accessGrid.append(row);
    channelInputs.set(channel.id, { view, upload });
  }
  if (channels.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "Create a room before restricting this role.";
    accessGrid.append(empty);
  }
  channelSection.append(accessGrid);
  card.append(channelSection);

  const categorySection = document.createElement("details");
  categorySection.className = "role-access-section";
  const categorySummary = document.createElement("summary");
  categorySummary.className = "role-access-summary";
  categorySummary.textContent = `Group access · ${categories.length} groups`;
  categorySection.append(categorySummary);
  const categoryAccessGrid = document.createElement("div");
  categoryAccessGrid.className = "role-channel-access-grid";
  const categoryInputs = new Map<string, { view: HTMLInputElement; upload: HTMLInputElement }>();
  for (const category of categories) {
    const access = (role.categoryAccess ?? []).find((item) => item.categoryId === category.id);
    const row = document.createElement("div");
    row.className = "role-channel-access-row";
    row.dataset.categoryId = category.id;
    const label = document.createElement("strong");
    label.className = "role-channel-name";
    label.textContent = categoryName(category);
    const viewLabel = document.createElement("label");
    viewLabel.className = "checkbox-label";
    const view = document.createElement("input");
    view.type = "checkbox";
    view.checked = Boolean(access?.canView || access?.canUpload);
    view.disabled = ownerRole || !canEditChannelAccess || role.viewAllChannels || !metadataReady;
    view.addEventListener("change", markDirty);
    const viewText = document.createElement("span");
    viewText.textContent = "View";
    viewLabel.append(view, viewText);
    const uploadLabel = document.createElement("label");
    uploadLabel.className = "checkbox-label";
    const upload = document.createElement("input");
    upload.type = "checkbox";
    upload.checked = Boolean(access?.canUpload);
    upload.disabled = ownerRole || !canEditChannelAccess || role.viewAllChannels || !role.permissions.upload_files || !metadataReady;
    upload.addEventListener("change", () => {
      markDirty();
      if (upload.checked) view.checked = true;
    });
    const uploadText = document.createElement("span");
    uploadText.textContent = "Upload";
    uploadLabel.append(upload, uploadText);
    row.append(label, viewLabel, uploadLabel);
    categoryAccessGrid.append(row);
    categoryInputs.set(category.id, { view, upload });
  }
  if (categories.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "Create a category before restricting this role by category.";
    categoryAccessGrid.append(empty);
  }
  categorySection.append(categoryAccessGrid);
  card.append(categorySection);

  const actions = document.createElement("div");
  actions.className = "role-card-actions";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "secondary role-editor-exit";
  done.textContent = "Back to roles";
  done.addEventListener("click", () => closeRoleEditor());
  actions.append(done);
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "secondary";
  preview.textContent = previewRoleId === role.id ? "Previewing role" : "View as role";
  preview.disabled = !metadataReady;
  preview.setAttribute("aria-pressed", String(previewRoleId === role.id));
  preview.addEventListener("click", () => startRolePreview(role.id));
  actions.append(preview);
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save role";
  save.disabled = ownerRole || !canManageRoles || !canEditThisRole || !metadataReady;
  save.addEventListener("click", async () => {
    if (!currentServer || !metadataConversationId) return;
    save.disabled = true;
    try {
      const updates: Parameters<ApiClient["updateServerRole"]>[2] = {};
      if (canEditName && !ownerRole && !everyoneRole) {
        updates.encryptedMetadata = await encryptMetadata(metadataConversationId, { name: name.value.trim(), kind: "server-role" });
      }
      if (canEditAppearance && !ownerRole && !everyoneRole) {
        updates.color = color.value;
        updates.mentionable = mentionable.checked;
      }
      if (canEditSeparation) updates.separateMembers = separateMembers.checked;
      if (canEditRolePosition && !ownerRole && !everyoneRole) {
        updates.position = Math.max(0, Number(position.value) || 0);
      }
      if (canEditPermissions && !ownerRole) {
        updates.permissions = Object.fromEntries(permissionDefinitions.map((definition) => [
          definition.id,
          permissionInputs.get(definition.id)!.checked,
        ])) as Partial<ServerPermissionMap>;
      }
      if (canEditChannelAccess && !ownerRole) updates.viewAllChannels = viewAll.checked;
      if (Object.keys(updates).length === 0) return;
      await api.updateServerRole(currentServer.id, role.id, updates);
      for (const channel of channels) {
        const inputs = channelInputs.get(channel.id);
        if (!inputs || viewAll.checked || ownerRole || !canEditChannelAccess) continue;
        if (!inputs.view.checked && !inputs.upload.checked) {
          await api.removeServerRoleChannelAccess(currentServer.id, role.id, channel.id);
        } else {
          await api.updateServerRoleChannelAccess(currentServer.id, role.id, channel.id, inputs.view.checked, inputs.upload.checked);
        }
      }
      for (const category of categories) {
        const inputs = categoryInputs.get(category.id);
        if (!inputs || viewAll.checked || ownerRole || !canEditChannelAccess) continue;
        if (!inputs.view.checked && !inputs.upload.checked) {
          await api.removeServerRoleCategoryAccess(currentServer.id, role.id, category.id);
        } else {
          await api.updateServerRoleCategoryAccess(currentServer.id, role.id, category.id, inputs.view.checked, inputs.upload.checked);
        }
      }
      roleEditorDirty = false;
      await loadData();
      setStatus("Role saved.");
    } catch (error) {
      setStatus(readableError(error), true);
      save.disabled = false;
    }
  });
  actions.append(save);
  if (!role.isSystem) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "Delete role";
    remove.disabled = !hasAnyPermission("manage_roles", "delete_roles") || !canEditThisRole;
    remove.addEventListener("click", async () => {
      if (!currentServer || !window.confirm(`Delete ${roleName(role)}? People will keep access only through their other roles.`)) return;
      remove.disabled = true;
      try {
        roleEditorDirty = false;
        await api.deleteServerRole(currentServer.id, role.id);
        await loadData();
        setStatus("Role deleted.");
      } catch (error) {
        setStatus(readableError(error), true);
        remove.disabled = false;
      }
    });
    actions.append(remove);
  }
  card.append(actions);
  manager.append(roleEditorOpen ? card : listPanel);
  renderRoleList();
  renderIcons(manager);
  renderRolePreview();
}

type ModerationActionKind = "warn" | "ban" | "timeout";

function openModerationAction(kind: ModerationActionKind, member: ServerMember) {
  const options: Record<ModerationActionKind, Array<[string, string]>> = {
    warn: [["2592000", "30 days"], ["7776000", "90 days"], ["never", "No expiry"]],
    ban: [["never", "Permanent"], ["86400", "1 day"], ["604800", "7 days"], ["2592000", "30 days"]],
    timeout: [["600", "10 minutes"], ["3600", "1 hour"], ["86400", "24 hours"], ["604800", "7 days"], ["2592000", "30 days"]],
  };
  pendingModerationAction = { kind, member };
  moderationActionTitle.textContent = kind === "warn" ? `Warn ${member.displayName}` : kind === "ban" ? `Ban ${member.displayName}` : `Timeout ${member.displayName}`;
  moderationActionDescription.textContent = kind === "warn"
    ? "This space-scoped warning is visible to the member and authorized space moderators. It does not restrict access."
    : kind === "ban"
      ? "This ban applies only to this space and blocks future invites until it expires or is revoked."
      : "This timeout applies only to this space and prevents sending messages and uploads until it expires or is removed.";
  moderationActionDuration.replaceChildren();
  for (const [value, label] of options[kind]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    moderationActionDuration.append(option);
  }
  moderationActionReason.value = "";
  moderationActionSubmit.textContent = kind === "warn" ? "Issue warning" : kind === "ban" ? "Ban in this space" : "Apply timeout";
  moderationActionDialog.showModal();
  moderationActionReason.focus();
}

moderationActionCancel.addEventListener("click", () => moderationActionDialog.close());
moderationActionDialog.addEventListener("close", () => { pendingModerationAction = undefined; });
moderationActionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const action = pendingModerationAction;
  if (!action || !currentServer) return;
  const reason = moderationActionReason.value.trim();
  if (!reason) {
    moderationActionReason.focus();
    return;
  }
  const duration = moderationActionDuration.value === "never" ? undefined : Number(moderationActionDuration.value);
  moderationActionSubmit.disabled = true;
  moderationActionCancel.disabled = true;
  try {
    if (action.kind === "warn") {
      await api.warnServerMember(currentServer.id, action.member.userId, reason, duration);
    } else if (action.kind === "ban") {
      await api.banServerMember(currentServer.id, action.member.userId, {
        reason,
        ...(duration ? { expiresInSeconds: duration } : {}),
      });
    } else if (duration) {
      await api.timeoutServerMember(currentServer.id, action.member.userId, duration, reason);
    }
    moderationActionDialog.close();
    await loadData();
    setStatus(action.kind === "warn" ? "Space warning issued; the member will see it in chat."
      : action.kind === "ban" ? "Member banned from this space."
        : "Member timed out in this space.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    moderationActionSubmit.disabled = false;
    moderationActionCancel.disabled = false;
  }
});

function renderMembers() {
  document.querySelectorAll<HTMLElement>(".member-actions-popover:popover-open, .member-role-dialog:popover-open").forEach((popover) => popover.hidePopover());
  memberList.replaceChildren();
  memberList.setAttribute("role", "table");
  memberList.setAttribute("aria-label", "Space members");
  const columns = document.createElement("div");
  columns.className = "members-table-heading";
  columns.setAttribute("role", "row");
  for (const title of ["Name", "Member since", "Roles", "Actions"]) {
    const column = document.createElement("span");
    column.setAttribute("role", "columnheader");
    column.textContent = title;
    columns.append(column);
  }
  memberList.append(columns);
  for (const member of members) {
    const row = document.createElement("div");
    row.className = "settings-list-row member-settings-row";
    row.setAttribute("role", "row");
    const avatar = document.createElement("span");
    avatar.className = "member-avatar";
    renderAvatar(avatar, member.displayName, member.userId, member.avatarUrl);
    avatar.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    copy.className = "settings-row-copy";
    const name = document.createElement("strong");
    name.textContent = member.displayName;
    const username = document.createElement("span");
    username.textContent = `@${member.username} · ${member.role === "owner" ? "Owner" : "member"}`;
    copy.append(name, username);
    const identity = document.createElement("div");
    identity.className = "member-table-identity";
    identity.setAttribute("role", "cell");
    identity.append(avatar, copy);
    const joined = document.createElement("div");
    joined.className = "member-table-joined";
    joined.setAttribute("role", "cell");
    const date = document.createElement("time");
    date.dateTime = member.joinedAt;
    date.textContent = new Date(member.joinedAt).toLocaleDateString();
    date.title = new Date(member.joinedAt).toLocaleString();
    joined.append(date);
    row.append(identity, joined);
    const actionCell = document.createElement("div");
    actionCell.setAttribute("role", "cell");
    actionCell.className = "member-table-actions";
    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className = "icon-button";
    actionButton.append(iconElement("more-horizontal"));
    actionButton.setAttribute("aria-label", `Actions for ${member.displayName}`);
    actionButton.setAttribute("aria-haspopup", "dialog");
    const actions = document.createElement("div");
    actions.className = "member-actions-popover";
    actions.setAttribute("role", "dialog");
    actions.setAttribute("aria-label", `Actions for ${member.displayName}`);
    actionButton.addEventListener("click", () => {
      showAnchoredPopover(actions, actionButton);
      actions.querySelector<HTMLButtonElement>("button")?.focus();
    });
    actionCell.append(actionButton);
    const assignedRoleIds = normalizeRoleIds(member.roleIds ?? roleAssignments.get(member.userId) ?? []);
    const roleSummary = document.createElement("div");
    roleSummary.className = "member-role-summary";
    roleSummary.setAttribute("role", "cell");
    const assignedRoles = assignedRoleIds
      .map((id) => roles.find((role) => role.id === id))
      .filter((role): role is CustomServerRole => Boolean(role))
      .sort((left, right) => right.position - left.position);
    const highestRole = assignedRoles[0];
    if (highestRole?.color) name.style.color = readableAccentText(highestRole.color, currentAppTheme());
    for (const role of assignedRoles) {
      const badge = document.createElement("span");
      badge.className = "role-badge";
      badge.style.setProperty("--role-color", role.color);
      badge.textContent = roleName(role);
      roleSummary.append(badge);
    }
    row.append(roleSummary);
    const restriction = (allowed: boolean) => member.userId === currentUserId ? "You cannot manage yourself with this action."
      : member.role === "owner" ? "The space owner is protected."
      : !allowed ? "Your role does not have permission for this action." : "";
    const restrict = (button: HTMLButtonElement, allowed: boolean) => {
      const reason = restriction(allowed);
      button.disabled = Boolean(reason);
      if (reason) button.title = reason;
      return button;
    };
    const canManageRoles = canAssignRoles();
    {
      const assign = memberRolePicker({
        memberName: member.displayName,
        roles: roles.filter((role) => role.systemKey !== "owner" && role.systemKey !== "everyone")
          .sort((a, b) => b.position - a.position)
          .map((role) => ({ id: role.id, name: roleName(role), color: role.color })),
        selected: assignedRoleIds,
        error: readableError,
        save: async (ids) => {
          await api.updateServerMemberRoles(currentServer!.id, member.userId, ids);
          await loadData();
          setStatus("Member roles updated.");
        },
      });
      assign.textContent = "Roles";
      assign.classList.add("member-roles-submenu-trigger");
      actions.append(restrict(assign, canManageRoles));
    }
    {
      const remove = document.createElement("button");
      remove.className = "danger-button";
      remove.type = "button";
      remove.textContent = "Kick member";
      restrict(remove, hasAnyPermission("manage_members", "kick_members"));
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Remove ${member.displayName} from this space?`)) return;
        remove.disabled = true;
        try {
          await api.removeServerMember(currentServer!.id, member.userId);
          await loadData();
          setStatus("Member removed.");
        } catch (error) {
          setStatus(readableError(error), true);
          remove.disabled = false;
        }
      });
      actions.append(remove);
    }
    {
      const ban = document.createElement("button");
      ban.className = "danger-button";
      ban.type = "button";
      ban.textContent = "Ban";
      restrict(ban, hasAnyPermission("manage_members", "ban_members"));
      ban.addEventListener("click", () => { actions.hidePopover(); openModerationAction("ban", member); });
      actions.append(ban);
    }
    {
      const warn = document.createElement("button");
      warn.type = "button";
      warn.className = "secondary";
      warn.textContent = "Warn";
      restrict(warn, hasAnyPermission("manage_members", "warn_members"));
      warn.addEventListener("click", () => { actions.hidePopover(); openModerationAction("warn", member); });
      actions.append(warn);
    }
    {
      const timeout = document.createElement("button");
      timeout.type = "button";
      timeout.className = "secondary";
      timeout.textContent = "Timeout";
      restrict(timeout, hasAnyPermission("manage_members", "timeout_members"));
      timeout.addEventListener("click", () => { actions.hidePopover(); openModerationAction("timeout", member); });
      actions.append(timeout);
    }
    const copyId = document.createElement("button");
    copyId.type = "button";
    copyId.className = "secondary";
    copyId.textContent = "Copy user ID";
    copyId.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(member.userId);
        actions.hidePopover();
        setStatus("User ID copied.");
      } catch { setStatus("Could not copy the user ID. Check browser clipboard permissions.", true); }
    });
    actions.append(copyId);
    const profile = document.createElement("button");
    profile.type = "button";
    profile.className = "secondary";
    profile.textContent = "Profile";
    profile.addEventListener("click", () => { actions.hidePopover(); void showMemberProfile(api, member.userId); });
    const message = document.createElement("button");
    message.type = "button";
    message.className = "secondary";
    message.textContent = "Message";
    message.disabled = member.userId === currentUserId;
    message.addEventListener("click", async () => {
      message.disabled = true;
      try {
        const result = await api.createConversation("dm", [member.userId]);
        window.location.assign(`/channels/@me/${encodeURIComponent(result.conversation.id)}`);
      } catch (error) { message.disabled = false; setStatus(readableError(error), true); }
    });
    const block = document.createElement("button");
    block.type = "button";
    block.className = "danger-button";
    block.textContent = "Block";
    block.disabled = true;
    let blocked = false;
    actionButton.addEventListener("click", () => {
      if (member.userId === currentUserId) { block.title = "You cannot block yourself."; return; }
      block.disabled = true;
      void api.user(member.userId).then((result) => {
        blocked = result.blockedByMe;
        block.textContent = blocked ? "Unblock" : "Block";
        block.disabled = false;
      }).catch(() => { block.title = "Could not load block status. Reopen the menu to retry."; });
    });
    block.addEventListener("click", async () => {
      if (!blocked && !window.confirm(`Block ${member.displayName}? This affects your account, not space membership.`)) return;
      block.disabled = true;
      try {
        if (blocked) await api.unblockUser(member.userId); else await api.blockUser(member.userId);
        blocked = !blocked;
        block.textContent = blocked ? "Unblock" : "Block";
        setStatus(blocked ? "Member blocked for your account." : "Member unblocked.");
      } catch (error) { setStatus(readableError(error), true); }
      finally { block.disabled = false; }
    });
    const existing = [...actions.querySelectorAll<HTMLButtonElement>("button")];
    const separator = () => document.createElement("hr");
    actions.replaceChildren(profile, message, separator(), block, separator());
    for (const label of ["Roles", "Warn", "Timeout", "Kick member", "Ban"]) {
      const button = existing.find((candidate) => candidate.textContent === label);
      if (button) actions.append(button);
    }
    actions.append(separator(), copyId);
    const limitation = restriction(true);
    if (limitation) {
      const explanation = document.createElement("p");
      explanation.className = "member-actions-note";
      explanation.textContent = limitation;
      actions.append(explanation);
    }
    row.append(actionCell);
    memberList.append(row);
  }
  renderIcons(memberList);
}

function renderModeration() {
  moderationList.replaceChildren();
  const canUnban = hasAnyPermission("manage_members", "unban_members");
  const canRemoveTimeout = hasAnyPermission("manage_members", "remove_timeouts");
  const canRevokeWarning = hasAnyPermission("manage_members", "revoke_warnings");
  if (moderation.bans.length === 0 && moderation.timeouts.length === 0 && moderation.warnings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "No active bans, timeouts, or warnings.";
    moderationList.append(empty);
    return;
  }
  for (const ban of moderation.bans) {
    const row = document.createElement("div");
    row.className = "settings-list-row moderation-row";
    const copy = document.createElement("div");
    copy.className = "settings-row-copy";
    const name = document.createElement("strong");
    name.textContent = `Banned · ${ban.displayName}`;
    const detail = document.createElement("span");
    detail.textContent = ban.expiresAt ? `@${ban.username} · expires ${new Date(ban.expiresAt).toLocaleString()}` : `@${ban.username} · permanent`;
    copy.append(name, detail);
    row.append(copy);
    if (canUnban) {
      const unban = document.createElement("button");
      unban.type = "button";
      unban.textContent = "Unban";
      unban.addEventListener("click", async () => {
        unban.disabled = true;
        try {
          await api.unbanServerMember(currentServer!.id, ban.userId);
          await loadData();
          setStatus("Member unbanned.");
        } catch (error) {
          setStatus(readableError(error), true);
          unban.disabled = false;
        }
      });
      row.append(unban);
    }
    moderationList.append(row);
  }
  for (const timeout of moderation.timeouts) {
    const row = document.createElement("div");
    row.className = "settings-list-row moderation-row";
    const copy = document.createElement("div");
    copy.className = "settings-row-copy";
    const name = document.createElement("strong");
    name.textContent = `Timed out · ${timeout.displayName}`;
    const detail = document.createElement("span");
    detail.textContent = `@${timeout.username} · until ${new Date(timeout.expiresAt).toLocaleString()}`;
    copy.append(name, detail);
    row.append(copy);
    if (canRemoveTimeout) {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "Restore";
      restore.addEventListener("click", async () => {
        restore.disabled = true;
        try {
          await api.removeServerMemberTimeout(currentServer!.id, timeout.userId);
          await loadData();
          setStatus("Member restored.");
        } catch (error) {
          setStatus(readableError(error), true);
          restore.disabled = false;
        }
      });
      row.append(restore);
    }
    moderationList.append(row);
  }
  for (const warning of moderation.warnings) {
    const row = document.createElement("div");
    row.className = "settings-list-row moderation-row";
    const copy = document.createElement("div");
    copy.className = "settings-row-copy";
    const name = document.createElement("strong");
    name.textContent = `${warning.active ? "Active warning" : warning.revokedAt ? "Revoked warning" : "Expired warning"} · ${warning.displayName}`;
    const detail = document.createElement("span");
    const acknowledged = warning.acknowledgedAt ? ` · acknowledged ${new Date(warning.acknowledgedAt).toLocaleString()}` : " · awaiting acknowledgement";
    detail.textContent = `@${warning.username} · ${warning.reason} · issued by @${warning.createdByUsername} · ${new Date(warning.createdAt).toLocaleString()}${warning.expiresAt ? ` · expires ${new Date(warning.expiresAt).toLocaleString()}` : " · no expiry"}${acknowledged}`;
    copy.append(name, detail);
    row.append(copy);
    if (canRevokeWarning && warning.active) {
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "Revoke warning";
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try {
          await api.revokeServerWarning(currentServer!.id, warning.id);
          await loadData();
          setStatus("Space warning revoked.");
        } catch (error) {
          setStatus(readableError(error), true);
          revoke.disabled = false;
        }
      });
      row.append(revoke);
    }
    moderationList.append(row);
  }
}

function renderInvites(invites: Awaited<ReturnType<ApiClient["serverInvites"]>>["invites"]) {
  inviteList.replaceChildren();
  const active = invites
    .filter((invite) => !invite.revokedAt)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const history = invites.filter((invite) => invite.id !== active?.id);
  createInvite.textContent = active ? "Regenerate link" : "Create invite";

  if (!active) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "No active invite link. Create one to invite people to this space.";
    inviteList.append(empty);
  } else {
    const row = document.createElement("div");
    row.className = "settings-list-row invite-active-row";
    const copy = document.createElement("div");
    copy.className = "settings-row-copy";
    const name = document.createElement("strong");
    name.textContent = "Active invite link";
    const details = document.createElement("span");
    details.textContent = `${active.uses}${active.maxUses ? `/${active.maxUses}` : " uses"} · ${active.expiresAt ? `expires ${new Date(active.expiresAt).toLocaleString()}` : "never expires"}`;
    copy.append(name, details);
    row.append(copy);
    if (hasAnyPermission("manage_invites", "revoke_invites")) {
      const revoke = document.createElement("button");
      revoke.className = "danger-button";
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try {
          await api.revokeServerInvite(currentServer!.id, active.id);
          await loadData();
          setStatus("Invite revoked.");
        } catch (error) {
          setStatus(readableError(error), true);
          revoke.disabled = false;
        }
      });
      row.append(revoke);
    }
    inviteList.append(row);
  }
  if (history.length > 0) {
    const historyDetails = document.createElement("details");
    historyDetails.className = "invite-history";
    const summary = document.createElement("summary");
    summary.textContent = `Previous links (${history.length})`;
    const historyList = document.createElement("div");
    historyList.className = "invite-history-list";
    for (const invite of history) {
      const row = document.createElement("div");
      row.className = "settings-list-row invite-history-row";
      const copy = document.createElement("div");
      copy.className = "settings-row-copy";
      const name = document.createElement("strong");
      name.textContent = invite.revokedAt ? "Revoked invite link" : "Superseded invite link";
      const details = document.createElement("span");
      details.textContent = `${invite.uses}${invite.maxUses ? `/${invite.maxUses}` : " uses"} · created ${new Date(invite.createdAt).toLocaleString()}`;
      copy.append(name, details);
      row.append(copy);
      historyList.append(row);
    }
    historyDetails.append(summary, historyList);
    inviteList.append(historyDetails);
  }
}

function updateSettingsControls() {
  if (!currentServer) return;
  saveServer.disabled = !currentServer.permissions.manage_server || !metadataReady;
  for (const control of overviewFields) control.disabled = !currentServer.permissions.manage_server || !metadataReady;
  deleteServer.hidden = currentServer.role !== "owner";
  categoryForm.querySelector("button")!.toggleAttribute("disabled", !hasAnyPermission("manage_channels", "manage_categories") || !metadataReady);
  channelForm.querySelector("button")!.toggleAttribute("disabled", !hasAnyPermission("manage_channels", "create_channels"));
  roleForm.querySelector("button")!.toggleAttribute("disabled", !hasAnyPermission("manage_roles", "create_roles") || !metadataReady);
  createInvite.disabled = !hasAnyPermission("manage_invites", "create_invites");
  const canManageBranding = hasPermission("manage_server");
  serverIconInput.disabled = !canManageBranding;
  serverBannerInput.disabled = !canManageBranding;
  removeServerIcon.disabled = !canManageBranding || !currentServer.iconUrl;
  removeServerBanner.disabled = !canManageBranding || !currentServer.bannerUrl;
  for (const control of [welcomeEnabled, welcomeHeading, welcomeDescription, welcomeRules, welcomeAcknowledgement]) control.disabled = !canManageBranding || !metadataReady;
  emojiForm.querySelector("button")!.toggleAttribute("disabled", !hasPermission("manage_custom_emoji") || !metadataReady);
  refreshAuditLog.disabled = !hasPermission("view_audit_logs");
}

async function hydrateChannelMetadata(version: number, channelSnapshot: ServerChannel[]) {
  if (!cryptoClient || !metadataConversationId) return;
  const metadataConversation = metadataConversationId;
  try {
    const channelsToPrepare = channelSnapshot.filter((channel) => channel.conversationId !== metadataConversation);
    const memberResults = await Promise.all(channelsToPrepare.map((channel) => api.conversationMembers(channel.conversationId)));
    for (let index = 0; index < channelsToPrepare.length; index += 1) {
      await prepareConversation(channelsToPrepare[index].conversationId, false, memberResults[index].members);
    }
    await cryptoClient.syncToDevice().catch(() => undefined);
    const channelMetadata = await Promise.all(channelSnapshot.map((channel) => decryptMetadata(channel.conversationId, channel.encryptedMetadata)));
    if (version !== metadataHydrationVersion || metadataConversationId !== metadataConversation) return;
    for (let index = 0; index < channelSnapshot.length; index += 1) {
      const metadata = channelMetadata[index];
      if (typeof metadata.name === "string" && metadata.name.trim()) channelNames.set(channelSnapshot[index].id, metadata.name.trim().slice(0, 80));
    }

    for (const channel of channelSnapshot) {
      const name = channelNames.get(channel.id);
      if (!name) continue;
      const channelRow = [...channelList.querySelectorAll<HTMLElement>(".channel-settings-row")]
        .find((row) => row.dataset.channelId === channel.id);
      const channelInput = channelRow?.querySelector<HTMLInputElement>("input");
      if (channelInput && channelInput.value === channelInput.dataset.fallbackName) channelInput.value = name;
      for (const roleRow of roleList.querySelectorAll<HTMLElement>(".role-channel-access-row")) {
        if (roleRow.dataset.channelId === channel.id) roleRow.querySelector<HTMLElement>(".role-channel-name")!.textContent = name;
      }
    }
    renderRolePreview();
  } catch (error) {
    console.warn("encrypted room metadata hydration failed", error);
  }
}

async function hydrateMetadata(version: number, channelSnapshot: ServerChannel[]) {
  const conversationId = metadataConversationId;
  if (!conversationId || !cryptoClient) {
    metadataReady = true;
    updateSettingsControls();
    renderCategories();
    renderChannels();
    renderOnboardingOptions();
    renderLandingOptions();
    renderRoles();
    return;
  }
  try {
    metadataMembers = await prepareConversation(conversationId);
    const [metadata, roleMetadata, categoryMetadata] = await Promise.all([
      currentServer!.encryptedMetadata ? cryptoClient.decryptMetadata(conversationId, currentServer!.encryptedMetadata) : Promise.resolve({} as Record<string, unknown>),
      Promise.all(roles.map((role) => decryptMetadata(conversationId, role.encryptedMetadata))),
      Promise.all(categories.map((category) => decryptMetadata(conversationId, category.encryptedMetadata))),
    ]);
    if (version !== metadataHydrationVersion || metadataConversationId !== conversationId) return;
    serverName.value = typeof metadata.name === "string" ? metadata.name : "";
    serverDescription.value = typeof metadata.description === "string" ? metadata.description : "";
    title.textContent = serverName.value.trim() || "Space settings";
    renderWelcome(metadata);
    for (let index = 0; index < roles.length; index += 1) {
      const name = roleMetadata[index].name;
      if (typeof name === "string" && name.trim()) roleNames.set(roles[index].id, name.trim().slice(0, 80));
    }
    for (let index = 0; index < categories.length; index += 1) {
      const name = categoryMetadata[index].name;
      if (typeof name === "string" && name.trim()) categoryNames.set(categories[index].id, name.trim().slice(0, 80));
    }
    metadataReady = true;
    updateSettingsControls();
    renderCategories();
    renderChannels();
    renderOnboardingOptions();
    renderLandingOptions();
    renderRoles();
    renderMembers();
    renderBranding();
    savedOverview = overviewSnapshot();
    if (status.textContent === "Loading encrypted settings…") setStatus("");
    void hydrateChannelMetadata(version, channelSnapshot);
    void hydrateCustomEmojiMetadata(version);
  } catch (error) {
    if (version !== metadataHydrationVersion) return;
    updateSettingsControls();
    setStatus("Could not unlock this space’s saved settings. Restore history keys in account Settings → Recovery, then reload. Editing is disabled to protect existing settings.", true);
    console.warn("encrypted settings metadata hydration failed", error);
  }
}

async function hydrateCustomEmojiMetadata(version: number) {
  if (!metadataConversationId || !cryptoClient) return;
  const values = await Promise.all(customEmojis.map((emoji) => decryptMetadata(metadataConversationId!, emoji.encryptedMetadata)));
  if (version !== metadataHydrationVersion) return;
  customEmojiNames.clear();
  customEmojiMetadata.clear();
  clearCustomEmojiPreviews();
  for (let index = 0; index < customEmojis.length; index += 1) {
    const name = values[index].name;
    customEmojiMetadata.set(customEmojis[index].id, values[index]);
    if (typeof name === "string" && /^[A-Za-z0-9_+-]{1,32}$/.test(name)) customEmojiNames.set(customEmojis[index].id, name);
  }
  renderCustomEmojis();
  await Promise.all(customEmojis.map(async (emoji, index) => {
    if (emoji.status !== "uploaded" || !emoji.fileUrl) return;
    try {
      const response = await fetch(emoji.fileUrl, { credentials: "include" });
      if (!response.ok) return;
      const blob = await decryptCustomEmojiImage(values[index], new Uint8Array(await response.arrayBuffer()));
      if (version !== metadataHydrationVersion) return;
      const src = URL.createObjectURL(blob);
      customEmojiPreviewUrls.set(emoji.id, src);
      const preview = emojiList.querySelector<HTMLElement>(`[data-emoji-id="${emoji.id}"] .custom-emoji-preview`);
      if (preview) {
        const image = document.createElement("img");
        image.src = src;
        image.alt = `:${customEmojiNames.get(emoji.id) ?? "emoji"}:`;
        preview.replaceChildren(image);
        preview.removeAttribute("title");
      }
    } catch { /* Keep an explicit unavailable preview without exposing keys or metadata. */ }
  }));
}

async function loadData() {
  if (!serverId) throw new Error("server_not_selected");
  const version = ++metadataHydrationVersion;
  metadataReady = false;
  metadataMembers = [];
  const [serverResult, channelResult, categoryResult, memberResult, roleResult, moderationResult, inviteResult, emojiResult, auditResult] = await Promise.all([
    api.server(serverId),
    api.serverChannels(serverId),
    api.serverCategories(serverId),
    api.serverMembers(serverId),
    api.serverRoles(serverId),
    api.serverModeration(serverId).catch((error) => {
      if (error instanceof ApiError && error.status === 403) return { bans: [], timeouts: [], warnings: [] } satisfies ServerModeration;
      throw error;
    }),
    api.serverInvites(serverId).catch((error) => {
      if (error instanceof ApiError && error.status === 403) return { invites: [] };
      throw error;
    }),
    api.serverCustomEmojis(serverId),
    api.serverAuditLogs(serverId).catch((error) => {
      if (error instanceof ApiError && error.status === 403) return { logs: [] };
      throw error;
    }),
  ]);
  currentServer = serverResult.server;
  channels = channelResult.channels;
  categories = categoryResult.categories;
  members = memberResult.members;
  roles = roleResult.roles;
  roleAssignments = new Map(roleResult.assignments.map((assignment) => [assignment.userId, normalizeRoleIds(assignment.roleIds)]));
  moderation = moderationResult;
  customEmojis = emojiResult.emojis;
  auditLogs = auditResult.logs;
  roleNames.clear();
  categoryNames.clear();
  channelNames.clear();
  customEmojiNames.clear();
  customEmojiMetadata.clear();
  clearCustomEmojiPreviews();
  title.textContent = "Space settings";
  roleLabel.textContent = `${currentServer.role} · ${channels.length} encrypted room${channels.length === 1 ? "" : "s"}`;
  backToServer.href = destination(currentServer.landingChannelId ?? channels[0]?.id);
  renderBranding();
  renderCustomEmojis();
  renderAuditLogs();

  const metadataChannel = roleResult.metadataConversationId
    ? channels.find((channel) => channel.conversationId === roleResult.metadataConversationId)
    : [...channels].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
  metadataConversationId = roleResult.metadataConversationId ?? metadataChannel?.conversationId;
  updateSettingsControls();
  renderCategories();
  renderChannels();
  renderOnboardingOptions();
  renderLandingOptions();
  renderRoles();
  renderMembers();
  renderModeration();
  renderInvites(inviteResult.invites);
  if (metadataConversationId) {
    setStatus("Loading encrypted settings…");
    void hydrateMetadata(version, channels.slice());
  } else {
    metadataReady = true;
    updateSettingsControls();
    renderCategories();
    renderChannels();
    renderOnboardingOptions();
    renderLandingOptions();
    renderRoles();
    renderBranding();
    renderCustomEmojis();
    renderAuditLogs();
  }
}

serverForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSpaceSettings();
});

async function saveSpaceSettings() {
  if (!currentServer || !metadataConversationId || !metadataReady || !currentServer.permissions.manage_server || !serverForm.reportValidity()) return false;
  saveServer.disabled = true;
  try {
    const encryptedMetadata = await encryptMetadata(metadataConversationId, {
      name: serverName.value.trim(),
      description: serverDescription.value.trim().slice(0, 240),
      welcome: {
        enabled: welcomeEnabled.checked,
        heading: welcomeHeading.value.trim().slice(0, 120),
        description: welcomeDescription.value.trim().slice(0, 500),
        rules: welcomeRules.value.trim().slice(0, 2_000),
        acknowledgement: welcomeAcknowledgement.checked,
      },
      kind: "server",
    });
    const updated = await api.updateServerSettings(currentServer.id, {
      encryptedMetadata,
      onboardingChannelId: onboardingChannel.value || null,
      landingChannelId: landingChannel.value || null,
    });
    currentServer = updated.server;
    backToServer.href = destination(currentServer.landingChannelId ?? channels[0]?.id);
    renderBranding();
    title.textContent = serverName.value.trim() || "Space settings";
    savedOverview = overviewSnapshot();
    setStatus("Space settings saved.");
    return true;
  } catch (error) {
    setStatus(readableError(error), true);
    return false;
  } finally {
    saveServer.disabled = !currentServer.permissions.manage_server || !metadataReady;
  }
}

async function uploadBranding(asset: "icon" | "banner", input: HTMLInputElement) {
  const file = input.files?.[0];
  if (!currentServer || !file) return;
  input.disabled = true;
  try {
    const result = await api.uploadServerBranding(currentServer.id, asset, file);
    currentServer = {
      ...currentServer,
      ...(asset === "icon" ? { iconUrl: result.url } : { bannerUrl: result.url }),
    };
    renderBranding();
    setStatus(`${asset === "icon" ? "Icon" : "Banner"} updated.`);
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    input.value = "";
    input.disabled = !hasPermission("manage_server");
  }
}

async function removeBranding(asset: "icon" | "banner") {
  if (!currentServer) return;
  const button = asset === "icon" ? removeServerIcon : removeServerBanner;
  button.disabled = true;
  try {
    await api.removeServerBranding(currentServer.id, asset);
    currentServer = {
      ...currentServer,
      ...(asset === "icon" ? { iconUrl: null } : { bannerUrl: null }),
    };
    renderBranding();
    setStatus(`${asset === "icon" ? "Icon" : "Banner"} removed.`);
  } catch (error) {
    setStatus(readableError(error), true);
    button.disabled = false;
  }
}

serverIconInput.addEventListener("change", () => void uploadBranding("icon", serverIconInput));
serverBannerInput.addEventListener("change", () => void uploadBranding("banner", serverBannerInput));
removeServerIcon.addEventListener("click", () => void removeBranding("icon"));
removeServerBanner.addEventListener("click", () => void removeBranding("banner"));

emojiForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = newEmojiFile.files?.[0];
  const name = newEmojiName.value.trim();
  const button = emojiForm.querySelector<HTMLButtonElement>("button");
  if (!currentServer || !metadataConversationId || !metadataReady || !file || !/^[A-Za-z0-9_+-]{1,32}$/.test(name)) return;
  if (!/^image\/(?:avif|gif|jpeg|png|webp)$/i.test(file.type)) {
    setStatus("Choose a PNG, JPG, GIF, WebP, or AVIF image.", true);
    return;
  }
  if ([...customEmojiNames.values()].some((existing) => existing.toLowerCase() === name.toLowerCase())) {
    setStatus("That custom emoji name is already in use.", true);
    return;
  }
  if (file.size > 10 * 1024 * 1024 - 64) {
    setStatus("That emoji is larger than 10 MiB.", true);
    return;
  }
  if (button) button.disabled = true;
  let pendingEmojiId: string | undefined;
  try {
    const encrypted = await encryptCustomEmoji(file);
    const metadata = await encryptMetadata(metadataConversationId, {
      kind: "custom-emoji",
      name,
      mimeType: file.type || "application/octet-stream",
      key: encrypted.key,
      iv: encrypted.iv,
    });
    const created = await api.createServerCustomEmoji(currentServer.id, {
      encryptedMetadata: metadata,
      expectedSizeBytes: encrypted.bytes.byteLength,
    });
    pendingEmojiId = created.emoji.id;
    await api.uploadServerCustomEmoji(currentServer.id, created.emoji.id, encrypted.bytes);
    pendingEmojiId = undefined;
    newEmojiName.value = "";
    newEmojiFile.value = "";
    await loadData();
    setStatus(`:${name}: uploaded as encrypted emoji.`);
  } catch (error) {
    if (pendingEmojiId) await api.removeServerCustomEmoji(currentServer.id, pendingEmojiId).catch(() => undefined);
    setStatus(readableError(error), true);
  } finally {
    if (button) button.disabled = !hasPermission("manage_custom_emoji") || !metadataReady;
  }
});

refreshAuditLog.addEventListener("click", async () => {
  if (!currentServer || !hasPermission("view_audit_logs")) return;
  refreshAuditLog.disabled = true;
  try {
    auditLogs = (await api.serverAuditLogs(currentServer.id)).logs;
    renderAuditLogs();
    setStatus("Audit log refreshed.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    refreshAuditLog.disabled = !hasPermission("view_audit_logs");
  }
});

deleteServer.addEventListener("click", async () => {
  if (!currentServer || currentServer.role !== "owner") return;
  const name = serverName.value.trim() || "this server";
  if (!window.confirm(`Permanently delete ${name}? All rooms and encrypted history will be removed for every person.`)) return;
  deleteServer.disabled = true;
  try {
    await api.deleteServer(currentServer.id);
    window.location.assign("/app");
  } catch (error) {
    setStatus(readableError(error), true);
    deleteServer.disabled = false;
  }
});

categoryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentServer || !metadataConversationId || !metadataReady || !newCategoryName.value.trim()) return;
  const button = categoryForm.querySelector<HTMLButtonElement>("button");
  if (button) button.disabled = true;
  try {
    const name = newCategoryName.value.trim();
    const encryptedMetadata = await encryptMetadata(metadataConversationId, { name, kind: "category" });
    await api.createCategory(currentServer.id, encryptedMetadata);
    newCategoryName.value = "";
    await loadData();
    setStatus("Category created.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    if (button) button.disabled = !hasAnyPermission("manage_channels", "manage_categories") || !metadataReady;
  }
});

channelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentServer || !newChannelName.value.trim()) return;
  const button = channelForm.querySelector<HTMLButtonElement>("button");
  if (button) button.disabled = true;
  try {
    const kind = newChannelKind.value === "voice" ? "voice" : "text";
    const result = await api.createChannel(currentServer.id, "", newChannelCategory.value || null, kind);
    const channelMembers = await prepareConversation(result.channel.conversationId);
    const encryptedMetadata = await cryptoClient!.encryptMetadata(result.channel.conversationId, channelMembers, {
      name: newChannelName.value.trim(),
      kind,
    });
    await api.updateChannel(currentServer.id, result.channel.id, { encryptedMetadata });
    newChannelName.value = "";
    await loadData();
    setStatus("Channel created.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    if (button) button.disabled = !hasAnyPermission("manage_channels", "create_channels");
  }
});

roleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentServer || !metadataConversationId || !metadataReady || !newRoleName.value.trim()) return;
  const button = roleForm.querySelector<HTMLButtonElement>("button");
  if (button) button.disabled = true;
  try {
    const name = newRoleName.value.trim();
    const encryptedMetadata = await encryptMetadata(metadataConversationId, { name, kind: "server-role" });
    const result = await api.createServerRole(currentServer.id, {
      encryptedMetadata,
      color: newRoleColor.value,
      permissions: defaultRolePermissions(),
      mentionable: false,
      viewAllChannels: true,
    });
    selectedRoleId = result.role.id;
    roleEditorOpen = true;
    roleForm.closest("details")?.removeAttribute("open");
    roleEditorDirty = false;
    newRoleName.value = "";
    await loadData();
    setStatus("Role created.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    if (button) button.disabled = !hasAnyPermission("manage_roles", "create_roles") || !metadataReady;
  }
});

function closeRolePreview() {
  previewRoleId = undefined;
  previewChannelId = undefined;
  if (rolePreview.open) rolePreview.close();
  setPreviewRoomNavigation(false);
  setPreviewInspector(false);
  renderRolePreview();
  roleList.querySelector<HTMLElement>(".role-editor button, .role-list-item button")?.focus();
}

exitRolePreview.addEventListener("click", closeRolePreview);
rolePreview.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeRolePreview();
});
previewRoomToggle.addEventListener("click", () => {
  const open = !rolePreviewContent.classList.contains("role-preview-room-nav-open");
  if (open) setPreviewInspector(false);
  setPreviewRoomNavigation(open);
});
previewInspectorToggle.addEventListener("click", () => {
  setPreviewRoomNavigation(false);
  setPreviewInspector(!rolePreviewContent.classList.contains("role-preview-inspector-open"));
});
previewRoomBackdrop.addEventListener("click", () => {
  setPreviewRoomNavigation(false);
  previewRoomToggle.focus();
});
previewInspectorBackdrop.addEventListener("click", () => {
  setPreviewInspector(false);
  previewInspectorToggle.focus();
});
window.addEventListener("resize", () => {
  if (!rolePreview.open) return;
  setPreviewRoomNavigation(false);
  setPreviewInspector(!window.matchMedia("(max-width: 1000px)").matches);
});

createInvite.addEventListener("click", async () => {
  if (!currentServer) return;
  createInvite.disabled = true;
  try {
    const result = await api.createServerInvite(currentServer.id, { expiresInSeconds: 7 * 24 * 60 * 60 });
    await showOneTimeToken(result.invite.token);
    await loadData();
    setStatus("Invite created.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    createInvite.disabled = !hasAnyPermission("manage_invites", "create_invites");
  }
});

async function boot() {
  if (!serverId) {
    window.location.assign("/app");
    return;
  }
  try {
    const result = await api.me();
    currentUserId = result.user.id;
    applySavedTheme();
    await ensureCrypto();
    await loadData();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) window.location.assign("/");
    else if (error instanceof LocalCryptoStoreError) {
      window.location.assign(`/unlock?error=${encodeURIComponent(error.message)}&return=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
    }
    else setStatus(readableError(error), true);
  }
}

void boot();
