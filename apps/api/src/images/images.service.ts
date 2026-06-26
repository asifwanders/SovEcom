/**
 * ImagesService.
 *
 * Handles image upload (validate → process → store → persist), findOne, remove.
 * Tenant-isolation: every query filters on tenant_id derived from the JWT principal.
 * EXIF/GPS is stripped in SharpProcessor — never stored on disk.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import sharp from 'sharp';
import { eq, and } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { images } from '../database/schema/images';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import {
  SharpProcessor,
  FORMATS,
  IMAGE_SIZES,
  MAX_PIXELS,
  Size,
} from './processors/sharp.processor';
import type { ImageResponseDto } from './dto/image-upload.dto';

/** Supported source MIME types (validated via sharp probe, NOT trusted mimetype). */
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);

/** Maximum upload size enforced in service (Multer also enforces at the HTTP layer). */
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Max persisted alt-text length. The HTTP boundary (ImageUploadQueryDto) already
 * trims + caps and rejects over-long with 400; this service-level normalize is defense-in-depth
 * so a non-HTTP caller can never push unbounded text into the unbounded `alt_text` column.
 */
const ALT_TEXT_MAX = 1000;

/** Trim + cap alt text; an empty/blank result becomes null. */
function normalizeAltText(altText: string | undefined): string | null {
  if (altText === undefined) return null;
  const trimmed = altText.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, ALT_TEXT_MAX);
}

/** MIME type for each output format. */
const FORMAT_MIME: Record<string, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly processor: SharpProcessor,
  ) {}

  // ── Upload ─────────────────────────────────────────────────────────────────

  async upload(
    user: AuthenticatedUser,
    file: { buffer: Buffer; mimetype: string; size: number; originalname: string },
    altText?: string,
  ): Promise<ImageResponseDto> {
    // 1. Size guard (belt-and-suspenders, Multer enforces too).
    if (file.size > MAX_SIZE) {
      throw new BadRequestException('File exceeds maximum upload size of 10 MB');
    }
    const normalizedAltText = normalizeAltText(altText);

    // 2. Genuine image validation via sharp probe — never trust mimetype. The probe is
    //    constructed with `limitInputPixels` (decompression/pixel-bomb DoS guard) and
    //    `failOn: 'warning'` so a malformed/truncated container is rejected, not coerced.
    let probedFormat: string;
    try {
      const meta = await sharp(file.buffer, {
        limitInputPixels: MAX_PIXELS,
        failOn: 'warning',
      }).metadata();
      if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
        throw new Error(`Unsupported format: ${meta.format ?? 'unknown'}`);
      }
      // metadata() reads the header WITHOUT decoding pixels, so a tiny file can declare
      // enormous dimensions. Reject on declared pixel count BEFORE any decode/variant work.
      if (!meta.width || !meta.height || meta.width * meta.height > MAX_PIXELS) {
        throw new Error(
          `Image dimensions exceed the allowed maximum (${meta.width ?? '?'}x${meta.height ?? '?'})`,
        );
      }
      probedFormat = meta.format;
    } catch {
      throw new BadRequestException('File is not a valid image (jpeg, png, webp, or avif)');
    }

    // 3. Generate variants (EXIF-stripped, auto-oriented).
    const imageId = uuidv7();
    this.logger.debug(`Processing image ${imageId} (${probedFormat}, ${file.size} bytes)`);
    const result = await this.processor.generateVariants(file.buffer);

    // 4. Upload original + 12 variants to storage.
    const originalExt = probedFormat === 'jpeg' ? 'jpg' : probedFormat;
    const tenantId = user.tenantId;

    await this.storage.upload(
      {
        tenantId,
        resourceType: 'images',
        resourceId: imageId,
        filename: `original.${originalExt}`,
      },
      result.original,
      FORMAT_MIME[probedFormat] ?? 'application/octet-stream',
    );

    const variantsMap: Record<string, Record<string, string>> = {};
    for (const size of Object.keys(IMAGE_SIZES) as Size[]) {
      variantsMap[size] = {};
      for (const fmt of FORMATS) {
        const filename = `${size}.${fmt}`;
        await this.storage.upload(
          { tenantId, resourceType: 'images', resourceId: imageId, filename },
          result.variants[size][fmt],
          FORMAT_MIME[fmt] ?? 'application/octet-stream',
        );
        const key = [tenantId, 'images', imageId, filename].join('/');
        variantsMap[size][fmt] = key;
      }
    }

    const originalKey = [tenantId, 'images', imageId, `original.${originalExt}`].join('/');

    // 5. Insert database row.
    await this.db.db.insert(images).values({
      id: imageId,
      tenantId,
      originalKey,
      format: result.meta.format,
      width: result.meta.width,
      height: result.meta.height,
      sizeBytes: file.size,
      variants: variantsMap,
      altText: normalizedAltText,
    });

    return this._toDto({
      id: imageId,
      tenantId,
      originalKey,
      format: result.meta.format,
      width: result.meta.width,
      height: result.meta.height,
      sizeBytes: file.size,
      variants: variantsMap,
      altText: normalizedAltText,
      createdAt: new Date(),
    });
  }

  // ── FindOne ────────────────────────────────────────────────────────────────

  async findOne(user: AuthenticatedUser, id: string): Promise<ImageResponseDto> {
    const rows = await this.db.db
      .select()
      .from(images)
      .where(and(eq(images.id, id), eq(images.tenantId, user.tenantId)))
      .limit(1);

    if (!rows[0]) {
      throw new NotFoundException(`Image ${id} not found`);
    }
    return this._toDto(rows[0]);
  }

  // ── Remove ─────────────────────────────────────────────────────────────────

  async remove(user: AuthenticatedUser, id: string): Promise<void> {
    const rows = await this.db.db
      .select()
      .from(images)
      .where(and(eq(images.id, id), eq(images.tenantId, user.tenantId)))
      .limit(1);

    if (!rows[0]) {
      throw new NotFoundException(`Image ${id} not found`);
    }

    const row = rows[0];
    const variantsMap = row.variants as Record<string, Record<string, string>>;

    // Delete all variant objects + original from storage (idempotent).
    const keys: string[] = [row.originalKey];
    for (const sizeVariants of Object.values(variantsMap)) {
      for (const key of Object.values(sizeVariants)) {
        keys.push(key);
      }
    }
    await Promise.all(keys.map((k) => this.storage.delete(k).catch(() => undefined)));

    // Delete database row.
    await this.db.db
      .delete(images)
      .where(and(eq(images.id, id), eq(images.tenantId, user.tenantId)));
  }

  // ── DTO mapping ────────────────────────────────────────────────────────────

  private _toDto(row: {
    id: string;
    tenantId: string;
    originalKey: string;
    format: string;
    width: number;
    height: number;
    sizeBytes: number;
    variants: unknown;
    altText: string | null;
    createdAt: Date;
  }): ImageResponseDto {
    const variantsMap = row.variants as Record<string, Record<string, string>>;

    const variantsDto: Record<string, Record<string, string>> = {};
    for (const size of Object.keys(IMAGE_SIZES) as Size[]) {
      variantsDto[size] = {};
      for (const fmt of FORMATS) {
        const key = variantsMap[size]?.[fmt];
        variantsDto[size][fmt] = key ? this.storage.getPublicUrl(key) : '';
      }
    }

    return {
      id: row.id,
      format: row.format,
      width: row.width,
      height: row.height,
      sizeBytes: row.sizeBytes,
      altText: row.altText,
      variants: variantsDto as unknown as import('./dto/image-upload.dto').ImageVariantsDto,
      originalUrl: this.storage.getPublicUrl(row.originalKey),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
