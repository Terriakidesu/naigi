import {
  ApiClient,
  ApiError,
  type CustomServerRole,
  type Server,
  type ServerCategory,
  type ServerChannel,
  type ServerMember,
  type ServerModeration,
  type ServerPermission,
  type ServerPermissionMap,
} from "./api";
import { CryptoClient } from "./crypto";
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
const categoryNames = new Map<string, string>();
const channelNames = new Map<string, string>();
const roleNames = new Map<string, string>();

const permissionDefinitions: Array<{ id: ServerPermission; label: string; description: string }> = [
  { id: "view_channels", label: "View channels", description: "See channels and read encrypted history." },
  { id: "send_messages", label: "Send messages", description: "Post encrypted messages in visible channels." },
  { id: "upload_files", label: "Upload files", description: "Upload encrypted files in all unrestricted channels." },
  { id: "mention_everyone", label: "Mention @everyone", description: "Use the @everyone broadcast mention." },
  { id: "mention_here", label: "Mention @here", description: "Use the @here broadcast mention." },
  { id: "mention_roles", label: "Mention roles", description: "Ping roles marked as mentionable." },
  { id: "manage_server", label: "Manage server", description: "Edit server details and server-wide settings." },
  { id: "manage_channels", label: "Manage channels", description: "Create, sort, edit, and archive channels." },
  { id: "manage_invites", label: "Manage invites", description: "Create and revoke invite links." },
  { id: "manage_roles", label: "Manage roles", description: "Create roles and assign them to members." },
  { id: "manage_members", label: "Manage members", description: "Remove members and inspect moderation lists." },
  { id: "ban_members", label: "Ban members", description: "Ban members and block future invites." },
  { id: "timeout_members", label: "Timeout members", description: "Temporarily prevent messaging and uploads." },
  { id: "delete_messages", label: "Delete messages", description: "Permanently remove encrypted messages for everyone." },
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

function readableError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "current_password_incorrect") return "The current password is incorrect.";
    if (error.code === "insufficient_server_permissions") return "You do not have permission to manage this server.";
    if (error.code === "insufficient_channel_permissions") return "This role cannot use that channel.";
    if (error.code === "invalid_role_permissions") return "The role permissions were invalid.";
    if (error.code === "owner_role_is_not_customizable") return "The owner role cannot be pinged or restricted.";
    if (error.code === "cannot_delete_system_role") return "System roles cannot be deleted.";
    if (error.code === "invalid_role_assignment") return "One or more selected roles are no longer available.";
    if (error.code === "cannot_assign_owner_role") return "The owner role cannot be assigned.";
    if (error.code === "role_hierarchy_violation") return "You can only manage roles below your highest role.";
    if (error.code === "server_banned") return "This account is banned from the server.";
    if (error.code === "cannot_archive_last_channel") return "A server must keep one active text channel.";
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
  cryptoClient = new CryptoClient(api, currentUserId, passphrase);
  await cryptoClient.initialize();
  confirmLocalUnlock();
}

async function prepareConversation(conversationId: string) {
  if (!cryptoClient) throw new Error("crypto_not_initialized");
  const result = await api.conversationMembers(conversationId);
  await cryptoClient.prepareConversation(conversationId, result.members);
  await cryptoClient.syncToDevice().catch(() => undefined);
  return result.members;
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
  if (roleNames.has(role.id)) return roleNames.get(role.id)!;
  if (role.systemKey === "owner") return "Owner";
  if (role.systemKey === "admin") return "Administrator";
  if (role.systemKey === "member") return "Member";
  return "Unnamed role";
}

function defaultRolePermissions(): Partial<ServerPermissionMap> {
  return { view_channels: true };
}

