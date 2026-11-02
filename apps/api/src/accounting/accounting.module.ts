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

@Global()
@Module({
  controllers: [AccountingController, TaxController, ContactsController, BillingController, SalesController, ReportsController],
  providers: [LedgerService, TaxService, ContactsService, BillingService, SalesService, ReportsService],
  exports: [LedgerService, TaxService, BillingService],
})
export class AccountingModule {}
