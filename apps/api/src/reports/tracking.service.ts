import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { isoOf, toDate } from '../accounting/setup';
import { CLOSING_SOURCES } from '../accounting/ledger.service';

const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const DAY = 86_400_000;
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;

type Dim = 'class' | 'location';

/** Classes and locations, budgets, profit and loss by dimension, budget vs. actual, and the dashboard figures. */
@Injectable()
export class TrackingService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  // ---------------------------------------------------------------- classes and locations

  list(companyId: string, dim: Dim) {
    return dim === 'class' ? this.prisma.trackingClass.findMany({ where: { companyId }, orderBy: { name: 'asc' } }) : this.prisma.location.findMany({ where: { companyId }, orderBy: { name: 'asc' } });
  }

  async save(companyId: string, dim: Dim, id: string | null, i: { name: string; isActive?: boolean }, actorId: string, ip: string | null) {
    try {
      const data = { name: i.name, ...(i.isActive !== undefined ? { isActive: i.isActive } : {}) };
      let row;
      if (!id) row = dim === 'class' ? await this.prisma.trackingClass.create({ data: { ...data, companyId } }) : await this.prisma.location.create({ data: { ...data, companyId } });
      else {
        const n = dim === 'class' ? await this.prisma.trackingClass.updateMany({ where: { id, companyId }, data }) : await this.prisma.location.updateMany({ where: { id, companyId }, data });
        if (!n.count) throw new NotFoundException({ code: 'NOT_FOUND', message: `${dim === 'class' ? 'Class' : 'Location'} not found` });
        row = dim === 'class' ? await this.prisma.trackingClass.findUniqueOrThrow({ where: { id } }) : await this.prisma.location.findUniqueOrThrow({ where: { id } });
      }
      await this.audit.record({ action: `${dim}.${id ? 'updated' : 'created'}`, companyId, actorId, entityType: dim === 'class' ? 'TrackingClass' : 'Location', entityId: row.id, metadata: data, ip });
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'DUPLICATE', message: 'That name is already used' });
      throw e;
    }
  }

  // ---------------------------------------------------------------- P&L by class or location

  /** Income statement with one column per class (or location), plus "Not specified" and the total. */
  async profitAndLossBy(companyId: string, dim: Dim, from: string, to: string) {
    if (to < from) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'The end date is before the start date' });
    const key = dim === 'class' ? 'classId' : 'locationId';
    const rows = await this.prisma.journalLine.groupBy({
      by: [key, 'accountId'],
      where: { companyId, account: { type: { in: ['REVENUE', 'EXPENSE'] } }, entry: { status: 'POSTED', sourceType: { notIn: [...CLOSING_SOURCES] }, date: { gte: toDate(from), lte: toDate(to) } } },
      _sum: { debit: true, credit: true },
    });
    const dims = await this.list(companyId, dim);
    const accounts = await this.prisma.account.findMany({ where: { companyId, type: { in: ['REVENUE', 'EXPENSE'] } }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, type: true } });
    const columns = [...dims.map((d) => ({ id: d.id as string | null, name: d.name })), { id: null, name: 'Not specified' }];
    const val = new Map<string, Decimal>(); // `${accountId}|${dimId}` → natural amount
    for (const r of rows) {
      const a = accounts.find((x) => x.id === r.accountId)!;
      const n = a.type === 'REVENUE' ? D(r._sum.credit ?? 0).minus(D(r._sum.debit ?? 0)) : D(r._sum.debit ?? 0).minus(D(r._sum.credit ?? 0));
      const k = `${r.accountId}|${(r as Record<string, unknown>)[key] ?? ''}`;
      val.set(k, (val.get(k) ?? D(0)).plus(n));
    }
    const lines = accounts.map((a) => {
      const cells = columns.map((c) => val.get(`${a.id}|${c.id ?? ''}`) ?? D(0));
      return { accountId: a.id, code: a.code, name: a.name, type: a.type, values: cells.map((x) => x.toFixed(2)), total: cells.reduce((s, x) => s.plus(x), D(0)).toFixed(2) };
    }).filter((l) => l.values.some((v) => v !== '0.00'));
    const sum = (type: string, i: number) => lines.filter((l) => l.type === type).reduce((s, l) => s.plus(i < 0 ? l.total : l.values[i]), D(0));
    const income = columns.map((_, i) => sum('REVENUE', i)), expenses = columns.map((_, i) => sum('EXPENSE', i));
    return {
      dimension: dim, from, to, columns: columns.map((c) => ({ id: c.id, name: c.name })), lines,
      totals: { income: income.map((x) => x.toFixed(2)), expenses: expenses.map((x) => x.toFixed(2)), netIncome: income.map((x, i) => x.minus(expenses[i]).toFixed(2)) },
      grand: { income: sum('REVENUE', -1).toFixed(2), expenses: sum('EXPENSE', -1).toFixed(2), netIncome: sum('REVENUE', -1).minus(sum('EXPENSE', -1)).toFixed(2) },
    };
  }

  // ---------------------------------------------------------------- budgets

  async saveBudget(companyId: string, id: string | null, i: { name: string; fiscalYearId: string; lines: { accountId: string; month: string; amount: string }[] }, actorId: string, ip: string | null) {
    const fy = await this.prisma.fiscalYear.findFirst({ where: { id: i.fiscalYearId, companyId } });
    if (!fy) throw new BadRequestException({ code: 'INVALID_FISCAL_YEAR', message: 'Unknown fiscal year' });
    const accountIds = [...new Set(i.lines.map((l) => l.accountId))];
    if (accountIds.length && (await this.prisma.account.count({ where: { companyId, id: { in: accountIds }, type: { in: ['REVENUE', 'EXPENSE'] } } })) !== accountIds.length) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Budgets are set on income and expense accounts' });
    const first = monthStart(isoOf(fy.startDate)), last = monthStart(isoOf(fy.endDate));
    const seen = new Set<string>();
    for (const l of i.lines) {
      const m = `${l.month}-01`;
      if (m < first || m > last) throw new BadRequestException({ code: 'OUTSIDE_YEAR', message: `${l.month} is outside fiscal year ${fy.label}` });
      if (seen.has(`${l.accountId}|${m}`)) throw new BadRequestException({ code: 'DUPLICATE_LINE', message: `An account appears twice for ${l.month}` });
      seen.add(`${l.accountId}|${m}`);
    }
    return this.prisma.$transaction(async (tx) => {
      let b;
      try {
        b = id ? await tx.budget.update({ where: { id, companyId }, data: { name: i.name, fiscalYearId: fy.id } }) : await tx.budget.create({ data: { companyId, name: i.name, fiscalYearId: fy.id } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'DUPLICATE', message: 'A budget with that name already exists' });
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Budget not found' });
        throw e;
      }
      await tx.budgetLine.deleteMany({ where: { budgetId: b.id } });
      await tx.budgetLine.createMany({ data: i.lines.filter((l) => !D(l.amount).isZero()).map((l) => ({ budgetId: b.id, companyId, accountId: l.accountId, month: toDate(`${l.month}-01`), amount: l.amount })) });
      await this.audit.record({ action: `budget.${id ? 'updated' : 'created'}`, companyId, actorId, entityType: 'Budget', entityId: b.id, metadata: { lines: i.lines.length }, ip }, tx);
      return b;
    });
  }

  listBudgets(companyId: string) {
    return this.prisma.budget.findMany({ where: { companyId }, orderBy: { name: 'asc' }, include: { _count: { select: { lines: true } } } });
  }

  async getBudget(companyId: string, id: string) {
    const b = await this.prisma.budget.findFirst({ where: { id, companyId }, include: { lines: true } });
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Budget not found' });
    return { ...b, lines: b.lines.map((l) => ({ accountId: l.accountId, month: isoOf(l.month).slice(0, 7), amount: D(l.amount).toFixed(2) })) };
  }

  async deleteBudget(companyId: string, id: string, actorId: string, ip: string | null) {
    const n = await this.prisma.budget.deleteMany({ where: { id, companyId } });
    if (!n.count) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Budget not found' });
    await this.audit.record({ action: 'budget.deleted', companyId, actorId, entityType: 'Budget', entityId: id, ip });
  }

  /** Budget vs. actual per account per month of the budget's fiscal year (actuals exclude year-end closing entries). */
  async budgetVsActual(companyId: string, id: string) {
    const b = await this.prisma.budget.findFirst({ where: { id, companyId }, include: { lines: true } });
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Budget not found' });
    const fy = await this.prisma.fiscalYear.findUniqueOrThrow({ where: { id: b.fiscalYearId } });
    const months: string[] = [];
    for (let m = monthStart(isoOf(fy.startDate)); m <= isoOf(fy.endDate); ) { months.push(m.slice(0, 7)); const d = toDate(m); m = isoOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))); }
    const actual = await this.prisma.$queryRaw<{ accountId: string; month: string; debit: string; credit: string }[]>`
      SELECT l."accountId", to_char(e.date, 'YYYY-MM') AS month, SUM(l.debit)::text AS debit, SUM(l.credit)::text AS credit
      FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId" JOIN "Account" a ON a.id = l."accountId"
      WHERE l."companyId" = ${companyId}::uuid AND e.status = 'POSTED' AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')
        AND a.type IN ('REVENUE', 'EXPENSE') AND e.date BETWEEN ${fy.startDate} AND ${fy.endDate}
      GROUP BY l."accountId", month`;
    const accounts = await this.prisma.account.findMany({ where: { companyId, type: { in: ['REVENUE', 'EXPENSE'] } }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, type: true } });
    const ids = new Set([...b.lines.map((l) => l.accountId), ...actual.map((a) => a.accountId)]);
    const rows = accounts.filter((a) => ids.has(a.id)).map((a) => {
      const per = months.map((m) => {
        const bud = b.lines.filter((l) => l.accountId === a.id && isoOf(l.month).startsWith(m)).reduce((s, l) => s.plus(l.amount.toString()), D(0));
        const act = actual.filter((x) => x.accountId === a.id && x.month === m).reduce((s, x) => s.plus(a.type === 'REVENUE' ? D(x.credit).minus(x.debit) : D(x.debit).minus(x.credit)), D(0));
        return { month: m, budget: bud, actual: act };
      });
      const tb = per.reduce((s, p) => s.plus(p.budget), D(0)), ta = per.reduce((s, p) => s.plus(p.actual), D(0));
      return {
        accountId: a.id, code: a.code, name: a.name, type: a.type,
        months: per.map((p) => ({ month: p.month, budget: p.budget.toFixed(2), actual: p.actual.toFixed(2), variance: p.actual.minus(p.budget).toFixed(2) })),
        total: { budget: tb.toFixed(2), actual: ta.toFixed(2), variance: ta.minus(tb).toFixed(2), percent: tb.isZero() ? null : ta.div(tb).times(100).toFixed(1) },
      };
    });
    return { budget: { id: b.id, name: b.name, fiscalYear: fy.label }, months, rows };
  }

  // ---------------------------------------------------------------- dashboard

  /** Figures for the home dashboard: 12 months of income and expenses, A/R aging, bank balances and this year's profit. */
  async dashboard(companyId: string, today = isoOf(new Date())) {
    const end = toDate(today);
    const startMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
    const monthly = await this.prisma.$queryRaw<{ month: string; type: string; debit: string; credit: string }[]>`
      SELECT to_char(e.date, 'YYYY-MM') AS month, a.type::text AS type, SUM(l.debit)::text AS debit, SUM(l.credit)::text AS credit
      FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId" JOIN "Account" a ON a.id = l."accountId"
      WHERE l."companyId" = ${companyId}::uuid AND e.status = 'POSTED' AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')
        AND a.type IN ('REVENUE', 'EXPENSE') AND e.date BETWEEN ${startMonth} AND ${end}
      GROUP BY month, a.type`;
    const months: { month: string; income: string; expenses: string; net: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const m = isoOf(new Date(Date.UTC(startMonth.getUTCFullYear(), startMonth.getUTCMonth() + i, 1))).slice(0, 7);
      const inc = monthly.filter((r) => r.month === m && r.type === 'REVENUE').reduce((s, r) => s.plus(D(r.credit).minus(r.debit)), D(0));
      const exp = monthly.filter((r) => r.month === m && r.type === 'EXPENSE').reduce((s, r) => s.plus(D(r.debit).minus(r.credit)), D(0));
      months.push({ month: m, income: inc.toFixed(2), expenses: exp.toFixed(2), net: inc.minus(exp).toFixed(2) });
    }

    const open = await this.prisma.invoice.findMany({ where: { companyId, kind: 'STANDARD', status: { in: ['POSTED', 'PARTIAL'] } }, select: { total: true, amountPaid: true, dueDate: true } });
    const aging = { current: D(0), d1_30: D(0), d31_60: D(0), d61_90: D(0), over90: D(0) };
    for (const i of open) {
      const bal = D(i.total).minus(i.amountPaid);
      const days = Math.round((end.getTime() - i.dueDate.getTime()) / DAY);
      const k = days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'over90';
      aging[k] = aging[k].plus(bal);
    }
    const openBills = await this.prisma.bill.findMany({ where: { companyId, kind: 'STANDARD', status: { in: ['POSTED', 'PARTIAL'] } }, select: { total: true, amountPaid: true, dueDate: true } });
    const payable = openBills.reduce((s, b) => s.plus(D(b.total).minus(b.amountPaid)), D(0));
    const overdueBills = openBills.filter((b) => b.dueDate < end).reduce((s, b) => s.plus(D(b.total).minus(b.amountPaid)), D(0));

    const banks = await this.prisma.bankAccount.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true, kind: true, ledgerAccountId: true } });
    const holding = await this.prisma.account.findMany({ where: { companyId, special: { not: null } }, select: { id: true, name: true } });
    const ids = [...banks.map((b) => b.ledgerAccountId), ...holding.map((h) => h.id)];
    const bal = ids.length ? await this.prisma.journalLine.groupBy({ by: ['accountId'], where: { companyId, accountId: { in: ids }, entry: { status: 'POSTED', date: { lte: end } } }, _sum: { debit: true, credit: true } }) : [];
    const balOf = (id: string) => { const r = bal.find((x) => x.accountId === id); return D(r?._sum.debit ?? 0).minus(D(r?._sum.credit ?? 0)); };

    const fy = await this.prisma.fiscalYear.findFirst({ where: { companyId, startDate: { lte: end }, endDate: { gte: end } } });
    let ytd = null;
    if (fy) {
      const r = await this.prisma.$queryRaw<{ type: string; debit: string; credit: string }[]>`
        SELECT a.type::text AS type, COALESCE(SUM(l.debit), 0)::text AS debit, COALESCE(SUM(l.credit), 0)::text AS credit
        FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId" JOIN "Account" a ON a.id = l."accountId"
        WHERE l."companyId" = ${companyId}::uuid AND e.status = 'POSTED' AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')
          AND a.type IN ('REVENUE', 'EXPENSE') AND e.date BETWEEN ${fy.startDate} AND ${end}
        GROUP BY a.type`;
      const inc = r.filter((x) => x.type === 'REVENUE').reduce((s, x) => s.plus(D(x.credit).minus(x.debit)), D(0));
      const exp = r.filter((x) => x.type === 'EXPENSE').reduce((s, x) => s.plus(D(x.debit).minus(x.credit)), D(0));
      ytd = { fiscalYear: fy.label, from: isoOf(fy.startDate), to: today, income: inc.toFixed(2), expenses: exp.toFixed(2), netIncome: inc.minus(exp).toFixed(2) };
    }
    return {
      asOf: today,
      months,
      receivables: { ...Object.fromEntries(Object.entries(aging).map(([k, v]) => [k, v.toFixed(2)])), total: Object.values(aging).reduce((s, v) => s.plus(v), D(0)).toFixed(2), count: open.length },
      payables: { total: payable.toFixed(2), overdue: overdueBills.toFixed(2), count: openBills.length },
      bankAccounts: [
        ...banks.map((b) => ({ id: b.id, name: b.name, kind: b.kind, balance: (b.kind === 'CREDIT_CARD' ? balOf(b.ledgerAccountId).neg() : balOf(b.ledgerAccountId)).toFixed(2) })),
        ...holding.map((h) => ({ id: h.id, name: h.name, kind: 'HOLDING', balance: balOf(h.id).toFixed(2) })),
      ],
      profitAndLoss: ytd,
    };
  }
}
