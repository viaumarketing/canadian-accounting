import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Permission } from '@ca/shared';
import type { Request } from 'express';

export const IS_PUBLIC = 'isPublic';
export const SUPER_ADMIN_ONLY = 'superAdminOnly';
export const PERMISSION = 'permission';
export const SKIP_CSRF = 'skipCsrf';

/** No session required. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Platform administration only. Grants no access to any company's data. */
export const SuperAdminOnly = () => SetMetadata(SUPER_ADMIN_ONLY, true);
/** Requires an active membership in :companyId whose role holds this permission. */
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION, p);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<Request>().auth!.user;
});
export const CurrentMembership = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<Request>().membership!;
});
export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<Request>().ip ?? null;
});

/** For machine-to-machine endpoints that authenticate by signature (e.g. Shopify webhooks), not cookies. */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);
