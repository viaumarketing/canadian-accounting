import { BadRequestException, Controller, ForbiddenException, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { roleHasPermission } from '@ca/shared';
import { ClientIp, CurrentMembership, CurrentUser, RequirePermission } from '../auth/decorators';
import { AuthUser, MembershipContext } from '../auth/auth.types';
import { CATALOG, ReportsService } from './reports.service';

@Controller('companies/:companyId')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermission('reports:view') @Get('report')
  catalog() { return CATALOG; }

  @RequirePermission('taxes:view') @Get('tax-periods')
  taxPeriods(@Param('companyId') c: string, @Query('date') date?: string) { return this.reports.taxPeriods(c, /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date! : new Date().toISOString().slice(0, 10)); }

  /** JSON for the screen; csv / xlsx / pdf downloads need reports:export. Every report is built from posted ledger data. */
  @RequirePermission('reports:view') @Get('report/:key')
  async report(@Param('companyId') c: string, @Param('key') key: string, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response, @CurrentUser() u: AuthUser, @CurrentMembership() m: MembershipContext, @ClientIp() ip: string | null) {
    const format = q.format ?? 'json';
    if (!['json', 'csv', 'xlsx', 'pdf'].includes(format)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'format must be json, csv, xlsx or pdf' });
    if (format !== 'json' && !roleHasPermission(m.role, 'reports:export')) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Missing permission reports:export' });
    const report = await this.reports.build(c, key, q);
    if (format === 'json') return report;
    const out = await this.reports.render(report, format as 'csv' | 'xlsx' | 'pdf');
    await this.reports.audited(c, u.id, key, format, q, ip);
    const stamp = [q.from, q.to ?? q.asOf].filter(Boolean).join('_') || new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', out.type);
    res.setHeader('Content-Disposition', `attachment; filename="${key}-${stamp.replace(/[^\w.-]/g, '')}.${out.ext}"`);
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(typeof out.body === 'string' ? Buffer.from(out.body, 'utf8') : out.body);
  }
}
