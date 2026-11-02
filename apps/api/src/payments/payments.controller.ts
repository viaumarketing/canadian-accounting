import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, Res } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { depositSchema, stripeConnectSchema } from '@ca/shared';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentUser, Public, RequirePermission, SkipCsrf } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { StripePaymentsService } from './stripe-payments.service';
import { DepositsService } from './deposits.service';
import { sendPdf } from '../documents/documents.controller';

@Controller('companies/:companyId')
export class PaymentsController {
  constructor(private readonly stripe: StripePaymentsService, private readonly deposits: DepositsService) {}

  // ---- the company's Stripe connection
  @RequirePermission('settings:create') @Get('stripe')
  status(@Param('companyId') c: string) { return this.stripe.status(c); }
  @RequirePermission('settings:create') @Put('stripe')
  connect(@Param('companyId') c: string, @Body(new ZodPipe(stripeConnectSchema)) b: z.infer<typeof stripeConnectSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.stripe.connect(c, b, u.id, ip); }
  @RequirePermission('settings:create') @HttpCode(204) @Delete('stripe')
  disconnect(@Param('companyId') c: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.stripe.disconnect(c, u.id, ip); }
  @RequirePermission('sales:view') @Get('stripe/checkouts')
  checkouts(@Param('companyId') c: string) { return this.stripe.listCheckouts(c); }

  // ---- Undeposited Funds and bank deposits
  @RequirePermission('banking:view') @Get('deposits/undeposited')
  undeposited(@Param('companyId') c: string) { return this.deposits.undeposited(c); }
  @RequirePermission('banking:view') @Get('deposits')
  list(@Param('companyId') c: string) { return this.deposits.list(c); }
  @RequirePermission('banking:view') @Get('deposits/:id')
  get(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.deposits.get(c, id); }
  @RequirePermission('banking:post') @Post('deposits')
  create(@Param('companyId') c: string, @Body(new ZodPipe(depositSchema)) b: z.infer<typeof depositSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.deposits.create(c, b, u.id, ip); }
  @RequirePermission('banking:reverse') @Post('deposits/:id/void')
  voidDeposit(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.deposits.void(c, id, u.id, ip); }
}

/** The customer's invoice link (/i/:token in the web app). The token is the only credential: 32 random characters. */
@Controller('public/invoices')
export class PublicInvoiceController {
  constructor(private readonly stripe: StripePaymentsService) {}

  @Public() @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Get(':token')
  get(@Param('token') t: string) { return this.stripe.publicInvoice(t); }
  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @Get(':token/pdf')
  async pdf(@Param('token') t: string, @Res({ passthrough: true }) res: Response) { const r = await this.stripe.publicPdf(t); return sendPdf(res, r.filename, r.pdf); }
  /** Same-origin POST from the invoice page (CSRF origin check applies), answered with the Stripe Checkout URL. */
  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post(':token/checkout')
  checkout(@Param('token') t: string) { return this.stripe.checkout(t); }
}

@Controller('webhooks')
export class StripeWebhookController {
  constructor(private readonly stripe: StripePaymentsService) {}

  /** One endpoint per connected company; the path names the connection, the signature proves it is Stripe. */
  @Public() @SkipCsrf() @SkipThrottle() @HttpCode(200) @Post('stripe/:accountId')
  receive(@Param('accountId') id: string, @Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') sig?: string) { return this.stripe.webhook(id, req.rawBody, sig); }
}
