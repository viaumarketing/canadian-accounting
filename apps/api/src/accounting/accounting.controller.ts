import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { createAccountSchema, createFiscalYearSchema, createJournalSchema, isoDate, lockPeriodSchema, reverseJournalSchema, roleHasPermission, updateAccountSchema } from '@ca/shared';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentMembership, CurrentUser, RequirePermission } from '../auth/decorators';
import { AuthUser, MembershipContext } from '../auth/auth.types';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from './ledger.service';
import { seedAccounting } from './setup';

const date = (v: string | undefined, name: string): string => {
  const r = isoDate.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `${name} must be a valid YYYY-MM-DD date` });
  return r.data;
};
const today = () => new Date().toISOString().slice(0, 10);

@Controller('companies/:companyId')
export class AccountingController {
  constructor(private readonly ledger: LedgerService, private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  // --- accounts ---
  @RequirePermission('accounts:view') @Get('accounts')
  accounts(@Param('companyId') c: string, @Query('all') all?: string) { return this.ledger.listAccounts(c, all === 'true'); }

  @RequirePermission('accounts:create') @Post('accounts')
  createAccount(@Param('companyId') c: string, @Body(new ZodPipe(createAccountSchema)) b: z.infer<typeof createAccountSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.ledger.createAccount(c, b, u.id, ip); }

  @RequirePermission('accounts:create') @Patch('accounts/:id')
  updateAccount(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateAccountSchema)) b: z.infer<typeof updateAccountSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.ledger.updateAccount(c, id, b, u.id, ip); }

  /** Idempotent: adds any missing template accounts, tax codes/rates and periods (e.g. for companies created in Milestone 1). */
  @RequirePermission('settings:create') @HttpCode(204) @Post('accounting/setup')
  async setup(@Param('companyId') c: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    await this.prisma.$transaction((tx) => seedAccounting(tx, c));
    await this.audit.record({ action: 'accounting.setup', companyId: c, actorId: u.id, ip });
  }

  // --- periods ---
  @RequirePermission('journal:view') @Get('periods')
  periods(@Param('companyId') c: string) { return this.ledger.listPeriods(c); }

  @RequirePermission('journal:approve') @Patch('periods/:id')
  lock(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(lockPeriodSchema)) b: { locked: boolean }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.ledger.setPeriodLock(c, id, b.locked, u.id, ip); }

  @RequirePermission('journal:view') @Get('fiscal-years')
  fiscalYears(@Param('companyId') c: string) { return this.ledger.listFiscalYears(c); }
  @RequirePermission('journal:view') @Get('fiscal-years/:id/close-preview')
  closePreview(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.ledger.closePreview(c, id); }
  @RequirePermission('journal:approve') @Post('fiscal-years/:id/close')
  closeYear(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.ledger.closeYear(c, id, u.id, ip); }
  @RequirePermission('journal:reverse') @Post('fiscal-years/:id/reopen')
  reopenYear(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.ledger.reopenYear(c, id, u.id, ip); }
  @RequirePermission('journal:approve') @Post('fiscal-years')
  fiscalYear(@Param('companyId') c: string, @Body(new ZodPipe(createFiscalYearSchema)) b: { startDate?: string }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.ledger.addFiscalYear(c, b.startDate, u.id, ip); }

  // --- journals ---
  @RequirePermission('journal:view') @Get('journals')
  journals(@Param('companyId') c: string, @Query() q: { from?: string; to?: string; status?: string; cursor?: string; take?: string }) {
    return this.ledger.listJournals(c, { from: q.from ? date(q.from, 'from') : undefined, to: q.to ? date(q.to, 'to') : undefined, status: q.status === 'DRAFT' || q.status === 'POSTED' ? q.status : undefined, cursor: q.cursor, take: q.take ? Number(q.take) || 50 : undefined });
  }

  @RequirePermission('journal:view') @Get('journals/:id')
  journal(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.ledger.getJournal(c, id); }

  @RequirePermission('journal:create') @Post('journals')
  createJournal(@Param('companyId') c: string, @Body(new ZodPipe(createJournalSchema)) b: z.infer<typeof createJournalSchema>, @CurrentUser() u: AuthUser, @CurrentMembership() m: MembershipContext, @ClientIp() ip: string | null) {
    if (b.post && !roleHasPermission(m.role, 'journal:post')) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Missing permission journal:post; save as a draft instead' });
    return this.ledger.createJournal(c, b, u.id, ip);
  }

  @RequirePermission('journal:post') @Post('journals/:id/post')
  postDraft(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.ledger.postDraft(c, id, u.id, ip); }

  @RequirePermission('journal:create') @HttpCode(204) @Delete('journals/:id')
  deleteDraft(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.ledger.deleteDraft(c, id, u.id, ip); }

  @RequirePermission('journal:reverse') @Post('journals/:id/reverse')
  reverse(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reverseJournalSchema)) b: { date?: string; memo?: string }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.ledger.reverse(c, id, u.id, b, ip); }

  // --- reports ---
  @RequirePermission('reports:view') @Get('reports/trial-balance')
  trialBalance(@Param('companyId') c: string, @Query('asOf') asOf?: string) { return this.ledger.trialBalance(c, date(asOf ?? today(), 'asOf')); }

  @RequirePermission('reports:view') @Get('reports/general-ledger')
  generalLedger(@Param('companyId') c: string, @Query() q: { accountId?: string; from?: string; to?: string }) {
    const id = z.string().uuid().safeParse(q.accountId);
    if (!id.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'accountId is required' });
    return this.ledger.generalLedger(c, id.data, date(q.from, 'from'), date(q.to ?? today(), 'to'));
  }
}
