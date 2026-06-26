/**
 * StorageController.
 *
 * `GET /uploads/*path`  — serve local files publicly (no auth required).
 *   - If `expires` + `sig` query params are present the signature is verified
 *     (reject expired or tampered URLs with 403).
 *   - Path traversal → 400 via assertSafeKey.
 *   - File not found → 404.
 *   - S3 driver → always 404 (S3 serves objects directly via its endpoint).
 */
import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Res,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { assertSafeKey } from './storage.key';
import { LocalAdapter } from './adapters/local.adapter';
import { StorageService, STORAGE_ADAPTER } from './storage.service';
import { resolveStorageSigningSecret } from './storage-signing-secret';

@ApiTags('Storage')
@Controller()
export class StorageController {
  private readonly isLocal: boolean;
  private readonly root: string;
  private readonly signingSecret: string;

  constructor(
    @Inject(STORAGE_ADAPTER) private readonly adapter: object,
    private readonly storageService: StorageService,
  ) {
    this.isLocal = adapter instanceof LocalAdapter;
    this.root = process.env['LOCAL_STORAGE_PATH'] ?? '/data/uploads';
    // validated once (production rejects unset/short/dev-default), mirroring JWT_SECRET.
    this.signingSecret = resolveStorageSigningSecret();
  }

  @Public()
  @Get('uploads/*path')
  @ApiOperation({ summary: 'Serve a publicly-stored asset (local driver only)' })
  serveFile(
    @Param('path') rawPath: string | string[],
    @Query('expires') expiresStr: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res() res: Response,
  ): void {
    // S3 driver: nothing to serve here — objects are accessed via S3/MinIO directly.
    if (!this.isLocal) {
      res.status(HttpStatus.NOT_FOUND).json({ message: 'Not found' });
      return;
    }

    // Express 5 wildcard params may be an array; normalise to a string.
    const rawStr = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath ?? '');
    // Normalise path (remove any leading slash).
    const key = rawStr.startsWith('/') ? rawStr.slice(1) : rawStr;

    // Path-traversal guard.
    try {
      assertSafeKey(key);
    } catch {
      throw new BadRequestException('Invalid storage path');
    }

    // Signature verification when query params are present.
    if (expiresStr !== undefined || sig !== undefined) {
      if (!expiresStr || !sig) {
        throw new ForbiddenException('Missing expires or sig parameter');
      }
      const expires = parseInt(expiresStr, 10);
      if (Number.isNaN(expires)) {
        throw new ForbiddenException('Invalid expires parameter');
      }
      const valid = LocalAdapter.verifySignature(key, expires, sig, this.signingSecret);
      if (!valid) {
        throw new ForbiddenException('Invalid or expired signature');
      }
    }

    const filePath = path.join(this.root, key);

    // Prevent any remaining traversal that bypassed the key check.
    if (
      !filePath.startsWith(path.resolve(this.root) + path.sep) &&
      filePath !== path.resolve(this.root)
    ) {
      throw new BadRequestException('Invalid storage path');
    }

    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('File not found');
    }

    // Derive a basic Content-Type from the extension.
    const ext = path.extname(key).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.json': 'application/json',
    };
    const contentType = mimeMap[ext] ?? 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    // Defense-in-depth: served upload assets must NEVER execute script in the app origin.
    // `Content-Disposition: attachment` forces a download instead of inline render, and
    // `Content-Security-Policy: sandbox` neutralises any script even if a viewer opens it
    // directly — so an SVG (or anything) that slips into storage cannot run as stored XSS
    // against the app origin. `X-Content-Type-Options: nosniff` stops MIME-sniffing turning
    // octet-stream bytes back into an executable type.
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Variant objects are immutable (keyed by imageId); cache indefinitely.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.status(HttpStatus.OK);
    fs.createReadStream(filePath).pipe(res as unknown as NodeJS.WritableStream);
  }
}
