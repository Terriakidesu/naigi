import { expect, test } from "bun:test";
import { decryptCustomEmojiImage } from "./custom-emoji-media";

test("custom emoji previews decrypt the uploaded envelope with its preserved metadata", async () => {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const clear = new Uint8Array([137, 80, 78, 71]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, clear));
  const envelope = new Uint8Array(12 + ciphertext.length);
  envelope.set(iv);
  envelope.set(ciphertext, 12);
  const metadata = { name: "old", key: Buffer.from(rawKey).toString("base64"), iv: Buffer.from(iv).toString("base64"), mimeType: "image/png" };
  const blob = await decryptCustomEmojiImage({ ...metadata, name: "renamed" }, envelope);
  expect(blob.type).toBe("image/png");
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(clear);
  await expect(decryptCustomEmojiImage({ ...metadata, mimeType: "image/svg+xml" }, envelope)).rejects.toThrow("invalid_emoji_image");
  envelope[envelope.length - 1] ^= 1;
  await expect(decryptCustomEmojiImage(metadata, envelope)).rejects.toThrow();
});
