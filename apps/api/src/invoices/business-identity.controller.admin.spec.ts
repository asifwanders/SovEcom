/**
 * Business identity admin controller + DTO boundary tests. This data prints
 * on INVOICES, so the Zod schema (the validation boundary) is pinned directly here:
 * rejects a bad country, rejects a partial address, rejects markup chars; accepts a
 * valid identity. The controller test pins the split of one body into the two typed
 * settings seams (business_identity vs eu_vat_registration).
 */
import { BusinessIdentityAdminController } from './business-identity.controller.admin';
import { UpdateBusinessIdentitySchema } from './dto/business-identity.dto';
import type {
  TenantSettingsService,
  BusinessIdentity,
  EuVatRegistration,
} from '../taxes/tenant-settings.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';

const user = { tenantId: 't1' } as AuthenticatedUser;
const IDENTITY: BusinessIdentity = { name: 'Acme', siren: '123', address: null };
const VAT: EuVatRegistration = { originCountry: 'FR', vatNumber: 'FR123' };

function make() {
  const service = {
    getBusinessIdentity: jest.fn().mockResolvedValue(IDENTITY),
    getEuVatRegistration: jest.fn().mockResolvedValue(VAT),
    updateBusinessIdentity: jest.fn().mockResolvedValue(IDENTITY),
    updateEuVatRegistration: jest.fn().mockResolvedValue(VAT),
  } as unknown as TenantSettingsService;
  return { controller: new BusinessIdentityAdminController(service), service };
}

describe('UpdateBusinessIdentitySchema (validation boundary)', () => {
  it('accepts a valid identity and upper-cases the countries', () => {
    const parsed = UpdateBusinessIdentitySchema.parse({
      name: 'Acme SARL',
      siren: '123 456 789',
      address: { line1: '1 rue de Paris', city: 'Paris', postalCode: '75001', country: 'fr' },
      originCountry: 'fr',
      vatNumber: 'FR12345678901',
    });
    expect(parsed.address?.country).toBe('FR');
    expect(parsed.originCountry).toBe('FR');
  });

  it('REJECTS a bad country code (not 2 letters)', () => {
    expect(UpdateBusinessIdentitySchema.safeParse({ originCountry: 'FRA' }).success).toBe(false);
    expect(
      UpdateBusinessIdentitySchema.safeParse({
        address: { line1: 'a', city: 'b', country: 'FRANCE' },
      }).success,
    ).toBe(false);
  });

  it('REJECTS an address missing required line1/city', () => {
    expect(
      UpdateBusinessIdentitySchema.safeParse({ address: { country: 'FR', city: 'Paris' } }).success,
    ).toBe(false);
  });

  it('REJECTS markup-breaking characters in printable fields (they print on invoices)', () => {
    expect(UpdateBusinessIdentitySchema.safeParse({ name: 'Acme <script>' }).success).toBe(false);
    expect(UpdateBusinessIdentitySchema.safeParse({ siren: '12"34' }).success).toBe(false);
  });

  it('REJECTS unknown top-level keys (strict)', () => {
    expect(UpdateBusinessIdentitySchema.safeParse({ bogus: 1 }).success).toBe(false);
  });

  it('allows clearing fields with null', () => {
    expect(
      UpdateBusinessIdentitySchema.safeParse({ name: null, address: null, vatNumber: null })
        .success,
    ).toBe(true);
  });
});

describe('BusinessIdentityAdminController', () => {
  it('GET returns the combined identity + EU-VAT view', async () => {
    const { controller } = make();
    expect(await controller.get(user)).toEqual({ identity: IDENTITY, euVatRegistration: VAT });
  });

  it('PUT routes name/siren/address to updateBusinessIdentity and VAT fields to updateEuVatRegistration', async () => {
    const { controller, service } = make();
    await controller.update(user, {
      name: 'Acme SARL',
      address: {
        line1: '1 rue de Paris',
        city: 'Paris',
        postalCode: '75001',
        country: 'FR',
      },
      originCountry: 'FR',
      vatNumber: 'FR123',
    } as never);

    expect(service.updateBusinessIdentity).toHaveBeenCalledWith('t1', {
      name: 'Acme SARL',
      address: {
        name: null,
        company: null,
        line1: '1 rue de Paris',
        line2: null,
        city: 'Paris',
        postalCode: '75001',
        country: 'FR',
      },
    });
    expect(service.updateEuVatRegistration).toHaveBeenCalledWith('t1', {
      originCountry: 'FR',
      vatNumber: 'FR123',
    });
  });

  it('PUT touching only identity does not write the EU-VAT block (reads it instead)', async () => {
    const { controller, service } = make();
    await controller.update(user, { siren: '999' } as never);
    expect(service.updateBusinessIdentity).toHaveBeenCalledWith('t1', { siren: '999' });
    expect(service.updateEuVatRegistration).not.toHaveBeenCalled();
    expect(service.getEuVatRegistration).toHaveBeenCalledWith('t1');
  });

  it('PUT with an empty body writes nothing, reads both blocks', async () => {
    const { controller, service } = make();
    await controller.update(user, {} as never);
    expect(service.updateBusinessIdentity).not.toHaveBeenCalled();
    expect(service.updateEuVatRegistration).not.toHaveBeenCalled();
    expect(service.getBusinessIdentity).toHaveBeenCalledWith('t1');
    expect(service.getEuVatRegistration).toHaveBeenCalledWith('t1');
  });
});
