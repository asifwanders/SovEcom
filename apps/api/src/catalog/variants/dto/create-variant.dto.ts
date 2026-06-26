/**
 * CreateVariantDto.
 */
import { createZodDto } from 'nestjs-zod';
import { VariantCreateSchema } from '../../products/dto/create-product.dto';

export class CreateVariantDto extends createZodDto(VariantCreateSchema) {}
