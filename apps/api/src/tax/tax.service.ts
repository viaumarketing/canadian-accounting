import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import { RateRow, TaxResult, activeRates, calculateTax, money } from '@ca/canadian-tax';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { isoOf, toDate } from '../accounting/setup';

type Db = Prisma.TransactionClient | PrismaService;

const toRows = (rates: { component: 'GST' | 'HST' | 'QST' | 'PST'; rate: Prisma.Decimal; recoverable: boolean; effectiveFrom: Date; effectiveTo: Date | null }[]): RateRow[] =>
  rates.map((r) => ({ component: r.component, rate: r.rate.toString(), recoverable: r.recoverable, effectiveFrom: isoOf(r.effectiveFrom), effectiveTo: r.effectiveTo ? isoOf(r.effectiveTo) : null }));

@Injectable()
export class TaxService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  listCodes(companyId: string) {
    return this.prisma.taxCode.findMany({ where: { companyId }, orderBy: { code: 'asc' }, include: { rates: { orderBy: [{ component: 'asc' }, { effectiveFrom: 'asc' }] } } });
  }

  async addRate(companyId: string, taxCodeId: string, input: { component: 'GST' | 'HST' | 'QST' | 'PST'; rate: string; recoverable: boolean; effectiveFrom: string; effectiveTo?: string | null; source?: string }, actorId: string, ip: string | null) {
    const code = await this.prisma.taxCode.findFirst({ where: { id: taxCodeId, companyId }, include: { rates: true } });
    if (!code) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tax code not found' });
    if (code.kind !== 'TAXABLE') throw new BadRequestException({ code: 'NOT_TAXABLE', message: 'Zero-rated and exempt codes carry no rates' });
    const from = input.effectiveFrom, to = input.effectiveTo ?? '9999-12-31';
    if (to < from) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'effectiveTo is before effectiveFrom' });
    const overlap = code.rates.some((r) => r.component === input.component && isoOf(r.effectiveFrom) <= to && (r.effectiveTo ? isoOf(r.effectiveTo) : '9999-12-31') >= from);
    if (overlap) throw new ConflictException({ code: 'OVERLAP', message: `A ${input.component} rate already covers part of that date range; end it first` });
    const r = await this.prisma.taxRate.create({ data: { companyId, taxCodeId, component: input.component, rate: input.rate, recoverable: input.recoverable, effectiveFrom: toDate(from), effectiveTo: input.effectiveTo ? toDate(input.effectiveTo) : null, source: input.source } });
    await this.audit.record({ action: 'tax_rate.created', companyId, actorId, entityType: 'TaxRate', entityId: r.id, metadata: { code: code.code, component: input.component, rate: input.rate, from }, ip });
    return r;
  }

  /** Close an open-ended rate (the normal way a rate change is entered: end the old row, add the new one). */
  async endRate(companyId: string, rateId: string, effectiveTo: string, actorId: string, ip: string | null) {
    const r = await this.prisma.taxRate.findFirst({ where: { id: rateId, companyId } });
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Rate not found' });
    if (effectiveTo < isoOf(r.effectiveFrom)) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'End date is before the rate starts' });
    const u = await this.prisma.taxRate.update({ where: { id: rateId }, data: { effectiveTo: toDate(effectiveTo) } });
    await this.audit.record({ action: 'tax_rate.ended', companyId, actorId, entityType: 'TaxRate', entityId: rateId, metadata: { effectiveTo }, ip });
    return u;
  }

  /**
   * Tax for a set of amounts as at `date`. Throws if a TAXABLE code has no rate in force that day:
   * silently charging 0% would be worse than refusing.
   */
  async compute(db: Db, companyId: string, date: string, inclusive: boolean, items: { amount: Decimal.Value; taxCodeId: string }[]): Promise<TaxResult[]> {
    const ids = [...new Set(items.map((i) => i.taxCodeId))];
    const codes = await db.taxCode.findMany({ where: { companyId, id: { in: ids } }, include: { rates: true } });
    if (codes.length !== ids.length) throw new BadRequestException({ code: 'INVALID_TAX_CODE', message: 'Unknown tax code' });
    const byId = new Map(codes.map((c) => [c.id, c]));
    return items.map((it) => {
      const c = byId.get(it.taxCodeId)!;
      if (!c.isActive) throw new BadRequestException({ code: 'INACTIVE_TAX_CODE', message: `Tax code ${c.code} is inactive` });
      const rates = c.kind === 'TAXABLE' ? activeRates(toRows(c.rates), date) : [];
      if (c.kind === 'TAXABLE' && rates.length === 0) throw new UnprocessableEntityException({ code: 'NO_RATE', message: `Tax code ${c.code} has no rate in force on ${date}` });
      return calculateTax({ amount: money(it.amount), inclusive, rates });
    });
  }
}
