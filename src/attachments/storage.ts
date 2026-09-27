import { mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";

export class AttachmentTooLargeError extends Error {
  constructor() {
    super("attachment exceeds the configured size limit");
    this.name = "AttachmentTooLargeError";
  }
}

export class AttachmentSizeMismatchError extends Error {
  constructor() {
    super("attachment size does not match the declared size");
    this.name = "AttachmentSizeMismatchError";
  }
}

export class ProfileImageInvalidError extends Error {
  constructor() {
    super("profile image bytes are invalid");
    this.name = "ProfileImageInvalidError";
  }
}

export function attachmentPath(storageKey: string) {
  if (!/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i.test(storageKey)) {
    throw new Error("invalid attachment storage key");
  }
  return join(config.attachmentsDirectory, storageKey);
}

export function profileImagePath(storageKey: string) {
  if (!/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i.test(storageKey)) {
    throw new Error("invalid profile image storage key");
  }
  return join(config.profileImagesDirectory, storageKey);
}

async function readRequestBody(request: Request, maxBytes: number) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      throw new AttachmentTooLargeError();
    }
  }

  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AttachmentTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

export async function storeEncryptedAttachment(request: Request, storageKey: string, expectedSize: number) {
  const bytes = await readRequestBody(request, config.maxAttachmentBytes);
  if (bytes.byteLength !== expectedSize) throw new AttachmentSizeMismatchError();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Buffer.from(digest);
  const finalPath = attachmentPath(storageKey);
  const temporaryPath = `${finalPath}.${crypto.randomUUID()}.upload`;

  await mkdir(config.attachmentsDirectory, { recursive: true });
  await Bun.write(temporaryPath, bytes);
  await rename(temporaryPath, finalPath);

  return { size: bytes.byteLength, hash };
}

export async function storeProfileImage(
  request: Request,
  storageKey: string,
  maxBytes: number,
  validate: (bytes: Buffer) => boolean,
) {
  const bytes = await readRequestBody(request, maxBytes);
  if (!validate(bytes)) throw new ProfileImageInvalidError();

  const finalPath = profileImagePath(storageKey);
  const temporaryPath = `${finalPath}.${crypto.randomUUID()}.upload`;
  await mkdir(config.profileImagesDirectory, { recursive: true });
  await Bun.write(temporaryPath, bytes);
  await rename(temporaryPath, finalPath);
  return { size: bytes.byteLength };
}

export async function encryptedAttachmentExists(storageKey: string) {
  return Bun.file(attachmentPath(storageKey)).exists();
}

export async function removeEncryptedAttachment(storageKey: string) {
  await unlink(attachmentPath(storageKey)).catch(() => undefined);
}

export async function removeProfileImage(storageKey: string) {
  await unlink(profileImagePath(storageKey)).catch(() => undefined);
}
