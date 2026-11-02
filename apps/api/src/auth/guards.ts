import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Permission, roleHasPermission } from '@ca/shared';
import { AppConfig, CONFIG } from '../config';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { IS_PUBLIC, PERMISSION, SKIP_CSRF, SUPER_ADMIN_ONLY } from './decorators';
import { SESSION_COOKIE } from './auth.types';
import { FEATURE } from '../saas/saas.decorators';
import { PLANS, writable, type Feature } from '../saas/plans';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_WHILE_PASSWORD_CHANGE_PENDING = ['/auth/me', '/auth/logout', '/auth/change-password'];

/**
 * CSRF defence for cookie auth, layered on SameSite=Lax:
 * state-changing requests must come from our web origin, or carry a custom header
 * (which a cross-site page cannot set without a CORS preflight that we never grant).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig, private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [ctx.getHandler(), ctx.getClass()])) return true;
    const origin = req.headers.origin;
    if (origin) {
      if (origin === new URL(this.config.WEB_ORIGIN).origin) return true;
      throw new ForbiddenException({ code: 'CSRF', message: 'Cross-origin request rejected' });
    }
    if (req.headers['x-requested-with'] === 'ca-web') return true;
    throw new ForbiddenException({ code: 'CSRF', message: 'Missing origin' });
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const session = token ? await this.auth.validateSession(token) : null;
    if (!session) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Sign in required' });
    req.auth = session;

    if (
      session.user.mustChangePassword &&
      !ALLOWED_WHILE_PASSWORD_CHANGE_PENDING.some((p) => req.path === p)
    ) {
      throw new ForbiddenException({ code: 'PASSWORD_CHANGE_REQUIRED', message: 'Change your password to continue' });
    }
    if (
      this.reflector.getAllAndOverride<boolean>(SUPER_ADMIN_ONLY, targets) &&
      !session.user.isSuperAdmin
    ) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Platform administrators only' });
    }
    return true;
  }
}

/**
 * Tenant guard. Any route with a :companyId param needs an ACTIVE membership of the caller in
 * that company (super admins get no exemption) and, if @RequirePermission is set, a role that
 * holds it. Non-members get 404 so company ids cannot be probed.
 */
@Injectable()
export class CompanyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService, @Inject(CONFIG) private readonly config: AppConfig) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const companyId = req.params?.companyId as string | undefined;
    if (!companyId || !req.auth) return true;

    const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found' });
    if (!/^[0-9a-f-]{36}$/i.test(companyId)) throw notFound();

    const m = await this.prisma.companyMembership.findUnique({
      where: { companyId_userId: { companyId, userId: req.auth.user.id } },
      include: { company: { select: { isActive: true, organization: { select: { plan: true, status: true, trialEndsAt: true, stripeSubscriptionId: true } } } } },
    });
    if (!m || m.status !== 'ACTIVE' || !m.company.isActive) throw notFound();

    const needed = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, [ctx.getHandler(), ctx.getClass()]);
    if (needed && !roleHasPermission(m.role, needed)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: `Missing permission ${needed}` });
    }
    // SaaS edition: the subscribing organization's plan and subscription decide what this company may do. Companies with no
    // organization (created by a platform administrator) and self-hosted installations are not limited.
    const org = this.config.APP_MODE === 'saas' ? m.company.organization : null;
    if (org) {
      const feature = this.reflector.getAllAndOverride<Feature | undefined>(FEATURE, [ctx.getHandler(), ctx.getClass()]);
      const plan = PLANS[org.plan as keyof typeof PLANS];
      if (feature && !plan?.features.includes(feature)) throw new ForbiddenException({ code: 'PLAN_FEATURE', message: `Your ${plan?.name ?? org.plan} plan does not include this feature; upgrade in Billing`, feature });
      if (!SAFE_METHODS.has(req.method) && !writable(org)) {
        throw new HttpException({ code: 'SUBSCRIPTION_INACTIVE', message: 'Your subscription is not active, so the books are read-only. Renew it in Billing to make changes; everything stays viewable and exportable.' }, HttpStatus.PAYMENT_REQUIRED);
      }
    }
    req.membership = { companyId, role: m.role };
    return true;
  }
}
