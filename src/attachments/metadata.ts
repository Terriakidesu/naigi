/**
 * Encrypted attachment and custom-emoji metadata.
 *
 * Attachments are stored as opaque ciphertext: the backend never sees what is inside, and the
 * content type is whatever the encrypting client declared. It is validated for shape and
 * consistency, not for safety, and the download route marks it `nosniff`.
 */

export const maxCustomEmojiBytes = 10 * 1024 * 1024;

/**
 * Bounds for `POST /v1/crypto/send-to-device`.
 *
 * Without them a single authenticated request could fan out across an unbounded number of
 * recipient devices and persist an unbounded `jsonb` payload per event, which is a
 * storage-exhaustion vector rather than a protocol limit.
 */
export const maxToDeviceRecipients = 100;
export const maxToDeviceDevicesPerRecipient = 100;
export const maxToDeviceEventsPerRequest = 200;
export const maxToDeviceEventBytes = 64 * 1024;

/** Extensions whose content type is pinned, so a declared type cannot contradict the extension. */
const imageMimeExtensions: Record<string, string[]> = {
  avif: ["image/avif"],
  gif: ["image/gif"],
  heic: ["image/heic"],
  jpeg: ["image/jpeg"],
  jpg: ["image/jpeg"],
  png: ["image/png"],
  webp: ["image/webp"],
};

const videoMimeExtensions: Record<string, string[]> = {
  mp4: ["video/mp4"],
  mov: ["video/quicktime"],
  ogg: ["video/ogg"],
  ogv: ["video/ogg"],
  webm: ["video/webm"],
};

/**
 * Normalises and checks a declared extension/content-type pair.
 *
 * Returns `null` when the pair is inconsistent or the type is malformed. An extension outside the
 * pinned tables may carry any well-formed `type/subtype`, since the bytes are ciphertext and the
 * value is only ever echoed back with `nosniff` and a forced download.
 */
export function attachmentMetadata(extension: string, mimeType: string) {
  const normalizedExtension = extension.toLowerCase();
  const normalizedMimeType = mimeType.toLowerCase();
  const allowed = imageMimeExtensions[normalizedExtension] ?? videoMimeExtensions[normalizedExtension];
  if (allowed && !allowed.includes(normalizedMimeType)) return null;
  if (!allowed && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalizedMimeType)) return null;
  return { extension: normalizedExtension, mimeType: normalizedMimeType };
}
