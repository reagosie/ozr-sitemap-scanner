/**
 * pixelmatch 6.x ships no type declarations, and @types/pixelmatch describes
 * the v5 API. This mirrors the installed version's actual signature.
 */
declare module 'pixelmatch' {
  interface PixelmatchOptions {
    /** Per-pixel colour distance, 0-1. Lower is stricter. Default 0.1. */
    threshold?: number;
    /** Treat anti-aliased pixels as unchanged. */
    includeAA?: boolean;
    alpha?: number;
    aaColor?: [number, number, number];
    diffColor?: [number, number, number];
    diffColorAlt?: [number, number, number];
    diffMask?: boolean;
  }

  export default function pixelmatch(
    img1: Uint8Array | Uint8ClampedArray,
    img2: Uint8Array | Uint8ClampedArray,
    output: Uint8Array | Uint8ClampedArray | null,
    width: number,
    height: number,
    options?: PixelmatchOptions,
  ): number;
}
