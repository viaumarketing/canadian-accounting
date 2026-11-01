import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AppConfig, CONFIG } from '../config';
import { PrismaService } from '../prisma.service';
import { Public } from '../auth/decorators';
import { checkEncryptionKey } from '../common/encryption-key-check';
import { SCHEMA_COMPAT_LEVEL, schemaCompat } from '../common/schema-compat';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, @Inject(CONFIG) private readonly config: AppConfig) {}

  /** Liveness: process is up. */
  @Get()
  live() {
    return { status: 'ok', version: this.config.APP_VERSION, schemaLevel: SCHEMA_COMPAT_LEVEL };
  }

  /** Readiness: dependencies reachable. */
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ code: 'DATABASE_DOWN', message: 'Cannot reach the database' });
    }
    // A database migrated by a newer release that this build cannot safely run against (see docs/dxp2800.md).
    const compat = await schemaCompat(this.prisma);
    if (!compat.ok) {
      throw new ServiceUnavailableException({
        code: 'SCHEMA_TOO_NEW',
        message: `The database was upgraded by a newer release (schema level ${compat.database}; this version supports ${compat.app}). Run scripts/rollback.sh, which restores the pre-upgrade backup, or upgrade again.`,
      });
    }
    // A key that cannot open the stored secrets means the stack is misconfigured (typically after a restore): say so loudly.
    const key = await checkEncryptionKey(this.prisma, this.config.ENCRYPTION_KEY).catch(() => null);
    if (key?.status === 'mismatch') {
      throw new ServiceUnavailableException({
        code: 'ENCRYPTION_KEY_MISMATCH',
        message: 'ENCRYPTION_KEY does not match the secrets stored in this database. Restore the original key from your saved .env.',
      });
    }
    return { status: 'ok', database: 'up' };
  }
}
