import { Global, Module } from '@nestjs/common';
import { PlaidProvider, type BankingProvider } from '@ca/banking';
import { AppConfig, CONFIG } from '../config';
import { BankingController } from './banking.controller';
import { BankingService } from './banking.service';
import { BANKING_PROVIDER, ConnectionsService } from './connections.service';
import { ReconciliationService } from './reconciliation.service';
import { DocumentStore } from '../common/document-store';

/** Tests swap `bankingFetch.fn` for a fake provider server. */
export const bankingFetch: { fn: typeof fetch } = { fn: (...a) => fetch(...a) };

@Global()
@Module({
  controllers: [BankingController],
  providers: [
    DocumentStore,
    {
      provide: BANKING_PROVIDER,
      inject: [CONFIG],
      useFactory: (c: AppConfig): BankingProvider | null =>
        c.PLAID_CLIENT_ID && c.PLAID_SECRET ? new PlaidProvider({ clientId: c.PLAID_CLIENT_ID, secret: c.PLAID_SECRET, env: c.PLAID_ENV, redirectUri: c.PLAID_REDIRECT_URI, fetch: ((...a: Parameters<typeof fetch>) => bankingFetch.fn(...a)) as typeof fetch }) : null,
    },
    BankingService, ReconciliationService, ConnectionsService,
  ],
  exports: [BankingService, ConnectionsService, ReconciliationService],
})
export class BankingModule {}
