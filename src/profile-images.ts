import {
  ProfileImageInvalidError,
  profileImagePath,
  removeProfileImage,
  storeProfileImage,
} from "./attachments/storage";

export { ProfileImageInvalidError, profileImagePath, removeProfileImage, storeProfileImage };

export function profileImageUrl(userId: string, storageKey: string | null | undefined) {
  return storageKey ? `/v1/users/${userId}/avatar?v=${encodeURIComponent(storageKey)}` : null;
}

export function profileBannerUrl(userId: string, storageKey: string | null | undefined) {
  return storageKey ? `/v1/users/${userId}/banner?v=${encodeURIComponent(storageKey)}` : null;
}

const profileImageExtensions: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/apng": "png",
  "image/png": "png",
  "image/webp": "webp",
};

export function profileImageMetadata(contentType: string | null | undefined) {
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mimeType) return null;
  const extension = profileImageExtensions[mimeType];
  return extension ? { extension, mimeType } : null;
}

function hasBytes(bytes: Buffer, ...expected: number[]) {
  return bytes.length >= expected.length && expected.every((value, index) => bytes[index] === value);
}

export function validProfileImageBytes(bytes: Buffer, mimeType: string) {
  if (mimeType === "image/jpeg") return hasBytes(bytes, 0xff, 0xd8, 0xff);
  if (mimeType === "image/png" || mimeType === "image/apng") {
    return hasBytes(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  }
  if (mimeType === "image/gif") {
    return bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a");
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (mimeType === "image/avif") {
    if (bytes.length < 12 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") return false;
    const brand = bytes.subarray(8, 12).toString("ascii");
    return brand === "avif" || brand === "avis" || brand === "mif1";
  }
  return false;
}
