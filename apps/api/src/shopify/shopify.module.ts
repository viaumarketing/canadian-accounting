import { Global, Module } from '@nestjs/common';
import { SHOPIFY_FETCH, ShopifyService } from './shopify.service';
import { ShopifySyncService } from './sync.service';
import { SyncQueue, SyncQueueImpl } from './queue';
import { ShopifyCallbackController, ShopifyController, ShopifyWebhookController } from './shopify.controller';

/** Tests swap `shopifyFetch.fn` for a fake Shopify; production leaves the real fetch. */
export const shopifyFetch: { fn: typeof fetch } = { fn: (...a) => fetch(...a) };

@Global()
@Module({
  controllers: [ShopifyController, ShopifyCallbackController, ShopifyWebhookController],
  providers: [
    { provide: SHOPIFY_FETCH, useValue: ((...a: Parameters<typeof fetch>) => shopifyFetch.fn(...a)) as typeof fetch },
    { provide: SyncQueue, useClass: SyncQueueImpl },
    ShopifyService,
    ShopifySyncService,
  ],
  exports: [ShopifyService, ShopifySyncService, SyncQueue],
})
export class ShopifyModule {}
