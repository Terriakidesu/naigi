export async function decryptCustomEmojiImage(metadata: Record<string, unknown>, encrypted: Uint8Array) {
  const decode = (value: unknown) => {
    if (typeof value !== "string") throw new Error("invalid_emoji_key");
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  };
  const key = decode(metadata.key);
  const iv = decode(metadata.iv);
  const mimeType = metadata.mimeType;
  if (![16, 24, 32].includes(key.byteLength) || iv.byteLength !== 12
    || typeof mimeType !== "string" || !/^image\/(?:avif|gif|jpeg|png|webp)$/i.test(mimeType)
    || encrypted.byteLength < 28 || encrypted.byteLength > 10 * 1024 * 1024) throw new Error("invalid_emoji_image");
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, new Uint8Array(encrypted.subarray(12)));
  return new Blob([clear], { type: mimeType });
}
