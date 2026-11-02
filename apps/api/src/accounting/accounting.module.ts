import { Global, Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { LedgerService } from './ledger.service';
import { TaxController } from '../tax/tax.controller';
import { TaxService } from '../tax/tax.service';
import { ContactsController } from '../contacts/contacts.controller';
import { ContactsService } from '../contacts/contacts.service';
import { BillingController } from '../billing/billing.controller';
import { BillingService } from '../billing/billing.service';
import { SalesController } from '../billing/sales.controller';
import { SalesService } from '../billing/sales.service';
import { ReportsController } from '../reports/reports.controller';
import { ReportsService } from '../reports/reports.service';
import { MailService } from '../mail/mail.service';
import { InventoryService } from '../inventory/inventory.service';
import { EstimatesService } from '../billing/estimates.service';
import { StatementsService } from '../billing/statements.service';
import { AutomationService } from '../billing/automation.service';
import { WorkflowController } from '../billing/workflow.controller';
import { PurchaseOrdersService } from '../billing/purchase-orders.service';
import { ProjectsService } from '../projects/projects.service';
import { TrackingService } from '../reports/tracking.service';
import { OperationsController } from '../reports/operations.controller';
import { StripePaymentsService } from '../payments/stripe-payments.service';
import { DepositsService } from '../payments/deposits.service';
import { PaymentsController, PublicInvoiceController, StripeWebhookController } from '../payments/payments.controller';
import { BrandingService } from '../documents/branding.service';
import { DocumentsService } from '../documents/documents.service';
import { DocumentsController } from '../documents/documents.controller';

@Global()
@Module({
  controllers: [AccountingController, TaxController, ContactsController, BillingController, SalesController, ReportsController, DocumentsController, WorkflowController, PaymentsController, PublicInvoiceController, StripeWebhookController, OperationsController],
  providers: [LedgerService, TaxService, ContactsService, BillingService, SalesService, ReportsService, MailService, BrandingService, DocumentsService, InventoryService, EstimatesService, StatementsService, AutomationService, StripePaymentsService, DepositsService, PurchaseOrdersService, ProjectsService, TrackingService],
  exports: [LedgerService, TaxService, BillingService, SalesService, MailService, DocumentsService, InventoryService, AutomationService],
})
export class AccountingModule {}
