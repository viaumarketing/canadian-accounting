import { Global, Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { LedgerService } from './ledger.service';
import { TaxController } from '../tax/tax.controller';
import { TaxService } from '../tax/tax.service';
import { ContactsController } from '../contacts/contacts.controller';
import { ContactsService } from '../contacts/contacts.service';
import { BillingController } from '../billing/billing.controller';
import { BillingService } from '../billing/billing.service';
import { ReportsController } from '../reports/reports.controller';
import { ReportsService } from '../reports/reports.service';

@Global()
@Module({
  controllers: [AccountingController, TaxController, ContactsController, BillingController, ReportsController],
  providers: [LedgerService, TaxService, ContactsService, BillingService, ReportsService],
  exports: [LedgerService, TaxService, BillingService],
})
export class AccountingModule {}
