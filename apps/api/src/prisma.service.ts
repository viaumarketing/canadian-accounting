import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@ca/database';
import { AppConfig, CONFIG } from './config';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(CONFIG) config: AppConfig) {
    // Interactive transactions: Prisma's 5 s default is too short for a busy N100 (a bank import was rolled back at 5.4 s
    // under load). Work is still atomic; it is just allowed to take longer before being abandoned.
    super({ datasources: { db: { url: config.DATABASE_URL } }, transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
  }
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
