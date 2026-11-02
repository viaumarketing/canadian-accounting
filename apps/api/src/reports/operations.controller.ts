import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { budgetSchema, inventoryAdjustmentSchema, isoDate, projectSchema, purchaseOrderSchema, timeEntrySchema, trackingNameSchema, uuid } from '@ca/shared';
import { ZodPipe } from '../common/zod.pipe';
import { ClientIp, CurrentMembership, CurrentUser, RequirePermission } from '../auth/decorators';
import { AuthUser, MembershipContext } from '../auth/auth.types';
import { InventoryService } from '../inventory/inventory.service';
import { PurchaseOrdersService } from '../billing/purchase-orders.service';
import { ProjectsService } from '../projects/projects.service';
import { TrackingService } from './tracking.service';
import { DocumentsService } from '../documents/documents.service';
import { sendPdf } from '../documents/documents.controller';
import { RequireFeature } from '../saas/saas.decorators';

const range = z.object({ from: isoDate, to: isoDate });
const asOf = z.object({ asOf: isoDate.optional() });
const detailQuery = range.extend({ itemId: uuid.optional() });
const timeQuery = z.object({ from: isoDate.optional(), to: isoDate.optional(), projectId: uuid.optional(), userId: uuid.optional() });
const profitQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const convertPo = z.object({ issueDate: isoDate.optional(), supplierRef: z.string().max(60).optional() });
type Po = z.infer<typeof purchaseOrderSchema>;
type Time = z.infer<typeof timeEntrySchema>;
type Proj = z.infer<typeof projectSchema>;
const today = () => new Date().toISOString().slice(0, 10);

@Controller('companies/:companyId')
export class OperationsController {
  constructor(private readonly inventory: InventoryService, private readonly pos: PurchaseOrdersService, private readonly projects: ProjectsService, private readonly tracking: TrackingService, private readonly documents: DocumentsService) {}

  // ---- inventory
  @RequireFeature('inventory') @RequirePermission('journal:post') @Post('inventory/adjustments')
  adjust(@Param('companyId') c: string, @Body(new ZodPipe(inventoryAdjustmentSchema)) b: z.infer<typeof inventoryAdjustmentSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.inventory.adjust(c, b, u.id, ip); }
  @RequireFeature('inventory') @RequirePermission('reports:view') @Get('inventory/valuation')
  valuation(@Param('companyId') c: string, @Query(new ZodPipe(asOf)) q: z.infer<typeof asOf>) { return this.inventory.valuation(c, q.asOf ?? today()); }
  @RequireFeature('inventory') @RequirePermission('reports:view') @Get('inventory/detail')
  detail(@Param('companyId') c: string, @Query(new ZodPipe(detailQuery)) q: z.infer<typeof detailQuery>) { return this.inventory.detail(c, q); }
  @RequireFeature('inventory') @RequirePermission('sales:view') @Get('inventory/low-stock')
  lowStock(@Param('companyId') c: string) { return this.inventory.lowStock(c); }

