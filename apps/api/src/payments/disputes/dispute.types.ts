/**
 * dispute domain type, derived from the pg enum.
 */
import type { disputeStatusEnum } from '../../database/schema/_enums';

export type DisputeStatus = (typeof disputeStatusEnum.enumValues)[number];
