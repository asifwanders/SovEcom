/**
 * SharpProcessor.
 *
 * Generates 4 sizes × 3 formats (12 derivatives) from an input buffer plus a
 * re-encoded, EXIF-stripped original (13 objects total).
 *
 * Privacy: EXIF/GPS metadata is stripped from ALL outputs including the
 * original. We do NOT call `.withMetadata()` so Sharp drops all XMP/IPTC/EXIF
 * from the encoded output. `.rotate()` is called first so EXIF orientation is
 * baked into pixel data before the metadata is discarded.
 */
import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

/** Supported output sizes (resize by WIDTH, fit:'inside', withoutEnlargement). */
export const IMAGE_SIZES = {
  large: 1920,
  medium: 800,
  small: 400,
  thumbnail: 150,
} as const;

export type Size = keyof typeof IMAGE_SIZES;
export type Format = 'avif' | 'webp' | 'jpeg';

export const FORMATS: readonly Format[] = ['avif', 'webp', 'jpeg'];

/**
 * Application megapixel cap for product images (decompression / pixel-bomb DoS guard).
 * sharp's default `limitInputPixels` is ~268MP — far larger than any real product photo
 * and large enough that a tiny crafted file can force a multi-GB decode. 50 MP (e.g.
 * ~8660×5773) comfortably covers high-res product photography while bounding the decode.
 */
export const MAX_MEGAPIXELS = 50;
export const MAX_PIXELS = MAX_MEGAPIXELS * 1_000_000;

export interface ProcessedVariant {
  avif: Buffer;
  webp: Buffer;
  jpeg: Buffer;
}

export interface ProcessResult {
  meta: {
    format: string;
    width: number;
    height: number;
  };
  /** Re-encoded original (EXIF-stripped, auto-oriented). */
  original: Buffer;
  variants: Record<Size, ProcessedVariant>;
}

@Injectable()
export class SharpProcessor {
  /**
   * Generate all variants from `input`.
   *
   * 1. Probe with sharp to validate the input is a supported raster image.
   * 2. Re-encode the original to its source format (strips EXIF/GPS).
   * 3. Resize to each of the 4 breakpoints and encode avif/webp/jpeg.
   */
  async generateVariants(input: Buffer): Promise<ProcessResult> {
    // Phase: probe + auto-orient base pipeline (EXIF orientation baked in,
    // metadata NOT forwarded so it's stripped in all outputs). `limitInputPixels`
    // bounds the DECODE itself (sharp throws past the cap) so a pixel-bomb cannot
    // force a multi-GB allocation even though ImagesService already pre-validated.
    const base = sharp(input, { limitInputPixels: MAX_PIXELS }).rotate(); // bake EXIF orientation

    const meta = await base.clone().metadata();
    const srcFormat = meta.format ?? 'jpeg';
    const srcWidth = meta.width ?? 0;
    const srcHeight = meta.height ?? 0;

    // Re-encode original without metadata (EXIF/GPS stripped).
    const original = await this._encodeOriginal(base.clone(), srcFormat);

    // Generate 4 size × 3 format variants.
    const variantEntries = await Promise.all(
      (Object.entries(IMAGE_SIZES) as [Size, number][]).map(async ([size, px]) => {
        const resized = base.clone().resize(px, undefined, {
          fit: 'inside',
          withoutEnlargement: true,
        });
        const [avif, webp, jpeg] = await Promise.all([
          resized.clone().avif().toBuffer(),
          resized.clone().webp().toBuffer(),
          resized.clone().jpeg().toBuffer(),
        ]);
        return [size, { avif, webp, jpeg }] as [Size, ProcessedVariant];
      }),
    );

    return {
      meta: { format: srcFormat, width: srcWidth, height: srcHeight },
      original,
      variants: Object.fromEntries(variantEntries) as Record<Size, ProcessedVariant>,
    };
  }

  /** Re-encode to the source format to strip EXIF. Falls back to jpeg on unknown formats. */
  private async _encodeOriginal(pipeline: sharp.Sharp, srcFormat: string): Promise<Buffer> {
    switch (srcFormat) {
      case 'png':
        return pipeline.png().toBuffer();
      case 'webp':
        return pipeline.webp().toBuffer();
      case 'avif':
        return pipeline.avif().toBuffer();
      default:
        return pipeline.jpeg().toBuffer();
    }
  }
}