  // ---- purchase orders
  @RequireFeature('purchase_orders') @RequirePermission('purchases:view') @Get('purchase-orders')
  listPo(@Param('companyId') c: string, @Query('status') s?: string) { return this.pos.list(c, s); }
  @RequireFeature('purchase_orders') @RequirePermission('purchases:view') @Get('purchase-orders/:id')
  getPo(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.pos.get(c, id); }
  @RequireFeature('purchase_orders') @RequirePermission('purchases:create') @Post('purchase-orders')
  createPo(@Param('companyId') c: string, @Body(new ZodPipe(purchaseOrderSchema)) b: Po, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.pos.create(c, b, u.id, ip); }
  @RequireFeature('purchase_orders') @RequirePermission('purchases:create') @Put('purchase-orders/:id')
  updatePo(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(purchaseOrderSchema)) b: Po, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.pos.update(c, id, b, u.id, ip); }
  @RequireFeature('purchase_orders') @RequirePermission('purchases:create') @Post('purchase-orders/:id/convert')
  convertPo(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(convertPo)) b: z.infer<typeof convertPo>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.pos.convert(c, id, u.id, ip, b); }
  @RequireFeature('purchase_orders') @RequirePermission('purchases:reverse') @Post('purchase-orders/:id/void')
  voidPo(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.pos.void(c, id, u.id, ip); }
  @RequireFeature('purchase_orders') @RequirePermission('purchases:view') @Get('purchase-orders/:id/pdf')
  async poPdf(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) { const r = await this.documents.render(c, 'purchase_order', id); return sendPdf(res, r.filename, r.pdf); }

  // ---- projects and time
  @RequireFeature('projects') @RequirePermission('sales:view') @Get('projects')
  listProjects(@Param('companyId') c: string) { return this.projects.list(c); }
  @RequireFeature('projects') @RequirePermission('sales:create') @Post('projects')
  createProject(@Param('companyId') c: string, @Body(new ZodPipe(projectSchema)) b: Proj, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.projects.save(c, null, b, u.id, ip); }
  @RequireFeature('projects') @RequirePermission('sales:create') @Put('projects/:id')
  updateProject(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(projectSchema)) b: Proj, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.projects.save(c, id, b, u.id, ip); }
  @RequireFeature('projects') @RequirePermission('reports:view') @Get('projects/profitability')
  profitability(@Param('companyId') c: string, @Query(new ZodPipe(profitQuery)) q: z.infer<typeof profitQuery>) { return this.projects.profitability(c, q); }

  /** Time is logged by anyone who can submit expenses (employees included); each person sees only their own unless they can approve. */
  @RequireFeature('time') @RequirePermission('expenses:view') @Get('time')
  listTime(@Param('companyId') c: string, @Query(new ZodPipe(timeQuery)) q: z.infer<typeof timeQuery>, @CurrentUser() u: AuthUser, @CurrentMembership() m: MembershipContext) { return this.projects.listTime(c, q, u.id, m.role); }
  @RequireFeature('time') @RequirePermission('expenses:create') @Post('time')
  logTime(@Param('companyId') c: string, @Body(new ZodPipe(timeEntrySchema)) b: Time, @CurrentUser() u: AuthUser, @CurrentMembership() m: MembershipContext, @ClientIp() ip: string | null) { return this.projects.logTime(c, b, u.id, m.role, ip); }
  @RequireFeature('time') @RequirePermission('expenses:create') @Put('time/:id')
  updateTime(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(timeEntrySchema)) b: Time, @CurrentUser() u: AuthUser, @CurrentMembership() m: MembershipContext, @ClientIp() ip: string | null) { return this.projects.updateTime(c, id, b, u.id, m.role, ip); }
  @RequireFeature('time') @RequirePermission('expenses:create') @HttpCode(204) @Delete('time/:id')
  deleteTime(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @CurrentMembership() m: MembershipContext, @ClientIp() ip: string | null) { return this.projects.deleteTime(c, id, u.id, m.role, ip); }

  // ---- classes and locations
  @RequireFeature('tracking') @RequirePermission('company:view') @Get('classes')
  classes(@Param('companyId') c: string) { return this.tracking.list(c, 'class'); }
  @RequireFeature('tracking') @RequirePermission('settings:create') @Post('classes')
  createClass(@Param('companyId') c: string, @Body(new ZodPipe(trackingNameSchema)) b: z.infer<typeof trackingNameSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.tracking.save(c, 'class', null, b, u.id, ip); }
  @RequireFeature('tracking') @RequirePermission('settings:create') @Put('classes/:id')
  updateClass(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(trackingNameSchema)) b: z.infer<typeof trackingNameSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.tracking.save(c, 'class', id, b, u.id, ip); }
  @RequireFeature('tracking') @RequirePermission('company:view') @Get('locations')
  locations(@Param('companyId') c: string) { return this.tracking.list(c, 'location'); }
  @RequireFeature('tracking') @RequirePermission('settings:create') @Post('locations')
  createLocation(@Param('companyId') c: string, @Body(new ZodPipe(trackingNameSchema)) b: z.infer<typeof trackingNameSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.tracking.save(c, 'location', null, b, u.id, ip); }
  @RequireFeature('tracking') @RequirePermission('settings:create') @Put('locations/:id')
  updateLocation(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(trackingNameSchema)) b: z.infer<typeof trackingNameSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.tracking.save(c, 'location', id, b, u.id, ip); }
  @RequireFeature('tracking') @RequirePermission('reports:view') @Get('reports/profit-and-loss-by-class')
  plByClass(@Param('companyId') c: string, @Query(new ZodPipe(range)) q: z.infer<typeof range>) { return this.tracking.profitAndLossBy(c, 'class', q.from, q.to); }
  @RequireFeature('tracking') @RequirePermission('reports:view') @Get('reports/profit-and-loss-by-location')
  plByLocation(@Param('companyId') c: string, @Query(new ZodPipe(range)) q: z.infer<typeof range>) { return this.tracking.profitAndLossBy(c, 'location', q.from, q.to); }

  // ---- budgets
  @RequireFeature('budgets') @RequirePermission('reports:view') @Get('budgets')
  budgets(@Param('companyId') c: string) { return this.tracking.listBudgets(c); }
  @RequireFeature('budgets') @RequirePermission('reports:view') @Get('budgets/:id')
  budget(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.tracking.getBudget(c, id); }
  @RequireFeature('budgets') @RequirePermission('accounts:create') @Post('budgets')
  createBudget(@Param('companyId') c: string, @Body(new ZodPipe(budgetSchema)) b: z.infer<typeof budgetSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.tracking.saveBudget(c, null, b, u.id, ip); }
  @RequireFeature('budgets') @RequirePermission('accounts:create') @Put('budgets/:id')
  updateBudget(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(budgetSchema)) b: z.infer<typeof budgetSchema>, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.tracking.saveBudget(c, id, b, u.id, ip); }
  @RequireFeature('budgets') @RequirePermission('accounts:create') @HttpCode(204) @Delete('budgets/:id')
  deleteBudget(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) { return this.tracking.deleteBudget(c, id, u.id, ip); }
  @RequireFeature('budgets') @RequirePermission('reports:view') @Get('budgets/:id/vs-actual')
  vsActual(@Param('companyId') c: string, @Param('id', ParseUUIDPipe) id: string) { return this.tracking.budgetVsActual(c, id); }

  // ---- dashboard
  @RequirePermission('reports:view') @Get('dashboard/charts')
  dashboard(@Param('companyId') c: string) { return this.tracking.dashboard(c); }
}
