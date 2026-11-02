import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import {
  CompanyRole,
  CreateCompanyInput,
  InviteMemberInput,
  TaxRegistrationInput,
  UpdateCompanyInput,
  gstHstNumberSchema,
} from '@ca/shared';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { SaasService } from '../saas/saas.service';
import { hashPassword } from '../auth/password';
import { currentFiscalYear } from './fiscal-year';
import { seedAccounting } from '../accounting/setup';

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly saas: SaasService) {}

  /**
   * Platform provisioning. The owner is named explicitly; the acting super admin gets no
   * membership unless they name themselves. An owner without an account gets one, with a
   * temporary password and a forced change at first login.
   */
  async provision(input: CreateCompanyInput, actorId: string, ip: string | null) {
    const { ownerEmail, ownerName, ownerTemporaryPassword, ...data } = input;
    const fy = currentFiscalYear(new Date(), data.fiscalYearEndMonth, data.fiscalYearEndDay);
    const newOwnerHash = ownerTemporaryPassword ? await hashPassword(ownerTemporaryPassword) : null;
    return this.prisma.$transaction(async (tx) => {
      let owner = await tx.user.findUnique({ where: { email: ownerEmail } });
      let createdOwner = false;
      if (!owner) {
        if (!ownerName || !newOwnerHash) {
          throw new BadRequestException({
            code: 'OWNER_DETAILS_REQUIRED',
            message: 'No account exists for that email; provide ownerName and ownerTemporaryPassword',
          });
        }
        owner = await tx.user.create({
          data: { email: ownerEmail, name: ownerName, passwordHash: newOwnerHash, mustChangePassword: true },
        });
        createdOwner = true;
      } else if (!owner.isActive) {
        throw new BadRequestException({ code: 'OWNER_INACTIVE', message: 'Owner account is deactivated' });
      }
      const company = await tx.company.create({
        data: {
          ...data,
          memberships: { create: { userId: owner.id, role: 'OWNER' } },
          fiscalYears: { create: fy },
        },
      });
      await seedAccounting(tx, company.id);
      await this.audit.record(
        { action: 'company.provisioned', companyId: company.id, actorId, entityType: 'Company', entityId: company.id, metadata: { ownerId: owner.id, createdOwner }, ip },
        tx,
      );
      return company;
    });
  }

  /** Platform-level list: metadata and counts only, never financial data. */
  listAll() {
    return this.prisma.company.findMany({
      orderBy: { legalName: 'asc' },
      select: {
        id: true, legalName: true, province: true, isActive: true, createdAt: true,
        _count: { select: { memberships: true } },
      },
    });
  }

  async get(companyId: string) {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { fiscalYears: { orderBy: { startDate: 'desc' } } },
    });
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found' });
    return c;
  }

  async update(companyId: string, input: UpdateCompanyInput, actorId: string, ip: string | null) {
    const before = await this.get(companyId);
    const company = await this.prisma.company.update({ where: { id: companyId }, data: input });
    await this.audit.record({
      action: 'company.updated', companyId, actorId, entityType: 'Company', entityId: companyId,
      metadata: { before: { legalName: before.legalName, province: before.province }, changes: input as Prisma.InputJsonObject }, ip,
    });
    return company;
  }

  /** Counts plus ledger-derived figures. Financials are null until something is posted; nothing is estimated. */
  async dashboard(companyId: string) {
    const [company, members, registrations, auditCount, posted] = await Promise.all([
      this.get(companyId),
      this.prisma.companyMembership.count({ where: { companyId, status: 'ACTIVE' } }),
      this.prisma.taxRegistration.count({ where: { companyId } }),
      this.prisma.auditEvent.count({ where: { companyId } }),
      this.prisma.journalEntry.count({ where: { companyId, status: 'POSTED' } }),
    ]);
    const today = new Date();
    const fiscalYear = company.fiscalYears.find((f) => f.startDate <= today && f.endDate >= today) ?? null;

    let financials: Record<string, string> | null = null;
    if (posted > 0) {
      type Row = { key: string; d: string; c: string };
      const ytd = fiscalYear
        ? await this.prisma.$queryRaw<Row[]>`
            SELECT a."type"::text AS key, COALESCE(SUM(l."debit"),0)::text AS d, COALESCE(SUM(l."credit"),0)::text AS c
            FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
            WHERE l."companyId" = ${companyId}::uuid AND e."status" = 'POSTED' AND e."date" BETWEEN ${fiscalYear.startDate} AND ${fiscalYear.endDate}
              AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')
            GROUP BY a."type"`
        : [];
      const roles = await this.prisma.$queryRaw<Row[]>`
        SELECT a."role"::text AS key, COALESCE(SUM(l."debit"),0)::text AS d, COALESCE(SUM(l."credit"),0)::text AS c
        FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
        WHERE l."companyId" = ${companyId}::uuid AND e."status" = 'POSTED' AND a."role" IS NOT NULL
        GROUP BY a."role"`;
      const net = (rows: Row[], key: string) => { const r = rows.find((x) => x.key === key); return new Decimal(r?.d ?? 0).minus(r?.c ?? 0); };
      const revenue = net(ytd, 'REVENUE').neg();
      const expenses = net(ytd, 'EXPENSE');
      const taxPayable = ['GST_HST_PAYABLE', 'QST_PAYABLE', 'PST_PAYABLE'].reduce((s, k) => s.minus(net(roles, k)), new Decimal(0))
        .minus(net(roles, 'GST_HST_RECEIVABLE')).minus(net(roles, 'QST_RECEIVABLE'));
      financials = {
        revenue: revenue.toFixed(2),
        expenses: expenses.toFixed(2),
        netIncome: revenue.minus(expenses).toFixed(2),
        accountsReceivable: net(roles, 'ACCOUNTS_RECEIVABLE').toFixed(2),
        accountsPayable: net(roles, 'ACCOUNTS_PAYABLE').neg().toFixed(2),
        salesTaxPayable: taxPayable.toFixed(2),
      };
    }
    return {
      company: { id: company.id, legalName: company.legalName, province: company.province, baseCurrency: company.baseCurrency },
      fiscalYear,
      counts: { activeMembers: members, taxRegistrations: registrations, auditEvents: auditCount },
      financials,
      setup: { hasTaxRegistration: registrations > 0, hasBusinessNumber: Boolean(company.businessNumber), hasLedger: posted > 0 },
    };
  }

  // ---- members ----

  listMembers(companyId: string) {
    return this.prisma.companyMembership.findMany({
      where: { companyId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, role: true, status: true, createdAt: true,
        user: { select: { id: true, email: true, name: true, mfaEnabled: true, lastLoginAt: true } },
      },
    });
  }

  private assertCanGrant(actorRole: CompanyRole, target: CompanyRole) {
    if (target === 'OWNER' && actorRole !== 'OWNER') {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Only an owner can grant the owner role' });
    }
  }

  async invite(companyId: string, actorId: string, actorRole: CompanyRole, input: InviteMemberInput, ip: string | null) {
    this.assertCanGrant(actorRole, input.role);
    return this.prisma.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email: input.email } });
      let created = false;
      if (!user) {
        user = await tx.user.create({
          data: {
            email: input.email,
            name: input.name,
            passwordHash: await hashPassword(input.temporaryPassword),
            mustChangePassword: true,
          },
        });
        created = true;
      }
      const existing = await tx.companyMembership.findUnique({
        where: { companyId_userId: { companyId, userId: user.id } },
      });
      if (existing) throw new ConflictException({ code: 'ALREADY_MEMBER', message: 'User is already a member' });
      await this.saas.assertSeat(tx, companyId, user.id);
      const m = await tx.companyMembership.create({ data: { companyId, userId: user.id, role: input.role } });
      await this.audit.record(
        { action: 'member.added', companyId, actorId, entityType: 'CompanyMembership', entityId: m.id, metadata: { userId: user.id, role: input.role, newUser: created }, ip },
        tx,
      );
      return { membershipId: m.id, userId: user.id, newUser: created };
    });
  }

  private async ownerCount(companyId: string, tx: Prisma.TransactionClient, excludeMembershipId?: string) {
    return tx.companyMembership.count({
      where: { companyId, role: 'OWNER', status: 'ACTIVE', ...(excludeMembershipId ? { id: { not: excludeMembershipId } } : {}) },
    });
  }

  async changeRole(companyId: string, membershipId: string, role: CompanyRole, actorId: string, actorRole: CompanyRole, ip: string | null) {
    this.assertCanGrant(actorRole, role);
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.companyMembership.findFirst({ where: { id: membershipId, companyId } });
      if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Member not found' });
      if (m.userId === actorId) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You cannot change your own role' });
      if (m.role === 'OWNER' && actorRole !== 'OWNER') {
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Only an owner can change an owner' });
      }
      if (m.role === 'OWNER' && role !== 'OWNER' && (await this.ownerCount(companyId, tx, m.id)) === 0) {
        throw new ConflictException({ code: 'LAST_OWNER', message: 'A company must keep at least one owner' });
      }
      const updated = await tx.companyMembership.update({ where: { id: m.id }, data: { role } });
      await this.audit.record(
        { action: 'member.role_changed', companyId, actorId, entityType: 'CompanyMembership', entityId: m.id, metadata: { from: m.role, to: role }, ip },
        tx,
      );
      return updated;
    });
  }

  async suspend(companyId: string, membershipId: string, actorId: string, actorRole: CompanyRole, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.companyMembership.findFirst({ where: { id: membershipId, companyId } });
      if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Member not found' });
      if (m.userId === actorId) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You cannot suspend yourself' });
      if (m.role === 'OWNER' && actorRole !== 'OWNER') {
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Only an owner can suspend an owner' });
      }
      if (m.role === 'OWNER' && (await this.ownerCount(companyId, tx, m.id)) === 0) {
        throw new ConflictException({ code: 'LAST_OWNER', message: 'A company must keep at least one owner' });
      }
      await tx.companyMembership.update({ where: { id: m.id }, data: { status: 'SUSPENDED' } });
      await this.audit.record(
        { action: 'member.suspended', companyId, actorId, entityType: 'CompanyMembership', entityId: m.id, ip },
        tx,
      );
    });
  }

  // ---- tax registrations ----

  listTaxRegistrations(companyId: string) {
    return this.prisma.taxRegistration.findMany({ where: { companyId }, orderBy: [{ kind: 'asc' }, { effectiveFrom: 'desc' }] });
  }

  /** Elect (or stop) the GST/HST Quick Method on a registration and record the remittance rates per sales tax code. */
  async setQuickMethod(companyId: string, registrationId: string, input: { from: string | null; rates: Record<string, { rate: string; credit?: string }> }, actorId: string, ip: string | null) {
    const reg = await this.prisma.taxRegistration.findFirst({ where: { id: registrationId, companyId } });
    if (!reg) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Registration not found' });
    if (reg.kind !== 'GST_HST') throw new BadRequestException({ code: 'NOT_GST_HST', message: 'The Quick Method applies to GST/HST registrations only' });
    if (input.from && new Date(`${input.from}T00:00:00Z`) < reg.effectiveFrom) throw new BadRequestException({ code: 'BEFORE_REGISTRATION', message: 'The election cannot start before the registration does' });
    const codes = Object.keys(input.rates);
    if (codes.length) {
      const known = new Set((await this.prisma.taxCode.findMany({ where: { companyId, code: { in: codes } }, select: { code: true } })).map((c) => c.code));
      const unknown = codes.filter((c) => !known.has(c));
      if (unknown.length) throw new BadRequestException({ code: 'UNKNOWN_TAX_CODE', message: `Unknown tax code${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` });
    }
    const updated = await this.prisma.taxRegistration.update({ where: { id: registrationId }, data: { quickMethodFrom: input.from ? new Date(`${input.from}T00:00:00Z`) : null, quickMethodRates: input.from ? input.rates : Prisma.DbNull } });
    await this.audit.record({
      action: 'tax_registration.quick_method', companyId, actorId, entityType: 'TaxRegistration', entityId: registrationId,
      metadata: { from: input.from, rates: input.from ? input.rates : null, before: { from: reg.quickMethodFrom?.toISOString().slice(0, 10) ?? null, rates: reg.quickMethodRates ?? null } } as Prisma.InputJsonObject, ip,
    });
    return updated;
  }

  async addTaxRegistration(companyId: string, input: TaxRegistrationInput, actorId: string, ip: string | null) {
    if (input.kind === 'GST_HST') {
      const r = gstHstNumberSchema.safeParse(input.registrationNumber);
      if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues[0].message });
      input = { ...input, registrationNumber: r.data };
    }
    try {
      const reg = await this.prisma.taxRegistration.create({ data: { ...input, companyId } });
      await this.audit.record({
        action: 'tax_registration.created', companyId, actorId, entityType: 'TaxRegistration', entityId: reg.id,
        metadata: { kind: reg.kind }, ip,
      });
      return reg;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'DUPLICATE', message: 'A registration of this kind already starts on that date' });
      }
      throw e;
    }
  }

  // ---- audit log ----

  async listAudit(companyId: string, take = 50, cursor?: string) {
    const rows = await this.prisma.auditEvent.findMany({
      where: { companyId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(take, 200) + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { actor: { select: { name: true, email: true } } },
    });
    const limit = Math.min(take, 200);
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }
}
