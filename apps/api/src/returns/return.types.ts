/**
 * return enums + the JSONB item shape, derived from the schema enums.
 */
import { returnStatusEnum, returnTypeEnum } from '../database/schema/_enums';

export type ReturnStatus = (typeof returnStatusEnum.enumValues)[number];
export type ReturnType = (typeof returnTypeEnum.enumValues)[number];

/** One requested return line — stored in `returns.items` (JSONB). */
export interface ReturnItem {
  orderItemId: string;
  quantity: number;
}
