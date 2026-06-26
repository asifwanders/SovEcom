import { keys } from './keys';

describe('redis key helpers', () => {
  it('builds a tenant-scoped cart key', () => {
    expect(keys.cart('t1', 's1')).toBe('sovecom:t:t1:cart:s1');
  });

  it('builds a tenant prefix', () => {
    expect(keys.tenant('t1')).toBe('sovecom:t:t1');
  });

  it('builds a tenant-scoped session key', () => {
    expect(keys.session('t1', 's1')).toBe('sovecom:t:t1:session:s1');
  });

  it('builds a tenant-scoped inventory reservation key', () => {
    expect(keys.inventoryReservation('t1', 'v9')).toBe('sovecom:t:t1:invres:v9');
  });

  it('builds a tenant-scoped cart dirty set key', () => {
    expect(keys.cartDirty('t1')).toBe('sovecom:t:t1:cart:dirty');
  });

  it('namespaces every key under sovecom and the tenant scope', () => {
    const all = [
      keys.cart('t', 's'),
      keys.session('t', 's'),
      keys.inventoryReservation('t', 'v'),
      keys.cartDirty('t'),
    ];
    for (const k of all) {
      expect(k.startsWith('sovecom:t:t:')).toBe(true);
    }
  });
});
