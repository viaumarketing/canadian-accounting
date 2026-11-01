import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  CompanyRole,
  CreateCompanyInput,
  InviteMemberInput,
  TaxRegistrationInput,
  UpdateCompanyInput,
  changeMemberRoleSchema,
  createCompanySchema,
  inviteMemberSchema,
  taxRegistrationSchema,
  updateCompanySchema,
} from '@ca/shared';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentMembership, CurrentUser, RequirePermission, SuperAdminOnly } from '../auth/decorators';
import { AuthUser, MembershipContext } from '../auth/auth.types';
import { CompaniesService } from './companies.service';

@Controller()
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  // Platform provisioning (super admin). Grants the platform admin no access to company data.
  @SuperAdminOnly()
  @Post('admin/companies')
  provision(@Body(new ZodPipe(createCompanySchema)) body: CreateCompanyInput, @CurrentUser() user: AuthUser, @ClientIp() ip: string | null) {
    return this.companies.provision(body, user.id, ip);
  }

  @SuperAdminOnly()
  @Get('admin/companies')
  listAll() {
    return this.companies.listAll();
  }

  @RequirePermission('company:view')
  @Get('companies/:companyId')
  get(@Param('companyId') id: string) {
    return this.companies.get(id);
  }

  @RequirePermission('company:view')
  @Get('companies/:companyId/dashboard')
  dashboard(@Param('companyId') id: string) {
    return this.companies.dashboard(id);
  }

  @RequirePermission('settings:create')
  @Patch('companies/:companyId')
  update(@Param('companyId') id: string, @Body(new ZodPipe(updateCompanySchema)) body: UpdateCompanyInput, @CurrentUser() user: AuthUser, @ClientIp() ip: string | null) {
    return this.companies.update(id, body, user.id, ip);
  }

  @RequirePermission('members:view')
  @Get('companies/:companyId/members')
  members(@Param('companyId') id: string) {
    return this.companies.listMembers(id);
  }

  @RequirePermission('members:create')
  @Post('companies/:companyId/members')
  invite(
    @Param('companyId') id: string,
    @Body(new ZodPipe(inviteMemberSchema)) body: InviteMemberInput,
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: MembershipContext,
    @ClientIp() ip: string | null,
  ) {
    return this.companies.invite(id, user.id, m.role, body, ip);
  }

  @RequirePermission('members:create')
  @Patch('companies/:companyId/members/:membershipId')
  changeRole(
    @Param('companyId') id: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body(new ZodPipe(changeMemberRoleSchema)) body: { role: CompanyRole },
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: MembershipContext,
    @ClientIp() ip: string | null,
  ) {
    return this.companies.changeRole(id, membershipId, body.role, user.id, m.role, ip);
  }

  @HttpCode(204)
  @RequirePermission('members:delete')
  @Delete('companies/:companyId/members/:membershipId')
  suspend(
    @Param('companyId') id: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: MembershipContext,
    @ClientIp() ip: string | null,
  ) {
    return this.companies.suspend(id, membershipId, user.id, m.role, ip);
  }

  @RequirePermission('taxes:view')
  @Get('companies/:companyId/tax-registrations')
  taxRegistrations(@Param('companyId') id: string) {
    return this.companies.listTaxRegistrations(id);
  }

  @RequirePermission('taxes:create')
  @Post('companies/:companyId/tax-registrations')
  addTaxRegistration(
    @Param('companyId') id: string,
    @Body(new ZodPipe(taxRegistrationSchema)) body: TaxRegistrationInput,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
  ) {
    return this.companies.addTaxRegistration(id, body, user.id, ip);
  }

  @RequirePermission('audit:view')
  @Get('companies/:companyId/audit')
  audit(@Param('companyId') id: string, @Query('cursor') cursor?: string, @Query('take') take?: string) {
    return this.companies.listAudit(id, take ? Math.max(1, Number(take) || 50) : 50, cursor);
  }
}
