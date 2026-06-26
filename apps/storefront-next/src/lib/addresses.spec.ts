/**
 * unit tests for the address mutation helpers.
 *
 * Verifies that each helper calls client.request with the exact method, path, and body structure
 * the API expects (path id in `path` param, not embedded in the URL string; optional fields sent as
 * undefined when empty).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAddress, updateAddress, deleteAddress } from './addresses';
import type { SovEcomClient } from '@sovecom/client-js';
import type { SavedAddress } from './auth-context';

const ADDR: SavedAddress = {
  id: 'addr-1',
  type: 'shipping',
  isDefault: true,
  name: 'Ada Lovelace',
  company: null,
  line1: '123 Rue de la Paix',
  line2: null,
  city: 'Paris',
  postalCode: '75001',
  region: null,
  country: 'FR',
  phone: null,
};

let mockRequest: ReturnType<typeof vi.fn>;
let client: SovEcomClient;

beforeEach(() => {
  mockRequest = vi.fn();
  client = { request: mockRequest } as unknown as SovEcomClient;
});

describe('createAddress', () => {
  it('calls POST /store/v1/customers/me/addresses with the full body', async () => {
    mockRequest.mockResolvedValue(ADDR);
    const result = await createAddress(client, {
      type: 'shipping',
      isDefault: true,
      name: 'Ada Lovelace',
      line1: '123 Rue de la Paix',
      city: 'Paris',
      postalCode: '75001',
      country: 'FR',
    });
    expect(mockRequest).toHaveBeenCalledWith(
      'post',
      '/store/v1/customers/me/addresses',
      expect.objectContaining({
        body: expect.objectContaining({
          type: 'shipping',
          isDefault: true,
          name: 'Ada Lovelace',
          line1: '123 Rue de la Paix',
          city: 'Paris',
          postalCode: '75001',
          country: 'FR',
        }),
      }),
    );
    expect(result).toBe(ADDR);
  });

  it('omits optional fields when not provided (undefined, not "")', async () => {
    mockRequest.mockResolvedValue(ADDR);
    await createAddress(client, {
      type: 'billing',
      isDefault: false,
      name: 'Ada',
      line1: '1 Main St',
      city: 'Lyon',
      postalCode: '69001',
      country: 'FR',
      // company, line2, region, phone NOT passed
    });
    const [, , opts] = mockRequest.mock.calls[0] as [
      string,
      string,
      { body: Record<string, unknown> },
    ];
    expect(opts.body.company).toBeUndefined();
    expect(opts.body.line2).toBeUndefined();
    expect(opts.body.region).toBeUndefined();
    expect(opts.body.phone).toBeUndefined();
  });

  it('returns the server-assigned SavedAddress', async () => {
    mockRequest.mockResolvedValue({ ...ADDR, id: 'new-id' });
    const result = await createAddress(client, {
      type: 'shipping',
      isDefault: false,
      name: 'Test',
      line1: '1 St',
      city: 'Paris',
      postalCode: '75001',
      country: 'FR',
    });
    expect(result.id).toBe('new-id');
  });
});

describe('updateAddress', () => {
  it('calls PATCH /store/v1/customers/me/addresses/{id} with path id and body', async () => {
    mockRequest.mockResolvedValue({ ...ADDR, name: 'Updated Name' });
    const result = await updateAddress(client, 'addr-1', { name: 'Updated Name' });
    expect(mockRequest).toHaveBeenCalledWith(
      'patch',
      '/store/v1/customers/me/addresses/{id}',
      expect.objectContaining({
        path: { id: 'addr-1' },
        body: expect.objectContaining({ name: 'Updated Name' }),
      }),
    );
    expect(result.name).toBe('Updated Name');
  });

  it('passes partial body (only changed fields)', async () => {
    mockRequest.mockResolvedValue({ ...ADDR, isDefault: true });
    await updateAddress(client, 'addr-1', { isDefault: true });
    const [, , opts] = mockRequest.mock.calls[0] as [
      string,
      string,
      { path: { id: string }; body: Record<string, unknown> },
    ];
    expect(opts.path.id).toBe('addr-1');
    expect(opts.body).toEqual({ isDefault: true });
  });

  it('uses the path param id, not a URL-embedded id', async () => {
    mockRequest.mockResolvedValue(ADDR);
    await updateAddress(client, 'some-uuid', { city: 'Lyon' });
    const [method, path, opts] = mockRequest.mock.calls[0] as [
      string,
      string,
      { path: { id: string } },
    ];
    // The URL template must stay un-interpolated
    expect(path).toBe('/store/v1/customers/me/addresses/{id}');
    expect(method).toBe('patch');
    expect(opts.path.id).toBe('some-uuid');
  });
});

describe('deleteAddress', () => {
  it('calls DELETE /store/v1/customers/me/addresses/{id} with path id', async () => {
    mockRequest.mockResolvedValue(undefined);
    await deleteAddress(client, 'addr-42');
    expect(mockRequest).toHaveBeenCalledWith(
      'delete',
      '/store/v1/customers/me/addresses/{id}',
      expect.objectContaining({ path: { id: 'addr-42' } }),
    );
  });

  it('uses path param id, not URL-embedded', async () => {
    mockRequest.mockResolvedValue(undefined);
    await deleteAddress(client, 'xyz');
    const [method, path, opts] = mockRequest.mock.calls[0] as [
      string,
      string,
      { path: { id: string } },
    ];
    expect(method).toBe('delete');
    expect(path).toBe('/store/v1/customers/me/addresses/{id}');
    expect(opts.path.id).toBe('xyz');
  });

  it('returns void (undefined)', async () => {
    mockRequest.mockResolvedValue(undefined);
    const result = await deleteAddress(client, 'addr-1');
    expect(result).toBeUndefined();
  });
});
