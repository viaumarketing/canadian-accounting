import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query, Put } from '@nestjs/common';
import { createBillSchema, createExpenseSchema, createInvoiceSchema, createPaymentSchema, decideExpenseSchema, reverseJournalSchema, roleHasPermission } from '@ca/shared';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentMembership, CurrentUser, RequirePermission } from '../auth/decorators';
import { AuthUser, MembershipContext } from '../auth/auth.types';
import { BillingService } from './billing.service';

type Ctx = { c: string; u: AuthUser; ip: string | null };

@Controller('companies/:companyId')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  // --- invoices / credit notes ---
  @RequirePermission('sales:view') @Get('invoices')
  invoices(@Param('companyId') c: string, @Query('status') s?: string) { return this.billing.listInvoices(c, s); }
  @RequirePermission('sales:view') @Get('invoices/:id')
  invoice(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.billing.getInvoice(c, id); }
  @RequirePermission('sales:create') @Post('invoices')
  createInvoice(@Param('companyId') c: string, @Body(new ZodPipe(createInvoiceSchema)) b: z.infer<typeof createInvoiceSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.createInvoice(c, b, u.id, ip); }
  @RequirePermission('sales:create') @Put('invoices/:id')
  updateInvoice(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(createInvoiceSchema)) b: z.infer<typeof createInvoiceSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.updateInvoice(c, id, b, u.id, ip); }
  @RequirePermission('sales:post') @Post('invoices/:id/post')
  postInvoice(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.postInvoice(c, id, u.id, ip); }
  @RequirePermission('sales:reverse') @Post('invoices/:id/void')
  voidInvoice(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.voidInvoice(c, id, u.id, ip); }

  // --- bills / vendor credits ---
  @RequirePermission('purchases:view') @Get('bills')
  bills(@Param('companyId') c: string, @Query('status') s?: string) { return this.billing.listBills(c, s); }
  @RequirePermission('purchases:view') @Get('bills/:id')
  bill(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.billing.getBill(c, id); }
  @RequirePermission('purchases:create') @Post('bills')
  createBill(@Param('companyId') c: string, @Body(new ZodPipe(createBillSchema)) b: z.infer<typeof createBillSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.createBill(c, b, u.id, ip); }
  @RequirePermission('purchases:create') @Put('bills/:id')
  updateBill(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(createBillSchema)) b: z.infer<typeof createBillSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.updateBill(c, id, b, u.id, ip); }
  @RequirePermission('purchases:post') @Post('bills/:id/post')
  postBill(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.postBill(c, id, u.id, ip); }
  @RequirePermission('purchases:reverse') @Post('bills/:id/void')
  voidBill(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.voidBill(c, id, u.id, ip); }

  // --- payments ---
  @RequirePermission('banking:view') @Get('payments')
  payments(@Param('companyId') c: string) { return this.billing.listPayments(c); }
  @RequirePermission('banking:view') @Post('payments')
  createPayment(@Param('companyId') c: string, @Body(new ZodPipe(createPaymentSchema)) b: z.infer<typeof createPaymentSchema>, @CurrentUser() u: AuthUser, @CurrentMembership() m: MembershipContext, @ClientIp() ip: string | null) {
    const need = b.direction === 'RECEIPT' ? 'sales:post' : 'purchases:post';
    if (!roleHasPermission(m.role, need)) throw new ForbiddenException({ code: 'FORBIDDEN', message: `Missing permission ${need}` });
    return this.billing.createPayment(c, b, u.id, ip);
  }
  @RequirePermission('banking:reverse') @Post('payments/:id/void')
  voidPayment(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reverseJournalSchema)) b: { date?: string }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.voidPayment(c, id, u.id, ip, b.date); }

  // --- expenses ---
  @RequirePermission('expenses:view') @Get('expenses')
  expenses(@Param('companyId') c: string, @CurrentUser() u: AuthUser, @CurrentMembership() m: MembershipContext) {
    // People who cannot approve expenses only ever see their own.
    return this.billing.listExpenses(c, roleHasPermission(m.role, 'expenses:approve') ? undefined : u.id);
  }
  @RequirePermission('expenses:create') @Post('expenses')
  createExpense(@Param('companyId') c: string, @Body(new ZodPipe(createExpenseSchema)) b: z.infer<typeof createExpenseSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.createExpense(c, b, u.id, ip); }
  @RequirePermission('expenses:approve') @Post('expenses/:id/approve')
  approve(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(decideExpenseSchema)) _b: unknown, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.decideExpense(c, id, 'approve', u.id, ip); }
  @RequirePermission('expenses:approve') @Post('expenses/:id/reject')
  reject(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(decideExpenseSchema)) _b: unknown, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.decideExpense(c, id, 'reject', u.id, ip); }
  @RequirePermission('expenses:post') @Post('expenses/:id/post')
  postExpense(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.billing.postExpense(c, id, u.id, ip); }
}
export type { Ctx };
