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

export function attachmentPath(storageKey: string) {
  if (!/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i.test(storageKey)) {
    throw new Error("invalid attachment storage key");
  }
  return join(config.attachmentsDirectory, storageKey);
}

async function readRequestBody(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > config.maxAttachmentBytes) {
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
      if (total > config.maxAttachmentBytes) {
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
  const bytes = await readRequestBody(request);
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

export async function encryptedAttachmentExists(storageKey: string) {
  return Bun.file(attachmentPath(storageKey)).exists();
}

export async function removeEncryptedAttachment(storageKey: string) {
  await unlink(attachmentPath(storageKey)).catch(() => undefined);
}
