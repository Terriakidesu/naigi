import {
  ApiClient,
  ApiError,
  type ConversationMember,
  type CustomServerRole,
  type Server,
  type ServerCategory,
  type ServerChannel,
  type ServerMember,
  type ServerModeration,
  type ServerPermission,
  type ServerPermissionMap,
} from "./api";
import { renderAvatar } from "./avatar";
import { CryptoClient, LocalCryptoStoreError } from "./crypto";
import { renderIcons } from "./icons";
import { showOneTimeToken } from "./ui-dialog";
import {
  clearSessionPassphrase,
  confirmLocalUnlock,
  forgetRememberedPassphrase,
  resolveLocalPassphrase,
} from "./unlock-vault";

const api = new ApiClient();
const serverId = new URLSearchParams(window.location.search).get("server");
const title = document.getElementById("server-settings-title") as HTMLElement;
const roleLabel = document.getElementById("server-settings-role") as HTMLElement;
const serverForm = document.getElementById("server-form") as HTMLFormElement;
const serverName = document.getElementById("server-name") as HTMLInputElement;
const serverDescription = document.getElementById("server-description") as HTMLTextAreaElement;
const onboardingChannel = document.getElementById("onboarding-channel") as HTMLSelectElement;
const saveServer = document.getElementById("save-server-button") as HTMLButtonElement;
const deleteServer = document.getElementById("delete-server-button") as HTMLButtonElement;
const categoryForm = document.getElementById("category-form") as HTMLFormElement;
const newCategoryName = document.getElementById("new-category-name") as HTMLInputElement;
const categoryList = document.getElementById("category-settings-list") as HTMLElement;
const channelForm = document.getElementById("channel-form") as HTMLFormElement;
const newChannelName = document.getElementById("new-channel-name") as HTMLInputElement;
const newChannelCategory = document.getElementById("new-channel-category") as HTMLSelectElement;
const channelList = document.getElementById("channel-settings-list") as HTMLElement;
const roleForm = document.getElementById("role-form") as HTMLFormElement;
const newRoleName = document.getElementById("new-role-name") as HTMLInputElement;
const newRoleColor = document.getElementById("new-role-color") as HTMLInputElement;
const roleList = document.getElementById("role-settings-list") as HTMLElement;
const rolePreview = document.getElementById("role-preview") as HTMLElement;
const rolePreviewTitle = document.getElementById("role-preview-title") as HTMLElement;
const rolePreviewBanner = document.getElementById("role-preview-banner") as HTMLElement;
const rolePreviewContent = document.getElementById("role-preview-content") as HTMLElement;
const exitRolePreview = document.getElementById("exit-role-preview") as HTMLButtonElement;
const memberList = document.getElementById("member-settings-list") as HTMLElement;
const moderationList = document.getElementById("moderation-settings-list") as HTMLElement;
const createInvite = document.getElementById("create-invite-settings") as HTMLButtonElement;
const inviteList = document.getElementById("invite-settings-list") as HTMLElement;
const status = document.getElementById("server-settings-status") as HTMLElement;
const backToServer = document.getElementById("back-to-server") as HTMLAnchorElement;
const logout = document.getElementById("server-logout-button") as HTMLButtonElement;

let currentUserId: string | undefined;
let currentServer: Server | undefined;
let channels: ServerChannel[] = [];
let categories: ServerCategory[] = [];
let members: ServerMember[] = [];
let roles: CustomServerRole[] = [];
let roleAssignments = new Map<string, string[]>();
let moderation: ServerModeration = { bans: [], timeouts: [] };
let cryptoClient: CryptoClient | undefined;
let metadataConversationId: string | undefined;
let metadataMembers: Awaited<ReturnType<ApiClient["conversationMembers"]>>["members"] = [];
let selectedRoleId: string | undefined;
let previewRoleId: string | undefined;
let roleSearchQuery = "";
let roleEditorDirty = false;
let metadataReady = false;
let metadataHydrationVersion = 0;
const categoryNames = new Map<string, string>();
const channelNames = new Map<string, string>();
const roleNames = new Map<string, string>();

