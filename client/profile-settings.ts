import { ApiClient, ApiError, type User } from "./api";
import { renderAvatar } from "./avatar";
import { MAX_PROFILE_IMAGE_BYTES } from "./profile-image-codec";
import { openProfileImageEditor } from "./profile-image-editor";

type ProfileSettingsElements = {
  name: HTMLElement;
  avatar: HTMLElement;
  username: HTMLElement;
  profileForm: HTMLFormElement;
  displayNameInput: HTMLInputElement;
  profileImageInput: HTMLInputElement;
  removeProfileImage: HTMLButtonElement;
};

function uploadErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.code === "profile_image_too_large") return "Profile images must be 5 MB or smaller.";
  if (error instanceof ApiError && error.code === "unsupported_profile_image_type") return "Choose a PNG, JPG, GIF, WebP, or AVIF image.";
  if (error instanceof ApiError && error.code === "invalid_profile_image") return "That file is not a valid supported image.";
  return error instanceof Error ? error.message : "Unable to upload profile image.";
}

export function setupProfileSettings(
  api: ApiClient,
  elements: ProfileSettingsElements,
  setStatus: (message: string, error?: boolean) => void,
) {
  let currentProfile: User | undefined;

  function renderProfile(user: User) {
    currentProfile = user;
    elements.name.textContent = user.displayName;
    renderAvatar(elements.avatar, user.displayName, user.id, user.avatarUrl);
    elements.username.textContent = `@${user.username}`;
    elements.displayNameInput.value = user.displayName;
    elements.removeProfileImage.hidden = !user.avatarUrl;
  }

  elements.profileForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = elements.displayNameInput.value.trim();
    if (!value) return;
    const button = elements.profileForm.querySelector<HTMLButtonElement>("button[type=submit]");
    if (button) button.disabled = true;
    try {
      const result = await api.updateProfile(value);
      renderProfile(result.user);
      setStatus("Profile saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to save profile.", true);
    } finally {
      if (button) button.disabled = false;
    }
  });

  elements.profileImageInput.addEventListener("change", async () => {
    const file = elements.profileImageInput.files?.[0];
    elements.profileImageInput.value = "";
    if (!file) return;
    if (file.size > MAX_PROFILE_IMAGE_BYTES) {
      setStatus("Profile images must be 5 MB or smaller.", true);
      return;
    }

    elements.profileImageInput.disabled = true;
    elements.removeProfileImage.disabled = true;
    try {
      const editedFile = await openProfileImageEditor(file);
      if (!editedFile) return;
      setStatus("Uploading profile image…");
      const result = await api.uploadProfileImage(editedFile);
      renderProfile(result.user);
      setStatus("Profile image updated.");
    } catch (error) {
      setStatus(uploadErrorMessage(error), true);
    } finally {
      elements.profileImageInput.disabled = false;
      elements.removeProfileImage.disabled = false;
    }
  });

  elements.removeProfileImage.addEventListener("click", async () => {
    if (!currentProfile?.avatarUrl) return;
    elements.removeProfileImage.disabled = true;
    elements.profileImageInput.disabled = true;
    try {
      await api.removeProfileImage();
      renderProfile({ ...currentProfile, avatarUrl: null });
      setStatus("Profile image removed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to remove profile image.", true);
    } finally {
      elements.removeProfileImage.disabled = false;
      elements.profileImageInput.disabled = false;
    }
  });

  return { renderProfile };
}
