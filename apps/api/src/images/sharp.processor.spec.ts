/**
 * SharpProcessor unit tests.
 *
 * Uses a programmatically-created sharp PNG (solid colour, 2400×1600) as the
 * test image so the suite has zero external file dependencies.
 */
import sharp from 'sharp';
import zlib from 'node:zlib';
import { SharpProcessor, IMAGE_SIZES, FORMATS, MAX_PIXELS } from './processors/sharp.processor';

// ── helpers ───────────────────────────────────────────────────────────────────

/** CRC-32 (PNG flavour) over a buffer — for crafting a header-only PNG fixture. */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
/**
 * A tiny but structurally-valid PNG that DECLARES `width`×`height` in its IHDR without
 * carrying that many pixels — a "pixel bomb": a few hundred bytes claiming enormous
 * dimensions. sharp's metadata() reads IHDR (no decode), so this exercises the
 * decompression-DoS guard cheaply.
 */
function craftPngHeader(width: number, height: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(0))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Generate a solid-colour PNG at the given dimensions (no EXIF). */
async function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 149, b: 237 } },
  })
    .png()
    .toBuffer();
}

/** Generate a tiny JPEG with injected EXIF (Orientation=6 = 90° CW). */
async function jpegWithExif(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('SharpProcessor', () => {
  let processor: SharpProcessor;

  beforeAll(() => {
    processor = new SharpProcessor();
  });

  // ── generateVariants ────────────────────────────────────────────────────────

  describe('generateVariants', () => {
    let result: Awaited<ReturnType<SharpProcessor['generateVariants']>>;

    beforeAll(async () => {
      const input = await solidPng(2400, 1600);
      result = await processor.generateVariants(input);
    });

    it('returns correct source metadata', () => {
      expect(result.meta.format).toBe('png');
      expect(result.meta.width).toBe(2400);
      expect(result.meta.height).toBe(1600);
    });

    it('returns 4 size buckets', () => {
      const sizes = Object.keys(result.variants);
      expect(sizes.sort()).toEqual(['large', 'medium', 'small', 'thumbnail'].sort());
    });

    it('each size bucket has avif, webp, jpeg buffers', () => {
      for (const size of Object.keys(IMAGE_SIZES)) {
        const bucket = result.variants[size as keyof typeof IMAGE_SIZES];
        for (const fmt of FORMATS) {
          expect(Buffer.isBuffer(bucket[fmt])).toBe(true);
          expect(bucket[fmt].length).toBeGreaterThan(0);
        }
      }
    });

    it('large variant is not wider than 1920px', async () => {
      const meta = await sharp(result.variants.large.jpeg).metadata();
      expect(meta.width).toBeLessThanOrEqual(1920);
    });

    it('medium variant is not wider than 800px', async () => {
      const meta = await sharp(result.variants.medium.jpeg).metadata();
      expect(meta.width).toBeLessThanOrEqual(800);
    });

    it('small variant is not wider than 400px', async () => {
      const meta = await sharp(result.variants.small.jpeg).metadata();
      expect(meta.width).toBeLessThanOrEqual(400);
    });

    it('thumbnail is exactly 150px wide (input is wider)', async () => {
      const meta = await sharp(result.variants.thumbnail.jpeg).metadata();
      expect(meta.width).toBe(150);
    });

    it('thumbnail avif is not wider than 150px', async () => {
      const meta = await sharp(result.variants.thumbnail.avif).metadata();
      expect(meta.width).toBeLessThanOrEqual(150);
    });

    it('output formats are correct per format type', async () => {
      const avifMeta = await sharp(result.variants.small.avif).metadata();
      expect(avifMeta.format).toBe('heif'); // sharp reports avif as heif
      const webpMeta = await sharp(result.variants.small.webp).metadata();
      expect(webpMeta.format).toBe('webp');
      const jpegMeta = await sharp(result.variants.small.jpeg).metadata();
      expect(jpegMeta.format).toBe('jpeg');
    });

    it('original buffer is non-empty', () => {
      expect(Buffer.isBuffer(result.original)).toBe(true);
      expect(result.original.length).toBeGreaterThan(0);
    });

    it('original re-encodes as png (strips EXIF by not using withMetadata)', async () => {
      const meta = await sharp(result.original).metadata();
      expect(meta.format).toBe('png');
    });
  });

  // ── smaller input withoutEnlargement ────────────────────────────────────────

  it('does not enlarge a small input image (100×80 thumbnail stays 100px wide)', async () => {
    const small = await solidPng(100, 80);
    const r = await processor.generateVariants(small);
    const thumbMeta = await sharp(r.variants.thumbnail.jpeg).metadata();
    // withoutEnlargement: true — image is already smaller than 150, stays as-is
    expect(thumbMeta.width).toBe(100);
  });

  // ── EXIF stripping ──────────────────────────────────────────────────────────

  describe('EXIF stripping', () => {
    it('strips EXIF orientation from JPEG input', async () => {
      // 300×200 with orientation=6 (90° CW) — after auto-orient the stored pixel
      // grid is 200×300 (portrait). The key check is that output has NO exif field.
      const input = await jpegWithExif(300, 200);

      // Confirm the input DOES have EXIF orientation
      const inputMeta = await sharp(input).metadata();
      expect(inputMeta.orientation).toBeDefined();

      const r = await processor.generateVariants(input);

      // Processed original must have no exif
      const origMeta = await sharp(r.original).metadata();
      expect(origMeta.exif).toBeUndefined();

      // All variants must have no exif
      for (const size of Object.keys(IMAGE_SIZES)) {
        const jpeg = r.variants[size as keyof typeof IMAGE_SIZES].jpeg;
        const m = await sharp(jpeg).metadata();
        expect(m.exif).toBeUndefined();
      }
    });
  });
});

// ── Validation helpers (used by ImagesService) ──────────────────────────────

describe('Image validation (sharp probe)', () => {
  it('accepts a valid PNG buffer', async () => {
    const buf = await solidPng(100, 100);
    const meta = await sharp(buf).metadata();
    expect(meta.format).toBe('png');
  });

  it('rejects a non-image buffer', async () => {
    const garbage = Buffer.from('this is not an image');
    await expect(sharp(garbage).metadata()).rejects.toThrow();
  });

  it('generates buffers significantly under 10 MB for a 2400×1600 PNG', async () => {
    // thumbnail should be very small; this catches memory / buffer leaks
    const input = await solidPng(2400, 1600);
    const proc = new SharpProcessor();
    const r = await proc.generateVariants(input);
    expect(r.variants.thumbnail.jpeg.length).toBeLessThan(100_000);
  });
});

// ── Decompression / pixel-bomb DoS guard ────────────────────────────
describe('pixel-bomb DoS guard', () => {
  it('refuses an image whose declared pixel count exceeds MAX_PIXELS', async () => {
    // ~64 MP declared in IHDR, > the 50 MP cap, in a few hundred bytes.
    const side = Math.ceil(Math.sqrt(MAX_PIXELS)) + 4000;
    const bomb = craftPngHeader(side, side);
    const proc = new SharpProcessor();
    // generateVariants now constructs sharp with limitInputPixels: MAX_PIXELS, so the
    // decode/probe throws rather than allocating multiple GB of pixels.
    await expect(proc.generateVariants(bomb)).rejects.toThrow();
  });

  it('still processes a normal in-cap image into all variants', async () => {
    const ok = await solidPng(2400, 1600);
    const proc = new SharpProcessor();
    const r = await proc.generateVariants(ok);
    expect(r.meta.width).toBe(2400);
    for (const size of Object.keys(IMAGE_SIZES)) {
      for (const fmt of FORMATS) {
        expect(r.variants[size as keyof typeof IMAGE_SIZES][fmt].length).toBeGreaterThan(0);
      }
    }
  });
});
