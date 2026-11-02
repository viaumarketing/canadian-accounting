import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { createSalesReceiptSchema, isoDate, itemSchema, updateContactSchema, updateItemSchema, uuid } from '@ca/shared';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentMembership, CurrentUser, RequirePermission } from '../auth/decorators';
import { AuthUser, MembershipContext } from '../auth/auth.types';
import { SalesService } from './sales.service';
import { ContactsService } from '../contacts/contacts.service';

const allSalesQuery = z.object({
  type: z.enum(['invoice', 'credit_note', 'sales_receipt', 'payment']).optional(),
  status: z.enum(['open', 'overdue', 'paid']).optional(),
  contactId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

@Controller('companies/:companyId')
export class SalesController {
  constructor(private readonly sales: SalesService, private readonly contacts: ContactsService) {}

  // --- all sales + money bar ---
  @RequirePermission('sales:view') @Get('sales/transactions')
  allSales(@Param('companyId') c: string, @Query(new ZodPipe(allSalesQuery)) q: z.infer<typeof allSalesQuery>) { return this.sales.allSales(c, q); }
  @RequirePermission('sales:view') @Get('sales/summary')
  summary(@Param('companyId') c: string) { return this.sales.moneyBar(c); }
  @RequirePermission('sales:view') @Get('sales/customer-balances')
  balances(@Param('companyId') c: string) { return this.sales.customerBalances(c); }

  // --- sales receipts ---
  @RequirePermission('sales:view') @Get('sales-receipts')
  receipts(@Param('companyId') c: string) { return this.sales.listReceipts(c); }
  @RequirePermission('sales:view') @Get('sales-receipts/:id')
  receipt(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.sales.getReceipt(c, id); }
  @RequirePermission('sales:create') @Post('sales-receipts')
  createReceipt(@Param('companyId') c: string, @Body(new ZodPipe(createSalesReceiptSchema)) b: z.infer<typeof createSalesReceiptSchema>, @CurrentUser() u: AuthUser, @CurrentMembership() m: MembershipContext, @ClientIp() ip: string | null) { return this.sales.createReceipt(c, b, u.id, m.role, ip); }
  @RequirePermission('sales:create') @Put('sales-receipts/:id')
  updateReceipt(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(createSalesReceiptSchema)) b: z.infer<typeof createSalesReceiptSchema>, @CurrentUser() u: AuthUser, @CurrentMembership() m: MembershipContext, @ClientIp() ip: string | null) { return this.sales.updateReceipt(c, id, b, u.id, m.role, ip); }
  @RequirePermission('sales:post') @Post('sales-receipts/:id/post')
  postReceipt(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.sales.postReceipt(c, id, u.id, ip); }
  @RequirePermission('sales:reverse') @Post('sales-receipts/:id/void')
  voidReceipt(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.sales.voidReceipt(c, id, u.id, ip); }

  // --- printable documents ---
  @RequirePermission('sales:view') @Get('invoices/:id/pdf')
  invoicePdf(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) { return this.pdf(c, 'invoice', id, res); }
  @RequirePermission('sales:view') @Get('sales-receipts/:id/pdf')
  receiptPdf(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) { return this.pdf(c, 'sales_receipt', id, res); }
  private async pdf(c: string, type: 'invoice' | 'sales_receipt', id: string, res: Response) {
    const { filename, pdf } = await this.sales.documentPdf(c, type, id);
    res.setHeader('Content-Type', 'application/pdf');
    // inline: opens in the browser's PDF viewer to print; the file name is used if it is saved
    res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(pdf);
  }

  // --- products & services ---
  @RequirePermission('sales:view') @Get('items')
  items(@Param('companyId') c: string, @Query('all') all?: string) { return this.sales.listItems(c, all === 'true'); }
  @RequirePermission('sales:create') @Post('items')
  createItem(@Param('companyId') c: string, @Body(new ZodPipe(itemSchema)) b: z.infer<typeof itemSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.sales.createItem(c, b, u.id, ip); }
  @RequirePermission('sales:create') @Patch('items/:id')
  updateItem(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateItemSchema)) b: z.infer<typeof updateItemSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.sales.updateItem(c, id, b, u.id, ip); }

  // --- customers (contact details used on documents) ---
  @RequirePermission('sales:create') @Patch('contacts/:id')
  updateContact(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateContactSchema)) b: z.infer<typeof updateContactSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.contacts.update(c, id, b, u.id, ip); }
}
