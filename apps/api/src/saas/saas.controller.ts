import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { CANADIAN_PROVINCES, checkoutPlanSchema, resendVerificationSchema, signupSchema, verifyEmailSchema } from '@ca/shared';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentUser, Public, SkipCsrf, SuperAdminOnly } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { SaasService } from './saas.service';

const companySchema = z.object({ legalName: z.string().trim().min(1).max(200), province: z.enum(CANADIAN_PROVINCES) });
const extendSchema = z.object({ days: z.number().int().min(1).max(90) });

@Controller()
export class SaasController {
  constructor(private readonly saas: SaasService) {}

  @Public() @Get('config')
  config() { return this.saas.publicConfig(); }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('signup')
  signup(@Body(new ZodPipe(signupSchema)) b: z.infer<typeof signupSchema>, @ClientIp() ip: string | null) { return this.saas.signup(b, ip); }
  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200) @Post('signup/verify')
  verify(@Body(new ZodPipe(verifyEmailSchema)) b: z.infer<typeof verifyEmailSchema>) { return this.saas.verify(b.token); }
  @Public() @Throttle({ default: { limit: 3, ttl: 60_000 } }) @HttpCode(202) @Post('signup/resend')
  resend(@Body(new ZodPipe(resendVerificationSchema)) b: z.infer<typeof resendVerificationSchema>) { return this.saas.resend(b.email); }

  // ---- the signed-in owner's subscription
  @Get('billing')
  billing(@CurrentUser() u: AuthUser) { return this.saas.billing(u.id); }
  @Post('billing/checkout')
  checkout(@CurrentUser() u: AuthUser, @Body(new ZodPipe(checkoutPlanSchema)) b: z.infer<typeof checkoutPlanSchema>) { return this.saas.checkout(u.id, b.plan); }
  @Post('billing/portal')
  portal(@CurrentUser() u: AuthUser) { return this.saas.portal(u.id); }
  @Post('billing/companies')
  addCompany(@CurrentUser() u: AuthUser, @Body(new ZodPipe(companySchema)) b: z.infer<typeof companySchema>, @ClientIp() ip: string | null) { return this.saas.addCompany(u.id, b, ip); }

  @Public() @SkipCsrf() @SkipThrottle() @HttpCode(200) @Post('webhooks/stripe-billing')
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') sig?: string) { return this.saas.webhook(req.rawBody, sig); }
}

/** Platform console: subscriptions and usage only. Super admins still cannot open any company's books. */
@SuperAdminOnly()
@Controller('admin/organizations')
export class SaasAdminController {
  constructor(private readonly saas: SaasService) {}
  @Get() list() { return this.saas.listOrganizations(); }
  @Post(':id/extend-trial')
  extend(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(extendSchema)) b: z.infer<typeof extendSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.saas.extendTrial(id, b.days, u.id, ip); }
}
