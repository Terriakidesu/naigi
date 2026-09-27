declare module "gifenc" {
  export type GifPalette = number[][];

  export type GifFrameOptions = {
    palette?: GifPalette;
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    repeat?: number;
    dispose?: number;
  };

  export type GifEncoder = {
    writeFrame(index: Uint8Array, width: number, height: number, options?: GifFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  };

  export function GIFEncoder(options?: { initialCapacity?: number; auto?: boolean }): GifEncoder;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: string; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number },
  ): GifPalette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: GifPalette, format?: string): Uint8Array;
}
