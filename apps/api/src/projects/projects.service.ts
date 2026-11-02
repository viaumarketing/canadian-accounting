import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import { roleHasPermission, type CompanyRole } from '@ca/shared';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { isoOf, toDate } from '../accounting/setup';
import { CLOSING_SOURCES } from '../accounting/ledger.service';

const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());

export interface ProjectInput { name: string; customerId: string; status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED'; description?: string; budget?: string; startDate?: string; endDate?: string }
export interface TimeInput { date: string; hours: string; customerId?: string; projectId?: string; itemId?: string; description?: string; billable: boolean; rate?: string; userId?: string }

/** Projects (jobs for a customer) and time tracking. Profitability is read from the ledger: every posted line tagged with the project. */
@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async checkCustomer(companyId: string, id: string) {
    const c = await this.prisma.contact.findFirst({ where: { id, companyId, isActive: true } });
    if (!c || c.kind === 'VENDOR') throw new BadRequestException({ code: 'INVALID_CONTACT', message: 'Pick an active customer' });
  }

  async save(companyId: string, id: string | null, i: ProjectInput, actorId: string, ip: string | null) {
    await this.checkCustomer(companyId, i.customerId);
    if (i.startDate && i.endDate && i.endDate < i.startDate) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'The end date is before the start date' });
    const data = { name: i.name, customerId: i.customerId, status: i.status, description: i.description ?? null, budget: i.budget ?? null, startDate: i.startDate ? toDate(i.startDate) : null, endDate: i.endDate ? toDate(i.endDate) : null };
    try {
      if (!id) {
        const p = await this.prisma.project.create({ data: { ...data, companyId } });
        await this.audit.record({ action: 'project.created', companyId, actorId, entityType: 'Project', entityId: p.id, ip });
        return p;
      }
      if (!(await this.prisma.project.findFirst({ where: { id, companyId } }))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Project not found' });
      const p = await this.prisma.project.update({ where: { id }, data });
      await this.audit.record({ action: 'project.updated', companyId, actorId, entityType: 'Project', entityId: id, ip });
      return p;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'DUPLICATE', message: 'A project with that name already exists' });
      throw e;
    }
  }

  list(companyId: string) {
    return this.prisma.project.findMany({ where: { companyId }, orderBy: [{ status: 'asc' }, { name: 'asc' }], include: { customer: { select: { name: true } } } });
  }

  /** Income, costs and profit per project from posted journal lines; hours from time entries. */
  async profitability(companyId: string, q: { from?: string; to?: string; projectId?: string } = {}) {
    const projects = await this.prisma.project.findMany({ where: { companyId, ...(q.projectId ? { id: q.projectId } : {}) }, include: { customer: { select: { name: true } } }, orderBy: { name: 'asc' } });
    const dateFilter = q.from || q.to ? { date: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {};
    const rows = await this.prisma.journalLine.groupBy({ by: ['projectId', 'accountId'], where: { companyId, projectId: { in: projects.map((p) => p.id) }, entry: { status: 'POSTED', sourceType: { notIn: [...CLOSING_SOURCES] }, ...dateFilter } }, _sum: { debit: true, credit: true } });
    const accts = new Map((await this.prisma.account.findMany({ where: { companyId, id: { in: [...new Set(rows.map((r) => r.accountId))] } }, select: { id: true, type: true } })).map((a) => [a.id, a.type]));
    const time = await this.prisma.timeEntry.groupBy({ by: ['projectId', 'billable'], where: { companyId, projectId: { in: projects.map((p) => p.id) }, ...dateFilter }, _sum: { hours: true } });
    const unbilled = await this.prisma.timeEntry.groupBy({ by: ['projectId'], where: { companyId, projectId: { in: projects.map((p) => p.id) }, billable: true, invoiceLineId: null }, _sum: { hours: true } });
    return projects.map((p) => {
      let income = D(0), costs = D(0);
      for (const r of rows.filter((x) => x.projectId === p.id)) {
        const t = accts.get(r.accountId);
        if (t === 'REVENUE') income = income.plus(D(r._sum.credit ?? 0)).minus(D(r._sum.debit ?? 0));
        else if (t === 'EXPENSE') costs = costs.plus(D(r._sum.debit ?? 0)).minus(D(r._sum.credit ?? 0));
      }
      const hours = (b: boolean) => D(time.find((t) => t.projectId === p.id && t.billable === b)?._sum.hours ?? 0);
      const profit = income.minus(costs);
      return {
        projectId: p.id, name: p.name, customer: p.customer.name, status: p.status, budget: p.budget?.toString() ?? null,
        income: income.toFixed(2), costs: costs.toFixed(2), profit: profit.toFixed(2), margin: income.isZero() ? null : profit.div(income).times(100).toFixed(1),
        hours: { billable: hours(true).toString(), nonBillable: hours(false).toString(), unbilled: D(unbilled.find((u) => u.projectId === p.id)?._sum.hours ?? 0).toString() },
        /** Labour cost is not included: the app does not run payroll, so it has no cost rate for time. */
        labourCostIncluded: false,
      };
    });
  }

  // ---------------------------------------------------------------- time

  private async timeRefs(companyId: string, i: TimeInput) {
    let customerId = i.customerId ?? null;
    if (i.projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: i.projectId, companyId } });
      if (!p) throw new BadRequestException({ code: 'INVALID_PROJECT', message: 'Unknown project' });
      if (customerId && customerId !== p.customerId) throw new BadRequestException({ code: 'INVALID_PROJECT', message: 'The project belongs to another customer' });
      customerId = p.customerId;
    }
    if (customerId) await this.checkCustomer(companyId, customerId);
    if (i.billable && !customerId) throw new BadRequestException({ code: 'INVALID_BILLABLE', message: 'Billable time needs a customer or project' });
    if (i.itemId && !(await this.prisma.item.findFirst({ where: { id: i.itemId, companyId, isActive: true } }))) throw new BadRequestException({ code: 'INVALID_ITEM', message: 'Unknown or inactive service' });
    return { date: toDate(i.date), hours: i.hours, customerId, projectId: i.projectId ?? null, itemId: i.itemId ?? null, description: i.description ?? null, billable: i.billable, rate: i.rate ?? null };
  }

  /** Anyone who may log time logs their own; logging or changing someone else's needs sales:approve. */
  private async owner(companyId: string, userId: string | undefined, actorId: string, role: CompanyRole) {
    const target = userId ?? actorId;
    if (target !== actorId) {
      if (!roleHasPermission(role, 'sales:approve')) throw new ForbiddenException({ code: 'FORBIDDEN', message: "Recording someone else's time needs sales:approve" });
      if (!(await this.prisma.companyMembership.findFirst({ where: { companyId, userId: target, status: 'ACTIVE' } }))) throw new BadRequestException({ code: 'INVALID_USER', message: 'That person is not a member of this company' });
    }
    return target;
  }

  async logTime(companyId: string, i: TimeInput, actorId: string, role: CompanyRole, ip: string | null) {
    const userId = await this.owner(companyId, i.userId, actorId, role);
    const t = await this.prisma.timeEntry.create({ data: { ...(await this.timeRefs(companyId, i)), companyId, userId } });
    await this.audit.record({ action: 'time.logged', companyId, actorId, entityType: 'TimeEntry', entityId: t.id, metadata: { hours: i.hours }, ip });
    return t;
  }

  async updateTime(companyId: string, id: string, i: TimeInput, actorId: string, role: CompanyRole, ip: string | null) {
    const cur = await this.prisma.timeEntry.findFirst({ where: { id, companyId } });
    if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Time entry not found' });
    await this.owner(companyId, cur.userId, actorId, role);
    if (cur.invoiceLineId) throw new ConflictException({ code: 'ALREADY_BILLED', message: 'This time is on an invoice; remove it from the invoice first' });
    const t = await this.prisma.timeEntry.update({ where: { id }, data: await this.timeRefs(companyId, i) });
    await this.audit.record({ action: 'time.updated', companyId, actorId, entityType: 'TimeEntry', entityId: id, ip });
    return t;
  }

  async deleteTime(companyId: string, id: string, actorId: string, role: CompanyRole, ip: string | null) {
    const cur = await this.prisma.timeEntry.findFirst({ where: { id, companyId } });
    if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Time entry not found' });
    await this.owner(companyId, cur.userId, actorId, role);
    if (cur.invoiceLineId) throw new ConflictException({ code: 'ALREADY_BILLED', message: 'This time is on an invoice; remove it from the invoice first' });
    await this.prisma.timeEntry.delete({ where: { id } });
    await this.audit.record({ action: 'time.deleted', companyId, actorId, entityType: 'TimeEntry', entityId: id, ip });
  }

  /** People who cannot approve time see only their own. */
  async listTime(companyId: string, q: { from?: string; to?: string; projectId?: string; userId?: string }, actorId: string, role: CompanyRole) {
    const mine = !roleHasPermission(role, 'sales:approve');
    const rows = await this.prisma.timeEntry.findMany({
      where: { companyId, ...(mine ? { userId: actorId } : q.userId ? { userId: q.userId } : {}), ...(q.projectId ? { projectId: q.projectId } : {}), ...(q.from || q.to ? { date: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}) },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 500, include: { user: { select: { name: true } }, project: { select: { name: true } } },
    });
    return rows.map((t) => ({ ...t, date: isoOf(t.date), billed: Boolean(t.invoiceLineId) }));
  }
}
