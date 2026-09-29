import { ApiClient, ApiError, type User } from "./api";
import { renderAvatar } from "./avatar";
import { MAX_PROFILE_IMAGE_BYTES } from "./profile-image-codec";
import { openProfileImageEditor } from "./profile-image-editor";

type ProfileSettingsElements = {
  name: HTMLElement;
  avatar: HTMLElement;
  banner: HTMLElement;
  username: HTMLElement;
  profileForm: HTMLFormElement;
  displayNameInput: HTMLInputElement;
  profileFormState: HTMLElement;
  discardProfileChanges: HTMLButtonElement;
  profileImageInput: HTMLInputElement;
  removeProfileImage: HTMLButtonElement;
  profileBannerInput: HTMLInputElement;
  removeProfileBanner: HTMLButtonElement;
};

function uploadErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.code === "profile_image_too_large") return "Profile images must be 5 MB or smaller.";
  if (error instanceof ApiError && error.code === "unsupported_profile_image_type") return "Choose a PNG, JPG, GIF, WebP, or AVIF image.";
  if (error instanceof ApiError && error.code === "invalid_profile_image") return "That file is not a valid supported image.";
  if (error instanceof ApiError && error.code === "profile_banner_too_large") return "Profile banners must be 5 MB or smaller.";
  if (error instanceof ApiError && error.code === "unsupported_profile_banner_type") return "Choose a PNG, JPG, GIF, WebP, or AVIF banner.";
  if (error instanceof ApiError && error.code === "invalid_profile_banner") return "That file is not a valid supported banner image.";
  return error instanceof Error ? error.message : "Unable to upload profile image.";
}

export function setupProfileSettings(
  api: ApiClient,
  elements: ProfileSettingsElements,
  setStatus: (message: string, error?: boolean) => void,
) {
  let currentProfile: User | undefined;

  function syncProfileFormState() {
    const dirty = Boolean(currentProfile && elements.displayNameInput.value.trim() !== currentProfile.displayName);
    const saveButton = elements.profileForm.querySelector<HTMLButtonElement>("button[type=submit]");
    elements.profileFormState.textContent = dirty ? "Unsaved changes" : "No unsaved changes";
    elements.profileFormState.dataset.state = dirty ? "dirty" : "saved";
    elements.discardProfileChanges.hidden = !dirty;
    if (saveButton) saveButton.disabled = !dirty;
  }

  function renderProfile(user: User, preserveDisplayNameDraft = false) {
    currentProfile = user;
    elements.name.textContent = user.displayName;
    renderAvatar(elements.avatar, user.displayName, user.id, user.avatarUrl);
    elements.banner.replaceChildren();
    if (user.bannerUrl) {
      const image = document.createElement("img");
      image.src = user.bannerUrl;
      image.alt = "";
      elements.banner.append(image);
      delete elements.banner.dataset.empty;
    } else {
      elements.banner.dataset.empty = "true";
    }
    elements.username.textContent = `@${user.username}`;
    if (!preserveDisplayNameDraft) elements.displayNameInput.value = user.displayName;
    elements.removeProfileImage.hidden = !user.avatarUrl;
    elements.removeProfileBanner.hidden = !user.bannerUrl;
    syncProfileFormState();
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
      syncProfileFormState();
    }
  });

  elements.displayNameInput.addEventListener("input", syncProfileFormState);
  elements.discardProfileChanges.addEventListener("click", () => {
    if (!currentProfile) return;
    elements.displayNameInput.value = currentProfile.displayName;
    syncProfileFormState();
    elements.displayNameInput.focus();
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
      renderProfile(result.user, true);
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
      renderProfile({ ...currentProfile, avatarUrl: null }, true);
      setStatus("Profile image removed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to remove profile image.", true);
    } finally {
      elements.removeProfileImage.disabled = false;
      elements.profileImageInput.disabled = false;
    }
  });

  elements.profileBannerInput.addEventListener("change", async () => {
    const file = elements.profileBannerInput.files?.[0];
    elements.profileBannerInput.value = "";
    if (!file) return;
    if (file.size > MAX_PROFILE_IMAGE_BYTES) {
      setStatus("Profile banners must be 5 MB or smaller.", true);
      return;
    }
    elements.profileBannerInput.disabled = true;
    elements.removeProfileBanner.disabled = true;
    try {
      setStatus("Uploading profile banner…");
      const result = await api.uploadProfileBanner(file);
      renderProfile(result.user, true);
      setStatus("Profile banner updated.");
    } catch (error) {
      setStatus(uploadErrorMessage(error), true);
    } finally {
      elements.profileBannerInput.disabled = false;
      elements.removeProfileBanner.disabled = false;
    }
  });

  elements.removeProfileBanner.addEventListener("click", async () => {
    if (!currentProfile?.bannerUrl) return;
    elements.removeProfileBanner.disabled = true;
    elements.profileBannerInput.disabled = true;
    try {
      await api.removeProfileBanner();
      renderProfile({ ...currentProfile, bannerUrl: null }, true);
      setStatus("Profile banner removed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to remove profile banner.", true);
    } finally {
      elements.removeProfileBanner.disabled = false;
      elements.profileBannerInput.disabled = false;
    }
  });

  return { renderProfile };
}
