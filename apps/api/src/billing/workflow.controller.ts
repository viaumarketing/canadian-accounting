import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { applyCreditSchema, estimateDecisionSchema, estimateSchema, isoDate, lateFeeSettingsSchema, payBillsSchema, recurringSchema, reminderSettingsSchema, sendDocumentSchema, sendStatementSchema, statementQuery } from '@ca/shared';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentMembership, CurrentUser, RequirePermission } from '../auth/decorators';
import { AuthUser, MembershipContext } from '../auth/auth.types';
import { EstimatesService } from './estimates.service';
import { StatementsService } from './statements.service';
import { AutomationService } from './automation.service';
import { BillingService } from './billing.service';
import { DocumentsService } from '../documents/documents.service';
import { sendPdf } from '../documents/documents.controller';

type Est = z.infer<typeof estimateSchema>;
const convertBody = z.object({ issueDate: isoDate.optional() });
const collectionsBody = z.object({ reminders: reminderSettingsSchema.optional(), lateFees: lateFeeSettingsSchema.nullable().optional() });

/** Estimates, recurring transactions, statements, collections (reminders, late fees), credits and paying bills. */
@Controller('companies/:companyId')
export class WorkflowController {
  constructor(private readonly estimates: EstimatesService, private readonly statements: StatementsService, private readonly automation: AutomationService, private readonly billing: BillingService, private readonly documents: DocumentsService) {}

  // ---- estimates
  @RequirePermission('sales:view') @Get('estimates')
  list(@Param('companyId') c: string, @Query('status') s?: string) { return this.estimates.list(c, s); }
  @RequirePermission('sales:view') @Get('estimates/:id')
  get(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.estimates.get(c, id); }
  @RequirePermission('sales:create') @Post('estimates')
  create(@Param('companyId') c: string, @Body(new ZodPipe(estimateSchema)) b: Est, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.estimates.create(c, b, u.id, ip); }
  @RequirePermission('sales:create') @Put('estimates/:id')
  update(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(estimateSchema)) b: Est, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.estimates.update(c, id, b, u.id, ip); }
  @RequirePermission('sales:create') @Post('estimates/:id/decision')
  decide(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(estimateDecisionSchema)) b: z.infer<typeof estimateDecisionSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.estimates.decide(c, id, b, u.id, ip); }
  @RequirePermission('sales:create') @Post('estimates/:id/convert')
  convert(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(convertBody)) b: z.infer<typeof convertBody>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.estimates.convert(c, id, u.id, ip, b.issueDate); }
  @RequirePermission('sales:reverse') @Post('estimates/:id/void')
  voidEstimate(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.estimates.void(c, id, u.id, ip); }
  @RequirePermission('sales:view') @Get('estimates/:id/pdf')
  async estimatePdf(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) { const r = await this.documents.render(c, 'estimate', id); return sendPdf(res, r.filename, r.pdf); }

  // ---- recurring transactions
  @RequirePermission('sales:view') @Get('recurring')
  recurring(@Param('companyId') c: string) { return this.automation.listTemplates(c); }
  @RequirePermission('sales:create') @Post('recurring')
  createRecurring(@Param('companyId') c: string, @Body(new ZodPipe(recurringSchema)) b: z.infer<typeof recurringSchema>, @CurrentUser() u: AuthUser, @CurrentMembership() m: MembershipContext, @ClientIp() ip: string | null) { return this.automation.saveTemplate(c, null, b, u.id, m.role, ip); }
  @RequirePermission('sales:create') @Put('recurring/:id')
  updateRecurring(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(recurringSchema)) b: z.infer<typeof recurringSchema>, @CurrentUser() u: AuthUser, @CurrentMembership() m: MembershipContext, @ClientIp() ip: string | null) { return this.automation.saveTemplate(c, id, b, u.id, m.role, ip); }
  @RequirePermission('sales:create') @HttpCode(204) @Delete('recurring/:id')
  deleteRecurring(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.automation.deleteTemplate(c, id, u.id, ip); }
  /** Create the next occurrence now (it moves the schedule forward, as a normal run would). */
  @RequirePermission('sales:create') @Post('recurring/:id/run')
  async runRecurring(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) {
    const t = (await this.automation.listTemplates(c)).find((x) => x.id === id);
    if (!t) return { created: 0, error: 'Recurring template not found' };
    const created = await this.automation.runTemplate(id, undefined, { once: true });
    const after = (await this.automation.listTemplates(c)).find((x) => x.id === id)!;
    return { created, nextDate: after.nextDate, lastError: after.lastError };
  }

  // ---- customer statements
  @RequirePermission('sales:view') @Get('statements')
  statement(@Param('companyId') c: string, @Query(new ZodPipe(statementQuery)) q: z.infer<typeof statementQuery>) { return this.statements.build(c, q); }
  @RequirePermission('sales:view') @Get('statements/pdf')
  async statementPdf(@Param('companyId') c: string, @Query(new ZodPipe(statementQuery)) q: z.infer<typeof statementQuery>, @Res({ passthrough: true }) res: Response) { const r = await this.statements.pdf(c, q); return sendPdf(res, r.filename, r.pdf); }
  @RequirePermission('sales:create') @Post('statements/send')
  sendStatement(@Param('companyId') c: string, @Body(new ZodPipe(sendStatementSchema)) b: z.infer<typeof sendStatementSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.statements.send(c, b, u.id, ip); }

  // ---- collections: reminders and late fees
  @RequirePermission('sales:view') @Get('collections/settings')
  collections(@Param('companyId') c: string) { return this.automation.getSettings(c); }
  @RequirePermission('settings:create') @Put('collections/settings')
  saveCollections(@Param('companyId') c: string, @Body(new ZodPipe(collectionsBody)) b: z.infer<typeof collectionsBody>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.automation.saveSettings(c, b as never, u.id, ip); }
  @RequirePermission('sales:create') @Post('invoices/:id/remind')
  remind(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sendDocumentSchema)) b: z.infer<typeof sendDocumentSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.documents.send(c, 'invoice', id, b, u.id, ip, { kind: 'reminder' }); }

  // ---- credits, paying bills, billable time and costs
  @RequirePermission('sales:post') @Post('invoices/:id/apply-credit')
  applyInvoiceCredit(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(applyCreditSchema)) b: z.infer<typeof applyCreditSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.applyCredit(c, 'invoice', id, b, u.id, ip); }
  @RequirePermission('purchases:post') @Post('bills/:id/apply-credit')
  applyBillCredit(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(applyCreditSchema)) b: z.infer<typeof applyCreditSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.applyCredit(c, 'bill', id, b, u.id, ip); }
  @RequirePermission('sales:reverse') @Post('credit-applications/:id/unapply')
  unapply(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.unapplyCredit(c, id, u.id, ip); }
  @RequirePermission('purchases:post') @Post('bills/pay')
  payBills(@Param('companyId') c: string, @Body(new ZodPipe(payBillsSchema)) b: z.infer<typeof payBillsSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.payBills(c, b, u.id, ip); }
  @RequirePermission('sales:view') @Get('customers/:id/billables')
  billables(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.billing.billables(c, id); }
}
