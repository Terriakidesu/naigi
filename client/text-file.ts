const textExtensions = new Set([
  "c", "cc", "conf", "cpp", "css", "csv", "diff", "env", "go", "h", "hpp", "html", "ini", "java",
  "js", "json", "jsx", "log", "md", "mdown", "markdown", "patch", "php", "py", "rb", "rs", "sh", "sql",
  "svg", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml",
]);

const textMimeTypes = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/markdown",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/xml",
  "application/x-httpd-php",
  "application/x-sh",
  "application/x-yaml",
  "text/css",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/markdown",
  "text/plain",
  "text/xml",
]);

export const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
export const INLINE_TEXT_PREVIEW_CHARACTERS = 1_200;

export function textPreviewExcerpt(text: string, maxCharacters = INLINE_TEXT_PREVIEW_CHARACTERS) {
  const limit = Math.max(1, Math.floor(maxCharacters));
  if (text.length <= limit) return { text, remainingCharacters: 0 };

  let end = text.lastIndexOf("\n", limit);
  if (end < limit * 0.55) {
    end = limit;
  } else {
    end += 1;
  }
  return {
    text: `${text.slice(0, end)}${text[end - 1] === "\n" ? "" : "\n"}…`,
    remainingCharacters: text.length - end,
  };
}

function extensionFor(filename: string) {
  return filename.toLowerCase().match(/\.([a-z0-9]{1,16})$/)?.[1] ?? "";
}

export function isPlaintextAttachment(filename: string, mimeType: string) {
  const normalizedMimeType = mimeType.toLowerCase().split(";", 1)[0];
  return normalizedMimeType.startsWith("text/") || textMimeTypes.has(normalizedMimeType) || textExtensions.has(extensionFor(filename));
}

export function textLanguage(filename: string, mimeType: string) {
  const extension = extensionFor(filename);
  if (extension) return extension;
  const normalizedMimeType = mimeType.toLowerCase().split(";", 1)[0];
  const mimeLanguages: Record<string, string> = {
    "application/ecmascript": "javascript",
    "application/javascript": "javascript",
    "application/json": "json",
    "application/ld+json": "json",
    "application/markdown": "markdown",
    "application/sql": "sql",
    "application/toml": "toml",
    "application/typescript": "typescript",
    "application/xml": "xml",
    "application/x-httpd-php": "php",
    "application/x-sh": "shell",
    "application/x-yaml": "yaml",
  };
  if (mimeLanguages[normalizedMimeType]) return mimeLanguages[normalizedMimeType];
  return normalizedMimeType.startsWith("text/") ? normalizedMimeType.slice(5) || "text" : "text";
}

export async function readTextPreview(blob: Blob, maxBytes = MAX_TEXT_PREVIEW_BYTES) {
  const bytes = new Uint8Array(await blob.slice(0, maxBytes + 1).arrayBuffer());
  const truncated = bytes.byteLength > maxBytes;
  const visible = truncated ? bytes.subarray(0, maxBytes) : bytes;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(visible);
  return {
    text: truncated ? `${text}\n\n[Preview truncated after ${Math.round(maxBytes / 1024)} KiB.]` : text,
    truncated,
  };
}
