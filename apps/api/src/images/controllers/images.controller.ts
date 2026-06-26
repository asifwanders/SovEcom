/**
 * ImagesController.
 * @Audit added to mutating routes (images service does not self-audit).
 *
 * Routes:
 *   POST   admin/v1/images          — upload (products:write)   [@Audit]
 *   GET    admin/v1/images/:id      — metadata (products:read)
 *   DELETE admin/v1/images/:id      — delete (products:write)   [@Audit]
 */
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Express } from 'express';
import { RequirePermission } from '../../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../authorization/permissions.constants';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { Audit } from '../../audit/decorators/audit.decorator';
import { ImagesService } from '../images.service';
import type { ImageResponseDto } from '../dto/image-upload.dto';
import { ImageUploadQueryDto } from '../dto/image-upload-query.dto';

@ApiTags('Images')
@Controller('admin/v1/images')
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  @Post()
  @Audit('image.uploaded')
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiOperation({
    summary: 'Upload and process an image (strips EXIF, generates 4 sizes × 3 formats)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        alt_text: { type: 'string' },
      },
      required: ['file'],
    },
  })
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
    // validate alt_text at the boundary (trim + max length); over-long → 400.
    @Query() query: ImageUploadQueryDto,
  ): Promise<ImageResponseDto> {
    if (!file) {
      throw new BadRequestException(
        'No file uploaded — include a "file" field in the multipart body',
      );
    }
    return this.images.upload(user, file, query.alt_text);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PRODUCTS_READ)
  @ApiOperation({ summary: 'Retrieve image metadata by ID' })
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ImageResponseDto> {
    return this.images.findOne(user, id);
  }

  @Delete(':id')
  @Audit('image.deleted')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Delete image and all its variants from storage' })
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.images.remove(user, id);
  }
}
