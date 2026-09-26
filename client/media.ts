const mimeToExtensions: Record<string, string[]> = {
  "image/avif": ["avif"],
  "image/gif": ["gif"],
  "image/heic": ["heic"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "video/mp4": ["mp4"],
  "video/webm": ["webm"],
  "video/ogg": ["ogv", "ogg"],
  "video/quicktime": ["mov"],
};

function extensionFor(file: File) {
  const fromName = file.name.toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1];
  const mapped = mimeToExtensions[file.type.toLowerCase()];
  if (fromName && (!mapped || mapped.includes(fromName))) return fromName;
  return mapped?.[0] ?? "bin";
}

function canvasBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
}

export type CompressedPhoto = {
  blob: Blob;
  extension: string;
  mimeType: string;
  width: number;
  height: number;
  name: string;
};

export type PreparedMedia = CompressedPhoto;

export async function prepareMedia(file: File): Promise<PreparedMedia> {
  const mimeType = file.type.toLowerCase() || "application/octet-stream";
  if (mimeType.startsWith("video/")) {
    const extension = extensionFor(file);
    return { blob: file, extension, mimeType, width: 0, height: 0, name: file.name };
  }
  if (!mimeToExtensions[mimeType]) {
    return { blob: file, extension: extensionFor(file), mimeType, width: 0, height: 0, name: file.name };
  }
  return compressPhoto(file);
}

/**
 * Resize and recompress a browser-supported still image before it is encrypted.
 * Unsupported/animated formats are returned unchanged rather than decoded by a
 * server, preserving the E2EE boundary and the original extension/MIME pair.
 */
export async function compressPhoto(file: File, maxDimension = 2048, quality = 0.82): Promise<CompressedPhoto> {
  const mimeType = file.type.toLowerCase();
  const extension = extensionFor(file);
  if (!extension || !mimeToExtensions[mimeType]) throw new Error("unsupported_image_type");

  if (mimeType === "image/gif" || mimeType === "image/heic" || mimeType === "image/avif") {
    return { blob: file, extension, mimeType, width: 0, height: 0, name: file.name };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { blob: file, extension, mimeType, width: 0, height: 0, name: file.name };
  }

  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return { blob: file, extension, mimeType, width: bitmap.width, height: bitmap.height, name: file.name };

    context.drawImage(bitmap, 0, 0, width, height);
    const compressed = await canvasBlob(canvas, mimeType, quality);
    if (!compressed || compressed.type.toLowerCase() !== mimeType) {
      return { blob: file, extension, mimeType, width: bitmap.width, height: bitmap.height, name: file.name };
    }

    return { blob: compressed, extension, mimeType, width, height, name: file.name };
  } finally {
    bitmap.close();
  }
}
