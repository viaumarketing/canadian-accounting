import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentUser, SuperAdminOnly } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { AdminService } from './admin.service';
import { ResourcesService } from './resources.service';

const activeSchema = z.object({ active: z.boolean() });
const adminSchema = z.object({ value: z.boolean() });
const pwSchema = z.object({ password: z.string().min(1).max(128) });

/** System administration: platform metadata only, never a company's financial data. */
@SuperAdminOnly()
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService, private readonly resources: ResourcesService) {}

  @Get('system') system() { return this.admin.system(); }
  /** Live resource snapshot (memory, disk, load, Redis) with warnings, plus the sampled history. */
  @Get('resources') async resourceUse(@Query('hours') hours?: string) {
    const h = Math.min(Math.max(Number(hours) || 24, 1), 168);
    const [now, history] = await Promise.all([this.resources.snapshot(), this.resources.history(h)]);
    return { now, history };
  }
  @Get('users') users() { return this.admin.listUsers(); }

  @HttpCode(204) @Patch('users/:id/active')
  active(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(activeSchema)) b: { active: boolean }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.admin.setActive(u.id, id, b.active, ip); }
  @HttpCode(204) @Patch('users/:id/super-admin')
  superAdmin(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(adminSchema)) b: { value: boolean }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.admin.setSuperAdmin(u.id, id, b.value, ip); }
  @HttpCode(204) @Post('users/:id/unlock')
  unlock(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.admin.unlock(u.id, id, ip); }
  @HttpCode(200) @Post('users/:id/revoke-sessions')
  revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.admin.revokeSessions(u.id, id, ip); }
  @HttpCode(204) @Post('users/:id/reset-mfa')
  resetMfa(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.admin.resetMfa(u.id, id, ip); }
  @HttpCode(204) @Post('users/:id/temp-password')
  tempPassword(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(pwSchema)) b: { password: string }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.admin.setTempPassword(u.id, id, b.password, ip); }
  @HttpCode(204) @Patch('companies/:id/active')
  companyActive(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(activeSchema)) b: { active: boolean }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.admin.setCompanyActive(u.id, id, b.active, ip); }
}
