/**
 * Unit tests — settings resolution + clamping.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSettings,
  DEFAULT_BATCH_SIZE,
  BATCH_HARD_CAP,
  DEFAULT_SUBJECT_TEMPLATE,
} from '../src/settings';

describe('resolveSettings', () => {
  it('falls back to safe defaults for undefined / garbage', () => {
    expect(resolveSettings(undefined)).toEqual({
      enabled: true,
      batchSize: DEFAULT_BATCH_SIZE,
      subjectTemplate: DEFAULT_SUBJECT_TEMPLATE,
    });
    expect(resolveSettings(42)).toMatchObject({ enabled: true, batchSize: DEFAULT_BATCH_SIZE });
    expect(resolveSettings(null)).toMatchObject({ batchSize: DEFAULT_BATCH_SIZE });
  });

  it('honors explicit valid values', () => {
    expect(
      resolveSettings({
        enabled: false,
        batchSize: 25,
        subjectTemplate: 'Now available: {product}',
      }),
    ).toEqual({
      enabled: false,
      batchSize: 25,
      subjectTemplate: 'Now available: {product}',
    });
  });

  it('clamps the batch to [1, HARD_CAP] and floors fractions', () => {
    expect(resolveSettings({ batchSize: 0 }).batchSize).toBe(1);
    expect(resolveSettings({ batchSize: -5 }).batchSize).toBe(1);
    expect(resolveSettings({ batchSize: 100_000 }).batchSize).toBe(BATCH_HARD_CAP);
    expect(resolveSettings({ batchSize: 12.9 }).batchSize).toBe(12);
  });

  it('ignores wrong-typed fields', () => {
    expect(resolveSettings({ enabled: 'yes', batchSize: 'lots', subjectTemplate: 99 })).toEqual({
      enabled: true,
      batchSize: DEFAULT_BATCH_SIZE,
      subjectTemplate: DEFAULT_SUBJECT_TEMPLATE,
    });
  });

  it('strips control chars from the subject template (header-injection guard)', () => {
    const out = resolveSettings({ subjectTemplate: 'Back\r\nBcc: evil@x.com {product}' });
    expect(out.subjectTemplate).not.toMatch(/[\r\n]/);
    expect(out.subjectTemplate).toContain('{product}');
  });

  it('bounds an over-long subject template and defaults a blank one', () => {
    const long = resolveSettings({ subjectTemplate: 'x'.repeat(500) });
    expect(long.subjectTemplate.length).toBeLessThanOrEqual(160);
    expect(resolveSettings({ subjectTemplate: '   ' }).subjectTemplate).toBe(
      DEFAULT_SUBJECT_TEMPLATE,
    );
  });
});
