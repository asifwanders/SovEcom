/**
 * Image response DTO.
 *
 * Returned by POST (upload), GET (findOne). Variant URLs are public URLs derived
 * from storage keys at read time — not stored — so CDN root changes are zero-cost.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VariantFormatDto {
  @ApiProperty({ description: 'AVIF public URL' })
  avif!: string;

  @ApiProperty({ description: 'WebP public URL' })
  webp!: string;

  @ApiProperty({ description: 'JPEG public URL' })
  jpeg!: string;
}

export class ImageVariantsDto {
  @ApiProperty({ type: VariantFormatDto })
  large!: VariantFormatDto;

  @ApiProperty({ type: VariantFormatDto })
  medium!: VariantFormatDto;

  @ApiProperty({ type: VariantFormatDto })
  small!: VariantFormatDto;

  @ApiProperty({ type: VariantFormatDto })
  thumbnail!: VariantFormatDto;
}

export class ImageResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Detected source format (jpeg | png | webp | avif)' })
  format!: string;

  @ApiProperty({ description: 'Source image width in pixels' })
  width!: number;

  @ApiProperty({ description: 'Source image height in pixels' })
  height!: number;

  @ApiProperty({ description: 'Original file size in bytes' })
  sizeBytes!: number;

  @ApiPropertyOptional({ description: 'Alt text (from multipart field or null)' })
  altText!: string | null;

  @ApiProperty({ type: ImageVariantsDto })
  variants!: ImageVariantsDto;

  @ApiProperty({ description: 'Public URL of the EXIF-stripped original' })
  originalUrl!: string;

  @ApiProperty({ description: 'ISO 8601 creation timestamp' })
  createdAt!: string;
}
