import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { createContactSchema } from '@ca/shared';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { ContactsService } from './contacts.service';

@Controller('companies/:companyId/contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @RequirePermission('sales:view') @Get()
  list(@Param('companyId') c: string, @Query('kind') kind?: string) { return this.contacts.list(c, kind === 'CUSTOMER' || kind === 'VENDOR' ? kind : undefined); }

  @RequirePermission('sales:create') @Post()
  create(@Param('companyId') c: string, @Body(new ZodPipe(createContactSchema)) b: z.infer<typeof createContactSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.contacts.create(c, b, u.id, ip); }

  @RequirePermission('sales:view') @Get(':id')
  get(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.contacts.get(c, id); }
}
