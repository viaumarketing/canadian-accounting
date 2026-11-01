import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SetupAdminInput, setupAdminSchema } from '@ca/shared';
import { AppConfig, CONFIG } from '../config';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { safeEqual } from '../common/crypto';
import { hashPassword } from './password';
import { ClientIp, Public } from './decorators';

/** First-administrator bootstrap. Works exactly once: it is refused as soon as any user exists. */
@Public()
@Controller('setup')
export class SetupController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('status')
  async status() {
    return {
      needsSetup: (await this.prisma.user.count()) === 0,
      requiresToken: Boolean(this.config.SETUP_TOKEN) || this.config.NODE_ENV === 'production',
    };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(201)
  @Post()
  async setup(@Body(new ZodPipe(setupAdminSchema)) body: SetupAdminInput, @ClientIp() ip: string | null) {
    // In production the first administrator can only be created with the token from .env, so nobody else on the network can claim the instance first.
    if (this.config.NODE_ENV === 'production' && !this.config.SETUP_TOKEN) {
      throw new ForbiddenException({ code: 'SETUP_TOKEN_REQUIRED', message: 'Set SETUP_TOKEN in .env and restart the api container before creating the first administrator.' });
    }
    if (this.config.SETUP_TOKEN && !(body.setupToken && safeEqual(body.setupToken, this.config.SETUP_TOKEN))) {
      throw new ForbiddenException({ code: 'INVALID_SETUP_TOKEN', message: 'Invalid setup token' });
    }
    const passwordHash = await hashPassword(body.password);
    const user = await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent setup attempts.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(727001)`;
      if ((await tx.user.count()) > 0) {
        throw new ConflictException({ code: 'ALREADY_SETUP', message: 'Setup has already been completed' });
      }
      const u = await tx.user.create({
        data: { email: body.email, name: body.name, passwordHash, isSuperAdmin: true },
      });
      await this.audit.record({ action: 'system.first_admin_created', actorId: u.id, entityType: 'User', entityId: u.id, ip }, tx);
      return u;
    });
    return { id: user.id, email: user.email };
  }
}
