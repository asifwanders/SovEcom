/**
 * email domain types, derived from the pg enums so the union stays in
 * lockstep with the database.
 */
import type { emailTypeEnum, emailStatusEnum } from '../database/schema/_enums';

export type EmailType = (typeof emailTypeEnum.enumValues)[number];
export type EmailStatus = (typeof emailStatusEnum.enumValues)[number];
