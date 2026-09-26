export class InvalidEncodingError extends Error {
  constructor(field: string) {
    super(`${field} must be valid base64url data`);
    this.name = "InvalidEncodingError";
  }
}

export function decodeBase64(value: string, field: string, maxBytes: number, allowEmpty = false) {
  if (value.length === 0) {
    if (allowEmpty) return Buffer.alloc(0);
    throw new InvalidEncodingError(field);
  }

  if (value.length > Math.ceil(maxBytes * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new InvalidEncodingError(field);
  }

  if (value.length % 4 === 1) throw new InvalidEncodingError(field);

  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const bytes = Buffer.from(padded, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");

  if (canonical !== standard.replace(/=+$/, "") || bytes.length > maxBytes) {
    throw new InvalidEncodingError(field);
  }

  return bytes;
}

export function encodeBase64(value: Uint8Array | Buffer) {
  return Buffer.from(value).toString("base64url");
}
