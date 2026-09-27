import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { decompressFrames, parseGIF, type ParsedFrame } from "gifuct-js";

export const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;
const GIF_MAX_FRAMES = 160;

export type CropRect = { x: number; y: number; size: number };
type RasterFrame = { data: Uint8ClampedArray; delay: number };

export function isAnimatedGifFile(file: File) {
  return file.type === "image/gif" || /\.gif$/i.test(file.name);
}

function imageDataFrom(data: Uint8ClampedArray, width: number, height: number) {
  const imageData = new ImageData(width, height);
  imageData.data.set(data);
  return imageData;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("profile_image_encode_failed")), type, quality);
  });
}

function outputName(file: File, type: string) {
  const base = file.name.replace(/\.[^/.]+$/, "") || "profile-image";
  const extension = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : type === "image/gif" ? "gif" : "png";
  return `${base}-cropped.${extension}`;
}

function gifFrameData(frame: ParsedFrame, context: CanvasRenderingContext2D, patch: HTMLCanvasElement) {
  patch.width = frame.dims.width;
  patch.height = frame.dims.height;
  const patchContext = patch.getContext("2d");
  if (!patchContext) throw new Error("profile_image_canvas_unavailable");
  patchContext.clearRect(0, 0, patch.width, patch.height);
  patchContext.putImageData(imageDataFrom(frame.patch, patch.width, patch.height), 0, 0);
  context.drawImage(patch, frame.dims.left, frame.dims.top);
}

async function decodeGif(file: File): Promise<{ width: number; height: number; frames: RasterFrame[] }> {
  const parsed = parseGIF(await file.arrayBuffer());
  const frames = decompressFrames(parsed, true);
  if (frames.length === 0 || frames.length > GIF_MAX_FRAMES) throw new Error("profile_image_animation_too_complex");

  const width = parsed.lsd.width;
  const height = parsed.lsd.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("profile_image_canvas_unavailable");
  context.clearRect(0, 0, width, height);
  const patch = document.createElement("canvas");
  const output: RasterFrame[] = [];
  let previous: { frame: ParsedFrame; restore: ImageData | null } | undefined;

  for (const frame of frames) {
    if (previous?.frame.disposalType === 2) {
      context.clearRect(previous.frame.dims.left, previous.frame.dims.top, previous.frame.dims.width, previous.frame.dims.height);
    } else if (previous?.frame.disposalType === 3 && previous.restore) {
      context.putImageData(previous.restore, 0, 0);
    }

    const restore = frame.disposalType === 3 ? context.getImageData(0, 0, width, height) : null;
    gifFrameData(frame, context, patch);
    output.push({
      data: context.getImageData(0, 0, width, height).data,
      delay: Math.max(20, frame.delay || 100),
    });
    previous = { frame, restore };
  }

  return { width, height, frames: output };
}

async function renderStatic(file: File, crop: CropRect, size: number, image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("profile_image_canvas_unavailable");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size);
  const type = file.type === "image/jpeg" ? "image/jpeg" : file.type === "image/webp" ? "image/webp" : "image/png";
  const blob = await canvasBlob(canvas, type, type === "image/jpeg" ? 0.9 : undefined);
  return new File([blob], outputName(file, type), { type });
}

async function renderGif(file: File, crop: CropRect, size: number) {
  const decoded = await decodeGif(file);
  const source = document.createElement("canvas");
  source.width = decoded.width;
  source.height = decoded.height;
  const sourceContext = source.getContext("2d", { willReadFrequently: true });
  const output = document.createElement("canvas");
  output.width = size;
  output.height = size;
  const outputContext = output.getContext("2d", { willReadFrequently: true });
  if (!sourceContext || !outputContext) throw new Error("profile_image_canvas_unavailable");

  const gif = GIFEncoder({ initialCapacity: Math.min(MAX_PROFILE_IMAGE_BYTES, file.size * 2) });
  for (let index = 0; index < decoded.frames.length; index += 1) {
    sourceContext.putImageData(imageDataFrom(decoded.frames[index].data, decoded.width, decoded.height), 0, 0);
    outputContext.clearRect(0, 0, size, size);
    outputContext.drawImage(source, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size);
    const data = outputContext.getImageData(0, 0, size, size).data;
    const palette = quantize(data, 256, { format: "rgba4444", oneBitAlpha: 128, clearAlpha: true });
    const indexed = applyPalette(data, palette, "rgba4444");
    const transparentIndex = palette.findIndex((color) => color.length > 3 && color[3] < 128);
    gif.writeFrame(indexed, size, size, {
      palette,
      delay: decoded.frames[index].delay,
      dispose: 1,
      transparent: transparentIndex >= 0,
      transparentIndex: transparentIndex >= 0 ? transparentIndex : 0,
      ...(index === 0 ? { repeat: 0 } : {}),
    });
  }
  gif.finish();
  const bytes = gif.bytes();
  const encoded = new Uint8Array(bytes.byteLength);
  encoded.set(bytes);
  return new File([encoded.buffer], outputName(file, "image/gif"), { type: "image/gif" });
}

export async function editProfileImage(file: File, image: HTMLImageElement, crop: CropRect, size: number) {
  const edited = isAnimatedGifFile(file)
    ? await renderGif(file, crop, size)
    : await renderStatic(file, crop, size, image);
  if (edited.size > MAX_PROFILE_IMAGE_BYTES) throw new Error("profile_image_too_large");
  return edited;
}
