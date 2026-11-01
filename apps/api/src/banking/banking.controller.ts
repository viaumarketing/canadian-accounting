import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { isoDate, uuid, amountString } from '@ca/shared';
import type { CsvMapping } from '@ca/banking';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { BankingService } from './banking.service';
import { ConnectionsService } from './connections.service';
import { ReconciliationService } from './reconciliation.service';

const col = z.number().int().min(0).max(200);
const mappingSchema = z.object({
  hasHeader: z.boolean().default(true), dateColumn: col, dateFormat: z.enum(['YMD', 'MDY', 'DMY', 'YYYYMMDD', 'auto']), descriptionColumns: z.array(col).min(1).max(5),
  amount: z.union([z.object({ mode: z.literal('single'), column: col, invert: z.boolean().optional() }), z.object({ mode: z.literal('split'), debitColumn: col, creditColumn: col })]),
  balanceColumn: col.optional(), externalIdColumn: col.optional(), decimalComma: z.boolean().optional(), delimiter: z.string().length(1).optional(),
});
const createAccountSchema = z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(['CHEQUING', 'SAVINGS', 'CREDIT_CARD']), institution: z.string().max(100).optional(), mask: z.string().regex(/^\w{2,4}$/).optional(), ledgerAccountId: uuid.optional(), newLedgerAccount: z.object({ code: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(120) }).optional() });
const updateAccountSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), isActive: z.boolean().optional(), institution: z.string().max(100).nullable().optional() });
const categorizeSchema = z.object({ lines: z.array(z.object({ accountId: uuid, amount: amountString, taxCodeId: uuid.optional(), description: z.string().max(300).optional() })).min(1).max(50), taxInclusive: z.boolean().default(true), contactId: uuid.optional(), memo: z.string().max(300).optional() });
const settleSchema = z.object({ contactId: uuid, allocations: z.array(z.object({ documentId: uuid, amount: amountString })).min(1).max(50) });
const transferSchema = z.object({ counterpartTxnId: uuid.optional(), toBankAccountId: uuid.optional() });
const ignoreSchema = z.object({ reason: z.string().max(200).optional() });
const matchSchema = z.object({ journalLineId: uuid });
const bulkSchema = z.object({ bankAccountId: uuid, minConfidence: z.number().min(0.9).max(1).default(0.9) });
const ruleSchema = z.object({
  name: z.string().trim().min(1).max(100), priority: z.number().int().min(1).max(10_000).default(100),
  conditions: z.object({ descriptionContains: z.array(z.string().trim().min(1).max(100)).max(20).optional(), direction: z.enum(['IN', 'OUT']).optional(), minAmount: amountString.optional(), maxAmount: amountString.optional(), bankAccountId: uuid.optional() })
    .refine((c) => Boolean(c.descriptionContains?.length || c.direction || c.minAmount || c.maxAmount), 'A rule needs at least one condition'),
  accountId: uuid, taxCodeId: uuid.optional(), contactId: uuid.optional(), isActive: z.boolean().default(true),
});
const reconSchema = z.object({ statementDate: isoDate, statementBalance: z.string().regex(/^-?\d{1,13}(\.\d{1,2})?$/), openingBalance: z.string().regex(/^-?\d{1,13}(\.\d{1,2})?$/).optional(), note: z.string().max(300).optional() });
const exchangeSchema = z.object({ publicToken: z.string().min(5).max(500), institutionName: z.string().max(100).optional() });
const linkSchema = z.object({ accounts: z.array(z.object({ providerAccountId: z.string().min(1).max(200), name: z.string().trim().min(1).max(100), kind: z.enum(['CHEQUING', 'SAVINGS', 'CREDIT_CARD']), mask: z.string().regex(/^\w{2,4}$/).optional(), ledgerAccountId: uuid.optional(), newLedgerAccount: z.object({ code: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(120) }).optional() })).min(1).max(30) });

function upload(req: Request, headers: Record<string, string | undefined>) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new BadRequestException({ code: 'NO_FILE', message: 'Send the file as the request body with Content-Type: application/octet-stream' });
  const filename = decodeURIComponent(String(req.query.filename ?? 'statement')).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  let mapping: CsvMapping | undefined;
  if (headers['x-import-mapping']) {
    if (headers['x-import-mapping'].length > 4000) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Mapping header too long' });
    try { mapping = new ZodPipe(mappingSchema).transform(JSON.parse(headers['x-import-mapping'])) as CsvMapping; }
    catch (e) { if (e instanceof BadRequestException) throw e; throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'X-Import-Mapping must be valid JSON' }); }
  }
  return { buf: req.body, filename, mapping };
}

