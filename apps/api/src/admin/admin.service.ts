import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { passwordSchema } from '@ca/shared';
import { AppConfig, CONFIG } from '../config';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { hashPassword } from '../auth/password';
import { QUEUE_NAME } from '../shopify/queue';
import { checkEncryptionKey } from '../common/encryption-key-check';

const BACKUP_RE = /^ca-\d{8}-\d{6}\.sql\.gz\.enc$/;

/** Platform administration. Everything here is operational metadata: no ledger, bank or Shopify business data is ever read. */
@Injectable()
export class AdminService {
  private redis?: IORedis;
  private queue?: Queue;
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Inject(CONFIG) private readonly config: AppConfig) {}

  // ------------------------------------------------------------------ users

  async listUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: { email: 'asc' },
      select: { id: true, email: true, name: true, isSuperAdmin: true, isActive: true, mfaEnabled: true, mustChangePassword: true, lastLoginAt: true, lockedUntil: true, failedLoginCount: true, createdAt: true, _count: { select: { memberships: true, sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } } } },
    });
    return users.map(({ _count, ...u }) => ({ ...u, companies: _count.memberships, activeSessions: _count.sessions }));
  }

  private async target(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });
    return u;
  }
  private async otherActiveSuperAdmins(excludeId: string) {
    return this.prisma.user.count({ where: { isSuperAdmin: true, isActive: true, id: { not: excludeId } } });
  }
  private revoke(userId: string) { return this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }); }

  async setActive(actorId: string, id: string, active: boolean, ip: string | null) {
    const u = await this.target(id);
    if (!active) {
      if (id === actorId) throw new ConflictException({ code: 'SELF_LOCKOUT', message: 'You cannot deactivate your own account' });
      if (u.isSuperAdmin && (await this.otherActiveSuperAdmins(id)) === 0) throw new ConflictException({ code: 'LAST_SUPER_ADMIN', message: 'This is the last active platform administrator' });
    }
    await this.prisma.user.update({ where: { id }, data: { isActive: active, ...(active ? { failedLoginCount: 0, lockedUntil: null } : {}) } });
    if (!active) await this.revoke(id);
    await this.audit.record({ action: active ? 'admin.user_activated' : 'admin.user_deactivated', actorId, entityType: 'User', entityId: id, metadata: { email: u.email }, ip });
  }

  async setSuperAdmin(actorId: string, id: string, value: boolean, ip: string | null) {
    const u = await this.target(id);
    if (!value) {
      if (id === actorId) throw new ConflictException({ code: 'SELF_LOCKOUT', message: 'You cannot remove your own platform-administrator role' });
      if (u.isSuperAdmin && (await this.otherActiveSuperAdmins(id)) === 0) throw new ConflictException({ code: 'LAST_SUPER_ADMIN', message: 'This is the last active platform administrator' });
    }
    if (value && !u.isActive) throw new BadRequestException({ code: 'INACTIVE', message: 'Activate the user first' });
    await this.prisma.user.update({ where: { id }, data: { isSuperAdmin: value } });
    await this.audit.record({ action: value ? 'admin.super_admin_granted' : 'admin.super_admin_revoked', actorId, entityType: 'User', entityId: id, metadata: { email: u.email }, ip });
  }

  async unlock(actorId: string, id: string, ip: string | null) {
    const u = await this.target(id);
    await this.prisma.user.update({ where: { id }, data: { failedLoginCount: 0, lockedUntil: null } });
    await this.audit.record({ action: 'admin.user_unlocked', actorId, entityType: 'User', entityId: id, metadata: { email: u.email }, ip });
  }

  async revokeSessions(actorId: string, id: string, ip: string | null) {
    const u = await this.target(id);
    const r = await this.revoke(id);
    await this.audit.record({ action: 'admin.sessions_revoked', actorId, entityType: 'User', entityId: id, metadata: { email: u.email, count: r.count }, ip });
    return { revoked: r.count };
  }

  /** Lost authenticator: removes MFA (the user re-enrols) and signs the user out everywhere. */
  async resetMfa(actorId: string, id: string, ip: string | null) {
    const u = await this.target(id);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaPendingSecretEnc: null } }),
      this.prisma.recoveryCode.deleteMany({ where: { userId: id } }),
    ]);
    await this.revoke(id);
    await this.audit.record({ action: 'admin.mfa_reset', actorId, entityType: 'User', entityId: id, metadata: { email: u.email }, ip });
  }

  /** The password is never logged or stored in the audit trail. The user must change it at next sign-in. */
  async setTempPassword(actorId: string, id: string, password: string, ip: string | null) {
    const u = await this.target(id);
    const ok = passwordSchema.safeParse(password);
    if (!ok.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: ok.error.issues[0].message });
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null } });
    await this.revoke(id);
    await this.audit.record({ action: 'admin.password_reset', actorId, entityType: 'User', entityId: id, metadata: { email: u.email }, ip });
  }

  async setCompanyActive(actorId: string, id: string, active: boolean, ip: string | null) {
    const c = await this.prisma.company.findUnique({ where: { id } });
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found' });
    await this.prisma.company.update({ where: { id }, data: { isActive: active } });
    await this.audit.record({ action: active ? 'admin.company_activated' : 'admin.company_deactivated', companyId: id, actorId, entityType: 'Company', entityId: id, metadata: { name: c.legalName }, ip });
  }

  // ------------------------------------------------------------------ system status

  private async backups() {
    const dir = this.config.BACKUP_DIR;
    if (!dir) return { status: 'not_configured' as const, note: 'BACKUP_DIR is not set; mount the backup directory read-only into the API container.' };
    try {
      const names = (await readdir(dir)).filter((n) => BACKUP_RE.test(n));
      const files = await Promise.all(names.map(async (n) => { const s = await stat(join(dir, n)); return { file: n, at: s.mtime, sizeBytes: s.size }; }));
      files.sort((a, b) => b.at.getTime() - a.at.getTime());
      const copy = await this.backupCopy(dir);
      if (!files.length) return { status: 'missing' as const, count: 0, note: 'No backup files found in the backup directory.', copy };
      const ageHours = Math.round(((Date.now() - files[0].at.getTime()) / 3_600_000) * 10) / 10;
      return { status: ageHours <= 36 ? ('ok' as const) : ('stale' as const), count: files.length, totalBytes: files.reduce((s, f) => s + f.sizeBytes, 0), latest: { ...files[0], ageHours }, recent: files.slice(0, 7), note: ageHours <= 36 ? undefined : 'The newest backup is older than 36 hours.', copy };
    } catch (e) {
      return { status: 'unreadable' as const, note: `Cannot read the backup directory: ${(e as Error).message}` };
    }
  }

  /** Off-NAS copy result written by the backup container after each backup (copy-status.json). */
  private async backupCopy(dir: string) {
    try {
      const j = JSON.parse(await readFile(join(dir, 'copy-status.json'), 'utf8')) as { at: string; status: string; file: string; message: string };
      const ageHours = Math.round(((Date.now() - new Date(j.at).getTime()) / 3_600_000) * 10) / 10;
      const status = j.status !== 'ok' ? ('failed' as const) : ageHours > 36 ? ('stale' as const) : ('ok' as const);
      return { status, at: j.at, file: j.file, ageHours, message: j.message || (status === 'stale' ? 'The last copy is older than 36 hours.' : undefined) };
    } catch {
      return { status: 'not_configured' as const, message: 'No off-NAS copy is configured (BACKUP_COPY_DIR). A backup that only lives on the NAS does not survive the NAS.' };
    }
  }

  private async queueCounts() {
    if (!this.config.REDIS_URL) return { status: 'not_configured' as const };
    try {
      this.redis ??= new IORedis(this.config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 1500 });
      this.queue ??= new Queue(QUEUE_NAME, { connection: this.redis });
      const counts = await Promise.race([this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
      return { status: 'ok' as const, counts };
    } catch (e) {
      return { status: 'unavailable' as const, error: (e as Error).message };
    }
  }

  async system() {
    const t0 = Date.now();
    let db: { status: 'up' | 'down'; latencyMs: number; sizeBytes?: number; connections?: number; migrations?: { applied: number; lastAppliedAt: Date | null; failed: number } } = { status: 'up', latencyMs: 0 };
    try {
      const [size, conns, mig] = await Promise.all([
        this.prisma.$queryRaw<{ s: bigint }[]>`SELECT pg_database_size(current_database()) AS s`,
        this.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database()`,
        this.prisma.$queryRaw<{ applied: bigint; last: Date | null; failed: bigint }[]>`SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied, max(finished_at) AS last, count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS failed FROM _prisma_migrations`,
      ]);
      db = { status: 'up', latencyMs: Date.now() - t0, sizeBytes: Number(size[0].s), connections: Number(conns[0].n), migrations: { applied: Number(mig[0].applied), lastAppliedAt: mig[0].last, failed: Number(mig[0].failed) } };
    } catch { db = { status: 'down', latencyMs: Date.now() - t0 }; }

    const since = new Date(Date.now() - 24 * 3_600_000);
    const [users, companies, jobsByStatus, oldestPending, deadJobs, stores, conns, security, queue, backups, encryptionKey] = await Promise.all([
      this.prisma.user.count(), this.prisma.company.count(),
      this.prisma.shopifySyncJob.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
      this.prisma.shopifySyncJob.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.prisma.shopifySyncJob.findMany({ where: { status: 'DEAD', createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, error: true, createdAt: true, company: { select: { legalName: true } }, store: { select: { shopDomain: true } } } }),
      this.prisma.shopifyStore.findMany({ where: { OR: [{ lastError: { not: null } }, { status: 'ERROR' }] }, select: { id: true, shopDomain: true, status: true, lastError: true, lastSyncAt: true, company: { select: { legalName: true } } } }),
      this.prisma.bankProviderConnection.findMany({ where: { OR: [{ lastError: { not: null } }, { status: 'ERROR' }] }, select: { id: true, provider: true, institutionName: true, status: true, lastError: true, lastSyncAt: true, company: { select: { legalName: true } } } }),
      this.prisma.auditEvent.findMany({ where: { action: { in: ['auth.login_failed', 'auth.account_locked', 'auth.mfa_disabled', 'admin.mfa_reset', 'admin.password_reset', 'admin.super_admin_granted', 'admin.user_deactivated'] } }, orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, action: true, ip: true, createdAt: true, metadata: true } }),
      this.queueCounts(), this.backups(),
      checkEncryptionKey(this.prisma, this.config.ENCRYPTION_KEY).catch(() => ({ status: 'unknown' as const, checked: 0, failed: 0 })),
    ]);
    return {
      version: { app: this.config.APP_VERSION, gitSha: this.config.GIT_SHA ?? null, builtAt: this.config.BUILD_TIME ?? null, node: process.version, environment: this.config.NODE_ENV, uptimeSeconds: Math.round(process.uptime()) },
      database: db,
      counts: { users, companies },
      jobs: { shopifyLast24h: Object.fromEntries(jobsByStatus.map((j) => [j.status, j._count])), oldestPendingAgeSeconds: oldestPending ? Math.round((Date.now() - oldestPending.createdAt.getTime()) / 1000) : null, deadLast7d: deadJobs, queue },
      integrationErrors: { shopify: stores, banking: conns },
      backups,
      encryptionKey,
      securityEvents: security,
    };
  }
}
