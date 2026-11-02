import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { brandingSchema, sendDocumentSchema, uuid } from '@ca/shared';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { BrandingService } from './branding.service';
import { DocumentsService, type DocType } from './documents.service';
import { MailService } from '../mail/mail.service';

type Send = z.infer<typeof sendDocumentSchema>;
const logQuery = z.object({ kind: z.string().max(40).optional(), documentId: uuid.optional() });

export function sendPdf(res: Response, filename: string, pdf: Buffer) {
  res.setHeader('Content-Type', 'application/pdf');
  // inline: opens in the browser's PDF viewer to print; the file name is used if it is saved
  res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'no-store');
  return new StreamableFile(pdf);
}

@Controller('companies/:companyId')
export class DocumentsController {
  constructor(private readonly branding: BrandingService, private readonly documents: DocumentsService, private readonly mail: MailService) {}

  // ---- branding: template, e-mail sender details, logo
  @RequirePermission('company:view') @Get('branding')
  getBranding(@Param('companyId') c: string) { return this.branding.get(c); }
  @RequirePermission('settings:create') @Put('branding')
  putBranding(@Param('companyId') c: string, @Body(new ZodPipe(brandingSchema)) b: z.infer<typeof brandingSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.branding.update(c, b, u.id, ip); }
  @RequirePermission('company:view') @Get('branding/logo')
  async getLogo(@Param('companyId') c: string, @Res({ passthrough: true }) res: Response) {
    const l = await this.branding.logo(c);
    res.setHeader('Content-Type', l.mime);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(l.bytes);
  }
  /** Raw image bytes (application/octet-stream, at most 1 MB): PNG or JPEG, checked by content. */
  @RequirePermission('settings:create') @Post('branding/logo')
  putLogo(@Param('companyId') c: string, @Req() req: Request, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.branding.setLogo(c, Buffer.isBuffer(req.body) ? req.body : undefined, u.id, ip); }
  @RequirePermission('settings:create') @HttpCode(204) @Delete('branding/logo')
  deleteLogo(@Param('companyId') c: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.branding.deleteLogo(c, u.id, ip); }
  /** A sample invoice PDF with the current branding, for the settings preview. */
  @RequirePermission('company:view') @Get('branding/preview.pdf')
  async preview(@Param('companyId') c: string, @Res({ passthrough: true }) res: Response) {
    const { renderSample } = await import('./sample');
    return sendPdf(res, 'branding-preview.pdf', await renderSample(this.documents, c));
  }

  // ---- e-mail: preview the message, send, delivery log
  @RequirePermission('sales:view') @Get('invoices/:id/email')
  invoiceEmail(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.documents.preview(c, 'invoice', id); }
  @RequirePermission('sales:create') @Post('invoices/:id/send')
  sendInvoice(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sendDocumentSchema)) b: Send, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.send(c, 'invoice', id, b, u, ip); }
  @RequirePermission('sales:view') @Get('sales-receipts/:id/email')
  receiptEmail(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.documents.preview(c, 'sales_receipt', id); }
  @RequirePermission('sales:create') @Post('sales-receipts/:id/send')
  sendReceipt(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sendDocumentSchema)) b: Send, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.send(c, 'sales_receipt', id, b, u, ip); }
  @RequirePermission('sales:view') @Get('estimates/:id/email')
  estimateEmail(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.documents.preview(c, 'estimate', id); }
  @RequirePermission('sales:create') @Post('estimates/:id/send')
  sendEstimate(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sendDocumentSchema)) b: Send, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.send(c, 'estimate', id, b, u, ip); }
  @RequirePermission('purchases:view') @Get('purchase-orders/:id/email')
  poEmail(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.documents.preview(c, 'purchase_order', id); }
  @RequirePermission('purchases:create') @Post('purchase-orders/:id/send')
  sendPo(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sendDocumentSchema)) b: Send, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.send(c, 'purchase_order', id, b, u, ip); }
  private send(c: string, type: DocType, id: string, b: Send, u: AuthUser, ip: string | null) { return this.documents.send(c, type, id, b, u.id, ip); }

  @RequirePermission('sales:view') @Get('emails')
  emails(@Param('companyId') c: string, @Query(new ZodPipe(logQuery)) q: z.infer<typeof logQuery>) { return this.mail.log(c, q); }
}
