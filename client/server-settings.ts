import { ApiClient, ApiError, type Server, type ServerCategory, type ServerChannel, type ServerMember } from "./api";
import { CryptoClient } from "./crypto";
import { showOneTimeToken } from "./ui-dialog";
import {
  clearSessionPassphrase,
  forgetRememberedPassphrase,
  recoverRememberedPassphrase,
  takeSessionPassphrase,
} from "./unlock-vault";

const api = new ApiClient();
const serverId = new URLSearchParams(window.location.search).get("server");
const title = document.getElementById("server-settings-title") as HTMLElement;
const roleLabel = document.getElementById("server-settings-role") as HTMLElement;
const serverForm = document.getElementById("server-form") as HTMLFormElement;
const serverName = document.getElementById("server-name") as HTMLInputElement;
const serverDescription = document.getElementById("server-description") as HTMLTextAreaElement;
const saveServer = document.getElementById("save-server-button") as HTMLButtonElement;
const categoryForm = document.getElementById("category-form") as HTMLFormElement;
const newCategoryName = document.getElementById("new-category-name") as HTMLInputElement;
const categoryList = document.getElementById("category-settings-list") as HTMLElement;
const channelForm = document.getElementById("channel-form") as HTMLFormElement;
const newChannelName = document.getElementById("new-channel-name") as HTMLInputElement;
const newChannelCategory = document.getElementById("new-channel-category") as HTMLSelectElement;
const channelList = document.getElementById("channel-settings-list") as HTMLElement;
const memberList = document.getElementById("member-settings-list") as HTMLElement;
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
let cryptoClient: CryptoClient | undefined;
let metadataConversationId: string | undefined;
let metadataMembers: Awaited<ReturnType<ApiClient["conversationMembers"]>>["members"] = [];
const categoryNames = new Map<string, string>();
const channelNames = new Map<string, string>();

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function readableError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "current_password_incorrect") return "The current password is incorrect.";
    if (error.code === "insufficient_server_permissions") return "You do not have permission to manage this server.";
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
  const passphrase = takeSessionPassphrase() ?? await recoverRememberedPassphrase(currentUserId).catch(() => null);
  if (!passphrase) {
    window.location.assign(`/unlock?return=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
    return;
  }
  cryptoClient = new CryptoClient(api, currentUserId, passphrase);
  await cryptoClient.initialize();
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
    username.textContent = `@${member.username} · ${member.role}`;
    copy.append(name, username);
    row.append(copy);
    if (member.userId !== currentUserId && currentServer?.role === "owner") {
      const role = document.createElement("select");
      role.innerHTML = `<option value="member">Member</option><option value="admin">Admin</option>`;
      role.value = member.role === "admin" ? "admin" : "member";
      role.addEventListener("change", async () => {
        try {
          await api.updateServerMemberRole(currentServer!.id, member.userId, role.value as "admin" | "member");
          await loadData();
          setStatus("Member role updated.");
        } catch (error) {
          setStatus(readableError(error), true);
        }
      });
      row.append(role);
    }
    if (member.userId !== currentUserId && member.role !== "owner" &&
      (currentServer?.role === "owner" || (currentServer?.role === "admin" && member.role === "member"))) {
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
    memberList.append(row);
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
  const [serverResult, channelResult, categoryResult, memberResult, inviteResult] = await Promise.all([
    api.server(serverId),
    api.serverChannels(serverId),
    api.serverCategories(serverId),
    api.serverMembers(serverId),
    api.serverInvites(serverId).catch((error) => {
      if (error instanceof ApiError && error.status === 403) return { invites: [] };
      throw error;
    }),
  ]);
  currentServer = serverResult.server;
  channels = channelResult.channels;
  categories = categoryResult.categories;
  members = memberResult.members;
  title.textContent = "Server settings";
  roleLabel.textContent = `${currentServer.role} · ${channels.length} text channel${channels.length === 1 ? "" : "s"}`;
  saveServer.disabled = currentServer.role === "member";
  categoryForm.querySelector("button")!.toggleAttribute("disabled", currentServer.role === "member");
  channelForm.querySelector("button")!.toggleAttribute("disabled", currentServer.role === "member");
  createInvite.disabled = currentServer.role === "member";
  backToServer.href = destination(channels[0]?.id);

  const metadataChannel = [...channels].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
  if (metadataChannel) {
    metadataConversationId = metadataChannel.conversationId;
    metadataMembers = await prepareConversation(metadataConversationId);
    const metadata = await decryptMetadata(metadataConversationId, currentServer.encryptedMetadata);
    serverName.value = typeof metadata.name === "string" ? metadata.name : "";
    serverDescription.value = typeof metadata.description === "string" ? metadata.description : "";
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
  renderMembers();
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
    saveServer.disabled = currentServer.role === "member";
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
    if (button) button.disabled = currentServer?.role === "member";
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
    if (button) button.disabled = currentServer?.role === "member";
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
    createInvite.disabled = currentServer?.role === "member";
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
