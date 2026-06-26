/**
 * ImagesService unit tests.
 *
 * Regression coverage for the decompression / pixel-bomb DoS guard: the
 * upload probe must REJECT an image whose declared (header) dimensions exceed the
 * application megapixel cap BEFORE any decode or variant work, and must still let a
 * normal in-cap image through to processing.
 */
import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import zlib from 'node:zlib';
import { ImagesService } from './images.service';
import { MAX_PIXELS } from './processors/sharp.processor';
import type { AuthenticatedUser } from '../auth/authenticated-user';

// ── crafted pixel-bomb fixture (declares huge dimensions, carries no pixels) ──
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
function craftPngHeader(width: number, height: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(0))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A real, small, in-cap PNG. */
async function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

function makeService(processorSpy: { generateVariants: jest.Mock }): ImagesService {
  const db = { db: { insert: () => ({ values: async () => undefined }) } };
  const storage = {
    upload: jest.fn(async () => undefined),
    getPublicUrl: (k: string) => `https://cdn.test/${k}`,
  };
  return new ImagesService(db as never, storage as never, processorSpy as never);
}

const USER = { tenantId: 'tenant-1', id: 'u1', role: 'admin' } as unknown as AuthenticatedUser;

describe('ImagesService.upload — pixel-bomb DoS guard', () => {
  it('rejects an image whose declared dimensions exceed the cap (before any decode)', async () => {
    const side = Math.ceil(Math.sqrt(MAX_PIXELS)) + 4000; // ~64 MP declared > 50 MP cap
    const bomb = craftPngHeader(side, side);
    const processor = { generateVariants: jest.fn() };
    const svc = makeService(processor);

    await expect(
      svc.upload(USER, {
        buffer: bomb,
        mimetype: 'image/png',
        size: bomb.length,
        originalname: 'bomb.png',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The guard fires BEFORE variant generation — no decode work happened.
    expect(processor.generateVariants).not.toHaveBeenCalled();
  });

  it('accepts a normal in-cap image and proceeds to variant generation', async () => {
    const ok = await solidPng(800, 600);
    const processor = {
      generateVariants: jest.fn(async () => ({
        meta: { format: 'png', width: 800, height: 600 },
        original: Buffer.from('orig'),
        variants: Object.fromEntries(
          ['large', 'medium', 'small', 'thumbnail'].map((s) => [
            s,
            { avif: Buffer.from('a'), webp: Buffer.from('w'), jpeg: Buffer.from('j') },
          ]),
        ),
      })),
    };
    const svc = makeService(processor);

    const dto = await svc.upload(USER, {
      buffer: ok,
      mimetype: 'image/png',
      size: ok.length,
      originalname: 'ok.png',
    });
    expect(processor.generateVariants).toHaveBeenCalledTimes(1);
    expect(dto.width).toBe(800);
    expect(dto.height).toBe(600);
  });
});

describe('ImagesService.upload — alt_text bounding (defense-in-depth)', () => {
  function okProcessor(): { generateVariants: jest.Mock } {
    return {
      generateVariants: jest.fn(async () => ({
        meta: { format: 'png', width: 800, height: 600 },
        original: Buffer.from('orig'),
        variants: Object.fromEntries(
          ['large', 'medium', 'small', 'thumbnail'].map((s) => [
            s,
            { avif: Buffer.from('a'), webp: Buffer.from('w'), jpeg: Buffer.from('j') },
          ]),
        ),
      })),
    };
  }

  it('caps an oversized alt_text to 1000 chars before persisting', async () => {
    const ok = await solidPng(800, 600);
    const svc = makeService(okProcessor());

    const dto = await svc.upload(
      USER,
      { buffer: ok, mimetype: 'image/png', size: ok.length, originalname: 'ok.png' },
      'x'.repeat(5000),
    );
    expect(dto.altText).toHaveLength(1000);
  });

  it('trims a normal alt_text and persists it; blank becomes null', async () => {
    const ok = await solidPng(800, 600);

    const svc1 = makeService(okProcessor());
    const dto1 = await svc1.upload(
      USER,
      { buffer: ok, mimetype: 'image/png', size: ok.length, originalname: 'ok.png' },
      '  a tidy caption  ',
    );
    expect(dto1.altText).toBe('a tidy caption');

    const svc2 = makeService(okProcessor());
    const dto2 = await svc2.upload(
      USER,
      { buffer: ok, mimetype: 'image/png', size: ok.length, originalname: 'ok.png' },
      '   ',
    );
    expect(dto2.altText).toBeNull();
  });
});
