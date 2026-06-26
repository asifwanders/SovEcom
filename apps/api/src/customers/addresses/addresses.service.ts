/**
 * AddressesService (self-scoped CRUD, no IDOR).
 *
 * Every method takes the AUTHENTICATED customer's (tenantId, customerId) from the
 * guard-set principal — never a path/body id — so customer A can never touch
 * customer B's address. A not-owned id surfaces as a 404.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { AddressesRepository } from './addresses.repository';
import { toAddressView, type AddressView } from '../customer.serializer';
import type { CreateAddressDto, UpdateAddressDto } from '../dto/address.dto';

@Injectable()
export class AddressesService {
  constructor(private readonly repo: AddressesRepository) {}

  async list(tenantId: string, customerId: string): Promise<AddressView[]> {
    const rows = await this.repo.listForCustomer(tenantId, customerId);
    return rows.map(toAddressView);
  }

  async create(tenantId: string, customerId: string, dto: CreateAddressDto): Promise<AddressView> {
    const row = await this.repo.insert({
      tenantId,
      customerId,
      type: dto.type,
      isDefault: dto.isDefault,
      name: dto.name,
      company: dto.company ?? null,
      line1: dto.line1,
      line2: dto.line2 ?? null,
      city: dto.city,
      postalCode: dto.postalCode,
      region: dto.region ?? null,
      country: dto.country,
      phone: dto.phone ?? null,
    });
    return toAddressView(row);
  }

  async update(
    tenantId: string,
    customerId: string,
    id: string,
    dto: UpdateAddressDto,
  ): Promise<AddressView> {
    const row = await this.repo.update(tenantId, customerId, id, { ...dto });
    if (!row) {
      throw new NotFoundException();
    }
    return toAddressView(row);
  }

  async remove(tenantId: string, customerId: string, id: string): Promise<void> {
    const ok = await this.repo.delete(tenantId, customerId, id);
    if (!ok) {
      throw new NotFoundException();
    }
  }
}
