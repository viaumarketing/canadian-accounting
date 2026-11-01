import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfig, CONFIG, loadConfig } from './config';
import { PrismaService } from './prisma.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard, CompanyGuard, CsrfGuard } from './auth/guards';
import { CompaniesModule } from './companies/companies.module';
import { AccountingModule } from './accounting/accounting.module';
import { ShopifyModule } from './shopify/shopify.module';
import { BankingModule } from './banking/banking.module';
import { HealthController } from './health/health.controller';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { ResourcesService } from './admin/resources.service';

export function coreModule(config: AppConfig = loadConfig()) {
  @Global()
  @Module({
    providers: [{ provide: CONFIG, useValue: config }, PrismaService],
    exports: [CONFIG, PrismaService],
  })
  class CoreModule {}
  return CoreModule;
}

export function buildAppModule(config: AppConfig = loadConfig()) {
  @Module({
    imports: [
      coreModule(config),
      ThrottlerModule.forRoot({
        throttlers: [{ ttl: 60_000, limit: 300 }],
        // Off by default under test (many logins per second); a dedicated test enables it.
        skipIf: () => (config.RATE_LIMIT_ENABLED ?? (config.NODE_ENV === 'test' ? 'false' : 'true')) === 'false',
      }),
      AuditModule,
      AuthModule,
      CompaniesModule,
      AccountingModule,
      ShopifyModule,
      BankingModule,
    ],
    controllers: [HealthController, AdminController],
    providers: [
      AdminService,
      ResourcesService,
      // Order matters: rate limit -> CSRF -> authentication -> tenant/permission.
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_GUARD, useClass: CsrfGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_GUARD, useClass: CompanyGuard },
    ],
  })
  class AppModule {}
  return AppModule;
}
