import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, RawBodyRequest, Req, Res, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { verifyWebhookHmac } from '@ca/shopify-integration';
import { isoDate, uuid } from '@ca/shared';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../config';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentUser, Public, RequirePermission, SkipCsrf } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { ACCOUNT_KEYS, ShopifyService } from './shopify.service';
import { ShopifySyncService } from './sync.service';

const connectSchema = z.object({ shop: z.string().min(1).max(200) });
const syncSchema = z.object({ kind: z.enum(['HISTORICAL', 'INCREMENTAL']).default('INCREMENTAL'), since: isoDate.optional() });
const settingsSchema = z.object({
  accountMap: z.object(Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, uuid.optional()])) as Record<(typeof ACCOUNT_KEYS)[number], z.ZodOptional<typeof uuid>>).partial().optional(),
  historyStart: isoDate.nullable().optional(),
});
const classifySchema = z.object({ accountId: uuid });

@Controller('companies/:companyId/shopify')
export class ShopifyController {
  constructor(private readonly shopify: ShopifyService, private readonly sync: ShopifySyncService) {}

  @RequirePermission('shopify:view') @Get('stores')
  stores(@Param('companyId') c: string) { return this.shopify.listStores(c); }

  @RequirePermission('settings:create') @Post('connect')
  connect(@Param('companyId') c: string, @Body(new ZodPipe(connectSchema)) b: { shop: string }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.shopify.startConnect(c, u.id, b.shop, ip); }

  @RequirePermission('settings:create') @Patch('stores/:storeId/settings')
  settings(@Param('companyId') c: string, @Param('storeId', ParseUUIDPipe) id: string, @Body(new ZodPipe(settingsSchema)) b: z.infer<typeof settingsSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.shopify.updateSettings(c, id, b, u.id, ip); }

  @RequirePermission('settings:create') @HttpCode(204) @Delete('stores/:storeId')
  disconnect(@Param('companyId') c: string, @Param('storeId', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.shopify.disconnect(c, id, u.id, ip); }

  @RequirePermission('shopify:create') @Post('stores/:storeId/sync')
  requestSync(@Param('companyId') c: string, @Param('storeId', ParseUUIDPipe) id: string, @Body(new ZodPipe(syncSchema)) b: z.infer<typeof syncSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.shopify.requestSync(c, id, b.kind, b.since, u.id, ip); }

  @RequirePermission('shopify:post') @Post('stores/:storeId/repost')
  repost(@Param('companyId') c: string, @Param('storeId', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.sync.repost(c, id, u.id, ip); }

  @RequirePermission('shopify:view') @Get('jobs')
  jobs(@Param('companyId') c: string, @Query('storeId') storeId?: string) { return this.shopify.listJobs(c, storeId && /^[0-9a-f-]{36}$/i.test(storeId) ? storeId : undefined); }

  @RequirePermission('shopify:view') @Get('orders')
  orders(@Param('companyId') c: string, @Query('status') s?: string) { return this.shopify.listOrders(c, s); }

  @RequirePermission('shopify:view') @Get('review')
  review(@Param('companyId') c: string) { return this.shopify.reviewQueue(c); }

  @RequirePermission('shopify:view') @Get('payouts')
  payouts(@Param('companyId') c: string) { return this.shopify.listPayouts(c); }

  @RequirePermission('shopify:view') @Get('payouts/:id')
  payout(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.shopify.payoutDetail(c, id); }

  @RequirePermission('shopify:post') @Post('balance-transactions/:id/classify')
  classify(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(classifySchema)) b: { accountId: string }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.shopify.classifyBalanceTransaction(c, id, b.accountId, u.id, ip); }
}

/** Where Shopify sends the merchant after they approve the app. Authenticated by `state` + HMAC, not by session. */
@Controller('shopify')
export class ShopifyCallbackController {
  constructor(private readonly shopify: ShopifyService, @Inject(CONFIG) private readonly config: AppConfig) {}

  @Public() @SkipThrottle() @Get('callback')
  async callback(@Query() q: Record<string, unknown>, @Res() res: Response, @ClientIp() ip: string | null) {
    const params = Object.fromEntries(Object.entries(q).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    const r = await this.shopify.finishConnect(params, ip);
    const base = new URL(this.config.WEB_ORIGIN).origin;
    if (!r.companyId) return res.redirect(`${base}/?shopifyError=${encodeURIComponent(r.error ?? 'failed')}`);
    return res.redirect(`${base}/c/${r.companyId}/shopify?${r.ok ? 'connected=1' : `error=${encodeURIComponent(r.error ?? 'failed')}`}`);
  }
}

@Controller('webhooks')
export class ShopifyWebhookController {
  constructor(private readonly shopify: ShopifyService, @Inject(CONFIG) private readonly config: AppConfig) {}

  /** HMAC over the raw bytes first; nothing is parsed or trusted before that. Answers fast: work happens in the job. */
  @Public() @SkipCsrf() @SkipThrottle() @HttpCode(200) @Post('shopify')
  async receive(@Req() req: RawBodyRequest<Request>, @Headers('x-shopify-hmac-sha256') hmac?: string, @Headers('x-shopify-topic') topic?: string, @Headers('x-shopify-shop-domain') shop?: string, @Headers('x-shopify-webhook-id') webhookId?: string) {
    if (!this.config.SHOPIFY_CLIENT_SECRET) throw new ServiceUnavailableException({ code: 'SHOPIFY_NOT_CONFIGURED', message: 'Shopify is not configured' });
    if (!req.rawBody || !verifyWebhookHmac(req.rawBody, hmac, this.config.SHOPIFY_CLIENT_SECRET)) throw new UnauthorizedException({ code: 'BAD_SIGNATURE', message: 'Invalid signature' });
    if (!topic || !shop || !webhookId) throw new UnauthorizedException({ code: 'BAD_HEADERS', message: 'Missing Shopify headers' });
    return this.shopify.handleWebhook(shop.toLowerCase(), topic, webhookId);
  }
}
