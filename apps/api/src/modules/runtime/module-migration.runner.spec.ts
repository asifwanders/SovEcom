/**
 * ModuleMigrationRunner.checksum unit tests.
 *
 * Pins the checksum is UNAMBIGUOUS across the up/down boundary (regression: the old
 * `${up} ${down}` concat collided at whitespace).
 */
import { checksum } from './module-migration.runner';

describe('ModuleMigrationRunner checksum', () => {
  it('does NOT collide across the up/down boundary at whitespace', () => {
    // Old concat `${up} ${down}` made both of these hash the string "A B C" → identical checksum.
    const a = checksum({ id: 'm', up: 'A', down: 'B C' });
    const b = checksum({ id: 'm', up: 'A B', down: 'C' });
    expect(a).not.toBe(b);
  });

  it('is stable for the same (up, down) pair', () => {
    expect(checksum({ id: 'm', up: 'CREATE TABLE x', down: 'DROP TABLE x' })).toBe(
      checksum({ id: 'm2', up: 'CREATE TABLE x', down: 'DROP TABLE x' }),
    );
  });

  it('distinguishes a missing down from an empty-string down', () => {
    expect(checksum({ id: 'm', up: 'A' })).not.toBe(checksum({ id: 'm', up: 'A', down: '' }));
  });
});
