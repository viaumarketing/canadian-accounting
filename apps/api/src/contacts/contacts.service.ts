import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@ca/database';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(companyId: string, kind?: 'CUSTOMER' | 'VENDOR') {
    return this.prisma.contact.findMany({
      where: { companyId, isActive: true, ...(kind ? { kind: { in: [kind, 'BOTH'] } } : {}) },
      orderBy: { name: 'asc' },
    });
  }

  async create(companyId: string, input: { kind: 'CUSTOMER' | 'VENDOR' | 'BOTH'; name: string; email?: string; province?: string; taxNumber?: string; billingAddress?: string; phone?: string; defaultTerms?: string }, actorId: string, ip: string | null) {
    const c = await this.prisma.contact.create({ data: { ...input, companyId } });
    await this.audit.record({ action: 'contact.created', companyId, actorId, entityType: 'Contact', entityId: c.id, ip });
    return c;
  }

  async update(companyId: string, id: string, input: { name?: string; email?: string | null; province?: string; taxNumber?: string; billingAddress?: string | null; phone?: string | null; defaultTerms?: string; isActive?: boolean }, actorId: string, ip: string | null) {
    await this.get(companyId, id);
    const c = await this.prisma.contact.update({ where: { id }, data: input });
    await this.audit.record({ action: 'contact.updated', companyId, actorId, entityType: 'Contact', entityId: id, metadata: input as Prisma.InputJsonObject, ip });
    return c;
  }

  async get(companyId: string, id: string) {
    const c = await this.prisma.contact.findFirst({ where: { id, companyId } });
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Contact not found' });
    return c;
  }
}