function roleOptions(selected: string[]) {
  const fragment = document.createDocumentFragment();
  for (const role of roles.filter((candidate) => candidate.systemKey !== "owner")) {
    const option = document.createElement("option");
    option.value = role.id;
    option.textContent = roleName(role);
    option.selected = selected.includes(role.id);
    option.style.color = role.color;
    fragment.append(option);
  }
  return fragment;
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
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save";
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
    archive.addEventListener("click", async () => {
      if (!window.confirm(`Archive ${name.value || "this category"}? Channels will become uncategorized.`)) return;
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
    const channelMembers = await prepareConversation(channel.conversationId);
    const encryptedMetadata = await cryptoClient!.encryptMetadata(channel.conversationId, channelMembers, { name: normalized, kind: "text" });
    await api.updateChannel(currentServer!.id, channel.id, {
      encryptedMetadata,
      categoryId: category.value || null,
      position: Math.max(0, Number(position.value) || 0),
    });
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
    const name = document.createElement("input");
    name.value = channelName(channel);
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
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save";
    save.addEventListener("click", () => void saveChannel(channel, name, category, position, save));
    const archive = document.createElement("button");
    archive.className = "danger-button";
    archive.type = "button";
    archive.textContent = "Archive";
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
    empty.textContent = "No active text channels.";
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
    return;
  }
  const canManageRoles = Boolean(currentServer && currentServer.permissions.manage_roles);
  for (const role of roles) {
    const card = document.createElement("article");
    card.className = "role-settings-card";
    card.style.setProperty("--role-color", role.color);

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
      ownerLabel.textContent = owner ? `${owner.displayName} · cannot be pinged` : "Server owner · cannot be pinged";
      heading.append(ownerLabel);
    }
    card.append(heading);

    const form = document.createElement("div");
    form.className = "role-card-form";
    const name = document.createElement("input");
    name.value = roleName(role);
    name.maxLength = 80;
    name.setAttribute("aria-label", `${roleName(role)} name`);
    name.disabled = role.systemKey === "owner" || !canManageRoles;
    const color = document.createElement("input");
    color.type = "color";
    color.value = role.color;
    color.setAttribute("aria-label", `${roleName(role)} color`);
    color.disabled = !canManageRoles || role.systemKey === "owner";
    const position = document.createElement("input");
    position.type = "number";
    position.min = "0";
    position.max = "1000000";
    position.value = String(role.position);
    position.className = "position-input";
    position.setAttribute("aria-label", `${roleName(role)} position`);
    position.disabled = !canManageRoles || role.systemKey === "owner";
    form.append(name, color, position);
    card.append(form);

    const controls = document.createElement("div");
    controls.className = "role-card-controls";
    const mentionableLabel = document.createElement("label");
    mentionableLabel.className = "checkbox-label role-toggle";
    const mentionable = document.createElement("input");
    mentionable.type = "checkbox";
    mentionable.checked = role.mentionable;
    mentionable.disabled = !canManageRoles || role.systemKey === "owner";
    const mentionableText = document.createElement("span");
    mentionableText.textContent = "Mentionable role";
    mentionableLabel.append(mentionable, mentionableText);
    const viewAllLabel = document.createElement("label");
    viewAllLabel.className = "checkbox-label role-toggle";
    const viewAll = document.createElement("input");
    viewAll.type = "checkbox";
    viewAll.checked = role.viewAllChannels;
    viewAll.disabled = !canManageRoles || role.systemKey === "owner";
    const viewAllText = document.createElement("span");
    viewAllText.textContent = "View every channel";
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
      checkbox.disabled = !canManageRoles || role.systemKey === "owner";
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
    channelHeading.textContent = "Channel access";
    card.append(channelHeading);
    const accessGrid = document.createElement("div");
    accessGrid.className = "role-channel-access-grid";
    const channelInputs = new Map<string, { view: HTMLInputElement; upload: HTMLInputElement }>();
    for (const channel of channels) {
      const access = role.channelAccess.find((item) => item.channelId === channel.id);
      const row = document.createElement("div");
      row.className = "role-channel-access-row";
      const label = document.createElement("strong");
      label.textContent = channelName(channel);
      const viewLabel = document.createElement("label");
      viewLabel.className = "checkbox-label";
      const view = document.createElement("input");
      view.type = "checkbox";
      view.checked = Boolean(access?.canView || access?.canUpload);
      view.disabled = !canManageRoles || role.systemKey === "owner" || role.viewAllChannels;
      const viewText = document.createElement("span");
      viewText.textContent = "View";
      viewLabel.append(view, viewText);
      const uploadLabel = document.createElement("label");
      uploadLabel.className = "checkbox-label";
      const upload = document.createElement("input");
      upload.type = "checkbox";
      upload.checked = Boolean(access?.canUpload);
      upload.disabled = !canManageRoles || role.systemKey === "owner" || role.viewAllChannels || !role.permissions.upload_files;
      upload.addEventListener("change", () => {
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
      empty.textContent = "Create a channel before restricting this role.";
      accessGrid.append(empty);
    }
    card.append(accessGrid);

    const actions = document.createElement("div");
    actions.className = "role-card-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save role";
    save.disabled = !canManageRoles || role.systemKey === "owner";
    save.addEventListener("click", async () => {
      if (!currentServer || !metadataConversationId) return;
      save.disabled = true;
      try {
        const permissions = Object.fromEntries(permissionDefinitions.map((definition) => [
          definition.id,
          permissionInputs.get(definition.id)!.checked,
        ])) as Partial<ServerPermissionMap>;
        const encryptedMetadata = role.systemKey === "owner"
          ? undefined
          : await encryptMetadata(metadataConversationId, { name: name.value.trim(), kind: "server-role" });
        await api.updateServerRole(currentServer.id, role.id, {
          ...(encryptedMetadata ? { encryptedMetadata } : {}),
          color: color.value,
          position: Math.max(0, Number(position.value) || 0),
          permissions,
          mentionable: mentionable.checked,
          viewAllChannels: viewAll.checked,
        });
        for (const channel of channels) {
          const inputs = channelInputs.get(channel.id);
          if (!inputs || viewAll.checked || role.systemKey === "owner") continue;
          if (!inputs.view.checked && !inputs.upload.checked) {
            await api.removeServerRoleChannelAccess(currentServer.id, role.id, channel.id);
          } else {
            await api.updateServerRoleChannelAccess(currentServer.id, role.id, channel.id, inputs.view.checked, inputs.upload.checked);
          }
        }
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
      remove.disabled = !canManageRoles;
      remove.addEventListener("click", async () => {
        if (!currentServer || !window.confirm(`Delete ${roleName(role)}? Members will keep access only through their other roles.`)) return;
        remove.disabled = true;
        try {
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
    roleList.append(card);
  }
}

function renderMembers() {
  memberList.replaceChildren();
  for (const member of members) {
    const row = document.createElement("div");
    row.className = "settings-list-row member-settings-row";
    const copy = document.createElement("div");
    copy.className = "settings-row-copy";
    const name = document.createElement("strong");
    name.textContent = member.displayName;
    const username = document.createElement("span");
    username.textContent = `@${member.username} · ${member.role === "owner" ? "Owner" : "member"}`;
    copy.append(name, username);
    row.append(copy);
    const assignedRoleIds = normalizeRoleIds(member.roleIds ?? roleAssignments.get(member.userId) ?? []);
    const roleSummary = document.createElement("div");
    roleSummary.className = "member-role-summary";
    for (const role of assignedRoleIds
      .map((id) => roles.find((role) => role.id === id))
      .filter((role): role is CustomServerRole => Boolean(role))
      .sort((left, right) => right.position - left.position)) {
      const badge = document.createElement("span");
      badge.className = "role-badge";
      badge.style.setProperty("--role-color", role.color);
      badge.textContent = roleName(role);
      roleSummary.append(badge);
    }
    if (roleSummary.childElementCount > 0) copy.append(roleSummary);
    const canManageRoles = Boolean(currentServer?.permissions.manage_roles);
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
      currentServer?.permissions.manage_members) {
      const remove = document.createElement("button");
      remove.className = "danger-button";
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Remove ${member.displayName} from this server?`)) return;
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
    if (member.userId !== currentUserId && member.role !== "owner" && currentServer?.permissions.ban_members) {
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
    if (member.userId !== currentUserId && member.role !== "owner" && currentServer?.permissions.timeout_members) {
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
  const canBan = Boolean(currentServer?.permissions.ban_members);
  const canTimeout = Boolean(currentServer?.permissions.timeout_members);
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
    if (canBan) {
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
    if (canTimeout) {
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
  if (invites.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "No invite links yet.";
    inviteList.append(empty);
    return;
  }
  for (const invite of invites) {
    const row = document.createElement("div");
    row.className = "settings-list-row";
    const copy = document.createElement("div");
    copy.className = "settings-row-copy";
    const name = document.createElement("strong");
    name.textContent = invite.revokedAt ? "Revoked invite" : "Active invite";
    const details = document.createElement("span");
    details.textContent = `${invite.uses}${invite.maxUses ? `/${invite.maxUses}` : " uses"} · ${invite.expiresAt ? `expires ${new Date(invite.expiresAt).toLocaleString()}` : "never expires"}`;
    copy.append(name, details);
    row.append(copy);
    if (!invite.revokedAt) {
      const revoke = document.createElement("button");
      revoke.className = "danger-button";
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try {
          await api.revokeServerInvite(currentServer!.id, invite.id);
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
}

async function loadData() {
  if (!serverId) throw new Error("server_not_selected");
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
  title.textContent = "Server settings";
  roleLabel.textContent = `${currentServer.role} · ${channels.length} text channel${channels.length === 1 ? "" : "s"}`;
  saveServer.disabled = !currentServer.permissions.manage_server;
  deleteServer.hidden = currentServer.role !== "owner";
  categoryForm.querySelector("button")!.toggleAttribute("disabled", !currentServer.permissions.manage_channels);
  channelForm.querySelector("button")!.toggleAttribute("disabled", !currentServer.permissions.manage_channels);
  roleForm.querySelector("button")!.toggleAttribute("disabled", !currentServer.permissions.manage_roles);
  createInvite.disabled = !currentServer.permissions.manage_invites;
  backToServer.href = destination(channels[0]?.id);

  const metadataChannel = roleResult.metadataConversationId
    ? channels.find((channel) => channel.conversationId === roleResult.metadataConversationId)
    : [...channels].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
  metadataConversationId = roleResult.metadataConversationId ?? metadataChannel?.conversationId;
  if (metadataConversationId) {
    metadataMembers = await prepareConversation(metadataConversationId);
    const metadata = await decryptMetadata(metadataConversationId, currentServer.encryptedMetadata);
    serverName.value = typeof metadata.name === "string" ? metadata.name : "";
    serverDescription.value = typeof metadata.description === "string" ? metadata.description : "";
    roleNames.clear();
    for (const role of roles) {
      const roleMetadata = await decryptMetadata(metadataConversationId, role.encryptedMetadata);
      if (typeof roleMetadata.name === "string" && roleMetadata.name.trim()) roleNames.set(role.id, roleMetadata.name.trim().slice(0, 80));
    }
    for (const category of categories) {
      const categoryMetadata = await decryptMetadata(metadataConversationId, category.encryptedMetadata);
      if (typeof categoryMetadata.name === "string") categoryNames.set(category.id, categoryMetadata.name);
    }
    for (const channel of channels) {
      const channelMembers = await prepareConversation(channel.conversationId);
      const channelMetadata = await decryptMetadata(channel.conversationId, channel.encryptedMetadata);
      if (typeof channelMetadata.name === "string") channelNames.set(channel.id, channelMetadata.name);
      // Ensure newly-created rooms have their current member devices prepared before they are edited.
      if (channelMembers.length === 0) channelNames.delete(channel.id);
    }
  }
  renderCategories();
  renderChannels();
  renderRoles();
  renderMembers();
  renderModeration();
  renderInvites(inviteResult.invites);
}

serverForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentServer || !metadataConversationId) return;
  saveServer.disabled = true;
  try {
    const encryptedMetadata = await encryptMetadata(metadataConversationId, {
      name: serverName.value.trim(),
      description: serverDescription.value.trim().slice(0, 240),
      kind: "server",
    });
    await api.updateServer(currentServer.id, encryptedMetadata);
    setStatus("Server settings saved.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    saveServer.disabled = !currentServer.permissions.manage_server;
  }
});

deleteServer.addEventListener("click", async () => {
  if (!currentServer || currentServer.role !== "owner") return;
  const name = serverName.value.trim() || "this server";
  if (!window.confirm(`Permanently delete ${name}? All channels and encrypted history will be removed for every member.`)) return;
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
  if (!currentServer || !metadataConversationId || !newCategoryName.value.trim()) return;
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
    if (button) button.disabled = !currentServer?.permissions.manage_channels;
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
    if (button) button.disabled = !currentServer?.permissions.manage_channels;
  }
});

roleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentServer || !metadataConversationId || !newRoleName.value.trim()) return;
  const button = roleForm.querySelector<HTMLButtonElement>("button");
  if (button) button.disabled = true;
  try {
    const name = newRoleName.value.trim();
    const encryptedMetadata = await encryptMetadata(metadataConversationId, { name, kind: "server-role" });
    await api.createServerRole(currentServer.id, {
      encryptedMetadata,
      color: newRoleColor.value,
      permissions: defaultRolePermissions(),
      mentionable: false,
      viewAllChannels: true,
    });
    newRoleName.value = "";
    await loadData();
    setStatus("Role created.");
  } catch (error) {
    setStatus(readableError(error), true);
  } finally {
    if (button) button.disabled = !currentServer?.permissions.manage_roles;
  }
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
    createInvite.disabled = !currentServer?.permissions.manage_invites;
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
    else setStatus(readableError(error), true);
  }
}

void boot();