const permissionDefinitions: Array<{ id: ServerPermission; label: string; description: string }> = [
  { id: "view_channels", label: "View rooms", description: "See rooms and read encrypted history." },
  { id: "send_messages", label: "Send messages", description: "Post encrypted messages in visible channels." },
  { id: "upload_files", label: "Upload files", description: "Upload encrypted files in all unrestricted rooms." },
  { id: "view_members", label: "View people", description: "See the space people directory." },
  { id: "mention_everyone", label: "Broadcast to all", description: "Use the all-people broadcast mention." },
  { id: "mention_here", label: "Mention active people", description: "Use the active-people broadcast mention." },
  { id: "mention_roles", label: "Mention roles", description: "Ping roles marked as mentionable." },
  { id: "manage_server", label: "Manage space", description: "Edit space details and space-wide settings." },
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
  { id: "view_moderation_records", label: "View moderation records", description: "See active bans and timeouts." },
  { id: "ban_members", label: "Ban members", description: "Ban members and block future invites." },
  { id: "unban_members", label: "Unban members", description: "Revoke active member bans." },
  { id: "timeout_members", label: "Timeout members", description: "Temporarily prevent messaging and uploads." },
  { id: "remove_timeouts", label: "Remove timeouts", description: "Restore members before their timeout expires." },
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
  { label: "Moderation", permissions: ["manage_server", "manage_members", "kick_members", "view_moderation_records", "ban_members", "unban_members", "timeout_members", "remove_timeouts"] },
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
  for (const view of views) view.hidden = `#${view.id}` !== hash;
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".server-settings-nav-item")) {
    const active = link.hash === hash;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}

window.addEventListener("hashchange", syncSettingsNav);
syncSettingsNav();
renderIcons();

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
  return Boolean(currentServer?.permissions[permission]);
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

function roleOptions(selected: string[]) {
  const fragment = document.createDocumentFragment();
  for (const role of roles.filter((candidate) => candidate.systemKey !== "owner" && candidate.systemKey !== "everyone")) {
    const option = document.createElement("option");
    option.value = role.id;
    option.textContent = roleName(role);
    option.selected = selected.includes(role.id);
    option.style.color = role.color;
    fragment.append(option);
  }
  return fragment;
}

function previewPermissions(role: CustomServerRole) {
  const permissions = {} as ServerPermissionMap;
  for (const definition of permissionDefinitions) permissions[definition.id] = role.permissions[definition.id] === true;
  return permissions;
}

