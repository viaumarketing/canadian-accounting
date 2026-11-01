import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { isoDate, taxRateSchema } from '@ca/shared';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { TaxService } from './tax.service';

const endSchema = z.object({ effectiveTo: isoDate });

@Controller('companies/:companyId')
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @RequirePermission('taxes:view') @Get('tax-codes')
  codes(@Param('companyId') c: string) { return this.tax.listCodes(c); }

  @RequirePermission('taxes:create') @Post('tax-codes/:id/rates')
  addRate(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(taxRateSchema)) b: z.infer<typeof taxRateSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.tax.addRate(c, id, b, u.id, ip); }

  @RequirePermission('taxes:create') @Patch('tax-rates/:id')
  endRate(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(endSchema)) b: { effectiveTo: string }, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.tax.endRate(c, id, b.effectiveTo, u.id, ip); }
}
