import { ApiClient } from "./api";
import { renderAvatar } from "./avatar";

export async function showMemberProfile(api: ApiClient, userId: string) {
  const dialog = document.createElement("dialog");
  dialog.className = "member-profile-dialog";
  dialog.setAttribute("aria-label", "Member profile");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "secondary";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());
  const body = document.createElement("div");
  body.className = "member-profile-body";
  body.textContent = "Loading profile…";
  dialog.append(body, close);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  try {
    const { user } = await api.user(userId);
    if (!dialog.isConnected) return;
    dialog.setAttribute("aria-label", `Profile for ${user.displayName}`);
    const avatar = document.createElement("span");
    avatar.className = "member-avatar";
    renderAvatar(avatar, user.displayName, user.id, user.avatarUrl);
    const name = document.createElement("strong");
    name.textContent = user.displayName;
    const username = document.createElement("span");
    username.textContent = `@${user.username}`;
    const created = document.createElement("span");
    created.textContent = `Joined Naigi ${new Date(user.createdAt).toLocaleDateString()}`;
    body.replaceChildren(avatar, name, username, created);
  } catch { body.textContent = "Unable to load this profile. You may no longer share a space with this member."; }
}