function renderRolePreview() {
  const role = previewRoleId ? roles.find((candidate) => candidate.id === previewRoleId) : undefined;
  if (!role) {
    rolePreview.hidden = true;
    rolePreviewBanner.replaceChildren();
    rolePreviewContent.replaceChildren();
    return;
  }

  const permissions = previewPermissions(role);
  rolePreview.hidden = false;
  rolePreview.style.setProperty("--role-color", role.color);
  rolePreviewTitle.textContent = `Viewing as ${roleName(role)}`;
  rolePreviewBanner.replaceChildren();

  const swatch = document.createElement("span");
  swatch.className = "role-preview-swatch";
  swatch.style.background = role.color;
  swatch.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  copy.className = "role-preview-banner-copy";
  const stack = document.createElement("strong");
  stack.textContent = role.systemKey === "everyone" ? "All members" : `All members · ${roleName(role)}`;
  const explanation = document.createElement("span");
  explanation.textContent = "Read-only simulation. No member is impersonated and no encrypted message history is loaded or decrypted.";
  copy.append(stack, explanation);
  rolePreviewBanner.append(swatch, copy);

  const roomCard = document.createElement("section");
  roomCard.className = "role-preview-card";
  const roomHeading = document.createElement("div");
  roomHeading.className = "role-preview-card-heading";
  const roomTitle = document.createElement("strong");
  roomTitle.textContent = "Room access";
  const roomMeta = document.createElement("span");
  roomMeta.className = "muted small";
  roomMeta.textContent = `${channels.length} room${channels.length === 1 ? "" : "s"}`;
  roomHeading.append(roomTitle, roomMeta);
  const roomList = document.createElement("div");
  roomList.className = "role-preview-channel-list";
  for (const channel of [...channels].sort((left, right) => left.position - right.position)) {
    const access = role.channelAccess.find((item) => item.channelId === channel.id);
    const categoryAccess = channel.categoryId ? (role.categoryAccess ?? []).find((item) => item.categoryId === channel.categoryId) : undefined;
    const canView = permissions.view_channels && (role.viewAllChannels || Boolean(access?.canView || access?.canUpload || categoryAccess?.canView || categoryAccess?.canUpload));
    const canSend = canView && permissions.send_messages;
    const canUpload = canView && permissions.upload_files && (role.viewAllChannels || Boolean(access?.canUpload || categoryAccess?.canUpload));
    const row = document.createElement("div");
    row.className = "role-preview-channel";
    const name = document.createElement("strong");
    name.textContent = channelName(channel);
    const actions = document.createElement("div");
    actions.className = "role-preview-channel-actions";
    for (const action of [
      ["View", canView],
      ["Send", canSend],
      ["Upload", canUpload],
    ] as const) {
      const badge = document.createElement("span");
      badge.className = `role-preview-action ${action[1] ? "allowed" : "blocked"}`;
      badge.textContent = action[0];
      actions.append(badge);
    }
    row.append(name, actions);
    roomList.append(row);
  }
  if (channels.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "No active encrypted rooms.";
    roomList.append(empty);
  }
  roomCard.append(roomHeading, roomList);

  const permissionCard = document.createElement("section");
  permissionCard.className = "role-preview-card";
  const permissionHeading = document.createElement("div");
  permissionHeading.className = "role-preview-card-heading";
  const permissionTitle = document.createElement("strong");
  permissionTitle.textContent = "Actions";
  const permissionMeta = document.createElement("span");
  permissionMeta.className = "muted small";
  permissionMeta.textContent = "Allowed and blocked";
  permissionHeading.append(permissionTitle, permissionMeta);
  const permissionGroups = document.createElement("div");
  permissionGroups.className = "role-preview-permission-groups";
  for (const group of previewPermissionGroups) {
    const groupSection = document.createElement("section");
    groupSection.className = "role-preview-permission-group";
    const groupTitle = document.createElement("h3");
    groupTitle.textContent = group.label;
    const groupList = document.createElement("div");
    groupList.className = "role-preview-permission-list";
    for (const permissionId of group.permissions) {
      const definition = permissionDefinitions.find((candidate) => candidate.id === permissionId);
      if (!definition) continue;
      const row = document.createElement("div");
      const allowed = permissions[permissionId];
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
    groupSection.append(groupTitle, groupList);
    permissionGroups.append(groupSection);
  }
  permissionCard.append(permissionHeading, permissionGroups);
  rolePreviewContent.replaceChildren(roomCard, permissionCard);
}

function startRolePreview(roleId: string) {
  previewRoleId = roleId;
  renderRolePreview();
  rolePreview.scrollIntoView({ behavior: "smooth", block: "start" });
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
      updates.encryptedMetadata = await cryptoClient!.encryptMetadata(channel.conversationId, channelMembers, { name: normalized, kind: "text" });
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
  for (const channel of channels) {
    const row = document.createElement("div");
    row.className = "settings-list-row channel-settings-row";
    row.dataset.channelId = channel.id;
    const name = document.createElement("input");
    const fallbackName = channelName(channel);
    name.value = fallbackName;
    name.dataset.fallbackName = fallbackName;
    name.maxLength = 80;
    name.setAttribute("aria-label", "Channel name");
    const category = document.createElement("select");
    category.setAttribute("aria-label", "Channel category");
    category.append(categoryOptions(channel.categoryId));
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
    row.append(name, category, position, save, archive);
    channelList.append(row);
  }
  if (channels.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "No active encrypted rooms.";
    channelList.append(empty);
  }
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

  const listPanel = document.createElement("aside");
  listPanel.className = "role-list-panel";
  const listHeading = document.createElement("div");
  listHeading.className = "role-list-heading";
  const listTitle = document.createElement("strong");
  listTitle.textContent = "Roles";
  const listCount = document.createElement("span");
  listCount.className = "muted small";
  listCount.textContent = `${editableRoles.length} total`;
  listHeading.append(listTitle, listCount);
  const search = document.createElement("input");
  search.type = "search";
  search.className = "role-search";
  search.placeholder = "Find a role";
  search.setAttribute("aria-label", "Find a role");
  search.value = roleSearchQuery;
  const listItems = document.createElement("div");
  listItems.className = "role-list-items";
  listItems.setAttribute("role", "listbox");
  listItems.setAttribute("aria-label", "Roles");

  const renderRoleList = () => {
    listItems.replaceChildren();
    const query = roleSearchQuery.trim().toLocaleLowerCase();
    const visibleRoles = editableRoles.filter((role) => !query || roleName(role).toLocaleLowerCase().includes(query));
    if (visibleRoles.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small role-list-empty";
      empty.textContent = "No matching roles.";
      listItems.append(empty);
      return;
    }
    for (const role of visibleRoles) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "role-list-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(role.id === selectedRoleId));
      item.style.setProperty("--role-color", role.color);
      const swatch = document.createElement("span");
      swatch.className = "role-color-swatch";
      swatch.style.background = role.color;
      const copy = document.createElement("span");
      copy.className = "role-list-copy";
      const name = document.createElement("strong");
      name.textContent = roleName(role);
      const meta = document.createElement("span");
      meta.textContent = role.isSystem ? `System · ${role.position}` : `Custom · ${role.position}`;
      copy.append(name, meta);
      item.append(swatch, copy);
      item.addEventListener("click", () => {
        if (role.id === selectedRoleId) return;
        if (roleEditorDirty && !window.confirm("Discard unsaved role changes?")) return;
        selectedRoleId = role.id;
        roleEditorDirty = false;
        renderRoles();
      });
      listItems.append(item);
    }
  };
  search.addEventListener("input", () => {
    roleSearchQuery = search.value;
    renderRoleList();
  });
  listPanel.append(listHeading, search, listItems);

  const role = editableRoles.find((candidate) => candidate.id === selectedRoleId) ?? editableRoles[0];
  const ownerRole = role.systemKey === "owner";
  const everyoneRole = role.systemKey === "everyone";
  const editableSystemRole = currentServer?.role === "owner" && role.systemKey !== "owner";
  const canEditThisRole = !role.isSystem || editableSystemRole;
  const canEditName = canEditThisRole && canEditRoleName();
  const canEditAppearance = canEditThisRole && canEditRoleAppearance();
  const canEditPermissions = canEditThisRole && canEditRolePermissions();
  const canEditRolePosition = canEditThisRole && canReorderRoles();
  const canEditChannelAccess = canEditThisRole && canManageRoleAccess();
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
  controls.append(mentionableLabel, viewAllLabel);
  card.append(controls);

  const permissionsHeading = document.createElement("h3");
  permissionsHeading.className = "role-card-subheading";
  permissionsHeading.textContent = "Permissions";
  card.append(permissionsHeading);
  const permissionGrid = document.createElement("div");
  permissionGrid.className = "role-permission-grid";
  const permissionInputs = new Map<ServerPermission, HTMLInputElement>();
  for (const definition of permissionDefinitions) {
    const label = document.createElement("label");
    label.className = "permission-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = role.permissions[definition.id];
    checkbox.disabled = ownerRole || !canEditPermissions || !metadataReady;
    checkbox.addEventListener("change", markDirty);
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
  card.append(permissionGrid);

  const channelHeading = document.createElement("h3");
  channelHeading.className = "role-card-subheading";
  channelHeading.textContent = "Room access";
  card.append(channelHeading);
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
  card.append(accessGrid);

  const categoryHeading = document.createElement("h3");
  categoryHeading.className = "role-card-subheading";
  categoryHeading.textContent = "Category access (inherited by rooms)";
  card.append(categoryHeading);
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
  card.append(categoryAccessGrid);

  const actions = document.createElement("div");
  actions.className = "role-card-actions";
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "secondary";
  preview.textContent = previewRoleId === role.id ? "Previewing role" : "View as role";
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
  manager.append(listPanel, card);
  renderRoleList();
  renderRolePreview();
}

function renderMembers() {
  memberList.replaceChildren();
  for (const member of members) {
    const row = document.createElement("div");
    row.className = "settings-list-row member-settings-row";
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
    row.append(avatar, copy);
    const assignedRoleIds = normalizeRoleIds(member.roleIds ?? roleAssignments.get(member.userId) ?? []);
    const roleSummary = document.createElement("div");
    roleSummary.className = "member-role-summary";
    const assignedRoles = assignedRoleIds
      .map((id) => roles.find((role) => role.id === id))
      .filter((role): role is CustomServerRole => Boolean(role))
      .sort((left, right) => right.position - left.position);
    const highestRole = assignedRoles[0];
    if (highestRole?.color) name.style.color = highestRole.color;
    for (const role of assignedRoles) {
      const badge = document.createElement("span");
      badge.className = "role-badge";
      badge.style.setProperty("--role-color", role.color);
      badge.textContent = roleName(role);
      roleSummary.append(badge);
    }
    if (roleSummary.childElementCount > 0) copy.append(roleSummary);
    const canManageRoles = canAssignRoles();
    if (member.userId !== currentUserId && member.role !== "owner" && canManageRoles) {
      const role = document.createElement("select");
      role.multiple = true;
      role.className = "member-role-select";
      role.setAttribute("aria-label", `Roles for ${member.displayName}`);
      role.append(roleOptions(assignedRoleIds));
      role.addEventListener("change", async () => {
        role.disabled = true;
        try {
          await api.updateServerMemberRoles(currentServer!.id, member.userId, [...role.selectedOptions].map((option) => option.value));
          await loadData();
          setStatus("Member roles updated.");
        } catch (error) {
          setStatus(readableError(error), true);
          role.disabled = false;
        }
      });
      row.append(role);
    }
    if (member.userId !== currentUserId && member.role !== "owner" &&
      hasAnyPermission("manage_members", "kick_members")) {
      const remove = document.createElement("button");
      remove.className = "danger-button";
      remove.type = "button";
      remove.textContent = "Remove";
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
      row.append(remove);
    }
    if (member.userId !== currentUserId && member.role !== "owner" && hasAnyPermission("manage_members", "ban_members")) {
      const ban = document.createElement("button");
      ban.className = "danger-button";
      ban.type = "button";
      ban.textContent = "Ban";
      ban.addEventListener("click", async () => {
        if (!window.confirm(`Ban ${member.displayName}? They will be blocked from future invites.`)) return;
        ban.disabled = true;
        try {
          await api.banServerMember(currentServer!.id, member.userId);
          await loadData();
          setStatus("Member banned.");
        } catch (error) {
          setStatus(readableError(error), true);
          ban.disabled = false;
        }
      });
      row.append(ban);
    }
    if (member.userId !== currentUserId && member.role !== "owner" && hasAnyPermission("manage_members", "timeout_members")) {
      const timeout = document.createElement("button");
      timeout.type = "button";
      timeout.className = "secondary";
      timeout.textContent = "Timeout";
      timeout.addEventListener("click", async () => {
        timeout.disabled = true;
        try {
          await api.timeoutServerMember(currentServer!.id, member.userId, 10 * 60);
          await loadData();
          setStatus("Member timed out for 10 minutes.");
        } catch (error) {
          setStatus(readableError(error), true);
          timeout.disabled = false;
        }
      });
      row.append(timeout);
    }
    memberList.append(row);
  }
}

function renderModeration() {
  moderationList.replaceChildren();
  const canUnban = hasAnyPermission("manage_members", "unban_members");
  const canRemoveTimeout = hasAnyPermission("manage_members", "remove_timeouts");
  if (moderation.bans.length === 0 && moderation.timeouts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "No active bans or timeouts.";
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
  deleteServer.hidden = currentServer.role !== "owner";
  categoryForm.querySelector("button")!.toggleAttribute("disabled", !hasAnyPermission("manage_channels", "manage_categories") || !metadataReady);
  channelForm.querySelector("button")!.toggleAttribute("disabled", !hasAnyPermission("manage_channels", "create_channels"));
  roleForm.querySelector("button")!.toggleAttribute("disabled", !hasAnyPermission("manage_roles", "create_roles") || !metadataReady);
  createInvite.disabled = !hasAnyPermission("manage_invites", "create_invites");
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
    renderRoles();
    return;
  }
  try {
    metadataMembers = await prepareConversation(conversationId);
    const [metadata, roleMetadata, categoryMetadata] = await Promise.all([
      decryptMetadata(conversationId, currentServer!.encryptedMetadata),
      Promise.all(roles.map((role) => decryptMetadata(conversationId, role.encryptedMetadata))),
      Promise.all(categories.map((category) => decryptMetadata(conversationId, category.encryptedMetadata))),
    ]);
    if (version !== metadataHydrationVersion || metadataConversationId !== conversationId) return;
    serverName.value = typeof metadata.name === "string" ? metadata.name : "";
    serverDescription.value = typeof metadata.description === "string" ? metadata.description : "";
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
    renderRoles();
    renderMembers();
    if (status.textContent === "Loading encrypted settings…") setStatus("");
    void hydrateChannelMetadata(version, channelSnapshot);
  } catch (error) {
    if (version !== metadataHydrationVersion) return;
    updateSettingsControls();
    setStatus("Encrypted settings are still loading. Try again in a moment.", true);
    console.warn("encrypted settings metadata hydration failed", error);
  }
}

async function loadData() {
  if (!serverId) throw new Error("server_not_selected");
  const version = ++metadataHydrationVersion;
  metadataReady = false;
  metadataMembers = [];
  const [serverResult, channelResult, categoryResult, memberResult, roleResult, moderationResult, inviteResult] = await Promise.all([
    api.server(serverId),
    api.serverChannels(serverId),
    api.serverCategories(serverId),
    api.serverMembers(serverId),
    api.serverRoles(serverId),
    api.serverModeration(serverId).catch((error) => {
      if (error instanceof ApiError && error.status === 403) return { bans: [], timeouts: [] } satisfies ServerModeration;
      throw error;
    }),
    api.serverInvites(serverId).catch((error) => {
      if (error instanceof ApiError && error.status === 403) return { invites: [] };
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
  roleNames.clear();
  categoryNames.clear();
  channelNames.clear();
  title.textContent = "Space settings";
  roleLabel.textContent = `${currentServer.role} · ${channels.length} encrypted room${channels.length === 1 ? "" : "s"}`;
  backToServer.href = destination(channels[0]?.id);

  const metadataChannel = roleResult.metadataConversationId
    ? channels.find((channel) => channel.conversationId === roleResult.metadataConversationId)
    : [...channels].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
  metadataConversationId = roleResult.metadataConversationId ?? metadataChannel?.conversationId;
  updateSettingsControls();
  renderCategories();
  renderChannels();
  renderOnboardingOptions();
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
    renderRoles();
  }
}

serverForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentServer || !metadataConversationId || !metadataReady) return;
  saveServer.disabled = true;
  try {
    const encryptedMetadata = await encryptMetadata(metadataConversationId, {
      name: serverName.value.trim(),
      description: serverDescription.value.trim().slice(0, 240),
      kind: "server",
    });
    const updated = await api.updateServerSettings(currentServer.id, {
      encryptedMetadata,
      onboardingChannelId: onboardingChannel.value || null,
    });
    currentServer = updated.server;
    setStatus("Space settings saved.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    saveServer.disabled = !currentServer.permissions.manage_server || !metadataReady;
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
    const result = await api.createChannel(currentServer.id, "", newChannelCategory.value || null);
    const channelMembers = await prepareConversation(result.channel.conversationId);
    const encryptedMetadata = await cryptoClient!.encryptMetadata(result.channel.conversationId, channelMembers, {
      name: newChannelName.value.trim(),
      kind: "text",
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

exitRolePreview.addEventListener("click", () => {
  previewRoleId = undefined;
  renderRolePreview();
  roleList.querySelector<HTMLElement>(".role-list-item[aria-selected='true']")?.focus();
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

logout.addEventListener("click", async () => {
  await api.logout().catch(() => undefined);
  clearSessionPassphrase();
  if (currentUserId) await forgetRememberedPassphrase(currentUserId).catch(() => undefined);
  window.location.assign("/");
});

async function boot() {
  if (!serverId) {
    window.location.assign("/app");
    return;
  }
  try {
    const result = await api.me();
    currentUserId = result.user.id;
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