@Controller('companies/:companyId/banking')
export class BankingController {
  constructor(private readonly banking: BankingService, private readonly recon: ReconciliationService, private readonly conns: ConnectionsService) {}

  // ---- accounts
  @RequirePermission('banking:view') @Get('accounts')
  accounts(@Param('companyId') c: string) { return this.banking.listAccounts(c); }
  @RequirePermission('banking:create') @Post('accounts')
  createAccount(@Param('companyId') c: string, @Body(new ZodPipe(createAccountSchema)) b: z.infer<typeof createAccountSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.createAccount(c, b, u.id, ip); }
  @RequirePermission('banking:create') @Patch('accounts/:id')
  updateAccount(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateAccountSchema)) b: z.infer<typeof updateAccountSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.updateAccount(c, id, b, u.id, ip); }

  // ---- import (raw bytes; options in query/headers)
  @RequirePermission('banking:create') @HttpCode(200) @Post('accounts/:id/import/preview')
  preview(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request, @Headers() h: Record<string, string>) { const u = upload(req, h); return this.banking.previewImport(c, id, u.buf, u.filename, u.mapping); }
  @RequirePermission('banking:create') @Post('accounts/:id/import/commit')
  commit(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request, @Headers() h: Record<string, string>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { const f = upload(req, h); return this.banking.commitImport(c, id, f.buf, f.filename, { mapping: f.mapping, acceptErrors: h['x-import-accept-errors'] === 'true' }, u.id, ip); }
  @RequirePermission('banking:view') @Get('statements')
  statements(@Param('companyId') c: string, @Query('bankAccountId') a?: string) { return this.banking.listStatements(c, a && /^[0-9a-f-]{36}$/i.test(a) ? a : undefined); }
  @RequirePermission('banking:view') @Get('statements/:id/download')
  async download(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const s = await this.banking.downloadStatement(c, id);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${s.filename.replace(/[^\w.\- ()]/g, '_')}"`);
    res.setHeader('X-Content-SHA256', s.sha256);
    res.send(s.bytes);
  }

  // ---- transactions
  @RequirePermission('banking:view') @Get('transactions')
  transactions(@Param('companyId') c: string, @Query() q: { bankAccountId?: string; status?: string; from?: string; to?: string; search?: string; cursor?: string; take?: string }) {
    const ok = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    const uid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
    return this.banking.listTransactions(c, { bankAccountId: uid(q.bankAccountId), status: ['UNMATCHED', 'MATCHED', 'RECONCILED', 'IGNORED'].includes(q.status ?? '') ? q.status : undefined, from: ok(q.from), to: ok(q.to), search: q.search?.slice(0, 100), cursor: uid(q.cursor), take: q.take ? Number(q.take) || 50 : undefined });
  }
  @RequirePermission('banking:post') @Post('transactions/:id/categorize')
  categorize(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(categorizeSchema)) b: z.infer<typeof categorizeSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.categorize(c, id, b, u.id, ip); }
  @RequirePermission('banking:view') @Get('transactions/:id/documents')
  documents(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.banking.documentSuggestions(c, id); }
  @RequirePermission('banking:post') @Post('transactions/:id/settle')
  settle(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(settleSchema)) b: z.infer<typeof settleSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.settle(c, id, b, u.id, ip); }
  @RequirePermission('banking:post') @Post('transactions/:id/transfer')
  transfer(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(transferSchema)) b: z.infer<typeof transferSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.transfer(c, id, b, u.id, ip); }
  @RequirePermission('banking:approve') @Post('transactions/:id/match')
  manual(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(matchSchema)) b: { journalLineId: string }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.manualMatch(c, id, b.journalLineId, u.id, ip); }
  @RequirePermission('banking:approve') @HttpCode(204) @Post('transactions/:id/unmatch')
  unmatch(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.unmatch(c, id, u.id, ip); }
  @RequirePermission('banking:reverse') @HttpCode(204) @Post('transactions/:id/undo')
  undo(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.undoCreated(c, id, u.id, ip); }
  @RequirePermission('banking:approve') @HttpCode(204) @Post('transactions/:id/ignore')
  ignore(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ignoreSchema)) b: { reason?: string }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.setIgnored(c, id, true, b.reason, u.id, ip); }
  @RequirePermission('banking:approve') @HttpCode(204) @Post('transactions/:id/unignore')
  unignore(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.setIgnored(c, id, false, undefined, u.id, ip); }

  // ---- suggestions
  @RequirePermission('banking:create') @Post('accounts/:id/suggest')
  suggest(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.banking.suggest(c, id).then((n) => ({ suggestions: n })); }
  @RequirePermission('banking:approve') @Post('matches/approve-bulk')
  bulk(@Param('companyId') c: string, @Body(new ZodPipe(bulkSchema)) b: z.infer<typeof bulkSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.approveBulk(c, b, u.id, ip); }
  @RequirePermission('banking:approve') @Post('matches/:id/approve')
  approve(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.approveMatch(c, id, u.id, ip); }
  @RequirePermission('banking:approve') @HttpCode(204) @Post('matches/:id/reject')
  reject(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.rejectMatch(c, id, u.id, ip); }
  @RequirePermission('banking:view') @Get('transfer-candidates')
  transferCandidates(@Param('companyId') c: string) { return this.banking.transferCandidates(c); }

  // ---- rules
  @RequirePermission('banking:view') @Get('rules')
  rules(@Param('companyId') c: string) { return this.banking.listRules(c); }
  @RequirePermission('banking:create') @Post('rules')
  createRule(@Param('companyId') c: string, @Body(new ZodPipe(ruleSchema)) b: z.infer<typeof ruleSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.saveRule(c, b, u.id, ip); }
  @RequirePermission('banking:create') @Put('rules/:id')
  updateRule(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ruleSchema)) b: z.infer<typeof ruleSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.banking.saveRule(c, { ...b, id }, u.id, ip); }
  @RequirePermission('banking:create') @HttpCode(204) @Delete('rules/:id')
  deleteRule(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.banking.deleteRule(c, id); }
  @RequirePermission('banking:create') @Post('rules/apply')
  applyRules(@Param('companyId') c: string) { return this.banking.applyRules(c).then((n) => ({ suggested: n })); }

  // ---- reconciliation
  @RequirePermission('banking:view') @Get('accounts/:id/reconciliation-preview')
  reconPreview(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: { statementDate?: string; statementBalance?: string; openingBalance?: string }) {
    return this.recon.preview(c, id, new ZodPipe(reconSchema).transform({ statementDate: q.statementDate, statementBalance: q.statementBalance, openingBalance: q.openingBalance || undefined }) as z.infer<typeof reconSchema>);
  }
  @RequirePermission('banking:post') @Post('accounts/:id/reconciliations')
  reconcile(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reconSchema)) b: z.infer<typeof reconSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.recon.complete(c, id, b, u.id, ip); }
  @RequirePermission('banking:view') @Get('reconciliations')
  reconciliations(@Param('companyId') c: string, @Query('bankAccountId') a?: string) { return this.recon.list(c, a && /^[0-9a-f-]{36}$/i.test(a) ? a : undefined); }
  @RequirePermission('banking:view') @Get('reconciliations/:id')
  reconReport(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.recon.report(c, id); }
  @RequirePermission('banking:reverse') @Post('reconciliations/:id/reopen')
  reopen(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.recon.reopen(c, id, u.id, ip); }

  // ---- provider connections (credentials-level: owners/admins)
  @RequirePermission('banking:view') @Get('connections')
  connections(@Param('companyId') c: string) { return this.conns.list(c).then((list) => ({ ...this.conns.status(), connections: list })); }
  @RequirePermission('settings:create') @Post('connections/link-token')
  linkToken(@Param('companyId') c: string, @CurrentUser() u: AuthUser) { return this.conns.linkToken(c, u.id); }
  @RequirePermission('settings:create') @Post('connections/exchange')
  exchange(@Param('companyId') c: string, @Body(new ZodPipe(exchangeSchema)) b: z.infer<typeof exchangeSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.conns.exchange(c, b.publicToken, b.institutionName, u.id, ip); }
  @RequirePermission('settings:create') @Post('connections/:id/accounts')
  linkAccounts(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(linkSchema)) b: z.infer<typeof linkSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.conns.linkAccounts(c, id, b.accounts, u.id, ip); }
  @RequirePermission('banking:create') @Post('connections/:id/sync')
  syncConn(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.conns.sync(c, id, u.id, ip); }
  @RequirePermission('settings:create') @HttpCode(204) @Delete('connections/:id')
  removeConn(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.conns.remove(c, id, u.id, ip); }
}
