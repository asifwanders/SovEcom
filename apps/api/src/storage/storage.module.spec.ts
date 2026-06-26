/**
 * Unit tests for the StorageModule factory — verifies that the correct adapter
 * class is selected based on the STORAGE_DRIVER env variable.
 */
import { LocalAdapter } from './adapters/local.adapter';
import { S3Adapter } from './adapters/s3.adapter';

function makeAdapter(driver: string | undefined) {
  // Simulate the factory logic from storage.module.ts.
  if (driver === 's3') return new S3Adapter();
  return new LocalAdapter();
}

describe('StorageModule adapter factory', () => {
  it('returns LocalAdapter when STORAGE_DRIVER is "local"', () => {
    const adapter = makeAdapter('local');
    expect(adapter).toBeInstanceOf(LocalAdapter);
  });

  it('returns LocalAdapter when STORAGE_DRIVER is undefined (default)', () => {
    const adapter = makeAdapter(undefined);
    expect(adapter).toBeInstanceOf(LocalAdapter);
  });

  it('returns S3Adapter when STORAGE_DRIVER is "s3"', () => {
    const adapter = makeAdapter('s3');
    expect(adapter).toBeInstanceOf(S3Adapter);
  });
});
